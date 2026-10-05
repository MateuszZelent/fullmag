"""Consume explicit native backend build requests; never restart a session."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fullmag_storage import (
    atomic_json,
    file_lock,
    read_workspace_build_request_receipt,
    resolve_layout,
    validate_path,
)
from windows.development_status import (
    DevelopmentStatusError,
    StatusHeartbeat,
    make_publisher,
    verified_build_identity,
)
from windows.workspace_backend_identity import fingerprint


class BuildWatcher:
    def __init__(
        self, digest, build, publish, debounce=None, may_build=lambda: True,
        verify_ready=None, read_build_manifest_sha256=None,
    ):
        self.digest, self.build, self.publish = digest, build, publish
        self.may_build = may_build
        self.verify_ready = verify_ready
        self.read_build_manifest_sha256 = read_build_manifest_sha256
        self.pending = None
        self.attempted = None
        self.last_result = None
        self.last_validation_error = None

    def step(self, now, request_id=None):
        # Idle source edits have no side effects. A request is consumed once,
        # even when a failed build or an interrupted HTTP reply is retried.
        if request_id is None or request_id == self.attempted:
            return
        if not self.may_build():
            return
        self.attempted = request_id
        current = self.digest()
        self.pending = current
        if not self.may_build():
            self.publish({"state": "stopped", "source_sha256": current, "request_id": request_id})
            return
        self.last_validation_error = None
        self.publish({"state": "building", "source_sha256": current, "request_id": request_id})
        result = self.build(request_id)
        self.last_result = result
        state = "failed"
        details = {}
        if result == 0:
            if self.verify_ready is None:
                state = "ready"
            else:
                try:
                    # The build captures its own frozen source under the build
                    # lease. Never compare it with a later live checkout hash.
                    if self.read_build_manifest_sha256 is None:
                        raise ValueError("Managed build has no request-scoped manifest receipt")
                    manifest_sha256 = self.read_build_manifest_sha256(request_id)
                    if not isinstance(manifest_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", manifest_sha256):
                        raise ValueError("Managed build receipt has no valid manifest pin")
                    details = self.verify_ready(manifest_sha256)
                    if not isinstance(details, dict):
                        raise ValueError("Build verification did not return an identity record")
                    state = "ready"
                    self.last_validation_error = None
                except Exception as error:
                    self.last_validation_error = error
        self.pending = details.get("ready_source_sha256", current)
        self.publish({"state": state, "source_sha256": self.pending, "exit_code": result,
                      "request_id": request_id,
                      "runtime_restart": "manual_after_saving", **details})


def read_build_intent(path, generation_id, worktree_id):
    """Read the API's bounded, scoped intent; never execute client commands."""
    if not path.exists():
        return None
    from windows.runtime_bundle import _duplicate_rejecting_object
    from windows.development_handoff import _read_limited
    raw = _read_limited(path, path.parent, "backend build request", 4096)
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=_duplicate_rejecting_object)
    fields = {"schema", "request_id", "api_instance_id", "worktree_id", "generation_id", "status_token_sha256"}
    if not isinstance(value, dict) or set(value) != fields:
        raise DevelopmentStatusError("Invalid backend build request")
    if value["schema"] != "fullmag.development-backend-build-intent.v1":
        raise DevelopmentStatusError("Unsupported backend build request")
    for key in ("request_id", "api_instance_id"):
        parsed = uuid.UUID(value[key])
        if parsed.int == 0 or str(parsed) != value[key]:
            raise DevelopmentStatusError("Invalid backend build request identity")
    if not isinstance(value["status_token_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["status_token_sha256"]):
        raise DevelopmentStatusError("Invalid backend build status credential")
    if value["generation_id"] != generation_id or value["worktree_id"] != worktree_id:
        return None
    return value


def read_build_request(path, generation_id, worktree_id):
    value = read_build_intent(path, generation_id, worktree_id)
    return None if value is None else value["request_id"]


def publish_build_result(path, state, generation_id, worktree_id):
    """Keep one terminal intent result independently of later CLI builds."""
    if state.get("state") not in {"ready", "failed"} or not state.get("request_id"):
        return
    intent = read_build_intent(path, generation_id, worktree_id)
    if intent is None or intent["request_id"] != state["request_id"]:
        return
    result = {**intent, "schema": "fullmag.development-backend-build-result.v1",
              "state": state["state"], "ready_build_id": state.get("ready_build_id"),
              "ready_source_sha256": state.get("ready_source_sha256")}
    atomic_json(path.with_name("backend-build-result.json"), result)


class ExplicitBuildObserver:
    """Observe the managed CLI route without ever requesting a compilation."""

    def __init__(self, path, worktree_id, profile, publish, verify_ready, source):
        self.path, self.worktree_id, self.profile = path, worktree_id, profile
        self.publish, self.verify_ready, self.source = publish, verify_ready, source
        self.signature = self._signature()

    def _signature(self):
        try:
            value = self.path.stat()
            return value.st_mtime_ns, value.st_size
        except FileNotFoundError:
            return None

    def step(self):
        signature = self._signature()
        if signature is None or signature == self.signature:
            return
        from windows.development_handoff import _read_limited
        value = json.loads(_read_limited(self.path, self.path.parent, "native build receipt", 65536))
        self.signature = signature
        if (value.get("worktree_id") != self.worktree_id or value.get("profile") != self.profile
                or value.get("execution_mode") != "windows-workspace-build"):
            return
        if value.get("state") == "running":
            self.publish({"state": "building", "source_sha256": self.source})
        elif value.get("state") == "completed" and value.get("exit_code") == 0:
            manifest_sha256 = value.get("build_manifest_sha256")
            if not isinstance(manifest_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", manifest_sha256):
                self.publish({"state": "failed", "source_sha256": self.source})
                return
            try:
                identity = self.verify_ready(manifest_sha256)
                self.source = identity["ready_source_sha256"]
                self.publish({"state": "ready", "source_sha256": self.source, **identity})
            except Exception as error:
                print(f"[backend dev] Build verification failed: {error}", flush=True)
                self.publish({"state": "failed", "source_sha256": self.source})
        elif value.get("state") in {"failed", "interrupted"}:
            self.publish({"state": "failed", "source_sha256": self.source})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--web-port", type=int, default=3197)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--stop-file")
    parser.add_argument("--baseline-digest")
    parser.add_argument("--generation-id")
    args = parser.parse_args(argv)
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
               "--workspace-backend-profile", "dev", "--workspace-build-mode", "true",
               "--workspace-web-port", str(args.web_port)]

    def publish(state):
        publish_build_result(status.with_name("backend-build-request.json"), state,
                             args.generation_id, layout["worktree_id"])
        if status_publisher is not None:
            status_publisher.publish(state)
        print("[backend dev] " + state["state"], flush=True)
        if state["state"] == "ready":
            print("[backend dev] New binaries ready. Save your project before restarting the UI.", flush=True)

    status_publisher = make_publisher(status, args.generation_id, layout["worktree_id"])
    heartbeat = None

    watcher = BuildWatcher(lambda: fingerprint(layout["repo_root"])["sha256"],
                           lambda request_id: subprocess.run(
                               [*command, "--workspace-request-id", request_id],
                               cwd=layout["repo_root"],
                           ).returncode,
                           publish,
                           may_build=lambda: stop is None or not stop.exists(),
                           verify_ready=lambda expected_manifest: verified_build_identity(
                               layout["build_root"], layout["runtime_root"],
                               Path(layout["build_root"]) / "windows-runtime" / "build-manifest.json",
                               None,
                               expected_manifest_sha256=expected_manifest,
                           ),
                           read_build_manifest_sha256=lambda request_id: read_workspace_build_request_receipt(
                               layout, request_id
                           )["build_manifest_sha256"])
    request_path = status.with_name("backend-build-request.json")
    once_request = str(uuid.uuid4()) if args.once else None
    observer = ExplicitBuildObserver(Path(layout["build_root"]) / "build-status.json",
                                     layout["worktree_id"], layout["profile"], publish,
                                     watcher.verify_ready, args.baseline_digest)
    with file_lock(lock, "backend watcher"):
        try:
            if status_publisher is not None:
                if not args.baseline_digest:
                    raise DevelopmentStatusError("Managed watcher requires its sealed baseline source identity")
                initial = {"state": "waiting", "source_sha256": args.baseline_digest}
                # A consumer crash must not replay a possibly completed build.
                # Keep its intent terminal/unknown until a NEW user request.
                if status.is_file():
                    prior = json.loads(status.read_text(encoding="utf-8-sig"))
                    if (prior.get("generation_id") == args.generation_id and
                            prior.get("worktree_id") == layout["worktree_id"] and
                            prior.get("request_id")):
                        watcher.attempted = prior["request_id"]
                        initial.update(state="failed", request_id=watcher.attempted)
                publish(initial)
                heartbeat = StatusHeartbeat(status_publisher).start()
            print("[backend dev] Waiting for Build backend in the UI; source edits do not start a build.", flush=True)
            while True:
                if heartbeat is not None:
                    heartbeat.raise_if_failed()
                if stop is not None and stop.exists():
                    publish({"state": "stopped", "source_sha256": watcher.pending or args.baseline_digest})
                    return 0
                request_id = once_request or read_build_request(request_path, args.generation_id, layout["worktree_id"])
                observer.step()
                attempted_before = watcher.attempted
                watcher.step(time.monotonic(), request_id)
                if watcher.attempted != attempted_before:
                    # The request consumer already published this build's
                    # terminal result; don't replace its request_id on polling.
                    observer.signature = observer._signature()
                    observer.source = watcher.pending or args.baseline_digest
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
