from __future__ import annotations

import inspect
from dataclasses import dataclass, field

from fullmag._validation import require_non_negative, require_positive

DEFAULT_GAMMA = 2.211e5
SUPPORTED_INTEGRATORS = {
    "heun",
    "rk4",
    "rk23",
    "rk45",
    "abm3",
    "coupled_imex_ark2",
    "auto",
}

# Canonical aliases: user-facing name → algorithm family.
# rk45 = Dormand-Prince 5(4), rk23 = Bogacki-Shampine 3(2).
INTEGRATOR_ALIASES: dict[str, str] = {
    "dp54": "rk45",
    "bs23": "rk23",
}

# Integrators that support embedded error estimation (adaptive step).
ADAPTIVE_INTEGRATORS = {"rk23", "rk45", "coupled_imex_ark2"}


class _AdaptiveTimestepType(type):
    @property
    def __signature__(cls) -> inspect.Signature:
        parameters = tuple(inspect.signature(cls.__init__).parameters.values())[1:]
        return inspect.Signature(parameters)

    def __call__(cls, *args: object, **kwargs: object) -> object:
        dt_min_explicit = "dt_min" in kwargs or len(args) >= 4
        policy = super().__call__(*args, **kwargs)
        object.__setattr__(policy, "_dt_min_explicit", dt_min_explicit)
        return policy


@dataclass(frozen=True, slots=True)
class AdaptiveTimestep(metaclass=_AdaptiveTimestepType):
    """Controls for RK23/RK45 embedded error or coupled ARS step doubling.

    ``coupled_imex_ark2`` compares one full coupled step with two half steps,
    scales their complete physical-state difference by ``1 / 3``, and accepts
    the more accurate two-half-step candidate when the normalized error is at
    most one.
    """

    atol: float = 1e-6
    rtol: float = 1e-3
    dt_initial: float | None = None
    dt_min: float = 1e-15
    dt_max: float | None = None
    safety: float = 0.9
    growth_limit: float = 2.0
    shrink_limit: float = 0.2
    max_spin_rotation: float | None = None
    norm_tolerance: float | None = None
    _tolerance_mode: str = field(
        default="advanced", init=False, repr=False, compare=False
    )
    _dt_min_explicit: bool = field(
        default=False, init=False, repr=False, compare=False
    )

    @classmethod
    def _from_max_error(
        cls,
        *,
        max_err: float,
        dt_initial: float | None = None,
        dt_min: float = 1e-15,
        dt_max: float | None = None,
    ) -> "AdaptiveTimestep":
        policy = cls(
            atol=max_err,
            rtol=0.0,
            dt_initial=dt_initial,
            dt_min=dt_min,
            dt_max=dt_max,
        )
        object.__setattr__(policy, "_tolerance_mode", "max_error")
        return policy

    def __post_init__(self) -> None:
        if self._tolerance_mode not in {"advanced", "max_error"}:
            raise ValueError("_tolerance_mode must be 'advanced' or 'max_error'")
        require_non_negative(self.atol, "atol")
        require_non_negative(self.rtol, "rtol")
        if self.atol == 0.0 and self.rtol == 0.0:
            raise ValueError("at least one of atol and rtol must be positive")
        if self.dt_initial is not None:
            require_positive(self.dt_initial, "dt_initial")
        require_positive(self.dt_min, "dt_min")
        if self.dt_max is not None:
            require_positive(self.dt_max, "dt_max")
            if self.dt_max < self.dt_min:
                raise ValueError("dt_max must be >= dt_min")
        if self.dt_initial is not None:
            if self.dt_initial < self.dt_min:
                raise ValueError("dt_initial must be >= dt_min")
            if self.dt_max is not None and self.dt_initial > self.dt_max:
                raise ValueError("dt_initial must be <= dt_max")
        if not (0.0 < self.safety <= 1.0):
            raise ValueError("safety must be in (0, 1]")
        require_positive(self.growth_limit, "growth_limit")
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
            "tolerance_mode": self._tolerance_mode,
            "atol": self.atol,
            "rtol": self.rtol,
            "dt_initial": self.dt_initial,
            "dt_min": self.dt_min,
            "safety": self.safety,
            "growth_limit": self.growth_limit,
            "shrink_limit": self.shrink_limit,
        }
        if self.dt_max is not None:
            d["dt_max"] = self.dt_max
        if self.max_spin_rotation is not None:
            d["max_spin_rotation"] = self.max_spin_rotation
        if self.norm_tolerance is not None:
            d["norm_tolerance"] = self.norm_tolerance
        return d


@dataclass(frozen=True, slots=True)
class FieldRefreshPolicy:
    """Cadence controls for expensive field/operator refreshes."""

    demag_interval_s: float | None = None

    def __post_init__(self) -> None:
        if self.demag_interval_s is not None:
            require_positive(self.demag_interval_s, "demag_interval_s")

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {}
        if self.demag_interval_s is not None:
            payload["demag_interval_s"] = self.demag_interval_s
        return payload


@dataclass(frozen=True, slots=True)
class LLG:
    gamma: float = DEFAULT_GAMMA
    integrator: str = "auto"
    fixed_timestep: float | None = None
    adaptive_timestep: AdaptiveTimestep | None = None
    field_refresh: FieldRefreshPolicy | None = None

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
        if self.field_refresh is not None:
            d["field_refresh"] = self.field_refresh.to_ir()
        return d


# ── Mechanical dynamics modes ─────────────────────────────


@dataclass(frozen=True, slots=True)
class PrescribedStrain:
    """Prescribed strain/stress mode — no mechanical solve.

    The strain or stress field is provided externally via MechanicalLoad.
    Only H_mel is computed from the given deformation state.
    """

    def to_ir(self) -> dict[str, object]:
        return {"kind": "prescribed_strain"}


@dataclass(frozen=True, slots=True)
class QuasistaticElasticity:
    """Quasistatic elasticity mode — full bidirectional coupling.

    At each LLG step, the quasistatic equilibrium ∇·σ = 0 is solved
    for the displacement field u, then H_mel is computed.

    Parameters
    ----------
    max_picard_iterations : int
        Maximum Picard iterations for nonlinear coupling (default: 3).
    picard_tolerance : float
        Convergence tolerance for Picard iterations (default: 1e-6).
    """

    max_picard_iterations: int = 3
    picard_tolerance: float = 1e-6

    def __post_init__(self) -> None:
        if self.max_picard_iterations < 1:
            raise ValueError("max_picard_iterations must be >= 1")
        require_positive(self.picard_tolerance, "picard_tolerance")

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "quasistatic_elasticity",
            "max_picard_iterations": self.max_picard_iterations,
            "picard_tolerance": self.picard_tolerance,
        }


@dataclass(frozen=True, slots=True)
class Elastodynamics:
    """Full elastodynamics mode — coupled m-u-v system.

    Parameters
    ----------
    mechanical_dt : float, optional
        Timestep for mechanical integration [s]. If None, matched to LLG dt.
    """

    mechanical_dt: float | None = None

    def __post_init__(self) -> None:
        if self.mechanical_dt is not None:
            require_positive(self.mechanical_dt, "mechanical_dt")

    def to_ir(self) -> dict[str, object]:
        d: dict[str, object] = {"kind": "elastodynamics"}
        if self.mechanical_dt is not None:
            d["mechanical_dt"] = self.mechanical_dt
        return d


MechanicsMode = PrescribedStrain | QuasistaticElasticity | Elastodynamics
