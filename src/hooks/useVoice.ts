/**
 * Voice input and output.
 *
 * Desktop records through Rust/cpal — never `getUserMedia`. WebKitGTK cannot
 * reach the microphone on a Wayland session: the request fails before any
 * permission prompt appears, which is why the browser is not asked for audio on
 * any platform. The backend streams `mic-chunk` and `mic-level` events for the
 * meter and hands back the finished WAV from `stop_capture`.
 *
 * Mobile hands off to the OS speech recogniser. Both fall back to the browser's
 * own SpeechRecognition when the preferred engine is unavailable, so voice
 * always does *something*.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isMobile, isTauri } from '@/platform';
import { useSettings } from '@/store/settings';
import { useConversation } from '@/store/conversation';

/** Whisper wants 16 kHz mono. Rust resamples to this before it emits anything. */
const SAMPLE_RATE = 16_000;

/** Number of bars the waveform visualiser draws. */
const SPECTRUM_BARS = 24;

export interface VoiceState {
  listening: boolean;
  speaking: boolean;
  /** 0-1 input level, drives the orb's ripple. */
  level: number;
  /** Frequency bins while speaking, drives the waveform bars. */
  spectrum: number[];
  error: string | null;
  supported: boolean;
}

/* ── Meter input ─────────────────────────────────────────────────── */

/**
 * Decode a `mic-chunk` payload: base64 PCM-16 little-endian, 16 kHz mono.
 *
 * The backend sends PCM rather than a JSON array of floats because these
 * arrive ~50 times a second — as JSON numbers each chunk would be an order of
 * magnitude larger and the IPC cost would show up in the animation.
 */
function decodePcm16(base64: string): Float32Array {
  const binary = atob(base64);
  const samples = new Float32Array(binary.length / 2);
  for (let i = 0; i < samples.length; i++) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    // Reassemble little-endian, then sign-extend the 16-bit value.
    const value = (hi << 8) | lo;
    samples[i] = (value >= 0x8000 ? value - 0x10000 : value) / 32_768;
  }
  return samples;
}

/**
 * Collapse a block of samples into bar heights for the visualiser.
 *
 * This replaces an AnalyserNode: with capture in Rust there is no WebAudio
 * graph to read frequency data from. Per-band RMS of the time-domain signal is
 * not a spectrum, but it tracks loudness across the block the same way and is
 * what the bars actually convey.
 */
function bars(samples: Float32Array): number[] {
  if (samples.length === 0) return [];

  const out: number[] = [];
  const width = Math.max(1, Math.floor(samples.length / SPECTRUM_BARS));
  for (let i = 0; i < SPECTRUM_BARS; i++) {
    let sum = 0;
    let count = 0;
    for (let j = i * width; j < (i + 1) * width && j < samples.length; j++) {
      sum += samples[j] * samples[j];
      count++;
    }
    out.push(count === 0 ? 0 : Math.min(1, Math.sqrt(sum / count) * 4));
  }
  return out;
}

