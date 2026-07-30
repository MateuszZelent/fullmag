"""Swept (extruded) mesh generation for thin-film and slab geometries.

Implements structured through-thickness meshing via Gmsh ``extrude()`` API
with explicit layer count control.  This produces prism elements (from
triangular source faces) or hexahedral elements (from quad source faces),
giving deterministic control over the number of element layers in the sweep
direction — something that free tetrahedral meshing cannot guarantee.

Key concepts (following COMSOL terminology):
  - **source face**: the 2D face that is meshed first (triangles or quads).
  - **destination face**: the face produced by extrusion on the opposite end.
  - **sweep direction**: the extrusion axis (typically the thin axis).
  - **distribution**: how layers are spaced — fixed uniform, linear grading,
    or exponential grading.

References:
  - COMSOL Learning Center, "Fundamentals of Swept Meshing"
  - Gmsh manual §6.3, ``gmsh.model.geo.extrude``
"""

from __future__ import annotations

import math
import numbers
import tempfile
from dataclasses import dataclass, replace as _dc_replace
from pathlib import Path
from typing import Any, Iterator, Literal

import numpy as np
from numpy.typing import NDArray

from fullmag._progress import emit_progress
from fullmag.model.geometry import ArchWaveguide, Box, Cylinder, Geometry

from ._gmsh_types import (
    AirboxOptions,
    MeshData,
    MeshRealizationReport,
    MeshOptions,
    MeshQualityReport,
    _MIXED_CELL_LOCAL_FACETS,
    _infer_axis_aligned_periodic_pairs,
    _count_exact_layer_planes,
    _mixed_cell_scaled_jacobians,
    MIXED_PYRAMID_APEX_SCALE_MAX,
    MIXED_PYRAMID_APEX_SCALE_STEP,
    MIXED_SCALED_JACOBIAN_P05_MIN,
)
from ._gmsh_infra import (
    _import_gmsh,
    _configure_gmsh_threads,
    _GmshProgressLogger,
)
from ._gmsh_extraction import _extract_mesh_data
from ._gmsh_fields import _add_surface_threshold_field, _apply_mesh_options
from ._gmsh_airbox import (
    _MIXED_SHARED_GMSH_VERSION,
    _add_conforming_swept_box_airbox_geo,
    _attach_mixed_layer_topology_certificate,
    _gmsh_cell_parts_in_extraction_order,
    _gmsh_cell_family_counts_for_entities,
    _gmsh_require_triangular_shell_interface,
)


# ---------------------------------------------------------------------------
# Sweepability classifier
# ---------------------------------------------------------------------------

SWEEP_STRATEGY_PRISM = "swept_prism"
SWEEP_STRATEGY_HEX = "swept_hex"
SWEEP_STRATEGY_AUTO = "auto"
SWEEP_STRATEGY_FREE_TET = "free_tetrahedral"

DISTRIBUTION_FIXED = "fixed"
DISTRIBUTION_LINEAR = "linear"
DISTRIBUTION_EXPONENTIAL = "exponential"


def _apply_mixed_source_face_mesh_options(
    gmsh: Any,
    *,
    source_surface: int,
    hmax_scaled: float,
    order: int,
    opts: MeshOptions,
    hscale: float,
) -> int:
    """Apply canonical film sizing only to the pre-extrusion source face."""
    source_field_ids: list[int] = []
    generic_fields: list[dict[str, Any]] = []
    geometry_names: set[str] = set()
    for config in opts.size_fields:
        params = config.get("params") if isinstance(config, dict) else None
        if not isinstance(params, dict):
            generic_fields.append(config)
            continue
        geometry_name = params.get("GeometryName")
        if isinstance(geometry_name, str):
            geometry_names.add(geometry_name)
        kind = config.get("kind")
        if kind == "ComponentVolumeConstant":
            field_id = gmsh.model.mesh.field.add("Constant")
            gmsh.model.mesh.field.setNumbers(field_id, "SurfacesList", [source_surface])
            gmsh.model.mesh.field.setNumber(
                field_id, "VIn", float(params["VIn"]) * hscale
            )
            gmsh.model.mesh.field.setNumber(
                field_id, "VOut", float(params.get("VOut", 1.0e22)) * hscale
            )
            gmsh.model.mesh.field.setNumber(field_id, "IncludeBoundary", 1)
            source_field_ids.append(field_id)
            config["_gmsh_status"] = "applied"
            config["_gmsh_field_id"] = int(field_id)
            continue
        if kind == "ComponentRestrictedBox":
            field_id = gmsh.model.mesh.field.add("Box")
            for parameter in (
                "VIn", "VOut", "XMin", "XMax", "YMin", "YMax", "ZMin", "ZMax"
            ):
                gmsh.model.mesh.field.setNumber(
                    field_id, parameter, float(params[parameter]) * hscale
                )
            source_field_ids.append(field_id)
            config["_gmsh_status"] = "applied"
            config["_gmsh_field_id"] = int(field_id)
            continue
        generic_fields.append(config)

    _apply_mesh_options(
        gmsh,
        hmax_scaled,
        order,
        _dc_replace(opts, size_fields=generic_fields),
        hscale=hscale,
        preexisting_field_ids=source_field_ids,
        component_surface_tags={name: [source_surface] for name in geometry_names},
    )
    field_ids = [int(field_id) for field_id in gmsh.model.mesh.field.list()]
    if not field_ids:
        raise RuntimeError("mixed source-face refinement produced no Gmsh field")
    source_field = max(field_ids)
    restricted = gmsh.model.mesh.field.add("Restrict")
    gmsh.model.mesh.field.setNumber(restricted, "InField", source_field)
    gmsh.model.mesh.field.setNumbers(restricted, "SurfacesList", [source_surface])
    gmsh.model.mesh.field.setAsBackgroundMesh(restricted)
    return int(restricted)


def _apply_mixed_air_interface_mesh_options(
    gmsh: Any,
    *,
    interface_surfaces: list[int],
    transition_air_volumes: tuple[int, ...],
    opts: MeshOptions,
    hscale: float,
) -> list[int]:
    """Realize interface ramps in air after the magnetic GEO extrusion."""
    restricted_fields: list[int] = []
    for config in opts.size_fields:
        if not isinstance(config, dict) or config.get("kind") not in {
            "InterfaceShellThreshold",
            "TransitionShellThreshold",
        }:
            continue
        params = config.get("params")
        if not isinstance(params, dict):
            continue
        field_id = _add_surface_threshold_field(
            gmsh,
            surface_tags=interface_surfaces,
            size_min=float(params["SizeMin"]),
            size_max=float(params["SizeMax"]),
            dist_min=float(params["DistMin"]),
            dist_max=float(params["DistMax"]),
            sampling=int(params.get("Sampling", 20)),
            hscale=hscale,
            grading=params.get("Grading"),
            growth_rate=params.get("GrowthRate"),
        )
        if field_id is None:
            config["_gmsh_status"] = "ignored"
            config["_gmsh_reason"] = "mixed air interface has no recovered surfaces"
            continue
        restricted = gmsh.model.mesh.field.add("Restrict")
        gmsh.model.mesh.field.setNumber(restricted, "InField", field_id)
        gmsh.model.mesh.field.setNumbers(
            restricted,
            "VolumesList",
            [int(volume) for volume in transition_air_volumes],
        )
        restricted_fields.append(int(restricted))
        config["_gmsh_status"] = "applied"
        config["_gmsh_field_id"] = int(restricted)
    return restricted_fields


def _mixed_gmsh_scaled_jacobian_p05(gmsh: Any) -> dict[str, float]:
    node_tags, coordinates, _ = gmsh.model.mesh.getNodes()
    coordinate_by_tag = {
        int(tag): point
        for tag, point in zip(
            node_tags,
            np.asarray(coordinates, dtype=np.float64).reshape((-1, 3)),
            strict=True,
        )
    }
    values: dict[str, list[float]] = {}
    for element_type, family, arity in (
        (4, "tet4", 4),
        (6, "prism6", 6),
        (7, "pyramid5", 5),
    ):
        element_tags, element_nodes = gmsh.model.mesh.getElementsByType(element_type)
        if len(element_tags) == 0:
            continue
        connectivity = np.asarray(element_nodes, dtype=np.int64).reshape((-1, arity))
        for cell in connectivity:
            cell_coordinates = np.asarray(
                [coordinate_by_tag[int(tag)] for tag in cell], dtype=np.float64
            )
            values.setdefault(family, []).extend(
                _mixed_cell_scaled_jacobians(family, cell_coordinates).tolist()
            )
    return {
        family: float(np.percentile(family_values, 5.0))
        for family, family_values in sorted(values.items())
    }


