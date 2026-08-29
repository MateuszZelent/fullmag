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

  [string]$ScriptPath,

  [switch]$BuildOnly,

  [ValidateRange(1, 65535)]
  [int]$WebPort = 3100
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$TargetTriple = "x86_64-pc-windows-msvc"
$RepoDriveRoot = [System.IO.Path]::GetPathRoot($RepoRoot)
$defaultCacheRoot = Join-Path $RepoDriveRoot "fullmag-cache"
$defaultBuildRoot = Join-Path $RepoDriveRoot "fullmag-build"

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
  throw "Missing required command: uv; run scripts/windows/setup_fullmag.ps1 -InstallMissing"
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
  $packagePath = Join-Path $RepoRoot "packages\fullmag-py[meshing]"
  Invoke-Uv @(
    "pip", "install", "--python", $PythonExe, "--editable", $packagePath
  )
}

function Ensure-ControlRoomDependencies {
  Require-Command "pnpm"
  $pnpmArguments = @("install", "--frozen-lockfile")
  $windowsSwc = Get-ChildItem `
    -LiteralPath (Join-Path $RepoRoot "node_modules\.pnpm") `
    -Directory `
    -Filter "@next+swc-win32-x64-msvc@*" `
    -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ((Test-Path -LiteralPath (Join-Path $RepoRoot "node_modules") -PathType Container) -and
      $null -eq $windowsSwc) {
    Write-Host "Replacing non-Windows node_modules with Windows dependencies"
    $pnpmArguments += "--force"
  }
  $previousCi = $env:CI
  $env:CI = "1"
  Push-Location $RepoRoot
  try {
    Invoke-External "pnpm" $pnpmArguments
    if ($Frontend -eq "static") {
      $env:FULLMAG_CONTROL_ROOM_STATIC_EXPORT = "1"
      try {
        Invoke-External "pnpm" @("--dir", "apps/control-room", "build")
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
  # Cargo places build-script output below the target triple directory.
  $searchRoot = Join-Path $TargetRoot "$TargetTriple\release\build"
  $dll = Get-ChildItem -LiteralPath $searchRoot -Filter "fullmag_fdm.dll" -File -Recurse -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if (-not $dll) {
    throw "CUDA build did not produce fullmag_fdm.dll below $searchRoot"
  }
  $destination = Join-Path (Split-Path -Parent $FullmagExe) "fullmag_fdm.dll"
  Copy-Item -LiteralPath $dll.FullName -Destination $destination -Force
  return (Resolve-AbsolutePath $destination)
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
$TargetRoot = if ($env:FULLMAG_WINDOWS_TARGET_DIR) {
  Resolve-AbsolutePath $env:FULLMAG_WINDOWS_TARGET_DIR
} else {
  Join-Path $BuildRoot "cargo-targets\fullmag-windows"
}
$CargoHome = Join-Path $CacheRoot "cargo"
$RustupHome = if ($env:FULLMAG_WINDOWS_RUSTUP_HOME) {
  Resolve-AbsolutePath $env:FULLMAG_WINDOWS_RUSTUP_HOME
} elseif (Get-Command "rustup" -ErrorAction SilentlyContinue) {
  (& rustup show home 2>$null | Select-Object -First 1).Trim()
} else {
  Join-Path $CacheRoot "rustup"
}
$PnpmHome = Join-Path $CacheRoot "pnpm-home"
$PnpmStore = Join-Path $CacheRoot "pnpm-store"
$PinnedPnpmVersion = "10.8.1"
$PinnedPnpmCli = Join-Path $CacheRoot "corepack\v1\pnpm\$PinnedPnpmVersion\bin\pnpm.cjs"
$NpmCache = Join-Path $CacheRoot "npm-cache"
$PipCache = Join-Path $CacheRoot "pip-cache"
$UvCache = Join-Path $CacheRoot "uv"
$TempRoot = Join-Path $CacheRoot "tmp"
$CudaCache = Join-Path $CacheRoot "cuda"
$PlaywrightRoot = Join-Path $CacheRoot "playwright-browsers"
$PythonRoot = Join-Path $CacheRoot "python"
$PythonVenv = Join-Path $PythonRoot "fullmag"
$PythonExe = Join-Path $PythonVenv "Scripts\python.exe"
$ManifestPath = Join-Path $BuildRoot "windows-runtime\build-manifest.json"
$FullmagExe = Join-Path $TargetRoot "$TargetTriple\release\fullmag.exe"
$FullmagApiExe = Join-Path $TargetRoot "$TargetTriple\release\fullmag-api.exe"
$StaticControlRoom = Join-Path $RepoRoot "apps\control-room\out\index.html"

foreach ($item in @(
  @{ Path = $CacheRoot; Label = "FULLMAG_WINDOWS_CACHE_ROOT" },
  @{ Path = $BuildRoot; Label = "FULLMAG_WINDOWS_BUILD_ROOT" },
  @{ Path = $TargetRoot; Label = "FULLMAG_WINDOWS_TARGET_DIR" },
  @{ Path = $RustupHome; Label = "FULLMAG_WINDOWS_RUSTUP_HOME" }
)) {
  Require-ExternalBuildPath $item.Path $item.Label
}

foreach ($directory in @(
  $CacheRoot, $BuildRoot, $TargetRoot, $CargoHome, $RustupHome, $PnpmHome,
  $PnpmStore, $NpmCache, $PipCache, $UvCache, $TempRoot, $CudaCache,
  $PlaywrightRoot, $PythonRoot, (Split-Path -Parent $ManifestPath)
)) {
  Ensure-Directory $directory
}

$env:CARGO_HOME = $CargoHome
$env:RUSTUP_HOME = $RustupHome
$env:RUSTUP_PERMIT_COPY_RENAME = "1"
$env:CARGO_TARGET_DIR = $TargetRoot
$env:CARGO_INCREMENTAL = "0"
$env:PNPM_HOME = $PnpmHome
$env:npm_config_store_dir = $PnpmStore
$env:npm_config_cache = $NpmCache
$env:COREPACK_HOME = Join-Path $CacheRoot "corepack"
$env:PIP_CACHE_DIR = $PipCache
$env:UV_CACHE_DIR = $UvCache
$env:UV_PYTHON_INSTALL_DIR = Join-Path $PythonRoot "managed"
$env:TEMP = $TempRoot
$env:TMP = $TempRoot
$env:CUDA_CACHE_PATH = $CudaCache
$env:PLAYWRIGHT_BROWSERS_PATH = $PlaywrightRoot
$env:PYTHONPYCACHEPREFIX = Join-Path $CacheRoot "python-bytecode"
$env:PYTHONDONTWRITEBYTECODE = "1"
$env:PYTHONPATH = Join-Path $RepoRoot "packages\fullmag-py\src"
$env:FULLMAG_PYTHON = $PythonExe
Add-NodePaths

if ($Backend -eq "fem") {
  throw "Native Windows launcher currently supports FDM only; FEM remains on its managed runtime path"
}

$useCuda = $Device -eq "gpu"
if ($useCuda -and $Backend -notin @("auto", "fdm")) {
  throw "device=gpu is only supported for the native Windows FDM lane"
}

$cudaCompiler = $null
$cudaBin = $null
Require-Command "git"
Require-Command "node"
if ($BuildMode -eq "true") {
  Require-Command "cargo"
  Require-Command "rustc"
  Require-Command "rustup"
  Require-Command "cmake"
  Import-VsEnvironment
  if ($useCuda) {
    $cudaCompiler = Resolve-CudaCompiler
    $cudaBin = Split-Path -Parent $cudaCompiler
    $env:CUDACXX = $cudaCompiler
    Prepend-PathEntry $cudaBin
  }
  Ensure-PythonEnvironment
  Ensure-ControlRoomDependencies
  $activeToolchain = (& rustup show active-toolchain 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $activeToolchain -notmatch "x86_64-pc-windows-msvc") {
    throw "An existing x86_64-pc-windows-msvc Rust toolchain is required; found: $activeToolchain"
  }
  Invoke-External "rustc" @("--version")
  Invoke-External "cargo" @("--version")

  $cargoArguments = @(
    "build", "--release", "--target", $TargetTriple,
    "-p", "fullmag-cli", "-p", "fullmag-api"
  )
  if ($useCuda) {
    $cargoArguments += @("--features", "cuda")
  }
  Push-Location $RepoRoot
  try {
    Invoke-External "cargo" $cargoArguments
  }
  finally {
    Pop-Location
  }

  if (-not (Test-Path -LiteralPath $FullmagExe -PathType Leaf)) {
    throw "Native Fullmag binary was not produced at $FullmagExe"
  }
  if (-not (Test-Path -LiteralPath $FullmagApiExe -PathType Leaf)) {
    throw "Native Fullmag API binary was not produced at $FullmagApiExe"
  }
  $nativeFdmDll = $null
  if ($useCuda) {
    $nativeFdmDll = Stage-NativeFdmDll
  }
  $manifest = [ordered]@{
    schema_version = 1
    target_triple = $TargetTriple
    binary = $FullmagExe
    api_binary = $FullmagApiExe
    backend = if ($Backend -eq "auto") { "auto" } else { $Backend }
    cuda = $useCuda
    features = if ($useCuda) { @("cuda") } else { @() }
    native_fdm_dll = $nativeFdmDll
    cuda_bin = $cudaBin
    cargo_target_dir = $TargetRoot
    cache_root = $CacheRoot
    git_commit = Get-GitCommit
    built_at_utc = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8
}
else {
  if (-not (Test-Path -LiteralPath $FullmagExe -PathType Leaf)) {
    throw "Native Windows Fullmag binary is missing at $FullmagExe; rerun with build=True"
  }
  if (-not (Test-Path -LiteralPath $FullmagApiExe -PathType Leaf)) {
    throw "Native Windows Fullmag API binary is missing at $FullmagApiExe; rerun with build=True"
  }
  if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
    throw "Fullmag Python environment is missing at $PythonExe; rerun with build=True"
  }
  if ($Frontend -eq "static" -and -not (Test-Path -LiteralPath $StaticControlRoom -PathType Leaf)) {
    throw "Static Control Room is missing at $StaticControlRoom; rerun with build=True or use dev"
  }
  if ($useCuda) {
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
      throw "CUDA build manifest is missing at $ManifestPath; rerun with build=True"
    }
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if (-not [bool]$manifest.cuda) {
      throw "Existing Windows runtime was not built with CUDA; rerun with build=True; CPU fallback is forbidden"
    }
    $nativeDll = Join-Path (Split-Path -Parent $FullmagExe) "fullmag_fdm.dll"
    if (-not (Test-Path -LiteralPath $nativeDll -PathType Leaf)) {
      throw "Native CUDA backend DLL is missing at $nativeDll; rerun with build=True"
    }
    if ($manifest.cuda_bin -and (Test-Path -LiteralPath $manifest.cuda_bin -PathType Container)) {
      Prepend-PathEntry $manifest.cuda_bin
    }
  }
}

if (-not (Test-Path -LiteralPath $PinnedPnpmCli -PathType Leaf)) {
  throw "Pinned pnpm $PinnedPnpmVersion is missing at $PinnedPnpmCli; rerun with build=True"
}
$resolvedPnpmVersion = (& node $PinnedPnpmCli --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $resolvedPnpmVersion -ne $PinnedPnpmVersion) {
  throw "Pinned pnpm validation failed at $PinnedPnpmCli; expected $PinnedPnpmVersion, got $resolvedPnpmVersion"
}
$env:FULLMAG_PNPM_CLI = $PinnedPnpmCli

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

$cliArguments = @()
if ($Frontend -eq "dev") {
  $cliArguments += "--dev"
}
if ($RunMode -eq "interactive") {
  $cliArguments += "-i"
}
$cliArguments += $resolvedScript
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
