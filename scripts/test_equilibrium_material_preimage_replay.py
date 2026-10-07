#!/usr/bin/env python3
"""Independent source/math checks for equilibrium material preimage replay.

This is an interpreted contract check.  It does not compile or execute the
Rust runner.  Its framing implementation is deliberately separate from the
Rust implementation so the published V1/V2 bytes and the Ku=0 namespace rule
have an independent oracle.
"""

from __future__ import annotations

import hashlib
import json
import math
import struct
from pathlib import Path


V1_NAMESPACE = "EquilibriumMaterialSignaturePreimage.v1"
V2_NAMESPACE = "EquilibriumMaterialSignaturePreimage.v2"
V1_PREIMAGE = (
    '{"schema_version":"EquilibriumMaterialSignaturePreimage.v1",'
    '"saturation_magnetisation_a_per_m":800000.0,'
    '"exchange_stiffness_j_per_m":1.3e-11,'
    '"saturation_magnetisation_field_a_per_m":null,'
    '"exchange_stiffness_field_j_per_m":null}'
)
V2_PREIMAGE = (
    '{"schema_version":"EquilibriumMaterialSignaturePreimage.v2",'
    '"saturation_magnetisation_a_per_m":800000.0,'
    '"exchange_stiffness_j_per_m":1.3e-11,'
    '"saturation_magnetisation_field_a_per_m":null,'
    '"exchange_stiffness_field_j_per_m":null,'
    '"uniaxial_anisotropy_j_per_m3":0.0,'
    '"canonical_uniaxial_axis":[0.5547001962252291,0.8320502943378437,0.0]}'
)
V1_DIGEST = "sha256:5acf82b569d679296e01d7724e5a2a83fc60ce37d3d711afd535143c4bdad5af"
V2_DIGEST = "sha256:5aff2c9f1fa917b8f55646cdb181e93feb1d2d8052d265d7256da089944e0f1b"


def framed_digest(namespace: str, payload: str) -> str:
    payload_bytes = payload.encode("utf-8")
    framed = (
        namespace.encode("utf-8")
        + b"\0"
        + struct.pack("<Q", len(payload_bytes))
        + payload_bytes
    )
    return "sha256:" + hashlib.sha256(framed).hexdigest()


def parse_strict_contract(payload: str) -> dict[str, object]:
    def reject_constant(token: str) -> None:
        raise ValueError(f"non-finite JSON constant: {token}")

    def reject_duplicate_fields(pairs: list[tuple[str, object]]) -> dict[str, object]:
        value: dict[str, object] = {}
        for key, item in pairs:
            if key in value:
                raise ValueError(f"duplicate field: {key}")
            value[key] = item
        return value

    value = json.loads(
        payload,
        object_pairs_hook=reject_duplicate_fields,
        parse_constant=reject_constant,
    )
    if not isinstance(value, dict):
        raise ValueError("preimage must be an object")
    schema = value.get("schema_version")
    if schema == V1_NAMESPACE:
        expected = {
            "schema_version",
            "saturation_magnetisation_a_per_m",
            "exchange_stiffness_j_per_m",
            "saturation_magnetisation_field_a_per_m",
            "exchange_stiffness_field_j_per_m",
        }
    elif schema == V2_NAMESPACE:
        expected = {
            "schema_version",
            "saturation_magnetisation_a_per_m",
            "exchange_stiffness_j_per_m",
            "saturation_magnetisation_field_a_per_m",
            "exchange_stiffness_field_j_per_m",
            "uniaxial_anisotropy_j_per_m3",
            "canonical_uniaxial_axis",
        }
    else:
        raise ValueError(f"unsupported schema: {schema!r}")
    if set(value) != expected:
        raise ValueError(f"schema fields differ: {sorted(set(value) ^ expected)}")

    ms = value["saturation_magnetisation_a_per_m"]
    aex = value["exchange_stiffness_j_per_m"]
    if not isinstance(ms, (int, float)) or isinstance(ms, bool) or not math.isfinite(ms) or ms <= 0:
        raise ValueError("Ms must be finite and positive")
    if not isinstance(aex, (int, float)) or isinstance(aex, bool) or not math.isfinite(aex) or aex < 0:
        raise ValueError("Aex must be finite and nonnegative")
    for key, lower, strict in (
        ("saturation_magnetisation_field_a_per_m", 0.0, True),
        ("exchange_stiffness_field_j_per_m", 0.0, False),
    ):
        values = value[key]
        if values is not None:
            if not isinstance(values, list):
                raise ValueError(f"{key} must be an array or null")
            for item in values:
                if (
                    not isinstance(item, (int, float))
                    or isinstance(item, bool)
                    or not math.isfinite(item)
                    or (item <= lower if strict else item < lower)
                ):
                    raise ValueError(f"{key} contains an invalid value")
    if schema == V2_NAMESPACE:
        if value["saturation_magnetisation_field_a_per_m"] is not None:
            raise ValueError("V2 constant-Ku identity requires uniform Ms")
        ku = value["uniaxial_anisotropy_j_per_m3"]
        axis = value["canonical_uniaxial_axis"]
        if not isinstance(ku, (int, float)) or isinstance(ku, bool) or not math.isfinite(ku):
            raise ValueError("Ku must be finite")
        if ku == 0.0 and math.copysign(1.0, ku) < 0:
            raise ValueError("Ku negative zero is not canonical")
        if not isinstance(axis, list) or len(axis) != 3 or any(
            not isinstance(item, (int, float))
            or isinstance(item, bool)
            or not math.isfinite(item)
            for item in axis
        ):
            raise ValueError("axis must contain three finite values")
        if any(item == 0.0 and math.copysign(1.0, item) < 0 for item in axis):
            raise ValueError("axis contains negative zero")
        norm = math.sqrt(sum(item * item for item in axis))
        if not math.isfinite(norm) or abs(norm - 1.0) > 1.0e-12:
            raise ValueError("axis must be unit length")
        first_nonzero = next((item for item in axis if item != 0.0), None)
        if first_nonzero is None or first_nonzero < 0.0:
            raise ValueError("axis orientation is not canonical")
    return value


