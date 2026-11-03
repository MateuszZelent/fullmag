"""Compare Göbel FEM and FDM endpoints on the FDM midplane.

Run from the checkout with Fullmag's Python package available:
python -m tests.standard_problems.bimeron.goebel_2019.compare_fem_fdm FEM_BUNDLE FDM_BUNDLE
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from fullmag.analysis.fem_cartesian_restriction import sample_fem_tet4_cartesian_centers
from fullmag.analysis.magnetization_comparison import CartesianGrid
from fullmag.meshing.persistence import mesh_data_from_ir
from tests.standard_problems.bimeron.goebel_2019.common import LLG_HOLD_TIME
from tests.standard_problems.bimeron.goebel_2019.verify import (
    MIN_RELAX_TIME_S,
    analyze_fdm_state,
)


# Allow accumulated floating-point error while resolving a fraction of one 2.5 fs step.
_TIME_ATOL_S = 1e-17
_STAGES = (
    ("relaxed", "stage_00_flat_relax", "relax", 0.0, MIN_RELAX_TIME_S),
    ("held", "stage_02_flat_run", "hold", MIN_RELAX_TIME_S, LLG_HOLD_TIME),
)


@dataclass(frozen=True)
class _Endpoint:
    path: Path
    state: dict
    metadata: dict
    plan: dict
    global_start_s: float
    local_duration_s: float
    state_sha256: str
    metadata_sha256: str

    @property
    def layout(self) -> dict:
        return self.state["layout"]

    def provenance(self) -> dict:
        return {
            "state_path": str(self.path / "m_final.json"),
            "state_sha256": self.state_sha256,
            "metadata_path": str(self.path / "metadata.json"),
            "metadata_sha256": self.metadata_sha256,
            "problem_source_hash": self.metadata.get("source_hash"),
            "build_identity": self.metadata.get("build_identity"),
            "requested_execution": self.metadata.get("requested_execution"),
            "execution_engine": self.metadata["execution_provenance"]["execution_engine"],
            "execution_resolution": self.metadata["execution_provenance"].get(
                "execution_resolution"
            ),
            "precision": self.metadata["execution_provenance"].get("precision"),
            "pbc": self.metadata["pbc"],
            "fem_demag_realization": self.plan.get("demag_realization"),
            "step": self.state["step"],
            "stage_local_duration_s": self.local_duration_s,
            "global_start_s": self.global_start_s,
            "global_end_s": self.global_start_s + self.local_duration_s,
        }


def _time_matches(actual: float, expected: float) -> bool:
    return math.isclose(actual, expected, rel_tol=0.0, abs_tol=_TIME_ATOL_S)


def _load_endpoint(bundle: Path, directory: str, backend: str) -> _Endpoint:
    path = bundle / "stages" / directory
    metadata_bytes = (path / "metadata.json").read_bytes()
    state_bytes = (path / "m_final.json").read_bytes()
    metadata = json.loads(metadata_bytes)
    state = json.loads(state_bytes)
    plan = metadata["execution_plan"]["backend_plan"]
    execution = metadata["execution_provenance"]
    expected_engine, expected_demag = (
        ("fem_cpu_native", "periodic_airbox_k0")
        if backend == "fem"
        else ("cuda_fdm", "truncated_images")
    )
    if (
        metadata.get("status") != "completed"
        or state["layout"].get("backend") != backend
        or state.get("observable") != "m"
        or execution.get("execution_engine") != expected_engine
        or execution.get("lossy_fallback_used") is True
        or (execution.get("execution_resolution") or {}).get("fallback_occurred") is True
    ):
        raise ValueError(f"{path}: expected a completed {expected_engine} magnetization stage")
    pbc = metadata["pbc"]
    if pbc.get("axes") != ["periodic", "open", "open"] or pbc.get("demag") != expected_demag:
        raise ValueError(f"{path}: expected x-only periodicity with {expected_demag}")

    # Flat headless stages reset the field clock and retain the global origin in the plan.
    initial = json.loads((path / "m_initial.json").read_bytes())
    start_s = float(plan["time_stage"]["start_time_s"])
    initial_s, final_s = float(initial["time"]), float(state["time"])
    if initial["step"] != 0 or not _time_matches(initial_s, 0.0) or state["step"] <= 0:
        raise ValueError(f"{path}: invalid physical timing for the local stage clock")
    return _Endpoint(
        path,
        state,
        metadata,
        plan,
        start_s,
        final_s - initial_s,
        hashlib.sha256(state_bytes).hexdigest(),
        hashlib.sha256(metadata_bytes).hexdigest(),
    )


def _validate_timing(
    endpoint: _Endpoint, stage_id: str, start_s: float, duration_s: float
) -> None:
    if (
        endpoint.plan["time_stage"]["active_stage_id"] != stage_id
        or not _time_matches(endpoint.global_start_s, start_s)
        or not _time_matches(endpoint.local_duration_s, duration_s)
    ):
        raise ValueError(
            f"{endpoint.path}: physical timing does not match {stage_id} "
            f"(global start {endpoint.global_start_s:.17g} s, "
            f"local duration {endpoint.local_duration_s:.17g} s; "
            f"expected {start_s:.17g} s, {duration_s:.17g} s)"
        )


def _fdm_grid(endpoint: _Endpoint) -> CartesianGrid:
    layout = endpoint.layout
    cells = tuple(layout["grid_cells"])
    origin = tuple(layout["origin_m"])
    spacing = tuple(layout["cell_size"])
    if len(cells) != 3 or any(type(count) is not int or count <= 0 for count in cells):
        raise ValueError(f"{endpoint.path}: invalid FDM grid dimensions")
    mask = layout.get("active_mask")
    if (
        cells[2] != 1
        or layout.get("active_cell_count") != math.prod(cells)
        or (mask is not None and (len(mask) != math.prod(cells) or any(v is not True for v in mask)))
    ):
        raise ValueError(f"{endpoint.path}: expected an all-active FDM grid with one z cell")
    grid = CartesianGrid(
        shape_zyx=cells[::-1],
        bounds_min_xyz=origin,
        bounds_max_xyz=tuple(lower + count * size for lower, count, size in zip(
            origin, cells, spacing, strict=True
        )),
    )
    if not math.isclose(origin[2] + 0.5 * spacing[2], 0.0, rel_tol=0.0, abs_tol=1e-21):
        raise ValueError(f"{endpoint.path}: FDM z center must coincide with the film midplane")
    return grid


def _sample_fem(endpoint: _Endpoint, grid: CartesianGrid) -> tuple[np.ndarray, dict]:
    if endpoint.plan.get("fe_order") != 1 or endpoint.plan.get("demag_realization") != "poisson_robin":
        raise ValueError(f"{endpoint.path}: expected P1 FEM with Poisson Robin demag")
    mesh = mesh_data_from_ir(endpoint.plan["mesh"])
    regions = endpoint.plan["region_materials"]
    if len(regions) != 1 or regions[0]["material"]["saturation_magnetisation"] <= 0.0:
        raise ValueError(f"{endpoint.path}: expected one magnetic film region in the FEM plan")
    marker = regions[0]["element_marker"]
    selected = mesh.element_markers == marker
    if mesh.cell_mesh_parts.size and not np.array_equal(selected, mesh.cell_mesh_parts == "magnetic"):
        raise ValueError(f"{endpoint.path}: FEM magnetic marker and mesh parts disagree")
    if not np.any(selected) or not np.all(mesh.cell_types[selected] == "tet4"):
        raise ValueError(f"{endpoint.path}: expected magnetic Tet4 elements")
    active_nodes = np.zeros(mesh.n_nodes, dtype=bool)
    tet_nodes = mesh.cell_nodes[mesh.cell_offsets[:-1][selected, None] + np.arange(4)]
    active_nodes[tet_nodes] = True
    field_mask = endpoint.layout["field_semantics"]["active_node_mask"]
    if not np.array_equal(active_nodes, field_mask):
        raise ValueError(f"{endpoint.path}: FEM magnetic elements and field support disagree")

    sampled = sample_fem_tet4_cartesian_centers(
        mesh,
        np.asarray(endpoint.state["values"], dtype=np.float64),
        grid,
        magnetic_markers=(marker,),
        time_s=endpoint.global_start_s + endpoint.local_duration_s,
    )
    if np.any(np.ma.getmaskarray(sampled.final_values)):
        raise ValueError(
            f"{endpoint.path}: incomplete magnetic coverage "
            f"({sampled.metadata['valid_voxel_count']}/{grid.voxel_count} FDM centers)"
        )
    raw = np.asarray(sampled.final_values).reshape((-1, 3))
    norms = np.linalg.norm(raw, axis=1)
    if not np.all(np.isfinite(norms)) or np.min(norms) <= 1e-12:
        raise ValueError(f"{endpoint.path}: cannot normalize a zero or invalid sampled vector")
    return raw / norms[:, None], {
        **sampled.metadata,
        "magnetic_object_id": regions[0]["object_id"],
        "raw_norm_min": float(np.min(norms)),
        "raw_norm_max": float(np.max(norms)),
        "raw_norm_max_deviation_from_one": float(np.max(np.abs(norms - 1.0))),
        "raw_min_mz": float(np.min(raw[:, 2])),
        "raw_max_mz": float(np.max(raw[:, 2])),
        "mesh_topology_fingerprint": endpoint.layout.get("topology_fingerprint"),
    }


def compare_bundles(*, fem_bundle: Path, fdm_bundle: Path) -> dict:
    """Report paired signed Q and core separation at the two reference endpoints."""
    stages = {}
    reference_grid = None
    for name, directory, stage_id, start_s, duration_s in _STAGES:
        fem = _load_endpoint(fem_bundle, directory, "fem")
        fdm = _load_endpoint(fdm_bundle, directory, "fdm")
        _validate_timing(fem, stage_id, start_s, duration_s)
        _validate_timing(fdm, stage_id, start_s, duration_s)
        if not (
            _time_matches(fem.global_start_s, fdm.global_start_s)
            and _time_matches(fem.local_duration_s, fdm.local_duration_s)
        ):
            raise ValueError(f"{name}: FEM and FDM physical timing differs")

        grid = _fdm_grid(fdm)
        if reference_grid is not None and grid != reference_grid:
            raise ValueError("FDM comparison grid changed between stages")
        reference_grid = grid
        metric_grid = {
            "grid_cells": tuple(fdm.layout["grid_cells"]),
            "cell_size": tuple(fdm.layout["cell_size"]),
            "origin": tuple(fdm.layout["origin_m"]),
            "periodic_x": True,
        }
        fdm_metrics = analyze_fdm_state(fdm.state["values"], **metric_grid)
        normalized_fem, sampling = _sample_fem(fem, grid)
        fem_metrics = analyze_fdm_state(normalized_fem.tolist(), **metric_grid)
        stages[name] = {
            "fem": {**fem.provenance(), "metrics": fem_metrics},
            "fdm": {**fdm.provenance(), "metrics": fdm_metrics},
            "sampling": sampling,
            "delta_fem_minus_fdm": {
                key: fem_metrics[key] - fdm_metrics[key]
                for key in ("topological_charge", "core_separation_m")
            },
        }

    return {
        "schema_version": "goebel_fem_fdm_midplane_comparison.v1",
        "grid": {
            **reference_grid.to_dict(),
            "midplane_z_m": (reference_grid.bounds_min_xyz[2] + reference_grid.bounds_max_xyz[2]) / 2,
        },
        "timing_absolute_tolerance_s": _TIME_ATOL_S,
        "stages": stages,
        "method": (
            "P1 tetrahedral center sampling and unit-vector normalization of FEM; "
            "signed solid angles on the same Cartesian grid with x wrapping and open y. "
            "Core separation uses the sampled global maximum and minimum of mz."
        ),
        "scope": (
            "Diagnostic cross-method comparison for zero-current endpoints. FEM uses "
            "periodic-airbox Robin demagnetization and FDM uses truncated images. "
            "Sampling does not establish FEM mesh convergence, solver parity, or "
            "quantitative agreement with the publication's SOT-driven raster data."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fem_bundle", type=Path)
    parser.add_argument("fdm_bundle", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = compare_bundles(
        fem_bundle=args.fem_bundle.resolve(), fdm_bundle=args.fdm_bundle.resolve()
    )
    serialized = json.dumps(report, indent=2, allow_nan=False) + "\n"
    if args.output is None:
        print(serialized, end="")
    else:
        args.output.write_text(serialized, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
