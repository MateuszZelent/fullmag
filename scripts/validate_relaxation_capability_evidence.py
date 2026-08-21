#!/usr/bin/env python3
"""Fail closed validation for promoted relaxation capability lanes."""

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
    "relaxation_production_matrix_for_capability",
    Path(__file__).with_name("verify_relaxation_production_matrix.py"),
)
if _MATRIX_SPEC is None or _MATRIX_SPEC.loader is None:  # pragma: no cover - import machinery failure
    raise RuntimeError("cannot load the canonical relaxation production matrix validator")
PRODUCTION_MATRIX = importlib.util.module_from_spec(_MATRIX_SPEC)
_MATRIX_SPEC.loader.exec_module(PRODUCTION_MATRIX)

try:
    from scripts.relaxation_qualification_contract import (
        RECEIPT_SCHEMA,
        PARITY_SCHEMA,
        canonical_binding,
        parity_scope,
        validate_mesh_refinement,
        validate_repeatability,
        validate_sha256_mapping,
    )
except ModuleNotFoundError:  # direct ``python scripts/<script>.py`` execution
    from relaxation_qualification_contract import (  # type: ignore[no-redef]
        RECEIPT_SCHEMA,
        PARITY_SCHEMA,
        canonical_binding,
        parity_scope,
        validate_mesh_refinement,
        validate_repeatability,
        validate_sha256_mapping,
    )

