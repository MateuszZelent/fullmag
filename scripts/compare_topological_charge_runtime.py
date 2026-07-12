#!/usr/bin/env python3
"""Combine independently captured FDM and FEM topological-charge evidence."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Iterable

try:
    from scripts.validate_topological_charge_runtime import METHOD, SCHEMA_VERSION, validate_evidence
except ModuleNotFoundError:  # Direct `python3 scripts/...` invocation.
    from validate_topological_charge_runtime import METHOD, SCHEMA_VERSION, validate_evidence


def read_single_run(path: Path, scenario: str) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"{path}: unexpected evidence schema_version")
    if payload.get("method") != METHOD:
        raise ValueError(f"{path}: unexpected topological-charge method")
    if payload.get("scenario") != scenario:
        raise ValueError(f"{path}: expected {scenario} evidence")
    runs = payload.get("runs")
    if not isinstance(runs, list) or len(runs) != 1 or not isinstance(runs[0], dict):
        raise ValueError(f"{path}: expected exactly one captured run")
    return runs[0]


def compare(fdm_path: Path, fem_path: Path) -> dict[str, Any]:
    payload = {
        "schema_version": SCHEMA_VERSION,
        "method": METHOD,
        "scenario": "cross_backend",
        "runs": [
            read_single_run(fdm_path, "fdm"),
            read_single_run(fem_path, "fem_p1"),
        ],
    }
    validate_evidence(payload)
    return payload


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fdm", required=True, type=Path)
    parser.add_argument("--fem", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        payload = compare(args.fdm, args.fem)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"FAIL: {error}")
        return 1
    print(json.dumps({"output": str(args.output), "status": "compared"}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
