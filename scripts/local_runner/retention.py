"""Read-only retention planning for the local container runner.

The planner is deliberately an inventory operation.  It never removes files,
changes queue state, calls Docker, or follows links.  A run is eligible only
when the queue record and its durable coordinator journal identify the same
job, owner, source digest, and full container ID.  Only the ``execution``
tree is measured; artifacts, logs, source capsules, and shared caches are
outside the retention scope.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
import json
import math
import os
from pathlib import Path
import re
import stat
from typing import Any


class RetentionError(ValueError):
    """The planner received an invalid storage root or retention policy."""


_TERMINAL_STATES = frozenset(("succeeded", "failed", "cancelled"))
_ACTIVE_STATES = frozenset(("running", "cancel_requested"))
_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
_DIGEST_RE = re.compile(r"[a-f0-9]{64}\Z")
_CONTAINER_RE = re.compile(r"[a-f0-9]{64}\Z")
_SCHEMA = "fullmag.local-runner.retention-plan.v1"
_JOURNAL_SCHEMA = "fullmag.local-runner.coordinator.v1"
_MAX_JSON_BYTES = 4 * 1024 * 1024
_REPARSE_POINT = 0x400


class _PathIssue(Exception):
    """An unsafe, missing, or unreadable path in one job's run tree."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _is_finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_reparse_or_symlink(path: Path) -> bool:
    """Inspect a path without resolving it or following a link."""

    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return False
    except OSError:
        # A path that cannot be inspected is unsafe for a cleanup decision.
        return True
    if stat.S_ISLNK(info.st_mode):
        return True
    return bool(getattr(info, "st_file_attributes", 0) & _REPARSE_POINT)


def _canonical_storage(value: object) -> Path:
    if not isinstance(value, (str, os.PathLike)):
        raise RetentionError("storage must be an absolute directory")
    lexical = Path(value)
    if not lexical.is_absolute():
        raise RetentionError("storage must be an absolute directory")
    try:
        lexical = Path(os.path.abspath(os.fspath(lexical)))
        if _is_reparse_or_symlink(lexical) or not lexical.is_dir():
            raise RetentionError("storage must be a real directory")
        resolved = lexical.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise RetentionError("cannot resolve storage") from error
    if os.path.normcase(str(lexical)) != os.path.normcase(str(resolved)):
        raise RetentionError("storage must not traverse a symlink or junction")
    if _is_reparse_or_symlink(resolved):
        raise RetentionError("storage must not be a symlink or junction")
    return resolved


def _valid_component(value: object) -> bool:
    # The queue accepts ``:`` for abstract identifiers, but a colon is a
    # drive/path separator on Windows and is not valid in canonical run paths.
    return isinstance(value, str) and _ID_RE.fullmatch(value) is not None


def _checked_child(root: Path, parts: tuple[str, ...], *, kind: str | None = None) -> Path:
    """Return a canonical child after checking every component without links."""

    current = root
    for part in parts:
        if not isinstance(part, str) or part in ("", ".", "..") or "/" in part or "\\" in part:
            raise _PathIssue("invalid_run_path")
        current = current / part
        try:
            info = os.lstat(current)
        except FileNotFoundError as error:
            raise _PathIssue("missing_run_path") from error
        except OSError as error:
            raise _PathIssue("unreadable_run_path") from error
        if stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & _REPARSE_POINT):
            raise _PathIssue("unsafe_reparse_path")

    try:
        if kind == "directory" and not current.is_dir():
            raise _PathIssue("invalid_run_path")
        if kind == "file" and not stat.S_ISREG(os.lstat(current).st_mode):
            raise _PathIssue("invalid_run_path")
        resolved = current.resolve(strict=True)
        resolved.relative_to(root)
    except _PathIssue:
        raise
    except (OSError, RuntimeError, ValueError) as error:
        raise _PathIssue("invalid_run_path") from error
    if os.path.normcase(str(current)) != os.path.normcase(str(resolved)):
        raise _PathIssue("unsafe_reparse_path")
    return resolved


