from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Sequence

from fullmag._validation import (
    as_vector3,
    require_finite,
    require_non_empty,
    require_non_negative,
    require_positive,
)
from fullmag.model.energy import Sinusoidal, TimeDependence
from fullmag.model.geometry import (
    AntennaLayout,
    AntennaRigidTransform,
    CPWAntennaLayout,
    CPWWidthStation,
    MicrostripAntennaLayout,
    MicrostripWidthStation,
    RigidTransform,
)

# FEM-034 / FEM-035: extensible allow-lists for solver and current_distribution.
# Add new entries here when additional backends or distributions are implemented.
ANTENNA_SOLVERS = {"mqs_2p5d_az"}
ANTENNA_FIELD_SOURCE_MODELS = {"mqs_2p5d_az", "prescribed_zeeman_mask"}
CURRENT_DISTRIBUTIONS = {"uniform"}
FIELD_TIME_ORIGINS = frozenset({"stage_local", "absolute"})
SPATIAL_WINDOWS = frozenset({"none", "hann"})
ANTENNA_OERSTED_REALIZATIONS = frozenset(
    {"direct_tetra_quadrature", "vector_potential_solver"}
)
ANTENNA_SPECTRUM_TRANSFORMS = frozenset({"spatial_fft", "nonuniform_spatial_fft"})
ANTENNA_SPECTRUM_WINDOWS = frozenset({"rectangular", "hann", "hamming", "blackman"})
ANTENNA_SPECTRUM_NORMALIZATIONS = frozenset({"integral_si", "unitary_discrete"})
ANTENNA_SPECTRUM_COMPONENTS = frozenset(
    {"x", "y", "z", "u", "v", "normal", "vector_power", "transverse"}
)
ANTENNA_SPECTRUM_OUTSIDE_POLICIES = frozenset({"error", "zero"})
ANTENNA_SPECTRUM_INTERPOLATIONS = frozenset({"fem_element", "fdm_trilinear"})
ANTENNA_PORT_MODE_SCHEMA_VERSION = "antenna_port_mode.v2"


def _normalized_vector3(value: Sequence[float], name: str) -> tuple[float, float, float]:
    vector = as_vector3(value, name)
    norm = math.sqrt(sum(component * component for component in vector))
    if not math.isfinite(norm) or norm <= 1e-15:
        raise ValueError(f"{name} must be non-zero")
    return tuple(component / norm for component in vector)


@dataclass(frozen=True, slots=True)
class AntennaPortBranch:
    id: str
    inlet_terminal_ref: str
    outlet_terminal_ref: str
    signed_weight: float

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "id",
            require_non_empty(self.id, "antenna_port_branch.id"),
        )
        for field_name in ("inlet_terminal_ref", "outlet_terminal_ref"):
            object.__setattr__(
                self,
                field_name,
                require_non_empty(
                    getattr(self, field_name), f"antenna_port_branch.{field_name}"
                ),
            )
        if self.inlet_terminal_ref == self.outlet_terminal_ref:
            raise ValueError(
                "antenna port branch inlet and outlet terminal references must differ"
            )
        object.__setattr__(
            self,
            "signed_weight",
            require_finite(self.signed_weight, "signed_weight"),
        )

    def to_ir(self) -> dict[str, object]:
        return {
            "id": self.id,
            "inlet_terminal_ref": self.inlet_terminal_ref,
            "outlet_terminal_ref": self.outlet_terminal_ref,
            "signed_weight": self.signed_weight,
        }


@dataclass(frozen=True, slots=True)
class AntennaPortMode:
    id: str
    source_object_id: str
    current_transport_id: str
    branches: tuple[AntennaPortBranch, ...]
    normalization_current_a: float = 1.0

    def __init__(
        self,
        *,
        id: str,
        source_object_id: str,
        current_transport_id: str,
        branches: Sequence[AntennaPortBranch],
        normalization_current_a: float = 1.0,
    ) -> None:
        object.__setattr__(self, "id", require_non_empty(id, "antenna_port_mode.id"))
        object.__setattr__(
            self,
            "source_object_id",
            require_non_empty(source_object_id, "antenna_port_mode.source_object_id"),
        )
        object.__setattr__(
            self,
            "current_transport_id",
            require_non_empty(current_transport_id, "antenna_port_mode.current_transport_id"),
        )
        resolved = tuple(branches)
        if len(resolved) < 2 or any(not isinstance(branch, AntennaPortBranch) for branch in resolved):
            raise ValueError("antenna port mode requires at least two typed branches")
        branch_ids = [branch.id for branch in resolved]
        if len(set(branch_ids)) != len(branch_ids):
            raise ValueError("antenna port branch ids must be unique")
        terminal_refs = [
            terminal
            for branch in resolved
            for terminal in (branch.inlet_terminal_ref, branch.outlet_terminal_ref)
        ]
        if len(set(terminal_refs)) != len(terminal_refs):
            raise ValueError(
                "antenna port terminal references must be unique across branches"
            )
        if abs(sum(branch.signed_weight for branch in resolved)) > 1e-12:
            raise ValueError("antenna port branch signed weights must sum to zero")
        positive_weight = sum(
            branch.signed_weight for branch in resolved if branch.signed_weight > 0.0
        )
        if abs(positive_weight - 1.0) > 1e-12 or not any(
            branch.signed_weight < 0.0 for branch in resolved
        ):
            raise ValueError(
                "antenna port positive branch weights must sum to one and include a return branch"
            )
        if normalization_current_a != 1.0:
            raise ValueError("antenna field basis normalization_current_a must equal exactly 1 A")
        object.__setattr__(self, "branches", resolved)
        object.__setattr__(self, "normalization_current_a", 1.0)

    def to_ir(self) -> dict[str, object]:
        return {
            "schema_version": ANTENNA_PORT_MODE_SCHEMA_VERSION,
            "id": self.id,
            "source_object_id": self.source_object_id,
            "current_transport_id": self.current_transport_id,
            "branches": [branch.to_ir() for branch in self.branches],
            "normalization_current_a": self.normalization_current_a,
        }


