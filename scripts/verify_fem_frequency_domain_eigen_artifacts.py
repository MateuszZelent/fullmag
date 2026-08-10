#!/usr/bin/env python3
"""Validate FEM frequency-domain modal eigen artifacts."""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from pathlib import Path


TWO_PI = 2.0 * math.pi
MU0 = 1.2566370614359173e-6
PRODUCTION_SHIFT_INVERT_SOLVER_MODELS = {
    "slepc_multi_shift_invert_production_cpu_dense",
}
PRODUCTION_K_PATH_MAX_RESIDUAL_RELATIVE_L2 = 1.0e-6
PRODUCTION_K_PATH_MAX_TANGENT_LEAKAGE_ABS = 1.0e-8
ALLOWED_MODAL_PHASOR_CONVENTIONS = {
    "exp_i_omega_t",
    "exp_plus_i_omega_t",
    "exp_minus_i_omega_t",
    "not_applicable_real_reference",
}
ALLOWED_MODAL_EIGENVALUE_MAPPINGS = {
    "lambda_eq_i_omega",
    "lambda_imag_positive_frequency",
    "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m",
}
ALLOWED_MODAL_ALGEBRAIC_FORMS = {
    "reference_effective_field_generalized",
    "linearized_llg_generalized",
    "gyrotropic_generalized",
    "k0_macrospin_field_generalized_to_gyrotropic_modal",
    "full_coupled_poisson_airbox_augmented_gauge",
    "schur_reduced_descriptor",
}
ALLOWED_TRACKING_SCORE_SUMMARY_SOURCES = {
    "seed_only",
    "frequency_score_fallback",
    "modal_overlap_weighted_score",
    "mixed_modal_overlap_and_frequency_fallback",
}
ALLOWED_TRACKING_SCORE_POINT_SOURCES = {
    "seed",
    "frequency_score_fallback",
    "modal_overlap_weighted_score",
}
TRACKING_SOURCES_REQUIRING_MODAL_OVERLAP = {
    "modal_overlap_weighted_score",
    "mixed_modal_overlap_and_frequency_fallback",
}
PRODUCTION_MODAL_K_PATH_SUMMARY_TRACKING_SOURCES = {
    "modal_overlap_weighted_score",
}
PRODUCTION_MODAL_K_PATH_TRACKING_METHODS = {
    "overlap_hungarian",
}
GPU_MODAL_KITTEL_SOLVER_ALGORITHMS = {
    "gpu_device_krylov_modal_eigen",
    "gpu_dense_k0_macrospin_modal_eigen",
}
GPU_MODAL_KITTEL_CAPABILITY_STATUSES = {
    "partial_production_executable",
    "production_executable",
    "validated",
}
REFERENCE_FULL_2X2_FLOQUET_REJECTION_CONTRACTS = {
    "production_cpu_modal_nonzero_k_floquet_operator_missing": {
        "production_cpu_rejection_scope": "selected_spectrum_nonzero_k_floquet_modal",
        "required_operator_contract": "bloch_floquet_tangent_operator_with_periodic_pairs",
        "required_operator_payload_kind": "bloch_floquet_tangent_operator",
        "modal_periodic_pair_contract_available": False,
    },
    "production_cpu_modal_dynamic_demag_k_operator_missing": {
        "production_cpu_rejection_scope": (
            "selected_spectrum_nonzero_k_floquet_modal_dynamic_demag"
        ),
        "required_operator_contract": "bloch_floquet_tangent_operator_with_dynamic_demag_k",
        "required_operator_payload_kind": "bloch_floquet_tangent_operator",
        "required_demag_payload_kind": "dynamic_demag_k_operator",
        "dynamic_demag_operator_source": "missing_numeric_fem_demag_k",
        "modal_periodic_pair_contract_available": False,
    },
}


def fail(message: str) -> None:
    raise SystemExit(f"invalid frequency-domain eigen artifacts:\n{message}")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def require_file(path: Path) -> None:
    if not path.is_file():
        fail(f"missing required artifact: {path}")


def require_equal(actual: object, expected: object, name: str) -> None:
    if actual != expected:
        fail(f"{name}: got {actual!r}, expected {expected!r}")


def validate_reference_full_2x2_floquet_rejection_contract(
    diagnostics: dict,
    *,
    prefix: str,
    expected_reason: str | None = None,
) -> str:
    reason = diagnostics.get("production_cpu_rejection_reason")
    if expected_reason is not None:
        require_equal(
            reason,
            expected_reason,
            f"{prefix}.production_cpu_rejection_reason",
        )
    if reason not in REFERENCE_FULL_2X2_FLOQUET_REJECTION_CONTRACTS:
        fail(
            f"{prefix}.production_cpu_rejection_reason: got {reason!r}, expected one of "
            f"{sorted(REFERENCE_FULL_2X2_FLOQUET_REJECTION_CONTRACTS)}"
        )
    contract = REFERENCE_FULL_2X2_FLOQUET_REJECTION_CONTRACTS[reason]
    for key, expected in contract.items():
        require_equal(diagnostics.get(key), expected, f"{prefix}.{key}")
    return reason


def require_non_empty_string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(f"{name} must be a non-empty string")
    return value


def require_sha256_token(value: object, name: str) -> str:
    token = require_non_empty_string(value, name)
    prefix = "sha256:"
    if not token.startswith(prefix) or len(token) != len(prefix) + 64:
        fail(f"{name} must be a sha256:<64 hex chars> token")
    suffix = token[len(prefix) :]
    if any(char not in "0123456789abcdef" for char in suffix):
        fail(f"{name} must use lowercase hex sha256 encoding")
    return token


def validate_periodic_mesh_certificate(
    certificate: object,
    *,
    name: str,
) -> str:
    if not isinstance(certificate, dict):
        fail(f"{name} must be an object")
    require_equal(
        certificate.get("schema_version"),
        "periodic_mesh_certificate.v5",
        f"{name}.schema_version",
    )
    require_equal(
        certificate.get("certificate_status"),
        "accepted",
        f"{name}.certificate_status",
    )
    magnetic_pair_count = require_non_negative_int(
        certificate.get("magnetic_pair_count"),
        f"{name}.magnetic_pair_count",
    )
    if magnetic_pair_count <= 0:
        fail(f"{name}.magnetic_pair_count must be positive")
    return require_sha256_token(
        certificate.get("magnetic_pair_map_sha256"),
        f"{name}.magnetic_pair_map_sha256",
    )


def require_finite_number(value: object, name: str) -> float:
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        fail(f"{name} must be a finite number")
    return float(value)


def require_boolean(value: object, name: str) -> bool:
    if not isinstance(value, bool):
        fail(f"{name} must be boolean")
    return value


def require_tracking_score_source(
    value: object,
    name: str,
    allowed: set[str],
) -> str:
    source = require_non_empty_string(value, name)
    if source not in allowed:
        fail(f"{name} is invalid")
    return source


def require_close(
    actual: float,
    expected: float,
    name: str,
    *,
    relative_tolerance: float = 1.0e-9,
    absolute_tolerance: float = 1.0e-6,
) -> None:
    if not math.isclose(
        actual,
        expected,
        rel_tol=relative_tolerance,
        abs_tol=absolute_tolerance,
    ):
        fail(f"{name}: got {actual!r}, expected {expected!r}")


def median(values: list[float]) -> float:
    if not values:
        fail("median requires at least one value")
    sorted_values = sorted(values)
    midpoint = len(sorted_values) // 2
    if len(sorted_values) % 2 == 0:
        return (sorted_values[midpoint - 1] + sorted_values[midpoint]) / 2.0
    return sorted_values[midpoint]


def require_non_negative_int(value: object, name: str) -> int:
    if not isinstance(value, int) or value < 0:
        fail(f"{name} must be a non-negative integer")
    return value


def require_object_list(value: object, name: str) -> list[dict]:
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        fail(f"{name} must be an object list")
    return value


