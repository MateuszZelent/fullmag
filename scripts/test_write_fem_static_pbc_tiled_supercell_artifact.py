#!/usr/bin/env python3
"""Tests for same-local tiled FEM static PBC supercell fixtures."""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

from test_compare_fem_static_pbc_equilibrium_artifacts import (
    add_metadata_mesh,
    write_artifacts,
    write_node_geometry,
)


SCRIPT = Path("scripts/write_fem_static_pbc_tiled_supercell_artifact.py")
COMPARE_SCRIPT = Path("scripts/compare_fem_static_pbc_equilibrium_artifacts.py")


def run_script(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        text=True,
        capture_output=True,
        check=False,
    )


def run_compare(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(COMPARE_SCRIPT), *args],
        text=True,
        capture_output=True,
        check=False,
    )


def write_unit_artifact(root: Path) -> None:
    nodes = [
        [-4.0e-8, -4.0e-8, 0.0],
        [4.0e-8, -4.0e-8, 0.0],
        [-4.0e-8, 4.0e-8, 0.0],
        [0.0, 0.0, 3.0e-8],
    ]
    write_artifacts(
        root,
        e_demag=1.0e-18,
        final_torque=4.0e3,
        m_initial_values=[
            [0.0, 1.0, 0.0],
            [0.01, 0.99, 0.0],
            [0.02, 0.98, 0.0],
            [0.03, 0.97, 0.0],
        ],
        m_values=[
            [1.0, 0.0, 0.0],
            [0.99, 0.01, 0.0],
            [0.98, 0.02, 0.0],
            [0.97, 0.03, 0.0],
        ],
        h_values=[
            10.0,
            20.0,
            30.0,
            40.0,
            1.0,
            2.0,
            3.0,
            4.0,
            0.0,
            0.0,
            0.0,
            0.0,
        ],
        h_initial_values=[
            100.0,
            200.0,
            300.0,
            400.0,
            10.0,
            20.0,
            30.0,
            40.0,
            0.0,
            0.0,
            0.0,
            0.0,
        ],
        phi_values=[1.0e-3, 2.0e-3, 3.0e-3, 4.0e-3],
        phi_initial_values=[10.0e-3, 20.0e-3, 30.0e-3, 40.0e-3],
    )
    write_node_geometry(root, magnetic_node_mask=[True, True, True, True], nodes_m=nodes)
    add_metadata_mesh(
        root,
        nodes=nodes,
        elements=[[0, 1, 2, 3]],
        element_markers=[1],
    )
    metadata_path = root / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata.setdefault("execution_plan", {}).setdefault("backend_plan", {})["material"] = {
        "saturation_magnetisation": 8.0e5,
    }
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")


def test_tiled_supercell_fixture_passes_strict_same_local_comparator(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report = tmp_path / "reports" / "supercell_validation.v1.json"
    write_unit_artifact(unit)

    result = run_script(
        "--unit-cell",
        str(unit),
        "--output",
        str(supercell),
        "--repeat-x",
        "3",
        "--repeat-y",
        "3",
    )

    assert result.returncode == 0, result.stderr
    metadata = json.loads((supercell / "metadata.json").read_text(encoding="utf-8"))
    assert metadata["periodic_antidot_relaxation"]["universe_size_m"] == [6.0e-7, 6.0e-7, 9.0e-8]
    assert metadata["periodic_antidot_relaxation"]["supercell_repeat"] == [3, 3]
    assert metadata["periodic_antidot_relaxation"]["tiled_same_local_fixture"] is True
    assert math.isclose(
        metadata["fem_cpu_relaxation_qualification"]["final_energy_terms_j"]["E_demag"],
        9.0e-18,
        rel_tol=1.0e-15,
    )
    assert len(json.loads((supercell / "m_final.json").read_text(encoding="utf-8"))["values"]) == 36

    fixture = json.loads(
        (supercell / "diagnostics" / "fem_static_pbc_tiled_supercell_fixture.v1.json").read_text(encoding="utf-8")
    )
    assert fixture["status"] == "diagnostic_fixture"
    assert fixture["not_a_runtime_solve"] is True

    compare = run_compare(
        "supercell",
        "--unit-cell",
        str(unit),
        "--supercell",
        str(supercell),
        "--repeat-x",
        "3",
        "--repeat-y",
        "3",
        "--report",
        str(report),
    )

    assert compare.returncode == 0, compare.stderr
    payload = json.loads(report.read_text(encoding="utf-8"))
    assert payload["status"] == "ok"
    assert payload["mapped_central_cell_comparability"]["same_local_discretization"] is True
    assert payload["metrics"]["mapped_max_nearest_field_node_distance_m"] < 1.0e-20
    assert payload["metrics"]["mapped_max_nearest_magnetic_node_distance_m"] < 1.0e-20
    assert payload["metrics"]["mapped_m_p99_l2_delta"] == 0.0
    assert payload["metrics"]["mapped_h_demag_p99_relative_error"] == 0.0
    assert payload["metrics"]["mapped_demag_phi_max_abs_delta_after_offset_A"] == 0.0


def test_tiled_supercell_fixture_preserves_initial_state_and_field_samples(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report = tmp_path / "reports" / "supercell_initial_validation.v1.json"
    write_unit_artifact(unit)

    result = run_script(
        "--unit-cell",
        str(unit),
        "--output",
        str(supercell),
        "--repeat-x",
        "3",
        "--repeat-y",
        "3",
    )

    assert result.returncode == 0, result.stderr
    assert len(json.loads((supercell / "m_initial.json").read_text(encoding="utf-8"))["values"]) == 36
    h_array = json.loads((supercell / "fields" / "H_demag.zarr" / ".zarray").read_text(encoding="utf-8"))
    assert h_array["shape"] == [2, 3, 36]
    h_samples = (supercell / "fields" / "H_demag.zarr" / "samples.csv").read_text(encoding="utf-8")
    assert "0,0,0.0,0.0,0.0.0" in h_samples
    assert "1,4,0.0,0.0,1.0.0" in h_samples

    compare = run_compare(
        "supercell",
        "--unit-cell",
        str(unit),
        "--supercell",
        str(supercell),
        "--repeat-x",
        "3",
        "--repeat-y",
        "3",
        "--state",
        "initial",
        "--report",
        str(report),
    )

    assert compare.returncode == 0, compare.stderr
    payload = json.loads(report.read_text(encoding="utf-8"))
    assert payload["status"] == "ok"
    assert payload["comparison_state"] == "initial"
    assert payload["metrics"]["mapped_m_p99_l2_delta"] == 0.0
    assert payload["metrics"]["mapped_h_demag_p99_relative_error"] == 0.0
    assert payload["metrics"]["mapped_demag_phi_max_abs_delta_after_offset_A"] == 0.0
