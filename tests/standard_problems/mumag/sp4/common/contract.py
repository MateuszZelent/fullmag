"""Canonical SI contract for NIST µMAG Standard Problem 4."""

from dataclasses import dataclass
import math


DEFAULT_RELAXATION_ALGORITHM = "llg_overdamped"


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


def validate_device(device: str) -> str:
    if device not in {"cpu", "gpu"}:
        raise ValueError(f"unsupported SP4 device: {device}")
    return device
