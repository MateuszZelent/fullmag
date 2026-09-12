from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Mapping, Sequence

from fullmag._validation import require_non_empty, require_positive

KVector = tuple[float, float, float]

_BIAS_FIELD_SWEEP_EQUILIBRIUM_POLICIES = {"relax_each", "continuation"}
_BIAS_FIELD_SWEEP_CONTINUATION_SEEDS = {
    "previous_accepted_equilibrium",
    "initial_state",
}

SUPPORTED_TRACKING_METHODS = {
    "overlap_greedy",
    "overlap_hungarian",
}

SUPPORTED_DISPERSION_VALIDATION_GEOMETRIES = {
    "damon_eshbach": "damon_eshbach",
    "damon-eshbach": "damon_eshbach",
    "de": "damon_eshbach",
    "backward_volume": "backward_volume",
    "backward-volume": "backward_volume",
    "bv": "backward_volume",
}

SUPPORTED_K0_KITTEL_MODELS = {
    "macrospin_larmor",
    "thin_film_in_plane",
}

SUPPORTED_K0_KITTEL_DEMAG_KINDS = {
    "none",
    "periodic_airbox_k0",
    "synthetic_demag_factor",
}


def _normalize_vec3(value: Sequence[float], name: str) -> KVector:
    if len(value) != 3:
        raise ValueError(f"{name} must have exactly three components")
    return (float(value[0]), float(value[1]), float(value[2]))


@dataclass(frozen=True, slots=True)
class BiasFieldSweep:
    """Declared physical bias-field samples in SI ``A/m`` for modal K0 scans."""

    samples_a_per_m: Sequence[Sequence[float]]
    equilibrium_policy: str = "relax_each"
    continuation_seed: str = "initial_state"

    def __post_init__(self) -> None:
        samples = tuple(
            _normalize_vec3(sample, f"samples_a_per_m[{index}]")
            for index, sample in enumerate(self.samples_a_per_m)
        )
        if not samples:
            raise ValueError("samples_a_per_m must not be empty")
        if not all(math.isfinite(component) for sample in samples for component in sample):
            raise ValueError("samples_a_per_m must contain finite A/m values")
        if self.equilibrium_policy not in _BIAS_FIELD_SWEEP_EQUILIBRIUM_POLICIES:
            raise ValueError("equilibrium_policy must be 'relax_each' or 'continuation'")
        if self.continuation_seed not in _BIAS_FIELD_SWEEP_CONTINUATION_SEEDS:
            raise ValueError(
                "continuation_seed must be 'previous_accepted_equilibrium' or 'initial_state'"
            )
        object.__setattr__(self, "samples_a_per_m", samples)

    def to_ir(self) -> dict[str, object]:
        return {
            "samples_a_per_m": [list(sample) for sample in self.samples_a_per_m],
            "equilibrium_policy": self.equilibrium_policy,
            "ordering": "declared",
            "continuation_seed": self.continuation_seed,
        }


def _tuple_of_positive_ints(values: Sequence[int], name: str) -> tuple[int, ...]:
    normalized = tuple(int(v) for v in values)
    if not normalized:
        raise ValueError(f"{name} must not be empty")
    if any(v <= 0 for v in normalized):
        raise ValueError(f"{name} must contain positive integers only")
    return normalized


def _tuple_of_sample_indices(values: Sequence[int], name: str) -> tuple[int, ...]:
    normalized = tuple(int(v) for v in values)
    if not normalized:
        raise ValueError(f"{name} must not be empty")
    if any(v < 0 for v in normalized):
        raise ValueError(f"{name} must contain non-negative integers only")
    return normalized


def _normalize_dispersion_geometry(value: str) -> str:
    key = require_non_empty(value, "geometry").strip().lower().replace(" ", "_")
    try:
        return SUPPORTED_DISPERSION_VALIDATION_GEOMETRIES[key]
    except KeyError as exc:
        supported = "damon_eshbach, backward_volume"
        raise ValueError(f"geometry must be one of: {supported}") from exc


def _normalize_frequency_window(value: Sequence[float]) -> tuple[float, float]:
    if len(value) != 2:
        raise ValueError("frequency_window_hz must have exactly two values")
    lo = float(value[0])
    hi = float(value[1])
    if lo < 0.0:
        raise ValueError("frequency_window_hz minimum must be >= 0")
    if hi <= lo:
        raise ValueError("frequency_window_hz maximum must be greater than minimum")
    if hi > 5.0e9:
        raise ValueError("frequency_window_hz maximum must not exceed 5 GHz")
    return (lo, hi)


