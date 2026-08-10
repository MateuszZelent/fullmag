#!/usr/bin/env python3
"""Independent Newell/cubature parity check for fresh FDM multilayer artifacts.

The production CPU runtime is deliberately treated as a black box here.  This
module contains its own rectangular-prism Newell primitive and an independent
Gauss--Legendre double-volume cubature.  It only consumes runtime artifacts;
it never creates a production run or imports the Rust/kernel builder.
"""

from __future__ import annotations

import argparse
import csv
import itertools
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence


MU0 = 4.0 * math.pi * 1.0e-7
QUALIFICATION_SCOPE = "SP4-derived, not canonical SP4 qualification"
SCHEMA_VERSION = "fdm_multilayer_independent_oracle.v1"
FIELD_RTOL = 1.0e-8
FIELD_ATOL_A_PER_M = 1.0e-6
ENERGY_RTOL = 1.0e-8
ENERGY_ATOL_J = 1.0e-30
RECIPROCITY_RTOL = 1.0e-10
RECIPROCITY_ATOL = 1.0e-30
CUBATURE_RTOL = 5.0e-7
CUBATURE_ATOL = 1.0e-12

GL8_NODES = (
    -0.9602898564975363,
    -0.7966664774136267,
    -0.525532409916329,
    -0.1834346424956498,
    0.1834346424956498,
    0.525532409916329,
    0.7966664774136263,
    0.9602898564975363,
)
GL8_WEIGHTS = (
    0.1012285362903763,
    0.2223810344533745,
    0.3137066458778873,
    0.362683783378362,
    0.362683783378362,
    0.3137066458778873,
    0.2223810344533745,
    0.1012285362903763,
)


class OracleError(ValueError):
    """Raised when runtime provenance or numerical input is not trustworthy."""


def _fail(message: str) -> None:
    raise OracleError(message)


