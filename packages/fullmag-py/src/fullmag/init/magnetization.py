from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Callable, Sequence, TypeAlias

from fullmag._validation import as_vector3, require_positive_int

if TYPE_CHECKING:
    from fullmag.init.textures import PresetTexture


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
        return {"kind": "random", "seed": self.seed}


@dataclass(frozen=True, slots=True)
class SampledMagnetization:
    values: list[tuple[float, float, float]]
    source_path: str | None
    source_format: str | None
    dataset: str | None
    sample_index: int | None

    def __init__(
        self,
        values: Sequence[Sequence[float]],
        *,
        source_path: str | None = None,
        source_format: str | None = None,
        dataset: str | None = None,
        sample_index: int | None = None,
    ) -> None:
        if not values:
            raise ValueError("values must not be empty")
        object.__setattr__(self, "values", [as_vector3(value, "values") for value in values])
        object.__setattr__(self, "source_path", source_path)
        object.__setattr__(self, "source_format", source_format)
        object.__setattr__(self, "dataset", dataset)
        object.__setattr__(self, "sample_index", sample_index)

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "sampled_field",
            "values": [list(value) for value in self.values],
        }


InitialMagnetization: TypeAlias = "UniformMagnetization | RandomMagnetization | SampledMagnetization | PresetTexture"


def uniform(
    value_or_x: Sequence[float] | float = None,
    y: float | None = None,
    z: float | None = None,
) -> UniformMagnetization:
    """Create a uniform magnetization initializer.

    Accepts either a 3-tuple or three positional floats::

        uniform((1, 0, 0))
        uniform(1, 0, 0)
    """
    if isinstance(value_or_x, (list, tuple)):
        return UniformMagnetization(value_or_x)
    elif value_or_x is not None and y is not None and z is not None:
        return UniformMagnetization((value_or_x, y, z))
    else:
        raise TypeError("uniform() requires 3 components: uniform(x, y, z) or uniform((x, y, z))")


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
