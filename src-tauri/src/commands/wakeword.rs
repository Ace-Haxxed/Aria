//! Always-on wake word detection, in pure Rust.
//!
//! A background thread holds the microphone open and scores a rolling window
//! of audio against a template of the wake word. Nothing leaves the machine
//! and there is no model file to fetch — the alternative, Vosk, needs a
//! platform-specific shared library downloaded outside cargo, which would make
//! "no dependencies, no internet" untrue.
//!
//! ## How it recognises a word without a speech model
//!
//! The window is reduced to MFCCs — the standard compact description of the
//! shape of a sound, which is what makes "JAR-vis" spoken by two different
//! people look alike and "Travis" look different. Those frames are compared to
//! a stored template with dynamic time warping, which tolerates the same word
//! said faster or slower.
//!
//! This is a keyword spotter, not a recogniser: it answers "did that sound
//! like the wake word" and nothing else. It is deliberately cheap, because it
//! runs continuously — the expensive, accurate transcription only starts once
//! this has fired.

use crate::util::{JResult, AriaError};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use rustfft::{num_complex::Complex, FftPlanner};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Everything downstream works at this rate; the listener resamples to it.
const SAMPLE_RATE: usize = 16_000;
/// 25 ms analysis frames every 10 ms — the long-standing defaults for speech.
const FRAME_LEN: usize = 400;
const FRAME_STEP: usize = 160;
const N_MELS: usize = 26;
const N_MFCC: usize = 13;
/// Wake words are short; anything longer is a sentence, not a trigger.
const WINDOW_SECONDS: f32 = 1.6;
const WINDOW_SAMPLES: usize = (SAMPLE_RATE as f32 * WINDOW_SECONDS) as usize;

/// Below this the window is silence and is not worth scoring.
const SILENCE_RMS: f32 = 0.012;

/// Sensitivity, 1-10 from the UI, held as an integer for atomic access.
static SENSITIVITY: AtomicU32 = AtomicU32::new(7);
static RUNNING: AtomicBool = AtomicBool::new(false);
/// Set while the main recorder owns the microphone.
static PAUSED: AtomicBool = AtomicBool::new(false);

/// Handle to the listener thread, so it can be stopped and joined.
static SESSION: Mutex<Option<mpsc::Receiver<()>>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/* ── Signal processing ──────────────────────────────────────────── */

/// Hz to mel. Mel spacing matches how human hearing resolves pitch, which is
/// what makes these features robust to a different speaker saying the same word.
fn hz_to_mel(hz: f32) -> f32 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

fn mel_to_hz(mel: f32) -> f32 {
    700.0 * (10f32.powf(mel / 2595.0) - 1.0)
}

/// Triangular mel filterbank over the FFT bins, built once and reused.
fn mel_filterbank(fft_size: usize) -> Vec<Vec<f32>> {
    let bins = fft_size / 2 + 1;
    let low = hz_to_mel(80.0);
    let high = hz_to_mel(SAMPLE_RATE as f32 / 2.0);

    let points: Vec<usize> = (0..N_MELS + 2)
        .map(|i| {
            let mel = low + (high - low) * i as f32 / (N_MELS + 1) as f32;
            ((mel_to_hz(mel) / (SAMPLE_RATE as f32 / 2.0)) * (bins - 1) as f32).round() as usize
        })
        .collect();

    (0..N_MELS)
        .map(|m| {
            let (start, centre, end) = (points[m], points[m + 1], points[m + 2]);
            let mut filter = vec![0.0; bins];
            for (bin, slot) in filter.iter_mut().enumerate().take(end.min(bins)) {
                if bin > start && bin <= centre && centre > start {
                    *slot = (bin - start) as f32 / (centre - start) as f32;
                } else if bin > centre && bin < end && end > centre {
                    *slot = (end - bin) as f32 / (end - centre) as f32;
                }
            }
            filter
        })
        .collect()
}

