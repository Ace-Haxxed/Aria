//! Live probe of the paths the first-run flow and settings panel call:
//! `cargo run --example wiring_probe`.
//!
//! These are the commands behind buttons a person clicks, so they are checked
//! against the real filesystem and the real network rather than mocked.

use nova_lib::commands::{llm, training};

#[tokio::main]
async fn main() {
    training_round_trip().await;
    key_validation().await;
    println!("\nOK: training capture and key validation behave as the UI expects.");
}

async fn training_round_trip() {
    println!("== training data ==");

    let before = training::training_stats().await.expect("stats");
    println!("before: {} records at {}", before.count, before.path);

    let id = format!("probe-{}", std::process::id());
    training::training_append(training::TrainingRecord {
        id: id.clone(),
        timestamp: "2026-08-13T00:00:00Z".into(),
        user: "what is on my screen".into(),
        assistant: "A terminal and a browser.".into(),
        model_used: "llama3.1:8b-ollama".into(),
        quality_score: None,
        note: None,
    })
    .await
    .expect("append");

    // An empty half must be dropped rather than stored — it would teach a
    // fine-tune nothing and dilute the set.
    training::training_append(training::TrainingRecord {
        id: "probe-empty".into(),
        timestamp: "2026-08-13T00:00:00Z".into(),
        user: "   ".into(),
        assistant: "".into(),
        model_used: "x".into(),
        quality_score: None,
        note: None,
    })
    .await
    .expect("append empty");

    let after = training::training_stats().await.expect("stats");
    println!(
        "after:  {} records, {:.1}% toward {} ({} bytes)",
        after.count, after.percent, after.target, after.size_bytes
    );
    assert_eq!(
        after.count,
        before.count + 1,
        "exactly one record should have been added"
    );

    // Rating rewrites the row in place.
    training::training_rate(id.clone(), 1, None).await.expect("rate");
    let rated = training::training_stats().await.expect("stats");
    assert_eq!(
        rated.rated_good,
        after.rated_good + 1,
        "the thumbs-up should have been recorded"
    );
    assert_eq!(rated.count, after.count, "rating must not add a row");
    println!("rated: {} good, {} bad", rated.rated_good, rated.rated_bad);

    // Rating something that was never captured is a no-op, not an error: the
    // user may rate a reply from before they turned capture on.
    training::training_rate("does-not-exist".into(), 0, None)
        .await
        .expect("rating an unknown id must not fail");

    let dest = std::env::temp_dir().join("jarvis-training-probe.jsonl");
    let exported = training::training_export(dest.to_string_lossy().to_string())
        .await
        .expect("export");
    let lines = std::fs::read_to_string(&exported).unwrap().lines().count();
    println!("exported {lines} lines to {exported}");
    assert_eq!(lines, rated.count, "export should contain every record");
    let _ = std::fs::remove_file(&exported);
}

async fn key_validation() {
    println!("\n== api key validation ==");

    // Empty: must ask for a key, not report a failure.
    let empty = llm::validate_api_key("groq".into(), "".into())
        .await
        .expect("validate");
    println!("empty  -> valid={} {:?}", empty.valid, empty.message);
    assert!(!empty.valid);

    // Wrong: must come back as a rejection with an explanation, never as a
    // thrown error — the wizard types into this on every keystroke.
    let bogus = llm::validate_api_key("groq".into(), "gsk_definitely_not_a_real_key".into())
        .await
        .expect("a bad key must not error, only report invalid");
    println!("bogus  -> valid={} {:?}", bogus.valid, bogus.message);
    assert!(!bogus.valid, "a bogus key must not validate");
    assert!(
        !bogus.message.is_empty() && !bogus.message.contains("401"),
        "the message must explain, not show a status code: {}",
        bogus.message
    );

    // A provider with no key requirement should pass straight through.
    let none = llm::validate_api_key("ollama".into(), "anything".into())
        .await
        .expect("validate");
    assert!(none.valid);
    println!("ollama -> valid={} {:?}", none.valid, none.message);
}
