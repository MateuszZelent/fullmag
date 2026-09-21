"""Durable host-local service loop for the single heavy-job runner.

The service is deliberately an adapter around injected queue and executor
callbacks.  It owns process lifetime and recovery policy, while the existing
coordinator remains responsible for queue leases and Docker identity checks.
There is no network listener and no PID-based termination path.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import socket
import threading
import time
import uuid

from fullmag_storage import StorageError, atomic_json, file_lock


SERVICE_SCHEMA = "fullmag.local-runner.service.v1"
STOP_SCHEMA = "fullmag.local-runner.stop-request.v1"
_MAX_ERROR_LENGTH = 2000
_MAX_REASON_LENGTH = 1000


class ServiceError(RuntimeError):
    """The service could not validate or persist its host-owned state."""


class ServiceBusy(ServiceError):
    """Another service instance owns the process lock."""


def _absolute_path(value: Path | str, label: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise ServiceError(f"{label} must be an absolute path")
    if path.is_symlink():
        raise ServiceError(f"{label} must not be a symlink")
    return path


def _timestamp(clock: Callable[[], float]) -> str:
    return datetime.fromtimestamp(float(clock()), timezone.utc).isoformat()


def _read_json(path: Path, label: str) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ServiceError(f"Cannot read {label}: {path}") from error
    if not isinstance(value, dict):
        raise ServiceError(f"{label} must contain a JSON object: {path}")
    return value


def _validate_reason(reason: str) -> str:
    if not isinstance(reason, str):
        raise ServiceError("Stop reason must be text")
    value = reason.strip()
    if not value or len(value) > _MAX_REASON_LENGTH:
        raise ServiceError("Stop reason must contain 1..1000 characters")
    return value


@dataclass(frozen=True)
class ServicePaths:
    """Exact host-owned paths used by one runner service installation."""

    state_path: Path
    lock_path: Path
    stop_request_path: Path

    def __post_init__(self) -> None:
        state = _absolute_path(self.state_path, "service state path")
        lock = _absolute_path(self.lock_path, "service lock path")
        stop = _absolute_path(self.stop_request_path, "stop request path")
        if len({state, lock, stop}) != 3:
            raise ServiceError("Service state, lock and stop paths must be distinct")
        object.__setattr__(self, "state_path", state)
        object.__setattr__(self, "lock_path", lock)
        object.__setattr__(self, "stop_request_path", stop)

    @classmethod
    def from_storage(cls, storage_root: Path | str) -> "ServicePaths":
        root = _absolute_path(storage_root, "storage root")
        return cls(
            state_path=root / "index" / "local-runner-service.json",
            lock_path=root / "locks" / "local-runner-service.lock",
            stop_request_path=root / "index" / "local-runner-service.stop.json",
        )

    @property
    def status_path(self) -> Path:
        """Compatibility spelling for callers that call the record status."""
        return self.state_path


def _coerce_stop_path(
    paths: ServicePaths | Path | str | None,
    stop_request_path: Path | str | None,
) -> Path:
    if stop_request_path is not None:
        target = stop_request_path
    elif isinstance(paths, ServicePaths):
        target = paths.stop_request_path
    elif paths is not None:
        # A bare path is intentionally interpreted as the exact stop marker,
        # not as a storage root.  ServicePaths.from_storage is the safe
        # convenience for storage-root callers.
        target = paths
    else:
        raise ServiceError("Provide ServicePaths or stop_request_path")
    return _absolute_path(target, "stop request path")


def read_stop_request(
    paths: ServicePaths | Path | str | None = None,
    *,
    stop_request_path: Path | str | None = None,
) -> dict | None:
    """Read the durable stop marker without changing it."""

    target = _coerce_stop_path(paths, stop_request_path)
    if not target.exists():
        return None
    request = _read_json(target, "stop request")
    if request.get("schema") != STOP_SCHEMA or not isinstance(request.get("requested"), bool):
        raise ServiceError(f"Invalid stop request schema: {target}")
    return request if request["requested"] else None


def request_stop(
    paths: ServicePaths | Path | str | None = None,
    *,
    stop_request_path: Path | str | None = None,
    reason: str = "operator requested a graceful stop",
    clock: Callable[[], float] = time.time,
    requested_by: str | None = None,
) -> dict:
    """Persist a graceful-stop request without touching the service PID."""

    target = _coerce_stop_path(paths, stop_request_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "schema": STOP_SCHEMA,
        "requested": True,
        "request_id": uuid.uuid4().hex,
        "requested_at": _timestamp(clock),
        "reason": _validate_reason(reason),
        "requested_by": requested_by or f"{socket.gethostname()}:{os.getpid()}",
    }
    atomic_json(target, record)
    return record


def clear_stop_request(
    paths: ServicePaths | Path | str | None = None,
    *,
    stop_request_path: Path | str | None = None,
    reason: str = "operator resumed the service",
    clock: Callable[[], float] = time.time,
) -> dict:
    """Record that a previous graceful-stop request has been cleared."""

    target = _coerce_stop_path(paths, stop_request_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "schema": STOP_SCHEMA,
        "requested": False,
        "request_id": uuid.uuid4().hex,
        "requested_at": None,
        "cleared_at": _timestamp(clock),
        "reason": _validate_reason(reason),
        "requested_by": f"{socket.gethostname()}:{os.getpid()}",
    }
    atomic_json(target, record)
    return record


class RunnerService:
    """Run one trusted local coordinator callback at a time.

    ``active`` returns the queue's currently running or cancel-requested
    leases.  ``reconcile`` receives that snapshot and may perform the exact
    coordinator reconciliation.  The service reads ``active`` again after
    reconciliation; a callback result is never treated as proof that a lease
    ended.  ``execute`` is called only after that second read is empty.

    Callback failures are retained in the status record and followed by the
    configured interval.  This keeps a broken Docker/queue dependency from
    becoming a busy loop.  A stop request prevents a new callback but is
    honoured only after an active lease has become terminal.
    """

    def __init__(
        self,
        *,
        execute: Callable[[], object],
        active: Callable[[], Sequence[Mapping[str, object]] | Sequence[object] | None] | None = None,
        active_jobs: Callable[[], Sequence[Mapping[str, object]] | Sequence[object] | None] | None = None,
        reconcile: Callable[[Sequence[object]], object] | None = None,
        paths: ServicePaths | None = None,
        state_path: Path | str | None = None,
        lock_path: Path | str | None = None,
        stop_request_path: Path | str | None = None,
        interval_seconds: float = 5.0,
        heartbeat_interval_seconds: float | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.time,
        host: str | None = None,
        pid: int | None = None,
        instance_id: str | None = None,
    ) -> None:
        if not callable(execute):
            raise TypeError("execute must be callable")
        active_callback = active if active is not None else active_jobs
        if not callable(active_callback):
            raise TypeError("active must be callable")
        if reconcile is not None and not callable(reconcile):
            raise TypeError("reconcile must be callable")
        try:
            interval = float(interval_seconds)
        except (TypeError, ValueError) as error:
            raise ServiceError("Interval must be a finite value in (0, 3600]") from error
        if not math.isfinite(interval) or not 0 < interval <= 3600:
            raise ServiceError("Interval must be a finite value in (0, 3600]")
        heartbeat_interval = interval / 2 if heartbeat_interval_seconds is None else heartbeat_interval_seconds
        try:
            heartbeat_interval = float(heartbeat_interval)
        except (TypeError, ValueError) as error:
            raise ServiceError("Heartbeat interval must be a finite value in (0, 3600]") from error
        if not math.isfinite(heartbeat_interval) or not 0 < heartbeat_interval <= 3600:
            raise ServiceError("Heartbeat interval must be a finite value in (0, 3600]")
        # A long polling interval must not turn the durable heartbeat into a
        # stale liveness signal while a build callback is running.
        heartbeat_interval = min(heartbeat_interval, 30.0)
        if paths is not None and any(value is not None for value in (state_path, lock_path, stop_request_path)):
            raise ServiceError("Use paths or explicit service paths, not both")
        if paths is None:
            if state_path is None or lock_path is None or stop_request_path is None:
                raise ServiceError("Provide paths or state_path, lock_path and stop_request_path")
            paths = ServicePaths(state_path, lock_path, stop_request_path)
        self.paths = paths
        self.execute = execute
        self.active = active_callback
        self.reconcile = reconcile or self._missing_reconcile
        self.interval_seconds = interval
        self.heartbeat_interval_seconds = heartbeat_interval
        self.sleep = sleep
        self.clock = clock
        self.host = host or socket.gethostname()
        self.pid = int(pid if pid is not None else os.getpid())
        self.instance_id = instance_id or uuid.uuid4().hex
        self._status: dict[str, object] = {}
        self._status_lock = threading.RLock()

    @staticmethod
    def _missing_reconcile(_jobs: Sequence[object]) -> None:
        raise ServiceError("Active lease requires an injected reconcile callback")

    @staticmethod
    def clear_stop_request(
        paths: ServicePaths | Path | str | None = None,
        *,
        stop_request_path: Path | str | None = None,
        reason: str = "operator resumed the service",
        clock: Callable[[], float] = time.time,
    ) -> dict:
        return clear_stop_request(paths, stop_request_path=stop_request_path, reason=reason, clock=clock)

    def _prepare_paths(self) -> None:
        for path in (self.paths.state_path, self.paths.lock_path, self.paths.stop_request_path):
            if path.is_symlink():
                raise ServiceError(f"Service path must not be a symlink: {path}")
            path.parent.mkdir(parents=True, exist_ok=True)

    def _write_status(self, **updates: object) -> dict:
        with self._status_lock:
            self._status.update(updates)
            self._status["heartbeat_at"] = _timestamp(self.clock)
            snapshot = dict(self._status)
            atomic_json(self.paths.state_path, snapshot)
            return snapshot

    def _heartbeat_tick(self) -> None:
        """Persist liveness while an injected callback occupies the worker."""

        with self._status_lock:
            self._status["heartbeat_at"] = _timestamp(self.clock)
            atomic_json(self.paths.state_path, dict(self._status))

    def _heartbeat_loop(self, stop_event: threading.Event) -> None:
        while not stop_event.wait(self.heartbeat_interval_seconds):
            try:
                self._heartbeat_tick()
            except Exception as error:
                # The foreground loop will persist the error at its next
                # state transition.  Do not let a heartbeat-only write error
                # terminate the build callback or create a second worker.
                self._record_error(error)

    def _call_with_heartbeat(self, callback: Callable[..., object], *args: object) -> object:
        stop_event = threading.Event()
        heartbeat = threading.Thread(
            target=self._heartbeat_loop,
            args=(stop_event,),
            name="runner-heartbeat",
            daemon=True,
        )
        heartbeat.start()
        try:
            return callback(*args)
        finally:
            stop_event.set()
            heartbeat.join()

    def _read_stop_request(self) -> dict | None:
        path = self.paths.stop_request_path
        if not path.exists():
            return None
        request = _read_json(path, "stop request")
        if request.get("schema") != STOP_SCHEMA or not isinstance(request.get("requested"), bool):
            raise ServiceError(f"Invalid stop request schema: {path}")
        return request if request["requested"] else None

    def _refresh_stop(self, stop_event: object | None) -> bool:
        request = self._read_stop_request()
        event_requested = bool(stop_event is not None and stop_event.is_set())
        with self._status_lock:
            if request is not None:
                self._status.update(
                    stop_requested=True,
                    stop_request=request,
                    stop_requested_at=request.get("requested_at"),
                    stop_reason=request.get("reason"),
                )
            elif event_requested:
                self._status.update(
                    stop_requested=True,
                    stop_request=None,
                    stop_requested_at=self._status.get("stop_requested_at") or _timestamp(self.clock),
                    stop_reason=self._status.get("stop_reason") or "in-process stop requested",
                )
            else:
                self._status.update(stop_requested=False, stop_request=None, stop_requested_at=None, stop_reason=None)
        return bool(request is not None or event_requested)

    def _read_active(self) -> list[object]:
        value = self.active()
        if value is None:
            return []
        if isinstance(value, Mapping):
            return [value]
        try:
            return list(value)
        except TypeError as error:
            raise ServiceError("active callback must return a sequence or None") from error

    @staticmethod
    def _job_ids(jobs: Sequence[object]) -> list[str]:
        result = []
        for item in jobs[:32]:
            if isinstance(item, Mapping):
                value = item.get("job_id")
            else:
                value = item
            if isinstance(value, str) and value:
                result.append(value[:160])
        return result

    @staticmethod
    def _result_summary(result: object) -> object:
        if result is None or isinstance(result, (str, int, float, bool)):
            return result
        if isinstance(result, Mapping):
            allowed = ("job_id", "state", "exit_code", "operation", "profile")
            return {
                key: result[key]
                for key in allowed
                if key in result and isinstance(result[key], (str, int, float, bool, type(None)))
            }
        return repr(result)[:_MAX_ERROR_LENGTH]

    def _record_error(self, error: Exception) -> None:
        message = f"{type(error).__name__}: {error}"[:_MAX_ERROR_LENGTH]
        with self._status_lock:
            self._status["last_error"] = message
            self._status["last_error_at"] = _timestamp(self.clock)
            self._status["error_count"] = int(self._status.get("error_count", 0)) + 1

    def _wait(self) -> None:
        self._write_status(waiting_until=_timestamp(lambda: self.clock() + self.interval_seconds))
        self.sleep(self.interval_seconds)

    def _finish(self, reason: str) -> dict:
        with self._status_lock:
            self._status.update(state="stopped", stop_reason=reason, finished_at=_timestamp(self.clock))
        return self._write_status()

    def _initial_status(self) -> dict:
        previous = None
        if self.paths.state_path.exists():
            previous = _read_json(self.paths.state_path, "service state")
            if previous.get("schema") != SERVICE_SCHEMA:
                raise ServiceError(f"Invalid service state schema: {self.paths.state_path}")
        state: dict[str, object] = {
            "schema": SERVICE_SCHEMA,
            "instance_id": self.instance_id,
            "pid": self.pid,
            "host": self.host,
            "started_at": _timestamp(self.clock),
            "heartbeat_at": None,
            "state": "starting",
            "stop_requested": False,
            "stop_request": None,
            "stop_requested_at": None,
            "stop_reason": None,
            "active_job_ids": [],
            "last_result": None,
            "last_error": None,
            "last_error_at": None,
            "error_count": 0,
        }
        if previous and previous.get("state") not in ("stopped", "failed"):
            state["recovered_instance_id"] = previous.get("instance_id")
            state["recovered_state"] = previous.get("state")
        return state

    def run(self, *, stop_event: object | None = None, max_iterations: int | None = None) -> dict:
        """Run until a graceful stop is requested, returning the final status."""

        if max_iterations is not None and (not isinstance(max_iterations, int) or max_iterations < 1):
            raise ServiceError("max_iterations must be a positive integer")
        self._prepare_paths()
        try:
            lock_context = file_lock(self.paths.lock_path, "local runner service")
            with lock_context:
                self._status = self._initial_status()
                self._write_status()
                iterations = 0
                while True:
                    iterations += 1
                    try:
                        stop_requested = self._refresh_stop(stop_event)
                        active_jobs = self._read_active()
                    except Exception as error:
                        self._record_error(error)
                        self._write_status(state="error")
                        self._wait()
                        continue

                    if active_jobs:
                        self._write_status(
                            state="stopping" if stop_requested else "reconciling",
                            active_job_ids=self._job_ids(active_jobs),
                        )
                        try:
                            self._call_with_heartbeat(self.reconcile, active_jobs)
                            remaining = self._read_active()
                        except Exception as error:
                            self._record_error(error)
                            self._write_status(state="error", active_job_ids=self._job_ids(active_jobs))
                            self._wait()
                            continue
                        if remaining:
                            self._write_status(
                                state="stopping" if self._refresh_stop(stop_event) else "reconciling",
                                active_job_ids=self._job_ids(remaining),
                            )
                            self._wait()
                            continue
                        stop_requested = self._refresh_stop(stop_event)
                        if stop_requested:
                            return self._finish("active lease reconciled; stop requested")

                    stop_requested = self._refresh_stop(stop_event)
                    if stop_requested:
                        return self._finish("stop requested")

                    self._write_status(state="running", active_job_ids=[])
                    try:
                        result = self._call_with_heartbeat(self.execute)
                        with self._status_lock:
                            self._status["last_result"] = self._result_summary(result)
                            if isinstance(result, Mapping) and isinstance(result.get("job_id"), str):
                                self._status["last_job_id"] = result["job_id"]
                        self._write_status(state="idle")
                    except Exception as error:
                        self._record_error(error)
                        self._write_status(state="error")

                    # A request arriving while the callback was running is
                    # observed before the interval sleep.  The callback has
                    # already returned (or failed), so stopping here is
                    # graceful and does not interrupt a job in flight.
                    try:
                        stop_after_callback = self._refresh_stop(stop_event)
                    except Exception as error:
                        self._record_error(error)
                        self._write_status(state="error")
                        stop_after_callback = False
                    if stop_after_callback:
                        return self._finish("stop requested after callback")

                    if max_iterations is not None and iterations >= max_iterations:
                        return self._finish("iteration limit reached")
                    # Errors also sleep, so a broken callback cannot spin.
                    self._wait()
        except StorageError as error:
            if "Storage is busy:" in str(error):
                raise ServiceBusy(str(error)) from error
            raise ServiceError(str(error)) from error


__all__ = [
    "SERVICE_SCHEMA",
    "STOP_SCHEMA",
    "RunnerService",
    "ServiceBusy",
    "ServiceError",
    "ServicePaths",
    "clear_stop_request",
    "read_stop_request",
    "request_stop",
]