def _mixed_apex_candidate_preserves_face_sides(
    coordinates: dict[int, NDArray[np.float64]],
    *,
    apex: int,
    candidate: NDArray[np.float64],
    shared_faces: list[
        tuple[
            tuple[int, ...],
            tuple[NDArray[np.int64], NDArray[np.int64]],
        ]
    ],
) -> bool:
    """Require the two owners of every moved shared face to remain opposite."""

    def point(tag: int) -> NDArray[np.float64]:
        return candidate if tag == apex else coordinates[tag]

    for face, owners in shared_faces:
        face_points = np.asarray([point(tag) for tag in face], dtype=np.float64)
        origin = face_points[0]
        normal: NDArray[np.float64] | None = None
        for left in range(1, len(face_points) - 1):
            trial = np.cross(
                face_points[left] - origin,
                face_points[left + 1] - origin,
            )
            norm = float(np.linalg.norm(trial))
            if norm > 0.0:
                normal = trial / norm
                break
        if normal is None:
            return False
        face_scale = max(
            float(np.linalg.norm(right - left))
            for offset, left in enumerate(face_points)
            for right in face_points[offset + 1 :]
        )
        side_tolerance = max(
            np.finfo(np.float64).tiny,
            64.0 * np.finfo(np.float64).eps * face_scale,
        )
        face_nodes = set(face)
        signed_distances: list[float] = []
        for owner in owners:
            opposite = [point(int(tag)) for tag in owner if int(tag) not in face_nodes]
            if not opposite:
                return False
            owner_interior = np.mean(np.asarray(opposite), axis=0)
            signed_distances.append(float(np.dot(owner_interior - origin, normal)))
        if (
            abs(signed_distances[0]) <= side_tolerance
            or abs(signed_distances[1]) <= side_tolerance
            or signed_distances[0] * signed_distances[1] >= 0.0
        ):
            return False
    return True


def _mixed_shared_faces_by_apex(
    cells_by_family: dict[str, list[NDArray[np.int64]]],
    *,
    apex_tags: list[int],
) -> dict[
    int,
    list[
        tuple[
            tuple[int, ...],
            tuple[NDArray[np.int64], NDArray[np.int64]],
        ]
    ],
]:
    """Index every shared face whose plane or owner interior an apex can move."""
    face_owners: dict[tuple[int, ...], list[NDArray[np.int64]]] = {}
    for family, cells in cells_by_family.items():
        for cell in cells:
            for local_face in _MIXED_CELL_LOCAL_FACETS[family]:
                face = tuple(sorted(int(cell[index]) for index in local_face))
                face_owners.setdefault(face, []).append(cell)

    apex_set = set(apex_tags)
    shared_faces_by_apex: dict[
        int,
        list[
            tuple[
                tuple[int, ...],
                tuple[NDArray[np.int64], NDArray[np.int64]],
            ]
        ],
    ] = {apex: [] for apex in apex_tags}
    for face, owners in face_owners.items():
        if len(owners) != 2:
            continue
        owner_nodes = {int(tag) for owner in owners for tag in owner}
        for apex in apex_set.intersection(owner_nodes):
            shared_faces_by_apex[apex].append((face, (owners[0], owners[1])))
    return shared_faces_by_apex


@dataclass(frozen=True)
class _MixedApexFaceSideConstraint:
    first_start: float
    first_slope: float
    second_start: float
    second_slope: float
    normal_start: NDArray[np.float64]
    normal_slope: NDArray[np.float64]
    edge_starts: tuple[NDArray[np.float64], ...]
    edge_slopes: tuple[NDArray[np.float64], ...]


def _prepare_mixed_apex_face_side_constraints(
    coordinates: dict[int, NDArray[np.float64]],
    *,
    directions: dict[int, NDArray[np.float64]],
    shared_faces_by_apex: dict[
        int,
        list[
            tuple[
                tuple[int, ...],
                tuple[NDArray[np.int64], NDArray[np.int64]],
            ]
        ],
    ],
) -> dict[int, list[_MixedApexFaceSideConstraint]]:
    """Precompute affine signed-volume guards for one-dimensional apex moves."""

    constraints: dict[int, list[_MixedApexFaceSideConstraint]] = {}
    for apex, shared_faces in shared_faces_by_apex.items():
        direction = directions[apex]

        def point(tag: int, alpha: float) -> NDArray[np.float64]:
            if tag == apex:
                return coordinates[tag] + alpha * direction
            return coordinates[tag]

        apex_constraints: list[_MixedApexFaceSideConstraint] = []
        for face, owners in shared_faces:
            face_nodes = set(face)

            def face_geometry(
                alpha: float,
            ) -> tuple[NDArray[np.float64], tuple[NDArray[np.float64], ...]]:
                points = [point(tag, alpha) for tag in face]
                origin = points[0]
                normal = np.zeros(3, dtype=np.float64)
                for left in range(1, len(points) - 1):
                    trial = np.cross(points[left] - origin, points[left + 1] - origin)
                    if float(np.linalg.norm(trial)) > 0.0:
                        normal = trial
                        break
                edges = tuple(
                    right - left
                    for offset, left in enumerate(points)
                    for right in points[offset + 1 :]
                )
                return normal, edges

            def owner_determinant(owner: NDArray[np.int64], alpha: float) -> float:
                normal_area, _edges = face_geometry(alpha)
                origin = point(face[0], alpha)
                opposite = [
                    point(int(tag), alpha)
                    for tag in owner
                    if int(tag) not in face_nodes
                ]
                if not opposite:
                    return 0.0
                owner_interior = np.mean(np.asarray(opposite), axis=0)
                return float(np.dot(owner_interior - origin, normal_area))

            starts = [owner_determinant(owner, 0.0) for owner in owners]
            ends = [owner_determinant(owner, 1.0) for owner in owners]
            normal_start, edge_starts = face_geometry(0.0)
            normal_end, edge_ends = face_geometry(1.0)
            apex_constraints.append(
                _MixedApexFaceSideConstraint(
                    first_start=starts[0],
                    first_slope=ends[0] - starts[0],
                    second_start=starts[1],
                    second_slope=ends[1] - starts[1],
                    normal_start=normal_start,
                    normal_slope=normal_end - normal_start,
                    edge_starts=edge_starts,
                    edge_slopes=tuple(
                        end - start for start, end in zip(edge_starts, edge_ends, strict=True)
                    ),
                )
            )
        constraints[apex] = apex_constraints
    return constraints


def _mixed_apex_factor_preserves_face_sides(
    constraints: list[_MixedApexFaceSideConstraint],
    *,
    alpha: float,
) -> bool:
    for constraint in constraints:
        first = constraint.first_start + alpha * constraint.first_slope
        second = constraint.second_start + alpha * constraint.second_slope
        normal_norm = float(np.linalg.norm(
            constraint.normal_start + alpha * constraint.normal_slope
        ))
        if normal_norm == 0.0:
            return False
        face_scale = max(
            float(np.linalg.norm(start + alpha * slope))
            for start, slope in zip(
                constraint.edge_starts, constraint.edge_slopes, strict=True
            )
        )
        tolerance = max(
            np.finfo(np.float64).tiny,
            64.0 * np.finfo(np.float64).eps * face_scale,
        ) * normal_norm
        if abs(first) <= tolerance or abs(second) <= tolerance or first * second >= 0.0:
            return False
    return True


