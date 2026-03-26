"""Flat mumax-inspired scripting API.

Provides global-state convenience functions that build a ``Problem`` internally.
Advanced users and multi-magnet problems can still use the class-based API directly.

Usage::

    import fullmag as fm

    fm.engine("fdm")
    fm.device("cuda:0")
    fm.cell(5e-9, 5e-9, 10e-9)

    layer = fm.geometry(fm.Box(1000e-9, 1000e-9, 10e-9))
    layer.Ms    = 800e3
    layer.Aex   = 13e-12
    layer.alpha = 0.5
    layer.m     = fm.uniform(1, 0, 0)

    fm.save("m", every=50e-12)
    fm.run(5e-10)

Multi-magnet example::

    py = fm.geometry(fm.Box(1000e-9, 1000e-9, 10e-9), name="py")
    py.Ms = 800e3; py.Aex = 13e-12; py.alpha = 0.5

    co = fm.geometry(fm.Box(1000e-9, 1000e-9, 5e-9).translate(0, 0, 7.5e-9), name="co")
    co.Ms = 1400e3; co.Aex = 30e-12; co.alpha = 0.02
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Sequence

from fullmag.model.energy import Demag, Exchange, InterfacialDMI, Zeeman
from fullmag.model.dynamics import DEFAULT_GAMMA, LLG
from fullmag.model.outputs import SaveField, SaveScalar
from fullmag.model.study import Relaxation, TimeEvolution
from fullmag.model.structure import Ferromagnet, Material
from fullmag.model.problem import (
    BackendTarget,
    DeviceTarget,
    DiscretizationHints,
    ExecutionMode,
    ExecutionPrecision,
    Problem,
    RuntimeSelection,
)
from fullmag.model.discretization import FDM, FEM


# ---------------------------------------------------------------------------
# Magnet handle — returned by fm.geometry()
# ---------------------------------------------------------------------------

class MagnetHandle:
    """Per-magnet configuration handle.

    Returned by ``fm.geometry()``. Assign material properties directly::

        layer = fm.geometry(fm.Box(1e-6, 1e-6, 1e-8))
        layer.Ms    = 800e3
        layer.Aex   = 13e-12
        layer.alpha = 0.5
        layer.m     = fm.uniform(1, 0, 0)
    """

    def __init__(self, shape: object, name: str = "body") -> None:
        self._shape = shape
        self._name = name
        self.Ms: float | None = None
        self.Aex: float | None = None
        self.alpha: float = 0.01
        self.Dind: float | None = None
        self.m: Any = None

    def __repr__(self) -> str:
        return f"MagnetHandle({self._name!r}, Ms={self.Ms}, Aex={self.Aex})"

    def _to_ferromagnet(self) -> Ferromagnet:
        """Convert to class-based Ferromagnet."""
        if self.Ms is None:
            raise ValueError(f"Magnet '{self._name}': Ms not set")
        if self.Aex is None:
            raise ValueError(f"Magnet '{self._name}': Aex not set")

        mat = Material(
            name=f"mat_{self._name}",
            Ms=self.Ms,
            A=self.Aex,
            alpha=self.alpha,
        )

        if self.m is None:
            from fullmag.init.magnetization import UniformMagnetization
            m0 = UniformMagnetization((1, 0, 0))
        else:
            m0 = self.m

        # Give geometry a unique name based on magnet handle name to
        # prevent collisions in multi-magnet problems.
        geom = self._shape
        if hasattr(geom, "name"):
            import copy
            geom = copy.copy(geom)
            object.__setattr__(geom, "name", f"{self._name}_geom")

        return Ferromagnet(
            name=self._name,
            geometry=geom,
            material=mat,
            m0=m0,
        )


# ---------------------------------------------------------------------------
# World state singleton
# ---------------------------------------------------------------------------

@dataclass
class _WorldState:
    """Mutable accumulator for the flat API — one per script."""

    # Engine
    _backend: str = "auto"
    _device: str = "auto"
    _gpu_count: int = 0
    _device_index: int | None = None

    # Grid
    _cell: tuple[float, float, float] | None = None
    _hmax: float | None = None
    _fem_order: int = 1

    # Magnets (ordered)
    _magnets: list[MagnetHandle] = field(default_factory=list)

    # External field
    _b_ext: tuple[float, float, float] | None = None

    # Solver
    _dt: float | None = None
    _max_error: float | None = None
    _integrator: str | None = None
    _gamma: float | None = None
    _interactive: bool = False

    # Outputs
    _outputs: list = field(default_factory=list)

    # Problem name
    _name: str = "fullmag_sim"


# Module-level singleton
_state = _WorldState()
_capture_enabled = False


@dataclass(frozen=True, slots=True)
class CapturedStage:
    problem: Problem
    entrypoint_kind: str
    default_until_seconds: float | None = None


_captured_stages: list[CapturedStage] = []

_MU_0 = 4.0e-7 * math.pi
_MU_B = 9.274_010_078_3e-24
_HBAR = 1.054_571_817e-34


def _gamma_from_g_factor(g_factor: float) -> float:
    return _MU_0 * g_factor * (_MU_B / _HBAR)


def reset() -> None:
    """Reset world state to defaults (useful between scripts)."""
    global _state
    _state = _WorldState()


def begin_script_capture() -> None:
    """Enable loader capture mode for flat scripts."""
    global _capture_enabled, _captured_stages
    reset()
    _capture_enabled = True
    _captured_stages = []


def finish_script_capture() -> list[CapturedStage]:
    """Return captured flat-script execution data and clear capture mode."""
    global _capture_enabled, _captured_stages
    captured = list(_captured_stages)
    _capture_enabled = False
    _captured_stages = []
    reset()
    return captured


# ---------------------------------------------------------------------------
# Engine / backend
# ---------------------------------------------------------------------------

def engine(backend: str) -> None:
    """Set computation backend: ``"fdm"``, ``"fem"``, or ``"auto"``."""
    _state._backend = backend.lower()


def device(spec: str) -> None:
    """Set device: ``"cpu"``, ``"cuda:0"``, ``"cuda:1"``, ``"gpu"``.

    Examples::

        fm.device("cpu")
        fm.device("cuda:0")
        fm.device("cuda:1")
    """
    spec = spec.lower()
    if spec == "cpu":
        _state._device = "cpu"
        _state._gpu_count = 0
        _state._device_index = None
    elif spec.startswith("cuda"):
        _state._device = "cuda"
        parts = spec.split(":")
        if len(parts) > 1:
            _state._device_index = int(parts[1])
        _state._gpu_count = 1
    elif spec == "gpu":
        _state._device = "gpu"
        _state._gpu_count = 1
    else:
        _state._device = spec


def cell(dx: float, dy: float, dz: float) -> None:
    """Set FDM cell size in meters."""
    _state._cell = (dx, dy, dz)


def hmax(val: float) -> None:
    """Set FEM maximum element size in meters."""
    _state._hmax = val


def fem_order(order: int) -> None:
    """Set FEM element order (1 or 2)."""
    _state._fem_order = order


def interactive(enabled: bool = True) -> None:
    """Request that the launcher keep the session open after the run.

    This is the script-owned counterpart of ``fullmag -i``.
    """
    _state._interactive = bool(enabled)


# ---------------------------------------------------------------------------
# Geometry → MagnetHandle
# ---------------------------------------------------------------------------

def geometry(shape: object, name: str = "body") -> MagnetHandle:
    """Register a magnet and return its configuration handle.

    Returns a ``MagnetHandle`` on which to set material parameters::

        layer = fm.geometry(fm.Box(1e-6, 1e-6, 1e-8), name="py")
        layer.Ms  = 800e3
        layer.Aex = 13e-12

    Multiple calls register multiple magnets.
    """
    handle = MagnetHandle(shape, name)
    _state._magnets.append(handle)
    return handle


# ---------------------------------------------------------------------------
# Solver
# ---------------------------------------------------------------------------

def solver(
    *,
    dt: float | None = None,
    max_error: float | None = None,
    integrator: str | None = None,
    gamma: float | None = None,
    g: float | None = None,
) -> None:
    """Configure the time integrator.

    Parameters
    ----------
    dt : float, optional
        Fixed timestep in seconds.
    max_error : float, optional
        Adaptive integrator error tolerance.
    integrator : str, optional
        Integrator name: ``"heun"``, ``"rk4"``, ``"rk23"``, ``"rk45"``.
    gamma : float, optional
        Gyromagnetic ratio in Fullmag internal units of ``m / (A s)``.
    g : float, optional
        Electron ``g``-factor. When provided, Fullmag derives
        ``gamma = mu0 * g * mu_B / hbar``.
    """
    if gamma is not None and g is not None:
        raise ValueError("solver() accepts either gamma=... or g=..., not both")
    if dt is not None:
        _state._dt = dt
    if max_error is not None:
        _state._max_error = max_error
    if integrator is not None:
        _state._integrator = integrator
    if gamma is not None:
        if gamma <= 0.0:
            raise ValueError("gamma must be positive")
        _state._gamma = gamma
    elif g is not None:
        if g <= 0.0:
            raise ValueError("g must be positive")
        _state._gamma = _gamma_from_g_factor(g)


# ---------------------------------------------------------------------------
# External fields
# ---------------------------------------------------------------------------

def b_ext(bx: float, by: float, bz: float) -> None:
    """Set uniform external field B in Tesla."""
    _state._b_ext = (bx, by, bz)


# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

_SCALAR_QUANTITIES = {"E_ex", "E_demag", "E_total", "E_ext", "max_h_eff", "max_dm_dt"}


def save(quantity: str, *, every: float) -> None:
    """Register an output quantity to save periodically.

    Parameters
    ----------
    quantity : str
        Field name (``"m"``, ``"H_demag"``, ``"H_eff"``) or
        scalar name (``"E_ex"``, ``"E_total"``, ``"max_h_eff"``).
    every : float
        Save interval in seconds.
    """
    if quantity in _SCALAR_QUANTITIES or quantity.startswith("E_"):
        _state._outputs.append(SaveScalar(scalar=quantity, every=every))
    else:
        _state._outputs.append(SaveField(field=quantity, every=every))


def name(problem_name: str) -> None:
    """Set the simulation name."""
    _state._name = problem_name


# ---------------------------------------------------------------------------
# Build Problem from accumulated state
# ---------------------------------------------------------------------------

def _build_problem(
    *,
    study_kind: str = "time_evolution",
    relax_algorithm: str = "llg_overdamped",
    relax_torque_tolerance: float = 1e-6,
    relax_energy_tolerance: float | None = None,
    relax_max_steps: int = 50_000,
) -> Problem:
    """Construct a Problem from the current world state."""
    s = _state

    # ── Validate ──
    if not s._magnets:
        raise ValueError("No magnets defined — call fm.geometry(...) first")

    # Convert handles to Ferromagnet objects
    magnets = [h._to_ferromagnet() for h in s._magnets]

    # Energy terms — default to Exchange + Demag (like mumax)
    energy: list = [Exchange(), Demag()]
    # Check if any magnet has DMI
    for h in s._magnets:
        if h.Dind is not None:
            energy.append(InterfacialDMI(D=h.Dind))
            break
    if s._b_ext is not None:
        energy.append(Zeeman(B=s._b_ext))

    # Outputs
    outputs = s._outputs if s._outputs else [
        SaveField(field="m", every=1e-12),
        SaveScalar(scalar="E_total", every=1e-12),
    ]

    # Dynamics
    llg_kwargs: dict[str, Any] = {}
    if s._dt is not None:
        llg_kwargs["fixed_timestep"] = s._dt
    if s._gamma is not None and not math.isclose(s._gamma, DEFAULT_GAMMA):
        llg_kwargs["gamma"] = s._gamma
    dynamics = LLG(**llg_kwargs)

    # Discretization
    disc_kwargs: dict[str, Any] = {}
    if s._cell is not None:
        disc_kwargs["fdm"] = FDM(cell=s._cell)
    if s._hmax is not None:
        disc_kwargs["fem"] = FEM(order=s._fem_order, hmax=s._hmax)
    elif s._backend == "fem" and "fem" not in disc_kwargs:
        # Auto-derive FEM hint: use finest FDM cell edge, or a sensible default.
        if s._cell is not None:
            disc_kwargs["fem"] = FEM(order=s._fem_order, hmax=min(s._cell))
        else:
            disc_kwargs["fem"] = FEM(order=s._fem_order, hmax=5e-9)

    # Runtime
    rt = RuntimeSelection()
    if s._backend != "auto":
        rt = rt.engine(s._backend)
    if s._device == "cuda":
        rt = rt.cuda(s._gpu_count)
        if s._device_index is not None:
            rt = rt.device(s._device_index)
    elif s._device == "cpu":
        rt = rt.cpu()
    elif s._device == "gpu":
        rt = rt.gpu(s._gpu_count)

    if study_kind == "relaxation":
        study = Relaxation(
            outputs=outputs,
            algorithm=relax_algorithm,
            torque_tolerance=relax_torque_tolerance,
            energy_tolerance=relax_energy_tolerance,
            max_steps=relax_max_steps,
            dynamics=dynamics,
        )
    else:
        study = TimeEvolution(dynamics=dynamics, outputs=outputs)

    return Problem(
        name=s._name,
        magnets=magnets,
        energy=energy,
        study=study,
        discretization=DiscretizationHints(**disc_kwargs) if disc_kwargs else None,
        runtime=rt,
        runtime_metadata={"interactive_session_requested": s._interactive},
    )


# ---------------------------------------------------------------------------
# Run / Relax
# ---------------------------------------------------------------------------

def run(until: float) -> Any:
    """Build the problem and run until the given simulation time."""
    if until <= 0.0:
        raise ValueError("run(until) requires a positive stop time")
    from fullmag.runtime import Simulation
    problem = _build_problem()
    if _capture_enabled:
        _captured_stages.append(
            CapturedStage(
                problem=problem,
                entrypoint_kind="flat_run",
                default_until_seconds=until,
            )
        )
        return problem
    return Simulation(problem).run(until=until)


def relax(
    *,
    tol: float = 1e-6,
    max_steps: int = 50_000,
    algorithm: str = "llg_overdamped",
    energy_tolerance: float | None = None,
) -> Any:
    """Build the problem and run a relaxation study."""
    from fullmag.runtime import Simulation
    problem = _build_problem(
        study_kind="relaxation",
        relax_algorithm=algorithm,
        relax_torque_tolerance=tol,
        relax_energy_tolerance=energy_tolerance,
        relax_max_steps=max_steps,
    )
    if _capture_enabled:
        _captured_stages.append(
            CapturedStage(
                problem=problem,
                entrypoint_kind="flat_relax",
                default_until_seconds=None,
            )
        )
        return problem

    fixed_timestep = problem.study.dynamics.fixed_timestep if isinstance(problem.study, Relaxation) else None
    until_seconds = (fixed_timestep or 1e-13) * max_steps
    return Simulation(problem).run(until=until_seconds)
