"""Low-level typed client for the Fullmag v2 API (ADR 0068, spec §4).

Every call goes through the generated operation table, so a path, method or
parameter that disappears from ``openapi-v2.json`` fails the generator check
instead of failing at runtime against a live session.
"""
from __future__ import annotations

import os
import time
from typing import Any, Mapping, Optional

from ._generated.operations import OPERATIONS, Operation
from ._schema import validate_payload
from ._transport import HttpResponse, HttpTransport
from .commands import CommandHandle, new_intent_id
from .fmtb import TableRows, decode_table_rows
from .fmvp import FieldVector, decode_field_vector

__all__ = ["Client", "DEFAULT_URL", "resolve_url"]

DEFAULT_URL = "http://127.0.0.1:3197"
URL_ENV = "FULLMAG_URL"
TOKEN_ENV = "FULLMAG_TOKEN"
SESSION_SCOPE_HEADER = "x-fullmag-session-scope"


def resolve_url(url: Optional[str] = None) -> str:
    """Return ``url``, else ``$FULLMAG_URL``, else the default DEV frontend origin."""
    return url or os.environ.get(URL_ENV) or DEFAULT_URL


class Client:
    """Blocking client bound to one Fullmag origin (a Docker DEV frontend or API)."""

    def __init__(
        self,
        url: Optional[str] = None,
        *,
        timeout: float = 30.0,
        token: Optional[str] = None,
        retry_budget_s: float = 60.0,
        transport: Optional[HttpTransport] = None,
    ) -> None:
        self.transport = transport or HttpTransport(
            resolve_url(url),
            timeout=timeout,
            token=token if token is not None else os.environ.get(TOKEN_ENV),
            retry_budget_s=retry_budget_s,
        )
        self.session_scope: Optional[str] = None
        # Optional hook ``(command_id, max_wait_s)`` installed by the event stream (F4).
        self.command_waiter: Any = None
        self.sessions = _Sessions(self)
        self.model = _Model(self)
        self.commands = _Commands(self)
        self.simulation = _Simulation(self)
        self.data = _Data(self)

    @property
    def url(self) -> str:
        return self.transport.base_url

    def close(self) -> None:
        self.transport.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def __repr__(self) -> str:
        return f"Client({self.url!r})"

    # ---- generic operation call -----------------------------------------

    def call(
        self,
        operation_id: str,
        *,
        path_params: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Any]] = None,
        body: Any = None,
        headers: Optional[Mapping[str, str]] = None,
        accept: str = "application/json",
        timeout: Optional[float] = None,
        ok_statuses: tuple[int, ...] = (),
    ) -> HttpResponse:
        """Invoke one operation from the generated table and return the raw response."""
        operation = OPERATIONS.get(operation_id)
        if operation is None:
            raise KeyError(f"unknown Fullmag API operation {operation_id!r}")
        path = _expand_path(operation, path_params or {})
        if query:
            unknown = sorted(set(query) - set(operation.query_params))
            if unknown:
                raise ValueError(f"{operation_id} does not accept query parameter(s): {', '.join(unknown)}")
        if operation.request_schema is not None:
            if body is None:
                raise ValueError(f"{operation_id} requires a {operation.request_schema} body")
            validate_payload(operation.request_schema, body)
        elif body is not None:
            raise ValueError(f"{operation_id} does not take a request body")
        request_headers = dict(headers or {})
        if self.session_scope and SESSION_SCOPE_HEADER in {name.lower() for name in operation.header_params}:
            request_headers.setdefault(SESSION_SCOPE_HEADER, self.session_scope)
        return self.transport.request(
            operation.method,
            path,
            query=query,
            json_body=body,
            headers=request_headers,
            accept=accept,
            timeout=timeout,
            ok_statuses=ok_statuses,
        )

    def call_json(self, operation_id: str, **kwargs: Any) -> Any:
        return self.call(operation_id, **kwargs).json()

    def health(self) -> Any:
        return self.call_json("platform_get_platform_health")


def _expand_path(operation: Operation, values: Mapping[str, Any]) -> str:
    missing = [name for name in operation.path_params if name not in values]
    if missing:
        raise ValueError(f"{operation.operation_id} requires path parameter(s): {', '.join(missing)}")
    extra = sorted(set(values) - set(operation.path_params))
    if extra:
        raise ValueError(f"{operation.operation_id} does not take path parameter(s): {', '.join(extra)}")
    path = operation.path
    for name in operation.path_params:
        path = path.replace("{" + name + "}", _quote_segment(str(values[name])))
    return path


