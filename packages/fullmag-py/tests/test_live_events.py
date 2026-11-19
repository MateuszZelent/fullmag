"""Realtime events, quantity reads and chunked loops in live mode (ADR 0068 F4, spec §5.4, §7)."""
from __future__ import annotations

import math
import threading
from pathlib import Path

import pytest

from live_session_fake import FakeLiveSession
from live_ws_fake import FakeEventServer, event

import fullmag as fm
from fullmag.client.events import EventStream

SCALARS = "/v2/sessions/current/data/scalars"


def test_event_stream_dispatches_and_resumes_after_drop() -> None:
    events = [
        event("hello", 1, {"current_seq": 1}),
        event("scalar.sample", 2, {"revision": 1, "row": {"step": 10, "mx": 0.9}}),
        event("resource.batch_changed", 3, {"changes": [{"resource": "commands", "revision": 4}], "coalesced": False, "window_ms": 0}),
        event("scalar.sample", 4, {"revision": 2, "row": {"step": 20, "mx": 0.8}}),
    ]
    with FakeEventServer(events, close_after=2) as server:
        stream = EventStream(server.url, reconnect_max_s=0.2)
        received: list[int] = []
        done = threading.Event()

        def collect(item) -> None:
            received.append(item.seq)
            if item.seq == 4:
                done.set()

        stream.subscribe("*", collect)
        changed: list[set[str]] = []
        stream.subscribe("resource.batch_changed", lambda item: changed.append(item.changed_resources()))
        stream.start()
        assert done.wait(10), received
        stream.close()
    assert received == [1, 2, 3, 4], "replay after reconnect must not duplicate or skip events"
    # A loaded host can time out a handshake before any event arrives; such
    # retries carry no cursor. The reconnect resumes after the last event the
    # client received: 2, or 1 when closing the fake's socket with the client's
    # unread pong resets the connection before event 2 is read.
    queries = [connection["query"] for connection in server.connections]
    assert queries[-1] in ({"after_seq": "2"}, {"after_seq": "1"}), queries
    assert all(query == {} for query in queries[:-1]), queries
    assert changed == [{"commands"}]


def test_pings_are_answered_with_pongs() -> None:
    from fullmag.client.events import WebSocketConnection

    with FakeEventServer([event("hello", 1, {})]) as server:
        connection = WebSocketConnection.connect(server.url, "/v2/sessions/current/events/ws", subprotocol="fullmag.live.v1", timeout=5)
        opcode, data = connection.recv_message()  # the server pings before the first event
        assert opcode == 0x1 and b'"hello"' in data
        assert server.pong_received.wait(5), "pings must be answered"
        connection.send_close()


def test_wrong_subprotocol_is_rejected() -> None:
    from fullmag.client.events import WebSocketConnection, WebSocketError

    with FakeEventServer([]) as server:
        with pytest.raises(WebSocketError, match="refused"):
            WebSocketConnection.connect(server.url, "/v2/sessions/current/events/ws", subprotocol="other", timeout=5)


def test_wait_for_change_wakes_on_event() -> None:
    with FakeEventServer([event("hello", 1, {})]) as server:
        stream = EventStream(server.url)
        stream.start()
        for _ in range(50):
            if stream.last_seq == 1:
                break
            stream.wait_for_change(0.1)
        stream.close()
    assert stream.last_seq == 1


@pytest.fixture()
def live(monkeypatch):
    monkeypatch.delenv("FULLMAG_URL", raising=False)
    with fm.ExecutionContext():
        with FakeLiveSession() as fake:
            rows = {"step": 0, "time": 0.0, "mx": 1.0, "my": 0.0, "mz": 0.0, "e_total": -1e-18}

            def scalars(request):
                # Mirror the server's typed query: `tail` is a flag, `limit` counts rows.
                if request.query.get("tail") not in (None, "true", "false"):
                    return 400, {"code": "bad_request", "message": "tail must be true or false"}, {}
                if not request.query.get("limit", "0").isdigit():
                    return 400, {"code": "bad_request", "message": "limit must be an integer"}, {}
                return 200, {"revision": rows["step"], "total_rows": 1, "returned_rows": 1, "columns": list(rows), "rows": [list(rows.values())], "observation_frames": []}, {}

            fake.api.route("GET", SCALARS, scalars)
            original = fake._command

            def command(request):
                reply = original(request)
                rows["step"] += 100
                rows["time"] += 1e-10
                rows["mx"] -= 0.25
                return reply

            fake.api.routes[("POST", "/v2/sessions/current/simulation/commands")] = command
            fm.connect(fake.url, events=False)
            fm.engine("fdm")
            fm.cell(5e-9, 5e-9, 10e-9)
            fm.solver(fix_dt=1e-13)
            layer = fm.geometry(fm.Box(100e-9, 50e-9, 10e-9), name="layer")
            layer.Ms, layer.Aex, layer.alpha = 800e3, 13e-12, 0.5
            layer.m = fm.texture.uniform(1, 0, 0)
            yield fake
            fm.disconnect()


