from __future__ import annotations

from dataclasses import dataclass
import warnings

from fullmag._validation import as_vector3, require_non_empty, require_non_negative, require_positive, require_finite
from fullmag.init import InitialMagnetization
from fullmag.init.magnetization import UniformMagnetization
from fullmag.model.discretization import PerObjectMeshRecipe
from fullmag.model.geometry import Geometry


@dataclass(frozen=True, slots=True)
class Material:
    """Magnetic material parameters expressed in SI units only.

    Units:
        Ms: saturation magnetization in A/m
        A: exchange stiffness in J/m
        alpha: Gilbert damping, dimensionless
        Ku1, Ku2: uniaxial anisotropy constants in J/m^3
        anisU: uniaxial easy axis as a dimensionless direction vector
        Kc1, Kc2, Kc3: cubic anisotropy constants in J/m^3
        anisC1, anisC2: cubic anisotropy axes as dimensionless direction vectors
        *_field: per-node overrides in the same SI unit as the corresponding scalar

    Example:
        Material(
            name="Py",
            Ms=8.0e5,
            A=1.3e-11,
            alpha=0.01,
            Ku1=0.0,
            anisU=(0.0, 0.0, 1.0),
        )

    Notes:
        Fullmag does not accept CGS-style authoring here. Pass SI values directly.
    """
    name: str
    Ms: float
    A: float
    alpha: float
    Ku1: float | None = None
    Ku2: float | None = None
    anisU: tuple[float, float, float] | None = None
    Kc1: float | None = None
    Kc2: float | None = None
    Kc3: float | None = None
    anisC1: tuple[float, float, float] | None = None
    anisC2: tuple[float, float, float] | None = None
    Dind: float | None = None
    Dbulk: float | None = None
    # Per-node spatially varying fields (override scalar when provided)
    Ms_field: list[float] | None = None
    A_field: list[float] | None = None
    alpha_field: list[float] | None = None
    Ku_field: list[float] | None = None
    Ku2_field: list[float] | None = None
    Kc1_field: list[float] | None = None
    Kc2_field: list[float] | None = None
    Kc3_field: list[float] | None = None
    Dind_field: list[float] | None = None
    Dbulk_field: list[float] | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", require_non_empty(self.name, "name"))
        require_positive(self.Ms, "Ms")
        require_positive(self.A, "A")
        require_non_negative(self.alpha, "alpha")
        if self.Ku1 is not None:
            require_non_negative(self.Ku1, "Ku1")
        if self.Ku2 is not None:
            require_non_negative(self.Ku2, "Ku2")
        if self.anisU is not None:
            object.__setattr__(self, "anisU", as_vector3(self.anisU, "anisU"))
        if self.anisC1 is not None:
            object.__setattr__(self, "anisC1", as_vector3(self.anisC1, "anisC1"))
        if self.anisC2 is not None:
            object.__setattr__(self, "anisC2", as_vector3(self.anisC2, "anisC2"))
        if self.Dind is not None:
            require_finite(self.Dind, "Dind")
        if self.Dbulk is not None:
            require_finite(self.Dbulk, "Dbulk")
        _warn_if_suspicious_si("Ms", self.Ms, lower=1.0e3, upper=1.0e8, unit="A/m")
        _warn_if_suspicious_si("A", self.A, lower=1.0e-14, upper=1.0e-8, unit="J/m")
        _warn_if_suspicious_si("alpha", self.alpha, lower=0.0, upper=10.0, unit="dimensionless")
        if self.Ku1 is not None:
            _warn_if_suspicious_si("Ku1", self.Ku1, lower=0.0, upper=1.0e10, unit="J/m^3")
        if self.Ku2 is not None:
            _warn_if_suspicious_si("Ku2", self.Ku2, lower=0.0, upper=1.0e10, unit="J/m^3")
        if self.Kc1 is not None:
            _warn_if_suspicious_si("Kc1", self.Kc1, lower=0.0, upper=1.0e10, unit="J/m^3")
        if self.Kc2 is not None:
            _warn_if_suspicious_si("Kc2", self.Kc2, lower=0.0, upper=1.0e10, unit="J/m^3")
        if self.Kc3 is not None:
            _warn_if_suspicious_si("Kc3", self.Kc3, lower=0.0, upper=1.0e10, unit="J/m^3")
        if self.Dind is not None:
            _warn_if_suspicious_si("Dind", self.Dind, lower=-1.0e-1, upper=1.0e-1, unit="J/m^2")
        if self.Dbulk is not None:
            _warn_if_suspicious_si("Dbulk", self.Dbulk, lower=-1.0e-1, upper=1.0e-1, unit="J/m^3")

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "saturation_magnetisation": self.Ms,
            "exchange_stiffness": self.A,
            "damping": self.alpha,
            "uniaxial_anisotropy": self.Ku1,
            "uniaxial_anisotropy_k2": self.Ku2,
            "anisotropy_axis": list(self.anisU) if self.anisU else None,
            "cubic_anisotropy_kc1": self.Kc1,
            "cubic_anisotropy_kc2": self.Kc2,
            "cubic_anisotropy_kc3": self.Kc3,
            "cubic_anisotropy_axis1": list(self.anisC1) if self.anisC1 else None,
            "cubic_anisotropy_axis2": list(self.anisC2) if self.anisC2 else None,
            "interfacial_dmi": self.Dind,
            "bulk_dmi": self.Dbulk,
            "ms_field": self.Ms_field,
            "a_field": self.A_field,
            "alpha_field": self.alpha_field,
            "ku_field": self.Ku_field,
            "ku2_field": self.Ku2_field,
            "kc1_field": self.Kc1_field,
            "kc2_field": self.Kc2_field,
            "kc3_field": self.Kc3_field,
            "dind_field": self.Dind_field,
            "dbulk_field": self.Dbulk_field,
        }


def _warn_if_suspicious_si(
    name: str,
    value: float,
    *,
    lower: float,
    upper: float,
    unit: str,
) -> None:
    if not (lower <= value <= upper):
        warnings.warn(
            f"{name}={value!r} looks unusual for SI input ({unit}). "
            "Double-check that the value is already expressed in SI units.",
            stacklevel=3,
        )


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
    mesh: PerObjectMeshRecipe | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", require_non_empty(self.name, "name"))
        if self.region is not None and self.region.geometry.geometry_name != self.geometry.geometry_name:
            raise ValueError("region geometry must match magnet geometry")
        if self.m0 is None:
            object.__setattr__(self, "m0", UniformMagnetization((1.0, 0.0, 0.0)))

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
            "mesh_recipe": self.mesh.to_ir() if self.mesh else None,
        }