/// MFCC frames for a window of audio.
fn mfcc(samples: &[f32], filters: &[Vec<f32>], planner: &mut FftPlanner<f32>) -> Vec<[f32; N_MFCC]> {
    if samples.len() < FRAME_LEN {
        return Vec::new();
    }

    let fft_size = FRAME_LEN.next_power_of_two();
    let fft = planner.plan_fft_forward(fft_size);

    // Hamming window: without it, the frame edges act as discontinuities and
    // smear energy across every frequency bin.
    let hamming: Vec<f32> = (0..FRAME_LEN)
        .map(|i| 0.54 - 0.46 * (2.0 * std::f32::consts::PI * i as f32 / (FRAME_LEN - 1) as f32).cos())
        .collect();

    let mut out = Vec::new();
    let mut start = 0;

    while start + FRAME_LEN <= samples.len() {
        let mut buffer: Vec<Complex<f32>> = (0..fft_size)
            .map(|i| {
                let value = if i < FRAME_LEN {
                    samples[start + i] * hamming[i]
                } else {
                    0.0
                };
                Complex { re: value, im: 0.0 }
            })
            .collect();
        fft.process(&mut buffer);

        let power: Vec<f32> = buffer[..fft_size / 2 + 1]
            .iter()
            .map(|c| c.norm_sqr())
            .collect();

        // Log-energy per mel band.
        let energies: Vec<f32> = filters
            .iter()
            .map(|filter| {
                let sum: f32 = filter.iter().zip(&power).map(|(f, p)| f * p).sum();
                (sum + 1e-10).ln()
            })
            .collect();

        // DCT-II, keeping the low coefficients — they carry the shape of the
        // vocal tract, which is the part that identifies the word.
        let mut coefficients = [0.0f32; N_MFCC];
        for (k, slot) in coefficients.iter_mut().enumerate() {
            *slot = energies
                .iter()
                .enumerate()
                .map(|(n, e)| {
                    e * ((std::f32::consts::PI * k as f32 * (n as f32 + 0.5)) / N_MELS as f32).cos()
                })
                .sum();
        }

        out.push(coefficients);
        start += FRAME_STEP;
    }

    normalise(&mut out);
    out
}

/// Subtract the per-coefficient mean across the window.
///
/// This is cepstral mean normalisation: it cancels whatever the microphone and
/// room do to the signal, so a template recorded on one device still matches
/// audio from another.
fn normalise(frames: &mut [[f32; N_MFCC]]) {
    if frames.is_empty() {
        return;
    }
    for k in 0..N_MFCC {
        let mean: f32 = frames.iter().map(|f| f[k]).sum::<f32>() / frames.len() as f32;
        for frame in frames.iter_mut() {
            frame[k] -= mean;
        }
    }
}

fn distance(a: &[f32; N_MFCC], b: &[f32; N_MFCC]) -> f32 {
    a.iter()
        .zip(b.iter())
        .map(|(x, y)| (x - y) * (x - y))
        .sum::<f32>()
        .sqrt()
}

/// Dynamic time warping distance, normalised by path length.
///
/// Plain frame-by-frame comparison fails the moment someone says the word
/// slightly faster; DTW finds the best alignment between the two sequences
/// first, which is what makes the match speaking-rate independent.
fn dtw(a: &[[f32; N_MFCC]], b: &[[f32; N_MFCC]]) -> f32 {
    if a.is_empty() || b.is_empty() {
        return f32::MAX;
    }

    let mut previous = vec![f32::MAX; b.len() + 1];
    let mut current = vec![f32::MAX; b.len() + 1];
    previous[0] = 0.0;

    for i in 1..=a.len() {
        current[0] = f32::MAX;
        for j in 1..=b.len() {
            let cost = distance(&a[i - 1], &b[j - 1]);
            let best = previous[j].min(current[j - 1]).min(previous[j - 1]);
            current[j] = if best == f32::MAX { cost } else { cost + best };
        }
        std::mem::swap(&mut previous, &mut current);
    }

    previous[b.len()] / (a.len() + b.len()) as f32
}

/* ── Templates ──────────────────────────────────────────────────── */

