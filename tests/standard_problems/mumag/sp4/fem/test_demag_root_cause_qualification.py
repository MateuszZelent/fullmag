from __future__ import annotations

import csv
import json
import math
import os
from pathlib import Path
import struct

import pytest

from tests.standard_problems.mumag.sp4.fem.demag_root_cause_qualification import (
    FDM_NEWELL_ENERGY_J,
    QualificationError,
    _p1_energies,
    qualify_p1_root_cause,
    qualify_p2_edge,
)


MU0 = 4.0e-7 * math.pi


def test_recovered_field_energy_uses_exact_p1_mass_bilinear() -> None:
    nodes = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    m = [[1.0, 0.0, 0.0], [2.0, 0.0, 0.0], [3.0, 0.0, 0.0], [4.0, 0.0, 0.0]]
    hx = [-2.0, -3.0, -5.0, -7.0]
    ms = 3.2
    _, recovered, _ = _p1_energies(
        nodes=nodes,
        elements=[[0, 1, 2, 3]],
        magnetic_elements=[0],
        m=m,
        phi=[0.0] * 4,
        h_demag_component_major=hx + [0.0] * 8,
        ms=ms,
    )
    local = sum(
        (2.0 if i == j else 1.0) * m[i][0] * hx[j]
        for i in range(4)
        for j in range(4)
    )
    expected = -0.5 * MU0 * ms * (1.0 / 6.0) * local / 20.0

    assert recovered == pytest.approx(expected)


def _write_zarr_vector(root: Path, values: list[float]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / ".zarray").write_text(
        json.dumps(
            {
                "zarr_format": 2,
                "shape": [1, len(values)],
                "chunks": [1, len(values)],
                "dtype": "<f8",
                "compressor": None,
                "fill_value": None,
                "order": "C",
                "filters": None,
                "dimension_separator": ".",
            }
        ),
        encoding="utf-8",
    )
    (root / "0.0").write_bytes(struct.pack(f"<{len(values)}d", *values))


