"""Archive integrity for disposable execution cleanup, never runtime admission.

Historical producer contracts are retained as evidence. This validator does not
qualify their physics, ABI, or compatibility with the current runtime profile.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from local_runner import retention, retention_persistence
from local_runner.build_executor import artifact_sha256
from local_runner.worker_entrypoint import canonical


_MAX_ARCHIVE_RECEIPT_BYTES = 4 * 1024**2
_RUNTIME_PACKAGE_PARTS = ("outputs", ".fullmag", "local")
_PLAN_ID = re.compile(r"plan-[a-f0-9]{8,32}\Z")
_SHA256 = re.compile(r"[a-f0-9]{64}\Z")


def _archive_storage_context(artifacts, job):
    """Bind archive documents to the canonical run path under storage."""
    artifacts = Path(artifacts)
    job_id = job.get("job_id")
    worktree_id = job.get("worktree_id")
    if (
        artifacts.name != "artifacts"
        or not retention._valid_component(job_id)
        or not retention._valid_component(worktree_id)
    ):
        raise ValueError("Archive artifact directory identity is invalid")
    try:
        storage = retention._canonical_storage(artifacts.parents[3])
        artifact_parts = artifacts.relative_to(storage).parts
    except (IndexError, OSError, RuntimeError, ValueError) as error:
        raise ValueError("Archive artifact directory is unsafe") from error
    expected = ("runs", worktree_id, job_id, "artifacts")
    if artifact_parts != expected:
        raise ValueError("Archive artifact directory is outside the expected run")
    try:
        retention._checked_child(storage, artifact_parts, kind="directory")
    except retention._PathIssue as error:
        raise ValueError("Archive artifact directory is unsafe: " + error.reason) from error
    return storage, artifact_parts


def _read_archive_document(storage, relative_parts, label):
    """Read and parse one small archive document from pinned regular-file bytes."""
    try:
        raw = retention_persistence._read_regular_bytes(
            storage, relative_parts, _MAX_ARCHIVE_RECEIPT_BYTES,
        )
    except retention_persistence.RetentionPersistenceError as error:
        if error.code == "part_size_exceeded":
            raise ValueError("Oversized " + label) from error
        raise ValueError("Cannot safely read " + label + ": " + error.code) from error
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Invalid " + label) from error
    if not isinstance(value, dict):
        raise ValueError("Invalid " + label)
    return raw, value


def _directory_identity(path):
    try:
        info = os.lstat(path)
    except OSError as error:
        raise ValueError("Runtime removal run root is unavailable") from error
    if (
        stat.S_ISLNK(info.st_mode)
        or bool(getattr(info, "st_file_attributes", 0) & 0x400)
        or not stat.S_ISDIR(info.st_mode)
        or info.st_dev in (None, 0)
        or info.st_ino in (None, 0)
    ):
        raise ValueError("Runtime removal run root identity is unsafe")
    return {"device": info.st_dev, "inode": info.st_ino}


def _validate_removed_runtime_package(artifacts, job, journal, receipt, receipt_bytes,
                                      package_entries, storage, artifact_parts):
    """Accept only the exact, completed runtime-package deletion receipt."""
    try:
        tombstone_path = retention._checked_child(
            artifacts, ("runtime-package-retention.json",), kind="file",
        )
    except retention._PathIssue as error:
        if error.reason == "missing_run_path":
            return False
        raise

    _tombstone_bytes, tombstone = _read_archive_document(
        storage, artifact_parts + ("runtime-package-retention.json",),
        "runtime package tombstone",
    )
    run_root = Path(artifacts).parent
    run_identity = _directory_identity(run_root)
    job_id = job.get("job_id")
    worktree_id = job.get("worktree_id")
    owner = job.get("owner")
    source_digest = job.get("source_digest")
    profile = job.get("profile")
    if (
        Path(artifacts).name != "artifacts"
        or not retention._valid_component(job_id)
        or not retention._valid_component(worktree_id)
        or run_root.name != job_id
        or run_root.parent.name != worktree_id
        or not isinstance(owner, str)
        or not owner
        or not isinstance(source_digest, str)
        or _SHA256.fullmatch(source_digest) is None
        or not isinstance(profile, str)
        or not profile
        or job.get("state") != "succeeded"
        or type(job.get("exit_code")) is not int
        or job["exit_code"] != 0
    ):
        raise ValueError("Runtime removal job identity mismatch")

    expected_journal = {
        "schema": "fullmag.local-runner.coordinator.v1",
        "job_id": job_id,
        "owner": owner,
        "source_digest": source_digest,
        "profile": profile,
        "phase": "terminal",
        "state": "succeeded",
        "exit_code": 0,
    }
    if any(journal.get(key) != value for key, value in expected_journal.items()):
        raise ValueError("Runtime removal journal identity mismatch")

    plan_id = tombstone.get("plan_id")
    if not isinstance(plan_id, str) or _PLAN_ID.fullmatch(plan_id) is None:
        raise ValueError("Runtime removal plan identity is invalid")
    expected_quarantine = run_root / (".runtime-package-quarantine-" + plan_id)
    expected_moved = expected_quarantine / "package"
    expected_tombstone = {
        "schema": "fullmag.runtime-package-retention.v1",
        "state": "removed",
        "deletion_state": "deleted",
        "job_id": job_id,
        "worktree_id": worktree_id,
        "source_digest": source_digest,
        "package_relative": "outputs/.fullmag/local",
        "build_receipt_sha256": hashlib.sha256(receipt_bytes).hexdigest(),
        "receipt": str(tombstone_path),
        "quarantine_path": str(expected_quarantine),
        "moved_path": str(expected_moved),
        "run_root_identity": run_identity,
    }
    if any(tombstone.get(key) != value for key, value in expected_tombstone.items()):
        raise ValueError("Runtime package tombstone identity mismatch")
    if os.path.lexists(expected_quarantine) or os.path.lexists(expected_moved):
        raise ValueError("Runtime package quarantine path remains present")

    quarantine_identity = tombstone.get("quarantine_identity")
    if (
        not isinstance(quarantine_identity, dict)
        or type(quarantine_identity.get("device")) is not int
        or type(quarantine_identity.get("inode")) is not int
        or quarantine_identity.get("device") != run_identity["device"]
        or quarantine_identity.get("inode", 0) <= 0
    ):
        raise ValueError("Runtime quarantine identity is incomplete")

    tree = tombstone.get("package_tree_identity")
    if not isinstance(tree, dict):
        raise ValueError("Runtime package tree identity is missing")
    for key in ("logical_bytes", "files", "links", "root_device", "root_inode"):
        if type(tree.get(key)) is not int:
            raise ValueError("Runtime package tree identity is invalid: " + key)
    if (
        tree["logical_bytes"] <= 0
        or tree["files"] <= 0
        or tree["links"] != 0
        or tree["root_device"] != run_identity["device"]
        or tree["root_inode"] <= 0
        or not isinstance(tree.get("fingerprint"), str)
        or _SHA256.fullmatch(tree["fingerprint"]) is None
        or type(tombstone.get("removed_logical_bytes")) is not int
        or tombstone["removed_logical_bytes"] != tree["logical_bytes"]
        # artifact_records() recursively records every copied runtime file;
        # this count/byte check cross-binds the tombstone census to that list.
        # Runtime retention separately hashed every listed file before removal.
        or tree["files"] != len(package_entries)
        or tree["logical_bytes"] != sum(entry["size"] for entry in package_entries)
    ):
        raise ValueError("Runtime package tree does not match its archive receipt")

    retention._checked_child(artifacts, ("outputs",), kind="directory")
    retention._checked_child(artifacts, ("outputs", ".fullmag"), kind="directory")
    try:
        retention._checked_child(artifacts, _RUNTIME_PACKAGE_PARTS, kind="directory")
    except retention._PathIssue as error:
        if error.reason != "missing_run_path":
            raise
    else:
        raise ValueError("Runtime package reappeared after removal")
    return True


def validate_archive_receipt_with_runtime_package(artifacts, job, journal):
    try:
        storage, artifact_parts = _archive_storage_context(artifacts, job)
        receipt_bytes, receipt = _read_archive_document(
            storage, artifact_parts + ("build-receipt.json",), "archive receipt",
        )
        expected = {"schema": "fullmag.local-runner.build-receipt.v1",
                    "job_id": job["job_id"], "source_digest": job["source_digest"],
                    "profile": job["profile"], "state": "succeeded",
                    "qualification": "NOT VERIFIED", "image_digest": journal["image_digest"]}
        if not isinstance(receipt, dict) or any(receipt.get(k) != v for k, v in expected.items()):
            raise ValueError("Archive receipt identity mismatch")
        native = job.get("payload", {}).get("native_source_identity")
        if (not isinstance(native, dict) or receipt.get("native_source_identity") != native
                or receipt.get("native_source_identity_sha256") != hashlib.sha256(canonical(native)).hexdigest()):
            raise ValueError("Archive native identity mismatch")
        stages = receipt.get("stages")
        if (not isinstance(stages, list) or not stages
                or any(not isinstance(s, dict) or type(s.get("exit_code")) is not int
                       or s["exit_code"] != 0 or not isinstance(s.get("name"), str)
                       or not s["name"] for s in stages)):
            raise ValueError("Archive build stages are incomplete or failed")
        entries = receipt.get("artifacts")
        if not isinstance(entries, list) or not entries:
            raise ValueError("Archive receipt has no artifacts")

        seen = set()
        package_entries = []
        normalized_entries = []
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError("Invalid archive artifact member")
            relative = entry.get("path")
            if (not isinstance(relative, str) or not relative or relative in seen
                    or "\\" in relative or ":" in relative or relative.startswith("/")
                    or any(part in ("", ".", "..") for part in relative.split("/"))
                    or type(entry.get("size")) is not int or entry["size"] < 0
                    or re.fullmatch(r"[a-f0-9]{64}", str(entry.get("sha256", ""))) is None):
                raise ValueError("Invalid archive artifact member")
            seen.add(relative)
            parts = tuple(relative.split("/"))
            if parts[:len(_RUNTIME_PACKAGE_PARTS)] == _RUNTIME_PACKAGE_PARTS and len(parts) > len(_RUNTIME_PACKAGE_PARTS):
                package_entries.append(entry)
            normalized_entries.append((relative, parts, entry))

        runtime_removed = _validate_removed_runtime_package(
            artifacts, job, journal, receipt, receipt_bytes, package_entries,
            storage, artifact_parts,
        )
        for relative, parts, entry in normalized_entries:
            try:
                artifact = retention._checked_child(artifacts, parts, kind="file")
            except retention._PathIssue as error:
                is_runtime_member = (
                    parts[:len(_RUNTIME_PACKAGE_PARTS)] == _RUNTIME_PACKAGE_PARTS
                    and len(parts) > len(_RUNTIME_PACKAGE_PARTS)
                )
                if runtime_removed and is_runtime_member and error.reason == "missing_run_path":
                    continue
                raise
            if artifact.stat().st_size != entry["size"] or artifact_sha256(artifact) != entry["sha256"]:
                raise ValueError("Archive artifact size/hash mismatch")
            if relative == "source-identity.json" and json.loads(artifact.read_text(encoding="utf-8")) != native:
                raise ValueError("Archive source identity artifact mismatch")
        retired_package = (
            Path(artifacts).joinpath(*_RUNTIME_PACKAGE_PARTS) if runtime_removed else None
        )
        return receipt, retired_package
    except retention._PathIssue as error:
        raise ValueError("Unsafe archive artifact path: " + error.reason) from error


def validate_archive_receipt(artifacts, job, journal):
    """Preserve the existing receipt API while validating all archive evidence."""
    receipt, _retired_package = validate_archive_receipt_with_runtime_package(
        artifacts, job, journal,
    )
    return receipt
