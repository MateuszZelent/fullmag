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
import hashlib
import struct
import tempfile
from dataclasses import dataclass, replace as _dc_replace
from pathlib import Path
from typing import Any, Iterator, Literal, Mapping, Sequence

import numpy as np
from numpy.typing import NDArray

from fullmag._progress import emit_progress, indeterminate_progress_phase
from fullmag.model.geometry import (
    ArchWaveguide,
    Box,
    Cylinder,
    Difference,
    Geometry,
    Translate,
)

from ._gmsh_types import (
    AirboxOptions,
    FEM_EXACT_LAYER_PLANE_ABS_TOLERANCE_M,
    FEM_EXACT_LAYER_PLANE_REL_TOLERANCE,
    FEM_TOPOLOGY_RELATIVE_DETERMINANT_EPS,
    MeshData,
    MeshRealizationReport,
    MeshOptions,
    MeshQualityReport,
    BodyMaterialFieldV2,
    BodySeparationPairV2,
    ExactSweepEvidenceV2,
    MagneticRegionV2,
    MixedLayerTopologyCertificateV2,
    _body_material_field_digest,
    _MIXED_CELL_LOCAL_FACETS,
    _infer_axis_aligned_periodic_pairs,
    _count_exact_layer_planes,
    _cell_jacobian_determinants,
    _cell_jacobian_determinants_batch,
    _iter_cell_family_batches,
    _mixed_cell_scaled_jacobians,
    _mixed_cell_scaled_jacobians_batch,
    _mixed_reference_derivative_samples,
    _mixed_v2_deterministic_inputs,
    MIXED_PYRAMID_APEX_SCALE_MAX,
    MIXED_PYRAMID_APEX_SCALE_STEP,
    MIXED_SCALED_JACOBIAN_P05_MIN,
    MIXED_QUALITY_METRIC,
    MIXED_INTERFACE_MARKER,
    MIXED_SHARED_GEO_STRATEGY,
    _is_sha256_digest,
)
from ._gmsh_infra import (
    _quality_volumes_in_si,
    _import_gmsh,
    _configure_gmsh_threads,
    _GmshProgressLogger,
)
from ._gmsh_extraction import (
    _compact_uncertified_volume_nodes,
    _extract_mesh_data,
    _extract_quality_metrics,
    certify_extracted_periodic_mesh,
)
from ._gmsh_fields import (
    _PLANE_PROJECTED_UPPER_KINDS,
    _add_exact_plane_projected_cap_field,
    _add_surface_threshold_field,
    _apply_mesh_options,
    _apply_post_mesh_options,
    _configure_mesh_size_fields,
    _exact_plane_cap_seed_points,
)
from ._gmsh_airbox import (
    _MIXED_SHARED_GMSH_VERSION,
    _add_airbox_geo,
    _add_geo_box_surface_loop,
    _add_partitioned_transition_shell_geo,
    _add_conforming_swept_box_airbox_geo,
    _attach_mixed_layer_topology_certificate,
    _gmsh_cell_parts_in_extraction_order,
    _gmsh_cell_family_counts_for_entities,
    _gmsh_require_triangular_shell_interface,
    _mixed_transition_shell_parameters,
)
from ._airbox_grading import _add_airbox_grading_field
from ._mixed_face_incidence import MixedFaceIncidence, build_mixed_face_incidence


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

_SWEEP_AXIS_INDEX = {"x": 0, "y": 1, "z": 2}


def _reject_unresolved_sweep_selectors(options: MeshOptions | None) -> None:
    """Fail closed when authored face selectors have no typed consumer.

    The public options model still accepts ``"auto"`` for compatibility with
    the Script Builder.  Named selectors are intentionally rejected at the
    generator boundary until geometry-identity-aware face selection is
    implemented; silently ignoring them would produce a different mesh than
    the authored policy.
    """
    if options is None:
        return
    for field_name in ("sweep_source", "sweep_destination"):
        value = getattr(options, field_name)
        if value is not None and value.strip().lower() != "auto":
            raise ValueError(
                f"{field_name}={value!r} is unsupported: named sweep face selectors "
                "require a geometry-identity-aware consumer"
            )


def _resolve_sweep_axis(
    geometry: Geometry,
    *,
    options: MeshOptions | None,
    fallback_axis: int,
) -> int:
    """Resolve the typed requested sweep direction for a geometry.

    ``MeshOptions.sweep_direction`` is the single runtime input for the
    extrusion axis.  ``None``/``auto`` retain the classifier's shortest-axis
    choice; explicit axes are applied only where the generator can realise
    them and otherwise fail closed instead of silently changing direction.
    """
    requested = options.sweep_direction if options is not None else None
    if requested in (None, "auto"):
        return int(fallback_axis)
    try:
        axis = _SWEEP_AXIS_INDEX[requested]
    except (KeyError, TypeError) as exc:
        raise ValueError(
            "sweep_direction must be one of 'auto', 'x', 'y', or 'z'"
        ) from exc
    if isinstance(geometry, Cylinder) and axis != 2:
        raise ValueError(
            "swept cylinder meshing supports only sweep_direction='z'"
        )
    if isinstance(geometry, ArchWaveguide) and axis != 2:
        raise ValueError(
            "layered ArchWaveguide meshing supports only sweep_direction='z'"
        )
    return axis


_SCOPED_LAYER_PLANE_PROOF_TOKEN = object()
_SCOPED_LAYER_PLANE_PROOF_KEY = "_gmsh_layer_plane_proof"


def _clear_scoped_layer_plane_proofs(options: MeshOptions) -> None:
    """Invalidate prior mesh-attempt evidence before direct option reuse."""
    for config in [*options.size_fields, *options.lower_bound_fields]:
        if isinstance(config, dict):
            config.pop(_SCOPED_LAYER_PLANE_PROOF_KEY, None)


def _fresh_scoped_layer_plane_attempt_options(options: MeshOptions) -> MeshOptions:
    """Clone size descriptors and remove proof before planning a new attempt."""

    def _clone_descriptors(
        descriptors: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        cloned: list[dict[str, Any]] = []
        for descriptor in descriptors:
            if isinstance(descriptor, Mapping):
                entry = dict(descriptor)
                entry.pop(_SCOPED_LAYER_PLANE_PROOF_KEY, None)
                cloned.append(entry)
            else:
                cloned.append(descriptor)
        return cloned

    return _dc_replace(
        options,
        size_fields=_clone_descriptors(options.size_fields),
        lower_bound_fields=_clone_descriptors(options.lower_bound_fields),
    )


def _recertify_scaled_periodic_mesh(mesh: MeshData) -> MeshData:
    """Return immutable SI mesh with newly validated periodic evidence."""
    candidate = _dc_replace(mesh, periodic_mesh_certificate=None)
    if not candidate.periodic_boundary_pairs:
        return candidate
    certificate = certify_extracted_periodic_mesh(
        candidate.nodes,
        candidate.boundary_faces,
        candidate.boundary_markers,
        candidate.periodic_boundary_pairs,
        candidate.periodic_node_pairs,
    )
    return _dc_replace(candidate, periodic_mesh_certificate=certificate)


THIN_FILM_SCOPED_LAYER_PARTITION_UNSUPPORTED = (
    "thin_film_scoped_fields_require_exact_cell_geometric_airbox"
)
THIN_FILM_SCOPED_LAYER_PARTITION_UNSUPPORTED_REASON = (
    "scoped thin-film fields currently require the exact-cell GEO Box path and "
    "a geometric bbox airbox so requested body layer planes can be built before "
    "3D meshing"
)


def _has_component_scoped_size_fields(options: MeshOptions) -> bool:
    return bool(options.lower_bound_fields) or any(
        isinstance(config, dict)
        and isinstance(config.get("params"), dict)
        and isinstance(config["params"].get("GeometryName"), str)
        and bool(config["params"]["GeometryName"].strip())
        for config in options.size_fields
    )


def _supports_scoped_layer_partitioned_box(
    geometry: Geometry,
    *,
    airbox: AirboxOptions | None,
) -> bool:
    """Whether a Box or canonical ring supports exact GEO z-layer partitions."""
    if airbox is None or airbox.grading_mode != "geometric":
        return False
    if isinstance(geometry, Box):
        base = geometry
    else:
        components = _box_cylinder_ring_components(geometry)
        if components is None:
            return False
        base, _tool = components
    return _coincident_ring_airbox_bounds(base, airbox) is not None


def _add_source_face_lower_bound_fields(
    gmsh: Any,
    *,
    lower_bound_fields: list[dict[str, Any]],
    source_surface: int,
    hscale: float,
) -> list[int]:
    """Compile component lower bounds on a source face owned by the component."""
    field_ids: list[int] = []
    for config in lower_bound_fields:
        if not isinstance(config, dict):
            raise ValueError("mesh_lower_bound_field_invalid: config must be an object")
        params = config.get("params", {})
        if not isinstance(params, dict):
            raise ValueError("mesh_lower_bound_field_invalid: params must be an object")
        geometry_name = params.get("GeometryName")
        if not isinstance(geometry_name, str) or not geometry_name.strip():
            reason = "mesh_lower_bound_owner_binding_missing: GeometryName is required"
            config["_gmsh_status"] = "rejected"
            config["_gmsh_reason"] = reason
            raise ValueError(reason)

        size = float(params["MinimumElementSize"]) * hscale
        if not math.isfinite(size) or size <= 0.0:
            raise ValueError(
                "mesh_lower_bound_field_invalid: MinimumElementSize must be finite and positive"
            )
        kind = config.get("kind")
        if kind == "ComponentVolumeLowerBound":
            field_id = gmsh.model.mesh.field.add("Constant")
            gmsh.model.mesh.field.setNumbers(
                field_id, "SurfacesList", [source_surface]
            )
            gmsh.model.mesh.field.setNumber(field_id, "VIn", size)
            gmsh.model.mesh.field.setNumber(field_id, "VOut", 0.0)
            gmsh.model.mesh.field.setNumber(field_id, "IncludeBoundary", 1)
            field_ids.append(int(field_id))
            continue

        if kind != "ComponentRegionLowerBound":
            reason = f"mesh_lower_bound_field_unsupported: kind='{kind}'"
            config["_gmsh_status"] = "rejected"
            config["_gmsh_reason"] = reason
            raise ValueError(reason)

        shape_kind = params.get("ShapeKind")
        center = [float(value) * hscale for value in params.get("Center", [])]
        if len(center) != 3:
            raise ValueError("mesh_lower_bound_shape_unsupported: region center must be 3D")

        if shape_kind == "box":
            box_size = [float(value) * hscale for value in params.get("Size", [])]
            if len(box_size) != 3:
                raise ValueError("mesh_lower_bound_shape_unsupported: box size must be 3D")
            shape_field = gmsh.model.mesh.field.add("Box")
            gmsh.model.mesh.field.setNumber(shape_field, "VIn", size)
            gmsh.model.mesh.field.setNumber(shape_field, "VOut", 0.0)
            for axis, name in enumerate(("X", "Y", "Z")):
                half_size = 0.5 * box_size[axis]
                gmsh.model.mesh.field.setNumber(
                    shape_field, f"{name}Min", center[axis] - half_size
                )
                gmsh.model.mesh.field.setNumber(
                    shape_field, f"{name}Max", center[axis] + half_size
                )
        elif shape_kind == "cylinder":
            axis = [
                float(value) for value in params.get("Axis", [0.0, 0.0, 1.0])
            ]
            if len(axis) != 3:
                raise ValueError(
                    "mesh_lower_bound_shape_unsupported: cylinder axis must be 3D"
                )
            axis_norm = math.sqrt(sum(value * value for value in axis))
            if not math.isfinite(axis_norm) or axis_norm <= 0.0:
                raise ValueError("mesh_lower_bound_shape_unsupported: cylinder axis is zero")
            axis_unit = [value / axis_norm for value in axis]
            height = float(params["Height"]) * hscale
            half_axis = [0.5 * height * value for value in axis_unit]
            cylinder_fields: list[int] = []
            for origin, direction in (
                ([center[index] - half_axis[index] for index in range(3)], axis_unit),
                (
                    [center[index] + half_axis[index] for index in range(3)],
                    [-value for value in axis_unit],
                ),
            ):
                cylinder = gmsh.model.mesh.field.add("Cylinder")
                gmsh.model.mesh.field.setNumber(cylinder, "VIn", size)
                gmsh.model.mesh.field.setNumber(cylinder, "VOut", 0.0)
                gmsh.model.mesh.field.setNumber(
                    cylinder, "Radius", float(params["Radius"]) * hscale
                )
                gmsh.model.mesh.field.setNumber(cylinder, "XCenter", origin[0])
                gmsh.model.mesh.field.setNumber(cylinder, "YCenter", origin[1])
                gmsh.model.mesh.field.setNumber(cylinder, "ZCenter", origin[2])
                for axis_name, value in zip(("XAxis", "YAxis", "ZAxis"), direction):
                    gmsh.model.mesh.field.setNumber(
                        cylinder, axis_name, value * height
                    )
                cylinder_fields.append(int(cylinder))
            shape_field = gmsh.model.mesh.field.add("Min")
            gmsh.model.mesh.field.setNumbers(
                shape_field, "FieldsList", cylinder_fields
            )
        elif shape_kind == "sphere":
            shape_field = gmsh.model.mesh.field.add("Ball")
            gmsh.model.mesh.field.setNumber(shape_field, "VIn", size)
            gmsh.model.mesh.field.setNumber(shape_field, "VOut", 0.0)
            gmsh.model.mesh.field.setNumber(
                shape_field, "Radius", float(params["Radius"]) * hscale
            )
            gmsh.model.mesh.field.setNumber(shape_field, "XCenter", center[0])
            gmsh.model.mesh.field.setNumber(shape_field, "YCenter", center[1])
            gmsh.model.mesh.field.setNumber(shape_field, "ZCenter", center[2])
        else:
            region_id = params.get("RegionId", "<unknown>")
            reason = (
                "mesh_lower_bound_shape_unsupported: "
                f"region='{region_id}' shape_kind='{shape_kind}'"
            )
            config["_gmsh_status"] = "rejected"
            config["_gmsh_reason"] = reason
            raise ValueError(reason)

        owner_mask = gmsh.model.mesh.field.add("Constant")
        gmsh.model.mesh.field.setNumbers(
            owner_mask, "SurfacesList", [source_surface]
        )
        gmsh.model.mesh.field.setNumber(owner_mask, "VIn", 1.0)
        gmsh.model.mesh.field.setNumber(owner_mask, "VOut", 0.0)
        gmsh.model.mesh.field.setNumber(owner_mask, "IncludeBoundary", 1)
        scoped_field = gmsh.model.mesh.field.add("MathEval")
        gmsh.model.mesh.field.setString(
            scoped_field,
            "F",
            f"Min(F{shape_field}, {size:.17g}*F{owner_mask})",
        )
        field_ids.append(int(scoped_field))
    return field_ids


_SOURCE_FACE_GRADED_KINDS = frozenset(
    {
        "ComponentRestrictedGradedBox",
        "ComponentRestrictedGradedCylinder",
        "ComponentRestrictedGradedSphere",
    }
)
_SOURCE_FACE_PROJECTED_SEED_KINDS = frozenset(
    {"ComponentRestrictedBox", *_SOURCE_FACE_GRADED_KINDS}
)


def _source_face_vector(
    params: dict[str, Any],
    key: str,
    *,
    kind: str,
) -> list[float]:
    values = params.get(key)
    if not isinstance(values, (list, tuple)) or len(values) != 3:
        raise ValueError(
            f"source-face projection for {kind} requires a three-component {key}"
        )
    try:
        result = [float(value) for value in values]
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"source-face projection for {kind} requires numeric {key}"
        ) from exc
    if not all(math.isfinite(value) for value in result):
        raise ValueError(
            f"source-face projection for {kind} requires finite {key}"
        )
    return result


def _source_face_owner_matches(
    config: dict[str, Any],
    *,
    source_geometry_name: str | None,
) -> bool:
    """Validate and select a component field for the source geometry."""
    kind = str(config.get("kind"))
    params = config.get("params")
    if not isinstance(params, dict):
        raise ValueError(
            f"source-face projection for {kind} requires an object params value"
        )
    owner = params.get("GeometryName")
    if kind.startswith("ComponentRestrictedGraded"):
        if not isinstance(owner, str) or not owner.strip():
            raise ValueError(
                f"source-face projection for {kind} requires GeometryName"
            )
        if source_geometry_name is None or not source_geometry_name.strip():
            raise ValueError(
                f"source-face projection for {kind} requires the source geometry owner"
            )
    if (
        source_geometry_name is not None
        and isinstance(owner, str)
        and owner.strip()
        and owner != source_geometry_name
    ):
        return False
    return True


def _localize_source_plane_seed_descriptor(
    config: dict[str, Any],
    *,
    normal_axis: int,
    face_axes: list[int],
) -> dict[str, Any] | None:
    """Project a supported component descriptor into source-plane coordinates.

    The source face is meshed before its volume exists.  Graded component fields
    therefore use the same exact-plane footprint data as the later cap helper,
    while the full ``TransitionDistance`` descriptor remains intact for the
    volume field created after extrusion.
    """
    kind = str(config.get("kind"))
    params = config.get("params")
    if kind not in _SOURCE_FACE_PROJECTED_SEED_KINDS:
        return None
    if not isinstance(params, dict):
        raise ValueError(
            f"source-face projection for {kind} requires an object params value"
        )
    if kind == "ComponentRestrictedBox":
        try:
            bounds_min = [float(params[f"{axis}Min"]) for axis in "XYZ"]
            bounds_max = [float(params[f"{axis}Max"]) for axis in "XYZ"]
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(
                "source-face projection for ComponentRestrictedBox requires finite bounds"
            ) from exc
        if not all(
            math.isfinite(value)
            for value in (*bounds_min, *bounds_max)
        ) or any(
            bounds_max[axis] <= bounds_min[axis] for axis in range(3)
        ):
            raise ValueError(
                "source-face projection for ComponentRestrictedBox requires positive bounds"
            )
        center = [
            0.5 * (bounds_min[axis] + bounds_max[axis])
            for axis in range(3)
        ]
        size = [bounds_max[axis] - bounds_min[axis] for axis in range(3)]
        return {
            "kind": "ComponentRestrictedGradedBox",
            "params": {
                "VIn": float(params["VIn"]),
                "VOut": float(params.get("VOut", params["VIn"])),
                "Center": [
                    center[face_axes[0]],
                    center[face_axes[1]],
                    center[normal_axis],
                ],
                "Size": [
                    size[face_axes[0]],
                    size[face_axes[1]],
                    size[normal_axis],
                ],
            },
        }

    localized = dict(config)
    localized_params = dict(params)
    center = _source_face_vector(params, "Center", kind=kind)
    localized_params["Center"] = [
        center[face_axes[0]],
        center[face_axes[1]],
        center[normal_axis],
    ]
    if kind == "ComponentRestrictedGradedBox":
        size = _source_face_vector(params, "Size", kind=kind)
        if any(value <= 0.0 for value in size):
            raise ValueError(
                "source-face projection for ComponentRestrictedGradedBox requires positive Size"
            )
        localized_params["Size"] = [
            size[face_axes[0]],
            size[face_axes[1]],
            size[normal_axis],
        ]
    elif kind == "ComponentRestrictedGradedCylinder":
        axis_values = params.get("Axis", [0.0, 0.0, 1.0])
        if not isinstance(axis_values, (list, tuple)) or len(axis_values) != 3:
            raise ValueError(
                f"source-face projection for {kind} requires a three-component Axis"
            )
        axis = _source_face_vector(
            {"Axis": axis_values}, "Axis", kind=kind
        )
        axis_norm = math.sqrt(sum(value * value for value in axis))
        if axis_norm <= 0.0:
            raise ValueError(
                "source-face projection for ComponentRestrictedGradedCylinder requires a non-zero Axis"
            )
        if abs(axis[normal_axis]) / axis_norm < 1.0 - 1.0e-9:
            raise ValueError(
                "source-face projection for ComponentRestrictedGradedCylinder requires an axis parallel to the source-face normal"
            )
        localized_params["Axis"] = [
            axis[face_axes[0]],
            axis[face_axes[1]],
            axis[normal_axis],
        ]
    elif kind == "ComponentRestrictedGradedSphere":
        radius = float(params.get("Radius"))
        if not math.isfinite(radius) or radius <= 0.0:
            raise ValueError(
                "source-face projection for ComponentRestrictedGradedSphere requires a positive Radius"
            )
    localized["params"] = localized_params
    return localized


def _localize_source_plane_lower_bound(
    config: dict[str, Any],
    *,
    normal_axis: int,
    face_axes: list[int],
) -> dict[str, Any]:
    """Copy a lower-bound descriptor with its shape axes in plane order."""
    localized = dict(config)
    params = config.get("params")
    if not isinstance(params, dict):
        return localized
    localized_params = dict(params)
    for key in ("Center", "Size", "Axis"):
        values = params.get(key)
        if isinstance(values, (list, tuple)) and len(values) == 3:
            values_float = [float(value) for value in values]
            localized_params[key] = [
                values_float[face_axes[0]],
                values_float[face_axes[1]],
                values_float[normal_axis],
            ]
    localized["params"] = localized_params
    return localized


