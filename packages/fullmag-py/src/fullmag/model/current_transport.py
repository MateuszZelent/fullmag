from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Sequence

from fullmag._validation import (
    as_vector3,
    require_finite,
    require_non_empty,
    require_positive,
    require_positive_int,
)
from fullmag.model.spin_torque import RegionRef
from fullmag.model.spin_transport import SurfaceRef

CURRENT_TRANSPORT_MODELS = {
    "prescribed_density",
    "ohmic_poisson",
    "magnetoresistive_poisson",
}
CURRENT_TRANSPORT_COUPLINGS = {"one_way", "bidirectional"}


@dataclass(frozen=True, slots=True)
class ChargeTransportMaterial:
    sigma_Spm: float
    sigma_parallel_Spm: float | None = None
    sigma_perpendicular_Spm: float | None = None
    sigma_AHE_Spm: float | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "sigma_Spm", require_positive(self.sigma_Spm, "sigma_Spm"))
        anisotropic = (
            self.sigma_parallel_Spm,
            self.sigma_perpendicular_Spm,
            self.sigma_AHE_Spm,
        )
        if any(value is not None for value in anisotropic) and not all(
            value is not None for value in anisotropic
        ):
            raise ValueError(
                "sigma_parallel_Spm, sigma_perpendicular_Spm, and sigma_AHE_Spm "
                "must be authored together"
            )
        if self.sigma_parallel_Spm is not None:
            object.__setattr__(
                self,
                "sigma_parallel_Spm",
                require_positive(self.sigma_parallel_Spm, "sigma_parallel_Spm"),
            )
            object.__setattr__(
                self,
                "sigma_perpendicular_Spm",
                require_positive(
                    self.sigma_perpendicular_Spm,
                    "sigma_perpendicular_Spm",
                ),
            )
            object.__setattr__(
                self,
                "sigma_AHE_Spm",
                require_finite(self.sigma_AHE_Spm, "sigma_AHE_Spm"),
            )

    def to_ir(self) -> dict[str, float]:
        value: dict[str, float] = {"sigma_Spm": self.sigma_Spm}
        if self.sigma_parallel_Spm is not None:
            value.update(
                {
                    "sigma_parallel_Spm": self.sigma_parallel_Spm,
                    "sigma_perpendicular_Spm": self.sigma_perpendicular_Spm,
                    "sigma_AHE_Spm": self.sigma_AHE_Spm,
                }
            )
        return value


@dataclass(frozen=True, slots=True)
class ChargeTransportMaterialAssignment:
    region: RegionRef
    material: ChargeTransportMaterial

    def to_ir(self) -> dict[str, object]:
        return {"region": self.region.to_ir(), "material": self.material.to_ir()}


class ChargeBoundary(Protocol):
    def to_ir(self) -> dict[str, object]: ...


def _boundary_base(kind: str, id: str, surfaces: Sequence[SurfaceRef]) -> dict[str, object]:
    normalized_surfaces = tuple(surfaces)
    if not normalized_surfaces:
        raise ValueError("charge boundary surfaces must not be empty")
    if not all(isinstance(surface, SurfaceRef) for surface in normalized_surfaces):
        raise TypeError("charge boundary surfaces must contain SurfaceRef values")
    return {
        "kind": kind,
        "id": require_non_empty(id, "id"),
        "surfaces": [surface.to_ir() for surface in normalized_surfaces],
    }


@dataclass(frozen=True, slots=True)
class VoltageElectrode:
    id: str
    surfaces: tuple[SurfaceRef, ...]
    potential_V: float

    def __init__(self, id: str, surfaces: Sequence[SurfaceRef], *, potential_V: float) -> None:
        object.__setattr__(self, "id", require_non_empty(id, "id"))
        normalized = tuple(surfaces)
        _boundary_base("voltage_electrode", id, normalized)
        object.__setattr__(self, "surfaces", normalized)
        object.__setattr__(self, "potential_V", require_finite(potential_V, "potential_V"))

    def to_ir(self) -> dict[str, object]:
        return {**_boundary_base("voltage_electrode", self.id, self.surfaces), "potential_V": self.potential_V}


