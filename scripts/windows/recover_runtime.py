#!/usr/bin/env python3
"""Explicitly recover a stale native Windows workspace runtime owner."""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from typing import Any, Callable


_SCRIPTS_ROOT = Path(__file__).resolve().parents[1]
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

import fullmag_storage as storage
from windows import runtime_bundle, runtime_lease


RECOVERY_SCHEMA = "fullmag.native-runtime-recovery.v1"
INSPECTION_SCHEMA = "fullmag.windows-runtime-inspection.v1"
PROFILE = "windows-native-fdm-cpu-dev"
STATUS_NAME = "native-workspace-status.json"

_POWERSHELL_INSPECTION = r"""
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $port = 0
  if (-not [int]::TryParse($env:FULLMAG_RECOVERY_PORT, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw 'Invalid recovery listener port'
  }
  $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{
      process_id = [int]$_.ProcessId
      name = [string]$_.Name
      executable_path = if ($null -eq $_.ExecutablePath) { $null } else { [string]$_.ExecutablePath }
      command_line = if ($null -eq $_.CommandLine) { $null } else { [string]$_.CommandLine }
    }
  })
  $allConnections = @(Get-NetTCPConnection -ErrorAction Stop)
  $connections = @($allConnections | Where-Object { [int]$_.LocalPort -eq $port } | ForEach-Object {
    [pscustomobject]@{
      local_port = [int]$_.LocalPort
      state = [string]$_.State
      process_id = [int]$_.OwningProcess
    }
  })
  $result = [pscustomobject]@{
    schema = 'fullmag.windows-runtime-inspection.v1'
    processes_complete = $true
    connections_complete = $true
    processes = $processes
    connections = $connections
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Depth 5 -Compress))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}
"""


class RecoveryError(storage.StorageError):
    """Recovery was not proven safe; the prior runtime status was retained."""


def _is_reparse_point(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & 0x400
    )


def _check_path_chain(path: Path, label: str, *, allow_missing_leaf: bool = False) -> None:
    """Reject reparse points anywhere in an already-resolved managed path."""
    absolute = Path(os.path.abspath(path))
    components = list(reversed(absolute.parents)) + [absolute]
    missing = False
    for index, component in enumerate(components):
        try:
            info = component.lstat()
        except FileNotFoundError as error:
            if not allow_missing_leaf or index != len(components) - 1:
                raise RecoveryError(f"{label} path is missing or incomplete: {component}") from error
            missing = True
            continue
        except OSError as error:
            raise RecoveryError(f"Cannot inspect {label} path {component}: {error}") from error
        if missing:
            raise RecoveryError(f"{label} path has an unexpected component after a missing parent: {component}")
        if _is_reparse_point(info):
            raise RecoveryError(f"{label} path contains a symlink or reparse point: {component}")
        if index != len(components) - 1 and not stat.S_ISDIR(info.st_mode):
            raise RecoveryError(f"{label} ancestor is not a directory: {component}")


def _same_path(left: str | os.PathLike[str], right: str | os.PathLike[str]) -> bool:
    return os.path.normcase(os.path.abspath(os.fspath(left))) == os.path.normcase(
        os.path.abspath(os.fspath(right))
    )


def _managed_paths(layout: dict[str, Any]) -> tuple[Path, Path, Path, Path, dict[str, Any], bytes]:
    if layout.get("profile") != PROFILE:
        raise RecoveryError(f"Runtime recovery requires the fixed {PROFILE!r} storage profile")
    storage.validate_managed_view(layout)

    repo = storage.absolute(layout["repo_root"], "repository root")
    if storage.identifier(repo) != layout["worktree_id"]:
        raise RecoveryError("Resolved worktree identity does not match its repository path")
    storage_root = storage.absolute(layout["storage_root"], "project storage root")
    runtime_root = storage.validate_path(
        Path(layout["runtime_root"]), storage_root, "native runtime root"
    )
    build_root = storage.validate_path(
        Path(layout["build_root"]), layout["build_storage_root"], "native build profile root"
    )
    lock_root = storage.validate_path(storage_root / "locks", storage_root, "storage lock directory")
    if not lock_root.is_dir():
        raise RecoveryError(f"Managed storage lock directory is missing: {lock_root}")
    if not runtime_root.is_dir():
        raise RecoveryError(f"Canonical native runtime directory is missing: {runtime_root}")

    marker = storage.validate_path(storage_root / ".fullmag-storage.json", storage_root, "storage marker")
    _check_path_chain(marker, "storage marker")
    try:
        marker_value = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RecoveryError(f"Cannot read the canonical storage marker: {error}") from error
    if marker_value != {"schema": storage.SCHEMA, "project_root": layout["project_root"]}:
        raise RecoveryError("Canonical storage marker does not belong to this Fullmag project")

    _check_path_chain(repo, "repository root")
    _check_path_chain(storage_root, "project storage root")
    _check_path_chain(build_root, "native build profile root")
    _check_path_chain(runtime_root, "native runtime root")
    _check_path_chain(lock_root, "storage lock directory")
    status = storage.validate_path(runtime_root / STATUS_NAME, storage_root, "native runtime status")
    _check_path_chain(status, "native runtime status")
    info = status.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise RecoveryError("Native runtime status must be a regular file")
    owner, owner_bytes = _read_active_owner(layout, storage_root)
    return repo, storage_root, runtime_root, status, owner, owner_bytes


