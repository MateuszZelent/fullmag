import pytest

import docker_goebel_qualification as q


def test_arguments_bind_only_canonical_workload_and_attempt_paths():
    token = "a" * 32
    args = q.solver_arguments(token)
    assert args[0:2] == [
        "/opt/fullmag/package/bin/fullmag-bin",
        (f"/opt/fullmag/control/goebel-scientific/attempts/{token}/inputs/"
         "tests/standard_problems/bimeron/goebel_2019/scenario_fdm.py"),
    ]
    assert args[2:13] == [
        "--backend", "fdm", "--precision", "double", "--mode", "strict",
        "--headless", "--ui", "none", "--existing-output", "error",
    ]
    assert args[13:] == [
        "--output-dir", f"/state/runs/goebel-reference/{token}/output.zarr",
        "--workspace-root", f"/state/runs/goebel-reference/{token}/workspace",
        "--receipt", f"/opt/fullmag/control/goebel-scientific/attempts/{token}/script-launch.json",
    ]
    with pytest.raises(ValueError, match="attempt"):
        q.solver_arguments("../foreign")


@pytest.mark.parametrize("changed", [
    {"health_status": "degraded"},
    {"queue_items": [{"state": "running"}]}, {"queue_cursor": "next"},
    {"runtime_state": "draining"}, {"native_leases_released": False},
])
def test_idle_admission_rejects_any_live_state_or_work(changed):
    record = dict(
        api_instance="de305d54-75b4-431b-adb2-eb6b9e546014",
        active_session=False, health_status="ok", queue_items=[],
        queue_cursor=None, runtime_state="ready", runtime_configured=True,
        native_leases_released=True,
    )
    q.validate_idle(record)
    with pytest.raises(ValueError, match="healthy and idle"):
        q.validate_idle({**record, **changed})


def test_cli_has_no_script_or_output_override():
    args = [
        "--repo-root", "/repo", "--source-root", "/registered",
        "--attempt", "a" * 32, "--config-sha256", "b" * 64,
        "--source-commit", "c" * 40, "--port", "3343",
    ]
    assert q.parser().parse_args(args).source_commit == "c" * 40
    with pytest.raises(SystemExit):
        q.parser().parse_args([*args, "--script", "/foreign.py"])


def test_solver_hash_requires_unique_artifact_and_matching_provenance():
    digest = "a" * 64
    artifact = {"path": "bin/fullmag-bin", "sha256": digest}
    provenance = {"binary_hashes": {"fullmag-bin": digest}}
    assert q.expected_solver_sha({"artifacts": [artifact]}, provenance) == digest
    with pytest.raises(ValueError, match="CLI binary"):
        q.expected_solver_sha({"artifacts": [artifact, artifact]}, provenance)
    with pytest.raises(ValueError, match="CLI binary"):
        q.expected_solver_sha({"artifacts": [artifact]}, {"binary_hashes": {}})



def test_retained_workspace_requires_exact_terminal_run():
    record = dict(
        api_instance="de305d54-75b4-431b-adb2-eb6b9e546014",
        active_session=True, health_status="ok", queue_items=[],
        queue_cursor=None, runtime_state="ready", runtime_configured=True,
        native_leases_released=True, current_run_id="run-01",
        current_run_status="cancelled", solver_state="idle",
    )
    q.validate_idle(record, "run-01")
    with pytest.raises(ValueError, match="exact pinned terminal run"):
        q.validate_idle(record)
    with pytest.raises(ValueError, match="exact pinned terminal run"):
        q.validate_idle(record, "run-02")
    with pytest.raises(ValueError, match="exact pinned terminal run"):
        q.validate_idle({**record, "current_run_status": "running"}, "run-01")


