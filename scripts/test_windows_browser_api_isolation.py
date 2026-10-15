"""Focused interpreted regression for owned browser workspace API startup."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "scripts" / "windows" / "run_fullmag.ps1"
CONTROL_ROOM = ROOT / "crates" / "fullmag-cli" / "src" / "control_room.rs"


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


def _workspace_launch_block() -> str:
    source = LAUNCHER.read_text(encoding="utf-8-sig")
    start_marker = 'if ($RunMode -eq "workspace") {\n  if (-not $FrontendWorkspaceRoot'
    start = source.index(start_marker)
    end = source.index('\nif (-not $ScriptPath)', start)
    block = source[start:end]
    assert block.count("exit 0") == 1
    return block.replace("\n  exit 0\n", "\n")


def _run_workspace_probe(
    tmp_path: Path, *, browser_workspace: bool, all_backends: bool, backend: str
) -> list[dict[str, object]]:
    powershell = _powershell()
    if powershell is None:
        pytest.skip("Windows PowerShell is required for the interpreted launcher probe")
    repo = tmp_path / "repo"
    repo.mkdir()
    block = _workspace_launch_block()
    probe = tmp_path / "browser-api-isolation.ps1"
    probe.write_text(
        "\n".join(
            [
                'param([Parameter(Mandatory = $true)][string]$RepoRoot)',
                '$ErrorActionPreference = "Stop"',
                '$RunMode = "workspace"',
                '$Frontend = "dev"',
                f'$BrowserWorkspace = ${str(browser_workspace).lower()}',
                f'$AllBackendsRequested = ${str(all_backends).lower()}',
                f'$Backend = "{backend}"',
                '$BrowserApiIsolation = $BrowserWorkspace -and ($AllBackendsRequested -or $Backend -eq "fem")',
                '$WebPort = 0',
                '$FullmagExe = "fixture-fullmag.exe"',
                '$FrontendWorkspaceRoot = Join-Path $RepoRoot "frontend"',
                '$FrontendCacheRoot = Join-Path $RepoRoot "cache"',
                '$StorageLayout = [pscustomobject]@{ runtime_root = $RepoRoot }',
                '$manifest = [pscustomobject]@{ python_sync_required = $false }',
                '$env:FULLMAG_API_PORT = "43123"',
                '$env:FULLMAG_REQUIRE_OWN_API = "prior-value"',
                'function Publish-NativeWorkspaceRuntime { return "fixture-desktop.exe" }',
                'function Invoke-External {',
                '  param([Parameter(Mandatory = $true)][string]$Command, [string[]]$Arguments = @())',
                '  [ordered]@{ during_api_port = [string]$env:FULLMAG_API_PORT; during_require_owned = [string]$env:FULLMAG_REQUIRE_OWN_API; command = $Command; args = $Arguments } | ConvertTo-Json -Compress',
                '}',
                block,
                '[ordered]@{ after_api_port = [string]$env:FULLMAG_API_PORT; after_require_owned = [string]$env:FULLMAG_REQUIRE_OWN_API } | ConvertTo-Json -Compress',
            ]
        )
        + "\n",
        encoding="utf-8",
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
    records = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            records.append(json.loads(line))
    assert len(records) == 2, result.stdout
    return records


def test_source_binds_browser_workspace_to_owned_nonzero_api_contract() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8-sig")
    control_room = CONTROL_ROOM.read_text(encoding="utf-8-sig")
    assert '$BrowserApiIsolation = $BrowserWorkspace -and ($AllBackendsRequested -or $Backend -eq "fem")' in launcher
    assert '$env:FULLMAG_API_PORT = "0"' in launcher
    assert '$env:FULLMAG_REQUIRE_OWN_API = "1"' in launcher
    assert '"FULLMAG_REQUIRE_OWN_API"' in control_room
    assert "return allocate_ephemeral_api_port()" in control_room
    assert 'owned_api_required && std::env::var_os("FULLMAG_API_PORT").is_none()' in control_room
    assert "FULLMAG_REQUIRE_OWN_API selected an occupied compatible API port" in control_room
    assert "!owned_api_required && api_port() != 0 && api_bridge_is_ready(api_port())" in control_room


@pytest.mark.parametrize(
    ("browser_workspace", "all_backends", "backend", "should_force"),
    [
        (True, True, "fem", True),
        (True, False, "fem", True),
        (False, False, "auto", False),
    ],
)
def test_workspace_child_gets_owned_api_only_for_browser_fem_routes(
    tmp_path: Path,
    browser_workspace: bool,
    all_backends: bool,
    backend: str,
    should_force: bool,
) -> None:
    records = _run_workspace_probe(
        tmp_path,
        browser_workspace=browser_workspace,
        all_backends=all_backends,
        backend=backend,
    )
    during, after = records
    if should_force:
        assert during["during_api_port"] == "0"
        assert during["during_require_owned"] == "1"
    else:
        assert during["during_api_port"] == "43123"
        assert during["during_require_owned"] == "prior-value"
    assert after == {"after_api_port": "43123", "after_require_owned": "prior-value"}
    if should_force:
        assert "--browser" in during["args"]
    else:
        assert "--browser" not in during["args"]
