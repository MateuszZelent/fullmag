"""Verify development observation and terminal drain in owned empty processes."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
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
        api = run_root / "fullmag-api.exe"
        receipt_path = run_root / "receipt.json"
        receipt = {"schema": "fullmag.development-backend-api-checks.v1", "state": "running",
                   "head": storage.git(repo, "rev-parse", "HEAD"), "task_id": owner["task_id"],
                   "owner": owner["owner"], "source_sha256": source_before,
                   "verified_build_id": verified["ready_build_id"], "api_sha256": manifest["api_binary_sha256"],
                   "verifier_sha256": verifier_hash,
                   "build_snapshot_sha256": manifest["source_snapshot_sha256"],
                   "build_commit": manifest["git_commit"],
                   "started_at": storage.now(), "checks": [], "processes": [],
                   "scope": "native resource observation, open mutation admission and empty-service terminal drain; no workspace freeze, restart, solver or release qualification"}
        storage.atomic_json(receipt_path, receipt)
        code = 1
        try:
            shutil.copyfile(source_api, api)
            binary_hash = hashlib.sha256(api.read_bytes()).hexdigest()
            if binary_hash != manifest["api_binary_sha256"] or hashlib.sha256(source_api.read_bytes()).hexdigest() != binary_hash:
                raise storage.StorageError("Native API changed while sealing its diagnostic copy")
            exercise(api, repo, run_root, receipt)
            exercise_service(repo, run_root, manifest, receipt)
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
            raise
        finally:
            receipt.update(state="completed" if code == 0 else "failed", exit_code=code, finished_at=storage.now())
            storage.atomic_json(receipt_path, receipt)
            print(json.dumps({"state": receipt["state"], "exit_code": code, "checks": len(receipt["checks"]), "receipt": str(receipt_path)}))
        return code


def exercise_service(repo: Path, run_root: Path, manifest: dict, receipt: dict) -> None:
    """Exercise only this verifier's initialized empty store and sealed binaries."""
    from windows.runtime_bundle import BINARY_NAMES

    binaries = run_root / "service-binaries"
    binaries.mkdir()
    source_root = Path(manifest["cargo_target_dir"]) / manifest["target_triple"] / manifest["compiler_profile"]
    for name in BINARY_NAMES:
        source = storage.validate_path(source_root / name, manifest["cargo_target_dir"], "native service executable")
        expected = manifest["executable_sha256"][name]
        shutil.copyfile(source, binaries / name)
        if (hashlib.sha256(source.read_bytes()).hexdigest() != expected
                or hashlib.sha256((binaries / name).read_bytes()).hexdigest() != expected):
            raise storage.StorageError("Native service executable changed while sealing")

    state_root = run_root / "service-state"
    store = state_root / "local-live/session-store"
    project = store / "project"
    project.mkdir(parents=True)
    # Production CLI initializes the store. The fixture has no accepted runs.
    (project / "main.py").write_text("# Empty development drain fixture\n", encoding="utf-8")
    env = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "COMPUTERNAME", "HOSTNAME") if key in os.environ}
    env.update(FULLMAG_REPO_ROOT=str(repo), FULLMAG_STATE_ROOT=str(state_root))
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
            receipt["checks"].append("empty-service-ready-source-identity")
            denied = control("drain_confirmed", str(uuid.uuid4()), "unauthorized")
            assert denied.get("status") == "rejected", denied
            receipt["checks"].append("wrong-owner-cannot-drain-empty-service")
            denied = control("drain_confirmed", owner["owner_token"], "invalid challenge")
            assert denied.get("status") == "rejected", denied
            receipt["checks"].append("invalid-challenge-cannot-drain-empty-service")
            challenge = uuid.uuid4().hex
            observed = control("status", owner["owner_token"], challenge)
            assert observed["nonce"] == challenge and observed["configuration"] == config
            assert observed["owner"]["state"] == "ready"
            receipt["checks"].append("rejected-drain-leaves-service-ready")
            challenge = uuid.uuid4().hex
            terminal = control("drain_confirmed", owner["owner_token"], challenge)
            assert terminal["schema_version"] == "runtime_service_drain.v1"
            assert terminal["nonce"] == challenge and terminal["configuration"] == config
            drained = terminal["owner"]
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
            # A failed fixture remains recorded; only authenticated graceful drain
            # is attempted for this exact child and its own store.
            if child.poll() is None and owner is not None and owner.get("pid") == child.pid:
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

    def with_api(label, config, callback):
        # Only this route's child can be stopped. It never accepts computation.
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        env = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP") if key in os.environ}
        env.update(FULLMAG_REPO_ROOT=str(repo), FULLMAG_STATE_ROOT=str(run_root / (label + "-state")), FULLMAG_API_PORT=str(port), FULLMAG_DISABLE_STATIC_CONTROL_ROOM="1")
        env.update(config)
        log_path = run_root / (label + ".log")
        with log_path.open("w", encoding="utf-8") as log:
            child = subprocess.Popen([str(api)], cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
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
                callback(get)
            finally:
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