@dataclass(frozen=True, slots=True)
class AntennaFieldSolutionRef:
    stage_id: str
    output_id: str
    asset_id: str
    content_digest: str

    def __post_init__(self) -> None:
        for field_name in ("stage_id", "output_id", "asset_id", "content_digest"):
            object.__setattr__(
                self,
                field_name,
                require_non_empty(getattr(self, field_name), f"solution_ref.{field_name}"),
            )

    def to_ir(self) -> dict[str, object]:
        return {field_name: getattr(self, field_name) for field_name in self.__slots__}


@dataclass(frozen=True, slots=True)
class AntennaStageOutputRef:
    """Authoring-time reference to an output declared by a solve stage."""

    stage_id: str
    output_id: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "stage_id", require_non_empty(self.stage_id, "stage_id"))
        object.__setattr__(self, "output_id", require_non_empty(self.output_id, "output_id"))

    def to_ir(self) -> dict[str, str]:
        return {
            "kind": "stage_output",
            "stage_id": self.stage_id,
            "output_id": self.output_id,
        }


@dataclass(frozen=True, slots=True)
class AntennaWaveformBandwidthDeclaration:
    """Authored physical upper band for a pulse or piecewise drive [Hz]."""

    f_max_hz: float

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "f_max_hz",
            require_non_negative(self.f_max_hz, "antenna_waveform_bandwidth.f_max_hz"),
        )

    def to_ir(self) -> dict[str, float]:
        return {"f_max_hz": self.f_max_hz}


@dataclass(frozen=True, slots=True)
class SolvedAntennaDrive:
    id: str
    name: str
    projection_ref: str
    port_mode_id: str
    peak_current_a: float
    waveform: TimeDependence
    bandwidth_declaration: AntennaWaveformBandwidthDeclaration | None = None
    time_origin: str = "stage_local"
    activation: DriveActivation | None = None

    def __post_init__(self) -> None:
        for field_name in ("id", "name", "projection_ref", "port_mode_id"):
            object.__setattr__(
                self,
                field_name,
                require_non_empty(getattr(self, field_name), f"solved_antenna_drive.{field_name}"),
            )
        object.__setattr__(
            self,
            "peak_current_a",
            require_finite(self.peak_current_a, "solved_antenna_drive.peak_current_a"),
        )
        if not hasattr(self.waveform, "to_ir"):
            raise TypeError("waveform must be a Fullmag time-dependence object")
        if self.bandwidth_declaration is not None and not isinstance(
            self.bandwidth_declaration, AntennaWaveformBandwidthDeclaration
        ):
            raise TypeError(
                "bandwidth_declaration must be an AntennaWaveformBandwidthDeclaration"
            )
        if self.bandwidth_declaration is not None and self.waveform.to_ir().get("kind") not in {
            "pulse", "piecewise_linear"
        }:
            raise ValueError(
                "bandwidth_declaration is only valid for pulse or piecewise_linear waveforms"
            )
        origin = require_non_empty(self.time_origin, "solved_antenna_drive.time_origin").lower()
        if origin not in FIELD_TIME_ORIGINS:
            raise ValueError(f"time_origin must be one of {sorted(FIELD_TIME_ORIGINS)}")
        resolved_activation = self.activation or DriveActivation.all_time_evolution()
        if not isinstance(resolved_activation, DriveActivation):
            raise TypeError("activation must be a DriveActivation")
        object.__setattr__(self, "time_origin", origin)
        object.__setattr__(self, "activation", resolved_activation)

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "id": self.id,
            "name": self.name,
            "projection_ref": self.projection_ref,
            "port_mode_id": self.port_mode_id,
            "peak_current_a": self.peak_current_a,
            "waveform": self.waveform.to_ir(),
            "time_origin": self.time_origin,
            "activation": self.activation.to_ir(),
        }
        if self.bandwidth_declaration is not None:
            payload["bandwidth_declaration"] = self.bandwidth_declaration.to_ir()
        return payload


@dataclass(frozen=True, slots=True)
class FieldTarget:
    kind: str
    object_id: str | None = None
    region_id: str | None = None

    def __post_init__(self) -> None:
        kind = require_non_empty(self.kind, "target.kind").lower()
        object.__setattr__(self, "kind", kind)
        if kind == "global":
            if self.object_id is not None or self.region_id is not None:
                raise ValueError("global target must not define object_id or region_id")
            return
        if kind not in {"object", "region"}:
            raise ValueError("target.kind must be 'global', 'object', or 'region'")
        object_id = require_non_empty(self.object_id or "", "target.object_id")
        object.__setattr__(self, "object_id", object_id)
        if kind == "object":
            if self.region_id is not None:
                raise ValueError("object target must not define region_id")
            return
        object.__setattr__(
            self,
            "region_id",
            require_non_empty(self.region_id or "", "target.region_id"),
        )

    @classmethod
    def global_domain(cls) -> "FieldTarget":
        return cls(kind="global")

    @classmethod
    def object(cls, object_id: str) -> "FieldTarget":
        return cls(kind="object", object_id=object_id)

    @classmethod
    def region(cls, object_id: str, region_id: str) -> "FieldTarget":
        return cls(kind="region", object_id=object_id, region_id=region_id)

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {"kind": self.kind}
        if self.object_id is not None:
            payload["object_id"] = self.object_id
        if self.region_id is not None:
            payload["region_id"] = self.region_id
        return payload


@dataclass(frozen=True, slots=True)
class AntennaNamedOutput:
    id: str
    quantity: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", require_non_empty(self.id, "antenna_output.id"))
        object.__setattr__(
            self,
            "quantity",
            require_non_empty(self.quantity, "antenna_output.quantity"),
        )

    def to_ir(self) -> dict[str, object]:
        return {"id": self.id, "quantity": self.quantity}


