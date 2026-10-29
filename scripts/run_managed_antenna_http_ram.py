"""Bounded real antenna HTTP gate using an existing managed CPU package.

All application state remains in tmpfs. Host tools have their own immutable
manifest; they are not attributed to the solver source capsule. No build or
durable SessionStore qualification is performed. A fresh API process imports
the bounded native archive before repeating the real HTTP checks.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import re
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
import uuid
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import ProxyHandler, Request, build_opener

PROFILE = "managed-antenna-http-ram-cpu"
SCHEMA = "fullmag.managed-antenna-http-ram.v1"
TOOLS_V1 = (
    "run_managed_antenna_http_ram.py", "smoke_antenna_external_lead_inspection.py",
    "smoke_antenna_inspection_display.py", "antenna_rt0_fixture_check.py",
    "antenna_current_display_fixture_check.py", "antenna_current_source_oracle.py",
    "antenna_inspection_cold_import_check.py",
    "antenna_standalone_fixture.py",
)
TOOLS_V2 = TOOLS_V1 + ("smoke_antenna_closed_loop_inspection.py",)
CANONICAL_FIELD_SMOKE = "smoke_antenna_artifact_fields.py"
TOOLS = TOOLS_V2 + (CANONICAL_FIELD_SMOKE,)
ORIGIN = "http://127.0.0.1:8081"
MAX_JSON = 4 << 20


MAX_ARCHIVE = 16 << 20
NONMAGNETIC_SHA = "e3ce550d020ca3e2c811b87f3686890a671b6bf592521a8af5ecfdff06986199"


CLOSEDLOOP_SHA = "16904540d169037480b563ec05e4cdb786c772caefba8c3e5a9b66365aa22a62"
BROWSER_SECONDS = 600
BROWSER_RUN_SECONDS = 1800
BROWSER_JSON_BOUND = 64 << 10
BROWSER_UNITS = {"V": "V", **{name: "A/m^2" for name in ("Jx", "Jy", "Jz", "|J|")},
                 **{name: "A/m" for name in ("Hx", "Hy", "Hz", "|H|")}}


def browser_port(value):
    if value is not None and (type(value) is not int or not 1024 <= value <= 65535 or value == 3197):
        raise ValueError("Invalid browser inspection port; the user workspace port 3197 is forbidden")
    return value


def browser_file(root, relative, limit):
    if not isinstance(relative, str) or not relative or "\\" in relative or ":" in relative:
        raise ValueError("Invalid browser evidence path")
    parts = relative.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("Browser evidence must remain inside its owned export")
    path = Path(root)
    for part in parts:
        path = path / part
        if path.is_symlink() or getattr(path.lstat(), "st_file_attributes", 0) & 0x400:
            raise ValueError("Browser evidence must not contain links or reparse points")
    if not path.is_file() or not 0 < path.stat().st_size <= limit:
        raise ValueError("Browser evidence is absent or oversized")
    return path


def browser_json(root, name, limit=BROWSER_JSON_BOUND):
    return json.loads(browser_file(root, name, limit).read_text(encoding="utf-8"))


def check_browser_mode(mode, port):
    if mode is None and port is None:
        return
    if not isinstance(mode, dict) or set(mode) != {"port", "nonce", "compose_sha256"} \
            or browser_port(mode.get("port")) != port or port is None \
            or not re.fullmatch(r"[0-9a-f]{32}", str(mode.get("nonce", ""))) \
            or not re.fullmatch(r"[0-9a-f]{64}", str(mode.get("compose_sha256", ""))):
        raise ValueError("Pinned browser inspection mode differs")


def write_browser_json(root, name, value):
    raw = (json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
    if len(raw) > BROWSER_JSON_BOUND:
        raise ValueError("Browser control document exceeds its bound")
    path = Path(root) / name
    if path.exists() or path.is_symlink():
        browser_file(root, name, BROWSER_JSON_BOUND)
    temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex + ".tmp")
    with temporary.open("xb") as stream:
        stream.write(raw)
    os.replace(temporary, path)


def browser_binding(metadata, mode, archive_sha256, tools_sha256, api_pid):
    if type(api_pid) is not int or api_pid <= 0:
        raise ValueError("Missing cold browser API process identity")
    binding = {key: metadata.get(key) for key in
               ("session_id", "run_id", "request_scope_epoch", "record_content_digest")}
    if any(not isinstance(value, str) or not value for value in binding.values()):
        raise ValueError("Missing cold browser scientific identity")
    return {**binding, **mode, "archive_sha256": archive_sha256,
            "tool_manifest_sha256": tools_sha256, "cold_api_pid": api_pid}


def check_browser_ready(export, mode, tools_sha256, *, terminal=False):
    ready = browser_json(export, "browser-ready.json")
    metadata = browser_json(export, "cold-inspection-metadata.json", MAX_JSON)
    archive = browser_file(export, "snapshot.fms", MAX_ARCHIVE)
    binding = ready.get("binding", {})
    if ready.get("schema") != "fullmag.antenna-cold-browser-ready.v1" or ready.get("state") != "browser_ready" \
            or ready.get("terminal") is not False or ready.get("browser_checked") is not False \
            or ready.get("session_storage") != "disposable_tmpfs" \
            or ready.get("physics_qualified") is not False or ready.get("durable_session_storage_qualified") is not False \
            or binding != browser_binding(metadata, mode, sha(archive), tools_sha256, binding.get("cold_api_pid")) \
            or ready.get("window_seconds") != BROWSER_SECONDS \
            or ready.get("url") != f"http://127.0.0.1:{mode['port']}/workspace":
        raise ValueError("Cold browser readiness identity differs")
    started, expires = ready.get("ready_at"), ready.get("expires_at")
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in (started, expires)) \
            or expires - started != BROWSER_SECONDS or not terminal and not started <= time.time() < expires:
        raise ValueError("Cold browser inspection window is expired or invalid")
    return ready


def check_browser_proof(export, ready, expected_sha256):
    path = browser_file(export, "browser-proof.json", BROWSER_JSON_BOUND)
    if not isinstance(expected_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_sha256) \
            or sha(path) != expected_sha256:
        raise ValueError("Browser proof hash differs")
    proof = browser_json(export, "browser-proof.json")
    if proof.get("schema") != "fullmag.antenna-cold-browser-proof.v1" \
            or proof.get("scope") != "browser_inspection_only" or proof.get("status") != "pass" \
            or proof.get("binding") != ready["binding"] \
            or proof.get("ready_sha256") != sha(Path(export) / "browser-ready.json") \
            or any(proof.get(key) is not False for key in ("physics_qualified", "durable_session_storage_qualified", "fixture_or_mock_used")) \
            or proof.get("page_errors") != [] or proof.get("shader_errors") != []:
        raise ValueError("Browser proof owner, scope or error evidence differs")
    canvas = proof.get("canvas", {})
    if canvas.get("visible") is not True or canvas.get("context_lost") is not False \
            or any(type(canvas.get(key)) is not int or not 0 < canvas[key] <= 16384 for key in ("width", "height")) \
            or proof.get("camera_rotation_checked") is not True \
            or type(proof.get("solve_count_before")) is not int or proof["solve_count_before"] < 0 \
            or proof.get("solve_count_after") != proof["solve_count_before"] \
            or any(type(proof.get(key)) is not int or not 0 <= proof[key] <= limit
                   for key, limit in (("request_count", 512), ("idle_request_count", 4))):
        raise ValueError("Browser canvas, solve-count or bounded-idle evidence is missing")
    screenshots = proof.get("screenshots")
    if not isinstance(screenshots, list) or not 1 <= len(screenshots) <= 16:
        raise ValueError("Browser proof needs at most 16 retained screenshots")
    pictures, total = {}, 0
    for entry in screenshots:
        relative = entry.get("path")
        if not isinstance(relative, str) or not relative.startswith("browser/") or relative in pictures:
            raise ValueError("Browser screenshot path is not owned or is duplicated")
        picture = browser_file(export, relative, 32 << 20)
        with picture.open("rb") as stream:
            signature = stream.read(8)
        if not (picture.suffix == ".png" and signature == b"\x89PNG\r\n\x1a\n" or
                picture.suffix in (".jpg", ".jpeg") and signature.startswith(b"\xff\xd8\xff")) \
                or type(entry.get("size_bytes")) is not int or entry["size_bytes"] != picture.stat().st_size \
                or entry.get("sha256") != sha(picture):
            raise ValueError("Browser screenshot bytes, size or hash differ")
        total += picture.stat().st_size
        pictures[relative] = entry["sha256"]
    frames = proof.get("quantities")
    if total > 32 << 20 or not isinstance(frames, list) or len(frames) != len(BROWSER_UNITS) \
            or {entry.get("quantity") for entry in frames} != set(BROWSER_UNITS) \
            or len({entry.get("screenshot") for entry in frames}) != len(frames) \
            or any(entry.get("unit") != BROWSER_UNITS[entry["quantity"]] or entry.get("screenshot") not in pictures for entry in frames) \
            or sha(path) != expected_sha256:
        raise ValueError("Browser V/J/H frames, SI units or total screenshot bound differ")
    # This validates an observer's browser evidence, not scientific correctness.
    return {"scope": "browser_inspection_only", "status": "pass",
            "proof_sha256": expected_sha256, "screenshots": pictures}


def browser_window(api, export, mode, result, cold):
    with build_opener(ProxyHandler({})).open(ORIGIN + "/workspace", timeout=5) as response:
        document = response.read(MAX_JSON + 1)
        if response.status != 200 or not document or len(document) > MAX_JSON \
                or "text/html" not in response.headers.get("Content-Type", ""):
            raise ValueError("Packaged cold workspace HTML is unavailable")
    result["browser_workspace_html_sha256"] = hashlib.sha256(document).hexdigest()
    started = time.time()
    ready = {"schema": "fullmag.antenna-cold-browser-ready.v1", "state": "browser_ready",
        "terminal": False, "browser_checked": False, "window_seconds": BROWSER_SECONDS,
        "session_storage": "disposable_tmpfs", "physics_qualified": False, "durable_session_storage_qualified": False,
        "ready_at": started, "expires_at": started + BROWSER_SECONDS,
        "url": f"http://127.0.0.1:{mode['port']}/workspace",
        "binding": browser_binding(cold, mode, result["archive_sha256"], result["tool_manifest_sha256"], api.pid)}
    write_browser_json(export, "browser-ready.json", ready)
    deadline = time.monotonic() + BROWSER_SECONDS
    while time.monotonic() < deadline:
        if api.poll() is not None:
            raise ValueError("Owned cold API exited during browser inspection")
        if (export / "browser-completion.json").exists():
            completion = browser_json(export, "browser-completion.json")
            if completion.get("schema") != "fullmag.antenna-cold-browser-completion.v1" \
                    or completion.get("binding") != ready["binding"] \
                    or completion.get("ready_sha256") != sha(export / "browser-ready.json"):
                raise ValueError("Browser completion belongs to another cold window")
            summary = check_browser_proof(export, ready, completion.get("proof_sha256"))
            current = get_json("/v2/sessions/current/data/antenna/stages/stage-000/external-lead-inspection")
            if browser_binding(current, mode, sha(export / "snapshot.fms"), result["tool_manifest_sha256"], api.pid) != ready["binding"]:
                raise ValueError("Cold scientific owner changed during browser inspection")
            return {**summary, "ready_sha256": sha(export / "browser-ready.json"),
                    "completion_sha256": sha(export / "browser-completion.json"), "completed_at": time.time()}
        time.sleep(0.25)
    raise ValueError("Browser inspection timed out after its fixed 600 second window")


def fixture_contract(fixture="magnetic"):
    import run_managed_antenna_ram as ram
    files = dict(ram.FIXTURE_FILES)
    if fixture == "nonmagnetic":
        files.pop("fem_antenna_current_source_inspection.py")
        files["fem_antenna_field_only_nonmagnetic.py"] = NONMAGNETIC_SHA
    elif fixture == "closedloop":
        files = {"fem_antenna_closed_loop_nonmagnetic.py": CLOSEDLOOP_SHA}
    elif fixture != "magnetic":
        raise ValueError("Unsupported antenna fixture")
    return files


def sha(path):
    with Path(path).open("rb") as stream:
        digest = hashlib.sha256()
        while chunk := stream.read(1 << 20):
            digest.update(chunk)
        return digest.hexdigest()


def tool_manifest(root, names=TOOLS):
    paths = [root / name for name in names]
    if any(path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_JSON
           for path in paths):
        raise ValueError("HTTP gate requires bounded regular host tool files")
    return {name: sha(root / name) for name in names}


def check_tools(root, expected):
    if set(expected) not in (set(TOOLS_V1), set(TOOLS_V2), set(TOOLS)) or tool_manifest(root, tuple(expected)) != expected:
        raise ValueError("HTTP gate host tool identity changed")


class HttpDiagnosticError(ValueError):
    def __init__(self, diagnostic):
        self.diagnostic = diagnostic
        super().__init__(f"HTTP gate GET {diagnostic['path']}: "
                         f"status {diagnostic.get('status')}: "
                         f"{diagnostic.get('error', diagnostic.get('body', ''))}")


def read_http(path):
    opener = build_opener(ProxyHandler({}))
    try:
        response = opener.open(ORIGIN + path, timeout=3)
    except HTTPError as error:
        response = error
    with response:
        data = response.read(MAX_JSON + 1)
        status = response.code
    diagnostic = {"path": path, "status": status}
    if status != 200 or len(data) > MAX_JSON:
        # Preserve exact bounded response bytes, including a non-JSON error.
        retained = data[:65536]
        diagnostic.update(body=retained.decode("utf-8", errors="replace"),
            body_base64=base64.b64encode(retained).decode(),
            body_truncated=len(data) > len(retained))
        if len(data) > MAX_JSON:
            diagnostic["error"] = "metadata response exceeds contract"
        raise HttpDiagnosticError(diagnostic)
    try:
        return json.loads(data)
    except (ValueError, UnicodeDecodeError) as error:
        retained = data[:65536]
        diagnostic.update(error=str(error),
            body=retained.decode("utf-8", errors="replace"),
            body_base64=base64.b64encode(retained).decode(),
            body_truncated=len(data) > len(retained))
        raise HttpDiagnosticError(diagnostic) from error


def get_json(path):
    return read_http(path)


def error_diagnostic(path, error):
    if isinstance(error, HttpDiagnosticError):
        return error.diagnostic
    return {"path": path, "error": str(error)}


def retain_inspection_failure(export, last_error, last_metadata):
    diagnostic = {"last_poll_error": last_error,
                  "last_200_inspection_metadata": last_metadata, "resources": {}}
    paths = ("/v2/sessions/current", "/v2/sessions/current/status",
             "/v2/sessions/current/simulation/runs/current",
             "/v2/sessions/current/simulation/stages/execution",
             "/v2/sessions/current/data/artifacts")
    keys = {"schema_version", "session_id", "session_epoch", "request_scope_epoch",
            "state_version", "revision", "revisions", "status", "session", "run",
            "run_id", "artifact_dir", "active_stage_index", "active_stage_kind",
            "total_stages", "runtime_state", "completed_stage_indexes", "stages"}
    for path in paths:
        try:
            value = get_json(path)
            if isinstance(value, dict):
                value = {key: item for key, item in value.items() if key in keys}
            diagnostic["resources"][path] = {"status": 200, "resource": value}
        except (OSError, ValueError) as error:
            diagnostic["resources"][path] = error_diagnostic(path, error)
    (export / "inspection-failure-diagnostic.json").write_text(
        json.dumps(diagnostic, sort_keys=True), encoding="utf-8")
    return "inspection-failure-diagnostic.json"


def wait_inspection(export, timeout=15):
    path = "/v2/sessions/current/data/antenna/stages/stage-000/external-lead-inspection"
    deadline = time.monotonic() + timeout
    last_error = None
    metadata = None
    while time.monotonic() < deadline:
        try:
            candidate = get_json(path)
            metadata = candidate
            if isinstance(candidate, dict) and candidate.get("runtime_stage_id") == "stage-000":
                return candidate
            last_error = {"path": path, "status": 200,
                          "error": "inspection runtime_stage_id differs from stage-000"}
        except (OSError, ValueError) as error:
            last_error = error_diagnostic(path, error)
        time.sleep(0.25)
    retain_inspection_failure(export, last_error, metadata)
    raise ValueError("Real solve did not register its inspection stage; "
                     "read inspection-failure-diagnostic.json")


def post_json(path, payload, limit=MAX_JSON):
    body = json.dumps(payload).encode()
    if len(body) > 2 * MAX_ARCHIVE:
        raise ValueError("Archive request exceeds bounded gate support")
    request = Request(ORIGIN + path, data=body,
                      headers={"Content-Type": "application/json"}, method="POST")
    with build_opener(ProxyHandler({})).open(request, timeout=120) as response:
        raw = response.read(limit + 1)
        if response.status != 200 or len(raw) > limit:
            raise ValueError("Archive response exceeds bounded gate support")
        return json.loads(raw)


def export_archive(export):
    response = post_json("/v2/sessions/current/persistence/exports",
                         {"profile": "archive"}, 2 * MAX_ARCHIVE)
    encoded = response.get("fms_base64")
    if not isinstance(encoded, str) or len(encoded) > 2 * MAX_ARCHIVE:
        raise ValueError("Missing or oversized native archive")
    raw = base64.b64decode(encoded, validate=True)
    if not raw or len(raw) > MAX_ARCHIVE or response.get("size_bytes") != len(raw) \
            or response.get("profile") != "archive":
        raise ValueError("Native archive size/profile differs")
    (export / "snapshot.fms").write_bytes(raw)
    return encoded, response["session_id"]


def smoke_scripts(fixture_script):
    return ("smoke_antenna_closed_loop_inspection.py",) if fixture_script == "fem_antenna_closed_loop_nonmagnetic.py" else ("smoke_antenna_external_lead_inspection.py", "smoke_antenna_inspection_display.py")


def compare_cold_metadata(warm, cold):
    # Revisions and request incarnation must change; scientific identity must not.
    if not warm.get("outputs") or warm.get("runtime_stage_id") != "stage-000" \
            or warm.get("runtime_stage_id") != cold.get("runtime_stage_id") \
            or warm.get("outputs") != cold.get("outputs"):
        raise ValueError("Cold archive changed canonical inspection identity")
    if warm.get("schema_version") == "antenna_closed_loop_stage_output.v2":
        if cold.get("schema_version") != warm["schema_version"] or warm.get("closed_loop_manifest") != cold.get("closed_loop_manifest") or warm.get("record_content_digest") != cold.get("record_content_digest") or warm.get("session_id") != cold.get("session_id") or warm.get("run_id") != cold.get("run_id"):
            raise ValueError("Cold archive changed closed-loop scientific identity")
        if warm.get("request_scope_epoch") == cold.get("request_scope_epoch"):
            raise ValueError("Cold import reused the warm request incarnation")


def wait_api(api, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if api.poll() is not None:
            raise ValueError("Owned RAM API exited before readiness")
        try:
            spec = get_json("/v2/platform/openapi.json")
            route = "/v2/sessions/current/data/antenna/stages/{stage_id}/external-lead-inspection"
            if all(route + suffix in spec["paths"] for suffix in
                   ("", "/display", "/payloads/{payload_kind}")):
                return
        except (OSError, ValueError, KeyError):
            pass
        time.sleep(0.25)
    raise ValueError("Owned RAM API did not expose inspection OpenAPI in time")


def stop_owned(api):
    if api is None or api.poll() is not None:
        return
    api.terminate()
    try:
        api.wait(timeout=10)
    except subprocess.TimeoutExpired:
        api.kill()
        api.wait(timeout=10)


def smoke(script, stage, export):
    # -I excludes ambient Python imports; only the pinned tools directory is
    # explicitly introduced. The numerical publisher remains the package.
    code = "import runpy,sys; sys.path.insert(0,'/tools'); runpy.run_path(sys.argv.pop(1),run_name='__main__')"
    with (export / (script + ".log")).open("wb") as log:
        completed = subprocess.run([sys.executable, "-I", "-B", "-c", code,
            "/tools/" + script, "--origin", ORIGIN, "--stage-id", stage],
            stdout=log, stderr=subprocess.STDOUT, timeout=120)
    if completed.returncode:
        raise ValueError(f"Real HTTP smoke failed: {script}; read retained log")
    raw = (export / (script + ".log")).read_bytes()
    if len(raw) > MAX_JSON:
        raise ValueError("HTTP smoke result exceeds JSON bound")
    result = json.loads(raw)
    expected_status = {
        "smoke_antenna_external_lead_inspection.py": "pass",
        "smoke_antenna_inspection_display.py": "passed",
        "smoke_antenna_closed_loop_inspection.py": "pass",
        CANONICAL_FIELD_SMOKE: "passed",
    }.get(script)
    if expected_status is None or result.get("status") != expected_status \
            or result.get("physics_qualified") is not False:
        raise ValueError("HTTP smoke failed or promoted inspection scope")
    return result


def canonical_field_identity(report):
    if report.get("schema") != "fullmag.antenna_artifact_fields_http.v1" \
            or report.get("status") != "passed" or report.get("physics_qualified") is not False \
            or report.get("production_frontend_codec_qualified") is not False \
            or report.get("cold_load_qualified") is not False \
            or report.get("inspection_family") != "closed_loop" \
            or report.get("runtime_stage_id") != "stage-000" or not report.get("run_id"):
        raise ValueError("Canonical field HTTP report is absent or promotes qualification")
    fields = report.get("fields")
    if not isinstance(fields, dict) or set(fields) != {"V_electric", "J_charge", "H_ant"}:
        raise ValueError("Canonical HTTP must retain exactly V, J and H")
    identity = {}
    for quantity, unit, components in (("V_electric", "V", 1), ("J_charge", "A/m^2", 3), ("H_ant", "A/m", 3)):
        field = fields[quantity]
        if not isinstance(field, dict) or field.get("unit") != unit or field.get("components") != components \
                or type(field.get("samples")) is not int or field["samples"] <= 0 \
                or not isinstance(field.get("values_sha256"), str) \
                or not re.fullmatch(r"[0-9a-f]{64}", field["values_sha256"]):
            raise ValueError("Canonical field units, cardinality or value digest differ")
        stable_digests = ("positions_sha256", "sample_identity_sha256", "connectivity_sha256")
        if any(not isinstance(field.get(key), str) or not re.fullmatch(r"[0-9a-f]{64}", field[key]) for key in stable_digests):
            raise ValueError("Canonical field geometry or lossless sample identity is absent")
        # Session-scoped carriers and encoded headers change after cold import.
        identity[quantity] = {key: field[key] for key in ("unit", "components", "samples", "values_sha256", *stable_digests)}
    return {"run_id": report["run_id"], "fields": identity}


def reject_stale_terminal_owners():
    """Probe only this owned RAM API after the scientific read-back.

    This is a negative admission test, not a concurrent-race or timeout proof.
    It does not inject scientific fields or stage references.
    """
    before = get_json("/v2/sessions/current/status")
    session = before["session"]
    run = before["run"]
    scope = session["request_scope_epoch"]
    epoch = int(scope.rsplit(":", 1)[1])
    owner = {"session_id": session["session_id"], "run_id": run["run_id"],
             "session_epoch": epoch, "request_scope_epoch": scope,
             "require_empty": False}
    cases = {
        "wrong_run": ({**owner, "run_id": owner["run_id"] + "-stale"}, 409),
        "wrong_epoch": ({**owner, "session_epoch": epoch + 1}, 409),
        "wrong_instance": ({**owner, "request_scope_epoch": "other-api:" + str(epoch)}, 409),
        "missing_bootstrap_payload": ({"session_id": owner["session_id"],
                               "run_id": owner["run_id"], "require_empty": True}, 409),
        "malformed_guard": ({**owner, "unknown": True}, 400),
    }
    results = {}
    body = json.dumps({"session_id": owner["session_id"],
                       "metadata": {"terminal_guard_rejection_probe": True}}).encode()
    opener = build_opener(ProxyHandler({}))
    publisher_scope = "&".join(key + "=" + quote(value, safe="~()*!.'-") for key, value in (
        ("session", session["session_id"]), ("epoch", session["session_epoch"]),
        ("request_scope_epoch", scope)))
    for name, (guard, expected) in cases.items():
        request = Request(ORIGIN + "/v2/sessions/current/internal/live/snapshot",
            data=body, method="POST", headers={"content-type": "application/json",
            "x-fullmag-terminal-owner": json.dumps(guard), "x-fullmag-session-scope": publisher_scope})
        try:
            with opener.open(request, timeout=5) as response:
                raise ValueError(f"Stale terminal owner accepted: {name}: {response.status}")
        except HTTPError as error:
            raw = error.read(4097)
            if error.code != expected or len(raw) > 4096:
                raise ValueError(f"Unexpected terminal guard rejection: {name}: {error.code}")
            detail = json.loads(raw)
            message = ("terminal_snapshot_owner_stale" if expected == 409
                       else "invalid terminal snapshot owner header")
            error_code = "terminal_snapshot_owner_stale" if expected == 409 else "bad_request"
            if not isinstance(detail, dict) or detail.get("error") != message \
                    or detail.get("message") != message \
                    or detail.get("code") != error_code:
                raise ValueError(f"Unrelated error is not a terminal guard rejection: {name}")
            results[name] = {"http_status": error.code}
    after = get_json("/v2/sessions/current/status")
    if any(after[key] != before[key] for key in ("session", "run", "resources", "lifecycle")):
        raise ValueError("Rejected terminal guard changed owner or resource revisions")
    return {"status": "pass", "cases": results,
            "concurrent_race_qualified": False, "timeout_qualified": False,
            "nonempty_bootstrap_qualified": False}


def check_standalone_read_model():
    before = get_json("/v2/sessions/current/status")
    fields = get_json("/v2/sessions/current/data/fields")
    catalog = get_json("/v2/sessions/current/data/quantities")
    mesh = get_json("/v2/sessions/current/meshing/summary")
    if fields.get("quantities") != []:
        raise ValueError("Standalone session exposes spatial magnetic carriers")
    entries = catalog.get("quantities")
    if not isinstance(entries, list) or any(not isinstance(entry, dict) for entry in entries):
        raise ValueError("Standalone quantity catalog is malformed")
    for quantity in ("m", "H_eff", "H_demag"):
        matches = [entry for entry in entries if entry.get("id") == quantity]
        if len(matches) != 1 or any(matches[0].get(key) != "unsupported" for key in
                ("capability_state", "solver_capability", "materialization_state")) \
                or any(matches[0].get(key) is not False for key in ("requestable", "materializable")):
            states = [{key: entry.get(key) for key in (
                "id", "capability_state", "solver_capability", "materialization_state",
                "requestable", "materializable", "materialization_reason_code",
            )} for entry in matches[:2]]
            raise ValueError("Standalone magnetic quantity state is not rejected: "
                             + json.dumps(states, sort_keys=True))
    if any(mesh.get(key) is not None for key in ("mesh_summary", "mesh_quality_summary",
            "effective_airbox_target", "effective_per_object_targets")):
        raise ValueError("Standalone session retains a magnetic mesh read-model")
    after = get_json("/v2/sessions/current/status")
    if any(after[key] != before[key] for key in ("session", "run", "resources", "lifecycle")):
        raise ValueError("Standalone read-model changed ownership or revisions during reads")
    return {"status": "pass", "field_catalog": fields, "mesh_summary": mesh,
            "unsupported_magnetic_quantities": ["m", "H_eff", "H_demag"],
            "transition_from_magnetic_session_qualified": False}


def execute_in_container(verify_cold_import=False, standalone=False, browser_inspection_port=None):
    export, tools = Path("/export"), Path("/tools")
    expected = json.loads((tools / "manifest.json").read_text())
    check_tools(tools, expected["tools_sha256"])
    # The container uses -I; admit only the verified, read-only tool directory.
    sys.path.insert(0, str(tools))
    from antenna_standalone_fixture import SCRIPT_NAME
    fixture = expected.get("fixture", "magnetic")
    port = browser_port(browser_inspection_port)
    mode = expected.get("browser_inspection")
    check_browser_mode(mode, port)
    if port is not None and (fixture != "closedloop" or standalone or verify_cold_import) \
            or port is None and mode is not None \
            or port is not None and (not isinstance(mode, dict) or mode.get("port") != port):
        raise ValueError("Browser inspection requires its explicit pinned closed-loop mode")
    if fixture not in ("magnetic", "nonmagnetic", "closedloop") or standalone and fixture != "magnetic":
        raise ValueError("Unsupported antenna fixture combination")
    if fixture == "closedloop" and verify_cold_import:
        raise ValueError("The optional legacy cold-import probe supports external leads; closed-loop uses the restarted API gate")
    variant = "standalone" if standalone else (fixture if fixture != "magnetic" else "magnetic_probe")
    if expected.get("fixture_variant", "magnetic_probe") != variant:
        raise ValueError("HTTP fixture variant differs from owned command")
    script = SCRIPT_NAME if standalone else "fem_antenna_current_source_inspection.py"
    fixture_sha = expected["fixture_sha256"]
    fixture_script = expected.get("fixture_script", script)
    selected_smokes = smoke_scripts(fixture_script)
    if fixture_script not in fixture_sha or standalone and fixture_script != SCRIPT_NAME:
        raise ValueError("Fixture script is absent from pinned inputs")
    for name, digest in fixture_sha.items():
        path = Path("/input") / name
        if path.is_symlink() or not path.is_file() or sha(path) != digest:
            raise ValueError("Staged fixed scientific input changed")
    if any(os.environ.get(key) != value for key, value in {
        "FULLMAG_REPO_ROOT": "/ram/workspace",
        "FULLMAG_STATE_ROOT": "/ram/workspace/.fullmag",
        "FULLMAG_STATE_DIR": "/ram/user-state", "FULLMAG_API_PORT": "8081",
    }.items()):
        raise ValueError("HTTP gate process environment leaves RAM ownership")
    workspace = Path("/ram/workspace")
    workspace.mkdir()
    (workspace / ".fullmag").mkdir()
    for source in Path("/source").iterdir():
        if source.name == ".fullmag":
            raise ValueError("Solver capsule contains mutable state root")
        (workspace / source.name).symlink_to(source, target_is_directory=source.is_dir())
    os.chdir(workspace)
    api = None
    result = {"schema": SCHEMA, "state": "failed", "physics_qualified": False,
        "durable_session_storage_qualified": False, "reuse_LLG_FFT_qualified": False,
        "qualification": "NOT VERIFIED", "session_storage": "disposable_tmpfs",
        "tool_manifest_sha256": sha(tools / "manifest.json"),
        "native_canonical_bundle_redecoded": False, "cold_archive_import": "NOT VERIFIED"}
    previous_signals = {}
    if port is not None:
        def interrupted(signum, frame):
            raise ValueError("Owned browser inspection was interrupted")
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous_signals[signum] = signal.signal(signum, interrupted)
    try:
        with (export / "api.log").open("wb") as api_log:
            api = subprocess.Popen(["/package/bin/fullmag-api"], stdout=api_log,
                stderr=subprocess.STDOUT)
            wait_api(api)
            result["warm_api_pid"] = api.pid
            with (export / "solver.log").open("wb") as log:
                solve = subprocess.run(["/package/bin/fullmag-bin",
                    "/input/" + fixture_script, "--headless",
                    "--api-port", "8081", "--expect-script-sha256",
                    fixture_sha[fixture_script],
                    "--output-dir", "/ram/result.zarr"], stdout=log,
                    stderr=subprocess.STDOUT, timeout=300)
            result["solver_exit_code"] = solve.returncode
            if solve.returncode:
                raise ValueError("Native solve failed; read retained solver.log")
            # Snapshot ownership must be produced by the real run. Do not
            # construct, inject or modify stage_execution/artifact_refs.
            metadata = wait_inspection(export)
            (export / "inspection-metadata.json").write_text(json.dumps(metadata, sort_keys=True))
            result["http_smokes"] = {
                name: smoke(name, "stage-000", export) for name in
                selected_smokes}
            if fixture == "closedloop" and CANONICAL_FIELD_SMOKE in expected["tools_sha256"]:
                result["canonical_fields_http"] = smoke(CANONICAL_FIELD_SMOKE, "stage-000", export)
                canonical_field_identity(result["canonical_fields_http"])
            result["terminal_owner_negative_admission"] = reject_stale_terminal_owners()
            if standalone:
                result["standalone_read_model"] = check_standalone_read_model()
            result["fixture_variant"] = variant
            # Both API handlers invoke the full canonical disk loader. The
            # Python smoke itself correctly does not claim native decoding.
            result.update(state="warm_http_pass", runtime_stage_id="stage-000",
                native_canonical_bundle_redecoded=True,
                canonical_decoder_owner="API load_published_antenna_closed_loop_inspection" if len(selected_smokes) == 1 else "API load_published_antenna_external_lead_solution",
                inspection_ref=metadata["outputs"][0]["inspection_ref"])
            if verify_cold_import:
                from antenna_inspection_cold_import_check import verify_cold_import as check_cold
                result["cold_import_result"] = check_cold("stage-000", export)
                if result["cold_import_result"].get("status") != "pass":
                    raise ValueError("Cold import did not pass its evidence contract")
                result["cold_archive_import"] = "PASS"
                if standalone:
                    result["standalone_cold_read_model"] = check_standalone_read_model()
            encoded, session_id = export_archive(export)
            stop_owned(api)
            api = None
            # Original locations disappear before cold import. The archive is
            # the only route back to stage artifacts; retained trees are evidence.
            (workspace / ".fullmag").rename(Path("/ram/warm-state-retired"))
            Path("/ram/result.zarr").rename(Path("/ram/warm-result.zarr"))
            cold_root = Path("/ram/cold-state")
            if cold_root.exists():
                raise ValueError("Cold state root was not fresh")
            cold_env = dict(os.environ, FULLMAG_STATE_ROOT=str(cold_root),
                            FULLMAG_STATE_DIR="/ram/cold-user-state")
            with (export / "cold-api.log").open("wb") as cold_log:
                api = subprocess.Popen(["/package/bin/fullmag-api"], env=cold_env,
                    stdout=cold_log, stderr=subprocess.STDOUT)
                wait_api(api)
                if api.pid == result["warm_api_pid"]:
                    raise ValueError("Cold API process identity was reused")
                result["cold_api_pid"] = api.pid
                restored = post_json("/v2/sessions/current/persistence/imports",
                    {"fms_base64": encoded, "restore_mode": "visualization_only"})
                if restored.get("session_id") != session_id \
                        or restored.get("restore_mode") != "visualization_only":
                    raise ValueError("Cold imported session identity differs")
                cold = get_json("/v2/sessions/current/data/antenna/stages/stage-000/external-lead-inspection")
                compare_cold_metadata(metadata, cold)
                (export / "cold-inspection-metadata.json").write_text(json.dumps(cold, sort_keys=True))
                cold_export = export / "cold-http"
                cold_export.mkdir()
                result["cold_http_smokes"] = {name: smoke(name, "stage-000", cold_export)
                    for name in selected_smokes}
                if fixture == "closedloop" and CANONICAL_FIELD_SMOKE in expected["tools_sha256"]:
                    result["cold_canonical_fields_http"] = smoke(CANONICAL_FIELD_SMOKE, "stage-000", cold_export)
                    if canonical_field_identity(result["canonical_fields_http"]) != canonical_field_identity(result["cold_canonical_fields_http"]):
                        raise ValueError("Cold import changed canonical V/J/H values, units or sampling")
                if standalone:
                    result["standalone_restarted_read_model"] = check_standalone_read_model()
                if len(selected_smokes) == 1 and result["http_smokes"][selected_smokes[0]]["scientific_identity"] != result["cold_http_smokes"][selected_smokes[0]]["scientific_identity"]:
                    raise ValueError("Cold HTTP changed decoded closed-loop scientific identity")
                result.update(state="cold_http_pass", cold_archive_import="PASS",
                    archive_sha256=sha(export / "snapshot.fms"),
                    cold_process_state_root=str(cold_root), cold_solver_executed=False)
                if port is not None:
                    result["browser_inspection"] = browser_window(api, export, mode, result, cold)
                    result["state"] = "cold_http_browser_pass"

    except Exception as error:
        result.update(state="failed", error=str(error))
    finally:
        try:
            stop_owned(api)
        except Exception as error:
            result.update(state="failed", shutdown_error=str(error))
        output = Path("/ram/warm-result.zarr")
        if not output.is_dir():
            output = Path("/ram/result.zarr")
        if output.is_dir():
            shutil.copytree(output, export / "result.zarr")
        state_root = workspace / ".fullmag"
        result["ram_state_file_inventory"] = [str(path.relative_to(state_root))
            for path in sorted(state_root.rglob("*")) if path.is_file()][:2000]
        (export / "gate-result.json").write_text(json.dumps(result, sort_keys=True))
        for signum, handler in previous_signals.items():
            signal.signal(signum, handler)
    return 0 if result["state"] in ("cold_http_pass", "cold_http_browser_pass") else 1


def http_spec(image, source, package, inputs, export, tools, verify_cold_import=False, *, standalone=False, browser_inspection_port=None):
    if not isinstance(verify_cold_import, bool):
        raise ValueError("Invalid cold import gate mode")
    if not isinstance(standalone, bool):
        raise ValueError("Invalid standalone gate mode")
    import run_managed_antenna_ram as ram
    spec = ram.scientific_spec(image, source, package, inputs, export)
    service = spec["services"]["antenna"]
    service["volumes"].append({"type": "bind", "source": str(tools.resolve()),
                               "target": "/tools", "read_only": True})
    service["environment"]["FULLMAG_API_PORT"] = "8081"
    service["command"] = ["python3", "-I", "-B", "/tools/run_managed_antenna_http_ram.py", "execute"]
    if verify_cold_import:
        service["command"].append("--verify-cold-import")
    if standalone:
        service["command"].append("--standalone")
    port = browser_port(browser_inspection_port)
    if port is not None:
        service["network_mode"] = "bridge"
        service["ports"] = [f"127.0.0.1:{port}:8081"]
        service["command"].extend(["--browser-inspection-port", str(port)])
    return spec


def resolved(repo, job, commit, source, native):
    import fullmag_storage as storage
    import run_managed_antenna_ram as ram
    _, build, context, built, capsule, package = ram.resolved_build(repo, job, commit, source, native)
    return storage.resolve_layout(repo, PROFILE), build, context, built, capsule, package


def attest_http(container, spec, project, port=None):
    import run_managed_antenna_ram as ram
    if port is None:
        return ram.attest(container, spec, project)
    browser_port(port)
    if not isinstance(container, str) or not re.fullmatch(r"[0-9a-f]{64}", container):
        raise ValueError("Full owned browser container ID required")
    observed = json.loads(ram.docker("inspect", container))[0]
    service = spec["services"]["antenna"]
    config, runtime = observed["HostConfig"], observed["Config"]
    labels = runtime.get("Labels", {})
    environment = runtime.get("Env", [])
    mounts = observed["Mounts"]
    if len({mount["Destination"] for mount in mounts}) != len(mounts):
        raise ValueError("Browser HTTP container has duplicate mount destinations")
    for mount in mounts:
        target = mount["Destination"]
        system_field = {"/etc/hosts": "HostsPath", "/etc/hostname": "HostnamePath", "/etc/resolv.conf": "ResolvConfPath"}.get(target)
        if system_field and (mount["Type"] != "bind" or not observed.get(system_field)
                or ram.host_path(mount["Source"]) != ram.host_path(observed[system_field])):
            raise ValueError("Browser HTTP system mount differs from Docker ownership")
        if mount["Type"] == "tmpfs" and (mount.get("RW") is not True or mount.get("Source") != ""):
            raise ValueError("Browser HTTP tmpfs mount differs")
    expected = {(m["target"], str(Path(m["source"]).resolve()).lower(), not m["read_only"]) for m in service["volumes"]}
    actual = [(m["Destination"], str(ram.host_path(m["Source"])).lower(), m["RW"]) for m in mounts
              if m["Type"] == "bind" and m["Destination"] not in ram.SYSTEM_MOUNT_TARGETS]
    if observed.get("Id") != container or observed["Image"] != service["image"] \
            or set(actual) != expected or len(actual) != len(expected) \
            or any(m["Type"] not in ("bind", "tmpfs") for m in mounts) \
            or any(m["Type"] == "tmpfs" and m["Destination"] not in ("/ram", "/tmp") for m in mounts) \
            or runtime.get("Cmd") != service["command"] or runtime.get("Entrypoint") not in (None, []) \
            or runtime.get("WorkingDir") != service["working_dir"] \
            or labels.get("com.docker.compose.project") != project or labels.get("com.docker.compose.service") != "antenna" \
            or any([item for item in environment if item.split("=", 1)[0] == key] != [f"{key}={value}"]
                   for key, value in service["environment"].items()):
        raise ValueError("Browser HTTP container image/mount/command/environment/owner differs")
    bindings = {"8081/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(port)}]}
    if config.get("NetworkMode") != "bridge" or config.get("PortBindings") != bindings \
            or config.get("PublishAllPorts") or config.get("ReadonlyRootfs") is not True \
            or config.get("Privileged") or config.get("CapAdd") or set(config.get("CapDrop", [])) != {"ALL"} \
            or "no-new-privileges:true" not in config.get("SecurityOpt", []) or runtime.get("User") != "65532:65532" \
            or config.get("Memory") != 2 * 1024**3 or config.get("NanoCpus") != 2 * 10**9 \
            or config.get("PidsLimit") != 128 or any(config.get(key) for key in ("Devices", "DeviceRequests", "DeviceCgroupRules")) \
            or config.get("Tmpfs") != {"/tmp": "rw,nosuid,nodev,size=64m", "/ram": "rw,nosuid,nodev,size=768m,mode=1777"}:
        raise ValueError("Browser HTTP container isolation or loopback port differs")
    if observed.get("State", {}).get("Running") and (observed.get("NetworkSettings", {}).get("Ports") != bindings
            or set(observed.get("NetworkSettings", {}).get("Networks", {})) != {"bridge"}):
        raise ValueError("Running browser HTTP network differs")
    return observed


def require_browser_window(layout, owned_container=None):
    import getpass
    from local_runner.container_client import request
    from local_runner.build_executor import is_blocking_fullmag_container
    from run_managed_browser import docker
    health = request(layout, getpass.getuser(), "GET", "/health", timeout=3)
    if health.get("service") != "fullmag-build-runner" or health.get("ok") is not True \
            or health.get("accepting_jobs") is not False or health.get("worker_alive") is not False \
            or health.get("stop_requested") is not True or health.get("worker_error") is not None \
            or health.get("active_jobs") != [] or health.get("legacy_jobs") != [] \
            or health.get("retention_busy") is not False or health.get("replacement_pending") is not False \
            or health.get("coordinator", {}).get("state") not in ("paused", "stopped"):
        raise ValueError("Browser inspection requires an operator-established idle/paused runner window")
    identifiers = docker("ps", "-q", "--no-trunc").split()
    running = json.loads(docker("inspect", *identifiers)) if identifiers else []
    if any(item.get("Id") != owned_container and is_blocking_fullmag_container(item,
            storage_root=layout["storage_root"], build_storage_root=layout["build_storage_root"])
           for item in running):
        raise ValueError("A compute or unknown Fullmag container blocks browser inspection")


def wait_browser_terminal(repo, root, spec, receipt, layout):
    from run_managed_browser import docker, read_json
    deadline = time.monotonic() + BROWSER_RUN_SECONDS
    try:
        while time.monotonic() < deadline:
            observed = attest_http(receipt["container_id"], spec, receipt["compose_project"], receipt["browser_inspection"]["port"])
            if observed["State"].get("Status") == "exited" and not observed["State"].get("Running"):
                observe(repo, root)
                receipt.update(read_json(root / "receipt.json"))
                return
            require_browser_window(layout, receipt["container_id"])
            time.sleep(1)
        raise ValueError("Owned browser HTTP run exceeded its fixed 1800 second bound")
    except BaseException:
        # A port or process name never grants ownership. Reattest the exact ID.
        observed = attest_http(receipt["container_id"], spec, receipt["compose_project"], receipt["browser_inspection"]["port"])
        if observed["State"].get("Running"):
            docker("stop", "--time", "10", receipt["container_id"])
        raise


def start(repo, job, commit, source_digest, native_digest, fixture="magnetic", verify_cold_import=False, *, standalone=False, browser_inspection_port=None):
    port = browser_port(browser_inspection_port)
    if port is None:
        return start_protected(repo, job, commit, source_digest, native_digest, fixture, verify_cold_import, standalone=standalone)
    if fixture != "closedloop" or standalone or verify_cold_import:
        raise ValueError("Browser inspection supports only the explicit closed-loop fixture")
    import fullmag_storage as storage
    from local_runner.runtime_use import runtime_package_use
    layout = storage.resolve_layout(repo, PROFILE)
    require_browser_window(layout)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", port))
    with runtime_package_use(layout), storage.file_lock(Path(layout["storage_root"]) / "locks/fullmag-native-windows-heavy.lock", "bounded browser inspection"), storage.build_lock(layout):
        require_browser_window(layout)
        return start_protected(repo, job, commit, source_digest, native_digest, fixture, verify_cold_import,
                               standalone=standalone, browser_inspection_port=port)


def start_protected(repo, job, commit, source_digest, native_digest, fixture="magnetic", verify_cold_import=False, *, standalone=False, browser_inspection_port=None):
    if not isinstance(standalone, bool) or not isinstance(verify_cold_import, bool):
        raise ValueError("Invalid HTTP gate mode")
    if fixture not in ("magnetic", "nonmagnetic", "closedloop") or standalone and fixture != "magnetic":
        raise ValueError("Unsupported antenna fixture combination")
    if fixture == "closedloop" and verify_cold_import:
        raise ValueError("The optional legacy cold-import probe supports external leads; closed-loop uses the restarted API gate")
    import fullmag_storage as storage
    import run_managed_antenna_ram as ram
    from run_managed_browser import docker
    layout, build, context, built, capsule, package = resolved(
        repo, job, commit, source_digest, native_digest)
    if standalone:
        fixtures, fixture_sha, generated = ram.fixture_identity(repo, standalone=True)
        fixture_script = ram.SCRIPT_NAME
    else:
        fixture_sha = fixture_contract(fixture)
        fixtures = {name: storage.validate_path(repo / "examples" / name, repo) for name in fixture_sha}
        for name, path in fixtures.items():
            if storage.is_link(path) or not path.is_file() or sha(path) != fixture_sha[name]:
                raise ValueError("Fixed scientific input differs: " + name)
        fixture_script = next(name for name in fixture_sha if name.endswith(".py"))
        generated = None
    host_tools = repo / "scripts"
    tools_sha = tool_manifest(host_tools)
    image = json.loads(docker("image", "inspect", context["image_digest"]))[0]
    if image.get("Id") != context["image_digest"] or image.get("Config", {}).get("Volumes"):
        raise ValueError("Build image has different identity or anonymous volumes")
    storage.initialize(layout)
    root = storage.validate_path(Path(layout["build_root"]) / "runs" / uuid.uuid4().hex,
                                 Path(layout["build_storage_root"]))
    root.mkdir(parents=True, exist_ok=False)
    inputs, export, tools = root / "input", root / "export", root / "tools"
    for folder in (inputs, export, tools):
        folder.mkdir()
    for name, path in fixtures.items():
        target = inputs / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        if sha(target) != fixture_sha[name]:
            raise ValueError("Fixture changed during staging")
    for name in TOOLS:
        shutil.copyfile(host_tools / name, tools / name)
    check_tools(tools, tools_sha)
    if generated is not None:
        (inputs / ram.SCRIPT_NAME).write_bytes(generated)
        if sha(inputs / ram.SCRIPT_NAME) != fixture_sha[ram.SCRIPT_NAME]:
            raise ValueError("Standalone fixture changed during staging")
    variant_name = "standalone" if standalone else (fixture if fixture != "magnetic" else "magnetic_probe")
    variant = {"fixture_variant": variant_name} if variant_name != "magnetic_probe" else {}
    storage.atomic_json(tools / "manifest.json", {"tools_sha256": tools_sha,
        "fixture_sha256": fixture_sha, "fixture": fixture, "fixture_script": fixture_script,
        "solver_capsule_attribution": False, "tool_manifest_version": 3, **variant})
    spec = http_spec(context["image_digest"], capsule / "tree", package, inputs, export, tools,
                     verify_cold_import, standalone=standalone, browser_inspection_port=browser_inspection_port)
    storage.atomic_json(root / "compose.json", spec)
    mode = None
    if browser_inspection_port is not None:
        mode = {"port": browser_inspection_port, "nonce": root.name, "compose_sha256": sha(root / "compose.json")}
        manifest = json.loads((tools / "manifest.json").read_text(encoding="utf-8"))
        storage.atomic_json(tools / "manifest.json", {**manifest, "browser_inspection": mode})
    project = "fullmag-antenna-http-ram-" + root.name
    receipt = {"schema": SCHEMA, "state": "starting", "run_root": str(root),
        "profile": PROFILE, "managed_job_id": job, "source_digest": source_digest,
        "native_source_identity": built["native_source_identity"],
        "image_digest": context["image_digest"], "compose_project": project,
        "compose_sha256": sha(root / "compose.json"), "tools_sha256": tools_sha,
        "tool_manifest_sha256": sha(tools / "manifest.json"),
        "fixture_sha256": fixture_sha, "fixture": fixture, "fixture_script": fixture_script, **variant,
        "build_receipt_sha256": sha(build / "artifacts/build-receipt.json"),
        "session_storage": "disposable_tmpfs", "qualification": "NOT VERIFIED",
        "physics_qualified": False, "durable_session_storage_qualified": False,
        "unit_tests_compiled": False}
    receipt["verify_cold_import"] = verify_cold_import
    if mode is not None:
        receipt["browser_inspection"] = mode
    try:
        args = ["compose", "-f", str(root / "compose.json"), "--project-name", project]
        docker(*args, "config", "--quiet")
        docker(*args, "up", "--detach", "--no-build", "--pull", "never")
        receipt["container_id"] = docker(*args, "ps", "--all", "--quiet", "antenna")
        attest_http(receipt["container_id"], spec, project, browser_inspection_port)
        receipt.update(state="launched_resources_retained", isolation="PASS")
        if mode is not None:
            storage.atomic_json(root / "receipt.json", receipt)
            print(json.dumps({"state": receipt["state"], "receipt": str(root / "receipt.json"), "terminal": False}), flush=True)
            wait_browser_terminal(repo, root, spec, receipt, layout)
    except Exception as error:
        receipt.update(state="failed_resources_retained", error=str(error))
        raise
    finally:
        storage.atomic_json(root / "receipt.json", receipt)
        print(json.dumps({"state": receipt["state"], "receipt": str(root / "receipt.json")}))
    return root


def observe(repo, root):
    import fullmag_storage as storage
    import run_managed_antenna_ram as ram
    from run_managed_browser import read_json
    from verify_saved_fem_archive_roundtrip import check_stamp
    layout = storage.resolve_layout(repo, PROFILE)
    root = storage.validate_path(root, Path(layout["build_root"]) / "runs")
    receipt = read_json(root / "receipt.json")
    if receipt.get("schema") != SCHEMA or receipt.get("run_root") != str(root) \
            or receipt.get("compose_sha256") != sha(root / "compose.json"):
        raise ValueError("HTTP RAM gate identity changed")
    native = receipt["native_source_identity"]
    fixture = receipt.get("fixture", "magnetic")
    variant = receipt.get("fixture_variant", "magnetic_probe")
    if variant not in ("standalone", "magnetic_probe", "nonmagnetic", "closedloop"):
        raise ValueError("Unknown scientific fixture variant")
    standalone = variant == "standalone"
    if fixture not in ("magnetic", "nonmagnetic", "closedloop") or standalone and fixture != "magnetic" or variant != (
            "standalone" if standalone else fixture if fixture != "magnetic" else "magnetic_probe"):
        raise ValueError("Scientific fixture variant differs from source selection")
    fixture_sha = ram.fixture_identity(repo, True)[1] if standalone else fixture_contract(fixture)
    variant_fields = {"fixture_variant": variant} if variant != "magnetic_probe" else {}
    verify_cold_import = receipt.get("verify_cold_import", False)
    if not isinstance(verify_cold_import, bool):
        raise ValueError("Invalid cold import gate mode")
    mode = receipt.get("browser_inspection")
    port = browser_port(mode.get("port")) if isinstance(mode, dict) else None
    check_browser_mode(mode, port)
    if mode is not None and (fixture != "closedloop" or standalone or verify_cold_import
            or mode["nonce"] != root.name or mode["compose_sha256"] != receipt["compose_sha256"]):
        raise ValueError("Browser inspection owner differs from the pinned run")
    _, build, context, built, capsule, package = resolved(repo, receipt["managed_job_id"],
        native["head_commit_full"], receipt["source_digest"], native["source_snapshot_sha256"])
    tools, inputs = root / "tools", root / "input"
    check_tools(tools, receipt["tools_sha256"])
    manifest = read_json(tools / "manifest.json")
    expected_manifest = {"tools_sha256": receipt["tools_sha256"], "fixture_sha256": fixture_sha,
        "fixture": fixture, "fixture_script": receipt["fixture_script"],
        "solver_capsule_attribution": False, **variant_fields}
    if set(receipt["tools_sha256"]) == set(TOOLS):
        expected_manifest["tool_manifest_version"] = 3
    elif set(receipt["tools_sha256"]) == set(TOOLS_V2):
        expected_manifest["tool_manifest_version"] = 2
    if mode is not None:
        expected_manifest["browser_inspection"] = mode
    if receipt["tool_manifest_sha256"] != sha(tools / "manifest.json") \
            or manifest != expected_manifest:
        raise ValueError("Pinned host-tool manifest differs")
    for name, expected in fixture_sha.items():
        if sha(inputs / name) != expected or storage.is_link(inputs / name):
            raise ValueError("Pinned scientific input differs")
    spec = read_json(root / "compose.json")
    if spec != http_spec(context["image_digest"], capsule / "tree", package,
                         inputs, root / "export", tools, verify_cold_import, standalone=standalone, browser_inspection_port=port) \
            or receipt["native_source_identity"] != built["native_source_identity"] \
            or receipt["image_digest"] != context["image_digest"] \
            or receipt["fixture_sha256"] != fixture_sha \
            or receipt["build_receipt_sha256"] != sha(build / "artifacts/build-receipt.json") \
            or receipt["compose_project"] != "fullmag-antenna-http-ram-" + root.name:
        raise ValueError("HTTP gate source/build/spec binding changed")
    observed = attest_http(receipt["container_id"], spec, receipt["compose_project"], port)
    state = observed["State"]
    if state.get("Status") != "exited" or state.get("Running"):
        if mode is not None and state.get("Running") and (root / "export/browser-ready.json").exists():
            require_browser_window(layout, receipt["container_id"])
            ready = check_browser_ready(root / "export", mode, receipt["tool_manifest_sha256"])
            path = "/v2/sessions/current/data/antenna/stages/stage-000/external-lead-inspection"
            with build_opener(ProxyHandler({})).open(f"http://127.0.0.1:{port}" + path, timeout=3) as response:
                raw = response.read(MAX_JSON + 1)
                if response.status != 200 or len(raw) > MAX_JSON:
                    raise ValueError("Running cold browser metadata is unavailable or oversized")
            if browser_binding(json.loads(raw), mode, sha(root / "export/snapshot.fms"),
                               receipt["tool_manifest_sha256"], ready["binding"]["cold_api_pid"]) != ready["binding"]:
                raise ValueError("Running cold browser owner differs from readiness")
            return {"state": "browser_ready", "terminal": False, "browser_checked": False,
                    "url": ready["url"], "run_root": str(root),
                    "ready_sha256": sha(root / "export/browser-ready.json")}
        return {"state": "pending", "container_state": state.get("Status"), "run_root": str(root)}
    receipt.update(state="failed_resources_retained", exit_code=state["ExitCode"],
                   oom_killed=state["OOMKilled"])
    try:
        if state["ExitCode"] != 0 or state["OOMKilled"] or state.get("Error"):
            raise ValueError("HTTP gate container failed; read retained logs")
        export = root / "export"
        result = read_json(export / "gate-result.json")
        if result.get("schema") != SCHEMA or result.get("state") != ("cold_http_browser_pass" if mode else "cold_http_pass") \
                or result.get("solver_exit_code") != 0 \
                or result.get("native_canonical_bundle_redecoded") is not True \
                or result.get("physics_qualified") is not False \
                or result.get("durable_session_storage_qualified") is not False \
                or result.get("reuse_LLG_FFT_qualified") is not False \
                or result.get("tool_manifest_sha256") != receipt["tool_manifest_sha256"]:
            raise ValueError("HTTP gate result is missing or promotes qualification")
        if standalone and (result.get("fixture_variant") != "standalone" or
                result.get("standalone_read_model", {}).get("status") != "pass"):
            raise ValueError("Standalone HTTP read-model evidence is missing")
        if standalone and verify_cold_import and result.get("standalone_cold_read_model", {}).get("status") != "pass":
            raise ValueError("Standalone cold read-model evidence is missing")
        if standalone and result.get("standalone_restarted_read_model", {}).get("status") != "pass":
            raise ValueError("Standalone restarted cold read-model evidence is missing")
        for name in ("api.log", "solver.log", "cold-api.log"):
            check_stamp((export / name).read_text(encoding="utf-8"), native["head_commit_full"],
                native["source_snapshot_sha256"], dirty=native["source_snapshot_dirty"])
        if not (export / "result.zarr").is_dir() or storage.is_link(export / "result.zarr"):
            raise ValueError("Retained real solver output is absent")
        if verify_cold_import:
            cold = result.get("cold_import_result", {})
            if result.get("cold_archive_import") != "PASS" or cold.get("status") != "pass" \
                    or any(cold.get(key) is not False for key in
                        ("durable_session_storage_qualified", "physics_qualified",
                         "reuse_LLG_FFT_qualified", "api_process_restarted")) \
                    or any(cold.get(key) is not True for key in
                        ("original_output_restored", "original_root_unavailable_during_import_and_reads",
                         "old_request_scope_rejected")):
                raise ValueError("Required cold import proof is absent or promotes durability")
            if read_json(export / "cold-import-result.json") != cold \
                    or cold.get("warm_request_scope") == cold.get("cold_request_scope"):
                raise ValueError("Retained cold import evidence differs or scope did not rotate")
            archive_path = export / "antenna-cold.fms"
            archive = cold.get("archive", {})
            if storage.is_link(archive_path) or not archive_path.is_file() \
                    or not 32 < archive_path.stat().st_size <= 32 << 20 \
                    or archive.get("bytes") != archive_path.stat().st_size \
                    or archive.get("sha256") != sha(archive_path):
                raise ValueError("Retained cold archive identity differs")
        if result.get("cold_archive_import") != "PASS" or result.get("cold_solver_executed") is not False \
                or result.get("cold_process_state_root") != "/ram/cold-state" \
                or type(result.get("warm_api_pid")) is not int \
                or type(result.get("cold_api_pid")) is not int \
                or result["warm_api_pid"] <= 0 or result["cold_api_pid"] <= 0 \
                or result["warm_api_pid"] == result["cold_api_pid"] \
                or result.get("archive_sha256") != sha(export / "snapshot.fms"):
            raise ValueError("Cold archive proof is missing")
        if receipt.get("fixture") == "closedloop":
            name = "smoke_antenna_closed_loop_inspection.py"
            warm_smoke, cold_smoke = result.get("http_smokes", {}).get(name, {}), result.get("cold_http_smokes", {}).get(name, {})
            if warm_smoke.get("status") != "pass" or cold_smoke.get("status") != "pass" or warm_smoke.get("physics_qualified") is not False or cold_smoke.get("physics_qualified") is not False or not warm_smoke.get("scientific_identity") or warm_smoke["scientific_identity"] != cold_smoke.get("scientific_identity"):
                raise ValueError("Closed-loop warm/cold decoded HTTP proof missing")
        if receipt.get("fixture") == "closedloop" and CANONICAL_FIELD_SMOKE in receipt["tools_sha256"]:
            if canonical_field_identity(result.get("canonical_fields_http", {})) != canonical_field_identity(result.get("cold_canonical_fields_http", {})):
                raise ValueError("Retained canonical V/J/H warm/cold identity differs")
        compare_cold_metadata(read_json(export / "inspection-metadata.json"),
                              read_json(export / "cold-inspection-metadata.json"))
        if mode is not None:
            ready = check_browser_ready(export, mode, receipt["tool_manifest_sha256"], terminal=True)
            browser = result.get("browser_inspection", {})
            summary = check_browser_proof(export, ready, browser.get("proof_sha256"))
            completion = browser_json(export, "browser-completion.json")
            completed = browser.get("completed_at")
            if completion != {"schema": "fullmag.antenna-cold-browser-completion.v1", "binding": ready["binding"],
                    "ready_sha256": sha(export / "browser-ready.json"), "proof_sha256": summary["proof_sha256"]} \
                    or type(completed) not in (int, float) or not math.isfinite(completed) \
                    or not ready["ready_at"] <= completed <= ready["expires_at"] \
                    or result.get("session_storage") != "disposable_tmpfs" \
                    or ready["binding"]["cold_api_pid"] != result["cold_api_pid"] \
                    or browser != {**summary, "ready_sha256": sha(export / "browser-ready.json"),
                                   "completion_sha256": sha(export / "browser-completion.json"), "completed_at": completed}:
                raise ValueError("Terminal browser proof is missing, stale or promotes its scope")
        receipt.update(state="cold_http_pass_resources_retained", startup_identity="PASS",
            gate_result_sha256=sha(export / "gate-result.json"),
            api_log_sha256=sha(export / "api.log"), solver_log_sha256=sha(export / "solver.log"),
            native_canonical_bundle_redecoded=True, cold_archive_import="PASS",
            cold_api_log_sha256=sha(export / "cold-api.log"),
            archive_sha256=sha(export / "snapshot.fms"))
        if mode is not None:
            receipt.update(state="cold_http_browser_pass_resources_retained", browser_inspection_result=browser,
                           browser_scope="browser_inspection_only", browser_checked=True)
    except Exception as error:
        receipt["error"] = str(error)
        raise
    finally:
        storage.atomic_json(root / "receipt.json", receipt)
    return {"state": receipt["state"], "run_root": str(root)}


def complete_browser(repo, root, proof_sha256):
    import fullmag_storage as storage
    from run_managed_browser import read_json
    layout = storage.resolve_layout(repo, PROFILE)
    root = storage.validate_path(root, Path(layout["build_root"]) / "runs")
    if observe(repo, root).get("state") != "browser_ready":
        raise ValueError("Browser completion requires a live, verified cold inspection window")
    receipt = read_json(root / "receipt.json")
    export = root / "export"
    ready = check_browser_ready(export, receipt["browser_inspection"], receipt["tool_manifest_sha256"])
    check_browser_proof(export, ready, proof_sha256)
    completion = {"schema": "fullmag.antenna-cold-browser-completion.v1", "binding": ready["binding"],
                  "ready_sha256": sha(export / "browser-ready.json"), "proof_sha256": proof_sha256}
    target = export / "browser-completion.json"
    if target.exists() or target.is_symlink():
        if browser_json(export, target.name) != completion:
            raise ValueError("A different browser completion already exists")
    else:
        write_browser_json(export, target.name, completion)
    return {"state": "browser_completion_requested", "terminal": False, "run_root": str(root)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path)
    sub = parser.add_subparsers(dest="action", required=True)
    start_args = sub.add_parser("start")
    for flag in ("job-id", "commit", "source-digest", "native-snapshot-sha256"):
        start_args.add_argument("--" + flag, required=True)
    start_args.add_argument("--fixture", choices=("magnetic", "nonmagnetic", "closedloop"), default="magnetic")
    start_args.add_argument("--verify-cold-import", action="store_true")
    start_args.add_argument("--standalone", action="store_true")
    start_args.add_argument("--browser-inspection-port", type=int)
    sub.add_parser("observe").add_argument("--run-root", type=Path, required=True)
    complete_args = sub.add_parser("complete-browser")
    complete_args.add_argument("--run-root", type=Path, required=True)
    complete_args.add_argument("--proof-sha256", required=True)
    execute_args = sub.add_parser("execute")
    execute_args.add_argument("--verify-cold-import", action="store_true")
    execute_args.add_argument("--standalone", action="store_true")
    execute_args.add_argument("--browser-inspection-port", type=int)
    args = parser.parse_args()
    if args.action == "execute":
        sys.exit(execute_in_container(args.verify_cold_import, args.standalone, args.browser_inspection_port))
    if args.repo_root is None:
        parser.error("host actions require --repo-root")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    if args.action == "start":
        start(args.repo_root, args.job_id, args.commit, args.source_digest, args.native_snapshot_sha256,
              fixture=args.fixture, verify_cold_import=args.verify_cold_import, standalone=args.standalone,
              browser_inspection_port=args.browser_inspection_port)
    elif args.action == "complete-browser":
        print(json.dumps(complete_browser(args.repo_root, args.run_root, args.proof_sha256)))
    else:
        print(json.dumps(observe(args.repo_root, args.run_root)))
