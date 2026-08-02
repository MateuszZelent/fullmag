#!/usr/bin/env python3
"""Validate and resolve the fail-closed LLG qualification registry."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any, Mapping


REGISTRY_SCHEMA = "fullmag.llg_timestep_qualification_registry.v1"
VALIDATOR_SCHEMA = "fullmag.llg_timestep_qualification.validator.v1"
STATES = {
    "unvalidated",
    "algebra_validated",
    "physics_validated",
    "production_qualified",
}
KEY_FIELDS = {
    "capability_id",
    "qualification_id",
    "backend",
    "device",
    "precision",
    "integrator",
    "timestep_policy",
}
ENTRY_FIELDS = {
    "key",
    "validation_state",
    "artifact_path",
    "artifact_sha256",
    "runtime_source_inputs_sha256",
    "runtime_dirty",
    "runtime_dirty_patch_sha256",
    "validated_scope",
    "validated_at",
    "validator_schema",
    "completed_gates",
    "reason",
}
QUALIFICATION_LANES = {
    "explicit_fixed_fdm_cpu_double": ("fdm", "cpu", "double", "fixed"),
    "explicit_fixed_fdm_cuda_double": ("fdm", "cuda", "double", "fixed"),
    "explicit_fixed_fdm_cuda_single": ("fdm", "cuda", "single", "fixed"),
    "explicit_fixed_fem_cpu_double": ("fem", "cpu", "double", "fixed"),
    "explicit_fixed_fem_gpu_double": ("fem", "gpu", "double", "fixed"),
    "explicit_adaptive_fdm_cpu_double": ("fdm", "cpu", "double", "adaptive"),
    "explicit_adaptive_fem_cpu_double": ("fem", "cpu", "double", "adaptive"),
    "explicit_adaptive_fem_gpu_double": ("fem", "gpu", "double", "adaptive"),
}
ALLOWED_INTEGRATORS = {"heun", "rk4", "rk23", "rk45", "abm3"}


class RegistryError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RegistryError(message)


def is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def validated_artifact_path(entry: Mapping[str, Any], repo_root: Path) -> Path:
    raw_path = entry.get("artifact_path")
    require(isinstance(raw_path, str) and raw_path, "promoted entry artifact_path is required")
    relative = Path(raw_path)
    require(not relative.is_absolute(), "artifact_path must be repository-relative")
    root = repo_root.resolve()
    resolved = (root / relative).resolve()
    require(resolved.is_relative_to(root), "artifact_path must stay inside repo root")
    require(resolved.is_file(), "qualification artifact does not exist")
    return resolved


def required_gates(state: str) -> set[str]:
    return {
        "unvalidated": set(),
        "algebra_validated": {"algebra"},
        "physics_validated": {"algebra", "physics"},
        "production_qualified": {"algebra", "physics", "production"},
    }[state]


def validate_promoted_entry(entry: Mapping[str, Any], repo_root: Path) -> None:
    key = entry["key"]
    state = entry["validation_state"]
    require(
        not (key["backend"] == "fem" and key["precision"] == "single"),
        "single-precision FEM cannot be promoted before its dedicated qualification",
    )
    artifact = validated_artifact_path(entry, repo_root)
    expected_artifact_hash = entry.get("artifact_sha256")
    require(is_sha256(expected_artifact_hash), "promoted entry artifact_sha256 is invalid")
    actual_artifact_hash = hashlib.sha256(artifact.read_bytes()).hexdigest()
    require(
        actual_artifact_hash == expected_artifact_hash,
        "artifact_sha256 does not match the qualification artifact",
    )
    require(
        is_sha256(entry.get("runtime_source_inputs_sha256")),
        "promoted entry runtime_source_inputs_sha256 is invalid",
    )
    require(entry.get("runtime_dirty") is False, "promoted entry runtime must be clean")
    require(
        entry.get("runtime_dirty_patch_sha256") is None,
        "clean promoted entry cannot carry a dirty patch hash",
    )
    scope = entry.get("validated_scope")
    require(isinstance(scope, dict) and scope, "promoted entry validated_scope is required")
    require(
        isinstance(entry.get("validated_at"), str) and entry["validated_at"],
        "promoted entry validated_at is required",
    )
    require(
        entry.get("validator_schema") == VALIDATOR_SCHEMA,
        "promoted entry validator_schema is unsupported",
    )
    gates = entry.get("completed_gates")
    require(isinstance(gates, list), "completed_gates must be an array")
    require(
        required_gates(state).issubset(set(gates)),
        f"{state} is missing a prerequisite promotion gate",
    )


def validate_registry(document: Any, repo_root: Path) -> None:
    require(isinstance(document, dict), "registry root must be an object")
    require(document.get("schema_version") == REGISTRY_SCHEMA, "unexpected registry schema_version")
    entries = document.get("entries")
    require(isinstance(entries, list), "registry entries must be an array")
    seen: set[str] = set()
    for index, entry in enumerate(entries):
        require(isinstance(entry, dict), f"entries[{index}] must be an object")
        require(
            set(entry) == ENTRY_FIELDS,
            f"entries[{index}] must contain the exact registry fields",
        )
        key = entry.get("key")
        require(isinstance(key, dict), f"entries[{index}].key must be an object")
        require(set(key) == KEY_FIELDS, f"entries[{index}].key must contain the exact identity fields")
        require(
            all(isinstance(key[field], str) and key[field] for field in KEY_FIELDS),
            f"entries[{index}].key values must be non-empty strings",
        )
        require(
            key["capability_id"] == "llg_td_policy_v1",
            f"entries[{index}].key capability_id is unsupported",
        )
        require(
            not (key["backend"] == "fem" and key["precision"] == "single"),
            "single-precision FEM cannot be promoted before its dedicated qualification",
        )
        require(
            key["backend"] in {"fdm", "fem"}
            and key["device"] in {"cpu", "cuda", "gpu"}
            and key["precision"] in {"single", "double"}
            and key["integrator"] in ALLOWED_INTEGRATORS
            and key["timestep_policy"] in {"fixed", "adaptive"},
            f"entries[{index}].key contains an unsupported lane value",
        )
        expected_lane = QUALIFICATION_LANES.get(key["qualification_id"])
        require(
            expected_lane is not None,
            f"entries[{index}].key qualification_id is unsupported",
        )
        require(
            expected_lane
            == (
                key["backend"],
                key["device"],
                key["precision"],
                key["timestep_policy"],
            ),
            f"entries[{index}].key qualification_id does not match its lane",
        )
        canonical_key = json.dumps(key, sort_keys=True, separators=(",", ":"))
        require(canonical_key not in seen, f"duplicate registry key at entries[{index}]")
        seen.add(canonical_key)
        state = entry.get("validation_state")
        require(state in STATES, f"entries[{index}].validation_state is unknown")
        if state != "unvalidated":
            validate_promoted_entry(entry, repo_root)
        else:
            require(
                all(
                    entry.get(field) is None
                    for field in (
                        "artifact_path",
                        "artifact_sha256",
                        "runtime_source_inputs_sha256",
                        "runtime_dirty",
                        "runtime_dirty_patch_sha256",
                        "validated_scope",
                        "validated_at",
                        "validator_schema",
                    )
                )
                and entry.get("completed_gates") == [],
                f"entries[{index}] unvalidated entries cannot carry promotion metadata",
            )
            require(
                isinstance(entry.get("reason"), str) and entry["reason"],
                f"entries[{index}] unvalidated entries require a reason",
            )


def resolve_validation_state(
    document: Any,
    identity: Mapping[str, str],
    runtime_source_inputs_sha256: str,
    repo_root: Path,
) -> str:
    try:
        validate_registry(document, repo_root)
        require(set(identity) == KEY_FIELDS, "lookup identity must contain exact key fields")
        require(is_sha256(runtime_source_inputs_sha256), "runtime source hash is invalid")
        for entry in document["entries"]:
            if entry["key"] != dict(identity):
                continue
            if entry["validation_state"] == "unvalidated":
                return "unvalidated"
            if entry["runtime_source_inputs_sha256"] != runtime_source_inputs_sha256:
                return "unvalidated"
            return str(entry["validation_state"])
    except (OSError, RegistryError):
        return "unvalidated"
    return "unvalidated"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("registry", type=Path)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    try:
        document = json.loads(args.registry.read_text(encoding="utf-8"))
        validate_registry(document, args.repo_root)
    except (OSError, json.JSONDecodeError, RegistryError) as error:
        print(f"FAIL: {error}")
        return 1
    print("LLG qualification registry PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
