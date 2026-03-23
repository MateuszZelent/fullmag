from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from fullmag.model import BackendTarget, ExecutionMode, Problem


@dataclass(frozen=True, slots=True)
class Result:
    status: str
    backend: BackendTarget
    mode: ExecutionMode
    notes: Sequence[str]


@dataclass(slots=True)
class Simulation:
    problem: Problem
    backend: BackendTarget | str = BackendTarget.AUTO
    mode: ExecutionMode | str = ExecutionMode.STRICT

    def __post_init__(self) -> None:
        self.backend = BackendTarget(self.backend)
        self.mode = ExecutionMode(self.mode)
        if self.backend is BackendTarget.HYBRID and self.mode is not ExecutionMode.HYBRID:
            raise ValueError("backend='hybrid' requires mode='hybrid'")
        if self.mode is ExecutionMode.HYBRID and self.backend is not BackendTarget.HYBRID:
            raise ValueError("mode='hybrid' requires backend='hybrid'")

    def to_ir(self, *, script_source: str | None = None, entrypoint_kind: str = "direct") -> dict[str, object]:
        return self.problem.to_ir(
            requested_backend=self.backend,
            execution_mode=self.mode,
            script_source=script_source,
            entrypoint_kind=entrypoint_kind,
        )

    def plan(self) -> Result:
        return Result(
            status="planned",
            backend=self.backend,
            mode=self.mode,
            notes=[
                "Public script lowering is still planning-only.",
                "The internal reference LLG + exchange engine exists in Rust but is not wired to Simulation.run() yet.",
            ],
        )

    def run(self, *, until: float | None = None) -> Result:
        notes = [
            "Public script lowering is still planning-only.",
            "The internal reference LLG + exchange engine exists in Rust but is not wired to Simulation.run() yet.",
        ]
        if until is not None:
            notes = [*notes, f"Requested stop time: {until} s"]
        return Result(status="planned", backend=self.backend, mode=self.mode, notes=notes)