def test_existing_package_reuse_allows_only_the_nonruntime_fixture(monkeypatch):
    package = "a" * 40
    mounted = "b" * 40
    backend = dict(commit=package, worktree_state="clean")
    probe = dict(resolved_commit=mounted, native_source_identity={
        "head_commit_full": mounted, "source_snapshot_dirty": False,
    })
    monkeypatch.setattr(q.codegen, "_source_matches", lambda *args: False)
    changed = q.FIXTURE_ONLY

    def git(root, action, *args):
        if action == "rev-parse":
            return mounted.encode()
        if action == "merge-base":
            assert args == ("--is-ancestor", package, mounted)
            return b""
        assert args == ("--name-only", "-z", package, mounted)
        return changed.encode() + b"\0"

    monkeypatch.setattr(q, "_git", git)
    assert q._runtime_source_binding("/registered", probe, backend) == (mounted, [changed])
    changed = "packages/fullmag-py/src/fullmag/__init__.py"
    with pytest.raises(ValueError, match="runtime sources differ"):
        q._runtime_source_binding("/registered", probe, backend)


def test_periodic_fem_has_fixed_cpu_scenario_and_mesh_contract():
    token = "a" * 32
    args = q.solver_arguments(token, "fem-periodic")
    assert args[1].endswith("/goebel_2019/scenario_fem_periodic.py")
    assert args[2:8] == ["--backend", "fem", "--precision", "double", "--mode", "strict"]
    env = q.solver_environment({"FULLMAG_FDM_EXECUTION": "gpu", "FULLMAG_FEM_EXECUTION": "gpu"},
                               "fem-periodic")
    assert env["FULLMAG_FEM_EXECUTION"] == "cpu"
    assert "FULLMAG_FDM_EXECUTION" not in env
    assert env["CUDA_VISIBLE_DEVICES"] == ""
    with pytest.raises(ValueError, match="unknown qualification lane"):
        q.solver_arguments(token, "../foreign")


def test_mesh_pin_and_deadline_are_explicit():
    from argparse import Namespace

    args = Namespace(lane="fem-periodic", mesh_sha256=None, solver_timeout_s=None,
                     mesh_profile="reference")
    with pytest.raises(ValueError, match="mesh SHA-256"):
        q.validate_lane_args(args)
    args.mesh_sha256 = "f" * 64
    assert q.validate_lane_args(args) > 3600
    args.solver_timeout_s = 86401
    assert q.validate_lane_args(args) == 86401
    args.solver_timeout_s = 604801
    with pytest.raises(ValueError, match="deadline"):
        q.validate_lane_args(args)
    args.lane = "fdm"
    with pytest.raises(ValueError, match="mesh SHA-256"):
        q.validate_lane_args(args)
    args.mesh_sha256 = None
    args.mesh_profile = "light-airbox"
    with pytest.raises(ValueError, match="light airbox applies only"):
        q.validate_lane_args(args)
    args.mesh_profile = "reference"
    args.solver_timeout_s = 86401
    with pytest.raises(ValueError, match="deadline"):
        q.validate_lane_args(args)


def test_light_airbox_generation_is_explicit_and_hash_bound(tmp_path, monkeypatch):
    inputs = tmp_path / "inputs"
    mesh = inputs / q.FEM_MESH
    mesh.parent.mkdir(parents=True)
    data = b"light mesh"

    def generate(command, **kwargs):
        assert command[-2:] == [str(mesh), "--light-airbox"]
        mesh.write_bytes(data)

    monkeypatch.setattr(q.subprocess, "run", generate)
    assert q._generate_mesh(tmp_path, inputs, {}, q.digest(data), "light-airbox") == mesh
    assert q.mesh_profile_pins("reference") == {}
    assert q.mesh_profile_pins("light-airbox") == {"mesh_profile": "light-airbox"}


def test_worker_terminal_is_published_once(tmp_path):
    path = tmp_path / "worker-terminal.json"
    record = {"schema": q.WORKER_SCHEMA, "attempt": "a" * 32}
    q.publish_json_once(path, record)
    assert q._regular_json(path) == record
    with pytest.raises(FileExistsError):
        q.publish_json_once(path, {**record, "attempt": "b" * 32})
    assert q._regular_json(path) == record


