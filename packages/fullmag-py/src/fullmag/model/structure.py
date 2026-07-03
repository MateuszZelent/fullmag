from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
import warnings

from fullmag._validation import as_vector3, require_non_empty, require_non_negative, require_positive, require_finite
from fullmag.init import InitialMagnetization, SampledMagnetization
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


_MATERIAL_PARAMETER_NAMES = {
    "Ms",
    "Aex",
    "Alpha",
    "Ku1",
    "Ku2",
    "AnisotropyAxis",
    "Kc1",
    "Kc2",
    "Kc3",
    "Dind",
    "Dbulk",
}

_REGION_FRAMES = {"object", "world"}
_REGION_REALIZATION_POLICIES = {"inherit", "conformal", "project"}
_REGION_CONFLICT_POLICIES = {"error", "higher_priority_wins", "min_mesh_size_wins"}
_MATERIAL_TRANSITION_KINDS = {"mesh_relative", "metric", "sharp"}
_MATERIAL_TRANSITION_SCOPES = {"boundary", "inside", "outside"}
_MATERIAL_FIELD_LOCATIONS = {"cell", "node", "element", "quadrature"}


@dataclass(frozen=True, slots=True)
class MaterialParameterField:
    """Authored spatial material parameter field for object-owned regions."""

    payload: dict[str, object]

    @staticmethod
    def constant(value: float | tuple[float, float, float], unit: str | None = None) -> "MaterialParameterField":
        if isinstance(value, (list, tuple)):
            resolved_value: object = list(as_vector3(value, "value"))
        else:
            resolved_value = require_finite(float(value), "value")
        payload: dict[str, object] = {"kind": "constant", "value": resolved_value}
        if unit is not None:
            payload["unit"] = require_non_empty(unit, "unit")
        return MaterialParameterField(payload)

    @staticmethod
    def linear(
        *,
        base: float,
        gradient: tuple[float, float, float],
        frame: str = "object",
        unit: str | None = None,
    ) -> "MaterialParameterField":
        normalized_frame = _normalize_choice(frame, _REGION_FRAMES, "frame")
        payload: dict[str, object] = {
            "kind": "linear",
            "base": require_finite(float(base), "base"),
            "gradient": list(as_vector3(gradient, "gradient")),
            "frame": normalized_frame,
        }
        if unit is not None:
            payload["unit"] = require_non_empty(unit, "unit")
        return MaterialParameterField(payload)

    @staticmethod
    def radial(
        *,
        center: tuple[float, float, float],
        radius: float,
        inside: float,
        outside: float,
        frame: str = "object",
        unit: str | None = None,
    ) -> "MaterialParameterField":
        normalized_frame = _normalize_choice(frame, _REGION_FRAMES, "frame")
        payload: dict[str, object] = {
            "kind": "radial",
            "center": list(as_vector3(center, "center")),
            "radius": require_positive(float(radius), "radius"),
            "inside": require_finite(float(inside), "inside"),
            "outside": require_finite(float(outside), "outside"),
            "frame": normalized_frame,
        }
        if unit is not None:
            payload["unit"] = require_non_empty(unit, "unit")
        return MaterialParameterField(payload)

    @staticmethod
    def sampled(
        *,
        asset_id: str,
        component_count: int,
        location: str,
        unit: str,
    ) -> "MaterialParameterField":
        if component_count < 1:
            raise ValueError("component_count must be >= 1")
        return MaterialParameterField(
            {
                "kind": "sampled",
                "asset_id": require_non_empty(asset_id, "asset_id"),
                "component_count": int(component_count),
                "location": _normalize_choice(location, _MATERIAL_FIELD_LOCATIONS, "location"),
                "unit": require_non_empty(unit, "unit"),
            }
        )

    def to_ir(self) -> dict[str, object]:
        return dict(self.payload)


@dataclass(frozen=True, slots=True)
class RegionMaterialOverride:
    parameter: str
    value: MaterialParameterField
    priority: int = 0
    conflict_policy: str = "error"

    def __post_init__(self) -> None:
        parameter = _normalize_parameter_name(self.parameter)
        _normalize_choice(self.conflict_policy, _REGION_CONFLICT_POLICIES, "conflict_policy")
        _validate_material_parameter_field(parameter, self.value)

    def to_ir(self) -> dict[str, object]:
        return {
            "parameter": _parameter_name_to_ir(self.parameter),
            "value": self.value.to_ir(),
            "priority": int(self.priority),
            "conflict_policy": _normalize_choice(
                self.conflict_policy,
                _REGION_CONFLICT_POLICIES,
                "conflict_policy",
            ),
        }


