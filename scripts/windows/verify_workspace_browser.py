"""Owned native/browser restart proof; every v2 request reaches the real API.

The private eligibility bridge does not change the public capability. Native
custody and browser hydration are independent requirements for a passing run.
"""
from __future__ import annotations

import hashlib
import ctypes
from ctypes import wintypes
import copy
import json
import math
import sys
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
from urllib.parse import quote
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
MAX_EXECUTION_OBSERVATIONS = 16
READY_SCHEMA = "fullmag.development-browser-native-ready.v1"
RESULT_SCHEMA = "fullmag.development-browser-native-result.v1"
API_LOG_SCHEMA = "fullmag.development-browser-api-log.v1"
SCRATCH_CHILD_SCHEMA = "fullmag.development-browser-scratch-child.v1"
RESTORED_SCHEMA_V1 = "fullmag.development-browser-native-restored.v1"
RESTORED_SCHEMA_V2 = "fullmag.development-browser-native-restored.v2"
SCRATCH_COMMAND_KINDS = frozenset({"fdm_grid_refresh", "remesh", "run", "relax", "solve"})
COMPUTE_CHILD_KINDS = frozenset({"run", "relax", "solve"})
EXECUTION_SCOPE_KEYS = ("api_instance_id", "session_id", "backend_session_epoch", "request_scope_epoch")


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


def camera_for_proof(value):
    """Require the exact camera contract; never normalize a lost view to defaults."""
    fields = {"projection", "position", "target", "up", "fov_degrees", "orthographic_scale"}
    if not isinstance(value, dict) or set(value) != fields:
        raise storage.StorageError("Camera proof has an incomplete or foreign camera")

    def finite_number(number):
        return type(number) in (int, float) and math.isfinite(number)

    if value["projection"] not in ("perspective", "orthographic"):
        raise storage.StorageError("Camera proof has an invalid projection")
    for field in ("position", "target", "up"):
        vector = value[field]
        if not isinstance(vector, list) or len(vector) != 3 or not all(map(finite_number, vector)):
            raise storage.StorageError("Camera proof has an invalid vector")
    if (value["position"] == value["target"]
            or sum(component * component for component in value["up"]) <= sys.float_info.epsilon):
        raise storage.StorageError("Camera proof has a degenerate view basis")
    fov, scale = value["fov_degrees"], value["orthographic_scale"]
    if (not finite_number(fov) or not 1 <= fov <= 179
            or (scale is not None and (not finite_number(scale) or scale <= 0))):
        raise storage.StorageError("Camera proof has an invalid projection parameter")
    return copy.deepcopy(value)


def validate_camera_preservation(before, after):
    expected, observed = camera_for_proof(before), camera_for_proof(after)
    changed = sorted(key for key in expected if expected[key] != observed[key])
    if changed:
        raise storage.StorageError("Native restart changed the captured camera: " + ", ".join(changed))
    return {"preserved": True, "before": expected, "after": observed}


def scene_after_successful_grid(scene):
    """Only clear the production mesh-dirty tag; retain all authored data."""
    expected = copy.deepcopy(scene)
    for obj in expected.get("objects", []):
        tags = obj.get("tags")
        if isinstance(tags, list) and "mesh:dirty" in tags:
            remaining = [tag for tag in tags if tag != "mesh:dirty"]
            if remaining:
                obj["tags"] = remaining
            else:
                obj.pop("tags")
    return expected


def validate_after_grid_document(before, expected):
    """Pin predicted hashes before restart; never relax archive or metadata."""
    if not isinstance(before, dict) or not isinstance(expected, dict):
        raise storage.StorageError("After-grid document proof is missing")
    hashes = ("scene_resource_sha256", "scene_document_sha256")
    if any(not isinstance(expected.get(key), str) or not SHA256_RE.fullmatch(expected[key])
           or not isinstance(before.get(key), str) or not SHA256_RE.fullmatch(before[key])
           for key in hashes):
        raise storage.StorageError("After-grid document hashes are invalid")
    if canonical({**expected, **{key: before[key] for key in hashes}}) != canonical(before):
        raise storage.StorageError("After-grid document changed archive or metadata")


def check_material_anisotropy_plans(binaries, fixture, env, receipt):
    """Exercise the production planner without compiling tests or starting a solver."""
    root = fixture / "material-anisotropy-plans"
    root.mkdir(exist_ok=False)
    verifier_sha256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    executable_sha256 = hashlib.sha256((binaries / "fullmag.exe").read_bytes()).hexdigest()
    receipt["workspace_browser_material_plan_identity"] = {
        "verifier_sha256": verifier_sha256, "executable_sha256": executable_sha256}

    def invoke(label, arguments):
        stdout_path, stderr_path = root / f"{label}.stdout", root / f"{label}.stderr"
        with stdout_path.open("xb") as stdout, stderr_path.open("xb") as stderr:
            child = subprocess.Popen([str(binaries / "fullmag.exe"), *arguments],
                                     cwd=fixture, env=env, stdout=stdout, stderr=stderr,
                                     creationflags=subprocess.CREATE_NO_WINDOW)
            record = {"label": f"material-plan-{label}", "pid": child.pid, "waited": False}
            receipt["processes"].append(record)
            deadline = time.monotonic() + 30
            try:
                while child.poll() is None:
                    if (time.monotonic() >= deadline
                            or stdout_path.stat().st_size + stderr_path.stat().st_size > MAX_LOG):
                        raise storage.StorageError(f"Production material planner {label} exceeded its bound")
                    time.sleep(0.02)
                child.wait(timeout=10)
                record.update(waited=True, exit_code=child.returncode, kill_requested=False)
            finally:
                if not record["waited"]:
                    try:
                        if child.poll() is None:
                            record["kill_requested"] = True
                            child.kill()
                        child.wait(timeout=10)
                        record.update(waited=True, exit_code=child.returncode)
                    except Exception as error:
                        record.update(outcome="unknown", cleanup_error=str(error),
                                      executable=str(binaries / "fullmag.exe"))
                        raise storage.StorageError(
                            f"Production material planner {label} has unknown cleanup outcome") from error
        if stdout_path.stat().st_size + stderr_path.stat().st_size > MAX_LOG:
            raise storage.StorageError(f"Production material planner {label} exceeded its output bound")
        return child.returncode, stdout_path.read_text(encoding="utf-8"), stderr_path.read_text(encoding="utf-8")

    code, stdout, stderr = invoke("example", ["example-ir"])
    if code:
        raise storage.StorageError(f"Production planner example failed: {stderr[:1024]}")
    baseline = json.loads(stdout)
    baseline["energy_terms"] = []
    baseline["geometry"]["entries"][0]["size"] = [2e-9, 2e-9, 2e-9]
    baseline["study"]["sampling"]["outputs"] = []
    baseline["backend_policy"]["requested_backend"] = "fdm"
    baseline["problem_meta"]["runtime_metadata"]["runtime_selection"] = {
        "backend": "fdm", "device": "cpu", "precision": "double", "mode": "strict"}
    cases = [
        ("ku1", {"uniaxial_anisotropy": 1000.0, "anisotropy_axis": [0, 0, 1]}, True),
        ("negative-ku1", {"uniaxial_anisotropy": -1000.0, "anisotropy_axis": [0, 0, 1]}, True),
        ("ku2", {"uniaxial_anisotropy": 0.0, "uniaxial_anisotropy_k2": 1000.0}, True),
        ("cubic", {"cubic_anisotropy_kc1": 1000.0}, True),
        ("absent", {}, False),
        ("zero", {"uniaxial_anisotropy": 0.0}, False),
        ("ku2-without-ku1", {"uniaxial_anisotropy_k2": 1000.0}, False),
        ("zero-axis", {"uniaxial_anisotropy": 1000.0, "anisotropy_axis": [0, 0, 0]}, False),
        ("parallel-cubic", {"cubic_anisotropy_kc1": 1000.0,
                            "cubic_anisotropy_axis1": [1, 0, 0],
                            "cubic_anisotropy_axis2": [2, 0, 0]}, False),
        ("unused-material", {}, False),
    ]
    observations = receipt["workspace_browser_material_plans"] = []
    for label, coefficients, accepted in cases:
        problem = copy.deepcopy(baseline)
        problem["materials"][0].update(coefficients)
        if label == "unused-material":
            unused = copy.deepcopy(problem["materials"][0])
            unused.update(name="unused", uniaxial_anisotropy=1000.0)
            problem["materials"].append(unused)
        input_path = root / f"{label}.json"
        input_path.write_text(json.dumps(problem, allow_nan=False), encoding="utf-8")
        code, stdout, stderr = invoke(label, ["plan-json", str(input_path), "--execution-plan"])
        observation = {"case": label, "expected_accepted": accepted, "exit_code": code,
                       "input_sha256": hashlib.sha256(input_path.read_bytes()).hexdigest()}
        observations.append(observation)
        if accepted:
            if code:
                raise storage.StorageError(f"Production planner rejected {label}: {stderr[:1024]}")
            fdm = json.loads(stdout)["backend_plan"]
            if (fdm["kind"] != "fdm" or fdm["enable_exchange"] or fdm["enable_demag"]
                    or fdm.get("external_field") is not None):
                raise storage.StorageError(f"Production planner changed local-only intent for {label}")
        elif code == 0 or not any(reason in stderr for reason in (
                "or nonzero anisotropy in a referenced material",
                "at least one interaction or material anisotropy is required")):
            raise storage.StorageError(f"Production planner did not reject {label} at the physics gate")
        observation["passed"] = True
    if (hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != verifier_sha256
            or hashlib.sha256((binaries / "fullmag.exe").read_bytes()).hexdigest() != executable_sha256):
        raise storage.StorageError("Production material planner verifier or executable changed during checks")


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


