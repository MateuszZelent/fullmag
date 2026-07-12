#!/usr/bin/env python3
"""Validate FEM-TD-OBS-003 realized Oersted-field artifacts."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import struct
from pathlib import Path
from typing import Iterable


CPU_TOLERANCE = 1.0e-12
GPU_TOLERANCE = 1.0e-10


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _result_from_log(path: Path) -> dict[str, object]:
    decoder = json.JSONDecoder()
    results: list[dict[str, object]] = []
    for index, character in enumerate(path.read_text(encoding="utf-8")):
        if character != "{":
            continue
        try:
            candidate, _ = decoder.raw_decode(path.read_text(encoding="utf-8")[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and "artifact_dir" in candidate and "total_steps" in candidate:
            results.append(candidate)
    if not results:
        raise ValueError(f"{path}: no CLI run summary")
    return results[-1]


def _artifact_dir(log: Path, result: dict[str, object]) -> Path:
    artifact_dir = Path(str(result["artifact_dir"]))
    return artifact_dir if artifact_dir.is_absolute() else Path.cwd() / artifact_dir


def _check_provenance(label: str, result: dict[str, object], artifact_dir: Path, device: str) -> None:
    if result.get("status") != "completed" or result.get("total_steps") != 8:
        raise ValueError(f"{label}: incomplete fixed-final-time run")
    if result.get("backend") != "fem" or result.get("mode") != "strict" or result.get("precision") != "double":
        raise ValueError(f"{label}: result is not strict double FEM")
    requested = result.get("requested_execution")
    if not isinstance(requested, dict) or requested.get("backend") != "fem" or requested.get("device") != device:
        raise ValueError(f"{label}: requested FEM {device} provenance is absent")
    metadata_path = artifact_dir / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    resolved = metadata.get("execution_provenance") if isinstance(metadata, dict) else None
    expected_engine = "fem_cpu_native" if device == "cpu" else "fem_native_gpu"
    if not isinstance(resolved, dict) or resolved.get("execution_engine") != expected_engine or resolved.get("lossy_fallback_used") is not False:
        raise ValueError(f"{label}: resolved native FEM {device} provenance is absent")


def _read_field(artifact_dir: Path, name: str) -> tuple[dict[str, str], list[float], dict[str, str]]:
    field_dir = artifact_dir / "fields" / f"{name}.zarr"
    attrs = json.loads((field_dir / ".zattrs").read_text(encoding="utf-8"))
    zarray = json.loads((field_dir / ".zarray").read_text(encoding="utf-8"))
    if attrs.get("observable") != name or attrs.get("unit") != "A/m":
        raise ValueError(f"{field_dir}: expected public {name} in A/m")
    with (field_dir / "samples.csv").open(newline="", encoding="utf-8") as handle:
        samples = list(csv.DictReader(handle))
    if len(samples) != 1:
        raise ValueError(f"{field_dir}: expected exactly one final accepted sample")
    sample = samples[0]
    if zarray.get("dtype") != "<f8" or not isinstance(zarray.get("shape"), list):
        raise ValueError(f"{field_dir}: expected uncompressed float64 Zarr field")
    shape = zarray["shape"]
    if len(shape) != 3 or shape[0] != 1:
        raise ValueError(f"{field_dir}: expected one vector sample")
    count = int(shape[1]) * int(shape[2])
    chunk = field_dir / sample["chunk_key"]
    payload = chunk.read_bytes()
    if len(payload) != count * 8:
        raise ValueError(f"{chunk}: payload size does not match Zarr shape")
    return sample, list(struct.unpack(f"<{count}d", payload)), {"field": name, "path": str(field_dir), "chunk": str(chunk), "sha256": _sha256(chunk)}


def _identity(label: str, left: dict[str, str], right: dict[str, str]) -> None:
    keys = ("sample", "step", "time", "solver_dt", "chunk_key", "dtype", "scalar_bytes", "cell_count")
    if any(left.get(key) != right.get(key) for key in keys):
        raise ValueError(f"{label}: H_oe and H_eff accepted sample identity differs")


def _check_close(label: str, actual: list[float], expected: list[float], tolerance: float) -> float:
    if len(actual) != len(expected):
        raise ValueError(f"{label}: field shape drift")
    error = max((abs(a - b) for a, b in zip(actual, expected, strict=True)), default=0.0)
    scale = max((abs(value) for value in (*actual, *expected)), default=0.0)
    if error > tolerance * max(1.0, scale):
        raise ValueError(f"{label}: max absolute residual {error:.17g} exceeds tolerance {tolerance:.1e}")
    return error


def _run(label: str, log: Path, device: str) -> tuple[dict[str, object], dict[str, str], list[float], list[float], list[dict[str, str]]]:
    result = _result_from_log(log)
    artifact_dir = _artifact_dir(log, result)
    _check_provenance(label, result, artifact_dir, device)
    oe_sample, h_oe, oe_ref = _read_field(artifact_dir, "H_oe")
    eff_sample, h_eff, eff_ref = _read_field(artifact_dir, "H_eff")
    _identity(label, oe_sample, eff_sample)
    final_time = float(result["final_time"])
    if not math.isclose(float(oe_sample["time"]), final_time, rel_tol=0.0, abs_tol=1.0e-24):
        raise ValueError(f"{label}: field sample is not at the accepted final time")
    return result, oe_sample, h_oe, h_eff, [{"log": str(log), "sha256": _sha256(log)}, oe_ref, eff_ref, {"metadata": str(artifact_dir / "metadata.json"), "sha256": _sha256(artifact_dir / "metadata.json")}]


def validate_runs(*, cpu_driven: Path, cpu_zero: Path, gpu_driven: Path, gpu_zero: Path) -> dict[str, object]:
    lanes: dict[str, object] = {}
    for device, driven_log, zero_log, tolerance in (
        ("cpu", cpu_driven, cpu_zero, CPU_TOLERANCE),
        ("gpu", gpu_driven, gpu_zero, GPU_TOLERANCE),
    ):
        driven = _run(f"{device}/driven", driven_log, device)
        zero = _run(f"{device}/zero", zero_log, device)
        _identity(f"{device}: driven/zero", driven[1], zero[1])
        residual = _check_close(
            f"{device}: H_eff(driven)-H_eff(zero) != H_oe(driven)",
            [a - b for a, b in zip(driven[3], zero[3], strict=True)],
            driven[2],
            tolerance,
        )
        zero_residual = _check_close(
            f"{device}: H_oe(zero) is non-zero", zero[2], [0.0] * len(zero[2]), tolerance
        )
        lanes[device] = {
            "tolerance": tolerance,
            "accepted_sample": {key: driven[1][key] for key in ("sample", "step", "time", "solver_dt", "chunk_key", "dtype", "scalar_bytes", "cell_count")},
            "max_decomposition_residual_A_per_m": residual,
            "max_zero_current_residual_A_per_m": zero_residual,
            "artifact_refs": [*driven[4], *zero[4]],
        }
    return {"status": "pass", "contract": "H_oe=H_eff(driven)-H_eff(zero)", "lanes": lanes}


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cpu-driven", type=Path, required=True)
    parser.add_argument("--cpu-zero", type=Path, required=True)
    parser.add_argument("--gpu-driven", type=Path, required=True)
    parser.add_argument("--gpu-zero", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        summary = validate_runs(
            cpu_driven=args.cpu_driven,
            cpu_zero=args.cpu_zero,
            gpu_driven=args.gpu_driven,
            gpu_zero=args.gpu_zero,
        )
    except (OSError, ValueError, json.JSONDecodeError, struct.error) as exc:
        print(f"FAIL: {exc}")
        return 1
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
