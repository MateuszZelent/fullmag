"""Canonical one-way steady spin drift-diffusion authoring contract."""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Sequence

from fullmag._validation import as_vector3, require_finite, require_non_empty, require_positive
from fullmag.model.spin_torque import RegionRef


DOS_ISOTROPIC_NONMAGNETIC_CAPACITANCE_FORMULA = "dos_isotropic_nonmagnetic.fullmag.v1"
ELEMENTARY_CHARGE_C = 1.602176634e-19


def _unit_vector(value: Sequence[float], name: str) -> tuple[float, float, float]:
    vector = as_vector3(value, name)
    if not all(math.isfinite(component) for component in vector):
        raise ValueError(f"{name} must contain only finite values")
    norm = math.hypot(*vector)
    if norm <= 1.0e-12:
        raise ValueError(f"{name} must have non-zero norm")
    return tuple(component / norm for component in vector)


@dataclass(frozen=True, slots=True)
class SurfaceRef:
    object_id: str
    surface_id: str
    orientation: tuple[float, float, float]

    def __init__(self, object_id: str, surface_id: str, orientation: Sequence[float]) -> None:
        object.__setattr__(self, "object_id", require_non_empty(object_id, "object_id"))
        object.__setattr__(self, "surface_id", require_non_empty(surface_id, "surface_id"))
        object.__setattr__(self, "orientation", _unit_vector(orientation, "orientation"))

    def to_ir(self) -> dict[str, object]:
        return {
            "object_id": self.object_id,
            "surface_id": self.surface_id,
            "orientation": list(self.orientation),
        }


@dataclass(frozen=True, slots=True)
class TransportExecution:
    discretization: str = "fdm"
    device: str = "cpu"
    precision: str = "double"
    execution_mode: str = "strict"

    def __post_init__(self) -> None:
        if self.discretization not in {"fdm", "fem", "auto"}:
            raise ValueError("discretization must be 'fdm', 'fem', or 'auto'")
        if self.device not in {"cpu", "gpu", "auto"}:
            raise ValueError("device must be 'cpu', 'gpu', or 'auto'")
        if self.precision not in {"single", "double"}:
            raise ValueError("precision must be 'single' or 'double'")
        if self.execution_mode not in {"strict", "extended"}:
            raise ValueError("execution_mode must be 'strict' or 'extended'")

    def to_ir(self) -> dict[str, str]:
        return {
            "discretization": self.discretization,
            "device": self.device,
            "precision": self.precision,
            "execution_mode": self.execution_mode,
        }