/// Where a recorded wake-word template lives.
fn template_path(word: &str) -> JResult<std::path::PathBuf> {
    let dir = crate::util::data_subdir("wakeword")?;
    let safe: String = word
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    Ok(dir.join(format!("{}.template.json", safe.to_lowercase())))
}

fn load_templates(word: &str) -> Vec<Vec<[f32; N_MFCC]>> {
    let Ok(path) = template_path(word) else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<Vec<[f32; N_MFCC]>>>(&text).unwrap_or_default()
}

fn save_templates(word: &str, templates: &[Vec<[f32; N_MFCC]>]) -> JResult<()> {
    let path = template_path(word)?;
    let text =
        serde_json::to_string(templates).map_err(|e| AriaError::msg(e.to_string()))?;
    std::fs::write(path, text)?;
    Ok(())
}

/* ── Capture ────────────────────────────────────────────────────── */

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut on_block: impl FnMut(&[f32]) + Send + 'static,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels.max(1) as usize;
    device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            let mono: Vec<f32> = data
                .chunks(channels)
                .map(|frame| {
                    frame.iter().map(|s| f32::from_sample_(*s)).sum::<f32>() / frame.len() as f32
                })
                .collect();
            on_block(&mono);
        },
        |_| {},
        None,
    )
}

fn open_stream(
    device: &cpal::Device,
    supported: &cpal::SupportedStreamConfig,
    on_block: impl FnMut(&[f32]) + Send + 'static,
) -> JResult<cpal::Stream> {
    let config: cpal::StreamConfig = supported.config();
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => build_stream::<f32>(device, &config, on_block),
        cpal::SampleFormat::I16 => build_stream::<i16>(device, &config, on_block),
        cpal::SampleFormat::U16 => build_stream::<u16>(device, &config, on_block),
        other => {
            return Err(AriaError::msg(format!(
                "The microphone reports an unsupported sample format ({other:?})."
            )))
        }
    };
    stream.map_err(|e| AriaError::msg(format!("The microphone could not be opened: {e}")))
}

/* ── Commands ───────────────────────────────────────────────────── */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeWordStatus {
    pub running: bool,
    pub paused: bool,
    pub word: String,
    pub sensitivity: u32,
    /// False until the user has recorded a template — without one there is
    /// nothing to match against.
    pub trained: bool,
    pub templates: usize,
}

#[tauri::command]
pub async fn wake_word_status(word: String) -> JResult<WakeWordStatus> {
    let templates = load_templates(&word);
    Ok(WakeWordStatus {
        running: RUNNING.load(Ordering::Relaxed),
        paused: PAUSED.load(Ordering::Relaxed),
        word,
        sensitivity: SENSITIVITY.load(Ordering::Relaxed),
        trained: !templates.is_empty(),
        templates: templates.len(),
    })
}

#[tauri::command]
pub async fn set_wake_word_sensitivity(threshold: u32) -> JResult<()> {
    SENSITIVITY.store(threshold.clamp(1, 10), Ordering::Relaxed);
    Ok(())
}

/// Stop scoring while the main recorder has the microphone.
///
/// Two cpal input streams on one device either fail to open or fight over it,
/// and scoring the user's actual question for the wake word would be wasted
/// work regardless.
pub fn pause() {
    PAUSED.store(true, Ordering::Relaxed);
}

pub fn resume() {
    PAUSED.store(false, Ordering::Relaxed);
}

#[tauri::command]
pub async fn stop_wake_word() -> JResult<()> {
    RUNNING.store(false, Ordering::Relaxed);
    // Wait for the thread to release the device before returning, so a
    // start/stop pair cannot leave two listeners running.
    if let Some(finished) = lock(&SESSION).take() {
        let _ = finished.recv_timeout(Duration::from_secs(2));
    }
    Ok(())
}

