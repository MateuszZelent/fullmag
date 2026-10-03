[CmdletBinding()]
param(
  [string]$Version
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$TargetTriple = "x86_64-pc-windows-msvc"
$ProductVersion = if ($Version) { $Version } elseif ($env:FULLMAG_WINDOWS_MSI_VERSION) { $env:FULLMAG_WINDOWS_MSI_VERSION } else { "0.1.0" }
if ($ProductVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
  throw "MSI version must be a numeric x.y.z value, got $ProductVersion"
}
$BuildCuda = $env:FULLMAG_WINDOWS_MSI_CUDA -eq "1"
. (Join-Path $PSScriptRoot "native_fem_package.ps1")
. (Join-Path $PSScriptRoot "python_package.ps1")
$femMode = if ($env:FULLMAG_WINDOWS_MSI_FEM) { $env:FULLMAG_WINDOWS_MSI_FEM } else { "cpu" }
$BuildPlan = Get-FullmagMsiBuildPlan -FemMode $femMode -Cuda:$BuildCuda `
  -DependencyPrefix $env:FULLMAG_FEM_DEPENDENCY_PREFIX -PrebuiltFemDirectory $env:FULLMAG_FEM_LIB_DIR
$BuildFeatures = @($BuildPlan.features)
. (Join-Path $PSScriptRoot "fullmag_storage.ps1")
$StorageProfile = $BuildPlan.storage_profile
if ($env:FULLMAG_STORAGE_MANAGED_ENTRY -ne "1") {
  $managedArguments = if ($Version) { @("-Version", $Version) } else { @() }
  $managedExitCode = Invoke-FullmagStorageManagedScript -RepoRoot $RepoRoot `
    -Profile $StorageProfile -ScriptPath $PSCommandPath -Arguments $managedArguments
  exit $managedExitCode
}
$StorageLayout = Resolve-FullmagStorageLayout -RepoRoot $RepoRoot -Profile $StorageProfile
Set-FullmagStorageEnvironment -Layout $StorageLayout
$BuildRoot = [string]$StorageLayout.build_root
$TargetRoot = [string]$StorageLayout.env.CARGO_TARGET_DIR
$ReleaseDir = Join-Path $TargetRoot "$TargetTriple\release"
$DistRoot = Join-Path ([string]$StorageLayout.runs_root) ("windows-msi-" + [Guid]::NewGuid().ToString("N"))
$StageRoot = Join-Path $DistRoot "stage"
$WixRoot = Join-Path $DistRoot "wix"
$ManifestPath = Join-Path $DistRoot "windows-msi-manifest.json"
$WheelRoot = Join-Path $DistRoot "python-wheels"
$nativeFdmBuildRoot = if ($env:FULLMAG_FDM_NATIVE_BUILD_ROOT) {
  [System.IO.Path]::GetFullPath($env:FULLMAG_FDM_NATIVE_BUILD_ROOT)
} else { Join-Path $BuildRoot "native" }
$null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $TargetRoot -Label "MSI Cargo target" -Parent $BuildRoot
$null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $nativeFdmBuildRoot -Label "MSI native FDM build" -Parent $BuildRoot
$null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $DistRoot -Label "MSI run" -Parent ([string]$StorageLayout.runs_root)
$nativeFemBuildRoot = Join-Path $BuildRoot "native-fem"
$null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $nativeFemBuildRoot -Label "MSI native FEM build" -Parent $BuildRoot
$env:FULLMAG_FDM_NATIVE_BUILD_ROOT = $nativeFdmBuildRoot
$null = Prepare-FullmagStorageLinks -RepoRoot $RepoRoot -Profile $StorageProfile -Frontend

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
  $vsPath = & $vswhere -products '*' -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
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

function Get-MsiDependencyRoots {
  param([string]$RedistRoot, [string]$CudaCompiler, [string[]]$ExtraRoots, [switch]$Cuda)
  $roots = @()
  if ($RedistRoot) {
    $x64Root = Join-Path $RedistRoot "x64"
    if (-not (Test-Path -LiteralPath $x64Root -PathType Container)) {
      throw "MSVC x64 redist directory is missing: $x64Root"
    }
    $roots += @(Get-ChildItem -LiteralPath $x64Root -Directory | Where-Object {
      $_.Name -match '^Microsoft\.VC[0-9]+\.(CRT|OpenMP|CXXAMP)$'
    } | Select-Object -ExpandProperty FullName)
  }
  if ($Cuda) {
    if (-not $CudaCompiler -or -not (Test-Path -LiteralPath $CudaCompiler -PathType Leaf)) {
      throw "CUDA compiler path is required for runtime dependency discovery"
    }
    $cudaBin = Split-Path -Parent ([System.IO.Path]::GetFullPath($CudaCompiler))
    $roots += $cudaBin
    $cudaX64 = Join-Path $cudaBin "x64"
    if (Test-Path -LiteralPath $cudaX64 -PathType Container) { $roots += $cudaX64 }
  }
  foreach ($root in @($ExtraRoots)) {
    if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root -PathType Container)) {
      throw "Declared MSI dependency directory is missing: $root"
    }
    $roots += [System.IO.Path]::GetFullPath($root)
  }
  $roots | Sort-Object -Unique
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
  $candidates = @(@("Release\fullmag_fdm.dll", "fullmag_fdm.dll") |
    ForEach-Object {
      $candidate = Join-Path (Join-Path $nativeFdmBuildRoot "backends\fdm") $_
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { Get-Item -LiteralPath $candidate }
    })
  if ($candidates.Count -ne 1) {
    throw "CUDA MSI build must produce exactly one canonical fullmag_fdm.dll below $nativeFdmBuildRoot; found $($candidates.Count)"
  }
  return $candidates[0]
}