def require_string_list(value: object, name: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        fail(f"{name} must be a string list")
    return value


def require_ordered_string_list(value: object, expected: list[str], name: str) -> None:
    items = require_string_list(value, name)
    if items != expected:
        fail(f"{name}: got {items!r}, expected {expected!r}")


def mode_field_id(sample_index: int, raw_mode_index: int) -> str:
    return f"analysis:eigen:sample-{sample_index:04d}:mode-{raw_mode_index:04d}"


def mode_field_resource_key(field_id: str) -> str:
    return (
        f"/v2/sessions/current/data/fields/{field_id}/samples/vector"
        "?view=phase_rotated_real&phase_rad=0"
    )


def mode_meta_resource_key(sample_index: int, raw_mode_index: int) -> str:
    return (
        "/v2/sessions/current/analysis/frequency-domain/eigen/"
        f"mode-field/{sample_index}/{raw_mode_index}/meta"
    )


def nested_mode_path(sample_index: int, raw_mode_index: int) -> str:
    return f"eigen/modes/sample_{sample_index:04d}/mode_{raw_mode_index:04d}.json"


def mode_payload_path(sample_index: int, raw_mode_index: int) -> str:
    return f"eigen/mode_fields/sample_{sample_index:04d}/mode_{raw_mode_index:04d}/vector.bin"


def mode_zarr_store_path() -> str:
    return "eigen/mode_fields.zarr"


def mode_zarr_array_path(sample_index: int, raw_mode_index: int) -> str:
    return (
        f"{mode_zarr_store_path()}/sample_{sample_index:04d}/"
        f"mode_{raw_mode_index:04d}/vector_xyz_complex"
    )


def mode_zarr_chunk_path(sample_index: int, raw_mode_index: int) -> str:
    return f"{mode_zarr_array_path(sample_index, raw_mode_index)}/0.0.0"


def require_mode_field_handoff(
    payload: dict,
    name: str,
    sample_index: int,
    raw_mode_index: int,
) -> None:
    expected_field_id = mode_field_id(sample_index, raw_mode_index)
    expected_resource_key = mode_field_resource_key(expected_field_id)
    require_equal(payload.get("mode_field_id"), expected_field_id, f"{name}.mode_field_id")
    require_equal(
        payload.get("mode_field_resource_key"),
        expected_resource_key,
        f"{name}.mode_field_resource_key",
    )


def require_tracking_summary(payload: dict, name: str) -> None:
    source = require_tracking_score_source(
        payload.get("tracking_score_source"),
        f"{name}.tracking_score_source",
        ALLOWED_TRACKING_SCORE_SUMMARY_SOURCES,
    )
    modal_overlap_available = require_boolean(
        payload.get("modal_overlap_available"),
        f"{name}.modal_overlap_available",
    )
    if source in TRACKING_SOURCES_REQUIRING_MODAL_OVERLAP and not modal_overlap_available:
        fail(f"{name}.modal_overlap_available must be true for {source}")
    unavailable_reason = payload.get("modal_overlap_unavailable_reason")
    if modal_overlap_available and unavailable_reason not in (None, ""):
        fail(f"{name}.modal_overlap_unavailable_reason must be empty when modal overlap is available")


def require_tracking_point(payload: dict, name: str) -> str:
    source = require_tracking_score_source(
        payload.get("tracking_score_source"),
        f"{name}.tracking_score_source",
        ALLOWED_TRACKING_SCORE_POINT_SOURCES,
    )
    modal_overlap_available = require_boolean(
        payload.get("modal_overlap_available"),
        f"{name}.modal_overlap_available",
    )
    if source in TRACKING_SOURCES_REQUIRING_MODAL_OVERLAP and not modal_overlap_available:
        fail(f"{name}.modal_overlap_available must be true for {source}")
    unavailable_reason = payload.get("modal_overlap_unavailable_reason")
    if modal_overlap_available and unavailable_reason not in (None, ""):
        fail(f"{name}.modal_overlap_unavailable_reason must be empty when modal overlap is available")
    return source


def require_tracking_method(value: object, name: str, allowed: set[str]) -> str:
    method = require_non_empty_string(value, name)
    if method not in allowed:
        fail(f"{name} is invalid")
    return method


def require_mode_payload(root: Path, relative_path: str, name: str) -> int:
    path = root / relative_path
    require_file(path)
    size = path.stat().st_size
    if size <= 0:
        fail(f"{name} payload must not be empty")
    if size % 8 != 0:
        fail(f"{name} payload byte size must be divisible by 8")
    f64_count = size // 8
    if f64_count % 6 != 0:
        fail(f"{name} payload must contain complex xyz f64 tuples")
    return f64_count


def require_mode_zarr_payload(
    root: Path,
    array_path: str,
    sample_count: int,
    expected_payload_value_count: int,
    name: str,
) -> int:
    zarray_path = root / array_path / ".zarray"
    zattrs_path = root / array_path / ".zattrs"
    chunk_path = root / array_path / "0.0.0"
    require_file(zarray_path)
    require_file(zattrs_path)
    require_file(chunk_path)
    zarray = load_json(zarray_path)
    require_equal(zarray.get("zarr_format"), 2, f"{name}.zarray.zarr_format")
    require_equal(zarray.get("shape"), [sample_count, 3, 2], f"{name}.zarray.shape")
    require_equal(zarray.get("chunks"), [max(sample_count, 1), 3, 2], f"{name}.zarray.chunks")
    require_equal(zarray.get("dtype"), "<f8", f"{name}.zarray.dtype")
    require_equal(zarray.get("order"), "C", f"{name}.zarray.order")
    zattrs = load_json(zattrs_path)
    require_equal(zattrs.get("quantity_id"), "delta_m", f"{name}.zattrs.quantity_id")
    require_equal(zattrs.get("unit"), "1", f"{name}.zattrs.unit")
    require_equal(
        zattrs.get("value_kind"),
        "complex_spatial_vector",
        f"{name}.zattrs.value_kind",
    )
    require_equal(
        zattrs.get("component_basis"),
        "global_xyz",
        f"{name}.zattrs.component_basis",
    )
    require_ordered_string_list(
        zattrs.get("axes"),
        ["spatial_sample", "component", "complex"],
        f"{name}.zattrs.axes",
    )
    require_ordered_string_list(
        zattrs.get("component_order"),
        ["x", "y", "z"],
        f"{name}.zattrs.component_order",
    )
    require_ordered_string_list(
        zattrs.get("complex_order"),
        ["real", "imag"],
        f"{name}.zattrs.complex_order",
    )
    size = chunk_path.stat().st_size
    expected_size = expected_payload_value_count * 8
    if size != expected_size:
        fail(f"{name} Zarr chunk byte size: got {size}, expected {expected_size}")
    return size // 8


def require_mode_zarr_store(root: Path) -> None:
    store_root = root / mode_zarr_store_path()
    zgroup_path = store_root / ".zgroup"
    zattrs_path = store_root / ".zattrs"
    require_file(zgroup_path)
    require_file(zattrs_path)
    zgroup = load_json(zgroup_path)
    require_equal(zgroup.get("zarr_format"), 2, "mode_fields.zarr/.zgroup.zarr_format")
    zattrs = load_json(zattrs_path)
    require_equal(
        zattrs.get("fullmag_kind"),
        "frequency_domain_mode_field_store",
        "mode_fields.zarr/.zattrs.fullmag_kind",
    )
    require_equal(zattrs.get("schema_version"), 1, "mode_fields.zarr/.zattrs.schema_version")
    require_equal(
        zattrs.get("preferred_container"),
        "zarr",
        "mode_fields.zarr/.zattrs.preferred_container",
    )
    require_ordered_string_list(
        zattrs.get("quantity_ids"),
        ["delta_m"],
        "mode_fields.zarr/.zattrs.quantity_ids",
    )
    require_equal(
        zattrs.get("compatibility_binary_exports"),
        True,
        "mode_fields.zarr/.zattrs.compatibility_binary_exports",
    )


def require_mode_metadata_summaries(metadata: dict, metadata_path: str) -> None:
    for forbidden in ["real", "imag", "amplitude", "phase"]:
        if forbidden in metadata:
            fail(f"{metadata_path}.{forbidden} must not inline vector arrays")
    sample_count = require_non_negative_int(
        metadata.get("mode_field_sample_count"),
        f"{metadata_path}.mode_field_sample_count",
    )
    amplitude_summary = metadata.get("amplitude_summary")
    if not isinstance(amplitude_summary, dict):
        fail(f"{metadata_path}.amplitude_summary must be an object")
    require_equal(
        amplitude_summary.get("sample_count"),
        sample_count,
        f"{metadata_path}.amplitude_summary.sample_count",
    )
    component_summary = metadata.get("component_summary")
    if not isinstance(component_summary, dict):
        fail(f"{metadata_path}.component_summary must be an object")
    require_equal(
        component_summary.get("component_count"),
        3,
        f"{metadata_path}.component_summary.component_count",
    )
    require_equal(
        component_summary.get("real_sample_count"),
        sample_count,
        f"{metadata_path}.component_summary.real_sample_count",
    )
    require_equal(
        component_summary.get("imag_sample_count"),
        sample_count,
        f"{metadata_path}.component_summary.imag_sample_count",
    )


def require_mode_field_metadata(
    metadata: dict,
    metadata_path: str,
    sample_index: int,
    raw_mode_index: int,
    require_zarr_mode_fields: bool,
) -> None:
    sample_count = require_non_negative_int(
        metadata.get("mode_field_sample_count"),
        f"{metadata_path}.mode_field_sample_count",
    )
    require_equal(
        metadata.get("value_kind"),
        "complex_spatial_vector",
        f"{metadata_path}.value_kind",
    )
    require_equal(
        metadata.get("component_basis"),
        "global_xyz",
        f"{metadata_path}.component_basis",
    )
    require_equal(metadata.get("component_count"), 3, f"{metadata_path}.component_count")
    require_ordered_string_list(
        metadata.get("components"),
        ["x", "y", "z"],
        f"{metadata_path}.components",
    )
    if require_zarr_mode_fields:
        expected_zarr_array_path = mode_zarr_array_path(sample_index, raw_mode_index)
        require_equal(metadata.get("storage_format"), "zarr", f"{metadata_path}.storage_format")
        require_equal(
            metadata.get("zarr_store_path"),
            mode_zarr_store_path(),
            f"{metadata_path}.zarr_store_path",
        )
        require_equal(
            metadata.get("zarr_array_path"),
            expected_zarr_array_path,
            f"{metadata_path}.zarr_array_path",
        )
        require_equal(
            metadata.get("zarr_chunk_path"),
            mode_zarr_chunk_path(sample_index, raw_mode_index),
            f"{metadata_path}.zarr_chunk_path",
        )
        require_equal(metadata.get("zarr_dtype"), "<f8", f"{metadata_path}.zarr_dtype")
        require_equal(
            metadata.get("zarr_shape"),
            [sample_count, 3, 2],
            f"{metadata_path}.zarr_shape",
        )
        require_equal(
            metadata.get("zarr_chunk_shape"),
            [max(sample_count, 1), 3, 2],
            f"{metadata_path}.zarr_chunk_shape",
        )
    else:
        require_equal(
            metadata.get("storage_format"),
            "binary_compatibility_exports",
            f"{metadata_path}.storage_format",
        )
        for field_name in [
            "zarr_store_path",
            "zarr_array_path",
            "zarr_chunk_path",
            "zarr_dtype",
            "zarr_shape",
            "zarr_chunk_shape",
        ]:
            if metadata.get(field_name) is not None:
                fail(f"{metadata_path}.{field_name} must be null or absent for binary-only mode fields")
    require_equal(
        metadata.get("compatibility_binary_payload_path"),
        mode_payload_path(sample_index, raw_mode_index),
        f"{metadata_path}.compatibility_binary_payload_path",
    )
    require_equal(
        metadata.get("payload_encoding"),
        "f64_interleaved_real_imag_xyz",
        f"{metadata_path}.payload_encoding",
    )
    require_equal(
        metadata.get("binary_layout"),
        "complex_f64_pairs_little_endian",
        f"{metadata_path}.binary_layout",
    )
    require_equal(
        metadata.get("complex_pair_count"),
        sample_count * 3,
        f"{metadata_path}.complex_pair_count",
    )
    require_equal(
        metadata.get("payload_value_count"),
        sample_count * 6,
        f"{metadata_path}.payload_value_count",
    )
    require_ordered_string_list(
        metadata.get("available_views"),
        ["complex", "real", "imag", "abs", "amplitude", "phase", "phase_rotated_real"],
        f"{metadata_path}.available_views",
    )
    require_equal(
        metadata.get("default_view"),
        "phase_rotated_real",
        f"{metadata_path}.default_view",
    )
    require_finite_number(
        metadata.get("default_phase_rad"),
        f"{metadata_path}.default_phase_rad",
    )


def validate_manifest_physics(manifest: dict) -> None:
    require_equal(
        manifest.get("analysis_family"),
        "magnetic_frequency_domain",
        "manifest.analysis_family",
    )
    require_equal(
        manifest.get("study_product"),
        "modal_eigen",
        "manifest.study_product",
    )
    physics = manifest.get("physics")
    if not isinstance(physics, dict):
        fail("manifest.physics must be an object")
    require_equal(
        physics.get("analysis_family"),
        "magnetic_frequency_domain",
        "manifest.physics.analysis_family",
    )
    phase_convention = physics.get("phase_convention")
    if phase_convention not in {
        "exp_i_omega_t",
        "exp_plus_i_omega_t",
        "exp_minus_i_omega_t",
    }:
        fail(
            "manifest.physics.phase_convention must be exp_i_omega_t, "
            "exp_plus_i_omega_t, or exp_minus_i_omega_t"
        )
    require_equal(
        physics.get("frequency_units"),
        "Hz",
        "manifest.physics.frequency_units",
    )
    require_equal(
        physics.get("field_units"),
        "dimensionless_delta_m",
        "manifest.physics.field_units",
    )
    require_non_empty_string(
        physics.get("normalization"),
        "manifest.physics.normalization",
    )


def validate_mode_diagnostics_fields(
    payload: dict,
    payload_path: str,
    frequency_hz: float,
) -> None:
    frequency_imag_hz = require_finite_number(
        payload.get("frequency_imag_hz"),
        f"{payload_path}.frequency_imag_hz",
    )
    phasor_convention = require_non_empty_string(
        payload.get("phasor_convention"),
        f"{payload_path}.phasor_convention",
    )
    if phasor_convention not in ALLOWED_MODAL_PHASOR_CONVENTIONS:
        fail(f"{payload_path}.phasor_convention is invalid")
    eigenvalue_mapping = require_non_empty_string(
        payload.get("eigenvalue_mapping"),
        f"{payload_path}.eigenvalue_mapping",
    )
    if eigenvalue_mapping not in ALLOWED_MODAL_EIGENVALUE_MAPPINGS:
        fail(f"{payload_path}.eigenvalue_mapping is invalid")
    residual_absolute_l2 = require_finite_number(
        payload.get("residual_absolute_l2"),
        f"{payload_path}.residual_absolute_l2",
    )
    residual_relative_l2 = require_finite_number(
        payload.get("residual_relative_l2"),
        f"{payload_path}.residual_relative_l2",
    )
    residual_linf = require_finite_number(
        payload.get("residual_linf"),
        f"{payload_path}.residual_linf",
    )
    mass_norm = require_finite_number(
        payload.get("mass_norm"),
        f"{payload_path}.mass_norm",
    )
    omega_rad_s = require_finite_number(
        payload.get("omega_rad_s"),
        f"{payload_path}.omega_rad_s",
    )
    if eigenvalue_mapping == "lambda_eq_i_omega":
        require_lambda_eq_i_omega_mapping(
            payload,
            payload_path,
            omega_rad_s,
            frequency_hz,
        )
    gamma_rad_s_t = require_finite_number(
        payload.get("gamma_rad_s_T"),
        f"{payload_path}.gamma_rad_s_T",
    )
    gamma0_rad_s_per_a_m = require_finite_number(
        payload.get("gamma0_rad_s_per_A_m"),
        f"{payload_path}.gamma0_rad_s_per_A_m",
    )
    mu0_t_m_per_a = require_finite_number(
        payload.get("mu0_T_m_per_A"),
        f"{payload_path}.mu0_T_m_per_A",
    )
    tangent_leakage_mean_abs = require_finite_number(
        payload.get("tangent_leakage_mean_abs"),
        f"{payload_path}.tangent_leakage_mean_abs",
    )
    tangent_leakage_max_abs = require_finite_number(
        payload.get("tangent_leakage_max_abs"),
        f"{payload_path}.tangent_leakage_max_abs",
    )
    if residual_absolute_l2 < 0.0:
        fail(f"{payload_path}.residual_absolute_l2 must be non-negative")
    if residual_relative_l2 < 0.0:
        fail(f"{payload_path}.residual_relative_l2 must be non-negative")
    if residual_linf < 0.0:
        fail(f"{payload_path}.residual_linf must be non-negative")
    if mass_norm <= 0.0:
        fail(f"{payload_path}.mass_norm must be positive")
    if gamma_rad_s_t <= 0.0:
        fail(f"{payload_path}.gamma_rad_s_T must be positive")
    if gamma0_rad_s_per_a_m <= 0.0:
        fail(f"{payload_path}.gamma0_rad_s_per_A_m must be positive")
    if mu0_t_m_per_a <= 0.0:
        fail(f"{payload_path}.mu0_T_m_per_A must be positive")
    require_close(
        gamma0_rad_s_per_a_m,
        mu0_t_m_per_a * gamma_rad_s_t,
        f"{payload_path}.gamma0_rad_s_per_A_m",
        relative_tolerance=1.0e-12,
        absolute_tolerance=1.0e-9,
    )
    if tangent_leakage_mean_abs < 0.0:
        fail(f"{payload_path}.tangent_leakage_mean_abs must be non-negative")
    if tangent_leakage_max_abs < 0.0:
        fail(f"{payload_path}.tangent_leakage_max_abs must be non-negative")
    if tangent_leakage_mean_abs > tangent_leakage_max_abs:
        fail(
            f"{payload_path}.tangent_leakage_mean_abs must be <= "
            f"{payload_path}.tangent_leakage_max_abs"
        )
    if (
        payload.get("damping_policy") == "include"
        and phasor_convention == "exp_i_omega_t"
    ):
        if frequency_imag_hz < 0.0:
            fail(
                f"{payload_path}.frequency_imag_hz must be non-negative for "
                "exp_i_omega_t damping"
            )
        damping_rate_hz = require_finite_number(
            payload.get("damping_rate_hz"),
            f"{payload_path}.damping_rate_hz",
        )
        linewidth_fwhm_hz = require_finite_number(
            payload.get("linewidth_fwhm_hz"),
            f"{payload_path}.linewidth_fwhm_hz",
        )
        if damping_rate_hz < 0.0:
            fail(f"{payload_path}.damping_rate_hz must be non-negative")
        if linewidth_fwhm_hz < 0.0:
            fail(f"{payload_path}.linewidth_fwhm_hz must be non-negative")
        require_close(
            damping_rate_hz,
            frequency_imag_hz,
            f"{payload_path}.damping_rate_hz",
        )
        require_close(
            linewidth_fwhm_hz,
            2.0 * frequency_imag_hz,
            f"{payload_path}.linewidth_fwhm_hz",
        )
    require_close(
        omega_rad_s,
        TWO_PI * frequency_hz,
        f"{payload_path}.omega_rad_s",
        absolute_tolerance=1.0e-3,
    )


def require_lambda_eq_i_omega_mapping(
    payload: dict,
    payload_path: str,
    omega_rad_s: float,
    frequency_hz: float,
) -> None:
    require_finite_number(
        payload.get("eigenvalue_real"),
        f"{payload_path}.eigenvalue_real",
    )
    eigenvalue_imag = require_finite_number(
        payload.get("eigenvalue_imag"),
        f"{payload_path}.eigenvalue_imag",
    )
    if eigenvalue_imag <= 0.0:
        fail(
            f"{payload_path}.eigenvalue_imag must be positive for "
            "lambda_eq_i_omega accepted modes"
        )
    require_close(
        omega_rad_s,
        eigenvalue_imag,
        f"{payload_path}.omega_rad_s",
        absolute_tolerance=1.0e-3,
    )
    require_close(
        frequency_hz,
        eigenvalue_imag / TWO_PI,
        f"{payload_path}.frequency_hz",
        absolute_tolerance=1.0e-6,
    )


def require_numeric_field_close(
    actual_payload: dict,
    expected_payload: dict,
    field_name: str,
    name: str,
    *,
    absolute_tolerance: float = 1.0e-6,
) -> None:
    actual = require_finite_number(actual_payload.get(field_name), name)
    expected = require_finite_number(
        expected_payload.get(field_name),
        name.replace(" vs ", " expected vs ", 1),
    )
    require_close(
        actual,
        expected,
        name,
        absolute_tolerance=absolute_tolerance,
    )


def require_mode_metadata_matches_summary(
    mode: dict,
    metadata: dict,
    metadata_path: str,
) -> None:
    for field_name in [
        "phasor_convention",
        "eigenvalue_mapping",
    ]:
        require_equal(
            metadata.get(field_name),
            mode.get(field_name),
            f"{metadata_path}.{field_name} vs mode.{field_name}",
        )
    for field_name in [
        "eigenvalue_real",
        "eigenvalue_imag",
        "frequency_imag_hz",
        "omega_rad_s",
        "mass_norm",
        "tangent_leakage_mean_abs",
        "tangent_leakage_max_abs",
        "gamma_rad_s_T",
        "gamma0_rad_s_per_A_m",
        "mu0_T_m_per_A",
    ]:
        require_numeric_field_close(
            metadata,
            mode,
            field_name,
            f"{metadata_path}.{field_name} vs mode.{field_name}",
        )


def require_eigen_summary_mode_matches_spectrum(
    mode: dict,
    spectrum_mode: dict,
    summary_mode_path: str,
) -> None:
    for field_name in [
        "phasor_convention",
        "eigenvalue_mapping",
    ]:
        require_equal(
            mode.get(field_name),
            spectrum_mode.get(field_name),
            f"{summary_mode_path}.{field_name} vs mode.{field_name}",
        )
    for field_name in [
        "eigenvalue_real",
        "eigenvalue_imag",
        "frequency_real_hz",
        "frequency_imag_hz",
        "angular_frequency_rad_per_s",
        "omega_rad_s",
        "mass_norm",
        "tangent_leakage_mean_abs",
        "tangent_leakage_max_abs",
        "gamma_rad_s_T",
        "gamma0_rad_s_per_A_m",
        "mu0_T_m_per_A",
    ]:
        require_numeric_field_close(
            mode,
            spectrum_mode,
            field_name,
            f"{summary_mode_path}.{field_name} vs mode.{field_name}",
        )


def validate_mode_summary(
    root: Path,
    mode: dict,
    sample_index: int,
    manifest_mode_paths: set[str],
    manifest_mode_resources: set[str],
    requested_window_hz: list[float] | None,
    require_zarr_mode_fields: bool,
) -> tuple[int, int, float, float, float, float]:
    raw_mode_index = require_non_negative_int(mode.get("raw_mode_index"), "mode.raw_mode_index")
    expected_field_id = mode_field_id(sample_index, raw_mode_index)
    expected_resource_key = mode_field_resource_key(expected_field_id)
    require_equal(mode.get("mode_field_id"), expected_field_id, "mode.mode_field_id")
    require_equal(
        mode.get("mode_field_resource_key"),
        expected_resource_key,
        "mode.mode_field_resource_key",
    )
    frequency_hz = require_finite_number(mode.get("frequency_hz"), "mode.frequency_hz")
    require_frequency_inside_window(frequency_hz, requested_window_hz, "mode.frequency_hz")
    frequency_real_hz = require_finite_number(mode.get("frequency_real_hz"), "mode.frequency_real_hz")
    require_close(frequency_hz, frequency_real_hz, "mode.frequency_hz")
    frequency_imag_hz = require_finite_number(
        mode.get("frequency_imag_hz"),
        "mode.frequency_imag_hz",
    )
    angular_frequency_rad_per_s = require_finite_number(
        mode.get("angular_frequency_rad_per_s"),
        "mode.angular_frequency_rad_per_s",
    )
    require_close(
        angular_frequency_rad_per_s,
        TWO_PI * frequency_hz,
        "mode.angular_frequency_rad_per_s",
        absolute_tolerance=1.0e-3,
    )
    validate_mode_diagnostics_fields(mode, "mode", frequency_hz)
    require_non_empty_string(mode.get("dominant_polarization"), "mode.dominant_polarization")

    metadata_path = nested_mode_path(sample_index, raw_mode_index)
    if manifest_mode_paths and metadata_path not in manifest_mode_paths:
        fail(f"manifest.artifacts.mode_metadata_paths missing {metadata_path}")
    metadata = load_json(root / metadata_path)
    require_equal(metadata.get("sample_index"), sample_index, f"{metadata_path}.sample_index")
    require_equal(
        metadata.get("raw_mode_index"),
        raw_mode_index,
        f"{metadata_path}.raw_mode_index",
    )
    require_equal(metadata.get("mode_field_id"), expected_field_id, f"{metadata_path}.mode_field_id")
    require_equal(
        metadata.get("mode_field_resource_key"),
        expected_resource_key,
        f"{metadata_path}.mode_field_resource_key",
    )
    metadata_frequency_hz = require_finite_number(
        metadata.get("frequency_hz"),
        f"{metadata_path}.frequency_hz",
    )
    require_close(metadata_frequency_hz, frequency_hz, f"{metadata_path}.frequency_hz")
    metadata_frequency_real_hz = require_finite_number(
        metadata.get("frequency_real_hz"),
        f"{metadata_path}.frequency_real_hz",
    )
    require_close(
        metadata_frequency_real_hz,
        frequency_real_hz,
        f"{metadata_path}.frequency_real_hz",
    )
    metadata_angular_frequency = require_finite_number(
        metadata.get("angular_frequency_rad_per_s"),
        f"{metadata_path}.angular_frequency_rad_per_s",
    )
    require_close(
        metadata_angular_frequency,
        angular_frequency_rad_per_s,
        f"{metadata_path}.angular_frequency_rad_per_s",
        absolute_tolerance=1.0e-3,
    )
    require_mode_metadata_matches_summary(mode, metadata, metadata_path)
    validate_mode_diagnostics_fields(metadata, metadata_path, frequency_hz)
    require_mode_metadata_summaries(metadata, metadata_path)
    require_mode_field_metadata(
        metadata,
        metadata_path,
        sample_index,
        raw_mode_index,
        require_zarr_mode_fields,
    )

    expected_meta_resource = mode_meta_resource_key(sample_index, raw_mode_index)
    if manifest_mode_resources and expected_meta_resource not in manifest_mode_resources:
        fail(f"manifest.resources.mode_field_resources missing {expected_meta_resource}")
    payload_value_count = require_non_negative_int(
        metadata.get("payload_value_count"),
        f"{metadata_path}.payload_value_count",
    )
    if require_zarr_mode_fields:
        zarr_payload_value_count = require_mode_zarr_payload(
            root,
            mode_zarr_array_path(sample_index, raw_mode_index),
            require_non_negative_int(
                metadata.get("mode_field_sample_count"),
                f"{metadata_path}.mode_field_sample_count",
            ),
            payload_value_count,
            f"mode {sample_index}/{raw_mode_index}",
        )
        require_equal(
            zarr_payload_value_count,
            payload_value_count,
            f"{metadata_path}.zarr_payload_value_count",
        )
    payload_value_count = require_mode_payload(
        root,
        mode_payload_path(sample_index, raw_mode_index),
        f"mode {sample_index}/{raw_mode_index}",
    )
    require_equal(
        metadata.get("payload_value_count"),
        payload_value_count,
        f"{metadata_path}.payload_value_count",
    )
    require_equal(
        metadata.get("complex_pair_count"),
        payload_value_count // 2,
        f"{metadata_path}.complex_pair_count",
    )
    return (
        sample_index,
        raw_mode_index,
        frequency_hz,
        frequency_real_hz,
        frequency_imag_hz,
        angular_frequency_rad_per_s,
    )


def validate_eigen_summary(
    summary: dict,
    known_modes: dict[tuple[int, int], tuple[float, float, float, float]],
    known_mode_summaries: dict[tuple[int, int], dict],
    requested_window_hz: list[float] | None,
) -> None:
    diagnostics = summary.get("solver_diagnostics")
    if not isinstance(diagnostics, dict):
        fail("eigen_summary.solver_diagnostics must be an object")
    constants = diagnostics.get("constants")
    if not isinstance(constants, dict):
        fail("eigen_summary.solver_diagnostics.constants must be an object")
    gamma_rad_s_t = require_finite_number(
        constants.get("gamma_rad_s_T"),
        "eigen_summary.solver_diagnostics.constants.gamma_rad_s_T",
    )
    gamma0_rad_s_per_a_m = require_finite_number(
        constants.get("gamma0_rad_s_per_A_m"),
        "eigen_summary.solver_diagnostics.constants.gamma0_rad_s_per_A_m",
    )
    mu0_t_m_per_a = require_finite_number(
        constants.get("mu0_T_m_per_A"),
        "eigen_summary.solver_diagnostics.constants.mu0_T_m_per_A",
    )
    require_close(
        gamma0_rad_s_per_a_m,
        mu0_t_m_per_a * gamma_rad_s_t,
        "eigen_summary.solver_diagnostics.constants.gamma0_rad_s_per_A_m",
        relative_tolerance=1.0e-12,
        absolute_tolerance=1.0e-9,
    )
    if diagnostics.get("dense_reference_oracle") is True:
        orthogonality = diagnostics.get("orthogonality")
        if not isinstance(orthogonality, list) or not orthogonality:
            fail("eigen_summary.solver_diagnostics.orthogonality must be a non-empty list")
    summary_modes = require_object_list(summary.get("modes"), "eigen_summary.modes")
    require_equal(summary.get("mode_count"), len(summary_modes), "eigen_summary.mode_count")
    for mode in summary_modes:
        sample_index = (
            require_non_negative_int(
                mode.get("sample_index"),
                "eigen_summary mode.sample_index",
            )
            if "sample_index" in mode
            else 0
        )
        raw_mode_index = require_non_negative_int(mode.get("index"), "eigen_summary mode.index")
        summary_mode_path = f"eigen_summary.modes[{sample_index}/{raw_mode_index}]"
        mode_key = (sample_index, raw_mode_index)
        if mode_key not in known_modes:
            fail(f"eigen_summary references unknown mode {mode_key!r}")
        spectrum_mode = known_mode_summaries.get(mode_key)
        if spectrum_mode is None:
            fail(f"eigen_summary references unknown mode summary {mode_key!r}")
        frequency_hz = require_finite_number(mode.get("frequency_hz"), "eigen_summary mode.frequency_hz")
        require_equal(
            mode.get("frequency_hz"),
            spectrum_mode.get("frequency_hz"),
            f"{summary_mode_path}.frequency_hz vs mode.frequency_hz",
        )
        require_frequency_inside_window(
            frequency_hz,
            requested_window_hz,
            f"{summary_mode_path}.frequency_hz",
        )
        require_eigen_summary_mode_matches_spectrum(
            mode,
            spectrum_mode,
            summary_mode_path,
        )
        validate_mode_diagnostics_fields(
            mode,
            summary_mode_path,
            frequency_hz,
        )


def require_frequency_pair(value: object, name: str) -> list[float]:
    if not isinstance(value, list) or len(value) != 2:
        fail(f"{name} must be a two-element frequency range")
    lo = require_finite_number(value[0], f"{name}[0]")
    hi = require_finite_number(value[1], f"{name}[1]")
    if lo < 0.0 or hi < lo:
        fail(f"{name} must be an ordered non-negative frequency range")
    return [lo, hi]


def require_frequency_inside_window(
    frequency_hz: float,
    requested_window_hz: list[float] | None,
    name: str,
) -> None:
    if requested_window_hz is None:
        return
    lo, hi = requested_window_hz
    tolerance = max(abs(lo), abs(hi), 1.0) * 1.0e-12
    if frequency_hz < lo - tolerance or frequency_hz > hi + tolerance:
        fail(
            f"{name} must be inside solver_diagnostics.requested_window_hz: "
            f"got {frequency_hz!r}, expected [{lo!r}, {hi!r}]"
        )


def validate_solver_window_diagnostics(
    diagnostics: dict,
    *,
    require_window: bool,
) -> list[float] | None:
    if "window_completeness" not in diagnostics:
        if require_window:
            fail("solver_diagnostics.window_completeness is required")
        return None

    requested = require_frequency_pair(
        diagnostics.get("requested_window_hz"),
        "solver_diagnostics.requested_window_hz",
    )
    resolved = require_frequency_pair(
        diagnostics.get("resolved_search_window_hz"),
        "solver_diagnostics.resolved_search_window_hz",
    )
    if resolved[0] > requested[0] or resolved[1] < requested[1]:
        fail("solver_diagnostics.resolved_search_window_hz must cover requested_window_hz")
    requested_mode_count = require_non_negative_int(
        diagnostics.get("requested_mode_count"),
        "solver_diagnostics.requested_mode_count",
    )
    mode_count = require_non_negative_int(
        diagnostics.get("mode_count"),
        "solver_diagnostics.mode_count",
    )
    if mode_count > requested_mode_count:
        fail("solver_diagnostics.mode_count must not exceed requested_mode_count")

    completeness = diagnostics.get("window_completeness")
    if not isinstance(completeness, dict):
        fail("solver_diagnostics.window_completeness must be an object")
    policy = completeness.get("policy")
    if policy not in {"best_effort", "certified_count"}:
        fail("solver_diagnostics.window_completeness.policy is invalid")
    status = completeness.get("status")
    if status not in {
        "not_certified",
        "certified",
        "partial_convergence",
        "truncated_by_requested_count",
        "window_exhausted",
    }:
        fail("solver_diagnostics.window_completeness.status is invalid")
    certification_method = completeness.get("certification_method")
    if not isinstance(certification_method, str) or not certification_method:
        fail("solver_diagnostics.window_completeness.certification_method must be a string")
    if not isinstance(completeness.get("additional_modes_may_exist"), bool):
        fail("solver_diagnostics.window_completeness.additional_modes_may_exist must be boolean")
    if status == "truncated_by_requested_count":
        if mode_count != requested_mode_count:
            fail(
                "solver_diagnostics.window_completeness.status=truncated_by_requested_count "
                "requires mode_count to equal requested_mode_count"
            )
        if completeness.get("additional_modes_may_exist") is not True:
            fail(
                "solver_diagnostics.window_completeness.status=truncated_by_requested_count "
                "requires additional_modes_may_exist=true"
            )
    for key in ["estimated_modes_in_window", "certified_modes_in_window"]:
        if key in completeness:
            require_non_negative_int(
                completeness.get(key),
                f"solver_diagnostics.window_completeness.{key}",
            )

    top_level_subwindows = diagnostics.get("subwindows")
    if top_level_subwindows is None and "sample_solver_diagnostics" in diagnostics:
        sample_diagnostics = require_object_list(
            diagnostics.get("sample_solver_diagnostics"),
            "solver_diagnostics.sample_solver_diagnostics",
        )
        sample_count = require_non_negative_int(
            diagnostics.get("sample_count"),
            "solver_diagnostics.sample_count",
        )
        if not sample_diagnostics or len(sample_diagnostics) != sample_count:
            fail(
                "solver_diagnostics.sample_solver_diagnostics must contain one entry "
                "per field/k sample"
            )
        seen_sample_indices: set[int] = set()
        valid_sample_statuses = {"ok", "unavailable", "validation_error", "operator_error", "solve_error"}
        for sample_position, sample in enumerate(sample_diagnostics):
            sample_name = f"solver_diagnostics.sample_solver_diagnostics[{sample_position}]"
            sample_index = require_non_negative_int(
                sample.get("sample_index"),
                f"{sample_name}.sample_index",
            )
            if sample_index in seen_sample_indices:
                fail(f"{sample_name}.sample_index must be unique")
            seen_sample_indices.add(sample_index)
            executed = sample.get("diagnostics")
            if not isinstance(executed, dict):
                fail(f"{sample_name}.diagnostics must be an object")
            if "requested_window_hz" in executed:
                sample_requested = require_frequency_pair(
                    executed.get("requested_window_hz"),
                    f"{sample_name}.diagnostics.requested_window_hz",
                )
                require_close(sample_requested[0], requested[0], f"{sample_name}.diagnostics.requested_window_hz[0]")
                require_close(sample_requested[1], requested[1], f"{sample_name}.diagnostics.requested_window_hz[1]")
            subwindows = require_object_list(
                executed.get("subwindows"),
                f"{sample_name}.diagnostics.subwindows",
            )
            if not subwindows:
                fail(f"{sample_name}.diagnostics.subwindows must not be empty")
            seen_subwindow_indices: set[int] = set()
            for subwindow_position, subwindow in enumerate(subwindows):
                name = f"{sample_name}.diagnostics.subwindows[{subwindow_position}]"
                subwindow_index = require_non_negative_int(
                    subwindow.get("subwindow_index"),
                    f"{name}.subwindow_index",
                )
                if subwindow_index in seen_subwindow_indices:
                    fail(f"{name}.subwindow_index must be unique within its sample")
                seen_subwindow_indices.add(subwindow_index)
                shift_frequency_hz = require_finite_number(
                    subwindow.get("shift_frequency_hz"),
                    f"{name}.shift_frequency_hz",
                )
                if shift_frequency_hz < requested[0] or shift_frequency_hz > requested[1]:
                    fail(f"{name}.shift_frequency_hz must be inside requested_window_hz")
                if subwindow.get("status") not in valid_sample_statuses:
                    fail(f"{name}.status is invalid")
                require_non_negative_int(
                    subwindow.get("converged_eigenpair_count"),
                    f"{name}.converged_eigenpair_count",
                )
                candidate_mode_count = None
                if "candidate_mode_count" in subwindow:
                    candidate_mode_count = require_non_negative_int(
                        subwindow.get("candidate_mode_count"),
                        f"{name}.candidate_mode_count",
                    )
                accepted_mode_count = require_non_negative_int(
                    subwindow.get("accepted_mode_count"),
                    f"{name}.accepted_mode_count",
                )
                if (
                    candidate_mode_count is not None
                    and accepted_mode_count > candidate_mode_count
                ):
                    fail(f"{name}.accepted_mode_count must not exceed candidate_mode_count")
                accepted_frequencies = subwindow.get("accepted_frequencies_hz")
                if not isinstance(accepted_frequencies, list):
                    fail(f"{name}.accepted_frequencies_hz must be a list")
                if len(accepted_frequencies) != accepted_mode_count:
                    fail(f"{name}.accepted_frequencies_hz must match accepted_mode_count")
                for frequency_position, frequency in enumerate(accepted_frequencies):
                    value = require_finite_number(
                        frequency,
                        f"{name}.accepted_frequencies_hz[{frequency_position}]",
                    )
                    if value < 0.0:
                        fail(f"{name}.accepted_frequencies_hz must be non-negative")
        return requested

    subwindows = require_object_list(
        top_level_subwindows,
        "solver_diagnostics.subwindows",
    )
    if not subwindows:
        fail("solver_diagnostics.subwindows must not be empty")
    valid_stop_reasons = {
        "converged",
        "window_exhausted",
        "partial_convergence",
        "max_iterations",
        "linear_solve_failed",
        "residual_not_met",
        "cancelled",
        "capability_missing",
        "operator_invalid",
    }
    for position, subwindow in enumerate(subwindows):
        name = f"solver_diagnostics.subwindows[{position}]"
        require_non_negative_int(subwindow.get("index"), f"{name}.index")
        requested_hz = require_frequency_pair(subwindow.get("requested_hz"), f"{name}.requested_hz")
        search_hz = require_frequency_pair(subwindow.get("search_hz"), f"{name}.search_hz")
        if search_hz[0] > requested_hz[0] or search_hz[1] < requested_hz[1]:
            fail(f"{name}.search_hz must cover requested_hz")
        shift_hz = require_finite_number(subwindow.get("shift_hz"), f"{name}.shift_hz")
        shift_frequency_hz = require_finite_number(
            subwindow.get("shift_frequency_hz"),
            f"{name}.shift_frequency_hz",
        )
        require_close(
            shift_frequency_hz,
            shift_hz,
            f"{name}.shift_frequency_hz",
        )
        if shift_hz < requested_hz[0] or shift_hz > requested_hz[1]:
            fail(f"{name}.shift_hz must be inside requested_hz")
        require_close(
            require_finite_number(subwindow.get("shift_omega_rad_s"), f"{name}.shift_omega_rad_s"),
            TWO_PI * shift_frequency_hz,
            f"{name}.shift_omega_rad_s",
            absolute_tolerance=1.0e-3,
        )
        require_non_negative_int(subwindow.get("outer_iterations"), f"{name}.outer_iterations")
        require_non_negative_int(
            subwindow.get("linear_iterations_total"),
            f"{name}.linear_iterations_total",
        )
        require_non_negative_int(subwindow.get("candidate_modes"), f"{name}.candidate_modes")
        require_non_negative_int(subwindow.get("accepted_modes"), f"{name}.accepted_modes")
        residual = require_finite_number(subwindow.get("residual_max"), f"{name}.residual_max")
        if residual < 0.0:
            fail(f"{name}.residual_max must be non-negative")
        if subwindow.get("stop_reason") not in valid_stop_reasons:
            fail(f"{name}.stop_reason is invalid")
    return requested


def validate_solver_provenance(
    diagnostics: dict,
    *,
    require_production_shift_invert_window: bool,
    require_production_modal_k_path: bool,
    require_production_gamma_k_path: bool,
    require_reference_full_2x2_floquet: bool,
) -> None:
    algebraic_form = require_non_empty_string(
        diagnostics.get("algebraic_form"),
        "solver_diagnostics.algebraic_form",
    )
    if algebraic_form not in ALLOWED_MODAL_ALGEBRAIC_FORMS:
        fail("solver_diagnostics.algebraic_form is invalid")
    require_non_empty_string(
        diagnostics.get("matrix_equation"),
        "solver_diagnostics.matrix_equation",
    )
    phasor_convention = require_non_empty_string(
        diagnostics.get("phasor_convention"),
        "solver_diagnostics.phasor_convention",
    )
    if phasor_convention not in ALLOWED_MODAL_PHASOR_CONVENTIONS:
        fail("solver_diagnostics.phasor_convention is invalid")
    diagnostics_mapping = require_non_empty_string(
        diagnostics.get("eigenvalue_mapping"),
        "solver_diagnostics.eigenvalue_mapping",
    )
    if (
        diagnostics_mapping not in ALLOWED_MODAL_EIGENVALUE_MAPPINGS
        and "gamma0_rad_s_per_A_m" not in diagnostics_mapping
    ):
        fail("solver_diagnostics.eigenvalue_mapping is invalid")
    require_non_empty_string(
        diagnostics.get("frequency_mapping"),
        "solver_diagnostics.frequency_mapping",
    )
    if not isinstance(diagnostics.get("production_gyrotropic_mapping"), bool):
        fail("solver_diagnostics.production_gyrotropic_mapping must be boolean")
    solver_model = require_non_empty_string(
        diagnostics.get("solver_model"),
        "solver_diagnostics.solver_model",
    )
    resolved_solver_family = require_non_empty_string(
        diagnostics.get("resolved_solver_family"),
        "solver_diagnostics.resolved_solver_family",
    )
    spectral_transform = require_non_empty_string(
        diagnostics.get("spectral_transform"),
        "solver_diagnostics.spectral_transform",
    )
    if spectral_transform not in {"none", "shift_invert", "contour_integral", "dense_generalized"}:
        fail("solver_diagnostics.spectral_transform is invalid")
    if require_reference_full_2x2_floquet:
        require_equal(
            solver_model,
            "reference_full_2x2_tangent",
            "solver_diagnostics.solver_model",
        )
        solver_notes = require_string_list(
            diagnostics.get("solver_notes"),
            "solver_diagnostics.solver_notes",
        )
        if "cpu_full_2x2_phase_reduced_floquet" not in solver_notes:
            fail(
                "solver_diagnostics.solver_notes must include "
                "'cpu_full_2x2_phase_reduced_floquet'"
            )
        require_equal(
            diagnostics.get("basis_transport_policy"),
            "tangent_frame_transport",
            "solver_diagnostics.basis_transport_policy",
        )
        frame_mismatch = require_finite_number(
            diagnostics.get("floquet_tangent_frame_max_mismatch"),
            "solver_diagnostics.floquet_tangent_frame_max_mismatch",
        )
        if frame_mismatch < 0.0:
            fail("solver_diagnostics.floquet_tangent_frame_max_mismatch must be non-negative")
        nonunitarity = require_finite_number(
            diagnostics.get("floquet_tangent_transport_max_nonunitarity"),
            "solver_diagnostics.floquet_tangent_transport_max_nonunitarity",
        )
        if nonunitarity < 0.0:
            fail("solver_diagnostics.floquet_tangent_transport_max_nonunitarity must be non-negative")
        if "requested_window_hz" in diagnostics and diagnostics.get("sample_count", 0) > 1:
            require_equal(
                diagnostics.get("frequency_window_solver_policy"),
                "reference_k_path_window_filter_not_shift_invert_or_feast",
                "solver_diagnostics.frequency_window_solver_policy",
            )
            window_completeness = diagnostics.get("window_completeness")
            if not isinstance(window_completeness, dict):
                fail("solver_diagnostics.window_completeness must be an object")
            require_equal(
                window_completeness.get("status"),
                "not_certified",
                "solver_diagnostics.window_completeness.status",
            )
            require_equal(
                window_completeness.get("certification_method"),
                "none",
                "solver_diagnostics.window_completeness.certification_method",
            )
            require_equal(
                window_completeness.get("additional_modes_may_exist"),
                True,
                "solver_diagnostics.window_completeness.additional_modes_may_exist",
            )
            require_equal(
                diagnostics.get("production_solver_available"),
                False,
                "solver_diagnostics.production_solver_available",
            )
            validate_reference_full_2x2_floquet_rejection_contract(
                diagnostics,
                prefix="solver_diagnostics",
            )
            require_equal(
                spectral_transform,
                "none",
                "solver_diagnostics.spectral_transform",
            )
    if require_production_modal_k_path or require_production_gamma_k_path:
        sample_count = require_non_negative_int(
            diagnostics.get("sample_count"),
            "solver_diagnostics.sample_count",
        )
        if sample_count <= 1:
            fail(
                "production modal k-path requires solver_diagnostics.sample_count > 1"
            )
        if solver_model not in PRODUCTION_SHIFT_INVERT_SOLVER_MODELS:
            fail(
                "production modal k-path requires the managed production "
                f"selected-spectrum adapter; got solver_model={solver_model!r}"
            )
        require_equal(
            diagnostics.get("solver_family"),
            solver_model,
            "solver_diagnostics.solver_family",
        )
        require_equal(
            resolved_solver_family,
            "shift_invert",
            "solver_diagnostics.resolved_solver_family",
        )
        require_equal(
            spectral_transform,
            "shift_invert",
            "solver_diagnostics.spectral_transform",
        )
        require_equal(
            diagnostics.get("solver_adapter"),
            "slepc_modal_eigen",
            "solver_diagnostics.solver_adapter",
        )
        require_equal(
            diagnostics.get("execution_lane"),
            "production_cpu",
            "solver_diagnostics.execution_lane",
        )
        require_equal(
            phasor_convention,
            "exp_i_omega_t",
            "solver_diagnostics.phasor_convention",
        )
        require_equal(
            diagnostics.get("production_solver_available"),
            True,
            "solver_diagnostics.production_solver_available",
        )
        require_equal(
            diagnostics.get("dense_reference_oracle"),
            False,
            "solver_diagnostics.dense_reference_oracle",
        )
        if (
            diagnostics.get("frequency_window_solver_policy")
            == "reference_k_path_window_filter_not_shift_invert_or_feast"
        ):
            fail(
                "production modal k-path must not use the reference "
                "k-path window-filter policy"
            )
        if require_production_modal_k_path:
            require_equal(
                diagnostics.get("basis_transport_policy"),
                "tangent_frame_transport",
                "solver_diagnostics.basis_transport_policy",
            )
            operator_diagnostics = diagnostics.get("operator_diagnostics")
            if not isinstance(operator_diagnostics, dict):
                fail("solver_diagnostics.operator_diagnostics must be an object")
            require_equal(
                operator_diagnostics.get("payload_kind"),
                "bloch_floquet_tangent_operator",
                "solver_diagnostics.operator_diagnostics.payload_kind",
            )
            if operator_diagnostics.get("demag_payload_kind") is not None:
                fail(
                    "solver_diagnostics.operator_diagnostics.demag_payload_kind "
                    "must be absent for the current no-demag production modal k-path gate"
                )
            reject_terms_if_present(
                operator_diagnostics,
                "solver_diagnostics.operator_diagnostics",
            )
            require_equal(
                diagnostics.get("modal_periodic_pair_contract_available"),
                True,
                "solver_diagnostics.modal_periodic_pair_contract_available",
            )
            floquet_periodic_pair_count = require_non_negative_int(
                diagnostics.get("floquet_periodic_pair_count"),
                "solver_diagnostics.floquet_periodic_pair_count",
            )
            if floquet_periodic_pair_count <= 0:
                fail("solver_diagnostics.floquet_periodic_pair_count must be positive")
            validate_periodic_mesh_certificate(
                diagnostics.get("periodic_mesh_certificate"),
                name="solver_diagnostics.periodic_mesh_certificate",
            )
            frame_mismatch = require_finite_number(
                diagnostics.get("floquet_tangent_frame_max_mismatch"),
                "solver_diagnostics.floquet_tangent_frame_max_mismatch",
            )
            if frame_mismatch < 0.0:
                fail("solver_diagnostics.floquet_tangent_frame_max_mismatch must be non-negative")
            nonunitarity = require_finite_number(
                diagnostics.get("floquet_tangent_transport_max_nonunitarity"),
                "solver_diagnostics.floquet_tangent_transport_max_nonunitarity",
            )
            if nonunitarity < 0.0:
                fail("solver_diagnostics.floquet_tangent_transport_max_nonunitarity must be non-negative")
        if "requested_window_hz" in diagnostics:
            window_completeness = diagnostics.get("window_completeness")
            if not isinstance(window_completeness, dict):
                fail("solver_diagnostics.window_completeness must be an object")
            require_equal(
                window_completeness.get("status"),
                "not_certified",
                "solver_diagnostics.window_completeness.status",
            )
            require_equal(
                window_completeness.get("certification_method"),
                "none",
                "solver_diagnostics.window_completeness.certification_method",
            )
            require_equal(
                window_completeness.get("additional_modes_may_exist"),
                True,
                "solver_diagnostics.window_completeness.additional_modes_may_exist",
            )
    if not require_production_shift_invert_window:
        return

    if solver_model not in PRODUCTION_SHIFT_INVERT_SOLVER_MODELS:
        fail(
            "solver_diagnostics.solver_model must identify the managed "
            f"production shift-invert adapter; got {solver_model!r}"
        )
    require_equal(
        diagnostics.get("solver_family"),
        solver_model,
        "solver_diagnostics.solver_family",
    )
    require_equal(
        resolved_solver_family,
        "shift_invert",
        "solver_diagnostics.resolved_solver_family",
    )
    require_equal(
        spectral_transform,
        "shift_invert",
        "solver_diagnostics.spectral_transform",
    )
    require_equal(
        diagnostics.get("solver_adapter"),
        "slepc_modal_eigen",
        "solver_diagnostics.solver_adapter",
    )
    require_equal(
        diagnostics.get("execution_lane"),
        "production_cpu",
        "solver_diagnostics.execution_lane",
    )
    require_equal(
        diagnostics.get("production_solver_available"),
        True,
        "solver_diagnostics.production_solver_available",
    )
    require_equal(
        diagnostics.get("dense_reference_oracle"),
        False,
        "solver_diagnostics.dense_reference_oracle",
    )


def validate_dispersion_manifest_capabilities(
    manifest: dict,
    *,
    require_reference_full_2x2_floquet: bool,
    require_production_modal_k_path: bool,
    require_production_gamma_k_path: bool,
) -> None:
    if (
        not require_reference_full_2x2_floquet
        and not require_production_modal_k_path
        and not require_production_gamma_k_path
    ):
        return
    capabilities = manifest.get("capabilities")
    if not isinstance(capabilities, dict):
        fail("manifest.capabilities must be an object for modal k-path gates")
    dispersion = capabilities.get("dispersion")
    if not isinstance(dispersion, dict):
        fail("manifest.capabilities.dispersion must be an object for modal k-path gates")
    require_capability_status(
        dispersion,
        "reference_cpu",
        "reference_executable",
        "manifest.capabilities.dispersion",
    )
    require_capability_status(
        dispersion,
        "production_cpu_gamma_k_path",
        "partial_production_executable",
        "manifest.capabilities.dispersion",
    )
    require_capability_status(
        dispersion,
        "production_gpu",
        "unsupported",
        "manifest.capabilities.dispersion",
    )
    require_capability_status(
        dispersion,
        "k_path",
        "reference_executable",
        "manifest.capabilities.dispersion",
    )
    require_capability_status(
        dispersion,
        "branch_tracking",
        "reference_executable",
        "manifest.capabilities.dispersion",
    )
    production_gpu_reason = dispersion.get("production_gpu", {}).get("reason")
    if not isinstance(production_gpu_reason, str) or "modal GPU" not in production_gpu_reason:
        fail(
            "manifest.capabilities.dispersion.production_gpu.reason must "
            "explain that modal GPU dispersion is unavailable"
        )
    if require_production_modal_k_path or require_production_gamma_k_path:
        require_equal(
            capabilities.get("production_native_solver_available"),
            True,
            "manifest.capabilities.production_native_solver_available",
        )
        require_equal(
            capabilities.get("validation_artifact"),
            False,
            "manifest.capabilities.validation_artifact",
        )
        require_capability_status(
            dispersion,
            "production_cpu",
            "partial_production_executable",
            "manifest.capabilities.dispersion",
        )
    elif require_reference_full_2x2_floquet:
        require_capability_status(
            dispersion,
            "production_cpu",
            "unsupported",
            "manifest.capabilities.dispersion",
        )


def require_capability_status(
    capabilities: dict,
    key: str,
    expected_status: str,
    name: str,
) -> None:
    entry = capabilities.get(key)
    entry_name = f"{name}.{key}"
    if not isinstance(entry, dict):
        fail(f"{entry_name} must be an object")
    require_equal(entry.get("status"), expected_status, f"{entry_name}.status")
    if not isinstance(entry.get("reason"), str) or not entry.get("reason"):
        fail(f"{entry_name}.reason must be a non-empty string")


def reject_terms_if_present(container: dict, name: str) -> None:
    terms = container.get("operator_terms_included")
    if terms is None:
        return
    if not isinstance(terms, list) or any(not isinstance(term, str) for term in terms):
        fail(f"{name}.operator_terms_included must be a string list when present")
    gated_terms = {
        "demag",
        "dynamic_demag",
        "periodic_poisson",
        "floquet_airbox",
        "dmi",
        "interfacial_dmi",
        "bulk_dmi",
        "magnetoelastic",
    }
    present = sorted(term for term in terms if term in gated_terms)
    if present:
        fail(
            f"{name}.operator_terms_included contains gated production "
            f"k-path term(s): {present!r}"
        )


def reject_driven_response_manifest_payloads(manifest: dict) -> None:
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict):
        fail("manifest.artifacts must be an object for production modal k-path gates")
    for field_name in [
        "response_sweep_v1_path",
        "response_sweep_v2_path",
        "response_map_v1_path",
        "response_map_v2_path",
        "response_diagnostics_v1_path",
        "response_progress_v1_path",
        "response_cancel_requested_v1_path",
    ]:
        require_equal(
            artifacts.get(field_name),
            None,
            f"manifest.artifacts.{field_name}",
        )
    frequency_point_paths = artifacts.get("frequency_point_paths")
    if frequency_point_paths not in (None, []):
        fail("manifest.artifacts.frequency_point_paths must be empty for production modal k-path gates")

    resources = manifest.get("resources")
    if not isinstance(resources, dict):
        fail("manifest.resources must be an object for production modal k-path gates")
    for field_name in [
        "response_sweep_resource_key",
        "response_map_resource_key",
        "response_progress_resource_key",
        "response_cancel_requested_resource_key",
        "response_diagnostics_resource_key",
    ]:
        require_equal(
            resources.get(field_name),
            None,
            f"manifest.resources.{field_name}",
        )
    response_field_resources = resources.get("response_field_resources")
    if response_field_resources not in (None, []):
        fail("manifest.resources.response_field_resources must be empty for production modal k-path gates")

    capabilities = manifest.get("capabilities")
    if not isinstance(capabilities, dict):
        fail("manifest.capabilities must be an object for production modal k-path gates")
    require_equal(
        capabilities.get("driven_response_artifact_available"),
        False,
        "manifest.capabilities.driven_response_artifact_available",
    )
    require_equal(
        capabilities.get("modal_artifact_available"),
        True,
        "manifest.capabilities.modal_artifact_available",
    )


