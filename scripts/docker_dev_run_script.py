#!/usr/bin/env python3
"""Activate one managed DEV script and observe only its exact run."""

from __future__ import annotations

import argparse
from collections.abc import Mapping
import json
import math
from pathlib import Path
import re
import time
from typing import Any

from docker_build_control import BuildControlError, ControlOutcomeUnknown, docker_capture


RESULT_SCHEMA = "fullmag.docker-dev-run-script.v1"
API_INSTANCE_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
POLL_INTERVAL_SECONDS = 1.0
OBSERVER_TIMEOUT_SECONDS = 20
OBSERVER_RETRIES = 2
MAX_OBSERVER_OUTPUT_BYTES = 64 * 1024

# Fixed image-side, read-only observer. Identity inputs are passed as argv
# environment values to a validated backend container; no shell or user source
# is interpolated into this program.
API_OBSERVER_SCRIPT = r'''import json, os, re, urllib.error, urllib.parse, urllib.request

SCHEMA = "fullmag.docker-dev-run-observation.v1"
API_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAX_BYTES = 128 * 1024
BASE = "http://127.0.0.1:8081"

def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key")
        value[key] = item
    return value

def encode_scope_component(value):
    return urllib.parse.quote(value, safe="-_.!~*'()")

def scope_header(session_id, session_epoch, request_scope_epoch):
    return ("session=" + encode_scope_component(session_id)
            + "&epoch=" + encode_scope_component(session_epoch)
            + "&request_scope_epoch=" + encode_scope_component(request_scope_epoch))

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None

def get(path, expected_api=None, expected_scope=None):
    headers = {"Accept": "application/json", "Host": "localhost"}
    if expected_api:
        headers["x-fullmag-api-instance"] = expected_api
    if expected_scope:
        headers["x-fullmag-session-scope"] = expected_scope
    request = urllib.request.Request(BASE + path, headers=headers, method="GET")
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(request, timeout=3.0) as response:
        if response.status != 200:
            raise RuntimeError("http_status")
        api_values = response.headers.get_all("x-fullmag-api-instance") or []
        if len(api_values) != 1 or not API_RE.fullmatch(api_values[0]):
            raise RuntimeError("api_identity")
        api_id = api_values[0]
        if expected_api is not None and api_id != expected_api:
            raise RuntimeError("api_instance_changed")
        raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise RuntimeError("response_too_large")
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
    if not isinstance(value, dict):
        raise RuntimeError("response_shape")
    return api_id, value

def emit(state, **fields):
    result = {"schema": SCHEMA, "state": state, **fields}
    print(json.dumps(result, sort_keys=True, separators=(",", ":")), flush=True)

mode = os.environ.get("FULLMAG_RUN_OBSERVER_MODE")
expected_api = os.environ.get("FULLMAG_RUN_OBSERVER_API_INSTANCE_ID") or None
try:
    if mode == "pin":
        api_id, health = get("/v2/platform/health", expected_api)
        if health.get("status") != "ok":
            raise RuntimeError("api_degraded")
        emit("observed", api_instance_id=api_id)
    elif mode == "run":
        session_id = os.environ.get("FULLMAG_RUN_OBSERVER_SESSION_ID", "")
        run_id = os.environ.get("FULLMAG_RUN_OBSERVER_RUN_ID", "")
        if not session_id or not run_id or expected_api is None:
            raise RuntimeError("observer_identity_missing")
        status_path = "/v2/sessions/current/status"
        expected_epoch = os.environ.get("FULLMAG_RUN_OBSERVER_SESSION_EPOCH") or None
        expected_scope = os.environ.get("FULLMAG_RUN_OBSERVER_REQUEST_SCOPE_EPOCH") or None
        if (expected_epoch is None) != (expected_scope is None):
            raise RuntimeError("observer_identity_missing")
        session_id_scope = session_id
        first_scope_header = (
            scope_header(session_id_scope, expected_epoch, expected_scope)
            if expected_epoch is not None else None
        )
        api_before, before = get(status_path, expected_api, first_scope_header)
        session_before = before.get("session")
        run_before = before.get("run")
        if (not isinstance(session_before, dict)
                or session_before.get("session_id") != session_id
                or not isinstance(session_before.get("session_epoch"), str)
                or not isinstance(session_before.get("request_scope_epoch"), str)
                or not session_before["request_scope_epoch"].startswith(api_before + ":")
                or not isinstance(run_before, dict)
                or run_before.get("run_id") != run_id):
            raise RuntimeError("request_scope_changed")
        session_epoch = session_before["session_epoch"]
        request_scope_epoch = session_before["request_scope_epoch"]
        if (expected_epoch is not None
                and (session_epoch != expected_epoch or request_scope_epoch != expected_scope)):
            raise RuntimeError("request_scope_changed")
        active_scope_header = scope_header(session_id, session_epoch, request_scope_epoch)
        run_path = "/v2/sessions/current/simulation/runs/" + urllib.parse.quote(run_id, safe="")
        api_run, run = get(run_path, expected_api, active_scope_header)
        if (run.get("session_id") != session_id or run.get("run_id") != run_id
                or not isinstance(run.get("status"), str)):
            raise RuntimeError("run_identity_changed")
        api_after, after = get(status_path, expected_api, active_scope_header)
        session_after = after.get("session")
        run_after = after.get("run")
        if (api_before != api_run or api_run != api_after
                or not isinstance(session_after, dict)
                or session_after.get("session_id") != session_id
                or session_after.get("session_epoch") != session_epoch
                or session_after.get("request_scope_epoch") != request_scope_epoch
                or not isinstance(run_after, dict)
                or run_after.get("run_id") != run_id):
            raise RuntimeError("request_scope_changed")
        emit("observed", api_instance_id=api_before,
             session_epoch=session_epoch, request_scope_epoch=request_scope_epoch,
             session_id=session_id,
             run_id=run_id, run_status=run["status"])
    else:
        raise RuntimeError("observer_mode_invalid")
except (OSError, TimeoutError, urllib.error.URLError, urllib.error.HTTPError,
        UnicodeDecodeError, ValueError, RuntimeError) as error:
    reason = str(error) if str(error) in {
        "api_identity", "api_instance_changed", "http_status", "response_too_large",
        "response_shape", "observer_identity_missing", "request_scope_changed",
        "run_identity_changed", "observer_mode_invalid", "api_degraded",
    } else "api_observation_failed"
    emit("unknown", reason=reason)
'''


