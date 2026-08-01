from __future__ import annotations

import math
import re
import uuid
from dataclasses import dataclass, field
from typing import Literal, Sequence, TypeAlias

from fullmag._validation import require_finite, require_non_empty

Vector3: TypeAlias = tuple[float, float, float]
PlanarReduction: TypeAlias = Literal[
    "mean_occupied",
    "thickness_integral",
    "rms",
    "min",
    "max",
    "abs_max",
]
EmptyPolicy: TypeAlias = Literal["exclude_empty", "include_air_as_zero"]
SurfaceVisibilityPolicy: TypeAlias = Literal[
    "frontmost",
    "backmost",
    "nearest_to_origin",
    "area_weighted_overlap",
]

_REDUCTIONS = {
    "mean_occupied",
    "thickness_integral",
    "rms",
    "min",
    "max",
    "abs_max",
}
_EMPTY_POLICIES = {"exclude_empty", "include_air_as_zero"}
_VISIBILITY_POLICIES = {
    "frontmost",
    "backmost",
    "nearest_to_origin",
    "area_weighted_overlap",
}
_NORMALIZATION_VERSION = "planar_frame_v1"


def _choice(value: str, allowed: set[str], name: str) -> str:
    normalized = require_non_empty(value, name).strip().lower()
    if normalized not in allowed:
        choices = ", ".join(sorted(allowed))
        raise ValueError(f"{name} must be one of: {choices}")
    return normalized


def _vector3(value: Sequence[float], name: str) -> Vector3:
    if len(value) != 3:
        raise ValueError(f"{name} must contain exactly 3 values")
    result = tuple(require_finite(float(component), f"{name}[{index}]") for index, component in enumerate(value))
    return result[0], result[1], result[2]


def _dot(a: Vector3, b: Vector3) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a: Vector3, b: Vector3) -> Vector3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _normalize(value: Vector3, name: str) -> Vector3:
    norm = math.sqrt(_dot(value, value))
    if not math.isfinite(norm) or norm <= 1e-15:
        raise ValueError(f"{name} must be finite and non-zero")
    if abs(norm - 1.0) <= 1e-15:
        return value
    return value[0] / norm, value[1] / norm, value[2] / norm


