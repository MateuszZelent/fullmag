"""Contract tests for the FDM multilayer GPU benchmark qualification gate."""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

from scripts.analysis.validate_fdm_multilayer_gpu_benchmark import (
    ARTIFACT_SCHEMA,
    ATTESTATION_SCHEMA,
    MEASUREMENT_SCHEMA,
    QUALIFICATION_SCHEMA,
    canonical_digest,
    validate_benchmark_artifact,
    validate_payload,
)


SCRIPT = Path(__file__).parent / "analysis" / "validate_fdm_multilayer_gpu_benchmark.py"
SHA = "a" * 64


def measurement(
    value: int,
    unit: str,
    statistic: str,
    *,
    sample_count: int = 5,
) -> dict[str, object]:
    return {
        "schema_version": MEASUREMENT_SCHEMA,
        "value": value,
        "unit": unit,
        "statistic": statistic,
        "sample_count": sample_count,
    }


def benchmark_row(lane: str, layer_count: int) -> dict[str, object]:
    gpu = lane == "cuda_fp64"
    device = "gpu" if gpu else "cpu"
    category_unit = 4096 * layer_count
    categories = {
        "magnetization": measurement(category_unit, "byte", "maximum"),
        "fields": measurement(category_unit, "byte", "maximum"),
        "fft_workspace": measurement(category_unit * 2, "byte", "maximum"),
        "kernel_catalog": measurement(
            category_unit * layer_count, "byte", "maximum"
        ),
        "scratch": measurement(category_unit, "byte", "maximum"),
    }
    tracked = sum(item["value"] for item in categories.values())
    execution_provenance: dict[str, object] = {
        "execution_engine": "cpu_reference_multilayer",
        "precision": "double",
    }
    if gpu:
        execution_provenance = {
            "execution_engine": "cuda_assisted_multilayer",
            "precision": "double",
            "resolved_fallback": None,
            "lossy_fallback_used": False,
            "ignored_terms": [],
            "fft_backend": "cuFFT",
            "device_name": "NVIDIA Test GPU",
            "compute_capability": "8.9",
            "cuda_driver_version": 13000,
            "cuda_runtime_version": 13000,
            "fdm_multilayer_transfer_telemetry": {
                "execution_shape": "cuda_assisted_multilayer",
                "data_residency": "host_authoritative_with_cuda_field_roundtrips",
                "h2d_transfer_count": 2 * layer_count,
                "d2h_transfer_count": 2 * layer_count,
                "h2d_bytes": 1024 * layer_count,
                "d2h_bytes": 256 * layer_count,
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
        }
    return {
        "lane": lane,
        "layer_count": layer_count,
        "requested_execution": {
            "backend": "fdm",
            "device": device,
            "precision": "double",
            "mode": "strict",
            "fallback_policy": "forbidden",
        },
        "execution_provenance": execution_provenance,
        "artifact_identity": {
            "metadata_sha256": hashlib.sha256(f"{lane}:{layer_count}".encode()).hexdigest(),
            "source_snapshot_sha256": ("b" if gpu else "2") * 64,
            "runtime_manifest_sha256": ("c" if gpu else "3") * 64,
            "runtime_binary_sha256": ("d" if gpu else "4") * 64,
        },
        "cold": {
            "kernel_setup": measurement(1000 * layer_count, "ns", "median"),
            "fft_plan_setup": measurement(2000 * layer_count, "ns", "median"),
            "total": measurement(4000 * layer_count, "ns", "median"),
        },
        "warm": {
            "apply": measurement(3000 * layer_count, "ns", "median"),
            "pair_multiply": measurement(
                1000 * layer_count * layer_count, "ns", "median"
            ),
            "forward_fft": measurement(500 * layer_count, "ns", "median"),
            "inverse_fft": measurement(500 * layer_count, "ns", "median"),
            "large_allocation_count": measurement(0, "count", "maximum"),
        },
        "transfer": {
            "total": measurement(250 if gpu else 0, "ns", "median"),
            "h2d_bytes": measurement(
                1024 * layer_count if gpu else 0, "byte", "median"
            ),
            "d2h_bytes": measurement(
                256 * layer_count if gpu else 0, "byte", "median"
            ),
        },
        "memory": {
            "peak_device_bytes": (
                measurement(tracked + category_unit, "byte", "maximum")
                if gpu
                else {"absence_reason": "not_applicable_cpu_lane"}
            ),
            "tracked_resident_bytes": measurement(
                tracked, "byte", "maximum"
            ),
            "planner_estimated_bytes": measurement(
                tracked, "byte", "maximum"
            ),
            "categories": categories,
        },
        "counters": {
            "forward_fft_count": measurement(
                layer_count, "count", "exact", sample_count=1
            ),
            "inverse_fft_count": measurement(
                layer_count, "count", "exact", sample_count=1
            ),
            "pair_multiply_count": measurement(
                layer_count * layer_count, "count", "exact", sample_count=1
            ),
            "kernel_layer_count": measurement(
                layer_count, "count", "exact", sample_count=1
            ),
            "kernel_pair_count": measurement(
                layer_count * layer_count, "count", "exact", sample_count=1
            ),
            "kernel_unique_count": measurement(
                layer_count, "count", "exact", sample_count=1
            ),
            "kernel_catalog_sha256": SHA,
        },
    }


def bind_attestation(payload: dict[str, object]) -> None:
    rows = payload["rows"]
    lane_bindings = {}
    for lane in ("cpu_fp64", "cuda_fp64"):
        lane_rows = [row for row in rows if row["lane"] == lane]
        if not lane_rows:
            continue
        identity = lane_rows[0]["artifact_identity"]
        lane_bindings[lane] = {
            "rows_sha256": canonical_digest(lane_rows),
            "source_snapshot_sha256": identity["source_snapshot_sha256"],
            "runtime_manifest_sha256": identity["runtime_manifest_sha256"],
            "runtime_binary_sha256": identity["runtime_binary_sha256"],
        }
    signed_payload = {
        "schema_version": payload["schema_version"],
        "provenance": payload["provenance"],
        "rows": rows,
    }
    payload["attestation"] = {
        "schema_version": ATTESTATION_SCHEMA,
        "producer_kind": "managed_lane_specific",
        "signature_algorithm": "ed25519",
        "key_id": "test-untrusted-key",
        "signed_payload_sha256": canonical_digest(signed_payload),
        "rows_sha256": canonical_digest(rows),
        "lane_bindings": lane_bindings,
        "signature_base64": base64.b64encode(bytes(64)).decode(),
    }


def complete_payload(*, include_l16: bool = False) -> dict[str, object]:
    layers = [1, 2, 4, 8] + ([16] if include_l16 else [])
    payload = {
        "schema_version": ARTIFACT_SCHEMA,
        "provenance": {
            "source_commit": "e" * 40,
            "dirty_state_manifest_sha256": "f" * 64,
            "scenario_schema_version": "fdm_multilayer_benchmark_scenario.v1",
            "scenario_sha256": "1" * 64,
            "thresholds_schema_version": "fdm_multilayer_benchmark_thresholds.v1",
            "thresholds_sha256": "5" * 64,
        },
        "rows": [
            benchmark_row(lane, count)
            for count in layers
            for lane in ("cpu_fp64", "cuda_fp64")
        ],
    }
    bind_attestation(payload)
    return payload


def write_payload(tmp_path: Path, payload: dict[str, object]) -> Path:
    path = tmp_path / "benchmark.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def cuda_row(payload: dict[str, object], layer_count: int) -> dict[str, object]:
    return next(
        row
        for row in payload["rows"]
        if row["lane"] == "cuda_fp64" and row["layer_count"] == layer_count
    )


def test_locally_fabricated_complete_payload_cannot_qualify(tmp_path: Path) -> None:
    report = validate_benchmark_artifact(write_payload(tmp_path, complete_payload()))

    assert report["schema_version"] == QUALIFICATION_SCHEMA
    assert report["contract_status"] == "valid"
    assert report["qualification_status"] == "not_qualified"
    assert set(report["reasons"]) == {
        "trusted_managed_attestation_unavailable",
        "cuda_native_device_resident_lane_unavailable",
    }


def test_preserves_real_execution_provenance_shape_and_stage_separately(
    tmp_path: Path,
) -> None:
    report = validate_benchmark_artifact(write_payload(tmp_path, complete_payload()))
    cpu = report["scaling_rows"][0]
    cuda = report["scaling_rows"][1]

    assert cpu["execution_provenance"]["execution_engine"] == "cpu_reference_multilayer"
    provenance = cuda["execution_provenance"]
    assert provenance["execution_engine"] == "cuda_assisted_multilayer"
    assert (
        provenance["fdm_multilayer_transfer_telemetry"]["execution_shape"]
        == "cuda_assisted_multilayer"
    )
    assert (
        provenance["fdm_multilayer_stage_telemetry"]["execution_engine"]
        == "cuda_native_multilayer_demag_v2"
    )


def test_missing_artifact_returns_clear_not_qualified_summary(tmp_path: Path) -> None:
    report = validate_benchmark_artifact(tmp_path / "missing.json")

    assert report["contract_status"] == "invalid"
    assert report["qualification_status"] == "not_qualified"
    assert report["reasons"] == [f"artifact_missing: {tmp_path / 'missing.json'}"]


def test_host_only_matrix_never_qualifies_as_gpu_evidence(tmp_path: Path) -> None:
    payload = complete_payload()
    payload["rows"] = [row for row in payload["rows"] if row["lane"] == "cpu_fp64"]
    bind_attestation(payload)

    report = validate_benchmark_artifact(write_payload(tmp_path, payload))

    assert report["qualification_status"] == "not_qualified"
    assert "cuda_lane_missing" in report["reasons"]
    assert "missing_required_row: cuda_fp64 L=1" in report["reasons"]


def test_rejects_invented_overall_engine_and_stage_shape(tmp_path: Path) -> None:
    payload = complete_payload()
    provenance = cuda_row(payload, 4)["execution_provenance"]
    provenance["execution_engine"] = "cuda_native_multilayer_demag_v2"
    provenance["fdm_multilayer_transfer_telemetry"]["execution_shape"] = "device_resident"
    bind_attestation(payload)

    report = validate_benchmark_artifact(write_payload(tmp_path, payload))

    assert (
        "cuda_fp64 L=4: overall execution_engine must be cuda_assisted_multilayer"
        in report["reasons"]
    )
    assert (
        "cuda_fp64 L=4: transfer execution_shape must be cuda_assisted_multilayer"
        in report["reasons"]
    )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("resolved_fallback", "cpu_reference"),
        ("lossy_fallback_used", True),
        ("ignored_terms", ["demag"]),
    ],
)
def test_rejects_cuda_provenance_that_records_a_fallback(
    tmp_path: Path, field: str, value: object
) -> None:
    payload = complete_payload()
    cuda_row(payload, 2)["execution_provenance"][field] = value
    bind_attestation(payload)

    report = validate_benchmark_artifact(write_payload(tmp_path, payload))

    assert report["contract_status"] == "invalid"
    assert report["qualification_status"] == "not_qualified"


