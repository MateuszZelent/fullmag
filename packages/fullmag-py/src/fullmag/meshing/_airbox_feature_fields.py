"""Air-scoped curvature and narrow-gap size fields (docs/physics/0107).

Both controls are upper bounds restricted to the air volumes.  They never
coarsen a magnetic body or an interface target: they enter the background
``Min`` next to the airbox grading field of note 0102.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from fullmag._progress import emit_progress, emit_progress_event

from ._gmsh_fields import _sample_surface_curvature_radius
from ._gmsh_types import AirboxOptions, _resolve_narrow_region_count

AIRBOX_FEATURE_UNSUPPORTED_ROUTE = "airbox_feature_refinement_unsupported_route"
# The gap estimate sums distances over every wall pair; past this count the
# per-point cost grows quadratically, so reject instead of degrading silently.
MAX_AIRBOX_GAP_WALLS = 32
_CURVATURE_SAMPLES_PER_AXIS = 5
_DISTANCE_SAMPLING = 20
_LOWER_CLAMP_FRACTION = 0.05


def require_no_airbox_feature_refinement(
    airbox: AirboxOptions | None,
    *,
    route: str,
) -> None:
    """Reject air curvature/narrow-gap controls on routes that cannot realize them."""
    if airbox is None or not airbox.has_feature_refinement:
        return
    raise ValueError(
        f"{AIRBOX_FEATURE_UNSUPPORTED_ROUTE}: the {route} air route builds its "
        "air layers from explicit level sets and cannot apply the universe "
        "curvature_factor / narrow_region_resolution controls; remove them or "
        "use a tetrahedral shared-domain route"
    )


def _flatten_tags(groups: Mapping[str, Sequence[int]]) -> list[int]:
    tags: set[int] = set()
    for values in groups.values():
        tags.update(int(tag) for tag in values)
    return sorted(tags)


def _restrict_to_air(gmsh: Any, field_ids: list[int], air_volume_tags: Sequence[int]) -> int:
    if len(field_ids) == 1:
        inner = field_ids[0]
    else:
        inner = gmsh.model.mesh.field.add("Min")
        gmsh.model.mesh.field.setNumbers(inner, "FieldsList", field_ids)
    restricted = gmsh.model.mesh.field.add("Restrict")
    gmsh.model.mesh.field.setNumber(restricted, "InField", inner)
    gmsh.model.mesh.field.setNumbers(
        restricted, "VolumesList", [int(tag) for tag in air_volume_tags]
    )
    return restricted


def _add_air_curvature_field(
    gmsh: Any,
    *,
    curvature_factor: float,
    surface_tags: Sequence[int],
    air_volume_tags: Sequence[int],
    size_max: float,
    size_min: float,
    growth: float,
) -> tuple[int | None, dict[str, object]]:
    """Eqs. eq-air-curvature-target and eq-air-curvature-ramp."""
    thresholds: list[int] = []
    smallest: float | None = None
    for surface_tag in surface_tags:
        try:
            radius = _sample_surface_curvature_radius(
                gmsh,
                int(surface_tag),
                samples_per_axis=_CURVATURE_SAMPLES_PER_AXIS,
            )
        except AttributeError:
            radius = None
        if radius is None:
            continue
        target = min(max(curvature_factor * radius, size_min), size_max)
        if target >= size_max:
            continue
        distance = gmsh.model.mesh.field.add("Distance")
        gmsh.model.mesh.field.setNumbers(distance, "SurfacesList", [int(surface_tag)])
        gmsh.model.mesh.field.setNumber(distance, "Sampling", _DISTANCE_SAMPLING)
        threshold = gmsh.model.mesh.field.add("Threshold")
        gmsh.model.mesh.field.setNumber(threshold, "InField", distance)
        gmsh.model.mesh.field.setNumber(threshold, "SizeMin", target)
        gmsh.model.mesh.field.setNumber(threshold, "SizeMax", size_max)
        gmsh.model.mesh.field.setNumber(threshold, "DistMin", 0.0)
        # A linear ramp with slope (g - 1) keeps h(d + h) = g * h(d).
        gmsh.model.mesh.field.setNumber(
            threshold, "DistMax", (size_max - target) / (growth - 1.0)
        )
        thresholds.append(threshold)
        smallest = target if smallest is None else min(smallest, target)
    report: dict[str, object] = {
        "curvature_factor": curvature_factor,
        "refined_surface_count": len(thresholds),
        "smallest_surface_target": smallest,
    }
    if not thresholds:
        report["status"] = "inactive"
        report["reason"] = "no air-adjacent surface has a sampled curvature below the air target"
        return None, report
    report["status"] = "active"
    return _restrict_to_air(gmsh, thresholds, air_volume_tags), report


def _add_air_gap_field(
    gmsh: Any,
    *,
    narrow_region_resolution: float,
    walls: Sequence[Sequence[int]],
    air_volume_tags: Sequence[int],
    size_max: float,
    size_min: float,
) -> tuple[int | None, dict[str, object]]:
    """Eqs. eq-air-gap-width, eq-air-gap-count and eq-air-gap-target."""
    elements_across = _resolve_narrow_region_count(0, narrow_region_resolution)
    report: dict[str, object] = {
        "narrow_region_resolution": narrow_region_resolution,
        "elements_across_gap": elements_across,
        "wall_count": len(walls),
    }
    if len(walls) < 2:
        report["status"] = "inactive"
        report["reason"] = "fewer than two air walls (one body and no outer boundary)"
        return None, report
    if len(walls) > MAX_AIRBOX_GAP_WALLS:
        raise ValueError(
            f"airbox narrow_region_resolution supports at most {MAX_AIRBOX_GAP_WALLS} "
            f"air walls (bodies plus outer boundary); got {len(walls)}"
        )
    distances: list[int] = []
    for wall in walls:
        distance = gmsh.model.mesh.field.add("Distance")
        gmsh.model.mesh.field.setNumbers(distance, "SurfacesList", [int(tag) for tag in wall])
        gmsh.model.mesh.field.setNumber(distance, "Sampling", _DISTANCE_SAMPLING)
        distances.append(distance)
    pair_fields: list[int] = []
    for first in range(len(distances)):
        for second in range(first + 1, len(distances)):
            expression = (
                f"Min(Max((F{distances[first]} + F{distances[second]}) / {elements_across}, "
                f"{size_min!r}), {size_max!r})"
            )
            pair = gmsh.model.mesh.field.add("MathEval")
            gmsh.model.mesh.field.setString(pair, "F", expression)
            pair_fields.append(pair)
    report["status"] = "active"
    return _restrict_to_air(gmsh, pair_fields, air_volume_tags), report


def add_airbox_feature_fields(
    gmsh: Any,
    airbox: AirboxOptions,
    *,
    air_volume_tags: Sequence[int],
    body_surface_groups: Mapping[str, Sequence[int]],
    outer_surface_tags: Sequence[int],
) -> list[int]:
    """Build the air-restricted curvature and narrow-gap upper-bound fields.

    ``airbox`` must already be expressed in mesh coordinates (the caller's
    scaled options).  ``body_surface_groups`` holds the air-adjacent surfaces
    of each magnetic component; ``outer_surface_tags`` is the truncation
    boundary.  Returns the field ids to append to the background ``Min``.
    """
    if not airbox.has_feature_refinement:
        return []
    if not air_volume_tags:
        raise ValueError("airbox feature refinement requires air volumes")
    assert airbox.maximum_element_size is not None  # enforced by AirboxOptions
    size_max = float(airbox.maximum_element_size)
    size_min = _LOWER_CLAMP_FRACTION * size_max
    if airbox.minimum_element_size is not None:
        size_min = max(size_min, float(airbox.minimum_element_size))
    size_min = min(size_min, size_max)

    groups = {
        name: sorted({int(tag) for tag in tags})
        for name, tags in body_surface_groups.items()
        if tags
    }
    field_ids: list[int] = []
    event: dict[str, object] = {
        "kind": "airbox_feature_refinement",
        "air_maximum_element_size": size_max,
        "lower_clamp": size_min,
    }
    if airbox.curvature_factor is not None:
        field_id, report = _add_air_curvature_field(
            gmsh,
            curvature_factor=float(airbox.curvature_factor),
            surface_tags=_flatten_tags(groups),
            air_volume_tags=air_volume_tags,
            size_max=size_max,
            size_min=size_min,
            growth=float(airbox.grading_ratio),
        )
        event["curvature"] = report
        if field_id is not None:
            field_ids.append(field_id)
    if airbox.narrow_region_resolution is not None:
        walls: list[list[int]] = [tags for tags in groups.values()]
        outer = sorted({int(tag) for tag in outer_surface_tags})
        if outer:
            walls.append(outer)
        field_id, report = _add_air_gap_field(
            gmsh,
            narrow_region_resolution=float(airbox.narrow_region_resolution),
            walls=walls,
            air_volume_tags=air_volume_tags,
            size_max=size_max,
            size_min=size_min,
        )
        event["narrow_gap"] = report
        if field_id is not None:
            field_ids.append(field_id)
    emit_progress(
        "Gmsh: airbox feature refinement "
        + ", ".join(
            f"{name}={report['status']}"  # type: ignore[index]
            for name, report in (
                ("curvature", event.get("curvature")),
                ("narrow_gap", event.get("narrow_gap")),
            )
            if report is not None
        )
    )
    emit_progress_event(event)
    return field_ids
