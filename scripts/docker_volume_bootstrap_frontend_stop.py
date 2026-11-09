"""Stop only the retained frontend after a qualified bootstrap API stop.

This operation never drains, claims, or rewrites the native owner. It binds a
preview to the exact selected checkout, bootstrap-stop evidence, native bytes,
Docker engine, and both retained service incarnations before stopping one
frontend container with a graceful signal.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from collections.abc import Mapping
from pathlib import Path
import re

from docker_build_control import (
    BuildControl,
    BuildControlError,
    canonical,
    compose_capture,
    docker_capture,
    toolchain_configuration,
)
from docker_dev_host import require_host
import docker_volume_bootstrap_recovery as recovery
import docker_volume_stop_bootstrap as bootstrap_stop


SCHEMA = "fullmag.docker-bootstrap-frontend-stop.v1"
PLAN_SCHEMA = "fullmag.docker-bootstrap-frontend-stop-plan.v1"
PHASE = "stop-bootstrap-frontend"
ATTEMPT_RE = re.compile(r"[0-9a-f]{32}\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
CONTAINER_RE = re.compile(r"[0-9a-f]{64}\Z")
IMAGE_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
MAX_EVIDENCE_BYTES = 1024 * 1024


def _fail(message: str) -> None:
    raise BuildControlError("Bootstrap frontend stop: " + message)


def _need(condition: object, message: str) -> None:
    if not condition:
        _fail(message)


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _validate_args(args: argparse.Namespace) -> None:
    _need(isinstance(getattr(args, "attempt", None), str)
          and ATTEMPT_RE.fullmatch(args.attempt) is not None,
          "development attempt is not a complete lowercase identity")
    _need(isinstance(getattr(args, "bootstrap_stop_attempt", None), str)
          and ATTEMPT_RE.fullmatch(args.bootstrap_stop_attempt) is not None,
          "bootstrap-stop attempt is not a complete lowercase identity")
    _need(isinstance(getattr(args, "bootstrap_stop_sha256", None), str)
          and SHA256_RE.fullmatch(args.bootstrap_stop_sha256) is not None,
          "bootstrap-stop terminal requires its exact raw SHA-256")
    _need(isinstance(getattr(args, "config_sha256", None), str)
          and SHA256_RE.fullmatch(args.config_sha256) is not None,
          "Compose config SHA-256 is not a complete lowercase digest")
    _need(type(getattr(args, "port", None)) is int and 1 <= args.port <= 65535,
          "frontend port is outside the valid range")
    _need(type(getattr(args, "apply", None)) is bool, "apply mode must be an explicit boolean")
    if args.apply:
        expected = getattr(args, "expected_plan_sha256", None)
        _need(isinstance(expected, str) and SHA256_RE.fullmatch(expected) is not None,
              "apply requires the exact preview plan SHA-256")


def _build_context(args):
    """Select only a registered checkout and its managed control volume."""
    from docker_dev import _compose_identity, _select_source

    require_host()
    try:
        repo_root = Path(args.repo_root).resolve(strict=True)
    except (AttributeError, OSError, TypeError) as error:
        raise BuildControlError("Bootstrap frontend stop requires an existing registered repo root") from error
    selected, layout = _select_source(repo_root, getattr(args, "source_root", None))
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    try:
        helper_image = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    except (KeyError, TypeError) as error:
        raise BuildControlError("Selected Compose toolchain does not pin the managed BuildControl image") from error
    control = BuildControl(identity, helper_image)
    _require_existing_control_volume(control)
    return selected, identity, control


def _require_existing_control_volume(control) -> None:
    """Read-only admission guard; mounting a missing named volume would create it."""
    result = docker_capture("volume", "inspect", control.volume, allow_failure=True)
    if result.returncode:
        listed = docker_capture("volume", "ls", "--format", "{{.Name}}", timeout=60)
        if listed.returncode:
            _fail("existing control volume identity cannot be observed")
        try:
            names = listed.stdout.decode("utf-8", "strict").splitlines()
        except UnicodeDecodeError as error:
            raise BuildControlError("Docker volume inventory is not UTF-8") from error
        if control.volume in names:
            _fail("existing control volume could not be inspected")
        _fail("bootstrap frontend stop requires its existing control volume")
    try:
        rows = json.loads(result.stdout.decode("utf-8", "strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Docker control-volume inspection is invalid") from error
    if (not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], Mapping)
            or rows[0].get("Name") != control.volume or rows[0].get("Driver") != "local"
            or rows[0].get("Options") or not isinstance(rows[0].get("Labels"), Mapping)
            or any(rows[0]["Labels"].get(key) != value
                   for key, value in control.shared_labels.items())):
        _fail("existing control volume ownership/driver differs")


def _single_id(raw: bytes, service: str) -> str:
    try:
        rows = raw.decode("utf-8", "strict").splitlines()
    except UnicodeDecodeError as error:
        raise BuildControlError("Compose returned an invalid " + service + " ID") from error
    if len(rows) != 1 or CONTAINER_RE.fullmatch(rows[0]) is None:
        _fail("Compose did not identify one exact " + service + " container")
    return rows[0]


def _json_rows(raw: bytes, label: str) -> list[dict[str, object]]:
    try:
        value = json.loads(raw.decode("utf-8", "strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError(label + " is not valid UTF-8 JSON") from error
    if not isinstance(value, list) or any(not isinstance(item, Mapping) for item in value):
        _fail(label + " is not an array of objects")
    return [dict(item) for item in value]


def _service_state(actual: Mapping[str, object], service: str) -> Mapping[str, object]:
    state = actual.get("State")
    if not isinstance(state, Mapping):
        _fail(service + " state observation is incomplete")
    return state


def _require_stopped(actual: Mapping[str, object], service: str) -> None:
    state = _service_state(actual, service)
    if (state.get("Status") != "exited" or state.get("Running") is not False
            or state.get("Paused") is not False or state.get("Restarting") is not False
            or state.get("OOMKilled") is not False or state.get("Dead") is not False
            or type(state.get("Pid")) is not int or state["Pid"] != 0
            or state.get("Error") not in ("", None)):
        _fail(service + " is not strictly stopped")


def _frontend_running(actual: Mapping[str, object]) -> bool:
    state = _service_state(actual, "frontend")
    if state.get("Running") is True:
        if (state.get("Status") != "running" or type(state.get("Pid")) is not int
                or state["Pid"] <= 0 or state.get("Paused") is not False
                or state.get("Restarting") is not False or state.get("OOMKilled") is not False
                or state.get("Dead") is not False or state.get("Error") not in ("", None)):
            _fail("frontend is neither running nor strictly stopped")
        return True
    if state.get("Running") is False:
        _require_stopped(actual, "frontend")
        return False
    _fail("frontend running state is ambiguous")


def _service_fingerprint(actual: Mapping[str, object], service: str) -> dict[str, object]:
    state = _service_state(actual, service)
    started_at = state.get("StartedAt")
    restart_count = actual.get("RestartCount", 0)
    config, host = actual.get("Config"), actual.get("HostConfig")
    mounts = actual.get("Mounts")
    if (not isinstance(started_at, str) or not started_at
            or type(restart_count) is not int or restart_count < 0
            or not isinstance(config, Mapping) or not isinstance(host, Mapping)
            or not isinstance(mounts, list) or any(not isinstance(item, Mapping) for item in mounts)):
        _fail(service + " stable config/mount/incarnation fingerprint is incomplete")
    normalized_mounts = []
    for mount in mounts:
        normalized_mounts.append({key: mount.get(key) for key in (
            "Type", "Name", "Source", "Destination", "Driver", "Mode", "RW", "Propagation",
        )})
    normalized_mounts.sort(key=lambda item: (str(item["Destination"]), str(item["Source"])))
    network_settings = actual.get("NetworkSettings", {})
    networks = network_settings.get("Networks", {}) if isinstance(network_settings, Mapping) else {}
    if not isinstance(networks, Mapping):
        _fail(service + " network fingerprint is malformed")
    network_fingerprint = {
        name: {
            "NetworkID": item.get("NetworkID"),
            "Aliases": item.get("Aliases"),
            "Links": item.get("Links"),
        }
        for name, item in sorted(networks.items()) if isinstance(item, Mapping)
    }
    stable = {
        "config": dict(config),
        "host_config": dict(host),
        "mounts": normalized_mounts,
        "networks": network_fingerprint,
    }
    return {
        "container_id": actual.get("Id"),
        "image_id": actual.get("Image"),
        "started_at": started_at,
        "restart_count": restart_count,
        "config_mount_sha256": _sha(canonical(stable)),
    }


def _read_runtime_records(control) -> dict[str, dict[str, str]]:
    paths = {
        "process_receipt": "runtime-control/runtime-service/process-tree.json",
        "owner": "runtime-control/runtime-services/OWNER.json",
        "launch": "runtime-control/runtime-services/LAUNCH.json",
        "config": "runtime-control/runtime-service/docker-all.json",
    }
    records = {}
    for key, path in paths.items():
        raw = bootstrap_stop._read_raw(control, path, maximum=MAX_EVIDENCE_BYTES)
        try:
            text = raw.decode("utf-8", "strict")
        except UnicodeDecodeError as error:
            raise BuildControlError("Native evidence is not UTF-8: " + key) from error
        records[key] = {"path": path, "raw_utf8": text, "sha256": _sha(raw)}
    return records


def _observe(args, selected, identity, control) -> dict[str, object]:
    from docker_compose_identity import validate_source_labels
    from docker_volume_dev import _validate_retained_service
    from docker_volume_stop_diagnostic import _port_matches
    from docker_volume_stop_unadmitted import _validate_network
    from docker_volume_container_recovery import _abrupt_network, _validate_owner_host

    reference = {
        "attempt": args.bootstrap_stop_attempt,
        "sha256": args.bootstrap_stop_sha256,
    }
    evidence = recovery.collect(control, reference)
    records = evidence.get("records")
    if not isinstance(records, Mapping):
        _fail("frozen bootstrap-stop evidence has no record inventory")
    try:
        terminal_raw = records["stop"]["raw_utf8"].encode("utf-8")
        terminal = bootstrap_stop._json(terminal_raw, "bootstrap stop terminal")
        compose_raw = records["compose"]["raw_utf8"].encode("utf-8")
        document = bootstrap_stop._json(compose_raw, "retained Compose document")
    except (KeyError, AttributeError, TypeError) as error:
        raise BuildControlError("Frozen bootstrap-stop evidence is malformed") from error
    _need(terminal.get("attempt") == args.attempt, "bootstrap stop belongs to another development attempt")
    _need(terminal.get("source_root") == str(selected), "bootstrap stop belongs to another selected checkout")
    _need(terminal.get("compose_project") == control.project, "bootstrap stop belongs to another Compose group")
    _need(terminal.get("config_sha256") == args.config_sha256, "bootstrap stop config pin differs")
    _need(document.get("name") == control.project, "retained Compose project differs from the selected group")
    services = document.get("services")
    _need(isinstance(services, Mapping) and set(services) == {"backend", "frontend"},
          "retained Compose does not contain exactly backend and frontend")
    _port_matches(document, args.port)

    ids = {
        name: _single_id(compose_capture(document, "ps", "--all", "--quiet", name), name)
        for name in ("backend", "frontend")
    }
    _need(ids["backend"] != ids["frontend"], "backend and frontend identify one container")
    _need(ids["backend"] == terminal.get("backend_container_id")
          and ids["frontend"] == terminal.get("frontend_container_id"),
          "Compose service IDs differ from the completed bootstrap stop")
    actual_rows = _json_rows(docker_capture("inspect", ids["backend"], ids["frontend"]).stdout,
                             "retained service inspection")
    by_id = {row.get("Id"): row for row in actual_rows}
    _need(len(actual_rows) == 2 and set(by_id) == set(ids.values()),
          "retained service inspection is incomplete or ambiguous")
    actual = {name: by_id[identifier] for name, identifier in ids.items()}

    image = terminal.get("image_id")
    _need(isinstance(image, str) and IMAGE_RE.fullmatch(image) is not None,
          "bootstrap stop has no immutable development image ID")
    image_rows = _json_rows(docker_capture("image", "inspect", image).stdout,
                            "retained development image inspection")
    _need(len(image_rows) == 1 and isinstance(image_rows[0].get("Config"), Mapping),
          "retained development image config is incomplete")
    _need(image_rows[0].get("Id") == image, "retained development image identity changed")
    image_config = image_rows[0]["Config"]

    runtime_records = _read_runtime_records(control)
    pins = {
        "development_attempt": args.attempt,
        "source_root": str(selected),
        "compose_project": control.project,
        "compose_config_sha256": args.config_sha256,
        "backend_container_id": ids["backend"],
        "frontend_container_id": ids["frontend"],
        "old_image_id": image,
        **{key + "_sha256": item["sha256"] for key, item in runtime_records.items()},
    }
    validated = recovery.validate(evidence, pins, runtime_records, actual["backend"], control=control)
    _require_stopped(actual["backend"], "backend")
    frontend_running = _frontend_running(actual["frontend"])
    owner_raw = runtime_records["owner"]["raw_utf8"].encode("utf-8")
    owner = bootstrap_stop._json(owner_raw, "retained native owner")
    _validate_owner_host(owner, actual["backend"])

    for service in ("backend", "frontend"):
        row = actual[service]
        labels = row.get("Config", {}).get("Labels", {})
        _need(row.get("Id") == ids[service] and row.get("Image") == image
              and isinstance(labels, Mapping)
              and labels.get("com.docker.compose.project") == control.project
              and labels.get("com.docker.compose.service") == service,
              "retained " + service + " source/image identity differs")
        validate_source_labels(row, identity)
        expected_started_at = (terminal["backend_started_at"] if service == "backend"
                               else validated["frontend_started_at"])
        _validate_retained_service(
            document, row, service, image_config,
            expected_started_at=expected_started_at,
        )
    if frontend_running:
        _validate_network(actual, ids, control.project, allow_stopped_backend=True)
    else:
        _abrupt_network(actual["backend"], actual["frontend"], control.project)

    engine_id = docker_capture("info", "--format", "{{.ID}}", timeout=30).stdout.decode(
        "utf-8", "strict").strip()
    _need(isinstance(engine_id, str) and engine_id and len(engine_id) <= 256
          and not any(ord(character) < 0x20 for character in engine_id),
          "Docker engine identity is unavailable")
    evidence_hashes = {
        key: item["sha256"] for key, item in records.items()
        if isinstance(item, Mapping) and isinstance(item.get("sha256"), str)
    }
    native_hashes = {key: item["sha256"] for key, item in runtime_records.items()}
    plan = {
        "schema": PLAN_SCHEMA,
        "source_root": str(selected),
        "compose_project": control.project,
        "control_volume": control.volume,
        "control_namespace": control.namespace or None,
        "development_attempt": args.attempt,
        "bootstrap_stop": reference,
        "compose_config_sha256": args.config_sha256,
        "compose_raw_sha256": _sha(compose_raw),
        "bootstrap_evidence_sha256": dict(sorted(evidence_hashes.items())),
        "native_evidence_sha256": dict(sorted(native_hashes.items())),
        "engine_id": engine_id,
        "image_id": image,
        "backend_container_id": ids["backend"],
        "frontend_container_id": ids["frontend"],
        "backend_started_at": terminal["backend_started_at"],
        "frontend_started_at": validated["frontend_started_at"],
        "service_fingerprints": {
            name: _service_fingerprint(row, name) for name, row in actual.items()
        },
    }
    return {
        "plan": plan,
        "plan_sha256": _sha(canonical(plan)),
        "ids": ids,
        "backend": actual["backend"],
        "frontend": actual["frontend"],
        "frontend_running": frontend_running,
        "owner_sha256": native_hashes["owner"],
    }


def _assert_preview_consumers(control, ids: Mapping[str, str]) -> None:
    from docker_volume_unclaimed_cancellation import _project_container_ids, _volume_consumer_ids

    expected = set(ids.values())
    if (_project_container_ids(control.project) != expected
            or _volume_consumer_ids(control.volume) != expected):
        _fail("Compose project or control volume has an unknown consumer")


def _assert_group_consumers(control, operation, ids: Mapping[str, str], expected_helper_id=None) -> str:
    from docker_volume_unclaimed_cancellation import _project_container_ids, _volume_consumer_ids

    helper_id = control._pin_operation_helper(operation)
    live_id = control._assert_live_operation_helper(operation)
    if live_id != helper_id or (expected_helper_id is not None and helper_id != expected_helper_id):
        _fail("BuildControl helper identity changed during frontend stop")
    expected = set(ids.values()) | {helper_id}
    if (_project_container_ids(control.project) != expected
            or _volume_consumer_ids(control.volume) != expected):
        _fail("Compose project or control volume has an unknown consumer")
    return helper_id


def _publish_intent(control, relative: str, raw: bytes) -> None:
    from docker_volume_unclaimed_cancellation import _publish_immutable

    _publish_immutable(control, relative, raw)


def _result(snapshot, *, state: str, intent_sha256: str | None = None) -> dict[str, object]:
    plan = snapshot["plan"]
    return {
        "schema": SCHEMA,
        "state": state,
        "plan_sha256": snapshot["plan_sha256"],
        "intent_sha256": intent_sha256,
        "bootstrap_stop_attempt": plan["bootstrap_stop"]["attempt"],
        "development_attempt": plan["development_attempt"],
        "engine_id": plan["engine_id"],
        "backend_container_id": plan["backend_container_id"],
        "frontend_container_id": plan["frontend_container_id"],
        "backend_running": False,
        "frontend_running": False,
        "native_owner_state": "ready-history-preserved",
        "native_owner_sha256": snapshot["owner_sha256"],
        "resource_leases": "untouched",
        "session_store": "untouched",
        "native_drain_claimed": False,
        "solve_replayed": False,
        "new_session_store_created": False,
    }


def run(args: argparse.Namespace) -> dict[str, object]:
    """Preview or apply the exact managed frontend stop."""
    _validate_args(args)
    selected, identity, control = _build_context(args)

    if not args.apply:
        snapshot = _observe(args, selected, identity, control)
        _assert_preview_consumers(control, snapshot["ids"])
        return {
            "schema": SCHEMA,
            "state": "preview",
            "plan": snapshot["plan"],
            "expected_plan_sha256": snapshot["plan_sha256"],
            "frontend_running": snapshot["frontend_running"],
            "backend_running": False,
        }

    # Qualify the explicit plan before normalizing permissions or starting the
    # operation helper. A stale plan cannot trigger control-volume preparation.
    qualified = _observe(args, selected, identity, control)
    _need(qualified["plan_sha256"] == args.expected_plan_sha256,
          "current bootstrap/frontend evidence differs from the reviewed preview plan")
    _assert_preview_consumers(control, qualified["ids"])
    control.prepare()

    operation_inputs = {
        "development_attempt": args.attempt,
        "bootstrap_stop_attempt": args.bootstrap_stop_attempt,
        "bootstrap_stop_sha256": args.bootstrap_stop_sha256,
        "config_sha256": args.config_sha256,
        "source_root": str(selected),
        "port": args.port,
        "expected_plan_sha256": args.expected_plan_sha256,
        "execution_state": "unknown",
    }
    with control.operation(PHASE, operation_inputs) as operation:
        operation["receipt"].update(state="authenticating-bootstrap-frontend-stop",
                                    execution_state="unknown")
        initial = _observe(args, selected, identity, control)
        _need(initial["plan_sha256"] == qualified["plan_sha256"],
              "bootstrap/frontend evidence changed after control preparation")
        helper_id = _assert_group_consumers(control, operation, initial["ids"])

        intent = {
            "schema": "fullmag.docker-bootstrap-frontend-stop-intent.v1",
            "state": "intent-written-before-signal",
            "plan_sha256": initial["plan_sha256"],
            "bootstrap_stop_attempt": args.bootstrap_stop_attempt,
            "bootstrap_stop_sha256": args.bootstrap_stop_sha256,
            "development_attempt": args.attempt,
            "backend_container_id": initial["ids"]["backend"],
            "frontend_container_id": initial["ids"]["frontend"],
            "frontend_started_at": initial["plan"]["frontend_started_at"],
            "engine_id": initial["plan"]["engine_id"],
            "frontend_was_running": initial["frontend_running"],
            "owner_sha256": initial["owner_sha256"],
        }
        intent_raw = canonical(intent) + b"\n"
        intent_path = operation["root"] + "/frontend-stop-intent.json"
        if control.read_bytes(intent_path, optional=True) is not None:
            _fail("frontend-stop intent already exists for this operation")
        _publish_intent(control, intent_path, intent_raw)
        if control.read_bytes(intent_path) != intent_raw:
            _fail("immutable frontend-stop intent did not round-trip exactly")
        intent_sha256 = _sha(intent_raw)

        # Intent publication may take time. Re-authenticate the full bridge
        # immediately before any signal, including the native and stop bytes.
        pre_signal = _observe(args, selected, identity, control)
        _need(pre_signal["plan_sha256"] == initial["plan_sha256"],
              "bootstrap/native/service fingerprint changed after frontend-stop intent")
        if not initial["frontend_running"] and pre_signal["frontend_running"]:
            _fail("frontend started after preview; refusing to signal a new lifecycle state")

        if pre_signal["frontend_running"]:
            helper_id = _assert_group_consumers(control, operation, pre_signal["ids"], helper_id)
            operation["receipt"].update(state="stopping-bootstrap-frontend",
                                        frontend_stop_intent_sha256=intent_sha256,
                                        helper_container_id=helper_id,
                                        execution_state="unknown")
            operation["daemon_pending"] = True
            docker_capture("stop", "--signal", "SIGTERM", "--time", "-1",
                           pre_signal["ids"]["frontend"], timeout=90)

        final = _observe(args, selected, identity, control)
        _need(final["plan_sha256"] == initial["plan_sha256"],
              "bootstrap/native/service fingerprint changed during frontend stop")
        _need(final["frontend_running"] is False,
              "frontend stop was not confirmed for the exact retained incarnation")
        helper_id = _assert_group_consumers(control, operation, final["ids"], helper_id)
        operation["daemon_pending"] = False
        stopped_state = ("stopped-confirmed" if pre_signal["frontend_running"]
                         else "already-stopped-confirmed")
        operation["receipt"].update(
            state="succeeded",
            stop_state=stopped_state,
            execution_state="unknown",
            frontend_stop_intent_sha256=intent_sha256,
            frontend_container_id=final["ids"]["frontend"],
            backend_container_id=final["ids"]["backend"],
            backend_running=False,
            frontend_running=False,
            native_owner_state="ready-history-preserved",
            native_owner_sha256=final["owner_sha256"],
            resource_leases="untouched",
            session_store="untouched",
            native_drain_claimed=False,
            solve_replayed=False,
            new_session_store_created=False,
            helper_container_id=helper_id,
        )
        return _result(final, state=stopped_state, intent_sha256=intent_sha256)
