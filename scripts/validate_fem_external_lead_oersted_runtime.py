#!/usr/bin/env python3
"""Validate the bounded public FEM external-lead Oersted runtime artifacts."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


EXPECTED_FINAL_TIME_S = 3.0e-13
CALLBACK_PATH = Path("transport/fem_stage_oersted_callback.v1.json")


def _runtime_result(path: Path) -> dict[str, object]:
    text = path.read_text(encoding="utf-8")
    decoder = json.JSONDecoder()
    candidates: list[dict[str, object]] = []
    for index, character in enumerate(text):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and "artifact_dir" in value and "status" in value:
            candidates.append(value)
    if not candidates:
        raise ValueError(f"{path} does not contain a CLI runtime summary")
    return candidates[-1]


def _object(path: Path) -> dict[str, object]:
    if not path.is_file():
        raise ValueError(f"required artifact is missing: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"artifact is not a JSON object: {path}")
    return value


def _finite_vectors(path: Path) -> list[list[float]]:
    payload = _object(path)
    values = payload.get("values")
    if not isinstance(values, list) or not values:
        raise ValueError(f"{path} has no magnetization values")
    result: list[list[float]] = []
    for index, vector in enumerate(values):
        if not isinstance(vector, list) or len(vector) != 3:
            raise ValueError(f"{path} magnetization[{index}] is not xyz")
        converted = [float(component) for component in vector]
        if not all(math.isfinite(component) for component in converted):
            raise ValueError(f"{path} magnetization[{index}] is non-finite")
        norm = math.sqrt(sum(component * component for component in converted))
        if abs(norm - 1.0) > 1.0e-8:
            raise ValueError(f"{path} magnetization[{index}] is not normalized")
        result.append(converted)
    return result


def _digest(value: object, field: str) -> str:
    if (
        not isinstance(value, str)
        or not value.startswith("sha256:")
        or len(value) != 71
        or any(character not in "0123456789abcdef" for character in value[7:])
    ):
        raise ValueError(f"callback {field} is not a canonical sha256 digest")
    return value


def _contains_stage_contract(value: object) -> bool:
    if isinstance(value, dict):
        if (
            value.get("stage_coupling") == "fem_stage_oersted_callback.v1"
            and isinstance(value.get("conservative_current_view"), dict)
            and value["conservative_current_view"].get("closure", {}).get("kind")
            == "external_lead"
        ):
            return True
        return any(_contains_stage_contract(child) for child in value.values())
    if isinstance(value, list):
        return any(_contains_stage_contract(child) for child in value)
    return False


def validate_runtime_log(path: Path) -> dict[str, object]:
    result = _runtime_result(path)
    if result.get("status") != "completed":
        raise ValueError(f"runtime status is {result.get('status')!r}, expected 'completed'")
    if result.get("backend") != "fem" or result.get("mode") != "strict":
        raise ValueError("runtime did not resolve strict FEM execution")
    if result.get("precision") != "double":
        raise ValueError("runtime did not resolve double precision")
    requested = result.get("requested_execution")
    expected_requested = {
        "backend": "fem",
        "device": "cpu",
        "precision": "double",
        "mode": "strict",
        "fallback_policy": "forbidden",
    }
    if not isinstance(requested, dict) or any(
        requested.get(key) != value for key, value in expected_requested.items()
    ):
        raise ValueError("CLI requested execution is not strict FEM CPU/double without fallback")
    steps = result.get("total_steps")
    if not isinstance(steps, int) or steps < 1:
        raise ValueError("runtime did not accept any LLG step")
    final_time = result.get("final_time")
    if not isinstance(final_time, (int, float)) or not math.isclose(
        float(final_time), EXPECTED_FINAL_TIME_S, rel_tol=1.0e-12, abs_tol=1.0e-24
    ):
        raise ValueError(f"runtime final time is {final_time!r}, expected {EXPECTED_FINAL_TIME_S}")

    artifact_value = result.get("artifact_dir")
    if not isinstance(artifact_value, str) or not artifact_value:
        raise ValueError("runtime summary has no artifact directory")
    artifact_dir = Path(artifact_value)
    metadata = _object(artifact_dir / "metadata.json")
    artifact_requested = metadata.get("requested_execution")
    if artifact_requested != requested:
        raise ValueError("artifact requested execution disagrees with CLI summary")
    provenance = metadata.get("execution_provenance")
    if not isinstance(provenance, dict):
        raise ValueError("metadata has no execution provenance")
    if provenance.get("execution_engine") != "fem_cpu_native":
        raise ValueError("runtime did not execute the native FEM CPU engine")
    if provenance.get("precision") != "double" or provenance.get("lossy_fallback_used") is not False:
        raise ValueError("runtime provenance reports wrong precision or lossy fallback")
    if not _contains_stage_contract(metadata.get("execution_plan")):
        raise ValueError("executed plan lacks the external-lead stage callback contract")

    callback_path = artifact_dir / CALLBACK_PATH
    if not callback_path.is_file():
        raise ValueError(f"callback artifact is missing: {callback_path}")
    callback = _object(callback_path)
    if callback.get("schema") != "fem_stage_oersted_callback.v1":
        raise ValueError("callback schema is not fem_stage_oersted_callback.v1")
    if callback.get("policy") != "fem_stage_oersted_callback.v1":
        raise ValueError("callback policy is not the external-lead Oersted stage policy")
    if callback.get("device_lane") != "cpu_native":
        raise ValueError("callback did not execute on the native CPU lane")
    begin = callback.get("begin_count")
    commit = callback.get("commit_count")
    rollback = callback.get("rollback_count")
    evaluate = callback.get("evaluate_count")
    if not all(isinstance(value, int) and value >= 0 for value in (begin, commit, rollback, evaluate)):
        raise ValueError("callback counters are invalid")
    if commit < 1:
        raise ValueError("no accepted callback commit was published")
    if begin != commit + rollback:
        raise ValueError("callback begin count does not equal commits plus rollbacks")
    if evaluate < 2 * commit:
        raise ValueError("callback was not evaluated at the expected multi-stage cadence")
    observation = callback.get("accepted_observation")
    if not isinstance(observation, dict):
        raise ValueError("callback has no accepted observation")
    if not isinstance(observation.get("source_state_revision"), int):
        raise ValueError("callback accepted observation has no source revision")
    if not math.isfinite(float(observation.get("evaluation_time_s", math.nan))):
        raise ValueError("callback accepted observation has invalid evaluation time")
    _digest(observation.get("source_view_identity_digest"), "source_view_identity_digest")
    _digest(observation.get("field_sha256"), "field_sha256")

    initial = _finite_vectors(artifact_dir / "m_initial.json")
    final = _finite_vectors(artifact_dir / "m_final.json")
    if len(initial) != len(final):
        raise ValueError("initial and final magnetization sizes differ")
    delta_l2 = math.sqrt(
        sum(
            (after - before) ** 2
            for initial_vector, final_vector in zip(initial, final, strict=True)
            for before, after in zip(initial_vector, final_vector, strict=True)
        )
    )
    if not math.isfinite(delta_l2) or delta_l2 <= 0.0:
        raise ValueError("accepted external-lead Oersted stage did not change magnetization")

    return {
        "schema": "fem_external_lead_oersted_public_runtime.v1",
        "artifact_dir": str(artifact_dir),
        "total_steps": steps,
        "final_time_s": float(final_time),
        "magnetization_delta_l2": delta_l2,
        "callback": callback,
    }


def main() -> None:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("runtime_log", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    summary = validate_runtime_log(args.runtime_log)
    encoded = json.dumps(summary, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")


if __name__ == "__main__":
    main()
