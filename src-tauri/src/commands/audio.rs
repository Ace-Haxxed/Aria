//! Microphone capture through the host audio API.
//!
//! WebKitGTK cannot serve `getUserMedia` on a Wayland session — the webview has
//! no route to PipeWire and the request fails before any permission prompt is
//! shown — so nothing in ARIA is allowed to ask the browser for audio. Every
//! sample comes from cpal instead: ALSA on Linux, WASAPI on Windows, CoreAudio
//! on macOS. That is also why this path needs no portal and no user setup.
//!
//! A capture session lives on its own thread because a cpal `Stream` is neither
//! `Send` nor `Sync`: the thread owns the stream for its whole life and is
//! steered through an `AtomicBool`. Audio is resampled to the 16 kHz mono that
//! whisper wants as it arrives, so `stop_capture` only has to wrap the buffer
//! in a WAV header.

use crate::util::{JResult, AriaError};
use base64::Engine;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// What whisper expects. Resampling here rather than in the frontend keeps the
/// conversion in one place and off the UI thread.
const TARGET_RATE: u32 = 16_000;

/// Hard ceiling on a single recording (10 minutes). A push-to-talk that never
/// receives its release — a dropped hotkey, a crashed webview — must not grow
/// the buffer until the process is killed.
const MAX_SAMPLES: usize = TARGET_RATE as usize * 600;

/// How long to wait for the audio backend to hand over the first callback.
/// PipeWire and CoreAudio both settle well inside this; an unplugged or
/// exclusively-held device never will.
const FIRST_CHUNK_TIMEOUT: Duration = Duration::from_millis(2_500);

/// Below this RMS a block counts as silence for end-of-speech detection.
/// Set above typical room tone so a quiet room does not read as speech, and
/// below normal speaking level so a soft talker is not cut off.
const SPEECH_RMS: f32 = 0.02;

/// Ignore silence until this much speech has been heard, so the pause between
/// pressing the key and starting to talk does not end the recording instantly.
const MIN_SPEECH_MS: u32 = 300;

/* ── Resampling ─────────────────────────────────────────────────── */

/// Linear resampler that keeps its phase between callbacks.
///
/// Resampling each callback independently would restart the interpolation at
/// every block boundary and print a click into the audio roughly 20 times a
/// second, which measurably hurts transcription. Carrying `pos` and the
/// unconsumed `tail` across calls makes the output one continuous stream.
struct Resampler {
    /// Source samples consumed per output sample.
    ratio: f64,
    /// Fractional read position within `tail`.
    pos: f64,
    /// Source samples not yet consumed, kept for the next callback.
    tail: Vec<f32>,
}

impl Resampler {
    fn new(src_rate: u32) -> Self {
        Self {
            ratio: src_rate as f64 / TARGET_RATE as f64,
            pos: 0.0,
            tail: Vec::new(),
        }
    }

    fn process(&mut self, input: &[f32]) -> Vec<f32> {
        self.tail.extend_from_slice(input);

        // Interpolating at `pos` reads `pos + 1`, so stop one sample short of
        // the end and leave the remainder for the next block.
        let mut out = Vec::with_capacity(((self.tail.len() as f64) / self.ratio) as usize + 1);
        while self.pos + 1.0 < self.tail.len() as f64 {
            let i = self.pos as usize;
            let frac = (self.pos - i as f64) as f32;
            out.push(self.tail[i] + (self.tail[i + 1] - self.tail[i]) * frac);
            self.pos += self.ratio;
        }

        let consumed = (self.pos as usize).min(self.tail.len());
        self.tail.drain(..consumed);
        self.pos -= consumed as f64;
        out
    }
}

/* ── WAV ────────────────────────────────────────────────────────── */

/// Wrap 16 kHz mono float samples in a PCM-16 WAV container.
fn encode_wav(samples: &[f32]) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let mut out = Vec::with_capacity(44 + data_len);

    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM header size
    out.extend_from_slice(&1u16.to_le_bytes()); // format: PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // channels: mono
    out.extend_from_slice(&TARGET_RATE.to_le_bytes());
    out.extend_from_slice(&(TARGET_RATE * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());

    for &s in samples {
        out.extend_from_slice(&to_i16(s).to_le_bytes());
    }
    out
}

