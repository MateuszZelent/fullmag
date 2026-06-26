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
    return case


def resolve_case_dir(manifest_path: Path, case: dict[str, Any], case_id: str) -> Path:
    raw_path = require_string(case.get("artifact_dir"), f"case {case_id!r}.artifact_dir")
    path = Path(raw_path)
    if path.is_absolute():
        raise SystemExit(
            f"case {case_id!r}.artifact_dir must be relative, got {raw_path!r}"
        )
    resolved = (manifest_path.parent / path).resolve()
    if not resolved.is_dir():
        raise SystemExit(f"case {case_id!r} artifact directory does not exist: {resolved}")
    return resolved


def run_case_validator(case_id: str, validator: Path, artifact_dir: Path) -> None:
    result = subprocess.run(
        [sys.executable, str(validator), str(artifact_dir)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        details = (result.stderr + result.stdout).strip()
        raise SystemExit(f"{case_id} validation failed: {details}")


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

    scripts_dir = Path(__file__).resolve().parent
    for case_id, expected in REQUIRED_CASES.items():
        case = require_case(case_id, cases[case_id])
        artifact_dir = resolve_case_dir(manifest_path, case, case_id)
        run_case_validator(case_id, scripts_dir / expected["validator"], artifact_dir)

    print(
        "validated hysteresis publication suite: "
        + ", ".join(REQUIRED_CASES.keys())
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
