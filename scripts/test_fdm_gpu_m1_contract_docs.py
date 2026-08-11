from __future__ import annotations

import hashlib
import json
import re
import struct
import sys
import unicodedata
import unittest
from pathlib import Path

from markdown_it import MarkdownIt


ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "docs/physics/0970-spin-hall-drift-diffusion-transport.md"
SOURCE_MAP = ROOT / "docs/physics/0970-spin-hall-drift-diffusion-transport.source-map.json"
TOPOLOGICAL_PAGE = ROOT / "docs/physics/0940-topological-charge-observable.md"
TOPOLOGICAL_SOURCE_MAP = ROOT / "docs/physics/0940-topological-charge-observable.source-map.json"
RACETRACK_FIXTURE = (
    ROOT / "tests/standard_problems/transport/racetrack_m1_v1/fixture.v1.json"
)
RACETRACK_README = ROOT / "tests/standard_problems/transport/racetrack_m1_v1/README.md"
RUNTIME = ROOT / "docs/specs/spin-transport-runtime-contract-v1.md"
MASTERPLAN = ROOT / "docs/architecture/backend-golden-masterplan.md"
CAPABILITY_MD = ROOT / "docs/specs/capability-matrix-v0.md"
CAPABILITY_JSON = ROOT / "docs/specs/capability-matrix-v0.json"
PLAN = (
    ROOT
    / "docs/raports/2026-07-15_audyt-stt-sot-she-fem-fdm"
    / "PLAN_WDROZENIA_I_SPECYFIKACJA_FIZYKI.md"
)
RACETRACK_PLAN = (
    ROOT / "docs/superpowers/plans/2026-08-11-solved-current-skyrmion-racetrack.md"
)


def _normalise(value: str) -> str:
    return " ".join(value.replace("`", "").split())


def _gpu_section(page: str) -> str:
    start = page.index("(fdm-gpu-m1-fp64-contract)=")
    end = page.index("\n### 3.2 FEM/MFEM weak-form contract", start)
    return page[start:end]


def _anchored_section(document: str, start: str, end: str) -> str:
    section_start = document.index(start)
    section_end = document.index(end, section_start)
    return document[section_start:section_end]


def _resolve_problem_ir_path(problem_ir: object, path: str) -> object:
    value = problem_ir
    for segment in path.split("."):
        match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)(.*)", segment)
        if match is None:
            raise AssertionError(f"invalid ProblemIR path segment: {segment!r}")
        field, indexes = match.groups()
        if not isinstance(value, dict) or field not in value:
            raise AssertionError(f"ProblemIR path {path!r} cannot resolve field {field!r}")
        value = value[field]
        offset = 0
        for index_match in re.finditer(r"\[(\d+)\]", indexes):
            if index_match.start() != offset:
                raise AssertionError(
                    f"ProblemIR path {path!r} uses a non-numeric or malformed selector"
                )
            if not isinstance(value, list):
                raise AssertionError(
                    f"ProblemIR path {path!r} indexes a non-array value"
                )
            value = value[int(index_match.group(1))]
            offset = index_match.end()
        if offset != len(indexes):
            raise AssertionError(
                f"ProblemIR path {path!r} uses a non-numeric or malformed selector"
            )
    return value


def _racetrack_public_lowering() -> dict[str, object]:
    python_src = ROOT / "packages/fullmag-py/src"
    if str(python_src) not in sys.path:
        sys.path.insert(0, str(python_src))

    import fullmag as fm

    fixture = json.loads(RACETRACK_FIXTURE.read_text(encoding="utf-8"))
    hm_geometry = fm.Translate(
        fm.Box(size=(512.0e-9, 128.0e-9, 3.0e-9), name="hm_base"),
        offset=(256.0e-9, 64.0e-9, 1.5e-9),
        name="hm",
    )
    fm_geometry = fm.Translate(
        fm.Box(size=(512.0e-9, 128.0e-9, 1.0e-9), name="fm_base"),
        offset=(256.0e-9, 64.0e-9, 3.5e-9),
        name="fm",
    )
    hm = fm.RegionRef("hm")
    ferromagnet = fm.RegionRef("fm")

    def surface(value: dict[str, object]) -> object:
        return fm.SurfaceRef(
            value["object_id"],
            value["surface_id"],
            value["orientation"],
        )

    charge_boundaries = {
        boundary["id"]: boundary
        for boundary in fixture["charge_boundary_contract"]["boundaries"]
    }
    current_transport = fm.CurrentTransport(
        name="charge",
        model="ohmic_poisson",
        coupling="one_way",
        domain=(hm, ferromagnet),
        materials=(
            fm.ChargeTransportMaterialAssignment(
                hm, fm.ChargeTransportMaterial(sigma_Spm=5.0e6)
            ),
            fm.ChargeTransportMaterialAssignment(
                ferromagnet, fm.ChargeTransportMaterial(sigma_Spm=1.0e6)
            ),
        ),
        boundaries=(
            fm.NormalCurrentElectrode(
                "terminal_x_minus",
                tuple(surface(value) for value in charge_boundaries["terminal_x_minus"]["surfaces"]),
                outward_current_density_Apm2=0.0,
            ),
            fm.NormalCurrentElectrode(
                "terminal_x_plus",
                tuple(surface(value) for value in charge_boundaries["terminal_x_plus"]["surfaces"]),
                outward_current_density_Apm2=0.0,
            ),
            fm.ChargeInsulating(
                "insulating_outer",
                tuple(surface(value) for value in charge_boundaries["insulating_outer"]["surfaces"]),
            ),
        ),
        gauge=fm.ChargePotentialGauge("zero_mean"),
        solver=fm.ChargeSolverPolicy(),
    )

    interface = fixture["interface_contract"]
    spin_boundary = fixture["spin_boundary_contract"]
    spin_transport = fm.SpinDriftDiffusion(
        id="spin",
        current_source_id="charge",
        mode="steady",
        domain=(hm, ferromagnet),
        materials=(
            fm.SpinTransportMaterialAssignment(
                hm,
                fm.SpinTransportMaterial(
                    sigma_s_Spm=5.0e6,
                    polarization_p=0.0,
                    theta_sh=0.2,
                    lambda_sf_m=1.5e-9,
                ),
            ),
            fm.SpinTransportMaterialAssignment(
                ferromagnet,
                fm.SpinTransportMaterial(
                    sigma_s_Spm=1.0e6,
                    polarization_p=0.4,
                    theta_sh=0.0,
                    lambda_sf_m=5.0e-9,
                    lambda_j_m=1.0e-9,
                    lambda_phi_m=1.0e-9,
                ),
            ),
        ),
        interfaces=(
            fm.MixingConductanceSpinInterface(
                id="hm_fm",
                normal_to_ferromagnet=interface["normal_to_ferromagnet"],
                normal_side=hm,
                ferromagnet_side=ferromagnet,
                g_up_Spm2=2.5e14,
                g_down_Spm2=2.5e14,
                g_r_Spm2=5.0e14,
                g_i_Spm2=5.0e13,
            ),
        ),
        boundaries=(
            fm.SpinInsulating(
                spin_boundary["id"],
                tuple(surface(value) for value in spin_boundary["surfaces"]),
            ),
        ),
        solver=fm.SpinSolverPolicy(),
        requested_execution=fm.TransportExecution(
            discretization="fdm",
            device="gpu",
            precision="double",
            execution_mode="strict",
        ),
    )

    runtime = fm.RuntimeSelection(
        backend_target=fm.BackendTarget.FDM,
        device_target=fm.DeviceTarget.GPU,
        gpu_count=1,
        device_index=0,
        execution_mode=fm.ExecutionMode.STRICT,
        execution_precision=fm.ExecutionPrecision.DOUBLE,
    )
    discretization = fm.DiscretizationHints(
        fdm=fm.FDM(cell=(2.0e-9, 2.0e-9, 1.0e-9))
    )
    material = fm.Material(
        name="fm_material",
        Ms=580.0e3,
        A=15.0e-12,
        alpha=0.3,
        Ku1=0.8e6,
        anisU=(0.0, 0.0, 1.0),
    )
    problem = fm.Problem(
        name="racetrack_m1_v1_base_drive",
        magnets=(
            fm.Ferromagnet(
                name="fm",
                geometry=fm_geometry,
                material=material,
            ),
        ),
        auxiliary_geometries=(hm_geometry,),
        energy=(
            fm.Exchange(),
            fm.Demag(),
            fm.InterfacialDMI(
                D=3.0e-3, interface_normal=(0.0, 0.0, 1.0)
            ),
        ),
        study=fm.TimeEvolution(
            dynamics=fm.LLG(integrator="rk4", fixed_timestep=1.0e-13),
            outputs=(fm.SaveField("m", every=5.0e-12),),
        ),
        runtime=runtime,
        discretization=discretization,
        current_modules=(current_transport,),
        spin_transports=(spin_transport,),
        spin_torques=(
            fm.DriftDiffusionSpinTorque(
                id="transport_torque", solve_id="spin", target=ferromagnet
            ),
        ),
    )
    lowered = problem.to_ir(include_geometry_assets=False, entrypoint_kind="flat_run")
    lowered["problem_meta"]["runtime_metadata"] = {
        "runtime_selection": runtime.to_runtime_metadata()
    }
    typed_problem_ir_keys = (
        "ir_version",
        "problem_meta",
        "geometry",
        "regions",
        "materials",
        "magnets",
        "energy_terms",
        "study",
        "backend_policy",
        "validation_profile",
        "current_modules",
        "spin_transport_modules",
        "spin_torque_modules",
    )
    return {key: lowered[key] for key in typed_problem_ir_keys}


REQUIRED_QUALIFICATION_GATES = {
    "layout_abi_v1",
    "charge_uniform_v1",
    "charge_layered_v1",
    "density_face_bc_v1",
    "component_gauge_v1",
    "charge_snapshot_v1",
    "spin_diffusion_v1",
    "direct_she_six_signs_v1",
    "face_current_e_v1",
    "upwind_three_way_v1",
    "mixing_interface_v2",
    "torque_balance_v1",
    "strict_residency_v1",
    "determinism_restart_v1",
    "public_path_v1",
    "convergence_v1",
    "performance_v1",
}


ABI_RECORD_LAYOUTS = {
    "buffer_view_v1": (80, 0x00, "32:address:u64;40:element_count:u64;48:byte_stride:u64;56:byte_length:u64;64:element_type:u32;68:pointer_space:u32;72:component_order:u32;76:reserved0:u32"),
    "context_create_request_v1": (104, 0x7F, "32:device_uuid:u8[16];48:device_ordinal:i32;52:precision:u32;56:strict_residency:u32;60:deterministic:u32;64:allocator_limit:u64;72:workspace_limit:u64;80:stream_policy:u32;84:reserved0:u32;88:requested_device_features:u64;96:reserved1:u64"),
    "context_create_result_v1": (136, 0x7F, "32:context_handle:handle32;64:device_uuid:u8[16];80:compute_major:u32;84:compute_minor:u32;88:cuda_runtime:u32;92:cuda_driver:u32;96:build_digest:u8[32];128:supported_features:u64"),
    "static_descriptor_v1": (184, 0x1C, "32:grid:u64[3];56:cell_size:f64[3];80:descriptor_revision:u64;88:source_revision:u64;96:descriptor_digest:u8[32];128:masks_view_ptr:u64;136:materials_view_ptr:u64;144:interfaces_view_ptr:u64;152:charge_faces_view_ptr:u64;160:spin_faces_view_ptr:u64;168:formula_ids_view_ptr:u64;176:reserved0:u64"),
    "charge_solve_request_v1": (120, 0x07, "32:context_handle:handle32;64:solver_policy:u32;68:gauge_policy:u32;72:attempt_id:u64;80:stage_id:u64;88:source_revision:u64;96:static_revision:u64;104:relative_tolerance:f64;112:max_iterations:u64"),
    "charge_solve_result_v1": (144, 0x07, "32:provisional_generation:u64;40:iterations:u64;48:reason:u32;52:reserved0:u32;56:algebraic_residual:f64;64:physical_residual:f64;72:component_balance:f64;80:electrode_balance:f64;88:transfer_count:u64;96:transfer_bytes:u64;104:peak_bytes:u64;112:candidate_digest:u8[32]"),
    "charge_snapshot_info_v1": (216, 0x27, "32:snapshot_handle:handle32;64:context_handle:handle32;96:snapshot_lineage_id:u8[16];112:accepted_sequence:u64;120:local_generation:u64;128:source_revision:u64;136:operator_revision:u64;144:snapshot_content_digest:u8[32];176:convergence_digest:u8[32];208:device_bytes:u64"),
    "steady_spin_solve_request_v1": (176, 0x1F, "32:context_handle:handle32;64:snapshot_handle:handle32;96:accepted_sequence:u64;104:m_stage_view_ptr:u64;112:torque_view_ptr:u64;120:solver_policy:u32;124:reserved0:u32;128:attempt_id:u64;136:stage_id:u64;144:source_revision:u64;152:operator_revision:u64;160:relative_tolerance:f64;168:max_iterations:u64"),
    "steady_spin_solve_result_v1": (176, 0x1F, "32:iterations:u64;40:reason:u32;44:reserved0:u32;48:algebraic_residual:f64;56:local_balance:f64;64:global_balance:f64;72:interface_balance:f64;80:torque_balance:f64;88:transfer_count:u64;96:transfer_bytes:u64;104:peak_bytes:u64;112:snapshot_content_digest:u8[32];144:deterministic_compute_digest:u8[32]"),
    "transport_telemetry_v1": (176, 0x7F, "32:audit_sequence:u64;40:direction:u32;44:reason:u32;48:status:u32;52:event_flags:u32;56:bytes:u64;64:count:u64;72:attempt_id:u64;80:stage_id:u64;88:iteration:u64;96:stream_id:u64;104:event_id:u64;112:operation_audit_digest:u8[32];144:scientific_continuation_digest:u8[32]"),
    "artifact_request_v1": (144, 0x44, "32:context_handle:handle32;64:snapshot_handle:handle32;96:field_id:u32;100:cadence:u32;104:range_begin:u64;112:range_count:u64;120:destination_view_ptr:u64;128:expected_bytes:u64;136:accepted_sequence:u64"),
    "checkpoint_size_request_v1": (144, 0x3F, "32:context_handle:handle32;64:snapshot_handle:handle32;96:accepted_sequence:u64;104:schema_version:u32;108:inclusion_mask:u32;112:static_descriptor_digest:u8[32]"),
    "checkpoint_size_result_v1": (88, 0x3F, "32:required_bytes:u64;40:section_count:u32;44:alignment:u32;48:schema_version:u32;52:inclusion_mask:u32;56:snapshot_content_digest:u8[32]"),
    "checkpoint_export_request_v1": (144, 0x3F, "32:context_handle:handle32;64:snapshot_handle:handle32;96:accepted_sequence:u64;104:cadence_id:u64;112:destination_view_ptr:u64;120:exact_capacity:u64;128:expected_size:u64;136:inclusion_mask:u32;140:reserved0:u32"),
    "checkpoint_export_result_v1": (232, 0x3F, "32:committed_bytes:u64;40:payload_sha256:u8[32];72:snapshot_digest:u8[32];104:spin_digest:u8[32];136:warm_start_digest:u8[32];168:audit_sequence:u64;176:snapshot_lineage_id:u8[16];192:accepted_sequence:u64;200:operation_audit_digest:u8[32]"),
    "checkpoint_import_request_v1": (232, 0x3F, "32:context_handle:handle32;64:source_view_ptr:u64;72:expected_payload_sha256:u8[32];104:device_uuid:u8[16];120:build_digest:u8[32];152:static_descriptor_digest:u8[32];184:restore_policy:u32;188:reserved0:u32;192:expected_bytes:u64;200:audit_parent_digest:u8[32]"),
    "checkpoint_restore_result_v1": (232, 0x3F, "32:snapshot_handle:handle32;64:snapshot_lineage_id:u8[16];80:accepted_sequence:u64;88:snapshot_content_digest:u8[32];120:spin_digest:u8[32];152:warm_start_digest:u8[32];184:audit_sequence:u64;192:restored_state:u32;196:reserved0:u32;200:operation_audit_digest:u8[32]"),
    "transport_error_v1": (176, 0x7F, "32:status:u32;36:record_id:u32;40:field_offset:u32;44:reserved0:u32;48:requested_abi:u32;52:available_abi:u32;56:requested_struct:u32;60:available_struct:u32;64:requested_features:u64;72:available_features:u64;80:context_handle:handle32;112:snapshot_handle:handle32;144:attempt_id:u64;152:diagnostic_ptr:u64;160:diagnostic_capacity:u64;168:diagnostic_length:u64"),
}


