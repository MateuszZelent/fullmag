"""Canonical SI contract for NIST µMAG Standard Problem 4."""

from dataclasses import dataclass
import math


PRODUCTION_RELAXATION_ALGORITHMS = (
    "llg_overdamped",
    "projected_gradient_bb",
    "nonlinear_cg",
)
CANONICAL_RELAXATION_ALGORITHM = "llg_overdamped"
CANONICAL_RELAXATION_DEVICE = "gpu"
DEFAULT_RELAXATION_ALGORITHM = CANONICAL_RELAXATION_ALGORITHM
RELAXATION_DT_MAX_S = 1e-14


@dataclass(frozen=True)
class SP4Case:
    id: str
    field_t: tuple[float, float, float]


@dataclass(frozen=True)
class MeshLevel:
    id: str
    hmax_m: float


@dataclass(frozen=True)
class AirboxVariant:
    id: str
    dimensions_m: tuple[float, float, float]
    hmax_m: float


@dataclass(frozen=True)
class EnergyComparisonTolerance:
    atol_j: float
    rtol: float

    def __post_init__(self) -> None:
        if not math.isfinite(self.atol_j) or self.atol_j < 0.0:
            raise ValueError("energy absolute tolerance must be finite and nonnegative")
        if not math.isfinite(self.rtol) or self.rtol < 0.0:
            raise ValueError("energy relative tolerance must be finite and nonnegative")

    def accepts(self, left_j: float, right_j: float) -> bool:
        if not math.isfinite(left_j) or not math.isfinite(right_j):
            return False
        delta = abs(left_j - right_j)
        allowed = self.atol_j + self.rtol * max(abs(left_j), abs(right_j))
        return delta <= allowed


@dataclass(frozen=True)
class MixedP1QualificationContract:
    mesh_energy: EnergyComparisonTolerance
    airbox_energy: EnergyComparisonTolerance
    operator_energy: EnergyComparisonTolerance
    fixed_finest_dt_pair_s: tuple[float, float]
    adaptive_finest_max_err_pair: tuple[float, float]
    component_rms_max: float
    component_p99_max: float
    component_endpoint_max: float
    crossing_delta_max_s: float
    energy_trajectory_relative_rms_max: float
    temporal_energy_endpoint: EnergyComparisonTolerance

    def __post_init__(self) -> None:
        for name, tolerance in (
            ("mesh_energy", self.mesh_energy),
            ("airbox_energy", self.airbox_energy),
            ("operator_energy", self.operator_energy),
            ("temporal_energy_endpoint", self.temporal_energy_endpoint),
        ):
            if not isinstance(tolerance, EnergyComparisonTolerance):
                raise TypeError(f"{name} must be EnergyComparisonTolerance")
        for name, pair in (
            ("fixed_finest_dt_pair_s", self.fixed_finest_dt_pair_s),
            ("adaptive_finest_max_err_pair", self.adaptive_finest_max_err_pair),
        ):
            if not isinstance(pair, tuple):
                raise TypeError(f"{name} must be an immutable tuple")
            if (
                len(pair) != 2
                or not all(math.isfinite(value) and value > 0.0 for value in pair)
                or pair[0] <= pair[1]
            ):
                raise ValueError(
                    f"{name} must contain exactly two finite positive values "
                    "ordered coarser to finer"
                )
        for name, value in (
            ("component_rms_max", self.component_rms_max),
            ("component_p99_max", self.component_p99_max),
            ("component_endpoint_max", self.component_endpoint_max),
            ("crossing_delta_max_s", self.crossing_delta_max_s),
            (
                "energy_trajectory_relative_rms_max",
                self.energy_trajectory_relative_rms_max,
            ),
        ):
            if not math.isfinite(value) or value < 0.0:
                raise ValueError(f"{name} must be finite and nonnegative")

    def temporal_accepts(
        self,
        *,
        component_rms: tuple[float, float, float],
        component_p99: tuple[float, float, float],
        component_endpoint: tuple[float, float, float],
        crossing_delta_s: float,
        energy_relative_rms: tuple[float, float, float],
        energy_endpoint_pairs_j: tuple[
            tuple[float, float], tuple[float, float], tuple[float, float]
        ],
    ) -> bool:
        triplets = (
            component_rms,
            component_p99,
            component_endpoint,
            energy_relative_rms,
            energy_endpoint_pairs_j,
        )
        if any(len(values) != 3 for values in triplets):
            return False
        if any(len(pair) != 2 for pair in energy_endpoint_pairs_j):
            return False
        bounded_metrics = (
            (component_rms, self.component_rms_max),
            (component_p99, self.component_p99_max),
            (component_endpoint, self.component_endpoint_max),
            (energy_relative_rms, self.energy_trajectory_relative_rms_max),
        )
        if any(
            not all(math.isfinite(value) and 0.0 <= value <= limit for value in values)
            for values, limit in bounded_metrics
        ):
            return False
        if not math.isfinite(crossing_delta_s) or abs(crossing_delta_s) > self.crossing_delta_max_s:
            return False
        return all(
            self.temporal_energy_endpoint.accepts(left_j, right_j)
            for left_j, right_j in energy_endpoint_pairs_j
        )