@pytest.mark.parametrize("field", ["resolved_fallback", "lossy_fallback_used", "ignored_terms"])
def test_rejects_cuda_provenance_without_explicit_no_fallback_fields(
    tmp_path: Path, field: str
) -> None:
    payload = complete_payload()
    del cuda_row(payload, 2)["execution_provenance"][field]
    bind_attestation(payload)

    report = validate_benchmark_artifact(write_payload(tmp_path, payload))

    assert report["contract_status"] == "invalid"
    assert report["qualification_status"] == "not_qualified"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("resolved_fallback", {}),
        ("lossy_fallback_used", 0),
        ("lossy_fallback_used", "false"),
        ("ignored_terms", "[]"),
    ],
)
def test_rejects_cuda_provenance_with_malformed_no_fallback_fields(
    tmp_path: Path, field: str, value: object
) -> None:
    payload = complete_payload()
    cuda_row(payload, 2)["execution_provenance"][field] = value
    bind_attestation(payload)

    report = validate_benchmark_artifact(write_payload(tmp_path, payload))

    assert report["contract_status"] == "invalid"
    assert report["qualification_status"] == "not_qualified"


def test_zero_cuda_memory_and_transfer_evidence_is_rejected(tmp_path: Path) -> None:
    payload = complete_payload()
    row = cuda_row(payload, 2)
    transfer = row["execution_provenance"]["fdm_multilayer_transfer_telemetry"]
    transfer.update(
        {
            "h2d_transfer_count": 0,
            "d2h_transfer_count": 0,
            "h2d_bytes": 0,
            "d2h_bytes": 0,
        }
    )
    row["transfer"]["h2d_bytes"]["value"] = 0
    row["transfer"]["d2h_bytes"]["value"] = 0
    row["memory"]["peak_device_bytes"]["value"] = 0
    for item in row["memory"]["categories"].values():
        item["value"] = 0
    row["memory"]["tracked_resident_bytes"]["value"] = 0
    row["memory"]["planner_estimated_bytes"]["value"] = 0
    bind_attestation(payload)

    report = validate_benchmark_artifact(write_payload(tmp_path, payload))

    assert "cuda_fp64 L=2: CUDA transfer telemetry must be positive" in report["reasons"]
    assert "cuda_fp64 L=2: peak_device_bytes must be positive" in report["reasons"]
    assert "cuda_fp64 L=2: required CUDA memory categories must be positive" in report["reasons"]


