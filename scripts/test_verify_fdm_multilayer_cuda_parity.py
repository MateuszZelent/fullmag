"""Fail-closed coverage for CUDA multilayer residency evidence."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
VERIFIER_PATH = REPOSITORY_ROOT / "scripts" / "verify_fdm_multilayer_cuda_parity.py"
THRESHOLDS = (
    REPOSITORY_ROOT
    / "tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/thresholds.v1.json"
)


def load_verifier():
    spec = importlib.util.spec_from_file_location("fdm_multilayer_cuda_parity", VERIFIER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cuda_identity() -> dict[str, object]:
    return {
        "device_name": "NVIDIA test device",
        "compute_capability": "8.9",
        "cuda_driver_version": 12080,
        "cuda_runtime_version": 12060,
    }


def d07_telemetry() -> dict[str, object]:
    return {
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


def transfer_telemetry() -> dict[str, object]:
    return {
        "execution_shape": "cuda_native_multilayer_demag_v2",
        "data_residency": "device_resident_per_refresh",
        "h2d_transfer_count": 0,
        "d2h_transfer_count": 0,
        "h2d_bytes": 0,
        "d2h_bytes": 0,
    }


def cpu_provenance() -> dict[str, object]:
    return {
        "execution_engine": "cpu_reference_multilayer",
        "precision": "double",
        "lossy_fallback_used": False,
        "resolved_fallback": None,
    }


def candidate_provenance() -> dict[str, object]:
    return {
        "precision": "double",
        **cuda_identity(),
        "execution_engine": "cuda_native_multilayer_demag_v2",
        "lossy_fallback_used": False,
        "resolved_fallback": None,
        "fft_backend": "cuFFT",
        "fdm_multilayer_stage_telemetry": d07_telemetry(),
        "fdm_multilayer_transfer_telemetry": transfer_telemetry(),
    }


def write_artifact(root: Path, provenance: dict[str, object]) -> None:
    field_root = root / "fields" / "H_demag"
    layer_root = field_root / "layer-0"
    layer_root.mkdir(parents=True)
    (field_root / "manifest.json").write_text(
        json.dumps({"layers": [{"id": "layer-0", "directory": "layer-0"}]}),
        encoding="utf-8",
    )
    (layer_root / "step_000000.json").write_text(
        json.dumps({"unit": "A/m", "component_order": "xyz", "values": [[1.0, 0.0, 0.0]]}),
        encoding="utf-8",
    )
    (root / "metadata.json").write_text(
        json.dumps({"execution_provenance": provenance}), encoding="utf-8"
    )


def verify_valid_fixture(tmp_path: Path, candidate: dict[str, object]) -> dict:
    reference = tmp_path / "reference"
    candidate_root = tmp_path / "candidate"
    write_artifact(reference, cpu_provenance())
    write_artifact(candidate_root, candidate)
    return load_verifier().verify(reference, candidate_root, THRESHOLDS, "cuda-fp64")


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        (
            lambda provenance: provenance.update(
                {"execution_engine": "cuda_assisted_multilayer"}
            ),
            "cuda_assisted_multilayer_not_qualified",
        ),
        (
            lambda provenance: provenance["fdm_multilayer_transfer_telemetry"].update(
                {"execution_shape": "cuda_assisted_multilayer"}
            ),
            "cuda_transfer_telemetry_not_qualified:execution_shape",
        ),
        (
            lambda provenance: provenance["fdm_multilayer_transfer_telemetry"].update(
                {"data_residency": "host_authoritative"}
            ),
            "cuda_transfer_telemetry_not_qualified:data_residency",
        ),
        (
            lambda provenance: provenance["fdm_multilayer_transfer_telemetry"].update(
                {"h2d_transfer_count": 1}
            ),
            "cuda_transfer_telemetry_not_qualified:h2d_transfer_count",
        ),
    ],
)
def test_rejects_non_device_resident_multilayer_provenance(
    tmp_path: Path, change, reason: str
) -> None:
    candidate = candidate_provenance()
    change(candidate)

    with pytest.raises(ValueError, match=reason):
        verify_valid_fixture(tmp_path, candidate)


def test_reports_exact_device_residency_and_zero_transfer_telemetry(tmp_path: Path) -> None:
    report = verify_valid_fixture(tmp_path, candidate_provenance())

    assert report["overall_execution_residency"] == "device_resident_per_refresh"
    assert report["transfer_telemetry"] == transfer_telemetry()
    assert report["d07_stage"] == d07_telemetry()


@pytest.mark.parametrize(
    ("mutate", "reason"),
    [
        (
            lambda provenance: provenance.pop("fdm_multilayer_transfer_telemetry"),
            "cuda_transfer_telemetry_not_qualified",
        ),
        (
            lambda provenance: provenance.update({"fdm_multilayer_transfer_telemetry": []}),
            "cuda_transfer_telemetry_not_qualified",
        ),
        (
            lambda provenance: provenance["fdm_multilayer_transfer_telemetry"].update(
                {"h2d_bytes": None}
            ),
            "cuda_transfer_telemetry_not_qualified:h2d_bytes",
        ),
        (
            lambda provenance: provenance["fdm_multilayer_transfer_telemetry"].update(
                {"d2h_bytes": -1}
            ),
            "cuda_transfer_telemetry_not_qualified:d2h_bytes",
        ),
        (
            lambda provenance: provenance["fdm_multilayer_transfer_telemetry"].update(
                {"h2d_transfer_count": 0.0}
            ),
            "cuda_transfer_telemetry_not_qualified:h2d_transfer_count",
        ),
        (
            lambda provenance: provenance["fdm_multilayer_transfer_telemetry"].update(
                {"d2h_transfer_count": True}
            ),
            "cuda_transfer_telemetry_not_qualified:d2h_transfer_count",
        ),
        (
            lambda provenance: provenance["fdm_multilayer_transfer_telemetry"].update(
                {"d2h_bytes": 8}
            ),
            "cuda_transfer_telemetry_not_qualified:d2h_bytes",
        ),
    ],
)
def test_rejects_missing_malformed_or_nonzero_transfer_telemetry(
    tmp_path: Path, mutate, reason: str
) -> None:
    candidate = candidate_provenance()
    mutate(candidate)

    with pytest.raises(ValueError, match=reason):
        verify_valid_fixture(tmp_path, candidate)


@pytest.mark.parametrize(
    ("mutate", "reason"),
    [
        (
            lambda provenance: provenance["fdm_multilayer_stage_telemetry"].update(
                {"forward_fft_count": 2}
            ),
            "d07_telemetry_not_qualified:forward_fft_count",
        ),
        (
            lambda provenance: provenance["fdm_multilayer_stage_telemetry"].update(
                {"forward_fft_count": 3.0}
            ),
            "d07_telemetry_not_qualified:forward_fft_count",
        ),
        (
            lambda provenance: provenance["fdm_multilayer_stage_telemetry"].update(
                {"refresh_count": True}
            ),
            "d07_telemetry_not_qualified:refresh_count",
        ),
        (
            lambda provenance: provenance["fdm_multilayer_stage_telemetry"].update(
                {"pair_accumulation_count": "9"}
            ),
            "d07_telemetry_not_qualified:pair_accumulation_count",
        ),
        (
            lambda provenance: provenance.update({"precision": "single"}),
            "cuda_fp64_candidate_precision_not_double",
        ),
        (
            lambda provenance: provenance.pop("device_name"),
            "cuda_identity_incomplete",
        ),
        (
            lambda provenance: provenance.update({"lossy_fallback_used": True}),
            "cuda_fallback_not_proven_absent",
        ),
    ],
)
def test_preserves_existing_d07_precision_identity_and_fallback_checks(
    tmp_path: Path, mutate, reason: str
) -> None:
    candidate = candidate_provenance()
    mutate(candidate)

    with pytest.raises(ValueError, match=reason):
        verify_valid_fixture(tmp_path, candidate)
