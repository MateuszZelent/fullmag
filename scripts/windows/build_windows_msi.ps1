$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$DistRoot = Join-Path $RepoRoot ".fullmag\dist"
$StageRoot = Join-Path $DistRoot "windows-msi-root"
$WixRoot = Join-Path $DistRoot "windows-msi-wix"
$ManifestPath = Join-Path $DistRoot "windows-msi-manifest.json"
$TargetTriple = "x86_64-pc-windows-msvc"
$ReleaseDir = Join-Path $RepoRoot "target\$TargetTriple\release"

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Import-VsEnvironment {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) {
    Write-Warning "vswhere.exe not found - assuming MSVC tools are already on PATH (e.g. inside container)."
    return
  }
  $vsPath = & $vswhere -latest -property installationPath 2>$null
  if (-not $vsPath) {
    throw "Visual Studio / Build Tools installation not found. Install VS Build Tools with the C++ workload."
  }
  $vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
  if (-not (Test-Path $vcvars)) {
    throw "vcvars64.bat not found at $vcvars"
  }
  cmd /c "`"$vcvars`" && set" | ForEach-Object {
    if ($_ -match "^(.+?)=(.*)$") {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
  }
  Write-Host "Imported MSVC environment from $vcvars"
}

function Ensure-Dir {
  param([string]$Path)
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Copy-Tree {
  param(
    [string]$Source,
    [string]$Destination
  )
  if (-not (Test-Path $Source)) {
    return
  }
  Ensure-Dir $Destination
  robocopy $Source $Destination /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed for $Source -> $Destination with exit code $LASTEXITCODE"
  }
}

function Copy-IfExists {
  param(
    [string]$Source,
    [string]$Destination
  )
  if (Test-Path $Source) {
    Ensure-Dir (Split-Path -Parent $Destination)
    Copy-Item -Force $Source $Destination
  }
}

function Copy-OrAliasLauncher {
  param(
    [string]$PrimarySource,
    [string]$FallbackSource,
    [string]$Destination
  )
  if (Test-Path $PrimarySource) {
    Ensure-Dir (Split-Path -Parent $Destination)
    Copy-Item -Force $PrimarySource $Destination
    return
  }
  if (Test-Path $FallbackSource) {
    Ensure-Dir (Split-Path -Parent $Destination)
    Copy-Item -Force $FallbackSource $Destination
  }
}

function Require-File {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    throw "Missing required file: $Path"
  }
}

function Write-VersionMetadata {
  param([string]$Path)
  $gitSha = (git -C $RepoRoot rev-parse HEAD).Trim()
  $gitShort = (git -C $RepoRoot rev-parse --short=12 HEAD).Trim()
  $builtAt = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
  $payload = @{
    product = "fullmag"
    artifact = "fullmag-windows-x86_64-msi"
    preproduction = $true
    git_sha = $gitSha
    git_short = $gitShort
    built_at_utc = $builtAt
  } | ConvertTo-Json -Depth 4
  Set-Content -Path $Path -Value $payload -Encoding UTF8
}

function Write-RuntimeManifests {
  param([string]$RuntimesRoot)
  $cpuDir = Join-Path $RuntimesRoot "cpu-reference"
  $fdmCudaDir = Join-Path $RuntimesRoot "fdm-cuda"
  Ensure-Dir $cpuDir
  Ensure-Dir $fdmCudaDir

  @'
{
  "family": "cpu-reference",
  "version": "0.1.0-preprod",
  "worker": "../../bin/fullmag-bin.exe",
  "engines": [
    { "backend": "fdm", "device": "cpu", "mode": "strict", "precision": "double", "public": true },
    { "backend": "fem", "device": "cpu", "mode": "strict", "precision": "double", "public": true }
  ]
}
'@ | Set-Content -Path (Join-Path $cpuDir "manifest.json") -Encoding UTF8

  @'
{
  "family": "fdm-cuda",
  "version": "0.1.0-preprod",
  "worker": "../../bin/fullmag-bin.exe",
  "engines": [
    { "backend": "fdm", "device": "gpu", "mode": "strict", "precision": "double", "public": true },
    { "backend": "fdm", "device": "gpu", "mode": "strict", "precision": "single", "public": false }
  ]
}
'@ | Set-Content -Path (Join-Path $fdmCudaDir "manifest.json") -Encoding UTF8
}

function Write-StageManifest {
  param([string]$Path)
  $manifest = [ordered]@{
    stage_root = $StageRoot
    generated_at_utc = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    bin = @(
      "bin/fullmag.exe",
      "bin/fullmag-api.exe",
      "bin/fullmag-ui.exe",
      "bin/fullmag-bin.exe"
    )
    runtimes = @(
      "runtimes/cpu-reference/manifest.json",
      "runtimes/fdm-cuda/manifest.json"
    )
    share = @(
      "share/version.json"
    )
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $Path -Encoding UTF8
}

function Test-StagedLayout {
  $required = @(
    (Join-Path $StageRoot "bin\fullmag.exe"),
    (Join-Path $StageRoot "bin\fullmag-api.exe"),
    (Join-Path $StageRoot "bin\fullmag-ui.exe"),
    (Join-Path $StageRoot "share\version.json"),
    (Join-Path $StageRoot "runtimes\cpu-reference\manifest.json"),
    (Join-Path $StageRoot "runtimes\fdm-cuda\manifest.json")
  )
  foreach ($path in $required) {
    Require-File $path
  }
}

function Harvest-Directory {
  param(
    [string]$Source,
    [string]$GroupName,
    [string]$OutFile
  )
  if (-not (Test-Path $Source)) {
    return
  }
  & heat.exe dir $Source `
    -cg $GroupName `
    -dr INSTALLDIR `
    -gg `
    -scom `
    -sreg `
    -sfrag `
    -srd `
    -var "var.StageRoot" `
    -out $OutFile
  if ($LASTEXITCODE -ne 0) {
    throw "heat.exe failed for $GroupName with exit code $LASTEXITCODE"
  }
}

