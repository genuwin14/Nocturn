<#
.SYNOPSIS
    Starts the Nocturn daemon against this repository.

.DESCRIPTION
    Runs in the foreground, so this terminal *is* the daemon: its log appears
    here, and Ctrl+C stops it. That is deliberate rather than a limitation —
    attaches, detaches and auth failures all print live, and when the client
    misbehaves this window usually says why.

    Checks the things that actually go wrong before starting: a missing build,
    a port already held, a root that does not exist.

.PARAMETER Root
    Project root. Shells start here and the file API cannot escape it.
    Defaults to this repository, which is a git repository and so gives the
    Review tab something real to show.

    Point this at whatever you want to reach from your phone. Prefer a folder
    holding your projects over something broad like C:\ — root is the blast
    radius of the token, and the terminal can cd anywhere regardless.

.PARAMETER Port
    Loopback port. Default 7071.

.PARAMETER Token
    Access token. Omitted, the daemon reuses the one persisted in
    %APPDATA%\nocturn\agent.token, generating it on first run.

.PARAMETER Shell
    Shell to spawn. Accepts arguments, e.g. -Shell "tmux new -A -s claude".

.PARAMETER Open
    Open the browser once the daemon answers.

.EXAMPLE
    .\dev.ps1
    Serves this repository on http://127.0.0.1:7071.

.EXAMPLE
    .\dev.ps1 -Root C:\code\my-app -Open
    Serves another project and opens it in the browser.
#>
[CmdletBinding()]
param(
    [string]$Root,
    [int]$Port = 7071,
    [string]$Token,
    [string]$Shell,
    [switch]$Open
)

$ErrorActionPreference = 'Stop'

# Resolved here rather than as a param default: $PSScriptRoot is not populated
# while the param block is being bound, so a default of $PSScriptRoot binds an
# empty string and every path built from it fails.
$repo = $PSScriptRoot
if (-not $repo) { $repo = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $Root) { $Root = $repo }

$exe = Join-Path $repo 'agent\target\release\nocturn-agent.exe'
$dist = Join-Path $repo 'web\dist'

# --- preflight ---------------------------------------------------------------

if (-not (Test-Path $Root)) {
    Write-Host "Project root does not exist: $Root" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $exe)) {
    Write-Host "The daemon is not built yet." -ForegroundColor Yellow
    Write-Host "  Run .\build.ps1 first." -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path (Join-Path $dist 'index.html'))) {
    Write-Host "The web client is not built yet." -ForegroundColor Yellow
    Write-Host "  Run .\build.ps1 first." -ForegroundColor Yellow
    exit 1
}

# A held port is the most common startup failure, and the daemon's own message
# for it ("Only one usage of each socket address") does not say what is holding
# it. Answering that here saves the guessing.
$held = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($held) {
    $owner = Get-Process -Id $held[0].OwningProcess -ErrorAction SilentlyContinue
    Write-Host ""
    Write-Host "Port $Port is already in use by $($owner.ProcessName) (PID $($held[0].OwningProcess))." -ForegroundColor Yellow
    if ($owner.ProcessName -eq 'nocturn-agent') {
        Write-Host "That is another Nocturn daemon. Stop it, or use -Port to run beside it." -ForegroundColor Yellow
    } else {
        Write-Host "Use -Port to pick another." -ForegroundColor Yellow
    }
    Write-Host ""
    exit 1
}

# A daemon older than the binary is a genuinely confusing state to debug — the
# app works, and behaves like a version you no longer have. Worth one line.
$built = (Get-Item $exe).LastWriteTime
Write-Host ""
Write-Host "nocturn-agent built $($built.ToString('yyyy-MM-dd HH:mm:ss'))" -ForegroundColor DarkGray

# --- run ---------------------------------------------------------------------

$agentArgs = @(
    '--root', $Root
    '--bind', "127.0.0.1:$Port"
    '--web', $dist
)
if ($Token) { $agentArgs += @('--token', $Token) }
if ($Shell) { $agentArgs += @('--shell', $Shell) }

if ($Open) {
    # The daemon holds this terminal once started, so the browser has to be
    # opened from somewhere else. Poll /health rather than guessing a delay.
    $url = "http://127.0.0.1:$Port/"
    Start-Job -ScriptBlock {
        param($probe, $url)
        for ($i = 0; $i -lt 40; $i++) {
            try {
                Invoke-WebRequest -Uri $probe -TimeoutSec 1 -UseBasicParsing | Out-Null
                Start-Process $url
                return
            } catch { Start-Sleep -Milliseconds 250 }
        }
    } -ArgumentList "http://127.0.0.1:$Port/health", $url | Out-Null
}

Write-Host "Ctrl+C to stop. Sessions do not survive a restart." -ForegroundColor DarkGray

& $exe @agentArgs
