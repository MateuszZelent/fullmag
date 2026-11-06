"""Atomic history publication under the existing control-volume operation lock.

This is an internal filesystem primitive, not a Docker admission command. Its
managed caller must authenticate mounts/namespace and collect complete external
run, process, lease and provenance evidence before planning and again under lock.
"""
from __future__ import annotations

from contextlib import contextmanager
import os
from pathlib import Path
import stat
import tempfile

from docker_activation_history_policy import (
    ATTEMPT, SCHEMA, SHA, HistoryError, MAX_ATTEMPT_BYTES, MAX_DOCUMENT_BYTES,
    MAX_HISTORY_ATTEMPTS, MAX_HISTORY_BYTES, MAX_LOG_BYTES,
    canonical, digest, file_manifest, referenced_attempts,
)


METADATA = frozenset({".history.json", ".history.sha256"})
GUARDS = ("activation/current.json", "activation/verified.json", "activation/unresolved.json",
          "development/current.json", "development/verified.json")


def _directory(path):
    path = Path(path)
    if path.is_symlink() or not path.is_dir() or path.resolve(strict=True) != path:
        raise HistoryError("History directory is missing, linked or noncanonical: " + str(path))
    return path


def _raw(path, maximum=MAX_DOCUMENT_BYTES):
    _directory(path.parent)
    before = path.lstat()
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
            or before.st_size > maximum):
        raise HistoryError("History file is linked, nonregular or oversized: " + path.name)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(maximum + 1)
        after = os.fstat(fd)
        signature = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_nlink)
        if (len(raw) > maximum or signature(before) != signature(opened)
                or signature(before) != signature(after) or signature(before) != signature(path.lstat())):
            raise HistoryError("History file changed while reading")
        return raw
    finally:
        os.close(fd)


def _optional_digest(root, relative):
    path = root / relative
    # An absent ancestor is ordinary absence; any linked ancestor is corruption.
    parent = root
    for component in Path(relative).parts[:-1]:
        parent = parent / component
        if parent.is_symlink():
            raise HistoryError("Linked history guard parent")
        if not parent.exists():
            return None
        _directory(parent)
    if path.is_symlink():
        raise HistoryError("Linked history guard")
    return digest(_raw(path)) if path.exists() else None


def _entries(path):
    if path.is_symlink():
        raise HistoryError("Linked history pool")
    if not path.exists():
        return []
    _directory(path)
    entries = list(path.iterdir())
    if len(entries) > MAX_HISTORY_ATTEMPTS:
        raise HistoryError("History pool entry bound exceeded")
    for child in entries:
        if ATTEMPT.fullmatch(child.name) is None:
            raise HistoryError("Unexpected history pool entry")
        _directory(child)
    return sorted(child.name for child in entries)


def source_files(path):
    _directory(path)
    entries = list(path.iterdir())
    if len(entries) > 32:
        raise HistoryError("History source file count exceeded")
    result = {}
    for entry in entries:
        # Prepared metadata is separately checked against the EXACT retained plan.
        if entry.name not in METADATA:
            result[entry.name] = _raw(entry, MAX_LOG_BYTES if entry.name == "build.log" else MAX_DOCUMENT_BYTES)
    return result