def _embed_mixed_source_face_seed_points(
    gmsh: Any,
    *,
    source_surface: int,
    opts: MeshOptions,
    hscale: float,
    source_geometry_name: str | None,
) -> None:
    """Embed exact-plane targets for component fields before extrusion.

    Component volume fields cannot be constructed until GEO extrusion has
    created owner volumes.  The source face still needs deterministic 2-D
    seeds, however, so graded box/cylinder/sphere footprints are localized to
    the source plane and embedded after the CSG ``isInside`` check.  The full
    graded descriptors (including ``TransitionDistance``) are applied later to
    the owner volumes.
    """
    projected_configs = [
        config
        for config in opts.size_fields
        if isinstance(config, dict)
        and config.get("kind") in _SOURCE_FACE_PROJECTED_SEED_KINDS
        and _source_face_owner_matches(
            config, source_geometry_name=source_geometry_name
        )
    ]
    if not projected_configs:
        return

    raw_bbox = gmsh.model.getBoundingBox(2, int(source_surface))
    try:
        bbox = tuple(float(value) for value in raw_bbox)
    except (TypeError, ValueError) as exc:
        raise RuntimeError(
            "mixed source-face seed embedding received a non-numeric "
            "source-surface bounding-box"
        ) from exc
    if len(bbox) != 6:
        raise RuntimeError(
            "mixed source-face seed embedding requires six source-surface "
            f"bounding-box values, got {len(bbox)}"
        )
    if not all(math.isfinite(value) for value in bbox):
        raise RuntimeError(
            "mixed source-face seed embedding requires finite source-surface "
            "bounding-box values"
        )
    if any(bbox[3 + axis] < bbox[axis] for axis in range(3)):
        raise RuntimeError(
            "mixed source-face seed embedding received inverted source-surface "
            "bounding-box bounds"
        )
    if not math.isfinite(hscale) or hscale <= 0.0:
        raise ValueError("mixed source-face seed embedding requires a positive hscale")

    spans = [bbox[3 + axis] - bbox[axis] for axis in range(3)]
    normal_axis = min(range(3), key=lambda axis: spans[axis])
    face_axes = [axis for axis in range(3) if axis != normal_axis]
    normal_span_si = spans[normal_axis] / hscale
    normal_si = 0.5 * (bbox[normal_axis] + bbox[3 + normal_axis]) / hscale
    normal_tolerance = max(1.0e-15, 1.0e-9 * max(normal_span_si, 1.0e-12))

    upper_descriptors: list[dict[str, Any]] = []
    for config in projected_configs:
        localized = _localize_source_plane_seed_descriptor(
            config,
            normal_axis=normal_axis,
            face_axes=face_axes,
        )
        if localized is None:
            continue
        params = localized.get("params")
        if not isinstance(params, dict):
            continue
        if localized["kind"] == "ComponentRestrictedGradedBox":
            center = _source_face_vector(
                params, "Center", kind=str(localized["kind"])
            )
            size = _source_face_vector(
                params, "Size", kind=str(localized["kind"])
            )
            if (
                normal_si < center[2] - 0.5 * size[2] - normal_tolerance
                or normal_si > center[2] + 0.5 * size[2] + normal_tolerance
            ):
                continue
        upper_descriptors.append(localized)
    if not upper_descriptors:
        return

    lower_descriptors = []
    for config in opts.lower_bound_fields:
        if not isinstance(config, dict):
            continue
        params = config.get("params")
        if not isinstance(params, dict):
            continue
        owner = params.get("GeometryName")
        if not isinstance(owner, str) or not owner.strip():
            continue
        if source_geometry_name is not None and owner != source_geometry_name:
            continue
        lower_descriptors.append(
            _localize_source_plane_lower_bound(
                config,
                normal_axis=normal_axis,
                face_axes=face_axes,
            )
        )
    bounds_xy = (
        bbox[face_axes[0]] / hscale,
        bbox[face_axes[1]] / hscale,
        bbox[3 + face_axes[0]] / hscale,
        bbox[3 + face_axes[1]] / hscale,
    )
    seed_points = _exact_plane_cap_seed_points(
        size_fields=upper_descriptors,
        lower_bound_fields=lower_descriptors,
        layer_planes=[normal_si],
        bounds_xy=bounds_xy,
    )
    is_inside = getattr(gmsh.model, "isInside", None)
    if not callable(is_inside):
        raise RuntimeError(
            "mixed source-face seed embedding requires Gmsh model.isInside"
        )
    embedded: list[int] = []
    for x, y, mesh_size in seed_points:
        point = [0.0, 0.0, 0.0]
        point[face_axes[0]] = x * hscale
        point[face_axes[1]] = y * hscale
        point[normal_axis] = normal_si * hscale
        if int(is_inside(2, int(source_surface), point)) != 1:
            continue
        embedded.append(
            int(gmsh.model.geo.addPoint(*point, float(mesh_size) * hscale))
        )
    if not embedded:
        return
    gmsh.model.geo.synchronize()
    gmsh.model.mesh.embed(0, embedded, 2, int(source_surface))


def _apply_mixed_source_face_mesh_options(
    gmsh: Any,
    *,
    source_surface: int,
    hmax_scaled: float,
    order: int,
    opts: MeshOptions,
    hscale: float,
    source_geometry_name: str | None = None,
) -> int:
    """Apply canonical film sizing only to the pre-extrusion source face."""
    source_field_ids: list[int] = []
    generic_fields: list[dict[str, Any]] = []
    geometry_names: set[str] = set()
    has_projected_source_field = False
    for config in opts.size_fields:
        params = config.get("params") if isinstance(config, dict) else None
        if not isinstance(params, dict):
            generic_fields.append(config)
            continue
        geometry_name = params.get("GeometryName")
        if isinstance(geometry_name, str):
            geometry_names.add(geometry_name)
        kind = config.get("kind")
        if kind in _SOURCE_FACE_GRADED_KINDS:
            _source_face_owner_matches(
                config, source_geometry_name=source_geometry_name
            )
            has_projected_source_field = True
            # These fields require owner volumes and are realized after GEO
            # extrusion.  Their exact source-plane footprints are embedded by
            # _embed_mixed_source_face_seed_points below.
            continue
        if kind == "ComponentVolumeConstant":
            if (
                source_geometry_name is not None
                and isinstance(geometry_name, str)
                and geometry_name != source_geometry_name
            ):
                generic_fields.append(config)
                continue
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
            if (
                source_geometry_name is not None
                and isinstance(geometry_name, str)
                and geometry_name != source_geometry_name
            ):
                generic_fields.append(config)
                continue
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

    source_lower_bound_fields: list[dict[str, Any]] = []
    for config in opts.lower_bound_fields:
        params = config.get("params") if isinstance(config, dict) else None
        if not isinstance(params, dict):
            raise ValueError("mesh_lower_bound_field_invalid: params must be an object")
        geometry_name = params.get("GeometryName")
        if not isinstance(geometry_name, str) or not geometry_name.strip():
            # A component lower bound has no safe global source-face meaning.
            # The post-extrusion owner validator remains responsible for the
            # definitive rejection; do not leak an unowned floor onto this cap.
            continue
        if source_geometry_name is not None and geometry_name != source_geometry_name:
            continue
        geometry_names.add(geometry_name)
        source_lower_bound_fields.append(config)
    source_lower_bound_ids = _add_source_face_lower_bound_fields(
        gmsh,
        lower_bound_fields=source_lower_bound_fields,
        source_surface=source_surface,
        hscale=hscale,
    )
    if (
        (source_lower_bound_ids and not source_field_ids and not generic_fields)
        or (has_projected_source_field and not source_field_ids and not generic_fields)
    ):
        # _apply_mesh_options receives Gmsh-scaled hmax here. Supply its base
        # upper target directly instead of asking its SI lower-only fallback
        # to scale that already-scaled value a second time.  Graded component
        # fields are installed after extrusion; this neutral cap only keeps
        # the pre-extrusion 2-D source face bounded while embedded exact-plane
        # seeds carry the local VIn target.
        source_default = gmsh.model.mesh.field.add("Constant")
        gmsh.model.mesh.field.setNumbers(
            source_default, "SurfacesList", [source_surface]
        )
        gmsh.model.mesh.field.setNumber(source_default, "VIn", hmax_scaled)
        gmsh.model.mesh.field.setNumber(source_default, "VOut", hmax_scaled)
        gmsh.model.mesh.field.setNumber(source_default, "IncludeBoundary", 1)
        source_field_ids.append(int(source_default))

    _apply_mesh_options(
        gmsh,
        hmax_scaled,
        order,
        _dc_replace(opts, size_fields=generic_fields, lower_bound_fields=[]),
        hscale=hscale,
        preexisting_field_ids=source_field_ids,
        preexisting_lower_bound_field_ids=source_lower_bound_ids,
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
    _embed_mixed_source_face_seed_points(
        gmsh,
        source_surface=source_surface,
        opts=opts,
        hscale=hscale,
        source_geometry_name=source_geometry_name,
    )
    return int(restricted)


def _add_swept_exact_plane_cap_field(
    gmsh: Any,
    *,
    opts: MeshOptions,
    geometry_name: str | None,
    body_volumes: list[int],
    source_z: float,
    thickness: float,
    n_layers: int,
    neutral_size: float,
    hscale: float,
    sweep_axis: int = 2,
) -> int | None:
    """Project scoped upper/lower targets onto every exact swept layer plane."""
    projected_fields = [
        config
        for config in opts.size_fields
        if isinstance(config, dict)
        and config.get("kind") in _PLANE_PROJECTED_UPPER_KINDS
    ]
    if not projected_fields:
        return None
    owned_projected_fields = [
        config
        for config in projected_fields
        if isinstance(config.get("params"), dict)
        and isinstance(config["params"].get("GeometryName"), str)
        and config["params"]["GeometryName"].strip()
    ]
    if not owned_projected_fields:
        # An unowned generic Box remains a source-face field only; it has no
        # safe volume-cap projection target.
        return None
    if not isinstance(geometry_name, str) or not geometry_name.strip():
        raise ValueError(
            "exact source-plane projection requires the component geometry owner"
        )
    if not body_volumes:
        raise ValueError(
            "exact source-plane projection requires exact component volumes"
        )
    if n_layers < 1 or not math.isfinite(thickness) or thickness <= 0.0:
        raise ValueError(
            "exact source-plane projection requires positive layer geometry"
        )
    if int(sweep_axis) != 2:
        raise ValueError(
            "exact source-plane projection currently requires a z-directed sweep"
        )
    owner_fields = [
        config
        for config in owned_projected_fields
        if config["params"].get("GeometryName") == geometry_name
    ]
    if not owner_fields:
        return None
    owner_lower = [
        config
        for config in opts.lower_bound_fields
        if isinstance(config, dict)
        and isinstance(config.get("params"), dict)
        and config["params"].get("GeometryName") == geometry_name
    ]
    layer_planes = [
        float(source_z) + float(thickness) * index / int(n_layers)
        for index in range(int(n_layers) + 1)
    ]
    return _add_exact_plane_projected_cap_field(
        gmsh,
        size_fields=owner_fields,
        lower_bound_fields=owner_lower,
        layer_planes=layer_planes,
        source_z=float(source_z),
        neutral_size=float(neutral_size),
        geometry_name=geometry_name,
        cap_volume_tags=body_volumes,
        hscale=hscale,
    )


def _reapply_periodic_surface_mappings(
    gmsh: Any,
    periodic_specs: list[dict[str, object]],
) -> None:
    """Reattach periodic maps after a multi-step GEO extrusion.

    Gmsh accepts the periodic declarations before generation, but a sequence
    of GEO extrusions can replace the boundary mesh entities while building
    the final 3-D mesh. Reapplying the same affine maps after generation
    makes the correspondence observable through ``getPeriodicNodes`` without
    changing the authored surface pairing.
    """
    for spec in periodic_specs:
        translation = [
            float(value)
            for value in spec.get("translation", (0.0, 0.0, 0.0))
        ]
        if len(translation) != 3:
            raise ValueError("periodic surface translation must contain three values")
        affine = [
            1.0,
            0.0,
            0.0,
            translation[0],
            0.0,
            1.0,
            0.0,
            translation[1],
            0.0,
            0.0,
            1.0,
            translation[2],
            0.0,
            0.0,
            0.0,
            1.0,
        ]
        gmsh.model.mesh.setPeriodic(  # type: ignore[attr-defined]
            2,
            [int(spec["slave_tag"])],
            [int(spec["master_tag"])],
            affine,
        )


def _set_mixed_volume_mesh_size_options(
    gmsh: Any,
    *,
    maximum_element_size_scaled: float,
) -> None:
    gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 1)
    gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
    gmsh.option.setNumber(
        "Mesh.CharacteristicLengthMax",
        maximum_element_size_scaled,
    )


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
    """Compute all-family p05 quality without a Python loop per element.

    The apex line-search calls this once after every mixed-domain mesh.  The
    old implementation performed a dictionary lookup, array allocation, and
    several NumPy calls for each of hundreds of thousands of cells.  Resolve
    Gmsh tags to a dense coordinate array once and evaluate each family in
    bounded vectorized batches instead.
    """
    node_tags, coordinates, _ = gmsh.model.mesh.getNodes()
    node_tags_array = np.asarray(node_tags, dtype=np.int64)
    node_coordinates = np.asarray(coordinates, dtype=np.float64).reshape((-1, 3))
    if node_tags_array.shape != (len(node_coordinates),):
        raise RuntimeError("mixed Gmsh node tags and coordinates have inconsistent lengths")
    order = np.argsort(node_tags_array)
    sorted_tags = node_tags_array[order]
    sorted_coordinates = node_coordinates[order]
    values: dict[str, list[np.ndarray]] = {}
    batch_size = 65_536
    for element_type, family, arity in (
        (4, "tet4", 4),
        (6, "prism6", 6),
        (7, "pyramid5", 5),
    ):
        element_tags, element_nodes = gmsh.model.mesh.getElementsByType(element_type)
        if len(element_tags) == 0:
            continue
        connectivity = np.asarray(element_nodes, dtype=np.int64).reshape((-1, arity))
        family_values: list[np.ndarray] = []
        for start in range(0, len(connectivity), batch_size):
            batch = connectivity[start : start + batch_size]
            positions = np.searchsorted(sorted_tags, batch)
            if np.any(positions >= len(sorted_tags)) or not np.array_equal(
                sorted_tags[positions], batch
            ):
                raise RuntimeError("mixed Gmsh connectivity references an unknown node")
            points = sorted_coordinates[positions]
            derivatives = _mixed_reference_derivative_samples(family)
            jacobians = np.einsum(
                "bnp,snr->bspr", points, derivatives, optimize=True
            )
            denominator = np.prod(np.linalg.norm(jacobians, axis=2), axis=2)
            determinants = np.abs(np.linalg.det(jacobians))
            family_values.append(
                np.divide(
                    determinants,
                    denominator,
                    out=np.zeros_like(determinants),
                    where=denominator > 0.0,
                ).reshape(-1)
            )
        values[family] = family_values
    return {
        family: float(np.percentile(np.concatenate(family_values), 5.0))
        for family, family_values in sorted(values.items())
    }


@dataclass(frozen=True)
class _MixedTetDegeneracyReport:
    element_tags: frozenset[int]
    worst_element_tag: int | None
    worst_determinant: float | None
    worst_threshold: float | None


def _mixed_tet_degeneracy_report(
    gmsh: Any,
    *,
    element_tags: frozenset[int] | None = None,
    use_global_scale: bool = False,
) -> _MixedTetDegeneracyReport:
    """Return strict tet4 degeneracies without extracting the complete mesh."""
    gmsh_element_tags, element_nodes = gmsh.model.mesh.getElementsByType(4)
    tags = np.asarray(gmsh_element_tags, dtype=np.int64)
    if tags.size == 0:
        return _MixedTetDegeneracyReport(frozenset(), None, None, None)
    connectivity = np.asarray(element_nodes, dtype=np.int64).reshape((-1, 4))
    if element_tags is not None:
        selected = np.isin(tags, np.asarray(sorted(element_tags), dtype=np.int64))
        tags = tags[selected]
        connectivity = connectivity[selected]
        if tags.size == 0:
            return _MixedTetDegeneracyReport(frozenset(), None, None, None)
    node_tags, node_coordinates, _ = gmsh.model.mesh.getNodes()
    node_tags_array = np.asarray(node_tags, dtype=np.int64)
    coordinates = np.asarray(node_coordinates, dtype=np.float64).reshape((-1, 3))
    global_threshold = (
        _mixed_tet_global_determinant_threshold(coordinates)
        if use_global_scale
        else None
    )
    order = np.argsort(node_tags_array)
    sorted_tags = node_tags_array[order]
    degenerate_tags: set[int] = set()
    worst_tag: int | None = None
    worst_determinant: float | None = None
    worst_threshold: float | None = None
    worst_margin = math.inf
    chunk_size = 65_536
    for start in range(0, len(tags), chunk_size):
        stop = min(start + chunk_size, len(tags))
        chunk_connectivity = connectivity[start:stop]
        positions = np.searchsorted(sorted_tags, chunk_connectivity)
        if np.any(positions >= len(sorted_tags)) or not np.array_equal(
            sorted_tags[positions], chunk_connectivity
        ):
            raise RuntimeError("mixed tet4 connectivity references an unknown Gmsh node")
        points = coordinates[order[positions]]
        matrices = np.stack(
            (
                points[:, 1] - points[:, 0],
                points[:, 2] - points[:, 0],
                points[:, 3] - points[:, 0],
            ),
            axis=2,
        )
        determinants = np.abs(np.linalg.det(matrices))
        pairwise = points[:, :, np.newaxis, :] - points[:, np.newaxis, :, :]
        characteristic_lengths = np.max(np.linalg.norm(pairwise, axis=3), axis=(1, 2))
        thresholds = (
            np.full_like(determinants, global_threshold)
            if global_threshold is not None
            else np.maximum(
                np.finfo(np.float64).tiny,
                FEM_TOPOLOGY_RELATIVE_DETERMINANT_EPS * characteristic_lengths**3,
            )
        )
        invalid = determinants <= thresholds
        if not np.any(invalid):
            continue
        invalid_indices = np.flatnonzero(invalid)
        degenerate_tags.update(int(tags[start + index]) for index in invalid_indices)
        margins = determinants[invalid_indices] / thresholds[invalid_indices]
        local = int(invalid_indices[int(np.argmin(margins))])
        local_margin = float(determinants[local] / thresholds[local])
        if local_margin < worst_margin:
            worst_margin = local_margin
            worst_tag = int(tags[start + local])
            worst_determinant = float(determinants[local])
            worst_threshold = float(thresholds[local])
    return _MixedTetDegeneracyReport(
        frozenset(degenerate_tags),
        worst_tag,
        worst_determinant,
        worst_threshold,
    )


def _mixed_tet_global_determinant_threshold(
    node_coordinates: NDArray[np.float64],
) -> float | None:
    """Return the determinant threshold used by the native mixed-mesh gate."""
    coordinates = np.asarray(node_coordinates, dtype=np.float64).reshape((-1, 3))
    if coordinates.size == 0:
        return None
    global_scale = float(np.max(np.ptp(coordinates, axis=0)))
    return max(np.finfo(np.float64).tiny, 6.0e-18 * global_scale**3)


_MIXED_TET_LOCAL_REPAIR_RELATIVE_STEPS = (
    1.0e-6,
    3.0e-6,
    1.0e-5,
    3.0e-5,
    1.0e-4,
)
_MIXED_TET_LOCAL_REPAIR_MAX_PASSES = 8
_MIXED_TET_LOCAL_REPAIR_ALLOWED_QUALITY_DROP = 0.05


def _mixed_tet_local_quality(
    coordinates: NDArray[np.float64],
    *,
    determinant_threshold: float | None = None,
) -> tuple[float, float, float]:
    """Return signed determinant, strict threshold, and scaled quality."""
    matrix = np.stack(
        (
            coordinates[1] - coordinates[0],
            coordinates[2] - coordinates[0],
            coordinates[3] - coordinates[0],
        ),
        axis=1,
    )
    determinant = float(np.linalg.det(matrix))
    characteristic = float(
        np.max(
            np.linalg.norm(
                coordinates[:, np.newaxis, :] - coordinates[np.newaxis, :, :],
                axis=2,
            )
        )
    )
    threshold = (
        max(
            np.finfo(np.float64).tiny,
            FEM_TOPOLOGY_RELATIVE_DETERMINANT_EPS * characteristic**3,
        )
        if determinant_threshold is None
        else float(determinant_threshold)
    )
    denominator = float(np.prod(np.linalg.norm(matrix, axis=0)))
    quality = abs(determinant) / denominator if denominator > 0.0 else 0.0
    return determinant, threshold, quality


def _mixed_tet_local_repair_directions(
    coordinates: dict[int, NDArray[np.float64]],
    cell: NDArray[np.int64],
    node_tag: int,
    incident_cells: NDArray[np.int64],
) -> list[NDArray[np.float64]]:
    """Build deterministic directions for one interior transition node."""
    directions: list[NDArray[np.float64]] = []
    for axis in range(3):
        direction = np.zeros(3, dtype=np.float64)
        direction[axis] = 1.0
        directions.extend((direction, -direction))

    opposite = np.asarray(
        [coordinates[int(tag)] for tag in cell if int(tag) != node_tag],
        dtype=np.float64,
    )
    if opposite.shape == (3, 3):
        normal = np.cross(opposite[1] - opposite[0], opposite[2] - opposite[0])
        normal_length = float(np.linalg.norm(normal))
        if normal_length > 0.0 and math.isfinite(normal_length):
            normal = normal / normal_length
            directions.extend((normal, -normal))

    neighbours = np.asarray(
        [
            coordinates[int(tag)]
            for incident_cell in incident_cells
            for tag in incident_cell
            if int(tag) != node_tag
        ],
        dtype=np.float64,
    )
    if len(neighbours):
        local = np.mean(neighbours, axis=0) - coordinates[node_tag]
        local_length = float(np.linalg.norm(local))
        if local_length > 0.0 and math.isfinite(local_length):
            local = local / local_length
            directions.extend((local, -local))

    unique: list[NDArray[np.float64]] = []
    for direction in directions:
        length = float(np.linalg.norm(direction))
        if length == 0.0 or not math.isfinite(length):
            continue
        normalized = direction / length
        if not any(
            np.allclose(normalized, previous, rtol=0.0, atol=1.0e-14)
            for previous in unique
        ):
            unique.append(normalized)
    return unique


def _mixed_gmsh_node_metadata(
    gmsh: Any,
    node_tag: int,
) -> tuple[list[float], int] | None:
    """Return parametric coordinates and entity dimension for one Gmsh node."""
    try:
        _point, parameters, dimension, _entity = gmsh.model.mesh.getNode(node_tag)
        return list(parameters), int(dimension)
    except (AttributeError, IndexError, TypeError, ValueError):
        # Small test doubles and older Gmsh bindings may not expose node
        # ownership metadata.  In that case the bounded local pass simply
        # declines the node and the configured Gmsh policy remains available.
        return None


