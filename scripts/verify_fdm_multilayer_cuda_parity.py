#!/usr/bin/env python3
"""Fail-closed CPU/CUDA parity and D-07 provenance verifier."""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
from pathlib import Path


PRECISION_CONTRACT_PATH = (
    Path(__file__).resolve().parent / "fdm_multilayer_cuda_precision_contract.py"
)


def load_precision_contract_validator():
    spec = importlib.util.spec_from_file_location(
        "fdm_multilayer_cuda_precision_contract",
        PRECISION_CONTRACT_PATH,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("precision_contract_helper_unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.validate_precision_contract


def load_cuda_identity_validator():
    spec = importlib.util.spec_from_file_location(
        "fdm_multilayer_cuda_precision_contract",
        PRECISION_CONTRACT_PATH,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("precision_contract_helper_unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.validate_cuda_identity


def read_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object: {path}")
    return value


def field_values(root: Path) -> list[float]:
    manifest = read_json(root / "fields" / "H_demag" / "manifest.json")
    values: list[float] = []
    for layer in manifest["layers"]:
        paths = sorted((root / "fields" / "H_demag" / layer["directory"]).glob("step_*.json"))
        if not paths:
            raise ValueError(f"missing H_demag snapshots for {layer['id']}")
        payload = read_json(paths[-1])
        if payload.get("unit") != "A/m" or payload.get("component_order") != "xyz":
            raise ValueError(f"invalid H_demag contract for {layer['id']}")
        values.extend(float(component) for vector in payload["values"] for component in vector)
    if not values or not all(math.isfinite(value) for value in values):
        raise ValueError("H_demag payload is empty or non-finite")
    return values


def validate_d07_stage(provenance: dict, reason_prefix: str) -> dict:
    stage = provenance.get("fdm_multilayer_stage_telemetry")
    if not isinstance(stage, dict) or stage.get("status") != "recorded":
        code = "d07_telemetry_not_qualified"
        raise ValueError(f"{reason_prefix}_{code}" if reason_prefix else code)
    expected = {
        "execution_engine": "cuda_native_multilayer_demag_v2",
        "data_residency": "device_resident_per_refresh",
        "fft_backend": "cuFFT",
        "layer_count": 3,
        "refresh_count": 1,
        "forward_fft_count": 3,
        "inverse_fft_count": 3,
        "pair_accumulation_count": 9,
    }
    for key, value in expected.items():
        actual = stage.get(key)
        if (
            isinstance(value, int)
            and (isinstance(actual, bool) or not isinstance(actual, int))
        ) or actual != value:
            code = f"d07_telemetry_not_qualified:{key}"
            raise ValueError(f"{reason_prefix}_{code}" if reason_prefix else code)
    return stage


def validate_transfer_telemetry(provenance: dict) -> dict:
    telemetry = provenance.get("fdm_multilayer_transfer_telemetry")
    code = "cuda_transfer_telemetry_not_qualified"
    if not isinstance(telemetry, dict):
        raise ValueError(code)
    expected = {
        "execution_shape": "cuda_native_multilayer_demag_v2",
        "data_residency": "device_resident_per_refresh",
    }
    for key, value in expected.items():
        if telemetry.get(key) != value:
            raise ValueError(f"{code}:{key}")
    for key in (
        "h2d_transfer_count",
        "d2h_transfer_count",
        "h2d_bytes",
        "d2h_bytes",
    ):
        value = telemetry.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value != 0:
            raise ValueError(f"{code}:{key}")
    return telemetry


def verify(cpu: Path, cuda: Path, thresholds: Path, lane: str) -> dict:
    reference_metadata = read_json(cpu / "metadata.json")
    candidate_metadata = read_json(cuda / "metadata.json")
    reference_provenance = reference_metadata.get("execution_provenance")
    candidate_provenance = candidate_metadata.get("execution_provenance")
    if not isinstance(reference_provenance, dict):
        raise ValueError("reference execution provenance is missing")
    if not isinstance(candidate_provenance, dict):
        raise ValueError("candidate execution provenance is missing")
    if reference_provenance.get("lossy_fallback_used") is not False:
        raise ValueError("reference_fallback_not_proven_absent")
    if reference_provenance.get("resolved_fallback") is not None:
        raise ValueError("reference_fallback_not_proven_absent")
    expected_reference_engine = (
        "cpu_reference_multilayer"
        if lane == "cuda-fp64"
        else "cuda_native_multilayer_demag_v2"
    )
    if reference_provenance.get("execution_engine") != expected_reference_engine:
        raise ValueError("reference_execution_engine_not_qualified")
    if lane == "cuda-fp32":
        validate_d07_stage(reference_provenance, "reference")
        if reference_provenance.get("fft_backend") != "cuFFT":
            raise ValueError("reference_cuda_provenance_not_qualified")
        try:
            load_cuda_identity_validator()(reference_provenance)
        except ValueError as error:
            raise ValueError(f"reference_cuda_provenance_not_qualified:{error}") from error
    precision_contract = load_precision_contract_validator()(
        reference_provenance,
        candidate_provenance,
        lane,
    )

    cpu_values = field_values(cpu)
    cuda_values = field_values(cuda)
    if len(cpu_values) != len(cuda_values):
        raise ValueError("CPU/CUDA H_demag payload lengths differ")
    provenance = candidate_provenance
    stage = validate_d07_stage(provenance, "")
    execution_engine = provenance.get("execution_engine")
    if execution_engine == "cuda_assisted_multilayer":
        raise ValueError("cuda_assisted_multilayer_not_qualified")
    if execution_engine != "cuda_native_multilayer_demag_v2":
        raise ValueError("cuda_native_multilayer_demag_v2_not_proven")
    if provenance.get("lossy_fallback_used") is not False:
        raise ValueError("cuda_fallback_not_proven_absent")
    if provenance.get("resolved_fallback") is not None:
        raise ValueError("cuda_fallback_not_proven_absent")
    if provenance.get("fft_backend") != "cuFFT" or not provenance.get("device_name"):
        raise ValueError("CUDA device/cuFFT provenance is incomplete")
    transfer_telemetry = validate_transfer_telemetry(provenance)

    limits = read_json(thresholds)
    max_reference = max(max(abs(value) for value in cpu_values), 1.0)
    max_abs = max(abs(actual - reference) for actual, reference in zip(cuda_values, cpu_values))
    if lane == "cuda-fp64":
        threshold = limits["cuda_fp64_vs_cpu"]
        allowed = float(threshold["atol"]) + float(threshold["rtol"]) * max_reference
        metric = {"max_abs_apm": max_abs, "allowed_apm": allowed}
        qualified = max_abs <= allowed
    else:
        threshold = limits["cuda_fp32_vs_cuda_fp64"]
        diffs = [actual - reference for actual, reference in zip(cuda_values, cpu_values)]
        weighted_rms = math.sqrt(sum(value * value for value in diffs) / len(diffs)) / max_reference
        component_linf = max_abs / max_reference
        metric = {
            "weighted_rms": weighted_rms,
            "max_component_normalized": component_linf,
        }
        qualified = (
            weighted_rms <= float(threshold["weighted_rms_max"])
            and component_linf <= float(threshold["max_component_normalized"])
        )
    if not qualified:
        raise ValueError("cpu_cuda_parity_not_qualified")
    return {
        "schema_version": "fdm_multilayer_cuda_parity.v1",
        "status": "qualified",
        "lane": lane,
        "overall_execution_residency": "device_resident_per_refresh",
        "precision_contract": precision_contract,
        "d07_stage": stage,
        "transfer_telemetry": transfer_telemetry,
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
