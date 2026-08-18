#!/bin/bash
#
# Build ARIA and install it as the `aria` command.
#
# Run it as yourself, not under sudo: the build has to write to your own Cargo
# and npm caches, and running the whole thing as root leaves them owned by root
# so your next ordinary build fails. Only the two install steps need
# privileges, and those are the only ones that ask for it.
set -euo pipefail

PREFIX="${PREFIX:-/usr/local}"
BINDIR="$PREFIX/bin"
cd "$(dirname "$0")/.."

if [ "${EUID:-$(id -u)}" -eq 0 ] && [ -z "${ARIA_ALLOW_ROOT:-}" ]; then
    echo "Run this as your normal user — it will ask for sudo when it needs it." >&2
    echo "(Set ARIA_ALLOW_ROOT=1 to override.)" >&2
    exit 1
fi

# Release by default: the debug binary carries full debug info and comes out
# around 670 MB, against roughly 23 MB optimised. That is not something to put
# in /usr/local/bin as a matter of course. Set ARIA_DEBUG=1 for a debug build
# when you actually want the symbols.
if [ -n "${ARIA_DEBUG:-}" ]; then
    PROFILE="debug"
    echo "Building ARIA (debug)..."
    npm run tauri build -- --debug --no-bundle
else
    PROFILE="release"
    echo "Building ARIA..."
    npm run tauri build -- --no-bundle
fi

# Tauri names the binary after `productName` in tauri.conf.json.
BINARY="src-tauri/target/$PROFILE/aria"
if [ ! -x "$BINARY" ]; then
    echo "Build finished but $BINARY is missing." >&2
    echo "Check the productName in src-tauri/tauri.conf.json." >&2
    exit 1
fi

echo "Installing to $BINDIR/aria..."
sudo install -Dm755 "$BINARY" "$BINDIR/aria"

echo
echo "ARIA installed. Run: aria"
if ! command -v aria >/dev/null 2>&1; then
    echo "Note: $BINDIR is not on your PATH — add it to use \`aria\` directly."
fi
