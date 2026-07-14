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


def write_zarr_field(
    root: Path,
    *,
    observable: str,
    component_order: list[str],
    values: list[float],
    initial_values: list[float] | None = None,
) -> None:
    field_dir = root / "fields" / f"{observable}.zarr"
    field_dir.mkdir(parents=True, exist_ok=True)
    component_count = len(component_order)
    assert len(values) % component_count == 0
    if initial_values is not None:
        assert len(initial_values) == len(values)
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
    sample_count = 2 if initial_values is not None else 1
    (field_dir / ".zarray").write_text(
        json.dumps({"dtype": "<f8", "order": "C", "shape": [sample_count, component_count, cell_count]}),
        encoding="utf-8",
    )
    with (field_dir / "samples.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["sample", "step", "time", "solver_dt", "chunk_key"])
        writer.writeheader()
        if initial_values is None:
            writer.writerow({"sample": "0", "step": "4", "time": "0.0", "solver_dt": "0.0", "chunk_key": "0.0.0"})
            (field_dir / "0.0.0").write_bytes(struct.pack(f"<{len(values)}d", *values))
        else:
            writer.writerow({"sample": "0", "step": "0", "time": "0.0", "solver_dt": "0.0", "chunk_key": "0.0.0"})
            writer.writerow({"sample": "1", "step": "4", "time": "0.0", "solver_dt": "0.0", "chunk_key": "1.0.0"})
            (field_dir / "0.0.0").write_bytes(struct.pack(f"<{len(initial_values)}d", *initial_values))
            (field_dir / "1.0.0").write_bytes(struct.pack(f"<{len(values)}d", *values))


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


def write_static_pbc_seam_diagnostics(root: Path, *, step: int = 4) -> None:
    diagnostics_dir = root / "diagnostics"
    diagnostics_dir.mkdir(parents=True, exist_ok=True)
    (diagnostics_dir / "fem_static_pbc_demag_seams.v1.json").write_text(
        json.dumps(
            {
                "schema_version": "fem_static_pbc_demag_seams.v1",
                "status": "ok",
                "step": step,
                "pair_diagnostics": [
                    {
                        "pair_id": "x_faces",
                        "m_seam_max": 0.0,
                        "h_demag_seam_max_Apm": 0.0,
                        "demag_phi_seam_max_after_offset_A": 0.0,
                        "b_normal_flux_seam_max_T": 0.0,
                        "side_magnetic_charge_sum_abs_Am": 0.0,
                    },
                    {
                        "pair_id": "y_faces",
                        "m_seam_max": 0.0,
                        "h_demag_seam_max_Apm": 0.0,
                        "demag_phi_seam_max_after_offset_A": 0.0,
                        "b_normal_flux_seam_max_T": 0.0,
                        "side_magnetic_charge_sum_abs_Am": 0.0,
                    },
                ],
            }
        ),
        encoding="utf-8",
    )


def write_periodic_pairs_artifact(root: Path) -> None:
    mesh_dir = root / "mesh"
    mesh_dir.mkdir(parents=True, exist_ok=True)
    (mesh_dir / "periodic_pairs.v1.json").write_text(
        json.dumps(
            {
                "schema_version": "periodic_pairs.v1",
                "validation_status": "ok",
                "pair_count": 2,
                "paired_node_count": 4,
                "max_translation_residual_m": 0.0,
                "pairs": [
                    {
                        "pair_id": "x_faces",
                        "status": "valid",
                        "paired_node_count": 2,
                        "domain_node_pair_counts": {"magnetic": 1, "airbox": 1},
                        "node_pairs": [{"node_a": 0, "node_b": 1}, {"node_a": 2, "node_b": 3}],
                        "boundary_face_pairs": [
                            {
                                "face_a": 10,
                                "face_b": 11,
                                "translation_m": [2.0e-7, 0.0, 0.0],
                                "normal_dot": -1.0,
                                "orientation": "opposed_normals",
                            }
                        ],
                    },
                    {
                        "pair_id": "y_faces",
                        "status": "valid",
                        "paired_node_count": 2,
                        "domain_node_pair_counts": {"magnetic": 1, "airbox": 1},
                        "node_pairs": [{"node_a": 0, "node_b": 2}, {"node_a": 1, "node_b": 3}],
                        "boundary_face_pairs": [
                            {
                                "face_a": 20,
                                "face_b": 21,
                                "translation_m": [0.0, 2.0e-7, 0.0],
                                "normal_dot": -1.0,
                                "orientation": "opposed_normals",
                            }
                        ],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )


def fragment_periodic_pairs_artifact(root: Path) -> None:
    pairs_path = root / "mesh" / "periodic_pairs.v1.json"
    payload = json.loads(pairs_path.read_text(encoding="utf-8"))
    original_pairs = payload["pairs"]
    payload["pairs"] = [
        json.loads(json.dumps(pair))
        for pair in original_pairs
        for _ in range(3)
    ]
    payload["pair_count"] = 6
    payload["paired_node_count"] = 12
    pairs_path.write_text(json.dumps(payload), encoding="utf-8")

    metadata_path = root / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["mesh"]["periodic_boundary_pair_count"] = 6
    metadata["mesh"]["periodic_boundary_pair_counts_by_id"] = {
        "x_faces": 3,
        "y_faces": 3,
    }
    reduction = metadata["demag_runtime"]["periodic_reduction"]
    reduction["boundary_pair_count"] = 6
    reduction["boundary_pair_counts_by_id"] = {"x_faces": 3, "y_faces": 3}
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")


def add_authoritative_mesh_topology(root: Path) -> None:
    metadata_path = root / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata.setdefault("execution_plan", {}).setdefault("backend_plan", {})["mesh"] = {
        "nodes": [[0.0, 0.0, 0.0] for _ in range(4)],
        "elements": [[0, 1, 2, 3]],
        "element_markers": [1],
        "boundary_faces": [[0, 1, 2] for _ in range(22)],
    }
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")


def write_artifacts(
    root: Path,
    *,
    e_demag: float,
    scenario: str = "exchange_coupled",
    demag: str = "periodic_airbox_k0",
    final_torque: float = 4.0e3,
    universe_size_m: list[float] | None = None,
    m_values: list[list[float]] | None = None,
    m_initial_values: list[list[float]] | None = None,
    h_values: list[float] | None = None,
    h_initial_values: list[float] | None = None,
    phi_values: list[float] | None = None,
    phi_initial_values: list[float] | None = None,
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
                "mesh": {
                    "periodic_boundary_pair_count": 2,
                    "periodic_node_pair_count": 4,
                    "periodic_boundary_pair_counts_by_id": {"x_faces": 1, "y_faces": 1},
                    "periodic_node_pair_counts_by_id": {"x_faces": 2, "y_faces": 2},
                },
                "demag_runtime": {
                    "model": "airbox",
                    "magnetostatic_boundary_model": "periodic_airbox_k0",
                    "poisson_operator": "pbc_reduced_poisson",
                    "periodic_reduction": {
                        "enabled": True,
                        "method": "P^T A P",
                        "node_pair_count": 4,
                        "boundary_pair_count": 2,
                        "node_pair_counts_by_id": {"x_faces": 2, "y_faces": 2},
                        "boundary_pair_counts_by_id": {"x_faces": 1, "y_faces": 1},
                        "periodic_boundary_markers_excluded_from_robin": True,
                    },
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
    if m_initial_values is None:
        m_initial_values = m_values
    (root / "m_final.json").write_text(
        json.dumps({"observable": "m", "unit": "1", "step": 4, "values": m_values}),
        encoding="utf-8",
    )
    (root / "m_initial.json").write_text(
        json.dumps({"observable": "m", "unit": "1", "step": 0, "values": m_initial_values}),
        encoding="utf-8",
    )
    write_static_pbc_seam_diagnostics(root)
    write_periodic_pairs_artifact(root)
    write_node_geometry(root, magnetic_node_mask=[any(abs(component) > 0.0 for component in vector) for vector in m_values])
    if h_values is None:
        h_values = [1.0e3, 1.0e3, 0.0, 0.0, 0.0, 0.0]
    if phi_values is None:
        phi_values = [1.0e-3, 1.2e-3]
    write_zarr_field(
        root,
        observable="H_demag",
        component_order=["x", "y", "z"],
        values=h_values,
        initial_values=h_initial_values,
    )
    write_zarr_field(
        root,
        observable="demag_phi",
        component_order=["scalar"],
        values=phi_values,
        initial_values=phi_initial_values,
    )


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


def test_z_padding_report_rejects_candidate_without_pbc_reduced_demag_runtime(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(reference, e_demag=1.0e-18, universe_size_m=[2.0e-7, 2.0e-7, 1.3e-7])
    write_artifacts(candidate, e_demag=1.001e-18, universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8])
    metadata_path = candidate / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["demag_runtime"]["poisson_operator"] = "finite_airbox_robin"
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

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
    assert "metadata.demag_runtime.poisson_operator" in result.stderr


def test_z_padding_report_rejects_candidate_without_seam_diagnostics(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(reference, e_demag=1.0e-18, universe_size_m=[2.0e-7, 2.0e-7, 1.3e-7])
    write_artifacts(candidate, e_demag=1.001e-18, universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8])
    seam_path = candidate / "diagnostics" / "fem_static_pbc_demag_seams.v1.json"
    seam_path.unlink(missing_ok=True)

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
    assert "fem_static_pbc_demag_seams.v1.json" in result.stderr


def test_z_padding_report_rejects_candidate_without_periodic_pairs_artifact(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(reference, e_demag=1.0e-18, universe_size_m=[2.0e-7, 2.0e-7, 1.3e-7])
    write_artifacts(candidate, e_demag=1.001e-18, universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8])
    (candidate / "mesh" / "periodic_pairs.v1.json").unlink()

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
    assert "mesh/periodic_pairs.v1.json" in result.stderr


def test_z_padding_report_accepts_fragmented_boundary_pair_definitions(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(
        reference,
        e_demag=1.0e-18,
        universe_size_m=[2.0e-7, 2.0e-7, 1.3e-7],
    )
    write_artifacts(
        candidate,
        e_demag=1.001e-18,
        universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8],
    )
    fragment_periodic_pairs_artifact(reference)
    fragment_periodic_pairs_artifact(candidate)

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
    assert json.loads(report_path.read_text(encoding="utf-8"))["status"] == "ok"


def test_z_padding_report_rejects_fragmented_definition_with_different_node_mapping(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(reference, e_demag=1.0e-18, universe_size_m=[2.0e-7, 2.0e-7, 1.3e-7])
    write_artifacts(candidate, e_demag=1.001e-18, universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8])
    fragment_periodic_pairs_artifact(reference)
    fragment_periodic_pairs_artifact(candidate)
    pairs_path = candidate / "mesh" / "periodic_pairs.v1.json"
    payload = json.loads(pairs_path.read_text(encoding="utf-8"))
    x_fragments = [pair for pair in payload["pairs"] if pair["pair_id"] == "x_faces"]
    x_fragments[1]["node_pairs"] = [
        {"node_a": 0, "node_b": 2},
        {"node_a": 1, "node_b": 3},
    ]
    pairs_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_report(
        "z-padding", "--reference", str(reference), "--candidate", str(candidate), "--report", str(report_path)
    )

    assert result.returncode != 0
    assert "node_pairs must match every fragmented definition" in result.stderr


def test_z_padding_report_accepts_last_valid_periodic_node_and_face_indices(tmp_path: Path) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(reference, e_demag=1.0e-18, universe_size_m=[2.0e-7, 2.0e-7, 1.3e-7])
    write_artifacts(candidate, e_demag=1.001e-18, universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8])
    add_authoritative_mesh_topology(reference)
    add_authoritative_mesh_topology(candidate)

    result = run_report(
        "z-padding", "--reference", str(reference), "--candidate", str(candidate), "--report", str(report_path)
    )

    assert result.returncode == 0, result.stderr


def test_z_padding_report_rejects_first_periodic_node_index_outside_mesh(tmp_path: Path) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(reference, e_demag=1.0e-18, universe_size_m=[2.0e-7, 2.0e-7, 1.3e-7])
    write_artifacts(candidate, e_demag=1.001e-18, universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8])
    add_authoritative_mesh_topology(reference)
    add_authoritative_mesh_topology(candidate)
    pairs_path = candidate / "mesh" / "periodic_pairs.v1.json"
    payload = json.loads(pairs_path.read_text(encoding="utf-8"))
    payload["pairs"][0]["node_pairs"][0]["node_a"] = 4
    pairs_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_report(
        "z-padding", "--reference", str(reference), "--candidate", str(candidate), "--report", str(report_path)
    )

    assert result.returncode != 0
    assert "node_a must be less than mesh node count 4" in result.stderr


def test_z_padding_report_rejects_first_periodic_face_index_outside_mesh(tmp_path: Path) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(reference, e_demag=1.0e-18, universe_size_m=[2.0e-7, 2.0e-7, 1.3e-7])
    write_artifacts(candidate, e_demag=1.001e-18, universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8])
    add_authoritative_mesh_topology(reference)
    add_authoritative_mesh_topology(candidate)
    pairs_path = candidate / "mesh" / "periodic_pairs.v1.json"
    payload = json.loads(pairs_path.read_text(encoding="utf-8"))
    payload["pairs"][1]["boundary_face_pairs"][0]["face_b"] = 22
    pairs_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_report(
        "z-padding", "--reference", str(reference), "--candidate", str(candidate), "--report", str(report_path)
    )

    assert result.returncode != 0
    assert "face_b must be less than mesh boundary face count 22" in result.stderr


def test_z_padding_report_rejects_boolean_periodic_count(tmp_path: Path) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(reference, e_demag=1.0e-18, universe_size_m=[2.0e-7, 2.0e-7, 1.3e-7])
    write_artifacts(candidate, e_demag=1.001e-18, universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8])
    metadata_path = candidate / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["mesh"]["periodic_node_pair_count"] = True
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    result = run_report(
        "z-padding", "--reference", str(reference), "--candidate", str(candidate), "--report", str(report_path)
    )

    assert result.returncode != 0
    assert "periodic_node_pair_count must be positive" in result.stderr


def test_z_padding_report_rejects_candidate_with_periodic_pairs_count_drift(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(reference, e_demag=1.0e-18, universe_size_m=[2.0e-7, 2.0e-7, 1.3e-7])
    write_artifacts(candidate, e_demag=1.001e-18, universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8])
    pairs_path = candidate / "mesh" / "periodic_pairs.v1.json"
    pairs = json.loads(pairs_path.read_text(encoding="utf-8"))
    pairs["pairs"][0]["paired_node_count"] = 1
    pairs_path.write_text(json.dumps(pairs), encoding="utf-8")

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
    assert "mesh/periodic_pairs.v1.json.x_faces.paired_node_count must match metadata.mesh" in result.stderr


def test_z_padding_report_rejects_candidate_without_periodic_node_pairs(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(reference, e_demag=1.0e-18, universe_size_m=[2.0e-7, 2.0e-7, 1.3e-7])
    write_artifacts(candidate, e_demag=1.001e-18, universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8])
    pairs_path = candidate / "mesh" / "periodic_pairs.v1.json"
    pairs = json.loads(pairs_path.read_text(encoding="utf-8"))
    pairs["pairs"][0]["node_pairs"] = []
    pairs_path.write_text(json.dumps(pairs), encoding="utf-8")

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
    assert "node_pairs must contain 2 entries" in result.stderr


def test_z_padding_report_rejects_candidate_with_bad_periodic_face_orientation(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(reference, e_demag=1.0e-18, universe_size_m=[2.0e-7, 2.0e-7, 1.3e-7])
    write_artifacts(candidate, e_demag=1.001e-18, universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8])
    pairs_path = candidate / "mesh" / "periodic_pairs.v1.json"
    pairs = json.loads(pairs_path.read_text(encoding="utf-8"))
    pairs["pairs"][0]["boundary_face_pairs"][0]["orientation"] = "parallel_normals"
    pairs["pairs"][0]["boundary_face_pairs"][0]["normal_dot"] = 1.0
    pairs_path.write_text(json.dumps(pairs), encoding="utf-8")

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
    assert "boundary_face_pairs[0].orientation must be opposed_normals" in result.stderr


def test_z_padding_report_rejects_candidate_with_bad_seam_flux_diagnostics(
    tmp_path: Path,
) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(reference, e_demag=1.0e-18, universe_size_m=[2.0e-7, 2.0e-7, 1.3e-7])
    write_artifacts(candidate, e_demag=1.001e-18, universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8])
    seam_path = candidate / "diagnostics" / "fem_static_pbc_demag_seams.v1.json"
    seams = json.loads(seam_path.read_text(encoding="utf-8"))
    seams["pair_diagnostics"][0]["b_normal_flux_seam_max_T"] = 1.0
    seam_path.write_text(json.dumps(seams), encoding="utf-8")

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
    assert "b_normal_flux_seam_max_T" in result.stderr


def test_z_padding_report_rejects_boolean_seam_metric(tmp_path: Path) -> None:
    reference = tmp_path / "reference" / "artifacts"
    candidate = tmp_path / "candidate" / "artifacts"
    report_path = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_artifacts(
        reference,
        e_demag=1.0e-18,
        universe_size_m=[2.0e-7, 2.0e-7, 1.3e-7],
    )
    write_artifacts(
        candidate,
        e_demag=1.001e-18,
        universe_size_m=[2.0e-7, 2.0e-7, 9.0e-8],
    )
    seam_path = candidate / "diagnostics" / "fem_static_pbc_demag_seams.v1.json"
    seams = json.loads(seam_path.read_text(encoding="utf-8"))
    seams["pair_diagnostics"][0]["m_seam_max"] = False
    seam_path.write_text(json.dumps(seams), encoding="utf-8")

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
    assert "m_seam_max must be numeric" in result.stderr


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
    contract = report["comparison_contract"]
    assert contract["purpose"] == "independent_relaxed_supercell_convergence"
    assert contract["precision_class"] == "physical_convergence"
    assert contract["primitive_supercell_equivalence"] == "not_exact_unless_state_periodicity_is_constrained"
    assert contract["independent_supercell_relaxation"] is True
    assert contract["recommended_h_demag_p99_relative_error_band"] == [0.01, 0.05]
    assert contract["status_semantics"] == "acceptance_gate_not_exact_equality"
    assert report["artifact_provenance"]["unit_cell"]["runtime_solve"] is True
    assert report["artifact_provenance"]["supercell"]["runtime_solve"] is True
    assert report["artifact_provenance"]["supercell"]["diagnostic_fixture"] is False
    assert report["metrics"]["e_demag_density_relative_error"] < 2.0e-2
    assert report["metrics"]["relaxation_state_mean_deviation_relative_error"] == 0.0
    assert report["metrics"]["magnetic_node_count_relative_error"] == 0.0
    assert report["metrics"]["field_cell_count_relative_error"] == 0.0
    assert report["central_cell_extraction"]["schema_version"] == "fem_static_pbc_supercell_central_cell.v1"
    assert report["mesh_comparability"]["unit_magnetic_node_count"] == 2
    assert report["mesh_comparability"]["central_cell_magnetic_node_count"] == 2
    assert report["mesh_comparability"]["magnetic_node_count_relative_error"] == 0.0


def test_supercell_initial_state_report_uses_initial_m_and_first_field_snapshot(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_initial_validation.v1.json"
    write_artifacts(
        unit,
        e_demag=1.0e-18,
        final_torque=4.0e3,
        m_initial_values=[[1.0, 0.0, 0.0], [0.98, 0.02, 0.0]],
        m_values=[[1.0, 0.0, 0.0], [0.98, 0.02, 0.0]],
        h_initial_values=[10.0, 20.0, 0.0, 0.0, 0.0, 0.0],
        h_values=[10.0, 20.0, 0.0, 0.0, 0.0, 0.0],
        phi_initial_values=[1.0e-3, 1.2e-3],
        phi_values=[1.0e-3, 1.2e-3],
    )
    write_artifacts(
        supercell,
        e_demag=9.0e-18,
        final_torque=4.0e3,
        universe_size_m=[6.0e-7, 6.0e-7, 9.0e-8],
        m_initial_values=[[1.0, 0.0, 0.0], [0.98, 0.02, 0.0]],
        m_values=[[0.0, 1.0, 0.0], [0.0, 0.98, 0.02]],
        h_initial_values=[10.0, 20.0, 0.0, 0.0, 0.0, 0.0],
        h_values=[100.0, 200.0, 0.0, 0.0, 0.0, 0.0],
        phi_initial_values=[1.7e-3, 1.9e-3],
        phi_values=[10.0e-3, 20.0e-3],
    )
    write_supercell_central_cell_extraction(supercell, e_demag=3.0e-18, final_torque=9.0e3)

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
        "--state",
        "initial",
        "--report",
        str(report_path),
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "ok"
    assert report["comparison_state"] == "initial"
    assert report["metrics"]["average_m_l2_delta"] == 0.0
    assert report["metrics"]["h_demag_stats_relative_error"] == 0.0
    assert report["metrics"]["demag_phi_max_abs_delta_A"] < 1.0e-18
    assert "e_demag_density_relative_error" not in report["metrics"]
    assert "central_cell_torque_residual_relative_error" not in report["metrics"]
    assert "e_demag_density_relative_error" not in report["thresholds"]
    assert "central_cell_torque_residual_relative_error" not in report["thresholds"]


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


def test_interpolated_comparison_reports_affine_phi_and_constant_h_delta_diagnostics(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_validation.v1.json"
    unit_nodes = [
        [0.0, 0.0, 0.0],
        [1.0e-8, 0.0, 0.0],
        [0.0, 1.0e-8, 0.0],
        [0.0, 0.0, 1.0e-8],
    ]
    phi_offset = 7.0e-4
    phi_gradient = [1.0e3, 2.0e3, 3.0e3]
    supercell_phi = [
        phi_offset + sum(phi_gradient[axis] * node[axis] for axis in range(3))
        for node in unit_nodes
    ]
    write_artifacts(
        unit,
        e_demag=1.0e-18,
        final_torque=4.0e3,
        m_values=[[1.0, 0.0, 0.0]] * 4,
        h_values=[0.0] * 12,
        phi_values=[0.0] * 4,
    )
    write_node_geometry(unit, magnetic_node_mask=[True, True, True, True], nodes_m=unit_nodes)
    add_metadata_mesh(unit, nodes=unit_nodes, elements=[[0, 1, 2, 3]], element_markers=[1])
    write_artifacts(
        supercell,
        e_demag=9.0e-18,
        final_torque=4.0e3,
        universe_size_m=[6.0e-7, 6.0e-7, 9.0e-8],
        m_values=[[1.0, 0.0, 0.0]] * 4,
        h_values=[-1.0e3] * 4 + [-2.0e3] * 4 + [-3.0e3] * 4,
        phi_values=supercell_phi,
    )
    write_node_geometry(supercell, magnetic_node_mask=[True, True, True, True], nodes_m=unit_nodes)
    write_supercell_central_cell_extraction(
        supercell,
        magnetic_node_indices=[0, 1, 2, 3],
        field_cell_indices=[0, 1, 2, 3],
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
    interpolated = report["interpolated_central_cell_comparability"]
    h_diag = interpolated["H_demag"]
    phi_diag = interpolated["demag_phi"]
    assert h_diag["mean_delta_vector_Apm"] == [-1.0e3, -2.0e3, -3.0e3]
    assert h_diag["p99_l2_delta_after_mean_delta"] < 1.0e-12
    assert phi_diag["max_abs_delta_after_offset_A"] > 1.0e-5
    assert abs(phi_diag["best_affine_offset_A"] - phi_offset) < 1.0e-15
    for actual, expected in zip(phi_diag["best_affine_gradient_A_per_m"], phi_gradient):
        assert abs(actual - expected) < 1.0e-6
    assert phi_diag["max_abs_delta_after_affine_A"] < 1.0e-18


def test_interpolated_comparison_reports_spatial_error_profiles(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_interpolated_validation.v1.json"
    unit_nodes = [
        [0.0, 0.0, 0.0],
        [1.0e-8, 0.0, 0.0],
        [0.0, 1.0e-8, 0.0],
        [0.0, 0.0, 1.0e-8],
    ]
    supercell_nodes = [
        [1.0e-9, 1.0e-9, 1.0e-9],
        [4.0e-9, 3.0e-9, 1.0e-9],
        [3.0e-9, 4.0e-9, 1.0e-9],
        [3.0e-9, 2.0e-9, 4.0e-9],
        [2.0e-9, 3.0e-9, 3.0e-9],
    ]
    write_artifacts(
        unit,
        e_demag=1.0e-18,
        universe_size_m=[1.0e-8, 1.0e-8, 9.0e-8],
        final_torque=4.0e3,
        m_values=[[1.0, 0.0, 0.0]] * 4,
        h_values=[0.0] * 12,
        phi_values=[0.0] * 4,
    )
    write_node_geometry(unit, magnetic_node_mask=[True, True, True, True], nodes_m=unit_nodes)
    add_metadata_mesh(unit, nodes=unit_nodes, elements=[[0, 1, 2, 3]], element_markers=[1])
    write_artifacts(
        supercell,
        e_demag=9.0e-18,
        universe_size_m=[3.0e-8, 3.0e-8, 9.0e-8],
        final_torque=4.0e3,
        m_values=[[1.0, 0.0, 0.0]] * 5,
        h_values=[10.0, -2.0, -2.0, -2.0, -4.0] + [0.0] * 10,
        phi_values=[1.0e-3, 0.0, 0.0, 0.0, 0.0],
    )
    write_node_geometry(supercell, magnetic_node_mask=[True] * 5, nodes_m=supercell_nodes)
    write_supercell_central_cell_extraction(
        supercell,
        magnetic_node_indices=[0, 1, 2, 3, 4],
        field_cell_indices=[0, 1, 2, 3, 4],
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
    interpolated = report["interpolated_central_cell_comparability"]
    h_profile = interpolated["H_demag"]["spatial_error_profile_after_mean_delta"]
    assert h_profile["max_error"] == 10.0
    for actual, expected in zip(h_profile["max_error_point_m"], supercell_nodes[0]):
        assert abs(actual - expected) < 1.0e-24
    assert abs(h_profile["max_error_lateral_seam_distance_m"] - 1.0e-9) < 1.0e-24
    assert h_profile["top_error_sample_count"] == 1
    phi_profile = interpolated["demag_phi"]["spatial_residual_profile_after_affine"]
    assert phi_profile["sample_count"] == 5
    assert phi_profile["max_error"] > 0.0
    assert phi_profile["max_error_lateral_seam_distance_m"] >= 0.0


def test_supercell_report_can_accept_interpolated_remesh_basis(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_interpolated_validation.v1.json"
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
        "supercell",
        "--unit-cell",
        str(unit),
        "--supercell",
        str(supercell),
        "--repeat-x",
        "3",
        "--repeat-y",
        "3",
        "--accept-interpolated-comparison",
        "--report",
        str(report_path),
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "ok"
    assert report["acceptance_basis"] == "interpolated_remesh"
    assert report["mapped_central_cell_comparability"]["same_local_discretization"] is False
    assert "mapped_max_nearest_magnetic_node_distance_m" not in report["thresholds"]
    assert report["metrics"]["interpolated_field_missed_count"] == 0
    assert report["metrics"]["interpolated_magnetic_missed_count"] == 0
    assert report["metrics"]["interpolated_m_p99_l2_delta"] < 1.0e-14
    assert report["metrics"]["interpolated_h_demag_p99_relative_error"] < 1.0e-14
    assert report["metrics"]["interpolated_demag_phi_max_abs_delta_after_offset_A"] < 1.0e-18


def test_supercell_report_can_compare_unit_final_to_supercell_initial_state(tmp_path: Path) -> None:
    unit = tmp_path / "unit" / "artifacts"
    supercell = tmp_path / "supercell" / "artifacts"
    report_path = tmp_path / "reports" / "supercell_interpolated_initial_operator_validation.v1.json"
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
        m_initial_values=[
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0],
        ],
        m_values=[
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 1.0, 1.0],
        ],
        h_initial_values=[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        h_values=[10.0, 20.0, 30.0, 40.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        phi_initial_values=[0.0, 0.0, 0.0, 0.0],
        phi_values=[1.0e-3, 2.0e-3, 3.0e-3, 4.0e-3],
    )
    write_node_geometry(unit, magnetic_node_mask=[True, True, True, True], nodes_m=unit_nodes)
    add_metadata_mesh(unit, nodes=unit_nodes, elements=[[0, 1, 2, 3]], element_markers=[1])
    write_artifacts(
        supercell,
        e_demag=9.0e-18,
        final_torque=4.0e3,
        universe_size_m=[6.0e-7, 6.0e-7, 9.0e-8],
        m_initial_values=[[0.5, 0.5, 0.5]],
        m_values=[[0.0, 0.0, 1.0]],
        h_initial_values=[25.0, 0.0, 0.0],
        h_values=[0.0, 0.0, 0.0],
        phi_initial_values=[2.5e-3],
        phi_values=[0.0],
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
        "supercell",
        "--unit-cell",
        str(unit),
        "--supercell",
        str(supercell),
        "--repeat-x",
        "3",
        "--repeat-y",
        "3",
        "--unit-state",
        "final",
        "--supercell-state",
        "initial",
        "--accept-interpolated-comparison",
        "--report",
        str(report_path),
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "ok"
    assert report["comparison_state"] == "final_to_initial"
    assert report["unit_comparison_state"] == "final"
    assert report["supercell_comparison_state"] == "initial"
    contract = report["comparison_contract"]
    assert contract["purpose"] == "frozen_repeated_state_operator_equivalence"
    assert contract["precision_class"] == "technical_operator"
    assert contract["primitive_supercell_equivalence"] == "same_magnetization_state_only"
    assert contract["independent_supercell_relaxation"] is False
    assert "e_demag_density_relative_error" not in report["thresholds"]
    assert "central_cell_torque_residual_relative_error" not in report["thresholds"]
    assert report["metrics"]["interpolated_m_p99_l2_delta"] < 1.0e-14
    assert report["metrics"]["interpolated_h_demag_p99_relative_error"] < 1.0e-14


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