/// Record one example of the wake word and store it as a template.
///
/// Templates are recorded rather than shipped: a stored average of other
/// people's voices matches the user's own far less well than two seconds of
/// their own speech, and it means a custom wake word works identically.
#[tauri::command]
pub async fn train_wake_word(word: String, replace: bool) -> JResult<WakeWordStatus> {
    let was_running = RUNNING.load(Ordering::Relaxed);
    if was_running {
        stop_wake_word().await?;
    }

    let captured = tokio::task::spawn_blocking(move || record_window(Duration::from_millis(1_800)))
        .await
        .map_err(|e| AriaError::msg(format!("recording failed: {e}")))??;

    let mut planner = FftPlanner::new();
    let filters = mel_filterbank(FRAME_LEN.next_power_of_two());
    let frames = mfcc(&captured, &filters, &mut planner);

    if frames.len() < 10 {
        return Err(AriaError::msg(
            "That was too short to learn from. Say the wake word clearly when the prompt appears.",
        ));
    }

    let rms = (captured.iter().map(|s| s * s).sum::<f32>() / captured.len() as f32).sqrt();
    if rms < SILENCE_RMS {
        return Err(AriaError::msg(
            "ARIA did not hear anything. Check your microphone and try again.",
        ));
    }

    let mut templates = if replace { Vec::new() } else { load_templates(&word) };
    templates.push(frames);
    // A handful of examples covers normal variation; more mostly adds
    // per-window comparison cost for no accuracy.
    if templates.len() > 5 {
        let excess = templates.len() - 5;
        templates.drain(..excess);
    }
    save_templates(&word, &templates)?;

    wake_word_status(word).await
}

/// Capture a fixed window of mono 16 kHz audio.
fn record_window(duration: Duration) -> JResult<Vec<f32>> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| AriaError::msg("No microphone was found."))?;
    let supported = device
        .default_input_config()
        .map_err(|e| AriaError::msg(format!("The microphone could not be opened: {e}")))?;

    let source_rate = supported.sample_rate().0 as usize;
    let collected = Arc::new(Mutex::new(Vec::<f32>::new()));
    let sink = collected.clone();

    let stream = open_stream(&device, &supported, move |block| {
        lock(&sink).extend_from_slice(block);
    })?;
    stream
        .play()
        .map_err(|e| AriaError::msg(format!("The microphone could not be started: {e}")))?;

    std::thread::sleep(duration);
    drop(stream);

    let raw = std::mem::take(&mut *lock(&collected));
    Ok(resample(&raw, source_rate))
}

/// Nearest-neighbour resample to 16 kHz.
///
/// Adequate here because MFCCs are computed from band energies, which are
/// insensitive to the interpolation artefacts this introduces — and it costs a
/// fraction of what a windowed-sinc resampler would on every block.
fn resample(input: &[f32], from_rate: usize) -> Vec<f32> {
    if from_rate == SAMPLE_RATE || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from_rate as f32 / SAMPLE_RATE as f32;
    let out_len = (input.len() as f32 / ratio) as usize;
    (0..out_len)
        .map(|i| input[((i as f32 * ratio) as usize).min(input.len() - 1)])
        .collect()
}

/// Start listening. Returns immediately; detection arrives as events.
#[tauri::command]
pub async fn start_wake_word(app: AppHandle, word: String) -> JResult<WakeWordStatus> {
    if RUNNING.load(Ordering::Relaxed) {
        return wake_word_status(word).await;
    }

    let templates = load_templates(&word);
    if templates.is_empty() {
        return Err(AriaError::msg(format!(
            "ARIA needs to hear you say \"{word}\" once before it can listen for it. Use Test in Settings → Voice."
        )));
    }

    let (finished_tx, finished_rx) = mpsc::channel::<()>();
    RUNNING.store(true, Ordering::Relaxed);
    PAUSED.store(false, Ordering::Relaxed);

    let word_for_thread = word.clone();
    std::thread::Builder::new()
        .name("jarvis-wakeword".into())
        .spawn(move || {
            listen_loop(app, word_for_thread, templates);
            let _ = finished_tx.send(());
        })
        .map_err(|e| AriaError::msg(format!("could not start the listener: {e}")))?;

    *lock(&SESSION) = Some(finished_rx);
    wake_word_status(word).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub word: String,
    /// 0-1; how close the match was, for the sensitivity readout.
    pub confidence: f32,
}

