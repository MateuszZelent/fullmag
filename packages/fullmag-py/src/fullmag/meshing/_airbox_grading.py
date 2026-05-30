from __future__ import annotations

import itertools
import math
from typing import Any, Sequence


def _math_number(value: float) -> str:
    return f"{float(value):.17g}"


def _distance_from_point_to_box(
    point: Sequence[float],
    bounds_min: Sequence[float],
    bounds_max: Sequence[float],
) -> float:
    squared = 0.0
    for coordinate, lower, upper in zip(point, bounds_min, bounds_max, strict=True):
        value = float(coordinate)
        if value < float(lower):
            delta = float(lower) - value
        elif value > float(upper):
            delta = value - float(upper)
        else:
            delta = 0.0
        squared += delta * delta
    return math.sqrt(squared)


def _airbox_boundary_distance_from_bbox(
    *,
    object_bounds_min: Sequence[float],
    object_bounds_max: Sequence[float],
    airbox_bounds_min: Sequence[float],
    airbox_bounds_max: Sequence[float],
) -> float:
    """Return a conservative object-to-airbox distance covering box corners."""
    corners = itertools.product(
        [float(airbox_bounds_min[0]), float(airbox_bounds_max[0])],
        [float(airbox_bounds_min[1]), float(airbox_bounds_max[1])],
        [float(airbox_bounds_min[2]), float(airbox_bounds_max[2])],
    )
    return max(
        _distance_from_point_to_box(corner, object_bounds_min, object_bounds_max)
        for corner in corners
    )


def _axis_fraction_expression(
    coord: str,
    object_min: float,
    object_max: float,
    airbox_min: float,
    airbox_max: float,
) -> str:
    terms: list[str] = []
    lower_gap = float(object_min) - float(airbox_min)
    upper_gap = float(airbox_max) - float(object_max)
    if lower_gap > 0.0:
        terms.append(
            f"({_math_number(object_min)} - {coord}) / {_math_number(lower_gap)}"
        )
    if upper_gap > 0.0:
        terms.append(
            f"({coord} - {_math_number(object_max)}) / {_math_number(upper_gap)}"
        )
    if not terms:
        return "0"
    if len(terms) == 1:
        return f"Max({terms[0]}, 0)"
    return f"Max(Max({terms[0]}, {terms[1]}), 0)"


def _rectangular_airbox_fraction_expression(
    *,
    object_bounds_min: Sequence[float],
    object_bounds_max: Sequence[float],
    airbox_bounds_min: Sequence[float],
    airbox_bounds_max: Sequence[float],
) -> str | None:
    if not (
        len(object_bounds_min)
        == len(object_bounds_max)
        == len(airbox_bounds_min)
        == len(airbox_bounds_max)
        == 3
    ):
        return None

    axes = [
        _axis_fraction_expression(
            coord,
            float(object_bounds_min[index]),
            float(object_bounds_max[index]),
            float(airbox_bounds_min[index]),
            float(airbox_bounds_max[index]),
        )
        for index, coord in enumerate(("x", "y", "z"))
    ]
    if all(axis == "0" for axis in axes):
        return None
    return f"Min(Max(Max({axes[0]}, {axes[1]}), {axes[2]}), 1)"


def _airbox_envelope_inner_size(
    *,
    h_inner: float,
    h_outer: float,
    grading_ratio: float,
) -> float:
    if h_outer <= h_inner or grading_ratio <= 1.0:
        return h_inner
    # The surface-distance field owns the very fine near-interface halo.  The
    # rectangular envelope only prevents the rest of the airbox from becoming a
    # flat h_outer plateau, so start it at a coarse-but-still-constraining size.
    return min(h_outer, max(h_inner, h_outer / (grading_ratio ** 4)))


