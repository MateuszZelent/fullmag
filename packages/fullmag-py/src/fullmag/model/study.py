from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from fullmag.model.dynamics import LLG
from fullmag.model.outputs import SaveField, SaveScalar

OutputSpec = SaveField | SaveScalar


@dataclass(frozen=True, slots=True)
class TimeEvolution:
    dynamics: LLG
    outputs: Sequence[OutputSpec]

    def __post_init__(self) -> None:
        if not self.outputs:
            raise ValueError("TimeEvolution requires at least one output")

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "time_evolution",
            "dynamics": self.dynamics.to_ir(),
            "sampling": {"outputs": [output.to_ir() for output in self.outputs]},
        }
