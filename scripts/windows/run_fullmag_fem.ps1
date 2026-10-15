[CmdletBinding()]
# Canonical Windows FEM entry point.
#
# Native Windows/MFEM is the managed default.  The historical Docker Desktop
# implementation remains an explicit compatibility fallback for operators that
# set FULLMAG_FORCE_WINDOWS_FEM_DOCKER=1.
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("true", "false")]
  [string]$BuildMode,

  [ValidateSet("static", "dev")]
  [string]$Frontend = "dev",

  [ValidateSet("fem")]
  [string]$Backend = "fem",

  [ValidateSet("auto", "cpu", "gpu")]
  [string]$Device = "gpu",

  [ValidateSet("interactive", "headless", "workspace")]
  [string]$RunMode = "interactive",

  [string]$ScriptPath,

  [string]$OutputDir,

  [switch]$BuildOnly,

  [switch]$Browser,

  # Internal build-to-launch handoff: pins the verified FEM manifest digest.
  [string]$ExpectedBuildId,

  [ValidateSet("fullmag-session", "fullmag-api", "fullmag-cli", "fullmag-runner")]
  [string]$TestPackage,

  [ValidatePattern("^[A-Za-z0-9_:.-]*$")]
  [string]$TestFilter = "",

  [Alias("skip_local_changes")]
  [switch]$SkipLocalChanges,

  [ValidateRange(0, 65535)]
  [int]$WebPort = 0
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

if ($TestPackage -and ($BuildMode -ne "true" -or -not $BuildOnly)) {
  throw "Targeted FEM tests require -BuildMode true -BuildOnly"
}
if ($Browser -and ($RunMode -ne "workspace" -or $ScriptPath -or $OutputDir -or $TestPackage)) {
  throw "Native FEM browser workspace does not accept a simulation script, output directory or test package"
}
if ($Browser -and $env:FULLMAG_FORCE_WINDOWS_FEM_DOCKER -eq "1") {
  throw "Native FEM browser workspace requires the managed native Windows route"
}
if ($ExpectedBuildId -and $ExpectedBuildId -notmatch '^[0-9a-f]{64}$') {
  throw "ExpectedBuildId must be a lowercase SHA256 manifest digest"
}
if ($ExpectedBuildId -and $env:FULLMAG_FORCE_WINDOWS_FEM_DOCKER -eq "1") {
  throw "ExpectedBuildId requires the managed native Windows FEM route; the Docker compatibility route cannot attest the pinned build"
}
if ($ExpectedBuildId -and $BuildMode -ne "false") {
  throw "ExpectedBuildId is only valid for the runtime half of a managed FEM build"
}

function Invoke-NativeWindowsFem {
  if ($TestPackage) {
    throw "Targeted FEM tests require the managed Docker test lane; native FEM launch does not accept TestPackage"
  }
  $resolver = Join-Path $RepoRoot "scripts\fullmag_storage.py"
  if (-not (Test-Path -LiteralPath $resolver -PathType Leaf)) {
    throw "Fullmag storage resolver is missing: $resolver"
  }
  $python = Get-Command "python" -ErrorAction SilentlyContinue
  if (-not $python) {
    throw "Python is required to invoke the native Windows FEM operation"
  }
  $nativeLauncher = Join-Path $RepoRoot "scripts\windows\run_fullmag.ps1"
  if (-not (Test-Path -LiteralPath $nativeLauncher -PathType Leaf)) {
    throw "Native Windows FEM launcher is missing: $nativeLauncher"
  }

  # The minimised native FEM route deliberately does not turn SLEPc on.  An
  # operator can still choose another explicit value before entering this
  # wrapper, but the default must not pull a modal provider into this build.
  $previousSlepc = $env:FULLMAG_FEM_WITH_SLEPC
  if (-not $previousSlepc) { $env:FULLMAG_FEM_WITH_SLEPC = "OFF" }
  $previousRequestedDevice = $env:FULLMAG_FEM_REQUESTED_DEVICE
  $env:FULLMAG_FEM_REQUESTED_DEVICE = $Device
  try {
    $action = if ($Browser) {
      if ($BuildOnly) { "run-windows-fem-workspace-build" } else { "run-windows-fem-workspace" }
    } else {
      "run-windows-fem"
    }
    $arguments = @(
      $resolver, $action, "--repo-root", $RepoRoot,
      "--fem-frontend", $Frontend, "--fem-device", $Device,
      "--fem-run-mode", $RunMode, "--fem-build-mode", $BuildMode,
      "--fem-web-port", $WebPort.ToString()
    )
    if ($ExpectedBuildId) { $arguments += @("--fem-expected-build-id", $ExpectedBuildId) }
    if (-not $Browser -and $ScriptPath) { $arguments += @("--fem-script", $ScriptPath) }
    if (-not $Browser -and $OutputDir) { $arguments += @("--fem-output-dir", $OutputDir) }
    if ($BuildOnly) { $arguments += "--fem-build-only" }
    if ($SkipLocalChanges) { $arguments += "--fem-skip-local-changes" }
    & $python.Source @arguments | Out-Host
    return [int]$LASTEXITCODE
  }
  finally {
    if ($null -eq $previousSlepc) {
      Remove-Item Env:FULLMAG_FEM_WITH_SLEPC -ErrorAction SilentlyContinue
    }
    else {
      $env:FULLMAG_FEM_WITH_SLEPC = $previousSlepc
    }
    if ($null -eq $previousRequestedDevice) {
      Remove-Item Env:FULLMAG_FEM_REQUESTED_DEVICE -ErrorAction SilentlyContinue
    }
    else {
      $env:FULLMAG_FEM_REQUESTED_DEVICE = $previousRequestedDevice
    }
  }
}

if ($env:FULLMAG_FORCE_WINDOWS_FEM_DOCKER -ne "1") {
  exit (Invoke-NativeWindowsFem)
}

# Compatibility callers that still pass a collected argument array remain
# supported by the legacy implementation (`@args` was its public contract).
$legacyLauncher = Join-Path $PSScriptRoot "run_fullmag_wsl.ps1"
if (-not (Test-Path -LiteralPath $legacyLauncher -PathType Leaf)) {
  throw "Windows FEM compatibility launcher is missing: $legacyLauncher"
}
$legacyArguments = @(
  "-BuildMode", $BuildMode,
  "-Frontend", $Frontend,
  "-Backend", $Backend,
  "-Device", $Device,
  "-RunMode", $RunMode,
  "-WebPort", $WebPort.ToString()
)
if ($ScriptPath) { $legacyArguments += @("-ScriptPath", $ScriptPath) }
if ($OutputDir) { $legacyArguments += @("-OutputDir", $OutputDir) }
if ($BuildOnly) { $legacyArguments += "-BuildOnly" }
if ($TestPackage) { $legacyArguments += @("-TestPackage", $TestPackage) }
if ($TestFilter) { $legacyArguments += @("-TestFilter", $TestFilter) }
if ($SkipLocalChanges) { $legacyArguments += "-SkipLocalChanges" }
& $legacyLauncher @legacyArguments
if ($null -ne $LASTEXITCODE) {
  exit $LASTEXITCODE
}
