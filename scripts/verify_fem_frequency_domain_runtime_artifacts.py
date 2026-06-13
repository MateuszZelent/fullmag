#!/usr/bin/env python3
"""Validate FEM frequency-domain runtime smoke artifacts."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

MAX_U64 = (1 << 64) - 1


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def require_string_list(value: object, name: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise SystemExit(f"invalid frequency-domain runtime artifacts:\n{name} must be a string list")
    return value


def require_object_list(value: object, name: str) -> list[dict]:
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise SystemExit(f"invalid frequency-domain runtime artifacts:\n{name} must be an object list")
    return value


def require_equal(actual: object, expected: object, name: str) -> None:
    if actual != expected:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{name}: got {actual!r}, expected {expected!r}"
        )


def require_expected(expected: dict[str, tuple[object, object]]) -> None:
    mismatches = [
        f"{name}: got {actual!r}, expected {expected_value!r}"
        for name, (actual, expected_value) in expected.items()
        if actual != expected_value
    ]
    if mismatches:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n" + "\n".join(mismatches)
        )


def require_non_empty_string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{name} must be a non-empty string"
        )
    return value


def manifest_completed_frequency_point_count(manifest: dict) -> object:
    diagnostics = manifest.get("diagnostics", {})
    if not isinstance(diagnostics, dict):
        return None
    canonical = diagnostics.get("completed_frequency_point_count")
    if canonical is not None:
        return canonical
    return diagnostics.get("completed_frequency_count")


def require_excitation_provenance(point: dict, point_name: str) -> None:
    provenance = point.get("excitation_provenance")
    if not isinstance(provenance, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{point_name}.excitation_provenance must be an object"
        )
    require_equal(provenance.get("kind"), "field", f"{point_name}.excitation_provenance.kind")
    phase_rad = provenance.get("phase_rad")
    if not isinstance(phase_rad, (int, float)) or not math.isfinite(float(phase_rad)):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{point_name}.excitation_provenance.phase_rad must be a finite number"
        )


def require_sweep_reuse(point: dict, point_name: str) -> None:
    sweep_reuse = point.get("sweep_reuse")
    if not isinstance(sweep_reuse, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{point_name}.sweep_reuse must be an object"
        )
    require_equal(
        sweep_reuse.get("operator_template_reused"),
        True,
        f"{point_name}.sweep_reuse.operator_template_reused",
    )
    warm_start = sweep_reuse.get("warm_start")
    if warm_start is None:
        return
    if not isinstance(warm_start, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{point_name}.sweep_reuse.warm_start must be null or an object"
        )
    require_equal(
        warm_start.get("kind"),
        "previous_frequency_response",
        f"{point_name}.sweep_reuse.warm_start.kind",
    )
    require_finite_number(
        warm_start.get("source_frequency_rad_per_s"),
        f"{point_name}.sweep_reuse.warm_start.source_frequency_rad_per_s",
    )


def require_finite_number(value: object, name: str) -> None:
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{name} must be a finite number"
        )


def require_finite_number_list(value: object, name: str) -> list[object]:
    if not isinstance(value, list) or not value:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{name} must be a non-empty finite number list"
        )
    for index, item in enumerate(value):
        require_finite_number(item, f"{name}[{index}]")
    return value


def require_complex_pair_list(value: object, name: str) -> None:
    if not isinstance(value, list) or not value:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{name} must be a non-empty list of [re, im] pairs"
        )
    for pair_index, pair in enumerate(value):
        if not isinstance(pair, list) or len(pair) != 2:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"{name}[{pair_index}] must be a [re, im] pair"
            )
        require_finite_number(pair[0], f"{name}[{pair_index}][0]")
        require_finite_number(pair[1], f"{name}[{pair_index}][1]")


def require_response_series(point: dict, point_name: str) -> None:
    require_finite_number(
        point.get("angular_frequency_rad_per_s"),
        f"{point_name}.angular_frequency_rad_per_s",
    )
    require_complex_pair_list(point.get("m_complex"), f"{point_name}.m_complex")
    component_amplitude = require_finite_number_list(
        point.get("component_response_amplitude"),
        f"{point_name}.component_response_amplitude",
    )
    component_phase = require_finite_number_list(
        point.get("component_response_phase"),
        f"{point_name}.component_response_phase",
    )
    m_complex = point.get("m_complex")
    if (
        isinstance(m_complex, list)
        and (len(component_amplitude) != len(m_complex) or len(component_phase) != len(m_complex))
    ):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{point_name}.component_response_amplitude/phase length must match m_complex"
        )
    require_finite_number(point.get("response_amplitude"), f"{point_name}.response_amplitude")
    require_finite_number(point.get("response_phase"), f"{point_name}.response_phase")
    require_finite_number(point.get("phase_rad"), f"{point_name}.phase_rad")
    require_finite_number(point.get("residual_l2_norm"), f"{point_name}.residual_l2_norm")
    require_finite_number(
        point.get("relative_residual_l2_norm"),
        f"{point_name}.relative_residual_l2_norm",
    )
    require_non_empty_string(point.get("residual_source"), f"{point_name}.residual_source")


def require_response_observables(point: dict, point_name: str) -> None:
    require_complex_pair_list(point.get("susceptibility_tensor"), f"{point_name}.susceptibility_tensor")
    provenance = point.get("susceptibility_tensor_provenance")
    if not isinstance(provenance, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{point_name}.susceptibility_tensor_provenance must be an object"
        )
    require_non_empty_string(provenance.get("kind"), f"{point_name}.susceptibility_tensor_provenance.kind")
    require_equal(
        provenance.get("full_tensor"),
        False,
        f"{point_name}.susceptibility_tensor_provenance.full_tensor",
    )
    absorbed_provenance = point.get("absorbed_power_density_provenance")
    if not isinstance(absorbed_provenance, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{point_name}.absorbed_power_density_provenance must be an object"
        )
    require_non_empty_string(absorbed_provenance.get("kind"), f"{point_name}.absorbed_power_density_provenance.kind")
    tangent_leakage = point.get("tangent_leakage")
    if not isinstance(tangent_leakage, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{point_name}.tangent_leakage must be an object"
        )
    require_equal(tangent_leakage.get("status"), "evaluated", f"{point_name}.tangent_leakage.status")
    require_finite_number(
        tangent_leakage.get("mean_abs_m0_dot_delta_m"),
        f"{point_name}.tangent_leakage.mean_abs_m0_dot_delta_m",
    )
    require_finite_number(
        tangent_leakage.get("max_abs_m0_dot_delta_m"),
        f"{point_name}.tangent_leakage.max_abs_m0_dot_delta_m",
    )


def require_static_periodic_diagnostics(diagnostics: dict, manifest: dict) -> bool:
    diagnostic_fields = [
        "static_periodic_projection",
        "static_periodic_node_pair_count",
        "static_periodic_frame_max_mismatch",
        "static_periodic_drive_max_mismatch",
    ]
    manifest_diagnostics = manifest.get("diagnostics", {})
    if not isinstance(manifest_diagnostics, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.diagnostics must be an object"
        )
    if all(
        diagnostics.get(field_name) is None and manifest_diagnostics.get(field_name) is None
        for field_name in diagnostic_fields
    ):
        return False

    projection = diagnostics.get("static_periodic_projection")
    manifest_projection = manifest_diagnostics.get("static_periodic_projection")
    if not isinstance(projection, bool):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "diagnostics.static_periodic_projection must be a boolean when static-periodic diagnostics are present"
        )
    if manifest_projection is not None and manifest_projection != projection:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.diagnostics.static_periodic_projection must match diagnostics.static_periodic_projection"
        )

    node_pair_count = diagnostics.get("static_periodic_node_pair_count")
    if not isinstance(node_pair_count, int) or node_pair_count < 0:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "diagnostics.static_periodic_node_pair_count must be a non-negative integer"
        )
    if projection and node_pair_count <= 0:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "diagnostics.static_periodic_node_pair_count must be positive when static_periodic_projection is true"
        )
    manifest_node_pair_count = manifest_diagnostics.get("static_periodic_node_pair_count")
    if manifest_node_pair_count is not None and manifest_node_pair_count != node_pair_count:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.diagnostics.static_periodic_node_pair_count must match diagnostics.static_periodic_node_pair_count"
        )

    for field_name in [
        "static_periodic_frame_max_mismatch",
        "static_periodic_drive_max_mismatch",
    ]:
        value = diagnostics.get(field_name)
        require_finite_number(value, f"diagnostics.{field_name}")
        if float(value) < 0.0:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"diagnostics.{field_name} must be non-negative"
            )
        if projection and float(value) > 1.0e-8:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"diagnostics.{field_name} must be <= 1e-8 when static_periodic_projection is true"
            )
        manifest_value = manifest_diagnostics.get(field_name)
        if manifest_value is not None and manifest_value != value:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"manifest.diagnostics.{field_name} must match diagnostics.{field_name}"
            )
    return projection


def require_manifest_physics(manifest: dict) -> None:
    require_non_empty_string(manifest.get("created_at"), "manifest.created_at")
    physics = manifest.get("physics")
    if not isinstance(physics, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.physics must be an object"
        )
    phase_convention = physics.get("phase_convention")
    if phase_convention not in {"exp_i_omega_t", "exp_minus_i_omega_t"}:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.physics.phase_convention must be exp_i_omega_t or exp_minus_i_omega_t"
        )
    expected = {
        "manifest.physics.analysis_family": (
            physics.get("analysis_family"),
            "frequency_domain",
        ),
        "manifest.physics.frequency_units": (physics.get("frequency_units"), "Hz"),
        "manifest.physics.field_units": (physics.get("field_units"), "A_per_m"),
        "manifest.physics.normalization": (
            physics.get("normalization"),
            "linear_response_tangent",
        ),
    }
    mismatches = [
        f"{name}: got {actual!r}, expected {expected_value!r}"
        for name, (actual, expected_value) in expected.items()
        if actual != expected_value
    ]
    if mismatches:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n" + "\n".join(mismatches)
        )
    require_finite_number(physics.get("llg_gamma0_si"), "manifest.physics.llg_gamma0_si")
    require_finite_number(physics.get("llg_alpha"), "manifest.physics.llg_alpha")
    spin_wave_bc = physics.get("spin_wave_bc")
    if not isinstance(spin_wave_bc, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.physics.spin_wave_bc must be an object"
        )
    require_non_empty_string(
        spin_wave_bc.get("kind"),
        "manifest.physics.spin_wave_bc.kind",
    )
    if not isinstance(physics.get("periodic_or_floquet"), bool):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.physics.periodic_or_floquet must be a boolean"
        )


def require_field_payload_metadata(point: dict, point_name: str) -> None:
    expected = {
        "payload_encoding": "f64_interleaved_real_imag_xyz",
        "binary_layout": "complex_f64_pairs_little_endian",
        "value_kind": "complex_spatial_vector",
        "component_basis": "global_xyz",
        "component_count": 3,
        "components": ["x", "y", "z"],
        "default_view": "phase_rotated_real",
        "default_phase_rad": 0.0,
    }
    for field_name, expected_value in expected.items():
        require_equal(point.get(field_name), expected_value, f"{point_name}.{field_name}")

    views = require_string_list(point.get("available_views"), f"{point_name}.available_views")
    required_views = {"complex", "real", "imag", "phase", "phase_rotated_real"}
    missing_views = sorted(required_views - set(views))
    if missing_views:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{point_name}.available_views missing required views: {missing_views!r}"
        )
    if "abs" not in views and "amplitude" not in views:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{point_name}.available_views must include 'abs' or 'amplitude'"
        )

    complex_pair_count = point.get("complex_pair_count")
    payload_value_count = point.get("payload_value_count")
    if not isinstance(complex_pair_count, int) or complex_pair_count <= 0:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{point_name}.complex_pair_count must be a positive integer"
        )
    if complex_pair_count > MAX_U64 // 2:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{point_name}.complex_pair_count overflows payload_value_count"
        )
    require_equal(payload_value_count, complex_pair_count * 2, f"{point_name}.payload_value_count")


def require_tangent_payload_metadata(point: dict, point_name: str) -> tuple[str | None, int | None]:
    tangent_fields = [
        "tangent_field_payload_path",
        "tangent_payload_encoding",
        "tangent_value_kind",
        "tangent_component_basis",
        "tangent_component_count",
        "tangent_components",
        "tangent_complex_pair_count",
        "tangent_payload_value_count",
    ]
    if all(point.get(field_name) is None for field_name in tangent_fields):
        return None, None

    tangent_path = point.get("tangent_field_payload_path")
    if not isinstance(tangent_path, str) or not tangent_path:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{point_name}.tangent_field_payload_path must be a non-empty string"
        )

    expected = {
        "tangent_payload_encoding": "f64_interleaved_real_imag_tangent",
        "tangent_value_kind": "complex_tangent_vector",
        "tangent_component_basis": "local_tangent_frame",
        "tangent_component_count": 2,
        "tangent_components": ["tangent_e1", "tangent_e2"],
    }
    for field_name, expected_value in expected.items():
        require_equal(point.get(field_name), expected_value, f"{point_name}.{field_name}")

    tangent_complex_pair_count = point.get("tangent_complex_pair_count")
    tangent_payload_value_count = point.get("tangent_payload_value_count")
    if not isinstance(tangent_complex_pair_count, int) or tangent_complex_pair_count <= 0:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{point_name}.tangent_complex_pair_count must be a positive integer"
        )
    if tangent_complex_pair_count > MAX_U64 // 2:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{point_name}.tangent_complex_pair_count overflows tangent_payload_value_count"
        )
    require_equal(
        tangent_payload_value_count,
        tangent_complex_pair_count * 2,
        f"{point_name}.tangent_payload_value_count",
    )
    return tangent_path, tangent_payload_value_count


def main() -> int:
    args = sys.argv[1:]
    require_static_periodic = False
    allow_interrupted = False
    allow_unavailable = False
    if "--require-static-periodic" in args:
        require_static_periodic = True
        args.remove("--require-static-periodic")
    if "--allow-interrupted" in args:
        allow_interrupted = True
        args.remove("--allow-interrupted")
    if "--allow-unavailable" in args:
        allow_unavailable = True
        args.remove("--allow-unavailable")
    root = (
        Path(args[0])
        if args
        else Path(".fullmag/reports/frequency-domain-runtime/artifacts")
    )
    common_required = [
        root / "response/progress.v1.json",
        root / "response/diagnostics.v1.json",
        root / "frequency_domain/manifest.v1.json",
    ]
    missing = [str(path) for path in common_required if not path.is_file()]
    if missing:
        raise SystemExit(
            "missing required frequency-domain runtime artifacts:\n"
            + "\n".join(missing)
        )

    progress = load_json(root / "response/progress.v1.json")
    diagnostics = load_json(root / "response/diagnostics.v1.json")
    manifest = load_json(root / "frequency_domain/manifest.v1.json")
    unavailable = manifest.get("status") == "unavailable"
    if unavailable:
        if not allow_unavailable:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.status is unavailable; pass --allow-unavailable to validate unavailable artifacts"
            )
        unavailable_expected = {
            "manifest.schema_version": (
                manifest.get("schema_version"),
                "frequency_domain_manifest.v1",
            ),
            "manifest.stage_kind": (manifest.get("stage_kind"), "frequency_response"),
            "manifest.complete": (manifest.get("complete"), False),
            "progress.schema_version": (
                progress.get("schema_version"),
                "frequency_domain_sweep_progress.v1",
            ),
            "progress.state": (progress.get("state"), "unavailable"),
            "progress.complete": (progress.get("complete"), False),
            "progress.completed_frequency_points": (
                progress.get("completed_frequency_points"),
                0,
            ),
            "progress.written_frequency_point_artifacts": (
                progress.get("written_frequency_point_artifacts"),
                0,
            ),
            "progress.partial_artifacts_available": (
                progress.get("partial_artifacts_available"),
                False,
            ),
            "diagnostics.schema_version": (
                diagnostics.get("schema_version"),
                "frequency_domain_response_diagnostics.v1",
            ),
            "diagnostics.status": (diagnostics.get("status"), "unavailable"),
            "diagnostics.complete": (diagnostics.get("complete"), False),
            "diagnostics.completed_frequency_point_count": (
                diagnostics.get("completed_frequency_point_count"),
                0,
            ),
            "diagnostics.written_frequency_point_artifacts": (
                diagnostics.get("written_frequency_point_artifacts"),
                0,
            ),
        }
        require_expected(unavailable_expected)
        require_manifest_physics(manifest)
        requested_execution = manifest.get("requested_execution")
        if not isinstance(requested_execution, dict):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.requested_execution must be an object"
            )
        resolved_execution = manifest.get("resolved_execution")
        if not isinstance(resolved_execution, dict):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.resolved_execution must be an object"
            )
        capabilities = manifest.get("capabilities")
        if not isinstance(capabilities, dict):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.capabilities must be an object"
            )
        unavailable_manifest_contract = {
            "manifest.requested_execution.solve_equation": (
                requested_execution.get("solve_equation"),
                "(i omega B - L) q = f",
            ),
            "manifest.requested_execution.solve_kind": (
                requested_execution.get("solve_kind"),
                "direct_harmonic_response",
            ),
            "manifest.requested_execution.study_kind": (
                requested_execution.get("study_kind"),
                "frequency_response",
            ),
            "manifest.resolved_execution.backend_engine_id": (
                resolved_execution.get("backend_engine_id"),
                "native_fem_mfem",
            ),
            "manifest.resolved_execution.reference_or_production": (
                resolved_execution.get("reference_or_production"),
                "production",
            ),
            "manifest.resolved_execution.solve_kind": (
                resolved_execution.get("solve_kind"),
                "direct_harmonic_response",
            ),
            "manifest.resolved_execution.solver_kind": (
                resolved_execution.get("solver_kind"),
                "production_unavailable",
            ),
            "manifest.resolved_execution.production_solver": (
                resolved_execution.get("production_solver"),
                True,
            ),
            "manifest.capabilities.production_solver_available": (
                capabilities.get("production_solver_available"),
                False,
            ),
            "manifest.capabilities.production_native_solver_available": (
                capabilities.get("production_native_solver_available"),
                False,
            ),
            "manifest.capabilities.validation_artifact": (
                capabilities.get("validation_artifact"),
                False,
            ),
            "manifest.capabilities.dynamic_demag_k_available": (
                capabilities.get("dynamic_demag_k_available"),
                False,
            ),
            "manifest.capabilities.floquet_response_available": (
                capabilities.get("floquet_response_available"),
                False,
            ),
        }
        require_expected(unavailable_manifest_contract)
        if not isinstance(requested_execution.get("frequency_count"), int):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.requested_execution.frequency_count must be an integer"
            )
        if not isinstance(requested_execution.get("write_response_fields"), bool):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.requested_execution.write_response_fields must be a boolean"
            )
        if not isinstance(resolved_execution.get("requested_execution_lane"), str):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.resolved_execution.requested_execution_lane must be a string"
            )
        if not isinstance(resolved_execution.get("lane_classification"), str):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.resolved_execution.lane_classification must be a string"
            )
        manifest_artifacts = manifest.get("artifacts", {})
        if not isinstance(manifest_artifacts, dict):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.artifacts must be an object"
            )
        unavailable_artifact_refs = {
            "manifest.artifacts.response_diagnostics_v1_path": (
                manifest_artifacts.get("response_diagnostics_v1_path"),
                "response/diagnostics.v1.json",
            ),
            "manifest.artifacts.response_progress_v1_path": (
                manifest_artifacts.get("response_progress_v1_path"),
                "response/progress.v1.json",
            ),
        }
        require_expected(unavailable_artifact_refs)
        if manifest_artifacts.get("frequency_point_paths") != []:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "unavailable manifest.artifacts.frequency_point_paths must be []"
            )
        manifest_resources = manifest.get("resources", {})
        if not isinstance(manifest_resources, dict):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.resources must be an object"
            )
        unavailable_resource_refs = {
            "manifest.resources.response_progress_resource_key": (
                manifest_resources.get("response_progress_resource_key"),
                "/v2/sessions/current/analysis/frequency-domain/response/progress.v1",
            ),
            "manifest.resources.response_diagnostics_resource_key": (
                manifest_resources.get("response_diagnostics_resource_key"),
                "/v2/sessions/current/analysis/frequency-domain/response/diagnostics.v1",
            ),
        }
        require_expected(unavailable_resource_refs)
        if manifest_resources.get("response_field_resources") != []:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "unavailable manifest.resources.response_field_resources must be []"
            )
        if (root / "response/magnetic_response_sweep.v1.json").exists() or (
            root / "response/magnetic_response_sweep.v2.json"
        ).exists():
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "unavailable artifacts must not include response sweep files"
            )
        return 0

    sweep_required = [
        root / "response/magnetic_response_sweep.v1.json",
        root / "response/magnetic_response_sweep.v2.json",
    ]
    missing = [str(path) for path in sweep_required if not path.is_file()]
    if missing:
        raise SystemExit(
            "missing required frequency-domain runtime artifacts:\n"
            + "\n".join(missing)
        )
    sweep_v1 = load_json(root / "response/magnetic_response_sweep.v1.json")
    sweep = load_json(root / "response/magnetic_response_sweep.v2.json")

    interrupted = manifest.get("status") == "interrupted"
    if interrupted and not allow_interrupted:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.status is interrupted; pass --allow-interrupted to validate partial artifacts"
        )
    expected_complete = False if interrupted else True
    expected_status = "interrupted" if interrupted else "ready"
    expected_state = "interrupted" if interrupted else "completed"
    expected_total_frequency_points = 2
    expected_completed_frequency_points = (
        progress.get("completed_frequency_points") if interrupted else 2
    )
    expected_written_frequency_point_artifacts = (
        progress.get("written_frequency_point_artifacts") if interrupted else 2
    )
    if interrupted:
        if not isinstance(expected_completed_frequency_points, int):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "progress.completed_frequency_points must be an integer for interrupted artifacts"
            )
        if not isinstance(expected_written_frequency_point_artifacts, int):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "progress.written_frequency_point_artifacts must be an integer for interrupted artifacts"
            )
        if expected_completed_frequency_points < 0 or expected_completed_frequency_points >= 2:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "interrupted progress.completed_frequency_points must be >= 0 and < total_frequency_points"
            )
        if expected_written_frequency_point_artifacts != expected_completed_frequency_points:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "interrupted written_frequency_point_artifacts must match completed_frequency_points"
            )

    expected = {
        "sweep_v1.schema_version": (
            sweep_v1.get("schema_version"),
            "magnetic_response_sweep.v1",
        ),
        "sweep_v1.backend_engine_id": (
            sweep_v1.get("backend_engine_id"),
            "native_fem_mfem",
        ),
        "sweep_v1.solver_model": (
            sweep_v1.get("solver_model"),
            "matrix_free_gmres",
        ),
        "sweep_v1.damping_policy": (
            sweep_v1.get("damping_policy"),
            "linearized_llg_tangent",
        ),
        "sweep_v1.lane_classification": (
            sweep_v1.get("lane_classification"),
            "fem_cpu_production",
        ),
        "sweep_v1.matrix_layout": (
            sweep_v1.get("matrix_layout"),
            "matrix_free_block_real",
        ),
        "sweep_v1.excitation_kind": (
            sweep_v1.get("excitation_kind"),
            "uniform_field",
        ),
        "sweep_v1.si_units.frequency": (
            sweep_v1.get("si_units", {}).get("frequency"),
            "Hz",
        ),
        "sweep_v1.si_units.angular_frequency": (
            sweep_v1.get("si_units", {}).get("angular_frequency"),
            "rad/s",
        ),
        "sweep_v1.point_count": (
            sweep_v1.get("point_count"),
            2,
        ),
        "sweep.schema_version": (
            sweep.get("schema_version"),
            "magnetic_response_sweep.v2",
        ),
        "sweep.solve_kind": (sweep.get("solve_kind"), "direct_harmonic_response"),
        "sweep.complete": (sweep.get("complete"), expected_complete),
        "sweep.completed_frequency_point_count": (
            sweep.get("completed_frequency_point_count"),
            expected_completed_frequency_points,
        ),
        "sweep.point_count": (
            sweep.get("point_count"),
            expected_total_frequency_points,
        ),
        "progress.status": (progress.get("status"), expected_status),
        "progress.schema_version": (
            progress.get("schema_version"),
            "frequency_domain_sweep_progress.v1",
        ),
        "progress.complete": (progress.get("complete"), expected_complete),
        "progress.state": (progress.get("state"), expected_state),
        "progress.total_frequency_points": (
            progress.get("total_frequency_points"),
            expected_total_frequency_points,
        ),
        "progress.completed_frequency_points": (
            progress.get("completed_frequency_points"),
            expected_completed_frequency_points,
        ),
        "progress.written_frequency_point_artifacts": (
            progress.get("written_frequency_point_artifacts"),
            expected_written_frequency_point_artifacts,
        ),
        "progress.partial_artifacts_available": (
            progress.get("partial_artifacts_available"),
            expected_completed_frequency_points > 0,
        ),
        "progress.latest_artifact_manifest_path": (
            progress.get("latest_artifact_manifest_path"),
            "frequency_domain/manifest.v1.json",
        ),
        "diagnostics.schema_version": (
            diagnostics.get("schema_version"),
            "frequency_domain_response_diagnostics.v1",
        ),
        "diagnostics.status": (diagnostics.get("status"), expected_status),
        "diagnostics.complete": (diagnostics.get("complete"), expected_complete),
        "diagnostics.assembled_mfem_operator_solver": (
            diagnostics.get("assembled_mfem_operator_solver"),
            False,
        ),
        "diagnostics.dense_block_real_solver": (
            diagnostics.get("dense_block_real_solver"),
            False,
        ),
        "diagnostics.matrix_free_solver": (
            diagnostics.get("matrix_free_solver"),
            True,
        ),
        "diagnostics.krylov_solver": (diagnostics.get("krylov_solver"), "gmres"),
        "diagnostics.completed_frequency_point_count": (
            diagnostics.get("completed_frequency_point_count"),
            expected_completed_frequency_points,
        ),
        "manifest.schema_version": (
            manifest.get("schema_version"),
            "frequency_domain_manifest.v1",
        ),
        "manifest.stage_kind": (manifest.get("stage_kind"), "frequency_response"),
        "manifest.status": (manifest.get("status"), expected_status),
        "manifest.complete": (manifest.get("complete"), expected_complete),
        "manifest.requested_execution.solve_equation": (
            manifest.get("requested_execution", {}).get("solve_equation"),
            "(i omega B - L) q = f",
        ),
        "manifest.resolved_execution.engine": (
            manifest.get("resolved_execution", {}).get("engine"),
            "native_fem_mfem_frequency_domain_cpu",
        ),
        "manifest.resolved_execution.native_backend": (
            manifest.get("resolved_execution", {}).get("native_backend"),
            "native_mfem_matrix_free",
        ),
        "manifest.resolved_execution.reference_or_production": (
            manifest.get("resolved_execution", {}).get("reference_or_production"),
            "production",
        ),
        "manifest.resolved_execution.solver_library": (
            manifest.get("resolved_execution", {}).get("solver_library"),
            "native_gmres",
        ),
        "manifest.resolved_execution.solver_model": (
            manifest.get("resolved_execution", {}).get("solver_model"),
            "matrix_free_gmres",
        ),
        "manifest.resolved_execution.solve_kind": (
            manifest.get("resolved_execution", {}).get("solve_kind"),
            "direct_harmonic_response",
        ),
        "manifest.capabilities.production_solver_available": (
            manifest.get("capabilities", {}).get("production_solver_available"),
            True,
        ),
        "manifest.capabilities.production_native_solver_available": (
            manifest.get("capabilities", {}).get("production_native_solver_available"),
            True,
        ),
        "manifest.capabilities.validation_artifact": (
            manifest.get("capabilities", {}).get("validation_artifact"),
            False,
        ),
        "manifest.resources.response_sweep_resource_key": (
            manifest.get("resources", {}).get("response_sweep_resource_key"),
            "/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep",
        ),
        "manifest.diagnostics.completed_frequency_point_count": (
            manifest_completed_frequency_point_count(manifest),
            expected_completed_frequency_points,
        ),
        "manifest.diagnostics.written_frequency_point_artifacts": (
            manifest.get("diagnostics", {}).get("written_frequency_point_artifacts"),
            expected_written_frequency_point_artifacts,
        ),
    }
    mismatches = [
        f"{name}: got {actual!r}, expected {expected_value!r}"
        for name, (actual, expected_value) in expected.items()
        if actual != expected_value
    ]
    if mismatches:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n" + "\n".join(mismatches)
        )
    require_finite_number(diagnostics.get("max_abs_response"), "diagnostics.max_abs_response")
    require_finite_number(diagnostics.get("residual_l2_norm"), "diagnostics.residual_l2_norm")
    require_finite_number(
        diagnostics.get("relative_residual_l2_norm"),
        "diagnostics.relative_residual_l2_norm",
    )
    static_periodic_projection = require_static_periodic_diagnostics(diagnostics, manifest)
    if require_static_periodic and not static_periodic_projection:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "static-periodic diagnostics were required but static_periodic_projection is not true"
        )
    require_manifest_physics(manifest)
    if require_static_periodic:
        periodic_pairs_path = manifest.get("artifacts", {}).get("periodic_pairs_v1_path")
        require_equal(
            periodic_pairs_path,
            "mesh/periodic_pairs.v1.json",
            "manifest.artifacts.periodic_pairs_v1_path",
        )
        periodic_pairs_file = root / "mesh/periodic_pairs.v1.json"
        if not periodic_pairs_file.is_file():
            raise SystemExit(
                "missing required frequency-domain runtime artifacts:\n"
                f"{periodic_pairs_file}"
            )
        periodic_pairs = load_json(periodic_pairs_file)
        require_equal(
            periodic_pairs.get("schema_version"),
            "periodic_pairs.v1",
            "mesh.periodic_pairs.schema_version",
        )
        require_equal(
            periodic_pairs.get("source"),
            "native_fem_frequency_domain_static_periodic",
            "mesh.periodic_pairs.source",
        )
        require_equal(
            periodic_pairs.get("pair_count"),
            diagnostics.get("static_periodic_node_pair_count"),
            "mesh.periodic_pairs.pair_count",
        )
        require_equal(
            periodic_pairs.get("validation_status"),
            "ok",
            "mesh.periodic_pairs.validation_status",
        )
        require_equal(
            periodic_pairs.get("paired_node_count"),
            diagnostics.get("static_periodic_node_pair_count") * 2,
            "mesh.periodic_pairs.paired_node_count",
        )
        require_equal(
            periodic_pairs.get("unpaired_source_count"),
            0,
            "mesh.periodic_pairs.unpaired_source_count",
        )
        require_equal(
            periodic_pairs.get("unpaired_destination_count"),
            0,
            "mesh.periodic_pairs.unpaired_destination_count",
        )
        require_finite_number(
            periodic_pairs.get("max_translation_residual_m"),
            "mesh.periodic_pairs.max_translation_residual_m",
        )
        residual_diagnostics = periodic_pairs.get("residual_diagnostics")
        if not isinstance(residual_diagnostics, dict):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "mesh.periodic_pairs.residual_diagnostics must be an object"
            )
        require_finite_number(
            residual_diagnostics.get("static_periodic_frame_max_mismatch"),
            "mesh.periodic_pairs.residual_diagnostics.static_periodic_frame_max_mismatch",
        )
        require_finite_number(
            residual_diagnostics.get("static_periodic_drive_max_mismatch"),
            "mesh.periodic_pairs.residual_diagnostics.static_periodic_drive_max_mismatch",
        )
        pairs = require_object_list(periodic_pairs.get("pairs"), "mesh.periodic_pairs.pairs")
        if len(pairs) != periodic_pairs.get("pair_count"):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"mesh.periodic_pairs.pairs length: got {len(pairs)}, expected {periodic_pairs.get('pair_count')}"
            )
        for pair_index, pair in enumerate(pairs):
            require_non_empty_string(
                pair.get("pair_id"),
                f"mesh.periodic_pairs.pairs[{pair_index}].pair_id",
            )
            require_non_empty_string(
                pair.get("source_marker"),
                f"mesh.periodic_pairs.pairs[{pair_index}].source_marker",
            )
            require_non_empty_string(
                pair.get("destination_marker"),
                f"mesh.periodic_pairs.pairs[{pair_index}].destination_marker",
            )
            require_equal(
                pair.get("validation_status"),
                "ok",
                f"mesh.periodic_pairs.pairs[{pair_index}].validation_status",
            )
            require_finite_number(
                pair.get("translation_residual_m"),
                f"mesh.periodic_pairs.pairs[{pair_index}].translation_residual_m",
            )
    require_equal(
        progress.get("status"),
        manifest.get("status"),
        "progress.status vs manifest.status",
    )
    require_equal(
        progress.get("complete"),
        manifest.get("complete"),
        "progress.complete vs manifest.complete",
    )
    require_equal(
        progress.get("complete"),
        sweep.get("complete"),
        "progress.complete vs sweep.complete",
    )
    require_equal(
        progress.get("complete"),
        diagnostics.get("complete"),
        "progress.complete vs diagnostics.complete",
    )
    require_equal(
        progress.get("completed_frequency_points"),
        sweep.get("completed_frequency_point_count"),
        "progress.completed_frequency_points vs sweep.completed_frequency_point_count",
    )
    require_equal(
        progress.get("completed_frequency_points"),
        diagnostics.get("completed_frequency_point_count"),
        "progress.completed_frequency_points vs diagnostics.completed_frequency_point_count",
    )
    require_equal(
        progress.get("completed_frequency_points"),
        manifest_completed_frequency_point_count(manifest),
        "progress.completed_frequency_points vs manifest.diagnostics.completed_frequency_point_count",
    )
    require_equal(
        progress.get("written_frequency_point_artifacts"),
        manifest.get("diagnostics", {}).get("written_frequency_point_artifacts"),
        "progress.written_frequency_point_artifacts vs manifest.diagnostics.written_frequency_point_artifacts",
    )

    sweep_v1_points = sweep_v1.get("points")
    if not isinstance(sweep_v1_points, list):
        raise SystemExit("invalid frequency-domain runtime artifacts:\nsweep_v1.points must be a list")
    if not sweep_v1_points and expected_completed_frequency_points != 0:
        raise SystemExit("invalid frequency-domain runtime artifacts:\nsweep_v1.points is empty")
    residual_sources = set()
    for index, point in enumerate(sweep_v1_points):
        if not isinstance(point, dict):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"sweep_v1.points[{index}] must be an object"
            )
        residual_sources.add(point.get("residual_source"))
        require_excitation_provenance(point, f"sweep_v1.points[{index}]")
        require_sweep_reuse(point, f"sweep_v1.points[{index}]")
    if expected_completed_frequency_points == 0:
        if residual_sources:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "sweep_v1.points must be empty when completed_frequency_points is 0"
            )
    elif residual_sources != {"matrix_free_gmres"}:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"sweep_v1 residual_source values: got {sorted(residual_sources)!r}, "
            "expected ['matrix_free_gmres']"
        )

    completed_count = sweep.get("completed_frequency_point_count")
    if not isinstance(completed_count, int) or completed_count < 0:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "sweep.completed_frequency_point_count must be a non-negative integer"
        )
    requested_execution = manifest.get("requested_execution")
    write_response_fields = True
    if isinstance(requested_execution, dict) and "write_response_fields" in requested_execution:
        if not isinstance(requested_execution.get("write_response_fields"), bool):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.requested_execution.write_response_fields must be a boolean"
            )
        write_response_fields = bool(requested_execution["write_response_fields"])
    point_paths = require_string_list(
        sweep.get("frequency_point_artifact_paths"),
        "sweep.frequency_point_artifact_paths",
    )
    payload_paths = require_string_list(
        sweep.get("response_field_payload_paths"),
        "sweep.response_field_payload_paths",
    )
    manifest_point_paths = require_string_list(
        manifest.get("artifacts", {}).get("frequency_point_paths"),
        "manifest.artifacts.frequency_point_paths",
    )
    manifest_payload_resources = require_object_list(
        manifest.get("resources", {}).get("response_field_resources"),
        "manifest.resources.response_field_resources",
    )
    if len(point_paths) != completed_count:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"sweep.frequency_point_artifact_paths length: got {len(point_paths)}, "
            f"expected {completed_count}"
        )
    expected_payload_count = completed_count if write_response_fields else 0
    if len(payload_paths) != expected_payload_count:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"sweep.response_field_payload_paths length: got {len(payload_paths)}, "
            f"expected {expected_payload_count}"
        )
    if manifest_point_paths != point_paths:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"manifest.artifacts.frequency_point_paths: got {manifest_point_paths!r}, "
            f"expected {point_paths!r}"
        )
    if len(manifest_payload_resources) != expected_payload_count:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"manifest.resources.response_field_resources length: got "
            f"{len(manifest_payload_resources)}, expected {expected_payload_count}"
        )
    if completed_count > 0:
        expected_first_point = "response/frequency_points/frequency_0000.json"
        if point_paths[0] != expected_first_point:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"first frequency point path: got {point_paths[0]!r}, expected {expected_first_point!r}"
            )
    if write_response_fields and completed_count > 0:
        expected_first_payload = "response/field_payloads/frequency_0000/vector_xyz.bin"
        if payload_paths[0] != expected_first_payload:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"first payload path: got {payload_paths[0]!r}, expected {expected_first_payload!r}"
            )
    missing_linked = [
        relative_path
        for relative_path in [*point_paths, *payload_paths]
        if not (root / relative_path).is_file()
    ]
    if missing_linked:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "linked v2 artifacts are missing:\n" + "\n".join(missing_linked)
        )

    sweep_points = sweep.get("points")
    if not isinstance(sweep_points, list) or len(sweep_points) != completed_count:
        actual_count = len(sweep_points) if isinstance(sweep_points, list) else "not a list"
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"sweep.points length: got {actual_count}, expected {completed_count}"
        )
    for index, point_value in enumerate(sweep_points):
        if not isinstance(point_value, dict):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"sweep.points[{index}] must be an object"
            )
        expected_point_path = point_paths[index]
        expected_payload_path = payload_paths[index] if write_response_fields else None
        if write_response_fields:
            expected_field_resource_id = f"analysis:frequency-response:frequency-{index:04d}"
            manifest_payload_resource = manifest_payload_resources[index]
            if manifest_payload_resource.get("frequency_index") != index:
                raise SystemExit(
                    "invalid frequency-domain runtime artifacts:\n"
                    f"manifest.resources.response_field_resources[{index}].frequency_index: got "
                    f"{manifest_payload_resource.get('frequency_index')!r}, expected {index}"
                )
            if manifest_payload_resource.get("field_resource_id") != expected_field_resource_id:
                raise SystemExit(
                    "invalid frequency-domain runtime artifacts:\n"
                    f"manifest.resources.response_field_resources[{index}].field_resource_id: got "
                    f"{manifest_payload_resource.get('field_resource_id')!r}, "
                    f"expected {expected_field_resource_id!r}"
                )
            if manifest_payload_resource.get("payload_path") != expected_payload_path:
                raise SystemExit(
                    "invalid frequency-domain runtime artifacts:\n"
                    f"manifest.resources.response_field_resources[{index}].payload_path: got "
                    f"{manifest_payload_resource.get('payload_path')!r}, "
                    f"expected {expected_payload_path!r}"
                )
        if point_value.get("frequency_index") != index:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"sweep.points[{index}].frequency_index: got "
                f"{point_value.get('frequency_index')!r}, expected {index}"
            )
        require_finite_number(
            point_value.get("frequency_hz"),
            f"sweep.points[{index}].frequency_hz",
        )
        require_finite_number(
            point_value.get("angular_frequency_rad_per_s"),
            f"sweep.points[{index}].angular_frequency_rad_per_s",
        )
        amplitude = point_value.get("max_response_amplitude")
        if amplitude is None:
            amplitude = point_value.get("response_amplitude")
        require_finite_number(amplitude, f"sweep.points[{index}].response_amplitude")
        require_finite_number(
            point_value.get("absorbed_power_density"),
            f"sweep.points[{index}].absorbed_power_density",
        )
        require_response_observables(point_value, f"sweep.points[{index}]")
        require_response_series(point_value, f"sweep.points[{index}]")
        require_finite_number(
            point_value.get("relative_residual_l2_norm"),
            f"sweep.points[{index}].relative_residual_l2_norm",
        )
        if point_value.get("frequency_point_artifact_path") != expected_point_path:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"sweep.points[{index}].frequency_point_artifact_path: got "
                f"{point_value.get('frequency_point_artifact_path')!r}, "
                f"expected {expected_point_path!r}"
            )
        if point_value.get("response_field_payload_path") != expected_payload_path:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"sweep.points[{index}].response_field_payload_path: got "
                f"{point_value.get('response_field_payload_path')!r}, "
                f"expected {expected_payload_path!r}"
            )
        require_finite_number(point_value.get("phase_rad"), f"sweep.points[{index}].phase_rad")
        require_excitation_provenance(point_value, f"sweep.points[{index}]")
        point_artifact = load_json(root / expected_point_path)
        require_equal(
            point_artifact.get("schema_version"),
            "frequency_response_point.v1",
            f"{expected_point_path}.schema_version",
        )
        require_equal(
            point_artifact.get("frequency_index"),
            index,
            f"{expected_point_path}.frequency_index",
        )
        require_response_observables(point_artifact, expected_point_path)
        require_response_series(point_artifact, expected_point_path)
        for observable_key in [
            "angular_frequency_rad_per_s",
            "absorbed_power_density",
            "m_complex",
            "response_amplitude",
            "response_phase",
            "phase_rad",
            "component_response_amplitude",
            "component_response_phase",
            "susceptibility_tensor",
            "tangent_leakage",
            "residual_l2_norm",
            "relative_residual_l2_norm",
            "residual_source",
        ]:
            if point_artifact.get(observable_key) != point_value.get(observable_key):
                raise SystemExit(
                    "invalid frequency-domain runtime artifacts:\n"
                    f"{expected_point_path}.{observable_key} does not match "
                    f"sweep.points[{index}].{observable_key}"
                )
        require_equal(
            point_artifact.get("field_payload_path"),
            expected_payload_path,
            f"{expected_point_path}.field_payload_path",
        )
        if write_response_fields:
            require_field_payload_metadata(point_artifact, expected_point_path)
        tangent_payload_path, tangent_payload_value_count = require_tangent_payload_metadata(
            point_artifact,
            expected_point_path,
        )
        point_tangent_payload_path = point_value.get("response_tangent_field_payload_path")
        if tangent_payload_path is not None and point_tangent_payload_path != tangent_payload_path:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"sweep.points[{index}].response_tangent_field_payload_path: got "
                f"{point_tangent_payload_path!r}, expected {tangent_payload_path!r}"
            )
        if tangent_payload_path is None and point_tangent_payload_path is not None:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"sweep.points[{index}].response_tangent_field_payload_path is present "
                "but point artifact has no tangent_field_payload_path"
            )
        if write_response_fields:
            payload_path = root / expected_payload_path
            payload_value_count = point_artifact["payload_value_count"]
            expected_size = payload_value_count * 8
            actual_size = payload_path.stat().st_size
            if actual_size != expected_size:
                raise SystemExit(
                    "invalid frequency-domain runtime artifacts:\n"
                    f"{expected_payload_path} size: got {actual_size}, expected {expected_size}"
                )
        if tangent_payload_path is not None:
            resolved_tangent_payload_path = root / tangent_payload_path
            if not resolved_tangent_payload_path.is_file():
                raise SystemExit(
                    "invalid frequency-domain runtime artifacts:\n"
                    f"linked tangent payload is missing: {tangent_payload_path}"
                )
            expected_tangent_size = tangent_payload_value_count * 8
            actual_tangent_size = resolved_tangent_payload_path.stat().st_size
            if actual_tangent_size != expected_tangent_size:
                raise SystemExit(
                    "invalid frequency-domain runtime artifacts:\n"
                    f"tangent payload {tangent_payload_path} size: got {actual_tangent_size}, "
                    f"expected {expected_tangent_size}"
                )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
