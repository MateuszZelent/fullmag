#!/usr/bin/env python3
"""Verify the disconnected-body mixed-P1 FEM operator oracle.

The verifier consumes the ordinary native Fullmag run artifacts.  It does not
require a probe-specific JSON report or a generated body-mass sidecar:
``metadata.json`` already contains the typed FEM mesh in
``execution_plan.backend_plan.mesh``.  The independent oracle reconstructs P1
lumped volume weights from that mesh and compares the persisted step-0 scalar
energies with the uniform-field and uniaxial formulas.

A valid run contains at least::

    metadata.json
    m_initial.json
    scalars.csv
    fields/H_ex.zarr
    fields/H_demag.zarr
    fields/H_eff.zarr

The source's runtime metadata is an authoring request and is only used to bind
body IDs, constants, initial states and the requested field to the realized
certificate.  Executed device identity comes from native metadata and Zarr
provenance.  Passing this script is a bounded operator probe receipt; it is
not a production convergence qualification.

No synthetic JSON values are accepted as physics evidence.  Missing typed
mesh connectivity, native provenance, scalar rows or persisted fields fail
closed.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys
from typing import Any, Iterable


EXPECTED_PROBLEM_NAME = "fem_disconnected_mixed_p1_operator_probe"
EXPECTED_SOURCE_NAME = "fem_disconnected_mixed_p1_operator_probe.py"
EXPECTED_CERTIFICATE_SCHEMA = "mixed_layer_topology_certificate.v2"
SUMMARY_SCHEMA_VERSION = "fem_disconnected_mixed_p1_operator_summary.v2"
TOPOLOGY_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
RAW_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
MU0_T_M_PER_A = 4.0 * math.pi * 1.0e-7

# These are the existing FEM artifact comparison bounds.  The energy bound is
# deliberately the project-level 1e-6 relative bound: native CPU/GPU
# reductions and the scalar CSV round-trip are not bit exact.  The absolute
# floor is far below energies of this nm-scale probe and only handles a true
# zero.  Geometry masses use a tighter 1e-12 bound because they are recomputed
# from the same persisted double coordinates, not from a solver reduction.
ENERGY_RTOL = 1.0e-6
ENERGY_ATOL_J = 1.0e-30
FIELD_RTOL = 5.0e-8
FIELD_ATOL_APM = 1.0e-6
STATE_ATOL = 1.0e-10
MASS_RTOL = 1.0e-12
MASS_ATOL_M3 = 1.0e-36
EXCHANGE_FIELD_ATOL_APM = 1.0e-5

REQUIRED_SCALARS = ("E_ex", "E_ext", "E_ani", "E_total")
REQUIRED_FIELDS = ("H_ex", "H_demag", "H_eff")
OPTIONAL_FIELDS = ("H_ext", "H_ani")


class ContractError(ValueError):
    """Raised when managed operator evidence is absent or inconsistent."""


def _fail(message: str) -> None:
    raise ContractError(message)


def _object(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(f"{label} must be an object")
    return value


def _list(value: object, label: str) -> list[Any]:
    if not isinstance(value, list):
        _fail(f"{label} must be an array")
    return value


def _string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        _fail(f"{label} must be a non-empty string")
    return value


def _finite(value: object, label: str) -> float:
    if isinstance(value, bool):
        _fail(f"{label} must be finite numeric data")
    try:
        result = float(value)
    except (TypeError, ValueError):
        _fail(f"{label} must be finite numeric data")
    if not math.isfinite(result):
        _fail(f"{label} must be finite numeric data")
    return result


def _positive(value: object, label: str) -> float:
    result = _finite(value, label)
    if result <= 0.0:
        _fail(f"{label} must be positive")
    return result


def _strict_nonnegative_int(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        _fail(f"{label} must be a non-negative integer")
    return value


def _digest(value: object, label: str, *, prefixed: bool = True) -> str:
    result = _string(value, label)
    pattern = TOPOLOGY_DIGEST_RE if prefixed else RAW_DIGEST_RE
    if pattern.fullmatch(result) is None:
        _fail(f"{label} must be a canonical SHA-256 digest")
    return result


def _canonical_json_digest(value: object) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _file_digest(path: Path) -> str:
    try:
        return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as error:
        _fail(f"cannot read {path}: {error}")
    raise AssertionError("unreachable")


def _json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        _fail(f"cannot read {label} {path}: {error}")
    except json.JSONDecodeError as error:
        _fail(f"{label} {path} is invalid JSON: {error}")
    return _object(value, label)


def _safe_relative(root: Path, raw: object, label: str) -> Path:
    relative = _string(raw, label)
    candidate = Path(relative)
    if candidate.is_absolute() or any(part == ".." for part in candidate.parts):
        _fail(f"{label} must be a relative path inside the artifact root")
    resolved_root = root.resolve()
    resolved = (root / candidate).resolve()
    try:
        resolved.relative_to(resolved_root)
    except ValueError:
        _fail(f"{label} escapes the artifact root")
    return resolved


def _unit_vector(value: object, label: str) -> tuple[float, float, float]:
    values = _list(value, label)
    if len(values) != 3:
        _fail(f"{label} must have exactly three components")
    vector = tuple(_finite(component, f"{label}[{index}]") for index, component in enumerate(values))
    norm = math.sqrt(sum(component * component for component in vector))
    if norm <= 0.0 or abs(norm - 1.0) > 1.0e-10:
        _fail(f"{label} must be a normalized non-zero vector")
    return vector


def _finite_vector(value: object, label: str) -> tuple[float, float, float]:
    values = _list(value, label)
    if len(values) != 3:
        _fail(f"{label} must have exactly three components")
    return tuple(_finite(component, f"{label}[{index}]") for index, component in enumerate(values))


def _dot(left: Iterable[float], right: Iterable[float]) -> float:
    return sum(a * b for a, b in zip(left, right))


def _within(actual: float, expected: float, *, rtol: float, atol: float) -> bool:
    return abs(actual - expected) <= atol + rtol * max(abs(actual), abs(expected))


def _source_hash(source: Path) -> str:
    try:
        return "sha256:" + hashlib.sha256(source.read_bytes()).hexdigest()
    except OSError as error:
        _fail(f"cannot read selected probe source {source}: {error}")
    raise AssertionError("unreachable")


def _hash_matches(value: object, expected: str, label: str) -> None:
    if not isinstance(value, str) or value not in {expected, expected.removeprefix("sha256:")}:
        _fail(f"{label} does not match the selected source")


def _source_contract(metadata: dict[str, Any], source_sha: str) -> dict[str, Any]:
    problem_meta = _object(metadata.get("problem_meta"), "metadata.problem_meta")
    runtime = _object(problem_meta.get("runtime_metadata"), "metadata.problem_meta.runtime_metadata")
    contract = _object(runtime.get("mixed_p1_operator_probe"), "source mixed-P1 probe metadata")
    if contract.get("schema_version") != "fem_disconnected_mixed_p1_operator_probe.v1":
        _fail("source mixed-P1 probe metadata has an unexpected schema")
    if contract.get("status") != "requested_not_verified":
        _fail("source probe metadata must remain an authoring request")
    body_ids = _list(contract.get("body_object_ids"), "source body_object_ids")
    if len(body_ids) != 2 or any(not isinstance(value, str) for value in body_ids) or len(set(body_ids)) != 2:
        _fail("source body_object_ids must contain two distinct IDs")
    body_contract = _object(contract.get("body_material_contract"), "source body_material_contract")
    if set(body_contract) != set(body_ids):
        _fail("source body material contract coverage is incomplete")
    for object_id, raw_body in body_contract.items():
        body = _object(raw_body, f"source body_material_contract.{object_id}")
        for key in ("Ms_A_per_m", "Aex_J_per_m", "alpha", "Ku1_J_per_m3"):
            _finite(body.get(key), f"source body_material_contract.{object_id}.{key}")
        _unit_vector(body.get("anisotropy_axis"), f"source body_material_contract.{object_id}.anisotropy_axis")
        _unit_vector(body.get("m_unit"), f"source body_material_contract.{object_id}.m_unit")
    b_ext = _list(contract.get("uniform_external_field_B_T"), "source uniform_external_field_B_T")
    if len(b_ext) != 3 or max(abs(_finite(value, "source B_ext")) for value in b_ext) <= 0.0:
        _fail("source uniform external field must be a non-zero 3-vector")
    if "source_hash" in contract:
        _hash_matches(contract["source_hash"], source_sha, "source contract source_hash")
    return {"contract": contract, "body_contract": body_contract, "B_ext_T": tuple(_finite(value, "source B_ext") for value in b_ext), "body_ids": tuple(body_ids)}


def _certificate(
    metadata: dict[str, Any],
    source: dict[str, Any],
    mesh: dict[str, Any],
) -> tuple[dict[str, Any], str, dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[str, Any]]:
    mesh_summary = _object(metadata.get("mesh"), "mesh metadata")
    topology = _digest(mesh_summary.get("topology_fingerprint"), "mesh.topology_fingerprint")
    report = _object(mesh_summary.get("mesh_build_report"), "mesh build report")
    if report.get("fallbacks_triggered") not in ([], None) or report.get("degraded") is True:
        _fail("mesh build report contains a fallback or degraded realization")
    certificate = report.get("mixed_layer_topology_certificate_v2")
    if certificate is None:
        _fail("metadata has no mixed_layer_topology_certificate_v2")
    certificate = _object(certificate, "mixed v2 topology certificate")
    if certificate.get("schema_version") != EXPECTED_CERTIFICATE_SCHEMA or certificate.get("certificate_status") != "accepted":
        _fail("mixed v2 topology certificate is not accepted")
    certificate_topology = _digest(
        certificate.get("topology_fingerprint"),
        "mixed v2 certificate topology_fingerprint",
    )
    typed_mesh_topology = _mixed_topology_fingerprint_v3(mesh["raw"])
    if certificate_topology != typed_mesh_topology:
        _fail("mixed v2 certificate topology fingerprint is not bound to typed mesh")
    if certificate.get("fallbacks_triggered", []) != []:
        _fail("mixed v2 certificate contains a fallback")
    for key in ("marker_coverage_complete", "nonconforming_face_count", "orphan_face_count", "nonmanifold_face_count", "coincident_interface_face_count"):
        if key == "marker_coverage_complete" and certificate.get(key) is not True:
            _fail("mixed v2 certificate marker coverage is incomplete")
        if key != "marker_coverage_complete" and certificate.get(key) != 0:
            _fail(f"mixed v2 certificate {key} must be zero")

    regions = _list(certificate.get("magnetic_regions"), "mixed v2 magnetic_regions")
    if len(regions) != 2:
        _fail("the focused probe requires exactly two magnetic regions")
    region_by_id: dict[str, dict[str, Any]] = {}
    for raw in regions:
        region = _object(raw, "mixed v2 magnetic region")
        object_id = _string(region.get("object_id"), "mixed v2 region.object_id")
        if object_id in region_by_id:
            _fail(f"mixed v2 region {object_id!r} is duplicated")
        marker = region.get("body_marker")
        material_marker = region.get("material_marker")
        if not isinstance(marker, int) or marker <= 0 or not isinstance(material_marker, int) or material_marker <= 0:
            _fail(f"mixed v2 region {object_id!r} has invalid markers")
        counts = _object(region.get("cell_family_counts"), f"mixed v2 {object_id} cell_family_counts")
        if not counts or any(family not in {"prism6", "tet4"} or not isinstance(count, int) or count <= 0 for family, count in counts.items()):
            _fail(f"mixed v2 region {object_id!r} has invalid cell families")
        region_by_id[object_id] = region
    if list(region_by_id) != sorted(region_by_id) or set(region_by_id) != set(source["body_ids"]):
        _fail("realized body IDs are not the sorted source body IDs")
    families = [set(_object(region, "region").get("cell_family_counts", {})) for region in regions]
    if sorted(families, key=lambda value: sorted(value)) != [{"prism6"}, {"tet4"}]:
        _fail("the focused probe requires one prism6 body and one tet4 body")

    pairs = _list(certificate.get("body_separation_pairs"), "mixed v2 body_separation_pairs")
    if len(pairs) != 1:
        _fail("the focused probe requires one body separation pair")
    pair = _object(pairs[0], "mixed v2 body separation pair")
    body_a = _string(pair.get("body_a"), "mixed v2 pair.body_a")
    body_b = _string(pair.get("body_b"), "mixed v2 pair.body_b")
    if (body_a, body_b) != tuple(sorted((body_a, body_b))) or {body_a, body_b} != set(region_by_id):
        _fail("mixed v2 separation pair does not cover the two bodies")
    if pair.get("contact_state") != "separated" or _positive(pair.get("min_gap_m"), "mixed v2 pair.min_gap_m") <= 0.0:
        _fail("mixed v2 pair must prove a positive separated gap")

    materials = _list(certificate.get("body_material_fields"), "mixed v2 body_material_fields")
    if len(materials) != 2:
        _fail("the focused probe requires one material field per body")
    material_by_id: dict[str, dict[str, Any]] = {}
    required_domains = {"Ms", "Aex", "alpha", "Ku1", "anisotropy_axis"}
    for raw in materials:
        material = _object(raw, "mixed v2 body material field")
        object_id = _string(material.get("object_id"), "body material object_id")
        if object_id in material_by_id or object_id not in region_by_id:
            _fail(f"body material field {object_id!r} is duplicated or unknown")
        if material.get("field_basis") != "body_owned_p1":
            _fail(f"body material field {object_id!r} is not body_owned_p1")
        domains = _list(material.get("coefficient_domains"), f"body material {object_id} coefficient_domains")
        if not required_domains.issubset(domains):
            _fail(f"body material field {object_id!r} omits a required coefficient domain")
        if material.get("air_interpolation_policy") != "forbidden" or material.get("cross_body_interpolation_policy") != "forbidden":
            _fail(f"body material field {object_id!r} permits forbidden interpolation")
        _digest(material.get("node_order_digest"), f"body material {object_id} node_order_digest")
        _digest(material.get("field_digest"), f"body material {object_id} field_digest")
        values = _object(material.get("values"), f"body material {object_id} values")
        _positive(values.get("Ms"), f"body material {object_id}.Ms")
        _positive(values.get("Aex"), f"body material {object_id}.Aex")
        if _finite(values.get("alpha"), f"body material {object_id}.alpha") < 0.0:
            _fail(f"body material {object_id}.alpha must be non-negative")
        _finite(values.get("Ku1"), f"body material {object_id}.Ku1")
        _unit_vector(values.get("anisotropy_axis"), f"body material {object_id}.anisotropy_axis")
        material_by_id[object_id] = material
    if set(material_by_id) != set(region_by_id) or list(material_by_id) != sorted(material_by_id):
        _fail("mixed v2 body material field coverage/order is incomplete")

    for object_id, raw_authored in source["body_contract"].items():
        authored = _object(raw_authored, f"source body contract {object_id}")
        values = _object(material_by_id[object_id].get("values"), f"certificate material {object_id} values")
        for certificate_key, source_key in (("Ms", "Ms_A_per_m"), ("Aex", "Aex_J_per_m"), ("alpha", "alpha"), ("Ku1", "Ku1_J_per_m3")):
            if _finite(values.get(certificate_key), f"certificate {object_id}.{certificate_key}") != _finite(authored.get(source_key), f"source {object_id}.{source_key}"):
                _fail(f"certificate material {object_id}.{certificate_key} differs from source contract")
        if _unit_vector(values.get("anisotropy_axis"), f"certificate {object_id}.anisotropy_axis") != _unit_vector(authored.get("anisotropy_axis"), f"source {object_id}.anisotropy_axis"):
            _fail(f"certificate anisotropy axis for {object_id} differs from source contract")

    return certificate, topology, region_by_id, material_by_id, {
        "pair": pair,
        "mesh_summary": mesh_summary,
        "certificate_topology": certificate_topology,
    }


def _pack_u8(value: int) -> bytes:
    return struct.pack("<B", value)


def _pack_u32(value: int) -> bytes:
    return struct.pack("<I", value)


def _pack_u64(value: int) -> bytes:
    return struct.pack("<Q", value)


def _pack_f64(value: object, label: str) -> bytes:
    number = _finite(value, label)
    bits = struct.unpack("<Q", struct.pack("<d", number))[0]
    return _pack_u64(bits)


def _write_string(buffer: bytearray, value: object, label: str) -> None:
    encoded = _string(value, label).encode("utf-8")
    buffer.extend(_pack_u64(len(encoded)))
    buffer.extend(encoded)


def _write_optional(buffer: bytearray, value: object, writer: Any) -> None:
    if value is None:
        buffer.extend(_pack_u8(0))
    else:
        buffer.extend(_pack_u8(1))
        writer(value)


def _mixed_topology_fingerprint_v3(mesh: dict[str, Any]) -> str:
    """Reproduce fullmag_ir's typed mixed-topology fingerprint v3."""

    nodes = _list(mesh.get("nodes"), "typed mesh fingerprint nodes")
    cells = _object(mesh.get("cells"), "typed mesh fingerprint cells")
    facets = _object(mesh.get("facets"), "typed mesh fingerprint facets")
    element_markers = _list(mesh.get("element_markers"), "typed mesh fingerprint element_markers")
    boundary_markers = _list(mesh.get("boundary_markers"), "typed mesh fingerprint boundary_markers")
    cell_types = _list(cells.get("types"), "typed mesh fingerprint cell types")
    cell_offsets = _list(cells.get("offsets"), "typed mesh fingerprint cell offsets")
    cell_nodes = _list(cells.get("nodes"), "typed mesh fingerprint cell nodes")
    cell_ordinals = _list(cells.get("global_ordinals"), "typed mesh fingerprint cell global_ordinals")
    cell_parts = _list(cells.get("mesh_parts"), "typed mesh fingerprint cell mesh_parts")
    facet_types = _list(facets.get("types"), "typed mesh fingerprint facet types")
    facet_roles = _list(facets.get("roles"), "typed mesh fingerprint facet roles")
    facet_offsets = _list(facets.get("offsets"), "typed mesh fingerprint facet offsets")
    facet_nodes = _list(facets.get("nodes"), "typed mesh fingerprint facet nodes")
    facet_ordinals = _list(facets.get("global_ordinals"), "typed mesh fingerprint facet global_ordinals")
    if len(cell_types) != len(element_markers) or len(cell_types) != len(cell_ordinals) or len(cell_types) != len(cell_parts):
        _fail("typed mesh fingerprint cell arrays have inconsistent lengths")
    if len(facet_types) != len(facet_roles) or len(facet_types) != len(facet_ordinals):
        _fail("typed mesh fingerprint facet arrays have inconsistent lengths")

    cell_type_codes = {"tet4": 1, "prism6": 2, "pyramid5": 3, "hex8": 4}
    cell_part_codes = {"magnetic": 1, "transition_air": 2, "far_air": 3}
    facet_type_codes = {"tri3": 1, "quad4": 2}
    facet_role_codes = {"exterior": 1, "material_interface": 2, "periodic_seam": 3}
    buffer = bytearray(b"fullmag:fem-mesh-topology-fingerprint:v3")
    buffer.extend(_pack_u64(len(nodes)))
    for index, raw_node in enumerate(nodes):
        node = _list(raw_node, f"typed mesh fingerprint node {index}")
        if len(node) != 3:
            _fail(f"typed mesh fingerprint node {index} must have three coordinates")
        for component in node:
            buffer.extend(_pack_f64(component, f"typed mesh fingerprint node {index}"))
    buffer.extend(_pack_u64(len(cell_types)))
    for index, family in enumerate(cell_types):
        name = _string(family, f"cell type {index}")
        if name not in cell_type_codes:
            _fail(f"typed mesh fingerprint cell type {name!r} is unknown")
        buffer.extend(_pack_u8(cell_type_codes[name]))
    buffer.extend(_pack_u64(len(cell_offsets)))
    for index, value in enumerate(cell_offsets):
        buffer.extend(_pack_u32(_strict_nonnegative_int(value, f"cell offset {index}")))
    buffer.extend(_pack_u64(len(cell_nodes)))
    for index, value in enumerate(cell_nodes):
        buffer.extend(_pack_u32(_strict_nonnegative_int(value, f"cell node {index}")))
    buffer.extend(_pack_u64(len(cell_ordinals)))
    for index, value in enumerate(cell_ordinals):
        buffer.extend(_pack_u64(_strict_nonnegative_int(value, f"cell global ordinal {index}")))
    buffer.extend(_pack_u64(len(cell_parts)))
    for index, part in enumerate(cell_parts):
        name = _string(part, f"cell mesh_part {index}")
        if name not in cell_part_codes:
            _fail(f"typed mesh fingerprint cell mesh_part {name!r} is unknown")
        buffer.extend(_pack_u8(cell_part_codes[name]))
    buffer.extend(_pack_u64(len(element_markers)))
    for index, value in enumerate(element_markers):
        buffer.extend(_pack_u32(_strict_nonnegative_int(value, f"element marker {index}")))
    buffer.extend(_pack_u64(len(facet_types)))
    for index, family in enumerate(facet_types):
        name = _string(family, f"facet type {index}")
        if name not in facet_type_codes:
            _fail(f"typed mesh fingerprint facet type {name!r} is unknown")
        buffer.extend(_pack_u8(facet_type_codes[name]))
    buffer.extend(_pack_u64(len(facet_roles)))
    for index, role in enumerate(facet_roles):
        name = _string(role, f"facet role {index}")
        if name not in facet_role_codes:
            _fail(f"typed mesh fingerprint facet role {name!r} is unknown")
        buffer.extend(_pack_u8(facet_role_codes[name]))
    buffer.extend(_pack_u64(len(facet_offsets)))
    for index, value in enumerate(facet_offsets):
        buffer.extend(_pack_u32(_strict_nonnegative_int(value, f"facet offset {index}")))
    buffer.extend(_pack_u64(len(facet_nodes)))
    for index, value in enumerate(facet_nodes):
        buffer.extend(_pack_u32(_strict_nonnegative_int(value, f"facet node {index}")))
    buffer.extend(_pack_u64(len(facet_ordinals)))
    for index, value in enumerate(facet_ordinals):
        buffer.extend(_pack_u64(_strict_nonnegative_int(value, f"facet global ordinal {index}")))
    buffer.extend(_pack_u64(len(boundary_markers)))
    for index, value in enumerate(boundary_markers):
        buffer.extend(_pack_u32(_strict_nonnegative_int(value, f"boundary marker {index}")))

    periodic_boundary_pairs = _list(mesh.get("periodic_boundary_pairs", []), "periodic boundary pairs")
    buffer.extend(_pack_u64(len(periodic_boundary_pairs)))
    for index, raw_pair in enumerate(periodic_boundary_pairs):
        pair = _object(raw_pair, f"periodic boundary pair {index}")
        _write_string(buffer, pair.get("pair_id"), f"periodic boundary pair {index}.pair_id")
        _write_optional(buffer, pair.get("source_marker"), lambda value: _write_string(buffer, value, "source_marker"))
        _write_optional(buffer, pair.get("destination_marker"), lambda value: _write_string(buffer, value, "destination_marker"))
        buffer.extend(_pack_u32(_strict_nonnegative_int(pair.get("marker_a", 0), f"periodic pair {index}.marker_a")))
        buffer.extend(_pack_u32(_strict_nonnegative_int(pair.get("marker_b", 0), f"periodic pair {index}.marker_b")))
        translation = pair.get("translation")
        if translation is not None:
            values = _list(translation, f"periodic pair {index}.translation")
            if len(values) != 3:
                _fail(f"periodic pair {index}.translation must have three components")
            _write_optional(buffer, values, lambda values: [buffer.extend(_pack_f64(value, f"periodic pair {index}.translation")) for value in values])
        else:
            _write_optional(buffer, None, lambda _value: None)
        _write_optional(buffer, pair.get("tolerance"), lambda value: buffer.extend(_pack_f64(value, f"periodic pair {index}.tolerance")))
        for key in ("axis_hint", "orientation", "pairing_policy"):
            _write_optional(buffer, pair.get(key), lambda value, key=key: _write_string(buffer, value, f"periodic pair {index}.{key}"))

    periodic_node_pairs = _list(mesh.get("periodic_node_pairs", []), "periodic node pairs")
    buffer.extend(_pack_u64(len(periodic_node_pairs)))
    for index, raw_pair in enumerate(periodic_node_pairs):
        pair = _object(raw_pair, f"periodic node pair {index}")
        _write_string(buffer, pair.get("pair_id"), f"periodic node pair {index}.pair_id")
        buffer.extend(_pack_u32(_strict_nonnegative_int(pair.get("node_a"), f"periodic node pair {index}.node_a")))
        buffer.extend(_pack_u32(_strict_nonnegative_int(pair.get("node_b"), f"periodic node pair {index}.node_b")))
    return "sha256:" + hashlib.sha256(buffer).hexdigest()


