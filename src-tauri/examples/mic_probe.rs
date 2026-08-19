//! Manual hardware probe: `cargo run --example mic_probe`.
//!
//! Unit tests cover the resampler and the WAV writer, but nothing in CI can
//! prove cpal actually opens this machine's microphone. This does, and prints
//! what the setup wizard would show.

#[tokio::main]
async fn main() {
    match nova_lib::commands::audio::test_microphone().await {
        Ok(t) => {
            println!(
                "microphone OK: {} ({} Hz, {} ch)",
                t.device, t.sample_rate, t.channels
            );
        }
        Err(e) => {
            eprintln!("microphone FAILED: {e}");
            std::process::exit(1);
        }
    }
}