@dataclass(frozen=True, slots=True)
class AntennaFieldSolveStage:
    id: str
    source_object_id: str
    current_transport_id: str
    port_mode_ids: tuple[str, ...]
    conservative_current_view_ref: str | None
    field_sampling_domain: FieldTarget
    target_refs: tuple[FieldTarget, ...]
    outputs: tuple[AntennaNamedOutput, ...]
    oersted_realization: str = "direct_tetra_quadrature"
    model: str = "quasistatic_conduction_biot_savart3d"
    conductor_mesh_policy: str = "authored_shared_domain"
    solver_policy: str = "production_default"

    def __init__(
        self,
        *,
        id: str,
        source_object_id: str,
        current_transport_id: str,
        port_mode_ids: Sequence[str],
        conservative_current_view_ref: str | None = None,
        field_sampling_domain: FieldTarget,
        target_refs: Sequence[FieldTarget],
        outputs: Sequence[AntennaNamedOutput],
        oersted_realization: str = "direct_tetra_quadrature",
        model: str = "quasistatic_conduction_biot_savart3d",
        conductor_mesh_policy: str = "authored_shared_domain",
        solver_policy: str = "production_default",
    ) -> None:
        for name, value in (
            ("id", id),
            ("source_object_id", source_object_id),
            ("current_transport_id", current_transport_id),
            ("conductor_mesh_policy", conductor_mesh_policy),
            ("solver_policy", solver_policy),
        ):
            object.__setattr__(self, name, require_non_empty(value, f"antenna_field_solve.{name}"))
        object.__setattr__(
            self,
            "conservative_current_view_ref",
            None
            if conservative_current_view_ref is None
            else require_non_empty(
                conservative_current_view_ref,
                "antenna_field_solve.conservative_current_view_ref",
            ),
        )
        ports = tuple(require_non_empty(value, "antenna_field_solve.port_mode_id") for value in port_mode_ids)
        if len(ports) != 1:
            raise ValueError("antenna field solve requires exactly one port_mode_id per executable stage")
        if not isinstance(field_sampling_domain, FieldTarget):
            raise TypeError("field_sampling_domain must be a FieldTarget")
        targets = tuple(target_refs)
        if not targets or any(not isinstance(target, FieldTarget) for target in targets):
            raise ValueError("antenna field solve requires at least one typed target_ref")
        resolved_outputs = tuple(outputs)
        if any(not isinstance(output, AntennaNamedOutput) for output in resolved_outputs) or sum(
            output.quantity == "H_ant_basis" for output in resolved_outputs
        ) != 1:
            raise ValueError("antenna field solve requires exactly one H_ant_basis output")
        realization = require_non_empty(oersted_realization, "oersted_realization").lower()
        if realization not in ANTENNA_OERSTED_REALIZATIONS:
            raise ValueError(
                f"oersted_realization must be one of {sorted(ANTENNA_OERSTED_REALIZATIONS)}"
            )
        if model != "quasistatic_conduction_biot_savart3d":
            raise ValueError("unsupported antenna field model")
        object.__setattr__(self, "port_mode_ids", ports)
        object.__setattr__(self, "field_sampling_domain", field_sampling_domain)
        object.__setattr__(self, "target_refs", targets)
        object.__setattr__(self, "outputs", resolved_outputs)
        object.__setattr__(self, "oersted_realization", realization)
        object.__setattr__(self, "model", model)

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "id": self.id,
            "source_object_id": self.source_object_id,
            "current_transport_id": self.current_transport_id,
            "port_mode_ids": list(self.port_mode_ids),
            "model": self.model,
            "oersted_realization": self.oersted_realization,
            "conductor_mesh_policy": self.conductor_mesh_policy,
            "field_sampling_domain": self.field_sampling_domain.to_ir(),
            "target_refs": [target.to_ir() for target in self.target_refs],
            "solver_policy": self.solver_policy,
            "outputs": [output.to_ir() for output in self.outputs],
        }
        if self.conservative_current_view_ref is not None:
            payload["conservative_current_view_ref"] = self.conservative_current_view_ref
        return payload


@dataclass(frozen=True, slots=True)
class AntennaTargetProjection:
    id: str
    solution: AntennaStageOutputRef | AntennaFieldSolutionRef
    target: FieldTarget
    output_id: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", require_non_empty(self.id, "antenna_projection.id"))
        object.__setattr__(
            self,
            "output_id",
            require_non_empty(self.output_id, "antenna_projection.output_id"),
        )
        if not isinstance(self.solution, (AntennaStageOutputRef, AntennaFieldSolutionRef)):
            raise TypeError(
                "solution must be an AntennaStageOutputRef or AntennaFieldSolutionRef"
            )
        if not isinstance(self.target, FieldTarget):
            raise TypeError("target must be a FieldTarget")

    def to_ir(self) -> dict[str, object]:
        solution = self.solution.to_ir()
        if isinstance(self.solution, AntennaFieldSolutionRef):
            solution = {"kind": "resolved_asset", **solution}
        return {
            "id": self.id,
            "solution": solution,
            "target": self.target.to_ir(),
            "output_id": self.output_id,
        }


