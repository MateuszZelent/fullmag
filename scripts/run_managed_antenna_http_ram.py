"""Bounded real antenna HTTP gate using an existing managed CPU package.

All application state remains in tmpfs. Host tools have their own immutable
manifest; they are not attributed to the solver source capsule. No build or
durable SessionStore qualification is performed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid
from urllib.request import ProxyHandler, Request, build_opener
from urllib.error import HTTPError

PROFILE = "managed-antenna-http-ram-cpu"
SCHEMA = "fullmag.managed-antenna-http-ram.v1"
TOOLS = (
    "run_managed_antenna_http_ram.py", "smoke_antenna_external_lead_inspection.py",
    "smoke_antenna_inspection_display.py", "antenna_rt0_fixture_check.py",
    "antenna_current_display_fixture_check.py", "antenna_current_source_oracle.py",
    "antenna_inspection_cold_import_check.py",
    "antenna_standalone_fixture.py",
)
ORIGIN = "http://127.0.0.1:8081"
MAX_JSON = 4 << 20


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(65536), b""):
            digest.update(block)
    return digest.hexdigest()


def tool_manifest(root):
    paths = [root / name for name in TOOLS]
    if any(path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_JSON
           for path in paths):
        raise ValueError("HTTP gate requires bounded regular host tool files")
    return {name: sha(root / name) for name in TOOLS}


def check_tools(root, expected):
    if set(expected) != set(TOOLS) or tool_manifest(root) != expected:
        raise ValueError("HTTP gate host tool identity changed")


def get_json(path):
    opener = build_opener(ProxyHandler({}))
    try:
        response = opener.open(ORIGIN + path, timeout=3)
    except HTTPError as error:
        body = error.read(4096).decode("utf-8", errors="replace")
        raise ValueError(f"HTTP {error.code} at {path}: {body}") from error
    with response:
        data = response.read(MAX_JSON + 1)
        if response.status != 200 or len(data) > MAX_JSON:
            raise ValueError("HTTP gate metadata response exceeds contract")
        return json.loads(data)


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
    expected_status = {"smoke_antenna_external_lead_inspection.py": "pass",
                       "smoke_antenna_inspection_display.py": "passed"}.get(script)
    if expected_status is None or result.get("status") != expected_status \
            or result.get("physics_qualified") is not False:
        raise ValueError("HTTP smoke failed or promoted inspection scope")
    return result


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
    for name, (guard, expected) in cases.items():
        request = Request(ORIGIN + "/v2/sessions/current/internal/live/snapshot",
            data=body, method="POST", headers={"content-type": "application/json",
            "x-fullmag-terminal-owner": json.dumps(guard)})
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
    variant = "standalone" if standalone else "magnetic_probe"
    if expected.get("fixture_variant", "magnetic_probe") != variant:
        raise ValueError("HTTP fixture variant differs from owned command")
    script = SCRIPT_NAME if standalone else "fem_antenna_current_source_inspection.py"
    fixture_sha = expected["fixture_sha256"]
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
            with (export / "solver.log").open("wb") as log:
                solve = subprocess.run(["/package/bin/fullmag-bin",
                    "/input/" + script, "--headless",
                    "--api-port", "8081", "--expect-script-sha256",
                    fixture_sha[script],
                    "--output-dir", "/ram/result.zarr"], stdout=log,
                    stderr=subprocess.STDOUT, timeout=300)
            result["solver_exit_code"] = solve.returncode
            if solve.returncode:
                raise ValueError("Native solve failed; read retained solver.log")
            # Snapshot ownership must be produced by the real run. Do not
            # construct, inject or modify stage_execution/artifact_refs.
            deadline = time.monotonic() + 15
            metadata = None
            last_metadata_error = None
            while time.monotonic() < deadline:
                try:
                    metadata = get_json("/v2/sessions/current/data/antenna/stages/stage-000/external-lead-inspection")
                    if metadata.get("runtime_stage_id") == "stage-000":
                        break
                except (OSError, ValueError) as error:
                    last_metadata_error = str(error)
                time.sleep(0.25)
            else:
                raise ValueError("Real solve did not register its inspection stage: " +
                                 str(last_metadata_error))
            (export / "inspection-metadata.json").write_text(json.dumps(metadata, sort_keys=True))
            result["http_smokes"] = {
                name: smoke(name, "stage-000", export) for name in
                ("smoke_antenna_external_lead_inspection.py", "smoke_antenna_inspection_display.py")}
            result["terminal_owner_negative_admission"] = reject_stale_terminal_owners()
            if standalone:
                result["standalone_read_model"] = check_standalone_read_model()
                result["fixture_variant"] = "standalone"
            # Both API handlers invoke the full canonical disk loader. The
            # Python smoke itself correctly does not claim native decoding.
            result.update(state="warm_http_pass", runtime_stage_id="stage-000",
                native_canonical_bundle_redecoded=True,
                canonical_decoder_owner="API load_published_antenna_external_lead_solution",
                inspection_ref=metadata["outputs"][0]["inspection_ref"])
            if verify_cold_import:
                from antenna_inspection_cold_import_check import verify_cold_import as check_cold
                result["cold_import_result"] = check_cold("stage-000", export)
                if result["cold_import_result"].get("status") != "pass":
                    raise ValueError("Cold import did not pass its evidence contract")
                result["cold_archive_import"] = "PASS"
                if standalone:
                    result["standalone_cold_read_model"] = check_standalone_read_model()
    except Exception as error:
        result.update(state="failed", error=str(error))
    finally:
        try:
            stop_owned(api)
        except Exception as error:
            result.update(state="failed", shutdown_error=str(error))
        output = Path("/ram/result.zarr")
        if output.is_dir():
            shutil.copytree(output, export / "result.zarr")
        state_root = workspace / ".fullmag"
        result["ram_state_file_inventory"] = [str(path.relative_to(state_root))
            for path in sorted(state_root.rglob("*")) if path.is_file()][:2000]
        (export / "gate-result.json").write_text(json.dumps(result, sort_keys=True))
    return 0 if result["state"] == "warm_http_pass" else 1


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


def start(repo, job, commit, source_digest, native_digest, verify_cold_import=False, *, standalone=False):
    if not isinstance(standalone, bool):
        raise ValueError("Invalid standalone gate mode")
    import fullmag_storage as storage
    import run_managed_antenna_ram as ram
    from run_managed_browser import docker
    layout, build, context, built, capsule, package = resolved(
        repo, job, commit, source_digest, native_digest)
    fixtures, hashes, generated = ram.fixture_identity(repo, standalone)
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
        if sha(target) != ram.FIXTURE_FILES[name]:
            raise ValueError("Fixture changed during staging")
    for name in TOOLS:
        shutil.copyfile(host_tools / name, tools / name)
    check_tools(tools, tools_sha)
    if generated is not None:
        (inputs / ram.SCRIPT_NAME).write_bytes(generated)
        if sha(inputs / ram.SCRIPT_NAME) != hashes[ram.SCRIPT_NAME]:
            raise ValueError("Standalone fixture changed during staging")
    variant = {"fixture_variant": "standalone"} if standalone else {}
    storage.atomic_json(tools / "manifest.json", {"tools_sha256": tools_sha,
        "fixture_sha256": hashes, "solver_capsule_attribution": False, **variant})
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
        "fixture_sha256": hashes, **variant,
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
    variant = receipt.get("fixture_variant", "magnetic_probe")
    if variant not in ("standalone", "magnetic_probe"):
        raise ValueError("Unknown scientific fixture variant")
    standalone = variant == "standalone"
    hashes = ram.fixture_identity(repo, True)[1] if standalone else ram.FIXTURE_FILES
    variant_fields = {"fixture_variant": "standalone"} if standalone else {}
    verify_cold_import = receipt.get("verify_cold_import", False)
    if not isinstance(verify_cold_import, bool):
        raise ValueError("Invalid cold import gate mode")
    _, build, context, built, capsule, package = resolved(repo, receipt["managed_job_id"],
        native["head_commit_full"], receipt["source_digest"], native["source_snapshot_sha256"])
    tools, inputs = root / "tools", root / "input"
    check_tools(tools, receipt["tools_sha256"])
    manifest = read_json(tools / "manifest.json")
    if receipt["tool_manifest_sha256"] != sha(tools / "manifest.json") \
            or manifest != {"tools_sha256": receipt["tools_sha256"],
                            "fixture_sha256": hashes, "solver_capsule_attribution": False, **variant_fields}:
        raise ValueError("Pinned host-tool manifest differs")
    for name, expected in hashes.items():
        if sha(inputs / name) != expected or storage.is_link(inputs / name):
            raise ValueError("Pinned scientific input differs")
    spec = read_json(root / "compose.json")
    if spec != http_spec(context["image_digest"], capsule / "tree", package,
                         inputs, root / "export", tools, verify_cold_import, standalone=standalone) \
            or receipt["native_source_identity"] != built["native_source_identity"] \
            or receipt["image_digest"] != context["image_digest"] \
            or receipt["fixture_sha256"] != hashes \
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
        if result.get("schema") != SCHEMA or result.get("state") != "warm_http_pass" \
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
        for name in ("api.log", "solver.log"):
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
        receipt.update(state="warm_http_pass_resources_retained", startup_identity="PASS",
            gate_result_sha256=sha(export / "gate-result.json"),
            api_log_sha256=sha(export / "api.log"), solver_log_sha256=sha(export / "solver.log"),
            native_canonical_bundle_redecoded=True,
            cold_archive_import="PASS" if verify_cold_import else "NOT VERIFIED")
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
              args.verify_cold_import, standalone=args.standalone)
    else:
        print(json.dumps(observe(args.repo_root, args.run_root)))
