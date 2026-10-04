"""Node package inventory and isolated native startup; no solver or compilation."""

import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "windows"))
import stage_node_runtime as node_package


def runtime_fixture(tmp_path):
    root = tmp_path / "runtime with spaces"
    root.mkdir()
    image = bytearray(128)
    image[:2] = b"MZ"
    struct.pack_into("<I", image, 60, 64)
    image[64:68] = b"PE\0\0"
    struct.pack_into("<H", image, 68, 0x8664)
    struct.pack_into("<H", image, 88, 0x20b)
    (root / "node.exe").write_bytes(image)
    (root / "LICENSE").write_text("license fixture, not a distribution", encoding="utf-8")
    return root


@pytest.mark.parametrize("case", ["missing_license", "empty_license", "missing_node", "wrong_architecture", "relative_root", "unsupported_version"])
def test_invalid_runtime_is_not_admitted(tmp_path, monkeypatch, case):
    root = runtime_fixture(tmp_path)
    version = "v24.19.0"
    if case == "missing_license":
        (root / "LICENSE").unlink()
    elif case == "empty_license":
        (root / "LICENSE").write_bytes(b"")
    elif case == "missing_node":
        (root / "node.exe").unlink()
    elif case == "wrong_architecture":
        image = bytearray((root / "node.exe").read_bytes())
        struct.pack_into("<H", image, 68, 0x14c)
        (root / "node.exe").write_bytes(image)
    elif case == "relative_root":
        root = Path("relative")
    else:
        version = "v22.1.0"
    calls = []
    def run(*args, **kwargs):
        calls.append(args)
        return subprocess.CompletedProcess(args, 0, version + "\n", "")
    monkeypatch.setattr(node_package.subprocess, "run", run)
    with pytest.raises((ValueError, FileNotFoundError)):
        node_package.inspect_runtime(root)
    assert len(calls) == (1 if case == "unsupported_version" else 0)


@pytest.mark.parametrize("case", ["node_changed", "license_changed", "inventory_escape", "incomplete", "conflict", "overlap"])
def test_staging_rejects_changed_or_invalid_inputs_before_copy(tmp_path, monkeypatch, case):
    root = runtime_fixture(tmp_path)
    monkeypatch.setattr(node_package.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 0, "v24.19.0\n", ""))
    inventory = node_package.inspect_runtime(root)
    stage = tmp_path / "stage"
    stage.mkdir()
    if case == "node_changed":
        (root / "node.exe").write_bytes(b"changed")
    elif case == "license_changed":
        (root / "LICENSE").write_text("changed", encoding="utf-8")
    elif case == "inventory_escape":
        inventory["files"][1]["path"] = "../outside"
    elif case == "incomplete":
        inventory["files"].pop()
    elif case == "conflict":
        (stage / "share/licenses").mkdir(parents=True)
        (stage / "share/licenses/node-LICENSE.txt").write_text("preserve", encoding="utf-8")
    else:
        stage = root
    with pytest.raises(ValueError):
        node_package.stage_runtime(inventory, stage)
    assert not (stage / "bin/node.exe").exists()
    assert not (tmp_path / "outside").exists()


@pytest.mark.skipif(os.name != "nt", reason="Native Windows Node required")
def test_actual_copied_node_starts_without_node_on_path(tmp_path):
    executable = shutil.which("node")
    if not executable:
        pytest.skip("Native Node input required")
    root = runtime_fixture(tmp_path)
    shutil.copyfile(executable, root / "node.exe")
    # The fixture license proves copying/inventory, not release license provenance.
    inventory_path = tmp_path / "inputs.json"
    result = subprocess.run([sys.executable, node_package.__file__, "inspect", "--root", str(root),
                             "--output", str(inventory_path)], capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    stage = tmp_path / "staged package"
    stage.mkdir()
    result = subprocess.run([sys.executable, node_package.__file__, "stage", "--inventory", str(inventory_path),
                             "--destination", str(stage)], capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    node_package.stage_runtime(inventory, stage)
    env = dict(os.environ, PATH="")
    result = subprocess.run([str(stage / "bin/node.exe"), "--version"],
                            env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == inventory["version"]
    assert (stage / "share/licenses/node-LICENSE.txt").read_bytes() == (root / "LICENSE").read_bytes()
    assert json.loads(json.dumps(inventory))["kind"] == "bundled-windows-x64-node"
