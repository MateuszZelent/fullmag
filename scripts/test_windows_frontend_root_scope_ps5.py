"""Check that staged frontend cache paths do not leak into native FEM builds."""

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
param($FunctionFile, $FixtureRoot)
$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSEdition -ne "Desktop" -or $PSVersionTable.PSVersion.Major -ne 5) {
  [Console]::Error.WriteLine("PS5_REQUIRED")
  exit 77
}

$fixtureRoot = [IO.Path]::GetFullPath($FixtureRoot)
$script:BuildRoot = Join-Path $fixtureRoot "build"
$script:RepoRoot = Join-Path $fixtureRoot "repo"
$script:BuildSourceRoot = Join-Path $script:BuildRoot "compiler-inputs\source"
$script:FrontendWorkspaceRoot = $null
$script:FrontendCacheRoot = $null
$script:FrontendSourceManifestPath = $null
$script:FrontendSourceManifestSha256 = $null
$script:StaticControlRoom = $null
$RunMode = "workspace"
$Frontend = "dev"
$WebPort = 0
$BuildSnapshot = $null
$StorageLayout = [pscustomobject]@{ build_root = $script:BuildRoot }
$script:ObservedFrontendRoot = $null
$script:ObservedCi = $null
$script:ObservedFailure = $false
$script:ErrorMessage = $null
$script:ShouldFailFrontend = $false
$canonicalFrontendRoot = Join-Path $script:BuildRoot "frontend"
$script:StagedFrontendRoot = Join-Path $script:BuildRoot "frontend\workspace\stage"
$script:StagedWorkspaceRoot = Join-Path $script:BuildRoot "frontend-sources\stage\workspace"
New-Item -ItemType Directory -Force -Path $script:RepoRoot, $script:BuildSourceRoot, $canonicalFrontendRoot, $script:StagedFrontendRoot, $script:StagedWorkspaceRoot | Out-Null

function Ensure-PinnedPnpm { }
function Get-WindowsBuildToolsRoot { return $fixtureRoot }
function Assert-FullmagStoragePath {
  param([object]$Layout, [string]$Path, [string]$Label, [string]$Parent)
  try { return [IO.Path]::GetFullPath($Path) }
  catch { throw "mock storage path label=$Label path=<$Path> parent=<$Parent>: $($_.Exception.Message)" }
}
function python {
  param([Parameter(ValueFromRemainingArguments = $true)][object[]]$Arguments)
  $global:LASTEXITCODE = 0
  [pscustomobject]@{
    schema = "fullmag.dev-source-mirror.v1"
    workspace_root = $script:StagedWorkspaceRoot
    frontend_root = $script:StagedFrontendRoot
    manifest_path = Join-Path $script:StagedWorkspaceRoot "frontend-manifest.json"
    manifest_sha256 = ("a" * 64)
  } | ConvertTo-Json -Compress
}
function Invoke-External {
  param([string]$Command, [object[]]$Arguments)
  $script:ObservedFrontendRoot = [Environment]::GetEnvironmentVariable("FULLMAG_FRONTEND_ROOT", "Process")
  $script:ObservedCi = [Environment]::GetEnvironmentVariable("CI", "Process")
  if ($script:ShouldFailFrontend) {
    throw "mock frontend command failure"
  }
}

. $FunctionFile

function Invoke-Case {
  param([bool]$ShouldFail)
  $script:ShouldFailFrontend = $ShouldFail
  $script:ObservedFrontendRoot = $null
  $script:ObservedCi = $null
  $script:ObservedFailure = $false
  $script:ErrorMessage = $null
  $env:FULLMAG_FRONTEND_ROOT = $canonicalFrontendRoot
  $env:CI = "caller-ci"
  $beforeLocation = (Get-Location).Path
  try {
    Ensure-ControlRoomDependencies
  }
  catch {
    $script:ErrorMessage = ($_ | Out-String).Trim()
    $script:ObservedFailure = $true
  }
  $afterRoot = [Environment]::GetEnvironmentVariable("FULLMAG_FRONTEND_ROOT", "Process")
  $afterCi = [Environment]::GetEnvironmentVariable("CI", "Process")
  [pscustomobject]@{
    requested_failure = $ShouldFail
    observed_failure = $script:ObservedFailure
    error_message = [string]$script:ErrorMessage
    observed_frontend_root = [string]$script:ObservedFrontendRoot
    restored_frontend_root = [string]$afterRoot
    restored_ci = [string]$afterCi
    restored_location = ((Get-Location).Path -eq $beforeLocation)
    staged_frontend_root = $script:StagedFrontendRoot
  }
}

@(
  (Invoke-Case -ShouldFail:$false)
  (Invoke-Case -ShouldFail:$true)
) | ConvertTo-Json -Compress
'''


def test_frontend_dependency_function_scopes_staged_root() -> None:
    source = LAUNCHER.read_text(encoding="utf-8-sig")
    start = source.index("function Ensure-ControlRoomDependencies {")
    end = source.index("function Ensure-PinnedPnpm {", start)
    function_source = source[start:end]
    assert "$stagedFrontendRoot = $null" in function_source
    assert "$previousFrontendRootWasSet = Test-Path Env:FULLMAG_FRONTEND_ROOT" in function_source
    assert "$env:FULLMAG_FRONTEND_ROOT = $previousFrontendRoot" in function_source
    assert "Remove-Item Env:FULLMAG_FRONTEND_ROOT" in function_source
    assert "$env:FULLMAG_FRONTEND_ROOT = $FrontendCacheRoot" not in function_source
    assert "if ($locationPushed) { Pop-Location }" in function_source


@NATIVE_WINDOWS_SKIP
def test_native_frontend_root_is_restored_on_success_and_failure(tmp_path: Path) -> None:
    source = LAUNCHER.read_text(encoding="utf-8-sig")
    start = source.index("function Ensure-ControlRoomDependencies {")
    end = source.index("function Ensure-PinnedPnpm {", start)
    function_file = tmp_path / "Ensure-ControlRoomDependencies.ps1"
    function_file.write_text(source[start:end], encoding="utf-8")
    driver = tmp_path / "frontend-root-scope.ps1"
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
            native_path(tmp_path),
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
    assert len(payload) == 2
    success, failure = payload
    assert success["requested_failure"] is False
    assert success["observed_failure"] is False, success["error_message"]
    assert success["observed_frontend_root"].lower() == success["staged_frontend_root"].lower()
    assert success["restored_frontend_root"].lower() != success["staged_frontend_root"].lower()
    assert success["restored_ci"] == "caller-ci"
    assert success["restored_location"] is True
    assert failure["requested_failure"] is True
    assert failure["observed_failure"] is True
    assert failure["observed_frontend_root"].lower() == failure["staged_frontend_root"].lower()
    assert failure["restored_frontend_root"].lower() != failure["staged_frontend_root"].lower()
    assert failure["restored_ci"] == "caller-ci"
    assert failure["restored_location"] is True
