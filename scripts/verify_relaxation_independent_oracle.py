#!/usr/bin/env python3
"""Run the small independent oracle used by relaxation qualification.

The production lane deliberately invokes this file in a separate Python
process.  It does not reimplement the solver; it checks analytic macrospin
alignment, unit-length final spins, scalar/state consistency, and the stated
energy monotonicity condition against hashed runtime artifacts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Mapping, Sequence


SCHEMA = "fullmag.relaxation.oracle_artifact.v1"
INPUT_SCHEMA = "fullmag.relaxation.oracle_input.v1"
IMPLEMENTATION = "scripts/verify_relaxation_independent_oracle.py"


class OracleError(RuntimeError):
    """The independent oracle could not prove a measurement."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise OracleError(message)


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def load_json(path: Path, label: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise OracleError(f"{label} is not valid JSON: {error}") from error
    require(isinstance(value, Mapping), f"{label} must be an object")
    return value


def safe_artifact(root: Path, raw: object, label: str) -> Path:
    require(isinstance(raw, str) and raw, f"{label} is missing")
    relative = Path(raw)
    require(not relative.is_absolute() and ".." not in relative.parts, f"{label} escaped artifact root")
    path = (root / relative).resolve()
    require(path.is_relative_to(root.resolve()), f"{label} escaped artifact root")
    require(path.is_file(), f"{label} does not exist: {raw}")
    return path


def finite(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def finite_mapping(value: object) -> bool:
    return isinstance(value, Mapping) and bool(value) and all(
        isinstance(item, (int, float))
        and not isinstance(item, bool)
        and math.isfinite(float(item))
        for item in value.values()
    )


def state_vectors(path: Path) -> list[list[float]]:
    document = load_json(path, "final state")
    values = document.get("values")
    require(isinstance(values, list) and values, "final state values are missing")
    vectors: list[list[float]] = []
    for index, value in enumerate(values):
        require(
            isinstance(value, list)
            and len(value) == 3
            and all(finite(component) for component in value),
            f"final state vector {index} is invalid",
        )
        vector = [float(component) for component in value]
        norm = math.sqrt(sum(component * component for component in vector))
        require(abs(norm - 1.0) <= 5e-3, f"final state vector {index} is not unit length")
        vectors.append(vector)
    return vectors


def mean_vector(vectors: Sequence[Sequence[float]]) -> dict[str, float]:
    count = float(len(vectors))
    return {
        "mx": sum(vector[0] for vector in vectors) / count,
        "my": sum(vector[1] for vector in vectors) / count,
        "mz": sum(vector[2] for vector in vectors) / count,
    }


def run(input_path: Path, output_path: Path, artifact_root: Path) -> None:
    input_document = load_json(input_path, "oracle input")
    require(input_document.get("schema_version") == INPUT_SCHEMA, "oracle input schema is invalid")
    algorithm = input_document.get("algorithm")
    lane = input_document.get("lane")
    precision = input_document.get("precision")
    workload = input_document.get("workload")
    oracle_identity = input_document.get("oracle")
    require(all(isinstance(value, str) and value for value in (algorithm, lane, precision, workload)), "oracle input identity is incomplete")
    require(
        isinstance(oracle_identity, Mapping)
        and isinstance(oracle_identity.get("kind"), str)
        and isinstance(oracle_identity.get("id"), str),
        "oracle input oracle identity is incomplete",
    )
    measurements = input_document.get("measurements")
    require(isinstance(measurements, list) and len(measurements) >= 6, "oracle input measurements are incomplete")

    comparisons: list[dict[str, Any]] = []
    for index, item in enumerate(measurements):
        require(isinstance(item, Mapping), f"measurement {index} is invalid")
        input_contract_path = safe_artifact(artifact_root, item.get("input_contract_path"), f"measurement {index} input contract")
        final_state_path = safe_artifact(artifact_root, item.get("final_state_path"), f"measurement {index} final state")
        input_contract_hash = item.get("input_contract_sha256")
        final_state_hash = item.get("final_state_sha256")
        require(isinstance(input_contract_hash, str) and len(input_contract_hash) == 64, f"measurement {index} input hash is invalid")
        require(isinstance(final_state_hash, str) and len(final_state_hash) == 64, f"measurement {index} state hash is invalid")
        require(sha256_file(input_contract_path) == input_contract_hash, f"measurement {index} input hash mismatch")
        require(sha256_file(final_state_path) == final_state_hash, f"measurement {index} state hash mismatch")
        contract = load_json(input_contract_path, f"measurement {index} input contract")
        contract_workload = contract.get("workload_id")
        require(
            isinstance(contract_workload, str) and contract_workload.endswith(f".{workload}"),
            f"measurement {index} workload binding is invalid",
        )

        result = item.get("result")
        require(isinstance(result, Mapping), f"measurement {index} result is missing")
        metrics = result.get("metrics")
        require(finite_mapping(metrics), f"measurement {index} metrics are invalid")
        assert isinstance(metrics, Mapping)
        vectors = state_vectors(final_state_path)
        observed_state = mean_vector(vectors)
        state_tolerance = 1e-4 if precision == "fp32" else 1e-8
        for component in ("mx", "my", "mz"):
            require(component in metrics and finite(metrics[component]), f"measurement {index} scalar {component} is missing")
            require(
                abs(float(metrics[component]) - observed_state[component]) <= state_tolerance,
                f"measurement {index} scalar/state mismatch for {component}",
            )

        if workload == "macrospin":
            reference = {"mz": 1.0}
            observed = {"mz": observed_state["mz"]}
            absolute_error = {"mz": abs(observed["mz"] - reference["mz"])}
            tolerance = {"mz": 1e-2}
            require(absolute_error["mz"] <= tolerance["mz"], f"measurement {index} macrospin alignment failed")
        elif workload == "exchange_demag":
            initial = item.get("initial_energy_j")
            final = metrics.get("energy_j")
            require(finite(initial) and finite(final), f"measurement {index} exchange-demag energies are invalid")
            tolerance_value = max(1e-30, abs(float(initial)) * 1e-10)
            increase = max(0.0, float(final) - float(initial))
            reference = {"initial_energy_j": float(initial)}
            observed = {"final_energy_j": float(final)}
            absolute_error = {"energy_increase_j": increase}
            tolerance = {"energy_increase_j": tolerance_value}
            require(increase <= tolerance_value, f"measurement {index} exchange-demag energy increased")
        else:
            raise OracleError(f"unsupported workload: {workload}")

        comparisons.append(
            {
                "input_contract_path": item["input_contract_path"],
                "input_contract_sha256": input_contract_hash,
                "final_state_path": item["final_state_path"],
                "final_state_sha256": final_state_hash,
                "reference": reference,
                "observed": observed,
                "state_observed": observed_state,
                "absolute_error": absolute_error,
                "tolerance": tolerance,
                "status": "passed",
            }
        )

    payload = {
        "schema_version": SCHEMA,
        "oracle": dict(oracle_identity),
        "status": "passed",
        "cell": {"algorithm": algorithm, "lane": lane, "precision": precision},
        "workload": workload,
        "measurement_count": len(comparisons),
        "independence": {
            "kind": "standalone_python_oracle",
            "implementation": IMPLEMENTATION,
            "implementation_sha256": sha256_file(Path(__file__).resolve()),
        },
        "input_path": str(input_path.resolve().relative_to(artifact_root.resolve()).as_posix()),
        "input_sha256": sha256_file(input_path),
        "comparisons": comparisons,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(canonical_bytes(payload) + b"\n")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--artifact-root", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        run(args.input.resolve(), args.output.resolve(), args.artifact_root.resolve())
    except (OSError, OracleError, ValueError) as error:
        print(f"RELAXATION_ORACLE_BLOCKED: {error}")
        return 3
    print(f"RELAXATION_ORACLE_PASSED output={args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
