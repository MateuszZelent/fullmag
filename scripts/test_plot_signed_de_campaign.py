"""Focused regressions for the signed-fifteen postprocessor."""

import hashlib
import json
from pathlib import Path

import pytest

import managed_runtime_artifact_root as runtime_artifacts
import plot_signed_de_campaign as plotting


K_VALUES = (-25, -20, -15, -10, -7, -5, -2, 0, 2, 5, 7, 10, 15, 20, 25)
MODEL_SHA = "a" * 64
JOB = {"job_id": "b" * 32, "worktree_id": "worktree", "source_digest": "c" * 64}
SOURCE = {"capsule_relative": "runs/worktree/job/source/tree", "resolved_commit": "d" * 40}
MODEL_SOURCE = {"kind": "versioned_standalone_input", "commit": "e" * 40,
                "path": "examples/fem_de_smoke_numeric.py", "sha256": MODEL_SHA}
CAMPAIGN = {
    "mode": "adaptive", "sampling": "signed-fifteen", "model_sha256": MODEL_SHA,
    "model_source_commit": MODEL_SOURCE["commit"], "max_cpu_percent": 90,
    "max_memory_percent": 80, "memory_reserve_bytes": 1_073_741_824,
    "max_workers": None, "threads_per_worker": 1,
}


RUN_ID = "run-session-17"
SESSION_ID = "session-17"


def _artifact_dir(batch: Path) -> Path:
    return batch / f"{plotting.PILOT}-{RUN_ID}-0" / "artifacts"


def _write_runtime_evidence(batch: Path, workspace: Path, run_id: str, session_id: str) -> None:
    container_workspace = runtime_artifacts.CONTAINER_ROOT + "/" + workspace.name
    summary = {
        "status": "completed", "backend": "fem", "mode": "strict", "precision": "double",
        "workspace_dir": container_workspace, "artifact_dir": container_workspace + "/artifacts",
        "run_id": run_id, "session_id": session_id,
    }
    log_path = batch / plotting.PILOT / "runtime.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text("[solver] progress\n" + json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    manifest = {
        "schema": "fullmag.run_manifest.v1", "status": "completed", "exit_code": 0,
        "source": {"sha256": MODEL_SHA}, "run_id": run_id, "session_id": session_id,
        "outputs": [{"path": "artifacts/metadata.json", "kind": "metadata"}],
    }
    storage = {
        "schema": "fullmag.output_storage.resolved.v1", "state": "succeeded",
        "resolved": {"output_dir": container_workspace, "run_id": run_id},
    }
    (workspace / "fullmag-run.json").write_text(json.dumps(manifest), encoding="utf-8")
    (workspace / "output-storage.json").write_text(json.dumps(storage), encoding="utf-8")