@dataclass(frozen=True, slots=True)
class AntennaSpectrumSamplingPlane:
    origin_m: tuple[float, float, float]
    axis_u: tuple[float, float, float]
    axis_v: tuple[float, float, float]
    extent_u_m: float
    extent_v_m: float
    sample_count_u: int
    sample_count_v: int
    interpolation: str = "fem_element"
    outside_policy: str = "error"

    def __init__(
        self,
        *,
        origin_m: Sequence[float],
        axis_u: Sequence[float],
        axis_v: Sequence[float],
        extent_u_m: float,
        extent_v_m: float,
        sample_count_u: int,
        sample_count_v: int,
        interpolation: str = "fem_element",
        outside_policy: str = "error",
    ) -> None:
        u = _normalized_vector3(axis_u, "antenna_spectrum.sampling_plane.axis_u")
        v = _normalized_vector3(axis_v, "antenna_spectrum.sampling_plane.axis_v")
        if abs(sum(a * b for a, b in zip(u, v, strict=True))) > 1e-12:
            raise ValueError("antenna spectrum sampling axes must be orthogonal")
        if not isinstance(sample_count_u, int) or sample_count_u < 2:
            raise ValueError("sample_count_u must be an integer >= 2")
        if not isinstance(sample_count_v, int) or sample_count_v < 2:
            raise ValueError("sample_count_v must be an integer >= 2")
        interpolation = require_non_empty(interpolation, "interpolation").lower()
        outside_policy = require_non_empty(outside_policy, "outside_policy").lower()
        if interpolation not in ANTENNA_SPECTRUM_INTERPOLATIONS:
            raise ValueError(f"interpolation must be one of {sorted(ANTENNA_SPECTRUM_INTERPOLATIONS)}")
        if outside_policy not in ANTENNA_SPECTRUM_OUTSIDE_POLICIES:
            raise ValueError(f"outside_policy must be one of {sorted(ANTENNA_SPECTRUM_OUTSIDE_POLICIES)}")
        object.__setattr__(self, "origin_m", as_vector3(origin_m, "antenna_spectrum.sampling_plane.origin_m"))
        object.__setattr__(self, "axis_u", u)
        object.__setattr__(self, "axis_v", v)
        object.__setattr__(self, "extent_u_m", require_positive(extent_u_m, "extent_u_m"))
        object.__setattr__(self, "extent_v_m", require_positive(extent_v_m, "extent_v_m"))
        object.__setattr__(self, "sample_count_u", sample_count_u)
        object.__setattr__(self, "sample_count_v", sample_count_v)
        object.__setattr__(self, "interpolation", interpolation)
        object.__setattr__(self, "outside_policy", outside_policy)

    def to_ir(self) -> dict[str, object]:
        return {
            "origin_m": list(self.origin_m),
            "axis_u": list(self.axis_u),
            "axis_v": list(self.axis_v),
            "extent_u_m": self.extent_u_m,
            "extent_v_m": self.extent_v_m,
            "sample_count_u": self.sample_count_u,
            "sample_count_v": self.sample_count_v,
            "interpolation": self.interpolation,
            "outside_policy": self.outside_policy,
        }


@dataclass(frozen=True, slots=True)
class AntennaSpectrumKGrid:
    k_u_rad_per_m: tuple[float, ...]
    k_v_rad_per_m: tuple[float, ...]

    def __init__(self, *, k_u_rad_per_m: Sequence[float], k_v_rad_per_m: Sequence[float]) -> None:
        for name, values in (("k_u_rad_per_m", k_u_rad_per_m), ("k_v_rad_per_m", k_v_rad_per_m)):
            if not values:
                raise ValueError(f"{name} must not be empty")
            if any(not math.isfinite(float(value)) for value in values):
                raise ValueError(f"{name} must contain only finite values")
            object.__setattr__(self, name, tuple(float(value) for value in values))

    def to_ir(self) -> dict[str, object]:
        return {"k_u_rad_per_m": list(self.k_u_rad_per_m), "k_v_rad_per_m": list(self.k_v_rad_per_m)}


@dataclass(frozen=True, slots=True)
class AntennaSpectrumRequest:
    id: str
    solution_ref: AntennaStageOutputRef | AntennaFieldSolutionRef
    target: FieldTarget
    transform: str
    sampling_plane: AntennaSpectrumSamplingPlane
    window: str
    normalization: str
    component: str
    output_id: str
    port_mode_id: str | None = None
    nonuniform_k_grid: AntennaSpectrumKGrid | None = None
    equilibrium_ref: str | None = None
    mode_basis_ref: str | None = None

    def __post_init__(self) -> None:
        for name in ("id", "component", "output_id"):
            object.__setattr__(
                self,
                name,
                require_non_empty(getattr(self, name), f"antenna_spectrum.{name}"),
            )
        if self.component not in ANTENNA_SPECTRUM_COMPONENTS:
            raise ValueError(
                f"component must be one of {sorted(ANTENNA_SPECTRUM_COMPONENTS)}"
            )
        if not isinstance(self.solution_ref, (AntennaStageOutputRef, AntennaFieldSolutionRef)):
            raise TypeError("solution_ref must be an AntennaStageOutputRef or AntennaFieldSolutionRef")
        if not isinstance(self.target, FieldTarget):
            raise TypeError("target must be a FieldTarget")
        if not isinstance(self.sampling_plane, AntennaSpectrumSamplingPlane):
            raise TypeError("sampling_plane must be an AntennaSpectrumSamplingPlane")
        if self.port_mode_id is not None:
            object.__setattr__(
                self,
                "port_mode_id",
                require_non_empty(self.port_mode_id, "antenna_spectrum.port_mode_id"),
            )
        transform = require_non_empty(self.transform, "antenna_spectrum.transform").lower()
        if transform not in ANTENNA_SPECTRUM_TRANSFORMS:
            raise ValueError(
                f"transform must be one of {sorted(ANTENNA_SPECTRUM_TRANSFORMS)}"
            )
        object.__setattr__(self, "transform", transform)
        window = require_non_empty(self.window, "antenna_spectrum.window").lower()
        normalization = require_non_empty(self.normalization, "antenna_spectrum.normalization").lower()
        if window not in ANTENNA_SPECTRUM_WINDOWS:
            raise ValueError(f"window must be one of {sorted(ANTENNA_SPECTRUM_WINDOWS)}")
        if window != "rectangular" and (
            self.sampling_plane.sample_count_u < 3
            or self.sampling_plane.sample_count_v < 3
        ):
            raise ValueError("non-rectangular windows require at least 3 samples per axis")
        if normalization not in ANTENNA_SPECTRUM_NORMALIZATIONS:
            raise ValueError(f"normalization must be one of {sorted(ANTENNA_SPECTRUM_NORMALIZATIONS)}")
        if transform == "spatial_fft" and self.nonuniform_k_grid is not None:
            raise ValueError("spatial_fft derives its k grid and forbids nonuniform_k_grid")
        if transform == "nonuniform_spatial_fft" and not isinstance(self.nonuniform_k_grid, AntennaSpectrumKGrid):
            raise ValueError("nonuniform_spatial_fft requires nonuniform_k_grid")
        if self.component == "transverse" and not self.equilibrium_ref:
            raise ValueError("transverse spectrum requires equilibrium_ref")
        if self.component != "transverse" and self.equilibrium_ref is not None:
            raise ValueError("equilibrium_ref is only valid for component='transverse'")
        for name in ("equilibrium_ref", "mode_basis_ref"):
            value = getattr(self, name)
            if value is not None:
                object.__setattr__(self, name, require_non_empty(value, f"antenna_spectrum.{name}"))
        if self.component == "transverse":
            raise ValueError("transverse spectrum is unsupported until certified equilibrium loading and projection exist")
        if self.mode_basis_ref is not None:
            raise ValueError("mode_basis_ref is unsupported until modal analysis is implemented")
        object.__setattr__(self, "window", window)
        object.__setattr__(self, "normalization", normalization)

    def to_ir(self) -> dict[str, object]:
        solution_ref = self.solution_ref.to_ir()
        if isinstance(self.solution_ref, AntennaFieldSolutionRef):
            solution_ref = {"kind": "resolved_asset", **solution_ref}
        payload: dict[str, object] = {
            "id": self.id,
            "solution_ref": solution_ref,
            "target": self.target.to_ir(),
            "transform": self.transform,
            "sampling_plane": self.sampling_plane.to_ir(),
            "window": self.window,
            "normalization": self.normalization,
            "component": self.component,
            "output_id": self.output_id,
        }
        if self.port_mode_id is not None:
            payload["port_mode_id"] = self.port_mode_id
        if self.nonuniform_k_grid is not None:
            payload["nonuniform_k_grid"] = self.nonuniform_k_grid.to_ir()
        if self.equilibrium_ref is not None:
            payload["equilibrium_ref"] = self.equilibrium_ref
        if self.mode_basis_ref is not None:
            payload["mode_basis_ref"] = self.mode_basis_ref
        return payload


