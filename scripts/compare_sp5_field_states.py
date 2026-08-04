#!/usr/bin/env python3
"""Compare final FEM tet4 and FDM SP5 fields on the FDM Cartesian grid.

The FEM field is reduced with the affine-P1 tet4 volume restriction.  This
preserves the FEM volume integral for straight-sided, non-overlapping magnetic
tetrahedra, but it remains a diagnostic comparison until the two solvers also
share equilibrium, time-step, operator, and demagnetization qualification.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any

import numpy as np

from fullmag.analysis.fem_cartesian_restriction import (
    build_tet4_cartesian_restriction,
    restrict_fem_magnetization,
)
from fullmag.analysis.magnetization_comparison import (
    CartesianGrid,
    StructuredMagnetization,
    compare_magnetization_textures,
)
from fullmag.meshing.persistence import mesh_data_from_ir


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _load_fdm(run_dir: Path) -> StructuredMagnetization:
    artifact = _read_json(run_dir / "m_final.json")
    layout = artifact.get("layout")
    if not isinstance(layout, dict) or layout.get("backend") != "fdm":
        raise ValueError("FDM m_final.json must declare layout.backend='fdm'")
    counts = tuple(int(value) for value in layout.get("grid_cells", ()))
    cell_size = tuple(float(value) for value in layout.get("cell_size", ()))
    origin = tuple(float(value) for value in layout.get("origin_m", ()))
    if len(counts) != 3 or len(cell_size) != 3 or len(origin) != 3:
        raise ValueError("FDM layout must declare grid_cells, cell_size, and origin_m")
    values = np.asarray(artifact.get("values"), dtype=np.float64)
    if values.shape != (counts[0] * counts[1] * counts[2], 3):
        raise ValueError("FDM final field shape does not match grid_cells")
    active_mask = np.asarray(layout.get("active_mask"), dtype=bool)
    if active_mask.shape != (values.shape[0],):
        raise ValueError("FDM active_mask shape does not match final field")
    grid = CartesianGrid(
        shape_zyx=(counts[2], counts[1], counts[0]),
        bounds_min_xyz=origin,
        bounds_max_xyz=tuple(origin[index] + counts[index] * cell_size[index] for index in range(3)),
    )
    reshaped = values.reshape((*grid.shape_zyx, 3))
    mask = np.broadcast_to(
        (~active_mask.reshape(grid.shape_zyx))[..., np.newaxis],
        (*grid.shape_zyx, 3),
    )
    return StructuredMagnetization(
        values=np.ma.array(reshaped[np.newaxis, ...], mask=mask[np.newaxis, ...]),
        times=np.asarray([float(artifact.get("time", 0.0))], dtype=np.float64),
        grid=grid,
        source_path=str(run_dir / "m_final.json"),
        metadata={"backend": "fdm", "layout": layout},
    )


def _fem_final_time(run_dir: Path) -> float:
    samples = run_dir / "fields" / "m.zarr" / "samples.csv"
    if not samples.is_file():
        return float(_read_json(run_dir / "m_final.json").get("time", 0.0))
    with samples.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        raise ValueError(f"{samples} contains no rows")
    return float(rows[-1]["time"])


def _load_fem(run_dir: Path, grid: CartesianGrid) -> StructuredMagnetization:
    artifact = _read_json(run_dir / "m_final.json")
    layout = artifact.get("layout")
    if not isinstance(layout, dict) or layout.get("backend") != "fem":
        raise ValueError("FEM m_final.json must declare layout.backend='fem'")
    metadata = _read_json(run_dir / "metadata.json")
    execution_plan = metadata.get("execution_plan")
    if not isinstance(execution_plan, dict):
        raise ValueError("FEM metadata must contain execution_plan")
    backend_plan = execution_plan.get("backend_plan")
    if not isinstance(backend_plan, dict) or not isinstance(backend_plan.get("mesh"), dict):
        raise ValueError("FEM metadata must contain execution_plan.backend_plan.mesh")
    mesh = mesh_data_from_ir(backend_plan["mesh"])
    values = np.asarray(artifact.get("values"), dtype=np.float64)
    if values.shape != (mesh.n_nodes, 3):
        raise ValueError("FEM final field shape does not match planner mesh node count")
    restriction = build_tet4_cartesian_restriction(mesh, grid)
    sampled = restrict_fem_magnetization(values, restriction)
    sampled_time = float(artifact.get("time", _fem_final_time(run_dir)))
    return StructuredMagnetization(
        values=sampled.values,
        times=np.asarray([sampled_time], dtype=np.float64),
        grid=sampled.grid,
        source_path=str(run_dir / "m_final.json"),
        metadata={
            **sampled.metadata,
            "backend": "fem",
            "mesh_topology_fingerprint": metadata.get("mesh", {}).get("topology_fingerprint"),
            "run_metadata_path": str(run_dir / "metadata.json"),
        },
    )


def compare(fdm_run_dir: Path, fem_run_dir: Path, time_tolerance: float) -> dict[str, Any]:
    fdm = _load_fdm(fdm_run_dir)
    fem = _load_fem(fem_run_dir, fdm.grid)
    same_final_time = abs(float(fdm.times[-1]) - float(fem.times[-1])) <= time_tolerance
    metrics = compare_magnetization_textures(fem, fdm, high_error_threshold=1.0e-3)
    return {
        "schema_version": "sp5.fem_fdm_field_comparison.v2",
        "scope": "final_field_same_time",
        "fdm_run": str(fdm_run_dir),
        "fem_run": str(fem_run_dir),
        "fdm_time_s": float(fdm.times[-1]),
        "fem_time_s": float(fem.times[-1]),
        "same_final_time": same_final_time,
        "time_tolerance_s": time_tolerance,
        "fem_sampling": dict(fem.metadata),
        "metrics": metrics.to_dict(),
        "qualification": {
            "status": "diagnostic",
            "equivalence_established": False,
            "reason": (
                "volume-consistent tet4 restriction and scalar endpoint metrics do not replace "
                "h/dt convergence, common equilibrium, or operator parity"
            ),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fdm-run", required=True, type=Path)
    parser.add_argument("--fem-run", required=True, type=Path)
    parser.add_argument("--time-tolerance", type=float, default=1.0e-18)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not np.isfinite(args.time_tolerance) or args.time_tolerance < 0.0:
        parser.error("--time-tolerance must be finite and non-negative")
    payload = compare(args.fdm_run, args.fem_run, args.time_tolerance)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
