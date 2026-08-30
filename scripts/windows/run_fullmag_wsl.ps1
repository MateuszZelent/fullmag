[CmdletBinding()]
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

  [ValidateSet("interactive", "headless")]
  [string]$RunMode = "interactive",

  [string]$ScriptPath,

  [switch]$BuildOnly,

  [ValidateRange(1, 65535)]
  [int]$WebPort = 3100
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$RepoDriveRoot = [System.IO.Path]::GetPathRoot($RepoRoot)
$defaultCacheRoot = Join-Path $RepoDriveRoot "fullmag-cache"
$defaultBuildRoot = Join-Path $RepoDriveRoot "fullmag-build"
$defaultTempRoot = Join-Path $RepoDriveRoot "fullmag-tmp"
$CudaBaseImage = if ($env:FULLMAG_CUDA_BASE_IMAGE) {
  $env:FULLMAG_CUDA_BASE_IMAGE
} else {
  "nvidia/cuda:12.6.3-devel-ubuntu22.04"
}
$CudaCacheKey = (($CudaBaseImage -replace "[^A-Za-z0-9]+", "-").Trim("-")).ToLowerInvariant()

function Resolve-AbsolutePath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path)
}

function Require-ExternalBuildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $resolved = (Resolve-AbsolutePath $Path).TrimEnd("\")
  $repo = $RepoRoot.TrimEnd("\")
  if (-not [System.IO.Path]::IsPathRooted($resolved)) {
    throw "$Label must be an absolute Windows path, got $resolved"
  }
  if ($resolved -eq [System.IO.Path]::GetPathRoot($resolved).TrimEnd("\")) {
    throw "$Label must not use a drive root directly, got $resolved"
  }
  if ($resolved.Equals($repo, [System.StringComparison]::OrdinalIgnoreCase) -or
      $resolved.StartsWith($repo + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be outside the repository, got $resolved"
  }
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

function Get-Sha256File {
  param([Parameter(Mandatory = $true)][string]$Path)
  # Do not depend on the optional Microsoft.PowerShell.Utility module here.
  # Some Windows PowerShell installations expose the module only after an
  # explicit import, which made a successful container build fail while
  # writing its manifest.  The .NET implementation is available in the
  # Windows PowerShell versions supported by this launcher.
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

function Invoke-External {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter()][string[]]$Arguments = @()
  )
  Write-Host ("> " + $Command + " " + ($Arguments -join " "))
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

function To-ComposePath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Resolve-AbsolutePath $Path).Replace("\", "/")
}

function Quote-Bash {
  param([Parameter(Mandatory = $true)][string]$Value)
  $replacement = "'" + [char]34 + "'" + [char]34 + "'"
  return "'" + $Value.Replace("'", $replacement) + "'"
}

function Get-RelativeUriPath {
  param(
    [Parameter(Mandatory = $true)][string]$BasePath,
    [Parameter(Mandatory = $true)][string]$Path
  )
  $baseUri = New-Object System.Uri(((Resolve-AbsolutePath $BasePath).TrimEnd("\") + "\"))
  $pathUri = New-Object System.Uri((Resolve-AbsolutePath $Path))
  return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($pathUri).ToString())
}

function Test-ExplicitDockerStorageRoot {
  $explicitRoot = $env:FULLMAG_DOCKER_STORAGE_ROOT
  if ($explicitRoot) {
    Require-ExternalBuildPath $explicitRoot "FULLMAG_DOCKER_STORAGE_ROOT"
    if (-not (Test-Path -LiteralPath $explicitRoot)) {
      throw "FULLMAG_DOCKER_STORAGE_ROOT does not exist: $explicitRoot"
    }
  }
}

function Invoke-DockerCompose {
  param([Parameter()][string[]]$Arguments = @())
  $composeArguments = @("compose", "-f", $ComposeFile) + $Arguments
  Write-Host ("docker compose " + ($composeArguments -join " "))
  & docker @composeArguments
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose failed with exit code $LASTEXITCODE"
  }
}

function Ensure-BuildxBuilder {
  $builderName = "fullmag-windows"
  $env:BUILDX_BUILDER = $builderName
  # Docker Desktop reports an unavailable Windows-engine builder on stderr even
  # when the active Linux builder list succeeds with exit code 0. With the
  # script-wide ErrorActionPreference=Stop, PowerShell otherwise promotes that
  # diagnostic to a terminating NativeCommandError.
  $savedErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    # Capture the native command result before running a PowerShell pipeline.
    # Select-Object/Out-String can clear LASTEXITCODE even when Docker exits 0.
    $builderListOutput = @(& docker buildx ls 2>$null)
    $builderListExitCode = $LASTEXITCODE
    $builderList = ($builderListOutput -join [Environment]::NewLine)
  }
  finally {
    $ErrorActionPreference = $savedErrorActionPreference
  }
  if ($builderListExitCode -ne 0) {
    throw "docker buildx ls failed with exit code $builderListExitCode"
  }
  if ($builderList -notmatch "(?m)^\s*fullmag-windows(?:\*|\s)") {
    Invoke-External "docker" @("buildx", "create", "--name", $builderName, "--driver", "docker-container", "--use")
  } else {
    Invoke-External "docker" @("buildx", "use", $builderName)
  }
  Invoke-External "docker" @("buildx", "inspect", $builderName, "--bootstrap")
}

function Invoke-DockerImageBuild {
  $image = if ($Device -eq "cpu") {
    if ($env:FULLMAG_WINDOWS_FEM_CPU_IMAGE) {
      $env:FULLMAG_WINDOWS_FEM_CPU_IMAGE
    } else {
      "fullmag/fem-cpu:windows-local"
    }
  } else {
    if ($env:FULLMAG_WINDOWS_FEM_GPU_IMAGE) {
      $env:FULLMAG_WINDOWS_FEM_GPU_IMAGE
    } else {
      "fullmag/fem-gpu:windows-local"
    }
  }
  $savedErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    # Do not pipe the native command to Out-Null: PowerShell may clear
    # LASTEXITCODE and turn a valid existing image into a false miss.
    $null = @(& docker image inspect $image --format '{{.Id}}' 2>$null)
    $imageInspectExitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $savedErrorActionPreference
  }
  if ($imageInspectExitCode -eq 0 -and $env:FULLMAG_WINDOWS_REBUILD_FEM_IMAGE -ne "1") {
    Write-Host "Reusing FEM image $image (set FULLMAG_WINDOWS_REBUILD_FEM_IMAGE=1 to rebuild)"
    return
  }

  Ensure-BuildxBuilder
  if ($Device -eq "cpu") {
    Invoke-External "docker" @(
      "buildx", "build",
      "--builder", "fullmag-windows",
      "--load",
      "--progress=plain",
      "--file", (Join-Path $RepoRoot "docker\fem-cpu\Dockerfile"),
      "--tag", $image,
      $RepoRoot
    )
    return
  }
  $cudaArchitectures = if ($env:FULLMAG_CUDA_ARCHITECTURES) {
    $env:FULLMAG_CUDA_ARCHITECTURES
  } else {
    "80-real;89-real;90-real;90-virtual"
  }
  $hypreArchitectures = if ($env:FULLMAG_HYPRE_GPU_ARCHITECTURES) {
    $env:FULLMAG_HYPRE_GPU_ARCHITECTURES
  } else {
    "60 70 80 89 90"
  }
  $hypreMemoryVariant = if ($env:FULLMAG_HYPRE_MEMORY_VARIANT) {
    $env:FULLMAG_HYPRE_MEMORY_VARIANT
  } else {
    "baseline"
  }
  $dockerfile = Join-Path $RepoRoot "docker\fem-gpu\Dockerfile"
  $arguments = @(
    "buildx", "build",
    "--builder", "fullmag-windows",
    "--load",
    "--progress=plain",
    "--file", $dockerfile,
    "--tag", $image,
    "--build-arg", "FULLMAG_CUDA_BASE_IMAGE=$CudaBaseImage",
    "--build-arg", "FULLMAG_CUDA_ARCHITECTURES=$cudaArchitectures",
    "--build-arg", "FULLMAG_HYPRE_GPU_ARCHITECTURES=$hypreArchitectures",
    "--build-arg", "FULLMAG_HYPRE_MEMORY_VARIANT=$hypreMemoryVariant",
    $RepoRoot
  )
  Invoke-External "docker" $arguments
}

function Get-DockerImageId {
  param([Parameter(Mandatory = $true)][string]$Image)
  $savedErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    # Capture LASTEXITCODE immediately after Docker; Select-Object can reset it.
    $imageOutput = @(& docker image inspect $Image --format '{{.Id}}' 2>$null)
    $imageExitCode = $LASTEXITCODE
    $imageId = if ($imageOutput.Count -gt 0) { [string]$imageOutput[0] } else { "" }
    $imageId = $imageId.Trim()
  }
  finally {
    $ErrorActionPreference = $savedErrorActionPreference
  }
  if ($imageExitCode -ne 0 -or -not $imageId) {
    throw "Docker image is unavailable: $Image; build it with BuildMode=true"
  }
  return $imageId
}

if ($Backend -ne "fem") {
  throw "Windows FEM container launcher requires backend=fem"
}

Require-Command "docker"
Test-ExplicitDockerStorageRoot

$dockerOsType = (& docker info --format '{{.OSType}}').Trim()
if ($LASTEXITCODE -ne 0 -or $dockerOsType -ne "linux") {
  throw "FEM on Windows requires Docker Desktop's Linux engine; detected OSTYPE=$dockerOsType"
}
$RequestedDevice = $Device
if ($Device -eq "auto") {
  $nvidiaSmi = Get-Command "nvidia-smi" -ErrorAction SilentlyContinue
  if ($nvidiaSmi) {
    & $nvidiaSmi.Path -L 2>$null | Out-Null
  }
  $Device = if ($nvidiaSmi -and $LASTEXITCODE -eq 0) { "gpu" } else { "cpu" }
  Write-Host "Resolved FEM device auto -> $Device"
}
if ($Device -eq "gpu") {
  if (-not (Get-Command "nvidia-smi" -ErrorAction SilentlyContinue)) {
    throw "FEM GPU requires nvidia-smi; CPU fallback is forbidden for an explicit GPU request"
  }
  Invoke-External "nvidia-smi" @("-L")
}

$CacheRoot = if ($env:FULLMAG_WINDOWS_CACHE_ROOT) {
  Resolve-AbsolutePath $env:FULLMAG_WINDOWS_CACHE_ROOT
} else {
  $defaultCacheRoot
}
$BuildRoot = if ($env:FULLMAG_WINDOWS_BUILD_ROOT) {
  Resolve-AbsolutePath $env:FULLMAG_WINDOWS_BUILD_ROOT
} else {
  $defaultBuildRoot
}
$TempRoot = if ($env:FULLMAG_WINDOWS_TEMP_ROOT) {
  Resolve-AbsolutePath $env:FULLMAG_WINDOWS_TEMP_ROOT
} else {
  $defaultTempRoot
}
$RuntimeKey = "fem-$Device"
$StateRoot = Join-Path $CacheRoot "state\$RuntimeKey"
$CargoHome = Join-Path $CacheRoot "cargo"
$RustupHome = Join-Path $CacheRoot "rustup"
$PnpmRoot = Join-Path $CacheRoot "pnpm"
$NodeModulesRoot = Join-Path $CacheRoot "node-modules"
$ControlRoomNodeModulesRoot = Join-Path $CacheRoot "control-room-node-modules"
$TargetKey = if ($Device -eq "gpu") { $CudaCacheKey } else { "fem-cpu" }
$TargetRoot = Join-Path $BuildRoot "cargo-targets\$TargetKey"
$ComposeFile = Join-Path $RepoRoot "compose.windows.yaml"
$ServiceName = "fullmag-windows-fem-$Device"
$RuntimeImage = if ($Device -eq "gpu") {
  if ($env:FULLMAG_WINDOWS_FEM_GPU_IMAGE) {
    $env:FULLMAG_WINDOWS_FEM_GPU_IMAGE
  } else {
    "fullmag/fem-gpu:windows-local"
  }
} else {
  if ($env:FULLMAG_WINDOWS_FEM_CPU_IMAGE) {
    $env:FULLMAG_WINDOWS_FEM_CPU_IMAGE
  } else {
    "fullmag/fem-cpu:windows-local"
  }
}

foreach ($path in @($CacheRoot, $BuildRoot, $TempRoot, $StateRoot, $CargoHome, $RustupHome, $PnpmRoot, $NodeModulesRoot, $ControlRoomNodeModulesRoot, $TargetRoot)) {
  Require-ExternalBuildPath $path "Fullmag build/cache path"
  Ensure-Directory $path
}
if (-not (Test-Path -LiteralPath $ComposeFile -PathType Leaf)) {
  throw "Windows FEM compose file is missing: $ComposeFile"
}

$env:FULLMAG_WINDOWS_REPO = To-ComposePath $RepoRoot
$env:FULLMAG_WINDOWS_STATE_ROOT = To-ComposePath $StateRoot
$env:FULLMAG_WINDOWS_BUILD_ROOT = To-ComposePath $BuildRoot
$env:FULLMAG_WINDOWS_CACHE_ROOT = To-ComposePath $CacheRoot
$env:FULLMAG_WINDOWS_TEMP_ROOT = To-ComposePath $TempRoot
$env:FULLMAG_WINDOWS_CARGO_HOME = To-ComposePath $CargoHome
$env:FULLMAG_WINDOWS_RUSTUP_HOME = To-ComposePath $RustupHome
$env:FULLMAG_WINDOWS_PNPM_ROOT = To-ComposePath $PnpmRoot
$env:FULLMAG_WINDOWS_NODE_MODULES_ROOT = To-ComposePath $NodeModulesRoot
$env:FULLMAG_WINDOWS_CONTROL_ROOM_NODE_MODULES_ROOT = To-ComposePath $ControlRoomNodeModulesRoot
$env:FULLMAG_WINDOWS_WEB_PORT = $WebPort.ToString()
$containerWebPort = 3100
$env:COMPOSE_PROJECT_NAME = "fullmag-windows-fem"
$identityPython = Get-Command "python" -ErrorAction SilentlyContinue
if (-not $identityPython) {
  throw "Python is required to capture the exact Fullmag source identity"
}
$previousGitOptionalLocks = $env:GIT_OPTIONAL_LOCKS
$identityOutput = $null
$identityExitCode = 0
try {
  # Source capture only reads the index and worktree.  Disable Git's optional
  # index refresh for this probe so a concurrent VS Code commit cannot race
  # with the launcher over .git/index.lock.  Restore the caller's setting
  # immediately after the capture; mandatory Git locks remain unaffected.
  $env:GIT_OPTIONAL_LOCKS = "0"
  $identityOutput = (& $identityPython.Path (Join-Path $RepoRoot "scripts\capture_source_snapshot_identity.py") --repo-root $RepoRoot --ignore-non-runtime-dirty | Out-String)
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
  throw "Fullmag source identity capture failed with exit code $identityExitCode"
}
$sourceIdentity = $identityOutput | ConvertFrom-Json
$env:FULLMAG_SOURCE_GIT_COMMIT = [string]$sourceIdentity.head_commit_full
$env:FULLMAG_SOURCE_WORKTREE_STATE = if ($sourceIdentity.source_snapshot_dirty) { "dirty" } else { "clean" }
$env:FULLMAG_SOURCE_SNAPSHOT_SHA256 = [string]$sourceIdentity.source_snapshot_sha256
$ManifestPath = Join-Path $StateRoot "windows-fem-$Device-manifest.json"
$RuntimeBinaryPath = Join-Path $StateRoot "local\bin\fullmag"
$RuntimeApiPath = Join-Path $StateRoot "local\bin\fullmag-api"

$resolvedScript = $null
$containerScript = $null
if ($ScriptPath) {
  $resolvedScript = if ([System.IO.Path]::IsPathRooted($ScriptPath)) {
    Resolve-AbsolutePath $ScriptPath
  } else {
    Resolve-AbsolutePath (Join-Path $RepoRoot $ScriptPath)
  }
  if (-not (Test-Path -LiteralPath $resolvedScript -PathType Leaf)) {
    throw "Fullmag script not found: $resolvedScript"
  }
  $relativeScript = (Get-RelativeUriPath $RepoRoot $resolvedScript).Replace("\", "/")
  if ($relativeScript.StartsWith("../") -or $relativeScript -eq "..") {
    throw "Fullmag script must be inside the repository: $resolvedScript"
  }
  $containerScript = "/workspace/$relativeScript"
} elseif (-not $BuildOnly) {
  throw "ScriptPath is required unless -BuildOnly is used"
}

$makeTarget = if ($Frontend -eq "static") { "install-cli-static" } else { "install-cli-dev" }
$buildMutex = $null
$buildMutexHeld = $false
Push-Location $RepoRoot
try {
  if ($BuildMode -eq "true") {
    # The dev and static targets intentionally share the local launcher and
    # Cargo target cache.  Serialize Windows builds so a concurrent frontend
    # cannot replace the binaries or manifest while this invocation is
    # validating them.
    $buildMutex = New-Object -TypeName System.Threading.Mutex -ArgumentList @($false, "Local\FullmagWindowsFEMBuild")
    Write-Host "Waiting for Fullmag Windows build lock..."
    try {
      $buildMutexHeld = $buildMutex.WaitOne()
    }
    catch [System.Threading.AbandonedMutexException] {
      # The previous owner exited unexpectedly; the OS grants ownership to
      # this waiter, so the build can safely repair the shared state.
      $buildMutexHeld = $true
      Write-Warning "Recovered an abandoned Fullmag Windows build lock"
    }
    if (-not $buildMutexHeld) {
      throw "Could not acquire the Fullmag Windows build lock"
    }
    Write-Host "Acquired Fullmag Windows build lock"
    Invoke-DockerImageBuild
    $buildCommand = if ($Device -eq "gpu") { @"
set -euo pipefail
cd /workspace
mkdir -p /workspace/.fullmag-build/cargo-targets/$TargetKey /workspace/.fullmag-cache /workspace/.fullmag-cargo /workspace/.fullmag-rustup /tmp/fullmag-windows
rustup toolchain install nightly --profile minimal --no-self-update
if [ ! -f /workspace/apps/control-room/node_modules/.bin/next ]; then
  pnpm --dir /workspace/apps/control-room install --frozen-lockfile
fi
FULLMAG_CUDA_BASE_IMAGE=$CudaBaseImage FULLMAG_CARGO_TARGET_ROOT=/workspace/.fullmag-build/cargo-targets/$TargetKey CARGO_TARGET_ROOT=/workspace/.fullmag-build/cargo-targets/$TargetKey FULLMAG_FORCE_LOCAL_FEM_GPU=1 make $makeTarget
test -x /workspace/.fullmag/local/bin/fullmag
grep -Fxq cuda-fem-gpu /workspace/.fullmag/local/launcher-build-mode
"@
    } else { @"
set -euo pipefail
cd /workspace
mkdir -p /workspace/.fullmag-build/cargo-targets/$TargetKey /workspace/.fullmag-cache /workspace/.fullmag-cargo /workspace/.fullmag-rustup /tmp/fullmag-windows
rustup toolchain install nightly --profile minimal --no-self-update
if [ ! -f /workspace/apps/control-room/node_modules/.bin/next ]; then
  pnpm --dir /workspace/apps/control-room install --frozen-lockfile
fi
FULLMAG_CARGO_TARGET_ROOT=/workspace/.fullmag-build/cargo-targets/$TargetKey CARGO_TARGET_ROOT=/workspace/.fullmag-build/cargo-targets/$TargetKey FULLMAG_FORCE_LOCAL_FEM_CPU=1 make $makeTarget
test -x /workspace/.fullmag/local/bin/fullmag
grep -Fxq fem-cpu /workspace/.fullmag/local/launcher-build-mode
"@ }
    # PowerShell here-strings use CRLF on Windows; bash treats the trailing
    # carriage return in `pipefail` as part of the option name.
    $buildCommand = $buildCommand.Replace("`r`n", "`n").Replace("`r", "`n")
    # Pass a single ASCII-safe argument through Docker/Compose. Directly
    # forwarding a multiline PowerShell string can corrupt shell option names
    # when Windows argument marshalling reintroduces carriage returns.
    $buildCommandBytes = [System.Text.Encoding]::UTF8.GetBytes($buildCommand)
    $buildCommandBase64 = [Convert]::ToBase64String($buildCommandBytes)
    $buildCommandPayload = "printf '%s' '$buildCommandBase64' | base64 --decode | bash"
    Invoke-DockerCompose @("run", "--rm", "--no-deps", $ServiceName, "bash", "-lc", $buildCommandPayload)
  } elseif (-not (Test-Path -LiteralPath $RuntimeBinaryPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $RuntimeApiPath -PathType Leaf)) {
    throw "Container-local FEM $Device launcher is missing at $StateRoot\local\bin\fullmag; rerun with build=True"
  }

  $imageId = Get-DockerImageId $RuntimeImage

  if ($BuildMode -eq "true") {
    $manifest = [ordered]@{
      schema_version = 2
      backend = "fem"
      requested_device = $RequestedDevice
      device = $Device
      runtime = "docker-desktop-linux-container-local"
      compose_file = $ComposeFile
      image = $RuntimeImage
      image_id = $imageId
      repository = $RepoRoot
      state_root = $StateRoot
      build_root = $BuildRoot
      cache_root = $CacheRoot
      cargo_target_root = $TargetRoot
      script = $resolvedScript
      git_commit = [string]$sourceIdentity.head_commit_full
      worktree_state = if ($sourceIdentity.source_snapshot_dirty) { "dirty" } else { "clean" }
      source_snapshot_sha256 = [string]$sourceIdentity.source_snapshot_sha256
      binary_sha256 = Get-Sha256File -Path $RuntimeBinaryPath
      api_binary_sha256 = Get-Sha256File -Path $RuntimeApiPath
      built_at_utc = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8
  } else {
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
      throw "Windows FEM $Device build manifest is missing at $ManifestPath; rerun with build=True"
    }
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    $binaryHash = Get-Sha256File -Path $RuntimeBinaryPath
    $apiBinaryHash = Get-Sha256File -Path $RuntimeApiPath
    $expectedWorktreeState = if ($sourceIdentity.source_snapshot_dirty) { "dirty" } else { "clean" }
    if ([int]$manifest.schema_version -ne 2 -or
        [string]$manifest.git_commit -ne [string]$sourceIdentity.head_commit_full -or
        [string]$manifest.worktree_state -ne $expectedWorktreeState -or
        [string]$manifest.source_snapshot_sha256 -ne [string]$sourceIdentity.source_snapshot_sha256 -or
        [string]$manifest.binary_sha256 -ne $binaryHash -or
        [string]$manifest.api_binary_sha256 -ne $apiBinaryHash -or
        [string]$manifest.image_id -ne $imageId) {
      throw "Existing Windows FEM $Device runtime does not match the current source identity or binary hashes; rerun with build=True"
    }
  }

  if ($BuildOnly) {
    Write-Host "Windows FEM $Device container build is ready"
    Write-Host "- image: $RuntimeImage"
    Write-Host "- state root: $StateRoot"
    Write-Host "- build root: $BuildRoot"
    exit 0
  }

  # The mutex protects the shared build outputs and manifest, not the
  # potentially long-running simulation.  Release it before starting the
  # container so an interactive/headless run cannot block a later VS Code or
  # terminal build for the duration of the solve.
  if ($buildMutexHeld) {
    $buildMutex.ReleaseMutex()
    $buildMutexHeld = $false
    $buildMutex.Dispose()
    $buildMutex = $null
  }

  if ($Device -eq "gpu") {
    Invoke-DockerCompose @("run", "--rm", "--no-deps", $ServiceName, "nvidia-smi", "-L")
  }

  $runArguments = @(
    "run", "--rm", "--no-deps", "--service-ports"
  )
  foreach ($entry in @(
    "FULLMAG_FEM_EXECUTION=$Device",
    "FULLMAG_RELAX_DEVICE=$Device",
    "FULLMAG_SP4_DEVICE=$Device",
    $(if ($Device -eq "gpu") { "FULLMAG_FEM_MFEM_DEVICE=cuda" } else { "FULLMAG_FEM_MFEM_DEVICE=cpu" }),
    $(if ($Device -eq "gpu") { "FULLMAG_FEM_REQUIRE_GPU=1" } else { "FULLMAG_FEM_REQUIRE_GPU=0" }),
    $(if ($Device -eq "gpu") { "FULLMAG_FEM_REQUIRE_CEED=1" } else { "FULLMAG_FEM_REQUIRE_CEED=0" }),
    "FULLMAG_DISABLE_MANAGED_FEM_GPU_RUNTIME=1",
    "FULLMAG_FDM_EXECUTION=cpu",
    $(if ($RunMode -eq "headless") { "FULLMAG_API_PORT=0" } else { $null })
  )) {
    if ([string]::IsNullOrWhiteSpace([string]$entry)) {
      continue
    }
    $runArguments += @("-e", $entry)
  }
  # Keep the canonical SP4 scenario configurable from the Windows shell while
  # forwarding only its documented scalar controls.  Arbitrary host
  # environment is deliberately not copied into the container.
  foreach ($name in @(
    "FULLMAG_SP4_PHASE",
    "FULLMAG_SP4_CASE",
    "FULLMAG_SP4_MESH",
    "FULLMAG_SP4_AIRBOX",
    "FULLMAG_SP4_TOPOLOGY_VARIANT",
    "FULLMAG_SP4_LAYERS",
    "FULLMAG_SP4_DURATION_S",
    "FULLMAG_SP4_RELAX_ALGORITHM",
    "FULLMAG_SP4_RELAX_MAX_STEPS",
    "FULLMAG_SP4_RELAX_TOL_APM"
  )) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($null -ne $value -and $value -ne "") {
      $runArguments += @("-e", "${name}=$value")
    }
  }
  if ($Device -eq "gpu") {
    $runArguments += @("-e", "FULLMAG_FEM_GPU_DEMAG_MODE=device_hypre_poisson")
  }
  $runArguments += @($ServiceName, "bash", "-lc")
  $cliArguments = @()
  if ($Frontend -eq "dev") { $cliArguments += "--dev" }
  if ($RunMode -eq "interactive") { $cliArguments += "-i" }
  $cliArguments += $containerScript
  $cliArguments += @("--backend", "fem")
  if ($RunMode -eq "headless") {
    $cliArguments += @("--headless", "--json")
  } else {
    # Compose publishes the caller-selected host port as host:$WebPort ->
    # container:3100.  The CLI must therefore always bind the container-side
    # port; passing $WebPort here makes every non-default host port unreachable.
    $cliArguments += @("--web-port", $containerWebPort.ToString())
  }
  $quotedCli = ($cliArguments | ForEach-Object { Quote-Bash $_ }) -join " "
  # Keep the packaged PyO3 extension root on PYTHONPATH.  The `fullmag`
  # wrapper normally adds it itself, but this shell command is the final
  # process boundary and used to overwrite PYTHONPATH with only the source
  # package.  That hid `_fullmag_core.so`, forcing every v2 cache hit through
  # the expensive Python full audit on the Windows bind mount.
  $runCommand = "set -euo pipefail; cd /workspace; export PYTHONPATH=/workspace/packages/fullmag-py/src:/workspace/.fullmag/local; exec /workspace/.fullmag/local/bin/fullmag $quotedCli"
  $runArguments += $runCommand
  Invoke-DockerCompose $runArguments
}
finally {
  if ($null -ne $buildMutex) {
    if ($buildMutexHeld) {
      try {
        $buildMutex.ReleaseMutex()
      }
      catch [System.Threading.SynchronizationLockException] {
        Write-Warning "Fullmag Windows build lock was not owned during release"
      }
    }
    $buildMutex.Dispose()
  }
  Pop-Location
}