@dataclass(frozen=True, slots=True)
class UniformFieldProfile:
    def to_ir(self) -> dict[str, object]:
        return {"kind": "uniform"}


@dataclass(frozen=True, slots=True)
class SincFieldProfile:
    axis: tuple[float, float, float]
    period_m: float
    center_m: float = 0.0
    width_m: float | None = None
    window: str = "none"

    def __init__(
        self,
        axis: Sequence[float],
        period_m: float,
        center_m: float = 0.0,
        width_m: float | None = None,
        window: str = "none",
    ) -> None:
        object.__setattr__(self, "axis", _normalized_vector3(axis, "spatial_profile.axis"))
        require_positive(period_m, "spatial_profile.period_m")
        require_finite(center_m, "spatial_profile.center_m")
        if width_m is not None:
            require_positive(width_m, "spatial_profile.width_m")
        normalized_window = require_non_empty(window, "spatial_profile.window").lower()
        if normalized_window not in SPATIAL_WINDOWS:
            raise ValueError(
                f"spatial_profile.window must be one of {sorted(SPATIAL_WINDOWS)}"
            )
        object.__setattr__(self, "period_m", float(period_m))
        object.__setattr__(self, "center_m", float(center_m))
        object.__setattr__(self, "width_m", None if width_m is None else float(width_m))
        object.__setattr__(self, "window", normalized_window)

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "kind": "sinc",
            "axis": list(self.axis),
            "period_m": self.period_m,
            "center_m": self.center_m,
            "window": self.window,
        }
        if self.width_m is not None:
            payload["width_m"] = self.width_m
        return payload


@dataclass(frozen=True, slots=True)
class GaussianPlaneWaveFieldProfile:
    center_x_m: float
    center_y_m: float
    carrier_origin_x_m: float
    sigma_x_m: float
    sigma_y_m: float
    wavelength_m: float
    carrier_phase_rad: float = 0.0

    def __post_init__(self) -> None:
        for field_name in (
            "center_x_m",
            "center_y_m",
            "carrier_origin_x_m",
            "carrier_phase_rad",
        ):
            value = require_finite(getattr(self, field_name), f"spatial_profile.{field_name}")
            object.__setattr__(self, field_name, value)
        for field_name in ("sigma_x_m", "sigma_y_m", "wavelength_m"):
            value = require_positive(getattr(self, field_name), f"spatial_profile.{field_name}")
            object.__setattr__(self, field_name, value)

    def value_at(self, point: Sequence[float]) -> float:
        x, y, _ = as_vector3(point, "spatial_profile.point")
        if not all(math.isfinite(value) for value in (x, y)):
            raise ValueError("spatial_profile.point must be finite")
        envelope = math.exp(
            -0.5 * (
                ((x - self.center_x_m) / self.sigma_x_m) ** 2
                + ((y - self.center_y_m) / self.sigma_y_m) ** 2
            )
        )
        carrier = 2.0 * math.pi * (x - self.carrier_origin_x_m) / self.wavelength_m
        return envelope * math.cos(carrier + self.carrier_phase_rad)

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "gaussian_plane_wave",
            "center_x_m": self.center_x_m,
            "center_y_m": self.center_y_m,
            "carrier_origin_x_m": self.carrier_origin_x_m,
            "sigma_x_m": self.sigma_x_m,
            "sigma_y_m": self.sigma_y_m,
            "wavelength_m": self.wavelength_m,
            "carrier_phase_rad": self.carrier_phase_rad,
        }


FieldEnvelope = UniformFieldProfile | SincFieldProfile


@dataclass(frozen=True, slots=True)
class GeometryMaskFieldProfile:
    object_id: str
    envelope: FieldEnvelope = UniformFieldProfile()

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "object_id",
            require_non_empty(self.object_id, "spatial_profile.object_id"),
        )
        if not isinstance(self.envelope, (UniformFieldProfile, SincFieldProfile)):
            raise TypeError("geometry-mask envelope must be UniformFieldProfile or SincFieldProfile")

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "geometry_mask",
            "object_id": self.object_id,
            "envelope": self.envelope.to_ir(),
        }