def test_terminal_observation_binds_worker_to_the_exact_mesh_and_inputs():
    execution = {
        "operation_attempt": "a" * 32,
        "lane": "fem-periodic",
        "reference_input_sha256": {"scenario_fem_periodic.py": "b" * 64},
        "fullmag_binary_sha256": "c" * 64,
        "mesh_sha256": "d" * 64,
        "solver_timeout_s": 36000,
    }
    result = {
        "runtime_exit_code": 0,
        "runtime_log_sha256": "e" * 64,
        "verification": {"state": "not_verified"},
    }
    record = {
        "schema": q.WORKER_SCHEMA,
        "attempt": execution["operation_attempt"],
        "lane": execution["lane"],
        "inputs": execution["reference_input_sha256"],
        "binary_sha256": execution["fullmag_binary_sha256"],
        "mesh_sha256": execution["mesh_sha256"],
        "solver_timeout_s": execution["solver_timeout_s"],
        "result": result,
    }
    assert q.validate_worker_terminal(record, execution) == result
    with pytest.raises(ValueError, match="differs from the exact admitted operation"):
        q.validate_worker_terminal({**record, "mesh_sha256": "f" * 64}, execution)
    light = {"mesh_profile": "light-airbox"}
    with pytest.raises(ValueError, match="differs from the exact admitted operation"):
        q.validate_worker_terminal(record, {**execution, **light})
    assert q.validate_worker_terminal({**record, **light}, {**execution, **light}) == result
    with pytest.raises(ValueError, match="no terminal completion evidence"):
        q.validate_worker_terminal(None, execution)


def test_comparison_reference_flags_are_paired_and_fem_only():
    assert q.comparison_reference("fdm", None, None) is None
    assert q.comparison_reference(q.FEM_LANE, "a" * 32, "b" * 64) == {
        "attempt": "a" * 32, "input_sha256": "b" * 64,
    }
    with pytest.raises(ValueError, match="paired"):
        q.comparison_reference(q.FEM_LANE, "a" * 32, None)
    with pytest.raises(ValueError, match="FEM-only"):
        q.comparison_reference("fdm", "a" * 32, "b" * 64)
    with pytest.raises(ValueError, match="exact"):
        q.comparison_reference(q.FEM_LANE, "../foreign", "b" * 64)


def fdm_reference_bundle(root):
    for stage in ("stage_00_flat_relax", "stage_02_flat_run"):
        directory = root / "stages" / stage
        directory.mkdir(parents=True)
        for name in ("m_initial.json", "m_final.json", "metadata.json"):
            (directory / name).write_text(f"{stage}/{name}", encoding="utf-8")
    return root


def test_reference_digest_pins_all_six_files(tmp_path):
    import hashlib
    import json

    root = fdm_reference_bundle(tmp_path / "output.zarr")
    files = {
        f"stages/{stage}/{name}": hashlib.sha256(f"{stage}/{name}".encode()).hexdigest()
        for stage in ("stage_00_flat_relax", "stage_02_flat_run")
        for name in ("m_initial.json", "m_final.json", "metadata.json")
    }
    expected = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert q.fdm_input_digest(root) == expected
    state = root / "stages/stage_02_flat_run/m_initial.json"
    state.write_text("changed", encoding="utf-8")
    assert q.fdm_input_digest(root) != expected