def _quote_segment(value: str) -> str:
    from urllib.parse import quote

    return quote(value, safe="")


def _drop_none(values: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None}


class _Namespace:
    def __init__(self, client: Client) -> None:
        self._client = client


class _Sessions(_Namespace):
    def list(self) -> Any:
        return self._client.call_json("sessions_get_sessions")

    def create(
        self,
        name: str,
        *,
        backend: str,
        device: str,
        precision: str,
        replace_current: bool = False,
        output_storage: Optional[Mapping[str, Any]] = None,
    ) -> Any:
        body = _drop_none(
            {
                "name": name,
                "backend": backend,
                "device": device,
                "precision": precision,
                "replace_current": replace_current,
                "output_storage": output_storage,
            }
        )
        return self._client.call_json("sessions_post_sessions", body=body)

    def current(self) -> Any:
        return self._client.call_json("sessions_get_sessions_current")

    def status(self) -> Any:
        return self._client.call_json("sessions_get_sessions_current_status")

    def clients(self) -> Any:
        """External clients (e.g. Python live scripts) seen within the presence TTL."""
        return self._client.call_json("sessions_get_sessions_current_clients")

    def heartbeat(self, client_id: str, *, kind: str = "python_live", label: Optional[str] = None) -> Any:
        """Announce or refresh this client's presence in the current session."""
        return self._client.call_json(
            "sessions_put_sessions_current_clients_client_id",
            path_params={"client_id": client_id},
            body=_drop_none({"kind": kind, "label": label}),
        )

    def leave(self, client_id: str) -> None:
        self._client.call(
            "sessions_delete_sessions_current_clients_client_id",
            path_params={"client_id": client_id},
        )


