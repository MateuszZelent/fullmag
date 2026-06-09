from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from fullmag._validation import as_vector3, require_finite, require_non_empty, require_positive


@dataclass(frozen=True, slots=True)
class Exchange:
    def to_ir(self) -> dict[str, object]:
        return {"kind": "exchange"}


_DEMAG_CANONICAL = frozenset({
    "auto",
    "bem",
    "fmm",
    "fredkin_koehler",
    "poisson_dirichlet",
    "poisson_robin",
})

_DEMAG_LEGACY_ALIASES: dict[str, str] = {
    "poisson_airbox": "poisson_robin",
    "airbox_robin": "poisson_robin",
    "airbox_dirichlet": "poisson_dirichlet",
}

_DEMAG_ALLOWED = frozenset({None}) | _DEMAG_CANONICAL | frozenset(_DEMAG_LEGACY_ALIASES)

# Phase-1C: canonical demag model vocabulary.
_DEMAG_MODELS = frozenset({"airbox", "bem", "fredkin_koehler", "fmm"})
_DEMAG_AIRBOX_VARIANTS = frozenset({"auto", "dirichlet", "robin"})

# Map (model, variant) → IR realization string.
# The IR uses the existing "poisson_robin"/"poisson_dirichlet" serde names
# for airbox variants. New models map to their own serde names.
_MODEL_TO_IR: dict[tuple[str, str], str] = {
    ("airbox", "auto"): "poisson_robin",
    ("airbox", "dirichlet"): "poisson_dirichlet",
    ("airbox", "robin"): "poisson_robin",
    ("bem", "auto"): "bem",
    ("fredkin_koehler", "auto"): "fredkin_koehler",
    ("fmm", "auto"): "fmm",
}


@dataclass(frozen=True, slots=True)
class Demag:
    """Demagnetization energy term.

    New canonical API::

        Demag(model="airbox")                       # default airbox + Robin
        Demag(model="airbox", variant="dirichlet")  # explicit Dirichlet
        Demag(model="fredkin_koehler")              # FEM/BEM, body-only mesh
        Demag(model="bem")                          # future: BEM

    Legacy API (still works, deprecated)::

        Demag(realization="poisson_robin")
    """

    model: str | None = None
    variant: str | None = None
    realization: str | None = None

    def __post_init__(self) -> None:
        # Disallow mixing old and new API
        if self.model is not None and self.realization is not None:
            raise ValueError(
                "Cannot specify both 'model' and 'realization'. "
                "Use model= (new) or realization= (legacy), not both."
            )

        if self.model is not None:
            # New model= API
            if self.model not in _DEMAG_MODELS:
                raise ValueError(
                    f"Demag model must be one of {sorted(_DEMAG_MODELS)!r}, "
                    f"got {self.model!r}"
                )
            effective_variant = self.variant or "auto"
            if self.model == "airbox":
                if effective_variant not in _DEMAG_AIRBOX_VARIANTS:
                    raise ValueError(
                        f"Airbox variant must be one of {sorted(_DEMAG_AIRBOX_VARIANTS)!r}, "
                        f"got {effective_variant!r}"
                    )
            elif self.variant is not None:
                raise ValueError(
                    f"Demag model '{self.model}' does not accept a 'variant' parameter."
                )
        elif self.realization is not None:
            # Legacy realization= API
            if self.realization not in _DEMAG_ALLOWED:
                raise ValueError(
                    f"Demag realization must be one of "
                    f"{sorted(r for r in _DEMAG_ALLOWED if r is not None)!r} "
                    f"or None, got {self.realization!r}"
                )
        elif self.variant is not None:
            raise ValueError(
                "'variant' requires 'model' to be specified (e.g. model='airbox')."
            )

    def _resolved_realization(self) -> str:
        """Return the canonical IR realization string."""
        if self.model is not None:
            effective_variant = self.variant or "auto"
            return _MODEL_TO_IR.get(
                (self.model, effective_variant), self.model
            )
        if self.realization is None:
            return "auto"
        return _DEMAG_LEGACY_ALIASES.get(self.realization, self.realization)

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "demag",
            "realization": self._resolved_realization(),
        }