def validate_reference_full_2x2_floquet_manifest_diagnostics(
    manifest_diagnostics: dict,
    solver_diagnostics: dict,
    *,
    require_reference_full_2x2_floquet: bool,
) -> None:
    if not require_reference_full_2x2_floquet:
        return
    if (
        "requested_window_hz" not in solver_diagnostics
        or solver_diagnostics.get("sample_count", 0) <= 1
    ):
        return
    validate_reference_full_2x2_floquet_rejection_contract(
        manifest_diagnostics,
        prefix="manifest.diagnostics",
        expected_reason=solver_diagnostics.get("production_cpu_rejection_reason"),
    )


def validate_production_modal_k_path_manifest_certificate(
    manifest_diagnostics: dict,
    solver_diagnostics: dict,
    *,
    require_production_modal_k_path: bool,
) -> None:
    if not require_production_modal_k_path:
        return
    solver_hash = validate_periodic_mesh_certificate(
        solver_diagnostics.get("periodic_mesh_certificate"),
        name="solver_diagnostics.periodic_mesh_certificate",
    )
    manifest_hash = validate_periodic_mesh_certificate(
        manifest_diagnostics.get("periodic_mesh_certificate"),
        name="manifest.diagnostics.periodic_mesh_certificate",
    )
    require_equal(
        manifest_hash,
        solver_hash,
        "manifest.diagnostics.periodic_mesh_certificate.magnetic_pair_map_sha256",
    )


