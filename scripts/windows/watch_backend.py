"""Build changed native backend sources; never restart an application session."""
import argparse
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fullmag_storage import atomic_json, file_lock, resolve_layout, validate_path
from windows.workspace_backend_identity import fingerprint


class BuildWatcher:
    def __init__(self, digest, build, publish, debounce=1.0, may_build=lambda: True):
        self.digest, self.build, self.publish = digest, build, publish
        self.debounce = debounce
        self.may_build = may_build
        self.pending = None
        self.changed_at = 0
        self.attempted = None
        self.last_result = None

    def step(self, now):
        current = self.digest()
        if current != self.pending:
            self.pending, self.changed_at = current, now
            self.publish({"state": "waiting", "source_sha256": current})
        if current == self.attempted or now - self.changed_at < self.debounce:
            return
        if not self.may_build():
            self.publish({"state": "stopped"})
            return
        self.attempted = current
        self.publish({"state": "building", "source_sha256": current})
        result = self.build()
        self.last_result = result
        after = self.digest()
        self.publish({"state": "ready" if result == 0 and after == current else
                      "superseded" if after != current else "failed",
                      "source_sha256": current, "exit_code": result,
                      "runtime_restart": "manual_after_saving"})
        # Changes made during compilation are coalesced into the next attempt.
        if after != current:
            self.pending, self.changed_at = after, time.monotonic()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--web-port", type=int, default=3197)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--stop-file")
    parser.add_argument("--baseline-digest")
    args = parser.parse_args(argv)
    if sys.platform != "win32":
        parser.error("Native backend watch requires Windows")
    if not 1 <= args.web_port <= 65535:
        parser.error("Web port must be from 1 to 65535")
    layout = resolve_layout(args.repo_root, "windows-native-fdm-cpu-dev")
    stop = None
    if args.stop_file:
        import re
        stop = validate_path(args.stop_file, layout["runtime_root"], "owned watcher stop file")
        if not re.fullmatch(r"native-watch-stop-[0-9a-f]{32}\.json", stop.name):
            parser.error("Invalid owned watcher stop file")
    if args.baseline_digest:
        import re
        if not re.fullmatch(r"[0-9a-f]{64}", args.baseline_digest):
            parser.error("Invalid backend source digest")
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
        if status.parent.exists():
            atomic_json(status, {"schema": "fullmag.backend-watch.v1", **state})
        print("[backend dev] " + state["state"], flush=True)
        if state["state"] == "ready":
            print("[backend dev] New binaries ready. Save your project before restarting the UI.", flush=True)

    watcher = BuildWatcher(lambda: fingerprint(layout["repo_root"])["sha256"],
                           lambda: subprocess.run(command, cwd=layout["repo_root"]).returncode,
                           publish, debounce=0 if args.once else 1,
                           may_build=lambda: stop is None or not stop.exists())
    watcher.attempted = args.baseline_digest
    with file_lock(lock, "backend watcher"):
        try:
            while True:
                if stop is not None and stop.exists():
                    publish({"state": "stopped"})
                    return 0
                watcher.step(time.monotonic())
                if args.once:
                    return watcher.last_result or 0
                time.sleep(0.5)
        except KeyboardInterrupt:
            publish({"state": "stopped"})
            return 130


if __name__ == "__main__":
    raise SystemExit(main())
