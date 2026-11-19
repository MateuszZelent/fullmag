"""One live connection between a Python process and a running Fullmag session."""
from __future__ import annotations

import contextlib
import logging
import math
import sys
import threading
import time
import uuid
from types import SimpleNamespace
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterator, Mapping, Optional
from urllib.parse import quote

from fullmag.client import ApiError, Client, CommandHandle, NotFoundError, Target
from fullmag.client.events import EventStream, LiveEvent, Subscription
from fullmag.client.fmtb import TableRows
from fullmag.client.fmvp import FieldVector
from fullmag.model.structure import MagnetizationAssignment

from ._scene import (
    SceneNotReady, build_world_scene, magnetization_scope_texture, plan_transactions,
    reconcile_scene_changes,
)

if TYPE_CHECKING:
    from fullmag.world import CapturedStage

__all__ = ["LiveCommandResult", "LiveSession"]

_LOG = logging.getLogger("fullmag.live")
_SESSION_DEFAULTS = {"device": "cpu", "precision": "double"}
# Presence heartbeat period; the API lists clients for 30 s after the last one.
_HEARTBEAT_INTERVAL_S = 10.0
_STAGE_TARGET = Target.current_stage()
# Mirrors the API's read-only terminal session states.
_TERMINAL_SESSION_STATUSES = frozenset({"stopping", "stopped", "cancelled", "failed", "completed", "closed"})


@dataclass
class LiveCommandResult:
    """What ``fm.relax()``/``fm.run()`` return in live mode."""

    command_id: str
    kind: str
    status: str
    completion_status: Optional[str]
    detail: Mapping[str, Any] = field(repr=False, default_factory=dict)

    @classmethod
    def from_handle(cls, handle: CommandHandle) -> "LiveCommandResult":
        detail = handle.detail
        completion = detail.get("completion_status")
        return cls(handle.command_id, handle.kind, handle.status, None if completion is None else str(completion), detail)


