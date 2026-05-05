from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Literal, TypeAlias

from fullmag._validation import (
    as_vector3,
    infer_geometry_format,
    require_non_empty,
    require_positive,
)


# ---------------------------------------------------------------------------
# Mixin for CSG operator overloads
# ---------------------------------------------------------------------------
class _GeometryOps:
    """Mixin providing ``-``, ``+``, ``&`` operators for CSG boolean ops."""

    def __sub__(self, other: "Geometry") -> "Difference":
        return Difference(base=self, tool=other)  # type: ignore[arg-type]

    def __add__(self, other: "Geometry") -> "Union":
        return Union(a=self, b=other)  # type: ignore[arg-type]

    def __and__(self, other: "Geometry") -> "Intersection":
        return Intersection(a=self, b=other)  # type: ignore[arg-type]

    def translate(self, offset: tuple[float, float, float]) -> "Translate":
        return Translate(geometry=self, offset=offset)  # type: ignore[arg-type]


def _format_translation_component(value: float) -> str:
    return f"{value:.6g}"


def _derived_translate_name(base_name: str, offset: tuple[float, float, float]) -> str:
    components = "_".join(_format_translation_component(component) for component in offset)
    return f"{base_name}__translate_{components}"


def _require_finite(value: float, field: str) -> float:
    normalized = float(value)
    if not math.isfinite(normalized):
        raise ValueError(f"{field} must be finite")
    return normalized


# ---------------------------------------------------------------------------
# Imported geometry (NPZ mask, STL, STEP, etc.)
# ---------------------------------------------------------------------------
ImportedGeometryScale: TypeAlias = float | tuple[float, float, float]
ImportedGeometryUnits: TypeAlias = str
ImportedGeometryVolume: TypeAlias = Literal["full", "surface"]

_IMPORTED_GEOMETRY_UNIT_SCALES: dict[str, float] = {
    "m": 1.0,
    "cm": 1e-2,
    "mm": 1e-3,
    "um": 1e-6,
    "µm": 1e-6,
    "μm": 1e-6,
    "nm": 1e-9,
    "pm": 1e-12,
}
_IMPORTED_GEOMETRY_VOLUMES: tuple[ImportedGeometryVolume, ...] = ("full", "surface")


def _normalize_import_units(units: ImportedGeometryUnits | None) -> tuple[ImportedGeometryUnits | None, float]:
    if units is None:
        return None, 1.0
    normalized = require_non_empty(units, "units").strip().lower()
    try:
        return normalized, _IMPORTED_GEOMETRY_UNIT_SCALES[normalized]
    except KeyError as exc:
        supported = ", ".join(sorted(_IMPORTED_GEOMETRY_UNIT_SCALES))
        raise ValueError(f"units must be one of: {supported}") from exc


def _apply_unit_scale(
    scale: ImportedGeometryScale,
    unit_scale: float,
) -> ImportedGeometryScale:
    if isinstance(scale, (int, float)):
        return float(scale) * unit_scale
    return tuple(float(component) * unit_scale for component in scale)


def _normalize_import_volume(volume: ImportedGeometryVolume | None) -> ImportedGeometryVolume:
    if volume is None:
        return "full"
    normalized = require_non_empty(volume, "volume").strip().lower()
    if normalized not in _IMPORTED_GEOMETRY_VOLUMES:
        supported = ", ".join(_IMPORTED_GEOMETRY_VOLUMES)
        raise ValueError(f"volume must be one of: {supported}")
    return normalized  # type: ignore[return-value]


@dataclass(frozen=True, slots=True)
class ImportedGeometry(_GeometryOps):
    source: str
    scale: ImportedGeometryScale = 1.0
    units: ImportedGeometryUnits | None = None
    name: str | None = None
    volume: ImportedGeometryVolume = "full"

    def __post_init__(self) -> None:
        source = require_non_empty(self.source, "source")
        object.__setattr__(self, "source", source)
        normalized_units, unit_scale = _normalize_import_units(self.units)
        object.__setattr__(self, "units", normalized_units)
        object.__setattr__(self, "volume", _normalize_import_volume(self.volume))
        effective_scale = _apply_unit_scale(self.scale, unit_scale)
        if isinstance(self.scale, (int, float)):
            object.__setattr__(self, "scale", require_positive(float(effective_scale), "scale"))
        else:
            normalized_scale = as_vector3(effective_scale, "scale")
            for index, component in enumerate(normalized_scale):
                require_positive(component, f"scale[{index}]")
            object.__setattr__(self, "scale", normalized_scale)
        if self.name is not None:
            object.__setattr__(self, "name", require_non_empty(self.name, "name"))

    @property
    def geometry_name(self) -> str:
        if self.name is not None:
            return self.name
        return self.source.rsplit("/", 1)[-1].rsplit(".", 1)[0]

    def to_ir(self) -> dict[str, object]:
        scale_ir: float | list[float]
        if isinstance(self.scale, (int, float)):
            scale_ir = float(self.scale)
        else:
            scale_ir = list(self.scale)
        return {
            "name": self.geometry_name,
            "kind": "imported_geometry",
            "source": self.source,
            "format": infer_geometry_format(self.source),
            "scale": scale_ir,
            **({"volume": self.volume} if self.volume != "full" else {}),
        }


