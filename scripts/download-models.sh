#!/usr/bin/env bash
#
# Fetch the offline voice engines: whisper.cpp for speech-to-text and piper for
# text-to-speech, plus their models.
#
# These are not bundled in the installer — they add ~140 MB, and anyone using a
# cloud backend never needs them. NOVA resolves whatever this script installs
# at runtime and falls back to the OS engines when it is absent.
#
# Usage: bash scripts/download-models.sh [--stt-only] [--tts-only] [--model base]

set -euo pipefail

BOLD=$'\033[1m'; DIM=$'\033[2m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'

say()  { printf '%s==>%s %s\n' "$CYAN$BOLD" "$RESET" "$1"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '%serror:%s %s\n' "$RED$BOLD" "$RESET" "$1" >&2; exit 1; }

WANT_STT=1
WANT_TTS=1
WHISPER_MODEL="tiny.en"

while [ $# -gt 0 ]; do
  case "$1" in
    --stt-only) WANT_TTS=0 ;;
    --tts-only) WANT_STT=0 ;;
    --model) shift; WHISPER_MODEL="${1:-tiny.en}" ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

# Must match `models_dir()` in src-tauri/src/commands/voice.rs.
case "$(uname -s)" in
  Darwin) DATA_DIR="$HOME/Library/Application Support" ;;
  MINGW*|MSYS*|CYGWIN*) DATA_DIR="${APPDATA:-$HOME/AppData/Roaming}" ;;
  *) DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}" ;;
esac

NOVA_DIR="$DATA_DIR/nova"
MODELS_DIR="$NOVA_DIR/models"
BIN_DIR="$NOVA_DIR/bin"

mkdir -p "$MODELS_DIR" "$BIN_DIR"
say "Installing into ${BOLD}${NOVA_DIR}${RESET}"

command -v curl >/dev/null 2>&1 || die "curl is required"

# Resume partial downloads; these files are large enough that a dropped
# connection halfway through is a real possibility.
fetch() {
  local url="$1" dest="$2" label="$3"

  if [ -s "$dest" ]; then
    ok "$label already present"
    return 0
  fi

  say "Downloading $label"
  if curl -fL --progress-bar -C - -o "$dest.partial" "$url"; then
    mv "$dest.partial" "$dest"
    ok "$label downloaded ($(du -h "$dest" | cut -f1))"
  else
    rm -f "$dest.partial"
    warn "could not download $label from $url"
    return 1
  fi
}

detect_platform() {
  local os arch
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=macos ;;
    MINGW*|MSYS*|CYGWIN*) os=windows ;;
    *) os=unknown ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) arch=unknown ;;
  esac
  echo "$os $arch"
}

read -r OS ARCH <<< "$(detect_platform)"
say "Platform: ${BOLD}${OS}/${ARCH}${RESET}"

# ── Speech to text: whisper.cpp ────────────────────────────────────

if [ "$WANT_STT" -eq 1 ]; then
  MODEL_FILE="$MODELS_DIR/ggml-${WHISPER_MODEL}.bin"
  MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin"

  fetch "$MODEL_URL" "$MODEL_FILE" "whisper model (${WHISPER_MODEL})" || true

  if [ -x "$BIN_DIR/whisper-cli" ] || command -v whisper-cli >/dev/null 2>&1; then
    ok "whisper-cli already available"
  else
    say "Building whisper.cpp"
    # No official prebuilt CLI is published for every platform, so build it.
    # It is a small C++ project and compiles in well under a minute.
    if command -v cmake >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
      BUILD_DIR="$(mktemp -d)"
      trap 'rm -rf "$BUILD_DIR"' EXIT

      if git clone --depth 1 https://github.com/ggerganov/whisper.cpp "$BUILD_DIR/whisper.cpp" >/dev/null 2>&1; then
        (
          cd "$BUILD_DIR/whisper.cpp"
          cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF >/dev/null
          cmake --build build --config Release -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)" >/dev/null
        ) && {
          # The binary moved between releases; accept either name.
          for candidate in build/bin/whisper-cli build/bin/main build/whisper-cli build/main; do
            if [ -f "$BUILD_DIR/whisper.cpp/$candidate" ]; then
              cp "$BUILD_DIR/whisper.cpp/$candidate" "$BIN_DIR/whisper-cli"
              chmod +x "$BIN_DIR/whisper-cli"
              ok "whisper-cli built"
              break
            fi
          done
        } || warn "whisper.cpp build failed — NOVA will use the browser recogniser instead"
      else
        warn "could not clone whisper.cpp"
      fi
      trap - EXIT
      rm -rf "$BUILD_DIR"
    else
      warn "cmake and git are needed to build whisper.cpp"
      warn "install them, or leave STT set to the browser engine in Settings → Voice"
    fi
  fi