def make_plan(root, candidates, *, identity, external_evidence_sha256, protected):
    root = _directory(root)
    if (not isinstance(identity, dict) or not identity.get("compose_project")
            or not identity.get("control_volume") or not isinstance(identity.get("namespace"), str)
            or not isinstance(external_evidence_sha256, str) or SHA.fullmatch(external_evidence_sha256) is None):
        raise HistoryError("History identity or external evidence pin is missing")
    if not candidates or len(candidates) > 16:
        raise HistoryError("History requires one bounded batch")
    lock = root / "operation.lock"
    lock_info = lock.lstat()
    if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_nlink != 1:
        raise HistoryError("Operation lock identity is unsafe")
    guards = {name: _optional_digest(root, name) for name in GUARDS}
    guard_records = {name: _raw(root / name) for name, pin in guards.items() if pin is not None}
    live_protected = set(protected) | referenced_attempts(
        guard_records, {value["run_id"]: value["attempt"] for value in candidates})
    live = _entries(root / "activation/attempts")
    archived = _entries(root / "activation/history-v1")
    if len(live) > 64 or set(live) & set(archived):
        raise HistoryError("Live/history pool identity is inconsistent")
    seen = set()
    for value in candidates:
        token = value["attempt"]
        if token in seen or token in live_protected or token not in live:
            raise HistoryError("Candidate is duplicate, protected or absent")
        seen.add(token)
        path = root / "activation/attempts" / token
        if any((path / name).exists() or (path / name).is_symlink() for name in METADATA):
            raise HistoryError("Prepared history requires its retained plan")
        if file_manifest(source_files(path)) != value["files"]:
            raise HistoryError("Candidate changed after qualification")
    return {"schema": SCHEMA, "identity": dict(identity), "candidates": candidates,
            "external_evidence_sha256": external_evidence_sha256,
            "protected": sorted(live_protected), "guard_files": guards,
            "live_attempts": live, "archived_attempts": archived,
            "operation_lock": {"device": lock_info.st_dev, "inode": lock_info.st_ino}}