function Require-File {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    throw "Missing required file: $Path"
  }
}

function Copy-RuntimeDllSet {
  param([string[]]$SourcePaths, [string]$BinDirectory)
  # Validate the complete set before copying; a basename conflict must not
  # silently select a different runtime dependency.
  $sources = @{}
  foreach ($sourcePath in $SourcePaths) {
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      throw "Runtime DLL is missing: $sourcePath"
    }
    $source = Get-Item -LiteralPath $sourcePath
    if ($source.Extension -ine ".dll" -or $source.Length -eq 0) {
      throw "Runtime DLL must be a nonempty .dll file: $sourcePath"
    }
    $hash = (Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($sources.ContainsKey($source.Name) -and $sources[$source.Name].sha256 -ne $hash) {
      throw "Conflicting runtime DLL basename: $($source.Name)"
    }
    $sources[$source.Name] = @{ source = $source.FullName; sha256 = $hash }
  }
  foreach ($name in $sources.Keys) {
    $destination = Join-Path $BinDirectory $name
    if (Test-Path -LiteralPath $destination) {
      if (-not (Test-Path -LiteralPath $destination -PathType Leaf) -or
          (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sources[$name].sha256) {
        throw "Conflicting staged runtime DLL: $name"
      }
    }
  }
  foreach ($name in @($sources.Keys | Sort-Object)) {
    $destination = Join-Path $BinDirectory $name
    Copy-Item -LiteralPath $sources[$name].source -Destination $destination -Force
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sources[$name].sha256) {
      throw "Staged runtime DLL hash mismatch: $name"
    }
    [ordered]@{ path = "bin/$name"; sha256 = $sources[$name].sha256 }
  }
}

function Write-MsiArtifactLocations {
  param([string]$MsiPath, [string]$StageManifestPath)
  foreach ($path in @($MsiPath, $StageManifestPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -eq 0) {
      throw "MSI output must be a nonempty file: $path"
    }
  }
  if ($env:GITHUB_OUTPUT) {
    Add-Content -LiteralPath $env:GITHUB_OUTPUT -Encoding UTF8 -Value @(
      "msi_path=$MsiPath", "manifest_path=$StageManifestPath"
    )
  }
  Write-Host "Created Windows MSI: $MsiPath"
  Write-Host "Stage manifest: $StageManifestPath"
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
    build_features = $BuildFeatures
    native_fem = $nativeFemAssembly
    runtime_dlls = @($runtimeDllInventory)
    pe_dependency_audit = $peDependencyAudit
    pe_dependency_plan = $peDependencyPlan
    python_runtime = $pythonRuntimeInventory
    python_pe_dependency_audit = $pythonPeDependencyAudit
    python_pe_dependency_plan = $pythonPePlan
    python_native_dependency_audit = $pythonNativeDependencyAudit
    python_packages = $pythonPackageInventory
    node_runtime = $nodeRuntimeInventory
    built_at_utc = $builtAt
  } | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($Path, $payload, [System.Text.UTF8Encoding]::new($false))
}

