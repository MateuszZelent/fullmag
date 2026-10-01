"""Replay the five material/physical preimages carried by R4 identity v2.

The three equilibrium identity preimages use the historical framed digest
contract from ``fem/equilibrium_identity.rs``.  The producer and consumer
material provenance preimages are the exact ``MaterialIR`` JSON bytes hashed
by ``shared_domain_content_digest`` and therefore have no namespace or length
frame.  This module validates the typed JSON contract before hashing the
original UTF-8 bytes; it never reconstructs Rust ``serde_json`` bytes.

The helper covers physical equilibrium identity and raw material provenance.
It does not validate the full 52-field identity record, mesh, m0, source
snapshots, modal operators, or solver results.  The main verifier must perform
its full identity-schema/content check before calling this five-pair replay.
Those remaining checks are separate R4 gates.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import struct
from typing import Any


IDENTITY_SCHEMA = "linearization_identity.v2"

MATERIAL_V1_NAMESPACE = "EquilibriumMaterialSignaturePreimage.v1"
MATERIAL_V2_NAMESPACE = "EquilibriumMaterialSignaturePreimage.v2"
STATIC_PHYSICS_NAMESPACE = "EquilibriumStaticPhysicsSignaturePreimage.v1"
BOUNDARY_NAMESPACE = "EquilibriumBoundarySignaturePreimage.v1"

_MATERIAL_V1_FIELDS = frozenset(
    {
        "schema_version",
        "saturation_magnetisation_a_per_m",
        "exchange_stiffness_j_per_m",
        "saturation_magnetisation_field_a_per_m",
        "exchange_stiffness_field_j_per_m",
    }
)
_MATERIAL_V2_FIELDS = frozenset(
    {
        *_MATERIAL_V1_FIELDS,
        "uniaxial_anisotropy_j_per_m3",
        "canonical_uniaxial_axis",
    }
)
_STATIC_PHYSICS_FIELDS = frozenset(
    {
        "schema_version",
        "enable_exchange",
        "enable_demag",
        "external_field_a_per_m",
    }
)
_BOUNDARY_FIELDS = frozenset(
    {
        "schema_version",
        "exchange_bc",
        "demag_realization",
        "air_box_config",
        "periodic_node_pairs",
        "periodic_boundary_pairs",
    }
)

_RAW_REQUIRED_FIELDS = frozenset(
    {
        "name",
        "saturation_magnetisation",
        "exchange_stiffness",
        "damping",
        # These fields are not `skip_serializing_if` in MaterialIR, so the
        # producer's serde_json::to_vec always emits them (as null when the
        # option is absent).  This is a producer-shaped replay contract; it
        # is intentionally stricter than generic deserialization of Option.
        "uniaxial_anisotropy",
        "anisotropy_axis",
    }
)
_RAW_OPTIONAL_SCALAR_FIELDS = frozenset(
    {
        "uniaxial_anisotropy",
        "uniaxial_anisotropy_k2",
        "cubic_anisotropy_kc1",
        "cubic_anisotropy_kc2",
        "cubic_anisotropy_kc3",
        "interfacial_dmi",
        "bulk_dmi",
    }
)
_RAW_OPTIONAL_VECTOR_FIELDS = frozenset(
    {
        "anisotropy_axis",
        "cubic_anisotropy_axis1",
        "cubic_anisotropy_axis2",
    }
)
_RAW_OPTIONAL_ARRAY_FIELDS = frozenset(
    {
        "ms_field",
        "a_field",
        "alpha_field",
        "ku_field",
        "ku2_field",
        "kc1_field",
        "kc2_field",
        "kc3_field",
        "dind_field",
        "dbulk_field",
    }
)

_DEMAG_VARIANTS = frozenset(
    {
        "poisson_dirichlet",
        "poisson_robin",
        "bem",
        "fredkin_koehler",
        "fmm",
        # These aliases are accepted by the Rust enum deserializer.
        "airbox_dirichlet",
        "poisson_airbox",
        "airbox_robin",
    }
)
_SHA256_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
_MAX_JSON_DEPTH = 128


class EquilibriumIdentityReplayError(ValueError):
    """The supplied equilibrium identity preimage is not replayable."""


def _fail(message: str) -> None:
    raise EquilibriumIdentityReplayError(message)


def _reject_duplicate_keys(items: list[tuple[str, Any]], label: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in items:
        if key in result:
            _fail(f"{label}: duplicate key {key!r}")
        result[key] = value
    return result


def _reject_nonfinite_constant(token: str, label: str) -> None:
    _fail(f"{label}: non-JSON number {token}")


def _parse_int_preserving_negative_zero(token: str) -> int | float:
    """Preserve JSON's lexical ``-0`` for Rust-like negative-zero checks.

    Python's default ``json.loads`` turns ``-0`` into integer zero.  Rust's
    ``serde_json`` decodes the same token as a floating-point negative zero
    when the destination is f64.  Returning ``-0.0`` keeps V2 Ku/axis checks
    fail-closed.  Unsigned PBC fields still reject it because ``_uint32``
    requires an actual non-negative integer, while ordinary ``0`` remains an
    int.
    """

    return -0.0 if token == "-0" else int(token)


def _validate_json_values(value: Any, label: str, depth: int = 0) -> None:
    if depth > _MAX_JSON_DEPTH:
        _fail(f"{label}: JSON nesting limit exceeded")
    if type(value) is str:
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise EquilibriumIdentityReplayError(
                f"{label}: invalid Unicode string"
            ) from error
    elif type(value) is float and not math.isfinite(value):
        _fail(f"{label}: non-finite number")
    elif type(value) is dict:
        for key, item in value.items():
            _validate_json_values(key, f"{label}.key")
            _validate_json_values(item, f"{label}.{key}", depth + 1)
    elif type(value) is list:
        for index, item in enumerate(value):
            _validate_json_values(item, f"{label}[{index}]", depth + 1)


def _strict_object(raw: bytes, label: str) -> dict[str, Any]:
    if type(raw) is not bytes:
        _fail(f"{label}: expected exact bytes")
    try:
        text = raw.decode("utf-8")
        value = json.loads(
            text,
            object_pairs_hook=lambda items: _reject_duplicate_keys(items, label),
            parse_constant=lambda token: _reject_nonfinite_constant(token, label),
            parse_int=_parse_int_preserving_negative_zero,
        )
    except EquilibriumIdentityReplayError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise EquilibriumIdentityReplayError(
            f"{label}: invalid UTF-8 JSON"
        ) from error
    if type(value) is not dict:
        _fail(f"{label}: expected JSON object")
    _validate_json_values(value, label)
    return value


def _exact_fields(value: dict[str, Any], expected: frozenset[str], label: str) -> None:
    actual = frozenset(value)
    missing = sorted(expected - actual)
    unknown = sorted(actual - expected)
    if missing or unknown:
        details: list[str] = []
        if missing:
            details.append(f"missing={','.join(missing)}")
        if unknown:
            details.append(f"unknown={','.join(unknown)}")
        _fail(f"{label}: invalid field set ({'; '.join(details)})")


def _finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"{label}: expected finite JSON number")
    try:
        result = float(value)
    except (OverflowError, ValueError) as error:
        raise EquilibriumIdentityReplayError(
            f"{label}: expected finite JSON number"
        ) from error
    if not math.isfinite(result):
        _fail(f"{label}: expected finite JSON number")
    return result


def _uint32(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 0xFFFFFFFF:
        _fail(f"{label}: expected u32")
    return value


def _finite_vector(value: Any, label: str, length: int) -> None:
    if type(value) is not list or len(value) != length:
        _fail(f"{label}: expected vector of length {length}")
    for index, component in enumerate(value):
        _finite_number(component, f"{label}[{index}]")


def _optional_number_array(
    value: Any,
    label: str,
    *,
    positive: bool = False,
    nonnegative: bool = False,
) -> None:
    if value is None:
        return
    if type(value) is not list:
        _fail(f"{label}: expected array or null")
    for index, item in enumerate(value):
        number = _finite_number(item, f"{label}[{index}]")
        if positive and number <= 0.0:
            _fail(f"{label}[{index}]: expected positive value")
        if nonnegative and number < 0.0:
            _fail(f"{label}[{index}]: expected non-negative value")


def _negative_zero(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and value == 0.0
        and math.copysign(1.0, float(value)) < 0.0
    )


def _validate_material_preimage(value: dict[str, Any]) -> str:
    schema = value.get("schema_version")
    if schema == MATERIAL_V1_NAMESPACE:
        _exact_fields(value, _MATERIAL_V1_FIELDS, "equilibrium material V1")
    elif schema == MATERIAL_V2_NAMESPACE:
        _exact_fields(value, _MATERIAL_V2_FIELDS, "equilibrium material V2")
    else:
        _fail(f"equilibrium material: unsupported schema {schema!r}")

    ms = _finite_number(
        value["saturation_magnetisation_a_per_m"],
        "equilibrium material saturation_magnetisation_a_per_m",
    )
    if ms <= 0.0:
        _fail("equilibrium material Ms must be finite and positive")
    aex = _finite_number(
        value["exchange_stiffness_j_per_m"],
        "equilibrium material exchange_stiffness_j_per_m",
    )
    if aex < 0.0:
        _fail("equilibrium material Aex must be finite and non-negative")
    _optional_number_array(
        value["saturation_magnetisation_field_a_per_m"],
        "equilibrium material saturation_magnetisation_field_a_per_m",
        positive=True,
    )
    _optional_number_array(
        value["exchange_stiffness_field_j_per_m"],
        "equilibrium material exchange_stiffness_field_j_per_m",
        nonnegative=True,
    )

    if schema == MATERIAL_V1_NAMESPACE:
        return schema

    # Constant-Ku V2 is defined only for uniform Ms.  Rust distinguishes an
    # absent/null Option from Some(vec![]), so even an empty array is rejected.
    if value["saturation_magnetisation_field_a_per_m"] is not None:
        _fail("equilibrium material V2 does not allow an Ms field")
    ku = _finite_number(
        value["uniaxial_anisotropy_j_per_m3"],
        "equilibrium material uniaxial_anisotropy_j_per_m3",
    )
    if _negative_zero(value["uniaxial_anisotropy_j_per_m3"]):
        _fail("equilibrium material V2 Ku cannot be negative zero")
    axis = value["canonical_uniaxial_axis"]
    _finite_vector(axis, "equilibrium material canonical_uniaxial_axis", 3)
    if any(_negative_zero(component) for component in axis):
        _fail("equilibrium material V2 axis cannot contain negative zero")
    norm = math.hypot(math.hypot(float(axis[0]), float(axis[1])), float(axis[2]))
    if not math.isfinite(norm) or abs(norm - 1.0) > 1.0e-12:
        _fail("equilibrium material V2 axis must have unit length")
    first_nonzero = next((component for component in axis if component != 0.0), None)
    if first_nonzero is None:
        _fail("equilibrium material V2 axis must be non-zero")
    if float(first_nonzero) < 0.0:
        _fail("equilibrium material V2 axis orientation is not canonical")
    # Keep the local binding explicit so reviewers can see that Ku is parsed
    # and checked even when its value is the valid explicit zero.
    _ = ku
    return schema


def _validate_static_physics_preimage(value: dict[str, Any]) -> str:
    _exact_fields(value, _STATIC_PHYSICS_FIELDS, "static physics")
    if value["schema_version"] != STATIC_PHYSICS_NAMESPACE:
        _fail("static physics: unsupported schema")
    for key in ("enable_exchange", "enable_demag"):
        if type(value[key]) is not bool:
            _fail(f"static physics {key} must be a JSON boolean")
    external = value["external_field_a_per_m"]
    if external is not None:
        _finite_vector(external, "static physics external_field_a_per_m", 3)
    return STATIC_PHYSICS_NAMESPACE


def _optional_string(value: Any, label: str) -> None:
    if value is not None and type(value) is not str:
        _fail(f"{label}: expected string or null")


def _validate_air_box(value: Any) -> None:
    if type(value) is not dict:
        _fail("boundary air_box_config must be an object or null")
    for key in ("factor", "grading"):
        if key not in value:
            _fail(f"boundary air_box_config missing {key}")
        _finite_number(value[key], f"boundary air_box_config.{key}")
    if "boundary_marker" not in value:
        _fail("boundary air_box_config missing boundary_marker")
    _uint32(value["boundary_marker"], "boundary air_box_config.boundary_marker")
    for key in (
        "bc_kind",
        "robin_beta_mode",
        "shape",
        "factor_source",
        "boundary_marker_source",
    ):
        if key in value:
            _optional_string(value[key], f"boundary air_box_config.{key}")
    if "robin_beta_factor" in value and value["robin_beta_factor"] is not None:
        _finite_number(
            value["robin_beta_factor"],
            "boundary air_box_config.robin_beta_factor",
        )


def _validate_node_pair(value: Any, index: int) -> None:
    label = f"boundary periodic_node_pairs[{index}]"
    if type(value) is not dict:
        _fail(f"{label} must be an object")
    for key in ("pair_id", "node_a", "node_b"):
        if key not in value:
            _fail(f"{label} missing {key}")
    if type(value["pair_id"]) is not str:
        _fail(f"{label}.pair_id must be a string")
    _uint32(value["node_a"], f"{label}.node_a")
    _uint32(value["node_b"], f"{label}.node_b")


def _validate_boundary_pair(value: Any, index: int) -> None:
    label = f"boundary periodic_boundary_pairs[{index}]"
    if type(value) is not dict:
        _fail(f"{label} must be an object")
    if "tolerance_m" in value:
        _fail(
            f"{label}.tolerance_m is a serde input alias; producer JSON must use tolerance"
        )
    if "pair_id" not in value or type(value["pair_id"]) is not str:
        _fail(f"{label}.pair_id must be a string")
    for key in ("source_marker", "destination_marker", "axis_hint", "orientation", "pairing_policy"):
        if key in value:
            _optional_string(value[key], f"{label}.{key}")
    for key in ("marker_a", "marker_b"):
        if key in value:
            _uint32(value[key], f"{label}.{key}")
    if "translation" in value and value["translation"] is not None:
        _finite_vector(value["translation"], f"{label}.translation", 3)
    if "tolerance" in value and value["tolerance"] is not None:
        _finite_number(value["tolerance"], f"{label}.tolerance")


def _validate_boundary_preimage(value: dict[str, Any]) -> str:
    _exact_fields(value, _BOUNDARY_FIELDS, "boundary")
    if value["schema_version"] != BOUNDARY_NAMESPACE:
        _fail("boundary: unsupported schema")
    if value["exchange_bc"] != "neumann":
        _fail("boundary exchange_bc is not a supported Rust enum value")
    demag = value["demag_realization"]
    if demag is not None and (
        type(demag) is not str or demag not in _DEMAG_VARIANTS
    ):
        _fail("boundary demag_realization is not a supported Rust enum value")
    if value["air_box_config"] is not None:
        _validate_air_box(value["air_box_config"])
    node_pairs = value["periodic_node_pairs"]
    boundary_pairs = value["periodic_boundary_pairs"]
    if type(node_pairs) is not list or type(boundary_pairs) is not list:
        _fail("boundary periodic pair collections must be arrays")
    for index, pair in enumerate(node_pairs):
        _validate_node_pair(pair, index)
    for index, pair in enumerate(boundary_pairs):
        _validate_boundary_pair(pair, index)
    return BOUNDARY_NAMESPACE


def _validate_raw_material_preimage(value: dict[str, Any]) -> None:
    # MaterialIR has no deny_unknown_fields annotation.  Preserve that Rust
    # behavior: validate the stable typed fields and retain any future raw
    # fields in the exact bytes instead of inventing a canonical schema.  This
    # is shape/finite-number validation only: planner positivity, supported
    # material families, axis normalization and other IR semantics belong to
    # the Rust producer and are deliberately not replayed here.
    missing = sorted(_RAW_REQUIRED_FIELDS - set(value))
    if missing:
        _fail(f"raw MaterialIR: missing required fields {','.join(missing)}")
    if type(value["name"]) is not str:
        _fail("raw MaterialIR name must be a string")
    for key in {
        "saturation_magnetisation",
        "exchange_stiffness",
        "damping",
    }:
        _finite_number(value[key], f"raw MaterialIR.{key}")
    if value["uniaxial_anisotropy"] is not None:
        _finite_number(
            value["uniaxial_anisotropy"],
            "raw MaterialIR.uniaxial_anisotropy",
        )
    if value["anisotropy_axis"] is not None:
        _finite_vector(value["anisotropy_axis"], "raw MaterialIR.anisotropy_axis", 3)
    for key in _RAW_OPTIONAL_SCALAR_FIELDS - {"uniaxial_anisotropy"}:
        if key in value and value[key] is not None:
            _finite_number(value[key], f"raw MaterialIR.{key}")
    for key in _RAW_OPTIONAL_VECTOR_FIELDS - {"anisotropy_axis"}:
        if key in value and value[key] is not None:
            _finite_vector(value[key], f"raw MaterialIR.{key}", 3)
    for key in _RAW_OPTIONAL_ARRAY_FIELDS:
        if key in value and value[key] is not None:
            _optional_number_array(value[key], f"raw MaterialIR.{key}")


def _digest(value: Any, label: str) -> str:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        _fail(f"{label}: expected sha256:<64 lowercase hex> digest")
    return value


def framed_digest(namespace: str, payload: bytes) -> str:
    if type(namespace) is not str or not namespace:
        _fail("digest namespace must be a non-empty string")
    return "sha256:" + hashlib.sha256(
        namespace.encode("utf-8")
        + b"\0"
        + struct.pack("<Q", len(payload))
        + payload
    ).hexdigest()


def raw_material_digest(payload: bytes) -> str:
    if type(payload) is not bytes:
        _fail("raw material digest requires exact bytes")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _preimage_bytes(preimage_json: Any, label: str) -> tuple[bytes, dict[str, Any]]:
    if type(preimage_json) is not str:
        _fail(f"{label}: preimage must be a JSON string")
    try:
        payload = preimage_json.encode("utf-8")
    except UnicodeEncodeError as error:
        raise EquilibriumIdentityReplayError(
            f"{label}: preimage is not valid UTF-8"
        ) from error
    return payload, _strict_object(payload, label)


def replay_preimage_json(
    preimage_json: str,
    expected_digest: str,
    kind: str,
) -> str:
    """Validate and replay one exact identity preimage.

    ``kind`` is one of ``equilibrium_material``, ``static_physics``,
    ``boundary`` or ``raw_material``.  The returned digest is the value that
    was compared with ``expected_digest``.
    """

    expected = _digest(expected_digest, f"{kind} signature")
    payload, value = _preimage_bytes(preimage_json, kind)
    if kind == "equilibrium_material":
        namespace = _validate_material_preimage(value)
        actual = framed_digest(namespace, payload)
    elif kind == "static_physics":
        namespace = _validate_static_physics_preimage(value)
        actual = framed_digest(namespace, payload)
    elif kind == "boundary":
        namespace = _validate_boundary_preimage(value)
        actual = framed_digest(namespace, payload)
    elif kind == "raw_material":
        _validate_raw_material_preimage(value)
        actual = raw_material_digest(payload)
    else:
        _fail(f"unsupported equilibrium identity preimage kind {kind!r}")
    if actual != expected:
        _fail(f"{kind} digest mismatch: expected {expected}, got {actual}")
    return actual


_IDENTITY_PREIMAGE_SPECS = (
    (
        "equilibrium_material_preimage_json",
        "equilibrium_material_signature",
        "equilibrium_material",
    ),
    (
        "equilibrium_static_physics_preimage_json",
        "equilibrium_static_physics_signature",
        "static_physics",
    ),
    (
        "equilibrium_boundary_preimage_json",
        "equilibrium_boundary_signature",
        "boundary",
    ),
    (
        "producer_material_provenance_preimage_json",
        "producer_material_provenance_signature",
        "raw_material",
    ),
    (
        "material_provenance_preimage_json",
        "material_provenance_signature",
        "raw_material",
    ),
)


def replay_equilibrium_identity_preimages(identity_bytes: bytes) -> dict[str, str]:
    """Replay all five exact preimages from one ``linearization_identity.v2``.

    The result is keyed by the identity signature field name.  This function
    intentionally checks only the identity schema marker and the five
    preimage/signature pairs.  The caller (the main verifier) must first run
    the full 52-field identity-schema/content validation.  This helper is not
    evidence for mesh, m0, source build, modal operator, residual or COMSOL
    parity.
    """

    identity = _strict_object(identity_bytes, "linearization identity")
    if identity.get("schema_version") != IDENTITY_SCHEMA:
        _fail("linearization identity has an unsupported schema")
    replayed: dict[str, str] = {}
    for preimage_key, signature_key, kind in _IDENTITY_PREIMAGE_SPECS:
        if preimage_key not in identity or signature_key not in identity:
            _fail(f"linearization identity is missing {preimage_key} or {signature_key}")
        replayed[signature_key] = replay_preimage_json(
            identity[preimage_key], identity[signature_key], kind
        )
    return replayed


# Short alias for callers that already use the generic identity terminology.
replay_identity_preimages = replay_equilibrium_identity_preimages