def _decode_object(raw: bytes, label: str) -> dict[str, Any]:
    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise ValueError(f"duplicate key: {key}")
            value[key] = item
        return value

    try:
        value = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=unique_object)
    except (UnicodeError, json.JSONDecodeError, ValueError) as error:
        raise RecoveryError(f"{label} is unreadable: {error}") from error
    if not isinstance(value, dict):
        raise RecoveryError(f"{label} is not an object")
    return value


def _read_active_owner(layout: dict[str, Any], storage_root: Path) -> tuple[dict[str, Any], bytes]:
    owner_path = storage.validate_path(
        storage_root / "index" / f"{layout['worktree_id']}.json",
        storage_root,
        "native runtime worktree owner registry",
    )
    _check_path_chain(owner_path, "native runtime worktree owner registry")
    if not stat.S_ISREG(owner_path.lstat().st_mode):
        raise RecoveryError("Native runtime worktree owner registry must be a regular file")
    try:
        owner_bytes = owner_path.read_bytes()
    except OSError as error:
        raise RecoveryError(f"Cannot read native runtime worktree owner registry: {error}") from error
    owner = _decode_object(owner_bytes, "Native runtime worktree owner registry")
    if (owner.get("schema") != storage.SCHEMA
            or owner.get("worktree_id") != layout["worktree_id"]
            or owner.get("repo_root") != layout["repo_root"]
            or owner.get("state") not in {"active", "wip"}
            or not isinstance(owner.get("task_id"), str) or not owner["task_id"].strip()
            or not isinstance(owner.get("owner"), str) or not owner["owner"].strip()):
        raise RecoveryError(
            "Native runtime recovery requires an active/wip owner registered for this exact checkout and worktree"
        )
    return owner, owner_bytes


def _decode_status(raw: bytes) -> dict[str, Any]:
    return _decode_object(raw, "Previous native runtime status")


def _validate_prior_owner(value: dict[str, Any], layout: dict[str, Any]) -> int:
    state = value.get("state")
    if value.get("schema") != storage.SCHEMA:
        raise RecoveryError("Previous native runtime status has an unsupported owner schema")
    if value.get("worktree_id") != layout["worktree_id"]:
        raise RecoveryError("Previous native runtime status belongs to a different worktree")
    if not isinstance(value.get("repo_root"), str) or value["repo_root"] != layout["repo_root"]:
        raise RecoveryError("Previous native runtime status belongs to a different checkout")
    if value.get("profile") != layout["profile"]:
        raise RecoveryError("Previous native runtime status belongs to a different storage profile")
    if value.get("execution_mode") != "windows-workspace":
        raise RecoveryError("Previous status is not owned by the native Windows workspace runtime")
    if not isinstance(state, str) or state not in (
        runtime_lease.NONTERMINAL_RUNTIME_STATES | {"failed"}
    ):
        raise RecoveryError("Previous runtime status is not an unresolved native workspace owner")

    manager = value.get("manager_pid", value.get("pid"))
    if type(manager) is not int or manager <= 0:
        raise RecoveryError("Previous runtime status has no trustworthy manager PID")
    legacy_pid = value.get("pid")
    if legacy_pid is not None and (type(legacy_pid) is not int or legacy_pid != manager):
        raise RecoveryError("Previous runtime status has inconsistent manager PID fields")
    for field in ("launcher_pid", "watcher_pid"):
        pid = value.get(field)
        if pid is not None and (type(pid) is not int or pid <= 0):
            raise RecoveryError(f"Previous runtime status has an invalid {field}")

    bundle_root = value.get("bundle_root")
    if bundle_root is not None:
        if not isinstance(bundle_root, str) or not bundle_root:
            raise RecoveryError("Previous runtime status has an invalid bundle root")
        bundles_root = Path(layout["runtime_root"]) / "native-bundles"
        try:
            bundle_path = storage.validate_path(Path(bundle_root), bundles_root, "previous runtime bundle")
            _check_path_chain(bundle_path, "previous runtime bundle")
        except (OSError, storage.StorageError) as error:
            raise RecoveryError(f"Previous runtime bundle path is mismatched or unsafe: {error}") from error
        if not bundle_path.is_dir():
            raise RecoveryError("Previous runtime bundle directory is missing")
    return manager