def _monitor_id(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    prefix = slug or "planar-monitor"
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


@dataclass(frozen=True, slots=True)
class MonitorTarget:
    kind: Literal["magnetic_domain", "domain", "object", "region"]
    object_id: str | None = None
    region_id: str | None = None

    @staticmethod
    def magnetic_domain() -> "MonitorTarget":
        return MonitorTarget("magnetic_domain")

    @staticmethod
    def domain() -> "MonitorTarget":
        return MonitorTarget("domain")

    @staticmethod
    def object(object_id: str) -> "MonitorTarget":
        return MonitorTarget(
            "object",
            object_id=require_non_empty(object_id, "object_id"),
        )

    @staticmethod
    def region(object_id: str, region_id: str) -> "MonitorTarget":
        return MonitorTarget(
            "region",
            object_id=require_non_empty(object_id, "object_id"),
            region_id=require_non_empty(region_id, "region_id"),
        )

    def __post_init__(self) -> None:
        if self.kind not in {"magnetic_domain", "domain", "object", "region"}:
            raise ValueError("MonitorTarget.kind must describe a physical target")
        if self.kind in {"object", "region"} and self.object_id is None:
            raise ValueError(f"{self.kind} target requires object_id")
        if self.kind == "region" and self.region_id is None:
            raise ValueError("region target requires region_id")
        if self.kind in {"magnetic_domain", "domain"} and (
            self.object_id is not None or self.region_id is not None
        ):
            raise ValueError(f"{self.kind} target must not define object_id or region_id")

    def to_ir(self) -> dict[str, object]:
        result: dict[str, object] = {"kind": self.kind}
        if self.object_id is not None:
            result["object_id"] = self.object_id
        if self.region_id is not None:
            result["region_id"] = self.region_id
        return result


@dataclass(frozen=True, slots=True)
class PlanarExtent:
    kind: Literal["explicit", "target_bounds", "magnetic_domain", "universe"]
    u: tuple[float, float] | None = None
    v: tuple[float, float] | None = None
    padding_m: float = 0.0

    @staticmethod
    def explicit(
        *,
        u: Sequence[float],
        v: Sequence[float],
    ) -> "PlanarExtent":
        if len(u) != 2 or len(v) != 2:
            raise ValueError("explicit extent u and v must each contain two values")
        return PlanarExtent(
            "explicit",
            u=(float(u[0]), float(u[1])),
            v=(float(v[0]), float(v[1])),
        )

    @staticmethod
    def target_bounds(*, padding: float = 0.0) -> "PlanarExtent":
        return PlanarExtent("target_bounds", padding_m=padding)

    @staticmethod
    def magnetic_domain(*, padding: float = 0.0) -> "PlanarExtent":
        return PlanarExtent("magnetic_domain", padding_m=padding)

    @staticmethod
    def universe(*, padding: float = 0.0) -> "PlanarExtent":
        return PlanarExtent("universe", padding_m=padding)

    def __post_init__(self) -> None:
        padding = require_finite(self.padding_m, "padding_m")
        if padding < 0.0:
            raise ValueError("padding_m must be >= 0")
        object.__setattr__(self, "padding_m", padding)
        if self.kind == "explicit":
            if self.u is None or self.v is None:
                raise ValueError("explicit extent requires u and v bounds")
            u_min, u_max = (
                require_finite(self.u[0], "u_min_m"),
                require_finite(self.u[1], "u_max_m"),
            )
            v_min, v_max = (
                require_finite(self.v[0], "v_min_m"),
                require_finite(self.v[1], "v_max_m"),
            )
            if u_min >= u_max:
                raise ValueError("explicit extent requires u_min_m < u_max_m")
            if v_min >= v_max:
                raise ValueError("explicit extent requires v_min_m < v_max_m")
            object.__setattr__(self, "u", (u_min, u_max))
            object.__setattr__(self, "v", (v_min, v_max))
        elif self.kind not in {"target_bounds", "magnetic_domain", "universe"}:
            raise ValueError("unsupported PlanarExtent.kind")
        elif self.u is not None or self.v is not None:
            raise ValueError(f"{self.kind} extent must not define explicit bounds")

    def to_ir(self) -> dict[str, object]:
        if self.kind == "explicit":
            assert self.u is not None and self.v is not None
            return {
                "kind": "explicit",
                "u_min_m": self.u[0],
                "u_max_m": self.u[1],
                "v_min_m": self.v[0],
                "v_max_m": self.v[1],
            }
        return {"kind": self.kind, "padding_m": self.padding_m}


@dataclass(frozen=True, slots=True)
class PlanarFrame:
    origin: Vector3
    normal: Vector3
    u_axis: Vector3
    extent: PlanarExtent
    preset: Literal["xy", "xz", "yz"] | None = None
    _v_axis: Vector3 = field(init=False, repr=False)

    def __post_init__(self) -> None:
        origin = _vector3(self.origin, "origin")
        normal = _normalize(_vector3(self.normal, "normal"), "normal")
        candidate_u = _vector3(self.u_axis, "u_axis")
        projection = _dot(candidate_u, normal)
        orthogonal_u = (
            candidate_u[0] - projection * normal[0],
            candidate_u[1] - projection * normal[1],
            candidate_u[2] - projection * normal[2],
        )
        if _dot(orthogonal_u, orthogonal_u) <= 1e-30:
            raise ValueError("normal and u_axis must not be collinear")
        u_axis = _normalize(orthogonal_u, "u_axis")
        v_axis = _normalize(_cross(normal, u_axis), "v_axis")
        if self.preset not in {None, "xy", "xz", "yz"}:
            raise ValueError("preset must be xy, xz, yz, or None")
        object.__setattr__(self, "origin", origin)
        object.__setattr__(self, "normal", normal)
        object.__setattr__(self, "u_axis", u_axis)
        object.__setattr__(self, "_v_axis", v_axis)

    @staticmethod
    def xy(*, position: float, extent: PlanarExtent) -> "PlanarFrame":
        return PlanarFrame(
            origin=(0.0, 0.0, require_finite(position, "position")),
            normal=(0.0, 0.0, 1.0),
            u_axis=(1.0, 0.0, 0.0),
            extent=extent,
            preset="xy",
        )

    @staticmethod
    def xz(*, position: float, extent: PlanarExtent) -> "PlanarFrame":
        return PlanarFrame(
            origin=(0.0, require_finite(position, "position"), 0.0),
            normal=(0.0, -1.0, 0.0),
            u_axis=(1.0, 0.0, 0.0),
            extent=extent,
            preset="xz",
        )

    @staticmethod
    def yz(*, position: float, extent: PlanarExtent) -> "PlanarFrame":
        return PlanarFrame(
            origin=(require_finite(position, "position"), 0.0, 0.0),
            normal=(1.0, 0.0, 0.0),
            u_axis=(0.0, 1.0, 0.0),
            extent=extent,
            preset="yz",
        )

    def to_ir(self) -> dict[str, object]:
        return {
            "origin_m": list(self.origin),
            "u_axis": list(self.u_axis),
            "v_axis": list(self._v_axis),
            "normal": list(self.normal),
            "preset": self.preset,
            "normalization_version": _NORMALIZATION_VERSION,
            "extent": self.extent.to_ir(),
        }


@dataclass(frozen=True, slots=True)
class PlaneSample:
    def to_ir(self) -> dict[str, object]:
        return {"kind": "plane_sample"}


@dataclass(frozen=True, slots=True)
class SlabAverage:
    thickness: float

    def __post_init__(self) -> None:
        thickness = float(self.thickness)
        if not math.isfinite(thickness) or thickness <= 0.0:
            raise ValueError("thickness must be finite and > 0")
        object.__setattr__(self, "thickness", thickness)

    def to_ir(self) -> dict[str, object]:
        return {"kind": "slab_average", "thickness_m": self.thickness}


@dataclass(frozen=True, slots=True)
class DepthProjection:
    reduction: PlanarReduction = "mean_occupied"
    empty_policy: EmptyPolicy = "exclude_empty"

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "reduction",
            _choice(self.reduction, _REDUCTIONS, "reduction"),
        )
        object.__setattr__(
            self,
            "empty_policy",
            _choice(self.empty_policy, _EMPTY_POLICIES, "empty_policy"),
        )

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "depth_projection",
            "reduction": self.reduction,
            "empty_policy": self.empty_policy,
        }


