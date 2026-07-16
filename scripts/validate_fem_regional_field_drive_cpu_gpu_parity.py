#!/usr/bin/env python3
"""Validate managed FEM CPU/GPU double regional-drive parity."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


def final_values(run: Path) -> dict[str, float]:
    table_dir = run / "tables" / "default"
    schema = json.loads((table_dir / "schema.json").read_text())
    rows = json.loads((table_dir / "table.json").read_text())["rows"]
    if not rows:
        raise ValueError(f"{run}: table has no rows")
    return dict(zip((column["quantity_id"] for column in schema["columns"]), rows[-1]["values"], strict=True))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cpu", type=Path, required=True)
    parser.add_argument("--gpu", type=Path, required=True)
    args = parser.parse_args()
    cpu, gpu = final_values(args.cpu), final_values(args.gpu)
    for quantity, tolerance in (("mx", 1e-8), ("my", 1e-8), ("mz", 1e-8)):
        error = abs(float(cpu[quantity]) - float(gpu[quantity]))
        if not math.isfinite(error) or error > tolerance:
            raise ValueError(f"{quantity} CPU/GPU error {error:.6e} exceeds {tolerance:.1e}")
    for run in (args.cpu, args.gpu):
        manifest = json.loads((run / "regional_field_drive.v1.json").read_text())
        if manifest["precision"] != "double" or manifest["drive_count"] < 1:
            raise ValueError(f"{run}: missing double regional-drive provenance")
    print("PASS: managed FEM CPU/GPU double regional-drive parity")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