def _repair_remaining_mixed_tet_slivers(
    gmsh: Any,
    *,
    initial_report: _MixedTetDegeneracyReport | None = None,
) -> bool:
    """Repair residual slivers with a bounded local interior-node move.

    ``initial_report`` may be supplied by a caller that has already scanned
    the current mesh; subsequent passes still rescan after every accepted
    move. This fallback considers only volume nodes of the offending tet,
    checks every incident tet, preserves their orientation and rejects any
    candidate that lowers a healthy neighbour's scaled quality by more than
    five percent.
    The boolean result tells the caller whether at least one node moved; a
    caller may still select a slower global qualification method if residual
    degeneracies remain.
    """
    moved_any = False
    first_report = initial_report
    for _pass in range(_MIXED_TET_LOCAL_REPAIR_MAX_PASSES):
        report = (
            first_report
            if first_report is not None
            else _mixed_tet_degeneracy_report(gmsh, use_global_scale=True)
        )
        first_report = None
        if not report.element_tags:
            return moved_any
        element_tags, element_nodes = gmsh.model.mesh.getElementsByType(4)
        tags = np.asarray(element_tags, dtype=np.int64)
        connectivity = np.asarray(element_nodes, dtype=np.int64).reshape((-1, 4))
        node_tags, node_coordinates, _ = gmsh.model.mesh.getNodes()
        coordinates = {
            int(tag): np.array(point, dtype=np.float64, copy=True)
            for tag, point in zip(
                node_tags,
                np.asarray(node_coordinates, dtype=np.float64).reshape((-1, 3)),
                strict=True,
            )
        }
        global_threshold = _mixed_tet_global_determinant_threshold(node_coordinates)
        if global_threshold is None:
            raise RuntimeError(
                "mixed local tet repair could not determine a global threshold"
            )
        moved = False
        for bad_tag in sorted(report.element_tags):
            bad_indices = np.flatnonzero(tags == bad_tag)
            if len(bad_indices) != 1:
                continue
            bad_cell = connectivity[int(bad_indices[0])]
            movable_nodes: list[int] = []
            for tag in bad_cell:
                metadata = _mixed_gmsh_node_metadata(gmsh, int(tag))
                if metadata is not None and metadata[1] == 3:
                    movable_nodes.append(int(tag))
            if not movable_nodes:
                continue
            best: tuple[float, float, int, int, NDArray[np.float64]] | None = None
            for node_tag in sorted(movable_nodes):
                incident_cells = connectivity[
                    np.any(connectivity == node_tag, axis=1)
                ]
                baseline: list[tuple[float, float, float]] = []
                for incident_cell in incident_cells:
                    baseline.append(
                        _mixed_tet_local_quality(
                            np.asarray(
                                [coordinates[int(tag)] for tag in incident_cell],
                                dtype=np.float64,
                            ),
                            determinant_threshold=global_threshold,
                        )
                    )
                bad_points = np.asarray(
                    [coordinates[int(tag)] for tag in bad_cell],
                    dtype=np.float64,
                )
                characteristic = float(
                    np.max(
                        np.linalg.norm(
                            bad_points[:, np.newaxis, :]
                            - bad_points[np.newaxis, :, :],
                            axis=2,
                        )
                    )
                )
                if characteristic <= 0.0 or not math.isfinite(characteristic):
                    continue
                metadata = _mixed_gmsh_node_metadata(gmsh, node_tag)
                if metadata is None:
                    continue
                parameters, _dimension = metadata
                original = coordinates[node_tag]
                for relative_step in _MIXED_TET_LOCAL_REPAIR_RELATIVE_STEPS:
                    displacement = characteristic * relative_step
                    for direction_index, direction in enumerate(
                        _mixed_tet_local_repair_directions(
                            coordinates,
                            bad_cell,
                            node_tag,
                            incident_cells,
                        )
                    ):
                        candidate = original + displacement * direction
                        candidate_quality: list[float] = []
                        valid = True
                        for base, incident_cell in zip(
                            baseline, incident_cells, strict=True
                        ):
                            points = np.asarray(
                                [
                                    candidate
                                    if int(tag) == node_tag
                                    else coordinates[int(tag)]
                                    for tag in incident_cell
                                ],
                                dtype=np.float64,
                            )
                            determinant, threshold, quality = _mixed_tet_local_quality(
                                points,
                                determinant_threshold=global_threshold,
                            )
                            if (
                                not math.isfinite(determinant)
                                or abs(determinant) <= threshold
                            ):
                                valid = False
                                break
                            base_determinant, base_threshold, base_quality = base
                            if (
                                abs(base_determinant) > base_threshold
                                and determinant * base_determinant <= 0.0
                            ):
                                valid = False
                                break
                            if (
                                base_quality > 0.0
                                and quality
                                < base_quality
                                * (1.0 - _MIXED_TET_LOCAL_REPAIR_ALLOWED_QUALITY_DROP)
                            ):
                                valid = False
                                break
                            candidate_quality.append(quality)
                        if not valid:
                            continue
                        score = min(candidate_quality)
                        candidate_key = (
                            relative_step,
                            -score,
                            direction_index,
                            node_tag,
                            candidate,
                        )
                        if best is None or candidate_key[:4] < best[:4]:
                            best = candidate_key
                if best is not None and best[0] == _MIXED_TET_LOCAL_REPAIR_RELATIVE_STEPS[0]:
                    # The smallest accepted movement is preferred globally;
                    # there is no reason to inspect larger steps for another
                    # node once this one already repairs the sliver.
                    break
            if best is None:
                continue
            (
                _relative_step,
                _negative_quality,
                _direction_index,
                node_tag,
                candidate,
            ) = best
            metadata = _mixed_gmsh_node_metadata(gmsh, node_tag)
            if metadata is None:
                continue
            parameters, _dimension = metadata
            gmsh.model.mesh.setNode(node_tag, candidate.tolist(), parameters)
            coordinates[node_tag] = np.array(candidate, copy=True)
            moved = True
            moved_any = True
            emit_progress(
                "Gmsh mixed local tet repair: "
                f"element={bad_tag} node={node_tag} "
                f"relative_step={_relative_step:.1e}"
            )
        if not moved:
            break
    return moved_any


def _mixed_cell_has_degenerate_jacobian(
    family: str,
    coordinates: NDArray[np.float64],
    *,
    determinant_threshold: float | None = None,
) -> bool:
    determinants = _cell_jacobian_determinants(family, coordinates)
    if determinant_threshold is None:
        characteristic_length = float(
            np.max(
                np.linalg.norm(
                    coordinates[:, np.newaxis, :] - coordinates[np.newaxis, :, :],
                    axis=2,
                )
            )
        )
        threshold = max(
            np.finfo(np.float64).tiny,
            FEM_TOPOLOGY_RELATIVE_DETERMINANT_EPS * characteristic_length**3,
        )
    else:
        threshold = float(determinant_threshold)
    return bool(np.min(np.abs(determinants)) <= threshold)


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
    cells_by_family: dict[str, NDArray[np.int64] | list[NDArray[np.int64]]],
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
    apex_array = np.asarray(apex_tags, dtype=np.int64)
    cell_arities = {"tet4": 4, "prism6": 6, "pyramid5": 5}
    face_owners: dict[tuple[int, ...], list[NDArray[np.int64]]] = {}
    cell_rows_by_family: dict[str, list[NDArray[np.int64]]] = {}

    # Only cells containing a movable apex can originate a relevant face.  The
    # candidate keys are small; all-cell membership checks below stay in
    # NumPy, so the far-air volume never creates millions of Python tuples.
    candidate_faces_by_arity: dict[int, set[tuple[int, ...]]] = {}
    for family, cells in cells_by_family.items():
        cell_array = np.asarray(cells, dtype=np.int64).reshape(
            (-1, cell_arities[family])
        )
        if isinstance(cells, np.ndarray):
            cell_rows = list(cell_array)
        else:
            # Preserve row identity for the small unit-test/development API;
            # the production path supplies a 2-D ndarray and takes the fast
            # vectorized mask below.
            cell_rows = [
                np.asarray(cell, dtype=np.int64) for cell in cells
            ]
        cell_rows_by_family[family] = cell_rows
        mask = np.isin(cell_array, apex_array).any(axis=1)
        for cell, is_incident in zip(cell_rows, mask, strict=True):
            if is_incident:
                for local_face in _MIXED_CELL_LOCAL_FACETS[family]:
                    face = tuple(sorted(int(cell[index]) for index in local_face))
                    candidate_faces_by_arity.setdefault(len(face), set()).add(face)

    def packed_face_keys(rows: NDArray[np.int64]) -> NDArray[np.void]:
        contiguous = np.ascontiguousarray(rows, dtype=np.int64)
        return contiguous.view(
            np.dtype((np.void, contiguous.dtype.itemsize * contiguous.shape[1]))
        ).reshape(-1)

    packed_candidates = {
        arity: packed_face_keys(
            np.asarray(sorted(faces), dtype=np.int64).reshape((-1, arity))
        )
        for arity, faces in candidate_faces_by_arity.items()
    }
    for family, cells in cells_by_family.items():
        cell_array = np.asarray(cells, dtype=np.int64).reshape(
            (-1, cell_arities[family])
        )
        cell_rows = cell_rows_by_family[family]
        for local_face in _MIXED_CELL_LOCAL_FACETS[family]:
            face_arity = len(local_face)
            candidates = packed_candidates.get(face_arity)
            if candidates is None or not len(cell_array):
                continue
            face_rows = np.sort(cell_array[:, local_face], axis=1)
            selected = np.flatnonzero(
                np.isin(packed_face_keys(face_rows), candidates)
            )
            for index in selected:
                face = tuple(int(value) for value in face_rows[index])
                face_owners.setdefault(face, []).append(cell_rows[int(index)])

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

            def owner_determinant(
                owner: NDArray[np.int64],
                origin: NDArray[np.float64],
                normal_area: NDArray[np.float64],
                alpha: float,
            ) -> float:
                opposite = [
                    point(int(tag), alpha)
                    for tag in owner
                    if int(tag) not in face_nodes
                ]
                if not opposite:
                    return 0.0
                owner_interior = np.mean(np.asarray(opposite), axis=0)
                return float(np.dot(owner_interior - origin, normal_area))

            # Every owner determinant and the stored side guard use the same
            # face geometry at alpha=0 or alpha=1.  Materialize each endpoint
            # once instead of recomputing the cross products for every owner.
            origin_start = point(face[0], 0.0)
            origin_end = point(face[0], 1.0)
            normal_start, edge_starts = face_geometry(0.0)
            normal_end, edge_ends = face_geometry(1.0)
            starts = [
                owner_determinant(owner, origin_start, normal_start, 0.0)
                for owner in owners
            ]
            ends = [
                owner_determinant(owner, origin_end, normal_end, 1.0)
                for owner in owners
            ]
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


