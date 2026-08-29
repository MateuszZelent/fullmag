from __future__ import annotations

import copy
import math
from collections.abc import Mapping, Sequence
from typing import Any

from fullmag.model.current_transport import (
    ConservativeCurrentBoundaryFace,
    ConservativeCurrentClosedGeometry,
    ConservativeCurrentExternalLead,
    ConservativeCurrentIdentity,
    ConservativeCurrentLeadInterfacePair,
    ConservativeCurrentPins,
    ConservativeCurrentSourceCut,
    ConservativeCurrentSourceCutFacePair,
    ConservativeCurrentView,
    ImpressedPotentialJump,
    ChargeInsulating,
    ChargePotentialGauge,
    ChargeSolverPolicy,
    ChargeTransportMaterial,
    ChargeTransportMaterialAssignment,
    CurrentTransport,
    NormalCurrentElectrode,
    StructuredCurrentClosure,
    StructuredCurrentSourceCut,
    StructuredCutPlane,
    VoltageElectrode,
)
from fullmag.model.energy import (
    Constant as OerstedConstant,
    OerstedCylinder,
    OerstedField,
    PiecewiseLinear as OerstedPiecewiseLinear,
    Pulse as OerstedPulse,
    SincPulse as OerstedSincPulse,
    Sinusoidal as OerstedSinusoidal,
)
from fullmag.model.spin_torque import (
    ConstantEnvelope,
    PiecewiseLinearEnvelope,
    PrescribedSpinOrbitTorque,
    PulseEnvelope,
    RegionRef,
    SignedScalarDrive,
    SincEnvelope,
    SinusoidalEnvelope,
    SlonczewskiSTT,
    TabulatedEnvelope,
    TimeEnvelopePoint,
    VectorCurrentDrive,
    ZhangLiSTT,
)
from fullmag.model.spin_transport import (
    DriftDiffusionSpinTorque as CanonicalDriftDiffusionSpinTorque,
    SurfaceRef,
)


def _material_id(name: str) -> str:
    return f"mat:{name}"


def _magnetization_id(name: str) -> str:
    return f"mag:{name}"


def _zero_vec3() -> list[float]:
    return [0.0, 0.0, 0.0]


def _one_vec3() -> list[float]:
    return [1.0, 1.0, 1.0]


def _identity_quat() -> list[float]:
    return [0.0, 0.0, 0.0, 1.0]


def _default_mapping() -> dict[str, object]:
    return {
        "space": "object",
        "projection": "object_local",
        "clamp_mode": "none",
    }


def _default_texture_transform() -> dict[str, object]:
    return {
        "translation": _zero_vec3(),
        "rotation_quat": _identity_quat(),
        "scale": _one_vec3(),
        "pivot": _zero_vec3(),
    }


def _copy_present_collection(
    source: dict[str, Any],
    destination: dict[str, Any],
    key: str,
) -> None:
    if key not in source:
        return
    value = source[key]
    if not isinstance(value, list):
        raise ValueError(f"{key} must be a list when present")
    destination[key] = list(value)


