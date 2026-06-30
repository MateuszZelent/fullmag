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
            "demag": "open",
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
            "periodic_node_pair_count": 12,
            "periodic_boundary_pair_counts_by_id": {"x_faces": 1, "y_faces": 1},
            "periodic_node_pair_counts_by_id": {"x_faces": 6, "y_faces": 6},
        },
    }
    (artifact_dir / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
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


def test_validator_rejects_missing_problem_pbc(tmp_path: Path) -> None:
    log_path = write_summary_fixture(tmp_path, scenario="exchange_coupled", coupled=True)
    artifact_dir = tmp_path / "artifacts"
    metadata = json.loads((artifact_dir / "metadata.json").read_text(encoding="utf-8"))
    metadata.pop("pbc")
    (artifact_dir / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")

    result = run_validator(log_path, "exchange_coupled")

    assert result.returncode != 0
    assert "metadata.pbc must be a JSON object" in result.stderr


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
