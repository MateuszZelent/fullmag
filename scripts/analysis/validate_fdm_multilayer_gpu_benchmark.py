#!/usr/bin/env python3
"""Validate fail-closed FDM multilayer CPU/CUDA benchmark artifacts.

This module validates the benchmark schema and cryptographic binding fields.
It deliberately cannot qualify an artifact until a trusted lane-specific
managed producer and signature verifier are wired into the gate.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import copy
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any


ARTIFACT_SCHEMA = "fullmag.fdm_multilayer_gpu_benchmark.v2"
QUALIFICATION_SCHEMA = "fullmag.fdm_multilayer_gpu_benchmark_qualification.v2"
MEASUREMENT_SCHEMA = "fullmag.benchmark_measurement.v1"
ATTESTATION_SCHEMA = "fullmag.managed_lane_attestation.v1"
TRUST_GATE_REASON = "trusted_managed_attestation_unavailable"
REQUIRED_LAYER_COUNTS = (1, 2, 4, 8)
OPTIONAL_LAYER_COUNT = 16
LANES = ("cpu_fp64", "cuda_fp64")
MEMORY_CATEGORIES = (
    "magnetization",
    "fields",
    "fft_workspace",
    "kernel_catalog",
    "scratch",
)
IDENTITY_KEYS = (
    "source_snapshot_sha256",
    "runtime_manifest_sha256",
    "runtime_binary_sha256",
)
SHA256_RE = re.compile(r"[0-9a-f]{64}")
COMMIT_RE = re.compile(r"[0-9a-f]{40}")


class BenchmarkContractError(ValueError):
    """Raised when an artifact cannot be parsed as a benchmark object."""


def canonical_digest(value: object) -> str:
    """Return the SHA-256 of the canonical JSON representation used by v2."""

    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def parse_benchmark_artifact(path: Path) -> dict[str, Any]:
    """Read one JSON object without inventing unavailable observations."""

    if not path.is_file():
        raise BenchmarkContractError(f"artifact_missing: {path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BenchmarkContractError(f"artifact_unreadable: {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise BenchmarkContractError("artifact_malformed: top-level object required")
    return payload


def _empty_report(path: Path) -> dict[str, Any]:
    return {
        "schema_version": QUALIFICATION_SCHEMA,
        "contract_status": "invalid",
        "qualification_status": "not_qualified",
        "artifact_path": str(path),
        "artifact_schema_version": None,
        "required_layer_counts": list(REQUIRED_LAYER_COUNTS),
        "observed_layer_counts": [],
        "provenance": {},
        "attestation": {},
        "scaling_rows": [],
        "qualification_blockers": [],
        "reasons": [],
    }


def _object(value: object, label: str, reasons: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        reasons.append(f"{label} must be an object")
        return {}
    return value


def _sha256(value: object, label: str, reasons: list[str]) -> str | None:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        reasons.append(f"{label} must be a SHA-256 digest")
        return None
    return value


def _nonnegative_int(value: object, label: str, reasons: list[str]) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        reasons.append(f"{label} must be a non-negative integer")
        return None
    return value


def _measurement(
    value: object,
    label: str,
    *,
    unit: str,
    statistic: str,
    reasons: list[str],
    positive: bool = False,
    integer: bool = False,
    sample_count: int | None = None,
    absence_reasons: tuple[str, ...] = (),
) -> int | float | None:
    observation = _object(value, label, reasons)
    absence_reason = observation.get("absence_reason")
    if absence_reason is not None:
        if absence_reason not in absence_reasons:
            reasons.append(f"{label}.absence_reason is not canonical")
        return None
    if observation.get("schema_version") != MEASUREMENT_SCHEMA:
        reasons.append(f"{label}.schema_version must be {MEASUREMENT_SCHEMA}")
    if observation.get("unit") != unit:
        reasons.append(f"{label}.unit must be {unit}")
    if observation.get("statistic") != statistic:
        reasons.append(f"{label}.statistic must be {statistic}")
    samples = _nonnegative_int(
        observation.get("sample_count"), f"{label}.sample_count", reasons
    )
    if samples is not None and samples == 0:
        reasons.append(f"{label}.sample_count must be positive")
    if sample_count is not None and samples is not None and samples != sample_count:
        reasons.append(f"{label}.sample_count must be {sample_count}")
    measured = observation.get("value")
    if isinstance(measured, bool) or not isinstance(measured, (int, float)):
        reasons.append(f"{label}.value must be numeric")
        return None
    number = float(measured)
    if not math.isfinite(number) or number < 0.0:
        reasons.append(f"{label}.value must be non-negative and finite")
        return None
    if positive and number <= 0.0:
        reasons.append(f"{label}.value must be positive")
    if integer and (not isinstance(measured, int) or isinstance(measured, bool)):
        reasons.append(f"{label}.value must be an integer")
        return None
    return measured


def _validate_provenance(payload: dict[str, Any], reasons: list[str]) -> dict[str, Any]:
    provenance = _object(payload.get("provenance"), "provenance", reasons)
    commit = provenance.get("source_commit")
    if not isinstance(commit, str) or COMMIT_RE.fullmatch(commit) is None:
        reasons.append("provenance.source_commit must be a full 40-character commit")
    for key in (
        "dirty_state_manifest_sha256",
        "scenario_sha256",
        "thresholds_sha256",
    ):
        _sha256(provenance.get(key), f"provenance.{key}", reasons)
    for key in ("scenario_schema_version", "thresholds_schema_version"):
        if not isinstance(provenance.get(key), str) or not provenance[key]:
            reasons.append(f"provenance.{key} must be a non-empty string")
    return provenance


def _validate_requested_execution(
    row: dict[str, Any], label: str, gpu: bool, reasons: list[str]
) -> None:
    requested = _object(
        row.get("requested_execution"), f"{label}.requested_execution", reasons
    )
    expected = {
        "backend": "fdm",
        "device": "gpu" if gpu else "cpu",
        "precision": "double",
        "mode": "strict",
        "fallback_policy": "forbidden",
    }
    for key, expected_value in expected.items():
        if requested.get(key) != expected_value:
            reasons.append(
                f"{label}: requested_execution.{key} must be {expected_value}"
            )


def _validate_identity(
    row: dict[str, Any], label: str, reasons: list[str]
) -> dict[str, Any]:
    identity = _object(row.get("artifact_identity"), f"{label}.artifact_identity", reasons)
    _sha256(
        identity.get("metadata_sha256"),
        f"{label}.artifact_identity.metadata_sha256",
        reasons,
    )
    for key in IDENTITY_KEYS:
        _sha256(identity.get(key), f"{label}.artifact_identity.{key}", reasons)
    return identity


def _validate_cpu_provenance(
    provenance: dict[str, Any], label: str, reasons: list[str]
) -> None:
    if provenance.get("execution_engine") != "cpu_reference_multilayer":
        reasons.append(
            f"{label}: overall execution_engine must be cpu_reference_multilayer"
        )
    if provenance.get("precision") != "double":
        reasons.append(f"{label}: execution_provenance.precision must be double")


def _validate_cuda_provenance(
    provenance: dict[str, Any], label: str, layer_count: int, reasons: list[str]
) -> tuple[dict[str, Any], dict[str, Any]]:
    if provenance.get("execution_engine") != "cuda_assisted_multilayer":
        reasons.append(
            f"{label}: overall execution_engine must be cuda_assisted_multilayer"
        )
    if provenance.get("precision") != "double":
        reasons.append(f"{label}: execution_provenance.precision must be double")
    if (
        "resolved_fallback" not in provenance
        or provenance["resolved_fallback"] is not None
    ):
        reasons.append(
            f"{label}: execution_provenance.resolved_fallback must be null"
        )
    if provenance.get("lossy_fallback_used") is not False:
        reasons.append(
            f"{label}: execution_provenance.lossy_fallback_used must be false"
        )
    if type(provenance.get("ignored_terms")) is not list or provenance[
        "ignored_terms"
    ]:
        reasons.append(f"{label}: execution_provenance.ignored_terms must be []")
    if provenance.get("fft_backend") != "cuFFT":
        reasons.append(f"{label}: execution_provenance.fft_backend must be cuFFT")
    for key in ("device_name", "compute_capability"):
        if not isinstance(provenance.get(key), str) or not provenance[key]:
            reasons.append(f"{label}: execution_provenance.{key} is required")
    for key in ("cuda_driver_version", "cuda_runtime_version"):
        version = _nonnegative_int(
            provenance.get(key), f"{label}.execution_provenance.{key}", reasons
        )
        if version is not None and version == 0:
            reasons.append(f"{label}: execution_provenance.{key} must be positive")

    transfer = _object(
        provenance.get("fdm_multilayer_transfer_telemetry"),
        f"{label}.execution_provenance.fdm_multilayer_transfer_telemetry",
        reasons,
    )
    if transfer.get("execution_shape") != "cuda_assisted_multilayer":
        reasons.append(
            f"{label}: transfer execution_shape must be cuda_assisted_multilayer"
        )
    if (
        transfer.get("data_residency")
        != "host_authoritative_with_cuda_field_roundtrips"
    ):
        reasons.append(f"{label}: transfer data_residency must be host-authoritative")
    transfer_values = [
        _nonnegative_int(transfer.get(key), f"{label}: transfer {key}", reasons)
        for key in (
            "h2d_transfer_count",
            "d2h_transfer_count",
            "h2d_bytes",
            "d2h_bytes",
        )
    ]
    if all(value is not None for value in transfer_values) and any(
        value == 0 for value in transfer_values
    ):
        reasons.append(f"{label}: CUDA transfer telemetry must be positive")

    stage = _object(
        provenance.get("fdm_multilayer_stage_telemetry"),
        f"{label}.execution_provenance.fdm_multilayer_stage_telemetry",
        reasons,
    )
    expected_stage: dict[str, object] = {
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
    for key, expected_value in expected_stage.items():
        if stage.get(key) != expected_value:
            reasons.append(f"{label}: stage {key} must be {expected_value}")
    return transfer, stage


def _validate_execution_provenance(
    row: dict[str, Any], label: str, gpu: bool, layer_count: int, reasons: list[str]
) -> tuple[dict[str, Any], dict[str, Any]]:
    provenance = _object(
        row.get("execution_provenance"), f"{label}.execution_provenance", reasons
    )
    if gpu:
        return _validate_cuda_provenance(provenance, label, layer_count, reasons)
    _validate_cpu_provenance(provenance, label, reasons)
    return {}, {}


def _validate_timings(row: dict[str, Any], label: str, reasons: list[str]) -> None:
    cold = _object(row.get("cold"), f"{label}.cold", reasons)
    for key in ("kernel_setup", "fft_plan_setup", "total"):
        _measurement(
            cold.get(key),
            f"{label}.cold.{key}",
            unit="ns",
            statistic="median",
            reasons=reasons,
            positive=True,
        )
    warm = _object(row.get("warm"), f"{label}.warm", reasons)
    for key in ("apply", "pair_multiply", "forward_fft", "inverse_fft"):
        _measurement(
            warm.get(key),
            f"{label}.warm.{key}",
            unit="ns",
            statistic="median",
            reasons=reasons,
            positive=True,
        )
    allocations = _measurement(
        warm.get("large_allocation_count"),
        f"{label}.warm.large_allocation_count",
        unit="count",
        statistic="maximum",
        reasons=reasons,
        integer=True,
    )
    if allocations is not None and allocations != 0:
        reasons.append(f"{label}: warm large_allocation_count must be zero")


def _validate_transfer_measurements(
    row: dict[str, Any],
    label: str,
    gpu: bool,
    provenance_transfer: dict[str, Any],
    reasons: list[str],
) -> None:
    transfer = _object(row.get("transfer"), f"{label}.transfer", reasons)
    _measurement(
        transfer.get("total"),
        f"{label}.transfer.total",
        unit="ns",
        statistic="median",
        reasons=reasons,
        positive=gpu,
    )
    h2d = _measurement(
        transfer.get("h2d_bytes"),
        f"{label}.transfer.h2d_bytes",
        unit="byte",
        statistic="median",
        reasons=reasons,
        positive=gpu,
        integer=True,
    )
    d2h = _measurement(
        transfer.get("d2h_bytes"),
        f"{label}.transfer.d2h_bytes",
        unit="byte",
        statistic="median",
        reasons=reasons,
        positive=gpu,
        integer=True,
    )
    if gpu:
        if h2d is not None and h2d != provenance_transfer.get("h2d_bytes"):
            reasons.append(f"{label}: measured H2D bytes differ from provenance")
        if d2h is not None and d2h != provenance_transfer.get("d2h_bytes"):
            reasons.append(f"{label}: measured D2H bytes differ from provenance")
    elif h2d not in (None, 0) or d2h not in (None, 0):
        reasons.append(f"{label}: CPU lane transfer bytes must be zero")


def _validate_memory(
    row: dict[str, Any],
    label: str,
    gpu: bool,
    reasons: list[str],
    qualification_blockers: list[str],
) -> None:
    memory = _object(row.get("memory"), f"{label}.memory", reasons)
    peak = _measurement(
        memory.get("peak_device_bytes"),
        f"{label}.memory.peak_device_bytes",
        unit="byte",
        statistic="maximum",
        reasons=reasons,
        positive=gpu,
        integer=True,
        absence_reasons=("not_applicable_cpu_lane",) if not gpu else (),
    )
    tracked = _measurement(
        memory.get("tracked_resident_bytes"),
        f"{label}.memory.tracked_resident_bytes",
        unit="byte",
        statistic="maximum",
        reasons=reasons,
        positive=True,
        integer=True,
    )
    planned = _measurement(
        memory.get("planner_estimated_bytes"),
        f"{label}.memory.planner_estimated_bytes",
        unit="byte",
        statistic="maximum",
        reasons=reasons,
        positive=True,
        integer=True,
    )
    categories = _object(
        memory.get("categories"), f"{label}.memory.categories", reasons
    )
    category_values: list[int | float | None] = []
    for key in MEMORY_CATEGORIES:
        category = categories.get(key)
        value = _measurement(
            category,
            f"{label}.memory.categories.{key}",
            unit="byte",
            statistic="maximum",
            reasons=reasons,
            positive=gpu,
            integer=True,
            absence_reasons=("not_exposed_by_runtime_v1",),
        )
        category_values.append(value)
        if (
            gpu
            and isinstance(category, dict)
            and category.get("absence_reason") == "not_exposed_by_runtime_v1"
        ):
            qualification_blockers.append(
                f"cuda_memory_category_absent: {label} "
                f"{key}=not_exposed_by_runtime_v1"
            )
    present_values = [value for value in category_values if value is not None]
    if gpu and any(value == 0 for value in present_values):
        reasons.append(f"{label}: required CUDA memory categories must be positive")
    if len(present_values) == len(MEMORY_CATEGORIES):
        category_total = sum(present_values)
        if tracked is not None and tracked != category_total:
            reasons.append(
                f"{label}: tracked_resident_bytes must equal tracked memory categories"
            )
        if planned is not None and planned != category_total:
            reasons.append(
                f"{label}: planner_estimated_bytes must equal tracked memory categories"
            )
    if gpu and peak is not None:
        if peak == 0:
            reasons.append(f"{label}: peak_device_bytes must be positive")
        if tracked is not None and peak < tracked:
            reasons.append(
                f"{label}: peak_device_bytes must cover tracked resident memory"
            )


def _validate_counters(
    row: dict[str, Any],
    label: str,
    layer_count: int,
    stage: dict[str, Any],
    reasons: list[str],
) -> None:
    counters = _object(row.get("counters"), f"{label}.counters", reasons)
    expected = {
        "forward_fft_count": (layer_count, "L"),
        "inverse_fft_count": (layer_count, "L"),
        "pair_multiply_count": (layer_count * layer_count, "L^2"),
        "kernel_layer_count": (layer_count, "L"),
        "kernel_pair_count": (layer_count * layer_count, "L^2"),
    }
    measured: dict[str, int | float | None] = {}
    for key, (expected_value, scale) in expected.items():
        measured[key] = _measurement(
            counters.get(key),
            f"{label}.counters.{key}",
            unit="count",
            statistic="exact",
            reasons=reasons,
            integer=True,
            sample_count=1,
        )
        if measured[key] is not None and measured[key] != expected_value:
            reasons.append(f"{label}: {key} must equal {scale}")
    unique = _measurement(
        counters.get("kernel_unique_count"),
        f"{label}.counters.kernel_unique_count",
        unit="count",
        statistic="exact",
        reasons=reasons,
        positive=True,
        integer=True,
        sample_count=1,
    )
    if unique is not None and unique > layer_count * layer_count:
        reasons.append(f"{label}: kernel_unique_count must be within [1, L^2]")
    _sha256(
        counters.get("kernel_catalog_sha256"),
        f"{label}.counters.kernel_catalog_sha256",
        reasons,
    )
    if stage:
        stage_links = {
            "forward_fft_count": "forward_fft_count",
            "inverse_fft_count": "inverse_fft_count",
            "pair_multiply_count": "pair_accumulation_count",
        }
        for counter_key, stage_key in stage_links.items():
            value = measured.get(counter_key)
            if value is not None and value != stage.get(stage_key):
                reasons.append(f"{label}: {counter_key} differs from stage telemetry")


def _validate_row(
    row: dict[str, Any],
    lane: str,
    layer_count: int,
    reasons: list[str],
    qualification_blockers: list[str],
) -> dict[str, Any]:
    label = f"{lane} L={layer_count}"
    gpu = lane == "cuda_fp64"
    _validate_requested_execution(row, label, gpu, reasons)
    identity = _validate_identity(row, label, reasons)
    provenance_transfer, stage = _validate_execution_provenance(
        row, label, gpu, layer_count, reasons
    )
    _validate_timings(row, label, reasons)
    _validate_transfer_measurements(
        row, label, gpu, provenance_transfer, reasons
    )
    _validate_memory(row, label, gpu, reasons, qualification_blockers)
    _validate_counters(row, label, layer_count, stage, reasons)
    return identity


def _validate_attestation(
    payload: dict[str, Any],
    seen: dict[tuple[str, int], dict[str, Any]],
    identities: dict[tuple[str, int], dict[str, Any]],
    reasons: list[str],
) -> dict[str, Any]:
    attestation = _object(payload.get("attestation"), "attestation", reasons)
    if attestation.get("schema_version") != ATTESTATION_SCHEMA:
        reasons.append(f"attestation.schema_version must be {ATTESTATION_SCHEMA}")
    if attestation.get("producer_kind") != "managed_lane_specific":
        reasons.append("attestation.producer_kind must be managed_lane_specific")
    if attestation.get("signature_algorithm") != "ed25519":
        reasons.append("attestation.signature_algorithm must be ed25519")
    if not isinstance(attestation.get("key_id"), str) or not attestation["key_id"]:
        reasons.append("attestation.key_id must be non-empty")
    signature = attestation.get("signature_base64")
    try:
        decoded = base64.b64decode(signature, validate=True)
        if len(decoded) != 64:
            raise ValueError("wrong Ed25519 signature length")
    except (TypeError, ValueError, binascii.Error):
        reasons.append("attestation.signature_base64 must contain signature bytes")

    rows = payload.get("rows", [])
    signed_payload = {
        "schema_version": payload.get("schema_version"),
        "provenance": payload.get("provenance"),
        "rows": rows,
    }
    expected_payload_digest = canonical_digest(signed_payload)
    expected_rows_digest = canonical_digest(rows)
    _sha256(
        attestation.get("signed_payload_sha256"),
        "attestation.signed_payload_sha256",
        reasons,
    )
    _sha256(attestation.get("rows_sha256"), "attestation.rows_sha256", reasons)
    if attestation.get("signed_payload_sha256") != expected_payload_digest:
        reasons.append("attestation.signed_payload_sha256 does not bind payload")
    if attestation.get("rows_sha256") != expected_rows_digest:
        reasons.append("attestation.rows_sha256 does not bind rows")

    bindings = _object(
        attestation.get("lane_bindings"), "attestation.lane_bindings", reasons
    )
    for lane in LANES:
        lane_rows = [row for (row_lane, _), row in seen.items() if row_lane == lane]
        if not lane_rows:
            continue
        binding = _object(
            bindings.get(lane), f"attestation.lane_bindings.{lane}", reasons
        )
        _sha256(
            binding.get("rows_sha256"),
            f"attestation.lane_bindings.{lane}.rows_sha256",
            reasons,
        )
        if binding.get("rows_sha256") != canonical_digest(lane_rows):
            reasons.append(
                f"attestation.lane_bindings.{lane}.rows_sha256 does not bind lane rows"
            )
        lane_identities = [
            identities[key] for key in seen if key[0] == lane and key in identities
        ]
        for identity_key in IDENTITY_KEYS:
            _sha256(
                binding.get(identity_key),
                f"attestation.lane_bindings.{lane}.{identity_key}",
                reasons,
            )
            values = {identity.get(identity_key) for identity in lane_identities}
            if len(values) != 1 or binding.get(identity_key) not in values:
                reasons.append(
                    f"attestation.lane_bindings.{lane}.{identity_key} does not match rows"
                )
    return attestation


def validate_payload(payload: dict[str, Any], *, artifact_path: Path) -> dict[str, Any]:
    """Validate v2 structure while keeping qualification closed without trust."""

    report = _empty_report(artifact_path)
    reasons: list[str] = report["reasons"]
    qualification_blockers: list[str] = report["qualification_blockers"]
    report["artifact_schema_version"] = payload.get("schema_version")
    if payload.get("schema_version") != ARTIFACT_SCHEMA:
        reasons.append(f"schema_version must be {ARTIFACT_SCHEMA}")
    provenance = _validate_provenance(payload, reasons)
    report["provenance"] = copy.deepcopy(provenance)

    raw_rows = payload.get("rows")
    if not isinstance(raw_rows, list):
        reasons.append("rows must be a list")
        raw_rows = []
    seen: dict[tuple[str, int], dict[str, Any]] = {}
    identities: dict[tuple[str, int], dict[str, Any]] = {}
    observed_layers: set[int] = set()
    allowed_layers = (*REQUIRED_LAYER_COUNTS, OPTIONAL_LAYER_COUNT)
    for index, value in enumerate(raw_rows):
        if not isinstance(value, dict):
            reasons.append(f"rows[{index}] must be an object")
            continue
        lane = value.get("lane")
        layer_count = value.get("layer_count")
        if lane not in LANES:
            reasons.append(f"rows[{index}].lane must be cpu_fp64 or cuda_fp64")
            continue
        if (
            isinstance(layer_count, bool)
            or not isinstance(layer_count, int)
            or layer_count not in allowed_layers
        ):
            reasons.append(f"rows[{index}].layer_count must be one of 1,2,4,8,16")
            continue
        key = (lane, layer_count)
        if key in seen:
            reasons.append(f"duplicate_row: {lane} L={layer_count}")
            continue
        seen[key] = value
        observed_layers.add(layer_count)
        identities[key] = _validate_row(
            value,
            lane,
            layer_count,
            reasons,
            qualification_blockers,
        )

    if not any(lane == "cuda_fp64" for lane, _ in seen):
        reasons.append("cuda_lane_missing")
    for layer_count in REQUIRED_LAYER_COUNTS:
        for lane in LANES:
            if (lane, layer_count) not in seen:
                reasons.append(f"missing_required_row: {lane} L={layer_count}")
    l16_lanes = {lane for lane, layer_count in seen if layer_count == OPTIONAL_LAYER_COUNT}
    if l16_lanes and l16_lanes != set(LANES):
        reasons.append("optional_L16_matrix_incomplete")

    attestation = _validate_attestation(payload, seen, identities, reasons)
    report["attestation"] = copy.deepcopy(attestation)
    report["observed_layer_counts"] = sorted(observed_layers)
    report["scaling_rows"] = [
        copy.deepcopy(row)
        for _, row in sorted(
            seen.items(), key=lambda item: (item[0][1], LANES.index(item[0][0]))
        )
    ]
    if not reasons:
        report["contract_status"] = "valid"
        if any(lane == "cuda_fp64" for lane, _ in seen):
            qualification_blockers.append(
                "cuda_native_device_resident_lane_unavailable"
            )
        qualification_blockers.append(TRUST_GATE_REASON)
        reasons.extend(qualification_blockers)
    return report


def validate_benchmark_artifact(path: Path) -> dict[str, Any]:
    """Parse and validate an artifact with a fail-closed structured result."""

    try:
        payload = parse_benchmark_artifact(path)
    except BenchmarkContractError as exc:
        report = _empty_report(path)
        report["reasons"].append(str(exc))
        return report
    return validate_payload(payload, artifact_path=path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    report = validate_benchmark_artifact(args.artifact)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
