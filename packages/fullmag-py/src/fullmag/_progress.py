from __future__ import annotations

from contextlib import contextmanager
import json
import os
import sys
from threading import Event, Thread
import time
from typing import Iterator


PROGRESS_PREFIX = "[fullmag-progress]"
PROGRESS_JSON_PREFIX = "json:"


def emit_progress(message: str) -> None:
    if os.environ.get("FULLMAG_PROGRESS", "").lower() not in {"1", "true", "yes", "on"}:
        return
    print(f"{PROGRESS_PREFIX} {message}", file=sys.stderr, flush=True)


def emit_progress_event(payload: dict[str, object]) -> None:
    if os.environ.get("FULLMAG_PROGRESS", "").lower() not in {"1", "true", "yes", "on"}:
        return
    print(
        f"{PROGRESS_PREFIX} {PROGRESS_JSON_PREFIX}{json.dumps(payload, separators=(',', ':'))}",
        file=sys.stderr,
        flush=True,
    )
@contextmanager
def indeterminate_progress_phase(
    *,
    phase: str,
    progress_label: str,
    message: str,
    heartbeat_interval_s: float = 15.0,
) -> Iterator[None]:
    if heartbeat_interval_s <= 0.0:
        raise ValueError("heartbeat_interval_s must be positive")

    started_at = time.monotonic()
    stop = Event()

    def emit(status: str) -> None:
        elapsed_s = max(0.0, time.monotonic() - started_at)
        event_message = (
            message
            if status == "started"
            else f"{message} ({elapsed_s:.1f}s elapsed)"
        )
        emit_progress_event(
            {
                "kind": "mesh_build_phase",
                "phase": phase,
                "status": status,
                "progress_kind": "indeterminate",
                "progress_percent": None,
                "progress_label": progress_label,
                "message": event_message,
            }
        )

    def heartbeat() -> None:
        while not stop.wait(heartbeat_interval_s):
            emit("heartbeat")

    emit("started")
    thread = Thread(
        target=heartbeat,
        name=f"fullmag-progress-{phase}",
        daemon=True,
    )
    thread.start()
    failed = False
    try:
        yield
    except BaseException:
        failed = True
        raise
    finally:
        stop.set()
        thread.join()
        emit("failed" if failed else "completed")
