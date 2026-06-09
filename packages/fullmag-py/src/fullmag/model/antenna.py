from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from fullmag._validation import (
    as_vector3,
    require_finite,
    require_non_empty,
    require_non_negative,
    require_positive,
)
from fullmag.model.energy import Sinusoidal, TimeDependence

# FEM-034 / FEM-035: extensible allow-lists for solver and current_distribution.
# Add new entries here when additional backends or distributions are implemented.
ANTENNA_SOLVERS = {"mqs_2p5d_az"}
ANTENNA_FIELD_SOURCE_MODELS = {"mqs_2p5d_az", "prescribed_zeeman_mask"}
CURRENT_DISTRIBUTIONS = {"uniform"}


def _drive_waveform_ir(
    *,
    frequency_hz: float | None,
    phase_rad: float,
    waveform: TimeDependence | None,
) -> dict[str, object] | None:
    if waveform is not None:
        return waveform.to_ir()
    if frequency_hz is None:
        return None
    return Sinusoidal(frequency_hz=frequency_hz, phase_rad=phase_rad).to_ir()


@dataclass(frozen=True, slots=True)
class RfDrive:
    current_a: float
    frequency_hz: float | None = None
    phase_rad: float = 0.0
    waveform: TimeDependence | None = None

    def __post_init__(self) -> None:
        if self.frequency_hz is not None:
            require_positive(self.frequency_hz, "frequency_hz")
        if self.waveform is not None and not hasattr(self.waveform, "to_ir"):
            raise TypeError(
                "waveform must be a Fullmag time-dependence object such as "
                "Sinusoidal(...) or Pulse(...)"
            )

    def to_ir(self) -> dict[str, object]:
        ir = {"current_a": float(self.current_a)}
        waveform_ir = _drive_waveform_ir(
            frequency_hz=self.frequency_hz,
            phase_rad=self.phase_rad,
            waveform=self.waveform,
        )
        if waveform_ir is not None:
            ir["waveform"] = waveform_ir
        return ir


@dataclass(frozen=True, slots=True)
class MicrostripAntenna:
    width: float
    thickness: float
    height_above_magnet: float
    preview_length: float
    center_x: float = 0.0
    center_y: float = 0.0
    current_distribution: str = "uniform"

    def __post_init__(self) -> None:
        require_positive(self.width, "width")
        require_positive(self.thickness, "thickness")
        require_non_negative(self.height_above_magnet, "height_above_magnet")
        require_positive(self.preview_length, "preview_length")
        object.__setattr__(
            self,
            "current_distribution",
            require_non_empty(self.current_distribution, "current_distribution").lower(),
        )
        if self.current_distribution not in CURRENT_DISTRIBUTIONS:
            raise ValueError(
                f"current_distribution must be one of {sorted(CURRENT_DISTRIBUTIONS)}, "
                f"got {self.current_distribution!r}"
            )

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "microstrip",
            "width": self.width,
            "thickness": self.thickness,
            "height_above_magnet": self.height_above_magnet,
            "preview_length": self.preview_length,
            "center_x": self.center_x,
            "center_y": self.center_y,
            "current_distribution": self.current_distribution,
        }


@dataclass(frozen=True, slots=True)
class CPWAntenna:
    signal_width: float
    gap: float
    ground_width: float
    thickness: float
    height_above_magnet: float
    preview_length: float
    center_x: float = 0.0
    center_y: float = 0.0
    current_distribution: str = "uniform"

    def __post_init__(self) -> None:
        require_positive(self.signal_width, "signal_width")
        require_positive(self.gap, "gap")
        require_positive(self.ground_width, "ground_width")
        require_positive(self.thickness, "thickness")
        require_non_negative(self.height_above_magnet, "height_above_magnet")
        require_positive(self.preview_length, "preview_length")
        object.__setattr__(
            self,
            "current_distribution",
            require_non_empty(self.current_distribution, "current_distribution").lower(),
        )
        if self.current_distribution not in CURRENT_DISTRIBUTIONS:
            raise ValueError(
                f"current_distribution must be one of {sorted(CURRENT_DISTRIBUTIONS)}, "
                f"got {self.current_distribution!r}"
            )

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "cpw",
            "signal_width": self.signal_width,
            "gap": self.gap,
            "ground_width": self.ground_width,
            "thickness": self.thickness,
            "height_above_magnet": self.height_above_magnet,
            "preview_length": self.preview_length,
            "center_x": self.center_x,
            "center_y": self.center_y,
            "current_distribution": self.current_distribution,
        }


Antenna = MicrostripAntenna | CPWAntenna