def validate_production_modal_k_path_scope(
    manifest: dict,
    *,
    require_production_modal_k_path: bool,
    require_production_gamma_k_path: bool,
) -> None:
    if not require_production_modal_k_path and not require_production_gamma_k_path:
        return
    if require_production_modal_k_path:
        require_equal(
            manifest.get("stage_id"),
            "eigenmodes",
            "manifest.stage_id",
        )
    requested_execution = manifest.get("requested_execution")
    if not isinstance(requested_execution, dict):
        fail("manifest.requested_execution must be an object for production modal k-path gates")
    if require_production_modal_k_path:
        require_equal(
            requested_execution.get("calculation_mode"),
            "dispersion_modal",
            "manifest.requested_execution.calculation_mode",
        )
        require_equal(
            requested_execution.get("backend"),
            "fem",
            "manifest.requested_execution.backend",
        )
        require_equal(
            requested_execution.get("device"),
            "cpu",
            "manifest.requested_execution.device",
        )
        require_equal(
            requested_execution.get("precision"),
            "double",
            "manifest.requested_execution.precision",
        )
        require_equal(
            requested_execution.get("solver_family"),
            "modal_eigen",
            "manifest.requested_execution.solver_family",
        )
        require_equal(
            requested_execution.get("solve_equation"),
            "A q = lambda B q; lambda = i omega",
            "manifest.requested_execution.solve_equation",
        )
        require_equal(
            requested_execution.get("include_demag"),
            False,
            "manifest.requested_execution.include_demag",
        )
    if requested_execution.get("include_dmi") is True:
        fail("manifest.requested_execution.include_dmi must not be true for production modal k-path gates")
    reject_terms_if_present(requested_execution, "manifest.requested_execution")

    resolved_execution = manifest.get("resolved_execution")
    if not isinstance(resolved_execution, dict):
        fail("manifest.resolved_execution must be an object for production modal k-path gates")
    if require_production_modal_k_path:
        require_equal(
            resolved_execution.get("backend"),
            "fem",
            "manifest.resolved_execution.backend",
        )
        require_equal(
            resolved_execution.get("device"),
            "cpu",
            "manifest.resolved_execution.device",
        )
        require_equal(
            resolved_execution.get("precision"),
            "double",
            "manifest.resolved_execution.precision",
        )
        require_equal(
            resolved_execution.get("demag_realization"),
            "none",
            "manifest.resolved_execution.demag_realization",
        )
        require_equal(
            resolved_execution.get("native_backend"),
            "native_cpu",
            "manifest.resolved_execution.native_backend",
        )
        require_equal(
            resolved_execution.get("reference_or_production"),
            "production",
            "manifest.resolved_execution.reference_or_production",
        )
        require_equal(
            resolved_execution.get("solver_library"),
            "slepc",
            "manifest.resolved_execution.solver_library",
        )
        require_equal(
            resolved_execution.get("solver_algorithm"),
            "slepc_multi_shift_invert_production_cpu_dense",
            "manifest.resolved_execution.solver_algorithm",
        )
        require_equal(
            resolved_execution.get("solve_kind"),
            "modal_eigen",
            "manifest.resolved_execution.solve_kind",
        )
        reject_driven_response_manifest_payloads(manifest)
    reject_terms_if_present(resolved_execution, "manifest.resolved_execution")


def validate_reference_full_2x2_floquet_mode_metadata(
    root: Path,
    mode_metadata_paths: set[str],
) -> None:
    if not mode_metadata_paths:
        fail("manifest.artifacts.mode_metadata_paths must not be empty")
    for metadata_path in sorted(mode_metadata_paths):
        metadata = load_json(root / metadata_path)
        if metadata.get("solver_model") == "cpu_full_2x2_phase_reduced_floquet":
            return
    fail(
        "at least one mode metadata artifact must report "
        "solver_model='cpu_full_2x2_phase_reduced_floquet'"
    )


def validate_reference_full_2x2_floquet_dispersion_path(
    known_modes: dict[tuple[int, int], tuple[float, float, float, float]],
    known_samples: dict[int, tuple[float, tuple[float, float, float], str]],
    branch_ids_by_mode: dict[tuple[int, int], int],
) -> None:
    if len(known_samples) < 3:
        fail("reference Full2x2 Floquet dispersion requires at least 3 samples")

    nonzero_k_samples = [
        sample_index
        for sample_index, (_path_s, k_vector, _label) in known_samples.items()
        if math.sqrt(sum(component * component for component in k_vector)) > 0.0
    ]
    if not nonzero_k_samples:
        fail("reference Full2x2 Floquet dispersion requires at least one nonzero k-vector")

    ordered_samples = sorted(known_samples.items(), key=lambda item: item[1][0])
    path_values = [path_s for _sample_index, (path_s, _k_vector, _label) in ordered_samples]
    if any(next_path <= path for path, next_path in zip(path_values, path_values[1:])):
        fail("reference Full2x2 Floquet dispersion path_s values must be strictly increasing")
    endpoint_labels = [
        ordered_samples[0][1][2].strip(),
        ordered_samples[-1][1][2].strip(),
    ]
    if not all(endpoint_labels):
        fail("reference Full2x2 Floquet dispersion requires labelled path endpoints")

    modes_by_branch: dict[int, list[tuple[int, float, float]]] = {}
    for mode_key, branch_id in branch_ids_by_mode.items():
        if mode_key not in known_modes:
            continue
        sample_index, _raw_mode_index = mode_key
        sample = known_samples.get(sample_index)
        if sample is None:
            continue
        path_s, _k_vector, _label = sample
        frequency_hz, _frequency_real_hz, _frequency_imag_hz, _omega = known_modes[mode_key]
        modes_by_branch.setdefault(branch_id, []).append((sample_index, path_s, frequency_hz))

    for branch_id, branch_modes in modes_by_branch.items():
        if len(branch_modes) < 3:
            continue
        branch_modes = sorted(branch_modes, key=lambda item: item[1])
        branch_frequencies = [frequency for _sample_index, _path_s, frequency in branch_modes]
        frequency_span = max(branch_frequencies) - min(branch_frequencies)
        scale = max(max(abs(frequency) for frequency in branch_frequencies), 1.0)
        if frequency_span > max(scale * 1.0e-9, 1.0):
            return
        fail(
            "reference Full2x2 Floquet dispersion frequency span is too small "
            f"for branch {branch_id}: got {frequency_span!r} Hz"
        )
    fail("reference Full2x2 Floquet dispersion requires a branch with at least 3 points")


def vector_magnitude(values: tuple[float, float, float]) -> float:
    return math.sqrt(sum(value * value for value in values))


def vector_distance(
    lhs: tuple[float, float, float],
    rhs: tuple[float, float, float],
) -> float:
    return math.sqrt(sum((left - right) ** 2 for left, right in zip(lhs, rhs)))


def dispersion_k_sampling_sources(root: Path) -> list[tuple[str, dict]]:
    sources: list[tuple[str, dict]] = []
    path_metadata_path = root / "eigen" / "dispersion" / "path.json"
    if path_metadata_path.is_file():
        path_metadata = load_json(path_metadata_path)
        sampling = path_metadata.get("sampling", path_metadata)
        if not isinstance(sampling, dict):
            fail("eigen/dispersion/path.json sampling metadata must be an object")
        sources.append(("eigen/dispersion/path.json", sampling))

    execution_metadata_path = root / "metadata.json"
    if execution_metadata_path.is_file():
        execution_metadata = load_json(execution_metadata_path)
        plan = execution_metadata.get("execution_plan", {}).get("backend_plan")
        if isinstance(plan, dict):
            sampling = plan.get("k_sampling")
            if isinstance(sampling, dict):
                sources.append(
                    ("metadata.execution_plan.backend_plan.k_sampling", sampling)
                )
    return sources


def validate_dispersion_k_sampling_path(
    root: Path,
    known_samples: dict[int, tuple[float, tuple[float, float, float], str]],
    *,
    require_path_metadata: bool = False,
) -> None:
    path_metadata_path = root / "eigen" / "dispersion" / "path.json"
    if require_path_metadata:
        require_file(path_metadata_path)
    for source_name, sampling in dispersion_k_sampling_sources(root):
        if sampling.get("kind") != "path":
            continue
        points = require_object_list(
            sampling.get("points"),
            f"{source_name}.points",
        )
        if len(points) < 2:
            fail(f"{source_name}.points must include at least two control points")
        control_vectors = [
            require_vector3(
                point.get("k_vector"),
                f"{source_name}.points[{index}].k_vector",
            )
            for index, point in enumerate(points)
        ]
        control_labels = []
        for index, point in enumerate(points):
            label = point.get("label", "")
            if label is None:
                label = ""
            if not isinstance(label, str):
                fail(f"{source_name}.points[{index}].label must be a string or null")
            control_labels.append(label)
        raw_samples_per_segment = sampling.get("samples_per_segment")
        if not isinstance(raw_samples_per_segment, list):
            fail(f"{source_name}.samples_per_segment must be a list")
        samples_per_segment = [
            require_non_negative_int(
                sample_count,
                f"{source_name}.samples_per_segment[{index}]",
            )
            for index, sample_count in enumerate(raw_samples_per_segment)
        ]
        if any(sample_count == 0 for sample_count in samples_per_segment):
            fail(f"{source_name}.samples_per_segment entries must be positive")
        closed = False
        if "closed" in sampling:
            closed = require_boolean(sampling.get("closed"), f"{source_name}.closed")
        expected_segment_count = len(points) if closed else len(points) - 1
        if len(samples_per_segment) != expected_segment_count:
            fail(
                f"{source_name} expected {expected_segment_count} "
                "samples_per_segment entries, got "
                f"{len(samples_per_segment)}"
            )
        expected_sample_count = sum(samples_per_segment) + 1
        if len(known_samples) != expected_sample_count:
            fail(
                f"{source_name} expected {expected_sample_count} dispersion "
                f"sample(s), got {len(known_samples)}"
            )
        ordered_samples = sorted(known_samples.items(), key=lambda item: item[1][0])
        segment_pairs = [
            (control_vectors[index], control_vectors[index + 1])
            for index in range(len(control_vectors) - 1)
        ]
        if closed:
            segment_pairs.append((control_vectors[-1], control_vectors[0]))
        degenerate_path = all(
            vector_distance(start, end) <= 1.0e-12
            for start, end in segment_pairs
        )
        path_values = [
            path_s for _sample_index, (path_s, _k_vector, _label) in ordered_samples
        ]
        if not degenerate_path and any(
            next_path <= path for path, next_path in zip(path_values, path_values[1:])
        ):
            fail(f"{source_name} dispersion path_s values must be strictly increasing")

        require_control_sample_match = (
            source_name == "eigen/dispersion/path.json" or closed
        )
        if require_control_sample_match:
            control_sample_position = 0
            control_expectations = [
                (0, control_vectors[0], control_labels[0], "initial control point")
            ]
            for segment_index, sample_count in enumerate(samples_per_segment):
                control_sample_position += sample_count
                target_control_index = (segment_index + 1) % len(control_vectors)
                control_expectations.append(
                    (
                        control_sample_position,
                        control_vectors[target_control_index],
                        control_labels[target_control_index],
                        f"control point {target_control_index}",
                    )
                )
            for sample_position, expected_k_vector, expected_label, label_path in control_expectations:
                if sample_position >= len(ordered_samples):
                    fail(f"{source_name}.{label_path} sample position is outside dispersion samples")
                sample_index, (_path_s, actual_k_vector, actual_label) = ordered_samples[
                    sample_position
                ]
                for component_index, (actual, expected) in enumerate(
                    zip(actual_k_vector, expected_k_vector)
                ):
                    require_close(
                        actual,
                        expected,
                        f"{source_name}.{label_path}.sample[{sample_index}].k_vector[{component_index}]",
                        absolute_tolerance=1.0e-6,
                    )
                if expected_label and actual_label:
                    require_equal(
                        actual_label,
                        expected_label,
                        f"{source_name}.{label_path}.sample[{sample_index}].label",
                    )

        require_endpoint_match = (
            source_name == "eigen/dispersion/path.json" or closed
        )
        if not require_endpoint_match:
            continue
        if degenerate_path:
            continue
        total_path_s = sum(vector_distance(start, end) for start, end in segment_pairs)
        final_path_s, final_k_vector, _final_label = ordered_samples[-1][1]
        require_close(
            final_path_s,
            total_path_s,
            f"{source_name}.final_path_s_rad_per_m",
            absolute_tolerance=1.0e-6,
        )
        endpoint_k_vector = control_vectors[0] if closed else control_vectors[-1]
        endpoint_label = (
            "closed k-path final sample" if closed else "open k-path final sample"
        )
        for component_index, (actual, expected) in enumerate(
            zip(final_k_vector, endpoint_k_vector)
        ):
            require_close(
                actual,
                expected,
                f"{source_name}.{endpoint_label}.k_vector[{component_index}]",
                absolute_tolerance=1.0e-6,
            )


def validate_production_k_path_samples(
    known_samples: dict[int, tuple[float, tuple[float, float, float], str]],
    *,
    require_production_modal_k_path: bool,
    require_production_gamma_k_path: bool,
) -> None:
    if not require_production_modal_k_path and not require_production_gamma_k_path:
        return
    nonzero_sample_indices = [
        sample_index
        for sample_index, (_path_s, k_vector, _label) in known_samples.items()
        if vector_magnitude(k_vector) > 1.0e-12
    ]
    if require_production_modal_k_path and not nonzero_sample_indices:
        fail(
            "production nonzero-k modal dispersion requires at least one "
            "nonzero k-vector; use --require-production-gamma-k-path for "
            "gamma-equivalent adapter bundles"
        )
    if require_production_gamma_k_path and nonzero_sample_indices:
        fail(
            "production gamma k-path requires all sampled k-vectors to be "
            f"gamma-equivalent zero; nonzero samples={nonzero_sample_indices!r}"
        )


def validate_production_k_path_mode_quality(
    known_mode_summaries: dict[tuple[int, int], dict],
    *,
    require_production_modal_k_path: bool,
    require_production_gamma_k_path: bool,
) -> None:
    if not require_production_modal_k_path and not require_production_gamma_k_path:
        return
    for (sample_index, raw_mode_index), mode in sorted(known_mode_summaries.items()):
        mode_name = f"spectrum.samples[{sample_index}].modes[{raw_mode_index}]"
        residual_relative_l2 = require_finite_number(
            mode.get("residual_relative_l2"),
            f"{mode_name}.residual_relative_l2",
        )
        if residual_relative_l2 > PRODUCTION_K_PATH_MAX_RESIDUAL_RELATIVE_L2:
            fail(
                f"{mode_name}.residual_relative_l2 exceeds production k-path "
                f"tolerance: got {residual_relative_l2!r}, "
                f"expected <= {PRODUCTION_K_PATH_MAX_RESIDUAL_RELATIVE_L2!r}"
            )
        tangent_leakage_max_abs = require_finite_number(
            mode.get("tangent_leakage_max_abs"),
            f"{mode_name}.tangent_leakage_max_abs",
        )
        if tangent_leakage_max_abs > PRODUCTION_K_PATH_MAX_TANGENT_LEAKAGE_ABS:
            fail(
                f"{mode_name}.tangent_leakage_max_abs exceeds production k-path "
                f"tolerance: got {tangent_leakage_max_abs!r}, "
                f"expected <= {PRODUCTION_K_PATH_MAX_TANGENT_LEAKAGE_ABS!r}"
            )


def validate_production_k_path_solver_subwindows(
    diagnostics: dict,
    *,
    require_production_modal_k_path: bool,
    require_production_gamma_k_path: bool,
) -> None:
    if not require_production_modal_k_path and not require_production_gamma_k_path:
        return
    subwindows = require_object_list(
        diagnostics.get("subwindows"),
        "solver_diagnostics.subwindows",
    )
    for position, subwindow in enumerate(subwindows):
        name = f"solver_diagnostics.subwindows[{position}]"
        accepted_modes = require_non_negative_int(
            subwindow.get("accepted_modes"),
            f"{name}.accepted_modes",
        )
        if accepted_modes <= 0:
            fail(f"{name}.accepted_modes must be positive for production k-path gates")
        residual = require_finite_number(subwindow.get("residual_max"), f"{name}.residual_max")
        if residual > PRODUCTION_K_PATH_MAX_RESIDUAL_RELATIVE_L2:
            fail(
                f"{name}.residual_max exceeds production k-path tolerance: "
                f"got {residual!r}, "
                f"expected <= {PRODUCTION_K_PATH_MAX_RESIDUAL_RELATIVE_L2!r}"
            )


def validate_production_modal_k_path_branch_tracking(
    manifest_diagnostics: dict,
    branches: dict,
    branch_diagnostics: dict,
    tracking_sources_by_mode: dict[tuple[int, int], str],
    overlap_by_mode: dict[tuple[int, int], float],
    *,
    require_production_modal_k_path: bool,
) -> None:
    if not require_production_modal_k_path:
        return
    require_equal(
        manifest_diagnostics.get("modal_overlap_available"),
        True,
        "manifest.diagnostics.modal_overlap_available",
    )
    require_tracking_score_source(
        manifest_diagnostics.get("tracking_score_source"),
        "manifest.diagnostics.tracking_score_source",
        PRODUCTION_MODAL_K_PATH_SUMMARY_TRACKING_SOURCES,
    )
    require_equal(
        branches.get("modal_overlap_available"),
        True,
        "branches.modal_overlap_available",
    )
    require_tracking_score_source(
        branches.get("tracking_score_source"),
        "branches.tracking_score_source",
        PRODUCTION_MODAL_K_PATH_SUMMARY_TRACKING_SOURCES,
    )
    require_tracking_method(
        branches.get("tracking_method"),
        "branches.tracking_method",
        PRODUCTION_MODAL_K_PATH_TRACKING_METHODS,
    )
    overlap_floor = require_finite_number(
        branches.get("overlap_floor"),
        "branches.overlap_floor",
    )
    if overlap_floor < 0.0 or overlap_floor > 1.0:
        fail("branches.overlap_floor must be in [0, 1]")
    require_equal(
        branch_diagnostics.get("modal_overlap_available"),
        True,
        "branches.diagnostics.modal_overlap_available",
    )
    require_tracking_score_source(
        branch_diagnostics.get("tracking_score_source"),
        "branches.diagnostics.tracking_score_source",
        PRODUCTION_MODAL_K_PATH_SUMMARY_TRACKING_SOURCES,
    )
    min_overlap = require_finite_number(
        branch_diagnostics.get("min_overlap"),
        "branches.diagnostics.min_overlap",
    )
    if min_overlap < overlap_floor:
        fail(
            "branches.diagnostics.min_overlap is below branches.overlap_floor: "
            f"got {min_overlap!r}, expected >= {overlap_floor!r}"
        )
    fallback_modes = sorted(
        mode_key
        for mode_key, source in tracking_sources_by_mode.items()
        if source == "frequency_score_fallback"
    )
    if fallback_modes:
        fail(
            "production modal k-path requires modal-overlap branch tracking; "
            f"frequency fallback modes={fallback_modes!r}"
        )
    if "modal_overlap_weighted_score" not in set(tracking_sources_by_mode.values()):
        fail("production modal k-path requires modal-overlap branch tracking")
    modal_overlap_values = [
        overlap
        for mode_key, overlap in overlap_by_mode.items()
        if tracking_sources_by_mode.get(mode_key) == "modal_overlap_weighted_score"
    ]
    if not modal_overlap_values:
        fail("production modal k-path requires modal-overlap branch tracking")
    require_close(
        min_overlap,
        min(modal_overlap_values),
        "branches.diagnostics.min_overlap",
        absolute_tolerance=1.0e-12,
    )
    median_overlap = require_finite_number(
        branch_diagnostics.get("median_overlap"),
        "branches.diagnostics.median_overlap",
    )
    if median_overlap < 0.0 or median_overlap > 1.0:
        fail("branches.diagnostics.median_overlap must be in [0, 1]")
    require_close(
        median_overlap,
        median(modal_overlap_values),
        "branches.diagnostics.median_overlap",
        absolute_tolerance=1.0e-12,
    )
    low_overlap_modes = sorted(
        (mode_key, overlap)
        for mode_key, overlap in overlap_by_mode.items()
        if tracking_sources_by_mode.get(mode_key) == "modal_overlap_weighted_score"
        and overlap < overlap_floor
    )
    if low_overlap_modes:
        fail(
            "production modal k-path overlap is below branches.overlap_floor: "
            f"{low_overlap_modes!r}"
        )


def require_vector3(value: object, name: str) -> tuple[float, float, float]:
    if not isinstance(value, list) or len(value) != 3:
        fail(f"{name} must be a length-3 array")
    return tuple(
        require_finite_number(component, f"{name}[{component_index}]")
        for component_index, component in enumerate(value)
    )


def require_csv_finite_number(row: dict[str, str], column: str, row_name: str) -> float:
    try:
        return require_finite_number(float(row[column]), f"{row_name}.{column}")
    except KeyError:
        fail(f"{row_name} missing column {column!r}")
    except ValueError:
        fail(f"{row_name}.{column} must be a finite number")


def require_csv_non_negative_int(row: dict[str, str], column: str, row_name: str) -> int:
    try:
        value = int(row[column])
    except KeyError:
        fail(f"{row_name} missing column {column!r}")
    except ValueError:
        fail(f"{row_name}.{column} must be a non-negative integer")
    return require_non_negative_int(value, f"{row_name}.{column}")


