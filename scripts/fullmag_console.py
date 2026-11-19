#!/usr/bin/env python3
"""Run one source-selected Docker DEV simulation in an owned foreground session."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import uuid

from docker_build_control import BuildControlError
import fullmag_storage as storage


CONSOLE_SESSION_ENV = "FULLMAG_CONSOLE_SESSION_ID"
CONSOLE_CANCEL_ENV = "FULLMAG_CONSOLE_CANCEL_REQUESTED"


@dataclass(frozen=True)
class Invocation:
    mode: str
    source: str
    script: str


def invocation(first: str, second: str, third: str = "") -> Invocation:
    if third:
        if first not in {"gui", "headless"}:
            raise ValueError("Three arguments require an explicit gui or headless mode")
        return Invocation(first, second, third)
    if first in {"gui", "headless"}:
        raise ValueError("An explicit mode requires a source and a script")
    if not first or not second:
        raise ValueError("A source and a Python script are required")
    return Invocation("gui", first, second)


def resolve_source(repo: Path, selector: str) -> Path:
    """Resolve an existing registered checkout or materialize a local Git branch."""
    records = storage.worktree_records(repo)
    available = [row for row in records if Path(row["worktree"]).is_dir() and "prunable" not in row]
    if not available:
        raise ValueError("The Git repository has no available registered checkout")
    if selector == "master":
        matches = [row for row in available if row.get("branch") == "refs/heads/master"]
    else:
        candidate = Path(selector).expanduser()
        if candidate.is_dir():
            resolved = candidate.resolve(strict=True)
            matches = [row for row in available if Path(row["worktree"]).resolve() == resolved]
        else:
            matches = [row for row in available if selector in {
                row.get("branch", "").removeprefix("refs/heads/"),
                Path(row["worktree"]).name, Path(row["worktree"]).parent.name,
            }]
    if len(matches) == 1:
        return Path(matches[0]["worktree"]).resolve(strict=True)
    if len(matches) > 1:
        raise ValueError("Source name is ambiguous; use its absolute checkout path")
    if selector == "master":
        raise ValueError("Master must have an available checkout on the master branch")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", selector):
        raise ValueError("Source must identify a registered checkout or a local Git branch")
    reference = "refs/heads/" + selector
    commit = storage.git(repo, "rev-parse", "--verify", reference + "^{commit}")
    layout = storage.resolve_layout(repo, "docker-all-gpu")
    identity = hashlib.sha256((reference + "\0" + commit).encode()).hexdigest()[:16]
    destination = Path(layout["worktrees_root"]) / ("console-" + identity) / "fullmag"
    if destination.exists():
        registered = [row for row in available if Path(row["worktree"]).resolve() == destination.resolve()]
        if (len(registered) == 1
                and storage.git(destination, "rev-parse", "HEAD") == commit
                and not storage.git(destination, "status", "--porcelain", "--untracked-files=all")):
            return destination.resolve(strict=True)
        raise ValueError("The branch source directory changed or is unregistered; select its absolute path")
    destination.parent.mkdir(parents=True, exist_ok=False)
    subprocess.run(["git", "-C", str(repo), "worktree", "add", "--detach", str(destination), commit], check=True)
    storage.register(storage.resolve_layout(destination, "docker-all-gpu"),
                     "console-" + identity, "fullmag-console", "Source checkout for " + reference)
    return destination.resolve(strict=True)


def execute(runtime, *, wait=time.sleep) -> int:
    """Keep the terminal attached until the operator closes this exact session."""
    result = None
    started = False
    try:
        runtime.start()
        started = True
        result = runtime.run()
        if result.get("state") == "unknown":
            runtime.output(result.get("message", "The run outcome is unknown; recovery evidence was retained."))
            return int(result.get("exit_code", 75))
        if result.get("outcome") in {"interrupted", "interrupted_before_activation"}:
            runtime.begin_shutdown()
            runtime.shutdown(result)
            return 130
        runtime.output("Simulation finished. Press Ctrl+C to close this session and its services.")
        while True:
            wait(0.25)
    except KeyboardInterrupt:
        runtime.begin_shutdown()
        if started:
            runtime.shutdown(result)
        else:
            runtime.cancel_start()
        return 130
    except Exception:
        # Cleanup still uses exact container/run fences. A failed observation
        # cannot authorize force-stopping an unconfirmed computation.
        try:
            if started:
                runtime.shutdown(result)
            else:
                runtime.cancel_start()
        except Exception as cleanup_error:
            runtime.output("Services retained; startup/shutdown recovery required: " + str(cleanup_error))
        raise
    finally:
        runtime.close_observers()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--mode-or-source", required=True)
    parser.add_argument("--source-or-script", required=True)
    parser.add_argument("--script", default="")
    parser.add_argument("--port", type=int)
    parser.add_argument("--gpu-access", choices=("auto", "required", "disabled"), default="auto")
    parser.add_argument("--startup-worker", action="store_true", help=argparse.SUPPRESS)
    return parser


def startup_worker(args, selected: Path, request: Invocation) -> int:
    """Defer startup interrupts to the current managed operation boundary."""
    token = os.environ.get(CONSOLE_SESSION_ENV, "")
    if not re.fullmatch(r"[0-9a-f]{32}", token):
        raise ValueError("Startup worker requires its console session identity")
    def stop_requested(_number, _frame):
        os.environ[CONSOLE_CANCEL_ENV] = token
    signal.signal(signal.SIGINT, stop_requested)
    signal.signal(signal.SIGTERM, stop_requested)
    if hasattr(signal, 'SIGBREAK'):
        signal.signal(signal.SIGBREAK, stop_requested)
    from docker_dev import main as docker_main
    command = ["--repo-root", str(args.repo_root), "up", "--source-root", str(selected),
               "--gpu-access", args.gpu_access]
    if args.port is not None:
        command.extend(("--port", str(args.port)))
    if request.mode == "headless":
        command.append("--headless")
    code = docker_main(command)
    return 130 if os.environ.get(CONSOLE_CANCEL_ENV) == token else code


def main(argv=None) -> int:
    args = _parser().parse_args(argv)
    try:
        request = invocation(args.mode_or_source, args.source_or_script, args.script)
        repo = args.repo_root.resolve(strict=True)
        selected = resolve_source(repo, request.source)
        if args.startup_worker:
            return startup_worker(args, selected, request)
        from docker_startup_script import prepare
        token = uuid.uuid4().hex
        prepare(selected, Path(request.script), request_id="console-" + token,
                source_commit=storage.git(selected, "rev-parse", "HEAD"))
        from fullmag_console_runtime import ConsoleRuntime
        runtime = ConsoleRuntime(args, request, selected, token)
        previous = {}
        def interrupt(_number, _frame):
            if runtime.stopping or runtime.request_interrupt():
                return
            raise KeyboardInterrupt
        for number in (signal.SIGINT, signal.SIGTERM):
            previous[number] = signal.signal(number, interrupt)
        try:
            return execute(runtime)
        finally:
            for number, handler in previous.items():
                signal.signal(number, handler)
    except (BuildControlError, storage.StorageError, OSError, ValueError, subprocess.SubprocessError) as error:
        print("fullmag: " + str(error), file=sys.stderr, flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