def _write_artifacts(
    root: Path,
    *,
    phi_scale: float = 1.0,
    h_scale: float = 1.0,
    native_terminal_scale: float | None = None,
    potential_order: int = 1,
) -> Path:
    artifacts = root / "artifacts"
    artifacts.mkdir(parents=True)
    # Unit tetrahedron. Ms is chosen so mu0/2 integral(M.grad(phi)) equals
    # the FDM oracle when phi_scale=1; no FEM result is embedded in the test.
    ms = 12.0 * FDM_NEWELL_ENERGY_J / MU0
    mesh = {
        "nodes": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        "cells": {
            "types": ["tet4"],
            "offsets": [0, 4],
            "nodes": [0, 1, 2, 3],
            "global_ordinals": [0],
            "mesh_parts": [],
        },
        "element_markers": [1],
        "mesh_name": "fixed-sp4-test-mesh",
    }
    size_fields = [
        {
            "kind": "EdgeDistanceThreshold",
            "status": "applied",
            "params": {"GeometryName": "film", "SizeMin": 1e-9, "SizeMax": 8e-9, "DistMin": 6e-9, "DistMax": 18e-9},
        },
        {
            "kind": "CornerDistanceThreshold",
            "status": "applied",
            "params": {"GeometryName": "film", "SizeMin": 1e-9, "SizeMax": 8e-9, "DistMin": 8e-9, "DistMax": 24e-9},
        },
    ]
    metadata = {
        "execution_provenance": {
            "execution_engine": "fem_cpu_native",
            "precision": "double",
            "lossy_fallback_used": False,
            "resolved_demag_realization": "fem_poisson_robin",
            "fem_poisson_demag": {
                "potential_order": potential_order,
                "potential_true_dof_count": 4 if potential_order == 1 else 10,
                "variational_energy_joules": FDM_NEWELL_ENERGY_J
                * (phi_scale if native_terminal_scale is None else native_terminal_scale),
                "recovered_field_energy_joules": FDM_NEWELL_ENERGY_J
                * (h_scale if native_terminal_scale is None else native_terminal_scale),
            },
        },
        "mesh": {
            "node_count": 4,
            "element_count": 1,
            "mesh_generation_id": "fixed-mesh-digest",
            "mesh_build_report": {
                "effective_airbox_target": {"minimum_element_size": 8e-9, "maximum_element_size": 110e-9},
                "size_fields_realized": size_fields,
            },
        },
        "execution_plan": {
            "backend_plan": {
                "fe_order": 1,
                "mesh": mesh,
                "object_segments": [
                    {"object_id": "film", "element_start": 0, "element_count": 1, "node_start": 0, "node_count": 4}
                ],
                "material": {"saturation_magnetisation": ms},
            }
        },
    }
    (artifacts / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    initial_m = [[1.0, 0.0, 0.0]] * 4
    final_m = [[0.9, 0.1, 0.0]] * 4
    (artifacts / "m_initial.json").write_text(json.dumps({"values": initial_m}), encoding="utf-8")
    (artifacts / "m_final.json").write_text(json.dumps({"values": final_m}), encoding="utf-8")
    _write_zarr_vector(artifacts / "fields/demag_phi.zarr", [0.0, phi_scale, 0.0, 0.0])
    _write_zarr_vector(
        artifacts / "fields/H_demag.zarr",
        [-h_scale] * 4 + [0.0] * 8,
    )
    with (artifacts / "scalars.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=["step", "mx", "my", "mz", "E_demag"])
        writer.writeheader()
        writer.writerow({"step": 0, "mx": 1.0, "my": 0.0, "mz": 0.0, "E_demag": FDM_NEWELL_ENERGY_J * phi_scale})
        writer.writerow({"step": 1, "mx": 0.9, "my": 0.1, "mz": 0.0, "E_demag": FDM_NEWELL_ENERGY_J})
    telemetry = {
        "revision": 2,
        "total_rows": 2,
        "returned_rows": 2,
        "columns": ["step", "mx", "my", "mz", "e_demag"],
        "rows": [
            [0.0, 1.0, 0.0, 0.0, FDM_NEWELL_ENERGY_J],
            [1.0, 0.9, 0.1, 0.0, FDM_NEWELL_ENERGY_J],
        ],
    }
    (root / "telemetry.json").write_text(json.dumps(telemetry), encoding="utf-8")
    return artifacts


def test_p1_root_cause_classifies_consistent_p1_that_misses_oracle_as_approximation(
    tmp_path: Path,
) -> None:
    artifacts = _write_artifacts(tmp_path, phi_scale=0.94, h_scale=0.94)

    report = qualify_p1_root_cause(artifacts)

    assert report["verdict"] == "p1_approximation_error"
    assert report["same_fixed_mesh"] is True
    assert report["energies_j"]["production_p1_rhs_dot_potential"] == pytest.approx(
        0.94 * FDM_NEWELL_ENERGY_J
    )
    assert report["energies_j"]["p1_recovered_h_demag"] == pytest.approx(
        0.94 * FDM_NEWELL_ENERGY_J
    )


def test_p1_root_cause_prioritizes_operator_rhs_recovery_mismatch(tmp_path: Path) -> None:
    artifacts = _write_artifacts(tmp_path, phi_scale=0.94, h_scale=0.80)

    report = qualify_p1_root_cause(artifacts)

    assert report["verdict"] == "operator_rhs_recovery_mismatch"


def test_p1_root_cause_does_not_compare_snapshot_energy_to_terminal_state(
    tmp_path: Path,
) -> None:
    artifacts = _write_artifacts(
        tmp_path,
        phi_scale=0.94,
        h_scale=0.94,
        native_terminal_scale=0.90,
    )

    report = qualify_p1_root_cause(artifacts)

    assert report["verdict"] == "p1_approximation_error"
    assert report["energies_j"]["snapshot_p1_rhs_dot_potential"] == pytest.approx(
        0.94 * FDM_NEWELL_ENERGY_J
    )
    assert report["energies_j"]["native_terminal_variational"] == pytest.approx(
        0.90 * FDM_NEWELL_ENERGY_J
    )


def test_p1_root_cause_rejects_a_non_p1_potential(tmp_path: Path) -> None:
    artifacts = _write_artifacts(tmp_path, potential_order=2)

    with pytest.raises(QualificationError, match="P1 scalar potential"):
        qualify_p1_root_cause(artifacts)


def test_p1_root_cause_requires_native_energy_diagnostics(tmp_path: Path) -> None:
    artifacts = _write_artifacts(tmp_path)
    metadata_path = artifacts / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["execution_provenance"]["fem_poisson_demag"].pop(
        "recovered_field_energy_joules"
    )
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    with pytest.raises(QualificationError, match="native demag energy diagnostics"):
        qualify_p1_root_cause(artifacts)


def test_p2_edge_gate_requires_root_cause_and_captures_all_average_m_sources(
    tmp_path: Path,
) -> None:
    artifacts = _write_artifacts(tmp_path, phi_scale=0.94, h_scale=0.94)
    root_report = qualify_p1_root_cause(artifacts)
    root_report_path = tmp_path / "root-cause.json"
    root_report_path.write_text(json.dumps(root_report), encoding="utf-8")
    metadata_path = artifacts / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["execution_provenance"]["fem_poisson_demag"].update(
        {"potential_order": 2, "potential_true_dof_count": 10}
    )
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    _write_zarr_vector(artifacts / "fields/demag_phi.zarr", [0.0, 1.0, 0.0, 0.0])
    _write_zarr_vector(artifacts / "fields/H_demag.zarr", [-1.0] * 4 + [0.0] * 8)
    rows = list(csv.DictReader((artifacts / "scalars.csv").open(encoding="utf-8")))
    rows[0]["E_demag"] = repr(FDM_NEWELL_ENERGY_J)
    with (artifacts / "scalars.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    report = qualify_p2_edge(
        artifacts,
        root_report_path=root_report_path,
        telemetry_path=tmp_path / "telemetry.json",
    )

    assert report["status"] == "qualified"
    assert report["initial_demag_energy"]["relative_error"] <= 0.01
    assert report["final_average_m"]["table"] == pytest.approx([0.9, 0.1, 0.0])
    assert report["final_average_m"]["telemetry"] == pytest.approx([0.9, 0.1, 0.0])
    assert report["final_average_m"]["recomputed_from_m_final"] == pytest.approx([0.9, 0.1, 0.0])


def test_p2_edge_gate_rejects_telemetry_without_initial_and_final_rows(
    tmp_path: Path,
) -> None:
    artifacts = _write_artifacts(tmp_path, phi_scale=0.94, h_scale=0.94)
    root_report = qualify_p1_root_cause(artifacts)
    root_report_path = tmp_path / "root-cause.json"
    root_report_path.write_text(json.dumps(root_report), encoding="utf-8")
    metadata_path = artifacts / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["execution_provenance"]["fem_poisson_demag"].update(
        {"potential_order": 2, "potential_true_dof_count": 10}
    )
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    scalar_rows = list(
        csv.DictReader((artifacts / "scalars.csv").open(encoding="utf-8"))
    )
    scalar_rows[0]["E_demag"] = repr(FDM_NEWELL_ENERGY_J)
    with (artifacts / "scalars.csv").open(
        "w", newline="", encoding="utf-8"
    ) as stream:
        writer = csv.DictWriter(stream, fieldnames=list(scalar_rows[0]))
        writer.writeheader()
        writer.writerows(scalar_rows)
    telemetry_path = tmp_path / "telemetry.json"
    telemetry = json.loads(telemetry_path.read_text(encoding="utf-8"))
    telemetry["total_rows"] = 1
    telemetry["returned_rows"] = 1
    telemetry["rows"] = telemetry["rows"][-1:]
    telemetry_path.write_text(json.dumps(telemetry), encoding="utf-8")

    with pytest.raises(QualificationError, match="initial and final rows"):
        qualify_p2_edge(
            artifacts,
            root_report_path=root_report_path,
            telemetry_path=telemetry_path,
        )


@pytest.mark.parametrize(
    ("column", "value", "message"),
    [
        ("mx", 0.5, "initial average m"),
        ("e_demag", 0.5 * FDM_NEWELL_ENERGY_J, "initial demag energy"),
    ],
)
def test_p2_edge_gate_rejects_initial_table_telemetry_mismatch(
    tmp_path: Path,
    column: str,
    value: float,
    message: str,
) -> None:
    artifacts = _write_artifacts(tmp_path, phi_scale=0.94, h_scale=0.94)
    root_report = qualify_p1_root_cause(artifacts)
    root_report_path = tmp_path / "root-cause.json"
    root_report_path.write_text(json.dumps(root_report), encoding="utf-8")
    metadata_path = artifacts / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["execution_provenance"]["fem_poisson_demag"].update(
        {"potential_order": 2, "potential_true_dof_count": 10}
    )
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    scalar_rows = list(
        csv.DictReader((artifacts / "scalars.csv").open(encoding="utf-8"))
    )
    scalar_rows[0]["E_demag"] = repr(FDM_NEWELL_ENERGY_J)
    with (artifacts / "scalars.csv").open(
        "w", newline="", encoding="utf-8"
    ) as stream:
        writer = csv.DictWriter(stream, fieldnames=list(scalar_rows[0]))
        writer.writeheader()
        writer.writerows(scalar_rows)
    telemetry_path = tmp_path / "telemetry.json"
    telemetry = json.loads(telemetry_path.read_text(encoding="utf-8"))
    telemetry["rows"][0][telemetry["columns"].index(column)] = value
    telemetry_path.write_text(json.dumps(telemetry), encoding="utf-8")

    with pytest.raises(QualificationError, match=message):
        qualify_p2_edge(
            artifacts,
            root_report_path=root_report_path,
            telemetry_path=telemetry_path,
        )


def test_p2_edge_gate_rejects_table_without_step_zero(tmp_path: Path) -> None:
    artifacts = _write_artifacts(tmp_path, phi_scale=0.94, h_scale=0.94)
    root_report = qualify_p1_root_cause(artifacts)
    root_report_path = tmp_path / "root-cause.json"
    root_report_path.write_text(json.dumps(root_report), encoding="utf-8")
    metadata_path = artifacts / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["execution_provenance"]["fem_poisson_demag"].update(
        {"potential_order": 2, "potential_true_dof_count": 10}
    )
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    scalar_rows = list(
        csv.DictReader((artifacts / "scalars.csv").open(encoding="utf-8"))
    )
    scalar_rows[0]["step"] = "7"
    scalar_rows[0]["E_demag"] = repr(FDM_NEWELL_ENERGY_J)
    with (artifacts / "scalars.csv").open(
        "w", newline="", encoding="utf-8"
    ) as stream:
        writer = csv.DictWriter(stream, fieldnames=list(scalar_rows[0]))
        writer.writeheader()
        writer.writerows(scalar_rows)

    with pytest.raises(QualificationError, match="table scalar window must start at step 0"):
        qualify_p2_edge(
            artifacts,
            root_report_path=root_report_path,
            telemetry_path=tmp_path / "telemetry.json",
        )


def test_p2_edge_gate_rejects_global_airbox_refinement(tmp_path: Path) -> None:
    artifacts = _write_artifacts(tmp_path, phi_scale=0.94, h_scale=0.94)
    root_report = qualify_p1_root_cause(artifacts)
    metadata_path = artifacts / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["execution_provenance"]["fem_poisson_demag"].update(
        {"potential_order": 2, "potential_true_dof_count": 10}
    )
    fields = metadata["mesh"]["mesh_build_report"]["size_fields_realized"]
    fields[0]["params"]["SizeMax"] = 3e-9
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    root_report_path = tmp_path / "root-cause.json"
    root_report_path.write_text(
        json.dumps(root_report),
        encoding="utf-8",
    )

    with pytest.raises(QualificationError, match="whole airbox"):
        qualify_p2_edge(
            artifacts,
            root_report_path=root_report_path,
            telemetry_path=tmp_path / "telemetry.json",
        )


@pytest.mark.skipif(
    os.environ.get("FULLMAG_RUN_SP4_DEMAG_QUALIFICATION") != "1",
    reason="opt-in managed-runtime qualification",
)
def test_opt_in_managed_p1_then_p2_qualification(tmp_path: Path) -> None:
    p1_artifacts = Path(os.environ["FULLMAG_SP4_P1_ARTIFACTS"])
    p2_artifacts = Path(os.environ["FULLMAG_SP4_P2_ARTIFACTS"])
    telemetry = Path(os.environ["FULLMAG_SP4_P2_TELEMETRY"])
    analytic_raw = os.environ.get("FULLMAG_SP4_ANALYTIC_ENERGY_J")
    root_report = qualify_p1_root_cause(
        p1_artifacts,
        analytic_energy_j=None if analytic_raw is None else float(analytic_raw),
    )
    root_report_path = tmp_path / "p1-root-cause.json"
    root_report_path.write_text(json.dumps(root_report), encoding="utf-8")

    assert root_report["verdict"] == "p1_approximation_error"
    p2_report = qualify_p2_edge(
        p2_artifacts,
        root_report_path=root_report_path,
        telemetry_path=telemetry,
    )
    assert p2_report["status"] == "qualified"
