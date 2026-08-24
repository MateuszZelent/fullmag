[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("true", "false")]
  [string]$BuildMode,

  [ValidateSet("static", "dev")]
  [string]$Frontend = "dev",

  [ValidateSet("auto", "fdm", "fem")]
  [string]$Backend = "auto",

  [ValidateSet("auto", "cpu", "gpu")]
  [string]$Device = "auto",

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
$ComposeFile = Join-Path $RepoRoot "compose.windows.yaml"
$ServiceName = "fullmag-wsl-gpu"
$defaultCacheRoot = "D:\fullmag-cache"
$defaultBuildRoot = "D:\fullmag-build"

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

function ConvertTo-ComposePath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return ((Resolve-AbsolutePath $Path) -replace "\\", "/")
}

function Invoke-External {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter()][string[]]$Arguments = @()
  )
  Write-Host ("> " + $Command + " " + ($Arguments -join " "))
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $Command @Arguments
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorAction
  }
  if ($exitCode -ne 0) {
    throw "$Command failed with exit code $exitCode"
  }
}

function Invoke-Captured {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter()][string[]]$Arguments = @()
  )
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = @(& $Command @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorAction
  }
  return [pscustomobject]@{
    Output = $output
    ExitCode = $exitCode
  }
}

function Invoke-Compose {
  param([Parameter()][string[]]$Arguments = @())
  Invoke-External "docker" (@("compose", "-f", $ComposeFile) + $Arguments)
}

function Set-ComposeEnvironment {
  $env:FULLMAG_WINDOWS_SOURCE_ROOT = ConvertTo-ComposePath $RepoRoot
  $env:FULLMAG_WINDOWS_STATE_ROOT = ConvertTo-ComposePath $StateRoot
  $env:FULLMAG_WINDOWS_BUILD_ROOT = ConvertTo-ComposePath $BuildMountRoot
  $env:FULLMAG_WINDOWS_CACHE_ROOT = ConvertTo-ComposePath $CacheRoot
  $env:FULLMAG_WINDOWS_TMP_ROOT = ConvertTo-ComposePath $TempRoot
  $env:FULLMAG_WINDOWS_WEB_PORT = $WebPort.ToString()
}

function Test-WslDockerPrerequisites {
  Require-Command "wsl.exe"
  Require-Command "docker.exe"

  $wslStatus = Invoke-Captured "wsl.exe" @("--status")
  if ($wslStatus.ExitCode -ne 0) {
    throw "WSL2 is unavailable; install/update WSL2 before using the Windows container route"
  }

  $composeVersion = Invoke-Captured "docker" @("compose", "version")
  if ($composeVersion.ExitCode -ne 0) {
    throw "Docker Compose is unavailable; install Docker Desktop with Compose support"
  }

  $dockerInfo = Invoke-Captured "docker" @("info", "--format", "{{.OSType}}")
  $dockerOs = ($dockerInfo.Output | Out-String).Trim()
  if ($dockerInfo.ExitCode -ne 0 -or $dockerOs -ne "linux") {
    throw "WSL2 route requires Docker Desktop using the Linux container backend; detected Docker OS '$dockerOs'"
  }
}

function Test-ContainerGpu {
  $result = Invoke-Captured "docker" @(
    "compose", "-f", $ComposeFile, "--profile", "windows-wsl", "run", "--rm", "--no-deps", "-T",
    $ServiceName, "nvidia-smi", "-L"
  )
  $result.Output | Out-Host
  if ($result.ExitCode -ne 0) {
    throw "WSL2 Docker GPU is unavailable; CPU fallback is forbidden for device=gpu"
  }
}

function Get-GitCommit {
  $result = Invoke-Captured "git" @("-C", $RepoRoot, "rev-parse", "HEAD")
  if ($result.ExitCode -ne 0) {
    return "unknown"
  }
  return ($result.Output | Out-String).Trim()
}

