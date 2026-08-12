#!/usr/bin/env python3
"""Unit tests for FEM frequency-domain modal eigen artifact validation."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_fem_frequency_domain_eigen_artifacts.py"
MU0 = 1.2566370614359173e-6
EIGEN_SUMMARY_SPECTRUM_SYNC_FIELDS = [
    "phasor_convention",
    "eigenvalue_mapping",
    "eigenvalue_real",
    "eigenvalue_imag",
    "frequency_hz",
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
    "relax_to_eigen_handoff_sha256",
    "source_mesh_topology_sha256",
]

RELAX_TO_EIGEN_HANDOFF_SHA256 = "sha256:" + "f" * 64
SOURCE_MESH_TOPOLOGY_SHA256 = "sha256:" + "a" * 64


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


def sync_eigen_summary_mode_from_spectrum(root: Path) -> None:
    spectrum = json.loads((root / "eigen" / "spectrum.v2.json").read_text())
    summary_path = root / "eigen" / "metadata" / "eigen_summary.json"
    summary = json.loads(summary_path.read_text())
    spectrum_mode = spectrum["samples"][0]["modes"][0]
    summary_mode = summary["modes"][0]
    for field_name in EIGEN_SUMMARY_SPECTRUM_SYNC_FIELDS:
        if field_name in spectrum_mode:
            summary_mode[field_name] = spectrum_mode[field_name]
    summary_path.write_text(json.dumps(summary))


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
        "relax_to_eigen_handoff_sha256": RELAX_TO_EIGEN_HANDOFF_SHA256,
        "source_mesh_topology_sha256": SOURCE_MESH_TOPOLOGY_SHA256,
    }
    if omit_spectrum_mode_field_resource_key:
        del mode_summary["mode_field_resource_key"]
    spectrum = {
        "schema_version": "eigen_spectrum.v2",
        "solver_model": "reference_scalar_tangent",
        "sample_count": 1,
        "mode_count": 1,
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
        "relax_to_eigen_handoff_sha256": RELAX_TO_EIGEN_HANDOFF_SHA256,
        "source_mesh_topology_sha256": SOURCE_MESH_TOPOLOGY_SHA256,
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
        "source_mesh_identity": {
            "mesh_id": "mesh:test",
            "mesh_generation_id": "mesh-generation:test",
            "mesh_revision": 17,
            "topology_fingerprint": SOURCE_MESH_TOPOLOGY_SHA256,
            "indexing": "full_domain_node_order",
            "node_count": 1,
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
            "relax_to_eigen_handoff_sha256": RELAX_TO_EIGEN_HANDOFF_SHA256,
            "source_mesh_topology_sha256": SOURCE_MESH_TOPOLOGY_SHA256,
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
                "relax_to_eigen_handoff_sha256": RELAX_TO_EIGEN_HANDOFF_SHA256,
                "source_mesh_topology_sha256": SOURCE_MESH_TOPOLOGY_SHA256,
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
        "capabilities": {
            "production_native_solver_available": False,
            "validation_artifact": True,
            "dispersion": reference_dispersion_capabilities(),
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


def sha256_file_token(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def typed_artifact_self_digest(payload: dict[str, object]) -> str:
    normalized = dict(payload)
    normalized["revision"] = ""
    normalized["content_sha256"] = ""

    def encode(value: object) -> str:
        if value is None:
            return "null"
        if value is True:
            return "true"
        if value is False:
            return "false"
        if isinstance(value, int):
            return str(value)
        if isinstance(value, float):
            rendered = repr(value)
            if "e" in rendered:
                mantissa, exponent = rendered.split("e", 1)
                sign = ""
                if exponent[0] in "+-":
                    sign, exponent = exponent[0], exponent[1:]
                rendered = f"{mantissa}e{sign}{int(exponent)}"
            return rendered
        if isinstance(value, str):
            return json.dumps(value, ensure_ascii=False)
        if isinstance(value, list):
            return "[" + ",".join(encode(entry) for entry in value) + "]"
        assert isinstance(value, dict)
        return "{" + ",".join(
            f"{json.dumps(key, ensure_ascii=False)}:{encode(value[key])}"
            for key in sorted(value)
        ) + "}"

    return "sha256:" + hashlib.sha256(encode(normalized).encode()).hexdigest()


def write_typed_field_sweep_fixture(root: Path) -> dict[str, object]:
    """Publish the smallest complete A1S modal field-sweep envelope.

    The source revisions deliberately hash the bytes already published by the
    core bundle.  This helper is used by negative tests so the ordinary
    fixture stays a legacy/core bundle unless it explicitly opts into the
    A1S discovery path.
    """
    spectrum_path = root / "eigen" / "spectrum.v2.json"
    branches_path = root / "eigen" / "branches.v2.json"
    spectrum_revision = sha256_file_token(spectrum_path)
    branches_revision = sha256_file_token(branches_path)
    topology = {
        "mesh_id": "mesh:test",
        "topology_revision": "mesh-rev:1",
        "indexing": "sample_index_then_raw_mode_index",
        "sample_axis": "sample_id",
        "mode_axis": "mode_id",
        "node_count": 1,
    }
    execution = {
        "backend": "fem",
        "device": "cpu",
        "precision": "float64",
        "execution_mode": "modal",
        "engine": "test",
        "implementation_id": "fixture",
        "status": "completed",
        "fallback_used": False,
        "fallback_reason": None,
    }
    field_id = "analysis:eigen:sample-0000:mode-0000"
    payload: dict[str, object] = {
        "schema_version": "eigen/field_sweep.v1",
        "artifact_id": "analysis:eigen:field-sweep",
        "source": {
            "kind": "modal_eigensolve",
            "artifact": "eigen/spectrum.v2.json",
            "revision": spectrum_revision,
        },
        "source_revision": spectrum_revision,
        "run_id": "run:current",
        "stage_id": "stage:eigenmodes",
        "scope_id": "scope:bias-field",
        "runtime_id": "runtime:test",
        "revision": "sha256:" + "0" * 64,
        "content_sha256": "sha256:" + "0" * 64,
        "status": "complete",
        "complete": True,
        "interrupted": False,
        "stop_reason": None,
        "requested_sample_count": 1,
        "completed_sample_count": 1,
        "scan_axis": {
            "kind": "bias_field",
            "coordinate": "bias_field_a_per_m",
            "unit": "A/m",
            "display_conversions": [
                {"name": "mu0_h", "unit": "T", "scale": MU0}
            ],
        },
        "units": {
            "frequency": "Hz",
            "angular_frequency": "rad/s",
            "bias_field": "A/m",
            "bias_field_display": "mu0 H (T)",
            "response_amplitude": None,
            "linewidth": None,
            "q_factor": None,
            "covariance": None,
        },
        "topology": topology,
        "requested_execution": execution,
        "resolved_execution": execution,
        "samples": [
            {
                "sample_id": "bias-field-sample-0000",
                "sample_index": 0,
                "scan_axis": {
                    "kind": "bias_field",
                    "coordinate": "bias_field_a_per_m",
                    "unit": "A/m",
                    "display_conversions": [
                        {"name": "mu0_h", "unit": "T", "scale": MU0}
                    ],
                },
                "bias_field_a_per_m": [40000.0, 0.0, 0.0],
                "bias_field_mu0_t": [40000.0 * MU0, 0.0, 0.0],
                "equilibrium_artifact_sha256": "sha256:" + "1" * 64,
                "linearization_state_sha256": "sha256:" + "2" * 64,
                "operator_input_signature_sha256": "sha256:" + "3" * 64,
                "topology": topology,
                "branch_ids": [0],
                "modes": [
                    {
                        "sample_id": "bias-field-sample-0000",
                        "mode_id": "sample-0000/mode-0000",
                        "raw_mode_index": 0,
                        "branch_id": 0,
                        "frequency_hz": 1.0e9,
                        "angular_frequency_rad_per_s": 6.283185307179586e9,
                        "mode_artifact_path": "eigen/modes/sample_0000/mode_0000.json",
                        "mode_field_id": field_id,
                        "mode_field_resource_key": (
                            "/v2/sessions/current/data/fields/"
                            f"{field_id}/samples/vector?view=phase_rotated_real&phase_rad=0"
                        ),
                        "residual_relative_l2": 1.0e-12,
                        "source_revision": spectrum_revision,
                        "status": "complete",
                    }
                ],
                "status": "complete",
                "stop_reason": None,
            }
        ],
        "cross_artifact_refs": [
            {
                "relation": "source_spectrum",
                "artifact": "eigen/spectrum.v2.json",
                "revision": spectrum_revision,
            },
            {
                "relation": "source_branches",
                "artifact": "eigen/branches.v2.json",
                "revision": branches_revision,
            },
        ],
    }
    payload["content_sha256"] = typed_artifact_self_digest(payload)
    payload["revision"] = payload["content_sha256"]
    (root / "eigen" / "field_sweep.v1.json").write_text(json.dumps(payload))
    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["artifacts"]["field_sweep_v1_path"] = "eigen/field_sweep.v1.json"
    manifest["resources"]["field_sweep_resource_key"] = (
        "/v2/sessions/current/analysis/frequency-domain/eigen/field-sweep.v1"
    )
    manifest_path.write_text(json.dumps(manifest))
    return payload


def declare_bias_field_sweep(root: Path, *, in_solver_diagnostics: bool = False) -> None:
    declaration = {
        "kind": "bias_field_sweep",
        "status": "complete",
        "complete": True,
        "requested_sample_count": 1,
        "completed_sample_count": 1,
    }
    if in_solver_diagnostics:
        diagnostics_path = root / "eigen" / "diagnostics" / "solver.v1.json"
        diagnostics = json.loads(diagnostics_path.read_text())
        diagnostics["field_sweep"] = declaration
        diagnostics_path.write_text(json.dumps(diagnostics))
        return
    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["field_sweep"] = declaration
    manifest_path.write_text(json.dumps(manifest))


def run_periodic_airbox_convergence_validator(
    mesh_roots: list[Path],
    airbox_roots: list[Path],
    max_relative_error: float = 0.05,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "verify_fem_eigen_k0_periodic_airbox_convergence.py"),
            "--max-relative-error",
            str(max_relative_error),
            "--minimum-field-count",
            "3",
            *(item for root in mesh_roots for item in ("--mesh-root", str(root))),
            *(item for root in airbox_roots for item in ("--airbox-root", str(root))),
        ],
        check=False,
        cwd=REPO_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def mark_reference_full_2x2_floquet_fixture(root: Path) -> None:
    solver_path = root / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.update(
        {
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
        }
    )
    solver_path.write_text(json.dumps(solver))

    mode_path = root / "eigen" / "modes" / "sample_0000" / "mode_0000.json"
    mode = json.loads(mode_path.read_text())
    mode["solver_model"] = "cpu_full_2x2_phase_reduced_floquet"
    mode_path.write_text(json.dumps(mode))


def expand_reference_floquet_fixture_to_k_path(
    root: Path,
    *,
    frequencies_hz: tuple[float, float, float] = (1.0e9, 1.1e9, 1.4e9),
    kx_rad_m: tuple[float, float, float] = (0.0, 1.0e7, 2.0e7),
    k_vectors_rad_m: tuple[tuple[float, float, float], ...] | None = None,
    path_s_rad_m: tuple[float, ...] | None = None,
) -> None:
    k_vectors = k_vectors_rad_m or tuple((kx, 0.0, 0.0) for kx in kx_rad_m)
    if len(frequencies_hz) != len(k_vectors):
        raise ValueError("frequencies_hz and k_vectors must have the same length")
    if path_s_rad_m is None:
        path_values_list = [0.0]
        for previous, current in zip(k_vectors, k_vectors[1:]):
            step = math.sqrt(
                sum((right - left) ** 2 for left, right in zip(previous, current))
            )
            path_values_list.append(path_values_list[-1] + step)
        path_values = tuple(path_values_list)
    else:
        path_values = path_s_rad_m
    if len(path_values) != len(k_vectors):
        raise ValueError("path_s_rad_m and k_vectors must have the same length")
    mark_reference_full_2x2_floquet_fixture(root)
    solver_path = root / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver["solver_notes"][0] = f"{len(k_vectors)} sample(s) generated from k_sampling"
    solver["sample_count"] = len(k_vectors)
    solver_path.write_text(json.dumps(solver))

    spectrum = json.loads((root / "eigen" / "spectrum.v2.json").read_text())
    branches = json.loads((root / "eigen" / "branches.v2.json").read_text())
    manifest = json.loads((root / "frequency_domain" / "manifest.v1.json").read_text())
    branch_points = []
    dispersion_rows = [
        (
            "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,"
            "label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,"
            "analytic_frequency_hz,relative_error,validation_geometry,line_width_hz,"
            "residual_norm,overlap_score,tracking_score_source,mode_field_id,"
            "mode_field_resource_key"
        )
    ]
    samples = []
    mode_paths = []
    mode_resources = []
    for sample_index, (frequency_hz, k_vector, path_s) in enumerate(
        zip(frequencies_hz, k_vectors, path_values)
    ):
        label = "G" if sample_index == 0 else "X" if sample_index == len(k_vectors) - 1 else ""
        path_s = float(path_s)
        omega = 6.283185307179586 * frequency_hz
        field_id = f"analysis:eigen:sample-{sample_index:04d}:mode-0000"
        field_resource = (
            f"/v2/sessions/current/data/fields/{field_id}/samples/vector"
            "?view=phase_rotated_real&phase_rad=0"
        )
        meta_resource = (
            "/v2/sessions/current/analysis/frequency-domain/eigen/"
            f"mode-field/{sample_index}/0/meta"
        )

        if sample_index:
            shutil.copytree(
                root / "eigen" / "modes" / "sample_0000",
                root / "eigen" / "modes" / f"sample_{sample_index:04d}",
            )
            shutil.copytree(
                root / "eigen" / "mode_fields" / "sample_0000",
                root / "eigen" / "mode_fields" / f"sample_{sample_index:04d}",
            )
            shutil.copytree(
                root / "eigen" / "mode_fields.zarr" / "sample_0000",
                root / "eigen" / "mode_fields.zarr" / f"sample_{sample_index:04d}",
            )

        mode_path = root / "eigen" / "modes" / f"sample_{sample_index:04d}" / "mode_0000.json"
        mode = json.loads(mode_path.read_text())
        mode.update(
            {
                "sample_index": sample_index,
                "mode_field_id": field_id,
                "mode_field_resource_key": field_resource,
                "frequency_hz": frequency_hz,
                "frequency_real_hz": frequency_hz,
                "angular_frequency_rad_per_s": omega,
                "omega_rad_s": omega,
                "k_vector": list(k_vector),
                "zarr_array_path": (
                    "eigen/mode_fields.zarr/"
                    f"sample_{sample_index:04d}/mode_0000/vector_xyz_complex"
                ),
                "zarr_chunk_path": (
                    "eigen/mode_fields.zarr/"
                    f"sample_{sample_index:04d}/mode_0000/vector_xyz_complex/0.0.0"
                ),
                "compatibility_binary_payload_path": (
                    f"eigen/mode_fields/sample_{sample_index:04d}/mode_0000/vector.bin"
                ),
            }
        )
        mode_path.write_text(json.dumps(mode))

        zattrs_path = (
            root
            / "eigen"
            / "mode_fields.zarr"
            / f"sample_{sample_index:04d}"
            / "mode_0000"
            / "vector_xyz_complex"
            / ".zattrs"
        )
        zattrs = json.loads(zattrs_path.read_text())
        zattrs["sample_index"] = sample_index
        zattrs_path.write_text(json.dumps(zattrs))

        mode_summary = spectrum["samples"][0]["modes"][0].copy()
        mode_summary.update(
            {
                "mode_field_id": field_id,
                "mode_field_resource_key": field_resource,
                "frequency_hz": frequency_hz,
                "frequency_real_hz": frequency_hz,
                "angular_frequency_rad_per_s": omega,
                "omega_rad_s": omega,
                "k_vector": list(k_vector),
            }
        )
        samples.append(
            {
                "sample_index": sample_index,
                "label": label,
                "k_vector": list(k_vector),
                "path_s": path_s,
                "segment_index": 0,
                "t_in_segment": sample_index / max(len(k_vectors) - 1, 1),
                "modes": [mode_summary],
            }
        )
        tracking_confidence = 1.0 if sample_index == 0 else 0.8
        branch_points.append(
            {
                "sample_index": sample_index,
                "raw_mode_index": 0,
                "frequency_hz": frequency_hz,
                "frequency_real_hz": frequency_hz,
                "frequency_imag_hz": 0.0,
                "angular_frequency_rad_per_s": omega,
                "tracking_confidence": tracking_confidence,
                "overlap_prev": None if sample_index == 0 else 0.8,
                "tracking_score_source": (
                    "seed" if sample_index == 0 else "modal_overlap_weighted_score"
                ),
                "modal_overlap_available": sample_index != 0,
                "mode_field_id": field_id,
                "mode_field_resource_key": field_resource,
            }
        )
        dispersion_rows.append(
            f"{sample_index},{path_s},{k_vector[0]},{k_vector[1]},{k_vector[2]},{label},0,0,{frequency_hz},{omega},"
            f",,,0,1.0e-9,{'' if sample_index == 0 else '0.8'},"
            f"{'seed' if sample_index == 0 else 'modal_overlap_weighted_score'},"
            f"{field_id},{field_resource}"
        )
        mode_paths.append(f"eigen/modes/sample_{sample_index:04d}/mode_0000.json")
        mode_resources.append(meta_resource)

    spectrum["sample_count"] = len(k_vectors)
    spectrum["samples"] = samples
    (root / "eigen" / "spectrum.v2.json").write_text(json.dumps(spectrum))
    sync_eigen_summary_mode_from_spectrum(root)
    branches["tracking_score_source"] = "mixed_modal_overlap_and_frequency_fallback"
    branches["modal_overlap_available"] = True
    branches["tracking_method"] = "overlap_hungarian"
    branches["overlap_floor"] = 0.5
    branches["branches"][0]["points"] = branch_points
    branches["diagnostics"] = {
        "tracking_score_source": "mixed_modal_overlap_and_frequency_fallback",
        "modal_overlap_available": True,
        "min_overlap": 0.8,
        "median_overlap": 0.8,
    }
    (root / "eigen" / "branches.v2.json").write_text(json.dumps(branches))
    manifest["artifacts"]["mode_metadata_paths"] = mode_paths
    manifest["resources"]["mode_field_resources"] = mode_resources
    manifest["diagnostics"] = {
        "tracking_score_source": "mixed_modal_overlap_and_frequency_fallback",
        "modal_overlap_available": True,
        "production_cpu_rejection_reason": (
            "production_cpu_modal_nonzero_k_floquet_operator_missing"
        ),
        "production_cpu_rejection_scope": "selected_spectrum_nonzero_k_floquet_modal",
        "required_operator_contract": (
            "bloch_floquet_tangent_operator_with_periodic_pairs"
        ),
        "required_operator_payload_kind": "bloch_floquet_tangent_operator",
        "modal_periodic_pair_contract_available": False,
    }
    (root / "frequency_domain" / "manifest.v1.json").write_text(json.dumps(manifest))
    (root / "eigen" / "dispersion.csv").write_text("\n".join(dispersion_rows))
    write_dispersion_path_sampling(
        root,
        points=tuple(
            (label, k_vector)
            for label, k_vector in zip(
                (
                    "G" if sample_index == 0 else "X" if sample_index == len(k_vectors) - 1 else ""
                    for sample_index in range(len(k_vectors))
                ),
                k_vectors,
            )
        ),
        samples_per_segment=tuple(1 for _ in range(len(k_vectors) - 1)),
        closed=False,
    )


def make_mode_fields_binary_only(root: Path) -> None:
    shutil.rmtree(root / "eigen" / "mode_fields.zarr")
    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["artifacts"]["mode_field_storage_format"] = "binary_compatibility_exports"
    manifest["artifacts"]["mode_field_zarr_store_path"] = None
    manifest_path.write_text(json.dumps(manifest))

    for mode_path in sorted((root / "eigen" / "modes").glob("sample_*/mode_*.json")):
        mode = json.loads(mode_path.read_text())
        mode["storage_format"] = "binary_compatibility_exports"
        for field_name in [
            "zarr_store_path",
            "zarr_array_path",
            "zarr_chunk_path",
            "zarr_dtype",
            "zarr_shape",
            "zarr_chunk_shape",
        ]:
            mode.pop(field_name, None)
        mode_path.write_text(json.dumps(mode))


def mark_production_shift_invert_k_path_fixture(root: Path) -> None:
    periodic_mesh_certificate = {
        "schema_version": "periodic_mesh_certificate.v5",
        "certificate_status": "accepted",
        "magnetic_pair_count": 1,
        "magnetic_pair_map_sha256": (
            "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        ),
        "pair_map_hash_canonicalization": (
            "periodic_mesh_certificate_pair_map.v1_schema_role_pair_id_len_sorted_nodes"
        ),
    }
    solver_path = root / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.update(
        {
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
            "operator_diagnostics": {
                "payload_kind": "bloch_floquet_tangent_operator",
            },
            "modal_periodic_pair_contract_available": True,
            "floquet_periodic_pair_count": 1,
            "periodic_mesh_certificate": periodic_mesh_certificate,
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
        }
    )
    solver_path.write_text(json.dumps(solver))

    branches_path = root / "eigen" / "branches.v2.json"
    branches = json.loads(branches_path.read_text())
    branches["tracking_score_source"] = "modal_overlap_weighted_score"
    branches["diagnostics"]["tracking_score_source"] = "modal_overlap_weighted_score"
    branches_path.write_text(json.dumps(branches))

    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["stage_id"] = "eigenmodes"
    manifest["diagnostics"]["tracking_score_source"] = "modal_overlap_weighted_score"
    manifest["diagnostics"]["periodic_mesh_certificate"] = periodic_mesh_certificate
    manifest["requested_execution"] = {
        "calculation_mode": "dispersion_modal",
        "backend": "fem",
        "device": "cpu",
        "precision": "double",
        "execution_mode": "extended",
        "ui_mode": "auto",
        "operator": "linearized_llg",
        "solver_family": "modal_eigen",
        "solve_equation": "A q = lambda B q; lambda = i omega",
        "include_demag": False,
        "damping_policy": "ignore",
        "equilibrium_source": "provided",
        "k_sampling": "path",
        "outputs": ["spectrum", "branches", "dispersion", "mode_fields"],
    }
    manifest["resolved_execution"] = {
        "backend": "fem",
        "device": "cpu",
        "precision": "double",
        "engine": "multi_k_orchestrator/slepc_multi_shift_invert_production_cpu_dense",
        "native_backend": "native_cpu",
        "reference_or_production": "production",
        "container_image": None,
        "build_features": [],
        "demag_realization": "none",
        "solver_library": "slepc",
        "solver_algorithm": "slepc_multi_shift_invert_production_cpu_dense",
        "solve_kind": "modal_eigen",
    }
    manifest["physics"] = {
        "analysis_family": "magnetic_frequency_domain",
        "phase_convention": "exp_i_omega_t",
        "frequency_units": "Hz",
        "field_units": "dimensionless_delta_m",
        "normalization": "unit_l2",
    }
    manifest["capabilities"] = {
        "driven_response_artifact_available": False,
        "modal_artifact_available": True,
        "production_native_solver_available": True,
        "validation_artifact": False,
        "dispersion": production_dispersion_capabilities(),
    }
    manifest_path.write_text(json.dumps(manifest))


def production_dispersion_capabilities() -> dict:
    return {
        "reference_cpu": {
            "status": "reference_executable",
            "reason": "reference CPU modal k-path artifacts are available",
        },
        "production_cpu": {
            "status": "partial_production_executable",
            "reason": "managed native CPU selected-spectrum no-demag Full2x2 Floquet k-path dispersion is executable",
        },
        "production_cpu_gamma_k_path": {
            "status": "partial_production_executable",
            "reason": "gamma-equivalent production CPU k-path bridge is validated",
        },
        "production_gpu": {
            "status": "unsupported",
            "reason": "modal GPU dispersion is unavailable",
        },
        "k_path": {
            "status": "reference_executable",
            "reason": "k-path dispersion.csv is available",
        },
        "branch_tracking": {
            "status": "reference_executable",
            "reason": "branches.v2 artifacts are available",
        },
    }


def reference_dispersion_capabilities() -> dict:
    capabilities = production_dispersion_capabilities()
    capabilities["production_cpu"] = {
        "status": "unsupported",
        "reason": "production CPU selected-spectrum modal k-path is not the resolved lane for this reference artifact",
    }
    return capabilities


def set_single_mode_lambda_i_omega_mapping(
    root: Path,
    *,
    eigenvalue_imag: float = 6.283185307179586e9,
) -> None:
    spectrum_path = root / "eigen" / "spectrum.v2.json"
    spectrum = json.loads(spectrum_path.read_text())
    spectrum_mode = spectrum["samples"][0]["modes"][0]
    spectrum_mode["phasor_convention"] = "exp_i_omega_t"
    spectrum_mode["eigenvalue_mapping"] = "lambda_eq_i_omega"
    spectrum_mode["eigenvalue_real"] = 0.0
    spectrum_mode["eigenvalue_imag"] = eigenvalue_imag
    spectrum_path.write_text(json.dumps(spectrum))

    mode_path = root / "eigen" / "modes" / "sample_0000" / "mode_0000.json"
    mode = json.loads(mode_path.read_text())
    mode["phasor_convention"] = "exp_i_omega_t"
    mode["eigenvalue_mapping"] = "lambda_eq_i_omega"
    mode["eigenvalue_real"] = 0.0
    mode["eigenvalue_imag"] = eigenvalue_imag
    mode_path.write_text(json.dumps(mode))

    summary_path = root / "eigen" / "metadata" / "eigen_summary.json"
    summary = json.loads(summary_path.read_text())
    summary_mode = summary["modes"][0]
    summary_mode["phasor_convention"] = "exp_i_omega_t"
    summary_mode["eigenvalue_mapping"] = "lambda_eq_i_omega"
    summary_mode["eigenvalue_real"] = 0.0
    summary_mode["eigenvalue_imag"] = eigenvalue_imag
    summary_path.write_text(json.dumps(summary))


def exchange_only_expected_frequency_hz(kx: float) -> float:
    gamma0 = 2.211e5
    h0 = 39_788.735772973836
    exchange_stiffness = 13e-12
    saturation_magnetisation = 800e3
    exchange_field = (
        2.0
        * exchange_stiffness
        * kx
        * kx
        / (MU0 * saturation_magnetisation)
    )
    return gamma0 * (h0 + exchange_field) / (2.0 * math.pi)


def k0_kittel_expected_frequency_hz(field_a_per_m: float) -> float:
    gamma0 = 2.211e5
    effective_magnetisation = 800e3
    return (
        gamma0
        * math.sqrt(field_a_per_m * (field_a_per_m + effective_magnetisation))
        / (2.0 * math.pi)
    )


def write_k0_kittel_field_sweep_metadata(
    root: Path,
    *,
    demag_kind: str = "synthetic_demag_factor",
) -> None:
    metadata = {
        "execution_plan": {
            "backend_plan": {
                "enable_exchange": True,
                "enable_demag": True,
                "gyromagnetic_ratio": 2.211e5,
                "material": {
                    "saturation_magnetisation": 800e3,
                    "effective_magnetisation": 800e3,
                },
                "operator": {
                    "kind": "k0_uniform_modal_eigen",
                    "include_demag": True,
                },
                "k0_kittel_validation": {
                    "case_id": "K0-3",
                    "demag_kind": demag_kind,
                    "model": "thin_film_in_plane",
                    "field_units": "A_per_m",
                    "relative_tolerance": 0.05,
                    "samples": [
                        {"sample_index": 0, "bias_field": [20e-3 / MU0, 0.0, 0.0]},
                        {"sample_index": 1, "bias_field": [50e-3 / MU0, 0.0, 0.0]},
                        {"sample_index": 2, "bias_field": [100e-3 / MU0, 0.0, 0.0]},
                    ],
                },
            }
        }
    }
    (root / "metadata.json").write_text(json.dumps(metadata))


def write_k0_kittel_summary_and_points(
    root: Path,
    fields: tuple[float, ...],
    frequencies_hz: tuple[float, ...],
    *,
    sweep_point_count: int | None = None,
    case_id: str = "K0-3",
    demag_kind: str = "synthetic_demag_factor",
) -> None:
    validation_dir = root / "validation" / "kittel_k0_pbc"
    validation_dir.mkdir(parents=True)
    point_count = len(fields) if sweep_point_count is None else sweep_point_count
    (validation_dir / "summary.v1.json").write_text(
        json.dumps(
            {
                "schema_version": "frequency_domain_kittel_k0_validation.v1",
                "status": "passed",
                "case_id": case_id,
                "test_id": "kittel_k0_pbc_thinfilm_demag_inplane",
                "model": "thin_film_in_plane",
                "phasor_convention": "exp_plus_i_omega_t",
                "boundary_condition": "periodic_k0",
                "k_vector_rad_per_m": [0.0, 0.0, 0.0],
                "demag_kind": demag_kind,
                "demag": {
                    "kind": demag_kind,
                    "effective_magnetisation_A_per_m": 800e3,
                    "gauge_policy": (
                        "mean_zero_augmented"
                        if demag_kind == "periodic_airbox_k0"
                        else "not_applicable"
                    ),
                    "phi_dof_count": 8 if demag_kind == "periodic_airbox_k0" else None,
                    "augmented_phi_dof_count": 9 if demag_kind == "periodic_airbox_k0" else None,
                    "poisson_constraint_relative_residual": (
                        1.0e-12 if demag_kind == "periodic_airbox_k0" else None
                    ),
                    "magnetic_pair_count": 4 if demag_kind == "periodic_airbox_k0" else None,
                    "airbox_pair_count": 6 if demag_kind == "periodic_airbox_k0" else None,
                    "production_periodic_airbox_claim": demag_kind == "periodic_airbox_k0",
                },
                "sweep_point_count": point_count,
                "max_relative_frequency_error": 0.0,
                "median_relative_frequency_error": 0.0,
                "mode_selection": {
                    "minimum_uniformity_score": 1.0,
                    "minimum_branch_overlap": 1.0,
                    "maximum_tangent_leakage": 0.0,
                },
                "solver": {
                    "backend": "modal_eigen",
                    "execution_lane": "production_cpu",
                    "requested_mode_count": 2,
                    "max_eigen_residual_relative": 0.0,
                },
            }
        )
    )
    rows = [
        (
            case_id,
            demag_kind,
            index,
            field,
            MU0 * field,
            frequency,
            frequency,
            0.0,
            0,
            0.0,
            2.0 * math.pi * frequency,
            0.0,
            1.0,
            1.0,
            0.0,
            0.0,
        )
        for index, (field, frequency) in enumerate(zip(fields, frequencies_hz))
    ]
    header = (
        "case_id,demag_kind,field_index,H0_A_per_m,mu0_H0_T,expected_frequency_hz,eigen_frequency_hz,"
        "relative_frequency_error,selected_mode_index,eigenvalue_real,eigenvalue_imag,"
        "mode_residual_relative,uniformity_score,branch_overlap_previous,"
        "max_m0_dot_delta_m_abs,max_periodic_seam_mismatch\n"
    )
    body = "".join(",".join(str(value) for value in row) + "\n" for row in rows)
    (validation_dir / "points.v1.csv").write_text(header + body)


def write_k0_kittel_convergence_table(
    root: Path,
    *,
    relative_error: float = 0.0,
    mesh_resolution_m: float = 5e-9,
    airbox_size_m: float = 80e-9,
) -> None:
    validation_dir = root / "validation" / "kittel_k0_pbc"
    validation_dir.mkdir(parents=True, exist_ok=True)
    header = (
        "case_id,demag_kind,mesh_resolution_m,airbox_size_m,phi_dof_count,"
        "poisson_residual_relative,relative_kittel_frequency_error,"
        "effective_magnetisation_A_per_m\n"
    )
    row = f"K0-3,periodic_airbox_k0,{mesh_resolution_m},{airbox_size_m},8,1e-12,{relative_error},800000.0\n"
    (validation_dir / "convergence.v1.csv").write_text(header + row)


def mark_poisson_airbox_k0_solver_fixture(root: Path) -> None:
    solver_path = root / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.update(
        {
            "assembly_kind": "mfem_weak_form_shared_domain",
            "solver_adapter": "k0_poisson_airbox_cpu_full_coupled_slepc",
            "solver_model": "k0_poisson_airbox_cpu_full_coupled_slepc",
            "resolved_solver_family": "k0_poisson_airbox_full_coupled",
            "demag_kind": "periodic_airbox_k0",
            "execution_lane": "production_cpu",
            "algebraic_form": "full_coupled_poisson_airbox_augmented_gauge",
            "phasor_convention": "exp_plus_i_omega_t",
            "eigenvalue_mapping": "lambda_imag_positive_frequency",
            "constants": {
                "gamma_rad_s_T": 221100.0 / MU0,
                "gamma0_rad_s_per_A_m": 221100.0,
                "mu0_T_m_per_A": MU0,
            },
        }
    )
    solver_path.write_text(json.dumps(solver))


def mark_relaxed_equilibrium_fixture(
    root: Path,
    *,
    steps: int = 4,
    handoff: str | None = None,
) -> None:
    summary_path = root / "eigen" / "metadata" / "eigen_summary.json"
    summary = json.loads(summary_path.read_text())
    equilibrium_source = {"kind": "relaxed_initial_state"}
    if handoff is not None:
        equilibrium_source["handoff"] = handoff
    summary["equilibrium_source"] = equilibrium_source
    summary["relaxation_steps"] = steps
    summary_path.write_text(json.dumps(summary))


def mark_gpu_modal_k0_kittel_fixture(root: Path) -> None:
    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["requested_execution"] = {
        "calculation_mode": "dispersion_modal",
        "backend": "fem",
        "device": "gpu",
        "precision": "double",
        "execution_mode": "strict",
        "ui_mode": "auto",
        "operator": "linearized_llg",
        "solver_family": "modal_eigen",
        "solve_equation": "A q = lambda B q; lambda = i omega",
        "include_demag": False,
        "damping_policy": "ignore",
        "equilibrium_source": "provided",
        "k_sampling": "path",
        "outputs": ["spectrum", "branches", "dispersion", "mode_fields"],
    }
    manifest["resolved_execution"] = {
        "backend": "fem",
        "device": "gpu",
        "precision": "double",
        "engine": "gpu_dense_k0_macrospin_modal_eigen",
        "native_backend": "native_gpu",
        "reference_or_production": "production",
        "container_image": "fullmag/fem-gpu:local",
        "build_features": ["cuda", "fem-gpu"],
        "demag_realization": "none",
        "solver_library": "cusolverdn",
        "solver_algorithm": "gpu_dense_k0_macrospin_modal_eigen",
        "solve_kind": "modal_eigen",
        "device_residency": "device_resident",
    }
    manifest["capabilities"]["dispersion"]["production_gpu"] = {
        "status": "partial_production_executable",
        "reason": "GPU modal Kittel fixture uses a real modal GPU lane",
    }
    manifest_path.write_text(json.dumps(manifest))

    summary_path = root / "validation" / "kittel_k0_pbc" / "summary.v1.json"
    summary = json.loads(summary_path.read_text())
    summary["solver"]["execution_lane"] = "production_gpu"
    summary["solver"]["solver_algorithm"] = "gpu_dense_k0_macrospin_modal_eigen"
    summary_path.write_text(json.dumps(summary))


def mark_gpu_modal_k0_periodic_airbox_fixture(root: Path) -> None:
    mark_poisson_airbox_k0_solver_fixture(root)
    solver_path = root / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    native_diagnostics = {
        "solver_adapter": "k0_poisson_airbox_gpu_petsc_slepc",
        "assembly_kind": "mfem_weak_form_shared_domain",
        "demag_kind": "periodic_airbox_k0",
        "algebraic_form": "schur_reduced_descriptor",
        "matrix_equation": "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q",
        "spectral_transform": "shift_invert",
        "spectral": {"spectral_scalar_mode": "real_split"},
        "persistent_solver_context": True,
        "gpu_device_resident_modal_eigensolver": True,
        "scalable_selected_spectrum": True,
        "production_implication": True,
        "validation_only": False,
        "cpu_fallback": "disabled",
        "fallback_used": False,
        "per_iteration_h2d_transfer_count": 0,
        "per_iteration_d2h_transfer_count": 0,
        "full_residual_certified": True,
    }
    solver.update(
        {
            "solver_adapter": "k0_poisson_airbox_gpu_petsc_slepc",
            "solver_model": "k0_poisson_airbox_gpu_petsc_slepc",
            "resolved_solver_family": "device_resident_arnoldi_shift_invert",
            "execution_lane": "production_gpu",
            "demag_kind": "periodic_airbox_k0",
            "algebraic_form": "schur_reduced_descriptor",
            "matrix_equation": "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q",
            "spectral_transform": "shift_invert",
            "production_periodic_airbox_claim": True,
            "sample_solver_diagnostics": [
                {"sample_index": 0, "diagnostics": native_diagnostics},
            ],
        }
    )
    solver_path.write_text(json.dumps(solver))

    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["requested_execution"] = {
        "backend": "fem",
        "device": "gpu",
        "precision": "double",
        "include_demag": True,
    }
    manifest["resolved_execution"] = {
        "backend": "fem",
        "device": "gpu",
        "precision": "double",
        "engine": "multi_k_orchestrator/k0_poisson_airbox_gpu_petsc_slepc",
        "native_backend": "native_gpu",
        "reference_or_production": "production",
        "solver_algorithm": "k0_poisson_airbox_gpu_petsc_slepc",
        "device_residency": "gpu_device_resident",
    }
    manifest_path.write_text(json.dumps(manifest))

    summary_path = root / "validation" / "kittel_k0_pbc" / "summary.v1.json"
    summary = json.loads(summary_path.read_text())
    summary["solver"]["execution_lane"] = "production_gpu"
    summary["solver"]["solver_algorithm"] = "k0_poisson_airbox_gpu_petsc_slepc"
    summary_path.write_text(json.dumps(summary))


def write_exchange_only_dispersion_metadata(root: Path) -> None:
    metadata = {
        "execution_plan": {
            "backend_plan": {
                "enable_exchange": True,
                "enable_demag": False,
                "external_field": [39_788.735772973836, 0.0, 0.0],
                "gyromagnetic_ratio": 2.211e5,
                "material": {
                    "exchange_stiffness": 13e-12,
                    "saturation_magnetisation": 800e3,
                },
                "operator": {
                    "include_demag": False,
                    "kind": "full_2x2",
                },
                "k_sampling": {
                    "kind": "path",
                    "points": [
                        {"label": "G", "k_vector": [0.0, 0.0, 0.0]},
                        {"label": "X", "k_vector": [2.0e7, 0.0, 0.0]},
                    ],
                    "samples_per_segment": [2],
                },
            }
        }
    }
    (root / "metadata.json").write_text(json.dumps(metadata))


def normalize_low_k_de_bv_geometry(value: object) -> str:
    aliases = {
        "de": "damon_eshbach",
        "damon_eshbach": "damon_eshbach",
        "damon-eshbach": "damon_eshbach",
        "bv": "backward_volume",
        "backward_volume": "backward_volume",
        "backward-volume": "backward_volume",
    }
    normalized = aliases.get(str(value).lower())
    if normalized is None:
        raise ValueError(f"invalid DE/BV geometry {value!r}")
    return normalized


def annotate_low_k_de_bv_dispersion_csv(
    root: Path,
    scenarios: list[dict[str, object]],
) -> None:
    dispersion_path = root / "eigen" / "dispersion.csv"
    rows = list(csv.DictReader(dispersion_path.read_text().splitlines()))
    sample_geometries: dict[int, str] = {}
    for scenario in scenarios:
        geometry = normalize_low_k_de_bv_geometry(scenario["geometry"])
        for sample_index in scenario["sample_indices"]:
            sample_geometries[int(sample_index)] = geometry

    for row in rows:
        sample_index = int(row["sample_index"])
        geometry = sample_geometries.get(sample_index)
        if geometry is None:
            continue
        k_vector = (
            float(row["kx_rad_per_m"]),
            float(row["ky_rad_per_m"]),
            float(row["kz_rad_per_m"]),
        )
        analytic_hz = low_k_de_bv_expected_frequency_hz(k_vector, geometry)
        frequency_hz = float(row["frequency_hz"])
        row["analytic_frequency_hz"] = f"{analytic_hz:.16e}"
        row["relative_error"] = (
            f"{abs(frequency_hz - analytic_hz) / max(abs(analytic_hz), 1.0):.16e}"
        )
        row["validation_geometry"] = geometry

    fieldnames = [
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
        "analytic_frequency_hz",
        "relative_error",
        "validation_geometry",
        "line_width_hz",
        "residual_norm",
        "overlap_score",
        "tracking_score_source",
        "mode_field_id",
        "mode_field_resource_key",
    ]
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    dispersion_path.write_text(output.getvalue().rstrip("\n"))


def low_k_de_bv_expected_frequency_hz(
    k_vector: tuple[float, float, float],
    geometry: str,
) -> float:
    gamma0 = 2.211e5
    h0 = 40_000.0
    exchange_stiffness = 3.5e-12
    saturation_magnetisation = 140e3
    film_thickness = 80e-9
    k_norm = math.sqrt(sum(component * component for component in k_vector))
    exchange_field = (
        2.0
        * exchange_stiffness
        * k_norm
        * k_norm
        / (MU0 * saturation_magnetisation)
    )
    p_factor = (
        0.0
        if k_norm == 0.0
        else 1.0 - (1.0 - math.exp(-k_norm * film_thickness)) / (k_norm * film_thickness)
    )
    common = h0 + exchange_field
    if geometry == "damon_eshbach":
        factor_a = common + saturation_magnetisation * (1.0 - p_factor)
        factor_b = common + saturation_magnetisation * p_factor
    elif geometry == "backward_volume":
        factor_a = common
        factor_b = common + saturation_magnetisation * (1.0 - p_factor)
    else:
        raise ValueError(geometry)
    return gamma0 * math.sqrt(factor_a * factor_b) / (2.0 * math.pi)


def write_low_k_de_bv_dispersion_metadata(
    root: Path,
    *,
    scenarios: list[dict[str, object]] | None = None,
    max_k_rad_per_m: float = 3.0e6,
    frequency_window_hz: list[float] | None = None,
) -> None:
    metadata = {
        "execution_plan": {
            "backend_plan": {
                "enable_exchange": True,
                "enable_demag": True,
                "external_field": [40_000.0, 0.0, 0.0],
                "gyromagnetic_ratio": 2.211e5,
                "material": {
                    "exchange_stiffness": 3.5e-12,
                    "saturation_magnetisation": 140e3,
                },
                "operator": {
                    "include_demag": True,
                    "kind": "full_2x2",
                    "demag_model": "thin_film_kalinikos_slab_n0",
                },
                "dispersion_validation": {
                    "kind": "thin_film_de_bv_low_k",
                    "analytic_model": "kalinikos_slab_n0",
                    "film_thickness_m": 80e-9,
                    "equilibrium_magnetization": [1.0, 0.0, 0.0],
                    "film_normal": [0.0, 0.0, 1.0],
                    "max_k_rad_per_m": max_k_rad_per_m,
                    "frequency_window_hz": frequency_window_hz or [0.0, 5.0e9],
                    "max_relative_error": 0.02,
                    "scenarios": scenarios
                    or [
                        {
                            "geometry": "backward_volume",
                            "branch_id": 0,
                            "sample_indices": [0, 1, 2],
                        },
                        {
                            "geometry": "damon_eshbach",
                            "branch_id": 0,
                            "sample_indices": [3, 4, 5],
                        },
                    ],
                },
            }
        }
    }
    (root / "metadata.json").write_text(json.dumps(metadata))
    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest.setdefault("validation", {})["dispersion_validation"] = metadata[
        "execution_plan"
    ]["backend_plan"]["dispersion_validation"]
    manifest["validation"]["dispersion_frequency_source"] = "analytic_reference_model"
    manifest["validation"]["dispersion_reference_model"] = "kalinikos_slab_n0"
    manifest["validation"][
        "dynamic_demag_operator_source"
    ] = "analytic_thin_film_de_bv_reference_not_fem_demag_k"
    manifest_path.write_text(json.dumps(manifest))
    annotate_low_k_de_bv_dispersion_csv(
        root,
        metadata["execution_plan"]["backend_plan"]["dispersion_validation"]["scenarios"],
    )


def write_dispersion_path_sampling(
    root: Path,
    *,
    points: tuple[tuple[str, tuple[float, float, float]], ...],
    samples_per_segment: tuple[int, ...],
    closed: bool,
) -> None:
    path = root / "eigen" / "dispersion" / "path.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "sampling": {
                    "kind": "path",
                    "points": [
                        {"label": label, "k_vector": list(k_vector)}
                        for label, k_vector in points
                    ],
                    "samples_per_segment": list(samples_per_segment),
                    "closed": closed,
                }
            }
        )
    )


def set_public_dispersion_sample_label(
    root: Path,
    *,
    sample_index: int,
    label: str,
) -> None:
    spectrum_path = root / "eigen" / "spectrum.v2.json"
    spectrum = json.loads(spectrum_path.read_text())
    for sample in spectrum["samples"]:
        if sample["sample_index"] == sample_index:
            sample["label"] = label
            break
    spectrum_path.write_text(json.dumps(spectrum))

    dispersion_path = root / "eigen" / "dispersion.csv"
    rows = dispersion_path.read_text().splitlines()
    headers = rows[0].split(",")
    sample_index_column = headers.index("sample_index")
    label_column = headers.index("label")
    next_rows = [rows[0]]
    for row in rows[1:]:
        columns = row.split(",")
        if int(columns[sample_index_column]) == sample_index:
            columns[label_column] = label
        next_rows.append(",".join(columns))
    dispersion_path.write_text("\n".join(next_rows))


def test_validator_accepts_eigen_artifact_bundle(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_closed_k_path_sampling_metadata(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=(1.0e9, 1.1e9, 1.4e9, 1.2e9),
        kx_rad_m=(0.0, 1.0e7, 2.0e7, 0.0),
        path_s_rad_m=(0.0, 1.0e7, 2.0e7, 4.0e7),
    )
    write_dispersion_path_sampling(
        tmp_path,
        points=(
            ("G", (0.0, 0.0, 0.0)),
            ("X", (1.0e7, 0.0, 0.0)),
            ("M", (2.0e7, 0.0, 0.0)),
        ),
        samples_per_segment=(1, 1, 1),
        closed=True,
    )
    set_public_dispersion_sample_label(tmp_path, sample_index=3, label="G")

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_dispersion_path_metadata_label_drift(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    path_metadata_path = tmp_path / "eigen" / "dispersion" / "path.json"
    path_metadata = json.loads(path_metadata_path.read_text())
    path_metadata["sampling"]["points"][-1]["label"] = "M"
    path_metadata_path.write_text(json.dumps(path_metadata))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "eigen/dispersion/path.json.control point 2.sample[2].label" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_dispersion_path_metadata_control_k_drift(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    path_metadata_path = tmp_path / "eigen" / "dispersion" / "path.json"
    path_metadata = json.loads(path_metadata_path.read_text())
    path_metadata["sampling"]["points"][1]["k_vector"][0] = 1.5e7
    path_metadata_path.write_text(json.dumps(path_metadata))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "eigen/dispersion/path.json.control point 1.sample[1].k_vector[0]" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_closed_k_path_with_open_segment_count(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=(1.0e9, 1.1e9, 1.4e9, 1.2e9),
        kx_rad_m=(0.0, 1.0e7, 2.0e7, 0.0),
        path_s_rad_m=(0.0, 1.0e7, 2.0e7, 4.0e7),
    )
    write_dispersion_path_sampling(
        tmp_path,
        points=(
            ("G", (0.0, 0.0, 0.0)),
            ("X", (1.0e7, 0.0, 0.0)),
            ("M", (2.0e7, 0.0, 0.0)),
        ),
        samples_per_segment=(1, 1),
        closed=True,
    )

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "expected 3 samples_per_segment entries, got 2" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_closed_k_path_missing_return_sample(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=(1.0e9, 1.1e9, 1.4e9, 1.6e9),
        kx_rad_m=(0.0, 1.0e7, 2.0e7, 3.0e7),
        path_s_rad_m=(0.0, 1.0e7, 2.0e7, 4.0e7),
    )
    write_dispersion_path_sampling(
        tmp_path,
        points=(
            ("G", (0.0, 0.0, 0.0)),
            ("X", (1.0e7, 0.0, 0.0)),
            ("M", (2.0e7, 0.0, 0.0)),
        ),
        samples_per_segment=(1, 1, 1),
        closed=True,
    )
    set_public_dispersion_sample_label(tmp_path, sample_index=3, label="G")

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "eigen/dispersion/path.json.control point 0.sample[3].k_vector[0]" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_missing_spectrum_mode_count(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    spectrum_path = tmp_path / "eigen" / "spectrum.v2.json"
    spectrum = json.loads(spectrum_path.read_text())
    del spectrum["mode_count"]
    spectrum_path.write_text(json.dumps(spectrum))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "spectrum.mode_count" in (result.stderr + result.stdout)


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


def test_validator_rejects_mode_field_without_source_mesh_identity(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    mode_path = tmp_path / "eigen" / "modes" / "sample_0000" / "mode_0000.json"
    mode = json.loads(mode_path.read_text())
    del mode["source_mesh_identity"]
    mode_path.write_text(json.dumps(mode))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "source_mesh_identity" in (result.stderr + result.stdout)


def test_validator_rejects_noncanonical_mode_handoff_sha256(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    mode_path = tmp_path / "eigen" / "modes" / "sample_0000" / "mode_0000.json"
    mode = json.loads(mode_path.read_text())
    mode["relax_to_eigen_handoff_sha256"] = "not-a-digest"
    mode_path.write_text(json.dumps(mode))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "relax_to_eigen_handoff_sha256" in (result.stderr + result.stdout)


def test_validator_rejects_mode_source_topology_identity_mismatch(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    mode_path = tmp_path / "eigen" / "modes" / "sample_0000" / "mode_0000.json"
    mode = json.loads(mode_path.read_text())
    mode["source_mesh_topology_sha256"] = "sha256:" + "b" * 64
    mode_path.write_text(json.dumps(mode))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "source_mesh_topology_sha256" in (result.stderr + result.stdout)


def test_validator_rejects_mode_handoff_cross_artifact_mismatch(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    mode_path = tmp_path / "eigen" / "modes" / "sample_0000" / "mode_0000.json"
    mode = json.loads(mode_path.read_text())
    mode["relax_to_eigen_handoff_sha256"] = "sha256:" + "e" * 64
    mode_path.write_text(json.dumps(mode))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "relax_to_eigen_handoff_sha256" in (result.stderr + result.stdout)


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
    branches_path = tmp_path / "eigen" / "branches.v2.json"
    branches = json.loads(branches_path.read_text())
    branches["branches"][0]["points"][0]["overlap_prev"] = 1.0
    branches_path.write_text(json.dumps(branches))

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
    spectrum_path = tmp_path / "eigen" / "spectrum.v2.json"
    spectrum = json.loads(spectrum_path.read_text())
    spectrum_mode = spectrum["samples"][0]["modes"][0]
    spectrum_mode["phasor_convention"] = "exp_i_omega_t"
    spectrum_mode["frequency_imag_hz"] = -1.0e6
    spectrum_path.write_text(json.dumps(spectrum))

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
    mode_path = tmp_path / "eigen" / "modes" / "sample_0000" / "mode_0000.json"
    mode = json.loads(mode_path.read_text())
    mode["frequency_imag_hz"] = 1.0e6
    mode_path.write_text(json.dumps(mode))
    sync_eigen_summary_mode_from_spectrum(tmp_path)
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
    mode_path = tmp_path / "eigen" / "modes" / "sample_0000" / "mode_0000.json"
    mode = json.loads(mode_path.read_text())
    mode["frequency_imag_hz"] = 1.0e6
    mode_path.write_text(json.dumps(mode))
    sync_eigen_summary_mode_from_spectrum(tmp_path)

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


def test_validator_accepts_lambda_i_omega_mode_frequency_mapping(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    set_single_mode_lambda_i_omega_mapping(tmp_path)

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_lambda_i_omega_frequency_mapping_drift(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    set_single_mode_lambda_i_omega_mapping(tmp_path, eigenvalue_imag=3.141592653589793e9)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "eigenvalue_imag" in (result.stderr + result.stdout) or "omega_rad_s" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_mode_metadata_phasor_drift_from_spectrum(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    mode_path = tmp_path / "eigen" / "modes" / "sample_0000" / "mode_0000.json"
    mode = json.loads(mode_path.read_text())
    mode["phasor_convention"] = "exp_i_omega_t"
    mode_path.write_text(json.dumps(mode))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "mode_0000.json.phasor_convention vs mode.phasor_convention" in (
        result.stderr + result.stdout
    )


def test_validator_accepts_mode_metadata_float_roundoff_from_spectrum(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    spectrum_path = tmp_path / "eigen" / "spectrum.v2.json"
    spectrum = json.loads(spectrum_path.read_text())
    spectrum["samples"][0]["modes"][0]["eigenvalue_real"] = 222052.04130342422
    spectrum_path.write_text(json.dumps(spectrum))
    sync_eigen_summary_mode_from_spectrum(tmp_path)

    mode_path = tmp_path / "eigen" / "modes" / "sample_0000" / "mode_0000.json"
    mode = json.loads(mode_path.read_text())
    mode["eigenvalue_real"] = 222052.04130342425
    mode_path.write_text(json.dumps(mode))

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_eigen_summary_phasor_drift_from_spectrum(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    summary_path = tmp_path / "eigen" / "metadata" / "eigen_summary.json"
    summary = json.loads(summary_path.read_text())
    summary["modes"][0]["phasor_convention"] = "exp_i_omega_t"
    summary_path.write_text(json.dumps(summary))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "eigen_summary.modes[0/0].phasor_convention vs mode.phasor_convention" in (
        result.stderr + result.stdout
    )


def test_validator_respects_eigen_summary_sample_index_when_present(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    summary_path = tmp_path / "eigen" / "metadata" / "eigen_summary.json"
    summary = json.loads(summary_path.read_text())
    summary["modes"][0]["sample_index"] = 1
    summary_path.write_text(json.dumps(summary))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "eigen_summary.modes[1/0].frequency_hz vs mode.frequency_hz" in (
        result.stderr + result.stdout
    )


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


def test_validator_accepts_executed_subwindows_scoped_per_field_sample(
    tmp_path: Path,
) -> None:
    requested_window = [1.0e8, 5.0e9]
    write_eigen_fixture(
        tmp_path,
        solver_diagnostics_override={
            "requested_mode_count": 1,
            "requested_window_hz": requested_window,
            "resolved_search_window_hz": requested_window,
            "window_completeness": {
                "policy": "best_effort",
                "status": "not_certified",
                "certification_method": "none",
                "additional_modes_may_exist": True,
            },
            "sample_solver_diagnostics": [
                {
                    "sample_index": 0,
                    "label": "H0",
                    "k_vector": [0.0, 0.0, 0.0],
                    "diagnostics": {
                        "requested_window_hz": requested_window,
                        "resolved_search_window_hz": requested_window,
                        "subwindows": [
                            {
                                "subwindow_index": 0,
                                "shift_frequency_hz": 2.55e9,
                                "status": "ok",
                                "converged_eigenpair_count": 4,
                                "candidate_mode_count": 2,
                                "accepted_mode_count": 1,
                                "accepted_frequencies_hz": [1.0e9],
                            }
                        ],
                    },
                }
            ],
        },
    )

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout


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
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_reference_full_2x2_floquet_without_dispersion_path_metadata(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    (tmp_path / "eigen" / "dispersion" / "path.json").unlink()

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "eigen/dispersion/path.json" in (result.stderr + result.stdout)


def test_validator_rejects_reference_full_2x2_floquet_without_dispersion_capabilities(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    del manifest["capabilities"]["dispersion"]
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "manifest.capabilities.dispersion" in (result.stderr + result.stdout)


def test_validator_rejects_reference_full_2x2_floquet_without_branch_capability(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    del manifest["capabilities"]["dispersion"]["branch_tracking"]
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "manifest.capabilities.dispersion.branch_tracking" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_reference_full_2x2_floquet_window_without_reference_policy(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.update(
        {
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
        }
    )
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "frequency_window_solver_policy" in (result.stderr + result.stdout)


def test_validator_rejects_reference_full_2x2_floquet_window_without_production_rejection_reason(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.update(
        {
            "production_solver_available": False,
            "frequency_window_solver_policy": (
                "reference_k_path_window_filter_not_shift_invert_or_feast"
            ),
            "production_cpu_rejection_reason": (
                "production_cpu_modal_nonzero_k_floquet_operator_missing"
            ),
            "production_cpu_rejection_scope": "selected_spectrum_nonzero_k_floquet_modal",
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
        }
    )
    solver.pop("production_cpu_rejection_reason", None)
    solver.pop("production_cpu_rejection_scope", None)
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "production_cpu_rejection_reason" in (result.stderr + result.stdout)


def test_validator_rejects_reference_full_2x2_floquet_window_without_required_operator_contract(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.update(
        {
            "production_solver_available": False,
            "frequency_window_solver_policy": (
                "reference_k_path_window_filter_not_shift_invert_or_feast"
            ),
            "production_cpu_rejection_reason": (
                "production_cpu_modal_nonzero_k_floquet_operator_missing"
            ),
            "production_cpu_rejection_scope": "selected_spectrum_nonzero_k_floquet_modal",
            "required_operator_contract": (
                "bloch_floquet_tangent_operator_with_periodic_pairs"
            ),
            "required_operator_payload_kind": "bloch_floquet_tangent_operator",
            "modal_periodic_pair_contract_available": False,
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
        }
    )
    solver.pop("required_operator_contract", None)
    solver.pop("modal_periodic_pair_contract_available", None)
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "required_operator_contract" in (result.stderr + result.stdout)


def test_validator_rejects_reference_full_2x2_floquet_window_without_required_operator_payload_kind(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.update(
        {
            "production_solver_available": False,
            "frequency_window_solver_policy": (
                "reference_k_path_window_filter_not_shift_invert_or_feast"
            ),
            "production_cpu_rejection_reason": (
                "production_cpu_modal_nonzero_k_floquet_operator_missing"
            ),
            "production_cpu_rejection_scope": "selected_spectrum_nonzero_k_floquet_modal",
            "required_operator_contract": (
                "bloch_floquet_tangent_operator_with_periodic_pairs"
            ),
            "required_operator_payload_kind": "bloch_floquet_tangent_operator",
            "modal_periodic_pair_contract_available": False,
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
        }
    )
    solver.pop("required_operator_payload_kind", None)
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "solver_diagnostics.required_operator_payload_kind" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_reference_full_2x2_floquet_window_with_certification_method(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.update(
        {
            "production_solver_available": False,
            "frequency_window_solver_policy": (
                "reference_k_path_window_filter_not_shift_invert_or_feast"
            ),
            "production_cpu_rejection_reason": (
                "production_cpu_modal_nonzero_k_floquet_operator_missing"
            ),
            "production_cpu_rejection_scope": "selected_spectrum_nonzero_k_floquet_modal",
            "required_operator_contract": (
                "bloch_floquet_tangent_operator_with_periodic_pairs"
            ),
            "required_operator_payload_kind": "bloch_floquet_tangent_operator",
            "modal_periodic_pair_contract_available": False,
            "requested_window_hz": [1.0, 1.0e13],
            "requested_mode_count": 1,
            "resolved_search_window_hz": [0.0, 1.125e13],
            "window_completeness": {
                "policy": "best_effort",
                "status": "not_certified",
                "certification_method": "certified_count",
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
        }
    )
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "solver_diagnostics.window_completeness.certification_method" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_reference_full_2x2_floquet_window_with_no_additional_modes_claim(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.update(
        {
            "production_solver_available": False,
            "frequency_window_solver_policy": (
                "reference_k_path_window_filter_not_shift_invert_or_feast"
            ),
            "production_cpu_rejection_reason": (
                "production_cpu_modal_nonzero_k_floquet_operator_missing"
            ),
            "production_cpu_rejection_scope": "selected_spectrum_nonzero_k_floquet_modal",
            "required_operator_contract": (
                "bloch_floquet_tangent_operator_with_periodic_pairs"
            ),
            "required_operator_payload_kind": "bloch_floquet_tangent_operator",
            "modal_periodic_pair_contract_available": False,
            "requested_window_hz": [1.0, 1.0e13],
            "requested_mode_count": 1,
            "resolved_search_window_hz": [0.0, 1.125e13],
            "window_completeness": {
                "policy": "best_effort",
                "status": "not_certified",
                "certification_method": "none",
                "estimated_modes_in_window": 1,
                "certified_modes_in_window": 0,
                "additional_modes_may_exist": False,
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
        }
    )
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "solver_diagnostics.window_completeness.additional_modes_may_exist" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_reference_full_2x2_floquet_window_without_manifest_rejection_reason(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.update(
        {
            "production_solver_available": False,
            "frequency_window_solver_policy": (
                "reference_k_path_window_filter_not_shift_invert_or_feast"
            ),
            "production_cpu_rejection_reason": (
                "production_cpu_modal_nonzero_k_floquet_operator_missing"
            ),
            "production_cpu_rejection_scope": "selected_spectrum_nonzero_k_floquet_modal",
            "required_operator_contract": (
                "bloch_floquet_tangent_operator_with_periodic_pairs"
            ),
            "required_operator_payload_kind": "bloch_floquet_tangent_operator",
            "modal_periodic_pair_contract_available": False,
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
        }
    )
    solver_path.write_text(json.dumps(solver))
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"].pop("production_cpu_rejection_reason", None)
    manifest["diagnostics"].pop("production_cpu_rejection_scope", None)
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "manifest.diagnostics.production_cpu_rejection_reason" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_reference_full_2x2_floquet_window_without_manifest_required_operator_contract(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.update(
        {
            "production_solver_available": False,
            "frequency_window_solver_policy": (
                "reference_k_path_window_filter_not_shift_invert_or_feast"
            ),
            "production_cpu_rejection_reason": (
                "production_cpu_modal_nonzero_k_floquet_operator_missing"
            ),
            "production_cpu_rejection_scope": "selected_spectrum_nonzero_k_floquet_modal",
            "required_operator_contract": (
                "bloch_floquet_tangent_operator_with_periodic_pairs"
            ),
            "required_operator_payload_kind": "bloch_floquet_tangent_operator",
            "modal_periodic_pair_contract_available": False,
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
        }
    )
    solver_path.write_text(json.dumps(solver))
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"].pop("required_operator_contract", None)
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "manifest.diagnostics.required_operator_contract" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_reference_full_2x2_floquet_window_without_manifest_required_operator_payload_kind(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.update(
        {
            "production_solver_available": False,
            "frequency_window_solver_policy": (
                "reference_k_path_window_filter_not_shift_invert_or_feast"
            ),
            "production_cpu_rejection_reason": (
                "production_cpu_modal_nonzero_k_floquet_operator_missing"
            ),
            "production_cpu_rejection_scope": "selected_spectrum_nonzero_k_floquet_modal",
            "required_operator_contract": (
                "bloch_floquet_tangent_operator_with_periodic_pairs"
            ),
            "required_operator_payload_kind": "bloch_floquet_tangent_operator",
            "modal_periodic_pair_contract_available": False,
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
        }
    )
    solver_path.write_text(json.dumps(solver))
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"].pop("required_operator_payload_kind", None)
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "manifest.diagnostics.required_operator_payload_kind" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_reference_full_2x2_floquet_window_without_manifest_periodic_pair_contract_flag(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.update(
        {
            "production_solver_available": False,
            "frequency_window_solver_policy": (
                "reference_k_path_window_filter_not_shift_invert_or_feast"
            ),
            "production_cpu_rejection_reason": (
                "production_cpu_modal_nonzero_k_floquet_operator_missing"
            ),
            "production_cpu_rejection_scope": "selected_spectrum_nonzero_k_floquet_modal",
            "required_operator_contract": (
                "bloch_floquet_tangent_operator_with_periodic_pairs"
            ),
            "required_operator_payload_kind": "bloch_floquet_tangent_operator",
            "modal_periodic_pair_contract_available": False,
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
        }
    )
    solver_path.write_text(json.dumps(solver))
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"].pop("modal_periodic_pair_contract_available", None)
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "manifest.diagnostics.modal_periodic_pair_contract_available" in (
        result.stderr + result.stdout
    )


def test_validator_accepts_reference_full_2x2_floquet_window_with_reference_policy(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.update(
        {
            "production_solver_available": False,
            "frequency_window_solver_policy": (
                "reference_k_path_window_filter_not_shift_invert_or_feast"
            ),
            "production_cpu_rejection_reason": (
                "production_cpu_modal_nonzero_k_floquet_operator_missing"
            ),
            "production_cpu_rejection_scope": "selected_spectrum_nonzero_k_floquet_modal",
            "required_operator_contract": (
                "bloch_floquet_tangent_operator_with_periodic_pairs"
            ),
            "required_operator_payload_kind": "bloch_floquet_tangent_operator",
            "modal_periodic_pair_contract_available": False,
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
        }
    )
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_reference_full_2x2_floquet_window_with_dynamic_demag_rejection(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    dynamic_demag_rejection = {
        "production_cpu_rejection_reason": (
            "production_cpu_modal_dynamic_demag_k_operator_missing"
        ),
        "production_cpu_rejection_scope": (
            "selected_spectrum_nonzero_k_floquet_modal_dynamic_demag"
        ),
        "required_operator_contract": (
            "bloch_floquet_tangent_operator_with_dynamic_demag_k"
        ),
        "required_operator_payload_kind": "bloch_floquet_tangent_operator",
        "required_demag_payload_kind": "dynamic_demag_k_operator",
        "dynamic_demag_operator_source": "missing_numeric_fem_demag_k",
        "modal_periodic_pair_contract_available": False,
    }
    solver.update(
        {
            "production_solver_available": False,
            "frequency_window_solver_policy": (
                "reference_k_path_window_filter_not_shift_invert_or_feast"
            ),
            **dynamic_demag_rejection,
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
        }
    )
    solver_path.write_text(json.dumps(solver))
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"].update(dynamic_demag_rejection)
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_reference_full_2x2_floquet_window_without_dynamic_demag_payload_kind(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.update(
        {
            "production_solver_available": False,
            "frequency_window_solver_policy": (
                "reference_k_path_window_filter_not_shift_invert_or_feast"
            ),
            "production_cpu_rejection_reason": (
                "production_cpu_modal_dynamic_demag_k_operator_missing"
            ),
            "production_cpu_rejection_scope": (
                "selected_spectrum_nonzero_k_floquet_modal_dynamic_demag"
            ),
            "required_operator_contract": (
                "bloch_floquet_tangent_operator_with_dynamic_demag_k"
            ),
            "required_operator_payload_kind": "bloch_floquet_tangent_operator",
            "dynamic_demag_operator_source": "missing_numeric_fem_demag_k",
            "modal_periodic_pair_contract_available": False,
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
        }
    )
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "solver_diagnostics.required_demag_payload_kind" in (
        result.stderr + result.stdout
    )


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
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_production_modal_k_path_without_dispersion_path_metadata(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    (tmp_path / "eigen" / "dispersion" / "path.json").unlink()

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "eigen/dispersion/path.json" in (result.stderr + result.stdout)


def test_validator_rejects_production_modal_k_path_with_non_eigen_stage_id(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["stage_id"] = "frequency_response"
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.stage_id" in (result.stderr + result.stdout)


def test_validator_rejects_production_modal_k_path_without_dispersion_capabilities(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    del manifest["capabilities"]["dispersion"]
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.capabilities.dispersion" in (result.stderr + result.stdout)


def test_validator_rejects_production_modal_k_path_with_demag_scope(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["requested_execution"]["include_demag"] = True
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.requested_execution.include_demag" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_with_dynamic_demag_realization(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["resolved_execution"]["demag_realization"] = "floquet_airbox"
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.resolved_execution.demag_realization" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_without_native_cpu_backend(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["resolved_execution"]["native_backend"] = "reference_cpu"
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.resolved_execution.native_backend" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_with_gpu_requested_device(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["requested_execution"]["device"] = "gpu"
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.requested_execution.device" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_with_non_fem_requested_backend(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["requested_execution"]["backend"] = "fdm"
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.requested_execution.backend" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_with_gpu_resolved_device(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["resolved_execution"]["device"] = "gpu"
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.resolved_execution.device" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_with_non_fem_resolved_backend(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["resolved_execution"]["backend"] = "fdm"
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.resolved_execution.backend" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_without_slepc_algorithm(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["resolved_execution"]["solver_algorithm"] = "reference_full_2x2_tangent"
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.resolved_execution.solver_algorithm" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_without_modal_solve_kind(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["resolved_execution"]["solve_kind"] = "driven_response"
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.resolved_execution.solve_kind" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_without_modal_solver_family_intent(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["requested_execution"]["solver_family"] = "driven_response"
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.requested_execution.solver_family" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_without_dispersion_modal_calculation_mode(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["requested_execution"]["calculation_mode"] = "frequency_response"
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.requested_execution.calculation_mode" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_without_modal_solve_equation(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["requested_execution"]["solve_equation"] = "(i omega B - A) q = b"
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.requested_execution.solve_equation" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_without_production_resolution(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["resolved_execution"]["reference_or_production"] = "reference"
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.resolved_execution.reference_or_production" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_with_driven_response_artifact(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["artifacts"]["response_sweep_v1_path"] = "response/sweep.v1.json"
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.artifacts.response_sweep_v1_path" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_without_modal_artifact_capability(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["capabilities"]["modal_artifact_available"] = False
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.capabilities.modal_artifact_available" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_with_gated_operator_term(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["requested_execution"]["operator_terms_included"] = ["exchange", "dmi"]
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.requested_execution.operator_terms_included" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_certified_window_overclaim(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver["window_completeness"] = {
        "policy": "certified_count",
        "status": "certified",
        "certification_method": "contour_count",
        "estimated_modes_in_window": 1,
        "certified_modes_in_window": 1,
        "additional_modes_may_exist": False,
    }
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "solver_diagnostics.window_completeness.status" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_with_large_mode_residual(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    spectrum_path = tmp_path / "eigen" / "spectrum.v2.json"
    spectrum = json.loads(spectrum_path.read_text())
    spectrum["samples"][1]["modes"][0]["residual_relative_l2"] = 1.0e-3
    spectrum_path.write_text(json.dumps(spectrum))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "residual_relative_l2" in (result.stderr + result.stdout)


def test_validator_rejects_production_modal_k_path_with_large_solver_subwindow_residual(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver["subwindows"][0]["residual_max"] = 1.0e-3
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "solver_diagnostics.subwindows[0].residual_max" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_without_accepted_subwindow_modes(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver["subwindows"][0]["accepted_modes"] = 0
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "solver_diagnostics.subwindows[0].accepted_modes" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_with_large_tangent_leakage(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    spectrum_path = tmp_path / "eigen" / "spectrum.v2.json"
    spectrum = json.loads(spectrum_path.read_text())
    spectrum["samples"][0]["modes"][0]["tangent_leakage_max_abs"] = 1.0e-4
    spectrum_path.write_text(json.dumps(spectrum))
    mode_path = tmp_path / "eigen" / "modes" / "sample_0000" / "mode_0000.json"
    mode = json.loads(mode_path.read_text())
    mode["tangent_leakage_max_abs"] = 1.0e-4
    mode_path.write_text(json.dumps(mode))
    summary_path = tmp_path / "eigen" / "metadata" / "eigen_summary.json"
    summary = json.loads(summary_path.read_text())
    summary["modes"][0]["tangent_leakage_max_abs"] = 1.0e-4
    summary_path.write_text(json.dumps(summary))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "tangent_leakage_max_abs" in (result.stderr + result.stdout)


def test_validator_rejects_production_modal_k_path_without_modal_overlap_tracking(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    branches_path = tmp_path / "eigen" / "branches.v2.json"
    branches = json.loads(branches_path.read_text())
    for branch in branches["branches"]:
        for point in branch["points"]:
            if point["tracking_score_source"] == "seed":
                continue
            point["tracking_score_source"] = "frequency_score_fallback"
            point["modal_overlap_available"] = False
            point["modal_overlap_unavailable_reason"] = "mode_vectors_unavailable"
    branches_path.write_text(json.dumps(branches))
    dispersion_path = tmp_path / "eigen" / "dispersion.csv"
    dispersion_path.write_text(
        dispersion_path.read_text().replace(
            "modal_overlap_weighted_score",
            "frequency_score_fallback",
        )
    )

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "modal-overlap branch tracking" in (result.stderr + result.stdout)


def test_validator_rejects_production_modal_k_path_manifest_tracking_drift(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    periodic_mesh_certificate = manifest["diagnostics"]["periodic_mesh_certificate"]
    manifest["diagnostics"] = {
        "tracking_score_source": "frequency_score_fallback",
        "modal_overlap_available": False,
        "modal_overlap_unavailable_reason": "mode_vectors_unavailable",
        "periodic_mesh_certificate": periodic_mesh_certificate,
    }
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.diagnostics.modal_overlap_available" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_mixed_manifest_tracking_source(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"]["tracking_score_source"] = (
        "mixed_modal_overlap_and_frequency_fallback"
    )
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.diagnostics.tracking_score_source" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_stale_manifest_overlap_unavailable_reason(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"]["modal_overlap_unavailable_reason"] = "mode_vectors_unavailable"
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.diagnostics.modal_overlap_unavailable_reason" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_branch_summary_tracking_drift(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    branches_path = tmp_path / "eigen" / "branches.v2.json"
    branches = json.loads(branches_path.read_text())
    branches["tracking_score_source"] = "seed_only"
    branches["diagnostics"]["tracking_score_source"] = "seed_only"
    branches_path.write_text(json.dumps(branches))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "branches.tracking_score_source" in (result.stderr + result.stdout)


def test_validator_rejects_production_modal_k_path_without_vector_tracking_method(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    branches_path = tmp_path / "eigen" / "branches.v2.json"
    branches = json.loads(branches_path.read_text())
    branches["tracking_method"] = "frequency_order"
    branches_path.write_text(json.dumps(branches))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "branches.tracking_method" in (result.stderr + result.stdout)


def test_validator_rejects_production_modal_k_path_overlap_below_floor(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    branches_path = tmp_path / "eigen" / "branches.v2.json"
    branches = json.loads(branches_path.read_text())
    branches["overlap_floor"] = 0.5
    branches["diagnostics"]["min_overlap"] = 0.1
    branches["branches"][0]["points"][1]["overlap_prev"] = 0.1
    branches["branches"][0]["points"][1]["tracking_confidence"] = 0.1
    branches_path.write_text(json.dumps(branches))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "overlap_floor" in (result.stderr + result.stdout)


def test_validator_rejects_production_modal_k_path_min_overlap_drift(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    branches_path = tmp_path / "eigen" / "branches.v2.json"
    branches = json.loads(branches_path.read_text())
    branches["diagnostics"]["min_overlap"] = 0.9
    branches_path.write_text(json.dumps(branches))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "branches.diagnostics.min_overlap" in (result.stderr + result.stdout)


def test_validator_rejects_production_modal_k_path_missing_median_overlap(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    branches_path = tmp_path / "eigen" / "branches.v2.json"
    branches = json.loads(branches_path.read_text())
    del branches["diagnostics"]["median_overlap"]
    branches_path.write_text(json.dumps(branches))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "branches.diagnostics.median_overlap" in (result.stderr + result.stdout)


def test_validator_rejects_production_modal_k_path_modal_overlap_without_overlap_prev(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    branches_path = tmp_path / "eigen" / "branches.v2.json"
    branches = json.loads(branches_path.read_text())
    del branches["branches"][0]["points"][1]["overlap_prev"]
    branches_path.write_text(json.dumps(branches))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "branch point.overlap_prev" in (result.stderr + result.stdout)


def test_validator_rejects_production_modal_k_path_dispersion_overlap_drift(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    dispersion_path = tmp_path / "eigen" / "dispersion.csv"
    dispersion_path.write_text(
        dispersion_path.read_text().replace(
            "0.8,modal_overlap_weighted_score",
            "0.1,modal_overlap_weighted_score",
            1,
        )
    )

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "dispersion row 1.overlap_score" in (result.stderr + result.stdout)


def test_validator_rejects_production_modal_k_path_tracking_confidence_drift(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    branches_path = tmp_path / "eigen" / "branches.v2.json"
    branches = json.loads(branches_path.read_text())
    branches["branches"][0]["points"][1]["tracking_confidence"] = 0.1
    branches_path.write_text(json.dumps(branches))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "branch point.tracking_confidence" in (result.stderr + result.stdout)


def test_validator_rejects_production_modal_k_path_without_manifest_capability(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["capabilities"] = {
        "production_native_solver_available": False,
        "validation_artifact": True,
    }
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.capabilities.dispersion" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_gamma_only_when_nonzero_production_modal_k_path_required(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=(1.0e9, 1.0e9, 1.0e9),
        kx_rad_m=(0.0, 0.0, 0.0),
        path_s_rad_m=(0.0, 0.0, 0.0),
    )
    mark_production_shift_invert_k_path_fixture(tmp_path)

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "production nonzero-k modal dispersion" in (result.stderr + result.stdout)


def test_validator_accepts_production_gamma_k_path_provenance(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=(1.0e9, 1.0e9, 1.0e9),
        kx_rad_m=(0.0, 0.0, 0.0),
        path_s_rad_m=(0.0, 1.0, 2.0),
    )
    mark_production_shift_invert_k_path_fixture(tmp_path)

    result = run_validator(tmp_path, "--require-production-gamma-k-path")

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_production_gamma_k_path_with_k0_demag(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=(1.0e9, 1.0e9, 1.0e9),
        kx_rad_m=(0.0, 0.0, 0.0),
        path_s_rad_m=(0.0, 0.0, 0.0),
    )
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["requested_execution"]["include_demag"] = True
    manifest["resolved_execution"]["demag_realization"] = "requested"
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-gamma-k-path")

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_nonzero_k_when_gamma_production_k_path_required(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)

    result = run_validator(tmp_path, "--require-production-gamma-k-path")

    assert result.returncode != 0
    assert "production gamma k-path" in (result.stderr + result.stdout)


def test_validator_rejects_production_modal_k_path_wrong_phasor_convention(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver["phasor_convention"] = "exp_minus_i_omega_t"
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "solver_diagnostics.phasor_convention" in (result.stderr + result.stdout)


def test_validator_rejects_production_modal_k_path_manifest_phasor_mismatch(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["physics"]["phase_convention"] = "exp_minus_i_omega_t"
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.physics.phase_convention" in (result.stderr + result.stdout)


def test_validator_rejects_production_modal_k_path_without_transport_policy(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.pop("basis_transport_policy", None)
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "solver_diagnostics.basis_transport_policy" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_without_bloch_payload(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.pop("operator_diagnostics", None)
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "solver_diagnostics.operator_diagnostics" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_without_periodic_pair_contract(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.pop("modal_periodic_pair_contract_available", None)
    solver.pop("floquet_periodic_pair_count", None)
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "solver_diagnostics.modal_periodic_pair_contract_available" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_without_periodic_mesh_certificate(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver.pop("periodic_mesh_certificate", None)
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "solver_diagnostics.periodic_mesh_certificate" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_manifest_pair_map_hash_drift(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["diagnostics"]["periodic_mesh_certificate"]["magnetic_pair_map_sha256"] = (
        "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
    )
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "manifest.diagnostics.periodic_mesh_certificate.magnetic_pair_map_sha256" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_production_modal_k_path_with_demag_payload_claim(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)
    mark_production_shift_invert_k_path_fixture(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver["operator_diagnostics"]["demag_payload_kind"] = "dynamic_demag_k_operator"
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-production-modal-k-path")

    assert result.returncode != 0
    assert "solver_diagnostics.operator_diagnostics.demag_payload_kind" in (
        result.stderr + result.stdout
    )


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


def test_validator_rejects_reference_full_2x2_floquet_without_k_path(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    mark_reference_full_2x2_floquet_fixture(tmp_path)

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "eigen/dispersion/path.json" in (result.stderr + result.stdout)


def test_validator_rejects_flat_reference_full_2x2_floquet_dispersion(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=(1.0e9, 1.0e9, 1.0e9),
    )

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode != 0
    assert "reference Full2x2 Floquet dispersion frequency span" in (
        result.stderr + result.stdout
    )


def test_validator_accepts_nonflat_reference_full_2x2_floquet_k_path(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(tmp_path)

    result = run_validator(tmp_path, "--require-reference-full-2x2-floquet")

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_exchange_only_analytic_reference_dispersion(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=tuple(
            exchange_only_expected_frequency_hz(kx) for kx in (0.0, 1.0e7, 2.0e7)
        ),
    )
    write_exchange_only_dispersion_metadata(tmp_path)

    result = run_validator(
        tmp_path,
        "--require-reference-full-2x2-floquet",
        "--require-exchange-only-analytic-dispersion",
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_k0_kittel_field_sweep(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=tuple(k0_kittel_expected_frequency_hz(field) for field in fields),
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path)

    result = run_validator(tmp_path, "--require-k0-kittel-field-sweep")

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_k0_kittel_summary_and_points(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    frequencies = tuple(k0_kittel_expected_frequency_hz(field) for field in fields)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path)
    write_k0_kittel_summary_and_points(tmp_path, fields, frequencies)

    result = run_validator(tmp_path, "--require-k0-kittel-field-sweep")

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_k0_kittel_demag_contract(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    frequencies = tuple(k0_kittel_expected_frequency_hz(field) for field in fields)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path)
    write_k0_kittel_summary_and_points(tmp_path, fields, frequencies)

    result = run_validator(tmp_path, "--require-k0-kittel-demag")

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_k0_kittel_demag_contract_with_binary_mode_exports(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    frequencies = tuple(k0_kittel_expected_frequency_hz(field) for field in fields)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path)
    write_k0_kittel_summary_and_points(tmp_path, fields, frequencies)
    make_mode_fields_binary_only(tmp_path)

    result = run_validator(tmp_path, "--require-k0-kittel-demag")

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_k0_kittel_demag_without_case_id(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    frequencies = tuple(k0_kittel_expected_frequency_hz(field) for field in fields)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path)
    metadata_path = tmp_path / "metadata.json"
    metadata = json.loads(metadata_path.read_text())
    del metadata["execution_plan"]["backend_plan"]["k0_kittel_validation"]["case_id"]
    metadata_path.write_text(json.dumps(metadata))
    write_k0_kittel_summary_and_points(tmp_path, fields, frequencies)

    result = run_validator(tmp_path, "--require-k0-kittel-demag")

    assert result.returncode != 0
    assert "k0_kittel_validation.case_id" in (result.stderr + result.stdout)


def test_validator_accepts_k0_kittel_periodic_airbox_contract_with_convergence(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    frequencies = tuple(k0_kittel_expected_frequency_hz(field) for field in fields)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path, demag_kind="periodic_airbox_k0")
    write_k0_kittel_summary_and_points(
        tmp_path,
        fields,
        frequencies,
        demag_kind="periodic_airbox_k0",
    )
    write_k0_kittel_convergence_table(tmp_path)
    mark_poisson_airbox_k0_solver_fixture(tmp_path)
    mark_relaxed_equilibrium_fixture(tmp_path)

    result = run_validator(tmp_path, "--require-k0-kittel-periodic-airbox-demag")

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_synthetic_periodic_airbox_production_claim(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    frequencies = tuple(k0_kittel_expected_frequency_hz(field) for field in fields)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path, demag_kind="periodic_airbox_k0")
    write_k0_kittel_summary_and_points(
        tmp_path,
        fields,
        frequencies,
        demag_kind="periodic_airbox_k0",
    )
    write_k0_kittel_convergence_table(tmp_path)
    mark_poisson_airbox_k0_solver_fixture(tmp_path)
    mark_relaxed_equilibrium_fixture(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver["assembly_kind"] = "synthetic_algebraic_oracle"
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-k0-kittel-periodic-airbox-demag")

    assert result.returncode != 0
    assert "solver_diagnostics.assembly_kind" in (result.stderr + result.stdout)


def test_validator_rejects_periodic_airbox_kittel_without_poisson_airbox_solver(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    frequencies = tuple(k0_kittel_expected_frequency_hz(field) for field in fields)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path, demag_kind="periodic_airbox_k0")
    write_k0_kittel_summary_and_points(
        tmp_path,
        fields,
        frequencies,
        demag_kind="periodic_airbox_k0",
    )
    write_k0_kittel_convergence_table(tmp_path)
    mark_relaxed_equilibrium_fixture(tmp_path)

    result = run_validator(tmp_path, "--require-k0-kittel-periodic-airbox-demag")

    assert result.returncode != 0
    assert "certified CPU or GPU K0 periodic-airbox adapter" in (result.stderr + result.stdout)


def test_validator_rejects_periodic_airbox_kittel_with_reference_solver_model(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    frequencies = tuple(k0_kittel_expected_frequency_hz(field) for field in fields)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path, demag_kind="periodic_airbox_k0")
    write_k0_kittel_summary_and_points(
        tmp_path,
        fields,
        frequencies,
        demag_kind="periodic_airbox_k0",
    )
    write_k0_kittel_convergence_table(tmp_path)
    mark_poisson_airbox_k0_solver_fixture(tmp_path)
    mark_relaxed_equilibrium_fixture(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver["solver_model"] = "reference_full_2x2_tangent"
    solver_path.write_text(json.dumps(solver))

    result = run_validator(tmp_path, "--require-k0-kittel-periodic-airbox-demag")

    assert result.returncode != 0
    assert "solver_diagnostics.solver_model" in (result.stderr + result.stdout)


def test_validator_rejects_periodic_airbox_kittel_without_relaxed_equilibrium(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    frequencies = tuple(k0_kittel_expected_frequency_hz(field) for field in fields)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path, demag_kind="periodic_airbox_k0")
    write_k0_kittel_summary_and_points(
        tmp_path,
        fields,
        frequencies,
        demag_kind="periodic_airbox_k0",
    )
    write_k0_kittel_convergence_table(tmp_path)
    mark_poisson_airbox_k0_solver_fixture(tmp_path)

    result = run_validator(tmp_path, "--require-k0-kittel-periodic-airbox-demag")

    assert result.returncode != 0
    assert "relaxed_initial_state" in (result.stderr + result.stdout)


def test_validator_accepts_periodic_airbox_kittel_relaxed_stage_handoff(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    frequencies = tuple(k0_kittel_expected_frequency_hz(field) for field in fields)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path, demag_kind="periodic_airbox_k0")
    write_k0_kittel_summary_and_points(
        tmp_path,
        fields,
        frequencies,
        demag_kind="periodic_airbox_k0",
    )
    write_k0_kittel_convergence_table(tmp_path)
    mark_poisson_airbox_k0_solver_fixture(tmp_path)
    mark_relaxed_equilibrium_fixture(tmp_path, steps=0, handoff="stage_continuation")

    result = run_validator(tmp_path, "--require-k0-kittel-periodic-airbox-demag")

    assert result.returncode == 0, result.stderr + result.stdout


def write_periodic_airbox_convergence_fixture_set(
    tmp_path: Path,
) -> tuple[list[Path], list[Path]]:
    mesh_roots = [tmp_path / f"mesh_{index}" for index in range(3)]
    airbox_roots = [tmp_path / f"airbox_{index}" for index in range(3)]
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    frequencies = tuple(k0_kittel_expected_frequency_hz(field) for field in fields)
    configurations = [
        *((root, mesh_resolution, 100e-9) for root, mesh_resolution in zip(mesh_roots, (30e-9, 20e-9, 10e-9), strict=True)),
        *((root, 10e-9, airbox_size) for root, airbox_size in zip(airbox_roots, (60e-9, 80e-9, 100e-9), strict=True)),
    ]
    for root, mesh_resolution, airbox_size in configurations:
        write_eigen_fixture(root)
        expand_reference_floquet_fixture_to_k_path(
            root,
            frequencies_hz=frequencies,
            k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
        )
        write_k0_kittel_field_sweep_metadata(root, demag_kind="periodic_airbox_k0")
        write_k0_kittel_summary_and_points(
            root,
            fields,
            frequencies,
            demag_kind="periodic_airbox_k0",
        )
        write_k0_kittel_convergence_table(
            root,
            mesh_resolution_m=mesh_resolution,
            airbox_size_m=airbox_size,
        )
        mark_poisson_airbox_k0_solver_fixture(root)
        mark_relaxed_equilibrium_fixture(root)
    return mesh_roots, airbox_roots


def test_periodic_airbox_convergence_validator_accepts_independent_three_level_sequences(
    tmp_path: Path,
) -> None:
    mesh_roots, airbox_roots = write_periodic_airbox_convergence_fixture_set(tmp_path)

    result = run_periodic_airbox_convergence_validator(mesh_roots, airbox_roots)

    assert result.returncode == 0, result.stderr + result.stdout
    assert '"level_count": 3' in result.stdout


def test_periodic_airbox_convergence_validator_rejects_single_mesh_resolution(
    tmp_path: Path,
) -> None:
    mesh_roots, airbox_roots = write_periodic_airbox_convergence_fixture_set(tmp_path)
    for root in mesh_roots:
        write_k0_kittel_convergence_table(
            root,
            mesh_resolution_m=20e-9,
            airbox_size_m=100e-9,
        )

    result = run_periodic_airbox_convergence_validator(mesh_roots, airbox_roots)

    assert result.returncode != 0
    assert "distinct runtime signatures" in (result.stderr + result.stdout)


def test_periodic_airbox_convergence_validator_rejects_reference_solver_model(
    tmp_path: Path,
) -> None:
    mesh_roots, airbox_roots = write_periodic_airbox_convergence_fixture_set(tmp_path)
    solver_path = mesh_roots[0] / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver["solver_model"] = "reference_full_2x2_tangent"
    solver_path.write_text(json.dumps(solver))

    result = run_periodic_airbox_convergence_validator(mesh_roots, airbox_roots)

    assert result.returncode != 0
    assert "solver_model" in (result.stderr + result.stdout)


def test_validator_rejects_synthetic_k0_kittel_for_periodic_airbox_gate(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    frequencies = tuple(k0_kittel_expected_frequency_hz(field) for field in fields)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path)
    write_k0_kittel_summary_and_points(tmp_path, fields, frequencies)

    result = run_validator(tmp_path, "--require-k0-kittel-periodic-airbox-demag")

    assert result.returncode != 0
    assert "periodic_airbox_k0" in (result.stderr + result.stdout)


def test_validator_rejects_k0_kittel_periodic_airbox_without_convergence(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    frequencies = tuple(k0_kittel_expected_frequency_hz(field) for field in fields)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path, demag_kind="periodic_airbox_k0")
    write_k0_kittel_summary_and_points(
        tmp_path,
        fields,
        frequencies,
        demag_kind="periodic_airbox_k0",
    )
    mark_poisson_airbox_k0_solver_fixture(tmp_path)
    mark_relaxed_equilibrium_fixture(tmp_path)

    result = run_validator(tmp_path, "--require-k0-kittel-demag")

    assert result.returncode != 0
    assert "convergence.v1.csv" in (result.stderr + result.stdout)


def test_validator_accepts_gpu_modal_k0_kittel_provenance(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    frequencies = tuple(k0_kittel_expected_frequency_hz(field) for field in fields)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path)
    write_k0_kittel_summary_and_points(tmp_path, fields, frequencies)
    mark_gpu_modal_k0_kittel_fixture(tmp_path)

    result = run_validator(
        tmp_path,
        "--require-k0-kittel-field-sweep",
        "--require-gpu-modal-k0-kittel-provenance",
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_gpu_modal_k0_periodic_airbox_provenance(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    frequencies = tuple(k0_kittel_expected_frequency_hz(field) for field in fields)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path, demag_kind="periodic_airbox_k0")
    write_k0_kittel_summary_and_points(
        tmp_path,
        fields,
        frequencies,
        demag_kind="periodic_airbox_k0",
    )
    write_k0_kittel_convergence_table(tmp_path)
    mark_gpu_modal_k0_periodic_airbox_fixture(tmp_path)
    mark_relaxed_equilibrium_fixture(tmp_path)

    result = run_validator(
        tmp_path,
        "--require-gpu-modal-k0-periodic-airbox-provenance",
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_gpu_periodic_airbox_hidden_cpu_fallback(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    frequencies = tuple(k0_kittel_expected_frequency_hz(field) for field in fields)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path, demag_kind="periodic_airbox_k0")
    write_k0_kittel_summary_and_points(
        tmp_path,
        fields,
        frequencies,
        demag_kind="periodic_airbox_k0",
    )
    write_k0_kittel_convergence_table(tmp_path)
    mark_gpu_modal_k0_periodic_airbox_fixture(tmp_path)
    mark_relaxed_equilibrium_fixture(tmp_path)
    solver_path = tmp_path / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text())
    solver["sample_solver_diagnostics"][0]["diagnostics"]["fallback_used"] = True
    solver_path.write_text(json.dumps(solver))

    result = run_validator(
        tmp_path,
        "--require-gpu-modal-k0-periodic-airbox-provenance",
    )

    assert result.returncode != 0
    assert "fallback_used" in (result.stderr + result.stdout)


def test_validator_rejects_cpu_k0_kittel_as_gpu_provenance(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    frequencies = tuple(k0_kittel_expected_frequency_hz(field) for field in fields)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path)
    write_k0_kittel_summary_and_points(tmp_path, fields, frequencies)

    result = run_validator(
        tmp_path,
        "--require-k0-kittel-field-sweep",
        "--require-gpu-modal-k0-kittel-provenance",
    )

    assert result.returncode != 0
    assert "manifest.requested_execution" in (result.stderr + result.stdout)


def test_validator_rejects_k0_kittel_summary_point_count_mismatch(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    frequencies = tuple(k0_kittel_expected_frequency_hz(field) for field in fields)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path)
    write_k0_kittel_summary_and_points(
        tmp_path,
        fields,
        frequencies,
        sweep_point_count=2,
    )

    result = run_validator(tmp_path, "--require-k0-kittel-field-sweep")

    assert result.returncode != 0
    assert "kittel_k0_pbc" in (result.stderr + result.stdout)


def test_validator_rejects_k0_kittel_field_sweep_wrong_scale(
    tmp_path: Path,
) -> None:
    fields = (20e-3 / MU0, 50e-3 / MU0, 100e-3 / MU0)
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=tuple(2.0 * k0_kittel_expected_frequency_hz(field) for field in fields),
        k_vectors_rad_m=((0.0, 0.0, 0.0),) * len(fields),
    )
    write_k0_kittel_field_sweep_metadata(tmp_path)

    result = run_validator(tmp_path, "--require-k0-kittel-field-sweep")

    assert result.returncode != 0
    assert "k0 Kittel field sweep" in (result.stderr + result.stdout)


def test_validator_rejects_exchange_only_dispersion_with_wrong_scale(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=tuple(
            10.0 * exchange_only_expected_frequency_hz(kx)
            for kx in (0.0, 1.0e7, 2.0e7)
        ),
    )
    write_exchange_only_dispersion_metadata(tmp_path)

    result = run_validator(
        tmp_path,
        "--require-reference-full-2x2-floquet",
        "--require-exchange-only-analytic-dispersion",
    )

    assert result.returncode != 0
    assert "exchange-only analytic dispersion" in (result.stderr + result.stdout)


def test_validator_accepts_exchange_only_reciprocal_reference_dispersion(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=tuple(
            exchange_only_expected_frequency_hz(kx) for kx in (0.0, 1.0e7, -1.0e7)
        ),
        kx_rad_m=(0.0, 1.0e7, -1.0e7),
        path_s_rad_m=(0.0, 1.0e7, 3.0e7),
    )
    write_exchange_only_dispersion_metadata(tmp_path)

    result = run_validator(
        tmp_path,
        "--require-reference-full-2x2-floquet",
        "--require-exchange-only-analytic-dispersion",
        "--require-exchange-only-reciprocal-dispersion",
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_exchange_only_nonreciprocal_reference_dispersion(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    plus_k_frequency_hz = exchange_only_expected_frequency_hz(1.0e7)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=(
            exchange_only_expected_frequency_hz(0.0),
            plus_k_frequency_hz,
            plus_k_frequency_hz * 1.1,
        ),
        kx_rad_m=(0.0, 1.0e7, -1.0e7),
        path_s_rad_m=(0.0, 1.0e7, 3.0e7),
    )
    write_exchange_only_dispersion_metadata(tmp_path)

    result = run_validator(
        tmp_path,
        "--require-reference-full-2x2-floquet",
        "--require-exchange-only-analytic-dispersion",
        "--require-exchange-only-reciprocal-dispersion",
    )

    assert result.returncode != 0
    assert "exchange-only reciprocal dispersion" in (result.stderr + result.stdout)


def test_validator_accepts_low_k_de_bv_analytic_dispersion(
    tmp_path: Path,
) -> None:
    k_vectors = (
        (0.0, 0.0, 0.0),
        (1.5e6, 0.0, 0.0),
        (3.0e6, 0.0, 0.0),
        (0.0, 0.0, 0.0),
        (0.0, 1.5e6, 0.0),
        (0.0, 3.0e6, 0.0),
    )
    frequencies = (
        low_k_de_bv_expected_frequency_hz(k_vectors[0], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[1], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[2], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[3], "damon_eshbach"),
        low_k_de_bv_expected_frequency_hz(k_vectors[4], "damon_eshbach"),
        low_k_de_bv_expected_frequency_hz(k_vectors[5], "damon_eshbach"),
    )
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=k_vectors,
    )
    write_low_k_de_bv_dispersion_metadata(tmp_path)

    result = run_validator(
        tmp_path,
        "--require-reference-full-2x2-floquet",
        "--require-low-k-de-bv-analytic-dispersion",
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_low_k_de_bv_manifest_validation_mismatch(
    tmp_path: Path,
) -> None:
    k_vectors = (
        (0.0, 0.0, 0.0),
        (1.5e6, 0.0, 0.0),
        (3.0e6, 0.0, 0.0),
        (0.0, 0.0, 0.0),
        (0.0, 1.5e6, 0.0),
        (0.0, 3.0e6, 0.0),
    )
    frequencies = (
        low_k_de_bv_expected_frequency_hz(k_vectors[0], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[1], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[2], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[3], "damon_eshbach"),
        low_k_de_bv_expected_frequency_hz(k_vectors[4], "damon_eshbach"),
        low_k_de_bv_expected_frequency_hz(k_vectors[5], "damon_eshbach"),
    )
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=k_vectors,
    )
    write_low_k_de_bv_dispersion_metadata(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["validation"]["dispersion_validation"]["max_k_rad_per_m"] = 2.0e6
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(
        tmp_path,
        "--require-reference-full-2x2-floquet",
        "--require-low-k-de-bv-analytic-dispersion",
    )

    assert result.returncode != 0
    assert "manifest.validation.dispersion_validation" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_low_k_de_bv_missing_frequency_source(
    tmp_path: Path,
) -> None:
    k_vectors = (
        (0.0, 0.0, 0.0),
        (1.5e6, 0.0, 0.0),
        (3.0e6, 0.0, 0.0),
        (0.0, 0.0, 0.0),
        (0.0, 1.5e6, 0.0),
        (0.0, 3.0e6, 0.0),
    )
    frequencies = (
        low_k_de_bv_expected_frequency_hz(k_vectors[0], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[1], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[2], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[3], "damon_eshbach"),
        low_k_de_bv_expected_frequency_hz(k_vectors[4], "damon_eshbach"),
        low_k_de_bv_expected_frequency_hz(k_vectors[5], "damon_eshbach"),
    )
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=k_vectors,
    )
    write_low_k_de_bv_dispersion_metadata(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    del manifest["validation"]["dispersion_frequency_source"]
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(
        tmp_path,
        "--require-reference-full-2x2-floquet",
        "--require-low-k-de-bv-analytic-dispersion",
    )

    assert result.returncode != 0
    assert "manifest.validation.dispersion_frequency_source" in (
        result.stderr + result.stdout
    )


def test_validator_accepts_low_k_de_bv_branch_label_metadata(
    tmp_path: Path,
) -> None:
    k_vectors = [
        (0.0, 0.0, 0.0),
        (1.5e6, 0.0, 0.0),
        (3.0e6, 0.0, 0.0),
        (0.0, 0.0, 0.0),
        (0.0, 1.5e6, 0.0),
        (0.0, 3.0e6, 0.0),
    ]
    frequencies = [
        low_k_de_bv_expected_frequency_hz(k_vectors[0], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[1], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[2], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[3], "damon_eshbach"),
        low_k_de_bv_expected_frequency_hz(k_vectors[4], "damon_eshbach"),
        low_k_de_bv_expected_frequency_hz(k_vectors[5], "damon_eshbach"),
    ]
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=k_vectors,
    )
    write_low_k_de_bv_dispersion_metadata(
        tmp_path,
        frequency_window_hz={"min": 0.0, "max": 5.0e9},
        scenarios=[
            {
                "geometry": "backward_volume",
                "branch_id": "branch_0",
                "sample_indices": [0, 1, 2],
            },
            {
                "geometry": "damon_eshbach",
                "branch_id": "branch_0",
                "sample_indices": [3, 4, 5],
            },
        ],
    )

    result = run_validator(
        tmp_path,
        "--require-reference-full-2x2-floquet",
        "--require-low-k-de-bv-analytic-dispersion",
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_accepts_low_k_de_bv_binary_mode_fields(
    tmp_path: Path,
) -> None:
    k_vectors = [
        (0.0, 0.0, 0.0),
        (1.5e6, 0.0, 0.0),
        (3.0e6, 0.0, 0.0),
        (0.0, 0.0, 0.0),
        (0.0, 1.5e6, 0.0),
        (0.0, 3.0e6, 0.0),
    ]
    frequencies = [
        low_k_de_bv_expected_frequency_hz(k_vectors[0], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[1], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[2], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[3], "damon_eshbach"),
        low_k_de_bv_expected_frequency_hz(k_vectors[4], "damon_eshbach"),
        low_k_de_bv_expected_frequency_hz(k_vectors[5], "damon_eshbach"),
    ]
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=tuple(frequencies),
        k_vectors_rad_m=tuple(k_vectors),
    )
    write_low_k_de_bv_dispersion_metadata(
        tmp_path,
        scenarios=[
            {
                "geometry": "backward_volume",
                "branch_id": "branch_0",
                "sample_indices": [0, 1, 2],
            },
            {
                "geometry": "damon_eshbach",
                "branch_id": "branch_0",
                "sample_indices": [3, 4, 5],
            },
        ],
    )
    make_mode_fields_binary_only(tmp_path)

    result = run_validator(
        tmp_path,
        "--require-low-k-de-bv-analytic-dispersion",
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_low_k_de_bv_dispersion_outside_k_range(
    tmp_path: Path,
) -> None:
    k_vectors = (
        (0.0, 0.0, 0.0),
        (1.5e6, 0.0, 0.0),
        (4.0e6, 0.0, 0.0),
        (0.0, 0.0, 0.0),
        (0.0, 1.5e6, 0.0),
        (0.0, 3.0e6, 0.0),
    )
    frequencies = (
        low_k_de_bv_expected_frequency_hz(k_vectors[0], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[1], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[2], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[3], "damon_eshbach"),
        low_k_de_bv_expected_frequency_hz(k_vectors[4], "damon_eshbach"),
        low_k_de_bv_expected_frequency_hz(k_vectors[5], "damon_eshbach"),
    )
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=k_vectors,
    )
    write_low_k_de_bv_dispersion_metadata(tmp_path)

    result = run_validator(
        tmp_path,
        "--require-reference-full-2x2-floquet",
        "--require-low-k-de-bv-analytic-dispersion",
    )

    assert result.returncode != 0
    assert "exceeds low-k range" in (result.stderr + result.stdout)


def test_validator_rejects_low_k_de_bv_dispersion_wrong_orientation(
    tmp_path: Path,
) -> None:
    k_vectors = (
        (0.0, 0.0, 0.0),
        (1.5e6, 0.0, 0.0),
        (3.0e6, 0.0, 0.0),
        (0.0, 0.0, 0.0),
        (1.5e6, 0.0, 0.0),
        (3.0e6, 0.0, 0.0),
    )
    frequencies = (
        low_k_de_bv_expected_frequency_hz(k_vectors[0], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[1], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[2], "backward_volume"),
        low_k_de_bv_expected_frequency_hz(k_vectors[3], "damon_eshbach"),
        low_k_de_bv_expected_frequency_hz(k_vectors[4], "damon_eshbach"),
        low_k_de_bv_expected_frequency_hz(k_vectors[5], "damon_eshbach"),
    )
    write_eigen_fixture(tmp_path)
    expand_reference_floquet_fixture_to_k_path(
        tmp_path,
        frequencies_hz=frequencies,
        k_vectors_rad_m=k_vectors,
    )
    write_low_k_de_bv_dispersion_metadata(
        tmp_path,
        scenarios=[
            {
                "geometry": "backward_volume",
                "branch_id": 0,
                "sample_indices": [0, 1, 2],
            },
            {
                "geometry": "damon_eshbach",
                "branch_id": 0,
                "sample_indices": [3, 4, 5],
            },
        ],
    )

    result = run_validator(
        tmp_path,
        "--require-reference-full-2x2-floquet",
        "--require-low-k-de-bv-analytic-dispersion",
    )

    assert result.returncode != 0
    assert "perpendicular to equilibrium magnetization" in (result.stderr + result.stdout)


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


def test_validator_accepts_complete_typed_modal_field_sweep(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    write_typed_field_sweep_fixture(tmp_path)

    result = run_validator(tmp_path)

    assert result.returncode == 0, result.stderr + result.stdout


def test_validator_rejects_typed_field_sweep_payload_self_digest_mismatch(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    artifact = write_typed_field_sweep_fixture(tmp_path)
    artifact["runtime_id"] = "runtime:tampered"
    (tmp_path / "eigen" / "field_sweep.v1.json").write_text(json.dumps(artifact))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "field_sweep.content_sha256" in (result.stderr + result.stdout)


def test_validator_rejects_typed_field_sweep_revision_mismatch(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    artifact = write_typed_field_sweep_fixture(tmp_path)
    artifact["revision"] = "sha256:" + "f" * 64
    (tmp_path / "eigen" / "field_sweep.v1.json").write_text(json.dumps(artifact))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "field_sweep.revision" in (result.stderr + result.stdout)


def test_validator_rejects_typed_field_sweep_content_sha256_mismatch(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    artifact = write_typed_field_sweep_fixture(tmp_path)
    artifact["content_sha256"] = "sha256:" + "f" * 64
    (tmp_path / "eigen" / "field_sweep.v1.json").write_text(json.dumps(artifact))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "field_sweep.content_sha256" in (result.stderr + result.stdout)


def test_validator_rejects_declared_bias_field_sweep_without_artifact_path(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    declare_bias_field_sweep(tmp_path)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.artifacts.field_sweep_v1_path" in (result.stderr + result.stdout)


def test_validator_rejects_diagnostics_declared_bias_field_sweep_without_artifact_path(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    declare_bias_field_sweep(tmp_path, in_solver_diagnostics=True)

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.artifacts.field_sweep_v1_path" in (result.stderr + result.stdout)


def test_validator_rejects_declared_bias_field_sweep_missing_artifact_file(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    write_typed_field_sweep_fixture(tmp_path)
    declare_bias_field_sweep(tmp_path)
    (tmp_path / "eigen" / "field_sweep.v1.json").unlink()

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "field_sweep.v1.json" in (result.stderr + result.stdout)


def test_validator_rejects_declared_bias_field_sweep_missing_resource_key(
    tmp_path: Path,
) -> None:
    write_eigen_fixture(tmp_path)
    write_typed_field_sweep_fixture(tmp_path)
    declare_bias_field_sweep(tmp_path)
    manifest_path = tmp_path / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    del manifest["resources"]["field_sweep_resource_key"]
    manifest_path.write_text(json.dumps(manifest))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "manifest.resources.field_sweep_resource_key" in (
        result.stderr + result.stdout
    )


def test_validator_rejects_typed_field_sweep_missing_source(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    artifact = write_typed_field_sweep_fixture(tmp_path)
    del artifact["source"]
    (tmp_path / "eigen" / "field_sweep.v1.json").write_text(json.dumps(artifact))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "field_sweep.source" in (result.stderr + result.stdout)


def test_validator_rejects_typed_field_sweep_stale_source_digest(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    artifact = write_typed_field_sweep_fixture(tmp_path)
    artifact["source"]["revision"] = "sha256:" + "f" * 64
    artifact["source_revision"] = "sha256:" + "f" * 64
    (tmp_path / "eigen" / "field_sweep.v1.json").write_text(json.dumps(artifact))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "field_sweep.source.revision" in (result.stderr + result.stdout)


def test_validator_rejects_typed_field_sweep_wrong_bias_units(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    artifact = write_typed_field_sweep_fixture(tmp_path)
    artifact["units"]["bias_field"] = "T"
    (tmp_path / "eigen" / "field_sweep.v1.json").write_text(json.dumps(artifact))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "field_sweep.units.bias_field" in (result.stderr + result.stdout)


def test_validator_rejects_typed_field_sweep_duplicate_sample_id(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    artifact = write_typed_field_sweep_fixture(tmp_path)
    artifact["samples"].append(dict(artifact["samples"][0]))
    artifact["requested_sample_count"] = 2
    artifact["completed_sample_count"] = 2
    (tmp_path / "eigen" / "field_sweep.v1.json").write_text(json.dumps(artifact))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "duplicate sample_id" in (result.stderr + result.stdout)


def test_validator_rejects_typed_field_sweep_mode_mapping_mismatch(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    artifact = write_typed_field_sweep_fixture(tmp_path)
    artifact["samples"][0]["modes"][0]["raw_mode_index"] = 9
    (tmp_path / "eigen" / "field_sweep.v1.json").write_text(json.dumps(artifact))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "field_sweep.samples[0].modes[0].raw_mode_index" in (result.stderr + result.stdout)


def test_validator_rejects_typed_field_sweep_unknown_branch_ref(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    artifact = write_typed_field_sweep_fixture(tmp_path)
    artifact["samples"][0]["branch_ids"] = [9]
    artifact["samples"][0]["modes"][0]["branch_id"] = 9
    (tmp_path / "eigen" / "field_sweep.v1.json").write_text(json.dumps(artifact))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "field_sweep.samples[0].branch_ids" in (result.stderr + result.stdout)


def test_validator_rejects_typed_field_sweep_topology_mismatch(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    artifact = write_typed_field_sweep_fixture(tmp_path)
    artifact["samples"][0]["topology"] = {
        **artifact["topology"],
        "topology_revision": "mesh-rev:other",
    }
    (tmp_path / "eigen" / "field_sweep.v1.json").write_text(json.dumps(artifact))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "field_sweep.samples[0].topology" in (result.stderr + result.stdout)


def test_validator_rejects_typed_field_sweep_missing_mode_metadata(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    write_typed_field_sweep_fixture(tmp_path)
    (tmp_path / "eigen" / "modes" / "sample_0000" / "mode_0000.json").unlink()

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "missing required artifact" in (result.stderr + result.stdout)


def test_validator_rejects_typed_field_sweep_tangent_only_field_reference(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    write_typed_field_sweep_fixture(tmp_path)
    metadata_path = tmp_path / "eigen" / "modes" / "sample_0000" / "mode_0000.json"
    metadata = json.loads(metadata_path.read_text())
    metadata["component_basis"] = "tangent_local"
    metadata_path.write_text(json.dumps(metadata))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "component_basis" in (result.stderr + result.stdout)


def test_validator_rejects_typed_field_sweep_nonfinite_mode_frequency(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    artifact = write_typed_field_sweep_fixture(tmp_path)
    artifact["samples"][0]["modes"][0]["frequency_hz"] = float("nan")
    (tmp_path / "eigen" / "field_sweep.v1.json").write_text(json.dumps(artifact))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "field_sweep.samples[0].modes[0].frequency_hz" in (result.stderr + result.stdout)


def test_validator_rejects_typed_field_sweep_complete_with_incomplete_counts(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    artifact = write_typed_field_sweep_fixture(tmp_path)
    artifact["requested_sample_count"] = 2
    artifact["completed_sample_count"] = 1
    (tmp_path / "eigen" / "field_sweep.v1.json").write_text(json.dumps(artifact))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "field_sweep.requested_sample_count" in (result.stderr + result.stdout)


def test_validator_rejects_typed_field_sweep_path_escape(tmp_path: Path) -> None:
    write_eigen_fixture(tmp_path)
    artifact = write_typed_field_sweep_fixture(tmp_path)
    artifact["cross_artifact_refs"][1]["artifact"] = "../../outside.json"
    (tmp_path / "eigen" / "field_sweep.v1.json").write_text(json.dumps(artifact))

    result = run_validator(tmp_path)

    assert result.returncode != 0
    assert "field_sweep.cross_artifact_refs[1].artifact" in (result.stderr + result.stdout)
