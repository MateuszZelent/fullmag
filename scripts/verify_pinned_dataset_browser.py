"""Managed browser fixture proof of pinned results, without solver or unit builds.

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
import time
import urllib.request
import uuid

import fullmag_storage as storage
from verify_control_room_sources import fingerprint, timestamp

PROFILE = "windows-control-room-browser-fixture"
BROWSER_CHANNEL = "chrome" if os.name == "nt" else None


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


def run(repo: Path, port: int, scenario: str = "pinned-dataset"):
    if scenario not in {"pinned-dataset", "project-document-handoff", "development-kernel-host"}:
        raise storage.StorageError("Unknown fixed browser fixture scenario")
    layout = storage.resolve_layout(repo, PROFILE)
    storage.initialize(layout)
    app = repo / "apps/control-room"
    smoke_name = {"pinned-dataset": "smoke-pinned-materialized-dataset.mjs", "project-document-handoff": "smoke-project-document-handoff.mjs", "development-kernel-host": "smoke-development-kernel-host.mjs"}[scenario]
    smoke = app / "scripts" / smoke_name
    node = shutil.which("node")
    next_cli = app / "node_modules/next/dist/bin/next"
    if not node or not next_cli.is_file() or not smoke.is_file():
        raise storage.StorageError("Existing Node, Next and pinned dataset smoke are required; no bootstrap")
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
            "schema": {"pinned-dataset": "fullmag_pinned_dataset_browser_fixture_v1", "project-document-handoff": "fullmag_project_document_browser_fixture_v1", "development-kernel-host": "fullmag_development_kernel_host_browser_fixture_v1"}[scenario], "state": "running",
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
            if scenario != "pinned-dataset":
                fixture_page = fixture_app / f"scripts/fixtures/{scenario}-page.tsx"
                if not fixture_page.is_file():
                    raise storage.StorageError("Project document browser fixture page is missing")
                target_page = fixture_app / f"app/{scenario}/page.tsx"
                if target_page.exists():
                    raise storage.StorageError("Project document fixture must not overwrite a product route")
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
            if scenario != "pinned-dataset":
                env["CONTROL_ROOM_URL"] = f"http://127.0.0.1:{port}/{scenario}"
                if scenario == "development-kernel-host":
                    env["CONTROL_ROOM_URL"] += "?fullmag_api_instance=11111111-1111-4111-8111-111111111111"
                env["FULLMAG_PROJECT_DOCUMENT_REPORT_DIR"] = str(run_root / "browser")
                if BROWSER_CHANNEL:
                    env["FULLMAG_PROJECT_DOCUMENT_BROWSER_CHANNEL"] = BROWSER_CHANNEL
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
            receipt["finished_at"] = timestamp()
            storage.atomic_json(receipt_path, receipt)
        print(json.dumps({"receipt": str(receipt_path), "state": receipt["state"]}))
        return receipt["exit_code"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--port", type=int, default=3250)
    parser.add_argument("--scenario", choices=("pinned-dataset", "project-document-handoff", "development-kernel-host"), default="pinned-dataset")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    raise SystemExit(run(args.repo_root.resolve(), args.port, args.scenario))
