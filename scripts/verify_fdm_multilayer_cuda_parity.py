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


class FieldArtifact:
    def __init__(
        self,
        *,
        values: tuple[float, ...],
        layer_cell_counts: tuple[int, ...],
        snapshot_count: int,
        payload_precision: str,
    ) -> None:
        self.values = values
        self.layer_cell_counts = layer_cell_counts
        self.snapshot_count = snapshot_count
        self.payload_precision = payload_precision

    @property
    def layer_count(self) -> int:
        return len(self.layer_cell_counts)


def _positive_int(value: object, reason: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(reason)
    return value


def _nonnegative_int(value: object, reason: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(reason)
    return value


def field_artifact(root: Path) -> FieldArtifact:
    manifest = read_json(root / "fields" / "H_demag" / "manifest.json")
    layers = manifest.get("layers")
    if not isinstance(layers, list) or not layers:
        raise ValueError("H_demag manifest layers are missing")
    layer_count = _positive_int(
        manifest.get("layer_count"),
        "H_demag manifest layer_count must be a positive integer",
    )
    if layer_count != len(layers):
        raise ValueError("H_demag manifest layer_count is inconsistent")

    values: list[float] = []
    layer_cell_counts: list[int] = []
    expected_snapshot_names: tuple[str, ...] | None = None
    payload_precision: str | None = None
    seen_directories: set[str] = set()
    for layer_index, layer in enumerate(layers):
        if not isinstance(layer, dict):
            raise ValueError(f"H_demag layer[{layer_index}] must be an object")
        layer_id = layer.get("id")
        directory = layer.get("directory")
        if not isinstance(layer_id, str) or not layer_id:
            raise ValueError(f"H_demag layer[{layer_index}] id is invalid")
        if (
            not isinstance(directory, str)
            or not directory
            or directory in seen_directories
        ):
            raise ValueError(f"H_demag layer[{layer_index}] directory is invalid")
        seen_directories.add(directory)
        cell_count = _positive_int(
            layer.get("value_count"),
            f"H_demag layer[{layer_index}] value_count must be a positive integer",
        )
        if layer.get("vector_shape") != [cell_count, 3]:
            raise ValueError(f"H_demag layer[{layer_index}] vector_shape is inconsistent")
        layer_cell_counts.append(cell_count)

        paths = sorted((root / "fields" / "H_demag" / directory).glob("step_*.json"))
        if not paths:
            raise ValueError(f"missing H_demag snapshots for {layer_id}")
        snapshot_names = tuple(path.name for path in paths)
        if expected_snapshot_names is None:
            expected_snapshot_names = snapshot_names
        elif snapshot_names != expected_snapshot_names:
            raise ValueError("H_demag layers do not carry the same snapshot set")

        for path in paths:
            payload = read_json(path)
            if (
                payload.get("unit") != "A/m"
                or payload.get("component_count") != 3
                or payload.get("component_order") != "xyz"
            ):
                raise ValueError(f"invalid H_demag contract for {layer_id}")
            provenance = payload.get("provenance")
            precision = provenance.get("precision") if isinstance(provenance, dict) else None
            if precision not in {"single", "double"}:
                raise ValueError(f"invalid H_demag payload precision for {layer_id}")
            if payload_precision is None:
                payload_precision = precision
            elif precision != payload_precision:
                raise ValueError("H_demag payload precision is inconsistent across snapshots")
            raw_values = payload.get("values")
            if not isinstance(raw_values, list) or len(raw_values) != cell_count:
                raise ValueError(f"H_demag payload shape is inconsistent for {layer_id}")
            for vector in raw_values:
                if not isinstance(vector, list) or len(vector) != 3:
                    raise ValueError(f"H_demag payload vector shape is invalid for {layer_id}")
                for component in vector:
                    if isinstance(component, bool) or not isinstance(component, (int, float)):
                        raise ValueError(f"H_demag payload component is invalid for {layer_id}")

        latest = read_json(paths[-1]).get("values")
        assert isinstance(latest, list)
        values.extend(float(component) for vector in latest for component in vector)
    if not values or not all(math.isfinite(value) for value in values):
        raise ValueError("H_demag payload is empty or non-finite")
    assert expected_snapshot_names is not None
    assert payload_precision is not None
    return FieldArtifact(
        values=tuple(values),
        layer_cell_counts=tuple(layer_cell_counts),
        snapshot_count=len(expected_snapshot_names),
        payload_precision=payload_precision,
    )


def validate_d07_stage(provenance: dict, reason_prefix: str, layer_count: int) -> dict:
    stage = provenance.get("fdm_multilayer_stage_telemetry")
    if not isinstance(stage, dict) or stage.get("status") != "recorded":
        code = "d07_telemetry_not_qualified"
        raise ValueError(f"{reason_prefix}_{code}" if reason_prefix else code)
    expected = {
        "execution_engine": "cuda_native_multilayer_demag_v2",
        "data_residency": "device_resident_per_refresh",
        "fft_backend": "cuFFT",
        "layer_count": layer_count,
        "refresh_count": 1,
        "forward_fft_count": layer_count,
        "inverse_fft_count": layer_count,
        "pair_accumulation_count": layer_count * layer_count,
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


def validate_transfer_telemetry(
    provenance: dict,
    artifact: FieldArtifact,
) -> dict:
    telemetry = provenance.get("fdm_multilayer_transfer_telemetry")
    code = "cuda_transfer_telemetry_not_qualified"
    if not isinstance(telemetry, dict):
        raise ValueError(code)
    precision = provenance.get("precision")
    expected_scalar_bytes = {"single": 4, "double": 8}.get(precision)
    if expected_scalar_bytes is None or artifact.payload_precision != precision:
        raise ValueError(f"{code}:payload_precision")
    vector_bytes = 3 * expected_scalar_bytes * sum(artifact.layer_cell_counts)
    observed_snapshot_count = artifact.snapshot_count * 6 * artifact.layer_count
    observed_snapshot_bytes = artifact.snapshot_count * 6 * vector_bytes
    expected = {
        "execution_shape": "cuda_native_multilayer_convolution",
        "data_residency": "device_resident_with_observed_host_snapshots",
        "layer_count": artifact.layer_count,
        "host_snapshot_count": artifact.snapshot_count,
        "payload_precision": precision,
        "scalar_bytes": expected_scalar_bytes,
        "setup_h2d_transfer_count": artifact.layer_count,
        "setup_h2d_bytes": vector_bytes,
        "observed_snapshot_d2h_transfer_count": observed_snapshot_count,
        "observed_snapshot_d2h_bytes": observed_snapshot_bytes,
        "warm_step_h2d_transfer_count": 0,
        "warm_step_h2d_bytes": 0,
        "warm_step_d2h_transfer_count": 0,
        "warm_step_d2h_bytes": 0,
        "h2d_transfer_count": artifact.layer_count,
        "d2h_transfer_count": observed_snapshot_count,
        "h2d_bytes": vector_bytes,
        "d2h_bytes": observed_snapshot_bytes,
    }
    for key, value in expected.items():
        actual = telemetry.get(key)
        if (
            isinstance(value, int)
            and (isinstance(actual, bool) or not isinstance(actual, int))
        ) or actual != value:
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
        else "cuda_native_multilayer_convolution"
    )
    if reference_provenance.get("execution_engine") != expected_reference_engine:
        raise ValueError("reference_execution_engine_not_qualified")
    reference_field = field_artifact(cpu)
    candidate_field = field_artifact(cuda)
    if reference_field.layer_cell_counts != candidate_field.layer_cell_counts:
        raise ValueError("CPU/CUDA H_demag layer geometry differs")
    if reference_field.snapshot_count != candidate_field.snapshot_count:
        raise ValueError("CPU/CUDA H_demag snapshot counts differ")
    if reference_field.payload_precision != reference_provenance.get("precision"):
        raise ValueError("reference_H_demag_payload_precision_mismatch")
    if candidate_field.payload_precision != candidate_provenance.get("precision"):
        raise ValueError("candidate_H_demag_payload_precision_mismatch")
    if lane == "cuda-fp32":
        validate_d07_stage(
            reference_provenance,
            "reference",
            reference_field.layer_count,
        )
        validate_transfer_telemetry(reference_provenance, reference_field)
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

    cpu_values = reference_field.values
    cuda_values = candidate_field.values
    if len(cpu_values) != len(cuda_values):
        raise ValueError("CPU/CUDA H_demag payload lengths differ")
    provenance = candidate_provenance
    stage = validate_d07_stage(provenance, "", candidate_field.layer_count)
    execution_engine = provenance.get("execution_engine")
    if execution_engine == "cuda_assisted_multilayer":
        raise ValueError("cuda_assisted_multilayer_not_qualified")
    if execution_engine != "cuda_native_multilayer_convolution":
        raise ValueError("cuda_native_multilayer_convolution_not_proven")
    if provenance.get("lossy_fallback_used") is not False:
        raise ValueError("cuda_fallback_not_proven_absent")
    if provenance.get("resolved_fallback") is not None:
        raise ValueError("cuda_fallback_not_proven_absent")
    if provenance.get("fft_backend") != "cuFFT" or not provenance.get("device_name"):
        raise ValueError("CUDA device/cuFFT provenance is incomplete")
    transfer_telemetry = validate_transfer_telemetry(provenance, candidate_field)

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
        "overall_execution_residency": "device_resident_with_observed_host_snapshots",
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
