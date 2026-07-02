#!/usr/bin/env python3
"""Tests for deriving driven FMR mode candidates from response artifacts."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DERIVER = REPO_ROOT / "scripts" / "derive_fem_frequency_response_modes.py"


def write_response_fixture(root: Path) -> None:
    (root / "response" / "frequency_points").mkdir(parents=True)
    (root / "response" / "field_payloads.zarr").mkdir(parents=True)
    points = []
    payload_paths = []
    amplitudes = [0.25, 2.5, 0.75]
    frequencies = [2.5e9, 2.75e9, 3.0e9]
    for index, (frequency_hz, amplitude) in enumerate(zip(frequencies, amplitudes)):
        payload_path = (
            f"response/field_payloads.zarr/frequency_{index:04d}/"
            "vector_xyz_complex/0.0.0"
        )
        point_path = f"response/frequency_points/frequency_{index:04d}.json"
        payload_file = root / payload_path
        payload_file.parent.mkdir(parents=True, exist_ok=True)
        payload_file.write_bytes(b"\x00" * 48)
        payload_paths.append(payload_path)
        point = {
            "schema_version": "frequency_response_point.v1",
            "frequency_index": index,
            "frequency_hz": frequency_hz,
            "angular_frequency_rad_per_s": frequency_hz * 6.283185307179586,
            "response_amplitude": amplitude,
            "field_payload_path": payload_path,
        }
        (root / point_path).write_text(json.dumps(point), encoding="utf-8")
        points.append(
            {
                "frequency_index": index,
                "frequency_hz": frequency_hz,
                "response_amplitude": amplitude,
                "frequency_point_artifact_path": point_path,
                "response_field_payload_path": payload_path,
            }
        )
    sweep = {
        "schema_version": "magnetic_response_sweep.v2",
        "complete": True,
        "completed_frequency_point_count": len(points),
        "frequency_point_artifact_paths": [
            f"response/frequency_points/frequency_{index:04d}.json"
            for index in range(len(points))
        ],
        "response_field_payload_paths": payload_paths,
        "points": points,
    }
    (root / "response" / "magnetic_response_sweep.v2.json").write_text(
        json.dumps(sweep),
        encoding="utf-8",
    )


def test_derives_peak_response_mode_candidate(tmp_path: Path) -> None:
    write_response_fixture(tmp_path)

    result = subprocess.run(
        [sys.executable, str(DERIVER), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    output_path = tmp_path / "response" / "derived_modes" / "fmr_peak_mode.v1.json"
    payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert payload["schema_version"] == "frequency_response_derived_mode.v1"
    assert payload["source"] == "magnetic_response_sweep.v2"
    assert payload["selection"] == "max_response_amplitude"
    assert payload["frequency_index"] == 1
    assert payload["frequency_hz"] == 2.75e9
    assert payload["response_amplitude"] == 2.5
    assert (
        payload["field_payload_path"]
        == "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0"
    )
    assert (
        payload["frequency_point_artifact_path"]
        == "response/frequency_points/frequency_0001.json"
    )
    assert payload["interpretation"] == "driven_response_field_at_peak_frequency"
    assert payload["provenance"] == {
        "canonical_product": "frequency_response",
        "derivation_method": "select_max_response_amplitude",
        "not_an_eigenmode": True,
        "schema_version": "frequency_response_derived_mode_provenance.v1",
        "selected_field_payload_path": "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0",
        "selected_frequency_hz": 2.75e9,
        "selected_frequency_index": 1,
        "selected_frequency_point_artifact_path": "response/frequency_points/frequency_0001.json",
        "selected_response_amplitude": 2.5,
        "selected_sweep_point_index": 1,
        "selection_metric": "response_amplitude",
        "source_artifact_path": "response/magnetic_response_sweep.v2.json",
        "source_schema_version": "magnetic_response_sweep.v2",
    }
    assert payload["refinement_recommendation"] == {
        "schema_version": "frequency_response_peak_refinement.v1",
        "strategy": "local_peak_window",
        "peak_position": "interior",
        "recommended_frequency_count": 5,
        "frequency_spacing_hz": 250000000.0,
        "recommended_frequencies_hz": [
            2625000000.0,
            2687500000.0,
            2750000000.0,
            2812500000.0,
            2875000000.0,
        ],
    }


def test_recommends_next_sweep_above_upper_boundary_peak(tmp_path: Path) -> None:
    write_response_fixture(tmp_path)
    sweep_path = tmp_path / "response" / "magnetic_response_sweep.v2.json"
    sweep = json.loads(sweep_path.read_text(encoding="utf-8"))
    for point, amplitude in zip(sweep["points"], [0.25, 0.75, 2.5]):
        point["response_amplitude"] = amplitude
    sweep_path.write_text(json.dumps(sweep), encoding="utf-8")

    result = subprocess.run(
        [sys.executable, str(DERIVER), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    output_path = tmp_path / "response" / "derived_modes" / "fmr_peak_mode.v1.json"
    payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert payload["frequency_index"] == 2
    assert payload["refinement_recommendation"] == {
        "schema_version": "frequency_response_peak_refinement.v1",
        "strategy": "local_peak_window",
        "peak_position": "upper_boundary",
        "recommended_frequency_count": 5,
        "frequency_spacing_hz": 250000000.0,
        "recommended_frequencies_hz": [
            3000000000.0,
            3125000000.0,
            3250000000.0,
            3375000000.0,
            3500000000.0,
        ],
    }


def test_rejects_peak_without_field_payload(tmp_path: Path) -> None:
    write_response_fixture(tmp_path)
    (
        tmp_path
        / "response"
        / "field_payloads.zarr"
        / "frequency_0001"
        / "vector_xyz_complex"
        / "0.0.0"
    ).unlink()

    result = subprocess.run(
        [sys.executable, str(DERIVER), str(tmp_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode != 0
    assert "peak response field payload is missing" in (result.stderr + result.stdout)
