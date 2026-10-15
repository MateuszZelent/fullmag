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

  # Explicit source-first Control Room host.  This is only valid for the
  # managed native FEM empty workspace; it must never widen FDM workspace
  # admission or invoke the desktop/Tauri surface.
  [switch]$Browser,

  # Build the single physical FEM GPU workspace package while publishing a
  # hash-bound capability manifest for all four runtime lanes.  The UI keeps
  # backend/device selection; this flag never selects a solver execution.
  [switch]$AllBackends,

  [switch]$SkipCompatibilityLinks,

  [Alias("skip_local_changes")]
  [switch]$SkipLocalChanges,

  # Internal build-to-launch handoff: pins a verified snapshot manifest.
  [string]$ExpectedBuildId,

  [ValidateRange(0, 65535)]
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
$AllBackendsRequested = [bool]$AllBackends
if ($AllBackendsRequested) {
  if ($RunMode -ne "workspace" -or $Backend -ne "auto" -or $Device -ne "auto") {
    throw "-AllBackends is only valid for an empty workspace with Backend=auto and Device=auto"
  }
  if ($ScriptPath -or $OutputDir -or $InitialMagnetizationState -or
      $InitialMagnetizationStateFormat -or $InitialMagnetizationStateDataset -or
      $null -ne $InitialMagnetizationStateSampleIndex) {
    throw "-AllBackends does not accept a simulation script, output, or initial state"
  }
  if ($BuildMode -eq "false" -and -not $ExpectedBuildId) {
    throw "-AllBackends runtime reuse requires ExpectedBuildId for the immutable capability manifest"
  }
}
$BrowserWorkspace = $Browser -and ($Backend -eq "fem" -or $AllBackendsRequested) -and $RunMode -eq "workspace"
$BrowserApiIsolation = $BrowserWorkspace -and ($AllBackendsRequested -or $Backend -eq "fem")
# Script-mode FEM needs the same private API ownership as the browser workspace,
# but headless runs must retain their disabled API contract.
$FemInteractiveApiIsolation = $RunMode -eq "interactive" -and $Backend -eq "fem"
if ($Browser -and -not $BrowserWorkspace) {
  throw "-Browser is only supported for the managed native FEM workspace"
}
if ($RunMode -eq "workspace" -and (
    $ScriptPath -or $OutputDir -or $InitialMagnetizationState -or
    $InitialMagnetizationStateFormat -or $InitialMagnetizationStateDataset -or
    $null -ne $InitialMagnetizationStateSampleIndex -or
    (($Backend -ne "auto") -and -not $BrowserWorkspace -and -not $AllBackendsRequested) -or
    (($Device -ne "auto") -and -not $BrowserWorkspace -and -not $AllBackendsRequested))) {
  throw "Workspace mode opens an empty authoring shell; choose backend/device in the UI and omit simulation inputs"
}
if ($Device -eq "gpu" -and $Backend -notin @("auto", "fdm", "fem")) {
  throw "device=gpu is only supported for the native Windows FDM or FEM lane"
}
if ($Backend -eq "fem" -and $RunMode -eq "workspace" -and -not $BrowserWorkspace -and -not $AllBackendsRequested) {
  throw "Native Windows FEM requires interactive or headless simulation mode"
}
if ($BuildMode -eq "auto" -and $RunMode -ne "workspace") {
  throw "Automatic build selection is supported only for the empty Windows workspace"
}
$SelectedBackendProfile = Resolve-WindowsBackendProfile `
  -RequestedProfile $BackendProfile -Frontend $Frontend -RunMode $RunMode
if ($AllBackendsRequested) {
  if ($SelectedBackendProfile -ne "release") {
    throw "-AllBackends requires the release native workspace profile"
  }
  # The physical package is built by the strict FEM GPU lane.  The original
  # auto/auto request is retained in the aggregate manifest and runtime env;
  # these internal values only select the producer build.
  $Backend = "fem"
  $Device = "gpu"
}
if ($SelectedBackendProfile -eq "dev" -and $RunMode -ne "workspace" -and $Device -ne "cpu") {
  throw "The dev backend profile is supported only for native Windows FDM CPU builds"
}
if ($RunMode -eq "workspace" -and $BuildOnly -and (
    -not $PSBoundParameters.ContainsKey("BackendProfile") -or
    $BackendProfile -eq "auto" -or $BuildMode -notin @("auto", "true"))) {
  throw "Workspace BuildOnly requires an explicit dev or release backend profile and BuildMode auto or true"
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if ($Backend -eq "fem" -and $env:FULLMAG_STORAGE_MANAGED_ENTRY -ne "1") {
  throw "Native Windows FEM must enter through scripts/windows/run_fullmag_fem.ps1 and the managed storage operation"
}
$NativeFemAttemptId = [string]$env:FULLMAG_NATIVE_FEM_ATTEMPT_ID
$NativeFemRequestedDevice = if ($env:FULLMAG_FEM_REQUESTED_DEVICE) {
  [string]$env:FULLMAG_FEM_REQUESTED_DEVICE
} else {
  $Device
}
if ($Backend -eq "fem") {
  if ($NativeFemAttemptId -notmatch '^[0-9a-f]{32}$') {
    throw "Native Windows FEM requires the managed attempt identity"
  }
  if ($NativeFemRequestedDevice -notin @("auto", "cpu", "gpu")) {
    throw "Native Windows FEM requested device provenance is invalid"
  }
}
$BuildSourceRoot = $RepoRoot
$BuildSnapshot = $null
$VolatileBuild = $null
function Get-WindowsBuildToolsRoot {
  if ($BuildSnapshot) { return (Join-Path $BuildSourceRoot "scripts\windows") }
  return $PSScriptRoot
}

function Get-NativeFemMsvcDesktopX64RedistRoot {
  if (-not $env:VCToolsRedistDir) { return $null }
  $redistRoot = Resolve-AbsolutePath ([string]$env:VCToolsRedistDir)
  if (-not (Test-Path -LiteralPath $redistRoot -PathType Container)) {
    throw "VCToolsRedistDir is not a canonical redistributable directory: $redistRoot"
  }
  # VCToolsRedistDir contains x86 and onecore siblings as well as the desktop
  # CRT.  Register only the vcvars64-selected desktop CRT tree so same-named
  # but incompatible images cannot compete during PE closure planning.
  $x64Root = Resolve-AbsolutePath (Join-Path $redistRoot "x64\Microsoft.VC143.CRT")
  $null = Assert-NativeFemPathChain -Path $x64Root -Base $redistRoot `
    -Label "MSVC desktop x64 redistributable root"
  $vcruntime = Join-Path $x64Root "vcruntime140.dll"
  $null = Assert-NativeFemPathChain -Path $vcruntime -Base $x64Root `
    -Label "MSVC desktop x64 vcruntime" -Leaf
  return $x64Root
}

function Invoke-CompilerInputsTool {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("materialize", "verify")][string]$Command,
    [Parameter(Mandatory = $true)][string]$RecordPath
  )
  $arguments = @($Command, "--record", $RecordPath, "--build-root", $BuildRoot)
  $useVolatile = $null -ne $VolatileBuild -and [bool]$VolatileBuild.enabled -and [bool]$VolatileBuild.compiler_inputs_enabled
  if ($useVolatile) {
    $arguments += @("--working-root", [string]$VolatileBuild.compiler_inputs_root)
  }

  $volatileRootWasSet = Test-Path "Env:FULLMAG_WINDOWS_VOLATILE_ROOT"
  $previousVolatileRoot = [Environment]::GetEnvironmentVariable("FULLMAG_WINDOWS_VOLATILE_ROOT", "Process")
  try {
    if ($useVolatile) {
      $env:FULLMAG_WINDOWS_VOLATILE_ROOT = [string]$VolatileBuild.root
    }
    $output = (& python -B (Join-Path (Get-WindowsBuildToolsRoot) "compiler_inputs.py") @arguments 2>&1 | Out-String)
    $exitCode = $LASTEXITCODE
  }
  finally {
    if ($volatileRootWasSet) {
      [Environment]::SetEnvironmentVariable("FULLMAG_WINDOWS_VOLATILE_ROOT", $previousVolatileRoot, "Process")
    }
    else {
      Remove-Item Env:FULLMAG_WINDOWS_VOLATILE_ROOT -ErrorAction SilentlyContinue
    }
  }
  if ($exitCode -ne 0) {
    throw "Compiler input $Command failed: $output"
  }
  try {
    return $output | ConvertFrom-Json
  }
  catch {
    throw "Compiler input $Command returned invalid JSON: $output"
  }
}
if ($ExpectedBuildId) {
  $expectedBuildHandoffAllowed =
    ($AllBackendsRequested -and $RunMode -eq "workspace" -and
      $SelectedBackendProfile -eq "release" -and $BuildMode -eq "false") -or
    ($RunMode -eq "workspace" -and $Backend -in @("auto", "fdm") -and
      $SelectedBackendProfile -in @("dev", "release") -and
      $Frontend -in @("dev", "static") -and $BuildMode -eq "false") -or
    ($BrowserWorkspace -and $SelectedBackendProfile -eq "release" -and
      $BuildMode -eq "false") -or
    ($Backend -eq "fem" -and $RunMode -in @("interactive", "headless") -and
      $SelectedBackendProfile -eq "release" -and $BuildMode -eq "false")
  if ($env:FULLMAG_STORAGE_MANAGED_ENTRY -ne "1" -or
      $ExpectedBuildId -notmatch '^[0-9a-f]{64}$' -or -not $expectedBuildHandoffAllowed) {
    throw "ExpectedBuildId requires the managed native build-to-launch handoff"
  }
}
$TargetTriple = "x86_64-pc-windows-msvc"

$StorageAdapter = Join-Path $RepoRoot "scripts\windows\fullmag_storage.ps1"
if (-not (Test-Path -LiteralPath $StorageAdapter -PathType Leaf)) {
  throw "Fullmag Windows storage adapter is missing: $StorageAdapter"
}
. $StorageAdapter
$StorageDevice = if ($Device -eq "gpu") { "gpu" } else { "cpu" }
$ExpectedStorageProfile = if ($Backend -eq "fem") {
  "windows-native-fem-$StorageDevice"
} elseif ($RunMode -eq "workspace" -or $SelectedBackendProfile -eq "dev") {
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
  $fixedFemProfiles = @("windows-native-fem-cpu", "windows-native-fem-gpu")
  if ($Backend -eq "fem" -and $requestedStorageProfile -ne $ExpectedStorageProfile) {
    throw "FULLMAG_STORAGE_PROFILE must match the selected native FEM device profile: $ExpectedStorageProfile"
  }
  if (($RunMode -eq "workspace" -or $SelectedBackendProfile -eq "dev") -and
      $requestedStorageProfile -ne $ExpectedStorageProfile) {
    throw "FULLMAG_STORAGE_PROFILE must match the selected native workspace compiler profile: $ExpectedStorageProfile"
  }
  if (($requestedStorageProfile -in $fixedWorkspaceProfiles -or $requestedStorageProfile -in $fixedFemProfiles) -and
      $requestedStorageProfile -ne $ExpectedStorageProfile) {
    throw "FULLMAG_STORAGE_PROFILE $requestedStorageProfile conflicts with the selected native lane"
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
  if ($Browser) { $managedArguments += "-Browser" }
  if ($AllBackendsRequested) { $managedArguments += "-AllBackends" }
  if ($SkipCompatibilityLinks) { $managedArguments += "-SkipCompatibilityLinks" }
  if ($SkipLocalChanges) { $managedArguments += "-SkipLocalChanges" }
  if ($AllBackendsRequested) {
    if ($RunMode -ne "workspace" -or -not $Browser -or $BuildMode -notin @("true", "false")) {
      throw "-AllBackends requires the closed Windows full workspace browser operation with BuildMode true or false"
    }
    $fullResolver = Join-Path $RepoRoot "scripts\fullmag_storage.py"
    if (-not (Test-Path -LiteralPath $fullResolver -PathType Leaf)) {
      throw "Full workspace storage resolver is missing: $fullResolver"
    }
    $fullPython = Get-Command "python" -ErrorAction SilentlyContinue
    if (-not $fullPython) {
      throw "Python is required to invoke the native full workspace operation"
    }
    $fullAction = if ($BuildOnly) {
      "run-windows-full-workspace-build"
    }
    else {
      "run-windows-full-workspace"
    }
    $fullArguments = @(
      $fullResolver, $fullAction, "--repo-root", $RepoRoot,
      "--full-frontend", $Frontend, "--full-web-port", $WebPort.ToString(),
      "--full-build-mode", $BuildMode
    )
    if ($SkipLocalChanges) { $fullArguments += "--full-skip-local-changes" }
    if (-not $BuildOnly -and $ExpectedBuildId) {
      $fullArguments += @("--full-expected-build-id", $ExpectedBuildId)
    }
    & $fullPython.Source @fullArguments | Out-Host
    exit [int]$LASTEXITCODE
  }

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

function Get-WindowsBuildRequirements {
  $requirementsPath = Join-Path $BuildSourceRoot "windows_build_requirements.json"
  if (-not (Test-Path -LiteralPath $requirementsPath -PathType Leaf)) {
    throw "Windows build requirements manifest is missing: $requirementsPath"
  }
  try {
    $requirements = Get-Content -LiteralPath $requirementsPath -Raw | ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    throw "Windows build requirements manifest is invalid: $requirementsPath ($($_.Exception.Message))"
  }
  if ([string]$requirements.schema_version -ne "fullmag.windows-build-requirements.v1" -or
      $null -eq $requirements.tools) {
    throw "Windows build requirements manifest has an incompatible schema: $requirementsPath"
  }
  return $requirements
}

function Get-PinnedUvVersion {
  $tool = $null
  $requirements = Get-WindowsBuildRequirements
  if ($requirements.tools.PSObject.Properties.Name -contains "uv") {
    $tool = $requirements.tools.PSObject.Properties["uv"].Value
  }
  $version = if ($null -ne $tool) { [string]$tool.version } else { "" }
  if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Windows build requirements do not define a valid pinned uv version"
  }
  return $version
}

function Assert-PinnedUvExecutable {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion
  )
  $versionOutput = (& $Path --version 2>&1 | Out-String).Trim()
  $exitCode = $LASTEXITCODE
  $versionPattern = '^uv\s+' + [regex]::Escape($ExpectedVersion) + '(?:\s|$)'
  if ($exitCode -ne 0 -or $versionOutput -notmatch $versionPattern) {
    throw "uv at $Path is not the pinned project version ${ExpectedVersion}: $versionOutput"
  }
}

function Invoke-Uv {
  param([Parameter()][string[]]$Arguments = @())
  $expectedVersion = Get-PinnedUvVersion
  $managedCandidates = @(
    (Join-Path $CacheRoot "tools\uv\Scripts\uv.exe"),
    # Keep the second layout for an already-provisioned project prefix whose
    # executable was placed at its root by an older setup helper.
    (Join-Path $CacheRoot "tools\uv\uv.exe")
  )
  foreach ($managedUv in $managedCandidates) {
    if (Test-Path -LiteralPath $managedUv -PathType Leaf) {
      Assert-PinnedUvExecutable -Path $managedUv -ExpectedVersion $expectedVersion
      Invoke-External $managedUv $Arguments
      return
    }
  }

  # Existing FDM users may already have an exact pinned uv on PATH.  Preserve
  # that compatible route, but never accept an unpinned global executable or
  # install an arbitrary version into a private fallback directory.
  $globalUv = Get-Command "uv.exe" -ErrorAction SilentlyContinue
  if ($globalUv) {
    $globalPath = if ($globalUv.Source) { [string]$globalUv.Source } else { [string]$globalUv.Path }
    Assert-PinnedUvExecutable -Path $globalPath -ExpectedVersion $expectedVersion
    Write-Warning "Using globally installed uv $expectedVersion because the project-managed uv is missing"
    Invoke-External $globalPath $Arguments
    return
  }
  throw "Project-managed uv $expectedVersion is missing; run scripts/windows/setup_build_environment.ps1 -Install"
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
  # A FEM build compiles from the sealed source snapshot. Keep browser
  # dependencies and static output beside that same source tree so the later
  # BuildMode=false handoff launches the frontend inputs that the binary used.
  # Workspace mode has its own staged root below the managed build profile.
  $dependencyWorkspace = if ($BuildSnapshot) { $BuildSourceRoot } else { $RepoRoot }
  $stagedFrontendRoot = $null
  if ($RunMode -eq "workspace") {
    # `0` means that the browser CLI chooses its own listener.  Frontend
    # staging still needs a nonzero cache key for Next dev; reserve one only
    # for the staged source tree and never publish it as the runtime port.
    $stageWebPort = $WebPort
    if ($Frontend -eq "dev" -and $stageWebPort -eq 0) {
      $stageListener = New-Object -TypeName System.Net.Sockets.TcpListener `
        -ArgumentList ([System.Net.IPAddress]::Loopback), 0
      try {
        $stageListener.Start()
        $stageWebPort = [int]$stageListener.LocalEndpoint.Port
      }
      finally {
        $stageListener.Stop()
      }
    }
    $stageArguments = @((Join-Path (Get-WindowsBuildToolsRoot) "stage_workspace_frontend.py"), "--repo-root", $BuildSourceRoot, "--build-root", $BuildRoot, "--mode", $Frontend)
    if ($Frontend -eq "dev") { $stageArguments += @("--web-port", $stageWebPort.ToString()) }
    if ($BuildSnapshot) { $stageArguments += @("--source-snapshot-record", [string]$BuildSnapshot.record_path) }
    $stageOutput = (& python -B @stageArguments 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "Native frontend staging failed: $stageOutput" }
    $stage = $stageOutput | ConvertFrom-Json
    $script:FrontendWorkspaceRoot = Assert-FullmagStoragePath -Layout $StorageLayout -Path ([string]$stage.workspace_root) -Label "native frontend workspace" -Parent $BuildRoot
    $script:FrontendCacheRoot = Assert-FullmagStoragePath -Layout $StorageLayout -Path ([string]$stage.frontend_root) -Label "native frontend cache" -Parent $BuildRoot
    $script:FrontendSourceManifestPath = [string]$stage.manifest_path
    $script:FrontendSourceManifestSha256 = [string]$stage.manifest_sha256
    $script:StaticControlRoom = Join-Path $FrontendWorkspaceRoot "apps\control-room\out\index.html"
    $stagedFrontendRoot = $FrontendCacheRoot
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
  $previousCiWasSet = Test-Path Env:CI
  $previousCi = [Environment]::GetEnvironmentVariable("CI", "Process")
  $previousFrontendRootWasSet = Test-Path Env:FULLMAG_FRONTEND_ROOT
  $previousFrontendRoot = [Environment]::GetEnvironmentVariable("FULLMAG_FRONTEND_ROOT", "Process")
  $locationPushed = $false
  try {
    $env:CI = "1"
    if ($stagedFrontendRoot) {
      $env:FULLMAG_FRONTEND_ROOT = $stagedFrontendRoot
    }
    Push-Location $dependencyWorkspace
    $locationPushed = $true
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
    try {
      if ($locationPushed) { Pop-Location }
    }
    finally {
      if ($previousFrontendRootWasSet) {
        $env:FULLMAG_FRONTEND_ROOT = $previousFrontendRoot
      } else {
        Remove-Item Env:FULLMAG_FRONTEND_ROOT -ErrorAction SilentlyContinue
      }
      if (-not $previousCiWasSet) {
        Remove-Item Env:CI -ErrorAction SilentlyContinue
      } else {
        $env:CI = $previousCi
      }
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
  # Keep the launcher aligned with rust-toolchain.toml and the setup manifest.
  # The managed Rustup home already owns this stable target; do not link an
  # unrelated user-profile nightly SDK into the build.
  $toolchain = "stable-x86_64-pc-windows-msvc"
  $env:RUSTUP_TOOLCHAIN = $toolchain
  if (-not (Test-Path -LiteralPath (Join-Path $RustupHome "toolchains\$toolchain\bin\rustc.exe") -PathType Leaf)) {
    throw "The managed stable Windows/MSVC Rust toolchain is missing; run scripts/windows/setup_build_environment.ps1 -Install"
  }
}

function Get-SourceIdentity {
  if ($BuildSnapshot) { return $BuildSnapshot.source_identity }
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
  if ($BuildSnapshot -and -not $FrontendSources) {
    if ($Dependencies) { return [string]$BuildSnapshot.dependency_source_sha256 }
    return [string]$BuildSnapshot.backend_source_sha256
  }
  $digestArguments = @("--repo-root", $RepoRoot)
  if ($FrontendSources) { $digestArguments += "--frontend" }
  if ($Dependencies) { $digestArguments += "--dependencies" }
  $output = (& python (Join-Path $PSScriptRoot "workspace_backend_identity.py") @digestArguments 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "Native workspace source fingerprint failed: $output" }
  $identity = $output | ConvertFrom-Json
  if ([string]$identity.sha256 -notmatch '^[0-9a-f]{64}$') { throw "Invalid native workspace source fingerprint" }
  return [string]$identity.sha256
}

function Read-BuildSnapshot {
  param([string]$RecordPath)
  $snapshotOutput = (& python -B (Join-Path (Get-WindowsBuildToolsRoot) "build_snapshot.py") verify --record $RecordPath --build-root $BuildRoot 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "Frozen build source verification failed: $snapshotOutput" }
  $snapshot = $snapshotOutput | ConvertFrom-Json
  if ([string]$snapshot.origin_repo_root -ne $RepoRoot) { throw "Frozen build source belongs to another checkout" }
  return $snapshot
}

function Install-FullmagPython {
  if (-not $BuildSnapshot) {
    Invoke-Uv @("pip", "install", "--python", $PythonExe, "--editable", (Join-Path $RepoRoot "packages\fullmag-py[meshing]"))
    return
  }
  # Setuptools creates egg-info/build metadata. Give it a separate writable
  # copy; immutable compiler sources and an active Python env stay untouched.
  $packageStage = Join-Path $PythonRoot ("package-builds\" + [Guid]::NewGuid().ToString("N"))
  $null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $packageStage -Label "Python package build source" -Parent $PythonRoot
  Ensure-Directory $packageStage
  Copy-Item -LiteralPath (Join-Path $BuildSourceRoot "packages\fullmag-py") -Destination $packageStage -Recurse
  $package = Join-Path $packageStage "fullmag-py"
  Get-ChildItem -LiteralPath $package -File -Recurse | ForEach-Object { $_.IsReadOnly = $false }
  Invoke-Uv @("pip", "install", "--python", $PythonExe, "$package[meshing]")
}

function Resolve-NativePublicationPython {
  # Windows venv python.exe is a redirector with its own child process. The
  # publisher must be a direct child of this launcher for the PID/nonce guard.
  $baseOutput = (& $PythonExe -B -c "import json, sys; print(json.dumps(sys._base_executable))" 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "Native publication Python probe failed: $baseOutput" }
  $basePython = $baseOutput | ConvertFrom-Json
  if ($basePython -isnot [string] -or [string]::IsNullOrWhiteSpace($basePython)) {
    throw "Native publication Python probe returned no base executable"
  }
  $basePython = Assert-FullmagStoragePath -Layout $StorageLayout -Path $basePython -Label "native publication Python" -Parent $PythonRoot
  if (-not (Test-Path -LiteralPath $basePython -PathType Leaf) -or
      [System.IO.Path]::GetExtension($basePython) -ne ".exe" -or
      (Get-Item -LiteralPath $basePython -Force).Length -eq 0) {
    throw "Native publication Python must be an existing nonempty managed executable"
  }
  return $basePython
}

function Publish-NativeWorkspaceRuntime {
  if (-not $env:FULLMAG_NATIVE_RUNTIME_READY_FILE -or
      $env:FULLMAG_NATIVE_RUNTIME_NONCE -notmatch '^[0-9a-f]{32}$') {
    throw "Native workspace runtime requires its managed publication handshake"
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
  $publicationPython = Resolve-NativePublicationPython
  $launchOutput = (& $publicationPython -B (Join-Path $PSScriptRoot "stable_launch.py") --repo-root $RepoRoot --bundle-root ([string]$bundle.bundle_root) --profile $SelectedBackendProfile 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "Stable native runtime publication failed: $launchOutput" }
  $launch = $launchOutput | ConvertFrom-Json
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
        ($RunMode -eq "workspace" -and -not $candidate.build_source_snapshot) -or
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
  $requirements = Get-WindowsBuildRequirements
  $cudaRequirement = $null
  if ($null -ne $requirements.tools -and
      $requirements.tools.PSObject.Properties.Name -contains "cuda") {
    $cudaRequirement = $requirements.tools.PSObject.Properties["cuda"].Value
  }
  $minimumCuda = if ($null -ne $cudaRequirement) { [string]$cudaRequirement.minimum } else { "" }
  if ($minimumCuda -notmatch '^\d+\.\d+\.\d+$') {
    throw "Windows build requirements do not define a valid CUDA minimum version"
  }
  $minimumCudaVersion = [version]$minimumCuda
  $candidates = @()
  $explicitCudaCompiler = [string]$env:CUDACXX
  if ($explicitCudaCompiler) {
    $candidates += $explicitCudaCompiler
  }
  else {
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
  }
  $seen = @{}
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      $resolved = Resolve-AbsolutePath $candidate
      $key = $resolved.ToLowerInvariant()
      if ($seen.ContainsKey($key)) { continue }
      $seen[$key] = $true
      $versionOutput = (& $resolved "--version" 2>&1 | Out-String).Trim()
      $exitCode = $LASTEXITCODE
      $versionMatch = [regex]::Match($versionOutput, '(?im)\brelease\s+(\d+)\.(\d+)|\bV(\d+)\.(\d+)(?:\.(\d+))?')
      $actualCudaVersion = $null
      if ($versionMatch.Success) {
        if ($versionMatch.Groups[1].Success) {
          $actualCudaVersion = [version]::new([int]$versionMatch.Groups[1].Value, [int]$versionMatch.Groups[2].Value, 0)
        }
        else {
          $patch = if ($versionMatch.Groups[5].Success) { [int]$versionMatch.Groups[5].Value } else { 0 }
          $actualCudaVersion = [version]::new([int]$versionMatch.Groups[3].Value, [int]$versionMatch.Groups[4].Value, $patch)
        }
      }
      if ($exitCode -eq 0 -and $null -ne $actualCudaVersion -and $actualCudaVersion -ge $minimumCudaVersion) {
        return $resolved
      }
      Write-Verbose "Ignoring CUDA compiler ${resolved}: version output did not satisfy minimum $minimumCuda"
    }
  }
  if ($explicitCudaCompiler) {
    throw "Explicit CUDACXX does not provide CUDA Toolkit $minimumCuda or newer; CPU fallback is forbidden for device=gpu"
  }
  throw "FDM GPU build requires nvcc from the CUDA Toolkit at least $minimumCuda; CPU fallback is forbidden for device=gpu"
}

function Test-NvidiaRuntime {
  Require-Command "nvidia-smi"
  & nvidia-smi -L | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "GPU FEM/FDM run requires a working NVIDIA driver/GPU; CPU fallback is forbidden"
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
  $destination = Assert-NativeFemCopyDestination -Path (Join-Path (Split-Path -Parent $FullmagExe) "fullmag_fdm.dll") `
    -Base $TargetRoot -Label "native FDM launch DLL"
  Copy-Item -LiteralPath $nativeDll -Destination $destination -Force
  return (Resolve-AbsolutePath $destination)
}

function Test-NativeFemPathWithin {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Base
  )
  $candidate = (Resolve-AbsolutePath $Path).TrimEnd('\')
  $root = (Resolve-AbsolutePath $Base).TrimEnd('\')
  return $candidate.Equals($root, [System.StringComparison]::OrdinalIgnoreCase) -or
    $candidate.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-NativeFemPathChain {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Base,
    [Parameter(Mandatory = $true)][string]$Label,
    [switch]$Leaf,
    [switch]$AllowHardLinkLeaf
  )
  $resolved = Resolve-AbsolutePath $Path
  $root = Resolve-AbsolutePath $Base
  if (-not (Test-NativeFemPathWithin -Path $resolved -Base $root)) {
    throw "$Label escapes its canonical root: $resolved"
  }
  $pathType = if ($Leaf) { "Leaf" } else { "Container" }
  if (-not (Test-Path -LiteralPath $resolved -PathType $pathType)) {
    throw "$Label is missing: $resolved"
  }
  $cursor = $resolved
  while ($true) {
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    $isReparsePoint = [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    $isDisallowedLink = $item.PSObject.Properties.Name -contains "LinkType" -and
      $item.LinkType -and -not ($AllowHardLinkLeaf -and $Leaf -and
      [string]$item.LinkType -eq "HardLink")
    if ($isReparsePoint -or $isDisallowedLink) {
      throw "$Label contains a junction or symlink: $cursor"
    }
    $comparisonCursor = $cursor.TrimEnd('\')
    $comparisonRoot = $root.TrimEnd('\')
    # Preserve a filesystem root such as C:\ while tolerating the trailing
    # separator commonly returned by vcvars64's VCToolsRedistDir.
    if ($comparisonCursor.Length -eq 2 -and $comparisonCursor[1] -eq ':') { $comparisonCursor += '\' }
    if ($comparisonRoot.Length -eq 2 -and $comparisonRoot[1] -eq ':') { $comparisonRoot += '\' }
    if ([string]::Equals($comparisonCursor, $comparisonRoot, [System.StringComparison]::OrdinalIgnoreCase)) { break }
    $parent = Split-Path -Parent $cursor
    if (-not $parent -or [string]::Equals($parent, $cursor, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "$Label has no safe canonical ancestor: $resolved"
    }
    $cursor = $parent
  }
  return $resolved
}

function Assert-NativeFemCopyDestination {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Base,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $resolved = Resolve-AbsolutePath $Path
  $root = Resolve-AbsolutePath $Base
  if (-not (Test-NativeFemPathWithin -Path $resolved -Base $root)) {
    throw "$Label escapes its canonical root: $resolved"
  }
  $parent = Split-Path -Parent $resolved
  $null = Assert-NativeFemPathChain -Path $parent -Base $root -Label "$Label parent"
  $existing = $null
  try {
    $existing = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
  }
  catch {
    if ($_.CategoryInfo.Category -ne "ObjectNotFound") {
      throw "$Label cannot be inspected before copy: $resolved ($($_.Exception.Message))"
    }
  }
  if ($null -eq $existing) { return $resolved }
  if ($existing.PSIsContainer) {
    throw "$Label destination is an existing directory; refusing overwrite: $resolved"
  }
  $null = Assert-NativeFemPathChain -Path $resolved -Base $root -Label $Label -Leaf
  return $resolved
}

function Assert-NativeFemStagedPeAudit {
  param(
    [Parameter(Mandatory = $true)][string]$AuditPath,
    [Parameter(Mandatory = $true)][string]$StageRoot,
    [AllowEmptyString()][string]$ExpectedAuditSha256 = "",
    [AllowEmptyString()][string]$LaunchRoot = "",
    [AllowEmptyString()][string]$LaunchBase = ""
  )
  $stage = Assert-NativeFemPathChain -Path $StageRoot -Base (Split-Path -Parent $StageRoot) `
    -Label "native FEM staged runtime"
  $audit = Assert-NativeFemPathChain -Path $AuditPath -Base (Split-Path -Parent $stage) `
    -Label "native FEM dependency audit" -Leaf
  $actualAuditSha256 = Get-Sha256File $audit
  if ($ExpectedAuditSha256 -and ($ExpectedAuditSha256 -notmatch '^[0-9a-f]{64}$' -or
      $actualAuditSha256 -ne $ExpectedAuditSha256.ToLowerInvariant())) {
    throw "Native FEM dependency audit hash does not match the build manifest; rerun with build=True"
  }
  try {
    $report = Get-Content -LiteralPath $audit -Raw | ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    throw "Native FEM dependency audit is invalid: $audit ($($_.Exception.Message))"
  }
  if ([int]$report.schema_version -ne 1 -or [string]$report.target -ne "x86_64-pc-windows-msvc" -or
      [string]$report.scope -ne "bin_pe_static_and_delay_imports" -or $null -eq $report.images) {
    throw "Native FEM dependency audit has an incompatible schema: $audit"
  }
  $records = @($report.images)
  if (-not $records.Count -or -not (@($records | Where-Object { [string]$_.path -match '^bin[\\/][^\\/]+$' } ).Count -eq $records.Count)) {
    throw "Native FEM dependency audit contains an invalid staged image path"
  }
  $seen = @{}
  foreach ($record in $records) {
    $relative = [string]$record.path
    $hash = [string]$record.sha256
    if ($hash -notmatch '^[0-9a-f]{64}$') { throw "Native FEM dependency audit contains an invalid image hash: $relative" }
    $name = $relative.Substring(4)
    $key = $name.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { throw "Native FEM dependency audit contains a duplicate image: $name" }
    $seen[$key] = $true
    $image = Assert-NativeFemPathChain -Path (Join-Path $stage $name) -Base $stage `
      -Label "native FEM staged image $name" -Leaf
    if ([System.IO.Path]::GetExtension($name).ToLowerInvariant() -notin @(".exe", ".dll")) {
      throw "Native FEM dependency audit contains a non-PE image: $relative"
    }
    if ((Get-Sha256File $image) -ne $hash.ToLowerInvariant()) {
      throw "Native FEM staged image hash does not match the dependency audit: $name"
    }
  }
  $actualImages = @(Get-ChildItem -LiteralPath $stage -File -Force | Where-Object {
    $_.Extension.ToLowerInvariant() -in @(".exe", ".dll")
  })
  foreach ($image in $actualImages) {
    if (-not $seen.ContainsKey($image.Name.ToLowerInvariant())) {
      throw "Native FEM staged PE image is missing from the dependency audit: $($image.Name)"
    }
  }
  if ($actualImages.Count -ne $seen.Count) {
    throw "Native FEM dependency audit does not cover every staged PE image"
  }
  if ($LaunchRoot) {
    if (-not $LaunchBase) { throw "Native FEM launch root requires a canonical storage base" }
    $launch = Assert-NativeFemPathChain -Path $LaunchRoot -Base $LaunchBase `
      -Label "native FEM launch runtime"
    foreach ($record in $records) {
      $name = ([string]$record.path).Substring(4)
      $launchImagePath = Join-Path $launch $name
      if ([System.IO.Path]::GetExtension($name).ToLowerInvariant() -eq ".exe") {
        $launchImage = Assert-NativeFemPathChain -Path $launchImagePath -Base $launch `
          -Label "native FEM launch image $name" -Leaf -AllowHardLinkLeaf
      }
      else {
        $launchImage = Assert-NativeFemPathChain -Path $launchImagePath -Base $launch `
          -Label "native FEM launch image $name" -Leaf
      }
      if ((Get-Sha256File $launchImage) -ne ([string]$record.sha256).ToLowerInvariant()) {
        throw "Native FEM launch image hash does not match the dependency audit: $name"
      }
    }
    $launchImages = @(Get-ChildItem -LiteralPath $launch -File -Force | Where-Object {
      $_.Extension.ToLowerInvariant() -in @(".exe", ".dll")
    })
    $unauditedLaunchImages = @($launchImages | Where-Object {
      -not $seen.ContainsKey($_.Name.ToLowerInvariant())
    })
    if ($launchImages.Count -ne $seen.Count -or $unauditedLaunchImages.Count -ne 0) {
      throw "Native FEM launch directory contains an unaudited PE image"
    }
  }
  return $actualAuditSha256
}

function Assert-NativeFemProviderInventory {
  param(
    [Parameter(Mandatory = $true)][object]$Receipt,
    [Parameter(Mandatory = $true)][string]$ProviderRoot,
    [Parameter(Mandatory = $true)][string]$Prefix
  )
  foreach ($kind in @("files", "tools")) {
    $entries = @($Receipt.$kind)
    if (-not $entries.Count) {
      throw "Native FEM provider receipt has an empty $kind inventory"
    }
    $base = if ($kind -eq "files") { $Prefix } else { $ProviderRoot }
    $seen = @{}
    foreach ($entry in $entries) {
      $path = [string]$entry.path
      $hash = [string]$entry.sha256
      if (-not [System.IO.Path]::IsPathRooted($path) -or
          $hash -notmatch '^[0-9a-f]{64}$') {
        throw "Native FEM provider receipt contains an invalid $kind inventory entry"
      }
      $resolved = Resolve-AbsolutePath $path
      if (-not (Test-NativeFemPathWithin -Path $resolved -Base $base)) {
        throw "Native FEM provider receipt $kind inventory escapes its canonical root: $path"
      }
      $key = $resolved.ToLowerInvariant()
      if ($seen.ContainsKey($key)) {
        throw "Native FEM provider receipt contains duplicate $kind inventory entry: $path"
      }
      $seen[$key] = $true
      $resolved = Assert-NativeFemPathChain -Path $resolved -Base $base `
        -Label "Native FEM provider receipt $kind inventory" -Leaf
      $item = Get-Item -LiteralPath $resolved -Force
      if (($entry.PSObject.Properties.Name -contains "size_bytes") -and
          [int64]$entry.size_bytes -ne [int64]$item.Length) {
        throw "Native FEM provider receipt size mismatch: $resolved"
      }
      if ((Get-Sha256File $resolved) -ne $hash) {
        throw "Native FEM provider receipt hash mismatch: $resolved"
      }
    }
    if ($kind -eq "files") {
      $null = Assert-NativeFemPathChain -Path $base -Base $base `
        -Label "Native FEM installed provider prefix"
      $providerDirectories = @(Get-ChildItem -LiteralPath $base -Directory -Recurse -Force -ErrorAction Stop)
      foreach ($directory in $providerDirectories) {
        $null = Assert-NativeFemPathChain -Path $directory.FullName -Base $base `
          -Label "Native FEM installed provider directory"
      }
      $providerFiles = @(Get-ChildItem -LiteralPath $base -File -Recurse -Force -ErrorAction Stop)
      foreach ($providerFile in $providerFiles) {
        $providerFilePath = Resolve-AbsolutePath $providerFile.FullName
        $providerFileKey = $providerFilePath.ToLowerInvariant()
        if (-not $seen.ContainsKey($providerFileKey)) {
          throw "Native FEM provider receipt installed-prefix inventory omits a file: $providerFilePath"
        }
      }
      if ($providerFiles.Count -ne $seen.Count) {
        throw "Native FEM provider receipt installed-prefix inventory does not exactly cover its files"
      }
    }
  }
}

