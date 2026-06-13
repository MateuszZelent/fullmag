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
    omit_spectrum_mode_field_resource_key: bool = False,
    inline_mode_vectors: bool = False,
    payload_size: int = 48,
    manifest_mode_resources_override: list[str] | None = None,
) -> None:
    (root / "eigen" / "modes" / "sample_0000").mkdir(parents=True)
    (root / "eigen" / "mode_fields" / "sample_0000" / "mode_0000").mkdir(
        parents=True
    )
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
                        "frequency_real_hz": 1.0e9,
                        "frequency_imag_hz": 0.0,
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
                "0,0,0,0,0,G,0,0,1.0e9,6.283185307179586e9,0,1.0e-9,",
            ]
        )
    )

    mode = {
        "schema_version": "2",
        "solver_model": "reference_scalar_tangent",
        "sample_index": 0,
        "raw_mode_index": 0,
        "branch_id": 0,
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
    if inline_mode_vectors:
        mode["real"] = [[1.0, 0.0, 0.0]]
        mode["imag"] = [[0.0, 1.0, 0.0]]
        mode["amplitude"] = [1.0]
        mode["phase"] = [0.0]
    (root / "eigen" / "modes" / "sample_0000" / "mode_0000.json").write_text(
        json.dumps(mode)
    )
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
            "mode_metadata_paths": ["eigen/modes/sample_0000/mode_0000.json"],
        },
        "resources": {
            "mode_field_resources": (
                manifest_mode_resources_override
                if manifest_mode_resources_override is not None
                else [meta_resource]
            ),
        },
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
