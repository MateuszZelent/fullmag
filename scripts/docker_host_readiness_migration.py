"""Explicit, pinned operator intent for a shared host-readiness migration."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat

SCHEMA = "host_runtime_readiness_migration_request.v1"
MAXIMUM_BYTES = 64 * 1024
FIELDS = frozenset({"schema_version", "expected_host_id", "expected_inventory_sha256",
    "expected_ledger_sha256", "expected_readiness_sha256",
    "expected_previous_capabilities_sha256", "expected_next_capabilities_sha256"})


def parse_request(raw: bytes) -> dict:
    if not raw or len(raw) > MAXIMUM_BYTES:
        raise ValueError("Host readiness migration request exceeds its size bound")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate host readiness migration request field")
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=unique)
    if not isinstance(value, dict) or set(value) != FIELDS or value["schema_version"] != SCHEMA:
        raise ValueError("Unsupported host readiness migration request shape")
    host = value["expected_host_id"]
    if not isinstance(host, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", host):
        raise ValueError("Invalid expected migration host identity")
    for field in FIELDS - {"schema_version", "expected_host_id"}:
        if not isinstance(value[field], str) or not re.fullmatch(r"[0-9a-f]{64}", value[field]):
            raise ValueError("Invalid migration digest: " + field)
    if value["expected_previous_capabilities_sha256"] == value["expected_next_capabilities_sha256"]:
        raise ValueError("Capability migration must name two different digests")
    return value


def stage_request(path: Path, run) -> dict:
    """Copy exact operator bytes to this group's control volume, never a bind."""
    path = Path(path)
    if not path.is_absolute():
        raise ValueError("Migration request must use an absolute operator path")
    for parent in (*reversed(path.parents), path):
        metadata = parent.lstat()
        reparse = getattr(metadata, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        if stat.S_ISLNK(metadata.st_mode) or reparse:
            raise ValueError("Migration request must not traverse a link or junction")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                         | getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size > MAXIMUM_BYTES:
            raise ValueError("Migration request is not a bounded regular file")
        chunks = []
        size = 0
        while size <= MAXIMUM_BYTES:
            chunk = os.read(descriptor, min(16384, MAXIMUM_BYTES + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        raw = b"".join(chunks)
        if len(raw) != metadata.st_size:
            raise ValueError("Migration intent changed size during observation")
    finally:
        os.close(descriptor)
    parse_request(raw)
    document = run / "host-readiness-migration.json"
    document.write_bytes(raw)
    digest = hashlib.sha256(raw).hexdigest()
    if document.read_bytes() != raw:
        raise ValueError("Staged migration intent changed during publication")
    return {"path": "/run/fullmag/control/" + document.relative, "sha256": digest}


def migration_environment(inputs: dict, store=None) -> dict[str, str]:
    value = inputs.get("host_readiness_migration")
    if value is None:
        return {}
    control = inputs.get("build_control")
    if not isinstance(control, dict) or not isinstance(value, dict) or set(value) != {"path", "sha256"}:
        raise ValueError("Migration requires a typed volume-only control descriptor")
    relative = control.get("run_relative")
    if not isinstance(relative, str) or not re.fullmatch(r"runs/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}", relative):
        raise ValueError("Migration control run is not canonical")
    relative += "/host-readiness-migration.json"
    if value["path"] != "/run/fullmag/control/" + relative:
        raise ValueError("Migration intent is outside this control run")
    if not isinstance(value["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["sha256"]):
        raise ValueError("Migration intent has no pinned digest")
    if store is not None:
        raw = store.read_bytes(relative)
        if hashlib.sha256(raw).hexdigest() != value["sha256"]:
            raise ValueError("Stored migration intent differs from its pin")
        parse_request(raw)
    return {"FULLMAG_HOST_READINESS_MIGRATION_REQUEST": value["path"],
            "FULLMAG_HOST_READINESS_MIGRATION_REQUEST_SHA256": value["sha256"]}
