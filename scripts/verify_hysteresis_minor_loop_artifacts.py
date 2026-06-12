#!/usr/bin/env python3
"""Validate branch-only hysteresis minor-loop artifacts."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any


EXPECTED_REVERSAL_MT = 50.0
EXPECTED_RETURN_MT = -25.0


def load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def require_number(value: Any, field: str) -> float:
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise SystemExit(f"{field} must be a finite number, got {value!r}")
    return float(value)


def require_close(value: Any, expected: float, field: str) -> None:
    actual = require_number(value, field)
    if abs(actual - expected) > 1e-9:
        raise SystemExit(f"{field} mismatch: {actual} != {expected}")


def require_point(point: Any, field_value_mT: float, loop_id: str, field: str) -> None:
    if not isinstance(point, dict):
        raise SystemExit(f"{field} must be an object, got {point!r}")
    require_close(point.get("field_value_mT"), field_value_mT, f"{field}.field_value_mT")
    if point.get("minor_loop_id") != loop_id:
        raise SystemExit(
            f"{field}.minor_loop_id must be {loop_id!r}, got {point.get('minor_loop_id')!r}"
        )
    if point.get("protocol_role") != "minor":
        raise SystemExit(
            f"{field}.protocol_role must be 'minor', got {point.get('protocol_role')!r}"
        )
    m_avg = point.get("m_avg")
    if not isinstance(m_avg, list) or len(m_avg) != 3:
        raise SystemExit(f"{field}.m_avg must contain 3 components")
    require_number(point.get("m_parallel"), f"{field}.m_parallel")
    require_number(point.get("m_oop"), f"{field}.m_oop")
    require_number(point.get("m_ip"), f"{field}.m_ip")


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit(
            "usage: scripts/verify_hysteresis_minor_loop_artifacts.py <artifact-dir>"
        )

    root = Path(sys.argv[1])
    minor_path = root / "hysteresis_minor_loops.json"
    points_path = root / "hysteresis_points.json"
    if not minor_path.is_file():
        raise SystemExit(f"missing minor-loop artifact: {minor_path}")
    if not points_path.is_file():
        raise SystemExit(f"missing major-loop points artifact: {points_path}")

    loops = load_json(minor_path)
    major_points = load_json(points_path)
    if not isinstance(loops, list) or len(loops) != 1:
        raise SystemExit(f"expected one minor loop, got {loops!r}")
    if not isinstance(major_points, list) or len(major_points) < 3:
        raise SystemExit("major-loop artifact must contain at least 3 points")

    loop = loops[0]
    if not isinstance(loop, dict):
        raise SystemExit(f"minor loop must be an object, got {loop!r}")
    loop_id = loop.get("loop_id")
    if loop_id != "minor_loop_001":
        raise SystemExit(f"unexpected minor loop id {loop_id!r}")
    if loop.get("policy") != "branch_only":
        raise SystemExit(f"minor loop policy must be branch_only, got {loop.get('policy')!r}")
    if loop.get("closure_status") != "returned":
        raise SystemExit(
            f"minor loop closure_status must be returned, got {loop.get('closure_status')!r}"
        )
    require_close(loop.get("reversal_field_mT"), EXPECTED_REVERSAL_MT, "reversal_field_mT")
    require_close(loop.get("return_field_mT"), EXPECTED_RETURN_MT, "return_field_mT")
    if loop.get("reversal_point_id") != 0 or loop.get("return_point_id") != 1:
        raise SystemExit(
            "minor loop must use branch-local reversal_point_id=0 and return_point_id=1"
        )

    points = loop.get("points")
    if not isinstance(points, list) or len(points) != 2:
        raise SystemExit(f"minor loop must contain two branch points, got {points!r}")
    require_point(points[0], EXPECTED_REVERSAL_MT, loop_id, "points[0]")
    require_point(points[1], EXPECTED_RETURN_MT, loop_id, "points[1]")

    settle_trace = loop.get("settle_trace")
    if not isinstance(settle_trace, list) or not settle_trace:
        raise SystemExit("minor loop must contain a non-empty settle_trace")
    require_close(
        settle_trace[0].get("field_value_mT"),
        EXPECTED_RETURN_MT,
        "settle_trace[0].field_value_mT",
    )
    if loop.get("closure_error_m_parallel") is not None:
        require_number(loop.get("closure_error_m_parallel"), "closure_error_m_parallel")
    if loop.get("recoil_susceptibility") is not None:
        require_number(loop.get("recoil_susceptibility"), "recoil_susceptibility")
    if loop.get("minor_loop_area") is not None:
        require_number(loop.get("minor_loop_area"), "minor_loop_area")

    print(
        "validated hysteresis minor loop: "
        f"loop_id={loop_id} policy=branch_only points={len(points)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
