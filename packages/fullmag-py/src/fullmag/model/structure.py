from __future__ import annotations

from dataclasses import dataclass

from fullmag._validation import as_vector3, require_non_empty, require_non_negative, require_positive
from fullmag.init import InitialMagnetization, uniform
from fullmag.model.geometry import Geometry


@dataclass(frozen=True, slots=True)
class Material:
    name: str
    Ms: float
    A: float
    alpha: float
    Ku1: float | None = None
    anisU: tuple[float, float, float] | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", require_non_empty(self.name, "name"))
        require_positive(self.Ms, "Ms")
        require_positive(self.A, "A")
        require_non_negative(self.alpha, "alpha")
        if self.Ku1 is not None:
            require_non_negative(self.Ku1, "Ku1")
        if self.anisU is not None:
            object.__setattr__(self, "anisU", as_vector3(self.anisU, "anisU"))

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "saturation_magnetisation": self.Ms,
            "exchange_stiffness": self.A,
            "damping": self.alpha,
            "uniaxial_anisotropy": self.Ku1,
            "anisotropy_axis": list(self.anisU) if self.anisU else None,
        }


@dataclass(frozen=True, slots=True)
class Region:
    name: str
    geometry: Geometry

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", require_non_empty(self.name, "name"))

    def to_ir(self) -> dict[str, object]:
        return {"name": self.name, "geometry": self.geometry.geometry_name}


@dataclass(frozen=True, slots=True)
class Ferromagnet:
    name: str
    geometry: Geometry
    material: Material
    region: Region | None = None
    m0: InitialMagnetization | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", require_non_empty(self.name, "name"))
        if self.region is not None and self.region.geometry.geometry_name != self.geometry.geometry_name:
            raise ValueError("region geometry must match magnet geometry")
        if self.m0 is None:
            object.__setattr__(self, "m0", uniform((1.0, 0.0, 0.0)))

    @property
    def region_name(self) -> str:
        if self.region is not None:
            return self.region.name
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "region": self.region_name,
            "material": self.material.name,
            "initial_magnetization": self.m0.to_ir() if self.m0 else None,
        }