def windows_process_snapshot(_layout: dict[str, Any], port: int) -> dict[str, Any]:
    """Query complete Windows process and TCP state without evaluating caller text."""
    if os.name != "nt":
        raise RecoveryError("Native runtime recovery requires native Windows process inspection")
    import base64

    encoded = base64.b64encode(_POWERSHELL_INSPECTION.encode("utf-16le")).decode("ascii")
    env = {**os.environ, "FULLMAG_RECOVERY_PORT": str(port)}
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
             "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
            env=env, capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=30, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RecoveryError(f"Windows process/listener inspection failed: {error}") from error
    if result.returncode != 0:
        raise RecoveryError(
            "Windows process/listener inspection failed; no absence was inferred: "
            + (result.stderr.strip() or f"PowerShell exit code {result.returncode}")
        )
    try:
        snapshot = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError) as error:
        raise RecoveryError("Windows process/listener inspection returned invalid structured JSON") from error
    return snapshot


def _normalize_process_path(path: str) -> str:
    return os.path.normcase(os.path.abspath(os.path.normpath(path)))


def _path_is_within(candidate: str, root: str) -> bool:
    candidate_path = _normalize_process_path(candidate)
    root_path = _normalize_process_path(root)
    try:
        return os.path.commonpath((candidate_path, root_path)) == root_path
    except ValueError:
        return False


def _validate_inspection(snapshot: Any, layout: dict[str, Any], port: int,
                         recorded_pids: set[int], manager_pid: int) -> dict[str, Any]:
    if not isinstance(snapshot, dict) or snapshot.get("schema") != INSPECTION_SCHEMA:
        raise RecoveryError("Windows process/listener inspection returned an unsupported record")
    if snapshot.get("processes_complete") is not True or snapshot.get("connections_complete") is not True:
        raise RecoveryError("Windows process/listener inspection was incomplete; no absence was inferred")
    processes = snapshot.get("processes")
    connections = snapshot.get("connections")
    if not isinstance(processes, list) or not isinstance(connections, list):
        raise RecoveryError("Windows process/listener inspection omitted a structured process or connection list")

    seen_pids: set[int] = set()
    native_names = {name.casefold() for name in runtime_bundle.BINARY_NAMES}
    repo = str(layout["repo_root"])
    build_root = str(layout["build_root"])
    runtime_root = str(layout["runtime_root"])
    roots = (repo, build_root, runtime_root)
    watcher_path = str(Path(repo) / "scripts" / "windows" / "watch_backend.py")
    found_native: list[str] = []
    found_watchers: list[int] = []

    for process in processes:
        if not isinstance(process, dict):
            raise RecoveryError("Windows process inspection contains an invalid process row")
        pid = process.get("process_id")
        name = process.get("name")
        executable = process.get("executable_path")
        command_line = process.get("command_line")
        if type(pid) is int and pid == 0 and isinstance(name, str) and name.casefold() == "system idle process":
            if pid in seen_pids:
                raise RecoveryError("Windows process inspection returned duplicate PID 0")
            seen_pids.add(pid)
            continue
        if type(pid) is not int or pid <= 0 or not isinstance(name, str) or not name:
            raise RecoveryError("Windows process inspection contains an incomplete process identity")
        if pid in seen_pids:
            raise RecoveryError(f"Windows process inspection returned duplicate PID {pid}")
        seen_pids.add(pid)
        base_name = name.replace("/", "\\").rsplit("\\", 1)[-1].casefold()
        if base_name in native_names:
            if not isinstance(executable, str) or not executable.strip():
                raise RecoveryError(
                    f"Cannot inspect the executable path for {name} PID {pid}; recovery remains blocked"
                )
            if not isinstance(command_line, str) or not command_line.strip():
                raise RecoveryError(
                    f"Cannot inspect the command line for {name} PID {pid}; recovery remains blocked"
                )
            if any(_path_is_within(executable, root) for root in roots):
                found_native.append(f"{name} PID {pid}")
        if ((base_name.startswith("python") and base_name.endswith(".exe")) or base_name == "py.exe") and (
            not isinstance(command_line, str) or not command_line.strip()
        ):
            raise RecoveryError(
                f"Cannot inspect the command line for Python PID {pid}; watcher absence is unproven"
            )
        if command_line is not None and not isinstance(command_line, str):
            raise RecoveryError(f"Windows process inspection has an invalid command line for PID {pid}")
        if isinstance(command_line, str):
            folded_command = command_line.replace("/", "\\").casefold()
            folded_watcher = watcher_path.replace("/", "\\").casefold()
            if "watch_backend.py" in folded_command and (
                folded_watcher in folded_command or _normalize_process_path(repo) in folded_command
            ):
                found_watchers.append(pid)

    reused_or_live = sorted(recorded_pids & seen_pids)
    if reused_or_live:
        raise RecoveryError(
            "A recorded manager/launcher/watcher PID is still present or has been reused; "
            f"recovery remains blocked: {reused_or_live}"
        )
    if found_native:
        raise RecoveryError("Native Fullmag executable is still running for this checkout/bundle: " + ", ".join(found_native))
    if found_watchers:
        raise RecoveryError(f"Native backend watcher is still running for this checkout: {sorted(set(found_watchers))}")

    local_ports: set[int] = set()
    for connection in connections:
        if not isinstance(connection, dict):
            raise RecoveryError("Windows listener inspection contains an invalid connection row")
        local_port = connection.get("local_port")
        state = connection.get("state")
        process_id = connection.get("process_id")
        if type(local_port) is not int or not 1 <= local_port <= 65535:
            raise RecoveryError("Windows listener inspection contains an invalid local port")
        if not isinstance(state, str) or not state or type(process_id) is not int or process_id < 0:
            raise RecoveryError("Windows listener inspection contains incomplete connection ownership")
        local_ports.add(local_port)
    if port in local_ports:
        raise RecoveryError(f"TCP port {port} is not closed; recovery remains blocked")

    return {
        "manager_pid": manager_pid,
        "manager_process_absent": manager_pid not in seen_pids,
        "recorded_processes_absent": True,
        "native_executables_absent": not found_native,
        "watcher_processes_absent": not found_watchers,
        "listener_port_closed": port not in local_ports,
    }