def _node_order_digest(node_indices: Iterable[int]) -> str:
    ordered = sorted(set(node_indices))
    payload = bytearray(b"fullmag:fem-body-node-order:v1")
    payload.extend(_pack_u32(len(ordered)))
    for node in ordered:
        payload.extend(_pack_u64(node))
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _encode_material_value(value: object) -> bytes:
    if value is None:
        return b"n"
    if isinstance(value, bool):
        return b"b1" if value else b"b0"
    if isinstance(value, int):
        return b"i" + struct.pack("<q", value)
    if isinstance(value, float):
        if not math.isfinite(value):
            _fail("material field digest contains non-finite value")
        return b"f" + struct.pack("<d", value)
    if isinstance(value, str):
        encoded = value.encode("utf-8")
        return b"s" + _pack_u32(len(encoded)) + encoded
    if isinstance(value, list):
        return b"a" + _pack_u32(len(value)) + b"".join(_encode_material_value(item) for item in value)
    if isinstance(value, dict):
        encoded_items = []
        for key, item in sorted(((str(key), item) for key, item in value.items()), key=lambda pair: pair[0]):
            key_bytes = key.encode("utf-8")
            encoded_items.append(_pack_u32(len(key_bytes)) + key_bytes + _encode_material_value(item))
        return b"m" + _pack_u32(len(encoded_items)) + b"".join(encoded_items)
    _fail(f"material field digest contains unsupported value type {type(value).__name__}")
    raise AssertionError("unreachable")


