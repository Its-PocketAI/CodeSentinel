param()

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $PSScriptRoot
$PnpmArgs = @("--filter", "@codesentinel/server", "exec", "node", "-e")

function Test-NodeModule([string]$Code) {
  & pnpm @PnpmArgs $Code | Out-Null
  return $LASTEXITCODE -eq 0
}

function Find-PnpmPackageDir([string]$Pattern, [string]$PackageSubdir) {
  $pkgRoot = Join-Path $RootDir "node_modules/.pnpm"
  $dir = Get-ChildItem $pkgRoot -Directory -Filter $Pattern | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $dir) {
    throw "Package directory not found for pattern: $Pattern"
  }
  return Join-Path $dir.FullName $PackageSubdir
}

function Repair-Package([string]$Name, [string]$Pattern, [string]$PackageSubdir, [string]$TestCode) {
  if (Test-NodeModule $TestCode) {
    Write-Host "[ok] $Name"
    return
  }

  $packageDir = Find-PnpmPackageDir $Pattern $PackageSubdir
  Write-Host "[fix] Rebuilding $Name ..."
  Push-Location $packageDir
  try {
    npm run install --verbose
    if ($LASTEXITCODE -ne 0) {
      throw "npm run install failed for $Name"
    }
  } finally {
    Pop-Location
  }

  if (-not (Test-NodeModule $TestCode)) {
    throw "$Name is still unavailable after rebuild."
  }
  Write-Host "[ok] $Name rebuilt"
}

Repair-Package `
  "better-sqlite3" `
  "better-sqlite3@*" `
  "node_modules/better-sqlite3" `
  "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.prepare('select 1').get(); db.close();"

Repair-Package `
  "@homebridge/node-pty-prebuilt-multiarch" `
  "@homebridge+node-pty-prebuilt-multiarch@*" `
  "node_modules/@homebridge/node-pty-prebuilt-multiarch" `
  "require('@homebridge/node-pty-prebuilt-multiarch');"

$nodePtyDir = Find-PnpmPackageDir "@homebridge+node-pty-prebuilt-multiarch@*" "node_modules/@homebridge/node-pty-prebuilt-multiarch"
$conptyRelease = Join-Path $nodePtyDir "build/Release/conpty.node"
$conptyDebug = Join-Path $nodePtyDir "build/Debug/conpty.node"
if ((Test-Path $conptyRelease) -or (Test-Path $conptyDebug)) {
  Write-Host "[ok] node-pty PTY binaries"
  exit 0
}

Write-Warning "node-pty is installed but conpty.node is unavailable. Windows AI terminals will fall back to exec mode."