# ---------------------------------------------------------------------------
# Primitive shapes
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class Box(_GeometryOps):
    """Axis-aligned box centered at origin."""

    size: tuple[float, float, float]
    name: str = "box"

    def __init__(
        self,
        size_or_x: tuple[float, float, float] | float | None = None,
        y: float | None = None,
        z: float | None = None,
        *,
        size: tuple[float, float, float] | None = None,
        name: str = "box",
    ) -> None:
        # Support both Box(size=(dx,dy,dz)) and Box(dx, dy, dz)
        if size is not None:
            resolved = size
        elif isinstance(size_or_x, (list, tuple)):
            resolved = size_or_x
        elif size_or_x is not None and y is not None and z is not None:
            resolved = (size_or_x, y, z)
        elif size_or_x is not None:
            raise TypeError("Box() requires 3 dimensions: Box(dx, dy, dz) or Box(size=(dx, dy, dz))")
        else:
            raise TypeError("Box() requires size argument")
        normalized_size = as_vector3(resolved, "size")
        for index, component in enumerate(normalized_size):
            require_positive(component, f"size[{index}]")
        object.__setattr__(self, "size", normalized_size)
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "box",
            "size": list(self.size),
        }


@dataclass(frozen=True, slots=True)
class Cylinder(_GeometryOps):
    """Circular cylinder centered at origin, axis along z."""

    radius: float
    height: float
    name: str = "cylinder"

    def __init__(self, radius: float, height: float, name: str = "cylinder") -> None:
        object.__setattr__(self, "radius", require_positive(radius, "radius"))
        object.__setattr__(self, "height", require_positive(height, "height"))
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "cylinder",
            "radius": self.radius,
            "height": self.height,
        }


@dataclass(frozen=True, slots=True)
class SinWaveguide(_GeometryOps):
    length: float
    width: float
    height: float
    period: float
    amplitude: float
    phase: float = 0.0
    z0: float = 0.0
    name: str = "sin_waveguide"

    def __init__(
        self,
        length: float,
        width: float,
        height: float,
        period: float,
        amplitude: float,
        *,
        phase: float = 0.0,
        z0: float = 0.0,
        name: str = "sin_waveguide",
    ) -> None:
        object.__setattr__(self, "length", require_positive(length, "length"))
        object.__setattr__(self, "width", require_positive(width, "width"))
        object.__setattr__(self, "height", require_positive(height, "height"))
        object.__setattr__(self, "period", require_positive(period, "period"))
        object.__setattr__(self, "amplitude", _require_finite(amplitude, "amplitude"))
        object.__setattr__(self, "phase", _require_finite(phase, "phase"))
        object.__setattr__(self, "z0", _require_finite(z0, "z0"))
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "sin_waveguide",
            "length": self.length,
            "width": self.width,
            "height": self.height,
            "period": self.period,
            "amplitude": self.amplitude,
            "phase": self.phase,
            "z0": self.z0,
        }


@dataclass(frozen=True, slots=True)
class ArchWaveguide(_GeometryOps):
    length: float
    width: float
    height: float
    arch_height: float
    z0: float = 0.0
    name: str = "arch_waveguide"

    def __init__(
        self,
        length: float,
        width: float,
        height: float,
        arch_height: float,
        *,
        z0: float = 0.0,
        name: str = "arch_waveguide",
    ) -> None:
        object.__setattr__(self, "length", require_positive(length, "length"))
        object.__setattr__(self, "width", require_positive(width, "width"))
        object.__setattr__(self, "height", require_positive(height, "height"))
        object.__setattr__(self, "arch_height", _require_finite(arch_height, "arch_height"))
        object.__setattr__(self, "z0", _require_finite(z0, "z0"))
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "arch_waveguide",
            "length": self.length,
            "width": self.width,
            "height": self.height,
            "arch_height": self.arch_height,
            "z0": self.z0,
        }


@dataclass(frozen=True, slots=True)
class Ellipsoid(_GeometryOps):
    """Ellipsoid centered at origin with semi-axes (rx, ry, rz).

    For a sphere, use ``Sphere(r)`` or ``Ellipsoid(r, r, r)``.
    """

    rx: float
    ry: float
    rz: float
    name: str = "ellipsoid"

    def __init__(
        self, rx: float, ry: float, rz: float, name: str = "ellipsoid"
    ) -> None:
        object.__setattr__(self, "rx", require_positive(rx, "rx"))
        object.__setattr__(self, "ry", require_positive(ry, "ry"))
        object.__setattr__(self, "rz", require_positive(rz, "rz"))
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "ellipsoid",
            "rx": self.rx,
            "ry": self.ry,
            "rz": self.rz,
        }


