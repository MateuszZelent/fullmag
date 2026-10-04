"""Verify development observation and terminal drain in owned empty processes."""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import msvcrt
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import threading
import traceback
import urllib.error
import urllib.request
import uuid

import fullmag_storage as storage
from windows.development_status import verified_build_identity
from windows.workspace_backend_identity import fingerprint


def run(repo_root: str) -> int:
    if not __debug__:
        raise storage.StorageError("Native API verification must not run with Python assertions disabled")
    layout = storage.resolve_layout(repo_root, "development-backend-api-checks")
    repo = Path(layout["repo_root"])
    native = storage.resolve_layout(repo, "windows-native-fdm-cpu-dev")
    source_before = fingerprint(repo)["sha256"]
    verifier_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    owner_path = storage.validate_path(Path(layout["storage_root"]) / "index" / (layout["worktree_id"] + ".json"), layout["storage_root"], "owner registry")
    owner = json.loads(owner_path.read_text(encoding="utf-8"))
    if owner.get("repo_root") != str(repo) or owner.get("state") not in {"active", "wip"} or not owner.get("task_id") or not owner.get("owner"):
        raise storage.StorageError("Native development checks require an active registered owner")
    storage.initialize(layout)
    with storage.build_lock(layout):
        manifest_path = storage.validate_path(Path(native["build_root"]) / "windows-runtime/build-manifest.json", layout["storage_root"], "native build manifest")
        verified = verified_build_identity(native["build_root"], native["runtime_root"], manifest_path, source_before)
        raw_manifest = manifest_path.read_bytes()
        if hashlib.sha256(raw_manifest).hexdigest() != verified["ready_build_id"]:
            raise storage.StorageError("Native build manifest changed after verification")
        manifest = json.loads(raw_manifest)
        source_api = storage.validate_path(manifest["api_binary"], native["build_root"], "verified native API")
        run_root = storage.validate_path(Path(layout["build_root"]) / "checks" / uuid.uuid4().hex, layout["build_storage_root"], "native API checks")
        run_root.mkdir(parents=True, exist_ok=False)
        from windows.runtime_bundle import _check_path_chain, _require_directory, _require_regular_file
        raw_api = Path(layout["build_root"]) / "runtime-bin/fullmag-api.exe"
        _check_path_chain(raw_api, "stable fixture API", allow_missing=True)
        api = storage.validate_path(raw_api, layout["build_root"], "stable fixture API")
        receipt_path = run_root / "receipt.json"
        receipt = {"schema": "fullmag.development-backend-api-checks.v1", "state": "running",
                   "head": storage.git(repo, "rev-parse", "HEAD"), "task_id": owner["task_id"],
                   "owner": owner["owner"], "source_sha256": source_before,
                   "verified_build_id": verified["ready_build_id"], "api_sha256": manifest["api_binary_sha256"],
                   "verifier_sha256": verifier_hash, "stable_executable_root": str(api.parent),
                   "build_snapshot_sha256": manifest["source_snapshot_sha256"],
                   "build_commit": manifest["git_commit"],
                   "started_at": storage.now(), "checks": [], "processes": [],
                   "scope": "native resource observation, private owner-authorized authoring acquisition and admission freeze/abort/disconnect, production CLI owner client in owned empty API, empty-service terminal drain; no process replacement, full workspace restart, solver or release qualification"}
        storage.atomic_json(receipt_path, receipt)
        code = 1
        try:
            from windows.runtime_bundle import BINARY_NAMES
            archive = run_root / "service-binaries"
            staging = run_root / "runtime-stage"
            archive.mkdir()
            staging.mkdir()
            api.parent.mkdir(exist_ok=True)
            _require_directory(api.parent, "stable fixture executable directory")
            if any(path.name not in BINARY_NAMES for path in api.parent.iterdir()):
                raise storage.StorageError("Stable fixture executable directory contains unknown entries")
            for existing in api.parent.iterdir():
                _require_regular_file(existing, "existing stable fixture executable", nonempty=True)
            source_bin = Path(manifest["cargo_target_dir"]) / manifest["target_triple"] / manifest["compiler_profile"]
            for name in BINARY_NAMES:
                _require_regular_file(source_bin / name, "verified fixture executable", nonempty=True)
                source = storage.validate_path(source_bin / name, native["build_root"], "verified fixture executable")
                expected = manifest["executable_sha256"][name]
                shutil.copyfile(source, archive / name)
                if hashlib.sha256(source.read_bytes()).hexdigest() != expected or hashlib.sha256((archive / name).read_bytes()).hexdigest() != expected:
                    raise storage.StorageError("Fixture executable changed while sealing its archive")
                shutil.copyfile(archive / name, staging / name)
                _check_path_chain(api.parent / name, "stable fixture executable", allow_missing=True)
                destination = storage.validate_path(api.parent / name, layout["build_root"], "stable fixture executable")
                # Windows refuses replacement of an active EXE. Never stop a
                # process to make room; the route holds its managed build lock.
                os.replace(staging / name, destination)
                if hashlib.sha256(destination.read_bytes()).hexdigest() != expected:
                    raise storage.StorageError("Stable fixture executable publication failed verification")
            binary_hash = hashlib.sha256(api.read_bytes()).hexdigest()
            if binary_hash != manifest["api_binary_sha256"] or hashlib.sha256(source_api.read_bytes()).hexdigest() != binary_hash:
                raise storage.StorageError("Native API changed while sealing its diagnostic copy")
            exercise(api, repo, run_root, receipt)
            exercise_service(repo, run_root, manifest, receipt, api.parent)
            # Use the canonical codegen branch rather than persisting the live
            # endpoint's process-specific accepted-store binding extension.
            export = subprocess.run([str(api), "--print-openapi-v2"], cwd=repo,
                                    capture_output=True, check=False, timeout=30,
                                    creationflags=subprocess.CREATE_NO_WINDOW)
            receipt["openapi_export_exit_code"] = export.returncode
            if export.returncode or len(export.stdout) > 4 * 1024 * 1024:
                raise storage.StorageError("Canonical native OpenAPI export failed")
            spec = json.loads(export.stdout)
            identity = spec["x-fullmag-build-identity"]
            if (identity["git_commit"] != receipt["build_commit"]
                    or identity["source_snapshot_sha256"] != receipt["build_snapshot_sha256"]
                    or "/v2/platform/development-backend" not in spec["paths"]):
                raise storage.StorageError("Canonical native OpenAPI identity does not match the verified build")
            storage.atomic_json(run_root / "openapi-v2.json", spec)
            receipt["openapi_sha256"] = hashlib.sha256((run_root / "openapi-v2.json").read_bytes()).hexdigest()
            receipt["checks"].append("canonical-codegen-identity")
            after = fingerprint(repo)["sha256"]
            receipt["source_sha256_after"] = after
            if after != source_before:
                raise storage.StorageError("Native sources changed during API verification")
            if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != verifier_hash:
                raise storage.StorageError("Native API verifier changed during verification")
            if not receipt["checks"] or not all(item["waited"] for item in receipt["processes"]):
                raise storage.StorageError("Native API verification lacks terminal evidence")
            code = 0
        except Exception as error:
            receipt["reason"] = type(error).__name__
            receipt["detail"] = str(error)[:1000]
            receipt["traceback"] = traceback.format_exc(limit=8)
            raise
        finally:
            receipt.update(state="completed" if code == 0 else "failed", exit_code=code, finished_at=storage.now())
            storage.atomic_json(receipt_path, receipt)
            print(json.dumps({"state": receipt["state"], "exit_code": code, "checks": len(receipt["checks"]), "receipt": str(receipt_path)}))
        return code