FieldSpatialProfile = (
    UniformFieldProfile
    | SincFieldProfile
    | GaussianPlaneWaveFieldProfile
    | GeometryMaskFieldProfile
)


@dataclass(frozen=True, slots=True)
class DriveActivation:
    kind: str
    stage_ids_value: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        kind = require_non_empty(self.kind, "activation.kind").lower()
        object.__setattr__(self, "kind", kind)
        if kind == "all_time_evolution":
            if self.stage_ids_value:
                raise ValueError("all_time_evolution activation must not define stage ids")
            return
        if kind != "stage_ids":
            raise ValueError("activation.kind must be 'all_time_evolution' or 'stage_ids'")
        if not self.stage_ids_value:
            raise ValueError("stage_ids activation requires at least one stage id")
        normalized = tuple(
            require_non_empty(stage_id, "activation.stage_id")
            for stage_id in self.stage_ids_value
        )
        if len(set(normalized)) != len(normalized):
            raise ValueError("activation stage ids must be unique")
        object.__setattr__(self, "stage_ids_value", normalized)

    @classmethod
    def all_time_evolution(cls) -> "DriveActivation":
        return cls(kind="all_time_evolution")

    @classmethod
    def stage_ids(cls, stage_ids: Sequence[str]) -> "DriveActivation":
        return cls(kind="stage_ids", stage_ids_value=tuple(stage_ids))

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {"kind": self.kind}
        if self.kind == "stage_ids":
            payload["stage_ids"] = list(self.stage_ids_value)
        return payload


@dataclass(frozen=True, slots=True)
class RegionalFieldDrive:
    id: str
    name: str
    target: FieldTarget
    amplitude_B_T: float
    direction: tuple[float, float, float]
    spatial_profile: FieldSpatialProfile
    waveform: TimeDependence
    time_origin: str = "stage_local"
    activation: DriveActivation = DriveActivation(kind="all_time_evolution")
    enabled: bool = True
    migration: dict[str, str] | None = None

    def __init__(
        self,
        *,
        id: str,
        name: str,
        target: FieldTarget,
        amplitude_B_T: float,
        direction: Sequence[float],
        spatial_profile: FieldSpatialProfile,
        waveform: TimeDependence,
        time_origin: str = "stage_local",
        activation: DriveActivation | None = None,
        enabled: bool = True,
        migration: dict[str, str] | None = None,
    ) -> None:
        object.__setattr__(self, "id", require_non_empty(id, "field_drive.id"))
        object.__setattr__(self, "name", require_non_empty(name, "field_drive.name"))
        if not isinstance(target, FieldTarget):
            raise TypeError("target must be a FieldTarget")
        require_non_negative(amplitude_B_T, "amplitude_B_T")
        object.__setattr__(self, "target", target)
        object.__setattr__(self, "amplitude_B_T", float(amplitude_B_T))
        object.__setattr__(self, "direction", _normalized_vector3(direction, "direction"))
        if not isinstance(
            spatial_profile,
            (
                UniformFieldProfile,
                SincFieldProfile,
                GaussianPlaneWaveFieldProfile,
                GeometryMaskFieldProfile,
            ),
        ):
            raise TypeError("spatial_profile must be a typed Fullmag field profile")
        if not hasattr(waveform, "to_ir"):
            raise TypeError("waveform must be a Fullmag time-dependence object")
        normalized_origin = require_non_empty(time_origin, "time_origin").lower()
        if normalized_origin not in FIELD_TIME_ORIGINS:
            raise ValueError(f"time_origin must be one of {sorted(FIELD_TIME_ORIGINS)}")
        resolved_activation = activation or DriveActivation.all_time_evolution()
        if not isinstance(resolved_activation, DriveActivation):
            raise TypeError("activation must be a DriveActivation")
        object.__setattr__(self, "spatial_profile", spatial_profile)
        object.__setattr__(self, "waveform", waveform)
        object.__setattr__(self, "time_origin", normalized_origin)
        object.__setattr__(self, "activation", resolved_activation)
        object.__setattr__(self, "enabled", bool(enabled))
        if migration is not None:
            if migration != {"migrated_from": "prescribed_zeeman_mask"}:
                raise ValueError("unsupported RegionalFieldDrive migration provenance")
            migration = dict(migration)
        object.__setattr__(self, "migration", migration)

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "id": self.id,
            "name": self.name,
            "kind": "regional",
            "enabled": self.enabled,
            "target": self.target.to_ir(),
            "amplitude_B_T": self.amplitude_B_T,
            "direction": list(self.direction),
            "spatial_profile": self.spatial_profile.to_ir(),
            "waveform": self.waveform.to_ir(),
            "time_origin": self.time_origin,
            "activation": self.activation.to_ir(),
        }
        if self.migration is not None:
            payload["migration"] = dict(self.migration)
        return payload


