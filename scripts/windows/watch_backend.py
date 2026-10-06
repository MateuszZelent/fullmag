"""Build changed native backend sources; never restart an application session."""
import argparse
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fullmag_storage import file_lock, resolve_layout, validate_path
from windows.development_status import (
    DevelopmentStatusError,
    StatusHeartbeat,
    make_publisher,
    verified_build_identity,
)
from windows.workspace_backend_identity import fingerprint


DEFAULT_DEBOUNCE_SECONDS = 120.0


class BuildWatcher:
    def __init__(self, digest, build, publish, debounce=DEFAULT_DEBOUNCE_SECONDS, may_build=lambda: True, verify_ready=None):
        self.digest, self.build, self.publish = digest, build, publish
        self.debounce = debounce
        self.may_build = may_build
        self.verify_ready = verify_ready
        self.pending = None
        self.changed_at = 0
        self.attempted = None
        self.last_result = None
        self.last_validation_error = None
        self.wait_after_superseded = False

    def step(self, now):
        current = self.digest()
        if current != self.pending:
            self.pending, self.changed_at = current, now
            self.wait_after_superseded = False
            self.publish({"state": "waiting", "source_sha256": current})
        elif self.wait_after_superseded:
            self.wait_after_superseded = False
            self.publish({"state": "waiting", "source_sha256": current})
        if current == self.attempted or now - self.changed_at < self.debounce:
            return
        if not self.may_build():
            self.publish({"state": "stopped", "source_sha256": current})
            return
        self.attempted = current
        self.last_validation_error = None
        self.publish({"state": "building", "source_sha256": current})
        result = self.build()
        self.last_result = result
        after = self.digest()
        state = "superseded" if after != current else "failed"
        details = {}
        if result == 0 and after == current:
            if self.verify_ready is None:
                state = "ready"
            else:
                try:
                    details = self.verify_ready(current)
                    if not isinstance(details, dict):
                        raise ValueError("Build verification did not return an identity record")
                    state = "ready"
                    self.last_validation_error = None
                except Exception as error:
                    self.last_validation_error = error
        self.publish({"state": state, "source_sha256": current, "exit_code": result,
                      "runtime_restart": "manual_after_saving", **details})
        # Changes made during compilation are coalesced into the next attempt.
        if after != current:
            self.pending, self.changed_at = after, time.monotonic()
            self.wait_after_superseded = True


def validate_debounce_seconds(value, *, once):
    """Parse an operator quiet-window setting without accepting NaN or infinity."""
    try:
        seconds = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError("Backend debounce seconds must be numeric") from error
    if not math.isfinite(seconds):
        raise ValueError("Backend debounce seconds must be finite")
    if seconds == 0 and once:
        return 0.0
    if not 1 <= seconds <= 300:
        raise ValueError("Backend debounce seconds must be from 1 to 300; zero is allowed only with --once")
    return seconds


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--web-port", type=int, default=3197)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--stop-file")
    parser.add_argument("--baseline-digest")
    parser.add_argument("--generation-id")
    parser.add_argument(
        "--debounce-seconds",
        default=os.environ.get("FULLMAG_BACKEND_DEV_DEBOUNCE_SECONDS", str(DEFAULT_DEBOUNCE_SECONDS)),
        help="Quiet time required before building changed backend sources (default: 120; env override supported)",
    )
    args = parser.parse_args(argv)
    try:
        debounce_seconds = validate_debounce_seconds(args.debounce_seconds, once=args.once)
    except ValueError as error:
        parser.error(str(error))
    if sys.platform != "win32":
        parser.error("Native backend watch requires Windows")
    if not 1 <= args.web_port <= 65535:
        parser.error("Web port must be from 1 to 65535")
    layout = resolve_layout(args.repo_root, "windows-native-fdm-cpu-dev")
    stop = None
    if args.stop_file:
        stop = validate_path(args.stop_file, layout["runtime_root"], "owned watcher stop file")
        if not re.fullmatch(r"native-watch-stop-[0-9a-f]{32}\.json", stop.name):
            parser.error("Invalid owned watcher stop file")
    if args.baseline_digest:
        if not re.fullmatch(r"[0-9a-f]{64}", args.baseline_digest):
            parser.error("Invalid backend source digest")
    if args.generation_id is not None and not re.fullmatch(r"[0-9a-f]{32}", args.generation_id):
        parser.error("Invalid managed runtime generation id")
    root = Path(layout["storage_root"])
    lock = validate_path(root / "locks" / (layout["worktree_id"] + ".backend-watch.lock"), root, "backend watch lock")
    status = validate_path(Path(layout["build_root"]) / "backend-watch-status.json", root, "backend watch status")
    # The closed build route owns creation/preflight and the mutable build lease.
    # The watcher only owns this separate, one-watcher-per-worktree lease.
    lock.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, str(Path(__file__).resolve().parents[1] / "fullmag_storage.py"),
               "run-windows-workspace-build", "--repo-root", layout["repo_root"],
               "--profile", layout["profile"], "--workspace-frontend", "dev",
               "--workspace-backend-profile", "dev", "--workspace-build-mode", "auto",
               "--workspace-web-port", str(args.web_port)]

    def publish(state):
        if status_publisher is not None:
            status_publisher.publish(state)
        print("[backend dev] " + state["state"], flush=True)
        if state["state"] == "ready":
            print("[backend dev] New binaries ready. Save your project before restarting the UI.", flush=True)

    status_publisher = make_publisher(status, args.generation_id, layout["worktree_id"])
    heartbeat = None

    watcher = BuildWatcher(lambda: fingerprint(layout["repo_root"])["sha256"],
                           lambda: subprocess.run(command, cwd=layout["repo_root"]).returncode,
                           publish, debounce=0 if args.once else debounce_seconds,
                           may_build=lambda: stop is None or not stop.exists(),
                           verify_ready=lambda expected: verified_build_identity(
                               layout["build_root"], layout["runtime_root"],
                               Path(layout["build_root"]) / "windows-runtime" / "build-manifest.json",
                               expected,
                           ))
    watcher.attempted = args.baseline_digest
    with file_lock(lock, "backend watcher"):
        try:
            if status_publisher is not None:
                if not args.baseline_digest:
                    raise DevelopmentStatusError("Managed watcher requires its sealed baseline source identity")
                publish({"state": "waiting", "source_sha256": args.baseline_digest})
                heartbeat = StatusHeartbeat(status_publisher).start()
            while True:
                if heartbeat is not None:
                    heartbeat.raise_if_failed()
                if stop is not None and stop.exists():
                    publish({"state": "stopped", "source_sha256": watcher.pending or args.baseline_digest})
                    return 0
                watcher.step(time.monotonic())
                if args.once:
                    return 1 if watcher.last_validation_error is not None else watcher.last_result or 0
                time.sleep(0.5)
        except KeyboardInterrupt:
            publish({"state": "stopped", "source_sha256": watcher.pending or args.baseline_digest})
            return 130
        finally:
            if heartbeat is not None:
                heartbeat.stop()
                heartbeat.raise_if_failed()


if __name__ == "__main__":
    raise SystemExit(main())
