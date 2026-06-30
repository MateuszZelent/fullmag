#!/usr/bin/env python3
"""Tests for strict-M5 supercell central-cell extraction artifact writer."""

from __future__ import annotations

import json
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
    (root / "metadata.json").write_text(
        json.dumps(
            {
                "fem_cpu_relaxation_qualification": {
                    "final_energy_terms_j": {
                        "E_demag": 9.0e-18,
                    },
                    "final_torque_apm": 5.0e3,
                }
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
    write_zarr(root, "demag_phi", ["scalar"], [1.0e-3, 1.2e-3, 2.0e-3])


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

    result = run_writer(root, "--central-cell-demag-energy-j", "1.0e-17")

    assert result.returncode != 0
    assert "--central-cell-demag-energy-j exceeds metadata final E_demag" in result.stderr


def test_rejects_central_torque_above_global_supercell_torque(tmp_path: Path) -> None:
    root = tmp_path / "supercell" / "artifacts"
    write_supercell_root(root)

    result = run_writer(root, "--central-cell-torque-apm", "6.0e3")

    assert result.returncode != 0
    assert "--central-cell-torque-apm exceeds metadata final_torque_apm" in result.stderr
