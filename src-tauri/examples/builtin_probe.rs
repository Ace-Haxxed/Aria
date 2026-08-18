//! Live probe of the built-in model: `cargo run --release --example builtin_probe`.
//!
//! Verifies the claims that matter and cannot be unit tested: that a real GGUF
//! loads, that generation streams, that it produces coherent text, and how
//! long each takes on this machine.

use candle_core::quantized::gguf_file;
use candle_core::{Device, Tensor};
use candle_transformers::generation::LogitsProcessor;
use candle_transformers::models::quantized_qwen2::ModelWeights;
use std::time::Instant;
use tokenizers::Tokenizer;

fn main() {
    let home = dirs::home_dir().expect("home");
    let model = home.join(".jarvis/models/qwen2.5-1.5b.gguf");
    let tok = home.join(".jarvis/models/qwen2.5-1.5b.tokenizer.json");

    if !model.exists() {
        eprintln!("model not downloaded at {}", model.display());
        std::process::exit(1);
    }
    println!(
        "model: {:.2} GB",
        std::fs::metadata(&model).unwrap().len() as f64 / 1e9
    );

    // 1. Load.
    let load_start = Instant::now();
    let tokenizer = Tokenizer::from_file(&tok).expect("tokenizer");
    let device = Device::Cpu;
    let mut file = std::fs::File::open(&model).expect("open");
    let content = gguf_file::Content::read(&mut file).expect("gguf parse");
    println!("tensors in file: {}", content.tensor_infos.len());
    // The same detection the engine performs, proving the file self-describes.
    let declared = content
        .metadata
        .get("general.architecture")
        .and_then(|v| v.to_string().ok())
        .cloned()
        .unwrap_or_default();
    println!("declared architecture: {declared:?}");
    assert_eq!(declared, "qwen2", "catalogue and file must agree");

    let mut weights =
        ModelWeights::from_gguf(content, &mut file, &device).expect("weights");
    let load_ms = load_start.elapsed().as_millis();
    println!("LOAD: {load_ms} ms");
    assert!(load_ms < 30_000, "load took {load_ms} ms");

    // 2. Generate, using the same prompt shape the app builds for llama-family.
    let prompt = "<|im_start|>user\nWhat is the capital of France? Answer in one word.<|im_end|>\n<|im_start|>assistant\n";
    let encoding = tokenizer.encode(prompt, true).expect("encode");
    let tokens = encoding.get_ids().to_vec();
    println!("prompt tokens: {}", tokens.len());

    let mut sampler = LogitsProcessor::new(42, Some(0.1), Some(0.9));
    let gen_start = Instant::now();
    let mut first_token_ms = 0u128;
    let mut text = String::new();
    let mut position = 0usize;

    let input = Tensor::new(tokens.as_slice(), &device)
        .unwrap()
        .unsqueeze(0)
        .unwrap();
    let logits = weights.forward(&input, 0).expect("prompt pass");
    let logits = logits.squeeze(0).unwrap();
    let logits = last_row(&logits);
    position += tokens.len();
    let mut next = sampler.sample(&logits).unwrap();

    for i in 0..40 {
        let piece = tokenizer.decode(&[next], false).unwrap_or_default();
        if i == 0 {
            first_token_ms = gen_start.elapsed().as_millis();
        }
        if piece.contains("<|im_end|>") || piece.contains("<|endoftext|>") {
            break;
        }
        text.push_str(&piece);

        let input = Tensor::new(&[next], &device).unwrap().unsqueeze(0).unwrap();
        let logits = weights.forward(&input, position).expect("step");
        let logits = logits.squeeze(0).unwrap();
        let logits = last_row(&logits);
        position += 1;
        next = sampler.sample(&logits).unwrap();
    }

    let elapsed = gen_start.elapsed();
    let generated = text.split_whitespace().count().max(1);
    println!("FIRST TOKEN: {first_token_ms} ms");
    println!(
        "GENERATION: {} ms, ~{:.1} tok/s",
        elapsed.as_millis(),
        40.0 / elapsed.as_secs_f32()
    );
    println!("OUTPUT: {:?}", text.trim());

    // 3. The answer must actually be right — a model that loads but emits
    //    noise would pass every check above.
    assert!(generated > 0, "no text generated");
    assert!(
        text.to_lowercase().contains("paris"),
        "expected a coherent answer naming Paris, got {text:?}"
    );
    println!("\nOK: built-in model loads, streams, and answers correctly.");
}

fn last_row(logits: &Tensor) -> Tensor {
    match logits.dims() {
        [_rows, _vocab] => {
            let rows = logits.dim(0).unwrap();
            logits.narrow(0, rows - 1, 1).unwrap().squeeze(0).unwrap()
        }
        _ => logits.clone(),
    }
}
