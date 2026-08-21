#!/usr/bin/env python3
"""Validate immutable FDM relaxation qualification receipts fail-closed."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import re
import shlex
import subprocess
from pathlib import Path
from typing import Any, Mapping


_MATRIX_SPEC = importlib.util.spec_from_file_location(
    "relaxation_production_matrix_for_fdm",
    Path(__file__).with_name("verify_relaxation_production_matrix.py"),
)
if _MATRIX_SPEC is None or _MATRIX_SPEC.loader is None:  # pragma: no cover - import machinery failure
    raise RuntimeError("cannot load the canonical relaxation matrix validator")
PRODUCTION_MATRIX = importlib.util.module_from_spec(_MATRIX_SPEC)
_MATRIX_SPEC.loader.exec_module(PRODUCTION_MATRIX)

try:
    from scripts.relaxation_qualification_contract import (
        PARITY_SCHEMA,
        RECEIPT_SCHEMA,
        canonical_binding,
        parity_scope,
        validate_mesh_refinement,
        validate_repeatability,
        validate_sha256_mapping,
    )
except ModuleNotFoundError:  # direct ``python scripts/<script>.py`` execution
    from relaxation_qualification_contract import (  # type: ignore[no-redef]
        PARITY_SCHEMA,
        RECEIPT_SCHEMA,
        canonical_binding,
        parity_scope,
        validate_mesh_refinement,
        validate_repeatability,
        validate_sha256_mapping,
    )

SCHEMA = RECEIPT_SCHEMA
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
    "llg_overdamped": {"kind": "independent_reference", "id": "fem_llg_reference.v1"},
    "projected_gradient_bb": {
        "kind": "independent_reference",
        "id": "fem_relaxation_endpoint_equivalence.v1",
    },
    "nonlinear_cg": {
        "kind": "independent_reference",
        "id": "fem_relaxation_endpoint_equivalence.v1",
    },
}
COMMANDS_BY_LANE = {
    # Smoke is evidence only; only the bounded release recipe can produce a
    # receipt accepted as a qualification input.
    "fdm_cpu_reference": {"just verify-fdm-relaxation-qualification-release"},
    "fdm_gpu_production": {"just verify-fdm-relaxation-qualification-cuda-release"},
}
RECIPE_HEADER = re.compile(r"^([A-Za-z0-9_-]+)(?:\s+[^:]*)?:\s*(?:#.*)?$")
ARTIFACT_SCHEMA = "fullmag.relaxation.qualification_artifact.v1"
EVIDENCE_LEVELS = ("D4", "D5", "D6")
RELEASE_TIMEOUT_S = 900.0
SCOPE_KEYS = {
    "feature_id",
    "algorithm",
    "lane",
    "backend",
    "device",
    "precision",
    "runtime_identity",
    "validated_workloads",
    "oracle",
    "mesh_refinement",
    "repeatability",
    "evidence",
    "material_representation",
    "material_payload_sha256",
    "active_mask_sha256",
    "realization_id",
    "direction_policy",
    "parity",
}
EXECUTION_KEYS = {
    "status",
    "converged",
    "termination_reason",
    "timeout",
    "max_steps_reached",
    "non_converged",
    "fallback_occurred",
    "accepted_steps",
    "max_steps",
    "metrics",
    "confirmation",
    "process",
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
    top_level = Path(git(repo_root, "rev-parse", "--show-toplevel")).resolve()
    require(top_level == repo_root.resolve(), "repo_root is not the Git worktree root")
    flagged = [
        line
        for line in git(repo_root, "ls-files", "-v").splitlines()
        if line and line[0] in {"h", "s", "S"}
    ]
    require(not flagged, "qualification source has assume-unchanged or skip-worktree index flags")
    status = git(
        repo_root,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
    )
    require(not status, "qualification source is dirty")
    commit = git(repo_root, "rev-parse", "HEAD")
    tree = git(repo_root, "rev-parse", "HEAD^{tree}")
    require(COMMIT.fullmatch(commit) is not None, "source commit is invalid")
    require(COMMIT.fullmatch(tree) is not None, "source tree is invalid")
    identity = json.dumps(
        {"source_commit": commit, "source_tree": tree},
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()
    return commit, hashlib.sha256(identity).hexdigest()


def receipt_path(repo_root: Path, raw: object, field: str) -> Path:
    require(isinstance(raw, str) and raw, f"{field} is required")
    relative = Path(raw)
    require(not relative.is_absolute() and ".." not in relative.parts, f"{field} must be repository-relative")
    reports = (repo_root / ".fullmag" / "reports" / "fdm-relaxation").resolve()
    unresolved = repo_root / relative
    require(not unresolved.is_symlink(), f"{field} must not be a symlink")
    resolved = unresolved.resolve()
    require(resolved.is_relative_to(reports), f"{field} must stay under fdm-relaxation reports")
    require(not resolved.is_symlink(), f"{field} must not be a symlink")
    require(resolved.is_file(), f"{field} does not exist: {raw}")
    return resolved


def workload_id(lane: str, precision: str, algorithm: str, case: str) -> str:
    return f"{lane}.{precision}.{algorithm}.{case}"


def canonical_workloads(lane: str, precision: str, algorithm: str) -> list[str]:
    return [
        workload_id(lane, precision, algorithm, "macrospin"),
        workload_id(lane, precision, algorithm, "exchange_demag"),
    ]


def recipe_body(repo_root: Path, recipe: str) -> str:
    justfile = repo_root / "justfile"
    require(justfile.is_file(), "repository justfile does not exist")
    lines = justfile.read_text(encoding="utf-8").splitlines()
    for index, line in enumerate(lines):
        match = RECIPE_HEADER.fullmatch(line)
        if match is None or match.group(1) != recipe:
            continue
        body: list[str] = []
        for candidate in lines[index + 1 :]:
            if candidate and not candidate[0].isspace():
                break
            body.append(candidate)
        return "\n".join(line.rstrip() for line in body).strip("\n") + "\n"
    raise QualificationError(f"recipe {recipe} does not exist in justfile")


def recipe_sha256(repo_root: Path, command: str) -> str:
    tokens = shlex.split(command)
    require(len(tokens) == 2 and tokens[0] == "just", "managed_command must contain exactly one just recipe")
    return hashlib.sha256(recipe_body(repo_root, tokens[1]).encode("utf-8")).hexdigest()


def validate_command(value: object, *, lane: str, repo_root: Path) -> str:
    require(isinstance(value, str), "managed_command is required")
    tokens = shlex.split(value)
    require(tokens == value.split(), "managed_command must contain exactly one allowlisted just recipe")
    require(len(tokens) == 2 and tokens[0] == "just", "managed_command must contain exactly one just recipe")
    require(value in COMMANDS_BY_LANE[lane], "managed_command is not an allowlisted recipe for this FDM lane")
    return recipe_sha256(repo_root, value)


def _finite_metrics(value: object) -> bool:
    return isinstance(value, Mapping) and bool(value) and all(
        isinstance(item, (int, float))
        and not isinstance(item, bool)
        and math.isfinite(float(item))
        for item in value.values()
    )


def _load_json(path: Path) -> Mapping[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, Mapping) else None


def _validate_case_artifact(path: Path, workload: str) -> None:
    document = _load_json(path)
    require(document is not None, "case artifact must be JSON")
    require(document.get("schema_version") == "fullmag.relaxation.case_artifact.v1", "case artifact schema is invalid")
    require(document.get("workload_id") == workload, "case artifact workload mismatch")
    require(document.get("status") == "passed", "case artifact did not pass")
    require(isinstance(document.get("result"), Mapping), "case artifact result is missing")
    require(
        isinstance(document.get("run_count"), int) and document["run_count"] >= 6,
        "case artifact run_count does not prove warmup plus measured runs",
    )


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
    workload = case.get("workload_id")
    require(workload in canonical_workloads(lane, precision, algorithm), "case workload_id is not in canonical scope")
    require(case.get("algorithm") == algorithm, "case algorithm mismatch")
    require(case.get("backend") == "fdm", "case backend must be fdm")
    require(case.get("device") == LANE_POLICY[lane]["device"], "case device mismatch")
    require(case.get("precision") == precision, "case precision mismatch")
    timeout = case.get("timeout_s")
    elapsed = case.get("elapsed_s")
    require(
        isinstance(timeout, (int, float))
        and not isinstance(timeout, bool)
        and math.isfinite(float(timeout))
        and 0 < timeout <= RELEASE_TIMEOUT_S,
        "case timeout_s must be positive and no greater than 900 s",
    )
    require(
        isinstance(elapsed, (int, float))
        and not isinstance(elapsed, bool)
        and math.isfinite(float(elapsed))
        and 0 <= elapsed <= timeout,
        "case elapsed_s exceeds timeout",
    )
    require(case.get("status") == "passed", "case did not pass")
    require(case.get("skipped") is False, "skipped case cannot qualify")
    require(case.get("fallback_occurred") is False, "fallback case cannot qualify")
    completion = case.get("completion")
    require(isinstance(completion, Mapping), "case completion is required")
    require(completion.get("converged") is True, "case completion.converged must be true")
    require(completion.get("reason") in {"torque", "energy"}, "case completion reason is not a convergence reason")
    accepted_steps = case.get("accepted_steps")
    max_steps = case.get("max_steps")
    require(isinstance(accepted_steps, int) and not isinstance(accepted_steps, bool) and accepted_steps >= 0, "accepted_steps is invalid")
    require(isinstance(max_steps, int) and not isinstance(max_steps, bool) and max_steps > 0, "max_steps is invalid")
    require(accepted_steps < max_steps, "max_steps termination cannot qualify as convergence")
    require(_finite_metrics(case.get("metrics")), "case metrics must be finite")
    oracle = case.get("oracle")
    require(
        isinstance(oracle, Mapping)
        and set(oracle) == {"kind", "id", "artifact_path", "artifact_sha256"}
        and {key: oracle[key] for key in ("kind", "id")} == ORACLES[algorithm],
        "case oracle is not the canonical independent oracle",
    )
    oracle_artifact = receipt_path(repo_root, oracle["artifact_path"], "oracle.artifact_path")
    require(SHA256.fullmatch(str(oracle["artifact_sha256"])) is not None, "oracle artifact sha256 is invalid")
    require(sha256_file(oracle_artifact) == oracle["artifact_sha256"], "oracle artifact hash mismatch")
    oracle_document = _load_json(oracle_artifact)
    require(oracle_document is not None, "oracle artifact must be JSON")
    require(oracle_document.get("schema_version") == "fullmag.relaxation.oracle_artifact.v1", "oracle artifact schema is invalid")
    require(oracle_document.get("oracle") == ORACLES[algorithm], "oracle artifact identity mismatch")
    require(oracle_document.get("workload") == workload.rsplit(".", 1)[-1], "oracle artifact workload mismatch")
    measurement_count = oracle_document.get("measurement_count")
    require(isinstance(measurement_count, int) and measurement_count >= 6, "oracle artifact measurements are incomplete")
    comparisons = oracle_document.get("comparisons")
    require(isinstance(comparisons, list) and len(comparisons) == measurement_count, "oracle artifact comparisons are incomplete")
    for comparison in comparisons:
        require(isinstance(comparison, Mapping), "oracle comparison is invalid")
        require(comparison.get("status") == "passed", "oracle comparison did not pass")
        for field in ("input_contract_sha256", "final_state_sha256"):
            require(SHA256.fullmatch(str(comparison.get(field))) is not None, f"oracle {field} is invalid")
        require(isinstance(comparison.get("reference"), Mapping), "oracle reference values are missing")
        require(isinstance(comparison.get("observed"), Mapping), "oracle observed values are missing")
        require(isinstance(comparison.get("absolute_error"), Mapping), "oracle comparison errors are missing")
        tolerance = comparison.get("tolerance")
        require(_finite_metrics(tolerance), "oracle tolerances are invalid")
    oracle_errors: list[str] = []
    PRODUCTION_MATRIX._validate_oracle_artifact(
        repo_root,
        oracle_document,
        algorithm=algorithm,
        lane=lane,
        precision=precision,
        workload=workload,
        cell=f"algorithm={algorithm}|lane={lane}|precision={precision}",
        errors=oracle_errors,
    )
    require(not oracle_errors, "oracle artifact is not independently source-bound: " + "; ".join(oracle_errors))
    artifacts = case.get("artifacts")
    require(isinstance(artifacts, list) and artifacts, "case artifacts are required")
    for artifact in artifacts:
        require(isinstance(artifact, Mapping) and set(artifact) == {"path", "sha256"}, "case artifact entry is invalid")
        path = receipt_path(repo_root, artifact.get("path"), "case artifact.path")
        require(SHA256.fullmatch(str(artifact.get("sha256"))) is not None, "case artifact sha256 is invalid")
        require(sha256_file(path) == artifact["sha256"], "case artifact hash mismatch")
        _validate_case_artifact(path, workload)


def _validate_execution(document: Mapping[str, Any], repo_root: Path) -> None:
    execution = document.get("execution")
    require(isinstance(execution, Mapping), "execution is required")
    require(set(execution) == EXECUTION_KEYS, "execution has non-canonical fields")
    require(execution.get("status") == "passed", "execution status is not passed")
    require(execution.get("converged") is True, "execution is not converged")
    require(execution.get("termination_reason") in {"torque", "energy"}, "execution termination reason is invalid")
    for key in ("timeout", "max_steps_reached", "non_converged", "fallback_occurred"):
        require(execution.get(key) is False, f"execution.{key} cannot qualify")
    accepted_steps = execution.get("accepted_steps")
    max_steps = execution.get("max_steps")
    require(isinstance(accepted_steps, int) and not isinstance(accepted_steps, bool) and accepted_steps >= 0, "execution accepted_steps is invalid")
    require(isinstance(max_steps, int) and not isinstance(max_steps, bool) and max_steps > 0, "execution max_steps is invalid")
    require(accepted_steps < max_steps, "execution reached max_steps")
    require(_finite_metrics(execution.get("metrics")), "execution metrics are invalid")
    confirmation = execution.get("confirmation")
    require(isinstance(confirmation, Mapping), "execution confirmation is required")
    require(isinstance(confirmation.get("accepted_state_id"), str) and confirmation["accepted_state_id"], "accepted state identity is required")
    require(confirmation.get("observed_after_accepted_step") is True, "torque was not observed after accepted state")
    process = execution.get("process")
    require(isinstance(process, Mapping), "execution process is required")
    required_process = {
        "command",
        "command_sha256",
        "runtime_manifest_path",
        "runtime_manifest_sha256",
        "log_path",
        "log_sha256",
        "exit_code",
    }
    require(set(process) == required_process, "execution process has non-canonical fields")
    command = document.get("managed_command")
    require(process.get("command") == command, "execution process command mismatch")
    require(
        SHA256.fullmatch(str(process.get("command_sha256"))) is not None
        and process["command_sha256"] == hashlib.sha256(str(command).encode("utf-8")).hexdigest(),
        "execution process command hash mismatch",
    )
    for path_field in ("runtime_manifest_path", "log_path"):
        path = receipt_path(repo_root, process.get(path_field), f"execution.process.{path_field}")
        digest_field = path_field.replace("_path", "_sha256")
        require(SHA256.fullmatch(str(process.get(digest_field))) is not None, f"{digest_field} is invalid")
        require(sha256_file(path) == process[digest_field], f"{path_field} hash mismatch")
    require(process.get("exit_code") == 0, "execution process failed")
    runtime_manifest = _load_json(receipt_path(repo_root, process["runtime_manifest_path"], "runtime_manifest_path"))
    require(runtime_manifest is not None, "runtime manifest must be JSON")
    require(runtime_manifest.get("schema_version") == "fullmag.relaxation.runtime_manifest.v1", "runtime manifest schema is invalid")
    require(runtime_manifest.get("runtime_identity") == document.get("runtime_identity"), "runtime manifest identity mismatch")
    require(runtime_manifest.get("source_commit") == document.get("source_commit"), "runtime manifest source commit mismatch")
    require(runtime_manifest.get("source_tree_sha256") == document.get("source_tree_sha256"), "runtime manifest source tree mismatch")
    log = _load_json(receipt_path(repo_root, process["log_path"], "log_path"))
    require(log is not None, "execution log must be JSON")
    require(log.get("schema_version") == "fullmag.relaxation.execution_log.v1", "execution log schema is invalid")
    require(log.get("status") == "passed" and log.get("exit_code") == 0, "execution log did not pass")
    require(log.get("command") == command, "execution log command mismatch")


def _validate_semantic_artifact(
    document: Mapping[str, Any],
    receipt: Mapping[str, Any],
    algorithm: str,
    lane: str,
    precision: str,
    level: str,
) -> None:
    require(document.get("schema_version") == ARTIFACT_SCHEMA, f"{level} artifact schema is invalid")
    require(document.get("level") == level, f"{level} artifact level is invalid")
    require(
        document.get("cell") == {"algorithm": algorithm, "lane": lane, "precision": precision},
        f"{level} artifact cell mismatch",
    )
    require(document.get("workload_ids") == canonical_workloads(lane, precision, algorithm), f"{level} artifact workloads mismatch")
    require(document.get("source_commit") == receipt.get("source_commit"), f"{level} artifact source commit mismatch")
    require(document.get("source_tree_sha256") == receipt.get("source_tree_sha256"), f"{level} artifact source tree mismatch")
    require(document.get("runtime_identity") == LANE_POLICY[lane]["runtime"], f"{level} artifact runtime mismatch")
    require(document.get("oracle") == ORACLES[algorithm], f"{level} artifact oracle mismatch")
    scope = receipt.get("validated_scope")
    require(isinstance(scope, Mapping), f"{level} artifact scope is missing")
    for key in (
        "material_representation",
        "material_payload_sha256",
        "active_mask_sha256",
        "realization_id",
        "direction_policy",
    ):
        require(document.get(key) == scope.get(key), f"{level} artifact {key} mismatch")
    require(
        document.get("mesh_refinement_observations") == scope.get("mesh_refinement"),
        f"{level} artifact mesh refinement observations mismatch",
    )
    require(
        document.get("repeatability_observations") == scope.get("repeatability"),
        f"{level} artifact repeatability observations mismatch",
    )
    require(document.get("parity") == scope.get("parity"), f"{level} artifact parity mismatch")
    result = document.get("result")
    require(isinstance(result, Mapping), f"{level} artifact result is required")
    require(result.get("status") == "passed" and result.get("converged") is True, f"{level} artifact did not converge")
    require(result.get("termination_reason") in {"torque", "energy"}, f"{level} artifact termination reason is invalid")
    accepted_steps = result.get("accepted_steps")
    max_steps = result.get("max_steps")
    require(isinstance(accepted_steps, int) and isinstance(max_steps, int) and max_steps > 0 and accepted_steps < max_steps, f"{level} artifact step bounds are invalid")
    require(_finite_metrics(result.get("metrics")), f"{level} artifact metrics are invalid")


def _validate_parity(
    scope: Mapping[str, Any],
    receipt: Mapping[str, Any],
    repo_root: Path,
    *,
    algorithm: str,
    lane: str,
    precision: str,
) -> None:
    value = scope.get("parity")
    expected = parity_scope(lane, precision)
    if expected["status"] == "not_applicable":
        require(value == expected, "validated_scope parity must be not_applicable")
        return
    require(isinstance(value, Mapping), "validated_scope parity is required")
    for key, expected_value in expected.items():
        require(value.get(key) == expected_value, f"validated_scope parity {key} is not canonical")
    artifact_path = receipt_path(repo_root, value.get("artifact_path"), "parity.artifact_path")
    artifact_hash = value.get("artifact_sha256")
    require(SHA256.fullmatch(str(artifact_hash)) is not None, "parity artifact_sha256 is invalid")
    require(sha256_file(artifact_path) == artifact_hash, "parity artifact hash mismatch")
    artifact = _load_json(artifact_path)
    require(artifact is not None, "parity artifact must be JSON")
    require(artifact.get("schema_version") == PARITY_SCHEMA, "parity artifact schema is invalid")
    require(artifact.get("status") == "passed", "parity artifact did not pass")
    require(
        artifact.get("target") == {"algorithm": algorithm, "lane": lane, "precision": precision},
        "parity target mismatch",
    )
    require(
        artifact.get("baseline")
        == {"lane": expected["baseline_lane"], "precision": expected["baseline_precision"]},
        "parity baseline mismatch",
    )
    require(artifact.get("source_commit") == receipt.get("source_commit"), "parity source commit mismatch")
    require(
        artifact.get("source_tree_sha256") == receipt.get("source_tree_sha256"),
        "parity source tree mismatch",
    )
    comparisons = artifact.get("comparisons")
    require(isinstance(comparisons, list) and len(comparisons) == 6, "parity comparisons are incomplete")
    target_workloads = set(canonical_workloads(lane, precision, algorithm))
    baseline_workloads = set(
        canonical_workloads(expected["baseline_lane"], expected["baseline_precision"], algorithm)
    )
    target_refinement = scope.get("mesh_refinement")
    target_observations = target_refinement.get("observations") if isinstance(target_refinement, Mapping) else None
    target_by_pair = {
        (item.get("workload_id"), item.get("mesh_level")): item
        for item in target_observations or []
        if isinstance(item, Mapping)
    }
    metric_names = {"energy_j", "max_torque_apm", "max_torque_t", "mx", "my", "mz"}
    observed_pairs: set[tuple[object, object, object]] = set()
    for comparison in comparisons:
        require(isinstance(comparison, Mapping) and comparison.get("status") == "passed", "parity comparison is invalid")
        target_workload = comparison.get("target_workload_id")
        baseline_workload = comparison.get("baseline_workload_id")
        mesh_level = comparison.get("mesh_level")
        require(
            target_workload in target_workloads
            and baseline_workload in baseline_workloads
            and isinstance(mesh_level, str)
            and (target_workload, baseline_workload, mesh_level) not in observed_pairs,
            "parity workload/mesh comparison is invalid",
        )
        observed_pairs.add((target_workload, baseline_workload, mesh_level))
        for key in (
            "target_input_contract_sha256",
            "baseline_input_contract_sha256",
            "target_final_state_sha256",
            "baseline_final_state_sha256",
        ):
            require(SHA256.fullmatch(str(comparison.get(key))) is not None, f"parity {key} is invalid")
        for key in ("target_metrics", "baseline_metrics", "absolute_error", "tolerance"):
            require(_finite_metrics(comparison.get(key)), f"parity {key} is invalid")
        target_observation = target_by_pair.get((target_workload, mesh_level))
        require(isinstance(target_observation, Mapping), "parity target refinement observation is missing")
        require(
            comparison.get("target_input_contract_sha256") == target_observation.get("input_contract_sha256"),
            "parity target input contract does not match refinement evidence",
        )
        final_states = target_observation.get("final_state_sha256")
        require(
            isinstance(final_states, list)
            and comparison.get("target_final_state_sha256") in final_states,
            "parity target final state does not match refinement evidence",
        )
        target_metrics = comparison.get("target_metrics")
        baseline_metrics = comparison.get("baseline_metrics")
        absolute_error = comparison.get("absolute_error")
        tolerance = comparison.get("tolerance")
        require(isinstance(target_metrics, Mapping) and set(target_metrics) == metric_names, "parity target metrics keys are invalid")
        require(isinstance(baseline_metrics, Mapping) and set(baseline_metrics) == metric_names, "parity baseline metrics keys are invalid")
        require(isinstance(absolute_error, Mapping) and set(absolute_error) == metric_names, "parity absolute error keys are invalid")
        require(isinstance(tolerance, Mapping) and set(tolerance) == metric_names, "parity tolerance keys are invalid")
        for name in metric_names:
            expected_error = abs(float(target_metrics[name]) - float(baseline_metrics[name]))
            require(
                abs(float(absolute_error[name]) - expected_error) <= max(1e-30, expected_error * 1e-12),
                f"parity absolute error is not recalculated for {name}",
            )
            require(float(tolerance[name]) >= 0 and expected_error <= float(tolerance[name]), f"parity tolerance failed for {name}")
    expected_pairs = {
        (target, baseline, mesh)
        for target in target_workloads
        for baseline in baseline_workloads
        if target.rsplit(".", 1)[-1] == baseline.rsplit(".", 1)[-1]
        for mesh in ("coarse", "medium", "fine")
    }
    require(observed_pairs == expected_pairs, "parity workload/mesh coverage is incomplete")


def _validate_scope(document: Mapping[str, Any], repo_root: Path) -> None:
    algorithm = document["algorithm"]
    lane = document["lane"]
    precision = document["precision"]
    scope = document.get("validated_scope")
    require(isinstance(scope, Mapping), "validated_scope is required")
    require(set(scope) == SCOPE_KEYS, "validated_scope has non-canonical fields")
    policy = LANE_POLICY[lane]
    expected = {
        "feature_id": f"relaxation_{algorithm}",
        "algorithm": algorithm,
        "lane": lane,
        "backend": "fdm",
        "device": policy["device"],
        "precision": precision,
        "runtime_identity": policy["runtime"],
        "validated_workloads": canonical_workloads(lane, precision, algorithm),
        "oracle": ORACLES[algorithm],
    }
    expected.update(
        canonical_binding(
            lane=lane,
            algorithm=algorithm,
            workload_ids=expected["validated_workloads"],
            mesh_levels=("coarse", "medium", "fine"),
        )
    )
    for key, value in expected.items():
        require(scope.get(key) == value, f"validated_scope.{key} is not canonical")
    require(
        validate_mesh_refinement(scope.get("mesh_refinement"), expected["validated_workloads"]),
        "validated_scope.mesh_refinement observations are incomplete",
    )
    require(
        validate_repeatability(scope.get("repeatability"), expected["validated_workloads"]),
        "validated_scope.repeatability observations are incomplete",
    )
    require(
        validate_sha256_mapping(scope.get("material_payload_sha256")),
        "validated_scope.material_payload_sha256 is invalid",
    )
    require(
        validate_sha256_mapping(scope.get("active_mask_sha256"), nested=True),
        "validated_scope.active_mask_sha256 is invalid",
    )
    _validate_parity(
        scope,
        document,
        repo_root,
        algorithm=algorithm,
        lane=lane,
        precision=precision,
    )
    evidence = scope.get("evidence")
    require(isinstance(evidence, Mapping) and set(evidence) == set(EVIDENCE_LEVELS), "validated_scope evidence is incomplete")
    collected: list[str] = []
    for level in EVIDENCE_LEVELS:
        level_evidence = evidence[level]
        require(isinstance(level_evidence, Mapping), f"{level} evidence is invalid")
        require(set(level_evidence) == {"status", "artifact_manifest"}, f"{level} evidence fields are not canonical")
        require(level_evidence.get("status") == "passed", f"{level} evidence did not pass")
        manifest = level_evidence.get("artifact_manifest")
        require(isinstance(manifest, list) and manifest, f"{level} artifact manifest is empty")
        for item in manifest:
            require(isinstance(item, Mapping) and set(item) == {"path", "sha256"}, f"{level} artifact manifest entry is invalid")
            path = receipt_path(repo_root, item.get("path"), f"{level}.artifact_path")
            digest = item.get("sha256")
            require(SHA256.fullmatch(str(digest)) is not None, f"{level} artifact hash is invalid")
            require(sha256_file(path) == digest, f"{level} artifact hash mismatch")
            artifact = _load_json(path)
            require(artifact is not None, f"{level} artifact must be JSON")
            _validate_semantic_artifact(artifact, document, algorithm, lane, precision, level)
            collected.append(str(item["path"]).replace("\\", "/"))
    artifact_path = document.get("artifact_path")
    receipt_artifact = receipt_path(repo_root, artifact_path, "artifact_path")
    digest = document.get("artifact_sha256")
    require(SHA256.fullmatch(str(digest)) is not None, "artifact_sha256 is invalid")
    require(sha256_file(receipt_artifact) == digest, "receipt artifact hash mismatch")
    require(isinstance(artifact_path, str) and artifact_path.replace("\\", "/") in collected, "receipt artifact is not in evidence manifest")


def validate_receipt(document: Mapping[str, Any], repo_root: Path) -> None:
    require(document.get("schema_version") == SCHEMA, "schema_version is invalid")
    require(document.get("status") == "passed", "receipt status is not passed")
    algorithm = document.get("algorithm")
    require(algorithm in ALGORITHMS, "algorithm is invalid")
    lane = document.get("lane")
    require(lane in LANE_POLICY, "lane is not canonical")
    policy = LANE_POLICY[lane]
    precision = document.get("precision")
    require(precision in policy["precisions"], "precision is not legal for lane")
    require(document.get("feature_id") == f"relaxation_{algorithm}", "feature_id is invalid")
    require(document.get("backend") == "fdm", "backend is not fdm")
    require(document.get("device") == policy["device"], "device does not match lane")
    require(document.get("runtime_identity") == policy["runtime"], "runtime identity does not match lane")
    require(document.get("source_clean") is True, "source_clean must be true")
    source_commit = document.get("source_commit")
    source_tree = document.get("source_tree_sha256")
    require(COMMIT.fullmatch(str(source_commit)) is not None, "source commit is invalid")
    require(SHA256.fullmatch(str(source_tree)) is not None, "source tree hash is invalid")
    current_commit, current_tree = source_identity(repo_root)
    require(source_commit == current_commit, "source commit is stale")
    require(source_tree == current_tree, "source tree hash is stale")
    command = document.get("managed_command")
    expected_recipe_hash = validate_command(command, lane=lane, repo_root=repo_root)
    require(document.get("recipe_sha256") == expected_recipe_hash, "recipe_sha256 does not match current justfile")
    require(document.get("solver_audit_gate") == "passed", "solver_audit_gate must be passed")
    _validate_execution(document, repo_root)
    _validate_scope(document, repo_root)
    expected_workloads = canonical_workloads(lane, precision, algorithm)
    cases = document.get("cases")
    require(isinstance(cases, list) and len(cases) == len(expected_workloads), "receipt cases are incomplete")
    case_ids = [case.get("workload_id") for case in cases if isinstance(case, Mapping)]
    require(case_ids == expected_workloads, "case order or workload coverage is not canonical")
    for case in cases:
        require(isinstance(case, Mapping), "case must be an object")
        validate_case(case, lane=lane, precision=precision, algorithm=algorithm, repo_root=repo_root)
    matrix_errors: list[str] = []
    cell = f"algorithm={algorithm}|lane={lane}|precision={precision}"
    PRODUCTION_MATRIX._validate_execution(repo_root, document, cell, matrix_errors)
    PRODUCTION_MATRIX._validate_cases(repo_root, document, algorithm, lane, precision, cell, matrix_errors)
    require(not matrix_errors, "production execution evidence is incomplete: " + "; ".join(matrix_errors))


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
