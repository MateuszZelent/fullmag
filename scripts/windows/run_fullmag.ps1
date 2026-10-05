[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("auto", "true", "false")]
  [string]$BuildMode,

  [ValidateSet("static", "dev")]
  [string]$Frontend = "dev",

  [ValidateSet("auto", "dev", "release")]
  [string]$BackendProfile = "release",

  [ValidateSet("auto", "fdm", "fem")]
  [string]$Backend = "auto",

  [ValidateSet("auto", "cpu", "gpu")]
  [string]$Device = "auto",

  [ValidateSet("interactive", "headless", "workspace")]
  [string]$RunMode = "interactive",

  [string]$ScriptPath,

  [string]$OutputDir,

  [string]$InitialMagnetizationState,

  [string]$InitialMagnetizationStateFormat,

  [string]$InitialMagnetizationStateDataset,

  [Nullable[int]]$InitialMagnetizationStateSampleIndex,

  [switch]$BuildOnly,

  [switch]$SkipCompatibilityLinks,

  [Alias("skip_local_changes")]
  [switch]$SkipLocalChanges,

  [ValidateRange(1, 65535)]
  [int]$WebPort = 3100
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Resolve-WindowsBackendProfile {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("auto", "dev", "release")][string]$RequestedProfile,
    [Parameter(Mandatory = $true)][ValidateSet("static", "dev")][string]$Frontend,
    [Parameter(Mandatory = $true)][ValidateSet("interactive", "headless", "workspace")][string]$RunMode
  )
  if ($RequestedProfile -eq "auto") {
    if ($RunMode -ne "workspace") {
      throw "BackendProfile=auto is supported only for the empty Windows workspace"
    }
    return $(if ($Frontend -eq "dev") { "dev" } else { "release" })
  }
  return $RequestedProfile
}

# Workspace opens the authoring shell; execution intent is chosen in the UI.
# Reject simulation inputs instead of silently dropping them from `fullmag ui`.
if ($RunMode -eq "workspace" -and (
    $ScriptPath -or $OutputDir -or $InitialMagnetizationState -or
    $InitialMagnetizationStateFormat -or $InitialMagnetizationStateDataset -or
    $null -ne $InitialMagnetizationStateSampleIndex -or
    $Backend -ne "auto" -or $Device -ne "auto")) {
  throw "Workspace mode opens an empty authoring shell; choose backend/device in the UI and omit simulation inputs"
}
if ($Backend -eq "fem") {
  throw "Native Windows launcher currently supports FDM only; FEM remains on its managed runtime path"
}
if ($Device -eq "gpu" -and $Backend -notin @("auto", "fdm")) {
  throw "device=gpu is only supported for the native Windows FDM lane"
}
if ($BuildMode -eq "auto" -and $RunMode -ne "workspace") {
  throw "Automatic build selection is supported only for the empty Windows workspace"
}
$SelectedBackendProfile = Resolve-WindowsBackendProfile `
  -RequestedProfile $BackendProfile -Frontend $Frontend -RunMode $RunMode
if ($SelectedBackendProfile -eq "dev" -and $RunMode -ne "workspace" -and $Device -ne "cpu") {
  throw "The dev backend profile is supported only for native Windows FDM CPU builds"
}
if ($RunMode -eq "workspace" -and $BuildOnly -and (
    -not $PSBoundParameters.ContainsKey("BackendProfile") -or
    $BackendProfile -eq "auto" -or $BuildMode -notin @("auto", "true"))) {
  throw "Workspace BuildOnly requires an explicit dev or release backend profile and BuildMode auto or true"
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$TargetTriple = "x86_64-pc-windows-msvc"

$StorageAdapter = Join-Path $RepoRoot "scripts\windows\fullmag_storage.ps1"
if (-not (Test-Path -LiteralPath $StorageAdapter -PathType Leaf)) {
  throw "Fullmag Windows storage adapter is missing: $StorageAdapter"
}
. $StorageAdapter
$StorageDevice = if ($Device -eq "gpu") { "gpu" } else { "cpu" }
$ExpectedStorageProfile = if ($RunMode -eq "workspace" -or $SelectedBackendProfile -eq "dev") {
  if ($SelectedBackendProfile -eq "dev") { "windows-native-fdm-cpu-dev" } else { "windows-native-fdm-cpu" }
} elseif ($StorageDevice -eq "gpu") {
  "windows-native-fdm-gpu"
} else {
  "windows-native-fdm-cpu"
}
$StorageProfile = $ExpectedStorageProfile
if ($env:FULLMAG_STORAGE_PROFILE -and $env:FULLMAG_STORAGE_PROFILE.Trim()) {
  $requestedStorageProfile = $env:FULLMAG_STORAGE_PROFILE.Trim()
  $fixedWorkspaceProfiles = @("windows-native-fdm-cpu", "windows-native-fdm-cpu-dev")
  if (($RunMode -eq "workspace" -or $SelectedBackendProfile -eq "dev") -and
      $requestedStorageProfile -ne $ExpectedStorageProfile) {
    throw "FULLMAG_STORAGE_PROFILE must match the selected native workspace compiler profile: $ExpectedStorageProfile"
  }
  if ($requestedStorageProfile -in $fixedWorkspaceProfiles -and
      $requestedStorageProfile -ne $ExpectedStorageProfile) {
    throw "FULLMAG_STORAGE_PROFILE $requestedStorageProfile conflicts with backend profile $SelectedBackendProfile"
  }
  if ($RunMode -ne "workspace" -and $SelectedBackendProfile -eq "release" -and
      $requestedStorageProfile -notin $fixedWorkspaceProfiles) {
    # Preserve existing task-specific storage profiles for legacy release runs.
    $StorageProfile = $requestedStorageProfile
  }
}

if ($env:FULLMAG_STORAGE_MANAGED_ENTRY -ne "1") {
  $managedArguments = @(
    "-BuildMode", $BuildMode,
    "-Frontend", $Frontend,
    "-BackendProfile", $SelectedBackendProfile,
    "-Backend", $Backend,
    "-Device", $Device,
    "-RunMode", $RunMode,
    "-WebPort", $WebPort.ToString()
  )
  if ($ScriptPath) { $managedArguments += @("-ScriptPath", $ScriptPath) }
  if ($OutputDir) { $managedArguments += @("-OutputDir", $OutputDir) }
  if ($InitialMagnetizationState) {
    $managedArguments += @("-InitialMagnetizationState", $InitialMagnetizationState)
  }
  if ($InitialMagnetizationStateFormat) {
    $managedArguments += @("-InitialMagnetizationStateFormat", $InitialMagnetizationStateFormat)
  }
  if ($InitialMagnetizationStateDataset) {
    $managedArguments += @("-InitialMagnetizationStateDataset", $InitialMagnetizationStateDataset)
  }
  if ($null -ne $InitialMagnetizationStateSampleIndex) {
    $managedArguments += @("-InitialMagnetizationStateSampleIndex", $InitialMagnetizationStateSampleIndex.ToString())
  }
  if ($BuildOnly) { $managedArguments += "-BuildOnly" }
  if ($SkipCompatibilityLinks) { $managedArguments += "-SkipCompatibilityLinks" }
  if ($SkipLocalChanges) { $managedArguments += "-SkipLocalChanges" }
  if ($RunMode -eq "workspace" -and $BuildOnly) {
    $managedExitCode = Invoke-FullmagStorageWindowsWorkspaceBuild `
      -RepoRoot $RepoRoot -Profile $StorageProfile -Frontend $Frontend `
      -BackendProfile $SelectedBackendProfile -BuildMode $BuildMode `
      -WebPort $WebPort -SkipLocalChanges:$SkipLocalChanges
  }
  elseif ($RunMode -eq "workspace" -and -not $BuildOnly) {
    $managedExitCode = Invoke-FullmagStorageWindowsWorkspace `
      -RepoRoot $RepoRoot -Profile $StorageProfile -Frontend $Frontend `
      -BackendProfile $SelectedBackendProfile -WebPort $WebPort -BuildMode $BuildMode `
      -SkipLocalChanges:$SkipLocalChanges
  }
  else {
    $managedExitCode = Invoke-FullmagStorageManagedScript `
      -RepoRoot $RepoRoot -Profile $StorageProfile -ScriptPath $PSCommandPath `
      -Arguments $managedArguments
  }
  exit $managedExitCode
}

$StorageLayout = Resolve-FullmagStorageLayout -RepoRoot $RepoRoot -Profile $StorageProfile
Set-FullmagStorageEnvironment -Layout $StorageLayout
$WorkspaceNamespace = [string]$StorageLayout.worktree_id
$CacheRoot = [string]$StorageLayout.cache_root
$BuildRoot = [string]$StorageLayout.build_root
$TargetRoot = [string]$StorageLayout.env.CARGO_TARGET_DIR
$TempRoot = [string]$StorageLayout.temp_root
$VolatileBuild = $null

function Resolve-AbsolutePath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path)
}

function Ensure-Directory {
  param([Parameter(Mandatory = $true)][string]$Path)
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Require-Command {
  param([Parameter(Mandatory = $true)][string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Invoke-External {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter()][string[]]$Arguments = @()
  )
  Write-Host ("> " + $Command + " " + ($Arguments -join " "))
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code ${LASTEXITCODE}"
  }
}

function Invoke-Uv {
  param([Parameter()][string[]]$Arguments = @())
  $managedUv = Join-Path $CacheRoot "tools\Scripts\uv.exe"
  if (Test-Path -LiteralPath $managedUv -PathType Leaf) {
    Invoke-External $managedUv $Arguments
    return
  }
  if (Get-Command "uv" -ErrorAction SilentlyContinue) {
    Invoke-External "uv" $Arguments
    return
  }
  $toolPackages = Join-Path $CacheRoot "tools\python-packages"
  if (-not (Test-Path -LiteralPath (Join-Path $toolPackages "uv\__main__.py") -PathType Leaf)) {
    if ($BuildMode -ne "true") {
      throw "Managed uv is missing; rebuild the Windows workspace"
    }
    Invoke-External "python" @("-m", "pip", "install", "--target", $toolPackages, "uv")
  }
  $previousPythonPath = $env:PYTHONPATH
  try {
    $env:PYTHONPATH = $toolPackages
    Invoke-External "python" (@("-m", "uv") + $Arguments)
  }
  finally { $env:PYTHONPATH = $previousPythonPath }
}

function Add-NodePaths {
  $nodeRoot = Join-Path $CacheRoot "node"
  $nodeGlobalRoot = Join-Path $nodeRoot "global"
  $nodeVersionRoots = @(
    Get-ChildItem -LiteralPath $nodeRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "v*" } |
      Select-Object -ExpandProperty FullName
  )
  $pathEntries = @($nodeRoot, $nodeGlobalRoot) + $nodeVersionRoots + @($env:Path)
  $env:Path = ($pathEntries | Where-Object { $_ -and $_.Trim() } | Select-Object -Unique) -join [System.IO.Path]::PathSeparator
}

function Prepend-PathEntry {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (Test-Path -LiteralPath $Path -PathType Container) {
    $env:Path = $Path + [System.IO.Path]::PathSeparator + $env:Path
  }
}

function Get-Sha256File {
  param([Parameter(Mandatory = $true)][string]$Path)
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
      return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
      $stream.Dispose()
    }
  }
  finally {
    $hasher.Dispose()
  }
}

function Assert-FullmagDesktopRuntime {
  param([string]$Path, [string]$ExpectedHash)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or
      (Get-Item -LiteralPath $Path).Length -eq 0) {
    throw "Native Fullmag desktop binary is missing at $Path; rerun with build=True"
  }
  if ($ExpectedHash -notmatch '^[0-9a-f]{64}$' -or
      (Get-Sha256File $Path) -ne $ExpectedHash) {
    throw "Native Fullmag desktop hash does not match the build manifest; rerun with build=True"
  }
}

function Import-VsEnvironment {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    throw "vswhere.exe not found; install Visual Studio Build Tools with the C++ workload"
  }
  $vsPath = (& $vswhere -products "*" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -latest -property installationPath 2>$null | Select-Object -First 1).Trim()
  if (-not $vsPath) {
    throw "Visual Studio / Build Tools installation not found"
  }
  $vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
  if (-not (Test-Path -LiteralPath $vcvars -PathType Leaf)) {
    throw "vcvars64.bat not found at $vcvars"
  }
  cmd.exe /d /s /c "`"$vcvars`" && set" | ForEach-Object {
    if ($_ -match "^(.+?)=(.*)$") {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
    }
  }
  Add-NodePaths
  Write-Host "Imported MSVC environment from $vcvars"
}

