"""Lightweight guards for the cold archive driver; no solver/test compilation."""
import importlib.util
from pathlib import Path
import sys
import subprocess
import json
import os
import shutil

import pytest

SCRIPT = Path(__file__).with_name("verify_saved_fem_archive_roundtrip.py")
SPEC = importlib.util.spec_from_file_location("saved_fem_archive_driver", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

COMMIT = "a" * 40
SNAPSHOT = "b" * 64
STAMP = f"[fullmag] build: 2026-10-01T12:00:00Z | commit: {COMMIT} | clean | source snapshot: {SNAPSHOT}"


@pytest.mark.parametrize("stderr", [STAMP.replace(COMMIT, "c" * 40), STAMP + "x", STAMP + "\n" + STAMP,
                                    STAMP.replace("clean", "dirty"), ""])
def test_rejects_mismatched_or_ambiguous_binary_identity(stderr):
    with pytest.raises(ValueError, match="startup identity"):
        MODULE.check_stamp(stderr, COMMIT, SNAPSHOT)


def test_accepts_exact_binary_identity():
    MODULE.check_stamp(STAMP + "\n", COMMIT, SNAPSHOT)


def payload():
    return {"schema": "fullmag.saved_native_fem_snapshot_integrity.v1", "status": "pass",
            "source": {"run_id": "run-1"}, "source_artifact_id": "artifact-1",
            "scientific_qualification": "not_verified", "archive_roundtrip": "not_verified",
            "native_snapshot_receipt": {key: "sha256:" + "a" * 64 for key in (
                "values_sha256", "native_node_map_sha256", "native_indexed_geometry_sha256")}}


@pytest.mark.parametrize("key,value", [("source", {"run_id": "another-run"}), ("status", "queued"),
                                       ("source_artifact_id", "other-artifact"),
                                       ("scientific_qualification", "pass"), ("archive_roundtrip", "pass")])
def test_result_requires_exact_source_and_honest_scope(key, value):
    result = payload()
    result[key] = value
    with pytest.raises(ValueError, match="requested source"):
        MODULE.check_integrity_result(result, payload()["source"], "artifact-1")


def test_result_requires_indexed_geometry_receipt():
    result = payload()
    del result["native_snapshot_receipt"]["native_indexed_geometry_sha256"]
    with pytest.raises(ValueError, match="incomplete"):
        MODULE.check_integrity_result(result, result["source"], "artifact-1")


def test_clone_preserves_durable_bytes_and_omits_process_ownership(tmp_path):
    original = tmp_path / "original"
    original.mkdir()
    (original / "state.json").write_bytes(b'{"state":"immutable"}')
    (original / "WRITER.lock").write_bytes(b"operational-lock")
    (original / "WRITER.owner.json").write_bytes(b"operational-owner")
    before = MODULE.inventory(original)
    cloned = tmp_path / "cloned"
    MODULE.copy_store(original, cloned, before)
    assert MODULE.inventory(original) == before
    assert (cloned / "state.json").read_bytes() == (original / "state.json").read_bytes()
    assert set(MODULE.inventory(cloned)) == {"state.json"}


def test_changed_source_cannot_pass_clone_barrier(tmp_path):
    original = tmp_path / "original"
    original.mkdir()
    (original / "state.json").write_bytes(b"before")
    before = MODULE.inventory(original)
    (original / "state.json").write_bytes(b"after")
    with pytest.raises(ValueError, match="changed"):
        MODULE.copy_store(original, tmp_path / "cloned", before)


def test_artifact_hash_works_without_python_311_file_digest(tmp_path, monkeypatch):
    from local_runner.build_executor import artifact_sha256
    sample = tmp_path / "artifact"
    sample.write_bytes(b"abc")
    monkeypatch.delattr(MODULE.hashlib, "file_digest", raising=False)
    expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    assert artifact_sha256(sample) == expected
    assert MODULE.digest(sample) == expected


def test_non_regular_store_member_rejected_before_copy(tmp_path):
    original = tmp_path / "original"
    original.mkdir()
    try:
        (original / "escape").symlink_to(tmp_path)
    except OSError:
        pytest.skip("host does not allow creating an isolated symlink fixture")
    with pytest.raises((ValueError, MODULE.storage.StorageError)):
        MODULE.inventory(original)


def test_native_shared_lease_blocks_exclusive_writer_without_data_changes(tmp_path):
    original = tmp_path / "original"
    original.mkdir()
    descriptor = original / "WRITER.lock"
    descriptor.write_bytes(b"fullmag.writer.lock.v1\n")
    code = """
import os,sys
with open(sys.argv[1], 'r+b') as stream:
    try:
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit(17)
"""
    before = MODULE.inventory(original)
    with MODULE.source_read_lock(original):
        assert MODULE.inventory(original) == before
        blocked = subprocess.run([sys.executable, "-c", code, str(descriptor)], capture_output=True, timeout=10)
        assert blocked.returncode == 17, blocked.stderr
    released = subprocess.run([sys.executable, "-c", code, str(descriptor)], capture_output=True, timeout=10)
    assert released.returncode == 0, released.stderr
    assert MODULE.inventory(original) == before


def archive_source(tmp_path):
    root = tmp_path / "store"
    (root / "project").mkdir(parents=True)
    (root / "manifests").mkdir()
    (root / "runs/run-1").mkdir(parents=True)
    (root / "project/main.py").write_text("# canonical script\n")
    (root / "CURRENT").write_text("generation-1")
    (root / "manifests/generation-1.json").write_text(json.dumps({"format": "fullmag.session.v1",
                                                                 "run_refs": ["runs/run-1/run_manifest.json"]}))
    for name in ("run_manifest.json", "artifact_catalog.json"):
        (root / "runs/run-1" / name).write_text("{}")
    return root


def test_archive_preflight_binds_current_session_to_pinned_run(tmp_path):
    root = archive_source(tmp_path)
    result = MODULE.check_archive_source(root, MODULE.inventory(root), {"run_id": "run-1"})
    assert result["pinned_run_ref"] == "runs/run-1/run_manifest.json"
    with pytest.raises(ValueError, match="CURRENT"):
        MODULE.check_archive_source(root, MODULE.inventory(root), {"run_id": "another-run"})


def test_current_pointer_has_a_bounded_metadata_read(tmp_path):
    root = archive_source(tmp_path)
    (root / "CURRENT").write_bytes(b"x" * 4097)
    with pytest.raises(ValueError, match="CURRENT exceeds metadata budget"):
        MODULE.check_archive_source(root, MODULE.inventory(root), {"run_id": "run-1"})


def test_untyped_live_project_document_is_not_silently_discarded(tmp_path):
    root = archive_source(tmp_path)
    snapshot = root / "project/current_live_snapshot.json"
    snapshot.write_text('{"untyped_refs":true}')
    with pytest.raises(ValueError, match="no files removed"):
        MODULE.check_archive_source(root, MODULE.inventory(root), {"run_id": "run-1"})
    assert snapshot.exists()


def test_just_route_requires_explicit_config_without_starting_work():
    just = shutil.which("just")
    if just is None:
        pytest.skip("just is unavailable")
    env = dict(os.environ)
    env.pop("FULLMAG_SAVED_FEM_ROUNDTRIP_CONFIG", None)
    result = subprocess.run([just, "verify-saved-fem-archive-roundtrip"], cwd=SCRIPT.parents[1],
                            env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode != 0
    assert "FULLMAG_SAVED_FEM_ROUNDTRIP_CONFIG must name" in result.stderr


def test_shell_adapter_rejects_extra_roundtrip_arguments():
    git_bash = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
    bash = str(git_bash) if git_bash.is_file() else shutil.which("bash")
    if not bash:
        pytest.skip("bash is unavailable")
    root = SCRIPT.parents[1]
    command = f'python "{SCRIPT.as_posix()}" --repo-root "{root.as_posix()}" --unknown-option'
    result = subprocess.run([bash, "scripts/just_storage_shell.sh", command], cwd=root,
                            capture_output=True, text=True, timeout=15)
    assert result.returncode == 2
    assert "invalid saved FEM archive recipe" in result.stderr