@dataclass(frozen=True, slots=True)
class InterfacialDMI:
    D: float
    interface_normal: tuple[float, float, float] | None = None

    def __init__(self, D: float, interface_normal: Sequence[float] | None = None) -> None:
        object.__setattr__(self, "D", require_finite(D, "D"))
        object.__setattr__(
            self,
            "interface_normal",
            as_vector3(interface_normal, "interface_normal")
            if interface_normal is not None
            else None,
        )

    def to_ir(self) -> dict[str, object]:
        ir: dict[str, object] = {"kind": "interfacial_dmi", "D": self.D}
        if self.interface_normal is not None:
            ir["interface_normal"] = list(self.interface_normal)
        return ir


@dataclass(frozen=True, slots=True)
class BulkDMI:
    D: float

    def __post_init__(self) -> None:
        object.__setattr__(self, "D", require_finite(self.D, "D"))

    def to_ir(self) -> dict[str, object]:
        return {"kind": "bulk_dmi", "D": self.D}


@dataclass(frozen=True, slots=True)
class Zeeman:
    B: tuple[float, float, float]

    def __init__(self, B: Sequence[float]) -> None:
        object.__setattr__(self, "B", as_vector3(B, "B"))

    def to_ir(self) -> dict[str, object]:
        return {"kind": "zeeman", "B": list(self.B)}


# ── Time dependence envelopes for Oersted field current ──


@dataclass(frozen=True, slots=True)
class Constant:
    """Constant time dependence (default)."""

    def to_ir(self) -> dict[str, object]:
        return {"kind": "constant"}


@dataclass(frozen=True, slots=True)
class Sinusoidal:
    """Sinusoidal time dependence: I(t) = I_dc * (sin(2π·freq·t + phase) + offset)."""

    frequency_hz: float
    phase_rad: float = 0.0
    offset: float = 0.0

    def __post_init__(self) -> None:
        require_positive(self.frequency_hz, "frequency_hz")

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "sinusoidal",
            "frequency_hz": self.frequency_hz,
            "phase_rad": self.phase_rad,
            "offset": self.offset,
        }


@dataclass(frozen=True, slots=True)
class Pulse:
    """Rectangular pulse: I(t) = I_dc for t_on ≤ t < t_off, else 0."""

    t_on: float
    t_off: float

    def __post_init__(self) -> None:
        if self.t_off <= self.t_on:
            raise ValueError("t_off must be greater than t_on")

    def to_ir(self) -> dict[str, object]:
        return {"kind": "pulse", "t_on": self.t_on, "t_off": self.t_off}


@dataclass(frozen=True, slots=True)
class PiecewiseLinear:
    """Piecewise-linear time dependence defined by (time, value) control points.

    The envelope is interpolated linearly between successive points.  Before
    the first point and after the last, the value is held constant at the
    first/last value respectively.

    Parameters
    ----------
    points : sequence of (time, value) pairs
        At least 2 points with strictly increasing times.
    """

    points: tuple[tuple[float, float], ...]

    def __init__(self, points: Sequence[Sequence[float]]) -> None:
        converted = tuple(
            (float(p[0]), float(p[1])) for p in points
        )
        if len(converted) < 2:
            raise ValueError("PiecewiseLinear requires at least 2 points")
        ts = [p[0] for p in converted]
        if any(t2 <= t1 for t1, t2 in zip(ts, ts[1:])):
            raise ValueError("PiecewiseLinear times must be strictly increasing")
        object.__setattr__(self, "points", converted)

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "piecewise_linear",
            "points": [[t, v] for t, v in self.points],
        }


@dataclass(frozen=True, slots=True)
class SincPulse:
    """Normalized sinc pulse: f(t) = amplitude * sinc(2 * cutoff_hz * (t - t0))."""

    cutoff_hz: float
    t0: float = 0.0
    amplitude: float = 1.0

    def __post_init__(self) -> None:
        require_positive(self.cutoff_hz, "cutoff_hz")
        require_finite(self.t0, "t0")
        require_finite(self.amplitude, "amplitude")

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "sinc_pulse",
            "cutoff_hz": self.cutoff_hz,
            "t0": self.t0,
            "amplitude": self.amplitude,
        }


