#!/usr/bin/env python3
"""Fail-closed CPU/CUDA parity and D-07 provenance verifier."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


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


def verify(cpu: Path, cuda: Path, thresholds: Path, lane: str) -> dict:
    cpu_values = field_values(cpu)
    cuda_values = field_values(cuda)
    if len(cpu_values) != len(cuda_values):
        raise ValueError("CPU/CUDA H_demag payload lengths differ")
    metadata = read_json(cuda / "metadata.json")
    provenance = metadata.get("execution_provenance")
    if not isinstance(provenance, dict):
        raise ValueError("CUDA execution provenance is missing")
    stage = provenance.get("fdm_multilayer_stage_telemetry")
    if not isinstance(stage, dict) or stage.get("status") != "recorded":
        raise ValueError("d07_telemetry_not_qualified")
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
        if stage.get(key) != value:
            raise ValueError(f"d07_telemetry_not_qualified:{key}")
    if provenance.get("execution_engine") != "cuda_assisted_multilayer":
        raise ValueError("unexpected overall CUDA execution engine")
    if provenance.get("fft_backend") != "cuFFT" or not provenance.get("device_name"):
        raise ValueError("CUDA device/cuFFT provenance is incomplete")

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
        "overall_execution_residency": "host_authoritative",
        "d07_stage": stage,
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
