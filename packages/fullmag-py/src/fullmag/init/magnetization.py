from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Sequence, TypeAlias

from fullmag._validation import as_vector3, require_positive_int


@dataclass(frozen=True, slots=True)
class UniformMagnetization:
    value: tuple[float, float, float]

    def __init__(self, value: Sequence[float]) -> None:
        object.__setattr__(self, "value", as_vector3(value, "value"))

    def to_ir(self) -> dict[str, object]:
        return {"kind": "uniform", "value": list(self.value)}


@dataclass(frozen=True, slots=True)
class RandomMagnetization:
    seed: int

    def __post_init__(self) -> None:
        object.__setattr__(self, "seed", require_positive_int(self.seed, "seed"))

    def to_ir(self) -> dict[str, object]:
        return {"kind": "random_seeded", "seed": self.seed}


@dataclass(frozen=True, slots=True)
class SampledMagnetization:
    values: list[tuple[float, float, float]]

    def __init__(self, values: Sequence[Sequence[float]]) -> None:
        if not values:
            raise ValueError("values must not be empty")
        object.__setattr__(self, "values", [as_vector3(value, "values") for value in values])

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "sampled_field",
            "values": [list(value) for value in self.values],
        }


InitialMagnetization: TypeAlias = UniformMagnetization | RandomMagnetization | SampledMagnetization


def uniform(value: Sequence[float]) -> UniformMagnetization:
    return UniformMagnetization(value)


def random(seed: int) -> RandomMagnetization:
    return RandomMagnetization(seed=seed)


def from_function(
    fn: Callable[[tuple[float, float, float]], Sequence[float]],
    sample_points: Sequence[Sequence[float]] | None = None,
) -> SampledMagnetization:
    del fn, sample_points
    raise NotImplementedError(
        "fm.init.from_function is deferred to a later phase once canonical sample-point lowering is defined"
    )
