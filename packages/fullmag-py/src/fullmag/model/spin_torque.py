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

import copy
from dataclasses import dataclass
import math
from typing import Mapping, Sequence, TypeAlias
import warnings

from fullmag._validation import (
    as_vector3,
    require_finite,
    require_non_empty,
    require_positive,
)


PRESCRIBED_SOT_V1_EPSILON_AXIS = 1e-12


def _finite_vector3(value: Sequence[float], field_name: str) -> tuple[float, float, float]:
    vector = as_vector3(value, field_name)
    if not all(math.isfinite(component) for component in vector):
        raise ValueError(f"{field_name} must contain only finite values")
    return vector


def _normalized_axis(
    value: Sequence[float], field_name: str
) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    authored = _finite_vector3(value, field_name)
    scale = max(abs(component) for component in authored)
    if scale == 0.0:
        raise ValueError(
            f"{field_name} norm must be greater than epsilon_axis "
            f"({PRESCRIBED_SOT_V1_EPSILON_AXIS:g})"
        )
    scaled = tuple(component / scale for component in authored)
    scaled_norm = math.hypot(*scaled)
    if (
        scale <= PRESCRIBED_SOT_V1_EPSILON_AXIS
        and scaled_norm <= PRESCRIBED_SOT_V1_EPSILON_AXIS / scale
    ):
        raise ValueError(
            f"{field_name} norm must be greater than epsilon_axis "
            f"({PRESCRIBED_SOT_V1_EPSILON_AXIS:g})"
        )
    raw_norm = math.hypot(*authored)
    if math.isclose(raw_norm, 1.0, rel_tol=0.0, abs_tol=1.0e-15):
        # Preserve an already canonical unit vector bit-for-bit.  Re-normalizing
        # a serialized unit vector can introduce a last-bit drift on every
        # scene-document round trip.
        return authored, authored
    return authored, tuple(component / scaled_norm for component in scaled)


@dataclass(frozen=True, slots=True)
class RegionRef:
    """Canonical reference to an authored object or one of its regions."""

    object_id: str
    region_id: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "object_id", require_non_empty(self.object_id, "object_id"))
        if self.region_id is not None:
            object.__setattr__(
                self,
                "region_id",
                require_non_empty(self.region_id, "region_id"),
            )

    def to_ir(self) -> dict[str, object]:
        value: dict[str, object] = {"object_id": self.object_id}
        if self.region_id is not None:
            value["region_id"] = self.region_id
        return value


@dataclass(frozen=True, slots=True)
class TimeEnvelopePoint:
    """One dimensionless multiplier sample at an SI time in seconds."""

    time_s: float
    value: float

    def __post_init__(self) -> None:
        object.__setattr__(self, "time_s", require_finite(self.time_s, "time_s"))
        object.__setattr__(self, "value", require_finite(self.value, "value"))

    def to_ir(self) -> dict[str, float]:
        return {"time_s": self.time_s, "value": self.value}


@dataclass(frozen=True, slots=True)
class ConstantEnvelope:
    value: float

    def __post_init__(self) -> None:
        object.__setattr__(self, "value", require_finite(self.value, "value"))

    def to_ir(self) -> dict[str, object]:
        return {"kind": "constant", "value": self.value}


@dataclass(frozen=True, slots=True)
class SinusoidalEnvelope:
    amplitude: float
    frequency_hz: float
    phase_rad: float = 0.0
    offset: float = 0.0

    def __post_init__(self) -> None:
        object.__setattr__(self, "amplitude", require_finite(self.amplitude, "amplitude"))
        frequency = require_finite(self.frequency_hz, "frequency_hz")
        if frequency < 0.0:
            raise ValueError("frequency_hz must be >= 0")
        object.__setattr__(self, "frequency_hz", frequency)
        object.__setattr__(self, "phase_rad", require_finite(self.phase_rad, "phase_rad"))
        object.__setattr__(self, "offset", require_finite(self.offset, "offset"))

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "sinusoidal",
            "amplitude": self.amplitude,
            "frequency_hz": self.frequency_hz,
            "phase_rad": self.phase_rad,
            "offset": self.offset,
        }


