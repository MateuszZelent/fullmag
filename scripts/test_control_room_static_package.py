"""Exercise packaged Node HTTP startup without compiling or running a solver."""

import hashlib
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

import pytest

from stage_control_room_static_runtime import EXPORT_ENTRYPOINTS, RUNTIME_FILES, stage_runtime


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "apps/control-room"
NODE = shutil.which("node")


def write_export(web):
    for name in EXPORT_ENTRYPOINTS:
        target = web / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"<html>packaged UI fixture: {name}</html>", encoding="utf-8")


def test_staged_package_serves_index_and_assets_without_source_tree(tmp_path):
    if not NODE:
        pytest.skip("Node is required for packaged runtime startup")
    web = tmp_path / "package with spaces" / "web"
    web.mkdir(parents=True)
    write_export(web)
    (web / "asset.txt").write_text("packaged asset", encoding="utf-8")
    inventory = stage_runtime(SOURCE, web)
    assert inventory == [
        {"path": name, "sha256": hashlib.sha256((SOURCE / name).read_bytes()).hexdigest()}
        for name in RUNTIME_FILES
    ]
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    with (tmp_path / "node.log").open("w+", encoding="utf-8") as log:
        process = subprocess.Popen(
            [NODE, str(web / "dev-server.mjs"), "--static-root", str(web),
             "--hostname", "127.0.0.1", "--port", str(port)],
            cwd=web, stdout=log, stderr=log,
        )
        try:
            deadline = time.monotonic() + 10
            while True:
                if process.poll() is not None:
                    log.seek(0)
                    pytest.fail(f"Packaged Node exited: {log.read()}")
                try:
                    with urlopen(f"http://127.0.0.1:{port}/", timeout=1) as response:
                        assert response.status == 200
                        assert b"packaged UI fixture" in response.read()
                    break
                except URLError:
                    if time.monotonic() >= deadline:
                        pytest.fail("Packaged Node did not become ready")
                    time.sleep(0.05)
            with urlopen(f"http://127.0.0.1:{port}/asset.txt", timeout=2) as response:
                assert response.read() == b"packaged asset"
            with urlopen(f"http://127.0.0.1:{port}/workspace?fullmag_api_instance=00000000-0000-4000-8000-000000000001", timeout=2) as response:
                assert response.status == 200
                assert "fullmag_api_instance=00000000-0000-4000-8000-000000000001" in response.geturl()
                assert b"workspace/index.html" in response.read()
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


@pytest.mark.parametrize("case", ["missing", "empty", "directory", "destination_directory", "destination_parent_file"])
def test_invalid_closure_is_rejected_before_any_copy(tmp_path, case):
    source = tmp_path / "source"
    web = tmp_path / "web"
    source.mkdir()
    web.mkdir()
    write_export(web)
    for name in RUNTIME_FILES:
        path = source / name
        path.parent.mkdir(exist_ok=True)
        path.write_text("fixture", encoding="utf-8")
    bad = source / RUNTIME_FILES[-1]
    if case == "missing":
        bad.unlink()
    elif case == "empty":
        bad.write_bytes(b"")
    elif case == "directory":
        bad.unlink()
        bad.mkdir()
    elif case == "destination_directory":
        target = web / RUNTIME_FILES[-1]
        target.mkdir(parents=True)
    else:
        (web / "scripts").write_text("preserve", encoding="utf-8")
    with pytest.raises((ValueError, FileNotFoundError)):
        stage_runtime(source, web)
    assert not (web / RUNTIME_FILES[0]).exists()


def test_overlapping_trees_are_rejected(tmp_path):
    with pytest.raises(ValueError, match="separate trees"):
        stage_runtime(tmp_path, tmp_path)


@pytest.mark.parametrize("case", ["missing", "empty", "directory"])
def test_incomplete_workspace_export_is_rejected_before_runtime_copy(tmp_path, case):
    web = tmp_path / "web"
    write_export(web)
    target = web / "workspace/index.html"
    if case == "missing":
        target.unlink()
    elif case == "empty":
        target.write_bytes(b"")
    else:
        target.unlink()
        target.mkdir()
    with pytest.raises((ValueError, FileNotFoundError)):
        stage_runtime(SOURCE, web)
    assert not (web / "dev-server.mjs").exists()


def test_msi_production_staging_block_copies_complete_runtime(tmp_path):
    powershell = shutil.which("pwsh") or shutil.which("powershell")
    if not powershell:
        pytest.skip("PowerShell is required for the MSI producer")
    repo = tmp_path / "source repo"
    source = repo / "apps/control-room"
    (source / "out").mkdir(parents=True)
    (source / "out/index.html").write_text("fixture", encoding="utf-8")
    (source / "out/workspace").mkdir()
    (source / "out/workspace/index.html").write_text("workspace fixture", encoding="utf-8")
    for name in RUNTIME_FILES:
        target = source / name
        target.parent.mkdir(exist_ok=True)
        shutil.copyfile(SOURCE / name, target)
    (repo / "scripts").mkdir()
    shutil.copyfile(ROOT / "scripts/stage_control_room_static_runtime.py",
                    repo / "scripts/stage_control_room_static_runtime.py")
    web = tmp_path / "staged web"
    driver = tmp_path / "producer.ps1"
    driver.write_text('''param($Installer, $RepoRoot, $webDir, $PythonExecutable)
$ErrorActionPreference = 'Stop'
function Require-File($Path) { if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Missing file' } }
function Copy-Tree($Source, $Destination) { New-Item -ItemType Directory -Path $Destination -Force | Out-Null; Copy-Item -Path (Join-Path $Source '*') -Destination $Destination -Recurse -Force }
function python { & $PythonExecutable @args }
$source = Get-Content -LiteralPath $Installer -Raw
$start = $source.IndexOf('  Require-File (Join-Path $RepoRoot "apps\\control-room\\out\\index.html")')
$end = $source.IndexOf('  Copy-Tree (Join-Path $RepoRoot "examples")', $start)
if ($start -lt 0 -or $end -le $start) { throw 'Missing production UI staging block' }
Invoke-Expression $source.Substring($start, $end - $start)
''', encoding="utf-8")
    result = subprocess.run(
        [powershell, "-NoProfile", "-File", str(driver),
         str(ROOT / "scripts/windows/build_windows_msi.ps1"), str(repo), str(web), sys.executable],
        capture_output=True, text=True, timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert (web / "index.html").read_text() == "fixture"
    assert (web / "workspace/index.html").read_text() == "workspace fixture"
    for name in RUNTIME_FILES:
        assert (web / name).read_bytes() == (SOURCE / name).read_bytes()
