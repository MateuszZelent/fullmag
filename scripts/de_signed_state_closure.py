"""Bind raw state sidecar bytes for later frozen-input imports, not physics proof."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
from typing import Any

SCHEMA = "fullmag.signed-state-file-closure.v1"
MAX_FILES = 8192
MAX_TOTAL_BYTES = 1024**3
MAX_STATE_JSON_BYTES = 128 * 1024**2
CONTENT_SHA = re.compile(r"sha256:[0-9a-f]{64}\Z")
STATE_SCHEMAS = {
    "equilibrium_artifact.v7.json": "equilibrium_artifact.v7",
    "equilibrium_artifact.v8.json": "equilibrium_artifact.v8",
    "linearization_state.v6.json": "LinearizationState.v6",
    "linearization_state.v7.json": "LinearizationState.v7",
}


def _regular(path: Path, directory: bool) -> os.stat_result:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ValueError(f"state closure traverses a link: {path}")
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ValueError(f"state closure path is not regular: {path}")
    return info


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("state sidecar contains duplicate JSON keys")
        result[key] = value
    return result


def _nonfinite(value):
    raise ValueError(f"state sidecar contains nonfinite JSON: {value}")


def _walk_error(error):
    raise ValueError("state closure directory could not be fully enumerated") from error


def collect_signed_state_closure(case: Path) -> dict[str, Any]:
    """Collect every exported file in the state trees with bounded, strict paths.

    Native content digests are retained as declared identities; this function
    neither recomputes native serialization nor certifies the accepted state.
    All files, including producer dependencies, receive raw SHA-256 bindings.
    """
    case = Path(case)
    _regular(case, True)
    roots = [case / "eigen" / "metadata"]
    _regular(case / "eigen", True)
    _regular(roots[0], True)
    equilibrium = case / "equilibrium"
    try:
        equilibrium.lstat()
    except FileNotFoundError:
        pass
    else:
        _regular(equilibrium, True)
        roots.append(equilibrium)
    entries = []
    total = 0
    for root in roots:
        for current, directories, files in os.walk(root, followlinks=False, onerror=_walk_error):
            current = Path(current)
            _regular(current, True)
            for name in directories:
                _regular(current / name, True)
            for name in sorted(files):
                path = current / name
                info = _regular(path, False)
                total += info.st_size
                if len(entries) >= MAX_FILES or total > MAX_TOTAL_BYTES:
                    raise ValueError("state closure exceeds bounded file/byte budget")
                if name in STATE_SCHEMAS and (info.st_size == 0 or info.st_size > MAX_STATE_JSON_BYTES):
                    raise ValueError("state sidecar JSON is empty or oversized")
                digest = hashlib.sha256()
                state_bytes = bytearray() if name in STATE_SCHEMAS else None
                read_bytes = 0
                with path.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024**2), b""):
                        read_bytes += len(chunk)
                        if read_bytes > info.st_size:
                            raise ValueError("state sidecar grew during binding")
                        digest.update(chunk)
                        if state_bytes is not None:
                            state_bytes.extend(chunk)
                            if len(state_bytes) > MAX_STATE_JSON_BYTES:
                                raise ValueError("state sidecar grew beyond bounded JSON size")
                entry = {"path": path.relative_to(case).as_posix(),
                         "size": info.st_size, "sha256": digest.hexdigest()}
                if name in STATE_SCHEMAS:
                    value = json.loads(state_bytes.decode("utf-8"),
                                       object_pairs_hook=_pairs, parse_constant=_nonfinite)
                    if not isinstance(value, dict) or value.get("schema_version") != STATE_SCHEMAS[name]:
                        raise ValueError("state sidecar has an unexpected schema")
                    content = value.get("content_sha256")
                    if not isinstance(content, str) or CONTENT_SHA.fullmatch(content) is None:
                        raise ValueError("state sidecar has no native content identity")
                    entry.update(schema_version=STATE_SCHEMAS[name], native_content_sha256=content)
                after = _regular(path, False)
                if (after.st_size, after.st_mtime_ns, after.st_ino) != (info.st_size, info.st_mtime_ns, info.st_ino):
                    raise ValueError("state sidecar changed during binding")
                entries.append(entry)
    entries.sort(key=lambda entry: entry["path"])
    if not any(entry.get("schema_version", "").startswith("equilibrium_artifact.") for entry in entries):
        raise ValueError("state closure has no exported equilibrium artifact")
    canonical = json.dumps(entries, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return {"schema": SCHEMA, "status": "hash_bound_only", "files": entries,
            "file_count": len(entries), "total_bytes": total,
            "file_table_sha256": hashlib.sha256(canonical).hexdigest(),
            "producer_source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}


def bind_signed_state_closure(case: Path, artifacts: dict[str, Any]) -> None:
    """Extend the receipt only after the entire closure passed path/hash checks."""
    closure = collect_signed_state_closure(case)
    required = dict(artifacts["required_artifact_hashes"])
    for entry in closure["files"]:
        binding = {"size": entry["size"], "sha256": entry["sha256"]}
        previous = required.get(entry["path"])
        if previous is not None and previous != binding:
            raise ValueError("state closure conflicts with an existing receipt binding")
        required[entry["path"]] = binding
    artifacts["required_artifact_hashes"] = required
    artifacts["signed_state_closure"] = closure
