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

try:
    from scripts.relaxation_qualification_contract import (
        RECEIPT_SCHEMA,
        canonical_binding,
        parity_baseline,
        parity_scope,
        PARITY_SCHEMA,
        validate_mesh_refinement,
        validate_repeatability,
        validate_sha256_mapping,
    )
except ModuleNotFoundError:  # direct ``python scripts/<script>.py`` execution
    from relaxation_qualification_contract import (  # type: ignore[no-redef]
        RECEIPT_SCHEMA,
        canonical_binding,
        parity_baseline,
        parity_scope,
        PARITY_SCHEMA,
        validate_mesh_refinement,
        validate_repeatability,
        validate_sha256_mapping,
    )

MANIFEST_SCHEMA = "fullmag.relaxation_production_matrix.v1"
MATRIX_ID = "FM-RELAX-017"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
ROOT = Path(__file__).resolve().parents[1]
ORACLE_SCRIPT = ROOT / "scripts" / "verify_relaxation_independent_oracle.py"
ORACLE_SCRIPT_RELATIVE = "scripts/verify_relaxation_independent_oracle.py"

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
        "material_representation",
        "material_payload_sha256",
        "active_mask_sha256",
        "realization_id",
        "direction_policy",
        "parity",
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
CASE_KEYS = frozenset(
    {
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
)
RUN_RECORD_KEYS = frozenset(
    {
        "workload_id",
        "mesh_level",
        "repetition",
        "command",
        "elapsed_s",
        "timeout_s",
        "timeout",
        "exit_code",
        "log_path",
        "log_sha256",
        "input_contract_path",
        "input_contract_sha256",
        "metadata_path",
        "metadata_sha256",
        "final_observables_path",
        "final_observables_sha256",
        "final_state_path",
        "final_state_sha256",
        "result",
        "initial_energy_j",
    }
)


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
    top_level = Path(_git(repo_root, "rev-parse", "--show-toplevel")).resolve()
    if top_level != repo_root.resolve():
        raise ValueError("source_root is not the Git worktree root")
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


def _validate_oracle_artifact(
    root: Path,
    document: Mapping[str, Any],
    *,
    algorithm: str,
    lane: str,
    precision: str,
    workload: str,
    cell: str,
    errors: list[str],
) -> None:
    if document.get("schema_version") != "fullmag.relaxation.oracle_artifact.v1":
        _add(errors, cell, "invalid=case.oracle.artifact.schema")
    if document.get("oracle") != ORACLE_IDENTITIES[algorithm]:
        _add(errors, cell, "invalid=case.oracle.artifact.oracle")
    if document.get("status") != "passed" or document.get("workload") != workload.rsplit(".", 1)[-1]:
        _add(errors, cell, "invalid=case.oracle.artifact.status_or_workload")

    independence = document.get("independence")
    if not isinstance(independence, Mapping):
        _add(errors, cell, "missing=case.oracle.artifact.independence")
    else:
        if independence.get("kind") != "standalone_python_oracle":
            _add(errors, cell, "invalid=case.oracle.artifact.independence.kind")
        if independence.get("implementation") != ORACLE_SCRIPT_RELATIVE:
            _add(errors, cell, "mismatch=case.oracle.artifact.independence.implementation")
        implementation_hash = independence.get("implementation_sha256")
        if not _is_sha256(implementation_hash):
            _add(errors, cell, "invalid=case.oracle.artifact.independence.implementation_sha256")
        elif not ORACLE_SCRIPT.is_file() or _sha256_file(ORACLE_SCRIPT) != implementation_hash:
            _add(errors, cell, "mismatch=case.oracle.artifact.independence.implementation_sha256")

    input_path = _safe_artifact_path(
        root,
        document.get("input_path"),
        "case.oracle.artifact.input_path",
        errors,
        cell,
    )
    input_hash = document.get("input_sha256")
    if not _is_sha256(input_hash):
        _add(errors, cell, "invalid=case.oracle.artifact.input_sha256")
    elif input_path is not None and _sha256_file(input_path) != input_hash:
        _add(errors, cell, "artifact_sha256_mismatch=case.oracle.artifact.input_path")
    input_document = _load_json(input_path) if input_path is not None else None
    if input_document is None:
        _add(errors, cell, "invalid=case.oracle.artifact.input")
    else:
        for key, expected in (
            ("schema_version", "fullmag.relaxation.oracle_input.v1"),
            ("oracle", ORACLE_IDENTITIES[algorithm]),
            ("algorithm", algorithm),
            ("lane", lane),
            ("precision", precision),
            ("workload", workload.rsplit(".", 1)[-1]),
        ):
            if input_document.get(key) != expected:
                _add(errors, cell, f"mismatch=case.oracle.artifact.input.{key}")

    measurement_count = document.get("measurement_count")
    comparisons = document.get("comparisons")
    if not isinstance(measurement_count, int) or measurement_count < 6 or not isinstance(comparisons, list) or len(comparisons) != measurement_count:
        _add(errors, cell, "invalid=case.oracle.comparisons")
        return
    input_measurements = input_document.get("measurements") if isinstance(input_document, Mapping) else None
    if not isinstance(input_measurements, list) or len(input_measurements) != measurement_count:
        _add(errors, cell, "invalid=case.oracle.input.measurements")
        input_measurements = []
    for index, comparison in enumerate(comparisons):
        if not isinstance(comparison, Mapping):
            _add(errors, cell, "invalid=case.oracle.comparison")
            continue
        if comparison.get("status") != "passed":
            _add(errors, cell, "status=case.oracle.comparison")
        for path_field, hash_field in (
            ("input_contract_path", "input_contract_sha256"),
            ("final_state_path", "final_state_sha256"),
        ):
            artifact = _safe_artifact_path(
                root,
                comparison.get(path_field),
                f"case.oracle.comparison.{path_field}",
                errors,
                cell,
            )
            digest = comparison.get(hash_field)
            if not _is_sha256(digest):
                _add(errors, cell, f"invalid=case.oracle.comparison.{hash_field}")
            elif artifact is not None and _sha256_file(artifact) != digest:
                _add(errors, cell, f"artifact_sha256_mismatch=case.oracle.comparison.{path_field}")
        for key in ("reference", "observed", "state_observed", "absolute_error", "tolerance"):
            value = comparison.get(key)
            if not isinstance(value, Mapping) or not value or any(
                not isinstance(item, (int, float))
                or not float(item) == float(item)
                or abs(float(item)) == float("inf")
                for item in value.values()
            ):
                _add(errors, cell, f"invalid=case.oracle.comparison.{key}")
        absolute_error = comparison.get("absolute_error")
        tolerance = comparison.get("tolerance")
        if isinstance(absolute_error, Mapping) and isinstance(tolerance, Mapping):
            for key, error in absolute_error.items():
                limit = tolerance.get(key)
                if not isinstance(limit, (int, float)) or float(error) > float(limit):
                    _add(errors, cell, f"oracle_error_exceeds_tolerance={key}")
        if index < len(input_measurements) and isinstance(input_measurements[index], Mapping):
            source = input_measurements[index]
            for key in (
                "input_contract_path",
                "input_contract_sha256",
                "final_state_path",
                "final_state_sha256",
            ):
                if comparison.get(key) != source.get(key):
                    _add(errors, cell, f"mismatch=case.oracle.comparison.{key}")


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
    runtime_manifest_path = _safe_artifact_path(
        root,
        process.get("runtime_manifest_path"),
        "execution.process.runtime_manifest_path",
        errors,
        cell,
    )
    executable: str | None = None
    if runtime_manifest_path is not None:
        runtime_manifest = _load_json(runtime_manifest_path)
        if runtime_manifest is None:
            _add(errors, cell, "invalid=execution.runtime_manifest_json")
        else:
            expected_runtime = LANE_POLICIES[receipt["lane"]]["runtime_identity"]
            for key, expected in (
                ("schema_version", "fullmag.relaxation.runtime_manifest.v1"),
                ("runtime_identity", expected_runtime),
                ("backend", LANE_POLICIES[receipt["lane"]]["backend"]),
                ("device", LANE_POLICIES[receipt["lane"]]["device"]),
                ("precision", receipt["precision"]),
                ("source_commit", receipt["source_commit"]),
                ("source_tree_sha256", receipt["source_tree_sha256"]),
            ):
                if runtime_manifest.get(key) != expected:
                    _add(errors, cell, f"mismatch=execution.runtime_manifest.{key}")
            if runtime_manifest.get("scenario") != "examples/relaxation_qualification_case.py":
                _add(errors, cell, "mismatch=execution.runtime_manifest.scenario")
            if not _is_sha256(runtime_manifest.get("scenario_sha256")):
                _add(errors, cell, "invalid=execution.runtime_manifest.scenario_sha256")
            executable = runtime_manifest.get("executable")
            if not isinstance(executable, str) or not executable:
                _add(errors, cell, "missing=execution.runtime_manifest.executable")
            if not _is_sha256(runtime_manifest.get("executable_sha256")):
                _add(errors, cell, "invalid=execution.runtime_manifest.executable_sha256")
            source_git_tree = runtime_manifest.get("source_git_tree")
            if not isinstance(source_git_tree, str) or not COMMIT_RE.fullmatch(source_git_tree):
                _add(errors, cell, "invalid=execution.runtime_manifest.source_git_tree")
            if receipt["lane"] != "fdm_cpu_reference":
                managed_manifest_hash = runtime_manifest.get("managed_bundle_manifest_sha256")
                if not _is_sha256(managed_manifest_hash):
                    _add(errors, cell, "invalid=execution.runtime_manifest.managed_bundle_manifest_sha256")
                build_identity = runtime_manifest.get("managed_bundle_build_identity")
                if not isinstance(build_identity, Mapping):
                    _add(errors, cell, "missing=execution.runtime_manifest.managed_bundle_build_identity")
                else:
                    if build_identity.get("git_commit") != receipt.get("source_commit"):
                        _add(errors, cell, "mismatch=execution.runtime_manifest.managed_bundle_build_identity.git_commit")
                    if build_identity.get("git_tree") != source_git_tree:
                        _add(errors, cell, "mismatch=execution.runtime_manifest.managed_bundle_build_identity.git_tree")
                    if build_identity.get("worktree_state") != "clean":
                        _add(errors, cell, "invalid=execution.runtime_manifest.managed_bundle_build_identity.worktree_state")
    log_path = _safe_artifact_path(
        root,
        process.get("log_path"),
        "execution.process.log_path",
        errors,
        cell,
    )
    if log_path is not None:
        log = _load_json(log_path)
        if log is None:
            _add(errors, cell, "invalid=execution.log_json")
        else:
            if log.get("schema_version") != "fullmag.relaxation.execution_log.v1":
                _add(errors, cell, "invalid=execution.log_schema")
            if log.get("status") != "passed" or log.get("exit_code") != 0:
                _add(errors, cell, "status=execution.log_failed")
            if log.get("command") != receipt.get("managed_command"):
                _add(errors, cell, "mismatch=execution.log_command")
            subprocesses = log.get("subprocesses")
            expected_workloads = set(
                canonical_workloads(receipt["algorithm"], receipt["lane"], receipt["precision"])
            )
            if not isinstance(subprocesses, list) or len(subprocesses) != 30:
                _add(errors, cell, "invalid=execution.log_subprocess_coverage")
            else:
                seen: set[tuple[object, object, object]] = set()
                for record in subprocesses:
                    _validate_run_record(
                        root,
                        record,
                        expected_workloads=expected_workloads,
                        cell=cell,
                        errors=errors,
                        measured_only=True,
                    )
                    if isinstance(record, Mapping):
                        command_text = record.get("command")
                        if isinstance(executable, str) and executable not in command_text:
                            _add(errors, cell, "mismatch=run_record.command.executable")
                        if "examples/relaxation_qualification_case.py" not in str(command_text):
                            _add(errors, cell, "mismatch=run_record.command.scenario")
                        identity = (
                            record.get("workload_id"),
                            record.get("mesh_level"),
                            record.get("repetition"),
                        )
                        if identity in seen:
                            _add(errors, cell, "duplicate=execution.log_subprocess")
                        seen.add(identity)
                expected_pairs = {
                    (workload, mesh, f"measured-{index:02d}")
                    for workload in expected_workloads
                    for mesh in ("coarse", "medium", "fine")
                    for index in range(1, 6)
                }
                if seen != expected_pairs:
                    _add(errors, cell, "invalid=execution.log_subprocess_coverage")


def _validate_run_record(
    root: Path,
    record: object,
    *,
    expected_workloads: set[str],
    cell: str,
    errors: list[str],
    measured_only: bool = False,
) -> None:
    if not isinstance(record, Mapping) or set(record) != RUN_RECORD_KEYS:
        _add(errors, cell, "invalid=run_record.fields")
        return
    workload = record.get("workload_id")
    if workload not in expected_workloads:
        _add(errors, cell, "invalid=run_record.workload")
    mesh = record.get("mesh_level")
    if mesh not in {"coarse", "medium", "fine"}:
        _add(errors, cell, "invalid=run_record.mesh")
    repetition = record.get("repetition")
    if not isinstance(repetition, str) or not re.fullmatch(r"(?:warmup|measured)-[0-9]{2}", repetition):
        _add(errors, cell, "invalid=run_record.repetition")
    elif measured_only and not repetition.startswith("measured-"):
        _add(errors, cell, "invalid=run_record.warmup_in_execution_log")
    timeout = record.get("timeout_s")
    elapsed = record.get("elapsed_s")
    if not isinstance(timeout, (int, float)) or not float(timeout) == float(timeout) or not 0 < float(timeout) <= 900.0:
        _add(errors, cell, "invalid=run_record.timeout_s")
    if not isinstance(elapsed, (int, float)) or not float(elapsed) == float(elapsed) or not 0 <= float(elapsed) <= float(timeout or 0):
        _add(errors, cell, "invalid=run_record.elapsed_s")
    if record.get("timeout") is not False or record.get("exit_code") != 0:
        _add(errors, cell, "invalid=run_record.process_status")
    if not isinstance(record.get("command"), str) or not record["command"]:
        _add(errors, cell, "invalid=run_record.command")
    result = record.get("result")
    if not isinstance(result, Mapping):
        _add(errors, cell, "invalid=run_record.result")
    else:
        if result.get("status") != "passed" or result.get("converged") is not True:
            _add(errors, cell, "invalid=run_record.result_status")
        if result.get("termination_reason") not in {"torque", "energy"}:
            _add(errors, cell, "invalid=run_record.result_reason")
        accepted_steps = result.get("accepted_steps")
        max_steps = result.get("max_steps")
        if not isinstance(accepted_steps, int) or not isinstance(max_steps, int) or not 0 <= accepted_steps < max_steps:
            _add(errors, cell, "invalid=run_record.result_step_bounds")
        metrics = result.get("metrics")
        if not isinstance(metrics, Mapping) or not metrics or any(
            not isinstance(value, (int, float))
            or not float(value) == float(value)
            or abs(float(value)) == float("inf")
            for value in metrics.values()
        ):
            _add(errors, cell, "invalid=run_record.result_metrics")
    if not isinstance(record.get("initial_energy_j"), (int, float)) or not float(record["initial_energy_j"]) == float(record["initial_energy_j"]):
        _add(errors, cell, "invalid=run_record.initial_energy")
    for path_field, hash_field in (
        ("log_path", "log_sha256"),
        ("input_contract_path", "input_contract_sha256"),
        ("metadata_path", "metadata_sha256"),
        ("final_observables_path", "final_observables_sha256"),
        ("final_state_path", "final_state_sha256"),
    ):
        raw_path = record.get(path_field)
        path = _safe_artifact_path(root, raw_path, f"run_record.{path_field}", errors, cell)
        digest = record.get(hash_field)
        if not _is_sha256(digest):
            _add(errors, cell, f"invalid=run_record.{hash_field}")
        elif path is not None and _sha256_file(path) != digest:
            _add(errors, cell, f"artifact_sha256_mismatch=run_record.{path_field}")


def _validate_cases(
    root: Path,
    receipt: Mapping[str, Any],
    algorithm: str,
    lane: str,
    precision: str,
    cell: str,
    errors: list[str],
) -> None:
    cases = receipt.get("cases")
    expected_workloads = canonical_workloads(algorithm, lane, precision)
    if not isinstance(cases, list) or len(cases) != len(expected_workloads):
        _add(errors, cell, "invalid=cases.coverage")
        return
    case_ids = [case.get("workload_id") if isinstance(case, Mapping) else None for case in cases]
    if case_ids != expected_workloads:
        _add(errors, cell, "invalid=cases.order_or_workload")
    for case in cases:
        if not isinstance(case, Mapping):
            _add(errors, cell, "invalid=case.object")
            continue
        if set(case) != CASE_KEYS:
            _add(errors, cell, "invalid=case.fields")
            continue
        workload = case.get("workload_id")
        if workload not in expected_workloads:
            _add(errors, cell, "invalid=case.workload")
        if case.get("algorithm") != algorithm or case.get("backend") != LANE_POLICIES[lane]["backend"]:
            _add(errors, cell, "mismatch=case.algorithm_backend")
        if case.get("device") != LANE_POLICIES[lane]["device"] or case.get("precision") != precision:
            _add(errors, cell, "mismatch=case.execution_scope")
        timeout = case.get("timeout_s")
        elapsed = case.get("elapsed_s")
        if not isinstance(timeout, (int, float)) or not float(timeout) == float(timeout) or not 0 < float(timeout) <= 900.0:
            _add(errors, cell, "invalid=case.timeout_s")
        if not isinstance(elapsed, (int, float)) or not float(elapsed) == float(elapsed) or not 0 <= float(elapsed) <= float(timeout or 0):
            _add(errors, cell, "invalid=case.elapsed_s")
        if case.get("status") != "passed" or case.get("skipped") is not False or case.get("fallback_occurred") is not False:
            _add(errors, cell, "invalid=case.status")
        completion = case.get("completion")
        if not isinstance(completion, Mapping) or completion.get("converged") is not True or completion.get("reason") not in {"torque", "energy"}:
            _add(errors, cell, "invalid=case.completion")
        accepted_steps = case.get("accepted_steps")
        max_steps = case.get("max_steps")
        if not isinstance(accepted_steps, int) or not isinstance(max_steps, int) or not 0 <= accepted_steps < max_steps:
            _add(errors, cell, "invalid=case.step_bounds")
        if not isinstance(case.get("metrics"), Mapping) or not case["metrics"] or any(
            not isinstance(value, (int, float)) or not float(value) == float(value) or abs(float(value)) == float("inf")
            for value in case["metrics"].values()
        ):
            _add(errors, cell, "invalid=case.metrics")
        oracle = case.get("oracle")
        if not isinstance(oracle, Mapping) or set(oracle) != {"kind", "id", "artifact_path", "artifact_sha256"} or {
            key: oracle.get(key) for key in ("kind", "id")
        } != ORACLE_IDENTITIES[algorithm]:
            _add(errors, cell, "invalid=case.oracle")
            continue
        oracle_path = _safe_artifact_path(root, oracle.get("artifact_path"), "case.oracle.artifact_path", errors, cell)
        if not _is_sha256(oracle.get("artifact_sha256")) or oracle_path is None or _sha256_file(oracle_path) != oracle.get("artifact_sha256"):
            _add(errors, cell, "invalid=case.oracle.artifact_sha256")
        else:
            oracle_document = _load_json(oracle_path)
            if oracle_document is None:
                _add(errors, cell, "invalid=case.oracle.artifact")
            else:
                _validate_oracle_artifact(
                    root,
                    oracle_document,
                    algorithm=algorithm,
                    lane=lane,
                    precision=precision,
                    workload=str(workload),
                    cell=cell,
                    errors=errors,
                )
        artifacts = case.get("artifacts")
        if not isinstance(artifacts, list) or not artifacts:
            _add(errors, cell, "missing=case.artifacts")
            continue
        for item in artifacts:
            if not isinstance(item, Mapping) or set(item) != {"path", "sha256"}:
                _add(errors, cell, "invalid=case.artifact_manifest")
                continue
            path = _safe_artifact_path(root, item.get("path"), "case.artifact.path", errors, cell)
            if path is None or not _is_sha256(item.get("sha256")) or _sha256_file(path) != item.get("sha256"):
                _add(errors, cell, "invalid=case.artifact_hash")
                continue
            document = _load_json(path)
            if document is None or document.get("schema_version") != "fullmag.relaxation.case_artifact.v1" or document.get("workload_id") != workload or document.get("status") != "passed":
                _add(errors, cell, "invalid=case.artifact")
            elif not isinstance(document.get("result"), Mapping) or document.get("run_count") != 18:
                _add(errors, cell, "invalid=case.artifact.completeness")
            else:
                run_records = document.get("run_records")
                if not isinstance(run_records, list) or len(run_records) != 18:
                    _add(errors, cell, "invalid=case.artifact.run_records")
                else:
                    seen: set[tuple[object, object, object]] = set()
                    for record in run_records:
                        _validate_run_record(
                            root,
                            record,
                            expected_workloads={str(workload)},
                            cell=cell,
                            errors=errors,
                        )
                        if isinstance(record, Mapping):
                            identity = (
                                record.get("workload_id"),
                                record.get("mesh_level"),
                                record.get("repetition"),
                            )
                            if identity in seen:
                                _add(errors, cell, "duplicate=case.artifact.run_record")
                            seen.add(identity)
                    expected_records = {
                        (workload, mesh, repetition)
                        for mesh in ("coarse", "medium", "fine")
                        for repetition in ("warmup-01", "measured-01", "measured-02", "measured-03", "measured-04", "measured-05")
                    }
                    if seen != expected_records:
                        _add(errors, cell, "invalid=case.artifact.run_record_coverage")


def _validate_parity(
    root: Path,
    scope: Mapping[str, Any],
    receipt: Mapping[str, Any],
    algorithm: str,
    lane: str,
    precision: str,
    cell: str,
    errors: list[str],
) -> None:
    value = scope.get("parity")
    expected = parity_scope(lane, precision)
    if expected["status"] == "not_applicable":
        if value != expected:
            _add(errors, cell, "invalid=scope.parity.not_applicable")
        return
    if not isinstance(value, Mapping):
        _add(errors, cell, "missing=scope.parity")
        return
    for key, expected_value in expected.items():
        if value.get(key) != expected_value:
            _add(errors, cell, f"mismatch=scope.parity.{key}")
    path = _safe_artifact_path(root, value.get("artifact_path"), "scope.parity.artifact_path", errors, cell)
    digest = value.get("artifact_sha256")
    if path is None or not _is_sha256(digest) or _sha256_file(path) != digest:
        _add(errors, cell, "invalid=scope.parity.artifact_sha256")
        return
    artifact = _load_json(path)
    if artifact is None:
        _add(errors, cell, "invalid=scope.parity.artifact")
        return
    if artifact.get("schema_version") != PARITY_SCHEMA or artifact.get("status") != "passed":
        _add(errors, cell, "invalid=scope.parity.artifact_schema")
    if artifact.get("target") != {"algorithm": algorithm, "lane": lane, "precision": precision}:
        _add(errors, cell, "mismatch=scope.parity.target")
    baseline = expected
    if artifact.get("baseline") != {"lane": baseline["baseline_lane"], "precision": baseline["baseline_precision"]}:
        _add(errors, cell, "mismatch=scope.parity.baseline")
    if artifact.get("source_commit") != receipt.get("source_commit"):
        _add(errors, cell, "mismatch=scope.parity.source_commit")
    if artifact.get("source_tree_sha256") != receipt.get("source_tree_sha256"):
        _add(errors, cell, "mismatch=scope.parity.source_tree_sha256")
    comparisons = artifact.get("comparisons")
    if not isinstance(comparisons, list) or len(comparisons) != 6:
        _add(errors, cell, "invalid=scope.parity.comparisons")
        return
    target_workloads = set(canonical_workloads(algorithm, lane, precision))
    baseline_workloads = set(
        canonical_workloads(algorithm, expected["baseline_lane"], expected["baseline_precision"])
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
        if not isinstance(comparison, Mapping) or comparison.get("status") != "passed":
            _add(errors, cell, "invalid=scope.parity.comparison")
            continue
        target_workload = comparison.get("target_workload_id")
        baseline_workload = comparison.get("baseline_workload_id")
        mesh_level = comparison.get("mesh_level")
        if (
            target_workload not in target_workloads
            or baseline_workload not in baseline_workloads
            or not isinstance(mesh_level, str)
            or (target_workload, baseline_workload, mesh_level) in observed_pairs
        ):
            _add(errors, cell, "invalid=scope.parity.workload_mesh")
        else:
            observed_pairs.add((target_workload, baseline_workload, mesh_level))
        for key in ("target_input_contract_sha256", "baseline_input_contract_sha256", "target_final_state_sha256", "baseline_final_state_sha256"):
            if not _is_sha256(comparison.get(key)):
                _add(errors, cell, f"invalid=scope.parity.{key}")
        for key in ("target_metrics", "baseline_metrics", "absolute_error", "tolerance"):
            value_map = comparison.get(key)
            if not isinstance(value_map, Mapping) or not value_map or any(
                not isinstance(item, (int, float)) or not float(item) == float(item) or abs(float(item)) == float("inf")
                for item in value_map.values()
            ):
                _add(errors, cell, f"invalid=scope.parity.{key}")
        target_observation = target_by_pair.get((target_workload, mesh_level))
        if not isinstance(target_observation, Mapping):
            _add(errors, cell, "missing=scope.parity.target_refinement_observation")
        else:
            if comparison.get("target_input_contract_sha256") != target_observation.get("input_contract_sha256"):
                _add(errors, cell, "mismatch=scope.parity.target_input_contract_sha256")
            final_states = target_observation.get("final_state_sha256")
            if not isinstance(final_states, list) or comparison.get("target_final_state_sha256") not in final_states:
                _add(errors, cell, "mismatch=scope.parity.target_final_state_sha256")
        target_metrics = comparison.get("target_metrics")
        baseline_metrics = comparison.get("baseline_metrics")
        absolute_error = comparison.get("absolute_error")
        tolerances = comparison.get("tolerance")
        if isinstance(target_metrics, Mapping) and set(target_metrics) != metric_names:
            _add(errors, cell, "invalid=scope.parity.target_metrics.keys")
        if isinstance(baseline_metrics, Mapping) and set(baseline_metrics) != metric_names:
            _add(errors, cell, "invalid=scope.parity.baseline_metrics.keys")
        if isinstance(absolute_error, Mapping) and isinstance(tolerances, Mapping):
            if set(absolute_error) != metric_names or set(tolerances) != metric_names:
                _add(errors, cell, "invalid=scope.parity.metric.keys")
            if isinstance(target_metrics, Mapping) and isinstance(baseline_metrics, Mapping):
                for name in metric_names:
                    if name not in absolute_error or name not in tolerances:
                        continue
                    expected_error = abs(float(target_metrics[name]) - float(baseline_metrics[name]))
                    declared_error = float(absolute_error[name])
                    tolerance = float(tolerances[name])
                    if tolerance < 0 or abs(declared_error - expected_error) > max(1e-30, expected_error * 1e-12):
                        _add(errors, cell, f"mismatch=scope.parity.absolute_error.{name}")
                    if expected_error > tolerance:
                        _add(errors, cell, f"parity_error_exceeds_tolerance={name}")
    expected_pairs = {
        (target, baseline, mesh)
        for target in target_workloads
        for baseline in baseline_workloads
        if target.rsplit(".", 1)[-1] == baseline.rsplit(".", 1)[-1]
        for mesh in ("coarse", "medium", "fine")
    }
    if observed_pairs != expected_pairs:
        _add(errors, cell, "invalid=scope.parity.workload_mesh_coverage")


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
    scope = receipt.get("validated_scope")
    if isinstance(scope, Mapping):
        for key in (
            "material_representation",
            "material_payload_sha256",
            "active_mask_sha256",
            "realization_id",
            "direction_policy",
        ):
            if document.get(key) != scope.get(key):
                _add(errors, cell, f"mismatch={level}.artifact_{key}")
        if document.get("mesh_refinement_observations") != scope.get("mesh_refinement"):
            _add(errors, cell, f"mismatch={level}.artifact_mesh_refinement_observations")
        if document.get("repeatability_observations") != scope.get("repeatability"):
            _add(errors, cell, f"mismatch={level}.artifact_repeatability_observations")
        if document.get("parity") != scope.get("parity"):
            _add(errors, cell, f"mismatch={level}.artifact_parity")
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


def _validate_scope_run_bindings(
    root: Path,
    receipt: Mapping[str, Any],
    scope: Mapping[str, Any],
    *,
    algorithm: str,
    lane: str,
    precision: str,
    cell: str,
    errors: list[str],
) -> None:
    cases = receipt.get("cases")
    records_by_pair: dict[tuple[str, str], list[Mapping[str, Any]]] = defaultdict(list)
    if not isinstance(cases, list):
        _add(errors, cell, "missing=scope.run_bindings.cases")
        return
    for case in cases:
        if not isinstance(case, Mapping):
            continue
        workload = case.get("workload_id")
        artifacts = case.get("artifacts")
        if not isinstance(workload, str) or not isinstance(artifacts, list):
            continue
        for manifest in artifacts:
            if not isinstance(manifest, Mapping):
                continue
            path = _safe_artifact_path(root, manifest.get("path"), "scope.run_bindings.case_artifact", errors, cell)
            if path is None:
                continue
            document = _load_json(path)
            run_records = document.get("run_records") if isinstance(document, Mapping) else None
            if not isinstance(run_records, list):
                continue
            for record in run_records:
                if isinstance(record, Mapping) and isinstance(record.get("mesh_level"), str):
                    records_by_pair[(workload, record["mesh_level"])].append(record)

    refinement = scope.get("mesh_refinement")
    repeatability = scope.get("repeatability")
    refinement_observations = refinement.get("observations") if isinstance(refinement, Mapping) else None
    repeatability_observations = repeatability.get("observations") if isinstance(repeatability, Mapping) else None
    if not isinstance(refinement_observations, list) or not isinstance(repeatability_observations, list):
        _add(errors, cell, "missing=scope.run_bindings.observations")
        return
    for observation in refinement_observations:
        if not isinstance(observation, Mapping):
            continue
        workload = observation.get("workload_id")
        mesh = observation.get("mesh_level")
        measured = [
            record
            for record in records_by_pair.get((workload, mesh), [])
            if str(record.get("repetition", "")).startswith("measured-")
        ]
        if len(measured) != 5:
            _add(errors, cell, "invalid=scope.mesh_refinement.run_binding_count")
            continue
        input_hashes = {record.get("input_contract_sha256") for record in measured}
        final_hashes = [record.get("final_state_sha256") for record in measured]
        if input_hashes != {observation.get("input_contract_sha256")}:
            _add(errors, cell, "mismatch=scope.mesh_refinement.input_contract_sha256")
        if final_hashes != observation.get("final_state_sha256"):
            _add(errors, cell, "mismatch=scope.mesh_refinement.final_state_sha256")
    for observation in repeatability_observations:
        if not isinstance(observation, Mapping):
            continue
        workload = observation.get("workload_id")
        mesh = observation.get("mesh_level")
        measured = [
            record
            for record in records_by_pair.get((workload, mesh), [])
            if str(record.get("repetition", "")).startswith("measured-")
        ]
        if len(measured) != 5:
            _add(errors, cell, "invalid=scope.repeatability.run_binding_count")
            continue
        if [record.get("log_path") for record in measured] != observation.get("run_log_paths"):
            _add(errors, cell, "mismatch=scope.repeatability.run_log_paths")
        if [record.get("final_state_sha256") for record in measured] != observation.get("final_state_sha256"):
            _add(errors, cell, "mismatch=scope.repeatability.final_state_sha256")


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
    }
    try:
        expected_values.update(
            canonical_binding(
                lane=lane,
                algorithm=algorithm,
                workload_ids=canonical_workloads(algorithm, lane, precision),
                mesh_levels=EXPECTED_MESH_REFINEMENT["levels"],
            )
        )
    except (TypeError, ValueError) as error:
        _add(errors, cell, f"invalid=scope.binding|{error}")
    for key in (
        "material_payload_sha256",
        "active_mask_sha256",
    ):
        value = scope.get(key)
        if key == "material_payload_sha256":
            valid_hashes = validate_sha256_mapping(value)
        else:
            valid_hashes = validate_sha256_mapping(value, nested=True)
        if key in scope and not valid_hashes:
            _add(errors, cell, f"invalid=scope.{key}")
    for key, expected in expected_values.items():
        if key not in scope:
            continue
        if scope.get(key) != expected:
            _add(errors, cell, f"mismatch=scope.{key}")
    workloads = canonical_workloads(algorithm, lane, precision)
    if not validate_mesh_refinement(scope.get("mesh_refinement"), workloads):
        _add(errors, cell, "invalid=scope.mesh_refinement.observations")
    if not validate_repeatability(scope.get("repeatability"), workloads):
        _add(errors, cell, "invalid=scope.repeatability.observations")
    _validate_parity(root, scope, receipt, algorithm, lane, precision, cell, errors)
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
    _validate_scope_run_bindings(
        root,
        receipt,
        scope,
        algorithm=algorithm,
        lane=lane,
        precision=precision,
        cell=cell,
        errors=errors,
    )
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
        expected_command = f"just {CANONICAL_RECIPE_BY_LANE[lane]}"
        if receipt["managed_command"] != expected_command:
            _add(errors, cell, "mismatch=managed_command.canonical_recipe")
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
    _validate_cases(root, receipt, algorithm, lane, precision, cell, errors)
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

    ``expected_identity`` and a clean ``source_root`` are mandatory for a
    qualified result.  The expected identity must name the source commit,
    source tree digest, and recipe digest for every lane; the orchestrator
    never chooses the first receipt or an offline caller as its trust anchor.
    """

    root = artifact_root.resolve()
    errors: list[str] = []
    normalized_expected = _validate_expected_identity(expected_identity, errors)
    live_source_identity: tuple[str, str] | None = None
    live_recipe_sha256: dict[str, str] = {}
    if source_root is None:
        _add(errors, None, "missing=source_root")
    else:
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
        "--source-root",
        type=Path,
        help="live source tree to verify; qualification recipes should always provide this",
    )
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
        source_root=args.source_root.resolve() if args.source_root is not None else None,
    )
    print(f"{MATRIX_ID} {result['status'].upper()}")
    print(f"manifest={args.output} checksum_sha256={result['checksum_sha256']}")
    for item in result["missing_evidence"]:
        print(f"- {item}")
    return 0 if result["status"] == "qualified" else 1


if __name__ == "__main__":
    raise SystemExit(main())