ABI_U32_REGISTRIES = {
    "u32_bool": {"false": 0, "true": 1},
    "element_type": {
        "invalid": 0,
        "u8": 1,
        "u32": 2,
        "u64": 3,
        "i32": 4,
        "f64": 5,
        "raw_bytes": 6,
    },
    "pointer_space": {
        "invalid": 0,
        "host_read_only": 1,
        "host_write_only": 2,
        "device_read_only": 3,
        "device_write_only": 4,
    },
    "component_order": {
        "invalid": 0,
        "scalar": 1,
        "xyz": 2,
        "soa_xyz": 3,
        "row_major_Q_ia": 4,
        "oriented_face_xyz": 5,
    },
    "precision": {"invalid": 0, "double": 1, "single_known_unsupported": 2},
    "stream_policy": {"invalid": 0, "context_owned_single_stream": 1},
    "charge_solver_policy": {"invalid": 0, "cg_device_amg_v1": 1},
    "spin_solver_policy": {
        "invalid": 0,
        "restarted_gmres_component_amg_v1": 1,
        "restarted_gmres_block_jacobi_prototype_v1": 2,
    },
    "gauge_policy": {
        "invalid": 0,
        "boundary_reference_per_component": 1,
        "zero_mean_per_free_component": 2,
    },
    "convergence_reason": {
        "unset": 0,
        "converged": 1,
        "max_iterations": 2,
        "non_finite": 3,
        "algebraic_failure": 4,
        "physical_balance_failure": 5,
        "cancelled": 6,
    },
    "telemetry_direction": {"none": 0, "h2d": 1, "d2h": 2, "device_internal": 3, "d2d": 4},
    "telemetry_reason": {
        "invalid": 0,
        "static_upload_h2d": 1,
        "scalar_reduction_d2h": 2,
        "artifact_readback_d2h": 3,
        "checkpoint_export_d2h": 4,
        "checkpoint_import_h2d": 5,
        "stream_synchronize": 6,
        "event_wait": 7,
        "rejected_attempt": 8,
        "solve_state_d2d": 9,
    },
    "telemetry_status": {"success": 0, "failed": 1, "rejected": 2},
    "artifact_field_id": {
        "invalid": 0,
        "V": 1,
        "J_c": 2,
        "mu_s": 3,
        "Q_ia": 4,
        "torque_stt": 5,
        "charge_interface_trace": 6,
        "transport_observations": 7,
    },
    "artifact_cadence": {
        "forbidden": 0,
        "accepted_step": 1,
        "final_state": 2,
        "explicit_request": 3,
    },
    "checkpoint_schema_version": {"invalid": 0, "v1": 1},
    "checkpoint_restore_policy": {"invalid": 0, "exact_same_device_build": 1},
    "checkpoint_restored_state": {
        "not_restored": 0,
        "restored_charge_accepted": 1,
        "restored_spin_accepted": 2,
    },
    "error_status": {
        "ok": 0,
        "unsupported": 1,
        "incompatible_abi": 2,
        "invalid_descriptor": 3,
        "invalid_pointer_space": 4,
        "invalid_state": 5,
        "out_of_memory": 6,
        "nonconverged": 7,
        "balance_failure": 8,
        "stale_snapshot": 9,
        "strict_gpu_residency_violation": 10,
        "cuda_runtime_error": 11,
        "live_snapshot": 12,
        "already_destroyed": 13,
        "out_of_resources": 14,
        "unsupported_required_feature": 15,
        "checkpoint_incompatible": 16,
    },
    "record_id": {
        "none": 0,
        **{name: index for index, name in enumerate(ABI_RECORD_LAYOUTS, start=1)},
    },
}


ABI_U32_FLAG_REGISTRIES = {
    "telemetry_event_flags": {
        "none": 0x00,
        "transfer": 0x01,
        "synchronization": 0x02,
        "cadence_authorized": 0x04,
        "scientific_commit": 0x08,
        "provisional": 0x10,
        "failed": 0x20,
    },
    "checkpoint_inclusion_mask": {
        "none": 0x00,
        "charge_arrays": 0x01,
        "charge_observations": 0x02,
        "spin_arrays": 0x04,
        "spin_observations_and_torque": 0x08,
        "warm_starts": 0x10,
        "continuation_meta": 0x20,
    },
}


ABI_U32_LEGAL_MASKS = {
    "telemetry_event_flags": 0x3F,
    "checkpoint_inclusion_mask": 0x3F,
}


def _abi_layout_rows(runtime: str) -> dict[str, tuple[int, int, str]]:
    header = "| Record ID | MIN_SIZE_V1 | KNOWN_FEATURES_V1 | Ordered tail fields (`offset:name:type`) |"
    if header not in runtime:
        raise AssertionError("ABI record layout table is missing")
    rows: dict[str, tuple[int, int, str]] = {}
    for line in runtime[runtime.index(header) :].splitlines()[2:]:
        if not line.startswith("|"):
            break
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) != 4:
            raise AssertionError(f"invalid ABI layout row: {line}")
        rows[cells[0].strip("`")] = (
            int(cells[1].strip("`")),
            int(cells[2].strip("`"), 16),
            cells[3].strip("`"),
        )
    return rows


SUBRECORD_SCHEMAS = {
    1: (
        ("compute_capability", 2),
        ("cuda_driver", 2),
        ("cuda_runtime", 2),
        ("compiler_identity", 8),
        ("deterministic_policy_digest", 7),
        ("formula_id", 8),
        ("operator_id", 8),
        ("engine_id", 8),
        ("residual_id", 8),
        ("grid", 3),
        ("cell_size", 5),
        ("descriptor_revision", 3),
        ("source_revision", 3),
        ("operator_revision", 3),
        ("component_count", 3),
        ("gauge_component_ids", 2),
        ("gauge_values", 5),
        ("convergence_reason", 2),
        ("iterations", 3),
        ("work_budget", 3),
    ),
    6: (
        ("active", 1),
        ("conductor", 1),
        ("torque_target", 1),
        ("material_region", 2),
        ("conductivity_revision", 3),
    ),
    7: (
        ("cell_linear", 3),
        ("axis", 2),
        ("side", 4),
        ("area", 5),
        ("density", 5),
        ("source_ids", 9),
    ),
    8: (
        ("interface_ids", 9),
        ("face_linear", 3),
        ("orientation", 4),
        ("V_N", 5),
        ("V_F", 5),
        ("J_N", 5),
        ("J_F", 5),
    ),
    9: (
        ("electrode_ids", 9),
        ("electrode_current", 5),
        ("component_balance", 5),
        ("physical_residual", 5),
    ),
    18: (
        ("engine_id", 8),
        ("preconditioner_revision", 3),
        ("restart_position", 3),
        ("basis_count", 3),
        ("iterate", 5),
        ("basis", 5),
        ("deterministic_reduction_state", 1),
    ),
    20: (
        ("accepted_sequence", 3),
        ("attempt_id", 3),
        ("stage_id", 3),
        ("telemetry_cursor", 3),
        ("charge_work_budget", 3),
        ("spin_work_budget", 3),
        ("scientific_continuation_digest", 7),
    ),
}


SECTION_CODECS = {
    1: (6, 1, "subrecord"),
    2: (5, 8, "f64"),
    3: (5, 8, "f64"),
    4: (5, 8, "f64"),
    5: (5, 8, "f64"),
    6: (6, 1, "subrecord"),
    7: (6, 1, "subrecord"),
    8: (6, 1, "subrecord"),
    9: (6, 1, "subrecord"),
    18: (6, 1, "subrecord"),
    20: (6, 1, "subrecord"),
}


RESTORE_REQUIRED_CHARGE_SECTIONS = {1, 2, 3, 4, 5, 6, 7, 8, 9, 18, 20}


def _align_up(value: int, alignment: int) -> int:
    return (value + alignment - 1) // alignment * alignment


def _encode_field_value(field_type: int, value: object) -> tuple[bytes, int]:
    if field_type == 1:
        data = bytes(value)
        return data, len(data)
    if field_type in {2, 3, 4, 5}:
        values = list(value) if isinstance(value, (list, tuple)) else [value]
        formats = {2: "I", 3: "Q", 4: "i", 5: "d"}
        return struct.pack("<" + formats[field_type] * len(values), *values), len(values)
    if field_type in {6, 7}:
        data = bytes(value)
        width = 16 if field_type == 6 else 32
        if len(data) != width:
            raise AssertionError(f"fixed byte field has length {len(data)}, expected {width}")
        return data, 1
    if field_type == 8:
        data = unicodedata.normalize("NFC", str(value)).encode("utf-8")
        return data, 1
    if field_type == 9:
        encoded = bytearray()
        values = list(value)
        for item in values:
            data = unicodedata.normalize("NFC", str(item)).encode("utf-8")
            encoded.extend(struct.pack("<I", len(data)))
            encoded.extend(data)
        return bytes(encoded), len(values)
    raise AssertionError(f"unknown subrecord field type {field_type}")


def _encode_subrecord(section_id: int, values: dict[str, object]) -> bytes:
    schema = SUBRECORD_SCHEMAS[section_id]
    if set(values) != {name for name, _ in schema}:
        raise AssertionError(f"section {section_id} values do not match its field registry")
    encoded_fields = []
    cursor = _align_up(16 + 32 * len(schema), 8)
    for field_id, (name, field_type) in enumerate(schema, start=1):
        data, count = _encode_field_value(field_type, values[name])
        cursor = _align_up(cursor, 8)
        encoded_fields.append((field_id, field_type, count, cursor, data))
        cursor += len(data)
    record_bytes = _align_up(cursor, 8)
    record = bytearray(record_bytes)
    struct.pack_into("<HHIQ", record, 0, 1, 0, len(schema), record_bytes)
    for index, (field_id, field_type, count, offset, data) in enumerate(encoded_fields):
        struct.pack_into("<HHIQQQ", record, 16 + 32 * index, field_id, field_type, 1, count, offset, len(data))
        record[offset : offset + len(data)] = data
    return bytes(record)


def _charge_meta_values() -> dict[str, object]:
    return {
        "compute_capability": [8, 0],
        "cuda_driver": 12000,
        "cuda_runtime": 12000,
        "compiler_identity": "nvcc-golden",
        "deterministic_policy_digest": bytes([0x44]) * 32,
        "formula_id": "transport_constitutive.one_way.fullmag.v1",
        "operator_id": "fv_charge_harmonic_v1",
        "engine_id": "fdm_charge_cg_device_amg_cuda_v1",
        "residual_id": "charge_balance_integrated_l2.v1",
        "grid": [1, 1, 1],
        "cell_size": [1.0, 1.0, 1.0],
        "descriptor_revision": 1,
        "source_revision": 1,
        "operator_revision": 1,
        "component_count": 1,
        "gauge_component_ids": [0],
        "gauge_values": [1.0],
        "convergence_reason": ABI_U32_REGISTRIES["convergence_reason"]["converged"],
        "iterations": 1,
        "work_budget": 8,
    }


