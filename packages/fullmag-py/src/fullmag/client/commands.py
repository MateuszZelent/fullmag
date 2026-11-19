"""Runtime command submission targets and completion handles (spec §4.4)."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Mapping, Optional

from .errors import CommandFailedError, CommandTimeoutError

if TYPE_CHECKING:
    from .client import Client

__all__ = ["CommandHandle", "Target", "new_intent_id"]

TERMINAL_STATUSES = frozenset({"completed", "rejected", "failed"})
SUCCESSFUL_COMPLETIONS = frozenset({"succeeded", "completed"})
_POLL_INITIAL_S = 0.05
_POLL_MAX_S = 1.0


def new_intent_id() -> str:
    """Return a fresh ``client_intent_id`` that makes resubmission idempotent."""
    return f"py-{uuid.uuid4().hex}"


class Target:
    """Factories for ``RuntimeCommandTarget`` values."""

    @staticmethod
    def study() -> dict[str, Any]:
        return {"kind": "study"}

    @staticmethod
    def run(run_id: Optional[str] = None) -> dict[str, Any]:
        return {"kind": "run"} if run_id is None else {"kind": "run", "run_id": run_id}

    @staticmethod
    def current_stage(stage_id: Optional[str] = None) -> dict[str, Any]:
        return {"kind": "current_stage"} if stage_id is None else {"kind": "current_stage", "stage_id": stage_id}

    @staticmethod
    def stage_index(index: int) -> dict[str, Any]:
        if index < 0:
            raise ValueError("stage index must be non-negative")
        return {"kind": "stage_index", "stage_index": int(index)}

    @staticmethod
    def stage_id(stage_id: str) -> dict[str, Any]:
        return {"kind": "stage_id", "stage_id": stage_id}

    @staticmethod
    def command(command_id: str) -> dict[str, Any]:
        return {"kind": "command_id", "command_id": command_id}


@dataclass
class CommandHandle:
    """A submitted runtime command; :meth:`wait` blocks until it is terminal."""

    client: "Client"
    command_id: str
    kind: str
    client_intent_id: Optional[str] = None
    detail: Mapping[str, Any] = field(default_factory=dict)
    clock: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep

    @property
    def status(self) -> str:
        return str(self.detail.get("status") or "queued")

    @property
    def done(self) -> bool:
        return self.status in TERMINAL_STATUSES

    def refresh(self) -> Mapping[str, Any]:
        self.detail = self.client.commands.get(self.command_id)
        return self.detail

    def wait(self, timeout: Optional[float] = None, *, raise_on_failure: bool = True) -> Mapping[str, Any]:
        """Poll the command until it is terminal and return its detail resource.

        Raises :class:`CommandFailedError` for rejected/failed/cancelled commands
        unless ``raise_on_failure`` is false, and :class:`CommandTimeoutError`
        when ``timeout`` seconds pass first.
        """
        deadline = None if timeout is None else self.clock() + timeout
        delay = _POLL_INITIAL_S
        waiter = getattr(self.client, "command_waiter", None)
        while True:
            self.refresh()
            if self.done:
                break
            if deadline is not None and self.clock() >= deadline:
                raise CommandTimeoutError(self.command_id, self.kind, self.status, float(timeout or 0.0))
            pause = delay if deadline is None else max(0.0, min(delay, deadline - self.clock()))
            if waiter is not None:
                waiter(self.command_id, pause)
            else:
                self.sleep(pause)
            delay = min(delay * 2, _POLL_MAX_S)
        if raise_on_failure:
            self.raise_for_failure()
        return self.detail

    def raise_for_failure(self) -> None:
        completion = self.detail.get("completion_status")
        failed = self.status in {"rejected", "failed"} or (
            completion is not None and str(completion) not in SUCCESSFUL_COMPLETIONS
        )
        if failed:
            raise CommandFailedError(
                self.command_id,
                self.kind,
                self.status,
                None if completion is None else str(completion),
                _optional_str(self.detail.get("error")),
            )


def _optional_str(value: Any) -> Optional[str]:
    return None if value is None else str(value)
