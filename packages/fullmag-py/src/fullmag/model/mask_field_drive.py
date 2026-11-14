"""Mask antennas: hand-written masks for field excitation (ADR 0081).

An antenna is authored with ``study.add_simpleantenna.arbitrary_mask(target, ...)``,
``magnet.add_simpleantenna.arbitrary_mask(...)`` or
``region.add_simpleantenna.arbitrary_mask(...)`` and receives terms with
``antenna.add(mask, time)``. It enters the physics through
``study.stages.add_field_drive(antenna)`` or ``study.field_drives.add(antenna)``;
``study.stages.update_field_drive(...)`` changes parameter values of the active
instance for the following stages.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Mapping, Sequence

from fullmag._validation import as_vector3, require_non_empty
from fullmag.model.antenna import FIELD_TIME_ORIGINS, DriveActivation, FieldTarget
from fullmag.model.mask_function import MaskFunction, MaskFunctionError, TimeFunction
from fullmag.model.structure import _region_shape_to_ir
from fullmag.model.vector_mask import VectorMask

MASK_FIELD_DRIVE_SCHEMA_VERSION = "mask_field_drive.v1"
MAX_MASK_TERMS = 8
MASK_FRAMES = frozenset({"world", "local"})
_TERM_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")


@dataclass(frozen=True, slots=True)
class MaskTerm:
    """One term ``mask(x, y, z) * time(t)``; ``time=None`` is static."""

    mask: MaskFunction | VectorMask
    time: TimeFunction | None = None
    name: str | None = None

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {}
        if self.name is not None:
            payload["name"] = self.name
        if isinstance(self.mask, VectorMask):
            payload["mask"] = self.mask.to_ir()
        else:
            payload["mask"] = {"kind": "function", "function": self.mask.to_ir()}
        if self.time is not None:
            payload["time"] = self.time.to_ir()
        return payload


class MaskAntenna:
    """A target, a support shape and up to eight ``mask * time`` terms."""

    __slots__ = (
        "id",
        "name",
        "target",
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
        target: FieldTarget,
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
        if not isinstance(target, FieldTarget):
            raise TypeError("target must be a FieldTarget")
        self.target = target
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
        self._terms: list[MaskTerm] = []
        self._frozen = False

    @property
    def terms(self) -> tuple[MaskTerm, ...]:
        return tuple(self._terms)

    def add(
        self,
        mask: MaskFunction | VectorMask,
        time: TimeFunction | None = None,
        *,
        name: str | None = None,
    ) -> "MaskAntenna":
        """Add one term ``mask(x, y, z) * time(t)``; ``time=None`` is static.

        ``name`` identifies the term in ``study.stages.update_field_drive(...,
        term=name)``; names are unique within the antenna.
        """
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
        if not isinstance(mask, (MaskFunction, VectorMask)):
            raise TypeError(
                "antenna.add() needs a mask made with fm.mask(...) or a vector mask "
                "from study.new_vector_mask()"
            )
        if time is not None and not isinstance(time, TimeFunction):
            if callable(time):
                raise TypeError("wrap the time function: fm.time(g, name=value, ...)")
            raise TypeError("antenna.add() needs a time function made with fm.time(...)")
        if name is not None:
            if not isinstance(name, str) or _TERM_NAME.fullmatch(name) is None:
                raise ValueError(
                    f"term name {name!r} must be a name of letters, digits and '_' "
                    "(at most 64 characters, not starting with a digit)"
                )
            if any(term.name == name for term in self._terms):
                raise ValueError(f"antenna {self.id!r} already has a term named {name!r}")
        if len(self._terms) >= MAX_MASK_TERMS:
            raise MaskFunctionError(
                f"antenna {self.id!r} already has {MAX_MASK_TERMS} terms (the limit)"
            )
        self._terms.append(MaskTerm(mask, time, name))
        return self

    def _freeze(self) -> None:
        """Called when the antenna is added to the study; terms are final."""
        if not self._terms:
            raise MaskFunctionError(f"antenna {self.id!r} has no terms; call antenna.add(...)")
        self._frozen = True

    def term_index(self, term: str | int | None) -> int:
        """Index of the term selected by name or index; ``None`` for one term."""
        if term is None:
            if len(self._terms) != 1:
                raise ValueError(
                    f"mask_update_invalid: antenna {self.id!r} has {len(self._terms)} terms; "
                    "select one with term=<name or index>"
                )
            return 0
        if isinstance(term, bool) or not isinstance(term, (str, int)):
            raise TypeError("term must be a term name or an index")
        if isinstance(term, int):
            if not 0 <= term < len(self._terms):
                raise ValueError(
                    f"mask_update_invalid: antenna {self.id!r} has no term {term} "
                    f"(terms 0..{len(self._terms) - 1})"
                )
            return term
        for index, existing in enumerate(self._terms):
            if existing.name == term:
                return index
        raise ValueError(f"mask_update_invalid: antenna {self.id!r} has no term named {term!r}")

    def with_parameters(
        self,
        *,
        term: str | int | None = None,
        mask_parameters: Mapping[str, float] | None = None,
        time_parameters: Mapping[str, float] | None = None,
    ) -> "MaskAntenna":
        """A frozen copy with new parameter values of one term (an Update).

        This antenna is not changed; names not given keep their values.
        """
        mask_parameters = dict(mask_parameters or {})
        time_parameters = dict(time_parameters or {})
        if not mask_parameters and not time_parameters:
            raise ValueError(
                "mask_update_invalid: give mask_parameters and/or time_parameters"
            )
        index = self.term_index(term)
        selected = self._terms[index]
        mask = selected.mask
        time = selected.time
        try:
            if mask_parameters and isinstance(mask, VectorMask):
                raise MaskFunctionError(
                    f"term {index} of antenna {self.id!r} is an array mask without parameters"
                )
            for parameter, value in mask_parameters.items():
                mask = mask.with_parameter(parameter, value)
            if time_parameters and time is None:
                raise MaskFunctionError(
                    f"term {index} of antenna {self.id!r} is static and has no time function"
                )
            for parameter, value in time_parameters.items():
                time = time.with_parameter(parameter, value)
        except MaskFunctionError as error:
            raise ValueError(f"mask_update_invalid: antenna {self.id!r}: {error}") from None
        copy = MaskAntenna(
            id=self.id,
            target=self.target,
            shape=self.shape,
            position=self.position_m,
            frame=self.frame,
            time_origin=self.time_origin,
            activation=self.activation,
            name=self.name,
            enabled=self.enabled,
        )
        copy._terms = list(self._terms)
        copy._terms[index] = MaskTerm(mask, time, selected.name)
        copy._frozen = True
        return copy

    def to_ir(self) -> dict[str, object]:
        if not self._terms:
            raise MaskFunctionError(f"antenna {self.id!r} has no terms; call antenna.add(...)")
        return {
            "schema_version": MASK_FIELD_DRIVE_SCHEMA_VERSION,
            "id": self.id,
            "name": self.name,
            "enabled": self.enabled,
            "target": self.target.to_ir(),
            "shape": _region_shape_to_ir(self.shape),
            "position_m": list(self.position_m),
            "frame": self.frame,
            "terms": [term.to_ir() for term in self._terms],
            "time_origin": self.time_origin,
            "activation": self.activation.to_ir(),
        }

    def __repr__(self) -> str:
        return (
            f"MaskAntenna(id={self.id!r}, target={self.target.to_ir()!r}, "
            f"terms={len(self._terms)})"
        )


__all__ = ["MASK_FIELD_DRIVE_SCHEMA_VERSION", "MAX_MASK_TERMS", "MaskAntenna", "MaskTerm"]