def exercise_cli_owner(repo: Path, run_root: Path, manifest: dict, receipt: dict, binaries: Path, service_config: Path) -> None:
    """Exercise the production native CLI client in its own empty API child."""
    fixture = run_root / "cli-owner-fixture"
    state = fixture / "state"
    state.mkdir(parents=True)
    native = storage.resolve_layout(repo, "windows-native-fdm-cpu-dev")
    checks = storage.resolve_layout(repo, "development-backend-api-checks")
    store = Path(native["storage_root"])
    worktree = native["worktree_id"]
    generation = uuid.uuid4().hex
    # Keep the fixture's generation separate from the user's active watcher.
    status = Path(checks["build_root"]) / "backend-watch-status.json"
    from windows.runtime_bundle import create_bundle, BINARY_NAMES
    source_bin = Path(manifest["cargo_target_dir"]) / manifest["target_triple"] / manifest["compiler_profile"]
    required = sum((source_bin / name).stat().st_size for name in BINARY_NAMES)
    if shutil.disk_usage(store).free < required + 512 * 1024 * 1024:
        raise storage.StorageError("Insufficient free storage for the isolated candidate bundle")
    candidate = create_bundle(native["build_root"], native["runtime_root"],
        Path(native["build_root"]) / "windows-runtime/build-manifest.json", "dev")
    receipt["cli_candidate_bundle"] = candidate
    storage.atomic_json(status, dict(schema="fullmag.backend-watch.v2", generation_id=generation,
        worktree_id=worktree, state="waiting", source_sha256=manifest["backend_source_sha256"],
        revision=1, updated_unix_ms=int(time.time() * 1000)))
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    env = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "COMPUTERNAME") if key in os.environ}
    env.update(FULLMAG_REPO_ROOT=str(repo), FULLMAG_STATE_ROOT=str(state), FULLMAG_API_PORT=str(port),
        FULLMAG_DEVELOPMENT_OWNER_PROBE="1", FULLMAG_NATIVE_RUNTIME_ACTIVE="1",
        FULLMAG_PYTHON=str(Path(native["build_root"]) / "python/fullmag/Scripts/python.exe"),
        FULLMAG_DEVELOPMENT_OWNER_PROBE_CANDIDATE=candidate["bundle_root"],
        FULLMAG_DEVELOPMENT_OWNER_PROBE_SERVICE_CONFIG=str(service_config),
        FULLMAG_STORAGE_PROFILE="windows-native-fdm-cpu-dev", FULLMAG_PROJECT_STORAGE_ROOT=str(store),
        FULLMAG_WORKTREE_ID=worktree, FULLMAG_DEVELOPMENT_BACKEND_GENERATION=generation,
        FULLMAG_DEVELOPMENT_BACKEND_STATUS_FILE=str(status),
        FULLMAG_DEVELOPMENT_BACKEND_SOURCE=manifest["backend_source_sha256"],
        FULLMAG_DEVELOPMENT_BACKEND_VERSION=manifest["build_version"]["product_version"])
    log_path = fixture / "cli.log"
    with log_path.open("w", encoding="utf-8") as log:
        child = subprocess.Popen([str(binaries / "fullmag.exe"), "runtime", "verify-development-api-owner"],
            cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW)
        record = {"label":"cli-owner-client", "pid":child.pid, "waited":False}
        receipt["processes"].append(record)
        try:
            code = child.wait(timeout=90)
            record.update(waited=True, exit_code=code)
        finally:
            if child.poll() is None:
                # This fixture owns the CLI and its API process tree.
                subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"],
                    capture_output=True, check=False, creationflags=subprocess.CREATE_NO_WINDOW)
                record.update(waited=True, exit_code=child.wait(timeout=10))
    if code != 0:
        raise storage.StorageError(f"Native CLI owner client failed; see {log_path}")
    frames = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines() if line.startswith('{')]
    assert len(frames) == 1, frames
    result = frames[0]
    assert result["schema"] == "fullmag.development-cli-owner-check.v1" and result["api_waited"] is True
    receipt["processes"].append(dict(label="cli-owned-api", pid=result["api_pid"],
        waited=True, exit_code=result["api_exit_code"]))
    for item in result["stage_helpers"]:
        assert item["waited"] is True and item["exit_code"] == 0
        receipt["processes"].append(dict(label="cli-capsule-stage-helper", **item))
    from windows.development_scene_handoff import load_scene_handoff
    assert len(result["handoffs"]) == 2
    for ack in result["handoffs"]:
        loaded = load_scene_handoff(str(repo), ack["handoff"]["handoff_id"], ack["binding"])
        assert loaded["snapshot_sha256"] == ack["handoff"]["snapshot_sha256"]
        assert loaded["receipt"]["state"] == "staged"
        assert loaded["editor"]["probe"] == ("empty" if ack["workspace_state"] == "no_session" else "scene")
    receipt["cli_handoffs"] = result["handoffs"]
    receipt["checks"].extend("cli-owner-" + name for name in result["checks"])


