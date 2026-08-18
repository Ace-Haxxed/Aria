//! Manual hardware probe: `cargo run --example screen_probe`.
//!
//! Exercises the real capture dispatch for this machine's session — the same
//! code path the setup wizard's "Screen capture" test runs.

#[tokio::main]
async fn main() {
    let info = aria_lib::platform::info();
    println!(
        "session: {:?} / compositor: {:?} / backend: {:?}",
        info.session_type,
        info.compositor,
        aria_lib::platform::backend()
    );

    match aria_lib::platform::screenshot(None).await {
        Ok(bytes) => {
            let png = bytes.starts_with(&[0x89, b'P', b'N', b'G']);
            println!("full screen OK: {} bytes, png header: {png}", bytes.len());
            assert!(png, "capture did not return a PNG");
        }
        Err(e) => {
            eprintln!("full screen FAILED: {e}");
            std::process::exit(1);
        }
    }

    let region = aria_lib::platform::Region {
        x: 0,
        y: 0,
        w: 200,
        h: 100,
    };
    match aria_lib::platform::screenshot(Some(region)).await {
        Ok(bytes) => {
            let img = image::load_from_memory(&bytes).expect("region capture is not an image");
            println!(
                "region OK: {} bytes, {}x{}",
                bytes.len(),
                image::GenericImageView::width(&img),
                image::GenericImageView::height(&img)
            );
        }
        Err(e) => {
            eprintln!("region FAILED: {e}");
            std::process::exit(1);
        }
    }
}