def test_report_failure_keeps_native_success_and_records_reference_drift(tmp_path, monkeypatch):
    import json
    import subprocess

    root = fdm_reference_bundle(tmp_path / "fdm")
    results = tmp_path / "fem"
    results.mkdir()
    pin = {"attempt": "a" * 32, "input_sha256": q.fdm_input_digest(root)}

    def run(argv, **kwargs):
        assert argv[3] == q.FEM_COMPARISON_MODULE
        (root / "stages/stage_02_flat_run/m_initial.json").write_text("changed", encoding="utf-8")
        return subprocess.CompletedProcess(
            argv, 0, stdout=b'{"schema_version":"goebel_fem_fdm_midplane_comparison.v1"}', stderr=b"",
        )

    monkeypatch.setattr(q.subprocess, "run", run)
    report = q.compare_fem_reference(results, root, tmp_path, {}, pin)
    assert report["state"] == "not_verified"
    assert "FDM comparison inputs differ" in report["error"]
    saved = json.loads((results / q.FEM_COMPARISON_FILE).read_text(encoding="utf-8"))
    assert saved["fdm_reference"] == pin
    assert saved["status"] == "not_verified"


def test_comparison_report_uses_the_pinned_modules_and_both_endpoints(tmp_path, monkeypatch):
    import json
    import subprocess

    root = fdm_reference_bundle(tmp_path / "fdm")
    results = tmp_path / "fem"
    results.mkdir()
    pin = {"attempt": "a" * 32, "input_sha256": q.fdm_input_digest(root)}
    assert q.lane_inputs(q.FEM_LANE, pin) == (
        *q.lane_inputs(q.FEM_LANE),
        f"{q.SOURCE}/compare_fem_fdm.py",
        f"{q.SOURCE}/verify.py",
    )
    payload = {
        "schema_version": q.FEM_COMPARISON_SCHEMA,
        "stages": {"relaxed": {"q": -1}, "held": {"q": -1}},
    }

    def run(argv, **kwargs):
        assert argv[-2:] == [str(results / "output.zarr"), str(root)]
        assert kwargs["cwd"] == tmp_path
        assert kwargs["check"] is True
        return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(payload).encode(), stderr=b"")

    monkeypatch.setattr(q.subprocess, "run", run)
    report = q.compare_fem_reference(results, root, tmp_path, {}, pin)
    assert report["state"] == "compared"
    path = results / q.FEM_COMPARISON_FILE
    assert report["sha256"] == q._file_sha(path)
    assert json.loads(path.read_bytes()) == {**payload, "fdm_reference": pin, "status": "compared"}


def test_periodic_fem_gpu_requires_explicit_cuda_strict_environment():
    from argparse import Namespace

    lane = "fem-periodic-gpu"
    args = Namespace(lane=lane, mesh_sha256="f" * 64, solver_timeout_s=86400)
    assert q.validate_lane_args(args) == 86400
    args.solver_timeout_s += 1
    with pytest.raises(ValueError, match="deadline"):
        q.validate_lane_args(args)
    assert q.solver_arguments("a" * 32, lane) == q.solver_arguments("a" * 32, "fem-periodic")
    ref = q.comparison_reference(lane, "b" * 32, "c" * 64)
    assert q.lane_inputs(lane, ref) == q.lane_inputs("fem-periodic", ref)
    env = q.solver_environment({"FULLMAG_FEM_EXECUTION": "cpu", "CUDA_VISIBLE_DEVICES": "0"}, lane)
    assert {key: env[key] for key in (
        "FULLMAG_FEM_EXECUTION", "FULLMAG_GOEBEL_FEM_DEVICE", "FULLMAG_RELAX_DEVICE",
        "FULLMAG_FEM_MFEM_DEVICE", "FULLMAG_FEM_GPU_DEMAG_MODE", "CUDA_VISIBLE_DEVICES",
    )} == {
        "FULLMAG_FEM_EXECUTION": "gpu", "FULLMAG_GOEBEL_FEM_DEVICE": "gpu",
        "FULLMAG_RELAX_DEVICE": "gpu", "FULLMAG_FEM_MFEM_DEVICE": "cuda",
        "FULLMAG_FEM_GPU_DEMAG_MODE": "device_hypre_poisson", "CUDA_VISIBLE_DEVICES": "0",
    }
    with pytest.raises(ValueError, match="CUDA_VISIBLE_DEVICES"):
        q.solver_environment({"CUDA_VISIBLE_DEVICES": ""}, lane)


