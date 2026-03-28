from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

from fullmag.model.dynamics import LLG
from fullmag.model.outputs import SaveField, SaveScalar, Snapshot
from fullmag._validation import require_positive

OutputSpec = SaveField | SaveScalar | Snapshot
SUPPORTED_RELAXATION_ALGORITHMS = {
    "llg_overdamped",
    "projected_gradient_bb",
    "nonlinear_cg",
    "tangent_plane_implicit",
}


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

    outputs: Sequence[OutputSpec]
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