def _write_atomic_exclusive(path: Path, contents: bytes) -> None:
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    storage.validate_path(temp, path.parent, "native recovery staging file")
    _check_path_chain(temp, "native recovery staging file", allow_missing_leaf=True)
    try:
        with temp.open("xb") as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        # A same-directory hard link publishes the complete bytes atomically and
        # fails if the chosen archive name already exists.
        os.link(temp, path)
    except FileExistsError as error:
        raise RecoveryError(f"Native recovery archive already exists: {path}") from error
    except OSError as error:
        raise RecoveryError(f"Cannot atomically publish native recovery archive {path}: {error}") from error
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def _replace_status_atomically(path: Path, contents: bytes, expected_previous: bytes) -> None:
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    storage.validate_path(temp, path.parent, "native recovery status staging file")
    _check_path_chain(temp, "native recovery status staging file", allow_missing_leaf=True)
    try:
        with temp.open("xb") as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        _check_path_chain(path, "native runtime status")
        try:
            current = path.read_bytes()
        except OSError as error:
            raise RecoveryError(f"Cannot re-read previous runtime status before replacement: {error}") from error
        if current != expected_previous:
            raise RecoveryError("Native runtime status changed during recovery; it was not replaced")
        os.replace(temp, path)
    except RecoveryError:
        raise
    except OSError as error:
        raise RecoveryError(f"Cannot atomically replace native runtime status: {error}") from error
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def _recorded_pids(value: dict[str, Any]) -> set[int]:
    manager = value.get("manager_pid", value.get("pid"))
    result = {manager}
    result.update(pid for pid in (value.get("launcher_pid"), value.get("watcher_pid")) if pid is not None)
    return result