/// Float -1..1 to signed 16-bit, clamped so a hot mic wraps to full scale
/// instead of inverting.
fn to_i16(sample: f32) -> i16 {
    let clamped = sample.clamp(-1.0, 1.0);
    if clamped < 0.0 {
        (clamped * 32_768.0) as i16
    } else {
        (clamped * 32_767.0) as i16
    }
}

fn pcm16_base64(samples: &[f32]) -> String {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        bytes.extend_from_slice(&to_i16(s).to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/* ── Session state ──────────────────────────────────────────────── */

struct Session {
    running: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    /// Resolves once the capture thread has torn its stream down, so a
    /// stop/start pair cannot leave two streams contending for the device.
    finished: mpsc::Receiver<()>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// Lock helper — a panic inside a cpal callback would otherwise poison the
/// mutex and wedge every later capture behind an `unwrap`.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/* ── Device helpers ─────────────────────────────────────────────── */

/// The device the user picked in Settings, or empty for the system default.
static PREFERRED_INPUT: Mutex<String> = Mutex::new(String::new());

/// Remember which microphone to open. Empty restores the system default.
#[tauri::command]
pub async fn set_input_device(name: Option<String>) -> JResult<()> {
    *lock(&PREFERRED_INPUT) = name.unwrap_or_default();
    Ok(())
}

fn default_input() -> JResult<(cpal::Device, cpal::SupportedStreamConfig)> {
    let host = cpal::default_host();

    // A named device the user chose. Falls through to the system default if it
    // has since been unplugged, which is better than refusing to record.
    let preferred = lock(&PREFERRED_INPUT).clone();
    if !preferred.is_empty() {
        if let Ok(mut devices) = host.input_devices() {
            if let Some(device) =
                devices.find(|d| d.name().is_ok_and(|n| n == preferred))
            {
                if let Ok(config) = device.default_input_config() {
                    return Ok((device, config));
                }
            }
        }
    }

    let device = host.default_input_device().ok_or_else(|| {
        AriaError::msg(
            "No microphone was found. Plug one in, or pick an input device in your \
             system sound settings, then try again.",
        )
    })?;
    let config = device.default_input_config().map_err(|e| {
        AriaError::msg(format!(
            "The default microphone could not be opened: {e}. Another application may \
             have it open exclusively."
        ))
    })?;
    Ok((device, config))
}

fn device_name(device: &cpal::Device) -> String {
    device.name().unwrap_or_else(|_| "default input".to_string())
}

/// Every input device the host can enumerate, for the picker in Settings.
///
/// Returns an empty list rather than an error when enumeration fails: not
/// being able to name the devices is not a reason to fail opening Settings,
/// and the system default still works.
#[tauri::command]
pub async fn list_microphones() -> JResult<Vec<String>> {
    Ok(tokio::task::spawn_blocking(|| {
        let host = cpal::default_host();
        let Ok(devices) = host.input_devices() else {
            return Vec::new();
        };
        let mut names: Vec<String> = devices.filter_map(|d| d.name().ok()).collect();
        // Duplicates are normal on ALSA, which lists the same card under
        // several plugin names.
        names.sort();
        names.dedup();
        names
    })
    .await
    .unwrap_or_default())
}

/// Build an input stream for one concrete sample format, converting whatever
/// the device natively produces into mono f32.
///
/// Devices are not required to offer f32 — plenty of USB microphones and every
/// WASAPI shared-mode endpoint report i16 — so all three formats cpal exposes
/// have to be handled or the stream fails to build on perfectly normal hardware.
fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut on_block: impl FnMut(&[f32]) + Send + 'static,
    on_error: impl Fn(String) + Send + 'static,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels.max(1) as usize;
    device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            // Average the channels: a stereo headset with one dead capsule
            // still produces usable speech this way.
            let mono: Vec<f32> = data
                .chunks(channels)
                .map(|frame| {
                    frame.iter().map(|s| f32::from_sample_(*s)).sum::<f32>() / frame.len() as f32
                })
                .collect();
            on_block(&mono);
        },
        move |err| on_error(err.to_string()),
        None,
    )
}

