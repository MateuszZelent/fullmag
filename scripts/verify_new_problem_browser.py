"""Managed browser and production-source checks for the New Problem dialog."""
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
ROUTE = "new-problem-verification"
MANIFESTS = ("pnpm-lock.yaml", "package.json", "apps/control-room/package.json")
DEFAULT_LINT_PATHS = (
    "src/kernel/api/ControlRoomApi.ts",
    "src/kernel/api/apiPaths.ts",
    "src/kernel/api/apiTypes.ts",
    "src/kernel/api/generated/openapi-v2-types.ts",
    "src/kernel/api/generated/openapi-v2-client.ts",
    "src/kernel/api/generated/openapi-v2-paths.ts",
    "src/kernel/layout/NewProblemDialog.tsx",
    "src/kernel/layout/newProblemStorage.ts",
    "src/kernel/resources/useOutputStorageDefaults.ts",
    "scripts/fixtures/new-problem-page.tsx",
    "scripts/smoke-new-problem-dialog.mjs",
)
TEST_EXCLUDES = (
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.spec.ts",
    "**/*.spec.tsx",
    "**/__tests__/**",
)
GENERATOR_INPUTS = (
    "apps/control-room/src/kernel/api/generated/openapi-v2.json",
    "apps/control-room/scripts/generate-v2-client.mjs",
)
GENERATED_OUTPUTS = (
    "apps/control-room/src/kernel/api/generated/openapi-v2-types.ts",
    "apps/control-room/src/kernel/api/generated/openapi-v2-client.ts",
    "apps/control-room/src/kernel/api/generated/openapi-v2-paths.ts",
)
BROWSER_CHANNEL = "chrome" if os.name == "nt" else None


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=False
    )
    if result.returncode:
        raise storage.StorageError(
            f"Cannot identify Git checkout at {repo}: {result.stderr.strip()}"
        )
    return result.stdout.strip()


def _common_git_dir(repo: Path) -> Path:
    value = Path(_git(repo, "rev-parse", "--git-common-dir"))
    return (repo / value if not value.is_absolute() else value).resolve()


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _frontend_tree_inventory(repo: Path) -> dict[str, str]:
    app = repo / "apps/control-room"
    excluded = {"node_modules", "out", "build", "storybook-static", "target-host", ".fullmag"}
    inventory = {}
    for directory, children, names in os.walk(app):
        current = Path(directory)
        children[:] = [
            name for name in children
            if name not in excluded
            and not name.startswith(".next")
            and not storage.is_link(current / name)
        ]
        for name in names:
            path = current / name
            if path.is_file() and not storage.is_link(path):
                inventory[path.relative_to(repo).as_posix()] = _sha256(path)
    return inventory


def _manifest_digests(checkout: Path) -> dict[str, str]:
    result = {}
    for relative in MANIFESTS:
        path = checkout / relative
        if not path.is_file():
            raise storage.StorageError(f"Required dependency manifest is missing: {path}")
        result[relative] = _sha256(path)
    return result


def _source_digest(repo: Path, generating: bool = False) -> str:
    digest = hashlib.sha256()
    digest.update(fingerprint(repo, generating).encode("ascii"))
    for relative in (*MANIFESTS, "scripts/new-problem-verification.just"):
        path = repo / relative
        if not path.is_file():
            raise storage.StorageError(f"Source digest input is missing: {path}")
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def _normalize_lint_path(value: str) -> Path:
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        raise storage.StorageError(f"Lint path must be repository-relative: {value}")
    if path.parts[:2] == ("apps", "control-room"):
        path = Path(*path.parts[2:])
    if not path.parts or path.suffix.lower() not in {".ts", ".tsx", ".js", ".mjs", ".cjs"}:
        raise storage.StorageError(f"Unsupported Control Room lint path: {value}")
    return path


def _main_checkout(repo: Path, layout: dict) -> Path:
    records = storage.worktree_records(repo)
    main = Path(str(records[0]["worktree"])).resolve()
    if not main.is_dir() or _common_git_dir(repo) != _common_git_dir(main):
        raise storage.StorageError("Task and main checkout do not share an available Git root")
    if main.parent != Path(layout["project_root"]).resolve():
        raise storage.StorageError("Git and storage resolver disagree on the project root")
    if Path(_git(main, "rev-parse", "--show-toplevel")).resolve() != main:
        raise storage.StorageError("Git's main checkout path did not resolve to its root")
    return main