@dataclass(frozen=True, slots=True)
class PulseEnvelope:
    amplitude: float
    t_on_s: float
    t_off_s: float

    def __post_init__(self) -> None:
        object.__setattr__(self, "amplitude", require_finite(self.amplitude, "amplitude"))
        t_on = require_finite(self.t_on_s, "t_on_s")
        t_off = require_finite(self.t_off_s, "t_off_s")
        if t_off <= t_on:
            raise ValueError("t_off_s must be greater than t_on_s")
        object.__setattr__(self, "t_on_s", t_on)
        object.__setattr__(self, "t_off_s", t_off)

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "pulse",
            "amplitude": self.amplitude,
            "t_on_s": self.t_on_s,
            "t_off_s": self.t_off_s,
        }


@dataclass(frozen=True, slots=True)
class PiecewiseLinearEnvelope:
    points: tuple[TimeEnvelopePoint, ...]

    def __init__(self, points: Sequence[TimeEnvelopePoint]) -> None:
        resolved = tuple(points)
        if not all(isinstance(point, TimeEnvelopePoint) for point in resolved):
            raise TypeError("points must contain TimeEnvelopePoint values")
        if any(right.time_s <= left.time_s for left, right in zip(resolved, resolved[1:])):
            raise ValueError("piecewise-linear time_s values must be strictly increasing")
        object.__setattr__(self, "points", resolved)

    def to_ir(self) -> dict[str, object]:
        return {"kind": "piecewise_linear", "points": [point.to_ir() for point in self.points]}


@dataclass(frozen=True, slots=True, init=False)
class SincEnvelope:
    amplitude: float
    center_s: float
    bandwidth_hz: float
    offset: float = 0.0

    def __init__(
        self,
        amplitude: float,
        center_s: float = 0.0,
        bandwidth_hz: float | None = None,
        offset: float = 0.0,
    ) -> None:
        if bandwidth_hz is None:
            raise ValueError("bandwidth_hz is required")
        object.__setattr__(self, "amplitude", require_finite(amplitude, "amplitude"))
        object.__setattr__(self, "center_s", require_finite(center_s, "center_s"))
        object.__setattr__(self, "bandwidth_hz", require_positive(bandwidth_hz, "bandwidth_hz"))
        object.__setattr__(self, "offset", require_finite(offset, "offset"))

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "sinc",
            "amplitude": self.amplitude,
            "center_s": self.center_s,
            "bandwidth_hz": self.bandwidth_hz,
            "offset": self.offset,
        }


@dataclass(frozen=True, slots=True)
class TabulatedEnvelope:
    artifact_ref: str
    interpolation: str = "linear"
    extrapolation: str = "error"
    bandwidth_hz: float | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "artifact_ref", require_non_empty(self.artifact_ref, "artifact_ref"))
        if self.interpolation not in {"linear", "previous"}:
            raise ValueError("interpolation must be 'linear' or 'previous'")
        if self.extrapolation not in {"zero", "hold", "error"}:
            raise ValueError("extrapolation must be 'zero', 'hold', or 'error'")
        if self.bandwidth_hz is not None:
            object.__setattr__(
                self,
                "bandwidth_hz",
                require_positive(self.bandwidth_hz, "bandwidth_hz"),
            )

    def to_ir(self) -> dict[str, object]:
        value: dict[str, object] = {
            "kind": "tabulated",
            "artifact_ref": self.artifact_ref,
            "interpolation": self.interpolation,
            "extrapolation": self.extrapolation,
        }
        if self.bandwidth_hz is not None:
            value["bandwidth_hz"] = self.bandwidth_hz
        return value


TimeEnvelope: TypeAlias = (
    ConstantEnvelope
    | SinusoidalEnvelope
    | PulseEnvelope
    | PiecewiseLinearEnvelope
    | SincEnvelope
    | TabulatedEnvelope
)


