"""Isolation and fail-closed checks for the managed browser launcher."""
import json
import hashlib
import pytest
from scripts import run_managed_browser as launcher
from local_runner.build_entrypoint import required_outputs_for_profile
from local_runner.worker_entrypoint import SCHEMA, canonical


def test_rejects_desktop_9p_session_storage():
    with pytest.raises(ValueError, match="durable storage adapter required"):
        launcher.require_session_filesystem("1021997")


def test_accepts_native_ext_filesystem_type_without_qualifying_it():
    launcher.require_session_filesystem("ef53")


def test_cpu_package_has_only_private_writable_state(tmp_path):
    spec = launcher.compose_spec("sha256:" + "a" * 64, tmp_path / "source",
                                tmp_path / "package", tmp_path / "state", 3104)
    service = spec["services"]["browser"]
    assert service["ports"] == ["127.0.0.1:3104:8081"]
    assert service["pull_policy"] == "never"
    assert service["network_mode"] == "bridge"
    assert service["read_only"] is True
    assert [(m["target"], m["read_only"]) for m in service["volumes"]] == [
        ("/source", True), ("/package", True), ("/state", False)]
    assert service["user"] == "65532:65532"
    assert service["mem_limit"] == "2g"
    assert service["cpus"] == 4
    assert service["pids_limit"] == 128
    assert service["command"][:2] == ["bash", "-c"]
    assert service["command"][2].endswith("exec /package/bin/fullmag-api")
    assert '$${path##*/}' in service["command"][2]
    assert "mkdir -p /state/workspace/.fullmag" in service["command"][2]
    assert "ln -s /state /state/workspace/.fullmag" not in service["command"][2]
    assert service["environment"]["FULLMAG_STATE_ROOT"] == "/state/workspace/.fullmag"
    assert service["environment"]["FULLMAG_REPO_ROOT"] == "/state/workspace"
    assert service["environment"]["FULLMAG_FEM_EXECUTION"] == "cpu"


@pytest.mark.parametrize("image,port", [("mutable:latest", 3104),
    ("sha256:" + "a" * 64, 80), ("sha256:" + "a" * 64, 65536)])
def test_rejects_mutable_images_and_invalid_ports(tmp_path, image, port):
    with pytest.raises(ValueError):
        launcher.compose_spec(image, tmp_path, tmp_path, tmp_path, port)


@pytest.mark.parametrize("state,phase,code", [("running", "running", None),
    ("failed", "terminal", 1), ("succeeded", "running", 0)])
def test_rejects_nonterminal_or_failed_build_before_launch(tmp_path, state, phase, code):
    (tmp_path / "trusted").mkdir()
    (tmp_path / "receipt.json").write_text(json.dumps({"profile": "fem-cpu-release",
        "state": state, "phase": phase, "exit_code": code}))
    (tmp_path / "trusted/context.json").write_text("{}")
    with pytest.raises(ValueError, match="terminal and successful"):
        launcher.validate_managed_build(tmp_path, "a" * 40)


@pytest.mark.parametrize("dirty,requested", [(True, "a" * 40), (False, "b" * 40)])
def test_rejects_dirty_or_wrong_source_commit(tmp_path, monkeypatch, dirty, requested):
    root = tmp_path / ("1" * 32)
    trusted = root / "trusted"
    trusted.mkdir(parents=True)
    context = {"job_id": root.name, "source_digest": "c" * 64,
        "profile": "fem-cpu-release", "image_digest": "sha256:" + "d" * 64,
        "native_source_identity": {"head_commit_full": "a" * 40,
                                    "source_snapshot_dirty": dirty}}
    (trusted / "context.json").write_text(json.dumps(context))
    for name in ("build_entrypoint.py", "worker_entrypoint.py"):
        (trusted / name).write_text("trusted")
    hashes = {p.name: launcher.digest(p) for p in trusted.iterdir()}
    (root / "receipt.json").write_text(json.dumps({**context, "phase": "terminal",
        "state": "succeeded", "exit_code": 0, "trusted_hashes": hashes}))
    monkeypatch.setattr(launcher, "validate_build_receipt", lambda *a: pytest.fail("must reject before artifacts"))
    with pytest.raises(ValueError, match="Expected clean commit"):
        launcher.validate_managed_build(root, requested)


def retained_build(tmp_path, dirty=True, source_digest="c" * 64):
    root = tmp_path / ("1" * 32)
    trusted = root / "trusted"
    trusted.mkdir(parents=True)
    native = {"head_commit_full": "a" * 40, "source_snapshot_dirty": dirty,
              "source_snapshot_sha256": "e" * 64}
    context = {"job_id": root.name, "source_digest": source_digest,
               "profile": "fem-cpu-release", "image_digest": "sha256:" + "d" * 64,
               "native_source_identity": native}
    (trusted / "context.json").write_text(json.dumps(context))
    for name in ("build_entrypoint.py", "worker_entrypoint.py"):
        (trusted / name).write_text("trusted")
    journal = {**context, "phase": "terminal", "state": "succeeded", "exit_code": 0,
               "trusted_hashes": {p.name: launcher.digest(p) for p in trusted.iterdir()}}
    (root / "receipt.json").write_text(json.dumps(journal))
    artifacts = root / "artifacts"
    entries = []
    for name in required_outputs_for_profile("fem-cpu-release"):
        path = artifacts / "outputs/.fullmag/local" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"integrity fixture, not an executable")
        entries.append({"path": path.relative_to(artifacts).as_posix(),
                        "size": path.stat().st_size, "sha256": launcher.digest(path)})
    built = {"schema": "fullmag.local-runner.build.v1", "job_id": context["job_id"],
             "source_digest": context["source_digest"], "profile": context["profile"],
             "image_digest": context["image_digest"], "state": "succeeded",
             "qualification": "NOT VERIFIED", "native_source_identity": native,
             "native_source_identity_sha256": hashlib.sha256(canonical(native)).hexdigest(),
             "artifacts": entries, "stages": [{"name": name, "exit_code": 0} for name in
                 ("native-build", "frontend-dependencies", "frontend-build")]}
    (artifacts / "build-receipt.json").write_text(json.dumps(built))
    return root


