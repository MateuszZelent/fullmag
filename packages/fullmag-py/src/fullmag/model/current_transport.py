from __future__ import annotations

from dataclasses import dataclass
import math
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
CONSERVATIVE_CURRENT_BOUNDARY_ROLES = {
    "insulating_outer",
    "source_cut",
    "closure_interface",
}


def _finite_vector3(value: Sequence[float], field_name: str) -> tuple[float, float, float]:
    result = as_vector3(value, field_name)
    if not all(math.isfinite(component) for component in result):
        raise ValueError(f"{field_name} must contain only finite values")
    return result


def _canonical_face_vertex_ids(value: Sequence[int], field_name: str) -> tuple[int, int, int]:
    if isinstance(value, (str, bytes)) or len(value) != 3:
        raise ValueError(f"{field_name} must contain exactly three vertex IDs")
    ids = tuple(value)
    if any(isinstance(vertex_id, bool) or not isinstance(vertex_id, int) for vertex_id in ids):
        raise TypeError(f"{field_name} must contain integer vertex IDs")
    if any(vertex_id <= 0 for vertex_id in ids):
        raise ValueError(f"{field_name} must contain positive vertex IDs")
    canonical = tuple(sorted(ids))
    if len(set(canonical)) != 3:
        raise ValueError(f"{field_name} must contain three distinct vertex IDs")
    return canonical  # type: ignore[return-value]


def _stable_vertex_id_list(value: Sequence[int], field_name: str) -> tuple[int, ...]:
    if isinstance(value, (str, bytes)) or not value:
        raise ValueError(f"{field_name} must not be empty")
    ids = tuple(value)
    if any(isinstance(vertex_id, bool) or not isinstance(vertex_id, int) for vertex_id in ids):
        raise TypeError(f"{field_name} must contain integer vertex IDs")
    if any(vertex_id <= 0 for vertex_id in ids):
        raise ValueError(f"{field_name} must contain positive vertex IDs")
    if len(set(ids)) != len(ids):
        raise ValueError(f"{field_name} must contain unique vertex IDs")
    return ids


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
class ConservativeCurrentIdentity:
    """Immutable identity of the accepted charge state consumed by RT0."""

    source_module_id: str
    source_state_revision: str
    source_field_digest: str
    conductivity_digest: str
    mesh_revision: str
    topology_revision: str
    geometry_digest: str
    envelope_revision: str
    envelope_digest: str
    evaluated_envelope_multiplier: float
    evaluation_time_s: float
    stage_identity: int

    def __post_init__(self) -> None:
        for field_name in (
            "source_module_id",
            "source_state_revision",
            "source_field_digest",
            "conductivity_digest",
            "mesh_revision",
            "topology_revision",
            "geometry_digest",
            "envelope_revision",
            "envelope_digest",
        ):
            object.__setattr__(self, field_name, require_non_empty(getattr(self, field_name), field_name))
        object.__setattr__(
            self,
            "evaluated_envelope_multiplier",
            require_finite(self.evaluated_envelope_multiplier, "evaluated_envelope_multiplier"),
        )
        object.__setattr__(self, "evaluation_time_s", require_finite(self.evaluation_time_s, "evaluation_time_s"))
        object.__setattr__(self, "stage_identity", require_positive_int(self.stage_identity, "stage_identity"))

    def to_ir(self) -> dict[str, object]:
        return {
            "source_module_id": self.source_module_id,
            "source_state_revision": self.source_state_revision,
            "source_field_digest": self.source_field_digest,
            "conductivity_digest": self.conductivity_digest,
            "mesh_revision": self.mesh_revision,
            "topology_revision": self.topology_revision,
            "geometry_digest": self.geometry_digest,
            "envelope_revision": self.envelope_revision,
            "envelope_digest": self.envelope_digest,
            "evaluated_envelope_multiplier": self.evaluated_envelope_multiplier,
            "evaluation_time_s": self.evaluation_time_s,
            "stage_identity": self.stage_identity,
        }


@dataclass(frozen=True, slots=True)
class ConservativeCurrentPins:
    """Required source/mesh identities checked before the native solve."""

    required_source_state_revision: str
    required_source_field_digest: str
    required_mesh_revision: str
    required_topology_revision: str

    def __post_init__(self) -> None:
        for field_name in (
            "required_source_state_revision",
            "required_source_field_digest",
            "required_mesh_revision",
            "required_topology_revision",
        ):
            object.__setattr__(self, field_name, require_non_empty(getattr(self, field_name), field_name))

    def to_ir(self) -> dict[str, str]:
        return {
            "required_source_state_revision": self.required_source_state_revision,
            "required_source_field_digest": self.required_source_field_digest,
            "required_mesh_revision": self.required_mesh_revision,
            "required_topology_revision": self.required_topology_revision,
        }


