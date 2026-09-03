# Canonical Windows FEM entry point.
#
# FEM is executed in a Linux container managed by Docker Desktop.  This
# launcher is called from Windows PowerShell and deliberately does not invoke
# wsl.exe or require a WSL checkout.  The historical run_fullmag_wsl.ps1 name
# is retained as a compatibility implementation for older scripts.

Write-Host "[Fullmag] FEM launcher started: $($MyInvocation.MyCommand.Path)" -ForegroundColor Cyan

$ErrorActionPreference = "Stop"

$legacyLauncher = Join-Path $PSScriptRoot "run_fullmag_wsl.ps1"
if (-not (Test-Path -LiteralPath $legacyLauncher -PathType Leaf)) {
  throw "Windows FEM launcher implementation is missing: $legacyLauncher"
}

& $legacyLauncher @args
if ($null -ne $LASTEXITCODE) {
  exit $LASTEXITCODE
}
