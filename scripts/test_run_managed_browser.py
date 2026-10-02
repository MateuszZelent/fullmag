"""Isolation and fail-closed checks for the managed browser launcher."""
import json
import pytest
from scripts import run_managed_browser as launcher


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
