"""Owned native/browser restart proof; every v2 request reaches the real API.

The private eligibility bridge does not change the public capability. Native
custody and browser hydration are independent requirements for a passing run.
"""
from __future__ import annotations

import hashlib
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import queue
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import fullmag_storage as storage
from windows import runtime_bundle
from windows.development_status import DevelopmentStatusPublisher, StatusHeartbeat, verified_build_identity
from windows.verify_consumer_pump import BUNDLE_ID_RE, SHA256_RE, _restore_diagnostic_status
from windows.stage_workspace_frontend import stage_workspace_frontend
from verify_pinned_dataset_browser import link_directory, stop_owned_process


WEB_PORT = 3258
MAX_FRAME = 128 * 1024
MAX_LOG = 2 * 1024 * 1024
READY_SCHEMA = "fullmag.development-browser-native-ready.v1"
RESULT_SCHEMA = "fullmag.development-browser-native-result.v1"
API_LOG_SCHEMA = "fullmag.development-browser-api-log.v1"


def utc_ms():
    if os.name != "nt":
        return time.time_ns() // 1_000_000
    # Use the same precise Windows clock as Rust SystemTime. Do not extend
    # the lease to compensate for a lower-resolution observer clock.
    read_clock = ctypes.WinDLL("kernel32").GetSystemTimePreciseAsFileTime
    read_clock.argtypes = [ctypes.POINTER(wintypes.FILETIME)]
    read_clock.restype = None
    value = wintypes.FILETIME()
    read_clock(ctypes.byref(value))
    ticks = (value.dwHighDateTime << 32) | value.dwLowDateTime
    return (ticks - 116444736000000000) // 10_000


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def valid_uuid(value):
    try:
        parsed = uuid.UUID(value)
        return parsed.int != 0 and str(parsed) == value
    except (ValueError, TypeError, AttributeError):
        return False


def validate_ready(frame, expected, now_ms, *, allow_expired=False):
    fields = {"schema", "api_instance_id", "worktree_id", "generation_id",
              "ready_build_id", "ready_source_sha256", "ui_origin", "nonce",
              "observed_at_unix_ms", "valid_until_unix_ms"}
    if not isinstance(frame, dict) or set(frame) != fields or frame.get("schema") != READY_SCHEMA:
        raise storage.StorageError("Private native readiness has an invalid shape")
    for key, value in expected.items():
        if frame.get(key) != value:
            raise storage.StorageError(f"Private native readiness differs at {key}")
    start, end = frame["observed_at_unix_ms"], frame["valid_until_unix_ms"]
    if (not valid_uuid(frame["api_instance_id"])
            or type(start) is not int or type(end) is not int
            or start <= 0 or not 0 < end - start <= 1000 or now_ms < start
            or (not allow_expired and now_ms >= end)):
        raise storage.StorageError(f"Private native readiness is expired or unconfirmed: now={now_ms}, observed={start}, until={end}")
    return dict(frame)


def terminal_record(value):
    if (not isinstance(value, dict) or set(value) != {"pid", "waited", "exit_code"}
            or type(value.get("pid")) is not int or value["pid"] <= 0
            or value.get("waited") is not True or type(value.get("exit_code")) is not int):
        raise storage.StorageError("Native browser proof lacks terminal process custody")
    return dict(value)


def read_api(port, pin, path):
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}",
                                     headers={"x-fullmag-api-instance": pin})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=5) as response:
        raw = response.read(MAX_FRAME + 1)
        if len(raw) > MAX_FRAME or response.headers.get("x-fullmag-api-instance") != pin:
            raise storage.StorageError("Browser proof API response is oversized or has a different pin")
        return json.loads(raw)


def read_session_scope(api_port, api_instance_id, identity):
    status = read_api(api_port, api_instance_id, "/v2/sessions/current/status")
    session = status.get("session")
    if (not isinstance(session, dict)
            or session.get("session_id") != identity.get("session_id")
            or not isinstance(session.get("session_epoch"), str)
            or not session["session_epoch"]
            or type(identity.get("session_epoch")) is not int
            or identity["session_epoch"] < 0
            or session.get("request_scope_epoch") != f"{api_instance_id}:{identity['session_epoch']}"):
        raise storage.StorageError("Session resource scope is not bound to the actual API owner")
    return {"session_resource_epoch": session["session_epoch"],
            "request_scope_epoch": session["request_scope_epoch"]}


def record_started_frame(frame, api_records, helper_records, receipt):
    schema = frame.get("schema")
    if schema == "fullmag.development-cli-owner-progress.v1":
        records, key, label = api_records, "api_pid", "browser-owned-api"
    elif schema == "fullmag.development-cli-candidate-preparation-progress.v1":
        records, key, label = helper_records, "helper_pid", "browser-candidate-helper"
    else:
        return False
    pid = frame.get(key)
    if type(pid) is not int or pid <= 0:
        receipt["workspace_browser_progress_error"] = "invalid started-process PID"
        raise storage.StorageError("Native browser progress has an invalid PID")
    if pid not in records:
        records[pid] = {"label": label, "pid": pid, "waited": False, "outcome": "unknown"}
        receipt["processes"].append(records[pid])
    return True