def validate_exchange_only_analytic_dispersion(
    root: Path,
    known_modes: dict[tuple[int, int], tuple[float, float, float, float]],
    known_samples: dict[int, tuple[float, tuple[float, float, float], str]],
    branch_ids_by_mode: dict[tuple[int, int], int],
) -> None:
    metadata_path = root / "metadata.json"
    require_file(metadata_path)
    metadata = load_json(metadata_path)
    plan = metadata.get("execution_plan", {}).get("backend_plan")
    if not isinstance(plan, dict):
        fail("metadata.execution_plan.backend_plan is required for exchange-only analytic dispersion")
    require_equal(
        plan.get("enable_exchange"),
        True,
        "metadata.execution_plan.backend_plan.enable_exchange",
    )
    require_equal(
        plan.get("enable_demag"),
        False,
        "metadata.execution_plan.backend_plan.enable_demag",
    )
    operator = plan.get("operator")
    if not isinstance(operator, dict):
        fail("metadata.execution_plan.backend_plan.operator must be an object")
    require_equal(
        operator.get("include_demag"),
        False,
        "metadata.execution_plan.backend_plan.operator.include_demag",
    )
    material = plan.get("material")
    if not isinstance(material, dict):
        fail("metadata.execution_plan.backend_plan.material must be an object")
    exchange_stiffness = require_finite_number(
        material.get("exchange_stiffness"),
        "metadata.execution_plan.backend_plan.material.exchange_stiffness",
    )
    saturation_magnetisation = require_finite_number(
        material.get("saturation_magnetisation"),
        "metadata.execution_plan.backend_plan.material.saturation_magnetisation",
    )
    if exchange_stiffness <= 0.0:
        fail("metadata.execution_plan.backend_plan.material.exchange_stiffness must be positive")
    if saturation_magnetisation <= 0.0:
        fail("metadata.execution_plan.backend_plan.material.saturation_magnetisation must be positive")
    gamma0 = require_finite_number(
        plan.get("gyromagnetic_ratio"),
        "metadata.execution_plan.backend_plan.gyromagnetic_ratio",
    )
    if gamma0 <= 0.0:
        fail("metadata.execution_plan.backend_plan.gyromagnetic_ratio must be positive")
    external_field = require_vector3(
        plan.get("external_field"),
        "metadata.execution_plan.backend_plan.external_field",
    )
    h0 = vector_magnitude(external_field)
    if h0 <= 0.0:
        fail("metadata.execution_plan.backend_plan.external_field must be nonzero")

    modes_by_branch: dict[int, list[tuple[int, float]]] = {}
    for mode_key, branch_id in branch_ids_by_mode.items():
        if mode_key not in known_modes:
            continue
        sample_index, _raw_mode_index = mode_key
        if sample_index not in known_samples:
            continue
        frequency_hz, _frequency_real_hz, _frequency_imag_hz, _omega = known_modes[mode_key]
        modes_by_branch.setdefault(branch_id, []).append((sample_index, frequency_hz))

    best_branch_error: float | None = None
    best_branch_id: int | None = None
    for branch_id, branch_modes in modes_by_branch.items():
        if len(branch_modes) < 3:
            continue
        branch_errors: list[float] = []
        for sample_index, frequency_hz in branch_modes:
            _path_s, k_vector, _label = known_samples[sample_index]
            k_norm = vector_magnitude(k_vector)
            exchange_field = (
                2.0 * exchange_stiffness * k_norm * k_norm
                / (MU0 * saturation_magnetisation)
            )
            expected_hz = gamma0 * (h0 + exchange_field) / TWO_PI
            branch_errors.append(abs(frequency_hz - expected_hz) / max(abs(expected_hz), 1.0))
        branch_error = max(branch_errors)
        if best_branch_error is None or branch_error < best_branch_error:
            best_branch_error = branch_error
            best_branch_id = branch_id

    if best_branch_error is None or best_branch_id is None:
        fail("exchange-only analytic dispersion requires a branch with at least 3 points")
    if best_branch_error > 0.25:
        fail(
            "exchange-only analytic dispersion max relative error is too large "
            f"for branch {best_branch_id}: got {best_branch_error:.6g}, expected <= 0.25"
        )


def validate_k0_kittel_summary_artifacts(
    root: Path,
    tolerance: float,
    *,
    require_demag: bool = False,
) -> None:
    summary_path = root / "validation/kittel_k0_pbc/summary.v1.json"
    if not summary_path.exists():
        return
    points_path = root / "validation/kittel_k0_pbc/points.v1.csv"
    require_file(points_path)
    summary = load_json(summary_path)
    summary_name = "validation/kittel_k0_pbc/summary.v1.json"
    require_equal(
        summary.get("schema_version"),
        "frequency_domain_kittel_k0_validation.v1",
        f"{summary_name}.schema_version",
    )
    require_equal(summary.get("status"), "passed", f"{summary_name}.status")
    if require_demag:
        require_equal(summary.get("case_id"), "K0-3", f"{summary_name}.case_id")
        require_equal(
            summary.get("model"),
            "thin_film_in_plane",
            f"{summary_name}.model",
        )
        demag_kind = require_non_empty_string(summary.get("demag_kind"), f"{summary_name}.demag_kind")
        if demag_kind not in {"synthetic_demag_factor", "periodic_airbox_k0"}:
            fail(f"{summary_name}.demag_kind is invalid for K0-3 demag validation")
        demag = summary.get("demag")
        if not isinstance(demag, dict):
            fail(f"{summary_name}.demag must be an object for K0-3 demag validation")
        require_equal(demag.get("kind"), demag_kind, f"{summary_name}.demag.kind")
        effective_magnetisation = require_finite_number(
            demag.get("effective_magnetisation_A_per_m"),
            f"{summary_name}.demag.effective_magnetisation_A_per_m",
        )
        if effective_magnetisation <= 0.0:
            fail(f"{summary_name}.demag.effective_magnetisation_A_per_m must be positive")
        if demag_kind == "periodic_airbox_k0":
            eigen_summary = load_json(root / "eigen/metadata/eigen_summary.json")
            equilibrium_source = eigen_summary.get("equilibrium_source")
            if not isinstance(equilibrium_source, dict):
                fail(
                    "eigen_summary.equilibrium_source must be an object with "
                    "kind=relaxed_initial_state"
                )
            require_equal(
                equilibrium_source.get("kind"),
                "relaxed_initial_state",
                "eigen_summary.equilibrium_source.kind",
            )
            relaxation_steps = require_non_negative_int(
                eigen_summary.get("relaxation_steps"),
                "eigen_summary.relaxation_steps",
            )
            handoff = equilibrium_source.get("handoff")
            if relaxation_steps <= 0 and handoff != "stage_continuation":
                fail(
                    "eigen_summary.relaxation_steps must be positive for periodic_airbox_k0 "
                    "unless eigen_summary.equilibrium_source.handoff=stage_continuation"
                )
            solver_diagnostics = load_json(root / "eigen/diagnostics/solver.v1.json")
            if solver_diagnostics.get("solver_adapter") not in {
                "k0_poisson_airbox_cpu_full_coupled_slepc",
                "k0_poisson_airbox_cpu_schur_slepc",
                "k0_poisson_airbox_gpu_petsc_slepc",
                "k0_poisson_airbox_gpu_modal_device_krylov",
            }:
                fail(
                    "solver_diagnostics.solver_adapter must be a certified "
                    "CPU or GPU K0 periodic-airbox adapter"
                )
            if solver_diagnostics.get("solver_model") not in {
                "k0_poisson_airbox_cpu_full_coupled_slepc",
                "k0_poisson_airbox_cpu_schur_slepc",
                "k0_poisson_airbox_gpu_petsc_slepc",
                "k0_poisson_airbox_gpu_modal_device_krylov",
            }:
                fail("solver_diagnostics.solver_model is not a certified K0 periodic-airbox model")
            if solver_diagnostics.get("resolved_solver_family") not in {
                "k0_poisson_airbox_full_coupled",
                "k0_poisson_airbox_schur",
                "device_resident_arnoldi_shift_invert",
            }:
                fail("solver_diagnostics.resolved_solver_family is not a certified K0 periodic-airbox family")
            require_equal(
                solver_diagnostics.get("demag_kind"),
                "periodic_airbox_k0",
                "solver_diagnostics.demag_kind",
            )
            assembly_kind = solver_diagnostics.get("assembly_kind")
            if assembly_kind is None:
                sampled = require_object_list(
                    solver_diagnostics.get("sample_solver_diagnostics"),
                    "solver_diagnostics.sample_solver_diagnostics",
                )
                if not sampled:
                    fail("solver_diagnostics.assembly_kind is required")
                sampled_assembly_kinds: list[object] = []
                for sample_position, sample in enumerate(sampled):
                    sample_payload = sample.get("diagnostics")
                    if not isinstance(sample_payload, dict):
                        fail(
                            "solver_diagnostics.sample_solver_diagnostics"
                            f"[{sample_position}].diagnostics must be an object"
                        )
                    sampled_assembly_kinds.append(sample_payload.get("assembly_kind"))
                if any(
                    value != "mfem_weak_form_shared_domain"
                    for value in sampled_assembly_kinds
                ):
                    fail(
                        "every sampled solver diagnostic must use "
                        "assembly_kind=mfem_weak_form_shared_domain"
                    )
            else:
                require_equal(
                    assembly_kind,
                    "mfem_weak_form_shared_domain",
                    "solver_diagnostics.assembly_kind",
                )
            gauge_policy = require_non_empty_string(
                demag.get("gauge_policy"),
                f"{summary_name}.demag.gauge_policy",
            )
            if gauge_policy not in {"none", "mean_zero_augmented"}:
                fail(f"{summary_name}.demag.gauge_policy is invalid")
            phi_dof_count = require_non_negative_int(
                demag.get("phi_dof_count"),
                f"{summary_name}.demag.phi_dof_count",
            )
            if phi_dof_count <= 0:
                fail(f"{summary_name}.demag.phi_dof_count must be positive")
            augmented_phi_dof_count = require_non_negative_int(
                demag.get("augmented_phi_dof_count"),
                f"{summary_name}.demag.augmented_phi_dof_count",
            )
            if gauge_policy == "mean_zero_augmented" and augmented_phi_dof_count <= phi_dof_count:
                fail(
                    f"{summary_name}.demag.augmented_phi_dof_count must exceed "
                    f"{summary_name}.demag.phi_dof_count for mean-zero gauge"
                )
            if gauge_policy == "none" and augmented_phi_dof_count != phi_dof_count:
                fail(
                    f"{summary_name}.demag.augmented_phi_dof_count must equal "
                    f"{summary_name}.demag.phi_dof_count when no gauge is present"
                )
            poisson_residual = require_finite_number(
                demag.get("poisson_constraint_relative_residual"),
                f"{summary_name}.demag.poisson_constraint_relative_residual",
            )
            if poisson_residual < 0.0 or poisson_residual > 1.0e-8:
                fail(
                    f"{summary_name}.demag.poisson_constraint_relative_residual "
                    "must be in [0, 1e-8]"
                )
            magnetic_pair_count = require_non_negative_int(
                demag.get("magnetic_pair_count"),
                f"{summary_name}.demag.magnetic_pair_count",
            )
            airbox_pair_count = require_non_negative_int(
                demag.get("airbox_pair_count"),
                f"{summary_name}.demag.airbox_pair_count",
            )
            if magnetic_pair_count <= 0:
                fail(f"{summary_name}.demag.magnetic_pair_count must be positive")
            if airbox_pair_count <= 0:
                fail(f"{summary_name}.demag.airbox_pair_count must be positive")
            require_equal(
                demag.get("production_periodic_airbox_claim"),
                True,
                f"{summary_name}.demag.production_periodic_airbox_claim",
            )
            validate_k0_kittel_demag_convergence_table(root, tolerance)
        else:
            require_equal(
                demag.get("production_periodic_airbox_claim"),
                False,
                f"{summary_name}.demag.production_periodic_airbox_claim",
            )
    boundary_condition = require_non_empty_string(
        summary.get("boundary_condition"),
        f"{summary_name}.boundary_condition",
    )
    if boundary_condition not in {"periodic_k0", "floquet_k0", "gamma_k0"}:
        fail(f"{summary_name}.boundary_condition is invalid")
    k_vector = require_vector3(summary.get("k_vector_rad_per_m"), f"{summary_name}.k_vector_rad_per_m")
    if vector_magnitude(k_vector) > 1.0e-9:
        fail(f"{summary_name}.k_vector_rad_per_m must be zero for k0 Kittel validation")
    sweep_point_count = require_non_negative_int(
        summary.get("sweep_point_count"),
        f"{summary_name}.sweep_point_count",
    )
    if sweep_point_count < 3:
        fail(f"{summary_name}.sweep_point_count must be at least 3")
    max_relative_error = require_finite_number(
        summary.get("max_relative_frequency_error"),
        f"{summary_name}.max_relative_frequency_error",
    )
    median_relative_error = require_finite_number(
        summary.get("median_relative_frequency_error"),
        f"{summary_name}.median_relative_frequency_error",
    )
    if max_relative_error < 0.0:
        fail(f"{summary_name}.max_relative_frequency_error must be non-negative")
    if median_relative_error < 0.0:
        fail(f"{summary_name}.median_relative_frequency_error must be non-negative")
    if max_relative_error > tolerance:
        fail(
            f"{summary_name}.max_relative_frequency_error is too large: "
            f"got {max_relative_error:.6g}, expected <= {tolerance:.6g}"
        )
    if median_relative_error > max_relative_error:
        fail(
            f"{summary_name}.median_relative_frequency_error must be <= "
            f"{summary_name}.max_relative_frequency_error"
        )

    reader = csv.DictReader(points_path.read_text().splitlines())
    required_columns = {
        "field_index",
        "H0_A_per_m",
        "mu0_H0_T",
        "expected_frequency_hz",
        "eigen_frequency_hz",
        "relative_frequency_error",
        "selected_mode_index",
        "eigenvalue_real",
        "eigenvalue_imag",
        "mode_residual_relative",
        "uniformity_score",
        "branch_overlap_previous",
        "max_m0_dot_delta_m_abs",
        "max_periodic_seam_mismatch",
    }
    missing = required_columns.difference(reader.fieldnames or [])
    if missing:
        fail(f"validation/kittel_k0_pbc/points.v1.csv missing columns: {sorted(missing)!r}")
    if require_demag:
        demag_missing = {"case_id", "demag_kind"}.difference(reader.fieldnames or [])
        if demag_missing:
            fail(
                "validation/kittel_k0_pbc/points.v1.csv missing K0-3 columns: "
                f"{sorted(demag_missing)!r}"
            )
    rows = list(reader)
    if len(rows) != sweep_point_count:
        fail(
            "validation/kittel_k0_pbc/points.v1.csv row count must match "
            f"{summary_name}.sweep_point_count: got {len(rows)}, expected {sweep_point_count}"
        )
    previous_h0: float | None = None
    previous_frequency: float | None = None
    observed_errors: list[float] = []
    for row_index, row in enumerate(rows):
        row_name = f"validation/kittel_k0_pbc/points.v1.csv row {row_index}"
        if require_demag:
            require_equal(row.get("case_id"), "K0-3", f"{row_name}.case_id")
            demag_kind = require_non_empty_string(row.get("demag_kind"), f"{row_name}.demag_kind")
            if demag_kind not in {"synthetic_demag_factor", "periodic_airbox_k0"}:
                fail(f"{row_name}.demag_kind is invalid for K0-3 demag validation")
        field_index = require_csv_non_negative_int(row, "field_index", row_name)
        if field_index != row_index:
            fail(f"{row_name}.field_index: got {field_index}, expected {row_index}")
        require_csv_non_negative_int(row, "selected_mode_index", row_name)
        h0 = require_csv_finite_number(row, "H0_A_per_m", row_name)
        mu0_h0 = require_csv_finite_number(row, "mu0_H0_T", row_name)
        expected_hz = require_csv_finite_number(row, "expected_frequency_hz", row_name)
        eigen_hz = require_csv_finite_number(row, "eigen_frequency_hz", row_name)
        relative_error = require_csv_finite_number(row, "relative_frequency_error", row_name)
        require_csv_finite_number(row, "eigenvalue_real", row_name)
        require_csv_finite_number(row, "eigenvalue_imag", row_name)
        residual = require_csv_finite_number(row, "mode_residual_relative", row_name)
        uniformity = require_csv_finite_number(row, "uniformity_score", row_name)
        overlap = require_csv_finite_number(row, "branch_overlap_previous", row_name)
        tangent_leakage = require_csv_finite_number(row, "max_m0_dot_delta_m_abs", row_name)
        seam_mismatch = require_csv_finite_number(row, "max_periodic_seam_mismatch", row_name)
        if h0 <= 0.0:
            fail(f"{row_name}.H0_A_per_m must be positive")
        if mu0_h0 <= 0.0:
            fail(f"{row_name}.mu0_H0_T must be positive")
        if expected_hz < 0.0 or eigen_hz < 0.0:
            fail(f"{row_name} frequencies must be non-negative")
        if relative_error < 0.0 or relative_error > tolerance:
            fail(f"{row_name}.relative_frequency_error must be in [0, tolerance]")
        if residual < 0.0:
            fail(f"{row_name}.mode_residual_relative must be non-negative")
        if not 0.0 <= uniformity <= 1.0:
            fail(f"{row_name}.uniformity_score must be in [0, 1]")
        if not 0.0 <= overlap <= 1.0:
            fail(f"{row_name}.branch_overlap_previous must be in [0, 1]")
        if tangent_leakage < 0.0:
            fail(f"{row_name}.max_m0_dot_delta_m_abs must be non-negative")
        if seam_mismatch < 0.0:
            fail(f"{row_name}.max_periodic_seam_mismatch must be non-negative")
        if previous_h0 is not None and h0 <= previous_h0:
            fail("validation/kittel_k0_pbc/points.v1.csv H0_A_per_m must be strictly increasing")
        if previous_frequency is not None and eigen_hz <= previous_frequency:
            fail(
                "validation/kittel_k0_pbc/points.v1.csv eigen_frequency_hz "
                "must be strictly increasing"
            )
        previous_h0 = h0
        previous_frequency = eigen_hz
        observed_errors.append(relative_error)
    observed_max_error = max(observed_errors)
    if observed_max_error > max_relative_error:
        fail(
            f"{summary_name}.max_relative_frequency_error must cover points.v1.csv errors: "
            f"got {max_relative_error:.6g}, observed {observed_max_error:.6g}"
        )


def validate_k0_kittel_demag_convergence_table(root: Path, tolerance: float) -> None:
    convergence_path = root / "validation/kittel_k0_pbc/convergence.v1.csv"
    require_file(convergence_path)
    reader = csv.DictReader(convergence_path.read_text().splitlines())
    required_columns = {
        "case_id",
        "demag_kind",
        "mesh_resolution_m",
        "airbox_size_m",
        "phi_dof_count",
        "poisson_residual_relative",
        "relative_kittel_frequency_error",
        "effective_magnetisation_A_per_m",
    }
    missing = required_columns.difference(reader.fieldnames or [])
    if missing:
        fail(f"validation/kittel_k0_pbc/convergence.v1.csv missing columns: {sorted(missing)!r}")
    rows = list(reader)
    if not rows:
        fail("validation/kittel_k0_pbc/convergence.v1.csv must contain at least one row")
    best_error: float | None = None
    for row_index, row in enumerate(rows):
        row_name = f"validation/kittel_k0_pbc/convergence.v1.csv row {row_index}"
        require_equal(row.get("case_id"), "K0-3", f"{row_name}.case_id")
        require_equal(row.get("demag_kind"), "periodic_airbox_k0", f"{row_name}.demag_kind")
        mesh_resolution = require_csv_finite_number(row, "mesh_resolution_m", row_name)
        airbox_size = require_csv_finite_number(row, "airbox_size_m", row_name)
        phi_dof_count = require_csv_non_negative_int(row, "phi_dof_count", row_name)
        poisson_residual = require_csv_finite_number(row, "poisson_residual_relative", row_name)
        relative_error = require_csv_finite_number(row, "relative_kittel_frequency_error", row_name)
        effective_magnetisation = require_csv_finite_number(
            row,
            "effective_magnetisation_A_per_m",
            row_name,
        )
        if mesh_resolution <= 0.0:
            fail(f"{row_name}.mesh_resolution_m must be positive")
        if airbox_size <= 0.0:
            fail(f"{row_name}.airbox_size_m must be positive")
        if phi_dof_count <= 0:
            fail(f"{row_name}.phi_dof_count must be positive")
        if poisson_residual < 0.0 or poisson_residual > 1.0e-8:
            fail(f"{row_name}.poisson_residual_relative must be in [0, 1e-8]")
        if relative_error < 0.0:
            fail(f"{row_name}.relative_kittel_frequency_error must be non-negative")
        if effective_magnetisation <= 0.0:
            fail(f"{row_name}.effective_magnetisation_A_per_m must be positive")
        best_error = relative_error if best_error is None else min(best_error, relative_error)
    if best_error is None or best_error > tolerance:
        fail(
            "validation/kittel_k0_pbc/convergence.v1.csv best "
            f"relative_kittel_frequency_error is too large: got {best_error}, "
            f"expected <= {tolerance:.6g}"
        )


