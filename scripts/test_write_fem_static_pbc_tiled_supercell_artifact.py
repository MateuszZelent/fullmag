#!/usr/bin/env python3
"""Tests for same-local tiled FEM static PBC supercell fixtures."""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

import pytest

from test_compare_fem_static_pbc_equilibrium_artifacts import (
    add_metadata_mesh,
    fragment_periodic_pairs_artifact,
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
    backend_mesh = metadata["execution_plan"]["backend_plan"]["mesh"]
    backend_mesh["boundary_faces"] = [[0, 1, 2] for _ in range(22)]
    backend_mesh["boundary_markers"] = list(range(22))
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

    periodic_pairs = json.loads(
        (supercell / "mesh" / "periodic_pairs.v1.json").read_text(encoding="utf-8")
    )
    assert periodic_pairs["certificate_status"] == "diagnostic_tiled_fixture"
    assert periodic_pairs["diagnostic_fixture_identity"]["realization"] == "independent_primitive_tiles"
    assert periodic_pairs["diagnostic_fixture_identity"]["repeat"] == [3, 3]
    assert periodic_pairs["paired_node_count"] == 36
    x_pair = next(pair for pair in periodic_pairs["pairs"] if pair["pair_id"] == "x_faces")
    assert x_pair["paired_node_count"] == 18
    assert x_pair["domain_node_pair_counts"] == {"magnetic": 9, "airbox": 9}
    assert len(x_pair["boundary_face_pairs"]) == 9
    assert x_pair["node_pairs"][:2] == [{"node_a": 0, "node_b": 1}, {"node_a": 2, "node_b": 3}]
    assert x_pair["node_pairs"][-2:] == [{"node_a": 32, "node_b": 33}, {"node_a": 34, "node_b": 35}]

    assert metadata["mesh"]["periodic_node_pair_count"] == 36
    assert metadata["mesh"]["periodic_node_pair_counts_by_id"] == {"x_faces": 18, "y_faces": 18}
    assert metadata["mesh"]["periodic_boundary_pair_count"] == 2
    assert metadata["mesh"]["periodic_boundary_pair_counts_by_id"] == {"x_faces": 1, "y_faces": 1}
    reduction = metadata["demag_runtime"]["periodic_reduction"]
    assert reduction["node_pair_count"] == 36
    assert reduction["node_pair_counts_by_id"] == {"x_faces": 18, "y_faces": 18}
    assert reduction["boundary_pair_count"] == 2
    assert reduction["boundary_pair_counts_by_id"] == {"x_faces": 1, "y_faces": 1}

    backend_mesh = metadata["execution_plan"]["backend_plan"]["mesh"]
    assert len(backend_mesh["boundary_faces"]) == 198
    assert len(backend_mesh["boundary_markers"]) == 198

    seams = json.loads(
        (supercell / "diagnostics" / "fem_static_pbc_demag_seams.v1.json").read_text(encoding="utf-8")
    )
    seam_by_id = {pair["pair_id"]: pair for pair in seams["pair_diagnostics"]}
    assert seam_by_id["x_faces"]["paired_node_count"] == 18
    assert seam_by_id["x_faces"]["boundary_face_pair_count"] == 9

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

    assert compare.returncode != 0
    assert "diagnostic tiled supercell fixture cannot produce physical convergence evidence" in compare.stderr
    assert not report.exists()


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
    assert payload["comparison_contract"]["status_semantics"] == "operator_consistency_gate_not_physical_supercell_convergence"
    assert payload["artifact_provenance"]["supercell"]["diagnostic_fixture"] is True
    assert payload["artifact_provenance"]["supercell"]["runtime_solve"] is False
    assert (
        payload["artifact_provenance"]["supercell"]["diagnostic_fixture_identity"]["sha256"]
        == json.loads(
            (supercell / "mesh" / "periodic_pairs.v1.json").read_text(encoding="utf-8")
        )["diagnostic_fixture_identity"]["sha256"]
    )


def test_tiled_supercell_fixture_preserves_fragmented_boundary_definitions(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    write_unit_artifact(unit)
    fragment_periodic_pairs_artifact(unit)
    seam_path = unit / "diagnostics" / "fem_static_pbc_demag_seams.v1.json"
    seams = json.loads(seam_path.read_text(encoding="utf-8"))
    fragmented_seams = []
    for diagnostic in seams["pair_diagnostics"]:
        for _ in range(3):
            fragment = json.loads(json.dumps(diagnostic))
            fragment["paired_node_count"] = 2
            fragment["boundary_face_pair_count"] = 1
            fragmented_seams.append(fragment)
    seams["pair_diagnostics"] = fragmented_seams
    seam_path.write_text(json.dumps(seams), encoding="utf-8")

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
    periodic_pairs = json.loads(
        (supercell / "mesh" / "periodic_pairs.v1.json").read_text(encoding="utf-8")
    )
    assert periodic_pairs["pair_count"] == 6
    assert periodic_pairs["paired_node_count"] == 108
    metadata = json.loads((supercell / "metadata.json").read_text(encoding="utf-8"))
    assert metadata["mesh"]["periodic_node_pair_count"] == 36
    assert metadata["mesh"]["periodic_node_pair_counts_by_id"] == {"x_faces": 18, "y_faces": 18}
    assert metadata["mesh"]["periodic_boundary_pair_count"] == 6
    assert metadata["mesh"]["periodic_boundary_pair_counts_by_id"] == {"x_faces": 3, "y_faces": 3}
    reduction = metadata["demag_runtime"]["periodic_reduction"]
    assert reduction["node_pair_count"] == 36
    assert reduction["boundary_pair_count"] == 6
    seams = json.loads(
        (supercell / "diagnostics" / "fem_static_pbc_demag_seams.v1.json").read_text(encoding="utf-8")
    )
    seam_by_id = {pair["pair_id"]: pair for pair in seams["pair_diagnostics"]}
    assert seam_by_id["x_faces"]["paired_node_count"] == 18
    assert seam_by_id["x_faces"]["boundary_face_pair_count"] == 9
    assert len(seams["pair_diagnostics"]) == 6
    assert all(
        pair["paired_node_count"] == 18 and pair["boundary_face_pair_count"] == 9
        for pair in seams["pair_diagnostics"]
    )

def test_tiled_supercell_fixture_rejects_first_node_index_outside_mesh(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    write_unit_artifact(unit)
    pairs_path = unit / "mesh" / "periodic_pairs.v1.json"
    payload = json.loads(pairs_path.read_text(encoding="utf-8"))
    payload["pairs"][0]["node_pairs"][0]["node_a"] = 4
    pairs_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_script(
        "--unit-cell", str(unit), "--output", str(supercell), "--repeat-x", "3", "--repeat-y", "3"
    )

    assert result.returncode != 0
    assert "node_a out of unit mesh range" in result.stderr


def test_tiled_supercell_fixture_rejects_first_face_index_outside_mesh(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    write_unit_artifact(unit)
    pairs_path = unit / "mesh" / "periodic_pairs.v1.json"
    payload = json.loads(pairs_path.read_text(encoding="utf-8"))
    payload["pairs"][1]["boundary_face_pairs"][0]["face_b"] = 22
    pairs_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_script(
        "--unit-cell", str(unit), "--output", str(supercell), "--repeat-x", "3", "--repeat-y", "3"
    )

    assert result.returncode != 0
    assert "face_b out of unit mesh boundary face range" in result.stderr


@pytest.mark.parametrize(
    ("target", "expected_error"),
    [
        ("coordinate", "metadata mesh nodes[0][0] must be numeric"),
        ("node_index", "node_a out of unit mesh range"),
        ("face_index", "face_a must be non-negative integer"),
        ("domain_count", "domain_node_pair_counts.magnetic must be non-negative"),
        ("seam_count", "paired_node_count must be positive"),
    ],
)
def test_tiled_supercell_fixture_rejects_boolean_numeric_fields(
    tmp_path: Path,
    target: str,
    expected_error: str,
) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    write_unit_artifact(unit)
    if target == "coordinate":
        metadata_path = unit / "metadata.json"
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        payload["execution_plan"]["backend_plan"]["mesh"]["nodes"][0][0] = True
        metadata_path.write_text(json.dumps(payload), encoding="utf-8")
    elif target in {"node_index", "face_index", "domain_count"}:
        pairs_path = unit / "mesh" / "periodic_pairs.v1.json"
        payload = json.loads(pairs_path.read_text(encoding="utf-8"))
        if target == "node_index":
            payload["pairs"][0]["node_pairs"][0]["node_a"] = True
        elif target == "face_index":
            payload["pairs"][0]["boundary_face_pairs"][0]["face_a"] = True
        else:
            payload["pairs"][0]["domain_node_pair_counts"]["magnetic"] = True
        pairs_path.write_text(json.dumps(payload), encoding="utf-8")
    else:
        seam_path = unit / "diagnostics" / "fem_static_pbc_demag_seams.v1.json"
        payload = json.loads(seam_path.read_text(encoding="utf-8"))
        payload["pair_diagnostics"][0]["paired_node_count"] = True
        seam_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_script(
        "--unit-cell", str(unit), "--output", str(supercell), "--repeat-x", "3", "--repeat-y", "3"
    )

    assert result.returncode != 0
    assert expected_error in result.stderr