function Write-RuntimeManifests {
  param([string]$RuntimesRoot)
  $cpuDir = Join-Path $RuntimesRoot "cpu-reference"
  $fdmCudaDir = Join-Path $RuntimesRoot "fdm-cuda"
  Ensure-Dir $cpuDir
  if ($BuildCuda) { Ensure-Dir $fdmCudaDir }

  $cpuManifest = @"
{
  "family": "cpu-reference",
  "version": "$ProductVersion",
  "worker": "../../bin/fullmag-bin.exe",
  "engines": [
    { "backend": "fdm", "device": "cpu", "mode": "strict", "precision": "double", "public": true }
  ]
}
"@
  [System.IO.File]::WriteAllText((Join-Path $cpuDir "manifest.json"), $cpuManifest, [System.Text.UTF8Encoding]::new($false))

  if ($BuildCuda) {
  $cudaManifest = @"
{
  "family": "fdm-cuda",
  "version": "$ProductVersion",
  "worker": "../../bin/fullmag-bin.exe",
  "engines": [
    { "backend": "fdm", "device": "gpu", "mode": "strict", "precision": "double", "public": true },
    { "backend": "fdm", "device": "gpu", "mode": "strict", "precision": "single", "public": false }
  ]
}
"@
  [System.IO.File]::WriteAllText((Join-Path $fdmCudaDir "manifest.json"), $cudaManifest, [System.Text.UTF8Encoding]::new($false))
  }
  Write-FullmagMsiFemRuntimeManifests -Plan $BuildPlan -RuntimesRoot $RuntimesRoot -Version $ProductVersion
}

function Write-StageManifest {
  param([string]$Path)
  $runtimePaths = @("runtimes/cpu-reference/manifest.json")
  if ($BuildCuda) { $runtimePaths += "runtimes/fdm-cuda/manifest.json" }
  if ($BuildPlan.fem_enabled) { $runtimePaths += "runtimes/fem-cpu-native/manifest.json" }
  if ($BuildPlan.fem_cuda) { $runtimePaths += "runtimes/fem-gpu/manifest.json" }
  $manifest = [ordered]@{
    schema_version = 2
    stage_root = $StageRoot
    generated_at_utc = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    product_version = $ProductVersion
    source_identity = $sourceIdentity
    build_features = $BuildFeatures
    native_fem = $nativeFemAssembly
    bin = @(
      "bin/fullmag.exe",
      "bin/fullmag-api.exe",
      "bin/fullmag-api-accepted-worker.exe",
      "bin/fullmag-api-accepted-supervisor.exe",
      "bin/fullmag-api-accepted-scheduler.exe",
      "bin/fullmag-runtime-service.exe",
      "bin/fullmag-api-resource-pool.exe",
      "bin/fullmag-api-accepted-fem-preparer.exe",
      "bin/fullmag-api-accepted-fem-preparation-supervisor.exe",
      "bin/fullmag-api-accepted-fem-preparation-scheduler.exe",
      "bin/fullmag-api-preparation-resource-pool.exe",
      "bin/fullmag-api-preparation-retry.exe",
      "bin/fullmag-ui.exe",
      "bin/fullmag-bin.exe",
      "bin/node.exe"
    )
    runtime_dlls = @($runtimeDllInventory)
    pe_dependency_audit = $peDependencyAudit
    pe_dependency_plan = $peDependencyPlan
    node_runtime = $nodeRuntimeInventory
    runtimes = $runtimePaths
    python_runtime = $pythonRuntimeInventory
    python_pe_dependency_audit = $pythonPeDependencyAudit
    python_pe_dependency_plan = $pythonPePlan
    python_native_dependency_audit = $pythonNativeDependencyAudit
    python_packages = $pythonPackageInventory
    share = @(
      "share/version.json",
      "share/licenses/node-LICENSE.txt"
      "share/licenses/python-LICENSE.txt"
    )
  }
  [System.IO.File]::WriteAllText($Path, ($manifest | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))
}

