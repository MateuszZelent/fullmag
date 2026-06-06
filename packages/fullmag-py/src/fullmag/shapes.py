from __future__ import annotations

from fullmag._validation import as_vector3
from fullmag.model.geometry import (
    ArchWaveguide,
    Box,
    Cylinder,
    Ellipse,
    Ellipsoid,
    Geometry,
    ImportedGeometry,
    SinWaveguide,
    Sphere,
)


def _with_center(shape: Geometry, center: tuple[float, float, float] | None) -> Geometry:
    if center is None:
        return shape
    normalized = as_vector3(center, "center")
    if normalized == (0.0, 0.0, 0.0):
        return shape
    return shape.translate(normalized)


def box(
    size: tuple[float, float, float],
    *,
    center: tuple[float, float, float] | None = None,
    name: str = "box",
) -> Geometry:
    return _with_center(Box(size=size, name=name), center)


def cylinder(
    *,
    radius: float,
    height: float,
    center: tuple[float, float, float] | None = None,
    name: str = "cylinder",
) -> Geometry:
    return _with_center(Cylinder(radius=radius, height=height, name=name), center)


def sphere(
    *,
    radius: float,
    center: tuple[float, float, float] | None = None,
    name: str = "sphere",
) -> Geometry:
    return _with_center(Sphere(radius=radius, name=name), center)


def ellipsoid(
    *,
    rx: float,
    ry: float,
    rz: float,
    center: tuple[float, float, float] | None = None,
    name: str = "ellipsoid",
) -> Geometry:
    return _with_center(Ellipsoid(rx=rx, ry=ry, rz=rz, name=name), center)


def ellipse(
    *,
    rx: float,
    ry: float,
    height: float,
    center: tuple[float, float, float] | None = None,
    name: str = "ellipse",
) -> Geometry:
    return _with_center(Ellipse(rx=rx, ry=ry, height=height, name=name), center)


def arch_waveguide(
    *,
    length: float,
    width: float,
    height: float,
    arch_height: float,
    center: tuple[float, float, float] | None = None,
    z0: float = 0.0,
    name: str = "arch_waveguide",
) -> Geometry:
    return _with_center(
        ArchWaveguide(
            length=length,
            width=width,
            height=height,
            arch_height=arch_height,
            z0=z0,
            name=name,
        ),
        center,
    )


def sin_waveguide(
    *,
    length: float,
    width: float,
    height: float,
    period: float,
    amplitude: float,
    center: tuple[float, float, float] | None = None,
    phase: float = 0.0,
    z0: float = 0.0,
    name: str = "sin_waveguide",
) -> Geometry:
    return _with_center(
        SinWaveguide(
            length=length,
            width=width,
            height=height,
            period=period,
            amplitude=amplitude,
            phase=phase,
            z0=z0,
            name=name,
        ),
        center,
    )


def imported(
    source: str,
    *,
    center: tuple[float, float, float] | None = None,
    name: str | None = None,
    scale: float | tuple[float, float, float] = 1.0,
    units: str | None = None,
    volume: str = "full",
) -> Geometry:
    return _with_center(
        ImportedGeometry(
            source=source,
            scale=scale,
            units=units,
            name=name,
            volume=volume,  # type: ignore[arg-type]
        ),
        center,
    )


__all__ = [
    "arch_waveguide",
    "box",
    "cylinder",
    "ellipse",
    "ellipsoid",
    "imported",
    "sin_waveguide",
    "sphere",
]
