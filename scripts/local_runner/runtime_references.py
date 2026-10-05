"""Read-only, fail-closed planner for local runner runtime package references.

The planner reads queue records, exact build receipts, bounded consumer metadata,
complete caller-supplied Docker inspections, pins, and explicit reference roots.
It never walks package payloads or scans source, execution, cache, build, or image
contents. Missing completeness attestations or unknown reference scope suppress
all candidates; scoped package-identity errors protect the affected job/group.

This is a preview snapshot, not deletion authorization. An executor must
revalidate under a shared reference guard that prevents new consumers racing a
delete. Native bundles outside the exact local package root, runtime variants,
images, source capsules, execution trees, and shared caches remain protected.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
from typing import Any

PLAN_SCHEMA = "fullmag.local-runner.runtime-reference-plan.v1"
BUILD_RECEIPT_SCHEMA = "fullmag.local-runner.build-receipt.v1"
RETENTION_TOMBSTONE_SCHEMA = "fullmag.runtime-package-retention.v1"
MANAGED_BROWSER_SCHEMA = "fullmag.managed-browser.v1"
_CONTROLLER_REFERENCE_SCHEMAS = {
    "signed15-controller-v1.json": "fullmag.one-shot-campaign-controller.v1",
    "signed15-plot-controller-v1.json": "fullmag.one-shot-plot-controller.v1",
    "priority-k10-results.json": "fullmag.priority-signed-pilots.v1",
}
_KNOWN_REFERENCE_SCHEMAS = frozenset({
    "fullmag.comsol-dispersion-benchmark.request.v1",
    "fullmag.comsol-dispersion-benchmark.result.v1",
    "fullmag.de100-pilot.request.v1",
    "fullmag.de100-pilot.result.v1",
    "fullmag.de-smoke.request.v1",
    "fullmag.de-smoke.result.v1",
    "fullmag.de-smoke.v1",
    "fullmag.de-ui-model-preview.v1",
    "fullmag.managed-package-openapi.v1",
    *_CONTROLLER_REFERENCE_SCHEMAS.values(),
    MANAGED_BROWSER_SCHEMA,
})
COORDINATOR_LABELS = {
    "com.fullmag.local-runner": "build-coordinator",
    "com.fullmag.local-runner.role": "coordinator",
    "com.fullmag.local-runner.schema": "fullmag.local-runner.container.v1",
}
_ACTIVE_STATES = frozenset(("queued", "running", "cancel_requested"))
_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
_FULL_ID_RE = re.compile(r"[a-f0-9]{64}\Z")
_MAX_JSON_BYTES = 4 * 1024 * 1024
_MAX_REFERENCE_FILES = 20_000
_MAX_REFERENCE_ENTRIES = 100_000
_MAX_METADATA_DIRS = 10_000
_MAX_DEPTH = 32
_REPARSE_POINT = 0x400
_SKIP_REFERENCE_DIRS = frozenset({
    "source", "tree", "execution", "cache", "build", ".git", "node_modules",
    "target", "__pycache__", ".venv", "venv",
})
_SKIP_STORAGE_METADATA_DIRS = _SKIP_REFERENCE_DIRS | frozenset((
    "trusted", "artifacts", ".fullmag", "package", "packages",
))
_REFERENCE_METADATA_FILENAMES = frozenset((
    "receipt.json", "proof.json", "run-request.json", "run-result.json",
    *_CONTROLLER_REFERENCE_SCHEMAS.keys(),
    "controller-config.json", "retry-provenance.json",
))


class RuntimeReferenceError(ValueError):
    """Invalid planner input, storage root, or retention policy."""


class _PathProblem(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _is_reparse(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & _REPARSE_POINT
    )


def _canonical_storage(value: object) -> Path:
    if not isinstance(value, (str, os.PathLike)) or not Path(value).is_absolute():
        raise RuntimeReferenceError("storage must be an absolute directory")
    lexical = Path(os.path.abspath(os.fspath(value)))
    try:
        info = os.lstat(lexical)
        resolved = lexical.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise RuntimeReferenceError("storage must be a readable real directory") from error
    if _is_reparse(info) or not stat.S_ISDIR(info.st_mode):
        raise RuntimeReferenceError("storage must be a readable real directory")
    if os.path.normcase(str(lexical)) != os.path.normcase(str(resolved)):
        raise RuntimeReferenceError("storage must not traverse a symlink or junction")
    return resolved


def _valid_component(value: object) -> bool:
    return isinstance(value, str) and _ID_RE.fullmatch(value) is not None


def _safe_existing(root: Path, parts: tuple[str, ...], *, want_dir: bool | None = None) -> Path | None:
    """Walk a fixed path without following links; None means a missing path."""
    current = root
    for part in parts:
        if not isinstance(part, str) or part in ("", ".", "..") or "/" in part or "\\" in part:
            raise _PathProblem("invalid_path_component")
        current = current / part
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            return None
        except OSError as error:
            raise _PathProblem("unreadable_path") from error
        if _is_reparse(info):
            raise _PathProblem("reparse_path")
    try:
        info = os.lstat(current)
        resolved = current.resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, RuntimeError, ValueError) as error:
        raise _PathProblem("unsafe_path") from error
    if os.path.normcase(str(current)) != os.path.normcase(str(resolved)):
        raise _PathProblem("reparse_path")
    if want_dir is True and not stat.S_ISDIR(info.st_mode):
        raise _PathProblem("not_a_directory")
    if want_dir is False and not stat.S_ISREG(info.st_mode):
        raise _PathProblem("not_a_regular_file")
    return resolved


def _read_json(root: Path, path: Path) -> Mapping[str, Any]:
    try:
        info = os.lstat(path)
    except OSError as error:
        raise _PathProblem("unreadable_metadata") from error
    if _is_reparse(info):
        raise _PathProblem("reparse_metadata")
    if not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_JSON_BYTES:
        raise _PathProblem("invalid_metadata_file")
    try:
        resolved = path.resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, RuntimeError, ValueError) as error:
        raise _PathProblem("unsafe_metadata_path") from error
    if os.path.normcase(str(path)) != os.path.normcase(str(resolved)):
        raise _PathProblem("reparse_metadata")
    descriptor = -1
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = -1
            raw = stream.read(_MAX_JSON_BYTES + 1)
    except OSError as error:
        if descriptor != -1:
            try:
                os.close(descriptor)
            except OSError:
                pass
        raise _PathProblem("unreadable_metadata") from error
    if len(raw) > _MAX_JSON_BYTES:
        raise _PathProblem("oversized_metadata")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _PathProblem("invalid_json") from error
    if not isinstance(value, Mapping):
        raise _PathProblem("metadata_not_object")
    return value


def _within(path: Path, parent: Path) -> bool:
    try:
        return os.path.commonpath(
            (os.path.normcase(str(path)), os.path.normcase(str(parent)))
        ) == os.path.normcase(str(parent))
    except (OSError, ValueError):
        return False


def _path_overlap(left: Path, right: Path) -> bool:
    return _within(left, right) or _within(right, left)


def _container_mount_overlaps(source: str, candidate: Path, storage: Path) -> bool:
    mount = Path(source.strip()) if source.strip() else None
    if mount is not None and mount.is_absolute():
        try:
            mount = Path(os.path.normcase(os.path.abspath(str(mount))))
        except (OSError, ValueError):
            mount = None
        if mount is not None and _path_overlap(mount, candidate):
            return True
    # Managed Linux daemons may report their mapped host root.
    source_parts = tuple(p.casefold() for p in source.replace("\\", "/").split("/") if p)
    try:
        relative = candidate.relative_to(storage)
    except ValueError:
        relative = None
    if relative is not None:
        candidate_parts = tuple(p.casefold() for p in relative.parts)
        for index, part in enumerate(source_parts):
            if part == "runs":
                suffix = source_parts[index:]
                if len(suffix) <= len(candidate_parts) and candidate_parts[:len(suffix)] == suffix:
                    return True
                if len(candidate_parts) <= len(suffix) and suffix[:len(candidate_parts)] == candidate_parts:
                    return True
    return False


def _finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _error(scope: str, code: str, path: str | None = None) -> dict[str, str]:
    result = {"scope": scope, "code": code}
    if path is not None:
        result["path"] = path
    return result


def _named_runtime_refs(
    document: Mapping[str, Any], filename: str | None,
) -> list[tuple[str, str]] | None:
    """Apply narrow filename-specific contracts for legacy controller metadata."""
    name = filename.casefold() if isinstance(filename, str) else ""
    expected_schema = _CONTROLLER_REFERENCE_SCHEMAS.get(name)
    # Versioned controller metadata may also be archived as a standard receipt.
    # The schema still requires its job identity independently of the filename.
    if (expected_schema is None and name not in ("controller-config.json", "retry-provenance.json")
            and document.get("schema") in _CONTROLLER_REFERENCE_SCHEMAS.values()):
        expected_schema = document["schema"]
    if expected_schema is not None:
        if document.get("schema") != expected_schema:
            raise _PathProblem("unsupported_controller_metadata_schema:" + name)
        job_id = document.get("job_id")
        if not _valid_component(job_id):
            raise _PathProblem("invalid_runtime_reference:controller.job_id")
        return [(job_id, "controller.job_id")]

    if name == "controller-config.json":
        # The current producer historically writes this schema-less observer
        # config; its job_id is the coordinator job observed by the controller.
        if "schema" in document:
            raise _PathProblem("unsupported_controller_config_schema")
        job_id = document.get("job_id")
        if not _valid_component(job_id):
            raise _PathProblem("invalid_runtime_reference:controller.job_id")
        return [(job_id, "controller.job_id")]

    if name == "retry-provenance.json":
        # The bounded legacy sample is schema-less and carries a predecessor
        # and successor coordinator job. Unknown shape must block globally.
        if "schema" in document:
            raise _PathProblem("unsupported_retry_provenance_schema")
        expected_fields = {
            "predecessor_job_id", "successor_job_id", "reason", "solver_started",
        }
        if set(document) != expected_fields:
            raise _PathProblem("unsupported_retry_provenance_fields")
        predecessor = document.get("predecessor_job_id")
        successor = document.get("successor_job_id")
        if not _valid_component(predecessor):
            raise _PathProblem("invalid_runtime_reference:lineage.predecessor_job_id")
        if not _valid_component(successor):
            raise _PathProblem("invalid_runtime_reference:lineage.successor_job_id")
        reason = document.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            raise _PathProblem("invalid_retry_provenance_reason")
        if not isinstance(document.get("solver_started"), bool):
            raise _PathProblem("invalid_retry_provenance_solver_started")
        return [
            (predecessor, "lineage.predecessor_job_id"),
            (successor, "lineage.successor_job_id"),
        ]
    return None


def _doc_ref_ids(
    document: Mapping[str, Any], *, external: bool, filename: str | None = None,
) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Extract supported runtime/job IDs without treating producer receipts as consumers."""
    named_refs = _named_runtime_refs(document, filename)
    named_ref_set = set(named_refs or ())
    named_root_job_ids = {
        job_id for job_id, kind in named_ref_set if kind == "controller.job_id"
    }
    refs: list[tuple[str, str]] = []
    roots: list[tuple[str, str]] = []
    schema = document.get("schema")
    if schema in (
        BUILD_RECEIPT_SCHEMA,
        RETENTION_TOMBSTONE_SCHEMA,
        "fullmag.local-runner.coordinator.v1",
        "fullmag.runner-execution.v1",
    ):
        return refs, roots

    def add_id(raw: object, kind: str) -> None:
        if isinstance(raw, Mapping):
            raw = raw.get("job_id") or raw.get("runtime_job_id")
        if not _valid_component(raw):
            raise _PathProblem("invalid_runtime_reference:" + kind)
        refs.append((raw, kind))

    def walk(value: object, *, location: str, root_level: bool = False) -> None:
        if isinstance(value, Mapping):
            for key, child in value.items():
                key = str(key)
                if key in ("runtime_job_id", "runtime_source_job"):
                    add_id(child, key)
                elif key == "artifact_root":
                    if not isinstance(child, str) or not child.strip():
                        raise _PathProblem("invalid_artifact_root")
                    roots.append((child, location + ".artifact_root"))
                elif key == "job" and isinstance(child, Mapping):
                    if "job_id" in child:
                        add_id(child.get("job_id"), "job.job_id")
                    walk(child, location=location + ".job")
                elif key == "frontend" and isinstance(child, Mapping):
                    if "job_id" in child:
                        add_id(child.get("job_id"), "frontend.job_id")
                    walk(child, location=location + ".frontend")
                elif key == "payload" and isinstance(child, Mapping):
                    walk(child, location=location + ".payload")
                elif key in ("runtime", "runtime_metadata") and isinstance(child, Mapping):
                    if "job_id" in child:
                        add_id(child.get("job_id"), key + ".job_id")
                    walk(child, location=location + "." + key)
                elif key == "managed_job_id":
                    add_id(child, "managed_job_id")
                elif isinstance(child, (Mapping, list)):
                    walk(child, location=location + "." + key)
                elif key == "job_id" and root_level:
                    if external or schema == "fullmag.managed-package-openapi.v1" or isinstance(document.get("runtime"), Mapping):
                        add_id(child, "job_id")
        elif isinstance(value, list):
            for index, child in enumerate(value):
                if isinstance(child, (Mapping, list)):
                    walk(child, location=f"{location}[{index}]")

    walk(document, location="$", root_level=True)
    # The filename contract already records a controller's root job_id. If a
    # caller supplied this file as an external root, omit only that duplicate
    # generic root reference while retaining all nested runtime references.
    generic_refs = [
        reference for reference in refs
        if not (reference[1] == "job_id" and reference[0] in named_root_job_ids)
    ]
    return (named_refs or []) + generic_refs, roots


