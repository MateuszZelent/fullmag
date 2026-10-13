"""Actual-Gmsh probes for component-scoped sizing on extrusion caps.

The production-style and geometry-only cases share the same SI geometry and
field. These probes do not qualify the production layered-box route or PBC.
"""

from __future__ import annotations

import importlib.util
import itertools
import math
import subprocess
import sys
import time
import unittest
from pathlib import Path

import numpy as np

from fullmag.meshing._layered_box_tetrahedralization import (
    tetrahedralize_layered_box,
)
from fullmag.meshing.gmsh_bridge import MeshOptions, _apply_mesh_options


_SCALE = 1.0e6  # Production Gmsh coordinates are expressed in micrometres.
_HALF_X_M = 60.0e-9
_HALF_Y_M = 40.0e-9
_PLANES_M = (-10.0e-9, 0.0, 10.0e-9)
_HMAX_M = 20.0e-9
_VIN_M = 3.0e-9
_ROI_HALF_XY_M = 15.0e-9
_FIELD_HALF_Z_M = 4.0e-9
_PROBE_TIMEOUT_S = 60


def _observe_tetrahedral_quality(
    nodes_si: np.ndarray,
    cells: np.ndarray,
) -> None:
    """Print dimensionless tet4 quality observations without adding a gate.

    Coordinates are centered and divided by one shared mesh scale before any
    edge products or determinants are evaluated, keeping these ratios away
    from SI-scale underflow.
    """
    coordinates = np.asarray(nodes_si, dtype=np.float64)
    cell_ids = np.asarray(cells, dtype=np.int64)
    lower = np.min(coordinates, axis=0)
    upper = np.max(coordinates, axis=0)
    common_scale = float(np.max(upper - lower))
    if not math.isfinite(common_scale) or common_scale <= 0.0:
        print(
            "evidence: topology=PASS, quality_state=FAIL; "
            f"no positive finite common scale: {common_scale!r}",
            flush=True,
        )
        return

    center = lower + 0.5 * (upper - lower)
    scaled_coordinates = (coordinates - center) / common_scale
    tetrahedra = scaled_coordinates[cell_ids]
    edge_pairs = tuple(itertools.combinations(range(4), 2))
    edge_lengths = np.stack(
        [
            np.linalg.norm(
                tetrahedra[:, left, :] - tetrahedra[:, right, :],
                axis=1,
            )
            for left, right in edge_pairs
        ],
        axis=1,
    )
    minimum_edge = np.min(edge_lengths, axis=1)
    maximum_edge = np.max(edge_lengths, axis=1)
    edge_ratio = np.divide(
        maximum_edge,
        minimum_edge,
        out=np.full_like(maximum_edge, np.inf),
        where=minimum_edge > 0.0,
    )

    per_vertex_scaled_jacobians = np.empty((len(cell_ids), 4), dtype=np.float64)
    for vertex in range(4):
        neighbors = [index for index in range(4) if index != vertex]
        edge_vectors = (
            tetrahedra[:, neighbors, :]
            - tetrahedra[:, vertex : vertex + 1, :]
        )
        signed_determinants = np.linalg.det(edge_vectors)
        if vertex % 2:
            signed_determinants = -signed_determinants
        edge_product = np.prod(np.linalg.norm(edge_vectors, axis=2), axis=1)
        per_vertex_scaled_jacobians[:, vertex] = np.divide(
            signed_determinants,
            edge_product,
            out=np.full_like(signed_determinants, np.nan),
            where=edge_product > 0.0,
        )

    minimum_signed_scaled_jacobian = np.min(
        per_vertex_scaled_jacobians,
        axis=1,
    )
    signed_determinants = np.linalg.det(
        tetrahedra[:, 1:, :] - tetrahedra[:, :1, :]
    )
    normalized_volume_determinant = np.divide(
        signed_determinants,
        maximum_edge**3,
        out=np.full_like(signed_determinants, np.nan),
        where=maximum_edge > 0.0,
    )

    finite_metrics = (
        np.all(np.isfinite(per_vertex_scaled_jacobians))
        and np.all(np.isfinite(edge_ratio))
        and np.all(np.isfinite(normalized_volume_determinant))
    )
    quality_state = (
        "FAIL"
        if (
            not finite_metrics
            or np.any(minimum_signed_scaled_jacobian <= 0.0)
            or np.any(normalized_volume_determinant <= 0.0)
        )
        else "OPEN"
    )
    histogram_edges = np.linspace(-1.0, 1.0, 21)
    histogram_counts, histogram_edges = np.histogram(
        minimum_signed_scaled_jacobian,
        bins=histogram_edges,
    )
    histogram = [
        {
            "lo": float(histogram_edges[index]),
            "hi": float(histogram_edges[index + 1]),
            "count": int(histogram_counts[index]),
        }
        for index in range(len(histogram_counts))
    ]
    outside_histogram_count = int(
        np.count_nonzero(
            (minimum_signed_scaled_jacobian < -1.0)
            | (minimum_signed_scaled_jacobian > 1.0)
        )
    )

    min5_ordinals = np.argsort(
        np.where(
            np.isfinite(minimum_signed_scaled_jacobian),
            minimum_signed_scaled_jacobian,
            np.inf,
        ),
        kind="stable",
    )[: min(5, len(cell_ids))]
    min5 = [
        {
            "cell_ordinal": int(ordinal),
            "minimum_signed_scaled_jacobian": float(
                minimum_signed_scaled_jacobian[ordinal]
            ),
            "per_vertex_det_over_edge_norm_product": [
                float(value)
                for value in per_vertex_scaled_jacobians[ordinal]
            ],
            "edge_ratio_max_over_min": float(edge_ratio[ordinal]),
            "normalized_volume_det_over_max_edge_cubed": float(
                normalized_volume_determinant[ordinal]
            ),
            "coordinates_si_m": coordinates[cell_ids[ordinal]].tolist(),
        }
        for ordinal in min5_ordinals
    ]
    print(
        "evidence: dimensionless tet4 quality observation; "
        f"topology=PASS, quality_state={quality_state} "
        "(OPEN means no quality threshold was applied), "
        f"common_scale_m={common_scale:.17g}, "
        "minimum_per_vertex_det_over_edge_norm_product="
        f"{float(np.nanmin(per_vertex_scaled_jacobians)):.17g}, "
        "minimum_signed_scaled_jacobian="
        f"{float(np.nanmin(minimum_signed_scaled_jacobian)):.17g}, "
        "edge_ratio_max_over_min="
        f"{float(np.nanmax(edge_ratio)):.17g}, "
        "normalized_volume_det_over_max_edge_cubed_min="
        f"{float(np.nanmin(normalized_volume_determinant)):.17g}, "
        f"minimum_signed_scaled_jacobian_histogram={histogram}, "
        f"histogram_outside_count={outside_histogram_count}, "
        f"min5_by_signed_scaled_jacobian={min5}",
        flush=True,
    )


