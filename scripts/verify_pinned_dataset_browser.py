"""Managed browser fixtures for fixed Control Room routes; no solver or unit builds.

An immutable frontend source view and isolated Next outputs stay in storage.
Existing checkout dependencies are read, never installed, copied or rebound.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
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
    "inspector-actions": ("smoke-inspector-actions.mjs", "fullmag_inspector_actions_browser_fixture_v1", "inspector-actions", "FULLMAG_INSPECTOR_ACTIONS"),
    "explorer-physics-reporting": ("smoke-explorer-physics-reporting.mjs", "fullmag_explorer_physics_reporting_browser_fixture_v1", "explorer-physics-reporting", "FULLMAG_EXPLORER_PHYSICS_REPORTING"),
    "object-material-editor": ("smoke-object-material-editor.mjs", "fullmag_object_material_editor_browser_fixture_v1", "object-material-editor", "FULLMAG_OBJECT_MATERIAL_EDITOR"),
    "antenna-drive-editor": ("smoke-antenna-drive-editor.mjs", "fullmag_antenna_drive_editor_browser_fixture_v1", "antenna-drive-editor", "FULLMAG_ANTENNA_DRIVE_EDITOR"),
    "antenna-source-spectrum": ("smoke-antenna-source-spectrum.mjs", "fullmag_antenna_source_spectrum_browser_fixture_v1", "antenna-source-spectrum", "FULLMAG_ANTENNA_SOURCE_SPECTRUM"),
    "antenna-port-editor": ("smoke-antenna-port-editor.mjs", "fullmag_antenna_port_editor_browser_fixture_v1", "antenna-port-editor", "FULLMAG_ANTENNA_PORT_EDITOR"),
    "antenna-port-diagnostics": ("smoke-antenna-port-diagnostics.mjs", "fullmag_antenna_port_diagnostics_browser_fixture_v1", "antenna-port-diagnostics", "FULLMAG_ANTENNA_PORT_DIAGNOSTICS"),
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


def run(repo: Path, port: int, scenario: str = "pinned-dataset"):
    if scenario not in SCENARIOS:
        raise storage.StorageError("Unknown fixed browser fixture scenario")
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
    smoke_name, receipt_schema, fixture_route, report_prefix = SCENARIOS[scenario]
    layout = storage.resolve_layout(repo, PROFILE)
    storage.initialize(layout)
    app = repo / "apps/control-room"
    smoke = app / "scripts" / smoke_name
    node = shutil.which("node")
    next_cli = app / "node_modules/next/dist/bin/next"
    if not node or not next_cli.is_file() or not smoke.is_file():
        raise storage.StorageError("Existing Node, Next and scenario smoke are required; no bootstrap")
    dependencies = app / "node_modules"
    real_dependencies = dependencies.resolve()
    if not (real_dependencies == dependencies or
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
        receipt_path = run_root / "receipt.json"
        receipt = {
            "schema": receipt_schema, "state": "running",
            "scenario": scenario,
            "repo_root": str(repo), "worktree_id": layout["worktree_id"], "profile": PROFILE,
            "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
            "source_digest_before": before, "started_at": timestamp(),
            "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "justfile_sha256": hashlib.sha256((repo / "justfile").read_bytes()).hexdigest(),
            "qualification": "fixture_only_not_backend_runtime_or_science",
            "unit_tests": "not_compiled_not_run", "port": port,
            "browser_channel": BROWSER_CHANNEL or "playwright_chromium",
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
            for name in ("package.json", "pnpm-workspace.yaml"):
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
            root_dependencies = repo / "node_modules"
            if root_dependencies.is_dir():
                root_real_dependencies = root_dependencies.resolve()
                if not (root_real_dependencies == root_dependencies or
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
                                            stdout=browser_log, stderr=subprocess.STDOUT, timeout=240)
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
            if scenario in {"inspector-actions", "explorer-physics-reporting"}:
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
            receipt["finished_at"] = timestamp()
            storage.atomic_json(receipt_path, receipt)
        if scenario in {"inspector-actions", "explorer-physics-reporting"} and receipt["state"] != "passed":
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
    parser.add_argument("--scenario", choices=tuple(SCENARIOS), default="pinned-dataset")
    args = parser.parse_args()
    port = args.port if args.port is not None else {
        "execution-profiles": 3255,
        "study-execution-profile": 3256,
        "inspector-routing": 3261,
        "inspector-actions": 3257,
        "explorer-physics-reporting": 3259,
    }.get(args.scenario, 3250)
    if not 1 <= port <= 65535:
        parser.error("port must be between 1 and 65535")
    raise SystemExit(run(args.repo_root.resolve(), port, args.scenario))