def _artifact_root_target(value: str, candidates: Mapping[str, dict[str, Any]], storage: Path) -> str | None:
    path = Path(value)
    if path.is_absolute():
        normalized = Path(os.path.normcase(os.path.abspath(str(path))))
        for job_id, candidate in candidates.items():
            if os.path.normcase(str(candidate["path"])) == os.path.normcase(str(normalized)):
                return job_id
        if _within(normalized, storage):
            parts = normalized.relative_to(storage).parts
            if len(parts) >= 3 and parts[0].casefold() == "runs":
                return parts[2]
        return None
    normal = value.replace("\\", "/")
    parts = tuple(part for part in normal.split("/") if part)
    if not parts or ".." in parts or not normal.endswith(
        ("artifacts/outputs/.fullmag/local", "outputs/.fullmag/local")
    ):
        raise _PathProblem("unsupported_artifact_root")
    for index, part in enumerate(parts):
        if part.casefold() == "runs" and index + 2 < len(parts):
            return parts[index + 2]
    return None


def _read_pin_state(root: Path) -> tuple[Mapping[str, Any], list[dict[str, str]]]:
    path = _safe_existing(root, ("index", "pinned-resources.json"), want_dir=None)
    if path is None:
        return {}, []
    pins = _read_json(root, path)
    errors: list[dict[str, str]] = []
    for value in pins.values():
        if isinstance(value, Mapping):
            if "pinned" in value and not isinstance(value["pinned"], bool):
                errors.append(_error("global", "invalid_pin_state", str(path)))
        elif not isinstance(value, bool):
            errors.append(_error("global", "invalid_pin_state", str(path)))
    return pins, errors


