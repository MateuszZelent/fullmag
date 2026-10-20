"""Exercise the managed Boost receipt and FEM CMake handoff boundaries.

The source-contract case runs on any host.  The optional receipt case runs only
under the explicit Windows PowerShell 5.1 lane; it creates tiny synthetic
provider files and never downloads, configures, or compiles a project.
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
SETUP = ROOT / "scripts/windows/setup_build_environment.ps1"
PACKAGE = ROOT / "scripts/windows/native_fem_package.ps1"


PROVIDER = ROOT / "scripts/windows/native_fem_dependencies.ps1"
REQUIREMENTS = ROOT / "windows_build_requirements.json"
FEM_CMAKE = ROOT / "backends/fem/CMakeLists.txt"


RUN_NATIVE_WINDOWS_POWERSHELL = (
    os.environ.get("FULLMAG_RUN_NATIVE_WINDOWS_POWERSHELL") == "1"
)
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


def test_boost_consumers_use_the_pinned_shared_provider_contract() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8-sig")
    setup = SETUP.read_text(encoding="utf-8-sig")
    package = PACKAGE.read_text(encoding="utf-8-sig")
    provider = PROVIDER.read_text(encoding="utf-8-sig")
    cmake = FEM_CMAKE.read_text(encoding="utf-8-sig")
    requirements = json.loads(REQUIREMENTS.read_text(encoding="utf-8"))
    boost = requirements["tools"]["boost_headers"]

    assert PROVIDER.is_file()
    assert "Get-FullmagNativeFemBoostRequirement -SourceRoot $BuildSourceRoot" in launcher
    assert "Assert-NativeFemProviderBoost -Receipt $receipt" in launcher
    assert "Assert-NativeFemProviderBoost -Receipt $receiptObject" in launcher
    assert "Assert-FullmagNativeFemBoostReceipt" in launcher
    assert "Get-FullmagNativeFemBoostRequirement -SourceRoot $script:RepoRoot" in setup
    assert "Assert-FullmagNativeFemBoostReceipt" in setup
    assert '"boost_headers"' in setup
    assert "$null = Assert-ProviderReceiptBoost -Receipt $receipt" in setup
    assert "metadata.source_root" not in launcher
    assert "metadata.source_root" not in setup
    assert "metadata.required_header" not in launcher
    assert "metadata.required_header" not in setup

    assert boost["archive_sha256"] == (
        "77bee48e32cabab96a3fd2589ec3ab9a17798d330220fdd8bde6ff5611b4ccde"
    )
    hash_prefix = boost["archive_sha256"][:12]
    provider_path = boost["provider_path"]
    provider_tail = "/".join(provider_path.replace("\\", "/").split("/")[-2:])
    assert provider_tail.endswith(hash_prefix), (
        "manifest provider_path does not use the archive hash suffix: "
        f"{provider_path!r} != *{hash_prefix!r}"
    )
    assert boost["required_headers"] == [
        "boost/multiprecision/cpp_int.hpp",
        "boost/rational.hpp",
    ]
    assert boost["max_selected_files"] == 50000
    assert boost["max_selected_file_bytes"] == 33554432
    assert boost["max_selected_uncompressed_bytes"] == 536870912
    for marker in (
        "function Assert-FullmagNativeFemBoostReceipt",
        "function Test-FullmagNativeFemBoostReceipt",
        "Get-FullmagNativeFemBoostArchiveInventory",
        "$archiveTree = @(",
        "installed_rational_header",
        "include_tree",
        '"boost/rational.hpp"',
    ):
        assert marker in provider
    assert provider_tail in cmake.replace("\\", "/")
    assert "Get-FullmagNativeFemBoostInstallRoot" in provider
    assert "Substring(0, 12)" in provider
    assert "boost/multiprecision/cpp_int.hpp" in cmake
    assert "boost/rational.hpp" in cmake
    assert "FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256" in package
    assert "-DFULLMAG_FEM_SOURCE_SNAPSHOT_SHA256=$sourceSnapshotSha256" in package
    assert "$env:FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256 = $sourceSnapshotSha256" in launcher


BOOST_DRIVER = r'''
param($FunctionFile, $HelperFile, $ProviderRoot, $Case)
$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSEdition -ne "Desktop" -or $PSVersionTable.PSVersion.Major -ne 5) {
  [Console]::Error.WriteLine("PS5_REQUIRED")
  exit 77
}
$providerRoot = [IO.Path]::GetFullPath($ProviderRoot)
$prefix = Join-Path $providerRoot "installed"
$archive = Join-Path $providerRoot "downloads\boost_1_89_0.zip"
$archiveParent = Split-Path -Parent $archive
New-Item -ItemType Directory -Force -Path $archiveParent | Out-Null
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Add-ZipText {
  param([IO.Compression.ZipArchive]$Zip, [string]$Name, [string]$Content)
  $entry = $Zip.CreateEntry($Name)
  $bytes = [Text.Encoding]::UTF8.GetBytes($Content)
  $stream = $entry.Open()
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
}
$zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Create)
try {
  Add-ZipText $zip "boost_1_89_0/boost/multiprecision/cpp_int.hpp" "synthetic boost integer header"
  Add-ZipText $zip "boost_1_89_0/boost/rational.hpp" "synthetic boost rational header"
  Add-ZipText $zip "boost_1_89_0/LICENSE_1_0.txt" "synthetic boost license"
} finally { $zip.Dispose() }
$archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
$installRoot = Join-Path $prefix ("providers\b-" + $archiveHash.Substring(0, 12))
$includeRoot = Join-Path $installRoot "include"
$header = Join-Path $includeRoot "boost\multiprecision\cpp_int.hpp"
$rational = Join-Path $includeRoot "boost\rational.hpp"
$license = Join-Path $installRoot "share\licenses\boost\LICENSE_1_0.txt"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $header),
  (Split-Path -Parent $rational), (Split-Path -Parent $license) | Out-Null
$headerBytes = [Text.Encoding]::UTF8.GetBytes("synthetic boost integer header")
$rationalBytes = [Text.Encoding]::UTF8.GetBytes("synthetic boost rational header")
$licenseBytes = [Text.Encoding]::UTF8.GetBytes("synthetic boost license")
[IO.File]::WriteAllBytes($header, $headerBytes)
[IO.File]::WriteAllBytes($rational, $rationalBytes)
[IO.File]::WriteAllBytes($license, $licenseBytes)
$headerHash = (Get-FileHash -LiteralPath $header -Algorithm SHA256).Hash.ToLowerInvariant()
$rationalHash = (Get-FileHash -LiteralPath $rational -Algorithm SHA256).Hash.ToLowerInvariant()
$licenseHash = (Get-FileHash -LiteralPath $license -Algorithm SHA256).Hash.ToLowerInvariant()
$script:Requirement = [pscustomobject]@{
  kind="project_managed_header_provider"; version="1.89.0"
  url="https://archives.boost.io/release/1.89.0/source/boost_1_89_0.zip"
  archive="boost_1_89_0.zip"; archive_sha256=$archiveHash
  root_directory="boost_1_89_0"; include_directory="boost"
  license_file="LICENSE_1_0.txt"
  required_headers=@("boost/multiprecision/cpp_int.hpp", "boost/rational.hpp")
  max_selected_files=50000; max_selected_file_bytes=33554432
  max_selected_uncompressed_bytes=536870912
}
function Get-NativeFemBoostRequirement { return $script:Requirement }
$BuildSourceRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $HelperFile))
. $FunctionFile
$tree = @(
  [pscustomobject]@{ path="include/boost/multiprecision/cpp_int.hpp"; size_bytes=(Get-Item $header).Length; sha256=$headerHash }
  [pscustomobject]@{ path="include/boost/rational.hpp"; size_bytes=(Get-Item $rational).Length; sha256=$rationalHash }
  [pscustomobject]@{ path="share/licenses/boost/LICENSE_1_0.txt"; size_bytes=(Get-Item $license).Length; sha256=$licenseHash }
)
$metadata = [pscustomobject]@{
  name="boost_headers"; kind=$script:Requirement.kind; version=$script:Requirement.version
  url=$script:Requirement.url; archive=$archive; archive_name=$script:Requirement.archive
  archive_sha256=$archiveHash; install_root=$installRoot; include_root=$includeRoot
  installed_header=$header; installed_header_sha256=$headerHash
  installed_rational_header=$rational; installed_rational_header_sha256=$rationalHash
  license=$license; license_sha256=$licenseHash; include_tree=$tree
  required_headers=$script:Requirement.required_headers
}
if ($Case -eq "mutated-header") { [IO.File]::WriteAllText($header, "changed header") }
if ($Case -eq "wrong-version") { $metadata.version = "1.88.0" }
$receipt = [pscustomobject]@{ boost = $metadata }
$failure = $null
try { Assert-NativeFemProviderBoost -Receipt $receipt -ProviderRoot $providerRoot | Out-Null }
catch { $failure = $_.Exception.Message }
[pscustomobject]@{ ok = ($null -eq $failure); error = [string]$failure } | ConvertTo-Json -Compress
'''


@NATIVE_WINDOWS_SKIP
@pytest.mark.parametrize(
    ("case", "expected_ok"),
    [("valid", True), ("mutated-header", False), ("wrong-version", False)],
)
def test_native_boost_receipt_admission_rejects_stale_metadata(
    tmp_path: Path, case: str, expected_ok: bool
) -> None:
    source = LAUNCHER.read_text(encoding="utf-8-sig")
    function_file = tmp_path / "Assert-NativeFemProviderBoost.ps1"
    function_file.write_text(
        extract_function(
            source, "Assert-NativeFemProviderBoost", "Assert-NativeFemProviderReceipt"
        ),
        encoding="utf-8",
    )
    driver = tmp_path / "boost-receipt-driver.ps1"
    driver.write_text(textwrap.dedent(BOOST_DRIVER), encoding="utf-8")
    provider_root = tmp_path / "provider root with spaces"
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
            native_path(function_file),
            native_path(PROVIDER),
            native_path(provider_root),
            case,
        ],
        capture_output=True,
        text=False,
        timeout=30,
        env={**os.environ, "PATHEXT": ".COM;.EXE;.BAT;.CMD"},
    )
    stdout = result.stdout.decode("utf-8", errors="replace")
    stderr = result.stderr.decode("utf-8", errors="replace")
    if result.returncode == 77 and "PS5_REQUIRED" in stderr:
        pytest.skip("Windows PowerShell 5.1 required")
    assert result.returncode == 0, f"stdout={stdout!r}\nstderr={stderr!r}"
    payload = json.loads(stdout.strip())
    assert payload["ok"] is expected_ok
    if not expected_ok:
        assert payload["error"]


CMARK_DRIVER = r'''
param($FunctionFile, $PackageRoot, $BuildRoot, $CapturePath, $SourceSnapshot)
$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSEdition -ne "Desktop" -or $PSVersionTable.PSVersion.Major -ne 5) {
  [Console]::Error.WriteLine("PS5_REQUIRED")
  exit 77
}
$prefix = Join-Path $PackageRoot "installed"
$config = Join-Path $prefix "lib\cmake\mfem\MFEMConfig.cmake"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $config) | Out-Null
[IO.File]::WriteAllText($config, "synthetic MFEM config")
$env:FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256 = $SourceSnapshot
$env:FULLMAG_CMAKE = Join-Path $PackageRoot "capture-cmake.cmd"
@('@echo off', '>"%FULLMAG_CAPTURE%" echo %*', 'exit /b 0') | Set-Content -LiteralPath $env:FULLMAG_CMAKE -Encoding ASCII
$env:FULLMAG_CAPTURE = $CapturePath
function Get-FullmagMsiModalProviderInventory {
  param([string]$BuildRoot, [string]$DependencyPrefix, [bool]$Enabled)
  return [pscustomobject]@{ enabled = $false }
}
function Assert-FullmagMsiModalProviderInventory { param([object]$Inventory) }
function Find-FullmagMsiFemOutput {
  param([string]$BuildRoot)
  $dll = Join-Path $BuildRoot "fullmag_fem.dll"
  $lib = Join-Path $BuildRoot "fullmag_fem.lib"
  New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
  [IO.File]::WriteAllText($dll, "synthetic dll")
  [IO.File]::WriteAllText($lib, "synthetic lib")
  return [pscustomobject]@{ directory=$BuildRoot; dll=$dll; import_library=$lib }
}
. $FunctionFile
$plan = [pscustomobject]@{ fem_enabled=$true; fem_cuda=$false; dependency_prefix=$prefix }
$result = Invoke-FullmagMsiFemBuild -Plan $plan -RepoRoot $PackageRoot -BuildRoot $BuildRoot
[pscustomobject]@{ snapshot=$result.source_snapshot_sha256; args=@($result.configure_arguments); captured=(Get-Content -LiteralPath $CapturePath -Raw) } | ConvertTo-Json -Compress
'''


@NATIVE_WINDOWS_SKIP
def test_native_fem_package_passes_source_snapshot_to_cmake(tmp_path: Path) -> None:
    source = PACKAGE.read_text(encoding="utf-8-sig")
    function_file = tmp_path / "Invoke-FullmagMsiFemBuild.ps1"
    function_file.write_text(
        extract_function(
            source,
            "Get-FullmagMsiFemSourceSnapshotSha256",
            "Invoke-FullmagMsiFemBuild",
        )
        + extract_function(
            source, "Invoke-FullmagMsiFemBuild", "Test-FullmagMsiPathWithin"
        ),
        encoding="utf-8",
    )
    driver = tmp_path / "cmake-argument-driver.ps1"
    driver.write_text(textwrap.dedent(CMARK_DRIVER), encoding="utf-8")
    package_root = tmp_path / "package root with spaces"
    build_root = tmp_path / "native build"
    capture = tmp_path / "cmake args.txt"
    digest = "a" * 64
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
            native_path(function_file),
            native_path(package_root),
            native_path(build_root),
            native_path(capture),
            digest,
        ],
        capture_output=True,
        text=False,
        timeout=30,
        env={**os.environ, "PATHEXT": ".COM;.EXE;.BAT;.CMD"},
    )
    stdout = result.stdout.decode("utf-8", errors="replace")
    stderr = result.stderr.decode("utf-8", errors="replace")
    if result.returncode == 77 and "PS5_REQUIRED" in stderr:
        pytest.skip("Windows PowerShell 5.1 required")
    assert result.returncode == 0, f"stdout={stdout!r}\nstderr={stderr!r}"
    payload = json.loads(stdout.strip().splitlines()[-1])
    assert payload["snapshot"] == digest
    assert any(
        argument == f"-DFULLMAG_FEM_SOURCE_SNAPSHOT_SHA256={digest}"
        for argument in payload["args"]
    )