def _sync_dir(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _mkdir(path):
    if not path.exists() and not path.is_symlink():
        path.mkdir(mode=0o750)
        _sync_dir(path.parent)
    return _directory(path)


def _publish(path, raw, staging):
    if path.is_symlink():
        raise HistoryError("Linked history publication target")
    if path.exists():
        if _raw(path) != raw:
            raise HistoryError("Retained history metadata differs from the pinned plan")
        return
    # A crash before rename can leave only a private staging file, never a
    # partially written metadata record in the source or archive directory.
    descriptor, name = tempfile.mkstemp(prefix="history-", dir=staging)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.rename(temporary, path)
        _sync_dir(path.parent)
        _sync_dir(staging)
    finally:
        if temporary.exists():
            temporary.unlink()


@contextmanager
def _locked(root, expected):
    import fcntl
    lock = root / "operation.lock"
    descriptor = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        actual = os.fstat(descriptor)
        if ({"device": actual.st_dev, "inode": actual.st_ino} != expected
                or not stat.S_ISREG(actual.st_mode) or actual.st_nlink != 1):
            raise HistoryError("Operation lock inode differs")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise HistoryError("Control operation is active; history retained") from error
        if lock.lstat().st_ino != actual.st_ino or lock.lstat().st_dev != actual.st_dev:
            raise HistoryError("Operation lock was replaced")
        yield
    finally:
        os.close(descriptor)


def apply_plan(root, plan, *, expected_plan_sha256, fresh_external_evidence, checkpoint=lambda phase: None):
    """Publish under lock; reentry accepts only this exact plan and original bytes.

    fresh_external_evidence is a mandatory managed inventory callback, executed
    under the lock before mutation. It returns the digest of freshly revalidated
    run/process/lease/provenance pins; a caller assertion is not runtime proof.
    """
    root = _directory(root)
    if (not isinstance(plan, dict) or plan.get("schema") != SCHEMA
            or digest(canonical(plan)) != expected_plan_sha256):
        raise HistoryError("History plan digest differs")
    with _locked(root, plan["operation_lock"]):
        for relative in ("active", "cache-retirement/closing.json", "activation/unresolved.json"):
            if _optional_digest(root, relative) is not None:
                raise HistoryError("Control activity or unresolved recovery blocks history")
        if {name: _optional_digest(root, name) for name in GUARDS} != plan["guard_files"]:
            raise HistoryError("History guard pointers changed since preview")
        if fresh_external_evidence() != plan["external_evidence_sha256"]:
            raise HistoryError("External history evidence changed since preview")
        live = set(_entries(root / "activation/attempts"))
        archived = set(_entries(root / "activation/history-v1"))
        candidates = {value["attempt"]: value for value in plan["candidates"]}
        completed = archived - set(plan["archived_attempts"])
        if (live & archived or not completed.issubset(candidates)
                or live != set(plan["live_attempts"]) - completed
                or archived != set(plan["archived_attempts"]) | completed):
            raise HistoryError("History pool changed since preview")
        current_roots = {name: _raw(root / name) for name, pin in plan["guard_files"].items() if pin is not None}
        current_protected = referenced_attempts(current_roots, {
            value["run_id"]: token for token, value in candidates.items()})
        if set(candidates) & (set(plan["protected"]) | current_protected):
            raise HistoryError("History plan includes protected activation")
        if len(archived | set(candidates)) > MAX_HISTORY_ATTEMPTS:
            raise HistoryError("History count budget exhausted")
        # Count every retained archive byte, including metadata/index. Existing
        # archive integrity is also revalidated by the managed inventory caller.
        history_bytes = 0
        for token in archived:
            path = root / "activation/history-v1" / token
            entries = list(path.iterdir())
            if len(entries) > 33:
                raise HistoryError("History archive file bound exceeded")
            for entry in entries:
                history_bytes += len(_raw(entry, MAX_LOG_BYTES if entry.name == "build.log" else MAX_DOCUMENT_BYTES))
        reserve = sum(sum(row["size_bytes"] for row in value["files"].values()) + MAX_DOCUMENT_BYTES + 16384
                      for token, value in candidates.items() if token not in completed)
        if history_bytes + reserve > MAX_HISTORY_BYTES:
            raise HistoryError("History byte budget exhausted")

        activation = _directory(root / "activation")
        destination = _mkdir(activation / "history-v1")
        staging = _mkdir(activation / "history-staging-v1")
        if len(list(staging.iterdir())) > 64:
            raise HistoryError("History staging requires qualified retention")
        operations = _mkdir(activation / "history-operations-v1")
        operation = _mkdir(operations / expected_plan_sha256)
        _publish(operation / "plan.json", canonical(plan) + b"\n", staging)
        for token, value in candidates.items():
            source = activation / "attempts" / token
            target = destination / token
            retained = target if token in completed else source
            if file_manifest(source_files(retained)) != value["files"]:
                raise HistoryError("History candidate bytes changed")
            metadata = canonical({"schema": SCHEMA, "attempt": token,
                                  "plan_sha256": expected_plan_sha256,
                                  "identity": plan["identity"], "evidence": value,
                                  "external_evidence_sha256": plan["external_evidence_sha256"]}) + b"\n"
            rows = {**value["files"], ".history.json": {"sha256": digest(metadata), "size_bytes": len(metadata)}}
            index = (SCHEMA + " " + token + "\n" + "".join(
                f"{row['sha256']} {row['size_bytes']} {name}\n" for name, row in sorted(rows.items()))).encode()
            if len(metadata) > MAX_DOCUMENT_BYTES or len(index) > 16384 or sum(row["size_bytes"] for row in rows.values()) + len(index) > MAX_ATTEMPT_BYTES:
                raise HistoryError("History publication exceeds its byte budget")
            if token in completed:
                if _raw(retained / ".history.json") != metadata or _raw(retained / ".history.sha256") != index:
                    raise HistoryError("Completed archive does not match retained plan")
                continue
            checkpoint("before-metadata")
            _publish(source / ".history.json", metadata, staging)
            checkpoint("after-metadata")
            _publish(source / ".history.sha256", index, staging)
            _sync_dir(source)
            checkpoint("before-rename")
            os.rename(source, target)
            _sync_dir(source.parent)
            _sync_dir(destination)
            checkpoint("after-rename")
        receipt = {"schema": SCHEMA, "state": "archived", "plan_sha256": expected_plan_sha256,
                   "attempts": sorted(candidates), "records_deleted": False, "solve_replayed": False}
        _publish(operation / "receipt.json", canonical(receipt) + b"\n", staging)
        return receipt
