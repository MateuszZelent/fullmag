#!/usr/bin/env python3
"""Independent parity check for CPU FDM multilayer ``push_pull`` artifacts.

The direct Newell oracle intentionally rejects non-identity transfer because a
native-grid tensor comparison is the wrong physical question for a transferred
run.  This verifier reconstructs the declared CPU reference operator instead:

* native magnetisation is pushed by active-volume overlap averaging;
* the tensor field is evaluated on the common scratch grid; and
* the scratch field is pulled by the exact volume-weighted adjoint.

The implementation is independent of the Rust transfer code and only consumes
completed runtime artifacts.  It fails closed when the artifact does not prove
the geometry or the CPU transfer realization.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

if __package__ in {None, ""}:  # pragma: no cover - direct CLI invocation
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.verify_fdm_multilayer_independent_oracle import (
    FIELD_ATOL_A_PER_M,
    FIELD_RTOL,
    MU0,
    OracleError,
    RuntimeArtifact,
    _cell3,
    _grid3,
    _mat,
    _read_json,
    _read_reported_energy,
    _require,
    _sample_indices,
    _vec3,
    independent_newell_tensor,
    load_runtime_artifact,
)


SCHEMA_VERSION = "fdm_multilayer_transfer_parity.v1"
QUALIFICATION_SCOPE = "SP4-derived, not canonical SP4 qualification"
TRANSFER_REALIZATION = "volume_weighted_overlap_adjoint"
GRID_FINGERPRINT_LENGTH = 64


@dataclass(frozen=True)
class TransferGeometry:
    native_grid: tuple[int, int, int]
    native_cell: tuple[float, float, float]
    native_origin: tuple[float, float, float]
    scratch_grid: tuple[int, int, int]
    scratch_cell: tuple[float, float, float]
    scratch_origin: tuple[float, float, float]

    @property
    def native_volume(self) -> float:
        return math.prod(self.native_cell)

    @property
    def scratch_volume(self) -> float:
        return math.prod(self.scratch_cell)

    @property
    def native_count(self) -> int:
        return math.prod(self.native_grid)

    @property
    def scratch_count(self) -> int:
        return math.prod(self.scratch_grid)


def _layout_geometries(artifact: RuntimeArtifact) -> list[TransferGeometry]:
    layout = artifact.metadata.get("artifact_layout")
    _require(isinstance(layout, dict), "artifact_layout is required")
    raw_layers = layout.get("layers")
    _require(isinstance(raw_layers, list) and len(raw_layers) == len(artifact.layers), "transfer/layout layer count mismatch")
    geometries: list[TransferGeometry] = []
    for index, raw in enumerate(raw_layers):
        _require(isinstance(raw, dict), f"transfer layout layer {index} must be an object")
        _require(raw.get("transfer_kind") == "push_pull", "transfer parity requires push_pull on every layer")
        native_grid = _grid3(raw.get("native_grid"), f"transfer layer[{index}].native_grid")
        native_cell = _cell3(raw.get("native_cell_size"), f"transfer layer[{index}].native_cell_size")
        native_origin = _vec3(raw.get("native_origin"), f"transfer layer[{index}].native_origin")
        scratch_grid = _grid3(raw.get("convolution_grid"), f"transfer layer[{index}].convolution_grid")
        scratch_cell = _cell3(raw.get("convolution_cell_size"), f"transfer layer[{index}].convolution_cell_size")
        scratch_origin = _vec3(raw.get("convolution_origin"), f"transfer layer[{index}].convolution_origin")
        _require(
            scratch_grid == tuple(layout.get("common_cells", scratch_grid)),
            f"transfer layer[{index}] scratch grid does not match common_cells",
        )
        _require(
            raw.get("active_mask_present") in {True, False},
            f"transfer layer[{index}] active-mask provenance is missing",
        )
        _require(
            raw.get("active_cell_count") == math.prod(native_grid),
            f"transfer layer[{index}] partial active masks are outside this verifier",
        )
        geometries.append(
            TransferGeometry(
                native_grid,
                native_cell,
                native_origin,
                scratch_grid,
                scratch_cell,
                scratch_origin,
            )
        )
    _require(geometries, "transfer parity requires at least one layer")
    return geometries


def _grid_fingerprint(value: Any, name: str) -> str:
    _require(
        isinstance(value, str)
        and len(value) == GRID_FINGERPRINT_LENGTH
        and all(character in "0123456789abcdef" for character in value),
        f"{name} must be a lowercase SHA-256 grid fingerprint",
    )
    return value


def _validate_transfer_provenance(
    artifact: RuntimeArtifact,
    geometries: Sequence[TransferGeometry],
) -> None:
    """Bind transfer declarations to the published layout and mesh contract.

    The runtime provenance names the realization, while the mesh artifact
    carries the resolved source/target grids and fingerprints.  A parity
    result is not trustworthy when either list is reordered, renamed, or
    describes a different grid than ``artifact_layout.layers``.
    """

    metadata = artifact.metadata
    layout = metadata.get("artifact_layout")
    _require(isinstance(layout, dict), "artifact_layout is required")
    raw_layout_layers = layout.get("layers")
    _require(
        isinstance(raw_layout_layers, list) and len(raw_layout_layers) == len(geometries),
        "transfer/layout layer count mismatch",
    )

    execution = metadata.get("execution_provenance")
    _require(isinstance(execution, dict), "execution_provenance is required")
    transfer_provenance = execution.get("fdm_multilayer_transfer")
    _require(isinstance(transfer_provenance, dict), "CPU transfer realization is not explicitly proven in runtime provenance")
    _require(
        transfer_provenance.get("schema_version") == "fdm_multilayer_transfer_realization.v1",
        "CPU transfer realization schema is missing",
    )
    _require(
        transfer_provenance.get("realization") == TRANSFER_REALIZATION,
        "CPU transfer realization is not explicitly proven in runtime provenance",
    )
    provenance_layers = transfer_provenance.get("layers")
    _require(
        isinstance(provenance_layers, list) and len(provenance_layers) == len(raw_layout_layers),
        "execution transfer provenance/layout layer count mismatch",
    )

    mesh = _read_json(artifact.root / "mesh" / "fdm_transfer_provenance.v1.json")
    _require(mesh.get("schema_version") == "fdm_transfer_provenance.v1", "FDM transfer mesh provenance schema mismatch")
    _require(mesh.get("backend") == "fdm_multilayer", "FDM transfer mesh provenance backend mismatch")
    _require(mesh.get("periodic_axes") == [False, False, False], "FDM transfer mesh provenance periodicity mismatch")
    _require(mesh.get("boundary_policy") == ["open", "open", "open"], "FDM transfer mesh provenance boundary policy mismatch")
    mesh_transfers = mesh.get("transfers")
    _require(
        isinstance(mesh_transfers, list) and len(mesh_transfers) == len(raw_layout_layers),
        "mesh transfer provenance/layout layer count mismatch",
    )
    target_fingerprint = _grid_fingerprint(
        mesh.get("target_grid_fingerprint"), "mesh target_grid_fingerprint"
    )
    target_origins = [
        _vec3(layer.get("convolution_origin"), f"artifact_layout.layers[{index}].convolution_origin")
        for index, layer in enumerate(raw_layout_layers)
        if isinstance(layer, dict)
    ]
    _require(len(target_origins) == len(raw_layout_layers), "artifact_layout convolution origins are required")
    common_target_origin = [min(origin[axis] for origin in target_origins) for axis in range(3)]

    for index, (layout_layer, provenance_layer, mesh_transfer, geometry) in enumerate(
        zip(raw_layout_layers, provenance_layers, mesh_transfers, geometries)
    ):
        _require(isinstance(layout_layer, dict), f"artifact_layout layer {index} must be an object")
        _require(isinstance(provenance_layer, dict), f"execution transfer provenance layer {index} must be an object")
        _require(isinstance(mesh_transfer, dict), f"mesh transfer provenance layer {index} must be an object")
        name = layout_layer.get("magnet_name")
        transfer_kind = layout_layer.get("transfer_kind")
        _require(isinstance(name, str) and name, f"artifact_layout layer {index} magnet_name is required")
        _require(transfer_kind == "push_pull", f"artifact_layout layer {index} must use push_pull")
        _require(
            provenance_layer.get("magnet_name") == name
            and provenance_layer.get("transfer_kind") == transfer_kind,
            f"execution transfer provenance layer {index} does not match artifact_layout",
        )
        _require(
            mesh_transfer.get("magnet_name") == name
            and mesh_transfer.get("transfer_kind") == transfer_kind,
            f"mesh transfer provenance layer {index} does not match artifact_layout",
        )
        _require(
            mesh_transfer.get("periodic_axes") == mesh.get("periodic_axes")
            and mesh_transfer.get("boundary_policy") == mesh.get("boundary_policy"),
            f"mesh transfer provenance layer {index} boundary contract mismatch",
        )

        source_grid = mesh_transfer.get("source_grid")
        target_grid = mesh_transfer.get("target_grid")
        _require(isinstance(source_grid, dict), f"mesh transfer provenance layer {index} source_grid is missing")
        _require(isinstance(target_grid, dict), f"mesh transfer provenance layer {index} target_grid is missing")
        _require(
            source_grid.get("cells") == list(geometry.native_grid)
            and source_grid.get("cell_m") == list(geometry.native_cell)
            and source_grid.get("origin_m") == list(geometry.native_origin),
            f"mesh transfer provenance layer {index} source grid does not match artifact_layout",
        )
        _require(
            target_grid.get("cells") == list(geometry.scratch_grid)
            and target_grid.get("cell_m") == list(geometry.scratch_cell),
            f"mesh transfer provenance layer {index} target grid does not match artifact_layout",
        )
        _require(
            target_grid.get("origin_m") == common_target_origin,
            f"mesh transfer provenance layer {index} common target origin does not match artifact_layout",
        )
        _grid_fingerprint(
            mesh_transfer.get("source_grid_fingerprint"),
            f"mesh transfer provenance layer {index} source_grid_fingerprint",
        )
        _require(
            _grid_fingerprint(
                mesh_transfer.get("target_grid_fingerprint"),
                f"mesh transfer provenance layer {index} target_grid_fingerprint",
            )
            == target_fingerprint,
            f"mesh transfer provenance layer {index} target fingerprint mismatch",
        )


def _axis_candidates(
    lo: float,
    hi: float,
    origin: float,
    cell: float,
    count: int,
) -> range:
    first = max(0, math.floor((lo - origin) / cell) - 1)
    last = min(count - 1, math.ceil((hi - origin) / cell) + 1)
    return range(first, max(first, last) + 1)


def _overlap_stencil(geometry: TransferGeometry) -> list[list[tuple[int, float]]]:
    """Build scratch-cell -> native-cell overlap entries in row-major order."""

    nx, ny, nz = geometry.native_grid
    sx, sy, sz = geometry.scratch_grid
    result: list[list[tuple[int, float]]] = [[] for _ in range(geometry.scratch_count)]
    for z in range(sz):
        for y in range(sy):
            for x in range(sx):
                scratch_index = z * sy * sx + y * sx + x
                scratch_lo = tuple(
                    geometry.scratch_origin[axis] + index * geometry.scratch_cell[axis]
                    for axis, index in enumerate((x, y, z))
                )
                scratch_hi = tuple(
                    scratch_lo[axis] + geometry.scratch_cell[axis] for axis in range(3)
                )
                for nz_index in _axis_candidates(
                    scratch_lo[2], scratch_hi[2], geometry.native_origin[2], geometry.native_cell[2], nz
                ):
                    native_lo_z = geometry.native_origin[2] + nz_index * geometry.native_cell[2]
                    overlap_z = max(0.0, min(scratch_hi[2], native_lo_z + geometry.native_cell[2]) - max(scratch_lo[2], native_lo_z))
                    if overlap_z <= 0.0:
                        continue
                    for ny_index in _axis_candidates(
                        scratch_lo[1], scratch_hi[1], geometry.native_origin[1], geometry.native_cell[1], ny
                    ):
                        native_lo_y = geometry.native_origin[1] + ny_index * geometry.native_cell[1]
                        overlap_y = max(0.0, min(scratch_hi[1], native_lo_y + geometry.native_cell[1]) - max(scratch_lo[1], native_lo_y))
                        if overlap_y <= 0.0:
                            continue
                        for nx_index in _axis_candidates(
                            scratch_lo[0], scratch_hi[0], geometry.native_origin[0], geometry.native_cell[0], nx
                        ):
                            native_lo_x = geometry.native_origin[0] + nx_index * geometry.native_cell[0]
                            overlap_x = max(0.0, min(scratch_hi[0], native_lo_x + geometry.native_cell[0]) - max(scratch_lo[0], native_lo_x))
                            overlap = overlap_x * overlap_y * overlap_z
                            if overlap > 0.0:
                                native_index = nz_index * ny * nx + ny_index * nx + nx_index
                                result[scratch_index].append((native_index, overlap))
    return result


def _push_values(
    layer_values: Sequence[tuple[float, float, float]],
    geometry: TransferGeometry,
    overlaps: Sequence[Sequence[tuple[int, float]]],
) -> tuple[list[tuple[float, float, float]], list[float]]:
    _require(len(layer_values) == geometry.native_count, "native magnetisation count does not match transfer geometry")
    scratch_values: list[tuple[float, float, float]] = []
    covered: list[float] = []
    for entries in overlaps:
        total = sum(overlap for _, overlap in entries)
        covered.append(total)
        if total <= 0.0:
            scratch_values.append((0.0, 0.0, 0.0))
            continue
        accumulator = [0.0, 0.0, 0.0]
        for native_index, overlap in entries:
            value = layer_values[native_index]
            for axis in range(3):
                accumulator[axis] += overlap * value[axis]
        scratch_values.append(tuple(value / total for value in accumulator))
    return scratch_values, covered


def _pull_adjoint(
    scratch_values: Sequence[tuple[float, float, float]],
    geometry: TransferGeometry,
    overlaps: Sequence[Sequence[tuple[int, float]]],
    covered: Sequence[float],
) -> list[tuple[float, float, float]]:
    _require(len(scratch_values) == geometry.scratch_count, "scratch field count does not match transfer geometry")
    native_values = [[0.0, 0.0, 0.0] for _ in range(geometry.native_count)]
    for scratch_index, entries in enumerate(overlaps):
        denominator = covered[scratch_index]
        if denominator <= 0.0:
            continue
        for native_index, overlap in entries:
            coefficient = geometry.scratch_volume * overlap / (denominator * geometry.native_volume)
            for axis in range(3):
                native_values[native_index][axis] += coefficient * scratch_values[scratch_index][axis]
    return [tuple(value) for value in native_values]


def _center(geometry: TransferGeometry, index: int, *, scratch: bool) -> tuple[float, float, float]:
    grid = geometry.scratch_grid if scratch else geometry.native_grid
    cell = geometry.scratch_cell if scratch else geometry.native_cell
    origin = geometry.scratch_origin if scratch else geometry.native_origin
    nx, ny, _ = grid
    z, remainder = divmod(index, nx * ny)
    y, x = divmod(remainder, nx)
    return tuple(origin[axis] + (item + 0.5) * cell[axis] for axis, item in enumerate((x, y, z)))


def _scratch_field(
    destination_layer: int,
    destination_index: int,
    artifact: RuntimeArtifact,
    geometries: Sequence[TransferGeometry],
    pushed: Sequence[Sequence[tuple[float, float, float]]],
    tensor_cache: dict[tuple[Any, ...], tuple[float, float, float, float, float, float]],
) -> tuple[float, float, float]:
    destination_geometry = geometries[destination_layer]
    destination = _center(destination_geometry, destination_index, scratch=True)
    field = [0.0, 0.0, 0.0]
    for source_layer, source_geometry in enumerate(geometries):
        for source_index, magnetization in enumerate(pushed[source_layer]):
            source = _center(source_geometry, source_index, scratch=True)
            displacement = tuple(destination[axis] - source[axis] for axis in range(3))
            key = (source_geometry.scratch_cell, destination_geometry.scratch_cell, displacement)
            tensor = tensor_cache.get(key)
            if tensor is None:
                tensor = independent_newell_tensor(
                    source_geometry.scratch_cell,
                    destination_geometry.scratch_cell,
                    displacement,
                )
                tensor_cache[key] = tensor
            matrix = _mat(tensor)
            for axis in range(3):
                field[axis] -= sum(matrix[axis][component] * magnetization[component] for component in range(3))
    return tuple(field)


def _scratch_fields_numpy(
    destination_layer: int,
    artifact: RuntimeArtifact,
    geometries: Sequence[TransferGeometry],
    pushed: Sequence[Sequence[tuple[float, float, float]]],
    tensor_cache: dict[tuple[Any, ...], tuple[float, float, float, float, float, float]],
) -> list[tuple[float, float, float]]:
    """Evaluate all scratch targets with an independent translation sweep.

    The source/destination scratch grids are common by contract.  A lag sweep
    therefore reuses one independently generated cell-pair tensor for every
    overlapping source/target slice, while NumPy only vectorizes the ordinary
    vector accumulation.  No production FFT buffer, kernel catalog, or Rust
    symbol is imported.
    """

    try:
        import numpy as np
    except ImportError as exc:  # pragma: no cover - managed runtime supplies numpy
        raise OracleError("full transfer coverage requires numpy for the independent lag sweep") from exc

    destination_geometry = geometries[destination_layer]
    reference_grid = destination_geometry.scratch_grid
    reference_cell = destination_geometry.scratch_cell
    for index, geometry in enumerate(geometries):
        _require(geometry.scratch_grid == reference_grid, f"layer[{index}] scratch grid differs from common grid")
        _require(geometry.scratch_cell == reference_cell, f"layer[{index}] scratch cell differs from common cell")

    sx, sy, sz = reference_grid
    destination_values = np.zeros((sz, sy, sx, 3), dtype=np.float64)
    destination_origin = destination_geometry.scratch_origin
    for source_layer, source_geometry in enumerate(geometries):
        source_values = np.asarray(pushed[source_layer], dtype=np.float64).reshape((sz, sy, sx, 3))
        origin_delta = tuple(
            destination_origin[axis] - source_geometry.scratch_origin[axis] for axis in range(3)
        )
        for lag_z in range(-(sz - 1), sz):
            source_z0 = max(0, -lag_z)
            source_z1 = min(sz, sz - lag_z)
            destination_z0 = source_z0 + lag_z
            destination_z1 = source_z1 + lag_z
            for lag_y in range(-(sy - 1), sy):
                source_y0 = max(0, -lag_y)
                source_y1 = min(sy, sy - lag_y)
                destination_y0 = source_y0 + lag_y
                destination_y1 = source_y1 + lag_y
                for lag_x in range(-(sx - 1), sx):
                    source_x0 = max(0, -lag_x)
                    source_x1 = min(sx, sx - lag_x)
                    destination_x0 = source_x0 + lag_x
                    destination_x1 = source_x1 + lag_x
                    displacement = (
                        origin_delta[0] + lag_x * reference_cell[0],
                        origin_delta[1] + lag_y * reference_cell[1],
                        origin_delta[2] + lag_z * reference_cell[2],
                    )
                    key = (source_geometry.scratch_cell, destination_geometry.scratch_cell, displacement)
                    tensor = tensor_cache.get(key)
                    if tensor is None:
                        tensor = independent_newell_tensor(
                            source_geometry.scratch_cell,
                            destination_geometry.scratch_cell,
                            displacement,
                        )
                        tensor_cache[key] = tensor
                    matrix = np.asarray(_mat(tensor), dtype=np.float64)
                    source_slice = source_values[
                        source_z0:source_z1,
                        source_y0:source_y1,
                        source_x0:source_x1,
                    ]
                    contribution = np.einsum("...j,ij->...i", source_slice, matrix)
                    destination_values[
                        destination_z0:destination_z1,
                        destination_y0:destination_y1,
                        destination_x0:destination_x1,
                    ] -= contribution
    return [tuple(value) for value in destination_values.reshape((-1, 3))]


def _adjoint_report(
    native_values: Sequence[Sequence[tuple[float, float, float]]],
    pushed: Sequence[Sequence[tuple[float, float, float]]],
    scratch_test: Sequence[Sequence[tuple[float, float, float]]],
    pulled_test: Sequence[Sequence[tuple[float, float, float]]],
    geometries: Sequence[TransferGeometry],
) -> dict[str, Any]:
    left = 0.0
    right = 0.0
    for layer_index, geometry in enumerate(geometries):
        for m, h in zip(pushed[layer_index], scratch_test[layer_index]):
            left += geometry.scratch_volume * sum(m[axis] * h[axis] for axis in range(3))
        for m, h in zip(native_values[layer_index], pulled_test[layer_index]):
            right += geometry.native_volume * sum(m[axis] * h[axis] for axis in range(3))
    residual = abs(left - right)
    tolerance = 1.0e-12 * max(abs(left), abs(right), 1.0)
    return {
        "status": "pass" if residual <= tolerance else "fail",
        "scratch_inner_product": left,
        "native_inner_product": right,
        "abs_residual": residual,
        "tolerance": tolerance,
    }


def _adjoint_test_vectors(
    geometries: Sequence[TransferGeometry],
) -> list[list[list[tuple[float, float, float]]]]:
    """Return two deterministic, non-constant scratch-field probes.

    A constant probe only exercises aggregate overlap weights.  These probes
    vary by layer, scratch-cell index, and vector component so that a cell
    permutation or an incorrect pull coefficient produces a non-zero
    residual.  Keeping the values deterministic makes the report reproducible
    without coupling it to any runtime field buffer.
    """

    probes: list[list[list[tuple[float, float, float]]]] = []
    for probe_index in range(2):
        probe_layers: list[list[tuple[float, float, float]]] = []
        for layer_index, geometry in enumerate(geometries):
            layer_values = [
                (
                    0.17 + 0.071 * probe_index + 0.013 * layer_index + 0.0017 * cell_index,
                    -0.29 + 0.053 * probe_index - 0.009 * layer_index + 0.0023 * cell_index,
                    0.41 - 0.037 * probe_index + 0.011 * layer_index - 0.0011 * cell_index,
                )
                for cell_index in range(geometry.scratch_count)
            ]
            probe_layers.append(layer_values)
        probes.append(probe_layers)
    return probes


def verify_transfer_artifact(
    root: str | Path,
    *,
    field_rtol: float = FIELD_RTOL,
    field_atol: float = FIELD_ATOL_A_PER_M,
    max_target_cells: int = 1,
    max_energy_cells: int = 4096,
) -> dict[str, Any]:
    artifact = load_runtime_artifact(root)
    _require(artifact.metadata.get("execution_provenance", {}).get("execution_engine") == "cpu_reference_multilayer", "transfer verifier requires CPU reference runtime provenance")
    geometries = _layout_geometries(artifact)
    _validate_transfer_provenance(artifact, geometries)
    overlaps = [_overlap_stencil(geometry) for geometry in geometries]
    pushed: list[list[tuple[float, float, float]]] = []
    covered: list[list[float]] = []
    for layer, geometry, stencil in zip(artifact.layers, geometries, overlaps):
        values, coverage = _push_values(layer.magnetization, geometry, stencil)
        pushed.append(values)
        covered.append(coverage)

    try:
        import numpy  # noqa: F401

        numpy_available = True
    except ImportError:
        numpy_available = False

    adjoint_cases: list[dict[str, Any]] = []
    for scratch_test in _adjoint_test_vectors(geometries):
        pulled_test = [
            _pull_adjoint(values, geometry, stencil, coverage)
            for values, geometry, stencil, coverage in zip(scratch_test, geometries, overlaps, covered)
        ]
        adjoint_cases.append(
            _adjoint_report(
                [layer.magnetization for layer in artifact.layers],
                pushed,
                scratch_test,
                pulled_test,
                geometries,
            )
        )
    adjoint = dict(adjoint_cases[0])
    adjoint["vector_cases"] = adjoint_cases
    adjoint["vector_case_count"] = len(adjoint_cases)
    adjoint["status"] = "pass" if all(case["status"] == "pass" for case in adjoint_cases) else "fail"
    adjoint["max_abs_residual"] = max(case["abs_residual"] for case in adjoint_cases)
    adjoint["max_tolerance"] = max(case["tolerance"] for case in adjoint_cases)

    tensor_cache: dict[tuple[Any, ...], tuple[float, float, float, float, float, float]] = {}
    errors: list[float] = []
    expected_values: dict[int, dict[int, tuple[float, float, float]]] = {}
    sampled_target_cells = 0
    full_coverage = True
    for destination_layer, (layer, geometry, stencil, coverage) in enumerate(
        zip(artifact.layers, geometries, overlaps, covered)
    ):
        indices = _sample_indices(layer.count, max_target_cells)
        full_coverage &= len(indices) == layer.count
        sampled_target_cells += len(indices)
        layer_expected: dict[int, tuple[float, float, float]] = {}
        if numpy_available:
            scratch_fields = _scratch_fields_numpy(
                destination_layer, artifact, geometries, pushed, tensor_cache
            )
        else:
            needed_scratch = {
                scratch_index
                for scratch_index, entries in enumerate(stencil)
                if any(native_index in {entry[0] for entry in entries} for native_index in indices)
            }
            scratch_fields = [(0.0, 0.0, 0.0)] * geometry.scratch_count
            for scratch_index in needed_scratch:
                scratch_fields[scratch_index] = _scratch_field(
                    destination_layer, scratch_index, artifact, geometries, pushed, tensor_cache
                )
        native_fields = _pull_adjoint(scratch_fields, geometry, stencil, coverage)
        for native_index in indices:
            native_field = native_fields[native_index]
            layer_expected[native_index] = native_field
            actual = layer.field[native_index]
            errors.extend(abs(actual[axis] - native_field[axis]) for axis in range(3))
        expected_values[destination_layer] = layer_expected

    max_error = max(errors, default=0.0)
    scale = max(
        max((abs(component) for layer in artifact.layers for vector in layer.field for component in vector), default=0.0),
        1.0,
    )
    tolerance = field_atol + field_rtol * scale
    field_status = "pass" if max_error <= tolerance else "fail"

    energy: dict[str, Any]
    if sum(layer.count for layer in artifact.layers) > max_energy_cells:
        energy = {"status": "blocked", "reason": "full_energy_coverage_limit", "max_energy_cells": max_energy_cells}
    elif not full_coverage:
        energy = {"status": "blocked", "reason": "full_field_coverage_required_for_energy"}
    else:
        expected_energy = 0.0
        runtime_energy = 0.0
        for layer_index, layer in enumerate(artifact.layers):
            values = expected_values[layer_index]
            for native_index, magnetization in enumerate(layer.magnetization):
                expected_field = values[native_index]
                runtime_field = layer.field[native_index]
                expected_energy += -0.5 * MU0 * geometries[layer_index].native_volume * sum(magnetization[axis] * expected_field[axis] for axis in range(3))
                runtime_energy += -0.5 * MU0 * geometries[layer_index].native_volume * sum(magnetization[axis] * runtime_field[axis] for axis in range(3))
        reported = _read_reported_energy(artifact)
        energy_scale = max(abs(expected_energy), abs(runtime_energy), abs(reported or 0.0), 1.0e-30)
        energy_tolerance = 1.0e-8 * energy_scale
        energy = {
            "status": "pass" if abs(expected_energy - runtime_energy) <= energy_tolerance and (reported is None or abs(reported - expected_energy) <= energy_tolerance) else "fail",
            "expected_energy_J": expected_energy,
            "runtime_field_energy_J": runtime_energy,
            "reported_energy_J": reported,
            "tolerance_J": energy_tolerance,
        }

    status = "qualified" if field_status == "pass" and full_coverage and energy["status"] == "pass" and adjoint["status"] == "pass" else "not_qualified"
    return {
        "schema_version": SCHEMA_VERSION,
        "qualification_scope": QUALIFICATION_SCOPE,
        "qualification_status": status,
        "transfer_realization": TRANSFER_REALIZATION,
        "runtime_artifact": str(Path(root)),
        "layer_count": len(artifact.layers),
        "field_norm": {
            "status": field_status,
            "sampled_target_cells": sampled_target_cells,
            "full_field_coverage": full_coverage,
            "max_abs_component_error_A_per_m": max_error,
            "tolerance_A_per_m": tolerance,
            "rtol": field_rtol,
            "atol_A_per_m": field_atol,
        },
        "energy_norm": energy,
        "transfer_adjoint": adjoint,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runtime_artifact", type=Path)
    parser.add_argument("--max-target-cells", type=int, default=1)
    parser.add_argument("--max-energy-cells", type=int, default=4096)
    parser.add_argument("--json-output", type=Path)
    args = parser.parse_args()
    try:
        report = verify_transfer_artifact(
            args.runtime_artifact,
            max_target_cells=args.max_target_cells,
            max_energy_cells=args.max_energy_cells,
        )
    except OracleError as exc:
        report = {
            "schema_version": SCHEMA_VERSION,
            "qualification_scope": QUALIFICATION_SCOPE,
            "qualification_status": "blocked",
            "runtime_artifact": str(args.runtime_artifact),
            "reason": str(exc),
        }
        print(json.dumps(report, indent=2, sort_keys=True))
        return 3
    rendered = json.dumps(report, indent=2, sort_keys=True)
    print(rendered)
    if args.json_output:
        args.json_output.write_text(rendered + "\n", encoding="utf-8")
    return 0 if report["qualification_status"] == "qualified" else 3


if __name__ == "__main__":
    raise SystemExit(main())
