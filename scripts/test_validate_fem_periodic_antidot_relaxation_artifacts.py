from __future__ import annotations

import json
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
                "unpaired_source_node_count": 0,
                "unpaired_destination_node_count": 0,
                "node_pairs": [
                    {"node_a": 0, "node_b": 1},
                    {"node_a": 2, "node_b": 3},
                ],
                "max_residual_m": 0.0,
                "rms_residual_m": 0.0,
                "status": "valid",
            },
            {
                "pair_id": "y_faces",
                "paired_node_count": 2,
                "unpaired_source_node_count": 0,
                "unpaired_destination_node_count": 0,
                "node_pairs": [
                    {"node_a": 0, "node_b": 2},
                    {"node_a": 1, "node_b": 3},
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
