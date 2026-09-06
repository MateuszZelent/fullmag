from __future__ import annotations

import itertools
import math
from typing import Any, Sequence


def _math_number(value: float) -> str:
    return f"{float(value):.17g}"


def _math_atom(value: float) -> str:
    return f"({_math_number(value)})"


def _growth_number(value: float) -> str:
    val = float(value)
    rendered = f"{val:.12g}"
    if rendered == "1" and val > 1.0:
        return f"{val:.17g}"
    return rendered


def _geometric_size_profile_expression(
    *,
    size_min: float,
    size_max: float,
    ramp: str,
    growth_rate: float | None,
) -> str:
    """Return a MathEval expression mapping a unit ramp from size_min to size_max."""
    min_value = float(size_min)
    max_value = float(size_max)
    if min_value <= 0.0 or max_value <= min_value:
        return _math_number(min_value)

    clamped_ramp = f"Min(Max(({ramp}), 0), 1)"
    if growth_rate is not None and float(growth_rate) > 1.0:
        g = float(growth_rate)
        if g - 1.0 > 1.0e-7:
            delta = f"({_growth_number(g)} - 1.0)"
            shaped_ramp = (
                f"(log(1 + {delta} * ({clamped_ramp})) / "
                f"log({_growth_number(g)}))"
            )
        else:
            shaped_ramp = clamped_ramp
    else:
        shaped_ramp = clamped_ramp

    return (
        f"{_math_number(min_value)} * "
        f"exp(log({_math_number(max_value)} / {_math_number(min_value)}) * "
        f"({shaped_ramp}))"
    )


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
            f"({_math_atom(object_min)} - {coord}) / {_math_number(lower_gap)}"
        )
    if upper_gap > 0.0:
        terms.append(
            f"({coord} - {_math_atom(object_max)}) / {_math_number(upper_gap)}"
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


def _spherical_airbox_fraction_expression(
    *,
    center: Sequence[float],
    object_radius: float,
    airbox_radius: float,
) -> str | None:
    span = float(airbox_radius) - float(object_radius)
    if span <= 0.0:
        return None
    cx, cy, cz = (_math_atom(float(value)) for value in center)
    radius_expr = (
        f"Sqrt((x - {cx}) * (x - {cx}) + "
        f"(y - {cy}) * (y - {cy}) + "
        f"(z - {cz}) * (z - {cz}))"
    )
    return (
        f"Min(Max(({radius_expr} - {_math_number(object_radius)}) / "
        f"{_math_number(span)}, 0), 1)"
    )


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

    field_id = gmsh.model.mesh.field.add("MathEval")
    gmsh.model.mesh.field.setString(
        field_id,
        "F",
        _geometric_size_profile_expression(
            size_min=float(h_inner),
            size_max=float(h_outer),
            ramp=fraction,
            growth_rate=float(grading_ratio),
        ),
    )
    return field_id


def _add_airbox_envelope_field(
    gmsh: Any,
    *,
    h_inner: float,
    h_outer: float,
    grading_ratio: float,
    airbox_shape: str,
    object_bounds_min: Sequence[float] | None,
    object_bounds_max: Sequence[float] | None,
    airbox_bounds_min: Sequence[float] | None,
    airbox_bounds_max: Sequence[float] | None,
    airbox_center: Sequence[float] | None,
    object_radius: float | None,
    airbox_radius: float | None,
) -> int | None:
    shape = str(airbox_shape).strip().lower()
    if shape == "sphere":
        if (
            airbox_center is not None
            and object_radius is not None
            and airbox_radius is not None
        ):
            fraction = _spherical_airbox_fraction_expression(
                center=airbox_center,
                object_radius=float(object_radius),
                airbox_radius=float(airbox_radius),
            )
        else:
            fraction = None
    elif (
        object_bounds_min is not None
        and object_bounds_max is not None
        and airbox_bounds_min is not None
        and airbox_bounds_max is not None
    ):
        return _add_rectangular_airbox_envelope_field(
            gmsh,
            h_inner=h_inner,
            h_outer=h_outer,
            grading_ratio=grading_ratio,
            object_bounds_min=object_bounds_min,
            object_bounds_max=object_bounds_max,
            airbox_bounds_min=airbox_bounds_min,
            airbox_bounds_max=airbox_bounds_max,
        )
    else:
        fraction = None
    if fraction is None:
        return None

    field_id = gmsh.model.mesh.field.add("MathEval")
    gmsh.model.mesh.field.setString(
        field_id,
        "F",
        _geometric_size_profile_expression(
            size_min=float(h_inner),
            size_max=float(h_outer),
            ramp=fraction,
            growth_rate=float(grading_ratio),
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
    airbox_shape: str = "bbox",
    airbox_center: Sequence[float] | None = None,
    object_radius: float | None = None,
    airbox_radius: float | None = None,
    air_volume_tags: Sequence[int] | None = None,
) -> int | None:
    """Add a background size field grading from body interface to airbox target."""
    surfaces = [int(tag) for tag in surface_tags]
    if not surfaces or grading_ratio <= 1.0:
        return None

    f_dist = gmsh.model.mesh.field.add("Distance")
    gmsh.model.mesh.field.setNumbers(f_dist, "SurfacesList", surfaces)
    gmsh.model.mesh.field.setNumber(f_dist, "Sampling", int(max(2, sampling)))

    if str(grading_mode).lower() == "geometric":
        f_growth = gmsh.model.mesh.field.add("MathEval")
        dist_span = max(float(dist_max), float(h_inner))
        gmsh.model.mesh.field.setString(
            f_growth,
            "F",
            _geometric_size_profile_expression(
                size_min=float(h_inner),
                size_max=float(h_outer),
                ramp=f"F{f_dist} / {_math_number(dist_span)}",
                growth_rate=float(grading_ratio),
            ),
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

    envelope_field = _add_airbox_envelope_field(
        gmsh,
        h_inner=float(h_inner),
        h_outer=float(h_outer),
        grading_ratio=float(grading_ratio),
        airbox_shape=airbox_shape,
        object_bounds_min=object_bounds_min,
        object_bounds_max=object_bounds_max,
        airbox_bounds_min=airbox_bounds_min,
        airbox_bounds_max=airbox_bounds_max,
        airbox_center=airbox_center,
        object_radius=object_radius,
        airbox_radius=airbox_radius,
    )

    if envelope_field is None:
        return _restrict_field_to_volumes(
            gmsh,
            local_field,
            volume_tags=air_volume_tags,
        )

    combined = gmsh.model.mesh.field.add("Max")
    gmsh.model.mesh.field.setNumbers(
        combined,
        "FieldsList",
        [local_field, envelope_field],
    )
    return _restrict_field_to_volumes(
        gmsh,
        combined,
        volume_tags=air_volume_tags,
    )


def _restrict_field_to_volumes(
    gmsh: Any,
    field_id: int,
    *,
    volume_tags: Sequence[int] | None,
) -> int:
    volumes = sorted({int(tag) for tag in volume_tags or []})
    if not volumes:
        return int(field_id)

    restricted = gmsh.model.mesh.field.add("Restrict")
    gmsh.model.mesh.field.setNumber(restricted, "InField", int(field_id))
    gmsh.model.mesh.field.setNumbers(restricted, "VolumesList", volumes)
    return int(restricted)
