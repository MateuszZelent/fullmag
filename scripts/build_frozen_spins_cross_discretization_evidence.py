#!/usr/bin/env python3
"""Validate and persist Frozen Spins cross-discretization evidence.

The input is produced by the Rust ``fullmag-plan`` example.  This validator is
deliberately independent of the Rust process: it checks the persisted
materialization contract, the physical measure calculation, and the
refinement sequence before emitting a release-ledger-friendly receipt.

The validator compares the authored selector/semantics identities and physical
measures.  It intentionally does *not* compare resolved FDM/FEM mask hashes
across lanes: those hashes identify different DOF orderings and are checked
against independently regenerated masks only within their own row.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import struct
from pathlib import Path
from typing import Any, Sequence


INPUT_SCHEMA = "fullmag.frozen_spins.cross_discretization.materialization.v1"
OUTPUT_SCHEMA = "fullmag.frozen_spins.cross_discretization.evidence.v1"
EXPECTED_EVALUATORS = {
    "fdm": "selection.fdm_cell_center.v1",
    "fem": "selection.fem_true_dof.any_incident_magnetic.v1",
}
EXPECTED_CONSTRAINT_ID = "cross_discretization_slab"
EXPECTED_CONSTRAINT_NAME = "Cross-discretization slab"
EXPECTED_FUNCTIONS = {
    "fdm": "compile_fdm_frozen_spins",
    "fem": "compile_fem_frozen_spins",
}
EXPECTED_MEASURE_DEFINITIONS = {
    "fdm": "fdm_cell_volume_sum",
    "fem": "fem_p1_structured_tet4_nodal_control_volume_sum",
}
EXPECTED_REFINEMENTS = ("coarse", "medium", "fine")
EXPECTED_LEVELS = {name: index for index, name in enumerate(EXPECTED_REFINEMENTS)}
SHA256_LENGTH = 64
TOPOLOGY_FINGERPRINT_SCHEMA = "fullmag.frozen_spins.cross_discretization.topology.v2"
SEMANTICS_VERSION = "frozen_spins.cross_discretization.selector_semantics.v1"
SEMANTICS_HASH_ENCODING = "fullmag.frozen_spins.semantics.f64_bits.v1"
FINE_RELATIVE_ERROR_LIMIT = 0.03
MEASURE_RELATIVE_TOLERANCE = 1.0e-10
NUMERIC_RELATIVE_TOLERANCE = 1.0e-10


class EvidenceError(ValueError):
    """Raised when an input artifact cannot prove the cross-lane contract."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise EvidenceError(message)


def _object(value: Any, label: str) -> dict[str, Any]:
    _require(isinstance(value, dict), f"{label} must be an object")
    return value


def _array(value: Any, label: str) -> list[Any]:
    _require(isinstance(value, list), f"{label} must be an array")
    return value


def _string(value: Any, label: str) -> str:
    _require(isinstance(value, str) and bool(value.strip()), f"{label} must be a non-empty string")
    return value


def _sha256(value: Any, label: str) -> str:
    value = _string(value, label).lower()
    canonical = value.removeprefix("sha256:")
    _require(
        len(canonical) == SHA256_LENGTH
        and all(character in "0123456789abcdef" for character in canonical),
        f"{label} must be a SHA-256 identity",
    )
    return canonical


def _positive_integer(value: Any, label: str) -> int:
    _require(
        isinstance(value, int) and not isinstance(value, bool) and value > 0,
        f"{label} must be a positive integer",
    )
    return value


def _nonnegative_integer(value: Any, label: str) -> int:
    _require(
        isinstance(value, int) and not isinstance(value, bool) and value >= 0,
        f"{label} must be a non-negative integer",
    )
    return value


def _finite_number(value: Any, label: str) -> float:
    _require(
        isinstance(value, (int, float)) and not isinstance(value, bool),
        f"{label} must be a number",
    )
    converted = float(value)
    _require(math.isfinite(converted), f"{label} must be finite")
    return converted


def _close(left: float, right: float, relative: float = NUMERIC_RELATIVE_TOLERANCE) -> bool:
    scale = max(abs(left), abs(right), 1.0e-300)
    return abs(left - right) <= relative * scale


def _f64_bits(value: Any, label: str) -> str:
    """Return the exact IEEE-754 binary64 bits used by the Rust producer."""

    number = _finite_number(value, label)
    bits = int.from_bytes(struct.pack(">d", number), byteorder="big", signed=False)
    return f"{bits:016x}"


def _canonicalize_f64_numbers(value: Any) -> Any:
    """Mirror the producer's f64-bits canonicalization recursively."""

    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return {"$fullmag_f64_bits": _f64_bits(value, "canonical semantics number")}
    if isinstance(value, list):
        return [_canonicalize_f64_numbers(item) for item in value]
    if isinstance(value, dict):
        return {key: _canonicalize_f64_numbers(item) for key, item in value.items()}
    raise EvidenceError("canonical semantics payload contains an unsupported JSON value")


def _canonical_json_bytes(value: Any) -> bytes:
    """Serialize a canonical JSON value exactly as required by the evidence contract."""

    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise EvidenceError(f"canonical semantics payload is not serializable: {error}") from error


def _hash_f64(value: float, hasher: Any) -> None:
    bits = int(_f64_bits(value, "materialized coordinate"), 16)
    hasher.update(bits.to_bytes(8, byteorder="little", signed=False))


def _fdm_grid_fingerprint(n: int, domain_length_m: float) -> str:
    """Regenerate the Rust producer's deterministic FDM cell-center hash."""

    cell = domain_length_m / n
    hasher = hashlib.sha256()
    hasher.update(b"fullmag.frozen_spins.cross_discretization.fdm_grid.v1")
    hasher.update(n.to_bytes(4, byteorder="little", signed=False))
    hasher.update(
        int(_f64_bits(domain_length_m, "FDM domain length"), 16).to_bytes(
            8, byteorder="little", signed=False
        )
    )
    for k in range(n):
        for j in range(n):
            for i in range(n):
                for index in (i, j, k):
                    _hash_f64((float(index) + 0.5) * cell, hasher)
    return hasher.hexdigest()


