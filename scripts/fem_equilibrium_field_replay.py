"""Independent replay of the native FEM equilibrium-field certificate.

This module mirrors the stable, byte-oriented part of the Rust contract in
``crates/fullmag-runner/src/types.rs`` and
``crates/fullmag-runner/src/fem_eigen.rs``.  It deliberately does not try to
recreate Rust's ``serde_json::to_vec`` bytes for the recomputation certificate:
the producer must provide those exact preimage bytes before that digest can be
called independently verified.

The public entry point is :func:`replay_accepted_recomputed_fields`.  It
returns a field-replay result, while keeping certificate JSON digest status and
missing source-context evidence explicit for a future manifest validator.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import struct
from typing import Any, Mapping, Sequence


FIELD_ABSOLUTE_TOLERANCE_A_PER_M = 1.0e-6
FIELD_RELATIVE_TOLERANCE = 1.0e-8
PHI_ABSOLUTE_TOLERANCE_A = 1.0e-12

V1_FIELDS = frozenset(
    {
        "schema_version",
        "h_ex_a_per_m",
        "h_demag_a_per_m",
        "h_ext_a_per_m",
        "h_eff_a_per_m",
        "phi_a",
        "content_sha256",
    }
)
V2_FIELDS = V1_FIELDS | {"h_anisotropy_a_per_m"}

CERTIFICATE_COMMON_FIELDS = frozenset(
    {
        "schema_version",
        "status",
        "recompute_provider",
        "node_count",
        "equilibrium_content_sha256",
        "mesh_topology_sha256",
        "equilibrium_material_signature",
        "equilibrium_static_physics_signature",
        "equilibrium_boundary_signature",
        "accepted_fields_content_sha256",
        "recomputed_fields_content_sha256",
        "max_h_ex_difference_a_per_m",
        "max_h_demag_difference_a_per_m",
        "max_h_ext_difference_a_per_m",
        "max_h_eff_difference_a_per_m",
        "max_phi_difference_a",
        "field_absolute_tolerance_a_per_m",
        "field_relative_tolerance",
        "phi_absolute_tolerance_a",
        "content_sha256",
    }
)
CERTIFICATE_V2_FIELDS = CERTIFICATE_COMMON_FIELDS | {
    "max_h_anisotropy_difference_a_per_m"
}

CERTIFICATE_INTEGER_FIELDS = frozenset({"node_count"})
CERTIFICATE_NUMBER_FIELDS = frozenset(
    {
        "max_h_ex_difference_a_per_m",
        "max_h_demag_difference_a_per_m",
        "max_h_ext_difference_a_per_m",
        "max_h_eff_difference_a_per_m",
        "max_h_anisotropy_difference_a_per_m",
        "max_phi_difference_a",
        "field_absolute_tolerance_a_per_m",
        "field_relative_tolerance",
        "phi_absolute_tolerance_a",
    }
)

CERTIFICATE_DIGEST_STATUS_VERIFIED = "verified_exact_preimage"
CERTIFICATE_DIGEST_STATUS_UNVERIFIED = "unverified_missing_preimage"


class ValidationError(ValueError):
    """Raised when a field or replay certificate violates its contract."""


@dataclass(frozen=True)
class ReplayResult:
    """Evidence returned after accepted/recomputed field replay.

    ``field_content_digests_verified`` and ``field_replay_verified`` cover the
    complete binary field contract.  ``certificate_content_digest_status`` is
    intentionally separate: without the producer's exact serde JSON
    preimage, a Python JSON re-serialization is not evidence of the Rust
    certificate digest.
    """

    schema_version: str
    node_count: int
    differences: Mapping[str, float]
    tolerances: Mapping[str, float]
    accepted_content_sha256: str
    recomputed_content_sha256: str
    field_content_digests_verified: bool
    field_replay_verified: bool
    certificate_content_digest_status: str
    limitations: tuple[str, ...]


@dataclass(frozen=True)
class _Fields:
    schema_version: str
    h_ex_a_per_m: tuple[tuple[float, float, float], ...]
    h_demag_a_per_m: tuple[tuple[float, float, float], ...]
    h_ext_a_per_m: tuple[tuple[float, float, float], ...]
    h_anisotropy_a_per_m: tuple[tuple[float, float, float], ...] | None
    h_eff_a_per_m: tuple[tuple[float, float, float], ...]
    phi_a: tuple[float, ...]
    content_sha256: str


def _fail(message: str) -> None:
    raise ValidationError(message)


def _finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"{label} must be a finite number")
    try:
        result = float(value)
    except (OverflowError, ValueError) as error:
        raise ValidationError(f"{label} must be a finite number") from error
    if not math.isfinite(result):
        _fail(f"{label} must be a finite number")
    return result


def _positive_node_count(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        _fail(f"{label} must be a positive integer")
    return value


def _sha256_digest(value: Any, label: str) -> str:
    if not isinstance(value, str) or len(value) != 71 or not value.startswith("sha256:"):
        _fail(f"{label} must be a lowercase sha256 digest")
    if any(character not in "0123456789abcdef" for character in value[7:]):
        _fail(f"{label} must be a lowercase sha256 digest")
    return value


def _exact_keys(value: Mapping[str, Any], expected: frozenset[str], label: str) -> None:
    if any(not isinstance(key, str) for key in value):
        _fail(f"{label} keys must be strings")
    actual = frozenset(value)
    missing = sorted(expected - actual)
    unknown = sorted(actual - expected)
    if missing or unknown:
        details = []
        if missing:
            details.append(f"missing={','.join(missing)}")
        if unknown:
            details.append(f"unknown={','.join(unknown)}")
        _fail(f"{label} has an invalid field set ({'; '.join(details)})")


def _match_certificate_preimage_values(
    parsed: Mapping[str, Any],
    expected: Mapping[str, Any],
    expected_keys: frozenset[str],
) -> None:
    """Compare JSON values using the types accepted by Rust's certificate schema.

    Python considers booleans equal to integers and floats.  That would let a
    preimage containing ``true`` or ``false`` bind to a Rust ``u64``/``f64``
    field even though serde rejects booleans for both numeric types.
    """

    for key in expected_keys:
        observed = parsed[key]
        expected_value = expected[key]
        if key in CERTIFICATE_INTEGER_FIELDS:
            if isinstance(observed, bool) or not isinstance(observed, int):
                _fail(f"certificate preimage {key} must be a JSON integer")
        elif key in CERTIFICATE_NUMBER_FIELDS:
            if isinstance(observed, bool) or not isinstance(observed, (int, float)):
                _fail(f"certificate preimage {key} must be a finite JSON number")
            _finite_number(observed, f"certificate preimage {key}")
        elif not isinstance(observed, str):
            _fail(f"certificate preimage {key} must be a JSON string")
        if observed != expected_value:
            _fail(f"certificate preimage field {key} does not match the inspected certificate")


def _vector_view(value: Any, node_count: int, label: str) -> tuple[tuple[float, float, float], ...]:
    if not isinstance(value, list) or len(value) != node_count:
        _fail(f"{label} must contain {node_count} vectors")
    vectors: list[tuple[float, float, float]] = []
    for index, vector in enumerate(value):
        if not isinstance(vector, list) or len(vector) != 3:
            _fail(f"{label}[{index}] must be a vector3")
        vectors.append(
            tuple(
                _finite_number(component, f"{label}[{index}][{component_index}]")
                for component_index, component in enumerate(vector)
            )
        )
    return tuple(vectors)


def _scalar_view(value: Any, node_count: int, label: str) -> tuple[float, ...]:
    if not isinstance(value, list) or len(value) != node_count:
        _fail(f"{label} must contain {node_count} values")
    return tuple(_finite_number(item, f"{label}[{index}]") for index, item in enumerate(value))


def _fields_digest(fields: _Fields) -> str:
    digest = hashlib.sha256()
    digest.update(fields.schema_version.encode("utf-8"))
    digest.update(b"\0")
    views: list[tuple[tuple[float, float, float], ...]] = [
        fields.h_ex_a_per_m,
        fields.h_demag_a_per_m,
        fields.h_ext_a_per_m,
        fields.h_eff_a_per_m,
    ]
    if fields.h_anisotropy_a_per_m is not None:
        # Rust inserts anisotropy between demag and external views.
        views.insert(2, fields.h_anisotropy_a_per_m)
    for vectors in views:
        digest.update(struct.pack("<Q", len(vectors)))
        for vector in vectors:
            for value in vector:
                digest.update(struct.pack("<d", value))
    digest.update(struct.pack("<Q", len(fields.phi_a)))
    for value in fields.phi_a:
        digest.update(struct.pack("<d", value))
    return "sha256:" + digest.hexdigest()


def _validate_field_decomposition(fields: _Fields, label: str) -> None:
    for node, (((h_ex, h_demag), h_ext), h_eff) in enumerate(
        zip(
            zip(zip(fields.h_ex_a_per_m, fields.h_demag_a_per_m), fields.h_ext_a_per_m),
            fields.h_eff_a_per_m,
        )
    ):
        for component in range(3):
            total = h_ex[component] + h_demag[component]
            if fields.h_anisotropy_a_per_m is not None:
                total += fields.h_anisotropy_a_per_m[node][component]
            total += h_ext[component]
            if h_eff[component] != total:
                _fail(
                    f"{label} H_eff must equal the schema-defined native field sum "
                    f"exactly at node {node}, component {component}"
                )


def _parse_fields(
    value: Any, node_count: int, label: str, *, verify_digest: bool = True
) -> _Fields:
    if not isinstance(value, Mapping):
        _fail(f"{label} must be a JSON object")
    schema = value.get("schema_version")
    if schema == "CertifiedFemEquilibriumFields.v1":
        expected = V1_FIELDS
        has_anisotropy = False
    elif schema == "CertifiedFemEquilibriumFields.v2":
        expected = V2_FIELDS
        has_anisotropy = True
    else:
        _fail(f"{label}.schema_version is unsupported")
    _exact_keys(value, expected, label)
    node_count = _positive_node_count(node_count, f"{label}.node_count")
    parsed = _Fields(
        schema_version=schema,
        h_ex_a_per_m=_vector_view(value["h_ex_a_per_m"], node_count, f"{label}.h_ex_a_per_m"),
        h_demag_a_per_m=_vector_view(value["h_demag_a_per_m"], node_count, f"{label}.h_demag_a_per_m"),
        h_ext_a_per_m=_vector_view(value["h_ext_a_per_m"], node_count, f"{label}.h_ext_a_per_m"),
        h_anisotropy_a_per_m=(
            _vector_view(value["h_anisotropy_a_per_m"], node_count, f"{label}.h_anisotropy_a_per_m")
            if has_anisotropy
            else None
        ),
        h_eff_a_per_m=_vector_view(value["h_eff_a_per_m"], node_count, f"{label}.h_eff_a_per_m"),
        phi_a=_scalar_view(value["phi_a"], node_count, f"{label}.phi_a"),
        content_sha256=_sha256_digest(value["content_sha256"], f"{label}.content_sha256"),
    )
    actual_digest = _fields_digest(parsed)
    if verify_digest and parsed.content_sha256 != actual_digest:
        _fail(f"{label}.content_sha256 does not match the native binary field digest")
    _validate_field_decomposition(parsed, label)
    return parsed


def validate_certified_equilibrium_fields(value: Any, node_count: int, label: str = "fields") -> None:
    """Validate one V1/V2 field payload against the native binary contract."""

    _parse_fields(value, node_count, label)


def certified_field_content_sha256(
    value: Any, node_count: int, label: str = "fields"
) -> str:
    """Compute the native binary field digest for a structured payload.

    This helper is useful for independent fixtures and for a future consumer
    that needs to compare the producer's declared digest.  It still enforces
    schema, shapes, finite values, and native field decomposition; it simply
    does not require the input's current ``content_sha256`` to already match.
    """

    return _fields_digest(_parse_fields(value, node_count, label, verify_digest=False))


def _max_vector_difference(
    left: tuple[tuple[float, float, float], ...],
    right: tuple[tuple[float, float, float], ...],
) -> float:
    if len(left) != len(right):
        _fail("accepted and recomputed vector field shapes differ")
    return max(
        (abs(left[node][component] - right[node][component]) for node in range(len(left)) for component in range(3)),
        default=0.0,
    )


def _max_vector_amplitude(values: tuple[tuple[float, float, float], ...]) -> float:
    return max((abs(component) for vector in values for component in vector), default=0.0)


def _max_scalar_difference(left: tuple[float, ...], right: tuple[float, ...]) -> float:
    if len(left) != len(right):
        _fail("accepted and recomputed scalar field shapes differ")
    return max((abs(a - b) for a, b in zip(left, right)), default=0.0)


def _max_scalar_amplitude(values: tuple[float, ...]) -> float:
    return max((abs(value) for value in values), default=0.0)


def calculate_field_differences(
    accepted_fields: Any,
    recomputed_fields: Any,
    node_count: int,
    label: str = "fields",
) -> dict[str, float]:
    """Return native-order max differences after validating both field views."""

    accepted = _parse_fields(accepted_fields, node_count, f"{label}.accepted")
    recomputed = _parse_fields(recomputed_fields, node_count, f"{label}.recomputed")
    if accepted.schema_version != recomputed.schema_version:
        _fail("accepted and recomputed field schema families differ")
    differences = {
        "max_h_ex_difference_a_per_m": _max_vector_difference(accepted.h_ex_a_per_m, recomputed.h_ex_a_per_m),
        "max_h_demag_difference_a_per_m": _max_vector_difference(accepted.h_demag_a_per_m, recomputed.h_demag_a_per_m),
        "max_h_ext_difference_a_per_m": _max_vector_difference(accepted.h_ext_a_per_m, recomputed.h_ext_a_per_m),
        "max_h_eff_difference_a_per_m": _max_vector_difference(accepted.h_eff_a_per_m, recomputed.h_eff_a_per_m),
        "max_phi_difference_a": _max_scalar_difference(accepted.phi_a, recomputed.phi_a),
    }
    if accepted.h_anisotropy_a_per_m is not None and recomputed.h_anisotropy_a_per_m is not None:
        differences["max_h_anisotropy_difference_a_per_m"] = _max_vector_difference(
            accepted.h_anisotropy_a_per_m, recomputed.h_anisotropy_a_per_m
        )
    return differences


def _certificate_sha256_from_exact_preimage(schema_version: str, preimage: bytes) -> str:
    digest = hashlib.sha256()
    digest.update(schema_version.encode("utf-8"))
    digest.update(b"\0")
    digest.update(struct.pack("<Q", len(preimage)))
    digest.update(preimage)
    return "sha256:" + digest.hexdigest()


def _parse_certificate_preimage(
    preimage: bytes,
    certificate: Mapping[str, Any],
    expected_keys: frozenset[str],
) -> None:
    """Bind supplied bytes to the inspected certificate before hashing them."""

    try:
        text = preimage.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValidationError("certificate preimage must be valid UTF-8 JSON") from error

    def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                _fail(f"certificate preimage contains duplicate key {key!r}")
            value[key] = item
        return value

    def reject_non_json_number(token: str) -> None:
        _fail(f"certificate preimage contains non-JSON number {token}")

    try:
        parsed = json.loads(
            text,
            object_pairs_hook=reject_duplicate_keys,
            parse_constant=reject_non_json_number,
        )
    except ValidationError:
        raise
    except (json.JSONDecodeError, TypeError) as error:
        raise ValidationError("certificate preimage must be a JSON object") from error
    if not isinstance(parsed, Mapping):
        _fail("certificate preimage must be a JSON object")
    _exact_keys(parsed, expected_keys, "certificate preimage")
    if parsed.get("content_sha256") != "":
        _fail("certificate preimage content_sha256 must be empty")
    expected = dict(certificate)
    expected["content_sha256"] = ""
    _match_certificate_preimage_values(parsed, expected, expected_keys)


def certificate_sha256_from_exact_preimage(schema_version: str, preimage: bytes) -> str:
    """Hash producer-supplied Rust ``serde_json`` certificate preimage bytes."""

    if not isinstance(schema_version, str) or not schema_version:
        _fail("certificate schema version must be a non-empty string")
    if not isinstance(preimage, bytes):
        _fail("certificate preimage must be exact bytes")
    return _certificate_sha256_from_exact_preimage(schema_version, preimage)


def _validate_certificate(
    certificate: Any,
    accepted: _Fields,
    recomputed: _Fields,
    node_count: int,
    differences: Mapping[str, float],
    certificate_preimage: bytes | None,
) -> tuple[str, tuple[str, ...]]:
    if not isinstance(certificate, Mapping):
        _fail("certificate must be a JSON object")
    if accepted.schema_version != recomputed.schema_version:
        _fail("accepted and recomputed field schema families differ")
    is_v2 = accepted.schema_version == "CertifiedFemEquilibriumFields.v2"
    expected_keys = CERTIFICATE_V2_FIELDS if is_v2 else CERTIFICATE_COMMON_FIELDS
    _exact_keys(certificate, expected_keys, "certificate")
    certificate_schema = (
        "RecomputedFemLinearizationCertificate.v2"
        if is_v2
        else "RecomputedFemLinearizationCertificate.v1"
    )
    provider = "native_fem_final_state_refresh.v2" if is_v2 else "native_fem_final_state_refresh.v1"
    if certificate["schema_version"] != certificate_schema:
        _fail("certificate.schema_version does not match the field family")
    if certificate["status"] != "matched" or certificate["recompute_provider"] != provider:
        _fail("certificate status or recompute provider is invalid")
    if _positive_node_count(certificate["node_count"], "certificate.node_count") != node_count:
        _fail("certificate.node_count does not match the expected node count")
    for name in (
        "equilibrium_content_sha256",
        "mesh_topology_sha256",
        "equilibrium_material_signature",
        "equilibrium_static_physics_signature",
        "equilibrium_boundary_signature",
        "accepted_fields_content_sha256",
        "recomputed_fields_content_sha256",
    ):
        _sha256_digest(certificate[name], f"certificate.{name}")
    _sha256_digest(certificate["content_sha256"], "certificate.content_sha256")
    if certificate["accepted_fields_content_sha256"] != accepted.content_sha256:
        _fail("certificate.accepted_fields_content_sha256 does not match accepted fields")
    if certificate["recomputed_fields_content_sha256"] != recomputed.content_sha256:
        _fail("certificate.recomputed_fields_content_sha256 does not match recomputed fields")

    tolerances = {
        "field_absolute_tolerance_a_per_m": FIELD_ABSOLUTE_TOLERANCE_A_PER_M,
        "field_relative_tolerance": FIELD_RELATIVE_TOLERANCE,
        "phi_absolute_tolerance_a": PHI_ABSOLUTE_TOLERANCE_A,
    }
    for name, expected in tolerances.items():
        actual = _finite_number(certificate[name], f"certificate.{name}")
        if actual < 0.0 or actual != expected:
            _fail(f"certificate.{name} does not match the shared native tolerance")

    field_scales = {
        "max_h_ex_difference_a_per_m": max(
            _max_vector_amplitude(accepted.h_ex_a_per_m),
            _max_vector_amplitude(recomputed.h_ex_a_per_m),
            1.0,
        ),
        "max_h_demag_difference_a_per_m": max(
            _max_vector_amplitude(accepted.h_demag_a_per_m),
            _max_vector_amplitude(recomputed.h_demag_a_per_m),
            1.0,
        ),
        "max_h_ext_difference_a_per_m": max(
            _max_vector_amplitude(accepted.h_ext_a_per_m),
            _max_vector_amplitude(recomputed.h_ext_a_per_m),
            1.0,
        ),
        "max_h_eff_difference_a_per_m": max(
            _max_vector_amplitude(accepted.h_eff_a_per_m),
            _max_vector_amplitude(recomputed.h_eff_a_per_m),
            1.0,
        ),
    }
    if is_v2:
        assert accepted.h_anisotropy_a_per_m is not None
        assert recomputed.h_anisotropy_a_per_m is not None
        field_scales["max_h_anisotropy_difference_a_per_m"] = max(
            _max_vector_amplitude(accepted.h_anisotropy_a_per_m),
            _max_vector_amplitude(recomputed.h_anisotropy_a_per_m),
            1.0,
        )
    for name, scale in field_scales.items():
        recorded = _finite_number(certificate[name], f"certificate.{name}")
        if recorded < 0.0 or recorded != differences[name]:
            _fail(f"certificate.{name} does not match independent replay")
        if recorded > FIELD_ABSOLUTE_TOLERANCE_A_PER_M + FIELD_RELATIVE_TOLERANCE * scale:
            _fail(f"certificate.{name} exceeds the shared field tolerance")
    phi_recorded = _finite_number(certificate["max_phi_difference_a"], "certificate.max_phi_difference_a")
    if phi_recorded < 0.0 or phi_recorded != differences["max_phi_difference_a"]:
        _fail("certificate.max_phi_difference_a does not match independent replay")
    phi_scale = max(
        _max_scalar_amplitude(accepted.phi_a),
        _max_scalar_amplitude(recomputed.phi_a),
        1.0,
    )
    if phi_recorded > PHI_ABSOLUTE_TOLERANCE_A + FIELD_RELATIVE_TOLERANCE * phi_scale:
        _fail("certificate.max_phi_difference_a exceeds the shared phi tolerance")

    if certificate_preimage is None:
        certificate_status = CERTIFICATE_DIGEST_STATUS_UNVERIFIED
        limitations = (
            "certificate content digest is not independently verified: exact Rust serde_json preimage bytes were not supplied",
        )
    else:
        if not isinstance(certificate_preimage, bytes):
            _fail("certificate preimage must be exact bytes")
        _parse_certificate_preimage(
            certificate_preimage,
            certificate,
            expected_keys,
        )
        expected_digest = _certificate_sha256_from_exact_preimage(
            certificate_schema, certificate_preimage
        )
        if expected_digest != certificate["content_sha256"]:
            _fail("certificate.content_sha256 does not match the supplied exact preimage")
        certificate_status = CERTIFICATE_DIGEST_STATUS_VERIFIED
        limitations = ()
    return certificate_status, limitations


def recomputed_fem_equilibrium_content_sha256(
    equilibrium_magnetization: Sequence[Sequence[float]],
) -> str:
    """Reproduce the native m0 digest when the exact equilibrium vectors exist."""

    digest = hashlib.sha256()
    digest.update(b"RecomputedFemLinearizationCertificate.m0.v1\0")
    digest.update(struct.pack("<Q", len(equilibrium_magnetization)))
    for node, vector in enumerate(equilibrium_magnetization):
        if not isinstance(vector, (list, tuple)) or len(vector) != 3:
            _fail(f"equilibrium_magnetization[{node}] must be a vector3")
        for component_index, component in enumerate(vector):
            digest.update(
                struct.pack("<d", _finite_number(component, f"equilibrium_magnetization[{node}][{component_index}]"))
            )
    return "sha256:" + digest.hexdigest()


def replay_accepted_recomputed_fields(
    accepted_fields: Any,
    recomputed_fields: Any,
    certificate: Any,
    *,
    node_count: int,
    certificate_preimage: bytes | None = None,
    equilibrium_magnetization: Sequence[Sequence[float]] | None = None,
    expected_mesh_topology_sha256: str | None = None,
    expected_identity_signatures: Mapping[str, str] | None = None,
) -> ReplayResult:
    """Replay accepted/recomputed fields and report certificate limitations.

    The optional context arguments let a later manifest validator close the
    remaining Rust checks without changing this field-only contract.  Missing
    context is reported in ``limitations`` rather than silently promoted.
    """

    expected_node_count = _positive_node_count(node_count, "node_count")
    accepted = _parse_fields(accepted_fields, expected_node_count, "accepted_fields")
    recomputed = _parse_fields(recomputed_fields, expected_node_count, "recomputed_fields")
    differences = {
        "max_h_ex_difference_a_per_m": _max_vector_difference(
            accepted.h_ex_a_per_m, recomputed.h_ex_a_per_m
        ),
        "max_h_demag_difference_a_per_m": _max_vector_difference(
            accepted.h_demag_a_per_m, recomputed.h_demag_a_per_m
        ),
        "max_h_ext_difference_a_per_m": _max_vector_difference(
            accepted.h_ext_a_per_m, recomputed.h_ext_a_per_m
        ),
        "max_h_eff_difference_a_per_m": _max_vector_difference(
            accepted.h_eff_a_per_m, recomputed.h_eff_a_per_m
        ),
        "max_phi_difference_a": _max_scalar_difference(accepted.phi_a, recomputed.phi_a),
    }
    if accepted.h_anisotropy_a_per_m is not None and recomputed.h_anisotropy_a_per_m is not None:
        differences["max_h_anisotropy_difference_a_per_m"] = _max_vector_difference(
            accepted.h_anisotropy_a_per_m, recomputed.h_anisotropy_a_per_m
        )
    certificate_status, limitations = _validate_certificate(
        certificate,
        accepted,
        recomputed,
        expected_node_count,
        differences,
        certificate_preimage,
    )
    limitation_list = list(limitations)
    if equilibrium_magnetization is None:
        limitation_list.append(
            "equilibrium_content_sha256 is format-checked but not replayed: equilibrium magnetization was not supplied"
        )
    else:
        if len(equilibrium_magnetization) != expected_node_count:
            _fail("equilibrium_magnetization node count does not match the expected node count")
        actual_m0_digest = recomputed_fem_equilibrium_content_sha256(equilibrium_magnetization)
        certificate_m0_digest = _sha256_digest(
            certificate["equilibrium_content_sha256"], "certificate.equilibrium_content_sha256"
        )
        if actual_m0_digest != certificate_m0_digest:
            _fail("certificate.equilibrium_content_sha256 does not match equilibrium magnetization")
    if expected_mesh_topology_sha256 is None:
        limitation_list.append(
            "mesh_topology_sha256 is format-checked but not compared: expected mesh digest was not supplied"
        )
    else:
        expected_mesh = _sha256_digest(expected_mesh_topology_sha256, "expected_mesh_topology_sha256")
        if certificate["mesh_topology_sha256"] != expected_mesh:
            _fail("certificate.mesh_topology_sha256 does not match the expected mesh digest")
    required_identity_keys = (
        "equilibrium_material_signature",
        "equilibrium_static_physics_signature",
        "equilibrium_boundary_signature",
    )
    if expected_identity_signatures is None:
        limitation_list.append(
            "equilibrium material/physics/boundary signatures are format-checked but not compared to a source plan"
        )
    else:
        for key in required_identity_keys:
            if key not in expected_identity_signatures:
                _fail(f"expected_identity_signatures is missing {key}")
            expected_identity = _sha256_digest(expected_identity_signatures[key], f"expected_identity_signatures.{key}")
            if certificate[key] != expected_identity:
                _fail(f"certificate.{key} does not match the expected source identity")
    return ReplayResult(
        schema_version=accepted.schema_version,
        node_count=expected_node_count,
        differences=dict(differences),
        tolerances={
            "field_absolute_tolerance_a_per_m": FIELD_ABSOLUTE_TOLERANCE_A_PER_M,
            "field_relative_tolerance": FIELD_RELATIVE_TOLERANCE,
            "phi_absolute_tolerance_a": PHI_ABSOLUTE_TOLERANCE_A,
        },
        accepted_content_sha256=accepted.content_sha256,
        recomputed_content_sha256=recomputed.content_sha256,
        field_content_digests_verified=True,
        field_replay_verified=True,
        certificate_content_digest_status=certificate_status,
        limitations=tuple(limitation_list),
    )