/// The listener. Holds the microphone and scores a sliding window.
fn listen_loop(app: AppHandle, word: String, templates: Vec<Vec<[f32; N_MFCC]>>) {
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        RUNNING.store(false, Ordering::Relaxed);
        let _ = app.emit("wake-word-error", "No microphone was found.");
        return;
    };
    let Ok(supported) = device.default_input_config() else {
        RUNNING.store(false, Ordering::Relaxed);
        let _ = app.emit("wake-word-error", "The microphone could not be opened.");
        return;
    };

    let source_rate = supported.sample_rate().0 as usize;
    let buffer = Arc::new(Mutex::new(Vec::<f32>::with_capacity(WINDOW_SAMPLES * 2)));
    let sink = buffer.clone();

    let stream = match open_stream(&device, &supported, move |block| {
        // Dropping audio while paused keeps the buffer from filling with the
        // user's actual question while the recorder has the device.
        if PAUSED.load(Ordering::Relaxed) {
            return;
        }
        let mut guard = lock(&sink);
        guard.extend_from_slice(block);
        // Bounded: this thread runs for the life of the app.
        let cap = WINDOW_SAMPLES * 3;
        if guard.len() > cap {
            let excess = guard.len() - cap;
            guard.drain(..excess);
        }
    }) {
        Ok(s) => s,
        Err(e) => {
            RUNNING.store(false, Ordering::Relaxed);
            let _ = app.emit("wake-word-error", e.to_string());
            return;
        }
    };

    if stream.play().is_err() {
        RUNNING.store(false, Ordering::Relaxed);
        let _ = app.emit("wake-word-error", "The microphone could not be started.");
        return;
    }

    let filters = mel_filterbank(FRAME_LEN.next_power_of_two());
    let mut planner = FftPlanner::new();
    // After a hit, ignore the next second: the same utterance would otherwise
    // match several overlapping windows and fire repeatedly.
    let mut cooldown_until = Instant::now();

    while RUNNING.load(Ordering::Relaxed) {
        // Scoring three times a second is responsive enough to feel immediate
        // while leaving the CPU idle in between.
        std::thread::sleep(Duration::from_millis(300));

        if PAUSED.load(Ordering::Relaxed) || Instant::now() < cooldown_until {
            continue;
        }

        let window: Vec<f32> = {
            let guard = lock(&buffer);
            let needed = (WINDOW_SAMPLES as f32 * source_rate as f32 / SAMPLE_RATE as f32) as usize;
            if guard.len() < needed {
                continue;
            }
            guard[guard.len() - needed..].to_vec()
        };

        let window = resample(&window, source_rate);

        // Silence is the overwhelmingly common case; rejecting it on a cheap
        // RMS check is what keeps idle CPU near zero.
        let rms = (window.iter().map(|s| s * s).sum::<f32>() / window.len().max(1) as f32).sqrt();
        if rms < SILENCE_RMS {
            continue;
        }

        let frames = mfcc(&window, &filters, &mut planner);
        if frames.is_empty() {
            continue;
        }

        let best = templates
            .iter()
            .map(|t| dtw(&frames, t))
            .fold(f32::MAX, f32::min);

        if best <= threshold_for(SENSITIVITY.load(Ordering::Relaxed)) {
            cooldown_until = Instant::now() + Duration::from_millis(1_500);

            // Bring the window forward: the point of a wake word is that it
            // works when the app is not in front of you.
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
                let _ = main.unminimize();
                let _ = main.set_focus();
            }

            let _ = app.emit(
                "wake-word-detected",
                Detection {
                    word: word.clone(),
                    confidence: confidence_from(best),
                },
            );
        }
    }

    drop(stream);
}