function Ensure-PythonEnvironment {
  if ($env:FULLMAG_NATIVE_RUNTIME_ACTIVE -eq "1" -and
      -not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
    throw "Active workspace Python dependencies cannot be repaired during a background build; save and close the UI"
  }
  $managedPythonRoot = Join-Path $PythonRoot "managed"
  Ensure-Directory $managedPythonRoot
  if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
    Invoke-Uv @(
      "python", "install", "3.12", "--install-dir", $managedPythonRoot
    )
    Invoke-Uv @(
      "venv", $PythonVenv, "--python", "3.12", "--managed-python", "--no-project", "--allow-existing"
    )
  }
  if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
    throw "Fullmag Python environment was not created at $PythonExe"
  }
}

function Ensure-ControlRoomDependencies {
  Ensure-PinnedPnpm
  if ($RunMode -eq "workspace" -and $env:FULLMAG_NATIVE_RUNTIME_ACTIVE -eq "1") {
    if (-not $FrontendWorkspaceRoot -or -not $FrontendCacheRoot -or
        -not (Test-Path -LiteralPath (Join-Path $FrontendWorkspaceRoot "apps\control-room\node_modules\next\package.json") -PathType Leaf)) {
      throw "Active workspace dependencies cannot be repaired during a background build; save and close the UI"
    }
    Write-Host "Reusing active workspace dependencies without install or restaging"
    return
  }
  $dependencyWorkspace = $RepoRoot
  if ($RunMode -eq "workspace") {
    $stageOutput = (& python (Join-Path $PSScriptRoot "stage_workspace_frontend.py") --repo-root $RepoRoot --build-root $BuildRoot --mode $Frontend --web-port $WebPort 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "Native frontend staging failed: $stageOutput" }
    $stage = $stageOutput | ConvertFrom-Json
    $script:FrontendWorkspaceRoot = Assert-FullmagStoragePath -Layout $StorageLayout -Path ([string]$stage.workspace_root) -Label "native frontend workspace" -Parent $BuildRoot
    $script:FrontendCacheRoot = Assert-FullmagStoragePath -Layout $StorageLayout -Path ([string]$stage.frontend_root) -Label "native frontend cache" -Parent $BuildRoot
    $script:FrontendSourceManifestPath = [string]$stage.manifest_path
    $script:FrontendSourceManifestSha256 = [string]$stage.manifest_sha256
    $script:StaticControlRoom = Join-Path $FrontendWorkspaceRoot "apps\control-room\out\index.html"
    $env:FULLMAG_FRONTEND_ROOT = $FrontendCacheRoot
    $dependencyWorkspace = $FrontendWorkspaceRoot
  }
  $pnpmArguments = @("install", "--frozen-lockfile")
  $windowsSwc = Get-ChildItem `
    -LiteralPath (Join-Path $dependencyWorkspace "node_modules\.pnpm") `
    -Directory `
    -Filter "@next+swc-win32-x64-msvc@*" `
    -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ((Test-Path -LiteralPath (Join-Path $dependencyWorkspace "node_modules") -PathType Container) -and
      $null -eq $windowsSwc) {
    Write-Host "Replacing non-Windows node_modules with Windows dependencies"
    $pnpmArguments += "--force"
  }
  $previousCi = $env:CI
  $env:CI = "1"
  Push-Location $dependencyWorkspace
  try {
    Invoke-External "node" (@($PinnedPnpmCli) + $pnpmArguments)
    if ($Frontend -eq "static") {
      $env:FULLMAG_CONTROL_ROOM_STATIC_EXPORT = "1"
      try {
        Invoke-External "node" (@($PinnedPnpmCli) + @("--dir", "apps/control-room", "build"))
      }
      finally {
        Remove-Item Env:FULLMAG_CONTROL_ROOM_STATIC_EXPORT -ErrorAction SilentlyContinue
      }
    }
  }
  finally {
    Pop-Location
    if ($null -eq $previousCi) {
      Remove-Item Env:CI -ErrorAction SilentlyContinue
    } else {
      $env:CI = $previousCi
    }
  }
}

