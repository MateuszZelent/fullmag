#!/usr/bin/env python3
"""Run a managed active-run WebSocket reconnect smoke on Windows.

The route builds ``fullmag-api`` and ``fullmag`` from one captured source
identity, starts an isolated FDM CPU relaxation, disconnects the realtime
transport while the solver is running, and verifies the same session/run and
monotonic HTTP resource revisions after reconnect.  It is a runtime recovery
receipt, not a physics or release qualification.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import uuid

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import capture_source_snapshot_identity as source_identity  # noqa: E402
import fullmag_storage as storage  # noqa: E402
from verify_project_api_runtime import json_request, wait_for_health  # noqa: E402
from verify_session_persistence import toolchain_identity  # noqa: E402


PROFILE = "windows-project-active-run-runtime"
RECEIPT_SCHEMA = "fullmag_project_active_run_runtime_v1"


class ActiveRunRuntimeError(RuntimeError):
    """A managed active-run preflight, process, or contract failure."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def contained_paths(layout: dict[str, object], run_id: str) -> dict[str, Path]:
    build_storage = Path(str(layout["build_storage_root"]))
    build_root = Path(str(layout["build_root"]))
    temp_root = Path(str(layout["temp_root"]))
    cache_root = Path(str(layout["cache_root"]))
    run_root = storage.validate_path(
        build_root / PROFILE / run_id, build_storage, "active-run runtime root"
    )
    return {
        "run_root": run_root,
        "temp_root": storage.validate_path(temp_root / PROFILE / run_id, build_storage, "active-run temp root"),
        "state_root": storage.validate_path(run_root / "state", build_storage, "active-run state root"),
        "target_dir": storage.validate_path(run_root / "cargo-target", build_storage, "active-run target"),
        # Share the already managed, validated Cargo/Rustup caches with the
        # existing project API routes. A fresh per-smoke cache cannot resolve
        # the offline workspace index and would make the receipt depend on
        # an accidental network fetch.
        "cargo_home": storage.validate_path(cache_root / "cargo", cache_root, "active-run Cargo home"),
        "rustup_home": storage.validate_path(cache_root / "rustup", cache_root, "active-run Rustup home"),
        "receipt": storage.validate_path(run_root / "receipt.json", build_storage, "active-run receipt"),
        "cargo_log": storage.validate_path(run_root / "cargo.log", build_storage, "active-run Cargo log"),
        "api_log": storage.validate_path(run_root / "api.log", build_storage, "active-run API log"),
        "cli_log": storage.validate_path(run_root / "cli.log", build_storage, "active-run CLI log"),
        "probe_log": storage.validate_path(run_root / "active-run-ws.log", build_storage, "active-run probe log"),
        "fixture": storage.validate_path(run_root / "active-run.py", build_storage, "active-run fixture"),
        "source_snapshot": storage.validate_path(run_root / "source-snapshot.v2.json", build_storage, "active-run source snapshot"),
        "source_snapshot_after": storage.validate_path(run_root / "source-snapshot-after.v2.json", build_storage, "active-run post-run source snapshot"),
    }


