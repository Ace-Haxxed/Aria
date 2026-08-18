#!/usr/bin/env bash
#
# Install everything ARIA needs on Arch Linux (and derivatives: Manjaro,
# EndeavourOS, CachyOS).
#
# Usage: bash scripts/install-arch.sh [--no-optional] [--build]

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
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

command -v pacman >/dev/null 2>&1 || die "this script is for Arch Linux; use install-fedora.sh or install-ubuntu.sh"
[ "$(id -u)" -ne 0 ] || die "do not run this as root — it calls sudo only where needed"

# Detect the session so we install the input/capture tools that actually work here.
SESSION="${XDG_SESSION_TYPE:-}"
if [ -z "$SESSION" ]; then
  [ -n "${WAYLAND_DISPLAY:-}" ] && SESSION=wayland || SESSION=x11
fi
say "Detected a ${BOLD}${SESSION}${RESET} session on ${BOLD}$(uname -m)${RESET}"

# ── Core: build toolchain and the Tauri/WebKit stack ───────────────
CORE=(
  base-devel curl wget file openssl
  webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg
  rust nodejs npm
)

# ── Session-specific control tools ─────────────────────────────────
if [ "$SESSION" = "wayland" ]; then
  SESSION_PKGS=(ydotool wtype grim slurp wl-clipboard)
else
  SESSION_PKGS=(xdotool scrot wmctrl xclip xorg-xprop)
fi

# ── Optional: features degrade gracefully without these ────────────
OPTIONAL=(pamixer brightnessctl libnotify playerctl ffmpeg chromium git)

PACKAGES=("${CORE[@]}" "${SESSION_PKGS[@]}")
[ "$INSTALL_OPTIONAL" -eq 1 ] && PACKAGES+=("${OPTIONAL[@]}")

say "Installing ${#PACKAGES[@]} packages"
printf '%s  %s%s\n' "$DIM" "${PACKAGES[*]}" "$RESET"
sudo pacman -S --needed --noconfirm "${PACKAGES[@]}"
ok "packages installed"

# ── ydotool needs its daemon running to inject input ───────────────
if [ "$SESSION" = "wayland" ]; then
  say "Enabling the ydotool daemon"
  if systemctl list-unit-files 2>/dev/null | grep -q '^ydotool\.service'; then
    sudo systemctl enable --now ydotool.service 2>/dev/null \
      && ok "ydotoold running" \
      || warn "could not start ydotoold — run: sudo systemctl enable --now ydotool"
  else
    warn "no ydotool service unit found; start ydotoold manually before using mouse/keyboard control"
  fi

  # ydotool writes to /dev/uinput, which is root-only by default.
  if [ ! -e /dev/uinput ] || ! [ -r /dev/uinput ]; then
    say "Granting access to /dev/uinput"
    echo 'KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' \
      | sudo tee /etc/udev/rules.d/80-jarvis-uinput.rules >/dev/null
    sudo usermod -aG input "$USER"
    sudo udevadm control --reload-rules && sudo udevadm trigger
    warn "log out and back in for the 'input' group to take effect"
  fi
fi

# ── Ollama, so ARIA works offline out of the box ───────────────────
if [ "$INSTALL_OPTIONAL" -eq 1 ] && ! command -v ollama >/dev/null 2>&1; then
  say "Installing Ollama (local LLM backend)"
  if sudo pacman -S --needed --noconfirm ollama 2>/dev/null; then
    sudo systemctl enable --now ollama 2>/dev/null || true
    ok "ollama installed"
    printf '  %sthen run: ollama pull llama3.1:8b%s\n' "$DIM" "$RESET"
  else
    warn "ollama is not in the official repos on this system; install from https://ollama.com"
  fi
fi

# ── Project dependencies ───────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$REPO_ROOT/package.json" ]; then
  say "Installing project dependencies"
  (cd "$REPO_ROOT" && npm install)
  ok "npm dependencies installed"

  if [ "$DO_BUILD" -eq 1 ]; then
    say "Building ARIA (this takes a few minutes on a first build)"
    (cd "$REPO_ROOT" && npm run desktop:build)
    ok "bundles are in src-tauri/target/release/bundle/"
  fi
fi

printf '\n%s%sARIA is ready.%s\n' "$GREEN" "$BOLD" "$RESET"
printf '  %sStart it with:%s npm run desktop:dev\n' "$DIM" "$RESET"
printf '  %sOffline voice:%s bash scripts/download-models.sh\n' "$DIM" "$RESET"
