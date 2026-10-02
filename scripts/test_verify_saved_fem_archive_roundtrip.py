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


def test_driver_identity_tracks_required_output_contract(tmp_path, monkeypatch):
    names = ("verify_saved_fem_archive_roundtrip.py", "fullmag_storage.py",
             "local_runner/build_executor.py", "local_runner/worker_entrypoint.py",
             "local_runner/build_entrypoint.py")
    for name in names:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"initial contract")
    monkeypatch.setattr(MODULE, "SCRIPT_DIR", tmp_path)
    before = MODULE.driver_identity()
    assert "local_runner/build_entrypoint.py" in before
    (tmp_path / "local_runner/build_entrypoint.py").write_bytes(b"changed contract")
    after = MODULE.driver_identity()
    assert after["local_runner/build_entrypoint.py"] != before["local_runner/build_entrypoint.py"]


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


def test_container_path_rejects_paths_outside_roundtrip_mount(tmp_path):
    run_root = tmp_path / "run"
    run_root.mkdir()
    with pytest.raises(ValueError, match="roundtrip mount"):
        MODULE.container_roundtrip_path(tmp_path / "outside.json", run_root)


def test_container_command_binds_exact_artifact_readonly_and_disables_fallback(tmp_path):
    run_root = tmp_path / "run"
    artifact_root = tmp_path / "artifact" / "outputs" / ".fullmag" / "local"
    state_root = run_root / "source-state"
    output = run_root / "before-export.stdout.log"
    error = run_root / "before-export.stderr.log"
    run_root.mkdir()
    artifact_root.mkdir(parents=True)
    state_root.mkdir()
    (tmp_path / "compose.windows.yaml").write_text("services: {}\n")
    compose_override = MODULE.write_windows_network_override(run_root)
    override_text = compose_override.read_text(encoding="utf-8")
    assert 'profiles: ["disabled"]' in override_text
    assert 'network_mode: "none"' in override_text
    image_digest = "sha256:" + "a" * 64
    command, compose_env, evidence = MODULE.build_windows_container_command(
        repo_root=tmp_path,
        run_root=run_root,
        artifact_root=artifact_root,
        state_root=state_root,
        args=["runtime", "verify-saved-fem-snapshot", "--store", state_root / "store"],
        output_path=output,
        error_path=error,
        image_ref=image_digest,
        expected_image_digest=image_digest,
        compose_mount_root=run_root / "container-mounts",
        compose_override_path=compose_override,
        project_name="fullmag-saved-fem-test",
        container_name="fullmag-saved-fem-test-before",
    )

    assert "--detach" in command
    assert "--no-deps" in command
    assert "--build" not in command
    assert "fullmag-windows-fem-cpu" in command
    assert str(compose_override) in command
    assert any(value.endswith(":/workspace:ro") for value in command)
    assert any(
        value.endswith(":/workspace/.fullmag/pinned-build:ro")
        and value.startswith(artifact_root.as_posix())
        for value in command
    )
    assert compose_env["FULLMAG_WINDOWS_FEM_CPU_IMAGE"] == image_digest
    assert compose_env["COMPOSE_PROFILES"] == ""
    assert evidence["expected_image_digest"] == image_digest
    assert "FULLMAG_DISABLE_MANAGED_FEM_GPU_RUNTIME=1" in command
    assert "FULLMAG_FORCE_LOCAL_FEM_CPU=1" in command
    assert "FULLMAG_FEM_EXECUTION=cpu" in command
    assert "FULLMAG_FEM_REQUIRE_GPU=0" in command
    assert "/workspace/.fullmag/pinned-build/bin/fullmag-bin" in command[-1]
    assert "/workspace/.fullmag/local/bin/fullmag" not in command[-1]


