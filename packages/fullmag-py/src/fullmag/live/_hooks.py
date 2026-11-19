"""Synchronisation hooks of the live DSL mode (ADR 0068 D1, spec §5.2).

Every public DSL entry point (module function, handle attribute assignment or
handle method) runs inside :func:`dsl_call`.  A shared depth counter makes the
outermost call the only one that synchronises, so ``fm.geometry(...)`` that
internally sets ten handle attributes still produces one transaction.
"""
from __future__ import annotations

import contextvars
import functools
import inspect
from typing import Any, Callable, Iterable, Optional, TypeVar

__all__ = ["dsl_call", "install_handle_hooks", "synced"]

_F = TypeVar("_F", bound=Callable[..., Any])
_depth: contextvars.ContextVar[int] = contextvars.ContextVar("fullmag_live_dsl_depth", default=0)

# Set by fullmag.live once imported; returns the active session or None.
_active_session: Optional[Callable[[], Any]] = None


def bind_active_session(resolver: Callable[[], Any]) -> None:
    global _active_session
    _active_session = resolver


class dsl_call:
    """Context manager marking one DSL entry point; syncs when the outermost call exits cleanly."""

    __slots__ = ("_token",)

    def __enter__(self) -> "dsl_call":
        self._token = _depth.set(_depth.get() + 1)
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        depth = _depth.get()
        _depth.reset(self._token)
        if depth != 1 or exc_type is not None or _active_session is None:
            return
        session = _active_session()
        if session is not None:
            session.after_dsl_call()


def synced(function: _F) -> _F:
    """Wrap a DSL function so the live session synchronises after it returns."""
    if getattr(function, "__fullmag_live_synced__", False):
        return function

    @functools.wraps(function)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        with dsl_call():
            return function(*args, **kwargs)

    wrapper.__fullmag_live_synced__ = True  # type: ignore[attr-defined]
    return wrapper  # type: ignore[return-value]


def install_handle_hooks(classes: Iterable[type]) -> None:
    """Make public attribute assignment and public methods of handle classes synchronise."""
    for cls in classes:
        if cls.__dict__.get("__fullmag_live_hooks__"):
            continue
        original_setattr = cls.__setattr__

        def __setattr__(self: Any, name: str, value: Any, _original: Callable[..., None] = original_setattr) -> None:
            if name.startswith("_"):
                _original(self, name, value)
                return
            with dsl_call():
                _original(self, name, value)

        cls.__setattr__ = __setattr__  # type: ignore[method-assign]
        for name, member in list(cls.__dict__.items()):
            if name.startswith("_") or not inspect.isfunction(member):
                continue
            setattr(cls, name, synced(member))
        cls.__fullmag_live_hooks__ = True  # type: ignore[attr-defined]