def recover(layout: dict[str, Any], port: int = 3197, *,
            snapshot_provider: Callable[[dict[str, Any], int], dict[str, Any]] | None = None,
            environ: dict[str, str] | None = None) -> dict[str, Any]:
    """Archive and replace one stale status after proving its owner is gone."""
    if type(port) is not int or not 1 <= port <= 65535:
        raise RecoveryError("Recovery listener port must be an integer from 1 to 65535")
    if snapshot_provider is None:
        if os.name != "nt":
            raise RecoveryError("Native runtime recovery requires native Windows process inspection")
        snapshot_provider = windows_process_snapshot
    env = os.environ if environ is None else environ
    repo, storage_root, runtime_root, status, owner, owner_bytes = _managed_paths(layout)
    if not _same_path(repo, layout["repo_root"]):
        raise RecoveryError("Resolved repository owner does not match this checkout")

    lease = storage.validate_path(
        storage_root / "locks" / f"{layout['worktree_id']}.native-runtime.lock",
        storage_root, "native workspace runtime lease",
    )
    build_lock_path = storage.validate_path(
        storage_root / "locks" / f"{layout['worktree_id']}.lock",
        storage_root, "native workspace build lock",
    )
    owner_path = storage.validate_path(
        storage_root / "locks" / f"{layout['worktree_id']}.owner.json",
        storage_root, "native workspace build lock owner",
    )
    _check_path_chain(lease, "native workspace runtime lease", allow_missing_leaf=True)
    _check_path_chain(build_lock_path, "native workspace build lock", allow_missing_leaf=True)
    _check_path_chain(owner_path, "native workspace build lock owner", allow_missing_leaf=True)

    with storage.file_lock(lease, "native workspace runtime recovery"):
        with storage.build_lock(layout):
            runtime_lease.assert_no_independent_service(layout, env)
            _, current_owner_bytes = _read_active_owner(layout, storage_root)
            if current_owner_bytes != owner_bytes:
                raise RecoveryError("Worktree owner registry changed during recovery admission")
            try:
                previous_bytes = status.read_bytes()
            except OSError as error:
                raise RecoveryError(f"Cannot read previous native runtime status: {error}") from error
            prior = _decode_status(previous_bytes)
            manager_pid = _validate_prior_owner(prior, layout)
            recorded_pids = _recorded_pids(prior)

            try:
                snapshot = snapshot_provider(layout, port)
            except RecoveryError:
                raise
            except Exception as error:
                raise RecoveryError(f"Windows process/listener inspection failed; no absence was inferred: {error}") from error
            evidence = _validate_inspection(snapshot, layout, port, recorded_pids, manager_pid)
            if evidence["manager_pid"] != manager_pid:
                raise RecoveryError("Windows recovery evidence does not match the recorded manager owner")

            runtime_lease.assert_no_independent_service(layout, env)
            try:
                current_bytes = status.read_bytes()
            except OSError as error:
                raise RecoveryError(f"Cannot re-read previous native runtime status: {error}") from error
            if current_bytes != previous_bytes:
                raise RecoveryError("Native runtime status changed during inspection; it was not archived or replaced")

            archive_name = f"native-runtime-prior-{uuid.uuid4().hex}.json"
            archive = storage.validate_path(runtime_root / archive_name, runtime_root, "native runtime status archive")
            _check_path_chain(archive, "native runtime status archive", allow_missing_leaf=True)
            _write_atomic_exclusive(archive, previous_bytes)
            prior_digest = hashlib.sha256(previous_bytes).hexdigest()
            recovery = {
                "operator": os.environ.get("USERNAME") or getpass.getuser() or "local-operator",
                "checked_at": datetime.now(timezone.utc).isoformat(),
                "archived_status": archive_name,
                "previous_status_sha256": prior_digest,
                "listener_port": port,
                "evidence": evidence,
                "owner_registry": {
                    "task_id": owner["task_id"],
                    "owner": owner["owner"],
                    "state": owner["state"],
                    "sha256": hashlib.sha256(owner_bytes).hexdigest(),
                },
            }
            receipt = {
                "schema": RECOVERY_SCHEMA,
                "state": "recovered",
                "worktree_id": layout["worktree_id"],
                "repo_root": str(repo),
                "profile": layout["profile"],
                "recovery": recovery,
            }
            if not runtime_lease._is_valid_recovery_receipt(receipt, status):
                raise RecoveryError("Generated recovery receipt failed the native runtime lease contract")
            receipt_bytes = (json.dumps(receipt, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            _replace_status_atomically(status, receipt_bytes, previous_bytes)
            try:
                written = _decode_status(status.read_bytes())
            except (OSError, RecoveryError) as error:
                raise RecoveryError(f"Cannot verify the published native recovery receipt: {error}") from error
            if not runtime_lease._is_terminal_runtime_receipt(written, status):
                raise RecoveryError("Published native recovery receipt does not pass the runtime lease validator")
            return {
                "state": "recovered",
                "status": str(status),
                "archive": str(archive),
                "previous_status_sha256": prior_digest,
                "listener_port": port,
            }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--web-port", type=int, default=3197)
    args = parser.parse_args(argv)
    try:
        if os.name != "nt":
            raise RecoveryError("Native runtime recovery is available only on native Windows")
        layout = storage.resolve_layout(args.repo_root, PROFILE)
        result = recover(layout, args.web_port)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (storage.StorageError, OSError, ValueError) as error:
        print(f"Native workspace recovery failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