def _result(
    state: str,
    outcome: str,
    exit_code: int,
    *,
    status: str,
    attempt: str | None = None,
    config_sha256: str | None = None,
    source_sha256: str | None = None,
    request_id: str | None = None,
    session_id: str | None = None,
    run_id: str | None = None,
    api_instance_id: str | None = None,
    session_epoch: str | None = None,
    request_scope_epoch: str | None = None,
    message: str | None = None,
) -> dict[str, Any]:
    value: dict[str, Any] = {
        "schema": RESULT_SCHEMA,
        "state": state,
        "outcome": outcome,
        "status": status,
        "exit_code": exit_code,
    }
    for key, item in (
        ("attempt", attempt),
        ("config_sha256", config_sha256),
        ("source_sha256", source_sha256),
        ("request_id", request_id),
        ("session_id", session_id),
        ("run_id", run_id),
        ("api_instance_id", api_instance_id),
        ("session_epoch", session_epoch),
        ("request_scope_epoch", request_scope_epoch),
        ("message", message),
    ):
        if item is not None:
            value[key] = item
    return value


def _container_probe(
    backend_container_id: str,
    mode: str,
    *,
    api_instance_id: str | None = None,
    session_id: str | None = None,
    run_id: str | None = None,
    session_epoch: str | None = None,
    request_scope_epoch: str | None = None,
) -> dict[str, Any]:
    environment = ["FULLMAG_RUN_OBSERVER_MODE=" + mode]
    if api_instance_id is not None:
        environment.append("FULLMAG_RUN_OBSERVER_API_INSTANCE_ID=" + api_instance_id)
    if session_id is not None:
        environment.append("FULLMAG_RUN_OBSERVER_SESSION_ID=" + session_id)
    if run_id is not None:
        environment.append("FULLMAG_RUN_OBSERVER_RUN_ID=" + run_id)
    if session_epoch is not None:
        environment.append("FULLMAG_RUN_OBSERVER_SESSION_EPOCH=" + session_epoch)
    if request_scope_epoch is not None:
        environment.append("FULLMAG_RUN_OBSERVER_REQUEST_SCOPE_EPOCH=" + request_scope_epoch)
    command = ["exec"]
    for value in environment:
        command.extend(("--env", value))
    command.extend((
        backend_container_id,
        "/usr/local/bin/python3",
        "-I",
        "-B",
        "-c",
        API_OBSERVER_SCRIPT,
    ))
    result = docker_capture(
        *command,
        timeout=OBSERVER_TIMEOUT_SECONDS,
        allow_failure=True,
    )
    if result.returncode != 0 or len(result.stdout) > MAX_OBSERVER_OUTPUT_BYTES:
        raise ControlOutcomeUnknown("managed API observation did not return a bounded result")
    try:
        value = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ControlOutcomeUnknown("managed API observation returned invalid data") from error
    if (not isinstance(value, dict)
            or value.get("schema") != "fullmag.docker-dev-run-observation.v1"
            or value.get("state") not in {"observed", "unknown"}):
        raise ControlOutcomeUnknown("managed API observation returned an invalid result")
    return value