def _finite(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"{name} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        _fail(f"{name} must be a finite number")
    return result


def _positive(value: Any, name: str) -> float:
    result = _finite(value, name)
    if result <= 0.0:
        _fail(f"{name} must be positive")
    return result


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        _fail(f"missing runtime artifact: {path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _fail(f"unreadable JSON runtime artifact {path}: {exc}")
    if not isinstance(payload, dict):
        _fail(f"runtime artifact must be a JSON object: {path}")
    return payload


def _require(condition: bool, message: str) -> None:
    if not condition:
        _fail(message)


def _vec3(value: Any, name: str) -> tuple[float, float, float]:
    _require(isinstance(value, (list, tuple)) and len(value) == 3, f"{name} must be a 3-vector")
    return tuple(_finite(component, f"{name}[{index}]") for index, component in enumerate(value))  # type: ignore[return-value]


def _cell3(value: Any, name: str) -> tuple[float, float, float]:
    _require(isinstance(value, (list, tuple)) and len(value) == 3, f"{name} must have three components")
    return tuple(_positive(component, f"{name}[{index}]") for index, component in enumerate(value))  # type: ignore[return-value]


def _grid3(value: Any, name: str) -> tuple[int, int, int]:
    _require(isinstance(value, (list, tuple)) and len(value) == 3, f"{name} must have three components")
    grid: list[int] = []
    for index, component in enumerate(value):
        _require(
            isinstance(component, int) and not isinstance(component, bool) and component > 0,
            f"{name}[{index}] must be a positive integer",
        )
        grid.append(component)
    return tuple(grid)  # type: ignore[return-value]


# These two primitives are copied from the published Newell--Williams--Dunlop
# equations, but are implemented independently in Python.  In particular, no
# production Rust function or generated kernel is imported by this verifier.
def _newell_f(x: float, y: float, z: float) -> float:
    x2 = x * x
    y2 = y * y
    z2 = z * z
    r2 = x2 + y2 + z2
    if r2 < 1.0e-300:
        return 0.0
    radius = math.sqrt(r2)
    result = (2.0 * x2 - y2 - z2) * radius / 6.0

    xz2 = x2 + z2
    if xz2 > 1.0e-300:
        argument = 2.0 * y * (y + radius) / xz2
        if argument > -1.0:
            result += y * (z2 - x2) * math.log1p(argument) / 4.0

    xy2 = x2 + y2
    if xy2 > 1.0e-300:
        argument = 2.0 * z * (z + radius) / xy2
        if argument > -1.0:
            result += z * (y2 - x2) * math.log1p(argument) / 4.0

    if abs(x) > 1.0e-300:
        result -= x * y * z * math.atan(y * z / (x * radius))
    return result


def _newell_g(x: float, y: float, z: float) -> float:
    x2 = x * x
    y2 = y * y
    z2 = z * z
    r2 = x2 + y2 + z2
    if r2 < 1.0e-300:
        return 0.0
    radius = math.sqrt(r2)
    result = -x * y * radius / 3.0

    xy2 = x2 + y2
    if xy2 > 1.0e-300:
        argument = 2.0 * z * (z + radius) / xy2
        if argument > -1.0:
            result += x * y * z * math.log1p(argument) / 2.0

    yz2 = y2 + z2
    if yz2 > 1.0e-300:
        argument = 2.0 * x * (x + radius) / yz2
        if argument > -1.0:
            result += y * (3.0 * z2 - y2) * math.log1p(argument) / 12.0

    xz2 = x2 + z2
    if xz2 > 1.0e-300:
        argument = 2.0 * y * (y + radius) / xz2
        if argument > -1.0:
            result += x * (3.0 * z2 - x2) * math.log1p(argument) / 12.0

    if abs(z) > 1.0e-300:
        result -= z2 * z * math.atan(x * y / (z * radius)) / 6.0
    if abs(y) > 1.0e-300:
        result -= y2 * z * math.atan(x * z / (y * radius)) / 2.0
    if abs(x) > 1.0e-300:
        result -= x2 * z * math.atan(y * z / (x * radius)) / 2.0
    return result


def _corner_sum(
    primitive: Any,
    source_cell: Sequence[float],
    destination_cell: Sequence[float],
    displacement: Sequence[float],
) -> float:
    terms: list[float] = []
    # The signs encode destination upper/lower minus source upper/lower.  This
    # six-dimensional finite difference is valid for unequal source/dest cells.
    for signs in itertools.product((-1.0, 1.0), repeat=6):
        coordinates = tuple(
            displacement[axis]
            + signs[axis] * destination_cell[axis] / 2.0
            - signs[axis + 3] * source_cell[axis] / 2.0
            for axis in range(3)
        )
        terms.append(math.prod(signs) * primitive(*coordinates))
    # The Newell finite difference is cancellation-heavy at the edge of a
    # padded 2-D film.  ``math.fsum`` keeps this independent oracle stable
    # enough to compare against the runtime's compensated summation instead
    # of measuring Python's naive accumulation order.
    return math.fsum(terms)


def independent_newell_tensor(
    source_cell: Sequence[float],
    destination_cell: Sequence[float],
    displacement: Sequence[float],
) -> tuple[float, float, float, float, float, float]:
    """Return ``N[destination <- source]`` in SI geometry.

    ``displacement`` is destination-centre minus source-centre.  The tensor is
    normalized by destination volume and has component order
    ``(xx, yy, zz, xy, xz, yz)``.  This orientation is part of the parity
    contract and is intentionally explicit at every call site.
    """

    source = _cell3(source_cell, "source_cell")
    destination = _cell3(destination_cell, "destination_cell")
    delta = _vec3(displacement, "displacement")
    signs = tuple(-1.0 if value < 0.0 else 1.0 for value in delta)
    canonical_delta = tuple(abs(value) for value in delta)
    volume = math.prod(destination)
    components = (
        _corner_sum(_newell_f, source, destination, canonical_delta),
        _corner_sum(lambda x, y, z: _newell_f(y, x, z), source, destination, canonical_delta),
        _corner_sum(lambda x, y, z: _newell_f(z, y, x), source, destination, canonical_delta),
        _corner_sum(_newell_g, source, destination, canonical_delta) * signs[0] * signs[1],
        _corner_sum(lambda x, y, z: _newell_g(x, z, y), source, destination, canonical_delta) * signs[0] * signs[2],
        _corner_sum(lambda x, y, z: _newell_g(y, z, x), source, destination, canonical_delta) * signs[1] * signs[2],
    )
    scale = 1.0 / (4.0 * math.pi * volume)
    result = tuple(component * scale for component in components)
    _require(all(math.isfinite(component) for component in result), "independent Newell tensor is non-finite")
    return result  # type: ignore[return-value]


def cubature_cell_pair_tensor(
    source_cell: Sequence[float],
    destination_cell: Sequence[float],
    displacement: Sequence[float],
) -> tuple[float, float, float, float, float, float]:
    """Independent GL8 double-volume cubature for a non-overlapping pair.

    The singular coincident-cell term is intentionally excluded: self terms
    are evaluated by the independent closed-form prism integral above.  This
    makes the cubature a genuine cross-check rather than a second call to the
    production generator.
    """

    source = _cell3(source_cell, "source_cell")
    destination = _cell3(destination_cell, "destination_cell")
    delta = _vec3(displacement, "displacement")
    integrals = [0.0] * 6
    for dx_node, dx_weight in zip(GL8_NODES, GL8_WEIGHTS):
        for dy_node, dy_weight in zip(GL8_NODES, GL8_WEIGHTS):
            for dz_node, dz_weight in zip(GL8_NODES, GL8_WEIGHTS):
                destination_point = (
                    delta[0] + destination[0] * dx_node / 2.0,
                    delta[1] + destination[1] * dy_node / 2.0,
                    delta[2] + destination[2] * dz_node / 2.0,
                )
                destination_weight = (
                    math.prod(destination)
                    * dx_weight
                    * dy_weight
                    * dz_weight
                    / 8.0
                )
                for sx_node, sx_weight in zip(GL8_NODES, GL8_WEIGHTS):
                    for sy_node, sy_weight in zip(GL8_NODES, GL8_WEIGHTS):
                        for sz_node, sz_weight in zip(GL8_NODES, GL8_WEIGHTS):
                            source_point = (
                                source[0] * sx_node / 2.0,
                                source[1] * sy_node / 2.0,
                                source[2] * sz_node / 2.0,
                            )
                            displacement_point = tuple(
                                destination_point[axis] - source_point[axis]
                                for axis in range(3)
                            )
                            squared_radius = sum(component * component for component in displacement_point)
                            if squared_radius < 1.0e-300:
                                _fail("cubature pair contains the singular coincident point; use Newell self term")
                            inverse_r3 = 1.0 / (squared_radius * math.sqrt(squared_radius))
                            inverse_r5 = inverse_r3 / squared_radius
                            weight = (
                                destination_weight
                                * math.prod(source)
                                * sx_weight
                                * sy_weight
                                * sz_weight
                                / 8.0
                            )
                            x, y, z = displacement_point
                            integrals[0] += weight * (inverse_r3 - 3.0 * x * x * inverse_r5)
                            integrals[1] += weight * (inverse_r3 - 3.0 * y * y * inverse_r5)
                            integrals[2] += weight * (inverse_r3 - 3.0 * z * z * inverse_r5)
                            integrals[3] += weight * (-3.0 * x * y * inverse_r5)
                            integrals[4] += weight * (-3.0 * x * z * inverse_r5)
                            integrals[5] += weight * (-3.0 * y * z * inverse_r5)
    scale = 1.0 / (4.0 * math.pi * math.prod(destination))
    return tuple(value * scale for value in integrals)  # type: ignore[return-value]


@dataclass
class RuntimeLayer:
    name: str
    grid: tuple[int, int, int]
    cell: tuple[float, float, float]
    origin: tuple[float, float, float]
    transfer_kind: str
    saturation_magnetisation: float
    magnetization: list[tuple[float, float, float]]
    field: list[tuple[float, float, float]]
    active: list[bool]

    @property
    def count(self) -> int:
        return math.prod(self.grid)

    @property
    def volume(self) -> float:
        return math.prod(self.cell)

    def center(self, flat_index: int) -> tuple[float, float, float]:
        nx, ny, _ = self.grid
        z, remainder = divmod(flat_index, nx * ny)
        y, x = divmod(remainder, nx)
        return tuple(
            self.origin[axis] + (index + 0.5) * self.cell[axis]
            for axis, index in enumerate((x, y, z))
        )


@dataclass
class RuntimeArtifact:
    root: Path
    metadata: dict[str, Any]
    layers: list[RuntimeLayer]
    step: int
    time_s: float
    case: str


def _vector_values(payload: dict[str, Any], name: str, expected: int) -> list[tuple[float, float, float]]:
    values = payload.get("values")
    _require(isinstance(values, list) and len(values) == expected, f"{name} must contain {expected} vectors")
    parsed = [_vec3(value, f"{name}[{index}]") for index, value in enumerate(values)]
    return parsed


def _validate_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    _require(metadata.get("status") == "completed", "runtime status must be completed")
    _require(isinstance(metadata.get("source_hash"), str) and metadata["source_hash"], "fresh source_hash metadata is required")
    _require(isinstance(metadata.get("engine_version"), str) and metadata["engine_version"], "engine_version metadata is required")

    requested = metadata.get("requested_execution")
    _require(isinstance(requested, dict), "requested_execution metadata is required")
    for key, expected in (
        ("backend", "fdm"),
        ("device", "cpu"),
        ("precision", "double"),
        ("fallback_policy", "forbidden"),
    ):
        _require(requested.get(key) == expected, f"requested_execution.{key} must be {expected}")

    provenance = metadata.get("execution_provenance")
    _require(isinstance(provenance, dict), "execution_provenance metadata is required")
    _require(
        provenance.get("execution_engine") == "cpu_reference_multilayer",
        "execution_provenance.execution_engine must be cpu_reference_multilayer",
    )
    _require(provenance.get("precision") == "double", "execution_provenance.precision must be double")
    _require(provenance.get("lossy_fallback_used") is False, "lossy fallback is forbidden")
    _require(
        provenance.get("demag_operator_kind") == "multilayer_tensor_fft_newell",
        "execution_provenance.demag_operator_kind must identify multilayer Newell",
    )

    layout = metadata.get("artifact_layout")
    _require(isinstance(layout, dict), "artifact_layout metadata is required")
    _require(layout.get("backend") == "fdm_multilayer", "artifact_layout.backend must be fdm_multilayer")
    _require(layout.get("mode") in {"two_d_stack", "three_d"}, "unsupported FDM multilayer mode")
    raw_layers = layout.get("layers")
    _require(isinstance(raw_layers, list) and raw_layers, "artifact_layout.layers is required")
    _require(layout.get("layer_count") == len(raw_layers), "artifact_layout.layer_count is inconsistent")

    mesh = metadata.get("mesh")
    _require(isinstance(mesh, dict), "mesh runtime metadata is required")
    _require(mesh.get("backend") == "fdm_multilayer", "mesh.backend must be fdm_multilayer")
    _require(mesh.get("periodic_axes") == [False, False, False], "periodic FDM boundaries are not accepted")
    _require(mesh.get("transfer_boundary_policy") == ["open", "open", "open"], "open transfer boundaries are required")
    _require(metadata.get("pbc") in (None, {}), "top-level periodic metadata must be absent/open")

    problem_meta = metadata.get("problem_meta")
    _require(isinstance(problem_meta, dict), "problem_meta metadata is required")
    runtime_metadata = problem_meta.get("runtime_metadata")
    _require(isinstance(runtime_metadata, dict), "problem_meta.runtime_metadata is required")
    qualification = runtime_metadata.get("fdm_multilayer_qualification")
    _require(isinstance(qualification, dict), "fdm_multilayer_qualification metadata is required")
    _require(qualification.get("qualification_scope") == QUALIFICATION_SCOPE, "qualification scope must be SP4-derived")
    for key, expected in (("backend", "fdm"), ("device", "cpu"), ("precision", "double")):
        _require(qualification.get(key) == expected, f"qualification metadata {key} must be {expected}")
    return layout


def _layer_saturation_magnetisations(
    metadata: dict[str, Any], layer_names: Sequence[str]
) -> dict[str, float]:
    """Read the resolved per-layer ``Ms`` values from runtime provenance."""

    execution_plan = metadata.get("execution_plan")
    backend_plan = execution_plan.get("backend_plan") if isinstance(execution_plan, dict) else None
    raw_layers = backend_plan.get("layers") if isinstance(backend_plan, dict) else None
    _require(isinstance(raw_layers, list), "execution_plan.backend_plan.layers is required for Ms provenance")
    result: dict[str, float] = {}
    for raw_layer in raw_layers:
        if not isinstance(raw_layer, dict):
            continue
        name = raw_layer.get("magnet_name")
        material = raw_layer.get("material")
        if not isinstance(name, str) or not isinstance(material, dict):
            continue
        value = material.get("saturation_magnetisation")
        if value is None:
            continue
        result[name] = _positive(value, f"Ms[{name}]")
    for name in layer_names:
        _require(name in result, f"missing resolved saturation_magnetisation provenance for layer {name}")
    return result


def _field_step_paths(root: Path, manifest_layers: list[dict[str, Any]]) -> tuple[int, list[Path]]:
    candidates: set[int] = set()
    per_layer: list[dict[int, Path]] = []
    for layer in manifest_layers:
        directory = layer.get("directory")
        _require(isinstance(directory, str) and directory, "field manifest layer directory is required")
        paths: dict[int, Path] = {}
        for path in (root / "fields" / "H_demag" / directory).glob("step_*.json"):
            try:
                step = int(path.stem.removeprefix("step_"))
            except ValueError:
                continue
            paths[step] = path
            candidates.add(step)
        _require(paths, f"H_demag field snapshots are missing for {directory}")
        per_layer.append(paths)
    for step in sorted(candidates):
        if all(step in paths for paths in per_layer):
            return step, [paths[step] for paths in per_layer]
    _fail("H_demag layers do not share one runtime snapshot step")


def _parse_case(layers: list[RuntimeLayer]) -> str:
    if len(layers) == 1:
        return "l1_self"
    thicknesses = [layer.grid[2] * layer.cell[2] for layer in layers]
    equal_thickness = all(
        math.isclose(thickness, thicknesses[0], rel_tol=0.0, abs_tol=1.0e-21)
        for thickness in thicknesses[1:]
    )
    if len(layers) == 2:
        return "l2_equal_thickness" if equal_thickness else "l2_unequal_thickness"
    if len(layers) == 3:
        return "l3_regular" if equal_thickness else "l3_heterogeneous"
    return "unsupported_layer_count"


def load_runtime_artifact(root: str | Path) -> RuntimeArtifact:
    """Load and validate one fresh runtime artifact, without synthesizing data."""

    artifact_root = Path(root)
    _require(artifact_root.is_dir(), f"runtime artifact directory is missing: {artifact_root}")
    metadata = _read_json(artifact_root / "metadata.json")
    layout = _validate_metadata(metadata)
    raw_layout_layers = layout["layers"]
    _require(isinstance(raw_layout_layers, list), "artifact_layout.layers must be an array")
    layer_names = [
        layer.get("magnet_name")
        for layer in raw_layout_layers
        if isinstance(layer, dict)
    ]
    _require(
        all(isinstance(name, str) and name for name in layer_names),
        "artifact_layout layer magnet_name is required",
    )
    saturation_magnetisations = _layer_saturation_magnetisations(
        metadata, [name for name in layer_names if isinstance(name, str)]
    )

    manifest = _read_json(artifact_root / "fields" / "H_demag" / "manifest.json")
    _require(manifest.get("schema_version") == "fdm_multilayer_field_manifest.v1", "H_demag manifest schema mismatch")
    _require(manifest.get("observable") == "H_demag" and manifest.get("unit") == "A/m", "H_demag manifest units mismatch")
    _require(manifest.get("storage_layout") == "per_layer_json", "H_demag must use per-layer JSON storage")
    manifest_layers = manifest.get("layers")
    _require(isinstance(manifest_layers, list) and len(manifest_layers) == len(raw_layout_layers), "field/layout layer count mismatch")
    _require(all(isinstance(layer, dict) for layer in manifest_layers), "H_demag manifest layers must be objects")
    _require(manifest.get("layer_count") == len(raw_layout_layers), "H_demag manifest layer_count is inconsistent")
    _require(manifest.get("component_order") == ["x", "y", "z"], "H_demag manifest component order mismatch")

    initial = _read_json(artifact_root / "m_initial.json")
    _require(initial.get("observable") == "m" and initial.get("unit") == "1", "m_initial must be dimensionless magnetization")
    initial_layout = initial.get("layout")
    _require(isinstance(initial_layout, dict) and initial_layout.get("backend") == "fdm_multilayer", "m_initial layout provenance is missing")
    _require(initial.get("step") == 0, "m_initial must be the step-zero snapshot")
    _require(_finite(initial.get("time", 0.0), "m_initial.time") == 0.0, "m_initial must have time zero")
    raw_initial_values = initial.get("values")
    _require(isinstance(raw_initial_values, list), "m_initial.values is required")

    step, field_paths = _field_step_paths(artifact_root, manifest_layers)
    layers: list[RuntimeLayer] = []
    field_times: list[float] = []
    expected_offset = 0
    for index, (layout_layer, manifest_layer, field_path) in enumerate(
        zip(raw_layout_layers, manifest_layers, field_paths)
    ):
        _require(isinstance(layout_layer, dict), f"layout layer {index} must be an object")
        _require(isinstance(manifest_layer, dict), f"manifest layer {index} must be an object")
        _require(isinstance(layout_layer.get("magnet_name"), str) and layout_layer["magnet_name"], f"layer[{index}] magnet_name is required")
        grid = _grid3(layout_layer.get("native_grid"), f"layer[{index}].native_grid")
        cell = _cell3(layout_layer.get("native_cell_size"), f"layer[{index}].native_cell_size")
        origin = _vec3(layout_layer.get("native_origin"), f"layer[{index}].native_origin")
        count = math.prod(grid)
        offset = layout_layer.get("value_offset")
        _require(isinstance(offset, int) and offset == expected_offset, f"layer[{index}] value_offset is not contiguous")
        _require(layout_layer.get("value_count") == count, f"layer[{index}] value_count does not match native_grid")
        transfer_kind = layout_layer.get("transfer_kind")
        _require(
            transfer_kind in {"identity", "push_pull"},
            f"layer[{index}] has unsupported transfer_kind {transfer_kind!r}",
        )
        expected_offset += count
        _require(manifest_layer.get("id") == layout_layer.get("magnet_name"), f"layer[{index}] manifest/layout id mismatch")
        _require(manifest_layer.get("value_offset") == offset and manifest_layer.get("value_count") == count, f"layer[{index}] manifest value range mismatch")
        for geometry_key in ("native_grid", "native_cell_size", "native_origin"):
            _require(
                manifest_layer.get(geometry_key) == layout_layer.get(geometry_key),
                f"layer[{index}] manifest/layout {geometry_key} mismatch",
            )
        _require(
            manifest_layer.get("active_mask_present") == layout_layer.get("active_mask_present"),
            f"layer[{index}] manifest/layout active-mask provenance mismatch",
        )
        _require(
            manifest_layer.get("active_cell_count") == layout_layer.get("active_cell_count")
            and manifest_layer.get("inactive_cell_count") == layout_layer.get("inactive_cell_count"),
            f"layer[{index}] active-cell counts are inconsistent",
        )
        _require(
            manifest_layer.get("transfer_kind") == transfer_kind,
            f"layer[{index}] manifest/layout transfer_kind mismatch",
        )
        if layout_layer.get("active_mask_present"):
            _require(
                layout_layer.get("active_cell_count") == count,
                f"layer[{index}] has a partial active mask that is not published in the runtime artifact",
            )
        else:
            _require(
                layout_layer.get("active_cell_count") == count and layout_layer.get("inactive_cell_count") == 0,
                f"layer[{index}] has inactive cells without a published active mask",
            )
        _require(manifest_layer.get("directory"), f"layer[{index}] field directory is missing")

        initial_end = offset + count
        _require(initial_end <= len(raw_initial_values), "m_initial does not cover all layer values")
        saturation_magnetisation = saturation_magnetisations[str(layout_layer["magnet_name"])]
        magnetization = [
            tuple(component * saturation_magnetisation for component in _vec3(value, f"m_initial layer[{index}]"))
            for value in raw_initial_values[offset:initial_end]
        ]
        field_payload = _read_json(field_path)
        _require(field_payload.get("observable") == "H_demag" and field_payload.get("unit") == "A/m", f"layer[{index}] H_demag units mismatch")
        _require(field_payload.get("step") == step, f"layer[{index}] field step mismatch")
        _require(field_payload.get("component_count") == 3 and field_payload.get("component_order") == "xyz", f"layer[{index}] H_demag component contract mismatch")
        _require(field_payload.get("location") == "cell" and field_payload.get("scope") == "layer", f"layer[{index}] field scope mismatch")
        field_provenance = field_payload.get("provenance")
        _require(isinstance(field_provenance, dict), f"layer[{index}] H_demag provenance is missing")
        _require(
            field_provenance.get("execution_engine") == "cpu_reference_multilayer"
            and field_provenance.get("precision") == "double",
            f"layer[{index}] H_demag provenance does not identify the CPU double runtime",
        )
        field_values = _vector_values(field_payload, f"H_demag layer[{index}]", count)
        field_layer = field_payload.get("layer")
        _require(isinstance(field_layer, dict) and field_layer.get("id") == manifest_layer.get("id"), f"layer[{index}] field provenance mismatch")
        _require(field_layer.get("native_grid") == list(grid), f"layer[{index}] field native_grid mismatch")
        _require(field_layer.get("native_cell_size") == list(cell), f"layer[{index}] field native_cell_size mismatch")
        _require(field_layer.get("native_origin") == list(origin), f"layer[{index}] field native_origin mismatch")
        time_s = _finite(field_payload.get("time", 0.0), f"H_demag layer[{index}].time")
        field_times.append(time_s)
        layers.append(
            RuntimeLayer(
                name=str(layout_layer.get("magnet_name")),
                grid=grid,
                cell=cell,
                origin=origin,
                transfer_kind=str(transfer_kind),
                saturation_magnetisation=saturation_magnetisation,
                magnetization=magnetization,
                field=field_values,
                active=[True] * count,
            )
        )

    _require(expected_offset == len(raw_initial_values), "m_initial contains values outside artifact layers")
    _require(step == 0, "independent parity requires a step-zero H_demag snapshot matching m_initial")
    _require(
        all(math.isclose(time_s, field_times[0], rel_tol=0.0, abs_tol=1.0e-30) for time_s in field_times),
        "H_demag layers do not share one snapshot time",
    )
    time_s = _finite(_read_json(field_paths[0]).get("time", 0.0), "H_demag.time")
    case = _parse_case(layers)
    _require(
        case != "unsupported_layer_count",
        "independent oracle supports only L=1, L=2, or L=3 artifacts",
    )
    return RuntimeArtifact(artifact_root, metadata, layers, step, time_s, case)


def _sample_indices(count: int, limit: int) -> list[int]:
    _require(limit > 0, "max_target_cells must be positive")
    if count <= limit:
        return list(range(count))
    if limit == 1:
        return [0]
    indices = {0, count - 1}
    for position in range(1, limit - 1):
        indices.add(round(position * (count - 1) / (limit - 1)))
    return sorted(indices)


def _mat(tensor: Sequence[float]) -> tuple[tuple[float, float, float], ...]:
    return (
        (tensor[0], tensor[3], tensor[4]),
        (tensor[3], tensor[1], tensor[5]),
        (tensor[4], tensor[5], tensor[2]),
    )


def _field_from_layers(
    target: RuntimeLayer,
    target_index: int,
    sources: list[RuntimeLayer],
    tensor_cache: dict[tuple[Any, ...], tuple[float, float, float, float, float, float]],
) -> tuple[float, float, float]:
    destination = target.center(target_index)
    field = [0.0, 0.0, 0.0]
    for source_index, source in enumerate(sources):
        for source_cell_index, magnetization in enumerate(source.magnetization):
            if not source.active[source_cell_index]:
                continue
            source_center = source.center(source_cell_index)
            displacement = tuple(destination[axis] - source_center[axis] for axis in range(3))
            key = (tuple(source.cell), tuple(target.cell), displacement)
            tensor = tensor_cache.get(key)
            if tensor is None:
                tensor = independent_newell_tensor(source.cell, target.cell, displacement)
                tensor_cache[key] = tensor
            matrix = _mat(tensor)
            for axis in range(3):
                field[axis] -= sum(matrix[axis][component] * magnetization[component] for component in range(3))
    return tuple(field)  # type: ignore[return-value]


def _field_values_numpy(
    artifact: RuntimeArtifact,
    tensor_cache: dict[tuple[Any, ...], tuple[float, float, float, float, float, float]],
) -> list[list[tuple[float, float, float]]]:
    """Evaluate every common-XY target with an independent translation sweep.

    Qualified identity artifacts in the published FDM contract share one
    convolution grid in X/Y and cell size; 3-D layers may have different Z
    cell counts.  The sweep below is an independent real-space reference,
    not an FFT implementation: each signed lag gets a fresh Python Newell
    tensor and NumPy only performs the vector accumulation over all matching
    source/target slices.  This makes full-field coverage feasible for the
    managed 128 x 32 x 1 evidence without importing production code.
    """

    try:
        import numpy as np
    except ImportError as exc:  # pragma: no cover - managed runtime supplies numpy
        raise OracleError("full coverage requires numpy for the independent lag sweep") from exc

    reference_grid = artifact.layers[0].grid
    reference_cell = artifact.layers[0].cell
    for index, layer in enumerate(artifact.layers):
        _require(layer.grid[:2] == reference_grid[:2], f"identity layer[{index}] XY grid differs from common grid")
        _require(layer.cell[:2] == reference_cell[:2], f"identity layer[{index}] XY cell differs from common cell")

    nx, ny, _ = reference_grid
    fields: list[list[tuple[float, float, float]]] = []
    for destination_layer in artifact.layers:
        destination_nz = destination_layer.grid[2]
        destination_values = np.zeros((destination_nz, ny, nx, 3), dtype=np.float64)
        for source_layer in artifact.layers:
            source_nz = source_layer.grid[2]
            source_values = np.asarray(source_layer.magnetization, dtype=np.float64).reshape((source_nz, ny, nx, 3))
            origin_delta = tuple(
                destination_layer.origin[axis] - source_layer.origin[axis]
                for axis in range(3)
            )
            for destination_z in range(destination_nz):
                destination_z_center = (destination_z + 0.5) * destination_layer.cell[2]
                for source_z in range(source_nz):
                    source_z_center = (source_z + 0.5) * source_layer.cell[2]
                    for lag_y in range(-(ny - 1), ny):
                        source_y0 = max(0, -lag_y)
                        source_y1 = min(ny, ny - lag_y)
                        destination_y0 = source_y0 + lag_y
                        destination_y1 = source_y1 + lag_y
                        for lag_x in range(-(nx - 1), nx):
                            source_x0 = max(0, -lag_x)
                            source_x1 = min(nx, nx - lag_x)
                            destination_x0 = source_x0 + lag_x
                            destination_x1 = source_x0 + lag_x + (source_x1 - source_x0)
                            displacement = (
                                origin_delta[0] + lag_x * reference_cell[0],
                                origin_delta[1] + lag_y * reference_cell[1],
                                origin_delta[2] + destination_z_center - source_z_center,
                            )
                            key = (source_layer.cell, destination_layer.cell, displacement)
                            tensor = tensor_cache.get(key)
                            if tensor is None:
                                tensor = independent_newell_tensor(
                                    source_layer.cell,
                                    destination_layer.cell,
                                    displacement,
                                )
                                tensor_cache[key] = tensor
                            matrix = np.asarray(_mat(tensor), dtype=np.float64)
                            source_slice = source_values[source_z, source_y0:source_y1, source_x0:source_x1]
                            contribution = np.einsum("...j,ij->...i", source_slice, matrix)
                            destination_values[destination_z, destination_y0:destination_y1, destination_x0:destination_x1] -= contribution
        fields.append([tuple(value) for value in destination_values.reshape((-1, 3))])
    return fields


def _field_norm(
    artifact: RuntimeArtifact,
    *,
    field_rtol: float,
    field_atol: float,
    max_target_cells: int,
) -> tuple[
    dict[str, Any],
    dict[int, list[tuple[float, float, float]]],
    dict[tuple[Any, ...], tuple[float, float, float, float, float, float]],
    list[list[tuple[float, float, float]]] | None,
]:
    tensor_cache: dict[tuple[Any, ...], tuple[float, float, float, float, float, float]] = {}
    expected: dict[int, list[tuple[float, float, float]]] = {}
    errors: list[float] = []
    reference_values: list[float] = []
    expected_norm_sq = 0.0
    error_norm_sq = 0.0
    sample_count = 0
    full_coverage = True
    numpy_fields: list[list[tuple[float, float, float]]] | None = None
    if all(
        len(_sample_indices(layer.count, max_target_cells)) == layer.count
        for layer in artifact.layers
    ):
        try:
            numpy_fields = _field_values_numpy(artifact, tensor_cache)
        except OracleError:
            # A non-common identity grid is still valid for sampled checking;
            # retain the exact direct path rather than weakening the contract.
            numpy_fields = None
    for target_index, target in enumerate(artifact.layers):
        indices = _sample_indices(target.count, max_target_cells)
        full_coverage &= len(indices) == target.count
        expected_values: list[tuple[float, float, float]] = []
        for cell_index in indices:
            value = (
                numpy_fields[target_index][cell_index]
                if numpy_fields is not None
                else _field_from_layers(target, cell_index, artifact.layers, tensor_cache)
            )
            expected_values.append(value)
            actual = target.field[cell_index]
            for component in range(3):
                error = abs(actual[component] - value[component])
                errors.append(error)
                reference_values.append(value[component])
                error_norm_sq += (actual[component] - value[component]) ** 2
                expected_norm_sq += value[component] ** 2
            sample_count += 1
        expected[target_index] = expected_values
    max_error = max(errors, default=0.0)
    expected_scale = max((abs(value) for value in reference_values), default=0.0)
    actual_scale = max(
        (abs(value) for layer in artifact.layers for index in _sample_indices(layer.count, max_target_cells) for vector in (layer.field[index],) for value in vector),
        default=0.0,
    )
    scale = max(expected_scale, actual_scale, 1.0)
    relative_l2 = math.sqrt(error_norm_sq / expected_norm_sq) if expected_norm_sq > 0.0 else math.sqrt(error_norm_sq)
    tolerance = field_atol + field_rtol * scale
    return (
        {
            "status": "pass" if max_error <= tolerance else "fail",
            "sampled_target_cells": sample_count,
            "full_field_coverage": full_coverage,
            "max_abs_component_error_A_per_m": max_error,
            "rms_component_error_A_per_m": math.sqrt(error_norm_sq / max(1, sample_count * 3)),
            "relative_l2_error": relative_l2,
            "tolerance_A_per_m": tolerance,
            "rtol": field_rtol,
            "atol_A_per_m": field_atol,
        },
        expected,
        tensor_cache,
        numpy_fields,
    )


def _read_reported_energy(artifact: RuntimeArtifact) -> float | None:
    path = artifact.root / "scalars.csv"
    if not path.is_file():
        return None
    try:
        with path.open(newline="", encoding="utf-8") as stream:
            for row in csv.DictReader(stream):
                try:
                    row_step = int(row.get("step", "-1"))
                except (TypeError, ValueError) as exc:
                    _fail(f"scalars.csv step must be numeric: {exc}")
                if row_step == artifact.step:
                    raw = row.get("E_demag", row.get("e_demag"))
                    if raw is None:
                        return None
                    try:
                        return _finite(float(raw), "scalars.csv E_demag")
                    except (TypeError, ValueError) as exc:
                        _fail(f"scalars.csv E_demag must be numeric: {exc}")
    except (OSError, TypeError, ValueError, csv.Error) as exc:
        _fail(f"invalid scalars.csv: {exc}")
    return None


def _energy_norm(
    artifact: RuntimeArtifact,
    *,
    energy_rtol: float,
    energy_atol: float,
    max_energy_cells: int,
    independent_fields: list[list[tuple[float, float, float]]] | None = None,
) -> dict[str, Any]:
    total_cells = sum(layer.count for layer in artifact.layers)
    reported = _read_reported_energy(artifact)
    if total_cells > max_energy_cells:
        return {
            "status": "blocked",
            "reason": "full_energy_coverage_limit",
            "total_cells": total_cells,
            "max_energy_cells": max_energy_cells,
            "reported_energy_J": reported,
            "rtol": energy_rtol,
            "atol_J": energy_atol,
        }
    tensor_cache: dict[tuple[Any, ...], tuple[float, float, float, float, float, float]] = {}
    expected_energy = 0.0
    runtime_field_energy = 0.0
    if independent_fields is None and all(
        layer.grid[:2] == artifact.layers[0].grid[:2]
        and layer.cell[:2] == artifact.layers[0].cell[:2]
        for layer in artifact.layers
    ):
        try:
            independent_fields = _field_values_numpy(artifact, tensor_cache)
        except OracleError:
            independent_fields = None
    for target_index, target in enumerate(artifact.layers):
        for index, magnetization in enumerate(target.magnetization):
            expected_field = (
                independent_fields[target_index][index]
                if independent_fields is not None
                else _field_from_layers(target, index, artifact.layers, tensor_cache)
            )
            runtime_field = target.field[index]
            expected_energy += -0.5 * MU0 * target.volume * sum(magnetization[axis] * expected_field[axis] for axis in range(3))
            runtime_field_energy += -0.5 * MU0 * target.volume * sum(magnetization[axis] * runtime_field[axis] for axis in range(3))
    scale = max(abs(expected_energy), abs(runtime_field_energy), abs(reported or 0.0), 1.0e-30)
    tolerance = energy_atol + energy_rtol * scale
    runtime_error = abs(runtime_field_energy - expected_energy)
    reported_error = None if reported is None else abs(reported - expected_energy)
    reported_status = "not_available" if reported is None else "pass" if reported_error is not None and reported_error <= tolerance else "fail"
    status = runtime_error <= tolerance and reported_status in {"pass", "not_available"}
    return {
        "status": "pass" if status else "fail",
        "expected_energy_J": expected_energy,
        "runtime_field_energy_J": runtime_field_energy,
        "reported_energy_J": reported,
        "runtime_field_abs_error_J": runtime_error,
        "reported_abs_error_J": reported_error,
        "reported_energy_status": reported_status,
        "tolerance_J": tolerance,
        "rtol": energy_rtol,
        "atol_J": energy_atol,
    }


def _reciprocity(artifact: RuntimeArtifact, *, rtol: float, atol: float, max_pairs: int = 256) -> dict[str, Any]:
    records: list[tuple[RuntimeLayer, int, RuntimeLayer, int]] = []
    for destination in artifact.layers:
        for source in artifact.layers:
            destination_indices = _sample_indices(destination.count, max(1, int(math.sqrt(max_pairs))))
            source_indices = _sample_indices(source.count, max(1, int(math.sqrt(max_pairs))))
            records.extend((destination, di, source, si) for di in destination_indices for si in source_indices)
    records = records[:max_pairs]
    residuals: list[float] = []
    scales: list[float] = []
    relative_residuals: list[float] = []
    for destination, destination_index, source, source_index in records:
        displacement = tuple(destination.center(destination_index)[axis] - source.center(source_index)[axis] for axis in range(3))
        forward = independent_newell_tensor(source.cell, destination.cell, displacement)
        reverse = independent_newell_tensor(destination.cell, source.cell, tuple(-value for value in displacement))
        forward_matrix = _mat(forward)
        reverse_matrix = _mat(reverse)
        for row in range(3):
            for column in range(3):
                left = destination.volume * forward_matrix[row][column]
                right = source.volume * reverse_matrix[column][row]
                residuals.append(abs(left - right))
                scale = max(abs(left), abs(right), 1.0e-300)
                scales.append(scale)
                # Components that are analytically zero are dominated by
                # floating-point cancellation.  Keep their absolute residual
                # in the report, but do not turn a 1e-16/1e-16 ratio into a
                # false reciprocity failure.
                component_floor = max(atol, max(destination.volume, source.volume) * 1.0e-12)
                if max(abs(left), abs(right)) > component_floor:
                    relative_residuals.append(abs(left - right) / scale)
    max_residual = max(residuals, default=0.0)
    scale = max(scales, default=1.0e-300)
    max_relative_residual = max(relative_residuals, default=0.0)
    tolerance = rtol + atol / scale
    return {
        "status": "pass" if max_relative_residual <= tolerance else "fail",
        "sampled_pairs": len(records),
        "max_abs_volume_weighted_residual": max_residual,
        "max_relative_volume_weighted_residual": max_relative_residual,
        "tolerance": tolerance,
        "rtol": rtol,
        "atol": atol,
        "orientation": _orientation_report(artifact.layers),
    }


def _orientation_report(layers: list[RuntimeLayer]) -> dict[str, Any]:
    signs: set[str] = set()
    deltas: list[float] = []
    for destination_index, destination in enumerate(layers):
        for source_index, source in enumerate(layers):
            if destination_index == source_index:
                continue
            delta_z = destination.center(0)[2] - source.center(0)[2]
            deltas.append(delta_z)
            if delta_z > 0.0:
                signs.add("+Z")
            elif delta_z < 0.0:
                signs.add("-Z")
    return {
        "observed_delta_z_m": deltas,
        "observed_signs": sorted(signs),
        "both_signed_directions": signs == {"+Z", "-Z"},
    }


def _cubature_report(artifact: RuntimeArtifact, *, rtol: float, atol: float) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    pair_specs: list[tuple[int, int, int, int]] = []
    # Cross-layer pairs are the useful cubature checks for a multilayer stack;
    # try them before any same-layer candidate so the report cannot be filled
    # by a less informative intra-layer sample.
    for destination_index, destination in enumerate(artifact.layers):
        for source_index, source in enumerate(artifact.layers):
            if destination_index != source_index:
                pair_specs.append((destination_index, source_index, 0, 0))
    # Adjacent cells share a face and the fixed GL8 rule is not a reliable
    # singular-integral cross-check there.  Use separated endpoints only; a
    # two-cell layer has no such pair and is reported as not applicable.
    for layer_index, layer in enumerate(artifact.layers):
        if layer.count >= 3:
            pair_specs.append((layer_index, layer_index, 0, layer.count - 1))

    for destination_index, source_index, destination_cell_index, source_cell_index in pair_specs:
        destination = artifact.layers[destination_index]
        source = artifact.layers[source_index]
        displacement = tuple(destination.center(destination_cell_index)[axis] - source.center(source_cell_index)[axis] for axis in range(3))
        try:
            cubature = cubature_cell_pair_tensor(source.cell, destination.cell, displacement)
        except OracleError:
            continue
        analytical = independent_newell_tensor(source.cell, destination.cell, displacement)
        error = max(abs(actual - expected) for actual, expected in zip(analytical, cubature))
        scale = max(max(abs(value) for value in analytical), max(abs(value) for value in cubature), 1.0)
        checks.append({
            "destination_layer": destination.name,
            "source_layer": source.name,
            "max_abs_component_error": error,
            "tolerance": atol + rtol * scale,
            "status": "pass" if error <= atol + rtol * scale else "fail",
        })
        if len(checks) >= 4:
            break
    if not checks:
        return {"status": "not_applicable", "reason": "only coincident self terms were available"}
    return {
        "status": "pass" if all(check["status"] == "pass" for check in checks) else "fail",
        "checks": checks,
        "rtol": rtol,
        "atol": atol,
    }


def verify_runtime_artifact(
    root: str | Path,
    *,
    field_rtol: float = FIELD_RTOL,
    field_atol: float = FIELD_ATOL_A_PER_M,
    energy_rtol: float = ENERGY_RTOL,
    energy_atol: float = ENERGY_ATOL_J,
    reciprocity_rtol: float = RECIPROCITY_RTOL,
    reciprocity_atol: float = RECIPROCITY_ATOL,
    cubature_rtol: float = CUBATURE_RTOL,
    cubature_atol: float = CUBATURE_ATOL,
    max_target_cells: int = 256,
    max_energy_cells: int = 4096,
) -> dict[str, Any]:
    artifact = load_runtime_artifact(root)
    if any(layer.transfer_kind != "identity" for layer in artifact.layers):
        _fail(
            "independent direct oracle requires identity transfer; "
            "push_pull artifacts need a transfer-specific parity verifier"
        )
    field, _, _, independent_fields = _field_norm(
        artifact,
        field_rtol=field_rtol,
        field_atol=field_atol,
        max_target_cells=max_target_cells,
    )
    energy = _energy_norm(
        artifact,
        energy_rtol=energy_rtol,
        energy_atol=energy_atol,
        max_energy_cells=max_energy_cells,
        independent_fields=independent_fields,
    )
    reciprocity = _reciprocity(artifact, rtol=reciprocity_rtol, atol=reciprocity_atol)
    cubature = _cubature_report(artifact, rtol=cubature_rtol, atol=cubature_atol)
    self_terms = []
    for layer in artifact.layers:
        tensor = independent_newell_tensor(layer.cell, layer.cell, (0.0, 0.0, 0.0))
        self_terms.append({
            "layer": layer.name,
            "trace": sum(tensor[:3]),
            "max_off_diagonal": max(abs(value) for value in tensor[3:]),
            "status": "pass" if abs(sum(tensor[:3]) - 1.0) <= 1.0e-12 and max(abs(value) for value in tensor[3:]) <= 1.0e-12 else "fail",
        })
    orientation_pass = artifact.case == "l1_self" or reciprocity["orientation"]["both_signed_directions"]
    required_pass = field["status"] == "pass" and field["full_field_coverage"] and energy["status"] == "pass" and reciprocity["status"] == "pass" and orientation_pass and cubature["status"] in {"pass", "not_applicable"} and all(item["status"] == "pass" for item in self_terms)
    return {
        "schema_version": SCHEMA_VERSION,
        "qualification_scope": QUALIFICATION_SCOPE,
        "qualification_status": "qualified" if required_pass else "not_qualified",
        "runtime_artifact": str(Path(root)),
        "case": artifact.case,
        "layer_count": len(artifact.layers),
        "field_step": artifact.step,
        "field_time_s": artifact.time_s,
        "field_norm": field,
        "energy_norm": energy,
        "reciprocity": reciprocity,
        "self_terms": self_terms,
        "cubature_crosscheck": cubature,
        "tolerances": {
            "field": {"rtol": field_rtol, "atol_A_per_m": field_atol},
            "energy": {"rtol": energy_rtol, "atol_J": energy_atol},
            "reciprocity": {"rtol": reciprocity_rtol, "atol": reciprocity_atol},
            "cubature": {"rtol": cubature_rtol, "atol": cubature_atol},
        },
    }


def verify_bundle(paths: Iterable[str | Path], **kwargs: Any) -> dict[str, Any]:
    reports: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for path in paths:
        try:
            reports.append(verify_runtime_artifact(path, **kwargs))
        except OracleError as exc:
            errors.append({"runtime_artifact": str(path), "reason": str(exc)})
    cases = {report["case"] for report in reports if report["qualification_status"] == "qualified"}
    equal_reports = [report for report in reports if report["case"] == "l2_equal_thickness"]
    equal_orientation = any(
        report.get("reciprocity", {}).get("orientation", {}).get("both_signed_directions")
        for report in equal_reports
    )
    l3_cases = {"l3_regular", "l3_heterogeneous"}
    report_cases = {report["case"] for report in reports}
    if report_cases and report_cases <= l3_cases:
        coverage = {case: case in cases for case in sorted(report_cases)}
    else:
        coverage = {
            "l1_self": "l1_self" in cases,
            "l2_plus_minus_z": equal_orientation,
            "l2_unequal_thickness": "l2_unequal_thickness" in cases,
        }
    all_covered = all(coverage.values()) and not errors
    all_pass = all(report["qualification_status"] == "qualified" for report in reports)
    status = "qualified" if all_covered and all_pass else "blocked" if errors or not all_covered else "not_qualified"
    return {
        "schema_version": SCHEMA_VERSION,
        "qualification_scope": QUALIFICATION_SCOPE,
        "qualification_status": status,
        "coverage": coverage,
        "reports": reports,
        "errors": errors,
        "tolerances": kwargs,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, action="append", required=True, help="fresh runtime artifact directory; repeat for L=1/L=2 cases")
    parser.add_argument("--output", type=Path, required=True, help="parity report JSON path")
    parser.add_argument("--max-target-cells", type=int, default=256)
    parser.add_argument("--max-energy-cells", type=int, default=4096)
    parser.add_argument("--field-rtol", type=float, default=FIELD_RTOL)
    parser.add_argument("--field-atol", type=float, default=FIELD_ATOL_A_PER_M)
    parser.add_argument("--energy-rtol", type=float, default=ENERGY_RTOL)
    parser.add_argument("--energy-atol", type=float, default=ENERGY_ATOL_J)
    parser.add_argument("--reciprocity-rtol", type=float, default=RECIPROCITY_RTOL)
    parser.add_argument("--reciprocity-atol", type=float, default=RECIPROCITY_ATOL)
    parser.add_argument("--cubature-rtol", type=float, default=CUBATURE_RTOL)
    parser.add_argument("--cubature-atol", type=float, default=CUBATURE_ATOL)
    args = parser.parse_args(argv)
    report = verify_bundle(
        args.artifact,
        field_rtol=args.field_rtol,
        field_atol=args.field_atol,
        energy_rtol=args.energy_rtol,
        energy_atol=args.energy_atol,
        reciprocity_rtol=args.reciprocity_rtol,
        reciprocity_atol=args.reciprocity_atol,
        cubature_rtol=args.cubature_rtol,
        cubature_atol=args.cubature_atol,
        max_target_cells=args.max_target_cells,
        max_energy_cells=args.max_energy_cells,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["qualification_status"] == "qualified" else 3


if __name__ == "__main__":
    raise SystemExit(main())