def _iter_mixed_apex_face_side_constraints(
    coordinates: dict[int, NDArray[np.float64]],
    *,
    directions: dict[int, NDArray[np.float64]],
    shared_faces_by_apex: dict[
        int,
        list[
            tuple[
                tuple[int, ...],
                tuple[NDArray[np.int64], NDArray[np.int64]],
            ]
        ],
    ],
) -> Iterator[tuple[int, list[_MixedApexFaceSideConstraint]]]:
    """Lazily prepare each apex guard after earlier apex moves are committed."""
    for apex in sorted(directions):
        yield apex, _prepare_mixed_apex_face_side_constraints(
            coordinates,
            directions={apex: directions[apex]},
            shared_faces_by_apex={apex: shared_faces_by_apex[apex]},
        )[apex]


def _optimize_mixed_pyramid_apices(gmsh: Any) -> float:
    """Deterministically improve pyramid p05 without degrading incident cells."""
    pyramid_tags, pyramid_nodes = gmsh.model.mesh.getElementsByType(7)
    if len(pyramid_tags) == 0:
        raise RuntimeError("mixed shared-domain realization produced no pyramid5 cells")
    pyramids = np.asarray(pyramid_nodes, dtype=np.int64).reshape((-1, 5))
    node_tags, node_coordinates, _ = gmsh.model.mesh.getNodes()
    coordinates = {
        int(tag): point
        for tag, point in zip(
            node_tags,
            np.asarray(node_coordinates, dtype=np.float64).reshape((-1, 3)),
            strict=True,
        )
    }
    apex_tags = sorted({int(tag) for tag in pyramids[:, 4]})
    original_apex_coordinates = {
        tag: np.array(coordinates[tag], copy=True) for tag in apex_tags
    }
    parametric: dict[int, list[float]] = {}
    for tag in apex_tags:
        _point, parameters, _dim, _entity = gmsh.model.mesh.getNode(tag)
        parametric[tag] = list(parameters)

    pyramids_by_apex: dict[int, list[np.ndarray]] = {}
    directions: dict[int, list[np.ndarray]] = {}
    for pyramid in pyramids:
        apex = int(pyramid[4])
        pyramids_by_apex.setdefault(apex, []).append(pyramid)
        base_center = np.mean(
            np.asarray([coordinates[int(tag)] for tag in pyramid[:4]]), axis=0
        )
        directions.setdefault(apex, []).append(coordinates[apex] - base_center)
    mean_direction = {
        apex: np.mean(np.asarray(apex_directions), axis=0)
        for apex, apex_directions in directions.items()
    }

    incident_by_apex: dict[int, list[tuple[str, np.ndarray]]] = {
        apex: [] for apex in apex_tags
    }
    apex_set = set(apex_tags)
    cells_by_family: dict[str, list[NDArray[np.int64]]] = {
        "pyramid5": [pyramid for pyramid in pyramids]
    }
    for element_type, family, arity in (
        (4, "tet4", 4),
        (6, "prism6", 6),
    ):
        element_tags, element_nodes = gmsh.model.mesh.getElementsByType(element_type)
        if len(element_tags) == 0:
            continue
        connectivity = np.asarray(element_nodes, dtype=np.int64).reshape((-1, arity))
        cells_by_family[family] = [cell for cell in connectivity]
        for cell in connectivity:
            cell_apices = sorted(apex_set.intersection(int(tag) for tag in cell))
            for apex in cell_apices:
                incident_by_apex[apex].append((family, cell))

    shared_faces_by_apex = _mixed_shared_faces_by_apex(
        cells_by_family,
        apex_tags=apex_tags,
    )

    def cell_qualities(
        family: str,
        cell: np.ndarray,
        *,
        apex: int,
        candidate: np.ndarray,
    ) -> list[float]:
        cell_coordinates = np.asarray(
            [
                candidate if int(tag) == apex else coordinates[int(tag)]
                for tag in cell
            ],
            dtype=np.float64,
        )
        return _mixed_cell_scaled_jacobians(family, cell_coordinates).tolist()

    step_count = int(
        round((MIXED_PYRAMID_APEX_SCALE_MAX - 1.0) / MIXED_PYRAMID_APEX_SCALE_STEP)
    )
    selected_factors: list[float] = []
    for apex, face_side_constraints in _iter_mixed_apex_face_side_constraints(
        coordinates,
        directions=mean_direction,
        shared_faces_by_apex=shared_faces_by_apex,
    ):
        original_incident = [
            value
            for family, cell in incident_by_apex[apex]
            for value in cell_qualities(
                family, cell, apex=apex, candidate=coordinates[apex]
            )
        ]
        incident_floor = min(
            min(original_incident, default=MIXED_SCALED_JACOBIAN_P05_MIN),
            MIXED_SCALED_JACOBIAN_P05_MIN,
        )
        best_factor = 1.0
        best_candidate = coordinates[apex]
        best_pyramid_min = min(
            value
            for pyramid in pyramids_by_apex[apex]
            for value in cell_qualities(
                "pyramid5", pyramid, apex=apex, candidate=coordinates[apex]
            )
        )
        for step in range(step_count + 1):
            factor = 1.0 + step * MIXED_PYRAMID_APEX_SCALE_STEP
            candidate = coordinates[apex] + (factor - 1.0) * mean_direction[apex]
            incident_qualities = [
                value
                for family, cell in incident_by_apex[apex]
                for value in cell_qualities(
                    family, cell, apex=apex, candidate=candidate
                )
            ]
            if any(
                value <= 0.0 or value < incident_floor
                for value in incident_qualities
            ):
                continue
            pyramid_min = min(
                value
                for pyramid in pyramids_by_apex[apex]
                for value in cell_qualities(
                    "pyramid5", pyramid, apex=apex, candidate=candidate
                )
            )
            if (
                pyramid_min <= best_pyramid_min
                and pyramid_min < MIXED_SCALED_JACOBIAN_P05_MIN
            ):
                continue
            if not _mixed_apex_factor_preserves_face_sides(
                face_side_constraints,
                alpha=factor - 1.0,
            ):
                continue
            if pyramid_min > best_pyramid_min:
                best_factor = factor
                best_candidate = candidate
                best_pyramid_min = pyramid_min
            if pyramid_min >= MIXED_SCALED_JACOBIAN_P05_MIN:
                break
        gmsh.model.mesh.setNode(
            apex, best_candidate.tolist(), parametric[apex]
        )
        coordinates[apex] = np.array(best_candidate, copy=True)
        selected_factors.append(best_factor)

    p05 = _mixed_gmsh_scaled_jacobian_p05(gmsh)
    if not p05 or any(
        value < MIXED_SCALED_JACOBIAN_P05_MIN for value in p05.values()
    ):
        for apex in sorted(mean_direction):
            gmsh.model.mesh.setNode(
                apex,
                original_apex_coordinates[apex].tolist(),
                parametric[apex],
            )
        raise RuntimeError(
            "mixed shared-domain pyramid apex optimization could not satisfy all-family "
            f"scaled-Jacobian p05 >= {MIXED_SCALED_JACOBIAN_P05_MIN}: {p05}"
        )
    emit_progress(
        "Gmsh mixed pyramid apex quality optimization: "
        f"moved={sum(factor > 1.0 for factor in selected_factors)}/{len(selected_factors)}, "
        f"max_scale={max(selected_factors):.3f}, p05={p05}"
    )
    return max(selected_factors)


def _repair_mixed_tetrahedra(gmsh: Any) -> None:
    """Repair Delaunay tetrahedra before certifying a mixed prism mesh."""
    emit_progress("Gmsh: repairing mixed-domain tetrahedra")
    gmsh.model.mesh.optimize("", niter=1)


class SweepabilityResult:
    """Result of checking whether a geometry is sweepable."""

    __slots__ = (
        "sweepable",
        "thin_axis",
        "thickness",
        "aspect_ratio",
        "reason",
    )

    def __init__(
        self,
        sweepable: bool,
        thin_axis: int | None = None,
        thickness: float | None = None,
        aspect_ratio: float | None = None,
        reason: str = "",
    ) -> None:
        self.sweepable = sweepable
        self.thin_axis = thin_axis
        self.thickness = thickness
        self.aspect_ratio = aspect_ratio
        self.reason = reason


