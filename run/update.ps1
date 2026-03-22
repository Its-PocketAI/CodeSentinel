param(
  [string]$Remote = $(if ($env:CODESENTINEL_UPDATE_REMOTE) { $env:CODESENTINEL_UPDATE_REMOTE } else { "origin" }),
  [string]$Branch = $(if ($env:CODESENTINEL_UPDATE_BRANCH) { $env:CODESENTINEL_UPDATE_BRANCH } else { "" }),
  [string]$Tag = $(if ($env:CODESENTINEL_UPDATE_TAG) { $env:CODESENTINEL_UPDATE_TAG } else { "latest" }),
  [string]$Mode = $(if ($env:CODESENTINEL_UPDATE_MODE) { $env:CODESENTINEL_UPDATE_MODE } elseif ($env:CODESENTINEL_UPDATE_BRANCH) { "branch" } else { "tag" }),
  [switch]$AllowDirty
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $PSScriptRoot

function Fail([string]$Message) {
  Write-Host "[error] $Message"
  exit 1
}

function Normalize-TagRef([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    Fail "empty tag value"
  }
  $trimmed = $Value.Trim()
  if ($trimmed.StartsWith("v")) {
    return $trimmed
  }
  return "v$trimmed"
}

function Resolve-LatestTag([string]$RemoteUrl) {
  $lines = git ls-remote --tags --refs $RemoteUrl 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $lines) {
    return $null
  }
  $candidates = @()
  foreach ($line in $lines) {
    $parts = $line -split "\s+"
    if ($parts.Count -lt 2) {
      continue
    }
    $tag = ($parts[1] -replace '^refs/tags/', '').Trim()
    if ($tag -match '^v?(\d+)\.(\d+)\.(\d+)$') {
      $version = [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
      $candidates += [pscustomobject]@{ Tag = $tag; Version = $version }
    }
  }
  if (-not $candidates) {
    return $null
  }
  return ($candidates | Sort-Object Version, Tag | Select-Object -Last 1).Tag
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

if ($Mode -ieq "branch") {
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
} else {
  $remoteUrl = (git remote get-url $Remote 2>$null).Trim()
  if ([string]::IsNullOrWhiteSpace($remoteUrl)) {
    Fail "cannot resolve remote URL for $Remote."
  }

  Write-Host "[info] Fetching latest tags from $Remote ..."
  git fetch $Remote --tags
  if ($LASTEXITCODE -ne 0) {
    Fail "git fetch --tags failed."
  }

  $targetTag = $null
  if ([string]::IsNullOrWhiteSpace($Tag) -or $Tag -eq "latest") {
    $targetTag = Resolve-LatestTag $remoteUrl
  } else {
    $targetTag = Normalize-TagRef $Tag
  }

  if ([string]::IsNullOrWhiteSpace($targetTag)) {
    Write-Host "[warn] No stable tags found on remote; falling back to branch mode ($Branch)."
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
  } else {
    Write-Host "[info] Updating to tag $targetTag ..."
    git fetch $Remote "refs/tags/${targetTag}:refs/tags/${targetTag}"
    if ($LASTEXITCODE -ne 0) {
      Fail "git fetch for tag $targetTag failed."
    }
    git checkout --detach $targetTag
    if ($LASTEXITCODE -ne 0) {
      Fail "git checkout --detach $targetTag failed."
    }
  }
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