def _pin_reason(root: Path, job: Mapping[str, Any], pins: Mapping[str, Any]) -> str | None:
    worktree, job_id = job["worktree_id"], job["job_id"]
    keys = (
        f"art-{worktree}-{job_id}", f"job-{worktree}-{job_id}",
        f"exec-{worktree}-{job_id}",
        f"run-{worktree}-{job_id}", f"run-{job_id}", job_id,
    )
    for key in keys:
        value = pins.get(key)
        if value is True or (isinstance(value, Mapping) and value.get("pinned") is True):
            return "pin:" + key
    for parts in (
        ("runs", worktree, job_id, "artifacts.pin"),
        ("runs", worktree, job_id, "execution", "artifacts.pin"),
        ("runs", worktree, job_id, "artifacts", "artifacts.pin"),
    ):
        try:
            marker = _safe_existing(root, parts, want_dir=False)
        except _PathProblem as issue:
            raise _PathProblem("unsafe_pin_marker:" + issue.reason) from issue
        if marker is not None:
            return "pin_marker:" + str(marker)
    for parts in (
        ("runs", worktree, job_id, "receipt.json"),
        ("runs", worktree, job_id, "artifacts", "build-receipt.json"),
        ("runs", worktree, job_id, "artifacts", "receipt.json"),
        ("runs", worktree, job_id, "execution", "build-receipt.json"),
    ):
        try:
            receipt_path = _safe_existing(root, parts, want_dir=False)
        except _PathProblem as issue:
            raise _PathProblem("unsafe_pin_receipt:" + issue.reason) from issue
        if receipt_path is None:
            continue
        receipt = _read_json(root, receipt_path)
        if receipt.get("pinned") is True:
            return "receipt_pin:" + str(receipt_path)
        if "pinned" in receipt and not isinstance(receipt.get("pinned"), bool):
            raise _PathProblem("invalid_pin_receipt")
    return None


def _read_build_receipt(root: Path, worktree: str, job_id: str) -> tuple[Path, Mapping[str, Any]]:
    path = _safe_existing(
        root, ("runs", worktree, job_id, "artifacts", "build-receipt.json"),
        want_dir=False,
    )
    if path is None:
        raise _PathProblem("missing_build_receipt")
    return path, _read_json(root, path)


def _safe_entries(path: Path, *, scope: str, errors: list[dict[str, str]],
                  max_entries: int, counter: list[int]) -> list[Path]:
    entries: list[tuple[str, str]] = []
    try:
        with os.scandir(path) as stream:
            for entry in stream:
                counter[0] += 1
                if counter[0] > max_entries:
                    errors.append(_error("global", "metadata_entry_limit_exceeded", str(path)))
                    return []
                entries.append((entry.name, entry.path))
    except OSError:
        errors.append(_error(scope, "unreadable_directory", str(path)))
        return []
    return [Path(entry_path) for _, entry_path in sorted(entries)]


