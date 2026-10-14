#!/usr/bin/env python3
"""Own the hosted Explorer browser proof under one managed storage run."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


HOST = "127.0.0.1"
PORT = 3100
SERVER_URL = f"http://{HOST}:{PORT}/workspace"
SERVER_TIMEOUT_SECONDS = 120
PROCESS_STOP_TIMEOUT_SECONDS = 10
LOG_TAIL_BYTES = 64 * 1024


def repository_root() -> Path:
    return Path(__file__).resolve().parents[2]


def frontend_workspace_root() -> Path:
    configured = os.environ.get("FULLMAG_CI_FRONTEND_WORKSPACE_ROOT")
    if not configured:
        raise RuntimeError("FULLMAG_CI_FRONTEND_WORKSPACE_ROOT is required for browser-proof logs")
    workspace = Path(configured)
    if not workspace.is_absolute() or not workspace.is_dir():
        raise RuntimeError("FULLMAG_CI_FRONTEND_WORKSPACE_ROOT must name the prepared managed workspace")
    return workspace


def log_tail(path: Path) -> str:
    try:
        with path.open("rb") as stream:
            stream.seek(0, os.SEEK_END)
            size = stream.tell()
            stream.seek(max(0, size - LOG_TAIL_BYTES))
            content = stream.read(LOG_TAIL_BYTES)
    except OSError as error:
        return f"<log unavailable: {error}>"
    return content.decode("utf-8", errors="replace")


def process_group_exists(process: subprocess.Popen[bytes]) -> bool:
    try:
        os.killpg(process.pid, 0)
    except ProcessLookupError:
        return False
    return True


def stop_process_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass

    deadline = time.monotonic() + PROCESS_STOP_TIMEOUT_SECONDS
    while time.monotonic() < deadline and process_group_exists(process):
        if process.poll() is None:
            try:
                process.wait(timeout=0.1)
            except subprocess.TimeoutExpired:
                pass
        else:
            # The group leader may have exited while a pnpm/Next descendant is
            # still shutting down. Keep the deadline useful without busy-spinning.
            time.sleep(0.1)

    if process_group_exists(process):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    process.wait()


def wait_for_server(process: subprocess.Popen[bytes], log_path: Path) -> None:
    deadline = time.monotonic() + SERVER_TIMEOUT_SECONDS
    last_error = "no HTTP response"
    while time.monotonic() < deadline:
        return_code = process.poll()
        if return_code is not None:
            raise RuntimeError(
                f"Next dev exited before readiness (exit {return_code}).\n{log_tail(log_path)}"
            )
        try:
            with urlopen(SERVER_URL, timeout=2) as response:
                if 200 <= response.status < 300:
                    return
                last_error = f"HTTP {response.status}"
        except (OSError, URLError) as error:
            last_error = str(error)
        time.sleep(0.5)
    raise RuntimeError(
        f"Next dev did not serve {SERVER_URL} within {SERVER_TIMEOUT_SECONDS}s: {last_error}.\n"
        f"{log_tail(log_path)}"
    )


def run_browser_proof(root: Path, browser_log: Path) -> int:
    environment = {
        **os.environ,
        "CONTROL_ROOM_URL": SERVER_URL,
        "CONTROL_ROOM_STUDY_AUTHORING_SMOKE_EXPLORER_CATALOG_ONLY": "1",
    }
    command = [
        "pnpm",
        "--dir",
        "apps/control-room",
        "exec",
        "node",
        "scripts/smoke-study-authoring-ui.mjs",
    ]
    with browser_log.open("wb") as log:
        process = subprocess.Popen(
            command,
            cwd=root,
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            return process.wait()
        finally:
            stop_process_group(process)


def main() -> int:
    if os.name != "posix":
        raise RuntimeError("This hosted browser harness requires a POSIX runner")
    root = repository_root()
    workspace = frontend_workspace_root()
    server_log = workspace / "explorer-catalog-next-dev.log"
    browser_log = workspace / "explorer-catalog-browser.log"
    server_command = [
        "pnpm",
        "--dir",
        "apps/control-room",
        "exec",
        "next",
        "dev",
        "--webpack",
        "--hostname",
        HOST,
        "--port",
        str(PORT),
    ]

    with server_log.open("wb") as log:
        server = subprocess.Popen(
            server_command,
            cwd=root,
            env=os.environ.copy(),
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            wait_for_server(server, server_log)
            return_code = run_browser_proof(root, browser_log)
            if return_code != 0:
                print(log_tail(browser_log), file=sys.stderr, end="")
            return return_code
        finally:
            stop_process_group(server)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Explorer browser smoke harness failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