@dataclass(frozen=True, slots=True)
class SignedScalarDrive:
    """Signed scalar current with an authored spin-polarization direction."""

    current_density_Apm2: float
    sigma: tuple[float, float, float]
    envelope: TimeEnvelope | None = None
    _sigma_hat: tuple[float, float, float] = (0.0, 0.0, 0.0)

    def __init__(
        self,
        current_density_Apm2: float,
        sigma: Sequence[float],
        envelope: TimeEnvelope | None = None,
    ) -> None:
        authored, normalized = _normalized_axis(sigma, "sigma")
        object.__setattr__(
            self,
            "current_density_Apm2",
            require_finite(current_density_Apm2, "current_density_Apm2"),
        )
        object.__setattr__(self, "sigma", authored)
        object.__setattr__(self, "_sigma_hat", normalized)
        object.__setattr__(self, "envelope", envelope)
        if envelope is not None and not isinstance(
            envelope,
            (
                ConstantEnvelope,
                SinusoidalEnvelope,
                PulseEnvelope,
                PiecewiseLinearEnvelope,
                SincEnvelope,
                TabulatedEnvelope,
            ),
        ):
            raise TypeError("envelope must be a canonical TimeEnvelope")

    def to_ir(self) -> dict[str, object]:
        value: dict[str, object] = {
            "kind": "signed_scalar",
            "current_density_Apm2": self.current_density_Apm2,
            "sigma_hat": list(self._sigma_hat),
        }
        if self.envelope is not None:
            value["envelope"] = self.envelope.to_ir()
        return value


@dataclass(frozen=True, slots=True)
class VectorCurrentDrive:
    """Binding to a vector current source with fixed geometric axes."""

    current_source: str
    drive_direction: tuple[float, float, float]
    interface_normal: tuple[float, float, float]
    _drive_hat: tuple[float, float, float]
    _normal_hat: tuple[float, float, float]

    def __init__(
        self,
        current_source: str,
        drive_direction: Sequence[float],
        interface_normal: Sequence[float],
    ) -> None:
        authored_drive, drive_hat = _normalized_axis(drive_direction, "drive_direction")
        authored_normal, normal_hat = _normalized_axis(interface_normal, "interface_normal")
        cross = (
            normal_hat[1] * drive_hat[2] - normal_hat[2] * drive_hat[1],
            normal_hat[2] * drive_hat[0] - normal_hat[0] * drive_hat[2],
            normal_hat[0] * drive_hat[1] - normal_hat[1] * drive_hat[0],
        )
        if math.hypot(*cross) <= PRESCRIBED_SOT_V1_EPSILON_AXIS:
            raise ValueError(
                "interface_normal and drive_direction must not be parallel within epsilon_axis"
            )
        object.__setattr__(self, "current_source", require_non_empty(current_source, "current_source"))
        object.__setattr__(self, "drive_direction", authored_drive)
        object.__setattr__(self, "interface_normal", authored_normal)
        object.__setattr__(self, "_drive_hat", drive_hat)
        object.__setattr__(self, "_normal_hat", normal_hat)

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "vector_current_source",
            "current_source_id": self.current_source,
            "drive_direction": list(self._drive_hat),
            "interface_normal": list(self._normal_hat),
        }


PrescribedSotDrive: TypeAlias = SignedScalarDrive | VectorCurrentDrive


def _validated_degree(degree: float) -> float:
    if not (0.0 < degree <= 1.0):
        raise ValueError(f"degree (P) must be in (0, 1], got {degree}")
    return float(degree)