def _tetrahedralize_actual_caps(
    cap_nodes_scaled: dict[float, np.ndarray],
) -> tuple[np.ndarray, dict[str, float | int]]:
    plane_inputs = [
        (float(plane_m), float(plane_m * _SCALE)) for plane_m in _PLANES_M
    ]
    nodes_si = np.vstack(
        [cap_nodes_scaled[plane_scaled] for _, plane_scaled in plane_inputs]
    ) / _SCALE
    layer_planes_si = np.asarray(_PLANES_M, dtype=np.float64)
    bounds_xy_si = (
        -_HALF_X_M,
        _HALF_X_M,
        -_HALF_Y_M,
        _HALF_Y_M,
    )
    max_z_error_by_plane = {
        f"{plane_m:.17g}": float(
            np.max(
                np.abs(
                    cap_nodes_scaled[plane_scaled][:, 2] / _SCALE - plane_m
                )
            )
        )
        for plane_m, plane_scaled in plane_inputs
    }
    input_nodes_before = nodes_si.copy()
    print(
        "stage: actual Gmsh nodes converted to SI without coordinate snapping; "
        f"node_count={len(nodes_si)}, layer_planes_m={layer_planes_si.tolist()}, "
        f"bounds_xy_m={bounds_xy_si}, max_z_error_m={max_z_error_by_plane}",
        flush=True,
    )

    started = time.perf_counter()
    try:
        cells = tetrahedralize_layered_box(
            nodes_si,
            layer_planes_si,
            bounds_xy_si,
        )
    except Exception as exc:
        elapsed_s = time.perf_counter() - started
        print(
            "evidence: layered-box kernel rejected actual Gmsh nodes; "
            f"elapsed_s={elapsed_s:.9f}, exception={type(exc).__name__}: {exc}",
            flush=True,
        )
        raise
    elapsed_s = time.perf_counter() - started

    if not np.array_equal(nodes_si, input_nodes_before):
        raise AssertionError("layered-box kernel modified its actual Gmsh node input")
    used_nodes = np.unique(cells)
    if not np.array_equal(used_nodes, np.arange(len(nodes_si), dtype=used_nodes.dtype)):
        raise AssertionError(
            f"kernel did not use every actual Gmsh cap node: "
            f"used={len(used_nodes)}, input={len(nodes_si)}"
        )

    tetra_nodes = nodes_si[cells]
    determinants = np.linalg.det(tetra_nodes[:, 1:, :] - tetra_nodes[:, :1, :])
    if not np.all(np.isfinite(determinants)) or not np.all(determinants > 0.0):
        raise AssertionError("kernel returned a nonfinite or nonpositive tetrahedron")
    tetra_volumes = [float(determinant) / 6.0 for determinant in determinants]
    xmin, xmax, ymin, ymax = bounds_xy_si
    expected_volume = (
        (xmax - xmin)
        * (ymax - ymin)
        * (layer_planes_si[-1] - layer_planes_si[0])
    )
    actual_volume = math.fsum(tetra_volumes)
    relative_volume_error = abs(actual_volume - expected_volume) / expected_volume
    if not math.isclose(actual_volume, expected_volume, rel_tol=1e-12, abs_tol=0.0):
        raise AssertionError(
            f"kernel tetrahedra do not cover the box volume: "
            f"actual={actual_volume:.17g}, expected={expected_volume:.17g}, "
            f"relative_error={relative_volume_error:.17g}"
        )

    plane_index = {float(z): index for index, z in enumerate(layer_planes_si)}
    face_slabs: dict[tuple[int, int, int], list[int]] = {}
    for cell in cells:
        z_indices = [plane_index[float(nodes_si[int(index), 2])] for index in cell]
        low, high = min(z_indices), max(z_indices)
        if high - low != 1:
            raise AssertionError(
                f"kernel tetrahedron crosses a requested slab: z_indices={z_indices}"
            )
        for face in itertools.combinations((int(index) for index in cell), 3):
            key = tuple(sorted(face))
            face_slabs.setdefault(key, []).append(low)

    if any(len(slabs) not in (1, 2) for slabs in face_slabs.values()):
        raise AssertionError("kernel returned a face with invalid incidence")
    middle_z = float(layer_planes_si[1])
    middle_cap_faces = [
        (face, slabs)
        for face, slabs in face_slabs.items()
        if np.all(nodes_si[np.asarray(face, dtype=np.int64), 2] == middle_z)
    ]
    if not middle_cap_faces:
        raise AssertionError("kernel output has no triangulated middle cap")
    for face, slabs in middle_cap_faces:
        if len(slabs) != 2 or sorted(slabs) != [0, 1]:
            raise AssertionError(
                f"middle cap face is not shared by adjacent slabs: {face}, {slabs}"
            )

    centroids = tetra_nodes.mean(axis=1)
    roi_mask = (
        (np.abs(centroids[:, 0]) <= _ROI_HALF_XY_M)
        & (np.abs(centroids[:, 1]) <= _ROI_HALF_XY_M)
        & (np.abs(centroids[:, 2]) <= _FIELD_HALF_Z_M)
    )
    roi_tetrahedra = int(np.count_nonzero(roi_mask))
    if roi_tetrahedra == 0:
        raise AssertionError(
            "kernel returned no tetrahedron whose centroid lies in the regional ROI"
        )

    _observe_tetrahedral_quality(nodes_si, cells)

    details: dict[str, float | int] = {
        "kernel_elapsed_s": elapsed_s,
        "tetrahedron_count": int(len(cells)),
        "used_node_count": int(len(used_nodes)),
        "middle_cap_face_count": int(len(middle_cap_faces)),
        "roi_tetrahedron_count": roi_tetrahedra,
        "minimum_signed_determinant_m3": float(np.min(determinants)),
        "relative_volume_error": relative_volume_error,
    }
    print(f"evidence: layered-box kernel {details}", flush=True)
    return cells, details


