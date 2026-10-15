"""Exercise the native FEM build function through Windows PowerShell 5.1.

The fixture invokes the function extracted from the production launcher and
stubs only the provider/build helpers.  It therefore checks PowerShell's
argument grammar and the post-provider path without compiling any source.
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


DRIVER = r'''
param($FunctionFile, $HelperRoot, $BuildRoot, $SourceRoot)
$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSEdition -ne "Desktop" -or $PSVersionTable.PSVersion.Major -ne 5) {
  [Console]::Error.WriteLine("PS5_REQUIRED")
  exit 77
}

$script:HelperRoot = [IO.Path]::GetFullPath($HelperRoot)
$script:BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
$script:ObservedCuda = $false
$script:ObservedCudaArchitectures = $null
$useCuda = $true
$Device = "gpu"
$RepoRoot = [IO.Path]::GetFullPath($SourceRoot)
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot)
$BuildRoot = $script:BuildRoot
$StorageLayout = [pscustomobject]@{ build_root = $BuildRoot; profile = "windows-native-fem-gpu" }
$nativeFemBuildRoot = Join-Path $BuildRoot "native-fem"

New-Item -ItemType Directory -Force -Path $script:HelperRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $BuildRoot "fem-dependencies") | Out-Null
$providerReceiptPath = Join-Path (Join-Path $BuildRoot "fem-dependencies") "provider-receipt.json"
[IO.File]::WriteAllText($providerReceiptPath, "{}")
$env:FULLMAG_CUDA_ARCHITECTURES = "89"
$env:FULLMAG_FEM_DEPENDENCY_PREFIX = Join-Path $BuildRoot "provider"
New-Item -ItemType Directory -Force -Path $env:FULLMAG_FEM_DEPENDENCY_PREFIX | Out-Null

function Get-WindowsBuildToolsRoot {
  return $script:HelperRoot
}

function Assert-NativeFemProviderReceipt {
  param([switch]$Cuda, [string]$CudaArchitectures)
  $script:ObservedCuda = [bool]$Cuda
  $script:ObservedCudaArchitectures = $CudaArchitectures
  return [pscustomobject]@{ marker = "mock-provider-receipt" }
}

function Assert-NativeFemPathChain {
  param([string]$Path, [string]$Base, [string]$Label, [switch]$Leaf)
  return $Path
}

function Get-Sha256File {
  param([string]$Path)
  return ("0" * 64)
}

. $FunctionFile
$result = Invoke-NativeFemBuild -SourceRoot $SourceRoot
[pscustomobject]@{
  observed_cuda = $script:ObservedCuda
  observed_cuda_architectures = [string]$script:ObservedCudaArchitectures
  result_directory = [string]$result.directory
  provider_receipt_sha256 = [string]$result.provider_receipt_sha256
  mfem_stack_restored = -not (Test-Path Env:FULLMAG_USE_MFEM_STACK)
  cuda_flag_restored = -not (Test-Path Env:FULLMAG_FEM_ENABLE_CUDA)
  gpu_requirement_restored = -not (Test-Path Env:FULLMAG_FEM_REQUIRE_GPU)
} | ConvertTo-Json -Compress
'''


HELPER = r'''
function Get-FullmagMsiBuildPlan {
  param([string]$FemMode, [switch]$Cuda, [string]$DependencyPrefix)
  return [pscustomobject]@{
    fem_mode = $FemMode
    cuda = [bool]$Cuda
    dependency_prefix = $DependencyPrefix
  }
}

function Invoke-FullmagMsiFemBuild {
  param([object]$Plan, [string]$RepoRoot, [string]$BuildRoot)
  $directory = Join-Path $BuildRoot "native-output"
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  return [pscustomobject]@{ directory = $directory }
}
'''


@NATIVE_WINDOWS_SKIP
def test_native_fem_build_executes_real_ps5_function_after_provider(tmp_path: Path) -> None:
    source = LAUNCHER.read_text(encoding="utf-8-sig")
    start = source.index("function Invoke-NativeFemBuild {")
    end = source.index("function Stage-NativeFemRuntime {", start)

    fixture_root = tmp_path / "native FEM fixture with spaces"
    fixture_root.mkdir()
    function_file = fixture_root / "Invoke-NativeFemBuild.ps1"
    function_file.write_text(source[start:end], encoding="utf-8")
    helper_root = fixture_root / "tools"
    helper_root.mkdir()
    (helper_root / "native_fem_package.ps1").write_text(HELPER, encoding="utf-8")
    build_root = fixture_root / "build"
    source_root = fixture_root / "source"
    source_root.mkdir()

    driver = fixture_root / "invoke-native-fem-build.ps1"
    driver.write_text(textwrap.dedent(DRIVER), encoding="utf-8")
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
            native_path(function_file),
            native_path(helper_root),
            native_path(build_root),
            native_path(source_root),
        ],
        capture_output=True,
        text=False,
        timeout=30,
        env=environment,
    )
    stdout = result.stdout.decode("utf-8", errors="replace")
    stderr = result.stderr.decode("utf-8", errors="replace")
    if result.returncode == 77 and "PS5_REQUIRED" in stderr:
        pytest.skip("Windows PowerShell 5.1 required")
    assert result.returncode == 0, f"stdout={stdout!r}\nstderr={stderr!r}"
    payload = json.loads(stdout.strip())
    assert payload["observed_cuda"] is True
    assert payload["observed_cuda_architectures"] == "89"
    assert payload["result_directory"].lower().endswith("native-output")
    assert payload["provider_receipt_sha256"] == "0" * 64
    assert payload["mfem_stack_restored"] is True
    assert payload["cuda_flag_restored"] is True
    assert payload["gpu_requirement_restored"] is True


def test_native_fem_provider_architecture_argument_is_ps5_safe() -> None:
    source = LAUNCHER.read_text(encoding="utf-8-sig")
    start = source.index("function Invoke-NativeFemBuild {")
    end = source.index("function Stage-NativeFemRuntime {", start)
    function_source = source[start:end]
    assert "-CudaArchitectures (if " not in function_source
    assert "$providerCudaArchitectures = if ($useCuda)" in function_source
    assert "-CudaArchitectures $providerCudaArchitectures" in function_source
