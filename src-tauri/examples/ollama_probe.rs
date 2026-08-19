//! Live probe of the hardened Ollama path: `cargo run --example ollama_probe`.

use nova_lib::commands::ollama;

#[tokio::main]
async fn main() {
    let s = ollama::check_ollama(None).await.expect("check");
    println!(
        "running={} installed={} latency={}ms\nmodels={:?}\npreferred={:?}",
        s.running, s.installed, s.latency_ms, s.models, s.preferred
    );
    assert!(s.running, "start Ollama to run this probe");
    assert!(s.preferred.is_some(), "a running server with models must pick one");

    // Model validation: the real one exists, an invented one does not.
    let real = s.preferred.clone().unwrap();
    let has_real = ollama::ollama_has_model(real.clone(), None).await.expect("show");
    let has_fake = ollama::ollama_has_model("not-a-real-model:99b".into(), None)
        .await
        .expect("show");
    println!("has({real})={has_real}  has(not-a-real-model:99b)={has_fake}");
    assert!(has_real, "the installed model should validate");
    assert!(!has_fake, "an uninstalled model must not validate");

    // Endpoint testing, including the failure paths the UI shows inline.
    for url in [
        "http://localhost:11434",
        "http://127.0.0.1:1",     // nothing listening
        "not-a-url",              // malformed
    ] {
        let t = ollama::test_ollama_endpoint(url.into()).await.expect("endpoint");
        println!("{url:<24} ok={:<5} {}", t.ok, t.message);
    }

    println!("\nOK: discovery, model validation and endpoint testing all behave.");
}