@dataclass(frozen=True, slots=True)
class ConservativeCurrentBoundaryFace:
    """Authored classification of one canonical triangular FEM boundary face."""

    face_vertex_ids: tuple[int, int, int]
    role: str
    circuit_id: str | None = None

    def __init__(
        self,
        face_vertex_ids: Sequence[int],
        role: str,
        circuit_id: str | None = None,
    ) -> None:
        canonical = _canonical_face_vertex_ids(face_vertex_ids, "face_vertex_ids")
        normalized_role = require_non_empty(role, "role").lower()
        if normalized_role not in CONSERVATIVE_CURRENT_BOUNDARY_ROLES:
            raise ValueError(
                "role must be one of 'insulating_outer', 'source_cut', or 'closure_interface'"
            )
        normalized_circuit = (
            require_non_empty(circuit_id, "circuit_id") if circuit_id is not None else None
        )
        if normalized_role == "insulating_outer" and normalized_circuit is not None:
            raise ValueError("insulating_outer boundary faces must not define circuit_id")
        if normalized_role != "insulating_outer" and normalized_circuit is None:
            raise ValueError(f"{normalized_role} boundary faces require circuit_id")
        object.__setattr__(self, "face_vertex_ids", canonical)
        object.__setattr__(self, "role", normalized_role)
        object.__setattr__(self, "circuit_id", normalized_circuit)

    def to_ir(self) -> dict[str, object]:
        value: dict[str, object] = {
            "face_vertex_ids": list(self.face_vertex_ids),
            "role": self.role,
        }
        if self.circuit_id is not None:
            value["circuit_id"] = self.circuit_id
        return value


@dataclass(frozen=True, slots=True)
class ConservativeCurrentSourceCutFacePair:
    minus_face_vertex_ids: tuple[int, int, int]
    plus_face_vertex_ids: tuple[int, int, int]

    def __init__(
        self,
        minus_face_vertex_ids: Sequence[int],
        plus_face_vertex_ids: Sequence[int],
    ) -> None:
        minus = _canonical_face_vertex_ids(minus_face_vertex_ids, "minus_face_vertex_ids")
        plus = _canonical_face_vertex_ids(plus_face_vertex_ids, "plus_face_vertex_ids")
        if minus == plus:
            raise ValueError("source-cut minus and plus faces must be distinct")
        object.__setattr__(
            self,
            "minus_face_vertex_ids",
            minus,
        )
        object.__setattr__(
            self,
            "plus_face_vertex_ids",
            plus,
        )

    def to_ir(self) -> dict[str, object]:
        return {
            "minus_face_vertex_ids": list(self.minus_face_vertex_ids),
            "plus_face_vertex_ids": list(self.plus_face_vertex_ids),
        }


@dataclass(frozen=True, slots=True)
class ConservativeCurrentSourceCut:
    id: str
    translation_m: tuple[float, float, float]
    potential_drop_v: float
    face_pairs: tuple[ConservativeCurrentSourceCutFacePair, ...]

    def __init__(
        self,
        id: str,
        translation_m: Sequence[float],
        potential_drop_v: float,
        face_pairs: Sequence[ConservativeCurrentSourceCutFacePair],
    ) -> None:
        normalized_pairs = tuple(face_pairs)
        if not normalized_pairs or not all(
            isinstance(pair, ConservativeCurrentSourceCutFacePair) for pair in normalized_pairs
        ):
            raise ValueError("face_pairs must contain at least one ConservativeCurrentSourceCutFacePair")
        object.__setattr__(self, "id", require_non_empty(id, "id"))
        object.__setattr__(self, "translation_m", _finite_vector3(translation_m, "translation_m"))
        if all(value == 0.0 for value in self.translation_m):
            raise ValueError("translation_m must be non-zero")
        object.__setattr__(self, "potential_drop_v", require_finite(potential_drop_v, "potential_drop_v"))
        object.__setattr__(self, "face_pairs", normalized_pairs)

    def to_ir(self) -> dict[str, object]:
        return {
            "id": self.id,
            "translation_m": list(self.translation_m),
            "potential_drop_v": self.potential_drop_v,
            "face_pairs": [pair.to_ir() for pair in self.face_pairs],
        }


@dataclass(frozen=True, slots=True)
class ConservativeCurrentClosedGeometry:
    operator_version: str
    revision: str
    digest: str
    source_cuts: tuple[ConservativeCurrentSourceCut, ...]

    def __init__(
        self,
        operator_version: str,
        revision: str,
        digest: str,
        source_cuts: Sequence[ConservativeCurrentSourceCut],
    ) -> None:
        normalized_cuts = tuple(source_cuts)
        if not normalized_cuts or not all(
            isinstance(cut, ConservativeCurrentSourceCut) for cut in normalized_cuts
        ):
            raise ValueError("source_cuts must contain at least one ConservativeCurrentSourceCut")
        object.__setattr__(self, "operator_version", require_non_empty(operator_version, "operator_version"))
        object.__setattr__(self, "revision", require_non_empty(revision, "revision"))
        object.__setattr__(self, "digest", require_non_empty(digest, "digest"))
        object.__setattr__(self, "source_cuts", normalized_cuts)

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "closed_geometry",
            "operator_version": self.operator_version,
            "revision": self.revision,
            "digest": self.digest,
            "source_cuts": [cut.to_ir() for cut in self.source_cuts],
        }