function Quote-Bash {
  param([Parameter(Mandatory = $true)][string]$Value)
  $replacement = "'" + [char]34 + "'" + [char]34 + "'"
  return "'" + $Value.Replace("'", $replacement) + "'"
}

function Resolve-ContainerScriptPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $resolved = if ([System.IO.Path]::IsPathRooted($Path)) {
    Resolve-AbsolutePath $Path
  }
  else {
    Resolve-AbsolutePath (Join-Path $RepoRoot $Path)
  }
  $repoPrefix = $RepoRoot.TrimEnd("\") + "\"
  if (-not $resolved.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "WSL2 container route requires the simulation script to be inside the repository: $resolved"
  }
  $relative = $resolved.Substring($repoPrefix.Length) -replace "\\", "/"
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
    throw "Fullmag script not found: $resolved"
  }
  return "/workspace/$relative"
}

function Invoke-ContainerBuild {
  $installTarget = if ($Frontend -eq "static") { "install-cli-static" } else { "install-cli-dev" }
  $cpuOnly = if ($Device -eq "cpu") { "1" } else { "0" }
  $buildScript = @"
set -euo pipefail
cd /workspace
mkdir -p /workspace/.fullmag-cache /workspace/.fullmag-build /workspace/.fullmag
rustup toolchain install nightly --profile minimal --no-self-update
FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT=1 \
FULLMAG_BUILD_CPU_ONLY=$cpuOnly \
FULLMAG_CARGO_TARGET_DIR=/workspace/.fullmag-build/cargo-targets/fullmag-cli \
CARGO_TARGET_DIR=/workspace/.fullmag-build/cargo-targets/fullmag-cli \
CARGO_INCREMENTAL=0 \
make $installTarget
test -x /workspace/.fullmag/local/bin/fullmag
test -x /workspace/.fullmag/local/bin/fullmag-bin
"@
  Invoke-Compose @(
    "--profile", "windows-wsl", "run", "--rm", "--no-deps", "-T", $ServiceName,
    "bash", "-lc", $buildScript
  )
}

function Write-BuildManifest {
  $manifest = [ordered]@{
    schema_version = 1
    runtime = "wsl2-docker"
    container_service = $ServiceName
    compose_file = $ComposeFile
    binary = "/workspace/.fullmag/local/bin/fullmag-bin"
    launcher = "/workspace/.fullmag/local/bin/fullmag"
    backend = $Backend
    device = $Device
    cuda = ($Device -eq "gpu")
    features = if ($Device -eq "gpu") { @("cuda") } else { @() }
    state_root = $StateRoot
    build_root = $BuildMountRoot
    cache_root = $CacheRoot
    cargo_target_dir = Join-Path $BuildMountRoot "cargo-targets\fullmag-cli"
    git_commit = Get-GitCommit
    built_at_utc = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8
}

function Test-ExistingBuild {
  if (-not (Test-Path -LiteralPath $ContainerLauncher -PathType Leaf)) {
    throw "WSL2 Fullmag launcher is missing at $ContainerLauncher; rerun with build=True"
  }
  if (-not (Test-Path -LiteralPath $ContainerBinary -PathType Leaf)) {
    throw "WSL2 Fullmag binary is missing at $ContainerBinary; rerun with build=True"
  }
  if ($Frontend -eq "static" -and -not (Test-Path -LiteralPath (Join-Path $StateRoot "local\web\index.html") -PathType Leaf)) {
    throw "Static Control Room is missing under $StateRoot; rerun with build=True or use dev"
  }
  if ($Device -eq "gpu") {
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
      throw "WSL2 CUDA build manifest is missing at $ManifestPath; rerun with build=True"
    }
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if ($manifest.runtime -ne "wsl2-docker" -or -not [bool]$manifest.cuda) {
      throw "Existing WSL2 runtime was not built with CUDA; rerun with build=True; CPU fallback is forbidden"
    }
  }
}

