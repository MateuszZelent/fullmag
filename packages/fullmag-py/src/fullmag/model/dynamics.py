from __future__ import annotations

from dataclasses import dataclass

from fullmag._validation import require_positive

DEFAULT_GAMMA = 2.211e5
SUPPORTED_INTEGRATORS = {"heun", "rk4", "rk23", "rk45", "abm3", "auto"}

# Canonical aliases: user-facing name → algorithm family.
# rk45 = Dormand-Prince 5(4), rk23 = Bogacki-Shampine 3(2).
INTEGRATOR_ALIASES: dict[str, str] = {
    "dp54": "rk45",
    "bs23": "rk23",
}

# Integrators that support embedded error estimation (adaptive step).
ADAPTIVE_INTEGRATORS = {"rk23", "rk45"}


@dataclass(frozen=True, slots=True)
class AdaptiveTimestep:
    """Controls for embedded-error adaptive time stepping (RK23, RK45)."""

    atol: float = 1e-6
    rtol: float = 1e-3
    dt_initial: float | None = None
    dt_min: float = 1e-16
    dt_max: float | None = None
    safety: float = 0.9
    growth_limit: float = 2.0
    shrink_limit: float = 0.2
    max_spin_rotation: float | None = None
    norm_tolerance: float | None = None

    def __post_init__(self) -> None:
        require_positive(self.atol, "atol")
        require_positive(self.rtol, "rtol")
        if self.dt_initial is not None:
            require_positive(self.dt_initial, "dt_initial")
        require_positive(self.dt_min, "dt_min")
        if self.dt_max is not None:
            require_positive(self.dt_max, "dt_max")
            if self.dt_max < self.dt_min:
                raise ValueError("dt_max must be >= dt_min")
        if not (0.0 < self.safety <= 1.0):
            raise ValueError("safety must be in (0, 1]")
        if self.growth_limit <= 1.0:
            raise ValueError("growth_limit must be > 1")
        if not (0.0 < self.shrink_limit < 1.0):
            raise ValueError("shrink_limit must be in (0, 1)")
        if self.max_spin_rotation is not None:
            require_positive(self.max_spin_rotation, "max_spin_rotation")
        if self.norm_tolerance is not None:
            require_positive(self.norm_tolerance, "norm_tolerance")

    def to_ir(self) -> dict[str, object]:
        d: dict[str, object] = {
            "atol": self.atol,
            "rtol": self.rtol,
            "dt_min": self.dt_min,
            "safety": self.safety,
            "growth_limit": self.growth_limit,
            "shrink_limit": self.shrink_limit,
        }
        if self.dt_initial is not None:
            d["dt_initial"] = self.dt_initial
        if self.dt_max is not None:
            d["dt_max"] = self.dt_max
        if self.max_spin_rotation is not None:
            d["max_spin_rotation"] = self.max_spin_rotation
        if self.norm_tolerance is not None:
            d["norm_tolerance"] = self.norm_tolerance
        return d


@dataclass(frozen=True, slots=True)
class LLG:
    gamma: float = DEFAULT_GAMMA
    integrator: str = "auto"
    fixed_timestep: float | None = None
    adaptive_timestep: AdaptiveTimestep | None = None

    def __post_init__(self) -> None:
        require_positive(self.gamma, "gamma")
        # Resolve alias before validation.
        canonical = INTEGRATOR_ALIASES.get(self.integrator, self.integrator)
        if canonical != self.integrator:
            object.__setattr__(self, "integrator", canonical)
        if self.integrator not in SUPPORTED_INTEGRATORS:
            supported = ", ".join(sorted(SUPPORTED_INTEGRATORS))
            raise ValueError(f"integrator must be one of: {supported}")
        if self.fixed_timestep is not None:
            require_positive(self.fixed_timestep, "fixed_timestep")
        if self.adaptive_timestep is not None and self.fixed_timestep is not None:
            raise ValueError(
                "adaptive_timestep and fixed_timestep are mutually exclusive"
            )
        if (
            self.adaptive_timestep is not None
            and self.integrator not in ADAPTIVE_INTEGRATORS
            and self.integrator != "auto"
        ):
            raise ValueError(
                f"adaptive_timestep requires an adaptive integrator "
                f"({', '.join(sorted(ADAPTIVE_INTEGRATORS))}), got '{self.integrator}'"
            )

    def to_ir(self) -> dict[str, object]:
        d: dict[str, object] = {
            "kind": "llg",
            "gyromagnetic_ratio": self.gamma,
            "integrator": self.integrator,
            "fixed_timestep": self.fixed_timestep,
        }
        if self.adaptive_timestep is not None:
            d["adaptive_timestep"] = self.adaptive_timestep.to_ir()
        return d