@dataclass(frozen=True, slots=True)
class ConservativeCurrentView:
    """Public, closure-aware FEM current view; no H1-to-RT0 fallback is implied."""

    stable_vertex_ids: tuple[int, ...]
    boundary_faces: tuple[ConservativeCurrentBoundaryFace, ...]
    identity: ConservativeCurrentIdentity
    pins: ConservativeCurrentPins
    closure: ConservativeCurrentClosedGeometry
    algebraic_relative_tolerance: float
    physical_relative_gate: float
    physical_absolute_gate_a: float
    reference_mpi_gather_broadcast: bool = False

    def __init__(
        self,
        *,
        stable_vertex_ids: Sequence[int],
        boundary_faces: Sequence[ConservativeCurrentBoundaryFace],
        identity: ConservativeCurrentIdentity,
        pins: ConservativeCurrentPins,
        closure: ConservativeCurrentClosedGeometry,
        algebraic_relative_tolerance: float,
        physical_relative_gate: float,
        physical_absolute_gate_a: float,
        reference_mpi_gather_broadcast: bool = False,
    ) -> None:
        normalized_faces = tuple(boundary_faces)
        if not normalized_faces or not all(
            isinstance(face, ConservativeCurrentBoundaryFace) for face in normalized_faces
        ):
            raise ValueError("boundary_faces must contain at least one ConservativeCurrentBoundaryFace")
        if not isinstance(identity, ConservativeCurrentIdentity):
            raise TypeError("identity must be ConservativeCurrentIdentity")
        if not isinstance(pins, ConservativeCurrentPins):
            raise TypeError("pins must be ConservativeCurrentPins")
        if not isinstance(closure, ConservativeCurrentClosedGeometry):
            raise TypeError("closure must be ConservativeCurrentClosedGeometry")
        object.__setattr__(self, "stable_vertex_ids", _stable_vertex_id_list(stable_vertex_ids, "stable_vertex_ids"))
        object.__setattr__(self, "boundary_faces", normalized_faces)
        object.__setattr__(self, "identity", identity)
        object.__setattr__(self, "pins", pins)
        object.__setattr__(self, "closure", closure)
        object.__setattr__(
            self,
            "algebraic_relative_tolerance",
            require_positive(algebraic_relative_tolerance, "algebraic_relative_tolerance"),
        )
        object.__setattr__(self, "physical_relative_gate", require_positive(physical_relative_gate, "physical_relative_gate"))
        object.__setattr__(self, "physical_absolute_gate_a", require_positive(physical_absolute_gate_a, "physical_absolute_gate_a"))
        if not isinstance(reference_mpi_gather_broadcast, bool):
            raise TypeError("reference_mpi_gather_broadcast must be boolean")
        object.__setattr__(self, "reference_mpi_gather_broadcast", reference_mpi_gather_broadcast)

    def to_ir(self) -> dict[str, object]:
        return {
            "stable_vertex_ids": list(self.stable_vertex_ids),
            "boundary_faces": [face.to_ir() for face in self.boundary_faces],
            "identity": self.identity.to_ir(),
            "pins": self.pins.to_ir(),
            "closure": self.closure.to_ir(),
            "algebraic_relative_tolerance": self.algebraic_relative_tolerance,
            "physical_relative_gate": self.physical_relative_gate,
            "physical_absolute_gate_a": self.physical_absolute_gate_a,
            "reference_mpi_gather_broadcast": self.reference_mpi_gather_broadcast,
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
    conservative_current_view: ConservativeCurrentView | None = None

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
        conservative_current_view: ConservativeCurrentView | None = None,
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
        if conservative_current_view is not None and not isinstance(
            conservative_current_view, ConservativeCurrentView
        ):
            raise TypeError("conservative_current_view must be ConservativeCurrentView")
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
        if conservative_current_view is not None and (
            normalized_model != "ohmic_poisson" or normalized_coupling != "one_way"
        ):
            raise ValueError(
                "conservative_current_view currently requires model='ohmic_poisson' and coupling='one_way'"
            )
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
        object.__setattr__(self, "conservative_current_view", conservative_current_view)

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
        if self.conservative_current_view is not None:
            ir["conservative_current_view"] = self.conservative_current_view.to_ir()
        return ir


__all__ = [
    "CURRENT_TRANSPORT_COUPLINGS",
    "CURRENT_TRANSPORT_MODELS",
    "CONSERVATIVE_CURRENT_BOUNDARY_ROLES",
    "ChargeInsulating",
    "ChargePotentialGauge",
    "ChargeSolverPolicy",
    "ChargeTransportMaterial",
    "ChargeTransportMaterialAssignment",
    "CurrentTransport",
    "ConservativeCurrentBoundaryFace",
    "ConservativeCurrentClosedGeometry",
    "ConservativeCurrentIdentity",
    "ConservativeCurrentPins",
    "ConservativeCurrentSourceCut",
    "ConservativeCurrentSourceCutFacePair",
    "ConservativeCurrentView",
    "NormalCurrentElectrode",
    "VoltageElectrode",
]