def validate_restored_frame(frame, expected, before, source_api_pid=None):
    """Validate custody metadata; v2 additionally binds the consumed request.

    This does not replace HTTP scene/camera hydration or terminal process
    verification. Legacy v1 carries no request identity and cannot qualify it.
    """
    fields = {"schema", "nonce", "new_api_instance_id", "api_pid",
              "old_api_exit_code", "helper_processes"}
    if not isinstance(frame, dict) or frame.get("schema") not in {RESTORED_SCHEMA_V1, RESTORED_SCHEMA_V2}:
        raise storage.StorageError("Native browser restore has an unsupported schema")
    v2 = frame["schema"] == RESTORED_SCHEMA_V2
    if v2:
        fields |= {"request_id", "generation_id", "old_api_instance_id", "old_api_pid"}
    if (set(frame) != fields or frame.get("nonce") != expected.get("nonce")
            or not valid_uuid(frame.get("new_api_instance_id"))
            or not isinstance(before, dict)
            or frame["new_api_instance_id"] == before.get("api_instance_id")
            or type(frame.get("api_pid")) is not int or frame["api_pid"] <= 0
            or type(frame.get("old_api_exit_code")) is not int):
        raise storage.StorageError("Native browser restore has invalid custody or scope")
    helpers = frame["helper_processes"]
    if not isinstance(helpers, list) or not helpers:
        raise storage.StorageError("Native browser restore lacks helper custody")
    seen = set()
    for helper in helpers:
        record = terminal_record(helper)
        if (record["pid"] in seen or record["pid"] == frame["api_pid"]
                or (source_api_pid is not None and record["pid"] == source_api_pid)):
            raise storage.StorageError("Native browser restore duplicated process custody")
        seen.add(record["pid"])
    if v2 and (not valid_uuid(frame["request_id"])
            or not valid_uuid(frame["old_api_instance_id"])
            or frame["old_api_instance_id"] != before.get("api_instance_id")
            or not isinstance(frame["generation_id"], str)
            or not BUNDLE_ID_RE.fullmatch(frame["generation_id"])
            or frame["generation_id"] != expected.get("generation_id")
            or type(source_api_pid) is not int or source_api_pid <= 0
            or type(frame["old_api_pid"]) is not int
            or frame["old_api_pid"] != source_api_pid
            or frame["old_api_pid"] == frame["api_pid"]):
        raise storage.StorageError("Native browser restore differs from the consumed request scope")
    return copy.deepcopy(frame)


def restore_protocol_scope(validated_frame):
    """Classify an already validated frame without promoting legacy proof."""
    schema = validated_frame.get("schema")
    if schema not in {RESTORED_SCHEMA_V1, RESTORED_SCHEMA_V2}:
        raise storage.StorageError("Restore protocol scope has an unsupported schema")
    return {"schema": schema, "authenticated_request_binding": schema == RESTORED_SCHEMA_V2,
            "qualification": "authenticated_v2" if schema == RESTORED_SCHEMA_V2
            else "legacy_v1_without_request_identity"}


def read_api(port, pin, path):
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}",
                                     headers={"x-fullmag-api-instance": pin})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=5) as response:
        raw = response.read(MAX_FRAME + 1)
        if len(raw) > MAX_FRAME or response.headers.get("x-fullmag-api-instance") != pin:
            raise storage.StorageError("Browser proof API response is oversized or has a different pin")
        return json.loads(raw)


def read_execution_scope(api_port, api_instance_id):
    """Read the actual pinned API/session identity used by execution resources."""
    if not valid_uuid(api_instance_id):
        raise storage.StorageError("Execution observation has no canonical API pin")
    status = read_api(api_port, api_instance_id, "/v2/sessions/current/status")
    session = status.get("session")
    session_id = session.get("session_id") if isinstance(session, dict) else None
    session_resource_epoch = session.get("session_epoch") if isinstance(session, dict) else None
    request_scope_epoch = session.get("request_scope_epoch") if isinstance(session, dict) else None
    prefix = api_instance_id + ":"
    request_counter = request_scope_epoch[len(prefix):] if isinstance(request_scope_epoch, str) \
        and request_scope_epoch.startswith(prefix) else None
    if (not isinstance(session, dict)
            or not isinstance(session_id, str) or not session_id.strip()
            or not isinstance(session_resource_epoch, str) or not session_resource_epoch
            or not isinstance(request_scope_epoch, str)
            or request_counter is None
            or not re.fullmatch(r"(?:0|[1-9][0-9]*)", request_counter)):
        raise storage.StorageError("Execution API has no exact workspace identity")
    backend_session_epoch = int(request_counter)
    parse_session_resource_epoch(session_id, session_resource_epoch)
    if request_scope_epoch != f"{api_instance_id}:{backend_session_epoch}":
        raise storage.StorageError("Execution status is not bound to the observed API/session transition")
    return {
        "api_instance_id": api_instance_id,
        "session_id": session_id,
        "backend_session_epoch": backend_session_epoch,
        "session_resource_epoch": session_resource_epoch,
        "request_scope_epoch": request_scope_epoch,
    }


