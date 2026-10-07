"""Hold a native runtime lease; release the build lease only after sealing."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time
import uuid
from datetime import datetime

from fullmag_storage import StorageError, atomic_json, build_lock, file_lock, now, process_alive, validate_path
from windows.runtime_bundle import _check_path_chain, validate_bundle
from windows.workspace_backend_identity import DEPENDENCY_INPUTS, fingerprint


TERMINAL_RUNTIME_STATES = frozenset(("completed", "failed"))
NONTERMINAL_RUNTIME_STATES = frozenset(("starting", "running", "stopping", "unknown"))
RECOVERY_ARCHIVE_NAME = re.compile(r"native-runtime-prior-[0-9a-f]{32}\.json")
SHA256 = re.compile(r"[0-9a-f]{64}")


def _read_runtime_status(path):
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise StorageError(f"Native workspace runtime status is unreadable; recovery is required: {error}") from error
    if not isinstance(value, dict):
        raise StorageError("Native workspace runtime status is not an object; recovery is required")
    return value


def _is_terminal_runtime_receipt(value, status_path=None):
    state = value.get("state")
    if not isinstance(state, str):
        return False
    if value.get("schema") == "fullmag.native-runtime-recovery.v1":
        return _is_valid_recovery_receipt(value, status_path)
    return (
        state in TERMINAL_RUNTIME_STATES
        and type(value.get("manager_pid")) is int
        and value["manager_pid"] > 0
        and type(value.get("launcher_pid")) is int
        and value["launcher_pid"] > 0
        and value.get("launcher_waited") is True
        and value.get("watcher_waited") is True
        and type(value.get("exit_code")) is int
        and isinstance(value.get("finished_at"), str)
        and bool(value["finished_at"])
        and (value.get("watcher_pid") is None or type(value.get("watcher_pid")) is int)
        and (value.get("watcher_pid") is None or
             (type(value.get("watcher_exit_code")) is int and value["watcher_exit_code"] == 0))
    )


def _is_valid_recovery_receipt(value, status_path):
    """Accept only an explicit recovery tied to preserved prior status bytes."""
    if status_path is None or value.get("state") != "recovered":
        return False
    recovery = value.get("recovery")
    if not isinstance(recovery, dict):
        return False
    operator = recovery.get("operator")
    checked_at = recovery.get("checked_at")
    archive_name = recovery.get("archived_status")
    prior_digest = recovery.get("previous_status_sha256")
    evidence = recovery.get("evidence")
    port = recovery.get("listener_port")
    if (not isinstance(operator, str) or not operator.strip() or
            not isinstance(checked_at, str) or not checked_at.strip() or
            not isinstance(archive_name, str) or not RECOVERY_ARCHIVE_NAME.fullmatch(archive_name) or
            not isinstance(prior_digest, str) or not SHA256.fullmatch(prior_digest) or
            type(port) is not int or not 1 <= port <= 65535 or
            not isinstance(evidence, dict) or
            evidence.get("manager_process_absent") is not True or
            evidence.get("native_executables_absent") is not True or
            evidence.get("watcher_processes_absent") is not True or
            evidence.get("listener_port_closed") is not True):
        return False
    try:
        checked_time = datetime.fromisoformat(checked_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    if checked_time.tzinfo is None:
        return False

    archive_path = Path(status_path).parent / archive_name
    try:
        if archive_path.is_symlink():
            return False
        archive_path = validate_path(archive_path, Path(status_path).parent, "native runtime recovery archive")
        if not archive_path.is_file():
            return False
        prior_bytes = archive_path.read_bytes()
        if hashlib.sha256(prior_bytes).hexdigest() != prior_digest:
            return False
        prior = json.loads(prior_bytes.decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, StorageError):
        return False

    if not isinstance(prior, dict):
        return False
    prior_state = prior.get("state")
    if (prior.get("schema") != "fullmag_storage_v1" or
            not isinstance(prior_state, str) or prior_state not in (NONTERMINAL_RUNTIME_STATES | {"failed"}) or
            prior.get("worktree_id") != value.get("worktree_id") or
            prior.get("repo_root") != value.get("repo_root")):
        return False
    prior_manager_pid = prior.get("manager_pid", prior.get("pid"))
    return (
        type(prior_manager_pid) is int and prior_manager_pid > 0 and
        type(evidence.get("manager_pid")) is int and evidence["manager_pid"] == prior_manager_pid
    )


def assert_no_independent_service(layout, environ=None):
    """Fail closed while canonical or externally configured service ownership is unresolved.

    FULLMAG_RUNTIME_SERVICE_CONFIG can select a store outside this checkout's
    canonical runs root. Until that owner has a separate lifecycle handshake,
    this controlled development route blocks rather than guessing whether the
    external service is absent. Canonical owner files are checked even when no
    config variable is present; no owner state is read, drained, or removed.
    """
    env = os.environ if environ is None else environ
    if "FULLMAG_RUNTIME_SERVICE_CONFIG" in env:
        raise StorageError(
            "An external runtime-service config is set through FULLMAG_RUNTIME_SERVICE_CONFIG; "
            "this controlled development route requires a separate owner handshake before starting or building"
        )

    service_root = Path(layout["runs_root"]) / "session-store" / "runtime-services"
    try:
        service_root = validate_path(
            service_root, layout["storage_root"], "native runtime service owner directory")
        root_info = service_root.lstat()
    except FileNotFoundError:
        return None
    except (OSError, StorageError) as error:
        raise StorageError(
            f"Cannot safely inspect canonical native runtime service owner directory {service_root}; "
            f"controlled service drain/recovery is required: {error}"
        ) from error
    if _is_service_reparse_point(root_info):
        raise StorageError(
            f"Canonical native runtime service owner directory is a symlink or reparse point: {service_root}; "
            "controlled service drain/recovery is required"
        )
    if not stat.S_ISDIR(root_info.st_mode):
        raise StorageError(
            f"Canonical native runtime service owner path is not a directory: {service_root}; "
            "controlled service drain/recovery is required"
        )

    for name in ("OWNER.json", "OWNER.lock", "LAUNCH.json", "LAUNCH.lock"):
        path = service_root / name
        try:
            path = validate_path(path, service_root, f"native runtime service {name}")
            info = path.lstat()
        except FileNotFoundError:
            continue
        except (OSError, StorageError) as error:
            raise StorageError(
                f"Cannot safely inspect native runtime service owner state at {path}; "
                f"controlled service drain/recovery is required: {error}"
            ) from error
        if _is_service_reparse_point(info):
            raise StorageError(
                f"Native runtime service owner state is a symlink or reparse point at {path}; "
                "controlled service drain/recovery is required"
            )
        raise StorageError(
            f"Native runtime service owner/launch state is present at {path}; "
            "controlled service drain/recovery is required before starting or building"
        )
    return None


def _is_service_reparse_point(info):
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & 0x400
    )


def active_runtime(layout):
    status = validate_path(
        Path(layout["runtime_root"]) / "native-workspace-status.json",
        layout["runtime_root"],
        "native runtime status",
    )
    value = _read_runtime_status(status)
    if value is None:
        return None
    if value.get("worktree_id") != layout["worktree_id"] or value.get("repo_root") != layout["repo_root"]:
        raise StorageError("Native runtime status belongs to a different checkout")
    if _is_terminal_runtime_receipt(value, status):
        return None
    state = value.get("state")
    if not isinstance(state, str) or state not in NONTERMINAL_RUNTIME_STATES:
        raise StorageError("Native runtime status is not a verified terminal receipt; recovery is required")
    if not process_alive(value.get("manager_pid", value.get("pid", -1))):
        raise StorageError(
            "Native workspace runtime has an uncertain owner outcome; verify its recorded processes and "
            "complete explicit recovery before building or launching again"
        )
    if value.get("state") != "running":
        raise StorageError("Native workspace runtime is still sealing or draining; retry after it exits")
    return value


def assert_frozen_dependencies(layout, active):
    source = active.get("source", {})
    expected = "dev" if source.get("compiler_profile") == "backend-dev" else "release"
    bundle, _ = validate_bundle(active["bundle_root"], layout["runtime_root"], expected)
    captured = bundle["source"].get("dependency_source_sha256")
    if not captured or captured != fingerprint(layout["repo_root"], DEPENDENCY_INPUTS)["sha256"]:
        raise StorageError("Python/frontend dependencies changed; save and close the active workspace before rebuilding")
    return captured


def validate_ready(path, layout, nonce, child_pid, profile):
    path = validate_path(path, layout["runtime_root"], "native runtime handshake")
    if path.is_symlink():
        raise StorageError("Native runtime handshake must be a regular file")
    value = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if (value.get("schema") != "fullmag.native-runtime-ready.v2" or
            value.get("nonce") != nonce or value.get("launcher_pid") != child_pid):
        raise StorageError("Native runtime handshake does not belong to this launcher")
    bundle, _ = validate_bundle(value["bundle_root"], layout["runtime_root"], profile)
    from windows.stable_launch import validate_launch_copy
    launch = validate_launch_copy(layout["repo_root"], value["bundle_root"], profile, nonce)
    if value.get("launch_root") != launch["launch_root"]:
        raise StorageError("Native runtime launch path does not match its verified executable view")
    return bundle, value["bundle_root"]


def run_sealed_runtime(layout, command, env, profile):
    root = Path(layout["storage_root"])
    runtime = Path(layout["runtime_root"])
    lease = validate_path(root / "locks" / (layout["worktree_id"] + ".native-runtime.lock"), root, "native runtime lease")
    status = validate_path(runtime / "native-workspace-status.json", root, "native runtime status")
    nonce = uuid.uuid4().hex
    ready = validate_path(runtime / ("native-ready-" + nonce + ".json"), root, "native runtime handshake")
    state = {
        "schema": "fullmag_storage_v1",
        "worktree_id": layout["worktree_id"],
        "profile": layout["profile"],
        "repo_root": layout["repo_root"],
        "pid": os.getpid(),
        "manager_pid": os.getpid(),
        "launch_nonce": nonce,
        "launcher_pid": None,
        "watcher_pid": None,
        "launcher_waited": False,
        "watcher_waited": True,
        "started_at": now(),
        "state": "starting",
        "execution_mode": "windows-workspace",
        "qualification": "not_assessed",
    }
    with file_lock(lease, "native workspace runtime"):
        previous = _read_runtime_status(status)
        if previous is not None:
            if (previous.get("worktree_id") != layout["worktree_id"] or
                    previous.get("repo_root") != layout["repo_root"]):
                raise StorageError("Native runtime status belongs to a different checkout")
            if not _is_terminal_runtime_receipt(previous, status):
                raise StorageError(
                    "Previous native workspace runtime has no verified terminal receipt; "
                    "inspect its recorded processes and complete explicit recovery before relaunch"
                )
        assert_no_independent_service(layout, env)
        atomic_json(status, state)
        child = None
        watcher = None
        stop_file = runtime / ("native-watch-stop-" + nonce + ".json")
        sealed = False
        try:
            with build_lock(layout):
                assert_no_independent_service(layout, env)
                child = subprocess.Popen(command, cwd=layout["repo_root"], env={
                    **env, **{key: os.environ[key] for key in
                              ("FULLMAG_STORAGE_LOCK_TOKEN", "FULLMAG_STORAGE_LOCK_KEY")},
                    "FULLMAG_NATIVE_RUNTIME_ACTIVE": "1",
                    "FULLMAG_NATIVE_RUNTIME_READY_FILE": str(ready),
                    "FULLMAG_NATIVE_RUNTIME_NONCE": nonce,
                })
                state["launcher_pid"] = child.pid
                atomic_json(status, state)
                # Until this receipt exists all launcher writes remain serialized.
                # No timeout fabricates successful publication or releases a lease.
                while child.poll() is None:
                    if ready.is_file():
                        bundle, bundle_root = validate_ready(ready, layout, nonce, child.pid, profile)
                        sealed = True
                        state.update(state="running", bundle_root=bundle_root,
                                     launch_root=str(runtime / "native-launch" / profile),
                                     build_lease="released_after_sealing", source=bundle.get("source"))
                        atomic_json(status, state)
                        break
                    time.sleep(0.1)
            if sealed and profile == "dev" and command[command.index("-Frontend") + 1] == "dev":
                import sys
                watch_env = dict(env)
                for key in (
                    "FULLMAG_STORAGE_LOCK_TOKEN",
                    "FULLMAG_STORAGE_LOCK_KEY",
                    "FULLMAG_NATIVE_RUNTIME_ACTIVE",
                    "FULLMAG_NATIVE_ACTIVE_DEPENDENCY_SHA256",
                    "FULLMAG_DEVELOPMENT_BACKEND_GENERATION",
                    "FULLMAG_DEVELOPMENT_BACKEND_STATUS_FILE",
                    "FULLMAG_DEVELOPMENT_BACKEND_SOURCE",
                    "FULLMAG_DEVELOPMENT_BACKEND_VERSION",
                ):
                    watch_env.pop(key, None)
                watcher_log = validate_path(
                    Path(layout["runtime_root"]) / "logs" / f"backend-watch-{nonce}.log",
                    layout["storage_root"], "backend request consumer log",
                )
                _check_path_chain(watcher_log, "backend request consumer log", allow_missing=True)
                watcher_log.parent.mkdir(parents=True, exist_ok=True)
                _check_path_chain(watcher_log, "backend request consumer log", allow_missing=True)
                # A background consumer must not depend on the UI terminal
                # draining its output or accepting input while a build runs.
                with watcher_log.open("xb") as output:
                    watcher = subprocess.Popen([
                        sys.executable, str(Path(__file__).with_name("watch_backend.py")),
                        "--repo-root", layout["repo_root"], "--web-port", command[command.index("-WebPort") + 1],
                        "--stop-file", str(stop_file), "--baseline-digest", bundle["source"]["backend_source_sha256"],
                        "--generation-id", nonce,
                    ], cwd=layout["repo_root"], env=watch_env,
                       stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)
                state["watcher_log"] = str(watcher_log)
                state["watcher_pid"] = watcher.pid
                state["watcher_waited"] = False
                atomic_json(status, state)
            result = child.wait()
            state.update(launcher_waited=True, exit_code=result)
            if result == 0 and not sealed:
                raise StorageError("Native launcher exited without publishing its sealed runtime")
            if watcher is not None:
                # The runtime remains nonterminal while the watcher drains any
                # build already admitted before this stop request.
                atomic_json(stop_file, {"schema": "fullmag.native-watch-stop.v1", "nonce": nonce})
                state["watcher_exit_code"] = watcher.wait()
                state["watcher_waited"] = True
                if state["watcher_exit_code"] != 0:
                    raise StorageError(
                        f"Native backend watcher did not drain cleanly; exit code {state['watcher_exit_code']}"
                    )
            state.update(state="completed" if result == 0 else "failed", finished_at=now())
            atomic_json(status, state)
            return result
        except BaseException as error:
            # Process death or an exception is not proof that PowerShell, the
            # API, or the independent application service is gone. Preserve a
            # nonterminal owner record so later builds/runs fail closed.
            state.update(
                state="unknown",
                uncertain_since=now(),
                error_type=type(error).__name__,
                error_message=str(error)[:1000],
            )
            try:
                atomic_json(status, state)
            except Exception:
                # Any earlier starting/running record is itself nonterminal.
                pass
            if watcher is not None:
                try:
                    atomic_json(stop_file, {"schema": "fullmag.native-watch-stop.v1", "nonce": nonce})
                    state["watcher_stop_requested_at"] = now()
                    state["watcher_exit_code"] = watcher.wait()
                    state["watcher_waited"] = True
                    atomic_json(status, state)
                except BaseException as cleanup_error:
                    state["watcher_drain_error"] = str(cleanup_error)[:1000]
                    try:
                        atomic_json(status, state)
                    except Exception:
                        pass
            raise