def _optimize_mixed_pyramid_apices(
    gmsh: Any,
    *,
    initial_tet_report: _MixedTetDegeneracyReport | None = None,
) -> float:
    """Deterministically improve pyramid p05 without degrading incident cells."""
    pyramid_tags, pyramid_nodes = gmsh.model.mesh.getElementsByType(7)
    if len(pyramid_tags) == 0:
        raise RuntimeError("mixed shared-domain realization produced no pyramid5 cells")
    pyramids = np.asarray(pyramid_nodes, dtype=np.int64).reshape((-1, 5))

    # The optimizer's only acceptance objective is the all-family p05 floor.
    # A healthy Gmsh mesh can already satisfy that floor after the local
    # tetrahedral repair; in that case running a line-search for every apex
    # cannot improve the accepted result and only repeats expensive geometry
    # work.  Check the strict tet gate before taking the fast path; if it
    # fails, retain the original line-search fallback below.
    initial_p05 = _mixed_gmsh_scaled_jacobian_p05(gmsh)
    if initial_p05 and all(
        value >= MIXED_SCALED_JACOBIAN_P05_MIN
        for value in initial_p05.values()
    ):
        degenerate_tets = (
            initial_tet_report
            if initial_tet_report is not None
            else _mixed_tet_degeneracy_report(gmsh, use_global_scale=True)
        )
        if not degenerate_tets.element_tags:
            emit_progress(
                "Gmsh mixed pyramid apex quality optimization: "
                f"moved=0/{len(pyramids)}, max_scale=1.000, p05={initial_p05}"
            )
            return 1.0
        # Preserve the original line-search fallback for a mesh whose p05
        # already passes but still contains a strict tet degeneracy.  The
        # optimizer may be able to repair that apex before the final gate.

    node_tags, node_coordinates, _ = gmsh.model.mesh.getNodes()
    coordinates = {
        int(tag): point
        for tag, point in zip(
            node_tags,
            np.asarray(node_coordinates, dtype=np.float64).reshape((-1, 3)),
            strict=True,
        )
    }
    global_tet_threshold = _mixed_tet_global_determinant_threshold(node_coordinates)
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
    apex_array = np.asarray(apex_tags, dtype=np.int64)
    cells_by_family: dict[str, NDArray[np.int64]] = {
        "pyramid5": pyramids
    }
    for element_type, family, arity in (
        (4, "tet4", 4),
        (6, "prism6", 6),
    ):
        element_tags, element_nodes = gmsh.model.mesh.getElementsByType(element_type)
        if len(element_tags) == 0:
            continue
        connectivity = np.asarray(element_nodes, dtype=np.int64).reshape((-1, arity))
        cells_by_family[family] = connectivity
        incident = connectivity[np.isin(connectivity, apex_array).any(axis=1)]
        for cell in incident:
            cell_apices = sorted(
                set(int(tag) for tag in cell).intersection(apex_tags)
            )
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
            if any(
                family == "tet4"
                and _mixed_cell_has_degenerate_jacobian(
                    family,
                    np.asarray(
                        [
                            candidate if int(tag) == apex else coordinates[int(tag)]
                            for tag in cell
                        ],
                        dtype=np.float64,
                    ),
                    determinant_threshold=global_tet_threshold,
                )
                for family, cell in incident_by_apex[apex]
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

    degenerate_tets = _mixed_tet_degeneracy_report(
        gmsh,
        use_global_scale=True,
    )
    if degenerate_tets.element_tags:
        for apex in sorted(mean_direction):
            gmsh.model.mesh.setNode(
                apex,
                original_apex_coordinates[apex].tolist(),
                parametric[apex],
            )
        raise RuntimeError(
            "mixed pyramid apex optimization created degenerate tet4: "
            f"count={len(degenerate_tets.element_tags)}, "
            f"worst_element_tag={degenerate_tets.worst_element_tag}, "
            f"determinant={degenerate_tets.worst_determinant:.6e}, "
            f"threshold={degenerate_tets.worst_threshold:.6e}"
        )

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


@dataclass(frozen=True)
class _MixedTetRepairPolicy:
    algorithm_id: str
    method: str
    iterations: int
    optimize_threshold: float = 1.0e-6
    force: bool = True
    local_first: bool = False


_MIXED_TET_REPAIR_METHODS = frozenset({"", "Relocate3D", "Netgen"})
_STRICT_MIXED_TET_REPAIR_POLICY = _MixedTetRepairPolicy(
    algorithm_id="fullmag.mixed-tet-repair.v1",
    method="Relocate3D",
    iterations=1,
    optimize_threshold=1.0e-6,
    force=True,
    local_first=True,
)


def _validate_mixed_tet_repair_policy(policy: _MixedTetRepairPolicy) -> None:
    if not isinstance(policy.algorithm_id, str) or not policy.algorithm_id.strip():
        raise ValueError("mixed tetrahedral repair algorithm ID must be non-empty")
    if policy.method not in _MIXED_TET_REPAIR_METHODS:
        raise ValueError(
            f"unsupported mixed tetrahedral repair method: {policy.method!r}"
        )
    if (
        isinstance(policy.iterations, bool)
        or not isinstance(policy.iterations, int)
        or policy.iterations < 1
    ):
        raise ValueError("mixed tetrahedral repair iterations must be at least one")
    if (
        isinstance(policy.optimize_threshold, bool)
        or not isinstance(policy.optimize_threshold, numbers.Real)
        or not math.isfinite(float(policy.optimize_threshold))
        or policy.optimize_threshold <= 0.0
    ):
        raise ValueError(
            "mixed tetrahedral repair optimize threshold must be a positive finite number"
        )
    if not isinstance(policy.force, bool):
        raise ValueError("mixed tetrahedral repair force flag must be boolean")
    if not isinstance(policy.local_first, bool):
        raise ValueError("mixed tetrahedral repair local-first flag must be boolean")


def _qualification_mixed_tet_repair_algorithm_id(
    method: str,
    iterations: int,
) -> str:
    """Return the deterministic ID for one non-production repair candidate."""
    selected_method = "" if method == "default" else method
    candidate = _MixedTetRepairPolicy(
        algorithm_id="qualification",
        method=selected_method,
        iterations=iterations,
    )
    _validate_mixed_tet_repair_policy(candidate)
    method_id = selected_method if selected_method else "default"
    return (
        "fullmag.mixed-tet-repair.qualification.v2"
        f".method-{method_id}.niter-{iterations}"
    )


def _execute_mixed_tet_repair_policy(
    gmsh: Any,
    policy: _MixedTetRepairPolicy,
) -> _MixedTetDegeneracyReport:
    """Execute one validated policy and return its final tet gate report."""
    if not isinstance(policy, _MixedTetRepairPolicy):
        raise TypeError("mixed tetrahedral repair policy has an invalid type")
    _validate_mixed_tet_repair_policy(policy)
    before = _mixed_tet_degeneracy_report(
        gmsh,
        use_global_scale=True,
    )
    if policy.local_first:
        if not before.element_tags:
            return before
        local_repair_moved = _repair_remaining_mixed_tet_slivers(
            gmsh,
            initial_report=before,
        )
        after = _mixed_tet_degeneracy_report(
            gmsh,
            use_global_scale=True,
        )
        if not after.element_tags:
            if local_repair_moved:
                emit_progress(
                    "Gmsh mixed local tet repair completed without global optimization"
                )
            return after
    else:
        after = before
    emit_progress("Gmsh: repairing mixed-domain tetrahedra")
    previous_threshold = gmsh.option.getNumber("Mesh.OptimizeThreshold")
    try:
        gmsh.option.setNumber(
            "Mesh.OptimizeThreshold", policy.optimize_threshold
        )
        gmsh.model.mesh.optimize(
            policy.method,
            force=policy.force,
            niter=policy.iterations,
        )
    finally:
        gmsh.option.setNumber("Mesh.OptimizeThreshold", previous_threshold)
    after = _mixed_tet_degeneracy_report(
        gmsh,
        use_global_scale=True,
    )
    if after.element_tags:
        _repair_remaining_mixed_tet_slivers(gmsh, initial_report=after)
        after = _mixed_tet_degeneracy_report(
            gmsh,
            use_global_scale=True,
        )
    if after.element_tags:
        created = after.element_tags - before.element_tags
        left = after.element_tags & before.element_tags
        reports = []
        for label, subset in (("created", created), ("left", left)):
            if not subset:
                continue
            report = _mixed_tet_degeneracy_report(
                gmsh,
                element_tags=subset,
                use_global_scale=True,
            )
            reports.append(
                f"{label}: count={len(subset)}, "
                f"worst_element_tag={report.worst_element_tag}, "
                f"determinant={report.worst_determinant:.6e}, "
                f"threshold={report.worst_threshold:.6e}"
            )
        raise RuntimeError(
            "mixed tetrahedral repair left or created degenerate tet4; "
            + "; ".join(reports)
        )
    return after


def _repair_mixed_tetrahedra(
    gmsh: Any,
    *,
    policy: _MixedTetRepairPolicy = _STRICT_MIXED_TET_REPAIR_POLICY,
) -> _MixedTetDegeneracyReport:
    """Repair Delaunay tetrahedra before certifying a mixed prism mesh."""
    return _execute_mixed_tet_repair_policy(gmsh, policy)


def _repair_mixed_tetrahedra_for_qualification(
    method: str,
    gmsh: Any,
    *,
    iterations: int = 1,
) -> _MixedTetDegeneracyReport:
    """Run one private qualification candidate through the canonical repair."""
    selected_method = "" if method == "default" else method
    if (
        selected_method == _STRICT_MIXED_TET_REPAIR_POLICY.method
        and iterations == _STRICT_MIXED_TET_REPAIR_POLICY.iterations
    ):
        policy = _MixedTetRepairPolicy(
            algorithm_id=_STRICT_MIXED_TET_REPAIR_POLICY.algorithm_id,
            method=selected_method,
            iterations=iterations,
            optimize_threshold=_STRICT_MIXED_TET_REPAIR_POLICY.optimize_threshold,
            force=_STRICT_MIXED_TET_REPAIR_POLICY.force,
            local_first=False,
        )
    else:
        policy = _MixedTetRepairPolicy(
            algorithm_id=_qualification_mixed_tet_repair_algorithm_id(
                selected_method,
                iterations,
            ),
            method=selected_method,
            iterations=iterations,
            optimize_threshold=_STRICT_MIXED_TET_REPAIR_POLICY.optimize_threshold,
            force=_STRICT_MIXED_TET_REPAIR_POLICY.force,
            local_first=False,
        )
    return _execute_mixed_tet_repair_policy(gmsh, policy)


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


def _box_cylinder_ring_components(
    geometry: Geometry,
) -> tuple[Box, Cylinder] | None:
    """Return the canonical thin-film ring components, if present.

    The GEO ring realization deliberately accepts only the public geometry
    form used by the COMSOL benchmark: a centered ``Box`` minus a centered,
    full-height Z-axis ``Cylinder``.  Accepting translated or nested CSG here
    would require a different face/volume construction and could silently
    change the authored geometry.
    """
    if not isinstance(geometry, Difference):
        return None
    base = geometry.base
    tool = geometry.tool
    if not isinstance(base, Box) or not isinstance(tool, Cylinder):
        return None
    if tool.axis != (0.0, 0.0, 1.0):
        return None
    sx, sy, sz = (float(value) for value in base.size)
    if not math.isclose(tool.height, sz, rel_tol=1.0e-9, abs_tol=1.0e-18):
        return None
    if tool.radius >= 0.5 * min(sx, sy):
        return None
    return base, tool


def _is_box_cylinder_ring(geometry: Geometry) -> bool:
    """Return whether *geometry* has the strict GEO ring representation."""
    return _box_cylinder_ring_components(geometry) is not None


def _translated_cylinder_annulus_components(
    geometry: Geometry,
) -> tuple[Difference, Cylinder, Cylinder, tuple[float, float, float]] | None:
    """Return a translated, axis-aligned annulus in the authored CSG form.

    The mixed shared-domain route intentionally accepts only the public
    ``Translate(Difference(Cylinder, Cylinder))`` representation.  It does
    not infer a ring from a bounding box or replace arbitrary OCC geometry;
    doing so would make the body-owned material and separation evidence
    ambiguous.
    """
    if not isinstance(geometry, Translate) or not isinstance(geometry.geometry, Difference):
        return None
    difference = geometry.geometry
    if not isinstance(difference.base, Cylinder) or not isinstance(difference.tool, Cylinder):
        return None
    outer, inner = difference.base, difference.tool
    if outer.axis != inner.axis or outer.radius <= inner.radius:
        return None
    if not all(math.isfinite(float(value)) for value in geometry.offset):
        return None
    if not math.isclose(
        float(outer.height), float(inner.height), rel_tol=1.0e-9, abs_tol=1.0e-18
    ):
        return None
    return difference, outer, inner, tuple(float(value) for value in geometry.offset)


def _disconnected_mixed_p1_pair(
    geometries: Sequence[Geometry],
) -> tuple[Box, Geometry, Cylinder, Cylinder, tuple[float, float, float]] | None:
    """Resolve the generic two-body Box plus translated annulus candidate."""
    if len(geometries) != 2:
        return None
    box = next((geometry for geometry in geometries if isinstance(geometry, Box)), None)
    ring_geometry = next(
        (geometry for geometry in geometries if _translated_cylinder_annulus_components(geometry)),
        None,
    )
    if box is None or ring_geometry is None:
        return None
    components = _translated_cylinder_annulus_components(ring_geometry)
    if components is None:
        return None
    _difference, outer, inner, offset = components
    return box, ring_geometry, outer, inner, offset


def classify_sweepability(geometry: Geometry) -> SweepabilityResult:
    """Classify whether *geometry* can be swept-meshed.

    Currently supports:
    - the canonical ``Box - Cylinder`` ring with a full-height Z-axis hole,
    - ``Box`` with aspect ratio > 2 in any axis,
    - ``Cylinder`` where height ≪ diameter (thin disk).

    Returns a :class:`SweepabilityResult` with diagnostics.
    """
    ring = _box_cylinder_ring_components(geometry)
    if ring is not None:
        base, tool = ring
        sx, sy, sz = (float(value) for value in base.size)
        lateral = max(sx, sy)
        ar = lateral / sz if sz > 0.0 else float("inf")
        return SweepabilityResult(
            sweepable=True,
            thin_axis=2,
            thickness=sz,
            aspect_ratio=ar,
            reason=(
                "Thin box-cylinder ring: full-height Z-axis hole, "
                f"lateral/thickness={ar:.1f}"
            ),
        )

    if isinstance(geometry, Difference):
        return SweepabilityResult(
            sweepable=False,
            reason=(
                "Only centered Box minus full-height Z-axis Cylinder is "
                "supported by the swept ring realization"
            ),
        )

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


def _coincident_ring_airbox_bounds(
    base: Box,
    airbox: AirboxOptions,
) -> tuple[float, float, float, float, float, float] | None:
    """Resolve the exact-cell airbox bounds supported by the ring GEO route."""
    sx, sy, sz = (float(value) for value in base.size)
    if str(airbox.shape).strip().lower() != "bbox":
        return None
    if airbox.size is None:
        ox, oy, oz = sx * float(airbox.padding_factor), sy * float(airbox.padding_factor), sz * float(airbox.padding_factor)
    else:
        ox, oy, oz = (float(value) for value in airbox.size)
    cx, cy, cz = (0.0, 0.0, 0.0) if airbox.center is None else tuple(float(value) for value in airbox.center)
    if not all(math.isfinite(value) and value > 0.0 for value in (ox, oy, oz)):
        raise ValueError("airbox dimensions must be finite and positive")
    # The partitioned GEO construction has no lateral transition shell.  It
    # is therefore reserved for the exact periodic cell used by the antidot
    # benchmark; larger lateral airboxes continue through the generic GEO
    # shell path below.
    if not (
        math.isclose(ox, sx, rel_tol=1.0e-9, abs_tol=1.0e-18)
        and math.isclose(oy, sy, rel_tol=1.0e-9, abs_tol=1.0e-18)
        and math.isclose(cx, 0.0, rel_tol=0.0, abs_tol=1.0e-18)
        and math.isclose(cy, 0.0, rel_tol=0.0, abs_tol=1.0e-18)
    ):
        return None
    bounds = (cx - ox / 2.0, cy - oy / 2.0, cz - oz / 2.0, cx + ox / 2.0, cy + oy / 2.0, cz + oz / 2.0)
    body_min = (-sx / 2.0, -sy / 2.0, -sz / 2.0)
    body_max = (sx / 2.0, sy / 2.0, sz / 2.0)
    tolerance = max(max(abs(value) for value in bounds + body_min + body_max) * 1.0e-10, 1.0e-18)
    if any(
        body_min[axis] < bounds[axis] - tolerance
        or body_max[axis] > bounds[axis + 3] + tolerance
        for axis in range(3)
    ):
        return None
    return bounds


def _box_airbox_layer_levels(
    body_bottom: float, body_top: float, zmin: float, zmax: float,
    n_layers: int, *, h_inner: float, h_outer: float, growth: float,
) -> list[float]:
    """Plan exact film planes and independently graded exterior planes (SI)."""
    if isinstance(n_layers, bool) or not isinstance(n_layers, int) or n_layers < 1:
        raise ValueError("film layer count must be a positive integer")
    if not all(math.isfinite(v) for v in (body_bottom, body_top, zmin, zmax, h_inner, h_outer, growth)):
        raise ValueError("layer planning inputs must be finite")
    if not zmin < body_bottom < body_top < zmax:
        raise ValueError("Box airbox requires positive clearance on both z faces")
    if h_inner <= 0 or h_outer < h_inner or growth < 1:
        raise ValueError("air layer sizes must be positive, ordered, and growth >= 1")

    def exterior(interface: float, boundary: float, direction: float) -> list[float]:
        coordinate_span = direction * (boundary - interface)
        if not math.isfinite(coordinate_span) or coordinate_span <= 0.0:
            raise ValueError("air layer coordinate span must be finite and positive")
        coordinate_scale = max(abs(interface), abs(boundary), coordinate_span)
        coordinate_spacing = math.ulp(coordinate_scale)
        if coordinate_spacing >= h_inner:
            raise ValueError("air layer size is below coordinate resolution")

        result = []
        position = interface
        relative_sum = 0.0
        compensation = 0.0
        step = h_inner

        def roundoff_bound(distance: float, *, prior_steps: int) -> float:
            relative_scale = max(coordinate_span, abs(distance), abs(step))
            relative_spacing = math.ulp(relative_scale)
            bound = (
                2.0 * coordinate_spacing
                + 4.0 * (prior_steps + 2) * relative_spacing
            )
            if not math.isfinite(bound):
                raise ValueError("air layer coordinate roundoff bound must be finite")
            return bound

        def close_boundary(bound: float) -> list[float]:
            if not result:
                return [boundary]
            previous = result[-2] if len(result) > 1 else interface
            extended_step = abs(boundary - previous)
            if extended_step - h_outer <= bound:
                result[-1] = boundary
                return result
            raise ValueError(
                "air layer roundoff closure would exceed maximum element size"
            )

        while True:
            distance = math.fsum((relative_sum, -compensation))
            remaining = coordinate_span - distance
            bound = roundoff_bound(distance, prior_steps=len(result))
            if remaining <= bound:
                if remaining < -bound:
                    raise ValueError("air layer relative plan overshot the boundary")
                return close_boundary(bound)

            if remaining <= step:
                if boundary == position:
                    raise ValueError("air layer size is below coordinate resolution")
                if abs(boundary - position) - step > bound:
                    raise ValueError(
                        "air layer step exceeds maximum element size at coordinate precision"
                    )
                result.append(boundary)
                return result

            corrected_step = step - compensation
            next_sum = relative_sum + corrected_step
            next_compensation = (next_sum - relative_sum) - corrected_step
            next_distance = math.fsum((next_sum, -next_compensation))
            next_bound = roundoff_bound(
                next_distance, prior_steps=len(result) + 1,
            )
            if coordinate_span - next_distance <= 0.0:
                overshoot = next_distance - coordinate_span
                if overshoot > next_bound:
                    raise ValueError("air layer relative plan overshot the boundary")
                if boundary == position:
                    raise ValueError("air layer size is below coordinate resolution")
                if abs(boundary - position) - step > next_bound:
                    raise ValueError(
                        "air layer step exceeds maximum element size at coordinate precision"
                    )
                result.append(boundary)
                return result

            following = interface + direction * next_distance
            if following == position:
                raise ValueError("air layer size is below coordinate resolution")
            if abs(following - position) - step > next_bound:
                raise ValueError(
                    "air layer step exceeds maximum element size at coordinate precision"
                )
            if direction * (following - boundary) >= 0.0:
                if coordinate_span - next_distance > next_bound:
                    raise ValueError(
                        "air layer size is below coordinate resolution"
                    )
                if abs(boundary - position) - step > next_bound:
                    raise ValueError(
                        "air layer step exceeds maximum element size at coordinate precision"
                    )
                result.append(boundary)
                return result
            result.append(following)
            position = following
            relative_sum = next_sum
            compensation = next_compensation
            step = min(step * growth, h_outer)

    lower = exterior(body_bottom, zmin, -1.0)
    upper = exterior(body_top, zmax, 1.0)
    film = [body_bottom + (body_top - body_bottom) * i / n_layers for i in range(n_layers + 1)]
    film[0], film[-1] = body_bottom, body_top
    return [*reversed(lower), *film, *upper]


def _scaled_airbox_maximum_element_size(
    airbox: AirboxOptions | None,
    *,
    scale: float,
) -> float | None:
    if airbox is None or airbox.maximum_element_size is None:
        return None
    return float(airbox.maximum_element_size) * float(scale)


def _resolve_box_airbox_layer_sizes(
    body_hmax: float,
    airbox: AirboxOptions,
) -> tuple[float, float]:
    """Resolve the exact Box air-layer interface size and finite outer cap (SI)."""
    base_hmax = float(body_hmax)
    growth = float(airbox.grading_ratio)
    if not math.isfinite(base_hmax) or base_hmax <= 0.0:
        raise ValueError("Box airbox body maximum element size must be finite and positive")
    if not math.isfinite(growth) or growth <= 1.0:
        raise ValueError("Box airbox grading ratio must be finite and greater than 1.0")

    explicit_inner = airbox.minimum_element_size
    h_inner = float(explicit_inner) if explicit_inner is not None else base_hmax
    if not math.isfinite(h_inner) or h_inner <= 0.0:
        raise ValueError("Box airbox minimum element size must be finite and positive")

    explicit_outer = airbox.maximum_element_size
    if explicit_outer is not None:
        h_outer = float(explicit_outer)
        if not math.isfinite(h_outer) or h_outer <= 0.0:
            raise ValueError("Box airbox maximum element size must be finite and positive")
        if explicit_inner is not None and h_inner > h_outer:
            raise ValueError(
                "Box airbox minimum_element_size must be <= maximum_element_size"
            )
        if explicit_inner is None:
            h_inner = min(h_inner, h_outer)
        return h_inner, h_outer

    # Match the existing lateral/OCC/GEO default: permit four geometric growth
    # steps when no authored far-air size is available, while keeping the cap
    # finite and positive before it reaches Gmsh.
    h_outer = h_inner
    for _ in range(4):
        h_outer *= growth
        if not math.isfinite(h_outer) or h_outer <= 0.0:
            raise ValueError(
                "implicit airbox outer element size must be finite and positive"
            )
    return h_inner, h_outer


def generate_swept_tetrahedral_box_airbox_mesh(
    geometry: Box, hmax: float, n_layers: int, *, order: int,
    distribution: str, recombine: bool, airbox: AirboxOptions | None,
    options: MeshOptions,
) -> MeshData:
    """Realize a fixed-layer Tet4 Box, partitioning scoped fields by exact z layers."""
    if airbox is not None and int(airbox.boundary_marker) == 10:
        raise ValueError(
            "shared-domain interface and outer boundary markers must be distinct"
        )
    _clear_scoped_layer_plane_proofs(options)
    if order != 1 or distribution != DISTRIBUTION_FIXED or recombine:
        raise ValueError("layered tetrahedral Box requires P1 fixed non-recombined layers")
    if options.sweep_direction not in (None, "auto", "z"):
        raise ValueError("layered tetrahedral Box supports only the z sweep direction")
    if options.sweep_face_meshing not in (None, "triangular"):
        raise ValueError("layered tetrahedral Box requires a triangular source face")
    if options.through_thickness_element_ratio not in (None, 1.0) or options.through_thickness_symmetric:
        raise ValueError("layered tetrahedral Box requires uniform film layers")
    if airbox is None:
        raise ValueError("layered tetrahedral Box currently requires an exact-cell bbox airbox")
    if _has_component_scoped_size_fields(
        options
    ) and not _supports_scoped_layer_partitioned_box(geometry, airbox=airbox):
        raise ValueError(
            f"{THIN_FILM_SCOPED_LAYER_PARTITION_UNSUPPORTED}: "
            f"{THIN_FILM_SCOPED_LAYER_PARTITION_UNSUPPORTED_REASON}"
        )
    if airbox.grading_mode != "geometric":
        raise ValueError("layered tetrahedral Box currently supports only geometric airbox grading")
    if isinstance(n_layers, bool) or not isinstance(n_layers, int) or n_layers < 1:
        raise ValueError("film layer count must be a positive integer")
    if not math.isfinite(float(hmax)) or hmax <= 0:
        raise ValueError("film lateral mesh size must be finite and positive")
    bounds = _coincident_ring_airbox_bounds(geometry, airbox)
    if bounds is None:
        raise ValueError("layered tetrahedral Box requires coincident lateral bbox airbox bounds")
    return _generate_coincident_ring_airbox_mesh(
        geometry, base=geometry, tool=None, hmax=hmax, n_layers=n_layers,
        order=order, airbox=airbox, options=options, bounds=bounds,
    )


def _generate_coincident_ring_airbox_mesh(
    geometry: Geometry,
    *,
    base: Box,
    tool: Cylinder | None,
    hmax: float,
    n_layers: int,
    order: int,
    airbox: AirboxOptions,
    options: MeshOptions,
    bounds: tuple[float, float, float, float, float, float],
) -> MeshData:
    """Mesh a Box or ring and exact-cell airbox as synchronized GEO partitions."""
    SCALE = 1.0e6
    body_hmax_scaled = float(hmax) * SCALE
    if not math.isfinite(body_hmax_scaled) or body_hmax_scaled <= 0.0:
        raise ValueError(
            "scaled Box body maximum element size must be finite and positive"
        )
    sx, sy, sz = (float(value) for value in base.size)
    radius = float(tool.radius) if tool is not None else None
    xmin, ymin, zmin, xmax, ymax, zmax = (float(value) * SCALE for value in bounds)
    body_bottom = -0.5 * sz * SCALE
    body_top = 0.5 * sz * SCALE
    if airbox.grading_mode != "geometric":
        raise ValueError("exact-cell layered airbox currently supports only geometric airbox grading")
    h_inner, h_outer = _resolve_box_airbox_layer_sizes(hmax, airbox)
    h_inner_scaled = h_inner * SCALE
    h_outer_scaled = h_outer * SCALE
    if not all(
        math.isfinite(value) and value > 0.0
        for value in (h_inner_scaled, h_outer_scaled)
    ):
        raise ValueError("scaled Box airbox element sizes must be finite and positive")
    levels = [value * SCALE for value in _box_airbox_layer_levels(
        body_bottom / SCALE, body_top / SCALE, zmin / SCALE, zmax / SCALE,
        n_layers, h_inner=h_inner, h_outer=h_outer, growth=float(airbox.grading_ratio),
    )]
    if any(levels[index + 1] <= levels[index] for index in range(len(levels) - 1)):
        raise ValueError("coincident ring airbox must have positive z clearance")

    gmsh = _import_gmsh()
    gmsh_version = str(getattr(gmsh, "__version__", "unknown"))
    if gmsh_version != _MIXED_SHARED_GMSH_VERSION:
        raise RuntimeError(
            "shared-domain swept ring meshing is qualified only for Gmsh "
            f"{_MIXED_SHARED_GMSH_VERSION}; detected {gmsh_version}"
        )
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        _configure_gmsh_threads(gmsh, requested_threads=1, honor_environment=False)
        gmsh.model.add("fullmag_swept_box_cylinder_ring_coincident_airbox")
        source_hmax_scaled = body_hmax_scaled
        z_source = body_bottom
        outer_points = [
            gmsh.model.geo.addPoint(x, y, z_source, source_hmax_scaled)
            for x, y in (
                (xmin, ymin),
                (xmax, ymin),
                (xmax, ymax),
                (xmin, ymax),
            )
        ]
        outer_lines = [
            gmsh.model.geo.addLine(outer_points[index], outer_points[(index + 1) % 4])
            for index in range(4)
        ]
        outer_loop = gmsh.model.geo.addCurveLoop(outer_lines)
        if tool is None:
            annulus_surface = gmsh.model.geo.addPlaneSurface([outer_loop])
            hole_surface = None
        else:
            center = gmsh.model.geo.addPoint(0.0, 0.0, z_source, source_hmax_scaled)
            right = gmsh.model.geo.addPoint(radius * SCALE, 0.0, z_source, source_hmax_scaled)
            top = gmsh.model.geo.addPoint(0.0, radius * SCALE, z_source, source_hmax_scaled)
            left = gmsh.model.geo.addPoint(-radius * SCALE, 0.0, z_source, source_hmax_scaled)
            bottom = gmsh.model.geo.addPoint(0.0, -radius * SCALE, z_source, source_hmax_scaled)
            arcs = [
                gmsh.model.geo.addCircleArc(right, center, top),
                gmsh.model.geo.addCircleArc(top, center, left),
                gmsh.model.geo.addCircleArc(left, center, bottom),
                gmsh.model.geo.addCircleArc(bottom, center, right),
            ]
            circle_loop = gmsh.model.geo.addCurveLoop(arcs)
            annulus_surface = gmsh.model.geo.addPlaneSurface([outer_loop, -circle_loop])
            hole_surface = gmsh.model.geo.addPlaneSurface([circle_loop])
        gmsh.model.geo.synchronize()

        scoped_layer_partitioning = (
            (isinstance(geometry, Box) or tool is not None)
            and _has_component_scoped_size_fields(options)
        )
        if scoped_layer_partitioning and not _supports_scoped_layer_partitioned_box(
            base,
            airbox=airbox,
        ):
            raise ValueError(
                f"{THIN_FILM_SCOPED_LAYER_PARTITION_UNSUPPORTED}: "
                f"{THIN_FILM_SCOPED_LAYER_PARTITION_UNSUPPORTED_REASON}"
            )

        source_fields: list[int] = []
        if not scoped_layer_partitioning:
            if options.size_fields or options.lower_bound_fields:
                source_fields.append(
                    _apply_mixed_source_face_mesh_options(
                        gmsh,
                        source_surface=annulus_surface,
                        hmax_scaled=source_hmax_scaled,
                        order=order,
                        opts=options,
                        hscale=SCALE,
                        source_geometry_name=geometry.geometry_name,
                    )
                )
            else:
                # The final air field must not coarsen the magnetic source face.
                source_field = gmsh.model.mesh.field.add("Constant")
                gmsh.model.mesh.field.setNumbers(source_field, "SurfacesList", [annulus_surface])
                gmsh.model.mesh.field.setNumber(source_field, "VIn", source_hmax_scaled)
                gmsh.model.mesh.field.setNumber(source_field, "VOut", 1.0e22)
                gmsh.model.mesh.field.setNumber(source_field, "IncludeBoundary", 1)
                gmsh.model.mesh.field.setAsBackgroundMesh(source_field)
                source_fields.append(source_field)
                gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 1)
                gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
                gmsh.option.setNumber("Mesh.CharacteristicLengthMax", source_hmax_scaled)
                gmsh.option.setNumber("Mesh.Algorithm", options.algorithm_2d)
                if options.hmin is not None:
                    gmsh.option.setNumber("Mesh.CharacteristicLengthMin", options.hmin * SCALE)
            gmsh.model.mesh.generate(2)

        annulus_volumes_by_interval: dict[int, int] = {}
        hole_volumes_by_interval: dict[int, int] = {}
        current_annulus = int(annulus_surface)
        current_hole = int(hole_surface) if hole_surface is not None else None
        interval_midpoints = [
            0.5 * (levels[level_index] + levels[level_index + 1])
            for level_index in range(len(levels) - 1)
        ]
        magnetic_indices = [
            level_index
            for level_index, midpoint in enumerate(interval_midpoints)
            if body_bottom < midpoint < body_top
        ]
        above_indices = [
            level_index
            for level_index, midpoint in enumerate(interval_midpoints)
            if midpoint >= body_top
        ]
        below_indices = [
            level_index
            for level_index, midpoint in enumerate(interval_midpoints)
            if midpoint <= body_bottom
        ]
        if len(magnetic_indices) + len(above_indices) + len(below_indices) != len(
            interval_midpoints
        ):
            raise RuntimeError("coincident ring intervals do not partition the airbox")
        ordered_indices = [*magnetic_indices, *above_indices, *reversed(below_indices)]
        below_started = False
        for level_index in ordered_indices:
            is_below = level_index in below_indices
            if is_below and not below_started:
                current_annulus = int(annulus_surface)
                current_hole = int(hole_surface) if hole_surface is not None else None
                below_started = True
            interval_step = float(levels[level_index + 1] - levels[level_index])
            step = -interval_step if is_below else interval_step
            target_z = float(
                levels[level_index] if is_below else levels[level_index + 1]
            )
            source_entities = [(2, current_annulus)] + (
                [(2, current_hole)] if current_hole is not None else []
            )
            # Keep every requested z interval as a separate CAD volume. The
            # unscoped compatibility route still extrudes its premeshed
            # source triangulation. Scoped air slabs remain geometry-only so
            # the final conforming 3D mesh resolves magnetic-owner and air
            # sizing independently. Magnetic intervals use one recombined
            # prism layer; the existing coordinate-based converter then gives
            # periodic copies the same deterministic tetrahedral split.
            if scoped_layer_partitioning:
                if body_bottom < 0.5 * (levels[level_index] + levels[level_index + 1]) < body_top:
                    extruded = gmsh.model.geo.extrude(
                        source_entities,
                        0.0,
                        0.0,
                        step,
                        numElements=[1],
                        heights=[1.0],
                        recombine=True,
                    )
                else:
                    extruded = gmsh.model.geo.extrude(
                        source_entities,
                        0.0,
                        0.0,
                        step,
                    )
            else:
                extruded = gmsh.model.geo.extrude(
                    source_entities,
                    0.0,
                    0.0,
                    step,
                    numElements=[1],
                    heights=[1.0],
                    recombine=True,
                )
            gmsh.model.geo.synchronize()
            volumes = [int(tag) for dim, tag in extruded if int(dim) == 3]
            if len(volumes) != (2 if tool is not None else 1):
                raise RuntimeError("coincident ring extrusion must produce annulus and hole volumes")
            annulus_step: list[int] = []
            hole_step: list[int] = []
            for volume in volumes:
                box = gmsh.model.getBoundingBox(3, volume)
                x_span = float(box[3] - box[0])
                if math.isclose(x_span, sx * SCALE, rel_tol=1.0e-7, abs_tol=1.0e-9):
                    annulus_step.append(volume)
                else:
                    hole_step.append(volume)
            if len(annulus_step) != 1 or len(hole_step) != (1 if tool is not None else 0):
                raise RuntimeError("coincident ring extrusion volume identity is ambiguous")
            annulus_volumes_by_interval[level_index] = annulus_step[0]
            if hole_step:
                hole_volumes_by_interval[level_index] = hole_step[0]
            top_surfaces = []
            for dim, tag in extruded:
                if int(dim) != 2:
                    continue
                box = gmsh.model.getBoundingBox(2, int(tag))
                if abs(float(box[2]) - target_z) <= 1.0e-8 and abs(float(box[5]) - target_z) <= 1.0e-8:
                    top_surfaces.append((int(tag), float(box[3] - box[0])))
            next_annulus = [tag for tag, x_span in top_surfaces if math.isclose(x_span, sx * SCALE, rel_tol=1.0e-7, abs_tol=1.0e-9)]
            next_hole = [tag for tag, x_span in top_surfaces if not math.isclose(x_span, sx * SCALE, rel_tol=1.0e-7, abs_tol=1.0e-9)]
            if len(next_annulus) != 1 or len(next_hole) != (1 if tool is not None else 0):
                raise RuntimeError("coincident ring extrusion top-face identity is ambiguous")
            current_annulus = next_annulus[0]
            current_hole = next_hole[0] if next_hole else None

        expected_interval_indices = set(range(len(levels) - 1))
        if set(annulus_volumes_by_interval) != expected_interval_indices:
            raise RuntimeError("coincident ring realization lost an annulus interval volume")
        if tool is not None and set(hole_volumes_by_interval) != expected_interval_indices:
            raise RuntimeError("coincident ring realization lost a hole interval volume")
        annulus_volumes = [
            annulus_volumes_by_interval[index]
            for index in range(len(levels) - 1)
        ]
        hole_volumes = [
            hole_volumes_by_interval[index]
            for index in sorted(hole_volumes_by_interval)
        ]

        body_volumes = [volume for i, volume in enumerate(annulus_volumes)
                        if body_bottom < 0.5 * (levels[i] + levels[i + 1]) < body_top]
        air_volumes = [volume for volume in annulus_volumes if volume not in body_volumes] + hole_volumes
        if len(body_volumes) != n_layers:
            raise RuntimeError("coincident ring realization lost a magnetic layer volume")
        gmsh.model.addPhysicalGroup(3, body_volumes, tag=1)
        gmsh.model.setPhysicalName(3, 1, "magnetic")
        gmsh.model.addPhysicalGroup(3, air_volumes, tag=2)
        gmsh.model.setPhysicalName(3, 2, "air")

        def boundary_surfaces(volumes: list[int]) -> set[int]:
            return {
                abs(int(tag))
                for dim, tag in gmsh.model.getBoundary(
                    [(3, volume) for volume in volumes], oriented=False
                )
                if int(dim) == 2
            }

        body_boundary = boundary_surfaces(body_volumes)
        air_boundary = boundary_surfaces(air_volumes)
        interface_surfaces = sorted(body_boundary & air_boundary)
        if interface_surfaces:
            gmsh.model.addPhysicalGroup(2, interface_surfaces, tag=10)
            gmsh.model.setPhysicalName(2, 10, "mag_air_interface")
        # The boundary of the combined volumes excludes magnetic-air interfaces.
        # Bounding-box extrema alone also select horizontal internal interfaces.
        outer_surfaces = sorted(boundary_surfaces(body_volumes + air_volumes))
        from ._gmsh_occ import (
            _add_periodic_boundary_physical_groups,
            _configure_axis_periodic_surfaces,
            _scale_periodic_boundary_pairs,
        )

        def is_z_cap(surface: int) -> bool:
            box = gmsh.model.getBoundingBox(2, surface)
            return any(abs(float(box[2]) - z) <= 1.0e-8
                       and abs(float(box[5]) - z) <= 1.0e-8 for z in (zmin, zmax))

        periodic_candidates = [surface for surface in outer_surfaces if not is_z_cap(surface)]
        periodic_specs = _configure_axis_periodic_surfaces(
            gmsh,
            surface_tags=periodic_candidates,
            pair_ids=list(options.periodic_pair_ids),
        )
        periodic_surfaces = _add_periodic_boundary_physical_groups(
            gmsh,
            periodic_specs,
            reserved_markers={10, int(airbox.boundary_marker)},
        )
        gamma_surfaces = [surface for surface in outer_surfaces if surface not in periodic_surfaces]
        if gamma_surfaces:
            gmsh.model.addPhysicalGroup(2, gamma_surfaces, tag=int(airbox.boundary_marker))
            gmsh.model.setPhysicalName(2, int(airbox.boundary_marker), "Gamma_out")

        airbox_scaled = _dc_replace(
            airbox,
            size=tuple(float(value) * SCALE for value in airbox.size)
            if airbox.size is not None
            else None,
            center=tuple(float(value) * SCALE for value in airbox.center)
            if airbox.center is not None
            else None,
            maximum_element_size=(
                float(airbox.maximum_element_size) * SCALE
                if airbox.maximum_element_size is not None
                else None
            ),
            minimum_element_size=(
                float(airbox.minimum_element_size) * SCALE
                if airbox.minimum_element_size is not None
                else None
            ),
        )
        airbox_field = None
        if airbox_scaled.grading_ratio > 1.0 and interface_surfaces:
            airbox_field = _add_airbox_grading_field(
                gmsh,
                surface_tags=interface_surfaces,
                h_inner=h_inner_scaled,
                h_outer=h_outer_scaled,
                grading_ratio=float(airbox_scaled.grading_ratio),
                grading_mode=str(airbox_scaled.grading_mode),
                dist_max=max(h_inner_scaled, min(xmax - xmin, ymax - ymin, zmax - zmin)),
                object_bounds_min=(xmin, ymin, body_bottom),
                object_bounds_max=(xmax, ymax, body_top),
                airbox_bounds_min=(xmin, ymin, zmin),
                airbox_bounds_max=(xmax, ymax, zmax),
                airbox_shape="bbox",
                air_volume_tags=air_volumes,
            )
            if airbox_field is not None:
                # Keep the graded air field active on the shared interface;
                # the owner-volume Restrict field below provides the magnetic
                # target without exporting its VOut into the air domain.
                gmsh.model.mesh.field.setNumber(
                    airbox_field,
                    "IncludeBoundary",
                    1 if h_inner_scaled <= body_hmax_scaled else 0,
                )

        final_options = _dc_replace(
            options,
            size_fields=(
                list(options.size_fields)
                if options.lower_bound_fields or scoped_layer_partitioning
                else []
            ),
        )
        # _apply_mesh_options raises the global characteristic-length ceiling
        # to accommodate the far-air target. Keep the body hmax independent of
        # that global value with an owner-volume upper field; its VOut is the
        # neutral global ceiling, so the constraint does not coarsen air.
        body_upper_field = gmsh.model.mesh.field.add("Constant")
        gmsh.model.mesh.field.setNumbers(
            body_upper_field, "VolumesList", body_volumes
        )
        gmsh.model.mesh.field.setNumber(
            body_upper_field, "VIn", body_hmax_scaled
        )
        gmsh.model.mesh.field.setNumber(body_upper_field, "IncludeBoundary", 1)
        gmsh.model.mesh.field.setNumber(
            body_upper_field,
            "VOut",
            max(body_hmax_scaled, h_outer_scaled),
        )
        body_upper_restricted = gmsh.model.mesh.field.add("Restrict")
        gmsh.model.mesh.field.setNumber(
            body_upper_restricted, "InField", body_upper_field
        )
        gmsh.model.mesh.field.setNumbers(
            body_upper_restricted, "VolumesList", body_volumes
        )
        gmsh.model.mesh.field.setNumber(
            body_upper_restricted, "IncludeBoundary", 1
        )
        # The scoped route starts from a lower outer-air source face and
        # extrudes that CAD face through the magnetic intervals.  A volume
        # Restrict field constrains the 3-D owner scope, not the two-dimensional
        # source face while it is meshed as the pre-3-D extrusion seed; the
        # corresponding 3-D GEO owner volumes already exist at that point.
        # Without an explicit source-surface target, a far-air cap can change
        # the ring's source triangulation even when the resolved owner target is
        # unchanged.  Pin both the annulus and complementary hole seed to the
        # owner target.  The neutral VOut keeps this seed field from becoming
        # an air-domain cap.
        owner_source_seed = None
        if scoped_layer_partitioning and hole_surface is not None:
            owner_source_seed = gmsh.model.mesh.field.add("Constant")
            owner_source_entities = [int(annulus_surface)]
            if hole_surface is not None:
                owner_source_entities.append(int(hole_surface))
            gmsh.model.mesh.field.setNumbers(
                owner_source_seed, "SurfacesList", owner_source_entities
            )
            gmsh.model.mesh.field.setNumber(
                owner_source_seed, "VIn", body_hmax_scaled
            )
            gmsh.model.mesh.field.setNumber(
                owner_source_seed, "VOut", 1.0e22
            )
            gmsh.model.mesh.field.setNumber(owner_source_seed, "IncludeBoundary", 1)

        preexisting_fields = [*source_fields, int(body_upper_restricted)]
        if owner_source_seed is not None:
            preexisting_fields.append(int(owner_source_seed))
        if airbox_field is not None:
            preexisting_fields.append(int(airbox_field))
        _apply_mesh_options(
            gmsh,
            body_hmax_scaled,
            order,
            final_options,
            hscale=SCALE,
            preexisting_field_ids=preexisting_fields,
            airbox_maximum_element_size=h_outer_scaled,
            component_volume_tags={geometry.geometry_name: body_volumes},
            component_surface_tags={
                geometry.geometry_name: sorted(
                    {
                        abs(int(tag))
                        for dim, tag in gmsh.model.getBoundary(
                            [(3, volume) for volume in body_volumes],
                            oriented=False,
                        )
                        if int(dim) == 2
                    }
                )
            },
        )
        with _GmshProgressLogger(gmsh):
            gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, options)
        _reapply_periodic_surface_mappings(gmsh, periodic_specs)
        from ._gmsh_layered_tetrahedra import subdivide_layered_prisms
        subdivide_layered_prisms(gmsh)
        quality, _per_domain_quality = (
            _extract_quality_metrics(gmsh, options)
            if options.compute_quality
            else (None, None)
        )
        raw_mesh = _extract_mesh_data(
            gmsh,
            quality=quality,
            has_physical_groups=True,
            periodic_pair_specs=periodic_specs,
            boundary_role_markers=(10, int(airbox.boundary_marker)),
        )
        if any(kind != "tet4" for kind in raw_mesh.cell_types.tolist()):
            raise RuntimeError(
                "coincident ring shared-domain realization requires tet4 volume cells; "
                f"Gmsh produced {sorted(set(raw_mesh.cell_types.tolist()))}"
            )
        if any(kind != "tri3" for kind in raw_mesh.facet_types.tolist()):
            raise RuntimeError(
                "coincident ring shared-domain realization requires tri3 boundary facets; "
                f"Gmsh produced {sorted(set(raw_mesh.facet_types.tolist()))}"
            )
        nodes = np.asarray(raw_mesh.nodes, dtype=np.float64) / SCALE
        elements = raw_mesh.elements
        magnetic_mask = np.asarray(raw_mesh.element_markers, dtype=np.int32) == 1
        if not np.any(magnetic_mask):
            raise RuntimeError("coincident ring realization produced no magnetic cells")
        magnetic_elements = elements[magnetic_mask]
        magnetic_nodes = np.unique(magnetic_elements.reshape(-1))
        if scoped_layer_partitioning:
            layer_planes = np.linspace(
                body_bottom / SCALE,
                body_top / SCALE,
                n_layers + 1,
                dtype=np.float64,
            )
            body_node_z = nodes[magnetic_nodes, 2]
            plane_tolerance = max(
                FEM_EXACT_LAYER_PLANE_ABS_TOLERANCE_M,
                FEM_EXACT_LAYER_PLANE_REL_TOLERANCE * (body_top - body_bottom) / SCALE,
            )
            exact_plane_count = _count_exact_layer_planes(nodes[magnetic_nodes], 2)
            resolved_layers = exact_plane_count - 1
            if resolved_layers != n_layers:
                raise RuntimeError(
                    "scoped layer-partitioned realization requested "
                    f"{n_layers} layers but resolved {resolved_layers} exact z intervals"
                )
            node_plane_distance = np.min(
                np.abs(body_node_z[:, None] - layer_planes[None, :]),
                axis=1,
            )
            if np.any(node_plane_distance > plane_tolerance):
                raise RuntimeError(
                    "scoped layer-partitioned realization has magnetic nodes outside "
                    "the requested through-thickness planes"
                )
            plane_incidence = [
                int(np.count_nonzero(np.abs(body_node_z - plane) <= plane_tolerance))
                for plane in layer_planes
            ]
            if any(count == 0 for count in plane_incidence):
                raise RuntimeError(
                    "scoped layer-partitioned realization lost a requested body plane: "
                    f"incidence={plane_incidence}"
                )
            body_cell_z = nodes[magnetic_elements, 2]
            for plane in layer_planes[1:-1]:
                crosses_plane = (
                    np.min(body_cell_z, axis=1) < plane - plane_tolerance
                ) & (
                    np.max(body_cell_z, axis=1) > plane + plane_tolerance
                )
                if np.any(crosses_plane):
                    raise RuntimeError(
                        "scoped layer-partitioned realization has tetrahedra crossing "
                        f"requested body plane z={plane:.17g} m"
                    )
            body_centroid_z = np.mean(body_cell_z, axis=1)
            for lower_plane, upper_plane in zip(layer_planes[:-1], layer_planes[1:], strict=True):
                in_partition = (
                    (body_centroid_z >= lower_plane - plane_tolerance)
                    & (body_centroid_z <= upper_plane + plane_tolerance)
                )
                if not np.any(in_partition):
                    raise RuntimeError(
                        "scoped layer-partitioned realization has an empty body layer "
                        f"[{lower_plane:.17g}, {upper_plane:.17g}] m"
                    )
            layer_plane_proof: dict[str, object] = {
                "_verification_token": _SCOPED_LAYER_PLANE_PROOF_TOKEN,
                "geometry_name": geometry.geometry_name,
                "requested_layer_partitions": int(n_layers),
                "resolved_layer_partitions": int(resolved_layers),
                "exact_plane_count": int(exact_plane_count),
                "layer_planes_m": [float(value) for value in layer_planes],
                "all_magnetic_nodes_on_requested_planes": True,
                "no_magnetic_tetrahedra_cross_requested_planes": True,
                "verification": "passed",
            }
        else:
            exact_plane_count = _count_exact_layer_planes(nodes[magnetic_nodes], 2)
            resolved_layers = exact_plane_count - 1
            if resolved_layers != n_layers:
                raise RuntimeError(
                    f"coincident ring realization requested {n_layers} layers but resolved {resolved_layers}"
                )
        result = MeshData(
            nodes=nodes,
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
            cell_mesh_parts=raw_mesh.cell_mesh_parts,
            periodic_boundary_pairs=_scale_periodic_boundary_pairs(
                raw_mesh.periodic_boundary_pairs,
                scale=SCALE,
            ),
            periodic_node_pairs=raw_mesh.periodic_node_pairs,
            periodic_mesh_certificate=None,
            quality=_quality_volumes_in_si(raw_mesh.quality, SCALE),
            per_domain_quality=(
                {marker: _quality_volumes_in_si(quality, SCALE)
                 for marker, quality in raw_mesh.per_domain_quality.items()}
                if raw_mesh.per_domain_quality is not None else None
            ),
        )
        result = _recertify_scaled_periodic_mesh(result)
        result.validate_strict(require_positive_orientation=True)
        if scoped_layer_partitioning:
            scoped_descriptors = [
                config
                for config in [*options.size_fields, *options.lower_bound_fields]
                if isinstance(config, dict)
                and isinstance(config.get("params"), dict)
                and isinstance(config["params"].get("GeometryName"), str)
            ]
            if not scoped_descriptors or any(
                config.get("_gmsh_status") != "applied"
                for config in scoped_descriptors
            ):
                raise RuntimeError(
                    "scoped layer-plane proof requires every component field to be applied"
                )
            for config in scoped_descriptors:
                config[_SCOPED_LAYER_PLANE_PROOF_KEY] = layer_plane_proof
        return result
    finally:
        gmsh.finalize()