def test_container_image_attestation_rejects_wrong_immutable_id(monkeypatch):
    class Result:
        returncode = 0
        stdout = '[{"Id":"sha256:' + "b" * 64 + '"}]'
        stderr = ""

    monkeypatch.setattr(MODULE.subprocess, "run", lambda *args, **kwargs: Result())
    with pytest.raises(ValueError, match="image identity"):
        MODULE.attest_windows_container_image(
            "sha256:" + "a" * 64, "sha256:" + "a" * 64
        )


def test_container_command_rejects_mutable_image_ref(tmp_path):
    with pytest.raises(ValueError, match="immutable digest"):
        MODULE.build_windows_container_command(
            repo_root=tmp_path,
            run_root=tmp_path / "run",
            artifact_root=tmp_path / "artifact",
            state_root=tmp_path / "run" / "state",
            args=[],
            output_path=tmp_path / "run" / "stdout",
            error_path=tmp_path / "run" / "stderr",
            image_ref="fullmag/fem-cpu:windows-local",
            expected_image_digest="sha256:" + "a" * 64,
            compose_mount_root=tmp_path / "run" / "mounts",
            compose_override_path=tmp_path / "run" / "compose.network-none.yaml",
            project_name="project",
            container_name="container",
        )


@pytest.mark.parametrize(
    ("outcome", "expected_state"),
    [
        ("timeout", "launch_timeout_container_unknown"),
        ("ambiguous", "launch_ambiguous_container_unknown"),
        ("nonzero", "launch_nonzero_container_unknown"),
    ],
)
def test_container_launch_unknown_outcomes_are_pending_and_keep_private_logs(
    tmp_path, monkeypatch, outcome, expected_state
):
    launch_stdout_path = tmp_path / "compose.stdout.log"
    launch_stderr_path = tmp_path / "compose.stderr.log"
    record = {"label": "before-export", "state": "observing"}
    receipt = {"commands": [record]}
    receipt_path = tmp_path / "receipt.json"
    calls = []

    class Result:
        returncode = 17 if outcome == "nonzero" else 0

    def fake_run(command, env, stdout, stderr, check, timeout):
        calls.append((command, timeout))
        stdout.write(b"compose started\n")
        stderr.write(b"compose diagnostic\n")
        if outcome == "timeout":
            raise subprocess.TimeoutExpired(command, timeout)
        if outcome == "ambiguous":
            stdout.seek(0)
            stdout.truncate()
            stdout.write(b"not-a-container-id\n")
        return Result()

    monkeypatch.setattr(MODULE.subprocess, "run", fake_run)
    with pytest.raises(ValueError):
        MODULE.observe_windows_container_launch(
            command=["docker", "compose", "run"],
            compose_env={},
            launch_stdout_path=launch_stdout_path,
            launch_stderr_path=launch_stderr_path,
            container_name="fullmag-saved-fem-before-export",
            command_record=record,
            receipt=receipt,
            receipt_path=receipt_path,
        )

    assert record["state"] == expected_state
    assert MODULE.has_pending_observation([record])
    assert launch_stdout_path.read_bytes()
    assert launch_stderr_path.read_bytes() == b"compose diagnostic\n"
    assert calls == [(["docker", "compose", "run"], MODULE.WINDOWS_CONTAINER_LAUNCH_TIMEOUT_SECONDS)]
    assert json.loads(receipt_path.read_text(encoding="utf-8"))["commands"][0]["state"] == expected_state


def test_normalized_host_path_accepts_docker_desktop_windows_aliases():
    if MODULE.os.name != "nt":
        pytest.skip("Docker Desktop Windows path aliases are Windows-only")
    expected = MODULE._normalized_host_path(r"C:\fullmag\roundtrip\artifact")
    assert MODULE._normalized_host_path(r"/host_mnt/c/fullmag/roundtrip/artifact") == expected
    assert MODULE._normalized_host_path(
        r"/run/desktop/mnt/host/c/fullmag/roundtrip/artifact"
    ) == expected


