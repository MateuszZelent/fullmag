# Run arbitrary bash command inside the Windows FEM container
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Script,

  [ValidateSet("gpu", "cpu")]
  [string]$Device = "gpu"
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$repoDrive = [System.IO.Path]::GetPathRoot($RepoRoot)
$cacheRoot = Join-Path $repoDrive "fullmag-cache"
$buildRoot = Join-Path $repoDrive "fullmag-build"
$tempRoot = Join-Path $repoDrive "fullmag-tmp"
$cargoHome = Join-Path $cacheRoot "cargo"
$rustupHome = Join-Path $cacheRoot "rustup"

foreach ($p in @($cacheRoot, $buildRoot, $tempRoot, $cargoHome, $rustupHome)) {
  if (-not (Test-Path -LiteralPath $p)) {
    New-Item -ItemType Directory -Force -Path $p | Out-Null
  }
}

$image = if ($Device -eq "gpu") { "fullmag/fem-gpu:windows-local" } else { "fullmag/fem-cpu:windows-local" }

# Encode bash script as base64 to avoid Windows/PowerShell quoting issues
$scriptClean = $Script.Replace("`r`n", "`n").Replace("`r", "`n")
$b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($scriptClean))
$bashPayload = "printf '%s' '$b64' | base64 --decode | bash"

$dockerArgs = @(
  "run", "--rm",
  "-v", "${RepoRoot}:/workspace",
  "-v", "${buildRoot}:/workspace/.fullmag-build",
  "-v", "${cacheRoot}:/workspace/.fullmag-cache",
  "-v", "${cargoHome}:/workspace/.fullmag-cargo",
  "-v", "${rustupHome}:/workspace/.fullmag-rustup",
  "-v", "${tempRoot}:/tmp/fullmag-windows",
  "-e", "FULLMAG_CUDA_ARCHITECTURES=89",
  "-e", "CARGO_HOME=/workspace/.fullmag-cargo",
  "-e", "RUSTUP_HOME=/workspace/.fullmag-rustup",
  "-e", "CARGO_TARGET_ROOT=/workspace/.fullmag-build/cargo-targets",
  "-e", "FULLMAG_CARGO_TARGET_ROOT=/workspace/.fullmag-build/cargo-targets",
  "-e", "CMAKE_BUILD_PARALLEL_LEVEL=16",
  "-e", "FULLMAG_PYTHON=/usr/bin/python3",
  "-e", "FULLMAG_USE_MFEM_STACK=ON",
  "-e", "FULLMAG_FEM_REQUIRE_GPU=1",
  "-e", "FULLMAG_FEM_REQUIRE_CEED=1",
  "-e", "FULLMAG_FEM_MFEM_DEVICE=ceed-cuda:/gpu/cuda/shared",
  "-e", "CMAKE_PREFIX_PATH=/opt/fullmag-deps",
  "-e", "PKG_CONFIG_PATH=/opt/fullmag-deps/lib/pkgconfig:/opt/fullmag-deps/lib64/pkgconfig",
  "-e", "LD_LIBRARY_PATH=/usr/local/cuda/lib64:/opt/fullmag-deps/lib",
  "-e", "PATH=/usr/local/cuda/bin:/root/.cargo/bin:/pnpm:/opt/fullmag-deps/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "-e", "TMPDIR=/tmp/fullmag-windows"
)

if ($Device -eq "gpu") {
  $dockerArgs += @("--gpus", "all")
}

$dockerArgs += @($image, "bash", "-lc", $bashPayload)

& docker @dockerArgs
if ($LASTEXITCODE -ne 0) {
  throw "Container command failed with exit code $LASTEXITCODE"
}
