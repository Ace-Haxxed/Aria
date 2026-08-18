//! Live network probe: `cargo run --example llm_probe`.
//!
//! Exercises the real Rust transport against a real Ollama, which is the part
//! no unit test can cover: that the body Jarvis builds is one Ollama accepts,
//! and that the response actually streams rather than arriving in one lump.

use futures_util::StreamExt;
use serde_json::json;

#[tokio::main]
async fn main() {
    // 1. The launch probe.
    let status = aria_lib::commands::ollama::check_ollama(None)
        .await
        .expect("check_ollama should not error");
    println!(
        "check_ollama -> running={} installed={} models={:?}",
        status.running, status.installed, status.models
    );

    if !status.running {
        eprintln!("Ollama is not running; start it to exercise the streaming path.");
        std::process::exit(1);
    }

    let model = status
        .models
        .first()
        .cloned()
        .expect("a running Ollama with no models cannot answer");

    // 2. The exact body `ollama_chat` would send.
    let body = aria_lib::commands::llm::ollama_body(
        &model,
        json!([{ "role": "user", "content": "Reply with exactly: OK" }]),
        None,
        Some(0.0),
        Some(16),
    );
    println!("\nrequest body: {}", serde_json::to_string(&body).unwrap());

    let response = reqwest::Client::new()
        .post("http://localhost:11434/api/chat")
        .json(&body)
        .send()
        .await
        .expect("request should reach Ollama");

    println!("status: {}", response.status());
    assert!(response.status().is_success(), "Ollama rejected the body");

    // 3. Confirm it streams: count the chunks and reassemble the answer.
    let mut stream = response.bytes_stream();
    let mut chunks = 0;
    let mut answer = String::new();

    while let Some(next) = stream.next().await {
        let bytes = next.expect("stream should not error");
        chunks += 1;
        for line in String::from_utf8_lossy(&bytes).lines() {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(text) = v.pointer("/message/content").and_then(|c| c.as_str()) {
                    answer.push_str(text);
                }
            }
        }
    }

    println!("streamed in {chunks} chunks");
    println!("answer: {:?}", answer.trim());
    assert!(chunks > 1, "response did not stream — got it in one chunk");
    assert!(!answer.trim().is_empty(), "no content came back");
    println!("\nOK: Rust transport streams from Ollama end to end.");
}
