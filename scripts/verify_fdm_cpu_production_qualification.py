#!/usr/bin/env python3
"""Fail-closed hardware-relative gate for production FDM CPU evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

SUMMARY_SCHEMA = "fullmag.fdm.cpu.production_qualification.v1"
THRESHOLD_SCHEMA = "fullmag.fdm.cpu.production_thresholds.v1"
RECEIPT_SCHEMA = "fullmag.fdm.cpu.production_gate.v1"
FIXTURES = ("small", "medium", "large")
MODES = ("control", "requested", "full")
EVALUATIONS = {"control": (30, 0), "requested": (20, 10), "full": (0, 30)}


class ContractError(RuntimeError):
    pass


@dataclass(frozen=True)
class EvidenceGroup:
    label: str
    paths: tuple[Path, ...]
    documents: tuple[Mapping[str, Any], ...]
    commit: str
    snapshot: str
    hardware_fingerprint: str
    hardware: Mapping[str, Any]
    rustc: str
    target: str


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ContractError(message)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def canonical_sha256(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    return f"sha256:{sha256_bytes(encoded)}"


def is_lower_hex(value: Any, length: int) -> bool:
    return isinstance(value, str) and len(value) == length and all(
        character in "0123456789abcdef" for character in value
    )


def number(value: Any, label: str, *, positive: bool = False) -> float:
    require(isinstance(value, (int, float)) and not isinstance(value, bool), f"{label} must be numeric")
    result = float(value)
    require(math.isfinite(result), f"{label} must be finite")
    require(not positive or result > 0.0, f"{label} must be positive")
    return result


def integer(value: Any, label: str, *, minimum: int = 0) -> int:
    require(isinstance(value, int) and not isinstance(value, bool), f"{label} must be an integer")
    require(value >= minimum, f"{label} must be >= {minimum}")
    return value


def load_object(path: Path, label: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ContractError(f"cannot read {label} {path}: {error}") from error
    require(isinstance(value, dict), f"{label} {path} must be a JSON object")
    return value


def validate_thresholds(value: Mapping[str, Any]) -> None:
    require(value.get("schema_version") == THRESHOLD_SCHEMA, "threshold schema mismatch")
    require(value.get("policy_status") == "approved", "threshold policy is not approved")
    require(
        value.get("qualification_scope")
        == "fdm_cpu_reference_double_heun_full_fixture_v1",
        "threshold qualification scope mismatch",
    )
    integer(value.get("minimum_repetitions"), "minimum_repetitions", minimum=5)
    fields = {
        "timing": ("median_ratio_max", "p95_ratio_max"),
        "allocations": ("count_ratio_max", "bytes_ratio_max"),
        "peak_live_heap": ("median_ratio_max", "p95_ratio_max", "absolute_allowance_bytes"),
        "process_peak_resident": ("median_ratio_max", "p95_ratio_max", "absolute_allowance_bytes"),
        "time_to_accuracy": (
            "timestep_ratio_max",
            "median_wall_time_ratio_max",
            "p95_wall_time_ratio_max",
        ),
    }
    for section, names in fields.items():
        policy = value.get(section)
        require(isinstance(policy, dict), f"threshold section {section} is missing")
        for name in names:
            number(policy.get(name), f"{section}.{name}", positive=True)


def validate_exact_execution(provenance: Mapping[str, Any], label: str) -> None:
    resolution = provenance.get("execution_resolution")
    require(isinstance(resolution, dict), f"{label} resolution is missing")
    require(provenance.get("execution_engine") == "cpu_reference", f"{label} is not CPU reference")
    require(provenance.get("precision") == "double", f"{label} is not double")
    require(provenance.get("lossy_fallback_used") is False, f"{label} used lossy fallback")
    require(resolution.get("resolution_mode") == "exact", f"{label} resolution is not exact")
    require(resolution.get("fallback_occurred") is False, f"{label} used fallback")


def result_map(document: Mapping[str, Any], label: str) -> dict[tuple[str, str], Mapping[str, Any]]:
    results = document.get("results")
    require(isinstance(results, list) and len(results) == 9, f"{label} must contain 9 results")
    mapped: dict[tuple[str, str], Mapping[str, Any]] = {}
    for result in results:
        require(isinstance(result, dict), f"{label} result must be an object")
        key = (result.get("fixture"), result.get("mode"))
        require(key[0] in FIXTURES and key[1] in MODES, f"{label} invalid result key {key}")
        require(key not in mapped, f"{label} duplicate result key {key}")
        provenance = result.get("execution_provenance")
        require(isinstance(provenance, dict), f"{label} {key} provenance is missing")
        validate_exact_execution(provenance, f"{label} {key}")
        transaction = provenance.get("fdm_cpu_step_transaction_telemetry")
        evaluation = provenance.get("fdm_cpu_evaluation_telemetry")
        fft = provenance.get("fdm_fft_execution")
        require(isinstance(transaction, dict), f"{label} {key} transaction telemetry is missing")
        require(isinstance(evaluation, dict), f"{label} {key} evaluation telemetry is missing")
        require(isinstance(fft, dict) and isinstance(fft.get("runtime_telemetry"), dict), f"{label} {key} FFT telemetry is missing")
        require(transaction.get("accepted_step_count") == 30, f"{label} {key} accepted-step count changed")
        require(transaction.get("rejected_attempt_count") == 0, f"{label} {key} rejected an attempt")
        minimal, full = EVALUATIONS[str(key[1])]
        require(evaluation.get("minimal_step_count") == minimal, f"{label} {key} Minimal count changed")
        require(evaluation.get("full_step_count") == full, f"{label} {key} Full count changed")
        runtime_fft = fft["runtime_telemetry"]
        require(runtime_fft.get("forward_fft_count") == 270, f"{label} {key} forward FFT count changed")
        require(runtime_fft.get("inverse_fft_count") == 270, f"{label} {key} inverse FFT count changed")
        for field in ("end_to_end_wall_time_ns", "allocation_count", "allocation_bytes", "peak_live_heap_growth_bytes"):
            integer(result.get(field), f"{label} {key} {field}", minimum=1)
        for field in ("backend_plan_sha256", "final_magnetization_sha256"):
            require(is_lower_hex(str(result.get(field, "")).removeprefix("sha256:"), 64), f"{label} {key} {field} is invalid")
        mapped[key] = result
    expected = {(fixture, mode) for fixture in FIXTURES for mode in MODES}
    require(set(mapped) == expected, f"{label} result matrix is incomplete")
    for fixture in FIXTURES:
        rows = [mapped[(fixture, mode)] for mode in MODES]
        require(len({row["backend_plan_sha256"] for row in rows}) == 1, f"{label} {fixture} plan parity failed")
        require(len({row["final_magnetization_sha256"] for row in rows}) == 1, f"{label} {fixture} state parity failed")
    return mapped


def validate_time_to_accuracy(document: Mapping[str, Any], label: str) -> Mapping[str, Any]:
    evidence = document.get("time_to_accuracy")
    require(isinstance(evidence, dict), f"{label} time_to_accuracy is missing")
    require(evidence.get("oracle_id") == "constant_z_field_llg_from_positive_x.v1", f"{label} oracle changed")
    require(number(evidence.get("tolerance_max_abs"), f"{label} tolerance", positive=True) == 1.0e-3, f"{label} tolerance changed")
    require(number(evidence.get("observed_order_coarse_to_fine"), f"{label} order") >= 1.5, f"{label} order below 1.5")
    require(number(evidence.get("first_passing_timestep_s"), f"{label} passing timestep", positive=True) <= 2.5e-11, f"{label} passing timestep regressed")
    integer(evidence.get("first_passing_wall_time_ns"), f"{label} time-to-accuracy wall time", minimum=1)
    runs = evidence.get("runs")
    require(isinstance(runs, list) and len(runs) == 3, f"{label} must contain 3 refinement runs")
    errors: list[float] = []
    for index, (run, timestep, steps) in enumerate(zip(runs, (5e-11, 2.5e-11, 1.25e-11), (20, 40, 80))):
        require(isinstance(run, dict), f"{label} refinement {index} is invalid")
        require(run.get("timestep_s") == timestep and run.get("expected_steps") == steps, f"{label} refinement schedule changed")
        errors.append(number(run.get("max_abs_error"), f"{label} refinement error", positive=True))
        provenance = run.get("execution_provenance")
        require(isinstance(provenance, dict), f"{label} refinement provenance missing")
        validate_exact_execution(provenance, f"{label} refinement {index}")
    require(all(right < left for left, right in zip(errors, errors[1:])), f"{label} refinement errors do not decrease")
    return evidence


def validate_summary(document: Mapping[str, Any], label: str) -> None:
    require(document.get("schema_version") == SUMMARY_SCHEMA, f"{label} schema mismatch")
    require(document.get("profile") == "full", f"{label} is not full profile")
    require(document.get("qualification_status") == "evidence_only", f"{label} harness status changed")
    require(document.get("qualification_blockers") == ["hardware_baseline_threshold_not_approved"], f"{label} blocker set changed")
    commit = document.get("commit")
    require(is_lower_hex(commit, 40), f"{label} commit is invalid")
    source = document.get("source_identity")
    require(isinstance(source, dict), f"{label} source identity missing")
    require(source.get("git_commit") == commit, f"{label} embedded commit mismatch")
    require(source.get("worktree_state") in {"clean", "dirty"}, f"{label} worktree state invalid")
    require(is_lower_hex(source.get("source_snapshot_sha256"), 64), f"{label} source snapshot invalid")
    require(isinstance(source.get("rustc_version"), str) and source["rustc_version"], f"{label} rustc missing")
    require(isinstance(source.get("target_triple"), str) and source["target_triple"], f"{label} target missing")
    hardware = document.get("hardware_identity")
    require(isinstance(hardware, dict), f"{label} hardware identity missing")
    require(document.get("hardware_fingerprint_sha256") == canonical_sha256(hardware), f"{label} hardware fingerprint mismatch")
    integer(document.get("process_peak_resident_bytes"), f"{label} peak RSS", minimum=1)
    result_map(document, label)
    validate_time_to_accuracy(document, label)


def load_group(paths: Sequence[Path], label: str, minimum: int) -> EvidenceGroup:
    require(len(paths) >= minimum, f"{label} requires at least {minimum} repetitions")
    require(len(set(paths)) == len(paths), f"{label} contains duplicate paths")
    documents = tuple(load_object(path, f"{label} summary") for path in paths)
    for index, document in enumerate(documents):
        validate_summary(document, f"{label}[{index}]")
    commits = {str(document["commit"]) for document in documents}
    snapshots = {str(document["source_identity"]["source_snapshot_sha256"]) for document in documents}
    fingerprints = {str(document["hardware_fingerprint_sha256"]) for document in documents}
    hardware = {json.dumps(document["hardware_identity"], sort_keys=True) for document in documents}
    rustc = {str(document["source_identity"]["rustc_version"]) for document in documents}
    targets = {str(document["source_identity"]["target_triple"]) for document in documents}
    require(len(commits) == len(snapshots) == len(fingerprints) == len(hardware) == len(rustc) == len(targets) == 1, f"{label} identity differs between repetitions")
    first = documents[0]
    return EvidenceGroup(label, tuple(paths), documents, next(iter(commits)), next(iter(snapshots)), next(iter(fingerprints)), first["hardware_identity"], next(iter(rustc)), next(iter(targets)))


def distribution(values: Iterable[float]) -> dict[str, float | int]:
    materialized = sorted(float(value) for value in values)
    require(bool(materialized) and all(math.isfinite(value) and value > 0 for value in materialized), "distribution values must be positive and finite")
    return {
        "count": len(materialized),
        "median": statistics.median(materialized),
        "p95": materialized[math.ceil(0.95 * len(materialized)) - 1],
        "minimum": materialized[0],
        "maximum": materialized[-1],
    }


def compare_metric(metric_id: str, baseline_values: Iterable[float], candidate_values: Iterable[float], median_limit: float, p95_limit: float, allowance: float = 0.0) -> tuple[dict[str, Any], list[str]]:
    baseline = distribution(baseline_values)
    candidate = distribution(candidate_values)
    median_ratio = max(0.0, float(candidate["median"]) - allowance) / float(baseline["median"])
    p95_ratio = max(0.0, float(candidate["p95"]) - allowance) / float(baseline["p95"])
    failures = []
    if median_ratio > median_limit:
        failures.append(f"{metric_id}:median_ratio={median_ratio:.6f}>{median_limit:.6f}")
    if p95_ratio > p95_limit:
        failures.append(f"{metric_id}:p95_ratio={p95_ratio:.6f}>{p95_limit:.6f}")
    return ({
        "metric_id": metric_id,
        "baseline": baseline,
        "candidate": candidate,
        "median_ratio_after_allowance": median_ratio,
        "p95_ratio_after_allowance": p95_ratio,
        "median_ratio_max": median_limit,
        "p95_ratio_max": p95_limit,
        "absolute_allowance": allowance,
        "status": "passed" if not failures else "failed",
    }, failures)


def result_values(group: EvidenceGroup, key: tuple[str, str], field: str) -> list[float]:
    return [float(result_map(document, group.label)[key][field]) for document in group.documents]


def assert_cross_group_parity(baseline: EvidenceGroup, candidate: EvidenceGroup) -> None:
    require(baseline.commit != candidate.commit, "candidate commit must differ from baseline commit")
    require(baseline.snapshot != candidate.snapshot, "candidate snapshot must differ from baseline snapshot")
    require(baseline.hardware_fingerprint == candidate.hardware_fingerprint and baseline.hardware == candidate.hardware, "hardware differs from baseline")
    require(baseline.rustc == candidate.rustc and baseline.target == candidate.target, "toolchain differs from baseline")
    hashes: dict[tuple[str, str], tuple[str, str]] = {}
    for group in (baseline, candidate):
        for document in group.documents:
            for key, result in result_map(document, group.label).items():
                current = (result["backend_plan_sha256"], result["final_magnetization_sha256"])
                require(key not in hashes or hashes[key] == current, f"{key} physical result differs across baseline/candidate")
                hashes[key] = current


def group_receipt(group: EvidenceGroup) -> dict[str, Any]:
    return {
        "commit": group.commit,
        "source_snapshot_sha256": group.snapshot,
        "hardware_fingerprint_sha256": group.hardware_fingerprint,
        "rustc_version": group.rustc,
        "target_triple": group.target,
        "repetitions": len(group.documents),
        "inputs": [{"path": path.as_posix(), "sha256": sha256_file(path)} for path in group.paths],
    }


def evaluate(baseline: EvidenceGroup, candidate: EvidenceGroup, thresholds: Mapping[str, Any], threshold_path: Path) -> dict[str, Any]:
    assert_cross_group_parity(baseline, candidate)
    comparisons: list[dict[str, Any]] = []
    failures: list[str] = []
    timing, allocations, heap = thresholds["timing"], thresholds["allocations"], thresholds["peak_live_heap"]
    for fixture in FIXTURES:
        for mode in MODES:
            key = (fixture, mode)
            policies = (
                ("end_to_end_wall_time_ns", timing["median_ratio_max"], timing["p95_ratio_max"], 0.0),
                ("allocation_count", allocations["count_ratio_max"], allocations["count_ratio_max"], 0.0),
                ("allocation_bytes", allocations["bytes_ratio_max"], allocations["bytes_ratio_max"], 0.0),
                ("peak_live_heap_growth_bytes", heap["median_ratio_max"], heap["p95_ratio_max"], heap["absolute_allowance_bytes"]),
            )
            for field, median_limit, p95_limit, allowance in policies:
                comparison, current = compare_metric(f"{fixture}.{mode}.{field}", result_values(baseline, key, field), result_values(candidate, key, field), float(median_limit), float(p95_limit), float(allowance))
                comparisons.append(comparison)
                failures.extend(current)
    rss = thresholds["process_peak_resident"]
    comparison, current = compare_metric(
        "suite.process_peak_resident_bytes",
        [float(document["process_peak_resident_bytes"]) for document in baseline.documents],
        [float(document["process_peak_resident_bytes"]) for document in candidate.documents],
        float(rss["median_ratio_max"]), float(rss["p95_ratio_max"]), float(rss["absolute_allowance_bytes"]),
    )
    comparisons.append(comparison)
    failures.extend(current)
    tta = thresholds["time_to_accuracy"]
    baseline_tta = [validate_time_to_accuracy(document, baseline.label) for document in baseline.documents]
    candidate_tta = [validate_time_to_accuracy(document, candidate.label) for document in candidate.documents]
    timestep_ratio = statistics.median(float(value["first_passing_timestep_s"]) for value in candidate_tta) / statistics.median(float(value["first_passing_timestep_s"]) for value in baseline_tta)
    timestep_failed = timestep_ratio > float(tta["timestep_ratio_max"])
    comparisons.append({"metric_id": "time_to_accuracy.first_passing_timestep_s", "candidate_to_baseline_ratio": timestep_ratio, "ratio_max": tta["timestep_ratio_max"], "status": "failed" if timestep_failed else "passed"})
    if timestep_failed:
        failures.append(f"time_to_accuracy.first_passing_timestep_s:ratio={timestep_ratio:.6f}>{float(tta['timestep_ratio_max']):.6f}")
    comparison, current = compare_metric(
        "time_to_accuracy.first_passing_wall_time_ns",
        [float(value["first_passing_wall_time_ns"]) for value in baseline_tta],
        [float(value["first_passing_wall_time_ns"]) for value in candidate_tta],
        float(tta["median_wall_time_ratio_max"]), float(tta["p95_wall_time_ratio_max"]),
    )
    comparisons.append(comparison)
    failures.extend(current)
    return {
        "schema_version": RECEIPT_SCHEMA,
        "qualification_status": "passed" if not failures else "failed",
        "failure_reasons": failures,
        "threshold_policy": {"path": threshold_path.as_posix(), "sha256": sha256_file(threshold_path), "schema_version": thresholds["schema_version"]},
        "baseline": group_receipt(baseline),
        "candidate": group_receipt(candidate),
        "comparisons": comparisons,
    }


def external(path: Path, repo_root: Path, label: str) -> Path:
    require(path.is_absolute(), f"{label} must be absolute")
    resolved = path.resolve()
    require(not resolved.is_relative_to(repo_root), f"{label} must be outside repository")
    return resolved


def run(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--thresholds", type=Path, required=True)
    parser.add_argument("--baseline-summary", type=Path, action="append", required=True)
    parser.add_argument("--candidate-summary", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args(argv)
    try:
        repo_root = arguments.repo_root.resolve()
        threshold_path = arguments.thresholds.resolve()
        require(threshold_path.is_relative_to(repo_root), "threshold policy must be below repository")
        thresholds = load_object(threshold_path, "threshold policy")
        validate_thresholds(thresholds)
        minimum = integer(thresholds["minimum_repetitions"], "minimum_repetitions", minimum=5)
        baseline_paths = [external(path, repo_root, "baseline summary") for path in arguments.baseline_summary]
        candidate_paths = [external(path, repo_root, "candidate summary") for path in arguments.candidate_summary]
        output = external(arguments.output, repo_root, "output")
        require(not output.exists(), "output must not already exist")
        receipt = evaluate(load_group(baseline_paths, "baseline", minimum), load_group(candidate_paths, "candidate", minimum), thresholds, threshold_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(json.dumps(receipt, indent=2, ensure_ascii=False))
        return 0 if receipt["qualification_status"] == "passed" else 2
    except (ContractError, OSError) as error:
        print(f"FDM_CPU_PRODUCTION_QUALIFICATION_ERROR={error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(run())