def _write_batch(tmp_path: Path) -> Path:
    batch = tmp_path / "batch"
    case = _artifact_dir(batch)
    (case / "eigen" / "diagnostics").mkdir(parents=True)
    (case / "eigen" / "metadata").mkdir(parents=True)
    (case / "frequency_domain").mkdir(parents=True)
    model = {
        "schema": "fullmag.de-smoke.v1", "sampling": "signed-fifteen",
        "dispersion_geometry": "damon_eshbach", "orientation": "M0=x,k=y,normal=z",
        "outer_boundary_kind": "poisson_dirichlet", "modal_target": "frequency_window",
        "selection_scope": "frequency_window", "window_complete": None,
        "requested_mode_count": 1, "ky_rad_per_m": [k * 1e6 for k in K_VALUES],
        "kx_rad_per_m": [0.0] * 15,
        "k_vectors_rad_per_m": [[0.0, k * 1e6, 0.0] for k in K_VALUES],
        "frequency_window_hz": [8.5e9, 16e9], "magnetostatic_bc": "floquet_airbox",
        "mu0_t_m_a": plotting.MU0, "external_induction_t": 0.1,
        "air_padding_each_side_m": 2e-6, "film_thickness_m": 10e-9,
        "exchange_stiffness_j_per_m": 13e-12,
        "saturation_magnetization_a_per_m": 800000.0,
        "gamma0_m_per_a_s": 221100.0,
    }
    metadata = {
        "source_hash": MODEL_SHA,
        "problem_meta": {"runtime_metadata": {
            "producer_run_id": RUN_ID,
            "de_smoke": model,
            "runtime_selection": {
                "parallel_execution": {"mode": "adaptive", **plotting.EXPECTED_POLICY},
            },
        }},
    }
    metadata_path = case / "metadata.json"
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    rows = [
        {
            "sample_index": index, "raw_mode_index": 0, "branch_id": 0,
            "kx_rad_per_m": 0.0, "ky_rad_per_m": k * 1e6, "kz_rad_per_m": 0.0,
            "frequency_hz": 10.0e9 + index * 1.0e8, "residual_norm": 1.0e-12,
        }
        for index, k in enumerate(K_VALUES)
    ]
    csv_path = case / "eigen" / "dispersion.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as stream:
        stream.write(",".join(rows[0].keys()) + "\n")
        for row in rows:
            stream.write(",".join(str(value) for value in row.values()) + "\n")
    artifacts = {
        "eigen/spectrum.v2.json": "{}",
        "eigen/branches.v2.json": "{}",
        "eigen/diagnostics/solver.v1.json": "{}",
        "eigen/metadata/eigen_summary.json": "{}",
        "frequency_domain/manifest.v1.json": "{}",
    }
    for relative, content in artifacts.items():
        path = case / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    hashes = {}
    for path in [metadata_path, csv_path, *(case / key for key in artifacts)]:
        relative = path.relative_to(case).as_posix()
        hashes[relative] = {
            "size": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }

    workspace = case.parent
    _write_runtime_evidence(batch, workspace, RUN_ID, SESSION_ID)
    request = {
        "schema": "fullmag.de-smoke.request.v1", "status": "prepared",
        "operation": plotting.PILOT + "-numerical-pilot", "cases": [plotting.PILOT],
        "sampling": "signed-fifteen", "output_dir": str(batch.resolve()),
        "job": JOB, "source": SOURCE, "model_sha256": MODEL_SHA,
        "model_source": MODEL_SOURCE, "parallel_campaign": CAMPAIGN,
    }
    _, runtime_binding = plotting.resolve_runtime_artifact_root(batch.resolve(), plotting.PILOT, MODEL_SHA)
    result = {
        "schema": "fullmag.de-smoke.result.v1", "pilot": plotting.PILOT,
        "status": "completed_unqualified", "return_code": 0, "job": JOB,
        "source": SOURCE, "model_sha256": MODEL_SHA, "model_source": MODEL_SOURCE,
        "parallel_campaign": CAMPAIGN,
        "runtime_output_binding": runtime_binding,
        "artifacts": {"case": plotting.PILOT, "required_artifact_hashes": hashes},
    }
    (batch / "run-request.json").write_text(json.dumps(request), encoding="utf-8")
    (batch / "run-result.json").write_text(json.dumps(result), encoding="utf-8")
    return batch


def test_load_campaign_binds_receipt_hashes_and_actual_rows(tmp_path, monkeypatch):
    batch = _write_batch(tmp_path)
    calls = []

    def validate(*args, **kwargs):
        calls.append((args, kwargs))
        return {"status": "pass", "sampling": "signed-fifteen", "sample_count": 15}

    monkeypatch.setattr(plotting, "validate_rows", validate)
    campaign = plotting.load_campaign(batch)
    assert len(campaign["rows"]) == 15
    assert [row["ky_rad_per_m"] for row in campaign["rows"]] == [k * 1e6 for k in K_VALUES]
    assert calls and calls[0][0][1] == "signed-fifteen"
    assert campaign["parallel_campaign"]["mode"] == "adaptive"
    assert campaign["case"] == _artifact_dir(batch)
    assert campaign["runtime_output_binding"]["run_id"] == RUN_ID
    assert campaign["artifact_sha256"]["eigen/dispersion.csv"]


def test_load_campaign_rejects_missing_runtime_output_binding(tmp_path, monkeypatch):
    batch = _write_batch(tmp_path)
    result_path = batch / "run-result.json"
    result = json.loads(result_path.read_text(encoding="utf-8"))
    result.pop("runtime_output_binding")
    result_path.write_text(json.dumps(result), encoding="utf-8")
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    with pytest.raises(ValueError, match="runtime_output_binding is missing"):
        plotting.load_campaign(batch)