@dataclass(frozen=True, slots=True)
class SpinTransportMaterial:
    sigma_s_Spm: float
    polarization_p: float
    theta_sh: float
    lambda_sf_m: float
    lambda_j_m: float | None = None
    lambda_phi_m: float | None = None
    spin_capacitance_As_per_V_m3: float | None = None
    capacitance_formula_version: str | None = None
    density_of_states_per_spin_Jinv_m3: float | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "sigma_s_Spm", require_positive(self.sigma_s_Spm, "sigma_s_Spm"))
        polarization = require_finite(self.polarization_p, "polarization_p")
        if not -1.0 <= polarization <= 1.0:
            raise ValueError("polarization_p must be in [-1, 1]")
        object.__setattr__(self, "polarization_p", polarization)
        object.__setattr__(self, "theta_sh", require_finite(self.theta_sh, "theta_sh"))
        object.__setattr__(self, "lambda_sf_m", require_positive(self.lambda_sf_m, "lambda_sf_m"))
        if self.lambda_j_m is not None:
            object.__setattr__(self, "lambda_j_m", require_positive(self.lambda_j_m, "lambda_j_m"))
        if self.lambda_phi_m is not None:
            object.__setattr__(self, "lambda_phi_m", require_positive(self.lambda_phi_m, "lambda_phi_m"))
        has_capacitance = self.spin_capacitance_As_per_V_m3 is not None
        has_density_of_states = self.density_of_states_per_spin_Jinv_m3 is not None
        if (has_capacitance or has_density_of_states) != (self.capacitance_formula_version is not None):
            raise ValueError(
                "spin capacitance/DOS and capacitance_formula_version must be authored together"
            )
        if has_capacitance:
            object.__setattr__(
                self,
                "spin_capacitance_As_per_V_m3",
                require_positive(
                    self.spin_capacitance_As_per_V_m3,
                    "spin_capacitance_As_per_V_m3",
                ),
            )
            object.__setattr__(
                self,
                "capacitance_formula_version",
                require_non_empty(self.capacitance_formula_version, "capacitance_formula_version"),
            )
            if self.capacitance_formula_version != DOS_ISOTROPIC_NONMAGNETIC_CAPACITANCE_FORMULA:
                raise ValueError(
                    "capacitance_formula_version must be "
                    f"'{DOS_ISOTROPIC_NONMAGNETIC_CAPACITANCE_FORMULA}'"
                )
        if has_density_of_states:
            density_of_states = require_positive(
                self.density_of_states_per_spin_Jinv_m3,
                "density_of_states_per_spin_Jinv_m3",
            )
            object.__setattr__(
                self,
                "density_of_states_per_spin_Jinv_m3",
                density_of_states,
            )
            if self.capacitance_formula_version != DOS_ISOTROPIC_NONMAGNETIC_CAPACITANCE_FORMULA:
                raise ValueError(
                    "capacitance_formula_version must be "
                    f"'{DOS_ISOTROPIC_NONMAGNETIC_CAPACITANCE_FORMULA}'"
                )
            if has_capacitance:
                expected = ELEMENTARY_CHARGE_C**2 * density_of_states
                if not math.isclose(
                    self.spin_capacitance_As_per_V_m3 or 0.0,
                    expected,
                    rel_tol=1.0e-12,
                    abs_tol=1.0e-300,
                ):
                    raise ValueError(
                        "spin_capacitance_As_per_V_m3 must equal e^2 times "
                        "density_of_states_per_spin_Jinv_m3"
                    )

    def resolved_spin_capacitance_As_per_V_m3(self) -> float | None:
        if self.spin_capacitance_As_per_V_m3 is not None:
            return self.spin_capacitance_As_per_V_m3
        if self.density_of_states_per_spin_Jinv_m3 is not None:
            return ELEMENTARY_CHARGE_C**2 * self.density_of_states_per_spin_Jinv_m3
        return None

    def to_ir(self) -> dict[str, object]:
        value: dict[str, object] = {
            "sigma_s_Spm": self.sigma_s_Spm,
            "polarization_p": self.polarization_p,
            "theta_sh": self.theta_sh,
            "lambda_sf_m": self.lambda_sf_m,
            "lambda_j_m": self.lambda_j_m if self.lambda_j_m is not None else "disabled",
            "lambda_phi_m": self.lambda_phi_m if self.lambda_phi_m is not None else "disabled",
        }
        if self.spin_capacitance_As_per_V_m3 is not None:
            value["spin_capacitance_As_per_V_m3"] = self.spin_capacitance_As_per_V_m3
        if self.density_of_states_per_spin_Jinv_m3 is not None:
            value["density_of_states_per_spin_Jinv_m3"] = self.density_of_states_per_spin_Jinv_m3
        if self.capacitance_formula_version is not None:
            value["capacitance_formula_version"] = self.capacitance_formula_version
        return value


@dataclass(frozen=True, slots=True)
class SpinTransportMaterialAssignment:
    region: RegionRef
    material: SpinTransportMaterial

    def to_ir(self) -> dict[str, object]:
        return {"region": self.region.to_ir(), "material": self.material.to_ir()}


