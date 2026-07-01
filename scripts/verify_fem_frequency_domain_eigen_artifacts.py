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
PRODUCTION_SHIFT_INVERT_SOLVER_MODELS = {
    "slepc_multi_shift_invert_production_cpu_dense",
}
ALLOWED_MODAL_PHASOR_CONVENTIONS = {
    "exp_i_omega_t",
    "exp_minus_i_omega_t",
    "not_applicable_real_reference",
}
ALLOWED_MODAL_EIGENVALUE_MAPPINGS = {
    "lambda_eq_i_omega",
    "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m",
}
ALLOWED_MODAL_ALGEBRAIC_FORMS = {
    "reference_effective_field_generalized",
    "linearized_llg_generalized",
    "gyrotropic_generalized",
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


def require_non_empty_string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(f"{name} must be a non-empty string")
    return value


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
    return source


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
    if phase_convention not in {"exp_i_omega_t", "exp_minus_i_omega_t"}:
        fail(
            "manifest.physics.phase_convention must be exp_i_omega_t "
            "or exp_minus_i_omega_t"
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


def validate_mode_summary(
    root: Path,
    mode: dict,
    sample_index: int,
    manifest_mode_paths: set[str],
    manifest_mode_resources: set[str],
    requested_window_hz: list[float] | None,
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
    validate_mode_diagnostics_fields(metadata, metadata_path, frequency_hz)
    require_mode_metadata_summaries(metadata, metadata_path)
    require_mode_field_metadata(metadata, metadata_path, sample_index, raw_mode_index)

    expected_meta_resource = mode_meta_resource_key(sample_index, raw_mode_index)
    if manifest_mode_resources and expected_meta_resource not in manifest_mode_resources:
        fail(f"manifest.resources.mode_field_resources missing {expected_meta_resource}")
    payload_value_count = require_non_negative_int(
        metadata.get("payload_value_count"),
        f"{metadata_path}.payload_value_count",
    )
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
        sample_index = 0
        raw_mode_index = require_non_negative_int(mode.get("index"), "eigen_summary mode.index")
        mode_key = (sample_index, raw_mode_index)
        if mode_key not in known_modes:
            fail(f"eigen_summary references unknown mode {mode_key!r}")
        frequency_hz = require_finite_number(mode.get("frequency_hz"), "eigen_summary mode.frequency_hz")
        require_frequency_inside_window(
            frequency_hz,
            requested_window_hz,
            f"eigen_summary.modes[{raw_mode_index}].frequency_hz",
        )
        validate_mode_diagnostics_fields(
            mode,
            f"eigen_summary.modes[{raw_mode_index}]",
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

    subwindows = require_object_list(
        diagnostics.get("subwindows"),
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
    if spectral_transform not in {"none", "shift_invert", "contour_integral"}:
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
                diagnostics.get("production_solver_available"),
                False,
                "solver_diagnostics.production_solver_available",
            )
            require_equal(
                spectral_transform,
                "none",
                "solver_diagnostics.spectral_transform",
            )
    if require_production_modal_k_path:
        sample_count = require_non_negative_int(
            diagnostics.get("sample_count"),
            "solver_diagnostics.sample_count",
        )
        if sample_count <= 1:
            fail("production modal k-path requires solver_diagnostics.sample_count > 1")
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


def validate_dispersion(
    root: Path,
    known_modes: dict[tuple[int, int], tuple[float, float, float, float]],
    known_samples: dict[int, tuple[float, tuple[float, float, float], str]],
    branch_ids_by_mode: dict[tuple[int, int], int],
    tracking_sources_by_mode: dict[tuple[int, int], str],
) -> None:
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
            "require production selected-spectrum modal k-path/Floquet "
            "dispersion artifacts rather than the reference k-path filter"
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
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
        require_reference_full_2x2_floquet=args.require_reference_full_2x2_floquet,
    )
    if args.require_production_modal_k_path:
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
        ),
    )
    require_equal(
        manifest.get("artifacts", {}).get("spectrum_v2_path"),
        "eigen/spectrum.v2.json",
        "manifest.artifacts.spectrum_v2_path",
    )
    require_equal(
        manifest.get("artifacts", {}).get("mode_field_storage_format"),
        "zarr",
        "manifest.artifacts.mode_field_storage_format",
    )
    require_equal(
        manifest.get("artifacts", {}).get("mode_field_zarr_store_path"),
        mode_zarr_store_path(),
        "manifest.artifacts.mode_field_zarr_store_path",
    )
    require_mode_zarr_store(root)

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
            )
            known_modes[(known_sample_index, known_raw_mode_index)] = (
                known_frequency_hz,
                known_frequency_real_hz,
                known_frequency_imag_hz,
                known_angular_frequency,
            )
    if not known_modes:
        fail("spectrum.samples must include at least one mode")
    diagnostics_mode_count = require_non_negative_int(
        solver_diagnostics.get("mode_count"),
        "solver_diagnostics.mode_count",
    )
    published_mode_count = max(published_mode_counts, default=0)
    require_equal(
        diagnostics_mode_count,
        published_mode_count,
        "solver_diagnostics.mode_count",
    )
    if args.require_reference_full_2x2_floquet:
        validate_reference_full_2x2_floquet_mode_metadata(root, manifest_mode_paths)

    branch_modes: set[tuple[int, int]] = set()
    branch_ids_by_mode: dict[tuple[int, int], int] = {}
    tracking_sources_by_mode: dict[tuple[int, int], str] = {}
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

    validate_eigen_summary(summary, known_modes, requested_window_hz)
    validate_dispersion(
        root,
        known_modes,
        known_samples,
        branch_ids_by_mode,
        tracking_sources_by_mode,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