@pytest.mark.parametrize("dirty", [True, False])
def test_explicit_snapshot_checks_exact_pins_and_real_artifact_integrity(tmp_path, dirty):
    root = retained_build(tmp_path, dirty)
    context, built = launcher.validate_managed_build(root, "a" * 40,
        source_digest="c" * 64, native_snapshot_sha256="e" * 64)
    assert built["native_source_identity"] == context["native_source_identity"]
    assert built["qualification"] == "NOT VERIFIED"
    artifact = root / "artifacts" / built["artifacts"][0]["path"]
    artifact.write_bytes(b"corrupted")
    with pytest.raises(ValueError, match="Artifact size mismatch"):
        launcher.validate_managed_build(root, "a" * 40,
            source_digest="c" * 64, native_snapshot_sha256="e" * 64)


@pytest.mark.parametrize("commit,digest,snapshot", [
    ("b" * 40, "c" * 64, "e" * 64),
    ("a" * 40, "f" * 64, "e" * 64),
    ("a" * 40, "c" * 64, "f" * 64),
    ("a" * 40, "c" * 64, None),
    ("a" * 40, None, "e" * 64),
    ("a" * 40, "c" * 63, "e" * 64),
])
def test_snapshot_refuses_wrong_or_incomplete_pins_before_artifacts(tmp_path, monkeypatch, commit, digest, snapshot):
    root = retained_build(tmp_path)
    monkeypatch.setattr(launcher, "validate_build_receipt", lambda *a: pytest.fail("must reject before artifacts"))
    with pytest.raises(ValueError, match="snapshot|commit"):
        launcher.validate_managed_build(root, commit,
            source_digest=digest, native_snapshot_sha256=snapshot)


def test_clean_commit_still_uses_existing_strict_artifact_validator(tmp_path):
    context, built = launcher.validate_managed_build(retained_build(tmp_path, dirty=False), "a" * 40)
    assert built["native_source_identity"] == context["native_source_identity"]


@pytest.mark.parametrize("snapshot,mode,resolved,corrupt", [
    (True, "commit", "a" * 40, False),
    (False, "snapshot", "a" * 40, False),
    (True, "snapshot", "b" * 40, False),
    (False, "commit", "b" * 40, False),
    (True, "snapshot", "a" * 40, True),
    (False, "commit", "a" * 40, True),
])
def test_run_refuses_capsule_mismatch_before_docker_or_storage_initialization(
        tmp_path, monkeypatch, snapshot, mode, resolved, corrupt):
    capsule = tmp_path / "capsule"
    tree = capsule / "tree"
    tree.mkdir(parents=True)
    member = tree / "fixture.py"
    member.write_bytes(b"x")
    core = {"schema_version": SCHEMA, "source_mode": mode, "resolved_commit": resolved,
            "files": [{"path": "fixture.py", "type": "file", "mode": "100644",
                       "size": 1, "sha256": hashlib.sha256(b"x").hexdigest()}],
            "deleted": [], "included_untracked": [], "excluded": []}
    source_digest = hashlib.sha256(canonical(core)).hexdigest()
    (capsule / "manifest.json").write_text(json.dumps({**core, "source_digest": source_digest}))
    root = retained_build(tmp_path, dirty=snapshot, source_digest=source_digest)
    journal_path = root / "receipt.json"
    journal = json.loads(journal_path.read_text())
    journal["mounts"] = [["bind", str(capsule), "/source", False]]
    journal_path.write_text(json.dumps(journal))
    # Verify the actual capsule first, then mutate only bytes for corruption cases.
    launcher.verify_source(capsule, source_digest)
    if corrupt:
        member.write_bytes(b"y")
    monkeypatch.setattr(launcher.storage, "resolve_layout", lambda *a: {
        "storage_root": str(tmp_path), "runs_root": str(tmp_path)})
    monkeypatch.setattr(launcher, "docker", lambda *a: pytest.fail("must reject before Docker"))
    monkeypatch.setattr(launcher.storage, "initialize",
                        lambda *a: pytest.fail("must reject before storage initialization"))
    pins = {"source_digest": source_digest, "native_snapshot_sha256": "e" * 64} if snapshot else {}
    error = "Capsule bytes changed" if corrupt else "capsule source mode/commit"
    with pytest.raises(ValueError, match=error):
        launcher.run(tmp_path, root.name, "a" * 40, 3104, **pins)


def test_snapshot_startup_requires_exact_dirty_flag_without_weakening_clean_default():
    stamp = "[fullmag] build: Fullmag | commit: " + "a" * 40 + " | dirty | source snapshot: " + "e" * 64
    with pytest.raises(ValueError, match="startup identity"):
        launcher.check_stamp(stamp, "a" * 40, "e" * 64)
    launcher.check_stamp(stamp, "a" * 40, "e" * 64, dirty=True)
    with pytest.raises(ValueError, match="startup identity"):
        launcher.check_stamp(stamp.replace(" | dirty | ", " | clean | "), "a" * 40, "e" * 64, dirty=True)
