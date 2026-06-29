#!/usr/bin/env python3
"""Tests for exporting FMR refinement frequencies as runtime env input."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "fem_frequency_response_refinement_env.py"


def write_peak_mode(root: Path, frequencies_hz: list[float]) -> Path:
    path = root / "response" / "derived_modes" / "fmr_peak_mode.v1.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "schema_version": "frequency_response_derived_mode.v1",
                "source": "magnetic_response_sweep.v2",
                "selection": "max_response_amplitude",
                "mode_label": "driven_response_peak_0000",
                "frequency_index": 1,
                "frequency_hz": 2.75e9,
                "response_amplitude": 2.5e-9,
                "frequency_point_artifact_path": "response/frequency_points/frequency_0001.json",
                "field_payload_path": (
                    "response/field_payloads.zarr/frequency_0001/"
                    "vector_xyz_complex/0.0.0"
                ),
                "interpretation": "driven_response_field_at_peak_frequency",
                "refinement_recommendation": {
                    "schema_version": "frequency_response_peak_refinement.v1",
                    "strategy": "local_peak_window",
                    "peak_position": "interior",
                    "recommended_frequency_count": len(frequencies_hz),
                    "frequency_spacing_hz": 250000000.0,
                    "recommended_frequencies_hz": frequencies_hz,
                },
            }
        ),
        encoding="utf-8",
    )
    return path


def run_script(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def test_prints_refinement_frequencies_as_ghz_csv(tmp_path: Path) -> None:
    write_peak_mode(tmp_path, [2.625e9, 2.6875e9, 2.75e9, 2.8125e9, 2.875e9])

    result = run_script(str(tmp_path))

    assert result.returncode == 0, result.stderr + result.stdout
    assert result.stdout.strip() == "2.625,2.6875,2.75,2.8125,2.875"


def test_prints_shell_export_when_requested(tmp_path: Path) -> None:
    write_peak_mode(tmp_path, [2.625e9, 2.6875e9])

    result = run_script("--shell-export", str(tmp_path))

    assert result.returncode == 0, result.stderr + result.stdout
    assert result.stdout.strip() == "export FULLMAG_FMR_FREQUENCIES_GHZ=2.625,2.6875"


def test_rejects_missing_recommended_frequencies(tmp_path: Path) -> None:
    write_peak_mode(tmp_path, [])

    result = run_script(str(tmp_path))

    assert result.returncode != 0
    assert "recommended_frequencies_hz must be a non-empty list" in (
        result.stderr + result.stdout
    )
