from __future__ import annotations

import csv
import json
from pathlib import Path

import pytest

from tests.standard_problems.mumag.sp4.fem.collect_results import (
    CollectionError,
    collect_attempt,
    record_failed_attempt,
)


def _write_artifacts(root: Path, *, crossing: bool = True) -> Path:
    artifacts = root / "artifacts"
    artifacts.mkdir(parents=True)
    metadata = {
        "requested_execution": {
            "backend": "fem",
            "device": "cpu",
            "precision": "double",
            "mode": "strict",
            "fallback_policy": "forbidden",
        },
        "execution_provenance": {
            "execution_engine": "fem_cpu_native",
            "precision": "double",
            "lossy_fallback_used": False,
            "integrator": "rk4",
            "timestep_policy": {
                "kind": "fixed",
                "fixed_dt": 2e-13,
            },
        },
        "demag_runtime": {
            "realization": "poisson_robin",
            "operator_mode": "cpu_hypre_poisson",
            "actual_iterations": 9,
            "final_residual_norm": 2e-13,
        },
        "mesh": {
            "topology_fingerprint": "sha256:mesh-a",
            "node_count": 1234,
            "element_count": 5678,
        },
        "problem_meta": {
            "runtime_metadata": {
                "domain_frame": {
                    "declared_universe": {"size": [7e-7, 2.5e-7, 2.5e-7]},
                },
                "mesh_workflow": {
                    "per_geometry": [
                        {
                            "maximum_element_size": 3e-9,
                            "through_thickness_elements": 3,
                        }
                    ]
                },
            }
        },
        "wall_time_s": 12.5,
    }
    (artifacts / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    final_mx = -0.2 if crossing else 0.2
    (artifacts / "scalars.csv").write_text(
        "step,time,solver_dt,mx,my,mz,E_total,max_torque_T\n"
        "0,0,2e-13,0.8,0.1,0,-1e-17,2e-3\n"
        "1,1e-12,2e-13,0.2,0.2,0.1,-2e-17,2e-4\n"
        f"2,2e-12,2e-13,{final_mx},0.3,0.2,-3e-17,2e-5\n",
        encoding="utf-8",
    )
    return artifacts


def _write_relaxation_artifacts(
    root: Path,
    *,
    algorithm: str = "llg_overdamped",
    converged: bool = True,
    final_torque_t: float = 8e-6,
    energy_increase: bool = False,
) -> Path:
    artifacts = root / "artifacts"
    artifacts.mkdir(parents=True)
    direct = algorithm != "llg_overdamped"
    provenance = {
        "execution_engine": "fem_cpu_native",
        "precision": "double",
        "lossy_fallback_used": False,
    }
    if not direct:
        provenance.update(
            {
                "integrator": "rk23",
                "timestep_policy": {
                    "kind": "adaptive",
                    "dt_initial_s": 1e-15,
                    "dt_min_s": 1e-17,
                    "dt_max_s": 1e-14,
                    "atol": 1e-7,
                },
            }
        )
    metadata = {
        "requested_execution": {
            "backend": "fem",
            "device": "cpu",
            "precision": "double",
            "mode": "strict",
            "fallback_policy": "forbidden",
        },
        "execution_provenance": provenance,
        "demag_runtime": {
            "realization": "poisson_robin",
            "operator_mode": "cpu_hypre_poisson",
            "actual_iterations": 11,
            "final_residual_norm": 1e-13,
        },
        "mesh": {
            "topology_fingerprint": "sha256:relax-mesh",
            "node_count": 2345,
            "element_count": 6789,
        },
        "problem_meta": {
            "runtime_metadata": {
                "domain_frame": {
                    "declared_universe": {"size": [7e-7, 2.5e-7, 2.5e-7]},
                },
                "mesh_workflow": {
                    "per_geometry": [{"maximum_element_size": 3e-9}]
                },
            }
        },
        "fem_cpu_relaxation_qualification": {
            "relaxation_algorithm": algorithm,
            "converged": converged,
            "stop_reason": "torque" if converged else "max_steps",
            "stop_metric_name": "max_torque_apm",
            "stop_metric_value": final_torque_t / 1.25663706212e-6,
            "stop_threshold": 7.957747154594767,
            "final_energy_terms_j": {"E_total": -3e-17},
            "final_torque_t": final_torque_t,
            "executed_steps": 3,
        },
        "wall_time_s": 7.5,
        "status": "completed",
    }
    (artifacts / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    middle_energy = -0.5e-17 if energy_increase else -2e-17
    if direct:
        header = "step,time,solver_dt,mx,my,mz,E_total,max_torque_T\n"
        rows = (
            "0,0,0,0.995,0.0995,0,-1e-17,2e-3\n"
            f"1,0,0,0.98,0.11,0,{middle_energy},2e-4\n"
            f"2,0,0,0.967,0.125,0,-3e-17,{final_torque_t}\n"
        )
    else:
        header = "step,time,solver_dt,mx,my,mz,E_total,max_torque_T\n"
        rows = (
            "0,0,1e-15,0.995,0.0995,0,-1e-17,2e-3\n"
            f"1,1e-12,8e-15,0.98,0.11,0,{middle_energy},2e-4\n"
            f"2,2e-12,1e-14,0.967,0.125,0,-3e-17,{final_torque_t}\n"
        )
    (artifacts / "scalars.csv").write_text(header + rows, encoding="utf-8")
    return artifacts


def _read_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as stream:
        return list(csv.DictReader(stream))


def test_collect_attempt_writes_one_stable_application_result_row(tmp_path: Path) -> None:
    artifacts = _write_artifacts(tmp_path / "run-a")
    ledger = tmp_path / "results.csv"

    result = collect_attempt(
        artifacts,
        ledger,
        scenario="case_a_rk4_fixed",
        attempt_id="attempt-001",
    )

    rows = _read_rows(ledger)
    assert len(rows) == 1
    row = rows[0]
    assert result == row
    assert row["attempt_id"] == "attempt-001"
    assert row["scenario"] == "case_a_rk4_fixed"
    assert row["phase"] == "dynamics"
    assert row["case"] == "case_a"
    assert row["relaxation_algorithm"] == ""
    assert row["integrator"] == "rk4"
    assert row["timestep_policy"] == "fixed"
    assert row["requested_device"] == "cpu"
    assert row["execution_engine"] == "fem_cpu_native"
    assert row["mesh_topology_fingerprint"] == "sha256:mesh-a"
    assert float(row["crossing_time_s"]) == pytest.approx(1.5e-12)
    assert int(row["sample_count"]) == 3
    assert float(row["final_E_total_J"]) == pytest.approx(-3e-17)
    assert float(row["final_max_torque_T"]) == pytest.approx(2e-5)
    assert float(row["wall_time_s"]) == pytest.approx(12.5)
    assert row["metadata_sha256"]
    assert row["scalars_sha256"]
    assert row["status"] == "completed"


def test_collect_attempt_appends_but_rejects_duplicate_attempt_id(tmp_path: Path) -> None:
    first = _write_artifacts(tmp_path / "run-a")
    second = _write_artifacts(tmp_path / "run-b")
    ledger = tmp_path / "results.csv"
    collect_attempt(first, ledger, scenario="case_a_rk4_fixed", attempt_id="one")
    collect_attempt(second, ledger, scenario="case_b_rk4_fixed", attempt_id="two")
    before = ledger.read_bytes()

    with pytest.raises(CollectionError, match="attempt ID already exists"):
        collect_attempt(second, ledger, scenario="case_b_rk4_fixed", attempt_id="one")

    assert ledger.read_bytes() == before
    assert [row["attempt_id"] for row in _read_rows(ledger)] == ["one", "two"]


def test_collect_attempt_accepts_the_sibling_zarr_bundle_root(tmp_path: Path) -> None:
    artifacts = _write_artifacts(tmp_path / "case_a_rk4_fixed.zarr")
    ledger = tmp_path / "results.csv"

    row = collect_attempt(
        artifacts.parent,
        ledger,
        scenario="case_a_rk4_fixed",
        attempt_id="bundle-root",
    )

    assert row["artifact_dir"] == str(artifacts.resolve())
    assert _read_rows(ledger)[0]["attempt_id"] == "bundle-root"


def test_failed_attempt_is_retained_without_claiming_physical_metrics(tmp_path: Path) -> None:
    ledger = tmp_path / "results.csv"

    row = record_failed_attempt(
        ledger,
        scenario="case_b_rk45_adaptive",
        attempt_id="failed-001",
        requested_device="gpu",
        category="execution_failure",
        detail="native runtime exited with status 1",
        wall_time_s=3.25,
        artifact_dir=tmp_path / "case_b_rk45_adaptive.zarr",
    )

    assert row["status"] == "execution_failure"
    assert row["failure_category"] == "execution_failure"
    assert row["failure_detail"] == "native runtime exited with status 1"
    assert row["requested_device"] == "gpu"
    assert row["integrator"] == "rk45"
    assert row["timestep_policy"] == "adaptive"
    assert row["crossing_time_s"] == ""
    assert float(row["wall_time_s"]) == pytest.approx(3.25)
    assert _read_rows(ledger) == [row]


def test_collect_relaxation_attempt_records_convergence_and_energy_descent(
    tmp_path: Path,
) -> None:
    artifacts = _write_relaxation_artifacts(tmp_path / "relax")
    ledger = tmp_path / "results.csv"

    row = collect_attempt(
        artifacts,
        ledger,
        scenario="relax_llg_rk23_adaptive",
        attempt_id="relax-001",
    )

    assert row["phase"] == "relaxation"
    assert row["case"] == ""
    assert row["relaxation_algorithm"] == "llg_overdamped"
    assert row["integrator"] == "rk23"
    assert row["timestep_policy"] == "adaptive"
    assert row["relaxation_converged"] == "true"
    assert row["relaxation_stop_reason"] == "torque"
    assert float(row["initial_E_total_J"]) == pytest.approx(-1e-17)
    assert float(row["final_E_total_J"]) == pytest.approx(-3e-17)
    assert float(row["energy_drop_J"]) == pytest.approx(2e-17)
    assert float(row["max_energy_increase_J"]) == pytest.approx(0.0)
    assert float(row["final_max_torque_T"]) == pytest.approx(8e-6)
    assert float(row["relaxation_torque_limit_T"]) == pytest.approx(1e-5)
    assert row["crossing_time_s"] == ""
    assert row["nist_rmse_mx"] == ""


def test_collect_direct_minimizer_leaves_time_integrator_fields_empty(
    tmp_path: Path,
) -> None:
    artifacts = _write_relaxation_artifacts(
        tmp_path / "relax",
        algorithm="projected_gradient_bb",
    )

    row = collect_attempt(
        artifacts,
        tmp_path / "results.csv",
        scenario="relax_projected_gradient_bb",
        attempt_id="relax-pgbb",
    )

    assert row["phase"] == "relaxation"
    assert row["relaxation_algorithm"] == "projected_gradient_bb"
    assert row["integrator"] == ""
    assert row["timestep_policy"] == ""
    assert row["time_start_s"] == ""
    assert row["time_stop_s"] == ""
    assert row["step_start"] == "0"
    assert row["step_stop"] == "2"


@pytest.mark.parametrize(
    "converged,final_torque_t,energy_increase,match",
    [
        (False, 8e-6, False, "did not converge"),
        (True, 2e-5, False, "torque.*exceeds"),
        (True, 8e-6, True, "energy increased"),
    ],
)
def test_collect_relaxation_fails_closed_before_appending_invalid_physics(
    tmp_path: Path,
    converged: bool,
    final_torque_t: float,
    energy_increase: bool,
    match: str,
) -> None:
    good = _write_relaxation_artifacts(tmp_path / "good")
    bad = _write_relaxation_artifacts(
        tmp_path / "bad",
        converged=converged,
        final_torque_t=final_torque_t,
        energy_increase=energy_increase,
    )
    ledger = tmp_path / "results.csv"
    collect_attempt(
        good,
        ledger,
        scenario="relax_llg_rk23_adaptive",
        attempt_id="good",
    )
    before = ledger.read_bytes()

    with pytest.raises(CollectionError, match=match):
        collect_attempt(
            bad,
            ledger,
            scenario="relax_llg_rk23_adaptive",
            attempt_id="bad",
        )

    assert ledger.read_bytes() == before


@pytest.mark.parametrize(
    "damage,match",
    [
        ("missing_metadata", "missing metadata"),
        ("missing_column", "missing scalar columns"),
        ("nonfinite", "non-finite"),
        ("nonmonotone", "strictly increasing"),
        ("no_crossing", "no positive-to-nonpositive mx crossing"),
    ],
)
def test_collect_attempt_fails_closed_without_modifying_ledger(
    tmp_path: Path,
    damage: str,
    match: str,
) -> None:
    good = _write_artifacts(tmp_path / "good")
    broken = _write_artifacts(tmp_path / "broken", crossing=damage != "no_crossing")
    ledger = tmp_path / "results.csv"
    collect_attempt(good, ledger, scenario="case_a_rk4_fixed", attempt_id="good")
    before = ledger.read_bytes()

    if damage == "missing_metadata":
        (broken / "metadata.json").unlink()
    elif damage == "missing_column":
        text = (broken / "scalars.csv").read_text(encoding="utf-8")
        (broken / "scalars.csv").write_text(text.replace(",mz,", ","), encoding="utf-8")
    elif damage == "nonfinite":
        text = (broken / "scalars.csv").read_text(encoding="utf-8")
        (broken / "scalars.csv").write_text(text.replace("0.2,0.2", "nan,0.2"), encoding="utf-8")
    elif damage == "nonmonotone":
        text = (broken / "scalars.csv").read_text(encoding="utf-8")
        (broken / "scalars.csv").write_text(text.replace("2,2e-12", "2,1e-12"), encoding="utf-8")

    with pytest.raises(CollectionError, match=match):
        collect_attempt(
            broken,
            ledger,
            scenario="case_a_rk4_fixed",
            attempt_id=f"broken-{damage}",
        )

    assert ledger.read_bytes() == before
