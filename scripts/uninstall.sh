#!/bin/bash
#
# Remove the `nova` command.
#
# Your settings, keys, conversations and downloaded models are left alone —
# uninstalling the binary is not a request to delete your data. To remove that
# too: rm -rf ~/.config/nova ~/.nova
set -euo pipefail

PREFIX="${PREFIX:-/usr/local}"
TARGET="$PREFIX/bin/nova"

if [ ! -e "$TARGET" ]; then
    echo "Nothing installed at $TARGET."
    exit 0
fi

sudo rm -f "$TARGET"
echo "NOVA removed."
echo "Your keys and data are still in ~/.config/nova and ~/.nova."
