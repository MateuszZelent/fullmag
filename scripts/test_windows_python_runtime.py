"""Interpreted CPython embed inventory/staging regressions; executable probe is a fixture."""

import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import zipfile

import pytest

sys.path.insert(0, str(Path(__file__).parent / "windows"))
import stage_python_runtime as runtime


def pe():
    content = bytearray(90)
    content[:2] = b"MZ"
    struct.pack_into("<I", content, 60, 64)
    content[64:68] = b"PE\0\0"
    struct.pack_into("<H", content, 68, 0x8664)
    struct.pack_into("<H", content, 88, 0x20b)
    return bytes(content)


@pytest.fixture
def distribution(tmp_path, monkeypatch):
    root = tmp_path / "embed source"
    root.mkdir()
    for name in ("python.exe", "python312.dll", "python3.dll", "_socket.pyd", "vcruntime140.dll"):
        (root / name).write_bytes(pe())
    (root / "LICENSE.txt").write_text("fixture license", encoding="utf-8")
    (root / "python312._pth").write_text("python312.zip\n.\n#import site\n", encoding="utf-8")
    with zipfile.ZipFile(root / "python312.zip", "w") as archive:
        archive.writestr("encodings/__init__.pyc", b"fixture bytecode")
    host = {"version": [3, 12, 10], "platform": "win32", "implementation": "cpython", "bits": 64}
    monkeypatch.setattr(runtime.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a[0], 0, json.dumps(host), ""))
    return root


@pytest.mark.parametrize("case", ["valid", "missing", "empty", "x86", "path_escape", "stdlib", "extra_directory", "source_changed", "inventory_changed", "dirty_destination", "overlap"])
def test_embed_inventory_and_staging(tmp_path, distribution, case):
    if case == "missing":
        (distribution / "python312.dll").unlink()
    elif case == "empty":
        (distribution / "LICENSE.txt").write_bytes(b"")
    elif case == "x86":
        content = bytearray(pe())
        struct.pack_into("<H", content, 68, 0x14c)
        (distribution / "_socket.pyd").write_bytes(content)
    elif case == "path_escape":
        (distribution / "python312._pth").write_text("python312.zip\n.\n../outside\n", encoding="utf-8")
    elif case == "stdlib":
        with zipfile.ZipFile(distribution / "python312.zip", "w") as archive:
            archive.writestr("missing", b"missing")
    elif case == "extra_directory":
        (distribution / "Lib").mkdir()
    if case in {"missing", "empty", "x86", "path_escape", "stdlib", "extra_directory"}:
        with pytest.raises(ValueError):
            runtime.inspect_runtime(distribution)
        return
    inventory = runtime.inspect_runtime(distribution)
    assert inventory["qualification"] == "not_verified"
    destination = tmp_path / "application"
    destination.mkdir()
    (destination / "bin").mkdir()
    if case == "source_changed":
        (distribution / "LICENSE.txt").write_text("different", encoding="utf-8")
    elif case == "inventory_changed":
        inventory["files"][0]["path"] = "../escape"
    elif case == "dirty_destination":
        (destination / "python").mkdir()
        (destination / "python/preserve").write_text("preserve", encoding="utf-8")
    elif case == "overlap":
        destination = distribution
    if case != "valid":
        with pytest.raises(ValueError):
            runtime.stage_runtime(inventory, destination)
        assert not (destination / "python/python.exe").exists()
        return
    staged = runtime.stage_runtime(inventory, destination)
    assert (destination / "python/python312._pth").read_bytes() == runtime.PTH
    assert (destination / "python/sitecustomize.py").read_bytes() == runtime.BOOTSTRAP
    assert (destination / "share/licenses/python-LICENSE.txt").read_bytes() == b"fixture license"
    assert (distribution / "python312._pth").read_text().endswith("#import site\n")
    for entry in staged["staged_files"]:
        assert hashlib.sha256((destination / entry["path"]).read_bytes()).hexdigest() == entry["sha256"]


@pytest.mark.parametrize("case", ["valid", "tampered", "external_path", "not_isolated", "wrong_version", "wrong_executable"])
def test_runtime_verification_poisoned_environment(tmp_path, distribution, monkeypatch, case):
    destination = tmp_path / "application"
    destination.mkdir()
    (destination / "bin").mkdir()
    inventory = runtime.stage_runtime(runtime.inspect_runtime(distribution), destination)
    python_dir = destination / "python"
    proof = {"version": [3, 12, 10], "isolated": 1, "no_user_site": 1,
             "paths": [str(python_dir), str(python_dir / "python312.zip"), str(python_dir / "site-packages")],
             "executable": str(python_dir / "python.exe")}
    if case == "tampered":
        (python_dir / "python312._pth").write_bytes(b"changed")
    elif case == "external_path":
        proof["paths"].append(str(tmp_path))
    elif case == "not_isolated":
        proof["isolated"] = 0
    elif case == "wrong_version":
        proof["version"] = [3, 13, 0]
    elif case == "wrong_executable":
        proof["executable"] = str(tmp_path / "python.exe")
    def probe(args, **kwargs):
        assert kwargs["env"]["PATH"] == ""
        assert kwargs["env"]["PYTHONHOME"] == "invalid-external-python"
        assert kwargs["env"]["PYTHONPATH"] == "invalid-external-modules"
        assert args[0] == str(python_dir / "python.exe")
        return subprocess.CompletedProcess(args, 0, json.dumps(proof), "")
    monkeypatch.setattr(runtime.subprocess, "run", probe)
    if case == "valid":
        assert runtime.verify_runtime(inventory, destination) == proof
    else:
        with pytest.raises(ValueError):
            runtime.verify_runtime(inventory, destination)


def test_both_license_copies_use_one_frozen_snapshot(tmp_path, distribution, monkeypatch):
    inventory = runtime.inspect_runtime(distribution)
    original_read = runtime.regular_bytes
    reads = 0
    def changing_license(path):
        nonlocal reads
        content = original_read(path)
        if path == distribution / "LICENSE.txt":
            reads += 1
            # The inspector reads twice; the copy then captures the frozen bytes.
            if reads == 3:
                path.write_bytes(b"changed after the frozen copy read")
        return content
    monkeypatch.setattr(runtime, "regular_bytes", changing_license)
    destination = tmp_path / "application"
    destination.mkdir()
    staged = runtime.stage_runtime(inventory, destination)
    assert reads == 3
    assert (destination / "python/LICENSE.txt").read_bytes() == b"fixture license"
    assert (destination / "share/licenses/python-LICENSE.txt").read_bytes() == b"fixture license"
    license_entries = [entry for entry in staged["staged_files"] if "LICENSE" in entry["path"]]
    assert len({entry["sha256"] for entry in license_entries}) == 1
