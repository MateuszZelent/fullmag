#!/usr/bin/env python3
"""Print recommended FMR refinement frequencies for the next response sweep."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path


def fail(message: str) -> None:
    raise SystemExit(f"invalid FMR refinement recommendation:\n{message}")


def load_json(path: Path) -> dict:
    if not path.is_file():
        fail(f"missing required artifact: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        fail(f"{path} must contain a JSON object")
    return value


def resolve_peak_mode_path(path: Path) -> Path:
    if path.is_file():
        return path
    return path / "response" / "derived_modes" / "fmr_peak_mode.v1.json"


def format_ghz(value_hz: object) -> str:
    if not isinstance(value_hz, (int, float)) or not math.isfinite(float(value_hz)):
        fail("recommended_frequencies_hz must contain finite numbers")
    value_ghz = float(value_hz) / 1.0e9
    return f"{value_ghz:.12g}"


def recommended_frequency_csv(path: Path) -> str:
    peak_mode = load_json(resolve_peak_mode_path(path))
    recommendation = peak_mode.get("refinement_recommendation")
    if not isinstance(recommendation, dict):
        fail("refinement_recommendation must be an object")
    frequencies = recommendation.get("recommended_frequencies_hz")
    if not isinstance(frequencies, list) or not frequencies:
        fail("recommended_frequencies_hz must be a non-empty list")
    return ",".join(format_ghz(value) for value in frequencies)


def main() -> int:
    args = sys.argv[1:]
    shell_export = False
    if "--shell-export" in args:
        shell_export = True
        args.remove("--shell-export")
    if len(args) != 1:
        raise SystemExit(
            "usage: scripts/fem_frequency_response_refinement_env.py "
            "[--shell-export] <artifacts-dir-or-fmr-peak-mode-json>"
        )
    csv = recommended_frequency_csv(Path(args[0]))
    if shell_export:
        print(f"export FULLMAG_FMR_FREQUENCIES_GHZ={csv}")
    else:
        print(csv)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