def _fem_points_fingerprint(n: int, domain_length_m: float) -> str:
    """Regenerate the Rust producer's structured P1 node-point hash."""

    hasher = hashlib.sha256()
    hasher.update(b"fullmag.frozen_spins.cross_discretization.fem_points.v1")
    hasher.update(((n + 1) ** 3).to_bytes(8, byteorder="little", signed=False))
    denominator = float(n)
    for k in range(n + 1):
        for j in range(n + 1):
            for i in range(n + 1):
                for index in (i, j, k):
                    _hash_f64(float(index) * domain_length_m / denominator, hasher)
    return hasher.hexdigest()


def _fem_node_index(i: int, j: int, k: int, n: int) -> int:
    side = n + 1
    return (k * side + j) * side + i


def _fem_connectivity_fingerprint(n: int) -> str:
    """Regenerate the Rust producer's ordered six-tet-per-cube connectivity hash."""

    hasher = hashlib.sha256()
    hasher.update(b"fullmag.frozen_spins.cross_discretization.fem_tet4_connectivity.v1")
    hasher.update(((n + 1) ** 3).to_bytes(8, byteorder="little", signed=False))
    element_count = 0
    for k in range(n):
        for j in range(n):
            for i in range(n):
                v000 = _fem_node_index(i, j, k, n)
                v100 = _fem_node_index(i + 1, j, k, n)
                v010 = _fem_node_index(i, j + 1, k, n)
                v110 = _fem_node_index(i + 1, j + 1, k, n)
                v001 = _fem_node_index(i, j, k + 1, n)
                v101 = _fem_node_index(i + 1, j, k + 1, n)
                v011 = _fem_node_index(i, j + 1, k + 1, n)
                v111 = _fem_node_index(i + 1, j + 1, k + 1, n)
                tetrahedra = (
                    (v000, v100, v110, v111),
                    (v000, v110, v010, v111),
                    (v000, v010, v011, v111),
                    (v000, v011, v001, v111),
                    (v000, v001, v101, v111),
                    (v000, v101, v100, v111),
                )
                for tetra in tetrahedra:
                    hasher.update(element_count.to_bytes(8, byteorder="little", signed=False))
                    for node in tetra:
                        hasher.update(node.to_bytes(8, byteorder="little", signed=False))
                    element_count += 1
    return hasher.hexdigest()


def _fem_tetrahedra(n: int):
    for k in range(n):
        for j in range(n):
            for i in range(n):
                v000 = _fem_node_index(i, j, k, n)
                v100 = _fem_node_index(i + 1, j, k, n)
                v010 = _fem_node_index(i, j + 1, k, n)
                v110 = _fem_node_index(i + 1, j + 1, k, n)
                v001 = _fem_node_index(i, j, k + 1, n)
                v101 = _fem_node_index(i + 1, j, k + 1, n)
                v011 = _fem_node_index(i, j + 1, k + 1, n)
                v111 = _fem_node_index(i + 1, j + 1, k + 1, n)
                yield from (
                    (v000, v100, v110, v111),
                    (v000, v110, v010, v111),
                    (v000, v010, v011, v111),
                    (v000, v011, v001, v111),
                    (v000, v001, v101, v111),
                    (v000, v101, v100, v111),
                )


def _tetra_volume(points: list[tuple[float, float, float]], tetra: tuple[int, int, int, int]) -> float:
    origin = points[tetra[0]]
    a = tuple(points[tetra[1]][axis] - origin[axis] for axis in range(3))
    b = tuple(points[tetra[2]][axis] - origin[axis] for axis in range(3))
    c = tuple(points[tetra[3]][axis] - origin[axis] for axis in range(3))
    cross = (
        b[1] * c[2] - b[2] * c[1],
        b[2] * c[0] - b[0] * c[2],
        b[0] * c[1] - b[1] * c[0],
    )
    return abs(a[0] * cross[0] + a[1] * cross[1] + a[2] * cross[2]) / 6.0


def _mask_sha256(mask: list[bool]) -> str:
    hasher = hashlib.sha256()
    hasher.update(len(mask).to_bytes(8, byteorder="little", signed=False))
    hasher.update(bytes(1 if selected else 0 for selected in mask))
    return hasher.hexdigest()


def _reference_sha256(mask: list[bool]) -> str:
    """Mirror the production reference digest for the materialized [1,0,0] vector."""

    hasher = hashlib.sha256()
    hasher.update(len(mask).to_bytes(8, byteorder="little", signed=False))
    reference_bits = (
        int(_f64_bits(1.0, "reference x"), 16).to_bytes(8, "little")
        + int(_f64_bits(0.0, "reference y"), 16).to_bytes(8, "little")
        + int(_f64_bits(0.0, "reference z"), 16).to_bytes(8, "little")
    )
    for selected in mask:
        hasher.update(bytes((1 if selected else 0,)))
        if selected:
            hasher.update(reference_bits)
    return hasher.hexdigest()


def _inside_box(point: tuple[float, float, float], expression: dict[str, Any]) -> bool:
    geometry = _object(expression.get("geometry"), "selector.geometry")
    center = _array(geometry.get("center_m"), "selector.geometry.center_m")
    size = _array(geometry.get("size_m"), "selector.geometry.size_m")
    boundary = _object(expression.get("boundary"), "selector.boundary")
    absolute_tolerance = _finite_number(boundary.get("absolute_tolerance_m"), "selector.absolute_tolerance_m")
    relative_tolerance = _finite_number(boundary.get("relative_tolerance"), "selector.relative_tolerance")
    for axis in range(3):
        value = abs(point[axis] - _finite_number(center[axis], f"selector.center_m[{axis}]"))
        limit = 0.5 * _finite_number(size[axis], f"selector.size_m[{axis}]")
        tolerance = absolute_tolerance + relative_tolerance * abs(limit)
        if value > limit + tolerance:
            return False
    return True


