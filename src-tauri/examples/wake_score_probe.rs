//! What does the spotter score against *this* room, right now?
//!
//! `cargo run --release --example wake_score_probe [word] [seconds]`
//!
//! The interactive probe needs someone to say the word. This one needs nobody:
//! it records ambient audio, scores every window against the stored template
//! exactly as the listener does, and reports how close the room alone comes to
//! the firing threshold. A room that scores *below* the threshold means the
//! wake word is firing continuously on nothing, which looks identical to it
//! being broken — the microphone opens, records silence, and transcribes it.

use std::time::Duration;

/// Score a spoken utterance against the stored template.
///
/// This is the decisive measurement. The listener slides a 1.6 s window, so
/// the utterance is scored the same way rather than as one fixed block — a
/// word spoken slightly late in the take would otherwise score badly for a
/// reason the real listener never suffers.
fn live_pass(templates: &[Vec<[f32; 13]>], word: &str, threshold: f32) {
    println!("Say \"{word}\" once, clearly, when you see GO.");
    for n in (1..=3).rev() {
        println!("  {n}...");
        std::thread::sleep(Duration::from_millis(700));
    }
    println!("  GO (2.5s)");

    let samples = match aria_lib::commands::wakeword::probe_record(Duration::from_millis(2_500)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("recording failed: {e}");
            std::process::exit(1);
        }
    };

    let window = (16_000.0 * 1.6) as usize;
    let step = 16_000 / 10;
    let mut best = f32::MAX;
    let mut best_at = 0.0;

    let mut start = 0;
    while start + window <= samples.len() {
        let slice = &samples[start..start + window];
        let d = aria_lib::commands::wakeword::probe_score_frames(templates, slice);
        if d < best {
            best = d;
            best_at = start as f32 / 16_000.0;
        }
        start += step;
    }

    let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32).sqrt();
    println!("\ncaptured RMS {rms:.5}");
    if rms < 0.012 {
        println!("That was below the silence floor — nothing was heard at all.");
        return;
    }

    println!("best window: distance {best:.2} at t={best_at:.2}s");
    println!("firing threshold at sensitivity 7: {threshold:.2}");
    println!(
        "loosest possible threshold (sensitivity 10): {:.2}",
        aria_lib::commands::wakeword::probe_threshold(10)
    );

    if best <= threshold {
        println!("\nRESULT: this utterance WOULD fire. The spotter is working.");
    } else if best <= aria_lib::commands::wakeword::probe_threshold(10) {
        println!("\nRESULT: too far at sensitivity 7, but within reach — raising");
        println!("sensitivity in Settings would make it fire.");
    } else {
        println!("\nRESULT: this utterance CANNOT fire at any sensitivity. Either the");
        println!("stored template does not match how you say it — retrain it — or the");
        println!("threshold range itself is too tight for real speech.");
    }
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    // `--live` scores a spoken utterance against the stored template, which is
    // the question the ambient pass cannot answer: the room not firing proves
    // no false positives, not that a real "aria" ever clears the threshold.
    let live = args.iter().any(|a| a == "--live");
    args.retain(|a| a != "--live");

    let word = args.first().cloned().unwrap_or_else(|| "aria".to_string());
    let seconds: f32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(6.0);

    let templates = aria_lib::commands::wakeword::probe_templates(&word);
    println!("word: {word:?}");
    println!("templates found: {}", templates.len());
    if templates.is_empty() {
        println!("\nNo template. The listener starts and immediately stops — this alone");
        println!("is enough for the wake word to do nothing at all.");
        return;
    }

    let sensitivity = 7;
    let threshold = aria_lib::commands::wakeword::probe_threshold(sensitivity);
    println!("sensitivity {sensitivity} -> fires at distance <= {threshold:.2}");
    println!(
        "the full sensitivity range 1-10 spans {:.2} to {:.2}\n",
        aria_lib::commands::wakeword::probe_threshold(1),
        aria_lib::commands::wakeword::probe_threshold(10)
    );

    if live {
        live_pass(&templates, &word, threshold);
        return;
    }

    println!("recording {seconds:.0}s of whatever the room is doing (say nothing)...");

    let samples = match aria_lib::commands::wakeword::probe_record(Duration::from_secs_f32(seconds))
    {
        Ok(s) => s,
        Err(e) => {
            eprintln!("recording failed: {e}");
            std::process::exit(1);
        }
    };

    let floor = aria_lib::commands::wakeword::probe_silence_floor();
    let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32).sqrt();
    let peak = aria_lib::commands::wakeword::probe_peak_rms(&samples);
    println!("captured {} samples", samples.len());
    println!("  mean RMS over the whole take: {rms:.5}");
    println!("  loudest 100ms in it:          {peak:.5}");
    println!("  silence floor:                {floor:.5}\n");

    // Score every 1.6s window, the same length the listener uses. The gate is
    // the loudest 100 ms of the window, matching the listener — the mean is
    // printed alongside to show how much the two differ.
    let window = (16_000.0 * 1.6) as usize;
    let step = window / 4;
    let mut fired = 0;
    let mut best = f32::MAX;
    let mut scored = 0;
    let mut gated_out_by_mean = 0;

    let mut start = 0;
    while start + window <= samples.len() {
        let slice = &samples[start..start + window];
        let wmean = (slice.iter().map(|s| s * s).sum::<f32>() / slice.len() as f32).sqrt();
        let wpeak = aria_lib::commands::wakeword::probe_peak_rms(slice);
        if wpeak >= floor {
            if wmean < floor {
                // The old gate would have thrown this window away unscored.
                gated_out_by_mean += 1;
            }
            let d = aria_lib::commands::wakeword::probe_score_frames(&templates, slice);
            scored += 1;
            best = best.min(d);
            let hit = d <= threshold;
            if hit {
                fired += 1;
            }
            println!(
                "  t={:5.2}s mean={:.4} peak={:.4} distance={:6.2} {}",
                start as f32 / 16_000.0,
                wmean,
                wpeak,
                d,
                if hit { "<-- WOULD FIRE" } else { "" }
            );
        }
        start += step;
    }

    println!("\nwindows loud enough to score: {scored}");
    println!("  of those, {gated_out_by_mean} would have been discarded by the old mean-RMS gate");
    if scored == 0 {
        println!("Every window was below the silence floor even at its loudest — the");
        println!("microphone is picking up nothing. Check that it is not muted.");
        return;
    }
    println!("closest ambient match: {best:.2} (threshold {threshold:.2})");
    println!(
        "\nRESULT: ambient audio would fire {fired} time(s). {}",
        if fired > 0 {
            "The spotter is triggering on background noise."
        } else {
            "The spotter correctly ignores this room."
        }
    );
}
