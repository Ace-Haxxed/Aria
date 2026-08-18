<div align="center">

# Aria

**An AI assistant with hands.**

It sees your screen, controls your mouse and keyboard, manages your files and
drives your browser — by voice or by text, on desktop and mobile, from one
shared codebase.

[Download](https://jarvis-assistant.github.io/jarvis/) ·
[Build from source](#build-from-source) ·
[Contributing](#contributing)

</div>

---

## Install

| Platform | One line |
|---|---|
| **Arch Linux** | `sudo pacman -U jarvis-*.pkg.tar.zst` |
| **Fedora / RHEL** | `sudo dnf install ./jarvis-*.rpm` |
| **Ubuntu / Debian** | `sudo apt install ./jarvis_*.deb` |
| **Any Linux** | `chmod +x jarvis_*.AppImage && ./jarvis_*.AppImage` |
| **Windows 10/11** | Run `Jarvis_*.msi`, or `jarvis-portable.exe` with no install |
| **macOS 12+** | Open the `.dmg`, drag to Applications, then right-click → Open |
| **Android 8+** | Sideload `app-debug.apk` |
| **iOS 15+** | Join the TestFlight beta |

Grab the files from the [latest release](https://github.com/jarvis-assistant/jarvis/releases/latest),
or use the [download page](https://jarvis-assistant.github.io/jarvis/), which
detects your platform for you.

### Get it on your phone

The download page shows a QR code for exactly this. On desktop, open
<https://jarvis-assistant.github.io/jarvis/> and scan the code in the
"Get it on your phone" section.

### Installing the dependencies instead

If you would rather set up a development machine, the install scripts handle
every system dependency for you:

```bash
bash scripts/install-arch.sh      # Arch, Manjaro, EndeavourOS
bash scripts/install-fedora.sh    # Fedora, RHEL, Rocky, Alma
bash scripts/install-ubuntu.sh    # Ubuntu, Debian, Pop!_OS, Mint
bash scripts/install-mac.sh       # macOS 12+
powershell -ExecutionPolicy Bypass -File scripts/install-windows.ps1
```

Pass `--build` to build the installers at the end, or `--no-optional` to skip
the extras.

---

## First run

Jarvis opens a setup wizard that:

- detects your OS, session type (X11 or Wayland) and compositor
- checks for missing tools and gives you the exact command to install them
- lets you pick an AI backend and test the connection
- configures voice, wake word and hotkeys
- tests your microphone, speaker and screen capture before finishing

On mobile it requests each permission with a plain explanation of what it is for.

---

## Choosing a brain

Jarvis needs a language model. You can switch at any time in Settings → AI.

| Backend | Key needed | Notes |
|---|---|---|
| **Built-in** | no | Runs inside Jarvis. No server, no account, no internet after the one-time model download. Default. |
| **Ollama** | no | Runs locally in its own server. Nothing leaves your machine. |
| **Groq** | yes (free) | Fastest cloud option by a wide margin. |
| **OpenRouter** | yes (free tier) | One key, every model. The `:free` models need no credits. |
| **Bytez** | yes | Serverless HuggingFace models, OpenAI-compatible. Enter any model id. |
| **OpenAI** | yes | `gpt-4o` and friends. |
| **Anthropic** | yes | Claude models. |
| **Google Gemini** | yes | `gemini-2.5-flash` and friends. The 1.5 generation is retired — a request for it returns "not found for API version v1beta". |
| **Custom** | optional | Any OpenAI-compatible endpoint: vLLM, LM Studio, llama.cpp. |
| **On-device** | no | `phi-3-mini` or `gemma-2b` on the phone itself. |

### OpenRouter

One key reaches models from every provider, which makes it the simplest way to
try several without collecting keys from each. Jarvis defaults to a `:free`
model, so a new key works immediately without adding credits:

| Model | Context | Cost |
|---|---|---|
| `meta-llama/llama-3.3-70b-instruct:free` | 131K | free, rate limited |
| `google/gemma-4-26b-a4b-it:free` | 262K | free, rate limited |
| `nvidia/nemotron-3.5-lightning:free` | 1M | free, rate limited |
| `anthropic/claude-sonnet-4.5` | 1M | paid |

Any model id from openrouter.ai/models can be typed in directly.

### Groq's free tier

Groq publishes different allowances per model, and the per-minute figure is not
the one that runs out first:

| Model | Context | Tokens/min | Tokens/day | Requests/day |
|---|---|---|---|---|
| `llama-3.1-8b-instant` | 131K | 6,000 | **500,000** | **14,400** |
| `llama-3.3-70b-versatile` | 131K | 12,000 | 100,000 | 1,000 |

Jarvis defaults to the 8B model. It has half the per-minute allowance but five
times the daily tokens and fourteen times the daily requests, which is what a
free key actually exhausts. Switch to the 70B model in Settings → AI when a
request needs the extra capability.

When a rate limit is hit, Jarvis reads the delay the provider states, shows a
countdown and retries itself. There is nothing to press.

### Fully offline with Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.1:8b     # the reasoning model
ollama pull llava           # the vision model, for seeing your screen
```

Then pick **Ollama** in Settings → AI. No key, no account, no network.

### API keys

Keys go in Settings → AI. They are stored in your **OS keychain** on desktop
(Secret Service on Linux, Keychain on macOS, Credential Manager on Windows) and
in secure storage on mobile. They are never written to the settings file or the
database, so exporting your action log or backing up your profile cannot leak
them.

### Offline voice

Speech works out of the box using your browser's and OS's built-in engines. For
fully offline, higher quality speech:

```bash
bash scripts/download-models.sh
```

That fetches whisper.cpp (speech-to-text) and piper (text-to-speech) plus their
models — about 140 MB. They are not bundled in the installer because most people
never need them. Jarvis picks them up at runtime and falls back gracefully when
they are absent.

---

## What it can do

**Everywhere**

Web search (DuckDuckGo, no key) · read and summarise any page · timers and
reminders · notifications · file management · clipboard history · long-term
memory of your preferences

**Desktop only**

See and describe your screen · find things on screen by description · click,
type, drag and scroll · manage windows and applications · read, write, organise,
zip and search files · drive a browser (navigate, click, fill forms, download) ·
run Python, Node and shell scripts · control volume, brightness and power ·
manage system packages and services · monitor processes

**Mobile only**

Camera analysis ("what is this?") · share to Jarvis from any app · home screen
widget · quick settings tile · Siri Shortcuts

---

## Safety

Jarvis can delete files and run shell commands, so there is a confirmation layer
in front of everything that matters.

- **It asks first** before deleting, running shell commands, installing or
  removing packages, shutting down, closing windows that may hold unsaved work,
  or anything else marked destructive.
- **The prompt shows you exactly what will happen** — the literal command, a
  risk level, and why it is being asked.
- **Shell commands are judged on their content**, not just their category. `ls`
  is waved through; anything matching `rm -rf`, `dd of=/dev/…`, `curl | sh`,
  `mkfs` or `sudo` always prompts, even if you previously trusted the tool.
- **Deletes go to the trash**, never `rm`. The action log offers a one-click
  restore.
- **"Trust this action type"** stops the prompts for a specific tool — but it is
  deliberately unavailable for high-risk actions.
- **Every action is logged** with its arguments, result and timing, and the log
  exports as JSON.
- **Capabilities can be switched off entirely** in Settings → Permissions. A
  disabled capability's tools are hidden from the model, which cannot use — or
  even see — them. Terminal and package management are **off by default**.

---

## Privacy

No analytics, no telemetry, no crash reporting, no phoning home. The only
network traffic Jarvis generates is to the AI backend you chose and to pages you
ask it to read. Choose Ollama and there is none at all.

Conversation history and long-term memory live in a local SQLite database
(desktop) or device storage (mobile), and both can be disabled or wiped from
Settings → Privacy.

---

## Build from source

**Requirements:** Node 18+, Rust 1.77+, and your platform's system dependencies
(the install scripts handle these).

```bash
git clone https://github.com/jarvis-assistant/jarvis
cd jarvis
npm install

npm run desktop:dev      # run the desktop app in development
npm run desktop:build    # build installers for the current platform
```

### Mobile

```bash
npm run android:open     # sync and open in Android Studio
npm run ios:open         # sync and open in Xcode (macOS only)

npm run android:build    # debug APK + release AAB
```

Two optional iOS extensions (share extension, WidgetKit widget) ship as source
in `ios/extensions/` with setup instructions in
[`ios/extensions/README.md`](ios/extensions/README.md). They need targets added
in Xcode, because `project.pbxproj` cannot be edited reliably by hand. The app
builds and ships without them.

### Useful commands

```bash
npm run typecheck                        # tsc --noEmit
cd src-tauri && cargo clippy             # lint the Rust backend
npm run tauri -- build --bundles deb     # build one specific bundle
```

---

## Architecture

```
src/
  core/          agent loop, LLM clients, memory, safety, shared tools
  platform/      index.ts picks desktop.ts or mobile.ts at runtime
  components/    shared/ · desktop/ · mobile/ · Settings/ · SetupWizard/ · ui/
  hooks/         useAgent, useVoice, useHotkeys, useWakeWord
  store/         zustand: conversation, settings, actions, timers
src-tauri/
  src/commands/  screen, mouse, keyboard, windows, files, apps, system,
                 browser, linux, voice, secrets, db
  src/platform/  detect.rs picks wayland.rs · x11.rs · windows.rs · macos.rs
android/  ios/   Capacitor native projects
```

**One React codebase.** `src/platform/index.ts` resolves to the desktop or
mobile tool set once at startup; nothing above it branches on runtime. Vite code-
splits the two, so the mobile bundle never ships desktop code and vice versa.

**The agent loop** (`src/core/agent.ts`) is think → act → observe → repeat: the
model streams a reply, any tool calls run through the safety layer, results feed
back, and it continues until it answers without calling a tool. Every tool call
appears in the action log as it happens.

**Platform dispatch in Rust** (`src-tauri/src/platform/`) picks the right helper
for the environment: `ydotool`/`wtype` for input on Wayland, `scrot`/`xdotool`/
`wmctrl` on X11, `hyprctl` and `swaymsg` for window management on wlroots
compositors, `enigo` (SendInput / CGEvent) on Windows and macOS.

Screen capture is chosen per compositor, because there is no portable Wayland
route: wlroots compositors (Hyprland, Sway) get `grim`, KDE gets `spectacle`,
and GNOME goes through **xdg-desktop-portal**. GNOME implements neither the
`wlr-screencopy` protocol `grim` needs nor an open `org.gnome.Shell.Screenshot`
— the latter has answered `AccessDenied` to callers outside the Shell since
GNOME 41, including `gnome-screenshot` itself — so the portal is the only route
that works there. Each family falls back to the portal if its native tool fails.

**Hardware never goes through the webview.** The microphone is captured in Rust
with `cpal` (ALSA / WASAPI / CoreAudio) rather than `getUserMedia`, because
WebKitGTK cannot reach the microphone on a Wayland session: the request fails
before a permission prompt is ever shown. Screen capture is likewise a Rust
path. The frontend receives audio as `mic-chunk` and `mic-level` events.

### Deliberate choices

- **CDP instead of Playwright** for browser control. Playwright is a Node library
  and cannot be driven from a Tauri binary without shipping a Node runtime; CDP
  is the protocol Playwright speaks underneath. Chromium-family browsers get the
  full tool set. Firefox removed its CDP implementation in version 129, so on a
  Firefox-only system `open_url` works and the DOM-level tools report what is
  missing rather than failing silently.
- **Subprocess helpers, not FFI** for capture, window management and system
  control. This keeps the crate free of hand-written `unsafe`, and means the
  identical Rust compiles for every target — which is what makes the CI matrix
  reliable.
- **Models are downloaded, not bundled.** 140 MB in every installer for a feature
  most users replace with a cloud backend is a bad trade.

### Known platform limits

- **GNOME and KDE on Wayland** do not expose window management to applications.
  Hyprland and Sway are fully supported; on GNOME/KDE, window tools return an
  explanation. Everything else works. An X11 session has no such limit.
- **Reading the cursor position on Wayland** is only possible under Hyprland —
  no other compositor exposes it.
- **macOS** needs Screen Recording and Accessibility granted in System Settings →
  Privacy & Security before screen and input control work.
- **Wayland input** needs `ydotoold` running and access to `/dev/uinput`. The
  setup wizard installs `ydotool` and starts its user service for you; granting
  a user access to `/dev/uinput` is a root-level change and is the one step that
  can still need a terminal.
- **Screen capture on GNOME** goes through xdg-desktop-portal, which may ask for
  permission the first time. The grant is remembered.

---

## Sharing Jarvis offline

Jarvis normally ships as a small installer and downloads its AI model on first
launch. On a machine with no internet — an air-gapped workstation, a workshop
with no wifi, a friend on a metered connection — that first launch never
completes, so there is a second option: one archive with everything in it.

```bash
scripts/bundle-with-model.sh              # bundle with Phi-3.5 Mini (~2.2 GB)
scripts/bundle-with-model.sh qwen2.5-1.5b # a smaller model (~1 GB)
scripts/bundle-with-model.sh --list       # what is available
```

The script builds the release binary, downloads the model if it is not already
in `~/.jarvis/models`, verifies it against the checksum HuggingFace publishes,
and writes a tarball to `src-tauri/target/bundle/`.

On the receiving machine:

```bash
tar -xzf jarvis-bundle-phi-3.5-mini-linux-x86_64-*.tar.gz
cd jarvis-bundle
./install-bundle.sh
```

That copies the model to `~/.jarvis/models` and the binary to `~/.local/bin`,
and adds a desktop entry on Linux. Nothing is downloaded, no account is needed,
and Jarvis works fully offline from that point. Adding a cloud API key later is
optional and never required.

The bundle is built for the platform and architecture it was created on, so a
Linux bundle will not run on macOS. Build one on each platform you need.

## Contributing

Pull requests are welcome. Before opening one:

```bash
npm run typecheck
cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

CI runs exactly these, then builds every platform. Both must pass.

**Adding a tool** is the most common contribution. Add a `defineTool({…})` entry
in `src/platform/desktop.ts` or `mobile.ts` — set its `capability` and `risk`
honestly, mark it `destructive` if it cannot be trivially undone, and write the
`description` for the model rather than for a human. If it needs new native
capability, add a `#[tauri::command]` in `src-tauri/src/commands/` and register
it in `lib.rs`.

**Adding a platform backend** means implementing the function set in
`src-tauri/src/platform/mod.rs` for your environment and adding a branch to
`backend()`.

---

## Licence

MIT. See [LICENSE](LICENSE).

Jarvis can control your device. Read what it asks before you approve it.
