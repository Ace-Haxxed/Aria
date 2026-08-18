//! What acceleration this machine can offer.
//!
//! Used for two decisions: how many layers to hand Ollama, and how many
//! threads to give the built-in model. Getting either wrong is the difference
//! between an answer that arrives while the user is still reading their own
//! question and one they wait out.

use crate::util::{has, run, JResult};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub available: bool,
    /// "nvidia", "amd", "intel", "apple" or "none".
    pub kind: String,
    pub name: String,
    pub vram_mb: u32,
    /// Physical cores — what to set Ollama's thread count to.
    pub cpu_threads: u32,
    /// Layers to offload. 0 means CPU-only; 99 means "all of them", which is
    /// how Ollama spells it.
    pub recommended_gpu_layers: u32,
}

/// Probe for a usable GPU.
///
/// Vendor tools are asked first because they report VRAM, which decides
/// whether offloading is worth it at all — a 2 GB card cannot hold a 4 GB
/// model and forcing it makes generation slower than staying on the CPU.
#[tauri::command]
pub async fn check_gpu() -> JResult<GpuInfo> {
    let cpu_threads = physical_cores();

    if let Some(info) = nvidia(cpu_threads).await {
        return Ok(info);
    }
    if let Some(info) = apple(cpu_threads) {
        return Ok(info);
    }
    if let Some(info) = other_vendor(cpu_threads).await {
        return Ok(info);
    }

    Ok(GpuInfo {
        available: false,
        kind: "none".into(),
        name: "CPU only".into(),
        vram_mb: 0,
        cpu_threads,
        recommended_gpu_layers: 0,
    })
}

fn physical_cores() -> u32 {
    let info = sysinfo::System::new_all();
    info.physical_core_count()
        .map(|n| n.max(1) as u32)
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| (n.get() / 2).max(1) as u32)
                .unwrap_or(4)
        })
}

async fn nvidia(cpu_threads: u32) -> Option<GpuInfo> {
    if !has("nvidia-smi") {
        return None;
    }
    let out = run(
        "nvidia-smi",
        &[
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ],
    )
    .await
    .ok()?;
    if !out.ok() {
        return None;
    }

    let line = out.trimmed().lines().next()?.to_string();
    let (name, vram) = line.split_once(',')?;
    let vram_mb: u32 = vram.trim().parse().ok()?;

    Some(GpuInfo {
        available: true,
        kind: "nvidia".into(),
        name: name.trim().to_string(),
        vram_mb,
        cpu_threads,
        recommended_gpu_layers: layers_for_vram(vram_mb),
    })
}

fn apple(cpu_threads: u32) -> Option<GpuInfo> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    // Apple Silicon shares memory with the CPU, so there is no separate VRAM
    // figure and offloading everything is always the right call.
    Some(GpuInfo {
        available: true,
        kind: "apple".into(),
        name: "Apple Silicon".into(),
        vram_mb: 0,
        cpu_threads,
        recommended_gpu_layers: 99,
    })
}

/// AMD and Intel, via their own tools or the PCI listing.
async fn other_vendor(cpu_threads: u32) -> Option<GpuInfo> {
    if has("rocm-smi") {
        if let Ok(out) = run("rocm-smi", &["--showproductname"]).await {
            if out.ok() {
                return Some(GpuInfo {
                    available: true,
                    kind: "amd".into(),
                    name: "AMD GPU".into(),
                    vram_mb: 0,
                    cpu_threads,
                    recommended_gpu_layers: 99,
                });
            }
        }
    }

    if !has("lspci") {
        return None;
    }
    let out = run("lspci", &[]).await.ok()?;
    let line = out
        .stdout
        .lines()
        .find(|l| l.contains("VGA") || l.contains("3D controller"))?;
    let lower = line.to_lowercase();

    // Integrated graphics are reported for completeness, but not recommended
    // for offload: they share system memory and are usually slower than the
    // CPU cores they are stealing bandwidth from.
    let (kind, name) = if lower.contains("nvidia") {
        ("nvidia", "NVIDIA GPU")
    } else if lower.contains("amd") || lower.contains("radeon") {
        ("amd", "AMD GPU")
    } else if lower.contains("intel") {
        ("intel", "Intel integrated graphics")
    } else {
        return None;
    };

    let integrated = kind == "intel";
    Some(GpuInfo {
        available: !integrated,
        kind: kind.into(),
        name: name.into(),
        vram_mb: 0,
        cpu_threads,
        recommended_gpu_layers: if integrated { 0 } else { 99 },
    })
}

/// How many layers a card of this size can usefully take.
///
/// Offloading more than fits causes the runtime to page weights across the PCI
/// bus every token, which is dramatically slower than not offloading at all.
fn layers_for_vram(vram_mb: u32) -> u32 {
    match vram_mb {
        0..=2_047 => 0,
        2_048..=3_999 => 16,
        4_000..=5_999 => 24,
        6_000..=7_999 => 32,
        _ => 99,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_cards_are_not_asked_to_hold_a_whole_model() {
        // Forcing offload onto a card that cannot hold the weights is slower
        // than staying on the CPU, so this must be 0 rather than optimistic.
        assert_eq!(layers_for_vram(1_024), 0);
        assert_eq!(layers_for_vram(2_048), 16);
    }

    #[test]
    fn layer_count_rises_with_vram() {
        let steps = [1_024, 3_000, 5_000, 7_000, 12_000].map(layers_for_vram);
        for pair in steps.windows(2) {
            assert!(pair[1] >= pair[0], "layer counts must not go backwards");
        }
        assert_eq!(layers_for_vram(24_000), 99);
    }

    #[test]
    fn core_count_is_plausible() {
        let cores = physical_cores();
        assert!((1..=256).contains(&cores), "got {cores}");
    }
}