def _known_storage_documents(
    root: Path, jobs: list[dict[str, Any]], errors: list[dict[str, str]]
) -> list[tuple[Path, str, bool]]:
    """Read bounded named receipts from storage runs and build run roots.

    Reference metadata can be nested under historical/custom scientific batch
    roots, so enumerate directory names within strict limits while skipping
    known payload/source trees. Only the four documented small JSON filenames
    are opened. Parse failures are global because a consumer receipt may name a
    different runtime job from the directory that contains it.
    """
    documents: list[tuple[Path, str, bool]] = []
    entry_counter = [0]
    overflowed = False

    def add_document(path: Path) -> None:
        nonlocal overflowed
        if len(documents) >= _MAX_REFERENCE_FILES:
            errors.append(_error("global", "reference_file_limit_exceeded", str(path)))
            overflowed = True
            return
        documents.append((path, "global", False))

    def scan_metadata_tree(start: Path) -> None:
        nonlocal overflowed
        pending = [(start, 0)]
        while pending and not overflowed:
            directory, depth = pending.pop()
            if depth > _MAX_DEPTH:
                errors.append(_error("global", "metadata_depth_limit_exceeded", str(directory)))
                continue
            entries = _safe_entries(
                directory, scope="global", errors=errors,
                max_entries=_MAX_REFERENCE_ENTRIES, counter=entry_counter,
            )
            if entry_counter[0] > _MAX_REFERENCE_ENTRIES:
                overflowed = True
                return
            for child in entries:
                try:
                    info = os.lstat(child)
                except OSError:
                    errors.append(_error("global", "unreadable_metadata_entry", str(child)))
                    continue
                if _is_reparse(info):
                    errors.append(_error("global", "reparse_metadata_entry", str(child)))
                    continue
                if stat.S_ISDIR(info.st_mode):
                    if child.name.casefold() not in _SKIP_STORAGE_METADATA_DIRS:
                        pending.append((child, depth + 1))
                    continue
                if stat.S_ISREG(info.st_mode) and child.name.casefold() in _REFERENCE_METADATA_FILENAMES:
                    add_document(child)
                    if overflowed:
                        return

    try:
        runs = _safe_existing(root, ("runs",), want_dir=True)
    except _PathProblem as issue:
        errors.append(_error("global", issue.reason, str(root / "runs")))
        return documents
    if runs is None:
        errors.append(_error("global", "missing_runs_root", str(root / "runs")))
        return documents
    scan_metadata_tree(runs)

    # `run_managed_browser` writes one receipt directly beneath the selected
    # build profile's runs/<id> directory. Never recurse through build payloads.
    if overflowed:
        return documents
    try:
        builds = _safe_existing(root, ("builds",), want_dir=True)
    except _PathProblem as issue:
        errors.append(_error("global", issue.reason, str(root / "builds")))
        return documents
    if builds is None:
        return documents
    worktrees = _safe_entries(
        builds, scope="global", errors=errors,
        max_entries=_MAX_REFERENCE_ENTRIES, counter=entry_counter,
    )
    if entry_counter[0] > _MAX_REFERENCE_ENTRIES:
        return documents
    for worktree_dir in worktrees:
        try:
            worktree_info = os.lstat(worktree_dir)
        except OSError:
            errors.append(_error("global", "unreadable_build_worktree", str(worktree_dir)))
            continue
        if _is_reparse(worktree_info):
            errors.append(_error("global", "reparse_build_worktree", str(worktree_dir)))
            continue
        if not stat.S_ISDIR(worktree_info.st_mode):
            continue
        profiles = _safe_entries(
            worktree_dir, scope="global", errors=errors,
            max_entries=_MAX_REFERENCE_ENTRIES, counter=entry_counter,
        )
        if entry_counter[0] > _MAX_REFERENCE_ENTRIES:
            return documents
        for profile_dir in profiles:
            try:
                profile_info = os.lstat(profile_dir)
            except OSError:
                errors.append(_error("global", "unreadable_build_profile", str(profile_dir)))
                continue
            if _is_reparse(profile_info):
                errors.append(_error("global", "reparse_build_profile", str(profile_dir)))
                continue
            if not stat.S_ISDIR(profile_info.st_mode):
                continue
            run_parts = ("builds", worktree_dir.name, profile_dir.name, "runs")
            try:
                run_root = _safe_existing(root, run_parts, want_dir=True)
            except _PathProblem as issue:
                errors.append(_error("global", issue.reason, str(root.joinpath(*run_parts))))
                continue
            if run_root is None:
                continue
            run_dirs = _safe_entries(
                run_root, scope="global", errors=errors,
                max_entries=_MAX_REFERENCE_ENTRIES, counter=entry_counter,
            )
            if entry_counter[0] > _MAX_REFERENCE_ENTRIES:
                return documents
            for run_dir in run_dirs:
                try:
                    run_info = os.lstat(run_dir)
                except OSError:
                    errors.append(_error("global", "unreadable_managed_browser_run", str(run_dir)))
                    continue
                if _is_reparse(run_info):
                    errors.append(_error("global", "reparse_managed_browser_run", str(run_dir)))
                    continue
                if not stat.S_ISDIR(run_info.st_mode):
                    continue
                receipt = run_dir / "receipt.json"
                try:
                    found = _safe_existing(root, run_parts + (run_dir.name, "receipt.json"), want_dir=False)
                except _PathProblem as issue:
                    errors.append(_error("global", issue.reason, str(receipt)))
                    continue
                if found is not None:
                    add_document(found)
                    if overflowed:
                        return documents
    return documents

def _explicit_root_documents(
    roots: Iterable[object], candidates: Mapping[str, dict[str, Any]],
    errors: list[dict[str, str]],
) -> list[tuple[Path, str, bool]]:
    documents: list[tuple[Path, str, bool]] = []
    count, entries_seen = 0, 0
    for raw_root in roots:
        if not isinstance(raw_root, (str, os.PathLike)) or not Path(raw_root).is_absolute():
            errors.append(_error("global", "invalid_reference_root", str(raw_root)))
            continue
        requested = Path(raw_root)
        try:
            info = os.lstat(requested)
            if _is_reparse(info):
                raise _PathProblem("reparse_reference_root")
            canonical = requested.resolve(strict=True)
        except (OSError, RuntimeError, _PathProblem) as issue:
            code = issue.reason if isinstance(issue, _PathProblem) else "unreadable_reference_root"
            errors.append(_error("global", code, str(requested)))
            continue
        if stat.S_ISREG(info.st_mode):
            documents.append((canonical, "global", True))
            count += 1
            continue
        if not stat.S_ISDIR(info.st_mode) or os.path.normcase(str(requested)) != os.path.normcase(str(canonical)):
            errors.append(_error("global", "invalid_or_reparse_reference_root", str(requested)))
            continue
        pending = [(canonical, 0)]
        while pending:
            directory, depth = pending.pop()
            if depth > _MAX_DEPTH:
                errors.append(_error("global", "reference_depth_limit_exceeded", str(directory)))
                break
            contents: list[tuple[str, str]] = []
            overflow = False
            try:
                with os.scandir(directory) as stream:
                    for entry in stream:
                        entries_seen += 1
                        if entries_seen > _MAX_REFERENCE_ENTRIES:
                            overflow = True
                            break
                        contents.append((entry.name, entry.path))
            except OSError:
                errors.append(_error("global", "unreadable_reference_directory", str(directory)))
                break
            if overflow:
                errors.append(_error("global", "reference_entry_limit_exceeded", str(directory)))
                break
            for entry_name, entry_path in sorted(contents, key=lambda item: item[0], reverse=True):
                if entry_name.casefold() in _SKIP_REFERENCE_DIRS:
                    continue
                path = Path(entry_path)
                try:
                    child_info = os.lstat(path)
                except OSError:
                    errors.append(_error("global", "unreadable_reference_entry", str(path)))
                    continue
                if _is_reparse(child_info):
                    errors.append(_error("global", "reparse_reference_entry", str(path)))
                    continue
                if stat.S_ISDIR(child_info.st_mode):
                    pending.append((path, depth + 1))
                elif stat.S_ISREG(child_info.st_mode) and path.suffix.casefold() == ".json":
                    if any(_within(path, item["path"]) for item in candidates.values()):
                        continue
                    count += 1
                    if count > _MAX_REFERENCE_FILES:
                        errors.append(_error("global", "reference_file_limit_exceeded", str(path)))
                        pending.clear()
                        break
                    documents.append((path, "global", True))
    return documents
