//! Build script: Tauri codegen, plus the tray icon variants.
//!
//! The tray icons are drawn here rather than committed as PNGs so the set
//! cannot drift out of sync — one function defines every state, and adding a
//! state means adding a colour rather than opening an image editor.

use std::path::Path;

fn main() {
    generate_tray_icons();
    watch_frontend();
    tauri_build::build()
}

/// Rebuild when the frontend bundle changes.
///
/// Tauri embeds `dist` into the binary at compile time. Emitting any
/// `rerun-if-changed` from a build script switches cargo from "rebuild when
/// anything in the package changed" to "rebuild only when these change" — so
/// once this script started watching itself for the tray icons, a
/// frontend-only change no longer triggered a rebuild and `cargo build`
/// cheerfully re-linked the *previous* UI. That failure is silent and easy to
/// mistake for the change not working.
fn watch_frontend() {
    let dist = Path::new("../dist");
    println!("cargo:rerun-if-changed=../dist/index.html");

    // Watching the asset directory catches every hashed bundle filename
    // without having to predict them.
    if let Ok(entries) = std::fs::read_dir(dist.join("assets")) {
        for entry in entries.flatten() {
            println!("cargo:rerun-if-changed={}", entry.path().display());
        }
    }
    println!("cargo:rerun-if-changed=tauri.conf.json");
}

/// Side length of the generated icons.
///
/// 32px is what every tray implementation asks for on a standard-density
/// display, and scaling one image beats shipping four sizes of four states.
const SIZE: u32 = 32;

/// The states a tray icon can show, and the colour that identifies each.
///
/// These match the orb: someone who has learned that cyan is idle and red is
/// listening should not have to learn a second vocabulary for the tray.
const STATES: &[(&str, [u8; 3])] = &[
    ("idle", [34, 211, 238]),
    ("listening", [239, 68, 68]),
    ("thinking", [226, 232, 240]),
    ("speaking", [59, 130, 246]),
    ("acting", [34, 197, 94]),
];

fn generate_tray_icons() {
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR is set by cargo");
    let dir = Path::new(&out_dir).join("tray-icons");
    std::fs::create_dir_all(&dir).expect("could not create the tray icon directory");

    for (name, colour) in STATES {
        // Two variants per state: the dot at full size and at reduced size.
        // Alternating between them is what produces the pulse, and doing it
        // with two static images means the animation costs an icon swap
        // rather than a redraw.
        for (suffix, scale) in [("", 1.0f32), ("-dim", 0.62)] {
            let png = draw_icon(*colour, scale);
            let path = dir.join(format!("{name}{suffix}.png"));
            std::fs::write(&path, png).expect("could not write a tray icon");
        }
    }

    println!("cargo:rerun-if-changed=build.rs");
}

/// Draw one icon: a filled circle with a soft edge, on transparent.
///
/// `scale` shrinks the dot without moving it, so a pair of frames pulses from
/// the centre rather than drifting.
fn draw_icon(colour: [u8; 3], scale: f32) -> Vec<u8> {
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];

    let centre = SIZE as f32 / 2.0;
    let radius = centre * 0.78 * scale;
    // A ring sits outside the dot at full size only; it reads as a halo and
    // makes the two pulse frames clearly different at 32px.
    let ring_radius = centre * 0.94;
    let ring_width = 1.6f32;

    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 + 0.5 - centre;
            let dy = y as f32 + 0.5 - centre;
            let distance = (dx * dx + dy * dy).sqrt();

            // Anti-aliased coverage: 1 inside, 0 outside, blended across one
            // pixel. Without this a 32px circle looks visibly jagged.
            let dot = (1.0 - (distance - radius + 0.5)).clamp(0.0, 1.0);
            let ring = if scale >= 1.0 {
                let edge = (distance - ring_radius).abs();
                (1.0 - (edge - ring_width / 2.0 + 0.5)).clamp(0.0, 1.0) * 0.45
            } else {
                0.0
            };

            let alpha = (dot + ring * (1.0 - dot)).clamp(0.0, 1.0);
            let index = ((y * SIZE + x) * 4) as usize;
            rgba[index] = colour[0];
            rgba[index + 1] = colour[1];
            rgba[index + 2] = colour[2];
            rgba[index + 3] = (alpha * 255.0) as u8;
        }
    }

    encode_png(SIZE, SIZE, &rgba)
}

/* ── Minimal PNG writer ─────────────────────────────────────────── */
//
// Written by hand rather than pulled in as a build dependency. The `image`
// crate is already a runtime dependency, but adding it to `[build-dependencies]`
// makes it compile twice — once for the host and once for the target — which
// is a noticeable cost on every clean build for four small images.

fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);

    // IHDR: 8-bit RGBA, no interlace.
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    write_chunk(&mut out, b"IHDR", &ihdr);

    // Each row is prefixed with its filter type; 0 means none, which keeps the
    // encoder trivial at the cost of a slightly larger file.
    let mut raw = Vec::with_capacity((height * (1 + width * 4)) as usize);
    for y in 0..height {
        raw.push(0);
        let start = (y * width * 4) as usize;
        raw.extend_from_slice(&rgba[start..start + (width * 4) as usize]);
    }

    write_chunk(&mut out, b"IDAT", &zlib_stored(&raw));
    write_chunk(&mut out, b"IEND", &[]);
    out
}

fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);

    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

/// A zlib stream using stored (uncompressed) deflate blocks.
///
/// These icons are a few kilobytes of mostly-transparent pixels; the space
/// saved by real compression would not pay for the code to do it.
fn zlib_stored(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01]; // deflate, default window

    // Stored blocks carry a 16-bit length, so anything longer is split.
    const MAX_BLOCK: usize = 65_535;
    let mut offset = 0;
    while offset < data.len() {
        let take = (data.len() - offset).min(MAX_BLOCK);
        let last = offset + take >= data.len();

        out.push(if last { 1 } else { 0 });
        out.extend_from_slice(&(take as u16).to_le_bytes());
        out.extend_from_slice(&(!(take as u16)).to_le_bytes());
        out.extend_from_slice(&data[offset..offset + take]);
        offset += take;
    }

    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *slot = c;
    }

    let mut crc = 0xffff_ffffu32;
    for byte in data {
        crc = table[((crc ^ *byte as u32) & 0xff) as usize] ^ (crc >> 8);
    }
    crc ^ 0xffff_ffff
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for byte in data {
        a = (a + *byte as u32) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}
