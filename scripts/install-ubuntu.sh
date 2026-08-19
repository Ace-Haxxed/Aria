#!/usr/bin/env bash
#
# Install everything NOVA needs on Ubuntu / Debian / Pop!_OS / Mint.
#
# Usage: bash scripts/install-ubuntu.sh [--no-optional] [--build]

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

command -v apt-get >/dev/null 2>&1 || die "this script is for Debian/Ubuntu; use install-arch.sh or install-fedora.sh"
[ "$(id -u)" -ne 0 ] || die "do not run this as root — it calls sudo only where needed"

SESSION="${XDG_SESSION_TYPE:-}"
if [ -z "$SESSION" ]; then
  [ -n "${WAYLAND_DISPLAY:-}" ] && SESSION=wayland || SESSION=x11
fi
say "Detected a ${BOLD}${SESSION}${RESET} session on ${BOLD}$(uname -m)${RESET}"

say "Updating package lists"
sudo apt-get update -qq

# Ubuntu 22.04+ and Debian 12+ ship webkit2gtk-4.1; older releases only have 4.0,
# which Tauri 2 cannot use.
WEBKIT="libwebkit2gtk-4.1-dev"
if ! apt-cache show "$WEBKIT" >/dev/null 2>&1; then
  warn "libwebkit2gtk-4.1-dev is unavailable — your release is too old for Tauri 2"
  warn "Ubuntu 22.04+ or Debian 12+ is required"
  WEBKIT="libwebkit2gtk-4.0-dev"
fi

CORE=(
  build-essential curl wget file pkg-config
  "$WEBKIT" libssl-dev libgtk-3-dev
  libayatana-appindicator3-dev librsvg2-dev
  nodejs npm
)

if [ "$SESSION" = "wayland" ]; then
  SESSION_PKGS=(ydotool wtype grim slurp wl-clipboard)
else
  SESSION_PKGS=(xdotool scrot wmctrl xclip x11-utils)
fi

OPTIONAL=(pamixer brightnessctl libnotify-bin playerctl ffmpeg chromium-browser git)

PACKAGES=("${CORE[@]}" "${SESSION_PKGS[@]}")
[ "$INSTALL_OPTIONAL" -eq 1 ] && PACKAGES+=("${OPTIONAL[@]}")

say "Installing ${#PACKAGES[@]} packages"
printf '%s  %s%s\n' "$DIM" "${PACKAGES[*]}" "$RESET"
# Install one at a time on failure: Debian and Ubuntu disagree on a few package
# names (chromium vs chromium-browser), and one miss should not abort the rest.
if ! sudo apt-get install -y "${PACKAGES[@]}" 2>/dev/null; then
  warn "batch install failed; retrying package by package"
  for pkg in "${PACKAGES[@]}"; do
    sudo apt-get install -y "$pkg" >/dev/null 2>&1 || warn "skipped $pkg (not available)"
  done
fi
ok "packages installed"

# Ubuntu's `nodejs` can be several major versions behind what Vite needs.
NODE_MAJOR="$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/')"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
  say "Installing a current Node.js (the distro version is too old)"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ok "node $(node -v) installed"
fi

if ! command -v rustc >/dev/null 2>&1; then
  say "Installing Rust"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck source=/dev/null
  . "$HOME/.cargo/env"
  ok "rust installed"
fi

if [ "$SESSION" = "wayland" ] && command -v ydotool >/dev/null 2>&1; then
  say "Enabling the ydotool daemon"
  sudo systemctl enable --now ydotool 2>/dev/null \
    && ok "ydotoold running" \
    || warn "start ydotoold manually before using mouse/keyboard control"

  echo 'KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' \
    | sudo tee /etc/udev/rules.d/80-nova-uinput.rules >/dev/null
  sudo usermod -aG input "$USER"
  sudo udevadm control --reload-rules && sudo udevadm trigger
  warn "log out and back in for the 'input' group to take effect"
fi

if [ "$INSTALL_OPTIONAL" -eq 1 ] && ! command -v ollama >/dev/null 2>&1; then
  say "Installing Ollama (local LLM backend)"
  curl -fsSL https://ollama.com/install.sh | sh && ok "ollama installed" || warn "ollama install failed"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$REPO_ROOT/package.json" ]; then
  say "Installing project dependencies"
  (cd "$REPO_ROOT" && npm install)
  ok "npm dependencies installed"

  if [ "$DO_BUILD" -eq 1 ]; then
    say "Building NOVA"
    (cd "$REPO_ROOT" && npm run desktop:build)
    ok "bundles are in src-tauri/target/release/bundle/"
  fi
fi

printf '\n%s%sNOVA is ready.%s\n' "$GREEN" "$BOLD" "$RESET"
printf '  %sStart it with:%s npm run desktop:dev\n' "$DIM" "$RESET"
printf '  %sOffline voice:%s bash scripts/download-models.sh\n' "$DIM" "$RESET"
