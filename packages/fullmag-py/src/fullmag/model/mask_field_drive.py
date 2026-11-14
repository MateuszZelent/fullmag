"""Mask antennas: hand-written masks for field excitation (ADR 0081).

An antenna is authored with ``study.add_simpleantenna.mask(...)`` and receives
terms with ``antenna.add(mask, time)``. It enters the physics through
``study.stages.add_field_drive(antenna)`` or ``study.field_drives.add(antenna)``.
"""

from __future__ import annotations

from typing import Sequence

from fullmag._validation import as_vector3, require_non_empty
from fullmag.model.antenna import FIELD_TIME_ORIGINS, DriveActivation
from fullmag.model.mask_function import MaskFunction, MaskFunctionError, TimeFunction
from fullmag.model.structure import _region_shape_to_ir

MASK_FIELD_DRIVE_SCHEMA_VERSION = "mask_field_drive.v1"
MAX_MASK_TERMS = 8
MASK_FRAMES = frozenset({"world", "local"})


class MaskAntenna:
    """A target, a support shape and up to eight ``mask * time`` terms."""

    __slots__ = (
        "id",
        "name",
        "target_object_id",
        "shape",
        "position_m",
        "frame",
        "time_origin",
        "activation",
        "enabled",
        "_terms",
        "_frozen",
    )

    def __init__(
        self,
        *,
        id: str,
        target_object_id: str,
        shape: object,
        position: Sequence[float] = (0.0, 0.0, 0.0),
        frame: str = "local",
        time_origin: str = "stage_local",
        activation: DriveActivation | None = None,
        name: str | None = None,
        enabled: bool = True,
    ) -> None:
        self.id = require_non_empty(id, "antenna id")
        self.name = require_non_empty(name if name is not None else id, "antenna name")
        self.target_object_id = require_non_empty(target_object_id, "target")
        self.shape = shape
        _region_shape_to_ir(shape)  # fail early for unsupported shapes
        self.position_m = tuple(float(value) for value in as_vector3(position, "position"))
        normalized_frame = require_non_empty(frame, "frame").lower()
        if normalized_frame not in MASK_FRAMES:
            raise ValueError("frame must be 'world' or 'local'")
        self.frame = normalized_frame
        normalized_origin = require_non_empty(time_origin, "time_origin").lower()
        if normalized_origin not in FIELD_TIME_ORIGINS:
            raise ValueError(f"time_origin must be one of {sorted(FIELD_TIME_ORIGINS)}")
        self.time_origin = normalized_origin
        resolved_activation = activation or DriveActivation.all_time_evolution()
        if not isinstance(resolved_activation, DriveActivation):
            raise TypeError("activation must be a DriveActivation")
        self.activation = resolved_activation
        self.enabled = bool(enabled)
        self._terms: list[tuple[MaskFunction, TimeFunction | None]] = []
        self._frozen = False

    @property
    def terms(self) -> tuple[tuple[MaskFunction, TimeFunction | None], ...]:
        return tuple(self._terms)

    def add(self, mask: MaskFunction, time: TimeFunction | None = None) -> "MaskAntenna":
        """Add one term ``mask(x, y, z) * time(t)``; ``time=None`` is static."""
        if self._frozen:
            raise MaskFunctionError(
                f"antenna {self.id!r} is already added to the study; add all terms "
                "before study.stages.add_field_drive(antenna)"
            )
        if callable(mask) and not isinstance(mask, MaskFunction):
            raise TypeError(
                "wrap the function: antenna.add(fm.mask(f, name=value, ...), "
                "fm.time(g, name=value, ...))"
            )
        if not isinstance(mask, MaskFunction):
            raise TypeError("antenna.add() needs a mask made with fm.mask(...)")
        if time is not None and not isinstance(time, TimeFunction):
            if callable(time):
                raise TypeError("wrap the time function: fm.time(g, name=value, ...)")
            raise TypeError("antenna.add() needs a time function made with fm.time(...)")
        if len(self._terms) >= MAX_MASK_TERMS:
            raise MaskFunctionError(
                f"antenna {self.id!r} already has {MAX_MASK_TERMS} terms (the limit)"
            )
        self._terms.append((mask, time))
        return self

    def _freeze(self) -> None:
        """Called when the antenna is added to the study; terms are final."""
        if not self._terms:
            raise MaskFunctionError(f"antenna {self.id!r} has no terms; call antenna.add(...)")
        self._frozen = True

    def to_ir(self) -> dict[str, object]:
        if not self._terms:
            raise MaskFunctionError(f"antenna {self.id!r} has no terms; call antenna.add(...)")
        terms = []
        for mask, time in self._terms:
            term: dict[str, object] = {"mask": {"kind": "function", "function": mask.to_ir()}}
            if time is not None:
                term["time"] = time.to_ir()
            terms.append(term)
        return {
            "schema_version": MASK_FIELD_DRIVE_SCHEMA_VERSION,
            "id": self.id,
            "name": self.name,
            "enabled": self.enabled,
            "target_object_id": self.target_object_id,
            "shape": _region_shape_to_ir(self.shape),
            "position_m": list(self.position_m),
            "frame": self.frame,
            "terms": terms,
            "time_origin": self.time_origin,
            "activation": self.activation.to_ir(),
        }

    def __repr__(self) -> str:
        return f"MaskAntenna(id={self.id!r}, target={self.target_object_id!r}, terms={len(self._terms)})"


__all__ = ["MASK_FIELD_DRIVE_SCHEMA_VERSION", "MAX_MASK_TERMS", "MaskAntenna"]
