#!/usr/bin/env python3
"""Prepare the frozen magnetic submesh for the periodic antidot FMR smoke."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import fullmag as fm
from fullmag.meshing._gmsh_types import MeshData
from fullmag.meshing.asset_pipeline import (
    _extract_frozen_magnetic_submesh,
    realize_fem_domain_mesh_asset_from_components_with_report,
)

NM = 1.0e-9


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    return default if raw is None or raw.strip() == "" else float(raw)


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return default if raw is None or raw.strip() == "" else int(raw)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(
            os.environ.get(
                "FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE",
                ".fullmag/reports/frequency-domain-periodic-airbox-runtime/mesh/"
                "periodic_antidot_frozen_magnetic_submesh.npz",
            )
        ),
        help="Frozen magnetic submesh .npz output path.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Regenerate even when the output already exists and validates.",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help="Optional JSON report path. Defaults to <output>.report.json.",
    )
    return parser


def cached_output_is_valid(path: Path) -> bool:
    if not path.is_file():
        return False
    mesh = MeshData.load(path)
    mesh.validate_strict(require_positive_orientation=True)
    if mesh.boundary_faces.size == 0:
        raise ValueError(
            f"{path} is not a frozen magnetic submesh: boundary_faces are empty"
        )
    return True


def periodic_antidot_geometry() -> fm.Difference:
    film_size = (200 * NM, 200 * NM, 10 * NM)
    return fm.Difference(
        base=fm.Box(size=film_size, name="periodic_film_base"),
        tool=fm.Cylinder(radius=25 * NM, height=film_size[2], name="central_hole"),
        name="periodic_film",
    )


def study_universe() -> dict[str, object]:
    fast_runtime_mesh = env_bool("FULLMAG_FMR_FAST_RUNTIME_MESH")
    film_size = (200 * NM, 200 * NM, 10 * NM)
    airbox_thickness = env_float("FULLMAG_FMR_AIRBOX_THICKNESS_NM", 90.0) * NM
    if airbox_thickness <= film_size[2]:
        raise ValueError("FULLMAG_FMR_AIRBOX_THICKNESS_NM must exceed 10 nm")
    return {
        "mode": "manual",
        "size": [film_size[0], film_size[1], airbox_thickness],
        "center": [0.0, 0.0, 0.0],
        "airbox_hmax": env_float(
            "FULLMAG_FMR_AIRBOX_MAX_ELEMENT_SIZE_NM",
            120.0 if fast_runtime_mesh else 60.0,
        )
        * NM,
        "airbox_hmin": env_float(
            "FULLMAG_FMR_AIRBOX_MIN_ELEMENT_SIZE_NM",
            16.0 if fast_runtime_mesh else 8.0,
        )
        * NM,
        "airbox_growth_rate": 1.5,
        "airbox_grading": "linear",
    }


def mesh_workflow() -> dict[str, object]:
    fast_runtime_mesh = env_bool("FULLMAG_FMR_FAST_RUNTIME_MESH")
    film_size_z = 10 * NM
    film_min = env_float(
        "FULLMAG_FMR_FILM_MIN_ELEMENT_SIZE_NM",
        8.0 if fast_runtime_mesh else 3.0,
    ) * NM
    film_max = env_float(
        "FULLMAG_FMR_FILM_MAX_ELEMENT_SIZE_NM",
        20.0 if fast_runtime_mesh else 8.0,
    ) * NM
    interface_max = env_float(
        "FULLMAG_FMR_FILM_INTERFACE_MAX_ELEMENT_SIZE_NM",
        14.0 if fast_runtime_mesh else 5.0,
    ) * NM
    edge_max = env_float(
        "FULLMAG_FMR_FILM_EDGE_MAX_ELEMENT_SIZE_NM",
        12.0 if fast_runtime_mesh else 4.0,
    ) * NM
    return {
        "mesh_options": {
            "periodic_pair_ids": ["x_faces", "y_faces"],
            "algorithm_2d": 6,
            "algorithm_3d": env_int("FULLMAG_FMR_MESH_ALGORITHM_3D", 1),
            "smoothing_steps": env_int(
                "FULLMAG_FMR_MESH_SMOOTHING_STEPS",
                1 if fast_runtime_mesh else 4,
            ),
            "optimize_iters": env_int(
                "FULLMAG_FMR_MESH_OPTIMIZE_ITERATIONS",
                1 if fast_runtime_mesh else 3,
            ),
            "size_from_curvature": env_int(
                "FULLMAG_FMR_MESH_SIZE_FROM_CURVATURE",
                8 if fast_runtime_mesh else 24,
            ),
            "narrow_regions": env_int(
                "FULLMAG_FMR_MESH_NARROW_REGIONS",
                1 if fast_runtime_mesh else 3,
            ),
        },
        "per_geometry": [
            {
                "geometry": "periodic_film",
                "bulk_hmax": film_max,
                "interface_hmax": interface_max,
                "interface_thickness": 8 * NM,
                "transition_distance": 20 * NM,
                "edge_hmax": edge_max,
                "edge_thickness": 5 * NM,
                "edge_transition_distance": 12 * NM,
                "corner_hmax": edge_max,
                "corner_extent": 5 * NM,
                "corner_transition_distance": 10 * NM,
            }
        ],
        "object_regions": [
            {
                "owner_object": "periodic_film",
                "name": "hole_transition_refinement",
                "enabled": True,
                "shape": {
                    "kind": "cylinder",
                    "radius": 43 * NM,
                    "height": film_size_z,
                    "center": [0.0, 0.0, 0.0],
                    "axis": [0.0, 0.0, 1.0],
                },
                "mesh_policy": {
                    "minimum_element_size": film_min,
                    "maximum_element_size": env_float(
                        "FULLMAG_FMR_HOLE_TRANSITION_MAX_ELEMENT_SIZE_NM",
                        14.0 if fast_runtime_mesh else 6.0,
                    )
                    * NM,
                    "transition_distance": 14 * NM,
                    "order": 1,
                },
            },
            {
                "owner_object": "periodic_film",
                "name": "hole_edge_refinement",
                "enabled": True,
                "shape": {
                    "kind": "cylinder",
                    "radius": 30 * NM,
                    "height": film_size_z,
                    "center": [0.0, 0.0, 0.0],
                    "axis": [0.0, 0.0, 1.0],
                },
                "mesh_policy": {
                    "minimum_element_size": env_float(
                        "FULLMAG_FMR_HOLE_EDGE_MIN_ELEMENT_SIZE_NM",
                        8.0 if fast_runtime_mesh else 3.0,
                    )
                    * NM,
                    "maximum_element_size": env_float(
                        "FULLMAG_FMR_HOLE_EDGE_MAX_ELEMENT_SIZE_NM",
                        12.0 if fast_runtime_mesh else 4.0,
                    )
                    * NM,
                    "transition_distance": 6 * NM,
                    "order": 1,
                },
            },
        ],
    }


def write_report(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def main() -> int:
    args = build_parser().parse_args()
    output = args.output.expanduser()
    report_path = (
        args.report.expanduser()
        if args.report is not None
        else output.with_suffix(output.suffix + ".report.json")
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    if not args.force and cached_output_is_valid(output):
        write_report(report_path, {"status": "cached", "mesh_source": str(output)})
        print(output)
        return 0

    universe = study_universe()
    workflow = mesh_workflow()
    object_regions = workflow.pop("object_regions")
    mesh, region_markers, build_report = (
        realize_fem_domain_mesh_asset_from_components_with_report(
            geometries=[periodic_antidot_geometry()],
            hints=fm.FEM(order=1, hmax=universe["airbox_hmax"]),
            study_universe=universe,
            mesh_workflow=workflow,
            object_regions=object_regions,  # type: ignore[arg-type]
        )
    )
    if build_report.build_mode != "conformal_occ" or build_report.degraded:
        raise RuntimeError(
            "baseline periodic antidot mesh must be a clean conformal OCC mesh "
            f"(build_mode={build_report.build_mode!r}, degraded={build_report.degraded!r})"
        )
    frozen = _extract_frozen_magnetic_submesh(
        mesh,
        region_markers,
        geometry_name="periodic_film",
    )
    frozen.mesh.save(output)
    write_report(
        report_path,
        {
            "status": "generated",
            "mesh_source": str(output),
            "region_markers": frozen.region_markers,
            "node_count": frozen.mesh.n_nodes,
            "element_count": frozen.mesh.n_elements,
            "interface_boundary_face_count": int(frozen.mesh.boundary_faces.shape[0]),
            "magnetic_submesh_signatures": frozen.magnetic_submesh_signatures,
            "baseline_build_report": build_report.to_dict(),
        },
    )
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