@dataclass(frozen=True, slots=True)
class NormalCurrentElectrode:
    id: str
    surfaces: tuple[SurfaceRef, ...]
    outward_current_density_Apm2: float

    def __init__(
        self,
        id: str,
        surfaces: Sequence[SurfaceRef],
        *,
        outward_current_density_Apm2: float,
    ) -> None:
        object.__setattr__(self, "id", require_non_empty(id, "id"))
        normalized = tuple(surfaces)
        _boundary_base("normal_current_electrode", id, normalized)
        object.__setattr__(self, "surfaces", normalized)
        object.__setattr__(
            self,
            "outward_current_density_Apm2",
            require_finite(outward_current_density_Apm2, "outward_current_density_Apm2"),
        )

    def to_ir(self) -> dict[str, object]:
        return {
            **_boundary_base("normal_current_electrode", self.id, self.surfaces),
            "outward_current_density_Apm2": self.outward_current_density_Apm2,
        }


@dataclass(frozen=True, slots=True)
class ChargeInsulating:
    id: str
    surfaces: tuple[SurfaceRef, ...]

    def __init__(self, id: str, surfaces: Sequence[SurfaceRef]) -> None:
        object.__setattr__(self, "id", require_non_empty(id, "id"))
        normalized = tuple(surfaces)
        _boundary_base("insulating", id, normalized)
        object.__setattr__(self, "surfaces", normalized)

    def to_ir(self) -> dict[str, object]:
        return _boundary_base("insulating", self.id, self.surfaces)


@dataclass(frozen=True, slots=True)
class ChargePotentialGauge:
    kind: str

    def __post_init__(self) -> None:
        normalized = require_non_empty(self.kind, "gauge").lower()
        if normalized not in {"dirichlet_reference", "zero_mean"}:
            raise ValueError("gauge must be 'dirichlet_reference' or 'zero_mean'")
        object.__setattr__(self, "kind", normalized)

    def to_ir(self) -> str:
        return self.kind


@dataclass(frozen=True, slots=True)
class ChargeSolverPolicy:
    engine: str = "cg"
    relative_tolerance: float = 1.0e-10
    absolute_tolerance: float = 0.0
    max_iterations: int = 10_000
    physical_residual_version: str = "charge_balance_integrated_l2.v1"
    operator_version: str = "fv_charge_harmonic_v1"

    def __post_init__(self) -> None:
        engine = require_non_empty(self.engine, "engine")
        if engine not in {"cg", "block_gmres"}:
            raise ValueError("charge engine must be 'cg' or 'block_gmres'")
        relative = require_finite(self.relative_tolerance, "relative_tolerance")
        absolute = require_finite(self.absolute_tolerance, "absolute_tolerance")
        if relative <= 0.0 or absolute < 0.0:
            raise ValueError("charge solver requires relative_tolerance > 0 and absolute_tolerance >= 0")
        expected_operator = (
            "fv_charge_harmonic_v1"
            if engine == "cg"
            else "fdm_coupled_charge_spin_fv_block_gmres.v1"
        )
        if self.operator_version != expected_operator:
            raise ValueError(
                f"charge solver engine '{engine}' requires operator_version='{expected_operator}'"
            )
        object.__setattr__(self, "engine", engine)
        object.__setattr__(self, "relative_tolerance", relative)
        object.__setattr__(self, "absolute_tolerance", absolute)
        object.__setattr__(self, "max_iterations", require_positive_int(self.max_iterations, "max_iterations"))
        expected_residual = (
            "charge_balance_integrated_l2.v1"
            if engine == "cg"
            else "transport_balance_integrated_l2.v1"
        )
        physical_residual = self.physical_residual_version
        # Keep the one-way default source-compatible while resolving the
        # reciprocal block to its transport-balance residual contract.
        if engine == "block_gmres" and physical_residual == "charge_balance_integrated_l2.v1":
            physical_residual = expected_residual
        if physical_residual != expected_residual:
            raise ValueError("unsupported charge physical_residual_version for engine")
        object.__setattr__(self, "physical_residual_version", physical_residual)
        if self.operator_version not in {
            "fv_charge_harmonic_v1",
            "fdm_coupled_charge_spin_fv_block_gmres.v1",
        }:
            raise ValueError("unsupported charge operator_version")

    def to_ir(self) -> dict[str, object]:
        return {
            "engine": self.engine,
            "linear": {
                "relative_tolerance": self.relative_tolerance,
                "absolute_tolerance": self.absolute_tolerance,
                "max_iterations": self.max_iterations,
            },
            "physical_residual_version": self.physical_residual_version,
            "operator_version": self.operator_version,
        }


