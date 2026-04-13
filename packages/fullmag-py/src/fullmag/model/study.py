from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

from fullmag.model.dynamics import LLG
from fullmag.model.eigen import ModeTracking, coerce_k_sampling
from fullmag.model.outputs import (
    SaveDispersion,
    SaveEigenDiagnostics,
    SaveField,
    SaveMode,
    SaveScalar,
    SaveSpectrum,
    Snapshot,
)
from fullmag._validation import require_non_empty, require_positive

TimeOutputSpec = SaveField | SaveScalar | Snapshot
EigenOutputSpec = SaveSpectrum | SaveMode | SaveDispersion | SaveEigenDiagnostics
OutputSpec = TimeOutputSpec | EigenOutputSpec
SUPPORTED_RELAXATION_ALGORITHMS = {
    "llg_overdamped",
    "projected_gradient_bb",
    "nonlinear_cg",
    "tangent_plane_implicit",
}
SUPPORTED_EIGEN_OPERATORS = {"linearized_llg", "full_2x2"}
SUPPORTED_EIGEN_TARGETS = {"lowest", "nearest"}
SUPPORTED_EQUILIBRIUM_SOURCES = {"provided", "relax", "artifact"}
SUPPORTED_EIGEN_NORMALIZATIONS = {"unit_l2", "unit_max_amplitude"}
SUPPORTED_EIGEN_DAMPING_POLICIES = {"ignore", "include"}
SUPPORTED_SPIN_WAVE_BCS = {"free", "pinned", "periodic", "floquet", "surface_anisotropy"}


@dataclass(frozen=True, slots=True)
class TimeEvolution:
    dynamics: LLG
    outputs: Sequence[TimeOutputSpec]

    def __post_init__(self) -> None:
        if not self.outputs:
            raise ValueError("TimeEvolution requires at least one output")

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "time_evolution",
            "dynamics": self.dynamics.to_ir(),
            "sampling": {"outputs": [output.to_ir() for output in self.outputs]},
        }


@dataclass(frozen=True, slots=True)
class Relaxation:
    """Energy minimization study that drives the system toward a (meta)stable
    equilibrium satisfying m × H_eff ≈ 0 under the constraint |m| = 1.

    Three algorithms are implemented (see ``docs/physics/0500-fdm-relaxation-algorithms.md``):

    * ``"llg_overdamped"`` — damping-only Landau–Lifshitz–Gilbert relaxation.
      Reuses the LLG pipeline but disables precession during relax(), matching
      the expected mumax-style semantics. Convergence speed still depends on
      damping and time step, but a large ``alpha`` is not required just to
      suppress orbiting.

    * ``"projected_gradient_bb"`` — projected steepest descent with
      Barzilai–Borwein step selection on the sphere product manifold.  Uses
      alternating BB1/BB2 step sizes with Armijo backtracking line search.
      Typically faster than overdamped LLG for smooth energy landscapes.

    * ``"nonlinear_cg"`` — nonlinear conjugate gradient (Polak–Ribière+) with
      tangent-space vector transport, periodic restarts every 50 iterations,
      and Armijo backtracking.  Generally the fastest for large-scale problems.

    * ``"tangent_plane_implicit"`` — FEM-only linearly implicit tangent-plane
      relaxation.  Not yet executable; reserved for future FEM production use.

    Parameters
    ----------
    outputs : Sequence[OutputSpec]
        Output specifications (fields and/or scalars) to record.
        At least one output is required.
    algorithm : str, default ``"llg_overdamped"``
        Relaxation algorithm identifier.  Must be one of the strings listed
        above.
    torque_tolerance : float, default ``1e-4``
        Maximum torque convergence threshold in A/m.
        The algorithm stops when max_i |m_i × H_eff,i| ≤ torque_tolerance.
    energy_tolerance : float or None, default ``None``
        Optional energy-change convergence threshold in Joules.  When set,
        convergence requires *both* torque and energy criteria to be met.
    max_steps : int, default ``50_000``
        Hard cap on the number of iterations.  The algorithm stops
        unconditionally after this many steps, regardless of convergence.
    dynamics : LLG, default ``LLG()``
        LLG parameters (damping, gyromagnetic ratio).  Used by the
        ``"llg_overdamped"`` algorithm and for material parameter specification
        in all algorithms.
    """

    outputs: Sequence[TimeOutputSpec]
    algorithm: str = "llg_overdamped"
    torque_tolerance: float = 1e-4
    energy_tolerance: float | None = None
    max_steps: int = 50_000
    dynamics: LLG = field(default_factory=LLG)

    def __post_init__(self) -> None:
        if not self.outputs:
            raise ValueError("Relaxation requires at least one output")
        if self.algorithm not in SUPPORTED_RELAXATION_ALGORITHMS:
            supported = ", ".join(sorted(SUPPORTED_RELAXATION_ALGORITHMS))
            raise ValueError(f"algorithm must be one of: {supported}")
        require_positive(self.torque_tolerance, "torque_tolerance")
        if self.energy_tolerance is not None:
            require_positive(self.energy_tolerance, "energy_tolerance")
        if self.max_steps <= 0:
            raise ValueError("max_steps must be positive")

    def to_ir(self) -> dict[str, object]:
        """Serialize to ProblemIR-compatible dictionary."""
        return {
            "kind": "relaxation",
            "algorithm": self.algorithm,
            "dynamics": self.dynamics.to_ir(),
            "torque_tolerance": self.torque_tolerance,
            "energy_tolerance": self.energy_tolerance,
            "max_steps": self.max_steps,
            "sampling": {"outputs": [output.to_ir() for output in self.outputs]},
        }


