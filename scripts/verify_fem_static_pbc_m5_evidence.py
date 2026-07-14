#!/usr/bin/env python3
"""Fail-closed verifier for the strict FEM static-PBC M5 evidence bundle.

This tool validates evidence produced by managed runtimes; it never turns a
missing or historical artifact into a passing result and it does not execute a
solver itself.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "fem_static_pbc_m5_evidence.v1"
FINGERPRINT_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
REQUIRED_CASES = {
    "primitive_cell": "cpu",
    "supercell": "cpu",
    "z_padding": "cpu",
    "equilibrium_cpu": "cpu",
    "equilibrium_gpu": "gpu",
}
MAX_STRICT_RELATIVE_ERROR = 2.0e-2


def error(errors: list[str], code: str, detail: str | None = None) -> None:
    errors.append(f"{code}:{detail}" if detail else code)


def nonempty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def valid_fingerprint(value: Any) -> bool:
    return isinstance(value, str) and FINGERPRINT_RE.fullmatch(value) is not None


def validate_manifest(path: Path) -> list[str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"manifest_read_error:{exc}"]
    if not isinstance(payload, dict):
        return ["manifest_not_object"]

    errors: list[str] = []
    if payload.get("schema_version") != SCHEMA_VERSION:
        error(errors, "schema_version_invalid")
    for field in (
        "mesh_generation_id",
        "topology_hash",
        "marker_map_hash",
        "material_realization_hash",
    ):
        if not nonempty(payload.get(field)):
            error(errors, "identity_missing", field)
    for field in ("topology_hash", "marker_map_hash", "material_realization_hash"):
        if not valid_fingerprint(payload.get(field)):
            error(errors, "identity_fingerprint_invalid", field)
    if payload.get("strict_thresholds") is not True:
        error(errors, "strict_thresholds_required")

    cases = payload.get("cases")
    if not isinstance(cases, dict):
        error(errors, "cases_missing")
        return errors
    for case_id, expected_engine in REQUIRED_CASES.items():
        case = cases.get(case_id)
        if not isinstance(case, dict):
            error(errors, "case_missing", case_id)
            continue
        if case.get("status") != "pass":
            error(errors, "case_not_pass", case_id)
        if case.get("engine") != expected_engine:
            error(errors, "case_engine_mismatch", case_id)
        if not valid_fingerprint(case.get("artifact_fingerprint")):
            error(errors, "case_artifact_fingerprint_invalid", case_id)
        metrics = case.get("metrics")
        if not isinstance(metrics, dict):
            error(errors, "case_metrics_missing", case_id)
            continue
        relative_error = metrics.get("max_relative_error")
        if not isinstance(relative_error, (int, float)) or not math.isfinite(float(relative_error)):
            error(errors, "case_metric_invalid", case_id)
        elif float(relative_error) < 0.0 or float(relative_error) > MAX_STRICT_RELATIVE_ERROR:
            error(errors, "case_metric_exceeds_strict_limit", case_id)
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args(argv)
    errors = validate_manifest(args.manifest)
    if errors:
        print("fem static PBC M5 evidence failed:", file=sys.stderr)
        for item in errors:
            print(f"- {item}", file=sys.stderr)
        return 1
    cases = json.loads(args.manifest.read_text(encoding="utf-8"))["cases"]
    print(f"fem static PBC M5 evidence passed: {len(cases)} cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