@dataclass(frozen=True, slots=True)
class RegionTextureOverride:
    initial_magnetization: InitialMagnetization

    def __post_init__(self) -> None:
        if not hasattr(self.initial_magnetization, "to_ir"):
            raise TypeError("region texture override must be an initial magnetization or texture preset")
        if isinstance(self.initial_magnetization, SampledMagnetization):
            raise ValueError(
                "region texture override does not support sampled_field initial magnetization in v1"
            )

    def to_ir(self) -> dict[str, object]:
        return {
            "initial_magnetization": self.initial_magnetization.to_ir(),
        }


@dataclass(frozen=True, slots=True)
class MaterialTransitionSpec:
    kind: str
    cells: int | None = None
    width: float | None = None
    scope: str = "boundary"

    def __post_init__(self) -> None:
        kind = _normalize_choice(self.kind, _MATERIAL_TRANSITION_KINDS, "kind")
        object.__setattr__(self, "kind", kind)
        scope = _normalize_choice(self.scope, _MATERIAL_TRANSITION_SCOPES, "scope")
        object.__setattr__(self, "scope", scope)
        if kind == "mesh_relative":
            if self.cells is None:
                raise ValueError("cells is required for mesh_relative material transition")
            cells = int(self.cells)
            if cells < 1:
                raise ValueError("cells must be >= 1")
            object.__setattr__(self, "cells", cells)
            object.__setattr__(self, "width", None)
        elif kind == "metric":
            if self.width is None:
                raise ValueError("width is required for metric material transition")
            object.__setattr__(self, "width", require_positive(float(self.width), "width"))
            object.__setattr__(self, "cells", None)
        else:
            object.__setattr__(self, "cells", None)
            object.__setattr__(self, "width", None)

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {"kind": self.kind}
        if self.cells is not None:
            payload["cells"] = int(self.cells)
        if self.width is not None:
            payload["width"] = float(self.width)
        if self.kind != "sharp":
            payload["scope"] = self.scope
        return payload


class ObjectRegionMaterialProxy:
    def __init__(self, owner: "ObjectRegion") -> None:
        object.__setattr__(self, "_owner", owner)

    def __setattr__(self, name: str, value: object) -> None:
        self._owner.set_material(name, value)