def record_api_log_frame(frame, expected, state_root, api_records, receipt):
    pid = frame.get("api_pid")
    file_name = frame.get("file_name")
    if (set(frame) != {"schema", "nonce", "api_pid", "api_instance_id", "file_name"}
            or frame.get("schema") != API_LOG_SCHEMA or frame.get("nonce") != expected["nonce"]
            or type(pid) is not int or pid not in api_records
            or not valid_uuid(frame.get("api_instance_id")) or not isinstance(file_name, str)):
        raise storage.StorageError("Browser API log metadata has a different owner scope")
    if not re.fullmatch(r"browser-workspace-api-[0-9a-f]{32}\.log", file_name):
        raise storage.StorageError("Browser API log is outside its private state root")
    candidate = state_root / file_name
    candidate = storage.validate_path(candidate, state_root, "browser-owned API log")
    runtime_bundle._require_regular_file(candidate, "browser-owned API log", nonempty=False)
    evidence = {"pid": pid, "api_instance_id": frame["api_instance_id"], "path": str(candidate)}
    logs = receipt.setdefault("workspace_browser_api_logs", [])
    existing = next((item for item in logs if item["pid"] == pid), None)
    if existing is not None and existing != evidence:
        raise storage.StorageError("Browser API log metadata changed for the same process")
    if existing is None:
        logs.append(evidence)


def terminal_custody(api_records, helper_records):
    return bool(api_records) and all(
        record.get("waited") is True and type(record.get("exit_code")) is int
        for record in [*api_records.values(), *helper_records.values()])


def validate_result_frame(frame, nonce):
    fields = {"schema", "nonce", "status", "old_api_pid", "old_api_instance_id", "new_api_pid",
              "new_api_instance_id", "old_api_exit_code", "new_api_exit_code", "helper_processes"}
    if (set(frame) != fields or frame.get("schema") != RESULT_SCHEMA or frame.get("nonce") != nonce
            or frame.get("status") not in {"passed", "failed", "unknown"}):
        raise storage.StorageError("Native browser result does not match its pinned contract")
    for prefix in ("old", "new"):
        pid, pin, code = (frame[f"{prefix}_api_pid"], frame[f"{prefix}_api_instance_id"],
                          frame[f"{prefix}_api_exit_code"])
        if prefix == "new" and frame["status"] != "passed" and pid is None and pin is None and code is None:
            continue
        if (type(pid) is not int or pid <= 0 or not valid_uuid(pin)
                or (type(code) is not int and not (frame["status"] == "unknown" and code is None))):
            raise storage.StorageError("Native browser result has unconfirmed API custody")
    helpers = frame["helper_processes"]
    if not isinstance(helpers, list) or not helpers:
        raise storage.StorageError("Native browser result has no helper custody")
    pids = [terminal_record(item)["pid"] for item in helpers]
    if len(set(pids)) != len(pids):
        raise storage.StorageError("Native browser result duplicated helper custody")


class ProofBridge:
    def __init__(self, expected, api_port, frames, process):
        self.expected, self.api_port = expected, api_port
        self.frames, self.process = frames, process
        self.lock = threading.RLock()
        self.ready = None
        self.restored = None
        self.before = None
        self.browser = None
        self.error = None
        self.finished = threading.Event()

    def eligibility(self):
        with self.lock:
            if self.process.poll() is not None or self.ready is None:
                raise storage.StorageError("Native browser owner is not ready")
            return validate_ready(self.ready, self.expected, utc_ms())

    def capture_before(self, body):
        proof = self.eligibility()
        if (set(body) != {"schema", "nonce", "api_instance_id", "project_document_before"}
                or body["schema"] != "fullmag.development-browser-before.v1"
                or body["nonce"] != self.expected["nonce"]
                or body["api_instance_id"] != proof["api_instance_id"]
                or not isinstance(body["project_document_before"], dict)
                or not body["project_document_before"]):
            raise storage.StorageError("Browser before-capture has a different scope or empty draft")
        scene = read_api(self.api_port, proof["api_instance_id"], "/v2/sessions/current/model/scene")
        objects = scene.get("objects")
        if not isinstance(objects, list) or not objects:
            raise storage.StorageError("Browser proof requires a nonempty canonical scene")
        backend = read_api(self.api_port, proof["api_instance_id"], "/v2/platform/development-backend")
        identity = backend.get("workspace_identity")
        if (not isinstance(identity, dict) or identity.get("api_instance_id") != proof["api_instance_id"]
                or not isinstance(identity.get("session_id"), str)
                or type(identity.get("session_epoch")) is not int):
            raise storage.StorageError("Nonempty browser scene has no exact workspace identity")
        session_scope = read_session_scope(self.api_port, proof["api_instance_id"], identity)
        with self.lock:
            if self.before is not None:
                raise storage.StorageError("Browser before-capture is immutable")
            self.before = {**body, "scene": scene, "identity": identity, "session_scope": session_scope}
        return {"captured": True, "object_count": len(objects),
                "scene_sha256": hashlib.sha256(canonical(scene).encode()).hexdigest()}

    def finish(self, body):
        with self.lock:
            before, restored = self.before, self.restored
        fields = {"schema", "nonce", "new_api_instance_id", "project_document_before", "project_document_after"}
        if (set(body) != fields or body.get("schema") != "fullmag.development-browser-finish.v1"
                or body.get("nonce") != self.expected["nonce"] or before is None or restored is None
                or body.get("new_api_instance_id") != restored.get("new_api_instance_id")
                or body["new_api_instance_id"] == before["api_instance_id"]
                or canonical(body["project_document_before"]) != canonical(before["project_document_before"])
                or canonical(body["project_document_after"]) != canonical(before["project_document_before"])):
            raise storage.StorageError("Browser hydration does not preserve the captured draft and new pin")
        scene = read_api(self.api_port, body["new_api_instance_id"], "/v2/sessions/current/model/scene")
        backend = read_api(self.api_port, body["new_api_instance_id"], "/v2/platform/development-backend")
        identity = backend.get("workspace_identity", {})
        if (canonical(scene) != canonical(before["scene"])
                or identity.get("api_instance_id") != body["new_api_instance_id"]
                or not isinstance(identity.get("session_id"), str)
                or identity["session_id"] == before["identity"]["session_id"]
                or identity.get("session_epoch") != 1):
            raise storage.StorageError("Native restart changed the scene or failed to establish the fresh session")
        session_scope = read_session_scope(self.api_port, body["new_api_instance_id"], identity)
        if (session_scope["request_scope_epoch"] == before["session_scope"]["request_scope_epoch"]
                or session_scope["session_resource_epoch"] == before["session_scope"]["session_resource_epoch"]):
            raise storage.StorageError("Native restart reused the old session resource scope")
        command = {"schema": "fullmag.development-browser-native-command.v1", "event": "finish",
                   "nonce": self.expected["nonce"], "new_api_instance_id": body["new_api_instance_id"]}
        with self.lock:
            if self.browser is not None:
                raise storage.StorageError("Browser finish has already been submitted")
            self.browser = {**body, "scene_sha256": hashlib.sha256(canonical(scene).encode()).hexdigest(),
                            "identity": identity, "session_scope": session_scope}
            self.process.stdin.write((canonical(command) + "\n").encode())
            self.process.stdin.flush()
            self.finished.set()
        return {"verified": True}


