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
    manifest_bytes = json.dumps(manifest).encode("utf-8")
    metadata_bytes = (workspace / "artifacts" / "metadata.json").read_bytes()
    (workspace / "fullmag-run.json").write_bytes(manifest_bytes)
    (workspace / "output-storage.json").write_text(json.dumps(storage), encoding="utf-8")
    attestation = {
        "schema": runtime_artifacts.ARTIFACT_ATTESTATION_SCHEMA,
        "status": "completed",
        "exit_code": 0,
        "run_id": run_id,
        "session_id": session_id,
        "source_sha256": MODEL_SHA,
        "metadata_relative_path": runtime_artifacts.METADATA_RELATIVE_PATH,
        "metadata_sha256": hashlib.sha256(metadata_bytes).hexdigest(),
        "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
    }
    (workspace / runtime_artifacts.ARTIFACT_ATTESTATION_FILE).write_bytes(
        json.dumps(attestation, separators=(",", ":")).encode("utf-8")
    )


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
        "eigen/spectrum.v3.json": "{}",
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


def _is_generation_control_file(relative: str) -> bool:
    return (
        relative in {
            "frequency_domain/generation.v1.json",
            "frequency_domain/generation.v2.json",
        }
        or relative.startswith("frequency_domain/generations/")
    )


