#!/usr/bin/env python3
"""Unit tests for FEM frequency-domain modal eigen artifact validation."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_fem_frequency_domain_eigen_artifacts.py"


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
) -> None:
    (root / "eigen" / "modes" / "sample_0000").mkdir(parents=True)
    (root / "eigen" / "mode_fields" / "sample_0000" / "mode_0000").mkdir(
        parents=True
    )
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
        "norm": 1.0,
        "max_amplitude": 1.0,
        "residual_norm": 1.0e-9,
        "residual_linf": 1.0e-10,
        "tangent_leakage_mean_abs": 0.0,
        "tangent_leakage_max_abs": 0.0,
        "dominant_polarization": "linear",
        "k_vector": [0.0, 0.0, 0.0],
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

    branches = {
        "schema_version": "eigen_branches.v2",
        "solver_model": "reference_scalar_tangent",
        "branches": [
            {
                "branch_id": 0,
                "label": "B0",
                "points": [
                    {
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
                    }
                ],
            }
        ],
    }
    (root / "eigen" / "branches.v2.json").write_text(json.dumps(branches))
    (root / "eigen" / "dispersion.csv").write_text(
        "\n".join(
            [
                "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score",
                (
                    "0,0,0,0,0,G,0,0,"
                    f"{dispersion_frequency_hz_override if dispersion_frequency_hz_override is not None else 1.0e9},"
                    "6.283185307179586e9,0,1.0e-9,"
                ),
            ]
        )
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
        "normalization": "unit_l2",
        "damping_policy": "ignore",
        "mode_field_id": field_id,
        "mode_field_resource_key": field_resource,
        "residual_norm": 1.0e-9,
        "residual_linf": 1.0e-10,
        "tangent_leakage_mean_abs": 0.0,
        "tangent_leakage_max_abs": 0.0,
        "dominant_polarization": "linear",
        "k_vector": [0.0, 0.0, 0.0],
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
        "stage_kind": "eigenmodes",
        "status": "ready",
        "complete": True,
        "artifacts": {
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


def run_validator(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(VALIDATOR), str(root)],
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
