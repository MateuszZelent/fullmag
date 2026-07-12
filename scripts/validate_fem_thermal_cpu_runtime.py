#!/usr/bin/env python3
"""Validate the narrow managed FEM CPU Brown-field runtime fixture."""

from __future__ import annotations

import argparse
import csv
import json
import math
import struct
from pathlib import Path
from typing import Iterable


def result_from_log(path: Path) -> dict[str, object]:
    decoder = json.JSONDecoder()
    candidates: list[dict[str, object]] = []
    for index, character in enumerate(path.read_text(encoding="utf-8")):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(path.read_text(encoding="utf-8")[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and "artifact_dir" in value and "total_steps" in value:
            candidates.append(value)
    if not candidates:
        raise ValueError(f"{path} does not contain a CLI run summary")
    return candidates[-1]


def _mapping(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} is missing")
    return value


def _nonzero_field(field: object) -> bool:
    values = _mapping(field, "H_therm artifact").get("values")
    if not isinstance(values, list) or not values:
        return False
    for vector in values:
        if isinstance(vector, list) and any(
            isinstance(component, (int, float)) and math.isfinite(float(component)) and float(component) != 0.0
            for component in vector
        ):
            return True
    return False


def validate_result(
    result: dict[str, object], artifact: dict[str, object], *, expected_seed: int, expected_steps: int
) -> None:
    if result.get("status") != "completed" or result.get("total_steps") != expected_steps:
        raise ValueError("FEM CPU thermal fixture did not complete its fixed step count")
    if result.get("backend") != "fem" or result.get("mode") != "strict" or result.get("precision") != "double":
        raise ValueError("runtime result is not strict double FEM")
    requested = _mapping(result.get("requested_execution"), "requested execution provenance")
    if requested.get("backend") != "fem" or requested.get("device") != "cpu":
        raise ValueError("requested execution is not FEM CPU")
    metadata = _mapping(artifact.get("metadata"), "artifact metadata")
    artifact_requested = _mapping(metadata.get("requested_execution"), "artifact requested execution provenance")
    if artifact_requested != requested:
        raise ValueError("artifact requested execution disagrees with run summary")
    provenance = _mapping(metadata.get("execution_provenance"), "resolved execution provenance")
    if provenance.get("execution_engine") != "fem_cpu_native" or provenance.get("lossy_fallback_used") is not False:
        raise ValueError("resolved execution is not native FEM CPU without fallback")
    plan = _mapping(_mapping(metadata.get("execution_plan"), "execution plan").get("backend_plan"), "FEM plan")
    if not isinstance(plan.get("temperature"), (int, float)) or float(plan["temperature"]) <= 0.0:
        raise ValueError("FEM plan has no active thermal temperature")
    seed_config = _mapping(plan.get("thermal_seed_config"), "thermal seed provenance")
    if seed_config.get("policy") != "fixed" or seed_config.get("seed") != expected_seed:
        raise ValueError("FEM plan thermal seed provenance differs from fixture")
    if "thermal_seed" in provenance and provenance["thermal_seed"] != expected_seed:
        raise ValueError("resolved thermal seed differs from fixture")
    claims = json.dumps({"metadata": metadata, "result": result}).casefold()
    if "statistically_validated" in claims or "fem_native_gpu" in claims or '"device": "gpu"' in claims:
        raise ValueError("fixture must not claim statistically_validated or GPU thermal status")
    if not _nonzero_field(artifact.get("h_therm")):
        raise ValueError("H_therm sampling evidence is absent or zero")


def _load_artifact(result: dict[str, object]) -> dict[str, object]:
    directory = Path(str(result["artifact_dir"]))
    metadata = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
    for name in ("H_therm_final.json", "H_therm.json", "h_therm_final.json", "h_therm.json"):
        candidate = directory / name
        if candidate.is_file():
            return {"metadata": metadata, "h_therm": json.loads(candidate.read_text(encoding="utf-8"))}
    zarr_dir = directory / "fields" / "H_therm.zarr"
    samples_path = zarr_dir / "samples.csv"
    if samples_path.is_file():
        attributes = _mapping(json.loads((zarr_dir / ".zattrs").read_text(encoding="utf-8")), "H_therm Zarr attributes")
        descriptor = _mapping(json.loads((zarr_dir / ".zarray").read_text(encoding="utf-8")), "H_therm Zarr descriptor")
        if attributes.get("observable") != "H_therm" or attributes.get("storage_layout") != "soa_component_major":
            raise ValueError("H_therm Zarr metadata is not the canonical vector-field layout")
        if attributes.get("component_order") != ["x", "y", "z"] or descriptor.get("dtype") != "<f8":
            raise ValueError("H_therm Zarr component order or dtype is invalid")
        samples = list(csv.DictReader(samples_path.read_text(encoding="utf-8").splitlines()))
        if not samples:
            raise ValueError(f"{zarr_dir} has no H_therm samples")
        latest = samples[-1]
        cell_count = int(latest["cell_count"])
        if cell_count <= 0 or int(latest["scalar_bytes"]) != 8:
            raise ValueError("H_therm Zarr sample has invalid vector dimensions")
        chunk_path = zarr_dir / latest["chunk_key"]
        raw = chunk_path.read_bytes()
        if len(raw) != 3 * cell_count * 8:
            raise ValueError("H_therm Zarr chunk byte length does not match three-component field shape")
        values = list(struct.unpack(f"<{len(raw) // 8}d", raw))
        return {"metadata": metadata, "h_therm": {"values": [values]}}
    raise ValueError(f"{directory} has no H_therm artifact")


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("--steps", type=int, required=True)
    parser.add_argument("--seed", type=int, required=True)
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        result = result_from_log(args.log)
        validate_result(result, _load_artifact(result), expected_seed=args.seed, expected_steps=args.steps)
    except ValueError as exc:
        print(f"FAIL: {exc}")
        return 1
    print("PASS: managed FEM CPU thermal runtime fixture accepted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