TimeDependence = Constant | Sinusoidal | Pulse | PiecewiseLinear | SincPulse

OERSTED_FIELD_MODELS = frozenset({"from_current_solution"})


@dataclass(frozen=True, slots=True)
class OerstedCylinder:
    """Oersted field from a cylindrical conductor (STNO / MTJ pillar).

    The field profile H_oe(x,y,z) is computed analytically using Ampère's
    law for an infinite cylinder and precomputed once on the GPU.  At each
    integration step the field is scaled by ``current * time_dependence(t)``.

    Parameters
    ----------
    current : float
        DC current amplitude in Amperes.  Sign determines chirality.
    radius : float
        Cylinder radius in metres.
    center : sequence of 3 floats, optional
        Cross-section centre [m].  Default: (0, 0, 0).
    axis : sequence of 3 floats, optional
        Current-flow axis (unit vector).  Default: (0, 0, 1) = +z.
    time_dependence : TimeDependence, optional
        Time-varying envelope.  Default: constant.
    """

    current: float
    radius: float
    center: tuple[float, float, float] = (0.0, 0.0, 0.0)
    axis: tuple[float, float, float] = (0.0, 0.0, 1.0)
    time_dependence: TimeDependence | None = None

    def __init__(
        self,
        current: float,
        radius: float,
        center: Sequence[float] = (0.0, 0.0, 0.0),
        axis: Sequence[float] = (0.0, 0.0, 1.0),
        time_dependence: TimeDependence | None = None,
    ) -> None:
        require_positive(radius, "radius")
        object.__setattr__(self, "current", float(current))
        object.__setattr__(self, "radius", float(radius))
        object.__setattr__(self, "center", as_vector3(center, "center"))
        object.__setattr__(self, "axis", as_vector3(axis, "axis"))
        object.__setattr__(self, "time_dependence", time_dependence)

    def to_ir(self) -> dict[str, object]:
        ir: dict[str, object] = {
            "kind": "oersted_cylinder",
            "current": self.current,
            "radius": self.radius,
            "center": list(self.center),
            "axis": list(self.axis),
        }
        if self.time_dependence is not None:
            ir["time_dependence"] = self.time_dependence.to_ir()
        return ir


@dataclass(frozen=True, slots=True)
class OerstedField:
    """Oersted field driven by a named current-transport solution.

    The current public executable subset is intentionally narrow:

    - ``model="from_current_solution"`` only,
    - ``source`` must reference a ``CurrentTransport``,
    - planner execution is currently limited to uniform prescribed current
      density in a cylindrical ``solve_region``.
    """

    source: str
    model: str = "from_current_solution"

    def __post_init__(self) -> None:
        if self.model not in OERSTED_FIELD_MODELS:
            raise ValueError(
                f"OerstedField model must be one of {sorted(OERSTED_FIELD_MODELS)!r}, got {self.model!r}"
            )
        object.__setattr__(self, "source", require_non_empty(self.source, "source"))

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "oersted_field",
            "model": self.model,
            "source": self.source,
        }


@dataclass(frozen=True, slots=True)
class Magnetoelastic:
    """Magnetoelastic coupling energy between a magnet and an elastic body.

    Parameters
    ----------
    magnet : str
        Name of the ``Ferromagnet``.
    body : str
        Name of the ``ElasticBody``.
    law : str
        Name of the ``MagnetostrictionLaw``.
    """

    magnet: str
    body: str
    law: str

    def __post_init__(self) -> None:
        from fullmag._validation import require_non_empty

        object.__setattr__(self, "magnet", require_non_empty(self.magnet, "magnet"))
        object.__setattr__(self, "body", require_non_empty(self.body, "body"))
        object.__setattr__(self, "law", require_non_empty(self.law, "law"))

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "magnetoelastic",
            "magnet": self.magnet,
            "body": self.body,
            "law": self.law,
        }