def Sphere(radius: float, name: str = "sphere") -> Ellipsoid:
    """Convenience constructor for a sphere (uniform ellipsoid)."""
    return Ellipsoid(rx=radius, ry=radius, rz=radius, name=name)


@dataclass(frozen=True, slots=True)
class Ellipse(_GeometryOps):
    """Elliptical disk centered at origin, axis along z.

    For a circular disk, use ``Ellipse(r, r, h)`` or just ``Cylinder(r, h)``.
    """

    rx: float
    ry: float
    height: float
    name: str = "ellipse"

    def __init__(
        self, rx: float, ry: float, height: float, name: str = "ellipse"
    ) -> None:
        object.__setattr__(self, "rx", require_positive(rx, "rx"))
        object.__setattr__(self, "ry", require_positive(ry, "ry"))
        object.__setattr__(self, "height", require_positive(height, "height"))
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "ellipse",
            "rx": self.rx,
            "ry": self.ry,
            "height": self.height,
        }


# ---------------------------------------------------------------------------
# CSG boolean operations
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class Difference(_GeometryOps):
    """CSG Boolean difference: base geometry minus tool geometry.

    Example: Box with a cylindrical hole::

        body = fm.Box(size=(1e-6, 1e-6, 10e-9)) - fm.Cylinder(radius=50e-9, height=10e-9)
    """

    base: "Geometry"
    tool: "Geometry"
    name: str = "difference"

    def __init__(
        self,
        base: "Geometry",
        tool: "Geometry",
        name: str = "difference",
    ) -> None:
        object.__setattr__(self, "base", base)
        object.__setattr__(self, "tool", tool)
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "difference",
            "base": self.base.to_ir(),
            "tool": self.tool.to_ir(),
        }


@dataclass(frozen=True, slots=True)
class Union(_GeometryOps):
    """CSG Boolean union: combine two geometries.

    Example::

        body = fm.Box(size=(1e-6, 1e-6, 10e-9)) + fm.Cylinder(radius=50e-9, height=10e-9)
    """

    a: "Geometry"
    b: "Geometry"
    name: str = "union"

    def __init__(
        self,
        a: "Geometry",
        b: "Geometry",
        name: str = "union",
    ) -> None:
        object.__setattr__(self, "a", a)
        object.__setattr__(self, "b", b)
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "union",
            "a": self.a.to_ir(),
            "b": self.b.to_ir(),
        }


@dataclass(frozen=True, slots=True)
class Intersection(_GeometryOps):
    """CSG Boolean intersection: keep only overlapping region.

    Example::

        body = fm.Box(size=(1e-6, 1e-6, 10e-9)) & fm.Cylinder(radius=50e-9, height=10e-9)
    """

    a: "Geometry"
    b: "Geometry"
    name: str = "intersection"

    def __init__(
        self,
        a: "Geometry",
        b: "Geometry",
        name: str = "intersection",
    ) -> None:
        object.__setattr__(self, "a", a)
        object.__setattr__(self, "b", b)
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "intersection",
            "a": self.a.to_ir(),
            "b": self.b.to_ir(),
        }


# ---------------------------------------------------------------------------
# Spatial transformations
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class Translate(_GeometryOps):
    """Translate (offset) a geometry by a 3D vector.

    Example: Hole off-center::

        hole = fm.Cylinder(radius=50e-9, height=10e-9).translate((100e-9, 0, 0))
    """

    geometry: "Geometry"
    offset: tuple[float, float, float]
    name: str | None = None

    def __init__(
        self,
        geometry: "Geometry",
        offset: tuple[float, float, float],
        name: str | None = None,
    ) -> None:
        object.__setattr__(self, "geometry", geometry)
        normalized_offset = as_vector3(offset, "offset")
        object.__setattr__(self, "offset", normalized_offset)
        if name is not None:
            object.__setattr__(self, "name", require_non_empty(name, "name"))
        else:
            object.__setattr__(self, "name", None)

    @property
    def geometry_name(self) -> str:
        if self.name is not None:
            return self.name
        return _derived_translate_name(self.geometry.geometry_name, self.offset)

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.geometry_name,
            "kind": "translate",
            "base": self.geometry.to_ir(),
            "by": list(self.offset),
        }


# ---------------------------------------------------------------------------
# Type alias
# ---------------------------------------------------------------------------
Geometry: TypeAlias = (
    ImportedGeometry
    | Box
    | Cylinder
    | SinWaveguide
    | ArchWaveguide
    | Ellipsoid
    | Ellipse
    | Difference
    | Union
    | Intersection
    | Translate
)