@dataclass(frozen=True)
class SP4Contract:
    dimensions_m: tuple[float, float, float]
    ms_a_per_m: float
    aex_j_per_m: float
    alpha: float
    gamma_mu0_m_per_as: float
    initial_m: tuple[float, float, float]
    sample_period_s: float
    minimum_duration_s: float
    equilibrium_window_s: float
    maximum_duration_s: float
    cases: tuple[SP4Case, ...]
    meshes: tuple[MeshLevel, ...]
    airboxes: tuple[AirboxVariant, ...]

    def __post_init__(self):
        if any(value <= 0 for value in self.dimensions_m):
            raise ValueError("SP4 dimensions must be positive")
        for group in (self.cases, self.meshes, self.airboxes):
            ids = [item.id for item in group]
            if len(ids) != len(set(ids)):
                raise ValueError("SP4 identifiers must be unique")
        if not math.isclose(sum(x * x for x in self.initial_m), 1.0, abs_tol=1e-14):
            raise ValueError("initial magnetization must be normalized")


CONTRACT = SP4Contract(
    dimensions_m=(500e-9, 125e-9, 3e-9),
    ms_a_per_m=8e5,
    aex_j_per_m=1.3e-11,
    alpha=0.02,
    gamma_mu0_m_per_as=2.211e5,
    initial_m=(1.0 / math.sqrt(1.01), 0.1 / math.sqrt(1.01), 0.0),
    sample_period_s=1e-12,
    minimum_duration_s=1e-9,
    equilibrium_window_s=50e-12,
    maximum_duration_s=5e-9,
    cases=(
        SP4Case("case-a", (-24.6e-3, 4.3e-3, 0.0)),
        SP4Case("case-b", (-35.5e-3, -6.3e-3, 0.0)),
    ),
    meshes=(MeshLevel("coarse", 3e-9), MeshLevel("medium", 2e-9), MeshLevel("fine", 1.5e-9)),
    airboxes=(
        AirboxVariant("baseline", (700e-9, 250e-9, 250e-9), 20e-9),
        AirboxVariant("expanded", (1000e-9, 500e-9, 500e-9), 20e-9),
    ),
)


MIXED_P1_QUALIFICATION = MixedP1QualificationContract(
    mesh_energy=EnergyComparisonTolerance(atol_j=2e-19, rtol=2e-2),
    airbox_energy=EnergyComparisonTolerance(atol_j=1e-19, rtol=1e-2),
    operator_energy=EnergyComparisonTolerance(atol_j=1e-30, rtol=1e-6),
    fixed_finest_dt_pair_s=(2e-14, 1e-14),
    adaptive_finest_max_err_pair=(1e-6, 1e-7),
    component_rms_max=0.01,
    component_p99_max=0.03,
    component_endpoint_max=0.01,
    crossing_delta_max_s=5e-12,
    energy_trajectory_relative_rms_max=0.01,
    temporal_energy_endpoint=EnergyComparisonTolerance(atol_j=1e-19, rtol=1e-2),
)


def validate_device(device: str) -> str:
    if device not in {"cpu", "gpu"}:
        raise ValueError(f"unsupported SP4 device: {device}")
    return device