function Ensure-PinnedPnpm {
  Require-Command "node"
  if (-not (Test-Path -LiteralPath $PinnedPnpmCli -PathType Leaf)) {
    if ($BuildMode -ne "true") {
      throw "Pinned pnpm $PinnedPnpmVersion is missing at $PinnedPnpmCli; rebuild the Windows workspace"
    }
    Require-Command "corepack"
    $env:COREPACK_HOME = Join-Path $CacheRoot "corepack"
    Invoke-External "corepack" @("prepare", "pnpm@$PinnedPnpmVersion", "--activate")
  }
  $resolvedPnpmVersion = (& node $PinnedPnpmCli --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $resolvedPnpmVersion -ne $PinnedPnpmVersion) {
    throw "Pinned pnpm validation failed at $PinnedPnpmCli; expected $PinnedPnpmVersion, got $resolvedPnpmVersion"
  }
  $env:FULLMAG_PNPM_CLI = $PinnedPnpmCli
}

function Ensure-NodeToolchain {
  Require-Command "node"
  $nodeVersion = (& node --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v24\.(1[89]|2[0-9]|[3-9][0-9])(?:\.[0-9]+)?$') {
    throw "Fullmag Control Room requires Node 24.18.x through 24.99.x, got $nodeVersion"
  }
  Ensure-PinnedPnpm
}

function Ensure-NativeRustToolchain {
  Require-Command "rustup"
  $toolchain = "fullmag-native-x86_64-pc-windows-msvc"
  $env:RUSTUP_TOOLCHAIN = $toolchain
  if (Test-Path -LiteralPath (Join-Path $RustupHome "toolchains\$toolchain\bin\rustc.exe") -PathType Leaf) { return }
  # Reuse an already installed host compiler as an SDK. Only the link metadata
  # is new and is stored in the managed RUSTUP_HOME; compiler files stay intact.
  $sdk = Join-Path $env:USERPROFILE ".rustup\toolchains\nightly-x86_64-pc-windows-msvc"
  if (-not (Test-Path -LiteralPath (Join-Path $sdk "bin\rustc.exe") -PathType Leaf)) {
    throw "An installed nightly Windows/MSVC Rust SDK is required for the native workspace build"
  }
  Invoke-External "rustup" @("toolchain", "link", $toolchain, $sdk)
}

function Get-SourceIdentity {
  $identityPython = if (Test-Path -LiteralPath $PythonExe -PathType Leaf) { $PythonExe } else { "python" }
  $identityScript = Join-Path $RepoRoot "scripts\capture_source_snapshot_identity.py"
  $previousGitOptionalLocks = $env:GIT_OPTIONAL_LOCKS
  $identityOutput = $null
  $identityExitCode = 0
  try {
    # The identity probe reads Git's index/worktree but does not need an
    # optional index refresh.  Avoid competing with a VS Code commit over
    # .git/index.lock while preserving all mandatory Git locking semantics.
    $env:GIT_OPTIONAL_LOCKS = "0"
    $identityOutput = (& $identityPython $identityScript --repo-root $RepoRoot --ignore-non-runtime-dirty 2>&1 | Out-String)
    $identityExitCode = $LASTEXITCODE
  }
  finally {
    if ($null -eq $previousGitOptionalLocks) {
      Remove-Item Env:GIT_OPTIONAL_LOCKS -ErrorAction SilentlyContinue
    } else {
      $env:GIT_OPTIONAL_LOCKS = $previousGitOptionalLocks
    }
  }
  if ($identityExitCode -ne 0) {
    throw "Fullmag source identity capture failed with exit code ${identityExitCode}: $identityOutput"
  }
  try {
    $identity = $identityOutput | ConvertFrom-Json
  }
  catch {
    throw "Fullmag source identity capture returned invalid JSON: $identityOutput"
  }
  if ([string]$identity.head_commit_full -notmatch '^[0-9a-f]{40}$' -or
      [string]$identity.source_snapshot_sha256 -notmatch '^[0-9a-f]{64}$' -or
      $identity.source_snapshot_dirty -isnot [bool]) {
    throw "Fullmag source identity is incomplete or invalid"
  }
  return $identity
}

