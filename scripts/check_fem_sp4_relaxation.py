#!/usr/bin/env python3
"""Fail-closed readiness check for a completed FEM SP4 relaxation bundle."""

from __future__ import annotations

import json
from pathlib import Path
import sys


TORQUE_LIMIT_T = 1e-5


def relaxation_is_ready(artifacts: Path) -> bool:
    try:
        metadata = json.loads((artifacts / "metadata.json").read_text())
        if not (artifacts / "m_final.json").is_file():
            return False
        qualification = metadata.get("fem_gpu_relaxation_qualification")
        if not isinstance(qualification, dict):
            qualification = metadata.get("fem_cpu_relaxation_qualification")
        return (
            isinstance(qualification, dict)
            and qualification.get("converged") is True
            and float(qualification["final_torque_t"]) <= TORQUE_LIMIT_T
        )
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
        return False


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: check_fem_sp4_relaxation.py ARTIFACTS", file=sys.stderr)
        return 2
    return 0 if relaxation_is_ready(Path(sys.argv[1])) else 1


if __name__ == "__main__":
    raise SystemExit(main())
