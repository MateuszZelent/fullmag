#!/usr/bin/env python3
"""Validate immutable FDM relaxation qualification receipts fail-closed."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shlex
import subprocess
from pathlib import Path
from typing import Any, Mapping


SCHEMA = "fdm.relaxation.qualification.v1"
ALGORITHMS = {"llg_overdamped", "projected_gradient_bb", "nonlinear_cg"}
LANE_POLICY = {
    "fdm_cpu_reference": {
        "device": "cpu",
        "precisions": {"fp64"},
        "runtime": {"kind": "reference_process", "id": "fdm_cpu_reference"},
    },
    "fdm_gpu_production": {
        "device": "cuda",
        "precisions": {"fp64", "fp32"},
        "runtime": {"kind": "managed_container", "id": "fdm_cuda_runtime"},
    },
}
ORACLES = {
    "llg_overdamped": {"kind": "independent_reference", "id": "fdm_llg_analytic.v1"},
    "projected_gradient_bb": {
        "kind": "independent_reference",
        "id": "fdm_direct_minimizer_reference.v1",
    },
    "nonlinear_cg": {
        "kind": "independent_reference",
        "id": "fdm_direct_minimizer_reference.v1",
    },
}
COMMANDS = {
    "just verify-fdm-relaxation-qualification-smoke",
    "just verify-fdm-relaxation-qualification-release",
}
SHA256 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")


class QualificationError(RuntimeError):
    """A receipt is not sufficient for scientific qualification."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise QualificationError(message)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(repo_root: Path, *args: str) -> str:
    try:
        return subprocess.check_output(
            ["git", *args], cwd=repo_root, text=True, stderr=subprocess.STDOUT
        ).strip()
    except (OSError, subprocess.CalledProcessError) as error:
        output = getattr(error, "output", "")
        raise QualificationError(f"cannot inspect source identity: {output or error}") from error


