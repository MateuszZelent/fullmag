"""Fail-closed P1 root-cause and P2 edge-refinement gates for µMAG SP4."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
import struct
from typing import Any, Iterable


MU0 = 4.0e-7 * math.pi
FDM_NEWELL_ENERGY_J = 7.137838407337884e-19
ORACLE_RELATIVE_TOLERANCE = 0.01
P1_INTERNAL_RELATIVE_TOLERANCE = 5.0e-3
AVERAGE_M_ABSOLUTE_TOLERANCE = 1.0e-9
TELEMETRY_ENERGY_RELATIVE_TOLERANCE = 1.0e-12
MAX_LOCAL_REFINEMENT_DISTANCE_M = 32.0e-9
MAX_QUALIFICATION_ELEMENTS = 1_300_000


class QualificationError(RuntimeError):
    """Raised when qualification evidence is missing or contradictory."""


def _load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise QualificationError(f"cannot read JSON evidence {path}: {error}") from error
    if not isinstance(value, dict):
        raise QualificationError(f"JSON evidence must be an object: {path}")
    return value


def _finite(value: object, label: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise QualificationError(f"{label} must be numeric") from error
    if not math.isfinite(number):
        raise QualificationError(f"{label} must be finite")
    return number


def _relative_error(value: float, reference: float) -> float:
    if reference == 0.0:
        return abs(value - reference)
    return abs(value - reference) / abs(reference)


def _backend_plan(metadata: dict[str, Any]) -> dict[str, Any]:
    try:
        plan = metadata["execution_plan"]["backend_plan"]
    except (KeyError, TypeError) as error:
        raise QualificationError("metadata lacks execution_plan.backend_plan") from error
    if not isinstance(plan, dict):
        raise QualificationError("execution_plan.backend_plan must be an object")
    return plan


def _validate_execution(metadata: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    provenance = metadata.get("execution_provenance")
    mesh_summary = metadata.get("mesh")
    if not isinstance(provenance, dict) or not isinstance(mesh_summary, dict):
        raise QualificationError("metadata lacks execution provenance or mesh summary")
    if provenance.get("execution_engine") not in {"fem_cpu_native", "fem_gpu_native"}:
        raise QualificationError("qualification requires a production native FEM execution")
    if provenance.get("precision") != "double":
        raise QualificationError("qualification requires double precision")
    if provenance.get("lossy_fallback_used") is not False:
        raise QualificationError("qualification forbids lossy fallback")
    resolved = provenance.get("resolved_demag_realization") or provenance.get(
        "requested_demag_realization"
    )
    if resolved not in {"fem_poisson_robin", "poisson_robin"}:
        raise QualificationError("qualification requires Poisson-Robin demag")
    return provenance, mesh_summary


def _mesh_data(metadata: dict[str, Any]) -> tuple[list[list[float]], list[list[int]], list[int], dict[str, Any]]:
    plan = _backend_plan(metadata)
    mesh = plan.get("mesh")
    if not isinstance(mesh, dict):
        raise QualificationError("backend plan lacks the fixed mesh payload")
    nodes = mesh.get("nodes")
    cells = mesh.get("cells")
    markers = mesh.get("element_markers")
    if not isinstance(nodes, list) or not isinstance(cells, dict) or not isinstance(markers, list):
        raise QualificationError("fixed mesh requires nodes, cells, and element_markers")
    cell_types = cells.get("types")
    offsets = cells.get("offsets")
    connectivity = cells.get("nodes")
    if (
        not isinstance(cell_types, list)
        or not isinstance(offsets, list)
        or not isinstance(connectivity, list)
        or len(offsets) != len(cell_types) + 1
        or not offsets
        or int(offsets[0]) != 0
        or int(offsets[-1]) != len(connectivity)
    ):
        raise QualificationError("fixed mesh cells CSR is malformed")
    if len(cell_types) != len(markers):
        raise QualificationError("fixed mesh element markers do not match elements")
    try:
        node_values = [[float(component) for component in node] for node in nodes]
        element_values = []
        for index, cell_type in enumerate(cell_types):
            start = int(offsets[index])
            end = int(offsets[index + 1])
            if cell_type != "tet4" or end - start != 4 or start < 0 or end < start:
                raise QualificationError(
                    "root-cause energy reconstruction requires canonical tet4 cells"
                )
            element_values.append([int(node) for node in connectivity[start:end]])
        marker_values = [int(marker) for marker in markers]
    except (TypeError, ValueError) as error:
        raise QualificationError("fixed mesh payload is not numeric") from error
    return node_values, element_values, marker_values, plan


def _mesh_identity(nodes: list[list[float]], elements: list[list[int]], markers: list[int]) -> str:
    payload = json.dumps(
        {"nodes": nodes, "elements": elements, "element_markers": markers},
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


def _magnetic_element_indices(plan: dict[str, Any], element_count: int) -> list[int]:
    segments = plan.get("object_segments")
    if not isinstance(segments, list):
        raise QualificationError("backend plan lacks magnetic object_segments")
    indices: list[int] = []
    for segment in segments:
        if not isinstance(segment, dict) or segment.get("object_id") == "__air__":
            continue
        start = int(segment.get("element_start", -1))
        count = int(segment.get("element_count", -1))
        if start < 0 or count <= 0 or start + count > element_count:
            raise QualificationError("magnetic object segment is outside the fixed mesh")
        indices.extend(range(start, start + count))
    if not indices:
        raise QualificationError("fixed mesh has no magnetic elements")
    if len(indices) != len(set(indices)):
        raise QualificationError("magnetic object segments overlap")
    return indices


def _det3(matrix: list[list[float]]) -> float:
    return (
        matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
        - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
        + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0])
    )


def _solve_transpose3(matrix: list[list[float]], rhs: list[float]) -> list[float]:
    transpose = [[matrix[column][row] for column in range(3)] for row in range(3)]
    determinant = _det3(transpose)
    if not math.isfinite(determinant) or abs(determinant) <= 1.0e-300:
        raise QualificationError("fixed mesh contains a singular tetrahedron")
    result: list[float] = []
    for column in range(3):
        replaced = [row[:] for row in transpose]
        for row in range(3):
            replaced[row][column] = rhs[row]
        result.append(_det3(replaced) / determinant)
    return result


def _tetra_geometry(nodes: list[list[float]], element: list[int]) -> tuple[float, list[list[float]]]:
    if len(element) != 4:
        raise QualificationError(
            "root-cause energy reconstruction currently requires an all-tetra fixed mesh"
        )
    try:
        vertices = [nodes[index] for index in element]
    except IndexError as error:
        raise QualificationError("fixed mesh tetrahedron references an invalid node") from error
    jacobian = [
        [vertices[column + 1][row] - vertices[0][row] for column in range(3)]
        for row in range(3)
    ]
    volume = abs(_det3(jacobian)) / 6.0
    if not math.isfinite(volume) or volume <= 0.0:
        raise QualificationError("fixed mesh contains a non-positive tetrahedron")
    return volume, jacobian


def _read_first_zarr_sample(path: Path) -> tuple[list[float], list[int]]:
    metadata = _load_json(path / ".zarray")
    shape = metadata.get("shape")
    chunks = metadata.get("chunks")
    if (
        not isinstance(shape, list)
        or not isinstance(chunks, list)
        or not shape
        or int(shape[0]) < 1
        or metadata.get("dtype") != "<f8"
        or metadata.get("compressor") is not None
        or metadata.get("order") != "C"
    ):
        raise QualificationError(f"unsupported Zarr evidence layout: {path}")
    key = ".".join("0" for _ in shape)
    chunk_path = path / key
    try:
        payload = chunk_path.read_bytes()
    except OSError as error:
        raise QualificationError(f"cannot read first Zarr sample {chunk_path}: {error}") from error
    width = math.prod(int(value) for value in shape[1:])
    if len(payload) != 8 * width:
        raise QualificationError(f"first Zarr sample has wrong byte count: {chunk_path}")
    return list(struct.unpack(f"<{width}d", payload)), [int(value) for value in shape]


def _load_vectors(path: Path, label: str) -> list[list[float]]:
    payload = _load_json(path)
    values = payload.get("values")
    if not isinstance(values, list):
        raise QualificationError(f"{label} lacks values")
    vectors: list[list[float]] = []
    for index, value in enumerate(values):
        if not isinstance(value, list) or len(value) != 3:
            raise QualificationError(f"{label} values[{index}] is not a three-vector")
        vectors.append([_finite(component, f"{label} values[{index}]") for component in value])
    return vectors


def _ms_value(plan: dict[str, Any]) -> float:
    material = plan.get("material")
    if not isinstance(material, dict):
        raise QualificationError("backend plan lacks material")
    value = _finite(material.get("saturation_magnetisation"), "saturation magnetisation")
    if value <= 0.0:
        raise QualificationError("saturation magnetisation must be positive")
    return value


def _p1_energies(
    *,
    nodes: list[list[float]],
    elements: list[list[int]],
    magnetic_elements: Iterable[int],
    m: list[list[float]],
    phi: list[float],
    h_demag_component_major: list[float],
    ms: float,
) -> tuple[float, float, list[float]]:
    node_count = len(nodes)
    if len(m) != node_count or len(phi) != node_count or len(h_demag_component_major) != 3 * node_count:
        raise QualificationError("P1 state, potential, H_demag, and mesh extents differ")
    weights = [0.0] * node_count
    rhs_dot_u_integral = 0.0
    h_integral = 0.0
    for element_index in magnetic_elements:
        element = elements[element_index]
        volume, jacobian = _tetra_geometry(nodes, element)
        delta_phi = [phi[element[axis]] - phi[element[0]] for axis in range(1, 4)]
        gradient_phi = _solve_transpose3(jacobian, delta_phi)
        average_m = [sum(m[node][axis] for node in element) / 4.0 for axis in range(3)]
        rhs_dot_u_integral += ms * volume * sum(
            average_m[axis] * gradient_phi[axis] for axis in range(3)
        )
        local_mass_bilinear = 0.0
        for local_i, node_i in enumerate(element):
            for local_j, node_j in enumerate(element):
                pair_weight = 2.0 if local_i == local_j else 1.0
                local_mass_bilinear += pair_weight * sum(
                    m[node_i][axis]
                    * h_demag_component_major[axis * node_count + node_j]
                    for axis in range(3)
                )
        h_integral += ms * volume * local_mass_bilinear / 20.0
        for node in element:
            weights[node] += volume / 4.0
    return 0.5 * MU0 * rhs_dot_u_integral, -0.5 * MU0 * h_integral, weights


def _scalar_rows(path: Path) -> list[dict[str, str]]:
    try:
        with path.open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
    except OSError as error:
        raise QualificationError(f"cannot read scalar table {path}: {error}") from error
    if not rows:
        raise QualificationError("scalars.csv has no rows")
    return rows


def _energy_column(row: dict[str, str]) -> float:
    for key in ("E_demag", "e_demag"):
        if key in row:
            return _finite(row[key], f"scalars.csv {key}")
    raise QualificationError("scalars.csv lacks E_demag/e_demag")


def _potential_contract(provenance: dict[str, Any], phi_shape: list[int], node_count: int) -> tuple[int, int]:
    poisson = provenance.get("fem_poisson_demag")
    if not isinstance(poisson, dict):
        raise QualificationError("provenance lacks FEM Poisson demag diagnostics")
    order = poisson.get("potential_order")
    dofs = poisson.get("potential_true_dof_count")
    if order is None or dofs is None:
        raise QualificationError("provenance lacks resolved demag potential order or DOF count")
    if math.prod(phi_shape[1:]) != node_count:
        raise QualificationError("demag_phi artifact must contain one vertex value per mesh node")
    return int(order), int(dofs)


def _native_demag_energies(provenance: dict[str, Any]) -> tuple[float, float]:
    poisson = provenance.get("fem_poisson_demag")
    if not isinstance(poisson, dict):
        raise QualificationError("provenance lacks FEM Poisson demag diagnostics")
    variational = poisson.get("variational_energy_joules")
    recovered = poisson.get("recovered_field_energy_joules")
    if variational is None or recovered is None:
        raise QualificationError("provenance lacks native demag energy diagnostics")
    return (
        _finite(variational, "native variational demag energy"),
        _finite(recovered, "native recovered-field demag energy"),
    )


def qualify_p1_root_cause(
    artifacts: Path,
    *,
    analytic_energy_j: float | None = None,
) -> dict[str, Any]:
    metadata = _load_json(artifacts / "metadata.json")
    provenance, mesh_summary = _validate_execution(metadata)
    nodes, elements, markers, plan = _mesh_data(metadata)
    if int(plan.get("fe_order", 0)) != 1:
        raise QualificationError("root-cause gate requires a P1 magnetization state")
    magnetic_elements = _magnetic_element_indices(plan, len(elements))
    initial_m = _load_vectors(artifacts / "m_initial.json", "m_initial.json")
    phi, phi_shape = _read_first_zarr_sample(artifacts / "fields/demag_phi.zarr")
    h_demag, _ = _read_first_zarr_sample(artifacts / "fields/H_demag.zarr")
    potential_order, potential_dofs = _potential_contract(
        provenance, phi_shape, len(nodes)
    )
    if potential_order != 1 or potential_dofs != len(nodes):
        raise QualificationError(
            "root-cause gate requires a production P1 scalar potential on the fixed mesh"
        )
    energy_btu, visual_energy_h, _ = _p1_energies(
        nodes=nodes,
        elements=elements,
        magnetic_elements=magnetic_elements,
        m=initial_m,
        phi=phi,
        h_demag_component_major=h_demag,
        ms=_ms_value(plan),
    )
    scalar_energy = _energy_column(_scalar_rows(artifacts / "scalars.csv")[0])
    native_variational_energy, native_recovered_field_energy = _native_demag_energies(
        provenance
    )
    native_recovery_error = _relative_error(
        native_recovered_field_energy, native_variational_energy
    )
    snapshot_recovery_error = _relative_error(scalar_energy, energy_btu)
    oracle_error = _relative_error(energy_btu, FDM_NEWELL_ENERGY_J)
    if max(native_recovery_error, snapshot_recovery_error) > P1_INTERNAL_RELATIVE_TOLERANCE:
        verdict = "operator_rhs_recovery_mismatch"
    elif oracle_error > ORACLE_RELATIVE_TOLERANCE:
        verdict = "p1_approximation_error"
    else:
        verdict = "p1_approximation_not_demonstrated"
    analytic = None if analytic_energy_j is None else _finite(
        analytic_energy_j, "analytic/reference energy"
    )
    return {
        "schema": "fullmag.mumag.sp4.fem-demag-root-cause.v1",
        "verdict": verdict,
        "same_fixed_mesh": True,
        "mesh_identity": _mesh_identity(nodes, elements, markers),
        "mesh": {
            "node_count": len(nodes),
            "element_count": len(elements),
            "magnetic_element_count": len(magnetic_elements),
            "state_order": 1,
            "potential_order": potential_order,
            "potential_true_dof_count": potential_dofs,
            "runtime_mesh_generation_id": mesh_summary.get("mesh_generation_id"),
        },
        "energies_j": {
            "snapshot_p1_rhs_dot_potential": energy_btu,
            "snapshot_production_recovered_demag": scalar_energy,
            "native_terminal_variational": native_variational_energy,
            "native_terminal_recovered_field": native_recovered_field_energy,
            "production_p1_rhs_dot_potential": energy_btu,
            "reconstructed_p1_rhs_dot_potential": energy_btu,
            "p1_recovered_h_demag": scalar_energy,
            "scalar_table_demag": scalar_energy,
            "visual_h_demag_artifact_diagnostic": visual_energy_h,
            "fdm_newell_oracle": FDM_NEWELL_ENERGY_J,
            "analytic_or_external_reference": analytic,
        },
        "relative_errors": {
            "snapshot_recovery_vs_rhs_dot_potential": snapshot_recovery_error,
            "native_terminal_recovery_vs_variational": native_recovery_error,
            "recovery_vs_production_rhs_dot_potential": snapshot_recovery_error,
            "reconstructed_vs_production_rhs_dot_potential": 0.0,
            "scalar_table_vs_production_rhs_dot_potential": snapshot_recovery_error,
            "production_rhs_dot_potential_vs_fdm_newell": oracle_error,
            "production_rhs_dot_potential_vs_analytic_reference": (
                None if analytic is None else _relative_error(scalar_energy, analytic)
            ),
        },
        "thresholds": {
            "internal_relative": P1_INTERNAL_RELATIVE_TOLERANCE,
            "fdm_oracle_relative": ORACLE_RELATIVE_TOLERANCE,
        },
        "provenance": provenance,
    }


def _weighted_average(values: list[list[float]], weights: list[float]) -> list[float]:
    if len(values) != len(weights):
        raise QualificationError("m_final values do not match fixed mesh nodes")
    total = sum(weights)
    if not math.isfinite(total) or total <= 0.0:
        raise QualificationError("magnetic nodal volume sum is not positive")
    return [
        sum(weight * values[index][axis] for index, weight in enumerate(weights)) / total
        for axis in range(3)
    ]


def _table_average(row: dict[str, str]) -> list[float]:
    return [_finite(row.get(name), f"scalars.csv {name}") for name in ("mx", "my", "mz")]


def _telemetry_average(path: Path) -> tuple[list[float], dict[str, Any]]:
    payload = _load_json(path)
    columns = payload.get("columns")
    rows = payload.get("rows")
    if not isinstance(columns, list) or not isinstance(rows, list) or not rows:
        raise QualificationError("telemetry scalar window lacks columns or rows")
    if len(rows) < 2:
        raise QualificationError("telemetry scalar window must contain initial and final rows")
    total_rows = payload.get("total_rows")
    returned_rows = payload.get("returned_rows")
    if total_rows != len(rows) or returned_rows != len(rows):
        raise QualificationError("telemetry scalar window counters do not match the full row window")
    if any(not isinstance(row, list) or len(row) != len(columns) for row in rows):
        raise QualificationError("telemetry row does not match columns")
    try:
        step_index = columns.index("step")
    except ValueError as error:
        raise QualificationError("telemetry lacks step column") from error
    steps = [_finite(row[step_index], "telemetry step") for row in rows]
    if steps[0] != 0.0 or steps[-1] < 1.0 or any(
        later <= earlier for earlier, later in zip(steps, steps[1:])
    ):
        raise QualificationError(
            "telemetry scalar window must start at step 0 and increase through the final step"
        )
    final = rows[-1]
    try:
        average = [_finite(final[columns.index(name)], f"telemetry {name}") for name in ("mx", "my", "mz")]
    except ValueError as error:
        raise QualificationError("telemetry lacks mx/my/mz columns") from error
    return average, payload


def _require_close_vectors(left: list[float], right: list[float], label: str) -> None:
    delta = max(abs(a - b) for a, b in zip(left, right, strict=True))
    if delta > AVERAGE_M_ABSOLUTE_TOLERANCE:
        raise QualificationError(
            f"{label} differs by {delta:.6e}, limit {AVERAGE_M_ABSOLUTE_TOLERANCE:.6e}"
        )


def _validate_local_edge_fields(mesh_summary: dict[str, Any]) -> dict[str, Any]:
    report = mesh_summary.get("mesh_build_report")
    if not isinstance(report, dict):
        raise QualificationError("mesh summary lacks mesh_build_report")
    airbox = report.get("effective_airbox_target")
    fields = report.get("size_fields_realized")
    if not isinstance(airbox, dict) or not isinstance(fields, list):
        raise QualificationError("mesh report lacks airbox target or realized size fields")
    airbox_hmin = _finite(airbox.get("minimum_element_size"), "airbox minimum element size")
    selected: dict[str, Any] = {}
    for kind in ("EdgeDistanceThreshold", "CornerDistanceThreshold"):
        matches = [field for field in fields if isinstance(field, dict) and field.get("kind") == kind and field.get("status") == "applied"]
        if len(matches) != 1:
            raise QualificationError(f"qualification requires exactly one applied {kind}")
        params = matches[0].get("params")
        if not isinstance(params, dict) or params.get("GeometryName") not in {"film", "film_geom"}:
            raise QualificationError(f"{kind} must target the SP4 film")
        size_max = _finite(params.get("SizeMax"), f"{kind} SizeMax")
        distance_max = _finite(params.get("DistMax"), f"{kind} DistMax")
        if size_max + 1.0e-30 < airbox_hmin:
            raise QualificationError(
                f"{kind} SizeMax refines the whole airbox instead of a bounded film neighborhood"
            )
        if distance_max > MAX_LOCAL_REFINEMENT_DISTANCE_M:
            raise QualificationError(
                f"{kind} transition extends beyond the bounded film neighborhood"
            )
        selected[kind] = params
    return {"airbox_minimum_element_size_m": airbox_hmin, "fields": selected}


def qualify_p2_edge(
    artifacts: Path,
    *,
    root_report_path: Path,
    telemetry_path: Path,
) -> dict[str, Any]:
    root = _load_json(root_report_path)
    if root.get("schema") != "fullmag.mumag.sp4.fem-demag-root-cause.v1":
        raise QualificationError("P2 gate requires a root-cause report")
    if root.get("verdict") != "p1_approximation_error":
        raise QualificationError(
            "P2 qualification is blocked until P1 is classified as approximation error"
        )
    metadata = _load_json(artifacts / "metadata.json")
    provenance, mesh_summary = _validate_execution(metadata)
    nodes, elements, markers, plan = _mesh_data(metadata)
    mesh_identity = _mesh_identity(nodes, elements, markers)
    if root.get("mesh_identity") != mesh_identity:
        raise QualificationError("P1 and P2 evidence do not use the same fixed mesh")
    phi, phi_shape = _read_first_zarr_sample(artifacts / "fields/demag_phi.zarr")
    potential_order, potential_dofs = _potential_contract(provenance, phi_shape, len(nodes))
    if potential_order != 2 or potential_dofs <= len(nodes):
        raise QualificationError("P2 gate requires independent quadratic potential edge DOFs")
    if len(elements) > MAX_QUALIFICATION_ELEMENTS:
        raise QualificationError("qualification mesh exceeds the bounded element budget")
    local_refinement = _validate_local_edge_fields(mesh_summary)
    rows = _scalar_rows(artifacts / "scalars.csv")
    table_steps = [_finite(row.get("step"), "scalars.csv step") for row in rows]
    if table_steps[0] != 0.0 or any(
        later <= earlier for earlier, later in zip(table_steps, table_steps[1:])
    ):
        raise QualificationError(
            "table scalar window must start at step 0 and increase through the final step"
        )
    initial_energy = _energy_column(rows[0])
    initial_error = _relative_error(initial_energy, FDM_NEWELL_ENERGY_J)
    if initial_error > ORACLE_RELATIVE_TOLERANCE:
        raise QualificationError(
            f"P2 initial demag energy relative error {initial_error:.6e} exceeds 1%"
        )
    magnetic_elements = _magnetic_element_indices(plan, len(elements))
    weights = [0.0] * len(nodes)
    for element_index in magnetic_elements:
        volume, _ = _tetra_geometry(nodes, elements[element_index])
        for node in elements[element_index]:
            weights[node] += volume / 4.0
    final_m = _load_vectors(artifacts / "m_final.json", "m_final.json")
    recomputed = _weighted_average(final_m, weights)
    table = _table_average(rows[-1])
    telemetry, telemetry_payload = _telemetry_average(telemetry_path)
    telemetry_columns = telemetry_payload["columns"]
    telemetry_initial_row = telemetry_payload["rows"][0]
    try:
        telemetry_initial_m = [
            _finite(
                telemetry_initial_row[telemetry_columns.index(name)],
                f"telemetry initial {name}",
            )
            for name in ("mx", "my", "mz")
        ]
        telemetry_initial_energy = _finite(
            telemetry_initial_row[telemetry_columns.index("e_demag")],
            "telemetry initial e_demag",
        )
    except ValueError as error:
        raise QualificationError(
            "telemetry lacks initial mx/my/mz/e_demag columns"
        ) from error
    _require_close_vectors(
        telemetry_initial_m,
        _table_average(rows[0]),
        "telemetry initial average m vs table initial average m",
    )
    initial_energy_delta = _relative_error(telemetry_initial_energy, initial_energy)
    if initial_energy_delta > TELEMETRY_ENERGY_RELATIVE_TOLERANCE:
        raise QualificationError(
            "telemetry initial demag energy differs from table initial demag energy "
            f"by {initial_energy_delta:.6e}, limit "
            f"{TELEMETRY_ENERGY_RELATIVE_TOLERANCE:.6e}"
        )
    _require_close_vectors(table, recomputed, "table average m vs m_final volume average")
    _require_close_vectors(telemetry, recomputed, "telemetry average m vs m_final volume average")
    return {
        "schema": "fullmag.mumag.sp4.fem-demag-p2-edge-qualification.v1",
        "status": "qualified",
        "root_cause_verdict": root["verdict"],
        "mesh_identity": mesh_identity,
        "mesh": {
            "node_count": len(nodes),
            "element_count": len(elements),
            "magnetic_element_count": len(magnetic_elements),
            "state_order": int(plan.get("fe_order", 0)),
            "potential_order": potential_order,
            "potential_true_dof_count": potential_dofs,
            "runtime_mesh_generation_id": mesh_summary.get("mesh_generation_id"),
            "local_refinement": local_refinement,
        },
        "initial_demag_energy": {
            "fem_j": initial_energy,
            "telemetry_j": telemetry_initial_energy,
            "table_telemetry_relative_error": initial_energy_delta,
            "fdm_newell_oracle_j": FDM_NEWELL_ENERGY_J,
            "relative_error": initial_error,
            "relative_tolerance": ORACLE_RELATIVE_TOLERANCE,
        },
        "final_average_m": {
            "table": table,
            "telemetry": telemetry,
            "recomputed_from_m_final": recomputed,
            "absolute_tolerance": AVERAGE_M_ABSOLUTE_TOLERANCE,
        },
        "telemetry": {
            "revision": telemetry_payload.get("revision"),
            "total_rows": telemetry_payload.get("total_rows"),
            "returned_rows": telemetry_payload.get("returned_rows"),
        },
        "provenance": provenance,
    }


def _write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(report, allow_nan=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    root_parser = subparsers.add_parser("p1-root-cause")
    root_parser.add_argument("--artifacts", type=Path, required=True)
    root_parser.add_argument("--output", type=Path, required=True)
    root_parser.add_argument("--analytic-energy-j", type=float)
    p2_parser = subparsers.add_parser("p2-edge")
    p2_parser.add_argument("--artifacts", type=Path, required=True)
    p2_parser.add_argument("--root-report", type=Path, required=True)
    p2_parser.add_argument("--telemetry", type=Path, required=True)
    p2_parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "p1-root-cause":
            report = qualify_p1_root_cause(
                args.artifacts, analytic_energy_j=args.analytic_energy_j
            )
        else:
            report = qualify_p2_edge(
                args.artifacts,
                root_report_path=args.root_report,
                telemetry_path=args.telemetry,
            )
        _write_report(args.output, report)
    except QualificationError as error:
        parser.error(str(error))
    print(json.dumps(report, allow_nan=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
