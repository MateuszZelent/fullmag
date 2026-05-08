from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Literal

Number = int | float


def _positive_float(name: str, value: Number) -> float:
    candidate = float(value)
    if candidate <= 0.0:
        raise ValueError(f"{name} must be positive, got {value!r}")
    return candidate


def _positive_int(name: str, value: int) -> int:
    candidate = int(value)
    if candidate < 2:
        raise ValueError(f"{name} must be >= 2, got {value!r}")
    return candidate


def _at_least_one_int(name: str, value: int) -> int:
    candidate = int(value)
    if candidate < 1:
        raise ValueError(f"{name} must be >= 1, got {value!r}")
    return candidate


def _geometry_name(value: str) -> str:
    name = str(value).strip()
    if not name:
        raise ValueError("geometry_name must be a non-empty string")
    return name


def object_core_relaxation(
    geometry_name: str,
    *,
    maximum_element_size: Number,
    surface_maximum_element_size: Number,
    surface_distance: Number,
    edge_maximum_element_size: Number | None = None,
    edge_distance: Number | None = None,
    sampling_surface: int = 20,
    sampling_edge: int = 40,
) -> dict[str, Any]:
    """Return an ObjectCoreRelaxation size-field descriptor."""
    core = _positive_float("maximum_element_size", maximum_element_size)
    surface = _positive_float("surface_maximum_element_size", surface_maximum_element_size)
    shell = _positive_float("surface_distance", surface_distance)
    if surface > core:
        raise ValueError("surface_maximum_element_size must be <= maximum_element_size")

    params: dict[str, Any] = {
        "GeometryName": _geometry_name(geometry_name),
        "core_maximum_element_size": core,
        "surface_maximum_element_size": surface,
        "surface_distance": shell,
        "sampling_surface": _positive_int("sampling_surface", sampling_surface),
        "sampling_edge": _positive_int("sampling_edge", sampling_edge),
    }
    if edge_maximum_element_size is not None or edge_distance is not None:
        if edge_maximum_element_size is None:
            raise ValueError("edge_maximum_element_size is required when edge_distance is set")
        if edge_distance is None:
            raise ValueError("edge_distance is required when edge_maximum_element_size is set")
        edge = _positive_float("edge_maximum_element_size", edge_maximum_element_size)
        if edge > surface:
            raise ValueError("edge_maximum_element_size must be <= surface_maximum_element_size")
        params["edge_maximum_element_size"] = edge
        params["edge_distance"] = _positive_float("edge_distance", edge_distance)
    return {"kind": "ObjectCoreRelaxation", "params": params}


def surface_shell(
    geometry_name: str,
    *,
    maximum_element_size: Number,
    far_maximum_element_size: Number,
    distance: Number,
    sampling: int = 20,
) -> dict[str, Any]:
    """Return a SurfaceDistanceThreshold field for a component surface shell."""
    shell = _positive_float("maximum_element_size", maximum_element_size)
    far = _positive_float("far_maximum_element_size", far_maximum_element_size)
    if shell > far:
        raise ValueError("maximum_element_size must be <= far_maximum_element_size")
    return {
        "kind": "SurfaceDistanceThreshold",
        "params": {
            "GeometryName": _geometry_name(geometry_name),
            "SizeMin": shell,
            "SizeMax": far,
            "DistMin": 0.0,
            "DistMax": _positive_float("distance", distance),
            "Sampling": _positive_int("sampling", sampling),
        },
    }


def edge_distance_threshold(
    geometry_name: str,
    *,
    maximum_element_size: Number,
    far_maximum_element_size: Number,
    distance: Number,
    curve_tags: Sequence[int] | None = None,
    selector: Literal["all_boundary_curves"] = "all_boundary_curves",
    sampling: int = 40,
) -> dict[str, Any]:
    """Return an EdgeDistanceThreshold field for recovered component curves."""
    edge = _positive_float("maximum_element_size", maximum_element_size)
    far = _positive_float("far_maximum_element_size", far_maximum_element_size)
    if edge > far:
        raise ValueError("maximum_element_size must be <= far_maximum_element_size")
    params: dict[str, Any] = {
        "GeometryName": _geometry_name(geometry_name),
        "Selector": {"mode": selector},
        "SizeMin": edge,
        "SizeMax": far,
        "DistMin": 0.0,
        "DistMax": _positive_float("distance", distance),
        "Sampling": _positive_int("sampling", sampling),
    }
    if curve_tags:
        params["CurveTags"] = [int(tag) for tag in curve_tags]
    return {"kind": "EdgeDistanceThreshold", "params": params}


def interface_shell(
    geometry_name: str,
    *,
    maximum_element_size: Number,
    far_maximum_element_size: Number,
    distance: Number,
    sampling: int = 20,
) -> dict[str, Any]:
    """Return an InterfaceShellThreshold field for the component interface shell."""
    interface = _positive_float("maximum_element_size", maximum_element_size)
    far = _positive_float("far_maximum_element_size", far_maximum_element_size)
    if interface > far:
        raise ValueError("maximum_element_size must be <= far_maximum_element_size")
    return {
        "kind": "InterfaceShellThreshold",
        "params": {
            "GeometryName": _geometry_name(geometry_name),
            "SizeMin": interface,
            "SizeMax": far,
            "DistMin": 0.0,
            "DistMax": _positive_float("distance", distance),
            "Sampling": _positive_int("sampling", sampling),
        },
    }


def boundary_layers(
    *,
    count: int,
    first_layer_thickness: Number,
    stretching: Number = 1.2,
    target_surface_tags: Sequence[int] | None = None,
    target_curve_tags: Sequence[int] | None = None,
) -> dict[str, Any]:
    """Return explicit boundary-layer mesh controls for tagged surfaces/curves."""
    surface_tags = [int(tag) for tag in target_surface_tags or ()]
    curve_tags = [int(tag) for tag in target_curve_tags or ()]
    if not surface_tags and not curve_tags:
        raise ValueError(
            "boundary_layers requires target_surface_tags or target_curve_tags"
        )
    return {
        "boundary_layer_count": _at_least_one_int("count", count),
        "boundary_layer_thickness": _positive_float(
            "first_layer_thickness", first_layer_thickness
        ),
        "boundary_layer_stretching": _positive_float("stretching", stretching),
        "boundary_layer_target_surface_tags": surface_tags,
        "boundary_layer_target_curve_tags": curve_tags,
    }
