from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from ._mesh_targets import _geometry_name_aliases


def _selector_point(selector: Mapping[str, object]) -> tuple[float, float, float]:
    raw_point = selector.get("point")
    if not isinstance(raw_point, Sequence) or isinstance(raw_point, (str, bytes)):
        raise ValueError("mesh selector point must be a 3-vector")
    point = [float(component) for component in raw_point]
    if len(point) != 3:
        raise ValueError("mesh selector point must be a 3-vector")
    return point[0], point[1], point[2]


def _selector_count(selector: Mapping[str, object]) -> int:
    count = int(selector.get("count", 1))
    if count < 1:
        raise ValueError("mesh selector count must be >= 1")
    return count


def _geometry_name(selector: Mapping[str, object]) -> str | None:
    raw_geometry = selector.get("geometry")
    if raw_geometry is None:
        return None
    geometry = str(raw_geometry).strip()
    if not geometry:
        raise ValueError("mesh selector geometry must be a non-empty string")
    return geometry


def _copy_selector(selector: Mapping[str, object]) -> dict[str, object]:
    return {str(key): value for key, value in selector.items()}


def _curve_tags_from_surfaces(gmsh: Any, surface_tags: Sequence[int]) -> list[int]:
    if not surface_tags:
        return []
    boundary = gmsh.model.getBoundary(
        [(2, int(tag)) for tag in surface_tags],
        oriented=False,
        recursive=False,
    )
    return sorted({int(tag) for dim, tag in boundary if int(dim) == 1})


def _resolve_surface_tags_from_aliases(
    geometry_name: str,
    component_surface_tags: dict[str, list[int]],
) -> list[int]:
    """Look up component surface tags by geometry_name, trying canonical aliases."""
    for alias in _geometry_name_aliases(geometry_name):
        tags = component_surface_tags.get(alias)
        if tags:
            return [int(tag) for tag in tags]
    return []


def _candidate_entities(
    gmsh: Any,
    *,
    dimension: int,
    selector: Mapping[str, object],
    component_surface_tags: dict[str, list[int]] | None,
) -> list[tuple[int, int]]:
    geometry = _geometry_name(selector)
    if geometry and component_surface_tags:
        surface_tags = _resolve_surface_tags_from_aliases(geometry, component_surface_tags)
        if dimension == 2:
            return [(2, tag) for tag in surface_tags]
        if dimension == 1:
            return [(1, tag) for tag in _curve_tags_from_surfaces(gmsh, surface_tags)]
    return [(int(dim), int(tag)) for dim, tag in gmsh.model.getEntities(dimension)]


def resolve_entity_selectors(
    gmsh: Any,
    selectors: Sequence[Mapping[str, object]] | None,
    *,
    dimension: int,
    component_surface_tags: dict[str, list[int]] | None = None,
) -> tuple[list[int], list[dict[str, object]]]:
    """Resolve semantic entity selectors to Gmsh entity tags.

    The public selector payload stores physical intent. This adapter resolves
    that intent only after Gmsh has realized the geometry and stable entity tags
    exist.
    """
    if selectors is None:
        return [], []

    resolved_tags: list[int] = []
    reports: list[dict[str, object]] = []
    for raw_selector in selectors:
        if not isinstance(raw_selector, Mapping):
            raise ValueError("mesh selectors must be dictionaries")
        selector = _copy_selector(raw_selector)
        kind = str(selector.get("kind", "")).strip()
        expected_kind = (
            "nearest_surface_to_point"
            if dimension == 2
            else "nearest_curve_to_point"
        )
        if kind != expected_kind:
            raise ValueError(
                f"dimension {dimension} selectors must have kind {expected_kind!r}"
            )

        point = _selector_point(selector)
        count = _selector_count(selector)
        candidates = _candidate_entities(
            gmsh,
            dimension=dimension,
            selector=selector,
            component_surface_tags=component_surface_tags,
        )
        if candidates:
            out_dim_tags, distances, coord = gmsh.model.occ.getClosestEntities(
                point[0],
                point[1],
                point[2],
                candidates,
                n=count,
            )
        else:
            out_dim_tags, distances, coord = [], [], []

        tags = [int(tag) for dim, tag in out_dim_tags if int(dim) == dimension]
        resolved_tags.extend(tags)
        reports.append(
            {
                "selector": selector,
                "dimension": dimension,
                "candidate_count": len(candidates),
                "resolved_tags": tags,
                "distances": [float(distance) for distance in distances],
                "closest_points": [float(value) for value in coord],
            }
        )

    return sorted(set(resolved_tags)), reports


def collect_orphan_entity_diagnostics(gmsh: Any) -> list[dict[str, int]]:
    if not hasattr(gmsh.model, "isEntityOrphan"):
        return []

    diagnostics: list[dict[str, int]] = []
    for dimension in (0, 1, 2, 3):
        for dim, tag in gmsh.model.getEntities(dimension):
            if gmsh.model.isEntityOrphan(int(dim), int(tag)):
                diagnostics.append({"dimension": int(dim), "tag": int(tag)})
    return diagnostics
