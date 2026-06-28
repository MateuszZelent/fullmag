"""Validate periodic-airbox FEM demag comparison artifacts.

The P2 periodic demag gate compares a primitive periodic cell against a
supercell reference while also checking continuity on periodic seams.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import shutil
import struct
from pathlib import Path
from typing import Iterable, Sequence

from helpers import (
    ValidationFailure,
    _fullmag,
    require_finite_metrics,
    require_native_runtime_core,
    require_periodic_pair_continuity,
    require_solver_telemetry,
    require_supercell_reference_close,
    write_csv,
)
from telemetry_validation import read_csv_rows

DEFAULT_CSV = Path(__file__).resolve().parent / "results" / "periodic_airbox_validation.csv"
DEFAULT_RUNTIME_DIR = Path(".fullmag") / "reports" / "fem-demag-periodic-airbox-validation"

NM = 1.0e-9
CELL_SIZE = (80.0 * NM, 80.0 * NM, 10.0 * NM)
AIRBOX_Z = 40.0 * NM
HOLE_RADIUS = 10.0 * NM
MS = 800e3
AEX = 13e-12
ALPHA = 0.5
M_DIR = (1.0, 0.0, 0.0)
RELAX_MAX_STEPS = 2
RELAX_ALGORITHM = "projected_gradient_bb"
RELAX_TOL = 1.0e-5
MU0 = 4.0e-7 * math.pi
MAGNETIC_MESH_MIN = 3.0 * NM
MAGNETIC_MESH_MAX = 8.0 * NM
MAGNETIC_INTERFACE_HMAX = 5.0 * NM
MAGNETIC_EDGE_HMAX = 4.0 * NM
HOLE_REFINEMENT_HMAX = 4.0 * NM
HOLE_REFINEMENT_RADIUS = HOLE_RADIUS + 8.0 * NM


def _primitive_rows(rows: Sequence[dict]) -> list[dict]:
    return [row for row in rows if row.get("model") == "primitive_periodic"]


def periodic_airbox_model_uses_lateral_pbc(model: str) -> bool:
    """Return whether a validation model should constrain lateral outer faces periodically."""
    return model in {"primitive_periodic", "supercell_reference"}


def latest_field_snapshot_path(output_dir: Path, field: str) -> Path:
    """Return the latest field artifact path for a runtime output field."""
    field_dir = output_dir / "fields" / field
    snapshots = sorted(field_dir.glob("step_*.json"))
    if snapshots:
        return snapshots[-1]
    zarr_dir = output_dir / "fields" / f"{field}.zarr"
    if zarr_dir.is_dir():
        return zarr_dir
    raise ValidationFailure(f"{output_dir}: missing field snapshot for {field}")


def _latest_zarr_chunk_key(zarr_dir: Path) -> str:
    samples_path = zarr_dir / "samples.csv"
    if not samples_path.exists():
        return "0.0.0"
    with samples_path.open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        raise ValidationFailure(f"{samples_path}: zarr sample index is empty")
    chunk_key = rows[-1].get("chunk_key")
    if not chunk_key:
        raise ValidationFailure(f"{samples_path}: latest zarr row has no chunk_key")
    return str(chunk_key)


def _read_vector_field_zarr_artifact(zarr_dir: Path) -> list[tuple[float, float, float]]:
    zarray_path = zarr_dir / ".zarray"
    if not zarray_path.exists():
        raise ValidationFailure(f"{zarr_dir}: missing .zarray metadata")
    with zarray_path.open() as handle:
        zarray = json.load(handle)
    shape = zarray.get("shape")
    dtype = zarray.get("dtype")
    compressor = zarray.get("compressor")
    if not isinstance(shape, list) or len(shape) != 3:
        raise ValidationFailure(f"{zarr_dir}: expected 3D vector zarr shape")
    if int(shape[1]) != 3:
        raise ValidationFailure(f"{zarr_dir}: zarr component axis must have length 3")
    if dtype != "<f8" or compressor is not None:
        raise ValidationFailure(f"{zarr_dir}: expected uncompressed little-endian f64 zarr")

    sample_count = int(shape[0])
    cell_count = int(shape[2])
    chunk_path = zarr_dir / _latest_zarr_chunk_key(zarr_dir)
    payload = chunk_path.read_bytes()
    if len(payload) % 8 != 0:
        raise ValidationFailure(f"{chunk_path}: zarr payload byte length is not f64-aligned")
    values = struct.unpack(f"<{len(payload) // 8}d", payload)
    expected_values = sample_count * 3 * cell_count
    if len(values) != expected_values:
        raise ValidationFailure(
            f"{chunk_path}: expected {expected_values} f64 values, found {len(values)}"
        )
    sample_offset = (sample_count - 1) * 3 * cell_count
    vectors = []
    for cell in range(cell_count):
        vector = (
            float(values[sample_offset + cell]),
            float(values[sample_offset + cell_count + cell]),
            float(values[sample_offset + 2 * cell_count + cell]),
        )
        if not all(math.isfinite(component) for component in vector):
            raise ValidationFailure(f"{chunk_path}: vector {cell} is not finite")
        vectors.append(vector)
    if not vectors:
        raise ValidationFailure(f"{chunk_path}: zarr field contains no vectors")
    return vectors


def _read_scalar_field_zarr_artifact(zarr_dir: Path) -> list[float]:
    zarray_path = zarr_dir / ".zarray"
    if not zarray_path.exists():
        raise ValidationFailure(f"{zarr_dir}: missing .zarray metadata")
    with zarray_path.open() as handle:
        zarray = json.load(handle)
    shape = zarray.get("shape")
    dtype = zarray.get("dtype")
    compressor = zarray.get("compressor")
    if not isinstance(shape, list) or len(shape) != 3:
        raise ValidationFailure(f"{zarr_dir}: expected 3D scalar zarr shape")
    if int(shape[1]) != 1:
        raise ValidationFailure(f"{zarr_dir}: zarr scalar component axis must have length 1")
    if dtype != "<f8" or compressor is not None:
        raise ValidationFailure(f"{zarr_dir}: expected uncompressed little-endian f64 zarr")

    sample_count = int(shape[0])
    cell_count = int(shape[2])
    chunk_path = zarr_dir / _latest_zarr_chunk_key(zarr_dir)
    payload = chunk_path.read_bytes()
    if len(payload) % 8 != 0:
        raise ValidationFailure(f"{chunk_path}: zarr payload byte length is not f64-aligned")
    values = struct.unpack(f"<{len(payload) // 8}d", payload)
    expected_values = sample_count * cell_count
    if len(values) != expected_values:
        raise ValidationFailure(
            f"{chunk_path}: expected {expected_values} f64 values, found {len(values)}"
        )
    sample_offset = (sample_count - 1) * cell_count
    parsed = [float(values[sample_offset + cell]) for cell in range(cell_count)]
    if not parsed:
        raise ValidationFailure(f"{chunk_path}: zarr field contains no scalar values")
    if not all(math.isfinite(value) for value in parsed):
        raise ValidationFailure(f"{chunk_path}: scalar field contains non-finite values")
    return parsed


def _latest_runtime_scalar(run_dir: Path, name: str) -> float:
    scalars_path = run_dir / "scalars.csv"
    if not scalars_path.exists():
        raise ValidationFailure(f"{run_dir}: missing scalars.csv")
    with scalars_path.open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        raise ValidationFailure(f"{scalars_path}: no scalar rows")
    if name not in rows[-1]:
        raise ValidationFailure(f"{scalars_path}: missing scalar column {name!r}")
    value = float(rows[-1][name])
    if not math.isfinite(value):
        raise ValidationFailure(f"{scalars_path}: scalar {name!r} is not finite")
    return value


def read_vector_field_artifact(path: Path) -> list[tuple[float, float, float]]:
    """Read a vector-valued field artifact written by the runner."""
    if path.is_dir():
        return _read_vector_field_zarr_artifact(path)
    with path.open() as handle:
        payload = json.load(handle)
    values = payload.get("values")
    if not isinstance(values, list):
        raise ValidationFailure(f"{path}: field artifact has no values array")
    parsed: list[tuple[float, float, float]] = []
    for index, value in enumerate(values):
        if not isinstance(value, list) or len(value) != 3:
            raise ValidationFailure(f"{path}: values[{index}] is not a 3-vector")
        vector = tuple(float(component) for component in value)
        if not all(math.isfinite(component) for component in vector):
            raise ValidationFailure(f"{path}: values[{index}] is not finite")
        parsed.append(vector)
    if not parsed:
        raise ValidationFailure(f"{path}: field artifact contains no vectors")
    return parsed


def read_scalar_field_artifact(path: Path) -> list[float]:
    """Read a scalar-valued field artifact written by the runner."""
    if path.is_dir():
        return _read_scalar_field_zarr_artifact(path)
    with path.open() as handle:
        payload = json.load(handle)
    values = payload.get("values")
    if not isinstance(values, list):
        raise ValidationFailure(f"{path}: scalar field artifact has no values array")
    parsed = [float(value) for value in values]
    if not parsed:
        raise ValidationFailure(f"{path}: scalar field artifact contains no values")
    if not all(math.isfinite(value) for value in parsed):
        raise ValidationFailure(f"{path}: scalar field artifact contains non-finite values")
    return parsed


def read_magnetization_artifact(path: Path) -> list[tuple[float, float, float]]:
    """Read a vector-valued magnetization artifact written by the runner."""
    with path.open() as handle:
        payload = json.load(handle)
    values = payload.get("values")
    if not isinstance(values, list):
        raise ValidationFailure(f"{path}: magnetization artifact has no values array")
    parsed: list[tuple[float, float, float]] = []
    for index, value in enumerate(values):
        if not isinstance(value, list) or len(value) != 3:
            raise ValidationFailure(f"{path}: values[{index}] is not a 3-vector")
        vector = tuple(float(component) for component in value)
        if not all(math.isfinite(component) for component in vector):
            raise ValidationFailure(f"{path}: values[{index}] is not finite")
        parsed.append(vector)
    if not parsed:
        raise ValidationFailure(f"{path}: magnetization artifact contains no vectors")
    return parsed


def periodic_pair_max_abs(
    values: Sequence[Sequence[float]],
    node_pairs: Sequence[dict],
) -> float:
    """Return max vector mismatch norm over periodic node pairs."""
    if not node_pairs:
        raise ValidationFailure("periodic mesh has no node pairs for seam check")
    max_delta = 0.0
    for pair in node_pairs:
        try:
            node_a = int(pair["node_a"])
            node_b = int(pair["node_b"])
            value_a = values[node_a]
            value_b = values[node_b]
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise ValidationFailure(f"invalid periodic node pair {pair!r}") from exc
        delta = math.sqrt(
            sum((float(value_b[component]) - float(value_a[component])) ** 2 for component in range(3))
        )
        max_delta = max(max_delta, delta)
    return max_delta


def periodic_scalar_pair_max_abs(
    values: Sequence[float],
    node_pairs: Sequence[dict],
) -> float:
    """Return max scalar mismatch over periodic node pairs."""
    if not node_pairs:
        raise ValidationFailure("periodic mesh has no node pairs for seam check")
    max_delta = 0.0
    for pair in node_pairs:
        try:
            node_a = int(pair["node_a"])
            node_b = int(pair["node_b"])
            value_a = float(values[node_a])
            value_b = float(values[node_b])
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise ValidationFailure(f"invalid periodic node pair {pair!r}") from exc
        max_delta = max(max_delta, abs(value_b - value_a))
    return max_delta


def periodic_node_pairs_from_mesh_ir(mesh_ir: dict) -> list[dict]:
    """Extract periodic node-pair dictionaries from a mesh IR payload."""
    pairs = mesh_ir.get("periodic_node_pairs")
    if not isinstance(pairs, list):
        raise ValidationFailure("mesh IR has no periodic_node_pairs array")
    return pairs


def periodic_axes_from_boundary_pairs(mesh_ir: dict) -> set[int]:
    """Infer periodic axes from periodic boundary-pair translations."""
    axes: set[int] = set()
    for pair in mesh_ir.get("periodic_boundary_pairs") or []:
        translation = pair.get("translation") if isinstance(pair, dict) else None
        if not isinstance(translation, list) or len(translation) != 3:
            continue
        nonzero = [
            axis
            for axis, value in enumerate(translation)
            if abs(float(value)) > 0.0
        ]
        axes.update(nonzero)
    return axes


def robin_periodic_seam_face_count(
    mesh_ir: dict,
    *,
    boundary_marker: int = 99,
    tolerance: float = 1.0e-12,
) -> int:
    """Count Robin-marked boundary faces lying on periodic lateral seams."""
    axes = periodic_axes_from_boundary_pairs(mesh_ir)
    if not axes:
        return 0
    nodes = mesh_ir.get("nodes")
    faces = mesh_ir.get("boundary_faces")
    markers = mesh_ir.get("boundary_markers")
    if not isinstance(nodes, list) or not isinstance(faces, list) or not isinstance(markers, list):
        raise ValidationFailure("mesh IR is missing nodes/boundary_faces/boundary_markers")
    if len(faces) != len(markers):
        raise ValidationFailure("mesh IR boundary_markers length does not match boundary_faces")
    bounds_min = [min(float(node[axis]) for node in nodes) for axis in range(3)]
    bounds_max = [max(float(node[axis]) for node in nodes) for axis in range(3)]
    count = 0
    for face, marker in zip(faces, markers):
        if int(marker) != int(boundary_marker):
            continue
        centroid = [
            sum(float(nodes[int(node)][axis]) for node in face) / 3.0
            for axis in range(3)
        ]
        if any(
            abs(centroid[axis] - bounds_min[axis]) <= tolerance
            or abs(centroid[axis] - bounds_max[axis]) <= tolerance
            for axis in axes
        ):
            count += 1
    return count


def _tetrahedron_volume(
    a: Sequence[float],
    b: Sequence[float],
    c: Sequence[float],
    d: Sequence[float],
) -> float:
    ux, uy, uz = (float(b[i]) - float(a[i]) for i in range(3))
    vx, vy, vz = (float(c[i]) - float(a[i]) for i in range(3))
    wx, wy, wz = (float(d[i]) - float(a[i]) for i in range(3))
    cx = vy * wz - vz * wy
    cy = vz * wx - vx * wz
    cz = vx * wy - vy * wx
    return abs(ux * cx + uy * cy + uz * cz) / 6.0


def _element_centroid(nodes: Sequence[Sequence[float]], element: Sequence[int]) -> tuple[float, float, float]:
    return (
        sum(float(nodes[node][0]) for node in element) / 4.0,
        sum(float(nodes[node][1]) for node in element) / 4.0,
        sum(float(nodes[node][2]) for node in element) / 4.0,
    )


def demag_energy_stats_from_field_artifacts(
    mesh_ir: dict,
    m_values: Sequence[Sequence[float]],
    h_values: Sequence[Sequence[float]],
    *,
    central_cell_only: bool,
) -> dict[str, float | int | str]:
    """Integrate field energy and geometry stats from runtime artifacts."""
    nodes = mesh_ir.get("nodes")
    elements = mesh_ir.get("elements")
    markers = mesh_ir.get("element_markers")
    if not isinstance(nodes, list) or not isinstance(elements, list) or not isinstance(markers, list):
        raise ValidationFailure("mesh IR is missing nodes/elements/element_markers")
    if len(elements) != len(markers):
        raise ValidationFailure("mesh IR element_markers length does not match elements")
    if len(m_values) != len(nodes) or len(h_values) != len(nodes):
        raise ValidationFailure(
            "field artifact lengths do not match mesh node count "
            f"(nodes={len(nodes)}, m={len(m_values)}, H={len(h_values)})"
        )

    weights = [0.0] * len(nodes)
    half_x = CELL_SIZE[0] / 2.0
    half_y = CELL_SIZE[1] / 2.0
    magnetic_volume = 0.0
    magnetic_element_count = 0
    for element, marker in zip(elements, markers):
        if int(marker) == 0:
            continue
        if not isinstance(element, list) or len(element) != 4:
            raise ValidationFailure(f"expected tetrahedral element, found {element!r}")
        element_nodes = [int(node) for node in element]
        if central_cell_only:
            cx, cy, _ = _element_centroid(nodes, element_nodes)
            if cx < -half_x or cx > half_x or cy < -half_y or cy > half_y:
                continue
        volume = _tetrahedron_volume(*(nodes[node] for node in element_nodes))
        magnetic_volume += volume
        magnetic_element_count += 1
        lumped = volume / 4.0
        for node in element_nodes:
            weights[node] += lumped

    energy = 0.0
    magnetic_node_count = 0
    for node, weight in enumerate(weights):
        if weight <= 0.0:
            continue
        magnetic_node_count += 1
        mdoth = sum(float(m_values[node][component]) * float(h_values[node][component]) for component in range(3))
        energy += -0.5 * MU0 * MS * mdoth * weight
    if not math.isfinite(energy):
        raise ValidationFailure("extracted demag energy is not finite")
    return {
        "e_demag_J": energy,
        "magnetic_volume_m3": magnetic_volume,
        "magnetic_element_count": magnetic_element_count,
        "magnetic_node_count": magnetic_node_count,
        "energy_scope": "central_cell" if central_cell_only else "all_magnetic_elements",
    }


def demag_energy_from_field_artifacts(
    mesh_ir: dict,
    m_values: Sequence[Sequence[float]],
    h_values: Sequence[Sequence[float]],
    *,
    central_cell_only: bool,
) -> float:
    """Integrate field energy from runtime artifacts, optionally on the central cell."""
    stats = demag_energy_stats_from_field_artifacts(
        mesh_ir,
        m_values,
        h_values,
        central_cell_only=central_cell_only,
    )
    energy = float(stats["e_demag_J"])
    if not math.isfinite(energy):
        raise ValidationFailure("extracted demag energy is not finite")
    return energy


def _cell_geometry(fm, *, dx: float = 0.0, dy: float = 0.0):
    cell = fm.Box(size=CELL_SIZE, name="film_cell") - fm.Cylinder(
        radius=HOLE_RADIUS,
        height=CELL_SIZE[2],
        name="hole",
    )
    if dx or dy:
        return cell.translate((dx, dy, 0.0))
    return cell


def _supercell_geometry(fm, repetitions: int):
    if repetitions < 1 or repetitions % 2 != 1:
        raise ValueError("supercell repetitions must be an odd positive integer")
    half = repetitions // 2
    geometry = None
    for ix in range(-half, half + 1):
        for iy in range(-half, half + 1):
            cell = _cell_geometry(fm, dx=ix * CELL_SIZE[0], dy=iy * CELL_SIZE[1])
            geometry = cell if geometry is None else geometry + cell
    return geometry


def _repeated_hole_refinement_geometries(fm, repetitions: int):
    if repetitions < 1 or repetitions % 2 != 1:
        raise ValueError("supercell repetitions must be an odd positive integer")
    half = repetitions // 2
    geometries = []
    for ix in range(-half, half + 1):
        for iy in range(-half, half + 1):
            hole_region = fm.Cylinder(
                radius=HOLE_REFINEMENT_RADIUS,
                height=CELL_SIZE[2],
                name=f"hole_refinement_{ix}_{iy}",
            )
            if ix or iy:
                hole_region = hole_region.translate((ix * CELL_SIZE[0], iy * CELL_SIZE[1], 0.0))
            geometries.append(hole_region)
    return geometries


def apply_periodic_airbox_mesh_policy(body, *, hole_refinement_geometries) -> None:
    """Apply the P2 thin-film mesh policy to the magnetic body."""
    body.mesh.thin_film(
        minimum_element_size=MAGNETIC_MESH_MIN,
        maximum_element_size=MAGNETIC_MESH_MAX,
        interface_maximum_element_size=MAGNETIC_INTERFACE_HMAX,
        interface_thickness=8.0 * NM,
        transition_distance=28.0 * NM,
        edge_maximum_element_size=MAGNETIC_EDGE_HMAX,
        edge_thickness=5.0 * NM,
        edge_transition_distance=16.0 * NM,
        corner_maximum_element_size=MAGNETIC_EDGE_HMAX,
        corner_extent=5.0 * NM,
        corner_transition_distance=12.0 * NM,
        curvature_factor=0.35,
        narrow_region_resolution=1.0,
        layers=2,
        order=1,
    )
    for index, geometry in enumerate(hole_refinement_geometries):
        refinement = body.add_region(
            f"hole_refinement_{index}",
            geometry,
            priority=10 + index,
        )
        refinement.mesh(
            minimum_element_size=MAGNETIC_MESH_MIN,
            maximum_element_size=HOLE_REFINEMENT_HMAX,
            transition_distance=12.0 * NM,
            order=1,
        )


def build_periodic_airbox_study(
    *,
    problem_name: str,
    model: str,
    repetitions: int = 1,
):
    """Build a primitive periodic or explicit supercell demag validation study."""
    fm = _fullmag()
    fm.reset()
    study = fm.study(problem_name)
    study.engine("fem")
    study.device("cpu", precision="double")

    span_x = CELL_SIZE[0] * repetitions
    span_y = CELL_SIZE[1] * repetitions
    study.universe(
        mode="auto",
        size=(span_x, span_y, AIRBOX_Z),
        center=(0.0, 0.0, 0.0),
        padding=(0.0, 0.0, 0.0),
    )
    study.universe.mesh(maximum_element_size=30.0 * NM)
    mesh_defaults = {
        "algorithm_2d": 6,
        "algorithm_3d": 1,
        "size_factor": 1,
        "size_from_curvature": 0,
        "smoothing_steps": 1,
        "optimize_iterations": 1,
        "narrow_regions": 0,
        "compute_quality": False,
        "per_element_quality": False,
    }
    if periodic_airbox_model_uses_lateral_pbc(model):
        periodic_bc = fm.PeriodicBC(["x_faces", "y_faces"]).to_ir()
        study.objects.mesh.defaults(
            periodic_pair_ids=periodic_bc["pair_ids"],
            **mesh_defaults,
        )
    else:
        study.objects.mesh.defaults(**mesh_defaults)

    if model == "primitive_periodic":
        geometry = _cell_geometry(fm)
    elif model == "supercell_reference":
        geometry = _supercell_geometry(fm, repetitions)
    else:
        raise ValueError(f"unsupported periodic airbox validation model: {model}")

    body = study.geometry(geometry, name="periodic_film")
    body.Ms = MS
    body.Aex = AEX
    body.alpha = ALPHA
    body.m = fm.texture.uniform(M_DIR)
    apply_periodic_airbox_mesh_policy(
        body,
        hole_refinement_geometries=_repeated_hole_refinement_geometries(fm, repetitions),
    )
    study.build_domain_mesh()
    study.demag(realization="poisson_robin")
    study.save("H_demag", every=1.0e-13)
    study.save("demag_phi", every=1.0e-13)
    study.solver(max_error=1.0e-6, integrator="rk45")
    return study


def _run_relaxation_with_artifacts(study, *, output_dir: Path):
    import fullmag.world as world
    from fullmag.runtime import Simulation

    problem = world._build_problem(
        study_kind="relaxation",
        relax_algorithm=RELAX_ALGORITHM,
        relax_torque_tolerance=RELAX_TOL,
        relax_max_steps=RELAX_MAX_STEPS,
    )
    until_seconds = 1.0e-13 * RELAX_MAX_STEPS
    return Simulation(problem).run(until=until_seconds, output_dir=str(output_dir))


def _mesh_ir_for_current_study() -> dict:
    import fullmag.world as world
    from fullmag._core import extract_fem_mesh_ir

    problem = world._build_problem(
        study_kind="relaxation",
        relax_algorithm=RELAX_ALGORITHM,
        relax_torque_tolerance=RELAX_TOL,
        relax_max_steps=RELAX_MAX_STEPS,
    )
    ir = problem.to_ir(
        requested_backend=problem.runtime.backend_target,
        execution_mode=problem.runtime.execution_mode,
        execution_precision=problem.runtime.execution_precision,
    )
    mesh_ir = extract_fem_mesh_ir(ir)
    if mesh_ir is None:
        raise ValidationFailure("periodic-airbox validation did not resolve a FEM mesh")
    return mesh_ir


def produce_periodic_airbox_rows(
    *,
    output_dir: Path = DEFAULT_RUNTIME_DIR,
    supercell_repetitions: int = 3,
) -> list[dict]:
    """Run primitive/supercell demag solves and return CSV validation rows.

    The runtime exposes `H_demag` and `demag_phi` field snapshots. `e_demag_J`
    is integrated from the saved `m_final` and `H_demag` fields; for the
    supercell reference it is restricted to magnetic elements whose centroids
    are inside the central primitive cell.
    """
    require_native_runtime_core()
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    rows: list[dict] = []
    comparison_group = f"periodic_airbox_{supercell_repetitions}x{supercell_repetitions}"
    for model, repetitions in (
        ("primitive_periodic", 1),
        ("supercell_reference", supercell_repetitions),
    ):
        run_dir = output_dir / model
        study = build_periodic_airbox_study(
            problem_name=f"{comparison_group}_{model}",
            model=model,
            repetitions=repetitions,
        )
        mesh_ir = _mesh_ir_for_current_study()
        result = _run_relaxation_with_artifacts(study, output_dir=run_dir)
        h_values = read_vector_field_artifact(latest_field_snapshot_path(run_dir, "H_demag"))
        phi_values = read_scalar_field_artifact(latest_field_snapshot_path(run_dir, "demag_phi"))
        m_values = read_magnetization_artifact(run_dir / "m_final.json")
        energy_stats = demag_energy_stats_from_field_artifacts(
            mesh_ir,
            m_values,
            h_values,
            central_cell_only=model == "supercell_reference",
        )
        e_demag = float(energy_stats["e_demag_J"])
        runtime_total_e_demag = _latest_runtime_scalar(run_dir, "E_demag")

        h_pair_max = 0.0
        phi_pair_max = 0.0
        robin_seam_count = 0
        if model == "primitive_periodic":
            periodic_node_pairs = periodic_node_pairs_from_mesh_ir(mesh_ir)
            h_pair_max = periodic_pair_max_abs(
                h_values,
                periodic_node_pairs,
            )
            phi_pair_max = periodic_scalar_pair_max_abs(phi_values, periodic_node_pairs)
            robin_seam_count = robin_periodic_seam_face_count(mesh_ir)

        last = result.steps[-1] if result.steps else None

        rows.append(
            {
                "case": f"{comparison_group}_{model}",
                "comparison_group": comparison_group,
                "model": model,
                "supercell_repetitions": repetitions,
                "e_demag_J": e_demag,
                "runtime_total_e_demag_J": runtime_total_e_demag,
                "runtime_total_to_field_scope_ratio": runtime_total_e_demag / e_demag,
                "magnetic_volume_m3": float(energy_stats["magnetic_volume_m3"]),
                "magnetic_element_count": int(energy_stats["magnetic_element_count"]),
                "magnetic_node_count": int(energy_stats["magnetic_node_count"]),
                "energy_scope": str(energy_stats["energy_scope"]),
                "h_demag_pair_max_abs_Apm": h_pair_max,
                "robin_periodic_seam_face_count": robin_seam_count,
                "phi_pair_max_abs": phi_pair_max,
                "phi_pair_status": "emitted_by_runtime",
                "demag_linear_iterations": float(getattr(last, "poisson_iterations", float("nan"))),
                "demag_linear_residual": float(getattr(last, "poisson_final_residual", float("nan"))),
                "demag_wall_time_ns": float(getattr(last, "demag_wall_time_ns", float("nan"))),
                "demag_assemble_wall_time_ns": float(
                    getattr(last, "demag_assemble_wall_time_ns", float("nan"))
                ),
                "demag_solve_wall_time_ns": float(
                    getattr(last, "demag_solve_wall_time_ns", float("nan"))
                ),
                "demag_recover_wall_time_ns": float(
                    getattr(last, "demag_recover_wall_time_ns", float("nan"))
                ),
                "demag_energy_wall_time_ns": float(
                    getattr(last, "demag_energy_wall_time_ns", float("nan"))
                ),
            }
        )
    return rows


def validate_periodic_airbox_artifact(
    rows: Sequence[dict],
    *,
    h_pair_tolerance: float = 1.0e-3,
    phi_pair_tolerance: float = 1.0e-11,
    supercell_relative_tolerance: float = 2.0e-2,
    require_phi: bool = True,
) -> None:
    """Validate periodic-airbox demag continuity and supercell agreement."""
    metric_keys = [
        "e_demag_J",
        "h_demag_pair_max_abs_Apm",
        "robin_periodic_seam_face_count",
        "demag_linear_residual",
    ]
    if require_phi:
        metric_keys.append("phi_pair_max_abs")
    require_finite_metrics(
        rows,
        metric_keys,
        label_key="case",
    )
    require_solver_telemetry(rows, label_key="case")

    primitive_rows = _primitive_rows(rows)
    if not primitive_rows:
        raise ValidationFailure("validation produced no primitive_periodic rows")
    require_periodic_pair_continuity(
        primitive_rows,
        label_key="case",
        h_tolerance=h_pair_tolerance,
        phi_tolerance=phi_pair_tolerance if require_phi else None,
    )
    for row in primitive_rows:
        if int(row.get("robin_periodic_seam_face_count", -1)) != 0:
            raise ValidationFailure(
                f"{row.get('case', 'primitive_periodic')}: Robin marker is present on "
                f"{int(row['robin_periodic_seam_face_count'])} periodic seam faces"
            )
    require_supercell_reference_close(
        rows,
        relative_tolerance=supercell_relative_tolerance,
    )


def periodic_airbox_comparison_summary(rows: Sequence[dict]) -> list[dict]:
    """Return one relative-error summary row per primitive/supercell group."""
    grouped: dict[str, dict[str, dict]] = {}
    for row in rows:
        group = str(row.get("comparison_group", "unknown"))
        model = str(row.get("model", "unknown"))
        grouped.setdefault(group, {})[model] = row

    summaries: list[dict] = []
    for group, by_model in grouped.items():
        primitive = by_model.get("primitive_periodic")
        reference = by_model.get("supercell_reference")
        if primitive is None or reference is None:
            raise ValidationFailure(f"{group}: missing primitive_periodic or supercell_reference row")
        primitive_energy = float(primitive["e_demag_J"])
        reference_energy = float(reference["e_demag_J"])
        if not math.isfinite(primitive_energy) or not math.isfinite(reference_energy):
            raise ValidationFailure(f"{group}: non-finite demag energy in comparison rows")
        if reference_energy == 0.0:
            raise ValidationFailure(f"{group}: zero reference demag energy")
        rel_error = abs(primitive_energy - reference_energy) / abs(reference_energy)
        summaries.append(
            {
                "comparison_group": group,
                "supercell_repetitions": int(reference["supercell_repetitions"]),
                "primitive_e_demag_J": primitive_energy,
                "reference_e_demag_J": reference_energy,
                "relative_error": rel_error,
                "h_demag_pair_max_abs_Apm": float(primitive["h_demag_pair_max_abs_Apm"]),
                "robin_periodic_seam_face_count": float(
                    primitive.get("robin_periodic_seam_face_count", 0.0)
                ),
                "primitive_demag_linear_iterations": float(primitive["demag_linear_iterations"]),
                "reference_demag_linear_iterations": float(reference["demag_linear_iterations"]),
                "phi_pair_status": str(primitive.get("phi_pair_status", "")),
            }
        )
    summaries.sort(key=lambda row: int(row["supercell_repetitions"]))
    return summaries


def summarize_periodic_airbox_sweep(csv_paths: Sequence[Path]) -> list[dict]:
    """Build a supercell-size sweep summary from produced validation CSV files."""
    summaries: list[dict] = []
    for csv_path in csv_paths:
        summaries.extend(periodic_airbox_comparison_summary(read_csv_rows(csv_path)))
    summaries.sort(key=lambda row: int(row["supercell_repetitions"]))
    seen = set()
    for row in summaries:
        repetitions = int(row["supercell_repetitions"])
        if repetitions in seen:
            raise ValidationFailure(f"duplicate sweep entry for {repetitions}x{repetitions}")
        seen.add(repetitions)
    return summaries


def validate_sweep_improves(rows: Sequence[dict]) -> None:
    """Require the largest supercell to improve over the smallest one."""
    finite = [
        row
        for row in rows
        if isinstance(row.get("relative_error"), (int, float))
        and math.isfinite(float(row["relative_error"]))
    ]
    finite.sort(key=lambda row: int(row["supercell_repetitions"]))
    if len(finite) < 2:
        raise ValidationFailure("periodic-airbox sweep needs at least two finite entries")
    first = float(finite[0]["relative_error"])
    last = float(finite[-1]["relative_error"])
    if last >= first:
        raise ValidationFailure(
            "periodic-airbox sweep did not improve from "
            f"{first:.6e} to {last:.6e}"
        )


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_path", nargs="?", type=Path, default=DEFAULT_CSV)
    parser.add_argument(
        "--produce",
        action="store_true",
        help="run the primitive/supercell runtime producer before validating",
    )
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_RUNTIME_DIR)
    parser.add_argument("--supercell-repetitions", type=int, default=3)
    parser.add_argument(
        "--allow-missing-phi",
        action="store_true",
        help="accept runtime CSVs that lack scalar-potential seam metrics",
    )
    parser.add_argument("--h-pair-tolerance", type=float, default=1.0e-3)
    parser.add_argument("--phi-pair-tolerance", type=float, default=1.0e-11)
    parser.add_argument("--supercell-relative-tolerance", type=float, default=2.0e-2)
    parser.add_argument(
        "--summarize-sweep",
        nargs="+",
        type=Path,
        metavar="CSV",
        help="write a diagnostic supercell-size sweep summary from produced CSV files",
    )
    parser.add_argument("--sweep-output", type=Path)
    args = parser.parse_args(list(argv) if argv is not None else None)

    try:
        if args.summarize_sweep:
            rows = summarize_periodic_airbox_sweep(args.summarize_sweep)
            validate_sweep_improves(rows)
            if args.sweep_output is not None:
                write_csv(
                    args.sweep_output,
                    rows,
                    field_order=[
                        "comparison_group",
                        "supercell_repetitions",
                        "primitive_e_demag_J",
                        "reference_e_demag_J",
                        "relative_error",
                        "h_demag_pair_max_abs_Apm",
                        "robin_periodic_seam_face_count",
                        "primitive_demag_linear_iterations",
                        "reference_demag_linear_iterations",
                        "phi_pair_status",
                    ],
                )
            first = rows[0]
            last = rows[-1]
            print(
                "PASS: periodic-airbox sweep relative error improves "
                f"{float(first['relative_error']):.6e} -> "
                f"{float(last['relative_error']):.6e}"
            )
            return 0

        csv_path = args.csv_path
        require_phi = not args.allow_missing_phi
        if args.produce:
            rows = produce_periodic_airbox_rows(
                output_dir=args.output_dir,
                supercell_repetitions=args.supercell_repetitions,
            )
            csv_path = args.output_dir / "periodic_airbox_validation.csv"
            write_csv(csv_path, rows)
        validate_periodic_airbox_artifact(
            read_csv_rows(csv_path),
            h_pair_tolerance=args.h_pair_tolerance,
            phi_pair_tolerance=args.phi_pair_tolerance,
            supercell_relative_tolerance=args.supercell_relative_tolerance,
            require_phi=require_phi,
        )
    except ValidationFailure as exc:
        print(f"FAIL: {exc}")
        return 1
    qualifier = "partial " if not require_phi else ""
    print(f"PASS: {qualifier}periodic-airbox demag artifact accepted ({csv_path})")
    if not require_phi:
        print("NOTE: scalar-potential seam metrics are not covered by this runtime artifact")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