@dataclass(frozen=True, slots=True)
class CurrentTransport:
    """Charge-current transport module for torque and device-level workflows.

    Current executable subset:
    - ``model="prescribed_density"`` on the public FDM path

    Authoring/reference contract (backend qualification remains explicit):
    - ``model="ohmic_poisson"`` with ``coupling="bidirectional"`` lowers to
      ``magnetoresistive_poisson`` and requires the reciprocal M2 parameters.
    """

    name: str
    model: str = "prescribed_density"
    current_density: tuple[float, float, float] | None = None
    solve_region: str | None = None
    conductivity_s_per_m: float | None = None
    coupling: str = "one_way"
    domain: tuple[RegionRef, ...] = ()
    materials: tuple[ChargeTransportMaterialAssignment, ...] = ()
    boundaries: tuple[ChargeBoundary, ...] = ()
    gauge: ChargePotentialGauge | None = None
    solver: ChargeSolverPolicy | None = None

    def __init__(
        self,
        *,
        name: str,
        model: str = "prescribed_density",
        current_density: Sequence[float] | None = None,
        solve_region: str | None = None,
        conductivity_s_per_m: float | None = None,
        coupling: str = "one_way",
        domain: Sequence[RegionRef] = (),
        materials: Sequence[ChargeTransportMaterialAssignment] = (),
        boundaries: Sequence[ChargeBoundary] = (),
        gauge: ChargePotentialGauge | None = None,
        solver: ChargeSolverPolicy | None = None,
    ) -> None:
        raw_model = require_non_empty(model, "model").lower()
        resolved_magnetoresistive_model = raw_model == "magnetoresistive_poisson"
        normalized_model = "ohmic_poisson" if resolved_magnetoresistive_model else raw_model
        if normalized_model not in CURRENT_TRANSPORT_MODELS:
            raise ValueError(
                f"model must be one of {sorted(CURRENT_TRANSPORT_MODELS)}, got {model!r}"
            )

        object.__setattr__(self, "name", require_non_empty(name, "name"))
        object.__setattr__(self, "model", normalized_model)
        object.__setattr__(
            self,
            "current_density",
            as_vector3(current_density, "current_density") if current_density is not None else None,
        )

        normalized_domain = tuple(domain)
        normalized_materials = tuple(materials)
        normalized_boundaries = tuple(boundaries)
        if not all(isinstance(region, RegionRef) for region in normalized_domain):
            raise TypeError("domain must contain RegionRef values")
        if not all(isinstance(item, ChargeTransportMaterialAssignment) for item in normalized_materials):
            raise TypeError("materials must contain ChargeTransportMaterialAssignment values")
        if not all(hasattr(item, "to_ir") for item in normalized_boundaries):
            raise TypeError("boundaries must contain typed charge boundary values")
        object.__setattr__(self, "domain", normalized_domain)
        object.__setattr__(self, "materials", normalized_materials)
        object.__setattr__(self, "boundaries", normalized_boundaries)
        object.__setattr__(self, "gauge", gauge)
        object.__setattr__(self, "solver", solver)
        normalized_coupling = require_non_empty(coupling, "coupling").lower()
        if normalized_coupling not in CURRENT_TRANSPORT_COUPLINGS:
            raise ValueError(f"coupling must be one of {sorted(CURRENT_TRANSPORT_COUPLINGS)}")
        if resolved_magnetoresistive_model and normalized_coupling != "bidirectional":
            raise ValueError(
                "model='magnetoresistive_poisson' requires coupling='bidirectional'"
            )
        if normalized_coupling == "bidirectional" and normalized_model != "ohmic_poisson":
            raise ValueError(
                "bidirectional current transport requires model='ohmic_poisson'"
            )
        object.__setattr__(self, "coupling", normalized_coupling)
        object.__setattr__(
            self,
            "solve_region",
            require_non_empty(solve_region, "solve_region") if solve_region is not None else None,
        )
        if conductivity_s_per_m is not None:
            require_positive(conductivity_s_per_m, "conductivity_s_per_m")
        object.__setattr__(
            self,
            "conductivity_s_per_m",
            float(conductivity_s_per_m) if conductivity_s_per_m is not None else None,
        )

        if normalized_model == "prescribed_density":
            if current_density is None:
                raise ValueError(
                    "current_density is required for CurrentTransport(model='prescribed_density')"
                )
        elif current_density is not None:
            raise ValueError(
                "current_density is not valid for CurrentTransport(model='ohmic_poisson')"
            )
        elif (
            not normalized_domain
            or not normalized_materials
            or not normalized_boundaries
            or gauge is None
            or solver is None
        ):
            raise ValueError(
                "CurrentTransport(model='ohmic_poisson') requires a complete charge contract: "
                "domain, materials, boundaries, gauge, and solver"
            )
        elif solve_region is not None or conductivity_s_per_m is not None:
            raise ValueError(
                "legacy solve_region/conductivity_s_per_m cannot be mixed with the complete charge contract"
            )

        if normalized_coupling == "bidirectional":
            if any(
                assignment.material.sigma_parallel_Spm is None
                or assignment.material.sigma_perpendicular_Spm is None
                or assignment.material.sigma_AHE_Spm is None
                for assignment in normalized_materials
            ):
                raise ValueError(
                    "bidirectional current transport requires sigma_parallel_Spm, "
                    "sigma_perpendicular_Spm, and sigma_AHE_Spm for every material"
                )
            if solver is None or solver.engine != "block_gmres":
                raise ValueError(
                    "bidirectional current transport requires a block_gmres ChargeSolverPolicy"
                )
        elif any(
            assignment.material.sigma_parallel_Spm is not None
            or assignment.material.sigma_perpendicular_Spm is not None
            or assignment.material.sigma_AHE_Spm is not None
            for assignment in normalized_materials
        ):
            raise ValueError(
                "anisotropic conductivity is valid only for bidirectional current transport"
            )

    def to_ir(self) -> dict[str, object]:
        ir: dict[str, object] = {
            "kind": "current_transport",
            "name": self.name,
            "model": (
                "magnetoresistive_poisson"
                if self.coupling == "bidirectional"
                else self.model
            ),
        }
        if self.current_density is not None:
            ir["current_density"] = list(self.current_density)
        if self.solve_region is not None:
            ir["solve_region"] = self.solve_region
        if self.conductivity_s_per_m is not None:
            ir["conductivity_s_per_m"] = self.conductivity_s_per_m
        ir["coupling"] = self.coupling
        if self.domain:
            ir["domain"] = [region.to_ir() for region in self.domain]
        if self.materials:
            ir["materials"] = [assignment.to_ir() for assignment in self.materials]
        if self.boundaries:
            ir["boundaries"] = [boundary.to_ir() for boundary in self.boundaries]
        if self.gauge is not None:
            ir["gauge"] = self.gauge.to_ir()
        if self.solver is not None:
            ir["solver"] = self.solver.to_ir()
        return ir


__all__ = [
    "CURRENT_TRANSPORT_COUPLINGS",
    "CURRENT_TRANSPORT_MODELS",
    "ChargeInsulating",
    "ChargePotentialGauge",
    "ChargeSolverPolicy",
    "ChargeTransportMaterial",
    "ChargeTransportMaterialAssignment",
    "CurrentTransport",
    "NormalCurrentElectrode",
    "VoltageElectrode",
]
