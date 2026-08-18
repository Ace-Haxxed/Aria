#!/usr/bin/env bash
#
# Install everything Jarvis needs on Fedora / RHEL / Rocky / Alma.
#
# Usage: bash scripts/install-fedora.sh [--no-optional] [--build]

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

command -v dnf >/dev/null 2>&1 || die "this script is for Fedora/RHEL; use install-arch.sh or install-ubuntu.sh"
[ "$(id -u)" -ne 0 ] || die "do not run this as root — it calls sudo only where needed"

SESSION="${XDG_SESSION_TYPE:-}"
if [ -z "$SESSION" ]; then
  [ -n "${WAYLAND_DISPLAY:-}" ] && SESSION=wayland || SESSION=x11
fi
say "Detected a ${BOLD}${SESSION}${RESET} session on ${BOLD}$(uname -m)${RESET}"

say "Installing development tools"
sudo dnf group install -y "c-development" 2>/dev/null \
  || sudo dnf groupinstall -y "Development Tools" 2>/dev/null \
  || warn "could not install the development group; continuing"

CORE=(
  webkit2gtk4.1-devel openssl-devel curl wget file
  libappindicator-gtk3-devel librsvg2-devel gtk3-devel
  nodejs npm
)

if [ "$SESSION" = "wayland" ]; then
  SESSION_PKGS=(ydotool wtype grim slurp wl-clipboard)
else
  SESSION_PKGS=(xdotool scrot wmctrl xclip xorg-x11-utils)
fi

OPTIONAL=(pamixer brightnessctl libnotify playerctl chromium git)

PACKAGES=("${CORE[@]}" "${SESSION_PKGS[@]}")
[ "$INSTALL_OPTIONAL" -eq 1 ] && PACKAGES+=("${OPTIONAL[@]}")

say "Installing ${#PACKAGES[@]} packages"
printf '%s  %s%s\n' "$DIM" "${PACKAGES[*]}" "$RESET"
# --skip-unavailable: RHEL derivatives lack a few of these, and one missing
# optional package should not abort the whole install.
sudo dnf install -y --skip-unavailable "${PACKAGES[@]}" \
  || sudo dnf install -y "${PACKAGES[@]}" \
  || warn "some packages could not be installed; check the output above"
ok "packages installed"

# ffmpeg lives in RPM Fusion, which is not enabled by default.
if [ "$INSTALL_OPTIONAL" -eq 1 ] && ! command -v ffmpeg >/dev/null 2>&1; then
  warn "ffmpeg needs RPM Fusion. Enable it with:"
  printf '  %ssudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %%fedora).noarch.rpm%s\n' "$DIM" "$RESET"
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
    say "Building Jarvis"
    (cd "$REPO_ROOT" && npm run desktop:build)
    ok "bundles are in src-tauri/target/release/bundle/"
  fi
fi

printf '\n%s%sJarvis is ready.%s\n' "$GREEN" "$BOLD" "$RESET"
printf '  %sStart it with:%s npm run desktop:dev\n' "$DIM" "$RESET"
printf '  %sOffline voice:%s bash scripts/download-models.sh\n' "$DIM" "$RESET"
