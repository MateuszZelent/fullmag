from __future__ import annotations

import json
import shutil
import struct
import subprocess
import sys
from pathlib import Path


SCRIPT = Path("scripts/validate_fem_periodic_antidot_relaxation_artifacts.py")


def write_summary_fixture(
    root: Path,
    *,
    scenario: str,
    coupled: bool,
    engine: str = "cpu",
    total_steps: int = 4,
) -> Path:
    artifact_dir = root / "artifacts"
    artifact_dir.mkdir(parents=True)
    mesh_dir = artifact_dir / "mesh"
    mesh_dir.mkdir()
    diagnostics_dir = artifact_dir / "diagnostics"
    diagnostics_dir.mkdir()
    demag_field_dir = artifact_dir / "fields" / "H_demag"
    demag_field_dir.mkdir(parents=True)
    demag_phi_dir = artifact_dir / "fields" / "demag_phi"
    demag_phi_dir.mkdir(parents=True)
    qualification_key = (
        "fem_gpu_relaxation_qualification"
        if engine == "gpu"
        else "fem_cpu_relaxation_qualification"
    )
    qualification = {
        "schema_version": f"{qualification_key}.v1",
        "relaxation_algorithm": "projected_gradient_bb",
        "executed_steps": total_steps,
        "norm_defect": 0.0,
        "stop_reason": "max_steps",
        "final_energy_terms_j": {
            "E_ex": 1.0e-19,
            "E_demag": 2.0e-19,
            "E_ext": -1.0e-19,
            "E_ani": 0.0,
            "E_dmi": 0.0,
            "E_total": 2.0e-19,
        },
        "final_torque_apm": 1.0e5,
        "final_torque_t": 1.25663706212e-1,
    }
    if engine == "gpu":
        qualification["device_policy"] = {
            "uses_cuda_kernels": True,
            "uses_gpu_poisson": True,
            "demag_operator_mode": "device_hypre_poisson",
        }
    metadata = {
        "pbc": {
            "axes": ["periodic", "periodic", "open"],
            "demag": "periodic_airbox_k0",
        },
        "periodic_antidot_relaxation": {
            "scenario": scenario,
            "exchange_coupled_across_periods": coupled,
            "magnetostatic_pbc": "periodic_airbox_k0",
            "periodic_pair_ids": ["x_faces", "y_faces"],
            "film_size_m": [2e-7, 2e-7, 1e-8],
            "universe_size_m": [2e-7, 2e-7, 9e-8] if coupled else [3.2e-7, 3.2e-7, 9e-8],
            "lateral_air_gap_m": [0.0, 0.0] if coupled else [1.2e-7, 1.2e-7],
        },
        "demag_runtime": {
            "model": "airbox",
            "boundary_variant": "robin",
            "linear_solver": "CG",
            "preconditioner": "AMG",
            "relative_tolerance": 1.0e-4,
            "max_iterations": 500,
            "actual_iterations": 12,
            "final_residual_norm": 1.0e-8,
            "mfem_device": "cuda" if engine == "gpu" else "cpu",
        },
        qualification_key: qualification,
        "mesh": {
            "periodic_boundary_pair_count": 2,
            "periodic_node_pair_count": 4,
            "periodic_boundary_pair_counts_by_id": {"x_faces": 1, "y_faces": 1},
            "periodic_node_pair_counts_by_id": {"x_faces": 2, "y_faces": 2},
        },
    }
    (artifact_dir / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    periodic_pairs = {
        "schema_version": "periodic_pairs.v1",
        "artifact_path": "mesh/periodic_pairs.v1.json",
        "validation_status": "ok",
        "pair_count": 2,
        "paired_node_count": 4,
        "max_translation_residual_m": 0.0,
        "pairs": [
            {
                "pair_id": "x_faces",
                "paired_node_count": 2,
                "domain_node_pair_counts": {"magnetic": 1, "airbox": 1},
                "unpaired_source_node_count": 0,
                "unpaired_destination_node_count": 0,
                "node_pairs": [
                    {"node_a": 0, "node_b": 1},
                    {"node_a": 2, "node_b": 3},
                ],
                "boundary_face_pairs": [
                    {
                        "face_a": 10,
                        "face_b": 11,
                        "translation_m": [2.0e-7, 0.0, 0.0],
                        "normal_dot": -1.0,
                        "orientation": "opposed_normals",
                    },
                ],
                "max_residual_m": 0.0,
                "rms_residual_m": 0.0,
                "status": "valid",
            },
            {
                "pair_id": "y_faces",
                "paired_node_count": 2,
                "domain_node_pair_counts": {"magnetic": 1, "airbox": 1},
                "unpaired_source_node_count": 0,
                "unpaired_destination_node_count": 0,
                "node_pairs": [
                    {"node_a": 0, "node_b": 2},
                    {"node_a": 1, "node_b": 3},
                ],
                "boundary_face_pairs": [
                    {
                        "face_a": 20,
                        "face_b": 21,
                        "translation_m": [0.0, 2.0e-7, 0.0],
                        "normal_dot": -1.0,
                        "orientation": "opposed_normals",
                    },
                ],
                "max_residual_m": 0.0,
                "rms_residual_m": 0.0,
                "status": "valid",
            },
        ],
    }
    (mesh_dir / "periodic_pairs.v1.json").write_text(
        json.dumps(periodic_pairs),
        encoding="utf-8",
    )
    final_magnetization = {
        "observable": "m",
        "unit": "dimensionless",
        "step": total_steps,
        "time": 1.0e-12,
        "solver_dt": 1.0e-13,
        "layout": {"backend": "fem"},
        "values": [
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
        ],
    }
    (artifact_dir / "m_final.json").write_text(
        json.dumps(final_magnetization),
        encoding="utf-8",
    )
    demag_field = {
        "observable": "H_demag",
        "unit": "A/m",
        "step": total_steps,
        "time": 1.0e-12,
        "solver_dt": 1.0e-13,
        "layout": {"backend": "fem"},
        "values": [
            [1.0e3, 0.0, 0.0],
            [1.0e3, 0.0, 0.0],
            [1.0e3, 0.0, 0.0],
            [1.0e3, 0.0, 0.0],
        ],
    }
    (demag_field_dir / f"step_{total_steps:06}.json").write_text(
        json.dumps(demag_field),
        encoding="utf-8",
    )
    demag_phi = {
        "observable": "demag_phi",
        "unit": "A",
        "step": total_steps,
        "time": 1.0e-12,
        "solver_dt": 1.0e-13,
        "layout": {"backend": "fem"},
        "values": [2.0e-3, 2.0e-3, 2.0e-3, 2.0e-3],
    }
    (demag_phi_dir / f"step_{total_steps:06}.json").write_text(
        json.dumps(demag_phi),
        encoding="utf-8",
    )
    seam_diagnostics = {
        "schema_version": "fem_static_pbc_demag_seams.v1",
        "status": "ok",
        "step": total_steps,
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
    (diagnostics_dir / "fem_static_pbc_demag_seams.v1.json").write_text(
        json.dumps(seam_diagnostics),
        encoding="utf-8",
    )
    scalars_header = (
        "step,time,solver_dt,mx,my,mz,E_ex,E_demag,E_ext,E_ani,E_dmi,"
        "E_total,max_dm_dt,max_h_eff,max_h_demag,max_torque_Apm,max_torque_T\n"
    )
    scalar_rows = []
    for row_index in range(total_steps):
        step = row_index + 1
        fraction = row_index / max(total_steps - 1, 1)
        e_total = 2.5e-19 - 0.5e-19 * fraction
        max_torque = 2.0e5 - 1.0e5 * fraction
        scalar_rows.append(
            f"{step},{step * 1.0e-13:.6e},1.0e-13,0.999,0.001,0.0,"
            f"1.0e-19,2.0e-19,-1.0e-19,0.0,0.0,{e_total:.6e},"
            f"0.5,1.0e5,1.0e4,{max_torque:.6e},0.125\n"
        )
    (artifact_dir / "scalars.csv").write_text(
        scalars_header + "".join(scalar_rows),
        encoding="utf-8",
    )
    summary = {
        "status": "completed",
        "backend": "fem",
        "mode": "strict",
        "precision": "double",
        "problem_name": f"fem_periodic_antidot_relax_{scenario}",
        "total_steps": total_steps,
        "artifact_dir": str(artifact_dir),
    }
    expected_engine = "fem_native_gpu" if engine == "gpu" else "fem_cpu_native"
    log_path = root / "runtime.log"
    log_path.write_text(
        f"resolved_engine_id={expected_engine} fallback=None\n"
        f"native FEM backend active: engine={expected_engine}\n"
        + json.dumps(summary)
        + "\n",
        encoding="utf-8",
    )
    return log_path


def run_validator(log_path: Path, scenario: str, *, engine: str = "cpu") -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            str(log_path),
            "--scenario",
            scenario,
            "--engine",
            engine,
            "--algorithm",
            "projected_gradient_bb",
            "--min-steps",
            "4",
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def run_validator_with_args(
    log_path: Path,
    scenario: str,
    extra_args: list[str],
    *,
    engine: str = "cpu",
) -> subprocess.CompletedProcess[str]:
    command = [
        sys.executable,
        str(SCRIPT),
        str(log_path),
        "--scenario",
        scenario,
        "--engine",
        engine,
        "--algorithm",
        "projected_gradient_bb",
        "--min-steps",
        "4",
    ]
    command.extend(extra_args)
    return subprocess.run(
        command,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def write_zarr_snapshot(
    root: Path,
    *,
    observable: str,
    unit: str,
    component_order: list[str],
    values: list[float],
    total_steps: int,
) -> None:
    zarr_dir = root / "artifacts" / "fields" / f"{observable}.zarr"
    zarr_dir.mkdir(parents=True)
    component_count = len(component_order)
    cell_count = len(values) // component_count
    (zarr_dir / ".zarray").write_text(
        json.dumps(
            {
                "zarr_format": 2,
                "shape": [1, component_count, cell_count],
                "chunks": [1, component_count, cell_count],
                "dtype": "<f8",
                "compressor": None,
                "fill_value": 0.0,
                "order": "C",
                "filters": None,
                "dimension_separator": ".",
            }
        ),
        encoding="utf-8",
    )
    (zarr_dir / ".zattrs").write_text(
        json.dumps(
            {
                "observable": observable,
                "unit": unit,
                "axes": ["sample", "component", "cell"],
                "component_order": component_order,
                "storage_layout": "soa_component_major",
                "sample_index_file": "samples.csv",
            }
        ),
        encoding="utf-8",
    )
    (zarr_dir / "samples.csv").write_text(
        "sample,step,time,solver_dt,chunk_key,dtype,scalar_bytes,cell_count\n"
        f"0,{total_steps},1.000000000000000e-12,1.000000000000000e-13,0.0.0,<f8,8,{cell_count}\n",
        encoding="utf-8",
    )
    (zarr_dir / "0.0.0").write_bytes(struct.pack(f"<{len(values)}d", *values))


def test_validator_accepts_native_zarr_field_snapshots(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    shutil.rmtree(tmp_path / "artifacts" / "fields" / "H_demag")
    shutil.rmtree(tmp_path / "artifacts" / "fields" / "demag_phi")
    write_zarr_snapshot(
        tmp_path,
        observable="H_demag",
        unit="A/m",
        component_order=["x", "y", "z"],
        values=[
            1.0e3,
            1.0e3,
            1.0e3,
            1.0e3,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
        ],
        total_steps=4,
    )
    write_zarr_snapshot(
        tmp_path,
        observable="demag_phi",
        unit="A",
        component_order=["scalar"],
        values=[2.0e-3, 2.0e-3, 2.0e-3, 2.0e-3],
        total_steps=4,
    )

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode == 0, result.stderr


def comparison_workload(*, scenario: str = "exchange_coupled") -> dict[str, object]:
    return {
        "axes": ["periodic", "periodic", "open"],
        "scenario": scenario,
        "film_size_m": [2.0e-7, 2.0e-7, 1.0e-8],
        "lateral_air_gap_m": [0.0, 0.0],
        "periodic_pair_ids": ["x_faces", "y_faces"],
        "exchange_coupled_across_periods": scenario == "exchange_coupled",
    }


def write_static_equilibrium_z_padding_report(
    path: Path,
    *,
    status: str = "ok",
    scenario: str = "exchange_coupled",
    include_workload: bool = True,
) -> None:
    payload: dict[str, object] = {
        "schema_version": "fem_static_pbc_z_padding_validation.v1",
        "status": status,
        "reference_artifacts": "reference/artifacts",
        "candidate_artifacts": "candidate/artifacts",
        "metrics": {
            "e_demag_relative_error": 1.0e-3,
            "h_demag_p99_relative_error": 1.0e-3,
            "demag_phi_range_relative_error": 1.0e-3,
            "h_demag_max_abs_delta_Apm": 1.0e-4,
            "demag_phi_max_abs_delta_A": 1.0e-8,
        },
    }
    if include_workload:
        payload["workload"] = {
            **comparison_workload(scenario=scenario),
            "reference_universe_size_m": [2.0e-7, 2.0e-7, 1.3e-7],
            "candidate_universe_size_m": [2.0e-7, 2.0e-7, 9.0e-8],
        }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def write_static_equilibrium_supercell_report(
    path: Path,
    *,
    status: str = "ok",
    scenario: str = "exchange_coupled",
    include_workload: bool = True,
) -> None:
    payload: dict[str, object] = {
        "schema_version": "fem_static_pbc_supercell_validation.v1",
        "status": status,
        "unit_cell_artifacts": "unit/artifacts",
        "supercell_artifacts": "supercell/artifacts",
        "repeat_x": 3,
        "repeat_y": 3,
        "cell_count": 9,
        "central_cell_extraction": {
            "schema_version": "fem_static_pbc_supercell_central_cell.v1",
            "path": "supercell/artifacts/diagnostics/fem_static_pbc_supercell_central_cell.v1.json",
            "repeat_x": 3,
            "repeat_y": 3,
            "cell_count": 9,
            "central_cell_index": [1, 1],
            "magnetic_node_count": 2,
            "field_cell_count": 2,
            "central_cell_demag_energy_j": 1.0e-18,
            "central_cell_torque_apm": 4.0e3,
        },
        "metrics": {
            "average_m_l2_delta": 1.0e-6,
            "e_demag_density_relative_error": 1.0e-3,
            "h_demag_stats_relative_error": 1.0e-3,
            "demag_phi_max_abs_delta_A": 1.0e-8,
            "central_cell_torque_residual_relative_error": 1.0e-2,
        },
    }
    if include_workload:
        payload["workload"] = {
            **comparison_workload(scenario=scenario),
            "unit_universe_size_m": [2.0e-7, 2.0e-7, 9.0e-8],
            "supercell_universe_size_m": [6.0e-7, 6.0e-7, 9.0e-8],
            "expected_supercell_universe_size_m": [6.0e-7, 6.0e-7, 9.0e-8],
        }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_validator_accepts_exchange_coupled_relaxation_metadata(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode == 0, result.stderr


def test_validator_accepts_air_gap_relaxation_metadata(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="air_gap", coupled=False)

    result = run_validator(log_path, "air_gap")

    assert result.returncode == 0, result.stderr


def test_validator_accepts_gpu_relaxation_metadata(tmp_path: Path) -> None:
    log_path = write_summary_fixture(
        tmp_path,
        scenario="air_gap",
        coupled=False,
        engine="gpu",
    )

    result = run_validator(log_path, "air_gap", engine="gpu")

    assert result.returncode == 0, result.stderr


def test_validator_accepts_required_static_equilibrium_comparison_reports(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    z_padding_report = tmp_path / "reports" / "z_padding_validation.v1.json"
    supercell_report = tmp_path / "reports" / "supercell_validation.v1.json"
    write_static_equilibrium_z_padding_report(z_padding_report)
    write_static_equilibrium_supercell_report(supercell_report)

    result = run_validator_with_args(
        log_path,
        "exchange_coupled",
        [
            "--require-z-padding-report",
            str(z_padding_report),
            "--require-supercell-report",
            str(supercell_report),
        ],
    )

    assert result.returncode == 0, result.stderr


def test_validator_rejects_air_gap_without_lateral_air_gap(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="air_gap", coupled=False)
    artifact_dir = tmp_path / "artifacts"
    metadata = json.loads((artifact_dir / "metadata.json").read_text(encoding="utf-8"))
    metadata["periodic_antidot_relaxation"]["lateral_air_gap_m"] = [0.0, 0.0]
    (artifact_dir / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")

    result = run_validator(log_path, "air_gap")

    assert result.returncode != 0
    assert "air_gap scenario must have positive lateral air gap" in result.stderr


def test_validator_rejects_exchange_coupled_with_lateral_air_gap(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    artifact_dir = tmp_path / "artifacts"
    metadata = json.loads((artifact_dir / "metadata.json").read_text(encoding="utf-8"))
    metadata["periodic_antidot_relaxation"]["lateral_air_gap_m"] = [1.2e-7, 1.2e-7]
    (artifact_dir / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "exchange_coupled scenario must have zero lateral air gap" in result.stderr


def test_validator_rejects_missing_demag_runtime(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    artifact_dir = tmp_path / "artifacts"
    metadata = json.loads((artifact_dir / "metadata.json").read_text(encoding="utf-8"))
    metadata.pop("demag_runtime")
    (artifact_dir / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "metadata.demag_runtime must be a JSON object" in result.stderr


def test_validator_rejects_unconverged_demag_runtime_residual(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    artifact_dir = tmp_path / "artifacts"
    metadata = json.loads((artifact_dir / "metadata.json").read_text(encoding="utf-8"))
    metadata["demag_runtime"]["final_residual_norm"] = 1.0e-2
    (artifact_dir / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "final_residual_norm must be non-negative and <= relative_tolerance" in result.stderr


def test_validator_rejects_missing_problem_pbc(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    artifact_dir = tmp_path / "artifacts"
    metadata = json.loads((artifact_dir / "metadata.json").read_text(encoding="utf-8"))
    metadata.pop("pbc")
    (artifact_dir / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "metadata.pbc must be a JSON object" in result.stderr


def test_validator_rejects_open_demag_problem_pbc(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    artifact_dir = tmp_path / "artifacts"
    metadata = json.loads((artifact_dir / "metadata.json").read_text(encoding="utf-8"))
    metadata["pbc"]["demag"] = "open"
    (artifact_dir / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "metadata.pbc.demag must be periodic_airbox_k0" in result.stderr


def test_validator_rejects_missing_periodic_pairs_artifact(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    periodic_pairs_path = tmp_path / "artifacts" / "mesh" / "periodic_pairs.v1.json"
    periodic_pairs_path.unlink()

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "missing periodic pairs artifact" in result.stderr


def test_validator_rejects_missing_periodic_node_pair_list(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    periodic_pairs_path = tmp_path / "artifacts" / "mesh" / "periodic_pairs.v1.json"
    payload = json.loads(periodic_pairs_path.read_text(encoding="utf-8"))
    payload["pairs"][0].pop("node_pairs")
    periodic_pairs_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "periodic pairs pair x_faces.node_pairs must be a JSON list" in result.stderr


def test_validator_rejects_periodic_pairs_without_airbox_node_coverage(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    periodic_pairs_path = tmp_path / "artifacts" / "mesh" / "periodic_pairs.v1.json"
    payload = json.loads(periodic_pairs_path.read_text(encoding="utf-8"))
    payload["pairs"][0]["domain_node_pair_counts"]["airbox"] = 0
    periodic_pairs_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "periodic pairs pair x_faces.domain_node_pair_counts.airbox must be positive" in result.stderr


def test_validator_accepts_air_gap_without_magnetic_seam_node_coverage(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="air_gap", coupled=False)
    periodic_pairs_path = tmp_path / "artifacts" / "mesh" / "periodic_pairs.v1.json"
    payload = json.loads(periodic_pairs_path.read_text(encoding="utf-8"))
    for pair in payload["pairs"]:
        pair["domain_node_pair_counts"]["magnetic"] = 0
        pair["domain_node_pair_counts"]["airbox"] = pair["paired_node_count"]
    periodic_pairs_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator(log_path, "air_gap")

    assert result.returncode == 0, result.stderr


def test_validator_rejects_exchange_coupled_without_magnetic_seam_node_coverage(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    periodic_pairs_path = tmp_path / "artifacts" / "mesh" / "periodic_pairs.v1.json"
    payload = json.loads(periodic_pairs_path.read_text(encoding="utf-8"))
    for pair in payload["pairs"]:
        pair["domain_node_pair_counts"]["magnetic"] = 0
        pair["domain_node_pair_counts"]["airbox"] = pair["paired_node_count"]
    periodic_pairs_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert (
        "periodic pairs pair x_faces.domain_node_pair_counts.magnetic must be positive for exchange_coupled"
        in result.stderr
    )


def test_validator_rejects_periodic_pairs_without_boundary_face_pairs(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    periodic_pairs_path = tmp_path / "artifacts" / "mesh" / "periodic_pairs.v1.json"
    payload = json.loads(periodic_pairs_path.read_text(encoding="utf-8"))
    payload["pairs"][1]["boundary_face_pairs"] = []
    periodic_pairs_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "periodic pairs pair y_faces.boundary_face_pairs must be non-empty" in result.stderr


def test_validator_rejects_periodic_pairs_with_bad_face_orientation(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    periodic_pairs_path = tmp_path / "artifacts" / "mesh" / "periodic_pairs.v1.json"
    payload = json.loads(periodic_pairs_path.read_text(encoding="utf-8"))
    payload["pairs"][0]["boundary_face_pairs"][0]["normal_dot"] = 1.0
    periodic_pairs_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "periodic pairs pair x_faces.boundary_face_pairs[0].normal_dot must be <= -0.999" in result.stderr


def test_validator_rejects_missing_final_magnetization_artifact(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    (tmp_path / "artifacts" / "m_final.json").unlink()

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "missing final magnetization artifact" in result.stderr


def test_validator_rejects_nonfinite_final_magnetization_vector(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    final_path = tmp_path / "artifacts" / "m_final.json"
    payload = json.loads(final_path.read_text(encoding="utf-8"))
    payload["values"][1][0] = float("nan")
    final_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "m_final.json values[1][0] must be finite" in result.stderr


def test_validator_rejects_final_magnetization_seam_mismatch(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    final_path = tmp_path / "artifacts" / "m_final.json"
    payload = json.loads(final_path.read_text(encoding="utf-8"))
    payload["values"][1] = [0.0, 1.0, 0.0]
    final_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "m_final.json periodic seam mismatch exceeds" in result.stderr


def test_validator_rejects_missing_demag_field_snapshot(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    demag_field_path = tmp_path / "artifacts" / "fields" / "H_demag" / "step_000004.json"
    demag_field_path.unlink()

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "missing H_demag field snapshot artifact" in result.stderr


def test_validator_rejects_demag_field_snapshot_step_mismatch(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    demag_field_path = tmp_path / "artifacts" / "fields" / "H_demag" / "step_000004.json"
    payload = json.loads(demag_field_path.read_text(encoding="utf-8"))
    payload["step"] = 3
    demag_field_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "H_demag snapshot step must match m_final.json step 4" in result.stderr


def test_validator_rejects_demag_field_seam_mismatch(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    demag_field_path = tmp_path / "artifacts" / "fields" / "H_demag" / "step_000004.json"
    payload = json.loads(demag_field_path.read_text(encoding="utf-8"))
    payload["values"][2] = [0.0, 2.0e3, 0.0]
    demag_field_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "H_demag snapshot periodic seam mismatch exceeds" in result.stderr


def test_validator_rejects_missing_demag_seam_diagnostics(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    seam_diagnostics_path = (
        tmp_path
        / "artifacts"
        / "diagnostics"
        / "fem_static_pbc_demag_seams.v1.json"
    )
    seam_diagnostics_path.unlink()

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "missing static PBC demag seam diagnostics artifact" in result.stderr


def test_validator_rejects_demag_seam_flux_mismatch(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    seam_diagnostics_path = (
        tmp_path
        / "artifacts"
        / "diagnostics"
        / "fem_static_pbc_demag_seams.v1.json"
    )
    payload = json.loads(seam_diagnostics_path.read_text(encoding="utf-8"))
    payload["pair_diagnostics"][0]["b_normal_flux_seam_max_T"] = 1.0
    seam_diagnostics_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "x_faces.b_normal_flux_seam_max_T exceeds" in result.stderr


def test_validator_rejects_demag_side_charge_sum(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    seam_diagnostics_path = (
        tmp_path
        / "artifacts"
        / "diagnostics"
        / "fem_static_pbc_demag_seams.v1.json"
    )
    payload = json.loads(seam_diagnostics_path.read_text(encoding="utf-8"))
    payload["pair_diagnostics"][1]["side_magnetic_charge_sum_abs_Am"] = 1.0
    seam_diagnostics_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "y_faces.side_magnetic_charge_sum_abs_Am exceeds" in result.stderr


def test_validator_rejects_missing_required_z_padding_report(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)

    result = run_validator_with_args(
        log_path,
        "exchange_coupled",
        ["--require-z-padding-report", str(tmp_path / "missing_z_padding.json")],
    )

    assert result.returncode != 0
    assert "missing required z-padding comparison report" in result.stderr


def test_validator_rejects_bad_required_supercell_report_status(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    supercell_report = tmp_path / "reports" / "supercell_validation.v1.json"
    write_static_equilibrium_supercell_report(supercell_report, status="failed")

    result = run_validator_with_args(
        log_path,
        "exchange_coupled",
        ["--require-supercell-report", str(supercell_report)],
    )

    assert result.returncode != 0
    assert "supercell comparison report status must be ok" in result.stderr


def test_validator_rejects_required_z_padding_report_with_excessive_metric(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    z_padding_report = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_static_equilibrium_z_padding_report(z_padding_report)
    payload = json.loads(z_padding_report.read_text(encoding="utf-8"))
    payload["metrics"]["e_demag_relative_error"] = 1.0
    z_padding_report.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator_with_args(
        log_path,
        "exchange_coupled",
        ["--require-z-padding-report", str(z_padding_report)],
    )

    assert result.returncode != 0
    assert "z-padding comparison report metrics.e_demag_relative_error exceeds" in result.stderr


def test_validator_rejects_required_z_padding_report_with_excessive_robust_h_metric(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    z_padding_report = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_static_equilibrium_z_padding_report(z_padding_report)
    payload = json.loads(z_padding_report.read_text(encoding="utf-8"))
    payload["metrics"]["h_demag_p99_relative_error"] = 1.0
    z_padding_report.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator_with_args(
        log_path,
        "exchange_coupled",
        ["--require-z-padding-report", str(z_padding_report)],
    )

    assert result.returncode != 0
    assert "z-padding comparison report metrics.h_demag_p99_relative_error exceeds" in result.stderr


def test_validator_rejects_required_supercell_report_with_excessive_metric(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    supercell_report = tmp_path / "reports" / "supercell_validation.v1.json"
    write_static_equilibrium_supercell_report(supercell_report)
    payload = json.loads(supercell_report.read_text(encoding="utf-8"))
    payload["metrics"]["e_demag_density_relative_error"] = 1.0
    supercell_report.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator_with_args(
        log_path,
        "exchange_coupled",
        ["--require-supercell-report", str(supercell_report)],
    )

    assert result.returncode != 0
    assert "supercell comparison report metrics.e_demag_density_relative_error exceeds" in result.stderr


def test_validator_rejects_required_supercell_report_without_central_cell_extraction(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    supercell_report = tmp_path / "reports" / "supercell_validation.v1.json"
    write_static_equilibrium_supercell_report(supercell_report)
    payload = json.loads(supercell_report.read_text(encoding="utf-8"))
    payload.pop("central_cell_extraction")
    supercell_report.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator_with_args(
        log_path,
        "exchange_coupled",
        ["--require-supercell-report", str(supercell_report)],
    )

    assert result.returncode != 0
    assert "supercell comparison report central_cell_extraction must be a JSON object" in result.stderr


def test_validator_rejects_required_supercell_report_without_scaled_geometry(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    supercell_report = tmp_path / "reports" / "supercell_validation.v1.json"
    write_static_equilibrium_supercell_report(supercell_report)
    payload = json.loads(supercell_report.read_text(encoding="utf-8"))
    payload["workload"].pop("supercell_universe_size_m")
    supercell_report.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator_with_args(
        log_path,
        "exchange_coupled",
        ["--require-supercell-report", str(supercell_report)],
    )

    assert result.returncode != 0
    assert "supercell comparison report workload.supercell_universe_size_m" in result.stderr


def test_validator_rejects_required_z_padding_report_without_workload(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    z_padding_report = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_static_equilibrium_z_padding_report(z_padding_report, include_workload=False)

    result = run_validator_with_args(
        log_path,
        "exchange_coupled",
        ["--require-z-padding-report", str(z_padding_report)],
    )

    assert result.returncode != 0
    assert "z-padding comparison report workload must be a JSON object" in result.stderr


def test_validator_rejects_required_z_padding_report_without_padding_geometry(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    z_padding_report = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_static_equilibrium_z_padding_report(z_padding_report)
    payload = json.loads(z_padding_report.read_text(encoding="utf-8"))
    payload["workload"].pop("reference_universe_size_m")
    z_padding_report.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator_with_args(
        log_path,
        "exchange_coupled",
        ["--require-z-padding-report", str(z_padding_report)],
    )

    assert result.returncode != 0
    assert "z-padding comparison report workload.reference_universe_size_m" in result.stderr


def test_validator_rejects_required_z_padding_report_for_different_pair_ids(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    z_padding_report = tmp_path / "reports" / "z_padding_validation.v1.json"
    write_static_equilibrium_z_padding_report(z_padding_report)
    payload = json.loads(z_padding_report.read_text(encoding="utf-8"))
    payload["workload"]["periodic_pair_ids"] = ["x_faces"]
    z_padding_report.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator_with_args(
        log_path,
        "exchange_coupled",
        ["--require-z-padding-report", str(z_padding_report)],
    )

    assert result.returncode != 0
    assert "z-padding comparison report workload.periodic_pair_ids" in result.stderr


def test_validator_rejects_required_supercell_report_for_different_lateral_gap(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    supercell_report = tmp_path / "reports" / "supercell_validation.v1.json"
    write_static_equilibrium_supercell_report(supercell_report)
    payload = json.loads(supercell_report.read_text(encoding="utf-8"))
    payload["workload"]["lateral_air_gap_m"] = [1.2e-7, 1.2e-7]
    supercell_report.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator_with_args(
        log_path,
        "exchange_coupled",
        ["--require-supercell-report", str(supercell_report)],
    )

    assert result.returncode != 0
    assert "supercell comparison report workload.lateral_air_gap_m" in result.stderr


def test_validator_rejects_required_supercell_report_for_different_workload(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    supercell_report = tmp_path / "reports" / "supercell_validation.v1.json"
    write_static_equilibrium_supercell_report(supercell_report, scenario="air_gap")

    result = run_validator_with_args(
        log_path,
        "exchange_coupled",
        ["--require-supercell-report", str(supercell_report)],
    )

    assert result.returncode != 0
    assert "supercell comparison report workload.scenario must match exchange_coupled" in result.stderr


def test_validator_rejects_missing_demag_phi_snapshot(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    demag_phi_path = tmp_path / "artifacts" / "fields" / "demag_phi" / "step_000004.json"
    demag_phi_path.unlink()

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "missing demag_phi field snapshot artifact" in result.stderr


def test_validator_rejects_demag_phi_snapshot_step_mismatch(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    demag_phi_path = tmp_path / "artifacts" / "fields" / "demag_phi" / "step_000004.json"
    payload = json.loads(demag_phi_path.read_text(encoding="utf-8"))
    payload["step"] = 3
    demag_phi_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "demag_phi snapshot step must match m_final.json step 4" in result.stderr


def test_validator_accepts_demag_phi_constant_offsets_by_periodic_pair_id(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    demag_phi_path = tmp_path / "artifacts" / "fields" / "demag_phi" / "step_000004.json"
    payload = json.loads(demag_phi_path.read_text(encoding="utf-8"))
    payload["values"] = [0.0, 1.0e-3, 2.0e-3, 3.0e-3]
    demag_phi_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode == 0, result.stderr


def test_validator_rejects_demag_phi_seam_mismatch(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    demag_phi_path = tmp_path / "artifacts" / "fields" / "demag_phi" / "step_000004.json"
    payload = json.loads(demag_phi_path.read_text(encoding="utf-8"))
    payload["values"][2] = 3.0e-3
    demag_phi_path.write_text(json.dumps(payload), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "demag_phi snapshot periodic seam mismatch exceeds" in result.stderr


def test_validator_rejects_increasing_scalar_energy_history(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    scalars_path = tmp_path / "artifacts" / "scalars.csv"
    lines = scalars_path.read_text(encoding="utf-8").splitlines()
    final_columns = lines[-1].split(",")
    final_columns[11] = "3.0e-19"
    lines[-1] = ",".join(final_columns)
    scalars_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "scalars.csv final E_total increased" in result.stderr


def test_validator_rejects_scalar_history_step_mismatch(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    scalars_path = tmp_path / "artifacts" / "scalars.csv"
    lines = scalars_path.read_text(encoding="utf-8").splitlines()
    final_columns = lines[-1].split(",")
    final_columns[0] = "5"
    lines[-1] = ",".join(final_columns)
    scalars_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "scalars.csv final step must match m_final.json step 4" in result.stderr


def test_validator_rejects_negative_demag_energy(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    artifact_dir = tmp_path / "artifacts"
    metadata = json.loads((artifact_dir / "metadata.json").read_text(encoding="utf-8"))
    metadata["fem_cpu_relaxation_qualification"]["final_energy_terms_j"]["E_demag"] = -1.0e-19
    (artifact_dir / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "E_demag must be non-negative" in result.stderr


def test_validator_rejects_gpu_without_device_poisson(tmp_path: Path) -> None:
    log_path = write_summary_fixture(
        tmp_path,
        scenario="air_gap",
        coupled=False,
        engine="gpu",
    )
    artifact_dir = tmp_path / "artifacts"
    metadata = json.loads((artifact_dir / "metadata.json").read_text(encoding="utf-8"))
    metadata["fem_gpu_relaxation_qualification"]["device_policy"]["uses_gpu_poisson"] = False
    (artifact_dir / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")

    result = run_validator(log_path, "air_gap", engine="gpu")

    assert result.returncode != 0
    assert "uses_gpu_poisson must be true" in result.stderr