def _canonical_domain(
    backend: str,
    n: int,
    domain_length_m: float,
    selector: dict[str, Any],
    label: str,
) -> dict[str, Any]:
    """Regenerate canonical points, active domain, mask and physical weights."""

    expression = _object(selector.get("canonical_expression"), f"{label}.selector.canonical_expression")
    if backend == "fdm":
        cell = domain_length_m / n
        points = [
            ((float(i) + 0.5) * cell, (float(j) + 0.5) * cell, (float(k) + 0.5) * cell)
            for k in range(n)
            for j in range(n)
            for i in range(n)
        ]
        active = [True] * len(points)
        weights = [cell**3] * len(points)
        domain_measure = domain_length_m**3
    else:
        denominator = float(n)
        points = [
            (
                float(i) * domain_length_m / denominator,
                float(j) * domain_length_m / denominator,
                float(k) * domain_length_m / denominator,
            )
            for k in range(n + 1)
            for j in range(n + 1)
            for i in range(n + 1)
        ]
        incidence = [0] * len(points)
        weights = [0.0] * len(points)
        element_count = 0
        for tetra in _fem_tetrahedra(n):
            volume = _tetra_volume(points, tetra)
            _require(
                math.isfinite(volume) and volume > 0.0,
                f"{label}: regenerated FEM tet4 has a non-positive volume",
            )
            for node in tetra:
                incidence[node] += 1
                weights[node] += volume / 4.0
            element_count += 1
        _require(
            element_count == 6 * n**3 and sum(incidence) == element_count * 4,
            f"{label}: regenerated FEM connectivity cardinality is inconsistent",
        )
        active = [count > 0 for count in incidence]
        domain_measure = 0.0
        for weight in weights:
            domain_measure += weight

    mask = [active[index] and _inside_box(point, expression) for index, point in enumerate(points)]
    frozen_dof_count = sum(1 for selected in mask if selected)
    active_dof_count = sum(1 for is_active in active if is_active)
    free_dof_count = active_dof_count - frozen_dof_count
    selected_measure = 0.0
    for selected, weight in zip(mask, weights):
        if selected:
            selected_measure += weight
    lower = [math.inf, math.inf, math.inf]
    upper = [-math.inf, -math.inf, -math.inf]
    for point, selected in zip(points, mask):
        if not selected:
            continue
        for axis in range(3):
            lower[axis] = min(lower[axis], point[axis])
            upper[axis] = max(upper[axis], point[axis])
    _require(frozen_dof_count > 0, f"{label}: canonical selector selected no DOFs")
    return {
        "active_mask": active,
        "active_dof_count": active_dof_count,
        "domain_measure_m3": domain_measure,
        "free_dof_count": free_dof_count,
        "frozen_dof_count": frozen_dof_count,
        "mask": mask,
        "mask_sha256": _mask_sha256(mask),
        "reference_sha256": _reference_sha256(mask),
        "selected_measure_m3": selected_measure,
        "selected_bounds_m": [lower, upper],
        "selected_weight_count": frozen_dof_count,
    }


def _expected_topology_fingerprint(
    backend: str,
    n: int,
    materialization: dict[str, Any],
    domain_length_m: float,
    label: str,
) -> str:
    """Recompute the planner topology identity from materialized provenance."""

    materialized_grid: str | None = None
    materialized_points: str | None = None
    materialized_connectivity: str | None = None
    if backend == "fdm":
        declared_grid = _sha256(
            materialization.get("grid_materialization_fingerprint"),
            f"{label}.materialization.grid_materialization_fingerprint",
        )
        counts = _array(materialization.get("counts"), f"{label}.materialization.counts")
        _require(counts == [n, n, n], f"{label}: materialized FDM counts do not match resolution")
        grid_point_count = _positive_integer(
            materialization.get("grid_point_count"), f"{label}.materialization.grid_point_count"
        )
        _require(grid_point_count == n**3, f"{label}: materialized FDM point count is not n^3")
        cell = _array(materialization.get("cell_m"), f"{label}.materialization.cell_m")
        _require(len(cell) == 3, f"{label}: materialized FDM cell size must have 3 axes")
        for index, value in enumerate(cell):
            _require(
                _close(_finite_number(value, f"{label}.materialization.cell_m[{index}]"), domain_length_m / n),
                f"{label}: materialized FDM cell size is inconsistent with domain length/resolution",
            )
        materialized_grid = _fdm_grid_fingerprint(n, domain_length_m)
        _require(
            declared_grid == materialized_grid,
            f"{label}: declared FDM grid fingerprint does not match deterministic materialized cell centers",
        )
    else:
        declared_points = _sha256(
            materialization.get("points_fingerprint"),
            f"{label}.materialization.points_fingerprint",
        )
        declared_connectivity = _sha256(
            materialization.get("connectivity_fingerprint"),
            f"{label}.materialization.connectivity_fingerprint",
        )
        point_count = _positive_integer(
            materialization.get("point_count"), f"{label}.materialization.point_count"
        )
        _require(point_count == (n + 1) ** 3, f"{label}: materialized FEM point count is not (n+1)^3")
        element_count = _positive_integer(
            materialization.get("element_count"), f"{label}.materialization.element_count"
        )
        _require(element_count == 6 * n**3, f"{label}: materialized FEM element count is not six tet4 per cube")
        incident_records = _positive_integer(
            materialization.get("incident_element_records"),
            f"{label}.materialization.incident_element_records",
        )
        _require(
            incident_records == element_count * 4,
            f"{label}: materialized FEM incidence does not cover every tet4 node",
        )
        materialized_points = _fem_points_fingerprint(n, domain_length_m)
        materialized_connectivity = _fem_connectivity_fingerprint(n)
        _require(
            declared_points == materialized_points,
            f"{label}: declared FEM points fingerprint does not match deterministic node coordinates",
        )
        _require(
            declared_connectivity == materialized_connectivity,
            f"{label}: declared FEM connectivity fingerprint does not match deterministic six-tet connectivity",
        )

    payload = {
        "backend": backend,
        "domain_length_f64_bits": _f64_bits(domain_length_m, f"{label}.domain_length_m"),
        "materialized_connectivity_fingerprint": materialized_connectivity,
        "materialized_grid_fingerprint": materialized_grid,
        "materialized_points_fingerprint": materialized_points,
        "n": n,
        "schema_version": TOPOLOGY_FINGERPRINT_SCHEMA,
    }
    return hashlib.sha256(_canonical_json_bytes(payload)).hexdigest()


