#!/usr/bin/env python3
"""Compare one explicit MuMax3 and Fullmag relaxed magnetization state."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from fullmag.analysis.magnetization_comparison import compare_relaxed_states


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Compare final MuMax3 and Fullmag magnetization textures."
    )
    parser.add_argument("--mumax", required=True, type=Path, help="MuMax3 m Zarr bundle")
    parser.add_argument(
        "--fullmag-state",
        required=True,
        type=Path,
        help="Fullmag relaxed_m.zarr(.zip) state artifact",
    )
    parser.add_argument(
        "--fullmag-mesh",
        required=True,
        type=Path,
        help="Fullmag .fullmag-mesh artifact used by the relaxation",
    )
    parser.add_argument(
        "--fullmag-run-bundle",
        required=True,
        type=Path,
        help="Fullmag run bundle containing the native planner mesh ordering",
    )
    parser.add_argument("--output", type=Path, help="Write the JSON report to this path")
    parser.add_argument(
        "--high-error-threshold",
        type=float,
        default=1.0e-3,
        help="Vector error threshold used for the high-error fraction",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    report = compare_relaxed_states(
        args.mumax,
        fullmag_state_path=args.fullmag_state,
        fullmag_mesh_path=args.fullmag_mesh,
        fullmag_run_bundle=args.fullmag_run_bundle,
        high_error_threshold=args.high_error_threshold,
    )
    payload = json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n"
    if args.output is None:
        sys.stdout.write(payload)
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