@dataclass(frozen=True, slots=True)
class AntennaFieldSource:
    name: str
    antenna: Antenna | None = None
    drive: RfDrive | None = None
    solver: str | None = None
    air_box_factor: float | None = None
    model: str = "mqs_2p5d_az"
    object: str | None = None
    B: float | None = None
    direction: tuple[float, float, float] = (0.0, 0.0, 1.0)
    spatial_profile: dict[str, object] | None = None
    waveform: TimeDependence | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", require_non_empty(self.name, "name"))
        model = require_non_empty(self.model, "model").lower()
        object.__setattr__(self, "model", model)
        if model not in ANTENNA_FIELD_SOURCE_MODELS:
            raise ValueError(
                f"model must be one of {sorted(ANTENNA_FIELD_SOURCE_MODELS)}, got {model!r}"
            )
        object.__setattr__(self, "direction", as_vector3(self.direction, "direction"))
        if self.waveform is not None and not hasattr(self.waveform, "to_ir"):
            raise TypeError("waveform must be a Fullmag time-dependence object")

        if model == "mqs_2p5d_az":
            if self.antenna is None:
                raise ValueError("antenna is required for model='mqs_2p5d_az'")
            if self.drive is None:
                raise ValueError("drive is required for model='mqs_2p5d_az'")
            solver = require_non_empty(self.solver or "mqs_2p5d_az", "solver").lower()
            object.__setattr__(self, "solver", solver)
            air_box_factor = 12.0 if self.air_box_factor is None else self.air_box_factor
            require_positive(air_box_factor, "air_box_factor")
            object.__setattr__(self, "air_box_factor", air_box_factor)
            if solver not in ANTENNA_SOLVERS:
                raise ValueError(
                    f"solver must be one of {sorted(ANTENNA_SOLVERS)}, got {solver!r}"
                )
            return

        if self.object is None or not str(self.object).strip():
            raise ValueError("object is required for model='prescribed_zeeman_mask'")
        if self.B is None:
            raise ValueError("B is required for model='prescribed_zeeman_mask'")
        require_finite(self.B, "B")
        direction = self.direction
        norm_sq = sum(component * component for component in direction)
        if norm_sq <= 1e-30:
            raise ValueError("direction must be non-zero")
        if self.antenna is not None or self.drive is not None or self.solver is not None:
            raise ValueError(
                "prescribed_zeeman_mask must not define antenna, drive, or solver"
            )
        if self.air_box_factor is not None:
            raise ValueError("prescribed_zeeman_mask must not define air_box_factor")

    def to_ir(self) -> dict[str, object]:
        if self.model == "prescribed_zeeman_mask":
            waveform = self.waveform.to_ir() if self.waveform is not None else None
            ir = {
                "kind": "antenna_field_source",
                "name": self.name,
                "model": self.model,
                "object": str(self.object),
                "field": {
                    "amplitude_B_T": float(self.B if self.B is not None else 0.0),
                    "direction": list(self.direction),
                },
                "spatial_profile": self.spatial_profile or {"kind": "uniform"},
            }
            if waveform is not None:
                ir["waveform"] = waveform
            return ir

        assert self.antenna is not None
        assert self.drive is not None
        return {
            "kind": "antenna_field_source",
            "name": self.name,
            "model": self.model,
            "solver": self.solver or "mqs_2p5d_az",
            "antenna": self.antenna.to_ir(),
            "drive": self.drive.to_ir(),
            "air_box_factor": self.air_box_factor if self.air_box_factor is not None else 12.0,
        }


@dataclass(frozen=True, slots=True)
class SpinWaveExcitationAnalysis:
    source: str
    method: str = "source_k_profile"
    propagation_axis: tuple[float, float, float] = (1.0, 0.0, 0.0)
    k_max_rad_per_m: float | None = None
    samples: int = 256

    def __post_init__(self) -> None:
        object.__setattr__(self, "source", require_non_empty(self.source, "source"))
        object.__setattr__(self, "method", require_non_empty(self.method, "method").lower())
        object.__setattr__(
            self, "propagation_axis", as_vector3(self.propagation_axis, "propagation_axis")
        )
        if self.method not in {"source_k_profile"}:
            raise ValueError("method must currently be 'source_k_profile'")
        if self.k_max_rad_per_m is not None:
            require_positive(self.k_max_rad_per_m, "k_max_rad_per_m")
        if self.samples <= 1:
            raise ValueError("samples must be greater than 1")

    def to_ir(self) -> dict[str, object]:
        ir = {
            "source": self.source,
            "method": self.method,
            "propagation_axis": list(self.propagation_axis),
            "samples": int(self.samples),
        }
        if self.k_max_rad_per_m is not None:
            ir["k_max_rad_per_m"] = self.k_max_rad_per_m
        return ir
