[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("true", "false")]
  [string]$BuildMode,

  [ValidateSet("static", "dev")]
  [string]$Frontend = "dev",

  [ValidateSet("fem")]
  [string]$Backend = "fem",

  [ValidateSet("gpu")]
  [string]$Device = "gpu",

  [ValidateSet("interactive", "headless")]
  [string]$RunMode = "interactive",

  [Parameter(Mandatory = $true)]
  [string]$ScriptPath,

  [ValidateRange(1, 65535)]
  [int]$WebPort = 3100
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$defaultCacheRoot = "D:\fullmag-cache"
$defaultBuildRoot = "D:\fullmag-build"
$defaultTempRoot = "D:\fullmag-tmp"
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

function Require-DPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $resolved = Resolve-AbsolutePath $Path
  if ($resolved -notmatch "^[dD]:\\") {
    throw "$Label must be on drive D:, got $resolved"
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

function Test-DockerStorageOnD {
  $explicitRoot = $env:FULLMAG_DOCKER_STORAGE_ROOT
  if ($explicitRoot) {
    Require-DPath $explicitRoot "FULLMAG_DOCKER_STORAGE_ROOT"
    if (-not (Test-Path -LiteralPath $explicitRoot)) {
      throw "FULLMAG_DOCKER_STORAGE_ROOT does not exist: $explicitRoot"
    }
    return
  }

  $dockerDiskDirectory = Join-Path $env:LOCALAPPDATA "Docker\wsl\disk"
  if (Test-Path -LiteralPath $dockerDiskDirectory -PathType Container) {
    $directory = Get-Item -LiteralPath $dockerDiskDirectory
    if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      $target = @($directory.Target) -join ""
      if ($target -match "^[dD]:\\") {
        return
      }
    }
    $dockerVhdx = Join-Path $dockerDiskDirectory "docker_data.vhdx"
    if (Test-Path -LiteralPath $dockerVhdx -PathType Leaf) {
      throw "Docker Desktop disk image is still on C: ($dockerVhdx). Move Docker Desktop's disk image to D: or set FULLMAG_DOCKER_STORAGE_ROOT to its D: root before a CUDA build."
    }
  }

  $knownDRoots = @(
    "D:\DockerDesktop\wsl",
    "D:\DockerDesktop",
    "D:\docker-desktop"
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Container }
  if (-not $knownDRoots) {
    throw "Docker Desktop storage location is not proven to be on D:. Set FULLMAG_DOCKER_STORAGE_ROOT to the configured D: storage root before a CUDA build."
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
  $builderList = (& docker buildx ls 2>$null | Out-String)
  if ($builderList -notmatch "(?m)^\s*fullmag-windows(?:\*|\s)") {
    Invoke-External "docker" @("buildx", "create", "--name", $builderName, "--driver", "docker-container", "--use")
  } else {
    Invoke-External "docker" @("buildx", "use", $builderName)
  }
  Invoke-External "docker" @("buildx", "inspect", $builderName, "--bootstrap")
}

function Invoke-DockerImageBuild {
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
  $image = if ($env:FULLMAG_WINDOWS_FEM_GPU_IMAGE) {
    $env:FULLMAG_WINDOWS_FEM_GPU_IMAGE
  } else {
    "fullmag/fem-gpu:windows-local"
  }
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

if ($Backend -ne "fem" -or $Device -ne "gpu") {
  throw "WSL2 FEM launcher requires backend=fem and device=gpu; CPU fallback is forbidden"
}

Require-DPath $RepoRoot "Fullmag repository"
Require-Command "wsl.exe"
Require-Command "docker"
Test-DockerStorageOnD

Invoke-External "wsl.exe" @("--status")
$dockerOsType = (& docker info --format '{{.OSType}}').Trim()
if ($LASTEXITCODE -ne 0 -or $dockerOsType -ne "linux") {
  throw "FEM GPU on Windows requires Docker Desktop's Linux/WSL2 backend; detected OSTYPE=$dockerOsType"
}
Require-Command "nvidia-smi"
Invoke-External "nvidia-smi" @("-L")

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
$StateRoot = Join-Path $CacheRoot "state"
$CargoHome = Join-Path $CacheRoot "cargo"
$RustupHome = Join-Path $CacheRoot "rustup"
$PnpmRoot = Join-Path $CacheRoot "pnpm"
$NodeModulesRoot = Join-Path $CacheRoot "node-modules"
$ControlRoomNodeModulesRoot = Join-Path $CacheRoot "control-room-node-modules"
$TargetRoot = Join-Path $BuildRoot "cargo-targets\$CudaCacheKey"
$ComposeFile = Join-Path $RepoRoot "compose.windows.yaml"

foreach ($path in @($CacheRoot, $BuildRoot, $TempRoot, $StateRoot, $CargoHome, $RustupHome, $PnpmRoot, $NodeModulesRoot, $ControlRoomNodeModulesRoot, $TargetRoot)) {
  Require-DPath $path "Fullmag build/cache path"
  Ensure-Directory $path
}
if (-not (Test-Path -LiteralPath $ComposeFile -PathType Leaf)) {
  throw "Windows WSL compose file is missing: $ComposeFile"
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
$env:COMPOSE_PROJECT_NAME = "fullmag-windows-fem"
Ensure-BuildxBuilder

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

$makeTarget = if ($Frontend -eq "static") { "install-cli-static" } else { "install-cli-dev" }
Push-Location $RepoRoot
try {
  if ($BuildMode -eq "true") {
    Invoke-DockerImageBuild
    $buildCommand = @"
set -euo pipefail
cd /workspace
mkdir -p /workspace/.fullmag-build/cargo-targets/$CudaCacheKey /workspace/.fullmag-cache /workspace/.fullmag-cargo /workspace/.fullmag-rustup /tmp/fullmag-windows
rustup toolchain install nightly --profile minimal --no-self-update
if [ ! -f /workspace/apps/control-room/node_modules/.bin/next ]; then
  pnpm --dir /workspace/apps/control-room install --frozen-lockfile
fi
FULLMAG_CUDA_BASE_IMAGE=$CudaBaseImage FULLMAG_CARGO_TARGET_ROOT=/workspace/.fullmag-build/cargo-targets/$CudaCacheKey CARGO_TARGET_ROOT=/workspace/.fullmag-build/cargo-targets/$CudaCacheKey FULLMAG_FORCE_LOCAL_FEM_GPU=1 make $makeTarget
test -x /workspace/.fullmag/local/bin/fullmag
grep -Fxq cuda-fem-gpu /workspace/.fullmag/local/launcher-build-mode
"@
    # PowerShell here-strings use CRLF on Windows; bash treats the trailing
    # carriage return in `pipefail` as part of the option name.
    $buildCommand = $buildCommand.Replace("`r`n", "`n").Replace("`r", "`n")
    # Pass a single ASCII-safe argument through Docker/Compose. Directly
    # forwarding a multiline PowerShell string can corrupt shell option names
    # when Windows argument marshalling reintroduces carriage returns.
    $buildCommandBytes = [System.Text.Encoding]::UTF8.GetBytes($buildCommand)
    $buildCommandBase64 = [Convert]::ToBase64String($buildCommandBytes)
    $buildCommandPayload = "printf '%s' '$buildCommandBase64' | base64 --decode | bash"
    Invoke-DockerCompose @("run", "--rm", "--no-deps", "fullmag-windows-fem-gpu", "bash", "-lc", $buildCommandPayload)
  } elseif (-not (Test-Path -LiteralPath (Join-Path $StateRoot "local\bin\fullmag") -PathType Leaf)) {
    throw "Container-local FEM GPU launcher is missing at $StateRoot\local\bin\fullmag; rerun with build=True"
  }

  $manifest = [ordered]@{
    schema_version = 1
    backend = "fem"
    device = "gpu"
    runtime = "wsl2-docker-container-local"
    compose_file = $ComposeFile
    image = "fullmag/fem-gpu:windows-local"
    repository = $RepoRoot
    state_root = $StateRoot
    build_root = $BuildRoot
    cache_root = $CacheRoot
    cargo_target_root = $TargetRoot
    script = $resolvedScript
    built_at_utc = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $StateRoot "windows-wsl-fem-gpu-manifest.json") -Encoding UTF8

  Invoke-DockerCompose @("run", "--rm", "--no-deps", "fullmag-windows-fem-gpu", "nvidia-smi", "-L")

  $runArguments = @(
    "run", "--rm", "--no-deps", "--service-ports",
    "-e", "FULLMAG_FEM_EXECUTION=gpu",
    "-e", "FULLMAG_RELAX_DEVICE=gpu",
    "-e", "FULLMAG_FEM_MFEM_DEVICE=cuda",
    "-e", "FULLMAG_FEM_GPU_DEMAG_MODE=device_hypre_poisson",
    "-e", "FULLMAG_FEM_REQUIRE_GPU=1",
    "-e", "FULLMAG_FEM_REQUIRE_CEED=1",
    "-e", "FULLMAG_DISABLE_MANAGED_FEM_GPU_RUNTIME=1",
    "-e", "FULLMAG_FDM_EXECUTION=cpu",
    "fullmag-windows-fem-gpu",
    "bash", "-lc"
  )
  $cliArguments = @()
  if ($Frontend -eq "dev") { $cliArguments += "--dev" }
  if ($RunMode -eq "interactive") { $cliArguments += "-i" }
  $cliArguments += $containerScript
  $cliArguments += @("--backend", "fem")
  if ($RunMode -eq "headless") {
    $cliArguments += @("--headless", "--json")
  } else {
    $cliArguments += @("--web-port", $WebPort.ToString())
  }
  $quotedCli = ($cliArguments | ForEach-Object { Quote-Bash $_ }) -join " "
  $runCommand = "set -euo pipefail; cd /workspace; export PYTHONPATH=/workspace/packages/fullmag-py/src; exec /workspace/.fullmag/local/bin/fullmag $quotedCli"
  $runArguments += $runCommand
  Invoke-DockerCompose $runArguments
}
finally {
  Pop-Location
}
