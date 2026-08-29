[CmdletBinding()]
param(
  [string]$Version
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$DistRoot = Join-Path $RepoRoot ".fullmag\dist"
$StageRoot = Join-Path $DistRoot "windows-msi-root"
$WixRoot = Join-Path $DistRoot "windows-msi-wix"
$ManifestPath = Join-Path $DistRoot "windows-msi-manifest.json"
$TargetTriple = "x86_64-pc-windows-msvc"
$RepoDriveRoot = [System.IO.Path]::GetPathRoot($RepoRoot)
$TargetRoot = if ($env:CARGO_TARGET_DIR) {
  [System.IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
} else {
  Join-Path $RepoDriveRoot "fullmag-build\cargo-targets\fullmag-windows-msi"
}
$ReleaseDir = Join-Path $TargetRoot "$TargetTriple\release"
$ProductVersion = if ($Version) { $Version } elseif ($env:FULLMAG_WINDOWS_MSI_VERSION) { $env:FULLMAG_WINDOWS_MSI_VERSION } else { "0.1.0" }
if ($ProductVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
  throw "MSI version must be a numeric x.y.z value, got $ProductVersion"
}
$BuildCuda = $env:FULLMAG_WINDOWS_MSI_CUDA -eq "1"

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
  $vsPath = & $vswhere -products '*' -latest -property installationPath 2>$null
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

function Find-NativeFdmDll {
  $searchRoot = Join-Path $TargetRoot "$TargetTriple\release\build"
  $candidates = @(Get-ChildItem -LiteralPath $searchRoot -Directory -Filter "fullmag-fdm-sys-*" -ErrorAction SilentlyContinue |
    ForEach-Object {
      $candidate = Join-Path $_.FullName "out\native-build\backends\fdm\fullmag_fdm.dll"
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { Get-Item -LiteralPath $candidate }
    })
  if ($candidates.Count -ne 1) {
    throw "CUDA MSI build must produce exactly one canonical fullmag_fdm.dll below $searchRoot; found $($candidates.Count)"
  }
  return $candidates[0]
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
    product_version = $ProductVersion
    release_channel = if ($env:FULLMAG_RELEASE_CHANNEL) { $env:FULLMAG_RELEASE_CHANNEL } else { "internal" }
    git_sha = $gitSha
    git_short = $gitShort
    source_identity = $sourceIdentity
    build_features = if ($BuildCuda) { @("cuda") } else { @() }
    python_runtime = "external-python-3.12-or-newer"
    node_runtime = "external-node-24.18-or-newer"
    built_at_utc = $builtAt
  } | ConvertTo-Json -Depth 4
  Set-Content -Path $Path -Value $payload -Encoding UTF8
}

function Write-RuntimeManifests {
  param([string]$RuntimesRoot)
  $cpuDir = Join-Path $RuntimesRoot "cpu-reference"
  $fdmCudaDir = Join-Path $RuntimesRoot "fdm-cuda"
  Ensure-Dir $cpuDir
  if ($BuildCuda) { Ensure-Dir $fdmCudaDir }

  @"
{
  "family": "cpu-reference",
  "version": "$ProductVersion",
  "worker": "../../bin/fullmag-bin.exe",
  "engines": [
    { "backend": "fdm", "device": "cpu", "mode": "strict", "precision": "double", "public": true }
  ]
}
"@ | Set-Content -Path (Join-Path $cpuDir "manifest.json") -Encoding UTF8

  if ($BuildCuda) {
  @"
{
  "family": "fdm-cuda",
  "version": "$ProductVersion",
  "worker": "../../bin/fullmag-bin.exe",
  "engines": [
    { "backend": "fdm", "device": "gpu", "mode": "strict", "precision": "double", "public": true },
    { "backend": "fdm", "device": "gpu", "mode": "strict", "precision": "single", "public": false }
  ]
}
"@ | Set-Content -Path (Join-Path $fdmCudaDir "manifest.json") -Encoding UTF8
  }
}

function Write-StageManifest {
  param([string]$Path)
  $runtimePaths = @("runtimes/cpu-reference/manifest.json")
  if ($BuildCuda) { $runtimePaths += "runtimes/fdm-cuda/manifest.json" }
  $manifest = [ordered]@{
    schema_version = 2
    stage_root = $StageRoot
    generated_at_utc = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    product_version = $ProductVersion
    source_identity = $sourceIdentity
    build_features = if ($BuildCuda) { @("cuda") } else { @() }
    bin = @(
      "bin/fullmag.exe",
      "bin/fullmag-api.exe",
      "bin/fullmag-ui.exe",
      "bin/fullmag-bin.exe"
    )
    runtimes = $runtimePaths
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
    (Join-Path $StageRoot "web\index.html"),
    (Join-Path $StageRoot "python\site-packages\fullmag\__init__.py"),
    (Join-Path $StageRoot "share\version.json"),
    (Join-Path $StageRoot "runtimes\cpu-reference\manifest.json")
  )
  if ($BuildCuda) { $required += (Join-Path $StageRoot "runtimes\fdm-cuda\manifest.json") }
  foreach ($path in $required) {
    Require-File $path
  }
}

function Harvest-Directory {
  param(
    [string]$Source,
    [string]$GroupName,
    [string]$DestinationDirectoryId,
    [string]$OutFile
  )
  $files = if (Test-Path -LiteralPath $Source) {
    Get-ChildItem -LiteralPath $Source -Force -Recurse -File -ErrorAction SilentlyContinue
  } else {
    @()
  }
  if (-not $files) {
    @"
<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Fragment>
    <ComponentGroup Id="$GroupName" />
  </Fragment>
</Wix>
"@ | Set-Content -Path $OutFile -Encoding UTF8
    return
  }
  & heat.exe dir $Source `
    -cg $GroupName `
    -dr $DestinationDirectoryId `
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
  $wix = Get-Content -Path $OutFile -Raw
  $wix = [regex]::Replace($wix, 'Id="(?<kind>cmp|fil|dir)(?<value>[^"]+)"', {
    param($match)
    'Id="' + $GroupName + '_' + $match.Groups['kind'].Value + $match.Groups['value'].Value + '"'
  })
  $sourceRelativePath = $Source.Substring($StageRoot.Length).TrimStart('\').Replace('/', '\')
  $sourcePrefix = '$(var.StageRoot)\'
  $wix = $wix.Replace($sourcePrefix, $sourcePrefix + $sourceRelativePath + '\')
  Set-Content -Path $OutFile -Value $wix -Encoding UTF8
}

Require-Command cargo
Require-Command rustup
Require-Command node
Require-Command pnpm
Require-Command python
Require-Command heat.exe
Require-Command candle.exe
Require-Command light.exe
Require-Command git

$PinnedPnpmVersion = "10.8.1"
$resolvedPnpmVersion = (& pnpm --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $resolvedPnpmVersion -ne $PinnedPnpmVersion) {
  throw "Pinned pnpm validation failed; expected $PinnedPnpmVersion, got $resolvedPnpmVersion"
}
$nodeVersion = (& node --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v24\.(1[89]|2[0-9]|[3-9][0-9])(?:\.[0-9]+)?$') {
  throw "Fullmag release requires Node 24.18.x through 24.99.x, got $nodeVersion"
}

$identityOutput = (& python (Join-Path $RepoRoot "scripts\capture_source_snapshot_identity.py") --repo-root $RepoRoot --ignore-non-runtime-dirty 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) {
  throw "Fullmag source identity capture failed with exit code ${LASTEXITCODE}: $identityOutput"
}
try {
  $sourceIdentity = $identityOutput | ConvertFrom-Json
} catch {
  throw "Fullmag source identity capture returned invalid JSON: $identityOutput"
}
if ([string]$sourceIdentity.head_commit_full -notmatch '^[0-9a-f]{40}$' -or
    [string]$sourceIdentity.source_snapshot_sha256 -notmatch '^[0-9a-f]{64}$' -or
    $sourceIdentity.source_snapshot_dirty -isnot [bool]) {
  throw "Fullmag source identity is incomplete or invalid"
}
$env:FULLMAG_SOURCE_GIT_COMMIT = [string]$sourceIdentity.head_commit_full
$env:FULLMAG_SOURCE_WORKTREE_STATE = if ($sourceIdentity.source_snapshot_dirty) { "dirty" } else { "clean" }
$env:FULLMAG_SOURCE_SNAPSHOT_SHA256 = [string]$sourceIdentity.source_snapshot_sha256
$env:CARGO_TARGET_DIR = $TargetRoot
Ensure-Dir $TargetRoot

if ($BuildCuda) {
  Require-Command nvcc
  $env:CUDACXX = (Get-Command nvcc).Source
}

Import-VsEnvironment

Push-Location $RepoRoot
try {
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm install failed with exit code $LASTEXITCODE"
  }
  $env:FULLMAG_CONTROL_ROOM_STATIC_EXPORT = "1"
  pnpm --dir apps/control-room build
  if ($LASTEXITCODE -ne 0) {
    throw "Control Room build failed with exit code $LASTEXITCODE"
  }
  Remove-Item Env:FULLMAG_CONTROL_ROOM_STATIC_EXPORT -ErrorAction SilentlyContinue
  rustup target add $TargetTriple
  if ($LASTEXITCODE -ne 0) {
    throw "rustup target add failed with exit code $LASTEXITCODE"
  }

  $launcherBuildArgs = @("build", "--locked", "--release", "--target", $TargetTriple, "-p", "fullmag-cli")
  if ($BuildCuda) { $launcherBuildArgs += @("--features", "cuda") }
  & cargo @launcherBuildArgs
  if ($LASTEXITCODE -ne 0) {
    throw "fullmag-cli build failed with exit code $LASTEXITCODE"
  }
  $apiBuildArgs = @("build", "--locked", "--release", "--target", $TargetTriple, "-p", "fullmag-api")
  if ($BuildCuda) { $apiBuildArgs += @("--features", "cuda") }
  & cargo @apiBuildArgs
  if ($LASTEXITCODE -ne 0) {
    throw "fullmag-api build failed with exit code $LASTEXITCODE"
  }
  & cargo build --locked --release --target $TargetTriple -p fullmag-desktop
  if ($LASTEXITCODE -ne 0) {
    throw "fullmag-desktop build failed with exit code $LASTEXITCODE"
  }
  & python -m pip install --disable-pip-version-check --quiet build
  if ($LASTEXITCODE -ne 0) { throw "Python build frontend installation failed with exit code $LASTEXITCODE" }
  & python -m build packages/fullmag-py
  if ($LASTEXITCODE -ne 0) { throw "Python wheel build failed with exit code $LASTEXITCODE" }

  Remove-Item -Recurse -Force $StageRoot, $WixRoot -ErrorAction SilentlyContinue
  Ensure-Dir $StageRoot
  Ensure-Dir $WixRoot

  $binDir = Join-Path $StageRoot "bin"
  $libDir = Join-Path $StageRoot "lib"
  $pythonDir = Join-Path $StageRoot "python"
  $pythonSiteDir = Join-Path $pythonDir "site-packages"
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

  foreach ($binary in @("fullmag.exe", "fullmag-api.exe", "fullmag-ui.exe")) {
    $sourceBinary = Join-Path $ReleaseDir $binary
    Require-File $sourceBinary
    Copy-Item -Force $sourceBinary (Join-Path $binDir $binary)
  }
  Copy-OrAliasLauncher (Join-Path $ReleaseDir "fullmag-bin.exe") (Join-Path $ReleaseDir "fullmag.exe") (Join-Path $binDir "fullmag-bin.exe")
  Require-File (Join-Path $binDir "fullmag-bin.exe")

  Get-ChildItem -Path $ReleaseDir -Filter "*.dll" -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item -Force $_.FullName (Join-Path $libDir $_.Name)
  }
  if ($BuildCuda) {
    $nativeFdmDll = Find-NativeFdmDll
    Copy-Item -Force $nativeFdmDll.FullName (Join-Path $libDir "fullmag_fdm.dll")
  }

  Require-File (Join-Path $RepoRoot "apps\control-room\out\index.html")
  Copy-Tree (Join-Path $RepoRoot "apps\control-room\out") $webDir
  Copy-Item -Force (Join-Path $RepoRoot "apps\control-room\dev-server.mjs") (Join-Path $webDir "dev-server.mjs")
  Ensure-Dir (Join-Path $webDir "scripts")
  Copy-Item -Force (Join-Path $RepoRoot "apps\control-room\scripts\resolve-pnpm-invocation.mjs") (Join-Path $webDir "scripts\resolve-pnpm-invocation.mjs")
  Copy-Tree (Join-Path $RepoRoot "examples") $examplesDir
  $wheel = Get-ChildItem -LiteralPath (Join-Path $RepoRoot "packages\fullmag-py\dist") -Filter "*.whl" -File |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if (-not $wheel) { throw "Python wheel was not produced under packages\fullmag-py\dist" }
  Ensure-Dir $pythonSiteDir
  Copy-Item -Force $wheel.FullName (Join-Path $pythonDir $wheel.Name)
  & python -m pip install --disable-pip-version-check --target $pythonSiteDir $wheel.FullName
  if ($LASTEXITCODE -ne 0) { throw "staging Python wheel dependencies failed with exit code $LASTEXITCODE" }
  & python -c "import sys; sys.path.insert(0, r'$pythonSiteDir'); import fullmag"
  if ($LASTEXITCODE -ne 0) { throw "staged Python package import smoke failed with exit code $LASTEXITCODE" }

  if (Test-Path (Join-Path $RepoRoot "external_solvers\tetrax\logo_large.png")) {
    Ensure-Dir (Join-Path $shareDir "icons")
    Copy-Item -Force (Join-Path $RepoRoot "external_solvers\tetrax\logo_large.png") `
      (Join-Path $shareDir "icons\fullmag.png")
  }

  @"
Fullmag Windows MSI license inventory.

This artifact carries the runtime's Python wheel and JavaScript/Rust lockfiles
used to reproduce dependency versions. Third-party license text is not
automatically generated by this script; review the dependency lockfiles before
redistribution outside the internal release channel.
"@ | Set-Content -Path (Join-Path $licensesDir "README.txt") -Encoding UTF8

  Write-VersionMetadata (Join-Path $shareDir "version.json")
  Write-RuntimeManifests $runtimesDir
  Write-StageManifest $ManifestPath
  Test-StagedLayout

  $fdmCudaDirectoryXml = if ($BuildCuda) {
    '            <Directory Id="RuntimeFdmCudaDir" Name="fdm-cuda" />'
  } else { "" }
  $fdmCudaFeatureXml = if ($BuildCuda) {
    @"
    <Feature Id="FdmCuda" Title="FDM CUDA Runtime" Level="1000">
      <ComponentGroupRef Id="RuntimeFdmCudaFiles" />
    </Feature>
"@
  } else { "" }
  $productWxs = Join-Path $WixRoot "Product.wxs"
  @"
<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="Fullmag" Language="1033" Version="$ProductVersion" Manufacturer="Fullmag" UpgradeCode="F4E7E24A-BB4D-4C8E-BD4A-0C4C9B3AF001">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" />
    <MajorUpgrade DowngradeErrorMessage="A newer version of [ProductName] is already installed." />
    <MediaTemplate EmbedCab="yes" />
    <Property Id="WIXUI_INSTALLDIR" Value="INSTALLDIR" />
    <UIRef Id="WixUI_InstallDir" />
    <UIRef Id="WixUI_ErrorProgressText" />

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLDIR" Name="Fullmag">
          <Directory Id="BinDir" Name="bin" />
          <Directory Id="LibDir" Name="lib" />
          <Directory Id="PythonDir" Name="python" />
          <Directory Id="WebDir" Name="web" />
          <Directory Id="RuntimesDir" Name="runtimes">
            <Directory Id="RuntimeCpuReferenceDir" Name="cpu-reference" />
$fdmCudaDirectoryXml
          </Directory>
          <Directory Id="ExamplesDir" Name="examples" />
          <Directory Id="ShareDir" Name="share" />
        </Directory>
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
$fdmCudaFeatureXml
    <Feature Id="Examples" Title="Examples" Level="1000">
      <ComponentGroupRef Id="ExampleFiles" />
    </Feature>
  </Product>
</Wix>
"@ | Set-Content -Path $productWxs -Encoding UTF8

  Harvest-Directory (Join-Path $StageRoot "bin") "BinFiles" "BinDir" (Join-Path $WixRoot "BinFiles.wxs")
  Harvest-Directory (Join-Path $StageRoot "lib") "LibFiles" "LibDir" (Join-Path $WixRoot "LibFiles.wxs")
  Harvest-Directory (Join-Path $StageRoot "web") "WebFiles" "WebDir" (Join-Path $WixRoot "WebFiles.wxs")
  Harvest-Directory (Join-Path $StageRoot "share") "ShareFiles" "ShareDir" (Join-Path $WixRoot "ShareFiles.wxs")
  Harvest-Directory (Join-Path $StageRoot "python") "PythonFiles" "PythonDir" (Join-Path $WixRoot "PythonFiles.wxs")
  Harvest-Directory (Join-Path $StageRoot "runtimes\cpu-reference") "RuntimeCpuReferenceFiles" "RuntimeCpuReferenceDir" (Join-Path $WixRoot "RuntimeCpuReferenceFiles.wxs")
  Harvest-Directory (Join-Path $StageRoot "runtimes\fdm-cuda") "RuntimeFdmCudaFiles" "RuntimeFdmCudaDir" (Join-Path $WixRoot "RuntimeFdmCudaFiles.wxs")
  Harvest-Directory (Join-Path $StageRoot "examples") "ExampleFiles" "ExamplesDir" (Join-Path $WixRoot "ExampleFiles.wxs")

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
