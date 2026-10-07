"""Replay the exact-byte digest of linearization_identity.v2.

This verifies identity/preimage binding, not the contents of linked mesh,
magnetization, field or material artifacts. Those require separate replay.
Never reconstruct serde_json bytes by serializing a Python dictionary.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import struct
from typing import Any


IDENTITY_SCHEMA = "linearization_identity.v2"
PREIMAGE_SCHEMA = "linearization_identity_preimage.v1"
IDENTITY_FIELDS = frozenset("""
schema_version sample_index equilibrium_artifact_schema linearization_state_schema
accepted_fields_schema certified_fields_schema recomputed_certificate_schema
handoff_schema_version handoff_content_sha256 source_run_id source_stage_id
source_stage_kind producer_plan_snapshot_sha256 consumer_plan_snapshot_sha256
producer_build_identity consumer_build_identity producer_source_snapshot_sha256
consumer_source_snapshot_sha256 cross_build_policy source_mesh_topology_sha256
modal_mesh_topology_fingerprint_v3 node_count equilibrium_content_sha256
equilibrium_artifact_path equilibrium_artifact_sha256 linearization_state_path
linearization_state_sha256 equilibrium_material_signature
equilibrium_material_preimage_json equilibrium_static_physics_signature
equilibrium_static_physics_preimage_json equilibrium_boundary_signature
equilibrium_boundary_preimage_json material_signature material_identity_kind
material_provenance_signature material_provenance_scope material_provenance_preimage_json
producer_material_provenance_signature producer_material_provenance_preimage_json
accepted_fields_content_sha256 accepted_fields_path certified_fields_content_sha256
certified_fields_path recomputed_certificate_content_sha256 recomputed_certificate_path
accepted_fields_bytes_sha256 certified_fields_bytes_sha256 recomputed_certificate_bytes_sha256
recomputed_certificate_preimage_json recomputed_certificate_preimage_sha256 content_sha256
""".split())
PREIMAGE_FIELDS = frozenset({
    "schema_version", "identity_schema", "identity_preimage_json",
    "identity_preimage_sha256", "identity_content_sha256",
})
_RAW_SOURCE_SNAPSHOT_RE = re.compile(r"[0-9a-f]{64}\Z")


class IdentityReplayError(ValueError):
    """The inspected identity does not bind to its exact hash preimage."""


def strict_json_object(raw: bytes, label: str) -> dict[str, Any]:
    """Decode JSON without duplicate keys, non-finite numbers or coercions."""
    if type(raw) is not bytes:
        raise IdentityReplayError(f"{label}: expected exact bytes")
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise IdentityReplayError(f"{label}: duplicate key {key}")
            result[key] = value
        return result

    def nonfinite(token: str) -> None:
        raise IdentityReplayError(f"{label}: non-JSON number {token}")

    try:
        result = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                            parse_constant=nonfinite)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise IdentityReplayError(f"{label}: invalid UTF-8 JSON") from error
    if type(result) is not dict:
        raise IdentityReplayError(f"{label}: expected object")
    _validate_json_values(result, label)
    return result


def _validate_json_values(value: Any, label: str, depth: int = 0) -> None:
    # JSON's escaped lone surrogates are accepted by Python but rejected by
    # serde_json strings. Exponent overflow (1e999) also bypasses parse_constant.
    if depth > 128:
        raise IdentityReplayError(f"{label}: JSON nesting limit exceeded")
    if type(value) is str:
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise IdentityReplayError(f"{label}: invalid Unicode string") from error
    elif type(value) is float and not math.isfinite(value):
        raise IdentityReplayError(f"{label}: non-finite number")
    elif type(value) is dict:
        for key, item in value.items():
            _validate_json_values(key, label)
            _validate_json_values(item, f"{label}.{key}", depth + 1)
    elif type(value) is list:
        for index, item in enumerate(value):
            _validate_json_values(item, f"{label}[{index}]", depth + 1)


def _same_typed_json(left: Any, right: Any, label: str) -> None:
    if type(left) is not type(right):
        raise IdentityReplayError(f"{label}: JSON type mismatch")
    if type(left) is dict:
        if left.keys() != right.keys():
            raise IdentityReplayError(f"{label}: field set mismatch")
        for key in left:
            _same_typed_json(left[key], right[key], f"{label}.{key}")
    elif type(left) is list:
        if len(left) != len(right):
            raise IdentityReplayError(f"{label}: array length mismatch")
        for index, (a, b) in enumerate(zip(left, right)):
            _same_typed_json(a, b, f"{label}[{index}]")
    else:
        if type(left) is float and (not math.isfinite(left) or not math.isfinite(right)):
            raise IdentityReplayError(f"{label}: non-finite number")
        if left != right:
            raise IdentityReplayError(f"{label}: value mismatch")


def _digest(value: Any, label: str) -> str:
    if type(value) is not str or re.fullmatch(r"sha256:[0-9a-f]{64}", value) is None:
        raise IdentityReplayError(f"{label}: expected sha256 digest")
    return value


def _source_snapshot(value: Any, label: str) -> str:
    """Validate native build-info's raw lowercase SHA-256 spelling."""
    if type(value) is not str or _RAW_SOURCE_SNAPSHOT_RE.fullmatch(value) is None:
        raise IdentityReplayError(
            f"{label}: expected 64 lowercase hexadecimal characters without sha256: prefix"
        )
    return value