def generate_swept_box_cylinder_ring_mesh(
    geometry: Difference,
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
    """Generate an exact-layer tet4 mesh for the canonical box-with-hole CSG.

    The magnetic source face is the rectangle with a circular hole and is
    extruded with ``n_layers`` fixed subdivisions.  ``recombine=False`` is
    intentional: the shared-domain FEM contract requires tet4/tri3 when
    periodic face pairs are present.  The GEO airbox is then added around the
    already extruded magnetic volume, preserving the CSG interface and the
    source z-planes while allowing Gmsh to tetrahedralize the air region.
    """
    components = _box_cylinder_ring_components(geometry)
    if components is None:
        raise ValueError(
            "swept ring meshing requires centered Box minus full-height Z-axis Cylinder"
        )
    base, tool = components
    opts = options or MeshOptions()
    if isinstance(n_layers, bool) or not isinstance(n_layers, numbers.Integral):
        raise TypeError("n_layers must be an integer")
    n_layers = int(n_layers)
    if n_layers < 1:
        raise ValueError("n_layers must be >= 1")
    if airbox is not None and n_layers not in (1, 2, 3):
        raise ValueError(
            "shared-domain swept ring meshing is qualified for exactly 1, 2, or 3 layers"
        )
    if isinstance(order, bool) or not isinstance(order, numbers.Integral):
        raise TypeError("order must be an integer")
    order = int(order)
    if order != 1:
        raise ValueError(
            f"swept ring meshing supports order=1; requested order={order}"
        )
    if distribution != DISTRIBUTION_FIXED or element_ratio != 1.0 or symmetric:
        raise ValueError(
            "swept ring meshing currently supports only fixed distribution"
        )
    if opts.sweep_face_meshing not in (None, "triangular") or recombine:
        raise ValueError(
            "swept ring meshing requires triangular, non-recombined source faces"
        )
    if opts.sweep_direction not in (None, "auto", "z"):
        raise ValueError("swept ring meshing supports only sweep_direction='z'")
    if airbox is not None and str(airbox.shape).strip().lower() != "bbox":
        raise ValueError("swept ring shared-domain meshing supports only a bbox airbox")
    if airbox is not None and int(airbox.boundary_marker) == 10:
        raise ValueError(
            "shared-domain interface and outer boundary markers must be distinct"
        )
    if isinstance(hmax, bool) or not math.isfinite(float(hmax)) or float(hmax) <= 0.0:
        raise ValueError("hmax must be finite and positive")
    hmax = float(hmax)
    if opts.hmin is not None and (
        isinstance(opts.hmin, bool)
        or not math.isfinite(float(opts.hmin))
        or float(opts.hmin) <= 0.0
    ):
        raise ValueError("hmin must be finite and positive")

    if airbox is not None:
        coincident_bounds = _coincident_ring_airbox_bounds(base, airbox)
        if coincident_bounds is not None:
            return _generate_coincident_ring_airbox_mesh(
                geometry,
                base=base,
                tool=tool,
                hmax=hmax,
                n_layers=n_layers,
                order=order,
                airbox=airbox,
                options=opts,
                bounds=coincident_bounds,
            )

    sx, sy, sz = (float(value) for value in base.size)
    radius = float(tool.radius)
    SCALE = 1.0e6
    sx_scaled, sy_scaled, sz_scaled = sx * SCALE, sy * SCALE, sz * SCALE
    r_scaled = radius * SCALE
    hmax_scaled = hmax * SCALE
    source_hmax_scaled = min(hmax_scaled, 2.0 * sz_scaled / n_layers)
    layer_heights = _compute_layer_heights(
        n_layers, sz, distribution, element_ratio, symmetric
    )
    cumulative: list[float] = []
    accumulated = 0.0
    for layer_height in layer_heights:
        accumulated += layer_height
        cumulative.append(accumulated)

    emit_progress(
        "Gmsh swept: box-cylinder ring "
        f"{sx:.2e}x{sy:.2e}x{sz:.2e}, hole r={radius:.2e}, "
        f"{n_layers} layers ({distribution})"
    )

    gmsh = _import_gmsh()
    gmsh_version = str(getattr(gmsh, "__version__", "unknown"))
    if airbox is not None and gmsh_version != _MIXED_SHARED_GMSH_VERSION:
        raise RuntimeError(
            "shared-domain swept ring meshing is qualified only for Gmsh "
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
        gmsh.model.add("fullmag_swept_box_cylinder_ring")

        z_bottom = -0.5 * sz_scaled
        p_outer = [
            gmsh.model.geo.addPoint(x, y, z_bottom, source_hmax_scaled)
            for x, y in (
                (-0.5 * sx_scaled, -0.5 * sy_scaled),
                (0.5 * sx_scaled, -0.5 * sy_scaled),
                (0.5 * sx_scaled, 0.5 * sy_scaled),
                (-0.5 * sx_scaled, 0.5 * sy_scaled),
            )
        ]
        outer_lines = [
            gmsh.model.geo.addLine(p_outer[index], p_outer[(index + 1) % 4])
            for index in range(4)
        ]
        p_center = gmsh.model.geo.addPoint(0.0, 0.0, z_bottom, source_hmax_scaled)
        p_right = gmsh.model.geo.addPoint(r_scaled, 0.0, z_bottom, source_hmax_scaled)
        p_top = gmsh.model.geo.addPoint(0.0, r_scaled, z_bottom, source_hmax_scaled)
        p_left = gmsh.model.geo.addPoint(-r_scaled, 0.0, z_bottom, source_hmax_scaled)
        p_bottom = gmsh.model.geo.addPoint(0.0, -r_scaled, z_bottom, source_hmax_scaled)
        arcs = [
            gmsh.model.geo.addCircleArc(p_right, p_center, p_top),
            gmsh.model.geo.addCircleArc(p_top, p_center, p_left),
            gmsh.model.geo.addCircleArc(p_left, p_center, p_bottom),
            gmsh.model.geo.addCircleArc(p_bottom, p_center, p_right),
        ]
        outer_loop = gmsh.model.geo.addCurveLoop(outer_lines)
        inner_loop = gmsh.model.geo.addCurveLoop([-arc for arc in reversed(arcs)])
        source_surface = gmsh.model.geo.addPlaneSurface([outer_loop, inner_loop])
        gmsh.model.geo.synchronize()

        source_field_ids: list[int] = []
        if opts.size_fields or opts.lower_bound_fields:
            source_field_ids.append(
                _apply_mixed_source_face_mesh_options(
                    gmsh,
                    source_surface=source_surface,
                    hmax_scaled=source_hmax_scaled,
                    order=order,
                    opts=opts,
                    hscale=SCALE,
                    source_geometry_name=geometry.geometry_name,
                )
            )
        else:
            gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 1)
            gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
            gmsh.option.setNumber("Mesh.CharacteristicLengthMax", source_hmax_scaled)
            gmsh.option.setNumber("Mesh.Algorithm", opts.algorithm_2d)
            if opts.hmin is not None:
                gmsh.option.setNumber("Mesh.CharacteristicLengthMin", opts.hmin * SCALE)
        gmsh.model.mesh.generate(2)

        extruded = gmsh.model.geo.extrude(
            [(2, source_surface)],
            0.0,
            0.0,
            sz_scaled,
            numElements=[1] * n_layers,
            heights=cumulative,
            recombine=False,
        )
        gmsh.model.geo.synchronize()
        body_volumes = [int(tag) for dim, tag in extruded if int(dim) == 3]
        if len(body_volumes) != 1:
            body_volumes = [int(tag) for dim, tag in gmsh.model.getEntities(3)]
        if len(body_volumes) != 1:
            raise RuntimeError(
                "swept ring extrusion must produce exactly one magnetic volume"
            )
        body_volume = body_volumes[0]
        body_surfaces = sorted(
            {
                abs(int(tag))
                for dim, tag in gmsh.model.getBoundary(
                    [(3, body_volume)], oriented=False
                )
                if int(dim) == 2
            }
        )
        if not body_surfaces:
            raise RuntimeError("swept ring extrusion produced no magnetic surfaces")

        airbox_field_id: int | None = None
        airbox_scaled: AirboxOptions | None = None
        outer_surfaces: list[int] = []
        if airbox is not None:
            from ._gmsh_generators import _scale_airbox_options

            airbox_scaled = _scale_airbox_options(airbox, SCALE)
            airbox_field_id = _add_airbox_geo(
                gmsh,
                [body_volume],
                body_surfaces,
                airbox_scaled,
                hmax_scaled,
                mesh_options=None,
            )
            outer_surfaces = [
                int(tag)
                for tag in gmsh.model.getEntitiesForPhysicalGroup(
                    2, int(airbox_scaled.boundary_marker)
                )
            ]

        from ._gmsh_occ import (
            _add_periodic_boundary_physical_groups,
            _configure_axis_periodic_surfaces,
            _scale_periodic_boundary_pairs,
        )

        periodic_candidates = outer_surfaces or [
            int(tag)
            for dim, tag in gmsh.model.getEntities(2)
            if int(dim) == 2
        ]
        periodic_pair_specs = _configure_axis_periodic_surfaces(
            gmsh,
            surface_tags=periodic_candidates,
            pair_ids=list(opts.periodic_pair_ids),
        )
        periodic_surface_tags = _add_periodic_boundary_physical_groups(
            gmsh,
            periodic_pair_specs,
            reserved_markers=(
                {10, int(airbox_scaled.boundary_marker)}
                if airbox_scaled is not None
                else {1}
            ),
        )

        def _replace_surface_group(
            marker: int,
            tags: list[int],
            name: str,
        ) -> None:
            try:
                gmsh.model.removePhysicalGroups([(2, int(marker))])
            except Exception:
                # Older Gmsh builds may not expose group removal.  In that
                # case the caller still gets a fail-closed extraction below
                # if overlapping groups duplicate boundary facets.
                pass
            if tags:
                gmsh.model.addPhysicalGroup(2, tags, tag=int(marker))
                gmsh.model.setPhysicalName(2, int(marker), name)

        if airbox_scaled is not None:
            _replace_surface_group(
                int(airbox_scaled.boundary_marker),
                [tag for tag in outer_surfaces if tag not in periodic_surface_tags],
                "Gamma_out",
            )
            _replace_surface_group(
                10,
                [tag for tag in body_surfaces if tag not in periodic_surface_tags],
                "mag_air_interface",
            )

        final_options = _dc_replace(
            opts,
            size_fields=(
                list(opts.size_fields)
                if opts.lower_bound_fields
                or any(
                    isinstance(config, dict)
                    and config.get("kind") in _PLANE_PROJECTED_UPPER_KINDS
                    for config in opts.size_fields
                )
                else []
            ),
        )
        preexisting_field_ids = list(source_field_ids)
        cap_field = _add_swept_exact_plane_cap_field(
            gmsh,
            opts=final_options,
            geometry_name=geometry.geometry_name,
            body_volumes=[body_volume],
            source_z=-0.5 * sz,
            thickness=sz,
            n_layers=n_layers,
            neutral_size=hmax,
            hscale=SCALE,
        )
        if cap_field is not None:
            preexisting_field_ids.append(int(cap_field))
        if airbox_field_id is not None:
            preexisting_field_ids.append(int(airbox_field_id))
        _apply_mesh_options(
            gmsh,
            hmax_scaled,
            order,
            final_options,
            hscale=SCALE,
            preexisting_field_ids=preexisting_field_ids,
            airbox_maximum_element_size=(
                airbox_scaled.maximum_element_size
                if airbox_scaled is not None
                else None
            ),
            component_volume_tags={geometry.geometry_name: [body_volume]},
            component_surface_tags={geometry.geometry_name: body_surfaces},
        )
        with _GmshProgressLogger(gmsh):
            gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)

        quality, _per_domain_quality = (
            _extract_quality_metrics(gmsh, opts)
            if opts.compute_quality
            else (None, None)
        )
        raw_mesh = _extract_mesh_data(
            gmsh,
            quality=quality,
            has_physical_groups=airbox_scaled is not None,
            periodic_pair_specs=periodic_pair_specs,
            boundary_role_markers=(
                (10, int(airbox_scaled.boundary_marker))
                if airbox_scaled is not None
                else None
            ),
        )
        if any(kind != "tet4" for kind in raw_mesh.cell_types.tolist()):
            raise RuntimeError(
                "swept ring shared-domain realization requires tet4 volume cells; "
                f"Gmsh produced {sorted(set(raw_mesh.cell_types.tolist()))}"
            )
        if any(kind != "tri3" for kind in raw_mesh.facet_types.tolist()):
            raise RuntimeError(
                "swept ring shared-domain realization requires tri3 boundary facets; "
                f"Gmsh produced {sorted(set(raw_mesh.facet_types.tolist()))}"
            )

        nodes = np.asarray(raw_mesh.nodes, dtype=np.float64) / SCALE
        elements = raw_mesh.elements
        magnetic_mask = np.asarray(raw_mesh.element_markers, dtype=np.int32) == 1
        if not np.any(magnetic_mask):
            raise RuntimeError("swept ring realization produced no magnetic cells")
        magnetic_nodes = np.unique(elements[magnetic_mask].reshape(-1))
        resolved_layers = _count_exact_layer_planes(nodes[magnetic_nodes], 2) - 1
        if resolved_layers != n_layers:
            raise RuntimeError(
                "swept ring realization requested "
                f"{n_layers} layers but resolved {resolved_layers}"
            )

        result = MeshData(
            nodes=nodes,
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
            cell_mesh_parts=raw_mesh.cell_mesh_parts,
            periodic_boundary_pairs=_scale_periodic_boundary_pairs(
                raw_mesh.periodic_boundary_pairs,
                scale=SCALE,
            ),
            periodic_node_pairs=raw_mesh.periodic_node_pairs,
            periodic_mesh_certificate=None,
            quality=_quality_volumes_in_si(raw_mesh.quality, SCALE),
            per_domain_quality=(
                {marker: _quality_volumes_in_si(quality, SCALE)
                 for marker, quality in raw_mesh.per_domain_quality.items()}
                if raw_mesh.per_domain_quality is not None else None
            ),
        )
        result = _recertify_scaled_periodic_mesh(result)
        result.validate_strict(require_positive_orientation=True)
        emit_progress(
            "Gmsh swept ring realization: "
            f"layers={resolved_layers}, nodes={result.n_nodes}, "
            f"cells={result.n_elements}, facets={result.n_boundary_faces}, "
            f"periodic_pairs={len(result.periodic_boundary_pairs)}"
        )
        return result
    finally:
        gmsh.finalize()

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
    geometry_name: str | None = None,
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
            radius,
            height,
            hmax,
            order=order,
            airbox=airbox,
            options=options,
            geometry_name=geometry_name,
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

        if opts.lower_bound_fields:
            body_volumes = [
                int(tag) for dim, tag in extrude_result if int(dim) == 3
            ]
            component_volume_tags = (
                {geometry_name: body_volumes}
                if isinstance(geometry_name, str)
                and geometry_name.strip()
                and body_volumes
                else None
            )
            component_surface_tags = None
            if component_volume_tags is not None:
                component_surface_tags = {
                    geometry_name: sorted(
                        {
                            abs(int(tag))
                            for dim, tag in gmsh.model.getBoundary(
                                [(3, volume) for volume in body_volumes],
                                oriented=False,
                            )
                            if int(dim) == 2
                        }
                    )
                }
            _apply_mesh_options(
                gmsh,
                hmax_scaled,
                order,
                opts,
                hscale=SCALE,
                component_volume_tags=component_volume_tags,
                component_surface_tags=component_surface_tags,
            )

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

        # The historical cylinder generator keeps a tet4 compatibility view
        # after Gmsh extrusion (prism6/hex8 cells are split into tetrahedra).
        # Preserve that route for callers that still need it, but make the
        # topology downgrade durable and machine-readable instead of silently
        # presenting it as a native swept prism.
        resolved_layers = _count_exact_layer_planes(nodes, 2) - 1
        if resolved_layers < 1:
            raise RuntimeError(
                "swept cylinder realization produced no usable z layer planes"
            )
        realization_fallbacks = [
            "swept_cylinder_recombined_to_tet4"
            if recombine
            else "swept_cylinder_to_tet4"
        ]
        if int(order) != 1:
            realization_fallbacks.append("swept_order_to_linear")
        if resolved_layers != int(n_layers):
            realization_fallbacks.append("swept_layer_count_mismatch")
        realization_report = MeshRealizationReport(
            requested_topology="hex8" if recombine else "prism6",
            resolved_topology="tet4",
            requested_layers=int(n_layers),
            resolved_layers=int(resolved_layers),
            requested_axis="z",
            resolved_axis="z",
            requested_order=int(order),
            resolved_order=1,
            fallbacks_triggered=tuple(realization_fallbacks),
            requested_direction=(
                opts.sweep_direction
                if opts.sweep_direction in {"auto", "x", "y", "z"}
                else "z"
            ),
        )

        return MeshData.from_legacy_tet4(
            nodes=nodes,
            elements=elements,
            element_markers=element_markers,
            boundary_faces=boundary_faces,
            boundary_markers=boundary_markers,
            periodic_boundary_pairs=periodic_boundary_pairs,
            periodic_node_pairs=periodic_node_pairs,
            quality=quality,
            realization_report=realization_report,
        )
    finally:
        gmsh.finalize()


