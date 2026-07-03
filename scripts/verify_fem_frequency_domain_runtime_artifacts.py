#!/usr/bin/env python3
"""Validate FEM frequency-domain runtime smoke artifacts."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

MAX_U64 = (1 << 64) - 1
CPU_GPU_PARITY_ABS_TOL = 1.0e-8
CPU_GPU_PARITY_REL_TOL = 1.0e-7
FLOQUET_RECIPROCAL_ABS_TOL = 1.0e-8
FLOQUET_RECIPROCAL_REL_TOL = 1.0e-7
FLOQUET_RECIPROCAL_K_ABS_TOL = 1.0e-6
FLOQUET_RECIPROCAL_K_REL_TOL = 1.0e-12
FLOQUET_TANGENT_FRAME_IDENTITY_TOL = 1.0e-10
AIRBOX_Z_PADDING_RESPONSE_ABS_TOL = 0.0
AIRBOX_Z_PADDING_RESPONSE_REL_TOL = 5.0e-2
AIRBOX_Z_PADDING_FREQUENCY_ABS_TOL = 1.0e-6
AIRBOX_Z_PADDING_FREQUENCY_REL_TOL = 1.0e-12
PERIODIC_AIRBOX_CPU_DEMAG_PRECONDITIONER_VARIANTS = {
    "graph_demag_coarse",
    "demag_coarse",
    "block_jacobi",
}
GPU_DYNAMIC_DEMAG_TANGENT_OPERATOR_SOURCES = {
    "explicit_demag_tangent_matrix",
    "matrix_free_demag_tangent_provider",
}


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


def require_non_negative_finite_number(value: object, name: str) -> None:
    require_finite_number(value, name)
    if float(value) < 0.0:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{name} must be non-negative"
        )


def require_fraction(value: object, name: str) -> float:
    require_finite_number(value, name)
    fraction = float(value)
    if fraction < 0.0 or fraction > 1.0:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{name} must be in [0, 1]"
        )
    return fraction


def require_finite_number_list(value: object, name: str) -> list[object]:
    if not isinstance(value, list) or not value:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{name} must be a non-empty finite number list"
        )
    for index, item in enumerate(value):
        require_finite_number(item, f"{name}[{index}]")
    return value


def require_block_norms(value: object, name: str) -> None:
    if not isinstance(value, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{name} must be an object"
        )
    for field_name in [
        "rhs_real_l2_norm",
        "rhs_imag_l2_norm",
        "residual_real_l2_norm",
        "residual_imag_l2_norm",
        "response_real_l2_norm",
        "response_imag_l2_norm",
    ]:
        require_non_negative_finite_number(
            value.get(field_name),
            f"{name}.{field_name}",
        )


def require_coupled_block_norms(value: object, name: str) -> None:
    if not isinstance(value, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{name} must be an object"
        )
    for field_name in [
        "rhs_delta_m_l2_norm",
        "rhs_delta_phi_l2_norm",
        "residual_delta_m_l2_norm",
        "residual_delta_phi_l2_norm",
        "relative_residual_delta_m_l2_norm",
        "relative_residual_delta_phi_l2_norm",
        "response_delta_m_l2_norm",
        "response_delta_phi_l2_norm",
    ]:
        require_non_negative_finite_number(
            value.get(field_name),
            f"{name}.{field_name}",
        )


def require_positive_integer(value: object, name: str) -> int:
    if not isinstance(value, int) or value <= 0:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{name} must be a positive integer"
        )
    return value


def require_non_negative_integer(value: object, name: str) -> int:
    if not isinstance(value, int) or value < 0:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{name} must be a non-negative integer"
        )
    return value


def decode_progress_json(progress: dict, name: str = "progress.progress_json") -> dict:
    raw_progress_json = progress.get("progress_json")
    if not isinstance(raw_progress_json, str) or not raw_progress_json.strip():
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{name} must preserve native solver progress details"
        )
    try:
        progress_json = json.loads(raw_progress_json)
    except json.JSONDecodeError as exc:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{name} must be valid JSON: {exc}"
        ) from exc
    if not isinstance(progress_json, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{name} must decode to an object"
        )
    return progress_json


def require_native_frequency_response_progress_observability(
    progress: dict,
    *,
    expected_demag_mode: str | None = None,
    expected_converged: bool | None = None,
) -> dict:
    native_iteration_count = require_positive_integer(
        progress.get("native_iteration_count"),
        "progress.native_iteration_count",
    )
    native_max_iterations = require_positive_integer(
        progress.get("native_max_iterations_for_frequency"),
        "progress.native_max_iterations_for_frequency",
    )
    if native_iteration_count > native_max_iterations:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "progress.native_iteration_count must be <= native_max_iterations_for_frequency"
        )
    require_non_negative_integer(
        progress.get("native_frequency_index"),
        "progress.native_frequency_index",
    )
    require_finite_number(
        progress.get("current_frequency_hz"),
        "progress.current_frequency_hz",
    )
    require_finite_number(
        progress.get("native_residual_l2_norm"),
        "progress.native_residual_l2_norm",
    )
    require_finite_number(
        progress.get("native_relative_residual_l2_norm"),
        "progress.native_relative_residual_l2_norm",
    )
    solve_fraction = require_fraction(
        progress.get("native_current_frequency_solve_fraction"),
        "progress.native_current_frequency_solve_fraction",
    )
    native_converged = progress.get("native_converged")
    if expected_converged is not None:
        require_equal(
            native_converged,
            expected_converged,
            "progress.native_converged",
        )
    elif not isinstance(native_converged, bool):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "progress.native_converged must be a boolean"
        )
    if native_converged is True and solve_fraction != 1.0:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "progress.native_current_frequency_solve_fraction must be 1.0 when native_converged is true"
        )

    progress_json = decode_progress_json(progress)
    require_equal(
        progress_json.get("native_iteration_count"),
        native_iteration_count,
        "progress.progress_json.native_iteration_count",
    )
    require_equal(
        progress_json.get("native_max_iterations_for_frequency"),
        native_max_iterations,
        "progress.progress_json.native_max_iterations_for_frequency",
    )
    require_equal(
        progress_json.get("native_current_frequency_solve_fraction"),
        progress.get("native_current_frequency_solve_fraction"),
        "progress.progress_json.native_current_frequency_solve_fraction",
    )
    require_equal(
        progress_json.get("native_relative_residual_l2_norm"),
        progress.get("native_relative_residual_l2_norm"),
        "progress.progress_json.native_relative_residual_l2_norm",
    )
    require_equal(
        progress_json.get("native_converged"),
        native_converged,
        "progress.progress_json.native_converged",
    )
    if expected_demag_mode is not None:
        require_equal(
            progress.get("demag_mode"),
            expected_demag_mode,
            "progress.demag_mode",
        )
        require_equal(
            progress_json.get("demag_mode"),
            expected_demag_mode,
            "progress.progress_json.demag_mode",
        )
    return progress_json


def canonical_phase_residual_rad(phase_rad: float) -> float:
    value = math.fmod(phase_rad + math.pi, 2.0 * math.pi)
    if value < 0.0:
        value += 2.0 * math.pi
    value -= math.pi
    if value <= -math.pi:
        value += 2.0 * math.pi
    return value


def require_three_finite_numbers(value: object, name: str) -> list[float]:
    if not isinstance(value, list) or len(value) != 3:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{name} must be a 3-vector"
        )
    vector = []
    for index, item in enumerate(value):
        require_finite_number(item, f"{name}[{index}]")
        vector.append(float(item))
    return vector


def require_complex_pair_list(value: object, name: str) -> list[object]:
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
    return value


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
    susceptibility_kind = provenance.get("kind")
    if susceptibility_kind == "drive_projected_si_susceptibility":
        require_expected(
            {
                f"{point_name}.susceptibility_tensor_provenance.basis": (
                    provenance.get("basis"),
                    "local_tangent_drive",
                ),
                f"{point_name}.susceptibility_tensor_provenance.response_quantity": (
                    provenance.get("response_quantity"),
                    "delta_M_over_h_drive",
                ),
                f"{point_name}.susceptibility_tensor_provenance.response_units": (
                    provenance.get("response_units"),
                    "dimensionless",
                ),
                f"{point_name}.susceptibility_tensor_provenance.dimensionless_si_susceptibility": (
                    provenance.get("dimensionless_si_susceptibility"),
                    True,
                ),
                f"{point_name}.susceptibility_tensor_provenance.requires_ms_for_chi_si": (
                    provenance.get("requires_ms_for_chi_si"),
                    False,
                ),
                f"{point_name}.susceptibility_tensor_provenance.ms_factor_applied": (
                    provenance.get("ms_factor_applied"),
                    True,
                ),
                f"{point_name}.susceptibility_tensor_provenance.normalization": (
                    provenance.get("normalization"),
                    "sum(Ms*response*conj(drive))/sum(abs(drive)^2)",
                ),
            }
        )
        if provenance.get("ms_source") not in {"uniform", "per_node_field"}:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"{point_name}.susceptibility_tensor_provenance.ms_source must be uniform or per_node_field"
            )
    elif susceptibility_kind == "drive_projected_scalar":
        require_expected(
            {
                f"{point_name}.susceptibility_tensor_provenance.basis": (
                    provenance.get("basis"),
                    "local_tangent_drive",
                ),
                f"{point_name}.susceptibility_tensor_provenance.response_quantity": (
                    provenance.get("response_quantity"),
                    "delta_m_over_h_drive",
                ),
                f"{point_name}.susceptibility_tensor_provenance.response_units": (
                    provenance.get("response_units"),
                    "m/A",
                ),
                f"{point_name}.susceptibility_tensor_provenance.dimensionless_si_susceptibility": (
                    provenance.get("dimensionless_si_susceptibility"),
                    False,
                ),
                f"{point_name}.susceptibility_tensor_provenance.requires_ms_for_chi_si": (
                    provenance.get("requires_ms_for_chi_si"),
                    True,
                ),
                f"{point_name}.susceptibility_tensor_provenance.ms_factor_applied": (
                    provenance.get("ms_factor_applied"),
                    False,
                ),
                f"{point_name}.susceptibility_tensor_provenance.normalization": (
                    provenance.get("normalization"),
                    "sum(response*conj(drive))/sum(abs(drive)^2)",
                ),
            }
        )
    else:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{point_name}.susceptibility_tensor_provenance.kind must be drive_projected_scalar or drive_projected_si_susceptibility"
        )
    absorbed_provenance = point.get("absorbed_power_density_provenance")
    if not isinstance(absorbed_provenance, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{point_name}.absorbed_power_density_provenance must be an object"
        )
    require_non_empty_string(absorbed_provenance.get("kind"), f"{point_name}.absorbed_power_density_provenance.kind")
    absorbed_kind = absorbed_provenance.get("kind")
    if absorbed_kind == "drive_projected_absorbed_power_density":
        require_expected(
            {
                f"{point_name}.absorbed_power_density_provenance.basis": (
                    absorbed_provenance.get("basis"),
                    "local_tangent_drive",
                ),
                f"{point_name}.absorbed_power_density_provenance.physical_power_density": (
                    absorbed_provenance.get("physical_power_density"),
                    True,
                ),
                f"{point_name}.absorbed_power_density_provenance.units": (
                    absorbed_provenance.get("units"),
                    "W/m^3",
                ),
                f"{point_name}.absorbed_power_density_provenance.requires_mu0_ms_factor": (
                    absorbed_provenance.get("requires_mu0_ms_factor"),
                    False,
                ),
                f"{point_name}.absorbed_power_density_provenance.mu0_ms_factor_applied": (
                    absorbed_provenance.get("mu0_ms_factor_applied"),
                    True,
                ),
                f"{point_name}.absorbed_power_density_provenance.normalization": (
                    absorbed_provenance.get("normalization"),
                    "0.5*mu0*abs(omega)*abs(imag(sum(Ms*response*conj(drive))))/tangent_dof_count",
                ),
                f"{point_name}.absorbed_power_density_provenance.full_power_density": (
                    absorbed_provenance.get("full_power_density"),
                    True,
                ),
            }
        )
        if absorbed_provenance.get("ms_source") not in {"uniform", "per_node_field"}:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"{point_name}.absorbed_power_density_provenance.ms_source must be uniform or per_node_field"
            )
    elif absorbed_kind == "drive_projected_absorption_proxy":
        require_expected(
            {
                f"{point_name}.absorbed_power_density_provenance.basis": (
                    absorbed_provenance.get("basis"),
                    "local_tangent_drive",
                ),
                f"{point_name}.absorbed_power_density_provenance.physical_power_density": (
                    absorbed_provenance.get("physical_power_density"),
                    False,
                ),
                f"{point_name}.absorbed_power_density_provenance.units": (
                    absorbed_provenance.get("units"),
                    "proxy_not_W_per_m3",
                ),
                f"{point_name}.absorbed_power_density_provenance.requires_mu0_ms_factor": (
                    absorbed_provenance.get("requires_mu0_ms_factor"),
                    True,
                ),
                f"{point_name}.absorbed_power_density_provenance.ms_factor_applied": (
                    absorbed_provenance.get("ms_factor_applied"),
                    False,
                ),
                f"{point_name}.absorbed_power_density_provenance.normalization": (
                    absorbed_provenance.get("normalization"),
                    "0.5*abs(omega)*abs(imag(sum(response*conj(drive))))/tangent_dof_count",
                ),
                f"{point_name}.absorbed_power_density_provenance.full_power_density": (
                    absorbed_provenance.get("full_power_density"),
                    False,
                ),
            }
        )
    else:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{point_name}.absorbed_power_density_provenance.kind must be drive_projected_absorption_proxy or drive_projected_absorbed_power_density"
        )
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


def require_floquet_phase_projection_diagnostics(diagnostics: dict, manifest: dict) -> bool:
    manifest_diagnostics = manifest.get("diagnostics", {})
    if not isinstance(manifest_diagnostics, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.diagnostics must be an object"
        )

    projection = diagnostics.get("floquet_phase_projection")
    manifest_projection = manifest_diagnostics.get("floquet_phase_projection")
    if projection is None and manifest_projection is None:
        return False
    if not isinstance(projection, bool):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "diagnostics.floquet_phase_projection must be a boolean when Floquet phase diagnostics are present"
        )
    if manifest_projection is not None and manifest_projection != projection:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.diagnostics.floquet_phase_projection must match diagnostics.floquet_phase_projection"
        )

    physics = manifest.get("physics")
    if not isinstance(physics, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.physics must be an object"
        )
    spin_wave_bc = physics.get("spin_wave_bc")
    if projection and not isinstance(spin_wave_bc, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.physics.spin_wave_bc must be an object when floquet_phase_projection is true"
        )
    if projection and spin_wave_bc.get("kind") != "floquet":
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.physics.spin_wave_bc.kind must be floquet when floquet_phase_projection is true"
        )
    if projection and physics.get("periodic_or_floquet") is not True:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.physics.periodic_or_floquet must be true when floquet_phase_projection is true"
        )
    if projection:
        capabilities = manifest.get("capabilities", {})
        if not isinstance(capabilities, dict):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.capabilities must be an object"
            )
        if capabilities.get("dynamic_demag_k_available") is not False:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.capabilities.dynamic_demag_k_available must be false for the current Floquet phase-projection no-demag runtime gate"
            )
        if diagnostics.get("floquet_real_imag_mixing") is not True:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "diagnostics.floquet_real_imag_mixing must be true when floquet_phase_projection is true"
            )
        if manifest_diagnostics.get("floquet_real_imag_mixing") is not True:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.diagnostics.floquet_real_imag_mixing must be true when floquet_phase_projection is true"
            )
        basis_transport_policy = diagnostics.get("basis_transport_policy")
        if basis_transport_policy not in {
            "tangent_frame_identity",
            "tangent_frame_transport",
            "full_vector",
        }:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "diagnostics.basis_transport_policy must state full_vector, tangent_frame_transport, or tangent_frame_identity when floquet_phase_projection is true"
            )
        if manifest_diagnostics.get("basis_transport_policy") != basis_transport_policy:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.diagnostics.basis_transport_policy must match diagnostics.basis_transport_policy"
            )
        if basis_transport_policy == "full_vector":
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "diagnostics.basis_transport_policy=full_vector is not valid for tangent-coordinate Floquet phase projection"
            )
        frame_mismatch = diagnostics.get("floquet_tangent_frame_max_mismatch")
        require_non_negative_finite_number(
            frame_mismatch,
            "diagnostics.floquet_tangent_frame_max_mismatch",
        )
        if manifest_diagnostics.get("floquet_tangent_frame_max_mismatch") != frame_mismatch:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.diagnostics.floquet_tangent_frame_max_mismatch must match diagnostics.floquet_tangent_frame_max_mismatch"
            )
        transport_nonunitarity = diagnostics.get(
            "floquet_tangent_transport_max_nonunitarity"
        )
        require_non_negative_finite_number(
            transport_nonunitarity,
            "diagnostics.floquet_tangent_transport_max_nonunitarity",
        )
        if (
            manifest_diagnostics.get("floquet_tangent_transport_max_nonunitarity")
            != transport_nonunitarity
        ):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.diagnostics.floquet_tangent_transport_max_nonunitarity must match diagnostics.floquet_tangent_transport_max_nonunitarity"
            )
        if (
            basis_transport_policy == "tangent_frame_identity"
            and float(frame_mismatch) > FLOQUET_TANGENT_FRAME_IDENTITY_TOL
        ):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "diagnostics.basis_transport_policy=tangent_frame_identity requires floquet_tangent_frame_max_mismatch below tolerance"
            )
        operator_terms = require_string_list(
            diagnostics.get("operator_terms_included"),
            "diagnostics.operator_terms_included",
        )
        if "exchange" not in operator_terms:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "diagnostics.operator_terms_included must include exchange when floquet_phase_projection is true"
            )
        exchange_edge_count = require_positive_integer(
            diagnostics.get("exchange_edge_count"),
            "diagnostics.exchange_edge_count",
        )
        manifest_exchange_edge_count = manifest_diagnostics.get("exchange_edge_count")
        if manifest_exchange_edge_count != exchange_edge_count:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.diagnostics.exchange_edge_count must match diagnostics.exchange_edge_count"
            )
        pair_count = diagnostics.get("floquet_periodic_pair_count")
        manifest_pair_count = manifest_diagnostics.get("floquet_periodic_pair_count")
        if not isinstance(pair_count, int) or pair_count <= 0:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "diagnostics.floquet_periodic_pair_count must be a positive integer when floquet_phase_projection is true"
            )
        if manifest_pair_count != pair_count:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.diagnostics.floquet_periodic_pair_count must match diagnostics.floquet_periodic_pair_count"
            )

        k_vector = diagnostics.get("floquet_k_vector_rad_per_m")
        manifest_k_vector = manifest_diagnostics.get("floquet_k_vector_rad_per_m")
        if not isinstance(k_vector, list) or len(k_vector) != 3:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "diagnostics.floquet_k_vector_rad_per_m must be a 3-vector when floquet_phase_projection is true"
            )
        for index, component in enumerate(k_vector):
            require_finite_number(
                component,
                f"diagnostics.floquet_k_vector_rad_per_m[{index}]",
            )
        if manifest_k_vector != k_vector:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.diagnostics.floquet_k_vector_rad_per_m must match diagnostics.floquet_k_vector_rad_per_m"
            )
    return projection


def require_floquet_periodic_pairs_artifact(
    root: Path,
    diagnostics: dict,
    manifest: dict,
) -> None:
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
        "native_fem_frequency_domain_floquet_phase_projection",
        "mesh.periodic_pairs.source",
    )
    pair_count = require_positive_integer(
        diagnostics.get("floquet_periodic_pair_count"),
        "diagnostics.floquet_periodic_pair_count",
    )
    require_equal(
        periodic_pairs.get("pair_count"),
        pair_count,
        "mesh.periodic_pairs.pair_count",
    )
    require_equal(
        periodic_pairs.get("validation_status"),
        "ok",
        "mesh.periodic_pairs.validation_status",
    )
    require_equal(
        periodic_pairs.get("paired_node_count"),
        pair_count * 2,
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
        residual_diagnostics.get("max_translation_residual_m"),
        "mesh.periodic_pairs.residual_diagnostics.max_translation_residual_m",
    )
    require_finite_number(
        residual_diagnostics.get("floquet_phase_loop_max_residual"),
        "mesh.periodic_pairs.residual_diagnostics.floquet_phase_loop_max_residual",
    )
    basis_transport_policy = diagnostics.get("basis_transport_policy")
    require_equal(
        periodic_pairs.get("basis_transport_policy"),
        basis_transport_policy,
        "mesh.periodic_pairs.basis_transport_policy",
    )
    pair_frame_mismatch = residual_diagnostics.get(
        "floquet_tangent_frame_max_mismatch"
    )
    require_non_negative_finite_number(
        pair_frame_mismatch,
        "mesh.periodic_pairs.residual_diagnostics.floquet_tangent_frame_max_mismatch",
    )
    require_equal(
        pair_frame_mismatch,
        diagnostics.get("floquet_tangent_frame_max_mismatch"),
        "mesh.periodic_pairs.residual_diagnostics.floquet_tangent_frame_max_mismatch",
    )
    pair_transport_nonunitarity = residual_diagnostics.get(
        "floquet_tangent_transport_max_nonunitarity"
    )
    require_non_negative_finite_number(
        pair_transport_nonunitarity,
        "mesh.periodic_pairs.residual_diagnostics.floquet_tangent_transport_max_nonunitarity",
    )
    require_equal(
        pair_transport_nonunitarity,
        diagnostics.get("floquet_tangent_transport_max_nonunitarity"),
        "mesh.periodic_pairs.residual_diagnostics.floquet_tangent_transport_max_nonunitarity",
    )

    k_vector = require_three_finite_numbers(
        diagnostics.get("floquet_k_vector_rad_per_m"),
        "diagnostics.floquet_k_vector_rad_per_m",
    )
    pairs = require_object_list(periodic_pairs.get("pairs"), "mesh.periodic_pairs.pairs")
    if len(pairs) != pair_count:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"mesh.periodic_pairs.pairs length: got {len(pairs)}, expected {pair_count}"
        )
    for pair_index, pair in enumerate(pairs):
        require_non_empty_string(
            pair.get("pair_id"),
            f"mesh.periodic_pairs.pairs[{pair_index}].pair_id",
        )
        require_equal(
            pair.get("validation_status"),
            "ok",
            f"mesh.periodic_pairs.pairs[{pair_index}].validation_status",
        )
        require_equal(
            pair.get("basis_transport_policy"),
            basis_transport_policy,
            f"mesh.periodic_pairs.pairs[{pair_index}].basis_transport_policy",
        )
        require_non_negative_integer(
            pair.get("node_a"),
            f"mesh.periodic_pairs.pairs[{pair_index}].node_a",
        )
        require_non_negative_integer(
            pair.get("node_b"),
            f"mesh.periodic_pairs.pairs[{pair_index}].node_b",
        )
        translation = require_three_finite_numbers(
            pair.get("translation_m"),
            f"mesh.periodic_pairs.pairs[{pair_index}].translation_m",
        )
        expected_translation = require_three_finite_numbers(
            pair.get("expected_translation_m"),
            f"mesh.periodic_pairs.pairs[{pair_index}].expected_translation_m",
        )
        for component_index, (actual, expected) in enumerate(
            zip(translation, expected_translation)
        ):
            if abs(actual - expected) > 1.0e-18:
                raise SystemExit(
                    "invalid frequency-domain runtime artifacts:\n"
                    f"mesh.periodic_pairs.pairs[{pair_index}].translation_m[{component_index}] must match expected_translation_m"
                )
        require_finite_number(
            pair.get("translation_residual_m"),
            f"mesh.periodic_pairs.pairs[{pair_index}].translation_residual_m",
        )
        phase_rad = pair.get("phase_rad")
        require_finite_number(
            phase_rad,
            f"mesh.periodic_pairs.pairs[{pair_index}].phase_rad",
        )
        expected_phase = -sum(k * delta for k, delta in zip(k_vector, translation))
        phase_residual = abs(canonical_phase_residual_rad(float(phase_rad) - expected_phase))
        if phase_residual > 1.0e-8:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"mesh.periodic_pairs.pairs[{pair_index}].phase_rad must satisfy -k dot translation; residual={phase_residual}"
            )


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


def expected_progress_demag_mode(manifest: dict) -> str | None:
    physics = manifest.get("physics")
    if not isinstance(physics, dict):
        return None
    resolved_bc = physics.get("resolved_magnetostatic_bc")
    if resolved_bc in {"periodic_airbox_k0", "floquet_airbox"}:
        return resolved_bc
    operator_terms = physics.get("operator_terms_included")
    if isinstance(operator_terms, list) and "demag" in operator_terms:
        return "enabled"
    return None


def require_progress_demag_mode(progress: dict, manifest: dict) -> None:
    expected_demag_mode = expected_progress_demag_mode(manifest)
    if expected_demag_mode is None:
        return
    require_equal(
        progress.get("demag_mode"),
        expected_demag_mode,
        "progress.demag_mode",
    )
    raw_progress_json = progress.get("progress_json")
    if not isinstance(raw_progress_json, str) or not raw_progress_json.strip():
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "progress.progress_json must preserve demag mode details"
        )
    try:
        progress_json = json.loads(raw_progress_json)
    except json.JSONDecodeError as exc:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"progress.progress_json must be valid JSON: {exc}"
        ) from exc
    if not isinstance(progress_json, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "progress.progress_json must decode to an object"
        )
    require_equal(
        progress_json.get("demag_mode"),
        expected_demag_mode,
        "progress.progress_json.demag_mode",
    )


def require_gpu_dynamic_demag_operator_source(
    diagnostics: dict,
    manifest: dict,
) -> None:
    operator_terms_value = diagnostics.get("operator_terms_included")
    if operator_terms_value is None:
        return
    operator_terms = require_string_list(
        operator_terms_value,
        "diagnostics.operator_terms_included",
    )
    if "demag" not in operator_terms:
        return
    source = diagnostics.get("demag_tangent_operator_source")
    if source not in GPU_DYNAMIC_DEMAG_TANGENT_OPERATOR_SOURCES:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "diagnostics.demag_tangent_operator_source must identify the GPU dynamic-demag tangent operator when operator_terms_included contains demag"
        )
    manifest_diagnostics = manifest.get("diagnostics")
    if not isinstance(manifest_diagnostics, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.diagnostics must be an object"
        )
    require_equal(
        manifest_diagnostics.get("demag_tangent_operator_source"),
        source,
        "manifest.diagnostics.demag_tangent_operator_source",
    )
    manifest_terms_value = manifest_diagnostics.get("operator_terms_included")
    if manifest_terms_value is not None:
        manifest_terms = require_string_list(
            manifest_terms_value,
            "manifest.diagnostics.operator_terms_included",
        )
        if "demag" not in manifest_terms:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.diagnostics.operator_terms_included must include demag when diagnostics.operator_terms_included includes demag"
            )


def require_progress_json_checkpoint(progress: dict, artifact_name: str = "progress") -> dict:
    raw_progress_json = progress.get("progress_json")
    if not isinstance(raw_progress_json, str) or not raw_progress_json.strip():
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{artifact_name}.progress_json must be a non-empty serialized checkpoint object"
        )
    try:
        progress_json = json.loads(raw_progress_json)
    except json.JSONDecodeError as exc:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{artifact_name}.progress_json must be valid JSON: {exc}"
        ) from exc
    if not isinstance(progress_json, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{artifact_name}.progress_json must decode to an object"
        )
    expected = {
        f"{artifact_name}.progress_json.schema_version": (
            progress_json.get("schema_version"),
            "frequency_domain_sweep_progress.v1",
        ),
        f"{artifact_name}.progress_json.state": (
            progress_json.get("state"),
            progress.get("state"),
        ),
        f"{artifact_name}.progress_json.status": (
            progress_json.get("status"),
            progress.get("status"),
        ),
        f"{artifact_name}.progress_json.complete": (
            progress_json.get("complete"),
            progress.get("complete"),
        ),
        f"{artifact_name}.progress_json.total_frequency_points": (
            progress_json.get("total_frequency_points"),
            progress.get("total_frequency_points"),
        ),
        f"{artifact_name}.progress_json.completed_frequency_points": (
            progress_json.get("completed_frequency_points"),
            progress.get("completed_frequency_points"),
        ),
        f"{artifact_name}.progress_json.written_frequency_point_artifacts": (
            progress_json.get("written_frequency_point_artifacts"),
            progress.get("written_frequency_point_artifacts"),
        ),
        f"{artifact_name}.progress_json.partial_artifacts_available": (
            progress_json.get("partial_artifacts_available"),
            progress.get("partial_artifacts_available"),
        ),
        f"{artifact_name}.progress_json.latest_artifact_manifest_path": (
            progress_json.get("latest_artifact_manifest_path"),
            progress.get("latest_artifact_manifest_path"),
        ),
    }
    if "current_frequency_hz" in progress_json:
        expected[f"{artifact_name}.progress_json.current_frequency_hz"] = (
            progress_json.get("current_frequency_hz"),
            progress.get("current_frequency_hz"),
        )
    for optional_key in ("frequency_min_hz", "frequency_max_hz", "demag_mode"):
        if optional_key in progress or optional_key in progress_json:
            expected[f"{artifact_name}.progress_json.{optional_key}"] = (
                progress_json.get(optional_key),
                progress.get(optional_key),
            )
    require_expected(expected)
    return progress_json


def require_frozen_magnetic_submesh_mode(manifest: dict) -> None:
    expected = "generated_frozen_magnetic_submesh"
    candidates: list[tuple[str, object]] = [
        ("manifest.domain_mesh_mode", manifest.get("domain_mesh_mode")),
    ]
    for section_name in ("diagnostics", "physics", "mesh"):
        section = manifest.get(section_name)
        if isinstance(section, dict):
            candidates.append(
                (f"manifest.{section_name}.domain_mesh_mode", section.get("domain_mesh_mode"))
            )
    if any(value == expected for _name, value in candidates):
        return
    observed = ", ".join(
        f"{name}={value!r}" for name, value in candidates if value is not None
    )
    if not observed:
        observed = "no domain_mesh_mode metadata found"
    raise SystemExit(
        "invalid frequency-domain runtime artifacts:\n"
        f"frozen magnetic submesh boundary requires {expected!r}; {observed}"
    )


def require_field_payload_metadata(
    root: Path,
    point: dict,
    point_name: str,
    expected_payload_path: str,
) -> None:
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
    if point.get("storage_format") == "zarr":
        if complex_pair_count % 3 != 0:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"{point_name}.complex_pair_count must be divisible by 3 for global_xyz Zarr payloads"
            )
        sample_count = complex_pair_count // 3
        require_equal(
            point.get("zarr_chunk_path"),
            expected_payload_path,
            f"{point_name}.zarr_chunk_path",
        )
        zarr_array_path = require_non_empty_string(
            point.get("zarr_array_path"),
            f"{point_name}.zarr_array_path",
        )
        require_equal(point.get("zarr_dtype"), "<f8", f"{point_name}.zarr_dtype")
        require_equal(
            point.get("zarr_shape"),
            [sample_count, 3, 2],
            f"{point_name}.zarr_shape",
        )
        require_equal(
            point.get("zarr_chunk_shape"),
            [max(sample_count, 1), 3, 2],
            f"{point_name}.zarr_chunk_shape",
        )
        zarray_path = root / zarr_array_path / ".zarray"
        if not zarray_path.is_file():
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"missing Zarr array metadata: {zarr_array_path}/.zarray"
            )
        zarray = load_json(zarray_path)
        require_equal(zarray.get("zarr_format"), 2, f"{point_name}.zarray.zarr_format")
        require_equal(
            zarray.get("shape"),
            [sample_count, 3, 2],
            f"{point_name}.zarray.shape",
        )
        require_equal(
            zarray.get("chunks"),
            [max(sample_count, 1), 3, 2],
            f"{point_name}.zarray.chunks",
        )
        require_equal(zarray.get("dtype"), "<f8", f"{point_name}.zarray.dtype")


def require_response_zarr_store(root: Path) -> None:
    store_root = root / "response/field_payloads.zarr"
    zgroup_path = store_root / ".zgroup"
    zattrs_path = store_root / ".zattrs"
    if not zgroup_path.is_file():
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "missing Zarr store metadata: response/field_payloads.zarr/.zgroup"
        )
    if not zattrs_path.is_file():
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "missing Zarr store metadata: response/field_payloads.zarr/.zattrs"
        )
    zgroup = load_json(zgroup_path)
    require_equal(zgroup.get("zarr_format"), 2, "field_payloads.zarr/.zgroup.zarr_format")
    zattrs = load_json(zattrs_path)
    require_equal(
        zattrs.get("fullmag_kind"),
        "frequency_domain_response_field_store",
        "field_payloads.zarr/.zattrs.fullmag_kind",
    )
    require_equal(zattrs.get("schema_version"), 1, "field_payloads.zarr/.zattrs.schema_version")
    require_equal(
        zattrs.get("preferred_container"),
        "zarr",
        "field_payloads.zarr/.zattrs.preferred_container",
    )
    require_equal(
        require_string_list(
            zattrs.get("quantity_ids"),
            "field_payloads.zarr/.zattrs.quantity_ids",
        ),
        ["dynamic_response"],
        "field_payloads.zarr/.zattrs.quantity_ids",
    )
    require_equal(
        zattrs.get("compatibility_binary_exports"),
        True,
        "field_payloads.zarr/.zattrs.compatibility_binary_exports",
    )


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


def parity_fail(message: str) -> None:
    raise SystemExit(
        "invalid frequency-domain runtime artifacts:\n"
        f"CPU/GPU parity {message}"
    )


def floquet_reciprocal_fail(message: str) -> None:
    raise SystemExit(
        "invalid frequency-domain runtime artifacts:\n"
        f"Floquet reciprocal {message}"
    )


def airbox_z_padding_fail(message: str) -> None:
    raise SystemExit(
        "invalid frequency-domain runtime artifacts:\n"
        f"airbox z-padding {message}"
    )


def require_airbox_z_padding_equal(
    target: object,
    reference: object,
    name: str,
) -> None:
    if target != reference:
        airbox_z_padding_fail(
            f"magnetic mesh invariant mismatch at {name}: "
            f"target={target!r}, reference={reference!r}; "
            "airbox comparison requires identical magnetic operator invariants "
            "so response drift is not mixed with remeshing"
        )


def compare_numeric_value(
    target: object,
    reference: object,
    name: str,
    *,
    abs_tol: float = CPU_GPU_PARITY_ABS_TOL,
    rel_tol: float = CPU_GPU_PARITY_REL_TOL,
    fail=parity_fail,
    target_label: str = "GPU",
    reference_label: str = "CPU",
) -> None:
    if isinstance(target, (int, float)) and isinstance(reference, (int, float)):
        target_value = float(target)
        reference_value = float(reference)
        if not math.isfinite(target_value) or not math.isfinite(reference_value):
            fail(f"{name} contains a non-finite value")
        tolerance = abs_tol + rel_tol * max(abs(target_value), abs(reference_value))
        difference = abs(target_value - reference_value)
        if difference > tolerance:
            fail(
                f"mismatch at {name}: {target_label}={target_value:.17g}, "
                f"{reference_label}={reference_value:.17g}, diff={difference:.17g}, "
                f"tol={tolerance:.17g}"
            )
        return
    if isinstance(target, list) and isinstance(reference, list):
        if len(target) != len(reference):
            fail(
                f"length mismatch at {name}: "
                f"{target_label}={len(target)}, {reference_label}={len(reference)}"
            )
        for index, (target_item, reference_item) in enumerate(zip(target, reference)):
            compare_numeric_value(
                target_item,
                reference_item,
                f"{name}[{index}]",
                abs_tol=abs_tol,
                rel_tol=rel_tol,
                fail=fail,
                target_label=target_label,
                reference_label=reference_label,
            )
        return
    fail(
        f"type mismatch at {name}: {target_label}={type(target).__name__}, "
        f"{reference_label}={type(reference).__name__}"
    )


def require_cpu_gpu_parity_reference(
    target_root: Path,
    reference_root: Path,
    *,
    target_manifest: dict,
    target_diagnostics: dict,
    target_sweep: dict,
) -> None:
    required = [
        reference_root / "response/progress.v1.json",
        reference_root / "response/diagnostics/solver.v1.json",
        reference_root / "response/magnetic_response_sweep.v2.json",
        reference_root / "frequency_domain/manifest.v1.json",
    ]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        parity_fail("reference bundle is missing required artifacts:\n" + "\n".join(missing))

    reference_progress = load_json(reference_root / "response/progress.v1.json")
    reference_diagnostics = load_json(reference_root / "response/diagnostics/solver.v1.json")
    reference_manifest = load_json(reference_root / "frequency_domain/manifest.v1.json")
    reference_sweep = load_json(reference_root / "response/magnetic_response_sweep.v2.json")

    if reference_manifest.get("status") != "ready" or reference_manifest.get("complete") is not True:
        parity_fail("reference CPU bundle must be a completed ready solve")
    if reference_progress.get("complete") is not True:
        parity_fail("reference CPU progress must be complete")
    reference_resolved = reference_manifest.get("resolved_execution", {})
    if not isinstance(reference_resolved, dict):
        parity_fail("reference manifest.resolved_execution must be an object")
    if reference_resolved.get("requested_execution_lane") != "production_cpu":
        parity_fail("reference bundle must use production_cpu execution lane")
    if reference_diagnostics.get("validation_fallback_used") is not False:
        parity_fail("reference CPU bundle must not use validation fallback")
    if target_diagnostics.get("validation_fallback_used") is not False:
        parity_fail("GPU target bundle must not use validation fallback")
    if target_manifest.get("resolved_execution", {}).get("requested_execution_lane") != "production_gpu":
        parity_fail("target bundle must use production_gpu execution lane")

    target_count = target_sweep.get("completed_frequency_point_count")
    reference_count = reference_sweep.get("completed_frequency_point_count")
    if target_count != reference_count:
        parity_fail(
            f"frequency point count mismatch: GPU={target_count!r}, CPU={reference_count!r}"
        )
    if target_diagnostics.get("static_periodic_node_pair_count") != reference_diagnostics.get(
        "static_periodic_node_pair_count"
    ):
        parity_fail(
            "static_periodic_node_pair_count mismatch: "
            f"GPU={target_diagnostics.get('static_periodic_node_pair_count')!r}, "
            f"CPU={reference_diagnostics.get('static_periodic_node_pair_count')!r}"
        )

    target_paths = require_string_list(
        target_sweep.get("frequency_point_artifact_paths"),
        "target sweep.frequency_point_artifact_paths",
    )
    reference_paths = require_string_list(
        reference_sweep.get("frequency_point_artifact_paths"),
        "reference sweep.frequency_point_artifact_paths",
    )
    if len(target_paths) != len(reference_paths):
        parity_fail(
            f"frequency point path count mismatch: GPU={len(target_paths)}, CPU={len(reference_paths)}"
        )

    compare_keys = [
        "frequency_hz",
        "angular_frequency_rad_per_s",
        "m_complex",
        "component_response_amplitude",
        "component_response_phase",
        "response_amplitude",
        "response_phase",
        "phase_rad",
        "susceptibility_tensor",
        "absorbed_power_density",
    ]
    for index, (target_path, reference_path) in enumerate(zip(target_paths, reference_paths)):
        target_point = load_json(target_root / target_path)
        reference_point = load_json(reference_root / reference_path)
        for key in compare_keys:
            compare_numeric_value(
                target_point.get(key),
                reference_point.get(key),
                f"frequency[{index}].{key}",
            )


def load_floquet_reciprocal_reference_bundle(reference_root: Path) -> tuple[dict, dict, dict, dict]:
    required = [
        reference_root / "response/progress.v1.json",
        reference_root / "response/diagnostics/solver.v1.json",
        reference_root / "response/magnetic_response_sweep.v2.json",
        reference_root / "frequency_domain/manifest.v1.json",
    ]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        floquet_reciprocal_fail(
            "reference bundle is missing required artifacts:\n" + "\n".join(missing)
        )

    reference_progress = load_json(reference_root / "response/progress.v1.json")
    reference_diagnostics = load_json(
        reference_root / "response/diagnostics/solver.v1.json"
    )
    reference_manifest = load_json(reference_root / "frequency_domain/manifest.v1.json")
    reference_sweep = load_json(reference_root / "response/magnetic_response_sweep.v2.json")

    if reference_manifest.get("status") != "ready" or reference_manifest.get("complete") is not True:
        floquet_reciprocal_fail("reference bundle must be a completed ready solve")
    if reference_progress.get("complete") is not True:
        floquet_reciprocal_fail("reference progress must be complete")
    if reference_manifest.get("resolved_execution", {}).get("requested_execution_lane") != "production_gpu":
        floquet_reciprocal_fail("reference bundle must use production_gpu execution lane")
    if reference_diagnostics.get("validation_fallback_used") is not False:
        floquet_reciprocal_fail("reference bundle must not use validation fallback")

    if not require_floquet_phase_projection_diagnostics(
        reference_diagnostics,
        reference_manifest,
    ):
        floquet_reciprocal_fail("reference bundle must use Floquet phase projection")
    require_floquet_periodic_pairs_artifact(
        reference_root,
        reference_diagnostics,
        reference_manifest,
    )
    return (
        reference_progress,
        reference_diagnostics,
        reference_manifest,
        reference_sweep,
    )


def require_exchange_only_floquet_terms(diagnostics: dict, name: str) -> None:
    operator_terms = require_string_list(
        diagnostics.get("operator_terms_included"),
        f"{name}.diagnostics.operator_terms_included",
    )
    if "exchange" not in operator_terms:
        floquet_reciprocal_fail(
            f"{name} diagnostics.operator_terms_included must include exchange"
        )
    unsupported_terms = {"demag", "dmi", "bulk_dmi", "interfacial_dmi"}
    present_unsupported = sorted(term for term in operator_terms if term in unsupported_terms)
    if present_unsupported:
        floquet_reciprocal_fail(
            f"{name} bundle is not exchange-only: unsupported operator terms "
            f"{present_unsupported!r}"
        )


def require_floquet_reciprocal_reference(
    target_root: Path,
    reference_root: Path,
    *,
    target_manifest: dict,
    target_diagnostics: dict,
    target_sweep: dict,
) -> None:
    _, reference_diagnostics, reference_manifest, reference_sweep = (
        load_floquet_reciprocal_reference_bundle(reference_root)
    )

    if target_manifest.get("resolved_execution", {}).get("requested_execution_lane") != "production_gpu":
        floquet_reciprocal_fail("target bundle must use production_gpu execution lane")
    if target_diagnostics.get("validation_fallback_used") is not False:
        floquet_reciprocal_fail("target bundle must not use validation fallback")
    if not require_floquet_phase_projection_diagnostics(target_diagnostics, target_manifest):
        floquet_reciprocal_fail("target bundle must use Floquet phase projection")

    require_exchange_only_floquet_terms(target_diagnostics, "target")
    require_exchange_only_floquet_terms(reference_diagnostics, "reference")

    target_k = require_three_finite_numbers(
        target_diagnostics.get("floquet_k_vector_rad_per_m"),
        "target.diagnostics.floquet_k_vector_rad_per_m",
    )
    reference_k = require_three_finite_numbers(
        reference_diagnostics.get("floquet_k_vector_rad_per_m"),
        "reference.diagnostics.floquet_k_vector_rad_per_m",
    )
    if math.sqrt(sum(component * component for component in target_k)) <= FLOQUET_RECIPROCAL_K_ABS_TOL:
        floquet_reciprocal_fail("target k-vector must be nonzero")
    compare_numeric_value(
        target_k,
        [-component for component in reference_k],
        "opposite k-vector",
        abs_tol=FLOQUET_RECIPROCAL_K_ABS_TOL,
        rel_tol=FLOQUET_RECIPROCAL_K_REL_TOL,
        fail=floquet_reciprocal_fail,
        target_label="target",
        reference_label="-reference",
    )

    target_count = target_sweep.get("completed_frequency_point_count")
    reference_count = reference_sweep.get("completed_frequency_point_count")
    if target_count != reference_count:
        floquet_reciprocal_fail(
            f"frequency point count mismatch: target={target_count!r}, "
            f"reference={reference_count!r}"
        )

    target_paths = require_string_list(
        target_sweep.get("frequency_point_artifact_paths"),
        "target sweep.frequency_point_artifact_paths",
    )
    reference_paths = require_string_list(
        reference_sweep.get("frequency_point_artifact_paths"),
        "reference sweep.frequency_point_artifact_paths",
    )
    if len(target_paths) != len(reference_paths):
        floquet_reciprocal_fail(
            f"frequency point path count mismatch: target={len(target_paths)}, "
            f"reference={len(reference_paths)}"
        )

    compare_keys = [
        "frequency_hz",
        "angular_frequency_rad_per_s",
        "response_amplitude",
        "component_response_amplitude",
        "absorbed_power_density",
    ]
    for index, (target_path, reference_path) in enumerate(zip(target_paths, reference_paths)):
        target_point = load_json(target_root / target_path)
        reference_point = load_json(reference_root / reference_path)
        for key in compare_keys:
            compare_numeric_value(
                target_point.get(key),
                reference_point.get(key),
                f"frequency[{index}].{key}",
                abs_tol=FLOQUET_RECIPROCAL_ABS_TOL,
                rel_tol=FLOQUET_RECIPROCAL_REL_TOL,
                fail=floquet_reciprocal_fail,
                target_label="target",
                reference_label="reference",
            )


def require_periodic_airbox_airbox_reference(
    target_root: Path,
    reference_root: Path,
    *,
    target_manifest: dict,
    target_diagnostics: dict,
    target_sweep: dict,
) -> None:
    required = [
        reference_root / "response/progress.v1.json",
        reference_root / "response/diagnostics/solver.v1.json",
        reference_root / "response/magnetic_response_sweep.v2.json",
        reference_root / "frequency_domain/manifest.v1.json",
    ]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        airbox_z_padding_fail(
            "reference bundle is missing required artifacts:\n" + "\n".join(missing)
        )

    reference_progress = load_json(reference_root / "response/progress.v1.json")
    reference_diagnostics = load_json(
        reference_root / "response/diagnostics/solver.v1.json"
    )
    reference_manifest = load_json(reference_root / "frequency_domain/manifest.v1.json")
    reference_sweep = load_json(reference_root / "response/magnetic_response_sweep.v2.json")

    if reference_manifest.get("status") != "ready" or reference_manifest.get("complete") is not True:
        airbox_z_padding_fail("reference bundle must be a completed ready solve")
    if reference_progress.get("complete") is not True:
        airbox_z_padding_fail("reference progress must be complete")
    if reference_manifest.get("resolved_execution", {}).get("requested_execution_lane") != "production_cpu":
        airbox_z_padding_fail("reference bundle must use production_cpu execution lane")
    if target_manifest.get("resolved_execution", {}).get("requested_execution_lane") != "production_cpu":
        airbox_z_padding_fail("target bundle must use production_cpu execution lane")
    if reference_diagnostics.get("validation_fallback_used") is not False:
        airbox_z_padding_fail("reference bundle must not use validation fallback")
    if target_diagnostics.get("validation_fallback_used") is not False:
        airbox_z_padding_fail("target bundle must not use validation fallback")

    target_physics = target_manifest.get("physics")
    reference_physics = reference_manifest.get("physics")
    if not isinstance(target_physics, dict) or not isinstance(reference_physics, dict):
        airbox_z_padding_fail("target and reference manifests must contain physics objects")
    for name, target_value, reference_value in (
        (
            "manifest.physics.delta_m_tangent_dof_count",
            target_physics.get("delta_m_tangent_dof_count"),
            reference_physics.get("delta_m_tangent_dof_count"),
        ),
        (
            "diagnostics.delta_m_tangent_dof_count",
            target_diagnostics.get("delta_m_tangent_dof_count"),
            reference_diagnostics.get("delta_m_tangent_dof_count"),
        ),
        (
            "manifest.physics.magnetic_periodic_constraint_set_count",
            target_physics.get("magnetic_periodic_constraint_set_count"),
            reference_physics.get("magnetic_periodic_constraint_set_count"),
        ),
        (
            "diagnostics.magnetic_periodic_constraint_set_count",
            target_diagnostics.get("magnetic_periodic_constraint_set_count"),
            reference_diagnostics.get("magnetic_periodic_constraint_set_count"),
        ),
        (
            "manifest.diagnostics.exchange_edge_count",
            target_manifest.get("diagnostics", {}).get("exchange_edge_count"),
            reference_manifest.get("diagnostics", {}).get("exchange_edge_count"),
        ),
        (
            "diagnostics.exchange_edge_count",
            target_diagnostics.get("exchange_edge_count"),
            reference_diagnostics.get("exchange_edge_count"),
        ),
    ):
        require_airbox_z_padding_equal(target_value, reference_value, name)

    require_periodic_airbox_cpu_demag_solved_boundary(
        reference_root,
        diagnostics=reference_diagnostics,
        manifest=reference_manifest,
    )
    require_periodic_airbox_cpu_demag_solved_boundary(
        target_root,
        diagnostics=target_diagnostics,
        manifest=target_manifest,
    )

    target_count = target_sweep.get("completed_frequency_point_count")
    reference_count = reference_sweep.get("completed_frequency_point_count")
    if target_count != reference_count:
        airbox_z_padding_fail(
            f"frequency point count mismatch: target={target_count!r}, "
            f"reference={reference_count!r}"
        )

    target_paths = require_string_list(
        target_sweep.get("frequency_point_artifact_paths"),
        "target sweep.frequency_point_artifact_paths",
    )
    reference_paths = require_string_list(
        reference_sweep.get("frequency_point_artifact_paths"),
        "reference sweep.frequency_point_artifact_paths",
    )
    if len(target_paths) != len(reference_paths):
        airbox_z_padding_fail(
            f"frequency point path count mismatch: target={len(target_paths)}, "
            f"reference={len(reference_paths)}"
        )

    peak_target: tuple[float, float] | None = None
    peak_reference: tuple[float, float] | None = None
    for index, (target_path, reference_path) in enumerate(zip(target_paths, reference_paths)):
        target_point = load_json(target_root / target_path)
        reference_point = load_json(reference_root / reference_path)
        for key in ("frequency_hz", "angular_frequency_rad_per_s"):
            compare_numeric_value(
                target_point.get(key),
                reference_point.get(key),
                f"frequency[{index}].{key}",
                abs_tol=AIRBOX_Z_PADDING_FREQUENCY_ABS_TOL,
                rel_tol=AIRBOX_Z_PADDING_FREQUENCY_REL_TOL,
                fail=airbox_z_padding_fail,
                target_label="target",
                reference_label="reference",
            )
        require_airbox_z_padding_equal(
            target_point.get("delta_m_tangent_dof_count"),
            reference_point.get("delta_m_tangent_dof_count"),
            f"frequency[{index}].delta_m_tangent_dof_count",
        )
        compare_numeric_value(
            target_point.get("response_amplitude"),
            reference_point.get("response_amplitude"),
            f"frequency[{index}].response_amplitude",
            abs_tol=AIRBOX_Z_PADDING_RESPONSE_ABS_TOL,
            rel_tol=AIRBOX_Z_PADDING_RESPONSE_REL_TOL,
            fail=airbox_z_padding_fail,
            target_label="target",
            reference_label="reference",
        )
        target_amplitude = target_point.get("response_amplitude")
        reference_amplitude = reference_point.get("response_amplitude")
        target_frequency = target_point.get("frequency_hz")
        reference_frequency = reference_point.get("frequency_hz")
        if (
            isinstance(target_amplitude, (int, float))
            and isinstance(target_frequency, (int, float))
            and (peak_target is None or float(target_amplitude) > peak_target[1])
        ):
            peak_target = (float(target_frequency), float(target_amplitude))
        if (
            isinstance(reference_amplitude, (int, float))
            and isinstance(reference_frequency, (int, float))
            and (peak_reference is None or float(reference_amplitude) > peak_reference[1])
        ):
            peak_reference = (float(reference_frequency), float(reference_amplitude))

    if peak_target is None or peak_reference is None:
        airbox_z_padding_fail("cannot identify response peak")
    compare_numeric_value(
        peak_target[0],
        peak_reference[0],
        "response_peak.frequency_hz",
        abs_tol=AIRBOX_Z_PADDING_FREQUENCY_ABS_TOL,
        rel_tol=AIRBOX_Z_PADDING_FREQUENCY_REL_TOL,
        fail=airbox_z_padding_fail,
        target_label="target",
        reference_label="reference",
    )
    compare_numeric_value(
        peak_target[1],
        peak_reference[1],
        "response_peak.response_amplitude",
        abs_tol=AIRBOX_Z_PADDING_RESPONSE_ABS_TOL,
        rel_tol=AIRBOX_Z_PADDING_RESPONSE_REL_TOL,
        fail=airbox_z_padding_fail,
        target_label="target",
        reference_label="reference",
    )


def require_periodic_airbox_gpu_unavailable_boundary(
    root: Path,
    *,
    diagnostics: dict,
    manifest: dict,
    requested_execution: dict,
    resolved_execution: dict,
    manifest_artifacts: dict,
    requested_frequency_count: int,
) -> None:
    reason = "periodic_airbox_dynamic_demag_gpu_unsupported"
    manifest_diagnostics = manifest.get("diagnostics")
    if not isinstance(manifest_diagnostics, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.diagnostics must be an object"
        )
    physics = manifest.get("physics")
    if not isinstance(physics, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.physics must be an object"
        )
    expected = {
        "diagnostics.requested_execution_lane": (
            diagnostics.get("requested_execution_lane"),
            "production_gpu",
        ),
        "diagnostics.resolved_execution_lane": (
            diagnostics.get("resolved_execution_lane"),
            "unavailable",
        ),
        "diagnostics.unsupported_reason": (
            diagnostics.get("unsupported_reason"),
            reason,
        ),
        "diagnostics.validation_fallback_used": (
            diagnostics.get("validation_fallback_used"),
            False,
        ),
        "diagnostics.periodic_airbox_coupled_block_solver": (
            diagnostics.get("periodic_airbox_coupled_block_solver"),
            False,
        ),
        "diagnostics.mfem_coupled_block_assembly": (
            diagnostics.get("mfem_coupled_block_assembly"),
            False,
        ),
        "diagnostics.requested_magnetostatic_bc": (
            diagnostics.get("requested_magnetostatic_bc"),
            "periodic_airbox_k0",
        ),
        "diagnostics.resolved_magnetostatic_bc": (
            diagnostics.get("resolved_magnetostatic_bc"),
            "periodic_airbox_k0",
        ),
        "manifest.resolved_execution.requested_execution_lane": (
            resolved_execution.get("requested_execution_lane"),
            "production_gpu",
        ),
        "manifest.resolved_execution.resolved_execution_lane": (
            resolved_execution.get("resolved_execution_lane"),
            "unavailable",
        ),
        "manifest.resolved_execution.lane_classification": (
            resolved_execution.get("lane_classification"),
            "fem_gpu_production",
        ),
        "manifest.diagnostics.requested_execution_lane": (
            manifest_diagnostics.get("requested_execution_lane"),
            "production_gpu",
        ),
        "manifest.diagnostics.resolved_execution_lane": (
            manifest_diagnostics.get("resolved_execution_lane"),
            "unavailable",
        ),
        "manifest.diagnostics.unsupported_reason": (
            manifest_diagnostics.get("unsupported_reason"),
            reason,
        ),
        "manifest.diagnostics.validation_fallback_used": (
            manifest_diagnostics.get("validation_fallback_used"),
            False,
        ),
        "manifest.diagnostics.periodic_airbox_coupled_block_solver": (
            manifest_diagnostics.get("periodic_airbox_coupled_block_solver"),
            False,
        ),
        "manifest.physics.spin_wave_bc.kind": (
            physics.get("spin_wave_bc", {}).get("kind")
            if isinstance(physics.get("spin_wave_bc"), dict)
            else None,
            "periodic",
        ),
        "manifest.physics.periodic_or_floquet": (
            physics.get("periodic_or_floquet"),
            True,
        ),
        "manifest.physics.requested_magnetostatic_bc": (
            physics.get("requested_magnetostatic_bc"),
            "periodic_airbox_k0",
        ),
        "manifest.physics.resolved_magnetostatic_bc": (
            physics.get("resolved_magnetostatic_bc"),
            "periodic_airbox_k0",
        ),
        "manifest.artifacts.periodic_pairs_v1_path": (
            manifest_artifacts.get("periodic_pairs_v1_path"),
            "mesh/periodic_pairs.v1.json",
        ),
    }
    require_expected(expected)
    if requested_execution.get("write_response_fields") is not True:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "periodic-airbox GPU unavailable boundary must preserve requested response-field writes"
        )
    for field_name in [
        "magnetic_periodic_constraint_set_count",
        "magnetostatic_periodic_constraint_set_count",
        "delta_m_tangent_dof_count",
        "delta_phi_dof_count",
        "magnetostatic_periodic_node_pair_count",
    ]:
        require_positive_integer(diagnostics.get(field_name), f"diagnostics.{field_name}")
        require_positive_integer(
            physics.get(field_name),
            f"manifest.physics.{field_name}",
        )

    frequency_point_paths = require_string_list(
        manifest_artifacts.get("frequency_point_paths"),
        "manifest.artifacts.frequency_point_paths",
    )
    if len(frequency_point_paths) != requested_frequency_count:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "periodic-airbox GPU unavailable boundary must publish one unavailable point artifact per requested frequency"
        )
    for index, point_path in enumerate(frequency_point_paths):
        point_file = root / point_path
        if not point_file.is_file():
            raise SystemExit(
                "missing required frequency-domain runtime artifacts:\n"
                f"{point_file}"
            )
        point = load_json(point_file)
        point_name = f"frequency_point[{index}]"
        point_expected = {
            f"{point_name}.status": (point.get("status"), "unavailable"),
            f"{point_name}.complete": (point.get("complete"), False),
            f"{point_name}.requested_magnetostatic_bc": (
                point.get("requested_magnetostatic_bc"),
                "periodic_airbox_k0",
            ),
            f"{point_name}.resolved_magnetostatic_bc": (
                point.get("resolved_magnetostatic_bc"),
                "periodic_airbox_k0",
            ),
        }
        require_expected(point_expected)
        demag_contribution = point.get("demag_contribution")
        if not isinstance(demag_contribution, dict):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"{point_name}.demag_contribution must be an object"
            )
        require_expected(
            {
                f"{point_name}.demag_contribution.status": (
                    demag_contribution.get("status"),
                    "unavailable",
                ),
                f"{point_name}.demag_contribution.unsupported_reason": (
                    demag_contribution.get("unsupported_reason"),
                    reason,
                ),
                f"{point_name}.demag_contribution.mfem_coupled_block_assembly": (
                    demag_contribution.get("mfem_coupled_block_assembly"),
                    False,
                ),
            }
        )

    periodic_pairs_file = root / "mesh/periodic_pairs.v1.json"
    if not periodic_pairs_file.is_file():
        raise SystemExit(
            "missing required frequency-domain runtime artifacts:\n"
            f"{periodic_pairs_file}"
        )
    periodic_pairs = load_json(periodic_pairs_file)
    require_expected(
        {
            "mesh.periodic_pairs.schema_version": (
                periodic_pairs.get("schema_version"),
                "periodic_pairs.v1",
            ),
            "mesh.periodic_pairs.source": (
                periodic_pairs.get("source"),
                "native_fem_frequency_domain_unavailable",
            ),
            "mesh.periodic_pairs.validation_status": (
                periodic_pairs.get("validation_status"),
                "unavailable",
            ),
            "mesh.periodic_pairs.unsupported_reason": (
                periodic_pairs.get("unsupported_reason"),
                reason,
            ),
        }
    )
    require_positive_integer(periodic_pairs.get("pair_count"), "mesh.periodic_pairs.pair_count")


def require_floquet_airbox_gpu_unavailable_boundary(
    root: Path,
    *,
    diagnostics: dict,
    manifest: dict,
    requested_execution: dict,
    resolved_execution: dict,
    manifest_artifacts: dict,
    requested_frequency_count: int,
) -> None:
    reason = "floquet_airbox_dynamic_demag_gpu_unsupported"
    manifest_diagnostics = manifest.get("diagnostics")
    if not isinstance(manifest_diagnostics, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.diagnostics must be an object"
        )
    physics = manifest.get("physics")
    if not isinstance(physics, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.physics must be an object"
        )
    spin_wave_bc = physics.get("spin_wave_bc")
    expected = {
        "diagnostics.requested_execution_lane": (
            diagnostics.get("requested_execution_lane"),
            "production_gpu",
        ),
        "diagnostics.resolved_execution_lane": (
            diagnostics.get("resolved_execution_lane"),
            "unavailable",
        ),
        "diagnostics.unsupported_reason": (
            diagnostics.get("unsupported_reason"),
            reason,
        ),
        "diagnostics.validation_fallback_used": (
            diagnostics.get("validation_fallback_used"),
            False,
        ),
        "diagnostics.periodic_airbox_coupled_block_solver": (
            diagnostics.get("periodic_airbox_coupled_block_solver"),
            False,
        ),
        "diagnostics.mfem_coupled_block_assembly": (
            diagnostics.get("mfem_coupled_block_assembly"),
            False,
        ),
        "diagnostics.requested_magnetostatic_bc": (
            diagnostics.get("requested_magnetostatic_bc"),
            "floquet_airbox",
        ),
        "diagnostics.resolved_magnetostatic_bc": (
            diagnostics.get("resolved_magnetostatic_bc"),
            "floquet_airbox",
        ),
        "manifest.diagnostics.requested_execution_lane": (
            manifest_diagnostics.get(
                "requested_execution_lane",
                diagnostics.get("requested_execution_lane"),
            ),
            "production_gpu",
        ),
        "manifest.diagnostics.resolved_execution_lane": (
            manifest_diagnostics.get(
                "resolved_execution_lane",
                diagnostics.get("resolved_execution_lane", "unavailable"),
            ),
            "unavailable",
        ),
        "manifest.diagnostics.unsupported_reason": (
            manifest_diagnostics.get(
                "unsupported_reason",
                manifest.get("unsupported_reason"),
            ),
            reason,
        ),
        "manifest.diagnostics.validation_fallback_used": (
            manifest_diagnostics.get(
                "validation_fallback_used",
                manifest.get("capabilities", {}).get("validation_fallback_used")
                if isinstance(manifest.get("capabilities"), dict)
                else None,
            ),
            False,
        ),
        "manifest.diagnostics.periodic_airbox_coupled_block_solver": (
            manifest_diagnostics.get(
                "periodic_airbox_coupled_block_solver",
                diagnostics.get("periodic_airbox_coupled_block_solver", False),
            ),
            False,
        ),
        "manifest.physics.spin_wave_bc.kind": (
            spin_wave_bc.get("kind") if isinstance(spin_wave_bc, dict) else None,
            "floquet",
        ),
        "manifest.physics.periodic_or_floquet": (
            physics.get("periodic_or_floquet"),
            True,
        ),
        "manifest.physics.requested_magnetostatic_bc": (
            physics.get("requested_magnetostatic_bc"),
            "floquet_airbox",
        ),
        "manifest.physics.resolved_magnetostatic_bc": (
            physics.get("resolved_magnetostatic_bc"),
            "floquet_airbox",
        ),
        "manifest.artifacts.periodic_pairs_v1_path": (
            manifest_artifacts.get("periodic_pairs_v1_path"),
            "mesh/periodic_pairs.v1.json",
        ),
    }
    require_expected(expected)
    if requested_execution.get("write_response_fields") is not True:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "Floquet-airbox GPU unavailable boundary must preserve requested response-field writes"
        )
    for field_name in [
        "magnetic_periodic_constraint_set_count",
        "magnetostatic_periodic_constraint_set_count",
        "delta_m_tangent_dof_count",
        "delta_phi_dof_count",
        "magnetostatic_periodic_node_pair_count",
        "floquet_periodic_pair_count",
    ]:
        require_positive_integer(diagnostics.get(field_name), f"diagnostics.{field_name}")

    k_vector = require_three_finite_numbers(
        diagnostics.get("floquet_k_vector_rad_per_m"),
        "diagnostics.floquet_k_vector_rad_per_m",
    )
    manifest_k_vector = manifest_diagnostics.get("floquet_k_vector_rad_per_m")
    if manifest_k_vector != k_vector:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.diagnostics.floquet_k_vector_rad_per_m must match diagnostics.floquet_k_vector_rad_per_m"
        )
    flux_status = diagnostics.get("delta_phi_flux_validation_status")
    if flux_status != "not_evaluated":
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "diagnostics.delta_phi_flux_validation_status must be not_evaluated"
        )
    require_equal(
        diagnostics.get("delta_phi_flux_validation_reason"),
        reason,
        "diagnostics.delta_phi_flux_validation_reason",
    )

    frequency_point_paths = require_string_list(
        manifest_artifacts.get("frequency_point_paths"),
        "manifest.artifacts.frequency_point_paths",
    )
    if frequency_point_paths:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "Floquet-airbox GPU unavailable boundary must not publish frequency point artifacts before the demag-k operator exists"
        )

    periodic_pairs_file = root / "mesh/periodic_pairs.v1.json"
    if not periodic_pairs_file.is_file():
        raise SystemExit(
            "missing required frequency-domain runtime artifacts:\n"
            f"{periodic_pairs_file}"
        )
    periodic_pairs = load_json(periodic_pairs_file)
    require_expected(
        {
            "mesh.periodic_pairs.schema_version": (
                periodic_pairs.get("schema_version"),
                "periodic_pairs.v1",
            ),
            "mesh.periodic_pairs.source": (
                periodic_pairs.get("source"),
                "native_fem_frequency_domain_floquet_airbox_unavailable",
            ),
            "mesh.periodic_pairs.validation_status": (
                periodic_pairs.get("validation_status"),
                "unavailable",
            ),
            "mesh.periodic_pairs.unsupported_reason": (
                periodic_pairs.get("unsupported_reason"),
                reason,
            ),
            "mesh.periodic_pairs.phase_convention": (
                periodic_pairs.get("phase_convention"),
                "exp_minus_i_k_dot_delta_r",
            ),
        }
    )
    pairs = require_object_list(periodic_pairs.get("pairs"), "mesh.periodic_pairs.pairs")
    if not pairs:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "mesh.periodic_pairs.pairs must include delta_phi Floquet pairs"
        )
    for pair_index, pair in enumerate(pairs):
        require_expected(
            {
                f"mesh.periodic_pairs.pairs[{pair_index}].pair_family": (
                    pair.get("pair_family"),
                    "magnetostatic_delta_phi",
                ),
                f"mesh.periodic_pairs.pairs[{pair_index}].unknown_family": (
                    pair.get("unknown_family"),
                    "delta_phi",
                ),
                f"mesh.periodic_pairs.pairs[{pair_index}].phase_validation_status": (
                    pair.get("phase_validation_status", "ok"),
                    "ok",
                ),
            }
        )
        translation = require_three_finite_numbers(
            pair.get("translation_m"),
            f"mesh.periodic_pairs.pairs[{pair_index}].translation_m",
        )
        phase_rad = pair.get("phase_rad")
        require_finite_number(phase_rad, f"mesh.periodic_pairs.pairs[{pair_index}].phase_rad")
        phase_metadata_missing = pair.get("phase_metadata_status") == "missing"
        expected_phase = -sum(k * delta for k, delta in zip(k_vector, translation))
        phase_residual = abs(canonical_phase_residual_rad(float(phase_rad) - expected_phase))
        if not phase_metadata_missing and phase_residual > 1.0e-8:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"mesh.periodic_pairs.pairs[{pair_index}].phase_rad must satisfy -k dot translation; residual={phase_residual}"
            )


def require_periodic_airbox_cpu_demag_solved_boundary(
    root: Path,
    *,
    diagnostics: dict,
    manifest: dict,
    require_frequency_point_artifacts: bool = True,
) -> None:
    manifest_diagnostics = manifest.get("diagnostics")
    if not isinstance(manifest_diagnostics, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.diagnostics must be an object"
        )
    physics = manifest.get("physics")
    if not isinstance(physics, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.physics must be an object"
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
    schur_coupled_block = (
        diagnostics.get("periodic_airbox_coupled_block_solver") is True
        or manifest_diagnostics.get("periodic_airbox_coupled_block_solver") is True
        or resolved_execution.get("periodic_airbox_coupled_block_solver") is True
    )
    expected_operator_field = (
        "dynamic_demag_operator_source"
        if schur_coupled_block
        else "demag_tangent_operator_source"
    )
    expected_operator_source = (
        "matrix_free_mfem_demag_phi_consistency_schur_provider"
        if schur_coupled_block
        else "matrix_free_demag_tangent_provider"
    )
    expected_dynamic_demag_matrix_form = (
        "schur_phi_consistency_provider" if schur_coupled_block else "magnetic_only"
    )
    expected_residual_partition_status = (
        "coupled_block"
        if schur_coupled_block
        else "magnetic_only_demag_tangent_provider"
    )
    expected = {
        "diagnostics.requested_execution_lane": (
            diagnostics.get("requested_execution_lane"),
            "production_cpu",
        ),
        "diagnostics.resolved_execution_lane": (
            diagnostics.get("resolved_execution_lane"),
            "production_cpu",
        ),
        "diagnostics.validation_fallback_used": (
            diagnostics.get("validation_fallback_used"),
            False,
        ),
        "diagnostics.periodic_airbox_coupled_block_solver": (
            diagnostics.get("periodic_airbox_coupled_block_solver"),
            schur_coupled_block,
        ),
        "diagnostics.mfem_coupled_block_assembly": (
            diagnostics.get("mfem_coupled_block_assembly"),
            False,
        ),
        f"diagnostics.{expected_operator_field}": (
            diagnostics.get(expected_operator_field),
            expected_operator_source,
        ),
        "diagnostics.dynamic_demag_matrix_form": (
            diagnostics.get("dynamic_demag_matrix_form"),
            expected_dynamic_demag_matrix_form,
        ),
        "diagnostics.requested_magnetostatic_bc": (
            diagnostics.get("requested_magnetostatic_bc"),
            "periodic_airbox_k0",
        ),
        "diagnostics.resolved_magnetostatic_bc": (
            diagnostics.get("resolved_magnetostatic_bc"),
            "periodic_airbox_k0",
        ),
        "manifest.resolved_execution.requested_execution_lane": (
            resolved_execution.get("requested_execution_lane"),
            "production_cpu",
        ),
        "manifest.resolved_execution.resolved_execution_lane": (
            resolved_execution.get("resolved_execution_lane"),
            "production_cpu",
        ),
        f"manifest.diagnostics.{expected_operator_field}": (
            manifest_diagnostics.get(expected_operator_field),
            expected_operator_source,
        ),
        "manifest.diagnostics.dynamic_demag_matrix_form": (
            manifest_diagnostics.get("dynamic_demag_matrix_form"),
            expected_dynamic_demag_matrix_form,
        ),
        "manifest.resolved_execution.dynamic_demag_matrix_form": (
            resolved_execution.get("dynamic_demag_matrix_form"),
            expected_dynamic_demag_matrix_form,
        ),
        "manifest.capabilities.dynamic_demag_matrix_form": (
            capabilities.get("dynamic_demag_matrix_form"),
            expected_dynamic_demag_matrix_form,
        ),
        "manifest.diagnostics.periodic_airbox_coupled_block_solver": (
            manifest_diagnostics.get("periodic_airbox_coupled_block_solver"),
            schur_coupled_block,
        ),
        "manifest.diagnostics.mfem_coupled_block_assembly": (
            manifest_diagnostics.get("mfem_coupled_block_assembly"),
            False,
        ),
        "manifest.physics.spin_wave_bc.kind": (
            physics.get("spin_wave_bc", {}).get("kind")
            if isinstance(physics.get("spin_wave_bc"), dict)
            else None,
            "periodic",
        ),
        "manifest.physics.periodic_or_floquet": (
            physics.get("periodic_or_floquet"),
            True,
        ),
        "manifest.physics.requested_magnetostatic_bc": (
            physics.get("requested_magnetostatic_bc"),
            "periodic_airbox_k0",
        ),
        "manifest.physics.resolved_magnetostatic_bc": (
            physics.get("resolved_magnetostatic_bc"),
            "periodic_airbox_k0",
        ),
    }
    require_expected(expected)
    exchange_edge_count = require_non_negative_integer(
        diagnostics.get("exchange_edge_count"),
        "diagnostics.exchange_edge_count",
    )
    require_equal(
        manifest_diagnostics.get("exchange_edge_count"),
        exchange_edge_count,
        "manifest.diagnostics.exchange_edge_count",
    )
    expected_preconditioner_variant = (
        "graph_demag_coarse"
        if exchange_edge_count > 0
        else "demag_coarse"
    )
    if schur_coupled_block:
        expected_preconditioner_kind = "mfem_phi_consistency_schur_right"
    else:
        expected_preconditioner_kind = (
            "mfem_tangent_graph_demag_coarse_right"
            if exchange_edge_count > 0
            else "mfem_tangent_demag_coarse_right"
        )
    preconditioner_variant = require_non_empty_string(
        diagnostics.get("krylov_preconditioner_variant"),
        "diagnostics.krylov_preconditioner_variant",
    )
    if preconditioner_variant not in PERIODIC_AIRBOX_CPU_DEMAG_PRECONDITIONER_VARIANTS:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "diagnostics.krylov_preconditioner_variant must be one of "
            f"{sorted(PERIODIC_AIRBOX_CPU_DEMAG_PRECONDITIONER_VARIANTS)!r}"
        )
    require_equal(
        preconditioner_variant,
        expected_preconditioner_variant,
        "diagnostics.krylov_preconditioner_variant",
    )
    require_equal(
        manifest_diagnostics.get("krylov_preconditioner_variant"),
        preconditioner_variant,
        "manifest.diagnostics.krylov_preconditioner_variant",
    )
    for source_name, source in [
        ("diagnostics", diagnostics),
        ("manifest.diagnostics", manifest_diagnostics),
    ]:
        require_equal(
            source.get("krylov_preconditioner_kind"),
            expected_preconditioner_kind,
            f"{source_name}.krylov_preconditioner_kind",
        )
        require_equal(
            source.get("krylov_preconditioner_applied"),
            True,
            f"{source_name}.krylov_preconditioner_applied",
        )
        require_equal(
            source.get("krylov_preconditioner_setup_status"),
            "ok",
            f"{source_name}.krylov_preconditioner_setup_status",
        )
        history = require_finite_number_list(
            source.get("gmres_relative_residual_history"),
            f"{source_name}.gmres_relative_residual_history",
        )
        if len(history) < 2:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"{source_name}.gmres_relative_residual_history must contain at least initial and final residuals"
            )
        max_iterations = require_positive_integer(
            source.get("max_iterations_for_frequency"),
            f"{source_name}.max_iterations_for_frequency",
        )
        restart_iterations = require_positive_integer(
            source.get("restart_iterations_for_frequency"),
            f"{source_name}.restart_iterations_for_frequency",
        )
        if restart_iterations > max_iterations:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"{source_name}.restart_iterations_for_frequency must be <= "
                f"{source_name}.max_iterations_for_frequency"
            )
        require_equal(
            source.get("coupled_residual_partition_status"),
            expected_residual_partition_status,
            f"{source_name}.coupled_residual_partition_status",
        )
        require_coupled_block_norms(
            source.get("coupled_block_norms"),
            f"{source_name}.coupled_block_norms",
        )
        coupled_block_norms = source.get("coupled_block_norms")
        if isinstance(coupled_block_norms, dict):
            require_equal(
                coupled_block_norms.get("rhs_delta_phi_l2_norm"),
                0.0,
                f"{source_name}.coupled_block_norms.rhs_delta_phi_l2_norm",
            )
            require_equal(
                coupled_block_norms.get("relative_residual_delta_phi_l2_norm"),
                0.0,
                f"{source_name}.coupled_block_norms.relative_residual_delta_phi_l2_norm",
            )
        if schur_coupled_block:
            continue
        require_block_norms(
            source.get("block_norms"),
            f"{source_name}.block_norms",
        )
        require_equal(
            source.get("demag_tangent_linearity_check"),
            True,
            f"{source_name}.demag_tangent_linearity_check",
        )
        for field_name in [
            "demag_tangent_additivity_max_abs_error",
            "demag_tangent_homogeneity_max_abs_error",
            "demag_tangent_additivity_relative_error",
            "demag_tangent_homogeneity_relative_error",
        ]:
            require_non_negative_finite_number(
                source.get(field_name),
                f"{source_name}.{field_name}",
            )
    for field_name in [
        "magnetic_periodic_constraint_set_count",
        "magnetostatic_periodic_constraint_set_count",
        "delta_m_tangent_dof_count",
        "delta_phi_dof_count",
        "magnetostatic_periodic_node_pair_count",
    ]:
        require_positive_integer(diagnostics.get(field_name), f"diagnostics.{field_name}")
        require_positive_integer(physics.get(field_name), f"manifest.physics.{field_name}")

    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.artifacts must be an object"
        )
    frequency_point_paths = require_string_list(
        artifacts.get("frequency_point_paths"),
        "manifest.artifacts.frequency_point_paths",
    )
    if not frequency_point_paths:
        if not require_frequency_point_artifacts:
            return
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "periodic-airbox CPU demag solved boundary must publish frequency point artifacts"
        )
    for index, point_path in enumerate(frequency_point_paths):
        point = load_json(root / point_path)
        point_name = f"frequency_point[{index}]"
        require_expected(
            {
                f"{point_name}.requested_magnetostatic_bc": (
                    point.get("requested_magnetostatic_bc"),
                    "periodic_airbox_k0",
                ),
                f"{point_name}.resolved_magnetostatic_bc": (
                    point.get("resolved_magnetostatic_bc"),
                    "periodic_airbox_k0",
                ),
            }
        )
        expected_delta_m_tangent_dof_count = require_positive_integer(
            point.get("delta_m_tangent_dof_count"),
            f"{point_name}.delta_m_tangent_dof_count",
        )
        demag_contribution = point.get("demag_contribution")
        if not isinstance(demag_contribution, dict):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"{point_name}.demag_contribution must be an object"
            )
        require_expected(
            {
                f"{point_name}.demag_contribution.status": (
                    demag_contribution.get("status"),
                    "solved",
                ),
                f"{point_name}.demag_contribution.operator_source": (
                    demag_contribution.get("operator_source"),
                    expected_operator_source,
                ),
                f"{point_name}.demag_contribution.dynamic_demag_matrix_form": (
                    demag_contribution.get("dynamic_demag_matrix_form"),
                    expected_dynamic_demag_matrix_form,
                ),
                f"{point_name}.demag_contribution.mfem_coupled_block_assembly": (
                    demag_contribution.get("mfem_coupled_block_assembly"),
                    False,
                ),
            }
        )
        if demag_contribution.get("unsupported_reason") is not None:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"{point_name}.demag_contribution.unsupported_reason must be null or absent for solved periodic-airbox demag"
            )
        delta_phi_complex = demag_contribution.get("delta_phi_complex")
        if delta_phi_complex is not None:
            require_complex_pair_list(
                delta_phi_complex,
                f"{point_name}.demag_contribution.delta_phi_complex",
            )
        elif schur_coupled_block:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"{point_name}.demag_contribution.delta_phi_complex must be present "
                "for periodic-airbox Schur coupled-block demag"
            )
        h_demag_complex = demag_contribution.get("h_demag_complex")
        if h_demag_complex is None:
            if not schur_coupled_block:
                raise SystemExit(
                    "invalid frequency-domain runtime artifacts:\n"
                    f"{point_name}.demag_contribution.h_demag_complex must be present "
                    "for magnetic-only periodic-airbox demag tangent provider"
                )
        else:
            h_demag_pairs = require_complex_pair_list(
                h_demag_complex,
                f"{point_name}.demag_contribution.h_demag_complex",
            )
            if len(h_demag_pairs) != expected_delta_m_tangent_dof_count:
                raise SystemExit(
                    "invalid frequency-domain runtime artifacts:\n"
                    f"{point_name}.demag_contribution.h_demag_complex length "
                    f"{len(h_demag_pairs)} does not match "
                    f"{point_name}.delta_m_tangent_dof_count "
                    f"{expected_delta_m_tangent_dof_count}"
                )


def resolve_provenance_path(source_root: Path, artifact_path: str) -> Path:
    path = Path(artifact_path)
    if path.is_absolute():
        return path
    return source_root / path


def require_m5_source_json_artifact(
    path: Path,
    name: str,
    expected_schema_version: str,
) -> dict:
    payload = load_json(path)
    if not isinstance(payload, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"{name} must be a JSON object"
        )
    require_equal(
        payload.get("schema_version"),
        expected_schema_version,
        f"{name}.schema_version",
    )
    require_equal(payload.get("status"), "ok", f"{name}.status")
    return payload


def require_m5_equilibrium_provenance_contract(manifest: dict) -> None:
    provenance = manifest.get("equilibrium_provenance")
    if not isinstance(provenance, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.equilibrium_provenance must be an object for M5-gated periodic-airbox response"
        )
    require_expected(
        {
            "manifest.equilibrium_provenance.schema_version": (
                provenance.get("schema_version"),
                "fem_frequency_domain_equilibrium_provenance.v1",
            ),
            "manifest.equilibrium_provenance.acceptance_gate": (
                provenance.get("acceptance_gate"),
                "M5_static_pbc_demag_equilibrium",
            ),
            "manifest.equilibrium_provenance.accepted": (
                provenance.get("accepted"),
                True,
            ),
            "manifest.equilibrium_provenance.source_kind": (
                provenance.get("source_kind"),
                "m5_static_pbc_demag_equilibrium",
            ),
            "manifest.equilibrium_provenance.magnetostatic_bc": (
                provenance.get("magnetostatic_bc"),
                "periodic_airbox_k0",
            ),
        }
    )
    for field_name in [
        "source_artifact_root",
        "equilibrium_field_path",
        "seam_diagnostics_path",
        "z_padding_report_path",
        "supercell_report_path",
    ]:
        require_non_empty_string(
            provenance.get(field_name),
            f"manifest.equilibrium_provenance.{field_name}",
        )
    source_artifact_root = require_non_empty_string(
        provenance.get("source_artifact_root"),
        "manifest.equilibrium_provenance.source_artifact_root",
    )
    source_root = Path(source_artifact_root)
    if not source_root.is_absolute():
        source_root = Path.cwd() / source_root
    if not source_root.is_dir():
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.equilibrium_provenance.source_artifact_root must point to an existing M5 artifact directory"
        )
    resolved_paths: dict[str, Path] = {}
    for field_name in [
        "equilibrium_field_path",
        "seam_diagnostics_path",
        "z_padding_report_path",
        "supercell_report_path",
    ]:
        artifact_path = require_non_empty_string(
            provenance.get(field_name),
            f"manifest.equilibrium_provenance.{field_name}",
        )
        resolved_path = resolve_provenance_path(source_root, artifact_path)
        if not resolved_path.is_file():
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"manifest.equilibrium_provenance.{field_name} must point to an existing M5 artifact file"
            )
        resolved_paths[field_name] = resolved_path
    equilibrium = load_json(resolved_paths["equilibrium_field_path"])
    if not isinstance(equilibrium, dict) or "m" not in equilibrium:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.equilibrium_provenance.equilibrium_field_path must point to a JSON object with field 'm'"
        )
    require_m5_source_json_artifact(
        resolved_paths["seam_diagnostics_path"],
        "manifest.equilibrium_provenance.seam_diagnostics_path",
        "fem_static_pbc_demag_seams.v1",
    )
    require_m5_source_json_artifact(
        resolved_paths["z_padding_report_path"],
        "manifest.equilibrium_provenance.z_padding_report_path",
        "fem_static_pbc_z_padding_validation.v1",
    )
    require_m5_source_json_artifact(
        resolved_paths["supercell_report_path"],
        "manifest.equilibrium_provenance.supercell_report_path",
        "fem_static_pbc_supercell_validation.v1",
    )
    axes = require_string_list(
        provenance.get("pbc_axes"),
        "manifest.equilibrium_provenance.pbc_axes",
    )
    if not axes:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.equilibrium_provenance.pbc_axes must not be empty"
        )


def select_response_peak(sweep_points: list[object]) -> tuple[int, dict, float]:
    selected: tuple[int, dict, float] | None = None
    for index, point in enumerate(sweep_points):
        if not isinstance(point, dict):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"sweep.points[{index}] must be an object"
            )
        amplitude = point.get("max_response_amplitude")
        if amplitude is None:
            amplitude = point.get("response_amplitude")
        require_finite_number(amplitude, f"sweep.points[{index}].response_amplitude")
        amplitude_float = float(amplitude)
        if selected is None or amplitude_float > selected[2]:
            selected = (index, point, amplitude_float)
    if selected is None:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "cannot identify response peak from an empty sweep"
        )
    return selected


def response_peak_refinement_recommendation(
    sweep_points: list[object],
    peak_position_index: int,
) -> dict:
    frequency_hz: list[float] = []
    for index, point in enumerate(sweep_points):
        if not isinstance(point, dict):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"sweep.points[{index}] must be an object"
            )
        frequency = point.get("frequency_hz")
        require_finite_number(frequency, f"sweep.points[{index}].frequency_hz")
        frequency_hz.append(float(frequency))
    count = 5
    if len(frequency_hz) < 2:
        return {
            "schema_version": "frequency_response_peak_refinement.v1",
            "strategy": "local_peak_window",
            "peak_position": "single_point",
            "recommended_frequency_count": 0,
            "frequency_spacing_hz": None,
            "recommended_frequencies_hz": [],
        }
    peak_frequency = frequency_hz[peak_position_index]
    if peak_position_index == 0:
        spacing = abs(frequency_hz[1] - frequency_hz[0])
        start = max(0.0, peak_frequency - 2.0 * spacing)
        stop = peak_frequency
        peak_position = "lower_boundary"
    elif peak_position_index == len(frequency_hz) - 1:
        spacing = abs(frequency_hz[-1] - frequency_hz[-2])
        start = peak_frequency
        stop = peak_frequency + 2.0 * spacing
        peak_position = "upper_boundary"
    else:
        left_spacing = abs(peak_frequency - frequency_hz[peak_position_index - 1])
        right_spacing = abs(frequency_hz[peak_position_index + 1] - peak_frequency)
        spacing = min(left_spacing, right_spacing)
        start = max(0.0, peak_frequency - 0.5 * spacing)
        stop = peak_frequency + 0.5 * spacing
        peak_position = "interior"
    step = (stop - start) / float(count - 1)
    return {
        "schema_version": "frequency_response_peak_refinement.v1",
        "strategy": "local_peak_window",
        "peak_position": peak_position,
        "recommended_frequency_count": count,
        "frequency_spacing_hz": spacing,
        "recommended_frequencies_hz": [
            start + step * index for index in range(count)
        ],
    }


def response_peak_amplitude_source(point: dict) -> str:
    return (
        "max_response_amplitude"
        if point.get("max_response_amplitude") is not None
        else "response_amplitude"
    )


def require_derived_peak_mode_artifact(root: Path, sweep: dict) -> None:
    sweep_points = sweep.get("points")
    if not isinstance(sweep_points, list):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "sweep.points must be a list before derived peak-mode validation"
        )
    derived_path = root / "response/derived_modes/fmr_peak_mode.v1.json"
    if not derived_path.is_file():
        raise SystemExit(
            "missing required frequency-domain runtime artifacts:\n"
            "response/derived_modes/fmr_peak_mode.v1.json"
        )
    derived = load_json(derived_path)
    fallback_index, peak, amplitude = select_response_peak(sweep_points)
    frequency_index = peak.get("frequency_index")
    if not isinstance(frequency_index, int):
        frequency_index = fallback_index
    frequency_hz = peak.get("frequency_hz")
    require_finite_number(frequency_hz, "response_peak.frequency_hz")
    point_path = peak.get("frequency_point_artifact_path")
    payload_path = peak.get("response_field_payload_path")
    require_non_empty_string(point_path, "response_peak.frequency_point_artifact_path")
    require_non_empty_string(payload_path, "response_peak.response_field_payload_path")
    if not (root / point_path).is_file():
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"peak frequency point artifact is missing: {point_path}"
        )
    if not (root / payload_path).is_file():
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"peak response field payload is missing: {payload_path}"
        )
    require_expected(
        {
            "derived_peak_mode.schema_version": (
                derived.get("schema_version"),
                "frequency_response_derived_mode.v1",
            ),
            "derived_peak_mode.source": (
                derived.get("source"),
                "magnetic_response_sweep.v2",
            ),
            "derived_peak_mode.selection": (
                derived.get("selection"),
                "max_response_amplitude",
            ),
            "derived_peak_mode.frequency_index": (
                derived.get("frequency_index"),
                frequency_index,
            ),
            "derived_peak_mode.frequency_point_artifact_path": (
                derived.get("frequency_point_artifact_path"),
                point_path,
            ),
            "derived_peak_mode.field_payload_path": (
                derived.get("field_payload_path"),
                payload_path,
            ),
            "derived_peak_mode.interpretation": (
                derived.get("interpretation"),
                "driven_response_field_at_peak_frequency",
            ),
        }
    )
    provenance = derived.get("provenance")
    if not isinstance(provenance, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "derived_peak_mode.provenance must be an object"
        )
    require_expected(
        {
            "derived_peak_mode.provenance.schema_version": (
                provenance.get("schema_version"),
                "frequency_response_derived_mode_provenance.v1",
            ),
            "derived_peak_mode.provenance.canonical_product": (
                provenance.get("canonical_product"),
                "frequency_response",
            ),
            "derived_peak_mode.provenance.source_artifact_path": (
                provenance.get("source_artifact_path"),
                "response/magnetic_response_sweep.v2.json",
            ),
            "derived_peak_mode.provenance.source_schema_version": (
                provenance.get("source_schema_version"),
                sweep.get("schema_version"),
            ),
            "derived_peak_mode.provenance.derivation_method": (
                provenance.get("derivation_method"),
                "select_max_response_amplitude",
            ),
            "derived_peak_mode.provenance.selection_metric": (
                provenance.get("selection_metric"),
                response_peak_amplitude_source(peak),
            ),
            "derived_peak_mode.provenance.selected_sweep_point_index": (
                provenance.get("selected_sweep_point_index"),
                fallback_index,
            ),
            "derived_peak_mode.provenance.selected_frequency_index": (
                provenance.get("selected_frequency_index"),
                frequency_index,
            ),
            "derived_peak_mode.provenance.selected_frequency_hz": (
                provenance.get("selected_frequency_hz"),
                frequency_hz,
            ),
            "derived_peak_mode.provenance.selected_response_amplitude": (
                provenance.get("selected_response_amplitude"),
                amplitude,
            ),
            "derived_peak_mode.provenance.selected_frequency_point_artifact_path": (
                provenance.get("selected_frequency_point_artifact_path"),
                point_path,
            ),
            "derived_peak_mode.provenance.selected_field_payload_path": (
                provenance.get("selected_field_payload_path"),
                payload_path,
            ),
            "derived_peak_mode.provenance.not_an_eigenmode": (
                provenance.get("not_an_eigenmode"),
                True,
            ),
        }
    )
    require_non_empty_string(derived.get("mode_label"), "derived_peak_mode.mode_label")
    require_finite_number(derived.get("frequency_hz"), "derived_peak_mode.frequency_hz")
    require_finite_number(
        derived.get("response_amplitude"),
        "derived_peak_mode.response_amplitude",
    )
    if float(derived["frequency_hz"]) != float(frequency_hz):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "derived_peak_mode.frequency_hz does not match the selected response peak"
        )
    if float(derived["response_amplitude"]) != amplitude:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "derived_peak_mode.response_amplitude does not match the selected response peak"
        )
    recommendation = derived.get("refinement_recommendation")
    if not isinstance(recommendation, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "derived_peak_mode.refinement_recommendation must be an object"
        )
    expected_recommendation = response_peak_refinement_recommendation(
        sweep_points,
        fallback_index,
    )
    require_expected(
        {
            "derived_peak_mode.refinement_recommendation.schema_version": (
                recommendation.get("schema_version"),
                expected_recommendation["schema_version"],
            ),
            "derived_peak_mode.refinement_recommendation.strategy": (
                recommendation.get("strategy"),
                expected_recommendation["strategy"],
            ),
            "derived_peak_mode.refinement_recommendation.peak_position": (
                recommendation.get("peak_position"),
                expected_recommendation["peak_position"],
            ),
            "derived_peak_mode.refinement_recommendation.recommended_frequency_count": (
                recommendation.get("recommended_frequency_count"),
                expected_recommendation["recommended_frequency_count"],
            ),
            "derived_peak_mode.refinement_recommendation.frequency_spacing_hz": (
                recommendation.get("frequency_spacing_hz"),
                expected_recommendation["frequency_spacing_hz"],
            ),
            "derived_peak_mode.refinement_recommendation.recommended_frequencies_hz": (
                recommendation.get("recommended_frequencies_hz"),
                expected_recommendation["recommended_frequencies_hz"],
            ),
        }
    )


def main() -> int:
    args = sys.argv[1:]
    require_static_periodic = False
    require_floquet_phase_projection = False
    require_production_gpu = False
    require_periodic_airbox_gpu_unsupported = False
    require_floquet_airbox_gpu_unsupported = False
    require_periodic_airbox_cpu_demag_solved = False
    require_m5_equilibrium_provenance = False
    require_frozen_magnetic_submesh = False
    require_min_frequency_points: int | None = None
    require_response_peak = False
    require_field_payloads_for_frequency_points = False
    require_derived_peak_mode = False
    allow_interrupted = False
    allow_unavailable = False
    allow_solve_error = False
    parity_reference: Path | None = None
    floquet_reciprocal_reference: Path | None = None
    airbox_reference: Path | None = None
    if "--require-static-periodic" in args:
        require_static_periodic = True
        args.remove("--require-static-periodic")
    if "--require-floquet-phase-projection" in args:
        require_floquet_phase_projection = True
        args.remove("--require-floquet-phase-projection")
    if "--require-production-gpu" in args:
        require_production_gpu = True
        args.remove("--require-production-gpu")
    if "--require-periodic-airbox-gpu-unsupported" in args:
        require_periodic_airbox_gpu_unsupported = True
        args.remove("--require-periodic-airbox-gpu-unsupported")
    if "--require-floquet-airbox-gpu-unsupported" in args:
        require_floquet_airbox_gpu_unsupported = True
        args.remove("--require-floquet-airbox-gpu-unsupported")
    if "--require-periodic-airbox-cpu-demag-solved" in args:
        require_periodic_airbox_cpu_demag_solved = True
        args.remove("--require-periodic-airbox-cpu-demag-solved")
    if "--require-m5-equilibrium-provenance" in args:
        require_m5_equilibrium_provenance = True
        args.remove("--require-m5-equilibrium-provenance")
    if "--require-frozen-magnetic-submesh" in args:
        require_frozen_magnetic_submesh = True
        args.remove("--require-frozen-magnetic-submesh")
    if "--require-min-frequency-points" in args:
        index = args.index("--require-min-frequency-points")
        if index + 1 >= len(args):
            raise SystemExit(
                "usage: scripts/verify_fem_frequency_domain_runtime_artifacts.py "
                "[--require-min-frequency-points <count>] <artifacts-dir>"
            )
        try:
            require_min_frequency_points = int(args[index + 1])
        except ValueError as exc:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "--require-min-frequency-points must be an integer"
            ) from exc
        if require_min_frequency_points <= 0:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "--require-min-frequency-points must be positive"
            )
        del args[index : index + 2]
    if "--require-response-peak" in args:
        require_response_peak = True
        args.remove("--require-response-peak")
    if "--require-field-payloads-for-frequency-points" in args:
        require_field_payloads_for_frequency_points = True
        args.remove("--require-field-payloads-for-frequency-points")
    if "--require-derived-peak-mode" in args:
        require_derived_peak_mode = True
        args.remove("--require-derived-peak-mode")
    if "--compare-reference" in args:
        index = args.index("--compare-reference")
        if index + 1 >= len(args):
            raise SystemExit(
                "usage: scripts/verify_fem_frequency_domain_runtime_artifacts.py "
                "[--compare-reference <cpu-artifacts-dir>] <artifacts-dir>"
            )
        parity_reference = Path(args[index + 1])
        del args[index : index + 2]
    if "--compare-floquet-reciprocal-reference" in args:
        index = args.index("--compare-floquet-reciprocal-reference")
        if index + 1 >= len(args):
            raise SystemExit(
                "usage: scripts/verify_fem_frequency_domain_runtime_artifacts.py "
                "[--compare-floquet-reciprocal-reference <opposite-k-artifacts-dir>] "
                "<artifacts-dir>"
            )
        floquet_reciprocal_reference = Path(args[index + 1])
        del args[index : index + 2]
    if "--compare-airbox-reference" in args:
        index = args.index("--compare-airbox-reference")
        if index + 1 >= len(args):
            raise SystemExit(
                "usage: scripts/verify_fem_frequency_domain_runtime_artifacts.py "
                "[--compare-airbox-reference <z-padding-reference-artifacts-dir>] "
                "<artifacts-dir>"
            )
        airbox_reference = Path(args[index + 1])
        del args[index : index + 2]
    if "--allow-interrupted" in args:
        allow_interrupted = True
        args.remove("--allow-interrupted")
    if "--allow-unavailable" in args:
        allow_unavailable = True
        args.remove("--allow-unavailable")
    if "--allow-solve-error" in args:
        allow_solve_error = True
        args.remove("--allow-solve-error")
    if parity_reference is not None and not require_production_gpu:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "CPU/GPU parity comparison requires --require-production-gpu for the target bundle"
        )
    if floquet_reciprocal_reference is not None and (
        not require_production_gpu or not require_floquet_phase_projection
    ):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "Floquet reciprocal comparison requires --require-production-gpu and "
            "--require-floquet-phase-projection for the target bundle"
        )
    if require_periodic_airbox_gpu_unsupported and not require_production_gpu:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "periodic-airbox GPU unavailable validation requires --require-production-gpu"
        )
    if require_floquet_airbox_gpu_unsupported and not require_production_gpu:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "Floquet-airbox GPU unavailable validation requires --require-production-gpu"
        )
    if require_periodic_airbox_gpu_unsupported and require_floquet_airbox_gpu_unsupported:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "periodic-airbox and Floquet-airbox unavailable validations are mutually exclusive"
        )
    if require_periodic_airbox_cpu_demag_solved and require_production_gpu:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "periodic-airbox CPU demag solved validation cannot be combined with --require-production-gpu"
        )
    if airbox_reference is not None and not require_periodic_airbox_cpu_demag_solved:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "airbox z-padding comparison requires --require-periodic-airbox-cpu-demag-solved"
        )
    if require_m5_equilibrium_provenance and not require_periodic_airbox_cpu_demag_solved:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "M5 equilibrium provenance validation requires --require-periodic-airbox-cpu-demag-solved"
        )
    root = (
        Path(args[0])
        if args
        else Path(".fullmag/reports/frequency-domain-runtime/artifacts")
    )
    common_required = [
        root / "response/progress.v1.json",
        root / "response/diagnostics/solver.v1.json",
        root / "frequency_domain/manifest.v1.json",
    ]
    missing = [str(path) for path in common_required if not path.is_file()]
    if missing:
        raise SystemExit(
            "missing required frequency-domain runtime artifacts:\n"
            + "\n".join(missing)
        )

    progress = load_json(root / "response/progress.v1.json")
    diagnostics = load_json(root / "response/diagnostics/solver.v1.json")
    manifest = load_json(root / "frequency_domain/manifest.v1.json")
    progress_json = require_progress_json_checkpoint(progress)
    unavailable = manifest.get("status") == "unavailable"
    if unavailable:
        if not allow_unavailable:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.status is unavailable; pass --allow-unavailable to validate unavailable artifacts"
            )
        expected_unavailable_written_frequency_point_artifacts = (
            progress.get("total_frequency_points")
            if require_periodic_airbox_gpu_unsupported
            else 0
        )
        expected_unavailable_partial_artifacts = (
            True
            if require_periodic_airbox_gpu_unsupported
            or require_floquet_airbox_gpu_unsupported
            else False
        )
        unavailable_expected = {
            "manifest.schema_version": (
                manifest.get("schema_version"),
                "frequency_domain_manifest.v1",
            ),
            "manifest.stage_kind": (manifest.get("stage_kind"), "frequency_response"),
            "manifest.analysis_family": (
                manifest.get("analysis_family"),
                "magnetic_frequency_domain",
            ),
            "manifest.study_product": (
                manifest.get("study_product"),
                "driven_response",
            ),
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
                expected_unavailable_written_frequency_point_artifacts,
            ),
            "progress.partial_artifacts_available": (
                progress.get("partial_artifacts_available"),
                expected_unavailable_partial_artifacts,
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
                expected_unavailable_written_frequency_point_artifacts,
            ),
        }
        require_expected(unavailable_expected)
        if require_floquet_airbox_gpu_unsupported:
            requested_frequency_count = progress.get("total_frequency_points")
            if not isinstance(requested_frequency_count, int) or requested_frequency_count < 0:
                raise SystemExit(
                    "invalid frequency-domain runtime artifacts:\n"
                    "progress.total_frequency_points must be a non-negative integer for Floquet-airbox unavailable artifacts"
                )
            manifest_artifacts = manifest.get("artifacts", {})
            if not isinstance(manifest_artifacts, dict):
                raise SystemExit(
                    "invalid frequency-domain runtime artifacts:\n"
                    "manifest.artifacts must be an object"
                )
            requested_execution = manifest.get("requested_execution", {})
            if not isinstance(requested_execution, dict):
                requested_execution = {}
            resolved_execution = manifest.get("resolved_execution", {})
            if not isinstance(resolved_execution, dict):
                resolved_execution = {}
            require_floquet_airbox_gpu_unavailable_boundary(
                root,
                diagnostics=diagnostics,
                manifest=manifest,
                requested_execution=requested_execution,
                resolved_execution=resolved_execution,
                manifest_artifacts=manifest_artifacts,
                requested_frequency_count=requested_frequency_count,
            )
            if (root / "response/magnetic_response_sweep.v1.json").exists() or (
                root / "response/magnetic_response_sweep.v2.json"
            ).exists():
                raise SystemExit(
                    "invalid frequency-domain runtime artifacts:\n"
                    "unavailable artifacts must not include response sweep files"
                )
            return 0
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
        requested_frequency_count = requested_execution["frequency_count"]
        if requested_frequency_count < 0:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.requested_execution.frequency_count must be non-negative"
            )
        diagnostics_requested_frequency_count = diagnostics.get(
            "requested_frequency_count"
        )
        if diagnostics_requested_frequency_count != requested_frequency_count:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "unavailable requested frequency count mismatch: "
                f"manifest.requested_execution.frequency_count={requested_frequency_count!r}, "
                f"diagnostics.requested_frequency_count={diagnostics_requested_frequency_count!r}"
            )
        if progress.get("total_frequency_points") != requested_frequency_count:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "unavailable requested frequency count mismatch: "
                f"manifest.requested_execution.frequency_count={requested_frequency_count!r}, "
                f"progress.total_frequency_points={progress.get('total_frequency_points')!r}"
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
                "response/diagnostics/solver.v1.json",
            ),
            "manifest.artifacts.solver_diagnostics_path": (
                manifest_artifacts.get("solver_diagnostics_path"),
                "response/diagnostics/solver.v1.json",
            ),
            "manifest.artifacts.response_progress_v1_path": (
                manifest_artifacts.get("response_progress_v1_path"),
                "response/progress.v1.json",
            ),
            "manifest.artifacts.response_cancel_requested_v1_path": (
                manifest_artifacts.get("response_cancel_requested_v1_path"),
                None,
            ),
            "manifest.artifacts.response_map_v1_path": (
                manifest_artifacts.get("response_map_v1_path"),
                None,
            ),
            "manifest.artifacts.response_map_v2_path": (
                manifest_artifacts.get("response_map_v2_path"),
                None,
            ),
        }
        for required_key in [
            "response_cancel_requested_v1_path",
            "response_map_v1_path",
            "response_map_v2_path",
        ]:
            if required_key not in manifest_artifacts:
                raise SystemExit(
                    "invalid frequency-domain runtime artifacts:\n"
                    f"manifest.artifacts.{required_key} is missing"
                )
        require_expected(unavailable_artifact_refs)
        if require_periodic_airbox_gpu_unsupported:
            require_periodic_airbox_gpu_unavailable_boundary(
                root,
                diagnostics=diagnostics,
                manifest=manifest,
                requested_execution=requested_execution,
                resolved_execution=resolved_execution,
                manifest_artifacts=manifest_artifacts,
                requested_frequency_count=requested_frequency_count,
            )
        elif require_floquet_airbox_gpu_unsupported:
            require_floquet_airbox_gpu_unavailable_boundary(
                root,
                diagnostics=diagnostics,
                manifest=manifest,
                requested_execution=requested_execution,
                resolved_execution=resolved_execution,
                manifest_artifacts=manifest_artifacts,
                requested_frequency_count=requested_frequency_count,
            )
        elif manifest_artifacts.get("frequency_point_paths") != []:
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
                "/v2/sessions/current/analysis/frequency-domain/response/diagnostics/solver.v1",
            ),
            "manifest.resources.response_cancel_requested_resource_key": (
                manifest_resources.get("response_cancel_requested_resource_key"),
                None,
            ),
            "manifest.resources.response_map_resource_key": (
                manifest_resources.get("response_map_resource_key"),
                None,
            ),
        }
        for required_key in [
            "response_cancel_requested_resource_key",
            "response_map_resource_key",
        ]:
            if required_key not in manifest_resources:
                raise SystemExit(
                    "invalid frequency-domain runtime artifacts:\n"
                    f"manifest.resources.{required_key} is missing"
                )
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

    if require_periodic_airbox_gpu_unsupported:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "periodic-airbox GPU unavailable boundary was required but manifest.status is not unavailable"
        )
    if require_floquet_airbox_gpu_unsupported:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "Floquet-airbox GPU unavailable boundary was required but manifest.status is not unavailable"
        )
    if require_periodic_airbox_cpu_demag_solved and unavailable:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "periodic-airbox CPU demag solved boundary was required but manifest.status is unavailable"
        )

    solve_error = manifest.get("status") == "solve_error"
    if solve_error:
        if not allow_solve_error:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.status is solve_error; pass --allow-solve-error to validate bounded diagnostic artifacts"
            )
        require_expected(
            {
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
                "progress.status": (progress.get("status"), "solve_error"),
                "progress.state": (progress.get("state"), "solve_error"),
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
                    True,
                ),
                "diagnostics.schema_version": (
                    diagnostics.get("schema_version"),
                    "frequency_domain_response_diagnostics.v1",
                ),
                "diagnostics.status": (diagnostics.get("status"), "solve_error"),
                "diagnostics.complete": (diagnostics.get("complete"), False),
                "diagnostics.validation_fallback_used": (
                    diagnostics.get("validation_fallback_used"),
                    False,
                ),
                "diagnostics.matrix_free_solver": (
                    diagnostics.get("matrix_free_solver"),
                    True,
                ),
            }
        )
        total_frequency_points = require_positive_integer(
            progress.get("total_frequency_points"),
            "progress.total_frequency_points",
        )
        requested_execution = manifest.get("requested_execution")
        if not isinstance(requested_execution, dict):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "manifest.requested_execution must be an object"
            )
        require_equal(
            requested_execution.get("frequency_count"),
            total_frequency_points,
            "manifest.requested_execution.frequency_count",
        )
        max_iterations = require_positive_integer(
            diagnostics.get("max_iterations_for_frequency"),
            "diagnostics.max_iterations_for_frequency",
        )
        require_positive_integer(
            diagnostics.get("progress_interval_iterations"),
            "diagnostics.progress_interval_iterations",
        )
        total_iterations = require_positive_integer(
            diagnostics.get("total_iteration_count"),
            "diagnostics.total_iteration_count",
        )
        if total_iterations < max_iterations:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "solve_error diagnostics.total_iteration_count must reach max_iterations_for_frequency"
            )
        for field_name in [
            "solver_relative_tolerance",
            "rhs_l2_norm",
            "initial_relative_residual_l2_norm",
            "relative_residual_l2_norm",
            "last_recomputed_relative_residual_l2_norm",
        ]:
            require_finite_number(diagnostics.get(field_name), f"diagnostics.{field_name}")
        progress_json = require_native_frequency_response_progress_observability(
            progress,
            expected_demag_mode=expected_progress_demag_mode(manifest),
            expected_converged=False,
        )
        native_iteration_count = require_positive_integer(
            progress.get("native_iteration_count"),
            "progress.native_iteration_count",
        )
        require_equal(
            native_iteration_count,
            total_iterations,
            "progress.native_iteration_count",
        )
        require_equal(
            progress.get("native_max_iterations_for_frequency"),
            max_iterations,
            "progress.native_max_iterations_for_frequency",
        )
        require_equal(
            progress_json.get("native_max_iterations_for_frequency"),
            max_iterations,
            "progress.progress_json.native_max_iterations_for_frequency",
        )
        expected_fraction = float(total_iterations) / float(max_iterations)
        require_equal(
            progress.get("native_current_frequency_solve_fraction"),
            expected_fraction,
            "progress.native_current_frequency_solve_fraction",
        )
        if require_frozen_magnetic_submesh:
            require_frozen_magnetic_submesh_mode(manifest)
        require_manifest_physics(manifest)
        if require_periodic_airbox_cpu_demag_solved:
            require_periodic_airbox_cpu_demag_solved_boundary(
                root,
                diagnostics=diagnostics,
                manifest=manifest,
                require_frequency_point_artifacts=False,
            )
            if require_m5_equilibrium_provenance:
                require_m5_equilibrium_provenance_contract(manifest)
        return 0

    if require_frozen_magnetic_submesh:
        require_frozen_magnetic_submesh_mode(manifest)
    if require_m5_equilibrium_provenance:
        require_m5_equilibrium_provenance_contract(manifest)

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
    expected_total_frequency_points = progress.get("total_frequency_points")
    if (
        not isinstance(expected_total_frequency_points, int)
        or expected_total_frequency_points <= 0
    ):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "progress.total_frequency_points must be a positive integer"
        )
    expected_completed_frequency_points = progress.get("completed_frequency_points")
    expected_written_frequency_point_artifacts = progress.get("written_frequency_point_artifacts")
    if isinstance(expected_completed_frequency_points, int) and (
        expected_completed_frequency_points > expected_total_frequency_points
    ):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "progress.total_frequency_points must be >= completed_frequency_points"
        )
    if isinstance(expected_written_frequency_point_artifacts, int) and (
        expected_written_frequency_point_artifacts > expected_total_frequency_points
    ):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "progress.total_frequency_points must be >= written_frequency_point_artifacts"
        )
    if not interrupted and expected_completed_frequency_points != expected_total_frequency_points:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "progress.completed_frequency_points must equal total_frequency_points for completed artifacts"
        )
    if not interrupted and expected_written_frequency_point_artifacts != expected_total_frequency_points:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "progress.written_frequency_point_artifacts must equal total_frequency_points for completed artifacts"
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
        if (
            expected_completed_frequency_points < 0
            or expected_completed_frequency_points >= expected_total_frequency_points
        ):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "interrupted progress.completed_frequency_points must be >= 0 and < total_frequency_points"
            )
        if expected_written_frequency_point_artifacts != expected_completed_frequency_points:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "interrupted written_frequency_point_artifacts must match completed_frequency_points"
            )
        cancel_requested_path = root / "response/cancel_requested.v1.json"
        if not cancel_requested_path.is_file():
            raise SystemExit(
                "missing required frequency-domain runtime artifacts:\n"
                "response/cancel_requested.v1.json"
            )
        cancel_requested = load_json(cancel_requested_path)
        cancel_expected = {
            "cancel_requested.schema_version": (
                cancel_requested.get("schema_version"),
                "frequency_domain_sweep_progress.v1",
            ),
            "cancel_requested.status": (
                cancel_requested.get("status"),
                "cancel_requested",
            ),
            "cancel_requested.state": (
                cancel_requested.get("state"),
                "cancel_requested",
            ),
            "cancel_requested.complete": (cancel_requested.get("complete"), False),
            "cancel_requested.total_frequency_points": (
                cancel_requested.get("total_frequency_points"),
                expected_total_frequency_points,
            ),
            "cancel_requested.completed_frequency_points": (
                cancel_requested.get("completed_frequency_points"),
                expected_completed_frequency_points,
            ),
            "cancel_requested.written_frequency_point_artifacts": (
                cancel_requested.get("written_frequency_point_artifacts"),
                expected_written_frequency_point_artifacts,
            ),
            "cancel_requested.partial_artifacts_available": (
                cancel_requested.get("partial_artifacts_available"),
                expected_written_frequency_point_artifacts > 0,
            ),
            "manifest.artifacts.response_cancel_requested_v1_path": (
                manifest.get("artifacts", {}).get("response_cancel_requested_v1_path"),
                "response/cancel_requested.v1.json",
            ),
            "manifest.resources.response_cancel_requested_resource_key": (
                manifest.get("resources", {}).get(
                    "response_cancel_requested_resource_key"
                ),
                "/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1",
            ),
        }
        require_expected(cancel_expected)
        require_progress_json_checkpoint(cancel_requested, "cancel_requested")

    expected_cancel_requested_artifact_path = (
        "response/cancel_requested.v1.json" if interrupted else None
    )
    expected_cancel_requested_resource_key = (
        "/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1"
        if interrupted
        else None
    )
    expected_execution_lane = "production_gpu" if require_production_gpu else "production_cpu"
    expected_lane_classification = (
        "fem_gpu_production" if require_production_gpu else "fem_cpu_production"
    )
    expected_engine = (
        "native_fem_mfem_frequency_domain_gpu"
        if require_production_gpu
        else "native_fem_mfem_frequency_domain_cpu"
    )
    schur_coupled_block = (
        diagnostics.get("periodic_airbox_coupled_block_solver") is True
        or manifest.get("diagnostics", {}).get("periodic_airbox_coupled_block_solver") is True
        or manifest.get("resolved_execution", {}).get("periodic_airbox_coupled_block_solver") is True
    )
    expected_solver_model = (
        "periodic_airbox_mfem_phi_consistency_schur"
        if schur_coupled_block
        else "matrix_free_gmres"
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
            expected_lane_classification,
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
            expected_completed_frequency_points,
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
            expected_completed_frequency_points,
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
        "diagnostics.matrix_form": (
            diagnostics.get("matrix_form"),
            "iomega_B_minus_L",
        ),
        "diagnostics.requested_execution_lane": (
            diagnostics.get("requested_execution_lane"),
            expected_execution_lane,
        ),
        "diagnostics.resolved_execution_lane": (
            diagnostics.get("resolved_execution_lane"),
            expected_execution_lane,
        ),
        "diagnostics.validation_fallback_used": (
            diagnostics.get("validation_fallback_used"),
            False,
        ),
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
        "manifest.analysis_family": (
            manifest.get("analysis_family"),
            "magnetic_frequency_domain",
        ),
        "manifest.study_product": (
            manifest.get("study_product"),
            "driven_response",
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
            expected_engine,
        ),
        "manifest.resolved_execution.requested_execution_lane": (
            manifest.get("resolved_execution", {}).get("requested_execution_lane"),
            expected_execution_lane,
        ),
        "manifest.resolved_execution.resolved_execution_lane": (
            manifest.get("resolved_execution", {}).get("resolved_execution_lane"),
            expected_execution_lane,
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
            expected_solver_model,
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
        "manifest.artifacts.response_map_v1_path": (
            manifest.get("artifacts", {}).get("response_map_v1_path"),
            None,
        ),
        "manifest.artifacts.response_map_v2_path": (
            manifest.get("artifacts", {}).get("response_map_v2_path"),
            None,
        ),
        "manifest.artifacts.solver_diagnostics_path": (
            manifest.get("artifacts", {}).get("solver_diagnostics_path"),
            "response/diagnostics/solver.v1.json",
        ),
        "manifest.artifacts.response_diagnostics_v1_path": (
            manifest.get("artifacts", {}).get("response_diagnostics_v1_path"),
            "response/diagnostics/solver.v1.json",
        ),
        "manifest.artifacts.response_progress_v1_path": (
            manifest.get("artifacts", {}).get("response_progress_v1_path"),
            "response/progress.v1.json",
        ),
        "manifest.resources.response_diagnostics_resource_key": (
            manifest.get("resources", {}).get("response_diagnostics_resource_key"),
            "/v2/sessions/current/analysis/frequency-domain/response/diagnostics/solver.v1",
        ),
        "manifest.resources.response_progress_resource_key": (
            manifest.get("resources", {}).get("response_progress_resource_key"),
            "/v2/sessions/current/analysis/frequency-domain/response/progress.v1",
        ),
        "manifest.resources.response_map_resource_key": (
            manifest.get("resources", {}).get("response_map_resource_key"),
            None,
        ),
        "manifest.artifacts.response_cancel_requested_v1_path": (
            manifest.get("artifacts", {}).get("response_cancel_requested_v1_path"),
            expected_cancel_requested_artifact_path,
        ),
        "manifest.resources.response_cancel_requested_resource_key": (
            manifest.get("resources", {}).get("response_cancel_requested_resource_key"),
            expected_cancel_requested_resource_key,
        ),
        "manifest.diagnostics.completed_frequency_point_count": (
            manifest_completed_frequency_point_count(manifest),
            expected_completed_frequency_points,
        ),
        "manifest.diagnostics.requested_execution_lane": (
            manifest.get("diagnostics", {}).get("requested_execution_lane"),
            expected_execution_lane,
        ),
        "manifest.diagnostics.resolved_execution_lane": (
            manifest.get("diagnostics", {}).get("resolved_execution_lane"),
            expected_execution_lane,
        ),
        "manifest.diagnostics.validation_fallback_used": (
            manifest.get("diagnostics", {}).get("validation_fallback_used"),
            False,
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
    floquet_phase_projection = require_floquet_phase_projection_diagnostics(
        diagnostics, manifest
    )
    if require_floquet_phase_projection and not floquet_phase_projection:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "Floquet phase diagnostics were required but floquet_phase_projection is not true"
        )
    if floquet_phase_projection:
        require_floquet_periodic_pairs_artifact(root, diagnostics, manifest)
    require_manifest_physics(manifest)
    require_progress_demag_mode(progress, manifest)
    if require_production_gpu:
        require_gpu_dynamic_demag_operator_source(diagnostics, manifest)
    require_equal(
        diagnostics.get("phasor_convention"),
        manifest["physics"]["phase_convention"],
        "diagnostics.phasor_convention",
    )
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
    if (
        require_min_frequency_points is not None
        and completed_count < require_min_frequency_points
    ):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"multi-frequency spectrum requires at least {require_min_frequency_points} "
            f"completed frequency points; got {completed_count}"
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
    manifest_artifacts = manifest.get("artifacts", {})
    if not isinstance(manifest_artifacts, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.artifacts must be an object"
        )
    for required_key in ["response_map_v1_path", "response_map_v2_path"]:
        if required_key not in manifest_artifacts:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"manifest.artifacts.{required_key} is missing"
            )
    manifest_payload_resources = require_object_list(
        manifest.get("resources", {}).get("response_field_resources"),
        "manifest.resources.response_field_resources",
    )
    manifest_resources = manifest.get("resources", {})
    if not isinstance(manifest_resources, dict):
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.resources must be an object"
        )
    if "response_map_resource_key" not in manifest_resources:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "manifest.resources.response_map_resource_key is missing"
        )
    if len(point_paths) != completed_count:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            f"sweep.frequency_point_artifact_paths length: got {len(point_paths)}, "
            f"expected {completed_count}"
        )
    expected_payload_count = completed_count if write_response_fields else 0
    if require_field_payloads_for_frequency_points and not write_response_fields:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n"
            "multi-frequency spectrum requires a field payload for every completed "
            "frequency point, but manifest.requested_execution.write_response_fields is false"
        )
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
    if expected_payload_count > 0:
        require_response_zarr_store(root)
    if completed_count > 0:
        expected_first_point = "response/frequency_points/frequency_0000.json"
        if point_paths[0] != expected_first_point:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                f"first frequency point path: got {point_paths[0]!r}, expected {expected_first_point!r}"
            )
    missing_linked = [
        relative_path
        for relative_path in [*point_paths, *payload_paths]
        if not (root / relative_path).is_file()
    ]
    if missing_linked:
        if require_field_payloads_for_frequency_points and any(
            path in payload_paths for path in missing_linked
        ):
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "multi-frequency spectrum requires a field payload for every "
                "completed frequency point; missing linked payloads:\n"
                + "\n".join(path for path in missing_linked if path in payload_paths)
            )
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
    response_peak: tuple[float, float] | None = None
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
        frequency_hz = point_value.get("frequency_hz")
        if isinstance(amplitude, (int, float)) and isinstance(frequency_hz, (int, float)):
            amplitude_float = float(amplitude)
            if response_peak is None or amplitude_float > response_peak[1]:
                response_peak = (float(frequency_hz), amplitude_float)
        require_finite_number(
            point_value.get("absorbed_power_density"),
            f"sweep.points[{index}].absorbed_power_density",
        )
        require_response_observables(point_value, f"sweep.points[{index}]")
        require_response_series(point_value, f"sweep.points[{index}]")
        require_sweep_reuse(point_value, f"sweep.points[{index}]")
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
        require_excitation_provenance(point_artifact, expected_point_path)
        require_sweep_reuse(point_artifact, expected_point_path)
        for observable_key in [
            "angular_frequency_rad_per_s",
            "absorbed_power_density",
            "excitation_provenance",
            "sweep_reuse",
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
            require_field_payload_metadata(
                root,
                point_artifact,
                expected_point_path,
                expected_payload_path,
            )
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

    if require_response_peak:
        if response_peak is None or response_peak[1] <= 0.0:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "multi-frequency spectrum requires a positive response peak"
            )
    if require_derived_peak_mode:
        require_derived_peak_mode_artifact(root, sweep)

    if parity_reference is not None:
        require_cpu_gpu_parity_reference(
            root,
            parity_reference,
            target_manifest=manifest,
            target_diagnostics=diagnostics,
            target_sweep=sweep,
        )

    if floquet_reciprocal_reference is not None:
        require_floquet_reciprocal_reference(
            root,
            floquet_reciprocal_reference,
            target_manifest=manifest,
            target_diagnostics=diagnostics,
            target_sweep=sweep,
        )

    if airbox_reference is not None:
        require_periodic_airbox_airbox_reference(
            root,
            airbox_reference,
            target_manifest=manifest,
            target_diagnostics=diagnostics,
            target_sweep=sweep,
        )

    if require_periodic_airbox_cpu_demag_solved:
        progress_json = require_native_frequency_response_progress_observability(
            progress,
            expected_demag_mode=expected_progress_demag_mode(manifest),
            expected_converged=True,
        )
        max_iterations = require_positive_integer(
            diagnostics.get("max_iterations_for_frequency"),
            "diagnostics.max_iterations_for_frequency",
        )
        require_equal(
            max_iterations,
            progress.get("native_max_iterations_for_frequency"),
            "diagnostics.max_iterations_for_frequency vs progress.native_max_iterations_for_frequency",
        )
        total_iterations = require_positive_integer(
            diagnostics.get("total_iteration_count"),
            "diagnostics.total_iteration_count",
        )
        native_iteration_count = require_positive_integer(
            progress.get("native_iteration_count"),
            "progress.native_iteration_count",
        )
        if total_iterations < native_iteration_count:
            raise SystemExit(
                "invalid frequency-domain runtime artifacts:\n"
                "diagnostics.total_iteration_count must be >= progress.native_iteration_count"
            )
        require_equal(
            progress_json.get("native_max_iterations_for_frequency"),
            max_iterations,
            "progress.progress_json.native_max_iterations_for_frequency vs diagnostics.max_iterations_for_frequency",
        )
        require_periodic_airbox_cpu_demag_solved_boundary(
            root,
            diagnostics=diagnostics,
            manifest=manifest,
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
