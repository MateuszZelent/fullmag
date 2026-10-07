"""Freeze accepted signed-fifteen campaign inputs for a later bounded probe.

This input-preparation utility does not execute Fullmag, build meshes, relax
magnetization, solve eigenmodes, or qualify physical results.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
from typing import Any, Mapping

import de_pilot_receipts
import de_signed_state_closure
import fem_linearization_identity_replay
import plot_signed_de_campaign
from comsol_mesh_identity import mesh_topology_fingerprint_v3


PILOT = "de-smoke-signed-fifteen"
PINNED_MODEL_COMMIT = "71ba0d18225ffcc83f7f18e676de8dc051e87fd1"
MANIFEST_SCHEMA = "fullmag.serial-adaptive-probe-input-manifest.v2"
MANIFEST_FILENAME = "input-manifest.json"
EXPECTED_INDICES = [3, 11, 3]
EXPECTED_PROBE_VECTORS = [[0.0, -1.0e7, 0.0], [0.0, 1.0e7, 0.0], [0.0, -1.0e7, 0.0]]
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
NATIVE_SHA = re.compile(r"sha256:[0-9a-f]{64}\Z")
MAX_STATE_FILES = 8192
MAX_STATE_BYTES = 1024**3
MAX_BUNDLE_JSON_BYTES = 128 * 1024**2


def _pairs_no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_nonfinite(value: str) -> None:
    raise ValueError(f"nonfinite JSON value: {value}")


def _parse_json(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs_no_duplicates,
                           parse_constant=_reject_nonfinite)
    except (UnicodeError, json.JSONDecodeError, ValueError) as error:
        raise ValueError(f"{label} is not strict UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def _sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    before = path.stat()
    with path.open("rb") as stream:
        size = 0
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            size += len(block)
            digest.update(block)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (
        after.st_size, after.st_mtime_ns, after.st_ino
    ) or size != after.st_size:
        raise ValueError(f"file changed while hashing: {path}")
    return digest.hexdigest()


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def _native_sha(value: object, name: str) -> str:
    if not isinstance(value, str) or NATIVE_SHA.fullmatch(value) is None:
        raise ValueError(f"{name} must be a native sha256:<hex> identity")
    return value


def _raw_sha(value: object, name: str) -> str:
    if not isinstance(value, str) or HEX64.fullmatch(value) is None:
        raise ValueError(f"{name} must be a raw-file SHA-256")
    return value


def _is_link(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _assert_no_links(path: Path, *, require_exists: bool = True) -> None:
    """Reject symlinks/reparse points in every existing component of a path."""
    absolute = Path(os.path.abspath(os.fspath(path)))
    chain = list(reversed((absolute, *absolute.parents)))
    missing = False
    for item in chain:
        try:
            info = item.lstat()
        except FileNotFoundError:
            missing = True
            if require_exists:
                raise ValueError(f"path is missing: {item}")
            continue
        except OSError as error:
            raise ValueError(f"path cannot be inspected: {item}") from error
        if _is_link(info):
            raise ValueError(f"path traverses a link or reparse point: {item}")
        if missing and require_exists:
            raise ValueError(f"path has a missing parent: {item}")
    if require_exists and not absolute.exists():
        raise ValueError(f"path is missing: {absolute}")


def _contained_path(path: Path, root: Path, label: str, *, require_exists: bool) -> Path:
    root_abs = Path(os.path.abspath(os.fspath(root)))
    path_abs = Path(os.path.abspath(os.fspath(path)))
    try:
        path_abs.relative_to(root_abs)
    except ValueError as error:
        raise ValueError(f"{label} escapes storage root") from error
    _assert_no_links(root_abs, require_exists=True)
    _assert_no_links(path_abs, require_exists=require_exists)
    if require_exists:
        try:
            path_abs.resolve(strict=True).relative_to(root_abs.resolve(strict=True))
        except (OSError, ValueError) as error:
            raise ValueError(f"{label} resolves outside storage root") from error
    else:
        if not path_abs.parent.is_dir():
            raise ValueError(f"{label} parent directory must already exist")
        try:
            path_abs.parent.resolve(strict=True).relative_to(root_abs.resolve(strict=True))
        except (OSError, ValueError) as error:
            raise ValueError(f"{label} parent resolves outside storage root") from error
    return path_abs


def _safe_relative(relative: object, label: str) -> str:
    if not isinstance(relative, str) or not relative or "\\" in relative:
        raise ValueError(f"{label} is not a normalized relative POSIX path")
    pure = PurePosixPath(relative)
    if pure.is_absolute() or pure.as_posix() != relative or any(
        part in {"", ".", ".."} for part in pure.parts
    ) or ":" in pure.parts[0]:
        raise ValueError(f"{label} escapes its storage root: {relative}")
    return relative


def _source_file(root: Path, relative: object, label: str) -> Path:
    safe = _safe_relative(relative, label)
    path = root.joinpath(*PurePosixPath(safe).parts)
    _assert_no_links(path, require_exists=True)
    if not path.is_file():
        raise ValueError(f"{label} is not a regular file: {safe}")
    try:
        path.resolve(strict=True).relative_to(root.resolve(strict=True))
    except (OSError, ValueError) as error:
        raise ValueError(f"{label} escapes its source root: {safe}") from error
    return path


def _read_strict_json(path: Path, label: str) -> tuple[dict[str, Any], bytes]:
    _assert_no_links(path, require_exists=True)
    if not path.is_file():
        raise ValueError(f"{label} is not a regular file: {path}")
    before = path.stat()
    raw = path.read_bytes()
    after = path.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (
        after.st_size, after.st_mtime_ns, after.st_ino
    ) or len(raw) != after.st_size:
        raise ValueError(f"{label} changed while being read")
    return _parse_json(raw, label), raw


def _read_file_verified(path: Path, expected_size: int, expected_sha: str,
                        label: str, *, max_bytes: int) -> bytes:
    _assert_no_links(path, require_exists=True)
    before = path.stat()
    if before.st_size != expected_size or expected_size > max_bytes:
        raise ValueError(f"{label} size differs from its manifest or exceeds the read limit")
    raw = path.read_bytes()
    after = path.stat()
    if (len(raw), _sha256_bytes(raw)) != (expected_size, expected_sha):
        raise ValueError(f"{label} hash or size mismatch")
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (
        after.st_size, after.st_mtime_ns, after.st_ino
    ):
        raise ValueError(f"{label} changed while being read")
    return raw


def _validate_result_artifact_paths(batch: Path, result: Mapping[str, Any]) -> None:
    artifacts = result.get("artifacts")
    if not isinstance(artifacts, Mapping):
        raise ValueError("run-result artifacts is missing")
    required = artifacts.get("required_artifact_hashes")
    if not isinstance(required, Mapping) or not required:
        raise ValueError("run-result required_artifact_hashes is missing")
    case = batch / PILOT
    for relative, binding in required.items():
        source = _source_file(case, relative, "run-result artifact path")
        if not isinstance(binding, Mapping):
            raise ValueError(f"run-result artifact binding is invalid: {relative}")
        _raw_sha(binding.get("sha256"), f"run-result artifact {relative} sha256")
        size = binding.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise ValueError(f"run-result artifact size is invalid: {relative}")
        if source.stat().st_size != size or _sha256_file(source) != binding["sha256"]:
            raise ValueError(f"run-result artifact hash or size mismatch: {relative}")


def _validate_closure_shape(result: Mapping[str, Any]) -> dict[str, Any]:
    artifacts = result.get("artifacts")
    if not isinstance(artifacts, Mapping):
        raise ValueError("run-result artifacts is missing")
    closure = artifacts.get("signed_state_closure")
    if not isinstance(closure, Mapping):
        raise ValueError("run-result has no receipt-bound signed_state_closure")
    if closure.get("schema") != de_signed_state_closure.SCHEMA or closure.get("status") != "hash_bound_only":
        raise ValueError("signed_state_closure schema/status is not supported")
    entries = closure.get("files")
    if not isinstance(entries, list) or not entries or len(entries) > MAX_STATE_FILES:
        raise ValueError("signed_state_closure files is empty or exceeds its bounded limit")
    if closure.get("file_count") != len(entries):
        raise ValueError("signed_state_closure file_count does not match files")
    required = artifacts.get("required_artifact_hashes")
    if not isinstance(required, Mapping):
        raise ValueError("run-result required_artifact_hashes is missing")
    seen: set[str] = set()
    previous = ""
    total_bytes = 0
    for entry in entries:
        if not isinstance(entry, Mapping):
            raise ValueError("signed_state_closure contains a non-object file entry")
        relative = _safe_relative(entry.get("path"), "closure path")
        if not relative.startswith(("eigen/metadata/", "equilibrium/")):
            raise ValueError(f"closure path is outside state export roots: {relative}")
        if relative in seen:
            raise ValueError(f"duplicate closure path: {relative}")
        if relative < previous:
            raise ValueError("signed_state_closure files are not sorted by path")
        previous = relative
        seen.add(relative)
        size = entry.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise ValueError(f"closure file size is invalid: {relative}")
        raw_sha = _raw_sha(entry.get("sha256"), f"closure file {relative} sha256")
        total_bytes += size
        binding = required.get(relative)
        if not isinstance(binding, Mapping) or binding.get("size") != size or binding.get("sha256") != raw_sha:
            raise ValueError(f"closure file is not bound by run-result required_artifact_hashes: {relative}")
    if total_bytes > MAX_STATE_BYTES or closure.get("total_bytes") != total_bytes:
        raise ValueError("signed_state_closure total_bytes is invalid or exceeds its bounded limit")
    if closure.get("file_table_sha256") != _sha256_bytes(_canonical_json(entries)):
        raise ValueError("signed_state_closure file_table_sha256 mismatch")
    _raw_sha(closure.get("producer_source_sha256"), "signed_state_closure producer_source_sha256")
    return dict(closure)


def _validate_closure_files(case: Path, claimed: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    # Enumerate the complete source closure again to catch extra files, links,
    # and incomplete trees, then compare the producer receipt's exact table.
    observed = de_signed_state_closure.collect_signed_state_closure(case)
    for key in ("schema", "status", "files", "file_count", "total_bytes", "file_table_sha256"):
        if observed.get(key) != claimed.get(key):
            raise ValueError(f"signed_state_closure differs from the complete source tree: {key}")
    by_path: dict[str, dict[str, Any]] = {}
    for entry in claimed["files"]:
        relative = entry["path"]
        source = _source_file(case, relative, "closure file")
        if source.stat().st_size != entry["size"] or _sha256_file(source) != entry["sha256"]:
            raise ValueError(f"signed_state_closure raw-file hash mismatch: {relative}")
        by_path[relative] = dict(entry)
    return by_path


def _read_closure_bytes(case: Path, path: str, entry: Mapping[str, Any], label: str) -> bytes:
    source = _source_file(case, path, label)
    before = source.stat()
    if before.st_size > de_signed_state_closure.MAX_STATE_JSON_BYTES:
        raise ValueError(f"{label} exceeds the bounded JSON read limit: {path}")
    raw = source.read_bytes()
    after = source.stat()
    expected_size = entry.get("size")
    expected_sha = _raw_sha(entry.get("sha256"), f"{label} sha256")
    if (len(raw), _sha256_bytes(raw)) != (expected_size, expected_sha):
        raise ValueError(f"{label} differs from its receipt-bound raw bytes: {path}")
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (
        after.st_size, after.st_mtime_ns, after.st_ino
    ):
        raise ValueError(f"{label} changed while being read: {path}")
    return raw


def _read_closure_json(case: Path, path: str, entry: Mapping[str, Any],
                       label: str) -> tuple[dict[str, Any], bytes]:
    raw = _read_closure_bytes(case, path, entry, label)
    return _parse_json(raw, label), raw


def _load_native_json(case: Path, path: str, entry: Mapping[str, Any], label: str) -> dict[str, Any]:
    if entry.get("schema_version") not in {
        "equilibrium_artifact.v7", "equilibrium_artifact.v8",
        "LinearizationState.v6", "LinearizationState.v7",
    }:
        raise ValueError(f"{label} closure entry has no supported native schema: {path}")
    value, _ = _read_closure_json(case, path, entry, label)
    if value.get("schema_version") != entry.get("schema_version"):
        raise ValueError(f"{label} schema differs from its closure entry: {path}")
    native = _native_sha(value.get("content_sha256"), f"{label} content_sha256")
    if entry.get("native_content_sha256") != native:
        raise ValueError(f"{label} native content identity differs from closure: {path}")
    return value


def _validate_identity_preimage(case: Path, index: int, identity: Mapping[str, Any],
                                identity_raw: bytes,
                                entries: Mapping[str, Mapping[str, Any]]) -> None:
    path = f"eigen/metadata/sample_{index:04}/linearization_identity_preimage.v1.json"
    entry = entries.get(path)
    if entry is None:
        raise ValueError(f"sample {index} has no receipt-bound linearization identity preimage")
    preimage_raw = _read_closure_bytes(case, path, entry, "linearization identity preimage")
    try:
        fem_linearization_identity_replay.replay_identity_preimage(identity_raw, preimage_raw)
    except fem_linearization_identity_replay.IdentityReplayError as error:
        raise ValueError(f"sample {index} linearization identity replay failed: {error}") from error


def _read_source_mesh_geometry(case: Path, index: int,
                               entries: Mapping[str, Mapping[str, Any]],
                               source_mesh_identity: str,
                               modal_mesh_fingerprint: str) -> dict[str, Any]:
    state_path = f"eigen/metadata/sample_{index:04}/nonshared_floquet_source_state.v1.json"
    state_entry = entries.get(state_path)
    if state_entry is None:
        raise ValueError(
            f"source_mesh_geometry_replay NOT VERIFIED: sample {index} has no receipt-bound source state"
        )
    state, _ = _read_closure_json(case, state_path, state_entry, "nonshared Floquet source state")
    if (state.get("schema_version") != "nonshared_floquet_source_state.v1" or
            isinstance(state.get("sample_index"), bool) or state.get("sample_index") != index):
        raise ValueError(f"sample {index} nonshared Floquet source-state schema/index is invalid")
    _native_sha(state.get("content_sha256"), f"sample {index} source-state content_sha256")
    mesh_state = state.get("mesh")
    if not isinstance(mesh_state, Mapping):
        raise ValueError(f"sample {index} source state has no mesh payload binding")
    declared_source = _native_sha(
        mesh_state.get("source_mesh_topology_sha256"), f"sample {index} source-state mesh identity"
    )
    declared_modal = _native_sha(
        mesh_state.get("topology_fingerprint_v3"), f"sample {index} source-state modal mesh identity"
    )
    if declared_source != source_mesh_identity:
        raise ValueError(f"sample {index} source state and linearization identity disagree on source mesh")
    if declared_modal != modal_mesh_fingerprint:
        raise ValueError(f"sample {index} source state modal mesh identity differs from the planner MeshIR")

    payload_kind = mesh_state.get("payload_kind")
    if not isinstance(payload_kind, str) or payload_kind not in {
        "producer_plan_snapshot_mesh", "producer_artifact_mesh"
    }:
        raise ValueError(
            f"source_mesh_geometry_replay NOT VERIFIED: sample {index} has no producer source MeshIR "
            f"(payload_kind={payload_kind!r})"
        )
    source_path = f"eigen/metadata/sample_{index:04}/nonshared_source/source_mesh.json"
    if mesh_state.get("payload_path") != source_path:
        raise ValueError(f"sample {index} source-state path does not name its producer source MeshIR")
    payload_entry = entries.get(source_path)
    if payload_entry is None:
        raise ValueError(
            f"source_mesh_geometry_replay NOT VERIFIED: sample {index} producer source MeshIR is not receipt-bound"
        )
    payload_raw = _read_closure_bytes(case, source_path, payload_entry, "producer source MeshIR")
    payload_sha = _native_sha(mesh_state.get("payload_sha256"), f"sample {index} source mesh payload_sha256")
    if payload_sha != "sha256:" + _sha256_bytes(payload_raw):
        raise ValueError(f"sample {index} source mesh payload differs from its source-state identity")
    source_mesh = _parse_json(payload_raw, f"sample {index} producer source MeshIR")
    if not isinstance(source_mesh.get("mesh_id"), str) or not source_mesh["mesh_id"]:
        raise ValueError(f"sample {index} producer source MeshIR has no mesh_id")
    actual_source, source_node_count = _mesh_topology_fingerprint(
        source_mesh, f"sample {index} producer source MeshIR"
    )
    if actual_source != source_mesh_identity or actual_source != declared_source:
        raise ValueError(f"sample {index} source_mesh_topology_sha256 differs from its producer source MeshIR")
    producer_node_count = mesh_state.get("producer_mesh_node_count")
    if (isinstance(producer_node_count, bool) or not isinstance(producer_node_count, int) or
            producer_node_count != source_node_count):
        raise ValueError(f"sample {index} source-state node count differs from its producer source MeshIR")
    return {
        "sample_index": index,
        "source_state_path": state_path,
        "source_path": source_path,
        "payload_kind": payload_kind,
        "raw_sha256": payload_entry["sha256"],
        "source_mesh_topology_sha256": actual_source,
        "node_count": source_node_count,
    }


def _read_probe_identities(case: Path, entries: Mapping[str, Mapping[str, Any]],
                           modal_mesh_fingerprint: str) -> tuple[dict[int, dict[str, Any]], dict[str, Any], dict[str, Any]]:
    identities: dict[int, dict[str, Any]] = {}
    source_mesh_records: list[dict[str, Any]] = []
    for index in (3, 11):
        identity_path = f"eigen/metadata/sample_{index:04}/linearization_identity.v2.json"
        if identity_path not in entries:
            raise ValueError(f"sample {index} has no receipt-bound linearization_identity.v2.json")
        identity_entry = entries[identity_path]
        identity, identity_raw = _read_closure_json(
            case, identity_path, identity_entry, "linearization identity"
        )
        if identity.get("schema_version") != "linearization_identity.v2" or identity.get("sample_index") != index:
            raise ValueError(f"sample {index} linearization identity index/schema is invalid")
        _validate_identity_preimage(case, index, identity, identity_raw, entries)

        eq_path = _safe_relative(identity.get("equilibrium_artifact_path"), f"sample {index} equilibrium path")
        eq_entry = entries.get(eq_path)
        if eq_entry is None or eq_entry.get("schema_version") not in {"equilibrium_artifact.v7", "equilibrium_artifact.v8"}:
            raise ValueError(f"sample {index} equilibrium path is not in the receipt-bound closure")
        equilibrium = _load_native_json(case, eq_path, eq_entry, "equilibrium artifact")
        native_eq = _native_sha(equilibrium.get("content_sha256"), "equilibrium artifact content_sha256")
        if identity.get("equilibrium_artifact_schema") != equilibrium.get("schema_version"):
            raise ValueError(f"sample {index} identity names another equilibrium schema")
        if identity.get("equilibrium_artifact_sha256") != native_eq or identity.get("equilibrium_content_sha256") != native_eq:
            raise ValueError(f"sample {index} identity does not bind the equilibrium native content")
        if equilibrium.get("accepted_for_linearization") is not True:
            raise ValueError(f"sample {index} equilibrium is not accepted for linearization")

        linearization_path = _safe_relative(identity.get("linearization_state_path"), f"sample {index} linearization path")
        lin_entry = entries.get(linearization_path)
        if lin_entry is None or lin_entry.get("schema_version") not in {"LinearizationState.v6", "LinearizationState.v7"}:
            raise ValueError(f"sample {index} linearization state path is not in the receipt-bound closure")
        linearization = _load_native_json(case, linearization_path, lin_entry, "linearization state")
        native_lin = _native_sha(linearization.get("content_sha256"), "linearization state content_sha256")
        if identity.get("linearization_state_schema") != linearization.get("schema_version") or identity.get("linearization_state_sha256") != native_lin:
            raise ValueError(f"sample {index} identity does not bind the linearization state")
        if linearization.get("source_equilibrium_artifact") != native_eq:
            raise ValueError(f"sample {index} linearization state refers to another equilibrium")

        source_mesh = _native_sha(identity.get("source_mesh_topology_sha256"), f"sample {index} source mesh identity")
        modal_mesh = _native_sha(identity.get("modal_mesh_topology_fingerprint_v3"), f"sample {index} modal mesh identity")
        if modal_mesh != modal_mesh_fingerprint:
            raise ValueError(f"sample {index} modal_mesh_topology_fingerprint_v3 differs from the frozen modal MeshIR")
        source_mesh_record = _read_source_mesh_geometry(
            case, index, entries, source_mesh, modal_mesh_fingerprint
        )
        source_mesh_records.append(source_mesh_record)
        count = identity.get("node_count")
        if isinstance(count, bool) or not isinstance(count, int) or count != source_mesh_record["node_count"]:
            raise ValueError(f"sample {index} identity node_count differs from the producer source MeshIR")
        identities[index] = {
            "identity_path": identity_path,
            "identity_content_sha256": _native_sha(identity.get("content_sha256"), "identity content_sha256"),
            "equilibrium_path": eq_path,
            "equilibrium_schema": equilibrium["schema_version"],
            "equilibrium_raw_sha256": eq_entry["sha256"],
            "equilibrium_content_sha256": native_eq,
            "linearization_path": linearization_path,
            "source_mesh_topology_sha256": source_mesh,
            "modal_mesh_topology_fingerprint_v3": modal_mesh,
            "node_count": count,
            "source_mesh_payload_path": source_mesh_record["source_path"],
            "source_mesh_payload_raw_sha256": source_mesh_record["raw_sha256"],
        }
    first, second = identities[3], identities[11]
    if first["equilibrium_content_sha256"] != second["equilibrium_content_sha256"]:
        raise ValueError("samples 3 and 11 do not bind the same equilibrium content")
    if first["equilibrium_schema"] != second["equilibrium_schema"]:
        raise ValueError("samples 3 and 11 do not bind the same equilibrium schema")
    if (first["source_mesh_topology_sha256"] != second["source_mesh_topology_sha256"] or
            first["modal_mesh_topology_fingerprint_v3"] != second["modal_mesh_topology_fingerprint_v3"] or
            first["node_count"] != second["node_count"]):
        raise ValueError("samples 3 and 11 do not bind the same mesh identity")
    selected = {
        "source_samples": [3, 11],
        "source_path": first["equilibrium_path"],
        "schema_version": first["equilibrium_schema"],
        "raw_sha256": first["equilibrium_raw_sha256"],
        "native_content_sha256": first["equilibrium_content_sha256"],
        "mesh_identity": {
            "source_mesh_topology_sha256": first["source_mesh_topology_sha256"],
            "modal_mesh_topology_fingerprint_v3": first["modal_mesh_topology_fingerprint_v3"],
            "node_count": first["node_count"],
        },
    }
    if (source_mesh_records[0]["source_mesh_topology_sha256"] !=
            source_mesh_records[1]["source_mesh_topology_sha256"]):
        raise ValueError("samples 3 and 11 do not bind the same source relaxation mesh identity")
    source_geometry = {
        "status": "receipt_bound_source_and_modal_topology_replayed",
        "source_samples": [3, 11],
        "source_mesh_topology_sha256": source_mesh_records[0]["source_mesh_topology_sha256"],
        "modal_mesh_topology_fingerprint_v3": modal_mesh_fingerprint,
        "source_mesh_payloads": source_mesh_records,
        "physical_source_state_replay": "not_performed",
    }
    return identities, selected, source_geometry


def _uint(value: object, bits: int, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value < (1 << bits):
        raise ValueError(f"MeshIR {label} must be an unsigned {bits}-bit integer")
    return value


def _mesh_connectivity(mesh: Mapping[str, Any], key: str,
                       arities: Mapping[str, int], *, roles: bool = False) -> tuple[int, set[int]]:
    table = mesh.get(key)
    if not isinstance(table, Mapping):
        raise ValueError(f"MeshIR {key} must be a typed connectivity object")
    types, offsets, flat_nodes = table.get("types"), table.get("offsets"), table.get("nodes")
    if not isinstance(types, list) or not types:
        raise ValueError(f"MeshIR {key}.types must be a non-empty array")
    if not isinstance(offsets, list) or len(offsets) != len(types) + 1:
        raise ValueError(f"MeshIR {key}.offsets must cover each typed element")
    if not isinstance(flat_nodes, list):
        raise ValueError(f"MeshIR {key}.nodes must be a flat connectivity array")
    for offset in offsets:
        _uint(offset, 32, f"{key}.offsets[]")
    if offsets[0] != 0 or offsets[-1] != len(flat_nodes):
        raise ValueError(f"MeshIR {key}.offsets do not span its connectivity array")
    for ordinal, (cell_type, start, end) in enumerate(zip(types, offsets, offsets[1:])):
        arity = arities.get(cell_type) if isinstance(cell_type, str) else None
        if arity is None or end <= start or end - start != arity:
            raise ValueError(f"MeshIR {key} element {ordinal} has an invalid type or offset span")
    node_count = len(mesh.get("nodes", []))
    node_ids = {_uint(value, 32, f"{key}.nodes[]") for value in flat_nodes}
    if any(value >= node_count for value in node_ids):
        raise ValueError(f"MeshIR {key} connectivity references a node outside the node array")
    ordinals = table.get("global_ordinals")
    if (not isinstance(ordinals, list) or len(ordinals) != len(types) or
            len({_uint(value, 64, f"{key}.global_ordinals[]") for value in ordinals}) != len(ordinals)):
        raise ValueError(f"MeshIR {key}.global_ordinals must uniquely cover each element")
    if key == "cells":
        parts = table.get("mesh_parts", [])
        if not isinstance(parts, list) or (parts and len(parts) != len(types)):
            raise ValueError("MeshIR cells.mesh_parts must be empty or cover each cell")
        if any(not isinstance(part, str) or part not in {"magnetic", "transition_air", "far_air"}
               for part in parts):
            raise ValueError("MeshIR cells.mesh_parts contains an unsupported part")
    if roles:
        role_values = table.get("roles")
        if (not isinstance(role_values, list) or len(role_values) != len(types) or
                any(not isinstance(role, str) or role not in {"exterior", "material_interface", "periodic_seam"}
                    for role in role_values)):
            raise ValueError("MeshIR facets.roles must identify each supported facet role")
    return len(types), node_ids


def _mesh_marker_table(value: object, label: str, valid_markers: set[int], *, required: bool) -> object:
    if value is None or value == [] or value == {}:
        if required:
            raise ValueError(f"accepted metadata has no {label} mapping")
        return None
    if isinstance(value, Mapping):
        entries = list(value.items())
    elif isinstance(value, list):
        entries = []
        for item in value:
            if isinstance(item, Mapping):
                entries.append((item.get("geometry_name"), item.get("marker")))
            elif isinstance(item, (list, tuple)) and len(item) == 2:
                entries.append((item[0], item[1]))
            else:
                raise ValueError(f"accepted metadata {label} contains an invalid entry")
    else:
        raise ValueError(f"accepted metadata {label} must be a mapping or array")
    names: set[str] = set()
    for name, marker in entries:
        if not isinstance(name, str) or not name or name in names:
            raise ValueError(f"accepted metadata {label} has an invalid or duplicate region name")
        names.add(name)
        marker_id = _uint(marker, 32, f"{label} marker")
        if marker_id not in valid_markers:
            raise ValueError(f"accepted metadata {label} references a marker absent from MeshIR")
    if required and not entries:
        raise ValueError(f"accepted metadata has no {label} mapping")
    return value


def _mesh_topology_fingerprint(mesh: Mapping[str, Any], label: str) -> tuple[str, int]:
    if not isinstance(mesh.get("nodes"), list) or not mesh["nodes"]:
        raise ValueError(f"{label} has no complete typed MeshIR nodes")
    if not isinstance(mesh.get("mesh_name"), str) or not mesh["mesh_name"]:
        raise ValueError(f"{label} has no mesh_name")
    for index, node in enumerate(mesh["nodes"]):
        try:
            valid_coordinate = (
                isinstance(node, list) and len(node) == 3 and
                all(not isinstance(value, bool) and isinstance(value, (int, float)) and
                    math.isfinite(float(value)) for value in node)
            )
        except (OverflowError, ValueError):
            valid_coordinate = False
        if not valid_coordinate:
            raise ValueError(f"{label} nodes[{index}] must be a finite three-component coordinate")
    cell_count, _ = _mesh_connectivity(
        mesh, "cells", {"tet4": 4, "prism6": 6, "pyramid5": 5, "hex8": 8}
    )
    facet_count, _ = _mesh_connectivity(mesh, "facets", {"tri3": 3, "quad4": 4}, roles=True)
    element_markers, boundary_markers = mesh.get("element_markers"), mesh.get("boundary_markers")
    if (not isinstance(element_markers, list) or len(element_markers) != cell_count or
            not isinstance(boundary_markers, list) or len(boundary_markers) != facet_count):
        raise ValueError(f"{label} element/boundary markers must cover the complete typed topology")
    for value in element_markers:
        _uint(value, 32, "element_markers[]")
    for value in boundary_markers:
        _uint(value, 32, "boundary_markers[]")
    for key in ("periodic_boundary_pairs", "periodic_node_pairs"):
        pairs = mesh.get(key, [])
        if not isinstance(pairs, list):
            raise ValueError(f"{label} {key} must be an array")
        for pair in pairs:
            if not isinstance(pair, Mapping):
                raise ValueError(f"{label} {key} contains a non-object pair")
            if key == "periodic_node_pairs":
                if not isinstance(pair.get("pair_id"), str) or not pair["pair_id"]:
                    raise ValueError(f"{label} periodic node pair has no pair_id")
                if any(_uint(pair.get(field), 32, f"periodic_node_pairs.{field}") >= len(mesh["nodes"])
                       for field in ("node_a", "node_b")):
                    raise ValueError(f"{label} periodic node pair references an unknown node")
    try:
        fingerprint = mesh_topology_fingerprint_v3(mesh)
    except (TypeError, ValueError, OverflowError, UnicodeError) as error:
        raise ValueError(f"{label} topology fingerprint failed: {error}") from error
    return fingerprint, len(mesh["nodes"])


def _source_mesh_and_markers(metadata: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    execution = metadata.get("execution_plan")
    backend = execution.get("backend_plan") if isinstance(execution, Mapping) else None
    mesh = backend.get("mesh") if isinstance(backend, Mapping) else None
    if not isinstance(mesh, Mapping):
        raise ValueError("accepted metadata has no complete execution_plan.backend_plan.mesh MeshIR")
    mesh_fingerprint, _ = _mesh_topology_fingerprint(mesh, "accepted modal MeshIR")
    element_markers = mesh["element_markers"]
    element_marker_ids = {_uint(value, 32, "element_markers[]") for value in element_markers}
    problem = metadata.get("problem_meta")
    runtime = problem.get("runtime_metadata", {}) if isinstance(problem, Mapping) else {}
    workflow = runtime.get("mesh_workflow") if isinstance(runtime, Mapping) else None
    if not isinstance(workflow, Mapping):
        workflow = {}
    report = backend.get("mesh_build_report") if isinstance(backend, Mapping) else None
    if not isinstance(report, Mapping):
        report = {}
    region = workflow.get("domain_region_markers")
    if region is None or region == [] or region == {}:
        region = report.get("region_markers", mesh.get("region_markers"))
    object_region = workflow.get("domain_object_region_markers")
    if object_region is None or object_region == [] or object_region == {}:
        object_region = report.get("object_region_markers", mesh.get("object_region_markers"))
    region = _mesh_marker_table(region, "domain region markers", element_marker_ids, required=True)
    object_region = _mesh_marker_table(
        object_region, "domain object region markers", element_marker_ids, required=False
    )
    return dict(mesh), {
        "region_markers": region,
        "object_region_markers": object_region,
        "modal_mesh_topology_fingerprint_v3": mesh_fingerprint,
    }


def _validate_source(batch: Path, storage_root: Path) -> dict[str, Any]:
    batch = _contained_path(batch, storage_root, "campaign batch", require_exists=True)
    if not batch.is_dir():
        raise ValueError("campaign batch must be a directory")
    request, request_raw = _read_strict_json(batch / "run-request.json", "run-request")
    result, result_raw = _read_strict_json(batch / "run-result.json", "run-result")
    _validate_result_artifact_paths(batch, result)
    closure = _validate_closure_shape(result)
    helper_path = Path(de_signed_state_closure.__file__)
    if closure["producer_source_sha256"] != _sha256_file(helper_path):
        raise ValueError("signed_state_closure producer source differs from the available closure validator")

    # Reuse the existing accepted-campaign gate; do not create a weaker local
    # interpretation of its receipt, row, metadata, or artifact rules.
    campaign = plot_signed_de_campaign.load_campaign(batch)
    if campaign["request"] != request or campaign["result"] != result:
        raise ValueError("strict source receipt parse differs from campaign validator output")
    if campaign["input_sha256"]["run-request.json"] != _sha256_bytes(request_raw) or campaign["input_sha256"]["run-result.json"] != _sha256_bytes(result_raw):
        raise ValueError("source run receipt changed while campaign validation was running")

    model_source = request.get("model_source")
    if not isinstance(model_source, Mapping) or model_source.get("kind") != "versioned_standalone_input":
        raise ValueError("campaign does not bind a versioned standalone model input")
    if model_source.get("commit") != PINNED_MODEL_COMMIT or model_source.get("path") != "examples/fem_de_smoke_numeric.py":
        raise ValueError("campaign model source is not the pinned signed-fifteen model commit/path")
    model_path = _source_file(batch, "model-input.py", "staged model input")
    model_before = model_path.stat()
    model_raw = model_path.read_bytes()
    model_after = model_path.stat()
    if (model_before.st_size, model_before.st_mtime_ns, model_before.st_ino) != (
        model_after.st_size, model_after.st_mtime_ns, model_after.st_ino
    ) or len(model_raw) != model_after.st_size:
        raise ValueError("staged model input changed while being read")
    model_sha = _sha256_bytes(model_raw)
    if not model_raw or len(model_raw) > 1024 * 1024:
        raise ValueError("staged model input is empty or oversized")
    if model_sha != request.get("model_sha256") or model_sha != model_source.get("sha256"):
        raise ValueError("staged model input raw hash differs from the model receipt")
    try:
        compile(model_raw, "model-input.py", "exec")
    except (SyntaxError, ValueError) as error:
        raise ValueError("staged model input is not valid Python source") from error

    case = batch / PILOT
    closure_entries = _validate_closure_files(case, closure)
    metadata, metadata_raw = _read_strict_json(case / "metadata.json", "campaign metadata")
    if _sha256_bytes(metadata_raw) != campaign["input_sha256"]["metadata.json"]:
        raise ValueError("campaign metadata changed after validation")
    mesh, markers = _source_mesh_and_markers(metadata)
    identities, selected, source_mesh_geometry = _read_probe_identities(
        case, closure_entries, markers["modal_mesh_topology_fingerprint_v3"]
    )
    model_metadata = campaign["model"]
    source_vectors = model_metadata.get("k_vectors_rad_per_m")
    if not isinstance(source_vectors, list) or len(source_vectors) != 15:
        raise ValueError("accepted campaign does not carry the complete fifteen-vector input")
    selected_vectors = [source_vectors[index] for index in (3, 11, 3)]
    if selected_vectors != EXPECTED_PROBE_VECTORS:
        raise ValueError("accepted campaign rows do not bind the required [-10,+10,-10] source vectors")
    rows = {row["sample_index"]: row for row in campaign["rows"] if row["sample_index"] in (3, 11)}
    if set(rows) != {3, 11} or any(
        [rows[index]["kx_rad_per_m"], rows[index]["ky_rad_per_m"], rows[index]["kz_rad_per_m"]] != source_vectors[index]
        for index in (3, 11)
    ):
        raise ValueError("validated dispersion rows do not agree with source sample indices 3 and 11")
    return {
        "batch": batch, "case": case, "request": request, "request_raw": request_raw,
        "result": result, "result_raw": result_raw, "model_raw": model_raw,
        "metadata": metadata, "metadata_raw": metadata_raw, "mesh": mesh, "markers": markers,
        "closure": closure, "closure_entries": closure_entries, "identities": identities,
        "selected_equilibrium": selected, "source_mesh_geometry_replay": source_mesh_geometry,
        "campaign": campaign, "source_vectors": source_vectors,
    }


def _write_copy(source: Path, destination: Path, expected_size: int, expected_sha: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    size = 0
    before = source.stat()
    with source.open("rb") as src, destination.open("xb") as dst:
        for block in iter(lambda: src.read(1024 * 1024), b""):
            size += len(block)
            digest.update(block)
            dst.write(block)
    after = source.stat()
    if (size, digest.hexdigest()) != (expected_size, expected_sha):
        raise ValueError(f"source file changed while freezing: {source}")
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise ValueError(f"source file changed while freezing: {source}")


def _write_bytes_exclusive(destination: Path, raw: bytes) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("xb") as stream:
        stream.write(raw)


def _manifest_entries(source: Mapping[str, Any]) -> tuple[list[dict[str, Any]], bytes]:
    records: list[dict[str, Any]] = []
    copies: list[tuple[Path | None, str, bytes | None, dict[str, Any]]] = []
    fixed = [
        ("request_raw", "provenance/run-request.json", "run_request", "run-request.json"),
        ("result_raw", "provenance/run-result.json", "run_result", "run-result.json"),
        ("metadata_raw", "provenance/metadata.json", "accepted_metadata", f"{PILOT}/metadata.json"),
        ("model_raw", "model-input.py", "model_source", "model-input.py"),
    ]
    for snapshot_name, destination, role, source_path in fixed:
        raw = source[snapshot_name]
        if not isinstance(raw, bytes):
            raise ValueError(f"validated source byte snapshot is missing: {source_path}")
        copies.append((None, destination, raw, {"role": role, "source_path": source_path}))
    case = source["case"]
    selected_path = source["selected_equilibrium"]["source_path"]
    for relative, entry in source["closure_entries"].items():
        source_file = _source_file(case, relative, "closure copy source")
        role = "receipt_bound_state_provenance"
        if relative == selected_path:
            role = "solver_consumed_equilibrium"
        elif str(entry.get("schema_version", "")).startswith("LinearizationState."):
            role = "reference_provenance_only"
        detail: dict[str, Any] = {"role": role, "source_path": relative}
        if "schema_version" in entry:
            detail["schema_version"] = entry["schema_version"]
        if "native_content_sha256" in entry:
            detail["native_content_sha256"] = entry["native_content_sha256"]
        copies.append((source_file, f"input/state/{relative}", None, detail))

    mesh_bytes = _canonical_json(source["mesh"])
    copies.append((None, "input/mesh-ir.json", mesh_bytes, {
        "role": "receipt_bound_complete_mesh_ir",
        "source_pointer": "execution_plan.backend_plan.mesh",
        "source_path": "provenance/metadata.json",
    }))
    for source_file, destination, raw, detail in copies:
        if raw is not None:
            size, digest = len(raw), _sha256_bytes(raw)
        else:
            assert source_file is not None
            closure_entry = source["closure_entries"][detail["source_path"]]
            size, digest = closure_entry["size"], closure_entry["sha256"]
        records.append({"bundle_path": destination, "size": size, "raw_sha256": digest, **detail})
    records.sort(key=lambda item: item["bundle_path"])
    return records, mesh_bytes


def _copy_source_files(source: Mapping[str, Any], output: Path,
                       records: list[dict[str, Any]], mesh_bytes: bytes) -> None:
    case = source["case"]
    snapshots = {
        "run-request.json": source["request_raw"],
        "run-result.json": source["result_raw"],
        f"{PILOT}/metadata.json": source["metadata_raw"],
        "model-input.py": source["model_raw"],
    }
    for record in records:
        destination = output.joinpath(*PurePosixPath(record["bundle_path"]).parts)
        if record["bundle_path"] == "input/mesh-ir.json":
            _write_bytes_exclusive(destination, mesh_bytes)
            continue
        source_name = record["source_path"]
        snapshot = snapshots.get(source_name)
        if snapshot is not None:
            if (len(snapshot), _sha256_bytes(snapshot)) != (record["size"], record["raw_sha256"]):
                raise ValueError(f"validated source snapshot differs from its manifest record: {source_name}")
            _write_bytes_exclusive(destination, snapshot)
            continue
        source_path = _source_file(case, source_name, "closure copy source")
        _write_copy(source_path, destination, record["size"], record["raw_sha256"])


def _walk_error(error: OSError) -> None:
    raise ValueError(f"bundle directory could not be fully enumerated: {error.filename}") from error


def _bundle_file_table(bundle: Path) -> dict[str, Path]:
    observed: dict[str, Path] = {}
    for current, directories, files in os.walk(bundle, followlinks=False, onerror=_walk_error):
        current_path = Path(current)
        for name in directories:
            directory = current_path / name
            info = directory.lstat()
            if _is_link(info) or not stat.S_ISDIR(info.st_mode):
                raise ValueError(f"bundle traverses a link or non-directory: {directory}")
        for name in files:
            path = current_path / name
            info = path.lstat()
            if _is_link(info) or not stat.S_ISREG(info.st_mode):
                raise ValueError(f"bundle contains a link or non-regular file: {path}")
            relative = path.relative_to(bundle).as_posix()
            if relative in observed:
                raise ValueError(f"duplicate bundle path: {relative}")
            observed[relative] = path
    return observed


def _validate_closure_in_bundle(result: Mapping[str, Any], manifest: Mapping[str, Any]) -> dict[str, Any]:
    artifacts = result.get("artifacts")
    if not isinstance(artifacts, Mapping):
        raise ValueError("bundled run-result artifacts is missing")
    receipt_closure, copied_closure = artifacts.get("signed_state_closure"), manifest.get("source_state_closure")
    if not isinstance(receipt_closure, Mapping) or not isinstance(copied_closure, Mapping) or dict(receipt_closure) != dict(copied_closure):
        raise ValueError("manifest signed-state closure differs from copied run-result")
    entries, required = receipt_closure.get("files"), artifacts.get("required_artifact_hashes")
    if not isinstance(entries, list) or not isinstance(required, Mapping):
        raise ValueError("bundled signed-state closure has no file table or receipt hash map")
    seen: set[str] = set()
    previous = ""
    total_bytes = 0
    for entry in entries:
        if not isinstance(entry, Mapping):
            raise ValueError("bundled signed-state closure has an invalid entry")
        relative = _safe_relative(entry.get("path"), "bundled closure path")
        if relative in seen:
            raise ValueError(f"duplicate bundled closure path: {relative}")
        if relative < previous:
            raise ValueError("bundled closure paths are not sorted")
        previous = relative
        seen.add(relative)
        raw_sha = _raw_sha(entry.get("sha256"), f"bundled closure {relative} sha256")
        size = entry.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise ValueError(f"bundled closure size is invalid: {relative}")
        total_bytes += size
        binding = required.get(relative)
        if not isinstance(binding, Mapping) or binding.get("sha256") != raw_sha or binding.get("size") != size:
            raise ValueError(f"bundled closure file is not receipt-bound: {relative}")
    if total_bytes > MAX_STATE_BYTES or receipt_closure.get("total_bytes") != total_bytes or receipt_closure.get("file_count") != len(entries):
        raise ValueError("bundled closure byte/file count is invalid")
    if receipt_closure.get("file_table_sha256") != _sha256_bytes(_canonical_json(entries)):
        raise ValueError("bundled closure canonical file-table hash is invalid")
    if receipt_closure.get("schema") != de_signed_state_closure.SCHEMA or receipt_closure.get("status") != "hash_bound_only":
        raise ValueError("bundled closure schema/status is unsupported")
    _raw_sha(receipt_closure.get("producer_source_sha256"), "bundled closure producer source sha256")
    return dict(receipt_closure)


def validate_bundle(bundle: str | Path, storage_root: str | Path) -> dict[str, Any]:
    """Reread and verify a frozen input bundle without accessing its source run."""
    storage = Path(os.path.abspath(os.fspath(storage_root)))
    bundle_path = _contained_path(Path(bundle), storage, "frozen input bundle", require_exists=True)
    if not bundle_path.is_dir():
        raise ValueError("frozen input bundle must be a directory")
    observed = _bundle_file_table(bundle_path)
    if MANIFEST_FILENAME not in observed:
        raise ValueError("frozen input bundle has no input-manifest.json")
    manifest, _ = _read_strict_json(observed[MANIFEST_FILENAME], "input manifest")
    if manifest.get("schema") != MANIFEST_SCHEMA or manifest.get("status") != "frozen_inputs_only":
        raise ValueError("frozen input manifest schema/status is unsupported")
    if manifest.get("copy_policy") != "byte-exact receipt-bound state closure and model; complete planner MeshIR retained":
        raise ValueError("frozen input manifest copy policy is unsupported")
    records = manifest.get("files")
    if not isinstance(records, list) or not records:
        raise ValueError("frozen input manifest files is empty or invalid")
    by_destination: dict[str, dict[str, Any]] = {}
    validated_raw: dict[str, bytes] = {}
    source_names: set[str] = set()
    previous = ""
    for record in records:
        if not isinstance(record, Mapping):
            raise ValueError("frozen input manifest has an invalid file record")
        destination = _safe_relative(record.get("bundle_path"), "bundle path")
        if destination == MANIFEST_FILENAME or destination in by_destination:
            raise ValueError(f"duplicate or reserved bundle path: {destination}")
        if destination < previous:
            raise ValueError("frozen input manifest files are not sorted by bundle_path")
        previous = destination
        raw_sha = _raw_sha(record.get("raw_sha256"), f"bundle file {destination} raw_sha256")
        size = record.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise ValueError(f"bundle file size is invalid: {destination}")
        path = _source_file(bundle_path, destination, "bundle file")
        read_limits = {
            "provenance/run-request.json": 16 * 1024**2,
            "provenance/run-result.json": 16 * 1024**2,
            "provenance/metadata.json": MAX_BUNDLE_JSON_BYTES,
            "model-input.py": 1024 * 1024,
            "input/mesh-ir.json": MAX_BUNDLE_JSON_BYTES,
        }
        if destination in read_limits:
            validated_raw[destination] = _read_file_verified(
                path, size, raw_sha, f"bundle file {destination}", max_bytes=read_limits[destination]
            )
        elif path.stat().st_size != size or _sha256_file(path) != raw_sha:
            raise ValueError(f"bundle file hash mismatch: {destination}")
        source_path = record.get("source_path")
        if source_path is not None:
            source_path = _safe_relative(source_path, "manifest source path")
            if source_path in source_names:
                raise ValueError(f"duplicate manifest source path: {source_path}")
            source_names.add(source_path)
        by_destination[destination] = dict(record)
    required_dests = {
        "provenance/run-request.json", "provenance/run-result.json", "provenance/metadata.json",
        "model-input.py", "input/mesh-ir.json",
    }
    if not required_dests.issubset(by_destination):
        raise ValueError("frozen input bundle omits required request/result/model/metadata/MeshIR files")
    expected_paths = set(by_destination) | {MANIFEST_FILENAME}
    if set(observed) != expected_paths:
        extras = sorted(set(observed) - expected_paths)
        missing = sorted(expected_paths - set(observed))
        if extras:
            raise ValueError(f"unbound bundle file: {extras[0]}")
        raise ValueError(f"frozen input bundle file is missing: {missing[0]}")

    request = _parse_json(validated_raw["provenance/run-request.json"], "bundled run-request")
    result = _parse_json(validated_raw["provenance/run-result.json"], "bundled run-result")
    try:
        de_pilot_receipts.validate_de_pilot_receipts(request, result, PILOT)
    except ValueError as error:
        raise ValueError("bundled source receipts are not an accepted completed campaign") from error
    source = manifest.get("source")
    if not isinstance(source, Mapping):
        raise ValueError("frozen input manifest source provenance is missing")
    if source.get("pilot") != PILOT:
        raise ValueError("frozen input manifest names a different campaign")
    source_batch_relative = _safe_relative(source.get("batch_relative_to_storage"), "source batch path")
    storage_abs = Path(os.path.abspath(os.fspath(storage)))
    request_output = request.get("output_dir")
    if not isinstance(request_output, str):
        raise ValueError("bundled request has no output_dir provenance")
    expected_batch = Path(os.path.abspath(storage_abs / Path(*PurePosixPath(source_batch_relative).parts)))
    if os.path.normcase(os.path.abspath(request_output)) != os.path.normcase(os.fspath(expected_batch)):
        raise ValueError("bundled request output_dir differs from source batch provenance")

    model_source = request.get("model_source")
    if (not isinstance(model_source, Mapping) or model_source.get("commit") != PINNED_MODEL_COMMIT or
            model_source.get("path") != "examples/fem_de_smoke_numeric.py"):
        raise ValueError("bundled source model is not the pinned model identity")
    if source.get("model_source") != dict(model_source):
        raise ValueError("manifest model source provenance differs from copied run-request")
    model_raw = validated_raw["model-input.py"]
    if not model_raw or len(model_raw) > 1024 * 1024:
        raise ValueError("bundled model input is empty or oversized")
    model_sha = _sha256_bytes(model_raw)
    if model_sha != request.get("model_sha256") or model_sha != model_source.get("sha256"):
        raise ValueError("bundled model input does not match source receipt hash")
    try:
        compile(model_raw, "model-input.py", "exec")
    except (SyntaxError, ValueError) as error:
        raise ValueError("bundled model input is not valid Python source") from error

    metadata = _parse_json(validated_raw["provenance/metadata.json"], "bundled source metadata")
    validated_parameters, frequency_window, _ = plot_signed_de_campaign._validate_model_metadata(request, metadata)
    policy = plot_signed_de_campaign._validate_campaign_policy(request, result, metadata)
    numerical = manifest.get("numerical_settings")
    model_metadata = numerical.get("model_metadata") if isinstance(numerical, Mapping) else None
    problem = metadata.get("problem_meta")
    runtime = problem.get("runtime_metadata", {}) if isinstance(problem, Mapping) else {}
    if not isinstance(model_metadata, Mapping) or dict(model_metadata) != runtime.get("de_smoke"):
        raise ValueError("manifest numerical settings differ from accepted model metadata")
    if numerical.get("validated_parameters") != validated_parameters:
        raise ValueError("manifest physical parameters differ from accepted campaign metadata")
    if numerical.get("frequency_window_hz") != frequency_window:
        raise ValueError("manifest frequency window differs from accepted campaign metadata")
    mesh, markers = _source_mesh_and_markers(metadata)
    mesh_copy = _parse_json(validated_raw["input/mesh-ir.json"], "bundled planner MeshIR")
    if mesh_copy != mesh:
        raise ValueError("bundled MeshIR differs from receipt-bound execution_plan.backend_plan.mesh")
    mesh_record = manifest.get("mesh")
    if not isinstance(mesh_record, Mapping) or mesh_record.get("region_markers") != markers["region_markers"] or mesh_record.get("object_region_markers") != markers["object_region_markers"]:
        raise ValueError("bundle marker mappings differ from accepted runtime mesh metadata")
    metadata_record = by_destination["provenance/metadata.json"]
    if (mesh_record.get("raw_sha256") != by_destination["input/mesh-ir.json"]["raw_sha256"] or
            mesh_record.get("node_count") != len(mesh["nodes"]) or
            mesh_record.get("source_pointer") != "execution_plan.backend_plan.mesh" or
            mesh_record.get("source_metadata_raw_sha256") != metadata_record["raw_sha256"] or
            mesh_record.get("modal_mesh_topology_fingerprint_v3") != markers["modal_mesh_topology_fingerprint_v3"]):
        raise ValueError("bundle mesh summary differs from copied MeshIR")

    artifacts = result.get("artifacts")
    if not isinstance(artifacts, Mapping):
        raise ValueError("bundled run-result has no artifacts")
    required = artifacts.get("required_artifact_hashes")
    if not isinstance(required, Mapping) or manifest.get("source_artifact_hashes") != dict(required):
        raise ValueError("manifest source artifact hashes differ from copied run-result")
    closure = _validate_closure_in_bundle(result, manifest)
    expected_state_paths = {f"input/state/{entry['path']}" for entry in closure["files"]}
    expected_bundle_paths = expected_state_paths | {
        "provenance/run-request.json", "provenance/run-result.json", "provenance/metadata.json",
        "model-input.py", "input/mesh-ir.json",
    }
    if set(by_destination) != expected_bundle_paths:
        raise ValueError("bundle manifest contains an unbound or missing state/input dependency")
    metadata_binding = required.get("metadata.json")
    if (not isinstance(metadata_binding, Mapping) or metadata_binding.get("sha256") != metadata_record["raw_sha256"] or
            metadata_binding.get("size") != metadata_record["size"]):
        raise ValueError("copied metadata is not bound by the source run-result")
    copied_entries = {
        record.get("source_path"): record for record in records
        if isinstance(record.get("source_path"), str) and record["source_path"].startswith(("eigen/metadata/", "equilibrium/"))
    }
    if len(copied_entries) != len(closure["files"]):
        raise ValueError("bundle does not preserve the complete receipt-bound state closure")
    for entry in closure["files"]:
        relative = entry["path"]
        record = copied_entries.get(relative)
        if (record is None or record.get("bundle_path") != f"input/state/{relative}" or
                record.get("raw_sha256") != entry["sha256"] or record.get("size") != entry["size"]):
            raise ValueError(f"bundle state closure copy differs from receipt: {relative}")
        if record.get("schema_version") != entry.get("schema_version") or record.get("native_content_sha256") != entry.get("native_content_sha256"):
            raise ValueError(f"bundle state native identity differs from receipt: {relative}")

    closure_root = bundle_path / "input" / "state"
    closure_entries = {entry["path"]: entry for entry in closure["files"]}
    identities, selected, source_mesh_geometry = _read_probe_identities(
        closure_root, closure_entries, markers["modal_mesh_topology_fingerprint_v3"]
    )
    selected["bundle_path"] = f"input/state/{selected['source_path']}"
    if manifest.get("selected_equilibrium") != selected:
        raise ValueError("manifest selected equilibrium differs from samples 3 and 11 native identities")
    if manifest.get("source_mesh_geometry_replay") != source_mesh_geometry:
        raise ValueError("manifest source/modal mesh geometry replay differs from receipt-bound source payloads")
    if mesh_record.get("source_mesh_topology_sha256") != source_mesh_geometry["source_mesh_topology_sha256"]:
        raise ValueError("bundle source mesh summary differs from receipt-bound producer source MeshIR")
    if mesh_record.get("mesh_identity") != selected["mesh_identity"]:
        raise ValueError("manifest mesh identity differs from the samples 3 and 11 equilibrium identity")
    if manifest.get("identities") != {str(index): value for index, value in identities.items()}:
        raise ValueError("manifest sample identities differ from receipt-bound identity sidecars")
    selected_record = by_destination.get(selected["bundle_path"])
    if not isinstance(selected_record, Mapping) or selected_record.get("role") != "solver_consumed_equilibrium":
        raise ValueError("the selected native equilibrium is not marked as the sole solver input")
    probe = manifest.get("probe")
    vectors = model_metadata.get("k_vectors_rad_per_m")
    expected_source_vectors = [vectors[index] for index in EXPECTED_INDICES] if isinstance(vectors, list) else None
    if (not isinstance(probe, Mapping) or probe.get("source_sample_indices") != EXPECTED_INDICES or
            probe.get("source_k_vectors_rad_per_m") != expected_source_vectors or
            probe.get("k_vectors_rad_per_m") != EXPECTED_PROBE_VECTORS or expected_source_vectors != EXPECTED_PROBE_VECTORS):
        raise ValueError("manifest probe indices/vectors differ from the accepted signed-fifteen model")
    if manifest.get("parallel_campaign") != policy:
        raise ValueError("manifest parallel campaign policy differs from accepted metadata")
    validation_scope = manifest.get("validation_scope")
    if (not isinstance(validation_scope, Mapping) or
            validation_scope.get("accepted_campaign_validator") != "plot_signed_de_campaign.load_campaign" or
            not isinstance(validation_scope.get("row_validation"), Mapping) or
            validation_scope["row_validation"].get("status") != "pass" or
            validation_scope.get("scientific_qualification") != "not_claimed" or
            validation_scope.get("solver_execution") != "not_performed"):
        raise ValueError("manifest validation scope makes an unsupported runtime/science claim")
    return dict(manifest)


def freeze_inputs(batch: str | Path, output: str | Path, storage_root: str | Path) -> dict[str, Any]:
    """Validate one accepted campaign and freeze its exact state and mesh inputs."""
    storage = Path(os.path.abspath(os.fspath(storage_root)))
    _assert_no_links(storage, require_exists=True)
    if not storage.is_dir():
        raise ValueError("storage_root must be an existing regular directory")
    batch_path = _contained_path(Path(batch), storage, "campaign batch", require_exists=True)
    output_path = _contained_path(Path(output), storage, "bundle output", require_exists=False)
    if output_path.exists():
        raise ValueError(f"bundle output already exists: {output_path}")
    if output_path == batch_path or output_path.is_relative_to(batch_path) or batch_path.is_relative_to(output_path):
        raise ValueError("bundle output and campaign batch must be disjoint")

    source = _validate_source(batch_path, storage)
    request, result = source["request"], source["result"]
    source_relative = batch_path.relative_to(storage).as_posix()
    records, mesh_bytes = _manifest_entries(source)
    selected = dict(source["selected_equilibrium"])
    selected["bundle_path"] = f"input/state/{selected['source_path']}"
    probe = {
        "source_sample_indices": list(EXPECTED_INDICES),
        "source_k_vectors_rad_per_m": [source["source_vectors"][index] for index in EXPECTED_INDICES],
        "k_vectors_rad_per_m": [list(vector) for vector in EXPECTED_PROBE_VECTORS],
    }
    metadata_hash = _sha256_bytes(source["metadata_raw"])
    mesh_record = {
        "bundle_path": "input/mesh-ir.json",
        "source_pointer": "execution_plan.backend_plan.mesh",
        "raw_sha256": _sha256_bytes(mesh_bytes),
        "size": len(mesh_bytes),
        "node_count": len(source["mesh"]["nodes"]),
        "region_markers": source["markers"]["region_markers"],
        "object_region_markers": source["markers"]["object_region_markers"],
        "source_metadata_raw_sha256": metadata_hash,
        "source_mesh_topology_sha256": source["source_mesh_geometry_replay"]["source_mesh_topology_sha256"],
        "modal_mesh_topology_fingerprint_v3": source["markers"]["modal_mesh_topology_fingerprint_v3"],
        "mesh_identity": selected["mesh_identity"],
    }
    manifest: dict[str, Any] = {
        "schema": MANIFEST_SCHEMA,
        "status": "frozen_inputs_only",
        "copy_policy": "byte-exact receipt-bound state closure and model; complete planner MeshIR retained",
        "source": {
            "pilot": PILOT,
            "batch_relative_to_storage": source_relative,
            "model_source": dict(request["model_source"]),
            "run_request_bundle_path": "provenance/run-request.json",
            "run_result_bundle_path": "provenance/run-result.json",
            "metadata_bundle_path": "provenance/metadata.json",
        },
        "source_artifact_hashes": dict(result["artifacts"]["required_artifact_hashes"]),
        "source_state_closure": source["closure"],
        "files": records,
        "selected_equilibrium": selected,
        "source_mesh_geometry_replay": source["source_mesh_geometry_replay"],
        "identities": {str(index): value for index, value in source["identities"].items()},
        "mesh": mesh_record,
        "numerical_settings": {
            "model_metadata": source["campaign"]["model"],
            "validated_parameters": source["campaign"]["parameters"],
            "frequency_window_hz": source["campaign"]["frequency_window_hz"],
        },
        "parallel_campaign": source["campaign"]["parallel_campaign"],
        "probe": probe,
        "validation_scope": {
            "accepted_campaign_validator": "plot_signed_de_campaign.load_campaign",
            "row_validation": source["campaign"]["row_report"],
            "scientific_qualification": "not_claimed",
            "solver_execution": "not_performed",
        },
    }

    # Exclusive directory creation is the no-overwrite boundary. On a later
    # write failure the partial directory is retained, never removed/reused.
    try:
        output_path.mkdir()
    except FileExistsError as error:
        raise ValueError(f"bundle output already exists: {output_path}") from error
    _copy_source_files(source, output_path, records, mesh_bytes)
    raw_manifest = json.dumps(manifest, sort_keys=True, indent=2, ensure_ascii=False,
                              allow_nan=False).encode("utf-8") + b"\n"
    _write_bytes_exclusive(output_path / MANIFEST_FILENAME, raw_manifest)
    return validate_bundle(output_path, storage)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("batch", type=Path, help="accepted signed-fifteen managed batch")
    parser.add_argument("output", type=Path, help="new bundle directory inside storage")
    parser.add_argument("--storage-root", required=True, type=Path, help="configured managed storage root")
    args = parser.parse_args(argv)
    try:
        manifest = freeze_inputs(args.batch, args.output, args.storage_root)
    except (OSError, ValueError) as error:
        print(f"freeze rejected: {error}", file=sys.stderr)
        return 2
    print(json.dumps({
        "status": manifest["status"],
        "schema": manifest["schema"],
        "bundle": str(Path(args.output).resolve()),
        "selected_equilibrium_content_sha256": manifest["selected_equilibrium"]["native_content_sha256"],
        "solver_execution": "not performed",
        "scientific_qualification": "not claimed",
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