def _mixed_v2_axis_basis(axis: Sequence[float]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return an orthonormal (u, v, axis) frame for a circular annulus."""
    normal = np.asarray(axis, dtype=np.float64)
    norm = float(np.linalg.norm(normal))
    if not math.isfinite(norm) or norm <= 0.0:
        raise ValueError("mixed v2 ring axis must be finite and nonzero")
    normal /= norm
    reference = np.asarray((1.0, 0.0, 0.0), dtype=np.float64)
    if abs(float(np.dot(reference, normal))) > 0.9:
        reference = np.asarray((0.0, 1.0, 0.0), dtype=np.float64)
    first = np.cross(normal, reference)
    first /= float(np.linalg.norm(first))
    second = np.cross(normal, first)
    second /= float(np.linalg.norm(second))
    return first, second, normal


def _mixed_v2_body_aabb(
    *,
    center: np.ndarray,
    axis: np.ndarray,
    radius: float,
    height: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Return the conservative exact AABB of a finite circular cylinder."""
    half_height = 0.5 * float(height)
    radial = float(radius) * np.sqrt(np.maximum(0.0, 1.0 - axis * axis))
    extent = radial + half_height * np.abs(axis)
    return center - extent, center + extent


def _mixed_v2_cell_volume(family: str, coordinates: NDArray[np.float64]) -> float:
    """Compute a positive geometric cell volume without a topology downgrade."""
    jacobians = _cell_jacobian_determinants(family, coordinates)
    if family == "tet4":
        return abs(float(jacobians[0])) / 6.0
    if family == "prism6":
        # The reference triangular prism has unit volume.  The quadrature
        # samples used by the quality proof therefore integrate det(J)
        # directly for the linear prism map.
        return abs(float(np.mean(jacobians)))
    if family == "pyramid5":
        base = coordinates[:4]
        apex = coordinates[4]
        triangles = ((0, 1, 2), (0, 2, 3))
        return float(sum(
            abs(float(np.linalg.det(np.stack((base[j] - base[i], base[k] - base[i], apex - base[i]), axis=1)))) / 6.0
            for i, j, k in triangles
        ))
    raise ValueError(f"mixed v2 volume does not support {family}")


def _mixed_v2_cell_volume_batch(
    family: str,
    coordinates: NDArray[np.float64],
    jacobians: NDArray[np.float64],
) -> NDArray[np.float64]:
    """Evaluate ``_mixed_v2_cell_volume`` for ``(M, k, 3)`` cells.

    ``jacobians`` is ``_cell_jacobian_determinants_batch`` of the same cells.
    Each row follows the scalar operation order, so the volumes are
    bit-identical to the per-cell reference.
    """
    if family == "tet4":
        return np.abs(jacobians[:, 0]) / 6.0
    if family == "prism6":
        return np.abs(np.mean(jacobians, axis=1))
    if family == "pyramid5":
        base = coordinates[:, :4]
        apex = coordinates[:, 4]
        volume = np.zeros(coordinates.shape[0], dtype=np.float64)
        for i, j, k in ((0, 1, 2), (0, 2, 3)):
            matrix = np.stack((base[:, j] - base[:, i], base[:, k] - base[:, i], apex - base[:, i]), axis=2)
            volume = volume + np.abs(np.linalg.det(matrix)) / 6.0
        return volume
    raise ValueError(f"mixed v2 volume does not support {family}")


def _mixed_v2_node_order_digest(node_ids: NDArray[np.int32]) -> str:
    ordered = np.asarray(node_ids, dtype=np.int64).reshape(-1)
    payload = b"fullmag:fem-body-node-order:v1" + struct.pack("<I", int(ordered.size))
    payload += b"".join(struct.pack("<Q", int(node)) for node in ordered.tolist())
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


def _mixed_v2_face_incidence(mesh: MeshData) -> MixedFaceIncidence:
    """Group every cell face and explicit facet by its exact node-id set."""
    return build_mixed_face_incidence(
        node_count=mesh.n_nodes,
        cell_types=mesh.cell_types,
        cell_offsets=mesh.cell_offsets,
        cell_nodes=mesh.cell_nodes,
        local_facets=_MIXED_CELL_LOCAL_FACETS,
        facet_offsets=mesh.facet_offsets,
        facet_nodes=mesh.facet_nodes,
    )


def _mixed_v2_cell_nodes_where(mesh: MeshData, mask: NDArray[np.bool_]) -> NDArray[np.int32]:
    """Return the sorted unique node ids of the cells selected by ``mask``."""
    return np.unique(mesh.cell_nodes[np.repeat(mask, np.diff(mesh.cell_offsets))])


def _mixed_v2_transition_interface_tri3_count(
    mesh: MeshData, incidence: MixedFaceIncidence
) -> int:
    """Count tri3 faces owned by exactly one transition and one far-air cell."""
    face_of_member = np.repeat(
        np.arange(incidence.arity.size, dtype=np.int64), np.diff(incidence.offsets)
    )
    selected = (
        (incidence.members >= 0)
        & (incidence.cell_owner_counts[face_of_member] == 2)
        & (incidence.arity[face_of_member] == 3)
    )
    # Cell members of one face stay contiguous after filtering, so each row
    # is the owner pair of one two-owner face.
    parts = mesh.cell_mesh_parts[incidence.members[selected]].reshape(-1, 2)
    transition = parts == "transition_air"
    far = parts == "far_air"
    return int(np.count_nonzero((transition[:, 0] & far[:, 1]) | (far[:, 0] & transition[:, 1])))


def _mixed_v2_conformity_counts(
    mesh: MeshData, incidence: MixedFaceIncidence | None = None
) -> dict[str, int]:
    """Check exact shared-node face ownership and explicit boundary coverage."""
    if incidence is None:
        incidence = _mixed_v2_face_incidence(mesh)
    nonmanifold = int(np.count_nonzero(incidence.cell_owner_counts > 2))
    orphan = int(np.count_nonzero((incidence.cell_owner_counts == 1) & (incidence.explicit_counts == 0)))
    # A face is conforming by construction when it has one exact node-id set
    # and at most two owners.  Gmsh's physical interface group then provides
    # the marker proof; no geometric tolerance is used to hide a mismatch.
    return {
        "nonconforming_face_count": 0,
        "orphan_face_count": int(orphan),
        "nonmanifold_face_count": int(nonmanifold),
        "coincident_interface_face_count": 0,
    }


def _mixed_v2_airbox_mesh_size_limits_m(
    *,
    airbox: AirboxOptions,
    box_hmax_m: float,
    ring_hmax_m: float,
) -> tuple[float, float]:
    """Resolve the shared mixed-V2 air sizing policy in SI units.

    The magnetic owners keep their own upper targets while the air domain
    grades from the authored interface minimum to the authored far-air
    maximum.  A far-air target below a magnetic target is raised to the
    largest owner target so the global Gmsh ceiling cannot clip a body.
    """
    body_hmax = max(float(box_hmax_m), float(ring_hmax_m))
    body_hmin = min(float(box_hmax_m), float(ring_hmax_m))
    if not math.isfinite(body_hmax) or body_hmax <= 0.0:
        raise ValueError("mixed v2 body mesh targets must be finite and positive")
    if not math.isfinite(body_hmin) or body_hmin <= 0.0:
        raise ValueError("mixed v2 body mesh targets must be finite and positive")

    h_inner = (
        float(airbox.minimum_element_size)
        if airbox.minimum_element_size is not None
        else body_hmin
    )
    requested_outer = (
        float(airbox.maximum_element_size)
        if airbox.maximum_element_size is not None
        else body_hmax * max(float(airbox.grading_ratio), 1.0) ** 4
    )
    h_outer = max(body_hmax, requested_outer)
    if (
        not math.isfinite(h_inner)
        or h_inner <= 0.0
        or not math.isfinite(h_outer)
        or h_outer <= 0.0
        or h_inner > h_outer
    ):
        raise ValueError(
            "mixed v2 airbox minimum/maximum element sizes must be finite, "
            "positive, and ordered"
        )
    return h_inner, h_outer


def _configure_disconnected_mixed_v2_mesh_size_fields(
    gmsh: Any,
    *,
    interface_surface_tags: Sequence[int],
    air_volume_tags: Sequence[int],
    body_volume_targets: Mapping[str, tuple[Sequence[int], float]],
    object_bounds_min_m: Sequence[float],
    object_bounds_max_m: Sequence[float],
    airbox_bounds_min_m: Sequence[float],
    airbox_bounds_max_m: Sequence[float],
    box_hmax_m: float,
    ring_hmax_m: float,
    airbox: AirboxOptions,
    options: MeshOptions,
    scale: float,
) -> tuple[float, float]:
    """Install scoped body limits and graded far-air sizing for mixed V2.

    The returned targets are also consumed by the shell policy.  Air grading
    is restricted to transition/far-air volumes, while one owner field per
    magnetic body preserves its independent hmax.  All fields are composed
    once so the two visible Gmsh stages use the same background policy.
    """
    if not interface_surface_tags:
        raise ValueError("mixed v2 air grading requires magnetic interface surfaces")
    if not air_volume_tags:
        raise ValueError("mixed v2 air grading requires air volume tags")
    if not body_volume_targets:
        raise ValueError("mixed v2 sizing requires magnetic body volume targets")
    if not math.isfinite(float(scale)) or float(scale) <= 0.0:
        raise ValueError("mixed v2 mesh-size scale must be finite and positive")

    h_inner_m, h_outer_m = _mixed_v2_airbox_mesh_size_limits_m(
        airbox=airbox,
        box_hmax_m=box_hmax_m,
        ring_hmax_m=ring_hmax_m,
    )
    h_inner_scaled = h_inner_m * float(scale)
    h_outer_scaled = h_outer_m * float(scale)
    object_min_scaled = [float(value) * float(scale) for value in object_bounds_min_m]
    object_max_scaled = [float(value) * float(scale) for value in object_bounds_max_m]
    airbox_min_scaled = [float(value) * float(scale) for value in airbox_bounds_min_m]
    airbox_max_scaled = [float(value) * float(scale) for value in airbox_bounds_max_m]
    air_spans = [
        airbox_max_scaled[index] - airbox_min_scaled[index]
        for index in range(3)
    ]
    if len(object_min_scaled) != 3 or len(object_max_scaled) != 3 or len(air_spans) != 3:
        raise ValueError("mixed v2 airbox bounds must contain three coordinates")
    if any(not math.isfinite(value) or value <= 0.0 for value in air_spans):
        raise ValueError("mixed v2 airbox bounds must have positive spans")

    _set_mixed_volume_mesh_size_options(
        gmsh,
        maximum_element_size_scaled=h_outer_scaled,
    )
    # The background fields below are authoritative.  Point sizes on the
    # outer GEO box are retained for construction but must not force their
    # magnetic hmax through the far-air volume.
    gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)

    air_field = _add_airbox_grading_field(
        gmsh,
        surface_tags=interface_surface_tags,
        h_inner=h_inner_scaled,
        h_outer=h_outer_scaled,
        grading_ratio=float(airbox.grading_ratio),
        grading_mode=str(airbox.grading_mode),
        dist_max=max(h_inner_scaled, min(air_spans)),
        object_bounds_min=object_min_scaled,
        object_bounds_max=object_max_scaled,
        airbox_bounds_min=airbox_min_scaled,
        airbox_bounds_max=airbox_max_scaled,
        airbox_shape="bbox",
        air_volume_tags=air_volume_tags,
    )

    body_fields: list[int] = []
    component_volume_tags: dict[str, list[int]] = {}
    for geometry_name, (volume_tags, body_hmax_m) in body_volume_targets.items():
        volumes = sorted({int(tag) for tag in volume_tags})
        if not volumes:
            raise ValueError(
                f"mixed v2 body target {geometry_name!r} has no volume tags"
            )
        body_hmax_scaled = float(body_hmax_m) * float(scale)
        if not math.isfinite(body_hmax_scaled) or body_hmax_scaled <= 0.0:
            raise ValueError(
                f"mixed v2 body target {geometry_name!r} is invalid"
            )
        component_volume_tags[str(geometry_name)] = volumes
        owner_field = gmsh.model.mesh.field.add("Constant")
        gmsh.model.mesh.field.setNumbers(owner_field, "VolumesList", volumes)
        gmsh.model.mesh.field.setNumber(owner_field, "VIn", body_hmax_scaled)
        gmsh.model.mesh.field.setNumber(
            owner_field,
            "VOut",
            max(body_hmax_scaled, h_outer_scaled),
        )
        gmsh.model.mesh.field.setNumber(owner_field, "IncludeBoundary", 1)
        restricted = gmsh.model.mesh.field.add("Restrict")
        gmsh.model.mesh.field.setNumber(restricted, "InField", owner_field)
        gmsh.model.mesh.field.setNumbers(restricted, "VolumesList", volumes)
        gmsh.model.mesh.field.setNumber(restricted, "IncludeBoundary", 1)
        body_fields.append(int(restricted))

    upper_fields = [*body_fields]
    if air_field is not None:
        upper_fields.insert(0, int(air_field))
    _configure_mesh_size_fields(
        gmsh,
        [],
        hscale=float(scale),
        extra_field_ids=upper_fields,
        component_volume_tags=component_volume_tags,
        lower_bound_fields=options.lower_bound_fields,
        default_upper_size=h_outer_m,
    )
    return h_inner_m, h_outer_m


def _mixed_v2_transition_shell_parameters_m(
    *,
    box_size_m: Sequence[float],
    airbox_size_m: Sequence[float],
    gap_m: float,
    box_hmax_m: float,
    ring_hmax_m: float,
    airbox: AirboxOptions,
) -> tuple[float, float]:
    """Resolve the deterministic transition shell in SI units.

    The generator historically resolved this after converting all geometry to
    micrometres.  Keeping the calculation in one helper prevents the planner
    and certificate from disagreeing about the shell thickness while retaining
    the existing bounded shell policy.
    """
    box_size = np.asarray(box_size_m, dtype=np.float64)
    airbox_size = np.asarray(airbox_size_m, dtype=np.float64)
    if box_size.shape != (3,) or airbox_size.shape != (3,):
        raise ValueError("mixed v2 shell sizes must contain three values")
    clearance_limit = min(
        float(np.min(0.5 * (airbox_size - box_size)))
        if np.all(airbox_size > box_size)
        else 0.0,
        0.45 * float(gap_m),
    )
    h_inner, h_outer = _mixed_v2_airbox_mesh_size_limits_m(
        airbox=airbox,
        box_hmax_m=box_hmax_m,
        ring_hmax_m=ring_hmax_m,
    )
    return _mixed_transition_shell_parameters(
        h_outer=h_outer,
        h_inner=h_inner,
        hmax=float(box_hmax_m),
        clearance_limit=clearance_limit,
        grading_ratio=float(airbox.grading_ratio),
    )


_MIXED_V2_INTERFACE_TRIANGLES = {
    "tri3": ((0, 1, 2),),
    "quad4": ((0, 1, 2), (0, 2, 3)),
}


def _mixed_v2_interface_facet_signed_volumes(
    mesh: MeshData,
    incidence: MixedFaceIncidence,
    interface: NDArray[np.int64],
    *,
    magnetic_markers: tuple[int, ...],
) -> tuple[NDArray[np.int64], NDArray[np.float64]]:
    """Return the magnetic owner and outward signed volume of each facet.

    Each facet's triangles are oriented away from its single magnetic owner
    and integrated as ``det(p_i, p_j, p_k) / 6``.  Every per-facet operation
    keeps the scalar reference layout; a batched orientation dot whose sign is
    not certain is re-evaluated with the scalar ``np.dot``.
    """
    members = incidence.members
    is_cell = members >= 0
    member_markers = mesh.element_markers[np.where(is_cell, members, 0)]
    magnetic = is_cell & np.isin(member_markers, np.asarray(magnetic_markers))
    face_starts = incidence.offsets[:-1]
    magnetic_counts = np.add.reduceat(magnetic.astype(np.int64), face_starts)
    magnetic_owner = np.add.reduceat(np.where(magnetic, members, 0), face_starts)

    faces = incidence.facet_face[interface]
    families = mesh.facet_types[interface]
    owner_valid = magnetic_counts[faces] == 1
    family_valid = np.isin(families, np.asarray(tuple(_MIXED_V2_INTERFACE_TRIANGLES)))
    invalid = np.flatnonzero(~(owner_valid & family_valid))
    if invalid.size:
        first = int(invalid[0])
        if not owner_valid[first]:
            raise RuntimeError(
                "mixed v2 magnetic interface facet does not have exactly one "
                "magnetic owner"
            )
        raise RuntimeError(
            f"mixed v2 magnetic interface has unsupported facet family {str(families[first])!r}"
        )

    owners = magnetic_owner[faces]
    owner_starts = mesh.cell_offsets[owners]
    owner_arities = mesh.cell_offsets[owners + 1] - owner_starts
    facet_starts = mesh.facet_offsets[interface]
    signed = np.empty(interface.size, dtype=np.float64)
    for family, triangles in _MIXED_V2_INTERFACE_TRIANGLES.items():
        facet_arity = len(triangles) + 2
        for owner_arity in np.unique(owner_arities[families == family]).tolist():
            rows = np.flatnonzero((families == family) & (owner_arities == owner_arity))
            points = mesh.nodes[
                mesh.facet_nodes[facet_starts[rows][:, np.newaxis] + np.arange(facet_arity)]
            ]
            owner_points = mesh.nodes[
                mesh.cell_nodes[owner_starts[rows][:, np.newaxis] + np.arange(owner_arity)]
            ]
            offset = np.mean(points, axis=1) - np.mean(owner_points, axis=1)
            value = np.zeros(rows.size, dtype=np.float64)
            for i, j, k in triangles:
                normal = np.cross(points[:, j] - points[:, i], points[:, k] - points[:, i])
                dot = np.einsum("ij,ij->i", normal, offset)
                uncertain = np.abs(dot) <= 1.0e-10 * (
                    np.linalg.norm(normal, axis=1) * np.linalg.norm(offset, axis=1)
                )
                for row in np.flatnonzero(uncertain).tolist():
                    dot[row] = float(np.dot(normal[row], offset[row]))
                swap = (dot < 0.0)[:, np.newaxis]
                second = np.where(swap, points[:, k], points[:, j])
                third = np.where(swap, points[:, j], points[:, k])
                value = value + np.linalg.det(np.stack((points[:, i], second, third), axis=2)) / 6.0
            signed[rows] = value
    return owners, signed