@dataclass(slots=True)
class ObjectRegion:
    """Authored region owned by one magnetic object."""

    owner_object: str
    name: str
    shape: object
    region_id: str | None = None
    frame: str = "object"
    enabled: bool = True
    priority: int = 0
    realization_policy: str = "inherit"
    mesh_policy: dict[str, object] | None = None
    material_overrides: list[RegionMaterialOverride] | None = None
    material_transition_spec: MaterialTransitionSpec | None = None
    texture_override: RegionTextureOverride | None = None
    _delete_callback: Callable[[], None] | None = field(default=None, repr=False, compare=False)
    material: ObjectRegionMaterialProxy = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self.owner_object = require_non_empty(self.owner_object, "owner_object")
        self.name = require_non_empty(self.name, "name")
        if self.region_id is None:
            self.region_id = f"{self.owner_object}:{self.name}"
        else:
            self.region_id = require_non_empty(self.region_id, "region_id")
        self.frame = _normalize_choice(self.frame, _REGION_FRAMES, "frame")
        self.realization_policy = _normalize_choice(
            self.realization_policy,
            _REGION_REALIZATION_POLICIES,
            "realization_policy",
        )
        if self.material_overrides is None:
            self.material_overrides = []
        self.material = ObjectRegionMaterialProxy(self)

    @property
    def texture(self) -> InitialMagnetization | None:
        if self.texture_override is None:
            return None
        return self.texture_override.initial_magnetization

    @texture.setter
    def texture(self, value: InitialMagnetization | None) -> None:
        if value is None:
            self.texture_override = None
        else:
            self.set_texture(value)

    def set_texture(self, value: InitialMagnetization) -> "ObjectRegion":
        self.texture_override = RegionTextureOverride(value)
        return self

    def set_material(
        self,
        parameter: str,
        value: float | tuple[float, float, float] | MaterialParameterField,
        *,
        unit: str | None = None,
        priority: int | None = None,
        conflict_policy: str = "error",
    ) -> "ObjectRegion":
        field = value if isinstance(value, MaterialParameterField) else MaterialParameterField.constant(value, unit=unit)
        if self.material_transition_spec is None:
            self.material_transition_spec = _default_region_transition_for_parameter(parameter)
        override = RegionMaterialOverride(
            parameter=_normalize_parameter_name(parameter),
            value=field,
            priority=self.priority if priority is None else int(priority),
            conflict_policy=conflict_policy,
        )
        self.material_overrides = [
            existing
            for existing in self.material_overrides or []
            if _normalize_parameter_name(existing.parameter) != override.parameter
        ]
        self.material_overrides.append(override)
        return self

    def set_material_field(
        self,
        parameter: str,
        value: float | tuple[float, float, float] | MaterialParameterField,
        *,
        unit: str | None = None,
        priority: int | None = None,
        conflict_policy: str = "error",
    ) -> "ObjectRegion":
        return self.set_material(
            parameter,
            value,
            unit=unit,
            priority=priority,
            conflict_policy=conflict_policy,
        )

    def material_transition(
        self,
        *,
        cells: int | None = None,
        width: float | None = None,
        kind: str = "mesh_relative",
        scope: str = "boundary",
    ) -> "ObjectRegion":
        self.material_transition_spec = MaterialTransitionSpec(
            kind=kind,
            cells=cells,
            width=width,
            scope=scope,
        )
        return self

    def mesh(
        self,
        *,
        maximum_element_size: float | None = None,
        minimum_element_size: float | None = None,
        transition_distance: float | None = None,
        order: int | None = None,
    ) -> "ObjectRegion":
        mesh_policy: dict[str, object] = {}
        if (
            minimum_element_size is not None
            and maximum_element_size is not None
            and float(minimum_element_size) > float(maximum_element_size)
        ):
            raise ValueError(
                f"{self.owner_object}:{self.name}.mesh: minimum_element_size must be <= maximum_element_size"
            )
        if maximum_element_size is not None:
            mesh_policy["maximum_element_size"] = require_positive(
                float(maximum_element_size),
                "maximum_element_size",
            )
        if minimum_element_size is not None:
            mesh_policy["minimum_element_size"] = require_positive(
                float(minimum_element_size),
                "minimum_element_size",
            )
        if transition_distance is not None:
            require_non_negative(float(transition_distance), "transition_distance")
            mesh_policy["transition_distance"] = float(transition_distance)
        if order is not None:
            if int(order) < 1:
                raise ValueError("order must be >= 1")
            mesh_policy["order"] = int(order)
        self.mesh_policy = mesh_policy or None
        return self

    def delete(self) -> None:
        if self._delete_callback is None:
            raise RuntimeError("region is not attached to an owner registry")
        self._delete_callback()

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "region_id": self.region_id,
            "owner_object": self.owner_object,
            "name": self.name,
            "shape": _region_shape_to_ir(self.shape),
            "frame": self.frame,
            "enabled": bool(self.enabled),
            "priority": int(self.priority),
            "material_overrides": [
                override.to_ir() for override in (self.material_overrides or [])
            ],
            "realization_policy": self.realization_policy,
        }
        if self.mesh_policy is not None:
            payload["mesh_policy"] = dict(self.mesh_policy)
        if self.material_transition_spec is not None:
            payload["material_transition"] = self.material_transition_spec.to_ir()
        if self.texture_override is not None:
            payload["texture_override"] = self.texture_override.to_ir()
        return payload


@dataclass(frozen=True, slots=True)
class MaterialParameterAssignment:
    assignment_id: str
    owner_object: str
    parameter: str
    value: MaterialParameterField
    region_id: str | None = None
    priority: int = 0
    conflict_policy: str = "error"

    def __post_init__(self) -> None:
        _validate_material_parameter_field(
            _normalize_parameter_name(self.parameter),
            self.value,
        )

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "assignment_id": require_non_empty(self.assignment_id, "assignment_id"),
            "owner_object": require_non_empty(self.owner_object, "owner_object"),
            "parameter": _parameter_name_to_ir(self.parameter),
            "value": self.value.to_ir(),
            "priority": int(self.priority),
            "conflict_policy": _normalize_choice(
                self.conflict_policy,
                _REGION_CONFLICT_POLICIES,
                "conflict_policy",
            ),
        }
        if self.region_id is not None:
            payload["region_id"] = require_non_empty(self.region_id, "region_id")
        return payload


def _normalize_choice(value: str, allowed: set[str], name: str) -> str:
    normalized = require_non_empty(str(value), name).strip().lower()
    if normalized not in allowed:
        raise ValueError(f"{name} must be one of {sorted(allowed)!r}, got {value!r}")
    return normalized


