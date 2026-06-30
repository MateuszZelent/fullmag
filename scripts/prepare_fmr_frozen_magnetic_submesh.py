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
    _assert_frozen_magnetic_submesh_invariants,
    _extract_frozen_magnetic_submesh,
    _frozen_magnetic_submesh_invariants,
    _load_frozen_magnetic_submesh_invariants_report,
    realize_fem_domain_mesh_asset_from_components_with_report,
)

NM = 1.0e-9
UNIT_CELL_SIZE = (200 * NM, 200 * NM, 10 * NM)


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


def supercell_repeats() -> tuple[int, int]:
    repeat_x = env_int("FULLMAG_FMR_SUPERCELL_REPEAT_X", 1)
    repeat_y = env_int("FULLMAG_FMR_SUPERCELL_REPEAT_Y", 1)
    if repeat_x <= 0 or repeat_y <= 0:
        raise ValueError("FULLMAG_FMR_SUPERCELL_REPEAT_X/Y must be positive integers")
    return repeat_x, repeat_y


def film_size() -> tuple[float, float, float]:
    repeat_x, repeat_y = supercell_repeats()
    return (
        UNIT_CELL_SIZE[0] * repeat_x,
        UNIT_CELL_SIZE[1] * repeat_y,
        UNIT_CELL_SIZE[2],
    )


def lattice_offsets(repeat: int, pitch: float) -> list[float]:
    center = 0.5 * (repeat - 1)
    return [(index - center) * pitch for index in range(repeat)]


def hole_centers() -> list[tuple[float, float]]:
    repeat_x, repeat_y = supercell_repeats()
    return [
        (x, y)
        for x in lattice_offsets(repeat_x, UNIT_CELL_SIZE[0])
        for y in lattice_offsets(repeat_y, UNIT_CELL_SIZE[1])
    ]


def translated_cylinder(radius: float, height: float, center: tuple[float, float], name: str):
    cylinder = fm.Cylinder(radius=radius, height=height, name=name)
    if center == (0.0, 0.0):
        return cylinder
    return cylinder.translate((center[0], center[1], 0.0))


def union_geometries(geometries: list[object]):
    if not geometries:
        raise ValueError("supercell antidot geometry requires at least one hole")
    current = geometries[0]
    for geometry in geometries[1:]:
        current = current + geometry
    return current


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
    size = film_size()
    centers = hole_centers()
    holes = [
        translated_cylinder(
            25 * NM,
            size[2],
            center,
            "central_hole" if len(centers) == 1 else f"hole_{index}",
        )
        for index, center in enumerate(centers)
    ]
    return fm.Difference(
        base=fm.Box(size=size, name="periodic_film_base"),
        tool=union_geometries(holes),
        name="periodic_film",
    )


def study_universe() -> dict[str, object]:
    fast_runtime_mesh = env_bool("FULLMAG_FMR_FAST_RUNTIME_MESH")
    size = film_size()
    airbox_thickness = env_float("FULLMAG_FMR_AIRBOX_THICKNESS_NM", 90.0) * NM
    if airbox_thickness <= size[2]:
        raise ValueError("FULLMAG_FMR_AIRBOX_THICKNESS_NM must exceed 10 nm")
    return {
        "mode": "manual",
        "size": [size[0], size[1], airbox_thickness],
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
    film_size_z = film_size()[2]
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
        "object_regions": supercell_object_regions(
            film_size_z=film_size_z,
            film_min=film_min,
            fast_runtime_mesh=fast_runtime_mesh,
        ),
    }