def test_container_mount_attestation_rejects_rogue_mount_and_requires_network_none(
    tmp_path, monkeypatch
):
    image_digest = "sha256:" + "a" * 64
    container_id = "b" * 64
    repo_root = tmp_path / "repo"
    artifact_root = tmp_path / "artifact"
    run_root = tmp_path / "run"
    compose_mount_root = run_root / "container-mounts"
    for path in (repo_root, artifact_root, run_root, compose_mount_root):
        path.mkdir(parents=True, exist_ok=True)
    expected_mounts = {
        "/workspace": (repo_root, False),
        "/workspace/.fullmag": (compose_mount_root / "runtime", True),
        "/workspace/.fullmag-build": (compose_mount_root / "build", True),
        "/workspace/.fullmag-cache": (compose_mount_root / "cache", True),
        "/workspace/.fullmag-cargo": (compose_mount_root / "cache" / "cargo", True),
        "/workspace/.fullmag-rustup": (compose_mount_root / "cache" / "rustup", True),
        "/pnpm": (compose_mount_root / "cache" / "pnpm", True),
        "/workspace/node_modules": (compose_mount_root / "frontend" / "node_modules", True),
        "/workspace/apps/control-room/node_modules": (
            compose_mount_root / "frontend" / "apps" / "control-room" / "node_modules", True
        ),
        "/fullmag-frontend": (compose_mount_root / "frontend", True),
        "/tmp/fullmag-windows": (compose_mount_root / "temp", True),
        "/workspace/.fullmag-roundtrip": (run_root, True),
        "/workspace/.fullmag/pinned-build": (artifact_root, False),
    }
    mounts = [
        {"Type": "bind", "Source": str(source), "Destination": destination, "RW": rw}
        for destination, (source, rw) in expected_mounts.items()
    ]
    inspected = {
        "Image": image_digest,
        "Mounts": mounts,
        "HostConfig": {"NetworkMode": "none"},
        "NetworkSettings": {"Networks": {"none": {
            "NetworkID": "none-network-id",
            "IPAddress": "",
            "GlobalIPv6Address": "",
            "Gateway": "",
            "IPv6Gateway": "",
            "EndpointID": "",
            "MacAddress": "",
            "LinkLocalIPv6Address": "",
            "IPPrefixLen": 0,
            "GlobalIPv6PrefixLen": 0,
            "IPv6PrefixLen": 0,
        }}},
    }

    class Result:
        returncode = 0
        stderr = ""

        @property
        def stdout(self):
            return json.dumps([inspected])

    monkeypatch.setattr(MODULE.subprocess, "run", lambda *args, **kwargs: Result())
    evidence = MODULE.attest_windows_container(
        container_id, image_digest, repo_root, artifact_root, run_root, compose_mount_root
    )
    assert evidence["network_mode"] == "none"
    assert evidence["network_settings_isolated"] is True
    assert evidence["unexpected_mounts_rejected"] is True

    inspected["Mounts"].append(
        {"Type": "bind", "Source": str(tmp_path / "rogue"), "Destination": "/rogue", "RW": True}
    )
    with pytest.raises(ValueError, match="unexpected mounts"):
        MODULE.attest_windows_container(
            container_id, image_digest, repo_root, artifact_root, run_root, compose_mount_root
        )

    inspected["Mounts"].pop()
    inspected["HostConfig"]["NetworkMode"] = "fullmag_default"
    with pytest.raises(ValueError, match="network access"):
        MODULE.attest_windows_container(
            container_id, image_digest, repo_root, artifact_root, run_root, compose_mount_root
        )

    inspected["HostConfig"]["NetworkMode"] = "none"
    inspected["NetworkSettings"]["Networks"] = {"bridge": {"IPAddress": "172.20.0.2"}}
    with pytest.raises(ValueError, match="network access"):
        MODULE.attest_windows_container(
            container_id, image_digest, repo_root, artifact_root, run_root, compose_mount_root
        )