def validate_k0_kittel_field_sweep(
    root: Path,
    known_modes: dict[tuple[int, int], tuple[float, float, float, float]],
    known_samples: dict[int, tuple[float, tuple[float, float, float], str]],
    branch_ids_by_mode: dict[tuple[int, int], int],
    *,
    require_demag: bool = False,
    require_periodic_airbox_demag: bool = False,
) -> None:
    metadata_path = root / "metadata.json"
    require_file(metadata_path)
    metadata = load_json(metadata_path)
    plan = metadata.get("execution_plan", {}).get("backend_plan")
    if not isinstance(plan, dict):
        fail("metadata.execution_plan.backend_plan is required for k0 Kittel field sweep")
    validation = plan.get("k0_kittel_validation")
    if not isinstance(validation, dict):
        fail("metadata.execution_plan.backend_plan.k0_kittel_validation is required")
    model = require_non_empty_string(
        validation.get("model"),
        "metadata.execution_plan.backend_plan.k0_kittel_validation.model",
    )
    if model not in {"macrospin_larmor", "thin_film_in_plane"}:
        fail("metadata.execution_plan.backend_plan.k0_kittel_validation.model is invalid")
    if require_demag:
        require_equal(
            validation.get("case_id"),
            "K0-3",
            "metadata.execution_plan.backend_plan.k0_kittel_validation.case_id",
        )
        demag_kind = require_non_empty_string(
            validation.get("demag_kind"),
            "metadata.execution_plan.backend_plan.k0_kittel_validation.demag_kind",
        )
        if demag_kind not in {"synthetic_demag_factor", "periodic_airbox_k0"}:
            fail("metadata.execution_plan.backend_plan.k0_kittel_validation.demag_kind is invalid")
        if require_periodic_airbox_demag:
            require_equal(
                demag_kind,
                "periodic_airbox_k0",
                "metadata.execution_plan.backend_plan.k0_kittel_validation.demag_kind",
            )
        require_equal(
            model,
            "thin_film_in_plane",
            "metadata.execution_plan.backend_plan.k0_kittel_validation.model",
        )
    require_equal(
        validation.get("field_units"),
        "A_per_m",
        "metadata.execution_plan.backend_plan.k0_kittel_validation.field_units",
    )
    gamma0 = require_finite_number(
        plan.get("gyromagnetic_ratio"),
        "metadata.execution_plan.backend_plan.gyromagnetic_ratio",
    )
    if gamma0 <= 0.0:
        fail("metadata.execution_plan.backend_plan.gyromagnetic_ratio must be positive")
    tolerance = require_finite_number(
        validation.get("relative_tolerance", 0.05),
        "metadata.execution_plan.backend_plan.k0_kittel_validation.relative_tolerance",
    )
    if tolerance <= 0.0 or tolerance > 0.25:
        fail(
            "metadata.execution_plan.backend_plan.k0_kittel_validation.relative_tolerance "
            "must be in (0, 0.25]"
        )
    material = plan.get("material")
    if not isinstance(material, dict):
        fail("metadata.execution_plan.backend_plan.material must be an object")
    effective_magnetisation = None
    if model == "thin_film_in_plane":
        effective_magnetisation = require_finite_number(
            material.get("effective_magnetisation", material.get("saturation_magnetisation")),
            "metadata.execution_plan.backend_plan.material.effective_magnetisation",
        )
        if effective_magnetisation <= 0.0:
            fail("metadata.execution_plan.backend_plan.material.effective_magnetisation must be positive")

    sample_specs = require_object_list(
        validation.get("samples"),
        "metadata.execution_plan.backend_plan.k0_kittel_validation.samples",
    )
    if len(sample_specs) < 3:
        fail("k0 Kittel field sweep requires at least 3 field samples")
    expected_by_sample: dict[int, tuple[float, float]] = {}
    for sample_spec in sample_specs:
        sample_index = require_non_negative_int(
            sample_spec.get("sample_index"),
            "k0 Kittel field sweep sample.sample_index",
        )
        bias_field = require_vector3(
            sample_spec.get("bias_field"),
            "k0 Kittel field sweep sample.bias_field",
        )
        field_magnitude = vector_magnitude(bias_field)
        if field_magnitude <= 0.0:
            fail("k0 Kittel field sweep sample.bias_field must be nonzero")
        sample = known_samples.get(sample_index)
        if sample is None:
            fail(f"k0 Kittel field sweep references unknown sample {sample_index}")
        _path_s, k_vector, _label = sample
        if vector_magnitude(k_vector) > 1.0e-9:
            fail("k0 Kittel field sweep requires all spectrum k-vectors to be zero")
        if model == "macrospin_larmor":
            expected_hz = gamma0 * field_magnitude / TWO_PI
        else:
            assert effective_magnetisation is not None
            expected_hz = (
                gamma0
                * math.sqrt(field_magnitude * (field_magnitude + effective_magnetisation))
                / TWO_PI
            )
        expected_by_sample[sample_index] = (field_magnitude, expected_hz)

    modes_by_branch: dict[int, list[tuple[int, float]]] = {}
    for mode_key, branch_id in branch_ids_by_mode.items():
        sample_index, _raw_mode_index = mode_key
        if sample_index not in expected_by_sample or mode_key not in known_modes:
            continue
        frequency_hz, _frequency_real_hz, _frequency_imag_hz, _omega = known_modes[mode_key]
        modes_by_branch.setdefault(branch_id, []).append((sample_index, frequency_hz))

    best_branch_error: float | None = None
    best_branch_id: int | None = None
    for branch_id, branch_modes in modes_by_branch.items():
        covered_samples = {sample_index for sample_index, _frequency in branch_modes}
        if set(expected_by_sample) - covered_samples:
            continue
        branch_errors = []
        branch_points = sorted(
            (
                expected_by_sample[sample_index][0],
                frequency_hz,
                expected_by_sample[sample_index][1],
            )
            for sample_index, frequency_hz in branch_modes
        )
        for _field_magnitude, frequency_hz, expected_hz in branch_points:
            branch_errors.append(abs(frequency_hz - expected_hz) / max(abs(expected_hz), 1.0))
        for left, right in zip(branch_points, branch_points[1:]):
            if right[1] <= left[1]:
                fail("k0 Kittel field sweep branch frequency must increase with bias field")
        branch_error = max(branch_errors)
        if best_branch_error is None or branch_error < best_branch_error:
            best_branch_error = branch_error
            best_branch_id = branch_id

    if best_branch_error is None or best_branch_id is None:
        fail("k0 Kittel field sweep requires one branch covering all field samples")
    if best_branch_error > tolerance:
        fail(
            "k0 Kittel field sweep max relative error is too large "
            f"for branch {best_branch_id}: got {best_branch_error:.6g}, expected <= {tolerance:.6g}"
        )
    validate_k0_kittel_summary_artifacts(root, tolerance, require_demag=require_demag)


def validate_gpu_modal_k0_kittel_provenance(root: Path) -> None:
    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    require_file(manifest_path)
    manifest = load_json(manifest_path)
    require_equal(
        manifest.get("study_product"),
        "modal_eigen",
        "manifest.study_product",
    )

    requested = manifest.get("requested_execution")
    if not isinstance(requested, dict):
        fail("manifest.requested_execution must be an object for GPU Kittel provenance")
    require_equal(requested.get("backend"), "fem", "manifest.requested_execution.backend")
    require_equal(requested.get("device"), "gpu", "manifest.requested_execution.device")
    require_equal(requested.get("precision"), "double", "manifest.requested_execution.precision")
    require_equal(
        requested.get("solver_family"),
        "modal_eigen",
        "manifest.requested_execution.solver_family",
    )
    require_equal(
        requested.get("include_demag"),
        False,
        "manifest.requested_execution.include_demag",
    )

    resolved = manifest.get("resolved_execution")
    if not isinstance(resolved, dict):
        fail("manifest.resolved_execution must be an object for GPU Kittel provenance")
    require_equal(resolved.get("backend"), "fem", "manifest.resolved_execution.backend")
    require_equal(resolved.get("device"), "gpu", "manifest.resolved_execution.device")
    require_equal(resolved.get("precision"), "double", "manifest.resolved_execution.precision")
    require_equal(
        resolved.get("solve_kind"),
        "modal_eigen",
        "manifest.resolved_execution.solve_kind",
    )
    require_equal(
        resolved.get("native_backend"),
        "native_gpu",
        "manifest.resolved_execution.native_backend",
    )
    require_equal(
        resolved.get("reference_or_production"),
        "production",
        "manifest.resolved_execution.reference_or_production",
    )
    require_equal(
        resolved.get("demag_realization"),
        "none",
        "manifest.resolved_execution.demag_realization",
    )
    solver_algorithm = require_non_empty_string(
        resolved.get("solver_algorithm"),
        "manifest.resolved_execution.solver_algorithm",
    )
    if solver_algorithm not in GPU_MODAL_KITTEL_SOLVER_ALGORITHMS:
        fail(
            "manifest.resolved_execution.solver_algorithm must be a real GPU modal "
            f"Kittel solver, got {solver_algorithm!r}"
        )
    engine = require_non_empty_string(
        resolved.get("engine"),
        "manifest.resolved_execution.engine",
    )
    if "cpu" in engine.lower():
        fail("manifest.resolved_execution.engine must not be a CPU modal engine")
    device_residency = require_non_empty_string(
        resolved.get("device_residency"),
        "manifest.resolved_execution.device_residency",
    )
    if device_residency not in {"device_resident", "gpu_device_resident"}:
        fail("manifest.resolved_execution.device_residency must prove GPU residency")

    capabilities = manifest.get("capabilities")
    if not isinstance(capabilities, dict):
        fail("manifest.capabilities must be an object for GPU Kittel provenance")
    dispersion = capabilities.get("dispersion")
    if not isinstance(dispersion, dict):
        fail("manifest.capabilities.dispersion must be an object for GPU Kittel provenance")
    production_gpu = dispersion.get("production_gpu")
    if not isinstance(production_gpu, dict):
        fail("manifest.capabilities.dispersion.production_gpu must be an object")
    gpu_status = require_non_empty_string(
        production_gpu.get("status"),
        "manifest.capabilities.dispersion.production_gpu.status",
    )
    if gpu_status not in GPU_MODAL_KITTEL_CAPABILITY_STATUSES:
        fail(
            "manifest.capabilities.dispersion.production_gpu.status must indicate "
            f"an executable GPU modal lane, got {gpu_status!r}"
        )

    summary_path = root / "validation/kittel_k0_pbc/summary.v1.json"
    require_file(summary_path)
    summary = load_json(summary_path)
    solver = summary.get("solver")
    if not isinstance(solver, dict):
        fail("validation/kittel_k0_pbc/summary.v1.json.solver must be an object")
    require_equal(
        solver.get("backend"),
        "modal_eigen",
        "validation/kittel_k0_pbc/summary.v1.json.solver.backend",
    )
    require_equal(
        solver.get("execution_lane"),
        "production_gpu",
        "validation/kittel_k0_pbc/summary.v1.json.solver.execution_lane",
    )
    summary_algorithm = require_non_empty_string(
        solver.get("solver_algorithm"),
        "validation/kittel_k0_pbc/summary.v1.json.solver.solver_algorithm",
    )
    if summary_algorithm != solver_algorithm:
        fail(
            "validation/kittel_k0_pbc/summary.v1.json.solver.solver_algorithm "
            "must match manifest.resolved_execution.solver_algorithm"
        )


def validate_gpu_modal_k0_periodic_airbox_provenance(root: Path) -> None:
    manifest = load_json(root / "frequency_domain/manifest.v1.json")
    requested = manifest.get("requested_execution")
    resolved = manifest.get("resolved_execution")
    if not isinstance(requested, dict) or not isinstance(resolved, dict):
        fail("GPU periodic-airbox provenance requires requested/resolved execution objects")
    require_equal(requested.get("backend"), "fem", "manifest.requested_execution.backend")
    require_equal(requested.get("device"), "gpu", "manifest.requested_execution.device")
    require_equal(requested.get("precision"), "double", "manifest.requested_execution.precision")
    require_equal(requested.get("include_demag"), True, "manifest.requested_execution.include_demag")
    require_equal(resolved.get("backend"), "fem", "manifest.resolved_execution.backend")
    require_equal(resolved.get("device"), "gpu", "manifest.resolved_execution.device")
    require_equal(resolved.get("native_backend"), "native_gpu", "manifest.resolved_execution.native_backend")
    require_equal(
        resolved.get("reference_or_production"),
        "production",
        "manifest.resolved_execution.reference_or_production",
    )
    if resolved.get("solver_algorithm") not in {
        "k0_poisson_airbox_gpu_petsc_slepc",
        "k0_poisson_airbox_gpu_modal_device_krylov",
    }:
        fail("manifest.resolved_execution.solver_algorithm must identify a GPU K0 PETSc/SLEPc adapter")
    require_equal(
        resolved.get("device_residency"),
        "gpu_device_resident",
        "manifest.resolved_execution.device_residency",
    )
    engine = require_non_empty_string(resolved.get("engine"), "manifest.resolved_execution.engine")
    if "cpu" in engine.lower():
        fail("manifest.resolved_execution.engine must not contain a CPU solver for strict GPU K0 demag")

    solver = load_json(root / "eigen/diagnostics/solver.v1.json")
    if solver.get("solver_adapter") not in {
        "k0_poisson_airbox_gpu_petsc_slepc",
        "k0_poisson_airbox_gpu_modal_device_krylov",
    }:
        fail("solver_diagnostics.solver_adapter must identify a GPU K0 PETSc/SLEPc adapter")
    require_equal(solver.get("execution_lane"), "production_gpu", "solver_diagnostics.execution_lane")
    require_equal(solver.get("demag_kind"), "periodic_airbox_k0", "solver_diagnostics.demag_kind")
    require_equal(solver.get("algebraic_form"), "schur_reduced_descriptor", "solver_diagnostics.algebraic_form")
    require_equal(solver.get("matrix_equation"), "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q", "solver_diagnostics.matrix_equation")
    require_equal(solver.get("spectral_transform"), "shift_invert", "solver_diagnostics.spectral_transform")
    require_equal(
        solver.get("production_periodic_airbox_claim"),
        True,
        "solver_diagnostics.production_periodic_airbox_claim",
    )
    samples = require_object_list(
        solver.get("sample_solver_diagnostics"),
        "solver_diagnostics.sample_solver_diagnostics",
    )
    if not samples:
        fail("GPU periodic-airbox provenance requires executed per-sample native diagnostics")
    for sample_index, sample in enumerate(samples):
        diagnostics = sample.get("diagnostics")
        if not isinstance(diagnostics, dict):
            fail(f"solver_diagnostics.sample_solver_diagnostics[{sample_index}].diagnostics must be an object")
        prefix = f"solver_diagnostics.sample_solver_diagnostics[{sample_index}].diagnostics"
        if diagnostics.get("solver_adapter") not in {
            "k0_poisson_airbox_gpu_petsc_slepc",
            "k0_poisson_airbox_gpu_modal_device_krylov",
        }:
            fail(f"{prefix}.solver_adapter must identify a GPU K0 PETSc/SLEPc adapter")
        require_equal(diagnostics.get("assembly_kind"), "mfem_weak_form_shared_domain", f"{prefix}.assembly_kind")
        require_equal(diagnostics.get("demag_kind"), "periodic_airbox_k0", f"{prefix}.demag_kind")
        require_equal(diagnostics.get("algebraic_form"), "schur_reduced_descriptor", f"{prefix}.algebraic_form")
        require_equal(diagnostics.get("matrix_equation"), "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q", f"{prefix}.matrix_equation")
        require_equal(diagnostics.get("spectral_transform"), "shift_invert", f"{prefix}.spectral_transform")
        spectral = diagnostics.get("spectral")
        if isinstance(spectral, dict):
            require_equal(spectral.get("spectral_scalar_mode"), "real_split", f"{prefix}.spectral.spectral_scalar_mode")
        require_equal(diagnostics.get("persistent_solver_context"), True, f"{prefix}.persistent_solver_context")
        require_equal(diagnostics.get("gpu_device_resident_modal_eigensolver"), True, f"{prefix}.gpu_device_resident_modal_eigensolver")
        require_equal(diagnostics.get("scalable_selected_spectrum"), True, f"{prefix}.scalable_selected_spectrum")
        require_equal(diagnostics.get("production_implication"), True, f"{prefix}.production_implication")
        require_equal(diagnostics.get("validation_only"), False, f"{prefix}.validation_only")
        require_equal(diagnostics.get("cpu_fallback"), "disabled", f"{prefix}.cpu_fallback")
        require_equal(diagnostics.get("fallback_used"), False, f"{prefix}.fallback_used")
        require_equal(diagnostics.get("per_iteration_h2d_transfer_count"), 0, f"{prefix}.per_iteration_h2d_transfer_count")
        require_equal(diagnostics.get("per_iteration_d2h_transfer_count"), 0, f"{prefix}.per_iteration_d2h_transfer_count")
        require_equal(diagnostics.get("full_residual_certified"), True, f"{prefix}.full_residual_certified")


def validate_cpu_modal_k0_periodic_airbox_provenance(root: Path) -> None:
    """Validate a fresh CPU P1 artifact without accepting Kittel metadata."""
    manifest = load_json(root / "frequency_domain/manifest.v1.json")
    requested = manifest.get("requested_execution")
    resolved = manifest.get("resolved_execution")
    if not isinstance(requested, dict) or not isinstance(resolved, dict):
        fail("CPU periodic-airbox provenance requires requested/resolved execution objects")
    require_equal(requested.get("backend"), "fem", "manifest.requested_execution.backend")
    require_equal(requested.get("device"), "cpu", "manifest.requested_execution.device")
    require_equal(requested.get("precision"), "double", "manifest.requested_execution.precision")
    require_equal(requested.get("include_demag"), True, "manifest.requested_execution.include_demag")
    require_equal(resolved.get("backend"), "fem", "manifest.resolved_execution.backend")
    require_equal(resolved.get("device"), "cpu", "manifest.resolved_execution.device")
    require_equal(resolved.get("native_backend"), "native_cpu", "manifest.resolved_execution.native_backend")
    require_equal(
        resolved.get("reference_or_production"),
        "production",
        "manifest.resolved_execution.reference_or_production",
    )
    if resolved.get("solver_algorithm") not in {
        "k0_poisson_airbox_cpu_full_coupled_slepc",
        "k0_poisson_airbox_cpu_schur_slepc",
    }:
        fail("manifest.resolved_execution.solver_algorithm must identify a CPU K0 PETSc/SLEPc adapter")
    require_equal(
        resolved.get("device_residency"),
        "host",
        "manifest.resolved_execution.device_residency",
    )
    require_equal(resolved.get("fallback_used"), False, "manifest.resolved_execution.fallback_used")
    validation = manifest.get("validation")
    if not isinstance(validation, dict):
        fail("manifest.validation must be an object")
    if validation.get("k0_kittel_validation") is not None:
        fail("production CPU artifact must not carry analytical Kittel validation metadata")

    solver = load_json(root / "eigen/diagnostics/solver.v1.json")
    if solver.get("solver_adapter") not in {
        "k0_poisson_airbox_cpu_full_coupled_slepc",
        "k0_poisson_airbox_cpu_schur_slepc",
    }:
        fail("solver_diagnostics.solver_adapter must identify a CPU K0 PETSc/SLEPc adapter")
    require_equal(solver.get("execution_lane"), "production_cpu", "solver_diagnostics.execution_lane")
    require_equal(solver.get("demag_kind"), "periodic_airbox_k0", "solver_diagnostics.demag_kind")
    require_equal(solver.get("algebraic_form"), "schur_reduced_descriptor", "solver_diagnostics.algebraic_form")
    require_equal(
        solver.get("matrix_equation"),
        "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q",
        "solver_diagnostics.matrix_equation",
    )
    require_equal(solver.get("spectral_transform"), "shift_invert", "solver_diagnostics.spectral_transform")
    require_equal(
        solver.get("production_periodic_airbox_claim"),
        True,
        "solver_diagnostics.production_periodic_airbox_claim",
    )
    samples = require_object_list(
        solver.get("sample_solver_diagnostics"),
        "solver_diagnostics.sample_solver_diagnostics",
    )
    if not samples:
        fail("CPU periodic-airbox provenance requires executed per-sample native diagnostics")
    for sample_index, sample in enumerate(samples):
        diagnostics = sample.get("diagnostics")
        if not isinstance(diagnostics, dict):
            fail(f"solver_diagnostics.sample_solver_diagnostics[{sample_index}].diagnostics must be an object")
        prefix = f"solver_diagnostics.sample_solver_diagnostics[{sample_index}].diagnostics"
        if diagnostics.get("solver_adapter") not in {
            "k0_poisson_airbox_cpu_full_coupled_slepc",
            "k0_poisson_airbox_cpu_schur_slepc",
        }:
            fail(f"{prefix}.solver_adapter must identify a CPU K0 PETSc/SLEPc adapter")
        require_equal(diagnostics.get("assembly_kind"), "mfem_weak_form_shared_domain", f"{prefix}.assembly_kind")
        require_equal(diagnostics.get("demag_kind"), "periodic_airbox_k0", f"{prefix}.demag_kind")
        require_equal(diagnostics.get("spectral_transform"), "shift_invert", f"{prefix}.spectral_transform")
        require_equal(diagnostics.get("fallback_used"), False, f"{prefix}.fallback_used")
        require_equal(diagnostics.get("full_residual_certified"), True, f"{prefix}.full_residual_certified")


def validate_k0_periodic_airbox_production_provenance(root: Path) -> None:
    manifest = load_json(root / "frequency_domain/manifest.v1.json")
    requested = manifest.get("requested_execution")
    if not isinstance(requested, dict):
        fail("K0 production provenance requires manifest.requested_execution")
    device = requested.get("device")
    if device == "cpu":
        validate_cpu_modal_k0_periodic_airbox_provenance(root)
    elif device == "gpu":
        validate_gpu_modal_k0_periodic_airbox_provenance(root)
        validation = manifest.get("validation")
        if not isinstance(validation, dict):
            fail("manifest.validation must be an object for GPU K0 production provenance")
        if validation.get("k0_kittel_validation") is not None:
            fail("production GPU artifact must not carry analytical Kittel validation metadata")
    else:
        fail("K0 production provenance requires requested device cpu or gpu")


def validate_exchange_only_reciprocal_dispersion(
    known_modes: dict[tuple[int, int], tuple[float, float, float, float]],
    known_samples: dict[int, tuple[float, tuple[float, float, float], str]],
    _branch_ids_by_mode: dict[tuple[int, int], int],
) -> None:
    published_modes: list[tuple[tuple[float, float, float], float]] = []
    for mode_key, mode_values in known_modes.items():
        sample_index, _raw_mode_index = mode_key
        sample = known_samples.get(sample_index)
        if sample is None:
            continue
        _path_s, k_vector, _label = sample
        if vector_magnitude(k_vector) == 0.0:
            continue
        frequency_hz, _frequency_real_hz, _frequency_imag_hz, _omega = mode_values
        published_modes.append((k_vector, frequency_hz))

    best_pair_error: float | None = None
    for left_index, (left_k, left_frequency_hz) in enumerate(published_modes):
        for right_k, right_frequency_hz in published_modes[left_index + 1 :]:
            pair_scale = max(vector_magnitude(left_k), vector_magnitude(right_k), 1.0)
            k_sum = tuple(
                left_component + right_component
                for left_component, right_component in zip(left_k, right_k)
            )
            if vector_magnitude(k_sum) > pair_scale * 1.0e-9:
                continue
            relative_error = abs(left_frequency_hz - right_frequency_hz) / max(
                abs(left_frequency_hz),
                abs(right_frequency_hz),
                1.0,
            )
            if best_pair_error is None or relative_error < best_pair_error:
                best_pair_error = relative_error

    if best_pair_error is None:
        fail("exchange-only reciprocal dispersion requires at least one published +k/-k pair")
    if best_pair_error > 1.0e-3:
        fail(
            "exchange-only reciprocal dispersion max relative error is too large "
            f"for the best +k/-k pair: got {best_pair_error:.6g}, expected <= 0.001"
        )