def _resolve_artifact_root(
    value: str, document_source: str, location: str,
    refs: list[dict[str, str]], candidates: Mapping[str, dict[str, Any]],
    jobs_by_id: Mapping[str, Mapping[str, Any]], storage: Path,
    errors: list[dict[str, str]], scope: str,
) -> None:
    try:
        target = _artifact_root_target(value, candidates, storage)
    except _PathProblem as issue:
        errors.append(_error(scope, issue.reason, document_source))
        return
    if target is None:
        if any(ref["source"] == document_source for ref in refs):
            return
        errors.append(_error(scope, "ambiguous_artifact_root", document_source))
        return
    if target not in jobs_by_id:
        errors.append(_error("global", "artifact_root_job_not_in_inventory", document_source))
        return
    refs.append({
        "job_id": target,
        "worktree_id": str(jobs_by_id[target].get("worktree_id", "")),
        "kind": "artifact_root",
        "source": document_source + ":" + location,
    })


def _package_manifest_identity(artifacts: object) -> str:
    if not isinstance(artifacts, list) or not artifacts:
        raise _PathProblem("build_receipt_artifacts_missing")
    package_entries = []
    for entry in artifacts:
        if not isinstance(entry, Mapping):
            raise _PathProblem("invalid_build_artifact_record")
        path = entry.get("path")
        size = entry.get("size")
        digest = entry.get("sha256")
        if (
            not isinstance(path, str)
            or path.startswith("/")
            or "\\" in path
            or ".." in path.split("/")
            or not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
            or not isinstance(digest, str)
            or not re.fullmatch(r"[a-f0-9]{64}", digest)
        ):
            raise _PathProblem("invalid_build_artifact_identity")
        if path.startswith("outputs/.fullmag/local/"):
            package_entries.append({"path": path, "size": size, "sha256": digest})
    if not package_entries:
        raise _PathProblem("build_receipt_has_no_local_package_entries")
    encoded = json.dumps(
        sorted(package_entries, key=lambda item: item["path"]),
        sort_keys=True, separators=(",", ":"), ensure_ascii=True,
    ).encode("ascii")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _metadata_sha256(root: Path, path: Path) -> str:
    try:
        info = os.lstat(path)
        resolved = path.resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, RuntimeError, ValueError) as error:
        raise _PathProblem("unsafe_metadata_path") from error
    if _is_reparse(info) or not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_JSON_BYTES:
        raise _PathProblem("invalid_build_receipt_file")
    descriptor = -1
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = -1
            raw = stream.read(_MAX_JSON_BYTES + 1)
    except OSError as error:
        if descriptor != -1:
            try:
                os.close(descriptor)
            except OSError:
                pass
        raise _PathProblem("unreadable_build_receipt") from error
    if len(raw) > _MAX_JSON_BYTES:
        raise _PathProblem("oversized_build_receipt")
    return hashlib.sha256(raw).hexdigest()


def _runtime_package_tombstone(
    root: Path, job: Mapping[str, Any], package_exists: bool,
) -> str | None:
    parts = (
        "runs", job["worktree_id"], job["job_id"],
        "artifacts", "runtime-package-retention.json",
    )
    path = _safe_existing(root, parts, want_dir=False)
    if path is None:
        return None
    tombstone = _read_json(root, path)
    receipt_path, receipt = _read_build_receipt(root, job["worktree_id"], job["job_id"])
    if job.get("exit_code") != 0 or not isinstance(job.get("source_digest"), str) or not re.fullmatch(r"[a-f0-9]{64}", job["source_digest"]):
        raise _PathProblem("tombstone_job_identity_invalid")
    expected_receipt = {
        "schema": BUILD_RECEIPT_SCHEMA,
        "job_id": job["job_id"],
        "worktree_id": job["worktree_id"],
        "profile": job.get("profile"),
        "source_digest": job.get("source_digest"),
        "state": "succeeded",
    }
    if any(receipt.get(key) != value for key, value in expected_receipt.items()
           if key != "worktree_id"):
        raise _PathProblem("tombstone_build_receipt_identity_mismatch")
    _package_manifest_identity(receipt.get("artifacts"))
    expected = {
        "schema": RETENTION_TOMBSTONE_SCHEMA,
        "job_id": job["job_id"],
        "worktree_id": job["worktree_id"],
        "source_digest": job.get("source_digest"),
        "package_relative": "outputs/.fullmag/local",
        "build_receipt_sha256": _metadata_sha256(root, receipt_path),
    }
    for key, value in expected.items():
        if tombstone.get(key) != value:
            raise _PathProblem("retention_tombstone_identity_mismatch:" + key)
    if re.fullmatch(r"plan-[a-f0-9]{8,32}", str(tombstone.get("plan_id", ""))) is None:
        raise _PathProblem("retention_tombstone_plan_id_invalid")
    state = tombstone.get("state")
    if state == "removed":
        if package_exists:
            raise _PathProblem("removed_tombstone_package_present")
        return "removed"
    if state in ("deleting", "partial_error"):
        raise _PathProblem("retention_tombstone_incomplete:" + state)
    raise _PathProblem("retention_tombstone_state_unsupported")

