#!/usr/bin/env python3
"""Tests for FEM frequency-domain eigen artifact plotting."""

from __future__ import annotations

import csv
import importlib.util
import json
import struct
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
PLOTTER = REPO_ROOT / "scripts" / "plot_fem_frequency_domain_eigen_artifacts.py"


def load_plotter_module():
    spec = importlib.util.spec_from_file_location("plot_fem_frequency_domain_eigen_artifacts", PLOTTER)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_plot_fixture(root: Path) -> None:
    (root / "eigen" / "modes" / "sample_0000").mkdir(parents=True)
    (root / "eigen" / "mode_fields" / "sample_0000" / "mode_0000").mkdir(parents=True)
    zarr_array_dir = (
        root
        / "eigen"
        / "mode_fields.zarr"
        / "sample_0000"
        / "mode_0000"
        / "vector_xyz_complex"
    )
    zarr_array_dir.mkdir(parents=True)

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
                        "frequency_hz": 1.25e9,
                        "frequency_real_hz": 1.25e9,
                        "frequency_imag_hz": 0.0,
                        "residual_norm": 1.0e-9,
                    }
                ],
            }
        ],
    }
    (root / "eigen" / "spectrum.v2.json").write_text(json.dumps(spectrum), encoding="utf-8")
    (root / "eigen" / "dispersion.csv").write_text(
        "\n".join(
            [
                (
                    "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,"
                    "kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,"
                    "omega_rad_s,analytic_frequency_hz,relative_error,"
                    "validation_geometry,line_width_hz,residual_norm,overlap_score,"
                    "tracking_score_source,mode_field_id,mode_field_resource_key"
                ),
                (
                    "0,0,0,0,0,G,0,0,1250000000,7853981633.974483,"
                    "1249000000,8.006405124099279e-4,backward_volume,"
                    ",1.0e-9,,seed,analysis:eigen:sample-0000:mode-0000,"
                    "/v2/sessions/current/data/fields/analysis:eigen:sample-0000:mode-0000/samples/vector?view=phase_rotated_real&phase_rad=0"
                ),
                (
                    "1,10000000,10000000,0,0,,0,0,1325000000,8325220532.012,"
                    "1324000000,7.547169811320755e-4,backward_volume,"
                    ",1.0e-9,0.8,modal_overlap_weighted_score,analysis:eigen:sample-0001:mode-0000,"
                    "/v2/sessions/current/data/fields/analysis:eigen:sample-0001:mode-0000/samples/vector?view=phase_rotated_real&phase_rad=0"
                ),
                (
                    "2,20000000,20000000,0,0,X,0,0,1500000000,9424777960.76938,"
                    "1498000000,1.3333333333333333e-3,backward_volume,"
                    ",1.0e-9,0.7,modal_overlap_weighted_score,analysis:eigen:sample-0002:mode-0000,"
                    "/v2/sessions/current/data/fields/analysis:eigen:sample-0002:mode-0000/samples/vector?view=phase_rotated_real&phase_rad=0"
                ),
            ]
        ),
        encoding="utf-8",
    )

    mode = {
        "schema_version": "2",
        "sample_index": 0,
        "raw_mode_index": 0,
        "frequency_hz": 1.25e9,
        "frequency_real_hz": 1.25e9,
        "mode_field_sample_count": 2,
        "zarr_chunk_path": "eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex/0.0.0",
        "compatibility_binary_payload_path": "eigen/mode_fields/sample_0000/mode_0000/vector.bin",
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
    (zarr_array_dir / ".zarray").write_text(
        json.dumps(
            {
                "zarr_format": 2,
                "shape": [2, 3, 2],
                "chunks": [2, 3, 2],
                "dtype": "<f8",
                "order": "C",
            }
        ),
        encoding="utf-8",
    )
    (zarr_array_dir / "0.0.0").write_bytes(struct.pack("<" + "d" * len(payload), *payload))


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


def test_plotter_prefers_zarr_mode_payload(tmp_path: Path) -> None:
    write_plot_fixture(tmp_path)
    binary_payload = (
        tmp_path
        / "eigen"
        / "mode_fields"
        / "sample_0000"
        / "mode_0000"
        / "vector.bin"
    )
    binary_payload.unlink()
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
    assert (output_dir / "mode_sample_0000_mode_0000_complex.svg").is_file()


def test_plotter_writes_dispersion_png_from_csv(tmp_path: Path) -> None:
    write_plot_fixture(tmp_path)
    output_png = tmp_path / "dyspersje.png"

    result = subprocess.run(
        [
            sys.executable,
            str(PLOTTER),
            str(tmp_path),
            "--output-dir",
            str(tmp_path / "plots"),
            "--modes",
            "0",
            "--dispersion-png",
            str(output_png),
        ],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    assert output_png.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    load_plotter_module().validate_rendered_png(output_png)


def test_plotter_reads_analytic_dispersion_overlay_columns(tmp_path: Path) -> None:
    write_plot_fixture(tmp_path)
    module = load_plotter_module()
    rows = list(
        csv.DictReader(
            (tmp_path / "eigen" / "dispersion.csv").read_text(encoding="utf-8").splitlines()
        )
    )

    assert module.analytic_dispersion_points(rows) == [
        (0.0, 1.249, "G", "backward_volume"),
        (10.0, 1.324, "", "backward_volume"),
        (20.0, 1.498, "X", "backward_volume"),
    ]
    assert max(module.relative_error_values(rows)) == 1.3333333333333333e-3


def test_png_validator_rejects_blank_dispersion_image(tmp_path: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    output_png = tmp_path / "blank.png"
    plt.imsave(output_png, [[[1.0, 1.0, 1.0, 1.0]] * 700] * 400)

    try:
        load_plotter_module().validate_rendered_png(output_png)
    except SystemExit as exc:
        assert "appears blank" in str(exc)
    else:
        raise AssertionError("blank PNG unexpectedly passed validation")
