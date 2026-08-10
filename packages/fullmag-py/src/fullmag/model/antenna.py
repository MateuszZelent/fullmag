from __future__ import annotations

from dataclasses import dataclass
import math
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
FIELD_TIME_ORIGINS = frozenset({"stage_local", "absolute"})
SPATIAL_WINDOWS = frozenset({"none", "hann"})


def _normalized_vector3(value: Sequence[float], name: str) -> tuple[float, float, float]:
    vector = as_vector3(value, name)
    norm = math.sqrt(sum(component * component for component in vector))
    if not math.isfinite(norm) or norm <= 1e-15:
        raise ValueError(f"{name} must be non-zero")
    return tuple(component / norm for component in vector)


@dataclass(frozen=True, slots=True)
class FieldTarget:
    kind: str
    object_id: str | None = None
    region_id: str | None = None

    def __post_init__(self) -> None:
        kind = require_non_empty(self.kind, "target.kind").lower()
        object.__setattr__(self, "kind", kind)
        if kind == "global":
            if self.object_id is not None or self.region_id is not None:
                raise ValueError("global target must not define object_id or region_id")
            return
        if kind not in {"object", "region"}:
            raise ValueError("target.kind must be 'global', 'object', or 'region'")
        object_id = require_non_empty(self.object_id or "", "target.object_id")
        object.__setattr__(self, "object_id", object_id)
        if kind == "object":
            if self.region_id is not None:
                raise ValueError("object target must not define region_id")
            return
        object.__setattr__(
            self,
            "region_id",
            require_non_empty(self.region_id or "", "target.region_id"),
        )

    @classmethod
    def global_domain(cls) -> "FieldTarget":
        return cls(kind="global")

    @classmethod
    def object(cls, object_id: str) -> "FieldTarget":
        return cls(kind="object", object_id=object_id)

    @classmethod
    def region(cls, object_id: str, region_id: str) -> "FieldTarget":
        return cls(kind="region", object_id=object_id, region_id=region_id)

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {"kind": self.kind}
        if self.object_id is not None:
            payload["object_id"] = self.object_id
        if self.region_id is not None:
            payload["region_id"] = self.region_id
        return payload


@dataclass(frozen=True, slots=True)
class UniformFieldProfile:
    def to_ir(self) -> dict[str, object]:
        return {"kind": "uniform"}


@dataclass(frozen=True, slots=True)
class SincFieldProfile:
    axis: tuple[float, float, float]
    period_m: float
    center_m: float = 0.0
    width_m: float | None = None
    window: str = "none"

    def __init__(
        self,
        axis: Sequence[float],
        period_m: float,
        center_m: float = 0.0,
        width_m: float | None = None,
        window: str = "none",
    ) -> None:
        object.__setattr__(self, "axis", _normalized_vector3(axis, "spatial_profile.axis"))
        require_positive(period_m, "spatial_profile.period_m")
        require_finite(center_m, "spatial_profile.center_m")
        if width_m is not None:
            require_positive(width_m, "spatial_profile.width_m")
        normalized_window = require_non_empty(window, "spatial_profile.window").lower()
        if normalized_window not in SPATIAL_WINDOWS:
            raise ValueError(
                f"spatial_profile.window must be one of {sorted(SPATIAL_WINDOWS)}"
            )
        object.__setattr__(self, "period_m", float(period_m))
        object.__setattr__(self, "center_m", float(center_m))
        object.__setattr__(self, "width_m", None if width_m is None else float(width_m))
        object.__setattr__(self, "window", normalized_window)

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "kind": "sinc",
            "axis": list(self.axis),
            "period_m": self.period_m,
            "center_m": self.center_m,
            "window": self.window,
        }
        if self.width_m is not None:
            payload["width_m"] = self.width_m
        return payload


@dataclass(frozen=True, slots=True)
class GaussianPlaneWaveFieldProfile:
    center_x_m: float
    center_y_m: float
    carrier_origin_x_m: float
    sigma_x_m: float
    sigma_y_m: float
    wavelength_m: float
    carrier_phase_rad: float = 0.0

    def __post_init__(self) -> None:
        for field_name in (
            "center_x_m",
            "center_y_m",
            "carrier_origin_x_m",
            "carrier_phase_rad",
        ):
            value = require_finite(getattr(self, field_name), f"spatial_profile.{field_name}")
            object.__setattr__(self, field_name, value)
        for field_name in ("sigma_x_m", "sigma_y_m", "wavelength_m"):
            value = require_positive(getattr(self, field_name), f"spatial_profile.{field_name}")
            object.__setattr__(self, field_name, value)

    def value_at(self, point: Sequence[float]) -> float:
        x, y, _ = as_vector3(point, "spatial_profile.point")
        if not all(math.isfinite(value) for value in (x, y)):
            raise ValueError("spatial_profile.point must be finite")
        envelope = math.exp(
            -0.5 * (
                ((x - self.center_x_m) / self.sigma_x_m) ** 2
                + ((y - self.center_y_m) / self.sigma_y_m) ** 2
            )
        )
        carrier = 2.0 * math.pi * (x - self.carrier_origin_x_m) / self.wavelength_m
        return envelope * math.cos(carrier + self.carrier_phase_rad)

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "gaussian_plane_wave",
            "center_x_m": self.center_x_m,
            "center_y_m": self.center_y_m,
            "carrier_origin_x_m": self.carrier_origin_x_m,
            "sigma_x_m": self.sigma_x_m,
            "sigma_y_m": self.sigma_y_m,
            "wavelength_m": self.wavelength_m,
            "carrier_phase_rad": self.carrier_phase_rad,
        }