function Write-JsonAtomic {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )
  $temporary = "$Path.tmp.$PID"
  $json = $Value | ConvertTo-Json -Depth 100
  [System.IO.File]::WriteAllText($temporary, $json, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-WindowsBackendSourceDigest {
  param([switch]$FrontendSources, [switch]$Dependencies)
  $digestArguments = @("--repo-root", $RepoRoot)
  if ($FrontendSources) { $digestArguments += "--frontend" }
  if ($Dependencies) { $digestArguments += "--dependencies" }
  $output = (& python (Join-Path $PSScriptRoot "workspace_backend_identity.py") @digestArguments 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "Native workspace source fingerprint failed: $output" }
  $identity = $output | ConvertFrom-Json
  if ([string]$identity.sha256 -notmatch '^[0-9a-f]{64}$') { throw "Invalid native workspace source fingerprint" }
  return [string]$identity.sha256
}

function Publish-NativeWorkspaceRuntime {
  if (-not $env:FULLMAG_NATIVE_RUNTIME_READY_FILE -or
      $env:FULLMAG_NATIVE_RUNTIME_NONCE -notmatch '^[0-9a-f]{32}$') {
    throw "Native workspace runtime requires its managed publication handshake"
  }
  foreach ($name in @(
    "FULLMAG_DEVELOPMENT_BACKEND_GENERATION",
    "FULLMAG_DEVELOPMENT_BACKEND_STATUS_FILE",
    "FULLMAG_DEVELOPMENT_BACKEND_SOURCE",
    "FULLMAG_DEVELOPMENT_BACKEND_VERSION"
  )) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
  $readyPath = Assert-FullmagStoragePath -Layout $StorageLayout -Path $env:FULLMAG_NATIVE_RUNTIME_READY_FILE -Label "native runtime handshake" -Parent $StorageLayout.runtime_root
  $bundleOutput = (& python (Join-Path $PSScriptRoot "runtime_bundle.py") --build-root $BuildRoot --runtime-root $StorageLayout.runtime_root --manifest $ManifestPath --profile $SelectedBackendProfile 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "Native runtime publication failed: $bundleOutput" }
  $bundle = $bundleOutput | ConvertFrom-Json
  $bundleManifestPath = Assert-FullmagStoragePath -Layout $StorageLayout -Path ([string]$bundle.manifest) -Label "sealed native runtime manifest" -Parent (Join-Path $StorageLayout.runtime_root "native-bundles")
  if (-not (Test-Path -LiteralPath $bundleManifestPath -PathType Leaf)) { throw "Sealed native runtime manifest is missing" }
  $sealedBundle = Get-Content -LiteralPath $bundleManifestPath -Raw | ConvertFrom-Json
  if ([string]$sealedBundle.schema -ne "fullmag.native-runtime-bundle.v1" -or
      [string]$sealedBundle.profile -ne $SelectedBackendProfile -or
      [string]$sealedBundle.compiler_profile -ne $CargoCompilerProfile -or
      [string]$sealedBundle.source.backend_source_sha256 -ne [string]$manifest.backend_source_sha256 -or
      [string]$sealedBundle.source.build_version.product_version -ne [string]$manifest.build_version.product_version) {
    throw "Sealed native runtime identity does not match the validated build manifest"
  }
  $launchOutput = (& python (Join-Path $PSScriptRoot "stable_launch.py") --repo-root $RepoRoot --bundle-root ([string]$bundle.bundle_root) --profile $SelectedBackendProfile 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "Stable native runtime publication failed: $launchOutput" }
  $launch = $launchOutput | ConvertFrom-Json
  if ($SelectedBackendProfile -eq "dev" -and $Frontend -eq "dev") {
    $statusPath = Assert-FullmagStoragePath -Layout $StorageLayout -Path (Join-Path $BuildRoot "backend-watch-status.json") -Label "development backend status" -Parent $BuildRoot
    $backendSource = [string]$sealedBundle.source.backend_source_sha256
    $productVersion = [string]$sealedBundle.source.build_version.product_version
    if ($backendSource -notmatch '^[0-9a-f]{64}$' -or -not $productVersion) {
      throw "Sealed native runtime is missing its development backend identity"
    }
    $env:FULLMAG_DEVELOPMENT_BACKEND_GENERATION = $env:FULLMAG_NATIVE_RUNTIME_NONCE
    $env:FULLMAG_DEVELOPMENT_BACKEND_STATUS_FILE = [string]$statusPath
    $env:FULLMAG_DEVELOPMENT_BACKEND_SOURCE = $backendSource
    $env:FULLMAG_DEVELOPMENT_BACKEND_VERSION = $productVersion
  }
  Write-JsonAtomic -Path $readyPath -Value ([ordered]@{
    schema = "fullmag.native-runtime-ready.v2"
    nonce = $env:FULLMAG_NATIVE_RUNTIME_NONCE
    launcher_pid = $PID
    bundle_root = [string]$bundle.bundle_root
    launch_root = [string]$launch.launch_root
  })
  Write-Host "Native runtime copy: $($bundle.bundle_root)"
  Write-Host "Native executable path: $($launch.fullmag_exe)"
  return [string]$launch.fullmag_exe
}

function Test-WindowsWorkspaceBuildRequired {
  param([string]$BackendDigest)
  foreach ($path in @($FullmagExe, $FullmagApiExe, $FullmagUiExe, $PythonExe, $ManifestPath, $PinnedPnpmCli)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $true }
  }
  try {
    $candidate = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if ([int]$candidate.schema_version -ne 1 -or
        [string]$candidate.backend_source_sha256 -ne $BackendDigest -or
        [string]$candidate.compiler_profile -ne $CargoCompilerProfile -or
        [string]$candidate.workspace_namespace -ne $WorkspaceNamespace -or
        [string]$candidate.target_triple -ne $TargetTriple -or
        [string]$candidate.frontend_mode -ne $Frontend -or
        [string]$candidate.git_commit -notmatch '^[0-9a-f]{40}$' -or
        [string]$candidate.source_snapshot_sha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]$candidate.source_identity_check -ne "passed" -or
        [string]$candidate.local_changes_check -ne "enforced" -or
        -not $FrontendWorkspaceRoot -or -not $FrontendCacheRoot -or
        -not (Test-Path -LiteralPath (Join-Path $FrontendWorkspaceRoot "apps\control-room\node_modules\next\package.json") -PathType Leaf) -or
        [string]$candidate.build_version.schema -ne "fullmag.build-version.v1" -or
        [string]$candidate.build_version.git_commit -ne [string]$candidate.git_commit -or
        [string]$candidate.build_version.source_snapshot_sha256 -ne [string]$candidate.source_snapshot_sha256 -or
        [string]$candidate.binary_sha256 -ne (Get-Sha256File $FullmagExe) -or
        [string]$candidate.api_binary_sha256 -ne (Get-Sha256File $FullmagApiExe) -or
        [string]$candidate.desktop_binary_sha256 -ne (Get-Sha256File $FullmagUiExe)) { return $true }
    $versionFile = Assert-FullmagStoragePath -Layout $StorageLayout -Path ([string]$candidate.build_version_file) -Label "build version file" -Parent $BuildRoot
    $frontendManifest = Assert-FullmagStoragePath -Layout $StorageLayout -Path ([string]$candidate.frontend_source_manifest) -Label "frontend source manifest" -Parent $BuildRoot
    if ([string]$candidate.build_version_file_sha256 -ne (Get-Sha256File $versionFile) -or
        [string]$candidate.frontend_source_manifest_sha256 -ne (Get-Sha256File $frontendManifest)) { return $true }
    if ($Frontend -eq "static" -and (
        [string]$candidate.frontend_source_sha256 -ne (Get-WindowsBackendSourceDigest -FrontendSources) -or
        -not (Test-Path -LiteralPath $StaticControlRoom -PathType Leaf) -or
        [string]$candidate.static_web_sha256 -ne (Get-DirectorySha256 (Split-Path -Parent $StaticControlRoom)))) { return $true }
  }
  catch { return $true }
  return $false
}

function Get-WindowsWorkspaceArtifactPaths {
  param(
    [Parameter(Mandatory = $true)][string]$BuildRoot,
    [Parameter(Mandatory = $true)][string]$TargetRoot,
    [Parameter(Mandatory = $true)][string]$TargetTriple,
    [Parameter(Mandatory = $true)][ValidateSet("backend-dev", "release")][string]$CompilerProfile
  )
  $binaryRoot = Join-Path $TargetRoot "$TargetTriple\$CompilerProfile"
  $runtimeRoot = Join-Path $BuildRoot "windows-runtime"
  return @{
    binary = Join-Path $binaryRoot "fullmag.exe"
    api_binary = Join-Path $binaryRoot "fullmag-api.exe"
    desktop_binary = Join-Path $binaryRoot "fullmag-ui.exe"
    manifest = Join-Path $runtimeRoot "build-manifest.json"
    version_identity = Join-Path $runtimeRoot "build-source-identity.json"
    version_record = Join-Path $runtimeRoot "build-version.json"
  }
}

function Get-WindowsCargoProfileArguments {
  param([Parameter(Mandatory = $true)][ValidateSet("backend-dev", "release")][string]$CompilerProfile)
  if ($CompilerProfile -eq "backend-dev") { return @("--profile", "backend-dev") }
  return @("--release")
}

function Get-DirectorySha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    return $null
  }
  $records = @(Get-ChildItem -LiteralPath $Path -File -Recurse -ErrorAction Stop |
    Sort-Object FullName |
    ForEach-Object {
    # Windows PowerShell uses .NET Framework, which lacks Path.GetRelativePath.
    $prefix = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $relative = $_.FullName.Substring($prefix.Length).Replace('\', '/')
      $hash = Get-Sha256File $_.FullName
      "$relative|$hash"
    })
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($records -join "`n") + "`n")
  $digest = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  return ([System.BitConverter]::ToString($digest) -replace '-', '').ToLowerInvariant()
}

function Resolve-CudaCompiler {
  $candidates = @()
  if ($env:CUDACXX) {
    $candidates += $env:CUDACXX
  }
  $nvcc = Get-Command "nvcc" -ErrorAction SilentlyContinue
  if ($nvcc) {
    $candidates += $nvcc.Path
  }
  if ($env:CUDA_PATH) {
    $candidates += (Join-Path $env:CUDA_PATH "bin\nvcc.exe")
  }
  $defaultCudaRoot = Join-Path ${env:ProgramFiles} "NVIDIA GPU Computing Toolkit\CUDA"
  if (Test-Path -LiteralPath $defaultCudaRoot -PathType Container) {
    $candidates += @(
      Get-ChildItem -LiteralPath $defaultCudaRoot -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName "bin\nvcc.exe" }
    )
  }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return (Resolve-AbsolutePath $candidate)
    }
  }
  throw "FDM GPU build requires nvcc from the CUDA Toolkit; CPU fallback is forbidden for device=gpu"
}

function Test-NvidiaRuntime {
  Require-Command "nvidia-smi"
  & nvidia-smi -L | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "FDM GPU run requires a working NVIDIA driver/GPU; CPU fallback is forbidden"
  }
}

function Get-GitCommit {
  $commit = (& git -C $RepoRoot rev-parse HEAD 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $commit) {
    return "unknown"
  }
  return $commit
}