def _material_field_digest(material: dict[str, Any], certificate_topology: str, body_marker: int, material_marker: int) -> str:
    fields = {
        "object_id": material["object_id"],
        "field_basis": material["field_basis"],
        "coefficient_domains": material["coefficient_domains"],
        "air_interpolation_policy": material["air_interpolation_policy"],
        "cross_body_interpolation_policy": material["cross_body_interpolation_policy"],
        "node_order_digest": material["node_order_digest"],
        "topology_fingerprint_version": "v3",
        "topology_fingerprint": certificate_topology,
        "body_marker": body_marker,
        "material_marker": material_marker,
        "component_units": {},
        "values": material["values"],
    }
    payload = bytearray(b"fullmag:fem-body-material-field:v1")
    for key in sorted(fields):
        encoded_key = key.encode("utf-8")
        payload.extend(_pack_u32(len(encoded_key)))
        payload.extend(encoded_key)
        payload.extend(_encode_material_value(fields[key]))
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _mesh_payload(metadata: dict[str, Any]) -> tuple[dict[str, Any], str]:
    execution_plan = _object(metadata.get("execution_plan"), "execution_plan")
    backend_plan = _object(execution_plan.get("backend_plan"), "execution_plan.backend_plan")
    if backend_plan.get("kind") != "fem":
        _fail("execution_plan.backend_plan.kind must be fem")
    mesh = _object(backend_plan.get("mesh"), "execution_plan.backend_plan.mesh")
    nodes = _list(mesh.get("nodes"), "typed FEM mesh nodes")
    if not nodes:
        _fail("typed FEM mesh nodes are required for the independent mass oracle")
    for index, raw in enumerate(nodes):
        vector = _list(raw, f"typed FEM node {index}")
        if len(vector) != 3 or any(not math.isfinite(float(value)) for value in vector):
            _fail(f"typed FEM node {index} is not a finite 3-vector")
    cells = _object(mesh.get("cells"), "typed FEM mesh cells")
    types = _list(cells.get("types"), "typed FEM cell types")
    offsets = _list(cells.get("offsets"), "typed FEM cell offsets")
    flat_nodes = _list(cells.get("nodes"), "typed FEM cell nodes")
    markers = _list(mesh.get("element_markers"), "typed FEM element_markers")
    global_ordinals = _list(cells.get("global_ordinals"), "typed FEM cell global_ordinals")
    mesh_parts = _list(cells.get("mesh_parts"), "typed FEM cell mesh_parts")
    if len(offsets) != len(types) + 1 or len(markers) != len(types) or len(global_ordinals) != len(types) or len(mesh_parts) != len(types) or not offsets or offsets[0] != 0:
        _fail("typed FEM mesh cell CSR arrays are inconsistent")
    if offsets[-1] != len(flat_nodes):
        _fail("typed FEM mesh cell CSR offsets do not cover connectivity")
    cells_out: list[dict[str, Any]] = []
    for index, raw_type in enumerate(types):
        if not isinstance(raw_type, str):
            _fail(f"typed FEM cell type {index} must be a string")
        start = _strict_nonnegative_int(offsets[index], f"typed FEM cell offset {index}")
        end = _strict_nonnegative_int(offsets[index + 1], f"typed FEM cell offset {index + 1}")
        if end < start or end > len(flat_nodes):
            _fail(f"typed FEM cell {index} has invalid CSR range")
        cell_nodes = []
        for position, raw_node in enumerate(flat_nodes[start:end]):
            node = _strict_nonnegative_int(raw_node, f"typed FEM cell {index} node {position}")
            if node >= len(nodes):
                _fail(f"typed FEM cell {index} references an out-of-range node")
            cell_nodes.append(node)
        marker = _strict_nonnegative_int(markers[index], f"typed FEM element marker {index}")
        ordinal = _strict_nonnegative_int(global_ordinals[index], f"typed FEM cell global ordinal {index}")
        part = _string(mesh_parts[index], f"typed FEM cell mesh_part {index}")
        if part not in {"magnetic", "transition_air", "far_air"}:
            _fail(f"typed FEM cell {index} has an unknown mesh part")
        if (part == "magnetic") != (marker != 0):
            _fail(f"typed FEM cell {index} has inconsistent magnetic marker/mesh part")
        cells_out.append({"type": raw_type, "nodes": cell_nodes, "marker": marker, "global_ordinal": ordinal, "mesh_part": part})
    if not cells_out:
        _fail("typed FEM mesh has no cells")
    return {"nodes": nodes, "cells": cells_out, "raw": mesh}, _canonical_json_digest(mesh)


