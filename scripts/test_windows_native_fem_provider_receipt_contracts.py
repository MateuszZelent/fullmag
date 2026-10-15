"""Exercise native FEM provider receipt admission without compiling anything.

The fixture invokes the production receipt validators through Windows
PowerShell 5.1.  It covers both the build/reuse launcher and the MSI package
reader, including the managed zstd helper manifest and the MSMPI inventory.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import textwrap

import pytest


ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "scripts/windows/run_fullmag.ps1"
PACKAGE = ROOT / "scripts/windows/native_fem_package.ps1"
DEPENDENCIES = ROOT / "scripts/windows/native_fem_dependencies.ps1"
REQUIREMENTS = ROOT / "windows_build_requirements.json"
RUN_NATIVE_WINDOWS_POWERSHELL = os.environ.get("FULLMAG_RUN_NATIVE_WINDOWS_POWERSHELL") == "1"
PS = shutil.which("powershell.exe") or shutil.which("pwsh")
if RUN_NATIVE_WINDOWS_POWERSHELL and not PS:
    PS = os.environ.get("FULLMAG_WINDOWS_POWERSHELL")
NATIVE_WINDOWS_SKIP = pytest.mark.skipif(
    not PS or (os.name != "nt" and not RUN_NATIVE_WINDOWS_POWERSHELL),
    reason="native Windows PowerShell 5.1 required",
)


def native_path(path: Path) -> str:
    if os.name == "nt" or not RUN_NATIVE_WINDOWS_POWERSHELL:
        return str(path)
    wslpath = shutil.which("wslpath")
    if not wslpath:
        raise AssertionError("wslpath is required for the explicit WSL PowerShell run")
    return subprocess.check_output(
        [wslpath, "-w", str(path)], text=True, timeout=10
    ).strip()


def extract_function(source: str, name: str, next_name: str) -> str:
    start = source.index(f"function {name} {{")
    end = source.index(f"function {next_name} {{", start)
    return source[start:end]


DRIVER = r'''
param($RunMpi, $RunZstd, $Package, $Dependencies, $RequirementsPath, $ProviderRoot, $SourceRoot, $Case)
$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSEdition -ne "Desktop" -or $PSVersionTable.PSVersion.Major -ne 5) {
  [Console]::Error.WriteLine("PS5_REQUIRED")
  exit 77
}

$providerRoot = [IO.Path]::GetFullPath($ProviderRoot)
$sourceRoot = [IO.Path]::GetFullPath($SourceRoot)
New-Item -ItemType Directory -Force -Path $providerRoot, $sourceRoot | Out-Null
$downloadRoot = Join-Path $providerRoot "downloads"
$toolRoot = Join-Path $providerRoot "tools"
$mpiInclude = Join-Path $toolRoot "msmpi-10.1.1\PFiles\Microsoft SDKs\MPI\Include"
$mpiLibraryRoot = Join-Path $toolRoot "msmpi-10.1.1\PFiles\Microsoft SDKs\MPI\Lib\x64"
New-Item -ItemType Directory -Force -Path $downloadRoot, $mpiInclude, $mpiLibraryRoot | Out-Null

$requirements = Get-Content -LiteralPath $RequirementsPath -Raw | ConvertFrom-Json
$helper = $requirements.provider_bootstrap.internal_helpers.zstd
$archive = Join-Path $downloadRoot ([string]$helper.archive)
$zstdDirectory = Join-Path $toolRoot ([string]$helper.tool_directory)
New-Item -ItemType Directory -Force -Path $zstdDirectory | Out-Null
$executable = Join-Path $zstdDirectory ([string]$helper.executable_name)
$mpiHeader = Join-Path $mpiInclude "mpi.h"
$mpiLibrary = Join-Path $mpiLibraryRoot "msmpi.lib"
[IO.File]::WriteAllText($archive, "receipt archive")
[IO.File]::WriteAllText($executable, "receipt zstd")
[IO.File]::WriteAllText($mpiHeader, "receipt mpi header")
[IO.File]::WriteAllText($mpiLibrary, "receipt mpi library")
$archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
$executableHash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
$mpiHeaderHash = (Get-FileHash -LiteralPath $mpiHeader -Algorithm SHA256).Hash.ToLowerInvariant()
$mpiLibraryHash = (Get-FileHash -LiteralPath $mpiLibrary -Algorithm SHA256).Hash.ToLowerInvariant()
$helper.archive_sha256 = $archiveHash
if ($Case -eq "missing-host") {
  $helper.PSObject.Properties.Remove("host_requirement")
}
elseif ($Case -eq "wrong-host") {
  $helper.host_requirement = "false"
}
$requirements | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $sourceRoot "windows_build_requirements.json")

function Resolve-AbsolutePath {
  param([string]$Path)
  return [IO.Path]::GetFullPath($Path)
}
function Test-NativeFemPathWithin {
  param([string]$Path, [string]$Base)
  $candidate = [IO.Path]::GetFullPath($Path).TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
  $root = [IO.Path]::GetFullPath($Base).TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
  return $candidate.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
}
function Assert-NativeFemPathChain {
  param([string]$Path, [string]$Base, [string]$Label, [switch]$Leaf)
  $resolved = [IO.Path]::GetFullPath($Path)
  if (-not (Test-NativeFemPathWithin -Path $resolved -Base $Base)) { throw "$Label escapes its root" }
  $kind = if ($Leaf) { "Leaf" } else { "Container" }
  if (-not (Test-Path -LiteralPath $resolved -PathType $kind)) { throw "$Label is missing" }
  return $resolved
}
function Get-Sha256File {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

. $RunMpi
. $RunZstd
. $Package
. $Dependencies

$tools = @(
  [pscustomobject]@{ path = $executable; sha256 = $executableHash },
  [pscustomobject]@{ path = $mpiHeader; sha256 = $mpiHeaderHash },
  [pscustomobject]@{ path = $mpiLibrary; sha256 = $mpiLibraryHash }
)
if ($Case -eq "unbound-mpi") {
  $tools = @($tools | Where-Object { $_.path -ne $mpiLibrary })
}
$zstdReceiptHash = $archiveHash
if ($Case -eq "mutated-archive") { $zstdReceiptHash = "0" * 64 }
$receipt = [pscustomobject]@{
  mpi_include = $mpiInclude
  mpi_library = $mpiLibrary
  tools = $tools
  zstd = [pscustomobject]@{
    kind = [string]$helper.kind
    version = [string]$helper.version
    url = [string]$helper.url
    archive = $archive
    archive_name = [string]$helper.archive
    archive_sha256 = $zstdReceiptHash
    executable = $executable
    executable_name = [string]$helper.executable_name
    executable_sha256 = $executableHash
    decode_memory = [string]$helper.decode_memory
  }
}

$runZstdError = $null
try { Assert-NativeFemProviderZstd -Receipt $receipt -Requirements $requirements -ProviderRoot $providerRoot | Out-Null } catch { $runZstdError = $_.Exception.Message }
$runMpiError = $null
try { Assert-NativeFemProviderMpiReceipt -Receipt $receipt -ProviderRoot $providerRoot | Out-Null } catch { $runMpiError = $_.Exception.Message }
$packageMpiError = $null
try { Assert-FullmagMsiReceiptMpiInventory -Receipt $receipt -ProviderRoot $providerRoot | Out-Null } catch { $packageMpiError = $_.Exception.Message }
$bootstrapError = $null
try { Get-FullmagNativeFemZstdRequirement -SourceRoot $sourceRoot | Out-Null } catch { $bootstrapError = $_.Exception.Message }
[pscustomobject]@{
  run_zstd_ok = ($null -eq $runZstdError)
  run_mpi_ok = ($null -eq $runMpiError)
  package_mpi_ok = ($null -eq $packageMpiError)
  bootstrap_ok = ($null -eq $bootstrapError)
  run_zstd_error = [string]$runZstdError
  run_mpi_error = [string]$runMpiError
  package_mpi_error = [string]$packageMpiError
  bootstrap_error = [string]$bootstrapError
} | ConvertTo-Json -Compress
'''


def test_receipt_contract_sources_require_typed_non_host_helper() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8-sig")
    bootstrap = DEPENDENCIES.read_text(encoding="utf-8-sig")
    assert 'helperPropertyNames -notcontains "host_requirement"' in launcher
    assert '$helper.host_requirement -isnot [bool]' in launcher
    assert 'helperPropertyNames -notcontains "host_requirement"' in bootstrap
    assert '$helper.host_requirement -isnot [bool]' in bootstrap
    assert "Assert-NativeFemProviderMpiReceipt -Receipt $receiptObject" in launcher
    package = PACKAGE.read_text(encoding="utf-8-sig")
    assert "function Assert-FullmagMsiReceiptMpiInventory" in package
    assert "Assert-FullmagMsiReceiptMpiInventory -Receipt $receipt" in package


@NATIVE_WINDOWS_SKIP
@pytest.mark.parametrize(
    ("case", "expected"),
    [
        (
            "valid",
            {"run_zstd_ok": True, "run_mpi_ok": True, "package_mpi_ok": True, "bootstrap_ok": True},
        ),
        (
            "missing-host",
            {"run_zstd_ok": False, "run_mpi_ok": True, "package_mpi_ok": True, "bootstrap_ok": False},
        ),
        (
            "wrong-host",
            {"run_zstd_ok": False, "run_mpi_ok": True, "package_mpi_ok": True, "bootstrap_ok": False},
        ),
        (
            "mutated-archive",
            {"run_zstd_ok": False, "run_mpi_ok": True, "package_mpi_ok": True, "bootstrap_ok": True},
        ),
        (
            "unbound-mpi",
            {"run_zstd_ok": True, "run_mpi_ok": False, "package_mpi_ok": False, "bootstrap_ok": True},
        ),
    ],
)
def test_native_receipt_contract_rejects_fail_open_mutations(
    tmp_path: Path, case: str, expected: dict[str, bool]
) -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8-sig")
    mpi = extract_function(launcher, "Assert-NativeFemProviderMpiReceipt", "Assert-NativeFemProviderZstd")
    zstd = extract_function(launcher, "Assert-NativeFemProviderZstd", "Assert-NativeFemProviderReceipt")
    fixture = tmp_path / "native FEM receipt fixture with spaces"
    fixture.mkdir()
    run_mpi = fixture / "run-mpi.ps1"
    run_zstd = fixture / "run-zstd.ps1"
    run_mpi.write_text(mpi, encoding="utf-8")
    run_zstd.write_text(zstd, encoding="utf-8")
    driver = fixture / "receipt-contract.ps1"
    driver.write_text(textwrap.dedent(DRIVER), encoding="utf-8")
    provider_root = fixture / "provider root"
    source_root = fixture / "frozen source root"
    environment = os.environ.copy()
    environment["PATHEXT"] = ".COM;.EXE;.BAT;.CMD"
    result = subprocess.run(
        [
            PS,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            native_path(driver),
            native_path(run_mpi),
            native_path(run_zstd),
            native_path(PACKAGE),
            native_path(DEPENDENCIES),
            native_path(REQUIREMENTS),
            native_path(provider_root),
            native_path(source_root),
            case,
        ],
        capture_output=True,
        text=False,
        timeout=45,
        env=environment,
    )
    stdout = result.stdout.decode("utf-8", errors="replace")
    stderr = result.stderr.decode("utf-8", errors="replace")
    if result.returncode == 77 and "PS5_REQUIRED" in stderr:
        pytest.skip("Windows PowerShell 5.1 required")
    assert result.returncode == 0, f"stdout={stdout!r}\nstderr={stderr!r}"
    payload = json.loads(stdout.strip())
    for field, value in expected.items():
        assert payload[field] is value, payload
