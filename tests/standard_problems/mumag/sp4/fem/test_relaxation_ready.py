import json

import pytest

from scripts.check_fem_sp4_relaxation import (
    MUMAX3_SP4_PROFILE,
    relaxation_is_ready,
)


FDM_INITIAL_DEMAG_J = 7.137838407337884e-19
FDM_FINAL_AVERAGE_M = (0.9669589943512007, 0.1252939793677222, -2.8e-17)
FDM_FINAL_EXCHANGE_J = 8.925128237079652e-20
FDM_FINAL_DEMAG_J = 5.405199805362659e-19
FDM_FINAL_TOTAL_J = 6.297712629070624e-19


def _write_relaxation(
    root,
    *,
    algorithm="llg_overdamped",
    converged=True,
    torque=8e-6,
    energies=(-1e-17, -2e-17, -3e-17),
    values=((1.0, 0.0, 0.0), (0.99, 0.1, 0.0)),
):
    artifacts = root / "artifacts"
    artifacts.mkdir(parents=True)
    metadata = {
        "fem_gpu_relaxation_qualification": {
            "relaxation_algorithm": algorithm,
            "converged": converged,
            "stop_reason": "torque_tolerance" if converged else "max_steps",
            "stop_metric_name": "max_torque_apm",
            "stop_metric_value": torque / 1.25663706212e-6,
            "stop_threshold": 7.957747154594767,
            "executed_steps": len(energies),
            "final_torque_t": torque,
        }
    }
    (artifacts / "metadata.json").write_text(json.dumps(metadata))
    (artifacts / "m_final.json").write_text(json.dumps({"values": values}))
    scalar_rows = "".join(
        f"{step},{step * 1e-14},{energy},{torque if step == len(energies) - 1 else 1e-3}\n"
        for step, energy in enumerate(energies)
    )
    (artifacts / "scalars.csv").write_text(
        "step,time,E_total,max_torque_T\n" + scalar_rows
    )
    return artifacts


def _write_mumax3_compatible_relaxation(
    root,
    *,
    potential_order=2,
    initial_demag=FDM_INITIAL_DEMAG_J,
    final_m=FDM_FINAL_AVERAGE_M,
    final_exchange=FDM_FINAL_EXCHANGE_J,
    final_demag=FDM_FINAL_DEMAG_J,
    final_total=FDM_FINAL_TOTAL_J,
):
    artifacts = _write_relaxation(
        root,
        algorithm="projected_gradient_bb",
        torque=1e-6,
        energies=(7.2e-19, 6.5e-19, final_total),
    )
    metadata_path = artifacts / "metadata.json"
    metadata = json.loads(metadata_path.read_text())
    metadata.update(
        {
            "problem_meta": {
                "runtime_metadata": {
                    "fem_demag_accuracy_contract": {
                        "schema_version": "fullmag.fem.demag_accuracy.v1",
                        "profile": MUMAX3_SP4_PROFILE,
                        "required_potential_order": 2,
                        "required_topology": "all_tet",
                    },
                    "study_universe": {"size": [7e-7, 2.5e-7, 2.5e-7]},
                    "mesh_workflow": {
                        "per_geometry": [{"geometry": "film", "hmax": 2e-9}]
                    },
                }
            },
            "execution_provenance": {
                "resolved_demag_realization": "fem_poisson_robin",
                "fem_poisson_demag": {
                    "potential_order": potential_order,
                    "potential_true_dof_count": 20 if potential_order == 2 else 10,
                },
            },
            "mesh": {
                "node_count": 10,
                "periodic_node_pair_count": 0,
            },
        }
    )
    metadata_path.write_text(json.dumps(metadata))
    mx, my, mz = final_m
    (artifacts / "scalars.csv").write_text(
        "step,time,mx,my,mz,E_ex,E_demag,E_total,max_torque_T\n"
        f"0,0,0.9950371902,0.0995037190,0,0,{initial_demag},{initial_demag},1e-3\n"
        f"1,0,0.98,0.11,0,{final_exchange * 0.95},{final_demag * 1.02},6.5e-19,1e-4\n"
        f"2,0,{mx},{my},{mz},{final_exchange},{final_demag},{final_total},1e-6\n"
    )
    return artifacts


def test_relaxation_ready_requires_convergence_and_torque_threshold(tmp_path):
    artifacts = _write_relaxation(tmp_path, converged=False, torque=4.7e-4)
    assert relaxation_is_ready(artifacts) is False

    artifacts = _write_relaxation(tmp_path / "ready", torque=1e-5)
    assert relaxation_is_ready(
        artifacts,
        expected_algorithm="llg_overdamped",
        expected_device="gpu",
    ) is True


@pytest.mark.parametrize(
    "override",
    [
        {"algorithm": "nonlinear_cg"},
        {"energies": (-1e-17, -3e-17, -2e-17)},
        {"energies": (-1e-17, float("nan"), -3e-17)},
        {"values": ((float("nan"), 0.0, 0.0),)},
    ],
)
def test_relaxation_ready_fails_closed_for_wrong_policy_or_artifacts(
    tmp_path,
    override,
):
    artifacts = _write_relaxation(tmp_path, **override)
    assert relaxation_is_ready(
        artifacts,
        expected_algorithm="llg_overdamped",
        expected_device="gpu",
    ) is False


def test_relaxation_ready_fails_closed_for_missing_or_malformed_artifacts(tmp_path):
    assert relaxation_is_ready(tmp_path) is False
    (tmp_path / "metadata.json").write_text("not-json")
    (tmp_path / "m_final.json").write_text("{}")
    assert relaxation_is_ready(tmp_path) is False


def test_mumax3_profile_requires_p2_provenance_and_physics_agreement(tmp_path):
    artifacts = _write_mumax3_compatible_relaxation(tmp_path)
    assert relaxation_is_ready(
        artifacts,
        expected_algorithm="projected_gradient_bb",
        expected_device="gpu",
        expected_compatibility_profile=MUMAX3_SP4_PROFILE,
    ) is True


@pytest.mark.parametrize(
    "override",
    [
        {"potential_order": 1},
        {"initial_demag": 0.8 * FDM_INITIAL_DEMAG_J},
        {"final_m": (0.98, 0.09, 0.0)},
        {"final_exchange": 0.5 * FDM_FINAL_EXCHANGE_J},
        {"final_demag": 0.9 * FDM_FINAL_DEMAG_J},
        {"final_total": 0.9 * FDM_FINAL_TOTAL_J},
    ],
)
def test_mumax3_profile_fails_closed_for_discretization_or_physics_drift(
    tmp_path,
    override,
):
    artifacts = _write_mumax3_compatible_relaxation(tmp_path, **override)
    assert relaxation_is_ready(
        artifacts,
        expected_algorithm="projected_gradient_bb",
        expected_device="gpu",
        expected_compatibility_profile=MUMAX3_SP4_PROFILE,
    ) is False


def test_mumax3_profile_rejects_legacy_relaxation_without_contract(tmp_path):
    artifacts = _write_relaxation(tmp_path, torque=1e-6)
    assert relaxation_is_ready(
        artifacts,
        expected_compatibility_profile=MUMAX3_SP4_PROFILE,
    ) is False
