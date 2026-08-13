#!/usr/bin/env python3
"""Fail closed on incomplete solved-current racetrack runtime outputs."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "fullmag.fdm_gpu_solved_current_racetrack_output.v1"
EXPECTED_EXECUTION = {
    "backend": "fdm",
    "device": "gpu",
    "precision": "double",
    "execution_mode": "strict",
}
EXPECTED_DRIVE_CASES = (
    ("drive_minus_1_5", -1.5e12),
    ("drive_minus_1_0", -1.0e12),
    ("drive_minus_0_5", -0.5e12),
    ("drive_plus_0_5", 0.5e12),
    ("drive_plus_1_0", 1.0e12),
    ("drive_plus_1_5", 1.5e12),
)
REQUIRED_FIELDS = (
    "m",
    "V_electric",
    "J_charge",
    "spin_potential",
    "spin_current_tensor",
    "torque_stt",
)
REQUIRED_ANALYSIS = ("skyrmion_trajectory", "skyrmion_hall_angle")


def _mapping(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{field} must be an object")
    return value


def _accepted_revision(value: Any, field: str) -> str:
    entry = _mapping(value, field)
    if entry.get("status") != "accepted":
        raise ValueError(f"{field}.status must be 'accepted'")
    revision = entry.get("revision")
    if not isinstance(revision, str) or not revision:
        raise ValueError(f"{field}.revision must be a non-empty string")
    return revision


def _execution(value: Any, field: str, *, resolved: bool) -> None:
    execution = _mapping(value, field)
    for key, expected in EXPECTED_EXECUTION.items():
        if execution.get(key) != expected:
            raise ValueError(f"{field}.{key} must be {expected!r}")
    if resolved and execution.get("fallback") != "forbidden":
        raise ValueError("resolved_execution.fallback must be 'forbidden'")


def validate_output_manifest(manifest: dict[str, object]) -> None:
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"schema_version must be {SCHEMA_VERSION!r}")
    _execution(manifest.get("requested_execution"), "requested_execution", resolved=False)
    _execution(manifest.get("resolved_execution"), "resolved_execution", resolved=True)

    relaxation = _mapping(manifest.get("relax_zero_current"), "relax_zero_current")
    if relaxation.get("status") != "accepted":
        raise ValueError("relax_zero_current.status must be 'accepted'")
    if relaxation.get("checkpoint") != "relaxed_zero_current":
        raise ValueError("relax_zero_current.checkpoint must be 'relaxed_zero_current'")
    revision = relaxation.get("accepted_revision")
    if not isinstance(revision, str) or not revision:
        raise ValueError("relax_zero_current.accepted_revision must be a non-empty string")
    if _accepted_revision(relaxation.get("topological_charge"), "relax_zero_current.topological_charge") != revision:
        raise ValueError("relax_zero_current.topological_charge.revision must match accepted_revision")

    drive = _mapping(manifest.get("drive_solved_current"), "drive_solved_current")
    if drive.get("status") != "accepted":
        raise ValueError("drive_solved_current.status must be 'accepted'")
    cases = drive.get("cases")
    if not isinstance(cases, list):
        raise ValueError("drive_solved_current.cases must be a list")
    observed = [(case.get("id"), case.get("current_density_Apm2")) for case in cases if isinstance(case, dict)]
    if observed != list(EXPECTED_DRIVE_CASES):
        raise ValueError("drive_solved_current.cases must contain the frozen signed six-current sweep")
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError("drive_solved_current.cases entries must be objects")
        current = case.get("current_density_Apm2")
        if not isinstance(current, (int, float)) or not math.isfinite(float(current)):
            raise ValueError("drive_solved_current.cases.current_density_Apm2 must be finite")
        for key in (
            "restart_revision",
            "charge_snapshot_revision",
            "spin_snapshot_revision",
            "torque_revision",
        ):
            if case.get(key) != revision:
                raise ValueError(f"drive_solved_current.cases.{key} must match relax_zero_current.accepted_revision")

    fields = _mapping(manifest.get("fields"), "fields")
    for field in REQUIRED_FIELDS:
        if _accepted_revision(fields.get(field), f"fields.{field}") != revision:
            raise ValueError(f"fields.{field}.revision must match relax_zero_current.accepted_revision")
    analysis = _mapping(manifest.get("analysis"), "analysis")
    for artifact in REQUIRED_ANALYSIS:
        if _accepted_revision(analysis.get(artifact), f"analysis.{artifact}") != revision:
            raise ValueError(f"analysis.{artifact}.revision must match relax_zero_current.accepted_revision")
    if manifest.get("qualification_boundary") != "not_production_qualified":
        raise ValueError("qualification_boundary must remain 'not_production_qualified'")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args(argv)
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict):
            raise ValueError("manifest root must be an object")
        validate_output_manifest(manifest)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"solved-current racetrack output rejected: {error}", file=sys.stderr)
        return 1
    print("solved-current racetrack output contract: pass")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
