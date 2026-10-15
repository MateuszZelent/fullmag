"""Verify the native PowerShell 5 argument boundary used by PE planning.

This is an interpreted process-boundary regression.  It does not compile or
invoke the PE planner: a real Windows Python process records argv so the
launcher quoting helper is exercised with the CUDA path shape that previously
broke argparse.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "scripts" / "windows" / "run_fullmag.ps1"


def _powershell() -> str | None:
    # This regression targets the Windows PowerShell 5 native argv boundary.
    candidates = [
        "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
        shutil.which("powershell.exe"),
    ]
    if os.name == "nt":
        candidates.insert(0, r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
    return next((item for item in candidates if item and Path(item).exists()), None)


def _native_path(path: Path) -> str:
    if os.name == "nt":
        return str(path)
    wslpath = shutil.which("wslpath")
    if not wslpath:
        return str(path)
    result = subprocess.run(
        [wslpath, "-w", str(path)], capture_output=True, text=True, check=True
    )
    return result.stdout.strip() or str(path)


def _native_python(powershell: str) -> str | None:
    result = subprocess.run(
        [
            powershell,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "(Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)",
        ],
        capture_output=True,
        text=True,
        timeout=20,
    )
    if result.returncode != 0:
        return None
    return next((line.strip() for line in result.stdout.splitlines() if line.strip()), None)


def test_native_powershell5_preserves_cuda_dependency_root_and_following_switches(tmp_path: Path) -> None:
    powershell = _powershell()
    if powershell is None:
        pytest.skip("Windows PowerShell is required for the native argv probe")
    python = _native_python(powershell)
    if python is None:
        pytest.skip("A native python.exe is required for the native argv probe")

    probe = tmp_path / "argv_probe.py"
    result_path = tmp_path / "argv.json"
    probe.write_text(
        "from pathlib import Path\n"
        "import json\n"
        "import sys\n"
        "Path(sys.argv[1]).write_text(json.dumps(sys.argv[2:]), encoding='utf-8')\n",
        encoding="utf-8",
    )
    driver = tmp_path / "invoke_native_helper.ps1"
    driver.write_text(
        r'''param(
  [Parameter(Mandatory = $true)][string]$Launcher,
  [Parameter(Mandatory = $true)][string]$Python,
  [Parameter(Mandatory = $true)][string]$Probe,
  [Parameter(Mandatory = $true)][string]$Result
)
$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath $Launcher -Raw
$start = $source.IndexOf('function ConvertTo-NativeProcessArgument {')
$end = $source.IndexOf('function Stage-NativeFemRuntime {')
if ($start -lt 0 -or $end -le $start) { throw 'launcher helper boundaries are missing' }
. ([scriptblock]::Create($source.Substring($start, $end - $start)))
$arguments = @(
  $Probe,
  $Result,
  '--dependency-root', 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.3\bin\',
  '--dependency-root', 'C:\Windows\system32',
  '--allow-cuda-driver'
)
$exitCode = Invoke-NativePythonWithArguments -PythonPath $Python -Arguments $arguments
if ($exitCode -ne 0) { throw "argv probe exited with code $exitCode" }
if (-not (Test-Path -LiteralPath $Result -PathType Leaf)) { throw 'argv probe did not write its result' }
''',
        encoding="utf-8",
        newline="\r\n",
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
            _native_path(driver),
            _native_path(LAUNCHER),
            python,
            _native_path(probe),
            _native_path(result_path),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert completed.returncode == 0, completed.stderr or completed.stdout
    assert result_path.exists(), completed.stderr or completed.stdout
    assert json.loads(result_path.read_text(encoding="utf-8")) == [
        "--dependency-root",
        "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.3\\bin\\",
        "--dependency-root",
        r"C:\Windows\system32",
        "--allow-cuda-driver",
    ]


def test_pe_planner_and_audit_use_the_quoted_native_python_path() -> None:
    source = LAUNCHER.read_text(encoding="utf-8-sig")
    assert "$planExitCode = Invoke-NativePythonWithArguments" in source
    assert "$auditExitCode = Invoke-NativePythonWithArguments" in source
    assert "& python @planArguments" not in source
    assert "& python @auditArguments" not in source
