/**
 * Wake-word detection.
 *
 * On the desktop this drives the Rust listener, which holds the microphone in
 * a background thread and matches audio locally. The browser's
 * `SpeechRecognition` is not an option there: WebKitGTK does not implement it,
 * so the previous approach silently never fired on Linux — the same class of
 * problem as `getUserMedia`.
 *
 * Mobile keeps the platform recogniser, which does exist and is already
 * running for dictation.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isMobile, isTauri } from '@/platform';
import { useSettings } from '@/store/settings';

interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function getRecognition(): (new () => RecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => RecognitionLike;
    webkitSpeechRecognition?: new () => RecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Tolerate the ways a recogniser might hear "hey nova". */
function matchesWakeWord(transcript: string, wakeWord: string): boolean {
  const heard = transcript.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  const target = wakeWord.toLowerCase().trim();
  if (heard.includes(target)) return true;

  const key = target.split(/\s+/).pop() ?? target;
  // How a recogniser tends to mangle "nova". `arya` and `area` were carried
  // over from the previous wake word by a find-and-replace and match nothing
  // anyone says to this one; `november` is what a recogniser reaches for when
  // it decides a short word must be the NATO alphabet.
  return new RegExp(`\\b(${key}|nova|novah|november)\\b`).test(heard);
}

/**
 * A short chime, synthesised rather than shipped as an asset.
 *
 * Two quick tones is enough to say "I'm listening" without being a sound
 * effect anyone has to hear twice. Generating it avoids bundling a file and
 * means it cannot be missing at runtime.
 */
function playActivationChime() {
  try {
    const context = new AudioContext();
    const now = context.currentTime;
    const gain = context.createGain();
    gain.connect(context.destination);
    // Short and quiet: this fires whenever the user speaks to the app.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

    for (const [frequency, at] of [
      [880, 0],
      [1320, 0.09],
    ] as const) {
      const osc = context.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, now + at);
      osc.connect(gain);
      osc.start(now + at);
      osc.stop(now + at + 0.1);
    }

    // Close once it has finished, so repeated wakes do not leak contexts.
    setTimeout(() => void context.close().catch(() => {}), 400);
  } catch {
    // Audio output is unavailable; the visual pulse still signals the wake.
  }
}

export interface WakeWordState {
  active: boolean;
  error: string | null;
  /**
   * Whether a template exists for this word. `null` until the listener has
   * been asked — distinguishing "not trained" from "not yet known" is what
   * keeps a warning from flashing up on every launch before the answer lands.
   */
  trained: boolean | null;
}

export function useWakeWord(onWake: () => void) {
  const [state, setState] = useState<WakeWordState>({
    active: false,
    error: null,
    trained: null,
  });
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const onWakeRef = useRef(onWake);
  const shouldRunRef = useRef(false);
  const unlistenRef = useRef<Array<() => void>>([]);

  const enabled = useSettings((s) => s.settings.voice.wakeWordEnabled);
  const wakeWord = useSettings((s) => s.settings.voice.wakeWord);
  const chimeEnabled = useSettings((s) => s.settings.voice.activationSound);
  const sensitivity = useSettings((s) => s.settings.voice.wakeWordSensitivity);

  useEffect(() => {
    onWakeRef.current = onWake;
  }, [onWake]);

  /* ── Desktop: the Rust listener ── */

  const stopNative = useCallback(async () => {
    unlistenRef.current.forEach((off) => off());
    unlistenRef.current = [];
    try {
      const { desktop } = await import('@/platform/desktop');
      await desktop.stopWakeWord();
    } catch {
      // Already stopped.
    }
    setState((s) => ({ ...s, active: false }));
  }, []);

  const startNative = useCallback(async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const { desktop } = await import('@/platform/desktop');

      const status = await desktop.wakeWordStatus(wakeWord);

      // Without a recorded template there is nothing to match against. This is
      // not an error — nothing is broken — but it is silent, and the caller has
      // to be able to tell the user why saying the wake word does nothing.
      if (!status.trained) {
        setState({ active: false, error: null, trained: false });
        return;
      }

      // Subscribed before starting, so a wake in the first moments is not lost.
      unlistenRef.current.push(
        await listen('wake-word-detected', () => {
          if (chimeEnabled) playActivationChime();
          onWakeRef.current();
        }),
      );
      unlistenRef.current.push(
        await listen<string>('wake-word-error', (event) => {
          setState((s) => ({ ...s, active: false, error: event.payload }));
        }),
      );

      await desktop.setWakeWordSensitivity(sensitivity);
      await desktop.startWakeWord(wakeWord);
      setState({ active: true, error: null, trained: true });
    } catch (e) {
      setState((s) => ({
        ...s,
        active: false,
        error: typeof e === 'string' ? e : e instanceof Error ? e.message : String(e),
      }));
    }
  }, [wakeWord, chimeEnabled, sensitivity]);

  /* ── Mobile: the platform recogniser ── */

  const stopBrowser = useCallback(() => {
    shouldRunRef.current = false;
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    setState((s) => ({ ...s, active: false }));
  }, []);

  const startBrowser = useCallback(() => {
    const Recognition = getRecognition();
    if (!Recognition) {
      setState((s) => ({
        ...s,
        error: 'Continuous listening is not available on this device.',
      }));
      return;
    }
    if (recognitionRef.current) return;

    shouldRunRef.current = true;
    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i]?.[0]?.transcript ?? '';
        if (matchesWakeWord(transcript, wakeWord)) {
          if (isMobile) {
            void import('@capacitor/haptics').then(({ Haptics, ImpactStyle }) =>
              Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {}),
            );
          }
          if (chimeEnabled) playActivationChime();
          onWakeRef.current();
          return;
        }
      }
    };

    recognition.onerror = (event) => {
      // "no-speech" fires constantly during silence and is not a real failure.
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        setState((s) => ({ ...s, error: `Wake word listener: ${event.error}` }));
      }
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setState((s) => ({ ...s, active: false }));
      if (shouldRunRef.current) {
        setTimeout(() => {
          if (shouldRunRef.current) startBrowser();
        }, 400);
      }
    };

    try {
      recognition.start();
      setState({ active: true, error: null, trained: true });
    } catch {
      recognitionRef.current = null;
    }
  }, [wakeWord, chimeEnabled]);

  useEffect(() => {
    if (!enabled) {
      if (isTauri) void stopNative();
      else stopBrowser();
      return;
    }

    if (isTauri) {
      void startNative();
      return () => void stopNative();
    }

    startBrowser();
    return stopBrowser;
  }, [enabled, startNative, stopNative, startBrowser, stopBrowser]);

  return {
    active: state.active,
    error: state.error,
    trained: state.trained,
    /**
     * Switched on, but there is no voice sample to match against — so it is
     * listening for nothing. The distinction matters: this is the one failure
     * mode with no symptom at all.
     */
    needsTraining: enabled && state.trained === false && !state.error,
    start: isTauri ? startNative : startBrowser,
    stop: isTauri ? stopNative : stopBrowser,
  };
}