def _tet_volume(nodes: list[list[Any]], indices: list[int]) -> float:
    a, b, c, d = (tuple(_finite(value, "mesh coordinate") for value in nodes[index]) for index in indices)
    ab = tuple(b[i] - a[i] for i in range(3))
    ac = tuple(c[i] - a[i] for i in range(3))
    ad = tuple(d[i] - a[i] for i in range(3))
    cross = (ac[1] * ad[2] - ac[2] * ad[1], ac[2] * ad[0] - ac[0] * ad[2], ac[0] * ad[1] - ac[1] * ad[0])
    determinant = ab[0] * cross[0] + ab[1] * cross[1] + ab[2] * cross[2]
    volume = abs(determinant) / 6.0
    if not math.isfinite(volume) or volume <= 0.0:
        _fail("typed FEM mesh contains a non-positive tet Jacobian")
    return volume


def _cell_volume(nodes: list[list[Any]], cell_type: str, indices: list[int]) -> float:
    if cell_type == "tet4":
        if len(indices) != 4:
            _fail("tet4 cell does not contain four nodes")
        return _tet_volume(nodes, indices)
    if cell_type == "prism6":
        if len(indices) != 6:
            _fail("prism6 cell does not contain six nodes")
        return sum(_tet_volume(nodes, list(tet)) for tet in ((indices[0], indices[1], indices[2], indices[3]), (indices[1], indices[2], indices[4], indices[3]), (indices[2], indices[4], indices[5], indices[3])))
    _fail(f"magnetic mixed-P1 cell family {cell_type!r} is not tet4 or prism6")
    raise AssertionError("unreachable")