def _probe_with_retry(backend_container_id: str, mode: str, **identity: str) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(OBSERVER_RETRIES):
        try:
            value = _container_probe(backend_container_id, mode, **identity)
            if value.get("state") == "observed":
                return value
            last_error = ControlOutcomeUnknown("managed API did not confirm the pinned identity")
        except (BuildControlError, ControlOutcomeUnknown, OSError, ValueError) as error:
            last_error = error
        if attempt + 1 < OBSERVER_RETRIES:
            time.sleep(0.25)
    raise ControlOutcomeUnknown(
        "managed API observation remains unknown after bounded read-only retries"
    ) from last_error


def run_script(
    repo_root: Path | str,
    script: Path | str,
    *,
    source_root: Path | str | None = None,
    port: int | None = None,
    request_id: str | None = None,
    timeout_seconds: float | None = None,
) -> dict[str, Any]:
    """Run one script in the validated running group; never stop or replay it."""

    if timeout_seconds is not None and (
        isinstance(timeout_seconds, bool)
        or not isinstance(timeout_seconds, (int, float))
        or not math.isfinite(timeout_seconds)
        or timeout_seconds <= 0
    ):
        return _result("rejected", "invalid_timeout", 2, status="not_started")
    if request_id is not None and not REQUEST_ID_RE.fullmatch(request_id):
        return _result("rejected", "invalid_request_id", 2, status="not_started")

    from docker_dev_defaults import _discover_pins, resolve_defaults

    try:
        repo = Path(repo_root).resolve(strict=True)
        defaults = resolve_defaults(repo, source_root=source_root, port=port)
        pins = _discover_pins(
            repo,
            defaults,
            requested_port=(defaults.port if port is not None else None),
        )
    except (BuildControlError, OSError, ValueError) as error:
        return _result(
            "rejected",
            "group_admission_failed",
            2,
            status="not_started",
            message="Managed DEV group could not be admitted: " + type(error).__name__,
        )

    if (not re.fullmatch(r"[0-9a-f]{32}", pins.attempt)
            or not SHA256_RE.fullmatch(pins.config_sha256)
            or not re.fullmatch(r"[0-9a-f]{64}", pins.backend_container_id)
            or not re.fullmatch(r"[0-9a-f]{64}", pins.frontend_container_id)):
        return _result(
            "rejected",
            "group_identity_invalid",
            2,
            status="not_started",
            attempt=pins.attempt,
            config_sha256=pins.config_sha256,
            message="Validated DEV group did not provide complete container pins.",
        )

    try:
        api_pin = _probe_with_retry(pins.backend_container_id, "pin")
    except KeyboardInterrupt:
        return _result(
            "unknown", "api_observation_interrupted", 130,
            status="unknown", attempt=pins.attempt,
            config_sha256=pins.config_sha256,
            message="API identity observation was interrupted; activation was not attempted.",
        )
    except (BuildControlError, ControlOutcomeUnknown, OSError, ValueError):
        return _result(
            "unknown",
            "api_identity_unavailable",
            75,
            status="unknown",
            attempt=pins.attempt,
            config_sha256=pins.config_sha256,
            message="API identity could not be pinned; script activation was not attempted.",
        )
    api_instance_id = api_pin.get("api_instance_id")
    if not isinstance(api_instance_id, str) or not API_INSTANCE_RE.fullmatch(api_instance_id):
        return _result(
            "unknown",
            "api_identity_invalid",
            75,
            status="unknown",
            attempt=pins.attempt,
            config_sha256=pins.config_sha256,
            message="API identity was invalid; script activation was not attempted.",
        )

    from docker_volume_activate import activate

    try:
        activation = activate(argparse.Namespace(
            repo_root=repo,
            attempt=pins.attempt,
            config_sha256=pins.config_sha256,
            source_root=pins.source_root,
            script=Path(script),
            request_id=request_id,
        ))
    except KeyboardInterrupt:
        return _result(
            "unknown",
            "activation_interrupted",
            130,
            status="unknown",
            attempt=pins.attempt,
            config_sha256=pins.config_sha256,
            api_instance_id=api_instance_id,
            message="Activation observation was interrupted; no retry or cancellation was attempted.",
        )
    except BuildControlError as error:
        if str(error) == "Backend activation was rejected; terminal activation receipt retained and retry is forbidden":
            return _result(
                "rejected",
                "script_rejected",
                2,
                status="rejected",
                attempt=pins.attempt,
                config_sha256=pins.config_sha256,
                api_instance_id=api_instance_id,
                message="The managed API rejected this script; the terminal receipt is retained.",
            )
        return _result(
            "unknown",
            "activation_outcome_unknown",
            75,
            status="unknown",
            attempt=pins.attempt,
            config_sha256=pins.config_sha256,
            api_instance_id=api_instance_id,
            message="Activation outcome is unknown; services remain running and no retry was attempted.",
        )
    except (ControlOutcomeUnknown, OSError, ValueError):
        return _result(
            "unknown",
            "activation_outcome_unknown",
            75,
            status="unknown",
            attempt=pins.attempt,
            config_sha256=pins.config_sha256,
            api_instance_id=api_instance_id,
            message="Activation outcome is unknown; services remain running and no retry was attempted.",
        )

    response = activation.get("response") if isinstance(activation, Mapping) else None
    if (not isinstance(activation, Mapping)
            or activation.get("state") != "activated" or not isinstance(response, Mapping)
            or response.get("request_id") != activation.get("request_id")
            or response.get("source_sha256") != activation.get("source_sha256")):
        return _result(
            "unknown",
            "activation_result_invalid",
            75,
            status="unknown",
            attempt=pins.attempt,
            config_sha256=pins.config_sha256,
            message="The retained activation result did not confirm the request identity.",
        )
    session_id = response.get("session_id")
    run_id = response.get("run_id")
    source_sha256 = activation.get("source_sha256")
    activation_request_id = activation.get("request_id")
    metadata = response.get("runtime_metadata")
    if (not isinstance(session_id, str) or not session_id.strip()
            or not isinstance(run_id, str) or not run_id.strip()
            or not isinstance(source_sha256, str) or not SHA256_RE.fullmatch(source_sha256)
            or not isinstance(activation_request_id, str)
            or not REQUEST_ID_RE.fullmatch(activation_request_id)
            or not isinstance(metadata, Mapping)
            or type(metadata.get("interactive")) is not bool
            or type(metadata.get("wait_for_solve")) is not bool):
        return _result(
            "unknown",
            "activation_identity_incomplete",
            75,
            status="unknown",
            attempt=pins.attempt,
            config_sha256=pins.config_sha256,
            source_sha256=source_sha256 if isinstance(source_sha256, str) else None,
            message="The retained activation result omitted required run pins.",
        )

    base = {
        "attempt": pins.attempt,
        "config_sha256": pins.config_sha256,
        "source_sha256": source_sha256,
        "request_id": activation_request_id,
        "session_id": session_id,
        "run_id": run_id,
        "api_instance_id": api_instance_id,
    }
    if metadata["interactive"] or metadata["wait_for_solve"]:
        try:
            _probe_with_retry(
                pins.backend_container_id,
                "pin",
                api_instance_id=api_instance_id,
            )
        except KeyboardInterrupt:
            return _result(
                "unknown", "api_observation_interrupted", 130,
                status="unknown", attempt=pins.attempt,
                config_sha256=pins.config_sha256,
                api_instance_id=api_instance_id,
                message="API identity observation was interrupted after activation; services remain running.",
            )
        except (BuildControlError, ControlOutcomeUnknown, OSError, ValueError):
            return _result(
                "unknown",
                "api_instance_changed",
                75,
                status="unknown",
                **base,
                message="API instance changed after activation; services remain running.",
            )
        status = response.get("status")
        if status not in {"accepted", "waiting_for_solve"}:
            return _result(
                "unknown", "activation_status_invalid", 75,
                status="unknown", **base,
            )
        outcome = "interactive_waiting_for_solve" if metadata["wait_for_solve"] else "interactive_accepted"
        return _result(
            "interactive",
            outcome,
            0,
            status=status,
            **base,
            message="Script accepted; the API and UI remain available.",
        )

    status_scope: str | None = None
    scientific_session_epoch: str | None = None
    deadline = None if timeout_seconds is None else time.monotonic() + timeout_seconds
    last_status = "unknown"
    while True:
        try:
            observed = _probe_with_retry(
                pins.backend_container_id,
                "run",
                api_instance_id=api_instance_id,
                session_id=session_id,
                run_id=run_id,
                session_epoch=scientific_session_epoch,
                request_scope_epoch=status_scope,
            )
        except KeyboardInterrupt:
            return _result(
                "unknown",
                "observation_interrupted",
                130,
                status=last_status,
                **base,
                request_scope_epoch=status_scope,
                message="Run observation was interrupted; the run was not cancelled.",
            )
        except (BuildControlError, ControlOutcomeUnknown, OSError, ValueError):
            return _result(
                "unknown",
                "run_observation_unknown",
                75,
                status=last_status,
                **base,
                request_scope_epoch=status_scope,
                message="Exact run status is unknown; services remain running and no replay was attempted.",
            )
        observed_scope = observed.get("request_scope_epoch")
        observed_epoch = observed.get("session_epoch")
        run_status = observed.get("run_status")
        if (observed.get("api_instance_id") != api_instance_id
                or observed.get("session_id") != session_id
                or observed.get("run_id") != run_id
                or not isinstance(observed_scope, str)
                or not isinstance(observed_epoch, str)):
            return _result(
                "unknown",
                "run_identity_changed",
                75,
                status=last_status,
                **base,
                message="API instance, session, or run identity changed during observation.",
            )
        if status_scope is None:
            status_scope = observed_scope
            scientific_session_epoch = observed_epoch
        elif observed_scope != status_scope:
            return _result(
                "unknown",
                "request_scope_changed",
                75,
                status=last_status,
                **base,
                request_scope_epoch=status_scope,
                message="API request scope changed during observation; services remain running.",
            )
        elif observed_epoch != scientific_session_epoch:
            return _result(
                "unknown", "session_epoch_changed", 75,
                status=last_status, **base,
                session_epoch=scientific_session_epoch,
                request_scope_epoch=status_scope,
                message="Session identity changed during observation; services remain running.",
            )
        if not isinstance(run_status, str):
            return _result(
                "unknown", "run_status_invalid", 75,
                status=last_status, **base, request_scope_epoch=status_scope,
            )
        last_status = run_status
        if run_status == "completed":
            return _result(
                "terminal", "completed", 0, status=run_status,
                **base, session_epoch=scientific_session_epoch,
                request_scope_epoch=status_scope,
            )
        if run_status == "failed":
            return _result(
                "terminal", "failed", 1, status=run_status,
                **base, session_epoch=scientific_session_epoch,
                request_scope_epoch=status_scope,
            )
        if run_status == "cancelled":
            return _result(
                "terminal", "cancelled", 1, status=run_status,
                **base, session_epoch=scientific_session_epoch,
                request_scope_epoch=status_scope,
                message="The run was cancelled; cancellation is not reported as success.",
            )
        if run_status not in {"queued", "pending", "waiting_for_compute", "running", "paused"}:
            return _result(
                "unknown", "run_status_unrecognized", 75,
                status=run_status, **base, request_scope_epoch=status_scope,
            )
        if deadline is not None and time.monotonic() >= deadline:
            return _result(
                "unknown", "observation_timeout", 124,
                status=run_status, **base, request_scope_epoch=status_scope,
                message="Observation deadline expired; the run was not cancelled and services remain running.",
            )
        try:
            time.sleep(POLL_INTERVAL_SECONDS)
        except KeyboardInterrupt:
            return _result(
                "unknown", "observation_interrupted", 130,
                status=last_status, **base,
                request_scope_epoch=status_scope,
                message="Run observation was interrupted; the run was not cancelled.",
            )
