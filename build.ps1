<#
.SYNOPSIS
    Builds Nocturn — the Rust daemon, the web client, or both.

.DESCRIPTION
    With no switches, builds both. The web client is built first, because the
    daemon serves it and a stale dist/ is the more confusing of the two
    failures: the app looks fine and simply behaves like an older version.

    Windows holds an open handle on a running executable, so `cargo build`
    fails with "Access is denied (os error 5)" while the daemon is up. This
    script detects that and says so, rather than leaving you to decode the
    error. It will not stop the daemon on its own unless you pass -Force:
    a restart kills every running shell, which for this project is the one
    thing worth being careful about.

.PARAMETER Agent
    Build only the Rust daemon.

.PARAMETER Web
    Build only the web client.

.PARAMETER Force
    Stop a running daemon rather than refusing to build. This kills its
    sessions.

.PARAMETER Test
    Also run the suites that need no daemon: cargo test and oxlint. The
    wire and browser suites need a running daemon, so they are not included
    here — start one with dev.ps1 and run them separately.

.EXAMPLE
    .\build.ps1
    Builds both halves.

.EXAMPLE
    .\build.ps1 -Agent -Force
    Stops the daemon and rebuilds it.

.EXAMPLE
    .\build.ps1 -Web
    Rebuilds the client only. No daemon restart needed — hard-refresh the
    browser (Ctrl+Shift+R) and it picks up the new bundle.
#>
[CmdletBinding()]
param(
    [switch]$Agent,
    [switch]$Web,
    [switch]$Force,
    [switch]$Test
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# Neither switch means both. Naming them explicitly is how you build one.
$targeted = $Agent -or $Web
$buildAgent = $Agent -or -not $targeted
$buildWeb = $Web -or -not $targeted

function Write-Step($text) {
    Write-Host ""
    Write-Host "==> $text" -ForegroundColor Cyan
}

function Write-Note($text) {
    Write-Host "    $text" -ForegroundColor DarkGray
}

function Stop-Daemon {
    $running = @(Get-Process nocturn-agent -ErrorAction SilentlyContinue)
    if ($running.Count -eq 0) { return $false }

    if (-not $Force) {
        Write-Host ""
        Write-Host "The daemon is running (PID $($running.Id -join ', '))." -ForegroundColor Yellow
        Write-Host "Windows locks a running .exe, so cargo cannot replace it." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  Ctrl+C it in its own terminal, or re-run with -Force." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Either way its sessions are lost: the PTYs are children of" -ForegroundColor DarkGray
        Write-Host "the daemon process and do not survive a restart." -ForegroundColor DarkGray
        exit 1
    }

    Write-Note "stopping daemon (PID $($running.Id -join ', '))"
    $running | Stop-Process -Force
    # The handle is released a moment after the process goes, and cargo fails
    # in exactly that window if it gets there first.
    $running | ForEach-Object { $_.WaitForExit(5000) | Out-Null }
    Start-Sleep -Milliseconds 300
    return $true
}

$started = Get-Date

if ($buildWeb) {
    Write-Step "Web client"
    Push-Location (Join-Path $root 'web')
    try {
        if (-not (Test-Path 'node_modules')) {
            Write-Note "node_modules missing; installing"
            npm install
            if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "web build failed" }

        if ($Test) {
            Write-Note "oxlint"
            npm run lint
            # oxlint exits non-zero only on errors; warnings are expected here
            # and are not a build failure.
        }
    }
    finally { Pop-Location }
}

if ($buildAgent) {
    Write-Step "Agent daemon"
    Stop-Daemon | Out-Null

    Push-Location (Join-Path $root 'agent')
    try {
        cargo build --release
        if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

        if ($Test) {
            Write-Note "cargo test"
            cargo test --release
            if ($LASTEXITCODE -ne 0) { throw "cargo test failed" }
        }
    }
    finally { Pop-Location }
}

$elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)

Write-Host ""
Write-Host "Built in ${elapsed}s" -ForegroundColor Green

if ($buildAgent) {
    $exe = Join-Path $root 'agent\target\release\nocturn-agent.exe'
    if (Test-Path $exe) {
        $stamp = (Get-Item $exe).LastWriteTime.ToString('HH:mm:ss')
        Write-Note "agent/target/release/nocturn-agent.exe  ($stamp)"
    }
}
if ($buildWeb) {
    $dist = Join-Path $root 'web\dist'
    if (Test-Path $dist) {
        $size = [math]::Round((Get-ChildItem $dist -Recurse -File |
            Measure-Object -Property Length -Sum).Sum / 1KB)
        Write-Note "web/dist  (${size} KB)"
    }
}

Write-Host ""
Write-Host "Start it with:  .\dev.ps1" -ForegroundColor DarkGray