def read_session_identity(api_port, api_instance_id):
    scope = read_execution_scope(api_port, api_instance_id)
    identity = {"api_instance_id": scope["api_instance_id"],
                "session_id": scope["session_id"],
                "session_epoch": scope["backend_session_epoch"]}
    session_scope = {"session_resource_epoch": scope["session_resource_epoch"],
                    "request_scope_epoch": scope["request_scope_epoch"]}
    return identity, session_scope


def read_admission_observation(api_port, api_instance_id):
    """Keep rejected prerequisites as evidence, without granting admission."""
    before = read_execution_scope(api_port, api_instance_id)
    status = read_api(api_port, api_instance_id, "/v2/sessions/current/status")
    mesh = read_api(api_port, api_instance_id, "/v2/sessions/current/meshing/semantics")
    after = read_execution_scope(api_port, api_instance_id)
    session = status.get("session", {})
    if (before != after or not isinstance(session, dict)
            or session.get("session_id") != before["session_id"]
            or session.get("session_epoch") != before["session_resource_epoch"]
            or session.get("request_scope_epoch") != before["request_scope_epoch"]):
        raise storage.StorageError("Admission observation crossed an API/session transition")
    return {"scope": before, "status": status, "meshing_semantics": mesh,
            "observed_at_unix_ms": utc_ms()}


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


def record_scratch_child_frame(frame, expected, scratch_records, receipt):
    if not isinstance(frame, dict) or frame.get("schema") != SCRATCH_CHILD_SCHEMA:
        return False

    def reject(message):
        receipt["workspace_browser_progress_error"] = "invalid scratch child custody"
        raise storage.StorageError(message)

    fields = {"schema", "nonce", "state", "pid", "command_id", "command_kind",
              "api_instance_id", "session_id", "session_epoch", "request_scope_epoch",
              "waited", "exit_code", "kill_requested"}
    if set(frame) != fields:
        reject("Scratch child frame has an invalid shape")
    if frame["nonce"] != expected.get("nonce"):
        reject("Scratch child frame has a different nonce")
    if (type(frame["pid"]) is not int or frame["pid"] <= 0
            or not isinstance(frame["command_id"], str) or not frame["command_id"].strip()
            or not isinstance(frame["command_kind"], str)
            or frame["command_kind"] not in SCRATCH_COMMAND_KINDS
            or not valid_uuid(frame["api_instance_id"])
            or not isinstance(frame["session_id"], str) or not frame["session_id"].strip()
            or not isinstance(frame["session_epoch"], str)
            or not frame["session_epoch"].startswith(frame["session_id"] + "@")
            or not frame["session_epoch"][len(frame["session_id"]) + 1:]
            or not isinstance(frame["request_scope_epoch"], str)):
        reject("Scratch child frame has invalid scope or command identity")
    scope_prefix = frame["api_instance_id"] + ":"
    request_counter = frame["request_scope_epoch"][len(scope_prefix):]
    if (not frame["request_scope_epoch"].startswith(scope_prefix)
            or not re.fullmatch(r"[0-9]+", request_counter)):
        reject("Scratch child frame has an invalid request scope epoch")
    state = frame["state"]
    if state == "started":
        if (type(frame["waited"]) is not bool or frame["waited"] is not False
                or frame["exit_code"] is not None
                or type(frame["kill_requested"]) is not bool or frame["kill_requested"] is not False):
            reject("Scratch child start frame is not an un-waited child")
    elif state == "waited":
        if (type(frame["waited"]) is not bool or frame["waited"] is not True
                or type(frame["exit_code"]) is not int
                or type(frame["kill_requested"]) is not bool):
            reject("Scratch child wait frame lacks an exact terminal outcome")
    else:
        reject("Scratch child frame has an unknown state")

    identity_fields = ("pid", "command_id", "command_kind", "api_instance_id", "session_id",
                      "session_epoch", "request_scope_epoch")
    api_logs = receipt.get("workspace_browser_api_logs", [])
    known_api_pins = {
        log.get("api_instance_id")
        for log in (api_logs if isinstance(api_logs, list) else [])
        if isinstance(log, dict) and valid_uuid(log.get("api_instance_id"))
    }
    restored = receipt.get("workspace_browser_restored")
    if isinstance(restored, dict) and valid_uuid(restored.get("new_api_instance_id")):
        known_api_pins.add(restored["new_api_instance_id"])
    for result_key in ("workspace_browser_result", "workspace_browser_cleanup_result"):
        result = receipt.get(result_key)
        if isinstance(result, dict):
            known_api_pins.update(pin for pin in (result.get("old_api_instance_id"),
                                                   result.get("new_api_instance_id"))
                                  if valid_uuid(pin))
    if frame["api_instance_id"] not in known_api_pins:
        reject("Scratch child API pin differs from observed browser API logs")

    command_id = frame["command_id"]
    entry = scratch_records.get(command_id)
    if state == "started":
        if entry is not None:
            reject("Scratch child emitted a duplicate start frame")
        record = {
            "label": "browser-scratch-child",
            **{key: frame[key] for key in identity_fields},
            "waited": False,
            "exit_code": None,
            "kill_requested": False,
            "outcome": "unknown",
        }
        if not isinstance(receipt.get("processes"), list):
            reject("Scratch child receipt has no process list")
        scratch_records[command_id] = {"identity": {key: frame[key] for key in identity_fields},
                                       "record": record, "wait_seen": False}
        receipt["processes"].append(record)
    else:
        if entry is None:
            reject("Scratch child wait frame has no observed start")
        if entry["wait_seen"]:
            reject("Scratch child emitted a duplicate wait frame")
        if any(entry["identity"].get(key) != frame[key] for key in identity_fields):
            reject("Scratch child identity changed between start and wait")
        entry["wait_seen"] = True
        entry["record"].update(waited=True, exit_code=frame["exit_code"],
                               kill_requested=frame["kill_requested"], outcome="terminal")

    frames = receipt.setdefault("workspace_browser_scratch_child_frames", [])
    if not isinstance(frames, list):
        reject("Scratch child receipt has no frame list")
    frames.append(dict(frame))
    return True