FieldEnvelope = UniformFieldProfile | SincFieldProfile


@dataclass(frozen=True, slots=True)
class GeometryMaskFieldProfile:
    object_id: str
    envelope: FieldEnvelope = UniformFieldProfile()

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "object_id",
            require_non_empty(self.object_id, "spatial_profile.object_id"),
        )
        if not isinstance(self.envelope, (UniformFieldProfile, SincFieldProfile)):
            raise TypeError("geometry-mask envelope must be UniformFieldProfile or SincFieldProfile")

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "geometry_mask",
            "object_id": self.object_id,
            "envelope": self.envelope.to_ir(),
        }


FieldSpatialProfile = (
    UniformFieldProfile
    | SincFieldProfile
    | GaussianPlaneWaveFieldProfile
    | GeometryMaskFieldProfile
)


@dataclass(frozen=True, slots=True)
class DriveActivation:
    kind: str
    stage_ids_value: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        kind = require_non_empty(self.kind, "activation.kind").lower()
        object.__setattr__(self, "kind", kind)
        if kind == "all_time_evolution":
            if self.stage_ids_value:
                raise ValueError("all_time_evolution activation must not define stage ids")
            return
        if kind != "stage_ids":
            raise ValueError("activation.kind must be 'all_time_evolution' or 'stage_ids'")
        if not self.stage_ids_value:
            raise ValueError("stage_ids activation requires at least one stage id")
        normalized = tuple(
            require_non_empty(stage_id, "activation.stage_id")
            for stage_id in self.stage_ids_value
        )
        if len(set(normalized)) != len(normalized):
            raise ValueError("activation stage ids must be unique")
        object.__setattr__(self, "stage_ids_value", normalized)

    @classmethod
    def all_time_evolution(cls) -> "DriveActivation":
        return cls(kind="all_time_evolution")

    @classmethod
    def stage_ids(cls, stage_ids: Sequence[str]) -> "DriveActivation":
        return cls(kind="stage_ids", stage_ids_value=tuple(stage_ids))

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {"kind": self.kind}
        if self.kind == "stage_ids":
            payload["stage_ids"] = list(self.stage_ids_value)
        return payload


@dataclass(frozen=True, slots=True)
class RegionalFieldDrive:
    id: str
    name: str
    target: FieldTarget
    amplitude_B_T: float
    direction: tuple[float, float, float]
    spatial_profile: FieldSpatialProfile
    waveform: TimeDependence
    time_origin: str = "stage_local"
    activation: DriveActivation = DriveActivation(kind="all_time_evolution")
    enabled: bool = True
    migration: dict[str, str] | None = None

    def __init__(
        self,
        *,
        id: str,
        name: str,
        target: FieldTarget,
        amplitude_B_T: float,
        direction: Sequence[float],
        spatial_profile: FieldSpatialProfile,
        waveform: TimeDependence,
        time_origin: str = "stage_local",
        activation: DriveActivation | None = None,
        enabled: bool = True,
        migration: dict[str, str] | None = None,
    ) -> None:
        object.__setattr__(self, "id", require_non_empty(id, "field_drive.id"))
        object.__setattr__(self, "name", require_non_empty(name, "field_drive.name"))
        if not isinstance(target, FieldTarget):
            raise TypeError("target must be a FieldTarget")
        require_non_negative(amplitude_B_T, "amplitude_B_T")
        object.__setattr__(self, "target", target)
        object.__setattr__(self, "amplitude_B_T", float(amplitude_B_T))
        object.__setattr__(self, "direction", _normalized_vector3(direction, "direction"))
        if not isinstance(
            spatial_profile,
            (
                UniformFieldProfile,
                SincFieldProfile,
                GaussianPlaneWaveFieldProfile,
                GeometryMaskFieldProfile,
            ),
        ):
            raise TypeError("spatial_profile must be a typed Fullmag field profile")
        if not hasattr(waveform, "to_ir"):
            raise TypeError("waveform must be a Fullmag time-dependence object")
        normalized_origin = require_non_empty(time_origin, "time_origin").lower()
        if normalized_origin not in FIELD_TIME_ORIGINS:
            raise ValueError(f"time_origin must be one of {sorted(FIELD_TIME_ORIGINS)}")
        resolved_activation = activation or DriveActivation.all_time_evolution()
        if not isinstance(resolved_activation, DriveActivation):
            raise TypeError("activation must be a DriveActivation")
        object.__setattr__(self, "spatial_profile", spatial_profile)
        object.__setattr__(self, "waveform", waveform)
        object.__setattr__(self, "time_origin", normalized_origin)
        object.__setattr__(self, "activation", resolved_activation)
        object.__setattr__(self, "enabled", bool(enabled))
        if migration is not None:
            if migration != {"migrated_from": "prescribed_zeeman_mask"}:
                raise ValueError("unsupported RegionalFieldDrive migration provenance")
            migration = dict(migration)
        object.__setattr__(self, "migration", migration)

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "id": self.id,
            "name": self.name,
            "kind": "regional",
            "enabled": self.enabled,
            "target": self.target.to_ir(),
            "amplitude_B_T": self.amplitude_B_T,
            "direction": list(self.direction),
            "spatial_profile": self.spatial_profile.to_ir(),
            "waveform": self.waveform.to_ir(),
            "time_origin": self.time_origin,
            "activation": self.activation.to_ir(),
        }
        if self.migration is not None:
            payload["migration"] = dict(self.migration)
        return payload


