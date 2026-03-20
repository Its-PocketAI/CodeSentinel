param(
  [string]$Remote = $(if ($env:CODESENTINEL_UPDATE_REMOTE) { $env:CODESENTINEL_UPDATE_REMOTE } else { "origin" }),
  [string]$Branch = $(if ($env:CODESENTINEL_UPDATE_BRANCH) { $env:CODESENTINEL_UPDATE_BRANCH } else { "" }),
  [switch]$AllowDirty
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $PSScriptRoot

function Fail([string]$Message) {
  Write-Host "[error] $Message"
  exit 1
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail "git not found in PATH."
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Fail "pnpm not found in PATH."
}

Set-Location $RootDir

$inside = (git rev-parse --is-inside-work-tree 2>$null)
if ($LASTEXITCODE -ne 0 -or $inside.Trim() -ne "true") {
  Fail "This directory is not a git repository: $RootDir"
}

$allowDirtyEnv = $env:CODESENTINEL_UPDATE_ALLOW_DIRTY -eq "1"
if (-not $AllowDirty -and -not $allowDirtyEnv) {
  $dirty = git status --porcelain
  if ($dirty) {
    Fail "Working tree has local changes. Commit/stash first, or use -AllowDirty / CODESENTINEL_UPDATE_ALLOW_DIRTY=1."
  }
}

$currentBranch = (git rev-parse --abbrev-ref HEAD).Trim()
if ([string]::IsNullOrWhiteSpace($currentBranch) -or $currentBranch -eq "HEAD") {
  $currentBranch = "main"
}
if ([string]::IsNullOrWhiteSpace($Branch)) {
  $Branch = $currentBranch
}

Write-Host "[info] Stopping service (if running)..."
& (Join-Path $RootDir "run/prod-stop.ps1")

Write-Host "[info] Fetching latest code from $Remote/$Branch ..."
git fetch $Remote $Branch --tags
if ($LASTEXITCODE -ne 0) {
  Fail "git fetch failed."
}

if ($currentBranch -ne $Branch) {
  Write-Host "[info] Switching branch to $Branch ..."
  git checkout $Branch
  if ($LASTEXITCODE -ne 0) {
    Fail "git checkout $Branch failed."
  }
}

Write-Host "[info] Pulling latest code ..."
git pull --ff-only $Remote $Branch
if ($LASTEXITCODE -ne 0) {
  Fail "git pull failed. Resolve branch divergence before updating."
}

Write-Host "[info] Installing dependencies ..."
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) {
  Fail "pnpm install failed."
}

Write-Host "[info] Starting service ..."
& (Join-Path $RootDir "run/prod-start.ps1")
if ($LASTEXITCODE -ne 0) {
  Fail "service start failed."
}

Write-Host "[ok] Update completed."
