"""Contracts of the low-level live client (ADR 0068 F1, spec python-live-client-v1 §4)."""
from __future__ import annotations

import socket
import subprocess
import sys
from pathlib import Path

import pytest

from live_api_fake import FakeFullmagApi, api_error

from fullmag.client import (
    Client,
    CommandFailedError,
    CommandTimeoutError,
    DevelopmentRestartError,
    FullmagConnectionError,
    InputLockedError,
    NotFoundError,
    RequestValidationError,
    SessionExistsError,
    StaleRevisionError,
    Target,
    resolve_url,
)
from fullmag.client._generated.operations import OPERATIONS
from fullmag.client._transport import HttpTransport, normalize_base_url

REPO_ROOT = Path(__file__).resolve().parents[3]
COMMANDS = "/v2/sessions/current/simulation/commands"
TRANSACTIONS = "/v2/sessions/current/model/transactions"


@pytest.fixture()
def api():
    with FakeFullmagApi() as fake:
        yield fake


def make_client(api: FakeFullmagApi, **kwargs) -> Client:
    transport = HttpTransport(api.url, retry_budget_s=kwargs.pop("retry_budget_s", 2.0), sleep=lambda _s: None)
    return Client(transport=transport, **kwargs)


def test_generated_models_are_current() -> None:
    result = subprocess.run(
        [sys.executable, "-B", str(REPO_ROOT / "scripts/generate_python_api_models.py"), "--check"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_operation_table_matches_spec_paths() -> None:
    import json

    spec = json.loads((REPO_ROOT / "apps/control-room/src/kernel/api/generated/openapi-v2.json").read_text(encoding="utf-8"))
    for operation in OPERATIONS.values():
        item = spec["paths"][operation.path]
        assert item[operation.method.lower()]["operationId"] == operation.operation_id


def test_url_resolution_prefers_argument_then_environment(monkeypatch) -> None:
    monkeypatch.setenv("FULLMAG_URL", "http://127.0.0.1:4000")
    assert resolve_url("http://example.test:1") == "http://example.test:1"
    assert resolve_url() == "http://127.0.0.1:4000"
    monkeypatch.delenv("FULLMAG_URL")
    assert resolve_url() == "http://127.0.0.1:3197"
    assert normalize_base_url("http://127.0.0.1:3197/") == "http://127.0.0.1:3197"
    with pytest.raises(ValueError):
        normalize_base_url("ftp://127.0.0.1")
    with pytest.raises(ValueError):
        normalize_base_url("http://127.0.0.1:3197/?x=1")


def test_requests_reuse_one_keep_alive_connection(api) -> None:
    api.route("GET", "/v2/sessions/current/status", {"api_contract_version": "2"})
    client = make_client(api)
    for _ in range(3):
        assert client.sessions.status() == {"api_contract_version": "2"}
    connections = {request.connection_id for request in api.find("GET", "/v2/sessions/current/status")}
    assert len(connections) == 1
    assert api.requests[0].headers["user-agent"].startswith("fullmag-python-live-client/")


def test_transaction_payload_is_validated_before_sending(api) -> None:
    client = make_client(api)
    with pytest.raises(RequestValidationError, match="create_object"):
        client.model.commit({"kind": "create_object", "object_id": "o1"})
    with pytest.raises(RequestValidationError, match="must be one of"):
        client.model.commit({"kind": "explode"})
    assert api.find("POST", TRANSACTIONS) == []


def test_transaction_round_trip_and_stale_revision(api) -> None:
    responses = iter(
        [
            (200, {"transaction_kind": "merge_patch", "scene_revision": 8, "committed_scene": {"revision": 8}}, {}),
            api_error(409, "revision_conflict", "scene revision mismatch: base=7, current=8"),
        ]
    )
    api.route("POST", TRANSACTIONS, lambda _request: next(responses))
    client = make_client(api)
    response = client.model.merge_patch({"study": {"stages": []}}, base_revision=7)
    assert response["scene_revision"] == 8
    assert api.find("POST", TRANSACTIONS)[0].json() == {
        "kind": "merge_patch",
        "merge_patch": {"study": {"stages": []}},
        "base_revision": 7,
    }
    with pytest.raises(StaleRevisionError) as caught:
        client.model.merge_patch({"study": {}}, base_revision=7)
    assert caught.value.status == 409 and "base=7" in caught.value.message


@pytest.mark.parametrize(
    ("reply", "error_type"),
    [
        (api_error(409, "accepted_execution_input_locked", "finish or stop the accepted run"), InputLockedError),
        (api_error(409, "conflict", "an active local session already exists; set replace_current"), SessionExistsError),
        (api_error(404, "not_found", "no current session"), NotFoundError),
    ],
)
def test_error_codes_map_to_typed_errors(api, reply, error_type) -> None:
    api.route("POST", "/v2/sessions", reply)
    client = make_client(api)
    with pytest.raises(error_type):
        client.sessions.create("s", backend="fdm", device="cpu", precision="double")


def test_development_handoff_is_retried_then_succeeds(api) -> None:
    replies = iter(
        [
            api_error(409, "development_restart_in_progress", "closed for handoff"),
            api_error(409, "development_restart_in_progress", "closed for handoff"),
            (200, {"accepted": True, "command_id": "c1"}, {}),
        ]
    )
    api.route("POST", COMMANDS, lambda _request: next(replies))
    handle = make_client(api).commands.submit("pause", target=Target.study())
    assert handle.command_id == "c1"
    intents = {request.json()["client_intent_id"] for request in api.find("POST", COMMANDS)}
    assert len(intents) == 1, "retries must reuse the same client_intent_id"


def test_development_handoff_beyond_budget_raises(api) -> None:
    api.route("POST", COMMANDS, api_error(409, "development_restart_in_progress", "closed"))
    client = make_client(api, retry_budget_s=0.0)
    with pytest.raises(DevelopmentRestartError):
        client.commands.submit("pause")


def test_proxy_502_is_retried_for_mutations(api) -> None:
    replies = iter([(502, b"Bad Gateway", {"Content-Type": "text/plain"}), (200, {"accepted": True, "command_id": "c2"}, {})])
    api.route("POST", COMMANDS, lambda _request: next(replies))
    assert make_client(api).commands.submit("stop").command_id == "c2"


def test_command_wait_polls_until_terminal(api) -> None:
    api.route("POST", COMMANDS, {"accepted": True, "command_id": "c3"})
    states = iter(["queued", "running", "completed"])
    api.route(
        "GET",
        f"{COMMANDS}/c3",
        lambda _request: (200, {"command_id": "c3", "seq": 1, "kind": "run", "created_at_unix_ms": 0, "status": next(states), "completion_status": "succeeded"}, {}),
    )
    client = make_client(api)
    handle = client.commands.submit("run", target=Target.study(), until_seconds=1e-9)
    handle.sleep = lambda _s: None
    detail = handle.wait()
    assert detail["status"] == "completed"
    body = api.find("POST", COMMANDS)[0].json()
    assert body["kind"] == "run" and body["until_seconds"] == 1e-9 and body["target"] == {"kind": "study"}
    assert body["client_intent_id"].startswith("py-")


def test_command_wait_raises_for_failed_and_cancelled(api) -> None:
    api.route("POST", COMMANDS, {"accepted": True, "command_id": "c4"})
    api.route(
        "GET",
        f"{COMMANDS}/c4",
        {"command_id": "c4", "seq": 1, "kind": "relax", "created_at_unix_ms": 0, "status": "completed", "completion_status": "cancelled"},
    )
    handle = make_client(api).commands.submit("relax")
    with pytest.raises(CommandFailedError, match="cancelled"):
        handle.wait()
    assert handle.wait(raise_on_failure=False)["completion_status"] == "cancelled"


def test_command_wait_times_out(api) -> None:
    api.route("POST", COMMANDS, {"accepted": True, "command_id": "c5"})
    api.route("GET", f"{COMMANDS}/c5", {"command_id": "c5", "seq": 1, "kind": "run", "created_at_unix_ms": 0, "status": "running"})
    handle = make_client(api).commands.submit("run", until_seconds=1.0)
    ticks = iter(range(100))
    handle.clock = lambda: float(next(ticks))
    handle.sleep = lambda _s: None
    with pytest.raises(CommandTimeoutError):
        handle.wait(timeout=3.0)


def test_unknown_query_and_missing_path_parameters_are_rejected(api) -> None:
    client = make_client(api)
    with pytest.raises(ValueError, match="query"):
        client.data.scalars(nonsense=1)
    with pytest.raises(ValueError, match="path parameter"):
        client.call("simulation_get_sessions_current_simulation_commands_command_id")


def test_session_scope_header_is_sent_where_declared(api) -> None:
    api.route("GET", "/v2/sessions/current/status", {"ok": True})
    client = make_client(api)
    client.session_scope = "session=s1&epoch=e1&request_scope_epoch=r1"
    client.sessions.status()
    assert api.requests[-1].headers["x-fullmag-session-scope"] == client.session_scope


def test_unreachable_api_raises_connection_error() -> None:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    transport = HttpTransport(f"http://127.0.0.1:{port}", retry_budget_s=0.0, sleep=lambda _s: None)
    with pytest.raises(FullmagConnectionError, match="docker-dev"):
        Client(transport=transport).sessions.status()
