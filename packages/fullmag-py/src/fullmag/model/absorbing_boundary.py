from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Sequence

from fullmag._validation import require_non_negative, require_positive


_FACES = ("x+", "x-", "y+", "y-", "z+", "z-")
_PROFILES = ("linear", "quadratic", "smootherstep")
_FRAMES = ("object", "universe")


@dataclass(frozen=True, slots=True)
class AbsorbingBoundaryLayer:
    """Per-object additive Gilbert-damping boundary layer."""

    total_width_m: float
    ramp_width_m: float
    max_damping: float
    faces: tuple[str, ...] = ("x+",)
    profile: str = "smootherstep"
    frame: str = "object"

    def __post_init__(self) -> None:
        total_width = require_positive(self.total_width_m, "total_width")
        ramp_width = require_positive(self.ramp_width_m, "ramp_width")
        if ramp_width > total_width:
            raise ValueError("ramp_width must be less than or equal to total_width")
        max_damping = require_non_negative(self.max_damping, "max_damping")
        faces = tuple(str(face).strip().lower() for face in self.faces)
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
        profile = str(self.profile).strip().lower()
        if profile not in _PROFILES:
            raise ValueError("profile must be 'linear', 'quadratic', or 'smootherstep'")
        frame = str(self.frame).strip().lower()
        if frame not in _FRAMES:
            raise ValueError("frame must be 'object' or 'universe'")
        object.__setattr__(self, "total_width_m", total_width)
        object.__setattr__(self, "ramp_width_m", ramp_width)
        object.__setattr__(self, "max_damping", max_damping)
        object.__setattr__(self, "faces", faces)
        object.__setattr__(self, "profile", profile)
        object.__setattr__(self, "frame", frame)

    def to_ir(self) -> dict[str, object]:
        return {
            "total_width_m": self.total_width_m,
            "ramp_width_m": self.ramp_width_m,
            "max_damping": self.max_damping,
            "faces": list(self.faces),
            "profile": self.profile,
            "frame": self.frame,
        }

    def _profile_value(self, value: float) -> float:
        t = max(0.0, min(1.0, value))
        if self.profile == "linear":
            return t
        if self.profile == "quadratic":
            return t * t
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


__all__ = ["AbsorbingBoundaryLayer"]