def _mixed_v2_closed_faceted_magnetic_volume(
    mesh: MeshData, incidence: MixedFaceIncidence | None = None
) -> float:
    """Integrate the closed, realized body boundary as an independent oracle.

    A curved annulus is represented by a faceted surface in the extracted
    linear mesh.  Comparing cell volume with the analytic BRep volume would
    therefore measure geometry approximation and reject ordinary valid meshes.
    The v2 integrity proof compares the volume cells with the closed realized
    interface facets instead; the BRep approximation remains a separate
    convergence concern for the caller.
    """
    if incidence is None:
        incidence = _mixed_v2_face_incidence(mesh)

    volumes_by_marker: dict[int, float] = {1: 0.0, 2: 0.0}
    seen_by_marker: dict[int, int] = {1: 0, 2: 0}
    interface = np.flatnonzero(
        (mesh.facet_roles == "material_interface")
        & (mesh.boundary_markers == MIXED_INTERFACE_MARKER)
    )
    if interface.size:
        owners, signed = _mixed_v2_interface_facet_signed_volumes(
            mesh, incidence, interface, magnetic_markers=tuple(volumes_by_marker)
        )
        # Accumulate in facet order so the sums match the per-facet reference.
        for owner_marker, value in zip(
            mesh.element_markers[owners].tolist(), signed.tolist(), strict=True
        ):
            volumes_by_marker[int(owner_marker)] += value
            seen_by_marker[int(owner_marker)] += 1
    if any(seen_by_marker[marker] == 0 for marker in volumes_by_marker):
        raise RuntimeError("mixed v2 magnetic interface facets are incomplete")
    volumes = [abs(value) for value in volumes_by_marker.values()]
    if not all(math.isfinite(value) and value > 0.0 for value in volumes):
        raise RuntimeError("mixed v2 closed faceted magnetic volume is invalid")
    return float(sum(volumes))


def attach_disconnected_mixed_p1_certificate_v2(
    mesh: MeshData,
    *,
    body_object_ids: tuple[str, str],
    body_bounds_min_m: tuple[float, float, float],
    body_bounds_max_m: tuple[float, float, float],
    expected_magnetic_volume_m3: float,
    airbox_bounds_min_m: tuple[float, float, float],
    airbox_bounds_max_m: tuple[float, float, float],
    requested_axis: int,
    requested_layers: int,
    requested_direction: str | None,
    body_gap_m: float,
    transition_shell_thickness_m: float,
    body_material_fields: Mapping[str, Mapping[str, object]],
    gmsh_version: str = _MIXED_SHARED_GMSH_VERSION,
    effective_gmsh_thread_count: int = 1,
    requested_algorithm_3d: int = 1,
    transition_algorithm_3d: int = 1,
    tetrahedral_algorithm_3d: int = 1,
    optimizer: str | None = None,
    optimizer_iterations: int = 0,
) -> MeshData:
    """Bind the complete v2 ownership and shared-domain proof to a mesh."""
    if mesh.cell_mesh_parts.shape != (mesh.n_elements,):
        raise RuntimeError("mixed v2 certificate requires a mesh part for every cell")
    if len(body_object_ids) != 2 or len(set(body_object_ids)) != 2:
        raise ValueError("mixed v2 certificate requires two distinct body object IDs")
    if requested_axis not in (0, 1, 2) or requested_layers not in (1, 2, 3):
        raise ValueError("mixed v2 certificate exact sweep controls are invalid")
    if not math.isfinite(body_gap_m) or body_gap_m <= 0.0:
        raise ValueError("mixed v2 certificate requires a positive body gap")
    if set(body_material_fields) != set(body_object_ids):
        raise ValueError("mixed v2 certificate material field coverage is incomplete")
    with indeterminate_progress_phase(
        phase="postprocessing",
        progress_label="fingerprinting mixed-domain topology",
        message=f"Fingerprinting mixed-domain topology ({mesh.n_elements} cells)",
    ):
        topology_fingerprint = mesh.topology_fingerprint_v3()
    resolved_direction = "xyz"[requested_axis]
    requested_direction = requested_direction if requested_direction in {"auto", "x", "y", "z"} else resolved_direction

    marker_counts: dict[str, dict[str, int]] = {}
    part_counts: dict[str, dict[str, int]] = {}
    for family, marker, part in zip(mesh.cell_types.tolist(), mesh.element_markers.tolist(), mesh.cell_mesh_parts.tolist(), strict=True):
        by_marker = marker_counts.setdefault(str(int(marker)), {})
        by_marker[str(family)] = by_marker.get(str(family), 0) + 1
        by_part = part_counts.setdefault(str(part), {})
        by_part[str(family)] = by_part.get(str(family), 0) + 1
    if set(marker_counts) != {"0", "1", "2"}:
        raise RuntimeError("mixed v2 mesh must contain air marker 0 and body markers 1 and 2")
    if any(part != "magnetic" and marker != 0 for marker, part in zip(mesh.element_markers.tolist(), mesh.cell_mesh_parts.tolist(), strict=True)):
        raise RuntimeError("mixed v2 mesh contains a nonzero air marker")
    facet_counts: dict[str, dict[str, int]] = {}
    for family, role, marker in zip(mesh.facet_types.tolist(), mesh.facet_roles.tolist(), mesh.boundary_markers.tolist(), strict=True):
        key = f"{role}:{int(marker)}"
        by_family = facet_counts.setdefault(key, {})
        by_family[str(family)] = by_family.get(str(family), 0) + 1

    cell_volumes = np.zeros(mesh.n_elements, dtype=np.float64)
    jacobians: dict[str, list[NDArray[np.float64]]] = {}
    scaled: dict[str, list[NDArray[np.float64]]] = {}
    with indeterminate_progress_phase(
        phase="postprocessing",
        progress_label="checking mixed-domain element quality",
        message=f"Checking cell volumes and Jacobians ({mesh.n_elements} cells)",
    ):
        checked = 0
        for family, ordinals, coordinates in _iter_cell_family_batches(mesh):
            determinants = _cell_jacobian_determinants_batch(family, coordinates)
            cell_volumes[ordinals] = _mixed_v2_cell_volume_batch(family, coordinates, determinants)
            jacobians.setdefault(family, []).append(determinants.reshape(-1))
            scaled.setdefault(family, []).append(_mixed_cell_scaled_jacobians_batch(family, coordinates).reshape(-1))
            checked += ordinals.size
            emit_progress(f"Cell volume and Jacobian checks: {checked}/{mesh.n_elements}")
    if not np.all(np.isfinite(cell_volumes)) or np.any(cell_volumes <= 0.0):
        raise RuntimeError("mixed v2 mesh contains nonpositive cell volume")
    jacobian_values = {family: np.concatenate(blocks) for family, blocks in sorted(jacobians.items())}
    scaled_values = {family: np.concatenate(blocks) for family, blocks in sorted(scaled.items())}
    jacobian_minima = {family: float(np.min(values)) for family, values in jacobian_values.items()}
    scaled_minima = {family: float(np.min(values)) for family, values in scaled_values.items()}
    scaled_p05 = {family: float(np.percentile(values, 5.0)) for family, values in scaled_values.items()}
    if any(value < MIXED_SCALED_JACOBIAN_P05_MIN for value in scaled_p05.values()):
        raise RuntimeError("mixed v2 mesh scaled Jacobian p05 is below the qualified minimum")

    magnetic_mask = np.isin(mesh.element_markers, np.asarray([1, 2], dtype=np.int32))
    magnetic_nodes = _mixed_v2_cell_nodes_where(mesh, magnetic_mask)
    # The shared exact-layer evidence belongs to the swept prism body.  The
    # second body is an independent annulus tetrahedral mesh and naturally
    # contains many coordinates along the requested axis; combining its
    # coordinates here would make a valid one-layer Box appear to have a
    # non-deterministic layer count.
    swept_nodes = _mixed_v2_cell_nodes_where(mesh, mesh.element_markers == 1)
    body_bounds: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    for marker in (1, 2):
        nodes = _mixed_v2_cell_nodes_where(mesh, mesh.element_markers == marker)
        if nodes.size == 0:
            raise RuntimeError(f"mixed v2 body marker {marker} has no mesh nodes")
        body_bounds[marker] = (
            np.min(mesh.nodes[nodes], axis=0),
            np.max(mesh.nodes[nodes], axis=0),
        )
    body_a_min, body_a_max = body_bounds[1]
    body_b_min, body_b_max = body_bounds[2]
    realized_gap_components = np.maximum(
        np.maximum(body_a_min - body_b_max, body_b_min - body_a_max),
        0.0,
    )
    realized_body_gap_m = float(np.linalg.norm(realized_gap_components))
    if not math.isfinite(realized_body_gap_m) or realized_body_gap_m <= 0.0:
        raise RuntimeError(
            "mixed v2 realized mesh body AABBs are overlapping or touching"
        )
    realized_magnetic_min = tuple(float(value) for value in np.min(mesh.nodes[magnetic_nodes], axis=0))
    realized_magnetic_max = tuple(float(value) for value in np.max(mesh.nodes[magnetic_nodes], axis=0))
    shared_volume = float(np.sum(cell_volumes))
    magnetic_volume = float(np.sum(cell_volumes[magnetic_mask]))
    incidence = _mixed_v2_face_incidence(mesh)
    faceted_magnetic_volume = _mixed_v2_closed_faceted_magnetic_volume(mesh, incidence)
    if not math.isfinite(faceted_magnetic_volume) or faceted_magnetic_volume <= 0.0:
        raise RuntimeError("mixed v2 closed faceted magnetic volume is invalid")
    expected_shared_volume = float(np.prod(np.asarray(airbox_bounds_max_m) - np.asarray(airbox_bounds_min_m)))
    magnetic_bounds_scale = max(float(np.max(np.asarray(body_bounds_max_m) - np.asarray(body_bounds_min_m))), 1.0e-30)
    airbox_bounds_scale = max(float(np.max(np.asarray(airbox_bounds_max_m) - np.asarray(airbox_bounds_min_m))), 1.0e-30)
    magnetic_bounds_error = max(
        float(np.max(np.abs(np.asarray(realized_magnetic_min) - np.asarray(body_bounds_min_m)))),
        float(np.max(np.abs(np.asarray(realized_magnetic_max) - np.asarray(body_bounds_max_m)))),
    ) / magnetic_bounds_scale
    realized_airbox_min = np.min(mesh.nodes, axis=0)
    realized_airbox_max = np.max(mesh.nodes, axis=0)
    airbox_bounds_error = max(
        float(np.max(np.abs(realized_airbox_min - np.asarray(airbox_bounds_min_m)))),
        float(np.max(np.abs(realized_airbox_max - np.asarray(airbox_bounds_max_m)))),
    ) / airbox_bounds_scale
    if magnetic_bounds_error > 1.0e-8 or airbox_bounds_error > 1.0e-8:
        raise RuntimeError("mixed v2 realized bounds do not match authored CAD bounds")
    magnetic_plane_coordinates = sorted({float(value) for value in mesh.nodes[swept_nodes, requested_axis]})
    plane_tolerance = max(FEM_EXACT_LAYER_PLANE_ABS_TOLERANCE_M, FEM_EXACT_LAYER_PLANE_REL_TOLERANCE * (magnetic_plane_coordinates[-1] - magnetic_plane_coordinates[0]))
    clustered: list[float] = []
    for value in magnetic_plane_coordinates:
        if not clustered or value - clustered[-1] > plane_tolerance:
            clustered.append(value)
    if len(clustered) != requested_layers + 1:
        raise RuntimeError("mixed v2 exact sweep has an incorrect number of magnetic planes")

    # The transition/far interface is internal and therefore not in the
    # explicit physical facet list; use exact owner sets and the local face
    # arity to count it.
    transition_faces = _mixed_v2_transition_interface_tri3_count(mesh, incidence)
    with indeterminate_progress_phase(
        phase="postprocessing",
        progress_label="checking mixed-domain conformity",
        message="Checking mixed-domain interfaces and face conformity",
    ):
        conformity = _mixed_v2_conformity_counts(mesh, incidence)
    if any(conformity.values()):
        raise RuntimeError(f"mixed v2 conformity proof failed: {conformity}")

    def region_nodes(marker: int) -> NDArray[np.int32]:
        return _mixed_v2_cell_nodes_where(mesh, mesh.element_markers == marker)

    regions: list[MagneticRegionV2] = []
    material_fields: list[BodyMaterialFieldV2] = []
    for object_id, marker in zip(body_object_ids, (1, 2), strict=True):
        nodes = region_nodes(marker)
        node_order_digest = _mixed_v2_node_order_digest(nodes)
        families = dict(sorted(marker_counts[str(marker)].items()))
        sweep = None
        if marker == 1:
            sweep = ExactSweepEvidenceV2(
                sweep_direction_requested=requested_direction,
                sweep_direction_resolved=resolved_direction,
                requested_layer_count=requested_layers,
                realized_layer_count=requested_layers,
                magnetic_plane_coordinates_m=tuple(float(value) for value in clustered),
                plane_tolerance_m=plane_tolerance,
                topology_fingerprint_version="v3",
                topology_fingerprint=topology_fingerprint,
                node_order_digest=node_order_digest,
            )
        regions.append(MagneticRegionV2(object_id=object_id, body_marker=marker, material_marker=marker, cell_family_counts=families, exact_sweep=sweep))
        field = BodyMaterialFieldV2(
            object_id=object_id,
            field_basis="body_owned_p1",
            coefficient_domains=("Ms", "Aex", "alpha", "Ku1", "anisotropy_axis"),
            air_interpolation_policy="forbidden",
            cross_body_interpolation_policy="forbidden",
            node_order_digest=node_order_digest,
            field_digest="sha256:" + "0" * 64,
            values=dict(body_material_fields[object_id]),
        )
        material_fields.append(_dc_replace(field, field_digest=_body_material_field_digest(field, topology_fingerprint_version="v3", topology_fingerprint=topology_fingerprint, body_marker=marker, material_marker=marker)))

    certificate = MixedLayerTopologyCertificateV2(
        certificate_status="accepted",
        magnetic_regions=tuple(sorted(regions, key=lambda region: region.object_id)),
        # Native FEM recomputes the separation from the realized mesh body
        # AABBs.  Emit that exact value, rather than the pre-mesh CAD gap, so
        # the certificate and the native admission proof cannot diverge due
        # to meshing/coordinate quantization.
        body_separation_pairs=(BodySeparationPairV2(body_a=min(body_object_ids), body_b=max(body_object_ids), min_gap_m=realized_body_gap_m, contact_state="separated"),),
        body_material_fields=tuple(sorted(material_fields, key=lambda field: field.object_id)),
        requested_algorithm_3d=int(requested_algorithm_3d),
        transition_algorithm_3d=int(transition_algorithm_3d),
        tetrahedral_algorithm_3d=int(tetrahedral_algorithm_3d),
        optimizer=optimizer,
        optimizer_iterations=int(optimizer_iterations),
        requested_sweep_direction=requested_direction,
        resolved_sweep_direction=resolved_direction,
        requested_layer_count=requested_layers,
        realized_layer_count=requested_layers,
        magnetic_plane_coordinates_m=tuple(float(value) for value in clustered),
        plane_tolerance_m=plane_tolerance,
        transition_shell_thickness_m=float(transition_shell_thickness_m),
        transition_shell_interface_tri3_count=int(transition_faces),
        interface_marker=MIXED_INTERFACE_MARKER,
        outer_boundary_marker=int(max(mesh.boundary_markers.tolist())),
        magnetic_bounds_min_m=tuple(float(value) for value in body_bounds_min_m),
        magnetic_bounds_max_m=tuple(float(value) for value in body_bounds_max_m),
        airbox_bounds_min_m=tuple(float(value) for value in airbox_bounds_min_m),
        airbox_bounds_max_m=tuple(float(value) for value in airbox_bounds_max_m),
        magnetic_bounds_relative_error=magnetic_bounds_error,
        airbox_bounds_relative_error=airbox_bounds_error,
        jacobian_minima_m3_by_family=jacobian_minima,
        quality_metric=MIXED_QUALITY_METRIC,
        scaled_jacobian_minima_by_family=scaled_minima,
        scaled_jacobian_p05_by_family=scaled_p05,
        magnetic_volume_m3=magnetic_volume,
        # The expected value is an independently integrated closed boundary
        # volume of the realized linear mesh.  The analytic BRep volume passed
        # by the planner is retained as a separate geometry-approximation
        # input; using it as the integrity oracle would reject curved rings
        # solely because their boundary is faceted.
        expected_magnetic_volume_m3=float(faceted_magnetic_volume),
        magnetic_relative_volume_error=abs(magnetic_volume - faceted_magnetic_volume) / faceted_magnetic_volume,
        air_volume_m3=shared_volume - magnetic_volume,
        shared_domain_volume_m3=shared_volume,
        expected_shared_domain_volume_m3=expected_shared_volume,
        shared_domain_relative_volume_error=abs(shared_volume - expected_shared_volume) / expected_shared_volume,
        marker_coverage_complete=True,
        nonconforming_face_count=conformity["nonconforming_face_count"],
        orphan_face_count=conformity["orphan_face_count"],
        nonmanifold_face_count=conformity["nonmanifold_face_count"],
        coincident_interface_face_count=conformity["coincident_interface_face_count"],
        deterministic_inputs=_mixed_v2_deterministic_inputs(
            requested_algorithm_3d=int(requested_algorithm_3d),
            transition_algorithm_3d=int(transition_algorithm_3d),
            tetrahedral_algorithm_3d=int(tetrahedral_algorithm_3d),
            optimizer=optimizer,
            optimizer_iterations=int(optimizer_iterations),
        ),
        topology_fingerprint_version="v3",
        topology_fingerprint=topology_fingerprint,
        gmsh_version=gmsh_version,
        strategy=MIXED_SHARED_GEO_STRATEGY,
        effective_gmsh_thread_count=effective_gmsh_thread_count,
        cell_family_counts_by_marker=marker_counts,
        cell_family_counts_by_part=part_counts,
        facet_family_counts_by_role_marker=facet_counts,
    )
    return _dc_replace(mesh, mixed_layer_topology_certificate=certificate)