def test_canonical_memory_absence_is_valid_but_blocks_qualification(
    tmp_path: Path,
) -> None:
    payload = complete_payload()
    row = cuda_row(payload, 1)
    row["memory"]["categories"]["scratch"] = {
        "absence_reason": "not_exposed_by_runtime_v1"
    }
    bind_attestation(payload)

    report = validate_benchmark_artifact(write_payload(tmp_path, payload))

    assert report["contract_status"] == "valid"
    assert report["qualification_status"] == "not_qualified"
    assert (
        "cuda_memory_category_absent: cuda_fp64 L=1 scratch=not_exposed_by_runtime_v1"
        in report["reasons"]
    )


def test_rejects_wrong_l_scaling_counters_and_memory_accounting(tmp_path: Path) -> None:
    payload = complete_payload()
    row = cuda_row(payload, 8)
    row["counters"]["forward_fft_count"]["value"] = 64
    row["counters"]["pair_multiply_count"]["value"] = 8
    row["memory"]["planner_estimated_bytes"]["value"] += 1
    bind_attestation(payload)

    report = validate_benchmark_artifact(write_payload(tmp_path, payload))

    assert "cuda_fp64 L=8: forward_fft_count must equal L" in report["reasons"]
    assert "cuda_fp64 L=8: pair_multiply_count must equal L^2" in report["reasons"]
    assert (
        "cuda_fp64 L=8: planner_estimated_bytes must equal tracked memory categories"
        in report["reasons"]
    )