class LiveSession:
    """Synchronises the DSL world of this process with the server's current session."""

    def __init__(
        self,
        client: Client,
        state: Any,
        *,
        source_path: Optional[Path] = None,
        command_timeout: Optional[float] = None,
    ) -> None:
        self.client = client
        self.state = state
        self.source_path = source_path or _default_source_path()
        self.command_timeout = command_timeout
        self.baseline: Optional[dict[str, Any]] = None
        self.revision: Optional[int] = None
        self.pending = False
        self.closed = False
        self._batch_depth = 0
        self._stage_magnetization_assignments: list[MagnetizationAssignment] = []
        self._magnetization_apply_scopes: dict[tuple[str, str | None], None] = {}
        self._pending_magnetization_apply: tuple[dict[str, Any], dict[str, Any]] | None = None
        self._reconcile_required = False
        self._reconciled_scene: Mapping[str, Any] | None = None
        self.transactions_committed = 0
        self.events: Optional[EventStream] = None
        self.client_id = f"python-{uuid.uuid4().hex[:12]}"
        self._heartbeat_stop = threading.Event()
        self._heartbeat_thread: Optional[threading.Thread] = None

    # ---- lifecycle -------------------------------------------------------

    def attach(self, *, new_session: bool, backend: str) -> None:
        """Bind to the current server session, creating one when needed."""
        try:
            current = None if new_session else self.client.sessions.current()
        except NotFoundError:
            current = None
        # A terminal session rejects every mutating command, so a script
        # starts a fresh one instead of attaching to it.
        terminal = isinstance(current, Mapping) and current.get("status") in _TERMINAL_SESSION_STATUSES
        if current is None or terminal:
            self.client.sessions.create(
                "fullmag-python-live",
                backend=backend,
                replace_current=new_session or terminal,
                **_SESSION_DEFAULTS,
            )
        status = self.client.sessions.status()
        identity = status.get("session", {})
        keys = (
            ("session", "session_id"),
            ("epoch", "session_epoch"),
            ("request_scope_epoch", "request_scope_epoch"),
        )
        if all(isinstance(identity.get(field), str) and identity[field] for _, field in keys):
            self.client.session_scope = "&".join(
                f"{key}=" + quote(identity[field], safe="-_.!~*'()")
                for key, field in keys
            )
        scene = self.client.model.scene()
        self.revision = _revision_of(scene)
        self._start_presence()
        # The script owns the scene: the first buildable world replaces it.
        self.baseline = None
        self.sync(strict=False)

    def close(self) -> None:
        self.closed = True
        self._stop_presence()
        if self.events is not None:
            self.events.close()
            self.events = None
        self.client.command_waiter = None
        self.client.close()

    def _start_presence(self) -> None:
        """Heartbeat presence so the Control Room shows that a script drives the session."""
        label = self.source_path.name

        def beat() -> None:
            while not self._heartbeat_stop.is_set():
                try:
                    self.client.sessions.heartbeat(self.client_id, label=label)
                except Exception as error:  # presence is informational and must not break the script
                    _LOG.debug("presence heartbeat failed: %s", error)
                self._heartbeat_stop.wait(_HEARTBEAT_INTERVAL_S)

        self._heartbeat_thread = threading.Thread(target=beat, name="fullmag-live-presence", daemon=True)
        self._heartbeat_thread.start()

    def _stop_presence(self) -> None:
        if self._heartbeat_thread is None:
            return
        self._heartbeat_stop.set()
        self._heartbeat_thread.join(timeout=2.0)
        self._heartbeat_thread = None
        try:
            self.client.sessions.leave(self.client_id)
        except Exception as error:
            _LOG.debug("presence leave failed: %s", error)

    def start_events(self) -> EventStream:
        """Start the realtime event stream; command waits then wake on events."""
        if self.events is None:
            self.events = EventStream(self.client.url).start()
            self.client.command_waiter = lambda _command_id, pause: self.events.wait_for_change(pause) if self.events else time.sleep(pause)
        return self.events

    def on(self, event_type: str, callback: Any) -> Subscription:
        """Call ``callback(event)`` for each realtime event of ``event_type`` (``"*"`` = all)."""
        return self.start_events().subscribe(event_type, callback)

    def __repr__(self) -> str:
        return f"LiveSession({self.client.url!r}, revision={self.revision}, pending={self.pending})"

    # ---- synchronisation -------------------------------------------------

    def after_dsl_call(self) -> None:
        if self.closed:
            return
        if self._batch_depth:
            self.pending = True
            return
        self.sync(strict=False)

    def sync(self, *, strict: bool = True, reconcile: bool = False) -> int:
        """Commit the difference between the world and the session; return transactions sent.

        With ``strict=False`` an incomplete world (e.g. a magnet without ``Ms``)
        is kept pending and sent by a later call; actions use ``strict=True``.
        """
        sent = self._commit_pending_magnetization_apply()
        if self._reconcile_required and not reconcile:
            if strict:
                raise self._magnetization_apply_conflict()
            return sent
        try:
            scene = build_world_scene(self.source_path)
        except SceneNotReady as error:
            self.pending = True
            if strict:
                raise RuntimeError(f"the live scene is incomplete: {error}") from error
            _LOG.debug("live sync deferred: %s", error)
            return sent
        previous = self._reconciled_scene
        candidate = scene
        revision = self.revision
        if reconcile:
            if not self._reconcile_required and previous is None:
                raise ValueError("scene reconciliation requires a magnetization apply conflict")
            previous = self.client.model.scene()
            revision = _revision_of(previous)
            if revision is None or self.revision is None or revision < self.revision:
                raise RuntimeError("scene reconciliation requires a current scene revision")
            if self._reconcile_required and revision == self.revision:
                raise RuntimeError("scene reconciliation requires the newer scene revision")
        if previous is not None:
            if self.baseline is None:
                raise RuntimeError("scene reconciliation requires a local committed baseline")
            candidate = reconcile_scene_changes(self.baseline, scene, previous)
            scopes = self._magnetization_apply_scopes.keys() | {
                (assignment.object_id, assignment.region_id)
                for assignment in self._stage_magnetization_assignments
            }
            for object_id, region_id in scopes:
                if (magnetization_scope_texture(scene, object_id, region_id)
                        != magnetization_scope_texture(candidate, object_id, region_id)):
                    raise ValueError("magnetization apply texture changed in the current scene; align the local draft")
            self._reconciled_scene = previous
            self.revision = revision
            self._reconcile_required = False
        if self._magnetization_apply_scopes and self.baseline is not None:
            if not self.client.session_scope:
                raise RuntimeError("applying magnetization requires a current workspace identity")
            request = {
                "operation_id": uuid.uuid4().hex,
                "scopes": [
                    {"object_id": object_id, "region_id": region_id}
                    for object_id, region_id in self._magnetization_apply_scopes
                ],
            }
            transaction, = plan_transactions(
                previous if previous is not None else self.baseline,
                candidate, revision, magnetization_apply=request,
            )
            self._pending_magnetization_apply = (transaction, scene)
            self._magnetization_apply_scopes.clear()
            return sent + self._commit_pending_magnetization_apply()

        transactions = plan_transactions(
            previous if previous is not None else self.baseline, candidate, revision,
        )
        for index, transaction in enumerate(transactions):
            if index and self.revision is not None:
                transaction["base_revision"] = self.revision
            response = self.client.model.commit(transaction)
            self.revision = int(response["scene_revision"])
            if previous is not None:
                self._reconciled_scene = response["committed_scene"]
            self.transactions_committed += 1
        self.baseline = scene
        self.pending = False
        return sent + len(transactions)

    def _commit_pending_magnetization_apply(self) -> int:
        pending = self._pending_magnetization_apply
        if pending is None:
            return 0
        transaction, local_scene = pending
        self.pending = True
        operation_id = transaction["magnetization_apply"]["operation_id"]
        try:
            response = self.client.model.commit(transaction, idempotency_key=operation_id)
        except ApiError as error:
            if error.status != 409 or error.code != "magnetization_apply_scene_advanced":
                raise
            # The server recognizes this exact operation as committed at base + 1.
            self._record_magnetization_apply(local_scene, transaction["base_revision"] + 1)
            self._reconcile_required = self.pending = True
            raise self._magnetization_apply_conflict() from error
        revision = response.get("scene_revision")
        receipt = response.get("magnetization_apply")
        if (response.get("transaction_kind") != "apply_magnetization"
                or not isinstance(receipt, Mapping)
                or receipt.get("operation_id") != operation_id
                or type(revision) is not int
                or revision != transaction["base_revision"] + 1):
            raise RuntimeError("server did not acknowledge the exact magnetization apply")
        if self._reconciled_scene is not None:
            self._reconciled_scene = response["committed_scene"]
        self._record_magnetization_apply(local_scene, revision)
        return 1

    def _record_magnetization_apply(self, local_scene: dict[str, Any], revision: int) -> None:
        self.revision = revision
        if self.baseline is not None:
            self.baseline = local_scene
        self._pending_magnetization_apply = None
        self.transactions_committed += 1
        self.pending = False

    @staticmethod
    def _magnetization_apply_conflict() -> ApiError:
        return ApiError(
            409, "magnetization_apply_scene_advanced",
            "The magnetization apply committed before another client changed the scene. "
            "Review the current scene and call fm.sync(reconcile=True).",
        )

    @contextlib.contextmanager
    def transaction(self) -> Iterator["LiveSession"]:
        """Group DSL calls into one synchronisation (one revision for one change set)."""
        self._batch_depth += 1
        try:
            yield self
        finally:
            self._batch_depth -= 1
        if self._batch_depth == 0:
            self.sync(strict=False)

    # ---- runtime commands -----------------------------------------------

    def reset_authored_world(self, state: Any) -> None:
        self.state = state
        if not self._reconcile_required and self._pending_magnetization_apply is None:
            self.baseline = None
            self._reconciled_scene = None
        self._stage_magnetization_assignments.clear()
        self._magnetization_apply_scopes.clear()

    def record_magnetization_assignment(self, assignment: MagnetizationAssignment) -> None:
        if self.baseline is not None:
            self._magnetization_apply_scopes[(assignment.object_id, assignment.region_id)] = None
        if self.state._live_stages:
            self._stage_magnetization_assignments.append(assignment)

    def author_physical_stage(self, stage: CapturedStage) -> int:
        self._commit_pending_magnetization_apply()
        if self._reconcile_required:
            raise self._magnetization_apply_conflict()
        stages = self.state._live_stages
        assignments = self._stage_magnetization_assignments
        if not stages:
            # Pin the initial conditions of the first physical stage. Later
            # workspace edits can then change the preview without altering it.
            for magnet in stage.problem.magnets:
                object_id = magnet.object_id or magnet.name
                assignments.append(MagnetizationAssignment(object_id, None, magnet.m0))
                for region in magnet.object_regions:
                    assignments.append(
                        MagnetizationAssignment(object_id, region.region_id, region.texture)
                    )
        stages.append(replace(stage, magnetization_assignments=tuple(assignments)))
        assignments.clear()
        return len(stages) - 1

    def submit(self, kind: str, *, wait: bool = True, target: Optional[Mapping[str, Any]] = None, **fields: Any) -> LiveCommandResult | CommandHandle:
        if kind in {"run", "relax", "solve", "compute_fields", "compute_energies"}:
            self.sync(strict=True)
            precondition = {"scene_revision": self.revision} if self.revision is not None else None
            handle = self.client.commands.submit(kind, target=target or Target.study(), precondition=precondition, reason="python_live", **fields)
        else:
            handle = self.client.commands.submit(kind, target=target or _STAGE_TARGET, reason="python_live", **fields)
        if not wait:
            return handle
        handle.wait(timeout=self.command_timeout)
        return LiveCommandResult.from_handle(handle)

    def submit_stage(self, kind: str, stage_index: int, **fields: Any) -> LiveCommandResult:
        """Run the authored stage ``stage_index`` (Docker accepted runs need an explicit stage)."""
        return self.submit(kind, target=Target.stage_index(stage_index), **fields)  # type: ignore[return-value]

    @contextlib.contextmanager
    def paused(self) -> Iterator["LiveSession"]:
        """Pause the run, apply edits, resume — also when the block raises (ADR 0068 D3)."""
        self.submit("pause")
        try:
            with self.transaction():
                yield self
        finally:
            self.submit("resume")

    # ---- data -------------------------------------------------------------

    def field(self, quantity_id: str, **query: Any) -> Optional[FieldVector]:
        try:
            return self.client.data.read_field(quantity_id, **query)
        except ApiError as error:
            # Accepted Docker runs publish m through observation frames; the
            # live field route has no resolved quantity registry for them.
            if quantity_id != "m" or query or "quantity_registry_not_resolved_plan" not in error.message:
                raise
        frames = self.client.data.observation_frames().get("frames") or []
        complete = [frame for frame in frames if frame.get("status") == "complete"]
        if not complete:
            return None
        return self.client.data.frame_magnetization(complete[-1]["frame_id"])

    def table(self, table_id: str, *, columns: Optional[tuple[str, ...]] = None, **query: Any) -> TableRows:
        return self.client.data.read_table(table_id, columns=columns, **query)

    def latest_step(self) -> Any:
        """The newest scalar row of the session as a step-like object (``mx``, ``e_total``, ...).

        Accepted Docker runs publish fields but not yet the scalar table; then
        ``mx``/``my``/``mz`` come from the unweighted mean of the published
        ``m`` (exact for FDM cells) and other scalars raise a clear error.
        """
        window = self.client.data.scalars(limit=1, tail=True)
        rows = window.get("rows") or []
        if rows:
            return SimpleNamespace(**dict(zip(window.get("columns") or [], rows[-1])))
        vector = self.field("m")
        if vector is None:
            raise RuntimeError("the live session has no scalar samples yet; run fm.relax() or fm.run() first")
        mean = vector.to_numpy().reshape(-1, 3).mean(axis=0)
        source = _field_source(self.client.data.fields(), "m")
        return _FieldOnlyStep(
            mx=float(mean[0]),
            my=float(mean[1]),
            mz=float(mean[2]),
            step=source.get("source_step"),
            time=source.get("source_time_seconds"),
        )

    def latest_result(self) -> SimpleNamespace:
        """A result-like object whose ``final_magnetization`` is the session's current ``m``."""
        vector = self.field("m")
        if vector is None:
            raise RuntimeError("the live session has no magnetization field yet")
        return SimpleNamespace(final_magnetization=vector.values.tolist(), field=vector)

    def run_until(
        self,
        predicate: Any,
        *,
        chunk_time: float,
        max_time: Optional[float] = None,
        max_chunks: Optional[int] = None,
        max_solver_steps: Optional[int] = None,
        relax: bool = False,
        relax_fields: Optional[Mapping[str, Any]] = None,
        stage_index: Optional[int] = None,
    ) -> Optional[LiveCommandResult]:
        """Run in chunks of ``chunk_time`` until ``predicate(step)`` is true (spec §5.4).

        ``step`` is :meth:`latest_step`. At least one of ``max_time``,
        ``max_chunks`` or ``max_solver_steps`` (counted from the session's
        ``step`` column) bounds the loop. Each chunk costs one command round
        trip and one scalar read.
        """
        if not math.isfinite(chunk_time) or chunk_time <= 0.0:
            raise ValueError("chunk_time must be a positive number of seconds")
        if max_time is None and max_chunks is None and max_solver_steps is None:
            raise ValueError("run_until needs max_time, max_chunks or max_solver_steps as a guard")
        start_step = _step_count(self) if max_solver_steps is not None else 0
        elapsed, chunks, last = 0.0, 0, None
        while (max_chunks is None or chunks < max_chunks) and (max_time is None or elapsed < max_time):
            span = chunk_time if max_time is None else min(chunk_time, max_time - elapsed)
            target = None if stage_index is None else Target.stage_index(stage_index)
            if relax:
                last = self.submit("relax", target=target, max_relaxation_time_s=span, **dict(relax_fields or {}))
            else:
                last = self.submit("run", target=target, until_seconds=span)
            elapsed += span
            chunks += 1
            step = self.latest_step()
            if predicate(step):
                break
            if max_solver_steps is not None and int(getattr(step, "step", 0) or 0) - start_step >= max_solver_steps:
                break
        return last  # type: ignore[return-value]

    def export_script(self) -> str:
        """The current scene as canonical Python, rendered by the server.

        Sessions created by a script (``fm.connect()``) have no source file, so
        the scene is rendered rather than read back.
        """
        self.sync(strict=False)
        response = self.client.model.render_script(expected_scene_revision=self.revision)
        return str(response.get("source", "")) if isinstance(response, Mapping) else str(response)


