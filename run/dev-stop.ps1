param()

$RootDir = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $RootDir "run/dev.pid"

if (-not (Test-Path $PidFile)) {
  Write-Host "Not running"
  exit 0
}

$pid = Get-Content $PidFile -ErrorAction SilentlyContinue
if (-not $pid) {
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  Write-Host "Not running"
  exit 0
}

try {
  Stop-Process -Id $pid -Force -ErrorAction Stop
} catch {}

Remove-Item $PidFile -ErrorAction SilentlyContinue
Write-Host "Stopped"
