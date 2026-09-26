"""Failure-path checks for the durable run restart evidence probe."""
import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_project_api_runtime as probe


def fixture():
    payload = {"run_intent": {"specification": {
        "run_id": "run-one", "snapshot": {"project_id": "project-one"}}}}
    before = {"run_id": "run-one", "catalog": {
        "execution_state": "pending_preparation", "task_ids": ["task-one"]},
        "snapshot": {"catalog_state": "materialized", "tasks": [
            {"lifecycle": "accepted", "readiness": {"state": "blocked"}}]}}
    return payload, before


def test_runtime_free_recovery_requires_explicit_no_session(monkeypatch):
    monkeypatch.setattr(probe, "json_request", lambda *args, **kwargs: (404, {"code": "not_found"}))
    assert probe.runtime_free_recovery("http://localhost") == {"status": 404, "code": "not_found"}
    monkeypatch.setattr(probe, "json_request", lambda *args, **kwargs: (200, {"snapshots": []}))
    with pytest.raises(probe.ApiRuntimeSmokeError, match="without an active session"):
        probe.runtime_free_recovery("http://localhost")


def test_restart_reads_durable_state_before_replaying(monkeypatch):
    payload, before = fixture()
    calls = []
    responses = iter([(200, before["snapshot"]), (200, {
        "run_id": "run-one", "disposition": "replayed"}),
        (200, before["catalog"]), (200, before["snapshot"])])
    def request(url, **kwargs):
        calls.append((url, kwargs.get("method", "GET")))
        return next(responses)
    monkeypatch.setattr(probe, "json_request", request)
    assert probe.probe_project_run("http://localhost", payload, before) == before
    assert [method for _, method in calls] == ["GET", "POST", "POST", "GET"]


def test_restart_rejects_lost_state_before_any_replay(monkeypatch):
    payload, before = fixture()
    calls = []
    def request(url, **kwargs):
        calls.append(url)
        return 200, {"catalog_state": "pending_materialization", "tasks": []}
    monkeypatch.setattr(probe, "json_request", request)
    with pytest.raises(probe.ApiRuntimeSmokeError, match="changed across"):
        probe.probe_project_run("http://localhost", payload, before)
    assert len(calls) == 1


def test_restart_rejects_recreated_catalog(monkeypatch):
    payload, before = fixture()
    changed = copy.deepcopy(before["catalog"])
    changed["task_ids"] = ["replacement-task"]
    responses = iter([(200, before["snapshot"]), (200, {
        "run_id": "run-one", "disposition": "replayed"}),
        (200, changed), (200, before["snapshot"])])
    monkeypatch.setattr(probe, "json_request", lambda *args, **kwargs: next(responses))
    with pytest.raises(probe.ApiRuntimeSmokeError, match="replay changed"):
        probe.probe_project_run("http://localhost", payload, before)