def main() -> None:
    repo = Path(__file__).resolve().parents[1]
    rust_path = repo / "crates/fullmag-runner/src/fem/equilibrium_identity.rs"
    source = rust_path.read_text(encoding="utf-8")
    replay_start = source.index("pub(super) fn replay_equilibrium_material_signature")
    replay_end = source.index("#[cfg(test)]", replay_start)
    replay_source = source[replay_start:replay_end]
    required_source_fragments = (
        "EquilibriumMaterialSignatureReplayV2",
        "#[serde(deny_unknown_fields)]",
        "schema_version",
        "preimage_json.as_bytes()",
        "(bytes.len() as u64).to_le_bytes()",
        "validate_canonical_uniaxial_axis",
        "EQUILIBRIUM_MATERIAL_PREIMAGE_V1",
        "EQUILIBRIUM_MATERIAL_PREIMAGE_V2",
    )
    for fragment in required_source_fragments:
        if fragment not in source:
            raise AssertionError(f"missing source contract fragment: {fragment}")
    if "serde_json::to_vec" in replay_source:
        raise AssertionError("replay path must not reserialize the published preimage")

    assert framed_digest(V1_NAMESPACE, V1_PREIMAGE) == V1_DIGEST
    assert framed_digest(V2_NAMESPACE, V2_PREIMAGE) == V2_DIGEST
    assert len(V1_PREIMAGE.encode("utf-8")) == 227
    assert len(V2_PREIMAGE.encode("utf-8")) == 332
    v1 = parse_strict_contract(V1_PREIMAGE)
    v2 = parse_strict_contract(V2_PREIMAGE)
    assert v1["schema_version"] == V1_NAMESPACE
    assert v2["schema_version"] == V2_NAMESPACE
    assert v2["uniaxial_anisotropy_j_per_m3"] == 0.0
    assert V1_DIGEST != V2_DIGEST, "explicit Ku=0 must remain in V2 identity"
    assert framed_digest(V1_NAMESPACE, V1_PREIMAGE + " \n") != V1_DIGEST
    assert framed_digest(V1_NAMESPACE, V1_PREIMAGE.replace("800000.0", "8.0e5")) != V1_DIGEST

    mutations = (
        V1_PREIMAGE[:-1] + ',"uniaxial_anisotropy_j_per_m3":0.0}',
        V2_PREIMAGE.replace(V2_NAMESPACE, V1_NAMESPACE),
        V1_PREIMAGE.replace("800000.0", "0.0"),
        V1_PREIMAGE.replace("1.3e-11", "-1.3e-11"),
        V2_PREIMAGE.replace("0.5547001962252291", "-0.5547001962252291"),
        V1_PREIMAGE.replace(
            '"schema_version":"EquilibriumMaterialSignaturePreimage.v1",',
            '"schema_version":"EquilibriumMaterialSignaturePreimage.v1",'
            '"schema_version":"EquilibriumMaterialSignaturePreimage.v1",',
        ),
        V2_PREIMAGE.replace(
            '"saturation_magnetisation_field_a_per_m":null',
            '"saturation_magnetisation_field_a_per_m":[]',
        ),
        V1_PREIMAGE.replace("800000.0", "NaN"),
    )
    for mutation in mutations:
        try:
            parse_strict_contract(mutation)
        except (ValueError, json.JSONDecodeError):
            continue
        raise AssertionError(f"invalid material mutation accepted: {mutation}")

    print("PASS: independent equilibrium material preimage replay contract")


if __name__ == "__main__":
    main()