def _mapping(value: object, context: str) -> dict[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{context} must be an object")
    return dict(value)


def _finite_number(value: object, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{context} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{context} must be a finite number")
    return result


def _positive_integer(value: object, context: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{context} must be a positive integer")
    return value


def _vec3(value: object, context: str, *, nonzero: bool = False) -> tuple[float, float, float]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence) or len(value) != 3:
        raise ValueError(f"{context} must be a three-component vector")
    result = tuple(_finite_number(component, f"{context}[{index}]") for index, component in enumerate(value))
    if nonzero and math.hypot(*result) <= 1e-12:
        raise ValueError(f"{context} must be nonzero")
    return result  # type: ignore[return-value]


def _nonempty_string(value: object, context: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{context} must be a non-empty string")
    return value.strip()


def _region_ref(value: object, context: str) -> RegionRef:
    entry = _mapping(value, context)
    object_id = _nonempty_string(entry.get("object_id"), f"{context}.object_id")
    region_id = entry.get("region_id")
    if region_id is not None:
        region_id = _nonempty_string(region_id, f"{context}.region_id")
    return RegionRef(object_id, region_id)


def _decode_current_transport(value: object) -> CurrentTransport:
    entry = _mapping(value, "current_transport")
    if entry.get("kind") != "current_transport":
        raise ValueError(f"unsupported current transport kind {entry.get('kind')!r}")
    current_density = entry.get("current_density")
    domain_value = entry.get("domain", [])
    materials_value = entry.get("materials", [])
    boundaries_value = entry.get("boundaries", [])
    if not isinstance(domain_value, list):
        raise ValueError("current_transport.domain must be a list")
    if not isinstance(materials_value, list):
        raise ValueError("current_transport.materials must be a list")
    if not isinstance(boundaries_value, list):
        raise ValueError("current_transport.boundaries must be a list")
    domain = [
        _region_ref(region, f"current_transport.domain[{index}]")
        for index, region in enumerate(domain_value)
    ]
    materials: list[ChargeTransportMaterialAssignment] = []
    for index, raw_assignment in enumerate(materials_value):
        assignment = _mapping(raw_assignment, f"current_transport.materials[{index}]")
        material = _mapping(
            assignment.get("material"),
            f"current_transport.materials[{index}].material",
        )
        materials.append(
            ChargeTransportMaterialAssignment(
                _region_ref(
                    assignment.get("region"),
                    f"current_transport.materials[{index}].region",
                ),
                ChargeTransportMaterial(
                    _finite_number(
                        material.get("sigma_Spm"),
                        f"current_transport.materials[{index}].material.sigma_Spm",
                    ),
                    sigma_parallel_Spm=(
                        _finite_number(
                            material.get("sigma_parallel_Spm"),
                            f"current_transport.materials[{index}].material.sigma_parallel_Spm",
                        )
                        if material.get("sigma_parallel_Spm") is not None
                        else None
                    ),
                    sigma_perpendicular_Spm=(
                        _finite_number(
                            material.get("sigma_perpendicular_Spm"),
                            f"current_transport.materials[{index}].material.sigma_perpendicular_Spm",
                        )
                        if material.get("sigma_perpendicular_Spm") is not None
                        else None
                    ),
                    sigma_AHE_Spm=(
                        _finite_number(
                            material.get("sigma_AHE_Spm"),
                            f"current_transport.materials[{index}].material.sigma_AHE_Spm",
                        )
                        if material.get("sigma_AHE_Spm") is not None
                        else None
                    ),
                ),
            )
        )

    boundaries = []
    for index, raw_boundary in enumerate(boundaries_value):
        boundary = _mapping(raw_boundary, f"current_transport.boundaries[{index}]")
        surfaces_value = boundary.get("surfaces")
        if not isinstance(surfaces_value, list):
            raise ValueError(f"current_transport.boundaries[{index}].surfaces must be a list")
        surfaces = []
        for surface_index, raw_surface in enumerate(surfaces_value):
            surface = _mapping(
                raw_surface,
                f"current_transport.boundaries[{index}].surfaces[{surface_index}]",
            )
            surfaces.append(
                SurfaceRef(
                    _nonempty_string(
                        surface.get("object_id"),
                        f"current_transport.boundaries[{index}].surfaces[{surface_index}].object_id",
                    ),
                    _nonempty_string(
                        surface.get("surface_id"),
                        f"current_transport.boundaries[{index}].surfaces[{surface_index}].surface_id",
                    ),
                    _vec3(
                        surface.get("orientation"),
                        f"current_transport.boundaries[{index}].surfaces[{surface_index}].orientation",
                        nonzero=True,
                    ),
                )
            )
        boundary_id = _nonempty_string(
            boundary.get("id"), f"current_transport.boundaries[{index}].id"
        )
        kind = boundary.get("kind")
        if kind == "voltage_electrode":
            boundaries.append(
                VoltageElectrode(
                    boundary_id,
                    surfaces,
                    potential_V=_finite_number(
                        boundary.get("potential_V"),
                        f"current_transport.boundaries[{index}].potential_V",
                    ),
                )
            )
        elif kind == "normal_current_electrode":
            boundaries.append(
                NormalCurrentElectrode(
                    boundary_id,
                    surfaces,
                    outward_current_density_Apm2=_finite_number(
                        boundary.get("outward_current_density_Apm2"),
                        f"current_transport.boundaries[{index}].outward_current_density_Apm2",
                    ),
                )
            )
        elif kind == "insulating":
            boundaries.append(ChargeInsulating(boundary_id, surfaces))
        else:
            raise ValueError(f"unsupported charge boundary kind {kind!r}")

    gauge_value = entry.get("gauge")
    solver_value = entry.get("solver")
    solver = None
    if solver_value is not None:
        solver_entry = _mapping(solver_value, "current_transport.solver")
        linear = _mapping(solver_entry.get("linear"), "current_transport.solver.linear")
        solver = ChargeSolverPolicy(
            engine=_nonempty_string(solver_entry.get("engine"), "current_transport.solver.engine"),
            relative_tolerance=_finite_number(
                linear.get("relative_tolerance"),
                "current_transport.solver.linear.relative_tolerance",
            ),
            absolute_tolerance=_finite_number(
                linear.get("absolute_tolerance"),
                "current_transport.solver.linear.absolute_tolerance",
            ),
            max_iterations=_positive_integer(
                linear.get("max_iterations"),
                "current_transport.solver.linear.max_iterations",
            ),
            physical_residual_version=_nonempty_string(
                solver_entry.get("physical_residual_version"),
                "current_transport.solver.physical_residual_version",
            ),
            operator_version=_nonempty_string(
                solver_entry.get("operator_version"),
                "current_transport.solver.operator_version",
            ),
        )
    conservative_view_value = entry.get("conservative_current_view")
    structured_closure_value = entry.get("structured_current_closure")
    return CurrentTransport(
        name=_nonempty_string(entry.get("name"), "current_transport.name"),
        model=_nonempty_string(entry.get("model", "prescribed_density"), "current_transport.model"),
        current_density=(
            _vec3(current_density, "current_transport.current_density")
            if current_density is not None
            else None
        ),
        solve_region=(
            _nonempty_string(entry["solve_region"], "current_transport.solve_region")
            if entry.get("solve_region") is not None
            else None
        ),
        conductivity_s_per_m=(
            _finite_number(entry["conductivity_s_per_m"], "current_transport.conductivity_s_per_m")
            if entry.get("conductivity_s_per_m") is not None
            else None
        ),
        coupling=_nonempty_string(
            entry.get("coupling", "one_way"), "current_transport.coupling"
        ),
        domain=domain,
        materials=materials,
        boundaries=boundaries,
        gauge=(
            ChargePotentialGauge(
                _nonempty_string(gauge_value, "current_transport.gauge")
            )
            if gauge_value is not None
            else None
        ),
        solver=solver,
        time_envelope=(
            _decode_sot_envelope(entry["time_envelope"])
            if entry.get("time_envelope") is not None
            else None
        ),
        conservative_current_view=(
            _decode_conservative_current_view(conservative_view_value)
            if conservative_view_value is not None
            else None
        ),
        structured_current_closure=(
            _decode_structured_current_closure(structured_closure_value)
            if structured_closure_value is not None
            else None
        ),
    )


def _decode_structured_current_closure(value: object) -> StructuredCurrentClosure:
    entry = _mapping(value, "current_transport.structured_current_closure")
    cuts_value = entry.get("source_cuts")
    if not isinstance(cuts_value, list):
        raise ValueError(
            "current_transport.structured_current_closure.source_cuts must be a list"
        )
    cuts: list[StructuredCurrentSourceCut] = []
    for index, raw_cut in enumerate(cuts_value):
        context = f"current_transport.structured_current_closure.source_cuts[{index}]"
        cut = _mapping(raw_cut, context)
        plane = _mapping(cut.get("plane"), f"{context}.plane")
        drive = _mapping(cut.get("drive"), f"{context}.drive")
        if drive.get("kind") != "impressed_potential_jump":
            raise ValueError(f"{context}.drive.kind must be 'impressed_potential_jump'")
        cuts.append(
            StructuredCurrentSourceCut(
                source_cut_id=_nonempty_string(
                    cut.get("source_cut_id"), f"{context}.source_cut_id"
                ),
                circuit_id=_nonempty_string(
                    cut.get("circuit_id"), f"{context}.circuit_id"
                ),
                region=_region_ref(cut.get("region"), f"{context}.region"),
                plane=StructuredCutPlane(
                    axis=_nonempty_string(plane.get("axis"), f"{context}.plane.axis"),
                    offset_m=_finite_number(
                        plane.get("offset_m"), f"{context}.plane.offset_m"
                    ),
                    normal=_nonempty_string(
                        plane.get("normal"), f"{context}.plane.normal"
                    ),
                ),
                drive=ImpressedPotentialJump(
                    drive_id=_nonempty_string(
                        drive.get("drive_id"), f"{context}.drive.drive_id"
                    ),
                    potential_jump_V=_finite_number(
                        drive.get("potential_jump_V"),
                        f"{context}.drive.potential_jump_V",
                    ),
                    schema_version=_nonempty_string(
                        drive.get("schema_version"),
                        f"{context}.drive.schema_version",
                    ),
                ),
            )
        )
    return StructuredCurrentClosure(
        closure_id=_nonempty_string(
            entry.get("closure_id"),
            "current_transport.structured_current_closure.closure_id",
        ),
        source_cuts=cuts,
        schema_version=_nonempty_string(
            entry.get("schema_version"),
            "current_transport.structured_current_closure.schema_version",
        ),
        kind=_nonempty_string(
            entry.get("kind"),
            "current_transport.structured_current_closure.kind",
        ),
    )


def _decode_conservative_current_view(value: object) -> ConservativeCurrentView:
    entry = _mapping(value, "current_transport.conservative_current_view")
    stable_ids = entry.get("stable_vertex_ids")
    if not isinstance(stable_ids, list):
        raise ValueError("current_transport.conservative_current_view.stable_vertex_ids must be a list")

    boundary_value = entry.get("boundary_faces")
    if not isinstance(boundary_value, list):
        raise ValueError("current_transport.conservative_current_view.boundary_faces must be a list")
    boundary_faces = []
    for index, raw_face in enumerate(boundary_value):
        face = _mapping(raw_face, f"current_transport.conservative_current_view.boundary_faces[{index}]")
        face_ids = face.get("face_vertex_ids")
        if not isinstance(face_ids, list):
            raise ValueError(f"current_transport.conservative_current_view.boundary_faces[{index}].face_vertex_ids must be a list")
        boundary_faces.append(
            ConservativeCurrentBoundaryFace(
                face_ids,
                _nonempty_string(face.get("role"), f"current_transport.conservative_current_view.boundary_faces[{index}].role"),
                circuit_id=(
                    _nonempty_string(face.get("circuit_id"), f"current_transport.conservative_current_view.boundary_faces[{index}].circuit_id")
                    if face.get("circuit_id") is not None
                    else None
                ),
            )
        )

    identity_value = _mapping(entry.get("identity"), "current_transport.conservative_current_view.identity")
    identity = ConservativeCurrentIdentity(
        source_module_id=_nonempty_string(identity_value.get("source_module_id"), "conservative_current_view.identity.source_module_id"),
        source_state_revision=_nonempty_string(identity_value.get("source_state_revision"), "conservative_current_view.identity.source_state_revision"),
        source_field_digest=_nonempty_string(identity_value.get("source_field_digest"), "conservative_current_view.identity.source_field_digest"),
        conductivity_digest=_nonempty_string(identity_value.get("conductivity_digest"), "conservative_current_view.identity.conductivity_digest"),
        mesh_revision=_nonempty_string(identity_value.get("mesh_revision"), "conservative_current_view.identity.mesh_revision"),
        topology_revision=_nonempty_string(identity_value.get("topology_revision"), "conservative_current_view.identity.topology_revision"),
        geometry_digest=_nonempty_string(identity_value.get("geometry_digest"), "conservative_current_view.identity.geometry_digest"),
        envelope_revision=_nonempty_string(identity_value.get("envelope_revision"), "conservative_current_view.identity.envelope_revision"),
        envelope_digest=_nonempty_string(identity_value.get("envelope_digest"), "conservative_current_view.identity.envelope_digest"),
        evaluated_envelope_multiplier=_finite_number(identity_value.get("evaluated_envelope_multiplier"), "conservative_current_view.identity.evaluated_envelope_multiplier"),
        evaluation_time_s=_finite_number(identity_value.get("evaluation_time_s"), "conservative_current_view.identity.evaluation_time_s"),
        stage_identity=_positive_integer(identity_value.get("stage_identity"), "conservative_current_view.identity.stage_identity"),
    )

    pins_value = _mapping(entry.get("pins"), "current_transport.conservative_current_view.pins")
    pins = ConservativeCurrentPins(
        required_source_state_revision=_nonempty_string(pins_value.get("required_source_state_revision"), "conservative_current_view.pins.required_source_state_revision"),
        required_source_field_digest=_nonempty_string(pins_value.get("required_source_field_digest"), "conservative_current_view.pins.required_source_field_digest"),
        required_mesh_revision=_nonempty_string(pins_value.get("required_mesh_revision"), "conservative_current_view.pins.required_mesh_revision"),
        required_topology_revision=_nonempty_string(pins_value.get("required_topology_revision"), "conservative_current_view.pins.required_topology_revision"),
    )

    closure_value = _mapping(entry.get("closure"), "current_transport.conservative_current_view.closure")
    if closure_value.get("kind") == "external_lead":
        lead_mesh = _mapping(
            closure_value.get("lead_mesh"),
            "conservative_current_view.closure.lead_mesh",
        )
        conductivity = closure_value.get("lead_conductivity_spm_per_element")
        stable_lead_ids = closure_value.get("lead_stable_vertex_ids")
        interface_value = closure_value.get("interface_pairs")
        minus_value = closure_value.get("minus_outer_electrode_face_vertex_ids")
        plus_value = closure_value.get("plus_outer_electrode_face_vertex_ids")
        if not isinstance(conductivity, list):
            raise ValueError("external lead conductivity must be a list")
        if not isinstance(stable_lead_ids, list):
            raise ValueError("external lead stable_vertex_ids must be a list")
        if not isinstance(interface_value, list):
            raise ValueError("external lead interface_pairs must be a list")
        if not isinstance(minus_value, list) or not isinstance(plus_value, list):
            raise ValueError("external lead outer electrode faces must be lists")
        interface_pairs = []
        for index, raw_pair in enumerate(interface_value):
            pair = raw_pair if isinstance(raw_pair, list) else None
            if pair is None or len(pair) != 2 or not isinstance(pair[0], list) or not isinstance(pair[1], list):
                raise ValueError(
                    f"external lead interface_pairs[{index}] must contain two face ID lists"
                )
            interface_pairs.append(ConservativeCurrentLeadInterfacePair(pair[0], pair[1]))
        closure = ConservativeCurrentExternalLead(
            operator_version=_nonempty_string(
                closure_value.get("operator_version"),
                "conservative_current_view.closure.operator_version",
            ),
            revision=_nonempty_string(
                closure_value.get("revision"),
                "conservative_current_view.closure.revision",
            ),
            digest=_nonempty_string(
                closure_value.get("digest"),
                "conservative_current_view.closure.digest",
            ),
            drive_id=_nonempty_string(
                closure_value.get("drive_id"),
                "conservative_current_view.closure.drive_id",
            ),
            outer_electrode_potential_drop_v=_finite_number(
                closure_value.get("outer_electrode_potential_drop_v"),
                "conservative_current_view.closure.outer_electrode_potential_drop_v",
            ),
            lead_mesh=lead_mesh,
            lead_conductivity_spm_per_element=conductivity,
            lead_stable_vertex_ids=stable_lead_ids,
            interface_pairs=interface_pairs,
            minus_outer_electrode_face_vertex_ids=minus_value,
            plus_outer_electrode_face_vertex_ids=plus_value,
            lead_conductivity_digest=_nonempty_string(
                closure_value.get("lead_conductivity_digest"),
                "conservative_current_view.closure.lead_conductivity_digest",
            ),
        )
        reference_mpi = entry.get("reference_mpi_gather_broadcast", False)
        if not isinstance(reference_mpi, bool):
            raise ValueError("conservative_current_view.reference_mpi_gather_broadcast must be boolean")
        return ConservativeCurrentView(
            stable_vertex_ids=stable_ids,
            boundary_faces=boundary_faces,
            identity=identity,
            pins=pins,
            closure=closure,
            algebraic_relative_tolerance=_finite_number(entry.get("algebraic_relative_tolerance"), "conservative_current_view.algebraic_relative_tolerance"),
            physical_relative_gate=_finite_number(entry.get("physical_relative_gate"), "conservative_current_view.physical_relative_gate"),
            physical_absolute_gate_a=_finite_number(entry.get("physical_absolute_gate_a"), "conservative_current_view.physical_absolute_gate_a"),
            reference_mpi_gather_broadcast=reference_mpi,
        )
    if closure_value.get("kind") != "closed_geometry":
        raise ValueError(
            "current_transport.conservative_current_view currently supports only closed_geometry closure"
        )
    source_cuts_value = closure_value.get("source_cuts")
    if not isinstance(source_cuts_value, list):
        raise ValueError("conservative_current_view.closure.source_cuts must be a list")
    source_cuts = []
    for index, raw_cut in enumerate(source_cuts_value):
        cut = _mapping(raw_cut, f"conservative_current_view.closure.source_cuts[{index}]")
        pairs_value = cut.get("face_pairs")
        if not isinstance(pairs_value, list):
            raise ValueError(f"conservative_current_view.closure.source_cuts[{index}].face_pairs must be a list")
        pairs = []
        for pair_index, raw_pair in enumerate(pairs_value):
            pair = _mapping(raw_pair, f"conservative_current_view.closure.source_cuts[{index}].face_pairs[{pair_index}]")
            minus = pair.get("minus_face_vertex_ids")
            plus = pair.get("plus_face_vertex_ids")
            if not isinstance(minus, list) or not isinstance(plus, list):
                raise ValueError("source-cut face-pair vertex IDs must be lists")
            pairs.append(ConservativeCurrentSourceCutFacePair(minus, plus))
        source_cuts.append(
            ConservativeCurrentSourceCut(
                _nonempty_string(cut.get("id"), f"conservative_current_view.closure.source_cuts[{index}].id"),
                _vec3(cut.get("translation_m"), f"conservative_current_view.closure.source_cuts[{index}].translation_m"),
                _finite_number(cut.get("potential_drop_v"), f"conservative_current_view.closure.source_cuts[{index}].potential_drop_v"),
                pairs,
            )
        )
    closure = ConservativeCurrentClosedGeometry(
        _nonempty_string(closure_value.get("operator_version"), "conservative_current_view.closure.operator_version"),
        _nonempty_string(closure_value.get("revision"), "conservative_current_view.closure.revision"),
        _nonempty_string(closure_value.get("digest"), "conservative_current_view.closure.digest"),
        source_cuts,
    )
    reference_mpi = entry.get("reference_mpi_gather_broadcast", False)
    if not isinstance(reference_mpi, bool):
        raise ValueError("conservative_current_view.reference_mpi_gather_broadcast must be boolean")
    return ConservativeCurrentView(
        stable_vertex_ids=stable_ids,
        boundary_faces=boundary_faces,
        identity=identity,
        pins=pins,
        closure=closure,
        algebraic_relative_tolerance=_finite_number(entry.get("algebraic_relative_tolerance"), "conservative_current_view.algebraic_relative_tolerance"),
        physical_relative_gate=_finite_number(entry.get("physical_relative_gate"), "conservative_current_view.physical_relative_gate"),
        physical_absolute_gate_a=_finite_number(entry.get("physical_absolute_gate_a"), "conservative_current_view.physical_absolute_gate_a"),
        reference_mpi_gather_broadcast=reference_mpi,
    )


def _decode_sot_envelope(value: object) -> object:
    entry = _mapping(value, "prescribed_sot.drive.envelope")
    kind = entry.get("kind")
    if kind == "constant":
        return ConstantEnvelope(_finite_number(entry.get("value"), "envelope.value"))
    if kind == "sinusoidal":
        return SinusoidalEnvelope(
            _finite_number(entry.get("amplitude"), "envelope.amplitude"),
            _finite_number(entry.get("frequency_hz"), "envelope.frequency_hz"),
            phase_rad=_finite_number(entry.get("phase_rad"), "envelope.phase_rad"),
            offset=_finite_number(entry.get("offset"), "envelope.offset"),
        )
    if kind == "pulse":
        return PulseEnvelope(
            _finite_number(entry.get("amplitude"), "envelope.amplitude"),
            _finite_number(entry.get("t_on_s"), "envelope.t_on_s"),
            _finite_number(entry.get("t_off_s"), "envelope.t_off_s"),
        )
    if kind == "piecewise_linear":
        points = entry.get("points")
        if not isinstance(points, list):
            raise ValueError("envelope.points must be a list")
        return PiecewiseLinearEnvelope(
            [
                TimeEnvelopePoint(
                    _finite_number(_mapping(point, f"envelope.points[{index}]").get("time_s"), f"envelope.points[{index}].time_s"),
                    _finite_number(_mapping(point, f"envelope.points[{index}]").get("value"), f"envelope.points[{index}].value"),
                )
                for index, point in enumerate(points)
            ]
        )
    if kind == "sinc":
        return SincEnvelope(
            _finite_number(entry.get("amplitude"), "envelope.amplitude"),
            center_s=_finite_number(entry.get("center_s"), "envelope.center_s"),
            bandwidth_hz=_finite_number(entry.get("bandwidth_hz"), "envelope.bandwidth_hz"),
            offset=_finite_number(entry.get("offset"), "envelope.offset"),
        )
    if kind == "tabulated":
        bandwidth = entry.get("bandwidth_hz")
        return TabulatedEnvelope(
            _nonempty_string(entry.get("artifact_ref"), "envelope.artifact_ref"),
            interpolation=_nonempty_string(entry.get("interpolation"), "envelope.interpolation"),
            extrapolation=_nonempty_string(entry.get("extrapolation"), "envelope.extrapolation"),
            bandwidth_hz=(
                _finite_number(bandwidth, "envelope.bandwidth_hz") if bandwidth is not None else None
            ),
        )
    raise ValueError(f"unsupported prescribed SOT envelope kind {kind!r}")


def _decode_prescribed_sot(entry: dict[str, object]) -> PrescribedSpinOrbitTorque:
    if entry.get("schema_version") != "prescribed_sot.v1":
        raise ValueError("unsupported prescribed SOT schema_version")
    formula = entry.get("formula_version")
    module_id = _nonempty_string(entry.get("id"), "prescribed_sot.id")
    drive = _mapping(entry.get("drive"), "prescribed_sot.drive")
    if formula == "prescribed_sot.legacy_fullmag.v0":
        prefix = "legacy_prescribed_sot_"
        if not module_id.startswith(prefix) or not module_id[len(prefix):].isdigit():
            raise ValueError("legacy prescribed SOT id must encode module_index")
        kind = drive.get("kind")
        kwargs: dict[str, object] = {}
        if kind == "legacy_scalar_magnitude":
            kwargs["raw_charge_current_density_Apm2"] = _finite_number(
                drive.get("raw_charge_current_density_Apm2"), "prescribed_sot.drive.raw_charge_current_density_Apm2"
            )
        elif kind == "legacy_current_source_norm":
            kwargs["current_source_id"] = _nonempty_string(
                drive.get("current_source_id"), "prescribed_sot.drive.current_source_id"
            )
        else:
            raise ValueError(f"unsupported legacy prescribed SOT drive kind {kind!r}")
        return PrescribedSpinOrbitTorque.from_legacy_v0(
            module_index=int(module_id[len(prefix):]),
            target=None,
            raw_spin_polarization=_vec3(entry.get("raw_spin_polarization"), "prescribed_sot.raw_spin_polarization"),
            xi_dl=_finite_number(entry.get("xi_dl"), "prescribed_sot.xi_dl"),
            xi_fl=_finite_number(entry.get("xi_fl"), "prescribed_sot.xi_fl"),
            free_layer_thickness_m=_finite_number(entry.get("free_layer_thickness_m"), "prescribed_sot.free_layer_thickness_m"),
            compatibility_origin=_mapping(entry.get("compatibility_origin"), "prescribed_sot.compatibility_origin"),
            **kwargs,  # type: ignore[arg-type]
        )
    if formula != "prescribed_sot.fullmag.v1":
        raise ValueError(f"unsupported prescribed SOT formula_version {formula!r}")
    drive_kind = drive.get("kind")
    if drive_kind == "signed_scalar":
        envelope = drive.get("envelope")
        decoded_drive = SignedScalarDrive(
            _finite_number(drive.get("current_density_Apm2"), "prescribed_sot.drive.current_density_Apm2"),
            _vec3(drive.get("sigma_hat"), "prescribed_sot.drive.sigma_hat", nonzero=True),
            _decode_sot_envelope(envelope) if envelope is not None else None,  # type: ignore[arg-type]
        )
    elif drive_kind == "vector_current_source":
        decoded_drive = VectorCurrentDrive(
            _nonempty_string(drive.get("current_source_id"), "prescribed_sot.drive.current_source_id"),
            _vec3(drive.get("drive_direction"), "prescribed_sot.drive.drive_direction", nonzero=True),
            _vec3(drive.get("interface_normal"), "prescribed_sot.drive.interface_normal", nonzero=True),
        )
    else:
        raise ValueError(f"unsupported prescribed SOT drive kind {drive_kind!r}")
    return PrescribedSpinOrbitTorque(
        module_id,
        _region_ref(entry.get("target"), "prescribed_sot.target"),
        decoded_drive,
        xi_dl=_finite_number(entry.get("xi_dl"), "prescribed_sot.xi_dl"),
        xi_fl=_finite_number(entry.get("xi_fl"), "prescribed_sot.xi_fl"),
        free_layer_thickness_m=_finite_number(entry.get("free_layer_thickness_m"), "prescribed_sot.free_layer_thickness_m"),
    )


def _decode_spin_torque(value: object) -> object:
    entry = _mapping(value, "spin_torque")
    kind = entry.get("kind")
    if kind == "drift_diffusion_spin_torque":
        if entry.get("schema_version") != "drift_diffusion_spin_torque.v1":
            raise ValueError("unsupported drift-diffusion spin-torque schema_version")
        if entry.get("formula_version") != "transport_torque_angular_momentum.fullmag.v1":
            raise ValueError("unsupported drift-diffusion spin-torque formula_version")
        return CanonicalDriftDiffusionSpinTorque(
            id=_nonempty_string(entry.get("id"), "drift_diffusion_spin_torque.id"),
            solve_id=_nonempty_string(
                entry.get("solve_id"), "drift_diffusion_spin_torque.solve_id"
            ),
            target=_region_ref(entry.get("target"), "drift_diffusion_spin_torque.target"),
        )
    if kind == "prescribed_sot":
        return _decode_prescribed_sot(entry)
    if kind not in {"slonczewski", "zhang_li"}:
        raise ValueError(f"unsupported spin torque kind {kind!r}")
    density = entry.get("current_density")
    source = entry.get("current_source")
    binding: dict[str, object]
    if (density is None) == (source is None):
        raise ValueError(f"{kind} requires exactly one current binding")
    binding = (
        {"current_density": _vec3(density, f"{kind}.current_density")}
        if density is not None
        else {"current_source": _nonempty_string(source, f"{kind}.current_source")}
    )
    if kind == "zhang_li":
        formula = entry.get("formula_version", "zhang_li.legacy_fullmag.v0")
        common: dict[str, object] = {**binding}
        if formula in {"zhang_li.fullmag.v1", "zhang_li.mumax3.v1"}:
            required_operator = (
                "zl_mumax3_central_v1"
                if formula == "zhang_li.mumax3.v1"
                else "zl_central_reference_v1"
            )
            if entry.get("schema_version") != "zhang_li_torque.v1":
                raise ValueError("canonical Zhang-Li schema_version must be zhang_li_torque.v1")
            if entry.get("operator_version") != required_operator:
                raise ValueError(f"canonical Zhang-Li requires {required_operator}")
            common.update(
                id=_nonempty_string(entry.get("id"), "zhang_li.id"),
                target=_region_ref(entry.get("target"), "zhang_li.target"),
                lande_g=_finite_number(entry.get("lande_g"), "zhang_li.lande_g"),
                operator_version=required_operator,
            )
        elif formula != "zhang_li.legacy_fullmag.v0":
            raise ValueError(f"unsupported Zhang-Li formula_version {formula!r}")
        return ZhangLiSTT(
            degree=_finite_number(entry.get("degree"), "zhang_li.degree"),
            beta=_finite_number(entry.get("beta"), "zhang_li.beta"),
            **common,  # type: ignore[arg-type]
        )
    if kind == "slonczewski":
        formula = entry.get("formula_version", "slonczewski.legacy_fullmag.v0")
        common: dict[str, object] = {
            **binding,
            "spin_polarization": _vec3(entry.get("spin_polarization"), "slonczewski.spin_polarization", nonzero=formula in {"slonczewski.fullmag.v2", "slonczewski.fullmag.v1"}),
            "degree": _finite_number(entry.get("degree"), "slonczewski.degree"),
            "lambda_asymmetry": _finite_number(entry.get("lambda_asymmetry"), "slonczewski.lambda_asymmetry"),
            "epsilon_prime": _finite_number(entry.get("epsilon_prime"), "slonczewski.epsilon_prime"),
        }
        thickness = entry.get("free_layer_thickness_m")
        if thickness is not None:
            common["free_layer_thickness_m"] = _finite_number(thickness, "slonczewski.free_layer_thickness_m")
        if formula == "slonczewski.fullmag.v2":
            if entry.get("schema_version") != "slonczewski_torque.v1" or entry.get("realization") != {
                "kind": "thin_layer_homogenized",
                "realization_version": "slonczewski_thin_layer_homogenized.v1",
            }:
                raise ValueError("unsupported canonical Slonczewski realization")
            return SlonczewskiSTT(
                id=_nonempty_string(entry.get("id"), "slonczewski.id"),
                target=_region_ref(entry.get("target"), "slonczewski.target"),
                stack_normal=_vec3(entry.get("stack_normal"), "slonczewski.stack_normal", nonzero=True),
                **common,  # type: ignore[arg-type]
            )
        if formula == "slonczewski.fullmag.v1":
            raise ValueError("slonczewski.fullmag.v1 is read-only provenance; use slonczewski.fullmag.v2")
        if formula != "slonczewski.legacy_fullmag.v0":
            raise ValueError(f"unsupported Slonczewski formula_version {formula!r}")
        return SlonczewskiSTT(
            fixed_layer_position=_nonempty_string(entry.get("fixed_layer_position", "top"), "slonczewski.fixed_layer_position"),
            **common,  # type: ignore[arg-type]
        )
    raise ValueError(f"unsupported spin torque kind {kind!r}")


def _decode_oersted_time_dependence(value: object) -> object:
    entry = _mapping(value, "oersted_field.time_dependence")
    kind = entry.get("kind")
    if kind == "constant":
        return OerstedConstant()
    if kind == "sinusoidal":
        return OerstedSinusoidal(
            _finite_number(entry.get("frequency_hz"), "time_dependence.frequency_hz"),
            phase_rad=_finite_number(entry.get("phase_rad"), "time_dependence.phase_rad"),
            offset=_finite_number(entry.get("offset"), "time_dependence.offset"),
        )
    if kind == "pulse":
        return OerstedPulse(
            _finite_number(entry.get("t_on"), "time_dependence.t_on"),
            _finite_number(entry.get("t_off"), "time_dependence.t_off"),
        )
    if kind == "piecewise_linear":
        points = entry.get("points")
        if not isinstance(points, list):
            raise ValueError("time_dependence.points must be a list")
        decoded_points = []
        for index, point in enumerate(points):
            if not isinstance(point, (list, tuple)) or len(point) != 2:
                raise ValueError(f"time_dependence.points[{index}] must be a pair")
            decoded_points.append([
                _finite_number(point[0], f"time_dependence.points[{index}][0]"),
                _finite_number(point[1], f"time_dependence.points[{index}][1]"),
            ])
        return OerstedPiecewiseLinear(decoded_points)
    if kind == "sinc_pulse":
        return OerstedSincPulse(
            _finite_number(entry.get("cutoff_hz"), "time_dependence.cutoff_hz"),
            t0=_finite_number(entry.get("t0"), "time_dependence.t0"),
            amplitude=_finite_number(entry.get("amplitude"), "time_dependence.amplitude"),
        )
    raise ValueError(f"unsupported Oersted time-dependence kind {kind!r}")


def _decode_oersted_field(value: object) -> OerstedCylinder | OerstedField:
    entry = _mapping(value, "oersted_field")
    kind = entry.get("kind")
    if kind == "oersted_field":
        source = _nonempty_string(entry.get("source"), "oersted_field.source")
        return OerstedField(
            source=source,
            model=_nonempty_string(entry.get("model"), "oersted_field.model"),
            id=_nonempty_string(entry.get("id", f"oersted:{source}"), "oersted_field.id"),
        )
    if kind == "oersted_cylinder":
        time_dependence = entry.get("time_dependence")
        return OerstedCylinder(
            current=_finite_number(entry.get("current"), "oersted_cylinder.current"),
            radius=_finite_number(entry.get("radius"), "oersted_cylinder.radius"),
            center=_vec3(entry.get("center"), "oersted_cylinder.center"),
            axis=_vec3(entry.get("axis"), "oersted_cylinder.axis", nonzero=True),
            time_dependence=(
                _decode_oersted_time_dependence(time_dependence) if time_dependence is not None else None
            ),  # type: ignore[arg-type]
            id=_nonempty_string(entry.get("id", "oersted:cylinder"), "oersted_cylinder.id"),
        )
    raise ValueError(f"unsupported Oersted field kind {kind!r}")


def _canonical_current_transports(values: object) -> list[dict[str, object]]:
    if not isinstance(values, list):
        raise ValueError("current_transports must be a list")
    return [_decode_current_transport(value).to_ir() for value in values]


def _canonical_spin_transports(values: object, *, scene_ids: bool) -> list[dict[str, object]]:
    """Preserve the validated ProblemIR payload for UI round-trip."""
    if not isinstance(values, list):
        raise ValueError("spin_transports must be a list")
    result: list[dict[str, object]] = []
    for index, value in enumerate(values):
        entry = _mapping(copy.deepcopy(value), f"spin_transports[{index}]")
        if entry.get("schema_version") != "spin_transport.v1":
            raise ValueError("spin transport schema_version must be spin_transport.v1")
        for key in ("id", "current_source_id"):
            if not isinstance(entry.get(key), str) or not str(entry[key]).strip():
                raise ValueError(f"spin_transports[{index}].{key} must be a non-empty string")
        for key in ("domain", "materials"):
            if not isinstance(entry.get(key), list) or not entry[key]:
                raise ValueError(f"spin_transports[{index}].{key} must be a non-empty list")
        canonical = entry
        if scene_ids and "id" not in canonical:
            canonical = {"id": f"spin-transport:{index}", **canonical}
        result.append(canonical)
    return result


def _canonical_spin_torques(values: object, *, scene_ids: bool) -> list[dict[str, object]]:
    if not isinstance(values, list):
        raise ValueError("spin_torques must be a list")
    result: list[dict[str, object]] = []
    for index, value in enumerate(values):
        entry = _mapping(copy.deepcopy(value), f"spin_torques[{index}]")
        kind = entry.get("kind")
        formula = entry.get("formula_version")
        if (
            (kind == "zhang_li" and formula not in {"zhang_li.fullmag.v1", "zhang_li.mumax3.v1"})
            or (
                kind == "slonczewski"
                and formula not in {"slonczewski.fullmag.v2", "slonczewski.fullmag.v1"}
            )
        ):
            entry.pop("id", None)
        module = _decode_spin_torque(entry)
        canonical = module.to_ir_module()  # type: ignore[attr-defined]
        if scene_ids and "id" not in canonical:
            canonical = {"id": f"spin-torque:{index}", **canonical}
        result.append(canonical)
    return result


def _canonical_oersted_fields(values: object, *, scene_ids: bool) -> list[dict[str, object]]:
    if not isinstance(values, list):
        raise ValueError("oersted_fields must be a list")
    result = []
    for index, value in enumerate(values):
        canonical = _decode_oersted_field(copy.deepcopy(value)).to_ir()
        result.append({"id": f"oersted-field:{index}", **canonical} if scene_ids else canonical)
    return result


_INTERACTION_ORDER = (
    "exchange",
    "demag",
    "interfacial_dmi",
    "bulk_dmi",
    "uniaxial_anisotropy",
)


def _stage_relax_algorithm(stage: dict[str, Any]) -> object:
    has_canonical = "algorithm" in stage
    has_legacy = "relax_algorithm" in stage
    if has_canonical and has_legacy:
        raise ValueError(
            "stage must not contain both 'algorithm' and legacy 'relax_algorithm'"
        )
    if has_canonical:
        return stage.get("algorithm")
    return stage.get("relax_algorithm")


def _canonical_scene_stage(raw_stage: object) -> object:
    if not isinstance(raw_stage, dict):
        return raw_stage
    stage = dict(raw_stage)
    algorithm = _stage_relax_algorithm(stage)
    had_algorithm = "algorithm" in stage or "relax_algorithm" in stage
    stage.pop("relax_algorithm", None)
    if had_algorithm:
        stage["algorithm"] = algorithm
    return stage


def _normalize_axis3(value: object) -> list[float]:
    if isinstance(value, list) and len(value) == 3:
        try:
            return [float(value[0]), float(value[1]), float(value[2])]
        except (TypeError, ValueError):
            return [0.0, 0.0, 1.0]
    return [0.0, 0.0, 1.0]


def _default_interaction_params(
    kind: str,
    *,
    material_dind: object,
    material_dbulk: object,
) -> dict[str, object] | None:
    if kind == "interfacial_dmi":
        dind = _number_or_none(material_dind)
        return {"dind": dind if dind is not None else 1e-3}
    if kind == "bulk_dmi":
        dbulk = _number_or_none(material_dbulk)
        return {"dbulk": dbulk if dbulk is not None else 1e-3}
    if kind == "uniaxial_anisotropy":
        return {"ku1": 0.0, "axis": [0.0, 0.0, 1.0]}
    return None


def _normalize_interaction_entry(
    raw: object,
    *,
    material_dind: object,
    material_dbulk: object,
) -> dict[str, object] | None:
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("kind") or "").strip()
    if kind not in _INTERACTION_ORDER:
        return None
    if kind in {"exchange", "demag"}:
        return {"kind": kind, "enabled": bool(raw.get("enabled", True)), "params": None}
    params = raw.get("params")
    params_map = dict(params) if isinstance(params, dict) else (
        _default_interaction_params(
            kind,
            material_dind=material_dind,
            material_dbulk=material_dbulk,
        ) or {}
    )
    if kind == "interfacial_dmi":
        dind = _number_or_none(params_map.get("dind"))
        if dind is None:
            dind = _number_or_none(material_dind)
        params_map["dind"] = dind if dind is not None else 1e-3
    elif kind == "bulk_dmi":
        dbulk = _number_or_none(params_map.get("dbulk"))
        if dbulk is None:
            dbulk = _number_or_none(material_dbulk)
        params_map["dbulk"] = dbulk if dbulk is not None else 1e-3
    elif kind == "uniaxial_anisotropy":
        ku1 = _number_or_none(params_map.get("ku1"))
        params_map["ku1"] = ku1 if ku1 is not None else 0.0
        params_map["axis"] = _normalize_axis3(params_map.get("axis"))
    return {
        "kind": kind,
        "enabled": bool(raw.get("enabled", True)),
        "params": params_map,
    }


def _ensure_physics_stack(
    raw: object,
    *,
    material_dind: object = None,
    material_dbulk: object = None,
) -> list[dict[str, object]]:
    by_kind: dict[str, dict[str, object]] = {}
    if isinstance(raw, list):
        for entry in raw:
            normalized = _normalize_interaction_entry(
                entry,
                material_dind=material_dind,
                material_dbulk=material_dbulk,
            )
            if normalized is not None:
                by_kind[str(normalized["kind"])] = normalized
    for required in ("exchange", "demag"):
        if required not in by_kind:
            by_kind[required] = {"kind": required, "enabled": True, "params": None}
    material_dind_value = _number_or_none(material_dind)
    material_dbulk_value = _number_or_none(material_dbulk)
    if material_dind_value not in (None, 0.0) and "interfacial_dmi" not in by_kind:
        by_kind["interfacial_dmi"] = _normalize_interaction_entry(
            {"kind": "interfacial_dmi", "enabled": True, "params": None},
            material_dind=material_dind,
            material_dbulk=None,
        ) or {"kind": "interfacial_dmi", "enabled": True, "params": {"dind": 1e-3}}
    if material_dbulk_value not in (None, 0.0) and "bulk_dmi" not in by_kind:
        by_kind["bulk_dmi"] = _normalize_interaction_entry(
            {"kind": "bulk_dmi", "enabled": True, "params": None},
            material_dind=None,
            material_dbulk=material_dbulk,
        ) or {"kind": "bulk_dmi", "enabled": True, "params": {"dbulk": 1e-3}}
    ordered: list[dict[str, object]] = []
    for kind in _INTERACTION_ORDER:
        entry = by_kind.get(kind)
        if entry is not None:
            ordered.append(entry)
    return ordered


def build_scene_document_from_builder(builder: dict[str, Any]) -> dict[str, Any]:
    geometries = builder.get("geometries") or []
    objects: list[dict[str, Any]] = []
    materials: list[dict[str, Any]] = []
    magnetization_assets: list[dict[str, Any]] = []

    for geometry in geometries:
        name = str(geometry.get("name", "object"))
        object_id = str(geometry.get("object_id") or name)
        geometry_params = dict(geometry.get("geometry_params") or {})
        translation = geometry_params.pop("translation", geometry_params.pop("translate", [0, 0, 0]))
        role = str(geometry.get("role") or "magnet")
        is_auxiliary = role != "magnet"
        magnetization = dict(geometry.get("magnetization") or {})
        mag_kind = str(magnetization.get("kind", "uniform"))
        if mag_kind == "file" and (
            magnetization.get("dataset") is not None or magnetization.get("sample_index") is not None
        ):
            mag_kind = "sampled"

        material_properties = dict(geometry.get("material") or {})
        object_regions = list(geometry.get("object_regions") or [])
        allocated_region_ids = list(geometry.get("allocated_region_ids") or [])
        for region in object_regions:
            if isinstance(region, dict):
                region_id = region.get("region_id") or region.get("id")
                if isinstance(region_id, str) and region_id not in allocated_region_ids:
                    allocated_region_ids.append(region_id)
        physics_stack = _ensure_physics_stack(
            geometry.get("physics_stack"),
            material_dind=material_properties.get("Dind"),
            material_dbulk=material_properties.get("Dbulk"),
        )

        objects.append(
            {
                "id": object_id,
                "name": name,
                "role": role,
                "geometry": {
                    "geometry_kind": str(geometry.get("geometry_kind", "")),
                    "geometry_params": geometry_params,
                    "bounds_min": geometry.get("bounds_min"),
                    "bounds_max": geometry.get("bounds_max"),
                },
                "transform": {
                    "translation": translation if isinstance(translation, list) else [0, 0, 0],
                    "rotation_quat": _identity_quat(),
                    "scale": _one_vec3(),
                    "pivot": _zero_vec3(),
                },
                "material_ref": "" if is_auxiliary else _material_id(name),
                "region_name": geometry.get("region_name"),
                "magnetization_ref": None if is_auxiliary else _magnetization_id(name),
                "physics_stack": [] if is_auxiliary else physics_stack,
                "object_mesh": geometry.get("mesh"),
                "mesh_override": geometry.get("mesh"),
                "regions": object_regions,
                "allocated_region_ids": allocated_region_ids,
                "material_parameter_fields": geometry.get("material_parameter_fields") or [],
                "visualization_hint": geometry.get("visualization_hint") or {},
                "visible": True,
                "locked": False,
                "tags": [f"role:{role}"] if is_auxiliary else [],
            }
        )
        if is_auxiliary:
            continue
        materials.append(
            {
                "id": _material_id(name),
                "name": f"{name} material",
                "properties": material_properties,
            }
        )
        magnetization_assets.append(
            {
                "id": _magnetization_id(name),
                "name": f"{name} magnetization",
                "kind": mag_kind,
                "value": magnetization.get("value"),
                "seed": magnetization.get("seed"),
                "source_path": magnetization.get("source_path"),
                "source_format": magnetization.get("source_format"),
                "dataset": magnetization.get("dataset"),
                "sample_index": magnetization.get("sample_index"),
                "mapping": dict(magnetization.get("mapping") or _default_mapping()),
                "texture_transform": dict(
                    magnetization.get("texture_transform") or _default_texture_transform()
                ),
                "preset_kind": magnetization.get("preset_kind"),
                "preset_params": magnetization.get("preset_params"),
                "preset_version": magnetization.get("preset_version"),
                "ui_label": magnetization.get("ui_label"),
            }
        )

    raw_current_modules = builder.get("current_modules") or []
    if not isinstance(raw_current_modules, list):
        raise ValueError("current_modules must be a list")
    current_transport_entries: list[object] = []
    legacy_current_modules: list[object] = []
    for module in raw_current_modules:
        if isinstance(module, Mapping) and module.get("kind") == "current_transport":
            current_transport_entries.append(module)
        else:
            legacy_current_modules.append(copy.deepcopy(module))

    requested_backend = str(
        builder.get("requested_backend") or builder.get("backend") or "auto"
    )
    requested_device = str(builder.get("requested_device") or "auto")
    requested_precision = str(
        builder.get("requested_precision")
        or builder.get("execution_precision")
        or "double"
    )

    document = {
        "version": "scene.v2",
        "revision": int(builder.get("revision", 0)),
        "scene": {
            "id": "scene",
            "name": "Scene",
            "source_of_truth": "repo_head",
            "authoring_schema": "mesh-first-fem.v1",
        },
        "universe": builder.get("universe"),
        "objects": objects,
        "materials": materials,
        "magnetization_assets": magnetization_assets,
        "current_modules": {
            "modules": legacy_current_modules,
            "excitation_analysis": builder.get("excitation_analysis"),
        },
        "current_transports": _canonical_current_transports(current_transport_entries),
        "couplings": builder.get("couplings") or [],
        "field_drives": {"drives": copy.deepcopy(builder.get("field_drives") or [])},
        "monitors": {"planar": copy.deepcopy(builder.get("planar_monitors") or [])},
        "study": {
            "backend": builder.get("backend"),
            "requested_backend": requested_backend,
            "requested_device": requested_device,
            "requested_precision": requested_precision,
            "requested_mode": builder.get("requested_mode", "strict"),
            "requested_cpu_threads": builder.get("cpu_threads"),
            "fem_demag_solver_policy": builder.get("fem_demag_solver_policy"),
            "exchange_enabled": bool(builder.get("exchange_enabled", True)),
            "demag_enabled": bool(builder.get("demag_enabled", True)),
            "demag_realization": builder.get("demag_realization"),
            "external_field": builder.get("external_field"),
            "solver": builder.get("solver") or {},
            "universe_mesh": builder.get("universe"),
            "shared_domain_mesh": builder.get("mesh") or {},
            "mesh_defaults": builder.get("mesh") or {},
            "stages": [
                _canonical_scene_stage(stage)
                for stage in (builder.get("stages") or [])
            ],
            "study_pipeline": builder.get("study_pipeline"),
            "table_autosave": builder.get("table_autosave"),
            "initial_state": builder.get("initial_state"),
        },
        "outputs": {"items": []},
        "editor": {
            "selected_object_id": None,
            "gizmo_mode": None,
            "transform_space": None,
            "selected_entity_id": None,
            "focused_entity_id": None,
            "object_view_mode": "context",
            "air_mesh_visible": True,
            "air_mesh_opacity": 28.0,
            "mesh_entity_view_state": {},
            "active_transform_scope": None,
        },
    }
    if "fdm" in builder:
        document["study"]["fdm"] = copy.deepcopy(builder.get("fdm"))
    if "spin_torques" in builder:
        document["spin_torques"] = _canonical_spin_torques(
            builder["spin_torques"], scene_ids=True
        )
    if "spin_transports" in builder:
        document["spin_transports"] = _canonical_spin_transports(
            builder["spin_transports"], scene_ids=True
        )
    if "oersted_terms" in builder:
        document["oersted_fields"] = _canonical_oersted_fields(
            builder["oersted_terms"], scene_ids=True
        )
    return document


def build_builder_from_scene_document(scene: dict[str, Any]) -> dict[str, Any]:
    materials = {
        str(material.get("id", "")): dict(material.get("properties") or {})
        for material in (scene.get("materials") or [])
    }
    magnetization_assets = {
        str(asset.get("id", "")): dict(asset)
        for asset in (scene.get("magnetization_assets") or [])
    }
    geometries: list[dict[str, Any]] = []

    for obj in scene.get("objects") or []:
        role = str(obj.get("role") or "magnet")
        is_auxiliary = role != "magnet"
        material_ref = str(obj.get("material_ref") or "")
        if not is_auxiliary and (not material_ref or material_ref not in materials):
            raise ValueError(
                f"object '{obj.get('id') or obj.get('name') or ''}' references missing material '{material_ref}'"
            )
        magnetization_ref = str(obj.get("magnetization_ref") or "")
        if not is_auxiliary and (
            not magnetization_ref or magnetization_ref not in magnetization_assets
        ):
            raise ValueError(
                f"object '{obj.get('id') or obj.get('name') or ''}' references missing magnetization asset '{magnetization_ref}'"
            )
        geometry = dict(obj.get("geometry") or {})
        geometry_params = dict(geometry.get("geometry_params") or {})
        transform = dict(obj.get("transform") or {})
        translation = transform.get("translation")
        if isinstance(translation, list) and len(translation) == 3:
            if any(abs(float(value)) > 0 for value in translation):
                geometry_params["translation"] = [float(value) for value in translation]

        magnetization_asset = magnetization_assets.get(magnetization_ref, {})
        magnetization = {
            "kind": str(magnetization_asset.get("kind", "uniform")),
            "value": magnetization_asset.get("value"),
            "seed": magnetization_asset.get("seed"),
            "source_path": magnetization_asset.get("source_path"),
            "source_format": magnetization_asset.get("source_format"),
            "dataset": magnetization_asset.get("dataset"),
            "sample_index": magnetization_asset.get("sample_index"),
            "mapping": dict(magnetization_asset.get("mapping") or _default_mapping()),
            "texture_transform": dict(
                magnetization_asset.get("texture_transform") or _default_texture_transform()
            ),
            "preset_kind": magnetization_asset.get("preset_kind"),
            "preset_params": magnetization_asset.get("preset_params"),
            "preset_version": magnetization_asset.get("preset_version"),
            "ui_label": magnetization_asset.get("ui_label"),
        }
        material_properties = materials.get(material_ref, {})
        physics_stack = _ensure_physics_stack(
            obj.get("physics_stack"),
            material_dind=material_properties.get("Dind"),
            material_dbulk=material_properties.get("Dbulk"),
        )

        entry: dict[str, Any] = {
            "object_id": str(obj.get("id") or obj.get("name") or ""),
            "name": str(obj.get("name") or obj.get("id") or ""),
            "role": role,
            "region_name": obj.get("region_name"),
            "geometry_kind": str(geometry.get("geometry_kind", "")),
            "geometry_params": geometry_params,
            "bounds_min": geometry.get("bounds_min"),
            "bounds_max": geometry.get("bounds_max"),
            "mesh": obj.get("object_mesh", obj.get("mesh_override")),
            "object_regions": obj.get("regions") or [],
            "allocated_region_ids": obj.get("allocated_region_ids") or [],
            "material_parameter_fields": obj.get("material_parameter_fields") or [],
            "visualization_hint": obj.get("visualization_hint") or {},
        }
        if not is_auxiliary:
            entry["material"] = material_properties
            entry["magnetization"] = magnetization
            entry["physics_stack"] = physics_stack
        geometries.append(entry)

    study = dict(scene.get("study") or {})
    current_modules = dict(scene.get("current_modules") or {})
    legacy_modules = current_modules.get("modules") or []
    if not isinstance(legacy_modules, list):
        raise ValueError("current_modules.modules must be a list")
    migrated_transports = [
        module
        for module in legacy_modules
        if isinstance(module, Mapping) and module.get("kind") == "current_transport"
    ]
    antenna_modules = [
        copy.deepcopy(module)
        for module in legacy_modules
        if not (isinstance(module, Mapping) and module.get("kind") == "current_transport")
    ]
    if "current_transports" in scene:
        transports = _canonical_current_transports(scene["current_transports"])
        if migrated_transports:
            transports.extend(_canonical_current_transports(migrated_transports))
    else:
        transports = _canonical_current_transports(migrated_transports)
    transport_names = [str(entry["name"]) for entry in transports]
    if len(transport_names) != len(set(transport_names)):
        raise ValueError("current_transports contains duplicate names")
    builder = {
        "revision": int(scene.get("revision", 0)),
        "backend": study.get("backend") or study.get("requested_backend"),
        "requested_backend": study.get("requested_backend", "auto"),
        "requested_device": study.get("requested_device", "auto"),
        "requested_precision": study.get("requested_precision", "double"),
        "requested_mode": study.get("requested_mode", "strict"),
        "cpu_threads": study.get("requested_cpu_threads"),
        "fem_demag_solver_policy": study.get("fem_demag_solver_policy"),
        "exchange_enabled": bool(study.get("exchange_enabled", True)),
        "demag_enabled": bool(study.get("demag_enabled", True)),
        "demag_realization": study.get("demag_realization"),
        "external_field": study.get("external_field"),
        "solver": study.get("solver") or {},
        "mesh": study.get("shared_domain_mesh") or study.get("mesh_defaults") or {},
        "universe": study.get("universe_mesh") or scene.get("universe"),
        "stages": study.get("stages") or [],
        "study_pipeline": study.get("study_pipeline"),
        "table_autosave": study.get("table_autosave"),
        "initial_state": study.get("initial_state"),
        "geometries": geometries,
        "couplings": scene.get("couplings") or [],
        "current_modules": [*antenna_modules, *transports],
        "excitation_analysis": current_modules.get("excitation_analysis"),
    }
    if "fdm" in study:
        builder["fdm"] = copy.deepcopy(study.get("fdm"))
    field_drives = scene.get("field_drives")
    if isinstance(field_drives, Mapping):
        drives = field_drives.get("drives")
        if isinstance(drives, list):
            builder["field_drives"] = copy.deepcopy(drives)
    monitors = scene.get("monitors")
    if isinstance(monitors, Mapping):
        planar = monitors.get("planar")
        if isinstance(planar, list):
            builder["planar_monitors"] = copy.deepcopy(planar)
    if "spin_torques" in scene:
        builder["spin_torques"] = _canonical_spin_torques(
            scene["spin_torques"], scene_ids=False
        )
    if "spin_transports" in scene:
        builder["spin_transports"] = _canonical_spin_transports(
            scene["spin_transports"], scene_ids=False
        )
    if "oersted_fields" in scene:
        builder["oersted_terms"] = _canonical_oersted_fields(
            scene["oersted_fields"], scene_ids=False
        )
    elif "oersted_terms" in scene:
        builder["oersted_terms"] = _canonical_oersted_fields(
            scene["oersted_terms"], scene_ids=False
        )
    return builder


def builder_overrides_from_scene_document(scene: dict[str, Any]) -> dict[str, Any]:
    builder = build_builder_from_scene_document(scene)
    solver = dict(builder.get("solver") or {})
    advanced_adaptive = solver.get("adaptive_timestep")
    advanced_adaptive_override = None
    if isinstance(advanced_adaptive, dict):
        advanced_adaptive_override = {
            key: _number_or_none(advanced_adaptive.get(key))
            for key in (
                "atol",
                "rtol",
                "dt_initial",
                "dt_min",
                "dt_max",
                "safety",
                "growth_limit",
                "shrink_limit",
                "max_spin_rotation",
                "norm_tolerance",
            )
            if key in advanced_adaptive
        }
    solver_override: dict[str, Any] = {}
    if "integrator" in solver:
        solver_override["integrator"] = solver.get("integrator") or None
    for key in ("fixed_timestep", "dt_initial", "dt_min", "dt_max", "max_err"):
        if key not in solver:
            continue
        raw_value = solver.get(key)
        # The Rust builder adapter serializes unset text fields as empty strings;
        # those are absence, while an explicit JSON null remains a deliberate
        # clear request and must stay visible to the override validator.
        if isinstance(raw_value, str) and not raw_value.strip():
            continue
        solver_override[key] = _number_or_none(raw_value)
    if "adaptive_timestep" in solver:
        solver_override["adaptive_timestep"] = advanced_adaptive_override
    solver_override["relax"] = {
        "algorithm": solver.get("relax_algorithm") or None,
        "torque_tolerance": _number_or_none(solver.get("torque_tolerance")),
        "energy_tolerance": _number_or_none(solver.get("energy_tolerance")),
        "max_steps": _int_or_none(solver.get("max_relax_steps")),
    }
    mesh = dict(builder.get("mesh") or {})
    overrides = {
        "runtime_selection": {
            "cpu_threads": _int_or_none(builder.get("cpu_threads")),
            "device": builder.get("requested_device", "auto"),
            "precision": builder.get("requested_precision", "double"),
        },
        "fem_demag_solver_policy": (
            dict(builder.get("fem_demag_solver_policy"))
            if isinstance(builder.get("fem_demag_solver_policy"), dict)
            else None
        ),
        "exchange_enabled": bool(builder.get("exchange_enabled", True)),
        "demag_enabled": bool(builder.get("demag_enabled", True)),
        "demag_realization": builder.get("demag_realization"),
        "external_field": (
            [float(value) for value in builder.get("external_field")]
            if isinstance(builder.get("external_field"), list)
            and len(builder.get("external_field")) == 3
            else None
        ),
        "solver": solver_override,
        "mesh": {
            "algorithm_2d": mesh.get("algorithm_2d"),
            "algorithm_3d": mesh.get("algorithm_3d"),
            "hmax": _number_or_auto(mesh.get("maximum_element_size") or mesh.get("hmax")),
            "hmin": _number_or_none(mesh.get("minimum_element_size") or mesh.get("hmin")),
            "maximum_element_size": _number_or_auto(mesh.get("maximum_element_size") or mesh.get("hmax")),
            "minimum_element_size": _number_or_none(mesh.get("minimum_element_size") or mesh.get("hmin")),
            "order": _int_or_none(mesh.get("order")),
            "calibrate_for": mesh.get("calibrate_for") or None,
            "size_preset": mesh.get("size_preset") or None,
            "size_factor": mesh.get("size_factor"),
            "size_from_curvature": mesh.get("size_from_curvature"),
            "curvature_factor": _number_or_none(mesh.get("curvature_factor")),
            "growth_rate": _number_or_none(
                mesh.get("maximum_element_growth_rate") or mesh.get("growth_rate")
            ),
            "maximum_element_growth_rate": _number_or_none(
                mesh.get("maximum_element_growth_rate") or mesh.get("growth_rate")
            ),
            "narrow_regions": mesh.get("narrow_regions"),
            "narrow_region_resolution": _number_or_none(mesh.get("narrow_region_resolution")),
            "resolved_size_from_curvature": _int_or_none(mesh.get("resolved_size_from_curvature")),
            "resolved_narrow_regions": _int_or_none(mesh.get("resolved_narrow_regions")),
            "resolved_growth_rate": _number_or_none(mesh.get("resolved_growth_rate")),
            "smoothing_steps": mesh.get("smoothing_steps"),
            "optimize": mesh.get("optimize") or None,
            "optimize_iterations": mesh.get("optimize_iterations"),
            "compute_quality": mesh.get("compute_quality"),
            "per_element_quality": mesh.get("per_element_quality"),
            "adaptive_mesh": None
            if not mesh.get("adaptive_enabled")
            else {
                "enabled": True,
                "policy": mesh.get("adaptive_policy"),
                "indicator": mesh.get("adaptive_indicator"),
                "target_quantity": mesh.get("adaptive_target_quantity"),
                "convergence_metric": mesh.get("adaptive_convergence_metric"),
                "theta": mesh.get("adaptive_theta"),
                "h_min": _number_or_none(mesh.get("adaptive_h_min")),
                "h_max": _number_or_none(mesh.get("adaptive_h_max")),
                "max_passes": mesh.get("adaptive_max_passes"),
                "error_tolerance": _number_or_none(mesh.get("adaptive_error_tolerance")),
            },
        },
        "universe": builder.get("universe"),
        "stages": [
            {
                "kind": stage.get("kind"),
                "entrypoint_kind": stage.get("entrypoint_kind"),
                "integrator": stage.get("integrator") or None,
                "fixed_timestep": _number_or_none(stage.get("fixed_timestep")),
                **(
                    {
                        "adaptive_timestep": _stage_adaptive_timestep_override(
                            stage.get("adaptive_timestep")
                        )
                    }
                    if "adaptive_timestep" in stage
                    else {}
                ),
                "until_seconds": _number_or_none(stage.get("until_seconds")),
                "relax_algorithm": _stage_relax_algorithm(stage) or None,
                "torque_tolerance": _number_or_none(stage.get("torque_tolerance")),
                "energy_tolerance": _number_or_none(stage.get("energy_tolerance")),
                "max_steps": _int_or_none(stage.get("max_steps")),
                "eigen_count": _int_or_none(stage.get("eigen_count")),
                "eigen_target": stage.get("eigen_target") or None,
                "eigen_operator": stage.get("eigen_operator") or None,
                "eigen_include_demag": (
                    bool(stage.get("eigen_include_demag"))
                    if isinstance(stage.get("eigen_include_demag"), bool)
                    else None
                ),
                "eigen_equilibrium_source": stage.get("eigen_equilibrium_source") or None,
                "eigen_normalization": stage.get("eigen_normalization") or None,
                "eigen_target_frequency": _number_or_none(stage.get("eigen_target_frequency")),
                "eigen_frequency_min": _number_or_none(stage.get("eigen_frequency_min")),
                "eigen_frequency_max": _number_or_none(stage.get("eigen_frequency_max")),
                "eigen_damping_policy": stage.get("eigen_damping_policy") or None,
                "eigen_k_vector": stage.get("eigen_k_vector") or None,
                "eigen_k_path": stage.get("eigen_k_path") or None,
                "eigen_spin_wave_bc": stage.get("eigen_spin_wave_bc") or None,
                "eigen_spin_wave_bc_config": (
                    dict(stage.get("eigen_spin_wave_bc_config"))
                    if isinstance(stage.get("eigen_spin_wave_bc_config"), dict)
                    else None
                ),
                "eigen_magnetostatic_bc": stage.get("eigen_magnetostatic_bc") or None,
            }
            for stage in (builder.get("stages") or [])
        ],
        "study_pipeline": builder.get("study_pipeline"),
        "table_autosave": builder.get("table_autosave"),
        "initial_state": builder.get("initial_state"),
        "geometries": builder.get("geometries") or [],
        "couplings": builder.get("couplings") or [],
        "planar_monitors": builder.get("planar_monitors") or [],
        "current_modules": builder.get("current_modules") or [],
        "excitation_analysis": builder.get("excitation_analysis"),
    }
    _copy_present_collection(builder, overrides, "spin_torques")
    _copy_present_collection(builder, overrides, "spin_transports")
    _copy_present_collection(builder, overrides, "oersted_terms")
    if "fdm" in builder:
        fdm = copy.deepcopy(builder.get("fdm"))
        if isinstance(fdm, dict):
            aliases: dict[str, str] = {}
            for geometry in builder.get("geometries") or []:
                if not isinstance(geometry, dict):
                    continue
                name = geometry.get("name") or geometry.get("object_id") or geometry.get("id")
                if name is None:
                    continue
                for alias in (
                    geometry.get("object_id"),
                    geometry.get("id"),
                    geometry.get("region_name"),
                ):
                    if alias is not None:
                        aliases[str(alias)] = str(name)
            for grid_key in ("per_magnet", "per_object_grid"):
                raw_grid = fdm.get(grid_key)
                if isinstance(raw_grid, dict):
                    fdm[grid_key] = {
                        aliases.get(str(key), str(key)): value
                        for key, value in raw_grid.items()
                    }
        overrides["fdm"] = fdm
    return overrides


def _stage_adaptive_timestep_override(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    override = {
        key: _number_or_none(value.get(key))
        for key in (
            "atol",
            "rtol",
            "dt_initial",
            "dt_min",
            "dt_max",
            "safety",
            "growth_limit",
            "shrink_limit",
            "max_spin_rotation",
            "norm_tolerance",
        )
        if key in value
    }
    if "tolerance_mode" in value:
        override["tolerance_mode"] = value.get("tolerance_mode")
    return override


def _number_or_none(value: Any) -> float | str | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        if stripped.lower() == "auto":
            return "auto"
        try:
            return float(stripped)
        except ValueError:
            return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _number_or_auto(value: Any) -> float | str | None:
    return _number_or_none(value)


def _int_or_none(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return int(stripped)
        except ValueError:
            return None
    if isinstance(value, (int, float)):
        return int(value)
    return None
