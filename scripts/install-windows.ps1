<#
.SYNOPSIS
  Install everything Jarvis needs on Windows 10 or 11.

.DESCRIPTION
  Installs the build toolchain (Rust, Node, VS Build Tools, WebView2) via winget,
  then the project dependencies. Run from an ordinary PowerShell prompt — it
  elevates only where a package actually requires it.

.PARAMETER NoOptional
  Skip optional packages (ffmpeg, Chromium, Ollama).

.PARAMETER Build
  Build the installers after setup.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
#>

[CmdletBinding()]
param(
    [switch]$NoOptional,
    [switch]$Build
)

$ErrorActionPreference = 'Stop'

function Say  { param($m) Write-Host "==> $m" -ForegroundColor Cyan }
function Ok   { param($m) Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!] $m" -ForegroundColor Yellow }
function Die  { param($m) Write-Host "error: $m" -ForegroundColor Red; exit 1 }

# ── Preconditions ──────────────────────────────────────────────────

if ([System.Environment]::OSVersion.Version.Major -lt 10) {
    Die 'Windows 10 or later is required.'
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Die 'winget is not available. Install "App Installer" from the Microsoft Store, then re-run.'
}

Say "Detected Windows $([System.Environment]::OSVersion.Version) on $env:PROCESSOR_ARCHITECTURE"

# ── Package installation ───────────────────────────────────────────

function Install-Package {
    param(
        [string]$Id,
        [string]$Name,
        [string]$Check
    )

    if ($Check -and (Get-Command $Check -ErrorAction SilentlyContinue)) {
        Ok "$Name already installed"
        return
    }

    Say "Installing $Name"
    # --silent avoids interactive installers; the accept flags stop winget
    # blocking on a licence prompt in a non-interactive session.
    $result = winget install --id $Id --exact --silent `
        --accept-package-agreements --accept-source-agreements 2>&1

    if ($LASTEXITCODE -eq 0) {
        Ok "$Name installed"
    } elseif ($result -match 'already installed') {
        Ok "$Name already installed"
    } else {
        Warn "could not install ${Name}: winget exited with $LASTEXITCODE"
    }
}

# Core toolchain. The MSVC build tools supply the linker Rust needs; WebView2 is
# the rendering engine the shipped app runs on.
Install-Package -Id 'Microsoft.VisualStudio.2022.BuildTools' -Name 'Visual Studio Build Tools' -Check $null
Install-Package -Id 'Microsoft.EdgeWebView2Runtime' -Name 'WebView2 Runtime' -Check $null
Install-Package -Id 'OpenJS.NodeJS.LTS' -Name 'Node.js LTS' -Check 'node'
Install-Package -Id 'Rustlang.Rustup' -Name 'Rust' -Check 'rustc'
Install-Package -Id 'Git.Git' -Name 'Git' -Check 'git'

if (-not $NoOptional) {
    Install-Package -Id 'Gyan.FFmpeg' -Name 'ffmpeg' -Check 'ffmpeg'
    Install-Package -Id 'Hibbiki.Chromium' -Name 'Chromium' -Check $null
    Install-Package -Id 'Ollama.Ollama' -Name 'Ollama' -Check 'ollama'
}

# winget updates the machine PATH but not this session's copy.
Say 'Refreshing PATH for this session'
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [System.Environment]::GetEnvironmentVariable('Path', 'User')

# The Build Tools installer does not always include the C++ workload, and
# without it `cargo build` fails at the link step with a cryptic error.
if (-not (Get-Command link.exe -ErrorAction SilentlyContinue)) {
    Warn 'The MSVC linker was not found on PATH.'
    Warn 'Open "Visual Studio Installer" and add the "Desktop development with C++" workload.'
}

if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) {
    Warn 'Rust is not on PATH yet. Close and reopen PowerShell, then re-run this script.'
    exit 0
}

# ── Project dependencies ───────────────────────────────────────────

$RepoRoot = Split-Path -Parent $PSScriptRoot
$PackageJson = Join-Path $RepoRoot 'package.json'

if (Test-Path $PackageJson) {
    Say 'Installing project dependencies'
    Push-Location $RepoRoot
    try {
        npm install
        Ok 'npm dependencies installed'

        if ($Build) {
            Say 'Building Jarvis (this takes a few minutes on a first build)'
            npm run desktop:build
            Ok 'installers are in src-tauri\target\release\bundle\'
        }
    } finally {
        Pop-Location
    }
}

Write-Host ''
Write-Host 'Jarvis is ready.' -ForegroundColor Green
Write-Host '  Start it with: npm run desktop:dev'
Write-Host '  Offline voice: bash scripts/download-models.sh  (use Git Bash or WSL)'
