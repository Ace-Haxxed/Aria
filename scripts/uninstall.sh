#!/bin/bash
#
# Remove the `aria` command.
#
# Your settings, keys, conversations and downloaded models are left alone —
# uninstalling the binary is not a request to delete your data. To remove that
# too: rm -rf ~/.config/aria ~/.aria
set -euo pipefail

PREFIX="${PREFIX:-/usr/local}"
TARGET="$PREFIX/bin/aria"

if [ ! -e "$TARGET" ]; then
    echo "Nothing installed at $TARGET."
    exit 0
fi

sudo rm -f "$TARGET"
echo "ARIA removed."
echo "Your keys and data are still in ~/.config/aria and ~/.aria."
