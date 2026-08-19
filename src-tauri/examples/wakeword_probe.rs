//! Live probe of the wake-word spotter: `cargo run --release --example wakeword_probe`.
//!
//! Unit tests use synthesised vowels. This checks the parts that only a real
//! microphone can exercise: that the capture path works, that a recorded word
//! matches itself, and roughly what it costs to score a window — the figure
//! that decides whether an always-on listener is acceptable.

use std::time::Instant;

fn main() {
    println!("This probe records three short clips. Follow the prompts.\n");

    let word = std::env::args().nth(1).unwrap_or_else(|| "jarvis".to_string());

    // 1. Record a template.
    println!("Say \"{word}\" when you see GO (1.8s)...");
    countdown();
    let template = match record() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("recording failed: {e}");
            std::process::exit(1);
        }
    };
    println!("  captured {} samples\n", template.len());

    // 2. The same word again — should match.
    println!("Say \"{word}\" AGAIN when you see GO...");
    countdown();
    let same = record().expect("record");

    // 3. A different word — should not match.
    println!("Now say \"Travis\" when you see GO...");
    countdown();
    let other = record().expect("record");

    // Scoring, and how long it takes.
    let started = Instant::now();
    let score_same = nova_lib::commands::wakeword::probe_score(&template, &same);
    let per_window_ms = started.elapsed().as_millis();
    let score_other = nova_lib::commands::wakeword::probe_score(&template, &other);

    println!("\n--- results ---");
    println!("same word  : {score_same:.3}");
    println!("other word : {score_other:.3}");
    println!("scoring cost: {per_window_ms} ms per window");
    println!(
        "at 3 scores/sec that is roughly {:.1}% of one core",
        (per_window_ms as f32 * 3.0) / 10.0
    );

    for sensitivity in [3u32, 5, 7, 9] {
        let threshold = nova_lib::commands::wakeword::probe_threshold(sensitivity);
        println!(
            "  sensitivity {sensitivity}: threshold {threshold:.2} -> same={} other={}",
            if score_same <= threshold { "FIRE" } else { "miss" },
            if score_other <= threshold { "FIRE (false positive)" } else { "reject" },
        );
    }

    if score_same < score_other {
        println!("\nOK: the wake word scores closer than the decoy.");
    } else {
        println!("\nWARNING: the decoy scored as close or closer. Record more templates.");
    }
}

fn countdown() {
    for n in ["3", "2", "1", "GO"] {
        println!("  {n}");
        std::thread::sleep(std::time::Duration::from_millis(600));
    }
}

fn record() -> Result<Vec<f32>, String> {
    nova_lib::commands::wakeword::probe_record(std::time::Duration::from_millis(1_800))
        .map_err(|e| e.to_string())
}