def test_quantity_handles_read_live_scalars(live) -> None:
    fm.run(1e-10)
    assert fm.m.average() == pytest.approx((0.75, 0.0, 0.0))
    assert float(fm.E_total) == pytest.approx(-1e-18)
    assert (fm.mx < 0.8).evaluate()


def test_run_while_runs_chunks_until_condition_fails(live) -> None:
    fm.run_while(fm.mx > 0.3, chunk_time=1e-10, max_time=1e-8)
    runs = live.command_bodies("run")
    assert len(runs) == 3  # mx: 0.75, 0.5, 0.25
    assert all(body["until_seconds"] == pytest.approx(1e-10) for body in runs)


def test_run_until_respects_solver_step_guard(live) -> None:
    session = fm.live.require_session("test")
    session.run_until(lambda step: False, chunk_time=1e-10, max_solver_steps=250)
    assert len(live.command_bodies("run")) == 3  # 100, 200, 300 >= 250


def test_run_until_requires_a_guard(live) -> None:
    with pytest.raises(ValueError, match="guard"):
        fm.run_until(lambda step: True, chunk_time=1e-10)


def test_jupyter_monitor_collects_samples_without_ipython(live) -> None:
    from fullmag.live import jupyter
    from fullmag.client.events import LiveEvent

    session = fm.live.require_session("test")
    session.events = type("Stub", (), {"subscribe": lambda self, kind, cb: type("S", (), {"cancel": lambda s: None})()})()
    monitor = jupyter.monitor(("mx",))
    monitor._on_sample(LiveEvent("scalar.sample", 5, {"row": {"time": 1e-10, "mx": 0.5, "label": "x"}}))
    assert monitor.samples == [{"time": 1e-10, "mx": 0.5}]
    assert "mx" in jupyter._table(monitor.samples, "time", ("mx",))
    session.events = None
    monitor.stop()


def test_field_only_runs_average_m_from_the_published_field(monkeypatch) -> None:
    # Accepted Docker runs publish fields but no scalar rows yet.
    field_bytes = (Path(__file__).resolve().parent / "fixtures" / "fmvp" / "v2_grid.bin").read_bytes()
    monkeypatch.delenv("FULLMAG_URL", raising=False)
    with fm.ExecutionContext():
        with FakeLiveSession() as fake:
            fake.api.route("GET", SCALARS, (200, {"revision": 0, "total_rows": 0, "returned_rows": 0, "columns": ["step", "mx"], "rows": [], "observation_frames": []}, {}))
            fake.api.route("GET", "/v2/sessions/current/data/fields/m/samples/vector", (200, field_bytes, {}))
            fake.api.route("GET", "/v2/sessions/current/data/fields", (200, {"quantities": [{"quantity_id": "m", "source_step": 500, "source_time_seconds": 5e-11}]}, {}))
            fm.connect(fake.url, events=False)
            try:
                assert fm.m.average() == pytest.approx((2.75, 3.25, 3.75))
                assert math.isnan(float(fm.E_total))
                assert fm.live.active_session().latest_step().step == 500
            finally:
                fm.disconnect()


def test_accepted_runs_read_m_from_the_latest_observation_frame(monkeypatch) -> None:
    field_bytes = (Path(__file__).resolve().parent / "fixtures" / "fmvp" / "v4_live_explicit.bin").read_bytes()
    monkeypatch.delenv("FULLMAG_URL", raising=False)
    with fm.ExecutionContext():
        with FakeLiveSession() as fake:
            fake.api.route(
                "GET",
                "/v2/sessions/current/data/fields/m/samples/vector",
                (400, {"code": "bad_request", "message": "quantity 'm' is not requestable as a field vector: quantity_registry_not_resolved_plan"}, {}),
            )
            fake.api.route(
                "GET",
                "/v2/sessions/current/data/observation-frames",
                (200, {"frames": [{"frame_id": "frame-old", "status": "complete"}, {"frame_id": "frame-new", "status": "complete"}, {"frame_id": "frame-busy", "status": "pending"}]}, {}),
            )
            fake.api.route("GET", "/v2/sessions/current/data/observation-frames/frame-new/magnetization", (200, field_bytes, {}))
            fm.connect(fake.url, events=False)
            try:
                vector = fm.field("m")
                assert vector is not None and vector.quantity_id == "m"
                assert fake.api.find("GET", "/v2/sessions/current/data/observation-frames/frame-new/magnetization")
            finally:
                fm.disconnect()
