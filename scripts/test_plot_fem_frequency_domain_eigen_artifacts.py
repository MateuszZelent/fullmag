#!/usr/bin/env python3
"""Tests for FEM frequency-domain eigen artifact plotting."""

from __future__ import annotations

import json
import struct
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
PLOTTER = REPO_ROOT / "scripts" / "plot_fem_frequency_domain_eigen_artifacts.py"


def write_plot_fixture(root: Path) -> None:
    (root / "eigen" / "modes" / "sample_0000").mkdir(parents=True)
    (root / "eigen" / "mode_fields" / "sample_0000" / "mode_0000").mkdir(parents=True)

    spectrum = {
        "schema_version": "eigen_spectrum.v2",
        "samples": [
            {
                "sample_index": 0,
                "label": "G",
                "k_vector": [0.0, 0.0, 0.0],
                "modes": [
                    {
                        "raw_mode_index": 0,
                        "frequency_real_hz": 1.25e9,
                        "frequency_imag_hz": 0.0,
                        "residual_norm": 1.0e-9,
                    }
                ],
            }
        ],
    }
    (root / "eigen" / "spectrum.v2.json").write_text(json.dumps(spectrum), encoding="utf-8")

    mode = {
        "schema_version": "2",
        "sample_index": 0,
        "raw_mode_index": 0,
        "frequency_real_hz": 1.25e9,
        "mode_field_sample_count": 2,
    }
    (root / "eigen" / "modes" / "sample_0000" / "mode_0000.json").write_text(
        json.dumps(mode),
        encoding="utf-8",
    )

    # Per node: mx.real, mx.imag, my.real, my.imag, mz.real, mz.imag.
    payload = [
        1.0,
        0.0,
        0.0,
        1.0,
        0.5,
        0.5,
        -1.0,
        0.0,
        0.0,
        -1.0,
        0.25,
        -0.25,
    ]
    (root / "eigen" / "mode_fields" / "sample_0000" / "mode_0000" / "vector.bin").write_bytes(
        struct.pack("<" + "d" * len(payload), *payload)
    )


def test_plotter_writes_spectrum_and_mode_view_svgs(tmp_path: Path) -> None:
    write_plot_fixture(tmp_path)
    output_dir = tmp_path / "plots"

    result = subprocess.run(
        [
            sys.executable,
            str(PLOTTER),
            str(tmp_path),
            "--output-dir",
            str(output_dir),
            "--modes",
            "0",
        ],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    assert (output_dir / "spectrum.svg").is_file()
    for view in ["real", "imag", "complex", "abs", "phase"]:
        path = output_dir / f"mode_sample_0000_mode_0000_{view}.svg"
        assert path.is_file()
        text = path.read_text(encoding="utf-8")
        assert "<svg" in text
        assert view in text
    animation = output_dir / "mode_sample_0000_mode_0000_animation.svg"
    assert animation.is_file()
    animation_text = animation.read_text(encoding="utf-8")
    assert "<animate" in animation_text
    assert "phase-rotated" in animation_text
