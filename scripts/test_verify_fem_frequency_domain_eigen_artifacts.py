#!/usr/bin/env python3
"""Unit tests for FEM frequency-domain modal eigen artifact validation."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_fem_frequency_domain_eigen_artifacts.py"


def drop_csv_columns(header: str, row: str, columns: set[str]) -> tuple[str, str]:
    names = header.split(",")
    values = row.split(",")
    keep_indices = [index for index, name in enumerate(names) if name not in columns]
    return (
        ",".join(names[index] for index in keep_indices),
        ",".join(values[index] for index in keep_indices),
    )


def set_csv_column(header: str, row: str, column: str, value: str) -> str:
    names = header.split(",")
    values = row.split(",")
    values[names.index(column)] = value
    return ",".join(values)


def write_eigen_fixture(
    root: Path,
    *,
    manifest_physics_override: dict[str, object] | None = None,
    omit_spectrum_mode_field_resource_key: bool = False,
    inline_mode_vectors: bool = False,
    omit_mode_payload_encoding: bool = False,
    available_views_override: list[str] | None = None,
    complex_pair_count_override: int | None = None,
    frequency_hz_override: float | None = None,
    branch_frequency_hz_override: float | None = None,
    dispersion_frequency_hz_override: float | None = None,
    zarr_quantity_id_override: str | None = None,
    zarr_root_preferred_container_override: str | None = None,
    payload_size: int = 48,
    manifest_mode_resources_override: list[str] | None = None,
    omit_mode_residual_relative_l2: bool = False,
    omit_mode_omega_rad_s: bool = False,
    omit_mode_eigenvalue_mapping: bool = False,
    omit_mode_tangent_leakage: bool = False,
    omit_branch_tracking_source: bool = False,
    branch_tracking_score_source_override: str | None = None,
    branch_modal_overlap_available_override: bool | None = None,
    omit_dispersion_overlap_score: bool = False,
    omit_dispersion_required_display_columns: bool = False,
    dispersion_branch_id_override: str | None = None,
    dispersion_tracking_score_source_override: str | None = None,
    dispersion_overlap_score_override: str | None = None,
    dispersion_path_s_override: str | None = None,
    dispersion_kx_override: str | None = None,
    dispersion_label_override: str | None = None,
    dispersion_line_width_override: str | None = None,
    duplicate_dispersion_row: bool = False,
    omit_dispersion_rows: bool = False,
    omit_dispersion_mode_field_columns: bool = False,
    gamma_rad_s_t_override: float | None = None,
    solver_diagnostics_override: dict[str, object] | None = None,
) -> None:
    (root / "eigen" / "modes" / "sample_0000").mkdir(parents=True)
    (root / "eigen" / "mode_fields" / "sample_0000" / "mode_0000").mkdir(
        parents=True
    )
    (root / "eigen" / "metadata").mkdir(parents=True)
    zarr_array_dir = (
        root
        / "eigen"
        / "mode_fields.zarr"
        / "sample_0000"
        / "mode_0000"
        / "vector_xyz_complex"
    )
    zarr_array_dir.mkdir(parents=True)
    (root / "frequency_domain").mkdir(parents=True)

    field_id = "analysis:eigen:sample-0000:mode-0000"
    field_resource = (
        "/v2/sessions/current/data/fields/"
        "analysis:eigen:sample-0000:mode-0000/samples/vector"
        "?view=phase_rotated_real&phase_rad=0"
    )
    meta_resource = (
        "/v2/sessions/current/analysis/frequency-domain/eigen/"
        "mode-field/0/0/meta"
    )
    mode_summary: dict[str, object] = {
        "raw_mode_index": 0,
        "branch_id": 0,
        "mode_field_id": field_id,
        "mode_field_resource_key": field_resource,
        "frequency_hz": frequency_hz_override if frequency_hz_override is not None else 1.0e9,
        "frequency_real_hz": 1.0e9,
        "frequency_imag_hz": 0.0,
        "angular_frequency_rad_per_s": 6.283185307179586e9,
        "eigenvalue_real": 0.0,
        "eigenvalue_imag": 6.283185307179586e9,
        "phasor_convention": "not_applicable_real_reference",
        "eigenvalue_mapping": (
            "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m"
        ),
        "norm": 1.0,
        "max_amplitude": 1.0,
        "residual_norm": 1.0e-9,
        "residual_absolute_l2": 1.0e-9,
        "residual_relative_l2": 1.0e-12,
        "residual_linf": 1.0e-10,
        "mass_norm": 1.0,
        "tangent_leakage_mean_abs": 0.0,
        "tangent_leakage_max_abs": 0.0,
        "dominant_polarization": "linear",
        "k_vector": [0.0, 0.0, 0.0],
        "omega_rad_s": 6.283185307179586e9,
        "gamma_rad_s_T": (
            gamma_rad_s_t_override
            if gamma_rad_s_t_override is not None
            else 1.759457895880903e11
        ),
        "gamma0_rad_s_per_A_m": 2.211e5,
        "mu0_T_m_per_A": 1.2566370614359173e-6,
    }
    if omit_spectrum_mode_field_resource_key:
        del mode_summary["mode_field_resource_key"]
    spectrum = {
        "schema_version": "eigen_spectrum.v2",
        "solver_model": "reference_scalar_tangent",
        "sample_count": 1,
        "samples": [
            {
                "sample_index": 0,
                "label": "G",
                "k_vector": [0.0, 0.0, 0.0],
                "path_s": 0.0,
                "segment_index": 0,
                "t_in_segment": 0.0,
                "modes": [mode_summary],
            }
        ],
    }
    (root / "eigen" / "spectrum.v2.json").write_text(json.dumps(spectrum))

    branch_point = {
        "sample_index": 0,
        "raw_mode_index": 0,
        "frequency_hz": (
            branch_frequency_hz_override
            if branch_frequency_hz_override is not None
            else 1.0e9
        ),
        "frequency_real_hz": 1.0e9,
        "frequency_imag_hz": 0.0,
        "angular_frequency_rad_per_s": 6.283185307179586e9,
        "tracking_confidence": 1.0,
        "overlap_prev": None,
        "tracking_score_source": (
            branch_tracking_score_source_override
            if branch_tracking_score_source_override is not None
            else "seed"
        ),
        "modal_overlap_available": (
            branch_modal_overlap_available_override
            if branch_modal_overlap_available_override is not None
            else False
        ),
        "mode_field_id": field_id,
        "mode_field_resource_key": field_resource,
    }
    if omit_branch_tracking_source:
        del branch_point["tracking_score_source"]
    branches = {
        "schema_version": "eigen_branches.v2",
        "solver_model": "reference_scalar_tangent",
        "tracking_score_source": "seed_only",
        "modal_overlap_available": False,
        "branches": [
            {
                "branch_id": 0,
                "label": "B0",
                "points": [branch_point],
            }
        ],
        "diagnostics": {
            "tracking_score_source": "seed_only",
            "modal_overlap_available": False,
        },
    }
    (root / "eigen" / "branches.v2.json").write_text(json.dumps(branches))
    dispersion_header = (
        "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,"
        "label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,"
        "residual_norm,overlap_score,tracking_score_source,mode_field_id,"
        "mode_field_resource_key"
    )
    dispersion_row = (
        "0,0,0,0,0,G,0,0,"
        f"{dispersion_frequency_hz_override if dispersion_frequency_hz_override is not None else 1.0e9},"
        "6.283185307179586e9,0,1.0e-9,,seed,"
        f"{field_id},{field_resource}"
    )
    if omit_dispersion_mode_field_columns:
        dispersion_header = (
            "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,"
            "label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,"
            "residual_norm,overlap_score,tracking_score_source"
        )
        dispersion_row = (
            "0,0,0,0,0,G,0,0,"
            f"{dispersion_frequency_hz_override if dispersion_frequency_hz_override is not None else 1.0e9},"
            "6.283185307179586e9,0,1.0e-9,,seed"
        )
    if omit_dispersion_overlap_score:
        dispersion_header, dispersion_row = drop_csv_columns(
            dispersion_header,
            dispersion_row,
            {"overlap_score"},
        )
    if omit_dispersion_required_display_columns:
        dispersion_header, dispersion_row = drop_csv_columns(
            dispersion_header,
            dispersion_row,
            {"label", "branch_id", "line_width_hz"},
        )
    if dispersion_branch_id_override is not None:
        dispersion_row = set_csv_column(
            dispersion_header,
            dispersion_row,
            "branch_id",
            dispersion_branch_id_override,
        )
    if dispersion_tracking_score_source_override is not None:
        dispersion_row = set_csv_column(
            dispersion_header,
            dispersion_row,
            "tracking_score_source",
            dispersion_tracking_score_source_override,
        )
    if dispersion_overlap_score_override is not None:
        dispersion_row = set_csv_column(
            dispersion_header,
            dispersion_row,
            "overlap_score",
            dispersion_overlap_score_override,
        )
    if dispersion_path_s_override is not None:
        dispersion_row = set_csv_column(
            dispersion_header,
            dispersion_row,
            "path_s_rad_per_m",
            dispersion_path_s_override,
        )
    if dispersion_kx_override is not None:
        dispersion_row = set_csv_column(
            dispersion_header,
            dispersion_row,
            "kx_rad_per_m",
            dispersion_kx_override,
        )
    if dispersion_label_override is not None:
        dispersion_row = set_csv_column(
            dispersion_header,
            dispersion_row,
            "label",
            dispersion_label_override,
        )
    if dispersion_line_width_override is not None:
        dispersion_row = set_csv_column(
            dispersion_header,
            dispersion_row,
            "line_width_hz",
            dispersion_line_width_override,
        )
    dispersion_rows = [] if omit_dispersion_rows else [dispersion_row]
    if duplicate_dispersion_row and dispersion_rows:
        dispersion_rows.append(dispersion_row)
    (root / "eigen" / "dispersion.csv").write_text(
        "\n".join([dispersion_header, *dispersion_rows])
    )

    mode = {
        "schema_version": "2",
        "solver_model": "reference_scalar_tangent",
        "sample_index": 0,
        "raw_mode_index": 0,
        "branch_id": 0,
        "frequency_hz": 1.0e9,
        "frequency_real_hz": 1.0e9,
        "frequency_imag_hz": 0.0,
        "angular_frequency_rad_per_s": 6.283185307179586e9,
        "eigenvalue_real": 0.0,
        "eigenvalue_imag": 6.283185307179586e9,
        "phasor_convention": "not_applicable_real_reference",
        "eigenvalue_mapping": (
            "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m"
        ),
        "normalization": "unit_l2",
        "damping_policy": "ignore",
        "mode_field_id": field_id,
        "mode_field_resource_key": field_resource,
        "residual_norm": 1.0e-9,
        "residual_absolute_l2": 1.0e-9,
        "residual_relative_l2": 1.0e-12,
        "residual_linf": 1.0e-10,
        "mass_norm": 1.0,
        "tangent_leakage_mean_abs": 0.0,
        "tangent_leakage_max_abs": 0.0,
        "dominant_polarization": "linear",
        "k_vector": [0.0, 0.0, 0.0],
        "omega_rad_s": 6.283185307179586e9,
        "gamma_rad_s_T": (
            gamma_rad_s_t_override
            if gamma_rad_s_t_override is not None
            else 1.759457895880903e11
        ),
        "gamma0_rad_s_per_A_m": 2.211e5,
        "mu0_T_m_per_A": 1.2566370614359173e-6,
        "value_kind": "complex_spatial_vector",
        "component_basis": "global_xyz",
        "component_count": 3,
        "components": ["x", "y", "z"],
        "storage_format": "zarr",
        "zarr_store_path": "eigen/mode_fields.zarr",
        "zarr_array_path": "eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex",
        "zarr_chunk_path": "eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex/0.0.0",
        "zarr_dtype": "<f8",
        "zarr_shape": [1, 3, 2],
        "zarr_chunk_shape": [1, 3, 2],
        "zarr_compressor": None,
        "compatibility_binary_payload_path": "eigen/mode_fields/sample_0000/mode_0000/vector.bin",
        "payload_encoding": "f64_interleaved_real_imag_xyz",
        "binary_layout": "complex_f64_pairs_little_endian",
        "complex_pair_count": (
            complex_pair_count_override
            if complex_pair_count_override is not None
            else 3
        ),
        "payload_value_count": 6,
        "available_views": (
            available_views_override
            if available_views_override is not None
            else [
                "complex",
                "real",
                "imag",
                "abs",
                "amplitude",
                "phase",
                "phase_rotated_real",
            ]
        ),
        "default_view": "phase_rotated_real",
        "default_phase_rad": 0.0,
        "mode_field_sample_count": 1,
        "amplitude_summary": {
            "sample_count": 1,
            "max": 1.0,
            "mean": 1.0,
        },
        "component_summary": {
            "real_sample_count": 1,
            "imag_sample_count": 1,
            "component_count": 3,
        },
    }
    if omit_mode_residual_relative_l2:
        del mode["residual_relative_l2"]
    if omit_mode_omega_rad_s:
        del mode["omega_rad_s"]
    if omit_mode_eigenvalue_mapping:
        del mode_summary["eigenvalue_mapping"]
        del mode["eigenvalue_mapping"]
    if omit_mode_tangent_leakage:
        del mode["tangent_leakage_mean_abs"]
    if omit_mode_payload_encoding:
        del mode["payload_encoding"]
    if inline_mode_vectors:
        mode["real"] = [[1.0, 0.0, 0.0]]
        mode["imag"] = [[0.0, 1.0, 0.0]]
        mode["amplitude"] = [1.0]
        mode["phase"] = [0.0]
    (root / "eigen" / "modes" / "sample_0000" / "mode_0000.json").write_text(
        json.dumps(mode)
    )
    summary = {
        "study_kind": "eigenmodes",
        "solver_backend": "cpu_baseline_fem_eigen",
        "solver_kind": "cpu_reference_symmetric",
        "mode_count": 1,
        "normalization": "unit_l2",
        "damping_policy": "ignore",
        "solver_diagnostics": {
            "dense_reference_oracle": True,
            "residual_definition": (
                "relative_residual = ||K u - lambda M u||_2 / "
                "(||K u||_2 + |lambda| * ||M u||_2)"
            ),
            "tangent_leakage_definition": (
                "abs(m0 dot delta_m) over reconstructed real and imaginary mode vectors"
            ),
            "constants": {
                "gamma_rad_s_T": (
                    gamma_rad_s_t_override
                    if gamma_rad_s_t_override is not None
                    else 1.759457895880903e11
                ),
                "gamma0_rad_s_per_A_m": 2.211e5,
                "mu0_T_m_per_A": 1.2566370614359173e-6,
            },
            "orthogonality": [
                {
                    "lhs_mode_index": 0,
                    "rhs_mode_index": 0,
                    "mass_inner_product": 1.0,
                }
            ],
        },
        "modes": [
            {
                "index": 0,
                "frequency_hz": 1.0e9,
                "frequency_real_hz": 1.0e9,
                "frequency_imag_hz": 0.0,
                "angular_frequency_rad_per_s": 6.283185307179586e9,
                "omega_rad_s": 6.283185307179586e9,
                "eigenvalue_real": 0.0,
                "eigenvalue_imag": 6.283185307179586e9,
                "phasor_convention": "not_applicable_real_reference",
                "eigenvalue_mapping": (
                    "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m"
                ),
                "norm": 1.0,
                "max_amplitude": 1.0,
                "residual_norm": 1.0e-9,
                "residual_absolute_l2": 1.0e-9,
                "residual_relative_l2": 1.0e-12,
                "residual_linf": 1.0e-10,
                "mass_norm": 1.0,
                "tangent_leakage_mean_abs": 0.0,
                "tangent_leakage_max_abs": 0.0,
                "gamma_rad_s_T": (
                    gamma_rad_s_t_override
                    if gamma_rad_s_t_override is not None
                    else 1.759457895880903e11
                ),
                "gamma0_rad_s_per_A_m": 2.211e5,
                "mu0_T_m_per_A": 1.2566370614359173e-6,
                "dominant_polarization": "linear",
                "k_vector": [0.0, 0.0, 0.0],
            }
        ],
    }
    (root / "eigen" / "metadata" / "eigen_summary.json").write_text(json.dumps(summary))
    (root / "eigen" / "mode_fields.zarr" / ".zgroup").write_text(
        json.dumps({"zarr_format": 2})
    )
    (root / "eigen" / "mode_fields.zarr" / ".zattrs").write_text(
        json.dumps(
            {
                "fullmag_kind": "frequency_domain_mode_field_store",
                "schema_version": 1,
                "preferred_container": (
                    zarr_root_preferred_container_override
                    if zarr_root_preferred_container_override is not None
                    else "zarr"
                ),
                "quantity_ids": ["delta_m"],
                "compatibility_binary_exports": True,
            }
        )
    )
    (root / "eigen" / "mode_fields.zarr" / "sample_0000" / ".zgroup").write_text(
        json.dumps({"zarr_format": 2})
    )
    (
        root
        / "eigen"
        / "mode_fields.zarr"
        / "sample_0000"
        / "mode_0000"
        / ".zgroup"
    ).write_text(json.dumps({"zarr_format": 2}))
    (zarr_array_dir / ".zarray").write_text(
        json.dumps(
            {
                "zarr_format": 2,
                "shape": [1, 3, 2],
                "chunks": [1, 3, 2],
                "dtype": "<f8",
                "compressor": None,
                "fill_value": 0.0,
                "order": "C",
                "filters": None,
                "dimension_separator": ".",
            }
        )
    )
    (zarr_array_dir / ".zattrs").write_text(
        json.dumps(
            {
                "quantity_id": (
                    zarr_quantity_id_override
                    if zarr_quantity_id_override is not None
                    else "delta_m"
                ),
                "unit": "1",
                "value_kind": "complex_spatial_vector",
                "component_basis": "global_xyz",
                "axes": ["spatial_sample", "component", "complex"],
                "component_order": ["x", "y", "z"],
                "complex_order": ["real", "imag"],
                "sample_index": 0,
                "raw_mode_index": 0,
                "mode_field_sample_count": 1,
                "storage_layout": "aos_xyz_complex_pairs",
            }
        )
    )
    (zarr_array_dir / "0.0.0").write_bytes(b"\0" * 48)
    (root / "eigen" / "mode_fields" / "sample_0000" / "mode_0000" / "vector.bin").write_bytes(
        b"\0" * payload_size
    )

    manifest = {
        "schema_version": "frequency_domain_manifest.v1",
        "analysis_family": "magnetic_frequency_domain",
        "study_product": "modal_eigen",
        "stage_kind": "eigenmodes",
        "status": "ready",
        "complete": True,
        "artifacts": {
            "solver_diagnostics_path": "eigen/diagnostics/solver.v1.json",
            "spectrum_v2_path": "eigen/spectrum.v2.json",
            "branches_v2_path": "eigen/branches.v2.json",
            "dispersion_csv_path": "eigen/dispersion.csv",
            "mode_field_zarr_store_path": "eigen/mode_fields.zarr",
            "mode_field_storage_format": "zarr",
            "mode_metadata_paths": ["eigen/modes/sample_0000/mode_0000.json"],
        },
        "resources": {
            "mode_field_resources": (
                manifest_mode_resources_override
                if manifest_mode_resources_override is not None
                else [meta_resource]
            ),
        },
        "diagnostics": {
            "tracking_score_source": "seed_only",
            "modal_overlap_available": False,
        },
        "physics": (
            manifest_physics_override
            if manifest_physics_override is not None
            else {
                "analysis_family": "magnetic_frequency_domain",
                "phase_convention": "exp_minus_i_omega_t",
                "frequency_units": "Hz",
                "field_units": "dimensionless_delta_m",
                "normalization": "unit_l2",
            }
        ),
    }
    (root / "frequency_domain" / "manifest.v1.json").write_text(json.dumps(manifest))
    (root / "eigen" / "diagnostics").mkdir(parents=True, exist_ok=True)
    solver_diagnostics = {
        "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
        "study_product": "modal_eigen",
        "status": "ready",
        "complete": True,
        "algebraic_form": "reference_effective_field_generalized",
        "matrix_equation": "K u = lambda M u",
        "phasor_convention": "not_applicable_real_reference",
        "eigenvalue_mapping": (
            "omega_rad_s = gamma0_rad_s_per_A_m * max(lambda_A_per_m, 0)"
        ),
        "frequency_mapping": "frequency_hz = omega_rad_s / (2*pi)",
        "production_gyrotropic_mapping": False,
        "solver_model": "dense_reference_oracle",
        "resolved_solver_family": "dense_reference_oracle",
        "spectral_transform": "none",
        "sample_count": 1,
        "mode_count": 1,
    }
    if solver_diagnostics_override is not None:
        solver_diagnostics.update(solver_diagnostics_override)
    (root / "eigen" / "diagnostics" / "solver.v1.json").write_text(
        json.dumps(solver_diagnostics)
    )


def run_validator(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(VALIDATOR), str(root), *args],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def test_validator_accepts_eigen_artifact_bundle(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_missing_spectrum_mode_field_resource_key(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path, omit_spectrum_mode_field_resource_key=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "mode.mode_field_resource_key" in (result.stderr + result.stdout)


def test_validator_rejects_manifest_mode_resource_mismatch(tmp_path: Path) -> None:
    write_eigen_fixture(
        tmp_path,
        manifest_mode_resources_override=[
            "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/0/9/meta"
        ],
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.resources.mode_field_resources" in (result.stderr + result.stdout)


def test_validator_rejects_invalid_mode_payload_size(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, payload_size=40)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "complex xyz" in (result.stderr + result.stdout)


def test_validator_rejects_inline_mode_vectors_in_metadata(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, inline_mode_vectors=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "must not inline vector arrays" in (result.stderr + result.stdout)


def test_validator_rejects_missing_mode_payload_encoding(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, omit_mode_payload_encoding=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "payload_encoding" in (result.stderr + result.stdout)


def test_validator_rejects_mode_available_view_drift(tmp_path: Path) -> None:
    write_eigen_fixture(
        tmp_path,
        available_views_override=["real", "imag", "phase_rotated_real"],
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "available_views" in (result.stderr + result.stdout)


def test_validator_rejects_mode_payload_count_drift(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, complex_pair_count_override=2)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "complex_pair_count" in (result.stderr + result.stdout)


def test_validator_rejects_frequency_alias_drift(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, frequency_hz_override=2.0e9)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "mode.frequency_hz" in (result.stderr + result.stdout)


def test_validator_rejects_branch_frequency_drift(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, branch_frequency_hz_override=2.0e9)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "branch point.frequency_hz" in (result.stderr + result.stdout)


def test_validator_rejects_dispersion_frequency_drift(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, dispersion_frequency_hz_override=2.0e9)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "dispersion row 0.frequency_hz" in (result.stderr + result.stdout)


def test_validator_rejects_missing_branch_tracking_score_source(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, omit_branch_tracking_source=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "tracking_score_source" in (result.stderr + result.stdout)


def test_validator_rejects_dispersion_missing_mode_field_handoff_columns(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path, omit_dispersion_mode_field_columns=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "eigen/dispersion.csv missing columns" in (result.stderr + result.stdout)
    assert "mode_field_id" in (result.stderr + result.stdout)


def test_validator_rejects_dispersion_missing_overlap_score_column(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path, omit_dispersion_overlap_score=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "eigen/dispersion.csv missing columns" in (result.stderr + result.stdout)
    assert "overlap_score" in (result.stderr + result.stdout)


def test_validator_rejects_dispersion_missing_required_display_columns(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path, omit_dispersion_required_display_columns=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "eigen/dispersion.csv missing columns" in (result.stderr + result.stdout)
    assert "label" in (result.stderr + result.stdout)
    assert "branch_id" in (result.stderr + result.stdout)
    assert "line_width_hz" in (result.stderr + result.stdout)


def test_validator_rejects_dispersion_branch_id_drift_from_branches(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path, dispersion_branch_id_override="7")

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "dispersion row 0.branch_id" in (result.stderr + result.stdout)


def test_validator_rejects_dispersion_tracking_source_drift_from_branch_point(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(
        tmp_path,
        dispersion_tracking_score_source_override="frequency_score_fallback",
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "dispersion row 0.tracking_score_source" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_dispersion_path_s_drift_from_spectrum(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path, dispersion_path_s_override="1.0")

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "dispersion row 0.path_s_rad_per_m" in (result.stderr + result.stdout)


def test_validator_rejects_dispersion_k_vector_drift_from_spectrum(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path, dispersion_kx_override="1.0")

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "dispersion row 0.kx_rad_per_m" in (result.stderr + result.stdout)


def test_validator_rejects_dispersion_label_drift_from_spectrum(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path, dispersion_label_override="X")

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "dispersion row 0.label" in (result.stderr + result.stdout)


def test_validator_rejects_duplicate_dispersion_mode_rows(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, duplicate_dispersion_row=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "duplicate dispersion row" in (result.stderr + result.stdout)


def test_validator_rejects_missing_dispersion_mode_rows(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, omit_dispersion_rows=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "missing dispersion rows" in (result.stderr + result.stdout)


def test_validator_rejects_modal_overlap_row_without_overlap_score(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(
        tmp_path,
        branch_tracking_score_source_override="modal_overlap_weighted_score",
        branch_modal_overlap_available_override=True,
        dispersion_tracking_score_source_override="modal_overlap_weighted_score",
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "dispersion row 0.overlap_score" in (result.stderr + result.stdout)


def test_validator_rejects_dispersion_overlap_score_outside_unit_interval(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path, dispersion_overlap_score_override="1.5")

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "dispersion row 0.overlap_score" in (result.stderr + result.stdout)


def test_validator_rejects_negative_exp_i_damping_frequency(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    mode_path = tmp_path / "eigen" / "modes" / "sample_0000" / "mode_0000.json"
    mode = json.loads(mode_path.read_text())
    mode["damping_policy"] = "include"
    mode["phasor_convention"] = "exp_i_omega_t"
    mode["frequency_imag_hz"] = -1.0e6
    mode["damping_rate_hz"] = -1.0e6
    mode["linewidth_fwhm_hz"] = -2.0e6
    mode_path.write_text(json.dumps(mode))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "frequency_imag_hz" in (result.stderr + result.stdout)


def test_validator_rejects_dispersion_linewidth_drift(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    spectrum_path = tmp_path / "eigen" / "spectrum.v2.json"
    spectrum = json.loads(spectrum_path.read_text())
    spectrum["samples"][0]["modes"][0]["frequency_imag_hz"] = 1.0e6
    spectrum_path.write_text(json.dumps(spectrum))
    dispersion_path = tmp_path / "eigen" / "dispersion.csv"
    dispersion_path.write_text(
        "\n".join(
            [
                "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score,tracking_score_source,mode_field_id,mode_field_resource_key",
                "0,0,0,0,0,G,0,0,1.0e9,6.283185307179586e9,1.0e6,1.0e-9,,seed,analysis:eigen:sample-0000:mode-0000,/v2/sessions/current/data/fields/analysis:eigen:sample-0000:mode-0000/samples/vector?view=phase_rotated_real&phase_rad=0",
            ]
        )
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "line_width_hz" in (result.stderr + result.stdout)


def test_validator_rejects_missing_positive_damping_dispersion_linewidth(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path, dispersion_line_width_override="")
    spectrum_path = tmp_path / "eigen" / "spectrum.v2.json"
    spectrum = json.loads(spectrum_path.read_text())
    spectrum["samples"][0]["modes"][0]["frequency_imag_hz"] = 1.0e6
    spectrum_path.write_text(json.dumps(spectrum))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "line_width_hz" in (result.stderr + result.stdout)


def test_validator_rejects_mode_zarr_quantity_drift(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, zarr_quantity_id_override="m")

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "mode 0/0.zattrs.quantity_id" in (result.stderr + result.stdout)


def test_validator_rejects_mode_zarr_root_container_drift(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, zarr_root_preferred_container_override="json")

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "mode_fields.zarr/.zattrs.preferred_container" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_mode_payload_byte_count_mismatch(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, payload_size=96)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "payload_value_count" in (result.stderr + result.stdout)


def test_validator_rejects_missing_residual_relative_l2(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, omit_mode_residual_relative_l2=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "residual_relative_l2" in (result.stderr + result.stdout)


def test_validator_rejects_missing_omega_rad_s(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, omit_mode_omega_rad_s=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "omega_rad_s" in (result.stderr + result.stdout)


def test_validator_rejects_missing_mode_eigenvalue_mapping(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, omit_mode_eigenvalue_mapping=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "eigenvalue_mapping" in (result.stderr + result.stdout)


def test_validator_rejects_missing_solver_algebraic_form(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    diagnostics_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text())
    del diagnostics["algebraic_form"]
    diagnostics_path.write_text(json.dumps(diagnostics))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "solver_diagnostics.algebraic_form" in (result.stderr + result.stdout)


def test_validator_rejects_missing_tangent_leakage(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, omit_mode_tangent_leakage=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "tangent_leakage_mean_abs" in (result.stderr + result.stdout)


def test_validator_rejects_gamma_constant_unit_drift(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, gamma_rad_s_t_override=2.778981146586646e-1)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "gamma0_rad_s_per_A_m" in (result.stderr + result.stdout)


def test_validator_rejects_window_completeness_without_subwindows(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(
        tmp_path,
        solver_diagnostics_override={
            "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
            "study_product": "modal_eigen",
            "status": "ready",
            "complete": True,
            "solver_model": "shift_invert",
            "resolved_solver_family": "shift_invert",
            "spectral_transform": "shift_invert",
            "sample_count": 1,
            "mode_count": 1,
            "requested_mode_count": 1,
            "requested_window_hz": [1.0e8, 5.0e9],
            "resolved_search_window_hz": [7.5e7, 5.125e9],
            "window_completeness": {
                "policy": "best_effort",
                "status": "not_certified",
                "certification_method": "none",
                "additional_modes_may_exist": True,
            },
        },
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "solver_diagnostics.subwindows" in (result.stderr + result.stdout)


def test_validator_rejects_frequency_window_without_requested_mode_count(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(
        tmp_path,
        solver_diagnostics_override={
            "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
            "study_product": "modal_eigen",
            "status": "ready",
            "complete": True,
            "solver_model": "shift_invert",
            "resolved_solver_family": "shift_invert",
            "spectral_transform": "shift_invert",
            "sample_count": 1,
            "mode_count": 1,
            "requested_window_hz": [1.0e8, 5.0e9],
            "resolved_search_window_hz": [7.5e7, 5.125e9],
            "window_completeness": {
                "policy": "best_effort",
                "status": "not_certified",
                "certification_method": "none",
                "estimated_modes_in_window": 1,
                "certified_modes_in_window": 0,
                "additional_modes_may_exist": True,
            },
            "subwindows": [
                {
                    "index": 0,
                    "requested_hz": [1.0e8, 5.0e9],
                    "search_hz": [7.5e7, 5.125e9],
                    "shift_hz": 2.55e9,
                    "shift_frequency_hz": 2.55e9,
                    "shift_omega_rad_s": 16022122533.30759,
                    "outer_iterations": 1,
                    "linear_iterations_total": 3,
                    "candidate_modes": 2,
                    "accepted_modes": 1,
                    "residual_max": 1.0e-9,
                    "stop_reason": "converged",
                }
            ],
        },
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "solver_diagnostics.requested_mode_count" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_solver_mode_count_that_exceeds_published_modes(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(
        tmp_path,
        solver_diagnostics_override={
            "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
            "study_product": "modal_eigen",
            "status": "ready",
            "complete": True,
            "solver_model": "shift_invert",
            "resolved_solver_family": "shift_invert",
            "spectral_transform": "shift_invert",
            "sample_count": 1,
            "mode_count": 2,
            "requested_mode_count": 2,
            "requested_window_hz": [1.0e8, 5.0e9],
            "resolved_search_window_hz": [7.5e7, 5.125e9],
            "window_completeness": {
                "policy": "best_effort",
                "status": "not_certified",
                "certification_method": "none",
                "estimated_modes_in_window": 1,
                "certified_modes_in_window": 0,
                "additional_modes_may_exist": True,
            },
            "subwindows": [
                {
                    "index": 0,
                    "requested_hz": [1.0e8, 5.0e9],
                    "search_hz": [7.5e7, 5.125e9],
                    "shift_hz": 2.55e9,
                    "shift_frequency_hz": 2.55e9,
                    "shift_omega_rad_s": 16022122533.30759,
                    "outer_iterations": 1,
                    "linear_iterations_total": 3,
                    "candidate_modes": 2,
                    "accepted_modes": 1,
                    "residual_max": 1.0e-9,
                    "stop_reason": "converged",
                }
            ],
        },
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "solver_diagnostics.mode_count" in (result.stderr + result.stdout)


def test_validator_rejects_truncated_window_below_requested_mode_count(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(
        tmp_path,
        solver_diagnostics_override={
            "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
            "study_product": "modal_eigen",
            "status": "ready",
            "complete": True,
            "solver_model": "shift_invert",
            "resolved_solver_family": "shift_invert",
            "spectral_transform": "shift_invert",
            "sample_count": 1,
            "mode_count": 1,
            "requested_mode_count": 2,
            "requested_window_hz": [1.0e8, 5.0e9],
            "resolved_search_window_hz": [7.5e7, 5.125e9],
            "window_completeness": {
                "policy": "best_effort",
                "status": "truncated_by_requested_count",
                "certification_method": "mode_cap",
                "estimated_modes_in_window": 1,
                "certified_modes_in_window": 0,
                "additional_modes_may_exist": True,
            },
            "subwindows": [
                {
                    "index": 0,
                    "requested_hz": [1.0e8, 5.0e9],
                    "search_hz": [7.5e7, 5.125e9],
                    "shift_hz": 2.55e9,
                    "shift_frequency_hz": 2.55e9,
                    "shift_omega_rad_s": 16022122533.30759,
                    "outer_iterations": 1,
                    "linear_iterations_total": 3,
                    "candidate_modes": 2,
                    "accepted_modes": 1,
                    "residual_max": 1.0e-9,
                    "stop_reason": "converged",
                }
            ],
        },
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "truncated_by_requested_count" in (result.stderr + result.stdout)


def test_validator_rejects_truncated_window_without_possible_extra_modes(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(
        tmp_path,
        solver_diagnostics_override={
            "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
            "study_product": "modal_eigen",
            "status": "ready",
            "complete": True,
            "solver_model": "shift_invert",
            "resolved_solver_family": "shift_invert",
            "spectral_transform": "shift_invert",
            "sample_count": 1,
            "mode_count": 2,
            "requested_mode_count": 2,
            "requested_window_hz": [1.0e8, 5.0e9],
            "resolved_search_window_hz": [7.5e7, 5.125e9],
            "window_completeness": {
                "policy": "best_effort",
                "status": "truncated_by_requested_count",
                "certification_method": "mode_cap",
                "estimated_modes_in_window": 2,
                "certified_modes_in_window": 0,
                "additional_modes_may_exist": False,
            },
            "subwindows": [
                {
                    "index": 0,
                    "requested_hz": [1.0e8, 5.0e9],
                    "search_hz": [7.5e7, 5.125e9],
                    "shift_hz": 2.55e9,
                    "shift_frequency_hz": 2.55e9,
                    "shift_omega_rad_s": 16022122533.30759,
                    "outer_iterations": 1,
                    "linear_iterations_total": 3,
                    "candidate_modes": 2,
                    "accepted_modes": 2,
                    "residual_max": 1.0e-9,
                    "stop_reason": "converged",
                }
            ],
        },
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "additional_modes_may_exist" in (result.stderr + result.stdout)


def test_validator_requires_production_shift_invert_provenance_when_requested(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)

    result = run_validator(tmp_path, "--require-production-shift-invert-window")

    assert result.returncode != 0
    assert "solver_diagnostics.solver_model" in (result.stderr + result.stdout)


def test_validator_accepts_production_shift_invert_window_provenance(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(
        tmp_path,
        solver_diagnostics_override={
            "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
            "study_product": "modal_eigen",
            "status": "ready",
            "complete": True,
            "solver_model": "slepc_multi_shift_invert_production_cpu_dense",
            "solver_family": "slepc_multi_shift_invert_production_cpu_dense",
            "resolved_solver_family": "shift_invert",
            "spectral_transform": "shift_invert",
            "solver_adapter": "slepc_modal_eigen",
            "execution_lane": "production_cpu",
            "production_solver_available": True,
            "dense_reference_oracle": False,
            "sample_count": 1,
            "mode_count": 1,
            "requested_mode_count": 1,
            "requested_window_hz": [1.0e8, 5.0e9],
            "resolved_search_window_hz": [7.5e7, 5.125e9],
            "window_completeness": {
                "policy": "best_effort",
                "status": "not_certified",
                "certification_method": "none",
                "estimated_modes_in_window": 1,
                "certified_modes_in_window": 0,
                "additional_modes_may_exist": True,
            },
            "subwindows": [
                {
                    "index": 0,
                    "requested_hz": [1.0e8, 5.0e9],
                    "search_hz": [7.5e7, 5.125e9],
                    "shift_hz": 2.55e9,
                    "shift_frequency_hz": 2.55e9,
                    "shift_omega_rad_s": 16022122533.30759,
                    "outer_iterations": 1,
                    "linear_iterations_total": 3,
                    "candidate_modes": 2,
                    "accepted_modes": 1,
                    "residual_max": 1.0e-9,
                    "stop_reason": "converged",
                }
            ],
        },
    )

    result = run_validator(tmp_path, "--require-production-shift-invert-window")

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_requires_reference_full_2x2_floquet_when_requested(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "solver_diagnostics.solver_model" in (result.stderr + result.stdout)


def test_validator_accepts_reference_full_2x2_floquet_when_requested(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(
        tmp_path,
        solver_diagnostics_override={
            "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
            "study_product": "modal_eigen",
            "status": "ready",
            "complete": True,
            "solver_model": "reference_full_2x2_tangent",
            "resolved_solver_family": "reference_full_2x2_tangent",
            "spectral_transform": "none",
            "solver_notes": [
                "1 sample(s) generated from k_sampling",
                "cpu_full_2x2_phase_reduced_floquet",
            ],
            "basis_transport_policy": "tangent_frame_transport",
            "floquet_tangent_frame_max_mismatch": 0.0,
            "floquet_tangent_transport_max_nonunitarity": 0.0,
            "sample_count": 1,
            "mode_count": 1,
        },
    )
    mode_path = tmp_path / "eigen" / "modes" / "sample_0000" / "mode_0000.json"
    mode = json.loads(mode_path.read_text())
    mode["solver_model"] = "cpu_full_2x2_phase_reduced_floquet"
    mode_path.write_text(json.dumps(mode))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_reference_full_2x2_floquet_window_without_reference_policy(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(
        tmp_path,
        solver_diagnostics_override={
            "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
            "study_product": "modal_eigen",
            "status": "ready",
            "complete": True,
            "solver_model": "reference_full_2x2_tangent",
            "resolved_solver_family": "reference_full_2x2_tangent",
            "spectral_transform": "none",
            "solver_notes": [
                "3 sample(s) generated from k_sampling",
                "cpu_full_2x2_phase_reduced_floquet",
            ],
            "basis_transport_policy": "tangent_frame_transport",
            "floquet_tangent_frame_max_mismatch": 0.0,
            "floquet_tangent_transport_max_nonunitarity": 0.0,
            "sample_count": 3,
            "mode_count": 1,
            "requested_mode_count": 1,
            "requested_window_hz": [1.0, 1.0e13],
            "resolved_search_window_hz": [0.0, 1.125e13],
            "window_completeness": {
                "policy": "best_effort",
                "status": "not_certified",
                "certification_method": "none",
                "estimated_modes_in_window": 1,
                "certified_modes_in_window": 0,
                "additional_modes_may_exist": True,
            },
            "subwindows": [
                {
                    "index": 0,
                    "requested_hz": [1.0, 1.0e13],
                    "search_hz": [0.0, 1.125e13],
                    "shift_hz": 5.0e12,
                    "shift_frequency_hz": 5.0e12,
                    "shift_omega_rad_s": 3.141592653589793e13,
                    "outer_iterations": 0,
                    "linear_iterations_total": 0,
                    "candidate_modes": 1,
                    "accepted_modes": 1,
                    "residual_max": 0.0,
                    "stop_reason": "window_exhausted",
                }
            ],
        },
    )
    mode_path = tmp_path / "eigen" / "modes" / "sample_0000" / "mode_0000.json"
    mode = json.loads(mode_path.read_text())
    mode["solver_model"] = "cpu_full_2x2_phase_reduced_floquet"
    mode_path.write_text(json.dumps(mode))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "frequency_window_solver_policy" in (result.stderr + result.stdout)


def test_validator_accepts_reference_full_2x2_floquet_window_with_reference_policy(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(
        tmp_path,
        solver_diagnostics_override={
            "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
            "study_product": "modal_eigen",
            "status": "ready",
            "complete": True,
            "solver_model": "reference_full_2x2_tangent",
            "resolved_solver_family": "reference_full_2x2_tangent",
            "spectral_transform": "none",
            "solver_notes": [
                "3 sample(s) generated from k_sampling",
                "cpu_full_2x2_phase_reduced_floquet",
            ],
            "basis_transport_policy": "tangent_frame_transport",
            "floquet_tangent_frame_max_mismatch": 0.0,
            "floquet_tangent_transport_max_nonunitarity": 0.0,
            "sample_count": 3,
            "mode_count": 1,
            "production_solver_available": False,
            "frequency_window_solver_policy": (
                "reference_k_path_window_filter_not_shift_invert_or_feast"
            ),
            "requested_window_hz": [1.0, 1.0e13],
            "requested_mode_count": 1,
            "resolved_search_window_hz": [0.0, 1.125e13],
            "window_completeness": {
                "policy": "best_effort",
                "status": "not_certified",
                "certification_method": "none",
                "estimated_modes_in_window": 1,
                "certified_modes_in_window": 0,
                "additional_modes_may_exist": True,
            },
            "subwindows": [
                {
                    "index": 0,
                    "requested_hz": [1.0, 1.0e13],
                    "search_hz": [0.0, 1.125e13],
                    "shift_hz": 5.0e12,
                    "shift_frequency_hz": 5.0e12,
                    "shift_omega_rad_s": 3.141592653589793e13,
                    "outer_iterations": 0,
                    "linear_iterations_total": 0,
                    "candidate_modes": 1,
                    "accepted_modes": 1,
                    "residual_max": 0.0,
                    "stop_reason": "window_exhausted",
                }
            ],
        },
    )
    mode_path = tmp_path / "eigen" / "modes" / "sample_0000" / "mode_0000.json"
    mode = json.loads(mode_path.read_text())
    mode["solver_model"] = "cpu_full_2x2_phase_reduced_floquet"
    mode_path.write_text(json.dumps(mode))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_reference_k_path_when_production_modal_k_path_required(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(
        tmp_path,
        solver_diagnostics_override={
            "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
            "study_product": "modal_eigen",
            "status": "ready",
            "complete": True,
            "solver_model": "reference_full_2x2_tangent",
            "resolved_solver_family": "reference_full_2x2_tangent",
            "spectral_transform": "none",
            "solver_notes": [
                "3 sample(s) generated from k_sampling",
                "cpu_full_2x2_phase_reduced_floquet",
            ],
            "basis_transport_policy": "tangent_frame_transport",
            "floquet_tangent_frame_max_mismatch": 0.0,
            "floquet_tangent_transport_max_nonunitarity": 0.0,
            "sample_count": 3,
            "mode_count": 1,
            "production_solver_available": False,
            "frequency_window_solver_policy": (
                "reference_k_path_window_filter_not_shift_invert_or_feast"
            ),
            "requested_window_hz": [1.0, 1.0e13],
            "requested_mode_count": 1,
            "resolved_search_window_hz": [0.0, 1.125e13],
            "window_completeness": {
                "policy": "best_effort",
                "status": "not_certified",
                "certification_method": "none",
                "estimated_modes_in_window": 1,
                "certified_modes_in_window": 0,
                "additional_modes_may_exist": True,
            },
            "subwindows": [
                {
                    "index": 0,
                    "requested_hz": [1.0, 1.0e13],
                    "search_hz": [0.0, 1.125e13],
                    "shift_hz": 5.0e12,
                    "shift_frequency_hz": 5.0e12,
                    "shift_omega_rad_s": 3.141592653589793e13,
                    "outer_iterations": 0,
                    "linear_iterations_total": 0,
                    "candidate_modes": 1,
                    "accepted_modes": 1,
                    "residual_max": 0.0,
                    "stop_reason": "window_exhausted",
                }
            ],
        },
    )

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "production modal k-path" in (result.stderr + result.stdout)


def test_validator_accepts_production_modal_k_path_provenance(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(
        tmp_path,
        solver_diagnostics_override={
            "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
            "study_product": "modal_eigen",
            "status": "ready",
            "complete": True,
            "algebraic_form": "gyrotropic_generalized",
            "matrix_equation": "A q = lambda B q",
            "phasor_convention": "exp_i_omega_t",
            "eigenvalue_mapping": "lambda_eq_i_omega",
            "production_gyrotropic_mapping": True,
            "solver_model": "slepc_multi_shift_invert_production_cpu_dense",
            "solver_family": "slepc_multi_shift_invert_production_cpu_dense",
            "resolved_solver_family": "shift_invert",
            "spectral_transform": "shift_invert",
            "solver_adapter": "slepc_modal_eigen",
            "execution_lane": "production_cpu",
            "production_solver_available": True,
            "dense_reference_oracle": False,
            "sample_count": 3,
            "mode_count": 1,
            "requested_mode_count": 1,
            "requested_window_hz": [1.0, 1.0e13],
            "resolved_search_window_hz": [0.0, 1.125e13],
            "window_completeness": {
                "policy": "best_effort",
                "status": "not_certified",
                "certification_method": "none",
                "estimated_modes_in_window": 1,
                "certified_modes_in_window": 0,
                "additional_modes_may_exist": True,
            },
            "subwindows": [
                {
                    "index": 0,
                    "requested_hz": [1.0, 1.0e13],
                    "search_hz": [0.0, 1.125e13],
                    "shift_hz": 5.0e12,
                    "shift_frequency_hz": 5.0e12,
                    "shift_omega_rad_s": 3.141592653589793e13,
                    "outer_iterations": 1,
                    "linear_iterations_total": 3,
                    "candidate_modes": 2,
                    "accepted_modes": 1,
                    "residual_max": 1.0e-9,
                    "stop_reason": "converged",
                }
            ],
        },
        manifest_physics_override={
            "analysis_family": "magnetic_frequency_domain",
            "phase_convention": "exp_i_omega_t",
            "frequency_units": "Hz",
            "field_units": "dimensionless_delta_m",
            "normalization": "unit_l2",
        },
    )

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_production_modal_k_path_wrong_phasor_convention(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(
        tmp_path,
        solver_diagnostics_override={
            "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
            "study_product": "modal_eigen",
            "status": "ready",
            "complete": True,
            "algebraic_form": "gyrotropic_generalized",
            "matrix_equation": "A q = lambda B q",
            "phasor_convention": "exp_minus_i_omega_t",
            "eigenvalue_mapping": "lambda_eq_i_omega",
            "production_gyrotropic_mapping": True,
            "solver_model": "slepc_multi_shift_invert_production_cpu_dense",
            "solver_family": "slepc_multi_shift_invert_production_cpu_dense",
            "resolved_solver_family": "shift_invert",
            "spectral_transform": "shift_invert",
            "solver_adapter": "slepc_modal_eigen",
            "execution_lane": "production_cpu",
            "production_solver_available": True,
            "dense_reference_oracle": False,
            "sample_count": 3,
            "mode_count": 1,
            "requested_mode_count": 1,
            "requested_window_hz": [1.0, 1.0e13],
            "resolved_search_window_hz": [0.0, 1.125e13],
            "window_completeness": {
                "policy": "best_effort",
                "status": "not_certified",
                "certification_method": "none",
                "estimated_modes_in_window": 1,
                "certified_modes_in_window": 0,
                "additional_modes_may_exist": True,
            },
            "subwindows": [
                {
                    "index": 0,
                    "requested_hz": [1.0, 1.0e13],
                    "search_hz": [0.0, 1.125e13],
                    "shift_hz": 5.0e12,
                    "shift_frequency_hz": 5.0e12,
                    "shift_omega_rad_s": 3.141592653589793e13,
                    "outer_iterations": 1,
                    "linear_iterations_total": 3,
                    "candidate_modes": 2,
                    "accepted_modes": 1,
                    "residual_max": 1.0e-9,
                    "stop_reason": "converged",
                }
            ],
        },
    )

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "solver_diagnostics.phasor_convention" in (result.stderr + result.stdout)


def test_validator_rejects_production_modal_k_path_manifest_phasor_mismatch(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(
        tmp_path,
        solver_diagnostics_override={
            "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
            "study_product": "modal_eigen",
            "status": "ready",
            "complete": True,
            "algebraic_form": "gyrotropic_generalized",
            "matrix_equation": "A q = lambda B q",
            "phasor_convention": "exp_i_omega_t",
            "eigenvalue_mapping": "lambda_eq_i_omega",
            "production_gyrotropic_mapping": True,
            "solver_model": "slepc_multi_shift_invert_production_cpu_dense",
            "solver_family": "slepc_multi_shift_invert_production_cpu_dense",
            "resolved_solver_family": "shift_invert",
            "spectral_transform": "shift_invert",
            "solver_adapter": "slepc_modal_eigen",
            "execution_lane": "production_cpu",
            "production_solver_available": True,
            "dense_reference_oracle": False,
            "sample_count": 3,
            "mode_count": 1,
            "requested_mode_count": 1,
            "requested_window_hz": [1.0, 1.0e13],
            "resolved_search_window_hz": [0.0, 1.125e13],
            "window_completeness": {
                "policy": "best_effort",
                "status": "not_certified",
                "certification_method": "none",
                "estimated_modes_in_window": 1,
                "certified_modes_in_window": 0,
                "additional_modes_may_exist": True,
            },
            "subwindows": [
                {
                    "index": 0,
                    "requested_hz": [1.0, 1.0e13],
                    "search_hz": [0.0, 1.125e13],
                    "shift_hz": 5.0e12,
                    "shift_frequency_hz": 5.0e12,
                    "shift_omega_rad_s": 3.141592653589793e13,
                    "outer_iterations": 1,
                    "linear_iterations_total": 3,
                    "candidate_modes": 2,
                    "accepted_modes": 1,
                    "residual_max": 1.0e-9,
                    "stop_reason": "converged",
                }
            ],
        },
    )

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.physics.phase_convention" in (result.stderr + result.stdout)


def test_validator_rejects_reference_full_2x2_floquet_without_transport_policy(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(
        tmp_path,
        solver_diagnostics_override={
            "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
            "study_product": "modal_eigen",
            "status": "ready",
            "complete": True,
            "solver_model": "reference_full_2x2_tangent",
            "resolved_solver_family": "reference_full_2x2_tangent",
            "spectral_transform": "none",
            "solver_notes": [
                "1 sample(s) generated from k_sampling",
                "cpu_full_2x2_phase_reduced_floquet",
            ],
            "sample_count": 1,
            "mode_count": 1,
        },
    )
    mode_path = tmp_path / "eigen" / "modes" / "sample_0000" / "mode_0000.json"
    mode = json.loads(mode_path.read_text())
    mode["solver_model"] = "cpu_full_2x2_phase_reduced_floquet"
    mode_path.write_text(json.dumps(mode))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "solver_diagnostics.basis_transport_policy" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_window_mode_outside_requested_range(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(
        tmp_path,
        solver_diagnostics_override={
            "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
            "study_product": "modal_eigen",
            "status": "ready",
            "complete": True,
            "solver_model": "slepc_multi_shift_invert_production_cpu_dense",
            "solver_family": "slepc_multi_shift_invert_production_cpu_dense",
            "resolved_solver_family": "shift_invert",
            "spectral_transform": "shift_invert",
            "solver_adapter": "slepc_modal_eigen",
            "execution_lane": "production_cpu",
            "production_solver_available": True,
            "dense_reference_oracle": False,
            "sample_count": 1,
            "mode_count": 1,
            "requested_mode_count": 1,
            "requested_window_hz": [2.0e9, 3.0e9],
            "resolved_search_window_hz": [1.9e9, 3.1e9],
            "window_completeness": {
                "policy": "best_effort",
                "status": "not_certified",
                "certification_method": "none",
                "estimated_modes_in_window": 1,
                "certified_modes_in_window": 0,
                "additional_modes_may_exist": True,
            },
            "subwindows": [
                {
                    "index": 0,
                    "requested_hz": [2.0e9, 3.0e9],
                    "search_hz": [1.9e9, 3.1e9],
                    "shift_hz": 2.5e9,
                    "shift_frequency_hz": 2.5e9,
                    "shift_omega_rad_s": 15707963267.948966,
                    "outer_iterations": 1,
                    "linear_iterations_total": 3,
                    "candidate_modes": 2,
                    "accepted_modes": 1,
                    "residual_max": 1.0e-9,
                    "stop_reason": "converged",
                }
            ],
        },
    )

    result = run_validator(tmp_path, "--require-production-shift-invert-window")

    assert result.returncode != 0
    assert "requested_window_hz" in (result.stderr + result.stdout)


def test_validator_accepts_exp_i_omega_t_phase_convention(tmp_path: Path) -> None:
    write_eigen_fixture(
        tmp_path,
        manifest_physics_override={
            "analysis_family": "magnetic_frequency_domain",
            "phase_convention": "exp_i_omega_t",
            "frequency_units": "Hz",
            "field_units": "dimensionless_delta_m",
            "normalization": "unit_l2",
        },
    )

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_missing_manifest_physics(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path, manifest_physics_override=None)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    del manifest["physics"]
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.physics" in (result.stderr + result.stdout)


def test_validator_rejects_unknown_phase_convention(tmp_path: Path) -> None:
    write_eigen_fixture(
        tmp_path,
        manifest_physics_override={
            "analysis_family": "magnetic_frequency_domain",
            "phase_convention": "exp_plus_i_k_dot_r",
            "frequency_units": "Hz",
            "field_units": "dimensionless_delta_m",
            "normalization": "unit_l2",
        },
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.physics.phase_convention" in (result.stderr + result.stdout)


def test_validator_rejects_mode_field_unit_drift(tmp_path: Path) -> None:
    write_eigen_fixture(
        tmp_path,
        manifest_physics_override={
            "analysis_family": "magnetic_frequency_domain",
            "phase_convention": "exp_minus_i_omega_t",
            "frequency_units": "Hz",
            "field_units": "A_per_m",
            "normalization": "unit_l2",
        },
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.physics.field_units" in (result.stderr + result.stdout)
