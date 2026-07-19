import json

import pytest

from scripts.check_fem_sp4_relaxation import relaxation_is_ready


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
