"""Managed browser fixtures for fixed Control Room routes; no solver or unit builds.

An immutable frontend source view and isolated Next outputs stay in storage.
Existing checkout dependencies are read, never installed, copied or rebound.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import uuid

import fullmag_storage as storage
from verify_control_room_sources import fingerprint, timestamp

PROFILE = "windows-control-room-browser-fixture"
BROWSER_CHANNEL = "chrome" if os.name == "nt" else None
SCENARIOS = {
    "antenna-workspace-authoring": ("smoke-managed-antenna-workspace.mjs", "fullmag.antenna-workspace-authoring-browser.v1", None, "FULLMAG_ANTENNA_WORKSPACE"),
    "antenna-regional-drive": ("smoke-antenna-regional-drive.mjs", "fullmag_antenna_regional_drive_browser_fixture_v1", "antenna-regional-drive", "FULLMAG_ANTENNA_REGIONAL"),
    "preparation-workspace": ("smoke-preparation-workspace.mjs", "fullmag_preparation_workspace_fixture_v1", "preparation-workspace", "FULLMAG_PREPARATION_WORKSPACE"),
    "inspector-actions": ("smoke-inspector-actions.mjs", "fullmag_inspector_actions_browser_fixture_v1", "inspector-actions", "FULLMAG_INSPECTOR_ACTIONS"),
    "explorer-physics-reporting": ("smoke-explorer-physics-reporting.mjs", "fullmag_explorer_physics_reporting_browser_fixture_v1", "explorer-physics-reporting", "FULLMAG_EXPLORER_PHYSICS_REPORTING"),
    "object-material-editor": ("smoke-object-material-editor.mjs", "fullmag_object_material_editor_browser_fixture_v1", "object-material-editor", "FULLMAG_OBJECT_MATERIAL_EDITOR"),
    "antenna-drive-editor": ("smoke-antenna-drive-editor.mjs", "fullmag_antenna_drive_editor_browser_fixture_v1", "antenna-drive-editor", "FULLMAG_ANTENNA_DRIVE_EDITOR"),
    "antenna-source-spectrum": ("smoke-antenna-source-spectrum.mjs", "fullmag_antenna_source_spectrum_browser_fixture_v1", "antenna-source-spectrum", "FULLMAG_ANTENNA_SOURCE_SPECTRUM"),
    "antenna-port-editor": ("smoke-antenna-port-editor.mjs", "fullmag_antenna_port_editor_browser_fixture_v1", "antenna-port-editor", "FULLMAG_ANTENNA_PORT_EDITOR"),
    "antenna-port-diagnostics": ("smoke-antenna-port-diagnostics.mjs", "fullmag_antenna_port_diagnostics_browser_fixture_v1", "antenna-port-diagnostics", "FULLMAG_ANTENNA_PORT_DIAGNOSTICS"),
    "artifact-field-overlay": ("smoke-artifact-field-overlay.mjs", "fullmag_artifact_field_overlay_browser_fixture_v1", "artifact-field-overlay", "FULLMAG_ARTIFACT_FIELD_OVERLAY"),
    "antenna-visualization": ("smoke-antenna-visualization.mjs", "fullmag_antenna_visualization_browser_fixture_v1", "antenna-visualization", "FULLMAG_ANTENNA_VISUALIZATION"),
    "inspector-routing": ("smoke-inspector.mjs", "fullmag_inspector_routing_browser_fixture_v1", None, "CONTROL_ROOM_INSPECTOR"),
    "antenna-cpw-viewport": ("smoke-antenna-cpw-viewport.mjs", "fullmag_antenna_cpw_viewport_browser_fixture_v1", "antenna-cpw-viewport", "FULLMAG_ANTENNA_CPW_VIEWPORT"),
    "pinned-dataset": ("smoke-pinned-materialized-dataset.mjs", "fullmag_pinned_dataset_browser_fixture_v1", None, "FULLMAG_PINNED_DATASET"),
    "antenna-external-lead-inspection": ("smoke-antenna-external-lead-inspection.mjs", "fullmag_antenna_inspection_browser_fixture_v1", "antenna-external-lead-inspection", "FULLMAG_ANTENNA_INSPECTION"),
    "antenna-microstrip-stations": ("smoke-antenna-microstrip-stations.mjs", "fullmag_antenna_microstrip_stations_browser_fixture_v1", "antenna-microstrip-stations", "FULLMAG_ANTENNA_STATIONS"),
    "antenna-transport-drafts": ("smoke-antenna-transport-drafts.mjs", "fullmag_antenna_transport_drafts_browser_fixture_v1", "antenna-transport-drafts", "FULLMAG_ANTENNA_TRANSPORT"),
    "antenna-solve-targets": ("smoke-antenna-solve-targets.mjs", "fullmag_antenna_solve_targets_browser_fixture_v1", "antenna-solve-targets", "FULLMAG_ANTENNA_SOLVE_TARGETS"),
    "primitive-color-inspector": ("smoke-primitive-color-inspector.mjs", "fullmag_primitive_color_inspector_browser_fixture_v1", "primitive-color-inspector", "FULLMAG_PRIMITIVE_COLOR"),
    "execution-profiles": ("smoke-execution-profiles.mjs", "fullmag_execution_profiles_browser_fixture_v1", "execution-profiles", "FULLMAG_EXECUTION_PROFILES"),
    "study-execution-profile": ("smoke-study-execution-profile.mjs", "fullmag_study_execution_profile_browser_fixture_v1", "study-execution-profile", "FULLMAG_STUDY_EXECUTION_PROFILE"),
}


def link_directory(source: Path, target: Path):
    if source.exists() or source.is_symlink():
        raise storage.StorageError(f"Fresh fixture link already exists: {source}")
    source.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        result = subprocess.run(
            ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
             "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:FULLMAG_LINK_SOURCE -Value $env:FULLMAG_LINK_TARGET | Out-Null"],
            env={**os.environ, "FULLMAG_LINK_SOURCE": str(source), "FULLMAG_LINK_TARGET": str(target)},
            capture_output=True, text=True,
        )
        if result.returncode:
            raise storage.StorageError(f"Cannot create fixture link: {result.stderr}")
    else:
        source.symlink_to(target, target_is_directory=True)
    if source.resolve() != target.resolve():
        raise storage.StorageError(f"Fixture link identity mismatch: {source}")


def stop_owned_process(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
    else:
        os.killpg(process.pid, signal.SIGTERM)
    process.wait(timeout=30)


def port_is_open(port: int):
    with socket.socket() as probe:
        probe.settimeout(1)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def print_fixture_log_tails(run_root: Path):
    max_bytes = 12_000
    max_lines = 80
    for name in ("browser.log", "next.log"):
        path = run_root / name
        print(f"--- fixture-owned {name} tail (at most {max_bytes} bytes) ---",
              file=sys.stderr, flush=True)
        try:
            if not path.is_file():
                print("(log not created)", file=sys.stderr, flush=True)
                continue
            with path.open("rb") as log:
                log.seek(0, os.SEEK_END)
                size = log.tell()
                log.seek(max(0, size - max_bytes), os.SEEK_SET)
                tail = log.read(max_bytes).decode("utf-8", errors="replace")
            if size > max_bytes:
                print("[earlier log bytes omitted]", file=sys.stderr)
            lines = tail.splitlines()[-max_lines:]
            print("\n".join(lines) if lines else "(empty log)",
                  file=sys.stderr, flush=True)
        except OSError as error:
            print(f"(cannot read fixture-owned log: {error})",
                  file=sys.stderr, flush=True)


def stage_dependency_roots(repo, layout, binding_path, expected_sha256, source_digest):
    """Admit only an explicitly pinned, installed stage of this worktree."""
    namespace = Path(layout["build_storage_root"]) / "builds" / layout["worktree_id"]

    def checked_path(value, root, label):
        return storage.validate_path(Path(value), root, label)

    def file_sha(path):
        if not path.is_file() or path.stat().st_size > 16 * 1024 * 1024:
            raise storage.StorageError(f"Missing or oversized dependency input: {path}")
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def load(path, expected):
        if not path.is_file() or path.stat().st_size > 16 * 1024 * 1024:
            raise storage.StorageError(f"Missing or oversized dependency input: {path}")
        raw = path.read_bytes()
        if len(raw) > 16 * 1024 * 1024 or hashlib.sha256(raw).hexdigest() != expected:
            raise storage.StorageError(f"Dependency input hash changed: {path}")
        return json.loads(raw)

    binding_file = checked_path(binding_path, namespace, "owned dependency binding")
    binding = load(binding_file, expected_sha256)
    if (binding.get("schema") != "fullmag.browser.dependency-stage-binding.v1"
            or Path(binding.get("repo_root", "")).resolve() != repo.resolve()
            or binding.get("worktree_id") != layout["worktree_id"]
            or binding.get("source_digest") != source_digest):
        raise storage.StorageError("Dependency binding owner or current source changed")
    receipt_file = checked_path(binding["install_receipt"], namespace, "owned install receipt")
    receipt = load(receipt_file, binding["install_receipt_sha256"])
    if (receipt.get("schema") != "fullmag.antenna.ui.dependency-diagnostic.v1"
            or receipt.get("state") != "INSTALLED_DEPENDENCIES_ONLY"
            or receipt.get("exit_code") != 0
            or "--frozen-lockfile" not in receipt.get("command", [])):
        raise storage.StorageError("Dependency stage has no successful frozen install")
    plan, stage = receipt["plan"], receipt["stage"]
    profile, stage_id = plan["profile"], stage["stage_id"]
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,95}", profile) or not re.fullmatch(r"[0-9a-f]{32}", stage_id):
        raise storage.StorageError("Invalid dependency profile or stage ID")
    build = namespace / profile
    stage_root = build / "frontend-sources" / stage_id
    workspace = stage_root / "workspace"
    app = workspace / "apps/control-room"
    if (Path(plan["repo_root"]).resolve() != repo.resolve()
            or Path(plan["build_root"]).resolve() != build.resolve()
            or stage.get("schema") != "fullmag.native-workspace-frontend-source.v1"
            or stage.get("mode") != "static"
            or Path(stage["source_root"]).resolve() != repo.resolve()
            or Path(stage["build_root"]).resolve() != build.resolve()
            or Path(stage["stage_root"]).resolve() != stage_root.resolve()
            or Path(stage["workspace_root"]).resolve() != workspace.resolve()
            or Path(stage["app_root"]).resolve() != app.resolve()):
        raise storage.StorageError("Dependency stage does not belong to this worktree profile")
    checked_path(build, namespace, "owned dependency profile")
    checked_path(stage_root, build, "owned dependency stage")
    checked_path(workspace, namespace, "owned dependency workspace")
    manifest_file = checked_path(stage["manifest_path"], stage_root, "stage manifest")
    if manifest_file != (stage_root / "frontend-source-manifest.json").resolve():
        raise storage.StorageError("Unexpected stage manifest path")
    manifest = load(manifest_file, stage["manifest_sha256"])
    for key in ("schema", "stage_id", "mode", "source_root", "build_root", "stage_root", "workspace_root", "app_root"):
        if manifest.get(key) != stage.get(key):
            raise storage.StorageError(f"Stage manifest identity mismatch: {key}")
    selected = {entry["path"]: entry for entry in manifest["source_files"]}
    metadata = {"package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/control-room/package.json"}
    metadata.update(entry["path"] for entry in manifest["source_files"] if entry["mode"] == "app-package-manifest")
    absent = set()
    for importer in manifest["lock_importers"]:
        relative = Path(importer)
        if relative.is_absolute() or ".." in relative.parts or relative.parts[:1] != ("apps",):
            raise storage.StorageError("Invalid stage lock importer")
        package_relative = (relative / "package.json").as_posix()
        if package_relative in selected:
            metadata.add(package_relative)
        else:
            absent.add(package_relative)
    if set(binding["metadata_sha256"]) != metadata or set(binding["absent_importer_manifests"]) != absent:
        raise storage.StorageError("Incomplete dependency metadata binding")
    for relative in absent:
        for root in (repo, workspace):
            path = checked_path(root / relative, root, "absent importer manifest")
            if path.exists() or path.is_symlink():
                raise storage.StorageError(f"Previously absent importer appeared: {relative}")
    for relative, expected in binding["metadata_sha256"].items():
        original = checked_path(repo / relative, repo, "root package metadata")
        staged = checked_path(workspace / relative, workspace, "stage package metadata")
        if selected.get(relative, {}).get("sha256") != expected or file_sha(original) != expected or file_sha(staged) != expected:
            raise storage.StorageError(f"Package/lock metadata changed: {relative}")
    app_dependencies = checked_path(app / "node_modules", workspace, "owned app dependencies")
    root_dependencies = checked_path(workspace / "node_modules", workspace, "owned root dependencies")
    if not app_dependencies.is_dir() or not root_dependencies.is_dir():
        raise storage.StorageError("Installed stage dependencies are missing")
    if set(binding["packages"]) != {"next", "react", "react-dom"}:
        raise storage.StorageError("Incomplete renderer package binding")
    for name, pin in binding["packages"].items():
        package_file = checked_path((app_dependencies / name / "package.json").resolve(), workspace, "owned renderer package")
        package = load(package_file, pin["sha256"])
        if package.get("name") != name or package.get("version") != pin["version"]:
            raise storage.StorageError(f"Renderer package changed: {name}")
    installed_lock = checked_path(root_dependencies / ".pnpm/lock.yaml", workspace, "installed pnpm lock")
    if file_sha(installed_lock) != binding["installed_lock_sha256"]:
        raise storage.StorageError("Installed dependency lock changed")
    next_cli = checked_path((app_dependencies / "next/dist/bin/next").resolve(), workspace, "owned Next CLI")
    if file_sha(next_cli) != binding["next_cli_sha256"]:
        raise storage.StorageError("Installed Next CLI changed")
    return app_dependencies, root_dependencies, {
        "binding": str(binding_file), "binding_sha256": expected_sha256,
        "install_receipt_sha256": binding["install_receipt_sha256"],
        "manifest_sha256": stage["manifest_sha256"], "stage_id": stage_id,
        "dependency_profile": profile, "packages": binding["packages"],
        "metadata_sha256": binding["metadata_sha256"], "absent_importer_manifests": sorted(absent),
        "source_digest": source_digest,
    }


def run(repo: Path, port: int, scenario: str = "pinned-dataset", dependency_workspace: Path | None = None):
    if scenario not in SCENARIOS:
        raise storage.StorageError("Unknown fixed browser fixture scenario")
    if scenario == "artifact-field-overlay" and port != 3276:
        raise storage.StorageError("Artifact field overlay browser fixture uses fixed port 3276")
    if scenario == "antenna-regional-drive" and port != 3272:
        raise storage.StorageError("Antenna regional drive browser fixture uses fixed port 3272")
    if scenario == "preparation-workspace" and port != 3268:
        raise storage.StorageError("Preparation workspace browser fixture uses fixed port 3268")
    if scenario == "object-material-editor" and port != 3266:
        raise storage.StorageError("Object material editor browser fixture uses fixed port 3266")
    if scenario == "antenna-drive-editor" and port != 3265:
        raise storage.StorageError("Antenna drive editor browser fixture uses fixed port 3265")
    if scenario == "antenna-port-editor" and port != 3264:
        raise storage.StorageError("Antenna port editor browser fixture uses fixed port 3264")
    if scenario == "execution-profiles" and port != 3255:
        raise storage.StorageError("Execution profiles browser fixture uses fixed port 3255")
    if scenario == "study-execution-profile" and port != 3256:
        raise storage.StorageError("Study execution profile browser fixture uses fixed port 3256")
    if scenario == "inspector-routing" and port != 3261:
        raise storage.StorageError("Inspector routing browser fixture uses fixed port 3261")
    if scenario == "inspector-actions" and port != 3257:
        raise storage.StorageError("Inspector actions browser fixture uses fixed port 3257")
    if scenario == "explorer-physics-reporting" and port != 3259:
        raise storage.StorageError("Explorer physics reporting browser fixture uses fixed port 3259")
    api_target = None
    if scenario == "antenna-workspace-authoring":
        if port != 3274:
            raise storage.StorageError("Managed antenna workspace uses fixed port 3274")
        from managed_browser_target import managed_browser_target
        api_target = managed_browser_target(repo, os.environ.get("FULLMAG_MANAGED_BROWSER_RECEIPT", ""),
            os.environ.get("FULLMAG_MANAGED_BROWSER_RECEIPT_SHA256"), require_fresh=True)
    smoke_name, receipt_schema, fixture_route, report_prefix = SCENARIOS[scenario]
    # The antenna profile includes carrier rejection, vector lifecycle and tensor dialog cases.
    browser_timeout_seconds = 600 if scenario == "antenna-visualization" else (360 if scenario == "antenna-workspace-authoring" else 240)
    layout = storage.resolve_layout(repo, PROFILE)
    storage.initialize(layout)
    app = repo / "apps/control-room"
    smoke = app / "scripts" / smoke_name
    node = shutil.which("node")
    binding_path = os.environ.get("FULLMAG_BROWSER_DEPENDENCY_BINDING")
    binding_sha256 = os.environ.get("FULLMAG_BROWSER_DEPENDENCY_BINDING_SHA256")
    if dependency_workspace is not None and binding_path:
        raise storage.StorageError("Choose a native dependency workspace or a stage binding, not both")
    if bool(binding_path) != bool(binding_sha256):
        raise storage.StorageError("A dependency binding requires its explicit SHA256; no fallback")
    if not node or not smoke.is_file():
        raise storage.StorageError("Existing Node and pinned dataset smoke are required; no bootstrap")
    dependencies = app / "node_modules"
    real_dependencies = dependencies.resolve()
    if dependency_workspace is None and not binding_path and not (real_dependencies == dependencies or
            storage.inside(real_dependencies, Path(layout["frontend_root"]).resolve())):
        raise storage.StorageError("Frontend dependencies belong to a different checkout")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", port))
    with storage.build_lock(layout):
        run_root = storage.validate_path(
            Path(layout["build_root"]) / (scenario + "-browser") / uuid.uuid4().hex,
            layout["build_storage_root"], "browser fixture run",
        )
        run_root.mkdir(parents=True)
        before = fingerprint(repo, False)
        stage_root_dependencies = None
        dependency_stage_proof = None
        if binding_path:
            real_dependencies, stage_root_dependencies, dependency_stage_proof = stage_dependency_roots(
                repo, layout, binding_path, binding_sha256, before,
            )
        native_dependency_before = None
        if dependency_workspace is not None:
            from frontend_source_workspace import SOURCE_CHECK_PROFILE, validate_dependency_workspace
            dependency_layout = storage.resolve_layout(repo, SOURCE_CHECK_PROFILE)
            native_dependency_before = validate_dependency_workspace(repo, dependency_layout, dependency_workspace)
            real_dependencies = Path(native_dependency_before["dependency_app_node_modules"])
            stage_root_dependencies = Path(native_dependency_before["dependency_root_node_modules"])
            dependency_stage_proof = native_dependency_before
        next_cli = real_dependencies / "next/dist/bin/next"
        if not next_cli.is_file():
            raise storage.StorageError("Existing Next is required; no bootstrap")
        receipt_path = run_root / "receipt.json"
        receipt = {
            "schema": receipt_schema, "state": "running",
            "scenario": scenario,
            "repo_root": str(repo), "worktree_id": layout["worktree_id"], "profile": PROFILE,
            "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
            "source_digest_before": before, "started_at": timestamp(),
            "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "justfile_sha256": hashlib.sha256((repo / "justfile").read_bytes()).hexdigest(),
            "qualification": "real_api_workspace_authoring_not_solve_science_or_durability" if api_target else "fixture_only_not_backend_runtime_or_science",
            "managed_api_target": api_target,
            "unit_tests": "not_compiled_not_run", "port": port,
            "browser_channel": BROWSER_CHANNEL or "playwright_chromium",
            "browser_timeout_seconds": browser_timeout_seconds,
            "dependency_stage": dependency_stage_proof,
        }
        storage.atomic_json(receipt_path, receipt)
        process = None
        try:
            snapshot = run_root / "source"
            fixture_app = snapshot / "apps/control-room"
            fixture_app.mkdir(parents=True)
            source_names = ["app", "src", "public", "scripts"] + [
                path.name for path in app.iterdir()
                if path.suffix in {".ts", ".tsx", ".json", ".mjs", ".css"} and path.is_file()
                and not path.name.endswith((".test.ts", ".test.tsx"))
            ]
            for name in source_names:
                source = app / name
                if not source.exists():
                    continue
                target = fixture_app / name
                if source.is_dir():
                    shutil.copytree(source, target)
                else:
                    shutil.copy2(source, target)
            for name in ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"):
                if (repo / name).is_file():
                    shutil.copy2(repo / name, snapshot / name)
            if fingerprint(repo, False) != before:
                raise storage.StorageError("Frontend sources changed while taking the fixture snapshot")
            if fixture_route:
                fixture_page = fixture_app / "scripts/fixtures" / (fixture_route + "-page.tsx")
                if not fixture_page.is_file():
                    raise storage.StorageError("Browser fixture page is missing")
                target_page = fixture_app / "app" / fixture_route / "page.tsx"
                if target_page.exists():
                    raise storage.StorageError("Browser fixture must not overwrite a product route")
                target_page.parent.mkdir(parents=True, exist_ok=False)
                shutil.copy2(fixture_page, target_page)
            link_directory(fixture_app / "node_modules", real_dependencies)
            root_dependencies = stage_root_dependencies if stage_root_dependencies is not None else repo / "node_modules"
            if root_dependencies.is_dir():
                root_real_dependencies = root_dependencies.resolve()
                if stage_root_dependencies is None and not (root_real_dependencies == root_dependencies or
                        storage.inside(root_real_dependencies, Path(layout["frontend_root"]).resolve())):
                    raise storage.StorageError("Root dependencies belong to a different checkout")
                link_directory(snapshot / "node_modules", root_real_dependencies)
            front = run_root / "frontend"
            # Server bundles resolve external modules from their real output
            # ancestors, not the source-view junction. Reuse exact dependencies.
            link_directory(front / "node_modules", real_dependencies)
            for relative, target in {
                ".fullmag-frontend": front,
                "out": front / "out",
                ".next": front / "next/default",
                f".next-control-room-{port}": front / f"next/dev-{port}",
            }.items():
                target.mkdir(parents=True, exist_ok=True)
                link_directory(fixture_app / relative, target)
            env = {**os.environ, **layout["env"],
                   "FULLMAG_FRONTEND_ROOT": str(front),
                   "FULLMAG_NEXT_DIST_DIR": f".next-control-room-{port}",
                   "NEXT_TELEMETRY_DISABLED": "1",
                   "CONTROL_ROOM_URL": f"http://127.0.0.1:{port}/workspace",
                   "FULLMAG_PINNED_DATASET_REPORT_DIR": str(run_root / "browser"),
                   "FULLMAG_FRONTEND_SOURCE_RUN_ROOT": str(run_root)}
            if BROWSER_CHANNEL:
                env["FULLMAG_PINNED_DATASET_BROWSER_CHANNEL"] = BROWSER_CHANNEL
            env[report_prefix + "_REPORT_DIR"] = str(run_root / "browser")
            if BROWSER_CHANNEL:
                env[report_prefix + "_BROWSER_CHANNEL"] = BROWSER_CHANNEL
            if fixture_route:
                env["CONTROL_ROOM_URL"] = f"http://127.0.0.1:{port}/{fixture_route}"
                if scenario in {"execution-profiles", "study-execution-profile", "inspector-actions", "explorer-physics-reporting"}:
                    env["CONTROL_ROOM_URL"] += "?fullmag_api_instance=11111111-1111-4111-8111-111111111111"
            if api_target:
                env["NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL"] = api_target["api_base"]
                env["FULLMAG_MANAGED_BROWSER_TARGET"] = json.dumps(api_target)
                env["CONTROL_ROOM_URL"] += "?fullmag_api_instance=" + api_target["api_instance"]
            receipt["source_view"] = str(fixture_app)
            receipt["dependency_root"] = str(real_dependencies)
            with (run_root / "next.log").open("w", encoding="utf-8") as next_log:
                process = subprocess.Popen(
                    [node, str(next_cli), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", str(port)],
                    cwd=fixture_app, env=env, stdout=next_log, stderr=subprocess.STDOUT,
                    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
                    start_new_session=os.name != "nt",
                )
                receipt["owned_server_pid"] = process.pid
                deadline = time.monotonic() + 240
                while True:
                    if process.poll() is not None:
                        raise storage.StorageError("Owned Next fixture server exited; inspect next.log")
                    try:
                        with urllib.request.urlopen(env["CONTROL_ROOM_URL"], timeout=3) as response:
                            if response.status == 200:
                                break
                    except (OSError, TimeoutError):
                        pass
                    if time.monotonic() >= deadline:
                        raise storage.StorageError("Owned Next fixture server did not become ready")
                    time.sleep(1)
                with (run_root / "browser.log").open("w", encoding="utf-8") as browser_log:
                    fixture_smoke = fixture_app / "scripts" / smoke.name
                    result = subprocess.run([node, str(fixture_smoke)], cwd=fixture_app, env=env,
                                            stdout=browser_log, stderr=subprocess.STDOUT, timeout=browser_timeout_seconds)
                receipt["exit_code"] = result.returncode
                receipt["state"] = "passed" if result.returncode == 0 else "failed"
        except BaseException as error:
            receipt.update(state="failed", error=str(error), exit_code=1)
        finally:
            if process is not None:
                try:
                    stop_owned_process(process)
                    deadline = time.monotonic() + 10
                    while port_is_open(port) and time.monotonic() < deadline:
                        time.sleep(0.25)
                    receipt["owned_server_terminal"] = process.poll() is not None and not port_is_open(port)
                    if not receipt["owned_server_terminal"]:
                        raise storage.StorageError("Owned fixture server termination was not verified")
                except BaseException as error:
                    receipt.update(state="failed", cleanup_error=str(error), exit_code=1)
            receipt["source_digest_after"] = fingerprint(repo, False)
            receipt["source_changed_during_run"] = (
                receipt["source_digest_after"] != before
                or hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != receipt["runner_sha256"]
                or hashlib.sha256((repo / "justfile").read_bytes()).hexdigest() != receipt["justfile_sha256"]
            )
            if receipt["source_changed_during_run"]:
                receipt.update(state="failed", exit_code=1)
            if scenario in {"inspector-actions", "explorer-physics-reporting", "preparation-workspace"}:
                browser_root = run_root / "browser"
                artifacts = []
                if browser_root.is_dir():
                    for artifact in sorted(path for path in browser_root.rglob("*") if path.is_file()):
                        artifacts.append({
                            "path": str(artifact.relative_to(run_root)),
                            "size_bytes": artifact.stat().st_size,
                            "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                        })
                receipt["browser_artifact_root"] = str(browser_root)
                receipt["browser_artifacts"] = artifacts
            if binding_path:
                try:
                    stage_dependency_roots(repo, layout, binding_path, binding_sha256, before)
                    receipt["dependency_stage_revalidated"] = True
                except (OSError, ValueError, KeyError, storage.StorageError) as error:
                    receipt.update(state="failed", exit_code=1, dependency_stage_error=str(error))
            if dependency_workspace is not None:
                try:
                    native_dependency_after = validate_dependency_workspace(repo, dependency_layout, dependency_workspace)
                    if native_dependency_after != native_dependency_before:
                        raise storage.StorageError("Native dependency workspace changed during browser verification")
                    receipt["dependency_stage_revalidated"] = True
                except (OSError, RuntimeError, ValueError) as error:
                    receipt.update(state="failed", exit_code=1, dependency_stage_error=str(error))
            if api_target:
                try:
                    after_target = managed_browser_target(repo, api_target["receipt"], api_target["receipt_sha256"])
                    if after_target != api_target:
                        raise ValueError("Managed API process identity changed during browser verification")
                    receipt["managed_api_target_revalidated"] = True
                except (OSError, ValueError, KeyError, storage.StorageError) as error:
                    receipt.update(state="failed", exit_code=1, managed_api_target_error=str(error))
            receipt["finished_at"] = timestamp()
            storage.atomic_json(receipt_path, receipt)
        if scenario in {"inspector-actions", "explorer-physics-reporting", "preparation-workspace"} and receipt["state"] != "passed":
            for key in ("error", "cleanup_error"):
                if receipt.get(key):
                    print(f"{key}: {str(receipt[key])[:2000]}", file=sys.stderr, flush=True)
            print_fixture_log_tails(run_root)
        print(json.dumps({"receipt": str(receipt_path), "state": receipt["state"]}))
        return receipt["exit_code"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--port", type=int)
    parser.add_argument("--dependency-workspace", type=Path)
    parser.add_argument("--scenario", choices=tuple(SCENARIOS), default="pinned-dataset")
    args = parser.parse_args()
    port = args.port if args.port is not None else {
        "antenna-regional-drive": 3272,
        "execution-profiles": 3255,
        "study-execution-profile": 3256,
        "inspector-routing": 3261,
        "inspector-actions": 3257,
        "explorer-physics-reporting": 3259,
    }.get(args.scenario, 3250)
    if not 1 <= port <= 65535:
        parser.error("port must be between 1 and 65535")
    raise SystemExit(run(args.repo_root.resolve(), port, args.scenario, args.dependency_workspace))