@dataclass(frozen=True, slots=True)
class GaussianPlaneWaveAntenna:
    id: str
    amplitude_B_T: float
    frequency_hz: float
    wavelength_m: float
    sigma_x_m: float
    fwhm_y_m: float
    center_x_m: float = 0.0
    center_y_m: float = 0.0
    carrier_origin_x_m: float = 0.0
    spatial_phase_rad: float = 0.0
    phase_rad: float = 0.0
    t0_s: float = 0.0
    target: FieldTarget = FieldTarget.global_domain()
    activation: DriveActivation = DriveActivation(kind="all_time_evolution")
    time_origin: str = "stage_local"
    enabled: bool = True

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", require_non_empty(self.id, "antenna.id"))
        object.__setattr__(
            self,
            "amplitude_B_T",
            require_non_negative(self.amplitude_B_T, "antenna.amplitude_B_T"),
        )
        for field_name in (
            "center_x_m",
            "center_y_m",
            "carrier_origin_x_m",
            "spatial_phase_rad",
            "phase_rad",
        ):
            value = require_finite(getattr(self, field_name), f"antenna.{field_name}")
            object.__setattr__(self, field_name, value)
        object.__setattr__(
            self,
            "frequency_hz",
            require_positive(self.frequency_hz, "antenna.frequency_hz"),
        )
        object.__setattr__(
            self,
            "wavelength_m",
            require_positive(self.wavelength_m, "antenna.wavelength_m"),
        )
        object.__setattr__(
            self,
            "sigma_x_m",
            require_positive(self.sigma_x_m, "antenna.sigma_x_m"),
        )
        object.__setattr__(
            self,
            "fwhm_y_m",
            require_positive(self.fwhm_y_m, "antenna.fwhm_y_m"),
        )
        object.__setattr__(self, "t0_s", require_non_negative(self.t0_s, "antenna.t0_s"))
        if not isinstance(self.target, FieldTarget):
            raise TypeError("antenna.target must be a FieldTarget")
        if not isinstance(self.activation, DriveActivation):
            raise TypeError("antenna.activation must be a DriveActivation")
        normalized_origin = require_non_empty(self.time_origin, "antenna.time_origin").lower()
        if normalized_origin not in FIELD_TIME_ORIGINS:
            raise ValueError(f"antenna.time_origin must be one of {sorted(FIELD_TIME_ORIGINS)}")
        object.__setattr__(self, "time_origin", normalized_origin)
        object.__setattr__(self, "enabled", bool(self.enabled))

    @property
    def sigma_y_m(self) -> float:
        return self.fwhm_y_m / (2.0 * math.sqrt(2.0 * math.log(2.0)))

    def to_drives(self) -> tuple[RegionalFieldDrive, RegionalFieldDrive]:
        waveform = Sinusoidal(
            frequency_hz=self.frequency_hz,
            phase_rad=self.phase_rad - 2.0 * math.pi * self.frequency_hz * self.t0_s,
        )
        base_profile = dict(
            center_x_m=self.center_x_m,
            center_y_m=self.center_y_m,
            carrier_origin_x_m=self.carrier_origin_x_m,
            sigma_x_m=self.sigma_x_m,
            sigma_y_m=self.sigma_y_m,
            wavelength_m=self.wavelength_m,
        )
        x_profile = GaussianPlaneWaveFieldProfile(
            **base_profile,
            carrier_phase_rad=self.spatial_phase_rad,
        )
        z_profile = GaussianPlaneWaveFieldProfile(
            **base_profile,
            carrier_phase_rad=self.spatial_phase_rad - math.pi / 2.0,
        )
        common = {
            "target": self.target,
            "amplitude_B_T": self.amplitude_B_T,
            "waveform": waveform,
            "time_origin": self.time_origin,
            "activation": self.activation,
            "enabled": self.enabled,
        }
        return (
            RegionalFieldDrive(
                id=f"{self.id}_x",
                name=f"{self.id} x quadrature",
                direction=(1.0, 0.0, 0.0),
                spatial_profile=x_profile,
                **common,
            ),
            RegionalFieldDrive(
                id=f"{self.id}_z",
                name=f"{self.id} z quadrature",
                direction=(0.0, 0.0, 1.0),
                spatial_profile=z_profile,
                **common,
            ),
        )


def _drive_waveform_ir(
    *,
    frequency_hz: float | None,
    phase_rad: float,
    waveform: TimeDependence | None,
) -> dict[str, object] | None:
    if waveform is not None:
        return waveform.to_ir()
    if frequency_hz is None:
        return None
    return Sinusoidal(frequency_hz=frequency_hz, phase_rad=phase_rad).to_ir()


@dataclass(frozen=True, slots=True)
class RfDrive:
    current_a: float
    frequency_hz: float | None = None
    phase_rad: float = 0.0
    waveform: TimeDependence | None = None

    def __post_init__(self) -> None:
        if self.frequency_hz is not None:
            require_positive(self.frequency_hz, "frequency_hz")
        if self.waveform is not None and not hasattr(self.waveform, "to_ir"):
            raise TypeError(
                "waveform must be a Fullmag time-dependence object such as "
                "Sinusoidal(...) or Pulse(...)"
            )

    def to_ir(self) -> dict[str, object]:
        ir = {"current_a": float(self.current_a)}
        waveform_ir = _drive_waveform_ir(
            frequency_hz=self.frequency_hz,
            phase_rad=self.phase_rad,
            waveform=self.waveform,
        )
        if waveform_ir is not None:
            ir["waveform"] = waveform_ir
        return ir


@dataclass(frozen=True, slots=True)
class MicrostripAntenna:
    width: float
    thickness: float
    height_above_magnet: float
    preview_length: float
    center_x: float = 0.0
    center_y: float = 0.0
    current_distribution: str = "uniform"

    def __post_init__(self) -> None:
        require_positive(self.width, "width")
        require_positive(self.thickness, "thickness")
        require_non_negative(self.height_above_magnet, "height_above_magnet")
        require_positive(self.preview_length, "preview_length")
        object.__setattr__(
            self,
            "current_distribution",
            require_non_empty(self.current_distribution, "current_distribution").lower(),
        )
        if self.current_distribution not in CURRENT_DISTRIBUTIONS:
            raise ValueError(
                f"current_distribution must be one of {sorted(CURRENT_DISTRIBUTIONS)}, "
                f"got {self.current_distribution!r}"
            )

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "microstrip",
            "width": self.width,
            "thickness": self.thickness,
            "height_above_magnet": self.height_above_magnet,
            "preview_length": self.preview_length,
            "center_x": self.center_x,
            "center_y": self.center_y,
            "current_distribution": self.current_distribution,
        }


