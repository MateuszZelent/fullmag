"""Contract tests for an honest frequency-only A1 comparison."""

from __future__ import annotations

import csv
import hashlib
import json
import math
from pathlib import Path

import pytest

from compare_comsol_a1_frequency_reference import (
    _verify_managed_a1,
    compare_frequencies,
    plot_comparison,
    read_reference,
)


def write_reference(path: Path) -> None:
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(("jpath", "kx_rad_per_um", "ky_rad_per_um", "frequency_order", "frequency_GHz"))
        for sample in range(61):
            x = math.pi / 0.2 * (sample / 20 if sample <= 20 else 1 if sample <= 40 else (60 - sample) / 20)
            y = math.pi / 0.2 * (0 if sample <= 20 else (sample - 20) / 20 if sample <= 40 else (60 - sample) / 20)
            for order in range(1, 25):
                writer.writerow((sample, f"{x:.9f}", f"{y:.9f}", order, f"{order + 8:.6f}"))


def write_numeric(path: Path, *, sample: int = 20, kx_offset: float = 0.0) -> None:
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(("sample_index", "raw_mode_index", "branch_id", "kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m", "frequency_hz", "residual_norm"))
        # Deliberately unordered raw modes and misleading branch IDs: matching
        # must use the local sorted spectrum, not either identifier.
        for mode, hz in ((99, 10e9), (3, 9e9)):
            writer.writerow((sample, mode, 123 - mode, math.pi / 0.2 * 1e6 + kx_offset, 0, 0, hz, 1e-10))


def test_comparison_matches_local_spectrum_without_claiming_branches(tmp_path: Path) -> None:
    reference = tmp_path / "reference.csv"
    numeric = tmp_path / "numeric.csv"
    write_reference(reference)
    write_numeric(numeric)
    report = compare_frequencies(read_reference(reference), numeric)
    assert report["status"] == "frequency_only_unqualified"
    assert report["sample_count"] == 1
    assert report["samples"][0]["sample_index"] == 20
    assert report["samples"][0]["matches"][0]["raw_mode_index"] == 3
    assert report["samples"][0]["matches"][0]["comsol_frequency_hz"] == 9e9
    assert report["samples"][0]["missing_comsol_modes"] == 22


def test_reference_rejects_duplicate_or_missing_modes(tmp_path: Path) -> None:
    reference = tmp_path / "reference.csv"
    write_reference(reference)
    rows = reference.read_text(encoding="utf-8").splitlines()
    reference.write_text("\n".join(rows[:-1]) + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="24"):
        read_reference(reference)


def test_comparison_rejects_wrong_wave_vector(tmp_path: Path) -> None:
    reference = tmp_path / "reference.csv"
    numeric = tmp_path / "numeric.csv"
    write_reference(reference)
    write_numeric(numeric, kx_offset=1e5)
    with pytest.raises(ValueError, match="wave vector"):
        compare_frequencies(read_reference(reference), numeric)


def test_managed_binding_rejects_tampered_numeric_csv(tmp_path: Path) -> None:
    case = tmp_path / "a1"
    (case / "eigen").mkdir(parents=True)
    numeric = case / "eigen/dispersion.csv"
    write_numeric(numeric)
    digest = hashlib.sha256(numeric.read_bytes()).hexdigest()
    (tmp_path / "run-result.json").write_text(json.dumps({
        "schema": "fullmag.comsol-dispersion-benchmark.result.v1",
        "status": "completed_unqualified",
        "return_code": 0,
        "cases": [{"case": "a1", "required_artifact_hashes": {"eigen/dispersion.csv": {"sha256": digest}}}],
    }), encoding="utf-8")
    (case / "metadata.json").write_text(json.dumps({"problem_meta": {"runtime_metadata": {
        "comsol_nonzero_k_dispersion": {
            "schema_version": "fullmag.comsol_nonzero_k_benchmark.v1",
            "benchmark_id": "comsol-py-antidot-square-v1", "case_id": "a1",
            "geometry": {"lattice_period_m": 200e-9, "hole_radius_m": 50e-9, "film_size_m": [200e-9, 200e-9, 10e-9], "air_padding_each_side_m": 2e-6},
            "material": {"Ms_A_per_m": 8e5, "Aex_J_per_m": 13e-12, "gamma_m_per_A_s": 2.211e5},
        }
    }}}), encoding="utf-8")
    assert _verify_managed_a1(case)["status"] == "completed_unqualified"
    numeric.write_text(numeric.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="artifact hash"):
        _verify_managed_a1(case)


def test_provisional_plot_shows_reference_and_fullmag_points(tmp_path: Path) -> None:
    reference_path = tmp_path / "reference.csv"
    numeric_path = tmp_path / "numeric.csv"
    write_reference(reference_path)
    write_numeric(numeric_path)
    reference = read_reference(reference_path)
    report = compare_frequencies(reference, numeric_path)
    image_path = tmp_path / "comparison.png"
    plot_comparison(reference, report, image_path)
    assert image_path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