def test_load_campaign_rejects_tampered_runtime_output_binding(tmp_path, monkeypatch):
    batch = _write_batch(tmp_path)
    result_path = batch / "run-result.json"
    result = json.loads(result_path.read_text(encoding="utf-8"))
    result["runtime_output_binding"]["metadata_sha256"] = "f" * 64
    result_path.write_text(json.dumps(result), encoding="utf-8")
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    with pytest.raises(ValueError, match="runtime_output_binding differs"):
        plotting.load_campaign(batch)


def test_load_campaign_rejects_stale_runtime_output_binding(tmp_path, monkeypatch):
    batch = _write_batch(tmp_path)
    old_workspace = _artifact_dir(batch).parent
    run_id, session_id = "run-session-18", "session-18"
    current_workspace = batch / f"{plotting.PILOT}-{run_id}-0"
    old_workspace.rename(current_workspace)
    metadata_path = current_workspace / "artifacts" / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["problem_meta"]["runtime_metadata"]["producer_run_id"] = run_id
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    _write_runtime_evidence(batch, current_workspace, run_id, session_id)
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    with pytest.raises(ValueError, match="runtime_output_binding differs"):
        plotting.load_campaign(batch)


def test_load_campaign_rejects_failed_receipt_before_plot_output(tmp_path, monkeypatch):
    batch = _write_batch(tmp_path)
    result_path = batch / "run-result.json"
    result = json.loads(result_path.read_text(encoding="utf-8"))
    result["status"] = "failed"
    result_path.write_text(json.dumps(result), encoding="utf-8")
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    with pytest.raises(ValueError, match="completed managed"):
        plotting.load_campaign(batch)
    assert not (batch.parent / "plot").exists()


def test_load_campaign_rejects_artifact_tamper(tmp_path, monkeypatch):
    batch = _write_batch(tmp_path)
    csv_path = _artifact_dir(batch) / "eigen" / "dispersion.csv"
    csv_path.write_text(csv_path.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    with pytest.raises(ValueError, match="artifact hash or size mismatch"):
        plotting.load_campaign(batch)


def test_load_campaign_rejects_parallel_source_commit_drift(tmp_path, monkeypatch):
    batch = _write_batch(tmp_path)
    for name in ("run-request.json", "run-result.json"):
        path = batch / name
        value = json.loads(path.read_text(encoding="utf-8"))
        value["parallel_campaign"]["model_source_commit"] = "f" * 40
        path.write_text(json.dumps(value), encoding="utf-8")
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    with pytest.raises(ValueError, match="source commit differs"):
        plotting.load_campaign(batch)


def test_write_plot_uses_actual_points_and_refuses_overwrite(tmp_path, monkeypatch):
    pytest.importorskip("matplotlib")
    batch = _write_batch(tmp_path)
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    calls = {"n0": 0, "coupled": 0}

    def n0(**kwargs):
        calls["n0"] += 1
        return {"open_film_n0_frequency_hz": 9.0e9,
                "finite_dirichlet_n0_frequency_hz": 9.1e9}

    def coupled(**kwargs):
        calls["coupled"] += 1
        return {"modes": [{"frequency_hz": 9.2e9}]}

    monkeypatch.setattr(plotting, "n0_reference_frequencies", n0)
    monkeypatch.setattr(plotting, "solve_thickness_modes", coupled)
    campaign = plotting.load_campaign(batch)
    output = batch.parent / "plot"
    files = plotting.write_plot(campaign, output)
    report = json.loads((output / "plot-receipt.json").read_text(encoding="utf-8"))
    assert calls == {"n0": 15, "coupled": 15}
    assert report["actual_point_count"] == 15
    assert report["mirrored_samples"] is False
    assert report["interpolated_numeric_samples"] is False
    assert report["runtime_output_binding"] == campaign["runtime_output_binding"]
    assert report["source_sha256"]["managed_runtime_artifact_root.py"]
    assert report["references"][0]["k_rad_per_m"] == -25e6
    assert Path(files["png"]).is_file() and Path(files["pdf"]).is_file()
    with pytest.raises(ValueError, match="overwrite"):
        plotting.write_plot(campaign, output)


def test_write_plot_requires_new_sibling_in_batch_storage(tmp_path, monkeypatch):
    batch = _write_batch(tmp_path)
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    campaign = plotting.load_campaign(batch)
    with pytest.raises(ValueError, match="sibling"):
        plotting.write_plot(campaign, batch / "nested-plot")