fi

# ── Text to speech: piper ──────────────────────────────────────────

if [ "$WANT_TTS" -eq 1 ]; then
  VOICE_FILE="$MODELS_DIR/en_US-ryan-high.onnx"
  VOICE_CONFIG="$MODELS_DIR/en_US-ryan-high.onnx.json"
  VOICE_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high"

  fetch "$VOICE_BASE/en_US-ryan-high.onnx" "$VOICE_FILE" "piper voice (en_US-ryan-high)" || true
  # piper refuses to start without the config sitting next to the model.
  fetch "$VOICE_BASE/en_US-ryan-high.onnx.json" "$VOICE_CONFIG" "piper voice config" || true

  if [ -x "$BIN_DIR/piper" ] || command -v piper >/dev/null 2>&1; then
    ok "piper already available"
  else
    PIPER_VERSION="2023.11.14-2"
    case "$OS/$ARCH" in
      linux/x64)    PIPER_ASSET="piper_linux_x86_64.tar.gz" ;;
      linux/arm64)  PIPER_ASSET="piper_linux_aarch64.tar.gz" ;;
      macos/x64)    PIPER_ASSET="piper_macos_x64.tar.gz" ;;
      macos/arm64)  PIPER_ASSET="piper_macos_aarch64.tar.gz" ;;
      windows/x64)  PIPER_ASSET="piper_windows_amd64.zip" ;;
      *)            PIPER_ASSET="" ;;
    esac

    if [ -z "$PIPER_ASSET" ]; then
      warn "no piper build for $OS/$ARCH — NOVA will use your system voice"
    else
      ARCHIVE="$BIN_DIR/$PIPER_ASSET"
      PIPER_URL="https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/${PIPER_ASSET}"

      if fetch "$PIPER_URL" "$ARCHIVE" "piper binary"; then
        say "Extracting piper"
        case "$PIPER_ASSET" in
          *.tar.gz) tar -xzf "$ARCHIVE" -C "$BIN_DIR" ;;
          *.zip) unzip -oq "$ARCHIVE" -d "$BIN_DIR" ;;
        esac
        rm -f "$ARCHIVE"

        # The archive unpacks into a `piper/` directory; hoist the binary and
        # its shared libraries up one level so the sidecar lookup finds them.
        if [ -d "$BIN_DIR/piper" ] && [ -f "$BIN_DIR/piper/piper" ]; then
          cp -r "$BIN_DIR/piper/"* "$BIN_DIR/" 2>/dev/null || true
          rm -rf "$BIN_DIR/piper"
        fi

        [ -f "$BIN_DIR/piper" ] && chmod +x "$BIN_DIR/piper" && ok "piper installed" \
          || warn "piper extracted but the binary was not where expected"
      fi
    fi
  fi
fi

# ── Summary ────────────────────────────────────────────────────────

printf '\n%s%sDone.%s\n' "$GREEN" "$BOLD" "$RESET"
printf '  %sModels:%s %s\n' "$DIM" "$RESET" "$MODELS_DIR"
printf '  %sBinaries:%s %s\n' "$DIM" "$RESET" "$BIN_DIR"

printf '\n%sInstalled:%s\n' "$BOLD" "$RESET"
for f in "$MODELS_DIR"/* "$BIN_DIR"/*; do
  [ -e "$f" ] || continue
  printf '  %-42s %s\n' "$(basename "$f")" "$(du -h "$f" 2>/dev/null | cut -f1)"
done

printf '\n%sRestart NOVA, then check Settings → Voice.%s\n' "$DIM" "$RESET"
