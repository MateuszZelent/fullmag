"""Live execution mode of the DSL (ADR 0068, spec python-live-client-v1 §2, §5).

``fm.connect()`` (or ``FULLMAG_URL``) turns the current process into a client of
a running Fullmag instance: every DSL call that changes the model is committed
to the session immediately, and actions (``fm.relax``, ``fm.run``) become
runtime commands.  Without a connection the DSL keeps its ``eager`` and
``capture`` behaviour unchanged.
"""
from __future__ import annotations

import contextlib
import os
from pathlib import Path
from typing import Any, Iterator, Optional

from fullmag.client import Client, URL_ENV_NAME
from fullmag.client.fmtb import TableRows
from fullmag.client.fmvp import FieldVector

from . import _hooks
from ._session import LiveCommandResult, LiveSession

__all__ = [
    "LiveCommandResult",
    "LiveModeError",
    "LiveSession",
    "active_session",
    "connect",
    "disconnect",
    "export_script",
    "field",
    "on",
    "pause",
    "paused",
    "require_session",
    "resume",
    "run_until",
    "skip",
    "stop",
    "sweep",
    "sync",
    "table",
    "transaction",
]


class LiveModeError(RuntimeError):
    """A DSL operation is not available, or not yet available, in live mode."""


def _world():
    from fullmag import world

    return world


def _capturing() -> bool:
    return bool(_world()._capture_binding.current().enabled)


def active_session() -> Optional[LiveSession]:
    """Return the live session bound to the current authoring context, if any.

    When none is bound and ``FULLMAG_URL`` is set, the first DSL call connects
    automatically (once per context).
    """
    if _capturing():
        return None
    state = _world()._state.current()
    session = state._live_session
    if session is None and os.environ.get(URL_ENV_NAME) and not state._live_auto_attempted:
        state._live_auto_attempted = True
        session = connect()
    if session is None or session.closed:
        return None
    return session


def require_session(operation: str) -> LiveSession:
    session = active_session()
    if session is None:
        raise LiveModeError(f"fm.{operation}() needs a live session; call fm.connect() or set {URL_ENV_NAME}")
    return session


def connect(
    url: Optional[str] = None,
    *,
    new_session: bool = False,
    backend: Optional[str] = None,
    token: Optional[str] = None,
    timeout: float = 30.0,
    retry_budget_s: float = 60.0,
    command_timeout: Optional[float] = None,
    source_path: Optional[str | Path] = None,
    events: bool = True,
) -> LiveSession:
    """Connect this process to a running Fullmag instance and switch the DSL to live mode.

    ``url`` defaults to ``$FULLMAG_URL`` and then the default DEV frontend origin.
    The current session is reused (one is created when none exists);
    ``new_session=True`` replaces it.  ``events`` starts the realtime stream so
    command waits wake on server events instead of polling.  The script owns the scene: the first
    complete world replaces the session's scene, later DSL calls patch it.
    """
    if _capturing():
        raise LiveModeError(
            "fm.connect() cannot run inside `fullmag script.py`; the script is captured into ProblemIR there. "
            "Run it with `python script.py` to drive a live session."
        )
    world = _world()
    state = world._state.current()
    previous = state._live_session
    if previous is not None and not previous.closed:
        previous.close()
    client = Client(url, timeout=timeout, token=token, retry_budget_s=retry_budget_s)
    session = LiveSession(
        client,
        state,
        source_path=Path(source_path).resolve() if source_path is not None else None,
        command_timeout=command_timeout,
    )
    state._live_session = session
    resolved_backend = backend or (state._backend if state._backend in {"fdm", "fem"} else "fdm")
    try:
        session.attach(new_session=new_session, backend=resolved_backend)
        if events:
            session.start_events()
    except BaseException:
        state._live_session = None
        session.close()
        raise
    return session


def disconnect() -> None:
    """Close the live session of this context; the DSL returns to eager mode."""
    state = _world()._state.current()
    session = state._live_session
    state._live_session = None
    if session is not None:
        session.close()


def sync(*, reconcile: bool = False) -> int:
    """Commit pending DSL changes.

    After a confirmed magnetization apply followed by a newer scene revision,
    use `reconcile=True` to keep other clients' edits and apply disjoint Python
    changes. Overlapping changes must be resolved in the local draft first.
    """
    return require_session("sync").sync(strict=True, reconcile=reconcile)


@contextlib.contextmanager
def transaction() -> Iterator[LiveSession]:
    """Group several DSL calls into one transaction."""
    with require_session("transaction").transaction() as session:
        yield session


@contextlib.contextmanager
def paused() -> Iterator[LiveSession]:
    """Pause the running stage, apply edits as one transaction, then resume."""
    with require_session("paused").paused() as session:
        yield session


def pause() -> LiveCommandResult:
    return require_session("pause").submit("pause")  # type: ignore[return-value]


def resume() -> LiveCommandResult:
    return require_session("resume").submit("resume")  # type: ignore[return-value]


def stop() -> LiveCommandResult:
    return require_session("stop").submit("stop")  # type: ignore[return-value]


def skip() -> LiveCommandResult:
    return require_session("skip").submit("skip")  # type: ignore[return-value]


def field(quantity_id: str, **query: Any) -> Optional[FieldVector]:
    """Read the current samples of a field (e.g. ``"m"``) from the live session."""
    return require_session("field").field(quantity_id, **query)


def table(table_id: str, *, columns: Optional[tuple[str, ...]] = None, **query: Any) -> TableRows:
    return require_session("table").table(table_id, columns=columns, **query)


def on(event_type: str, callback: Any) -> Any:
    """Subscribe ``callback(event)`` to realtime events (``"scalar.sample"``,
    ``"resource.batch_changed"``, ``"*"``); returns a subscription with ``cancel()``."""
    return require_session("on").on(event_type, callback)


def run_until(
    predicate: Any,
    *,
    chunk_time: float,
    max_time: Optional[float] = None,
    max_chunks: Optional[int] = None,
) -> Optional[LiveCommandResult]:
    """Run in chunks until ``predicate(step)`` holds; ``step`` exposes the newest scalars."""
    session = require_session("run_until")
    stage_index = _world()._append_live_loop_stage(relax=False, chunk_time=float(chunk_time))
    return session.run_until(
        predicate, chunk_time=chunk_time, max_time=max_time, max_chunks=max_chunks, stage_index=stage_index
    )


def sweep(function: Any, **kwargs: Any) -> Any:
    """Run ``function(**point)`` for every point across several groups (see :mod:`fullmag.live.sweep`)."""
    from .sweep import sweep as _sweep

    return _sweep(function, **kwargs)


def export_script() -> str:
    """Return the session rendered as a canonical Fullmag Python script."""
    return require_session("export_script").export_script()


_hooks.bind_active_session(active_session)
