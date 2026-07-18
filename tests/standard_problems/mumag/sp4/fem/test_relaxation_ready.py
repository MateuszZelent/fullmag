import json

from scripts.check_fem_sp4_relaxation import relaxation_is_ready


def test_relaxation_ready_requires_convergence_and_torque_threshold(tmp_path):
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    (artifacts / "m_final.json").write_text("{}")
    metadata = {
        "fem_gpu_relaxation_qualification": {
            "converged": False,
            "final_torque_t": 4.7e-4,
        }
    }
    (artifacts / "metadata.json").write_text(json.dumps(metadata))
    assert relaxation_is_ready(artifacts) is False

    metadata["fem_gpu_relaxation_qualification"].update(
        converged=True, final_torque_t=1e-5
    )
    (artifacts / "metadata.json").write_text(json.dumps(metadata))
    assert relaxation_is_ready(artifacts) is True


def test_relaxation_ready_fails_closed_for_missing_or_malformed_artifacts(tmp_path):
    assert relaxation_is_ready(tmp_path) is False
    (tmp_path / "metadata.json").write_text("not-json")
    (tmp_path / "m_final.json").write_text("{}")
    assert relaxation_is_ready(tmp_path) is False