def source_identity(repo_root: Path) -> tuple[str, str]:
    status = git(repo_root, "status", "--porcelain=v1", "--untracked-files=all")
    require(not status, "qualification source is dirty")
    commit = git(repo_root, "rev-parse", "HEAD")
    tree = git(repo_root, "rev-parse", "HEAD^{tree}")
    require(COMMIT.fullmatch(commit) is not None, "source commit is invalid")
    require(re.fullmatch(r"[0-9a-f]{40}", tree) is not None, "source tree is invalid")
    identity = json.dumps(
        {"source_commit": commit, "source_tree": tree},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return commit, hashlib.sha256(identity).hexdigest()


def receipt_path(repo_root: Path, raw: object, field: str) -> Path:
    require(isinstance(raw, str) and raw, f"{field} is required")
    relative = Path(raw)
    require(not relative.is_absolute(), f"{field} must be repository-relative")
    reports = (repo_root / ".fullmag" / "reports" / "fdm-relaxation").resolve()
    resolved = (repo_root / relative).resolve()
    require(resolved.is_relative_to(reports), f"{field} must stay under fdm-relaxation reports")
    require(resolved.is_file(), f"{field} does not exist: {raw}")
    return resolved


def workload_id(lane: str, precision: str, algorithm: str, case: str) -> str:
    return f"{lane}.{precision}.{algorithm}.{case}"


def canonical_workloads(lane: str, precision: str, algorithm: str) -> list[str]:
    return [
        workload_id(lane, precision, algorithm, "macrospin"),
        workload_id(lane, precision, algorithm, "exchange_demag"),
    ]


def validate_command(value: object) -> None:
    require(isinstance(value, str) and value in COMMANDS, "managed_command is not an allowlisted FDM recipe")
    tokens = shlex.split(value)
    require(tokens == value.split(), "managed_command must contain exactly one allowlisted just recipe")


def validate_case(
    case: Mapping[str, Any],
    *,
    lane: str,
    precision: str,
    algorithm: str,
    repo_root: Path,
) -> None:
    required = {
        "workload_id",
        "algorithm",
        "backend",
        "device",
        "precision",
        "timeout_s",
        "elapsed_s",
        "status",
        "skipped",
        "fallback_occurred",
        "completion",
        "accepted_steps",
        "max_steps",
        "metrics",
        "oracle",
        "artifacts",
    }
    require(set(case) == required, f"case has non-canonical fields: {sorted(set(case) ^ required)}")
    expected_id = case.get("workload_id")
    require(expected_id in canonical_workloads(lane, precision, algorithm), "case workload_id is not in canonical scope")
    require(case.get("algorithm") == algorithm, "case algorithm mismatch")
    require(case.get("backend") == "fdm", "case backend must be fdm")
    require(case.get("device") == LANE_POLICY[lane]["device"], "case device mismatch")
    require(case.get("precision") == precision, "case precision mismatch")
    timeout = case.get("timeout_s")
    elapsed = case.get("elapsed_s")
    require(isinstance(timeout, (int, float)) and timeout > 0, "case timeout_s must be positive")
    require(isinstance(elapsed, (int, float)) and 0 <= elapsed <= timeout, "case elapsed_s exceeds timeout")
    require(case.get("status") == "passed", "case did not pass")
    require(case.get("skipped") is False, "skipped case cannot qualify")
    require(case.get("fallback_occurred") is False, "fallback case cannot qualify")
    completion = case.get("completion")
    require(isinstance(completion, dict), "case completion is required")
    require(completion.get("converged") is True, "case completion.converged must be true")
    require(completion.get("reason") in {"torque", "energy"}, "case completion reason is not a convergence reason")
    accepted_steps = case.get("accepted_steps")
    max_steps = case.get("max_steps")
    require(isinstance(accepted_steps, int) and accepted_steps >= 0, "accepted_steps is invalid")
    require(isinstance(max_steps, int) and max_steps > 0, "max_steps is invalid")
    require(accepted_steps < max_steps, "max_steps termination cannot qualify as convergence")
    metrics = case.get("metrics")
    require(isinstance(metrics, dict) and metrics, "case metrics are required")
    require(all(isinstance(value, (int, float)) and float(value) == float(value) and abs(float(value)) != float("inf") for value in metrics.values()), "case metrics must be finite")
    oracle = case.get("oracle")
    require(
        isinstance(oracle, dict)
        and set(oracle) == {"kind", "id", "artifact_path", "artifact_sha256"}
        and {key: oracle[key] for key in ("kind", "id")} == ORACLES[algorithm],
        "case oracle is not the canonical independent oracle",
    )
    oracle_artifact = receipt_path(repo_root, oracle["artifact_path"], "oracle.artifact_path")
    require(SHA256.fullmatch(str(oracle["artifact_sha256"])) is not None, "oracle artifact sha256 is invalid")
    require(sha256_file(oracle_artifact) == oracle["artifact_sha256"], "oracle artifact hash mismatch")
    artifacts = case.get("artifacts")
    require(isinstance(artifacts, list) and artifacts, "case artifacts are required")
    for artifact in artifacts:
        require(isinstance(artifact, dict) and set(artifact) == {"path", "sha256"}, "case artifact entry is invalid")
        path = receipt_path(repo_root, artifact.get("path"), "case artifact.path")
        require(SHA256.fullmatch(str(artifact.get("sha256"))) is not None, "case artifact sha256 is invalid")
        require(sha256_file(path) == artifact["sha256"], "case artifact hash mismatch")


def validate_receipt(document: Mapping[str, Any], repo_root: Path) -> None:
    require(document.get("schema_version") == SCHEMA, "schema_version is invalid")
    require(document.get("status") == "passed", "receipt status is not passed")
    lane = document.get("lane")
    require(lane in LANE_POLICY, "lane is not canonical")
    policy = LANE_POLICY[lane]
    precision = document.get("precision")
    require(precision in policy["precisions"], "precision is not legal for lane")
    require(document.get("backend") == "fdm", "backend is not fdm")
    require(document.get("device") == policy["device"], "device does not match lane")
    require(document.get("runtime_identity") == policy["runtime"], "runtime identity does not match lane")
    algorithm = document.get("algorithm")
    require(algorithm in ALGORITHMS, "algorithm is invalid")
    require(document.get("managed_command") in COMMANDS, "managed command is invalid")
    validate_command(document.get("managed_command"))
    source = document.get("source_identity")
    require(isinstance(source, dict) and source.get("source_clean") is True, "source identity is not clean")
    require(COMMIT.fullmatch(str(source.get("source_commit"))) is not None, "source commit is invalid")
    require(SHA256.fullmatch(str(source.get("source_tree_sha256"))) is not None, "source tree hash is invalid")
    current_commit, current_tree = source_identity(repo_root)
    require(source.get("source_commit") == current_commit, "source commit is stale")
    require(source.get("source_tree_sha256") == current_tree, "source tree hash is stale")
    workloads = document.get("validated_workloads")
    expected_workloads = canonical_workloads(lane, precision, algorithm)
    require(workloads == expected_workloads, "validated_workloads do not match canonical scope")
    cases = document.get("cases")
    require(isinstance(cases, list) and len(cases) == len(expected_workloads), "receipt cases are incomplete")
    case_ids = [case.get("workload_id") for case in cases if isinstance(case, dict)]
    require(case_ids == expected_workloads, "case order or workload coverage is not canonical")
    for case in cases:
        require(isinstance(case, dict), "case must be an object")
        validate_case(case, lane=lane, precision=precision, algorithm=algorithm, repo_root=repo_root)
    receipt_artifact = receipt_path(repo_root, document.get("artifact_path"), "artifact_path")
    require(SHA256.fullmatch(str(document.get("artifact_sha256"))) is not None, "artifact_sha256 is invalid")
    require(sha256_file(receipt_artifact) == document["artifact_sha256"], "receipt artifact hash mismatch")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipt", type=Path)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    try:
        document = json.loads(args.receipt.read_text(encoding="utf-8"))
        require(isinstance(document, dict), "receipt root must be an object")
        validate_receipt(document, args.repo_root.resolve())
    except (OSError, json.JSONDecodeError, QualificationError) as error:
        print(f"FAIL: {error}")
        return 1
    print("FDM relaxation qualification PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