ARTIFACT_SCHEMA = "fullmag.relaxation.qualification_artifact.v1"
PROMOTED_STATUSES = {
    "production_executable",
    "partial_production_executable",
    "validated",
}
CANONICAL_FEATURES = {
    "relaxation_llg_overdamped": "llg_overdamped",
    "relaxation_projected_gradient_bb": "projected_gradient_bb",
    "relaxation_nonlinear_cg": "nonlinear_cg",
    "relaxation_tangent_plane_implicit": "tangent_plane_implicit",
}
CANONICAL_LANES = {
    "fdm_cpu_reference": {
        "backend": "fdm",
        "device": "cpu",
        "precisions": frozenset({"fp64"}),
    },
    "fdm_gpu_production": {
        "backend": "fdm",
        "device": "cuda",
        "precisions": frozenset({"fp32", "fp64"}),
    },
    "fem_cpu_public": {
        "backend": "fem",
        "device": "cpu",
        "precisions": frozenset({"fp64"}),
    },
    "fem_gpu_public": {
        "backend": "fem",
        "device": "gpu",
        "precisions": frozenset({"fp64"}),
    },
}
RUNTIME_IDENTITIES = {
    "fdm_cpu_reference": {"kind": "reference_process", "id": "fdm_cpu_reference"},
    "fdm_gpu_production": {"kind": "managed_container", "id": "fdm_cuda_runtime"},
    "fem_cpu_public": {"kind": "managed_container", "id": "fem_cpu_runtime"},
    "fem_gpu_public": {"kind": "managed_container", "id": "fem_gpu_host"},
}
ORACLE_IDENTITIES = {
    "llg_overdamped": {"kind": "independent_reference", "id": "fem_llg_reference.v1"},
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
EVIDENCE_LEVELS = ("D4", "D5", "D6")
RELAXATION_EVIDENCE_FIELDS = frozenset(
    {
        "qualification_receipts",
        "qualification_requirements",
        "validated_scope",
        "solver_audit_gate",
        "source_commit",
        "source_tree_sha256",
    }
)
RELAXATION_ID_MARKERS = (
    "relaxation",
    "llg_overdamped",
    "projected_gradient_bb",
    "pgbb",
    "nonlinear_cg",
    "tangent_plane_implicit",
    "tpi",
)
MANAGED_RECIPE_ALLOWLIST = {
    "verify-fem-relaxation-production-benchmark": {
        "backend": "fem",
        "algorithms": frozenset(
            {"llg_overdamped", "projected_gradient_bb", "nonlinear_cg"}
        ),
        # This digest is bound to the canonical recipe body in the repository.
        "recipe_sha256": "27fc9211a3a75be07c0085dd2a9f01768dc8dd09688c7bdcb9d559ddd3c99e0e",
        "required_markers": (
            "just ensure-managed-fem-runtime",
            "docker compose --profile fem-gpu run",
        ),
    },
    "verify-fdm-relaxation-qualification-release": {
        "backend": "fdm",
        "algorithms": frozenset(
            {"llg_overdamped", "projected_gradient_bb", "nonlinear_cg"}
        ),
        "recipe_sha256": "11e5e0e44a73a932a6e088cf1191c5a9a51e2cde468f6e8e5e72f495daa08248",
        "required_markers": ("scripts/run_relaxation_qualification_lane.py",),
    },
    "verify-fdm-relaxation-qualification-cuda-release": {
        "backend": "fdm",
        "algorithms": frozenset(
            {"llg_overdamped", "projected_gradient_bb", "nonlinear_cg"}
        ),
        "recipe_sha256": "4eeb91b7628a58fe89fb4dbc865635a60d848fc3a1aafc56ffdbca1d82d1b797",
        "required_markers": (
            "just ensure-managed-fem-runtime",
            "docker compose --profile fem-gpu run",
            "--lane fdm_gpu_production",
        ),
    },
    "verify-fem-relaxation-qualification-release": {
        "backend": "fem",
        "algorithms": frozenset(
            {"llg_overdamped", "projected_gradient_bb", "nonlinear_cg", "tangent_plane_implicit"}
        ),
        "recipe_sha256": "d0b001ce9e0a68106ce9be56df832e38ac0359001ac9779624960a7f19332fb4",
        "required_markers": (
            "just verify-fem-relaxation-source-contract",
            "docker compose --profile fem-gpu run",
            "--lane fem_cpu_public",
        ),
    },
    "verify-fem-relaxation-qualification-cuda-release": {
        "backend": "fem",
        "algorithms": frozenset(
            {"llg_overdamped", "projected_gradient_bb", "nonlinear_cg"}
        ),
        "recipe_sha256": "8bde0bb019a58959e1d48ffb1ffbed2311c4d706c1dabd48feb13cca58c320f5",
        "required_markers": (
            "just verify-fem-relaxation-source-contract",
            "docker compose --profile fem-gpu run",
            "--lane fem_gpu_public",
        ),
    },
}
RELAXATION_LABEL = re.compile(r"^Relaxation\(([^()]+)\)$")
RELAXATION_LIKE_LABEL = re.compile(r"^Relaxation\([^()]+\)$", re.IGNORECASE)
RECIPE_HEADER = re.compile(r"^([A-Za-z0-9_-]+)(?:\s+[^:]*)?:\s*(?:#.*)?$")


class EvidenceError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise EvidenceError(message)


def is_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def git_output(repo_root: Path, *arguments: str, text: bool = True) -> str | bytes:
    try:
        return subprocess.check_output(
            ["git", *arguments],
            cwd=repo_root,
            text=text,
            stderr=subprocess.STDOUT,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        detail = getattr(error, "output", None)
        if isinstance(detail, bytes):
            detail = detail.decode("utf-8", errors="replace")
        raise EvidenceError(
            f"cannot inspect source repository: {str(detail or error).strip()}"
        ) from error


def gitlinks(repo_root: Path) -> list[dict[str, str]]:
    raw = git_output(repo_root, "ls-files", "-s", "-z", text=False)
    assert isinstance(raw, bytes)
    entries: list[dict[str, str]] = []
    for record in raw.split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, object_id, stage = metadata.decode("ascii").split()
        if mode != "160000" or stage != "0":
            continue
        path = raw_path.decode("utf-8", errors="strict")
        nested = repo_root / path
        require(nested.is_dir(), f"nested gitlink {path} is missing")
        nested_head = str(git_output(nested, "rev-parse", "HEAD")).strip()
        require(
            nested_head == object_id,
            f"nested gitlink {path} HEAD differs from the indexed commit",
        )
        nested_status = str(
            git_output(
                nested,
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
                "--ignore-submodules=none",
            )
        )
        require(not nested_status, f"nested gitlink {path} source is dirty or untracked")
        entries.append({"path": path, "commit": object_id})
    return sorted(entries, key=lambda entry: entry["path"])


def source_identity(repo_root: Path) -> tuple[str, str]:
    root = Path(str(git_output(repo_root, "rev-parse", "--show-toplevel")).strip()).resolve()
    require(root == repo_root.resolve(), "repo_root is not the Git worktree root")
    index_flags = str(git_output(repo_root, "ls-files", "-v"))
    flagged = [line for line in index_flags.splitlines() if line and line[0] in {"h", "s", "S"}]
    require(
        not flagged,
        "qualification source has assume-unchanged or skip-worktree index drift",
    )
    status = str(
        git_output(
            repo_root,
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--ignore-submodules=none",
        )
    )
    require(not status, "qualification source is not clean: tracked, untracked, or nested changes exist")
    commit = str(git_output(repo_root, "rev-parse", "HEAD")).strip()
    tree = str(git_output(repo_root, "rev-parse", "HEAD^{tree}")).strip()
    require(bool(re.fullmatch(r"[0-9a-f]{40}", commit)), "current source_commit is invalid")
    require(bool(re.fullmatch(r"[0-9a-f]{40}", tree)), "current source tree is invalid")
    identity = {
        "source_commit": commit,
        "source_tree": tree,
        "nested_gitlinks": gitlinks(repo_root),
    }
    canonical = json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return commit, hashlib.sha256(canonical).hexdigest()


def repository_path(repo_root: Path, raw_path: object, field: str) -> Path:
    require(isinstance(raw_path, str) and raw_path, f"{field} is required")
    relative = Path(raw_path)
    require(not relative.is_absolute(), f"{field} must be repository-relative")
    reports_root = (repo_root / ".fullmag" / "reports").resolve()
    resolved = (repo_root / relative).resolve()
    require(resolved.is_relative_to(reports_root), f"{field} must stay under .fullmag/reports")
    return resolved


def read_receipt(path: Path) -> Mapping[str, Any]:
    require(path.is_file(), "existing receipt is required")
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise EvidenceError(f"receipt is not valid JSON: {error}") from error
    require(isinstance(receipt, dict), "receipt root must be an object")
    return receipt


def recipe_body(justfile: Path, recipe: str) -> str:
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
        return "\n".join(body)
    raise EvidenceError(f"allowlisted managed recipe {recipe} does not exist in justfile")


def canonical_recipe_body(body: str) -> str:
    return "\n".join(line.rstrip() for line in body.splitlines()).strip("\n") + "\n"


def validate_managed_command(
    command: object, repo_root: Path, backend: str, algorithm: str
) -> None:
    require(isinstance(command, str) and command, "receipt managed_command is required")
    try:
        tokens = shlex.split(command)
    except ValueError as error:
        raise EvidenceError(f"receipt managed_command is invalid: {error}") from error
    require(
        len(tokens) == 2 and tokens[0] == "just",
        "receipt managed_command must name exactly one allowlisted just recipe",
    )
    recipe = tokens[1]
    policy = MANAGED_RECIPE_ALLOWLIST.get(recipe)
    require(policy is not None, f"managed_command recipe {recipe} is not allowlisted")
    require(policy["backend"] == backend, "managed_command recipe backend does not match lane")
    require(
        algorithm in policy["algorithms"],
        f"allowlisted recipe {recipe} does not execute algorithm {algorithm}",
    )
    body = recipe_body(repo_root / "justfile", recipe)
    actual_recipe_sha256 = hashlib.sha256(
        canonical_recipe_body(body).encode("utf-8")
    ).hexdigest()
    require(
        actual_recipe_sha256 == policy["recipe_sha256"],
        f"allowlisted recipe {recipe} does not match its canonical recipe body",
    )
    markers = policy["required_markers"]
    active_lines = [
        line.strip()
        for line in body.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    require(
        all(any(line.startswith(marker) for line in active_lines) for marker in markers),
        f"allowlisted recipe {recipe} does not use the required managed/container runtime",
    )


def canonical_algorithm(feature: Mapping[str, Any]) -> str | None:
    feature_id = feature.get("id")
    label = feature.get("label")
    require(isinstance(feature_id, str), "feature id is required")
    expected = CANONICAL_FEATURES.get(feature_id)
    if expected is None:
        label_match = (
            RELAXATION_LIKE_LABEL.fullmatch(label)
            if isinstance(label, str)
            else None
        )
        if label_match is not None:
            raise EvidenceError(
                f"{feature_id} uses Relaxation(*) label without a canonical relaxation feature id"
            )
        normalized_id = feature_id.lower().replace("-", "_")
        id_like = any(marker in normalized_id for marker in RELAXATION_ID_MARKERS)
        evidence_like = bool(RELAXATION_EVIDENCE_FIELDS.intersection(feature))
        require(
            not id_like and not evidence_like,
            f"{feature_id} is an unknown relaxation-like feature row",
        )
        return None
    require(isinstance(label, str), f"{feature_id} label is required")
    label_match = RELAXATION_LABEL.fullmatch(label)
    require(
        label_match is not None and label_match.group(1) == expected,
        f"{feature_id} label does not match canonical relaxation algorithm {expected}",
    )
    return expected


def promoted_lanes(feature: Mapping[str, Any]) -> list[str]:
    lanes = feature.get("lanes")
    require(isinstance(lanes, dict), f"{feature.get('id')} lanes must be an object")
    for lane in lanes:
        require(lane in CANONICAL_LANES, f"unknown relaxation lane {lane}")
    promoted = [lane for lane, status in lanes.items() if status in PROMOTED_STATUSES]
    require(
        feature.get("validation_state") != "validated" or promoted,
        f"{feature.get('id')} validated state requires a promoted lane",
    )
    return promoted


def canonical_workloads(lane: str, algorithm: str) -> list[str]:
    require(lane in CANONICAL_LANES, f"unknown relaxation lane {lane}")
    require(algorithm in ORACLE_IDENTITIES, f"unknown relaxation algorithm {algorithm}")
    return [
        f"{lane}.{algorithm}.macrospin",
        f"{lane}.{algorithm}.exchange_demag",
    ]


def _load_json(path: Path) -> Mapping[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, Mapping) else None


def _finite_metrics(value: object) -> bool:
    return isinstance(value, Mapping) and bool(value) and all(
        isinstance(item, (int, float))
        and not isinstance(item, bool)
        and math.isfinite(float(item))
        for item in value.values()
    )


def _validate_semantic_artifact(
    path: Path,
    *,
    level: str,
    receipt: Mapping[str, Any],
    algorithm: str,
    lane: str,
    workloads: list[str],
) -> None:
    document = _load_json(path)
    require(document is not None, f"{level} artifact must be JSON")
    require(
        document.get("schema_version") == ARTIFACT_SCHEMA,
        f"{level} artifact schema is invalid",
    )
    require(document.get("level") == level, f"{level} artifact level is invalid")
    require(
        document.get("cell")
        == {
            "algorithm": algorithm,
            "lane": lane,
            "precision": receipt.get("precision"),
        },
        f"{level} artifact cell mismatch",
    )
    require(document.get("workload_ids") == workloads, f"{level} artifact workloads mismatch")
    require(
        document.get("source_commit") == receipt.get("source_commit"),
        f"{level} artifact source commit mismatch",
    )
    require(
        document.get("source_tree_sha256") == receipt.get("source_tree_sha256"),
        f"{level} artifact source tree mismatch",
    )
    require(
        document.get("runtime_identity") == RUNTIME_IDENTITIES[lane],
        f"{level} artifact runtime mismatch",
    )
    require(
        document.get("oracle") == ORACLE_IDENTITIES[algorithm],
        f"{level} artifact oracle mismatch",
    )
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
        document.get("parity") == scope.get("parity"),
        f"{level} artifact parity mismatch",
    )
    require(
        document.get("mesh_refinement_observations") == scope.get("mesh_refinement"),
        f"{level} artifact mesh refinement observations mismatch",
    )
    require(
        document.get("repeatability_observations") == scope.get("repeatability"),
        f"{level} artifact repeatability observations mismatch",
    )
    result = document.get("result")
    require(isinstance(result, Mapping), f"{level} artifact result is required")
    require(
        result.get("status") == "passed" and result.get("converged") is True,
        f"{level} artifact did not converge",
    )
    require(
        result.get("termination_reason") in {"torque", "energy"},
        f"{level} artifact termination reason is invalid",
    )
    accepted_steps = result.get("accepted_steps")
    max_steps = result.get("max_steps")
    require(
        isinstance(accepted_steps, int)
        and not isinstance(accepted_steps, bool)
        and isinstance(max_steps, int)
        and not isinstance(max_steps, bool)
        and max_steps > 0
        and accepted_steps < max_steps,
        f"{level} artifact step bounds are invalid",
    )
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
    require(isinstance(value, dict), "validated_scope parity is required")
    for key, expected_value in expected.items():
        require(value.get(key) == expected_value, f"validated_scope parity {key} is not canonical")
    artifact = repository_path(repo_root, value.get("artifact_path"), "parity artifact_path")
    require(is_sha256(value.get("artifact_sha256")), "parity artifact_sha256 is invalid")
    require(value["artifact_sha256"] == hashlib.sha256(artifact.read_bytes()).hexdigest(), "parity artifact hash mismatch")
    document = _load_json(artifact)
    require(document is not None, "parity artifact must be JSON")
    require(document.get("schema_version") == PARITY_SCHEMA, "parity artifact schema is invalid")
    require(document.get("status") == "passed", "parity artifact did not pass")
    require(document.get("target") == {"algorithm": algorithm, "lane": lane, "precision": precision}, "parity target mismatch")
    require(document.get("baseline") == {"lane": expected["baseline_lane"], "precision": expected["baseline_precision"]}, "parity baseline mismatch")
    require(document.get("source_commit") == receipt.get("source_commit"), "parity source commit mismatch")
    require(document.get("source_tree_sha256") == receipt.get("source_tree_sha256"), "parity source tree mismatch")
    comparisons = document.get("comparisons")
    require(isinstance(comparisons, list) and len(comparisons) == 6, "parity comparisons are incomplete")
    target_workloads = set(canonical_workloads(lane, algorithm))
    baseline_workloads = set(
        canonical_workloads(expected["baseline_lane"], algorithm)
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
        for key in ("target_input_contract_sha256", "baseline_input_contract_sha256", "target_final_state_sha256", "baseline_final_state_sha256"):
            require(is_sha256(comparison.get(key)), f"parity {key} is invalid")
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


def _validate_execution_evidence(
    receipt: Mapping[str, Any],
    repo_root: Path,
    *,
    algorithm: str,
    lane: str,
) -> None:
    execution = receipt.get("execution")
    require(isinstance(execution, Mapping) and set(execution) == EXECUTION_KEYS, "receipt execution evidence is missing or non-canonical")
    require(execution.get("status") == "passed" and execution.get("converged") is True, "receipt execution did not converge")
    require(execution.get("termination_reason") in {"torque", "energy"}, "receipt execution termination reason is invalid")
    for key in ("timeout", "max_steps_reached", "non_converged", "fallback_occurred"):
        require(execution.get(key) is False, f"receipt execution.{key} cannot qualify")
    accepted_steps = execution.get("accepted_steps")
    max_steps = execution.get("max_steps")
    require(isinstance(accepted_steps, int) and isinstance(max_steps, int) and 0 <= accepted_steps < max_steps, "receipt execution step bounds are invalid")
    require(_finite_metrics(execution.get("metrics")), "receipt execution metrics are invalid")
    confirmation = execution.get("confirmation")
    require(isinstance(confirmation, Mapping), "receipt execution confirmation is missing")
    require(isinstance(confirmation.get("accepted_state_id"), str) and confirmation["accepted_state_id"], "receipt execution accepted state is missing")
    require(confirmation.get("observed_after_accepted_step") is True, "receipt execution lacks post-step observation")
    process = execution.get("process")
    require(isinstance(process, Mapping), "receipt execution process is missing")
    required_process = {
        "command",
        "command_sha256",
        "runtime_manifest_path",
        "runtime_manifest_sha256",
        "log_path",
        "log_sha256",
        "exit_code",
    }
    require(set(process) == required_process, "receipt execution process is non-canonical")
    command = receipt.get("managed_command")
    require(process.get("command") == command, "receipt execution process command mismatch")
    require(is_sha256(process.get("command_sha256")) and process["command_sha256"] == hashlib.sha256(str(command).encode("utf-8")).hexdigest(), "receipt execution command hash mismatch")
    for path_field in ("runtime_manifest_path", "log_path"):
        path = repository_path(repo_root, process.get(path_field), f"execution.process.{path_field}")
        digest_field = path_field.replace("_path", "_sha256")
        require(is_sha256(process.get(digest_field)) and hashlib.sha256(path.read_bytes()).hexdigest() == process[digest_field], f"receipt execution {path_field} hash mismatch")
    require(process.get("exit_code") == 0, "receipt execution process failed")
    runtime_manifest = _load_json(repository_path(repo_root, process["runtime_manifest_path"], "runtime_manifest_path"))
    require(runtime_manifest is not None, "receipt runtime manifest must be JSON")
    for key, expected in (
        ("schema_version", "fullmag.relaxation.runtime_manifest.v1"),
        ("runtime_identity", RUNTIME_IDENTITIES[lane]),
        ("backend", CANONICAL_LANES[lane]["backend"]),
        ("device", CANONICAL_LANES[lane]["device"]),
        ("source_commit", receipt.get("source_commit")),
        ("source_tree_sha256", receipt.get("source_tree_sha256")),
        ("scenario", "examples/relaxation_qualification_case.py"),
    ):
        require(runtime_manifest.get(key) == expected, f"receipt runtime manifest {key} mismatch")
    require(runtime_manifest.get("precision") == receipt.get("precision"), "receipt runtime manifest precision mismatch")
    require(is_sha256(runtime_manifest.get("scenario_sha256")), "receipt runtime manifest scenario hash is invalid")
    require(is_sha256(runtime_manifest.get("executable_sha256")) and isinstance(runtime_manifest.get("executable"), str) and runtime_manifest["executable"], "receipt runtime manifest executable identity is invalid")
    source_git_tree = runtime_manifest.get("source_git_tree")
    require(isinstance(source_git_tree, str) and re.fullmatch(r"[0-9a-f]{40}", source_git_tree) is not None, "receipt runtime manifest source git tree is invalid")
    if lane != "fdm_cpu_reference":
        require(is_sha256(runtime_manifest.get("managed_bundle_manifest_sha256")), "receipt managed runtime manifest hash is invalid")
        build_identity = runtime_manifest.get("managed_bundle_build_identity")
        require(isinstance(build_identity, Mapping), "receipt managed runtime build identity is missing")
        require(build_identity.get("git_commit") == receipt.get("source_commit"), "receipt managed runtime commit mismatch")
        require(build_identity.get("git_tree") == source_git_tree, "receipt managed runtime tree mismatch")
        require(build_identity.get("worktree_state") == "clean", "receipt managed runtime was built from dirty source")
    log = _load_json(repository_path(repo_root, process["log_path"], "log_path"))
    require(log is not None, "receipt execution log must be JSON")
    require(log.get("schema_version") == "fullmag.relaxation.execution_log.v1", "receipt execution log schema is invalid")
    require(log.get("status") == "passed" and log.get("exit_code") == 0, "receipt execution log did not pass")
    require(log.get("command") == command, "receipt execution log command mismatch")


def validate_workloads(
    feature_id: str, workloads: object, algorithm: str, promoted_lanes: list[str]
) -> list[str]:
    require(
        isinstance(workloads, list)
        and workloads
        and all(isinstance(workload, str) and workload for workload in workloads),
        f"{feature_id} promoted relaxation requires non-empty validated_workloads",
    )
    require(
        len(workloads) == len(set(workloads)),
        f"{feature_id} validated_workloads must be unique",
    )
    expected = [
        workload
        for lane in CANONICAL_LANES
        if lane in promoted_lanes
        for workload in canonical_workloads(lane, algorithm)
    ]
    require(
        workloads == expected,
        f"{feature_id} validated_workloads must equal the canonical lane/algorithm workloads",
    )
    return workloads


def validate_receipt(
    receipt: Mapping[str, Any],
    repo_root: Path,
    *,
    feature_id: str,
    algorithm: str,
    lane: str,
    workloads: list[str],
    source_commit: str,
    source_tree_sha256: str,
) -> None:
    lane_policy = CANONICAL_LANES[lane]
    require(receipt.get("schema_version") == RECEIPT_SCHEMA, "receipt schema_version is invalid")
    require(receipt.get("status") == "passed", "receipt status must be passed")
    require(receipt.get("feature_id") == feature_id, "receipt feature_id does not match capability")
    require(receipt.get("algorithm") == algorithm, "receipt algorithm does not match capability")
    require(receipt.get("lane") == lane, "receipt lane does not match promoted lane")
    require(receipt.get("backend") == lane_policy["backend"], "receipt backend does not match canonical lane")
    require(receipt.get("device") == lane_policy["device"], "receipt device does not match canonical lane")
    require(
        receipt.get("precision") in lane_policy["precisions"],
        "receipt precision is not legal for canonical lane",
    )
    require(receipt.get("source_clean") is True, "receipt source_clean must be true")
    require(receipt.get("source_commit") == source_commit, "receipt source_commit is stale")
    require(
        receipt.get("source_tree_sha256") == source_tree_sha256,
        "receipt source_tree_sha256 is stale",
    )
    artifact = repository_path(repo_root, receipt.get("artifact_path"), "artifact_path")
    require(artifact.is_file(), "qualification artifact does not exist")
    require(is_sha256(receipt.get("artifact_sha256")), "receipt artifact_sha256 is invalid")
    require(
        receipt["artifact_sha256"] == hashlib.sha256(artifact.read_bytes()).hexdigest(),
        "receipt artifact_sha256 does not match qualification artifact",
    )
    validate_managed_command(
        receipt.get("managed_command"),
        repo_root,
        str(lane_policy["backend"]),
        algorithm,
    )
    scope = receipt.get("validated_scope")
    require(isinstance(scope, dict), "receipt validated_scope must be an object")
    require(
        set(scope) == SCOPE_KEYS,
        "receipt validated_scope does not have the canonical qualification scope",
    )
    require(scope.get("feature_id") == feature_id, "validated_scope feature_id does not match")
    require(scope.get("algorithm") == algorithm, "validated_scope algorithm does not match")
    require(scope.get("lane") == lane, "validated_scope lane does not match")
    require(scope.get("backend") == lane_policy["backend"], "validated_scope backend does not match")
    require(scope.get("device") == lane_policy["device"], "validated_scope device does not match")
    require(scope.get("precision") == receipt.get("precision"), "validated_scope precision does not match")
    require(
        scope.get("runtime_identity") == RUNTIME_IDENTITIES[lane],
        "validated_scope runtime_identity does not match canonical lane",
    )
    scoped_workloads = scope.get("validated_workloads")
    require(
        isinstance(scoped_workloads, list)
        and len(scoped_workloads) == len(set(scoped_workloads))
        and scoped_workloads == workloads,
        "validated_scope.validated_workloads must equal the canonical lane/algorithm workloads",
    )
    require(
        scope.get("oracle") == ORACLE_IDENTITIES[algorithm],
        "validated_scope oracle does not match canonical algorithm",
    )
    require(
        validate_mesh_refinement(scope.get("mesh_refinement"), workloads),
        "validated_scope mesh_refinement observations are incomplete or non-canonical",
    )
    require(
        validate_repeatability(scope.get("repeatability"), workloads),
        "validated_scope repeatability observations are incomplete or non-canonical",
    )
    binding = canonical_binding(
        lane=lane,
        algorithm=algorithm,
        workload_ids=workloads,
        mesh_levels=("coarse", "medium", "fine"),
    )
    for key, value in binding.items():
        require(scope.get(key) == value, f"validated_scope {key} is not canonical")
    require(
        validate_sha256_mapping(scope.get("material_payload_sha256")),
        "validated_scope material_payload_sha256 is invalid",
    )
    require(
        validate_sha256_mapping(scope.get("active_mask_sha256"), nested=True),
        "validated_scope active_mask_sha256 is invalid",
    )
    _validate_parity(
        scope,
        receipt,
        repo_root,
        algorithm=algorithm,
        lane=lane,
        precision=str(receipt.get("precision")),
    )
    _validate_execution_evidence(
        receipt,
        repo_root,
        algorithm=algorithm,
        lane=lane,
    )
    evidence = scope.get("evidence")
    require(
        isinstance(evidence, dict) and set(evidence) == set(EVIDENCE_LEVELS),
        "validated_scope evidence must contain D4, D5 and D6",
    )
    manifest_paths: set[str] = set()
    for level in EVIDENCE_LEVELS:
        level_evidence = evidence[level]
        require(
            isinstance(level_evidence, dict)
            and set(level_evidence) == {"status", "artifact_manifest"}
            and level_evidence.get("status") == "passed",
            f"validated_scope {level} evidence is not passed",
        )
        manifest = level_evidence["artifact_manifest"]
        require(isinstance(manifest, list) and manifest, f"validated_scope {level} artifact_manifest is required")
        for item in manifest:
            require(
                isinstance(item, dict)
                and set(item) == {"path", "sha256"}
                and is_sha256(item.get("sha256")),
                f"validated_scope {level} artifact_manifest entry is invalid",
            )
            artifact_path = repository_path(repo_root, item["path"], f"{level}.artifact_manifest.path")
            require(artifact_path.is_file(), f"validated_scope {level} artifact does not exist")
            require(
                hashlib.sha256(artifact_path.read_bytes()).hexdigest() == item["sha256"],
                f"validated_scope {level} artifact_manifest sha256 mismatch",
            )
            _validate_semantic_artifact(
                artifact_path,
                level=level,
                receipt=receipt,
                algorithm=algorithm,
                lane=lane,
                workloads=workloads,
            )
            manifest_paths.add(str(item["path"]))
    require(
        receipt.get("artifact_path") in manifest_paths,
        "receipt artifact is missing from the D4/D5/D6 artifact manifest",
    )
    require(
        receipt.get("solver_audit_gate") == "passed",
        "receipt solver_audit_gate must be passed",
    )


def validate_feature(
    feature: Mapping[str, Any],
    repo_root: Path,
    source_commit: str,
    source_tree_sha256: str,
) -> None:
    feature_id = str(feature["id"])
    algorithm = CANONICAL_FEATURES[feature_id]
    promoted = promoted_lanes(feature)
    if not promoted:
        return
    validate_workloads(
        feature_id,
        feature.get("validated_workloads"),
        algorithm,
        promoted,
    )
    receipt_paths = feature.get("qualification_receipts")
    require(
        isinstance(receipt_paths, list) and receipt_paths,
        f"{feature_id} promoted relaxation requires an existing receipt",
    )
    receipts = [
        read_receipt(repository_path(repo_root, path, "qualification_receipt"))
        for path in receipt_paths
    ]
    for lane in promoted:
        lane_workloads = canonical_workloads(lane, algorithm)
        matching = [receipt for receipt in receipts if receipt.get("lane") == lane]
        require(matching, f"{feature_id} promoted lane {lane} requires an existing receipt")
        for receipt in matching:
            validate_receipt(
                receipt,
                repo_root,
                feature_id=feature_id,
                algorithm=algorithm,
                lane=lane,
                workloads=lane_workloads,
                source_commit=source_commit,
                source_tree_sha256=source_tree_sha256,
            )


def validate_matrix(document: Any, repo_root: Path) -> None:
    require(isinstance(document, dict), "capability matrix root must be an object")
    require(
        document.get("schema_version") == "capability_matrix.v0",
        "unexpected capability matrix schema_version",
    )
    features = document.get("features")
    require(isinstance(features, list), "capability matrix features must be an array")
    relaxation_features: list[Mapping[str, Any]] = []
    has_promoted_lane = False
    for feature in features:
        require(isinstance(feature, dict), "capability feature must be an object")
        algorithm = canonical_algorithm(feature)
        if algorithm is None:
            continue
        relaxation_features.append(feature)
        if promoted_lanes(feature):
            has_promoted_lane = True
    if not has_promoted_lane:
        return
    source_commit, source_tree_sha256 = source_identity(repo_root)
    for feature in relaxation_features:
        validate_feature(feature, repo_root, source_commit, source_tree_sha256)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "matrix",
        type=Path,
        nargs="?",
        default=Path("docs/specs/capability-matrix-v0.json"),
    )
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    try:
        validate_matrix(
            json.loads(args.matrix.read_text(encoding="utf-8")),
            args.repo_root.resolve(),
        )
    except (OSError, json.JSONDecodeError, EvidenceError) as error:
        print(f"FAIL: {error}")
        return 1
    print("Relaxation capability evidence PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
