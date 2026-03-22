param()

$RootDir = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $RootDir "run/dev.pid"

if (-not (Test-Path $PidFile)) {
  Write-Host "Not running"
  exit 0
}

$procId = Get-Content $PidFile -ErrorAction SilentlyContinue
if (-not $procId) {
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  Write-Host "Not running"
  exit 0
}

try {
  Get-Process -Id $procId -ErrorAction Stop | Out-Null
  taskkill.exe /PID $procId /T /F | Out-Null
} catch {}

Remove-Item $PidFile -ErrorAction SilentlyContinue
Write-Host "Stopped"