def supercell_object_regions(
    *,
    film_size_z: float,
    film_min: float,
    fast_runtime_mesh: bool,
) -> list[dict[str, object]]:
    centers = hole_centers()
    regions: list[dict[str, object]] = []
    for index, center in enumerate(centers):
        suffix = "" if len(centers) == 1 else f"_{index}"
        regions.append(
            {
                "owner_object": "periodic_film",
                "name": f"hole_transition_refinement{suffix}",
                "enabled": True,
                "shape": {
                    "kind": "cylinder",
                    "radius": 43 * NM,
                    "height": film_size_z,
                    "center": [center[0], center[1], 0.0],
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
            }
        )
        regions.append(
            {
                "owner_object": "periodic_film",
                "name": f"hole_edge_refinement{suffix}",
                "enabled": True,
                "shape": {
                    "kind": "cylinder",
                    "radius": 30 * NM,
                    "height": film_size_z,
                    "center": [center[0], center[1], 0.0],
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
            }
        )
    return regions


def write_report(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def frozen_region_markers_from_report(report_path: Path) -> list[dict[str, object]]:
    if report_path.is_file():
        try:
            payload = json.loads(report_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            payload = {}
        if isinstance(payload, dict) and isinstance(payload.get("region_markers"), list):
            markers: list[dict[str, object]] = []
            for marker in payload["region_markers"]:
                if isinstance(marker, dict):
                    markers.append(dict(marker))
            if markers:
                return markers
    return [{"geometry_name": "periodic_film", "marker": 1}]


def previous_baseline_build_report_from_report(report_path: Path) -> object | None:
    if not report_path.is_file():
        return None
    try:
        payload = json.loads(report_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    if isinstance(payload, dict):
        return payload.get("baseline_build_report")
    return None


def frozen_submesh_report_payload(
    *,
    status: str,
    output: Path,
    mesh: MeshData,
    region_markers: list[dict[str, object]],
    baseline_build_report: object | None = None,
) -> dict[str, object]:
    invariants = _frozen_magnetic_submesh_invariants(mesh, region_markers)
    repeat_x, repeat_y = supercell_repeats()
    payload: dict[str, object] = {
        "status": status,
        "mesh_source": str(output),
        "supercell_repeat_x": repeat_x,
        "supercell_repeat_y": repeat_y,
        "supercell_cell_count": repeat_x * repeat_y,
        "region_markers": region_markers,
        "node_count": invariants["node_count"],
        "element_count": invariants["element_count"],
        "interface_boundary_face_count": invariants["interface_boundary_face_count"],
        "periodic_boundary_pair_count": invariants["periodic_boundary_pair_count"],
        "periodic_node_pair_count": invariants["periodic_node_pair_count"],
        "periodic_boundary_pair_counts_by_id": invariants[
            "periodic_boundary_pair_counts_by_id"
        ],
        "periodic_node_pair_counts_by_id": invariants["periodic_node_pair_counts_by_id"],
        "magnetic_submesh_signatures": invariants["magnetic_submesh_signatures"],
        "frozen_magnetic_submesh_invariants": invariants,
    }
    if baseline_build_report is not None:
        payload["baseline_build_report"] = baseline_build_report
    return payload


def assert_frozen_submesh_invariants_match_previous_report(
    report_path: Path,
    mesh: MeshData,
    region_markers: list[dict[str, object]],
) -> None:
    if not report_path.is_file():
        return
    expected = _load_frozen_magnetic_submesh_invariants_report(report_path)
    candidate = _frozen_magnetic_submesh_invariants(mesh, region_markers)
    try:
        _assert_frozen_magnetic_submesh_invariants(
            expected,
            candidate,
            context=str(report_path),
        )
    except ValueError as exc:
        raise RuntimeError(str(exc)) from exc


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
        cached_mesh = MeshData.load(output)
        region_markers = frozen_region_markers_from_report(report_path)
        assert_frozen_submesh_invariants_match_previous_report(
            report_path,
            cached_mesh,
            region_markers,
        )
        write_report(
            report_path,
            frozen_submesh_report_payload(
                status="cached",
                output=output,
                mesh=cached_mesh,
                region_markers=region_markers,
                baseline_build_report=previous_baseline_build_report_from_report(report_path),
            ),
        )
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
    assert_frozen_submesh_invariants_match_previous_report(
        report_path,
        frozen.mesh,
        frozen.region_markers,
    )
    frozen.mesh.save(output)
    write_report(
        report_path,
        frozen_submesh_report_payload(
            status="generated",
            output=output,
            mesh=frozen.mesh,
            region_markers=frozen.region_markers,
            baseline_build_report=build_report.to_dict(),
        ),
    )
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
