from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.verify_fdm_multilayer_cuda_parity import verify


QUALIFICATION_SCOPE = "SP4-derived, not canonical SP4 qualification"


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def _write_artifact(root: Path, metadata: dict, layer_count: int = 3) -> None:
    layers = []
    for index in range(layer_count):
        layer_id = f"layer-{index}"
        directory = f"layer-{index}"
        layers.append({"id": layer_id, "directory": directory})
        _write_json(
            root / "fields" / "H_demag" / directory / "step_000001.json",
            {
                "observable": "H_demag",
                "unit": "A/m",
                "step": 1,
                "component_count": 3,
                "component_order": "xyz",
                "location": "cell",
                "scope": "layer",
                "layer": {"id": layer_id},
                "values": [[float(index + 1), 0.0, 0.0]],
            },
        )
    _write_json(root / "fields" / "H_demag" / "manifest.json", {"layers": layers})
    _write_json(root / "metadata.json", metadata)


def _requested(device: str, precision: str) -> dict:
    return {
        "backend": "fdm",
        "device": device,
        "precision": precision,
        "mode": "strict",
        "fallback_policy": "forbidden",
    }


def _cpu_metadata() -> dict:
    return {
        "status": "completed",
        "source_hash": "a" * 64,
        "engine_version": "0.1.0",
        "requested_execution": _requested("cpu", "double"),
        "execution_provenance": {
            "execution_engine": "cpu_reference_multilayer",
            "precision": "double",
            "fft_backend": "rustfft",
            "lossy_fallback_used": False,
        },
    }


def _cuda_metadata(precision: str, layer_count: int = 3) -> dict:
    return {
        "status": "completed",
        "source_hash": "a" * 64,
        "engine_version": "0.1.0",
        "requested_execution": _requested("gpu", precision),
        "execution_provenance": {
            "execution_engine": "cuda_native_multilayer_convolution",
            "precision": precision,
            "demag_operator_kind": "native_multilayer_tensor_fft_newell",
            "fft_backend": "cuFFT",
            "device_name": "Test GPU",
            "compute_capability": "8.6",
            "cuda_driver_version": 12080,
            "cuda_runtime_version": 12080,
            "lossy_fallback_used": False,
            "ignored_terms": [],
            "fdm_multilayer_transfer_telemetry": {
                "execution_shape": "cuda_native_multilayer_convolution",
                "data_residency": "device_source_of_truth",
                "h2d_transfer_count": 2,
                "d2h_transfer_count": 2,
                "h2d_bytes": 48,
                "d2h_bytes": 48,
            },
            "fdm_multilayer_stage_telemetry": {
                "status": "recorded",
                "execution_engine": "cuda_native_multilayer_demag_v2",
                "data_residency": "device_resident_per_refresh",
                "fft_backend": "cuFFT",
                "layer_count": layer_count,
                "refresh_count": 1,
                "forward_fft_count": layer_count,
                "inverse_fft_count": layer_count,
                "pair_accumulation_count": layer_count * layer_count,
            },
        },
    }


def _thresholds(path: Path) -> Path:
    _write_json(
        path,
        {
            "schema_version": "fdm_multilayer_thresholds.v1",
            "qualification_scope": QUALIFICATION_SCOPE,
            "cuda_fp64_vs_cpu": {"rtol": 1e-8, "atol": 1e-4},
            "cuda_fp32_vs_cuda_fp64": {
                "weighted_rms_max": 2e-4,
                "max_component_normalized": 5e-4,
            },
        },
    )
    return path


def _artifacts(tmp_path: Path, lane: str = "cuda-fp64", layer_count: int = 3):
    reference = tmp_path / "reference"
    candidate = tmp_path / "candidate"
    if lane == "cuda-fp64":
        reference_metadata = _cpu_metadata()
    else:
        reference_metadata = _cuda_metadata("double", layer_count)
    candidate_metadata = _cuda_metadata(
        "double" if lane == "cuda-fp64" else "single", layer_count
    )
    _write_artifact(reference, reference_metadata, layer_count)
    _write_artifact(candidate, candidate_metadata, layer_count)
    return reference, candidate, _thresholds(tmp_path / "thresholds.json")


def test_accepts_exact_native_cuda_d07_counts_for_artifact_layer_count(tmp_path: Path) -> None:
    reference, candidate, thresholds = _artifacts(tmp_path, layer_count=2)

    report = verify(reference, candidate, thresholds, "cuda-fp64")

    assert report["status"] == "verified"
    assert report["qualification_claim"] is None
    assert report["overall_execution_residency"] == "device_resident"
    assert report["d07_stage"]["forward_fft_count"] == 2
    assert report["d07_stage"]["inverse_fft_count"] == 2
    assert report["d07_stage"]["pair_accumulation_count"] == 4


def test_rejects_host_authoritative_cuda_assisted_candidate(tmp_path: Path) -> None:
    reference, candidate, thresholds = _artifacts(tmp_path)
    metadata = json.loads((candidate / "metadata.json").read_text(encoding="utf-8"))
    metadata["execution_provenance"]["execution_engine"] = "cuda_assisted_multilayer"
    telemetry = metadata["execution_provenance"]["fdm_multilayer_transfer_telemetry"]
    telemetry["execution_shape"] = "cuda_assisted_multilayer"
    telemetry["data_residency"] = "host_authoritative_with_cuda_field_roundtrips"
    _write_json(candidate / "metadata.json", metadata)

    with pytest.raises(ValueError, match="cuda_device_residency_not_qualified"):
        verify(reference, candidate, thresholds, "cuda-fp64")