function Stage-NativeFdmDll {
  # Keep CMake output outside Cargo's deeply nested OUT_DIR to avoid Windows
  # MAX_PATH failures during CUDA compiler detection.
  $nativeDll = Join-Path $nativeFdmBuildRoot "backends\fdm\Release\fullmag_fdm.dll"
  if (-not (Test-Path -LiteralPath $nativeDll -PathType Leaf)) {
    throw "CUDA build did not produce canonical fullmag_fdm.dll at $nativeDll"
  }
  $destination = Join-Path (Split-Path -Parent $FullmagExe) "fullmag_fdm.dll"
  Copy-Item -LiteralPath $nativeDll -Destination $destination -Force
  return (Resolve-AbsolutePath $destination)
}

$useCuda = $Device -eq "gpu"
$CargoHome = [string]$StorageLayout.env.CARGO_HOME
$RustupHome = [string]$StorageLayout.env.RUSTUP_HOME
$PnpmHome = [string]$StorageLayout.env.PNPM_HOME
$PnpmStore = [string]$StorageLayout.env.npm_config_store_dir
$PinnedPnpmVersion = "10.8.1"
$PinnedPnpmCli = Join-Path $CacheRoot "corepack\v1\pnpm\$PinnedPnpmVersion\bin\pnpm.cjs"
$NpmCache = [string]$StorageLayout.env.npm_config_cache
$PipCache = [string]$StorageLayout.env.PIP_CACHE_DIR
$UvCache = [string]$StorageLayout.env.UV_CACHE_DIR
$CudaCache = [string]$StorageLayout.env.CUDA_CACHE_PATH
$PlaywrightRoot = [string]$StorageLayout.env.PLAYWRIGHT_BROWSERS_PATH
$PythonRoot = Join-Path $BuildRoot "python"
$PythonVenv = Join-Path $PythonRoot "fullmag"
$PythonExe = Join-Path $PythonVenv "Scripts\python.exe"
$CargoCompilerProfile = if ($SelectedBackendProfile -eq "dev") { "backend-dev" } else { "release" }
$ArtifactPaths = Get-WindowsWorkspaceArtifactPaths `
  -BuildRoot $BuildRoot -TargetRoot $TargetRoot -TargetTriple $TargetTriple `
  -CompilerProfile $CargoCompilerProfile