def plan_runtime_references(
    storage: str | os.PathLike[str],
    jobs: Iterable[Mapping[str, Any]],
    container_inspections: Iterable[Mapping[str, Any]],
    explicit_reference_roots: Iterable[str | os.PathLike[str]],
    *,
    min_artifacts_to_keep: int,
    jobs_complete: bool = False,
    containers_complete: bool = False,
    reference_roots_complete: bool = False,
    current_coordinator_id: str | None = None,
) -> dict[str, Any]:
    """Create a read-only snapshot plan for local runtime packages.

    Completeness flags are caller attestations. Without all three, the plan
    exposes no candidates. Only succeeded build jobs with matching receipts
    qualify. The latest minimum successful builds per worktree/profile remain.
    """
    root = _canonical_storage(storage)
    if (
        not isinstance(min_artifacts_to_keep, int)
        or isinstance(min_artifacts_to_keep, bool)
        or not 1 <= min_artifacts_to_keep <= 20
    ):
        raise RuntimeReferenceError("min_artifacts_to_keep must be an integer from 1 to 20")

    errors: list[dict[str, str]] = []
    references: list[dict[str, str]] = []
    unknown_scope = False

    def add_error(scope: str, code: str, path: str | None = None) -> None:
        nonlocal unknown_scope
        errors.append(_error(scope, code, path))
        if scope == "global":
            unknown_scope = True

    if jobs_complete is not True:
        add_error("global", "jobs_inventory_incomplete")
    if containers_complete is not True:
        add_error("global", "container_inventory_incomplete")
    if reference_roots_complete is not True:
        add_error("global", "reference_roots_incomplete")

    try:
        job_iter = iter(jobs)
    except TypeError as error:
        raise RuntimeReferenceError("jobs must be iterable") from error
    jobs_list: list[dict[str, Any]] = []
    jobs_by_id: dict[str, dict[str, Any]] = {}
    for sequence, record in enumerate(job_iter):
        if sequence >= 100_000:
            add_error("global", "job_inventory_limit_exceeded")
            break
        if not isinstance(record, Mapping):
            add_error("global", "invalid_job_record:" + str(sequence))
            continue
        item = dict(record)
        job_id, worktree = item.get("job_id"), item.get("worktree_id")
        if not _valid_component(job_id) or not _valid_component(worktree):
            add_error("global", "invalid_job_identity")
            continue
        item["job_id"], item["worktree_id"] = job_id, worktree
        if job_id in jobs_by_id:
            add_error("global", "duplicate_job_id:" + job_id)
            continue
        jobs_by_id[job_id] = item
        jobs_list.append(item)

    package_records: dict[str, dict[str, Any]] = {}
    blocked_job_reasons: dict[str, list[str]] = {}
    blocked_groups: set[tuple[str, str]] = set()

    def protect(job_id: str, reason: str) -> None:
        blocked_job_reasons.setdefault(job_id, []).append(reason)

    def scoped_problem(job_id: str, code: str, path: str | None = None) -> None:
        add_error("job:" + job_id, code, path)
        protect(job_id, code)

    runs = _safe_existing(root, ("runs",), want_dir=True)
    if runs is None:
        add_error("global", "missing_runs_root", str(root / "runs"))

    # Examine only exact package roots and the bounded build receipt.
    for job in jobs_list:
        job_id, worktree = job["job_id"], job["worktree_id"]
        operation, state = job.get("operation"), job.get("state")
        run_parts = ("runs", worktree, job_id)
        try:
            run_root = _safe_existing(root, run_parts, want_dir=True)
            package = _safe_existing(
                root, run_parts + ("artifacts", "outputs", ".fullmag", "local"),
                want_dir=True,
            )
        except _PathProblem as issue:
            scoped_problem(job_id, issue.reason, str(root.joinpath(*run_parts)))
            continue
        if package is None:
            if operation == "build" and state == "succeeded":
                expected_path = root.joinpath(*run_parts, "artifacts", "outputs", ".fullmag", "local")
                try:
                    tombstone_state = _runtime_package_tombstone(root, job, False)
                except _PathProblem as issue:
                    scoped_problem(job_id, issue.reason, str(root.joinpath(*run_parts, "artifacts", "runtime-package-retention.json")))
                    package_records[job_id] = {
                        "job_id": job_id, "worktree_id": worktree,
                        "profile": job.get("profile"), "path": str(expected_path),
                        "reason": "invalid_or_incomplete_tombstone",
                    }
                    continue
                if tombstone_state == "removed":
                    package_records[job_id] = {
                        "job_id": job_id, "worktree_id": worktree,
                        "profile": job.get("profile"), "path": str(expected_path),
                        "reason": "intentionally_removed",
                    }
                    continue
                scoped_problem(job_id, "missing_runtime_package", str(expected_path))
                package_records[job_id] = {
                    "job_id": job_id, "worktree_id": worktree,
                    "profile": job.get("profile"), "path": str(expected_path),
                    "reason": "missing_runtime_package",
                }
            continue
        profile = job.get("profile")
        if operation != "build":
            scoped_problem(job_id, "package_for_unsupported_operation", str(package))
            package_records[job_id] = {
                "job_id": job_id, "worktree_id": worktree, "profile": profile,
                "path": str(package), "reason": "unsupported_operation",
            }
            continue
        if not _valid_component(profile):
            add_error("global", "missing_package_profile", str(run_root or package))
            package_records[job_id] = {
                "job_id": job_id, "worktree_id": worktree,
                "profile": None, "path": str(package), "reason": "missing_profile",
            }
            continue
        if state in _ACTIVE_STATES:
            protect(job_id, "active_job:" + str(state))
            package_records[job_id] = {
                "job_id": job_id, "worktree_id": worktree, "profile": profile,
                "path": str(package), "reason": "active_job:" + str(state),
            }
            continue
        if state != "succeeded":
            package_records[job_id] = {
                "job_id": job_id, "worktree_id": worktree, "profile": profile,
                "path": str(package), "reason": "job_state:" + str(state),
            }
            continue
        try:
            _runtime_package_tombstone(root, job, True)
        except _PathProblem as issue:
            scoped_problem(job_id, issue.reason, str(root / "runs" / worktree / job_id / "artifacts" / "runtime-package-retention.json"))
            package_records[job_id] = {
                "job_id": job_id, "worktree_id": worktree, "profile": profile,
                "path": str(package), "reason": "invalid_or_incomplete_tombstone",
            }
            continue
        receipt_path = root / "runs" / worktree / job_id / "artifacts" / "build-receipt.json"
        try:
            receipt_path, receipt = _read_build_receipt(root, worktree, job_id)
            expected = {
                "schema": BUILD_RECEIPT_SCHEMA, "job_id": job_id,
                "profile": profile, "source_digest": job.get("source_digest"),
                "state": "succeeded",
            }
            if job.get("exit_code") != 0:
                raise _PathProblem("successful_job_exit_code_invalid")
            if not isinstance(job.get("source_digest"), str) or not re.fullmatch(r"[a-f0-9]{64}", job["source_digest"]):
                raise _PathProblem("invalid_job_source_digest")
            if any(receipt.get(key) != value for key, value in expected.items()):
                raise _PathProblem("build_receipt_identity_mismatch")
            if not isinstance(receipt.get("image_digest"), str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", receipt["image_digest"]):
                raise _PathProblem("invalid_build_image_digest")
            tree_identity = _package_manifest_identity(receipt.get("artifacts"))
        except _PathProblem as issue:
            scoped_problem(job_id, issue.reason, str(receipt_path))
            package_records[job_id] = {
                "job_id": job_id, "worktree_id": worktree, "profile": profile,
                "path": str(package), "reason": "invalid_build_receipt",
            }
            continue
        finished = job.get("updated_at")
        if not _finite_number(finished):
            add_error("group:" + worktree + "/" + profile, "missing_success_timestamp", str(receipt_path))
            blocked_groups.add((worktree, profile))
        package_records[job_id] = {
            "job_id": job_id, "worktree_id": worktree, "profile": profile,
            "source_digest": str(job.get("source_digest") or ""),
            "image_digest": str(receipt.get("image_digest") or ""),
            "tree_identity": tree_identity,
            "finished_at": float(finished) if _finite_number(finished) else None,
            "path": str(package), "receipt": str(receipt_path),
            "state": "succeeded", "operation": operation, "success": True,
        }
    # Detect unindexed package leaves using only the two-level runs directory
    # structure; payload below the exact package leaf remains untouched.
    runs = _safe_existing(root, ("runs",), want_dir=True)
    if runs is not None:
        entry_counter = [0]
        worktree_dirs = _safe_entries(
            runs, scope="global", errors=errors,
            max_entries=_MAX_METADATA_DIRS, counter=entry_counter,
        )
        for worktree_dir in worktree_dirs:
            try:
                info = os.lstat(worktree_dir)
            except OSError:
                add_error("global", "unreadable_worktree_directory", str(worktree_dir))
                continue
            if _is_reparse(info):
                add_error("global", "reparse_worktree_directory", str(worktree_dir))
                continue
            if not stat.S_ISDIR(info.st_mode):
                continue
            job_dirs = _safe_entries(
                worktree_dir, scope="global", errors=errors,
                max_entries=_MAX_METADATA_DIRS, counter=entry_counter,
            )
            for job_dir in job_dirs:
                try:
                    info = os.lstat(job_dir)
                except OSError:
                    add_error("global", "unreadable_run_directory", str(job_dir))
                    continue
                if _is_reparse(info):
                    add_error("global", "reparse_run_directory", str(job_dir))
                    continue
                if not stat.S_ISDIR(info.st_mode):
                    continue
                try:
                    package = _safe_existing(
                        root, ("runs", worktree_dir.name, job_dir.name,
                               "artifacts", "outputs", ".fullmag", "local"),
                        want_dir=True,
                    )
                except _PathProblem as issue:
                    add_error("global", issue.reason, str(job_dir))
                    continue
                if package is None:
                    continue
                indexed = jobs_by_id.get(job_dir.name)
                if indexed is not None and indexed.get("worktree_id") == worktree_dir.name:
                    continue
                add_error("global", "orphan_runtime_package", str(package))
                package_records["orphan:" + worktree_dir.name + "/" + job_dir.name] = {
                    "job_id": job_dir.name, "worktree_id": worktree_dir.name,
                    "profile": None, "path": str(package), "reason": "orphan_runtime_package",
                }

    # Pins are read as bounded metadata and marker paths, never by walking artifacts.
    try:
        pins, pin_errors = _read_pin_state(root)
        for issue in pin_errors:
            add_error(issue["scope"], issue["code"], issue.get("path"))
    except _PathProblem as issue:
        add_error("global", issue.reason, str(root / "index" / "pinned-resources.json"))
        pins = {}
    for job in jobs_list:
        record = package_records.get(job["job_id"])
        if record is None:
            continue
        if record.get("success") or record.get("reason", "").startswith("active_job"):
            try:
                reason = _pin_reason(root, job, pins)
            except _PathProblem as issue:
                scoped_problem(job["job_id"], issue.reason, record["path"])
                continue
            if reason:
                protect(job["job_id"], reason)
                references.append({
                    "job_id": job["job_id"], "worktree_id": job["worktree_id"],
                    "kind": "pin", "source": reason,
                })

    # Active queue payloads can identify packages used by queued/running work.
    for job in jobs_list:
        if job.get("state") not in _ACTIVE_STATES:
            continue
        payload = job.get("payload", {})
        if payload is None:
            payload = {}
        if not isinstance(payload, Mapping):
            add_error("global", "invalid_active_job_payload", "queue:" + job["job_id"])
            continue
        try:
            raw_refs, raw_roots = _doc_ref_ids({"payload": payload}, external=False)
        except _PathProblem as issue:
            add_error("global", issue.reason, "queue:" + job["job_id"])
            continue
        for target_id, kind in raw_refs:
            if target_id not in jobs_by_id:
                add_error("global", "active_job_reference_not_in_inventory:" + target_id)
                continue
            target_job = jobs_by_id[target_id]
            references.append({
                "job_id": target_id, "worktree_id": target_job["worktree_id"],
                "kind": "active." + kind, "source": "queue:" + job["job_id"],
            })
            protect(target_id, "active_reference:" + kind)
        for value, location in raw_roots:
            _resolve_artifact_root(
                value, "queue:" + job["job_id"], location, references,
                package_records, jobs_by_id, root, errors, "global",
            )

    # Consume supplied inspection results only; do not contact Docker here.
    try:
        inspections = list(container_inspections)
    except TypeError as error:
        raise RuntimeReferenceError("container_inspections must be iterable") from error
    if containers_complete is True:
        seen_container_ids: set[str] = set()
        for inspection in inspections:
            if not isinstance(inspection, Mapping):
                add_error("global", "invalid_container_inspection")
                continue
            container_id = inspection.get("Id")
            if not isinstance(container_id, str) or not _FULL_ID_RE.fullmatch(container_id):
                add_error("global", "invalid_container_id")
                continue
            if container_id in seen_container_ids:
                add_error("global", "duplicate_container_id:" + container_id)
                continue
            seen_container_ids.add(container_id)
            config = inspection.get("Config")
            labels = config.get("Labels") if isinstance(config, Mapping) else None
            is_current = (
                isinstance(current_coordinator_id, str)
                and _FULL_ID_RE.fullmatch(current_coordinator_id) is not None
                and container_id == current_coordinator_id
                and isinstance(labels, Mapping)
                and all(labels.get(key) == value for key, value in COORDINATOR_LABELS.items())
            )
            if is_current:
                continue
            mounts = inspection.get("Mounts")
            if not isinstance(mounts, list):
                add_error("global", "invalid_container_mount_inventory", container_id)
                continue
            for mount in mounts:
                if not isinstance(mount, Mapping):
                    add_error("global", "invalid_container_mount", container_id)
                    continue
                kind = mount.get("Type")
                if kind == "bind":
                    source = mount.get("Source")
                    if not isinstance(source, str) or not source:
                        add_error("global", "missing_bind_mount_source", container_id)
                        continue
                    for package_id, record in package_records.items():
                        if not record.get("success") or package_id.startswith("orphan:"):
                            continue
                        if _container_mount_overlaps(source, Path(record["path"]), root):
                            protect(package_id, "container_mount:" + container_id)
                            references.append({
                                "job_id": record["job_id"],
                                "worktree_id": record["worktree_id"],
                                "kind": "container_mount",
                                "source": container_id + ":" + source,
                            })
                elif kind not in ("volume", "tmpfs", "npipe"):
                    add_error("global", "unsupported_container_mount_type", container_id)

    # Read documented in-storage consumer metadata and caller-supplied roots.
    metadata_docs = _known_storage_documents(root, jobs_list, errors)
    try:
        extra_docs = _explicit_root_documents(explicit_reference_roots, package_records, errors)
    except TypeError as error:
        raise RuntimeReferenceError("explicit_reference_roots must be iterable") from error
    seen_paths: set[str] = set()
    for path, default_scope, external in metadata_docs + extra_docs:
        identity = os.path.normcase(str(path))
        if identity in seen_paths:
            continue
        seen_paths.add(identity)
        try:
            read_root = root if _within(path, root) else path.parent
            document = _read_json(read_root, path)
            raw_refs, raw_roots = _doc_ref_ids(
                document, external=external, filename=path.name
            )
        except _PathProblem as issue:
            errors.append(_error(default_scope, issue.reason, str(path)))
            if default_scope.startswith("job:"):
                protect(default_scope[4:], issue.reason)
            continue
        schema = document.get("schema")
        if ((raw_refs or raw_roots) and isinstance(schema, str)
                and schema.startswith("fullmag.")
                and schema not in _KNOWN_REFERENCE_SCHEMAS):
            add_error("global", "unsupported_reference_schema:" + schema, str(path))
            continue
        for target_id, kind in raw_refs:
            if target_id not in jobs_by_id:
                add_error("global", "runtime_reference_not_in_inventory:" + target_id, str(path))
                continue
            target_job = jobs_by_id[target_id]
            references.append({
                "job_id": target_id, "worktree_id": target_job["worktree_id"],
                "kind": kind, "source": str(path),
            })
            protect(target_id, "reference:" + kind)
        for value, location in raw_roots:
            scope = default_scope if default_scope.startswith("job:") else "global"
            _resolve_artifact_root(
                value, str(path), location, references, package_records,
                jobs_by_id, root, errors, scope,
            )
            if any(error.get("scope") == scope
                   and error.get("code") == "ambiguous_artifact_root"
                   and error.get("path") == str(path) for error in errors):
                if scope.startswith("job:"):
                    protect(scope[4:], "ambiguous_artifact_root")

    # Several bounded readers append errors directly; recompute global scope.
    unknown_scope = any(error.get("scope") == "global" for error in errors)
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for package_id, record in package_records.items():
        if record.get("success") and not package_id.startswith("orphan:"):
            groups.setdefault((record["worktree_id"], record["profile"]), []).append(record)
    minimum_ids: set[str] = set()
    for group, records in groups.items():
        if group in blocked_groups:
            continue
        ordered = sorted(
            records,
            key=lambda item: (item["finished_at"] is None,
                              item["finished_at"] if item["finished_at"] is not None else float("-inf"),
                              item["job_id"]),
            reverse=True,
        )
        minimum_ids.update(item["job_id"] for item in ordered[:min_artifacts_to_keep])
    candidates: list[dict[str, Any]] = []
    retained: list[dict[str, Any]] = []
    for package_id, record in sorted(package_records.items()):
        if not record.get("success") or package_id.startswith("orphan:"):
            retained.append({
                "job_id": record.get("job_id"),
                "worktree_id": record.get("worktree_id"),
                "profile": record.get("profile"),
                "package_path": record["path"],
                "path": record["path"],
                "reason": record.get("reason", "protected_or_unverified"),
            })
            continue
        group = (record["worktree_id"], record["profile"])
        scoped_block = (
            package_id in blocked_job_reasons
            or group in blocked_groups
            or any(error.get("scope") == "job:" + package_id for error in errors)
            or any(error.get("scope") == "group:" + group[0] + "/" + group[1] for error in errors)
        )
        if unknown_scope:
            reason = "global_unknown_scope"
        elif package_id in minimum_ids:
            reason = "minimum_successful_builds"
        elif blocked_job_reasons.get(package_id):
            reason = ";".join(sorted(set(blocked_job_reasons[package_id])))
        elif group in blocked_groups:
            reason = "successful_build_group_unordered"
        elif scoped_block:
            reason = "scoped_metadata_error"
        else:
            reason = None
        if reason is not None:
            retained.append({
                "job_id": package_id,
                "worktree_id": record["worktree_id"],
                "profile": record["profile"],
                "package_path": record["path"],
                "path": record["path"],
                "reason": reason,
            })
            continue
        refs_for_job = sorted(
            (ref for ref in references if ref.get("job_id") == package_id),
            key=lambda ref: (ref.get("kind", ""), ref.get("source", "")),
        )
        fingerprint_input = {
            "job_id": package_id,
            "references": refs_for_job,
            "protections": sorted(set(blocked_job_reasons.get(package_id, []))),
            "scope_errors": sorted(
                (error for error in errors
                 if error.get("scope") in (
                     "job:" + package_id,
                     "group:" + group[0] + "/" + group[1],
                 )),
                key=lambda error: json.dumps(error, sort_keys=True),
            ),
        }
        fingerprint = hashlib.sha256(json.dumps(
            fingerprint_input, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        ).encode("ascii")).hexdigest()
        candidates.append({
            "job_id": package_id,
            "worktree_id": record["worktree_id"],
            "profile": record["profile"],
            "package_path": record["path"],
            "path": record["path"],
            "source_digest": record["source_digest"],
            "tree_identity": record["tree_identity"],
            "reference_fingerprint": "sha256:" + fingerprint,
            "finished_at": record["finished_at"],
            "reason": "older_successful_unreferenced_package",
        })

    errors = sorted(
        {json.dumps(item, sort_keys=True): item for item in errors}.values(),
        key=lambda item: (item.get("scope", ""), item.get("code", ""), item.get("path", "")),
    )
    references = sorted(
        {json.dumps(item, sort_keys=True): item for item in references}.values(),
        key=lambda item: (
            item.get("worktree_id", ""), item.get("job_id", ""),
            item.get("kind", ""), item.get("source", ""),
        ),
    )
    status = "blocked" if unknown_scope else ("partial" if errors else "ready")
    return {
        "schema": PLAN_SCHEMA,
        "status": status,
        "complete": not errors and not unknown_scope,
        "unknown_scope": unknown_scope,
        "policy": {"min_artifacts_to_keep": min_artifacts_to_keep},
        "coverage": {
            "jobs_complete": jobs_complete is True,
            "containers_complete": containers_complete is True,
            "reference_roots_complete": reference_roots_complete is True,
            "package_payloads_scanned": False,
            "built_in_metadata": [
                "bounded storage/runs scans of run-request.json, run-result.json, receipt.json, proof.json",
                "bounded builds/<worktree>/<profile>/runs/<id>/receipt.json scan for managed-browser references",
                "candidate run/build receipt pinned flags",
            ],
        },
        "candidates": candidates,
        "retained": retained,
        "protected_external": [
            {"kind": "native_bundle_variants", "candidate": False, "reason": "out_of_scope"},
            {"kind": "runtime_variants", "candidate": False, "reason": "out_of_scope"},
            {"kind": "container_images", "candidate": False, "reason": "out_of_scope"},
            {"kind": "source_capsules", "candidate": False, "reason": "out_of_scope"},
            {"kind": "execution_trees", "candidate": False, "reason": "out_of_scope"},
            {"kind": "shared_build_caches", "candidate": False, "reason": "out_of_scope"},
        ],
        "references": references,
        "errors": errors,
    }