def _restore_section_values() -> dict[int, object]:
    values: dict[int, object] = {
        1: _charge_meta_values(),
        2: [1.0],
        3: [0.0, 0.0],
        4: [0.0, 0.0],
        5: [0.0, 0.0],
        6: {
            "active": bytes([1]),
            "conductor": bytes([1]),
            "torque_target": bytes([0]),
            "material_region": [1],
            "conductivity_revision": 1,
        },
        7: {"cell_linear": [], "axis": [], "side": [], "area": [], "density": [], "source_ids": []},
        8: {"interface_ids": [], "face_linear": [], "orientation": [], "V_N": [], "V_F": [], "J_N": [], "J_F": []},
        9: {
            "electrode_ids": ["ground"],
            "electrode_current": [0.0],
            "component_balance": [0.0],
            "physical_residual": [0.0],
        },
        18: {
            "engine_id": "fdm_charge_cg_device_amg_cuda_v1",
            "preconditioner_revision": 1,
            "restart_position": 0,
            "basis_count": 0,
            "iterate": [1.0],
            "basis": [],
            "deterministic_reduction_state": bytes(32),
        },
        20: {
            "accepted_sequence": 7,
            "attempt_id": 1,
            "stage_id": 1,
            "telemetry_cursor": 0,
            "charge_work_budget": 8,
            "spin_work_budget": 0,
            "scientific_continuation_digest": bytes(32),
        },
    }
    preliminary = _encode_subrecord(20, values[20])
    warm_start = _encode_subrecord(18, values[18])
    scientific_sections = []
    for section_id in range(1, 10):
        section_value = values[section_id]
        if section_id in SUBRECORD_SCHEMAS:
            scientific_sections.append(_encode_subrecord(section_id, section_value))
        else:
            scientific_sections.append(struct.pack("<" + "d" * len(section_value), *section_value))
    snapshot_digest = hashlib.sha256(b"".join(scientific_sections)).digest()
    continuation_digest = hashlib.sha256(snapshot_digest + warm_start + preliminary).digest()
    values[20]["scientific_continuation_digest"] = continuation_digest
    return values


def _encode_section(section_id: int, value: object) -> bytes:
    _, _, codec = SECTION_CODECS[section_id]
    if codec == "subrecord":
        return _encode_subrecord(section_id, value)
    values = list(value)
    return struct.pack("<" + "d" * len(values), *values)