def _require_nonzero_vec3(value: KVector, name: str) -> None:
    if all(component == 0.0 for component in value):
        raise ValueError(f"{name} must be non-zero")


@dataclass(frozen=True, slots=True)
class KPoint:
    label: str | None
    k: KVector

    def __post_init__(self) -> None:
        if self.label is not None:
            object.__setattr__(self, "label", require_non_empty(self.label, "label"))
        object.__setattr__(self, "k", _normalize_vec3(self.k, "k"))

    def to_ir(self) -> dict[str, object]:
        return {
            "label": self.label,
            "k_vector": list(self.k),
        }


@dataclass(frozen=True, slots=True)
class KPath:
    points: Sequence[KPoint]
    samples_per_segment: Sequence[int]
    closed: bool = False

    def __post_init__(self) -> None:
        normalized_points = tuple(self.points)
        if len(normalized_points) < 2:
            raise ValueError("KPath requires at least two points")
        object.__setattr__(self, "points", normalized_points)

        normalized_samples = _tuple_of_positive_ints(
            self.samples_per_segment,
            "samples_per_segment",
        )
        expected_segments = len(normalized_points) if self.closed else len(normalized_points) - 1
        if len(normalized_samples) != expected_segments:
            raise ValueError(
                "samples_per_segment must have length equal to the number of path segments "
                f"({expected_segments})"
            )
        object.__setattr__(self, "samples_per_segment", normalized_samples)

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "path",
            "points": [point.to_ir() for point in self.points],
            "samples_per_segment": list(self.samples_per_segment),
            "closed": self.closed,
        }


@dataclass(frozen=True, slots=True)
class DispersionValidationScenario:
    geometry: str
    branch_id: str
    sample_indices: Sequence[int]

    def __post_init__(self) -> None:
        object.__setattr__(self, "geometry", _normalize_dispersion_geometry(self.geometry))
        object.__setattr__(self, "branch_id", require_non_empty(self.branch_id, "branch_id"))
        sample_indices = _tuple_of_sample_indices(self.sample_indices, "sample_indices")
        if len(sample_indices) < 3:
            raise ValueError("sample_indices must contain at least three samples")
        object.__setattr__(self, "sample_indices", sample_indices)

    def to_ir(self) -> dict[str, object]:
        return {
            "geometry": self.geometry,
            "branch_id": self.branch_id,
            "sample_indices": list(self.sample_indices),
        }


@dataclass(frozen=True, slots=True)
class ThinFilmDEBVDispersionValidation:
    film_thickness_m: float
    equilibrium_magnetization: Sequence[float]
    scenarios: Sequence[DispersionValidationScenario | Mapping[str, object]]
    film_normal: Sequence[float] = (0.0, 0.0, 1.0)
    frequency_window_hz: Sequence[float] = (0.0, 5.0e9)
    max_k_rad_per_m: float = 3.0e6
    max_relative_error: float = 0.10
    analytic_model: str = "kalinikos_slab_n0"

    def __post_init__(self) -> None:
        require_positive(self.film_thickness_m, "film_thickness_m")
        max_k = require_positive(self.max_k_rad_per_m, "max_k_rad_per_m")
        if max_k > 3.0e6:
            raise ValueError("max_k_rad_per_m must not exceed 3e6")
        max_relative_error = require_positive(self.max_relative_error, "max_relative_error")
        if max_relative_error > 0.25:
            raise ValueError("max_relative_error must not exceed 0.25")
        if self.analytic_model != "kalinikos_slab_n0":
            raise ValueError("analytic_model must be 'kalinikos_slab_n0'")

        m0 = _normalize_vec3(self.equilibrium_magnetization, "equilibrium_magnetization")
        _require_nonzero_vec3(m0, "equilibrium_magnetization")
        film_normal = _normalize_vec3(self.film_normal, "film_normal")
        _require_nonzero_vec3(film_normal, "film_normal")
        frequency_window = _normalize_frequency_window(self.frequency_window_hz)

        scenarios = tuple(
            scenario
            if isinstance(scenario, DispersionValidationScenario)
            else DispersionValidationScenario(
                geometry=str(scenario.get("geometry")),
                branch_id=str(scenario.get("branch_id")),
                sample_indices=scenario.get("sample_indices"),  # type: ignore[arg-type]
            )
            for scenario in self.scenarios
        )
        geometries = {scenario.geometry for scenario in scenarios}
        if {"damon_eshbach", "backward_volume"} - geometries:
            raise ValueError(
                "scenarios must include both damon_eshbach and backward_volume"
            )

        object.__setattr__(self, "film_thickness_m", float(self.film_thickness_m))
        object.__setattr__(self, "equilibrium_magnetization", m0)
        object.__setattr__(self, "film_normal", film_normal)
        object.__setattr__(self, "frequency_window_hz", frequency_window)
        object.__setattr__(self, "max_k_rad_per_m", float(max_k))
        object.__setattr__(self, "max_relative_error", float(max_relative_error))
        object.__setattr__(self, "scenarios", scenarios)

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "thin_film_de_bv_low_k",
            "analytic_model": self.analytic_model,
            "film_thickness_m": self.film_thickness_m,
            "equilibrium_magnetization": list(self.equilibrium_magnetization),
            "film_normal": list(self.film_normal),
            "frequency_window_hz": {
                "min": self.frequency_window_hz[0],
                "max": self.frequency_window_hz[1],
            },
            "max_k_rad_per_m": self.max_k_rad_per_m,
            "max_relative_error": self.max_relative_error,
            "scenarios": [scenario.to_ir() for scenario in self.scenarios],
        }


