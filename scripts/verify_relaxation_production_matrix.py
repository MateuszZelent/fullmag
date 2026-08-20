#!/usr/bin/env python3
"""Fail-closed orchestration of the FM-RELAX-017 qualification matrix.

The script consumes already-produced FDM/FEM relaxation receipts.  It never
starts a solver.  Qualification is possible only when every canonical cell
has exactly one receipt with complete scope, matching source/recipe identity,
and verified immutable artifacts.  Missing or contradictory evidence produces
an auditable ``blocked`` manifest instead of an implicit pass.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shlex
import subprocess
from collections import defaultdict
from pathlib import Path
from typing import Any, Mapping, Sequence


RECEIPT_SCHEMA = "fullmag.relaxation_qualification_receipt.v1"
MANIFEST_SCHEMA = "fullmag.relaxation_production_matrix.v1"
MATRIX_ID = "FM-RELAX-017"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")

ALGORITHMS = (
    "llg_overdamped",
    "projected_gradient_bb",
    "nonlinear_cg",
    "tangent_plane_implicit",
)
FEATURE_IDS = {algorithm: f"relaxation_{algorithm}" for algorithm in ALGORITHMS}
ARTIFACT_SCHEMA = "fullmag.relaxation.qualification_artifact.v1"
RECIPE_HEADER = re.compile(r"^([A-Za-z0-9_-]+)(?:\s+[^:]*)?:\s*(?:#.*)?$")

# These are the only recipes that can ever produce a matrix receipt.  The
# CUDA/FEM recipes are intentionally reserved until their managed runtime
# contracts exist in the repository; a CPU recipe must never qualify a GPU
# cell by naming a different lane in the receipt.
CANONICAL_RECIPE_BY_LANE = {
    "fdm_cpu_reference": "verify-fdm-relaxation-qualification-release",
    "fdm_gpu_production": "verify-fdm-relaxation-qualification-cuda-release",
    "fem_cpu_public": "verify-fem-relaxation-qualification-release",
    "fem_gpu_public": "verify-fem-relaxation-qualification-cuda-release",
}

# TPI is not a legal production cell for FDM or FEM GPU in the current
# capability matrix.  It must be represented as not_applicable, not as a
# permanently missing receipt.
UNSUPPORTED_CELLS = {
    ("tangent_plane_implicit", "fdm_cpu_reference"),
    ("tangent_plane_implicit", "fdm_gpu_production"),
    ("tangent_plane_implicit", "fem_gpu_public"),
}

# The order is part of the canonical matrix and therefore part of the
# deterministic output.  FEM FP32 is intentionally not a legal cell until it
# has its own qualification contract.
LANE_POLICIES: dict[str, dict[str, Any]] = {
    "fdm_cpu_reference": {
        "backend": "fdm",
        "device": "cpu",
        "precisions": ("fp64",),
        "runtime_identity": {"kind": "reference_process", "id": "fdm_cpu_reference"},
    },
    "fdm_gpu_production": {
        "backend": "fdm",
        "device": "cuda",
        "precisions": ("fp32", "fp64"),
        "runtime_identity": {"kind": "managed_container", "id": "fdm_cuda_runtime"},
    },
    "fem_cpu_public": {
        "backend": "fem",
        "device": "cpu",
        "precisions": ("fp64",),
        "runtime_identity": {"kind": "managed_container", "id": "fem_cpu_runtime"},
    },
    "fem_gpu_public": {
        "backend": "fem",
        "device": "gpu",
        "precisions": ("fp64",),
        "runtime_identity": {"kind": "managed_container", "id": "fem_gpu_host"},
    },
}

ORACLE_IDENTITIES: dict[str, dict[str, str]] = {
    "llg_overdamped": {
        "kind": "independent_reference",
        "id": "fem_llg_reference.v1",
    },
    "projected_gradient_bb": {
        "kind": "independent_reference",
        "id": "fem_relaxation_endpoint_equivalence.v1",
    },
    "nonlinear_cg": {
        "kind": "independent_reference",
        "id": "fem_relaxation_endpoint_equivalence.v1",
    },
    "tangent_plane_implicit": {
        "kind": "independent_reference",
        "id": "fem_tpi_reference.v1",
    },
}

SCOPE_KEYS = frozenset(
    {
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
    }
)
EVIDENCE_LEVELS = ("D4", "D5", "D6")
EXECUTION_KEYS = frozenset(
    {
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
)
EXPECTED_MESH_REFINEMENT = {
    "levels": ["coarse", "medium", "fine"],
    "strategy": "same_physical_problem",
}
EXPECTED_REPEATABILITY = {"warmup_runs": 1, "measured_runs": 5}


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    return _sha256_bytes(path.read_bytes())


def _is_sha256(value: object) -> bool:
    return isinstance(value, str) and SHA256_RE.fullmatch(value) is not None


def _is_commit(value: object) -> bool:
    return isinstance(value, str) and COMMIT_RE.fullmatch(value) is not None


def _cell(algorithm: str, lane: str, precision: str) -> str:
    return f"algorithm={algorithm}|lane={lane}|precision={precision}"


def canonical_cells() -> tuple[tuple[str, str, str], ...]:
    return tuple(
        (algorithm, lane, precision)
        for algorithm in ALGORITHMS
        for lane, policy in LANE_POLICIES.items()
        for precision in policy["precisions"]
        if (algorithm, lane) not in UNSUPPORTED_CELLS
    )


def all_matrix_cells() -> tuple[tuple[str, str, str], ...]:
    return tuple(
        (algorithm, lane, precision)
        for algorithm in ALGORITHMS
        for lane, policy in LANE_POLICIES.items()
        for precision in policy["precisions"]
    )


def canonical_workloads(algorithm: str, lane: str, precision: str) -> list[str]:
    return [
        f"{lane}.{precision}.{algorithm}.macrospin",
        f"{lane}.{precision}.{algorithm}.exchange_demag",
    ]


def _git(repo_root: Path, *args: str) -> str:
    try:
        return subprocess.check_output(
            ["git", *args], cwd=repo_root, text=True, stderr=subprocess.STDOUT
        ).strip()
    except (OSError, subprocess.CalledProcessError) as error:
        output = getattr(error, "output", "")
        raise ValueError(f"cannot inspect source identity: {output or error}") from error


def _source_identity(repo_root: Path) -> tuple[str, str]:
    flagged = [
        line
        for line in _git(repo_root, "ls-files", "-v").splitlines()
        if line and line[0] in {"h", "s", "S"}
    ]
    if flagged:
        raise ValueError("source has assume-unchanged or skip-worktree index flags")
    status = _git(
        repo_root,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
    )
    if status:
        raise ValueError("source worktree is dirty")
    commit = _git(repo_root, "rev-parse", "HEAD")
    tree = _git(repo_root, "rev-parse", "HEAD^{tree}")
    if not _is_commit(commit):
        raise ValueError("source commit is invalid")
    identity = _canonical_bytes({"source_commit": commit, "source_tree": tree})
    return commit, _sha256_bytes(identity)


def _recipe_body(repo_root: Path, recipe: str) -> str:
    justfile = repo_root / "justfile"
    if not justfile.is_file():
        raise ValueError("repository justfile does not exist")
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
    raise ValueError(f"canonical recipe {recipe} does not exist in justfile")


def _recipe_sha256(repo_root: Path, recipe: str) -> str:
    return _sha256_bytes(_recipe_body(repo_root, recipe).encode("utf-8"))


def _path_label(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def _add(errors: list[str], cell: str | None, detail: str) -> None:
    errors.append(f"{cell}|{detail}" if cell else detail)


def _load_json(path: Path) -> Mapping[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _safe_artifact_path(root: Path, raw: object, label: str, errors: list[str], cell: str) -> Path | None:
    if not isinstance(raw, str) or not raw:
        _add(errors, cell, f"missing={label}")
        return None
    relative = Path(raw)
    if relative.is_absolute() or ".." in relative.parts:
        _add(errors, cell, f"invalid={label}.path")
        return None
    unresolved = root / relative
    if unresolved.is_symlink():
        _add(errors, cell, f"invalid={label}.symlink")
        return None
    candidate = unresolved.resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        _add(errors, cell, f"invalid={label}.path")
        return None
    if candidate.is_symlink():
        _add(errors, cell, f"invalid={label}.symlink")
        return None
    if not candidate.is_file():
        _add(errors, cell, f"missing={label}.file")
        return None
    return candidate


def _validate_expected_identity(
    expected: Mapping[str, Any] | None,
    errors: list[str],
) -> dict[str, Any] | None:
    if expected is None:
        _add(errors, None, "missing=expected_identity")
        return None
    if not isinstance(expected, Mapping):
        _add(errors, None, "invalid=expected_identity")
        return None
    result: dict[str, Any] = {}
    commit = expected.get("source_commit")
    tree = expected.get("source_tree_sha256")
    if not _is_commit(commit):
        _add(errors, None, "missing=expected_identity.source_commit")
    else:
        result["source_commit"] = commit
    if not _is_sha256(tree):
        _add(errors, None, "missing=expected_identity.source_tree_sha256")
    else:
        result["source_tree_sha256"] = tree
    recipe_hashes = expected.get("recipe_sha256_by_lane")
    if not isinstance(recipe_hashes, Mapping):
        _add(errors, None, "missing=expected_identity.recipe_sha256_by_lane")
    else:
        normalized: dict[str, str] = {}
        for lane in LANE_POLICIES:
            value = recipe_hashes.get(lane)
            if not _is_sha256(value):
                _add(errors, None, f"missing=expected_identity.recipe_sha256_by_lane.{lane}")
            else:
                normalized[lane] = value
        result["recipe_sha256_by_lane"] = normalized
    return result


def _receipt_cell(receipt: Mapping[str, Any], path_label: str, errors: list[str]) -> tuple[str, str, str] | None:
    values = {
        "algorithm": receipt.get("algorithm"),
        "lane": receipt.get("lane"),
        "precision": receipt.get("precision"),
    }
    for key, value in values.items():
        if not isinstance(value, str) or not value:
            _add(errors, None, f"receipt={path_label}|missing={key}")
    if any(not isinstance(value, str) or not value for value in values.values()):
        return None
    algorithm = values["algorithm"]
    lane = values["lane"]
    precision = values["precision"]
    assert isinstance(algorithm, str)
    assert isinstance(lane, str)
    assert isinstance(precision, str)
    if algorithm not in ALGORITHMS:
        _add(errors, None, f"receipt={path_label}|invalid=algorithm.{algorithm}")
        return None
    if lane not in LANE_POLICIES:
        _add(errors, None, f"receipt={path_label}|invalid=lane.{lane}")
        return None
    if precision not in LANE_POLICIES[lane]["precisions"]:
        _add(errors, None, f"receipt={path_label}|invalid=precision.{precision}")
        return None
    return algorithm, lane, precision


def _scan_forbidden_execution_values(
    value: object,
    cell: str,
    errors: list[str],
    path: str = "receipt",
) -> None:
    """Catch failure metadata even when a producer put it outside execution."""

    if isinstance(value, Mapping):
        for raw_key, child in value.items():
            key = str(raw_key).lower().replace("-", "_")
            child_path = f"{path}.{key}"
            if key in {"fallback", "fallback_occurred", "used_fallback", "cpu_fallback"}:
                if child is True:
                    _add(errors, cell, "fallback=true")
            elif key in {"fallbacks", "fallback_events"}:
                if child not in ([], None, False, ""):
                    _add(errors, cell, "fallback=present")
            elif key == "fallback_reason" and child not in (None, False, "", []):
                _add(errors, cell, "fallback=present")
            elif key in {"source_dirty", "worktree_dirty", "dirty"} and child is True:
                _add(errors, cell, "source_dirty=true")
            elif key == "clean" and child is False:
                _add(errors, cell, "source_dirty=true")
            elif key in {"timeout", "timed_out", "timedout"} and child is True:
                _add(errors, cell, "timeout=true")
            elif key in {"max_steps", "max_steps_reached", "hit_max_steps"} and child is True:
                _add(errors, cell, "max_steps=true")
            elif key in {"converged", "is_converged"} and child is False:
                _add(errors, cell, "non_converged=true")
            elif key in {"termination_reason", "reason", "failure_category"} and isinstance(child, str):
                normalized = child.lower().replace("-", "_").replace(" ", "_")
                if "timeout" in normalized:
                    _add(errors, cell, "timeout=true")
                elif "max_step" in normalized:
                    _add(errors, cell, "max_steps=true")
                elif "non_conver" in normalized or "not_conver" in normalized:
                    _add(errors, cell, "non_converged=true")
                elif normalized in {"failed", "failure", "error"}:
                    _add(errors, cell, "status=failed")
            _scan_forbidden_execution_values(child, cell, errors, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _scan_forbidden_execution_values(child, cell, errors, f"{path}[{index}]")


def _validate_execution(
    root: Path,
    receipt: Mapping[str, Any],
    cell: str,
    errors: list[str],
) -> None:
    execution = receipt.get("execution")
    if not isinstance(execution, Mapping):
        _add(errors, cell, "missing=execution")
        return
    for key in sorted(EXECUTION_KEYS - set(execution)):
        _add(errors, cell, f"missing=execution.{key}")
    if execution.get("status") != "passed":
        _add(errors, cell, f"status={execution.get('status', 'missing')}")
    if execution.get("converged") is not True:
        _add(errors, cell, "non_converged=true")
    if execution.get("termination_reason") not in {"torque", "energy"}:
        _add(errors, cell, f"termination_reason={execution.get('termination_reason', 'missing')}")
    for key, reason in (
        ("timeout", "timeout=true"),
        ("max_steps_reached", "max_steps=true"),
        ("non_converged", "non_converged=true"),
        ("fallback_occurred", "fallback=true"),
    ):
        if execution.get(key) is not False:
            _add(errors, cell, reason)
    accepted_steps = execution.get("accepted_steps")
    max_steps = execution.get("max_steps")
    if not isinstance(accepted_steps, int) or accepted_steps < 0:
        _add(errors, cell, "invalid=execution.accepted_steps")
    if not isinstance(max_steps, int) or max_steps <= 0:
        _add(errors, cell, "invalid=execution.max_steps")
    elif isinstance(accepted_steps, int) and accepted_steps >= max_steps:
        _add(errors, cell, "max_steps=true")
    metrics = execution.get("metrics")
    if not isinstance(metrics, Mapping) or not metrics:
        _add(errors, cell, "missing=execution.metrics")
    else:
        for name, value in metrics.items():
            if not isinstance(name, str) or not isinstance(value, (int, float)) or not float(value) == float(value) or abs(float(value)) == float("inf"):
                _add(errors, cell, f"invalid=execution.metrics.{name}")
    confirmation = execution.get("confirmation")
    if not isinstance(confirmation, Mapping):
        _add(errors, cell, "missing=execution.confirmation")
    else:
        if not isinstance(confirmation.get("accepted_state_id"), str) or not confirmation["accepted_state_id"]:
            _add(errors, cell, "missing=execution.confirmation.accepted_state_id")
        if confirmation.get("observed_after_accepted_step") is not True:
            _add(errors, cell, "missing=execution.confirmation.observed_after_accepted_step")
    process = execution.get("process")
    if not isinstance(process, Mapping):
        _add(errors, cell, "missing=execution.process")
        return
    required_process = {
        "command",
        "command_sha256",
        "runtime_manifest_path",
        "runtime_manifest_sha256",
        "log_path",
        "log_sha256",
        "exit_code",
    }
    if set(process) != required_process:
        _add(errors, cell, "invalid=execution.process.fields")
        return
    command = receipt.get("managed_command")
    if process.get("command") != command:
        _add(errors, cell, "mismatch=execution.process.command")
    if not _is_sha256(process.get("command_sha256")) or process.get("command_sha256") != _sha256_bytes(str(command).encode("utf-8")):
        _add(errors, cell, "invalid=execution.process.command_sha256")
    for field in ("runtime_manifest_path", "log_path"):
        path = _safe_artifact_path(root, process.get(field), f"execution.process.{field}", errors, cell)
        digest = process.get(f"{field.replace('_path', '')}_sha256")
        if not _is_sha256(digest):
            _add(errors, cell, f"invalid=execution.process.{field.replace('_path', '')}_sha256")
        elif path is not None and _sha256_file(path) != digest:
            _add(errors, cell, f"artifact_sha256_mismatch=execution.process.{field}")
    if process.get("exit_code") != 0:
        _add(errors, cell, "status=process_failed")


def _validate_artifact_manifest(
    root: Path,
    level: str,
    level_evidence: object,
    cell: str,
    errors: list[str],
    collected: list[dict[str, str]],
    receipt: Mapping[str, Any],
    algorithm: str,
    lane: str,
    precision: str,
) -> None:
    if not isinstance(level_evidence, Mapping):
        _add(errors, cell, f"missing=scope.evidence.{level}")
        return
    if level_evidence.get("status") != "passed":
        _add(errors, cell, f"status={level}.evidence")
    manifest = level_evidence.get("artifact_manifest")
    if not isinstance(manifest, list) or not manifest:
        _add(errors, cell, f"missing=scope.evidence.{level}.artifact_manifest")
        return
    for index, item in enumerate(manifest):
        if not isinstance(item, Mapping):
            _add(errors, cell, f"invalid=scope.evidence.{level}.artifact_manifest[{index}]")
            continue
        raw_path = item.get("path")
        digest = item.get("sha256")
        artifact = _safe_artifact_path(
            root,
            raw_path,
            f"scope.evidence.{level}.artifact_manifest[{index}]",
            errors,
            cell,
        )
        if not _is_sha256(digest):
            _add(errors, cell, f"invalid=scope.evidence.{level}.artifact_manifest[{index}].sha256")
        if artifact is None or not _is_sha256(digest):
            continue
        assert isinstance(raw_path, str)
        assert isinstance(digest, str)
        if _sha256_file(artifact) != digest:
            _add(errors, cell, f"artifact_sha256_mismatch={raw_path}")
        _validate_semantic_artifact(
            artifact,
            level,
            receipt,
            algorithm,
            lane,
            precision,
            cell,
            errors,
        )
        collected.append({"level": level, "path": raw_path.replace("\\", "/"), "sha256": digest})


def _validate_semantic_artifact(
    path: Path,
    level: str,
    receipt: Mapping[str, Any],
    algorithm: str,
    lane: str,
    precision: str,
    cell: str,
    errors: list[str],
) -> None:
    document = _load_json(path)
    if document is None:
        _add(errors, cell, f"invalid={level}.artifact_json")
        return
    if document.get("schema_version") != ARTIFACT_SCHEMA:
        _add(errors, cell, f"invalid={level}.artifact_schema")
    if document.get("level") != level:
        _add(errors, cell, f"mismatch={level}.artifact_level")
    expected_cell = {"algorithm": algorithm, "lane": lane, "precision": precision}
    if document.get("cell") != expected_cell:
        _add(errors, cell, f"mismatch={level}.artifact_cell")
    if document.get("workload_ids") != canonical_workloads(algorithm, lane, precision):
        _add(errors, cell, f"mismatch={level}.artifact_workloads")
    for key in ("source_commit", "source_tree_sha256"):
        if document.get(key) != receipt.get(key):
            _add(errors, cell, f"mismatch={level}.artifact_{key}")
    if document.get("runtime_identity") != LANE_POLICIES[lane]["runtime_identity"]:
        _add(errors, cell, f"mismatch={level}.artifact_runtime_identity")
    if document.get("oracle") != ORACLE_IDENTITIES[algorithm]:
        _add(errors, cell, f"mismatch={level}.artifact_oracle")
    result = document.get("result")
    if not isinstance(result, Mapping):
        _add(errors, cell, f"missing={level}.artifact_result")
        return
    if result.get("status") != "passed" or result.get("converged") is not True:
        _add(errors, cell, f"non_converged={level}.artifact_result")
    if result.get("termination_reason") not in {"torque", "energy"}:
        _add(errors, cell, f"invalid={level}.artifact_termination_reason")
    accepted_steps = result.get("accepted_steps")
    max_steps = result.get("max_steps")
    if not isinstance(accepted_steps, int) or not isinstance(max_steps, int) or max_steps <= 0 or accepted_steps >= max_steps:
        _add(errors, cell, f"invalid={level}.artifact_step_bounds")
    metrics = result.get("metrics")
    if not isinstance(metrics, Mapping) or not metrics or any(
        not isinstance(value, (int, float))
        or not float(value) == float(value)
        or abs(float(value)) == float("inf")
        for value in metrics.values()
    ):
        _add(errors, cell, f"invalid={level}.artifact_metrics")


def _validate_scope(
    root: Path,
    receipt: Mapping[str, Any],
    algorithm: str,
    lane: str,
    precision: str,
    cell: str,
    errors: list[str],
) -> list[dict[str, str]]:
    scope = receipt.get("validated_scope")
    if not isinstance(scope, Mapping):
        _add(errors, cell, "missing=scope")
        return []
    for key in sorted(SCOPE_KEYS - set(scope)):
        _add(errors, cell, f"missing=scope.{key}")
    extra = sorted(set(scope) - SCOPE_KEYS)
    for key in extra:
        _add(errors, cell, f"invalid=scope.{key}")
    policy = LANE_POLICIES[lane]
    expected_values: dict[str, object] = {
        "feature_id": FEATURE_IDS[algorithm],
        "algorithm": algorithm,
        "lane": lane,
        "backend": policy["backend"],
        "device": policy["device"],
        "precision": precision,
        "runtime_identity": policy["runtime_identity"],
        "validated_workloads": canonical_workloads(algorithm, lane, precision),
        "oracle": ORACLE_IDENTITIES[algorithm],
        "mesh_refinement": EXPECTED_MESH_REFINEMENT,
        "repeatability": EXPECTED_REPEATABILITY,
    }
    for key, expected in expected_values.items():
        if key not in scope:
            continue
        if scope.get(key) != expected:
            _add(errors, cell, f"mismatch=scope.{key}")
    evidence = scope.get("evidence")
    collected: list[dict[str, str]] = []
    if not isinstance(evidence, Mapping):
        _add(errors, cell, "missing=scope.evidence")
    else:
        for level in EVIDENCE_LEVELS:
            _validate_artifact_manifest(
                root,
                level,
                evidence.get(level),
                cell,
                errors,
                collected,
                receipt,
                algorithm,
                lane,
                precision,
            )
    artifact_path = _safe_artifact_path(root, receipt.get("artifact_path"), "artifact", errors, cell)
    artifact_digest = receipt.get("artifact_sha256")
    if not _is_sha256(artifact_digest):
        _add(errors, cell, "missing=artifact_sha256")
    if artifact_path is not None and _is_sha256(artifact_digest):
        assert isinstance(artifact_digest, str)
        if _sha256_file(artifact_path) != artifact_digest:
            _add(errors, cell, "artifact_sha256_mismatch=artifact_path")
        artifact_relative = receipt.get("artifact_path")
        assert isinstance(artifact_relative, str)
        if not any(item["path"] == artifact_relative.replace("\\", "/") for item in collected):
            _add(errors, cell, "missing=artifact_manifest.artifact_path")
    return collected


def _validate_receipt(
    root: Path,
    receipt: Mapping[str, Any],
    cell_tuple: tuple[str, str, str],
    expected: Mapping[str, Any] | None,
    errors: list[str],
    live_source_identity: tuple[str, str] | None = None,
    live_recipe_sha256: str | None = None,
) -> list[dict[str, str]]:
    algorithm, lane, precision = cell_tuple
    cell = _cell(algorithm, lane, precision)
    if receipt.get("schema_version") != RECEIPT_SCHEMA:
        _add(errors, cell, "invalid=schema_version")
    if receipt.get("status") != "passed":
        _add(errors, cell, f"status={receipt.get('status', 'missing')}")
    if receipt.get("feature_id") != FEATURE_IDS[algorithm]:
        _add(errors, cell, "mismatch=feature_id")
    policy = LANE_POLICIES[lane]
    for key, expected_value in (
        ("backend", policy["backend"]),
        ("device", policy["device"]),
        ("precision", precision),
    ):
        if receipt.get(key) != expected_value:
            _add(errors, cell, f"mismatch={key}")
    if receipt.get("runtime_identity") != policy["runtime_identity"]:
        _add(errors, cell, "mismatch=runtime_identity")
    if receipt.get("source_clean") is not True:
        _add(errors, cell, "source_clean=false")
    if not isinstance(receipt.get("managed_command"), str) or not receipt["managed_command"].strip():
        _add(errors, cell, "missing=managed_command")
    else:
        try:
            command = shlex.split(receipt["managed_command"])
        except ValueError:
            command = []
        if len(command) != 2 or command[0] != "just":
            _add(errors, cell, "invalid=managed_command")
        elif command[1] != CANONICAL_RECIPE_BY_LANE[lane]:
            _add(errors, cell, "mismatch=managed_command.canonical_recipe")
    if expected is not None:
        if receipt.get("source_commit") != expected.get("source_commit"):
            _add(errors, cell, "source_commit=mismatch")
        if receipt.get("source_tree_sha256") != expected.get("source_tree_sha256"):
            _add(errors, cell, "source_tree_sha256=mismatch")
        expected_recipe = expected.get("recipe_sha256_by_lane", {}).get(lane)
        if receipt.get("recipe_sha256") != expected_recipe:
            _add(errors, cell, "recipe_sha256=mismatch")
    else:
        for key in ("source_commit", "source_tree_sha256", "recipe_sha256"):
            _add(errors, cell, f"missing={key}")
    if not _is_commit(receipt.get("source_commit")):
        _add(errors, cell, "invalid=source_commit")
    if not _is_sha256(receipt.get("source_tree_sha256")):
        _add(errors, cell, "invalid=source_tree_sha256")
    if not _is_sha256(receipt.get("recipe_sha256")):
        _add(errors, cell, "invalid=recipe_sha256")
    if live_source_identity is not None:
        if receipt.get("source_commit") != live_source_identity[0]:
            _add(errors, cell, "source_commit=live_worktree_mismatch")
        if receipt.get("source_tree_sha256") != live_source_identity[1]:
            _add(errors, cell, "source_tree_sha256=live_worktree_mismatch")
    if live_recipe_sha256 is not None and receipt.get("recipe_sha256") != live_recipe_sha256:
        _add(errors, cell, "recipe_sha256=live_justfile_mismatch")
    if receipt.get("solver_audit_gate") != "passed":
        _add(errors, cell, "missing=solver_audit_gate.passed")
    _validate_execution(root, receipt, cell, errors)
    _scan_forbidden_execution_values(receipt, cell, errors)
    return _validate_scope(root, receipt, algorithm, lane, precision, cell, errors)


def _discover_receipts(root: Path) -> list[Path]:
    if root.is_file():
        return [root]
    if not root.is_dir():
        return []
    candidates = []
    for path in root.rglob("*.json"):
        name = path.name.lower()
        if name == "receipt.json" or "receipt" in name:
            candidates.append(path)
            continue
        document = _load_json(path)
        if document is not None and document.get("schema_version") == RECEIPT_SCHEMA:
            candidates.append(path)
    return sorted(candidates, key=lambda path: path.as_posix())


def orchestrate(
    receipt_paths: Sequence[Path],
    *,
    expected_identity: Mapping[str, Any] | None,
    artifact_root: Path,
    output_path: Path | None = None,
    source_root: Path | None = None,
) -> dict[str, Any]:
    """Validate receipts and return a deterministic qualification result.

    ``expected_identity`` is mandatory for a qualified result.  It must name
    the source commit, source tree digest, and recipe digest for every lane;
    the orchestrator never chooses the first receipt as its trust anchor.
    """

    root = artifact_root.resolve()
    errors: list[str] = []
    normalized_expected = _validate_expected_identity(expected_identity, errors)
    live_source_identity: tuple[str, str] | None = None
    live_recipe_sha256: dict[str, str] = {}
    if source_root is not None:
        source_root = source_root.resolve()
        try:
            live_source_identity = _source_identity(source_root)
        except ValueError as error:
            _add(errors, None, f"invalid=live_source_identity|{error}")
        for lane, recipe in CANONICAL_RECIPE_BY_LANE.items():
            try:
                live_recipe_sha256[lane] = _recipe_sha256(source_root, recipe)
            except (OSError, UnicodeError, ValueError) as error:
                _add(errors, None, f"invalid=live_recipe.{lane}|{error}")
        if normalized_expected is not None and live_source_identity is not None:
            if normalized_expected.get("source_commit") != live_source_identity[0]:
                _add(errors, None, "mismatch=expected_identity.source_commit.live_worktree")
            if normalized_expected.get("source_tree_sha256") != live_source_identity[1]:
                _add(errors, None, "mismatch=expected_identity.source_tree_sha256.live_worktree")
        if normalized_expected is not None:
            expected_hashes = normalized_expected.get("recipe_sha256_by_lane", {})
            for lane, actual in live_recipe_sha256.items():
                if expected_hashes.get(lane) != actual:
                    _add(errors, None, f"mismatch=expected_identity.recipe_sha256_by_lane.{lane}.live_justfile")
    records: list[dict[str, Any]] = []
    by_cell: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    receipt_paths_sorted = sorted(
        (Path(path) for path in receipt_paths),
        key=lambda path: _path_label(path, root),
    )
    for path in receipt_paths_sorted:
        try:
            path.resolve().relative_to(root)
        except ValueError:
            _add(errors, None, f"receipt={path.name}|invalid=outside_artifact_root")
            continue
        if path.is_symlink():
            _add(errors, None, f"receipt={_path_label(path, root)}|invalid=symlink")
            continue
        label = _path_label(path, root)
        receipt = _load_json(path)
        if receipt is None:
            _add(errors, None, f"receipt={label}|invalid=json")
            continue
        cell_tuple = _receipt_cell(receipt, label, errors)
        record = {
            "path": label,
            "sha256": _sha256_file(path) if path.is_file() else None,
            "receipt": receipt,
            "cell": cell_tuple,
            "artifacts": [],
        }
        records.append(record)
        if cell_tuple is not None:
            by_cell[cell_tuple].append(record)

    for cell_tuple, cell_records in by_cell.items():
        cell = _cell(*cell_tuple)
        if len(cell_records) > 1:
            paths = ",".join(record["path"] for record in cell_records)
            _add(errors, cell, f"duplicate_receipt={paths}")
        for record in cell_records:
            record["artifacts"] = _validate_receipt(
                root,
                record["receipt"],
                cell_tuple,
                normalized_expected,
                errors,
                live_source_identity,
                live_recipe_sha256.get(cell_tuple[1]),
            )

    for cell_tuple in canonical_cells():
        if cell_tuple not in by_cell:
            _add(errors, _cell(*cell_tuple), "missing=receipt")

    identities = {
        (
            record["receipt"].get("source_commit"),
            record["receipt"].get("source_tree_sha256"),
        )
        for record in records
        if record["cell"] is not None
    }
    if len(identities) > 1:
        _add(errors, None, "mixed_source=receipt_identities_differ")

    manifest_cells: list[dict[str, Any]] = []
    for algorithm, lane, precision in all_matrix_cells():
        cell_tuple = (algorithm, lane, precision)
        if (algorithm, lane) in UNSUPPORTED_CELLS:
            manifest_cells.append(
                {
                    "algorithm": algorithm,
                    "lane": lane,
                    "precision": precision,
                    "status": "not_applicable",
                    "receipt_paths": [],
                }
            )
            continue
        cell_records = by_cell.get(cell_tuple, [])
        manifest_cells.append(
            {
                "algorithm": algorithm,
                "lane": lane,
                "precision": precision,
                "status": "qualified" if len(cell_records) == 1 else "blocked",
                "receipt_paths": [record["path"] for record in cell_records],
            }
        )
    receipt_manifest = [
        {
            "cell": (
                {"algorithm": record["cell"][0], "lane": record["cell"][1], "precision": record["cell"][2]}
                if record["cell"] is not None
                else None
            ),
            "path": record["path"],
            "sha256": record["sha256"],
        }
        for record in records
    ]
    receipt_manifest.sort(key=lambda item: (item["path"], json.dumps(item["cell"], sort_keys=True)))
    artifacts: list[dict[str, str]] = []
    artifact_owners: dict[str, set[str]] = defaultdict(set)
    for record in records:
        cell_tuple = record["cell"]
        if cell_tuple is None:
            continue
        for item in record["artifacts"]:
            artifact_owners[item["path"]].add(_cell(*cell_tuple))
            artifacts.append(
                {
                    "cell": _cell(*cell_tuple),
                    "level": item["level"],
                    "path": item["path"],
                    "sha256": item["sha256"],
                }
            )
    for path, owners in sorted(artifact_owners.items()):
        if len(owners) > 1:
            _add(errors, None, f"duplicate_artifact_across_cells={path}")
    artifacts.sort(key=lambda item: (item["path"], item["level"], item["cell"], item["sha256"]))
    missing_evidence = sorted(set(errors))
    status = "qualified" if not missing_evidence else "blocked"
    manifest: dict[str, Any] = {
        "schema_version": MANIFEST_SCHEMA,
        "matrix_id": MATRIX_ID,
        "status": status,
        "canonical_scope": {
            "algorithms": list(ALGORITHMS),
            "lanes": {
                lane: list(policy["precisions"])
                for lane, policy in LANE_POLICIES.items()
            },
            "cell_count": len(canonical_cells()),
            "not_applicable_cells": [
                {
                    "algorithm": algorithm,
                    "lane": lane,
                    "precision": precision,
                }
                for algorithm, lane, precision in all_matrix_cells()
                if (algorithm, lane) in UNSUPPORTED_CELLS
            ],
        },
        "expected_identity": normalized_expected,
        "cells": manifest_cells,
        "receipts": receipt_manifest,
        "artifact_manifest": artifacts,
        "missing_evidence": missing_evidence,
    }
    checksum = _sha256_bytes(_canonical_bytes(manifest))
    manifest["checksum_sha256"] = checksum
    if output_path is not None:
        destination = Path(output_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(_canonical_bytes(manifest) + b"\n")
    return {
        "status": status,
        "checksum_sha256": checksum,
        "manifest": manifest,
        "missing_evidence": missing_evidence,
    }


def _read_expected_identity(path: Path | None, args: argparse.Namespace) -> dict[str, Any] | None:
    if path is not None:
        value = _load_json(path)
        return dict(value) if value is not None else None
    recipe_hashes: dict[str, str] = {}
    for item in args.recipe_sha256 or []:
        if "=" not in item:
            continue
        lane, digest = item.split("=", 1)
        recipe_hashes[lane] = digest
    if args.source_commit is None and args.source_tree_sha256 is None and not recipe_hashes:
        return None
    return {
        "source_commit": args.source_commit,
        "source_tree_sha256": args.source_tree_sha256,
        "recipe_sha256_by_lane": recipe_hashes,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", action="append", type=Path, dest="receipts")
    parser.add_argument("--receipt-root", type=Path)
    parser.add_argument("--expected-identity", type=Path)
    parser.add_argument("--source-commit")
    parser.add_argument("--source-tree-sha256")
    parser.add_argument("--recipe-sha256", action="append", help="LANE=SHA256")
    parser.add_argument("--artifact-root", type=Path)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("relaxation-production-matrix.v1.json"),
    )
    args = parser.parse_args(argv)
    receipt_root = args.receipt_root or args.artifact_root or Path.cwd()
    receipt_paths = list(args.receipts or [])
    if not receipt_paths:
        receipt_paths = _discover_receipts(receipt_root)
    artifact_root = (args.artifact_root or args.receipt_root or Path.cwd()).resolve()
    result = orchestrate(
        receipt_paths,
        expected_identity=_read_expected_identity(args.expected_identity, args),
        artifact_root=artifact_root,
        output_path=args.output,
    )
    print(f"{MATRIX_ID} {result['status'].upper()}")
    print(f"manifest={args.output} checksum_sha256={result['checksum_sha256']}")
    for item in result["missing_evidence"]:
        print(f"- {item}")
    return 0 if result["status"] == "qualified" else 1


if __name__ == "__main__":
    raise SystemExit(main())