function Invoke-ContainerRuntime {
  param([Parameter(Mandatory = $true)][string]$ContainerScriptPath)
  $execution = switch ($Device) {
    "gpu" { "cuda" }
    "cpu" { "cpu" }
    default { $null }
  }
  $cliArguments = @()
  if ($Frontend -eq "dev") {
    $cliArguments += "--dev"
  }
  if ($RunMode -eq "interactive") {
    $cliArguments += "-i"
  }
  $cliArguments += $ContainerScriptPath
  if ($Backend -ne "auto") {
    $cliArguments += @("--backend", $Backend)
  }
  if ($RunMode -eq "headless") {
    $cliArguments += @("--headless", "--json")
  }
  else {
    $cliArguments += @("--web-port", $WebPort.ToString())
  }
  $quotedArguments = ($cliArguments | ForEach-Object { Quote-Bash $_ }) -join " "
  $runScript = "set -euo pipefail; cd /workspace; exec /workspace/.fullmag/local/bin/fullmag $quotedArguments"
  $composeArguments = @(
    "--profile", "windows-wsl", "run", "--rm", "--no-deps", "--service-ports"
  )
  if ($RunMode -eq "headless") {
    $composeArguments += "-T"
  }
  if ($execution) {
    $composeArguments += @("-e", "FULLMAG_FDM_EXECUTION=$execution")
  }
  if ($RunMode -eq "headless") {
    $composeArguments += @("-e", "FULLMAG_API_PORT=0")
  }
  $composeArguments += @($ServiceName, "bash", "-lc", $runScript)
  Invoke-Compose $composeArguments
}

if ($Backend -eq "fem") {
  throw "WSL2 Windows launcher currently supports the explicit FDM lane; use the managed FEM recipes for backend=fem"
}

$CacheRoot = if ($env:FULLMAG_WINDOWS_CACHE_ROOT) {
  Resolve-AbsolutePath $env:FULLMAG_WINDOWS_CACHE_ROOT
}
else {
  $defaultCacheRoot
}
$BuildRoot = if ($env:FULLMAG_WINDOWS_BUILD_ROOT) {
  Resolve-AbsolutePath $env:FULLMAG_WINDOWS_BUILD_ROOT
}
else {
  $defaultBuildRoot
}
$BuildMountRoot = Join-Path $BuildRoot "windows-wsl"
$StateRoot = Join-Path $BuildMountRoot "state"
$TempRoot = Join-Path $CacheRoot "tmp"
$ManifestPath = Join-Path $BuildMountRoot "build-manifest.json"
$ContainerLauncher = Join-Path $StateRoot "local\bin\fullmag"
$ContainerBinary = Join-Path $StateRoot "local\bin\fullmag-bin"

Require-DPath $CacheRoot "FULLMAG_WINDOWS_CACHE_ROOT"
Require-DPath $BuildRoot "FULLMAG_WINDOWS_BUILD_ROOT"
foreach ($directory in @($CacheRoot, $BuildRoot, $BuildMountRoot, $StateRoot, $TempRoot)) {
  Ensure-Directory $directory
}
if (-not (Test-Path -LiteralPath $ComposeFile -PathType Leaf)) {
  throw "Windows WSL2 Compose file is missing at $ComposeFile"
}

Set-ComposeEnvironment
Test-WslDockerPrerequisites
if ($BuildMode -eq "true") {
  Invoke-Compose @("--profile", "windows-wsl", "build", $ServiceName)
}
if ($Device -eq "gpu") {
  Test-ContainerGpu
}
if ($BuildMode -eq "true") {
  Invoke-ContainerBuild
  Write-BuildManifest
}
else {
  Test-ExistingBuild
}

$containerScript = Resolve-ContainerScriptPath $ScriptPath
Write-Host "Windows host -> WSL2 Docker Fullmag runtime"
Write-Host "- service: $ServiceName"
Write-Host "- script: $containerScript"
Write-Host "- backend: $Backend"
Write-Host "- device: $Device"
Write-Host "- cache root: $CacheRoot"
Write-Host "- build root: $BuildMountRoot"
Invoke-ContainerRuntime $containerScript