def test_l16_is_optional_but_requires_both_lanes_when_present(tmp_path: Path) -> None:
    complete = validate_benchmark_artifact(
        write_payload(tmp_path, complete_payload(include_l16=True))
    )
    assert complete["contract_status"] == "valid"
    assert complete["observed_layer_counts"] == [1, 2, 4, 8, 16]

    payload = complete_payload(include_l16=True)
    payload["rows"] = [
        row
        for row in payload["rows"]
        if not (row["lane"] == "cuda_fp64" and row["layer_count"] == 16)
    ]
    bind_attestation(payload)
    incomplete = validate_benchmark_artifact(write_payload(tmp_path, payload))
    assert incomplete["contract_status"] == "invalid"
    assert "optional_L16_matrix_incomplete" in incomplete["reasons"]


def test_unknown_or_mixed_measurement_units_are_rejected(tmp_path: Path) -> None:
    payload = complete_payload()
    row = cuda_row(payload, 1)
    row["warm"]["apply"]["unit"] = "us"
    row["memory"]["categories"]["fft_workspace"]["unit"] = "MiB"
    row["cold"]["kernel_setup"]["sample_count"] = 0
    bind_attestation(payload)

    report = validate_benchmark_artifact(write_payload(tmp_path, payload))

    assert "cuda_fp64 L=1.warm.apply.unit must be ns" in report["reasons"]
    assert (
        "cuda_fp64 L=1.memory.categories.fft_workspace.unit must be byte"
        in report["reasons"]
    )
    assert (
        "cuda_fp64 L=1.cold.kernel_setup.sample_count must be positive"
        in report["reasons"]
    )


def test_attestation_must_bind_payload_rows_and_lane_runtime_identities(
    tmp_path: Path,
) -> None:
    payload = complete_payload()
    payload["attestation"]["rows_sha256"] = "0" * 64
    payload["attestation"]["lane_bindings"]["cuda_fp64"][
        "runtime_binary_sha256"
    ] = "9" * 64

    report = validate_benchmark_artifact(write_payload(tmp_path, payload))

    assert "attestation.rows_sha256 does not bind rows" in report["reasons"]
    assert (
        "attestation.lane_bindings.cuda_fp64.runtime_binary_sha256 does not match rows"
        in report["reasons"]
    )


def test_cli_writes_not_qualified_report_for_structurally_valid_input(
    tmp_path: Path,
) -> None:
    artifact = write_payload(tmp_path, complete_payload())
    output = tmp_path / "qualification.json"

    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(artifact), "--output", str(output)],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 1
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["contract_status"] == "valid"
    assert report["qualification_status"] == "not_qualified"


def test_validation_does_not_mutate_caller_payload(tmp_path: Path) -> None:
    payload = complete_payload()
    expected = copy.deepcopy(payload)

    validate_payload(payload, artifact_path=tmp_path / "benchmark.json")

    assert payload == expected