/* ── Browser SpeechRecognition typings ───────────────────────────── */

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useVoice(onTranscript: (text: string) => void) {
  const [state, setState] = useState<VoiceState>({
    listening: false,
    speaking: false,
    level: 0,
    spectrum: [],
    error: null,
    supported: true,
  });

  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  /** Teardown for the Rust capture event listeners, set while recording. */
  const micListenersRef = useRef<Array<() => void>>([]);
  /** `stopListening` is defined below; the silence handler reaches it here. */
  const stopListeningRef = useRef<() => Promise<void>>(async () => {});

  // Keep the callback fresh without re-creating start/stop on every render.
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  /* ── Metering ── */

  const runMeter = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const timeData = new Uint8Array(analyser.fftSize);
    const freqData = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      analyser.getByteTimeDomainData(timeData);
      analyser.getByteFrequencyData(freqData);

      // RMS of the waveform, centred on 128.
      let sum = 0;
      for (const v of timeData) {
        const normalised = (v - 128) / 128;
        sum += normalised * normalised;
      }
      const level = Math.min(1, Math.sqrt(sum / timeData.length) * 3);

      // Collapse the spectrum into 24 bars for the visualiser.
      const bars: number[] = [];
      const step = Math.floor(freqData.length / 24) || 1;
      for (let i = 0; i < 24; i++) {
        let acc = 0;
        for (let j = 0; j < step; j++) acc += freqData[i * step + j] ?? 0;
        bars.push(acc / step / 255);
      }

      setState((s) => ({ ...s, level, spectrum: bars }));
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const stopMeter = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setState((s) => ({ ...s, level: 0, spectrum: [] }));
  }, []);

  /* ── Recording ── */

  /** Drop the Rust capture listeners and reset the meter. */
  const teardownRecording = useCallback(() => {
    stopMeter();
    micListenersRef.current.forEach((off) => off());
    micListenersRef.current = [];
  }, [stopMeter]);

  /** Release the WebAudio graph used for *playback* visualisation only. */
  const teardownPlaybackGraph = useCallback(() => {
    void contextRef.current?.close().catch(() => {});
    contextRef.current = null;
    analyserRef.current = null;
  }, []);

  const startListening = useCallback(async () => {
    if (state.listening) return;
    setState((s) => ({ ...s, error: null }));

    const engine = useSettings.getState().settings.voice.sttEngine;

    // Mobile: hand straight to the OS recogniser.
    if (isMobile && engine !== 'off') {
      try {
        const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
        const permission = await SpeechRecognition.requestPermissions();
        if (permission.speechRecognition !== 'granted') {
          setState((s) => ({ ...s, error: 'Microphone permission was denied.' }));
          return;
        }

        setState((s) => ({ ...s, listening: true }));
        useConversation.getState().setAgentState('listening');

        const result = await SpeechRecognition.start({
          language: 'en-US',
          maxResults: 1,
          partialResults: false,
          popup: false,
        });

        setState((s) => ({ ...s, listening: false }));
        useConversation.getState().setAgentState('idle');

        const text = result.matches?.[0];
        if (text) onTranscriptRef.current(text);
      } catch (e) {
        setState((s) => ({
          ...s,
          listening: false,
          error: e instanceof Error ? e.message : String(e),
        }));
        useConversation.getState().setAgentState('idle');
      }
      return;
    }

    // Desktop with the whisper sidecar: capture through Rust/cpal, which is the
    // only route to the microphone that works on a Wayland session.
    if (isTauri && engine === 'whisper-sidecar') {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const { desktop } = await import('@/platform/desktop');

        // Subscribe before starting, so no chunk arrives unobserved.
        const offChunk = await listen<string>('mic-chunk', (event) => {
          setState((s) => ({ ...s, spectrum: bars(decodePcm16(event.payload)) }));
        });
        const offLevel = await listen<number>('mic-level', (event) => {
          setState((s) => ({ ...s, level: event.payload }));
        });
        const offError = await listen<string>('mic-error', (event) => {
          setState((s) => ({ ...s, error: `Microphone error: ${event.payload}` }));
        });

        // Rust reports when the user has stopped speaking. Acting on it means
        // the answer starts the moment they finish, instead of when they
        // remember to release the button.
        const offSilence = await listen('mic-silence', () => {
          if (useSettings.getState().settings.voice.autoStopOnSilence) {
            void stopListeningRef.current();
          }
        });
        micListenersRef.current = [offChunk, offLevel, offError, offSilence];

        // Rust reports a device it could not open as a rejected promise, so a
        // failure surfaces here rather than as silence on release.
        await desktop.startCapture(
          useSettings.getState().settings.voice.silenceTimeoutMs,
        );

        setState((s) => ({ ...s, listening: true }));
        useConversation.getState().setAgentState('listening');
        return;
      } catch (e) {
        teardownRecording();
        setState((s) => ({
          ...s,
          error: typeof e === 'string' ? e : e instanceof Error ? e.message : String(e),
        }));
        useConversation.getState().setAgentState('idle');
        return;
      }
    }

    // Fallback: the browser's own recogniser.
    const Recognition = getSpeechRecognition();
    if (!Recognition) {
      setState((s) => ({
        ...s,
        supported: false,
        error:
          'No speech recognition is available. Install the whisper sidecar with ' +
          '`bash scripts/download-models.sh`, or type instead.',
      }));
      return;
    }

    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      const text = event.results?.[0]?.[0]?.transcript;
      if (text) onTranscriptRef.current(text);
    };
    recognition.onerror = (event) => {
      setState((s) => ({ ...s, listening: false, error: `Speech error: ${event.error}` }));
      useConversation.getState().setAgentState('idle');
    };
    recognition.onend = () => {
      setState((s) => ({ ...s, listening: false }));
      useConversation.getState().setAgentState('idle');
    };

    recognition.start();
    setState((s) => ({ ...s, listening: true }));
    useConversation.getState().setAgentState('listening');
  }, [state.listening, runMeter]);

  const stopListening = useCallback(async () => {
    if (!state.listening) return;

    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
      return;
    }

    if (isMobile) {
      const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
      await SpeechRecognition.stop().catch(() => {});
      setState((s) => ({ ...s, listening: false }));
      useConversation.getState().setAgentState('idle');
      return;
    }

    // Whisper path: Rust hands back the finished recording as a WAV.
    setState((s) => ({ ...s, listening: false }));
    teardownRecording();

    useConversation.getState().setAgentState('thinking');
    try {
      const { desktop } = await import('@/platform/desktop');
      // The audio comes from this return value rather than from reassembled
      // `mic-chunk` events: those drive the meter, and one dropped under load
      // would silently truncate the transcript.
      const wavBase64 = await desktop.stopCapture();

      // A WAV is 44 bytes of header plus 2 bytes per sample, and base64 costs
      // 4 characters per 3 bytes. Anything under ~0.3s is a mis-tap.
      const approxSamples = ((wavBase64.length * 3) / 4 - 44) / 2;
      if (approxSamples < SAMPLE_RATE * 0.3) {
        useConversation.getState().setAgentState('idle');
        return;
      }

      const text = await desktop.transcribe(wavBase64);
      if (text.trim()) {
        onTranscriptRef.current(text.trim());
      } else {
        useConversation.getState().setAgentState('idle');
      }
    } catch (e) {
      setState((s) => ({
        ...s,
        error: typeof e === 'string' ? e : e instanceof Error ? e.message : String(e),
      }));
      useConversation.getState().setAgentState('idle');
    }
  }, [state.listening, teardownRecording]);

  useEffect(() => {
    stopListeningRef.current = stopListening;
  }, [stopListening]);

  const toggleListening = useCallback(() => {
    void (state.listening ? stopListening() : startListening());
  }, [state.listening, startListening, stopListening]);

  /* ── Speaking ── */

  const stopSpeaking = useCallback(() => {
    // Clear the queue first: without this, cancelling mid-reply stops the
    // current sentence and immediately starts the next one.
    queueRef.current = [];
    utteranceEndedRef.current = true;
    audioRef.current?.pause();
    audioRef.current = null;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    stopMeter();
    // `speak` opens an AudioContext per utterance for the visualiser; closing
    // it here keeps a long session from hitting the browser's context limit.
    teardownPlaybackGraph();
    setState((s) => ({ ...s, speaking: false }));
  }, [stopMeter, teardownPlaybackGraph]);

  /**
   * Sentences waiting to be spoken, and whether one is playing.
   *
   * Sentences arrive faster than they can be spoken, so they queue. Playing
   * them as they arrive would overlap them into noise; waiting for the whole
   * reply would give up the latency this exists to save.
   */
  const queueRef = useRef<string[]>([]);
  const playingRef = useRef(false);
  /** Set once the reply is complete, so the queue knows when to finish. */
  const utteranceEndedRef = useRef(true);

  /** Speak one sentence, resolving when it has finished playing. */
  const speakOne = useCallback(async (sentence: string): Promise<void> => {
    const voice = useSettings.getState().settings.voice;

    if (isMobile && voice.ttsEngine === 'native') {
      const { TextToSpeech } = await import('@capacitor-community/text-to-speech');
      await TextToSpeech.speak({
        text: sentence,
        lang: 'en-US',
        rate: voice.speed,
        pitch: voice.pitch,
        category: 'ambient',
      });
      return;
    }

    if (isTauri && voice.ttsEngine === 'piper-sidecar') {
      const { desktop } = await import('@/platform/desktop');
      const dataUrl = await desktop.synthesize(sentence, voice.speed);
      const audio = new Audio(dataUrl);
      audioRef.current = audio;
      await new Promise<void>((resolve) => {
        audio.onended = () => resolve();
        // A sentence that fails to play must not stall the queue behind it.
        audio.onerror = () => resolve();
        void audio.play().catch(() => resolve());
      });
      return;
    }

    if (isTauri && voice.ttsEngine === 'os-native') {
      const { desktop } = await import('@/platform/desktop');
      await desktop.speakNative(sentence);
      return;
    }

    if ('speechSynthesis' in window) {
      await new Promise<void>((resolve) => {
        const utterance = new SpeechSynthesisUtterance(sentence);
        utterance.rate = voice.speed;
        utterance.pitch = voice.pitch;
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        window.speechSynthesis.speak(utterance);
      });
    }
  }, []);

  /** Drain the queue, one sentence at a time, until the reply is finished. */
  const drainQueue = useCallback(async () => {
    if (playingRef.current) return;
    playingRef.current = true;

    setState((s) => ({ ...s, speaking: true }));
    useConversation.getState().setAgentState('speaking');

    try {
      while (queueRef.current.length > 0) {
        const next = queueRef.current.shift()!;
        try {
          await speakOne(next);
        } catch {
          // One failed sentence should not silence the rest of the answer.
        }
      }
    } finally {
      playingRef.current = false;
      setState((s) => ({ ...s, speaking: false, spectrum: [] }));
      if (
        utteranceEndedRef.current &&
        useConversation.getState().agentState === 'speaking'
      ) {
        useConversation.getState().setAgentState('idle');
      }
    }
  }, [speakOne]);

  /**
   * Queue one sentence from a reply that is still generating.
   *
   * `null` means the reply is complete: anything already queued still plays,
   * and the orb returns to idle once it has.
   */
  const speakSentence = useCallback(
    (sentence: string | null) => {
      if (useSettings.getState().settings.voice.ttsEngine === 'off') return;

      if (sentence === null) {
        utteranceEndedRef.current = true;
        // Nothing queued and nothing playing: the reply was silent.
        if (!playingRef.current && queueRef.current.length === 0) {
          if (useConversation.getState().agentState === 'speaking') {
            useConversation.getState().setAgentState('idle');
          }
        }
        return;
      }

      const clean = sentence.trim();
      if (!clean) return;

      // A new utterance after the last one finished starts a fresh run.
      if (utteranceEndedRef.current && !playingRef.current) {
        queueRef.current = [];
      }
      utteranceEndedRef.current = false;
      queueRef.current.push(clean);
      void drainQueue();
    },
    [drainQueue],
  );

  const speak = useCallback(
    async (text: string) => {
      const clean = text.replace(/```[\s\S]*?```/g, ' code block ').trim();
      if (!clean) return;

      const voice = useSettings.getState().settings.voice;
      if (voice.ttsEngine === 'off') return;

      stopSpeaking();
      setState((s) => ({ ...s, speaking: true }));
      useConversation.getState().setAgentState('speaking');

      const finish = () => {
        setState((s) => ({ ...s, speaking: false, spectrum: [] }));
        if (useConversation.getState().agentState === 'speaking') {
          useConversation.getState().setAgentState('idle');
        }
      };

      try {
        if (isMobile && voice.ttsEngine === 'native') {
          const { TextToSpeech } = await import('@capacitor-community/text-to-speech');
          await TextToSpeech.speak({
            text: clean,
            lang: 'en-US',
            rate: voice.speed,
            pitch: voice.pitch,
            category: 'ambient',
          });
          finish();
          return;
        }

        if (isTauri && voice.ttsEngine === 'piper-sidecar') {
          const { desktop } = await import('@/platform/desktop');
          const dataUrl = await desktop.synthesize(clean, voice.speed);

          const audio = new Audio(dataUrl);
          audioRef.current = audio;

          // Route through WebAudio so the visualiser has something to read.
          try {
            const context = new AudioContext();
            const source = context.createMediaElementSource(audio);
            const analyser = context.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            analyser.connect(context.destination);
            analyserRef.current = analyser;
            contextRef.current = context;
            runMeter();
          } catch {
            // Visualisation is optional; playback still works without it.
          }

          audio.onended = () => {
            stopMeter();
            finish();
          };
          audio.onerror = () => {
            stopMeter();
            finish();
          };
          await audio.play();
          return;
        }

        // Browser speech synthesis, and the desktop OS-native fallback.
        if (isTauri && voice.ttsEngine === 'os-native') {
          const { desktop } = await import('@/platform/desktop');
          await desktop.speakNative(clean);
          finish();
          return;
        }

        if ('speechSynthesis' in window) {
          const utterance = new SpeechSynthesisUtterance(clean);
          utterance.rate = voice.speed;
          utterance.pitch = voice.pitch;
          utterance.onend = finish;
          utterance.onerror = finish;
          window.speechSynthesis.speak(utterance);
          return;
        }

        finish();
      } catch (e) {
        setState((s) => ({
          ...s,
          error: typeof e === 'string' ? e : e instanceof Error ? e.message : String(e),
        }));
        finish();
      }
    },
    [stopSpeaking, runMeter, stopMeter],
  );

  useEffect(
    () => () => {
      teardownRecording();
      teardownPlaybackGraph();
      recognitionRef.current?.abort();
      audioRef.current?.pause();
      // Unmounting mid-recording must release the device, or the next session
      // finds the microphone already held.
      if (isTauri) {
        void import('@/platform/desktop')
          .then((m) => m.desktop.stopCapture())
          .catch(() => {});
      }
    },
    [teardownRecording, teardownPlaybackGraph],
  );

  return {
    ...state,
    startListening,
    stopListening,
    toggleListening,
    speak,
    speakSentence,
    stopSpeaking,
  };
}
