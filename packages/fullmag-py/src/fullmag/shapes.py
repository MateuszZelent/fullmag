from __future__ import annotations

from typing import Literal

from fullmag._validation import as_vector3
from fullmag.model.geometry import (
    ArchWaveguide,
    AuthoredSelectionAffine,
    AuthoredSelectionGeometry,
    Box,
    Cylinder,
    Ellipse,
    Ellipsoid,
    Geometry,
    ImportedGeometry,
    SinWaveguide,
    SelectionAffine,
    SelectionCylinder,
    SelectionThroughObjectDisk,
    Sphere,
    ThroughObjectExtrusion,
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


def disk(
    *,
    radius: float,
    thickness: float | None = None,
    center: tuple[float, float, float] = (0.0, 0.0, 0.0),
    normal: tuple[float, float, float] = (0.0, 0.0, 1.0),
    extrusion: Literal["finite", "through_object"] = "finite",
    object_id: str | None = None,
) -> AuthoredSelectionGeometry:
    """Build a selection-only disk predicate without evaluating point membership."""
    if extrusion == "finite":
        if object_id is not None:
            raise ValueError("object_id is only valid with through_object extrusion")
        if thickness is None:
            raise ValueError("thickness is required for finite disk extrusion")
        return SelectionCylinder(
            radius_m=radius,
            center_m=center,
            axis=normal,
            height_m=thickness,
        )
    if extrusion == "through_object":
        if thickness is not None:
            raise ValueError("thickness is not valid with through_object extrusion")
        if object_id is None:
            raise ValueError("object_id is required for through_object extrusion")
        return SelectionThroughObjectDisk(
            radius_m=radius,
            center_m=center,
            normal=normal,
            extrusion=ThroughObjectExtrusion(object_id=object_id),
        )
    raise ValueError("extrusion must be 'finite' or 'through_object'")


def affine(
    geometry: AuthoredSelectionGeometry,
    *,
    translation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    quaternion: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 1.0),
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0),
    pivot: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> AuthoredSelectionGeometry:
    """Build a serializable affine selection predicate without evaluating it."""
    fields = {
        "geometry": geometry,
        "translation_m": translation,
        "rotation_xyzw": quaternion,
        "scale": scale,
        "pivot_m": pivot,
    }
    if type(geometry) in (SelectionCylinder, SelectionAffine):
        return SelectionAffine(**fields)
    if type(geometry) in (SelectionThroughObjectDisk, AuthoredSelectionAffine):
        return AuthoredSelectionAffine(**fields)
    raise TypeError("geometry must be an exact AuthoredSelectionGeometry node")


def rotate(
    geometry: AuthoredSelectionGeometry,
    *,
    quaternion: tuple[float, float, float, float],
    pivot: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> AuthoredSelectionGeometry:
    """Build a rotation-only affine selection predicate."""
    return affine(geometry, quaternion=quaternion, pivot=pivot)


def scale(
    geometry: AuthoredSelectionGeometry,
    *,
    factors: tuple[float, float, float],
    pivot: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> AuthoredSelectionGeometry:
    """Build a scale-only affine selection predicate."""
    return affine(geometry, scale=factors, pivot=pivot)


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
    "affine",
    "arch_waveguide",
    "box",
    "cylinder",
    "disk",
    "ellipse",
    "ellipsoid",
    "imported",
    "rotate",
    "scale",
    "sin_waveguide",
    "sphere",
]