def _parse_input(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise EvidenceError(f"{label}: invalid UTF-8/JSON: {error}") from error
    return _object(value, f"{label}: root")


def _validate_canonical_semantics_value(value: Any, label: str) -> None:
    """Reject raw numbers or malformed IEEE-754 wrapper objects."""

    if isinstance(value, bool) or value is None or isinstance(value, str):
        return
    if isinstance(value, (int, float)):
        raise EvidenceError(f"{label} contains a raw number; canonical f64 bits are required")
    if isinstance(value, list):
        for index, item in enumerate(value):
            _validate_canonical_semantics_value(item, f"{label}[{index}]")
        return
    if isinstance(value, dict):
        if "$fullmag_f64_bits" in value:
            _require(
                set(value) == {"$fullmag_f64_bits"},
                f"{label} has an invalid f64-bits wrapper",
            )
            bits = value["$fullmag_f64_bits"]
            _require(
                isinstance(bits, str)
                and len(bits) == 16
                and all(character in "0123456789abcdef" for character in bits),
                f"{label} has an invalid f64 bit pattern",
            )
            return
        for key, item in value.items():
            _require(isinstance(key, str), f"{label} has a non-string object key")
            _validate_canonical_semantics_value(item, f"{label}.{key}")
        return
    raise EvidenceError(f"{label} contains an unsupported JSON value")


def _validate_semantics_payload(
    selector_input: dict[str, Any],
    selector: dict[str, Any],
    analytic: dict[str, Any],
    physical_contract: dict[str, Any],
    label: str,
) -> dict[str, Any]:
    """Prove that the semantics digest covers the complete selector contract."""

    payload = _object(selector_input.get("semantics_payload"), f"{label}.semantics_payload")
    _require(
        payload.get("hash_encoding") == SEMANTICS_HASH_ENCODING,
        f"{label}: unsupported semantics hash encoding",
    )
    _require(
        payload.get("semantics_version") == selector["semantics_version"] == SEMANTICS_VERSION,
        f"{label}: semantics payload/version mismatch",
    )
    _validate_canonical_semantics_value(payload, f"{label}.semantics_payload")
    expected_hash = hashlib.sha256(_canonical_json_bytes(payload)).hexdigest()
    _require(
        expected_hash == selector["semantics_fingerprint"],
        f"{label}: semantics fingerprint does not match canonical payload bytes",
    )

    constraint_payload = _object(payload.get("constraint"), f"{label}.semantics_payload.constraint")
    _require(
        constraint_payload.get("schema_version") == "frozen_spins.v1",
        f"{label}: semantics payload does not contain a FrozenSpinsIR schema",
    )
    _require(
        constraint_payload.get("id") == selector["root_constraint_id"] == EXPECTED_CONSTRAINT_ID,
        f"{label}: semantics payload constraint id is not the planner root constraint",
    )
    _require(
        constraint_payload.get("name") == EXPECTED_CONSTRAINT_NAME,
        f"{label}: semantics payload constraint name is not the canonical cross-discretization constraint",
    )
    _require(
        constraint_payload.get("enabled") is True,
        f"{label}: semantics payload constraint must be enabled",
    )
    _require(
        constraint_payload.get("reference") == {"kind": "capture_current_at_activation"}
        and constraint_payload.get("membership") == {"kind": "static"}
        and constraint_payload.get("activation") == {"kind": "all_stages"}
        and constraint_payload.get("empty_selection") == "error"
        and constraint_payload.get("inactive_selection") == "error",
        f"{label}: full FrozenSpinsIR reference/membership/activation policies are required",
    )
    _require(
        constraint_payload.get("selector") == _canonicalize_f64_numbers(selector["canonical_expression"]),
        f"{label}: semantics payload selector is not the canonical authored expression",
    )
    expression = _object(selector["canonical_expression"], f"{label}.selector.canonical_expression")
    _require(
        expression.get("kind") == "inside_geometry",
        f"{label}: selector expression must be the approved inside-geometry selector",
    )
    geometry = _object(expression.get("geometry"), f"{label}.selector.canonical_expression.geometry")
    _require(
        geometry.get("kind") == "box",
        f"{label}: selector geometry must be the approved box",
    )
    _require(
        _object(expression.get("frame"), f"{label}.selector.canonical_expression.frame").get("kind") == "world"
        and _object(expression.get("sampling"), f"{label}.selector.canonical_expression.sampling").get("kind") == "dof_point",
        f"{label}: selector must use world-frame DOF-point sampling",
    )
    boundary = _object(
        expression.get("boundary"), f"{label}.selector.canonical_expression.boundary"
    )
    _require(
        boundary.get("kind") == "inclusive"
        and _close(_finite_number(boundary.get("absolute_tolerance_m"), f"{label}.selector.absolute_tolerance_m"), 0.0)
        and _close(_finite_number(boundary.get("relative_tolerance"), f"{label}.selector.relative_tolerance"), 1.0e-12),
        f"{label}: selector boundary policy is not the canonical inclusive policy",
    )
    geometry_center = _array(geometry.get("center_m"), f"{label}.selector.geometry.center_m")
    geometry_size = _array(geometry.get("size_m"), f"{label}.selector.geometry.size_m")
    analytic_bounds = _array(analytic.get("bounds_m"), f"{label}.analytic_measure.bounds_m")
    analytic_lower = _array(analytic_bounds[0], f"{label}.analytic_measure.bounds_m[0]")
    analytic_upper = _array(analytic_bounds[1], f"{label}.analytic_measure.bounds_m[1]")
    _require(
        len(geometry_center) == len(geometry_size) == len(analytic_lower) == len(analytic_upper) == 3,
        f"{label}: selector/analytic geometry must be three-dimensional",
    )
    for index, (center, size, lower, upper) in enumerate(
        zip(geometry_center, geometry_size, analytic_lower, analytic_upper)
    ):
        center_value = _finite_number(center, f"{label}.selector.geometry.center_m[{index}]")
        size_value = _finite_number(size, f"{label}.selector.geometry.size_m[{index}]")
        lower_value = _finite_number(lower, f"{label}.analytic_measure.bounds_m[0][{index}]")
        upper_value = _finite_number(upper, f"{label}.analytic_measure.bounds_m[1][{index}]")
        _require(
            _close(center_value, (lower_value + upper_value) / 2.0)
            and _close(size_value, upper_value - lower_value),
            f"{label}: selector box is not the analytic physical-measure box",
        )
    _require(
        payload.get("analytic_measure") == _canonicalize_f64_numbers(analytic),
        f"{label}: semantics payload analytic-measure contract differs from the root contract",
    )
    _require(
        payload.get("physical_measure_contract") == physical_contract,
        f"{label}: semantics payload physical-measure contract differs from the root contract",
    )
    return payload


def _validate_row(
    row: Any,
    selector: dict[str, Any],
    analytic_measure_m3: float,
    domain_length_m: float,
    expected_refinement: str,
    expected_level: int,
) -> dict[str, Any]:
    row = _object(row, f"refinements[{expected_level}]")
    backend = _string(row.get("backend"), f"refinements[{expected_level}].backend")
    _require(backend in EXPECTED_EVALUATORS, f"unexpected backend {backend!r}")
    _require(
        row.get("refinement") == expected_refinement,
        f"{backend}: refinement order is not {expected_refinement!r}",
    )
    _require(
        row.get("refinement_level") == expected_level,
        f"{backend}/{expected_refinement}: refinement_level is not {expected_level}",
    )
    evaluator_id = _string(row.get("evaluator_id"), f"{backend}/{expected_refinement}.evaluator_id")
    _require(
        evaluator_id == EXPECTED_EVALUATORS[backend],
        f"{backend}/{expected_refinement}: unexpected planner evaluator {evaluator_id!r}",
    )
    row_authored_selector = _sha256(
        row.get("authored_selector_fingerprint"),
        f"{backend}/{expected_refinement}.authored_selector_fingerprint",
    )
    row_semantics_selector = _sha256(
        row.get("semantics_selector_fingerprint"),
        f"{backend}/{expected_refinement}.semantics_selector_fingerprint",
    )
    _require(
        row_authored_selector == selector["authored_fingerprint"]
        and row_semantics_selector == selector["semantics_fingerprint"],
        f"{backend}/{expected_refinement}: row selector fingerprint differs from the shared selector",
    )
    topology = _sha256(
        row.get("topology_fingerprint"),
        f"{backend}/{expected_refinement}.topology_fingerprint",
    )

    resolution = _array(row.get("resolution"), f"{backend}/{expected_refinement}.resolution")
    _require(len(resolution) == 3, f"{backend}/{expected_refinement}: resolution must have 3 axes")
    resolution = [_positive_integer(value, f"{backend}/{expected_refinement}.resolution[{index}]") for index, value in enumerate(resolution)]
    _require(resolution[0] == resolution[1] == resolution[2], f"{backend}/{expected_refinement}: only isotropic refinement is accepted")
    n = resolution[0]
    canonical_domain = _canonical_domain(
        backend,
        n,
        domain_length_m,
        selector,
        f"{backend}/{expected_refinement}",
    )

    materialized_dof_count = _positive_integer(
        row.get("materialized_dof_count"), f"{backend}/{expected_refinement}.materialized_dof_count"
    )
    active_dof_count = _positive_integer(
        row.get("active_dof_count"), f"{backend}/{expected_refinement}.active_dof_count"
    )
    frozen_dof_count = _nonnegative_integer(
        row.get("frozen_dof_count"), f"{backend}/{expected_refinement}.frozen_dof_count"
    )
    free_dof_count = _nonnegative_integer(
        row.get("free_dof_count"), f"{backend}/{expected_refinement}.free_dof_count"
    )
    _require(
        materialized_dof_count == canonical_domain["active_dof_count"]
        and active_dof_count == canonical_domain["active_dof_count"],
        f"{backend}/{expected_refinement}: materialized/active DOF cardinality does not match the regenerated canonical domain",
    )
    _require(
        frozen_dof_count == canonical_domain["frozen_dof_count"]
        and free_dof_count == canonical_domain["free_dof_count"],
        f"{backend}/{expected_refinement}: frozen/free counts do not match the regenerated canonical selection mask",
    )
    selected_weight_count = _positive_integer(
        row.get("selected_measure_weight_count"),
        f"{backend}/{expected_refinement}.selected_measure_weight_count",
    )
    _require(
        selected_weight_count == canonical_domain["selected_weight_count"] == frozen_dof_count,
        f"{backend}/{expected_refinement}: selected measure weights are not tied to the regenerated canonical selection mask",
    )

    _require(
        row.get("dof_measure_definition") == EXPECTED_MEASURE_DEFINITIONS[backend],
        f"{backend}/{expected_refinement}: physical measure definition is not the approved one",
    )
    materialization = _object(
        row.get("materialization"), f"{backend}/{expected_refinement}.materialization"
    )
    _require(
        materialization.get("source_kind") == "rust_production_planner_evaluator"
        and materialization.get("crate") == "fullmag-plan"
        and materialization.get("function") == EXPECTED_FUNCTIONS[backend]
        and materialization.get("evaluator_id") == evaluator_id
        and materialization.get("domain_materialized") is True
        and materialization.get("measure_weights_materialized") is True,
        f"{backend}/{expected_refinement}: materialization is not tied to the production planner evaluator",
    )
    materialized_domain_length = _finite_number(
        materialization.get("domain_length_m"),
        f"{backend}/{expected_refinement}.materialization.domain_length_m",
    )
    _require(
        _close(materialized_domain_length, domain_length_m),
        f"{backend}/{expected_refinement}: materialized domain length differs from analytic contract",
    )
    expected_topology = _expected_topology_fingerprint(
        backend,
        n,
        materialization,
        domain_length_m,
        f"{backend}/{expected_refinement}",
    )
    _require(
        topology == expected_topology,
        f"{backend}/{expected_refinement}: topology fingerprint is not bound to materialized grid/mesh provenance",
    )
    weight_unit = None
    if backend == "fdm":
        _require(row.get("mesh_element_count") is None, f"{backend}/{expected_refinement}: FDM cannot claim FEM elements")
        weight_unit = _finite_number(
            materialization.get("weight_unit_m3"),
            f"{backend}/{expected_refinement}.materialization.weight_unit_m3",
        )
        expected_weight_unit = (domain_length_m / n) ** 3
        _require(
            weight_unit > 0.0 and _close(weight_unit, expected_weight_unit),
            f"{backend}/{expected_refinement}: FDM cell weight does not match the regenerated grid cell volume",
        )
    else:
        mesh_element_count = _positive_integer(
            row.get("mesh_element_count"),
            f"{backend}/{expected_refinement}.mesh_element_count",
        )
        _require(
            materialization.get("fe_order") == 1
            and materialization.get("mesh_family") == "structured_cube_split_into_six_tet4",
            f"{backend}/{expected_refinement}: FEM materialization is not the approved P1/tet4 domain",
        )
        _require(
            materialization.get("weight_definition")
            == "lumped_p1_nodal_control_volume_sum_tet_volume_over_4",
            f"{backend}/{expected_refinement}: FEM weights are not the regenerated lumped P1 control volumes",
        )
        _require(
            mesh_element_count == 6 * n**3,
            f"{backend}/{expected_refinement}: FEM row element count is not six tet4 per cube",
        )

    resolved_plan = _object(row.get("resolved_plan"), f"{backend}/{expected_refinement}.resolved_plan")
    _require(
        resolved_plan.get("schema_version") == "resolved_frozen_spins_plan.v1",
        f"{backend}/{expected_refinement}: missing resolved frozen-spins plan schema",
    )
    _require(
        resolved_plan.get("grid_or_mesh_fingerprint") == row.get("topology_fingerprint"),
        f"{backend}/{expected_refinement}: resolved plan topology is not the materialized topology",
    )
    _require(
        resolved_plan.get("active_dof_count") == active_dof_count
        and resolved_plan.get("frozen_dof_count") == frozen_dof_count
        and resolved_plan.get("free_dof_count") == free_dof_count,
        f"{backend}/{expected_refinement}: resolved plan counts differ from the regenerated canonical domain",
    )
    _require(
        resolved_plan.get("constraint_ids") == [selector["root_constraint_id"]]
        and resolved_plan.get("source_state_revision") == 1
        and resolved_plan.get("all_active_dofs_frozen")
        == (canonical_domain["active_dof_count"] > 0 and canonical_domain["free_dof_count"] == 0),
        f"{backend}/{expected_refinement}: resolved plan identity/count flags are not canonical",
    )
    # Keep this identity row-local.  In particular, do not retain a value to
    # compare it against the other discretization's DOF ordering.
    plan_mask_sha256 = _sha256(
        resolved_plan.get("resolved_mask_sha256"),
        f"{backend}/{expected_refinement}.resolved_plan.resolved_mask_sha256",
    )
    _require(
        plan_mask_sha256 == canonical_domain["mask_sha256"],
        f"{backend}/{expected_refinement}: resolved plan mask hash does not match the regenerated canonical mask",
    )
    certificate = _object(
        resolved_plan.get("certificate"), f"{backend}/{expected_refinement}.resolved_plan.certificate"
    )
    _require(
        certificate.get("schema_version") == "selection_certificate.v1"
        and certificate.get("evaluator_id") == evaluator_id,
        f"{backend}/{expected_refinement}: certificate is not owned by the production evaluator",
    )
    _require(
        certificate.get("grid_or_mesh_fingerprint") == row.get("topology_fingerprint"),
        f"{backend}/{expected_refinement}: certificate topology is not the materialized topology",
    )
    authored_fingerprints = _array(
        certificate.get("authored_fingerprints"),
        f"{backend}/{expected_refinement}.certificate.authored_fingerprints",
    )
    _require(len(authored_fingerprints) == 1, f"{backend}/{expected_refinement}: exactly one selector is required")
    authored = _object(authored_fingerprints[0], f"{backend}/{expected_refinement}.authored_fingerprints[0]")
    _require(
        authored.get("constraint_id") == selector.get("root_constraint_id")
        and _sha256(authored.get("selector_sha256"), f"{backend}/{expected_refinement}.selector_sha256")
        == selector["authored_fingerprint"],
        f"{backend}/{expected_refinement}: planner authored fingerprint differs from the shared selector",
    )
    _positive_integer(
        certificate.get("source_state_revision"),
        f"{backend}/{expected_refinement}.certificate.source_state_revision",
    )
    _require(
        certificate.get("source_state_revision") == 1,
        f"{backend}/{expected_refinement}: certificate source state revision is not the canonical revision",
    )
    _require(
        certificate.get("constraint_ids") == [selector.get("root_constraint_id")],
        f"{backend}/{expected_refinement}: certificate constraint ownership is not canonical",
    )
    _require(
        certificate.get("active_dof_count") == canonical_domain["active_dof_count"]
        and certificate.get("frozen_dof_count") == canonical_domain["frozen_dof_count"]
        and certificate.get("free_dof_count") == canonical_domain["free_dof_count"]
        and certificate.get("raw_candidate_dof_count") == canonical_domain["frozen_dof_count"]
        and certificate.get("inactive_candidate_dof_count") == 0,
        f"{backend}/{expected_refinement}: certificate counts do not match the regenerated canonical mask",
    )
    certificate_mask_sha256 = _sha256(
        certificate.get("mask_sha256"),
        f"{backend}/{expected_refinement}.certificate.mask_sha256",
    )
    _require(
        certificate_mask_sha256 == canonical_domain["mask_sha256"],
        f"{backend}/{expected_refinement}: certificate mask hash does not match the regenerated canonical mask",
    )
    reference_sha256 = _sha256(
        certificate.get("resolved_reference_sha256"),
        f"{backend}/{expected_refinement}.certificate.resolved_reference_sha256",
    )
    _require(
        reference_sha256 == canonical_domain["reference_sha256"],
        f"{backend}/{expected_refinement}: certificate reference hash does not match the regenerated canonical reference",
    )
    certificate_bounds = _array(
        certificate.get("bounds_m"), f"{backend}/{expected_refinement}.certificate.bounds_m"
    )
    _require(len(certificate_bounds) == 2, f"{backend}/{expected_refinement}: certificate bounds need lower and upper corners")
    for bound_index, (actual_bound, expected_bound) in enumerate(
        zip(certificate_bounds, canonical_domain["selected_bounds_m"])
    ):
        actual_bound = _array(actual_bound, f"{backend}/{expected_refinement}.certificate.bounds_m[{bound_index}]")
        _require(len(actual_bound) == 3, f"{backend}/{expected_refinement}: certificate bounds must be 3D")
        for axis, (actual, expected) in enumerate(zip(actual_bound, expected_bound)):
            _require(
                _close(
                    _finite_number(actual, f"{backend}/{expected_refinement}.certificate.bounds_m[{bound_index}][{axis}]"),
                    expected,
                ),
                f"{backend}/{expected_refinement}: certificate bounds do not match regenerated selected points",
            )

    domain_measure = _finite_number(
        row.get("domain_measure_m3"), f"{backend}/{expected_refinement}.domain_measure_m3"
    )
    selected_measure = _finite_number(
        row.get("selected_measure_m3"), f"{backend}/{expected_refinement}.selected_measure_m3"
    )
    selected_error = _finite_number(
        row.get("selected_measure_error_abs_m3"),
        f"{backend}/{expected_refinement}.selected_measure_error_abs_m3",
    )
    selected_relative_error = _finite_number(
        row.get("selected_measure_relative_error"),
        f"{backend}/{expected_refinement}.selected_measure_relative_error",
    )
    _require(domain_measure > 0.0 and selected_measure > 0.0, f"{backend}/{expected_refinement}: physical measures must be positive")
    _require(
        _close(domain_measure, canonical_domain["domain_measure_m3"]),
        f"{backend}/{expected_refinement}: domain physical measure does not match regenerated control volumes",
    )
    _require(
        _close(selected_measure, canonical_domain["selected_measure_m3"]),
        f"{backend}/{expected_refinement}: selected physical measure does not match regenerated mask weights",
    )
    expected_error = abs(selected_measure - analytic_measure_m3)
    _require(
        _close(selected_error, expected_error),
        f"{backend}/{expected_refinement}: selected measure error is not derived from the analytic measure",
    )
    _require(
        _close(selected_relative_error, expected_error / analytic_measure_m3),
        f"{backend}/{expected_refinement}: relative measure error is not derived from the analytic measure",
    )
    if backend == "fdm":
        _require(
            _close(selected_measure, selected_weight_count * weight_unit),
            f"{backend}/{expected_refinement}: selected measure is not the selected cell-volume sum",
        )

    return {
        "backend": backend,
        "refinement": expected_refinement,
        "refinement_level": expected_level,
        "evaluator_id": evaluator_id,
        "authored_selector_fingerprint": row_authored_selector,
        "semantics_selector_fingerprint": row_semantics_selector,
        "topology_fingerprint": topology,
        "resolution": resolution,
        "materialized_dof_count": materialized_dof_count,
        "active_dof_count": active_dof_count,
        "frozen_dof_count": frozen_dof_count,
        "free_dof_count": free_dof_count,
        "selected_measure_m3": selected_measure,
        "selected_measure_error_abs_m3": selected_error,
        "selected_measure_relative_error": selected_relative_error,
        "domain_measure_m3": domain_measure,
        "selected_measure_weight_count": selected_weight_count,
        "mesh_element_count": row.get("mesh_element_count"),
        "dof_measure_definition": row["dof_measure_definition"],
        "resolved_plan": resolved_plan,
        "materialization": materialization,
    }


def build_evidence(raw_bytes: bytes, input_label: str = "materialization") -> dict[str, Any]:
    """Validate a Rust materialization artifact and return a receipt."""

    root = _parse_input(raw_bytes, input_label)
    _require(root.get("schema_version") == INPUT_SCHEMA, f"{input_label}: schema must be {INPUT_SCHEMA}")
    _require(root.get("status") == "PASS", f"{input_label}: producer status must be PASS")
    producer = _object(root.get("producer"), f"{input_label}.producer")
    _require(
        producer.get("kind") == "rust_production_planner_evaluator"
        and producer.get("crate") == "fullmag-plan"
        and _string(producer.get("command"), f"{input_label}.producer.command").startswith("cargo run -p fullmag-plan"),
        f"{input_label}: artifact is not produced by the fullmag-plan evaluator workflow",
    )

    selector_input = _object(root.get("selector"), f"{input_label}.selector")
    selector_authored = _sha256(
        selector_input.get("authored_fingerprint"), f"{input_label}.selector.authored_fingerprint"
    )
    selector_semantics = _sha256(
        selector_input.get("semantics_fingerprint"), f"{input_label}.selector.semantics_fingerprint"
    )
    selector = {
        "authored_fingerprint": selector_authored,
        "semantics_fingerprint": selector_semantics,
        "semantics_version": _string(
            selector_input.get("semantics_version"), f"{input_label}.selector.semantics_version"
        ),
        "root_constraint_id": _string(
            selector_input.get("root_constraint_id"), f"{input_label}.selector.root_constraint_id"
        ),
        "canonical_expression": _object(
            selector_input.get("canonical_expression"), f"{input_label}.selector.canonical_expression"
        ),
    }
    _require(
        selector["semantics_version"] == SEMANTICS_VERSION,
        f"{input_label}: unsupported selector semantics version",
    )

    analytic = _object(root.get("analytic_measure"), f"{input_label}.analytic_measure")
    domain_length_m = _finite_number(
        analytic.get("domain_length_m"), f"{input_label}.analytic_measure.domain_length_m"
    )
    _require(domain_length_m > 0.0, f"{input_label}: analytic domain length must be positive")
    analytic_measure_m3 = _finite_number(analytic.get("value_m3"), f"{input_label}.analytic_measure.value_m3")
    _require(analytic_measure_m3 > 0.0, f"{input_label}: analytic measure must be positive")
    bounds = _array(analytic.get("bounds_m"), f"{input_label}.analytic_measure.bounds_m")
    _require(len(bounds) == 2, f"{input_label}: analytic bounds need lower and upper corners")
    lower = _array(bounds[0], f"{input_label}.analytic_measure.bounds_m[0]")
    upper = _array(bounds[1], f"{input_label}.analytic_measure.bounds_m[1]")
    _require(len(lower) == 3 and len(upper) == 3, f"{input_label}: analytic bounds must be 3D")
    lower = [_finite_number(value, f"{input_label}.analytic_measure.lower[{index}]") for index, value in enumerate(lower)]
    upper = [_finite_number(value, f"{input_label}.analytic_measure.upper[{index}]") for index, value in enumerate(upper)]
    _require(
        all(0.0 <= left < right <= domain_length_m for left, right in zip(lower, upper)),
        f"{input_label}: analytic box bounds must be strictly increasing and inside the materialized domain",
    )
    computed_analytic = math.prod(right - left for left, right in zip(lower, upper))
    _require(_close(analytic_measure_m3, computed_analytic), f"{input_label}: analytic measure does not match its box formula")
    _require(analytic.get("geometry") == "box", f"{input_label}: analytic geometry must be the approved box")

    physical_contract = _object(root.get("physical_measure_contract"), f"{input_label}.physical_measure_contract")
    _require(
        physical_contract.get("unit") == "m^3"
        and physical_contract.get("method") == "sum_selected_dof_control_volumes"
        and physical_contract.get("cross_lane_resolved_mask_sha256_comparison") == "NOT_PERFORMED",
        f"{input_label}: physical-measure contract is incomplete or compares cross-lane mask hashes",
    )
    selector["semantics_payload"] = _validate_semantics_payload(
        selector_input,
        selector,
        {
            **analytic,
            "domain_length_m": domain_length_m,
        },
        physical_contract,
        input_label,
    )

    refinement_rows = _array(root.get("refinements"), f"{input_label}.refinements")
    _require(len(refinement_rows) == 6, f"{input_label}: exactly six refinement rows are required")
    validated_rows: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for raw_row in refinement_rows:
        row_object = _object(raw_row, f"{input_label}.refinement")
        backend = row_object.get("backend")
        refinement = row_object.get("refinement")
        _require(isinstance(backend, str) and isinstance(refinement, str), f"{input_label}: each row needs backend/refinement")
        key = (backend, refinement)
        _require(key not in seen, f"{input_label}: duplicate refinement row {key!r}")
        seen.add(key)
        _require(refinement in EXPECTED_LEVELS, f"{input_label}: unexpected refinement {refinement!r}")
        validated_rows.append(
            _validate_row(
                raw_row,
                selector,
                analytic_measure_m3,
                domain_length_m,
                refinement,
                EXPECTED_LEVELS[refinement],
            )
        )
    _require(
        seen == {(backend, refinement) for backend in EXPECTED_EVALUATORS for refinement in EXPECTED_REFINEMENTS},
        f"{input_label}: rows must cover FDM and FEM at coarse/medium/fine",
    )

    convergence: dict[str, dict[str, Any]] = {}
    for backend in EXPECTED_EVALUATORS:
        rows = sorted(
            (row for row in validated_rows if row["backend"] == backend),
            key=lambda row: row["refinement_level"],
        )
        previous_resolution = 0
        previous_measure = 0.0
        previous_error = math.inf
        for row in rows:
            resolution = row["resolution"][0]
            measure = row["selected_measure_m3"]
            error = row["selected_measure_error_abs_m3"]
            _require(resolution > previous_resolution, f"{backend}: refinement resolution is not strictly increasing")
            _require(measure > previous_measure, f"{backend}: physical selected measure is not strictly increasing")
            _require(error < previous_error, f"{backend}: error to analytic measure is not strictly decreasing")
            _require(
                measure <= analytic_measure_m3 * (1.0 + MEASURE_RELATIVE_TOLERANCE),
                f"{backend}: refinement crossed above the analytic measure; convergence is not one-sided",
            )
            previous_resolution = resolution
            previous_measure = measure
            previous_error = error
        fine = rows[-1]
        _require(
            fine["selected_measure_relative_error"] <= FINE_RELATIVE_ERROR_LIMIT,
            f"{backend}: fine refinement relative error exceeds {FINE_RELATIVE_ERROR_LIMIT:.3f}",
        )
        convergence[backend] = {
            "refinement_levels": [row["refinement"] for row in rows],
            "resolutions": [row["resolution"][0] for row in rows],
            "selected_measure_m3": [row["selected_measure_m3"] for row in rows],
            "absolute_error_m3": [row["selected_measure_error_abs_m3"] for row in rows],
            "relative_error": [row["selected_measure_relative_error"] for row in rows],
            "monotone_measure": True,
            "monotone_error_to_analytic": True,
            "fine_relative_error_limit": FINE_RELATIVE_ERROR_LIMIT,
        }

    # Physical measure is the cross-discretization comparison.  DOF counts and
    # resolved mask hashes intentionally do not appear in this comparison.
    cross_measure_differences: list[float] = []
    for refinement in EXPECTED_REFINEMENTS:
        fdm = next(row for row in validated_rows if row["backend"] == "fdm" and row["refinement"] == refinement)
        fem = next(row for row in validated_rows if row["backend"] == "fem" and row["refinement"] == refinement)
        difference = abs(fdm["selected_measure_m3"] - fem["selected_measure_m3"])
        scale = max(abs(fdm["selected_measure_m3"]), abs(fem["selected_measure_m3"]), 1.0e-300)
        _require(
            difference / scale <= MEASURE_RELATIVE_TOLERANCE,
            f"{refinement}: FDM/FEM physical measures differ beyond tolerance",
        )
        cross_measure_differences.append(difference)

    digest = hashlib.sha256(raw_bytes).hexdigest()
    return {
        "schema_version": OUTPUT_SCHEMA,
        "evidence_id": f"frozen-spins-cross-discretization-{digest}",
        "status": "PASS",
        "implementation_status": "EXECUTED_PLANNER_MATERIALIZATION",
        "qualification_status": "UNQUALIFIED",
        "qualification_blocker": "clean_source_identity_and_remaining_p15_matrix_not_bound",
        "test_case_ids": ["FS-P15-CROSS-DISCRETIZATION"],
        "contracts": {
            "production_planner_materialization": "PASS",
            "shared_authored_selector_fingerprint": "PASS",
            "shared_selector_semantics_fingerprint": "PASS",
            "physical_measure_unit_m3": "PASS",
            "fdm_coarse_medium_fine": "PASS",
            "fem_coarse_medium_fine": "PASS",
            "fdm_monotone_convergence_to_analytic": "PASS",
            "fem_monotone_convergence_to_analytic": "PASS",
            "physical_measure_cross_discretization_parity": "PASS",
            "resolved_mask_sha256_cross_discretization_comparison": "NOT_PERFORMED",
        },
        "selector": selector,
        "analytic_measure": {
            "domain_length_m": domain_length_m,
            "value_m3": analytic_measure_m3,
            "bounds_m": [lower, upper],
            "formula": analytic.get("formula"),
        },
        "convergence": convergence,
        "refinements": validated_rows,
        "input_artifact": {
            "path": input_label,
            "bytes": len(raw_bytes),
            "sha256": digest,
        },
        "cross_measure_absolute_differences_m3": cross_measure_differences,
    }


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp.{os.getpid()}")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args(argv)
    try:
        raw_bytes = arguments.input.read_bytes()
        try:
            input_label = arguments.input.resolve().relative_to(Path.cwd().resolve()).as_posix()
        except ValueError:
            input_label = arguments.input.as_posix()
        evidence = build_evidence(raw_bytes, input_label=input_label)
        write_json_atomic(arguments.output, evidence)
    except (OSError, EvidenceError) as error:
        print(f"FROZEN_SPINS_CROSS_DISCRETIZATION_EVIDENCE_ERROR={error}")
        return 2
    print(json.dumps({"output": arguments.output.as_posix(), "status": "PASS", "test_case_id": "FS-P15-CROSS-DISCRETIZATION"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