def classify_sweepability(geometry: Geometry) -> SweepabilityResult:
    """Classify whether *geometry* can be swept-meshed.

    Currently supports:
    - ``Box`` with aspect ratio > 2 in any axis
    - ``Cylinder`` where height ≪ diameter (thin disk)

    Returns a :class:`SweepabilityResult` with diagnostics.
    """
    if isinstance(geometry, Cylinder):
        if geometry.axis != (0.0, 0.0, 1.0):
            return SweepabilityResult(
                sweepable=False,
                thin_axis=None,
                thickness=geometry.height,
                aspect_ratio=(2.0 * geometry.radius / geometry.height)
                if geometry.height > 0
                else float("inf"),
                reason="Arbitrary-axis cylinders require the OCC free-tetrahedral path",
            )
        h = geometry.height
        d = 2.0 * geometry.radius
        ar = d / h if h > 0 else float("inf")
        if ar >= 2.0:
            return SweepabilityResult(
                sweepable=True,
                thin_axis=2,  # Z axis
                thickness=h,
                aspect_ratio=ar,
                reason=f"Thin disk: diameter/height={ar:.1f}",
            )
        return SweepabilityResult(
            sweepable=False,
            thin_axis=None,
            thickness=h,
            aspect_ratio=ar,
            reason=f"Cylinder aspect ratio {ar:.1f} < 2.0; not a thin disk",
        )

    if isinstance(geometry, Box):
        sx, sy, sz = geometry.size
        dims = [sx, sy, sz]
        min_dim = min(dims)
        max_dim = max(dims)
        thin_axis = dims.index(min_dim)
        ar = max_dim / min_dim if min_dim > 0 else float("inf")
        if ar >= 2.0:
            return SweepabilityResult(
                sweepable=True,
                thin_axis=thin_axis,
                thickness=min_dim,
                aspect_ratio=ar,
                reason=f"Thin slab: axis={thin_axis}, max/min={ar:.1f}",
            )
        return SweepabilityResult(
            sweepable=False,
            thin_axis=None,
            thickness=min_dim,
            aspect_ratio=ar,
            reason=f"Box aspect ratio {ar:.1f} < 2.0; roughly cubic",
        )

    if isinstance(geometry, ArchWaveguide):
        thickness = geometry.height
        lateral_size = max(geometry.length, geometry.width, abs(geometry.arch_height) + thickness)
        ar = lateral_size / thickness if thickness > 0 else float("inf")
        if ar >= 2.0:
            return SweepabilityResult(
                sweepable=True,
                thin_axis=2,
                thickness=thickness,
                aspect_ratio=ar,
                reason=f"Thin arch waveguide: lateral/thickness={ar:.1f}",
            )
        return SweepabilityResult(
            sweepable=False,
            thin_axis=None,
            thickness=thickness,
            aspect_ratio=ar,
            reason=f"ArchWaveguide aspect ratio {ar:.1f} < 2.0; not a thin ribbon",
        )

    return SweepabilityResult(
        sweepable=False,
        reason=f"Geometry type {type(geometry).__name__} not yet supported for swept meshing",
    )


# ---------------------------------------------------------------------------
# Distribution helpers
# ---------------------------------------------------------------------------

def _compute_layer_heights(
    n_layers: int,
    total_thickness: float,
    distribution: str = DISTRIBUTION_FIXED,
    element_ratio: float = 1.0,
    symmetric: bool = False,
) -> list[float]:
    """Compute normalised layer heights for the extrusion.

    Returns a list of *n_layers* fractional heights that sum to 1.0.
    Gmsh ``extrude()`` expects cumulative normalised heights.
    """
    if n_layers < 1:
        raise ValueError("n_layers must be >= 1")

    if distribution == DISTRIBUTION_FIXED or element_ratio == 1.0:
        return [1.0 / n_layers] * n_layers

    if symmetric:
        # Mirror grading: fine at both faces, coarser in center.
        half_n = n_layers // 2
        remainder = n_layers - 2 * half_n
        half_heights = _compute_layer_heights(
            half_n, total_thickness / 2.0, distribution, element_ratio, symmetric=False,
        )
        result = half_heights[:]
        if remainder > 0:
            result.append(1.0 / n_layers)
        result.extend(reversed(half_heights))
        total = sum(result)
        return [h / total for h in result]

    if distribution == DISTRIBUTION_LINEAR:
        # Linear grading: height_i = 1 + (ratio-1) * i / (n-1)
        if n_layers == 1:
            return [1.0]
        raw = [1.0 + (element_ratio - 1.0) * i / (n_layers - 1) for i in range(n_layers)]
        total = sum(raw)
        return [h / total for h in raw]

    if distribution == DISTRIBUTION_EXPONENTIAL:
        # Geometric grading: height_i = ratio^i
        raw = [element_ratio ** i for i in range(n_layers)]
        total = sum(raw)
        return [h / total for h in raw]

    # Fallback: uniform
    return [1.0 / n_layers] * n_layers


# ---------------------------------------------------------------------------
# Swept mesh generators
# ---------------------------------------------------------------------------

