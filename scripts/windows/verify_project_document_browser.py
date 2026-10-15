"""Verify the real project-document lifecycle in a session-free workspace."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fullmag_storage as storage
from frontend_source_workspace import prepare_source_workspace, validate_dependency_workspace
from verify_control_room_sources import fingerprint, timestamp
from verify_pinned_dataset_browser import link_directory, port_is_open, stop_owned_process


PROFILE = "windows-control-room-source-check"
PORT = 3269
SMOKE_NAME = "smoke-project-lifecycle-runtime.mjs"
EXPECTED_IDLE_404_MAX_COUNTS = {
    "/v2/sessions/current/simulation/preparation": 2,
    "/v2/sessions/current/simulation/runs/current": 1,
}
EXPECTED_SCREENSHOTS = {
    "new-project.png",
    "reopened-project.png",
    "closed-project.png",
}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise storage.StorageError(message)


def _api_health(get, expected_instance_id: str | None = None) -> str:
    owner_pid = getattr(get, "owner_pid", None)
    api_port = getattr(get, "api_port", None)
    _require(isinstance(owner_pid, int) and owner_pid > 0, "The owned native API PID is unavailable")
    _require(isinstance(api_port, int) and 1 <= api_port <= 65535, "The owned native API port is unavailable")
    _require(storage.process_alive(owner_pid), "The verifier-owned native API process is no longer alive")
    status, _, _ = get("health")
    _require(status == 200, f"Native API health returned HTTP {status}")
    instance_id = getattr(get, "instance_id", None)
    _require(isinstance(instance_id, str) and instance_id, "Native API health omitted its instance identity")
    if expected_instance_id is not None:
        _require(instance_id == expected_instance_id, "Native API instance identity changed during browser proof")
    return instance_id


def _sessions_snapshot(get, expected_instance_id: str) -> dict:
    status, etag, body = get("/v2/sessions")
    instance_id = getattr(get, "instance_id", None)
    _require(status == 200, f"Native API session list returned HTTP {status}")
    _require(instance_id == expected_instance_id, "Session list came from a different API instance")
    _require(isinstance(body, dict) and body.get("sessions") == [],
             f"Expected an empty runtime session list, received {body!r}")
    return {
        "status": status,
        "etag": etag,
        "api_instance_id": instance_id,
        "sessions": body["sessions"],
    }


def _dependency_identity(value: dict) -> dict:
    return {
        "dependency_workspace": value["dependency_workspace"],
        "dependency_app": value["dependency_app"],
        "dependency_root_node_modules": value["dependency_root_node_modules"],
        "dependency_app_node_modules": value["dependency_app_node_modules"],
        "dependency_manifest": value["dependency_manifest"],
        "dependency_manifest_sha256": value["dependency_manifest_sha256"],
        "dependency_input_hashes": value["dependency_input_hashes"],
        "dependency_inputs_sha256": value["dependency_inputs_sha256"],
        "dependency_stage_id": value["dependency_stage_id"],
        "dependency_profile": value["dependency_profile"],
        "source_run_profile": value["source_run_profile"],
        "source_run_build_root": value["source_run_build_root"],
    }


def _terminate_owned_process(process: subprocess.Popen, record: dict) -> None:
    if process.poll() is None:
        try:
            stop_owned_process(process)
        except subprocess.CalledProcessError:
            # A process can exit between poll() and taskkill. Only accept that
            # race when the owned root process is confirmed terminal.
            if process.poll() is None:
                raise
    return_code = process.wait(timeout=30)
    record.update(return_code=return_code, waited=True, terminal=process.poll() is not None)
    _require(record["terminal"], f"Owned child process {process.pid} did not reach a terminal state")


def _wait_for_server(process: subprocess.Popen, url: str, log_path: Path) -> None:
    deadline = time.monotonic() + 240
    while True:
        if process.poll() is not None:
            raise storage.StorageError(f"Owned Next server exited before readiness; inspect {log_path}")
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status == 200:
                    return
        except urllib.error.HTTPError:
            pass
        except (OSError, TimeoutError):
            pass
        if time.monotonic() >= deadline:
            raise storage.StorageError(f"Owned Next server did not become ready; inspect {log_path}")
        time.sleep(0.5)


def _validate_browser_report(report: dict, report_root: Path, workspace_url: str, api_base: str) -> list[dict]:
    _require(report.get("state") == "passed", "Project lifecycle browser smoke did not pass")
    _require(report.get("scope") == "browser-project-lifecycle-without-runtime-session",
             "Project lifecycle browser report has the wrong session scope")
    _require(report.get("session_mode") == "absent", "Project lifecycle browser smoke used a runtime session")
    _require(report.get("browser_channel") == ("chrome" if os.name == "nt" else "playwright_chromium"),
             "Project lifecycle browser report used an unexpected browser channel")
    _require(report.get("workspace_url") == workspace_url, "Project lifecycle browser report used a different workspace URL")
    _require(report.get("api_base") == api_base, "Project lifecycle browser report used a different API base")
    _require(report.get("byte_roundtrip") is True, "Project archive bytes did not round-trip unchanged")
    _require(report.get("close_project") == "verified", "Project Close was not verified")
    _require(report.get("first_download") == "untitled-project.fms", "New project archive name was unexpected")
    _require(report.get("second_download") == "roundtrip.fms", "Reopened project archive name was unexpected")
    _require(isinstance(report.get("archive_bytes"), int) and report["archive_bytes"] > 4,
             "Project archive download was empty or too short")
    for field in ("current_session_requests", "current_session_websocket_requests", "forbidden_runtime_requests", "page_errors"):
        _require(report.get(field) == [], f"Project lifecycle report contains forbidden {field}: {report.get(field)!r}")

    expected_404 = report.get("expected_idle_404_max_counts")
    _require(expected_404 == EXPECTED_IDLE_404_MAX_COUNTS, "Project lifecycle report changed the allowed idle 404 contract")
    errors = report.get("http_errors")
    _require(isinstance(errors, list), "Project lifecycle report omitted HTTP error observations")
    counts: dict[str, int] = {}
    for error in errors:
        _require(isinstance(error, dict), "Project lifecycle HTTP error observation is malformed")
        path = error.get("path")
        _require(error.get("status") == 404 and path in EXPECTED_IDLE_404_MAX_COUNTS,
                 f"Unexpected project lifecycle HTTP error: {error!r}")
        counts[path] = counts.get(path, 0) + 1
        _require(counts[path] <= EXPECTED_IDLE_404_MAX_COUNTS[path],
                 f"Too many expected idle 404 responses for {path}")

    requests = report.get("requests")
    persistence_requests = report.get("project_persistence_requests")
    _require(isinstance(requests, list) and isinstance(persistence_requests, list),
             "Project lifecycle report omitted browser request observations")
    _require(bool(persistence_requests), "Browser lifecycle did not exercise project persistence routes")
    _require(isinstance(report.get("console_errors"), list), "Project lifecycle report omitted console errors")

    screenshots = report.get("screenshots")
    _require(isinstance(screenshots, list) and len(screenshots) == len(EXPECTED_SCREENSHOTS),
             "Project lifecycle report must contain all three lifecycle screenshots")
    artifacts = []
    names = set()
    for value in screenshots:
        _require(isinstance(value, str), "Project lifecycle screenshot path is malformed")
        path = Path(value).resolve(strict=True)
        _require(storage.inside(path, report_root.resolve(strict=True)),
                 f"Project lifecycle screenshot escaped its report directory: {path}")
        _require(path.is_file(), f"Project lifecycle screenshot is not a file: {path}")
        _require(path.stat().st_size > 0, f"Project lifecycle screenshot is empty: {path}")
        names.add(path.name)
        artifacts.append({"path": str(path), "size_bytes": path.stat().st_size, "sha256": _sha256(path)})
    _require(names == EXPECTED_SCREENSHOTS, f"Project lifecycle screenshots are incomplete: {sorted(names)}")
    return artifacts


def exercise(repo: Path, run_root: Path, receipt: dict, get, frontend_dependency_workspace: Path) -> None:
    """Exercise New/Save/Open/Save/Close against the owned API with no session."""

    helper_path = Path(__file__).resolve(strict=True)
    proof = {
        "schema": "fullmag.project-document-browser-proof.v1",
        "state": "running",
        "scope": "real-product-workspace-project-lifecycle-without-runtime-session",
        "qualification": "browser_and_project_document_api_only_no_solver_or_release_qualification",
        "started_at": timestamp(),
        "main_run_root": str(Path(run_root).resolve()),
        "frontend_dependency_workspace": str(Path(frontend_dependency_workspace)),
        "browser_port": PORT,
        "processes": [],
        "checks": [],
        "cleanup_errors": [],
    }
    receipt["project_document_browser_proof"] = proof
    proof_path = storage.validate_path(Path(run_root) / "project-document-browser-proof.json",
                                       Path(run_root), "project browser proof receipt")
    proof["proof_path"] = str(proof_path)
    storage.atomic_json(proof_path, proof)

    failure: BaseException | None = None
    layout = None
    before_source_fingerprint = None
    before_helper_sha256 = None
    before_dependency_identity = None
    browser_run_root = None
    api_instance_id = None
    browser_attempted = False
    server_launch_attempted = False
    next_process = None
    smoke_process = None
    smoke_return_code = None

    try:
        repo = Path(repo).resolve(strict=True)
        frontend_dependency_workspace = Path(frontend_dependency_workspace).resolve(strict=True)
        before_helper_sha256 = _sha256(helper_path)
        before_source_fingerprint = fingerprint(repo, False)
        proof.update(
            repo_root=str(repo),
            source_fingerprint_before=before_source_fingerprint,
            helper_path=str(helper_path),
            helper_sha256_before=before_helper_sha256,
        )
        _require(os.name == "nt", "The project document browser proof requires the native Windows host")

        layout = storage.resolve_layout(repo, PROFILE)
        _require(layout.get("profile") == PROFILE, "Resolver did not return the fixed source-check profile")
        before_dependency_identity = _dependency_identity(
            validate_dependency_workspace(repo, layout, frontend_dependency_workspace)
        )
        proof["dependency_identity_before"] = before_dependency_identity
        _require(storage.process_alive(get.owner_pid), "The verifier-owned native API process is not alive")
        api_instance_id = _api_health(get)
        proof["api_owner_pid"] = get.owner_pid
        proof["api_port"] = get.api_port
        proof["api_instance_id_before"] = api_instance_id
        proof["checks"].append("owned-native-api-health-and-instance-identity")

        _require(not port_is_open(PORT), f"Fixed browser port {PORT} is already in use; no listener will be stopped")
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", PORT))
        proof["checks"].append("fixed-localhost-port-3269-was-free-before-storage-mutation")

        node = shutil.which("node")
        _require(node is not None, "An existing Node executable is required; no install or bootstrap is allowed")
        dependency_root = Path(before_dependency_identity["dependency_workspace"]).resolve(strict=True)
        dependency_app_modules = Path(before_dependency_identity["dependency_app_node_modules"]).resolve(strict=True)
        dependency_next_cli = dependency_app_modules / "next" / "dist" / "bin" / "next"
        _require(dependency_next_cli.is_file(), "The validated frontend workspace has no existing Next CLI")
        _require(storage.inside(dependency_next_cli.resolve(strict=True), dependency_root),
                 "The Next CLI resolves outside the validated dependency workspace")
        smoke_source = repo / "apps/control-room/scripts" / SMOKE_NAME
        _require(smoke_source.is_file(), f"Project lifecycle smoke is missing: {smoke_source}")

        storage.initialize(layout)
        build_root = Path(layout["build_root"]).resolve(strict=True)
        run_parent = storage.validate_path(build_root / "project-document-browser", build_root,
                                           "project document browser run parent")
        run_parent.mkdir(parents=True, exist_ok=True)
        browser_run_root = storage.validate_path(run_parent / uuid.uuid4().hex, build_root,
                                                 "project document browser run root")
        browser_run_root.mkdir(parents=False, exist_ok=False)
        proof["front_run"] = str(browser_run_root)
        proof["checks"].append("canonical-managed-browser-run-root-created")

        prepared = prepare_source_workspace(repo, layout, browser_run_root, frontend_dependency_workspace)
        app = Path(prepared["app"]).resolve(strict=True)
        workspace_root = Path(prepared["workspace_root"]).resolve(strict=True)
        source_manifest = Path(prepared["source_manifest"]).resolve(strict=True)
        frontend_root_link = app / ".fullmag-frontend"
        frontend_root = frontend_root_link.resolve(strict=True)
        _require(storage.inside(app, browser_run_root) and storage.inside(workspace_root, browser_run_root),
                 "Staged application escaped its canonical browser run root")
        _require(storage.inside(frontend_root, browser_run_root),
                 "Staged frontend cache escaped its canonical browser run root")
        _require(storage.inside(source_manifest, browser_run_root),
                 "Frontend source manifest escaped its canonical browser run root")
        _require(_sha256(source_manifest) == prepared["source_manifest_sha256"],
                 "Staged frontend source manifest hash does not match the preparation receipt")
        _require(Path(prepared["dependencies"]).resolve(strict=True) == dependency_app_modules,
                 "Staged app dependencies differ from the validated native app dependencies")

        extra_dist = frontend_root / "next" / "dev-3269"
        _require(not extra_dist.exists() and not extra_dist.is_symlink(),
                 f"Fresh staged Next output path already exists: {extra_dist}")
        extra_dist.mkdir(parents=True, exist_ok=False)
        link_directory(app / ".next-control-room-3269", extra_dist)
        link_directory(frontend_root / "node_modules", dependency_app_modules)

        staged_smoke = app / "scripts" / SMOKE_NAME
        staged_next_cli = app / "node_modules" / "next" / "dist" / "bin" / "next"
        _require(staged_smoke.is_file(), "The staged project lifecycle smoke is missing")
        _require(staged_next_cli.is_file(), "The staged dependency link does not expose the existing Next CLI")
        _require(staged_next_cli.resolve(strict=True) == dependency_next_cli.resolve(strict=True),
                 "The staged Next CLI does not resolve to the validated dependency workspace")

        manifest_path = Path(prepared["dependency_manifest"]).resolve(strict=True)
        proof.update(
            frontend_workspace=str(workspace_root),
            frontend_app=str(app),
            frontend_root=str(frontend_root),
            frontend_source_stage_id=prepared["source_stage_id"],
            frontend_source_manifest=str(source_manifest),
            frontend_source_manifest_sha256=prepared["source_manifest_sha256"],
            dependency_manifest=str(manifest_path),
            dependency_manifest_sha256=prepared["dependency_manifest_sha256"],
            dependency_input_hashes=prepared["dependency_input_hashes"],
            dependency_inputs_sha256=prepared["dependency_inputs_sha256"],
            dependency_workspace=str(prepared["dependency_workspace"]),
            dependency_profile=prepared["dependency_profile"],
        )
        _require(prepared["dependency_manifest_sha256"] == before_dependency_identity["dependency_manifest_sha256"]
                 and prepared["dependency_input_hashes"] == before_dependency_identity["dependency_input_hashes"]
                 and prepared["dependency_inputs_sha256"] == before_dependency_identity["dependency_inputs_sha256"]
                 and prepared["dependency_manifest"] == before_dependency_identity["dependency_manifest"]
                 and prepared["dependency_workspace"] == before_dependency_identity["dependency_workspace"]
                 and prepared["dependency_profile"] == before_dependency_identity["dependency_profile"],
                 "Frontend source staging observed different dependency identity than preflight")
        proof["checks"].append("current-frontend-sources-staged-with-validated-read-only-dependencies")

        _api_health(get, api_instance_id)
        sessions_before = _sessions_snapshot(get, api_instance_id)
        proof["sessions_before"] = sessions_before
        proof["checks"].append("runtime-session-list-empty-before-browser-lifecycle")

        query = urllib.parse.urlencode({"fullmag_api_instance": api_instance_id})
        workspace_url = f"http://127.0.0.1:{PORT}/workspace?{query}"
        api_base = f"http://127.0.0.1:{PORT}"
        api_proxy_target = f"http://127.0.0.1:{get.api_port}"
        browser_report_root = browser_run_root / "browser"
        browser_report_path = browser_report_root / "report.json"
        next_log_path = browser_run_root / "next.log"
        browser_log_path = browser_run_root / "browser.log"
        proof.update(
            workspace_url=workspace_url,
            api_base=api_base,
            api_proxy_target=api_proxy_target,
            browser_report_root=str(browser_report_root),
            browser_report_path=str(browser_report_path),
            next_log=str(next_log_path),
            browser_log=str(browser_log_path),
        )
        env = {**os.environ, **layout["env"]}
        env.update(
            FULLMAG_FRONTEND_ROOT=str(frontend_root),
            FULLMAG_NEXT_DIST_DIR=".next-control-room-3269",
            FULLMAG_API_PROXY_TARGET=api_proxy_target,
            NEXT_TELEMETRY_DISABLED="1",
            CONTROL_ROOM_URL=workspace_url,
            CONTROL_ROOM_API_BASE=api_base,
            CONTROL_ROOM_PROJECT_SESSION_MODE="absent",
            CONTROL_ROOM_PROJECT_RUNTIME_REPORT_DIR=str(browser_report_root),
            CONTROL_ROOM_PROJECT_BROWSER_CHANNEL="chrome",
        )

        server_launch_attempted = True
        with next_log_path.open("w", encoding="utf-8") as next_log:
            next_process = subprocess.Popen(
                [node, str(staged_next_cli), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", str(PORT)],
                cwd=app,
                env=env,
                stdout=next_log,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
            )
        next_record = {"role": "next-dev-server", "pid": next_process.pid, "port": PORT,
                       "return_code": None, "waited": False, "terminal": False}
        proof["processes"].append(next_record)
        storage.atomic_json(proof_path, proof)
        _wait_for_server(next_process, workspace_url, next_log_path)
        next_record["ready"] = True
        proof["checks"].append("owned-next-webpack-server-ready-on-localhost-3269")

        browser_attempted = True
        browser_report_root.mkdir(parents=True, exist_ok=True)
        with browser_log_path.open("w", encoding="utf-8") as browser_log:
            smoke_process = subprocess.Popen(
                [node, str(staged_smoke)],
                cwd=app,
                env=env,
                stdout=browser_log,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
            )
        smoke_record = {"role": "project-lifecycle-browser-smoke", "pid": smoke_process.pid,
                        "return_code": None, "waited": False, "terminal": False}
        proof["processes"].append(smoke_record)
        storage.atomic_json(proof_path, proof)
        try:
            smoke_return_code = smoke_process.wait(timeout=240)
        except subprocess.TimeoutExpired as error:
            raise storage.StorageError("Project lifecycle browser smoke exceeded its 240-second timeout") from error
        smoke_record.update(return_code=smoke_return_code, waited=True, terminal=smoke_process.poll() is not None)
        _require(smoke_return_code == 0,
                 f"Project lifecycle browser smoke exited with {smoke_return_code}; inspect {browser_log_path}")
    except BaseException as error:
        failure = error
        proof["error"] = str(error)
        proof["traceback"] = traceback.format_exc()
    finally:
        if smoke_process is not None:
            try:
                record = next(item for item in proof["processes"] if item["role"] == "project-lifecycle-browser-smoke")
                _terminate_owned_process(smoke_process, record)
            except BaseException as error:
                proof["cleanup_errors"].append(f"browser process cleanup: {error}")

        if browser_attempted and layout is not None and api_instance_id is not None:
            try:
                proof["api_instance_id_after"] = _api_health(get, api_instance_id)
                sessions_after = _sessions_snapshot(get, api_instance_id)
                proof["sessions_after"] = sessions_after
                proof["checks"].append("runtime-session-list-empty-after-browser-lifecycle")
                if proof.get("sessions_before", {}).get("sessions") != sessions_after["sessions"]:
                    raise storage.StorageError("Runtime session list changed during project lifecycle browser proof")
            except BaseException as error:
                proof["cleanup_errors"].append(f"post-browser API observation: {error}")

        if browser_attempted and browser_run_root is not None:
            report_root = browser_run_root / "browser"
            report_path = report_root / "report.json"
            if report_path.is_file():
                try:
                    browser_report = json.loads(report_path.read_text(encoding="utf-8"))
                    proof["browser_report"] = browser_report
                    proof["browser_artifacts"] = _validate_browser_report(
                        browser_report, report_root, proof["workspace_url"], proof["api_base"]
                    )
                    proof["checks"].append("browser-report-confirms-no-session-byte-roundtrip-and-close")
                except BaseException as error:
                    proof["cleanup_errors"].append(f"browser report validation: {error}")
            else:
                proof["cleanup_errors"].append("browser report was not written")

        if next_process is not None:
            try:
                record = next(item for item in proof["processes"] if item["role"] == "next-dev-server")
                _terminate_owned_process(next_process, record)
            except BaseException as error:
                proof["cleanup_errors"].append(f"Next server cleanup: {error}")

        if server_launch_attempted:
            try:
                deadline = time.monotonic() + 10
                while port_is_open(PORT) and time.monotonic() < deadline:
                    time.sleep(0.25)
                proof["port_closed_after_cleanup"] = not port_is_open(PORT)
                _require(proof["port_closed_after_cleanup"], "Browser port 3269 remained open after owned Next cleanup")
                proof["checks"].append("owned-localhost-port-3269-closed-after-cleanup")
            except BaseException as error:
                proof["cleanup_errors"].append(f"port cleanup verification: {error}")

        if layout is not None and before_dependency_identity is not None:
            try:
                after_dependency_identity = _dependency_identity(
                    validate_dependency_workspace(repo, layout, frontend_dependency_workspace)
                )
                proof["dependency_identity_after"] = after_dependency_identity
                _require(after_dependency_identity == before_dependency_identity,
                         "Validated frontend dependency identity changed during browser proof")
                proof["checks"].append("validated-dependency-manifest-and-inputs-unchanged")
            except BaseException as error:
                proof["cleanup_errors"].append(f"dependency identity revalidation: {error}")

        if before_source_fingerprint is not None:
            try:
                after_source_fingerprint = fingerprint(Path(repo), False)
                proof["source_fingerprint_after"] = after_source_fingerprint
                _require(after_source_fingerprint == before_source_fingerprint,
                         "Frontend source fingerprint changed during browser proof")
                proof["checks"].append("frontend-source-fingerprint-unchanged")
            except BaseException as error:
                proof["cleanup_errors"].append(f"source fingerprint verification: {error}")

        if before_helper_sha256 is not None:
            try:
                after_helper_sha256 = _sha256(helper_path)
                proof["helper_sha256_after"] = after_helper_sha256
                _require(after_helper_sha256 == before_helper_sha256,
                         "Project browser verifier source changed while it was running")
                proof["checks"].append("project-browser-verifier-source-unchanged")
            except BaseException as error:
                proof["cleanup_errors"].append(f"helper source hash verification: {error}")

        if proof["cleanup_errors"]:
            proof["state"] = "failed"
            if failure is None:
                failure = storage.StorageError("Project document browser proof failed during cleanup or evidence validation")
                proof["error"] = str(failure)
        elif failure is None:
            proof["state"] = "passed"
            proof["finished_at"] = timestamp()
        else:
            proof["state"] = "failed"
        if "finished_at" not in proof:
            proof["finished_at"] = timestamp()
        storage.atomic_json(proof_path, proof)

    if failure is not None:
        raise storage.StorageError(f"Project document browser proof failed: {failure}") from failure