def _normalize_parameter_name(value: str) -> str:
    aliases = {
        "a": "Aex",
        "aex": "Aex",
        "alpha": "Alpha",
        "anisotropy_axis": "AnisotropyAxis",
        "anisu": "AnisotropyAxis",
        "dbulk": "Dbulk",
        "dind": "Dind",
        "kc1": "Kc1",
        "kc2": "Kc2",
        "kc3": "Kc3",
        "ku1": "Ku1",
        "ku2": "Ku2",
        "ms": "Ms",
    }
    stripped = require_non_empty(value, "parameter")
    parameter = aliases.get(stripped.lower(), stripped)
    if parameter not in _MATERIAL_PARAMETER_NAMES:
        raise ValueError(
            f"parameter must be one of {sorted(_MATERIAL_PARAMETER_NAMES)!r}, got {value!r}"
        )
    return parameter


def _default_region_transition_for_parameter(parameter: str) -> MaterialTransitionSpec | None:
    if _normalize_parameter_name(parameter) in {"Ms", "Aex"}:
        return MaterialTransitionSpec(kind="mesh_relative", cells=3, scope="boundary")
    return None


def _parameter_name_to_ir(value: str) -> str:
    return {
        "Ms": "ms",
        "Aex": "aex",
        "Alpha": "alpha",
        "Ku1": "ku1",
        "Ku2": "ku2",
        "AnisotropyAxis": "anisotropy_axis",
        "Kc1": "kc1",
        "Kc2": "kc2",
        "Kc3": "kc3",
        "Dind": "dind",
        "Dbulk": "dbulk",
    }[_normalize_parameter_name(value)]


def _validate_material_parameter_field(parameter: str, field_value: MaterialParameterField) -> None:
    payload = field_value.to_ir()
    if payload.get("kind") != "constant":
        return
    value = payload.get("value")
    if not isinstance(value, (int, float)):
        return
    scalar = float(value)
    if parameter == "Ms" and scalar <= 0.0:
        raise ValueError("Ms must be > 0")
    if parameter in {"Aex", "Alpha"} and scalar < 0.0:
        raise ValueError(f"{parameter} must be >= 0")


def _region_shape_to_ir(shape: object) -> dict[str, object]:
    if hasattr(shape, "to_ir"):
        shape_ir = shape.to_ir()
    elif isinstance(shape, dict):
        shape_ir = dict(shape)
    else:
        raise TypeError("region shape must be a Fullmag geometry or shape IR dict")

    kind = shape_ir.get("kind")
    if kind == "translate":
        base = shape_ir.get("base")
        if not isinstance(base, dict):
            raise TypeError("translated region shape base must be a shape IR dict")
        translated = _region_shape_to_ir(base)
        offset = as_vector3(shape_ir.get("by"), "shape.center")
        center = as_vector3(translated.get("center", (0.0, 0.0, 0.0)), "shape.center")
        translated["center"] = [center[index] + offset[index] for index in range(3)]
        return translated
    if kind == "box":
        return {
            "kind": "box",
            "size": list(as_vector3(shape_ir.get("size"), "shape.size")),
            "center": list(as_vector3(shape_ir.get("center", (0.0, 0.0, 0.0)), "shape.center")),
        }
    if kind == "cylinder":
        return {
            "kind": "cylinder",
            "radius": require_positive(float(shape_ir.get("radius")), "shape.radius"),
            "height": require_positive(float(shape_ir.get("height")), "shape.height"),
            "center": list(as_vector3(shape_ir.get("center", (0.0, 0.0, 0.0)), "shape.center")),
            "axis": list(as_vector3(shape_ir.get("axis", (0.0, 0.0, 1.0)), "shape.axis")),
        }
    if kind == "ellipsoid":
        radii = as_vector3(shape_ir.get("radii"), "shape.radii")
        if radii[0] != radii[1] or radii[0] != radii[2]:
            raise ValueError("object region v1 supports spherical ellipsoids only")
        return {
            "kind": "sphere",
            "radius": require_positive(float(radii[0]), "shape.radius"),
            "center": list(as_vector3(shape_ir.get("center", (0.0, 0.0, 0.0)), "shape.center")),
        }
    if kind in {"sphere", "csg"}:
        return shape_ir
    raise ValueError(f"unsupported object region shape kind {kind!r}")


@dataclass(frozen=True, slots=True)
class Ferromagnet:
    name: str
    geometry: Geometry
    material: Material
    region: Region | None = None
    m0: InitialMagnetization | None = None
    mesh: PerObjectMeshRecipe | None = None
    object_regions: tuple[ObjectRegion, ...] = ()
    allocated_region_ids: tuple[str, ...] = ()
    material_parameter_fields: tuple[MaterialParameterAssignment, ...] = ()

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