@dataclass(frozen=True, slots=True)
class SurfaceBoundary:
    kind: Literal["object_boundary", "region_boundary", "named_surface"]
    region_id: str | None = None
    surface_id: str | None = None

    @staticmethod
    def object_boundary() -> "SurfaceBoundary":
        return SurfaceBoundary("object_boundary")

    @staticmethod
    def region_boundary(region_id: str) -> "SurfaceBoundary":
        return SurfaceBoundary(
            "region_boundary",
            region_id=require_non_empty(region_id, "region_id"),
        )

    @staticmethod
    def named(surface_id: str) -> "SurfaceBoundary":
        return SurfaceBoundary(
            "named_surface",
            surface_id=require_non_empty(surface_id, "surface_id"),
        )

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {"kind": self.kind}
        if self.region_id is not None:
            payload["region_id"] = self.region_id
        if self.surface_id is not None:
            payload["surface_id"] = self.surface_id
        return payload


@dataclass(frozen=True, slots=True)
class SurfaceProjection:
    boundary: SurfaceBoundary
    visibility_policy: SurfaceVisibilityPolicy = "frontmost"

    def __post_init__(self) -> None:
        if not isinstance(self.boundary, SurfaceBoundary):
            raise TypeError("boundary must be SurfaceBoundary")
        object.__setattr__(
            self,
            "visibility_policy",
            _choice(
                self.visibility_policy,
                _VISIBILITY_POLICIES,
                "visibility_policy",
            ),
        )

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "surface_projection",
            "boundary": self.boundary.to_ir(),
            "visibility_policy": self.visibility_policy,
        }


PlanarOperator: TypeAlias = (
    PlaneSample | SlabAverage | DepthProjection | SurfaceProjection
)


@dataclass(frozen=True, slots=True)
class PlanarMonitor:
    name: str
    target: MonitorTarget
    frame: PlanarFrame
    operator: PlanarOperator
    monitor_id: str | None = None

    def __post_init__(self) -> None:
        name = require_non_empty(self.name, "name")
        monitor_id = (
            _monitor_id(name)
            if self.monitor_id is None
            else require_non_empty(self.monitor_id, "monitor_id")
        )
        if not isinstance(self.target, MonitorTarget):
            raise TypeError("target must be MonitorTarget")
        if not isinstance(self.frame, PlanarFrame):
            raise TypeError("frame must be PlanarFrame")
        if not isinstance(
            self.operator,
            (PlaneSample, SlabAverage, DepthProjection, SurfaceProjection),
        ):
            raise TypeError("operator must be a planar operator")
        object.__setattr__(self, "name", name)
        object.__setattr__(self, "monitor_id", monitor_id)

    @property
    def id(self) -> str:
        assert self.monitor_id is not None
        return self.monitor_id

    def to_ir(self) -> dict[str, object]:
        return {
            "id": self.id,
            "name": self.name,
            "target": self.target.to_ir(),
            "frame": self.frame.to_ir(),
            "operator": self.operator.to_ir(),
        }


class StudyMonitorRegistry:
    def __init__(self, storage: list[PlanarMonitor] | None = None) -> None:
        self._storage = storage if storage is not None else []

    def add_planar(
        self,
        *,
        name: str,
        target: MonitorTarget,
        frame: PlanarFrame,
        operator: PlanarOperator,
        monitor_id: str | None = None,
    ) -> PlanarMonitor:
        normalized_name = require_non_empty(name, "name")
        if any(item.name == normalized_name for item in self._storage):
            raise ValueError(f"duplicate planar monitor name {normalized_name!r}")
        monitor = PlanarMonitor(
            name=normalized_name,
            target=target,
            frame=frame,
            operator=operator,
            monitor_id=monitor_id,
        )
        if any(item.id == monitor.id for item in self._storage):
            raise ValueError(f"duplicate planar monitor id {monitor.id!r}")
        self._storage.append(monitor)
        return monitor

    def items(self) -> tuple[PlanarMonitor, ...]:
        return tuple(self._storage)


__all__ = [
    "DepthProjection",
    "MonitorTarget",
    "PlanarExtent",
    "PlanarFrame",
    "PlanarMonitor",
    "PlanarOperator",
    "PlaneSample",
    "SlabAverage",
    "StudyMonitorRegistry",
    "SurfaceBoundary",
    "SurfaceProjection",
]
