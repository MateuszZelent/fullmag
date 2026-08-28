[CmdletBinding()]
param(
  [switch]$InstallMissing,

  [ValidateSet("all", "native", "fem")]
  [string]$Lane = "all"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$RepoDriveRoot = [System.IO.Path]::GetPathRoot($RepoRoot)
$defaultCacheRoot = Join-Path $RepoDriveRoot "fullmag-cache"
$defaultBuildRoot = Join-Path $RepoDriveRoot "fullmag-build"
$defaultTempRoot = Join-Path $RepoDriveRoot "fullmag-tmp"

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
  return $resolved
}

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

$cacheCandidate = if ($env:FULLMAG_WINDOWS_CACHE_ROOT) { $env:FULLMAG_WINDOWS_CACHE_ROOT } else { $defaultCacheRoot }
$buildCandidate = if ($env:FULLMAG_WINDOWS_BUILD_ROOT) { $env:FULLMAG_WINDOWS_BUILD_ROOT } else { $defaultBuildRoot }
$tempCandidate = if ($env:FULLMAG_WINDOWS_TEMP_ROOT) { $env:FULLMAG_WINDOWS_TEMP_ROOT } else { $defaultTempRoot }
$CacheRoot = Require-ExternalBuildPath $cacheCandidate "FULLMAG_WINDOWS_CACHE_ROOT"
$BuildRoot = Require-ExternalBuildPath $buildCandidate "FULLMAG_WINDOWS_BUILD_ROOT"
$TempRoot = Require-ExternalBuildPath $tempCandidate "FULLMAG_WINDOWS_TEMP_ROOT"

foreach ($directory in @($CacheRoot, $BuildRoot, $TempRoot)) {
  Ensure-Directory $directory
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

foreach ($command in @("git", "cargo", "rustup", "cmake", "node", "pnpm", "python")) {
  if (-not (Test-Command $command)) {
    throw "Missing required command: $command"
  }
}

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
