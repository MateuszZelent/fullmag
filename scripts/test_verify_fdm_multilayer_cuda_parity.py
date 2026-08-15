"""Fail-closed coverage for CUDA multilayer residency evidence."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Sequence

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


DEFAULT_LAYER_COUNTS = (64, 64, 64)
DEFAULT_SNAPSHOT_COUNT = 2


def d07_telemetry(layer_count: int = 3) -> dict[str, object]:
    return {
        "status": "recorded",
        "execution_engine": "cuda_native_multilayer_demag_v2",
        "data_residency": "device_resident_per_refresh",
        "fft_backend": "cuFFT",
        "layer_count": layer_count,
        "refresh_count": 1,
        "forward_fft_count": layer_count,
        "inverse_fft_count": layer_count,
        "pair_accumulation_count": layer_count * layer_count,
    }


def transfer_telemetry(
    layer_counts: Sequence[int] = DEFAULT_LAYER_COUNTS,
    snapshot_count: int = DEFAULT_SNAPSHOT_COUNT,
    precision: str = "double",
) -> dict[str, object]:
    layer_count = len(layer_counts)
    scalar_bytes = 4 if precision == "single" else 8
    vector_bytes = 3 * scalar_bytes * sum(layer_counts)
    snapshot_vector_count = snapshot_count * 6 * layer_count
    snapshot_bytes = snapshot_count * 6 * vector_bytes
    return {
        "execution_shape": "cuda_native_multilayer_convolution",
        "data_residency": "device_resident_with_observed_host_snapshots",
        "layer_count": layer_count,
        "host_snapshot_count": snapshot_count,
        "payload_precision": precision,
        "scalar_bytes": scalar_bytes,
        "setup_h2d_transfer_count": layer_count,
        "setup_h2d_bytes": vector_bytes,
        "observed_snapshot_d2h_transfer_count": snapshot_vector_count,
        "observed_snapshot_d2h_bytes": snapshot_bytes,
        "warm_step_h2d_transfer_count": 0,
        "warm_step_h2d_bytes": 0,
        "warm_step_d2h_transfer_count": 0,
        "warm_step_d2h_bytes": 0,
        "h2d_transfer_count": layer_count,
        "d2h_transfer_count": snapshot_vector_count,
        "h2d_bytes": vector_bytes,
        "d2h_bytes": snapshot_bytes,
    }


def cpu_provenance() -> dict[str, object]:
    return {
        "execution_engine": "cpu_reference_multilayer",
        "precision": "double",
        "lossy_fallback_used": False,
        "resolved_fallback": None,
    }


def candidate_provenance(
    precision: str = "double",
    layer_counts: Sequence[int] = DEFAULT_LAYER_COUNTS,
    snapshot_count: int = DEFAULT_SNAPSHOT_COUNT,
) -> dict[str, object]:
    return {
        "precision": precision,
        **cuda_identity(),
        "execution_engine": "cuda_native_multilayer_convolution",
        "lossy_fallback_used": False,
        "resolved_fallback": None,
        "fft_backend": "cuFFT",
        "fdm_multilayer_stage_telemetry": d07_telemetry(len(layer_counts)),
        "fdm_multilayer_transfer_telemetry": transfer_telemetry(
            layer_counts,
            snapshot_count,
            precision,
        ),
    }


def write_artifact(
    root: Path,
    provenance: dict[str, object],
    *,
    layer_counts: Sequence[int] = DEFAULT_LAYER_COUNTS,
    snapshot_count: int = DEFAULT_SNAPSHOT_COUNT,
    payload_precision: str | None = None,
) -> None:
    field_root = root / "fields" / "H_demag"
    layers = [
        {
            "id": f"layer-{index}",
            "directory": f"layer-{index}",
            "value_count": cell_count,
            "vector_shape": [cell_count, 3],
        }
        for index, cell_count in enumerate(layer_counts)
    ]
    field_root.mkdir(parents=True)
    (field_root / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": "fdm_multilayer_field_manifest.v1",
                "observable": "H_demag",
                "unit": "A/m",
                "component_order": ["x", "y", "z"],
                "layer_count": len(layers),
                "layers": layers,
            }
        ),
        encoding="utf-8",
    )
    resolved_precision = payload_precision or str(provenance.get("precision", "double"))
    for layer, cell_count in zip(layers, layer_counts):
        layer_root = field_root / str(layer["directory"])
        layer_root.mkdir()
        for step in range(snapshot_count):
            (layer_root / f"step_{step:06}.json").write_text(
                json.dumps(
                    {
                        "observable": "H_demag",
                        "unit": "A/m",
                        "component_count": 3,
                        "component_order": "xyz",
                        "provenance": {"precision": resolved_precision},
                        "values": [[1.0, 0.0, 0.0] for _ in range(cell_count)],
                    }
                ),
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
    ("layer_counts", "snapshot_count"),
    [
        ((4, 7), 1),
        ((2, 3, 5, 7), 3),
    ],
)
def test_derives_transfer_contract_from_geometry_and_snapshot_count(
    tmp_path: Path,
    layer_counts: tuple[int, ...],
    snapshot_count: int,
) -> None:
    reference = tmp_path / "reference"
    candidate_root = tmp_path / "candidate"
    write_artifact(
        reference,
        cpu_provenance(),
        layer_counts=layer_counts,
        snapshot_count=snapshot_count,
    )
    provenance = candidate_provenance("double", layer_counts, snapshot_count)
    write_artifact(
        candidate_root,
        provenance,
        layer_counts=layer_counts,
        snapshot_count=snapshot_count,
    )

    report = load_verifier().verify(
        reference,
        candidate_root,
        THRESHOLDS,
        "cuda-fp64",
    )

    assert report["transfer_telemetry"] == transfer_telemetry(
        layer_counts,
        snapshot_count,
        "double",
    )


def test_rejects_aggregate_only_transfer_telemetry(tmp_path: Path) -> None:
    candidate = candidate_provenance()
    telemetry = candidate["fdm_multilayer_transfer_telemetry"]
    assert isinstance(telemetry, dict)
    for key in tuple(telemetry):
        if key not in {
            "execution_shape",
            "data_residency",
            "h2d_transfer_count",
            "d2h_transfer_count",
            "h2d_bytes",
            "d2h_bytes",
        }:
            telemetry.pop(key)

    with pytest.raises(ValueError, match="cuda_transfer_telemetry_not_qualified:layer_count"):
        verify_valid_fixture(tmp_path, candidate)


def test_rejects_fake_single_layer_artifact_claiming_three_layers(tmp_path: Path) -> None:
    reference = tmp_path / "reference"
    candidate_root = tmp_path / "candidate"
    write_artifact(reference, cpu_provenance(), layer_counts=(192,))
    candidate = candidate_provenance()
    candidate["fdm_multilayer_stage_telemetry"] = d07_telemetry(1)
    write_artifact(candidate_root, candidate, layer_counts=(192,))

    with pytest.raises(ValueError, match="cuda_transfer_telemetry_not_qualified:layer_count"):
        load_verifier().verify(reference, candidate_root, THRESHOLDS, "cuda-fp64")


def test_rejects_nonzero_warm_transfer_with_matching_aggregate_totals(
    tmp_path: Path,
) -> None:
    candidate = candidate_provenance()
    telemetry = candidate["fdm_multilayer_transfer_telemetry"]
    assert isinstance(telemetry, dict)
    warm_bytes = 3 * 8 * sum(DEFAULT_LAYER_COUNTS)
    telemetry["warm_step_h2d_transfer_count"] = 1
    telemetry["warm_step_h2d_bytes"] = warm_bytes
    telemetry["h2d_transfer_count"] = int(telemetry["setup_h2d_transfer_count"]) + 1
    telemetry["h2d_bytes"] = int(telemetry["setup_h2d_bytes"]) + warm_bytes

    with pytest.raises(
        ValueError,
        match="cuda_transfer_telemetry_not_qualified:warm_step_h2d_transfer_count",
    ):
        verify_valid_fixture(tmp_path, candidate)


def test_rejects_d07_stage_layer_count_mismatching_artifact_geometry(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference"
    candidate_root = tmp_path / "candidate"
    write_artifact(reference, cpu_provenance(), layer_counts=(96, 96))
    write_artifact(
        candidate_root,
        candidate_provenance(),
        layer_counts=(96, 96),
    )

    with pytest.raises(ValueError, match="d07_telemetry_not_qualified:layer_count"):
        load_verifier().verify(reference, candidate_root, THRESHOLDS, "cuda-fp64")


def test_rejects_fp32_scalar_width_mismatch(tmp_path: Path) -> None:
    reference = tmp_path / "reference"
    candidate_root = tmp_path / "candidate"
    write_artifact(reference, candidate_provenance("double"))
    candidate = candidate_provenance("single")
    telemetry = candidate["fdm_multilayer_transfer_telemetry"]
    assert isinstance(telemetry, dict)
    telemetry.update(transfer_telemetry(precision="double"))
    telemetry["payload_precision"] = "single"
    write_artifact(candidate_root, candidate, payload_precision="single")

    with pytest.raises(ValueError, match="cuda_transfer_telemetry_not_qualified:scalar_bytes"):
        load_verifier().verify(reference, candidate_root, THRESHOLDS, "cuda-fp32")


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
            lambda provenance: provenance.update(
                {"execution_engine": "cuda_native_multilayer_demag_v2"}
            ),
            "cuda_native_multilayer_convolution_not_proven",
        ),
        (
            lambda provenance: provenance["fdm_multilayer_transfer_telemetry"].update(
                {"execution_shape": "cuda_native_multilayer_demag_v2"}
            ),
            "cuda_transfer_telemetry_not_qualified:execution_shape",
        ),
        (
            lambda provenance: provenance["fdm_multilayer_transfer_telemetry"].update(
                {"data_residency": "device_resident_per_refresh"}
            ),
            "cuda_transfer_telemetry_not_qualified:data_residency",
        ),
        (
            lambda provenance: provenance["fdm_multilayer_transfer_telemetry"].update(
                {"h2d_transfer_count": 4}
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


def test_reports_exact_device_residency_and_observed_transfer_telemetry(tmp_path: Path) -> None:
    report = verify_valid_fixture(tmp_path, candidate_provenance())

    assert (
        report["overall_execution_residency"]
        == "device_resident_with_observed_host_snapshots"
    )
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
                {"d2h_bytes": 55288}
            ),
            "cuda_transfer_telemetry_not_qualified:d2h_bytes",
        ),
    ],
)
def test_rejects_missing_malformed_or_inexact_transfer_telemetry(
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
