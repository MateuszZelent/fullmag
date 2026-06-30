#!/usr/bin/env python3
"""Validate the hysteresis publication benchmark suite manifest."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "hysteresis-publication-suite/v1"
REQUIRED_CASES = {
    "macrospin_sw": {
        "validator": "verify_hysteresis_fdm_macrospin_sw_artifacts.py",
        "roles": {"macrospin_sw", "custom_angle"},
    },
    "thinfilm_oop_ip": {
        "validator": "verify_hysteresis_fdm_thinfilm_oop_ip_artifacts.py",
        "roles": {"in_plane", "oop"},
    },
    "projection_benchmark": {
        "validator": "verify_hysteresis_projection_benchmark.py",
        "roles": {"in_plane", "oop", "custom_angle"},
    },
}
REQUIRED_METADATA_FIELDS = (
    "artifact_dir",
    "run_command",
    "validator",
    "backend",
    "device",
    "precision",
    "roles",
)
ACCEPTANCE_STATUSES = {"criteria_declared_runtime_open", "validated"}
LANE_STATUSES = {"supported-with-warning", "unsupported", "validated"}
REQUIRED_CROSS_BACKEND_METRICS = {
    "H_c_plus",
    "H_c_minus",
    "M_r_plus",
    "M_r_minus",
}
REQUIRED_CROSS_BACKEND_LANES = {
    ("fdm", "cpu", "double"),
    ("fdm", "gpu", "double"),
    ("fem", "cpu", "double"),
    ("fem", "gpu", "double"),
}
METRICS_PARITY_SCHEMA_VERSION = "hysteresis-metrics-parity/v1"


def load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def require_mapping(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SystemExit(f"{field} must be an object, got {value!r}")
    return value


def require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise SystemExit(f"{field} must be a non-empty string, got {value!r}")
    return value


def require_string_list(value: Any, field: str) -> list[str]:
    if not isinstance(value, list) or not value or not all(isinstance(item, str) for item in value):
        raise SystemExit(f"{field} must be a non-empty list of strings")
    return value


def require_optional_string_list(value: Any, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise SystemExit(f"{field} must be a list of strings")
    return value


def require_case_validator_args(case_id: str, value: Any) -> list[str]:
    args = require_optional_string_list(value, f"case {case_id!r}.validator_args")
    if not args:
        return args
    if case_id != "macrospin_sw":
        raise SystemExit(
            f"case {case_id!r}.validator_args is not supported for this validator"
        )
    allowed_flags = {
        "--require-publication-astroid-ratio": 0,
        "--astroid-ratio-abs-tolerance": 1,
    }
    index = 0
    while index < len(args):
        flag = args[index]
        if flag not in allowed_flags:
            raise SystemExit(
                f"case {case_id!r}.validator_args contains unsupported argument {flag!r}"
            )
        arity = allowed_flags[flag]
        if index + arity >= len(args):
            raise SystemExit(
                f"case {case_id!r}.validator_args missing value after {flag!r}"
            )
        for offset in range(1, arity + 1):
            value_arg = args[index + offset]
            if not value_arg or value_arg.startswith("-"):
                raise SystemExit(
                    f"case {case_id!r}.validator_args has invalid value "
                    f"{value_arg!r} after {flag!r}"
                )
        index += arity + 1
    return args


def require_under(base: Path, path: Path, field: str) -> None:
    try:
        path.relative_to(base)
    except ValueError:
        raise SystemExit(f"{field} must stay under {base}, got {path}") from None


def lane_key(lane: dict[str, Any], field: str) -> tuple[str, str, str]:
    return (
        require_string(lane.get("backend"), f"{field}.backend"),
        require_string(lane.get("device"), f"{field}.device"),
        require_string(lane.get("precision"), f"{field}.precision"),
    )


def lane_label(key: tuple[str, str, str]) -> str:
    return "/".join(key)


def require_case(case_id: str, value: Any) -> dict[str, Any]:
    case = require_mapping(value, f"case {case_id!r}")
    for field in REQUIRED_METADATA_FIELDS:
        if field not in case:
            raise SystemExit(f"case {case_id!r} missing required field {field!r}")
    expected = REQUIRED_CASES[case_id]
    validator = require_string(case.get("validator"), f"case {case_id!r}.validator")
    if validator != expected["validator"]:
        raise SystemExit(
            f"case {case_id!r}.validator must be {expected['validator']!r}, got {validator!r}"
        )
    for field in ("run_command", "backend", "device", "precision"):
        require_string(case.get(field), f"case {case_id!r}.{field}")
    roles = case.get("roles")
    if not isinstance(roles, list) or not all(isinstance(role, str) for role in roles):
        raise SystemExit(f"case {case_id!r}.roles must be a list of strings")
    missing_roles = sorted(expected["roles"] - set(roles))
    if missing_roles:
        raise SystemExit(
            f"case {case_id!r}.roles missing required role(s): {', '.join(missing_roles)}"
        )
    require_case_validator_args(case_id, case.get("validator_args"))
    return case


def require_cross_backend_acceptance(
    manifest: dict[str, Any],
    cases: dict[str, Any],
) -> tuple[tuple[str, str, str], dict[tuple[str, str, str], dict[str, Any]]]:
    cross_backend = require_mapping(
        manifest.get("cross_backend_acceptance"),
        "cross_backend_acceptance",
    )
    status = require_string(
        cross_backend.get("status"),
        "cross_backend_acceptance.status",
    )
    if status not in ACCEPTANCE_STATUSES:
        raise SystemExit(
            "cross_backend_acceptance.status must be one of "
            + ", ".join(sorted(ACCEPTANCE_STATUSES))
            + f", got {status!r}"
        )
    if status == "validated":
        require_string_list(
            cross_backend.get("parity_checks"),
            "cross_backend_acceptance.parity_checks",
        )
    reference_lane = require_mapping(
        cross_backend.get("reference_lane"),
        "cross_backend_acceptance.reference_lane",
    )
    reference_key = lane_key(reference_lane, "cross_backend_acceptance.reference_lane")
    reference_cases = require_string_list(
        reference_lane.get("case_ids"),
        "cross_backend_acceptance.reference_lane.case_ids",
    )
    required_metrics = set(
        require_string_list(
            cross_backend.get("required_metrics"),
            "cross_backend_acceptance.required_metrics",
        )
    )
    missing_metrics = sorted(REQUIRED_CROSS_BACKEND_METRICS - required_metrics)
    if missing_metrics:
        raise SystemExit(
            "cross_backend_acceptance.required_metrics missing required metric(s): "
            + ", ".join(missing_metrics)
        )
    lanes = cross_backend.get("lanes")
    if not isinstance(lanes, list) or not lanes:
        raise SystemExit(
            "cross_backend_acceptance.lanes must be a non-empty list"
        )
    lanes_by_key: dict[tuple[str, str, str], dict[str, Any]] = {}
    for index, raw_lane in enumerate(lanes):
        lane = require_mapping(raw_lane, f"cross_backend_acceptance.lanes[{index}]")
        key = lane_key(lane, f"cross_backend_acceptance.lanes[{index}]")
        if key in lanes_by_key:
            raise SystemExit(
                f"cross_backend_acceptance.lanes duplicates {lane_label(key)}"
            )
        lanes_by_key[key] = lane
        lane_status = require_string(
            lane.get("status"),
            f"cross_backend_acceptance.lanes[{index}].status",
        )
        if lane_status not in LANE_STATUSES:
            raise SystemExit(
                f"cross_backend_acceptance.lanes[{index}].status must be one of "
                + ", ".join(sorted(LANE_STATUSES))
                + f", got {lane_status!r}"
            )
        if status == "validated" and lane_status != "validated":
            raise SystemExit(
                "cross_backend_acceptance.status='validated' requires "
                "all cross_backend_acceptance.lanes entries to be 'validated', "
                f"got {lane_status!r} for {lane_label(key)}"
            )
        case_ids = lane.get("case_ids", [])
        if case_ids != []:
            case_ids = require_string_list(
                case_ids,
                f"cross_backend_acceptance.lanes[{index}].case_ids",
            )
        if lane_status == "validated":
            if not case_ids:
                raise SystemExit(
                    f"cross_backend_acceptance lane {lane_label(key)} is validated "
                    "but has no case_ids"
                )
            require_string(
                lane.get("evidence"),
                f"cross_backend_acceptance.lanes[{index}].evidence",
            )
        elif lane_status == "supported-with-warning":
            limitations = lane.get("limitations", lane.get("blockers"))
            require_string_list(
                limitations,
                f"cross_backend_acceptance.lanes[{index}].limitations",
            )
        elif lane_status == "unsupported":
            require_string(
                lane.get("reason"),
                f"cross_backend_acceptance.lanes[{index}].reason",
            )
        for case_id in case_ids:
            if case_id not in cases:
                raise SystemExit(
                    "cross_backend_acceptance references unknown case "
                    f"{case_id!r}"
                )
            case = cases[case_id]
            case_key = (
                require_string(case.get("backend"), f"case {case_id!r}.backend"),
                require_string(case.get("device"), f"case {case_id!r}.device"),
                require_string(case.get("precision"), f"case {case_id!r}.precision"),
            )
            if case_key != key:
                raise SystemExit(
                    f"cross_backend_acceptance lane {lane_label(key)} references "
                    f"case {case_id!r} declared as {lane_label(case_key)}"
                )
    missing_lanes = sorted(
        REQUIRED_CROSS_BACKEND_LANES - set(lanes_by_key),
        key=lane_label,
    )
    if missing_lanes:
        raise SystemExit(
            "cross_backend_acceptance missing required lane(s): "
            + ", ".join(lane_label(key) for key in missing_lanes)
        )
    if reference_key not in lanes_by_key:
        raise SystemExit(
            "cross_backend_acceptance.reference_lane must match a declared lane, "
            f"got {lane_label(reference_key)}"
        )
    for case_id in reference_cases:
        if case_id not in cases:
            raise SystemExit(
                "cross_backend_acceptance.reference_lane references unknown case "
                f"{case_id!r}"
            )
        case_key = (
            require_string(cases[case_id].get("backend"), f"case {case_id!r}.backend"),
            require_string(cases[case_id].get("device"), f"case {case_id!r}.device"),
            require_string(cases[case_id].get("precision"), f"case {case_id!r}.precision"),
        )
        if case_key != reference_key:
            raise SystemExit(
                "cross_backend_acceptance.reference_lane references case "
                f"{case_id!r} declared as {lane_label(case_key)}"
            )
    tolerances = cross_backend.get("tolerances")
    if not isinstance(tolerances, list) or not tolerances:
        raise SystemExit(
            "cross_backend_acceptance.tolerances must be a non-empty list"
        )
    tolerance_metrics: set[str] = set()
    for index, raw_tolerance in enumerate(tolerances):
        tolerance = require_mapping(
            raw_tolerance,
            f"cross_backend_acceptance.tolerances[{index}]",
        )
        tolerance_metric = require_string(
            tolerance.get("metric"),
            f"cross_backend_acceptance.tolerances[{index}].metric",
        )
        tolerance_metrics.add(tolerance_metric)
        tolerance_status = require_string(
            tolerance.get("status"),
            f"cross_backend_acceptance.tolerances[{index}].status",
        )
        if tolerance_status not in ("deferred", "validated"):
            raise SystemExit(
                "cross_backend_acceptance.tolerances status must be 'deferred' "
                f"or 'validated', got {tolerance_status!r}"
            )
        if status == "validated" and tolerance_status != "validated":
            raise SystemExit(
                "cross_backend_acceptance.status='validated' requires "
                "cross_backend_acceptance.tolerances entries to be 'validated', "
                f"got {tolerance_status!r}"
            )
        require_string(
            tolerance.get("reason"),
            f"cross_backend_acceptance.tolerances[{index}].reason",
        )
    missing_tolerance_metrics = sorted(REQUIRED_CROSS_BACKEND_METRICS - tolerance_metrics)
    if status == "validated" and missing_tolerance_metrics:
        raise SystemExit(
            "cross_backend_acceptance.status='validated' requires "
            "cross_backend_acceptance.tolerances entries for required metric(s): "
            + ", ".join(missing_tolerance_metrics)
        )
    return reference_key, lanes_by_key


def resolve_case_dir(manifest_path: Path, case: dict[str, Any], case_id: str) -> Path:
    raw_path = require_string(case.get("artifact_dir"), f"case {case_id!r}.artifact_dir")
    path = Path(raw_path)
    if path.is_absolute():
        raise SystemExit(
            f"case {case_id!r}.artifact_dir must be relative, got {raw_path!r}"
        )
    base = manifest_path.parent.resolve()
    resolved = (manifest_path.parent / path).resolve()
    require_under(base, resolved, f"case {case_id!r}.artifact_dir")
    if not resolved.is_dir():
        raise SystemExit(f"case {case_id!r} artifact directory does not exist: {resolved}")
    return resolved


def run_case_validator(
    case_id: str,
    validator: Path,
    artifact_dir: Path,
    validator_args: list[str],
) -> None:
    result = subprocess.run(
        [sys.executable, str(validator), *validator_args, str(artifact_dir)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        details = (result.stderr + result.stdout).strip()
        raise SystemExit(f"{case_id} validation failed: {details}")


def resolve_parity_check(manifest_path: Path, value: Any, index: int) -> Path:
    raw_path = require_string(
        value,
        f"cross_backend_acceptance.parity_checks[{index}]",
    )
    path = Path(raw_path)
    if path.is_absolute():
        raise SystemExit(
            "cross_backend_acceptance.parity_checks entries must be relative, "
            f"got {raw_path!r}"
        )
    base = manifest_path.parent.resolve()
    resolved = (manifest_path.parent / path).resolve()
    require_under(
        base,
        resolved,
        f"cross_backend_acceptance.parity_checks[{index}]",
    )
    if not resolved.is_file():
        raise SystemExit(
            "cross_backend_acceptance.parity_checks entry does not exist: "
            f"{raw_path!r}"
        )
    return resolved


def run_metrics_parity_validator(
    parity_check: Path,
    validator: Path,
    display_path: str,
) -> None:
    result = subprocess.run(
        [sys.executable, str(validator), str(parity_check)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        details = (result.stderr + result.stdout).strip()
        raise SystemExit(f"{display_path} parity validation failed: {details}")


def parity_manifest_lane_pairs(parity_check: Path, display_path: str) -> set[tuple[str, str]]:
    manifest = require_mapping(
        load_json(parity_check),
        f"{display_path} metrics parity manifest",
    )
    if manifest.get("schema_version") != METRICS_PARITY_SCHEMA_VERSION:
        raise SystemExit(
            f"{display_path}.schema_version must be "
            f"{METRICS_PARITY_SCHEMA_VERSION!r}, got {manifest.get('schema_version')!r}"
        )
    pairs = manifest.get("pairs")
    if not isinstance(pairs, list) or not pairs:
        raise SystemExit(f"{display_path}.pairs must be a non-empty list")
    lane_pairs: set[tuple[str, str]] = set()
    for index, raw_pair in enumerate(pairs):
        pair = require_mapping(raw_pair, f"{display_path}.pairs[{index}]")
        reference = require_mapping(
            pair.get("reference"),
            f"{display_path}.pairs[{index}].reference",
        )
        candidate = require_mapping(
            pair.get("candidate"),
            f"{display_path}.pairs[{index}].candidate",
        )
        lane_pairs.add(
            (
                lane_label(lane_key(reference, f"{display_path}.pairs[{index}].reference")),
                lane_label(lane_key(candidate, f"{display_path}.pairs[{index}].candidate")),
            )
        )
    return lane_pairs


def require_validated_parity_coverage(
    reference_key: tuple[str, str, str],
    lanes_by_key: dict[tuple[str, str, str], dict[str, Any]],
    lane_pairs: set[tuple[str, str]],
) -> None:
    reference_label = lane_label(reference_key)
    compared_lanes = {
        candidate
        for reference, candidate in lane_pairs
        if reference == reference_label
    }
    required_lanes = {
        lane_label(key)
        for key in lanes_by_key
        if key != reference_key
    }
    missing = sorted(required_lanes - compared_lanes)
    if missing:
        raise SystemExit(
            "cross_backend_acceptance.status='validated' requires parity_checks "
            "covering reference lane comparisons for: "
            + ", ".join(missing)
        )


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: scripts/verify_hysteresis_publication_suite.py <manifest.json>")

    manifest_path = Path(sys.argv[1])
    manifest = require_mapping(load_json(manifest_path), "publication suite manifest")
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise SystemExit(
            f"schema_version must be {SCHEMA_VERSION!r}, got {manifest.get('schema_version')!r}"
        )
    cases = require_mapping(manifest.get("cases"), "cases")
    missing = [case_id for case_id in REQUIRED_CASES if case_id not in cases]
    if missing:
        raise SystemExit(f"missing required case(s): {', '.join(missing)}")

    for case_id, value in cases.items():
        if case_id in REQUIRED_CASES:
            require_case(case_id, value)
    reference_key, lanes_by_key = require_cross_backend_acceptance(manifest, cases)

    scripts_dir = Path(__file__).resolve().parent
    for case_id, expected in REQUIRED_CASES.items():
        case = require_case(case_id, cases[case_id])
        artifact_dir = resolve_case_dir(manifest_path, case, case_id)
        validator_args = require_case_validator_args(case_id, case.get("validator_args"))
        run_case_validator(
            case_id,
            scripts_dir / expected["validator"],
            artifact_dir,
            validator_args,
        )

    cross_backend = require_mapping(
        manifest.get("cross_backend_acceptance"),
        "cross_backend_acceptance",
    )
    parity_checks = cross_backend.get("parity_checks", [])
    if parity_checks != []:
        if not isinstance(parity_checks, list):
            raise SystemExit(
                "cross_backend_acceptance.parity_checks must be a list of strings"
            )
        lane_pairs: set[tuple[str, str]] = set()
        for index, raw_check in enumerate(parity_checks):
            display_path = require_string(
                raw_check,
                f"cross_backend_acceptance.parity_checks[{index}]",
            )
            parity_check = resolve_parity_check(manifest_path, raw_check, index)
            lane_pairs.update(parity_manifest_lane_pairs(parity_check, display_path))
            run_metrics_parity_validator(
                parity_check,
                scripts_dir / "verify_hysteresis_metrics_parity.py",
                display_path,
            )
        if cross_backend.get("status") == "validated":
            require_validated_parity_coverage(reference_key, lanes_by_key, lane_pairs)

    print(
        "validated hysteresis publication suite: "
        + ", ".join(REQUIRED_CASES.keys())
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
