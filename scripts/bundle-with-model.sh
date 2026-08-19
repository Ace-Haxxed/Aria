#!/usr/bin/env bash
#
# Package NOVA together with an AI model, for machines that have no internet.
#
# The normal installer is small and downloads the model on first launch. That
# is the wrong shape for an air-gapped machine, a workshop with no wifi, or
# handing a colleague a USB stick — so this produces one archive with
# everything in it.
#
# Usage:
#   scripts/bundle-with-model.sh                  # default model
#   scripts/bundle-with-model.sh qwen2.5-1.5b     # a smaller one
#   scripts/bundle-with-model.sh --list           # what is available
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Mirrors util::data_dir() in the Rust backend: a machine that already has
# ~/.jarvis keeps using it, because that is where the downloaded weights are.
if [ -d "$HOME/.nova" ] || [ ! -d "$HOME/.jarvis" ]; then
  NOVA_HOME="$HOME/.nova"
else
  NOVA_HOME="$HOME/.jarvis"
fi
MODELS_DIR="$NOVA_HOME/models"
BUILD_DIR="$ROOT/target/bundle"

# Kept in step with src-tauri/src/commands/models.rs. Each line is:
#   id|repo|filename|tokenizer repo|approx MB
MODELS=(
  "phi-3.5-mini|microsoft/Phi-3.5-mini-instruct-gguf|Phi-3.5-mini-instruct-Q4_K_M.gguf|microsoft/Phi-3.5-mini-instruct|2200"
  "llama-3.2-3b|bartowski/Llama-3.2-3B-Instruct-GGUF|Llama-3.2-3B-Instruct-Q4_K_M.gguf|meta-llama/Llama-3.2-3B-Instruct|2000"
  "qwen2.5-1.5b|Qwen/Qwen2.5-1.5B-Instruct-GGUF|qwen2.5-1.5b-instruct-q4_k_m.gguf|Qwen/Qwen2.5-1.5B-Instruct|1000"
  "mistral-7b|TheBloke/Mistral-7B-Instruct-v0.2-GGUF|mistral-7b-instruct-v0.2.Q4_K_M.gguf|mistralai/Mistral-7B-Instruct-v0.2|4100"
)

DEFAULT_MODEL="phi-3.5-mini"

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m warning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m error:\033[0m %s\n' "$*" >&2; exit 1; }

list_models() {
  printf '%-16s %8s  %s\n' "ID" "SIZE" "STATUS"
  for entry in "${MODELS[@]}"; do
    IFS='|' read -r id _repo _file _tok size <<<"$entry"
    local status="not downloaded"
    [ -f "$MODELS_DIR/$id.gguf" ] && status="ready"
    printf '%-16s %7sM  %s\n' "$id" "$size" "$status"
  done
}

find_model() {
  for entry in "${MODELS[@]}"; do
    IFS='|' read -r id _ _ _ _ <<<"$entry"
    [ "$id" = "$1" ] && { echo "$entry"; return 0; }
  done
  return 1
}

# ── Arguments ────────────────────────────────────────────────────────

if [ "${1:-}" = "--list" ]; then
  list_models
  exit 0
fi

MODEL_ID="${1:-$DEFAULT_MODEL}"
ENTRY="$(find_model "$MODEL_ID")" || die "Unknown model '$MODEL_ID'. Try --list."
IFS='|' read -r MODEL_ID REPO FILENAME TOKENIZER_REPO SIZE_MB <<<"$ENTRY"

case "$(uname -s)" in
  Linux)  PLATFORM=linux ;;
  Darwin) PLATFORM=macos ;;
  *) die "This script supports Linux and macOS. On Windows use WSL." ;;
esac

command -v cargo >/dev/null || die "cargo is not installed. See https://rustup.rs"
command -v curl  >/dev/null || die "curl is not installed."
command -v npm   >/dev/null || die "npm is not installed."

# ── Build ────────────────────────────────────────────────────────────

say "Building the frontend"
cd "$ROOT"
npm run build >/dev/null

say "Building the release binary (this takes a while)"
cd "$ROOT/src-tauri"
cargo build --release
BINARY="$ROOT/src-tauri/target/release/nova"
[ -f "$BINARY" ] || die "The build did not produce $BINARY"

# ── Model ────────────────────────────────────────────────────────────

mkdir -p "$MODELS_DIR"
MODEL_PATH="$MODELS_DIR/$MODEL_ID.gguf"
TOKENIZER_PATH="$MODELS_DIR/$MODEL_ID.tokenizer.json"

download() {
  local url="$1" dest="$2" label="$3"
  say "Downloading $label"
  # --continue-at resumes a previous attempt; a multi-gigabyte transfer that
  # has to restart from zero on every hiccup is a transfer that never finishes.
  curl -fL --progress-bar --continue-at - -o "$dest.part" "$url" \
    || die "Download failed. Re-run to resume where it stopped."
  mv "$dest.part" "$dest"
}

if [ -f "$MODEL_PATH" ]; then
  say "Model already present ($(du -h "$MODEL_PATH" | cut -f1))"
else
  download \
    "https://huggingface.co/$REPO/resolve/main/$FILENAME?download=true" \
    "$MODEL_PATH" "$MODEL_ID (~${SIZE_MB}MB)"
fi

if [ ! -f "$TOKENIZER_PATH" ]; then
  download \
    "https://huggingface.co/$TOKENIZER_REPO/resolve/main/tokenizer.json" \
    "$TOKENIZER_PATH" "tokenizer"
fi