@dataclass(frozen=True, slots=True)
class TransparentSpinInterface:
    id: str
    side_a: RegionRef
    side_b: RegionRef
    normal_a_to_b: tuple[float, float, float]

    def __init__(self, id: str, side_a: RegionRef, side_b: RegionRef, normal_a_to_b: Sequence[float]) -> None:
        object.__setattr__(self, "id", require_non_empty(id, "id"))
        object.__setattr__(self, "side_a", side_a)
        object.__setattr__(self, "side_b", side_b)
        object.__setattr__(self, "normal_a_to_b", _unit_vector(normal_a_to_b, "normal_a_to_b"))

    def to_ir(self) -> dict[str, object]:
        return {"kind": "transparent", "id": self.id, "side_a": self.side_a.to_ir(), "side_b": self.side_b.to_ir(), "normal_a_to_b": list(self.normal_a_to_b)}


@dataclass(frozen=True, slots=True)
class SpinMemoryLossReservoir:
    """Statically eliminated SML reservoir with three dissipative branches."""

    g_n_Spm2: float
    g_f_Spm2: float
    g_lattice_Spm2: float
    formula_version: str = "sml_reservoir.fullmag.v2"

    def __post_init__(self) -> None:
        for name in ("g_n_Spm2", "g_f_Spm2"):
            value = require_finite(getattr(self, name), name)
            if value < 0.0:
                raise ValueError(f"{name} must be >= 0")
            object.__setattr__(self, name, value)
        object.__setattr__(
            self,
            "g_lattice_Spm2",
            require_positive(self.g_lattice_Spm2, "g_lattice_Spm2"),
        )
        version = require_non_empty(self.formula_version, "formula_version")
        if version != "sml_reservoir.fullmag.v2":
            raise ValueError("formula_version must be 'sml_reservoir.fullmag.v2'")
        object.__setattr__(self, "formula_version", version)

    def to_ir(self) -> dict[str, object]:
        return {
            "g_n_Spm2": self.g_n_Spm2,
            "g_f_Spm2": self.g_f_Spm2,
            "g_lattice_Spm2": self.g_lattice_Spm2,
            "formula_version": self.formula_version,
        }


@dataclass(frozen=True, slots=True)
class MixingConductanceSpinInterface:
    id: str
    normal_to_ferromagnet: tuple[float, float, float]
    normal_side: RegionRef
    ferromagnet_side: RegionRef
    g_up_Spm2: float
    g_down_Spm2: float
    g_r_Spm2: float
    g_i_Spm2: float
    spin_memory_loss: SpinMemoryLossReservoir | None = None

    def __init__(self, *, id: str, normal_to_ferromagnet: Sequence[float], normal_side: RegionRef, ferromagnet_side: RegionRef, g_up_Spm2: float, g_down_Spm2: float, g_r_Spm2: float, g_i_Spm2: float, spin_memory_loss: SpinMemoryLossReservoir | None = None) -> None:
        object.__setattr__(self, "id", require_non_empty(id, "id"))
        object.__setattr__(self, "normal_to_ferromagnet", _unit_vector(normal_to_ferromagnet, "normal_to_ferromagnet"))
        object.__setattr__(self, "normal_side", normal_side)
        object.__setattr__(self, "ferromagnet_side", ferromagnet_side)
        for name, value in (("g_up_Spm2", g_up_Spm2), ("g_down_Spm2", g_down_Spm2), ("g_r_Spm2", g_r_Spm2)):
            finite = require_finite(value, name)
            if finite < 0.0:
                raise ValueError(f"{name} must be >= 0")
            object.__setattr__(self, name, finite)
        object.__setattr__(self, "g_i_Spm2", require_finite(g_i_Spm2, "g_i_Spm2"))
        object.__setattr__(self, "spin_memory_loss", spin_memory_loss)

    def to_ir(self) -> dict[str, object]:
        value: dict[str, object] = {
            "kind": "mixing_conductance", "id": self.id,
            "normal_to_ferromagnet": list(self.normal_to_ferromagnet),
            "normal_side": self.normal_side.to_ir(), "ferromagnet_side": self.ferromagnet_side.to_ir(),
            "g_up_Spm2": self.g_up_Spm2, "g_down_Spm2": self.g_down_Spm2,
            "g_r_Spm2": self.g_r_Spm2, "g_i_Spm2": self.g_i_Spm2,
            "absorption": "full_absorption", "formula_version": "magnetoelectronic.fullmag.v2",
        }
        if self.spin_memory_loss is not None:
            value["spin_memory_loss"] = self.spin_memory_loss.to_ir()
        return value


