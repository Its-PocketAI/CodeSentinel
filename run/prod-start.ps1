param()

$RootDir = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $RootDir "run/prod.pid"
$LogDir = Join-Path $RootDir "logs"
$LogFile = Join-Path $LogDir "prod.log"

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

$runner = @"
Set-Location -LiteralPath '$RootDir'
`$env:CODESENTINEL_SERVE_WEB = '1'
`$env:NODE_ENV = 'production'
if (-not `$env:CODESENTINEL_DEFAULT_USER) {
  `$env:CODESENTINEL_DEFAULT_USER = `$env:USERNAME
}
& pnpm build *>> '$LogFile'
if (`$LASTEXITCODE -ne 0) {
  exit `$LASTEXITCODE
}
& pnpm start *>> '$LogFile'
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
