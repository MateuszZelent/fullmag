# Historical compatibility alias. The canonical Windows FEM Docker Desktop
# implementation is owned by run_fullmag_fem.ps1 and does not invoke WSL.

$ErrorActionPreference = "Stop"

$canonicalLauncher = Join-Path $PSScriptRoot "run_fullmag_fem.ps1"
if (-not (Test-Path -LiteralPath $canonicalLauncher -PathType Leaf)) {
  throw "Canonical Windows FEM launcher is missing: $canonicalLauncher"
}

& $canonicalLauncher @args
if ($null -ne $LASTEXITCODE) {
  exit $LASTEXITCODE
}