@dataclass(frozen=True, slots=True)
class _SurfaceBoundary:
    id: str
    surfaces: tuple[SurfaceRef, ...]
    kind: str

    def __init__(self, id: str, surfaces: Sequence[SurfaceRef], *, kind: str) -> None:
        resolved = tuple(surfaces)
        if not resolved:
            raise ValueError("surfaces must not be empty")
        object.__setattr__(self, "id", require_non_empty(id, "id"))
        object.__setattr__(self, "surfaces", resolved)
        object.__setattr__(self, "kind", kind)

    def to_ir(self) -> dict[str, object]:
        return {"kind": self.kind, "id": self.id, "surfaces": [surface.to_ir() for surface in self.surfaces]}


class SpinInsulating(_SurfaceBoundary):
    def __init__(self, id: str, surfaces: Sequence[SurfaceRef]) -> None:
        super().__init__(id, surfaces, kind="spin_insulating")


class SpinSink(_SurfaceBoundary):
    def __init__(self, id: str, surfaces: Sequence[SurfaceRef]) -> None:
        super().__init__(id, surfaces, kind="spin_sink")


@dataclass(frozen=True, slots=True)
class SpecifiedSpinPotential(_SurfaceBoundary):
    spin_potential_V: tuple[float, float, float]

    def __init__(self, id: str, surfaces: Sequence[SurfaceRef], spin_potential_V: Sequence[float]) -> None:
        _SurfaceBoundary.__init__(self, id, surfaces, kind="specified_spin_potential")
        object.__setattr__(self, "spin_potential_V", as_vector3(spin_potential_V, "spin_potential_V"))

    def to_ir(self) -> dict[str, object]:
        return {
            **_SurfaceBoundary.to_ir(self),
            "spin_potential_V": list(self.spin_potential_V),
        }


@dataclass(frozen=True, slots=True)
class SpecifiedSpinFlux(_SurfaceBoundary):
    normal_spin_flux_Apm2: tuple[float, float, float]

    def __init__(self, id: str, surfaces: Sequence[SurfaceRef], normal_spin_flux_Apm2: Sequence[float]) -> None:
        _SurfaceBoundary.__init__(self, id, surfaces, kind="specified_spin_flux")
        object.__setattr__(self, "normal_spin_flux_Apm2", as_vector3(normal_spin_flux_Apm2, "normal_spin_flux_Apm2"))

    def to_ir(self) -> dict[str, object]:
        return {
            **_SurfaceBoundary.to_ir(self),
            "normal_spin_flux_Apm2": list(self.normal_spin_flux_Apm2),
        }


@dataclass(frozen=True, slots=True)
class PeriodicSpin:
    id: str
    minus_surface: SurfaceRef
    plus_surface: SurfaceRef
    translation_m: tuple[float, float, float]

    def __init__(self, id: str, minus_surface: SurfaceRef, plus_surface: SurfaceRef, translation_m: Sequence[float]) -> None:
        translation = as_vector3(translation_m, "translation_m")
        if math.hypot(*translation) == 0.0:
            raise ValueError("translation_m must be non-zero")
        object.__setattr__(self, "id", require_non_empty(id, "id"))
        object.__setattr__(self, "minus_surface", minus_surface)
        object.__setattr__(self, "plus_surface", plus_surface)
        object.__setattr__(self, "translation_m", translation)

    def to_ir(self) -> dict[str, object]:
        return {"kind": "periodic_spin", "id": self.id, "minus_surface": self.minus_surface.to_ir(), "plus_surface": self.plus_surface.to_ir(), "translation_m": list(self.translation_m)}


