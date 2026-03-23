from __future__ import annotations

from dataclasses import dataclass

from fullmag._validation import require_positive

DEFAULT_GAMMA = 2.211e5
SUPPORTED_INTEGRATORS = {"heun"}


@dataclass(frozen=True, slots=True)
class LLG:
    gamma: float = DEFAULT_GAMMA
    integrator: str = "heun"
    fixed_timestep: float | None = None

    def __post_init__(self) -> None:
        require_positive(self.gamma, "gamma")
        if self.integrator not in SUPPORTED_INTEGRATORS:
            supported = ", ".join(sorted(SUPPORTED_INTEGRATORS))
            raise ValueError(f"integrator must be one of: {supported}")
        if self.fixed_timestep is not None:
            require_positive(self.fixed_timestep, "fixed_timestep")

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "llg",
            "gyromagnetic_ratio": self.gamma,
            "integrator": self.integrator,
            "fixed_timestep": self.fixed_timestep,
        }
