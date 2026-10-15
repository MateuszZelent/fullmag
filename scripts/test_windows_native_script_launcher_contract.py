"""Focused native PowerShell regression for script-mode Windows launcher isolation."""

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
    candidates = [shutil.which("pwsh"), shutil.which("powershell.exe")]
    if os.name != "nt":
        candidates.append("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")
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


def _script_launch_tail() -> str:
    source = LAUNCHER.read_text(encoding="utf-8-sig")
    start = source.index("$cliArguments = @()")
    tail = source[start:]
    assert "Invoke-External $FullmagExe $cliArguments" in tail
    return tail


def _run_script_probe(
    tmp_path: Path, *, run_mode: str, backend: str, web_port: int
) -> tuple[dict[str, object], dict[str, object]]:
    powershell = _powershell()
    if powershell is None:
        pytest.skip("Windows PowerShell is required for the interpreted launcher probe")

    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "fixture.py").write_text("print('fixture')\n", encoding="utf-8")
    probe = tmp_path / f"script-launch-{run_mode}-{backend}-{web_port}.ps1"
    tail = _script_launch_tail()
    probe.write_text(
        "\n".join(
            [
                'param([Parameter(Mandatory = $true)][string]$RepoRoot)',
                '$ErrorActionPreference = "Stop"',
                f'$RunMode = "{run_mode}"',
                f'$Backend = "{backend}"',
                '$Device = "gpu"',
                '$Frontend = "dev"',
                f'$WebPort = {web_port}',
                '$FullmagExe = "fixture-fullmag.exe"',
                '$TargetRoot = "fixture-target"',
                '$CacheRoot = "fixture-cache"',
                '$resolvedScript = Join-Path $RepoRoot "fixture.py"',
                '$resolvedOutputDir = $null',
                '$OutputDir = ""',
                '$InitialMagnetizationState = ""',
                '$FemInteractiveApiIsolation = $RunMode -eq "interactive" -and $Backend -eq "fem"',
                '$env:FULLMAG_API_PORT = "43123"',
                '$env:FULLMAG_REQUIRE_OWN_API = "prior-value"',
                'function Invoke-External {',
                '  param([Parameter(Mandatory = $true)][string]$Command, [string[]]$Arguments = @())',
                '  [ordered]@{ during_api_port = [string]$env:FULLMAG_API_PORT; during_require_owned = [string]$env:FULLMAG_REQUIRE_OWN_API; command = $Command; args = $Arguments } | ConvertTo-Json -Compress',
                '}',
                tail,
                '[ordered]@{ after_api_port = [string]$env:FULLMAG_API_PORT; after_require_owned = [string]$env:FULLMAG_REQUIRE_OWN_API } | ConvertTo-Json -Compress',
            ]
        )
        + "\n",
        encoding="utf-8",
        newline="\r\n",
    )
    result = subprocess.run(
        [
            powershell,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            _native_path(probe),
            _native_path(repo),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    records = [
        json.loads(line.strip())
        for line in result.stdout.splitlines()
        if line.strip().startswith("{")
    ]
    assert len(records) == 2, result.stdout
    return records[0], records[1]


def test_source_keeps_zero_web_port_out_of_script_cli_and_scopes_fem_api_ownership() -> None:
    source = LAUNCHER.read_text(encoding="utf-8-sig")
    tail = source[source.index("$previousScriptApiPortWasSet"):]
    assert '$FemInteractiveApiIsolation = $RunMode -eq "interactive" -and $Backend -eq "fem"' in source
    assert 'if ($WebPort -ne 0) {\n      $cliArguments += @("--web-port", $WebPort.ToString())\n    }' in tail
    assert '$cliArguments += @("--web-port", $WebPort.ToString())' not in tail.split(
        'if ($WebPort -ne 0)', 1
    )[0]
    assert '$env:FULLMAG_API_PORT = "0"' in tail
    assert '$env:FULLMAG_REQUIRE_OWN_API = "1"' in tail
    assert '$previousScriptApiPortWasSet = Test-Path Env:FULLMAG_API_PORT' in tail
    assert '$previousScriptRequireOwnedApiWasSet = Test-Path Env:FULLMAG_REQUIRE_OWN_API' in tail
    assert 'SetEnvironmentVariable("FULLMAG_API_PORT", $previousScriptApiPort, "Process")' in tail
    assert 'SetEnvironmentVariable("FULLMAG_REQUIRE_OWN_API", $previousScriptRequireOwnedApi, "Process")' in tail


@pytest.mark.parametrize(
    ("run_mode", "backend", "web_port"),
    [
        ("interactive", "fem", 0),
        ("interactive", "fem", 3197),
        ("interactive", "fdm", 0),
        ("headless", "fem", 0),
    ],
)
def test_script_dispatch_has_correct_port_api_scope_and_environment_restore(
    tmp_path: Path, run_mode: str, backend: str, web_port: int
) -> None:
    during, after = _run_script_probe(
        tmp_path, run_mode=run_mode, backend=backend, web_port=web_port
    )
    assert after == {"after_api_port": "43123", "after_require_owned": "prior-value"}
    args = [str(value) for value in during["args"]]
    if run_mode == "headless":
        assert args[-2:] == ["--headless", "--json"]
        assert "--web-port" not in args
        assert during["during_api_port"] == "0"
        assert during["during_require_owned"] == "prior-value"
    else:
        assert "-i" in args
        if web_port == 0:
            assert "--web-port" not in args
        else:
            index = args.index("--web-port")
            assert args[index + 1] == str(web_port)
        if backend == "fem":
            assert during["during_api_port"] == "0"
            assert during["during_require_owned"] == "1"
        else:
            assert during["during_api_port"] == "43123"
            assert during["during_require_owned"] == "prior-value"


@pytest.mark.skipif(_powershell() is None, reason="Windows PowerShell is unavailable")
def test_launcher_is_accepted_by_native_powershell_parser(tmp_path: Path) -> None:
    powershell = _powershell()
    assert powershell is not None
    probe = tmp_path / "parse.ps1"
    probe.write_text(
        """
param([string]$Path)
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count) { throw ($errors | Out-String) }
Write-Output "parsed"
""",
        encoding="utf-8",
        newline="\r\n",
    )
    result = subprocess.run(
        [powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", _native_path(probe), _native_path(LAUNCHER)],
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "parsed"
