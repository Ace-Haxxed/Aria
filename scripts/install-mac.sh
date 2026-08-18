#!/usr/bin/env bash
#
# Install everything Jarvis needs on macOS 12 (Monterey) or later.
#
# Usage: bash scripts/install-mac.sh [--no-optional] [--build]

set -euo pipefail

BOLD=$'\033[1m'; DIM=$'\033[2m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'

say()  { printf '%s==>%s %s\n' "$CYAN$BOLD" "$RESET" "$1"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '%serror:%s %s\n' "$RED$BOLD" "$RESET" "$1" >&2; exit 1; }

INSTALL_OPTIONAL=1
DO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --no-optional) INSTALL_OPTIONAL=0 ;;
    --build) DO_BUILD=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || die "this script is for macOS"

MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
[ "$MACOS_MAJOR" -ge 12 ] || die "macOS 12 (Monterey) or later is required; found $(sw_vers -productVersion)"

ARCH="$(uname -m)"
say "Detected macOS $(sw_vers -productVersion) on ${BOLD}${ARCH}${RESET}"

# Xcode Command Line Tools provide clang, which Rust needs to link.
if ! xcode-select -p >/dev/null 2>&1; then
  say "Installing the Xcode Command Line Tools"
  xcode-select --install || true
  warn "finish the installer window, then re-run this script"
  exit 0
fi
ok "Xcode Command Line Tools present"

if ! command -v brew >/dev/null 2>&1; then
  say "Installing Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  # Apple Silicon puts brew in /opt/homebrew, which is not on PATH by default.
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  ok "homebrew installed"
fi

CORE=(node)
OPTIONAL=(ffmpeg chromium git)

PACKAGES=("${CORE[@]}")
[ "$INSTALL_OPTIONAL" -eq 1 ] && PACKAGES+=("${OPTIONAL[@]}")

say "Installing ${#PACKAGES[@]} packages"
for pkg in "${PACKAGES[@]}"; do
  if brew list "$pkg" >/dev/null 2>&1; then
    ok "$pkg already installed"
  else
    brew install "$pkg" >/dev/null 2>&1 && ok "$pkg installed" || warn "could not install $pkg"
  fi
done

if ! command -v rustc >/dev/null 2>&1; then
  say "Installing Rust"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck source=/dev/null
  . "$HOME/.cargo/env"
  ok "rust installed"
fi

# Universal binaries need both architectures available to the toolchain.
say "Adding both macOS Rust targets (for universal builds)"
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null 2>&1 || true
ok "targets ready"

if [ "$INSTALL_OPTIONAL" -eq 1 ] && ! command -v ollama >/dev/null 2>&1; then
  say "Installing Ollama (local LLM backend)"
  brew install --cask ollama >/dev/null 2>&1 && ok "ollama installed" \
    || warn "install Ollama from https://ollama.com if you want an offline backend"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$REPO_ROOT/package.json" ]; then
  say "Installing project dependencies"
  (cd "$REPO_ROOT" && npm install)
  ok "npm dependencies installed"

  if [ "$DO_BUILD" -eq 1 ]; then
    say "Building a universal Jarvis"
    (cd "$REPO_ROOT" && npm run tauri -- build --target universal-apple-darwin)
    ok "the .dmg is in src-tauri/target/universal-apple-darwin/release/bundle/dmg/"
  fi
fi

printf '\n%s%sJarvis is ready.%s\n' "$GREEN" "$BOLD" "$RESET"
printf '  %sStart it with:%s npm run desktop:dev\n' "$DIM" "$RESET"
printf '  %sOffline voice:%s bash scripts/download-models.sh\n' "$DIM" "$RESET"
printf '\n%sOne more step:%s macOS gatekeeps screen capture and input control.\n' "$YELLOW$BOLD" "$RESET"
printf '  Grant Jarvis %sScreen Recording%s and %sAccessibility%s under\n' "$BOLD" "$RESET" "$BOLD" "$RESET"
printf '  System Settings → Privacy & Security, then restart the app.\n'