function Test-StagedLayout {
  $required = @(
    (Join-Path $StageRoot "bin\fullmag.exe"),
    (Join-Path $StageRoot "bin\node.exe"),
    (Join-Path $StageRoot "share\licenses\node-LICENSE.txt"),
    (Join-Path $StageRoot "bin\fullmag-api.exe"),
    (Join-Path $StageRoot "bin\fullmag-api-accepted-worker.exe"),
    (Join-Path $StageRoot "bin\fullmag-api-accepted-supervisor.exe"),
    (Join-Path $StageRoot "bin\fullmag-api-accepted-scheduler.exe"),
    (Join-Path $StageRoot "bin\fullmag-runtime-service.exe"),
    (Join-Path $StageRoot "bin\fullmag-api-resource-pool.exe"),
    (Join-Path $StageRoot "bin\fullmag-api-accepted-fem-preparer.exe"),
    (Join-Path $StageRoot "bin\fullmag-api-accepted-fem-preparation-supervisor.exe"),
    (Join-Path $StageRoot "bin\fullmag-api-accepted-fem-preparation-scheduler.exe"),
    (Join-Path $StageRoot "bin\fullmag-api-preparation-resource-pool.exe"),
    (Join-Path $StageRoot "bin\fullmag-api-preparation-retry.exe"),
    (Join-Path $StageRoot "bin\fullmag-ui.exe"),
    (Join-Path $StageRoot "web\index.html"),
    (Join-Path $StageRoot "web\workspace\index.html"),
    (Join-Path $StageRoot "web\dev-server.mjs"),
    (Join-Path $StageRoot "web\scripts\dev-server-public-origin.mjs"),
    (Join-Path $StageRoot "web\scripts\resolve-pnpm-invocation.mjs"),
    (Join-Path $StageRoot "python\site-packages\fullmag\__init__.py"),
    (Join-Path $StageRoot "python\python.exe"),
    (Join-Path $StageRoot "python\python312._pth"),
    (Join-Path $StageRoot "python\sitecustomize.py"),
    (Join-Path $StageRoot "share\licenses\python-LICENSE.txt"),
    (Join-Path $StageRoot "share\version.json"),
    (Join-Path $StageRoot "runtimes\cpu-reference\manifest.json")
  )
  if ($BuildCuda) { $required += (Join-Path $StageRoot "runtimes\fdm-cuda\manifest.json") }
  if ($BuildPlan.fem_enabled) {
    $required += (Join-Path $StageRoot "bin\fullmag_fem.dll"), (Join-Path $StageRoot "runtimes\fem-cpu-native\manifest.json")
  }
  if ($BuildPlan.fem_cuda) { $required += (Join-Path $StageRoot "runtimes\fem-gpu\manifest.json") }
  foreach ($path in $required) {
    Require-File $path
  }
  foreach ($dll in $runtimeDllInventory) {
    $path = Join-Path $StageRoot $dll.path
    Require-File $path
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $dll.sha256) {
      throw "Runtime DLL changed after staging: $($dll.path)"
    }
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
& python (Join-Path $RepoRoot "scripts\check_python_dependency_lock.py") --project (Join-Path $RepoRoot "packages\fullmag-py\pyproject.toml") --lock (Join-Path $RepoRoot "packages\fullmag-py\uv.lock")
if ($LASTEXITCODE -ne 0) { throw "Python dependency lock validation failed before build" }
Require-Command uv
Require-Command heat.exe
Require-Command candle.exe
Require-Command light.exe
Require-Command git
if ($BuildPlan.fem_enabled) { Require-Command $(if ($env:FULLMAG_CMAKE) { $env:FULLMAG_CMAKE } else { "cmake" }) }

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
Require-Command "dumpbin.exe"
$extraDllRoots = @(if ($env:FULLMAG_WINDOWS_MSI_DLL_ROOTS) { $env:FULLMAG_WINDOWS_MSI_DLL_ROOTS.Split(';') })
$extraDllRoots += @(Get-FullmagMsiFemDependencyRoots -Plan $BuildPlan)
$dependencyRoots = @(Get-MsiDependencyRoots -RedistRoot $env:VCToolsRedistDir -CudaCompiler $env:CUDACXX `
  -ExtraRoots $extraDllRoots -Cuda:$BuildCuda)
$nativeFemAssembly = $null

if ([string]::IsNullOrWhiteSpace($env:FULLMAG_WINDOWS_NODE_RUNTIME_ROOT)) {
  throw "Configure FULLMAG_WINDOWS_NODE_RUNTIME_ROOT with a native x64 Node distribution containing node.exe and LICENSE"
}
$nodeRuntimeInventoryPath = Join-Path $DistRoot "node-runtime-inputs.json"
Ensure-Dir $DistRoot
& python (Join-Path $PSScriptRoot "stage_node_runtime.py") inspect --root $env:FULLMAG_WINDOWS_NODE_RUNTIME_ROOT --output $nodeRuntimeInventoryPath
if ($LASTEXITCODE -ne 0) { throw "Native Node runtime inspection failed with exit code $LASTEXITCODE" }
$nodeRuntimeInventory = Get-Content -LiteralPath $nodeRuntimeInventoryPath -Raw | ConvertFrom-Json
$nodeRuntimeInventorySha256 = (Get-FileHash -LiteralPath $nodeRuntimeInventoryPath -Algorithm SHA256).Hash
$dependencyRoots += [string]$nodeRuntimeInventory.source_root

if ([string]::IsNullOrWhiteSpace($env:FULLMAG_WINDOWS_PYTHON_RUNTIME_ROOT)) {
  throw "Configure FULLMAG_WINDOWS_PYTHON_RUNTIME_ROOT with a native x64 CPython 3.12 embeddable distribution"
}
$pythonRuntimeInventoryPath = Join-Path $DistRoot "python-runtime-inputs.json"
& python (Join-Path $PSScriptRoot "stage_python_runtime.py") inspect --root $env:FULLMAG_WINDOWS_PYTHON_RUNTIME_ROOT --output $pythonRuntimeInventoryPath
if ($LASTEXITCODE -ne 0) { throw "Native Python runtime inspection failed" }
$pythonRuntimeInputHash = (Get-FileHash -LiteralPath $pythonRuntimeInventoryPath -Algorithm SHA256).Hash
$pythonRuntimeInput = Get-Content -LiteralPath $pythonRuntimeInventoryPath -Raw | ConvertFrom-Json

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

  $nativeFemOutput = Invoke-FullmagMsiFemBuild -Plan $BuildPlan -RepoRoot $RepoRoot -BuildRoot $nativeFemBuildRoot
  if ($BuildPlan.fem_enabled) {
    $env:FULLMAG_FEM_LIB_DIR = $nativeFemOutput.directory
  }
  $launcherBuildArgs = @("build", "--locked", "--release", "--target", $TargetTriple, "-p", "fullmag-cli")
  if ($BuildFeatures.Count) { $launcherBuildArgs += @("--features", ($BuildFeatures -join ",")) }
  & cargo @launcherBuildArgs
  if ($LASTEXITCODE -ne 0) {
    throw "fullmag-cli build failed with exit code $LASTEXITCODE"
  }
  $apiBuildArgs = @("build", "--locked", "--release", "--target", $TargetTriple, "-p", "fullmag-api")
  if ($BuildFeatures.Count) { $apiBuildArgs += @("--features", ($BuildFeatures -join ",")) }
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
  & python -m build --outdir $WheelRoot packages/fullmag-py
  if ($LASTEXITCODE -ne 0) { throw "Python wheel build failed with exit code $LASTEXITCODE" }

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

  foreach ($binary in @(
    "fullmag.exe",
    "fullmag-api.exe",
    "fullmag-api-accepted-worker.exe",
    "fullmag-api-accepted-supervisor.exe",
    "fullmag-api-accepted-scheduler.exe",
    "fullmag-runtime-service.exe",
    "fullmag-api-resource-pool.exe",
    "fullmag-api-accepted-fem-preparer.exe",
    "fullmag-api-accepted-fem-preparation-supervisor.exe",
    "fullmag-api-accepted-fem-preparation-scheduler.exe",
    "fullmag-api-preparation-resource-pool.exe",
    "fullmag-api-preparation-retry.exe",
    "fullmag-ui.exe"
  )) {
    $sourceBinary = Join-Path $ReleaseDir $binary
    Require-File $sourceBinary
    Copy-Item -Force $sourceBinary (Join-Path $binDir $binary)
  }
  Copy-OrAliasLauncher (Join-Path $ReleaseDir "fullmag-bin.exe") (Join-Path $ReleaseDir "fullmag.exe") (Join-Path $binDir "fullmag-bin.exe")
  Require-File (Join-Path $binDir "fullmag-bin.exe")
  if ((Get-FileHash -LiteralPath $nodeRuntimeInventoryPath -Algorithm SHA256).Hash -ne $nodeRuntimeInventorySha256) {
    throw "Node runtime inventory changed before staging"
  }
  & python (Join-Path $PSScriptRoot "stage_node_runtime.py") stage --inventory $nodeRuntimeInventoryPath --destination $StageRoot
  if ($LASTEXITCODE -ne 0) { throw "Native Node runtime staging failed with exit code $LASTEXITCODE" }
  if ((Get-FileHash -LiteralPath $pythonRuntimeInventoryPath -Algorithm SHA256).Hash -ne $pythonRuntimeInputHash) {
    throw "Python runtime inventory changed before staging"
  }
  $pythonRuntimeStagedPath = Join-Path $DistRoot "python-runtime-staged.json"
  & python (Join-Path $PSScriptRoot "stage_python_runtime.py") stage --inventory $pythonRuntimeInventoryPath --destination $StageRoot --output $pythonRuntimeStagedPath
  if ($LASTEXITCODE -ne 0) { throw "Native Python runtime staging failed" }
  $pythonRuntimeStagedHash = (Get-FileHash -LiteralPath $pythonRuntimeStagedPath -Algorithm SHA256).Hash
  $pythonRuntimeInventory = Get-Content -LiteralPath $pythonRuntimeStagedPath -Raw | ConvertFrom-Json

  $runtimeDllSources = @(Get-ChildItem -LiteralPath $ReleaseDir -Filter "*.dll" -File -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty FullName)
  if ($BuildCuda) {
    $nativeFdmDll = Find-NativeFdmDll
    $runtimeDllSources += $nativeFdmDll.FullName
  }
  if ($BuildPlan.fem_enabled) { $runtimeDllSources += $nativeFemOutput.dll }
  if ($BuildPlan.fem_enabled) {
    Assert-FullmagMsiModalProviderInventory -Inventory $nativeFemOutput.modal_provider
    foreach ($femArtifact in @(@{path=$nativeFemOutput.dll; hash=$nativeFemOutput.dll_sha256},
        @{path=$nativeFemOutput.import_library; hash=$nativeFemOutput.import_library_sha256},
        @{path=$nativeFemOutput.provider_config; hash=$nativeFemOutput.provider_config_sha256})) {
      if ((Get-FileHash -LiteralPath $femArtifact.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $femArtifact.hash) {
        throw "Native FEM build input/output changed before staging: $($femArtifact.path)"
      }
    }
  }
  $runtimeDllInventory = @(Copy-RuntimeDllSet -SourcePaths $runtimeDllSources -BinDirectory $binDir)
  $pePlanPath = Join-Path $DistRoot "windows-pe-dependency-plan.json"
  $pePlanArgs = @((Join-Path $PSScriptRoot "plan_pe_dependencies.py"), "--bin", $binDir,
    "--dumpbin", (Get-Command dumpbin.exe).Source, "--output", $pePlanPath)
  foreach ($root in $dependencyRoots) { $pePlanArgs += @("--dependency-root", $root) }
  if ($BuildCuda) { $pePlanArgs += "--allow-cuda-driver" }
  & python @pePlanArgs
  if ($LASTEXITCODE -ne 0) { throw "Staged DLL closure planning failed with exit code $LASTEXITCODE" }
  $peDependencyPlan = Get-Content -LiteralPath $pePlanPath -Raw | ConvertFrom-Json
  foreach ($entry in $peDependencyPlan.staged_images.PSObject.Properties) {
    if ((Get-FileHash -LiteralPath (Join-Path $binDir $entry.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) {
      throw "Staged PE changed after dependency planning: $($entry.Name)"
    }
  }
  foreach ($source in $peDependencyPlan.sources) {
    if ((Get-FileHash -LiteralPath $source.source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $source.sha256) {
      throw "Planned SDK DLL changed before staging: $($source.name)"
    }
  }
  $runtimeDllInventory += @(Copy-RuntimeDllSet -SourcePaths @($peDependencyPlan.sources | ForEach-Object { $_.source }) -BinDirectory $binDir)
  foreach ($source in $peDependencyPlan.sources) {
    if ((Get-FileHash -LiteralPath (Join-Path $binDir $source.name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $source.sha256) {
      throw "Planned SDK DLL changed during staging: $($source.name)"
    }
  }
  $peAuditPath = Join-Path $DistRoot "windows-pe-dependencies.json"
  $peAuditArgs = @((Join-Path $PSScriptRoot "verify_pe_dependencies.py"), "--bin", $binDir,
    "--dumpbin", (Get-Command dumpbin.exe).Source, "--output", $peAuditPath)
  if ($BuildCuda) { $peAuditArgs += "--allow-cuda-driver" }
  & python @peAuditArgs
  if ($LASTEXITCODE -ne 0) { throw "Staged PE dependency audit failed with exit code $LASTEXITCODE" }
  $peDependencyAudit = Get-Content -LiteralPath $peAuditPath -Raw | ConvertFrom-Json
  $pythonPePlanPath = Join-Path $DistRoot "python-pe-dependency-plan.json"
  $pythonPePlanArgs = @((Join-Path $PSScriptRoot "plan_pe_dependencies.py"), "--bin", $pythonDir,
    "--include-pyd", "--dumpbin", (Get-Command dumpbin.exe).Source, "--output", $pythonPePlanPath)
  $pythonPePlanArgs += @("--dependency-root", [string]$pythonRuntimeInput.source_root)
  & python @pythonPePlanArgs
  if ($LASTEXITCODE -ne 0) { throw "Python runtime DLL closure planning failed" }
  $pythonPePlan = Get-Content -LiteralPath $pythonPePlanPath -Raw | ConvertFrom-Json
  foreach ($source in $pythonPePlan.sources) {
    if ((Get-FileHash -LiteralPath $source.source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $source.sha256) {
      throw "Python runtime dependency changed before copying: $($source.name)"
    }
  }
  Copy-RuntimeDllSet -SourcePaths @($pythonPePlan.sources | ForEach-Object { $_.source }) -BinDirectory $pythonDir | Out-Null
  foreach ($source in $pythonPePlan.sources) {
    if ((Get-FileHash -LiteralPath (Join-Path $pythonDir $source.name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $source.sha256) {
      throw "Python runtime dependency changed during copying: $($source.name)"
    }
  }
  $pythonPeAuditPath = Join-Path $DistRoot "python-pe-dependencies.json"
  & python (Join-Path $PSScriptRoot "verify_pe_dependencies.py") --bin $pythonDir --include-pyd `
    --dumpbin (Get-Command dumpbin.exe).Source --output $pythonPeAuditPath
  if ($LASTEXITCODE -ne 0) { throw "Python runtime PE dependency audit failed" }
  $pythonPeDependencyAudit = Get-Content -LiteralPath $pythonPeAuditPath -Raw | ConvertFrom-Json
  $stagedNodeVersion = (& (Join-Path $binDir "node.exe") --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $stagedNodeVersion -ne [string]$nodeRuntimeInventory.version) {
    throw "Staged Node runtime failed its version smoke check: $stagedNodeVersion"
  }
  foreach ($nodeFile in $nodeRuntimeInventory.files) {
    if ((Get-FileHash -LiteralPath (Join-Path $StageRoot $nodeFile.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $nodeFile.sha256) {
      throw "Staged Node runtime changed during dependency audit: $($nodeFile.path)"
    }
  }
  if ($BuildPlan.fem_enabled) {
    $availabilityOutput = (& (Join-Path $binDir "fullmag.exe") runtime fem-availability --json | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "Staged FEM availability probe failed with exit code $LASTEXITCODE" }
    $nativeFemAvailability = Convert-FullmagMsiFemAvailability -Plan $BuildPlan -JsonOutput $availabilityOutput
    $nativeFemAssembly = @{ mode=$BuildPlan.fem_mode; dependency_prefix=$BuildPlan.dependency_prefix;
      runtime_dll="bin/fullmag_fem.dll"; availability=$nativeFemAvailability;
      runtime_dll_sha256=$nativeFemOutput.dll_sha256; import_library_sha256=$nativeFemOutput.import_library_sha256;
      provider_config=$nativeFemOutput.provider_config; provider_config_sha256=$nativeFemOutput.provider_config_sha256;
      modal_provider=$nativeFemOutput.modal_provider;
      configure_arguments=@($nativeFemOutput.configure_arguments);
      qualification="not_verified" }
  }

  Require-File (Join-Path $RepoRoot "apps\control-room\out\index.html")
  Require-File (Join-Path $RepoRoot "apps\control-room\out\workspace\index.html")
  Copy-Tree (Join-Path $RepoRoot "apps\control-room\out") $webDir
  & python (Join-Path $RepoRoot "scripts\stage_control_room_static_runtime.py") --source (Join-Path $RepoRoot "apps\control-room") --destination $webDir
  if ($LASTEXITCODE -ne 0) { throw "Static UI runtime staging failed with exit code $LASTEXITCODE" }
  Copy-Tree (Join-Path $RepoRoot "examples") $examplesDir
  $wheels = @(Get-ChildItem -LiteralPath $WheelRoot -Filter "fullmag-*.whl" -File)
  if ($wheels.Count -ne 1) { throw "Exactly one Fullmag Python wheel must be produced under $WheelRoot" }
  $wheel = $wheels[0]
  $pythonPackageInventory = Stage-FullmagLockedPythonPackages -RepoRoot $RepoRoot -WheelPath $wheel.FullName `
    -SiteDirectory $pythonSiteDir -ProofDirectory (Join-Path $DistRoot "python-packages") -ExpectedPythonMinor 12
  Copy-Item -Force $wheel.FullName (Join-Path $pythonDir $wheel.Name)
  & python (Join-Path $RepoRoot "scripts\check_staged_python_wheel.py") --wheel (Join-Path $pythonDir $wheel.Name) `
    --project (Join-Path $RepoRoot "packages\fullmag-py\pyproject.toml") --sha256 $pythonPackageInventory.inputs[2].sha256
  if ($LASTEXITCODE -ne 0) { throw "Staged Fullmag wheel integrity validation failed" }
  if (@($pythonPackageInventory.host.version)[0] -ne 3 -or @($pythonPackageInventory.host.version)[1] -ne 12) {
    throw "Python package wheels must be staged using the bundled CPython 3.12 ABI"
  }
  if ((Get-FileHash -LiteralPath $pythonRuntimeStagedPath -Algorithm SHA256).Hash -ne $pythonRuntimeStagedHash) {
    throw "Staged Python runtime inventory changed"
  }
  & python (Join-Path $PSScriptRoot "stage_python_runtime.py") verify --inventory $pythonRuntimeStagedPath --destination $StageRoot --output (Join-Path $DistRoot "python-runtime-smoke.json")
  if ($LASTEXITCODE -ne 0) { throw "Bundled Python isolation smoke failed" }
  $pythonNativeAuditPath = Join-Path $DistRoot "python-native-dependencies.json"
  $pythonNativeAuditArgs = @((Join-Path $PSScriptRoot "verify_python_native_dependencies.py"),
    "--stage", $StageRoot, "--dumpbin", (Get-Command dumpbin.exe).Source, "--output", $pythonNativeAuditPath)
  if ($BuildCuda) { $pythonNativeAuditArgs += "--allow-cuda-driver" }
  & python @pythonNativeAuditArgs
  if ($LASTEXITCODE -ne 0) { throw "Recursive Python native dependency audit failed" }
  $pythonNativeAuditHash = (Get-FileHash -LiteralPath $pythonNativeAuditPath -Algorithm SHA256).Hash
  $pythonNativeDependencyAudit = Get-Content -LiteralPath $pythonNativeAuditPath -Raw | ConvertFrom-Json
  & (Join-Path $pythonDir "python.exe") -c "import fullmag, numpy, h5py, zarr, scipy, gmsh, manifold3d, meshio, trimesh; from PIL import Image"
  if ($LASTEXITCODE -ne 0) { throw "staged Python package import smoke failed with exit code $LASTEXITCODE" }
  foreach ($pythonInput in $pythonPackageInventory.inputs) {
    if ((Get-FileHash -LiteralPath $pythonInput.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pythonInput.sha256) {
      throw "Python package input changed after wheel staging: $($pythonInput.path)"
    }
  }
  if ((Get-FileHash -LiteralPath $pythonNativeAuditPath -Algorithm SHA256).Hash -ne $pythonNativeAuditHash) {
    throw "Python native audit inventory changed after import smoke"
  }
  & python (Join-Path $PSScriptRoot "verify_python_native_dependencies.py") --stage $StageRoot `
    --dumpbin (Get-Command dumpbin.exe).Source --verify-inventory $pythonNativeAuditPath `
    --output (Join-Path $DistRoot "python-native-post-smoke.json")
  if ($LASTEXITCODE -ne 0) { throw "Python native image set changed after import smoke" }
  foreach ($pythonImage in $pythonNativeDependencyAudit.images) {
    if ((Get-FileHash -LiteralPath (Join-Path $StageRoot $pythonImage.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pythonImage.sha256) {
      throw "Python native image changed after audit: $($pythonImage.path)"
    }
  }
  foreach ($pythonFile in $pythonRuntimeInventory.staged_files) {
    if ((Get-FileHash -LiteralPath (Join-Path $StageRoot $pythonFile.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pythonFile.sha256) {
      throw "Python runtime changed after import smoke: $($pythonFile.path)"
    }
  }

  if (Test-Path (Join-Path $RepoRoot "external_solvers\tetrax\logo_large.png")) {
    Ensure-Dir (Join-Path $shareDir "icons")
    Copy-Item -Force (Join-Path $RepoRoot "external_solvers\tetrax\logo_large.png") `
      (Join-Path $shareDir "icons\fullmag.png")
  }

  @"
Fullmag Windows MSI license inventory.

This artifact carries the runtime's Python wheel and dependency hash metadata.
The build uses dependency lockfiles from the source checkout; the lockfiles are
not included in this artifact. Third-party license text is not automatically
generated by this script; review the source dependency lockfiles before
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
    <Feature Id="FdmCuda" Title="FDM CUDA Runtime" Level="1">
      <ComponentGroupRef Id="RuntimeFdmCudaFiles" />
    </Feature>
"@
  } else { "" }
  $femDirectoryXml = if ($BuildPlan.fem_enabled) { '            <Directory Id="RuntimeFemCpuDir" Name="fem-cpu-native" />' } else { "" }
  $femFeatureXml = if ($BuildPlan.fem_enabled) { '<Feature Id="FemCpu" Title="Native FEM CPU Runtime" Level="1"><ComponentGroupRef Id="RuntimeFemCpuFiles" /></Feature>' } else { "" }
  if ($BuildPlan.fem_cuda) {
    $femDirectoryXml += "`n" + '            <Directory Id="RuntimeFemGpuDir" Name="fem-gpu" />'
    $femFeatureXml += "`n" + '<Feature Id="FemGpu" Title="Native FEM GPU Runtime" Level="1"><ComponentGroupRef Id="RuntimeFemGpuFiles" /></Feature>'
  }
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
$femDirectoryXml
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
$femFeatureXml
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
  if ($BuildPlan.fem_enabled) {
    Harvest-Directory (Join-Path $StageRoot "runtimes\fem-cpu-native") "RuntimeFemCpuFiles" "RuntimeFemCpuDir" (Join-Path $WixRoot "RuntimeFemCpuFiles.wxs")
  }
  if ($BuildPlan.fem_cuda) {
    Harvest-Directory (Join-Path $StageRoot "runtimes\fem-gpu") "RuntimeFemGpuFiles" "RuntimeFemGpuDir" (Join-Path $WixRoot "RuntimeFemGpuFiles.wxs")
  }
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

  Write-MsiArtifactLocations -MsiPath $msiPath -StageManifestPath $ManifestPath
}
finally {
  if ($BuildPlan.fem_enabled) { Remove-Item Env:FULLMAG_FEM_LIB_DIR -ErrorAction SilentlyContinue }
  Pop-Location
}
