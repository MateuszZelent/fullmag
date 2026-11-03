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
