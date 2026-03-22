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

function Get-VsDevCmdPath() {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) {
    return $null
  }

  $path = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find Common7\Tools\VsDevCmd.bat 2>$null | Select-Object -First 1
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($path)) {
    return $null
  }

  $trimmed = $path.Trim()
  if (-not (Test-Path $trimmed)) {
    return $null
  }

  return $trimmed
}

$script:VsDevCmdPath = Get-VsDevCmdPath

function Invoke-PackageInstall([string]$Name, [string]$PackageDir) {
  Write-Host "[fix] Rebuilding $Name ..."

  $exitCode = 0
  if ($script:VsDevCmdPath) {
    Write-Host "[fix] Using Visual Studio build environment"
    $escapedVsDevCmd = $script:VsDevCmdPath.Replace('"', '""')
    $escapedPackageDir = $PackageDir.Replace('"', '""')
    $command = 'call "' + $escapedVsDevCmd + '" -arch=x64 && cd /d "' + $escapedPackageDir + '" && npm run install --verbose'
    & cmd.exe /d /s /c $command
    $exitCode = $LASTEXITCODE
  } else {
    Push-Location $PackageDir
    try {
      npm run install --verbose
      $exitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
  }

  if ($exitCode -ne 0) {
    throw "npm run install failed for $Name"
  }
}

function Repair-Package([string]$Name, [string]$Pattern, [string]$PackageSubdir, [string]$TestCode) {
  if (Test-NodeModule $TestCode) {
    Write-Host "[ok] $Name"
    return
  }

  $packageDir = Find-PnpmPackageDir $Pattern $PackageSubdir
  Invoke-PackageInstall $Name $packageDir

  if (-not (Test-NodeModule $TestCode)) {
    throw "$Name is still unavailable after rebuild."
  }
  Write-Host "[ok] $Name rebuilt"
}

function Get-NodePtyBinaryState([string]$PackageDir) {
  $releaseDir = Join-Path $PackageDir "build/Release"
  $debugDir = Join-Path $PackageDir "build/Debug"
  return [PSCustomObject]@{
    HasConpty = (Test-Path (Join-Path $releaseDir "conpty.node")) -or (Test-Path (Join-Path $debugDir "conpty.node"))
    HasWinpty = (Test-Path (Join-Path $releaseDir "pty.node")) -or (Test-Path (Join-Path $debugDir "pty.node"))
  }
}

function Ensure-NodePtyWindowsBinaries([string]$PackageDir) {
  $state = Get-NodePtyBinaryState $PackageDir
  if ($state.HasConpty) {
    Write-Host "[ok] node-pty PTY binaries (ConPTY)"
    return
  }
  if ($state.HasWinpty) {
    Write-Warning "node-pty is installed without conpty.node. Windows AI terminals will use winpty fallback."
    return
  }

  Invoke-PackageInstall "@homebridge/node-pty-prebuilt-multiarch" $PackageDir

  $state = Get-NodePtyBinaryState $PackageDir
  if ($state.HasConpty) {
    Write-Host "[ok] node-pty PTY binaries (ConPTY)"
    return
  }
  if ($state.HasWinpty) {
    Write-Warning "node-pty repaired with pty.node only. Windows AI terminals will use winpty fallback."
    return
  }

  Write-Warning "node-pty is installed but PTY binaries are unavailable. Windows AI terminals will fall back to exec mode."
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
Ensure-NodePtyWindowsBinaries $nodePtyDir
