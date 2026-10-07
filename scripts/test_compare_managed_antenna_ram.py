"""Interpreted comparison orchestration checks, not native qualification."""
from pathlib import Path

import pytest
from scripts import compare_managed_antenna_ram as comparison


@pytest.mark.parametrize("state", ["pending", "failed_resources_retained"])
def test_refuses_non_success_before_reading_or_reconstructing(tmp_path, monkeypatch, state):
    monkeypatch.setattr(comparison.launcher.storage, "resolve_layout", lambda *args: {
        "build_root": str(tmp_path)})
    root = tmp_path / "runs" / ("1" * 32)
    monkeypatch.setattr(comparison.launcher, "observe", lambda *args: {"state": state})
    monkeypatch.setattr(comparison, "reconstruct_inputs", lambda *args: pytest.fail("no inputs"))
    monkeypatch.setattr(comparison, "read_inspection", lambda *args: pytest.fail("no payloads"))
    with pytest.raises(ValueError, match="successful terminal RAM solve"):
        comparison.compare(tmp_path, root)


def test_actual_isolated_public_lowering_matches_fixture_pin():
    repo = Path(__file__).resolve().parents[1]
    inputs = comparison.reconstruct_inputs(
        repo, repo / "examples/fem_antenna_current_source_inspection.py")
    assert comparison.fixture_input_digest(inputs) == comparison.FIXTURE_INPUT_SHA256


def test_reconstruction_rejects_wrong_python_source_tree(tmp_path):
    repo = Path(__file__).resolve().parents[1]
    with pytest.raises(ValueError, match="isolated input reconstruction"):
        comparison.reconstruct_inputs(tmp_path, repo / "examples/fem_antenna_current_source_inspection.py")


def test_reconstruction_rejects_non_antenna_pipeline(tmp_path):
    repo = Path(__file__).resolve().parents[1]
    script = tmp_path / "not_antenna.py"
    script.write_text('import fullmag as fm\nstudy=fm.study("empty")\n', encoding="utf-8")
    with pytest.raises(ValueError, match="isolated input reconstruction"):
        comparison.reconstruct_inputs(repo, script)


def prepared_comparison(tmp_path, monkeypatch):
    root = tmp_path / "runs" / ("1" * 32)
    receipt = {"managed_job_id": "2" * 32, "native_source_identity": {
        "head_commit_full": "a" * 40, "source_snapshot_sha256": "b" * 64},
        "source_digest": "c" * 64, "build_receipt_sha256": "d" * 64,
        "solver_log_sha256": "e" * 64}
    monkeypatch.setattr(comparison.launcher.storage, "resolve_layout", lambda *args: {
        "build_root": str(tmp_path)})
    monkeypatch.setattr(comparison.launcher, "observe", lambda *args: {
        "state": "solver_succeeded_comparison_pending"})
    monkeypatch.setattr(comparison.launcher, "read_json", lambda *args: receipt)
    def binding(*args):
        assert args[1:] == ("2" * 32, "a" * 40, "c" * 64, "b" * 64)
        return {}, None, None, None, tmp_path / "capsule", None
    monkeypatch.setattr(comparison.launcher, "resolved_build", binding)
    def reconstruct(source, script):
        assert source == tmp_path / "capsule/tree"
        assert script == root / "input/fem_antenna_current_source_inspection.py"
        return {"exact_reconstructed_input": True}
    monkeypatch.setattr(comparison, "reconstruct_inputs", reconstruct)
    def reader(artifact_root, record):
        assert artifact_root == root / "export/result.zarr/artifacts"
        assert record == artifact_root / "antenna/external_lead_stage_outputs/stage-000/antenna_external_lead_stage_output.v1.json"
        return {"device_ids": [1], "potential_v": [2], "positions_m": [[3, 4, 5]],
            "field_apm": [[6, 7, 8]], "manifest_content_digest": "sha256:" + "f" * 64,
            "manifest_sha256": "f" * 64, "record_sha256": "f" * 64,
            "bundle_sha256": "f" * 64, "bundle_bytes": b"exact bundle"}
    monkeypatch.setattr(comparison, "read_inspection", reader)
    def rt0_check(inputs, bundle):
        assert inputs == {"exact_reconstructed_input": True} and bundle == b"exact bundle"
        return {"comparison": "PASS", "physics_qualified": False}
    monkeypatch.setattr(comparison, "compare_rt0_fixture", rt0_check)
    monkeypatch.setattr(comparison, "compare_bundle_observables", lambda *args: {
        "comparison": "PASS", "physics_qualified": False})
    return root


def test_uses_exact_run_values_and_never_promotes_scope(tmp_path, monkeypatch):
    root = prepared_comparison(tmp_path, monkeypatch)
    def oracle(inputs, ids, voltage, positions, field, **tolerances):
        assert inputs == {"exact_reconstructed_input": True}
        assert (ids, voltage, positions, field) == ([1], [2], [[3, 4, 5]], [[6, 7, 8]])
        assert tolerances == comparison.TOLERANCES
        return {"physics_qualified": False, "qualification": "NOT VERIFIED"}
    monkeypatch.setattr(comparison, "compare_fixture", oracle)
    result = comparison.compare(tmp_path, root)
    assert result["comparison"] == "PASS"
    assert result["physics_qualified"] is False
    assert result["durable_session_storage_qualified"] is False
    assert result["reuse_LLG_FFT_qualified"] is False
    assert result["native_input_pins_recomputed"] is False
    assert result["native_canonical_bundle_redecoded"] is False
    assert result["rt0_fixture"] == {"comparison": "PASS", "physics_qualified": False}
    assert result["qualification"] == "NOT VERIFIED"


def test_oracle_mismatch_is_not_success(tmp_path, monkeypatch):
    root = prepared_comparison(tmp_path, monkeypatch)
    def reject(*args, **kwargs):
        raise ValueError("magnetic field vector mismatch")
    monkeypatch.setattr(comparison, "compare_fixture", reject)
    with pytest.raises(ValueError, match="field vector mismatch"):
        comparison.compare(tmp_path, root)


def test_rt0_mismatch_is_not_success(tmp_path, monkeypatch):
    root = prepared_comparison(tmp_path, monkeypatch)
    monkeypatch.setattr(comparison, "compare_fixture", lambda *args, **kwargs: {})
    def reject(inputs, bundle):
        assert inputs == {"exact_reconstructed_input": True} and bundle == b"exact bundle"
        raise ValueError("RT0 fixture face moment mismatch")
    monkeypatch.setattr(comparison, "compare_rt0_fixture", reject, raising=False)
    with pytest.raises(ValueError, match="RT0 fixture face moment mismatch"):
        comparison.compare(tmp_path, root)


def test_bundle_observable_mismatch_is_not_success(tmp_path, monkeypatch):
    root = prepared_comparison(tmp_path, monkeypatch)
    monkeypatch.setattr(comparison, "compare_fixture", lambda *args, **kwargs: pytest.fail("no oracle"))
    def reject(inputs, values):
        raise ValueError("Bundle observable association: derived H differs from field")
    monkeypatch.setattr(comparison, "compare_bundle_observables", reject)
    with pytest.raises(ValueError, match="observable association"):
        comparison.compare(tmp_path, root)