def terminal_custody(api_records, helper_records, scratch_records=None, receipt=None):
    if receipt is not None and receipt.get("workspace_browser_progress_error"):
        return False
    scratch_records = scratch_records or {}
    return bool(api_records) and all(
        record.get("waited") is True and type(record.get("exit_code")) is int
        for record in [*api_records.values(), *helper_records.values()]
    ) and all(
        entry.get("wait_seen") is True
        and entry.get("record", {}).get("waited") is True
        and type(entry.get("record", {}).get("exit_code")) is int
        and type(entry.get("record", {}).get("kill_requested")) is bool
        for entry in scratch_records.values()
    )


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


def completed_command_detail(frame, command_id, command_kind):
    if (not isinstance(frame, dict)
            or frame.get("command_id") != command_id
            or frame.get("kind") != command_kind
            or frame.get("status") != "completed"
            or frame.get("completion_status") != "completed"
            or type(frame.get("created_at_unix_ms")) is not int
            or type(frame.get("completed_at_unix_ms")) is not int
            or frame["created_at_unix_ms"] <= 0
            or frame["completed_at_unix_ms"] < frame["created_at_unix_ms"]):
        raise storage.StorageError(f"Observed {command_kind} command has no exact completed ledger receipt")
    return {
        "command_id": command_id,
        "kind": command_kind,
        "status": frame["status"],
        "completion_status": frame["completion_status"],
        "created_at_unix_ms": frame["created_at_unix_ms"],
        "completed_at_unix_ms": frame["completed_at_unix_ms"],
        "run_id": frame.get("run_id"),
        "stage_id": frame.get("stage_id"),
        "stage_index": frame.get("stage_index"),
        "applied_step": frame.get("applied_step"),
        "completed_step": frame.get("completed_step"),
        "requested_execution": frame.get("requested_execution"),
        "resolved_execution": frame.get("resolved_execution"),
    }


def has_positive_solver_execution(evidence):
    applied, completed = evidence.get("applied_step"), evidence.get("completed_step")
    return type(applied) is int and applied >= 0 and type(completed) is int and completed > applied


def completed_scratch_entry(entry, api_instance_id, scope):
    if not isinstance(entry, dict) or entry.get("wait_seen") is not True:
        return False
    identity, record = entry.get("identity"), entry.get("record")
    return (
        isinstance(identity, dict) and isinstance(record, dict)
        and identity.get("api_instance_id") == api_instance_id
        and identity.get("session_id") == scope.get("session_id")
        and identity.get("session_epoch") == scope.get("session_resource_epoch")
        and identity.get("request_scope_epoch") == scope.get("request_scope_epoch")
        and record.get("api_instance_id") == api_instance_id
        and record.get("waited") is True
        and type(record.get("exit_code")) is int and record["exit_code"] == 0
        and record.get("kill_requested") is False
    )


def same_execution_scope(left, right):
    return isinstance(left, dict) and isinstance(right, dict) and all(
        left.get(key) == right.get(key) for key in EXECUTION_SCOPE_KEYS)


def parse_session_resource_epoch(session_id, value):
    prefix = session_id + "@"
    if not isinstance(value, str) or not value.startswith(prefix):
        raise storage.StorageError("Session resource epoch has a different session identity")
    parts = value[len(prefix):].split(":tombstone:")
    if len(parts) not in (1, 2) or any(
            len(part) > 39 or not part.isascii() or not part.isdecimal() or not 0 < int(part) < 2**128
            or str(int(part)) != part for part in parts):
        raise storage.StorageError("Session resource epoch is not canonical")
    started = int(parts[0])
    finished = int(parts[1]) if len(parts) == 2 else None
    if finished is not None and finished < started:
        raise storage.StorageError("Session tombstone precedes its start")
    return started, finished


def validate_terminal_execution_scope(scope, restored, lifecycle, earliest_finish, observed_at):
    for key in EXECUTION_SCOPE_KEYS:
        if key != "session_resource_epoch" and scope.get(key) != restored.get(key):
            raise storage.StorageError("Terminal execution changed its API/session owner")
    started, previous_finish = parse_session_resource_epoch(
        restored["session_id"], restored["session_resource_epoch"])
    next_started, finished = parse_session_resource_epoch(
        scope["session_id"], scope["session_resource_epoch"])
    if (previous_finish is not None or next_started != started or finished is None
            or type(earliest_finish) is not int or type(observed_at) is not int
            or not earliest_finish <= finished <= observed_at
            or not isinstance(lifecycle, dict) or lifecycle.get("solver") != "completed"
            or lifecycle.get("session_resource") != "tombstoned"
            or lifecycle.get("commandability") != "read_only"):
        raise storage.StorageError("Execution has no exact completed session tombstone")
    return finished


def owned_scratch_entry_in_scope(entry, api_instance_id, scope):
    if not isinstance(entry, dict):
        return False
    identity, record = entry.get("identity"), entry.get("record")
    if (not isinstance(identity, dict) or not isinstance(record, dict)
            or identity.get("api_instance_id") != api_instance_id
            or identity.get("session_id") != scope.get("session_id")
            or identity.get("session_epoch") != scope.get("session_resource_epoch")
            or identity.get("request_scope_epoch") != scope.get("request_scope_epoch")
            or record.get("api_instance_id") != api_instance_id
            or record.get("kill_requested") is not False):
        return False
    if entry.get("wait_seen") is True:
        return record.get("waited") is True and type(record.get("exit_code")) is int \
            and record["exit_code"] == 0
    return record.get("waited") is False and record.get("exit_code") is None


def scratch_frame_positions(frames, command_ids):
    positions = {}
    for index, frame in enumerate(frames):
        if not isinstance(frame, dict) or frame.get("command_id") not in command_ids:
            continue
        state = frame.get("state")
        if state not in {"started", "waited"}:
            continue
        key = (frame["command_id"], state)
        if key in positions:
            raise storage.StorageError("Execution observation found duplicate scratch lifecycle frames")
        positions[key] = index
    return positions