def generate_swept_cylinder_mesh(
    radius: float,
    height: float,
    hmax: float,
    n_layers: int,
    *,
    order: int = 1,
    distribution: str = DISTRIBUTION_FIXED,
    element_ratio: float = 1.0,
    symmetric: bool = False,
    recombine: bool = False,
    airbox: AirboxOptions | None = None,
    options: MeshOptions | None = None,
) -> MeshData:
    """Generate a swept (extruded) mesh for a thin cylinder.

    Builds a circular disk (source face) at z = -height/2, meshes it with
    triangles (or quads if *recombine*), then extrudes upward by *height*
    with *n_layers* structured layers.

    Args:
        radius: Cylinder radius (SI metres).
        height: Cylinder height / thickness (SI metres).
        hmax: Maximum element size on the source face (SI metres).
        n_layers: Number of element layers through thickness.
        distribution: Layer spacing: "fixed", "linear", "exponential".
        element_ratio: Grading ratio for non-uniform distributions.
        symmetric: Mirror grading about the mid-plane.
        recombine: If True, use quads on source face → hexahedral elements.
        airbox: Optional airbox (currently triggers fallback to tet).
        options: Additional Gmsh options.
    """
    opts = options or MeshOptions()
    SCALE = 1e6  # m → µm

    if airbox is not None:
        emit_progress(
            "Gmsh swept: airbox requested with swept mesh — "
            "falling back to free tetrahedral for combined domain"
        )
        from ._gmsh_generators import generate_cylinder_mesh
        return generate_cylinder_mesh(
            radius, height, hmax, order=order, airbox=airbox, options=options,
        )

    layer_heights = _compute_layer_heights(
        n_layers, height, distribution, element_ratio, symmetric,
    )
    # Gmsh extrude expects cumulative normalised heights
    cumulative = []
    acc = 0.0
    for h in layer_heights:
        acc += h
        cumulative.append(acc)

    r_scaled = radius * SCALE
    h_scaled = height * SCALE
    hmax_scaled = hmax * SCALE

    emit_progress(
        f"Gmsh swept: cylinder r={radius:.2e}, h={height:.2e}, "
        f"{n_layers} layers ({distribution})"
    )

    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        _configure_gmsh_threads(gmsh)
        gmsh.model.add("fullmag_swept_cylinder")

        # Build source face at z = -h/2 as a disk via GEO kernel.
        # GEO extrude supports Layers{} and Recombine natively.
        z_bottom = -h_scaled / 2.0

        # Create a circle arc: center + 4 quarter arcs
        p_center = gmsh.model.geo.addPoint(0.0, 0.0, z_bottom, hmax_scaled)
        p_right = gmsh.model.geo.addPoint(r_scaled, 0.0, z_bottom, hmax_scaled)
        p_top = gmsh.model.geo.addPoint(0.0, r_scaled, z_bottom, hmax_scaled)
        p_left = gmsh.model.geo.addPoint(-r_scaled, 0.0, z_bottom, hmax_scaled)
        p_bot = gmsh.model.geo.addPoint(0.0, -r_scaled, z_bottom, hmax_scaled)

        arc1 = gmsh.model.geo.addCircleArc(p_right, p_center, p_top)
        arc2 = gmsh.model.geo.addCircleArc(p_top, p_center, p_left)
        arc3 = gmsh.model.geo.addCircleArc(p_left, p_center, p_bot)
        arc4 = gmsh.model.geo.addCircleArc(p_bot, p_center, p_right)

        loop = gmsh.model.geo.addCurveLoop([arc1, arc2, arc3, arc4])
        source_surf = gmsh.model.geo.addPlaneSurface([loop])

        if recombine:
            gmsh.model.geo.mesh.setRecombine(2, source_surf)

        gmsh.model.geo.synchronize()

        # Mesh the 2D source face
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", hmax_scaled)
        if opts.hmin is not None:
            gmsh.option.setNumber("Mesh.CharacteristicLengthMin", opts.hmin * SCALE)
        gmsh.option.setNumber("Mesh.Algorithm", opts.algorithm_2d)

        gmsh.model.mesh.generate(2)

        # Extrude the source face with structured layers
        num_elements_per_layer = [1] * n_layers
        extrude_result = gmsh.model.geo.extrude(
            [(2, source_surf)],
            0.0, 0.0, h_scaled,
            numElements=num_elements_per_layer,
            heights=cumulative,
            recombine=recombine,
        )
        gmsh.model.geo.synchronize()

        # Generate 3D mesh from the extrusion
        gmsh.model.mesh.generate(3)

        # Extract mesh data
        node_tags, node_coords, _ = gmsh.model.mesh.getNodes()
        nodes = np.array(node_coords, dtype=np.float64).reshape(-1, 3) / SCALE

        # Get all 3D elements (prisms = type 6, hexahedra = type 5, tetra = type 4)
        elem_types, elem_tags_list, elem_node_tags_list = gmsh.model.mesh.getElements(3)

        all_elements = []
        for etype, etags, enodes in zip(elem_types, elem_tags_list, elem_node_tags_list):
            gmsh_info = gmsh.model.mesh.getElementProperties(etype)
            nodes_per_elem = gmsh_info[3]
            elem_array = np.array(enodes, dtype=np.int64).reshape(-1, nodes_per_elem)
            all_elements.append((etype, elem_array))

        # Build node tag → index mapping
        tag_to_idx = np.zeros(int(node_tags.max()) + 1, dtype=np.int32)
        for idx, tag in enumerate(node_tags):
            tag_to_idx[int(tag)] = idx

        # Convert prisms/hexes to tetrahedra for MeshData compatibility.
        # Each prism (6 nodes) → 3 tets; each hex (8 nodes) → 5 or 6 tets.
        tet_elements: list[NDArray[np.int32]] = []
        for etype, elem_arr in all_elements:
            remapped = tag_to_idx[elem_arr.astype(np.int64)]
            if etype == 6:  # Prism: 6 nodes
                tet_elements.extend(_split_prism_to_tets(remapped))
            elif etype == 5:  # Hex: 8 nodes
                tet_elements.extend(_split_hex_to_tets(remapped))
            elif etype == 4:  # Already tetra
                tet_elements.append(remapped)

        if len(tet_elements) == 0:
            raise RuntimeError("Swept mesh produced 0 volume elements")

        elements = np.vstack(tet_elements).astype(np.int32)
        element_markers = np.ones(elements.shape[0], dtype=np.int32)

        # Extract boundary faces (triangles on the surface)
        surf_types, surf_tags_list, surf_node_tags_list = gmsh.model.mesh.getElements(2)
        boundary_faces_list: list[NDArray[np.int32]] = []
        for stype, stags, snodes in zip(surf_types, surf_tags_list, surf_node_tags_list):
            info = gmsh.model.mesh.getElementProperties(stype)
            npn = info[3]
            if npn == 3:  # triangles
                tri = np.array(snodes, dtype=np.int64).reshape(-1, 3)
                boundary_faces_list.append(tag_to_idx[tri].astype(np.int32))
            elif npn == 4:  # quads → split into 2 triangles each
                quad = np.array(snodes, dtype=np.int64).reshape(-1, 4)
                remapped = tag_to_idx[quad]
                tri_a = remapped[:, [0, 1, 2]]
                tri_b = remapped[:, [0, 2, 3]]
                boundary_faces_list.append(tri_a.astype(np.int32))
                boundary_faces_list.append(tri_b.astype(np.int32))

        if boundary_faces_list:
            boundary_faces = np.vstack(boundary_faces_list)
        else:
            boundary_faces = np.zeros((0, 3), dtype=np.int32)
        boundary_markers = np.ones(boundary_faces.shape[0], dtype=np.int32)

        quality = None
        if opts.compute_quality:
            quality = _compute_swept_quality(nodes, elements)

        emit_progress(
            f"Gmsh swept: mesh ready — {nodes.shape[0]} nodes, "
            f"{elements.shape[0]} elements ({n_layers} layers), "
            f"{boundary_faces.shape[0]} boundary faces"
        )

        periodic_boundary_pairs: list[dict[str, object]] = []
        periodic_node_pairs: list[dict[str, object]] = []
        if opts.periodic_pair_ids:
            inferred_mesh = MeshData.from_legacy_tet4(
                nodes=nodes,
                elements=elements,
                element_markers=element_markers,
                boundary_faces=boundary_faces,
                boundary_markers=boundary_markers,
                quality=quality,
            )
            all_boundary_pairs, all_node_pairs = _infer_axis_aligned_periodic_pairs(
                inferred_mesh
            )
            requested_pair_ids = set(opts.periodic_pair_ids)
            periodic_boundary_pairs = [
                pair for pair in all_boundary_pairs if pair.get("pair_id") in requested_pair_ids
            ]
            periodic_node_pairs = [
                pair for pair in all_node_pairs if pair.get("pair_id") in requested_pair_ids
            ]

        return MeshData.from_legacy_tet4(
            nodes=nodes,
            elements=elements,
            element_markers=element_markers,
            boundary_faces=boundary_faces,
            boundary_markers=boundary_markers,
            periodic_boundary_pairs=periodic_boundary_pairs,
            periodic_node_pairs=periodic_node_pairs,
            quality=quality,
        )
    finally:
        gmsh.finalize()


