from __future__ import annotations

import os
import json
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "scripts" / "windows" / "run_fullmag.ps1"


def _powershell() -> str | None:
    return shutil.which("powershell.exe") or shutil.which("pwsh")


def _native_path(path: Path) -> str:
    """Pass a WSL path to native PowerShell when this test runs through WSL."""
    if os.name == "nt":
        return str(path)
    wslpath = shutil.which("wslpath")
    if not wslpath:
        return str(path)
    converted = subprocess.run(
        [wslpath, "-w", str(path)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    return converted or str(path)


def test_script_and_workspace_ui_requirements_matrix(tmp_path: Path) -> None:
    powershell = _powershell()
    if powershell is None:
        pytest.skip("PowerShell is required for the native launcher requirements matrix")

    probe = tmp_path / "ui-requirements.ps1"
    probe.write_text(
        r'''
param([Parameter(Mandatory = $true)][string]$Launcher)
$ErrorActionPreference = "Stop"
$source = Get-Content -LiteralPath $Launcher -Raw -Encoding UTF8
$start = $source.IndexOf('$needsDesktopRuntime =', [System.StringComparison]::Ordinal)
$end = $source.IndexOf('$nextDistDir =', $start, [System.StringComparison]::Ordinal)
if ($start -lt 0 -or $end -le $start) {
  throw "Launcher does not expose the desktop/browser requirements boundary"
}
$requirements = $source.Substring($start, $end - $start)
$cases = @(
  [ordered]@{ run_mode = "interactive"; frontend = "dev"; build_only = $true },
  [ordered]@{ run_mode = "interactive"; frontend = "dev"; build_only = $false },
  [ordered]@{ run_mode = "interactive"; frontend = "static"; build_only = $true },
  [ordered]@{ run_mode = "headless"; frontend = "dev"; build_only = $true },
  [ordered]@{ run_mode = "workspace"; frontend = "dev"; build_only = $true }
)
$result = foreach ($case in $cases) {
  $RunMode = [string]$case.run_mode
  $Frontend = [string]$case.frontend
  $BuildOnly = [bool]$case.build_only
  . ([scriptblock]::Create($requirements))
  [ordered]@{
    run_mode = $RunMode
    frontend = $Frontend
    build_only = $BuildOnly
    control_room_toolchain = [bool]$needsControlRoomToolchain
    desktop_runtime = [bool]$needsDesktopRuntime
  }
}
$result | ConvertTo-Json -Depth 5 -Compress
''',
        encoding="utf-8",
    )

    completed = subprocess.run(
        [
            powershell,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            _native_path(probe),
            _native_path(LAUNCHER),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout) == [
        {
            "run_mode": "interactive",
            "frontend": "dev",
            "build_only": True,
            "control_room_toolchain": True,
            "desktop_runtime": False,
        },
        {
            "run_mode": "interactive",
            "frontend": "dev",
            "build_only": False,
            "control_room_toolchain": True,
            "desktop_runtime": False,
        },
        {
            "run_mode": "interactive",
            "frontend": "static",
            "build_only": True,
            "control_room_toolchain": True,
            "desktop_runtime": False,
        },
        {
            "run_mode": "headless",
            "frontend": "dev",
            "build_only": True,
            "control_room_toolchain": False,
            "desktop_runtime": False,
        },
        {
            "run_mode": "workspace",
            "frontend": "dev",
            "build_only": True,
            "control_room_toolchain": True,
            "desktop_runtime": True,
        },
    ]
