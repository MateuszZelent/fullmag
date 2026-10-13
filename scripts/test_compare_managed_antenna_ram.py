"""Interpreted comparison orchestration checks, not native qualification."""
import json
import shutil
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


def test_actual_standalone_input_preserves_physical_oracle_pin(tmp_path):
    repo = Path(__file__).resolve().parents[1]
    paths, _, generated = comparison.launcher.fixture_identity(repo, standalone=True)
    for name, path in paths.items():
        target = tmp_path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    script = tmp_path / comparison.launcher.SCRIPT_NAME
    script.write_bytes(generated)
    inputs = comparison.reconstruct_inputs(repo, script, standalone=True)
    assert comparison.fixture_input_digest(inputs) == comparison.FIXTURE_INPUT_SHA256


def test_standalone_reconstruction_rejects_original_magnetic_probe():
    repo = Path(__file__).resolve().parents[1]
    with pytest.raises(ValueError, match="Standalone input contains magnetic state or dynamics"):
        comparison.reconstruct_inputs(repo, repo / "examples/fem_antenna_current_source_inspection.py",
                                      standalone=True)


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


def test_standalone_comparison_reconstructs_executed_script_not_magnetic_original(tmp_path, monkeypatch):
    root = prepared_comparison(tmp_path, monkeypatch)
    receipt = comparison.launcher.read_json(None)
    receipt["fixture_variant"] = "standalone"
    calls = []
    def reconstruct(source, script, *, standalone=False):
        assert source == tmp_path / "capsule/tree"
        assert script == root / "input" / comparison.launcher.SCRIPT_NAME
        assert standalone is True
        calls.append(script)
        return {"exact_reconstructed_input": True}
    monkeypatch.setattr(comparison, "reconstruct_inputs", reconstruct)
    monkeypatch.setattr(comparison, "compare_fixture", lambda *args, **kwargs: {"comparison": "PASS"})
    result = comparison.compare(tmp_path, root)
    assert len(calls) == 1
    assert result["fixture_variant"] == "standalone"
    assert result["standalone_input_nonmagnetic"] is True
    assert result["physics_qualified"] is False


def test_unknown_variant_cannot_reconstruct_or_report_success(tmp_path, monkeypatch):
    root = prepared_comparison(tmp_path, monkeypatch)
    comparison.launcher.read_json(None)["fixture_variant"] = "other"
    monkeypatch.setattr(comparison, "reconstruct_inputs", lambda *args: pytest.fail("no input"))
    with pytest.raises(ValueError, match="variant"):
        comparison.compare(tmp_path, root)


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


@pytest.mark.parametrize("reject_current", [False, True])
def test_v2_checks_J_before_reporting_any_scientific_success(tmp_path, monkeypatch, reject_current):
    root = prepared_comparison(tmp_path, monkeypatch)
    legacy_reader = comparison.read_inspection
    monkeypatch.setattr(comparison, "read_inspection", lambda *args: {
        **legacy_reader(*args), "current_display_bytes": b"snapshot", "current_display_receipt": {},
        "current_display_sha256": "9" * 64})
    calls = []
    def current(inputs, values):
        assert inputs == {"exact_reconstructed_input": True}
        assert values["current_display_bytes"] == b"snapshot"
        calls.append("J")
        if reject_current:
            raise ValueError("I/A vector mismatch")
        return {"comparison": "PASS", "physics_qualified": False}
    def oracle(*args, **kwargs):
        assert calls == ["J"]
        return {"physics_qualified": False}
    monkeypatch.setattr(comparison, "compare_current_display_fixture", current)
    monkeypatch.setattr(comparison, "compare_fixture", oracle)
    if reject_current:
        with pytest.raises(ValueError, match="I/A"):
            comparison.compare(tmp_path, root)
    else:
        result = comparison.compare(tmp_path, root)
        assert result["schema"] == "fullmag.antenna-ram-V-J-H-comparison.v2"
        assert result["current_display_comparison"]["comparison"] == "PASS"
        assert result["current_display_sha256"] == "9" * 64
        assert result["physics_qualified"] is False and result["reuse_LLG_FFT_qualified"] is False


def test_cli_retains_report_only_after_success(tmp_path, monkeypatch, capsys):
    root = tmp_path / "runs" / ("1" * 32)
    (root / "export").mkdir(parents=True)
    monkeypatch.setattr(comparison.launcher.storage, "resolve_layout", lambda *args: {
        "build_root": str(tmp_path)})
    result = {"comparison": "PASS", "physics_qualified": False,
              "native_canonical_bundle_redecoded": False}
    monkeypatch.setattr(comparison, "compare", lambda *args: dict(result))
    reported = comparison.main([
        "--repo-root", str(tmp_path), "--run-root", str(root), "--write-report"])
    retained = json.loads((root / "export/V-J-H-comparison.json").read_text())
    assert retained == reported == json.loads(capsys.readouterr().out)
    assert retained["comparison_sources_sha256"] == comparison.comparison_sources_sha256()
    assert retained["physics_qualified"] is False
    assert retained["native_canonical_bundle_redecoded"] is False


@pytest.mark.parametrize("source_change", [False, True])
def test_cli_does_not_publish_failed_or_changed_comparison(tmp_path, monkeypatch, source_change):
    root = tmp_path / "runs" / ("1" * 32)
    root.mkdir(parents=True)
    def execute(*args):
        if not source_change:
            raise ValueError("field mismatch")
        return {"comparison": "PASS"}
    monkeypatch.setattr(comparison, "compare", execute)
    if source_change:
        pins = iter([{"reader": "a" * 64}, {"reader": "b" * 64}])
        monkeypatch.setattr(comparison, "comparison_sources_sha256", lambda: next(pins))
    with pytest.raises(ValueError, match="sources changed" if source_change else "field mismatch"):
        comparison.main([
            "--repo-root", str(tmp_path), "--run-root", str(root), "--write-report"])
    assert not (root / "export/V-J-H-comparison.json").exists()