def _read_json(path: Path) -> Mapping[str, Any]:
    """Read a bounded regular file, refusing links and non-object JSON."""

    try:
        info = os.lstat(path)
    except FileNotFoundError as error:
        raise _PathIssue("missing_metadata") from error
    except OSError as error:
        raise _PathIssue("unreadable_metadata") from error
    if stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & _REPARSE_POINT):
        raise _PathIssue("unsafe_reparse_path")
    if not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_JSON_BYTES:
        raise _PathIssue("invalid_metadata")

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = -1
            raw = stream.read(_MAX_JSON_BYTES + 1)
    except OSError as error:
        if descriptor != -1:
            try:
                os.close(descriptor)
            except OSError:
                pass
        raise _PathIssue("unreadable_metadata") from error
    if len(raw) > _MAX_JSON_BYTES:
        raise _PathIssue("invalid_metadata")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _PathIssue("invalid_metadata") from error
    if not isinstance(value, Mapping):
        raise _PathIssue("invalid_metadata")
    return value


def _safe_execution_bytes(root: Path) -> int:
    """Count regular files below ``root`` without crossing links or mounts."""

    try:
        root_info = os.lstat(root)
    except OSError as error:
        raise _PathIssue("unreadable_execution_tree") from error
    if stat.S_ISLNK(root_info.st_mode) or bool(getattr(root_info, "st_file_attributes", 0) & _REPARSE_POINT):
        raise _PathIssue("unsafe_execution_tree")
    if not stat.S_ISDIR(root_info.st_mode):
        raise _PathIssue("invalid_execution_tree")
    root_device = getattr(root_info, "st_dev", None)
    total = 0
    pending = [root]
    while pending:
        current = pending.pop()
        try:
            entries = list(os.scandir(current))
        except OSError as error:
            raise _PathIssue("unreadable_execution_tree") from error
        for entry in entries:
            path = Path(entry.path)
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError as error:
                raise _PathIssue("unreadable_execution_tree") from error
            if stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & _REPARSE_POINT):
                raise _PathIssue("unsafe_execution_tree")
            if stat.S_ISDIR(info.st_mode):
                # A mount placed inside an execution tree is outside the exact
                # job directory even when it is not represented as a symlink.
                entry_device = getattr(info, "st_dev", None)
                # Windows' ``DirEntry.stat`` reports a synthetic zero device
                # while ``lstat`` reports the volume identity.  Device-boundary
                # protection is meaningful on POSIX; reparse checks above are
                # the corresponding Windows boundary.
                if (os.name != "nt" and root_device is not None
                        and entry_device not in (None, 0, root_device)):
                    raise _PathIssue("unsafe_execution_tree")
                pending.append(path)
            elif stat.S_ISREG(info.st_mode):
                total += info.st_size
            else:
                raise _PathIssue("unsafe_execution_tree")
    return total


def _record(*, job_id: str | None, worktree_id: str | None, state: str | None,
            execution: Path | None, container_id: str | None, reason: str,
            expiry: float | None, size: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "job_id": job_id,
        "worktree_id": worktree_id,
        "state": state,
        "execution": str(execution) if execution is not None else None,
        "container_id": container_id,
        "reason": reason,
        "expiry": expiry,
    }
    if size is not None:
        result["bytes"] = size
    return result


def _job_terminal_time(job: Mapping[str, Any], journal: Mapping[str, Any]) -> float | None:
    # A terminal journal timestamp is authoritative once the coordinator has
    # written it; queue.updated_at is retained as the fallback for older jobs.
    value = journal["finished_at"] if "finished_at" in journal else job.get("updated_at")
    return float(value) if _is_finite_number(value) else None