def _add_rectangular_airbox_envelope_field(
    gmsh: Any,
    *,
    h_inner: float,
    h_outer: float,
    grading_ratio: float,
    object_bounds_min: Sequence[float],
    object_bounds_max: Sequence[float],
    airbox_bounds_min: Sequence[float],
    airbox_bounds_max: Sequence[float],
) -> int | None:
    fraction = _rectangular_airbox_fraction_expression(
        object_bounds_min=object_bounds_min,
        object_bounds_max=object_bounds_max,
        airbox_bounds_min=airbox_bounds_min,
        airbox_bounds_max=airbox_bounds_max,
    )
    if fraction is None:
        return None

    envelope_inner = _airbox_envelope_inner_size(
        h_inner=float(h_inner),
        h_outer=float(h_outer),
        grading_ratio=float(grading_ratio),
    )
    field_id = gmsh.model.mesh.field.add("MathEval")
    gmsh.model.mesh.field.setString(
        field_id,
        "F",
        (
            f"{_math_number(envelope_inner)} + "
            f"({_math_number(h_outer)} - {_math_number(envelope_inner)}) * ({fraction})"
        ),
    )
    return field_id


def _add_airbox_grading_field(
    gmsh: Any,
    *,
    surface_tags: Sequence[int],
    h_inner: float,
    h_outer: float,
    grading_ratio: float,
    grading_mode: str,
    dist_max: float,
    sampling: int = 20,
    object_bounds_min: Sequence[float] | None = None,
    object_bounds_max: Sequence[float] | None = None,
    airbox_bounds_min: Sequence[float] | None = None,
    airbox_bounds_max: Sequence[float] | None = None,
) -> int | None:
    """Add a background size field grading from body interface to airbox target."""
    surfaces = [int(tag) for tag in surface_tags]
    if not surfaces or grading_ratio <= 1.0:
        return None

    f_dist = gmsh.model.mesh.field.add("Distance")
    gmsh.model.mesh.field.setNumbers(f_dist, "SurfacesList", surfaces)
    gmsh.model.mesh.field.setNumber(f_dist, "Sampling", int(max(2, sampling)))

    if str(grading_mode).lower() == "geometric":
        log_g = math.log(float(grading_ratio))
        f_growth = gmsh.model.mesh.field.add("MathEval")
        gmsh.model.mesh.field.setString(
            f_growth,
            "F",
            f"{float(h_inner)} * exp({log_g} * F{f_dist} / {float(h_inner)})",
        )

        f_cap = gmsh.model.mesh.field.add("MathEval")
        gmsh.model.mesh.field.setString(f_cap, "F", f"{float(h_outer)}")

        f_min = gmsh.model.mesh.field.add("Min")
        gmsh.model.mesh.field.setNumbers(f_min, "FieldsList", [f_growth, f_cap])
        local_field = f_min
    else:
        f_thresh = gmsh.model.mesh.field.add("Threshold")
        gmsh.model.mesh.field.setNumber(f_thresh, "InField", f_dist)
        gmsh.model.mesh.field.setNumber(f_thresh, "SizeMin", float(h_inner))
        gmsh.model.mesh.field.setNumber(f_thresh, "SizeMax", float(h_outer))
        gmsh.model.mesh.field.setNumber(f_thresh, "DistMin", 0.0)
        gmsh.model.mesh.field.setNumber(
            f_thresh,
            "DistMax",
            max(float(dist_max), float(h_inner)),
        )
        local_field = f_thresh

    envelope_field = None
    if (
        object_bounds_min is not None
        and object_bounds_max is not None
        and airbox_bounds_min is not None
        and airbox_bounds_max is not None
    ):
        envelope_field = _add_rectangular_airbox_envelope_field(
            gmsh,
            h_inner=float(h_inner),
            h_outer=float(h_outer),
            grading_ratio=float(grading_ratio),
            object_bounds_min=object_bounds_min,
            object_bounds_max=object_bounds_max,
            airbox_bounds_min=airbox_bounds_min,
            airbox_bounds_max=airbox_bounds_max,
        )

    if envelope_field is None:
        return local_field

    combined = gmsh.model.mesh.field.add("Min")
    gmsh.model.mesh.field.setNumbers(
        combined,
        "FieldsList",
        [local_field, envelope_field],
    )
    return combined