/// Dispatch on the device's native format and build the stream.
fn open_stream(
    device: &cpal::Device,
    supported: &cpal::SupportedStreamConfig,
    on_block: impl FnMut(&[f32]) + Send + 'static,
    on_error: impl Fn(String) + Send + 'static,
) -> JResult<cpal::Stream> {
    let config: cpal::StreamConfig = supported.config();
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => build_stream::<f32>(device, &config, on_block, on_error),
        cpal::SampleFormat::I16 => build_stream::<i16>(device, &config, on_block, on_error),
        cpal::SampleFormat::U16 => build_stream::<u16>(device, &config, on_block, on_error),
        other => {
            return Err(AriaError::msg(format!(
                "The microphone reports an unsupported sample format ({other:?})."
            )))
        }
    };

    stream.map_err(|e| AriaError::msg(format!("The microphone could not be opened: {e}")))
}

/* ── Commands ───────────────────────────────────────────────────── */

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicTest {
    pub ok: bool,
    pub device: String,
    pub sample_rate: u32,
    pub channels: u16,
}

/// Prove the microphone actually delivers audio.
///
/// Querying the device's config is not a test — it succeeds on a machine whose
/// microphone is muted at the hardware switch or held exclusively by another
/// process. This opens a real stream and waits for a real callback, which is
/// the only thing that distinguishes a working input from a listed one.
#[tauri::command]
pub async fn test_microphone() -> JResult<MicTest> {
    // The wake-word listener holds the input device while it is running, so
    // testing without handing it over would report a working microphone as
    // busy — and that is the machine most likely to be running this test.
    super::wakeword::pause();
    let outcome = tokio::task::spawn_blocking(|| {
        let (device, supported) = default_input()?;
        let name = device_name(&device);
        let sample_rate = supported.sample_rate().0;
        let channels = supported.channels();

        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        let err_tx = tx.clone();

        let stream = open_stream(
            &device,
            &supported,
            move |block| {
                if !block.is_empty() {
                    // Only the first callback matters; the rest race and lose
                    // once the receiver is dropped, which is harmless.
                    let _ = tx.send(Ok(()));
                }
            },
            move |e| {
                let _ = err_tx.send(Err(e));
            },
        )?;

        stream
            .play()
            .map_err(|e| AriaError::msg(format!("The microphone could not be started: {e}")))?;

        let verdict = rx.recv_timeout(FIRST_CHUNK_TIMEOUT);
        drop(stream);

        match verdict {
            Ok(Ok(())) => Ok(MicTest {
                ok: true,
                device: name,
                sample_rate,
                channels,
            }),
            Ok(Err(e)) => Err(AriaError::msg(format!("The microphone reported: {e}"))),
            Err(_) => Err(AriaError::msg(format!(
                "`{name}` opened but produced no audio. Check that it is not muted \
                 in your system sound settings."
            ))),
        }
    })
    .await;
    // Give the device back whatever the outcome was; a failed test must not
    // leave the wake word deaf.
    super::wakeword::resume();

    outcome.map_err(|e| AriaError::msg(format!("microphone test did not finish: {e}")))?
}