/// Sensitivity 1-10 to a DTW distance ceiling.
///
/// Higher sensitivity accepts a looser match. The range is deliberately narrow:
/// past roughly 10 the spotter starts accepting any similarly-shaped word, and
/// "Travis" is exactly that.
fn threshold_for(sensitivity: u32) -> f32 {
    let s = sensitivity.clamp(1, 10) as f32;
    3.0 + s * 0.7
}

fn confidence_from(distance: f32) -> f32 {
    // Map distance onto 0-1 for display; closer is better.
    (1.0 - (distance / 12.0)).clamp(0.0, 1.0)
}

/* ── Probe hooks ────────────────────────────────────────────────── */
//
// Thin wrappers so the manual probe can exercise the real capture and scoring
// path. Kept here rather than making the internals public, so the module's
// surface stays the commands.

/// Record a window of microphone audio, resampled to 16 kHz mono.
pub fn probe_record(duration: Duration) -> JResult<Vec<f32>> {
    record_window(duration)
}

/// Score two recordings against each other, exactly as the listener does.
pub fn probe_score(template: &[f32], candidate: &[f32]) -> f32 {
    let filters = mel_filterbank(FRAME_LEN.next_power_of_two());
    let mut planner = FftPlanner::new();
    let a = mfcc(template, &filters, &mut planner);
    let b = mfcc(candidate, &filters, &mut planner);
    dtw(&b, &a)
}