def _publish_v2_generation(case: Path, *, omitted=()) -> str:
    omitted = set(omitted)
    files = {
        path.relative_to(case).as_posix(): path.read_bytes()
        for path in case.rglob("*")
        if path.is_file()
        and not _is_generation_control_file(path.relative_to(case).as_posix())
        and path.relative_to(case).as_posix() not in omitted
    }
    members = {
        logical: {
            "byte_length": len(data),
            "sha256": "sha256:" + hashlib.sha256(data).hexdigest(),
        }
        for logical, data in sorted(files.items())
    }
    content = {
        "schema_version": "frequency_domain_artifact_generation.v2",
        "producer": {"run_id": RUN_ID, "stage_id": "eigen", "stage_kind": "eigensolve"},
        "members": members,
    }
    canonical = json.dumps(
        content, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    generation_id = "sha256:" + hashlib.sha256(canonical).hexdigest()
    generation_root = case / "frequency_domain/generations" / generation_id[7:]
    for logical, data in files.items():
        target = generation_root.joinpath(*logical.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    marker = json.dumps(
        {"generation_id": generation_id, "content": content},
        ensure_ascii=False,
        indent=2,
    ).encode("utf-8")
    marker_path = case / "frequency_domain/generation.v2.json"
    marker_path.parent.mkdir(parents=True, exist_ok=True)
    marker_path.write_bytes(marker)

    reader = plotting.ArtifactBundleReader(case)
    _, binding = plotting.resolve_runtime_artifact_root(
        case.parent.parent,
        plotting.PILOT,
        MODEL_SHA,
        metadata_bytes_loader=lambda _artifact_root: reader.read_bytes(
            "metadata.json", maximum_bytes=plotting.MAX_METADATA_BYTES),
    )
    result_path = case.parent.parent / "run-result.json"
    result = json.loads(result_path.read_text(encoding="utf-8"))
    result["runtime_output_binding"] = binding
    result_path.write_text(json.dumps(result), encoding="utf-8")
    return generation_id


def _publish_v1_generation(case: Path) -> str:
    files = {
        path.relative_to(case).as_posix(): path.read_bytes()
        for path in case.rglob("*")
        if path.is_file()
        and not _is_generation_control_file(path.relative_to(case).as_posix())
    }
    content = {
        "schema_version": "frequency_domain_artifact_generation.v1",
        "producer": {"run_id": RUN_ID, "stage_id": "eigen", "stage_kind": "eigensolve"},
        "members": {
            logical: {
                "byte_length": len(data),
                "sha256": "sha256:" + hashlib.sha256(data).hexdigest(),
            }
            for logical, data in sorted(files.items())
        },
    }
    canonical = json.dumps(
        content, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    generation_id = "sha256:" + hashlib.sha256(canonical).hexdigest()
    marker = json.dumps(
        {"generation_id": generation_id, "content": content},
        ensure_ascii=False,
        indent=2,
    ).encode("utf-8")
    marker_path = case / "frequency_domain/generation.v1.json"
    marker_path.parent.mkdir(parents=True, exist_ok=True)
    marker_path.write_bytes(marker)
    return generation_id


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
    result = json.loads((batch / "run-result.json").read_text(encoding="utf-8"))
    expected_hashes = result["artifacts"]["required_artifact_hashes"]
    assert campaign["artifact_sha256"]["eigen/dispersion.csv"] == expected_hashes[
        "eigen/dispersion.csv"]["sha256"]
    assert not campaign["artifact_sha256"]["eigen/dispersion.csv"].startswith("sha256:")
    assert campaign["input_sha256"]["metadata.json"] == expected_hashes["metadata.json"][
        "sha256"]


def test_load_campaign_rejects_mismatched_bare_artifact_digest(tmp_path, monkeypatch):
    batch = _write_batch(tmp_path)
    result_path = batch / "run-result.json"
    result = json.loads(result_path.read_text(encoding="utf-8"))
    result["artifacts"]["required_artifact_hashes"]["eigen/dispersion.csv"][
        "sha256"] = "f" * 64
    result_path.write_text(json.dumps(result), encoding="utf-8")
    monkeypatch.setattr(
        plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})

    with pytest.raises(ValueError, match="artifact hash or size mismatch: eigen/dispersion.csv"):
        plotting.load_campaign(batch)


def test_load_campaign_reads_immutable_members_when_legacy_aliases_are_absent(tmp_path, monkeypatch):
    batch = _write_batch(tmp_path)
    case = _artifact_dir(batch)
    expected = {
        relative: (case / relative).read_bytes()
        for relative in (
            "metadata.json",
            "eigen/dispersion.csv",
            "eigen/diagnostics/solver.v1.json",
            "eigen/spectrum.v3.json",
        )
    }
    generation_id = _publish_v2_generation(case)
    result = json.loads((batch / "run-result.json").read_text(encoding="utf-8"))
    for relative in result["artifacts"]["required_artifact_hashes"]:
        (case / relative).unlink()

    observed_readers = []

    def validate(_csv_path, sampling, _diagnostics_path, _metadata_path, *, bundle_reader):
        observed_readers.append(bundle_reader)
        assert sampling == "signed-fifteen"
        for relative, payload in expected.items():
            assert bundle_reader.read_bytes(
                relative, maximum_bytes=plotting._campaign_artifact_limit(relative)) == payload
        return {"status": "pass", "sampling": sampling, "sample_count": 15}

    monkeypatch.setattr(plotting, "validate_rows", validate)
    campaign = plotting.load_campaign(batch)

    assert campaign["rows"][0]["ky_rad_per_m"] == K_VALUES[0] * 1e6
    assert campaign["artifact_sha256"]["eigen/dispersion.csv"] == hashlib.sha256(
        expected["eigen/dispersion.csv"]).hexdigest()
    assert campaign["input_sha256"]["metadata.json"] == hashlib.sha256(
        expected["metadata.json"]).hexdigest()
    assert campaign["input_sha256"]["eigen/diagnostics/solver.v1.json"] == hashlib.sha256(
        expected["eigen/diagnostics/solver.v1.json"]).hexdigest()
    assert len(observed_readers) == 1
    assert observed_readers[0].generation.generation_id == generation_id


def test_load_campaign_accepts_historical_binding_for_verified_mutable_v1(tmp_path, monkeypatch):
    batch = _write_batch(tmp_path)
    case = _artifact_dir(batch)
    generation_id = _publish_v1_generation(case)
    recorded_binding = json.loads((batch / "run-result.json").read_text(encoding="utf-8"))[
        "runtime_output_binding"]
    monkeypatch.setattr(
        plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})

    campaign = plotting.load_campaign(batch)

    current_binding = dict(campaign["runtime_output_binding"])
    current_binding.pop("metadata_read_source")
    current_binding.pop("metadata_logical_path")
    assert current_binding == recorded_binding
    assert campaign["rows"][0]["sample_index"] == 0
    assert campaign["runtime_output_binding"]["metadata_read_source"] == "provided_verified_bytes"
    assert campaign["runtime_output_binding"]["metadata_logical_path"] == "metadata.json"
    assert campaign["artifact_generation"]["generation_id"] == generation_id
    assert campaign["artifact_generation"]["generation_binding_status"] == "byte_verified_mutable"
    assert campaign["case"] == case


def test_load_campaign_rejects_callbackless_binding_for_immutable_v2(tmp_path, monkeypatch):
    batch = _write_batch(tmp_path)
    case = _artifact_dir(batch)
    _publish_v2_generation(case)
    result_path = batch / "run-result.json"
    result = json.loads(result_path.read_text(encoding="utf-8"))
    result["runtime_output_binding"].pop("metadata_read_source")
    result["runtime_output_binding"].pop("metadata_logical_path")
    result_path.write_text(json.dumps(result), encoding="utf-8")
    monkeypatch.setattr(
        plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})

    with pytest.raises(ValueError, match="runtime_output_binding differs"):
        plotting.load_campaign(batch)


