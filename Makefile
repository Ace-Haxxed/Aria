# ARIA — Adaptive Reasoning and Intelligence Assistant
#
# Recipes must be indented with tabs, not spaces.

.PHONY: install uninstall dev build check test clean

## Build and install the `aria` command system-wide.
install:
	bash scripts/install.sh

## Remove the `aria` command. Leaves your keys and data alone.
uninstall:
	bash scripts/uninstall.sh

## Run with hot reload.
dev:
	npm run tauri dev

## Release build.
build:
	npm run tauri build

## Typecheck the frontend and the Rust side without producing a binary.
check:
	npx tsc --noEmit
	cd src-tauri && cargo check --all-targets

## Run the Rust test suite.
test:
	cd src-tauri && cargo test

## Drop build artifacts. Your keys and data are untouched.
clean:
	cd src-tauri && cargo clean
	rm -rf dist
