#!/usr/bin/env python3
"""Tests for strict-M5 supercell central-cell extraction artifact writer."""

from __future__ import annotations

import json
import math
import struct
import subprocess
import sys
from pathlib import Path


SCRIPT = Path("scripts/write_fem_static_pbc_supercell_central_cell_artifact.py")


def write_zarr(root: Path, observable: str, component_order: list[str], values: list[float]) -> None:
    field_dir = root / "fields" / f"{observable}.zarr"
    field_dir.mkdir(parents=True, exist_ok=True)
    component_count = len(component_order)
    cell_count = len(values) // component_count
    (field_dir / ".zattrs").write_text(
        json.dumps({"component_order": component_order}),
        encoding="utf-8",
    )
    (field_dir / ".zarray").write_text(
        json.dumps({"dtype": "<f8", "order": "C", "shape": [1, component_count, cell_count]}),
        encoding="utf-8",
    )
    (field_dir / "samples.csv").write_text(
        "step,time,solver_dt,chunk_key\n4,0.0,0.0,0.0.0\n",
        encoding="utf-8",
    )
    (field_dir / "0.0.0").write_bytes(struct.pack(f"<{len(values)}d", *values))


def write_supercell_root(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "mesh").mkdir()
    (root / "metadata.json").write_text(
        json.dumps(
            {
                "periodic_antidot_relaxation": {
                    "scenario": "exchange_coupled",
                    "film_size_m": [2.0e-7, 2.0e-7, 1.0e-8],
                    "universe_size_m": [6.0e-7, 6.0e-7, 9.0e-8],
                    "supercell_repeat": [3, 3],
                },
                "fem_cpu_relaxation_qualification": {
                    "final_energy_terms_j": {
                        "E_demag": 1.0e-6,
                    },
                    "final_torque_apm": 5.0e3,
                },
            }
        ),
        encoding="utf-8",
    )
    (root / "m_final.json").write_text(
        json.dumps(
            {
                "observable": "m",
                "unit": "dimensionless",
                "values": [
                    [1.0, 0.0, 0.0],
                    [0.99, 0.01, 0.0],
                    [0.0, 1.0, 0.0],
                ],
            }
        ),
        encoding="utf-8",
    )
    write_zarr(root, "H_demag", ["x", "y", "z"], [1.0e3, 1.1e3, 2.0e3, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
    write_zarr(root, "H_eff", ["x", "y", "z"], [1.0e3, 1.1e3, 2.0e3, 4.0e3, 0.0, 0.0, 0.0, 0.0, 0.0])
    write_zarr(root, "demag_phi", ["scalar"], [1.0e-3, 1.2e-3, 2.0e-3])


def write_geometry_supercell_root(root: Path) -> None:
    write_supercell_root(root)
    (root / "m_final.json").write_text(
        json.dumps(
            {
                "observable": "m",
                "unit": "dimensionless",
                "values": [
                    [1.0, 0.0, 0.0],
                    [0.99, 0.01, 0.0],
                    [0.98, 0.02, 0.0],
                    [0.97, 0.03, 0.0],
                    [0.96, 0.04, 0.0],
                ],
            }
        ),
        encoding="utf-8",
    )
    write_zarr(
        root,
        "H_demag",
        ["x", "y", "z"],
        [
            1.0e3,
            1.1e3,
            1.2e3,
            1.3e3,
            1.4e3,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
        ],
    )
    write_zarr(
        root,
        "H_eff",
        ["x", "y", "z"],
        [
            1.0e3,
            1.1e3,
            1.2e3,
            1.3e3,
            1.4e3,
            4.0e3,
            5.0e3,
            6.0e3,
            7.0e3,
            8.0e3,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
        ],
    )
    write_zarr(root, "demag_phi", ["scalar"], [1.0e-3, 1.1e-3, 1.2e-3, 1.3e-3, 1.4e-3])
    (root / "mesh" / "node_geometry.v1.json").write_text(
        json.dumps(
            {
                "schema_version": "fem_mesh_node_geometry.v1",
                "artifact_path": "mesh/node_geometry.v1.json",
                "node_count": 5,
                "nodes_m": [
                    [-2.5e-7, 0.0, 0.0],
                    [-5.0e-8, -5.0e-8, 0.0],
                    [0.0, 0.0, 0.0],
                    [5.0e-8, 5.0e-8, 0.0],
                    [2.5e-7, 0.0, 0.0],
                ],
                "magnetic_node_mask": [True, True, False, True, True],
                "magnetic_node_count": 4,
                "field_cell_alignment": {
                    "m": "node_index",
                    "H_demag": "node_index",
                    "demag_phi": "node_index",
                },
            }
        ),
        encoding="utf-8",
    )


def write_mesh_backed_geometry_supercell_root(root: Path) -> None:
    write_geometry_supercell_root(root)
    metadata = json.loads((root / "metadata.json").read_text(encoding="utf-8"))
    metadata["execution_plan"] = {
        "backend_plan": {
            "material": {
                "saturation_magnetisation": 2.0,
            },
            "mesh": {
                "nodes": [
                    [-0.25, -0.25, 0.0],
                    [0.25, -0.25, 0.0],
                    [-0.25, 0.25, 0.0],
                    [-0.25, -0.25, 0.25],
                    [2.5, 0.0, 0.0],
                ],
                "elements": [
                    [0, 1, 2, 3],
                ],
                "element_markers": [1],
            },
        },
    }
    metadata["periodic_antidot_relaxation"]["film_size_m"] = [2.0, 2.0, 1.0]
    metadata["periodic_antidot_relaxation"]["universe_size_m"] = [6.0, 6.0, 3.0]
    (root / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    (root / "mesh" / "node_geometry.v1.json").write_text(
        json.dumps(
            {
                "schema_version": "fem_mesh_node_geometry.v1",
                "artifact_path": "mesh/node_geometry.v1.json",
                "node_count": 5,
                "nodes_m": [
                    [-0.25, -0.25, 0.0],
                    [0.25, -0.25, 0.0],
                    [-0.25, 0.25, 0.0],
                    [-0.25, -0.25, 0.25],
                    [2.5, 0.0, 0.0],
                ],
                "magnetic_node_mask": [True, True, True, True, False],
                "magnetic_node_count": 4,
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
    (root / "m_final.json").write_text(
        json.dumps(
            {
                "observable": "m",
                "unit": "dimensionless",
                "values": [
                    [1.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                ],
            }
        ),
        encoding="utf-8",
    )
    write_zarr(
        root,
        "H_demag",
        ["x", "y", "z"],
        [
            -3.0,
            -3.0,
            -3.0,
            -3.0,
            100.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
        ],
    )
    write_zarr(
        root,
        "H_eff",
        ["x", "y", "z"],
        [
            0.0,
            0.0,
            0.0,
            0.0,
            100.0,
            4.0,
            4.0,
            4.0,
            4.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
        ],
    )
    write_zarr(root, "demag_phi", ["scalar"], [1.0e-3, 1.1e-3, 1.2e-3, 1.3e-3, 1.4e-3])


def run_writer(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            str(root),
            "--repeat-x",
            "3",
            "--repeat-y",
            "3",
            "--magnetic-node-indices",
            "0,1",
            "--field-cell-indices",
            "0,1",
            "--central-cell-demag-energy-j",
            "1.0e-18",
            "--central-cell-torque-apm",
            "4.0e3",
            *args,
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def test_writes_central_cell_extraction_artifact(tmp_path: Path) -> None:
    root = tmp_path / "supercell" / "artifacts"
    write_supercell_root(root)

    result = run_writer(root)

    assert result.returncode == 0, result.stderr
    artifact_path = root / "diagnostics" / "fem_static_pbc_supercell_central_cell.v1.json"
    payload = json.loads(artifact_path.read_text(encoding="utf-8"))
    assert payload["schema_version"] == "fem_static_pbc_supercell_central_cell.v1"
    assert payload["repeat_x"] == 3
    assert payload["repeat_y"] == 3
    assert payload["cell_count"] == 9
    assert payload["central_cell_index"] == [1, 1]
    assert payload["magnetic_node_indices"] == [0, 1]
    assert payload["field_cell_indices"] == [0, 1]
    assert payload["central_cell_demag_energy_j"] == 1.0e-18
    assert payload["central_cell_torque_apm"] == 4.0e3


def test_auto_selects_central_cell_indices_from_node_geometry(tmp_path: Path) -> None:
    root = tmp_path / "supercell" / "artifacts"
    write_geometry_supercell_root(root)

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            str(root),
            "--repeat-x",
            "3",
            "--repeat-y",
            "3",
            "--auto-central-cell-indices",
            "--central-cell-demag-energy-j",
            "1.0e-18",
            "--central-cell-torque-apm",
            "4.0e3",
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(
        (root / "diagnostics" / "fem_static_pbc_supercell_central_cell.v1.json").read_text(
            encoding="utf-8"
        )
    )
    assert payload["central_cell_index"] == [1, 1]
    assert payload["magnetic_node_indices"] == [1, 3]
    assert payload["field_cell_indices"] == [1, 2, 3]
    assert payload["index_selection"]["method"] == "node_geometry_bounds"


def test_auto_selection_rejects_missing_node_geometry(tmp_path: Path) -> None:
    root = tmp_path / "supercell" / "artifacts"
    write_supercell_root(root)

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            str(root),
            "--repeat-x",
            "3",
            "--repeat-y",
            "3",
            "--auto-central-cell-indices",
            "--central-cell-demag-energy-j",
            "1.0e-18",
            "--central-cell-torque-apm",
            "4.0e3",
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode != 0
    assert "missing JSON file" in result.stderr
    assert "node_geometry.v1.json" in result.stderr


def test_auto_scalars_compute_energy_and_torque_from_mesh_and_fields(tmp_path: Path) -> None:
    root = tmp_path / "supercell" / "artifacts"
    write_mesh_backed_geometry_supercell_root(root)

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            str(root),
            "--repeat-x",
            "3",
            "--repeat-y",
            "3",
            "--auto-central-cell-indices",
            "--auto-central-cell-scalars",
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(
        (root / "diagnostics" / "fem_static_pbc_supercell_central_cell.v1.json").read_text(
            encoding="utf-8"
        )
    )
    expected_volume = (0.5 * 0.5 * 0.25) / 6.0
    expected_energy = 0.5 * 4.0 * math.pi * 1.0e-7 * 2.0 * 3.0 * expected_volume
    assert payload["magnetic_node_indices"] == [0, 1, 2, 3]
    assert math.isclose(payload["central_cell_demag_energy_j"], expected_energy)
    assert payload["central_cell_torque_apm"] == 4.0
    assert payload["scalar_selection"]["method"] == "element_centroid_mesh_integral"


def test_auto_scalars_reject_missing_h_eff_field(tmp_path: Path) -> None:
    root = tmp_path / "supercell" / "artifacts"
    write_mesh_backed_geometry_supercell_root(root)
    field_dir = root / "fields" / "H_eff.zarr"
    for child in field_dir.iterdir():
        child.unlink()
    field_dir.rmdir()

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            str(root),
            "--repeat-x",
            "3",
            "--repeat-y",
            "3",
            "--auto-central-cell-indices",
            "--auto-central-cell-scalars",
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode != 0
    assert "missing H_eff zarr directory" in result.stderr


def test_rejects_empty_index_list(tmp_path: Path) -> None:
    root = tmp_path / "supercell" / "artifacts"
    write_supercell_root(root)

    result = run_writer(root, "--magnetic-node-indices", "")

    assert result.returncode != 0
    assert "--magnetic-node-indices must contain at least one index" in result.stderr


def test_reads_index_lists_from_files(tmp_path: Path) -> None:
    root = tmp_path / "supercell" / "artifacts"
    write_supercell_root(root)
    magnetic_indices = tmp_path / "magnetic_indices.txt"
    field_indices = tmp_path / "field_indices.txt"
    magnetic_indices.write_text("0\n1\n", encoding="utf-8")
    field_indices.write_text("0,1\n", encoding="utf-8")

    result = run_writer(
        root,
        "--magnetic-node-indices",
        str(magnetic_indices),
        "--field-cell-indices",
        str(field_indices),
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(
        (root / "diagnostics" / "fem_static_pbc_supercell_central_cell.v1.json").read_text(
            encoding="utf-8"
        )
    )
    assert payload["magnetic_node_indices"] == [0, 1]
    assert payload["field_cell_indices"] == [0, 1]


def test_rejects_indices_outside_artifact_ranges(tmp_path: Path) -> None:
    root = tmp_path / "supercell" / "artifacts"
    write_supercell_root(root)

    result = run_writer(root, "--field-cell-indices", "0,9")

    assert result.returncode != 0
    assert "--field-cell-indices contains index 9 outside [0, 3)" in result.stderr


def test_rejects_central_energy_above_global_supercell_demag_energy(tmp_path: Path) -> None:
    root = tmp_path / "supercell" / "artifacts"
    write_supercell_root(root)

    result = run_writer(root, "--central-cell-demag-energy-j", "2.0e-6")

    assert result.returncode != 0
    assert "--central-cell-demag-energy-j exceeds metadata final E_demag" in result.stderr


def test_rejects_central_torque_above_global_supercell_torque(tmp_path: Path) -> None:
    root = tmp_path / "supercell" / "artifacts"
    write_supercell_root(root)

    result = run_writer(root, "--central-cell-torque-apm", "6.0e3")

    assert result.returncode != 0
    assert "--central-cell-torque-apm exceeds metadata final_torque_apm" in result.stderr
