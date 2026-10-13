"""Build canonical layered-box ``MeshData`` from generated Gmsh cap meshes."""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import replace
import math
from numbers import Integral, Real
from typing import Any

import numpy as np

from ._gmsh_extraction import _extract_periodic_pairs
from ._gmsh_layered_periodic import periodic_patch_z_bounds_from_gmsh
from ._gmsh_occ import _scale_periodic_boundary_pairs
from ._gmsh_tet4_quality import quality_for_tet4_arrays
from ._gmsh_types import (
    FEM_EXACT_LAYER_PLANE_ABS_TOLERANCE_M,
    FEM_EXACT_LAYER_PLANE_REL_TOLERANCE,
    MeshData,
    MeshOptions,
)
from ._layered_box_mesh_data import build_layered_box_mesh_data


def _finite_real(value: object, name: str) -> float:
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, Real):
        raise TypeError(f"{name} must be a real number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def _positive_tag(value: object, name: str) -> int:
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, Integral):
        raise TypeError(f"{name} must be an integer Gmsh tag")
    result = int(value)
    if result <= 0:
        raise ValueError(f"{name} must be positive")
    return result


def _ordered_real_sequence(value: object, name: str, *, minimum_size: int) -> tuple[float, ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise TypeError(f"{name} must be a sequence of real values")
    result = tuple(_finite_real(item, f"{name}[{index}]") for index, item in enumerate(value))
    if len(result) < minimum_size:
        raise ValueError(f"{name} must contain at least {minimum_size} values")
    if any(right <= left for left, right in zip(result, result[1:])):
        raise ValueError(f"{name} must be strictly increasing")
    return result


def _periodic_specs(value: object) -> list[dict[str, object]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise TypeError("periodic_surface_specs must be a sequence of mappings")
    specs: list[dict[str, object]] = []
    for index, spec in enumerate(value):
        if not isinstance(spec, Mapping):
            raise TypeError(f"periodic_surface_specs[{index}] must be a mapping")
        specs.append(dict(spec))
    return specs


def _cap_node_rows(gmsh: Any, surface_tag: int) -> tuple[list[int], list[tuple[float, float, float]]]:
    try:
        raw_tags, raw_coordinates, _parametric = gmsh.model.mesh.getNodes(
            2,
            surface_tag,
            includeBoundary=True,
            returnParametricCoord=False,
        )
    except Exception as exc:
        raise ValueError(f"could not read mesh nodes from cap surface {surface_tag}") from exc

    tags_array = np.asarray(raw_tags)
    if tags_array.ndim != 1:
        raise ValueError(f"cap surface {surface_tag} returned malformed node tags")
    if tags_array.size == 0:
        raise ValueError(f"cap surface {surface_tag} has no mesh nodes")
    tags = [_positive_tag(tag, f"cap surface {surface_tag} node tag") for tag in tags_array]

    if np.iscomplexobj(raw_coordinates):
        raise ValueError(f"cap surface {surface_tag} returned complex node coordinates")
    try:
        coordinates = np.asarray(raw_coordinates, dtype=np.float64)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"cap surface {surface_tag} returned invalid node coordinates") from exc
    if coordinates.ndim == 1:
        if coordinates.size != 3 * len(tags):
            raise ValueError(f"cap surface {surface_tag} returned inconsistent node coordinates")
        coordinates = coordinates.reshape((-1, 3))
    elif coordinates.shape != (len(tags), 3):
        raise ValueError(f"cap surface {surface_tag} returned inconsistent node coordinates")
    if not np.all(np.isfinite(coordinates)):
        raise ValueError(f"cap surface {surface_tag} returned non-finite node coordinates")
    points = [tuple(float(value) for value in row) for row in coordinates]
    return tags, points


def _verify_periodic_retention(
    gmsh: Any,
    specs: Sequence[Mapping[str, object]],
    retained_node_tags: set[int],
) -> None:
    """Reject a periodic correspondence when exactly one endpoint is a cap node."""
    for index, spec in enumerate(specs):
        pair_id = spec.get("pair_id")
        master_tag = _positive_tag(spec.get("master_tag"), f"periodic_surface_specs[{index}].master_tag")
        slave_tag = _positive_tag(spec.get("slave_tag"), f"periodic_surface_specs[{index}].slave_tag")
        try:
            returned_master, slave_nodes, master_nodes, _affine = (
                gmsh.model.mesh.getPeriodicNodes(2, slave_tag)
            )
        except Exception as exc:
            raise ValueError(
                f"gmsh did not provide periodic node pairs for {pair_id!r} surface {slave_tag}"
            ) from exc
        if int(returned_master) != master_tag:
            raise ValueError(
                f"gmsh periodic pair {pair_id!r} mapped surface {slave_tag} to master "
                f"{int(returned_master)}, expected {master_tag}"
            )
        slave_array = np.asarray(slave_nodes)
        master_array = np.asarray(master_nodes)
        if (
            slave_array.ndim != 1
            or master_array.ndim != 1
            or slave_array.size == 0
            or slave_array.size != master_array.size
        ):
            raise ValueError(f"gmsh periodic pair {pair_id!r} has no valid node correspondence")
        for slave_node, master_node in zip(slave_array, master_array, strict=True):
            slave_kept = _positive_tag(slave_node, "periodic slave node tag") in retained_node_tags
            master_kept = _positive_tag(master_node, "periodic master node tag") in retained_node_tags
            if slave_kept != master_kept:
                raise ValueError(
                    f"periodic pair {pair_id!r} retains only one endpoint of a canonical node pair"
                )


def build_layered_box_from_gmsh_caps(
    gmsh: Any,
    *,
    cap_surface_tags: Sequence[int],
    requested_layer_planes_si_m: Sequence[float],
    magnetic_plane_indices: tuple[int, int],
    bounds_xy_si_m: Sequence[float],
    gmsh_units_per_m: float,
    options: MeshOptions,
    periodic_surface_specs: Sequence[Mapping[str, object]],
    outer_boundary_marker: int,
) -> MeshData:
    """Create the final exact layered-box Tet4 mesh from already-generated caps.

    The Gmsh caller owns session initialization, locking, geometry fields,
    ``generate(2)``, and periodic surface configuration. Cap node tags provide
    the only identity used to merge the cross-sections. Coordinates are
    converted once to SI; exact meshing uses the observed binary cap planes.
    """
    scale = _finite_real(gmsh_units_per_m, "gmsh_units_per_m")
    if scale <= 0.0:
        raise ValueError("gmsh_units_per_m must be positive")
    if not isinstance(options, MeshOptions):
        raise TypeError("options must be MeshOptions")

    requested_planes = _ordered_real_sequence(
        requested_layer_planes_si_m,
        "requested_layer_planes_si_m",
        minimum_size=2,
    )
    if not isinstance(cap_surface_tags, Sequence) or isinstance(cap_surface_tags, (str, bytes)):
        raise TypeError("cap_surface_tags must be a sequence of Gmsh surface tags")
    if len(cap_surface_tags) != len(requested_planes):
        raise ValueError("cap_surface_tags and requested_layer_planes_si_m must have matching lengths")
    surface_tags = [
        _positive_tag(tag, f"cap_surface_tags[{index}]")
        for index, tag in enumerate(cap_surface_tags)
    ]
    if len(set(surface_tags)) != len(surface_tags):
        raise ValueError("cap_surface_tags must not contain duplicates")

    if not isinstance(magnetic_plane_indices, tuple) or len(magnetic_plane_indices) != 2:
        raise TypeError("magnetic_plane_indices must be a pair of integer plane indices")
    first_plane, last_plane = (
        _positive_index(value, f"magnetic_plane_indices[{index}]")
        for index, value in enumerate(magnetic_plane_indices)
    )
    if first_plane >= last_plane or last_plane >= len(surface_tags):
        raise ValueError("magnetic_plane_indices must select an increasing in-range interval")

    retained_coordinates: dict[int, tuple[float, float, float]] = {}
    actual_plane_values_gmsh: list[float] = []
    for plane_index, surface_tag in enumerate(surface_tags):
        tags, points = _cap_node_rows(gmsh, surface_tag)
        cap_z_values = {point[2] for point in points}
        if len(cap_z_values) != 1:
            raise ValueError(
                f"cap surface {surface_tag} has nodes on more than one exact z plane"
            )
        actual_z_gmsh = next(iter(cap_z_values))
        actual_z_si = actual_z_gmsh / scale
        if not math.isfinite(actual_z_si):
            raise ValueError(f"cap surface {surface_tag} z coordinate overflowed SI conversion")
        actual_plane_values_gmsh.append(actual_z_gmsh)
        for node_tag, point in zip(tags, points, strict=True):
            previous = retained_coordinates.get(node_tag)
            if previous is not None and previous != point:
                raise ValueError(
                    f"Gmsh node tag {node_tag} has conflicting coordinates across cap surfaces"
                )
            retained_coordinates[node_tag] = point
        tolerance = max(
            FEM_EXACT_LAYER_PLANE_ABS_TOLERANCE_M,
            FEM_EXACT_LAYER_PLANE_REL_TOLERANCE * (requested_planes[-1] - requested_planes[0]),
        )
        if abs(actual_z_si - requested_planes[plane_index]) > tolerance:
            raise ValueError(
                f"cap surface {surface_tag} actual z={actual_z_si:.17g} m differs from "
                f"requested layer plane {requested_planes[plane_index]:.17g} m "
                f"beyond tolerance {tolerance:.17g} m"
            )

    actual_planes = tuple(value / scale for value in actual_plane_values_gmsh)
    if any(not math.isfinite(value) for value in actual_planes):
        raise ValueError("actual cap planes overflowed SI conversion")
    if any(right <= left for left, right in zip(actual_planes, actual_planes[1:])):
        raise ValueError("actual cap planes must be strictly increasing")

    ordered_tags = sorted(retained_coordinates)
    node_index = {tag: index for index, tag in enumerate(ordered_tags)}
    nodes_si = np.asarray(
        [tuple(value / scale for value in retained_coordinates[tag]) for tag in ordered_tags],
        dtype=np.float64,
    )
    if not np.all(np.isfinite(nodes_si)):
        raise ValueError("cap node coordinates overflowed SI conversion")

    specs = _periodic_specs(periodic_surface_specs)
    retained_node_tags = set(node_index)
    _verify_periodic_retention(gmsh, specs, retained_node_tags)
    periodic_boundary_pairs_gmsh, periodic_node_pairs = _extract_periodic_pairs(
        gmsh,
        node_index,
        specs,
    )
    periodic_boundary_pairs = _scale_periodic_boundary_pairs(
        periodic_boundary_pairs_gmsh,
        scale=scale,
    )
    periodic_patch_z_bounds = periodic_patch_z_bounds_from_gmsh(
        gmsh,
        specs,
        gmsh_units_per_m=scale,
        layer_planes_si_m=actual_planes,
    )

    mesh = build_layered_box_mesh_data(
        nodes_si,
        actual_planes,
        bounds_xy_si_m,
        magnetic_z_bounds=(actual_planes[first_plane], actual_planes[last_plane]),
        outer_boundary_marker=outer_boundary_marker,
        periodic_boundary_pairs=periodic_boundary_pairs,
        periodic_node_pairs=periodic_node_pairs,
        periodic_patch_z_bounds=periodic_patch_z_bounds,
        tetrahedralization_method="delaunay",
    )
    if options.compute_quality:
        quality, per_domain_quality = quality_for_tet4_arrays(
            gmsh,
            mesh.nodes,
            mesh.elements,
            mesh.element_markers,
            options,
        )
        mesh = replace(
            mesh,
            quality=quality,
            per_domain_quality=per_domain_quality,
        )
    return mesh


def _positive_index(value: object, name: str) -> int:
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, Integral):
        raise TypeError(f"{name} must be an integer index")
    result = int(value)
    if result < 0:
        raise ValueError(f"{name} must be nonnegative")
    return result
