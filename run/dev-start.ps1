param()

$RootDir = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $RootDir "run/dev.pid"
$LogDir = Join-Path $RootDir "logs"
$LogFile = Join-Path $LogDir "dev.log"
$ConfigPath = Join-Path $RootDir "config/config.json"
$ServerPort = 3990

if (Test-Path $PidFile) {
  $procId = Get-Content $PidFile -ErrorAction SilentlyContinue
  if ($procId) {
    try {
      Get-Process -Id $procId -ErrorAction Stop | Out-Null
      Write-Host "Already running (pid $procId)"
      exit 0
    } catch {}
  }
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
& (Join-Path $RootDir "run/windows-ensure-native.ps1")

if (-not (Test-Path $ConfigPath)) {
  $ConfigPath = Join-Path $RootDir "config/config.example.json"
}
if (Test-Path $ConfigPath) {
  try {
    $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    if ($cfg.server.port) {
      $ServerPort = [int]$cfg.server.port
    }
  } catch {}
}
$ApiBase = "http://127.0.0.1:$ServerPort"
$WsBase = "ws://127.0.0.1:$ServerPort"

$runner = @"
Set-Location -LiteralPath '$RootDir'
`$env:PORT = '$ServerPort'
`$env:VITE_API_BASE = '$ApiBase'
`$env:VITE_WS_BASE = '$WsBase'
if (-not `$env:CODESENTINEL_DEFAULT_USER) {
  `$env:CODESENTINEL_DEFAULT_USER = `$env:USERNAME
}
& pnpm dev *>> '$LogFile'
exit `$LASTEXITCODE
"@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($runner))
$proc = Start-Process -FilePath "powershell.exe" -ArgumentList @(
  "-NoLogo",
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
  $encoded
) -WorkingDirectory $RootDir -WindowStyle Hidden -PassThru
$proc.Id | Set-Content $PidFile
Start-Sleep -Seconds 2
try {
  Get-Process -Id $proc.Id -ErrorAction Stop | Out-Null
  Write-Host "Started (pid $($proc.Id))"
} catch {
  Write-Host "Failed to start. Check $LogFile"
  exit 1
}