def unit_vector(values: tuple[float, float, float], name: str) -> tuple[float, float, float]:
    magnitude = vector_magnitude(values)
    if magnitude <= 0.0:
        fail(f"{name} must be nonzero")
    return tuple(value / magnitude for value in values)


def vector_dot(
    lhs: tuple[float, float, float],
    rhs: tuple[float, float, float],
) -> float:
    return sum(left * right for left, right in zip(lhs, rhs))


def kalinikos_slab_n0_frequency_hz(
    *,
    k_norm: float,
    geometry: str,
    bias_field_a_per_m: float,
    film_thickness_m: float,
    exchange_stiffness_j_per_m: float,
    saturation_magnetisation_a_per_m: float,
    gamma0_rad_s_per_a_m: float,
) -> float:
    exchange_field = (
        2.0
        * exchange_stiffness_j_per_m
        * k_norm
        * k_norm
        / (MU0 * saturation_magnetisation_a_per_m)
    )
    if k_norm == 0.0:
        p_factor = 0.0
    else:
        kd = k_norm * film_thickness_m
        p_factor = 1.0 - (1.0 - math.exp(-kd)) / kd
    common = bias_field_a_per_m + exchange_field
    if geometry == "damon_eshbach":
        factor_a = common + saturation_magnetisation_a_per_m * (1.0 - p_factor)
        factor_b = common + saturation_magnetisation_a_per_m * p_factor
    elif geometry == "backward_volume":
        factor_a = common
        factor_b = common + saturation_magnetisation_a_per_m * (1.0 - p_factor)
    else:
        fail(f"unsupported DE/BV analytic geometry: {geometry!r}")
    if factor_a <= 0.0 or factor_b <= 0.0:
        fail("DE/BV analytic dispersion factors must be positive")
    return gamma0_rad_s_per_a_m * math.sqrt(factor_a * factor_b) / TWO_PI


def require_frequency_window_hz(value: object, name: str) -> tuple[float, float]:
    if isinstance(value, list) and len(value) == 2:
        lower = require_finite_number(value[0], f"{name}[0]")
        upper = require_finite_number(value[1], f"{name}[1]")
    elif isinstance(value, dict):
        lower = require_finite_number(value.get("min"), f"{name}.min")
        upper = require_finite_number(value.get("max"), f"{name}.max")
    else:
        fail(f"{name} must be a two-entry frequency window")
    if lower < 0.0 or upper <= lower:
        fail(f"{name} must be a valid positive frequency window")
    return lower, upper


def canonical_dispersion_validation(value: object, name: str) -> dict[str, object]:
    if not isinstance(value, dict):
        fail(f"{name} must be an object")
    canonical = dict(value)
    lower, upper = require_frequency_window_hz(
        value.get("frequency_window_hz"),
        f"{name}.frequency_window_hz",
    )
    canonical["frequency_window_hz"] = {"min": lower, "max": upper}
    return canonical


def require_int_list(value: object, name: str) -> list[int]:
    if not isinstance(value, list) or any(not isinstance(item, int) for item in value):
        fail(f"{name} must be an integer list")
    return value


def require_branch_id(value: object, name: str) -> int:
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("branch_"):
            suffix = text[len("branch_") :]
            if suffix.isdigit():
                return int(suffix)
        if text.isdigit():
            return int(text)
    fail(f"{name} must be a non-negative branch id or branch_N label")


def validate_low_k_de_bv_analytic_dispersion(
    root: Path,
    known_modes: dict[tuple[int, int], tuple[float, float, float, float]],
    known_samples: dict[int, tuple[float, tuple[float, float, float], str]],
    branch_ids_by_mode: dict[tuple[int, int], int],
    dispersion_rows_by_mode: dict[tuple[int, int], dict[str, str]],
) -> None:
    metadata_path = root / "metadata.json"
    require_file(metadata_path)
    metadata = load_json(metadata_path)
    plan = metadata.get("execution_plan", {}).get("backend_plan")
    if not isinstance(plan, dict):
        fail("metadata.execution_plan.backend_plan is required for DE/BV analytic dispersion")
    validation = plan.get("dispersion_validation")
    if not isinstance(validation, dict):
        fail("metadata.execution_plan.backend_plan.dispersion_validation must be an object")
    manifest = load_json(root / "frequency_domain/manifest.v1.json")
    manifest_validation = manifest.get("validation", {}).get("dispersion_validation")
    if not isinstance(manifest_validation, dict):
        fail("manifest.validation.dispersion_validation must be an object")
    manifest_validation_block = manifest.get("validation")
    if not isinstance(manifest_validation_block, dict):
        fail("manifest.validation must be an object")
    frequency_source = manifest_validation_block.get("dispersion_frequency_source")
    if frequency_source not in (
        "analytic_reference_model",
        "numeric_modal_solver_with_analytic_comparison",
    ):
        fail(
            "manifest.validation.dispersion_frequency_source must distinguish "
            "analytic_reference_model from numeric_modal_solver_with_analytic_comparison"
        )
    dynamic_demag_source = manifest_validation_block.get("dynamic_demag_operator_source")
    if not isinstance(dynamic_demag_source, str) or not dynamic_demag_source.strip():
        fail("manifest.validation.dynamic_demag_operator_source must be a non-empty string")
    reference_model = manifest_validation_block.get("dispersion_reference_model")
    if frequency_source == "analytic_reference_model":
        require_equal(
            reference_model,
            "kalinikos_slab_n0",
            "manifest.validation.dispersion_reference_model",
        )
        require_equal(
            dynamic_demag_source,
            "analytic_thin_film_de_bv_reference_not_fem_demag_k",
            "manifest.validation.dynamic_demag_operator_source",
        )
    elif reference_model not in (None, ""):
        fail(
            "manifest.validation.dispersion_reference_model must be empty for "
            "numeric modal solver DE/BV comparison artifacts"
        )
    require_equal(
        canonical_dispersion_validation(
            manifest_validation,
            "manifest.validation.dispersion_validation",
        ),
        canonical_dispersion_validation(
            validation,
            "metadata.execution_plan.backend_plan.dispersion_validation",
        ),
        "manifest.validation.dispersion_validation",
    )
    require_equal(
        validation.get("kind"),
        "thin_film_de_bv_low_k",
        "metadata.execution_plan.backend_plan.dispersion_validation.kind",
    )
    require_equal(
        validation.get("analytic_model"),
        "kalinikos_slab_n0",
        "metadata.execution_plan.backend_plan.dispersion_validation.analytic_model",
    )
    frequency_window_hz = require_frequency_window_hz(
        validation.get("frequency_window_hz"),
        "metadata.execution_plan.backend_plan.dispersion_validation.frequency_window_hz",
    )
    if frequency_window_hz[1] > 5.0e9:
        fail("DE/BV low-k analytic dispersion frequency window must not exceed 5 GHz")
    max_k = require_finite_number(
        validation.get("max_k_rad_per_m"),
        "metadata.execution_plan.backend_plan.dispersion_validation.max_k_rad_per_m",
    )
    if max_k <= 0.0 or max_k > 3.0e6:
        fail("DE/BV low-k analytic dispersion max_k_rad_per_m must be in (0, 3e6]")
    film_thickness = require_finite_number(
        validation.get("film_thickness_m"),
        "metadata.execution_plan.backend_plan.dispersion_validation.film_thickness_m",
    )
    if film_thickness <= 0.0:
        fail("DE/BV low-k analytic dispersion film_thickness_m must be positive")
    max_relative_error = validation.get("max_relative_error")
    if max_relative_error is None:
        max_relative_error = 0.10
    max_relative_error = require_finite_number(
        max_relative_error,
        "metadata.execution_plan.backend_plan.dispersion_validation.max_relative_error",
    )
    if max_relative_error <= 0.0 or max_relative_error > 0.25:
        fail("DE/BV low-k analytic dispersion max_relative_error must be in (0, 0.25]")

    material = plan.get("material")
    if not isinstance(material, dict):
        fail("metadata.execution_plan.backend_plan.material must be an object")
    exchange_stiffness = require_finite_number(
        material.get("exchange_stiffness"),
        "metadata.execution_plan.backend_plan.material.exchange_stiffness",
    )
    saturation_magnetisation = require_finite_number(
        material.get("saturation_magnetisation"),
        "metadata.execution_plan.backend_plan.material.saturation_magnetisation",
    )
    if exchange_stiffness <= 0.0:
        fail("metadata.execution_plan.backend_plan.material.exchange_stiffness must be positive")
    if saturation_magnetisation <= 0.0:
        fail("metadata.execution_plan.backend_plan.material.saturation_magnetisation must be positive")
    gamma0 = require_finite_number(
        plan.get("gyromagnetic_ratio"),
        "metadata.execution_plan.backend_plan.gyromagnetic_ratio",
    )
    if gamma0 <= 0.0:
        fail("metadata.execution_plan.backend_plan.gyromagnetic_ratio must be positive")
    bias_field = vector_magnitude(
        require_vector3(
            plan.get("external_field"),
            "metadata.execution_plan.backend_plan.external_field",
        )
    )
    if bias_field <= 0.0:
        fail("metadata.execution_plan.backend_plan.external_field must be nonzero")
    magnetization_direction = unit_vector(
        require_vector3(
            validation.get("equilibrium_magnetization"),
            "metadata.execution_plan.backend_plan.dispersion_validation.equilibrium_magnetization",
        ),
        "metadata.execution_plan.backend_plan.dispersion_validation.equilibrium_magnetization",
    )
    film_normal = unit_vector(
        require_vector3(
            validation.get("film_normal"),
            "metadata.execution_plan.backend_plan.dispersion_validation.film_normal",
        ),
        "metadata.execution_plan.backend_plan.dispersion_validation.film_normal",
    )
    if abs(vector_dot(magnetization_direction, film_normal)) > 1.0e-6:
        fail("DE/BV low-k analytic dispersion requires in-plane equilibrium magnetization")

    scenarios = require_object_list(
        validation.get("scenarios"),
        "metadata.execution_plan.backend_plan.dispersion_validation.scenarios",
    )
    seen_geometries: set[str] = set()
    for scenario_index, scenario in enumerate(scenarios):
        raw_geometry = require_non_empty_string(
            scenario.get("geometry"),
            f"dispersion_validation.scenarios[{scenario_index}].geometry",
        )
        geometry_aliases = {
            "de": "damon_eshbach",
            "damon_eshbach": "damon_eshbach",
            "damon-eshbach": "damon_eshbach",
            "bv": "backward_volume",
            "backward_volume": "backward_volume",
            "backward-volume": "backward_volume",
        }
        geometry = geometry_aliases.get(raw_geometry.lower())
        if geometry is None:
            fail(f"dispersion_validation.scenarios[{scenario_index}].geometry is invalid")
        seen_geometries.add(geometry)
        branch_id = require_branch_id(
            scenario.get("branch_id"),
            f"dispersion_validation.scenarios[{scenario_index}].branch_id",
        )
        sample_indices = require_int_list(
            scenario.get("sample_indices"),
            f"dispersion_validation.scenarios[{scenario_index}].sample_indices",
        )
        if len(sample_indices) < 3:
            fail(f"DE/BV scenario {geometry} requires at least three samples")
        branch_errors: list[float] = []
        nonzero_samples = 0
        for sample_index in sample_indices:
            if sample_index not in known_samples:
                fail(f"DE/BV scenario {geometry} references unknown sample_index {sample_index}")
            _path_s, k_vector, _label = known_samples[sample_index]
            k_norm = vector_magnitude(k_vector)
            if k_norm > max_k * (1.0 + 1.0e-12):
                fail(
                    f"DE/BV scenario {geometry} sample_index {sample_index} exceeds low-k range: "
                    f"{k_norm!r} > {max_k!r}"
                )
            if k_norm > 0.0:
                nonzero_samples += 1
                k_direction = unit_vector(k_vector, f"sample {sample_index} k_vector")
                if abs(vector_dot(k_direction, film_normal)) > 1.0e-6:
                    fail(f"DE/BV scenario {geometry} sample_index {sample_index} k is not in-plane")
                projection = abs(vector_dot(k_direction, magnetization_direction))
                if geometry == "backward_volume" and abs(projection - 1.0) > 1.0e-6:
                    fail(
                        f"DE/BV scenario {geometry} sample_index {sample_index} "
                        "k must be parallel to equilibrium magnetization"
                    )
                if geometry == "damon_eshbach" and projection > 1.0e-6:
                    fail(
                        f"DE/BV scenario {geometry} sample_index {sample_index} "
                        "k must be perpendicular to equilibrium magnetization"
                    )
            matching_mode_entries = [
                (mode_key, mode_values[0])
                for mode_key, mode_values in known_modes.items()
                if mode_key[0] == sample_index and branch_ids_by_mode.get(mode_key) == branch_id
            ]
            if len(matching_mode_entries) != 1:
                fail(
                    f"DE/BV scenario {geometry} requires exactly one published mode "
                    f"for sample_index {sample_index}, branch_id {branch_id}"
                )
            mode_key, frequency_hz = matching_mode_entries[0]
            if frequency_hz < frequency_window_hz[0] or frequency_hz > frequency_window_hz[1]:
                fail(
                    f"DE/BV scenario {geometry} frequency for sample_index {sample_index} "
                    "is outside the requested low-GHz window"
                )
            expected_hz = kalinikos_slab_n0_frequency_hz(
                k_norm=k_norm,
                geometry=geometry,
                bias_field_a_per_m=bias_field,
                film_thickness_m=film_thickness,
                exchange_stiffness_j_per_m=exchange_stiffness,
                saturation_magnetisation_a_per_m=saturation_magnetisation,
                gamma0_rad_s_per_a_m=gamma0,
            )
            relative_error = abs(frequency_hz - expected_hz) / max(abs(expected_hz), 1.0)
            branch_errors.append(relative_error)
            row = dispersion_rows_by_mode.get(mode_key)
            if row is None:
                fail(
                    f"DE/BV scenario {geometry} requires a dispersion.csv row "
                    f"for sample_index {sample_index}, raw_mode_index {mode_key[1]}"
                )
            row_geometry = require_non_empty_string(
                row.get("validation_geometry"),
                f"dispersion row for sample {sample_index}.validation_geometry",
            )
            if row_geometry != geometry:
                fail(
                    f"dispersion row for sample_index {sample_index} has "
                    f"validation_geometry={row_geometry!r}, expected {geometry!r}"
                )
            row_analytic = require_finite_number(
                float(require_non_empty_string(
                    row.get("analytic_frequency_hz"),
                    f"dispersion row for sample {sample_index}.analytic_frequency_hz",
                )),
                f"dispersion row for sample {sample_index}.analytic_frequency_hz",
            )
            require_close(
                row_analytic,
                expected_hz,
                f"dispersion row for sample {sample_index}.analytic_frequency_hz",
                relative_tolerance=1.0e-12,
                absolute_tolerance=1.0e-6,
            )
            row_relative_error = require_finite_number(
                float(require_non_empty_string(
                    row.get("relative_error"),
                    f"dispersion row for sample {sample_index}.relative_error",
                )),
                f"dispersion row for sample {sample_index}.relative_error",
            )
            require_close(
                row_relative_error,
                relative_error,
                f"dispersion row for sample {sample_index}.relative_error",
                absolute_tolerance=1.0e-12,
            )
        if nonzero_samples < 2:
            fail(f"DE/BV scenario {geometry} requires at least two nonzero k samples")
        branch_error = max(branch_errors)
        if branch_error > max_relative_error:
            fail(
                f"DE/BV low-k analytic dispersion max relative error is too large "
                f"for {geometry}: got {branch_error:.6g}, expected <= {max_relative_error:.6g}"
            )
    if seen_geometries != {"damon_eshbach", "backward_volume"}:
        fail("DE/BV low-k analytic dispersion requires both Damon-Eshbach and backward-volume scenarios")