@dataclass(frozen=True, slots=True)
class GaussianPlaneWaveAntenna:
    id: str
    amplitude_B_T: float
    frequency_hz: float
    wavelength_m: float
    sigma_x_m: float
    fwhm_y_m: float
    center_x_m: float = 0.0
    center_y_m: float = 0.0
    carrier_origin_x_m: float = 0.0
    spatial_phase_rad: float = 0.0
    phase_rad: float = 0.0
    t0_s: float = 0.0
    target: FieldTarget = FieldTarget.global_domain()
    activation: DriveActivation = DriveActivation(kind="all_time_evolution")
    time_origin: str = "stage_local"
    enabled: bool = True

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", require_non_empty(self.id, "antenna.id"))
        object.__setattr__(
            self,
            "amplitude_B_T",
            require_non_negative(self.amplitude_B_T, "antenna.amplitude_B_T"),
        )
        for field_name in (
            "center_x_m",
            "center_y_m",
            "carrier_origin_x_m",
            "spatial_phase_rad",
            "phase_rad",
        ):
            value = require_finite(getattr(self, field_name), f"antenna.{field_name}")
            object.__setattr__(self, field_name, value)
        object.__setattr__(
            self,
            "frequency_hz",
            require_positive(self.frequency_hz, "antenna.frequency_hz"),
        )
        object.__setattr__(
            self,
            "wavelength_m",
            require_positive(self.wavelength_m, "antenna.wavelength_m"),
        )
        object.__setattr__(
            self,
            "sigma_x_m",
            require_positive(self.sigma_x_m, "antenna.sigma_x_m"),
        )
        object.__setattr__(
            self,
            "fwhm_y_m",
            require_positive(self.fwhm_y_m, "antenna.fwhm_y_m"),
        )
        object.__setattr__(self, "t0_s", require_non_negative(self.t0_s, "antenna.t0_s"))
        if not isinstance(self.target, FieldTarget):
            raise TypeError("antenna.target must be a FieldTarget")
        if not isinstance(self.activation, DriveActivation):
            raise TypeError("antenna.activation must be a DriveActivation")
        normalized_origin = require_non_empty(self.time_origin, "antenna.time_origin").lower()
        if normalized_origin not in FIELD_TIME_ORIGINS:
            raise ValueError(f"antenna.time_origin must be one of {sorted(FIELD_TIME_ORIGINS)}")
        object.__setattr__(self, "time_origin", normalized_origin)
        object.__setattr__(self, "enabled", bool(self.enabled))

    @property
    def sigma_y_m(self) -> float:
        return self.fwhm_y_m / (2.0 * math.sqrt(2.0 * math.log(2.0)))

    def to_drives(self) -> tuple[RegionalFieldDrive, RegionalFieldDrive]:
        waveform = Sinusoidal(
            frequency_hz=self.frequency_hz,
            phase_rad=self.phase_rad - 2.0 * math.pi * self.frequency_hz * self.t0_s,
        )
        base_profile = dict(
            center_x_m=self.center_x_m,
            center_y_m=self.center_y_m,
            carrier_origin_x_m=self.carrier_origin_x_m,
            sigma_x_m=self.sigma_x_m,
            sigma_y_m=self.sigma_y_m,
            wavelength_m=self.wavelength_m,
        )
        x_profile = GaussianPlaneWaveFieldProfile(
            **base_profile,
            carrier_phase_rad=self.spatial_phase_rad,
        )
        z_profile = GaussianPlaneWaveFieldProfile(
            **base_profile,
            carrier_phase_rad=self.spatial_phase_rad - math.pi / 2.0,
        )
        common = {
            "target": self.target,
            "amplitude_B_T": self.amplitude_B_T,
            "waveform": waveform,
            "time_origin": self.time_origin,
            "activation": self.activation,
            "enabled": self.enabled,
        }
        return (
            RegionalFieldDrive(
                id=f"{self.id}_x",
                name=f"{self.id} x quadrature",
                direction=(1.0, 0.0, 0.0),
                spatial_profile=x_profile,
                **common,
            ),
            RegionalFieldDrive(
                id=f"{self.id}_z",
                name=f"{self.id} z quadrature",
                direction=(0.0, 0.0, 1.0),
                spatial_profile=z_profile,
                **common,
            ),
        )


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