def bridge_handler(bridge):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send_json(self, code, value):
            raw = canonical(value).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            try:
                if self.path != "/eligibility":
                    raise storage.StorageError("Unknown private proof resource")
                self.send_json(200, bridge.eligibility())
            except Exception as error:
                self.send_json(409, {"error": str(error)})

        def do_POST(self):
            try:
                if self.headers.get("Origin") != bridge.expected["ui_origin"]:
                    raise storage.StorageError("Private browser command has a different origin")
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= MAX_FRAME:
                    raise storage.StorageError("Private browser command exceeds its byte limit")
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict):
                    raise storage.StorageError("Private browser command is not an object")
                method = {"/before": bridge.capture_before, "/finish": bridge.finish}.get(self.path)
                if method is None:
                    raise storage.StorageError("Unknown private browser command")
                self.send_json(200, method(body))
            except Exception as error:
                self.send_json(409, {"error": str(error)})
    return Handler


class NativeFrames:
    """Bound the entire observation stream, not just individual JSON frames."""
    def __init__(self, process, path):
        self.process, self.path = process, path
        self.items = queue.Queue(maxsize=2048)
        self.error = None
        self.done = threading.Event()
        self.thread = threading.Thread(target=self._read, daemon=True)

    def _read(self):
        total = 0
        try:
            with self.path.open("xb") as log:
                while line := self.process.stdout.readline(MAX_FRAME + 1):
                    total += len(line)
                    if len(line) > MAX_FRAME or total > MAX_LOG:
                        raise storage.StorageError("Native browser stream exceeded its observation limit")
                    log.write(line)
                    log.flush()
                    if line.startswith(b"{"):
                        if not line.endswith(b"\n"):
                            raise storage.StorageError("Native browser JSON frame is incomplete")
                        frame = json.loads(line)
                        if not isinstance(frame, dict):
                            raise storage.StorageError("Native browser frame is not an object")
                        self.items.put_nowait(frame)
        except Exception as error:
            self.error = error
        finally:
            self.done.set()


def free_port():
    with socket.socket() as handle:
        handle.bind(("127.0.0.1", 0))
        return handle.getsockname()[1]


