from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from fullmag._validation import as_vector3, require_positive


@dataclass(frozen=True, slots=True)
class Exchange:
    def to_ir(self) -> dict[str, object]:
        return {"kind": "exchange"}


@dataclass(frozen=True, slots=True)
class Demag:
    realization: str | None = None

    def __post_init__(self) -> None:
        allowed = (None, "auto", "transfer_grid", "poisson_airbox")
        if self.realization not in allowed:
            raise ValueError(
                f"Demag realization must be one of {allowed!r}, got {self.realization!r}"
            )

    def to_ir(self) -> dict[str, object]:
        ir: dict[str, object] = {"kind": "demag"}
        if self.realization is not None:
            ir["realization"] = self.realization
        return ir


@dataclass(frozen=True, slots=True)
class InterfacialDMI:
    D: float

    def __post_init__(self) -> None:
        require_positive(self.D, "D")

    def to_ir(self) -> dict[str, object]:
        return {"kind": "interfacial_dmi", "D": self.D}


@dataclass(frozen=True, slots=True)
class Zeeman:
    B: tuple[float, float, float]

    def __init__(self, B: Sequence[float]) -> None:
        object.__setattr__(self, "B", as_vector3(B, "B"))

    def to_ir(self) -> dict[str, object]:
        return {"kind": "zeeman", "B": list(self.B)}