def replay_identity_preimage(identity_bytes: bytes, sidecar_bytes: bytes) -> str:
    """Verify exact identity bytes and return their declared framed digest.

    This is deliberately a digest gate only. A return value does not certify
    the linked physical state, source build, solver residual or convergence.
    """
    identity = strict_json_object(identity_bytes, "identity")
    sidecar = strict_json_object(sidecar_bytes, "preimage sidecar")
    if identity.keys() != IDENTITY_FIELDS or sidecar.keys() != PREIMAGE_FIELDS:
        raise IdentityReplayError("identity/preimage: unknown or missing fields")
    if identity["schema_version"] != IDENTITY_SCHEMA:
        raise IdentityReplayError("identity: unsupported schema")
    if sidecar["schema_version"] != PREIMAGE_SCHEMA or sidecar["identity_schema"] != IDENTITY_SCHEMA:
        raise IdentityReplayError("preimage sidecar: unsupported schema")
    for key in IDENTITY_FIELDS:
        value = identity[key]
        if key in {"sample_index", "node_count"}:
            if (type(value) is not int or value < (1 if key == "node_count" else 0)
                    or value > (1 << 64) - 1):
                raise IdentityReplayError(f"identity.{key}: invalid integer")
        elif key in {"producer_build_identity", "consumer_build_identity"}:
            if type(value) is not dict:
                raise IdentityReplayError(f"identity.{key}: expected object")
            _source_snapshot(
                value.get("source_snapshot_sha256"),
                f"identity.{key}.source_snapshot_sha256",
            )
        elif key in {
            "producer_source_snapshot_sha256",
            "consumer_source_snapshot_sha256",
        }:
            _source_snapshot(value, f"identity.{key}")
        elif type(value) is not str or not value:
            raise IdentityReplayError(f"identity.{key}: expected nonempty string")
    declared = _digest(identity["content_sha256"], "identity.content_sha256")
    if sidecar["identity_content_sha256"] != declared:
        raise IdentityReplayError("preimage sidecar: identity digest mismatch")
    text = sidecar["identity_preimage_json"]
    if type(text) is not str:
        raise IdentityReplayError("preimage sidecar: preimage must be a string")
    try:
        exact = text.encode("utf-8")
    except UnicodeEncodeError as error:
        raise IdentityReplayError("preimage sidecar: invalid UTF-8 preimage") from error
    raw_digest = "sha256:" + hashlib.sha256(exact).hexdigest()
    if _digest(sidecar["identity_preimage_sha256"], "preimage digest") != raw_digest:
        raise IdentityReplayError("preimage sidecar: raw digest mismatch")
    parsed = strict_json_object(exact, "identity preimage")
    expected = dict(identity, content_sha256="")
    _same_typed_json(parsed, expected, "identity preimage")
    framed = (IDENTITY_SCHEMA.encode("utf-8") + b"\0" +
              struct.pack("<Q", len(exact)) + exact)
    actual = "sha256:" + hashlib.sha256(framed).hexdigest()
    if actual != declared:
        raise IdentityReplayError("identity: framed digest mismatch")
    return declared
