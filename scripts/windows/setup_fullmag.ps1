[CmdletBinding()]
param(
  [switch]$InstallMissing,

  [ValidateSet("all", "native", "fem")]
  [string]$Lane = "all"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

$StorageAdapter = Join-Path $RepoRoot "scripts\windows\fullmag_storage.ps1"
if (-not (Test-Path -LiteralPath $StorageAdapter -PathType Leaf)) {
  throw "Fullmag Windows storage adapter is missing: $StorageAdapter"
}
. $StorageAdapter
$StorageProfile = "windows-setup"

if ($env:FULLMAG_STORAGE_MANAGED_ENTRY -ne "1") {
  $managedArguments = @("-Lane", $Lane)
  if ($InstallMissing) { $managedArguments += "-InstallMissing" }
  $managedExitCode = Invoke-FullmagStorageManagedScript `
    -RepoRoot $RepoRoot -Profile $StorageProfile -ScriptPath $PSCommandPath `
    -Arguments $managedArguments
  exit $managedExitCode
}

$StorageLayout = Resolve-FullmagStorageLayout -RepoRoot $RepoRoot -Profile $StorageProfile
Set-FullmagStorageEnvironment -Layout $StorageLayout
$WorkspaceNamespace = [string]$StorageLayout.worktree_id
$CacheRoot = [string]$StorageLayout.cache_root
$BuildRoot = [string]$StorageLayout.build_root
$TempRoot = [string]$StorageLayout.temp_root

function Ensure-Directory {
  param([Parameter(Mandatory = $true)][string]$Path)
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Test-Command {
  param([Parameter(Mandatory = $true)][string]$Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Checked {
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

$PinnedPnpmVersion = "10.8.1"
$CorepackHome = [string]$StorageLayout.env.COREPACK_HOME
$PinnedPnpmCli = Join-Path $CorepackHome "v1\pnpm\$PinnedPnpmVersion\bin\pnpm.cjs"

foreach ($item in @(
    @{ Path = $CacheRoot; Label = "FULLMAG_WINDOWS_CACHE_ROOT" },
    @{ Path = $BuildRoot; Label = "FULLMAG_WINDOWS_BUILD_ROOT" },
    @{ Path = $TempRoot; Label = "FULLMAG_WINDOWS_TEMP_ROOT" },
    @{ Path = $CorepackHome; Label = "COREPACK_HOME" }
  )) {
  $null = Assert-FullmagStoragePath -Layout $StorageLayout -Path $item.Path -Label $item.Label
}

foreach ($directory in @($CacheRoot, $BuildRoot, $TempRoot)) {
  Ensure-Directory $directory
}

function Ensure-PinnedPnpm {
  Ensure-Directory $CorepackHome
  if (-not (Test-Path -LiteralPath $PinnedPnpmCli -PathType Leaf)) {
    if (-not $InstallMissing) {
      throw "Pinned pnpm $PinnedPnpmVersion is missing at $PinnedPnpmCli; run this script again with -InstallMissing"
    }
    $corepack = Get-Command "corepack" -ErrorAction SilentlyContinue
    if (-not $corepack) {
      throw "Corepack is required to provision pinned pnpm $PinnedPnpmVersion at $PinnedPnpmCli"
    }
    Invoke-Checked $corepack.Source @("install", "--global", "pnpm@$PinnedPnpmVersion")
  }
  if (-not (Test-Path -LiteralPath $PinnedPnpmCli -PathType Leaf)) {
    throw "Corepack did not provision pinned pnpm $PinnedPnpmVersion at $PinnedPnpmCli"
  }
  $resolvedVersion = (& node $PinnedPnpmCli --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $resolvedVersion -ne $PinnedPnpmVersion) {
    throw "Pinned pnpm validation failed at $PinnedPnpmCli; expected $PinnedPnpmVersion, got $resolvedVersion"
  }
}

$ToolsRoot = Join-Path $CacheRoot "tools"
$CargoToolsBin = Join-Path $ToolsRoot "bin"
$PythonToolsScripts = Join-Path $ToolsRoot "Scripts"
foreach ($directory in @($ToolsRoot, $CargoToolsBin, $PythonToolsScripts)) {
  Ensure-Directory $directory
}
$env:Path = (@($CargoToolsBin, $PythonToolsScripts, $env:Path) | Select-Object -Unique) -join [System.IO.Path]::PathSeparator

$gitBash = Join-Path $env:ProgramFiles "Git\bin\bash.exe"
if (-not (Test-Path -LiteralPath $gitBash -PathType Leaf)) {
  throw "Git Bash is required at $gitBash because the current justfile recipes use bash"
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
  throw "vswhere.exe not found; install Visual Studio Build Tools with the C++ workload"
}
$vsPath = (& $vswhere -products "*" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -latest -property installationPath 2>$null | Select-Object -First 1).Trim()
$vcvars = if ($vsPath) { Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat" } else { "" }
if (-not $vcvars -or -not (Test-Path -LiteralPath $vcvars -PathType Leaf)) {
  throw "vcvars64.bat not found; install the Visual Studio C++ workload"
}

foreach ($command in @("git", "cargo", "rustup", "cmake", "node", "python")) {
  if (-not (Test-Command $command)) {
    throw "Missing required command: $command"
  }
}

Ensure-PinnedPnpm

$managedJust = Join-Path $CargoToolsBin "just.exe"
if (-not (Test-Path -LiteralPath $managedJust -PathType Leaf)) {
  if (-not $InstallMissing) {
    throw "Missing required command: just. Run this script again with -InstallMissing"
  }
  Invoke-Checked "cargo" @("install", "just", "--locked", "--root", $ToolsRoot)
}

$uvExe = Join-Path $PythonToolsScripts "uv.exe"
if (-not (Test-Command "uv") -and -not (Test-Path -LiteralPath $uvExe -PathType Leaf)) {
  if (-not $InstallMissing) {
    throw "Missing required command: uv. Run this script again with -InstallMissing"
  }
  Invoke-Checked "python" @("-m", "pip", "install", "--prefix", $ToolsRoot, "--ignore-installed", "uv")
}
if (-not (Test-Path -LiteralPath $managedJust -PathType Leaf)) {
  throw "just installation did not produce an executable below $CargoToolsBin"
}
if (-not (Test-Command "uv") -and -not (Test-Path -LiteralPath $uvExe -PathType Leaf)) {
  throw "uv installation did not produce $uvExe"
}

if ($Lane -in @("all", "fem")) {
  if (-not (Test-Command "docker")) {
    throw "Missing required command for the FEM container lane: docker"
  }
  & docker info --format '{{.OSType}}' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Docker Desktop is installed but its Linux engine is not available"
  }
}

Write-Host "Fullmag Windows environment is ready"
Write-Host "- repository: $RepoRoot"
Write-Host "- cache: $CacheRoot"
Write-Host "- build: $BuildRoot"
Write-Host "- temp: $TempRoot"
Write-Host "- MSVC: $vcvars"
Write-Host "- Git Bash: $gitBash"
Write-Host "- tools: $ToolsRoot"
if (-not (Test-Command "just")) {
  Write-Host "- just: $managedJust"
  Write-Host "  Add $CargoToolsBin to PATH for new shells before invoking just recipes."
}
Write-Host "Use FULLMAG_WINDOWS_CACHE_ROOT, FULLMAG_WINDOWS_BUILD_ROOT, and FULLMAG_WINDOWS_TEMP_ROOT to override storage."