@dataclass(frozen=True, slots=True)
class Eigenmodes:
    outputs: Sequence[EigenOutputSpec]
    count: int = 20
    target: str = "lowest"
    target_frequency: float | None = None
    operator: str = "linearized_llg"
    equilibrium_source: str = "provided"
    equilibrium_artifact: str | None = None
    include_demag: bool = True
    k_sampling: object | None = None
    k_vector: tuple[float, float, float] | None = None
    mode_tracking: ModeTracking | None = None
    normalization: str = "unit_l2"
    damping_policy: str = "ignore"
    spin_wave_bc: str | dict[str, object] = "free"
    dynamics: LLG = field(default_factory=LLG)

    def __post_init__(self) -> None:
        if not self.outputs:
            raise ValueError("Eigenmodes requires at least one output")
        if self.count <= 0:
            raise ValueError("count must be positive")
        if self.operator not in SUPPORTED_EIGEN_OPERATORS:
            supported = ", ".join(sorted(SUPPORTED_EIGEN_OPERATORS))
            raise ValueError(f"operator must be one of: {supported}")
        if self.target not in SUPPORTED_EIGEN_TARGETS:
            supported = ", ".join(sorted(SUPPORTED_EIGEN_TARGETS))
            raise ValueError(f"target must be one of: {supported}")
        if self.target == "nearest":
            require_positive(self.target_frequency, "target_frequency")
        elif self.target_frequency is not None:
            require_positive(self.target_frequency, "target_frequency")
        if self.equilibrium_source not in SUPPORTED_EQUILIBRIUM_SOURCES:
            supported = ", ".join(sorted(SUPPORTED_EQUILIBRIUM_SOURCES))
            raise ValueError(f"equilibrium_source must be one of: {supported}")
        if self.equilibrium_source == "artifact":
            if self.equilibrium_artifact is None:
                raise ValueError("equilibrium_artifact is required when equilibrium_source='artifact'")
            object.__setattr__(
                self,
                "equilibrium_artifact",
                require_non_empty(self.equilibrium_artifact, "equilibrium_artifact"),
            )
        elif self.equilibrium_artifact is not None:
            object.__setattr__(
                self,
                "equilibrium_artifact",
                require_non_empty(self.equilibrium_artifact, "equilibrium_artifact"),
            )
        if self.normalization not in SUPPORTED_EIGEN_NORMALIZATIONS:
            supported = ", ".join(sorted(SUPPORTED_EIGEN_NORMALIZATIONS))
            raise ValueError(f"normalization must be one of: {supported}")
        if self.damping_policy not in SUPPORTED_EIGEN_DAMPING_POLICIES:
            supported = ", ".join(sorted(SUPPORTED_EIGEN_DAMPING_POLICIES))
            raise ValueError(f"damping_policy must be one of: {supported}")
        if isinstance(self.spin_wave_bc, str):
            if self.spin_wave_bc not in SUPPORTED_SPIN_WAVE_BCS:
                supported = ", ".join(sorted(SUPPORTED_SPIN_WAVE_BCS))
                raise ValueError(f"spin_wave_bc must be one of: {supported}")
        elif isinstance(self.spin_wave_bc, dict):
            kind = self.spin_wave_bc.get("kind")
            if kind not in SUPPORTED_SPIN_WAVE_BCS:
                supported = ", ".join(sorted(SUPPORTED_SPIN_WAVE_BCS))
                raise ValueError(f"spin_wave_bc.kind must be one of: {supported}")
        else:
            raise ValueError("spin_wave_bc must be a string or a mapping")
        # Validate alias / primary representation early to fail loudly.
        coerce_k_sampling(k_sampling=self.k_sampling, legacy_k_vector=self.k_vector)

    def to_ir(self) -> dict[str, object]:
        target: dict[str, object]
        if self.target == "nearest":
            target = {"kind": "nearest", "frequency_hz": self.target_frequency}
        else:
            target = {"kind": "lowest"}

        equilibrium: dict[str, object]
        if self.equilibrium_source == "artifact":
            equilibrium = {
                "kind": "artifact",
                "path": self.equilibrium_artifact,
            }
        elif self.equilibrium_source == "relax":
            equilibrium = {"kind": "relaxed_initial_state"}
        else:
            equilibrium = {"kind": "provided"}

        payload: dict[str, object] = {
            "kind": "eigenmodes",
            "dynamics": self.dynamics.to_ir(),
            "operator": {
                "kind": self.operator,
                "include_demag": self.include_demag,
            },
            "count": self.count,
            "target": target,
            "equilibrium": equilibrium,
            "k_sampling": coerce_k_sampling(
                k_sampling=self.k_sampling,
                legacy_k_vector=self.k_vector,
            ),
            "normalization": self.normalization,
            "damping_policy": self.damping_policy,
            "spin_wave_bc": self.spin_wave_bc,
            "sampling": {"outputs": [output.to_ir() for output in self.outputs]},
        }
        if self.mode_tracking is not None:
            payload["mode_tracking"] = self.mode_tracking.to_ir()
        return payload