def generate_swept_box_mesh(
    size: tuple[float, float, float],
    hmax: float,
    n_layers: int,
    *,
    thin_axis: int = 2,
    order: int = 1,
    distribution: str = DISTRIBUTION_FIXED,
    element_ratio: float = 1.0,
    symmetric: bool = False,
    recombine: bool = False,
    airbox: AirboxOptions | None = None,
    options: MeshOptions | None = None,
) -> MeshData:
    """Generate a native ``prism6`` mesh for an axis-aligned box.

    Meshes the large cross-section face (perpendicular to *thin_axis*),
    then extrudes its triangular mesh with exactly *n_layers* structured
    layers. ``recombine`` is retained for caller compatibility; prism
    realization always recombines the triangular extrusion and never
    recombines the source face into quadrilaterals.
    """
    opts = options or MeshOptions()
    SCALE = 1e6

    for name, value in (
        ("n_layers", n_layers),
        ("order", order),
        ("thin_axis", thin_axis),
    ):
        if isinstance(value, bool) or not isinstance(value, numbers.Integral):
            raise TypeError(f"{name} must be an integer")
    n_layers = int(n_layers)
    order = int(order)
    thin_axis = int(thin_axis)
    if order != 1:
        raise ValueError(
            f"body-only swept prism meshing supports order=1; requested order={order}"
        )
    if n_layers < 1:
        raise ValueError("n_layers must be >= 1")
    if thin_axis not in (0, 1, 2):
        raise ValueError("thin_axis must be one of 0 (x), 1 (y), or 2 (z)")
    if distribution != DISTRIBUTION_FIXED or element_ratio != 1.0 or symmetric:
        raise ValueError(
            "body-only swept prism meshing currently supports only fixed distribution"
        )
    if opts.periodic_pair_ids:
        raise ValueError("body-only swept prism meshing does not support periodic pairs")
    if airbox is not None:
        if n_layers != 1:
            raise ValueError(
                "mixed shared-domain swept meshing is qualified for exactly one layer"
            )
        if str(airbox.shape).strip().lower() != "bbox":
            raise ValueError(
                "mixed shared-domain swept meshing supports only a bbox airbox"
            )
        if int(airbox.boundary_marker) == 10:
            raise ValueError("mixed shared-domain interface and outer boundary markers must be distinct")
        unsupported = []
        if opts.algorithm_2d != 6:
            unsupported.append("algorithm_2d")
        if opts.algorithm_3d != 1:
            unsupported.append("algorithm_3d")
        qualified_field_kinds = {
            "ComponentVolumeConstant",
            "InterfaceShellThreshold",
            "TransitionShellThreshold",
            "ComponentRestrictedBox",
            "EdgeDistanceThreshold",
            "CornerDistanceThreshold",
        }
        unsupported_field_kinds = sorted(
            {
                str(field.get("kind")) if isinstance(field, dict) else type(field).__name__
                for field in opts.size_fields
                if not isinstance(field, dict)
                or field.get("kind") not in qualified_field_kinds
            }
        )
        if unsupported_field_kinds:
            unsupported.append(
                "size_fields=" + ",".join(unsupported_field_kinds)
            )
        if opts.boundary_layer_count is not None:
            unsupported.append("boundary layers")
        if opts.optimize is not None:
            unsupported.append("optimizer")
        if opts.periodic_pair_ids:
            unsupported.append("periodic pairs")
        if opts.sweep_face_meshing not in (None, "triangular"):
            unsupported.append("sweep_face_meshing")
        if unsupported:
            raise ValueError(
                "mixed shared-domain strategy is not qualified for: " + ", ".join(unsupported)
            )

    try:
        sx, sy, sz = (float(value) for value in size)
    except (TypeError, ValueError) as exc:
        raise ValueError("size must contain exactly three finite positive values") from exc
    for index, value in enumerate((sx, sy, sz)):
        if not math.isfinite(value) or value <= 0.0:
            raise ValueError(f"size[{index}] must be finite and positive")
    if isinstance(hmax, bool) or not math.isfinite(float(hmax)) or float(hmax) <= 0.0:
        raise ValueError("hmax must be finite and positive")
    hmax = float(hmax)
    if opts.hmin is not None and (
        isinstance(opts.hmin, bool)
        or not math.isfinite(float(opts.hmin))
        or float(opts.hmin) <= 0.0
    ):
        raise ValueError("hmin must be finite and positive")
    dims = [sx, sy, sz]
    thickness = dims[thin_axis]

    emit_progress(
        f"Gmsh swept: box {sx:.2e}×{sy:.2e}×{sz:.2e}, "
        f"thin_axis={thin_axis}, {n_layers} layers ({distribution})"
    )

    gmsh = _import_gmsh()
    gmsh_version = str(getattr(gmsh, "__version__", "unknown"))
    if airbox is not None and gmsh_version != _MIXED_SHARED_GMSH_VERSION:
        raise RuntimeError(
            "mixed shared-domain swept meshing is qualified only for Gmsh "
            f"{_MIXED_SHARED_GMSH_VERSION}; detected {gmsh_version}"
        )
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        effective_gmsh_thread_count = _configure_gmsh_threads(
            gmsh,
            requested_threads=1 if airbox is not None else None,
            honor_environment=airbox is None,
        )
        gmsh.model.add("fullmag_swept_box")

        # Compute source-face rectangle (the two non-thin axes)
        axes = [0, 1, 2]
        face_axes = [a for a in axes if a != thin_axis]
        face_dims = [dims[a] for a in face_axes]

        # Extrusion direction vector
        extrude_dir = [0.0, 0.0, 0.0]
        extrude_dir[thin_axis] = thickness * SCALE

        # Source face origin (bottom of thin axis)
        origin = [-sx * SCALE / 2.0, -sy * SCALE / 2.0, -sz * SCALE / 2.0]

        # Build the 2D rectangle at the source face
        w = face_dims[0] * SCALE
        h = face_dims[1] * SCALE
        hmax_scaled = hmax * SCALE

        # Map face_axes to 3D coordinates
        corner = list(origin)
        p1 = gmsh.model.geo.addPoint(corner[0], corner[1], corner[2], hmax_scaled)

        corner2 = list(origin)
        corner2[face_axes[0]] += w
        p2 = gmsh.model.geo.addPoint(corner2[0], corner2[1], corner2[2], hmax_scaled)

        corner3 = list(origin)
        corner3[face_axes[0]] += w
        corner3[face_axes[1]] += h
        p3_mesh_size = hmax_scaled * (0.5 if airbox is not None else 1.0)
        p3 = gmsh.model.geo.addPoint(
            corner3[0], corner3[1], corner3[2], p3_mesh_size
        )

        corner4 = list(origin)
        corner4[face_axes[1]] += h
        p4 = gmsh.model.geo.addPoint(corner4[0], corner4[1], corner4[2], hmax_scaled)

        l1 = gmsh.model.geo.addLine(p1, p2)
        l2 = gmsh.model.geo.addLine(p2, p3)
        l3 = gmsh.model.geo.addLine(p3, p4)
        l4 = gmsh.model.geo.addLine(p4, p1)

        source_loop = [l1, l2, l3, l4]
        if airbox is not None:
            first = np.zeros(3, dtype=np.float64)
            second = np.zeros(3, dtype=np.float64)
            first[face_axes[0]] = 1.0
            second[face_axes[1]] = 1.0
            if float(np.dot(np.cross(first, second), extrude_dir)) > 0.0:
                # The inner shell must follow the frozen GEO fixture: source
                # normal opposite to extrusion, so it is a true air-volume
                # hole instead of an overlapping shell.
                source_loop = [-l4, -l3, -l2, -l1]
        loop = gmsh.model.geo.addCurveLoop(source_loop)
        source_surf = gmsh.model.geo.addPlaneSurface([loop])

        gmsh.model.geo.synchronize()

        # The source face must remain triangular. Recombining this face would
        # turn the extrusion into hex8 instead of the requested prism6 family.
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", hmax_scaled)
        if opts.hmin is not None:
            gmsh.option.setNumber("Mesh.CharacteristicLengthMin", opts.hmin * SCALE)
        gmsh.option.setNumber("Mesh.Algorithm", opts.algorithm_2d)
        source_refinement_field: int | None = None
        if airbox is not None and opts.size_fields:
            source_refinement_field = _apply_mixed_source_face_mesh_options(
                gmsh,
                source_surface=source_surf,
                hmax_scaled=hmax_scaled,
                order=order,
                opts=opts,
                hscale=SCALE,
            )
            gmsh.model.mesh.generate(2)
            gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 1)
            gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 1)
            gmsh.option.setNumber(
                "Mesh.CharacteristicLengthMax",
                (
                    float(airbox.maximum_element_size) * SCALE
                    if airbox.maximum_element_size is not None
                    else hmax_scaled
                ),
            )
        # Extrude the geometry before generating the mesh. One layer group
        # with a terminal normalized height is the documented uniform Gmsh
        # contract: exactly ``n_layers`` subdivisions ending at height 1.0.
        extrusion_entities = gmsh.model.geo.extrude(
            [(2, source_surf)],
            extrude_dir[0], extrude_dir[1], extrude_dir[2],
            numElements=[n_layers],
            heights=[1.0],
            recombine=True,
        )
        outer_size_m: tuple[float, float, float] | None = None
        transition_shell_thickness_m: float | None = None
        domain_volume_entities: tuple[int, tuple[int, ...], int] | None = None
        transition_shell_surfaces: list[int] | None = None
        airbox_grading_field: int | None = None
        air_interface_fields: list[int] = []
        if airbox is not None:
            (
                domain_volume_entities,
                _outer_surfaces,
                outer_size_m,
                transition_shell_thickness_m,
                transition_shell_surfaces,
                airbox_grading_field,
            ) = (
                _add_conforming_swept_box_airbox_geo(
                    gmsh,
                    body_size_scaled=(sx * SCALE, sy * SCALE, sz * SCALE),
                    source_surface=source_surf,
                    extrusion_entities=list(extrusion_entities),
                    airbox=airbox,
                    hmax_scaled=hmax_scaled,
                    scale=SCALE,
                )
            )
            assert domain_volume_entities is not None
            air_interface_fields = _apply_mixed_air_interface_mesh_options(
                gmsh,
                interface_surfaces=[
                    int(source_surf),
                    *[
                        int(tag)
                        for dim, tag in extrusion_entities
                        if int(dim) == 2
                    ],
                ],
                transition_air_volumes=domain_volume_entities[1],
                opts=opts,
                hscale=SCALE,
            )
        else:
            gmsh.model.geo.synchronize()
        gmsh.option.setNumber("Mesh.Algorithm3D", opts.algorithm_3d)
        gmsh.option.setNumber("Mesh.RandomFactor", 0.0)
        gmsh.option.setNumber("Mesh.ElementOrder", 1)
        active_background_fields = [
            field_id
            for field_id in (
                source_refinement_field,
                *air_interface_fields,
                airbox_grading_field,
            )
            if field_id is not None
        ]
        if len(active_background_fields) > 1:
            combined_background = gmsh.model.mesh.field.add("Min")
            gmsh.model.mesh.field.setNumbers(
                combined_background,
                "FieldsList",
                active_background_fields,
            )
            gmsh.model.mesh.field.setAsBackgroundMesh(combined_background)
        elif active_background_fields:
            gmsh.model.mesh.field.setAsBackgroundMesh(active_background_fields[0])
        with _GmshProgressLogger(gmsh):
            gmsh.model.mesh.generate(3)
        if airbox is not None:
            _repair_mixed_tetrahedra(gmsh)
            _optimize_mixed_pyramid_apices(gmsh)

        # Extract → same pipeline as cylinder
        if airbox is not None:
            raw_mesh = _extract_mesh_data(gmsh, has_physical_groups=True)
            mesh = MeshData(
                nodes=np.asarray(raw_mesh.nodes, dtype=np.float64) / SCALE,
                cell_types=raw_mesh.cell_types,
                cell_offsets=raw_mesh.cell_offsets,
                cell_nodes=raw_mesh.cell_nodes,
                element_markers=raw_mesh.element_markers,
                facet_types=raw_mesh.facet_types,
                facet_roles=raw_mesh.facet_roles,
                facet_offsets=raw_mesh.facet_offsets,
                facet_nodes=raw_mesh.facet_nodes,
                boundary_markers=raw_mesh.boundary_markers,
                cell_global_ordinals=raw_mesh.cell_global_ordinals,
                facet_global_ordinals=raw_mesh.facet_global_ordinals,
            )
            assert outer_size_m is not None
            assert transition_shell_thickness_m is not None
            assert domain_volume_entities is not None
            assert transition_shell_surfaces is not None
            transition_shell_interface_tri3_count = (
                _gmsh_require_triangular_shell_interface(
                    gmsh, transition_shell_surfaces
                )
            )
            (
                magnetic_volume,
                transition_air_volumes,
                far_air_volume,
            ) = domain_volume_entities
            cell_mesh_parts = _gmsh_cell_parts_in_extraction_order(
                gmsh,
                {
                    "magnetic": [magnetic_volume],
                    "transition_air": list(transition_air_volumes),
                    "far_air": [far_air_volume],
                },
            )
            if cell_mesh_parts.shape != (mesh.n_elements,):
                raise RuntimeError("mixed shared-domain cell mesh-part identity is incomplete")
            airbox_center_m = (
                np.zeros(3, dtype=np.float64)
                if airbox.center is None
                else np.asarray(airbox.center, dtype=np.float64)
            )
            airbox_size_array_m = np.asarray(outer_size_m, dtype=np.float64)
            return _attach_mixed_layer_topology_certificate(
                mesh,
                body_size_m=(sx, sy, sz),
                airbox_bounds_min_m=tuple(
                    float(value)
                    for value in airbox_center_m - 0.5 * airbox_size_array_m
                ),
                airbox_bounds_max_m=tuple(
                    float(value)
                    for value in airbox_center_m + 0.5 * airbox_size_array_m
                ),
                requested_axis=thin_axis,
                requested_layers=n_layers,
                gmsh_version=gmsh_version,
                cell_mesh_parts=cell_mesh_parts,
                outer_boundary_marker=int(airbox.boundary_marker),
                effective_gmsh_thread_count=effective_gmsh_thread_count,
            )
        return _extract_swept_mesh_data(
            gmsh,
            SCALE,
            requested_axis=thin_axis,
            requested_layers=n_layers,
        )
    finally:
        gmsh.finalize()