$ManifestPath = $ArtifactPaths.manifest
$VersionIdentityPath = $ArtifactPaths.version_identity
$VersionRecordPath = $ArtifactPaths.version_record
$FullmagExe = $ArtifactPaths.binary
$FullmagApiExe = $ArtifactPaths.api_binary
$FullmagUiExe = $ArtifactPaths.desktop_binary
$StaticControlRoom = Join-Path $RepoRoot "apps\control-room\out\index.html"
$FrontendWorkspaceRoot = $null
$FrontendCacheRoot = $null
$FrontendSourceManifestPath = $null
$FrontendSourceManifestSha256 = $null
if ($RunMode -eq "workspace" -and (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  try {
    $existingWorkspaceManifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if ($existingWorkspaceManifest.frontend_workspace_root) {
      $FrontendWorkspaceRoot = Assert-FullmagStoragePath -Layout $StorageLayout -Path ([string]$existingWorkspaceManifest.frontend_workspace_root) -Label "native frontend workspace" -Parent $BuildRoot
      $FrontendCacheRoot = Assert-FullmagStoragePath -Layout $StorageLayout -Path ([string]$existingWorkspaceManifest.frontend_cache_root) -Label "native frontend cache" -Parent $BuildRoot
      $FrontendSourceManifestPath = [string]$existingWorkspaceManifest.frontend_source_manifest
      $FrontendSourceManifestSha256 = [string]$existingWorkspaceManifest.frontend_source_manifest_sha256
      $StaticControlRoom = Join-Path $FrontendWorkspaceRoot "apps\control-room\out\index.html"
    }
  }
  catch { $FrontendWorkspaceRoot = $null }
}
$BackendSourceDigest = if ($RunMode -eq "workspace") { Get-WindowsBackendSourceDigest } else { $null }
$FrontendSourceDigest = if ($RunMode -eq "workspace" -and $Frontend -eq "static") { Get-WindowsBackendSourceDigest -FrontendSources } else { $null }
if ($BuildMode -eq "auto") {
  $BuildMode = if (Test-WindowsWorkspaceBuildRequired -BackendDigest $BackendSourceDigest) { "true" } else { "false" }
  Write-Host "Windows workspace automatic build selection: $BuildMode"
}
$needsControlRoomToolchain = $RunMode -eq "workspace" -or $Frontend -eq "static" -or
  (-not $BuildOnly -and $RunMode -in @("interactive", "workspace"))

$nextDistDir = if ($needsControlRoomToolchain -and $Frontend -eq "dev") {
  ".next-control-room-$WebPort"
} else {
  $null
}
$prepareArguments = @{
  RepoRoot = $RepoRoot
  Profile = $StorageProfile
}
if (-not $SkipCompatibilityLinks -and $RunMode -ne "workspace") {
  $prepareArguments.Compat = $true
}
if ($needsControlRoomToolchain -and $RunMode -ne "workspace") {
  $prepareArguments.Frontend = $true
}
if ($nextDistDir -and $RunMode -ne "workspace") {
  $prepareArguments.NextDistDir = $nextDistDir
}
if ($SkipCompatibilityLinks -and -not $BuildOnly) {
  throw "SkipCompatibilityLinks is allowed only for an isolated BuildOnly invocation"
}
if ($RunMode -ne "workspace" -and (-not $SkipCompatibilityLinks -or $needsControlRoomToolchain)) {
  $null = Prepare-FullmagStorageLinks @prepareArguments
}

foreach ($directory in @(
  $CargoHome, $RustupHome, $PnpmHome, $PnpmStore, $NpmCache, $PipCache, $UvCache,
  $TempRoot, $CudaCache, $PlaywrightRoot, $PythonRoot,
  (Split-Path -Parent $ManifestPath)
)) {
  if ($directory) {
    Ensure-Directory $directory
  }
}

$null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $TargetRoot -Label "CARGO_TARGET_DIR" -Parent $BuildRoot
$null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $PythonRoot -Label "Fullmag Python root" -Parent $BuildRoot
$env:CARGO_HOME = $CargoHome
$env:RUSTUP_HOME = $RustupHome
$env:CARGO_INCREMENTAL = if ($SelectedBackendProfile -eq "dev" -or ($Frontend -eq "dev" -and -not $BuildOnly)) { "1" } else { "0" }
$env:FULLMAG_FDM_EXECUTION = $null
$env:UV_PYTHON_INSTALL_DIR = Join-Path $PythonRoot "managed"
$env:UV_PYTHON_BIN_DIR = Join-Path $PythonRoot "bin"
$env:PYTHONPATH = Join-Path $RepoRoot "packages\fullmag-py\src"
$env:FULLMAG_PYTHON = $PythonExe
Add-NodePaths

$nativeFdmBuildRoot = if ($env:FULLMAG_FDM_NATIVE_BUILD_ROOT) {
  Resolve-AbsolutePath $env:FULLMAG_FDM_NATIVE_BUILD_ROOT
} else {
  Join-Path $BuildRoot "native"
}
$null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $nativeFdmBuildRoot -Label "FULLMAG_FDM_NATIVE_BUILD_ROOT" -Parent $BuildRoot
Ensure-Directory $nativeFdmBuildRoot
$env:FULLMAG_FDM_NATIVE_BUILD_ROOT = $nativeFdmBuildRoot

$cudaCompiler = $null
$cudaBin = $null
Require-Command "git"

if ($BuildMode -eq "true") {
  Ensure-PythonEnvironment
}
elseif (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
  throw "Fullmag Python environment is missing at $PythonExe; rerun with build=True"
}

$sourceIdentity = Get-SourceIdentity
$sourceCommit = [string]$sourceIdentity.head_commit_full
$sourceWorktreeState = if ([bool]$sourceIdentity.source_snapshot_dirty) { "dirty" } else { "clean" }
$sourceSnapshotSha256 = [string]$sourceIdentity.source_snapshot_sha256
$localChangesCheck = if ($SkipLocalChanges) { "skipped" } else { "enforced" }
if ($SkipLocalChanges) {
  Write-Warning "Local source-change validation is skipped; this runtime is unqualified for reproducibility"
}
$env:FULLMAG_SOURCE_GIT_COMMIT = $sourceCommit
$env:FULLMAG_SOURCE_WORKTREE_STATE = $sourceWorktreeState
$env:FULLMAG_SOURCE_SNAPSHOT_SHA256 = $sourceSnapshotSha256

if ($BuildMode -eq "true") {
  Write-JsonAtomic -Path $versionIdentityPath -Value $sourceIdentity
  Invoke-External $PythonExe @(
    "-B", (Join-Path $RepoRoot "scripts\build_version.py"),
    "--repo-root", $RepoRoot, "--source-identity", $versionIdentityPath,
    "--output", $versionRecordPath
  )
  $buildVersion = Get-Content -LiteralPath $versionRecordPath -Raw | ConvertFrom-Json
  if ([string]$buildVersion.git_commit -ne $sourceCommit -or
      [string]$buildVersion.source_snapshot_sha256 -ne $sourceSnapshotSha256) {
    throw "Build version does not match the captured native source identity"
  }
  $env:FULLMAG_BUILD_VERSION_FILE = $versionRecordPath
  $env:FULLMAG_BUILD_VERSION = [string]$buildVersion.semver_version
  $env:FULLMAG_WINDOWS_FILE_VERSION = [string]$buildVersion.windows_file_version
  $env:SOURCE_DATE_EPOCH = ([DateTimeOffset]::Parse([string]$buildVersion.build_date_utc)).ToUnixTimeSeconds().ToString()
  $tauriConfig = if ($env:TAURI_CONFIG) { $env:TAURI_CONFIG | ConvertFrom-Json } else { [pscustomobject]@{} }
  $tauriConfig | Add-Member -NotePropertyName version -NotePropertyValue ([string]$buildVersion.semver_version) -Force
  $env:TAURI_CONFIG = $tauriConfig | ConvertTo-Json -Depth 100 -Compress
  $PythonSyncRequired = $env:FULLMAG_NATIVE_RUNTIME_ACTIVE -eq "1"
  if (-not $PythonSyncRequired) {
    Invoke-Uv @("pip", "install", "--python", $PythonExe, "--editable", (Join-Path $RepoRoot "packages\fullmag-py[meshing]"))
  } else {
    Write-Host "Keeping the active Python environment unchanged; version sync is deferred until restart"
  }
  Write-Host "Fullmag build version: $($buildVersion.semver_version)"
}

# Headless runs never launch the Control Room, so they must not be coupled to
# the Node/pnpm profile recorded by a binary-only (`-BuildOnly`) build.  Static
# exports always need the frontend toolchain; interactive dev runs do as well.
if ($needsControlRoomToolchain) {
  Ensure-NodeToolchain
}

if ($BuildMode -eq "true") {
  $volatileOutput = (& python -B (Join-Path $PSScriptRoot "volatile_build_storage.py") `
    --repo-root $RepoRoot --profile $StorageProfile --build-root $BuildRoot 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "Volatile compiler storage preparation failed: $volatileOutput" }
  $VolatileBuild = $volatileOutput | ConvertFrom-Json
  if ([bool]$VolatileBuild.enabled -and (
      -not $VolatileBuild.root -or -not $VolatileBuild.temp_root -or
      (Resolve-AbsolutePath ([string]$VolatileBuild.durable_build_root)) -ine (Resolve-AbsolutePath $BuildRoot))) {
    throw "Volatile compiler storage does not match the durable build profile"
  }
  Require-Command "cargo"
  Require-Command "rustc"
  Require-Command "rustup"
  Require-Command "cmake"
  Import-VsEnvironment
  Ensure-NativeRustToolchain
  if ($useCuda) {
    $cudaCompiler = Resolve-CudaCompiler
    $cudaBin = Split-Path -Parent $cudaCompiler
    $env:CUDACXX = $cudaCompiler
    Prepend-PathEntry $cudaBin
  }
  if ($needsControlRoomToolchain) {
    Ensure-ControlRoomDependencies
  }
  $activeToolchain = (& rustup show active-toolchain 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $activeToolchain -notmatch "x86_64-pc-windows-msvc") {
    throw "An existing x86_64-pc-windows-msvc Rust toolchain is required; found: $activeToolchain"
  }
  Invoke-External "rustc" @("--version")
  Invoke-External "cargo" @("--version")

  $cargoProfileArguments = @(Get-WindowsCargoProfileArguments -CompilerProfile $CargoCompilerProfile)
  $cargoArguments = @(
    "build", "--locked"
  )
  $cargoArguments += $cargoProfileArguments
  $cargoArguments += @(
    "--target", $TargetTriple,
    "-p", "fullmag-cli", "-p", "fullmag-api"
  )
  if ($useCuda) {
    $cargoArguments += @("--features", "cuda")
  }
  $useVolatileTemp = $null -ne $VolatileBuild -and [bool]$VolatileBuild.enabled
  $savedTemporaryEnvironment = @{}
  if ($useVolatileTemp) {
    foreach ($name in @("TEMP", "TMP", "TMPDIR")) {
      $savedTemporaryEnvironment[$name] = [pscustomobject]@{
        was_set = Test-Path "Env:$name"
        value = [Environment]::GetEnvironmentVariable($name, "Process")
      }
    }
  }
  try {
    if ($useVolatileTemp) {
      foreach ($name in @("TEMP", "TMP", "TMPDIR")) {
        [Environment]::SetEnvironmentVariable($name, [string]$VolatileBuild.temp_root, "Process")
      }
    }
    Push-Location $RepoRoot
    try {
      Invoke-External "cargo" $cargoArguments
      if ($needsControlRoomToolchain) {
        # CUDA belongs to the solver packages, not the desktop shell.
        $desktopCargoArguments = @("build", "--locked") + $cargoProfileArguments + @(
          "--target", $TargetTriple,
          "-p", "fullmag-desktop"
        )
        Invoke-External "cargo" $desktopCargoArguments
      }
    }
    finally {
      Pop-Location
    }
  }
  finally {
    if ($useVolatileTemp) {
      foreach ($name in @("TEMP", "TMP", "TMPDIR")) {
        $saved = $savedTemporaryEnvironment[$name]
        if ($saved.was_set) {
          [Environment]::SetEnvironmentVariable($name, [string]$saved.value, "Process")
        } else {
          Remove-Item "Env:$name" -ErrorAction SilentlyContinue
        }
      }
    }
  }

  if (-not (Test-Path -LiteralPath $FullmagExe -PathType Leaf)) {
    throw "Native Fullmag binary was not produced at $FullmagExe"
  }
  if (-not (Test-Path -LiteralPath $FullmagApiExe -PathType Leaf)) {
    throw "Native Fullmag API binary was not produced at $FullmagApiExe"
  }
  if ($needsControlRoomToolchain -and (
      -not (Test-Path -LiteralPath $FullmagUiExe -PathType Leaf) -or
      (Get-Item -LiteralPath $FullmagUiExe).Length -eq 0)) {
    throw "Native Fullmag desktop binary was not produced at $FullmagUiExe"
  }
  $versionedBinaries = @($FullmagExe, $FullmagApiExe)
  if ($needsControlRoomToolchain) { $versionedBinaries += $FullmagUiExe }
  foreach ($versionedBinary in $versionedBinaries) {
    $peVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($versionedBinary)
    $peNumericVersion = "$($peVersion.FileMajorPart).$($peVersion.FileMinorPart).$($peVersion.FileBuildPart).$($peVersion.FilePrivatePart)"
    if ($peVersion.ProductVersion -ne [string]$buildVersion.semver_version -or
        $peNumericVersion -ne [string]$buildVersion.windows_file_version) {
      throw "Native binary version does not match the generated build identity: $versionedBinary"
    }
  }
  $pythonPackageVersion = (& $PythonExe -c "from importlib.metadata import version; print(version('fullmag'))" | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or (-not $PythonSyncRequired -and $pythonPackageVersion -ne [string]$buildVersion.pep440_version)) {
    throw "Installed Fullmag Python version does not match the generated build identity"
  }
  $nativeFdmDll = $null
  if ($useCuda) {
    $nativeFdmDll = Stage-NativeFdmDll
  }
  # Capture both ends of the build.  The default path refuses a binary built
  # from a different checkout snapshot; the explicit skip path preserves both
  # identities in the manifest and marks the receipt non-qualifying.
  $finalSourceIdentity = Get-SourceIdentity
  $sourceIdentityChanged = [string]$finalSourceIdentity.head_commit_full -ne $sourceCommit -or
      [string]$finalSourceIdentity.source_snapshot_sha256 -ne $sourceSnapshotSha256
  if ($RunMode -eq "workspace" -and $Frontend -eq "dev") {
    $sourceIdentityChanged = (Get-WindowsBackendSourceDigest) -ne $BackendSourceDigest
  }
  if ($sourceIdentityChanged -and -not $SkipLocalChanges) {
    throw "Fullmag source changed while the native runtime was building; rerun with build=True after the checkout is stable"
  }
  $workspaceExecutableHashes = [ordered]@{}
  if ($RunMode -eq "workspace") {
    $bundleNamesOutput = (& python -c "import sys; sys.path.insert(0, sys.argv[1]); from runtime_bundle import BINARY_NAMES; print('\n'.join(BINARY_NAMES))" $PSScriptRoot | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "Native executable inventory failed" }
    foreach ($bundleName in ($bundleNamesOutput.Trim() -split '\r?\n')) {
      $workspaceExecutableHashes[$bundleName] = Get-Sha256File (Join-Path (Split-Path -Parent $FullmagExe) $bundleName)
    }
  }
  $manifest = [ordered]@{
    schema_version = 1
    target_triple = $TargetTriple
    compiler_profile = $CargoCompilerProfile
    binary = $FullmagExe
    api_binary = $FullmagApiExe
    desktop_binary = if ($needsControlRoomToolchain) { $FullmagUiExe } else { $null }
    backend = if ($Backend -eq "auto") { "auto" } else { $Backend }
    cuda = $useCuda
    features = @(if ($useCuda) { "cuda" })
    native_fdm_dll = $nativeFdmDll
    workspace_namespace = $WorkspaceNamespace
    cuda_bin = $cudaBin
    cargo_target_dir = $TargetRoot
    volatile_build_storage = $VolatileBuild
    cache_root = $CacheRoot
    git_commit = $sourceCommit
    worktree_state = $sourceWorktreeState
    source_snapshot_sha256 = $sourceSnapshotSha256
    build_version = $buildVersion
    build_version_file = $versionRecordPath
    build_version_file_sha256 = Get-Sha256File $versionRecordPath
    installed_python_version = $pythonPackageVersion
    python_sync_required = [bool]$PythonSyncRequired
    executable_sha256 = $workspaceExecutableHashes
    dependency_source_sha256 = Get-WindowsBackendSourceDigest -Dependencies
    backend_source_sha256 = $BackendSourceDigest
    frontend_source_sha256 = $FrontendSourceDigest
    frontend_mode = $Frontend
    frontend_workspace_root = $FrontendWorkspaceRoot
    frontend_cache_root = $FrontendCacheRoot
    frontend_source_manifest = $FrontendSourceManifestPath
    frontend_source_manifest_sha256 = $FrontendSourceManifestSha256
    source_identity_check = if ($SkipLocalChanges) { "skipped" } else { "passed" }
    local_changes_check = $localChangesCheck
    source_commit_after = [string]$finalSourceIdentity.head_commit_full
    source_worktree_state_after = if ([bool]$finalSourceIdentity.source_snapshot_dirty) { "dirty" } else { "clean" }
    source_snapshot_sha256_after = [string]$finalSourceIdentity.source_snapshot_sha256
    node_version = if ($needsControlRoomToolchain) { (& node --version).Trim() } else { $null }
    pnpm_version = if ($needsControlRoomToolchain) { $PinnedPnpmVersion } else { $null }
    static_web_sha256 = if ($Frontend -eq "static") { Get-DirectorySha256 (Split-Path -Parent $StaticControlRoom) } else { $null }
    binary_sha256 = Get-Sha256File $FullmagExe
    api_binary_sha256 = Get-Sha256File $FullmagApiExe
    desktop_binary_sha256 = if ($needsControlRoomToolchain) { Get-Sha256File $FullmagUiExe } else { $null }
    native_fdm_dll_sha256 = if ($nativeFdmDll) { Get-Sha256File $nativeFdmDll } else { $null }
    built_at_utc = [string]$buildVersion.build_date_utc
  }
  Write-JsonAtomic -Path $ManifestPath -Value $manifest
}
else {
  if (-not (Test-Path -LiteralPath $FullmagExe -PathType Leaf)) {
    throw "Native Windows Fullmag binary is missing at $FullmagExe; rerun with build=True"
  }
  if (-not (Test-Path -LiteralPath $FullmagApiExe -PathType Leaf)) {
    throw "Native Windows Fullmag API binary is missing at $FullmagApiExe; rerun with build=True"
  }
  if ($Frontend -eq "static" -and -not (Test-Path -LiteralPath $StaticControlRoom -PathType Leaf)) {
    throw "Static Control Room is missing at $StaticControlRoom; rerun with build=True or use dev"
  }
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "Windows runtime build manifest is missing at $ManifestPath; rerun with build=True"
  }
  $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  $expectedNodeVersion = if ($needsControlRoomToolchain) { (& node --version).Trim() } else { $null }
  $expectedPnpmVersion = if ($needsControlRoomToolchain) { $PinnedPnpmVersion } else { $null }
  $manifestStructureMismatch = [int]$manifest.schema_version -ne 1 -or
      [string]$manifest.git_commit -notmatch '^[0-9a-f]{40}$' -or
      [string]$manifest.source_snapshot_sha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$manifest.compiler_profile -ne $CargoCompilerProfile -or
      [string]$manifest.workspace_namespace -ne $WorkspaceNamespace -or
      [string]$manifest.target_triple -ne $TargetTriple -or
      [string]$manifest.node_version -ne [string]$expectedNodeVersion -or
      [string]$manifest.pnpm_version -ne [string]$expectedPnpmVersion
  if ($RunMode -eq "workspace") {
    $manifestStructureMismatch = $manifestStructureMismatch -or [string]$manifest.frontend_mode -ne $Frontend -or
        [string]$manifest.build_version.schema -ne "fullmag.build-version.v1" -or
        [string]$manifest.build_version.git_commit -ne [string]$manifest.git_commit -or
        [string]$manifest.build_version.source_snapshot_sha256 -ne [string]$manifest.source_snapshot_sha256
  }
  $manifestSourceMismatch = [string]$manifest.git_commit -ne $sourceCommit -or
      [string]$manifest.worktree_state -ne $sourceWorktreeState -or
      [string]$manifest.source_snapshot_sha256 -ne $sourceSnapshotSha256
  if ($RunMode -eq "workspace" -and $Frontend -eq "dev") {
    $manifestSourceMismatch = [string]$manifest.backend_source_sha256 -ne $BackendSourceDigest
  }
  if ($manifestStructureMismatch -or
      (-not $SkipLocalChanges -and $manifestSourceMismatch)) {
    throw "Existing Windows runtime does not match the current source identity; rerun with build=True"
  }
  if (-not $SkipLocalChanges -and [string]$manifest.local_changes_check -eq "skipped") {
    throw "Existing Windows runtime was built with -SkipLocalChanges; rerun with -SkipLocalChanges to acknowledge the unqualified receipt"
  }
  $binaryHash = Get-Sha256File $FullmagExe
  $apiBinaryHash = Get-Sha256File $FullmagApiExe
  if ([string]$manifest.binary_sha256 -ne $binaryHash -or
      [string]$manifest.api_binary_sha256 -ne $apiBinaryHash) {
    throw "Existing Windows runtime binary hash does not match its manifest; rerun with build=True"
  }
  if ($needsControlRoomToolchain) {
    Assert-FullmagDesktopRuntime -Path $FullmagUiExe -ExpectedHash ([string]$manifest.desktop_binary_sha256)
  }
  if ($RunMode -eq "workspace") {
    $versionFile = Assert-FullmagStoragePath -Layout $StorageLayout -Path ([string]$manifest.build_version_file) -Label "build version file" -Parent $BuildRoot
    $frontendManifest = Assert-FullmagStoragePath -Layout $StorageLayout -Path ([string]$manifest.frontend_source_manifest) -Label "frontend source manifest" -Parent $BuildRoot
    if ([string]$manifest.build_version_file_sha256 -ne (Get-Sha256File $versionFile) -or
        [string]$manifest.frontend_source_manifest_sha256 -ne (Get-Sha256File $frontendManifest)) {
      throw "Native workspace metadata hash does not match the build manifest; rebuild the Windows workspace"
    }
  }
  if ($Frontend -eq "static" -and
      [string]$manifest.static_web_sha256 -ne (Get-DirectorySha256 (Split-Path -Parent $StaticControlRoom))) {
    throw "Existing static Control Room assets do not match the build manifest; rerun with build=True"
  }
  if ($useCuda) {
    if (-not [bool]$manifest.cuda) {
      throw "Existing Windows runtime was not built with CUDA; rerun with build=True; CPU fallback is forbidden"
    }
    $nativeDll = Join-Path (Split-Path -Parent $FullmagExe) "fullmag_fdm.dll"
    if (-not (Test-Path -LiteralPath $nativeDll -PathType Leaf)) {
      throw "Native CUDA backend DLL is missing at $nativeDll; rerun with build=True"
    }
    $nativeDllHash = Get-Sha256File $nativeDll
    if ([string]$manifest.native_fdm_dll_sha256 -ne $nativeDllHash) {
      throw "Native CUDA backend DLL hash does not match the build manifest; rerun with build=True"
    }
    if ($manifest.cuda_bin -and (Test-Path -LiteralPath $manifest.cuda_bin -PathType Container)) {
      Prepend-PathEntry $manifest.cuda_bin
    }
  }
}

if ($useCuda) {
  Test-NvidiaRuntime
  $env:FULLMAG_FDM_EXECUTION = "cuda"
}
elseif ($Device -eq "cpu") {
  $env:FULLMAG_FDM_EXECUTION = "cpu"
}
else {
  Remove-Item Env:FULLMAG_FDM_EXECUTION -ErrorAction SilentlyContinue
}

if ($BuildOnly) {
  Write-Host "Windows native Fullmag build is ready"
  Write-Host "- binary: $FullmagExe"
  Write-Host "- cargo target: $TargetRoot"
  Write-Host "- cache root: $CacheRoot"
  Write-Host "- rustup home: $RustupHome"
  exit 0
}

if ($RunMode -eq "workspace") {
  if (-not $FrontendWorkspaceRoot -or -not $FrontendCacheRoot) { throw "Native frontend workspace is missing from the build manifest" }
  if ([bool]$manifest.python_sync_required) {
    $env:FULLMAG_BUILD_VERSION_FILE = [string]$manifest.build_version_file
    $env:FULLMAG_BUILD_VERSION = [string]$manifest.build_version.semver_version
    Invoke-Uv @("pip", "install", "--python", $PythonExe, "--editable", (Join-Path $RepoRoot "packages\fullmag-py[meshing]"))
    $installedVersion = (& $PythonExe -c "from importlib.metadata import version; print(version('fullmag'))" | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $installedVersion -ne [string]$manifest.build_version.pep440_version) { throw "Deferred Python version sync failed" }
    $manifest.installed_python_version = $installedVersion
    $manifest.python_sync_required = $false
    Write-JsonAtomic -Path $ManifestPath -Value $manifest
  }
  $FullmagExe = Publish-NativeWorkspaceRuntime
  $env:FULLMAG_REPO_ROOT = $FrontendWorkspaceRoot
  $env:FULLMAG_FRONTEND_ROOT = $FrontendCacheRoot
  $env:FULLMAG_STATE_ROOT = Join-Path $StorageLayout.runtime_root "state"
  $env:FULLMAG_DEV_SOURCE_ROOT = if ($Frontend -eq "dev") { Join-Path $RepoRoot "apps\control-room" } else { "" }
  $workspaceArguments = @("ui", "--web-port", $WebPort.ToString())
  if ($Frontend -eq "dev") { $workspaceArguments += "--dev" }
  Push-Location $RepoRoot
  try {
    Invoke-External $FullmagExe $workspaceArguments
  }
  finally {
    Pop-Location
  }
  exit 0
}

if (-not $ScriptPath) {
  throw "ScriptPath is required unless -BuildOnly is used"
}

$resolvedScript = if ([System.IO.Path]::IsPathRooted($ScriptPath)) {
  Resolve-AbsolutePath $ScriptPath
}
else {
  Resolve-AbsolutePath (Join-Path $RepoRoot $ScriptPath)
}
if (-not (Test-Path -LiteralPath $resolvedScript -PathType Leaf)) {
  throw "Fullmag script not found: $resolvedScript"
}
$resolvedOutputDir = $null
if ($OutputDir) {
  $resolvedOutputDir = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
    Resolve-AbsolutePath $OutputDir
  }
  else {
    Resolve-AbsolutePath (Join-Path $RepoRoot $OutputDir)
  }
}

$cliArguments = @()
if ($Frontend -eq "dev") {
  $cliArguments += "--dev"
}
if ($RunMode -eq "interactive") {
  $cliArguments += "-i"
}
$cliArguments += $resolvedScript
if ($resolvedOutputDir) {
  $cliArguments += @("--output-dir", $resolvedOutputDir)
}
if ($InitialMagnetizationState) {
  $resolvedInitialState = if ([System.IO.Path]::IsPathRooted($InitialMagnetizationState)) {
    Resolve-AbsolutePath $InitialMagnetizationState
  }
  else {
    Resolve-AbsolutePath (Join-Path $RepoRoot $InitialMagnetizationState)
  }
  if (-not (Test-Path -LiteralPath $resolvedInitialState -PathType Leaf)) {
    throw "Initial magnetization state not found: $resolvedInitialState"
  }
  $cliArguments += @("--initial-magnetization-state", $resolvedInitialState)
  if ($InitialMagnetizationStateFormat) {
    $cliArguments += @("--initial-magnetization-state-format", $InitialMagnetizationStateFormat)
  }
  if ($InitialMagnetizationStateDataset) {
    $cliArguments += @("--initial-magnetization-state-dataset", $InitialMagnetizationStateDataset)
  }
  if ($null -ne $InitialMagnetizationStateSampleIndex) {
    # Clap treats a negative value passed as a separate argv item as another
    # option. Keep the option and value in one argv item so sample -1 reaches
    # the state reader unchanged.
    $cliArguments += "--initial-magnetization-state-sample-index=$($InitialMagnetizationStateSampleIndex.ToString())"
  }
}
if ($Backend -ne "auto") {
  $cliArguments += @("--backend", $Backend)
}
if ($RunMode -eq "headless") {
  $env:FULLMAG_API_PORT = "0"
  $cliArguments += @("--headless", "--json")
}
else {
  $cliArguments += @("--web-port", $WebPort.ToString())
}

Write-Host "Windows native Fullmag runtime"
Write-Host "- binary: $FullmagExe"
Write-Host "- script: $resolvedScript"
Write-Host "- backend: $Backend"
Write-Host "- device: $Device"
Write-Host "- cargo target: $TargetRoot"
Write-Host "- cache root: $CacheRoot"

Push-Location $RepoRoot
try {
  Invoke-External $FullmagExe $cliArguments
}
finally {
  Pop-Location
}