@dataclass(frozen=True, slots=True)
class K0KittelFieldSample:
    sample_index: int
    bias_field: Sequence[float]

    def __post_init__(self) -> None:
        sample_index = int(self.sample_index)
        if sample_index < 0:
            raise ValueError("sample_index must be non-negative")
        bias_field = _normalize_vec3(self.bias_field, "bias_field")
        _require_nonzero_vec3(bias_field, "bias_field")
        object.__setattr__(self, "sample_index", sample_index)
        object.__setattr__(self, "bias_field", bias_field)

    def to_ir(self) -> dict[str, object]:
        return {
            "sample_index": self.sample_index,
            "bias_field": list(self.bias_field),
        }


@dataclass(frozen=True, slots=True)
class K0KittelFieldSweepValidation:
    samples: Sequence[K0KittelFieldSample | Mapping[str, object]]
    model: str = "macrospin_larmor"
    effective_magnetisation: float | None = None
    relative_tolerance: float = 0.05
    case_id: str | None = None
    demag_kind: str | None = None

    def __post_init__(self) -> None:
        model = require_non_empty(self.model, "model")
        if model not in SUPPORTED_K0_KITTEL_MODELS:
            supported = ", ".join(sorted(SUPPORTED_K0_KITTEL_MODELS))
            raise ValueError(f"model must be one of: {supported}")
        case_id = None if self.case_id is None else require_non_empty(self.case_id, "case_id")
        demag_kind = None
        if self.demag_kind is not None:
            demag_kind = require_non_empty(self.demag_kind, "demag_kind")
            if demag_kind not in SUPPORTED_K0_KITTEL_DEMAG_KINDS:
                supported = ", ".join(sorted(SUPPORTED_K0_KITTEL_DEMAG_KINDS))
                raise ValueError(f"demag_kind must be one of: {supported}")
        relative_tolerance = require_positive(self.relative_tolerance, "relative_tolerance")
        if relative_tolerance > 0.25:
            raise ValueError("relative_tolerance must not exceed 0.25")
        effective_magnetisation = self.effective_magnetisation
        if model == "thin_film_in_plane":
            effective_magnetisation = require_positive(
                effective_magnetisation,
                "effective_magnetisation",
            )
        elif effective_magnetisation is not None:
            effective_magnetisation = require_positive(
                effective_magnetisation,
                "effective_magnetisation",
            )
        samples = tuple(
            sample
            if isinstance(sample, K0KittelFieldSample)
            else K0KittelFieldSample(
                sample_index=int(sample.get("sample_index")),
                bias_field=sample.get("bias_field"),  # type: ignore[arg-type]
            )
            for sample in self.samples
        )
        if len(samples) < 3:
            raise ValueError("K0KittelFieldSweepValidation requires at least three samples")
        sample_indices = [sample.sample_index for sample in samples]
        if len(set(sample_indices)) != len(sample_indices):
            raise ValueError("sample_index values must be unique")

        object.__setattr__(self, "model", model)
        object.__setattr__(self, "case_id", case_id)
        object.__setattr__(self, "demag_kind", demag_kind)
        object.__setattr__(self, "relative_tolerance", float(relative_tolerance))
        object.__setattr__(self, "effective_magnetisation", effective_magnetisation)
        object.__setattr__(self, "samples", samples)

    def to_ir(self) -> dict[str, object]:
        material: dict[str, object] = {}
        if self.effective_magnetisation is not None:
            material["effective_magnetisation"] = self.effective_magnetisation
        payload: dict[str, object] = {
            "kind": "k0_kittel_field_sweep",
            "model": self.model,
            "field_units": "A_per_m",
            "relative_tolerance": self.relative_tolerance,
            "material": material,
            "samples": [sample.to_ir() for sample in self.samples],
        }
        if self.case_id is not None:
            payload["case_id"] = self.case_id
        if self.demag_kind is not None:
            payload["demag_kind"] = self.demag_kind
        return payload