def _body_masses(mesh: dict[str, Any], regions: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    by_marker = {int(region["body_marker"]): object_id for object_id, region in regions.items()}
    result = {object_id: {"volume_m3": 0.0, "node_weights_m3": {}, "node_indices": [], "cell_family_counts": {}} for object_id in regions}
    for cell in mesh["cells"]:
        object_id = by_marker.get(cell["marker"])
        if object_id is None:
            continue
        volume = _cell_volume(mesh["nodes"], cell["type"], cell["nodes"])
        body = result[object_id]
        body["volume_m3"] += volume
        body["cell_family_counts"][cell["type"]] = body["cell_family_counts"].get(cell["type"], 0) + 1
        share = volume / len(cell["nodes"])
        for node in cell["nodes"]:
            body["node_weights_m3"][node] = body["node_weights_m3"].get(node, 0.0) + share
    for object_id, body in result.items():
        if body["volume_m3"] <= 0.0 or not body["node_weights_m3"]:
            _fail(f"typed FEM mesh has no positive magnetic mass for body {object_id}")
        expected = _object(regions[object_id].get("cell_family_counts"), f"certificate {object_id} cell_family_counts")
        if body["cell_family_counts"] != {key: int(value) for key, value in expected.items()}:
            _fail(f"typed FEM mesh cell-family counts disagree for body {object_id}")
        body["node_indices"] = sorted(body["node_weights_m3"])
    node_sets = [set(body["node_indices"]) for body in result.values()]
    if len(node_sets[0] & node_sets[1]) != 0:
        _fail("disconnected magnetic bodies share a mesh node")
    return result


def _read_initial_m(artifacts: Path, source_hash: str, engine: str, node_count: int) -> tuple[list[tuple[float, float, float]], str]:
    path = artifacts / "m_initial.json"
    payload = _json(path, "m_initial artifact")
    provenance = _object(payload.get("provenance"), "m_initial provenance")
    _hash_matches(provenance.get("source_hash"), source_hash, "m_initial provenance source_hash")
    if provenance.get("execution_engine") != engine or provenance.get("precision") != "double":
        _fail("m_initial provenance does not match the resolved native lane")
    values = _list(payload.get("values"), "m_initial.values")
    if len(values) != node_count:
        _fail("m_initial.values length differs from typed mesh node count")
    vectors = [_finite_vector(raw, f"m_initial.values[{index}]") for index, raw in enumerate(values)]
    return vectors, _file_digest(path)


def _tree_digest(path: Path) -> str:
    if not path.is_dir():
        _fail(f"field artifact {path} must be a directory")
    digest = hashlib.sha256()
    files = sorted(item for item in path.rglob("*") if item.is_file())
    if not files:
        _fail(f"field artifact {path} is empty")
    for item in files:
        relative = item.relative_to(path).as_posix().encode("utf-8")
        data = item.read_bytes()
        digest.update(len(relative).to_bytes(8, "little"))
        digest.update(relative)
        digest.update(len(data).to_bytes(8, "little"))
        digest.update(data)
    return "sha256:" + digest.hexdigest()


def _read_zarr_step0(artifacts: Path, quantity: str, source_hash: str, engine: str, node_count: int) -> tuple[list[tuple[float, float, float]], dict[str, Any]]:
    store = artifacts / "fields" / f"{quantity}.zarr"
    attrs = _json(store / ".zattrs", f"{quantity} Zarr attributes")
    if attrs.get("observable") != quantity or attrs.get("unit") != "A/m" or attrs.get("axes") != ["sample", "component", "cell"] or attrs.get("component_order") != ["x", "y", "z"]:
        _fail(f"{quantity} Zarr attributes do not describe a canonical vector field")
    provenance = _object(attrs.get("provenance"), f"{quantity} Zarr provenance")
    if provenance.get("problem_name") != EXPECTED_PROBLEM_NAME or provenance.get("execution_engine") != engine or provenance.get("precision") != "double":
        _fail(f"{quantity} Zarr provenance does not match the native run")
    _hash_matches(provenance.get("source_hash"), source_hash, f"{quantity} Zarr source_hash")
    zarray = _json(store / ".zarray", f"{quantity} Zarr array metadata")
    shape = _list(zarray.get("shape"), f"{quantity} Zarr shape")
    if zarray.get("zarr_format") != 2 or len(shape) != 3 or shape[1:] != [3, node_count] or zarray.get("dtype") != "<f8" or zarray.get("compressor") is not None or zarray.get("order") != "C" or zarray.get("dimension_separator") != ".":
        _fail(f"{quantity} Zarr array metadata is not canonical binary64 SoA")
    try:
        with (store / "samples.csv").open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
    except OSError as error:
        _fail(f"cannot read {quantity} samples.csv: {error}")
    row = next((value for value in rows if value.get("step") == "0"), None)
    if row is None or row.get("chunk_key") != "0.0.0" or row.get("dtype") != "<f8" or row.get("cell_count") != str(node_count):
        _fail(f"{quantity} Zarr has no canonical step-0 sample")
    chunk = store / "0.0.0"
    try:
        data = chunk.read_bytes()
    except OSError as error:
        _fail(f"cannot read {quantity} Zarr step-0 chunk: {error}")
    if len(data) != 3 * node_count * 8:
        _fail(f"{quantity} Zarr step-0 payload has the wrong byte count")
    flat = struct.unpack(f"<{3 * node_count}d", data)
    # ZarrFieldSeriesWriter declares ``soa_component_major`` and writes all
    # x values, then all y values, then all z values.  Keep this conversion
    # explicit; interpreting the payload as interleaved xyz would silently
    # compare the wrong vector at every node.
    vectors = [
        tuple(flat[component * node_count + index] for component in range(3))
        for index in range(node_count)
    ]
    if any(not all(math.isfinite(component) for component in vector) for vector in vectors):
        _fail(f"{quantity} Zarr step-0 contains non-finite values")
    return vectors, {"sha256": _tree_digest(store), "node_count": node_count, "path": f"fields/{quantity}.zarr"}


def _read_step0_scalars(artifacts: Path) -> dict[str, float]:
    path = artifacts / "scalars.csv"
    try:
        with path.open(newline="", encoding="utf-8") as stream:
            reader = csv.DictReader(stream)
            missing = set(REQUIRED_SCALARS) - set(reader.fieldnames or ())
            if missing:
                _fail(f"scalars.csv is missing required operator columns: {sorted(missing)}")
            rows = list(reader)
    except OSError as error:
        _fail(f"cannot read scalars.csv: {error}")
    row = next((value for value in rows if value.get("step") == "0"), None)
    if row is None:
        _fail("scalars.csv does not contain a persisted step-0 row")
    result = {name: _finite(row.get(name), f"scalars.csv step-0 {name}") for name in REQUIRED_SCALARS}
    result["E_demag"] = _finite(row.get("E_demag"), "scalars.csv step-0 E_demag")
    return result


def _validate_metadata(artifacts: Path, source_path: Path, device: str) -> dict[str, Any]:
    metadata = _json(artifacts / "metadata.json", "runtime metadata")
    if metadata.get("problem_name") != EXPECTED_PROBLEM_NAME or metadata.get("status") != "completed":
        _fail("runtime metadata is not a completed mixed-P1 probe run")
    source_sha = _source_hash(source_path)
    _hash_matches(metadata.get("source_hash"), source_sha, "metadata.source_hash")
    requested = _object(metadata.get("requested_execution"), "requested execution")
    expected_requested = {"backend": "fem", "device": device, "precision": "double", "mode": "strict", "fallback_policy": "forbidden"}
    if requested != expected_requested:
        _fail(f"requested_execution must equal {expected_requested}")
    provenance = _object(metadata.get("execution_provenance"), "execution provenance")
    expected_engine = "fem_cpu_native" if device == "cpu" else "fem_native_gpu"
    if provenance.get("execution_engine") != expected_engine or provenance.get("precision") != "double" or provenance.get("lossy_fallback_used") is not False or provenance.get("ignored_terms", []) != []:
        _fail("execution provenance does not prove the requested no-fallback double lane")
    source = _source_contract(metadata, source_sha)
    mesh, mesh_digest = _mesh_payload(metadata)
    certificate, topology, regions, materials, extra = _certificate(metadata, source, mesh)
    node_count = _strict_nonnegative_int(extra["mesh_summary"].get("node_count"), "mesh.node_count")
    element_count = _strict_nonnegative_int(extra["mesh_summary"].get("element_count"), "mesh.element_count")
    if len(mesh["nodes"]) != node_count:
        _fail("typed mesh node count differs from runtime mesh summary")
    if len(mesh["cells"]) != element_count:
        _fail("typed mesh element count differs from runtime mesh summary")
    plan = _object(_object(metadata.get("execution_plan"), "execution_plan").get("backend_plan"), "backend plan")
    plan_field = plan.get("external_field")
    if plan_field is None:
        _fail("execution plan external_field is missing")
    external_field_h = tuple(_finite(value, "execution plan external_field") for value in _list(plan_field, "execution plan external_field"))
    if len(external_field_h) != 3 or any(not _within(external_field_h[index], source["B_ext_T"][index] / MU0_T_M_PER_A, rtol=1.0e-12, atol=1.0e-6) for index in range(3)):
        _fail("execution plan external_field (H, A/m) differs from source B_ext (T)")
    return {"metadata": metadata, "source": source, "source_sha": source_sha, "engine": expected_engine, "certificate": certificate, "topology": topology, "certificate_topology": extra["certificate_topology"], "regions": regions, "materials": materials, "mesh": mesh, "mesh_digest": mesh_digest, "pair": extra["pair"], "provenance": provenance, "external_field_H_Apm": external_field_h}


def _validate_run(source: Path, artifacts: Path, device: str) -> dict[str, Any]:
    identity = _validate_metadata(artifacts, source, device)
    masses = _body_masses(identity["mesh"], identity["regions"])
    for object_id, body in masses.items():
        material = identity["materials"][object_id]
        expected_node_digest = _node_order_digest(body["node_indices"])
        if material.get("node_order_digest") != expected_node_digest:
            _fail(f"certificate material node_order_digest is not bound to realized body nodes for {object_id}")
        region_sweep = identity["regions"][object_id].get("exact_sweep")
        if region_sweep is not None and region_sweep.get("node_order_digest") != expected_node_digest:
            _fail(f"certificate exact_sweep node_order_digest is not bound to realized body nodes for {object_id}")
        body_marker = int(identity["regions"][object_id]["body_marker"])
        material_marker = int(identity["regions"][object_id]["material_marker"])
        if material.get("field_digest") != _material_field_digest(material, identity["certificate_topology"], body_marker, material_marker):
            _fail(f"certificate material field_digest is not bound to its canonical values for {object_id}")
    vectors, initial_sha = _read_initial_m(artifacts, identity["source_sha"], identity["engine"], len(identity["mesh"]["nodes"]))
    fields: dict[str, list[tuple[float, float, float]]] = {}
    receipts: dict[str, dict[str, Any]] = {}
    for quantity in REQUIRED_FIELDS:
        fields[quantity], receipts[quantity] = _read_zarr_step0(artifacts, quantity, identity["source_sha"], identity["engine"], len(identity["mesh"]["nodes"]))
    for quantity in OPTIONAL_FIELDS:
        if (artifacts / "fields" / f"{quantity}.zarr").is_dir():
            fields[quantity], receipts[quantity] = _read_zarr_step0(artifacts, quantity, identity["source_sha"], identity["engine"], len(identity["mesh"]["nodes"]))
    scalars = _read_step0_scalars(artifacts)
    body_contract = identity["source"]["body_contract"]
    for object_id, body in masses.items():
        authored = _object(body_contract[object_id], f"source body contract {object_id}")
        m_expected = _unit_vector(authored.get("m_unit"), f"source {object_id}.m_unit")
        for node in body["node_indices"]:
            actual = vectors[node]
            if any(abs(actual[index] - m_expected[index]) > STATE_ATOL for index in range(3)):
                _fail(f"m_initial does not match the body-owned state for {object_id}")
            if "H_ext" in fields:
                expected_h = identity["external_field_H_Apm"]
                if any(not _within(fields["H_ext"][node][index], expected_h[index], rtol=FIELD_RTOL, atol=FIELD_ATOL_APM) for index in range(3)):
                    _fail(f"H_ext is not the requested uniform field for {object_id}")
    max_h_ex = max(abs(component) for body in masses.values() for node in body["node_indices"] for component in fields["H_ex"][node])
    if max_h_ex > EXCHANGE_FIELD_ATOL_APM:
        _fail(f"persisted H_ex is non-zero for constant disconnected-body state: {max_h_ex} A/m")

    analytic_ext = 0.0
    analytic_ani = 0.0
    body_summary: dict[str, Any] = {}
    for object_id, body in masses.items():
        material = _object(identity["materials"][object_id].get("values"), f"certificate material {object_id} values")
        authored = _object(body_contract[object_id], f"source body contract {object_id}")
        m_unit = _unit_vector(authored.get("m_unit"), f"source {object_id}.m_unit")
        axis = _unit_vector(material.get("anisotropy_axis"), f"certificate {object_id}.anisotropy_axis")
        volume = body["volume_m3"]
        zeeman = -MU0_T_M_PER_A * _finite(material.get("Ms"), f"certificate {object_id}.Ms") * volume * _dot(m_unit, identity["external_field_H_Apm"])
        anis = -_finite(material.get("Ku1"), f"certificate {object_id}.Ku1") * volume * (_dot(m_unit, axis) ** 2)
        analytic_ext += zeeman
        analytic_ani += anis
        body_summary[object_id] = {"volume_m3": volume, "node_count": len(body["node_indices"]), "cell_family_counts": body["cell_family_counts"], "analytic_E_ext_J": zeeman, "analytic_E_ani_J": anis}
    if not _within(scalars["E_ext"], analytic_ext, rtol=ENERGY_RTOL, atol=ENERGY_ATOL_J):
        _fail(f"step-0 E_ext disagrees with the independent P1 volume oracle: observed={scalars['E_ext']} expected={analytic_ext}")
    if not _within(scalars["E_ani"], analytic_ani, rtol=ENERGY_RTOL, atol=ENERGY_ATOL_J):
        _fail(f"step-0 E_ani disagrees with the independent P1 volume oracle: observed={scalars['E_ani']} expected={analytic_ani}")
    exchange_energy_bound = max(ENERGY_ATOL_J, 1.0e-8 * max(abs(scalars["E_ext"]), abs(scalars["E_ani"]), ENERGY_ATOL_J))
    if abs(scalars["E_ex"]) > exchange_energy_bound:
        _fail(f"step-0 E_ex is non-zero for constant disconnected bodies: {scalars['E_ex']} J > {exchange_energy_bound} J")
    return {"schema_version": SUMMARY_SCHEMA_VERSION, "status": "accepted", "qualification_status": "operator_probe_accepted_not_production_qualified", "device": device, "execution_engine": identity["engine"], "source_sha256": identity["source_sha"], "topology_fingerprint": identity["topology"], "certificate_topology_fingerprint": identity["certificate_topology"], "mesh_digest": identity["mesh_digest"], "initial_state_sha256": initial_sha, "certificate_sha256": _canonical_json_digest(identity["certificate"]), "body_ids": sorted(masses), "bodies": body_summary, "scalars_step0": scalars, "field_receipts": receipts, "field_values": fields, "mass_values": masses, "exchange_zero_bounds": {"energy_J": exchange_energy_bound, "field_A_per_m": EXCHANGE_FIELD_ATOL_APM}, "optional_fields_missing": [quantity for quantity in OPTIONAL_FIELDS if quantity not in fields]}


def _compare_fields(cpu: dict[str, Any], gpu: dict[str, Any], quantity: str, nodes: list[int]) -> dict[str, float]:
    left = cpu["field_values"].get(quantity)
    right = gpu["field_values"].get(quantity)
    if left is None or right is None:
        return {"available": 0.0}
    max_delta = 0.0
    sum_sq = 0.0
    count = 0
    for node in nodes:
        for axis in range(3):
            delta = abs(left[node][axis] - right[node][axis])
            max_delta = max(max_delta, delta)
            sum_sq += delta * delta
            count += 1
    scale = max(max(abs(left[node][axis]) for node in nodes for axis in range(3)), max(abs(right[node][axis]) for node in nodes for axis in range(3)))
    allowed = STATE_ATOL if quantity == "m" else FIELD_ATOL_APM + FIELD_RTOL * scale
    if max_delta > allowed:
        _fail(f"CPU/GPU {quantity} mismatch: {max_delta} > {allowed}")
    return {"available": 1.0, "max_component_abs_delta": max_delta, "rms_component_abs_delta": math.sqrt(sum_sq / max(count, 1)), "allowed_delta": allowed}


def compare_artifacts(source: Path, cpu_artifacts: Path, gpu_artifacts: Path) -> dict[str, Any]:
    cpu = _validate_run(source, cpu_artifacts, "cpu")
    gpu = _validate_run(source, gpu_artifacts, "gpu")
    for key in ("source_sha256", "topology_fingerprint", "certificate_topology_fingerprint", "mesh_digest", "certificate_sha256"):
        if cpu[key] != gpu[key]:
            _fail(f"CPU/GPU {key} differs")
    if cpu["body_ids"] != gpu["body_ids"]:
        _fail("CPU/GPU body ownership differs")
    for object_id in cpu["body_ids"]:
        left = cpu["bodies"][object_id]
        right = gpu["bodies"][object_id]
        if not _within(left["volume_m3"], right["volume_m3"], rtol=MASS_RTOL, atol=MASS_ATOL_M3):
            _fail(f"CPU/GPU body {object_id} P1 volume differs")
    nodes = sorted({node for body in cpu["mass_values"].values() for node in body["node_indices"]})
    comparisons = {
        quantity: _compare_fields(cpu, gpu, quantity, nodes)
        for quantity in ("H_ex", "H_demag", "H_eff")
    }
    for name in ("E_ex", "E_ext", "E_ani", "E_total"):
        if not _within(cpu["scalars_step0"][name], gpu["scalars_step0"][name], rtol=ENERGY_RTOL, atol=ENERGY_ATOL_J):
            _fail(f"CPU/GPU step-0 {name} differs beyond the project energy bound")
    return {"schema_version": "fem_disconnected_mixed_p1_cpu_gpu_comparison.v2", "status": "accepted", "qualification_status": "operator_probe_accepted_not_production_qualified", "source_sha256": cpu["source_sha256"], "topology_fingerprint": cpu["topology_fingerprint"], "mesh_digest": cpu["mesh_digest"], "cpu_engine": cpu["execution_engine"], "gpu_engine": gpu["execution_engine"], "body_ids": cpu["body_ids"], "field_comparison": comparisons, "energy_relative_tolerance": ENERGY_RTOL}


def validate_artifacts(source: Path, artifacts: Path, *, device: str) -> dict[str, Any]:
    if device not in {"cpu", "gpu"}:
        _fail("device must be cpu or gpu")
    if not source.is_file():
        _fail(f"selected probe source does not exist: {source}")
    return _validate_run(source, artifacts, device)


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate = subparsers.add_parser("validate")
    validate.add_argument("source", type=Path)
    validate.add_argument("artifacts", type=Path)
    validate.add_argument("--device", choices=("cpu", "gpu"), required=True)
    validate.add_argument("--output", type=Path, required=True)
    compare = subparsers.add_parser("compare")
    compare.add_argument("source", type=Path)
    compare.add_argument("--cpu-artifacts", type=Path, required=True)
    compare.add_argument("--gpu-artifacts", type=Path, required=True)
    compare.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "validate":
            result = validate_artifacts(args.source, args.artifacts, device=args.device)
        else:
            result = compare_artifacts(args.source, args.cpu_artifacts, args.gpu_artifacts)
        _write_json(args.output, result)
        print(json.dumps({"status": result["status"], "output": str(args.output)}, sort_keys=True))
        return 0
    except (ContractError, OSError, ValueError) as error:
        print(f"operator probe verification failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
