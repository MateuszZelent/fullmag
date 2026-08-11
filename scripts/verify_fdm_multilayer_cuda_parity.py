#!/usr/bin/env python3
"""Fail-closed CPU/CUDA parity and D-07 provenance verifier."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path


THRESHOLDS_SCHEMA = "fdm_multilayer_thresholds.v1"
QUALIFICATION_SCOPE = "SP4-derived, not canonical SP4 qualification"
CUDA_EXECUTION_SHAPE = "cuda_native_multilayer_convolution"
CUDA_STAGE_ENGINE = "cuda_native_multilayer_demag_v2"
DEVICE_IDENTITY_FIELDS = (
    "device_name",
    "compute_capability",
    "cuda_driver_version",
    "cuda_runtime_version",
)


def read_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object: {path}")
    return value


def field_values(root: Path) -> tuple[list[float], tuple[str, ...], int]:
    manifest = read_json(root / "fields" / "H_demag" / "manifest.json")
    layers = manifest.get("layers")
    if not isinstance(layers, list) or not layers:
        raise ValueError("H_demag layer manifest is empty or malformed")
    values: list[float] = []
    layer_ids: list[str] = []
    snapshot_step: int | None = None
    for layer in layers:
        if not isinstance(layer, dict):
            raise ValueError("H_demag layer manifest entry is malformed")
        layer_id = layer.get("id")
        directory = layer.get("directory")
        if not isinstance(layer_id, str) or not layer_id or not isinstance(directory, str):
            raise ValueError("H_demag layer identity is malformed")
        if layer_id in layer_ids:
            raise ValueError(f"duplicate H_demag layer identity: {layer_id}")
        layer_ids.append(layer_id)
        paths = sorted((root / "fields" / "H_demag" / directory).glob("step_*.json"))
        if not paths:
            raise ValueError(f"missing H_demag snapshots for {layer_id}")
        payload = read_json(paths[-1])
        expected_contract = {
            "observable": "H_demag",
            "unit": "A/m",
            "component_count": 3,
            "component_order": "xyz",
            "location": "cell",
            "scope": "layer",
        }
        if any(payload.get(key) != value for key, value in expected_contract.items()):
            raise ValueError(f"invalid H_demag contract for {layer_id}")
        payload_layer = payload.get("layer")
        if not isinstance(payload_layer, dict) or payload_layer.get("id") != layer_id:
            raise ValueError(f"invalid H_demag layer provenance for {layer_id}")
        step = payload.get("step")
        if isinstance(step, bool) or not isinstance(step, int) or step < 0:
            raise ValueError(f"invalid H_demag step for {layer_id}")
        if paths[-1].name != f"step_{step:06d}.json":
            raise ValueError(f"H_demag filename/step mismatch for {layer_id}")
        if snapshot_step is None:
            snapshot_step = step
        elif snapshot_step != step:
            raise ValueError("H_demag layer snapshot steps differ")
        vectors = payload.get("values")
        if not isinstance(vectors, list) or not vectors:
            raise ValueError(f"missing H_demag values for {layer_id}")
        for vector in vectors:
            if not isinstance(vector, list) or len(vector) != 3:
                raise ValueError(f"invalid H_demag vector for {layer_id}")
            values.extend(float(component) for component in vector)
    if not values or not all(math.isfinite(value) for value in values):
        raise ValueError("H_demag payload is empty or non-finite")
    if snapshot_step is None:
        raise ValueError("H_demag snapshot step is missing")
    return values, tuple(layer_ids), snapshot_step


def _provenance(metadata: dict, label: str) -> dict:
    provenance = metadata.get("execution_provenance")
    if not isinstance(provenance, dict):
        raise ValueError(f"{label}_execution_provenance_missing")
    return provenance


def _validate_requested_execution(metadata: dict, device: str, precision: str, label: str) -> None:
    requested = metadata.get("requested_execution")
    expected = {
        "backend": "fdm",
        "device": device,
        "precision": precision,
        "mode": "strict",
        "fallback_policy": "forbidden",
    }
    if not isinstance(requested, dict):
        raise ValueError(f"{label}_requested_execution_missing")
    for key, value in expected.items():
        if requested.get(key) != value:
            raise ValueError(f"{label}_requested_execution_mismatch:{key}")


def _validate_no_fallback(provenance: dict) -> None:
    fallback = provenance.get("resolved_fallback")
    if fallback is not None:
        if not isinstance(fallback, dict) or not isinstance(fallback.get("occurred"), bool):
            raise ValueError("fallback_provenance_malformed")
        if fallback["occurred"]:
            fallback_engine = str(fallback.get("fallback_engine", "")).lower()
            if "cpu" in fallback_engine:
                raise ValueError("cpu_fallback_not_qualified")
            raise ValueError("cuda_fallback_not_qualified")
    if provenance.get("lossy_fallback_used") is not False:
        raise ValueError("lossy_fallback_not_qualified")
    ignored_terms = provenance.get("ignored_terms", [])
    if ignored_terms != []:
        raise ValueError("ignored_physics_terms_not_qualified")


def _validate_device_identity(provenance: dict, label: str) -> dict:
    identity = {key: provenance.get(key) for key in DEVICE_IDENTITY_FIELDS}
    if not isinstance(identity["device_name"], str) or not identity["device_name"].strip():
        raise ValueError(f"{label}_cuda_device_identity_incomplete:device_name")
    if not isinstance(identity["compute_capability"], str) or not identity[
        "compute_capability"
    ].strip():
        raise ValueError(f"{label}_cuda_device_identity_incomplete:compute_capability")
    for key in ("cuda_driver_version", "cuda_runtime_version"):
        value = identity[key]
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"{label}_cuda_device_identity_incomplete:{key}")
    return identity


def _validate_cuda_artifact(metadata: dict, layer_count: int, precision: str, label: str) -> dict:
    _validate_requested_execution(metadata, "gpu", precision, label)
    provenance = _provenance(metadata, label)
    _validate_no_fallback(provenance)

    transfer = provenance.get("fdm_multilayer_transfer_telemetry")
    if not isinstance(transfer, dict):
        raise ValueError("cuda_transfer_telemetry_missing")
    execution_shape = transfer.get("execution_shape")
    residency = transfer.get("data_residency")
    if execution_shape == "cuda_assisted_multilayer" or (
        isinstance(residency, str)
        and any(marker in residency.lower() for marker in ("host", "cpu", "assisted"))
    ):
        raise ValueError("cuda_device_residency_not_qualified")
    if execution_shape != CUDA_EXECUTION_SHAPE:
        raise ValueError("cuda_execution_shape_not_qualified")
    if not isinstance(residency, str) or "device" not in residency.lower():
        raise ValueError("cuda_device_residency_not_qualified")
    for key in ("h2d_transfer_count", "d2h_transfer_count", "h2d_bytes", "d2h_bytes"):
        value = transfer.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f"cuda_transfer_telemetry_invalid:{key}")

    if provenance.get("execution_engine") != CUDA_EXECUTION_SHAPE:
        engine = str(provenance.get("execution_engine", "")).lower()
        if "cpu" in engine:
            raise ValueError("cpu_fallback_not_qualified")
        if "assisted" in engine:
            raise ValueError("cuda_device_residency_not_qualified")
        raise ValueError("cuda_execution_engine_not_qualified")
    expected_provenance = {
        "precision": precision,
        "demag_operator_kind": "native_multilayer_tensor_fft_newell",
        "fft_backend": "cuFFT",
    }
    for key, value in expected_provenance.items():
        if provenance.get(key) != value:
            raise ValueError(f"cuda_execution_provenance_mismatch:{key}")

    stage = provenance.get("fdm_multilayer_stage_telemetry")
    if not isinstance(stage, dict) or stage.get("status") != "recorded":
        raise ValueError("d07_telemetry_not_qualified")
    expected_stage = {
        "execution_engine": CUDA_STAGE_ENGINE,
        "data_residency": "device_resident_per_refresh",
        "fft_backend": "cuFFT",
        "layer_count": layer_count,
        "refresh_count": 1,
        "forward_fft_count": layer_count,
        "inverse_fft_count": layer_count,
        "pair_accumulation_count": layer_count * layer_count,
    }
    for key, value in expected_stage.items():
        if stage.get(key) != value:
            raise ValueError(f"d07_telemetry_not_qualified:{key}")
    return {
        "provenance": provenance,
        "stage": stage,
        "transfer": transfer,
        "device_identity": _validate_device_identity(provenance, label),
    }


def _validate_artifact_identity(reference: dict, candidate: dict) -> dict:
    reference_source = reference.get("source_hash")
    candidate_source = candidate.get("source_hash")
    if reference_source != candidate_source:
        raise ValueError("artifact_source_hash_mismatch")
    reference_version = reference.get("engine_version")
    candidate_version = candidate.get("engine_version")
    if not isinstance(reference_version, str) or reference_version != candidate_version:
        raise ValueError("artifact_engine_version_mismatch")
    return {
        "source_hash": reference_source if reference_source is not None else "not_exposed",
        "engine_version": reference_version,
    }


def _validate_thresholds(path: Path) -> tuple[dict, str]:
    limits = read_json(path)
    if limits.get("schema_version") != THRESHOLDS_SCHEMA:
        raise ValueError("thresholds_schema_mismatch")
    if limits.get("qualification_scope") != QUALIFICATION_SCOPE:
        raise ValueError("thresholds_qualification_scope_mismatch")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return limits, f"sha256:{digest}"


def _validate_completed_run(metadata: dict, label: str) -> None:
    if metadata.get("status") != "completed":
        raise ValueError(f"{label}_run_not_completed")


def verify(cpu: Path, cuda: Path, thresholds: Path, lane: str) -> dict:
    if lane not in ("cuda-fp64", "cuda-fp32"):
        raise ValueError("unsupported_lane")
    reference_values, reference_layers, reference_step = field_values(cpu)
    candidate_values, candidate_layers, candidate_step = field_values(cuda)
    if reference_layers != candidate_layers:
        raise ValueError("reference_candidate_layer_identity_mismatch")
    if reference_step != candidate_step:
        raise ValueError("reference_candidate_snapshot_step_mismatch")
    if len(reference_values) != len(candidate_values):
        raise ValueError("reference_candidate_H_demag_payload_lengths_differ")

    reference_metadata = read_json(cpu / "metadata.json")
    candidate_metadata = read_json(cuda / "metadata.json")
    _validate_completed_run(reference_metadata, "reference")
    _validate_completed_run(candidate_metadata, "candidate")
    artifact_identity = _validate_artifact_identity(reference_metadata, candidate_metadata)
    limits, thresholds_sha256 = _validate_thresholds(thresholds)
    candidate_precision = "double" if lane == "cuda-fp64" else "single"
    candidate_contract = _validate_cuda_artifact(
        candidate_metadata, len(candidate_layers), candidate_precision, "candidate"
    )
    if lane == "cuda-fp64":
        _validate_requested_execution(reference_metadata, "cpu", "double", "reference")
        reference_provenance = _provenance(reference_metadata, "reference")
        _validate_no_fallback(reference_provenance)
        if reference_provenance.get("execution_engine") != "cpu_reference_multilayer":
            raise ValueError("cpu_reference_execution_engine_mismatch")
        if reference_provenance.get("precision") != "double":
            raise ValueError("cpu_reference_precision_mismatch")
    else:
        reference_contract = _validate_cuda_artifact(
            reference_metadata, len(reference_layers), "double", "reference"
        )
        if reference_contract["device_identity"] != candidate_contract["device_identity"]:
            raise ValueError("cuda_reference_device_identity_mismatch")

    max_reference = max(max(abs(value) for value in reference_values), 1.0)
    max_abs = max(
        abs(actual - reference)
        for actual, reference in zip(candidate_values, reference_values)
    )
    if lane == "cuda-fp64":
        threshold = limits["cuda_fp64_vs_cpu"]
        allowed = float(threshold["atol"]) + float(threshold["rtol"]) * max_reference
        metric = {
            "max_abs_apm": max_abs,
            "allowed_apm": allowed,
            "threshold": threshold,
        }
        qualified = max_abs <= allowed
    else:
        threshold = limits["cuda_fp32_vs_cuda_fp64"]
        diffs = [
            actual - reference
            for actual, reference in zip(candidate_values, reference_values)
        ]
        weighted_rms = math.sqrt(sum(value * value for value in diffs) / len(diffs)) / max_reference
        component_linf = max_abs / max_reference
        metric = {
            "weighted_rms": weighted_rms,
            "max_component_normalized": component_linf,
            "threshold": threshold,
        }
        qualified = (
            weighted_rms <= float(threshold["weighted_rms_max"])
            and component_linf <= float(threshold["max_component_normalized"])
        )
    if not qualified:
        raise ValueError("cpu_cuda_parity_not_qualified")
    return {
        "schema_version": "fdm_multilayer_cuda_parity.v2",
        "qualification_scope": QUALIFICATION_SCOPE,
        "status": "verified",
        "qualification_claim": None,
        "verification_scope": "bounded_d07_demag_refresh_parity",
        "lane": lane,
        "overall_execution_shape": CUDA_EXECUTION_SHAPE,
        "overall_execution_residency": "device_resident",
        "artifact_identity": artifact_identity,
        "thresholds": {
            "schema_version": THRESHOLDS_SCHEMA,
            "sha256": thresholds_sha256,
        },
        "device_identity": candidate_contract["device_identity"],
        "transfer_telemetry": candidate_contract["transfer"],
        "d07_stage": candidate_contract["stage"],
        "parity": metric,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--thresholds", type=Path, required=True)
    parser.add_argument("--lane", choices=("cuda-fp64", "cuda-fp32"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = verify(args.reference, args.candidate, args.thresholds, args.lane)
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        report = {"status": "not_qualified", "lane": args.lane, "reason": str(error)}
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        return 3
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