def _dependency_owner(repo: Path, main: Path) -> dict:
    task_manifests = _manifest_digests(repo)
    owner_manifests = _manifest_digests(main)
    if task_manifests != owner_manifests:
        changed = [name for name in MANIFESTS if task_manifests[name] != owner_manifests[name]]
        raise storage.StorageError(
            "Main-checkout dependencies cannot be reused because manifests differ: "
            + ", ".join(changed)
        )
    for relative in ("node_modules", "apps/control-room/node_modules"):
        if storage.is_link(repo / relative):
            raise storage.StorageError("Task worktree dependencies are not used by this fixture")

    app_deps = main / "apps/control-room/node_modules"
    if not app_deps.is_dir() or storage.is_link(app_deps):
        raise storage.StorageError(
            "Owned main-checkout Control Room node_modules are required; no install is allowed"
        )
    app_real = app_deps.resolve()
    if not storage.inside(app_real, main):
        raise storage.StorageError("Main-checkout app dependencies resolve outside that checkout")
    root_deps = main / "node_modules"
    root_real = root_deps.resolve() if root_deps.is_dir() else None
    if root_real and (storage.is_link(root_deps) or not storage.inside(root_real, main)):
        raise storage.StorageError("Main-checkout root dependencies are not owned by that checkout")

    tools = {
        "next": app_real / "next/dist/bin/next",
        "typescript": app_real / "typescript/bin/tsc",
        "eslint": app_real / "eslint/bin/eslint.js",
        "openapi_typescript": app_real / "openapi-typescript/bin/cli.js",
        "react_doctor": root_real / "react-doctor/bin/react-doctor.js" if root_real else None,
    }
    required = {"next", "typescript", "eslint"}
    missing = [name for name, path in tools.items() if name in required and (path is None or not path.is_file())]
    if missing:
        raise storage.StorageError("Required main-checkout frontend tools are missing: " + ", ".join(missing))
    tool_paths = {
        name: str(path) for name, path in tools.items() if path is not None and path.is_file()
    }
    return {
        "checkout": str(main),
        "common_git_dir": str(_common_git_dir(main)),
        "app_node_modules": str(app_deps),
        "app_node_modules_realpath": str(app_real),
        "root_node_modules": str(root_deps) if root_real else None,
        "root_node_modules_realpath": str(root_real) if root_real else None,
        "manifest_sha256": {
            name: {"task_checkout": task_manifests[name], "dependency_owner": owner_manifests[name]}
            for name in MANIFESTS
        },
        "tool_paths": tool_paths,
    }