# ---------------------------------------------------------------------------
# Prism/hex → tet splitting (for MeshData compat with tet-only solver)
# ---------------------------------------------------------------------------

def _split_prism_to_tets(prisms: NDArray) -> list[NDArray[np.int32]]:
    """Split prism elements (6 nodes each) into 3 tetrahedra each.

    Gmsh prism node ordering: 0,1,2 (bottom triangle), 3,4,5 (top triangle).
    """
    n = prisms.shape[0]
    # 3 tets per prism
    t1 = prisms[:, [0, 1, 2, 3]]
    t2 = prisms[:, [1, 2, 3, 4]]
    t3 = prisms[:, [2, 3, 4, 5]]
    return [t1, t2, t3]


def _split_hex_to_tets(hexes: NDArray) -> list[NDArray[np.int32]]:
    """Split hexahedral elements (8 nodes each) into 5 tetrahedra each.

    Gmsh hex node ordering: 0-3 bottom, 4-7 top.
    Standard 5-tet decomposition.
    """
    n = hexes.shape[0]
    t1 = hexes[:, [0, 1, 3, 4]]
    t2 = hexes[:, [1, 2, 3, 6]]
    t3 = hexes[:, [3, 4, 6, 7]]
    t4 = hexes[:, [1, 4, 5, 6]]
    t5 = hexes[:, [1, 3, 4, 6]]
    return [t1, t2, t3, t4, t5]


# ---------------------------------------------------------------------------
# Internal extraction helper
# ---------------------------------------------------------------------------

def _extract_swept_mesh_data(
    gmsh: Any,
    scale: float,
    *,
    requested_axis: int,
    requested_layers: int,
) -> MeshData:
    """Extract one body-only prism mesh without a compatibility conversion."""
    mesh = _extract_mesh_data(gmsh)
    if mesh.n_elements == 0:
        raise RuntimeError("swept prism realization produced zero volume elements")
    realized_families = sorted(set(mesh.cell_types.tolist()))
    if realized_families != ["prism6"]:
        raise RuntimeError(
            "swept prism realization required prism6-only volume cells; "
            f"Gmsh produced {realized_families}"
        )
    if any(kind not in {"tri3", "quad4"} for kind in mesh.facet_types.tolist()):
        raise RuntimeError(
            "swept prism realization produced an unsupported boundary facet family"
        )

    # Gmsh 4.15 linear Prism 6 ordering is the canonical Fullmag prism6
    # ordering. ``oriented_copy`` is a fail-safe for an entity orientation
    # reversal; strict validation then proves positive mapped Jacobians.
    mesh = mesh.oriented_copy()
    mesh.validate_strict()
    nodes = np.asarray(mesh.nodes, dtype=np.float64) / scale
    resolved_layers = _count_exact_layer_planes(nodes, requested_axis) - 1
    if resolved_layers != requested_layers:
        raise RuntimeError(
            f"swept prism realization requested {requested_layers} layers "
            f"but resolved {resolved_layers}"
        )
    mesh = MeshData(
        nodes=nodes,
        cell_types=mesh.cell_types,
        cell_offsets=mesh.cell_offsets,
        cell_nodes=mesh.cell_nodes,
        element_markers=mesh.element_markers,
        facet_types=mesh.facet_types,
        facet_roles=mesh.facet_roles,
        facet_offsets=mesh.facet_offsets,
        facet_nodes=mesh.facet_nodes,
        boundary_markers=mesh.boundary_markers,
        cell_global_ordinals=mesh.cell_global_ordinals,
        facet_global_ordinals=mesh.facet_global_ordinals,
        quality=mesh.quality,
        per_domain_quality=mesh.per_domain_quality,
        realization_report=MeshRealizationReport(
            requested_topology="prism6",
            resolved_topology="prism6",
            requested_layers=requested_layers,
            resolved_layers=resolved_layers,
            requested_axis="xyz"[requested_axis],
            resolved_axis="xyz"[requested_axis],
            requested_order=1,
            resolved_order=1,
            fallbacks_triggered=(),
        ),
    )
    mesh.validate_strict()
    emit_progress(
        "Gmsh swept realization: requested topology=prism6 "
        f"axis={'xyz'[requested_axis]} layers={requested_layers} order=1; "
        f"resolved topology=prism6 axis={'xyz'[requested_axis]} "
        f"layers={requested_layers} order=1 "
        f"cells={mesh.n_elements} facets={mesh.n_boundary_faces} fallbacks=[]"
    )
    return mesh