Require-Command cargo
Require-Command rustup
Require-Command pnpm
Require-Command heat.exe
Require-Command candle.exe
Require-Command light.exe
Require-Command git

Import-VsEnvironment

Push-Location $RepoRoot
try {
  pnpm install --frozen-lockfile
  pnpm --dir apps/control-room build
  rustup target add $TargetTriple

  cargo build --release --target $TargetTriple -p fullmag-cli
  cargo build --release --target $TargetTriple -p fullmag-api
  cargo build --release --target $TargetTriple -p fullmag-desktop

  Remove-Item -Recurse -Force $StageRoot, $WixRoot -ErrorAction SilentlyContinue
  Ensure-Dir $StageRoot
  Ensure-Dir $WixRoot

  $binDir = Join-Path $StageRoot "bin"
  $libDir = Join-Path $StageRoot "lib"
  $pythonDir = Join-Path $StageRoot "python"
  $webDir = Join-Path $StageRoot "web"
  $runtimesDir = Join-Path $StageRoot "runtimes"
  $examplesDir = Join-Path $StageRoot "examples"
  $shareDir = Join-Path $StageRoot "share"
  $licensesDir = Join-Path $shareDir "licenses"

  Ensure-Dir $binDir
  Ensure-Dir $libDir
  Ensure-Dir $pythonDir
  Ensure-Dir $webDir
  Ensure-Dir $runtimesDir
  Ensure-Dir $examplesDir
  Ensure-Dir $licensesDir

  Copy-IfExists (Join-Path $ReleaseDir "fullmag.exe") (Join-Path $binDir "fullmag.exe")
  Copy-IfExists (Join-Path $ReleaseDir "fullmag-api.exe") (Join-Path $binDir "fullmag-api.exe")
  Copy-IfExists (Join-Path $ReleaseDir "fullmag-ui.exe") (Join-Path $binDir "fullmag-ui.exe")
  Copy-OrAliasLauncher (Join-Path $ReleaseDir "fullmag-bin.exe") (Join-Path $ReleaseDir "fullmag.exe") (Join-Path $binDir "fullmag-bin.exe")

  Get-ChildItem -Path $ReleaseDir -Filter "*.dll" -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item -Force $_.FullName (Join-Path $libDir $_.Name)
  }

  Copy-Tree (Join-Path $RepoRoot "apps\web\out") $webDir
  Copy-Tree (Join-Path $RepoRoot "examples") $examplesDir
  Copy-Tree (Join-Path $RepoRoot ".fullmag\local\python") $pythonDir

  if (Test-Path (Join-Path $RepoRoot "external_solvers\tetrax\logo_large.png")) {
    Ensure-Dir (Join-Path $shareDir "icons")
    Copy-Item -Force (Join-Path $RepoRoot "external_solvers\tetrax\logo_large.png") `
      (Join-Path $shareDir "icons\fullmag.png")
  }

  @'
Third-party license aggregation is not bundled yet in this preproduction artifact.
This MSI is for internal validation of the Windows install layout.
  '@ | Set-Content -Path (Join-Path $licensesDir "README.txt") -Encoding UTF8

  Write-VersionMetadata (Join-Path $shareDir "version.json")
  Write-RuntimeManifests $runtimesDir
  Write-StageManifest $ManifestPath
  Test-StagedLayout

  $productWxs = Join-Path $WixRoot "Product.wxs"
  @"
<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="Fullmag" Language="1033" Version="0.1.0" Manufacturer="Fullmag" UpgradeCode="F4E7E24A-BB4D-4C8E-BD4A-0C4C9B3AF001">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" />
    <MajorUpgrade DowngradeErrorMessage="A newer version of [ProductName] is already installed." />
    <MediaTemplate EmbedCab="yes" />
    <Property Id="WIXUI_INSTALLDIR" Value="INSTALLDIR" />
    <UIRef Id="WixUI_InstallDir" />
    <UIRef Id="WixUI_ErrorProgressText" />

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLDIR" Name="Fullmag" />
      </Directory>
      <Directory Id="ProgramMenuFolder">
        <Directory Id="ProgramMenuFullmag" Name="Fullmag" />
      </Directory>
    </Directory>

    <DirectoryRef Id="INSTALLDIR">
      <Component Id="PathComponent" Guid="3A8E48A0-6C63-4F89-9D6C-C6B1F77C1201">
        <Environment Id="AddFullmagBinToPath" Name="PATH" Action="set" Part="last" System="yes" Value="[INSTALLDIR]bin" />
        <RegistryValue Root="HKLM" Key="Software\Fullmag" Name="InstallPath" Type="string" Value="[INSTALLDIR]" KeyPath="yes" />
      </Component>
    </DirectoryRef>

    <DirectoryRef Id="ProgramMenuFullmag">
      <Component Id="StartMenuShortcutComponent" Guid="6D3BBAA4-64E6-40F8-8C39-76AE043F0C02">
        <Shortcut Id="FullmagShortcut" Name="Fullmag" Description="Micromagnetic simulation environment" Target="[INSTALLDIR]bin\fullmag.exe" Arguments="ui" WorkingDirectory="INSTALLDIR" />
        <RemoveFolder Id="RemoveFullmagProgramMenuDir" On="uninstall" />
        <RegistryValue Root="HKCU" Key="Software\Fullmag" Name="StartMenuShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </DirectoryRef>

    <Feature Id="Core" Title="Core" Level="1" Absent="disallow">
      <ComponentGroupRef Id="BinFiles" />
      <ComponentGroupRef Id="LibFiles" />
      <ComponentGroupRef Id="WebFiles" />
      <ComponentGroupRef Id="ShareFiles" />
      <ComponentRef Id="PathComponent" />
      <ComponentRef Id="StartMenuShortcutComponent" />
    </Feature>
    <Feature Id="PythonRuntime" Title="Python Runtime" Level="1">
      <ComponentGroupRef Id="PythonFiles" />
    </Feature>
    <Feature Id="CpuReference" Title="CPU Reference Runtime" Level="1">
      <ComponentGroupRef Id="RuntimeCpuReferenceFiles" />
    </Feature>
    <Feature Id="FdmCuda" Title="FDM CUDA Runtime" Level="1000">
      <ComponentGroupRef Id="RuntimeFdmCudaFiles" />
    </Feature>
    <Feature Id="Examples" Title="Examples" Level="1000">
      <ComponentGroupRef Id="ExampleFiles" />
    </Feature>
  </Product>
</Wix>
"@ | Set-Content -Path $productWxs -Encoding UTF8

  Harvest-Directory (Join-Path $StageRoot "bin") "BinFiles" (Join-Path $WixRoot "BinFiles.wxs")
  Harvest-Directory (Join-Path $StageRoot "lib") "LibFiles" (Join-Path $WixRoot "LibFiles.wxs")
  Harvest-Directory (Join-Path $StageRoot "web") "WebFiles" (Join-Path $WixRoot "WebFiles.wxs")
  Harvest-Directory (Join-Path $StageRoot "share") "ShareFiles" (Join-Path $WixRoot "ShareFiles.wxs")
  Harvest-Directory (Join-Path $StageRoot "python") "PythonFiles" (Join-Path $WixRoot "PythonFiles.wxs")
  Harvest-Directory (Join-Path $StageRoot "runtimes\cpu-reference") "RuntimeCpuReferenceFiles" (Join-Path $WixRoot "RuntimeCpuReferenceFiles.wxs")
  Harvest-Directory (Join-Path $StageRoot "runtimes\fdm-cuda") "RuntimeFdmCudaFiles" (Join-Path $WixRoot "RuntimeFdmCudaFiles.wxs")
  Harvest-Directory (Join-Path $StageRoot "examples") "ExampleFiles" (Join-Path $WixRoot "ExampleFiles.wxs")

  $wixSources = Get-ChildItem -Path $WixRoot -Filter "*.wxs" | Select-Object -ExpandProperty FullName
  $wixObjDir = Join-Path $WixRoot "obj"
  Ensure-Dir $wixObjDir
  & candle.exe -nologo -arch x64 "-dStageRoot=$StageRoot" "-out" "$wixObjDir\" $wixSources
  if ($LASTEXITCODE -ne 0) {
    throw "candle.exe failed with exit code $LASTEXITCODE"
  }

  $wixObjs = Get-ChildItem -Path $wixObjDir -Filter "*.wixobj" | Select-Object -ExpandProperty FullName
  $msiPath = Join-Path $DistRoot "fullmag.msi"
  & light.exe -nologo -ext WixUIExtension -out $msiPath $wixObjs
  if ($LASTEXITCODE -ne 0) {
    throw "light.exe failed with exit code $LASTEXITCODE"
  }

  Write-Host "Created Windows MSI:"
  Write-Host "  $msiPath"
  Write-Host "Stage manifest:"
  Write-Host "  $ManifestPath"
}
finally {
  Pop-Location
}