def exercise_service(repo: Path, run_root: Path, manifest: dict, receipt: dict, binaries: Path) -> None:
    """Exercise only this verifier's initialized empty store and sealed binaries."""
    from windows.runtime_bundle import BINARY_NAMES

    for name in BINARY_NAMES:
        expected = manifest["executable_sha256"][name]
        if hashlib.sha256((binaries / name).read_bytes()).hexdigest() != expected:
            raise storage.StorageError("Native service executable changed while sealing")

    state_root = run_root / "service-state"
    store = state_root / "local-live/session-store"
    project = store / "project"
    project.mkdir(parents=True)
    # Production CLI initializes the store. The fixture has no accepted runs.
    (project / "main.py").write_text("# Empty development drain fixture\n", encoding="utf-8")
    env = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "COMPUTERNAME", "HOSTNAME") if key in os.environ}
    env.update(FULLMAG_REPO_ROOT=str(repo), FULLMAG_STATE_ROOT=str(state_root))
    for label, args, private_value, expected_error in (
        ("restore-cli-release", ["ui"], "1", "requires development UI without a script"),
        ("restore-cli-script", ["ui", "--dev", str(run_root / "missing-script.py")], "1", "requires development UI without a script"),
        ("restore-cli-invalid", ["ui", "--dev"], "true", "invalid private development restore configuration"),
    ):
        rejected = subprocess.run(
            [str(binaries / "fullmag.exe"), *args], cwd=repo,
            env={**env, "FULLMAG_DEVELOPMENT_RESTORE_STDIN": private_value},
            input=b"not consumed", capture_output=True, timeout=15,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        output = rejected.stdout + rejected.stderr
        (run_root / (label + ".log")).write_bytes(output)
        if rejected.returncode == 0 or expected_error.encode() not in output:
            raise storage.StorageError("Private CLI restore did not reject its invalid startup context")
        receipt["checks"].append(label + "-rejected-before-bootstrap")
    # Exercise the actual CLI -> API inherited pipe. A deliberate frontend URL
    # failure occurs only after wait_for_api_ready, before any frontend/desktop
    # process starts; the CLI's owned bootstrap guard then waits for its API.
    if not shutil.which("node", path=env.get("PATH")):
        raise storage.StorageError("CLI pipe fixture requires the configured Node runtime")
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        bridge_port = reservation.getsockname()[1]
    fixture_storage = run_root / "fixture-storage"
    bridge_env = {**env,
        "FULLMAG_STATE_ROOT": str(run_root / "restore-cli-state"),
        "FULLMAG_API_PORT": str(bridge_port),
        "FULLMAG_WEB_PUBLIC_PORT": "invalid-fixture-port",
        "FULLMAG_DEVELOPMENT_RESTORE_STDIN": "1",
        "FULLMAG_DEVELOPMENT_BACKEND_GENERATION": "1" * 32,
        "FULLMAG_DEVELOPMENT_BACKEND_STATUS_FILE": str(fixture_storage / "builds/fixture-worktree/windows-native-fdm-cpu-dev/backend-watch-status.json"),
        "FULLMAG_DEVELOPMENT_BACKEND_SOURCE": "a" * 64,
        "FULLMAG_DEVELOPMENT_BACKEND_VERSION": "0.1.0-dev.fixture",
        "FULLMAG_PROJECT_STORAGE_ROOT": str(fixture_storage),
        "FULLMAG_WORKTREE_ID": "fixture-worktree",
    }
    bridge = subprocess.Popen([str(binaries / "fullmag.exe"), "ui", "--dev"],
        cwd=repo, env=bridge_env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
    bridge_record = dict(label="restore-cli-pipe", pid=bridge.pid, waited=False)
    receipt["processes"].append(bridge_record)
    try:
        output, _ = bridge.communicate((run_root / "restore-cli-input.json").read_bytes(), timeout=90)
    finally:
        if bridge.poll() is None:
            # Stopping only the CLI would orphan its API on Windows. This tree
            # belongs exclusively to this empty verifier fixture, which has
            # never reached frontend/desktop or accepted computation startup.
            cleanup = subprocess.run(["taskkill", "/PID", str(bridge.pid), "/T", "/F"],
                capture_output=True, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
            bridge_record["tree_cleanup_exit_code"] = cleanup.returncode
        bridge_record.update(exit_code=bridge.wait(timeout=10), waited=True)
        with socket.socket() as probe:
            bridge_record["api_listener_closed"] = probe.connect_ex(("127.0.0.1", bridge_port)) != 0
        if not bridge_record["api_listener_closed"]:
            raise storage.StorageError("CLI bootstrap left its owned restore API listening")
    (run_root / "restore-cli-pipe.log").write_bytes(output)
    if bridge.returncode == 0 or b"FULLMAG_WEB_PUBLIC_PORT must contain digits" not in output:
        raise storage.StorageError("CLI inherited restore pipe did not reach the post-API frontend gate")
    receipt["checks"].extend(("restore-cli-inherited-pipe-reaches-fresh-api", "restore-cli-owned-api-drained-on-bootstrap-error"))
    initialized = subprocess.run([str(binaries / "fullmag.exe"), "session", "save", str(run_root / "empty.fms"), "--profile", "compact"],
                                 cwd=repo, env=env, capture_output=True, timeout=30,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
    (run_root / "service-initialize.log").write_bytes(initialized.stdout + initialized.stderr)
    if initialized.returncode:
        raise storage.StorageError("Production CLI could not initialize the empty service fixture")
    budget = dict(cpu_millis=1000, memory_bytes=1024, storage_bytes=1024, gpu_memory_bytes=0)
    config = dict(schema_version="runtime_service_config.v1", store_root=str(store), target_id="desktop",
                  compute_pool_id="compute", preparation_pool_id="prep",
                  compute_resources=[dict(resource_id="compute.cpu", kind="cpu", budget=budget)],
                  preparation_resources=[dict(resource_id="prep.cpu", budget=budget)],
                  worker_timeout_seconds=10, preparation_timeout_seconds=10,
                  heartbeat_interval_milliseconds=100, startup_timeout_seconds=10, drain_timeout_seconds=10)
    config_path = run_root / "service-config.json"
    storage.atomic_json(config_path, config)
    owner_path = store / "runtime-services/OWNER.json"
    log_path = run_root / "service.log"
    with log_path.open("w", encoding="utf-8") as log:
        child = subprocess.Popen([str(binaries / "fullmag-runtime-service.exe"), "--config", str(config_path)],
                                 cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        record = dict(label="empty-resident-service", pid=child.pid, waited=False)
        receipt["processes"].append(record)
        owner = None
        idle_drain_requested = False

        def control(command, token, nonce):
            address, port = owner["control_address"].rsplit(":", 1)
            if address != "127.0.0.1" or not 0 < int(port) < 65536:
                raise storage.StorageError("Fixture control address is not IPv4 loopback")
            frame = dict(schema_version="runtime_service_control.v1", owner_token=token, command=command, nonce=nonce)
            with socket.create_connection((address, int(port)), timeout=15) as stream:
                stream.sendall(json.dumps(frame).encode("utf-8") + b"\n")
                response = bytearray()
                while b"\n" not in response:
                    block = stream.recv(4096)
                    if not block or len(response) + len(block) > 256 * 1024:
                        raise storage.StorageError("Fixture control response is incomplete or oversized")
                    response.extend(block)
                line, trailing = response.split(b"\n", 1)
                if trailing.strip():
                    raise storage.StorageError("Fixture control response has trailing data")
                return json.loads(line)

        try:
            deadline = time.monotonic() + 20
            while True:
                if child.poll() is not None:
                    raise storage.StorageError("Empty resident service exited before Ready")
                if owner_path.exists():
                    owner = json.loads(owner_path.read_text(encoding="utf-8"))
                    if owner["state"] == "ready":
                        break
                if time.monotonic() >= deadline:
                    raise storage.StorageError("Empty resident service did not publish Ready")
                time.sleep(0.1)
            assert owner["pid"] == child.pid
            assert owner["build_commit"] == manifest["git_commit"]
            assert owner["build_snapshot"] == manifest["source_snapshot_sha256"]
            assert len(owner["children"]) == 2 and all(item["status"] == "running" for item in owner["children"])
            exercise_cli_owner(repo, run_root, manifest, receipt, binaries, config_path)
            assert control("status", owner["owner_token"], uuid.uuid4().hex)["owner"]["state"] == "ready"
            assert not (store / "development/ADMISSION-FENCE.json").exists()
            receipt["checks"].append("foreign-api-store-refusal-keeps-service-ready-and-unfenced")
            receipt["checks"].append("empty-service-ready-source-identity")
            denied = control("drain_idle_confirmed", str(uuid.uuid4()), "unauthorized")
            assert denied.get("status") == "rejected", denied
            receipt["checks"].append("wrong-owner-cannot-drain-empty-service")
            denied = control("drain_idle_confirmed", owner["owner_token"], "invalid challenge")
            assert denied.get("status") == "rejected", denied
            receipt["checks"].append("invalid-challenge-cannot-drain-empty-service")
            challenge = uuid.uuid4().hex
            observed = control("status", owner["owner_token"], challenge)
            assert observed["nonce"] == challenge and observed["configuration"] == config
            assert observed["owner"]["state"] == "ready"
            receipt["checks"].append("rejected-drain-leaves-service-ready")
            # Valid empty catalog without an intent must remain conservative;
            # neither scheduler has a task to dispatch from this fixture.
            orphan_path = store / "runs/idle-fence-orphan/run_catalog.json"
            orphan_path.parent.mkdir(parents=True)
            storage.atomic_json(orphan_path, dict(schema_version="run_catalog.v1",
                run_id="idle-fence-orphan", revision=1, updated_at="2026-10-03T00:00:00Z", tasks=[]))
            denied = control("drain_idle_confirmed", owner["owner_token"], uuid.uuid4().hex)
            assert denied == {"status": "rejected", "reason": "idle_not_proven"}, denied
            assert control("status", owner["owner_token"], uuid.uuid4().hex)["owner"]["state"] == "ready"
            assert not (store / "development/ADMISSION-FENCE.json").exists()
            receipt["checks"].append("orphan-empty-catalog-refuses-idle-drain")
            orphan_path.unlink()  # Only the disposable catalog created above.
            # These durable ownership fixtures have no catalog/specification to
            # dispatch. Resources deliberately lie outside both configured pools:
            # checking just the resident service's offers would miss them.
            lease_common = dict(resource_id="outside-pool", budget=budget,
                run_id="idle-fence-lease", task_id="fixture-task", lease_token="fixture-lease",
                state="active", acquired_at="2026-10-03T00:00:00Z",
                heartbeat_at="2026-10-03T00:00:00Z", heartbeat_sequence=0)
            for family, document in (
                ("resource_leases", dict(**lease_common, schema_version="resource_lease.v1",
                    kind="cpu", attempt_id="fixture-attempt", ownership_epoch=1)),
                ("preparation_resource_leases", dict(**lease_common,
                    schema_version="preparation_resource_lease.v1",
                    preparation_attempt_id="fixture-preparation")),
            ):
                lease_path = store / "runs/idle-fence-lease" / family / "outside-pool/fixture-lease.json"
                lease_path.parent.mkdir(parents=True)
                storage.atomic_json(lease_path, document)
                denied = control("drain_idle_confirmed", owner["owner_token"], uuid.uuid4().hex)
                assert denied == {"status": "rejected", "reason": "idle_not_proven"}, denied
                assert control("status", owner["owner_token"], uuid.uuid4().hex)["owner"]["state"] == "ready"
                assert not (store / "development/ADMISSION-FENCE.json").exists()
                receipt["checks"].append(family + "-outside-pool-refuses-idle-drain")
                # Keep the document to prove that terminal lease history does
                # not prevent the eventual idle drain. No process owns it.
                storage.atomic_json(lease_path, {**document, "state": "released",
                    "released_at": "2026-10-03T00:01:00Z"})
            fence_path = store / "development/ADMISSION-FENCE.json"
            fence_path.parent.mkdir(exist_ok=True)
            # Only this verifier's empty store is modified. Unknown persisted
            # ownership must reject before either scheduler is drained.
            fence_path.write_text('{"schema":"unknown"}', encoding="utf-8")
            denied = control("drain_idle_confirmed", owner["owner_token"], uuid.uuid4().hex)
            assert denied == {"status": "rejected", "reason": "idle_not_proven"}, denied
            assert control("status", owner["owner_token"], uuid.uuid4().hex)["owner"]["state"] == "ready"
            assert fence_path.read_text(encoding="utf-8") == '{"schema":"unknown"}'
            receipt["checks"].append("unknown-fence-refuses-idle-drain-without-stopping-service")
            fence_path.unlink()  # Remove only the disposable marker created above.
            challenge = uuid.uuid4().hex
            # Hold the existing native descriptor, never replace its inode or
            # owner metadata. A short competing writer must be retried by the
            # service; an unknown/busy authoring store must still fail closed.
            with (store / "WRITER.lock").open("r+b", buffering=0) as descriptor:
                deadline = time.monotonic() + 5
                while True:
                    try:
                        descriptor.seek(0)
                        msvcrt.locking(descriptor.fileno(), msvcrt.LK_NBLCK, 1)
                        break
                    except OSError:
                        assert time.monotonic() < deadline
                        time.sleep(0.02)
                def release_writer():
                    time.sleep(0.3)
                    descriptor.seek(0)
                    msvcrt.locking(descriptor.fileno(), msvcrt.LK_UNLCK, 1)
                release = threading.Thread(target=release_writer)
                started = time.monotonic()
                release.start()
                try:
                    idle_drain_requested = True
                    drain_child = subprocess.Popen(
                        [str(binaries / "fullmag.exe"), "runtime", "verify-development-service-drain", "--config", str(config_path)],
                        cwd=repo, env={**env, "FULLMAG_DEVELOPMENT_SERVICE_DRAIN_PROBE":"1"},
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                        creationflags=subprocess.CREATE_NO_WINDOW)
                    drain_record = dict(label="native-idle-drain-client", pid=drain_child.pid, waited=False)
                    receipt["processes"].append(drain_record)
                    try:
                        output, errors = drain_child.communicate(timeout=20)
                    finally:
                        if drain_child.poll() is None:
                            drain_child.kill()  # Only this fixture's diagnostic CLI, never the service.
                            drain_child.wait(timeout=10)
                        drain_record.update(waited=True, exit_code=drain_child.returncode)
                    (run_root / "native-idle-drain-client.log").write_bytes(output + errors)
                    assert drain_child.returncode == 0
                    frames = [json.loads(line) for line in output.decode().splitlines() if line.startswith('{')]
                    assert len(frames) == 1
                    proof = frames[0]
                finally:
                    release.join(timeout=2)
                    assert not release.is_alive()
                assert proof["schema"] == "fullmag.development-service-idle-check.v1"
                assert time.monotonic() - started >= 0.25
            receipt["checks"].append("idle-drain-retries-native-writer-contention-before-fencing")
            fence = json.loads(fence_path.read_text(encoding="utf-8"))
            challenge = proof["fence_nonce"]
            canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
            assert hashlib.sha256(canonical(fence)).hexdigest() == proof["fence_sha256"]
            assert proof["service_pid"] == child.pid and proof["state"] == "drained"
            assert fence["schema"] == "fullmag.development-admission-fence.v1"
            assert fence["owner_token"] == owner["owner_token"] and fence["nonce"] == challenge
            assert json.loads(fence_path.read_text(encoding="utf-8")) == fence
            receipt["checks"].append("idle-drain-retains-exact-durable-admission-fence")
            drained = json.loads(owner_path.read_text(encoding="utf-8"))
            assert hashlib.sha256(canonical(drained)).hexdigest() == proof["owner_sha256"]
            assert proof["children"] == drained["children"]
            receipt["checks"].append("production-rust-client-validates-global-idle-drain-and-fence")
            assert drained["state"] == "drained"
            for field in ("owner_token", "process_start_token", "pid", "host", "target_id", "control_address",
                          "build_commit", "build_snapshot", "compute_pool_id", "preparation_pool_id",
                          "compute_pool_generation", "preparation_pool_generation"):
                assert drained[field] == owner[field], field
            assert {(item["role"], item["pid"]) for item in drained["children"]} == {(item["role"], item["pid"]) for item in owner["children"]}
            assert all(item["status"] == "exited_success" for item in drained["children"])
            receipt["checks"].append("confirmed-drain-follows-both-terminal-children")
            assert json.loads(owner_path.read_text(encoding="utf-8"))["state"] == "drained"
            receipt["checks"].append("terminal-owner-published-before-confirmation")
        finally:
            # Never stop an unrelated owner or replace an unknown drain result.
            # Once an idle lifecycle request may have been sent, a lost CLI
            # outcome must not trigger a second lifecycle request. Wait for the
            # exact owned service; retain it with evidence if it stays live.
            if not idle_drain_requested and child.poll() is None and owner is not None and owner.get("pid") == child.pid:
                try:
                    control("drain", owner["owner_token"], None)
                except (OSError, ValueError, storage.StorageError):
                    pass
            try:
                record["exit_code"] = child.wait(timeout=20)
                record["waited"] = True
            except subprocess.TimeoutExpired:
                record["retained_reason"] = "owned service drain outcome remains unknown"
                raise
            record["log_sha256"] = hashlib.sha256(log_path.read_bytes()).hexdigest()
        if record["exit_code"] != 0:
            raise storage.StorageError("Empty resident service did not exit successfully")
        receipt["checks"].append("confirmed-drain-service-process-exited")
        assert json.loads(fence_path.read_text(encoding="utf-8")) == fence
        receipt["checks"].append("admission-fence-survives-service-process-exit")


def exercise(api: Path, repo: Path, run_root: Path, receipt: dict) -> None:
    generation, source, worktree = "1" * 32, "a" * 64, "fixture-worktree"
    fixture_storage = run_root / "fixture-storage"
    status = fixture_storage / "builds" / worktree / "windows-native-fdm-cpu-dev/backend-watch-status.json"
    status.parent.mkdir(parents=True)
    configured = {
        "FULLMAG_DEVELOPMENT_BACKEND_GENERATION": generation,
        "FULLMAG_DEVELOPMENT_BACKEND_STATUS_FILE": str(status),
        "FULLMAG_DEVELOPMENT_BACKEND_SOURCE": source,
        "FULLMAG_DEVELOPMENT_BACKEND_VERSION": "0.1.0-dev.fixture",
        "FULLMAG_PROJECT_STORAGE_ROOT": str(fixture_storage), "FULLMAG_WORKTREE_ID": worktree,
    }
    checks = receipt["checks"]

    def frame(state="waiting", **changes):
        value = dict(schema="fullmag.backend-watch.v2", generation_id=generation,
                     worktree_id=worktree, state=state, source_sha256=source,
                     revision=1, updated_unix_ms=int(time.time() * 1000))
        value.update(changes)
        storage.atomic_json(status, value)

    def check(name, body, state, reason):
        assert body["state"] == state and body["reason"] == reason, (name, body)
        assert body["restart_available"] is False, (name, body)
        serialized = json.dumps(body)
        assert not any(secret in serialized for secret in (str(fixture_storage), generation, "generation_id", "updated_unix_ms", "status_file", "pid")), body
        checks.append(name)

    def with_api(label, config, callback, *, restore_input=None, reject_startup=False, hold_input_open=False):
        # Only this route's child can be stopped. It never accepts computation.
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        env = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "COMPUTERNAME") if key in os.environ}
        env.update(FULLMAG_REPO_ROOT=str(repo), FULLMAG_STATE_ROOT=str(run_root / (label + "-state")), FULLMAG_API_PORT=str(port), FULLMAG_DISABLE_STATIC_CONTROL_ROOM="1")
        env.update(config)
        log_path = run_root / (label + ".log")
        with log_path.open("w", encoding="utf-8") as log:
            child = subprocess.Popen([str(api)], cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT,
                                     stdin=subprocess.PIPE if restore_input is not None or hold_input_open else subprocess.DEVNULL,
                                     creationflags=subprocess.CREATE_NO_WINDOW)
            record = {"label": label, "pid": child.pid, "port": port, "waited": False}
            receipt["processes"].append(record)
            base = f"http://127.0.0.1:{port}/v2/platform/"

            def get(path="development-backend", etag=None, *, method="GET", payload=None):
                url = f"http://127.0.0.1:{port}" + path if path.startswith("/") else base + path
                headers = {"If-None-Match": etag} if etag else {}
                if payload is not None:
                    headers["Content-Type"] = "application/json"
                request = urllib.request.Request(url, method=method, headers=headers,
                                                 data=json.dumps(payload).encode("utf-8") if payload is not None else None)
                try:
                    with urllib.request.urlopen(request, timeout=2) as response:
                        return response.status, response.headers.get("ETag"), None if response.status == 204 else json.load(response)
                except urllib.error.HTTPError as error:
                    if error.code == 304:
                        return 304, error.headers.get("ETag"), None
                    raise
            try:
                if restore_input is not None:
                    try:
                        child.stdin.write(restore_input)
                        child.stdin.close()
                    except BrokenPipeError:
                        if not reject_startup:
                            raise
                if reject_startup:
                    assert child.wait(timeout=15) != 0, label
                    try:
                        get()
                    except urllib.error.URLError:
                        checks.append(label + "-rejected-before-listener")
                    else:
                        raise AssertionError("Invalid restore exposed an API listener")
                    return
                deadline = time.monotonic() + 20
                while True:
                    if child.poll() is not None:
                        raise RuntimeError(f"Owned API exited during startup: {label}; see {log_path}")
                    try:
                        get()
                        break
                    except urllib.error.URLError:
                        if time.monotonic() >= deadline:
                            raise RuntimeError("Owned API did not become available")
                        time.sleep(0.1)
                get.owner_pid = child.pid
                get.api_port = port
                callback(get)
            finally:
                if child.stdin is not None and not child.stdin.closed:
                    try:
                        child.stdin.close()
                    except BrokenPipeError:
                        pass
                if child.poll() is None:
                    record["stop_requested_by_verifier"] = True
                    child.terminate()
                record["exit_code"] = child.wait(timeout=10)
                record["waited"] = True
                record["log_sha256"] = hashlib.sha256(log_path.read_bytes()).hexdigest()

    def disabled(get):
        check("non-dev-disabled", get()[2], "disabled", "disabled")
        status_code, _, created = get("/v2/sessions", method="POST", payload={
            "name": "Owned admission fixture", "backend": "fdm", "device": "cpu", "precision": "double",
        })
        assert status_code == 201 and created["session_id"], created
        checks.append("open-admission-creates-scratch-session")
        status_code, _, current = get("/v2/sessions/current")
        assert status_code == 200 and current["session_id"] == created["session_id"], current
        checks.append("read-after-admitted-mutation")
        status_code, _, _ = get("/v1/internal/live/current/control/wait?timeoutMs=100")
        assert status_code == 204, status_code
        checks.append("admitted-empty-control-dequeue")

    with_api("disabled", {}, disabled)
    with_api("partial", {"FULLMAG_DEVELOPMENT_BACKEND_GENERATION": generation}, lambda get: check("partial-configuration", get()[2], "unknown", "configuration_invalid"))

    # This tests the private prelisten consumer, not capsule authenticity or
    # the manager's complete restart. No previous process/session is stopped.
    restored_scene = {
        "version": "scene.v2", "revision": 17,
        "scene": {"id": "stable-model-fixture", "name": "Restored authoring", "source_of_truth": "ui"},
        "objects": [{"id": "body-fixture", "name": "Unassigned draft", "material_ref": "",
                     "geometry": {"geometry_kind": "box", "geometry_params": {"size": [1e-6, 1e-6, 1e-8]}}}],
        "editor": {"selected_object_id": "body-fixture", "gizmo_mode": "rotate"},
        "study": {"requested_backend": "auto", "requested_device": "gpu",
                  "requested_precision": "single", "requested_mode": "extended", "requested_cpu_threads": 3},
    }
    restore_envelope = {
        "schema": "fullmag.development-prelisten-restore.v1",
        "target_build_id": configured["FULLMAG_DEVELOPMENT_BACKEND_VERSION"],
        "target_source_sha256": source, "old_session_id": "old-session-fixture",
        "scene_document": restored_scene,
    }
    restore_config = {**configured, "FULLMAG_DEVELOPMENT_RESTORE_STDIN": "1"}
    storage.atomic_json(run_root / "restore-cli-input.json", restore_envelope)

    owner_token = "7" * 32

    def private_acquisition(get, expected_scene=None):
        owner_root = fixture_storage / "runtimes" / worktree
        deadline = time.monotonic() + 5
        while True:
            records = [json.loads(path.read_text()) for path in owner_root.glob("development-api-owner-*.json")]
            matching = [item for item in records if item["pid"] == get.owner_pid and item["api_port"] == get.api_port]
            if len(matching) == 1:
                owner = matching[0]
                break
            assert time.monotonic() < deadline, "Private owner discovery was not published"
            time.sleep(0.05)
        assert owner["schema"] == "fullmag.development-api-owner.v1"
        assert owner["owner_token_sha256"] == hashlib.sha256(owner_token.encode()).hexdigest()
        assert owner_token not in json.dumps(owner)
        address, port = owner["control_address"].rsplit(":", 1)
        assert address == "127.0.0.1" and 0 < int(port) < 65536
        checks.append("private-owner-discovery-bound-to-owned-api")

        def connect():
            return socket.create_connection((address, int(port)), timeout=8)

        def exchange(stream, message):
            stream.sendall(json.dumps(message).encode() + b"\n")
            response = bytearray()
            while b"\n" not in response:
                block = stream.recv(4096)
                assert block and len(response) + len(block) <= 64 * 1024 * 1024
                response.extend(block)
            line, trailing = response.split(b"\n", 1)
            assert not trailing.strip()
            exchange.last_raw = line
            return json.loads(line)

        # Retain Rust's scalar number tokens while independently sorting object
        # keys. Python's float printer uses a different exponent spelling.
        class NumberToken(str):
            pass

        def canonical_wire_bytes(value):
            if isinstance(value, NumberToken):
                return value.encode()
            if isinstance(value, list):
                return b"[" + b",".join(map(canonical_wire_bytes, value)) + b"]"
            if isinstance(value, dict):
                return b"{" + b",".join(json.dumps(key, ensure_ascii=False).encode() + b":"
                    + canonical_wire_bytes(value[key]) for key in sorted(value)) + b"}"
            return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()

        canonical = None
        if expected_scene is not None:
            code, _, canonical = get("/v2/sessions/current/model/scene")
            assert code == 200
            code, _, observed_status = get("/v2/sessions/current/status")
            assert code == 200 and observed_status["session"]["request_scope_epoch"] == owner["api_instance_id"] + ":1"
            checks.append("private-owner-http-pin-and-restored-request-scope-share-instance")

        frame = dict(schema="fullmag.development-api-control.v1", owner_token=owner_token,
                     api_instance_id=owner["api_instance_id"], nonce=str(uuid.uuid4()), command="acquire")
        for change in ({"owner_token": "8" * 32}, {"api_instance_id": str(uuid.uuid4())},
                       {"nonce": "invalid"}, {"unexpected": True}):
            with connect() as stream:
                denied = exchange(stream, {**frame, **change})
                assert denied["status"] == "rejected" and "workspace" not in denied, denied
        checks.append("private-acquisition-auth-identity-nonce-and-schema-rejected")

        def assert_mutation_frozen():
            try:
                get("/v2/sessions", method="POST", payload={"name": "Must not be created",
                    "backend": "fdm", "device": "cpu", "precision": "double"})
            except urllib.error.HTTPError as error:
                assert error.code == 409, error.code
                assert json.load(error)["code"] == "development_restart_in_progress"
            else:
                raise AssertionError("Private acquisition did not freeze mutation admission")

        def rejected_body_transport():
            body = json.dumps({"name": "Rejected transport fixture", "backend": "fdm",
                "device": "cpu", "precision": "double", "padding": "x" * 65536}).encode()
            for framing in ("content-length", "chunked"):
                connection = http.client.HTTPConnection("127.0.0.1", get.api_port, timeout=5)
                try:
                    payload = body if framing == "content-length" else [body[:50], body[50:]]
                    connection.request("POST", "/v2/sessions", body=payload,
                        headers={"Content-Type": "application/json", "X-Request-ID": "frozen-transport"},
                        encode_chunked=framing == "chunked")
                    response = connection.getresponse()
                    assert response.status == 409 and not response.will_close
                    assert response.getheader("x-request-id") == "frozen-transport"
                    assert response.getheader("x-fullmag-api-instance") == owner["api_instance_id"]
                    assert response.getheader("x-api-contract-version")
                    assert json.loads(response.read())["code"] == "development_restart_in_progress"
                    retained_socket = connection.sock
                    assert retained_socket is not None
                    connection.request("GET", "/healthz")
                    observed = connection.getresponse()
                    assert observed.status == 200
                    observed.read()
                    assert connection.sock is retained_socket
                finally:
                    connection.close()
                checks.append("frozen-" + framing + "-body-returns-409-and-retains-connection")
            for partial_body in (b"", b"x"):
                connection = http.client.HTTPConnection("127.0.0.1", get.api_port, timeout=5)
                try:
                    connection.putrequest("POST", "/v2/sessions")
                    connection.putheader("Content-Length", "32")
                    connection.endheaders()
                    started = time.monotonic()
                    if partial_body:
                        connection.send(partial_body)  # Never complete the declared body.
                    response = connection.getresponse()
                    assert response.status == 409 and response.will_close
                    assert response.getheader("Connection") == "close"
                    assert json.loads(response.read())["code"] == "development_restart_in_progress"
                    assert 1.5 <= time.monotonic() - started < 5
                finally:
                    connection.close()
                checks.append("frozen-" + ("partial" if partial_body else "stalled") + "-body-is-bounded-and-closes-connection")

        with connect() as stream:
            acquired = exchange(stream, frame)
            assert acquired["schema"] == "fullmag.development-authoring-acquisition.v1", acquired
            assert acquired["nonce"] == frame["nonce"] and acquired["api_instance_id"] == owner["api_instance_id"]
            workspace = acquired["workspace"]
            if expected_scene is None:
                assert workspace == {"state": "no_session", "session_epoch": 0}, workspace
            else:
                assert workspace["state"] == "session", workspace
                assert workspace["scene_document"] == canonical
                assert canonical["scene"]["id"] == expected_scene["scene"]["id"]
                assert workspace["identity"]["api_instance_id"] == owner["api_instance_id"]
                assert workspace["identity"]["session_epoch"] == 1
                wire_scene = json.loads(exchange.last_raw, parse_float=NumberToken,
                    parse_int=NumberToken)["workspace"]["scene_document"]
                assert workspace["scene_sha256"] == hashlib.sha256(canonical_wire_bytes(wire_scene)).hexdigest()
                from windows.development_acquisition_handoff import _acquired
                staged_workspace, staged_identity = _acquired(bytes(exchange.last_raw), owner["api_instance_id"])
                assert staged_workspace == workspace and staged_identity == workspace["identity"]
                checks.append("private-acquisition-production-stager-validates-rust-wire-and-digest")
            checks.append("private-acquisition-canonical-workspace-and-provenance")
            for _ in range(2):
                confirmed = exchange(stream, {**frame, "command": "confirm"})
                assert confirmed == {"schema": "fullmag.development-api-confirm.v1",
                    "nonce": frame["nonce"], "api_instance_id": owner["api_instance_id"]}
                assert_mutation_frozen()
            checks.append("private-held-confirmation-keeps-mutation-admission-frozen")
            time.sleep(2.2)  # Prove the held guard exceeds the initial frame timeout.
            assert_mutation_frozen()
            checks.append("private-acquisition-remains-frozen-beyond-initial-frame-timeout")
            rejected_body_transport()
            abort = exchange(stream, {**frame, "command": "abort"})
            assert abort["schema"] == "fullmag.development-api-abort.v1" and abort["nonce"] == frame["nonce"]
        checks.append("private-acquisition-freezes-and-abort-reopens-admission")
        # A foreign confirmation cannot acknowledge or retain this acquisition.
        with connect() as stream:
            acquired = exchange(stream, frame)
            assert acquired["schema"] == "fullmag.development-authoring-acquisition.v1"
            rejected = exchange(stream, {**frame, "command": "confirm", "nonce": str(uuid.uuid4())})
            assert rejected == {"schema": "fullmag.development-api-control.v1",
                "status": "rejected", "reason": "development_owner_request_rejected"}
        checks.append("private-confirmation-foreign-nonce-rejected")
        # A disconnected owner must never leave the active model frozen.
        with connect() as stream:
            acquired = exchange(stream, {**frame, "nonce": str(uuid.uuid4())})
            assert acquired["schema"] == "fullmag.development-authoring-acquisition.v1"
            assert_mutation_frozen()
        deadline = time.monotonic() + 5
        while True:
            try:
                if expected_scene is None:
                    code, _, _ = get("/v2/sessions", method="POST", payload={"name": "After disconnect",
                        "backend": "fdm", "device": "cpu", "precision": "double"})
                    assert code == 201
                else:
                    code, _, canonical = get("/v2/sessions/current/model/scene")
                    code, _, _ = get("/v2/sessions/current/model/scene", method="PUT", payload=canonical)
                    assert code == 200
                break
            except urllib.error.HTTPError as error:
                assert error.code == 409 and time.monotonic() < deadline
                time.sleep(0.05)
        checks.append("private-acquisition-disconnect-reopens-admission")

    for label, configuration in (
        ("owner-nonmanaged", {"FULLMAG_DEVELOPMENT_OWNER_TOKEN": owner_token}),
        ("owner-invalid-token", {**configured, "FULLMAG_DEVELOPMENT_OWNER_TOKEN": "invalid"}),
    ):
        with_api(label, configuration, None, reject_startup=True)
    with_api("owner-empty", {**configured, "FULLMAG_DEVELOPMENT_OWNER_TOKEN": owner_token}, private_acquisition)
    with_api("owner-restored", {**restore_config, "FULLMAG_DEVELOPMENT_OWNER_TOKEN": owner_token},
             lambda get: private_acquisition(get, restored_scene), restore_input=json.dumps(restore_envelope).encode())

    def restored(get):
        code, _, current = get("/v2/sessions/current")
        assert code == 200 and current["session_id"] not in {"old-session-fixture", "stable-model-fixture"}, current
        checks.append("prelisten-fresh-session-identity")
        assert "development_restored_authoring" not in json.dumps(current), current
        checks.append("prelisten-private-restore-provenance-is-not-exported")
        code, _, document = get("/v2/sessions/current/model/scene")
        assert code == 200 and document["scene"]["id"] == "stable-model-fixture", document
        assert document["revision"] == 17, document
        assert document["study"]["requested_device"] == "gpu", document
        assert document["study"]["requested_backend"] == "auto", document
        assert document["study"]["requested_precision"] == "single", document
        assert document["study"]["requested_mode"] == "extended", document
        assert document["study"]["requested_cpu_threads"] == 3, document
        checks.append("prelisten-canonical-intent-preserved")
        assert document["objects"][0]["id"] == "body-fixture", document
        assert document["objects"][0]["geometry"]["geometry_params"]["size"] == [1e-6, 1e-6, 1e-8], document
        assert document["editor"]["selected_object_id"] == "body-fixture", document
        assert document["editor"]["gizmo_mode"] == "rotate", document
        checks.append("prelisten-incomplete-geometry-and-editor-preserved")
        code, _, status_body = get("/v2/sessions/current/status")
        assert code == 200 and status_body["run"] is None, status_body
        assert status_body["session"]["request_scope_epoch"].endswith(":1"), status_body
        assert status_body["lifecycle"]["solver"] == "awaiting_command", status_body
        checks.append("prelisten-new-request-scope-and-idle-state")
        for path in ("/v2/sessions/current/simulation/runs/current", "/v2/sessions/current/simulation/preparation"):
            try:
                get(path)
            except urllib.error.HTTPError as error:
                assert error.code == 404, (path, error.code)
            else:
                raise AssertionError("Restore unexpectedly retained historical execution")
        checks.append("prelisten-no-historical-run-or-preparation")
        document["scene"]["name"] = "Edited restored model"
        code, _, edited = get("/v2/sessions/current/model/scene", method="PUT", payload=document)
        assert code == 200 and edited["revision"] == 18, edited
        assert edited["scene"]["name"] == "Edited restored model", edited
        checks.append("prelisten-restored-authoring-is-editable")

    with_api("restored", restore_config, restored, restore_input=json.dumps(restore_envelope).encode())
    for label, config, envelope in (
        ("restore-nonmanaged", {"FULLMAG_DEVELOPMENT_RESTORE_STDIN": "1"}, restore_envelope),
        ("restore-wrong-target", restore_config, {**restore_envelope, "target_source_sha256": "b" * 64}),
        ("restore-invalid-scene", restore_config, {**restore_envelope, "scene_document": {**restored_scene, "version": "unknown"}}),
    ):
        with_api(label, config, None, restore_input=json.dumps(envelope).encode(), reject_startup=True)
    with_api("restore-empty-input", restore_config, None, restore_input=b"", reject_startup=True)
    with_api("restore-stalled-input", restore_config, None, reject_startup=True, hold_input_open=True)
    with_api("restore-oversize-input", restore_config, None,
             restore_input=b" " * (64 * 1024 * 1024 + 1), reject_startup=True)

    def managed(get):
        frame()
        _, etag, body = get()
        check("waiting", body, "waiting", "build_pending")
        frame(updated_unix_ms=int(time.time() * 1000) + 1)
        assert get(etag=etag)[0] == 304
        checks.append("heartbeat-stable-etag")
        frame("building")
        changed_status, changed_etag, _ = get(etag=etag)
        assert changed_status == 200 and changed_etag != etag
        checks.append("state-change-invalidates-etag")
        for state, reason in (("building", "build_pending"), ("failed", "build_failed"), ("superseded", "build_pending"), ("stopped", "watcher_stopped")):
            frame(state)
            check(state, get()[2], state, reason)
        frame("ready", ready_build_id="b" * 64, ready_source_sha256=source)
        check("ready-with-restart-blocked", get()[2], "ready", "restart_integration_pending")
        assert get()[2]["ready_build"]["source_sha256"] == source
        for name, change in (("wrong-generation", {"generation_id": "2" * 32}), ("wrong-worktree", {"worktree_id": "other"}), ("unexpected-private-field", {"host_path": "secret"}), ("invalid-source", {"source_sha256": "bad"})):
            frame(**change)
            check(name, get()[2], "unknown", "observation_invalid")
        frame("ready", ready_build_id="b" * 64, ready_source_sha256="c" * 64)
        check("candidate-source-mismatch", get()[2], "unknown", "observation_invalid")
        for label, delta in (("stale", -20_000), ("future", 20_000)):
            frame(updated_unix_ms=int(time.time() * 1000) + delta)
            check(label, get()[2], "unknown", "observation_stale")
        status.write_bytes(b"x" * 8193)
        check("oversized-file", get()[2], "unknown", "observation_unavailable")
        status.unlink()  # Only this run's disposable fixture, never live watcher metadata.
        check("missing-file", get()[2], "unknown", "observation_unavailable")
        frame()
        _, _, spec = get("openapi.json")
        assert "/v2/platform/development-backend" in spec["paths"]
        identity = spec["x-fullmag-build-identity"]
        assert identity["git_commit"] == receipt["build_commit"]
        assert identity["source_snapshot_sha256"] == receipt["build_snapshot_sha256"]
        storage.atomic_json(run_root / "openapi-v2.json", spec)
        receipt["openapi_sha256"] = hashlib.sha256((run_root / "openapi-v2.json").read_bytes()).hexdigest()
        checks.append("generated-openapi-resource")
    frame()
    with_api("managed", configured, managed)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    args = parser.parse_args()
    try:
        raise SystemExit(run(args.repo_root))
    except Exception as error:
        print(f"Native development resource verification failed: {error}", file=sys.stderr)
        raise SystemExit(2)
