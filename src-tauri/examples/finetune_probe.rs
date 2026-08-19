//! Live probe of the fine-tuning sidecar: `cargo run --example finetune_probe`.
//!
//! Confirms the Rust side finds the script, runs it, and parses what it says.
//! It does not train — that needs multi-gigabyte libraries — but it exercises
//! every step up to the point training would begin.

#[tokio::main]
async fn main() {
    let readiness = nova_lib::commands::finetune::check_finetune_support()
        .await
        .expect("check should not error");

    println!("python available : {}", readiness.python_available);
    println!("python version   : {}", readiness.python_version);
    println!("gpu              : {} ({})", readiness.gpu, readiness.device);
    println!("backend          : {:?}", readiness.backend);
    println!("ready to train   : {}", readiness.ready);
    println!("usable pairs     : {}", readiness.pairs);
    println!("estimate         : {} min", readiness.estimated_minutes);
    if let Some(problem) = &readiness.problem {
        println!("problem          : {problem}");
    }

    assert!(
        readiness.python_available,
        "the sidecar could not be reached: {:?}",
        readiness.problem
    );
    assert!(
        !readiness.python_version.is_empty(),
        "no version reported — stdout was not parsed"
    );

    let adapters = nova_lib::commands::finetune::list_adapters()
        .await
        .expect("listing adapters should not error");
    println!("\nadapters trained : {}", adapters.len());

    println!("\nOK: the sidecar is reachable and its output parses.");
}
