#!/usr/bin/env python3
"""Validate the normative Frozen Spins V1 scope ledger.

The ledger is stored as JSON-compatible YAML so validation stays deterministic
and does not depend on a host-installed YAML package.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


EXPECTED_SCHEMA = "fullmag.frozen_spins.scope.v1"
ALLOWED_SCOPE_STATUSES = {"REQUIRED", "OUT_OF_SCOPE"}


def validate_scope_document(document: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(document, dict):
        return ["scope document must be a JSON object"]
    if document.get("schema_version") != EXPECTED_SCHEMA:
        errors.append(f"schema_version must equal {EXPECTED_SCHEMA!r}")
    if not isinstance(document.get("scope_revision"), int) or document["scope_revision"] < 1:
        errors.append("scope_revision must be a positive integer")

    features = document.get("features")
    if not isinstance(features, list) or not features:
        return [*errors, "features must be a non-empty array"]

    seen_ids: set[str] = set()
    seen_test_ids: set[str] = set()
    for index, feature in enumerate(features):
        prefix = f"features[{index}]"
        if not isinstance(feature, dict):
            errors.append(f"{prefix} must be an object")
            continue
        feature_id = feature.get("id")
        if not isinstance(feature_id, str) or not feature_id.strip():
            errors.append(f"{prefix}.id must be a non-empty string")
        elif feature_id in seen_ids:
            errors.append(f"duplicate feature id: {feature_id}")
        else:
            seen_ids.add(feature_id)

        scope_status = feature.get("scope_status")
        if scope_status not in ALLOWED_SCOPE_STATUSES:
            errors.append(
                f"{prefix}.scope_status must be one of {sorted(ALLOWED_SCOPE_STATUSES)}"
            )
        reason_code = feature.get("reason_code")
        if scope_status == "OUT_OF_SCOPE" and (
            not isinstance(reason_code, str) or not reason_code.strip()
        ):
            errors.append(f"{prefix}.reason_code is required for OUT_OF_SCOPE")
        if scope_status == "REQUIRED" and reason_code is not None:
            errors.append(f"{prefix}.reason_code must be absent for REQUIRED")

        test_ids = feature.get("required_test_case_ids")
        if not isinstance(test_ids, list) or not test_ids:
            errors.append(f"{prefix}.required_test_case_ids must be non-empty")
            continue
        for test_index, test_id in enumerate(test_ids):
            if not isinstance(test_id, str) or not test_id.startswith("FS-"):
                errors.append(
                    f"{prefix}.required_test_case_ids[{test_index}] must start with 'FS-'"
                )
            elif test_id in seen_test_ids:
                errors.append(f"duplicate test case id: {test_id}")
            else:
                seen_test_ids.add(test_id)

    return errors


def load_scope(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "path",
        nargs="?",
        type=Path,
        default=Path("docs/validation/frozen-spins-v1-scope.yaml"),
    )
    args = parser.parse_args()
    try:
        document = load_scope(args.path)
    except (OSError, json.JSONDecodeError) as error:
        print(f"FAIL: unable to read Frozen Spins scope ledger: {error}")
        return 1
    errors = validate_scope_document(document)
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    required = sum(
        feature["scope_status"] == "REQUIRED" for feature in document["features"]
    )
    out_of_scope = len(document["features"]) - required
    print(
        "PASS: Frozen Spins V1 scope ledger is valid "
        f"({required} required, {out_of_scope} out of scope)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