function Assert-NativeFemProviderMpiReceipt {
  param(
    [Parameter(Mandatory = $true)][object]$Receipt,
    [Parameter(Mandatory = $true)][string]$ProviderRoot
  )
  if ([string]::IsNullOrWhiteSpace([string]$Receipt.mpi_include) -or
      [string]::IsNullOrWhiteSpace([string]$Receipt.mpi_library)) {
    throw "Native FEM provider receipt does not bind both MSMPI include and library paths"
  }
  $mpiInclude = Assert-NativeFemPathChain -Path ([string]$Receipt.mpi_include) -Base $ProviderRoot `
    -Label "Native FEM provider MSMPI include directory"
  $mpiLibrary = Assert-NativeFemPathChain -Path ([string]$Receipt.mpi_library) -Base $ProviderRoot `
    -Label "Native FEM provider MSMPI import library" -Leaf
  if ([IO.Path]::GetFileName($mpiLibrary) -ine "msmpi.lib") {
    throw "Native FEM provider receipt MSMPI library has the wrong filename: $mpiLibrary"
  }
  $mpiHeader = Assert-NativeFemPathChain -Path (Join-Path $mpiInclude "mpi.h") -Base $ProviderRoot `
    -Label "Native FEM provider MSMPI header" -Leaf
  $libraryTools = @($Receipt.tools | Where-Object {
    [string]::Equals((Resolve-AbsolutePath ([string]$_.path)), $mpiLibrary, [System.StringComparison]::OrdinalIgnoreCase)
  })
  $headerTools = @($Receipt.tools | Where-Object {
    [string]::Equals((Resolve-AbsolutePath ([string]$_.path)), $mpiHeader, [System.StringComparison]::OrdinalIgnoreCase)
  })
  if ($libraryTools.Count -ne 1 -or $headerTools.Count -ne 1) {
    throw "Native FEM provider receipt MSMPI paths are not bound to the hashed tools inventory"
  }
  [pscustomobject]@{ include = $mpiInclude; header = $mpiHeader; library = $mpiLibrary }
}

function Assert-NativeFemProviderZstd {
  param(
    [Parameter(Mandatory = $true)][object]$Receipt,
    [Parameter(Mandatory = $true)][object]$Requirements,
    [Parameter(Mandatory = $true)][string]$ProviderRoot
  )
  $helper = $null
  if ($null -ne $Requirements.provider_bootstrap -and
      $null -ne $Requirements.provider_bootstrap.internal_helpers) {
    $helper = $Requirements.provider_bootstrap.internal_helpers.zstd
  }
  $helperPropertyNames = if ($null -ne $helper) {
    @($helper.PSObject.Properties | ForEach-Object { $_.Name })
  } else { @() }
  if ($null -eq $helper -or
      $helperPropertyNames -notcontains "host_requirement" -or
      $helper.host_requirement -isnot [bool] -or
      [string]$helper.kind -ne "provider_bootstrap_internal_helper" -or
      [bool]$helper.host_requirement -or
      [string]$helper.managed_by -ne "scripts/windows/native_fem_dependencies.ps1") {
    throw "Windows build requirements do not define zstd as the managed internal FEM bootstrap helper"
  }
  $metadata = $Receipt.zstd
  if ($null -eq $metadata) { throw "Native FEM provider receipt is missing zstd helper metadata" }
  foreach ($name in @("kind", "version", "url", "archive", "archive_name", "archive_sha256", "executable", "executable_name", "executable_sha256", "decode_memory")) {
    if ([string]::IsNullOrWhiteSpace([string]$metadata.$name)) {
      throw "Native FEM provider receipt zstd metadata is incomplete: $name"
    }
  }
  if ([string]$metadata.kind -ne [string]$helper.kind -or
      [string]$metadata.version -ne [string]$helper.version -or
      [string]$metadata.url -ne [string]$helper.url -or
      [string]$metadata.archive_name -ne [string]$helper.archive -or
      [string]$metadata.archive_sha256 -ne [string]$helper.archive_sha256 -or
      [string]$metadata.executable_name -ne [string]$helper.executable_name -or
      [string]$metadata.decode_memory -ne [string]$helper.decode_memory) {
    throw "Native FEM provider receipt zstd metadata does not match the committed helper pin"
  }
  if ([string]$metadata.archive_sha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$metadata.executable_sha256 -notmatch '^[0-9a-f]{64}$') {
    throw "Native FEM provider receipt zstd metadata contains an invalid SHA256"
  }
  $archive = [string]$metadata.archive
  if (-not [System.IO.Path]::IsPathRooted($archive) -or
      -not (Test-NativeFemPathWithin -Path $archive -Base $ProviderRoot) -or
      [System.IO.Path]::GetFileName($archive) -ne [string]$helper.archive) {
    throw "Native FEM provider receipt zstd archive is outside the canonical provider root or has the wrong pin"
  }
  $archive = Assert-NativeFemPathChain -Path $archive -Base $ProviderRoot `
    -Label "Native FEM provider zstd archive" -Leaf
  if ((Get-Sha256File $archive) -ne ([string]$metadata.archive_sha256).ToLowerInvariant()) {
    throw "Native FEM provider zstd archive hash does not match the committed helper pin"
  }
  $executable = [string]$metadata.executable
  $toolRoot = Join-Path $ProviderRoot ("tools\" + [string]$helper.tool_directory)
  if (-not [System.IO.Path]::IsPathRooted($executable) -or
      -not (Test-NativeFemPathWithin -Path $executable -Base $toolRoot) -or
      [System.IO.Path]::GetFileName($executable) -ne [string]$helper.executable_name) {
    throw "Native FEM provider receipt zstd executable is outside the canonical helper directory or has the wrong name"
  }
  $matches = @($Receipt.tools | Where-Object {
    [string]::Equals([string]$_.path, $executable, [System.StringComparison]::OrdinalIgnoreCase)
  })
  if ($matches.Count -ne 1 -or
      [string]$matches[0].sha256 -ne [string]$metadata.executable_sha256) {
    throw "Native FEM provider receipt zstd executable is not bound to its hashed tools inventory"
  }
}

function Get-NativeFemBoostRequirement {
  # Read the Boost pin from the same frozen dependency helper that performed
  # the provider bootstrap.  Reuse must never validate against a later live
  # checkout whose requirements may have changed after the build snapshot.
  $dependencyScript = Join-Path $BuildSourceRoot "scripts\windows\native_fem_dependencies.ps1"
  if (-not (Test-Path -LiteralPath $dependencyScript -PathType Leaf)) {
    throw "Native FEM dependency helper is missing from the compiler source snapshot: $dependencyScript"
  }
  . $dependencyScript
  return Get-FullmagNativeFemBoostRequirement -SourceRoot $BuildSourceRoot
}

function Assert-NativeFemProviderBoost {
  param(
    [Parameter(Mandatory = $true)][object]$Receipt,
    [Parameter(Mandatory = $true)][string]$ProviderRoot
  )
  $requirement = Get-NativeFemBoostRequirement
  # Get-NativeFemBoostRequirement is intentionally evaluated against the
  # frozen source root.  Its dot-sourced helper functions are local to that
  # function scope, so load the validator again in this admission scope.
  # Always load the snapshot helper here: a pre-existing function from another
  # checkout or an earlier operation must never satisfy provider admission.
  $dependencyScript = Join-Path $BuildSourceRoot "scripts\windows\native_fem_dependencies.ps1"
  if (-not (Test-Path -LiteralPath $dependencyScript -PathType Leaf)) {
    throw "Native FEM dependency helper is missing from the compiler source snapshot: $dependencyScript"
  }
  . $dependencyScript
  $validator = Get-Command Assert-FullmagNativeFemBoostReceipt -CommandType Function `
    -ErrorAction SilentlyContinue
  if ($null -eq $validator -or $null -eq $validator.ScriptBlock) {
    throw "Native FEM Boost receipt validator could not be loaded from the compiler source snapshot"
  }
  return & $validator.ScriptBlock -Receipt $Receipt -Requirement $requirement `
    -ProviderRoot $ProviderRoot
}

function Assert-NativeFemProviderReceipt {
  param(
    [Parameter(Mandatory = $true)][bool]$Cuda,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$CudaArchitectures
  )
  $providerRoot = Join-Path $BuildRoot "fem-dependencies"
  $expectedPrefix = Join-Path $providerRoot "installed"
  $null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $providerRoot -Label "native FEM provider root" -Parent $BuildRoot
  $null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $expectedPrefix -Label "native FEM provider prefix" -Parent $providerRoot
  if (-not (Test-Path -LiteralPath $expectedPrefix -PathType Container)) {
    throw "Native FEM provider prefix is missing: $expectedPrefix"
  }
  $actualPrefix = [string]$env:FULLMAG_FEM_DEPENDENCY_PREFIX
  if (-not $actualPrefix -or -not [System.IO.Path]::IsPathRooted($actualPrefix) -or
      -not (Test-Path -LiteralPath $actualPrefix -PathType Container)) {
    throw "Native FEM requires an absolute existing FULLMAG_FEM_DEPENDENCY_PREFIX"
  }
  $actualPrefix = (Resolve-AbsolutePath $actualPrefix).TrimEnd('\')
  $canonicalPrefix = (Resolve-AbsolutePath $expectedPrefix).TrimEnd('\')
  if (-not $actualPrefix.Equals($canonicalPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "FULLMAG_FEM_DEPENDENCY_PREFIX must be the canonical managed provider prefix: $expectedPrefix"
  }

  $receiptPath = Join-Path $providerRoot "provider-receipt.json"
  $receiptPath = Assert-NativeFemPathChain -Path $receiptPath -Base $providerRoot `
    -Label "Native FEM provider receipt" -Leaf
  try {
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    throw "Native FEM provider receipt is invalid: $receiptPath ($($_.Exception.Message))"
  }
  if ([string]$receipt.schema -ne "fullmag.windows.fem-providers.v1" -or $null -eq $receipt.plan) {
    throw "Native FEM provider receipt has an incompatible schema"
  }
  $receiptRoot = (Resolve-AbsolutePath ([string]$receipt.plan.root)).TrimEnd('\')
  $canonicalRoot = (Resolve-AbsolutePath $providerRoot).TrimEnd('\')
  if (-not (Test-NativeFemPathWithin -Path $receiptRoot -Base $providerRoot) -or
      -not $receiptRoot.Equals($canonicalRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Native FEM provider receipt root is not canonical"
  }
  $receiptPrefix = (Resolve-AbsolutePath ([string]$receipt.plan.prefix)).TrimEnd('\')
  if (-not $receiptPrefix.Equals($canonicalPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Native FEM provider receipt prefix is not canonical"
  }
  if ([bool]$receipt.plan.cuda -ne $Cuda) {
    throw "Native FEM provider receipt CUDA mode does not match the requested lane"
  }
  $receiptArchitectures = [string]$receipt.plan.cuda_architectures
  if ($Cuda) {
    if ($CudaArchitectures -notmatch '^\d+(;\d+)*$' -or $receiptArchitectures -ne $CudaArchitectures) {
      throw "Native FEM provider receipt CUDA architectures do not match the requested list"
    }
  }
  elseif (-not [string]::IsNullOrWhiteSpace($receiptArchitectures)) {
    throw "CPU native FEM provider receipt must not contain CUDA architectures"
  }

  $requirements = Get-WindowsBuildRequirements
  foreach ($name in @("hypre", "mfem", "libceed")) {
    $tool = $requirements.tools.PSObject.Properties[$name].Value
    $expectedVersion = if ($null -ne $tool) { [string]$tool.version } else { "" }
    $expectedCommit = if ($null -ne $tool) { [string]$tool.commit } else { "" }
    $matches = @($receipt.plan.providers | Where-Object { [string]$_.name -eq $name })
    if ($matches.Count -ne 1 -or [string]$matches[0].version -ne $expectedVersion -or
        [string]$matches[0].sha -ne $expectedCommit) {
      throw "Native FEM provider receipt does not match the pinned $name provider"
    }
  }
  $null = Assert-NativeFemProviderBoost -Receipt $receipt -ProviderRoot $providerRoot
  Assert-NativeFemProviderInventory -Receipt $receipt -ProviderRoot $providerRoot -Prefix $expectedPrefix
  $null = Assert-NativeFemProviderMpiReceipt -Receipt $receipt -ProviderRoot $providerRoot
  Assert-NativeFemProviderZstd -Receipt $receipt -Requirements $requirements -ProviderRoot $providerRoot
  $env:FULLMAG_FEM_DEPENDENCY_PREFIX = $actualPrefix
  return $receipt
}

function Assert-NativeFemProviderArtifacts {
  param(
    [Parameter(Mandatory = $true)][string]$ProviderConfigPath,
    [Parameter(Mandatory = $true)][string]$ProviderConfigSha256,
    [Parameter(Mandatory = $true)][string]$ProviderReceiptPath,
    [Parameter(Mandatory = $true)][string]$ProviderReceiptSha256
  )
  $providerRoot = Join-Path $BuildRoot "fem-dependencies"
  $providerPrefix = Join-Path $providerRoot "installed"
  $null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $providerRoot `
    -Label "native FEM provider root" -Parent $BuildRoot
  $null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $providerPrefix `
    -Label "native FEM provider prefix" -Parent $providerRoot
  $config = Assert-NativeFemPathChain -Path $ProviderConfigPath -Base $providerPrefix `
    -Label "native FEM provider config" -Leaf
  $receipt = Assert-NativeFemPathChain -Path $ProviderReceiptPath -Base $providerRoot `
    -Label "native FEM provider receipt" -Leaf
  $expectedReceipt = Assert-NativeFemPathChain -Path (Join-Path $providerRoot "provider-receipt.json") `
    -Base $providerRoot -Label "native FEM canonical provider receipt" -Leaf
  if ((Resolve-AbsolutePath $receipt) -ine (Resolve-AbsolutePath $expectedReceipt)) {
    throw "Native FEM provider receipt path is not canonical"
  }
  if ($ProviderConfigSha256 -notmatch '^[0-9a-fA-F]{64}$' -or
      $ProviderReceiptSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw "Native FEM provider provenance contains an invalid SHA256"
  }
  $actualConfigSha256 = Get-Sha256File $config
  $actualReceiptSha256 = Get-Sha256File $receipt
  if ($actualConfigSha256 -ne $ProviderConfigSha256.ToLowerInvariant()) {
    throw "Native FEM provider config hash does not match its build provenance"
  }
  if ($actualReceiptSha256 -ne $ProviderReceiptSha256.ToLowerInvariant()) {
    throw "Native FEM provider receipt hash does not match its build provenance"
  }
  try {
    $receiptObject = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    throw "Native FEM provider receipt is invalid: $receipt ($($_.Exception.Message))"
  }
  $null = Assert-NativeFemProviderMpiReceipt -Receipt $receiptObject -ProviderRoot $providerRoot
  $null = Assert-NativeFemProviderBoost -Receipt $receiptObject -ProviderRoot $providerRoot
  return [ordered]@{
    provider_config = $config
    provider_config_sha256 = $actualConfigSha256
    provider_receipt_path = $receipt
    provider_receipt_sha256 = $actualReceiptSha256
  }
}


function Invoke-NativeFemBuild {
  param([Parameter(Mandatory = $true)][string]$SourceRoot)
  $helper = Join-Path (Get-WindowsBuildToolsRoot) "native_fem_package.ps1"
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    throw "Native FEM package helper is missing: $helper"
  }
  # The provider bootstrap is part of the closed managed FEM operation.  An
  # explicit prefix is accepted only when it already exists; an empty prefix
  # is materialized under this operation's canonical build root.  CUDA
  # architectures come from the requested process environment or the live
  # NVIDIA driver, never from a host-specific hardcoded value.
  if ($useCuda) {
    if ($env:FULLMAG_CUDA_ARCHITECTURES) {
      if ($env:FULLMAG_CUDA_ARCHITECTURES -notmatch '^\d+(;\d+)*$') {
        throw "FULLMAG_CUDA_ARCHITECTURES must be a numeric semicolon-separated list"
      }
    }
    else {
      $nvidiaSmi = Get-Command "nvidia-smi.exe" -ErrorAction SilentlyContinue
      if (-not $nvidiaSmi) { $nvidiaSmi = Get-Command "nvidia-smi" -ErrorAction SilentlyContinue }
      if (-not $nvidiaSmi) {
        throw "Native FEM GPU build requires nvidia-smi.exe or explicit FULLMAG_CUDA_ARCHITECTURES"
      }
      $capabilityLines = @(& $nvidiaSmi.Source "--query-gpu=compute_cap" "--format=csv,noheader" 2>$null)
      if ($LASTEXITCODE -ne 0 -or -not $capabilityLines.Count) {
        throw "Native FEM GPU build could not query CUDA compute capabilities; set FULLMAG_CUDA_ARCHITECTURES explicitly"
      }
      $architectures = @()
      foreach ($line in $capabilityLines) {
        $capability = ([string]$line).Trim()
        if ($capability -match '^([0-9]+)\.([0-9]+)') {
          $architectures += ($matches[1] + $matches[2])
        }
        elseif ($capability -match '^\d+$') {
          $architectures += $capability
        }
        else {
          throw "Native FEM GPU build returned an invalid CUDA compute capability: $capability"
        }
      }
      $architectures = @($architectures | Where-Object { $_ } | Sort-Object -Unique)
      if (-not $architectures.Count) {
        throw "Native FEM GPU build returned no usable CUDA compute capabilities"
      }
      $env:FULLMAG_CUDA_ARCHITECTURES = $architectures -join ";"
    }
  }
  if (-not $env:FULLMAG_FEM_DEPENDENCY_PREFIX) {
    $dependencyBootstrap = Join-Path (Get-WindowsBuildToolsRoot) "native_fem_dependencies.ps1"
    if (-not (Test-Path -LiteralPath $dependencyBootstrap -PathType Leaf)) {
      throw "Native FEM dependency bootstrap is missing: $dependencyBootstrap"
    }
    . $dependencyBootstrap
    $cudaArchitectures = if ($useCuda) { [string]$env:FULLMAG_CUDA_ARCHITECTURES } else { "" }
    $env:FULLMAG_FEM_DEPENDENCY_PREFIX = Invoke-FullmagNativeFemDependencies `
      -RepoRoot $RepoRoot -SourceRoot $SourceRoot -StorageLayout $StorageLayout `
      -Cuda:$useCuda -CudaArchitectures $cudaArchitectures
  }
  $providerCudaArchitectures = if ($useCuda) { [string]$env:FULLMAG_CUDA_ARCHITECTURES } else { "" }
  $providerReceipt = Assert-NativeFemProviderReceipt -Cuda:$useCuda `
    -CudaArchitectures $providerCudaArchitectures
  . $helper
  $previousStack = $env:FULLMAG_USE_MFEM_STACK
  $previousCuda = $env:FULLMAG_FEM_ENABLE_CUDA
  $previousRequire = $env:FULLMAG_FEM_REQUIRE_GPU
  if (-not $env:FULLMAG_FEM_WITH_SLEPC) { $env:FULLMAG_FEM_WITH_SLEPC = "OFF" }
  $env:FULLMAG_USE_MFEM_STACK = "ON"
  $env:FULLMAG_FEM_ENABLE_CUDA = if ($useCuda) { "ON" } else { "OFF" }
  $env:FULLMAG_FEM_REQUIRE_GPU = if ($useCuda) { "ON" } else { "OFF" }
  try {
    $plan = Get-FullmagMsiBuildPlan -FemMode $Device -Cuda:$useCuda `
      -DependencyPrefix $env:FULLMAG_FEM_DEPENDENCY_PREFIX
    $output = Invoke-FullmagMsiFemBuild -Plan $plan -RepoRoot $SourceRoot -BuildRoot $nativeFemBuildRoot
    $output | Add-Member -NotePropertyName provider_receipt -NotePropertyValue $providerReceipt -Force
    $providerReceiptPath = Assert-NativeFemPathChain `
      -Path (Join-Path (Join-Path $BuildRoot "fem-dependencies") "provider-receipt.json") `
      -Base (Join-Path $BuildRoot "fem-dependencies") -Label "native FEM provider receipt" -Leaf
    $output | Add-Member -NotePropertyName provider_receipt_path -NotePropertyValue $providerReceiptPath -Force
    $output | Add-Member -NotePropertyName provider_receipt_sha256 -NotePropertyValue (Get-Sha256File $providerReceiptPath) -Force
    $script:NativeFemPlan = $plan
    $script:NativeFemOutput = $output
    $env:FULLMAG_FEM_LIB_DIR = [string]$output.directory
    return $output
  }
  finally {
    if ($null -eq $previousStack) { Remove-Item Env:FULLMAG_USE_MFEM_STACK -ErrorAction SilentlyContinue }
    else { $env:FULLMAG_USE_MFEM_STACK = $previousStack }
    if ($null -eq $previousCuda) { Remove-Item Env:FULLMAG_FEM_ENABLE_CUDA -ErrorAction SilentlyContinue }
    else { $env:FULLMAG_FEM_ENABLE_CUDA = $previousCuda }
    if ($null -eq $previousRequire) { Remove-Item Env:FULLMAG_FEM_REQUIRE_GPU -ErrorAction SilentlyContinue }
    else { $env:FULLMAG_FEM_REQUIRE_GPU = $previousRequire }
  }
}

# Windows PowerShell 5 serializes argument arrays into a command line.  Quote
# path arguments explicitly, including the doubled trailing separator required
# before a closing quote, so a CUDA/MSVC root with spaces cannot swallow the
# following planner switch.
function ConvertTo-NativeProcessArgument {
  param([AllowEmptyString()][string]$Value)
  if ($null -eq $Value) { return '""' }
  if ($Value.IndexOf('"') -ge 0) {
    throw "Native process arguments cannot contain embedded quotes: $Value"
  }
  if ($Value.Length -gt 0 -and $Value -notmatch '\s') { return $Value }
  $trailingSlashCount = 0
  for ($index = $Value.Length - 1; $index -ge 0; $index--) {
    if ($Value[$index] -ne '\') { break }
    $trailingSlashCount++
  }
  $trailingSlashes = if ($trailingSlashCount -gt 0) {
    ('\' * $trailingSlashCount) -join ''
  } else {
    ''
  }
  return '"' + $Value + $trailingSlashes + '"'
}

function Invoke-NativePythonWithArguments {
  param(
    [Parameter(Mandatory = $true)][string]$PythonPath,
    [Parameter()][string[]]$Arguments = @()
  )
  if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
    throw "Python executable is missing: $PythonPath"
  }
  # Native planner imports must never write bytecode into the frozen tools
  # tree.  Keep this switch before the caller-supplied arguments so the
  # helper remains responsible for every Python invocation at this boundary.
  $nativeArguments = @('-B') + @($Arguments | ForEach-Object {
    ConvertTo-NativeProcessArgument -Value ([string]$_)
  })
  $argumentLine = $nativeArguments -join ' '
  $process = Start-Process -FilePath $PythonPath -ArgumentList $argumentLine -NoNewWindow -Wait -PassThru
  try {
    return [int]$process.ExitCode
  }
  finally {
    $process.Dispose()
  }
}
function Stage-NativeFemRuntime {
  param([Parameter(Mandatory = $true)]$FemOutput)
  if (-not $FemOutput.dll -or -not (Test-Path -LiteralPath ([string]$FemOutput.dll) -PathType Leaf)) {
    throw "Native FEM build did not produce fullmag_fem.dll"
  }
  if (-not $FemOutput.dll_sha256 -or -not $FemOutput.import_library_sha256) {
    throw "Native FEM build output is missing immutable hashes"
  }
  $providerProvenance = Assert-NativeFemProviderArtifacts `
    -ProviderConfigPath ([string]$FemOutput.provider_config) `
    -ProviderConfigSha256 ([string]$FemOutput.provider_config_sha256) `
    -ProviderReceiptPath ([string]$FemOutput.provider_receipt_path) `
    -ProviderReceiptSha256 ([string]$FemOutput.provider_receipt_sha256)
  $sourceFemDll = Assert-NativeFemPathChain -Path ([string]$FemOutput.dll) -Base $nativeFemBuildRoot `
    -Label "native FEM build DLL" -Leaf
  $expectedFemDllSha256 = ([string]$FemOutput.dll_sha256).ToLowerInvariant()
  if ($expectedFemDllSha256 -notmatch '^[0-9a-f]{64}$' -or
      (Get-Sha256File $sourceFemDll) -ne $expectedFemDllSha256) {
    throw "Native FEM build DLL hash changed before staging"
  }
  $stageRoot = Join-Path $FemRuntimeRoot "bin"
  Ensure-Directory $stageRoot
  $null = Assert-NativeFemPathChain -Path $stageRoot -Base $FemRuntimeRoot `
    -Label "native FEM staged runtime"
  $launchRoot = Assert-NativeFemPathChain -Path (Split-Path -Parent $FullmagExe) -Base $TargetRoot `
    -Label "native FEM launch runtime"
  # Cargo's release binaries are hardlinks to release\deps.  Read and hash
  # those source leaves with the narrow exception in Assert-NativeFemPathChain;
  # every staging and copy destination remains strict.  The complete runtime
  # family is required for both narrow FEM and aggregate builds because Cargo
  # emits the accepted worker/scheduler binaries in every release profile.
  $runtimeFamilyNames = @(Get-FullmagFullPackageCanonicalRuntimeNames `
    -IncludeDesktop:$needsDesktopRuntime -ToolsRoot (Get-WindowsBuildToolsRoot))
  $stageBinaries = @($runtimeFamilyNames | ForEach-Object { Join-Path $launchRoot $_ })
  if (-not $runtimeFamilyNames -or $runtimeFamilyNames.Count -eq 0 -or
      -not @($runtimeFamilyNames | Where-Object { $_ -ieq (Split-Path -Leaf $FullmagExe) }).Count -or
      -not @($runtimeFamilyNames | Where-Object { $_ -ieq (Split-Path -Leaf $FullmagApiExe) }).Count) {
    throw "Canonical native FEM runtime family is missing the Fullmag and API executables"
  }
  $sourceLaunchBinaryPaths = @{}
  foreach ($binary in @($stageBinaries | Select-Object -Unique)) {
    $sourceBinary = Assert-NativeFemPathChain -Path $binary -Base $TargetRoot `
      -Label "native FEM staged runtime binary" -Leaf -AllowHardLinkLeaf
    $sourceLaunchBinaryPaths[(Split-Path -Leaf $binary).ToLowerInvariant()] = $sourceBinary
    $destination = Assert-NativeFemCopyDestination -Path (Join-Path $stageRoot (Split-Path -Leaf $binary)) `
      -Base $FemRuntimeRoot -Label "native FEM staged binary"
    Copy-Item -LiteralPath $sourceBinary -Destination $destination -Force
  }
  $femDllDestination = Assert-NativeFemCopyDestination -Path (Join-Path $stageRoot "fullmag_fem.dll") `
    -Base $FemRuntimeRoot -Label "native FEM staged backend DLL"
  Copy-Item -LiteralPath $sourceFemDll -Destination $femDllDestination -Force
  $dumpbin = Get-Command "dumpbin.exe" -ErrorAction SilentlyContinue
  if (-not $dumpbin) { throw "Native FEM DLL staging requires dumpbin.exe from the MSVC environment" }
  $planPath = Join-Path $FemRuntimeRoot "windows-pe-dependency-plan.json"
  $dependencyRoots = @()
  . (Join-Path (Get-WindowsBuildToolsRoot) "native_fem_package.ps1")
  $dependencyRoots += @(Get-FullmagMsiFemDependencyRoots -Plan $NativeFemPlan)
  # The FEM feature set also links the FDM ABI.  Its Cargo build-script output
  # is outside the FEM provider prefix, so include the frozen FDM build tree
  # and source-root compatibility location in the explicit closure roots.
  $dependencyRoots += @(
    (Join-Path $nativeFdmBuildRoot "backends\fdm\Release"),
    (Join-Path $BuildSourceRoot "backends\fdm")
  )
  $msvcX64RedistRoot = Get-NativeFemMsvcDesktopX64RedistRoot
  if ($msvcX64RedistRoot) { $dependencyRoots += $msvcX64RedistRoot }
  if ($env:CUDA_PATH) { $dependencyRoots += (Join-Path $env:CUDA_PATH "bin") }
  if ($env:CUDACXX) { $dependencyRoots += (Split-Path -Parent $env:CUDACXX) }
  $dependencyRoots = @($dependencyRoots | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } | Sort-Object -Unique)
  if (-not $dependencyRoots.Count) { throw "Native FEM dependency roots are empty; refusing an unclosed runtime" }
  $planArguments = @(
    (Join-Path (Get-WindowsBuildToolsRoot) "plan_pe_dependencies.py"),
    "--bin", $stageRoot, "--dumpbin", $dumpbin.Source, "--output", $planPath
  )
  foreach ($root in $dependencyRoots) { $planArguments += @("--dependency-root", $root) }
  if ($useCuda) { $planArguments += "--allow-cuda-driver" }
  $planExitCode = Invoke-NativePythonWithArguments -PythonPath $PythonExe -Arguments $planArguments
  if ($planExitCode -ne 0) { throw "Native FEM PE dependency planning failed with exit code $planExitCode" }
  $pePlan = Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
  foreach ($source in $pePlan.sources) {
    $destination = Assert-NativeFemCopyDestination -Path (Join-Path $stageRoot ([string]$source.name)) `
      -Base $FemRuntimeRoot -Label "native FEM staged dependency"
    Copy-Item -LiteralPath ([string]$source.source) -Destination $destination -Force
    if ((Get-Sha256File $destination) -ne [string]$source.sha256) {
      throw "Native FEM dependency changed during staging: $($source.name)"
    }
  }
  $auditPath = Join-Path $FemRuntimeRoot "windows-pe-dependencies.json"
  $auditArguments = @(
    (Join-Path (Get-WindowsBuildToolsRoot) "verify_pe_dependencies.py"),
    "--bin", $stageRoot, "--dumpbin", $dumpbin.Source, "--output", $auditPath
  )
  if ($useCuda) { $auditArguments += "--allow-cuda-driver" }
  $auditExitCode = Invoke-NativePythonWithArguments -PythonPath $PythonExe -Arguments $auditArguments
  if ($auditExitCode -ne 0) { throw "Native FEM PE dependency audit failed with exit code $auditExitCode" }
  $auditSha256 = Assert-NativeFemStagedPeAudit -AuditPath $auditPath -StageRoot $stageRoot
  foreach ($path in Get-ChildItem -LiteralPath $stageRoot -File) {
    $nameKey = $path.Name.ToLowerInvariant()
    if ($sourceLaunchBinaryPaths.ContainsKey($nameKey)) {
      # Never overwrite Cargo's hardlinked launch EXE.  The staged copy and
      # the exact launch source must still have the audited bytes.
      $sourceLaunchBinary = [string]$sourceLaunchBinaryPaths[$nameKey]
      $launchPath = Resolve-AbsolutePath (Join-Path $launchRoot $path.Name)
      if ([System.IO.Path]::GetFullPath($sourceLaunchBinary) -ine $launchPath -or
          (Get-Sha256File $sourceLaunchBinary) -ne (Get-Sha256File $path.FullName)) {
        throw "Native FEM launch executable changed during staging: $($path.Name)"
      }
      continue
    }
    $destination = Assert-NativeFemCopyDestination -Path (Join-Path $launchRoot $path.Name) `
      -Base $TargetRoot -Label "native FEM launch binary"
    Copy-Item -LiteralPath $path.FullName -Destination $destination -Force
  }
  $null = Assert-NativeFemStagedPeAudit -AuditPath $auditPath -StageRoot $stageRoot `
    -ExpectedAuditSha256 $auditSha256 -LaunchRoot $launchRoot -LaunchBase $TargetRoot
  $launchFemDll = Assert-NativeFemPathChain -Path (Join-Path $launchRoot "fullmag_fem.dll") -Base $launchRoot `
    -Label "native FEM launch DLL" -Leaf
  if ((Get-Sha256File $launchFemDll) -ne $expectedFemDllSha256) {
    throw "Native FEM launch DLL hash does not match the built FEM DLL"
  }
  $runtimeFamily = @()
  $runtimeFamilyInventorySha256 = $null
  foreach ($name in $runtimeFamilyNames) {
    $familyPath = Assert-NativeFemPathChain -Path (Join-Path $launchRoot $name) -Base $TargetRoot `
      -Label "native FEM runtime family binary" -Leaf -AllowHardLinkLeaf
    $familyItem = Get-Item -LiteralPath $familyPath -Force -ErrorAction Stop
    $runtimeFamily += [ordered]@{
      name = $name
      path = [System.IO.Path]::GetFullPath($familyPath)
      size_bytes = [int64]$familyItem.Length
      sha256 = Get-Sha256File $familyPath
    }
  }
  $runtimeFamilyInventorySha256 = Get-FullmagFullPackageRuntimeFamilyInventorySha256 -Artifacts $runtimeFamily
  return [ordered]@{
    device = $Device
    requested_device = if ($env:FULLMAG_FEM_REQUESTED_DEVICE) { $env:FULLMAG_FEM_REQUESTED_DEVICE } else { $Device }
    dependency_prefix = (Resolve-AbsolutePath $env:FULLMAG_FEM_DEPENDENCY_PREFIX)
    dependency_plan = $pePlan
    dependency_plan_path = $planPath
    dependency_audit_path = $auditPath
    dependency_audit_sha256 = $auditSha256
    runtime_bin = $stageRoot
    runtime_dll = Join-Path (Split-Path -Parent $FullmagExe) "fullmag_fem.dll"
    runtime_dll_sha256 = Get-Sha256File $launchFemDll
    provider_config = $providerProvenance.provider_config
    provider_config_sha256 = $providerProvenance.provider_config_sha256
    provider_receipt_path = $providerProvenance.provider_receipt_path
    provider_receipt_sha256 = $providerProvenance.provider_receipt_sha256
    import_library_sha256 = [string]$FemOutput.import_library_sha256
    strict_gpu = [bool]$useCuda
    runtime_family_root = [System.IO.Path]::GetFullPath($launchRoot)
    runtime_family = @($runtimeFamily)
    runtime_family_inventory = @($runtimeFamilyNames)
    runtime_family_inventory_sha256 = $runtimeFamilyInventorySha256
    runtime_family_dependency_audit_path = [System.IO.Path]::GetFullPath($auditPath)
    runtime_family_dependency_audit_sha256 = $auditSha256
  }
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
$PhysicalManifestPath = $ManifestPath
$FullRuntimeRoot = $null
$FullCapabilityManifestPath = $null
if ($Backend -eq "fem") {
  $FemRuntimeRoot = Join-Path $BuildRoot "windows-fem-runtime"
  $ManifestPath = Join-Path $FemRuntimeRoot "build-manifest.json"
  $PhysicalManifestPath = $ManifestPath
  $VersionIdentityPath = Join-Path $FemRuntimeRoot "build-source-identity.json"
  $VersionRecordPath = Join-Path $FemRuntimeRoot "build-version.json"
}
if ($AllBackendsRequested -or $Backend -eq "fem") {
  if ($AllBackendsRequested) {
    $FullRuntimeRoot = Join-Path $BuildRoot "windows-full-runtime"
    $FullCapabilityManifestPath = Join-Path $FullRuntimeRoot "build-manifest.json"
    $ManifestPath = $FullCapabilityManifestPath
  }
  $fullPackageHelper = Join-Path $PSScriptRoot "native_full_package.ps1"
  if (-not (Test-Path -LiteralPath $fullPackageHelper -PathType Leaf)) {
    throw "The full capability package helper is missing: $fullPackageHelper"
  }
  . $fullPackageHelper
}
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
$existingFemManifest = $null
if ($Backend -eq "fem" -and (Test-Path -LiteralPath $PhysicalManifestPath -PathType Leaf)) {
  try { $existingFemManifest = Get-Content -LiteralPath $PhysicalManifestPath -Raw | ConvertFrom-Json }
  catch { $existingFemManifest = $null }
}
$BackendSourceDigest = if ($RunMode -eq "workspace") { Get-WindowsBackendSourceDigest } else { $null }
$FrontendSourceDigest = if ($RunMode -eq "workspace" -and $Frontend -eq "static") { Get-WindowsBackendSourceDigest -FrontendSources } else { $null }
if ($BuildMode -eq "auto") {
  $BuildMode = if (Test-WindowsWorkspaceBuildRequired -BackendDigest $BackendSourceDigest) { "true" } else { "false" }
  Write-Host "Windows workspace automatic build selection: $BuildMode"
}
$nativeWorkspaceSnapshotBuild = $BuildMode -eq "true" -and $RunMode -eq "workspace" -and
  $SelectedBackendProfile -in @("dev", "release") -and $Frontend -in @("dev", "static")
$nativeFemSnapshotBuild = $BuildMode -eq "true" -and $Backend -eq "fem"
if ($nativeWorkspaceSnapshotBuild -or $nativeFemSnapshotBuild) {
  Write-Host "Capturing immutable native source inputs for this build request"
  $snapshotOutput = (& python -B (Join-Path $PSScriptRoot "build_snapshot.py") create --repo-root $RepoRoot --build-root $BuildRoot 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "Native source snapshot failed: $snapshotOutput" }
  $BuildSnapshot = $snapshotOutput | ConvertFrom-Json
  if ($nativeWorkspaceSnapshotBuild -and $env:FULLMAG_NATIVE_RUNTIME_ACTIVE -eq "1" -and
      ([string]$env:FULLMAG_NATIVE_ACTIVE_DEPENDENCY_SHA256 -notmatch '^[0-9a-f]{64}$' -or
       [string]$BuildSnapshot.dependency_source_sha256 -ne $env:FULLMAG_NATIVE_ACTIVE_DEPENDENCY_SHA256)) {
    throw "Captured dependencies differ from the active workspace; save and close it before rebuilding"
  }
  $BuildSourceRoot = [string]$BuildSnapshot.source_root
  $StaticControlRoom = Join-Path $BuildSourceRoot "apps\control-room\out\index.html"
  $BackendSourceDigest = [string]$BuildSnapshot.backend_source_sha256
  Write-Host "Frozen source: $($BuildSnapshot.snapshot_id); later checkout edits belong to the next build"
}
$existingFrozenManifest = if ($Backend -eq "fem") { $existingFemManifest } else { $existingWorkspaceManifest }
if ($BuildMode -eq "false" -and $existingFrozenManifest -and $existingFrozenManifest.build_source_snapshot) {
  if ($ExpectedBuildId -and (Get-Sha256File $ManifestPath) -ne $ExpectedBuildId) {
    throw "The requested build manifest changed before launch; refusing a different build"
  }
  $BuildSnapshot = Read-BuildSnapshot -RecordPath ([string]$existingFrozenManifest.build_source_snapshot.record_path)
  if ([string]$BuildSnapshot.inventory_sha256 -ne [string]$existingFrozenManifest.build_source_snapshot.inventory_sha256 -or
      [string]$BuildSnapshot.backend_source_sha256 -ne [string]$existingFrozenManifest.build_source_snapshot.backend_source_sha256) {
    throw "Build manifest does not match its frozen sources"
  }
  $BuildSourceRoot = [string]$BuildSnapshot.source_root
  $StaticControlRoom = Join-Path $BuildSourceRoot "apps\control-room\out\index.html"
} elseif ($ExpectedBuildId) {
  throw "The requested build has no verified frozen sources"
}
if ($BuildMode -eq "true") {
  $volatileToolsRoot = if ($BuildSnapshot) { Get-WindowsBuildToolsRoot } else { $PSScriptRoot }
  $volatileBuildOutput = (& python -B (Join-Path $volatileToolsRoot "volatile_build_storage.py") `
    --repo-root $RepoRoot --profile $StorageProfile --build-root $BuildRoot 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "Volatile compiler storage preparation failed: $volatileBuildOutput" }
  $VolatileBuild = $volatileBuildOutput | ConvertFrom-Json
  if ([bool]$VolatileBuild.enabled -and (
      -not $VolatileBuild.root -or -not $VolatileBuild.temp_root -or
      -not $VolatileBuild.compiler_inputs_root -or -not $VolatileBuild.durable_build_root -or
      (Resolve-AbsolutePath ([string]$VolatileBuild.durable_build_root)) -ine (Resolve-AbsolutePath $BuildRoot))) {
    throw "Volatile compiler storage does not match the durable build profile"
  }
  if ([bool]$VolatileBuild.enabled -and -not [bool]$VolatileBuild.compiler_inputs_enabled) {
    Write-Host "RAM-disk path normalization unsupported: keeping one durable compiler mirror; compiler TEMP uses $($VolatileBuild.temp_root)"
  }
}
# Browser/script runs need Node, pnpm and Control Room assets even in the
# BuildOnly half of a build-then-run operation. Tauri is a separate product
# surface: only the desktop workspace publishes and validates fullmag-ui.exe.
$needsDesktopRuntime = $RunMode -eq "workspace" -and -not $BrowserWorkspace
$needsControlRoomToolchain = $needsDesktopRuntime -or $Frontend -eq "static" -or
  $RunMode -eq "interactive" -or $BrowserWorkspace

$nextDistDir = if ($needsControlRoomToolchain -and $Frontend -eq "dev") {
  ".next-control-room-$WebPort"
} else {
  $null
}
$prepareArguments = @{
  RepoRoot = $RepoRoot
  Profile = $StorageProfile
}
# Native FEM already resolves its build/runtime paths under managed storage;
# do not rebind shared checkout compatibility links during a FEM operation.
if (-not $SkipCompatibilityLinks -and $RunMode -ne "workspace" -and $Backend -ne "fem") {
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
$CargoBin = Join-Path $CargoHome "bin"
Prepend-PathEntry -Path $CargoBin
$env:CARGO_INCREMENTAL = if ($SelectedBackendProfile -eq "dev" -or ($Frontend -eq "dev" -and -not $BuildOnly)) { "1" } else { "0" }
$env:FULLMAG_FDM_EXECUTION = $null
$env:UV_PYTHON_INSTALL_DIR = Join-Path $PythonRoot "managed"
$env:UV_PYTHON_BIN_DIR = Join-Path $PythonRoot "bin"
$env:PYTHONPATH = Join-Path $BuildSourceRoot "packages\fullmag-py\src"
$env:PYTHONDONTWRITEBYTECODE = "1"
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
$nativeFemBuildRoot = Join-Path $BuildRoot "native-fem"
$null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $nativeFemBuildRoot -Label "native FEM build root" -Parent $BuildRoot
Ensure-Directory $nativeFemBuildRoot
if ($Backend -eq "fem") { Ensure-Directory $FemRuntimeRoot }
$NativeFemPlan = $null
$NativeFemOutput = $null
$NativeFemRuntime = $null

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
$env:FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256 = $sourceSnapshotSha256

if ($BuildMode -eq "true") {
  Write-JsonAtomic -Path $versionIdentityPath -Value $sourceIdentity
  Invoke-External $PythonExe @(
    "-B", (Join-Path $BuildSourceRoot "scripts\build_version.py"),
    "--repo-root", $BuildSourceRoot, "--source-identity", $versionIdentityPath,
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
    Install-FullmagPython
  } else {
    Write-Host "Keeping the active Python environment unchanged; version sync is deferred until restart"
  }
  Write-Host "Fullmag build version: $($buildVersion.semver_version)"
}

# Headless runs never launch the Control Room and remain binary-only.  Static
# exports and interactive dev runs prepare and pin the frontend toolchain during
# BuildOnly so the subsequent runtime phase can reuse the same manifest.
if ($needsControlRoomToolchain) {
  Ensure-NodeToolchain
}

if ($BuildMode -eq "true") {
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

  # Keep compiler paths stable while the immutable snapshot remains the
  # authority for Python, frontend staging, versioning and provenance.
  $CompilerSourceRoot = $BuildSourceRoot
  if ($BuildSnapshot) {
    Write-Host "[native-build] compiler input materialization starting"
    $CompilerInputs = Invoke-CompilerInputsTool -Command materialize -RecordPath ([string]$BuildSnapshot.record_path)
    Write-Host "[native-build] compiler input materialization complete"
    if ([string]$CompilerInputs.snapshot_id -ne [string]$BuildSnapshot.snapshot_id -or
        [string]$CompilerInputs.inventory_sha256 -ne [string]$BuildSnapshot.inventory_sha256 -or
        [string]$CompilerInputs.record_path -ne [string]$BuildSnapshot.record_path -or
        [string]$CompilerInputs.snapshot_source_root -ne $BuildSourceRoot) {
      throw "Compiler inputs do not match the frozen build source"
    }
    if ($null -ne $VolatileBuild -and [bool]$VolatileBuild.enabled -and [bool]$VolatileBuild.compiler_inputs_enabled) {
      $expectedCompilerSourceRoot = Resolve-AbsolutePath (Join-Path ([string]$VolatileBuild.compiler_inputs_root) "source")
      $actualCompilerSourceRoot = Resolve-AbsolutePath ([string]$CompilerInputs.source_root)
      if (-not $actualCompilerSourceRoot.Equals($expectedCompilerSourceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Compiler inputs are outside the prepared volatile working root"
      }
      $CompilerSourceRoot = $actualCompilerSourceRoot
    }
    else {
      $CompilerSourceRoot = Assert-FullmagStoragePath -Layout $StorageLayout -Path ([string]$CompilerInputs.source_root) -Label "native compiler inputs" -Parent $BuildRoot
    }
  }

  $cargoProfileArguments = @(Get-WindowsCargoProfileArguments -CompilerProfile $CargoCompilerProfile)
  $cargoArguments = @(
    "build", "--locked"
  )
  $cargoArguments += $cargoProfileArguments
  $cargoArguments += @(
    "--target", $TargetTriple,
    "-p", "fullmag-cli", "-p", "fullmag-api"
  )
  $cargoFeatures = @()
  if ($Backend -eq "fem") {
    # The historical fem-gpu Cargo feature enables the native FEM binding for
    # both CPU and GPU.  CUDA is added only for the strict GPU lane.
    Write-Host "[native-fem] provider preparation and native FEM build starting"
    $NativeFemOutput = Invoke-NativeFemBuild -SourceRoot $CompilerSourceRoot
    $cargoFeatures = @([string[]]$NativeFemPlan.features)
  }
  elseif ($useCuda) {
    $cargoFeatures = @("cuda")
  }
  if ($cargoFeatures.Count) {
    $cargoArguments += @("--features", ($cargoFeatures -join ","))
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
    Push-Location $CompilerSourceRoot
    try {
      Invoke-External "cargo" $cargoArguments
      if ($needsDesktopRuntime) {
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
        }
        else {
          Remove-Item "Env:$name" -ErrorAction SilentlyContinue
        }
      }
    }
  }

  if ($BuildSnapshot) {
    Write-Host "[native-build] compiler input verification starting"
    $verifiedCompilerInputs = Invoke-CompilerInputsTool -Command verify -RecordPath ([string]$BuildSnapshot.record_path)
    Write-Host "[native-build] compiler input verification complete"
    if ([string]$verifiedCompilerInputs.source_root -ne $CompilerSourceRoot -or
        [string]$verifiedCompilerInputs.snapshot_id -ne [string]$BuildSnapshot.snapshot_id -or
        [string]$verifiedCompilerInputs.inventory_sha256 -ne [string]$BuildSnapshot.inventory_sha256 -or
        [string]$verifiedCompilerInputs.record_path -ne [string]$BuildSnapshot.record_path -or
        [string]$verifiedCompilerInputs.snapshot_source_root -ne $BuildSourceRoot) {
      throw "Compiler input binding changed during compilation"
    }
  }

  if (-not (Test-Path -LiteralPath $FullmagExe -PathType Leaf)) {
    throw "Native Fullmag binary was not produced at $FullmagExe"
  }
  if (-not (Test-Path -LiteralPath $FullmagApiExe -PathType Leaf)) {
    throw "Native Fullmag API binary was not produced at $FullmagApiExe"
  }
  if ($needsDesktopRuntime -and (
      -not (Test-Path -LiteralPath $FullmagUiExe -PathType Leaf) -or
      (Get-Item -LiteralPath $FullmagUiExe).Length -eq 0)) {
    throw "Native Fullmag desktop binary was not produced at $FullmagUiExe"
  }
  $versionedBinaries = @($FullmagExe, $FullmagApiExe)
  if ($needsDesktopRuntime) { $versionedBinaries += $FullmagUiExe }
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
  if ($Backend -eq "fem") {
    $NativeFemRuntime = Stage-NativeFemRuntime -FemOutput $NativeFemOutput
    if ($AllBackendsRequested) {
      # Stage-NativeFemRuntime audits and copies the FDM ABI closure as part of
      # the FEM package.  Bind the aggregate capability record to that exact
      # staged file instead of treating FEM output as an FDM build receipt.
      $nativeFdmDll = Join-Path (Split-Path -Parent $FullmagExe) "fullmag_fdm.dll"
      if (-not (Test-Path -LiteralPath $nativeFdmDll -PathType Leaf)) {
        throw "The all-backends package is missing the staged native FDM DLL: $nativeFdmDll"
      }
    }
  }
  elseif ($useCuda) {
    $nativeFdmDll = Stage-NativeFdmDll
  }
  # Capture both ends of the build.  The default path refuses a binary built
  # from a different checkout snapshot; the explicit skip path preserves both
  # identities in the manifest and marks the receipt non-qualifying.
  if ($BuildSnapshot) {
    $verifiedSnapshot = Read-BuildSnapshot -RecordPath ([string]$BuildSnapshot.record_path)
    if ([string]$verifiedSnapshot.inventory_sha256 -ne [string]$BuildSnapshot.inventory_sha256) {
      throw "Frozen build inventory changed during compilation"
    }
    $finalSourceIdentity = $verifiedSnapshot.source_identity
    $sourceIdentityChanged = $false
  } else {
    $finalSourceIdentity = Get-SourceIdentity
    $sourceIdentityChanged = [string]$finalSourceIdentity.head_commit_full -ne $sourceCommit -or
      [string]$finalSourceIdentity.source_snapshot_sha256 -ne $sourceSnapshotSha256
    if ($RunMode -eq "workspace" -and $Frontend -eq "dev") {
      $sourceIdentityChanged = (Get-WindowsBackendSourceDigest) -ne $BackendSourceDigest
    }
  }
  if ($sourceIdentityChanged -and -not $SkipLocalChanges) {
    throw "Fullmag source changed while the native runtime was building; rerun with build=True after the checkout is stable"
  }
  $workspaceExecutableHashes = [ordered]@{}
  if ($RunMode -eq "workspace" -and -not $BrowserWorkspace) {
    $bundleNamesOutput = (& python -B -c "import sys; sys.path.insert(0, sys.argv[1]); from runtime_bundle import BINARY_NAMES; print('\n'.join(BINARY_NAMES))" (Get-WindowsBuildToolsRoot) | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "Native executable inventory failed" }
    foreach ($bundleName in ($bundleNamesOutput.Trim() -split '\r?\n')) {
      $workspaceExecutableHashes[$bundleName] = Get-Sha256File (Join-Path (Split-Path -Parent $FullmagExe) $bundleName)
    }
  }
  $frontendEntryPath = $null
  $frontendEntrySha256 = $null
  if ($BrowserWorkspace) {
    $frontendEntryPath = if ($Frontend -eq "static") {
      Join-Path $FrontendCacheRoot "out\index.html"
    } else {
      Join-Path $FrontendWorkspaceRoot "apps\control-room\dev-server.mjs"
    }
    if (-not (Test-Path -LiteralPath $frontendEntryPath -PathType Leaf) -or
        (Get-Item -LiteralPath $frontendEntryPath -Force).Length -eq 0) {
      throw "Native FEM browser frontend entry is missing or empty: $frontendEntryPath"
    }
    $frontendEntrySha256 = Get-Sha256File $frontendEntryPath
  }
  $manifest = [ordered]@{
    schema_version = 1
    target_triple = $TargetTriple
    compiler_profile = $CargoCompilerProfile
    binary = $FullmagExe
    api_binary = $FullmagApiExe
    desktop_binary = if ($needsDesktopRuntime) { $FullmagUiExe } else { $null }
    backend = if ($Backend -eq "auto") { "auto" } else { $Backend }
    cuda = $useCuda
    features = if ($Backend -eq "fem") { @([string[]]$NativeFemPlan.features) } else { @(if ($useCuda) { "cuda" }) }
    native_fdm_dll = $nativeFdmDll
    native_fem = $NativeFemRuntime
    workspace_namespace = $WorkspaceNamespace
    cuda_bin = $cudaBin
    cargo_target_dir = $TargetRoot
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
    build_source_snapshot = if ($BuildSnapshot) { [ordered]@{
      record_path = [string]$BuildSnapshot.record_path
      inventory_sha256 = [string]$BuildSnapshot.inventory_sha256
      source_root = $BuildSourceRoot
    } } else { $null }
    volatile_build_storage = if ($null -ne $VolatileBuild -and [bool]$VolatileBuild.enabled) { [ordered]@{
      root = [string]$VolatileBuild.root
      temp_root = [string]$VolatileBuild.temp_root
      compiler_inputs_root = if ([bool]$VolatileBuild.compiler_inputs_enabled) { [string]$VolatileBuild.compiler_inputs_root } else { Join-Path $BuildRoot "compiler-inputs" }
      compiler_inputs_enabled = [bool]$VolatileBuild.compiler_inputs_enabled
      durable_build_root = [string]$VolatileBuild.durable_build_root
    } } else { $null }
    frontend_source_sha256 = $FrontendSourceDigest
    frontend_mode = $Frontend
    frontend_workspace_root = $FrontendWorkspaceRoot
    frontend_cache_root = $FrontendCacheRoot
    frontend_source_manifest = $FrontendSourceManifestPath
    frontend_source_manifest_sha256 = $FrontendSourceManifestSha256
    ui_host = if ($BrowserWorkspace) { "browser" } elseif ($needsDesktopRuntime) { "desktop" } else { $null }
    workspace_mode = if ($BrowserWorkspace) { "empty" } elseif ($needsDesktopRuntime) { "desktop" } else { $null }
    browser_workspace = [bool]$BrowserWorkspace
    frontend_entry_path = $frontendEntryPath
    frontend_entry_sha256 = $frontendEntrySha256
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
    desktop_binary_sha256 = if ($needsDesktopRuntime) { Get-Sha256File $FullmagUiExe } else { $null }
    native_fdm_dll_sha256 = if ($nativeFdmDll) { Get-Sha256File $nativeFdmDll } else { $null }
    built_at_utc = [string]$buildVersion.build_date_utc
  }
  if ($Backend -eq "fem") {
    $manifest.state = "completed"
    $manifest.native_fem_attempt_id = $NativeFemAttemptId
  }
  $physicalManifestOutputPath = if ($AllBackendsRequested) { $PhysicalManifestPath } else { $ManifestPath }
  Write-JsonAtomic -Path $physicalManifestOutputPath -Value $manifest
  if ($AllBackendsRequested) {
    $nativeFemDll = Join-Path (Split-Path -Parent $FullmagExe) "fullmag_fem.dll"
    $null = New-FullmagFullRuntimeManifest `
      -OutputRoot $FullRuntimeRoot -ManifestPath $FullCapabilityManifestPath `
      -OriginManifestPath $PhysicalManifestPath -FullmagExe $FullmagExe `
      -FullmagApiExe $FullmagApiExe -NativeFdmDll $nativeFdmDll `
      -NativeFemDll $nativeFemDll -SourceCommit $sourceCommit `
      -SourceSnapshotSha256 $sourceSnapshotSha256 -AttemptId $NativeFemAttemptId `
      -BuildRoot $BuildRoot -ToolsRoot (Get-WindowsBuildToolsRoot)
  }
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
  if ($AllBackendsRequested) {
    $nativeFdmDll = Join-Path (Split-Path -Parent $FullmagExe) "fullmag_fdm.dll"
    $nativeFemDll = Join-Path (Split-Path -Parent $FullmagExe) "fullmag_fem.dll"
    $null = Assert-FullmagFullRuntimeManifest `
      -ManifestPath $ManifestPath -OriginManifestPath $PhysicalManifestPath `
      -FullmagExe $FullmagExe -FullmagApiExe $FullmagApiExe `
      -NativeFdmDll $nativeFdmDll -NativeFemDll $nativeFemDll `
      -ExpectedBuildId $ExpectedBuildId -SourceCommit $sourceCommit `
      -SourceSnapshotSha256 $sourceSnapshotSha256 -AttemptId $NativeFemAttemptId `
      -BuildRoot $BuildRoot -ToolsRoot (Get-WindowsBuildToolsRoot)
    $allBackendFem = $manifest.native_fem
    $allBackendFemAudit = [string]$allBackendFem.dependency_audit_path
    $allBackendFemRuntimeBin = [string]$allBackendFem.runtime_bin
    $allBackendFemAuditSha256 = [string]$allBackendFem.dependency_audit_sha256
    if (-not $allBackendFem -or -not $allBackendFemAudit -or
        -not $allBackendFemRuntimeBin -or
        $allBackendFemAuditSha256 -notmatch '^[0-9a-f]{64}$') {
      throw "Existing full workspace is missing its complete FEM PE audit; rerun with build=True"
    }
    $allBackendLaunchRoot = Assert-NativeFemPathChain `
      -Path (Split-Path -Parent $FullmagExe) -Base $TargetRoot `
      -Label "full workspace launch runtime"
    $null = Assert-NativeFemStagedPeAudit `
      -AuditPath $allBackendFemAudit -StageRoot $allBackendFemRuntimeBin `
      -ExpectedAuditSha256 $allBackendFemAuditSha256 `
      -LaunchRoot $allBackendLaunchRoot -LaunchBase $TargetRoot
  }
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
    if ($BrowserWorkspace) {
      $manifestStructureMismatch = $manifestStructureMismatch -or
          [string]$manifest.ui_host -ne "browser" -or
          [string]$manifest.workspace_mode -ne "empty" -or
          $manifest.browser_workspace -isnot [bool] -or
          -not [bool]$manifest.browser_workspace -or
          $null -ne $manifest.desktop_binary -or
          $null -ne $manifest.desktop_binary_sha256
    }
  }
  $manifestSourceMismatch = [string]$manifest.git_commit -ne $sourceCommit -or
      [string]$manifest.worktree_state -ne $sourceWorktreeState -or
      [string]$manifest.source_snapshot_sha256 -ne $sourceSnapshotSha256
  if ($RunMode -eq "workspace" -and $Frontend -eq "dev") {
    $manifestSourceMismatch = [string]$manifest.backend_source_sha256 -ne $BackendSourceDigest
  }
  if ($ExpectedBuildId -and $BuildSnapshot -and (Get-Sha256File $ManifestPath) -eq $ExpectedBuildId) {
    $manifestSourceMismatch = $false
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
  if ($needsDesktopRuntime) {
    Assert-FullmagDesktopRuntime -Path $FullmagUiExe -ExpectedHash ([string]$manifest.desktop_binary_sha256)
  }
  if ($RunMode -eq "workspace") {
    $versionFile = Assert-FullmagStoragePath -Layout $StorageLayout -Path ([string]$manifest.build_version_file) -Label "build version file" -Parent $BuildRoot
    $frontendManifest = Assert-FullmagStoragePath -Layout $StorageLayout -Path ([string]$manifest.frontend_source_manifest) -Label "frontend source manifest" -Parent $BuildRoot
    if ([string]$manifest.build_version_file_sha256 -ne (Get-Sha256File $versionFile) -or
        [string]$manifest.frontend_source_manifest_sha256 -ne (Get-Sha256File $frontendManifest)) {
      throw "Native workspace metadata hash does not match the build manifest; rebuild the Windows workspace"
    }
    if ($BrowserWorkspace) {
      $browserEntryPath = if ($Frontend -eq "static") {
        Join-Path $FrontendCacheRoot "out\index.html"
      } else {
        Join-Path $FrontendWorkspaceRoot "apps\control-room\dev-server.mjs"
      }
      if (-not (Test-Path -LiteralPath $browserEntryPath -PathType Leaf) -or
          (Get-Item -LiteralPath $browserEntryPath -Force).Length -eq 0 -or
          [string]$manifest.frontend_entry_path -ne (Resolve-AbsolutePath $browserEntryPath) -or
          [string]$manifest.frontend_entry_sha256 -notmatch '^[0-9a-f]{64}$' -or
          [string]$manifest.frontend_entry_sha256 -ne (Get-Sha256File $browserEntryPath)) {
        throw "Existing FEM browser frontend entry does not match the build manifest; rerun with build=True"
      }
    }
  }
  if ($Frontend -eq "static" -and
      [string]$manifest.static_web_sha256 -ne (Get-DirectorySha256 (Split-Path -Parent $StaticControlRoom))) {
    throw "Existing static Control Room assets do not match the build manifest; rerun with build=True"
  }
  if ($Backend -eq "fem" -and -not $AllBackendsRequested) {
    if ([string]$manifest.backend -ne "fem" -or -not $manifest.native_fem -or
        [string]$manifest.native_fem.device -ne $Device) {
      throw "Existing Windows runtime is not a native FEM package for the requested device; rerun with build=True"
    }
    if ([string]$manifest.state -ne "completed" -or
        [string]$manifest.native_fem_attempt_id -notmatch '^[0-9a-f]{32}$' -or
        $manifest.cuda -isnot [bool] -or [bool]$manifest.cuda -ne $useCuda -or
        $manifest.native_fem.strict_gpu -isnot [bool] -or
        [bool]$manifest.native_fem.strict_gpu -ne $useCuda -or
        [string]$manifest.native_fem.requested_device -ne $NativeFemRequestedDevice) {
      throw "Existing Windows runtime has inconsistent native FEM GPU or request provenance; rerun with build=True"
    }
    $nativeFemDll = Join-Path (Split-Path -Parent $FullmagExe) "fullmag_fem.dll"
    if (-not (Test-Path -LiteralPath $nativeFemDll -PathType Leaf)) {
      throw "Native FEM backend DLL is missing at $nativeFemDll; rerun with build=True"
    }
    if ([string]$manifest.native_fem.runtime_dll_sha256 -ne (Get-Sha256File $nativeFemDll)) {
      throw "Native FEM backend DLL hash does not match the build manifest; rerun with build=True"
    }
    if ($useCuda -and -not [bool]$manifest.native_fem.strict_gpu) {
      throw "Existing FEM runtime is not strict GPU; CPU fallback is forbidden; rerun with build=True"
    }
    $null = Assert-NativeFemProviderArtifacts `
      -ProviderConfigPath ([string]$manifest.native_fem.provider_config) `
      -ProviderConfigSha256 ([string]$manifest.native_fem.provider_config_sha256) `
      -ProviderReceiptPath ([string]$manifest.native_fem.provider_receipt_path) `
      -ProviderReceiptSha256 ([string]$manifest.native_fem.provider_receipt_sha256)
    $femAudit = [string]$manifest.native_fem.dependency_audit_path
    $femRuntimeBin = [string]$manifest.native_fem.runtime_bin
    $expectedFemRuntimeRoot = Resolve-AbsolutePath $FemRuntimeRoot
    $expectedFemRuntimeBin = Resolve-AbsolutePath (Join-Path $expectedFemRuntimeRoot "bin")
    $expectedFemAudit = Resolve-AbsolutePath (Join-Path $expectedFemRuntimeRoot "windows-pe-dependencies.json")
    if ((Resolve-AbsolutePath $femRuntimeBin) -ine $expectedFemRuntimeBin -or
        (Resolve-AbsolutePath $femAudit) -ine $expectedFemAudit) {
      throw "Existing FEM runtime dependency paths are not canonical; rerun with build=True"
    }
    $femAuditSha256 = [string]$manifest.native_fem.dependency_audit_sha256
    if ($femAuditSha256 -notmatch '^[0-9a-f]{64}$') {
      throw "Existing FEM runtime has no immutable dependency audit hash; rerun with build=True"
    }
    $launchRoot = Assert-NativeFemPathChain -Path (Split-Path -Parent $FullmagExe) -Base $TargetRoot `
      -Label "native FEM launch runtime"
    $null = Assert-NativeFemStagedPeAudit -AuditPath $femAudit -StageRoot $femRuntimeBin `
      -ExpectedAuditSha256 $femAuditSha256 -LaunchRoot $launchRoot -LaunchBase $TargetRoot
  }
  elseif ($useCuda) {
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

if ($AllBackendsRequested) {
  # The aggregate package deliberately leaves solver selection to the UI.
  # In particular, do not inherit the physical FEM-GPU producer's execution
  # variables into a workspace that advertises all four capabilities.
  Remove-Item Env:FULLMAG_FDM_EXECUTION -ErrorAction SilentlyContinue
  Remove-Item Env:FULLMAG_FEM_EXECUTION -ErrorAction SilentlyContinue
  Remove-Item Env:FULLMAG_RELAX_DEVICE -ErrorAction SilentlyContinue
  $env:FULLMAG_FULL_RUNTIME_MANIFEST = $ManifestPath
}
elseif ($Backend -eq "fem") {
  if ($useCuda) { Test-NvidiaRuntime }
  $env:FULLMAG_FDM_EXECUTION = "cpu"
  $env:FULLMAG_FEM_EXECUTION = $Device
  $env:FULLMAG_RELAX_DEVICE = $Device
}
elseif ($useCuda) {
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
    Install-FullmagPython
    $installedVersion = (& $PythonExe -c "from importlib.metadata import version; print(version('fullmag'))" | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $installedVersion -ne [string]$manifest.build_version.pep440_version) { throw "Deferred Python version sync failed" }
    $manifest.installed_python_version = $installedVersion
    $manifest.python_sync_required = $false
    Write-JsonAtomic -Path $ManifestPath -Value $manifest
  }
  $env:FULLMAG_REPO_ROOT = $FrontendWorkspaceRoot
  $env:FULLMAG_FRONTEND_ROOT = $FrontendCacheRoot
  $env:FULLMAG_STATE_ROOT = Join-Path $StorageLayout.runtime_root "state"
  $env:FULLMAG_DEV_SOURCE_ROOT = if ($Frontend -eq "dev") {
    if ($BrowserWorkspace) { Join-Path $FrontendWorkspaceRoot "apps\control-room" } else { Join-Path $RepoRoot "apps\control-room" }
  } else { "" }
  if ($BrowserWorkspace) {
    # The browser CLI owns free-port selection when WebPort=0.  Passing zero
    # as an explicit --web-port would ask the CLI to bind port zero rather
    # than use its managed candidate list.
    $workspaceArguments = @("ui", "--browser")
    if ($WebPort -ne 0) { $workspaceArguments += @("--web-port", $WebPort.ToString()) }
  } else {
    $FullmagExe = Publish-NativeWorkspaceRuntime
    $workspaceArguments = @("ui", "--web-port", $WebPort.ToString())
  }
  if ($Frontend -eq "dev") { $workspaceArguments += "--dev" }
  $previousBrowserApiPortWasSet = Test-Path Env:FULLMAG_API_PORT
  $previousBrowserApiPort = [Environment]::GetEnvironmentVariable("FULLMAG_API_PORT", "Process")
  $previousRequireOwnedApiWasSet = Test-Path Env:FULLMAG_REQUIRE_OWN_API
  $previousRequireOwnedApi = [Environment]::GetEnvironmentVariable("FULLMAG_REQUIRE_OWN_API", "Process")
  try {
    if ($BrowserApiIsolation) {
      # Zero asks the CLI to reserve a fresh concrete API endpoint; the private
      # ownership flag prevents reuse of a compatible API already on that port.
      $env:FULLMAG_API_PORT = "0"
      $env:FULLMAG_REQUIRE_OWN_API = "1"
    }
    Push-Location $RepoRoot
    try {
      Invoke-External $FullmagExe $workspaceArguments
    }
    finally {
      Pop-Location
    }
  }
  finally {
    if ($previousBrowserApiPortWasSet) {
      [Environment]::SetEnvironmentVariable("FULLMAG_API_PORT", $previousBrowserApiPort, "Process")
    }
    else {
      Remove-Item Env:FULLMAG_API_PORT -ErrorAction SilentlyContinue
    }
    if ($previousRequireOwnedApiWasSet) {
      [Environment]::SetEnvironmentVariable("FULLMAG_REQUIRE_OWN_API", $previousRequireOwnedApi, "Process")
    }
    else {
      Remove-Item Env:FULLMAG_REQUIRE_OWN_API -ErrorAction SilentlyContinue
    }
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
if ($resolvedOutputDir) {
  $resolvedOutputDir = Assert-FullmagStoragePath -Layout $StorageLayout -Path $resolvedOutputDir -Label "simulation output" -Parent ([string]$StorageLayout.storage_root)
  Ensure-Directory $resolvedOutputDir
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
$previousScriptApiPortWasSet = Test-Path Env:FULLMAG_API_PORT
$previousScriptApiPort = [Environment]::GetEnvironmentVariable("FULLMAG_API_PORT", "Process")
$previousScriptRequireOwnedApiWasSet = Test-Path Env:FULLMAG_REQUIRE_OWN_API
$previousScriptRequireOwnedApi = [Environment]::GetEnvironmentVariable("FULLMAG_REQUIRE_OWN_API", "Process")
try {
  if ($RunMode -eq "headless") {
    # Headless script execution keeps the API disabled; do not opt it into
    # the interactive owned-API contract.
    $env:FULLMAG_API_PORT = "0"
    $cliArguments += @("--headless", "--json")
  }
  else {
    # An omitted option lets the CLI select a usable listener from its
    # managed candidate list.  --web-port 0 is an explicit unusable port.
    if ($WebPort -ne 0) {
      $cliArguments += @("--web-port", $WebPort.ToString())
    }
    if ($FemInteractiveApiIsolation) {
      $env:FULLMAG_API_PORT = "0"
      $env:FULLMAG_REQUIRE_OWN_API = "1"
    }
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
}
finally {
  if ($previousScriptApiPortWasSet) {
    [Environment]::SetEnvironmentVariable("FULLMAG_API_PORT", $previousScriptApiPort, "Process")
  }
  else {
    Remove-Item Env:FULLMAG_API_PORT -ErrorAction SilentlyContinue
  }
  if ($previousScriptRequireOwnedApiWasSet) {
    [Environment]::SetEnvironmentVariable("FULLMAG_REQUIRE_OWN_API", $previousScriptRequireOwnedApi, "Process")
  }
  else {
    Remove-Item Env:FULLMAG_REQUIRE_OWN_API -ErrorAction SilentlyContinue
  }
}