def child_environment(
    layout: dict[str, object],
    paths: dict[str, Path],
    tools: dict[str, Path],
    identity: dict[str, object],
    repo_root: Path,
) -> dict[str, str]:
    env = {str(key): str(value) for key, value in os.environ.items()}
    env.update({str(key): str(value) for key, value in layout["env"].items()})
    env.update(
        {
            "FULLMAG_STORAGE_PROFILE": PROFILE,
            "CARGO_TARGET_DIR": str(paths["target_dir"]),
            "FULLMAG_CARGO_TARGET_DIR": str(paths["target_dir"]),
            "FULLMAG_CARGO_TARGET_ROOT": str(paths["target_dir"]),
            "CARGO_HOME": str(paths["cargo_home"]),
            "RUSTUP_HOME": str(paths["rustup_home"]),
            "RUSTC": str(tools["rustc"]),
            "TMPDIR": str(paths["temp_root"]),
            "TEMP": str(paths["temp_root"]),
            "TMP": str(paths["temp_root"]),
            "FULLMAG_SOURCE_GIT_COMMIT": str(identity["head_commit_full"]),
            "FULLMAG_SOURCE_WORKTREE_STATE": "dirty" if identity["source_snapshot_dirty"] else "clean",
            "FULLMAG_SOURCE_SNAPSHOT_SHA256": str(identity["source_snapshot_sha256"]),
            "FULLMAG_PYTHON": sys.executable,
            "PYTHONPATH": str(repo_root / "packages" / "fullmag-py" / "src"),
            "PYTHONNOUSERSITE": "1",
            "CARGO_BUILD_JOBS": "1",
        }
    )
    bins = [str(Path(tools["cargo"]).parent), str(Path(tools["rustc"]).parent)]
    old_path = env.get("PATH", "")
    env["PATH"] = os.pathsep.join(bins + ([old_path] if old_path else []))
    env.pop("RUSTUP_TOOLCHAIN", None)
    return env


def write_fixture(path: Path) -> None:
    path.write_text(
        """import fullmag as fm

study = fm.study("managed_active_run_reconnect")
study.engine("fdm")
study.device("cpu", precision="double")
study.universe(mode="manual", size=(80e-9, 160e-9, 10e-9), center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.cell(5e-9, 5e-9, 5e-9)
film = study.geometry(fm.Box(size=(40e-9, 120e-9, 10e-9), name="managed_smoke_box"), name="managed_smoke_box")
film.Ms = 752000.0
film.Aex = 1.55e-11
film.alpha = 0.1
film.m = fm.texture.uniform(0.0, 1.0, 0.0)
study.demag()
study.b_ext(0.0, 0.0, 1e-3)
study.solver(fix_dt=1e-13, g=2.115)
study.stages.add_relax(algorithm="llg_overdamped", dt=1e-13, tolA=1e-4, max_steps=100000).tableautosave(every_steps=50, quantities=["step", "t", "dt", "mx", "my", "mz", "E_total"])
""",
        encoding="utf-8",
        newline="\n",
    )


def terminate(process: subprocess.Popen[bytes] | None) -> int | None:
    if process is None:
        return None
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
    return process.returncode