class _FieldOnlyStep(SimpleNamespace):
    """A step derived from published fields; scalars without a field are absent."""

    def __getattr__(self, name: str) -> Any:
        # An AttributeError keeps getattr(step, name, default) working.
        raise AttributeError(
            f"scalar {name!r} is not available: this run published fields but no scalar "
            "table (accepted Docker runs do not project scalar rows yet)"
        )


def _field_source(catalog: Any, quantity_id: str) -> Mapping[str, Any]:
    entries = catalog.get("quantities", []) if isinstance(catalog, Mapping) else []
    return next((entry for entry in entries if entry.get("quantity_id") == quantity_id), {})


def _step_count(session: "LiveSession") -> int:
    try:
        return int(getattr(session.latest_step(), "step", 0) or 0)
    except RuntimeError:
        return 0


def _revision_of(scene: Any) -> Optional[int]:
    if isinstance(scene, Mapping):
        value = scene.get("revision")
        if value is None and isinstance(scene.get("scene"), Mapping):
            value = scene["scene"].get("revision")
        return int(value) if value is not None else None
    return None


def _default_source_path() -> Path:
    main = sys.modules.get("__main__")
    script = getattr(main, "__file__", None)
    return Path(script).resolve() if script else Path.cwd() / "fullmag_live_session.py"
