[CmdletBinding()]
param(
  [ValidateSet("gpu", "cpu")]
  [string]$Device = "gpu",
  [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

function Resolve-AbsolutePath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "Path must not be empty"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Ensure-Directory([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function To-ComposePath([string]$Path) {
  return $Path.Replace("\", "/")
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = Join-Path $PSScriptRoot "..\.."
}
$RepoRoot = Resolve-AbsolutePath $RepoRoot
$ComposeFile = Join-Path $RepoRoot "compose.windows.yaml"
if (-not (Test-Path -LiteralPath $ComposeFile -PathType Leaf)) {
  throw "Windows FEM compose file is missing: $ComposeFile"
}

$repoDrive = [System.IO.Path]::GetPathRoot($RepoRoot)
$cacheRoot = if ($env:FULLMAG_WINDOWS_CACHE_ROOT) {
  $env:FULLMAG_WINDOWS_CACHE_ROOT
} else {
  Join-Path $repoDrive "fullmag-cache"
}
$buildRoot = if ($env:FULLMAG_WINDOWS_BUILD_ROOT) {
  $env:FULLMAG_WINDOWS_BUILD_ROOT
} else {
  Join-Path $repoDrive "fullmag-build"
}
$stateRoot = if ($env:FULLMAG_WINDOWS_STATE_ROOT) {
  $env:FULLMAG_WINDOWS_STATE_ROOT
} else {
  Join-Path $cacheRoot "state\fem-$Device"
}
$tempRoot = if ($env:FULLMAG_WINDOWS_TEMP_ROOT) {
  $env:FULLMAG_WINDOWS_TEMP_ROOT
} else {
  Join-Path $repoDrive "fullmag-tmp"
}
$cargoHome = if ($env:FULLMAG_WINDOWS_CARGO_HOME) {
  $env:FULLMAG_WINDOWS_CARGO_HOME
} else {
  Join-Path $cacheRoot "cargo"
}
$rustupHome = if ($env:FULLMAG_WINDOWS_RUSTUP_HOME) {
  $env:FULLMAG_WINDOWS_RUSTUP_HOME
} else {
  Join-Path $cacheRoot "rustup"
}
$pnpmRoot = if ($env:FULLMAG_WINDOWS_PNPM_ROOT) {
  $env:FULLMAG_WINDOWS_PNPM_ROOT
} else {
  Join-Path $cacheRoot "pnpm"
}
$nodeModulesRoot = if ($env:FULLMAG_WINDOWS_NODE_MODULES_ROOT) {
  $env:FULLMAG_WINDOWS_NODE_MODULES_ROOT
} else {
  Join-Path $cacheRoot "node-modules"
}
$controlRoomNodeModulesRoot = if ($env:FULLMAG_WINDOWS_CONTROL_ROOM_NODE_MODULES_ROOT) {
  $env:FULLMAG_WINDOWS_CONTROL_ROOM_NODE_MODULES_ROOT
} else {
  Join-Path $cacheRoot "control-room-node-modules"
}

foreach ($path in @(
    $cacheRoot, $buildRoot, $stateRoot, $tempRoot, $cargoHome, $rustupHome,
    $pnpmRoot, $nodeModulesRoot, $controlRoomNodeModulesRoot
  )) {
  Ensure-Directory $path
}

$env:FULLMAG_WINDOWS_REPO = To-ComposePath $RepoRoot
$env:FULLMAG_WINDOWS_STATE_ROOT = To-ComposePath $stateRoot
$env:FULLMAG_WINDOWS_BUILD_ROOT = To-ComposePath $buildRoot
$env:FULLMAG_WINDOWS_CACHE_ROOT = To-ComposePath $cacheRoot
$env:FULLMAG_WINDOWS_TEMP_ROOT = To-ComposePath $tempRoot
$env:FULLMAG_WINDOWS_CARGO_HOME = To-ComposePath $cargoHome
$env:FULLMAG_WINDOWS_RUSTUP_HOME = To-ComposePath $rustupHome
$env:FULLMAG_WINDOWS_PNPM_ROOT = To-ComposePath $pnpmRoot
$env:FULLMAG_WINDOWS_NODE_MODULES_ROOT = To-ComposePath $nodeModulesRoot
$env:FULLMAG_WINDOWS_CONTROL_ROOM_NODE_MODULES_ROOT = To-ComposePath $controlRoomNodeModulesRoot
$env:COMPOSE_PROJECT_NAME = "fullmag-windows-fem"

$identityPython = Get-Command "python" -ErrorAction SilentlyContinue
if (-not $identityPython) {
  throw "Python is required to capture the exact Fullmag source identity"
}
$identityOutput = (& $identityPython.Path (Join-Path $RepoRoot "scripts\capture_source_snapshot_identity.py") --repo-root $RepoRoot --ignore-non-runtime-dirty | Out-String)
if ($LASTEXITCODE -ne 0) {
  throw "Fullmag source identity capture failed with exit code $LASTEXITCODE"
}
$sourceIdentity = $identityOutput | ConvertFrom-Json
$env:FULLMAG_SOURCE_GIT_COMMIT = [string]$sourceIdentity.head_commit_full
$env:FULLMAG_SOURCE_WORKTREE_STATE = if ($sourceIdentity.source_snapshot_dirty) { "dirty" } else { "clean" }
$env:FULLMAG_SOURCE_SNAPSHOT_SHA256 = [string]$sourceIdentity.source_snapshot_sha256

$serviceName = "fullmag-windows-fem-$Device"
$targetRoot = Join-Path $buildRoot "native-contract\$Device"
Ensure-Directory $targetRoot
$containerTargetRoot = "/workspace/.fullmag-build/native-contract/$Device"
$runtimeLibraryPath = if ($Device -eq "gpu") {
  "/workspace/.fullmag-build/native-contract/$Device/backends/fem:/opt/fullmag-deps/lib"
} else {
  "/workspace/.fullmag-build/native-contract/$Device/backends/fem:/opt/fullmag-deps/lib"
}
$targets = if ($Device -eq "gpu") {
  @(
    "fem_frequency_domain_contract",
    "fem_frequency_domain_checked_extent_contract",
    "fem_poisson_airbox_shared_domain_contract",
    "fem_mesh_symmetry_certificate_v6_contract",
    "fem_mode_kinematics_contract",
    "fem_linearized_dynamic_pencil_contract",
    "fem_operator_contract",
    "fem_modal_eigen_contract",
    "fem_poisson_airbox_modal_eigen_slepc_contract",
    "fem_driven_response_contract",
    "fem_window_partition_contract",
    "fem_mode_deduplication_contract",
    "fem_contour_interval_solver_contract"
  )
} else {
  # The Windows CPU image deliberately omits PETSc/SLEPc.  Keep the CPU
  # route honest by running only the native contracts that do not require the
  # optional sparse-direct or modal dependency slice; those gates have their
  # own managed GPU/PETSc route above.
  @(
    "fem_frequency_domain_checked_extent_contract",
    "fem_poisson_airbox_shared_domain_contract",
    "fem_mesh_symmetry_certificate_v6_contract",
    "fem_mode_kinematics_contract",
    "fem_linearized_dynamic_pencil_contract",
    "fem_operator_contract",
    "fem_driven_response_contract",
    "fem_window_partition_contract",
    "fem_mode_deduplication_contract",
    "fem_contour_interval_solver_contract"
  )
}
$buildTargets = ($targets | ForEach-Object { 'cmake --build "$build_dir" --target {0}' -f $_ }) -join "`n"
$runTargets = ($targets | ForEach-Object {
    if ($_ -eq "fem_poisson_airbox_modal_eigen_slepc_contract") {
      # Keep this Windows recapture scoped to the CPU Schur complete-window
      # regression. The same binary also contains separate bounded GPU
      # validation fixtures whose diagnostics contract is qualified elsewhere.
      'FULLMAG_N2_CW1_FOCUSED=1 "$build_dir/backends/fem/{0}"' -f $_
    } else {
      '"$build_dir/backends/fem/{0}"' -f $_
    }
  }) -join "`n"
$cmakeOptions = if ($Device -eq "gpu") {
  '-DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON'
} else {
  '-DFULLMAG_ENABLE_CUDA=OFF -DFULLMAG_ENABLE_FEM_GPU=OFF -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF'
}
$buildCommand = @'
set -euo pipefail
cd /workspace
build_dir=__CONTRACT_BUILD_DIR__
cmake -S native -B "$build_dir" __CMAKE_OPTIONS__
__BUILD_TARGETS__
export LD_LIBRARY_PATH=__RUNTIME_LIBRARY_PATH__:"${LD_LIBRARY_PATH:-}"
__RUN_TARGETS__
'@
$buildCommand = $buildCommand.Replace("__CONTRACT_BUILD_DIR__", $containerTargetRoot)
$buildCommand = $buildCommand.Replace("__CMAKE_OPTIONS__", $cmakeOptions)
$buildCommand = $buildCommand.Replace("__BUILD_TARGETS__", $buildTargets)
$buildCommand = $buildCommand.Replace("__RUNTIME_LIBRARY_PATH__", $runtimeLibraryPath)
$buildCommand = $buildCommand.Replace("__RUN_TARGETS__", $runTargets)
$buildCommand = $buildCommand.Replace("`r`n", "`n").Replace("`r", "`n")
$payload = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($buildCommand))
$composeArgs = @(
  "-f", $ComposeFile,
  "run", "--rm", "--no-deps"
)
if ($Device -eq "gpu") {
  $composeArgs += @("-e", "FULLMAG_FEM_EXECUTION=gpu", "-e", "FULLMAG_FEM_MFEM_DEVICE=ceed-cuda:/gpu/cuda/shared", "-e", "FULLMAG_FEM_REQUIRE_GPU=1", "-e", "FULLMAG_FEM_REQUIRE_CEED=1")
} else {
  $composeArgs += @("-e", "FULLMAG_FEM_EXECUTION=cpu", "-e", "FULLMAG_FEM_MFEM_DEVICE=cpu", "-e", "FULLMAG_FEM_REQUIRE_GPU=0", "-e", "FULLMAG_FEM_REQUIRE_CEED=0")
}
$composeArgs += @(
  $serviceName,
  "bash", "-lc",
  "printf '%s' '$payload' | base64 --decode | bash"
)
& docker compose @composeArgs
if ($LASTEXITCODE -ne 0) {
  throw "Windows FEM $Device native contract suite failed with exit code $LASTEXITCODE"
}
Write-Host "Windows FEM $Device native frequency-domain contract suite passed"
Write-Host "- targets: $($targets.Count)"
Write-Host "- worktree: $RepoRoot"
Write-Host "- build root: $targetRoot"
Write-Host "- source snapshot: $($sourceIdentity.source_snapshot_sha256)"
