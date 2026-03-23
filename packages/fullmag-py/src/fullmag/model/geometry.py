from __future__ import annotations

from dataclasses import dataclass
from typing import TypeAlias

from fullmag._validation import (
    as_vector3,
    infer_geometry_format,
    require_non_empty,
    require_positive,
)


@dataclass(frozen=True, slots=True)
class ImportedGeometry:
    source: str
    name: str | None = None

    def __post_init__(self) -> None:
        source = require_non_empty(self.source, "source")
        object.__setattr__(self, "source", source)
        if self.name is not None:
            object.__setattr__(self, "name", require_non_empty(self.name, "name"))

    @property
    def geometry_name(self) -> str:
        if self.name is not None:
            return self.name
        return self.source.rsplit("/", 1)[-1].rsplit(".", 1)[0]

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.geometry_name,
            "kind": "imported_geometry",
            "source": self.source,
            "format": infer_geometry_format(self.source),
        }


@dataclass(frozen=True, slots=True)
class Box:
    size: tuple[float, float, float]
    name: str = "box"

    def __init__(self, size: tuple[float, float, float], name: str = "box") -> None:
        normalized_size = as_vector3(size, "size")
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
class Cylinder:
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


Geometry: TypeAlias = ImportedGeometry | Box | Cylinder
