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
import os
import re
from pathlib import Path
import shutil
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


def execute_in_container(verify_cold_import=False, standalone=False):
    export, tools = Path("/export"), Path("/tools")
    expected = json.loads((tools / "manifest.json").read_text())
    check_tools(tools, expected["tools_sha256"])
    # The container uses -I; admit only the verified, read-only tool directory.
    sys.path.insert(0, str(tools))
    from antenna_standalone_fixture import SCRIPT_NAME
    fixture = expected.get("fixture", "magnetic")
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
    return 0 if result["state"] == "cold_http_pass" else 1


def http_spec(image, source, package, inputs, export, tools, verify_cold_import=False, *, standalone=False):
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
    return spec


def resolved(repo, job, commit, source, native):
    import fullmag_storage as storage
    import run_managed_antenna_ram as ram
    _, build, context, built, capsule, package = ram.resolved_build(repo, job, commit, source, native)
    return storage.resolve_layout(repo, PROFILE), build, context, built, capsule, package


def start(repo, job, commit, source_digest, native_digest, fixture="magnetic", verify_cold_import=False, *, standalone=False):
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
                     verify_cold_import, standalone=standalone)
    storage.atomic_json(root / "compose.json", spec)
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
    try:
        args = ["compose", "-f", str(root / "compose.json"), "--project-name", project]
        docker(*args, "config", "--quiet")
        docker(*args, "up", "--detach", "--no-build", "--pull", "never")
        receipt["container_id"] = docker(*args, "ps", "--all", "--quiet", "antenna")
        ram.attest(receipt["container_id"], spec, project)
        receipt.update(state="launched_resources_retained", isolation="PASS")
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
    if receipt["tool_manifest_sha256"] != sha(tools / "manifest.json") \
            or manifest != expected_manifest:
        raise ValueError("Pinned host-tool manifest differs")
    for name, expected in fixture_sha.items():
        if sha(inputs / name) != expected or storage.is_link(inputs / name):
            raise ValueError("Pinned scientific input differs")
    spec = read_json(root / "compose.json")
    if spec != http_spec(context["image_digest"], capsule / "tree", package,
                         inputs, root / "export", tools, verify_cold_import, standalone=standalone) \
            or receipt["native_source_identity"] != built["native_source_identity"] \
            or receipt["image_digest"] != context["image_digest"] \
            or receipt["fixture_sha256"] != fixture_sha \
            or receipt["build_receipt_sha256"] != sha(build / "artifacts/build-receipt.json") \
            or receipt["compose_project"] != "fullmag-antenna-http-ram-" + root.name:
        raise ValueError("HTTP gate source/build/spec binding changed")
    observed = ram.attest(receipt["container_id"], spec, receipt["compose_project"])
    state = observed["State"]
    if state.get("Status") != "exited" or state.get("Running"):
        return {"state": "pending", "container_state": state.get("Status"), "run_root": str(root)}
    receipt.update(state="failed_resources_retained", exit_code=state["ExitCode"],
                   oom_killed=state["OOMKilled"])
    try:
        if state["ExitCode"] != 0 or state["OOMKilled"] or state.get("Error"):
            raise ValueError("HTTP gate container failed; read retained logs")
        export = root / "export"
        result = read_json(export / "gate-result.json")
        if result.get("schema") != SCHEMA or result.get("state") != "cold_http_pass" \
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
        receipt.update(state="cold_http_pass_resources_retained", startup_identity="PASS",
            gate_result_sha256=sha(export / "gate-result.json"),
            api_log_sha256=sha(export / "api.log"), solver_log_sha256=sha(export / "solver.log"),
            native_canonical_bundle_redecoded=True, cold_archive_import="PASS",
            cold_api_log_sha256=sha(export / "cold-api.log"),
            archive_sha256=sha(export / "snapshot.fms"))
    except Exception as error:
        receipt["error"] = str(error)
        raise
    finally:
        storage.atomic_json(root / "receipt.json", receipt)
    return {"state": receipt["state"], "run_root": str(root)}


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
    sub.add_parser("observe").add_argument("--run-root", type=Path, required=True)
    execute_args = sub.add_parser("execute")
    execute_args.add_argument("--verify-cold-import", action="store_true")
    execute_args.add_argument("--standalone", action="store_true")
    args = parser.parse_args()
    if args.action == "execute":
        sys.exit(execute_in_container(args.verify_cold_import, args.standalone))
    if args.repo_root is None:
        parser.error("host actions require --repo-root")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    if args.action == "start":
        start(args.repo_root, args.job_id, args.commit, args.source_digest, args.native_snapshot_sha256,
              fixture=args.fixture, verify_cold_import=args.verify_cold_import, standalone=args.standalone)
    else:
        print(json.dumps(observe(args.repo_root, args.run_root)))