def _gpu_stage_metadata():
    return {
        "status": "completed",
        "requested_execution": {
            "backend": "fem", "device": "gpu", "precision": "double",
            "mode": "strict", "fallback_policy": "forbidden",
        },
        "pbc": {"axes": ["periodic", "open", "open"], "demag": "periodic_airbox_k0"},
        "execution_plan": {
            "backend_plan": {"rotated_interfacial_dmi": 3e-3, "enable_demag": True},
        },
        "execution_provenance": {
            "execution_engine": "fem_native_gpu", "precision": "double",
            "lossy_fallback_used": False,
            "execution_resolution": {"fallback_occurred": False},
            "fem_data_residency": "device_source_of_truth",
            "uses_cuda_kernels": True, "uses_gpu_poisson": True,
            "fem_demag_operator_mode": "device_hypre_poisson",
            "hypre_execution_policy": "device", "demag_residency": "device",
            "fem_gpu_state_allocated": True, "fem_gpu_rk_uses_cuda_kernels": True,
            "fem_gpu_rk_stage_exchange_device_resident": True,
            "fem_gpu_rk_allows_exchange_host_sync": False,
            "fem_gpu_execution_receipt": {
                "requested": "strict_device", "resolved": "device_resident",
                "executed": "cuda_fem", "execution_class": "device_resident",
                "precision": "double", "integrator": "rk45", "accounting_valid": True,
                "required_operator_mask": 991, "resolved_device_operator_mask": 991,
                "executed_device_operator_mask": 991,
                "resolved_host_operator_mask": 0, "resolved_unknown_operator_mask": 0,
                "executed_host_operator_mask": 0, "executed_unknown_operator_mask": 0,
                "fallback_count": 0, "hot_loop_compute_h2d_bytes": 0,
                "hot_loop_compute_d2h_bytes": 0, "hot_loop_compute_host_sync_count": 0,
                "accepted_step_count": 20,
            },
        },
    }


@pytest.mark.parametrize(("scope", "field", "value", "error"), [
    (None, None, None, None),
    ("receipt", "executed_device_operator_mask", 989, "required operators"),
    ("receipt", "integrator", "heun", "integrator"),
    ("receipt", "fallback_count", 1, "fallback_count"),
    ("receipt", "accepted_step_count", 0, "no accepted CUDA RK45 step"),
    ("receipt", "hot_loop_compute_h2d_bytes", 16, "hot_loop_compute_h2d_bytes"),
    ("provenance", "hypre_execution_policy", "host", "hypre_execution_policy"),
    ("provenance", "fem_gpu_execution_receipt", None, "missing native FEM GPU receipt"),
])
def test_cuda_attestation_requires_native_execution_on_both_stages(tmp_path, scope, field, value, error):
    relaxed = "stage_00_flat_relax"
    held = "stage_02_flat_run"
    for stage in (relaxed, held):
        path = tmp_path / "stages" / stage / "metadata.json"
        path.parent.mkdir(parents=True)
        metadata = _gpu_stage_metadata()
        if stage == held and scope:
            provenance = metadata["execution_provenance"]
            evidence = provenance["fem_gpu_execution_receipt"] if scope == "receipt" else provenance
            evidence[field] = value
        q.publish_json_once(path, metadata)

    if error:
        with pytest.raises(ValueError, match=f"{held}: .*{error}"):
            q.attest_fem_gpu(tmp_path)
    else:
        attestation = q.attest_fem_gpu(tmp_path)
        assert attestation["state"] == "attested"
        assert set(attestation["stages"]) == {relaxed, held}
        assert attestation["stages"][held]["metadata_sha256"] == (
            q._file_sha(tmp_path / "stages" / held / "metadata.json")
        )
