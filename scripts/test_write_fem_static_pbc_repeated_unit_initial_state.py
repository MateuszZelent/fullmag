#!/usr/bin/env python3
"""Tests for repeated-unit static PBC supercell initial-state preparation."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


SCRIPT = Path(__file__).with_name("write_fem_static_pbc_repeated_unit_initial_state.py")


def write_metadata(root: Path, *, nodes: list[list[float]], elements: list[list[int]], markers: list[int]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "metadata.json").write_text(
        json.dumps(
            {
                "pbc": {"axes": ["periodic", "periodic", "open"], "demag": "periodic_airbox_k0"},
                "periodic_antidot_relaxation": {
                    "exchange_coupled_across_periods": True,
                    "scenario": "exchange_coupled",
                    "film_size_m": [2.0, 2.0, 1.0],
                    "lateral_air_gap_m": [0.0, 0.0],
                    "periodic_pair_ids": ["x_faces", "y_faces"],
                    "universe_size_m": [2.0, 2.0, 3.0],
                },
                "execution_plan": {
                    "backend_plan": {
                        "mesh": {
                            "nodes": nodes,
                            "elements": elements,
                            "element_markers": markers,
                        }
                    }
                },
                "fem_cpu_relaxation_qualification": {
                    "schema_version": "fem_cpu_relaxation_qualification.v1",
                    "final_energy_terms_j": {"E_demag": 1.0e-18, "E_total": 1.0e-18},
                    "final_torque_apm": 1.0,
                },
            }
        ),
        encoding="utf-8",
    )


def write_m_final(root: Path, values: list[list[float]]) -> None:
    (root / "m_final.json").write_text(
        json.dumps({"observable": "m", "unit": "1", "values": values}),
        encoding="utf-8",
    )


def write_node_geometry(root: Path, *, nodes: list[list[float]], magnetic_mask: list[bool]) -> None:
    mesh_dir = root / "mesh"
    mesh_dir.mkdir(parents=True, exist_ok=True)
    (mesh_dir / "node_geometry.v1.json").write_text(
        json.dumps(
            {
                "schema_version": "fem_mesh_node_geometry.v1",
                "node_count": len(nodes),
                "nodes_m": nodes,
                "magnetic_node_mask": magnetic_mask,
                "field_cell_alignment": {
                    "m": "node_index",
                    "H_demag": "node_index",
                    "H_eff": "node_index",
                    "demag_phi": "node_index",
                },
            }
        ),
        encoding="utf-8",
    )


def run_writer(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        text=True,
        capture_output=True,
        check=False,
    )


def test_writer_maps_unit_m_final_to_supercell_sampled_state(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    output = tmp_path / "states" / "m_repeated_unit.json"
    report = tmp_path / "states" / "m_repeated_unit.report.json"
    write_metadata(
        unit,
        nodes=[
            [-0.5, 0.0, 0.0],
            [0.5, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
            [0.0, 0.0, 1.5],
        ],
        elements=[[0, 1, 2, 3], [1, 2, 3, 4]],
        markers=[1, 0],
    )
    write_m_final(
        unit,
        [
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, -1.0, 0.0],
            [0.0, 0.0, 0.0],
        ],
    )
    write_node_geometry(
        supercell,
        nodes=[
            [-2.5, 0.0, 0.0],
            [-1.5, 0.0, 0.0],
            [0.2, 0.0, 0.0],
        ],
        magnetic_mask=[True, True, False],
    )

    result = run_writer(
        "--unit-cell",
        str(unit),
        "--supercell",
        str(supercell),
        "--repeat-x",
        "3",
        "--repeat-y",
        "3",
        "--output",
        str(output),
        "--report",
        str(report),
    )

    assert result.returncode == 0, result.stderr
    state = json.loads(output.read_text(encoding="utf-8"))
    assert state["kind"] == "magnetization_state"
    assert state["observable"] == "m"
    assert state["format"] == "json"
    assert state["vector_count"] == 3
    assert state["values"] == [
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0],
    ]
    payload = json.loads(report.read_text(encoding="utf-8"))
    assert payload["schema_version"] == "fem_static_pbc_repeated_unit_initial_state.v1"
    assert payload["unit_magnetic_node_count"] == 4
    assert payload["supercell_node_count"] == 3
    assert payload["supercell_magnetic_node_count"] == 2
    assert payload["mapped_magnetic_node_count"] == 2
    assert payload["air_or_nonmagnetic_fill_vector"] == [0.0, 0.0, 0.0]
    assert payload["max_nearest_unit_node_distance_m"] == 0.0


def test_writer_rejects_nonzero_nearest_node_mismatch_above_tolerance(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    write_metadata(
        unit,
        nodes=[
            [-0.5, 0.0, 0.0],
            [0.5, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ],
        elements=[[0, 1, 2, 3]],
        markers=[1],
    )
    write_m_final(
        unit,
        [
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, -1.0, 0.0],
        ],
    )
    write_node_geometry(
        supercell,
        nodes=[[-2.45, 0.0, 0.0]],
        magnetic_mask=[True],
    )

    result = run_writer(
        "--unit-cell",
        str(unit),
        "--supercell",
        str(supercell),
        "--repeat-x",
        "3",
        "--repeat-y",
        "3",
        "--max-nearest-distance-m",
        "1e-3",
        "--output",
        str(tmp_path / "state.json"),
    )

    assert result.returncode != 0
    assert "nearest unit node distance exceeds" in result.stderr
    assert "inf" not in result.stderr
    assert "5.000000e-02" in result.stderr


def test_writer_can_map_remeshed_supercell_by_unit_tetrahedral_interpolation(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    output = tmp_path / "states" / "m_repeated_unit.json"
    report = tmp_path / "states" / "m_repeated_unit.report.json"
    write_metadata(
        unit,
        nodes=[
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 2.0],
        ],
        elements=[[0, 1, 2, 3], [1, 2, 3, 4]],
        markers=[1, 0],
    )
    write_m_final(
        unit,
        [
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 1.0, 1.0],
            [0.0, 0.0, 0.0],
        ],
    )
    write_node_geometry(
        supercell,
        nodes=[
            [0.25, 0.25, 0.25],
            [2.25, 0.25, 0.25],
            [0.1, 0.1, 1.7],
        ],
        magnetic_mask=[True, True, False],
    )

    result = run_writer(
        "--unit-cell",
        str(unit),
        "--supercell",
        str(supercell),
        "--repeat-x",
        "3",
        "--repeat-y",
        "3",
        "--mapping-mode",
        "linear_tetrahedral_interpolation",
        "--output",
        str(output),
        "--report",
        str(report),
    )

    assert result.returncode == 0, result.stderr
    state = json.loads(output.read_text(encoding="utf-8"))
    unit_component = 1.0 / (3.0**0.5)
    assert state["values"][0] == [unit_component, unit_component, unit_component]
    assert state["values"][1] == [unit_component, unit_component, unit_component]
    assert state["values"][2] == [0.0, 0.0, 0.0]
    payload = json.loads(report.read_text(encoding="utf-8"))
    assert payload["mapping_mode"] == "linear_tetrahedral_interpolation"
    assert payload["interpolation_method"] == "linear_tetrahedral_barycentric"
    assert payload["interpolated_magnetic_node_count"] == 2