def test_rejects_resolved_cpu_fallback_before_parity(tmp_path: Path) -> None:
    reference, candidate, thresholds = _artifacts(tmp_path)
    metadata = json.loads((candidate / "metadata.json").read_text(encoding="utf-8"))
    metadata["execution_provenance"]["resolved_fallback"] = {
        "occurred": True,
        "original_engine": "cuda_native_multilayer_convolution",
        "fallback_engine": "cpu_reference_multilayer",
        "reason": "cuda_runtime_unavailable",
        "message": "test fixture",
    }
    _write_json(candidate / "metadata.json", metadata)

    with pytest.raises(ValueError, match="cpu_fallback_not_qualified"):
        verify(reference, candidate, thresholds, "cuda-fp64")


def test_rejects_malformed_fallback_provenance(tmp_path: Path) -> None:
    reference, candidate, thresholds = _artifacts(tmp_path)
    metadata = json.loads((candidate / "metadata.json").read_text(encoding="utf-8"))
    metadata["execution_provenance"]["resolved_fallback"] = "unknown"
    _write_json(candidate / "metadata.json", metadata)

    with pytest.raises(ValueError, match="fallback_provenance_malformed"):
        verify(reference, candidate, thresholds, "cuda-fp64")


def test_rejects_incomplete_candidate_run(tmp_path: Path) -> None:
    reference, candidate, thresholds = _artifacts(tmp_path)
    metadata = json.loads((candidate / "metadata.json").read_text(encoding="utf-8"))
    metadata["status"] = "failed"
    _write_json(candidate / "metadata.json", metadata)

    with pytest.raises(ValueError, match="candidate_run_not_completed"):
        verify(reference, candidate, thresholds, "cuda-fp64")


def test_rejects_incomplete_reference_run(tmp_path: Path) -> None:
    reference, candidate, thresholds = _artifacts(tmp_path)
    metadata = json.loads((reference / "metadata.json").read_text(encoding="utf-8"))
    metadata["status"] = "cancelled"
    _write_json(reference / "metadata.json", metadata)

    with pytest.raises(ValueError, match="reference_run_not_completed"):
        verify(reference, candidate, thresholds, "cuda-fp64")


def test_rejects_reference_candidate_snapshot_step_mismatch(tmp_path: Path) -> None:
    reference, candidate, thresholds = _artifacts(tmp_path)
    for layer_index in range(3):
        directory = candidate / "fields" / "H_demag" / f"layer-{layer_index}"
        payload = json.loads((directory / "step_000001.json").read_text(encoding="utf-8"))
        payload["step"] = 2
        _write_json(directory / "step_000002.json", payload)

    with pytest.raises(ValueError, match="reference_candidate_snapshot_step_mismatch"):
        verify(reference, candidate, thresholds, "cuda-fp64")


def test_rejects_fp32_reference_from_a_different_cuda_device(tmp_path: Path) -> None:
    reference, candidate, thresholds = _artifacts(tmp_path, lane="cuda-fp32")
    metadata = json.loads((reference / "metadata.json").read_text(encoding="utf-8"))
    metadata["execution_provenance"]["device_name"] = "Other GPU"
    _write_json(reference / "metadata.json", metadata)

    with pytest.raises(ValueError, match="cuda_reference_device_identity_mismatch"):
        verify(reference, candidate, thresholds, "cuda-fp32")


def test_rejects_source_hash_mismatch_between_reference_and_candidate(tmp_path: Path) -> None:
    reference, candidate, thresholds = _artifacts(tmp_path)
    metadata = json.loads((candidate / "metadata.json").read_text(encoding="utf-8"))
    metadata["source_hash"] = "b" * 64
    _write_json(candidate / "metadata.json", metadata)

    with pytest.raises(ValueError, match="artifact_source_hash_mismatch"):
        verify(reference, candidate, thresholds, "cuda-fp64")


def test_rejects_threshold_schema_drift(tmp_path: Path) -> None:
    reference, candidate, thresholds = _artifacts(tmp_path)
    limits = json.loads(thresholds.read_text(encoding="utf-8"))
    limits["schema_version"] = "fdm_multilayer_thresholds.v0"
    _write_json(thresholds, limits)

    with pytest.raises(ValueError, match="thresholds_schema_mismatch"):
        verify(reference, candidate, thresholds, "cuda-fp64")


def test_fp32_lane_uses_distinct_fp32_thresholds(tmp_path: Path) -> None:
    reference, candidate, thresholds = _artifacts(tmp_path, lane="cuda-fp32")
    step = candidate / "fields" / "H_demag" / "layer-0" / "step_000001.json"
    payload = json.loads(step.read_text(encoding="utf-8"))
    payload["values"][0][0] += 1e-4
    _write_json(step, payload)

    report = verify(reference, candidate, thresholds, "cuda-fp32")

    assert report["status"] == "verified"
    assert report["qualification_claim"] is None
    assert "weighted_rms" in report["parity"]
    assert "max_component_normalized" in report["parity"]