def _build_checkpoint(section_values: dict[int, object]) -> bytes:
    section_ids = sorted(section_values)
    section_payloads = [(section_id, _encode_section(section_id, section_values[section_id])) for section_id in section_ids]
    header_size = 320
    descriptor_size = 96
    section_count = len(section_payloads)
    payload_offset = _align_up(header_size + descriptor_size * section_count, 64)
    offsets = []
    cursor = payload_offset
    for _, content in section_payloads:
        cursor = _align_up(cursor, 64)
        offsets.append(cursor)
        cursor += len(content)
    total_size = _align_up(cursor, 64)
    payload = bytearray(total_size)
    struct.pack_into("<8sHHIIIIIQQQQQQ", payload, 0, b"FMGPUTR1", 1, 0, header_size, 0x01020304, descriptor_size, section_count, 0, total_size, header_size, payload_offset, 0, 0x20, 7)
    payload[80:96] = bytes(range(16))
    payload[96:112] = bytes(range(16, 32))
    payload[112:144] = bytes([0x11]) * 32
    payload[144:176] = bytes([0x22]) * 32
    scientific_contents = [content for (section_id, content) in section_payloads if section_id in set(range(1, 10)) | set(range(10, 18))]
    payload[176:208] = hashlib.sha256(b"".join(scientific_contents)).digest()
    descriptors = bytearray()
    section_bytes = bytearray()
    for (section_id, content), offset in zip(section_payloads, offsets):
        element_type, element_size, _ = SECTION_CODECS[section_id]
        descriptor = bytearray(descriptor_size)
        struct.pack_into("<IHHIIQQQQ", descriptor, 0, section_id, 1, 1, element_type, element_size, len(content) // element_size, offset, len(content), len(content))
        descriptor[48:80] = hashlib.sha256(content).digest()
        descriptors.extend(descriptor)
        section_bytes.extend(content)
        payload[offset : offset + len(content)] = content
    payload[header_size : header_size + len(descriptors)] = descriptors
    payload[208:240] = hashlib.sha256(descriptors).digest()
    payload[240:272] = hashlib.sha256(section_bytes).digest()
    payload[272:304] = b"\x00" * 32
    payload[272:304] = hashlib.sha256(payload).digest()
    return bytes(payload)


def _build_checkpoint_golden() -> bytes:
    return _build_checkpoint({1: _charge_meta_values(), 2: [1.0]})


def _build_restore_checkpoint_golden() -> bytes:
    return _build_checkpoint(_restore_section_values())


def _checkpoint_golden_bytes(runtime: str) -> bytes:
    begin = "FMGPUTR1_GOLDEN_HEX_BEGIN"
    end = "FMGPUTR1_GOLDEN_HEX_END"
    if begin not in runtime or end not in runtime:
        raise AssertionError("FMGPUTR1 golden payload block is missing")
    hex_text = runtime.split(begin, 1)[1].split(end, 1)[0]
    return bytes.fromhex("".join(hex_text.split()))


def _restore_checkpoint_golden_bytes(runtime: str) -> bytes:
    begin = "FMGPUTR1_RESTORE_GOLDEN_HEX_BEGIN"
    end = "FMGPUTR1_RESTORE_GOLDEN_HEX_END"
    if begin not in runtime or end not in runtime:
        raise AssertionError("FMGPUTR1 restore-valid golden payload block is missing")
    hex_text = runtime.split(begin, 1)[1].split(end, 1)[0]
    return bytes.fromhex("".join(hex_text.split()))


def _assert_abi_byte_layout(runtime: str) -> None:
    normalised = _normalise(runtime)
    for field in (
        "0:abi_version:u32",
        "4:struct_version:u32",
        "8:struct_size:u32",
        "12:reserved_flags:u32",
        "16:required_features:u64",
        "24:reserved0:u64",
        "COMMON_PREFIX_SIZE=32",
        "COMMON_PREFIX_ALIGNMENT=8",
        "KNOWN_GLOBAL_FEATURES_V1=0x000000000000007f",
    ):
        if field not in normalised:
            raise AssertionError(f"ABI common byte layout lost {field}")
    rows = _abi_layout_rows(runtime)
    if rows != ABI_RECORD_LAYOUTS:
        raise AssertionError("ABI per-record byte layouts, MIN_SIZE or feature masks differ")


def _abi_u32_registry_rows(runtime: str) -> tuple[dict[str, dict[str, int]], dict[str, dict[str, int]], dict[str, int]]:
    enum_header = "| U32 registry | Name | Exact value | Zero/unknown rule |"
    flag_header = "| U32 flag registry | Name | Exact bit | Legality |"
    mask_header = "| U32 flag registry | LEGAL_MASK_V1 |"
    if enum_header not in runtime or flag_header not in runtime or mask_header not in runtime:
        raise AssertionError("numeric ABI registry tables are missing")
    enums: dict[str, dict[str, int]] = {}
    for line in runtime[runtime.index(enum_header) :].splitlines()[2:]:
        if not line.startswith("|"):
            break
        cells = [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]
        if len(cells) != 4:
            raise AssertionError(f"invalid numeric enum row: {line}")
        enums.setdefault(cells[0], {})[cells[1]] = int(cells[2], 0)
    flags: dict[str, dict[str, int]] = {}
    for line in runtime[runtime.index(flag_header) :].splitlines()[2:]:
        if not line.startswith("|"):
            break
        cells = [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]
        if len(cells) != 4:
            raise AssertionError(f"invalid numeric flag row: {line}")
        flags.setdefault(cells[0], {})[cells[1]] = int(cells[2], 0)
    masks: dict[str, int] = {}
    for line in runtime[runtime.index(mask_header) :].splitlines()[2:]:
        if not line.startswith("|"):
            break
        cells = [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]
        if len(cells) != 2:
            raise AssertionError(f"invalid legal-mask row: {line}")
        masks[cells[0]] = int(cells[1], 0)
    return enums, flags, masks


def _assert_abi_numeric_registries(runtime: str) -> None:
    enums, flags, masks = _abi_u32_registry_rows(runtime)
    if enums != ABI_U32_REGISTRIES:
        raise AssertionError("closed u32 enum/ID registry differs")
    if flags != ABI_U32_FLAG_REGISTRIES:
        raise AssertionError("u32 flag registry differs")
    if masks != ABI_U32_LEGAL_MASKS:
        raise AssertionError("u32 legal masks differ")
    normalised = _normalise(runtime)
    for rule in (
        "closed enum unknown u32 values are invalid_descriptor",
        "telemetry_event_flags unknown bits are incompatible_abi",
        "checkpoint_inclusion_mask unknown bits are unsupported_required_feature",
        "strict_residency and deterministic are u32 booleans restricted to 0 or 1",
        "schema_version is u32 value 1",
        "error_status ok=0 is forbidden in transport_error_v1",
        "checkpoint charge-only required mask is 0x00000033",
        "checkpoint spin-required mask is 0x0000003f",
    ):
        if rule not in normalised:
            raise AssertionError(f"numeric ABI unknown/sentinel rule lost {rule}")


def _decode_field_value(field_type: int, content: bytes, count: int) -> object:
    widths = {1: 1, 2: 4, 3: 8, 4: 4, 5: 8, 6: 16, 7: 32}
    if field_type in widths:
        if len(content) != count * widths[field_type]:
            raise AssertionError("subrecord fixed-width field length mismatch")
        if field_type == 1:
            return content
        if field_type in {6, 7}:
            if count != 1:
                raise AssertionError("fixed identity/digest count must be one")
            return content
        formats = {2: "I", 3: "Q", 4: "i", 5: "d"}
        return list(struct.unpack("<" + formats[field_type] * count, content))
    if field_type == 8:
        if count != 1:
            raise AssertionError("UTF-8 scalar count must be one")
        value = content.decode("utf-8")
        if unicodedata.normalize("NFC", value) != value or "\x00" in value:
            raise AssertionError("UTF-8 scalar is not canonical NFC/no-NUL")
        return value
    if field_type == 9:
        values = []
        cursor = 0
        for _ in range(count):
            if cursor + 4 > len(content):
                raise AssertionError("UTF-8 list length prefix is truncated")
            length = struct.unpack_from("<I", content, cursor)[0]
            cursor += 4
            if cursor + length > len(content):
                raise AssertionError("UTF-8 list item is truncated")
            value = content[cursor : cursor + length].decode("utf-8")
            if unicodedata.normalize("NFC", value) != value or "\x00" in value:
                raise AssertionError("UTF-8 list item is not canonical NFC/no-NUL")
            values.append(value)
            cursor += length
        if cursor != len(content):
            raise AssertionError("UTF-8 list has trailing bytes")
        return values
    raise AssertionError(f"unknown subrecord field type {field_type}")


def _decode_subrecord(section_id: int, content: bytes) -> dict[str, object]:
    if len(content) < 16:
        raise AssertionError("subrecord header is truncated")
    version, flags, field_count, record_bytes = struct.unpack_from("<HHIQ", content, 0)
    schema = SUBRECORD_SCHEMAS[section_id]
    if (version, flags, field_count, record_bytes) != (1, 0, len(schema), len(content)):
        raise AssertionError("subrecord header/version/field_count/record_bytes mismatch")
    directory_end = 16 + 32 * field_count
    if directory_end > len(content):
        raise AssertionError("subrecord field directory is truncated")
    decoded: dict[str, object] = {}
    counts: dict[str, int] = {}
    previous_end = _align_up(directory_end, 8)
    if content[directory_end:previous_end] != b"\x00" * (previous_end - directory_end):
        raise AssertionError("subrecord directory padding is nonzero")
    for index, (expected_name, expected_type) in enumerate(schema):
        field_id, field_type, field_flags, count, offset, length = struct.unpack_from("<HHIQQQ", content, 16 + 32 * index)
        if (field_id, field_type, field_flags) != (index + 1, expected_type, 1):
            raise AssertionError("subrecord field registry/type/flags mismatch")
        expected_offset = _align_up(previous_end, 8)
        if offset != expected_offset or offset + length > len(content):
            raise AssertionError("subrecord field offset/length is invalid")
        if content[previous_end:offset] != b"\x00" * (offset - previous_end):
            raise AssertionError("subrecord inter-field padding is nonzero")
        decoded[expected_name] = _decode_field_value(field_type, content[offset : offset + length], count)
        counts[expected_name] = count
        previous_end = offset + length
    canonical_record_bytes = _align_up(previous_end, 8)
    if len(content) != canonical_record_bytes:
        raise AssertionError("subrecord record_bytes is not the minimal canonical alignment")
    if content[previous_end:] != b"\x00" * (canonical_record_bytes - previous_end):
        raise AssertionError("subrecord trailing padding is nonzero")
    exact_counts = {
        1: {"compute_capability": 2, "cuda_driver": 1, "cuda_runtime": 1, "compiler_identity": 1, "deterministic_policy_digest": 1, "formula_id": 1, "operator_id": 1, "engine_id": 1, "residual_id": 1, "grid": 3, "cell_size": 3, "descriptor_revision": 1, "source_revision": 1, "operator_revision": 1, "component_count": 1, "convergence_reason": 1, "iterations": 1, "work_budget": 1},
        6: {"conductivity_revision": 1},
        18: {"engine_id": 1, "preconditioner_revision": 1, "restart_position": 1, "basis_count": 1},
        20: {name: 1 for name, _ in SUBRECORD_SCHEMAS[20]},
    }.get(section_id, {})
    for name, expected_count in exact_counts.items():
        if counts[name] != expected_count:
            raise AssertionError(f"section {section_id} field {name} count differs")
    return decoded


def _zero_subrecord_field(content: bytes, field_id: int) -> bytes:
    candidate = bytearray(content)
    _, _, field_count, _ = struct.unpack_from("<HHIQ", candidate, 0)
    if not 1 <= field_id <= field_count:
        raise AssertionError("subrecord field id is outside the directory")
    _, _, _, _, offset, length = struct.unpack_from("<HHIQQQ", candidate, 16 + 32 * (field_id - 1))
    candidate[offset : offset + length] = b"\x00" * length
    return bytes(candidate)


def _validate_checkpoint_golden(payload: bytes, *, require_restore: bool = False) -> dict[int, object]:
    if len(payload) < 320:
        raise AssertionError("checkpoint is truncated before the v1 header")
    values = struct.unpack_from("<8sHHIIIIIQQQQQQ", payload, 0)
    magic, major, minor, header_size, endian, descriptor_size, count, reserved, total_size, table_offset, payload_offset, flags, features, sequence = values
    if (magic, major, minor, header_size, endian, descriptor_size, reserved) != (
        b"FMGPUTR1", 1, 0, 320, 0x01020304, 96, 0
    ):
        raise AssertionError("checkpoint header fields differ from golden v1")
    expected_payload_offset = _align_up(header_size + count * descriptor_size, 64)
    if (table_offset, payload_offset, flags, features, sequence) != (320, expected_payload_offset, 0, 0x20, 7):
        raise AssertionError("checkpoint header identities differ from golden v1")
    if len(payload) != total_size:
        raise AssertionError("checkpoint total_size mismatch")
    if payload[304:320] != b"\x00" * 16:
        raise AssertionError("checkpoint header padding is not canonical zero")
    descriptors = payload[table_offset : table_offset + count * descriptor_size]
    if len(descriptors) != count * descriptor_size:
        raise AssertionError("checkpoint descriptor table is truncated")
    if hashlib.sha256(descriptors).digest() != payload[208:240]:
        raise AssertionError("checkpoint descriptor-table digest mismatch")
    if payload[table_offset + len(descriptors) : payload_offset] != b"\x00" * (payload_offset - table_offset - len(descriptors)):
        raise AssertionError("checkpoint table-to-payload padding is not zero")
    section_data = bytearray()
    previous_offset = payload_offset
    decoded: dict[int, object] = {}
    raw_contents: dict[int, bytes] = {}
    previous_id = 0
    for index in range(count):
        descriptor = descriptors[index * descriptor_size : (index + 1) * descriptor_size]
        section_id, version, section_flags, element_type, element_size, element_count, offset, length, raw_length = struct.unpack_from("<IHHIIQQQQ", descriptor, 0)
        if section_id not in SECTION_CODECS or section_id <= previous_id:
            raise AssertionError("checkpoint section id is unknown or out of order")
        expected_type, expected_size, codec = SECTION_CODECS[section_id]
        if (element_type, element_size, element_count) != (expected_type, expected_size, length // expected_size):
            raise AssertionError("checkpoint section element tuple differs from its registry")
        if (version, section_flags, raw_length) != (1, 1, length):
            raise AssertionError("checkpoint section version/flags/raw length mismatch")
        expected_offset = _align_up(previous_offset, 64)
        if descriptor[80:96] != b"\x00" * 16 or offset != expected_offset:
            raise AssertionError("checkpoint descriptor padding/order/alignment mismatch")
        if payload[previous_offset:offset] != b"\x00" * (offset - previous_offset):
            raise AssertionError("checkpoint inter-section padding is not zero")
        content = payload[offset : offset + length]
        if hashlib.sha256(content).digest() != descriptor[48:80]:
            raise AssertionError("checkpoint section digest mismatch")
        if codec == "subrecord":
            decoded[section_id] = _decode_subrecord(section_id, content)
        else:
            decoded[section_id] = _decode_field_value(5, content, element_count)
        raw_contents[section_id] = content
        section_data.extend(content)
        previous_offset = offset + length
        previous_id = section_id
    canonical_total_size = _align_up(previous_offset, 64)
    if total_size != canonical_total_size:
        raise AssertionError("checkpoint total_size is not the minimal canonical alignment")
    if payload[previous_offset:] != b"\x00" * (canonical_total_size - previous_offset):
        raise AssertionError("checkpoint trailing padding is not zero")
    if hashlib.sha256(section_data).digest() != payload[240:272]:
        raise AssertionError("checkpoint ordered section-data digest mismatch")
    candidate = bytearray(payload)
    expected_file_digest = bytes(candidate[272:304])
    candidate[272:304] = b"\x00" * 32
    if hashlib.sha256(candidate).digest() != expected_file_digest:
        raise AssertionError("checkpoint whole-file digest mismatch")
    scientific_ids = [section_id for section_id in decoded if 1 <= section_id <= 17]
    if hashlib.sha256(b"".join(raw_contents[section_id] for section_id in scientific_ids)).digest() != payload[176:208]:
        raise AssertionError("checkpoint snapshot-content digest mismatch")
    if require_restore:
        if set(decoded) != RESTORE_REQUIRED_CHARGE_SECTIONS:
            raise AssertionError("restore-valid charge checkpoint section set is incomplete")
        grid = decoded[1]["grid"]
        if grid != [1, 1, 1]:
            raise AssertionError("restore golden grid differs")
        component_count = decoded[1]["component_count"][0]
        if len(decoded[1]["gauge_component_ids"]) != component_count or len(decoded[1]["gauge_values"]) != component_count:
            raise AssertionError("restore golden gauge arrays differ from component_count")
        if tuple(len(decoded[section_id]) for section_id in (2, 3, 4, 5)) != (1, 2, 2, 2):
            raise AssertionError("restore golden charge array shapes differ")
        if not all(len(decoded[6][name]) == 1 for name in ("active", "conductor", "torque_target", "material_region")):
            raise AssertionError("restore golden mask shapes differ")
        for section_id, fields in ((7, ("cell_linear", "axis", "side", "area", "density", "source_ids")), (8, ("interface_ids", "face_linear", "orientation", "V_N", "V_F", "J_N", "J_F"))):
            if len({len(decoded[section_id][name]) for name in fields}) != 1:
                raise AssertionError("restore golden parallel observation arrays differ")
        if len({len(decoded[9][name]) for name in ("electrode_ids", "electrode_current", "component_balance", "physical_residual")}) != 1:
            raise AssertionError("restore golden charge observation arrays differ")
        if len(decoded[18]["iterate"]) != 1 or len(decoded[18]["basis"]) != decoded[18]["basis_count"][0]:
            raise AssertionError("restore golden warm-start counts differ")
        if decoded[20]["accepted_sequence"] != [sequence]:
            raise AssertionError("restore golden accepted sequence differs")
        continuation = decoded[20]["scientific_continuation_digest"]
        expected_continuation = hashlib.sha256(payload[176:208] + raw_contents[18] + _zero_subrecord_field(raw_contents[20], 7)).digest()
        if continuation != expected_continuation:
            raise AssertionError("restore golden scientific continuation digest mismatch")
    return decoded


def _rehash_checkpoint(payload: bytearray) -> bytes:
    _, _, _, header_size, _, descriptor_size, count, _, total_size, table_offset, _, _, _, _ = struct.unpack_from("<8sHHIIIIIQQQQQQ", payload, 0)
    if len(payload) != total_size:
        raise AssertionError("cannot rehash malformed checkpoint size")
    section_data = bytearray()
    scientific_data = bytearray()
    for index in range(count):
        descriptor_offset = table_offset + index * descriptor_size
        section_id, _, _, _, _, _, offset, length, _ = struct.unpack_from("<IHHIIQQQQ", payload, descriptor_offset)
        content = payload[offset : offset + length]
        payload[descriptor_offset + 48 : descriptor_offset + 80] = hashlib.sha256(content).digest()
        section_data.extend(content)
        if 1 <= section_id <= 17:
            scientific_data.extend(content)
    descriptors = payload[table_offset : table_offset + count * descriptor_size]
    payload[176:208] = hashlib.sha256(scientific_data).digest()
    payload[208:240] = hashlib.sha256(descriptors).digest()
    payload[240:272] = hashlib.sha256(section_data).digest()
    payload[272:304] = b"\x00" * 32
    payload[272:304] = hashlib.sha256(payload).digest()
    return bytes(payload)


def _checkpoint_with_extra_trailing_block(payload: bytes) -> bytes:
    candidate = bytearray(payload)
    total_size = struct.unpack_from("<Q", candidate, 32)[0]
    candidate.extend(bytes(64))
    struct.pack_into("<Q", candidate, 32, total_size + 64)
    return _rehash_checkpoint(candidate)


def _checkpoint_with_extra_subrecord_gap(payload: bytes) -> bytes:
    candidate = bytearray(payload)
    descriptor_offset = 320
    section_offset = struct.unpack_from("<Q", candidate, descriptor_offset + 24)[0]
    section_length = struct.unpack_from("<Q", candidate, descriptor_offset + 32)[0]
    section = bytes(candidate[section_offset : section_offset + section_length])
    _, _, field_count, record_bytes = struct.unpack_from("<HHIQ", section, 0)
    first_data_offset = struct.unpack_from("<Q", section, 16 + 16)[0]
    expanded = bytearray(section_length + 8)
    expanded[:first_data_offset] = section[:first_data_offset]
    expanded[first_data_offset + 8 :] = section[first_data_offset:]
    struct.pack_into("<Q", expanded, 8, record_bytes + 8)
    for index in range(field_count):
        field_descriptor = 16 + 32 * index
        data_offset = struct.unpack_from("<Q", expanded, field_descriptor + 16)[0]
        struct.pack_into("<Q", expanded, field_descriptor + 16, data_offset + 8)
    candidate[section_offset : section_offset + len(expanded)] = expanded
    struct.pack_into("<Q", candidate, descriptor_offset + 16, len(expanded))
    struct.pack_into("<Q", candidate, descriptor_offset + 32, len(expanded))
    struct.pack_into("<Q", candidate, descriptor_offset + 40, len(expanded))
    return _rehash_checkpoint(candidate)


def _checkpoint_with_extra_intersection_block(payload: bytes) -> bytes:
    candidate = bytearray(payload)
    second_descriptor = 320 + 96
    second_offset = struct.unpack_from("<Q", candidate, second_descriptor + 24)[0]
    second_length = struct.unpack_from("<Q", candidate, second_descriptor + 32)[0]
    second_content = bytes(candidate[second_offset : second_offset + second_length])
    new_second_offset = second_offset + 64
    candidate.extend(bytes(64))
    candidate[second_offset : second_offset + second_length] = bytes(second_length)
    candidate[new_second_offset : new_second_offset + second_length] = second_content
    struct.pack_into("<Q", candidate, second_descriptor + 24, new_second_offset)
    struct.pack_into("<Q", candidate, 32, _align_up(new_second_offset + second_length, 64))
    return _rehash_checkpoint(candidate)


def _assert_telemetry_and_fixture_closure(page: str, runtime: str) -> None:
    combined = _normalise(_gpu_section(page) + "\n" + _anchored_section(runtime, "(fdm-gpu-m1-abi-v1)=", "\n## 14. Capability gates M0–M3"))
    codec_golden = _build_checkpoint_golden()
    restore_golden = _build_restore_checkpoint_golden()
    required = (
        "scientific_continuation_digest",
        "operation_audit_digest",
        "append-only operation audit",
        "failed checkpoint_import_h2d",
        "full telemetry stream is not compared",
        "runtime exporter never emits it",
        "scientific importer rejects it",
        "free component B has no voltage datum",
        "artifact D2H=512 bytes",
        f"codec-only golden length={len(codec_golden)} bytes",
        f"codec-only golden SHA-256={hashlib.sha256(codec_golden).hexdigest()}",
        f"restore-valid checkpoint length={len(restore_golden)} bytes",
        f"restore-valid checkpoint SHA-256={hashlib.sha256(restore_golden).hexdigest()}",
        f"checkpoint D2H={len(restore_golden)} bytes",
        "mixing grids 2x16x1, 2x32x1, and 2x64x1",
        "e_n=1/(6n^2)",
        "workload-specific fixed qualification envelope, not a global runtime cap",
        "warm transactional peak <=2147483648",
        "median total solve <=30 s",
        "p95 total solve <=36 s",
    )
    for value in required:
        if _normalise(value) not in combined:
            raise AssertionError(f"telemetry/fixture closure lost {value}")
    if "approved fdm_gpu_m1_perf_baseline_v1.json" in combined:
        raise AssertionError("performance gate still depends on a future approved baseline")
    if "checkpoint D2H=640 bytes" in combined or "640-byte FMGPUTR1 codec-golden export" in combined:
        raise AssertionError("runtime fixtures still use the codec-only golden as a checkpoint")


def _qualification_rows(page: str) -> dict[str, tuple[str, str, str, str]]:
    section = _gpu_section(page)
    header = "| Gate ID | Fixture and frozen parameters | Exact oracle | Metric and tolerance/budget | Required device/artifact proof |"
    if header not in section:
        raise AssertionError("qualification matrix lost its exact five-column header")
    start = section.index(header)
    rows: dict[str, tuple[str, str, str, str]] = {}
    for line in section[start:].splitlines()[2:]:
        if not line.startswith("|"):
            break
        cells = tuple(cell.strip() for cell in line.strip().strip("|").split("|"))
        if len(cells) != 5:
            raise AssertionError(f"qualification row must have five columns: {line}")
        gate = cells[0].strip("`")
        if gate in rows:
            raise AssertionError(f"duplicate qualification gate: {gate}")
        rows[gate] = (cells[1], cells[2], cells[3], cells[4])
    return rows


def _assert_qualification_matrix(page: str) -> None:
    rows = _qualification_rows(page)
    if set(rows) != REQUIRED_QUALIFICATION_GATES:
        raise AssertionError(
            f"qualification gates differ: expected {sorted(REQUIRED_QUALIFICATION_GATES)}, got {sorted(rows)}"
        )
    for gate, (fixture, oracle, metric, proof) in rows.items():
        if f"`fdm_gpu_m1_{gate}`" not in fixture:
            raise AssertionError(f"{gate} lost exact fixture id")
        if "`oracle." not in oracle:
            raise AssertionError(f"{gate} lost exact oracle id")
        if not any(character.isdigit() for character in metric) or not any(
            token in metric for token in ("exact", "<=", ">=", "rtol", "atol")
        ):
            raise AssertionError(f"{gate} lost numeric metric/tolerance")
        if "non-skipped" not in proof or "GPU UUID" not in proof or ".json" not in proof:
            raise AssertionError(f"{gate} lost managed device/artifact proof")


def _assert_honest_gpu_status(section: str) -> None:
    normalised = _normalise(section)
    for required in (
        "semantic_only",
        "implementation_state=partial",
        "validation_state=unvalidated",
        "validated_workloads=[]",
    ):
        if required not in normalised:
            raise AssertionError(f"GPU status lost {required}")
    for forbidden in (
        "implementation_state=absent",
        "implementation_state=source_visible",
        "implementation_state=executable",
        "validation_state=validated",
        "validated_workloads=[fdm_gpu_m1_demo]",
        "source_visible",
        "development_executable",
        "reference_executable",
        "production_executable",
    ):
        if forbidden in normalised:
            raise AssertionError(f"GPU status contains contradictory promotion {forbidden}")


def _status_sections() -> dict[str, str]:
    page = PAGE.read_text(encoding="utf-8")
    runtime = RUNTIME.read_text(encoding="utf-8")
    masterplan = MASTERPLAN.read_text(encoding="utf-8")
    capability = CAPABILITY_MD.read_text(encoding="utf-8")
    plan = PLAN.read_text(encoding="utf-8")
    return {
        "note": _gpu_section(page).split("#### Ownership", 1)[0],
        "runtime": _anchored_section(
            runtime,
            "(fdm-gpu-m1-abi-v1)=",
            "\nThe ABI is separate from `fullmag_fdm_cpu_*`",
        ),
        "masterplan": _anchored_section(
            masterplan,
            "Dlatego capability FDM GPU M1 pozostaje",
            "\n\n## 9. Strategia Demagnetyzacji",
        ),
        "capability": _anchored_section(
            capability,
            "PR-15 nie promuje FDM GPU/FP64 M1.",
            "\n\n| Capability id |",
        ),
        "plan": plan[
            plan.index("## 32.166. Implementacja ograniczonego FDM GPU/FP64 M1 charge") :
        ],
    }


def _assert_abi_contract(runtime: str) -> None:
    start = "(fdm-gpu-m1-abi-v1)="
    end = "\n## 14. Capability gates M0–M3"
    section = _anchored_section(runtime, start, end) if end in runtime else runtime[runtime.index(start) :]
    normalised = _normalise(section)
    required = (
        "fullmag_fdm_gpu_transport_context_handle_v1",
        "fullmag_fdm_gpu_charge_snapshot_handle_v1",
        "fullmag_fdm_gpu_charge_snapshot_info_v1",
        "registry_cookie",
        "slot",
        "generation",
        "type_tag",
        "retired tombstone",
        "generation exhaustion",
        "same struct_version",
        "unknown struct_version",
        "required_features",
        "fullmag_fdm_gpu_transport_checkpoint_export_request_v1",
        "fullmag_fdm_gpu_transport_checkpoint_import_request_v1",
        "fullmag_fdm_gpu_transport_checkpoint_restore_result_v1",
        "checkpoint_query_size",
        "checkpoint_export",
        "checkpoint_import",
        "FMGPUTR1",
        "little-endian",
        "SHA-256",
        "snapshot_lineage_id",
        "accepted_sequence",
        "snapshot_content_digest",
        "atomic restore",
        "checkpoint_export_d2h",
        "checkpoint_import_h2d",
    )
    for value in required:
        if _normalise(value) not in normalised:
            raise AssertionError(f"GPU ABI contract lost {value}")
    if "fullmag_fdm_gpu_charge_snapshot_v1" in normalised:
        raise AssertionError("opaque snapshot handle and snapshot info still share one ABI name")
    _assert_honest_gpu_status(section)


PAGE_MUTATIONS = {
    "separate context": ("GpuTransportContext", "Context"),
    "device snapshot": ("immutable device snapshot", "host snapshot"),
    "density boundary": ("NormalCurrentElectrode [A/m2]", "NormalCurrentElectrode [A]"),
    "face-current electric field": (
        "fdm_exact_face_current_electric_reconstruction.v1",
        "structured_cross_gradient_v1",
    ),
    "six SHE contractions": ("all six signed Levi-Civita contractions", "one cross product"),
    "transverse-only mixing": ("transverse-only", "charge-conducting-only"),
    "strict residency": ("zero vector transfers per stage", "one vector transfer per stage"),
    "no fallback": ("no CPU fallback", "CPU fallback"),
    "FP64 only": ("FP64-only", "FP32-enabled"),
    "telemetry provenance": ("versioned transfer telemetry and provenance", "unversioned counters"),
    "exact-zero upwind tie": (
        "exact zero selects the negative-axis cell and multiplies it by exact zero",
        "exact zero selects an implementation-defined cell",
    ),
}


ABI_MUTATIONS = {
    "typed snapshot handle": (
        "fullmag_fdm_gpu_charge_snapshot_handle_v1",
        "fullmag_fdm_gpu_charge_snapshot_v1",
    ),
    "snapshot info": ("fullmag_fdm_gpu_charge_snapshot_info_v1", "snapshot record"),
    "safe tombstone": ("retired tombstone", "freed pointer"),
    "version negotiation": ("same struct_version", "any struct_version"),
    "checkpoint export": ("checkpoint_export", "checkpoint_download"),
    "checkpoint import": ("checkpoint_import", "checkpoint_upload"),
    "checkpoint integrity": ("SHA-256", "unchecked bytes"),
    "atomic restore": ("atomic restore", "incremental restore"),
}


def _assert_page_contract(page: str) -> None:
    normalised = _normalise(page)
    required = (
        "(fdm-gpu-m1-fp64-contract)=",
        "backends/fdm/gpu/cuda/transport/**",
        "GpuTransportContext",
        "must not extend the LLG Context",
        "FP64-only",
        "FP32 remains fail-closed",
        "immutable device snapshot",
        "V[N]",
        "Jx[(nx+1)ny nz]",
        "Jy[nx(ny+1)nz]",
        "Jz[nx ny(nz+1)]",
        "two accepted charge traces",
        "NormalCurrentElectrode [A/m2]",
        "fdm_exact_face_current_electric_reconstruction.v1",
        "all six signed Levi-Civita contractions",
        "exact zero selects the negative-axis cell and multiplies it by exact zero",
        "transverse-only",
        "fdm_transport_torque_cell_surface_balance.v1",
        "fdm_charge_cg_cuda_v1",
        "fdm_spin_block_gmres_cuda_v1",
        "zero vector transfers per stage",
        "versioned transfer telemetry and provenance",
        "no CPU fallback",
        "semantic_only",
        "implementation_state=partial",
        "validated_workloads=[]",
        "rejected attempt",
        "immutable accepted snapshots",
        "cache key",
        "restart",
        "device evidence",
    )
    for value in required:
        if _normalise(value) not in normalised:
            raise AssertionError(f"FDM GPU M1 page contract lost {value}")


class FdmGpuM1ContractDocsTests(unittest.TestCase):
    def test_fdm_gpu_m1_fp64_contract_is_frozen_without_capability_promotion(self) -> None:
        page = PAGE.read_text(encoding="utf-8")
        runtime = _normalise(RUNTIME.read_text(encoding="utf-8"))
        masterplan = _normalise(MASTERPLAN.read_text(encoding="utf-8"))
        capability_md = _normalise(CAPABILITY_MD.read_text(encoding="utf-8"))
        plan = _normalise(PLAN.read_text(encoding="utf-8"))
        source_map = json.loads(SOURCE_MAP.read_text(encoding="utf-8"))
        capability = json.loads(CAPABILITY_JSON.read_text(encoding="utf-8"))

        _assert_page_contract(page)
        _assert_qualification_matrix(page)
        _assert_honest_gpu_status(_gpu_section(page))
        _assert_abi_contract(RUNTIME.read_text(encoding="utf-8"))
        _assert_abi_byte_layout(RUNTIME.read_text(encoding="utf-8"))
        _assert_abi_numeric_registries(RUNTIME.read_text(encoding="utf-8"))
        _assert_telemetry_and_fixture_closure(page, RUNTIME.read_text(encoding="utf-8"))
        for status_section in _status_sections().values():
            _assert_honest_gpu_status(status_section)

        for value in (
            "(fdm-gpu-m1-abi-v1)=",
            "fullmag_fdm_gpu_transport_context_handle_v1",
            "fullmag_fdm_gpu_charge_snapshot_handle_v1",
            "fullmag_fdm_gpu_charge_snapshot_info_v1",
            "abi_version, struct_version, struct_size, reserved_flags",
            "host_read_only",
            "device_read_only",
            "context_create",
            "upload_static_descriptor",
            "solve_charge",
            "accept_charge_snapshot",
            "solve_steady_spin",
            "query_telemetry",
            "readback_artifact",
            "checkpoint_query_size",
            "checkpoint_export",
            "checkpoint_import",
            "destroy",
            "stale_snapshot",
            "strict_gpu_residency_violation",
            "double destroy",
        ):
            self.assertIn(_normalise(value), runtime)

        self.assertIn("backends/fdm/gpu/cuda/transport/**", masterplan)
        self.assertIn("GpuTransportContext", masterplan)
        self.assertIn("32.161. FDM GPU/FP64 M1 docs-first contract freeze", plan)
        self.assertIn("32.166. Implementacja ograniczonego FDM GPU/FP64 M1 charge", plan)
        self.assertIn("implementation_state=partial", plan)
        self.assertIn("implementation_state=partial", capability_md)
        self.assertIn("validation_state=unvalidated", capability_md)
        self.assertIn("validated_workloads=[]", capability_md)
        self.assertIn("torem A", runtime)
        self.assertIn("Tor B", runtime)
        self.assertIn("checkpoint_incompatible", runtime)

        lanes = {
            feature["id"]: feature
            for feature in capability["features"]
            if feature["id"]
            in {
                "transport.charge.ohmic.fullmag.v1",
                "transport.spin.steady_drift_diffusion.fullmag.v1",
                "transport.spin.direct_she.fullmag.v1",
                "transport.spin.mixing_conductance.fullmag.v2",
                "coupling.transport_llg.one_way.fullmag.v1",
            }
        }
        self.assertEqual(5, len(lanes))
        for feature in lanes.values():
            self.assertEqual("semantic_only", feature["lanes"]["fdm_gpu_production"])
            self.assertEqual([], feature["validated_workloads"])
        charge = lanes["transport.charge.ohmic.fullmag.v1"]
        self.assertEqual("partial", charge["implementation_state"])
        self.assertEqual("unvalidated", charge["validation_state"])

        sources = {source["id"]: source for source in source_map["sources"]}
        self.assertEqual(
            "DOC-ANCHOR:fdm-gpu-m1-fp64-contract",
            sources["fdm-gpu-m1-contract"]["symbol"],
        )
        self.assertEqual("planned_contract", sources["fdm-gpu-m1-contract"]["evidence_status"])
        self.assertEqual(
            "DOC-ANCHOR:fdm-gpu-m1-abi-v1",
            sources["fdm-gpu-m1-abi-contract"]["symbol"],
        )
        self.assertEqual("planned_contract", sources["fdm-gpu-m1-abi-contract"]["evidence_status"])
        self.assertEqual(
            "actual_device_contract",
            sources["fdm-gpu-m1-charge-solver"]["evidence_status"],
        )
        self.assertEqual(
            "actual_device_contract",
            sources["fdm-gpu-m1-snapshot-test"]["evidence_status"],
        )

    def test_required_semantic_mutations_are_rejected(self) -> None:
        page = _normalise(_gpu_section(PAGE.read_text(encoding="utf-8")))
        self.assertEqual(11, len(PAGE_MUTATIONS))
        for name, (old, new) in PAGE_MUTATIONS.items():
            with self.subTest(name=name):
                self.assertIn(old, page, f"mutation precondition missing for {name}")
                mutated = page.replace(old, new)
                with self.assertRaises(AssertionError):
                    _assert_page_contract(mutated)

    def test_status_promotions_and_nonempty_workloads_are_rejected(self) -> None:
        section = _gpu_section(PAGE.read_text(encoding="utf-8"))
        illegal_mutations = (
            section.replace("semantic_only", "source_visible", 1),
            section + "\n`source_visible`\n",
            section + "\n`production_executable`\n",
            section.replace("implementation_state=partial", "implementation_state=source_visible", 1),
            section.replace("validation_state=unvalidated", "validation_state=validated", 1),
            section.replace("validated_workloads=[]", "validated_workloads=[fdm_gpu_m1_demo]", 1),
        )
        for mutated in illegal_mutations:
            with self.subTest(mutation=mutated[-80:]):
                with self.assertRaises(AssertionError):
                    _assert_honest_gpu_status(mutated)

    def test_note_spec_plan_and_capability_statuses_are_each_fail_closed(self) -> None:
        for owner, section in _status_sections().items():
            illegal_mutations = (
                section + "\nsource_visible\n",
                section + "\nproduction_executable\n",
                section.replace("implementation_state=partial", "implementation_state=executable", 1),
                section.replace("validation_state=unvalidated", "validation_state=validated", 1),
                section.replace("validated_workloads=[]", "validated_workloads=[fdm_gpu_m1_demo]", 1),
            )
            for mutated in illegal_mutations:
                with self.subTest(owner=owner, mutation=mutated[-80:]):
                    with self.assertRaises(AssertionError):
                        _assert_honest_gpu_status(mutated)

    def test_every_qualification_gate_is_required(self) -> None:
        page = PAGE.read_text(encoding="utf-8")
        rows = _qualification_rows(page)
        self.assertEqual(REQUIRED_QUALIFICATION_GATES, set(rows))
        for gate in sorted(REQUIRED_QUALIFICATION_GATES):
            with self.subTest(gate=gate):
                mutated_lines = [
                    line
                    for line in page.splitlines()
                    if not line.startswith(f"| `{gate}` |")
                ]
                with self.assertRaises(AssertionError):
                    _assert_qualification_matrix("\n".join(mutated_lines))

    def test_abi_and_restart_regressions_are_rejected(self) -> None:
        runtime = RUNTIME.read_text(encoding="utf-8")
        section = _anchored_section(runtime, "(fdm-gpu-m1-abi-v1)=", "\n## 14. Capability gates M0–M3")
        self.assertEqual(8, len(ABI_MUTATIONS))
        for name, (old, new) in ABI_MUTATIONS.items():
            with self.subTest(name=name):
                self.assertIn(old, section, f"mutation precondition missing for {name}")
                with self.assertRaises(AssertionError):
                    _assert_abi_contract(section.replace(old, new))

    def test_every_abi_record_has_an_exact_byte_layout_and_feature_mask(self) -> None:
        runtime = RUNTIME.read_text(encoding="utf-8")
        _assert_abi_byte_layout(runtime)
        illegal_mutations = (
            runtime.replace("16:required_features:u64", "24:required_features:u64", 1),
            runtime.replace("COMMON_PREFIX_SIZE=32", "COMMON_PREFIX_SIZE=24", 1),
            runtime.replace("`static_descriptor_v1` | `184`", "`static_descriptor_v1` | `176`", 1),
            runtime.replace("`0x000000000000001c`", "`0x0000000000000000`", 1),
        )
        for mutated in illegal_mutations:
            with self.assertRaises(AssertionError):
                _assert_abi_byte_layout(mutated)

    def test_every_numeric_abi_registry_and_legal_mask_is_exact(self) -> None:
        runtime = RUNTIME.read_text(encoding="utf-8")
        _assert_abi_numeric_registries(runtime)
        for registry, entries in ABI_U32_REGISTRIES.items():
            name, value = next(iter(entries.items()))
            old = f"| `{registry}` | `{name}` | `{value}` |"
            self.assertIn(old, runtime, f"numeric registry row missing for {registry}")
            with self.assertRaises(AssertionError):
                _assert_abi_numeric_registries(runtime.replace(old, f"| `{registry}` | `{name}` | `{value + 1}` |", 1))
        for registry, entries in ABI_U32_FLAG_REGISTRIES.items():
            name, value = next(iter(entries.items()))
            old = f"| `{registry}` | `{name}` | `0x{value:08x}` |"
            self.assertIn(old, runtime, f"numeric flag row missing for {registry}")
            with self.assertRaises(AssertionError):
                _assert_abi_numeric_registries(runtime.replace(old, f"| `{registry}` | `{name}` | `0x80000000` |", 1))
        for registry, mask in ABI_U32_LEGAL_MASKS.items():
            old = f"| `{registry}` | `0x{mask:08x}` |"
            self.assertIn(old, runtime, f"legal mask row missing for {registry}")
            with self.assertRaises(AssertionError):
                _assert_abi_numeric_registries(runtime.replace(old, f"| `{registry}` | `0xffffffff` |", 1))
        with self.assertRaises(AssertionError):
            _assert_abi_numeric_registries(runtime.replace("closed enum unknown u32 values are invalid_descriptor", "unknown enums are ignored", 1))

    def test_checkpoint_golden_payload_has_one_canonical_byte_encoding(self) -> None:
        runtime = RUNTIME.read_text(encoding="utf-8")
        documented = _checkpoint_golden_bytes(runtime)
        expected = _build_checkpoint_golden()
        self.assertEqual(expected, documented)
        _validate_checkpoint_golden(documented)

        restore_documented = _restore_checkpoint_golden_bytes(runtime)
        restore_expected = _build_restore_checkpoint_golden()
        self.assertEqual(restore_expected, restore_documented)
        _validate_checkpoint_golden(restore_documented, require_restore=True)

        truncated = documented[:-1]
        corrupt_section = bytearray(documented)
        first_offset = struct.unpack_from("<Q", documented, 320 + 24)[0]
        first_length = struct.unpack_from("<Q", documented, 320 + 32)[0]
        second_offset = struct.unpack_from("<Q", documented, 320 + 96 + 24)[0]
        corrupt_section[first_offset] ^= 0x01
        unknown_required_section = bytearray(documented)
        struct.pack_into("<I", unknown_required_section, 320, 0xFFFF)
        nonzero_padding = bytearray(documented)
        nonzero_padding[first_offset + first_length] = 1
        wrong_element_tuple = bytearray(documented)
        struct.pack_into("<I", wrong_element_tuple, 320 + 8, 2)
        wrong_element_tuple = _rehash_checkpoint(wrong_element_tuple)
        wrong_record_bytes = bytearray(documented)
        struct.pack_into("<Q", wrong_record_bytes, first_offset + 8, first_length + 8)
        wrong_record_bytes = _rehash_checkpoint(wrong_record_bytes)
        wrong_field_type = bytearray(documented)
        struct.pack_into("<H", wrong_field_type, first_offset + 16 + 2, 3)
        wrong_field_type = _rehash_checkpoint(wrong_field_type)
        wrong_field_id = bytearray(documented)
        struct.pack_into("<H", wrong_field_id, first_offset + 16, 2)
        wrong_field_id = _rehash_checkpoint(wrong_field_id)
        wrong_field_count = bytearray(documented)
        struct.pack_into("<Q", wrong_field_count, first_offset + 16 + 8, 1)
        wrong_field_count = _rehash_checkpoint(wrong_field_count)
        self.assertEqual((6, 1, first_length), struct.unpack_from("<IIQ", documented, 320 + 8))
        self.assertGreater(second_offset, first_offset + first_length)
        for mutated in (truncated, corrupt_section, unknown_required_section, nonzero_padding, wrong_element_tuple, wrong_record_bytes, wrong_field_type, wrong_field_id, wrong_field_count):
            with self.assertRaises(AssertionError):
                _validate_checkpoint_golden(bytes(mutated))

        missing_required = bytearray(restore_documented)
        section_count = struct.unpack_from("<I", missing_required, 24)[0]
        section_nine_index = list(sorted(RESTORE_REQUIRED_CHARGE_SECTIONS)).index(9)
        struct.pack_into("<I", missing_required, 320 + section_nine_index * 96, 99)
        missing_required = _rehash_checkpoint(missing_required)
        self.assertEqual(11, section_count)
        with self.assertRaises(AssertionError):
            _validate_checkpoint_golden(missing_required, require_restore=True)

    def test_checkpoint_decoder_rejects_nonminimal_canonical_padding(self) -> None:
        documented = _checkpoint_golden_bytes(RUNTIME.read_text(encoding="utf-8"))
        mutations = {
            "extra_trailing_64_bytes": _checkpoint_with_extra_trailing_block(documented),
            "extra_subrecord_8_byte_gap": _checkpoint_with_extra_subrecord_gap(documented),
            "extra_intersection_64_byte_gap": _checkpoint_with_extra_intersection_block(documented),
        }
        for name, mutated in mutations.items():
            with self.subTest(name=name):
                with self.assertRaises(AssertionError):
                    _validate_checkpoint_golden(mutated)

    def test_restore_golden_closes_before_digest_import_and_error_sections(self) -> None:
        runtime = RUNTIME.read_text(encoding="utf-8")
        tokens = MarkdownIt("commonmark").parse(runtime)
        fenced_content = "\n".join(
            token.content for token in tokens if token.type == "fence"
        )
        self.assertNotIn("snapshot_content_digest covers", fenced_content)
        self.assertNotIn("Error model and fail-closed combinations", fenced_content)

        headings = [
            tokens[index + 1].content
            for index, token in enumerate(tokens[:-1])
            if token.type == "heading_open"
        ]
        self.assertIn("Error model and fail-closed combinations", headings)

    def test_transfer_audit_and_nonvacuous_fixture_values_are_required(self) -> None:
        page = PAGE.read_text(encoding="utf-8")
        runtime = RUNTIME.read_text(encoding="utf-8")
        _assert_telemetry_and_fixture_closure(page, runtime)
        mutations = (
            ("scientific_continuation_digest", "telemetry_digest"),
            ("failed checkpoint_import_h2d", "discarded failed transfer"),
            ("free component B has no voltage datum", "one voltage datum per component"),
            ("artifact D2H=512 bytes", "artifact bytes are implementation-defined"),
            (f"checkpoint D2H={len(_build_restore_checkpoint_golden())} bytes", "checkpoint bytes are implementation-defined"),
            (f"restore-valid checkpoint SHA-256={hashlib.sha256(_build_restore_checkpoint_golden()).hexdigest()}", "restore checkpoint SHA is unspecified"),
            ("e_n=1/(6n^2)", "decreasing mixing error"),
            ("median total solve <=30 s", "median solve compared with future baseline"),
        )
        for old, new in mutations:
            self.assertIn(old, page + runtime)
            with self.assertRaises(AssertionError):
                _assert_telemetry_and_fixture_closure(page.replace(old, new), runtime.replace(old, new))


class RacetrackM1PhysicsContractDocsTests(unittest.TestCase):
    def test_racetrack_fixture_equations_signs_and_planned_symbols_are_frozen(self) -> None:
        fixture = json.loads(RACETRACK_FIXTURE.read_text(encoding="utf-8"))
        transport_page = PAGE.read_text(encoding="utf-8")
        topological_page = TOPOLOGICAL_PAGE.read_text(encoding="utf-8")
        readme = RACETRACK_README.read_text(encoding="utf-8")
        transport_source_map = json.loads(SOURCE_MAP.read_text(encoding="utf-8"))
        topological_source_map = json.loads(
            TOPOLOGICAL_SOURCE_MAP.read_text(encoding="utf-8")
        )

        self.assertEqual("racetrack_m1_v1", fixture["schema_version"])
        self.assertEqual("synthetic_validation_fixture", fixture["fixture_kind"])
        self.assertFalse(fixture["claims_single_real_material"])
        self.assertEqual(
            {
                "track_axis": "+x",
                "transverse_axis": "+y",
                "stack_axis": "+z",
                "interface_normal_hm_to_fm": "+z",
                "positive_conventional_current": "+x",
            },
            fixture["orientation"],
        )
        self.assertEqual(
            {"racetrack_m1_v1", "she_1d_film_v1", "skyrmion_hall_angle_v1"},
            set(fixture["contract_ids"]),
        )

        expected_values = {
            "track.length": (512e-9, "m"),
            "track.width": (128e-9, "m"),
            "hm.thickness": (3e-9, "m"),
            "fm.thickness": (1e-9, "m"),
            "cell.x": (2e-9, "m"),
            "cell.y": (2e-9, "m"),
            "cell.z": (1e-9, "m"),
            "fm.Ms": (580e3, "A/m"),
            "fm.A": (15e-12, "J/m"),
            "fm.alpha": (0.3, "1"),
            "fm.Ku": (0.8e6, "J/m^3"),
            "fm.D": (3e-3, "J/m^2"),
            "hm.sigma_charge": (5e6, "S/m"),
            "hm.sigma_spin": (5e6, "S/m"),
            "hm.theta_SH": (0.2, "1"),
            "hm.lambda_sf": (1.5e-9, "m"),
            "fm.sigma_charge": (1e6, "S/m"),
            "fm.sigma_spin": (1e6, "S/m"),
            "fm.P": (0.4, "1"),
            "fm.lambda_sf": (5e-9, "m"),
            "fm.lambda_J": (1e-9, "m"),
            "fm.lambda_phi": (1e-9, "m"),
            "interface.G_up": (2.5e14, "S/m^2"),
            "interface.G_down": (2.5e14, "S/m^2"),
            "interface.G_r": (5e14, "S/m^2"),
            "interface.G_i": (5e13, "S/m^2"),
            "drive.J_minus_1_5": (-1.5e12, "A/m^2"),
            "drive.J_minus_1_0": (-1.0e12, "A/m^2"),
            "drive.J_minus_0_5": (-0.5e12, "A/m^2"),
            "drive.J_plus_0_5": (0.5e12, "A/m^2"),
            "drive.J_plus_1_0": (1.0e12, "A/m^2"),
            "drive.J_plus_1_5": (1.5e12, "A/m^2"),
        }
        parameters = {row["id"]: row for row in fixture["parameters"]}
        self.assertEqual(set(expected_values), set(parameters))
        for parameter_id, (value, si_unit) in expected_values.items():
            with self.subTest(parameter_id=parameter_id):
                row = parameters[parameter_id]
                self.assertEqual(value, row["value"])
                self.assertEqual(si_unit, row["si_unit"])
                self.assertEqual("numerical_validation_fixture", row["value_kind"])
                for field in (
                    "symbol",
                    "si_unit",
                    "value",
                    "validity",
                    "problem_ir_path",
                    "motivation",
                ):
                    self.assertIn(field, row)
                    self.assertNotEqual("", row[field])

        for equation_id in (
            "racetrack-charge-continuity",
            "racetrack-direct-she",
            "racetrack-steady-spin-balance",
            "racetrack-mixing-boundary",
            "racetrack-torque-balance",
            "racetrack-gilbert-llg",
        ):
            self.assertIn(f":label: {equation_id}", transport_page)
        for equation_id in (
            "skyrmion-hall-weighted-regression",
            "skyrmion-hall-angle",
        ):
            self.assertIn(f":label: {equation_id}", topological_page)
        for operation in (
            "reverse_J",
            "reverse_theta_SH",
            "reverse_normal",
            "reverse_transverse_axis",
        ):
            self.assertIn(f"| `{operation}` |", transport_page + topological_page)

        planned_symbols = {
            row["symbol"]
            for source_map in (transport_source_map, topological_source_map)
            for row in source_map["planned_symbols"]
        }
        self.assertEqual(
            {
                "ResolvedFdmSpinTransportIR.transport_active_mask",
                "ResolvedSpinTransportPlanIR.fdm_gpu_double",
                "GpuM1TransportSession::prepare",
                "fullmag_fdm_context_bind_gpu_transport_v1",
                "TransportStageCheckpointV1",
                "execution_provenance.transport_m1_v1",
                "SkyrmionTrajectoryV1",
                "SkyrmionHallAngleV1",
            },
            planned_symbols,
        )
        for source_map in (transport_source_map, topological_source_map):
            for row in source_map["planned_symbols"]:
                self.assertEqual("planned_not_implemented", row["status"])
                for field in ("path", "symbol", "owner_task", "evidence_gate"):
                    self.assertTrue(row[field])

        planned_by_owner_and_symbol = {
            (row["owner_task"], row["symbol"]): row["path"]
            for source_map in (transport_source_map, topological_source_map)
            for row in source_map["planned_symbols"]
        }
        self.assertEqual(
            {
                (
                    "Task 2",
                    "ResolvedFdmSpinTransportIR.transport_active_mask",
                ): "crates/fullmag-ir/src/spin_transport.rs",
                (
                    "Task 3",
                    "ResolvedSpinTransportPlanIR.fdm_gpu_double",
                ): "crates/fullmag-plan/src/spin_transport.rs",
                (
                    "Task 4",
                    "GpuM1TransportSession::prepare",
                ): "crates/fullmag-runner/src/fdm/gpu/cuda/spin_transport.rs",
                (
                    "Task 5",
                    "fullmag_fdm_context_bind_gpu_transport_v1",
                ): "native/include/fullmag_fdm.h",
                (
                    "Task 6",
                    "TransportStageCheckpointV1",
                ): "crates/fullmag-runner/src/fdm/gpu/cuda/spin_transport.rs",
                (
                    "Task 7",
                    "execution_provenance.transport_m1_v1",
                ): "crates/fullmag-runner/src/artifacts.rs",
                (
                    "Task 8",
                    "SkyrmionTrajectoryV1",
                ): "crates/fullmag-api/src/analysis/skyrmion_trajectory.rs",
                (
                    "Task 8",
                    "SkyrmionHallAngleV1",
                ): "crates/fullmag-api/src/analysis/skyrmion_trajectory.rs",
            },
            planned_by_owner_and_symbol,
        )
        plan = RACETRACK_PLAN.read_text(encoding="utf-8")
        for (owner_task, symbol), path in planned_by_owner_and_symbol.items():
            with self.subTest(owner_task=owner_task, symbol=symbol):
                owner_start = plan.index(f"### {owner_task}:")
                next_task = plan.find("\n### Task ", owner_start + 1)
                owner_section = plan[owner_start : next_task if next_task >= 0 else None]
                self.assertIn(path, plan)
                for symbol_token in re.split(r"\.|::", symbol):
                    self.assertIn(symbol_token, owner_section)
                self.assertTrue(
                    (ROOT / path).exists() or f"Create: `{path}`" in plan,
                    f"planned path {path} must exist or be declared Create in the plan",
                )

        for required in (
            "racetrack_m1_v1",
            "syntetyczny fixture walidacyjny",
            "nie reprezentuje jednego rzeczywistego materiału",
            "skyrmion_hall_angle_v1",
        ):
            self.assertIn(required, transport_page + topological_page + readme)

    def test_racetrack_fixture_freezes_one_complete_normalized_problem(self) -> None:
        fixture = json.loads(RACETRACK_FIXTURE.read_text(encoding="utf-8"))

        self.assertEqual(
            {
                "discretization": "fdm",
                "device": "gpu",
                "precision": "double",
                "execution_mode": "strict",
            },
            fixture["execution_intent"]["requested_tuple"],
        )
        self.assertEqual(
            [
                "cpu",
                "single",
                "prescribed_torque",
                "prescribed_current_density",
                "oersted",
                "inverse_spin_hall_effect",
                "reciprocal_m2",
                "transient_m3",
                "mtj",
                "periodic_boundaries",
                "thermal_noise",
                "multi_gpu",
            ],
            fixture["execution_intent"]["forbidden_fallbacks"],
        )
        self.assertEqual(
            {
                "counts": [256, 64, 4],
                "cell_size_m": [2e-9, 2e-9, 1e-9],
                "extent_m": [512e-9, 128e-9, 4e-9],
                "origin_m": [0.0, 0.0, 0.0],
                "cell_order": "x_fastest_then_y_then_z",
            },
            fixture["structured_grid"],
        )
        self.assertEqual(
            {
                "hm": {
                    "object_id": "hm",
                    "origin_m": [0.0, 0.0, 0.0],
                    "size_m": [512e-9, 128e-9, 3e-9],
                    "cell_bounds": {"x": [0, 256], "y": [0, 64], "z": [0, 3]},
                },
                "fm": {
                    "object_id": "fm",
                    "origin_m": [0.0, 0.0, 3e-9],
                    "size_m": [512e-9, 128e-9, 1e-9],
                    "cell_bounds": {"x": [0, 256], "y": [0, 64], "z": [3, 4]},
                },
                "interface_z_m": 3e-9,
                "overlap_rule": "disjoint_half_open_cell_bounds_with_one_shared_geometric_face",
            },
            fixture["layer_placement"],
        )

        charge = fixture["charge_boundary_contract"]
        self.assertEqual("zero_mean", charge["gauge"])
        self.assertEqual("every_external_surface_exactly_once", charge["coverage_rule"])
        boundaries = {row["id"]: row for row in charge["boundaries"]}
        self.assertEqual(
            {"terminal_x_minus", "terminal_x_plus", "insulating_outer"},
            set(boundaries),
        )
        self.assertEqual(-1.0, boundaries["terminal_x_minus"]["current_multiplier"])
        self.assertEqual(1.0, boundaries["terminal_x_plus"]["current_multiplier"])
        self.assertEqual(
            [
                {"object_id": "hm", "surface_id": "x-", "orientation": [-1.0, 0.0, 0.0]},
                {"object_id": "fm", "surface_id": "x-", "orientation": [-1.0, 0.0, 0.0]},
            ],
            boundaries["terminal_x_minus"]["surfaces"],
        )
        self.assertEqual(
            [
                {"object_id": "hm", "surface_id": "x+", "orientation": [1.0, 0.0, 0.0]},
                {"object_id": "fm", "surface_id": "x+", "orientation": [1.0, 0.0, 0.0]},
            ],
            boundaries["terminal_x_plus"]["surfaces"],
        )
        insulating_surfaces = [
            {"object_id": "hm", "surface_id": "y-", "orientation": [0.0, -1.0, 0.0]},
            {"object_id": "hm", "surface_id": "y+", "orientation": [0.0, 1.0, 0.0]},
            {"object_id": "hm", "surface_id": "z-", "orientation": [0.0, 0.0, -1.0]},
            {"object_id": "fm", "surface_id": "y-", "orientation": [0.0, -1.0, 0.0]},
            {"object_id": "fm", "surface_id": "y+", "orientation": [0.0, 1.0, 0.0]},
            {"object_id": "fm", "surface_id": "z+", "orientation": [0.0, 0.0, 1.0]},
        ]
        self.assertEqual(insulating_surfaces, boundaries["insulating_outer"]["surfaces"])
        self.assertEqual(
            {
                "id": "spin_insulating_outer",
                "kind": "spin_insulating",
                "coverage_rule": "every_external_surface_exactly_once",
                "surfaces": [
                    {"object_id": "hm", "surface_id": "x-", "orientation": [-1.0, 0.0, 0.0]},
                    {"object_id": "hm", "surface_id": "x+", "orientation": [1.0, 0.0, 0.0]},
                    *insulating_surfaces[:3],
                    {"object_id": "fm", "surface_id": "x-", "orientation": [-1.0, 0.0, 0.0]},
                    {"object_id": "fm", "surface_id": "x+", "orientation": [1.0, 0.0, 0.0]},
                    *insulating_surfaces[3:],
                ],
            },
            fixture["spin_boundary_contract"],
        )

        self.assertEqual(
            {
                "id": "hm_fm",
                "kind": "mixing_conductance",
                "normal_side": {"object_id": "hm"},
                "ferromagnet_side": {"object_id": "fm"},
                "normal_to_ferromagnet": [0.0, 0.0, 1.0],
                "normal_surface": {
                    "object_id": "hm",
                    "surface_id": "z+",
                    "orientation": [0.0, 0.0, 1.0],
                },
                "ferromagnet_surface": {
                    "object_id": "fm",
                    "surface_id": "z-",
                    "orientation": [0.0, 0.0, -1.0],
                },
                "interface_z_m": 3e-9,
            },
            fixture["interface_contract"],
        )

        masks = fixture["mask_contract"]
        self.assertEqual([256, 64, 4], masks["shape"])
        self.assertEqual("x_fastest_then_y_then_z", masks["cell_order"])
        self.assertEqual(65_536, masks["transport_active"]["active_cell_count"])
        self.assertEqual([0, 4], masks["transport_active"]["cell_bounds"]["z"])
        for mask_id in ("magnetic_active", "torque_target"):
            self.assertEqual(16_384, masks[mask_id]["active_cell_count"])
            self.assertEqual([3, 4], masks[mask_id]["cell_bounds"]["z"])
        self.assertEqual(
            "torque_target subset magnetic_active subset transport_active",
            masks["subset_invariant"],
        )

        stages = fixture["stage_contract"]
        self.assertEqual(
            {
                "order": 0,
                "id": "relax_zero_current",
                "kind": "relax",
                "transport_module_present": True,
                "current_density_Apm2": 0.0,
                "transport_torque_enabled": False,
                "output_checkpoint": "relaxed_zero_current",
            },
            stages[0],
        )
        self.assertEqual(1, stages[1]["order"])
        self.assertEqual("drive_solved_current", stages[1]["id"])
        self.assertEqual("independent_fixed_step_runs", stages[1]["kind"])
        self.assertTrue(stages[1]["transport_module_present"])
        self.assertTrue(stages[1]["transport_torque_enabled"])
        self.assertEqual("relaxed_zero_current", stages[1]["restart_from"])
        self.assertEqual(
            [
                "drive.J_minus_1_5",
                "drive.J_minus_1_0",
                "drive.J_minus_0_5",
                "drive.J_plus_0_5",
                "drive.J_plus_1_0",
                "drive.J_plus_1_5",
            ],
            [case["parameter_id"] for case in fixture["current_schedule"]["drive_cases"]],
        )
        schedule = fixture["current_schedule"]
        self.assertEqual("racetrack_current_schedule.v1", schedule["schema_version"])
        self.assertEqual("relax_zero_current", schedule["preparation_stage"])
        self.assertEqual("relaxed_zero_current", schedule["relaxed_checkpoint"])
        self.assertTrue(schedule["reset_to_relaxed_checkpoint_before_each_case"])
        self.assertEqual("every_llg_rhs_evaluation", schedule["transport_update"])
        for order, case in enumerate(schedule["drive_cases"]):
            self.assertEqual(order, case["order"])
            self.assertEqual(-case["current_density_Apm2"], case["terminal_outward_Apm2"]["terminal_x_minus"])
            self.assertEqual(case["current_density_Apm2"], case["terminal_outward_Apm2"]["terminal_x_plus"])
            self.assertEqual(2e-9, case["duration_s"])
            self.assertEqual(1e-13, case["fixed_time_step_s"])
            self.assertEqual(5e-12, case["sample_interval_s"])

        normalized = fixture["normalized_problem_ir_contract"]
        self.assertEqual(["fm", "hm"], normalized["geometry_entry_order"])
        self.assertEqual(
            [
                "geometry.entries[0].base.size[0] == geometry.entries[1].base.size[0]",
                "geometry.entries[0].base.size[1] == geometry.entries[1].base.size[1]",
            ],
            normalized["geometry_equalities"],
        )
        self.assertEqual(["charge"], normalized["current_module_order"])
        self.assertEqual(["spin"], normalized["spin_transport_module_order"])
        self.assertEqual(["transport_torque"], normalized["spin_torque_module_order"])
        self.assertEqual(
            {
                "hm": {"object_id": "hm"},
                "fm": {"object_id": "fm"},
                "transport_domain": [{"object_id": "hm"}, {"object_id": "fm"}],
                "magnetic_domain": [{"object_id": "fm"}],
                "torque_target": {"object_id": "fm"},
            },
            normalized["region_refs"],
        )
        self.assertEqual(
            "expected_lowering arrays and top-level fixture boundary, mask, and stage arrays are ordered; no field may be backend-defaulted; workflow-only fields are not ProblemIR",
            normalized["canonicalization_rule"],
        )

    def test_racetrack_expected_lowering_matches_public_python_dsl(self) -> None:
        fixture = json.loads(RACETRACK_FIXTURE.read_text(encoding="utf-8"))
        normalized = fixture["normalized_problem_ir_contract"]

        self.assertEqual("typed_expected_lowering_map", normalized["contract_kind"])
        self.assertEqual(
            _racetrack_public_lowering(),
            normalized["expected_lowering"],
        )
        self.assertEqual(
            {
                "status": "not_publicly_lowerable_as_one_problem",
                "missing_capabilities": [
                    "per_stage_current_boundary_mutation",
                    "restart_each_drive_from_named_checkpoint",
                ],
                "rule": "typed records are current ProblemIR; the six-case restart schedule remains an external fixture workflow until both stage capabilities exist",
            },
            normalized["public_lowering_boundary"],
        )

        expected_lowering = normalized["expected_lowering"]
        self.assertEqual("translate", expected_lowering["geometry"]["entries"][0]["kind"])
        self.assertEqual("box", expected_lowering["geometry"]["entries"][0]["base"]["kind"])
        self.assertEqual("translate", expected_lowering["geometry"]["entries"][1]["kind"])
        self.assertEqual("box", expected_lowering["geometry"]["entries"][1]["base"]["kind"])
        self.assertEqual(
            [256.0e-9, 64.0e-9, 3.5e-9],
            expected_lowering["geometry"]["entries"][0]["by"],
        )
        self.assertEqual(
            [256.0e-9, 64.0e-9, 1.5e-9],
            expected_lowering["geometry"]["entries"][1]["by"],
        )
        self.assertEqual("fm_material", expected_lowering["materials"][0]["name"])

        parameters = {row["id"]: row for row in fixture["parameters"]}
        expected_paths = {
            "track.length": "geometry.entries[1].base.size[0]",
            "track.width": "geometry.entries[1].base.size[1]",
            "hm.thickness": "geometry.entries[1].base.size[2]",
            "fm.thickness": "geometry.entries[0].base.size[2]",
            "fm.Ms": "materials[0].saturation_magnetisation",
            "fm.A": "materials[0].exchange_stiffness",
            "fm.alpha": "materials[0].damping",
            "fm.Ku": "materials[0].uniaxial_anisotropy",
        }
        for parameter_id, expected_path in expected_paths.items():
            self.assertEqual(expected_path, parameters[parameter_id]["problem_ir_path"])
        for parameter_id, parameter in parameters.items():
            with self.subTest(parameter_id=parameter_id):
                resolved = _resolve_problem_ir_path(
                    expected_lowering,
                    parameter["problem_ir_path"],
                )
                if not parameter_id.startswith("drive."):
                    self.assertEqual(parameter["value"], resolved)

        charge = expected_lowering["current_modules"][0]
        self.assertEqual("current_transport", charge["kind"])
        self.assertEqual("ohmic_poisson", charge["model"])
        self.assertEqual("one_way", charge["coupling"])
        self.assertEqual("charge_balance_integrated_l2.v1", charge["solver"]["physical_residual_version"])
        self.assertEqual("fv_charge_harmonic_v1", charge["solver"]["operator_version"])

        spin = expected_lowering["spin_transport_modules"][0]
        self.assertEqual("charge", spin["current_source_id"])
        self.assertEqual("steady", spin["mode"])
        self.assertEqual("transport_constitutive.one_way.fullmag.v1", spin["constitutive_version"])
        self.assertEqual(
            {
                "discretization": "fdm",
                "device": "gpu",
                "precision": "double",
                "execution_mode": "strict",
            },
            spin["requested_execution"],
        )
        self.assertEqual(
            {
                "kind": "drift_diffusion_spin_torque",
                "schema_version": "drift_diffusion_spin_torque.v1",
                "id": "transport_torque",
                "solve_id": "spin",
                "target": {"object_id": "fm"},
                "formula_version": "transport_torque_angular_momentum.fullmag.v1",
            },
            expected_lowering["spin_torque_modules"][0],
        )
        self.assertEqual(
            ["exchange", "demag", "interfacial_dmi"],
            [term["kind"] for term in expected_lowering["energy_terms"]],
        )
        self.assertEqual(
            "rk4",
            expected_lowering["study"]["dynamics"]["integrator"],
        )
        self.assertEqual(
            {"execution_mode": "strict"},
            expected_lowering["validation_profile"],
        )
        self.assertEqual(
            {
                "backend": "fdm",
                "device": "gpu",
                "gpu_count": 1,
                "device_index": 0,
                "cpu_threads": None,
                "execution_mode": "strict",
                "execution_precision": "double",
            },
            expected_lowering["problem_meta"]["runtime_metadata"]["runtime_selection"],
        )

    def test_racetrack_schedule_targets_existing_problem_ir_fields(self) -> None:
        fixture = json.loads(RACETRACK_FIXTURE.read_text(encoding="utf-8"))
        schedule = fixture["current_schedule"]

        for index, case in enumerate(schedule["drive_cases"], start=1):
            self.assertEqual(index, case["stage_index"])
            self.assertEqual("flat_run", case["entrypoint_kind"])
            self.assertEqual(
                {
                    "current_modules[0].boundaries[0].outward_current_density_Apm2": (
                        -case["current_density_Apm2"]
                    ),
                    "current_modules[0].boundaries[1].outward_current_density_Apm2": case[
                        "current_density_Apm2"
                    ],
                },
                case["problem_ir_overrides"],
            )
            self.assertNotIn("current_sweep", json.dumps(case))
        for parameter in fixture["parameters"]:
            path = parameter["problem_ir_path"]
            self.assertNotIn("current_sweep", path)
            self.assertNotIn("[charge]", path)
            self.assertNotIn("[spin]", path)
            self.assertNotIn("[hm_fm]", path)

    def test_racetrack_equation_blocks_freeze_exact_signs_and_index_order(self) -> None:
        page = PAGE.read_text(encoding="utf-8")
        charge = _anchored_section(
            page, ":label: racetrack-charge-continuity", "```\n\nDirect SHE"
        )
        direct_she = _anchored_section(
            page, ":label: racetrack-direct-she", "```\n\nSteady M1"
        )
        steady = _anchored_section(
            page, ":label: racetrack-steady-spin-balance", "```\n\nDla skoku"
        )
        mixing = _anchored_section(
            page, ":label: racetrack-mixing-boundary", "```\n\nMoment pędu"
        )
        torque = _anchored_section(
            page, ":label: racetrack-torque-balance", "```\n\n`T_tr,G`"
        )
        gilbert = _anchored_section(
            page, ":label: racetrack-gilbert-llg", "```\n\n#### 2.9.2"
        )

        self.assertIn(r"\nabla\!\cdot\mathbf J_c=0", charge)
        self.assertIn(r"\mathbf J_c=\sigma\mathbf E=-\sigma\nabla V", charge)
        self.assertIn(r"Q^{\mathrm{SHE}}_{ia}", direct_she)
        self.assertIn(r"\theta_{\mathrm{SH}}\epsilon_{ika}J_{c,k}", direct_she)
        self.assertIn(r"J_{c,x}>0,\ \theta_{\mathrm{SH}}>0", direct_she)
        self.assertIn(r"Q^{\mathrm{SHE}}_{zy}>0", direct_she)
        self.assertIn(r"$n=+e_z$", page)
        for fragment in (
            r"\partial_iQ_{ia}&=-R_{\mathrm{sf},a}-R_{J,a}-R_{\phi,a}",
            r"R_{\mathrm{sf}}&=\frac{\sigma_s}{2\lambda_{\mathrm{sf}}^2}\mu_s",
            r"R_J&=\frac{\sigma_s}{2\lambda_J^2}(\mu_s\times m)",
            r"R_\phi&=\frac{\sigma_s}{2\lambda_\phi^2}m\times(\mu_s\times m)",
        ):
            self.assertIn(fragment, steady)
        self.assertIn(r"\Delta\mu_s=\mu_{s,HM}-\mu_{s,FM}", page)
        self.assertIn(r"\Delta V_\Gamma=V_{HM}-V_{FM}", page)
        for fragment in (
            r"j_{c,n}&=(G_\uparrow+G_\downarrow)\Delta V_\Gamma",
            r"(G_\uparrow-G_\downarrow)\Delta V_\Gamma",
            r"G_r m\times(\Delta\mu_s\times m)",
            r"+G_i(\Delta\mu_s\times m)",
        ):
            self.assertIn(fragment, mixing)
        self.assertIn(r"T_{\mathrm{tr},G,K}=-\frac{\gamma_e}{M_{s,K}}\frac{\hbar}{2e}", torque)
        self.assertIn(r"R_{J,K}+R_{\phi,K}", torque)
        self.assertNotIn(r"R_{\mathrm{sf},K}", torque)
        self.assertIn(r"(1+\alpha^2)\partial_t m=", gilbert)
        self.assertIn(r"-\gamma_e\left[m\times B_{\mathrm{eff}}", gilbert)
        self.assertIn(r"+T_{\mathrm{tr},G}+\alpha m\times T_{\mathrm{tr},G}", gilbert)

    def test_new_symbol_table_rows_wrap_latex_and_si_units_in_math(self) -> None:
        pages_and_rows = (
            (
                PAGE.read_text(encoding="utf-8"),
                ("m", "alpha", "B_eff", "T_P", "T_SHE"),
            ),
            (
                TOPOLOGICAL_PAGE.read_text(encoding="utf-8"),
                ("$t_n$", "$v_x$", "$\\Theta_H$", "$S_{tt}$"),
            ),
        )
        for page, row_ids in pages_and_rows:
            for row_id in row_ids:
                with self.subTest(row_id=row_id):
                    row = next(
                        line for line in page.splitlines() if line.startswith(f"| {row_id} |")
                    )
                    cells = [cell.strip() for cell in row.strip().strip("|").split("|")]
                    self.assertTrue(cells[1].startswith("$") and cells[1].endswith("$"))
                    self.assertTrue(cells[3].startswith("$") and cells[3].endswith("$"))

    def test_theta_sh_reversal_separates_polarized_and_pure_she_responses(self) -> None:
        fixture = json.loads(RACETRACK_FIXTURE.read_text(encoding="utf-8"))
        page = PAGE.read_text(encoding="utf-8")
        oracle = fixture["sign_contract"]["reverse_theta_sh"]

        self.assertEqual(0.4, oracle["production_fixture_polarization"])
        self.assertEqual(
            "T(+theta_SH)=T_P+T_SHE; T(-theta_SH)=T_P-T_SHE",
            oracle["torque_decomposition"],
        )
        self.assertEqual({"fm.P": 0.0}, oracle["pure_she_oracle"]["parameter_overrides"])
        self.assertEqual(
            ["mu_s", "Q_spin", "T_tr_G"],
            oracle["pure_she_oracle"]["exactly_odd_observables"],
        )
        self.assertEqual(
            "no exact oddness claim for nonlinear trajectory velocity",
            oracle["pure_she_oracle"]["velocity_semantics"],
        )
        for fragment in (
            r"T(+\theta_{\mathrm{SH}})=T_P+T_{\mathrm{SHE}}",
            r"T(-\theta_{\mathrm{SH}})=T_P-T_{\mathrm{SHE}}",
            r"P=0",
            "nie jest ogólnie odd",
            "no exact oddness claim for nonlinear trajectory velocity",
        ):
            self.assertIn(fragment, page)
        reverse_row = next(
            line for line in page.splitlines() if line.startswith("| `reverse_theta_SH` |")
        )
        self.assertIn(r"$T_P+T_{\mathrm{SHE}}\to T_P-T_{\mathrm{SHE}}$", reverse_row)
        self.assertNotIn("$(-v_x,-v_y)$", reverse_row)

    def test_skyrmion_hall_angle_v1_is_fully_deterministic(self) -> None:
        fixture = json.loads(RACETRACK_FIXTURE.read_text(encoding="utf-8"))
        page = TOPOLOGICAL_PAGE.read_text(encoding="utf-8")
        contract = fixture["analysis_contract"]

        self.assertEqual("skyrmion_hall_angle_v1", contract["algorithm_version"])
        self.assertEqual("signed_topological_density_first_moment", contract["centre"]["method"])
        self.assertEqual(0.5, contract["centre"]["minimum_abs_charge"])
        windows = contract["candidate_windows"]
        self.assertEqual("all_contiguous_intervals", windows["enumeration"])
        self.assertEqual(21, windows["minimum_samples"])
        self.assertEqual(1e-10, windows["minimum_duration_s"])
        self.assertEqual(0.05, windows["maximum_relative_charge_deviation"])
        self.assertEqual(16e-9, windows["minimum_edge_distance_m"])
        self.assertEqual(1.0, windows["minimum_mean_speed_mps"])
        self.assertEqual(4e-9, windows["minimum_net_displacement_m"])
        self.assertEqual(0.10, windows["maximum_speed_coefficient_of_variation"])
        self.assertEqual(
            ["maximum_duration", "minimum_start_index", "minimum_end_index"],
            windows["selection_tie_break"],
        )
        regression = contract["regression"]
        self.assertEqual(1e-18, regression["position_variance_floor_m2"])
        self.assertEqual(
            "1/max(sigma_x_m2+sigma_y_m2,position_variance_floor_m2)",
            regression["common_weight"],
        )
        self.assertEqual("N-2", regression["residual_degrees_of_freedom"])
        self.assertEqual(
            [
                "topology_lost",
                "edge_contaminated",
                "insufficient_samples",
                "no_motion",
                "no_stationary_window",
            ],
            contract["reason_code_precedence"],
        )
        for equation_id in (
            "skyrmion-signed-density-centre",
            "skyrmion-candidate-speed-statistics",
            "skyrmion-hall-weighted-regression",
            "skyrmion-hall-weighted-covariance",
            "skyrmion-hall-angle",
            "skyrmion-hall-angle-variance",
        ):
            self.assertIn(f":label: {equation_id}", page)
        for fragment in (
            r"\Delta Q_{n,k}=\frac{\Omega_{n,k}}{4\pi}",
            r"\mathbf r_n=\frac{\sum_k\Delta Q_{n,k}\mathbf c_{n,k}}{Q_n}",
            r"c_v=\frac{\sqrt{\frac{1}{N-1}\sum_{k=i}^{j-1}(s_k-\bar s)^2}}{\max(\bar s,1\,\mathrm{m\,s^{-1}})}",
            r"\chi_{ab}=\frac{1}{N-2}\sum_nw_nr_{a,n}r_{b,n}",
            r"\operatorname{Cov}(v_a,v_b)=\frac{\chi_{ab}}{S_{tt}}",
        ):
            self.assertIn(fragment, page)
        self.assertIn(
            "`topology_lost` → `edge_contaminated` → `insufficient_samples` → "
            "`no_motion` → `no_stationary_window`",
            page,
        )

    def test_topological_source_map_covers_equations_and_numerical_claims(self) -> None:
        source_map = json.loads(TOPOLOGICAL_SOURCE_MAP.read_text(encoding="utf-8"))
        equations = {row["id"]: row for row in source_map["equations"]}
        self.assertEqual(
            {
                "topological-support-frame",
                "topological-normalized-magnetization",
                "topological-charge-density",
                "topological-charge-integral",
                "topological-solid-angle",
                "topological-discrete-charge",
                "fdm-thickness-weighted-charge",
                "fem-midpoint-thickness-average",
                "skyrmion-signed-density-centre",
                "skyrmion-candidate-speed-statistics",
                "skyrmion-hall-weighted-regression",
                "skyrmion-hall-weighted-covariance",
                "skyrmion-hall-angle",
                "skyrmion-hall-angle-variance",
                "belavin-polyakov-texture",
            },
            set(equations),
        )
        self.assertEqual(["topological-charge-kernel"], equations["topological-solid-angle"]["sources"])
        self.assertEqual(["topological-fdm-weighting"], equations["fdm-thickness-weighted-charge"]["sources"])
        self.assertEqual(["topological-fem-weighting"], equations["fem-midpoint-thickness-average"]["sources"])
        for equation_id in (
            "skyrmion-signed-density-centre",
            "skyrmion-candidate-speed-statistics",
            "skyrmion-hall-weighted-regression",
            "skyrmion-hall-weighted-covariance",
            "skyrmion-hall-angle",
            "skyrmion-hall-angle-variance",
        ):
            self.assertEqual(["skyrmion-hall-contract"], equations[equation_id]["sources"])

        claims = {row["id"]: row for row in source_map["claims"]}
        self.assertEqual(
            {
                "scaled-vector-normalization",
                "exceptional-triangle-thresholds",
                "under-resolution-threshold",
                "support-topology-qualification",
                "boundary-uniformity-threshold",
                "fdm-cell-thickness-weighting",
                "fem-auto-profile-count",
            },
            set(claims),
        )
        source_ids = {row["id"] for row in source_map["sources"]}
        for claim in claims.values():
            self.assertTrue(claim["sources"])
            self.assertTrue(set(claim["sources"]).issubset(source_ids))
            self.assertIn(claim["evidence_status"], {"source_and_tests", "planned_contract"})
        sources = {row["id"]: row for row in source_map["sources"]}
        self.assertEqual("compute_oriented_charge", sources["topological-charge-kernel"]["symbol"])
        self.assertEqual("fem_midpoint_weights", sources["topological-fem-weighting"]["symbol"])
        self.assertEqual(
            "resolved_profile_sample_count",
            sources["topological-profile-sampling"]["symbol"],
        )
        self.assertEqual("planned_contract", sources["skyrmion-hall-contract"]["evidence_status"])

    def test_new_topological_tables_use_myst_inline_math(self) -> None:
        page = TOPOLOGICAL_PAGE.read_text(encoding="utf-8")
        for row in (
            r"| $t_n$ | $t_n$ | accepted trajectory time sample | $\mathrm{s}$ |",
            r"| $w_n$ | $w_n$ | inverse position-variance regression weight | $\mathrm{m^{-2}}$ |",
            r"| $\Theta_H$ | $\Theta_H$ | signed skyrmion Hall angle in the reported frame | $\mathrm{rad}$ |",
            r"| $\sigma_{r,n}^2$ | $\sigma_{r,n}^2$ | summed centre-coordinate variance before flooring | $\mathrm{m^2}$ |",
        ):
            self.assertIn(row, page)
        self.assertNotIn("| t_n | t_n | accepted trajectory time sample | \\mathrm{s} |", page)


if __name__ == "__main__":
    unittest.main()