# Verify against the digest HuggingFace publishes, so a corrupt file is caught
# here rather than on the recipient's machine.
say "Verifying the model"
EXPECTED="$(curl -fsSL "https://huggingface.co/api/models/$REPO/tree/main" 2>/dev/null \
  | tr ',' '\n' | grep -A2 "\"$FILENAME\"" | grep -o '"oid":"[a-f0-9]\{64\}"' \
  | head -1 | cut -d'"' -f4 || true)"

if [ -n "$EXPECTED" ]; then
  if command -v sha256sum >/dev/null; then
    ACTUAL="$(sha256sum "$MODEL_PATH" | cut -d' ' -f1)"
  else
    ACTUAL="$(shasum -a 256 "$MODEL_PATH" | cut -d' ' -f1)"
  fi
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    die "The model failed its checksum. Delete $MODEL_PATH and re-run."
  fi
  say "Checksum verified"
else
  warn "Could not fetch the published checksum; skipping verification."
fi

# ── Assemble ─────────────────────────────────────────────────────────

STAGE="$BUILD_DIR/nova-bundle"
rm -rf "$STAGE"
mkdir -p "$STAGE/models" "$STAGE/scripts"

say "Assembling the bundle"
cp "$BINARY" "$STAGE/nova"
chmod +x "$STAGE/nova"
cp "$MODEL_PATH" "$STAGE/models/$MODEL_ID.gguf"
cp "$TOKENIZER_PATH" "$STAGE/models/$MODEL_ID.tokenizer.json"

# The fine-tuning sidecar is small and useless to re-download offline.
[ -f "$ROOT/scripts/finetune.py" ] && cp "$ROOT/scripts/finetune.py" "$STAGE/scripts/"

cat > "$STAGE/install-bundle.sh" <<'INSTALLER'
#!/usr/bin/env bash
#
# Install NOVA and its model from this bundle. No internet needed.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m error:\033[0m %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux)  BIN_DIR="$HOME/.local/bin" ;;
  Darwin) BIN_DIR="$HOME/.local/bin" ;;
  *) die "This installer supports Linux and macOS." ;;
esac

# Mirrors util::data_dir() in the Rust backend: a machine that already has
# ~/.jarvis keeps using it, because that is where the downloaded weights are.
if [ -d "$HOME/.nova" ] || [ ! -d "$HOME/.jarvis" ]; then
  NOVA_HOME="$HOME/.nova"
else
  NOVA_HOME="$HOME/.jarvis"
fi
MODELS_DIR="$NOVA_HOME/models"
mkdir -p "$BIN_DIR" "$MODELS_DIR"

say "Installing the model to $MODELS_DIR"
for file in "$HERE"/models/*; do
  name="$(basename "$file")"
  if [ -f "$MODELS_DIR/$name" ]; then
    say "  $name is already installed, skipping"
  else
    cp "$file" "$MODELS_DIR/$name"
    say "  $name"
  fi
done

if [ -d "$HERE/scripts" ] && [ -n "$(ls -A "$HERE/scripts" 2>/dev/null)" ]; then
  mkdir -p "$NOVA_HOME/scripts"
  cp "$HERE"/scripts/* "$NOVA_HOME/scripts/"
fi

say "Installing NOVA to $BIN_DIR"
cp "$HERE/nova" "$BIN_DIR/nova"
chmod +x "$BIN_DIR/nova"

# A desktop entry, so it appears in the applications menu rather than only
# being runnable from a terminal.
if [ "$(uname -s)" = "Linux" ]; then
  APPS="$HOME/.local/share/applications"
  mkdir -p "$APPS"
  cat > "$APPS/nova.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=NOVA
Comment=AI assistant that runs on this machine
Exec=$BIN_DIR/nova
Terminal=false
Categories=Utility;
DESKTOP
  update-desktop-database "$APPS" 2>/dev/null || true
fi

echo
say "Done."
case ":$PATH:" in
  *":$BIN_DIR:"*) say "Run it with: nova" ;;
  *) say "Run it with: $BIN_DIR/nova"
     say "(add $BIN_DIR to your PATH to run it by name)" ;;
esac
say "It works offline — the model is already installed."
INSTALLER
chmod +x "$STAGE/install-bundle.sh"

cat > "$STAGE/README.txt" <<READMETXT
NOVA — offline bundle
=======================

This archive contains NOVA and an AI model, so it works with no internet.

  Model:    $MODEL_ID
  Platform: $PLATFORM ($(uname -m))

To install:

  ./install-bundle.sh

That copies the model into NOVA's data directory and the binary to ~/.local/bin.
Nothing is downloaded and nothing needs an account.

Requirements on the target machine:
  - Linux: webkit2gtk 4.1, gtk3
  - macOS: 12 or newer

NOVA works entirely offline with this model. Adding a cloud API key later is
optional, in Settings, and never required.
READMETXT

# ── Archive ──────────────────────────────────────────────────────────

STAMP="$(date +%Y%m%d)"
ARCHIVE="$BUILD_DIR/nova-bundle-$MODEL_ID-$PLATFORM-$(uname -m)-$STAMP.tar.gz"

say "Compressing (this takes a few minutes)"
# The model is already compressed, so -1 saves considerable time for a
# negligible difference in size.
tar -C "$BUILD_DIR" -czf "$ARCHIVE" --options='compression-level=1' nova-bundle 2>/dev/null \
  || GZIP=-1 tar -C "$BUILD_DIR" -czf "$ARCHIVE" nova-bundle

rm -rf "$STAGE"

echo
say "Bundle ready:"
echo "     $ARCHIVE"
echo "     $(du -h "$ARCHIVE" | cut -f1)"
echo
say "To share it:"
echo "     tar -xzf $(basename "$ARCHIVE")"
echo "     cd nova-bundle && ./install-bundle.sh"
