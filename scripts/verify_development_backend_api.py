"""Verify the development resource with an owned, empty native API process."""
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
                   "scope": "native resource observation and open mutation admission; no UI, freeze, restart, solver or release qualification"}
        storage.atomic_json(receipt_path, receipt)
        code = 1
        try:
            shutil.copyfile(source_api, api)
            binary_hash = hashlib.sha256(api.read_bytes()).hexdigest()
            if binary_hash != manifest["api_binary_sha256"] or hashlib.sha256(source_api.read_bytes()).hexdigest() != binary_hash:
                raise storage.StorageError("Native API changed while sealing its diagnostic copy")
            exercise(api, repo, run_root, receipt)
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