def run(repo_root: Path) -> tuple[int, dict[str, object]]:
    if os.name != "nt":
        raise ActiveRunRuntimeError("managed active-run route is supported only on Windows")
    layout = storage.resolve_layout(repo_root, PROFILE)
    storage.initialize(layout)
    with storage.build_lock(layout):
        run_id = uuid.uuid4().hex
        paths = contained_paths(layout, run_id)
        for key in ("run_root", "temp_root", "target_dir", "cargo_home", "rustup_home", "state_root"):
            paths[key].mkdir(parents=True, exist_ok=True)
        receipt: dict[str, object] = {
            "schema": RECEIPT_SCHEMA,
            "route": "project-active-run-runtime",
            "profile": PROFILE,
            "run_id": run_id,
            "worktree_id": layout["worktree_id"],
            "repo_root": str(repo_root),
            "started_at": utc_now(),
            "state": "preflight",
            "paths": {key: str(value) for key, value in paths.items()},
            "build_command": ["cargo", "build", "--locked", "--offline", "-p", "fullmag-api", "-p", "fullmag-cli"],
            "runtime_scope": [
                "FDM CPU flat_relax active run",
                "fullmag.live.v1 hello → client-controlled disconnect → after_seq reconnect",
                "HTTP run/stages/solver/commands continuity",
            ],
            "runtime_mutations": ["isolated scratch active run only"],
        }
        api_process: subprocess.Popen[bytes] | None = None
        cli_process: subprocess.Popen[bytes] | None = None
        api_log_handle = None
        cli_log_handle = None
        return_code = 2
        try:
            identity = source_identity.capture(repo_root, ignore_non_runtime_dirty=True)
            write_atomic_json(paths["source_snapshot"], identity)
            receipt["source_identity"] = identity
            toolchain, tools = toolchain_identity()
            receipt["toolchain"] = toolchain
            env = child_environment(layout, paths, tools, identity, repo_root)
            api_port = free_port()
            env["FULLMAG_API_PORT"] = str(api_port)
            env["FULLMAG_STATE_ROOT"] = str(paths["state_root"] / "api")
            receipt["api_port"] = api_port
            paths["fixture"].parent.mkdir(parents=True, exist_ok=True)
            write_fixture(paths["fixture"])
            with paths["cargo_log"].open("w", encoding="utf-8", newline="\n") as cargo_log:
                receipt["state"] = "building"
                write_atomic_json(paths["receipt"], receipt)
                build = subprocess.run(
                    [str(tools["cargo"]), "build", "--locked", "--offline", "-p", "fullmag-api", "-p", "fullmag-cli"],
                    cwd=repo_root, env=env, stdout=cargo_log, stderr=subprocess.STDOUT, text=True, check=False,
                )
            receipt["build_exit_code"] = build.returncode
            if build.returncode != 0:
                raise ActiveRunRuntimeError(f"fullmag API/CLI build failed with code {build.returncode}")
            api_name = "fullmag-api.exe" if os.name == "nt" else "fullmag-api"
            cli_name = "fullmag.exe" if os.name == "nt" else "fullmag"
            api_binary = paths["target_dir"] / "debug" / api_name
            cli_binary = paths["target_dir"] / "debug" / cli_name
            for label, binary in (("API", api_binary), ("CLI", cli_binary)):
                if not binary.is_file() or binary.stat().st_size == 0:
                    raise ActiveRunRuntimeError(f"fullmag {label} binary is missing or empty: {binary}")
            receipt["binaries"] = {
                "api": {"path": str(api_binary), "sha256": hashlib.sha256(api_binary.read_bytes()).hexdigest()},
                "cli": {"path": str(cli_binary), "sha256": hashlib.sha256(cli_binary.read_bytes()).hexdigest()},
            }
            paths["api_log"].parent.mkdir(parents=True, exist_ok=True)
            api_log_handle = paths["api_log"].open("w", encoding="utf-8", newline="\n")
            api_process = subprocess.Popen([str(api_binary)], cwd=repo_root, env=env, stdout=api_log_handle, stderr=subprocess.STDOUT)
            base_url = f"http://127.0.0.1:{api_port}"
            health = wait_for_health(base_url, api_process)
            _, openapi = json_request(f"{base_url}/v2/platform/openapi.json")
            remote_identity = openapi.get("x-fullmag-build-identity") if isinstance(openapi, dict) else None
            expected_identity = {
                "git_commit": identity["head_commit_full"],
                "source_snapshot_sha256": identity["source_snapshot_sha256"],
                "worktree_state": "dirty" if identity["source_snapshot_dirty"] else "clean",
            }
            if not isinstance(remote_identity, dict) or any(remote_identity.get(key) != value for key, value in expected_identity.items()):
                raise ActiveRunRuntimeError(f"API build identity mismatch: {remote_identity!r} != {expected_identity!r}")
            cli_env = dict(env)
            cli_env["FULLMAG_STATE_ROOT"] = str(paths["state_root"] / "cli")
            cli_env["FULLMAG_SKIP_CONTROL_ROOM"] = "1"
            cli_env["FULLMAG_FDM_EXECUTION"] = "cpu"
            cli_env.pop("FULLMAG_ATTACHED_SESSION_ID", None)
            cli_log_handle = paths["cli_log"].open("w", encoding="utf-8", newline="\n")
            cli_process = subprocess.Popen(
                [str(cli_binary), "-i", str(paths["fixture"]), "--backend", "fdm"],
                cwd=repo_root, env=cli_env, stdout=cli_log_handle, stderr=subprocess.STDOUT,
            )
            deadline = time.monotonic() + 60
            latest: object = None
            while time.monotonic() < deadline:
                if cli_process.poll() is not None:
                    raise ActiveRunRuntimeError(f"fullmag CLI exited before active run with code {cli_process.returncode}")
                try:
                    _, latest = json_request(f"{base_url}/v2/sessions/current/status", timeout=2.0)
                    if isinstance(latest, dict) and latest.get("run", {}).get("run_id") and latest.get("run", {}).get("solver_steps", 0) >= 1 and latest.get("solver", {}).get("state") in {"materializing_script", "preparing", "running", "paused"}:
                        break
                except Exception:
                    pass
                time.sleep(0.25)
            else:
                raise ActiveRunRuntimeError(f"active run did not become observable: {latest!r}")
            node = shutil.which("node", path=cli_env.get("PATH"))
            if not node:
                raise ActiveRunRuntimeError("node is required for the active-run websocket probe")
            probe = SCRIPT_DIR / "probe_active_run_ws.mjs"
            probe_result = subprocess.run([node, str(probe), base_url], cwd=repo_root, env=cli_env, capture_output=True, text=True, timeout=90, check=False)
            paths["probe_log"].write_text(f"$ {node} {probe} {base_url}\nexit_code={probe_result.returncode}\nstdout:\n{probe_result.stdout}\nstderr:\n{probe_result.stderr}\n", encoding="utf-8", newline="\n")
            if probe_result.returncode != 0:
                raise ActiveRunRuntimeError(f"active-run websocket probe failed: {probe_result.stderr.strip()[-700:]}")
            try:
                probe_payload = json.loads(probe_result.stdout)
            except json.JSONDecodeError as error:
                raise ActiveRunRuntimeError("active-run probe did not emit JSON") from error
            if not isinstance(probe_payload, dict) or probe_payload.get("state") != "passed":
                raise ActiveRunRuntimeError("active-run probe returned an invalid result")
            receipt["health"] = health
            receipt["active_run_probe"] = probe_payload
            receipt["cli_exit_code_before_cleanup"] = cli_process.poll()
            receipt["cli_exit_code"] = terminate(cli_process)
            cli_process = None
            receipt["api_exit_code"] = terminate(api_process)
            api_process = None
            if cli_log_handle is not None:
                cli_log_handle.close()
                cli_log_handle = None
            if api_log_handle is not None:
                api_log_handle.close()
                api_log_handle = None
            receipt["fixture_sha256"] = hashlib.sha256(paths["fixture"].read_bytes()).hexdigest()
            source_after = source_identity.capture(repo_root, ignore_non_runtime_dirty=True)
            write_atomic_json(paths["source_snapshot_after"], source_after)
            receipt["source_identity_after"] = source_after
            receipt["source_changed_during_run"] = source_after["source_snapshot_sha256"] != identity["source_snapshot_sha256"]
            if receipt["source_changed_during_run"]:
                raise ActiveRunRuntimeError("source identity changed during active-run runtime smoke")
            receipt["state"] = "passed"
            return_code = 0
        except BaseException as error:
            receipt["state"] = "failed"
            receipt["error"] = f"{type(error).__name__}: {error}"
            return_code = 1
        finally:
            if cli_process is not None:
                receipt["cli_exit_code"] = terminate(cli_process)
            if api_process is not None:
                receipt["api_exit_code"] = terminate(api_process)
            if cli_log_handle is not None:
                cli_log_handle.close()
            if api_log_handle is not None:
                api_log_handle.close()
            receipt["finished_at"] = utc_now()
            receipt["exit_code"] = return_code
            write_atomic_json(paths["receipt"], receipt)
        # The managed Windows runner may expose a legacy console code page;
        # keep the receipt machine-readable without requiring UTF-8 stdout.
        print(json.dumps(receipt, indent=2, ensure_ascii=True))
        return return_code, receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        return run(args.repo_root.resolve())[0]
    except Exception as error:
        print(f"project active-run runtime smoke failed before receipt: {type(error).__name__}: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