def _run_actual_gmsh_probe(extrusion_mode: str) -> None:
    import gmsh

    if extrusion_mode not in {"production-mesh-sweep", "geometry-only"}:
        raise ValueError(f"unsupported extrusion mode: {extrusion_mode}")

    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add(f"component_restricted_box_cap_{extrusion_mode}")
        geo = gmsh.model.geo

        x0, x1 = -_HALF_X_M * _SCALE, _HALF_X_M * _SCALE
        y0, y1 = -_HALF_Y_M * _SCALE, _HALF_Y_M * _SCALE
        z0, zm, z1 = (plane * _SCALE for plane in _PLANES_M)
        hmax = _HMAX_M * _SCALE
        bbox_tolerance = 1.0e-5 * hmax
        node_tolerance = (
            64.0
            * np.finfo(np.float64).eps
            * max(1.0, abs(x0), abs(x1), abs(y0), abs(y1), abs(z0), abs(z1))
        )
        print(
            f"stage: mode={extrusion_mode}, "
            f"gmsh={getattr(gmsh, '__version__', 'unknown')}, "
            f"planes_m={list(_PLANES_M)}",
            flush=True,
        )

        corner_tags = [
            geo.addPoint(x, y, z0, hmax)
            for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))
        ]
        curve_tags = [
            geo.addLine(corner_tags[index], corner_tags[(index + 1) % 4])
            for index in range(4)
        ]
        source_loop = geo.addCurveLoop(curve_tags)
        source_surface = geo.addPlaneSurface([source_loop])
        geo.synchronize()

        def extrude_surface(surface_tag: int, distance: float):
            args = ([(2, surface_tag)], 0.0, 0.0, distance)
            if extrusion_mode == "geometry-only":
                return geo.extrude(*args)
            return geo.extrude(
                *args,
                numElements=[1],
                heights=[1.0],
                recombine=True,
            )

        lower_extrusion = extrude_surface(source_surface, zm - z0)
        geo.synchronize()
        lower_volumes = [
            int(tag) for dim, tag in lower_extrusion if int(dim) == 3
        ]
        if len(lower_volumes) != 1:
            raise AssertionError(
                f"expected one lower extrusion volume, got {lower_extrusion!r}"
            )
        print(f"stage: lower extrusion volume={lower_volumes[0]}", flush=True)

        def boundary_surfaces(volume_tag: int) -> set[int]:
            return {
                abs(int(tag))
                for dim, tag in gmsh.model.getBoundary(
                    [(3, volume_tag)],
                    combined=False,
                    oriented=False,
                    recursive=False,
                )
                if int(dim) == 2
            }

        def cap_at_plane(volume_tag: int, plane_z: float) -> int:
            matches: list[int] = []
            for surface_tag in boundary_surfaces(volume_tag):
                bounds = gmsh.model.getBoundingBox(2, surface_tag)
                if (
                    abs(float(bounds[2]) - plane_z) <= bbox_tolerance
                    and abs(float(bounds[5]) - plane_z) <= bbox_tolerance
                    and abs(float(bounds[0]) - x0) <= bbox_tolerance
                    and abs(float(bounds[3]) - x1) <= bbox_tolerance
                    and abs(float(bounds[1]) - y0) <= bbox_tolerance
                    and abs(float(bounds[4]) - y1) <= bbox_tolerance
                ):
                    matches.append(surface_tag)
            if len(matches) != 1:
                raise AssertionError(
                    f"expected one full-box cap at z={plane_z:g}, "
                    f"volume={volume_tag}, matches={matches}"
                )
            return matches[0]

        middle_cap_from_lower = cap_at_plane(lower_volumes[0], zm)
        upper_extrusion = extrude_surface(middle_cap_from_lower, z1 - zm)
        geo.synchronize()
        upper_volumes = [
            int(tag) for dim, tag in upper_extrusion if int(dim) == 3
        ]
        if len(upper_volumes) != 1:
            raise AssertionError(
                f"expected one upper extrusion volume, got {upper_extrusion!r}"
            )
        print(f"stage: upper extrusion volume={upper_volumes[0]}", flush=True)

        lower_surfaces = boundary_surfaces(lower_volumes[0])
        upper_surfaces = boundary_surfaces(upper_volumes[0])
        shared_surfaces = lower_surfaces & upper_surfaces
        middle_cap = cap_at_plane(lower_volumes[0], zm)
        if shared_surfaces != {middle_cap}:
            raise AssertionError(
                "the two extruded volumes must share exactly their middle cap; "
                f"lower={sorted(lower_surfaces)}, upper={sorted(upper_surfaces)}, "
                f"shared={sorted(shared_surfaces)}, middle_cap={middle_cap}"
            )
        lower_cap = cap_at_plane(lower_volumes[0], z0)
        upper_cap = cap_at_plane(upper_volumes[0], z1)

        volume_tags = [lower_volumes[0], upper_volumes[0]]
        field = {
            "kind": "ComponentRestrictedBox",
            "params": {
                "GeometryName": "body",
                "VIn": _VIN_M,
                "VOut": _HMAX_M,
                "XMin": -_ROI_HALF_XY_M,
                "XMax": _ROI_HALF_XY_M,
                "YMin": -_ROI_HALF_XY_M,
                "YMax": _ROI_HALF_XY_M,
                "ZMin": -_FIELD_HALF_Z_M,
                "ZMax": _FIELD_HALF_Z_M,
            },
        }
        _apply_mesh_options(
            gmsh,
            # hmax is already in Gmsh coordinates; hscale scales field inputs.
            hmax=hmax,
            order=1,
            opts=MeshOptions(size_fields=[field], compute_quality=False),
            hscale=_SCALE,
            component_volume_tags={"body": volume_tags},
        )

        field_ids = [int(tag) for tag in gmsh.model.mesh.field.list()]
        field_types = {
            field_id: gmsh.model.mesh.field.getType(field_id)
            for field_id in field_ids
        }
        restrict_ids = [
            field_id
            for field_id, field_type in field_types.items()
            if field_type == "Restrict"
        ]
        if len(restrict_ids) != 1:
            raise AssertionError(
                f"expected one existing owner-restricted field, got {field_types}"
            )
        restrict_id = restrict_ids[0]
        restricted_volumes = sorted(
            int(round(float(tag)))
            for tag in gmsh.model.mesh.field.getNumbers(restrict_id, "VolumesList")
        )
        if restricted_volumes != sorted(volume_tags):
            raise AssertionError(
                f"owner field volumes={restricted_volumes}, expected={sorted(volume_tags)}"
            )
        include_boundary = float(
            gmsh.model.mesh.field.getNumber(restrict_id, "IncludeBoundary")
        )
        if include_boundary != 1.0:
            raise AssertionError(
                f"Restrict.IncludeBoundary={include_boundary}, expected Gmsh default 1"
            )

        cap_tags_by_plane = {z0: lower_cap, zm: middle_cap, z1: upper_cap}
        print(
            "stage: geometry incidence and owner field verified; "
            f"cap_tags={cap_tags_by_plane}, restricted_volumes={restricted_volumes}, "
            "starting generate(2)",
            flush=True,
        )
        gmsh.model.mesh.generate(2)
        print("stage: generate(2) completed", flush=True)

        cap_nodes: dict[float, np.ndarray] = {}
        roi_counts: dict[float, int] = {}
        total_counts: dict[float, int] = {}
        for plane_z, surface_tag in cap_tags_by_plane.items():
            _, coordinates, _ = gmsh.model.mesh.getNodes(
                2,
                surface_tag,
                includeBoundary=True,
                returnParametricCoord=False,
            )
            nodes = np.asarray(coordinates, dtype=np.float64).reshape((-1, 3))
            cap_nodes[plane_z] = nodes
            total_counts[plane_z] = int(len(nodes))
            if len(nodes) == 0:
                raise AssertionError(
                    f"no 2D mesh nodes on cap z={plane_z:g}, surface={surface_tag}"
                )
            max_plane_error = float(np.max(np.abs(nodes[:, 2] - plane_z)))
            if max_plane_error > node_tolerance:
                raise AssertionError(
                    f"cap z-plane drift: z={plane_z:g}, surface={surface_tag}, "
                    f"max_error={max_plane_error:.17g}, "
                    f"tolerance={node_tolerance:.17g}"
                )
            roi_mask = (
                (nodes[:, 0] > -_ROI_HALF_XY_M * _SCALE)
                & (nodes[:, 0] < _ROI_HALF_XY_M * _SCALE)
                & (nodes[:, 1] > -_ROI_HALF_XY_M * _SCALE)
                & (nodes[:, 1] < _ROI_HALF_XY_M * _SCALE)
            )
            roi_counts[plane_z] = int(np.count_nonzero(roi_mask))

        def xy_signature(nodes: np.ndarray) -> tuple[tuple[float, float], ...]:
            return tuple(sorted((float(x), float(y)) for x, y in nodes[:, :2]))

        copied_xy = {
            "middle_equals_lower": xy_signature(cap_nodes[zm])
            == xy_signature(cap_nodes[z0]),
            "middle_equals_upper": xy_signature(cap_nodes[zm])
            == xy_signature(cap_nodes[z1]),
            "lower_equals_upper": xy_signature(cap_nodes[z0])
            == xy_signature(cap_nodes[z1]),
        }
        print(
            "evidence: "
            f"mode={extrusion_mode}, roi_node_counts={roi_counts}, "
            f"total_node_counts={total_counts}, copied_xy={copied_xy}",
            flush=True,
        )

        if extrusion_mode == "production-mesh-sweep" and not all(copied_xy.values()):
            raise AssertionError(
                "production-style mesh extrusion did not preserve identical cap "
                f"XY nodes: {copied_xy}; ROI={roi_counts}; total={total_counts}"
            )
        if extrusion_mode == "geometry-only":
            if not (
                copied_xy["lower_equals_upper"]
                and not copied_xy["middle_equals_lower"]
                and not copied_xy["middle_equals_upper"]
            ):
                raise AssertionError(
                    "geometry-only caps do not show a coarse/fine/coarse XY pattern; "
                    f"copied_xy={copied_xy}, ROI={roi_counts}, total={total_counts}"
                )
            if roi_counts[zm] <= max(roi_counts[z0], roi_counts[z1]):
                raise AssertionError(
                    "geometry-only extrusion did not allow the component-restricted "
                    "Box to create a denser middle cap; "
                    f"gmsh={getattr(gmsh, '__version__', 'unknown')}, "
                    f"planes_m={list(_PLANES_M)}, volume_tags={volume_tags}, "
                    f"cap_tags={cap_tags_by_plane}, roi_node_counts={roi_counts}, "
                    f"total_node_counts={total_counts}, copied_xy={copied_xy}, "
                    f"VIn_m={_VIN_M:g}, VOut_m={_HMAX_M:g}, "
                    f"ROI_half_xy_m={_ROI_HALF_XY_M:g}, "
                    f"field_half_z_m={_FIELD_HALF_Z_M:g}"
                )
            _tetrahedralize_actual_caps(cap_nodes)

    finally:
        if gmsh.isInitialized():
            gmsh.finalize()