/// The distance ceiling for a sensitivity setting.
pub fn probe_threshold(sensitivity: u32) -> f32 {
    threshold_for(sensitivity)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A crude vowel-ish signal: two formants held for a fixed time.
    fn tone(freqs: &[f32], seconds: f32) -> Vec<f32> {
        let n = (SAMPLE_RATE as f32 * seconds) as usize;
        (0..n)
            .map(|i| {
                let t = i as f32 / SAMPLE_RATE as f32;
                freqs
                    .iter()
                    .map(|f| (2.0 * std::f32::consts::PI * f * t).sin())
                    .sum::<f32>()
                    / freqs.len() as f32
            })
            .collect()
    }

    /// A crude "word": a sequence of vowel-like segments.
    ///
    /// Steady tones are useless as test material here. Cepstral mean
    /// normalisation subtracts the average of each coefficient over the
    /// window, so a signal whose spectrum never changes collapses to nearly
    /// zero and every such signal matches every other. That is correct
    /// behaviour — the information a spotter uses is the *trajectory* of the
    /// spectrum — and it means a fair test has to vary over time, as speech
    /// does.
    fn word(segments: &[&[f32]], seconds_each: f32) -> Vec<f32> {
        segments
            .iter()
            .flat_map(|f| tone(f, seconds_each))
            .collect()
    }

    /// Two formant pairs standing in for distinct vowels.
    const AH: &[f32] = &[730.0, 1090.0];
    const EE: &[f32] = &[270.0, 2290.0];
    const OO: &[f32] = &[300.0, 870.0];

    fn features(samples: &[f32]) -> Vec<[f32; N_MFCC]> {
        let filters = mel_filterbank(FRAME_LEN.next_power_of_two());
        let mut planner = FftPlanner::new();
        mfcc(samples, &filters, &mut planner)
    }

    #[test]
    fn mel_scale_round_trips() {
        for hz in [80.0, 440.0, 1000.0, 4000.0] {
            let back = mel_to_hz(hz_to_mel(hz));
            assert!((back - hz).abs() < 1.0, "{hz} -> {back}");
        }
    }

    #[test]
    fn filterbank_covers_the_spectrum() {
        let filters = mel_filterbank(512);
        assert_eq!(filters.len(), N_MELS);
        // Every filter must pass something, or that band is dead weight.
        for (i, f) in filters.iter().enumerate() {
            assert!(f.iter().any(|&v| v > 0.0), "filter {i} is empty");
        }
    }

    #[test]
    fn mfcc_produces_frames_at_the_expected_rate() {
        let audio = tone(AH, 1.0);
        let frames = features(&audio);
        // 1s at 10ms steps, less one frame length.
        assert!(frames.len() > 90 && frames.len() < 102, "got {}", frames.len());
    }

    #[test]
    fn a_signal_matches_itself() {
        let a = features(&word(&[AH, EE, OO], 0.25));
        assert!(dtw(&a, &a) < 0.001, "identical audio should score ~0");
    }

    #[test]
    fn different_words_score_further_apart_than_the_same_word() {
        // The property the whole spotter rests on: the same sequence of sounds
        // scores close, a different sequence scores far.
        let spoken = features(&word(&[AH, EE, OO], 0.25));
        // The same word again, with the segment boundaries shifted slightly —
        // nobody says a word identically twice.
        let again = features(&word(&[AH, EE, OO], 0.27));
        // The same three vowels in a different order: same phonemes, different
        // word. This is the "Travis" case in miniature.
        let reordered = features(&word(&[OO, AH, EE], 0.25));

        let near = dtw(&spoken, &again);
        let far = dtw(&spoken, &reordered);
        assert!(near < far, "same word {near} should score below other word {far}");
    }

    #[test]
    fn dtw_tolerates_a_change_of_pace() {
        // The same word said faster must still match, which is the entire
        // reason for warping rather than comparing frame by frame.
        let slow = features(&word(&[AH, EE, OO], 0.30));
        let fast = features(&word(&[AH, EE, OO], 0.18));
        let unrelated = features(&word(&[EE, OO, AH], 0.30));

        let paced = dtw(&slow, &fast);
        let other = dtw(&slow, &unrelated);
        assert!(
            paced < other,
            "a faster utterance ({paced}) should beat a different word ({other})"
        );
    }

    #[test]
    fn a_stationary_signal_carries_no_word_identity() {
        // Documents the limitation behind the tests above: after cepstral mean
        // normalisation an unchanging spectrum collapses, so steady tones are
        // indistinguishable from each other. Real speech always varies, and
        // the spotter only ever sees speech-shaped input.
        let held_a = features(&tone(&[300.0, 900.0], 0.8));
        let held_b = features(&tone(&[1500.0, 3000.0], 0.8));
        assert!(
            dtw(&held_a, &held_b) < 1.0,
            "steady tones are expected to collapse together"
        );
    }

    #[test]
    fn dtw_handles_empty_input() {
        let a = features(&word(&[AH, EE], 0.25));
        assert_eq!(dtw(&a, &[]), f32::MAX);
        assert_eq!(dtw(&[], &a), f32::MAX);
    }

    #[test]
    fn sensitivity_is_monotonic_and_bounded() {
        let low = threshold_for(1);
        let high = threshold_for(10);
        assert!(low < high, "higher sensitivity must accept looser matches");
        // Beyond this the spotter fires on anything with speech in it.
        assert!(high <= 10.5, "threshold {high} is too permissive");
        // Out-of-range values from the UI must not widen it further.
        assert_eq!(threshold_for(99), high);
        assert_eq!(threshold_for(0), low);
    }

    #[test]
    fn confidence_is_normalised() {
        assert_eq!(confidence_from(0.0), 1.0);
        assert_eq!(confidence_from(100.0), 0.0);
        assert!((0.0..=1.0).contains(&confidence_from(6.0)));
    }

    #[test]
    fn resampling_halves_a_32k_stream() {
        let input: Vec<f32> = (0..3_200).map(|i| i as f32).collect();
        assert_eq!(resample(&input, 32_000).len(), 1_600);
        // A matching rate is passed straight through.
        assert_eq!(resample(&input, SAMPLE_RATE).len(), input.len());
    }

    #[test]
    fn normalisation_centres_each_coefficient() {
        let mut frames = vec![[1.0f32; N_MFCC], [3.0f32; N_MFCC]];
        normalise(&mut frames);
        for k in 0..N_MFCC {
            let mean = (frames[0][k] + frames[1][k]) / 2.0;
            assert!(mean.abs() < 1e-6, "coefficient {k} not centred");
        }
    }
}