def _pin_present(run_root: Path) -> bool:
    # These are direct, well-known paths.  We intentionally never walk the
    # artifacts directory, whose contents are not a retention decision input.
    for parts in (("artifacts.pin",), ("execution", "artifacts.pin"), ("artifacts", "artifacts.pin")):
        try:
            path = _checked_child(run_root, parts, kind="file")
        except _PathIssue as issue:
            if issue.reason in ("missing_run_path", "missing_metadata", "invalid_run_path"):
                continue
            # An unsafe pin path cannot grant protection; the execution/run
            # tree will still be retained by the caller's metadata checks.
            continue
        if path.is_file():
            return True

    for parts in (("artifacts", "build-receipt.json"), ("receipt.json",),
                  ("artifacts", "receipt.json"), ("execution", "build-receipt.json")):
        try:
            receipt = _read_json(_checked_child(run_root, parts, kind="file"))
        except _PathIssue:
            continue
        if receipt.get("pinned") is True:
            return True
    return False


def _sort_key(value: Mapping[str, Any]) -> tuple[str, str, str]:
    return (str(value.get("worktree_id") or ""), str(value.get("job_id") or ""), str(value.get("reason") or ""))


def plan(storage: str | os.PathLike[str], jobs: Iterable[Mapping[str, Any]], now: float,
         success_hours: float = 24, failed_hours: float = 168) -> dict[str, Any]:
    """Build a deterministic, read-only retention inventory.

    ``jobs`` is normally the queue's public record list.  A candidate is
    returned only for an expired succeeded/failed/cancelled record with an
    exact canonical run tree and matching coordinator journal.  Every other
    record is retained with a reason explaining the fail-closed decision.
    """

    root = _canonical_storage(storage)
    if not _is_finite_number(now):
        raise RetentionError("now must be a finite number")
    if not _is_finite_number(success_hours) or success_hours < 0:
        raise RetentionError("success_hours must be a finite non-negative number")
    if not _is_finite_number(failed_hours) or failed_hours < 0:
        raise RetentionError("failed_hours must be a finite non-negative number")
    try:
        records = iter(jobs)
    except TypeError as error:
        raise RetentionError("jobs must be iterable") from error

    candidates: list[dict[str, Any]] = []
    retained: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    candidate_bytes = 0
    retained_bytes = 0
    scanned_bytes = 0

    for raw in records:
        if not isinstance(raw, Mapping):
            retained.append(_record(job_id=None, worktree_id=None, state=None,
                                    execution=None, container_id=None,
                                    reason="invalid_job_record", expiry=None))
            continue

        job_id = raw.get("job_id") if isinstance(raw.get("job_id"), str) else None
        worktree_id = raw.get("worktree_id") if isinstance(raw.get("worktree_id"), str) else None
        state = raw.get("state") if isinstance(raw.get("state"), str) else None
        if not _valid_component(job_id) or not _valid_component(worktree_id):
            retained.append(_record(job_id=job_id, worktree_id=worktree_id, state=state,
                                    execution=None, container_id=None,
                                    reason="invalid_job_identity", expiry=None))
            continue
        identity = (os.path.normcase(worktree_id), os.path.normcase(job_id))
        if identity in seen:
            retained.append(_record(job_id=job_id, worktree_id=worktree_id, state=state,
                                    execution=None, container_id=None,
                                    reason="duplicate_job", expiry=None))
            continue
        seen.add(identity)

        if state in _ACTIVE_STATES:
            retained.append(_record(job_id=job_id, worktree_id=worktree_id, state=state,
                                    execution=None, container_id=None, reason="active", expiry=None))
            continue
        if state not in _TERMINAL_STATES:
            retained.append(_record(job_id=job_id, worktree_id=worktree_id, state=state,
                                    execution=None, container_id=None,
                                    reason="unsupported_state", expiry=None))
            continue

        try:
            run_root = _checked_child(root, ("runs", worktree_id, job_id), kind="directory")
            execution = _checked_child(root, ("runs", worktree_id, job_id, "execution"), kind="directory")
            journal_path = _checked_child(root, ("runs", worktree_id, job_id, "coordinator.json"), kind="file")
            journal = _read_json(journal_path)
        except _PathIssue as issue:
            retained.append(_record(job_id=job_id, worktree_id=worktree_id, state=state,
                                    execution=None, container_id=None,
                                    reason=issue.reason, expiry=None))
            continue

        container_id = journal.get("container_id")
        visible_container = container_id if isinstance(container_id, str) and _CONTAINER_RE.fullmatch(container_id) else None
        if journal.get("schema") != _JOURNAL_SCHEMA or journal.get("job_id") != job_id:
            retained.append(_record(job_id=job_id, worktree_id=worktree_id, state=state,
                                    execution=execution, container_id=visible_container,
                                    reason="invalid_coordinator", expiry=None))
            continue
        if journal.get("owner") != raw.get("owner"):
            retained.append(_record(job_id=job_id, worktree_id=worktree_id, state=state,
                                    execution=execution, container_id=visible_container,
                                    reason="owner_mismatch", expiry=None))
            continue
        if (not isinstance(raw.get("source_digest"), str)
                or not _DIGEST_RE.fullmatch(raw["source_digest"])
                or journal.get("source_digest") != raw["source_digest"]):
            retained.append(_record(job_id=job_id, worktree_id=worktree_id, state=state,
                                    execution=execution, container_id=visible_container,
                                    reason="source_identity_mismatch", expiry=None))
            continue
        if "worktree_id" in journal and journal.get("worktree_id") != worktree_id:
            retained.append(_record(job_id=job_id, worktree_id=worktree_id, state=state,
                                    execution=execution, container_id=visible_container,
                                    reason="invalid_coordinator", expiry=None))
            continue
        if not isinstance(container_id, str) or _CONTAINER_RE.fullmatch(container_id) is None:
            retained.append(_record(job_id=job_id, worktree_id=worktree_id, state=state,
                                    execution=execution, container_id=None,
                                    reason="missing_full_container_id", expiry=None))
            continue
        if "state" in journal and journal.get("state") != state:
            retained.append(_record(job_id=job_id, worktree_id=worktree_id, state=state,
                                    execution=execution, container_id=container_id,
                                    reason="coordinator_state_mismatch", expiry=None))
            continue

        timestamp = _job_terminal_time(raw, journal)
        if timestamp is None:
            retained.append(_record(job_id=job_id, worktree_id=worktree_id, state=state,
                                    execution=execution, container_id=container_id,
                                    reason="invalid_timestamp", expiry=None))
            continue
        hours = success_hours if state == "succeeded" else failed_hours
        expiry = timestamp + float(hours) * 3600

        try:
            size = _safe_execution_bytes(execution)
        except _PathIssue as issue:
            retained.append(_record(job_id=job_id, worktree_id=worktree_id, state=state,
                                    execution=execution, container_id=container_id,
                                    reason=issue.reason, expiry=expiry))
            continue
        retained_bytes += size
        scanned_bytes += size

        if _pin_present(run_root):
            retained.append(_record(job_id=job_id, worktree_id=worktree_id, state=state,
                                    execution=execution, container_id=container_id,
                                    reason="pinned", expiry=expiry, size=size))
            continue
        if float(now) < expiry:
            retained.append(_record(job_id=job_id, worktree_id=worktree_id, state=state,
                                    execution=execution, container_id=container_id,
                                    reason="not_expired", expiry=expiry, size=size))
            continue

        candidate = _record(job_id=job_id, worktree_id=worktree_id, state=state,
                            execution=execution, container_id=container_id,
                            reason=f"{state}_expired", expiry=expiry, size=size)
        candidates.append(candidate)
        candidate_bytes += size
        retained_bytes -= size

    candidates.sort(key=_sort_key)
    retained.sort(key=_sort_key)
    return {
        "schema": _SCHEMA,
        "generated_at": float(now),
        "candidates": candidates,
        "retained": retained,
        "space": {
            "candidate_bytes": candidate_bytes,
            "retained_bytes": retained_bytes,
            "scanned_bytes": scanned_bytes,
            "candidate_count": len(candidates),
            "retained_count": len(retained),
        },
    }


__all__ = ["RetentionError", "plan"]