def _validated_lambda(lambda_asymmetry: float) -> float:
    value = require_finite(lambda_asymmetry, "lambda_asymmetry")
    if value < 1.0:
        raise ValueError(f"lambda_asymmetry (Lambda) must be >= 1, got {value}")
    return value


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
        ``Ω = γₑ·ℏ·J / (e·Ms·d)``. When ``None`` the engine defaults to
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
    fixed_layer_position: str | None = "top"
    id: str | None = None
    target: RegionRef | None = None
    stack_normal: tuple[float, float, float] | None = None
    interface_id: str | None = None
    formula_version: str = "slonczewski.legacy_fullmag.v0"
    realization_version: str | None = None

    def __init__(
        self,
        current_density: Sequence[float] | None = None,
        spin_polarization: Sequence[float] = (0.0, 0.0, 1.0),
        degree: float = 0.4,
        lambda_asymmetry: float = 1.0,
        epsilon_prime: float = 0.0,
        free_layer_thickness_m: float | None = None,
        fixed_layer_position: str | None = None,
        *,
        current_source: str | None = None,
        id: str | None = None,
        target: RegionRef | None = None,
        stack_normal: Sequence[float] | None = None,
        interface_id: str | None = None,
    ) -> None:
        resolved_density, resolved_source = _resolve_current_binding(
            current_density=current_density,
            current_source=current_source,
        )
        object.__setattr__(self, "current_density", resolved_density)
        object.__setattr__(self, "current_source", resolved_source)
        canonical = (
            id is not None
            or target is not None
            or stack_normal is not None
            or interface_id is not None
        )
        if canonical:
            if id is None or target is None or stack_normal is None:
                raise ValueError("canonical SlonczewskiSTT requires id, target, and stack_normal")
            if not isinstance(target, RegionRef):
                raise TypeError("target must be a RegionRef")
            if interface_id is None and free_layer_thickness_m is None:
                raise ValueError("canonical thin-layer SlonczewskiSTT requires free_layer_thickness_m")
            if interface_id is not None and free_layer_thickness_m is not None:
                raise ValueError(
                    "canonical interface-flux SlonczewskiSTT must not set free_layer_thickness_m"
                )
            if fixed_layer_position is not None:
                raise ValueError("fixed_layer_position is legacy-only; canonical SlonczewskiSTT uses stack_normal")
            _, polarization_hat = _normalized_axis(spin_polarization, "spin_polarization")
            _, stack_hat = _normalized_axis(stack_normal, "stack_normal")
            object.__setattr__(self, "spin_polarization", polarization_hat)
            object.__setattr__(self, "id", require_non_empty(id, "id"))
            object.__setattr__(self, "target", target)
            object.__setattr__(self, "stack_normal", stack_hat)
            object.__setattr__(
                self,
                "interface_id",
                require_non_empty(interface_id, "interface_id")
                if interface_id is not None
                else None,
            )
            object.__setattr__(self, "fixed_layer_position", None)
            object.__setattr__(self, "formula_version", "slonczewski.fullmag.v2")
            object.__setattr__(
                self,
                "realization_version",
                "slonczewski_interface_flux.v1"
                if interface_id is not None
                else "slonczewski_thin_layer_homogenized.v1",
            )
        else:
            object.__setattr__(self, "spin_polarization", as_vector3(spin_polarization, "spin_polarization"))
            object.__setattr__(self, "id", None)
            object.__setattr__(self, "target", None)
            object.__setattr__(self, "stack_normal", None)
            object.__setattr__(self, "interface_id", None)
            object.__setattr__(self, "fixed_layer_position", _validated_fixed_layer_position(fixed_layer_position or "top"))
            object.__setattr__(self, "formula_version", "slonczewski.legacy_fullmag.v0")
            object.__setattr__(self, "realization_version", None)
        object.__setattr__(self, "degree", _validated_degree(degree))
        object.__setattr__(self, "lambda_asymmetry", _validated_lambda(lambda_asymmetry))
        object.__setattr__(self, "epsilon_prime", require_finite(epsilon_prime, "epsilon_prime"))
        if free_layer_thickness_m is not None:
            require_positive(free_layer_thickness_m, "free_layer_thickness_m")
            object.__setattr__(self, "free_layer_thickness_m", float(free_layer_thickness_m))
        else:
            object.__setattr__(self, "free_layer_thickness_m", None)

    def to_ir_module(self) -> dict[str, object]:
        ir: dict[str, object] = {
            "kind": "slonczewski",
            "formula_version": self.formula_version,
            "spin_polarization": list(self.spin_polarization),
            "degree": self.degree,
            "lambda_asymmetry": self.lambda_asymmetry,
            "epsilon_prime": self.epsilon_prime,
        }
        if self.formula_version == "slonczewski.fullmag.v2":
            assert self.id is not None and self.target is not None
            assert self.stack_normal is not None and self.realization_version is not None
            realization: dict[str, object]
            if self.interface_id is not None:
                realization = {
                    "kind": "interface_flux",
                    "interface_id": self.interface_id,
                    "realization_version": self.realization_version,
                }
            else:
                realization = {
                    "kind": "thin_layer_homogenized",
                    "realization_version": self.realization_version,
                }
            ir.update({
                "schema_version": "slonczewski_torque.v1",
                "id": self.id,
                "target": self.target.to_ir(),
                "stack_normal": list(self.stack_normal),
                "realization": realization,
            })
        else:
            ir["fixed_layer_position"] = self.fixed_layer_position
        if self.free_layer_thickness_m is not None:
            ir["free_layer_thickness_m"] = self.free_layer_thickness_m
        if self.current_density is not None:
            ir["current_density"] = list(self.current_density)
        if self.current_source is not None:
            ir["current_source"] = self.current_source
        return ir

    def to_ir_fields(self) -> dict[str, object]:
        """Return the legacy executable STT fields used by the current runner."""
        if self.current_density is None or self.formula_version != "slonczewski.legacy_fullmag.v0":
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
    operator_version : str, optional
        Explicit canonical spatial/formula realization.  Use
        ``"zl_mumax3_central_v1"`` for the MuMax3-compatible FDM operator or
        omit it for the legacy Fullmag evaluator.
    """

    current_density: tuple[float, float, float] | None
    current_source: str | None
    degree: float = 0.4
    beta: float = 0.0
    id: str | None = None
    target: RegionRef | None = None
    lande_g: float | None = None
    formula_version: str = "zhang_li.legacy_fullmag.v0"
    operator_version: str | None = None

    def __init__(
        self,
        current_density: Sequence[float] | None = None,
        degree: float = 0.4,
        beta: float = 0.0,
        *,
        xi: float | None = None,
        current_source: str | None = None,
        id: str | None = None,
        target: RegionRef | None = None,
        lande_g: float | None = None,
        operator_version: str | None = None,
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
        if operator_version is not None and operator_version not in {
            "zl_central_reference_v1",
            "zl_mumax3_central_v1",
        }:
            raise ValueError(f"unsupported ZhangLiSTT operator_version {operator_version!r}")
        canonical = (
            id is not None
            or target is not None
            or lande_g is not None
            or operator_version is not None
        )
        if canonical:
            if id is None or target is None or lande_g is None:
                raise ValueError("canonical ZhangLiSTT requires id, target, and lande_g")
            if not isinstance(target, RegionRef):
                raise TypeError("target must be a RegionRef")
            require_positive(lande_g, "lande_g")
            if operator_version == "zl_mumax3_central_v1" and lande_g != 2.0:
                raise ValueError(
                    "zl_mumax3_central_v1 is source-compatible with MuMax3's "
                    "fixed g=2.0; use lande_g=2.0"
                )
            object.__setattr__(self, "id", require_non_empty(id, "id"))
            object.__setattr__(self, "target", target)
            object.__setattr__(self, "lande_g", float(lande_g))
            resolved_operator = operator_version or "zl_central_reference_v1"
            object.__setattr__(self, "operator_version", resolved_operator)
            object.__setattr__(
                self,
                "formula_version",
                "zhang_li.mumax3.v1"
                if resolved_operator == "zl_mumax3_central_v1"
                else "zhang_li.fullmag.v1",
            )
        else:
            object.__setattr__(self, "id", None)
            object.__setattr__(self, "target", None)
            object.__setattr__(self, "lande_g", None)
            object.__setattr__(self, "formula_version", "zhang_li.legacy_fullmag.v0")
            object.__setattr__(self, "operator_version", None)

    def to_ir_module(self) -> dict[str, object]:
        ir = {
            "kind": "zhang_li",
            "formula_version": self.formula_version,
            "degree": self.degree,
            "beta": self.beta,
        }
        if self.formula_version in {"zhang_li.fullmag.v1", "zhang_li.mumax3.v1"}:
            assert self.id is not None and self.target is not None
            assert self.lande_g is not None and self.operator_version is not None
            ir.update({
                "schema_version": "zhang_li_torque.v1",
                "id": self.id,
                "target": self.target.to_ir(),
                "operator_version": self.operator_version,
                "lande_g": self.lande_g,
            })
        if self.current_density is not None:
            ir["current_density"] = list(self.current_density)
        if self.current_source is not None:
            ir["current_source"] = self.current_source
        return ir

    def to_ir_fields(self) -> dict[str, object]:
        """Return the legacy executable STT fields used by the current runner."""
        if self.current_density is None or self.formula_version != "zhang_li.legacy_fullmag.v0":
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
class PrescribedSpinOrbitTorque:
    """Canonical local damping-like and field-like spin-orbit torque source."""

    name: str
    target: RegionRef | None
    drive: PrescribedSotDrive | None
    xi_dl: float
    xi_fl: float
    free_layer_thickness_m: float
    _legacy_module: dict[str, object] | None = None

    def __init__(
        self,
        name: str,
        target: RegionRef,
        drive: PrescribedSotDrive,
        *,
        xi_dl: float,
        xi_fl: float = 0.0,
        free_layer_thickness_m: float,
    ) -> None:
        if not isinstance(target, RegionRef):
            raise TypeError("target must be a RegionRef")
        if not isinstance(drive, (SignedScalarDrive, VectorCurrentDrive)):
            raise TypeError("drive must be SignedScalarDrive or VectorCurrentDrive")
        object.__setattr__(self, "name", require_non_empty(name, "name"))
        object.__setattr__(self, "target", target)
        object.__setattr__(self, "drive", drive)
        object.__setattr__(self, "xi_dl", require_finite(xi_dl, "xi_dl"))
        object.__setattr__(self, "xi_fl", require_finite(xi_fl, "xi_fl"))
        object.__setattr__(
            self,
            "free_layer_thickness_m",
            require_positive(free_layer_thickness_m, "free_layer_thickness_m"),
        )
        object.__setattr__(self, "_legacy_module", None)

    @classmethod
    def from_legacy_v0(
        cls,
        *,
        module_index: int,
        target: None,
        raw_spin_polarization: Sequence[float],
        xi_dl: float,
        xi_fl: float,
        free_layer_thickness_m: float,
        compatibility_origin: Mapping[str, str],
        raw_charge_current_density_Apm2: float | None = None,
        current_source_id: str | None = None,
    ) -> "PrescribedSpinOrbitTorque":
        """Re-export an exact migration-origin-gated legacy-v0 node."""
        if isinstance(module_index, bool) or not isinstance(module_index, int) or module_index < 0:
            raise ValueError("module_index must be a non-negative integer")
        if target is not None:
            raise ValueError("legacy-v0 compatibility requires explicit global target=None")
        exact_origin = {
            "source_ir_version": "0.2.0",
            "authored_kind": "spin_orbit_torque",
        }
        if dict(compatibility_origin) != exact_origin:
            raise ValueError(
                "legacy-v0 compatibility_origin must be exactly "
                "source_ir_version='0.2.0' and authored_kind='spin_orbit_torque'"
            )
        if (raw_charge_current_density_Apm2 is None) == (current_source_id is None):
            raise ValueError(
                "legacy-v0 requires exactly one of raw_charge_current_density_Apm2 "
                "or current_source_id"
            )
        raw_sigma = _finite_vector3(raw_spin_polarization, "raw_spin_polarization")
        if raw_charge_current_density_Apm2 is not None:
            drive: dict[str, object] = {
                "kind": "legacy_scalar_magnitude",
                "raw_charge_current_density_Apm2": require_finite(
                    raw_charge_current_density_Apm2,
                    "raw_charge_current_density_Apm2",
                ),
            }
        else:
            drive = {
                "kind": "legacy_current_source_norm",
                "current_source_id": require_non_empty(current_source_id or "", "current_source_id"),
            }
        name = f"legacy_prescribed_sot_{module_index}"
        module = {
            "kind": "prescribed_sot",
            "schema_version": "prescribed_sot.v1",
            "id": name,
            "target": None,
            "formula_version": "prescribed_sot.legacy_fullmag.v0",
            "drive": drive,
            "raw_spin_polarization": list(raw_sigma),
            "xi_dl": require_finite(xi_dl, "xi_dl"),
            "xi_fl": require_finite(xi_fl, "xi_fl"),
            "free_layer_thickness_m": require_positive(
                free_layer_thickness_m,
                "free_layer_thickness_m",
            ),
            "compatibility_origin": exact_origin,
        }
        instance = object.__new__(cls)
        object.__setattr__(instance, "name", name)
        object.__setattr__(instance, "target", None)
        object.__setattr__(instance, "drive", None)
        object.__setattr__(instance, "xi_dl", module["xi_dl"])
        object.__setattr__(instance, "xi_fl", module["xi_fl"])
        object.__setattr__(
            instance,
            "free_layer_thickness_m",
            module["free_layer_thickness_m"],
        )
        object.__setattr__(instance, "_legacy_module", module)
        return instance

    def to_ir_module(self) -> dict[str, object]:
        if self._legacy_module is not None:
            return copy.deepcopy(self._legacy_module)
        assert self.target is not None
        assert self.drive is not None
        return {
            "kind": "prescribed_sot",
            "schema_version": "prescribed_sot.v1",
            "id": self.name,
            "target": self.target.to_ir(),
            "formula_version": "prescribed_sot.fullmag.v1",
            "drive": self.drive.to_ir(),
            "xi_dl": self.xi_dl,
            "xi_fl": self.xi_fl,
            "free_layer_thickness_m": self.free_layer_thickness_m,
        }

    @property
    def current_source(self) -> str | None:
        if isinstance(self.drive, VectorCurrentDrive):
            return self.drive.current_source
        if self._legacy_module is not None:
            legacy_drive = self._legacy_module["drive"]
            if (
                isinstance(legacy_drive, dict)
                and legacy_drive.get("kind") == "legacy_current_source_norm"
            ):
                source = legacy_drive.get("current_source_id")
                return source if isinstance(source, str) else None
        return None


@dataclass(frozen=True, slots=True)
class SpinOrbitTorque:
    """Deprecated authoring alias that always lowers to canonical prescribed SOT."""

    _canonical: PrescribedSpinOrbitTorque
    charge_current_density_a_per_m2: float | None
    current_source: str | None
    damping_like_efficiency: float
    spin_polarization: tuple[float, float, float]
    ferromagnet_thickness_m: float
    field_like_efficiency: float

    def __init__(
        self,
        charge_current_density_a_per_m2: float | None = None,
        damping_like_efficiency: float = 0.0,
        spin_polarization: Sequence[float] | None = None,
        ferromagnet_thickness_m: float = 1e-9,
        field_like_efficiency: float = 0.0,
        *,
        name: str = "prescribed_sot",
        target: RegionRef | None = None,
        current_source: str | None = None,
        drive_direction: Sequence[float] | None = None,
        interface_normal: Sequence[float] | None = None,
    ) -> None:
        warnings.warn(
            "SpinOrbitTorque is deprecated; use PrescribedSpinOrbitTorque",
            DeprecationWarning,
            stacklevel=2,
        )
        if target is None:
            raise ValueError(
                "SpinOrbitTorque compatibility alias requires an explicit target=RegionRef(...)"
            )
        if current_source is not None:
            if charge_current_density_a_per_m2 is not None:
                raise ValueError(
                    "use either charge_current_density_a_per_m2 or current_source, not both"
                )
            if drive_direction is None or interface_normal is None:
                raise ValueError(
                    "current_source migration requires explicit drive_direction and "
                    "interface_normal; axes cannot be inferred from spin_polarization"
                )
            if spin_polarization is not None:
                raise ValueError(
                    "spin_polarization is not accepted with current_source; "
                    "use drive_direction and interface_normal only"
                )
            drive: PrescribedSotDrive = VectorCurrentDrive(
                current_source,
                drive_direction,
                interface_normal,
            )
        else:
            if charge_current_density_a_per_m2 is None:
                raise ValueError(
                    "one of charge_current_density_a_per_m2 or current_source is required"
                )
            if drive_direction is not None or interface_normal is not None:
                raise ValueError(
                    "drive_direction and interface_normal are valid only with current_source"
                )
            drive = SignedScalarDrive(
                charge_current_density_a_per_m2,
                sigma=(0.0, 0.0, 1.0) if spin_polarization is None else spin_polarization,
            )
        canonical = PrescribedSpinOrbitTorque(
            name=name,
            target=target,
            drive=drive,
            xi_dl=damping_like_efficiency,
            xi_fl=field_like_efficiency,
            free_layer_thickness_m=ferromagnet_thickness_m,
        )
        object.__setattr__(self, "_canonical", canonical)
        object.__setattr__(
            self,
            "charge_current_density_a_per_m2",
            charge_current_density_a_per_m2,
        )
        object.__setattr__(self, "current_source", current_source)
        object.__setattr__(self, "damping_like_efficiency", canonical.xi_dl)
        object.__setattr__(
            self,
            "spin_polarization",
            _finite_vector3(
                (0.0, 0.0, 1.0) if spin_polarization is None else spin_polarization,
                "spin_polarization",
            ),
        )
        object.__setattr__(self, "ferromagnet_thickness_m", canonical.free_layer_thickness_m)
        object.__setattr__(self, "field_like_efficiency", canonical.xi_fl)

    def to_ir_module(self) -> dict[str, object]:
        return self._canonical.to_ir_module()

    @property
    def name(self) -> str:
        return self._canonical.name


SpinTorqueModule = (
    SlonczewskiSTT
    | ZhangLiSTT
    | InterfaceCppSTT
    | DriftDiffusionSpinTorque
    | PrescribedSpinOrbitTorque
    | SpinOrbitTorque
)
SpinTorque = SpinTorqueModule
LegacySpinTorque = SlonczewskiSTT | ZhangLiSTT
