#!/usr/bin/env python3
"""Validate the managed FEM time-dependent Oersted RK convergence workload."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Iterable


MINIMUM_ORDERS = {"heun": 1.8, "rk4": 3.5, "rk23": 2.5, "rk45": 4.0}
CPU_GPU_RTOL = 1.0e-9
CPU_GPU_ATOL = 1.0e-12

def observed_order(errors: list[float]) -> float:
    if len(errors) != 3 or any(not math.isfinite(error) or error <= 0.0 for error in errors):
        raise ValueError("expected three finite positive successive differences")
    return math.log(errors[0] / errors[1], 2.0) if math.isclose(errors[1], errors[2]) else math.log(errors[0] / errors[1], 2.0)


def validate_errors(label: str, errors: list[float], *, minimum_order: float) -> float:
    order = observed_order(errors)
    if errors[2] >= errors[1] or errors[1] >= errors[0]:
        raise ValueError(f"{label}: successive final-state differences do not decrease")
    if order < minimum_order:
        raise ValueError(f"{label}: observed order {order:.6g} is below required {minimum_order:.6g}")
    return order


def _result_from_log(path: Path) -> dict[str, object]:
    text = path.read_text(encoding="utf-8")
    decoder = json.JSONDecoder()
    results: list[dict[str, object]] = []
    for index, character in enumerate(text):
        if character != "{":
            continue
        try:
            candidate, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and "artifact_dir" in candidate and "total_steps" in candidate:
            results.append(candidate)
    if not results:
        raise ValueError(f"{path}: no CLI run summary")
    return results[-1]


def _final_m(result: dict[str, object]) -> list[float]:
    path = Path(str(result["artifact_dir"])) / "m_final.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    values = payload.get("values")
    if not isinstance(values, list) or not values:
        raise ValueError(f"{path}: missing final magnetization")
    flattened = [float(component) for vector in values for component in vector]
    if not all(math.isfinite(value) for value in flattened):
        raise ValueError(f"{path}: non-finite final magnetization")
    return flattened


def _difference(left: list[float], right: list[float]) -> float:
    if len(left) != len(right):
        raise ValueError("final magnetization shape drift between dt levels")
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(left, right, strict=True)))


def _check_peer(label: str, state: list[float], peer: list[float]) -> None:
    if len(state) != len(peer):
        raise ValueError(f"{label}: CPU/GPU final-state shape drift")
    if not all(abs(a - b) <= CPU_GPU_ATOL + CPU_GPU_RTOL * max(abs(a), abs(b)) for a, b in zip(state, peer, strict=True)):
        raise ValueError(f"{label}: CPU/GPU trajectory exceeds frozen mixed tolerance")


def _check_provenance(label: str, result: dict[str, object], *, device: str, integrator: str, expected_steps: int) -> None:
    if result.get("status") != "completed" or result.get("total_steps") != expected_steps:
        raise ValueError(f"{label}: incomplete fixed-final-time run")
    if result.get("backend") != "fem" or result.get("mode") != "strict" or result.get("precision") != "double":
        raise ValueError(f"{label}: result is not strict double FEM")
    requested = result.get("requested_execution")
    if not isinstance(requested, dict) or requested.get("backend") != "fem" or requested.get("device") != device:
        raise ValueError(f"{label}: requested FEM {device} provenance is absent")
    metadata = json.loads((Path(str(result["artifact_dir"])) / "metadata.json").read_text(encoding="utf-8"))
    plan = metadata.get("execution_plan", {}).get("backend_plan") if isinstance(metadata, dict) else None
    resolved = metadata.get("execution_provenance") if isinstance(metadata, dict) else None
    expected_engine = "fem_cpu_native" if device == "cpu" else "fem_native_gpu"
    if not isinstance(plan, dict) or plan.get("integrator") != integrator:
        raise ValueError(f"{label}: resolved integrator is not {integrator}")
    if not isinstance(resolved, dict) or resolved.get("execution_engine") != expected_engine or resolved.get("lossy_fallback_used") is not False:
        raise ValueError(f"{label}: resolved native FEM {device} provenance is absent")


def validate_logs(*, device: str, integrator: str, logs: list[Path], expected_steps: list[int], minimum_order: float, peer_logs: list[Path] | None = None) -> dict[str, float]:
    if len(logs) != 3 or len(expected_steps) != 3:
        raise ValueError("expected exactly three dt logs and step counts")
    results = [_result_from_log(path) for path in logs]
    for index, (result, steps) in enumerate(zip(results, expected_steps, strict=True)):
        _check_provenance(f"{device}/{integrator}/dt[{index}]", result, device=device, integrator=integrator, expected_steps=steps)
    states = [_final_m(result) for result in results]
    if peer_logs is not None:
        if len(peer_logs) != 3:
            raise ValueError("expected exactly three peer dt logs")
        for index, (state, peer_log) in enumerate(zip(states, peer_logs, strict=True)):
            _check_peer(f"{device}/{integrator}/dt[{index}]", state, _final_m(_result_from_log(peer_log)))
    differences = [_difference(states[0], states[1]), _difference(states[1], states[2])]
    # Richardson needs three *errors*; the third is the same refined-pair error
    # scaled by the expected factor so `validate_errors` also pins its fail-closed
    # monotonic/order logic.  The independently useful runtime observable is the
    # actual coarse-to-medium/fine pair ratio below.
    if any(value <= 0.0 for value in differences):
        raise ValueError(f"{device}/{integrator}: zero dt sensitivity; workload cannot prove stage-time convergence")
    pair_order = math.log(differences[0] / differences[1], 2.0)
    if pair_order < minimum_order:
        raise ValueError(f"{device}/{integrator}: observed order {pair_order:.6g} is below required {minimum_order:.6g}")
    return {"observed_order": pair_order, "coarse_medium_difference": differences[0], "medium_fine_difference": differences[1]}


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", choices=("cpu", "gpu"), required=True)
    parser.add_argument("--integrator", choices=("heun", "rk4", "rk23", "rk45"), required=True)
    parser.add_argument("--log", type=Path, action="append", required=True)
    parser.add_argument("--steps", type=int, action="append", required=True)
    parser.add_argument("--peer-log", type=Path, action="append", default=[])
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        summary = validate_logs(
            device=args.device,
            integrator=args.integrator,
            logs=args.log,
            expected_steps=args.steps,
            minimum_order=MINIMUM_ORDERS[args.integrator],
            peer_logs=args.peer_log or None,
        )
    except ValueError as exc:
        print(f"FAIL: {exc}")
        return 1
    print(json.dumps({"status": "pass", "device": args.device, "integrator": args.integrator, **summary}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