# ---------------------------------------------------------------------------
# Quality metrics for swept mesh
# ---------------------------------------------------------------------------

def _compute_swept_quality(
    nodes: NDArray[np.float64],
    elements: NDArray[np.int32],
) -> MeshQualityReport:
    """Compute basic quality metrics for tet elements from swept mesh."""
    n_elem = elements.shape[0]
    if n_elem == 0:
        return MeshQualityReport(
            n_elements=0,
            sicn_min=0.0, sicn_max=0.0, sicn_mean=0.0, sicn_p5=0.0,
            sicn_histogram=[],
            gamma_min=0.0, gamma_mean=0.0,
            gamma_histogram=[0] * 20,
            volume_min=0.0, volume_max=0.0, volume_mean=0.0, volume_std=0.0,
            avg_quality=0.0,
            quality_source="unavailable",
        )

    # Compute volumes of tetrahedra
    v0 = nodes[elements[:, 0]]
    v1 = nodes[elements[:, 1]]
    v2 = nodes[elements[:, 2]]
    v3 = nodes[elements[:, 3]]

    e1 = v1 - v0
    e2 = v2 - v0
    e3 = v3 - v0
    volumes = np.abs(np.einsum("ij,ij->i", e1, np.cross(e2, e3))) / 6.0

    # Simple gamma (inscribed/circumscribed radius ratio) proxy:
    # Use volume-based aspect ratio as a simplified quality metric.
    # For a regular tet, gamma = 1; for degenerate, gamma → 0.
    edge_lengths = np.zeros((n_elem, 6), dtype=np.float64)
    edge_lengths[:, 0] = np.linalg.norm(v1 - v0, axis=1)
    edge_lengths[:, 1] = np.linalg.norm(v2 - v0, axis=1)
    edge_lengths[:, 2] = np.linalg.norm(v3 - v0, axis=1)
    edge_lengths[:, 3] = np.linalg.norm(v2 - v1, axis=1)
    edge_lengths[:, 4] = np.linalg.norm(v3 - v1, axis=1)
    edge_lengths[:, 5] = np.linalg.norm(v3 - v2, axis=1)

    max_edge = edge_lengths.max(axis=1)
    # Avoid division by zero
    max_edge = np.maximum(max_edge, 1e-30)
    # Normalised quality ∝ V / l_max^3 (scaled to [0,1] for regular tet)
    gamma = (6.0 * np.sqrt(2.0) * volumes) / (max_edge ** 3)
    gamma = np.clip(gamma, 0.0, 1.0)

    gamma_hist, _ = np.histogram(gamma, bins=20, range=(0.0, 1.0))

    return MeshQualityReport(
        n_elements=n_elem,
        sicn_min=0.0,
        sicn_max=0.0,
        sicn_mean=0.0,
        sicn_p5=0.0,
        sicn_histogram=[],
        gamma_min=float(gamma.min()),
        gamma_mean=float(gamma.mean()),
        gamma_histogram=[int(value) for value in gamma_hist.tolist()],
        volume_min=float(volumes.min()),
        volume_max=float(volumes.max()),
        volume_mean=float(volumes.mean()),
        volume_std=float(volumes.std()),
        avg_quality=float(gamma.mean()),
        element_gamma=[float(value) for value in gamma.tolist()],
        element_volume=[float(value) for value in volumes.tolist()],
        quality_source="swept_topology_proxy",
    )


# ---------------------------------------------------------------------------
# Public dispatch
# ---------------------------------------------------------------------------

def should_use_swept(geometry: Geometry, opts: MeshOptions) -> bool:
    """Decide whether to use swept meshing for the given geometry + options."""
    strategy = opts.mesh_strategy
    if strategy == SWEEP_STRATEGY_FREE_TET:
        return False
    if strategy in (SWEEP_STRATEGY_PRISM, SWEEP_STRATEGY_HEX):
        if isinstance(geometry, Cylinder) and geometry.axis != (0.0, 0.0, 1.0):
            raise ValueError(
                "explicit swept meshing requires a Z-axis cylinder; use free_tet for arbitrary axes"
            )
        return True
    if strategy == SWEEP_STRATEGY_AUTO or strategy is None:
        # Auto-detect: use swept if geometry is sweepable AND
        # through_thickness_elements is set
        if opts.through_thickness_elements is not None and opts.through_thickness_elements > 0:
            result = classify_sweepability(geometry)
            return result.sweepable
    return False


def generate_swept_mesh(
    geometry: Geometry,
    hmax: float,
    n_layers: int,
    *,
    order: int = 1,
    distribution: str = DISTRIBUTION_FIXED,
    element_ratio: float = 1.0,
    symmetric: bool = False,
    recombine: bool = False,
    airbox: AirboxOptions | None = None,
    options: MeshOptions | None = None,
) -> MeshData:
    """Dispatch swept mesh generation based on geometry type."""
    if options is not None and options.mesh_strategy == SWEEP_STRATEGY_HEX:
        raise ValueError(
            "explicit swept_hex realization is not implemented in the body-only prism path"
        )
    if (
        options is not None
        and options.mesh_strategy == SWEEP_STRATEGY_PRISM
        and not isinstance(geometry, Box)
    ):
        raise TypeError(
            "body-only swept prism meshing supports only axis-aligned Box geometry"
        )
    if isinstance(geometry, Cylinder):
        if geometry.axis != (0.0, 0.0, 1.0):
            raise ValueError(
                "swept cylinder meshing supports only the canonical Z axis; use OCC free tetrahedral meshing for arbitrary axes"
            )
        return generate_swept_cylinder_mesh(
            geometry.radius, geometry.height, hmax, n_layers,
            order=order, distribution=distribution,
            element_ratio=element_ratio, symmetric=symmetric,
            recombine=recombine, airbox=airbox, options=options,
        )
    if isinstance(geometry, Box):
        result = classify_sweepability(geometry)
        thin_axis = result.thin_axis if result.thin_axis is not None else 2
        return generate_swept_box_mesh(
            geometry.size, hmax, n_layers,
            thin_axis=thin_axis, order=order,
            distribution=distribution, element_ratio=element_ratio,
            symmetric=symmetric, recombine=recombine,
            airbox=airbox, options=options,
        )
    if isinstance(geometry, ArchWaveguide):
        from ._gmsh_generators import generate_mesh_from_file
        from .surface_assets import _geometry_to_trimesh, _import_trimesh

        emit_progress(
            "Gmsh swept: ArchWaveguide uses layered surface-constrained "
            "tetrahedral meshing"
        )
        with tempfile.TemporaryDirectory(prefix="fullmag-arch-waveguide-layered-") as tmp_dir:
            surface_path = Path(tmp_dir) / "arch_waveguide_layered.stl"
            trimesh = _import_trimesh()
            surface = _geometry_to_trimesh(
                geometry,
                trimesh,
                through_thickness_elements=n_layers,
                through_thickness_distribution=distribution,
                through_thickness_element_ratio=element_ratio,
                through_thickness_symmetric=symmetric,
            )
            surface.export(surface_path)
            return generate_mesh_from_file(
                surface_path,
                hmax=hmax,
                order=order,
                airbox=airbox,
                options=options,
            )
    raise TypeError(
        f"Swept meshing not supported for geometry type {type(geometry).__name__}. "
        "Use mesh_strategy='free_tetrahedral' instead."
    )
