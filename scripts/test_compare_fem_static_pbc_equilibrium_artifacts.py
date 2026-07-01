#!/usr/bin/env python3
"""Tests for static FEM PBC equilibrium comparison reports."""

from __future__ import annotations

import csv
import json
import struct
import subprocess
import sys
from pathlib import Path


SCRIPT = Path(__file__).with_name("compare_fem_static_pbc_equilibrium_artifacts.py")


def write_zarr_field(root: Path, *, observable: str, component_order: list[str], values: list[float]) -> None:
    field_dir = root / "fields" / f"{observable}.zarr"
    field_dir.mkdir(parents=True, exist_ok=True)
    component_count = len(component_order)
    assert len(values) % component_count == 0
    cell_count = len(values) // component_count
    (field_dir / ".zattrs").write_text(
        json.dumps(
            {
                "observable": observable,
                "unit": "A/m" if observable == "H_demag" else "A",
                "component_order": component_order,
            }
        ),
        encoding="utf-8",
    )
    (field_dir / ".zarray").write_text(
        json.dumps({"dtype": "<f8", "order": "C", "shape": [1, component_count, cell_count]}),
        encoding="utf-8",
    )
    with (field_dir / "samples.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["step", "time", "solver_dt", "chunk_key"])
        writer.writeheader()
        writer.writerow({"step": "4", "time": "0.0", "solver_dt": "0.0", "chunk_key": "0.0.0"})
    (field_dir / "0.0.0").write_bytes(struct.pack(f"<{len(values)}d", *values))


def write_supercell_central_cell_extraction(
    root: Path,
    *,
    repeat_x: int = 3,
    repeat_y: int = 3,
    magnetic_node_indices: list[int] | None = None,
    field_cell_indices: list[int] | None = None,
    e_demag: float = 1.0e-18,
    final_torque: float = 4.0e3,
) -> None:
    if magnetic_node_indices is None:
        magnetic_node_indices = [0, 1]
    if field_cell_indices is None:
        field_cell_indices = [0, 1]
    diagnostics_dir = root / "diagnostics"
    diagnostics_dir.mkdir(parents=True, exist_ok=True)
    (diagnostics_dir / "fem_static_pbc_supercell_central_cell.v1.json").write_text(
        json.dumps(
            {
                "schema_version": "fem_static_pbc_supercell_central_cell.v1",
                "repeat_x": repeat_x,
                "repeat_y": repeat_y,
                "cell_count": repeat_x * repeat_y,
                "central_cell_index": [repeat_x // 2, repeat_y // 2],
                "magnetic_node_indices": magnetic_node_indices,
                "field_cell_indices": field_cell_indices,
                "central_cell_demag_energy_j": e_demag,
                "central_cell_torque_apm": final_torque,
            }
        ),
        encoding="utf-8",
    )


def write_node_geometry(
    root: Path,
    *,
    magnetic_node_mask: list[bool],
    nodes_m: list[list[float]] | None = None,
) -> None:
    if nodes_m is None:
        nodes_m = [[float(index) * 1.0e-8, 0.0, 0.0] for index in range(len(magnetic_node_mask))]
    mesh_dir = root / "mesh"
    mesh_dir.mkdir(parents=True, exist_ok=True)
    (mesh_dir / "node_geometry.v1.json").write_text(
        json.dumps(
            {
                "schema_version": "mesh_node_geometry.v1",
                "node_count": len(magnetic_node_mask),
                "nodes_m": nodes_m,
                "magnetic_node_mask": magnetic_node_mask,
                "field_cell_alignment": {
                    "m": "node_index",
                    "H_demag": "node_index",
                    "demag_phi": "node_index",
                },
            }
        ),
        encoding="utf-8",
    )


def add_metadata_mesh(root: Path, *, nodes: list[list[float]], elements: list[list[int]], element_markers: list[int]) -> None:
    metadata_path = root / "metadata.json"
    payload = json.loads(metadata_path.read_text(encoding="utf-8"))
    payload.setdefault("execution_plan", {}).setdefault("backend_plan", {})["mesh"] = {
        "nodes": nodes,
        "elements": elements,
        "element_markers": element_markers,
    }
    metadata_path.write_text(json.dumps(payload), encoding="utf-8")


def add_initial_state_override_metadata(root: Path) -> None:
    metadata_path = root / "metadata.json"
    payload = json.loads(metadata_path.read_text(encoding="utf-8"))
    payload["problem_meta"] = {
        "runtime_metadata": {
            "initial_magnetization_state_override": {
                "kind": "initial_magnetization_state_override",
                "source_path": "states/m_repeated_unit.json",
                "format": "json",
                "dataset": None,
                "sample_index": None,
                "vector_count": 2,
            }
        }
    }
    metadata_path.write_text(json.dumps(payload), encoding="utf-8")


def write_artifacts(
    root: Path,
    *,
    e_demag: float,
    scenario: str = "exchange_coupled",
    demag: str = "periodic_airbox_k0",
    final_torque: float = 4.0e3,
    universe_size_m: list[float] | None = None,
    m_values: list[list[float]] | None = None,
    h_values: list[float] | None = None,
    phi_values: list[float] | None = None,
) -> None:
    root.mkdir(parents=True, exist_ok=True)
    if universe_size_m is None:
        universe_size_m = [2.0e-7, 2.0e-7, 9.0e-8]
    (root / "metadata.json").write_text(
        json.dumps(
            {
                "pbc": {
                    "axes": ["periodic", "periodic", "open"],
                    "demag": demag,
                },
                "periodic_antidot_relaxation": {
                    "exchange_coupled_across_periods": scenario == "exchange_coupled",
                    "scenario": scenario,
                    "film_size_m": [2.0e-7, 2.0e-7, 1.0e-8],
                    "lateral_air_gap_m": [0.0, 0.0],
                    "periodic_pair_ids": ["x_faces", "y_faces"],
                    "universe_size_m": universe_size_m,
                },
                "fem_cpu_relaxation_qualification": {
                    "schema_version": "fem_cpu_relaxation_qualification.v1",
                    "final_energy_terms_j": {"E_demag": e_demag, "E_total": e_demag},
                    "final_torque_apm": final_torque,
                },
            }
        ),
        encoding="utf-8",
    )
    if m_values is None:
        m_values = [[1.0, 0.0, 0.0], [0.98, 0.02, 0.0]]
    (root / "m_final.json").write_text(
        json.dumps({"observable": "m", "unit": "1", "step": 4, "values": m_values}),
        encoding="utf-8",
    )
    write_node_geometry(root, magnetic_node_mask=[any(abs(component) > 0.0 for component in vector) for vector in m_values])
    if h_values is None:
        h_values = [1.0e3, 1.0e3, 0.0, 0.0, 0.0, 0.0]
    if phi_values is None:
        phi_values = [1.0e-3, 1.2e-3]
    write_zarr_field(root, observable="H_demag", component_order=["x", "y", "z"], values=h_values)
    write_zarr_field(root, observable="demag_phi", component_order=["scalar"], values=phi_values)


def run_report(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        text=True,
        capture_output=True,
        check=False,
    )


def test_z_padding_report_accepts_matching_static_artifacts(tmp_path: Path) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(reference, e_demag=1.0e-18, universe_size_m=[2.0e-7, 2.0e-7, 1.3e-7])
    write_artifacts(candidate, e_demag=1.001e-18, universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8])

    result = run_report(
        "z-padding",
        "--reference",
        str(reference),
        "--candidate",
        str(candidate),
        "--report",
        str(report_path),
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["schema_version"] == "fem_static_pbc_z_padding_validation.v1"
    assert report["status"] == "ok"
    assert report["reference_artifacts"] == str(reference)
    assert report["candidate_artifacts"] == str(candidate)
    assert report["metrics"]["e_demag_relative_error"] > 0.0


def test_z_padding_report_uses_robust_field_stats_not_global_max_outlier(tmp_path: Path) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    reference_h = [1.0e3] * 99 + [2.50e5] + [0.0] * 100 + [0.0] * 100
    candidate_h = [1.0e3] * 99 + [2.60e5] + [0.0] * 100 + [0.0] * 100
    write_artifacts(
        reference,
        e_demag=1.0e-18,
        universe_size_m=[2.0e-7, 2.0e-7, 1.3e-7],
        h_values=reference_h,
        phi_values=[-1.0e-3, 1.0e-3],
    )
    write_artifacts(
        candidate,
        e_demag=1.001e-18,
        universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8],
        h_values=candidate_h,
        phi_values=[-1.001e-3, 1.001e-3],
    )

    result = run_report(
        "z-padding",
        "--reference",
        str(reference),
        "--candidate",
        str(candidate),
        "--report",
        str(report_path),
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "ok"
    assert report["metrics"]["h_demag_max_abs_delta_Apm"] > 1.0e3
    assert report["metrics"]["h_demag_p99_relative_error"] == 0.0
    assert report["metrics"]["demag_phi_range_relative_error"] < 2.0e-2


def test_supercell_report_compares_scaled_demag_density(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_validation.v1.json"
    write_artifacts(unit, e_demag=1.0e-18, final_torque=4.0e3)
    write_artifacts(
        supercell,
        e_demag=9.01e-18,
        final_torque=4.01e3,
        universe_size_m=[6.0e-7, 6.0e-7, 9.0e-8],
    )
    write_supercell_central_cell_extraction(supercell, e_demag=1.001e-18, final_torque=4.01e3)

    result = run_report(
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
        str(report_path),
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["schema_version"] == "fem_static_pbc_supercell_validation.v1"
    assert report["status"] == "ok"
    assert report["cell_count"] == 9
    assert report["metrics"]["e_demag_density_relative_error"] < 2.0e-2
    assert report["metrics"]["relaxation_state_mean_deviation_relative_error"] == 0.0
    assert report["metrics"]["magnetic_node_count_relative_error"] == 0.0
    assert report["metrics"]["field_cell_count_relative_error"] == 0.0
    assert report["central_cell_extraction"]["schema_version"] == "fem_static_pbc_supercell_central_cell.v1"
    assert report["mesh_comparability"]["unit_magnetic_node_count"] == 2
    assert report["mesh_comparability"]["central_cell_magnetic_node_count"] == 2
    assert report["mesh_comparability"]["magnetic_node_count_relative_error"] == 0.0


def test_supercell_report_adds_mapped_central_cell_comparison(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_validation.v1.json"
    write_artifacts(
        unit,
        e_demag=1.0e-18,
        final_torque=4.0e3,
        m_values=[
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0],
        ],
        h_values=[10.0, 20.0, 30.0, 1.0, 2.0, 3.0, 0.0, 0.0, 0.0],
        phi_values=[1.0e-3, 2.0e-3, 3.0e-3],
    )
    write_node_geometry(
        unit,
        magnetic_node_mask=[True, True, False],
        nodes_m=[[-1.0e-8, 0.0, 0.0], [1.0e-8, 0.0, 0.0], [0.0, 0.0, 3.0e-8]],
    )
    write_artifacts(
        supercell,
        e_demag=9.0e-18,
        final_torque=4.0e3,
        universe_size_m=[6.0e-7, 6.0e-7, 9.0e-8],
        m_values=[
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 0.0],
        ],
        h_values=[10.0, 20.0, 30.0, 99.0, 1.0, 2.0, 3.0, 99.0, 0.0, 0.0, 0.0, 99.0],
        phi_values=[1.7e-3, 2.7e-3, 3.7e-3, 9.0e-3],
    )
    write_node_geometry(
        supercell,
        magnetic_node_mask=[True, True, False, False],
        nodes_m=[[1.9e-7, 0.0, 0.0], [2.1e-7, 0.0, 0.0], [2.0e-7, 0.0, 3.0e-8], [0.0, 0.0, 0.0]],
    )
    write_supercell_central_cell_extraction(
        supercell,
        magnetic_node_indices=[0, 1],
        field_cell_indices=[0, 1, 2],
        e_demag=1.0e-18,
        final_torque=4.0e3,
    )

    result = run_report(
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
        str(report_path),
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(report_path.read_text(encoding="utf-8"))
    mapped = report["mapped_central_cell_comparability"]
    assert mapped["schema_version"] == "fem_static_pbc_supercell_mapped_comparison.v1"
    assert mapped["same_local_discretization"] is True
    assert mapped["same_local_discretization_limit_m"] == 1.0e-12
    assert mapped["magnetic_pair_count"] == 2
    assert mapped["field_pair_count"] == 3
    assert mapped["max_nearest_field_node_distance_m"] < 1.0e-18
    assert mapped["m"]["max_l2_delta"] == 0.0
    assert mapped["H_demag"]["max_l2_delta"] == 0.0
    assert abs(mapped["demag_phi"]["best_constant_offset_A"] - 7.0e-4) < 1.0e-18
    assert mapped["demag_phi"]["max_abs_delta_after_offset_A"] < 1.0e-18
    assert report["metrics"]["mapped_h_demag_p99_relative_error"] == 0.0


def test_supercell_report_fails_when_mapped_nearest_distance_is_not_strict(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_validation.v1.json"
    write_artifacts(
        unit,
        e_demag=1.0e-18,
        final_torque=4.0e3,
        m_values=[[1.0, 0.0, 0.0], [0.0, 0.0, 0.0]],
        h_values=[10.0, 20.0, 1.0, 2.0, 0.0, 0.0],
        phi_values=[1.0e-3, 2.0e-3],
    )
    write_node_geometry(
        unit,
        magnetic_node_mask=[True, False],
        nodes_m=[[0.0, 0.0, 0.0], [0.0, 0.0, 2.0e-8]],
    )
    write_artifacts(
        supercell,
        e_demag=9.0e-18,
        final_torque=4.0e3,
        universe_size_m=[6.0e-7, 6.0e-7, 9.0e-8],
        m_values=[[1.0, 0.0, 0.0], [0.0, 0.0, 0.0]],
        h_values=[10.0, 20.0, 1.0, 2.0, 0.0, 0.0],
        phi_values=[1.7e-3, 2.7e-3],
    )
    write_node_geometry(
        supercell,
        magnetic_node_mask=[True, False],
        nodes_m=[[2.0e-7 + 1.0e-9, 0.0, 0.0], [2.0e-7, 0.0, 2.0e-8]],
    )
    write_supercell_central_cell_extraction(
        supercell,
        magnetic_node_indices=[0],
        field_cell_indices=[0, 1],
        e_demag=1.0e-18,
        final_torque=4.0e3,
    )

    result = run_report(
        "--allow-failed-status",
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
        str(report_path),
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(report_path.read_text(encoding="utf-8"))
    mapped = report["mapped_central_cell_comparability"]
    assert report["status"] == "failed"
    assert "mapped_max_nearest_magnetic_node_distance_m" in result.stderr
    assert mapped["same_local_discretization"] is False
    assert mapped["same_local_discretization_limit_m"] == 1.0e-12
    assert report["metrics"]["mapped_max_nearest_magnetic_node_distance_m"] > 1.0e-12


def test_supercell_report_can_add_interpolated_remesh_comparison(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_validation.v1.json"
    unit_nodes = [
        [0.0, 0.0, 0.0],
        [1.0e-8, 0.0, 0.0],
        [0.0, 1.0e-8, 0.0],
        [0.0, 0.0, 1.0e-8],
    ]
    supercell_node = [2.5e-9, 2.5e-9, 2.5e-9]
    write_artifacts(
        unit,
        e_demag=1.0e-18,
        final_torque=4.0e3,
        m_values=[
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 1.0, 1.0],
        ],
        h_values=[10.0, 20.0, 30.0, 40.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        phi_values=[1.0e-3, 2.0e-3, 3.0e-3, 4.0e-3],
    )
    write_node_geometry(unit, magnetic_node_mask=[True, True, True, True], nodes_m=unit_nodes)
    add_metadata_mesh(unit, nodes=unit_nodes, elements=[[0, 1, 2, 3]], element_markers=[1])
    write_artifacts(
        supercell,
        e_demag=9.0e-18,
        final_torque=4.0e3,
        universe_size_m=[6.0e-7, 6.0e-7, 9.0e-8],
        m_values=[[0.5, 0.5, 0.5]],
        h_values=[25.0, 0.0, 0.0],
        phi_values=[2.5e-3],
    )
    write_node_geometry(supercell, magnetic_node_mask=[True], nodes_m=[supercell_node])
    write_supercell_central_cell_extraction(
        supercell,
        magnetic_node_indices=[0],
        field_cell_indices=[0],
        e_demag=1.0e-18,
        final_torque=4.0e3,
    )

    result = run_report(
        "--allow-failed-status",
        "supercell",
        "--unit-cell",
        str(unit),
        "--supercell",
        str(supercell),
        "--repeat-x",
        "3",
        "--repeat-y",
        "3",
        "--include-interpolated-comparison",
        "--report",
        str(report_path),
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "failed"
    interpolated = report["interpolated_central_cell_comparability"]
    assert interpolated["schema_version"] == "fem_static_pbc_supercell_interpolated_comparison.v1"
    assert interpolated["field_coverage_ratio"] == 1.0
    assert interpolated["magnetic_coverage_ratio"] == 1.0
    assert interpolated["m"]["max_l2_delta"] < 1.0e-14
    assert interpolated["H_demag"]["max_l2_delta"] < 1.0e-12
    assert interpolated["demag_phi"]["max_abs_delta_after_offset_A"] < 1.0e-18


def test_supercell_report_can_write_failed_diagnostic_status(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_validation.v1.json"
    write_artifacts(unit, e_demag=1.0e-18, final_torque=4.0e3)
    write_artifacts(
        supercell,
        e_demag=9.8e-18,
        final_torque=4.01e3,
        universe_size_m=[6.0e-7, 6.0e-7, 9.0e-8],
    )
    write_supercell_central_cell_extraction(supercell, e_demag=1.2e-18, final_torque=4.01e3)

    result = run_report(
        "--allow-failed-status",
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
        str(report_path),
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "failed"
    assert "e_demag_density_relative_error" in result.stderr


def test_supercell_report_carries_repeated_state_initial_override_provenance(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_validation.v1.json"
    write_artifacts(unit, e_demag=1.0e-18, final_torque=4.0e3)
    write_artifacts(
        supercell,
        e_demag=9.01e-18,
        final_torque=4.01e3,
        universe_size_m=[6.0e-7, 6.0e-7, 9.0e-8],
    )
    add_initial_state_override_metadata(supercell)
    write_supercell_central_cell_extraction(supercell, e_demag=1.001e-18, final_torque=4.01e3)

    result = run_report(
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
        str(report_path),
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(report_path.read_text(encoding="utf-8"))
    override = report["supercell_initial_magnetization_state_override"]
    assert override["kind"] == "initial_magnetization_state_override"
    assert override["source_path"] == "states/m_repeated_unit.json"
    assert override["format"] == "json"
    assert override["vector_count"] == 2


def test_supercell_report_rejects_missing_central_cell_extraction(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_validation.v1.json"
    write_artifacts(unit, e_demag=1.0e-18, final_torque=4.0e3)
    write_artifacts(
        supercell,
        e_demag=9.01e-18,
        final_torque=4.01e3,
        universe_size_m=[6.0e-7, 6.0e-7, 9.0e-8],
    )

    result = run_report(
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
        str(report_path),
    )

    assert result.returncode != 0
    assert "missing supercell central-cell extraction artifact" in result.stderr
    assert not report_path.exists()


def test_supercell_report_records_noncomparable_global_mesh_counts(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_validation.v1.json"
    write_artifacts(
        unit,
        e_demag=1.0e-18,
        final_torque=4.0e3,
        m_values=[
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
        ],
        h_values=[1.0e3] * 5 + [0.0] * 10,
        phi_values=[1.0e-3, 1.2e-3, 1.1e-3, 1.15e-3, 1.05e-3],
    )
    write_artifacts(
        supercell,
        e_demag=9.0e-18,
        final_torque=4.0e3,
        universe_size_m=[6.0e-7, 6.0e-7, 9.0e-8],
        m_values=[
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
        ],
        h_values=[1.0e3] * 5 + [0.0] * 10,
        phi_values=[1.0e-3, 1.2e-3, 1.1e-3, 1.15e-3, 1.05e-3],
    )
    write_supercell_central_cell_extraction(
        supercell,
        magnetic_node_indices=[0, 1],
        field_cell_indices=[0, 1],
        e_demag=1.0e-18,
        final_torque=4.0e3,
    )

    result = run_report(
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
        str(report_path),
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "ok"
    assert report["metrics"]["magnetic_node_count_relative_error"] > 0.2
    assert report["metrics"]["field_cell_count_relative_error"] > 0.2
    assert report["mesh_comparability"]["magnetic_node_count_relative_error"] > 0.2
    assert report["mesh_comparability"]["field_cell_count_relative_error"] > 0.2


def test_supercell_report_records_relaxation_state_mismatch(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_validation.v1.json"
    write_artifacts(
        unit,
        e_demag=1.0e-18,
        final_torque=4.0e3,
        m_values=[[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]],
    )
    write_artifacts(
        supercell,
        e_demag=9.0e-18,
        final_torque=4.0e3,
        universe_size_m=[6.0e-7, 6.0e-7, 9.0e-8],
        m_values=[
            [0.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
        ],
        h_values=[1.0e3, 1.0e3, 1.0e3, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        phi_values=[1.0e-3, 1.2e-3, 1.1e-3],
    )
    write_supercell_central_cell_extraction(
        supercell,
        magnetic_node_indices=[0, 1],
        field_cell_indices=[0, 1],
        e_demag=1.0e-18,
        final_torque=4.0e3,
    )

    result = run_report(
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
        str(report_path),
    )

    assert result.returncode != 0
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "failed"
    state = report["relaxation_state_comparability"]
    assert state["unit_average_m"] == [1.0, 0.0, 0.0]
    assert state["central_cell_average_m"] == [0.0, 1.0, 0.0]
    assert state["central_cell_average_m_l2_delta"] > 1.4
    assert state["unit_mean_l2_deviation_from_unit_average_m"] == 0.0
    assert state["central_cell_mean_l2_deviation_from_unit_average_m"] > 1.4
    assert state["mean_l2_deviation_relative_error"] == 1.0
    assert report["metrics"]["relaxation_state_mean_deviation_relative_error"] == 1.0
    assert "relaxation_state_mean_deviation_relative_error" in result.stderr


def test_supercell_report_uses_central_cell_extraction_not_global_average(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_validation.v1.json"
    write_artifacts(
        unit,
        e_demag=1.0e-18,
        final_torque=4.0e3,
        m_values=[[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]],
    )
    write_artifacts(
        supercell,
        e_demag=9.0e-18,
        final_torque=4.0e3,
        universe_size_m=[6.0e-7, 6.0e-7, 9.0e-8],
        m_values=[
            [0.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
            [2.0, -1.0, 0.0],
            [2.0, -1.0, 0.0],
        ],
        h_values=[1.0e3, 1.0e3, 1.0e3, 1.0e3, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        phi_values=[1.0e-3, 1.2e-3, 1.0e-3, 1.2e-3],
    )
    write_supercell_central_cell_extraction(
        supercell,
        magnetic_node_indices=[0, 1],
        field_cell_indices=[0, 1],
        e_demag=1.0e-18,
        final_torque=4.0e3,
    )

    result = run_report(
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
        str(report_path),
    )

    assert result.returncode != 0
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "failed"
    assert "average_m_l2_delta" in result.stderr


def test_supercell_report_uses_unit_magnetic_node_mask_for_average_m(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_validation.v1.json"
    write_artifacts(
        unit,
        e_demag=1.0e-18,
        final_torque=4.0e3,
        m_values=[
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 0.0],
        ],
        h_values=[1.0e3, 1.0e3, 1.0e3, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        phi_values=[1.0e-3, 1.2e-3, 1.1e-3],
    )
    write_node_geometry(unit, magnetic_node_mask=[True, True, False])
    write_artifacts(
        supercell,
        e_demag=9.0e-18,
        final_torque=4.0e3,
        universe_size_m=[6.0e-7, 6.0e-7, 9.0e-8],
        m_values=[
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
        ],
        h_values=[1.0e3, 1.0e3, 1.0e3, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        phi_values=[1.0e-3, 1.2e-3, 1.1e-3],
    )
    write_supercell_central_cell_extraction(
        supercell,
        magnetic_node_indices=[0, 1],
        field_cell_indices=[0, 1],
        e_demag=1.0e-18,
        final_torque=4.0e3,
    )

    result = run_report(
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
        str(report_path),
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "ok"
    assert report["metrics"]["average_m_l2_delta"] == 0.0


def test_supercell_report_uses_unit_metadata_mesh_for_average_m_without_node_geometry(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_validation.v1.json"
    write_artifacts(
        unit,
        e_demag=1.0e-18,
        final_torque=4.0e3,
        m_values=[
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 0.0],
        ],
        h_values=[1.0e3] * 5 + [0.0] * 10,
        phi_values=[1.0e-3, 1.2e-3, 1.1e-3, 1.05e-3, 1.15e-3],
    )
    add_metadata_mesh(
        unit,
        nodes=[[float(index), 0.0, 0.0] for index in range(5)],
        elements=[[0, 1, 2, 3], [1, 2, 3, 4]],
        element_markers=[1, 0],
    )
    write_artifacts(
        supercell,
        e_demag=9.0e-18,
        final_torque=4.0e3,
        universe_size_m=[6.0e-7, 6.0e-7, 9.0e-8],
        m_values=[
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
        ],
        h_values=[1.0e3, 1.0e3, 1.0e3, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        phi_values=[1.0e-3, 1.2e-3, 1.1e-3],
    )
    write_supercell_central_cell_extraction(
        supercell,
        magnetic_node_indices=[0, 1],
        field_cell_indices=[0, 1],
        e_demag=1.0e-18,
        final_torque=4.0e3,
    )

    result = run_report(
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
        str(report_path),
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "ok"
    assert report["metrics"]["average_m_l2_delta"] == 0.0


def test_report_writer_rejects_excessive_z_padding_energy_drift(tmp_path: Path) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(reference, e_demag=1.0e-18, universe_size_m=[2.0e-7, 2.0e-7, 1.3e-7])
    write_artifacts(candidate, e_demag=2.0e-18, universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8])

    result = run_report(
        "z-padding",
        "--reference",
        str(reference),
        "--candidate",
        str(candidate),
        "--report",
        str(report_path),
    )

    assert result.returncode != 0
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "failed"
    assert "e_demag_relative_error" in result.stderr


def test_z_padding_report_rejects_self_comparison(tmp_path: Path) -> None:
    root = tmp_path / "same" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(root, e_demag=1.0e-18)

    result = run_report(
        "z-padding",
        "--reference",
        str(root),
        "--candidate",
        str(root),
        "--report",
        str(report_path),
    )

    assert result.returncode != 0
    assert "reference and candidate artifact roots must be different" in result.stderr
    assert not report_path.exists()


def test_supercell_report_rejects_self_comparison(tmp_path: Path) -> None:
    root = tmp_path / "same" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_validation.v1.json"
    write_artifacts(root, e_demag=1.0e-18)

    result = run_report(
        "supercell",
        "--unit-cell",
        str(root),
        "--supercell",
        str(root),
        "--repeat-x",
        "3",
        "--repeat-y",
        "3",
        "--report",
        str(report_path),
    )

    assert result.returncode != 0
    assert "unit-cell and supercell artifact roots must be different" in result.stderr
    assert not report_path.exists()


def test_z_padding_report_rejects_different_static_pbc_workloads(tmp_path: Path) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(reference, e_demag=1.0e-18, scenario="exchange_coupled")
    write_artifacts(candidate, e_demag=1.001e-18, scenario="air_gap")

    result = run_report(
        "z-padding",
        "--reference",
        str(reference),
        "--candidate",
        str(candidate),
        "--report",
        str(report_path),
    )

    assert result.returncode != 0
    assert "scenario must match" in result.stderr
    assert not report_path.exists()


def test_z_padding_report_rejects_identical_airbox_padding(tmp_path: Path) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(reference, e_demag=1.0e-18, universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8])
    write_artifacts(candidate, e_demag=1.001e-18, universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8])

    result = run_report(
        "z-padding",
        "--reference",
        str(reference),
        "--candidate",
        str(candidate),
        "--report",
        str(report_path),
    )

    assert result.returncode != 0
    assert "z-padding comparison requires different open-z universe_size_m" in result.stderr
    assert not report_path.exists()


def test_supercell_report_rejects_unscaled_supercell_geometry(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_validation.v1.json"
    write_artifacts(unit, e_demag=1.0e-18, final_torque=4.0e3)
    write_artifacts(supercell, e_demag=9.01e-18, final_torque=4.01e3)
    write_supercell_central_cell_extraction(supercell, e_demag=1.001e-18, final_torque=4.01e3)

    result = run_report(
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
        str(report_path),
    )

    assert result.returncode != 0
    assert "supercell comparison requires lateral universe_size_m scaled by repeat_x/repeat_y" in result.stderr
    assert not report_path.exists()


def test_supercell_report_rejects_non_periodic_airbox_workload(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_validation.v1.json"
    write_artifacts(unit, e_demag=1.0e-18, demag="periodic_airbox_k0")
    write_artifacts(supercell, e_demag=9.01e-18, demag="open", universe_size_m=[6.0e-7, 6.0e-7, 9.0e-8])
    write_supercell_central_cell_extraction(supercell, e_demag=1.001e-18)

    result = run_report(
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
        str(report_path),
    )

    assert result.returncode != 0
    assert "pbc.demag must be periodic_airbox_k0" in result.stderr
    assert not report_path.exists()