@dataclass(frozen=True, slots=True)
class CPWAntenna:
    signal_width: float
    gap: float
    ground_width: float
    thickness: float
    height_above_magnet: float
    preview_length: float
    center_x: float = 0.0
    center_y: float = 0.0
    current_distribution: str = "uniform"

    def __post_init__(self) -> None:
        require_positive(self.signal_width, "signal_width")
        require_positive(self.gap, "gap")
        require_positive(self.ground_width, "ground_width")
        require_positive(self.thickness, "thickness")
        require_non_negative(self.height_above_magnet, "height_above_magnet")
        require_positive(self.preview_length, "preview_length")
        object.__setattr__(
            self,
            "current_distribution",
            require_non_empty(self.current_distribution, "current_distribution").lower(),
        )
        if self.current_distribution not in CURRENT_DISTRIBUTIONS:
            raise ValueError(
                f"current_distribution must be one of {sorted(CURRENT_DISTRIBUTIONS)}, "
                f"got {self.current_distribution!r}"
            )

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "cpw",
            "signal_width": self.signal_width,
            "gap": self.gap,
            "ground_width": self.ground_width,
            "thickness": self.thickness,
            "height_above_magnet": self.height_above_magnet,
            "preview_length": self.preview_length,
            "center_x": self.center_x,
            "center_y": self.center_y,
            "current_distribution": self.current_distribution,
        }


Antenna = MicrostripAntenna | CPWAntenna


@dataclass(frozen=True, slots=True)
class AntennaFieldSource:
    name: str
    antenna: Antenna | None = None
    drive: RfDrive | None = None
    solver: str | None = None
    air_box_factor: float | None = None
    model: str = "mqs_2p5d_az"
    object: str | None = None
    B: float | None = None
    direction: tuple[float, float, float] = (0.0, 0.0, 1.0)
    spatial_profile: dict[str, object] | None = None
    waveform: TimeDependence | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", require_non_empty(self.name, "name"))
        model = require_non_empty(self.model, "model").lower()
        object.__setattr__(self, "model", model)
        if model not in ANTENNA_FIELD_SOURCE_MODELS:
            raise ValueError(
                f"model must be one of {sorted(ANTENNA_FIELD_SOURCE_MODELS)}, got {model!r}"
            )
        object.__setattr__(self, "direction", as_vector3(self.direction, "direction"))
        if self.waveform is not None and not hasattr(self.waveform, "to_ir"):
            raise TypeError("waveform must be a Fullmag time-dependence object")

        if model == "mqs_2p5d_az":
            if self.antenna is None:
                raise ValueError("antenna is required for model='mqs_2p5d_az'")
            if self.drive is None:
                raise ValueError("drive is required for model='mqs_2p5d_az'")
            solver = require_non_empty(self.solver or "mqs_2p5d_az", "solver").lower()
            object.__setattr__(self, "solver", solver)
            air_box_factor = 12.0 if self.air_box_factor is None else self.air_box_factor
            require_positive(air_box_factor, "air_box_factor")
            object.__setattr__(self, "air_box_factor", air_box_factor)
            if solver not in ANTENNA_SOLVERS:
                raise ValueError(
                    f"solver must be one of {sorted(ANTENNA_SOLVERS)}, got {solver!r}"
                )
            return

        if self.object is None or not str(self.object).strip():
            raise ValueError("object is required for model='prescribed_zeeman_mask'")
        if self.B is None:
            raise ValueError("B is required for model='prescribed_zeeman_mask'")
        require_finite(self.B, "B")
        direction = self.direction
        norm_sq = sum(component * component for component in direction)
        if norm_sq <= 1e-30:
            raise ValueError("direction must be non-zero")
        if self.antenna is not None or self.drive is not None or self.solver is not None:
            raise ValueError(
                "prescribed_zeeman_mask must not define antenna, drive, or solver"
            )
        if self.air_box_factor is not None:
            raise ValueError("prescribed_zeeman_mask must not define air_box_factor")

    def to_ir(self) -> dict[str, object]:
        if self.model == "prescribed_zeeman_mask":
            waveform = self.waveform.to_ir() if self.waveform is not None else None
            ir = {
                "kind": "antenna_field_source",
                "name": self.name,
                "model": self.model,
                "object": str(self.object),
                "field": {
                    "amplitude_B_T": float(self.B if self.B is not None else 0.0),
                    "direction": list(self.direction),
                },
                "spatial_profile": self.spatial_profile or {"kind": "uniform"},
            }
            if waveform is not None:
                ir["waveform"] = waveform
            return ir

        assert self.antenna is not None
        assert self.drive is not None
        return {
            "kind": "antenna_field_source",
            "name": self.name,
            "model": self.model,
            "solver": self.solver or "mqs_2p5d_az",
            "antenna": self.antenna.to_ir(),
            "drive": self.drive.to_ir(),
            "air_box_factor": self.air_box_factor if self.air_box_factor is not None else 12.0,
        }


@dataclass(frozen=True, slots=True)
class SpinWaveExcitationAnalysis:
    source: str
    method: str = "source_k_profile"
    propagation_axis: tuple[float, float, float] = (1.0, 0.0, 0.0)
    k_max_rad_per_m: float | None = None
    samples: int = 256

    def __post_init__(self) -> None:
        object.__setattr__(self, "source", require_non_empty(self.source, "source"))
        object.__setattr__(self, "method", require_non_empty(self.method, "method").lower())
        object.__setattr__(
            self, "propagation_axis", as_vector3(self.propagation_axis, "propagation_axis")
        )
        if self.method not in {"source_k_profile"}:
            raise ValueError("method must currently be 'source_k_profile'")
        if self.k_max_rad_per_m is not None:
            require_positive(self.k_max_rad_per_m, "k_max_rad_per_m")
        if self.samples <= 1:
            raise ValueError("samples must be greater than 1")

    def to_ir(self) -> dict[str, object]:
        ir = {
            "source": self.source,
            "method": self.method,
            "propagation_axis": list(self.propagation_axis),
            "samples": int(self.samples),
        }
        if self.k_max_rad_per_m is not None:
            ir["k_max_rad_per_m"] = self.k_max_rad_per_m
        return ir