class TestLayeredCapFieldSampling(unittest.TestCase):
    def _run_probe(self, mode: str) -> None:
        if importlib.util.find_spec("gmsh") is None:
            self.skipTest("gmsh not available")

        worker_path = str(Path(__file__).resolve())
        try:
            result = subprocess.run(
                [sys.executable, worker_path, "--gmsh-worker", mode],
                capture_output=True,
                text=True,
                timeout=_PROBE_TIMEOUT_S,
                check=False,
            )
        except subprocess.TimeoutExpired as timeout:
            stdout = timeout.stdout or ""
            stderr = timeout.stderr or ""
            if isinstance(stdout, bytes):
                stdout = stdout.decode("utf-8", errors="replace")
            if isinstance(stderr, bytes):
                stderr = stderr.decode("utf-8", errors="replace")
            self.fail(
                f"{mode} actual-Gmsh cap probe exceeded {_PROBE_TIMEOUT_S}s; "
                f"last worker stdout:\n{stdout}\nworker stderr:\n{stderr}"
            )

        self.assertEqual(
            result.returncode,
            0,
            f"{mode} actual-Gmsh cap probe failed with exit={result.returncode}; "
            f"worker stdout:\n{result.stdout}\nworker stderr:\n{result.stderr}",
        )
        if result.stdout:
            print(result.stdout, end="")

    def test_production_style_mesh_extrusion_reuses_cap_xy_nodes(self) -> None:
        self._run_probe("production-mesh-sweep")

    def test_geometry_only_extrusion_refines_shared_middle_cap(self) -> None:
        self._run_probe("geometry-only")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--gmsh-worker":
        _run_actual_gmsh_probe(sys.argv[2])
    else:
        unittest.main()