class _Model(_Namespace):
    def scene(self) -> Any:
        return self._client.call_json("model_get_sessions_current_model_scene")

    def script(self) -> Any:
        return self._client.call_json("model_get_sessions_current_model_script")

    def render_script(self, *, expected_scene_revision: Optional[int] = None) -> Any:
        """Render the current scene as canonical Python (``source``) and record it in the session."""
        return self._client.call_json(
            "model_post_sessions_current_model_syncs",
            body=_drop_none({"expected_scene_revision": expected_scene_revision}),
        )

    def commit(
        self,
        transaction: Mapping[str, Any],
        *,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        """Commit one ``AuthoringTransactionRequest`` and return the response."""
        return self._client.call_json(
            "model_post_sessions_current_model_transactions",
            body=dict(transaction),
            headers={"Idempotency-Key": idempotency_key} if idempotency_key else None,
        )

    def replace_scene(self, scene: Mapping[str, Any], *, base_revision: Optional[int] = None) -> Any:
        return self.commit(_drop_none({"kind": "replace_scene", "scene": dict(scene), "base_revision": base_revision}))

    def merge_patch(self, patch: Mapping[str, Any], *, base_revision: Optional[int] = None) -> Any:
        return self.commit(_drop_none({"kind": "merge_patch", "merge_patch": dict(patch), "base_revision": base_revision}))


class _Commands(_Namespace):
    def submit(
        self,
        kind: str,
        *,
        target: Optional[Mapping[str, Any]] = None,
        precondition: Optional[Mapping[str, Any]] = None,
        reason: Optional[str] = None,
        client_intent_id: Optional[str] = None,
        **fields: Any,
    ) -> CommandHandle:
        """Submit one ``StructuredCommandRequest`` and return its handle."""
        intent = client_intent_id or new_intent_id()
        body = _drop_none(
            {
                "kind": kind,
                "target": None if target is None else dict(target),
                "precondition": None if precondition is None else dict(precondition),
                "reason": reason,
                "client_intent_id": intent,
                "requested_at_unix_ms": int(time.time() * 1000),
                **fields,
            }
        )
        response = self._client.call_json("simulation_post_sessions_current_simulation_commands", body=body)
        command_id = str(response["command_id"])
        return CommandHandle(self._client, command_id, kind, intent, {"status": "queued", "command_id": command_id})

    def get(self, command_id: str) -> Any:
        return self._client.call_json(
            "simulation_get_sessions_current_simulation_commands_command_id",
            path_params={"command_id": command_id},
        )

    def queue(self) -> Any:
        return self._client.call_json("simulation_get_sessions_current_simulation_commands")


class _Simulation(_Namespace):
    def current_run(self) -> Any:
        return self._client.call_json("simulation_get_sessions_current_simulation_runs_current")

    def stages_execution(self) -> Any:
        return self._client.call_json("simulation_get_sessions_current_simulation_stages_execution")


class _Data(_Namespace):
    def __init__(self, client: Client) -> None:
        super().__init__(client)
        self._field_cache: dict[Any, tuple[str, FieldVector]] = {}

    def quantities(self, *, stage_id: Optional[str] = None) -> Any:
        return self._client.call_json("data_get_sessions_current_data_quantities", query=_drop_none({"stage_id": stage_id}))

    def fields(self, *, stage_id: Optional[str] = None) -> Any:
        return self._client.call_json("data_get_sessions_current_data_fields", query=_drop_none({"stage_id": stage_id}))

    def observation_frames(self) -> Any:
        """Accepted-run observation frames of the current run (newest last)."""
        return self._client.call_json("data_get_sessions_current_data_observation_frames")

    def frame_magnetization(self, frame_id: str) -> FieldVector:
        """Decode the source-qualified magnetization of one observation frame (FMVP v4)."""
        response = self._client.call(
            "data_get_sessions_current_data_observation_frames_frame_id_magnetization",
            path_params={"frame_id": frame_id},
            accept="application/octet-stream, application/json",
        )
        return decode_field_vector(response.body)

    def field_meta(self, quantity_id: str) -> Any:
        return self._client.call_json(
            "data_get_sessions_current_data_fields_quantity_id_meta",
            path_params={"quantity_id": quantity_id},
        )

    def field_vector(self, quantity_id: str, *, etag: Optional[str] = None, **query: Any) -> HttpResponse:
        """Return the raw FMVP response (200), or the 202/204/304 response unchanged."""
        headers = {"If-None-Match": etag} if etag else None
        return self._client.call(
            "data_get_sessions_current_data_fields_quantity_id_samples_vector",
            path_params={"quantity_id": quantity_id},
            query=_drop_none(query),
            headers=headers,
            accept="application/octet-stream, application/json",
            ok_statuses=(304,),
        )

    def read_field(self, quantity_id: str, *, wait_s: float = 30.0, **query: Any) -> Optional[FieldVector]:
        """Decode the current samples of ``quantity_id``; ``None`` when the field has no data (204).

        A 202 (field still materialising) is polled until ``wait_s`` elapses; an
        unchanged ETag (304) returns the previously decoded object.
        """
        key = (quantity_id, tuple(sorted((k, str(v)) for k, v in query.items() if v is not None)))
        cached = self._field_cache.get(key)
        deadline = time.monotonic() + wait_s
        delay = 0.05
        while True:
            response = self.field_vector(quantity_id, etag=cached[0] if cached else None, **query)
            if response.status == 304 and cached is not None:
                return cached[1]
            if response.status == 204:
                return None
            if response.status == 202:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"field {quantity_id!r} still materialising after {wait_s:g} s")
                time.sleep(delay)
                delay = min(delay * 2, 1.0)
                continue
            decoded = decode_field_vector(response.body)
            etag = response.headers.get("etag")
            if etag:
                self._field_cache[key] = (etag, decoded)
            return decoded

    def read_table(self, table_id: str, *, columns: Optional[tuple[str, ...]] = None, **query: Any) -> TableRows:
        """Decode table rows (``rows.bin``) into a :class:`TableRows` numpy view."""
        if columns is not None and "columns" not in query:
            query["columns"] = list(columns)
        response = self.table_rows_bin(table_id, **query)
        return decode_table_rows(response.body, columns=columns)

    def scalars(self, **query: Any) -> Any:
        return self._client.call_json("data_get_sessions_current_data_scalars", query=_drop_none(query))

    def tables(self) -> Any:
        return self._client.call_json("data_get_sessions_current_data_tables")

    def table_rows(self, table_id: str, **query: Any) -> Any:
        return self._client.call_json(
            "data_get_sessions_current_data_tables_table_id_rows",
            path_params={"table_id": table_id},
            query=_drop_none(query),
        )

    def table_rows_bin(self, table_id: str, **query: Any) -> HttpResponse:
        return self._client.call(
            "data_get_sessions_current_data_tables_table_id_rows_bin",
            path_params={"table_id": table_id},
            query=_drop_none(query),
            accept="application/vnd.fullmag.table-rows.v1+octet-stream",
        )
