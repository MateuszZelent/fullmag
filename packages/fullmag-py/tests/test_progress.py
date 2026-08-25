from __future__ import annotations

from threading import Event
from unittest.mock import patch

import pytest

from fullmag._progress import indeterminate_progress_phase


def test_indeterminate_progress_phase_emits_heartbeat_without_fake_percent() -> None:
    events: list[dict[str, object]] = []
    heartbeat_seen = Event()

    def capture(payload: dict[str, object]) -> None:
        events.append(payload)
        if payload.get("status") == "heartbeat":
            heartbeat_seen.set()

    with patch("fullmag._progress.emit_progress_event", side_effect=capture):
        with indeterminate_progress_phase(
            phase="meshing",
            progress_label="extracting mesh nodes",
            message="Extracting mesh nodes",
            heartbeat_interval_s=0.01,
        ):
            assert heartbeat_seen.wait(0.5)

    assert [event["status"] for event in events[:2]] == ["started", "heartbeat"]
    assert events[-1]["status"] == "completed"
    assert all(event["kind"] == "mesh_build_phase" for event in events)
    assert all(event["progress_kind"] == "indeterminate" for event in events)
    assert all(event["progress_percent"] is None for event in events)


def test_indeterminate_progress_phase_stops_and_reports_failure() -> None:
    events: list[dict[str, object]] = []

    with patch("fullmag._progress.emit_progress_event", side_effect=events.append):
        with pytest.raises(RuntimeError, match="boom"):
            with indeterminate_progress_phase(
                phase="mesh_postprocessing",
                progress_label="serializing mesh",
                message="Serializing mesh",
                heartbeat_interval_s=0.01,
            ):
                raise RuntimeError("boom")

    assert events[-1]["status"] == "failed"
    assert events[-1]["progress_percent"] is None

