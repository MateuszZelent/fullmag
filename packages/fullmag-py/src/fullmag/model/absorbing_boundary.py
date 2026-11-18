from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
import math
from numbers import Real

from fullmag._validation import require_non_negative, require_positive
from fullmag.model._absorbing_boundary_expression import compile_distance_expression, compile_expression


_FACES = ("x+", "x-", "y+", "y-", "z+", "z-")
_PROFILES = ("linear", "quadratic", "smootherstep", "logarithmic", "tanh", "custom")
_FRAMES = ("object", "universe")


def _faces(raw: Sequence[str]) -> tuple[str, ...]:
    faces = tuple(str(face).strip().lower() for face in raw)
    if not faces:
        raise ValueError("faces must contain at least one face")
    unknown = sorted(set(faces).difference(_FACES))
    if unknown:
        raise ValueError(
            "faces must use only x+, x-, y+, y-, z+, or z-; "
            f"unknown: {', '.join(unknown)}"
        )
    if len(set(faces)) != len(faces):
        raise ValueError("faces must not contain duplicates")
    return faces


class _DampingRamp:
    __slots__ = ()
    total_width_m: float
    ramp_width_m: float
    max_damping: float
    profile: str
    frame: str
    expression: str | None

    def _validate_ramp(self) -> None:
        total_width = require_positive(self.total_width_m, "total_width")
        ramp_width = require_positive(self.ramp_width_m, "ramp_width")
        if ramp_width > total_width:
            raise ValueError("ramp_width must be less than or equal to total_width")
        max_damping = require_non_negative(self.max_damping, "max_damping")
        profile = str(self.profile).strip().lower()
        if profile not in _PROFILES:
            raise ValueError(f"profile must be one of: {', '.join(_PROFILES)}")
        expression = self.expression
        if profile == "custom":
            if not isinstance(expression, str) or not expression.strip():
                raise ValueError("expression is required for a custom absorbing boundary profile")
            compile_expression(expression)
        elif expression is not None:
            raise ValueError("expression requires a custom absorbing boundary profile")
        frame = str(self.frame).strip().lower()
        if frame not in _FRAMES:
            raise ValueError("frame must be 'object' or 'universe'")
        object.__setattr__(self, "total_width_m", total_width)
        object.__setattr__(self, "ramp_width_m", ramp_width)
        object.__setattr__(self, "max_damping", max_damping)
        object.__setattr__(self, "profile", profile)
        object.__setattr__(self, "frame", frame)


@dataclass(frozen=True, slots=True)
class AbsorbingBoundaryLayer(_DampingRamp):
    """Per-object additive Gilbert-damping boundary layer."""

    total_width_m: float
    ramp_width_m: float
    max_damping: float
    faces: tuple[str, ...] = ("x+",)
    profile: str = "smootherstep"
    frame: str = "object"
    expression: str | None = None

    def __post_init__(self) -> None:
        self._validate_ramp()
        object.__setattr__(self, "faces", _faces(self.faces))

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "total_width_m": self.total_width_m,
            "ramp_width_m": self.ramp_width_m,
            "max_damping": self.max_damping,
            "faces": list(self.faces),
            "profile": self.profile,
            "frame": self.frame,
        }
        if self.expression is not None:
            payload["expression"] = self.expression
        return payload

    def _profile_value(self, value: float) -> float:
        t = max(0.0, min(1.0, value))
        if t in (0.0, 1.0):
            return t
        if self.profile == "linear":
            return t
        if self.profile == "quadratic":
            return t * t
        if self.profile == "logarithmic":
            return math.log1p(9 * t) / math.log(10)
        if self.profile == "tanh":
            return (1 + math.tanh(4 * t - 2) / math.tanh(2)) / 2
        if self.expression is not None:
            return compile_expression(self.expression)(t)
        return t * t * t * (t * (t * 6.0 - 15.0) + 10.0)

    def contribution(self, point: Sequence[float], bounds: Sequence[float]) -> float:
        """Return additive damping at a point for ``bounds=(xmin,...,zmax)``."""
        if len(point) != 3 or len(bounds) != 6:
            raise ValueError("point must contain 3 values and bounds must contain 6 values")
        coordinates = tuple(float(value) for value in point)
        limits = tuple(float(value) for value in bounds)
        if not all(math.isfinite(value) for value in (*coordinates, *limits)):
            raise ValueError("point and bounds must be finite")
        axis_bounds = ((limits[0], limits[3]), (limits[1], limits[4]), (limits[2], limits[5]))
        weight = 0.0
        for face in self.faces:
            axis = "xyz".index(face[0])
            lower, upper = axis_bounds[axis]
            distance = coordinates[axis] - lower if face[1] == "-" else upper - coordinates[axis]
            if distance < 0.0 or distance > self.total_width_m:
                continue
            ramp_start = self.total_width_m - self.ramp_width_m
            taper = (self.total_width_m - distance) / self.ramp_width_m
            if distance >= self.total_width_m:
                taper = 0.0
            elif distance <= ramp_start:
                taper = 1.0
            weight = max(weight, self._profile_value(taper))
        return self.max_damping * weight


