#!/usr/bin/env python3
"""Validate the versioned cross-backend PBC promotion matrix.

The verifier is intentionally evidence-only: it validates named case results and
their artifact fingerprints, but it does not run a managed solver runtime.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "pbc_production_matrix.v1"
CAPABILITY_STATUSES = {
    "unsupported",
    "source_visible",
    "semantic_only",
    "reference_executable",
    "development_executable",
    "partial_production_executable",
    "production_executable",
    "validated",
}
RESULT_STATUSES = {"pass", "expected_unsupported", "not_run", "failed"}
FINGERPRINT_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def _error(errors: list[str], code: str, case_id: str | None = None) -> None:
    errors.append(f"{code}:{case_id}" if case_id else code)


def _nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate_manifest(path: Path) -> list[str]:
    errors: list[str] = []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"manifest_read_error:{exc}"]

    if not isinstance(payload, dict):
        return ["manifest_not_object"]
    if payload.get("schema_version") != SCHEMA_VERSION:
        _error(errors, "schema_version_invalid")
    if not _nonempty_string(payload.get("matrix_id")):
        _error(errors, "matrix_id_missing")
    cases = payload.get("cases")
    if not isinstance(cases, list) or not cases:
        _error(errors, "cases_missing")
        return errors

    seen: set[str] = set()
    required_case_fields = {
        "case_id",
        "backend",
        "device",
        "precision",
        "lane",
        "capability_id",
        "capability_status",
        "result",
    }
    for case in cases:
        if not isinstance(case, dict):
            _error(errors, "case_not_object")
            continue
        case_id = case.get("case_id")
        case_label = case_id if isinstance(case_id, str) else None
        if not _nonempty_string(case_id):
            _error(errors, "case_id_missing")
            continue
        if case_id in seen:
            _error(errors, "duplicate_case_id", case_id)
        seen.add(case_id)
        for field in sorted(required_case_fields - case.keys()):
            _error(errors, f"case_field_missing:{field}", case_label)
        capability_status = case.get("capability_status")
        if capability_status not in CAPABILITY_STATUSES:
            _error(errors, "capability_status_invalid", case_label)
        result = case.get("result")
        if not isinstance(result, dict):
            _error(errors, "case_result_missing", case_label)
            continue
        result_status = result.get("status")
        if result_status not in RESULT_STATUSES:
            _error(errors, "case_result_status_invalid", case_label)
            continue
        fingerprint = result.get("artifact_fingerprint")
        if result_status == "not_run":
            _error(errors, "case_result_missing", case_label)
            continue
        if result_status == "failed":
            _error(errors, "case_failed", case_label)
            continue
        if not isinstance(fingerprint, str) or not FINGERPRINT_RE.fullmatch(fingerprint):
            _error(errors, "artifact_fingerprint_missing", case_label)
        if result_status == "expected_unsupported":
            if capability_status != "unsupported":
                _error(errors, "unsupported_status_mismatch", case_label)
            if not _nonempty_string(result.get("reason")):
                _error(errors, "unsupported_reason_missing", case_label)

    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args(argv)
    errors = validate_manifest(args.manifest)
    if errors:
        print("pbc production matrix failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"pbc production matrix passed: {len(json.loads(args.manifest.read_text(encoding='utf-8'))['cases'])} cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