def generate_disconnected_mixed_p1_mesh(
    box: Box,
    ring_geometry: Geometry,
    outer: Cylinder,
    inner: Cylinder,
    offset: tuple[float, float, float],
    *,
    box_hmax: float,
    ring_hmax: float,
    n_layers: int,
    airbox: AirboxOptions,
    options: MeshOptions | None = None,
) -> MeshData:
    """Generate a conforming Box-prism plus disconnected annulus-tet domain."""
    opts = options or MeshOptions()
    if opts.algorithm_2d != 6 or opts.algorithm_3d not in (1, 10) or opts.periodic_pair_ids:
        raise ValueError(
            "mixed v2 shared-domain route requires algorithm 2D=6, algorithm "
            "3D=1 or 10, and no periodic pairs"
        )
    if opts.optimize not in (None, "Gmsh"):
        raise ValueError(
            "mixed v2 shared-domain route supports only the Gmsh optimizer"
        )
    if opts.size_fields or opts.boundary_layer_count is not None or opts.sweep_face_meshing not in (None, "triangular"):
        raise ValueError("mixed v2 shared-domain route does not accept unresolved size/boundary fields")
    if opts.optimize is None:
        optimizer_iterations = 0
    else:
        optimizer_iterations = int(opts.optimize_iters)
        if optimizer_iterations < 1:
            raise ValueError("mixed v2 Gmsh optimizer requires at least one iteration")
    if n_layers not in (1, 2, 3):
        raise ValueError("mixed v2 exact layer count must be 1, 2 or 3")
    if outer.axis != inner.axis or outer.radius <= inner.radius or not math.isclose(outer.height, inner.height, rel_tol=1.0e-9, abs_tol=1.0e-18):
        raise ValueError("mixed v2 annulus components are not compatible")
    if str(airbox.shape).strip().lower() != "bbox":
        raise ValueError("mixed v2 shared-domain route requires a bbox airbox")
    scale = 1.0e6
    box_size = np.asarray(box.size, dtype=np.float64)
    ring_center = np.asarray(offset, dtype=np.float64)
    axis = np.asarray(outer.axis, dtype=np.float64)
    ring_min, ring_max = _mixed_v2_body_aabb(center=ring_center, axis=axis, radius=float(outer.radius), height=float(outer.height))
    box_min = -0.5 * box_size
    box_max = 0.5 * box_size
    separation_components = np.maximum(np.maximum(box_min - ring_max, ring_min - box_max), 0.0)
    gap = float(np.linalg.norm(separation_components))
    if not math.isfinite(gap) or gap <= max(1.0e-18, np.finfo(np.float64).eps * max(float(np.max(box_size)), float(np.max(np.abs(ring_center))), 1.0)):
        raise ValueError("mixed v2 route requires a strictly positive axis-aligned body gap")
    union_min = np.minimum(box_min, ring_min)
    union_max = np.maximum(box_max, ring_max)
    if airbox.size is None:
        outer_size = (union_max - union_min) * float(airbox.padding_factor)
    else:
        outer_size = np.asarray(airbox.size, dtype=np.float64)
    center = np.zeros(3, dtype=np.float64) if airbox.center is None else np.asarray(airbox.center, dtype=np.float64)
    air_min = center - 0.5 * outer_size
    air_max = center + 0.5 * outer_size
    if np.any(union_min <= air_min) or np.any(union_max >= air_max):
        raise ValueError("mixed v2 airbox must strictly contain both disconnected bodies")

    emit_progress("Gmsh mixed v2: generating Box prism and disconnected annulus tetrahedron")
    gmsh = _import_gmsh()
    if str(getattr(gmsh, "__version__", "unknown")) != _MIXED_SHARED_GMSH_VERSION:
        raise RuntimeError(f"mixed v2 route is qualified only for Gmsh {_MIXED_SHARED_GMSH_VERSION}")
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        effective_threads = _configure_gmsh_threads(gmsh, requested_threads=1, honor_environment=False)
        if effective_threads != 1:
            raise RuntimeError("mixed v2 route requires one effective Gmsh thread")
        gmsh.model.add("fullmag_mixed_p1_v2")
        # Box source face, followed by exact structured extrusion.
        dims_scaled = box_size * scale
        thin_axis = int(np.argmin(box_size))
        requested_direction = opts.sweep_direction if opts.sweep_direction in {"auto", "x", "y", "z"} else "auto"
        if requested_direction in _SWEEP_AXIS_INDEX:
            thin_axis = _SWEEP_AXIS_INDEX[requested_direction]
        face_axes = [axis_index for axis_index in range(3) if axis_index != thin_axis]
        origin = -0.5 * dims_scaled
        points: list[int] = []
        for face_coordinate in ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)):
            coordinate = origin.copy()
            coordinate[face_axes[0]] += face_coordinate[0] * dims_scaled[face_axes[0]]
            coordinate[face_axes[1]] += face_coordinate[1] * dims_scaled[face_axes[1]]
            points.append(int(gmsh.model.geo.addPoint(*coordinate.tolist(), float(box_hmax * scale))))
        lines = [int(gmsh.model.geo.addLine(points[index], points[(index + 1) % 4])) for index in range(4)]
        source_loop = lines
        first = np.zeros(3, dtype=np.float64); first[face_axes[0]] = 1.0
        second = np.zeros(3, dtype=np.float64); second[face_axes[1]] = 1.0
        extrusion_direction = np.zeros(3, dtype=np.float64); extrusion_direction[thin_axis] = dims_scaled[thin_axis]
        if float(np.dot(np.cross(first, second), extrusion_direction)) > 0.0:
            source_loop = [-line for line in reversed(lines)]
        box_surface = int(gmsh.model.geo.addPlaneSurface([gmsh.model.geo.addCurveLoop(source_loop)]))

        # Annulus source face in a frame aligned with the authored cylinder axis.
        u, v, normal = _mixed_v2_axis_basis(outer.axis)
        center_scaled = ring_center * scale
        bottom_center = center_scaled - normal * (0.5 * float(outer.height) * scale)
        ring_center_tag = int(gmsh.model.geo.addPoint(*bottom_center.tolist(), float(ring_hmax * scale)))
        ring_loops: list[int] = []
        for radius in (float(outer.radius), float(inner.radius)):
            circle_points = [
                int(gmsh.model.geo.addPoint(*(bottom_center + (u * math.cos(angle) + v * math.sin(angle)) * radius * scale).tolist(), float(ring_hmax * scale)))
                for angle in (0.0, 0.5 * math.pi, math.pi, 1.5 * math.pi)
            ]
            arcs = [int(gmsh.model.geo.addCircleArc(circle_points[index], ring_center_tag, circle_points[(index + 1) % 4])) for index in range(4)]
            ring_loops.append(int(gmsh.model.geo.addCurveLoop(arcs)))
        ring_surface = int(gmsh.model.geo.addPlaneSurface(ring_loops))
        gmsh.model.geo.synchronize()
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", float(max(box_hmax, ring_hmax) * scale))
        if opts.hmin is not None:
            gmsh.option.setNumber("Mesh.CharacteristicLengthMin", float(opts.hmin * scale))
        gmsh.option.setNumber("Mesh.Algorithm", 6)
        gmsh.model.mesh.generate(2)
        box_extrusion = list(gmsh.model.geo.extrude([(2, box_surface)], *(extrusion_direction.tolist()), numElements=[n_layers], heights=[1.0], recombine=True))
        ring_extrusion = list(gmsh.model.geo.extrude([(2, ring_surface)], *(normal * float(outer.height) * scale).tolist(), recombine=False))
        gmsh.model.geo.synchronize()
        box_volume = next(int(tag) for dim, tag in box_extrusion if int(dim) == 3)
        ring_volume = next(int(tag) for dim, tag in ring_extrusion if int(dim) == 3)
        ring_boundary = gmsh.model.getBoundary([(3, ring_volume)], combined=False, oriented=True)
        ring_surface_loop = int(gmsh.model.geo.addSurfaceLoop([int(tag) for dim, tag in ring_boundary if int(dim) == 2]))
        shell_thickness_m, shell_target_m = _mixed_v2_transition_shell_parameters_m(
            box_size_m=box_size,
            airbox_size_m=outer_size,
            gap_m=gap,
            box_hmax_m=box_hmax,
            ring_hmax_m=ring_hmax,
            airbox=airbox,
        )
        shell_thickness = float(shell_thickness_m * scale)
        shell_target = float(shell_target_m * scale)
        if shell_thickness <= 0.0:
            raise ValueError("mixed v2 transition shell has no positive clearance from the annulus")
        shell_min = -0.5 * dims_scaled - shell_thickness
        shell_max = 0.5 * dims_scaled + shell_thickness
        outer_surfaces, outer_loop = _add_geo_box_surface_loop(gmsh, bounds_min=air_min * scale, bounds_max=air_max * scale, mesh_size=float(max(box_hmax, ring_hmax) * scale))
        transition_volumes, shell_outward = _add_partitioned_transition_shell_geo(gmsh, magnetic_volume=box_volume, shell_min=shell_min, body_min=-0.5 * dims_scaled, body_max=0.5 * dims_scaled, shell_max=shell_max, mesh_size=float(shell_target))
        shell_inner_loop = int(gmsh.model.geo.addSurfaceLoop([-int(tag) for tag in shell_outward]))
        far_air_volume = int(gmsh.model.geo.addVolume([int(outer_loop), shell_inner_loop, ring_surface_loop]))
        gmsh.model.geo.synchronize()
        box_surfaces = [int(tag) for dim, tag in gmsh.model.getBoundary([(3, box_volume)], combined=False, oriented=False) if int(dim) == 2]
        ring_surfaces = [abs(int(tag)) for dim, tag in ring_boundary if int(dim) == 2]
        interface_surfaces = sorted(set(box_surfaces + ring_surfaces))
        gmsh.model.addPhysicalGroup(3, [box_volume], tag=1); gmsh.model.setPhysicalName(3, 1, "magnetic_box")
        gmsh.model.addPhysicalGroup(3, [ring_volume], tag=2); gmsh.model.setPhysicalName(3, 2, "magnetic_ring")
        gmsh.model.addPhysicalGroup(3, [*transition_volumes, far_air_volume], tag=3); gmsh.model.setPhysicalName(3, 3, "air")
        gmsh.model.addPhysicalGroup(2, interface_surfaces, tag=MIXED_INTERFACE_MARKER); gmsh.model.setPhysicalName(2, MIXED_INTERFACE_MARKER, "mag_air_interface")
        gmsh.model.addPhysicalGroup(2, outer_surfaces, tag=int(airbox.boundary_marker)); gmsh.model.setPhysicalName(2, int(airbox.boundary_marker), "Gamma_out")
        _configure_disconnected_mixed_v2_mesh_size_fields(
            gmsh,
            interface_surface_tags=interface_surfaces,
            air_volume_tags=[*map(int, transition_volumes), int(far_air_volume)],
            body_volume_targets={
                box.geometry_name: ([int(box_volume)], float(box_hmax)),
                ring_geometry.geometry_name: ([int(ring_volume)], float(ring_hmax)),
            },
            object_bounds_min_m=tuple(float(value) for value in union_min),
            object_bounds_max_m=tuple(float(value) for value in union_max),
            airbox_bounds_min_m=tuple(float(value) for value in air_min),
            airbox_bounds_max_m=tuple(float(value) for value in air_max),
            box_hmax_m=float(box_hmax),
            ring_hmax_m=float(ring_hmax),
            airbox=airbox,
            options=opts,
            scale=scale,
        )
        gmsh.option.setNumber("Mesh.RandomFactor", 0.0)
        gmsh.option.setNumber("Mesh.ElementOrder", 1)
        # HXT (10) only accepts triangular surfaces.  The exact swept Box and
        # its 3x3x3 transition partition intentionally retain quad faces so
        # their first stage must use Delaunay (1).  Hide the transition stage
        # while HXT meshes the annulus and far-air tetrahedral volumes, then
        # restore visibility before extraction.  This is one Gmsh model and
        # one conforming mesh, not two unrelated meshes or a fallback.
        if opts.algorithm_3d == 10:
            volume_tags = [int(tag) for dim, tag in gmsh.model.getEntities(3) if int(dim) == 3]
            transition_stage = {int(box_volume), *(int(tag) for tag in transition_volumes)}
            tetrahedral_stage = {int(ring_volume), int(far_air_volume)}
            if not transition_stage.issubset(set(volume_tags)) or not tetrahedral_stage.issubset(set(volume_tags)):
                raise RuntimeError("mixed v2 hybrid stage volume ownership is incomplete")
            gmsh.option.setNumber("Mesh.MeshOnlyVisible", 1)
            for tag in volume_tags:
                gmsh.model.setVisibility([(3, tag)], tag in transition_stage)
            gmsh.option.setNumber("Mesh.Algorithm3D", 1)
            with _GmshProgressLogger(gmsh):
                gmsh.model.mesh.generate(3)
            for tag in volume_tags:
                gmsh.model.setVisibility([(3, tag)], tag in tetrahedral_stage)
            gmsh.option.setNumber("Mesh.Algorithm3D", 10)
            with _GmshProgressLogger(gmsh):
                gmsh.model.mesh.generate(3)
            for tag in volume_tags:
                gmsh.model.setVisibility([(3, tag)], True)
            gmsh.option.setNumber("Mesh.MeshOnlyVisible", 0)
        else:
            gmsh.option.setNumber("Mesh.Algorithm3D", 1)
            with _GmshProgressLogger(gmsh):
                gmsh.model.mesh.generate(3)
        if opts.optimize is not None:
            with indeterminate_progress_phase(
                phase="meshing",
                progress_label="optimizing mixed-domain mesh",
                message=f"Optimizing mixed-domain mesh ({opts.optimize}, {optimizer_iterations} iterations)",
            ):
                _apply_post_mesh_options(gmsh, opts)
        with indeterminate_progress_phase(phase="meshing", progress_label="repairing mixed-domain tetrahedra", message="Repairing mixed-domain tetrahedra"):
            mixed_tet_report = _repair_mixed_tetrahedra(gmsh)
        with indeterminate_progress_phase(phase="meshing", progress_label="optimizing mixed-pyramid apices", message="Optimizing mixed-pyramid apices"):
            _optimize_mixed_pyramid_apices(gmsh, initial_tet_report=mixed_tet_report)
        quality, per_domain_quality = (
            _extract_quality_metrics(gmsh, opts)
            if opts.compute_quality
            else (None, None)
        )
        quality = _quality_volumes_in_si(quality, scale)
        if per_domain_quality is not None:
            per_domain_quality = {
                marker: _quality_volumes_in_si(report, scale)
                for marker, report in per_domain_quality.items()
            }
        raw = _extract_mesh_data(
            gmsh,
            quality=quality,
            has_physical_groups=True,
            per_domain_quality=per_domain_quality,
            boundary_role_markers=(
                MIXED_INTERFACE_MARKER,
                int(airbox.boundary_marker),
            ),
        )
        raw = _compact_uncertified_volume_nodes(raw)
        mesh = MeshData(
            nodes=np.asarray(raw.nodes, dtype=np.float64) / scale,
            vertex_identity=raw.vertex_identity,
            cell_types=raw.cell_types,
            cell_offsets=raw.cell_offsets,
            cell_nodes=raw.cell_nodes,
            element_markers=raw.element_markers,
            facet_types=raw.facet_types,
            facet_roles=raw.facet_roles,
            facet_offsets=raw.facet_offsets,
            facet_nodes=raw.facet_nodes,
            boundary_markers=raw.boundary_markers,
            cell_global_ordinals=raw.cell_global_ordinals,
            facet_global_ordinals=raw.facet_global_ordinals,
            cell_mesh_parts=_gmsh_cell_parts_in_extraction_order(
                gmsh,
                {
                    "magnetic": [box_volume, ring_volume],
                    "transition_air": [int(tag) for tag in transition_volumes],
                    "far_air": [far_air_volume],
                },
            ),
            quality=raw.quality,
            per_domain_quality=raw.per_domain_quality,
        )
        if mesh.cell_mesh_parts.shape != (mesh.n_elements,):
            raise RuntimeError("mixed v2 cell mesh-part identity is incomplete")
        with indeterminate_progress_phase(
            phase="postprocessing",
            progress_label="orienting mixed-domain cells",
            message=f"Orienting mixed-domain cells ({mesh.n_elements} cells)",
        ):
            mesh = mesh.oriented_copy()
        with indeterminate_progress_phase(
            phase="postprocessing",
            progress_label="validating mixed-domain topology",
            message="Validating mixed-domain topology and positive cell orientation",
        ):
            mesh.validate_strict(require_positive_orientation=True)
        return mesh
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
    geometry_name: str | None = None,
    requested_direction: str | None = None,
) -> MeshData:
    """Generate a native ``prism6`` mesh for an axis-aligned box.

    Meshes the large cross-section face (perpendicular to *thin_axis*),
    then extrudes its triangular mesh with exactly *n_layers* structured
    layers. ``recombine`` is retained for caller compatibility; prism
    realization always recombines the triangular extrusion and never
    recombines the source face into quadrilaterals.
    """
    opts = options or MeshOptions()
    if requested_direction is None:
        requested_direction = opts.sweep_direction
    if requested_direction not in (None, "auto", "x", "y", "z"):
        raise ValueError(
            "requested sweep direction must be one of 'auto', 'x', 'y', or 'z'"
        )
    if requested_direction in _SWEEP_AXIS_INDEX:
        thin_axis = _SWEEP_AXIS_INDEX[requested_direction]
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
    if airbox is not None and n_layers not in (1, 2, 3):
        raise ValueError(
            "mixed shared-domain swept meshing is qualified for exactly 1, 2, or 3 layers"
        )
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
            "ComponentRestrictedGradedBox",
            "ComponentRestrictedGradedCylinder",
            "ComponentRestrictedGradedSphere",
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
        source_hmax_scaled = (
            min(hmax_scaled, 2.0 * thickness * SCALE / n_layers)
            if airbox is not None
            else hmax_scaled
        )

        # Map face_axes to 3D coordinates
        corner = list(origin)
        p1 = gmsh.model.geo.addPoint(
            corner[0], corner[1], corner[2], source_hmax_scaled
        )

        corner2 = list(origin)
        corner2[face_axes[0]] += w
        p2 = gmsh.model.geo.addPoint(
            corner2[0], corner2[1], corner2[2], source_hmax_scaled
        )

        corner3 = list(origin)
        corner3[face_axes[0]] += w
        corner3[face_axes[1]] += h
        # Keep the source face uniformly targeted.  The old mixed-airbox
        # special case refined only this opposite corner to 0.5*h, which
        # increased the 2-D triangulation without improving the certified
        # transition quality and made the finest SP4 level produce pyramid
        # slivers.  The bounded source-face field already carries the exact
        # target to the surface, so an extra point-only refinement is both
        # unnecessary and harmful for the 3-D transition.
        p3_mesh_size = source_hmax_scaled
        p3 = gmsh.model.geo.addPoint(
            corner3[0], corner3[1], corner3[2], p3_mesh_size
        )

        corner4 = list(origin)
        corner4[face_axes[1]] += h
        p4 = gmsh.model.geo.addPoint(
            corner4[0], corner4[1], corner4[2], source_hmax_scaled
        )

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
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", source_hmax_scaled)
        if opts.hmin is not None:
            gmsh.option.setNumber("Mesh.CharacteristicLengthMin", opts.hmin * SCALE)
        gmsh.option.setNumber("Mesh.Algorithm", opts.algorithm_2d)
        source_refinement_field: int | None = None
        if airbox is not None and (opts.size_fields or opts.lower_bound_fields):
            source_refinement_field = _apply_mixed_source_face_mesh_options(
                gmsh,
                source_surface=source_surf,
                hmax_scaled=source_hmax_scaled,
                order=order,
                opts=opts,
                hscale=SCALE,
                source_geometry_name=geometry_name,
            )
            gmsh.model.mesh.generate(2)
            _set_mixed_volume_mesh_size_options(
                gmsh,
                maximum_element_size_scaled=(
                    float(airbox.maximum_element_size) * SCALE
                    if airbox.maximum_element_size is not None
                    else hmax_scaled
                ),
            )
        elif airbox is not None and source_hmax_scaled < hmax_scaled:
            # Restrict the quality-preserving target to the magnetic source
            # face. Letting the fine point size propagate through the 3D
            # volume over-refines the transition air and can trigger Gmsh
            # tetrahedral overlaps for L=3.
            source_size = gmsh.model.mesh.field.add("Constant")
            gmsh.model.mesh.field.setNumbers(
                source_size, "SurfacesList", [source_surf]
            )
            gmsh.model.mesh.field.setNumber(
                source_size, "VIn", source_hmax_scaled
            )
            gmsh.model.mesh.field.setNumber(source_size, "VOut", 1.0e22)
            gmsh.model.mesh.field.setNumber(source_size, "IncludeBoundary", 1)
            source_refinement_field = gmsh.model.mesh.field.add("Restrict")
            gmsh.model.mesh.field.setNumber(
                source_refinement_field, "InField", source_size
            )
            gmsh.model.mesh.field.setNumbers(
                source_refinement_field, "SurfacesList", [source_surf]
            )
            gmsh.model.mesh.setSize(
                [(0, tag) for tag in (p1, p2, p3, p4)],
                hmax_scaled,
            )
            _set_mixed_volume_mesh_size_options(
                gmsh,
                maximum_element_size_scaled=(
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
        if opts.lower_bound_fields or any(
            isinstance(config, dict)
            and config.get("kind") in _PLANE_PROJECTED_UPPER_KINDS
            for config in opts.size_fields
        ):
            if domain_volume_entities is not None:
                body_volumes = [int(domain_volume_entities[0])]
            else:
                body_volumes = [
                    int(tag) for dim, tag in extrusion_entities if int(dim) == 3
                ]
            component_volume_tags = (
                {geometry_name: body_volumes}
                if isinstance(geometry_name, str)
                and geometry_name.strip()
                and body_volumes
                else None
            )
            component_surface_tags = None
            if component_volume_tags is not None:
                component_surface_tags = {
                    geometry_name: sorted(
                        {
                            abs(int(tag))
                            for dim, tag in gmsh.model.getBoundary(
                                [(3, volume) for volume in body_volumes],
                                oriented=False,
                            )
                            if int(dim) == 2
                        }
                    )
                }
            cap_field = _add_swept_exact_plane_cap_field(
                gmsh,
                opts=opts,
                geometry_name=geometry_name,
                body_volumes=body_volumes,
                source_z=-0.5 * thickness,
                thickness=thickness,
                n_layers=n_layers,
                neutral_size=hmax,
                hscale=SCALE,
                sweep_axis=thin_axis,
            )
            if cap_field is not None:
                active_background_fields.append(int(cap_field))
            _apply_mesh_options(
                gmsh,
                hmax_scaled,
                order,
                opts,
                hscale=SCALE,
                preexisting_field_ids=active_background_fields,
                airbox_maximum_element_size=_scaled_airbox_maximum_element_size(
                    airbox,
                    scale=SCALE,
                ),
                component_volume_tags=component_volume_tags,
                component_surface_tags=component_surface_tags,
            )
        elif len(active_background_fields) > 1:
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
            with indeterminate_progress_phase(
                phase="meshing",
                progress_label="repairing mixed-domain tetrahedra",
                message="Repairing mixed-domain tetrahedra",
            ):
                mixed_tet_report = _repair_mixed_tetrahedra(gmsh)
            with indeterminate_progress_phase(
                phase="meshing",
                progress_label="optimizing mixed-pyramid apices",
                message="Optimizing mixed-pyramid apices",
            ):
                _optimize_mixed_pyramid_apices(
                    gmsh,
                    initial_tet_report=mixed_tet_report,
                )

        # Extract → same pipeline as cylinder
        if airbox is not None:
            with indeterminate_progress_phase(
                phase="meshing",
                progress_label="extracting mesh data",
                message="Extracting mesh nodes, elements, and boundary facets",
            ):
                raw_mesh = _extract_mesh_data(
                    gmsh,
                    has_physical_groups=True,
                    boundary_role_markers=(10, int(airbox.boundary_marker)),
                )
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
                requested_direction=requested_direction,
            )
        return _extract_swept_mesh_data(
            gmsh,
            SCALE,
            requested_axis=thin_axis,
            requested_layers=n_layers,
            requested_direction=requested_direction,
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
    requested_direction: str | None = None,
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
            requested_direction=(
                requested_direction
                if requested_direction in {"auto", "x", "y", "z"}
                else "xyz"[requested_axis]
            ),
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
    if strategy == "thin_film_tetrahedral":
        # The public thin-film recipe keeps tetrahedral topology.  The
        # Box and canonical antidot ring use GEO extrusion to realize
        # exact magnetic source planes while preserving Tet4 topology.
        return isinstance(geometry, Box) or _is_box_cylinder_ring(geometry)
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
    _reject_unresolved_sweep_selectors(options)
    if options is not None and options.mesh_strategy == SWEEP_STRATEGY_HEX:
        raise ValueError(
            "explicit swept_hex realization is not implemented in the body-only prism path"
        )
    if (
        options is not None
        and options.mesh_strategy == SWEEP_STRATEGY_PRISM
        and not isinstance(geometry, (Box, Difference))
    ):
        raise TypeError(
            "body-only swept prism meshing supports only axis-aligned Box or canonical Box-Cylinder ring geometry"
        )
    if isinstance(geometry, Difference):
        return generate_swept_box_cylinder_ring_mesh(
            geometry,
            hmax,
            n_layers,
            order=order,
            distribution=distribution,
            element_ratio=element_ratio,
            symmetric=symmetric,
            recombine=recombine,
            airbox=airbox,
            options=options,
        )
    if isinstance(geometry, Cylinder):
        _resolve_sweep_axis(geometry, options=options, fallback_axis=2)
        if geometry.axis != (0.0, 0.0, 1.0):
            raise ValueError(
                "swept cylinder meshing supports only the canonical Z axis; use OCC free tetrahedral meshing for arbitrary axes"
            )
        return generate_swept_cylinder_mesh(
            geometry.radius, geometry.height, hmax, n_layers,
            order=order, distribution=distribution,
            element_ratio=element_ratio, symmetric=symmetric,
            recombine=recombine,
            airbox=airbox,
            options=options,
            geometry_name=geometry.geometry_name,
        )
    if isinstance(geometry, Box):
        if options is not None and options.mesh_strategy == "thin_film_tetrahedral":
            return generate_swept_tetrahedral_box_airbox_mesh(
                geometry, hmax, n_layers, order=order, distribution=distribution,
                recombine=recombine, airbox=airbox, options=options,
            )
        result = classify_sweepability(geometry)
        fallback_axis = result.thin_axis if result.thin_axis is not None else 2
        thin_axis = _resolve_sweep_axis(
            geometry,
            options=options,
            fallback_axis=fallback_axis,
        )
        return generate_swept_box_mesh(
            geometry.size, hmax, n_layers,
            thin_axis=thin_axis, order=order,
            distribution=distribution, element_ratio=element_ratio,
            symmetric=symmetric, recombine=recombine,
            airbox=airbox, options=options,
            geometry_name=geometry.geometry_name,
            requested_direction=(
                options.sweep_direction if options is not None else None
            ),
        )
    if isinstance(geometry, ArchWaveguide):
        _resolve_sweep_axis(geometry, options=options, fallback_axis=2)
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
                geometry_name=geometry.geometry_name,
            )
    raise TypeError(
        f"Swept meshing not supported for geometry type {type(geometry).__name__}. "
        "Use mesh_strategy='free_tetrahedral' instead."
    )