@dataclass(frozen=True, slots=True)
class ModeTracking:
    method: str = "overlap_hungarian"
    frequency_window_hz: float | None = None
    overlap_floor: float = 0.50
    max_branch_gap: int = 1

    def __post_init__(self) -> None:
        if self.method not in SUPPORTED_TRACKING_METHODS:
            supported = ", ".join(sorted(SUPPORTED_TRACKING_METHODS))
            raise ValueError(f"method must be one of: {supported}")
        if self.frequency_window_hz is not None:
            require_positive(self.frequency_window_hz, "frequency_window_hz")
        require_positive(self.overlap_floor, "overlap_floor")
        if not (0.0 <= self.overlap_floor <= 1.0):
            raise ValueError("overlap_floor must be in the interval [0, 1]")
        if self.max_branch_gap < 0:
            raise ValueError("max_branch_gap must be >= 0")

    def to_ir(self) -> dict[str, object]:
        return {
            "method": self.method,
            "frequency_window_hz": self.frequency_window_hz,
            "overlap_floor": self.overlap_floor,
            "max_branch_gap": self.max_branch_gap,
        }


def serialize_k_sampling(value: object | None) -> dict[str, object] | None:
    if value is None:
        return None
    if isinstance(value, KPath):
        return value.to_ir()
    if isinstance(value, KPoint):
        return {
            "kind": "single",
            "k_vector": list(value.k),
        }
    if isinstance(value, (tuple, list)):
        k = _normalize_vec3(value, "k_sampling")
        return {
            "kind": "single",
            "k_vector": list(k),
        }
    raise ValueError(
        "k_sampling must be None, a 3-vector, KPoint, or KPath"
    )


def coerce_k_sampling(
    *,
    k_sampling: object | None,
    legacy_k_vector: Sequence[float] | None,
) -> dict[str, object] | None:
    if k_sampling is not None and legacy_k_vector is not None:
        raise ValueError("use either k_sampling or k_vector, not both")
    if k_sampling is not None:
        return serialize_k_sampling(k_sampling)
    if legacy_k_vector is not None:
        return serialize_k_sampling(tuple(float(v) for v in legacy_k_vector))
    return None


def is_zero_k_vector(value: Sequence[float] | None) -> bool:
    if value is None:
        return True
    vec = _normalize_vec3(value, "value")
    return all(component == 0.0 for component in vec)


def serialize_dispersion_validation(value: object) -> dict[str, object]:
    if isinstance(value, ThinFilmDEBVDispersionValidation):
        return value.to_ir()
    if isinstance(value, Mapping):
        return dict(value)
    to_ir = getattr(value, "to_ir", None)
    if callable(to_ir):
        payload = to_ir()
        if not isinstance(payload, dict):
            raise ValueError("dispersion validation to_ir() must return a dict")
        return payload
    raise ValueError(
        "dispersion validation must be a dict or an object with to_ir()"
    )


def serialize_k0_kittel_validation(value: object) -> dict[str, object]:
    if isinstance(value, K0KittelFieldSweepValidation):
        return value.to_ir()
    if isinstance(value, Mapping):
        return dict(value)
    to_ir = getattr(value, "to_ir", None)
    if callable(to_ir):
        payload = to_ir()
        if not isinstance(payload, dict):
            raise ValueError("k0 Kittel validation to_ir() must return a dict")
        return payload
    raise ValueError(
        "k0 Kittel validation must be a dict or an object with to_ir()"
    )


__all__ = [
    "DispersionValidationScenario",
    "K0KittelFieldSample",
    "K0KittelFieldSweepValidation",
    "KVector",
    "KPoint",
    "KPath",
    "ModeTracking",
    "ThinFilmDEBVDispersionValidation",
    "coerce_k_sampling",
    "is_zero_k_vector",
    "serialize_dispersion_validation",
    "serialize_k0_kittel_validation",
    "serialize_k_sampling",
]