@dataclass(frozen=True, slots=True)
class ReciprocalNonlinearSolverPolicy:
    """Scaled Picard/GMRES policy for the steady reciprocal M2 block.

    ``gmres_restart`` is the initial Krylov basis length.  The FDM reference
    lane may grow it after a residual plateau while preserving the requested
    maximum-iteration budget.  Its CPU reference realization may also use
    multiplicative block-line sweeps and a neutral voltage cold start; these
    are numerical policies and do not alter the reciprocal M2 equations.
    """

    gmres_restart: int = 40
    max_picard_iterations: int = 4
    relative_update_tolerance: float = 1.0e-9
    eta_transport: float = 0.1

    def __post_init__(self) -> None:
        if self.gmres_restart <= 0:
            raise ValueError("gmres_restart must be > 0")
        if self.max_picard_iterations <= 0:
            raise ValueError("max_picard_iterations must be > 0")
        relative = require_finite(
            self.relative_update_tolerance,
            "relative_update_tolerance",
        )
        eta = require_finite(self.eta_transport, "eta_transport")
        if relative <= 0.0:
            raise ValueError("relative_update_tolerance must be > 0")
        if not 0.0 < eta <= 1.0:
            raise ValueError("eta_transport must be in (0, 1]")
        object.__setattr__(self, "relative_update_tolerance", relative)
        object.__setattr__(self, "eta_transport", eta)

    def to_ir(self) -> dict[str, object]:
        return {
            "gmres_restart": self.gmres_restart,
            "max_picard_iterations": self.max_picard_iterations,
            "relative_update_tolerance": self.relative_update_tolerance,
            "eta_transport": self.eta_transport,
        }


@dataclass(frozen=True, slots=True)
class SpinSolverPolicy:
    engine: str = "auto"
    relative_tolerance: float = 1.0e-8
    absolute_tolerance: float = 0.0
    max_iterations: int = 500
    operator_version: str = "fv_spin_upwind_v1"
    default_external_boundary: str = "spin_insulating"
    reciprocal_nonlinear: ReciprocalNonlinearSolverPolicy | None = None

    def __post_init__(self) -> None:
        require_non_empty(self.engine, "engine")
        require_positive(self.relative_tolerance, "relative_tolerance")
        if self.absolute_tolerance < 0.0 or not math.isfinite(self.absolute_tolerance):
            raise ValueError("absolute_tolerance must be finite and >= 0")
        if self.max_iterations <= 0:
            raise ValueError("max_iterations must be > 0")
        if self.default_external_boundary not in {"spin_insulating", "reject_unassigned"}:
            raise ValueError("invalid default_external_boundary")

    def to_ir(self) -> dict[str, object]:
        value: dict[str, object] = {
            "engine": self.engine,
            "linear": {"relative_tolerance": self.relative_tolerance, "absolute_tolerance": self.absolute_tolerance, "max_iterations": self.max_iterations},
            "physical_residual_version": "transport_balance_integrated_l2.v1",
            "operator_version": self.operator_version,
            "default_external_boundary": self.default_external_boundary,
        }
        if self.reciprocal_nonlinear is not None:
            value["reciprocal_nonlinear"] = self.reciprocal_nonlinear.to_ir()
        return value