def _link_directory(link: Path, target: Path) -> None:
    if link.exists() or storage.is_link(link):
        raise storage.StorageError(f"Fixture link already exists: {link}")
    link.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        result = subprocess.run(
            [
                "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference='Stop'; "
                "New-Item -ItemType Junction -Path $env:FULLMAG_LINK_SOURCE "
                "-Value $env:FULLMAG_LINK_TARGET | Out-Null",
            ],
            env={**os.environ, "FULLMAG_LINK_SOURCE": str(link), "FULLMAG_LINK_TARGET": str(target)},
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode:
            raise storage.StorageError(f"Cannot create dependency link: {result.stderr}")
    else:
        link.symlink_to(target, target_is_directory=True)
    if link.resolve() != target.resolve():
        raise storage.StorageError(f"Fixture link identity mismatch: {link}")


def _copy_frontend_snapshot(repo: Path, run_root: Path, expected_fingerprint: str) -> tuple[Path, str]:
    app = repo / "apps/control-room"
    snapshot = run_root / "source"
    fixture_app = snapshot / "apps/control-room"
    fixture_app.mkdir(parents=True)
    ignored = shutil.ignore_patterns(
        "node_modules", "out", "build", "storybook-static", "target-host",
        ".fullmag", ".next", ".next-*",
    )
    for name in ("app", "src", "public", "scripts"):
        source = app / name
        if source.is_dir():
            shutil.copytree(source, fixture_app / name, ignore=ignored)
    for source in app.iterdir():
        if source.is_file() and (
            source.name == "package.json"
            or source.suffix.lower() in {".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".css"}
        ):
            shutil.copy2(source, fixture_app / source.name)
    for name in ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"):
        source = repo / name
        if source.is_file():
            shutil.copy2(source, snapshot / name)
    snapshot_tsconfig = fixture_app / "tsconfig.json"
    if snapshot_tsconfig.is_file():
        config = json.loads(snapshot_tsconfig.read_text(encoding="utf-8"))
        excluded = list(config.get("exclude", []))
        config["exclude"] = list(dict.fromkeys((*excluded, *TEST_EXCLUDES)))
        snapshot_tsconfig.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    if fingerprint(repo, False) != expected_fingerprint:
        raise storage.StorageError("Frontend sources changed while copying the source view")

    fixture_page = fixture_app / "scripts/fixtures/new-problem-page.tsx"
    route_page = fixture_app / f"app/{ROUTE}/page.tsx"
    if not fixture_page.is_file() or route_page.exists():
        raise storage.StorageError("New Problem fixture is missing or would overwrite a product route")
    route_page.parent.mkdir(parents=True, exist_ok=False)
    shutil.copy2(fixture_page, route_page)
    digest = hashlib.sha256()
    for path in sorted(item for item in snapshot.rglob("*") if item.is_file() and not storage.is_link(item)):
        digest.update(path.relative_to(snapshot).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return fixture_app, digest.hexdigest()


def _port_is_open(port: int) -> bool:
    with socket.socket() as probe:
        probe.settimeout(1)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def _require_free_port(port: int) -> None:
    with socket.socket() as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError as error:
            raise storage.StorageError(f"Fixture port is already in use: {port}") from error


def _stop_owned_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait(timeout=30)


def _run_owned_command(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    log_path: Path,
    label: str,
    timeout_seconds: int,
    receipt: dict,
) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
            start_new_session=os.name != "nt",
        )
        try:
            exit_code = process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired as error:
            _stop_owned_process(process)
            receipt["steps"].append(
                {"name": label, "pid": process.pid, "state": "timed_out", "timeout_seconds": timeout_seconds}
            )
            raise storage.StorageError(f"Owned {label} process timed out") from error
    receipt["steps"].append({"name": label, "pid": process.pid, "exit_code": exit_code})
    if exit_code:
        raise storage.StorageError(f"Owned {label} process failed with exit code {exit_code}")


def _prepare_output_links(
    fixture_app: Path,
    output: Path,
    app_dependencies: Path,
    root_dependencies: Path | None,
    port: int,
) -> Path:
    output.mkdir(parents=True)
    _link_directory(fixture_app / "node_modules", app_dependencies)
    if root_dependencies is not None:
        _link_directory(fixture_app.parent.parent / "node_modules", root_dependencies)
    _link_directory(output / "node_modules", app_dependencies)

    dist_name = f".next-control-room-{port}"
    for relative, target in {
        ".fullmag-frontend": output,
        "out": output / "out",
        ".next": output / "next/default",
        dist_name: output / f"next/dev-{port}",
    }.items():
        target.mkdir(parents=True, exist_ok=True)
        _link_directory(fixture_app / relative, target)
    _link_directory(output / "app", fixture_app / "app")
    _link_directory(output / "next/app", fixture_app / "app")
    return fixture_app / dist_name


def _run_typecheck_and_lint(
    *,
    repo: Path,
    fixture_app: Path,
    output: Path,
    env: dict[str, str],
    node: str,
    owner: dict,
    lint_paths: tuple[Path, ...],
    timeout_seconds: int,
    receipt: dict,
) -> None:
    tools = owner["tool_paths"]
    exclude = [
        str(fixture_app / "node_modules"),
        str(fixture_app / "out"),
        str(fixture_app / ".next/dev"),
        str(output / "node_modules"),
        *(str(fixture_app / pattern) for pattern in TEST_EXCLUDES),
    ]
    config_path = output / "tsconfig.production.json"
    config_path.write_text(
        json.dumps(
            {
                "extends": str(fixture_app / "tsconfig.typecheck.json"),
                "compilerOptions": {"noEmit": True, "incremental": False},
                "include": [
                    "next-env.d.ts",
                    "typecheck-env.d.ts",
                    "**/*.ts",
                    "**/*.tsx",
                    "**/*.mts",
                ],
                "exclude": [
                    *exclude,
                    str(fixture_app / ".next"),
                    str(fixture_app / env.get("FULLMAG_NEXT_DIST_DIR", ".next")),
                ],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    receipt["typecheck"] = {
        "command": "tsc --noEmit --incremental false",
        "config": str(config_path),
        "test_sources_excluded": list(TEST_EXCLUDES),
    }
    _run_owned_command(
        [node, tools["typescript"], "--noEmit", "--incremental", "false", "--project", str(config_path)],
        cwd=fixture_app,
        env=env,
        log_path=Path(receipt["browser_log_dir"]) / "production-typecheck.log",
        label="production_tsc",
        timeout_seconds=timeout_seconds,
        receipt=receipt,
    )

    paths = [path.as_posix() for path in lint_paths]
    receipt["eslint"] = {"max_warnings": 0, "paths": paths, "cache": "disabled"}
    _run_owned_command(
        [node, tools["eslint"], *paths, "--max-warnings=0", "--no-cache"],
        cwd=fixture_app,
        env=env,
        log_path=Path(receipt["browser_log_dir"]) / "eslint.log",
        label="eslint_changed_sources",
        timeout_seconds=timeout_seconds,
        receipt=receipt,
    )

    doctor = tools.get("react_doctor")
    if doctor is None:
        receipt["react_doctor"] = {
            "state": "unavailable",
            "reason": "Not installed in the read-only main-checkout dependency owner; no bootstrap attempted",
        }
    else:
        doctor_output = output / "react-doctor"
        doctor_output.mkdir(parents=True, exist_ok=False)
        doctor_report = Path(receipt["browser_report_dir"]) / "react-doctor.json"
        doctor_command = [
            node,
            doctor,
            "--verbose",
            "--scope",
            "changed",
            "--include-untracked",
            "--no-supply-chain",
            "--no-score",
            "--no-cache",
            "--max-duration",
            str(timeout_seconds),
            "--output-dir",
            str(doctor_output),
            "--json",
            "--json-out",
            str(doctor_report),
            "apps/control-room",
        ]
        receipt["react_doctor"] = {
            "state": "running",
            "command": [str(part) for part in doctor_command],
            "report": str(doctor_report),
            "output_dir": str(doctor_output),
            "scope": "changed_including_untracked",
            "supply_chain": "disabled",
            "telemetry": "disabled",
            "cache": "disabled",
        }
        _run_owned_command(
            doctor_command,
            cwd=repo,
            env=env,
            log_path=Path(receipt["browser_log_dir"]) / "react-doctor.log",
            label="react_doctor_changed_scope",
            timeout_seconds=timeout_seconds,
            receipt=receipt,
        )
        receipt["react_doctor"]["state"] = "completed"
        receipt["react_doctor"]["report_sha256"] = _sha256(doctor_report)


def _wait_for_server(process: subprocess.Popen, url: str, timeout_seconds: int) -> None:
    deadline = time.monotonic() + timeout_seconds
    while True:
        if process.poll() is not None:
            raise storage.StorageError("Owned Next fixture server exited before readiness; inspect next.log")
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status == 200:
                    return
        except (OSError, TimeoutError):
            pass
        if time.monotonic() >= deadline:
            raise storage.StorageError("Owned Next fixture server did not become ready")
        time.sleep(1)


def _run_locked(
    repo: Path,
    layout: dict,
    owner: dict,
    port: int,
    lint_paths: tuple[Path, ...],
    timeout_seconds: int,
) -> tuple[int, Path, dict]:
    run_root = storage.validate_path(
        Path(layout["build_root"]) / "new-problem-browser" / uuid.uuid4().hex,
        layout["build_storage_root"],
        "new problem browser run",
    )
    run_root.mkdir(parents=True, exist_ok=False)
    output = run_root / "output"
    browser_dir = run_root / "browser"
    screenshot_dir = run_root / "screenshots"
    browser_dir.mkdir()
    screenshot_dir.mkdir()
    receipt_path = run_root / "receipt.json"
    source_before = _source_digest(repo)
    fingerprint_before = fingerprint(repo, False)
    receipt = {
        "schema": "fullmag_new_problem_browser_fixture_v1",
        "state": "running",
        "qualification": "fixture_only_not_backend_runtime_or_science",
        "unit_tests": "not_compiled_not_run",
        "repo_root": str(repo),
        "project_root": layout["project_root"],
        "worktree_id": layout["worktree_id"],
        "profile": PROFILE,
        "head": _git(repo, "rev-parse", "HEAD"),
        "branch": _git(repo, "branch", "--show-current"),
        "started_at": timestamp(),
        "source_digest_before": source_before,
        "control_room_fingerprint_before": fingerprint_before,
        "dependency_owner": owner["checkout"],
        "dependency_root": owner["app_node_modules_realpath"],
        "dependency_paths": {
            "app_node_modules": owner["app_node_modules"],
            "root_node_modules": owner["root_node_modules"],
        },
        "dependency_manifest_sha256": owner["manifest_sha256"],
        "runner_sha256": _sha256(Path(__file__).resolve()),
        "recipe_sha256": _sha256(repo / "scripts/new-problem-verification.just"),
        "storage_build_lock_owner": str(Path(layout["storage_root"]) / "locks" / f"{layout['worktree_id']}.owner.json"),
        "storage_build_lock_state": "held_during_run",
        "port": port,
        "browser_channel": BROWSER_CHANNEL or "playwright_chromium",
        "source_snapshot": str(run_root / "source"),
        "output_root": str(output),
        "browser_report_dir": str(browser_dir),
        "screenshots_dir": str(screenshot_dir),
        "browser_log_dir": str(browser_dir),
        "lint_paths": [path.as_posix() for path in lint_paths],
        "steps": [],
    }
    storage.atomic_json(receipt_path, receipt)

    server: subprocess.Popen | None = None
    exit_code = 1
    try:
        if _source_digest(repo) != source_before:
            raise storage.StorageError("Control Room sources changed before the source snapshot")
        fixture_app, snapshot_digest = _copy_frontend_snapshot(repo, run_root, fingerprint_before)
        if _source_digest(repo) != source_before:
            raise storage.StorageError("Control Room sources changed while taking the source snapshot")
        receipt["source_snapshot_sha256"] = snapshot_digest

        app_dependencies = Path(owner["app_node_modules_realpath"])
        root_dependencies = (
            Path(owner["root_node_modules_realpath"])
            if owner["root_node_modules_realpath"]
            else None
        )
        dist_link = _prepare_output_links(
            fixture_app, output, app_dependencies, root_dependencies, port
        )
        node = shutil.which("node")
        if not node:
            raise storage.StorageError("Node.js is unavailable; no frontend bootstrap is allowed")
        temp_root = output / "tmp"
        temp_root.mkdir()
        env = {
            **os.environ,
            **layout["env"],
            "FULLMAG_FRONTEND_ROOT": str(output),
            "FULLMAG_NEXT_DIST_DIR": dist_link.name,
            "FULLMAG_FRONTEND_SOURCE_RUN_ROOT": str(run_root),
            "FULLMAG_NEW_PROBLEM_REPORT_DIR": str(browser_dir),
            "FULLMAG_NEW_PROBLEM_SCREENSHOT_DIR": str(screenshot_dir),
            "CONTROL_ROOM_URL": f"http://127.0.0.1:{port}/{ROUTE}",
            "NEXT_TELEMETRY_DISABLED": "1",
            "NODE_COMPILE_CACHE": str(output / "node-compile-cache"),
            "NODE_PATH": os.pathsep.join(
                value for value in (owner["app_node_modules_realpath"], owner["root_node_modules_realpath"]) if value
            ),
            "TMP": str(temp_root),
            "TEMP": str(temp_root),
            "TMPDIR": str(temp_root),
        }
        if BROWSER_CHANNEL:
            env["FULLMAG_NEW_PROBLEM_BROWSER_CHANNEL"] = BROWSER_CHANNEL

        with (browser_dir / "next.log").open("w", encoding="utf-8") as log:
            server = subprocess.Popen(
                [node, owner["tool_paths"]["next"], "dev", "--webpack", "--hostname", "127.0.0.1", "--port", str(port)],
                cwd=fixture_app,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
                start_new_session=os.name != "nt",
            )
            receipt["owned_server_pid"] = server.pid
            _wait_for_server(server, env["CONTROL_ROOM_URL"], timeout_seconds)

        next_output = output / f"next/dev-{port}"
        generated_types = next_output / "dev/types"
        if not generated_types.is_dir():
            generated_types = next_output / "types"
        if not generated_types.is_dir():
            raise storage.StorageError("Next did not generate route types in the isolated output")
        _run_owned_command(
            [node, str(fixture_app / "scripts/smoke-new-problem-dialog.mjs")],
            cwd=fixture_app,
            env=env,
            log_path=browser_dir / "browser.log",
            label="browser_smoke",
            timeout_seconds=timeout_seconds,
            receipt=receipt,
        )
        _run_typecheck_and_lint(
            repo=repo,
            fixture_app=fixture_app,
            output=output,
            env=env,
            node=node,
            owner=owner,
            lint_paths=lint_paths,
            timeout_seconds=timeout_seconds,
            receipt=receipt,
        )
        report_path = browser_dir / "new-problem-browser.json"
        receipt["browser_report"] = str(report_path)
        if not report_path.is_file():
            raise storage.StorageError("Browser smoke did not write its JSON report")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        receipt["browser_report_state"] = report.get("state")
        if report.get("state") != "passed":
            raise storage.StorageError("Browser smoke report did not declare state=passed")
        receipt["screenshots"] = sorted(str(path) for path in screenshot_dir.glob("*.png"))
        exit_code = 0
    except BaseException as error:
        receipt.update(state="failed", error=str(error))
        exit_code = 1
    finally:
        if server is not None:
            try:
                _stop_owned_process(server)
                deadline = time.monotonic() + 10
                while _port_is_open(port) and time.monotonic() < deadline:
                    time.sleep(0.25)
                receipt["owned_server_terminal"] = (
                    server.poll() is not None and not _port_is_open(port)
                )
                if not receipt["owned_server_terminal"]:
                    raise storage.StorageError("Owned fixture server termination was not verified")
            except BaseException as error:
                receipt.update(state="failed", cleanup_error=str(error))
                exit_code = 1
        try:
            receipt["source_digest_after"] = _source_digest(repo)
            receipt["control_room_fingerprint_after"] = fingerprint(repo, False)
            receipt["source_changed_during_run"] = source_before != receipt["source_digest_after"]
        except BaseException as error:
            receipt["source_digest_after_error"] = str(error)
            receipt["source_changed_during_run"] = True
        if receipt.get("source_changed_during_run"):
            receipt.update(state="failed", error="Control Room sources changed during the run")
            exit_code = 1
        if exit_code == 0:
            receipt["state"] = "passed"
        receipt["exit_code"] = exit_code
        receipt["finished_at"] = timestamp()
        storage.atomic_json(receipt_path, receipt)

    return exit_code, receipt_path, receipt



def _run_client_codegen_locked(
    repo: Path,
    layout: dict,
    owner: dict,
    timeout_seconds: int,
) -> tuple[int, Path, dict]:
    run_root = storage.validate_path(
        Path(layout["build_root"]) / "new-problem-client-codegen" / uuid.uuid4().hex,
        layout["build_storage_root"],
        "new problem client codegen run",
    )
    run_root.mkdir(parents=True, exist_ok=False)
    temp_root = run_root / "tmp"
    temp_root.mkdir()
    app = repo / "apps/control-room"
    input_paths = {relative: repo / relative for relative in GENERATOR_INPUTS}
    output_paths = {relative: repo / relative for relative in GENERATED_OUTPUTS}
    input_before = {
        relative: _sha256(path) if path.is_file() else None
        for relative, path in input_paths.items()
    }
    output_inventory_before = _frontend_tree_inventory(repo)
    source_before = _source_digest(repo, generating=True)
    receipt_path = run_root / "receipt.json"
    node = shutil.which("node")
    receipt = {
        "schema": "fullmag_new_problem_client_codegen_v1",
        "state": "running",
        "mode": "generate_client",
        "qualification": "generated_frontend_client_only",
        "unit_tests": "not_compiled_not_run",
        "repo_root": str(repo),
        "project_root": layout["project_root"],
        "worktree_id": layout["worktree_id"],
        "profile": PROFILE,
        "head": _git(repo, "rev-parse", "HEAD"),
        "branch": _git(repo, "branch", "--show-current"),
        "started_at": timestamp(),
        "source_digest_before": source_before,
        "generator_inputs": {
            relative: {"sha256_before": digest}
            for relative, digest in input_before.items()
        },
        "generated_outputs": [
            {
                "path": relative,
                "sha256_before": output_inventory_before.get(relative),
            }
            for relative in GENERATED_OUTPUTS
        ],
        "dependency_owner": owner["checkout"],
        "dependency_root": owner["app_node_modules_realpath"],
        "dependency_paths": {
            "app_node_modules": owner["app_node_modules"],
            "root_node_modules": owner["root_node_modules"],
            "openapi_typescript_cli": owner["tool_paths"].get("openapi_typescript"),
        },
        "dependency_manifest_sha256": owner["manifest_sha256"],
        "runner_sha256": _sha256(Path(__file__).resolve()),
        "recipe_sha256": _sha256(repo / "scripts/new-problem-verification.just"),
        "storage_build_lock_owner": str(
            Path(layout["storage_root"]) / "locks" / f"{layout['worktree_id']}.owner.json"
        ),
        "storage_build_lock_state": "held_during_run",
        "run_root": str(run_root),
        "log_dir": str(run_root),
        "mutable_tool_output_root": str(temp_root),
        "steps": [],
    }
    storage.atomic_json(receipt_path, receipt)
    exit_code = 1
    try:
        if not node:
            raise storage.StorageError("Node.js is unavailable; no frontend bootstrap is allowed")
        cli = owner["tool_paths"].get("openapi_typescript")
        if not cli or not Path(cli).is_file():
            raise storage.StorageError("Read-only main-checkout openapi-typescript CLI is missing")
        missing_inputs = [name for name, digest in input_before.items() if digest is None]
        if missing_inputs:
            raise storage.StorageError(
                "OpenAPI codegen inputs are missing: " + ", ".join(missing_inputs)
            )
        expected_outputs = set(GENERATED_OUTPUTS)
        app_dependencies = owner["app_node_modules_realpath"]
        root_dependencies = owner["root_node_modules_realpath"]
        env = {
            **os.environ,
            **layout["env"],
            "FULLMAG_FRONTEND_SOURCE_RUN_ROOT": str(run_root),
            "NODE_PATH": os.pathsep.join(
                value for value in (app_dependencies, root_dependencies) if value
            ),
            "NODE_DISABLE_COMPILE_CACHE": "1",
            "TMP": str(temp_root),
            "TEMP": str(temp_root),
            "TMPDIR": str(temp_root),
        }
        relative_json = Path(GENERATOR_INPUTS[0]).relative_to("apps/control-room")
        relative_types = Path(GENERATED_OUTPUTS[0]).relative_to("apps/control-room")
        commands = [
            (
                "openapi_typescript",
                [node, cli, relative_json.as_posix(), "--output", relative_types.as_posix()],
            ),
            (
                "generate_v2_client",
                [node, "scripts/generate-v2-client.mjs"],
            ),
        ]
        receipt["logs"] = []
        for label, command in commands:
            step_log = run_root / f"{label}.log"
            receipt["logs"].append(str(step_log))
            _run_owned_command(
                command,
                cwd=app,
                env=env,
                log_path=step_log,
                label=label,
                timeout_seconds=timeout_seconds,
                receipt=receipt,
            )

        input_after = {
            relative: _sha256(path) if path.is_file() else None
            for relative, path in input_paths.items()
        }
        output_inventory_after = _frontend_tree_inventory(repo)
        changed_paths = sorted(
            relative
            for relative in set(output_inventory_before) | set(output_inventory_after)
            if output_inventory_before.get(relative) != output_inventory_after.get(relative)
        )
        missing_outputs = [relative for relative, path in output_paths.items() if not path.is_file()]
        receipt["generator_inputs"] = {
            relative: {
                "sha256_before": input_before[relative],
                "sha256_after": input_after[relative],
            }
            for relative in GENERATOR_INPUTS
        }
        receipt["generated_outputs"] = [
            {
                "path": relative,
                "sha256_before": output_inventory_before.get(relative),
                "sha256_after": output_inventory_after.get(relative),
                "changed": output_inventory_before.get(relative) != output_inventory_after.get(relative),
            }
            for relative in GENERATED_OUTPUTS
        ]
        receipt["changed_paths"] = changed_paths
        receipt["source_digest_after"] = _source_digest(repo, generating=True)
        receipt["source_changed_during_run"] = (
            source_before != receipt["source_digest_after"]
            or input_before != input_after
        )
        unexpected = sorted(set(changed_paths) - expected_outputs)
        if unexpected:
            raise storage.StorageError(
                "Client codegen changed files outside its three generated outputs: "
                + ", ".join(unexpected)
            )
        if missing_outputs:
            raise storage.StorageError("Client codegen outputs are missing: " + ", ".join(missing_outputs))
        if receipt["source_changed_during_run"]:
            raise storage.StorageError("OpenAPI source or generator inputs changed during codegen")
        exit_code = 0
    except BaseException as error:
        receipt.update(state="failed", error=str(error))
        exit_code = 1
    finally:
        try:
            input_after = {
                relative: _sha256(path) if path.is_file() else None
                for relative, path in input_paths.items()
            }
            output_inventory_after = _frontend_tree_inventory(repo)
            receipt.setdefault(
                "generator_inputs",
                {
                    relative: {
                        "sha256_before": input_before[relative],
                        "sha256_after": input_after[relative],
                    }
                    for relative in GENERATOR_INPUTS
                },
            )
            receipt.setdefault(
                "generated_outputs",
                [
                    {
                        "path": relative,
                        "sha256_before": output_inventory_before.get(relative),
                        "sha256_after": output_inventory_after.get(relative),
                        "changed": output_inventory_before.get(relative) != output_inventory_after.get(relative),
                    }
                    for relative in GENERATED_OUTPUTS
                ],
            )
            receipt.setdefault(
                "changed_paths",
                sorted(
                    relative
                    for relative in set(output_inventory_before) | set(output_inventory_after)
                    if output_inventory_before.get(relative) != output_inventory_after.get(relative)
                ),
            )
            receipt["source_digest_after"] = _source_digest(repo, generating=True)
            receipt["source_changed_during_run"] = (
                source_before != receipt["source_digest_after"]
                or input_before != input_after
            )
        except BaseException as error:
            receipt["after_snapshot_error"] = str(error)
            receipt["source_changed_during_run"] = True
            exit_code = 1
        if receipt.get("source_changed_during_run"):
            receipt.update(state="failed", error=receipt.get("error", "Source changed during client codegen"))
            exit_code = 1
        if exit_code == 0:
            receipt["state"] = "passed"
        receipt["exit_code"] = exit_code
        receipt["finished_at"] = timestamp()
        storage.atomic_json(receipt_path, receipt)
    return exit_code, receipt_path, receipt


def run(
    repo_root: Path,
    port: int,
    lint_values: tuple[str, ...],
    timeout_seconds: int,
    generate_client: bool = False,
) -> int:
    requested = repo_root.resolve()
    repo = Path(_git(requested, "rev-parse", "--show-toplevel")).resolve()
    if repo != requested:
        raise storage.StorageError(f"Pass the worktree root, not a nested path: {requested}")
    if _git(repo, "rev-parse", "--show-superproject-working-tree"):
        raise storage.StorageError("Run from the Fullmag checkout, not a Git submodule")

    layout = storage.resolve_layout(repo, PROFILE)
    main = _main_checkout(repo, layout)
    owner = _dependency_owner(repo, main)
    if not shutil.which("node"):
        raise storage.StorageError("Node.js is unavailable; no frontend bootstrap is allowed")
    if generate_client:
        if not owner["tool_paths"].get("openapi_typescript"):
            raise storage.StorageError("Read-only main-checkout openapi-typescript CLI is missing")
    else:
        lint_paths = tuple(
            dict.fromkeys(_normalize_lint_path(value) for value in (*DEFAULT_LINT_PATHS, *lint_values))
        )
        for path in lint_paths:
            if not (repo / "apps/control-room" / path).is_file():
                raise storage.StorageError(f"Changed-source lint path is missing: {path}")
        _require_free_port(port)

    storage.initialize(layout)
    with storage.build_lock(layout):
        if generate_client:
            exit_code, receipt_path, receipt = _run_client_codegen_locked(
                repo, layout, owner, timeout_seconds
            )
        else:
            exit_code, receipt_path, receipt = _run_locked(
                repo, layout, owner, port, lint_paths, timeout_seconds
            )
    receipt["storage_build_lock_state"] = "released"
    storage.atomic_json(receipt_path, receipt)
    print(json.dumps({"receipt": str(receipt_path), "state": receipt["state"]}))
    return exit_code


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--port", type=int, default=3258)
    parser.add_argument("--lint-path", action="append", default=[])
    parser.add_argument("--timeout-seconds", type=int, default=240)
    parser.add_argument(
        "--generate-client",
        action="store_true",
        help="run isolated managed OpenAPI client generation instead of browser verification",
    )
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    if not 30 <= args.timeout_seconds <= 1800:
        parser.error("timeout-seconds must be between 30 and 1800")
    try:
        return run(
            args.repo_root,
            args.port,
            tuple(args.lint_path),
            args.timeout_seconds,
            generate_client=args.generate_client,
        )
    except (storage.StorageError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"[new problem browser] {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