def validate_dispersion(
    root: Path,
    known_modes: dict[tuple[int, int], tuple[float, float, float, float]],
    known_samples: dict[int, tuple[float, tuple[float, float, float], str]],
    branch_ids_by_mode: dict[tuple[int, int], int],
    tracking_sources_by_mode: dict[tuple[int, int], str],
    overlap_by_mode: dict[tuple[int, int], float],
) -> dict[tuple[int, int], dict[str, str]]:
    path = root / "eigen/dispersion.csv"
    require_file(path)
    reader = csv.DictReader(path.read_text().splitlines())
    rows = list(reader)
    required_columns = {
        "sample_index",
        "path_s_rad_per_m",
        "kx_rad_per_m",
        "ky_rad_per_m",
        "kz_rad_per_m",
        "label",
        "raw_mode_index",
        "branch_id",
        "frequency_hz",
        "omega_rad_s",
        "line_width_hz",
        "residual_norm",
        "overlap_score",
        "tracking_score_source",
        "mode_field_id",
        "mode_field_resource_key",
    }
    missing = required_columns.difference(reader.fieldnames or [])
    if missing:
        fail(f"eigen/dispersion.csv missing columns: {sorted(missing)!r}")
    seen_mode_keys: set[tuple[int, int]] = set()
    rows_by_mode: dict[tuple[int, int], dict[str, str]] = {}
    for row_index, row in enumerate(rows):
        sample_index = require_non_negative_int(
            int(row["sample_index"]),
            f"dispersion row {row_index}.sample_index",
        )
        raw_mode_index = require_non_negative_int(
            int(row["raw_mode_index"]),
            f"dispersion row {row_index}.raw_mode_index",
        )
        mode_key = (sample_index, raw_mode_index)
        if mode_key in seen_mode_keys:
            fail(
                "duplicate dispersion row for "
                f"sample={sample_index}, raw_mode={raw_mode_index}"
            )
        seen_mode_keys.add(mode_key)
        rows_by_mode[mode_key] = row
        if mode_key not in known_modes:
            fail(
                "eigen/dispersion.csv references unknown mode "
                f"sample={sample_index}, raw_mode={raw_mode_index}"
            )
        sample_metadata = known_samples.get(sample_index)
        if sample_metadata is None:
            fail(
                "eigen/dispersion.csv references unknown sample "
                f"sample={sample_index}"
            )
        expected_path_s, expected_k_vector, expected_label = sample_metadata
        path_s = require_finite_number(
            float(row["path_s_rad_per_m"]),
            f"dispersion row {row_index}.path_s_rad_per_m",
        )
        require_close(
            path_s,
            expected_path_s,
            f"dispersion row {row_index}.path_s_rad_per_m",
            absolute_tolerance=1.0e-9,
        )
        for component_name, actual_text, expected_value in [
            ("kx_rad_per_m", row["kx_rad_per_m"], expected_k_vector[0]),
            ("ky_rad_per_m", row["ky_rad_per_m"], expected_k_vector[1]),
            ("kz_rad_per_m", row["kz_rad_per_m"], expected_k_vector[2]),
        ]:
            component_value = require_finite_number(
                float(actual_text),
                f"dispersion row {row_index}.{component_name}",
            )
            require_close(
                component_value,
                expected_value,
                f"dispersion row {row_index}.{component_name}",
                absolute_tolerance=1.0e-9,
            )
        require_equal(
            row.get("label", ""),
            expected_label,
            f"dispersion row {row_index}.label",
        )
        branch_id = require_non_negative_int(
            int(row["branch_id"]),
            f"dispersion row {row_index}.branch_id",
        )
        expected_branch_id = branch_ids_by_mode.get(mode_key)
        if expected_branch_id is None:
            fail(
                "eigen/dispersion.csv references mode without branch point "
                f"sample={sample_index}, raw_mode={raw_mode_index}"
            )
        require_equal(
            branch_id,
            expected_branch_id,
            f"dispersion row {row_index}.branch_id",
        )
        tracking_score_source = require_tracking_score_source(
            row.get("tracking_score_source"),
            f"dispersion row {row_index}.tracking_score_source",
            ALLOWED_TRACKING_SCORE_POINT_SOURCES,
        )
        expected_tracking_score_source = tracking_sources_by_mode.get(mode_key)
        if expected_tracking_score_source is None:
            fail(
                "eigen/dispersion.csv references mode without branch tracking source "
                f"sample={sample_index}, raw_mode={raw_mode_index}"
            )
        require_equal(
            tracking_score_source,
            expected_tracking_score_source,
            f"dispersion row {row_index}.tracking_score_source",
        )
        overlap_score_text = row.get("overlap_score", "").strip()
        if tracking_score_source == "modal_overlap_weighted_score" and not overlap_score_text:
            fail(
                f"dispersion row {row_index}.overlap_score must be present "
                "for modal_overlap_weighted_score"
            )
        if overlap_score_text:
            overlap_score = require_finite_number(
                float(overlap_score_text),
                f"dispersion row {row_index}.overlap_score",
            )
            if overlap_score < 0.0 or overlap_score > 1.0:
                fail(
                    f"dispersion row {row_index}.overlap_score must be in [0, 1]"
                )
            expected_overlap_score = overlap_by_mode.get(mode_key)
            if (
                tracking_score_source == "modal_overlap_weighted_score"
                and expected_overlap_score is not None
            ):
                require_close(
                    overlap_score,
                    expected_overlap_score,
                    f"dispersion row {row_index}.overlap_score",
                    absolute_tolerance=1.0e-12,
                )
        expected_field_id = mode_field_id(sample_index, raw_mode_index)
        expected_resource_key = mode_field_resource_key(expected_field_id)
        require_equal(
            row.get("mode_field_id"),
            expected_field_id,
            f"dispersion row {row_index}.mode_field_id",
        )
        require_equal(
            row.get("mode_field_resource_key"),
            expected_resource_key,
            f"dispersion row {row_index}.mode_field_resource_key",
        )
        frequency_hz = require_finite_number(
            float(row["frequency_hz"]),
            f"dispersion row {row_index}.frequency_hz",
        )
        omega_rad_s = require_finite_number(
            float(row["omega_rad_s"]),
            f"dispersion row {row_index}.omega_rad_s",
        )
        known_frequency_hz, _, known_frequency_imag_hz, known_angular_frequency = known_modes[mode_key]
        require_close(
            frequency_hz,
            known_frequency_hz,
            f"dispersion row {row_index}.frequency_hz",
        )
        require_close(
            omega_rad_s,
            known_angular_frequency,
            f"dispersion row {row_index}.omega_rad_s",
            absolute_tolerance=1.0e-3,
        )
        line_width_hz = row.get("line_width_hz", "").strip()
        if known_frequency_imag_hz > 0.0 and not line_width_hz:
            fail(
                f"dispersion row {row_index}.line_width_hz must be present "
                "when frequency_imag_hz is positive"
            )
        if line_width_hz:
            linewidth = require_finite_number(
                float(line_width_hz),
                f"dispersion row {row_index}.line_width_hz",
            )
            if linewidth < 0.0:
                fail(f"dispersion row {row_index}.line_width_hz must be non-negative")
            require_close(
                linewidth,
                2.0 * known_frequency_imag_hz,
                f"dispersion row {row_index}.line_width_hz",
            )
    missing_mode_keys = set(known_modes.keys()).difference(seen_mode_keys)
    if missing_mode_keys:
        fail(f"missing dispersion rows for modes: {sorted(missing_mode_keys)!r}")
    return rows_by_mode


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate FEM frequency-domain modal eigen artifacts.",
    )
    parser.add_argument(
        "root",
        nargs="?",
        default=".fullmag/reports/eigen/artifacts",
        help="artifact root directory",
    )
    parser.add_argument(
        "--require-production-shift-invert-window",
        action="store_true",
        help=(
            "require managed runtime frequency-window artifacts from the "
            "native production modal SLEPc shift-invert adapter"
        ),
    )
    parser.add_argument(
        "--require-reference-full-2x2-floquet",
        action="store_true",
        help=(
            "require reference/MVP nonzero-k Floquet dispersion artifacts from "
            "the CPU full-2x2 phase-reduced tangent path"
        ),
    )
    parser.add_argument(
        "--require-production-modal-k-path",
        action="store_true",
        help=(
            "require production selected-spectrum nonzero-k modal dispersion "
            "artifacts rather than the reference k-path filter or gamma-only "
            "production bridge"
        ),
    )
    parser.add_argument(
        "--require-production-gamma-k-path",
        action="store_true",
        help=(
            "require a gamma-equivalent production selected-spectrum modal "
            "k-path bridge with all sampled k-vectors equal to zero"
        ),
    )
    parser.add_argument(
        "--require-exchange-only-analytic-dispersion",
        action="store_true",
        help=(
            "require the no-demag exchange+Zeeman k-path branch to match "
            "f = gamma0 * (H0 + 2 A k^2/(mu0 Ms)) / (2*pi) within coarse "
            "reference-FEM tolerance"
        ),
    )
    parser.add_argument(
        "--require-exchange-only-reciprocal-dispersion",
        action="store_true",
        help=(
            "require no-demag exchange+Zeeman k-path artifacts to include a "
            "+k/-k branch pair and satisfy f(k)=f(-k) within reciprocal "
            "dispersion tolerance"
        ),
    )
    parser.add_argument(
        "--require-k0-kittel-field-sweep",
        action="store_true",
        help=(
            "require a k=0 uniform-field eigen branch to match the macrospin "
            "Larmor or in-plane thin-film Kittel formula declared in "
            "metadata.execution_plan.backend_plan.k0_kittel_validation"
        ),
    )
    parser.add_argument(
        "--require-k0-kittel-demag",
        action="store_true",
        help=(
            "require the K0-3 thin-film demag Kittel validation contract, "
            "including case_id=K0-3 and demag_kind metadata in summary/points"
        ),
    )
    parser.add_argument(
        "--require-k0-kittel-periodic-airbox-demag",
        action="store_true",
        help=(
            "require the K0-3 thin-film demag Kittel validation contract to "
            "use the real periodic_airbox_k0 Poisson-airbox demag path, not "
            "the synthetic demag-factor validation slice"
        ),
    )
    parser.add_argument(
        "--require-gpu-modal-k0-kittel-provenance",
        action="store_true",
        help=(
            "require k0 Kittel artifacts to prove a real FEM modal GPU solve "
            "instead of CPU fallback or driven-response GPU provenance"
        ),
    )
    parser.add_argument(
        "--require-gpu-modal-k0-periodic-airbox-provenance",
        action="store_true",
        help=(
            "require strict production GPU K0 periodic-airbox modal execution, "
            "persistent device Krylov residency, zero iterative vector transfers, "
            "full residual certification, and no CPU fallback"
        ),
    )
    parser.add_argument(
        "--require-k0-periodic-airbox-production",
        action="store_true",
        help=(
            "require a fresh CPU or GPU P1 periodic-airbox modal artifact "
            "without analytical Kittel metadata"
        ),
    )
    parser.add_argument(
        "--require-gpu-modal-k0-periodic-airbox-production",
        action="store_true",
        help=(
            "require a fresh GPU P1 periodic-airbox modal artifact without "
            "analytical Kittel metadata"
        ),
    )
    parser.add_argument(
        "--require-low-k-de-bv-analytic-dispersion",
        action="store_true",
        help=(
            "require realistic thin-film low-k Damon-Eshbach and "
            "backward-volume dispersion scenarios with |k| <= 3e6 rad/m, "
            "frequency window <= 5 GHz, and Kalinikos n=0 analytic agreement"
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.require_k0_kittel_periodic_airbox_demag:
        args.require_k0_kittel_demag = True
    if args.require_gpu_modal_k0_periodic_airbox_provenance:
        args.require_k0_kittel_periodic_airbox_demag = True
        args.require_k0_kittel_demag = True
    if args.require_gpu_modal_k0_periodic_airbox_production:
        args.require_k0_periodic_airbox_production = True
    if args.require_k0_kittel_demag:
        args.require_k0_kittel_field_sweep = True
    if args.require_production_modal_k_path and args.require_production_gamma_k_path:
        fail(
            "--require-production-modal-k-path and "
            "--require-production-gamma-k-path are mutually exclusive"
        )
    root = Path(args.root)
    for relative_path in [
        "eigen/spectrum.v2.json",
        "eigen/branches.v2.json",
        "eigen/dispersion.csv",
        "eigen/metadata/eigen_summary.json",
        "frequency_domain/manifest.v1.json",
    ]:
        require_file(root / relative_path)

    spectrum = load_json(root / "eigen/spectrum.v2.json")
    branches = load_json(root / "eigen/branches.v2.json")
    summary = load_json(root / "eigen/metadata/eigen_summary.json")
    manifest = load_json(root / "frequency_domain/manifest.v1.json")
    solver_diagnostics = load_json(root / "eigen/diagnostics/solver.v1.json")

    require_equal(spectrum.get("schema_version"), "eigen_spectrum.v2", "spectrum.schema_version")
    require_equal(branches.get("schema_version"), "eigen_branches.v2", "branches.schema_version")
    require_equal(
        manifest.get("schema_version"),
        "frequency_domain_manifest.v1",
        "manifest.schema_version",
    )
    require_equal(manifest.get("stage_kind"), "eigenmodes", "manifest.stage_kind")
    validate_manifest_physics(manifest)
    require_equal(
        manifest.get("artifacts", {}).get("solver_diagnostics_path"),
        "eigen/diagnostics/solver.v1.json",
        "manifest.artifacts.solver_diagnostics_path",
    )
    manifest_diagnostics = manifest.get("diagnostics")
    if not isinstance(manifest_diagnostics, dict):
        fail("manifest.diagnostics must be an object")
    require_tracking_summary(manifest_diagnostics, "manifest.diagnostics")
    require_file(root / "eigen/diagnostics/solver.v1.json")
    require_equal(
        solver_diagnostics.get("schema_version"),
        "frequency_domain_modal_solver_diagnostics.v1",
        "solver_diagnostics.schema_version",
    )
    require_equal(
        solver_diagnostics.get("study_product"),
        "modal_eigen",
        "solver_diagnostics.study_product",
    )
    validate_solver_provenance(
        solver_diagnostics,
        require_production_shift_invert_window=args.require_production_shift_invert_window,
        require_production_modal_k_path=args.require_production_modal_k_path,
        require_production_gamma_k_path=args.require_production_gamma_k_path,
        require_reference_full_2x2_floquet=args.require_reference_full_2x2_floquet,
    )
    validate_reference_full_2x2_floquet_manifest_diagnostics(
        manifest_diagnostics,
        solver_diagnostics,
        require_reference_full_2x2_floquet=args.require_reference_full_2x2_floquet,
    )
    validate_production_modal_k_path_manifest_certificate(
        manifest_diagnostics,
        solver_diagnostics,
        require_production_modal_k_path=args.require_production_modal_k_path,
    )
    validate_dispersion_manifest_capabilities(
        manifest,
        require_reference_full_2x2_floquet=args.require_reference_full_2x2_floquet,
        require_production_modal_k_path=args.require_production_modal_k_path,
        require_production_gamma_k_path=args.require_production_gamma_k_path,
    )
    validate_production_modal_k_path_scope(
        manifest,
        require_production_modal_k_path=args.require_production_modal_k_path,
        require_production_gamma_k_path=args.require_production_gamma_k_path,
    )
    if args.require_production_modal_k_path or args.require_production_gamma_k_path:
        require_equal(
            manifest.get("physics", {}).get("phase_convention"),
            "exp_i_omega_t",
            "manifest.physics.phase_convention",
        )
    requested_window_hz = validate_solver_window_diagnostics(
        solver_diagnostics,
        require_window=(
            args.require_production_shift_invert_window
            or args.require_production_modal_k_path
            or args.require_production_gamma_k_path
        ),
    )
    require_equal(
        manifest.get("artifacts", {}).get("spectrum_v2_path"),
        "eigen/spectrum.v2.json",
        "manifest.artifacts.spectrum_v2_path",
    )
    mode_field_storage_format = manifest.get("artifacts", {}).get("mode_field_storage_format")
    if mode_field_storage_format == "zarr":
        require_equal(
            manifest.get("artifacts", {}).get("mode_field_zarr_store_path"),
            mode_zarr_store_path(),
            "manifest.artifacts.mode_field_zarr_store_path",
        )
        require_mode_zarr_store(root)
        require_zarr_mode_fields = True
    elif (
        mode_field_storage_format == "binary_compatibility_exports"
        and (
            args.require_low_k_de_bv_analytic_dispersion
            or args.require_k0_kittel_demag
            or args.require_k0_periodic_airbox_production
        )
    ):
        require_equal(
            manifest.get("artifacts", {}).get("mode_field_zarr_store_path"),
            None,
            "manifest.artifacts.mode_field_zarr_store_path",
        )
        require_zarr_mode_fields = False
    else:
        fail(
            "manifest.artifacts.mode_field_storage_format must be 'zarr'"
            " or, for low-k DE/BV analytic reference and K0 Kittel demag artifacts only,"
            " 'binary_compatibility_exports'"
        )

    manifest_mode_paths = set(
        require_string_list(
            manifest.get("artifacts", {}).get("mode_metadata_paths"),
            "manifest.artifacts.mode_metadata_paths",
        )
    )
    manifest_mode_resources = set(
        require_string_list(
            manifest.get("resources", {}).get("mode_field_resources"),
            "manifest.resources.mode_field_resources",
        )
    )

    samples = require_object_list(spectrum.get("samples"), "spectrum.samples")
    require_equal(spectrum.get("sample_count"), len(samples), "spectrum.sample_count")
    known_modes: dict[tuple[int, int], tuple[float, float, float, float]] = {}
    known_mode_summaries: dict[tuple[int, int], dict] = {}
    known_samples: dict[int, tuple[float, tuple[float, float, float], str]] = {}
    published_mode_counts: list[int] = []
    for sample_position, sample in enumerate(samples):
        sample_index = require_non_negative_int(
            sample.get("sample_index"),
            f"spectrum.samples[{sample_position}].sample_index",
        )
        path_s = require_finite_number(sample.get("path_s"), f"spectrum.samples[{sample_position}].path_s")
        k_vector_raw = sample.get("k_vector")
        if not isinstance(k_vector_raw, list) or len(k_vector_raw) != 3:
            fail(f"spectrum.samples[{sample_position}].k_vector must be a length-3 array")
        k_vector = tuple(
            require_finite_number(
                component,
                f"spectrum.samples[{sample_position}].k_vector[{component_index}]",
            )
            for component_index, component in enumerate(k_vector_raw)
        )
        label = sample.get("label")
        if label is None:
            label = ""
        if not isinstance(label, str):
            fail(f"spectrum.samples[{sample_position}].label must be a string or null")
        known_samples[sample_index] = (path_s, k_vector, label)
        modes = require_object_list(sample.get("modes"), f"spectrum.samples[{sample_position}].modes")
        published_mode_counts.append(len(modes))
        for mode in modes:
            (
                known_sample_index,
                known_raw_mode_index,
                known_frequency_hz,
                known_frequency_real_hz,
                known_frequency_imag_hz,
                known_angular_frequency,
            ) = validate_mode_summary(
                root,
                mode,
                sample_index,
                manifest_mode_paths,
                manifest_mode_resources,
                requested_window_hz,
                require_zarr_mode_fields,
            )
            known_modes[(known_sample_index, known_raw_mode_index)] = (
                known_frequency_hz,
                known_frequency_real_hz,
                known_frequency_imag_hz,
                known_angular_frequency,
            )
            known_mode_summaries[(known_sample_index, known_raw_mode_index)] = mode
    if not known_modes:
        fail("spectrum.samples must include at least one mode")
    spectrum_mode_count = require_non_negative_int(
        spectrum.get("mode_count"),
        "spectrum.mode_count",
    )
    diagnostics_mode_count = require_non_negative_int(
        solver_diagnostics.get("mode_count"),
        "solver_diagnostics.mode_count",
    )
    published_mode_count = max(published_mode_counts, default=0)
    require_equal(
        spectrum_mode_count,
        published_mode_count,
        "spectrum.mode_count",
    )
    require_equal(
        diagnostics_mode_count,
        published_mode_count,
        "solver_diagnostics.mode_count",
    )
    if args.require_reference_full_2x2_floquet:
        validate_reference_full_2x2_floquet_mode_metadata(root, manifest_mode_paths)
    validate_dispersion_k_sampling_path(
        root,
        known_samples,
        require_path_metadata=(
            args.require_reference_full_2x2_floquet
            or args.require_production_modal_k_path
        ),
    )
    validate_production_k_path_samples(
        known_samples,
        require_production_modal_k_path=args.require_production_modal_k_path,
        require_production_gamma_k_path=args.require_production_gamma_k_path,
    )
    validate_production_k_path_mode_quality(
        known_mode_summaries,
        require_production_modal_k_path=args.require_production_modal_k_path,
        require_production_gamma_k_path=args.require_production_gamma_k_path,
    )
    validate_production_k_path_solver_subwindows(
        solver_diagnostics,
        require_production_modal_k_path=args.require_production_modal_k_path,
        require_production_gamma_k_path=args.require_production_gamma_k_path,
    )

    branch_modes: set[tuple[int, int]] = set()
    branch_ids_by_mode: dict[tuple[int, int], int] = {}
    tracking_sources_by_mode: dict[tuple[int, int], str] = {}
    overlap_by_mode: dict[tuple[int, int], float] = {}
    require_tracking_summary(branches, "branches")
    branch_diagnostics = branches.get("diagnostics")
    if not isinstance(branch_diagnostics, dict):
        fail("branches.diagnostics must be an object")
    require_tracking_summary(branch_diagnostics, "branches.diagnostics")
    for branch_index, branch in enumerate(require_object_list(branches.get("branches"), "branches.branches")):
        branch_id = require_non_negative_int(branch.get("branch_id"), f"branches[{branch_index}].branch_id")
        for point in require_object_list(branch.get("points"), f"branches[{branch_index}].points"):
            sample_index = require_non_negative_int(point.get("sample_index"), "branch point.sample_index")
            raw_mode_index = require_non_negative_int(
                point.get("raw_mode_index"),
                "branch point.raw_mode_index",
            )
            branch_mode_key = (sample_index, raw_mode_index)
            branch_modes.add(branch_mode_key)
            existing_branch_id = branch_ids_by_mode.get(branch_mode_key)
            if existing_branch_id is not None and existing_branch_id != branch_id:
                fail(
                    "branches contain duplicate mode points with conflicting branch_id: "
                    f"sample={sample_index}, raw_mode={raw_mode_index}"
                )
            branch_ids_by_mode[branch_mode_key] = branch_id
            tracking_source = require_tracking_point(point, "branch point")
            tracking_sources_by_mode[branch_mode_key] = tracking_source
            tracking_confidence = require_finite_number(
                point.get("tracking_confidence"),
                "branch point.tracking_confidence",
            )
            if tracking_confidence < 0.0 or tracking_confidence > 1.0:
                fail("branch point.tracking_confidence must be in [0, 1]")
            overlap_prev = point.get("overlap_prev")
            if tracking_source == "modal_overlap_weighted_score" and overlap_prev is None:
                fail("branch point.overlap_prev is required for modal_overlap_weighted_score")
            if overlap_prev is not None:
                overlap_by_mode[branch_mode_key] = require_finite_number(
                    overlap_prev,
                    "branch point.overlap_prev",
                )
                if overlap_by_mode[branch_mode_key] < 0.0 or overlap_by_mode[branch_mode_key] > 1.0:
                    fail("branch point.overlap_prev must be in [0, 1]")
                if tracking_source == "modal_overlap_weighted_score":
                    require_close(
                        tracking_confidence,
                        overlap_by_mode[branch_mode_key],
                        "branch point.tracking_confidence",
                        absolute_tolerance=1.0e-12,
                    )
            require_mode_field_handoff(
                point,
                "branch point",
                sample_index,
                raw_mode_index,
            )
            if branch_mode_key in known_modes:
                frequency_hz = require_finite_number(
                    point.get("frequency_hz"),
                    "branch point.frequency_hz",
                )
                frequency_real_hz = require_finite_number(
                    point.get("frequency_real_hz"),
                    "branch point.frequency_real_hz",
                )
                angular_frequency = require_finite_number(
                    point.get("angular_frequency_rad_per_s"),
                    "branch point.angular_frequency_rad_per_s",
                )
                (
                    known_frequency_hz,
                    known_frequency_real_hz,
                    _known_frequency_imag_hz,
                    known_angular_frequency,
                ) = known_modes[branch_mode_key]
                require_close(
                    frequency_hz,
                    known_frequency_hz,
                    "branch point.frequency_hz",
                )
                require_close(
                    frequency_real_hz,
                    known_frequency_real_hz,
                    "branch point.frequency_real_hz",
                )
                require_close(
                    angular_frequency,
                    known_angular_frequency,
                    "branch point.angular_frequency_rad_per_s",
                    absolute_tolerance=1.0e-3,
                )
    unknown_branch_modes = branch_modes.difference(known_modes.keys())
    if unknown_branch_modes:
        fail(f"branches reference unknown modes: {sorted(unknown_branch_modes)!r}")
    validate_production_modal_k_path_branch_tracking(
        manifest_diagnostics,
        branches,
        branch_diagnostics,
        tracking_sources_by_mode,
        overlap_by_mode,
        require_production_modal_k_path=args.require_production_modal_k_path,
    )
    dispersion_rows_by_mode = validate_dispersion(
        root,
        known_modes,
        known_samples,
        branch_ids_by_mode,
        tracking_sources_by_mode,
        overlap_by_mode,
    )

    if args.require_reference_full_2x2_floquet:
        validate_reference_full_2x2_floquet_dispersion_path(
            known_modes,
            known_samples,
            branch_ids_by_mode,
        )
    if args.require_exchange_only_analytic_dispersion:
        validate_exchange_only_analytic_dispersion(
            root,
            known_modes,
            known_samples,
            branch_ids_by_mode,
        )
    if args.require_exchange_only_reciprocal_dispersion:
        validate_exchange_only_reciprocal_dispersion(
            known_modes,
            known_samples,
            branch_ids_by_mode,
        )
    if args.require_k0_kittel_field_sweep:
        validate_k0_kittel_field_sweep(
            root,
            known_modes,
            known_samples,
            branch_ids_by_mode,
            require_demag=args.require_k0_kittel_demag,
            require_periodic_airbox_demag=args.require_k0_kittel_periodic_airbox_demag,
        )
    if args.require_gpu_modal_k0_kittel_provenance:
        validate_gpu_modal_k0_kittel_provenance(root)
    if args.require_gpu_modal_k0_periodic_airbox_provenance:
        validate_gpu_modal_k0_periodic_airbox_provenance(root)
    if args.require_k0_periodic_airbox_production:
        validate_k0_periodic_airbox_production_provenance(root)
        if args.require_gpu_modal_k0_periodic_airbox_production:
            requested_execution = manifest.get("requested_execution")
            if not isinstance(requested_execution, dict):
                fail("GPU K0 production provenance requires requested execution metadata")
            require_equal(
                requested_execution.get("device"),
                "gpu",
                "manifest.requested_execution.device",
            )
    if args.require_low_k_de_bv_analytic_dispersion:
        validate_low_k_de_bv_analytic_dispersion(
            root,
            known_modes,
            known_samples,
            branch_ids_by_mode,
            dispersion_rows_by_mode,
        )

    validate_eigen_summary(
        summary,
        known_modes,
        known_mode_summaries,
        requested_window_hz,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