@dataclass(frozen=True, slots=True)
class UniaxialAnisotropy:
    """Uniaxial magnetocrystalline anisotropy energy.

    The anisotropy energy density is::

        e = Ku1 * sin²(θ) + Ku2 * sin⁴(θ)

    where θ is the angle between the magnetization and the easy axis.

    Parameters
    ----------
    ku1 : float
        First-order uniaxial anisotropy constant [J/m³].
        Positive = easy axis, negative = easy plane.
    ku2 : float, optional
        Second-order uniaxial anisotropy constant [J/m³].  Default: 0.
    axis : sequence of 3 floats, optional
        Easy axis direction (unit vector).  Default: (0, 0, 1).
    """

    ku1: float
    ku2: float = 0.0
    axis: tuple[float, float, float] = (0.0, 0.0, 1.0)

    def __init__(
        self,
        ku1: float,
        ku2: float = 0.0,
        axis: Sequence[float] = (0.0, 0.0, 1.0),
    ) -> None:
        object.__setattr__(self, "ku1", float(ku1))
        object.__setattr__(self, "ku2", float(ku2))
        object.__setattr__(self, "axis", as_vector3(axis, "axis"))

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "uniaxial_anisotropy",
            "ku1": self.ku1,
            "ku2": self.ku2,
            "axis": list(self.axis),
        }


@dataclass(frozen=True, slots=True)
class CubicAnisotropy:
    """Cubic magnetocrystalline anisotropy energy.

    The anisotropy energy density is::

        e = Kc1*(α₁²α₂² + α₂²α₃² + α₃²α₁²) + Kc2*(α₁²α₂²α₃²) + Kc3*(…)

    where α₁, α₂, α₃ are the direction cosines with respect to the crystal axes.

    Parameters
    ----------
    kc1 : float
        First cubic anisotropy constant [J/m³].
    kc2 : float, optional
        Second cubic anisotropy constant [J/m³].  Default: 0.
    kc3 : float, optional
        Third cubic anisotropy constant [J/m³].  Default: 0.
    axis1 : sequence of 3 floats, optional
        First crystal axis (unit vector).  Default: (1, 0, 0).
    axis2 : sequence of 3 floats, optional
        Second crystal axis (unit vector, perpendicular to axis1).  Default: (0, 1, 0).
    """

    kc1: float
    kc2: float = 0.0
    kc3: float = 0.0
    axis1: tuple[float, float, float] = (1.0, 0.0, 0.0)
    axis2: tuple[float, float, float] = (0.0, 1.0, 0.0)

    def __init__(
        self,
        kc1: float,
        kc2: float = 0.0,
        kc3: float = 0.0,
        axis1: Sequence[float] = (1.0, 0.0, 0.0),
        axis2: Sequence[float] = (0.0, 1.0, 0.0),
    ) -> None:
        object.__setattr__(self, "kc1", float(kc1))
        object.__setattr__(self, "kc2", float(kc2))
        object.__setattr__(self, "kc3", float(kc3))
        object.__setattr__(self, "axis1", as_vector3(axis1, "axis1"))
        object.__setattr__(self, "axis2", as_vector3(axis2, "axis2"))

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "cubic_anisotropy",
            "kc1": self.kc1,
            "kc2": self.kc2,
            "kc3": self.kc3,
            "axis1": list(self.axis1),
            "axis2": list(self.axis2),
        }


@dataclass(frozen=True, slots=True)
class ThermalNoise:
    """Stochastic thermal fluctuations (Brown noise) in the LLG equation.

    The stochastic field amplitude follows the fluctuation-dissipation theorem::

        σ = sqrt(2 α k_B T / (γ μ₀ M_s V Δt))

    Parameters
    ----------
    temperature : float
        Temperature in Kelvin.  Must be positive.
    seed : int, optional
        Random number generator seed for reproducibility.  If ``None`` a
        time-dependent seed is used.
    """

    temperature: float
    seed: int | None = None

    def __post_init__(self) -> None:
        require_positive(self.temperature, "temperature")

    def to_ir(self) -> dict[str, object]:
        ir: dict[str, object] = {
            "kind": "thermal_noise",
            "temperature": self.temperature,
        }
        if self.seed is not None:
            ir["seed"] = self.seed
        return ir
