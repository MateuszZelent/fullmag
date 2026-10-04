"""Interpreted checks for native backend reuse with a live frontend."""
import importlib.util
from pathlib import Path
import subprocess

import pytest

spec = importlib.util.spec_from_file_location("workspace_identity", Path(__file__).parent / "windows/workspace_backend_identity.py")
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)


@pytest.fixture
def repo(tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    for name, content in (("Cargo.toml", "native"), ("crates/example/lib.rs", "backend"),
                          ("apps/control-room/src/Example.tsx", "frontend")):
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    return tmp_path


def test_frontend_edit_preserves_backend_identity(repo):
    previous = identity.fingerprint(repo)["sha256"]
    frontend_inputs = ("apps/control-room",)
    frontend_previous = identity.fingerprint(repo, frontend_inputs)["sha256"]
    (repo / "apps/control-room/src/Example.tsx").write_text("changed UI")
    assert identity.fingerprint(repo)["sha256"] == previous
    assert identity.fingerprint(repo, frontend_inputs)["sha256"] != frontend_previous


def test_backend_edit_and_deletion_invalidate_native_package(repo):
    previous = identity.fingerprint(repo)["sha256"]
    source = repo / "crates/example/lib.rs"
    source.write_text("changed backend")
    changed = identity.fingerprint(repo)["sha256"]
    assert changed != previous
    source.unlink()
    assert identity.fingerprint(repo)["sha256"] not in (previous, changed)


def test_new_backend_input_invalidates_identity_but_ignored_output_does_not(repo):
    previous = identity.fingerprint(repo)["sha256"]
    (repo / ".gitignore").write_text("crates/example/output/\n")
    output = repo / "crates/example/output"
    output.mkdir()
    (output / "binary").write_bytes(b"cached output")
    assert identity.fingerprint(repo)["sha256"] == previous
    (repo / "crates/example/new.rs").write_text("new input")
    assert identity.fingerprint(repo)["sha256"] != previous


def test_dependency_only_edits_invalidate_backend_and_frozen_dependencies(repo):
    backend = identity.fingerprint(repo)["sha256"]
    dependencies = identity.fingerprint(repo, identity.DEPENDENCY_INPUTS)["sha256"]
    (repo / "pnpm-lock.yaml").write_text("new dependency identity")
    assert identity.fingerprint(repo)["sha256"] != backend
    assert identity.fingerprint(repo, identity.DEPENDENCY_INPUTS)["sha256"] != dependencies