_GEOMETRY_FIELDS = {
    "faces": ("faces",),
    "plane": ("origin", "normal"),
    "cylinder": ("center", "axis", "radius_m", "direction"),
    "sphere": ("center", "radius_m", "direction"),
    "region_boundary": ("region_id",),
    "expression": ("expression",),
}


def _identifier(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a nonempty string")
    return value


def _finite_real(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(value):
        raise ValueError(f"{field} must be a finite number")
    return float(value)


def _geometry_parameter(key: str, value: object) -> object:
    if key == "faces":
        if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
            raise ValueError("faces must be an array")
        return _faces(value)
    if key in ("center", "origin", "axis", "normal"):
        if not isinstance(value, Sequence) or isinstance(value, (str, bytes)) or len(value) != 3:
            raise ValueError(f"{key} must have three components")
        vector = tuple(_finite_real(component, key) for component in value)
        if key in ("axis", "normal") and not any(vector):
            raise ValueError(f"{key} must be nonzero")
        return vector
    if key == "radius_m":
        return require_positive(_finite_real(value, key), key)
    if key == "direction":
        if value not in ("outward", "inward"):
            raise ValueError("direction must be outward or inward")
        return value
    if key == "region_id":
        return _identifier(value, key)
    if not isinstance(value, str):
        raise ValueError("distance expression must be a string")
    compile_distance_expression(value)
    return value


@dataclass(frozen=True, slots=True, init=False)
class AbsorbingGeometry:
    """Distance coordinate of an absorbing layer. All lengths are in metres."""

    kind: str
    _parameters: tuple[tuple[str, object], ...]

    def __init__(self, kind: str, **parameters: object) -> None:
        fields = _GEOMETRY_FIELDS.get(kind)
        if fields is None:
            raise ValueError(f"unknown absorbing geometry kind {kind!r}")
        if set(parameters) != set(fields):
            raise ValueError(f"{kind} geometry requires exactly {', '.join(fields)}")
        object.__setattr__(self, "kind", kind)
        object.__setattr__(self, "_parameters", tuple(
            (key, _geometry_parameter(key, parameters[key])) for key in fields
        ))

    @classmethod
    def faces(cls, faces: Sequence[str]) -> AbsorbingGeometry:
        return cls("faces", faces=faces)

    @classmethod
    def plane(cls, origin: Sequence[float], normal: Sequence[float]) -> AbsorbingGeometry:
        return cls("plane", origin=origin, normal=normal)

    @classmethod
    def cylinder(cls, center: Sequence[float], axis: Sequence[float], radius_m: float,
                 direction: str = "outward") -> AbsorbingGeometry:
        return cls("cylinder", center=center, axis=axis, radius_m=radius_m, direction=direction)

    @classmethod
    def sphere(cls, center: Sequence[float], radius_m: float, direction: str = "outward") -> AbsorbingGeometry:
        return cls("sphere", center=center, radius_m=radius_m, direction=direction)

    @classmethod
    def region_boundary(cls, region_id: str) -> AbsorbingGeometry:
        return cls("region_boundary", region_id=region_id)

    @classmethod
    def expression(cls, expression: str) -> AbsorbingGeometry:
        return cls("expression", expression=expression)

    def to_ir(self) -> dict[str, object]:
        return {"kind": self.kind, **{
            key: list(value) if isinstance(value, tuple) else value for key, value in self._parameters
        }}


@dataclass(frozen=True, slots=True, kw_only=True)
class SpatialAbsorbingLayer(_DampingRamp):
    """Named additive damping layer, optionally clipped to an object's region."""

    layer_id: str
    name: str
    geometry: AbsorbingGeometry
    total_width_m: float
    ramp_width_m: float
    max_damping: float
    region_id: str | None = None
    enabled: bool = True
    profile: str = "smootherstep"
    expression: str | None = None
    frame: str = "object"

    def __post_init__(self) -> None:
        _identifier(self.layer_id, "layer_id")
        if not isinstance(self.name, str) or not self.name.strip():
            raise ValueError("layer name must be a nonempty string")
        if not isinstance(self.enabled, bool):
            raise ValueError("enabled must be a boolean")
        if self.region_id is not None:
            _identifier(self.region_id, "region_id")
        if not isinstance(self.geometry, AbsorbingGeometry):
            raise TypeError("geometry must be an AbsorbingGeometry")
        for key in ("total_width_m", "ramp_width_m", "max_damping"):
            _finite_real(getattr(self, key), key)
        self._validate_ramp()
        shape = self.geometry.to_ir()
        if shape.get("direction") == "outward" and self.total_width_m > shape["radius_m"]:
            raise ValueError("total_width_m must not exceed radius_m for an outward band")

    def referenced_regions(self) -> tuple[str, ...]:
        refs = () if self.region_id is None else (self.region_id,)
        if self.geometry.kind == "region_boundary":
            refs += (self.geometry.to_ir()["region_id"],)
        return refs

    def to_ir(self) -> dict[str, object]:
        wire = {
            "layer_id": self.layer_id, "name": self.name, "enabled": self.enabled,
            "frame": self.frame, "total_width_m": self.total_width_m, "ramp_width_m": self.ramp_width_m,
            "max_damping": self.max_damping, "profile": self.profile, "geometry": self.geometry.to_ir(),
        }
        if self.expression is not None:
            wire["expression"] = self.expression
        if self.region_id is not None:
            wire["region_id"] = self.region_id
        return wire

    @classmethod
    def from_ir(cls, raw: Mapping[str, object]) -> SpatialAbsorbingLayer:
        if not isinstance(raw, Mapping) or not isinstance(raw.get("geometry"), Mapping):
            raise ValueError("each layer requires a geometry object")
        missing = {"enabled", "frame", "profile"}.difference(raw)
        if missing:
            raise ValueError(f"missing spatial layer fields: {', '.join(sorted(missing))}")
        return cls(**{**raw, "geometry": AbsorbingGeometry(**raw["geometry"])})


@dataclass(frozen=True, slots=True)
class AbsorbingBoundaryLayers:
    layers: tuple[SpatialAbsorbingLayer, ...]

    def __post_init__(self) -> None:
        layers = tuple(self.layers)
        if not all(isinstance(layer, SpatialAbsorbingLayer) for layer in layers):
            raise TypeError("layers must contain SpatialAbsorbingLayer instances")
        if len({layer.layer_id for layer in layers}) != len(layers):
            raise ValueError("absorbing layer IDs must be unique within an object")
        object.__setattr__(self, "layers", layers)

    def validate_regions(self, region_ids: set[str]) -> None:
        for layer in self.layers:
            for region_id in layer.referenced_regions():
                if region_id not in region_ids:
                    raise ValueError(f"absorbing layer {layer.layer_id!r} references unknown region {region_id!r}")

    def to_ir(self) -> dict[str, object]:
        return {"layers": [layer.to_ir() for layer in self.layers]}


__all__ = ["AbsorbingBoundaryLayer", "AbsorbingGeometry", "SpatialAbsorbingLayer"]
