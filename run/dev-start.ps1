param()

$RootDir = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $RootDir "run/dev.pid"
$LogDir = Join-Path $RootDir "logs"
$LogFile = Join-Path $LogDir "dev.log"

if (Test-Path $PidFile) {
  $pid = Get-Content $PidFile -ErrorAction SilentlyContinue
  if ($pid) {
    try {
      Get-Process -Id $pid -ErrorAction Stop | Out-Null
      Write-Host "Already running (pid $pid)"
      exit 0
    } catch {}
  }
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not $env:CODESENTINEL_DEFAULT_USER) {
  $env:CODESENTINEL_DEFAULT_USER = $env:USERNAME
}

$proc = Start-Process -FilePath "pnpm" -ArgumentList "dev" -WorkingDirectory $RootDir -NoNewWindow -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError $LogFile
$proc.Id | Set-Content $PidFile
Start-Sleep -Seconds 1
try {
  Get-Process -Id $proc.Id -ErrorAction Stop | Out-Null
  Write-Host "Started (pid $($proc.Id))"
} catch {
  Write-Host "Failed to start. Check $LogFile"
  exit 1
}
