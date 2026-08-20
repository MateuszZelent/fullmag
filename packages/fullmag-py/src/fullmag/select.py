from __future__ import annotations

from .model.selection import (
    MagnetizationSelectionScalars,
    Selection,
    SelectionScalar,
    all_magnetic_selection,
    between_selection,
    canonical_selection_sha256,
    coordinate_selection,
    in_object_selection,
    in_region_selection,
    inside_selection,
)


m = MagnetizationSelectionScalars()


def all_magnetic() -> Selection:
    return all_magnetic_selection()


def in_object(value: object) -> Selection:
    return in_object_selection(value)


def in_region(owner: object, region: object) -> Selection:
    return in_region_selection(owner, region)


def inside(
    geometry: object,
    *,
    frame: object = "world",
    boundary: str = "inclusive",
    absolute_tolerance_m: object = 0.0,
    relative_tolerance: object = 1.0e-12,
    object_bounds_m: object = None,
) -> Selection:
    return inside_selection(
        geometry,
        frame=frame,
        boundary=boundary,
        absolute_tolerance_m=absolute_tolerance_m,
        relative_tolerance=relative_tolerance,
        object_bounds_m=object_bounds_m,
    )


def coordinate(component: str, *, frame: object = "world") -> SelectionScalar:
    return coordinate_selection(component, frame)


def between(
    value: SelectionScalar,
    lower: object,
    upper: object,
    *,
    closed: str = "both",
) -> Selection:
    return between_selection(value, lower, upper, closed=closed)


__all__ = [
    "all_magnetic",
    "between",
    "canonical_selection_sha256",
    "coordinate",
    "in_object",
    "in_region",
    "inside",
    "m",
]