def configure_fixture(repo, run_root, manifest, receipt, owner_bundle):
    if not BUNDLE_ID_RE.fullmatch(owner_bundle):
        raise storage.StorageError("Browser proof requires a canonical owner bundle ID")
    native = storage.resolve_layout(repo, "windows-native-fdm-cpu-dev")
    checks = storage.resolve_layout(repo, "development-backend-api-checks")
    storage_root, runtime_root = Path(native["storage_root"]), Path(native["runtime_root"])
    build_root = Path(native["build_root"])
    manifest_path = build_root / "windows-runtime/build-manifest.json"
    raw_manifest = manifest_path.read_bytes()
    identity = verified_build_identity(build_root, runtime_root, manifest_path, None)
    if (identity["ready_build_id"] != receipt["verified_build_id"]
            or hashlib.sha256(raw_manifest).hexdigest() != identity["ready_build_id"]
            or json.loads(raw_manifest) != manifest):
        raise storage.StorageError("Browser proof B manifest changed after admission")
    owner_root = storage.validate_path(runtime_root / "native-bundles" / owner_bundle,
                                       storage_root, "browser proof A bundle")
    owner_bytes = (owner_root / "manifest.json").read_bytes()
    if len(owner_bytes) > MAX_FRAME:
        raise storage.StorageError("Browser owner manifest exceeds its byte limit")
    owner, file_hashes = runtime_bundle.validate_bundle(owner_root, runtime_root, "dev")
    source = owner.get("source", {})
    if (source.get("workspace_namespace") != native["worktree_id"]
            or source.get("backend_source_sha256") == identity["ready_source_sha256"]
            or source.get("manifest_sha256") == identity["ready_build_id"]
            or not SHA256_RE.fullmatch(str(source.get("backend_source_sha256", "")))
            or (owner_root / "manifest.json").read_bytes() != owner_bytes):
        raise storage.StorageError("Browser proof A is not a distinct verified stable package")
    fixture = run_root / "workspace-browser-fixture"
    fixture.mkdir(exist_ok=False)
    state_root = fixture / "state"
    state_root.mkdir()
    status = storage.validate_path(Path(checks["build_root"]) / "backend-watch-status.json",
                                   storage_root, "private browser diagnostic status")
    if status == Path(native["build_root"]) / "backend-watch-status.json":
        raise storage.StorageError("Browser diagnostic status aliases the active native watcher")
    if os.path.lexists(status) and (status.is_symlink() or not status.is_file()):
        raise storage.StorageError("Browser diagnostic status is not a regular file")
    prior = status.read_bytes() if status.exists() else None
    generation, scope, nonce = uuid.uuid4().hex, str(uuid.uuid4()), str(uuid.uuid4())
    accepted = Path(native["runs_root"]) / "workspaces" / scope / "session-store"
    if os.path.lexists(accepted.parent):
        raise storage.StorageError("Browser accepted-store scope already exists")
    api_port = free_port()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", WEB_PORT))
    expected = {"worktree_id": native["worktree_id"], "generation_id": generation,
                "ready_build_id": identity["ready_build_id"],
                "ready_source_sha256": identity["ready_source_sha256"],
                "ui_origin": f"http://localhost:{WEB_PORT}", "nonce": nonce}
    request = {"schema": "fullmag.development-browser-native-input.v1",
               "owner_bundle_id": owner_bundle,
               "owner_manifest_sha256": hashlib.sha256(owner_bytes).hexdigest(),
               "owner_source_sha256": source["backend_source_sha256"],
               "ready_build_id": expected["ready_build_id"],
               "ready_source_sha256": expected["ready_source_sha256"],
               "web_port": WEB_PORT, "nonce": nonce}
    base_env = {key: os.environ[key] for key in
                ("SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "COMPUTERNAME")
                if key in os.environ}
    env = {**base_env, "FULLMAG_REPO_ROOT": str(repo), "FULLMAG_DEVELOPMENT_OWNER_PROBE": "1",
           "FULLMAG_NATIVE_RUNTIME_ACTIVE": "1", "FULLMAG_STORAGE_PROFILE": "windows-native-fdm-cpu-dev",
           "FULLMAG_PROJECT_STORAGE_ROOT": str(storage_root), "FULLMAG_WORKTREE_ID": native["worktree_id"],
           "FULLMAG_RUNS_ROOT": native["runs_root"], "FULLMAG_PYTHON": str(build_root / "python/fullmag/Scripts/python.exe"),
           "FULLMAG_STATE_ROOT": str(state_root), "FULLMAG_STATE_DIR": str(state_root),
           "FULLMAG_API_PORT": str(api_port),
           "FULLMAG_ACCEPTED_STORE_SCOPE": scope, "FULLMAG_DEVELOPMENT_BACKEND_GENERATION": generation,
           "FULLMAG_DEVELOPMENT_BACKEND_SOURCE": expected["ready_source_sha256"],
           "FULLMAG_DEVELOPMENT_BACKEND_VERSION": manifest["build_version"]["product_version"],
           "FULLMAG_DEVELOPMENT_BACKEND_STATUS_FILE": str(status),
           "FULLMAG_DEVELOPMENT_RESTART_PROBE_CASE": "browser-workspace"}
    receipt["workspace_browser_fixture"] = {**expected, "api_port": api_port,
        "accepted_store_scope": scope, "accepted_store_root": str(accepted),
        "owner_bundle_id": owner_bundle, "owner_files": file_hashes,
        "owner_manifest_sha256": request["owner_manifest_sha256"]}
    return native, fixture, status, prior, expected, request, env


def stage_diagnostic_page(repo, app, fixture):
    """Seal the calling checkout's diagnostic page separately from product sources."""
    source = Path(repo) / "apps/control-room/scripts/fixtures/native-workspace-restart-page.tsx"
    # Check the lexical path before resolving containment: resolving first
    # would hide a symlink or junction in the source chain.
    before = runtime_bundle._require_regular_file(source, "current diagnostic page", nonempty=True)
    source = storage.validate_path(source, repo, "current diagnostic page")
    if before.st_size > 256 * 1024:
        raise storage.StorageError("Current diagnostic page exceeds its byte limit")
    with source.open("rb") as input_file:
        captured = input_file.read(256 * 1024 + 1)
    if not captured or len(captured) > 256 * 1024:
        raise storage.StorageError("Current diagnostic page has an invalid captured size")
    digest = hashlib.sha256(captured).hexdigest()
    snapshot = fixture / "diagnostic-page-source.tsx"
    runtime_bundle._check_path_chain(snapshot.parent, "diagnostic snapshot directory")
    with snapshot.open("xb") as output:
        output.write(captured)
    page = app / "app/native-browser-proof/page.tsx"
    if os.path.lexists(page):
        raise storage.StorageError("Browser proof cannot overwrite a product route")
    page.parent.mkdir(parents=True, exist_ok=False)
    runtime_bundle._check_path_chain(page.parent, "diagnostic route directory")
    shutil.copyfile(snapshot, page)
    after = runtime_bundle._require_regular_file(source, "current diagnostic page", nonempty=True)
    runtime_bundle._require_regular_file(snapshot, "diagnostic page snapshot", nonempty=True)
    runtime_bundle._require_regular_file(page, "staged diagnostic page", nonempty=True)
    stable_stat = lambda value: (value.st_dev, value.st_ino, value.st_size,
                                 value.st_mtime_ns, value.st_ctime_ns)
    if (source.read_bytes() != captured or stable_stat(before) != stable_stat(after)
            or hashlib.sha256(snapshot.read_bytes()).hexdigest() != digest
            or hashlib.sha256(page.read_bytes()).hexdigest() != digest):
        raise storage.StorageError("Diagnostic page changed during capture or staging")
    return page, {"source_path": str(source), "snapshot_path": str(snapshot),
                  "source_sha256": digest, "staged_route_path": str(page),
                  "staged_route_sha256": digest}


def start_frontend(repo, native, fixture, manifest, bridge_url, api_port, receipt):
    snapshot = manifest["build_source_snapshot"]
    source_root = storage.validate_path(snapshot["source_root"], native["build_root"], "frozen frontend sources")
    # The same immutable snapshot used to compile B supplies the real UI code.
    stage = stage_workspace_frontend(source_root, native["build_root"], mode="static",
                                     source_snapshot_record=snapshot["record_path"])
    app, front = Path(stage["app_root"]), Path(stage["frontend_root"])
    dependencies = storage.validate_path(Path(manifest["frontend_workspace_root"]) / "apps/control-room/node_modules",
                                         native["build_root"], "existing frozen frontend dependencies")
    node = shutil.which("node")
    next_cli = dependencies / "next/dist/bin/next"
    if not node or not next_cli.is_file():
        raise storage.StorageError("Browser proof needs existing verified Node/Next dependencies")
    for required in ("typescript/bin/tsc", "@types/node/index.d.ts", "@types/react/index.d.ts"):
        if not (dependencies / required).is_file():
            raise storage.StorageError(f"Frozen frontend dependencies are incomplete: {required}; no automatic install")
    page, diagnostic = stage_diagnostic_page(repo, app, fixture)
    receipt["workspace_browser_diagnostic_page"] = diagnostic
    api_route = app / "app/native-browser-probe/[operation]/route.ts"
    api_route.parent.mkdir(parents=True, exist_ok=False)
    api_route.write_text(
        'import { NextRequest } from "next/server";\n'
        'const bridge = ' + json.dumps(bridge_url) + ';\n'
        'async function forward(request: NextRequest, context: {params: Promise<{operation: string}>}) {\n'
        ' const {operation} = await context.params;\n'
        ' if (!["eligibility","before","finish"].includes(operation)) return new Response(null,{status:404});\n'
        ' const response = await fetch(bridge+"/"+operation,{method:request.method,cache:"no-store",\n'
        ' headers:{"content-type":"application/json","origin":request.headers.get("origin")??""},\n'
        ' ...(request.method==="POST"?{body:await request.text()}:{} )});\n'
        ' return new Response(await response.arrayBuffer(),{status:response.status,headers:{"content-type":"application/json","cache-control":"no-store"}});\n'
        '}\nexport const GET=forward; export const POST=forward;\n', encoding="utf-8")
    link_directory(app / "node_modules", dependencies)
    link_directory(front / "node_modules", dependencies)
    root_deps = Path(manifest["frontend_workspace_root"]) / "node_modules"
    if root_deps.is_dir():
        link_directory(Path(stage["workspace_root"]) / "node_modules", root_deps)
    # The staging helper owns these links. Verify rather than recreate them.
    for link_name, target in ((".fullmag-frontend", front),
                              ("out", front / "out"),
                              (".next", front / "next/default")):
        if (app / link_name).resolve() != target.resolve():
            raise storage.StorageError(f"Staged frontend has a different managed link: {link_name}")
    dist = app / f".next-control-room-{WEB_PORT}"
    dist_target = front / f"next/dev-{WEB_PORT}"
    dist_target.mkdir(parents=True)
    link_directory(dist, dist_target)
    env = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP")
           if key in os.environ}
    env.update(FULLMAG_API_PROXY_TARGET=f"http://127.0.0.1:{api_port}",
               FULLMAG_FRONTEND_ROOT=str(front), FULLMAG_NEXT_DIST_DIR=dist.name,
               NEXT_TELEMETRY_DISABLED="1")
    log = (fixture / "next.log").open("wb")
    process = subprocess.Popen([node, str(next_cli), "dev", "--webpack", "--hostname", "127.0.0.1",
                                "--port", str(WEB_PORT)], cwd=app, env=env, stdout=log, stderr=subprocess.STDOUT,
                               creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
    receipt["workspace_browser_frontend"] = {"pid": process.pid, "waited": False,
        "source_manifest_sha256": stage["manifest_sha256"], "workspace_root": stage["workspace_root"],
        "product_source_root": str(source_root), "dependencies": str(dependencies),
        "test_route": str(page), "test_route_sha256": diagnostic["staged_route_sha256"]}
    return process, log


def check_frontend_sources(fixture, receipt):
    """Check the staged page against its actual dependency/type context."""
    staged = receipt["workspace_browser_frontend"]
    app = Path(staged["test_route"]).parents[2]
    dependencies = Path(staged["dependencies"])
    config = fixture / "tsconfig.browser-source.json"
    config.write_text(canonical({
        "extends": str(app / "tsconfig.json"),
        "compilerOptions": {"noEmit": True, "incremental": False,
                            "typeRoots": [str(dependencies / "@types")]},
        "files": [str(app / "next-env.d.ts"), staged["test_route"]],
        "include": [], "exclude": [str(app / "node_modules")],
    }), encoding="utf-8")
    deadline = time.monotonic() + 20
    while not (app / "next-env.d.ts").is_file():
        if time.monotonic() >= deadline:
            raise storage.StorageError("Next did not publish its staged TypeScript environment")
        time.sleep(0.1)
    node = shutil.which("node")
    commands = [
        ("typecheck", [node, str(dependencies / "typescript/bin/tsc"), "--noEmit", "--project", str(config)]),
        ("lint", [node, str(dependencies / "eslint/bin/eslint.js"), "--no-cache", staged["test_route"]]),
    ]
    checks = receipt.setdefault("workspace_browser_source_checks", [])
    for label, command in commands:
        log_path = fixture / (label + ".log")
        with log_path.open("xb") as log:
            child = subprocess.Popen(command, cwd=app, stdout=log, stderr=subprocess.STDOUT,
                                     creationflags=subprocess.CREATE_NO_WINDOW)
            record = {"label": "browser-source-" + label, "pid": child.pid, "waited": False}
            receipt["processes"].append(record)
            try:
                child.wait(timeout=60)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
                record.update(waited=True, exit_code=child.returncode)
                raise storage.StorageError(f"Staged frontend {label} exceeded its bounded check")
            record.update(waited=True, exit_code=child.returncode)
            checks.append({"check": label, "exit_code": child.returncode, "log": str(log_path)})
            if child.returncode:
                raise storage.StorageError(f"Staged frontend {label} failed; inspect {log_path}")


def exercise(repo, run_root, manifest, receipt, binaries, owner_bundle):
    native, fixture, status, prior, expected, request, env = configure_fixture(
        repo, run_root, manifest, receipt, owner_bundle)
    publisher = DevelopmentStatusPublisher(status, expected["generation_id"], expected["worktree_id"])
    heartbeat = None
    process = frontend = server = bridge = reader = None
    frontend_log = None
    native_error_log = None
    api_records = {}
    helper_records = {}
    terminal = False
    result_confirmed = False
    try:
        publisher.publish({"state": "ready", "source_sha256": expected["ready_source_sha256"],
                           "ready_build_id": expected["ready_build_id"],
                           "ready_source_sha256": expected["ready_source_sha256"]})
        heartbeat = StatusHeartbeat(publisher, interval_seconds=2).start()
        initializer_log = fixture / "initializer.log"
        with initializer_log.open("xb") as log:
            initializer = subprocess.Popen([str(binaries / "fullmag.exe"), "runtime", "initialize-scoped-accepted-store"],
                                           cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT,
                                           creationflags=subprocess.CREATE_NO_WINDOW)
            record = {"label": "browser-accepted-store-initializer", "pid": initializer.pid, "waited": False}
            receipt["processes"].append(record)
            try:
                initializer.wait(timeout=20)
            except subprocess.TimeoutExpired:
                # This owned command only initializes the fresh fixture store;
                # it never owns a browser or API process.
                initializer.kill()
                try:
                    initializer.wait(timeout=5)
                    record.update(waited=True, exit_code=initializer.returncode)
                except subprocess.TimeoutExpired:
                    record["outcome"] = "unknown after initializer stop request"
                raise
            record.update(waited=True, exit_code=initializer.returncode)
            if initializer.returncode != 0:
                raise storage.StorageError("Private browser accepted-store initialization failed")
        native_error_log = (fixture / "native.stderr.log").open("xb")
        process = subprocess.Popen([str(binaries / "fullmag.exe"), "runtime", "verify-development-restart-consumer"],
                                   cwd=repo, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=native_error_log, creationflags=subprocess.CREATE_NO_WINDOW)
        cli_record = {"label": "browser-native-cli", "pid": process.pid, "waited": False}
        receipt["processes"].append(cli_record)
        reader = NativeFrames(process, fixture / "native.log")
        bridge = ProofBridge(expected, int(env["FULLMAG_API_PORT"]), reader, process)
        server = ThreadingHTTPServer(("127.0.0.1", 0), bridge_handler(bridge))
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        reader.thread.start()
        process.stdin.write((canonical(request) + "\n").encode())
        process.stdin.flush()
        # Stage before opening the browser, from B's verified immutable sources.
        frontend, frontend_log = start_frontend(
            repo, native, fixture, manifest, f"http://127.0.0.1:{server.server_port}",
            bridge.api_port, receipt)
        check_frontend_sources(fixture, receipt)
        results = []
        deadline = time.monotonic() + 600
        announced = False
        while time.monotonic() < deadline:
            if reader.error is not None:
                raise storage.StorageError(f"Native browser observation failed: {reader.error}")
            try:
                frame = reader.items.get(timeout=0.2)
            except queue.Empty:
                frame = None
            if frame is not None:
                schema = frame.get("schema")
                if record_started_frame(frame, api_records, helper_records, receipt):
                    pass
                elif schema == API_LOG_SCHEMA:
                    try:
                        record_api_log_frame(frame, expected, fixture / "state", api_records, receipt)
                    except storage.StorageError:
                        receipt["workspace_browser_progress_error"] = "invalid API log metadata"
                        raise
                elif schema == READY_SCHEMA:
                    now_ms = utc_ms()
                    validated = validate_ready(frame, expected, now_ms, allow_expired=True)
                    # Staging the frozen frontend can outlast the first
                    # readiness heartbeat. An expired frame never grants
                    # eligibility, but is not evidence the live owner failed.
                    if now_ms >= validated["valid_until_unix_ms"]:
                        continue
                    if not any(log["api_instance_id"] == validated["api_instance_id"]
                               and log["pid"] in api_records
                               for log in receipt.get("workspace_browser_api_logs", [])):
                        receipt["workspace_browser_progress_error"] = "API log pin is unconfirmed"
                        raise storage.StorageError("Private readiness has no matching owned API log")
                    with bridge.lock:
                        bridge.ready = validated
                    if not announced:
                        announced = True
                        receipt["workspace_browser_url"] = (
                            f"http://localhost:{WEB_PORT}/native-browser-proof?fullmag_api_instance="
                            + validated["api_instance_id"])
                        print(canonical({"event": "browser-ready", "url": receipt["workspace_browser_url"],
                                         "receipt": str(run_root / "receipt.json")}), flush=True)
                elif schema == "fullmag.development-browser-native-restored.v1":
                    if (frame.get("nonce") != expected["nonce"]
                            or not valid_uuid(frame.get("new_api_instance_id"))
                            or type(frame.get("api_pid")) is not int or frame["api_pid"] <= 0
                            or type(frame.get("old_api_exit_code")) is not int):
                        raise storage.StorageError("Native browser restore has invalid custody or scope")
                    with bridge.lock:
                        bridge.restored = dict(frame)
                        bridge.ready = None
                    if frame["api_pid"] not in api_records:
                        api_records[frame["api_pid"]] = {"label": "browser-replacement-api", "pid": frame["api_pid"],
                                                         "waited": False, "outcome": "unknown"}
                        receipt["processes"].append(api_records[frame["api_pid"]])
                    for pid, record in api_records.items():
                        if pid != frame["api_pid"]:
                            record.update(waited=True, exit_code=frame["old_api_exit_code"], outcome="terminal")
                    receipt["workspace_browser_restored"] = frame
                elif schema == RESULT_SCHEMA:
                    results.append(frame)
                with bridge.lock:
                    if bridge.before is not None:
                        receipt["workspace_browser_before"] = bridge.before
                storage.atomic_json(run_root / "receipt.json", receipt)
            if process.poll() is not None and reader.done.is_set() and reader.items.empty():
                break
            if frontend.poll() is not None:
                raise storage.StorageError("Private browser frontend exited before verification")
        if process.poll() is None:
            raise storage.StorageError("Native browser outcome is unknown after its observation budget")
        process.wait(timeout=5)
        cli_record.update(waited=True, exit_code=process.returncode)
        reader.thread.join(timeout=2)
        if reader.thread.is_alive() or reader.error is not None or len(results) != 1:
            raise storage.StorageError("Native browser result or observation transport is unconfirmed")
        result = results[0]
        validate_result_frame(result, expected["nonce"])
        result_confirmed = True
        for key, exit_key in (("old_api_pid", "old_api_exit_code"), ("new_api_pid", "new_api_exit_code")):
            pid, code = result.get(key), result.get(exit_key)
            if key == "new_api_pid" and result.get("status") != "passed" and pid is None and code is None:
                continue  # A failed pre-restart proof never created API B.
            if type(pid) is not int or pid not in api_records:
                raise storage.StorageError("Native browser has unknown API terminal custody")
            if result["status"] == "unknown" and code is None:
                continue  # Preserve observed helper exits without claiming an API wait.
            if type(code) is not int:
                raise storage.StorageError("Native browser has unknown API terminal custody")
            api_records[pid].update(waited=True, exit_code=code, outcome="terminal")
        helpers = result.get("helper_processes")
        if not isinstance(helpers, list) or not helpers:
            raise storage.StorageError("Native browser has no helper custody")
        known_helpers = set()
        for item in helpers:
            evidence = terminal_record(item)
            pid = evidence["pid"]
            if pid in known_helpers:
                raise storage.StorageError("Native browser duplicated helper custody")
            known_helpers.add(pid)
            if pid not in helper_records:
                helper_records[pid] = {"label": "browser-native-helper"}
                receipt["processes"].append(helper_records[pid])
            helper_records[pid].update(evidence, outcome="terminal")
        if not set(helper_records).issubset(known_helpers):
            raise storage.StorageError("An early browser helper still has unknown custody")
        terminal = terminal_custody(api_records, helper_records)
        receipt["workspace_browser_result"] = result
        if not terminal:
            raise storage.StorageError("Native browser API or helper terminal custody remains unknown")
        if (process.returncode != 0 or result.get("status") != "passed" or bridge.browser is None
                or bridge.restored is None or result["new_api_instance_id"] != bridge.browser["new_api_instance_id"]
                or result["old_api_instance_id"] != bridge.before["api_instance_id"]
                or result["new_api_pid"] == result["old_api_pid"]):
            raise storage.StorageError("Native custody and actual browser hydration did not both pass")
        receipt["workspace_browser_hydration"] = bridge.browser
        receipt["checks"].extend(["browser-private-native-readiness", "browser-nonempty-scene-captured",
                                   "browser-exact-scene-restored", "browser-fresh-session-and-api-pin",
                                   "browser-unsaved-document-restored", "browser-native-processes-waited"])
    finally:
        if process is not None and process.poll() is None and (bridge is None or not bridge.finished.is_set()):
            # EOF is a failed proof command, handled by the native owner. It
            # must perform its own exact-scope cleanup; killing this CLI would
            # discard custody of its API children.
            try:
                process.stdin.close()
                process.wait(timeout=15)
            except (OSError, subprocess.TimeoutExpired):
                receipt["workspace_browser_cleanup"] = "native owner outcome remains unknown"
        if process is not None and process.poll() is not None:
            process.wait(timeout=5)
            cli_record.update(waited=True, exit_code=process.returncode)
            # A failed observation can still produce truthful terminal custody
            # after EOF. Keep failure as failure, but do not lose a valid final
            # frame merely because it arrived during cleanup.
            if reader is not None:
                reader.thread.join(timeout=2)
                while not reader.items.empty():
                    cleanup_frame = reader.items.get_nowait()
                    try:
                        if record_started_frame(cleanup_frame, api_records, helper_records, receipt):
                            continue
                    except storage.StorageError:
                        continue
                    if (cleanup_frame.get("schema") != RESULT_SCHEMA
                            or cleanup_frame.get("nonce") != expected["nonce"]):
                        continue
                    try:
                        validate_result_frame(cleanup_frame, expected["nonce"])
                    except storage.StorageError:
                        continue
                    result_confirmed = True
                    for pid_key, code_key in (("old_api_pid", "old_api_exit_code"),
                                              ("new_api_pid", "new_api_exit_code")):
                        pid, code = cleanup_frame.get(pid_key), cleanup_frame.get(code_key)
                        if type(pid) is int and type(code) is int:
                            if pid not in api_records:
                                api_records[pid] = {"label": "browser-owned-api", "pid": pid,
                                                    "waited": False, "outcome": "unknown"}
                                receipt["processes"].append(api_records[pid])
                            api_records[pid].update(waited=True, exit_code=code, outcome="terminal")
                    for value in cleanup_frame.get("helper_processes", []):
                        try:
                            evidence = terminal_record(value)
                        except storage.StorageError:
                            continue
                        pid = evidence["pid"]
                        if pid not in helper_records:
                            helper_records[pid] = {"label": "browser-native-helper"}
                            receipt["processes"].append(helper_records[pid])
                        helper_records[pid].update(evidence, outcome="terminal")
                    receipt["workspace_browser_cleanup_result"] = cleanup_frame
                terminal = (result_confirmed and not receipt.get("workspace_browser_progress_error")
                            and reader.done.is_set() and not reader.thread.is_alive()
                            and reader.error is None and terminal_custody(api_records, helper_records))
        if server is not None:
            server.shutdown()
            server.server_close()
        if frontend is not None:
            stop_owned_process(frontend)
            receipt["workspace_browser_frontend"].update(waited=True, exit_code=frontend.returncode)
        if frontend_log is not None:
            frontend_log.close()
        if native_error_log is not None:
            native_error_log.close()
        if heartbeat is not None:
            heartbeat.stop()
        if terminal or process is None:
            _restore_diagnostic_status(status, expected["worktree_id"], expected["generation_id"], prior)
        else:
            receipt["workspace_browser_retained_status"] = str(status)
        storage.atomic_json(run_root / "receipt.json", receipt)