/// Begin recording. Audio streams to the frontend as `mic-chunk` (base64 PCM-16
/// at 16 kHz mono) and `mic-level` (0-1, for the orb); the authoritative buffer
/// is kept here and returned whole by [`stop_capture`].
#[tauri::command]
pub async fn start_capture(app: AppHandle, silence_timeout_ms: Option<u32>) -> JResult<()> {
    // 0 disables auto-stop; the frontend passes the user's setting.
    let silence_timeout_ms = silence_timeout_ms.unwrap_or(800).max(1);
    // Starting twice would leave the first stream running and unreachable.
    stop_session();

    // Hand the microphone over. Two input streams on one device either fail to
    // open or fight for it, and scoring the user's actual question against the
    // wake word would be wasted work in any case.
    super::wakeword::pause();

    tokio::task::spawn_blocking(move || {
        let running = Arc::new(AtomicBool::new(true));
        let samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let (finished_tx, finished_rx) = mpsc::channel::<()>();

        {
            let running = running.clone();
            let samples = samples.clone();

            std::thread::Builder::new()
                .name("aria-mic".into())
                .spawn(move || {
                    // The thread owns the stream for its entire life: cpal
                    // streams are !Send, so it can never be handed back.
                    let opened = (|| -> JResult<cpal::Stream> {
                        let (device, supported) = default_input()?;
                        let mut resampler = Resampler::new(supported.sample_rate().0);

                        let app_audio = app.clone();
                        let app_err = app.clone();
                        let running_cb = running.clone();

                        // Per-session speech/silence counters, owned by the
                        // audio callback.
                        let mut spoken_ms: u32 = 0;
                        let mut silent_ms: u32 = 0;
                        let mut signalled = false;

                        open_stream(
                            &device,
                            &supported,
                            move |block| {
                                if !running_cb.load(Ordering::Relaxed) {
                                    return;
                                }
                                let resampled = resampler.process(block);
                                if resampled.is_empty() {
                                    return;
                                }

                                let mut buf = lock(&samples);
                                if buf.len() >= MAX_SAMPLES {
                                    running_cb.store(false, Ordering::Relaxed);
                                    return;
                                }
                                buf.extend_from_slice(&resampled);
                                drop(buf);

                                let rms = (resampled.iter().map(|s| s * s).sum::<f32>()
                                    / resampled.len() as f32)
                                    .sqrt();
                                let _ = app_audio.emit("mic-level", (rms * 3.0).min(1.0));
                                let _ = app_audio.emit("mic-chunk", pcm16_base64(&resampled));

                                // End-of-speech detection. Waiting for the user
                                // to release a key adds a beat of dead time to
                                // every single utterance; noticing that they
                                // stopped talking removes it.
                                let block_ms =
                                    (resampled.len() as u32 * 1_000) / TARGET_RATE;
                                if rms >= SPEECH_RMS {
                                    spoken_ms += block_ms;
                                    silent_ms = 0;
                                } else if spoken_ms >= MIN_SPEECH_MS {
                                    silent_ms += block_ms;
                                    if silent_ms >= silence_timeout_ms && !signalled {
                                        signalled = true;
                                        // Advisory: the frontend decides whether
                                        // to act on it, because a user holding
                                        // the button is deliberately still
                                        // recording.
                                        let _ = app_audio.emit("mic-silence", spoken_ms);
                                    }
                                }
                            },
                            move |e| {
                                let _ = app_err.emit("mic-error", e);
                            },
                        )
                        .and_then(|s| {
                            s.play().map_err(|e| {
                                AriaError::msg(format!("the microphone did not start: {e}"))
                            })?;
                            Ok(s)
                        })
                    })();

                    let stream = match opened {
                        Ok(s) => {
                            let _ = ready_tx.send(Ok(()));
                            s
                        }
                        Err(e) => {
                            let _ = ready_tx.send(Err(e.to_string()));
                            let _ = finished_tx.send(());
                            return;
                        }
                    };

                    while running.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(20));
                    }

                    // Explicit, so the device is released before the handshake
                    // tells `stop_capture` it is safe to start another session.
                    drop(stream);
                    let _ = finished_tx.send(());
                })
                .map_err(|e| AriaError::msg(format!("could not start the audio thread: {e}")))?;
        }

        // Surface a failure to open the device as a failed `start_capture`
        // rather than as silence the user only notices on release.
        match ready_rx.recv_timeout(FIRST_CHUNK_TIMEOUT) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(AriaError::msg(e)),
            Err(_) => {
                running.store(false, Ordering::Relaxed);
                return Err(AriaError::msg(
                    "The microphone did not respond in time. Another application may be \
                     using it exclusively.",
                ));
            }
        }

        *lock(&SESSION) = Some(Session {
            running,
            samples,
            finished: finished_rx,
        });
        Ok(())
    })
    .await
    .map_err(|e| AriaError::msg(format!("capture did not start: {e}")))?
}

