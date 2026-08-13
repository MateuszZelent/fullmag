"""Contract for the managed native CUDA D-07 runtime gate."""

from __future__ import annotations

import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

from fullmag.runtime.loader import load_problem_from_script


REPOSITORY_ROOT = Path(__file__).resolve().parents[6]
SCENARIO = Path(__file__).with_name("scenario_l3_cuda_v2_small.py")
CUDA_PARITY_VERIFIER = REPOSITORY_ROOT / "scripts/verify_fdm_multilayer_cuda_parity.py"
CUDA_PRECISION_CONTRACT = (
    REPOSITORY_ROOT / "scripts/fdm_multilayer_cuda_precision_contract.py"
)


def load_cuda_parity_verifier():
    spec = importlib.util.spec_from_file_location(
        "verify_fdm_multilayer_cuda_parity",
        CUDA_PARITY_VERIFIER,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_h_demag_artifact(root: Path, provenance: dict[str, object]) -> None:
    field_root = root / "fields" / "H_demag"
    layer_root = field_root / "layer-0"
    layer_root.mkdir(parents=True)
    (field_root / "manifest.json").write_text(
        json.dumps({"layers": [{"id": "layer-0", "directory": "layer-0"}]}),
        encoding="utf-8",
    )
    (layer_root / "step_000000.json").write_text(
        json.dumps(
            {
                "unit": "A/m",
                "component_order": "xyz",
                "values": [[1.0, 0.0, 0.0]],
            }
        ),
        encoding="utf-8",
    )
    (root / "metadata.json").write_text(
        json.dumps({"execution_provenance": provenance}),
        encoding="utf-8",
    )


def cuda_identity() -> dict[str, object]:
    return {
        "device_name": "NVIDIA test device",
        "compute_capability": "8.9",
        "cuda_driver_version": 12080,
        "cuda_runtime_version": 12060,
    }


def transfer_telemetry() -> dict[str, object]:
    return {
        "execution_shape": "cuda_native_multilayer_demag_v2",
        "data_residency": "device_resident_per_refresh",
        "h2d_transfer_count": 0,
        "d2h_transfer_count": 0,
        "h2d_bytes": 0,
        "d2h_bytes": 0,
    }


def native_candidate_provenance(precision: str) -> dict[str, object]:
    return {
        "precision": precision,
        **cuda_identity(),
        "execution_engine": "cuda_native_multilayer_demag_v2",
        "lossy_fallback_used": False,
        "resolved_fallback": None,
        "fft_backend": "cuFFT",
        "fdm_multilayer_stage_telemetry": {
            "status": "recorded",
            "execution_engine": "cuda_native_multilayer_demag_v2",
            "data_residency": "device_resident_per_refresh",
            "fft_backend": "cuFFT",
            "layer_count": 3,
            "refresh_count": 1,
            "forward_fft_count": 3,
            "inverse_fft_count": 3,
            "pair_accumulation_count": 9,
        },
        "fdm_multilayer_transfer_telemetry": transfer_telemetry(),
    }


def cpu_reference_provenance() -> dict[str, object]:
    return {
        "execution_engine": "cpu_reference_multilayer",
        "precision": "double",
        "lossy_fallback_used": False,
        "resolved_fallback": None,
    }


def test_cuda_parity_verifier_rejects_assisted_multilayer_artifact(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference"
    candidate = tmp_path / "candidate"
    stage_telemetry = {
        "status": "recorded",
        "execution_engine": "cuda_native_multilayer_demag_v2",
        "data_residency": "device_resident_per_refresh",
        "fft_backend": "cuFFT",
        "layer_count": 3,
        "refresh_count": 1,
        "forward_fft_count": 3,
        "inverse_fft_count": 3,
        "pair_accumulation_count": 9,
    }
    write_h_demag_artifact(reference, cpu_reference_provenance())
    write_h_demag_artifact(
        candidate,
        {
            "precision": "double",
            **cuda_identity(),
            "execution_engine": "cuda_assisted_multilayer",
            "lossy_fallback_used": False,
            "resolved_fallback": None,
            "fft_backend": "cuFFT",
            "fdm_multilayer_stage_telemetry": stage_telemetry,
        },
    )

    verifier = load_cuda_parity_verifier()
    with pytest.raises(ValueError, match="cuda_assisted_multilayer_not_qualified"):
        verifier.verify(
            reference,
            candidate,
            REPOSITORY_ROOT
            / "tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/thresholds.v1.json",
            "cuda-fp64",
        )


def test_cuda_parity_verifier_rejects_reference_fallback(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference"
    candidate = tmp_path / "candidate"
    reference_provenance = cpu_reference_provenance()
    reference_provenance["lossy_fallback_used"] = True
    write_h_demag_artifact(reference, reference_provenance)
    write_h_demag_artifact(candidate, native_candidate_provenance("double"))

    verifier = load_cuda_parity_verifier()
    with pytest.raises(ValueError, match="reference_fallback_not_proven_absent"):
        verifier.verify(
            reference,
            candidate,
            REPOSITORY_ROOT
            / "tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/thresholds.v1.json",
            "cuda-fp64",
        )


def test_cuda_parity_verifier_rejects_candidate_fallback(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference"
    candidate = tmp_path / "candidate"
    write_h_demag_artifact(reference, cpu_reference_provenance())
    candidate_provenance = native_candidate_provenance("double")
    candidate_provenance["lossy_fallback_used"] = True
    write_h_demag_artifact(candidate, candidate_provenance)

    verifier = load_cuda_parity_verifier()
    with pytest.raises(ValueError, match="cuda_fallback_not_proven_absent"):
        verifier.verify(
            reference,
            candidate,
            REPOSITORY_ROOT
            / "tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/thresholds.v1.json",
            "cuda-fp64",
        )


def test_cuda_parity_verifier_requires_reference_metadata(tmp_path: Path) -> None:
    reference = tmp_path / "reference"
    candidate = tmp_path / "candidate"
    write_h_demag_artifact(reference, {"precision": "double"})
    (reference / "metadata.json").unlink()
    write_h_demag_artifact(candidate, native_candidate_provenance("double"))

    verifier = load_cuda_parity_verifier()
    with pytest.raises(FileNotFoundError, match="metadata.json"):
        verifier.verify(
            reference,
            candidate,
            REPOSITORY_ROOT
            / "tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/thresholds.v1.json",
            "cuda-fp64",
        )


def test_cuda_parity_verifier_rejects_fp32_candidate_reported_as_double(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference"
    candidate = tmp_path / "candidate"
    write_h_demag_artifact(
        reference,
        native_candidate_provenance("double"),
    )
    write_h_demag_artifact(candidate, native_candidate_provenance("double"))

    verifier = load_cuda_parity_verifier()
    with pytest.raises(ValueError, match="cuda_fp32_candidate_precision_not_single"):
        verifier.verify(
            reference,
            candidate,
            REPOSITORY_ROOT
            / "tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/thresholds.v1.json",
            "cuda-fp32",
        )


def test_cuda_parity_verifier_reports_verified_precision_contract(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference"
    candidate = tmp_path / "candidate"
    write_h_demag_artifact(reference, cpu_reference_provenance())
    write_h_demag_artifact(candidate, native_candidate_provenance("double"))

    verifier = load_cuda_parity_verifier()
    report = verifier.verify(
        reference,
        candidate,
        REPOSITORY_ROOT
        / "tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/thresholds.v1.json",
        "cuda-fp64",
    )

    assert report["precision_contract"] == {
        "lane": "cuda-fp64",
        "reference_precision": "double",
        "candidate_precision": "double",
        "cuda_identity_match": None,
    }


def test_cuda_fp32_parity_verifier_requires_native_fp64_reference(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference"
    candidate = tmp_path / "candidate"
    write_h_demag_artifact(reference, native_candidate_provenance("double"))
    write_h_demag_artifact(candidate, native_candidate_provenance("single"))

    verifier = load_cuda_parity_verifier()
    report = verifier.verify(
        reference,
        candidate,
        REPOSITORY_ROOT
        / "tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/thresholds.v1.json",
        "cuda-fp32",
    )
    assert report["precision_contract"]["cuda_identity_match"] is True


def test_cuda_fp32_parity_verifier_requires_reference_d07_cufft_proof(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference"
    candidate = tmp_path / "candidate"
    reference_provenance = native_candidate_provenance("double")
    reference_provenance.pop("fdm_multilayer_stage_telemetry")
    reference_provenance["fft_backend"] = "rustfft"
    write_h_demag_artifact(reference, reference_provenance)
    write_h_demag_artifact(candidate, native_candidate_provenance("single"))

    verifier = load_cuda_parity_verifier()
    with pytest.raises(ValueError, match="reference_d07_telemetry_not_qualified"):
        verifier.verify(
            reference,
            candidate,
            REPOSITORY_ROOT
            / "tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/thresholds.v1.json",
            "cuda-fp32",
        )


def test_cuda_v2_scenario_forces_identity_grid_with_distinct_materials() -> None:
    loaded = load_problem_from_script(SCENARIO, lightweight_assets=True)
    ir = loaded.problem.to_ir()
    hints = ir["backend_policy"]["discretization_hints"]["fdm"]

    assert hints["demag"] == {
        "strategy": "multilayer_convolution",
        "mode": "three_d",
        "common_cells": [8, 4, 2],
    }
    saturation_values = {
        material["saturation_magnetisation"] for material in ir["materials"]
    }
    assert saturation_values == {7.8e5, 8.0e5, 8.2e5}


@pytest.mark.parametrize("lane", ["cuda-fp64", "cuda-fp32"])
def test_managed_cuda_recipe_runs_real_device_and_fail_closed_verifier(
    lane: str,
) -> None:
    result = subprocess.run(
        ["just", "--dry-run", "verify-fdm-multilayer-cuda-runtime", lane],
        cwd=REPOSITORY_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    rendered = result.stdout + result.stderr
    assert "docker compose --profile fem-gpu run --rm --no-deps" in rendered
    assert "nvidia-smi -L" in rendered
    assert "scenario_l3_cuda_v2_small.py" in rendered
    assert "verify_fdm_multilayer_cuda_parity.py" in rendered
    assert str(CUDA_PRECISION_CONTRACT.relative_to(REPOSITORY_ROOT)) in rendered
    assert '"$verifier" "$precision_contract" justfile' in rendered
    assert "d07_telemetry_not_qualified" in rendered
    assert "cuda_assisted_multilayer_not_qualified" in rendered
    assert "reference_execution_engine_not_qualified" in rendered
    assert "reference_fallback_not_proven_absent" in rendered
    assert "reference_d07_telemetry_not_qualified" in rendered
    assert "reference_cuda_provenance_not_qualified" in rendered
    assert "cuda_identity_incomplete" in rendered
    assert "cuda_identity_invalid" in rendered
    assert "cpu_cuda_parity_not_qualified" in rendered
    assert ".build_identity.source_snapshot_sha256" in rendered
    assert "managed_runtime_source_snapshot_mismatch" in rendered
    assert "source_drift_after_runtime" in rendered
    assert "input_hash_drift_after_runtime" in rendered
    assert "source_hash_drift_after_runtime" in rendered
    assert "managed_runtime_manifest_drift_after_runtime" in rendered
    manifest_guard = rendered.index("managed_runtime_manifest_drift_after_runtime")
    verified_write = rendered.index(r'\"status\":\"verified\"')
    assert manifest_guard < verified_write