@dataclass(frozen=True, slots=True)
class FrequencyResponse:
    outputs: Sequence[EigenOutputSpec]
    frequencies_hz: Sequence[float]
    excitation_field_au_per_m: tuple[float, float, float] = (0.0, 0.0, 1.0)
    operator: str = "linearized_llg"
    equilibrium_source: str = "provided"
    equilibrium_artifact: str | None = None
    include_demag: bool = True
    k_sampling: object | None = None
    k_vector: tuple[float, float, float] | None = None
    normalization: str = "unit_l2"
    damping_policy: str = "ignore"
    spin_wave_bc: str | dict[str, object] = "free"
    dynamics: LLG = field(default_factory=LLG)

    def __post_init__(self) -> None:
        if not self.outputs:
            raise ValueError("FrequencyResponse requires at least one output")
        normalized_freqs = tuple(float(freq) for freq in self.frequencies_hz)
        if not normalized_freqs:
            raise ValueError("frequencies_hz must not be empty")
        if any(freq <= 0.0 for freq in normalized_freqs):
            raise ValueError("frequencies_hz must contain positive values only")
        object.__setattr__(self, "frequencies_hz", normalized_freqs)
        coerce_k_sampling(k_sampling=self.k_sampling, legacy_k_vector=self.k_vector)

    def to_ir(self) -> dict[str, object]:
        equilibrium: dict[str, object]
        if self.equilibrium_source == "artifact":
            equilibrium = {"kind": "artifact", "path": self.equilibrium_artifact}
        elif self.equilibrium_source == "relax":
            equilibrium = {"kind": "relaxed_initial_state"}
        else:
            equilibrium = {"kind": "provided"}
        return {
            "kind": "frequency_response",
            "dynamics": self.dynamics.to_ir(),
            "operator": {
                "kind": self.operator,
                "include_demag": self.include_demag,
            },
            "equilibrium": equilibrium,
            "k_sampling": coerce_k_sampling(
                k_sampling=self.k_sampling,
                legacy_k_vector=self.k_vector,
            ),
            "normalization": self.normalization,
            "damping_policy": self.damping_policy,
            "spin_wave_bc": self.spin_wave_bc,
            "excitation": {"field_au_per_m": list(self.excitation_field_au_per_m)},
            "frequencies_hz": {"values_hz": list(self.frequencies_hz)},
            "sampling": {"outputs": [output.to_ir() for output in self.outputs]},
        }