/// Signal the capture thread to stop and wait for it to release the device.
/// Returns the samples it collected, or `None` if nothing was recording.
fn stop_session() -> Option<Vec<f32>> {
    // Give the microphone back to the wake-word listener whether or not a
    // session was running, so a failed start cannot leave it paused forever.
    super::wakeword::resume();

    let session = lock(&SESSION).take()?;
    session.running.store(false, Ordering::Relaxed);

    // The thread polls the flag every 20ms; this only ever waits that long,
    // and the timeout means a wedged audio backend cannot hang the UI.
    let _ = session.finished.recv_timeout(Duration::from_secs(3));

    let samples = std::mem::take(&mut *lock(&session.samples));
    Some(samples)
}

/// Stop recording and return the take as a base64 WAV (16 kHz mono PCM-16),
/// ready to hand to `transcribe`.
///
/// The frontend gets the audio from this return value rather than by
/// reassembling `mic-chunk` events: those exist to drive the meter, and an
/// event dropped under load would silently truncate the transcript.
#[tauri::command]
pub async fn stop_capture() -> JResult<String> {
    let samples = tokio::task::spawn_blocking(stop_session)
        .await
        .map_err(|e| AriaError::msg(format!("capture did not stop cleanly: {e}")))?;

    let samples = samples.unwrap_or_default();
    Ok(base64::engine::general_purpose::STANDARD.encode(encode_wav(&samples)))
}

/// Is a capture session currently open? Used on reconnect so the UI can
/// resynchronise after a webview reload.
#[tauri::command]
pub async fn is_capturing() -> JResult<bool> {
    Ok(lock(&SESSION).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_halves_a_32k_stream() {
        let mut r = Resampler::new(32_000);
        let input: Vec<f32> = (0..3_200).map(|i| i as f32 / 3_200.0).collect();
        let out = r.process(&input);
        // 3200 source samples at 32k is 100ms, which is 1600 samples at 16k.
        assert!((out.len() as i32 - 1_600).abs() <= 1, "got {}", out.len());
    }

    #[test]
    fn resampler_keeps_phase_across_blocks() {
        // A continuous ramp fed in two blocks must come out monotonic: a
        // resampler that restarted each block would step backwards at the seam.
        let mut r = Resampler::new(48_000);
        let mut out = Vec::new();
        for block in 0..2 {
            let input: Vec<f32> = (0..480)
                .map(|i| (block * 480 + i) as f32 / 960.0)
                .collect();
            out.extend(r.process(&input));
        }
        assert!(out.len() > 100);
        assert!(
            out.windows(2).all(|w| w[1] >= w[0] - 1e-6),
            "resampled ramp is not monotonic"
        );
    }

    #[test]
    fn resampler_passes_matching_rate_through() {
        let mut r = Resampler::new(TARGET_RATE);
        let input: Vec<f32> = (0..1_000).map(|i| (i % 7) as f32 / 7.0).collect();
        let out = r.process(&input);
        assert!((out.len() as i32 - 1_000).abs() <= 1);
        assert!((out[0] - input[0]).abs() < 1e-6);
    }

    #[test]
    fn wav_header_describes_the_payload() {
        let wav = encode_wav(&[0.0, 0.5, -0.5, 1.0]);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(wav.len(), 44 + 8);
        // data chunk length
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 8);
        // sample rate
        assert_eq!(
            u32::from_le_bytes(wav[24..28].try_into().unwrap()),
            TARGET_RATE
        );
    }

    #[test]
    fn full_scale_samples_do_not_wrap() {
        assert_eq!(to_i16(1.0), 32_767);
        assert_eq!(to_i16(-1.0), -32_768);
        // Clipping must saturate, not invert.
        assert_eq!(to_i16(4.2), 32_767);
        assert_eq!(to_i16(-4.2), -32_768);
    }
}
