from __future__ import annotations

from fullmag.model.structure import MaterialParameterField


def constant(value: float | tuple[float, float, float], unit: str | None = None) -> MaterialParameterField:
    return MaterialParameterField.constant(value, unit=unit)


def linear(
    *,
    base: float,
    gradient: tuple[float, float, float],
    frame: str = "object",
    unit: str | None = None,
) -> MaterialParameterField:
    return MaterialParameterField.linear(
        base=base,
        gradient=gradient,
        frame=frame,
        unit=unit,
    )


def radial(
    *,
    center: tuple[float, float, float],
    radius: float,
    inside: float,
    outside: float,
    frame: str = "object",
    unit: str | None = None,
) -> MaterialParameterField:
    return MaterialParameterField.radial(
        center=center,
        radius=radius,
        inside=inside,
        outside=outside,
        frame=frame,
        unit=unit,
    )


def sampled(
    *,
    asset_id: str,
    component_count: int,
    location: str,
    unit: str,
) -> MaterialParameterField:
    return MaterialParameterField.sampled(
        asset_id=asset_id,
        component_count=component_count,
        location=location,
        unit=unit,
    )


__all__ = ["MaterialParameterField", "constant", "linear", "radial", "sampled"]
