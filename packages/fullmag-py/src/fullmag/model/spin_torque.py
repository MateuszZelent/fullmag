"""Spin-transfer and spin-orbit torque model definitions for Fullmag.

The public Python DSL exposes torque modules as physics-first objects that can
be attached to a ``Problem`` either via the legacy ``spin_torque=...`` slot or
the canonical ``spin_torques=[...]`` list.

Current executable subset:
- ``SlonczewskiSTT`` on FDM CPU/GPU
- ``ZhangLiSTT`` on FDM CPU/GPU
- ``SpinOrbitTorque`` on FDM CPU/GPU

Semantic-only placeholders are provided for the next roadmap steps:
- ``InterfaceCppSTT``
- ``DriftDiffusionSpinTorque``
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from fullmag._validation import as_vector3, require_non_empty, require_positive


def _validated_degree(degree: float) -> float:
    if not (0.0 < degree <= 1.0):
        raise ValueError(f"degree (P) must be in (0, 1], got {degree}")
    return float(degree)


def _validated_lambda(lambda_asymmetry: float) -> float:
    if lambda_asymmetry < 1.0:
        raise ValueError(f"lambda_asymmetry (Lambda) must be >= 1, got {lambda_asymmetry}")
    return float(lambda_asymmetry)


def _validated_beta(beta: float) -> float:
    if beta < 0.0:
        raise ValueError(f"beta must be >= 0, got {beta}")
    return float(beta)


def _resolve_current_binding(
    *,
    current_density: Sequence[float] | None,
    current_source: str | None,
) -> tuple[tuple[float, float, float] | None, str | None]:
    if current_density is not None and current_source is not None:
        raise ValueError("use either current_density or current_source, not both")
    if current_density is None and current_source is None:
        raise ValueError("one of current_density or current_source is required")
    resolved_density = (
        as_vector3(current_density, "current_density") if current_density is not None else None
    )
    resolved_source = (
        require_non_empty(current_source, "current_source") if current_source is not None else None
    )
    return resolved_density, resolved_source


def _resolve_scalar_current_binding(
    *,
    charge_current_density_a_per_m2: float | None,
    current_source: str | None,
) -> tuple[float | None, str | None]:
    if charge_current_density_a_per_m2 is not None and current_source is not None:
        raise ValueError(
            "use either charge_current_density_a_per_m2 or current_source, not both"
        )
    if charge_current_density_a_per_m2 is None and current_source is None:
        raise ValueError(
            "one of charge_current_density_a_per_m2 or current_source is required"
        )
    resolved_source = (
        require_non_empty(current_source, "current_source") if current_source is not None else None
    )
    if charge_current_density_a_per_m2 is None:
        return None, resolved_source
    require_positive(charge_current_density_a_per_m2, "charge_current_density_a_per_m2")
    return float(charge_current_density_a_per_m2), resolved_source


FIXED_LAYER_POSITIONS = {"top", "bottom"}


def _validated_fixed_layer_position(position: str) -> str:
    pos = position.lower().strip()
    if pos not in FIXED_LAYER_POSITIONS:
        raise ValueError(f"fixed_layer_position must be one of {sorted(FIXED_LAYER_POSITIONS)}, got {position!r}")
    return pos


@dataclass(frozen=True, slots=True)
class SlonczewskiSTT:
    """Slonczewski spin-transfer torque for CPP / MTJ geometry.

    Parameters
    ----------
    current_density : tuple of 3 floats, optional
        Current density vector [A/m²]. For CPP, typically (0, 0, Jz).
    current_source : str, optional
        Name of a ``CurrentTransport`` module that provides the current drive.
    spin_polarization : tuple of 3 floats
        Unit vector of fixed-layer polarization direction.
    degree : float
        Spin polarization efficiency P (0 < P ≤ 1). Default: 0.4.
    lambda_asymmetry : float
        Slonczewski asymmetry parameter Λ (≥ 1). Default: 1.0.
    epsilon_prime : float, optional
        Secondary (field-like) spin-transfer coefficient ε'. Default: 0.0.
    free_layer_thickness_m : float, optional
        Free-layer thickness d [m]. Used in the β_STT prefactor
        ``β = ℏ·J / (2·e·μ₀·Ms·d)``. When ``None`` the engine defaults to
        the cell size along the current-flow direction (like amumax).
    fixed_layer_position : str, optional
        Stack ordering of fixed vs free layer along +z: ``"top"`` or ``"bottom"``.
        Controls the sign of the torque (current sign convention).
        ``"top"`` → electrons flow upward into the fixed layer (positive J_z),
        ``"bottom"`` → electrons flow downward (sign flip, like amumax ``FIXEDLAYER_BOTTOM``).
        Default: ``"top"``.
    """

    current_density: tuple[float, float, float] | None
    current_source: str | None
    spin_polarization: tuple[float, float, float]
    degree: float = 0.4
    lambda_asymmetry: float = 1.0
    epsilon_prime: float = 0.0
    free_layer_thickness_m: float | None = None
    fixed_layer_position: str = "top"

    def __init__(
        self,
        current_density: Sequence[float] | None = None,
        spin_polarization: Sequence[float] = (0.0, 0.0, 1.0),
        degree: float = 0.4,
        lambda_asymmetry: float = 1.0,
        epsilon_prime: float = 0.0,
        free_layer_thickness_m: float | None = None,
        fixed_layer_position: str = "top",
        *,
        current_source: str | None = None,
    ) -> None:
        resolved_density, resolved_source = _resolve_current_binding(
            current_density=current_density,
            current_source=current_source,
        )
        object.__setattr__(self, "current_density", resolved_density)
        object.__setattr__(self, "current_source", resolved_source)
        object.__setattr__(
            self,
            "spin_polarization",
            as_vector3(spin_polarization, "spin_polarization"),
        )
        object.__setattr__(self, "degree", _validated_degree(degree))
        object.__setattr__(self, "lambda_asymmetry", _validated_lambda(lambda_asymmetry))
        object.__setattr__(self, "epsilon_prime", float(epsilon_prime))
        if free_layer_thickness_m is not None:
            require_positive(free_layer_thickness_m, "free_layer_thickness_m")
            object.__setattr__(self, "free_layer_thickness_m", float(free_layer_thickness_m))
        else:
            object.__setattr__(self, "free_layer_thickness_m", None)
        object.__setattr__(
            self,
            "fixed_layer_position",
            _validated_fixed_layer_position(fixed_layer_position),
        )

    def to_ir_module(self) -> dict[str, object]:
        ir: dict[str, object] = {
            "kind": "slonczewski",
            "spin_polarization": list(self.spin_polarization),
            "degree": self.degree,
            "lambda_asymmetry": self.lambda_asymmetry,
            "epsilon_prime": self.epsilon_prime,
            "fixed_layer_position": self.fixed_layer_position,
        }
        if self.free_layer_thickness_m is not None:
            ir["free_layer_thickness_m"] = self.free_layer_thickness_m
        if self.current_density is not None:
            ir["current_density"] = list(self.current_density)
        if self.current_source is not None:
            ir["current_source"] = self.current_source
        return ir

    def to_ir_fields(self) -> dict[str, object]:
        """Return the legacy executable STT fields used by the current runner."""
        if self.current_density is None:
            return {}
        fields: dict[str, object] = {
            "current_density": list(self.current_density),
            "stt_degree": self.degree,
            "stt_spin_polarization": list(self.spin_polarization),
            "stt_lambda": self.lambda_asymmetry,
            "stt_epsilon_prime": self.epsilon_prime,
            "stt_fixed_layer_position": self.fixed_layer_position,
        }
        if self.free_layer_thickness_m is not None:
            fields["stt_thickness"] = self.free_layer_thickness_m
        return fields


@dataclass(frozen=True, slots=True)
class ZhangLiSTT:
    """Zhang-Li spin-transfer torque for CIP geometry.

    Parameters
    ----------
    current_density : tuple of 3 floats, optional
        Current density vector [A/m²].
    degree : float
        Spin polarization efficiency P (0 < P ≤ 1). Default: 0.4.
    beta : float
        Non-adiabatic STT parameter β ≥ 0. Default: 0.0.
    xi : float, optional
        Alias for ``beta`` (mumax3/amumax compatibility).  If both ``beta``
        and ``xi`` are specified with different non-zero values, raises
        ``ValueError``.
    """

    current_density: tuple[float, float, float] | None
    current_source: str | None
    degree: float = 0.4
    beta: float = 0.0

    def __init__(
        self,
        current_density: Sequence[float] | None = None,
        degree: float = 0.4,
        beta: float = 0.0,
        *,
        xi: float | None = None,
        current_source: str | None = None,
    ) -> None:
        # Resolve xi / beta alias
        resolved_beta = beta
        if xi is not None:
            if beta != 0.0 and xi != beta:
                raise ValueError(
                    f"beta={beta} and xi={xi} are both specified with different values; "
                    "use only one (xi is an alias for beta)"
                )
            resolved_beta = xi
        resolved_density, resolved_source = _resolve_current_binding(
            current_density=current_density,
            current_source=current_source,
        )
        object.__setattr__(self, "current_density", resolved_density)
        object.__setattr__(self, "current_source", resolved_source)
        object.__setattr__(self, "degree", _validated_degree(degree))
        object.__setattr__(self, "beta", _validated_beta(resolved_beta))

    def to_ir_module(self) -> dict[str, object]:
        ir = {
            "kind": "zhang_li",
            "degree": self.degree,
            "beta": self.beta,
        }
        if self.current_density is not None:
            ir["current_density"] = list(self.current_density)
        if self.current_source is not None:
            ir["current_source"] = self.current_source
        return ir

    def to_ir_fields(self) -> dict[str, object]:
        """Return the legacy executable STT fields used by the current runner."""
        if self.current_density is None:
            return {}
        return {
            "current_density": list(self.current_density),
            "stt_degree": self.degree,
            "stt_beta": self.beta,
        }


@dataclass(frozen=True, slots=True)
class InterfaceCppSTT:
    """Interface-local CPP torque placeholder for multilayer / MTJ stacks."""

    current_density: tuple[float, float, float] | None
    current_source: str | None
    spin_polarization: tuple[float, float, float]
    interface_normal: tuple[float, float, float]
    degree: float = 0.4
    lambda_asymmetry: float = 1.0
    epsilon_prime: float = 0.0

    def __init__(
        self,
        current_density: Sequence[float] | None = None,
        spin_polarization: Sequence[float] = (0.0, 0.0, 1.0),
        interface_normal: Sequence[float] = (0.0, 0.0, 1.0),
        degree: float = 0.4,
        lambda_asymmetry: float = 1.0,
        epsilon_prime: float = 0.0,
        *,
        current_source: str | None = None,
    ) -> None:
        resolved_density, resolved_source = _resolve_current_binding(
            current_density=current_density,
            current_source=current_source,
        )
        object.__setattr__(self, "current_density", resolved_density)
        object.__setattr__(self, "current_source", resolved_source)
        object.__setattr__(
            self,
            "spin_polarization",
            as_vector3(spin_polarization, "spin_polarization"),
        )
        object.__setattr__(
            self,
            "interface_normal",
            as_vector3(interface_normal, "interface_normal"),
        )
        object.__setattr__(self, "degree", _validated_degree(degree))
        object.__setattr__(self, "lambda_asymmetry", _validated_lambda(lambda_asymmetry))
        object.__setattr__(self, "epsilon_prime", float(epsilon_prime))

    def to_ir_module(self) -> dict[str, object]:
        ir = {
            "kind": "interface_cpp",
            "spin_polarization": list(self.spin_polarization),
            "interface_normal": list(self.interface_normal),
            "degree": self.degree,
            "lambda_asymmetry": self.lambda_asymmetry,
            "epsilon_prime": self.epsilon_prime,
        }
        if self.current_density is not None:
            ir["current_density"] = list(self.current_density)
        if self.current_source is not None:
            ir["current_source"] = self.current_source
        return ir


@dataclass(frozen=True, slots=True)
class DriftDiffusionSpinTorque:
    """Semantic placeholder for self-consistent drift-diffusion torque."""

    current_density: tuple[float, float, float] | None
    current_source: str | None
    spin_polarization: tuple[float, float, float]
    degree: float = 0.4
    beta: float = 0.0
    spin_diffusion_length_m: float = 5e-9

    def __init__(
        self,
        current_density: Sequence[float] | None = None,
        spin_polarization: Sequence[float] = (0.0, 0.0, 1.0),
        degree: float = 0.4,
        beta: float = 0.0,
        spin_diffusion_length_m: float = 5e-9,
        *,
        current_source: str | None = None,
    ) -> None:
        resolved_density, resolved_source = _resolve_current_binding(
            current_density=current_density,
            current_source=current_source,
        )
        object.__setattr__(self, "current_density", resolved_density)
        object.__setattr__(self, "current_source", resolved_source)
        object.__setattr__(
            self,
            "spin_polarization",
            as_vector3(spin_polarization, "spin_polarization"),
        )
        object.__setattr__(self, "degree", _validated_degree(degree))
        object.__setattr__(self, "beta", _validated_beta(beta))
        require_positive(spin_diffusion_length_m, "spin_diffusion_length_m")
        object.__setattr__(self, "spin_diffusion_length_m", float(spin_diffusion_length_m))

    def to_ir_module(self) -> dict[str, object]:
        ir = {
            "kind": "drift_diffusion",
            "spin_polarization": list(self.spin_polarization),
            "degree": self.degree,
            "beta": self.beta,
            "spin_diffusion_length_m": self.spin_diffusion_length_m,
        }
        if self.current_density is not None:
            ir["current_density"] = list(self.current_density)
        if self.current_source is not None:
            ir["current_source"] = self.current_source
        return ir


@dataclass(frozen=True, slots=True)
class SpinOrbitTorque:
    """Damping-like / field-like spin-orbit torque (Spin Hall Effect).

    Executable on FDM CPU/GPU.  Models the torque exerted on an FM layer by
    spin-current injection from an adjacent heavy-metal (HM) layer via the
    Spin Hall Effect.
    """

    charge_current_density_a_per_m2: float | None
    current_source: str | None
    damping_like_efficiency: float
    spin_polarization: tuple[float, float, float]
    ferromagnet_thickness_m: float
    field_like_efficiency: float = 0.0

    def __init__(
        self,
        charge_current_density_a_per_m2: float | None = None,
        damping_like_efficiency: float = 0.0,
        spin_polarization: Sequence[float] = (0.0, 0.0, 1.0),
        ferromagnet_thickness_m: float = 1e-9,
        field_like_efficiency: float = 0.0,
        *,
        current_source: str | None = None,
    ) -> None:
        resolved_density, resolved_source = _resolve_scalar_current_binding(
            charge_current_density_a_per_m2=charge_current_density_a_per_m2,
            current_source=current_source,
        )
        require_positive(ferromagnet_thickness_m, "ferromagnet_thickness_m")
        object.__setattr__(self, "charge_current_density_a_per_m2", resolved_density)
        object.__setattr__(self, "current_source", resolved_source)
        object.__setattr__(self, "damping_like_efficiency", float(damping_like_efficiency))
        object.__setattr__(self, "field_like_efficiency", float(field_like_efficiency))
        object.__setattr__(
            self,
            "spin_polarization",
            as_vector3(spin_polarization, "spin_polarization"),
        )
        object.__setattr__(self, "ferromagnet_thickness_m", float(ferromagnet_thickness_m))

    def to_ir_module(self) -> dict[str, object]:
        ir = {
            "kind": "spin_orbit_torque",
            "damping_like_efficiency": self.damping_like_efficiency,
            "field_like_efficiency": self.field_like_efficiency,
            "spin_polarization": list(self.spin_polarization),
            "ferromagnet_thickness_m": self.ferromagnet_thickness_m,
        }
        if self.charge_current_density_a_per_m2 is not None:
            ir["charge_current_density_a_per_m2"] = self.charge_current_density_a_per_m2
        if self.current_source is not None:
            ir["current_source"] = self.current_source
        return ir


SpinTorqueModule = (
    SlonczewskiSTT
    | ZhangLiSTT
    | InterfaceCppSTT
    | DriftDiffusionSpinTorque
    | SpinOrbitTorque
)
SpinTorque = SpinTorqueModule
LegacySpinTorque = SlonczewskiSTT | ZhangLiSTT