class ProofBridge:
    def __init__(self, expected, api_port, frames, process, receipt=None,
                 scratch_records=None, receipt_path=None):
        self.expected, self.api_port = expected, api_port
        self.frames, self.process = frames, process
        self.lock = threading.RLock()
        self.execution_lock = threading.Lock()
        self.receipt = receipt if receipt is not None else {"processes": []}
        self.scratch_records = scratch_records if scratch_records is not None else {}
        self.receipt_path = Path(receipt_path) if receipt_path is not None else None
        self.ready = None
        self.restored = None
        self.before = None
        self.restore_observation = None
        self.last_execution = None
        self.browser = None
        self.error = None
        self.finished = threading.Event()
        self.cancelled = threading.Event()

    def cancel(self, body):
        if (set(body) != {"schema", "nonce"}
                or body.get("schema") != "fullmag.development-browser-cancel.v1"
                or body.get("nonce") != self.expected["nonce"]):
            raise storage.StorageError("Private browser cancellation has an invalid scope")
        with self.lock:
            if self.finished.is_set():
                raise storage.StorageError("Browser finish has already been submitted")
            self.receipt["workspace_browser_cancel_requested"] = True
            self.cancelled.set()
        return {"cancel_requested": True}

    def eligibility(self):
        with self.lock:
            if self.process.poll() is not None or self.ready is None:
                raise storage.StorageError("Native browser owner is not ready")
            return validate_ready(self.ready, self.expected, utc_ms())

    def _store_execution_observation(self, observation):
        with self.lock:
            observations = self.receipt.setdefault("workspace_browser_execution_observations", [])
            if not isinstance(observations, list):
                raise storage.StorageError("Execution receipt has an invalid observation list")
            if len(observations) >= MAX_EXECUTION_OBSERVATIONS:
                raise storage.StorageError("Execution observation budget is exhausted")
            observations.append(dict(observation))
            self.receipt["workspace_browser_execution"] = dict(observation)
            if self.receipt_path is not None:
                storage.atomic_json(self.receipt_path, self.receipt)

    def capture_restored_observation(self):
        with self.execution_lock:
            with self.lock:
                if self.restore_observation is not None:
                    return dict(self.restore_observation)
                before, restored = copy.deepcopy(self.before), copy.deepcopy(self.restored)
            if before is None or not isinstance(restored, dict):
                raise storage.StorageError("Restored execution scope has no captured before state")
            api_instance_id = restored.get("new_api_instance_id")
            if (not valid_uuid(api_instance_id)
                    or api_instance_id == before.get("api_instance_id")
                    or type(restored.get("api_pid")) is not int or restored["api_pid"] <= 0):
                raise storage.StorageError("Restored execution scope has no distinct native API pin")
            scope = read_execution_scope(self.api_port, api_instance_id)
            scene = read_api(self.api_port, api_instance_id, "/v2/sessions/current/model/scene")
            if (canonical(scene) != canonical(before.get("scene"))
                    or scope["api_instance_id"] != api_instance_id
                    or scope["session_id"] == before["identity"].get("session_id")
                    or scope["backend_session_epoch"] != 1
                    or scope["request_scope_epoch"] == before["session_scope"].get("request_scope_epoch")
                    or scope["session_resource_epoch"] == before["session_scope"].get("session_resource_epoch")):
                raise storage.StorageError("Restored scene or fresh session differs from the captured before state")
            observation = {
                "api_instance_id": api_instance_id,
                "api_pid": restored["api_pid"],
                "api_response_pin": api_instance_id,
                "scope": scope,
                "scene_sha256": hashlib.sha256(canonical(scene).encode()).hexdigest(),
                "object_count": len(scene.get("objects", [])) if isinstance(scene, dict) else 0,
                "captured_at_unix_ms": utc_ms(),
            }
            with self.lock:
                if self.restore_observation is None:
                    self.restore_observation = observation
                    self.receipt["workspace_browser_restore_observation"] = dict(observation)
                    if self.receipt_path is not None:
                        storage.atomic_json(self.receipt_path, self.receipt)
                elif canonical(self.restore_observation) != canonical(observation):
                    raise storage.StorageError("Restored execution scope changed during baseline capture")
                return dict(self.restore_observation)

    def execution(self, *, require_terminal=True):
        observed_at = utc_ms()
        try:
            evidence = self._read_execution_evidence(require_terminal=require_terminal)
        except Exception as error:
            observation = {"observed_at_unix_ms": observed_at, "verified": False,
                           "error": f"{type(error).__name__}: {str(error)[:512]}"}
            try:
                self._store_execution_observation(observation)
            except storage.StorageError:
                pass
            if isinstance(error, storage.StorageError):
                raise
            raise storage.StorageError(f"Execution observation failed: {type(error).__name__}: {error}") from error
        observation = {"observed_at_unix_ms": observed_at, "verified": require_terminal,
                       "ready_to_close": not require_terminal, **evidence}
        self._store_execution_observation(observation)
        with self.lock:
            self.last_execution = dict(observation)
        return {"verified": require_terminal, "ready_to_close": not require_terminal, **evidence}

    def _read_execution_evidence(self, *, require_terminal=True):
        with self.lock:
            before = copy.deepcopy(self.before)
            restored = copy.deepcopy(self.restored)
            restore = copy.deepcopy(self.restore_observation)
            scratch = copy.deepcopy(self.scratch_records)
            scratch_frames = copy.deepcopy(self.receipt.get("workspace_browser_scratch_child_frames", []))
            api_logs = copy.deepcopy(self.receipt.get("workspace_browser_api_logs", []))
        if before is None or restored is None or restore is None:
            raise storage.StorageError("Execution observation lacks before and restored API scopes")
        api_instance_id = restored.get("new_api_instance_id")
        api_pid = restored.get("api_pid")
        if (not valid_uuid(api_instance_id) or api_instance_id == before.get("api_instance_id")
                or type(api_pid) is not int or api_pid <= 0
                or restore.get("api_instance_id") != api_instance_id
                or restore.get("api_response_pin") != api_instance_id):
            raise storage.StorageError("Execution observation is not bound to the restored API response pin")
        if not isinstance(api_logs, list) or not any(
                isinstance(log, dict) and log.get("api_instance_id") == before.get("api_instance_id")
                for log in api_logs):
            raise storage.StorageError("Captured before state has no matching observed API log pin")

        scope_before = read_execution_scope(self.api_port, api_instance_id)
        queue_before = read_api(self.api_port, api_instance_id, "/v2/sessions/current/simulation/commands")
        scene = read_api(self.api_port, api_instance_id, "/v2/sessions/current/model/scene")
        scene_sha256 = hashlib.sha256(canonical(scene).encode()).hexdigest()
        if (canonical(scene) != canonical(scene_after_successful_grid(before.get("scene")))
                or not same_execution_scope(scope_before, restore.get("scope"))):
            raise storage.StorageError("Restored scene or session scope changed after the restore observation")

        records = list(scratch.items())
        grid_index = next((index for index in range(len(records) - 1, -1, -1)
                           if records[index][1].get("identity", {}).get("api_instance_id") == api_instance_id
                           and records[index][1].get("identity", {}).get("command_kind") == "fdm_grid_refresh"), None)
        if grid_index is None:
            raise storage.StorageError("No restored-API fdm_grid_refresh child was observed")
        grid_id, grid_entry = records[grid_index]
        if not completed_scratch_entry(grid_entry, api_instance_id, restore["scope"]):
            raise storage.StorageError("fdm_grid_refresh child lacks a normal successful wait")

        compute_index = next((index for index in range(len(records) - 1, grid_index, -1)
                              if records[index][1].get("identity", {}).get("api_instance_id") == api_instance_id
                              and records[index][1].get("identity", {}).get("command_kind") in COMPUTE_CHILD_KINDS), None)
        if compute_index is None:
            raise storage.StorageError("No separate normal Compute child followed the grid refresh")
        compute_id, compute_entry = records[compute_index]
        if ((require_terminal and not completed_scratch_entry(compute_entry, api_instance_id, restore["scope"]))
                or grid_id == compute_id
                or grid_entry["identity"].get("pid") == compute_entry["identity"].get("pid")):
            raise storage.StorageError("Normal Compute child is not separate and normally waited")
        positions = scratch_frame_positions(scratch_frames, {grid_id, compute_id})
        grid_start, grid_wait = positions.get((grid_id, "started"), -1), positions.get((grid_id, "waited"), -1)
        compute_start, compute_wait = positions.get((compute_id, "started"), -1), positions.get((compute_id, "waited"))
        if (not (grid_start < grid_wait < compute_start)
                or (compute_wait is not None and compute_wait <= compute_start)):
            raise storage.StorageError("Scratch frames do not show grid wait before the distinct Compute child")
        if not owned_scratch_entry_in_scope(compute_entry, api_instance_id, restore["scope"]):
            raise storage.StorageError("Compute child lost its exact API/session scope or custody")

        grid_kind = grid_entry["identity"]["command_kind"]
        compute_kind = compute_entry["identity"]["command_kind"]
        grid_detail = read_api(self.api_port, api_instance_id,
                               "/v2/sessions/current/simulation/commands/" + quote(grid_id, safe=""))
        grid_evidence = completed_command_detail(grid_detail, grid_id, grid_kind)
        compute_detail = read_api(self.api_port, api_instance_id,
                                  "/v2/sessions/current/simulation/commands/" + quote(compute_id, safe=""))
        compute_evidence = completed_command_detail(compute_detail, compute_id, compute_kind)
        if (not isinstance(compute_evidence["run_id"], str) or not compute_evidence["run_id"].strip()
                or not ((isinstance(compute_evidence["stage_id"], str) and compute_evidence["stage_id"].strip())
                        or (type(compute_evidence["stage_index"]) is int and compute_evidence["stage_index"] >= 0))
                or not has_positive_solver_execution(compute_evidence)
                or not isinstance(compute_evidence["requested_execution"], dict)
                or not isinstance(compute_evidence["resolved_execution"], dict)):
            raise storage.StorageError("Completed Compute command lacks positive stage-step and execution provenance")

        run = read_api(self.api_port, api_instance_id, "/v2/sessions/current/simulation/runs/current")
        stages = read_api(self.api_port, api_instance_id, "/v2/sessions/current/simulation/stages/execution")
        if (not isinstance(run, dict) or run.get("run_id") != compute_evidence["run_id"]
                or run.get("session_id") != scope_before["session_id"]
                or run.get("status") != ("completed" if require_terminal else "awaiting_command")
                or type(run.get("total_steps")) is not int or run["total_steps"] <= 0
                or type(run.get("total_stages")) is not int or run["total_stages"] <= 0
                or not isinstance(stages, dict) or type(stages.get("total_stages")) is not int
                or stages["total_stages"] <= 0 or not isinstance(stages.get("completed_stage_indexes"), list)
                or not isinstance(stages.get("stages"), list)):
            raise storage.StorageError("Current run has no completed stage or positive solver-step receipt")
        matching_stages = [item for item in stages["stages"]
                           if isinstance(item, dict) and item.get("command_id") == compute_id]
        if len(matching_stages) != 1:
            raise storage.StorageError("Completed Compute has no unique stage linked by command ID")
        if not require_terminal and any(not isinstance(item, dict) or item.get("status") != "completed"
                                        for item in stages["stages"]):
            raise storage.StorageError("Close requires all authored stages to be completed")
        stage = matching_stages[0]
        if stage.get("completed_step") != compute_evidence["completed_step"]:
            raise storage.StorageError("Compute stage and command differ on the completed solver step")
        stage_index = stage.get("index")
        completed_indexes = stages["completed_stage_indexes"]
        if (not isinstance(stage.get("stage_id"), str) or not stage["stage_id"].strip()
                or type(stage_index) is not int or stage_index < 0
                or stage.get("status") != "completed"
                or type(stage.get("started_at_unix_ms")) is not int
                or type(stage.get("completed_at_unix_ms")) is not int
                or stage["started_at_unix_ms"] <= 0
                or stage["completed_at_unix_ms"] < stage["started_at_unix_ms"]
                or any(type(index) is not int for index in completed_indexes)
                or stage_index not in completed_indexes
                or (compute_evidence["stage_id"] is not None
                    and compute_evidence["stage_id"] != stage["stage_id"])
                or (compute_evidence["stage_index"] is not None
                    and compute_evidence["stage_index"] != stage_index)):
            raise storage.StorageError("Compute stage is not completed with exact run and command linkage")
        requested, resolved = compute_evidence["requested_execution"], compute_evidence["resolved_execution"]
        expected_requested = {"backend": "fdm", "device": "cpu", "precision": "double", "mode": "strict"}
        if any(requested.get(key) != value for key, value in expected_requested.items()):
            raise storage.StorageError("Compute command did not request strict-double FDM CPU execution")
        resolved_backend = resolved.get("backend")
        if (resolved_backend != "fdm"
                or resolved.get("device") != "cpu" or resolved.get("precision") != "double"
                or resolved.get("mode") != "strict"):
            raise storage.StorageError("Compute command did not resolve to strict-double FDM CPU")
        for suffix in ("backend", "device", "precision", "mode"):
            if run.get("requested_" + suffix) != requested[suffix]:
                raise storage.StorageError("Current run differs from the Compute requested execution")
            if run.get("resolved_" + suffix) != resolved.get(suffix):
                raise storage.StorageError("Current run differs from the Compute resolved execution")
        scope_after = read_execution_scope(self.api_port, api_instance_id)
        if canonical(scope_after) != canonical(scope_before):
            raise storage.StorageError("API/session observation scope changed while reading execution receipts")
        close_evidence = None
        terminal_timestamp = None
        if require_terminal:
            if not isinstance(queue_before, dict) or not isinstance(queue_before.get("commands"), list):
                raise storage.StorageError("Terminal execution has no command ledger")
            closes = [item for item in queue_before.get("commands", [])
                      if isinstance(item, dict) and item.get("kind") == "close"
                      and type(item.get("created_at_unix_ms")) is int
                      and item["created_at_unix_ms"] >= compute_evidence["completed_at_unix_ms"]]
            if len(closes) != 1:
                raise storage.StorageError("Terminal Compute has no unique explicit Close command")
            close_id = closes[0].get("command_id")
            if not isinstance(close_id, str) or not close_id.strip():
                raise storage.StorageError("Terminal Close has no command identity")
            close_detail = read_api(self.api_port, api_instance_id,
                                   "/v2/sessions/current/simulation/commands/" + quote(close_id, safe=""))
            close_evidence = completed_command_detail(close_detail, close_id, "close")
            status = read_api(self.api_port, api_instance_id, "/v2/sessions/current/status")
            if (status.get("session", {}).get("session_epoch") != scope_after["session_resource_epoch"]
                    or canonical(read_execution_scope(self.api_port, api_instance_id)) != canonical(scope_after)
                    or stages.get("runtime_state") != "completed"
                    or any(not isinstance(item, dict) or item.get("status") != "completed"
                           for item in stages["stages"])):
                raise storage.StorageError("Terminal lifecycle changed while reading Close receipts")
            terminal_timestamp = validate_terminal_execution_scope(
                scope_after, restore["scope"], status.get("lifecycle"),
                max(stage["completed_at_unix_ms"], close_evidence["created_at_unix_ms"]), utc_ms())
        elif (not same_execution_scope(scope_after, restore.get("scope"))
              or scope_after["session_resource_epoch"] != restore["scope"]["session_resource_epoch"]):
            raise storage.StorageError("Stable API/session execution scope changed before Close")
        close_precondition = None
        if not require_terminal:
            queue_after = read_api(self.api_port, api_instance_id, "/v2/sessions/current/simulation/commands")
            if (not isinstance(queue_before, dict) or not isinstance(queue_after, dict)
                    or not isinstance(queue_before.get("commands"), list)
                    or canonical(queue_before["commands"]) != canonical(queue_after.get("commands"))
                    or any(not isinstance(item, dict) or item.get("status") not in {"completed", "failed", "rejected"}
                           for item in queue_before["commands"])
                    or stages.get("runtime_state") != "awaiting_command"
                    or type(stages.get("revision")) is not int or stages["revision"] < 0):
                raise storage.StorageError("Close readiness changed or another command is still pending")
            close_precondition = {"runtime_state": "awaiting_command",
                                  "command_revision": len(queue_before["commands"]),
                                  "stage_execution_revision": stages["revision"]}

        return {
            "api_instance_id": api_instance_id,
            "api_pid": api_pid,
            "api_response_pin": api_instance_id,
            "before_api_instance_id": before.get("api_instance_id"),
            "before_scene_sha256": hashlib.sha256(canonical(before["scene"]).encode()).hexdigest(),
            "scene_sha256": scene_sha256,
            "restore_scope": restore["scope"],
            "session_resource_epoch_transition": {
                "restored": restore["scope"]["session_resource_epoch"],
                "observation_start": scope_before["session_resource_epoch"],
                "observation_end": scope_after["session_resource_epoch"],
            },
            "observation_scope": scope_after,
            "close_precondition": close_precondition,
            "close": close_evidence,
            "session_finished_at_unix_ms": terminal_timestamp,
            "grid": {**grid_evidence, "child_pid": grid_entry["record"]["pid"],
                     "child_exit_code": grid_entry["record"]["exit_code"],
                     "kill_requested": grid_entry["record"]["kill_requested"]},
            "compute": {**compute_evidence, "child_pid": compute_entry["record"]["pid"],
                        "child_exit_code": compute_entry["record"]["exit_code"],
                        "kill_requested": compute_entry["record"]["kill_requested"],
                        "stage": {"stage_id": stage["stage_id"], "index": stage_index,
                                  "status": stage["status"],
                                  "started_at_unix_ms": stage["started_at_unix_ms"],
                                  "completed_at_unix_ms": stage["completed_at_unix_ms"]},
                        "run": {"run_id": run["run_id"], "status": run["status"],
                                "total_steps": run["total_steps"], "total_stages": run["total_stages"]}},
        }

    def capture_before(self, body):
        proof = self.eligibility()
        if (set(body) != {"schema", "nonce", "api_instance_id", "project_document_before", "project_document_after_grid"}
                or body["schema"] != "fullmag.development-browser-before.v1"
                or body["nonce"] != self.expected["nonce"]
                or body["api_instance_id"] != proof["api_instance_id"]
                or not isinstance(body["project_document_before"], dict)
                or not body["project_document_before"]):
            raise storage.StorageError("Browser before-capture has a different scope or empty draft")
        validate_after_grid_document(body["project_document_before"], body["project_document_after_grid"])
        scene = read_api(self.api_port, proof["api_instance_id"], "/v2/sessions/current/model/scene")
        objects = scene.get("objects")
        if not isinstance(objects, list) or not objects:
            raise storage.StorageError("Browser proof requires a nonempty canonical scene")
        identity, session_scope = read_session_identity(self.api_port, proof["api_instance_id"])
        camera = camera_for_proof(read_api(
            self.api_port, proof["api_instance_id"], "/v2/sessions/current/visualization/state"
        ).get("camera"))
        admission = read_admission_observation(self.api_port, proof["api_instance_id"])
        if (admission["scope"]["session_id"] != identity["session_id"]
                or admission["scope"]["session_resource_epoch"] != session_scope["session_resource_epoch"]
                or admission["scope"]["request_scope_epoch"] != session_scope["request_scope_epoch"]
                or canonical(scene) != canonical(read_api(
                    self.api_port, proof["api_instance_id"], "/v2/sessions/current/model/scene"))):
            raise storage.StorageError("Before capture changed while reading admission prerequisites")
        with self.lock:
            if self.before is not None:
                raise storage.StorageError("Browser before-capture is immutable")
            self.before = {**body, "scene": scene, "identity": identity, "session_scope": session_scope,
                           "admission_observation": admission, "camera": camera}
            self.receipt["workspace_browser_before"] = copy.deepcopy(self.before)
            if self.receipt_path is not None:
                storage.atomic_json(self.receipt_path, self.receipt)
        return {"captured": True, "object_count": len(objects),
                "scene_sha256": hashlib.sha256(canonical(scene).encode()).hexdigest()}

    def finish(self, body):
        with self.lock:
            if self.cancelled.is_set():
                raise storage.StorageError("Browser proof cancellation has already been submitted")
            before, restored = self.before, self.restored
        fields = {"schema", "nonce", "new_api_instance_id", "project_document_before", "project_document_after"}
        if (set(body) != fields or body.get("schema") != "fullmag.development-browser-finish.v1"
                or body.get("nonce") != self.expected["nonce"] or before is None or restored is None
                or body.get("new_api_instance_id") != restored.get("new_api_instance_id")
                or body["new_api_instance_id"] == before["api_instance_id"]
                or canonical(body["project_document_before"]) != canonical(before["project_document_before"])
                or canonical(body["project_document_after"]) != canonical(before["project_document_after_grid"])):
            raise storage.StorageError("Browser hydration does not preserve the captured draft and new pin")
        camera_evidence = validate_camera_preservation(before["camera"], read_api(
            self.api_port, body["new_api_instance_id"], "/v2/sessions/current/visualization/state"
        ).get("camera"))
        execution = self.execution()
        scene = read_api(self.api_port, body["new_api_instance_id"], "/v2/sessions/current/model/scene")
        identity, session_scope = read_session_identity(self.api_port, body["new_api_instance_id"])
        if (canonical(scene) != canonical(scene_after_successful_grid(before["scene"]))
                or identity["api_instance_id"] != body["new_api_instance_id"]
                or identity["session_id"] == before["identity"]["session_id"]
                or identity["session_epoch"] != 1):
            raise storage.StorageError("Native restart changed the scene or failed to establish the fresh session")
        if (session_scope["request_scope_epoch"] == before["session_scope"]["request_scope_epoch"]
                or session_scope["session_resource_epoch"] == before["session_scope"]["session_resource_epoch"]):
            raise storage.StorageError("Native restart reused the old session resource scope")
        command = {"schema": "fullmag.development-browser-native-command.v1", "event": "finish",
                   "nonce": self.expected["nonce"], "new_api_instance_id": body["new_api_instance_id"]}
        with self.lock:
            if self.cancelled.is_set():
                raise storage.StorageError("Browser proof cancellation has already been submitted")
            if self.browser is not None:
                raise storage.StorageError("Browser finish has already been submitted")
            self.receipt["workspace_browser_camera"] = camera_evidence
            self.browser = {**body, "scene_sha256": hashlib.sha256(canonical(scene).encode()).hexdigest(),
                            "identity": identity, "session_scope": session_scope}
            self.process.stdin.write((canonical(command) + "\n").encode())
            self.process.stdin.flush()
            self.finished.set()
        return {"verified": True, "execution": execution}


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
                if self.path == "/eligibility":
                    value = bridge.eligibility()
                elif self.path == "/execution":
                    value = bridge.execution()
                elif self.path == "/completed-stage":
                    value = bridge.execution(require_terminal=False)
                else:
                    raise storage.StorageError("Unknown private proof resource")
                self.send_json(200, value)
            except Exception as error:
                self.send_json(409, {"error": str(error)})

        def do_POST(self):
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= MAX_FRAME:
                    raise storage.StorageError("Private browser command exceeds its byte limit")
                raw = self.rfile.read(size)
                if self.headers.get("Origin") != bridge.expected["ui_origin"]:
                    raise storage.StorageError("Private browser command has a different origin")
                body = json.loads(raw)
                if not isinstance(body, dict):
                    raise storage.StorageError("Private browser command is not an object")
                method = {"/before": bridge.capture_before, "/finish": bridge.finish,
                          "/cancel": bridge.cancel}.get(self.path)
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
    env = {**base_env, "PYTHONDONTWRITEBYTECODE": "1",
           "FULLMAG_REPO_ROOT": str(repo), "FULLMAG_DEVELOPMENT_OWNER_PROBE": "1",
           "FULLMAG_NATIVE_RUNTIME_ACTIVE": "1", "FULLMAG_STORAGE_PROFILE": "windows-native-fdm-cpu-dev",
           "FULLMAG_PROJECT_STORAGE_ROOT": str(storage_root), "FULLMAG_WORKTREE_ID": native["worktree_id"],
           "FULLMAG_RUNS_ROOT": native["runs_root"], "FULLMAG_PYTHON": str(build_root / "python/fullmag/Scripts/python.exe"),
           "FULLMAG_STATE_ROOT": str(state_root), "FULLMAG_STATE_DIR": str(state_root),
           "FULLMAG_API_PORT": str(api_port),
           "FULLMAG_ACCEPTED_STORE_SCOPE": scope, "FULLMAG_DEVELOPMENT_BACKEND_GENERATION": generation,
           "FULLMAG_DEVELOPMENT_BACKEND_SOURCE": expected["ready_source_sha256"],
           "FULLMAG_DEVELOPMENT_BACKEND_VERSION": manifest["build_version"]["product_version"],
           "FULLMAG_DEVELOPMENT_BACKEND_STATUS_FILE": str(status),
           "FULLMAG_DEVELOPMENT_RESTART_PROBE_CASE": "browser-workspace",
           "FULLMAG_SCRATCH_PROOF_NONCE": expected["nonce"]}
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
    for required in ("typescript-native/bin/tsc", "@types/node/index.d.ts", "@types/react/index.d.ts"):
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
        ' if (!["eligibility","execution","completed-stage","before","finish","cancel"].includes(operation)) return new Response(null,{status:404});\n'
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
        ("typecheck", [node, str(dependencies / "typescript-native/bin/tsc"), "--noEmit", "--project", str(config)]),
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
    scratch_records = {}
    terminal = False
    result_confirmed = False
    try:
        check_material_anisotropy_plans(binaries, fixture, env, receipt)
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
        bridge = ProofBridge(expected, int(env["FULLMAG_API_PORT"]), reader, process,
                             receipt, scratch_records, run_root / "receipt.json")
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
        deadline = time.monotonic() + 1800
        announced = False
        while time.monotonic() < deadline:
            if bridge.cancelled.is_set():
                raise storage.StorageError("Private browser proof cancelled; collecting terminal custody")
            if reader.error is not None:
                raise storage.StorageError(f"Native browser observation failed: {reader.error}")
            try:
                frame = reader.items.get(timeout=0.2)
            except queue.Empty:
                frame = None
            if frame is not None:
                schema = frame.get("schema")
                with bridge.lock:
                    scratch_frame = record_scratch_child_frame(frame, expected, scratch_records, receipt)
                if scratch_frame:
                    pass
                elif record_started_frame(frame, api_records, helper_records, receipt):
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
                elif schema in {RESTORED_SCHEMA_V1, RESTORED_SCHEMA_V2}:
                    with bridge.lock:
                        before = copy.deepcopy(bridge.before)
                    source_pids = {log["pid"] for log in receipt.get("workspace_browser_api_logs", [])
                                   if before is not None and log["api_instance_id"] == before.get("api_instance_id")}
                    source_pid = next(iter(source_pids)) if len(source_pids) == 1 else None
                    frame = validate_restored_frame(frame, expected, before, source_pid)
                    receipt["workspace_browser_restore_protocol"] = restore_protocol_scope(frame)
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
                    # Capture the exact restored authoring state before the
                    # browser can submit a new Grid/Compute operation.
                    bridge.capture_restored_observation()
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
        terminal = terminal_custody(api_records, helper_records, scratch_records, receipt)
        receipt["workspace_browser_result"] = result
        if not terminal:
            raise storage.StorageError("Native browser API, helper, or scratch child terminal custody remains unknown")
        if (process.returncode != 0 or result.get("status") != "passed" or bridge.browser is None
                or bridge.restored is None or result["new_api_instance_id"] != bridge.browser["new_api_instance_id"]
                or result["old_api_instance_id"] != bridge.before["api_instance_id"]
                or result["new_api_pid"] == result["old_api_pid"]):
            raise storage.StorageError("Native custody and actual browser hydration did not both pass")
        receipt["workspace_browser_hydration"] = bridge.browser
        if receipt.get("workspace_browser_restore_protocol", {}).get("authenticated_request_binding") is True:
            receipt["checks"].append("browser-authenticated-v2-request-and-source-custody")
        receipt["checks"].extend(["browser-private-native-readiness", "browser-nonempty-scene-captured",
                                   "browser-exact-scene-restored", "browser-fresh-session-and-api-pin",
                                   "browser-unsaved-document-restored", "browser-native-processes-waited",
                                   "browser-restored-grid-normal-wait", "browser-restored-compute-terminal-success"])
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
                    try:
                        with bridge.lock:
                            scratch_frame = record_scratch_child_frame(
                                cleanup_frame, expected, scratch_records, receipt)
                        if scratch_frame:
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
                            and reader.error is None
                            and terminal_custody(api_records, helper_records, scratch_records, receipt))
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
        if bridge is not None:
            with bridge.lock:
                storage.atomic_json(run_root / "receipt.json", receipt)
        else:
            storage.atomic_json(run_root / "receipt.json", receipt)