def test_load_campaign_rejects_non_annotation_binding_drift_for_mutable_v1(
    tmp_path, monkeypatch
):
    batch = _write_batch(tmp_path)
    case = _artifact_dir(batch)
    _publish_v1_generation(case)
    result_path = batch / "run-result.json"
    result = json.loads(result_path.read_text(encoding="utf-8"))
    result["runtime_output_binding"]["metadata_sha256"] = "f" * 64
    result_path.write_text(json.dumps(result), encoding="utf-8")
    monkeypatch.setattr(
        plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})

    with pytest.raises(ValueError, match="runtime_output_binding differs"):
        plotting.load_campaign(batch)


def test_load_campaign_never_falls_back_to_an_alias_for_an_undeclared_v2_member(
    tmp_path, monkeypatch
):
    batch = _write_batch(tmp_path)
    case = _artifact_dir(batch)
    _publish_v2_generation(case, omitted=("eigen/dispersion.csv",))
    assert (case / "eigen/dispersion.csv").is_file()
    monkeypatch.setattr(
        plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})

    with pytest.raises(ValueError):
        plotting.load_campaign(batch)


def test_load_campaign_fences_v2_after_all_campaign_rows_are_parsed(tmp_path, monkeypatch):
    batch = _write_batch(tmp_path)
    case = _artifact_dir(batch)
    _publish_v2_generation(case)

    def change_generation_during_validation(*args, **kwargs):
        # Publish a distinct, valid immutable generation. Corrupting the
        # selector would exercise canonical parsing, not the current fence.
        member = case / "eigen/spectrum.v3.json"
        member.write_bytes(member.read_bytes() + b" ")
        _publish_v2_generation(case)
        return {"status": "pass"}

    monkeypatch.setattr(plotting, "validate_rows", change_generation_during_validation)
    with pytest.raises(ValueError, match="generation changed"):
        plotting.load_campaign(batch)



def test_load_campaign_fails_closed_on_noncanonical_current_marker(tmp_path, monkeypatch):
    batch = _write_batch(tmp_path)
    case = _artifact_dir(batch)
    _publish_v2_generation(case)

    def corrupt_marker_during_validation(*args, **kwargs):
        marker = case / "frequency_domain/generation.v2.json"
        marker.write_bytes(marker.read_bytes() + b" ")
        return {"status": "pass"}

    monkeypatch.setattr(plotting, "validate_rows", corrupt_marker_during_validation)
    with pytest.raises(ValueError, match="generation commit is not canonical"):
        plotting.load_campaign(batch)


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


def test_load_campaign_rejects_post_terminal_metadata_edit_with_same_identity(tmp_path, monkeypatch):
    batch = _write_batch(tmp_path)
    metadata_path = _artifact_dir(batch) / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["post_run_edit"] = True
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    with pytest.raises(ValueError, match="Producer artifact attestation"):
        plotting.load_campaign(batch)


def test_load_campaign_rejects_post_terminal_manifest_edit_with_same_identity(tmp_path, monkeypatch):
    batch = _write_batch(tmp_path)
    manifest_path = _artifact_dir(batch).parent / "fullmag-run.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["finished_at"] = "2026-10-10T12:00:00Z"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    with pytest.raises(ValueError, match="Producer artifact attestation"):
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
    assert report["artifact_generation"] == campaign["artifact_generation"]
    assert report["source_sha256"]["managed_runtime_artifact_root.py"]
    assert report["source_sha256"]["comsol_modal_field_certificate.py"]
    assert report["source_sha256"]["frequency_domain_generation.py"]
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
