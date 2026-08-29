#!/usr/bin/env python3
"""Verify only Frozen Spins authoring, Python DSL, and IR serialization.

This script deliberately does not claim backend runtime qualification.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run_cmd(command: list[str], description: str) -> bool:
    print(f"RUN: {description}: {' '.join(command)}")
    environment = os.environ.copy()
    environment["PYTHONIOENCODING"] = "utf-8"
    environment["PYTHONUTF8"] = "1"
    result = subprocess.run(
        command,
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=environment,
    )
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
    if result.stderr:
        print(result.stderr, end="" if result.stderr.endswith("\n") else "\n", file=sys.stderr)
    if result.returncode != 0:
        print(f"FAIL: {description} (exit code {result.returncode})")
        return False
    print(f"PASS: {description}")
    return True


def main() -> int:
    checks = (
        ([sys.executable, str(ROOT / "scripts" / "verify_frozen_spins_ir.py")], "IR serialization"),
        ([sys.executable, str(ROOT / "scripts" / "verify_frozen_spins_python.py")], "Python DSL"),
    )
    passed = all(run_cmd(command, description) for command, description in checks)
    if not passed:
        return 1
    print("PASS: Frozen Spins authoring/source checks completed")
    print("NOTE: backend runtime qualification was not executed by this script")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