@dataclass(frozen=True, slots=True)
class SpinDriftDiffusion:
    id: str
    current_source_id: str
    domain: tuple[RegionRef, ...]
    materials: tuple[SpinTransportMaterialAssignment, ...]
    interfaces: tuple[TransparentSpinInterface | MixingConductanceSpinInterface, ...] = ()
    boundaries: tuple[_SurfaceBoundary | PeriodicSpin, ...] = ()
    solver: SpinSolverPolicy = SpinSolverPolicy()
    requested_execution: TransportExecution = TransportExecution()
    mode: str = "steady"

    def __init__(self, *, id: str, current_source_id: str, domain: Sequence[RegionRef], materials: Sequence[SpinTransportMaterialAssignment], interfaces: Sequence[TransparentSpinInterface | MixingConductanceSpinInterface] = (), boundaries: Sequence[_SurfaceBoundary | PeriodicSpin] = (), solver: SpinSolverPolicy | None = None, requested_execution: TransportExecution | None = None, mode: str = "steady") -> None:
        if mode not in {"steady", "transient"}:
            raise ValueError("mode must be 'steady' or 'transient'")
        resolved_domain = tuple(domain)
        if not resolved_domain:
            raise ValueError("domain must not be empty")
        object.__setattr__(self, "id", require_non_empty(id, "id"))
        object.__setattr__(self, "current_source_id", require_non_empty(current_source_id, "current_source_id"))
        object.__setattr__(self, "domain", resolved_domain)
        resolved_materials = tuple(materials)
        if not resolved_materials:
            raise ValueError("materials must not be empty")
        if not all(isinstance(item, SpinTransportMaterialAssignment) for item in resolved_materials):
            raise TypeError("materials must contain SpinTransportMaterialAssignment values")
        if mode == "transient" and any(
            item.material.resolved_spin_capacitance_As_per_V_m3() is None
            for item in resolved_materials
        ):
            raise ValueError(
                "transient SpinDriftDiffusion requires physical spin_capacitance_As_per_V_m3 "
                "and capacitance_formula_version for every material"
            )
        object.__setattr__(self, "materials", resolved_materials)
        object.__setattr__(self, "interfaces", tuple(interfaces))
        object.__setattr__(self, "boundaries", tuple(boundaries))
        object.__setattr__(self, "solver", solver or SpinSolverPolicy())
        object.__setattr__(self, "requested_execution", requested_execution or TransportExecution())
        object.__setattr__(self, "mode", mode)

    def to_ir(self, *, coupling: str | None = None) -> dict[str, object]:
        resolved_coupling = coupling or "one_way"
        if resolved_coupling not in {"one_way", "bidirectional"}:
            raise ValueError("coupling must be 'one_way' or 'bidirectional'")
        return {
            "schema_version": "spin_transport.v1", "id": self.id,
            "current_source_id": self.current_source_id,
            "domain": [region.to_ir() for region in self.domain], "mode": self.mode,
            "materials": [assignment.to_ir() for assignment in self.materials],
            "interfaces": [interface.to_ir() for interface in self.interfaces],
            "boundaries": [boundary.to_ir() for boundary in self.boundaries],
            "solver": self.solver.to_ir(), "requested_execution": self.requested_execution.to_ir(),
            "constitutive_version": (
                "transport_constitutive.reciprocal.fullmag.v1"
                if resolved_coupling == "bidirectional"
                else "transport_constitutive.one_way.fullmag.v1"
            ),
        }


@dataclass(frozen=True, slots=True)
class DriftDiffusionSpinTorque:
    id: str
    solve_id: str
    target: RegionRef

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", require_non_empty(self.id, "id"))
        object.__setattr__(self, "solve_id", require_non_empty(self.solve_id, "solve_id"))

    def to_ir_module(self) -> dict[str, object]:
        return {"kind": "drift_diffusion_spin_torque", "schema_version": "drift_diffusion_spin_torque.v1", "id": self.id, "solve_id": self.solve_id, "target": self.target.to_ir(), "formula_version": "transport_torque_angular_momentum.fullmag.v1"}


__all__ = [name for name in globals() if not name.startswith("_") and name not in {"math", "Sequence"}]
