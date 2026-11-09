"""Finish one exact fresh-state archive after its original writer ended unknown.

This narrow continuation never repeats Compose stop/rm or starts services.  It
uses the retained operation helper and existing runtime archiver, then writes
the ordinary succeeded operation records with terminal.json last so the
original helper can release its own active marker.
"""
from __future__ import annotations

import argparse
import base64
from collections.abc import Mapping
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
from typing import Any

from docker_build_control import (
    BuildControl,
    BuildControlError,
    MAX_DOCUMENT_BYTES,
    bounded_capture,
    canonical,
    docker_capture,
)
from docker_dev_host import docker_argv, require_host


ATTEMPT = re.compile(r"[0-9a-f]{32}\Z")
CONTAINER = re.compile(r"[0-9a-f]{64}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
PLAN_SCHEMA = "fullmag.docker-interrupted-fresh-archive-plan.v1"
INTENT_SCHEMA = "fullmag.docker-interrupted-fresh-archive-intent.v1"
FINALIZATION_SCHEMA = "fullmag.docker-interrupted-fresh-archive-finalization.v1"
MAX_RECORD_BYTES = MAX_DOCUMENT_BYTES


def _fail(message: str) -> None:
    raise BuildControlError(message)


def strict_object(raw: bytes, label: str) -> dict[str, Any]:
    """Parse one bounded JSON object and reject duplicate keys."""
    if not isinstance(raw, bytes) or len(raw) > MAX_RECORD_BYTES:
        _fail(label + " is not a bounded byte document")

    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                _fail(label + " contains duplicate JSON keys")
            value[key] = item
        return value

    try:
        value = json.loads(raw, object_pairs_hook=unique)
    except (TypeError, ValueError) as error:
        raise BuildControlError(label + " is not valid JSON") from error
    if not isinstance(value, dict):
        _fail(label + " is not an object")
    return value


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _require_sha(value: object, label: str) -> str:
    if not isinstance(value, str) or SHA256.fullmatch(value) is None:
        _fail(label + " is not a lowercase SHA-256")
    return value


def validate_pins(pins: Mapping[str, object]) -> dict[str, str]:
    if not isinstance(pins, Mapping):
        _fail("Interrupted archive pins are malformed")
    result = dict(pins)
    for key in ("prior_attempt", "recreation_attempt"):
        if not isinstance(result.get(key), str) or ATTEMPT.fullmatch(result[key]) is None:
            _fail("Interrupted archive " + key.replace("_", " ") + " pin is invalid")
    if not isinstance(result.get("config_sha256"), str) or SHA256.fullmatch(result["config_sha256"]) is None:
        _fail("Interrupted archive Compose SHA-256 pin is invalid")
    if not isinstance(result.get("source_root"), str) or not Path(result["source_root"]).is_absolute():
        _fail("Interrupted archive source root pin is not absolute")
    _require_sha(result.get("unknown_receipt_sha256"), "Original unknown receipt pin")
    if not isinstance(result.get("helper_container_id"), str) or CONTAINER.fullmatch(result["helper_container_id"]) is None:
        _fail("Interrupted archive full helper ID pin is invalid")
    image = result.get("helper_image")
    if not isinstance(image, str) or not re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}|sha256:[0-9a-f]{64}", image):
        _fail("Interrupted archive helper image pin must be immutable")
    engine = result.get("engine_id")
    if not isinstance(engine, str) or not engine or len(engine.encode("utf-8")) > 256 or "\x00" in engine:
        _fail("Interrupted archive Docker Engine ID pin is invalid")
    return result


def validate_unknown_receipt(raw: bytes, pins: Mapping[str, object]) -> dict[str, Any]:
    pins = validate_pins(pins)
    if _sha(raw) != pins["unknown_receipt_sha256"]:
        _fail("Original unknown recreation receipt SHA-256 differs")
    receipt = strict_object(raw, "Original unknown recreation receipt")
    inputs = receipt.get("inputs")
    if (receipt.get("schema") != "fullmag.docker-build-operation.v1"
            or receipt.get("phase") != "recreate-services"
            or receipt.get("state") != "outcome-unknown-resources-retained"
            or receipt.get("attempt") != pins["recreation_attempt"]
            or receipt.get("fresh_state") is not True
            or not isinstance(inputs, Mapping)
            or inputs.get("attempt") != pins["prior_attempt"]
            or inputs.get("config_sha256") != pins["config_sha256"]
            or receipt.get("helper_container") != "fullmag-control-" + pins["recreation_attempt"]
            or receipt.get("error") != "Archived group ledger still has a container consumer"):
        _fail("Unknown recreation receipt does not match the exact fresh-state operation pins")
    started = receipt.get("started_at")
    finished = receipt.get("finished_at")
    if (type(started) not in (int, float) or not math.isfinite(started)
            or type(finished) not in (int, float) or not math.isfinite(finished)
            or finished < started):
        _fail("Original unknown receipt has no finalized bounded host-writer timestamp")
    return receipt


def select_receipt_documents(
    authoritative_raw: bytes,
    original_sidecar_raw: bytes | None,
    pins: Mapping[str, object],
    *,
    continuation_intent_exists: bool,
):
    """Return current and original receipt docs across a partial final CAS."""
    if original_sidecar_raw is None:
        original = validate_unknown_receipt(authoritative_raw, pins)
        return original, original, authoritative_raw
    original = validate_unknown_receipt(original_sidecar_raw, pins)
    if authoritative_raw != original_sidecar_raw and not continuation_intent_exists:
        _fail("Authoritative receipt changed without this continuation's durable intent")
    authoritative = original if authoritative_raw == original_sidecar_raw else strict_object(
        authoritative_raw, "Partially published recreation receipt"
    )
    return authoritative, original, original_sidecar_raw


def validate_snapshot(
    pins: Mapping[str, object],
    receipt: Mapping[str, object],
    previous: Mapping[str, object],
    compose: Mapping[str, object],
    retained: Mapping[str, object],
    recovery: Mapping[str, object],
    *,
    identity: Mapping[str, object],
    control_volume: str,
    namespace: str,
) -> dict[str, object]:
    """Validate only retained records; this function never inspects old IDs."""
    pins = validate_pins(pins)
    prior = pins["prior_attempt"]
    recreation = pins["recreation_attempt"]
    project = identity.get("project_name")
    source_root = pins["source_root"]
    inputs = previous.get("inputs") if isinstance(previous, Mapping) else None
    receipt_inputs = receipt.get("inputs") if isinstance(receipt, Mapping) else None
    if (not isinstance(project, str) or identity.get("source_root") != source_root
            or receipt.get("schema") != "fullmag.docker-build-operation.v1"
            or receipt.get("phase") != "recreate-services"
            or receipt.get("state") != "outcome-unknown-resources-retained"
            or receipt.get("attempt") != recreation
            or receipt.get("fresh_state") is not True
            or receipt.get("helper_container") != "fullmag-control-" + recreation
            or previous.get("schema") != "fullmag.docker-build-operation.v1"
            or previous.get("phase") != "development"
            or previous.get("state") != "succeeded"
            or previous.get("attempt") != prior
            or previous.get("compose_project") != project
            or previous.get("config_sha256") != pins["config_sha256"]
            or not isinstance(inputs, Mapping)
            or inputs.get("source_root") != source_root
            or inputs.get("image_id") != recovery.get("image_id")
            or inputs.get("source_project_id") != identity.get("project_id")
            or inputs.get("source_worktree_id") != identity.get("worktree_id")
            or inputs.get("source_checkout_kind") != identity.get("checkout_kind")):
        _fail("Prior successful development authority differs from the source/configuration pins")
    if (compose.get("name") != project
            or hashlib.sha256(canonical(dict(compose))).hexdigest() != pins["config_sha256"]):
        _fail("Prior canonical Compose document differs from its pinned configuration")

    previous_state = previous.get("state_root")
    if (not isinstance(previous_state, str) or not Path(previous_state).is_absolute()
            or receipt.get("previous_state_root") != previous_state
            or receipt.get("compose_project") != project
            or receipt.get("control_volume") != control_volume
            or receipt.get("control_namespace", "") != namespace
            or receipt_inputs.get("attempt") != prior
            or receipt_inputs.get("config_sha256") != pins["config_sha256"]):
        _fail("Unknown recreation receipt does not bind the prior state and control namespace")

    if (recovery.get("schema") != "fullmag.cancelled-activation-recovery.v1"
            or recovery.get("state") != "stopped-awaiting-fresh-archive"
            or recovery.get("development_attempt") != prior
            or recovery.get("config_sha256") != pins["config_sha256"]
            or recovery.get("source_root") != source_root
            or recovery.get("compose_project") != project
            or recovery.get("control_volume") != control_volume
            or recovery.get("control_namespace", "") != namespace
            or recovery.get("state_root") != previous_state
            or recovery.get("image_id") != inputs.get("image_id")
            or recovery.get("restart_policy") != "fresh-state-only"
            or recovery.get("execution_state") != "not-started"):
        _fail("Canonical cancelled-activation recovery does not qualify this fresh archive")
    for field in ("activation_attempt", "original_receipt_sha256", "journal_sha256", "source_sha256"):
        value = recovery.get(field)
        if not isinstance(value, str) or not value:
            _fail("Cancelled-activation recovery is missing " + field)
    for field in ("original_receipt_sha256", "journal_sha256", "source_sha256"):
        _require_sha(recovery.get(field), "Cancelled recovery " + field)

    ids: dict[str, str] = {}
    for service in ("backend", "frontend"):
        row = retained.get(service) if isinstance(retained, Mapping) else None
        config = row.get("Config") if isinstance(row, Mapping) else None
        labels = config.get("Labels") if isinstance(config, Mapping) else None
        identifier = row.get("Id") if isinstance(row, Mapping) else None
        state = row.get("State") if isinstance(row, Mapping) else None
        if (not isinstance(identifier, str) or CONTAINER.fullmatch(identifier) is None
                or not isinstance(labels, Mapping)
                or labels.get("com.docker.compose.project") != project
                or labels.get("com.docker.compose.service") != service
                or not isinstance(state, Mapping)):
            _fail("Retained " + service + " container snapshot is malformed")
        ids[service] = identifier
    if (ids["backend"] != recovery.get("backend_container")
            or ids["frontend"] != recovery.get("frontend_container")
            or ids["backend"] != previous.get("backend_container")
            or ids["frontend"] != previous.get("frontend_container")):
        _fail("Retained service IDs differ from the prior and cancelled recovery records")
    backend_state = retained["backend"]["State"]
    frontend_state = retained["frontend"]["State"]
    if (backend_state.get("Running") is not False or backend_state.get("ExitCode") != 0
            or backend_state.get("StartedAt") != recovery.get("backend_started_at")
            or frontend_state.get("StartedAt") != recovery.get("frontend_started_at")):
        _fail("Retained backend drain or frontend incarnation differs from the cancellation proof")
    return {
        "compose_project": project,
        "control_volume": control_volume,
        "control_namespace": namespace,
        "source_root": source_root,
        "prior_attempt": prior,
        "recreation_attempt": recreation,
        "config_sha256": pins["config_sha256"],
        "previous_state_root": previous_state,
        "removed_containers": [ids["backend"], ids["frontend"]],
        "retained_containers": ids,
        "image_id": inputs["image_id"],
        "frontend_snapshot_state": (
            "pre-stop-running" if frontend_state.get("Running") is True
            else "captured-state-unknown"
        ),
        "cancelled_activation_attempt": recovery["activation_attempt"],
        "cancelled_recovery_sha256": hashlib.sha256(canonical(dict(recovery))).hexdigest(),
        "cancelled_journal_sha256": recovery["journal_sha256"],
        "cancelled_original_receipt_sha256": recovery["original_receipt_sha256"],
        "cancelled_source_sha256": recovery["source_sha256"],
    }


def make_plan(evidence: Mapping[str, object]) -> dict[str, object]:
    if not isinstance(evidence, Mapping):
        _fail("Interrupted archive plan evidence is malformed")
    plan = {"schema": PLAN_SCHEMA, **dict(evidence)}
    if "created_at" in plan or "observed_at" in plan:
        _fail("Interrupted archive plan must not depend on wall-clock time")
    return plan


def plan_sha256(plan: Mapping[str, object]) -> str:
    if not isinstance(plan, Mapping) or plan.get("schema") != PLAN_SCHEMA:
        _fail("Interrupted archive plan schema is invalid")
    return _sha(canonical(dict(plan)))


def validate_publication_state(
    current_raw: bytes,
    original_raw: bytes,
    final_raw: bytes,
    *,
    expected_sha256: str | None,
) -> None:
    """Allow only untouched unknown or this exact final CAS value."""
    original_sha = _sha(original_raw)
    if expected_sha256 != original_sha:
        _fail("Interrupted archive receipt baseline SHA differs from its immutable original")
    if _sha(current_raw) not in {original_sha, _sha(final_raw)}:
        _fail("Interrupted archive receipt contains a conflicting publication")


def _observer_script(token: str, root: str) -> str:
    if ATTEMPT.fullmatch(token) is None or not Path(root).is_absolute() or "'" in root:
        _fail("Continuation observer path or attempt is invalid")
    attempt_root = root.rstrip("/") + "/recreate-services/attempts/" + token
    lock = attempt_root + "/interrupted-fresh-archive.lock"
    terminal = attempt_root + "/terminal.json"
    active = root.rstrip("/") + "/active"
    return "\n".join((
        "set -euo pipefail",
        "token=" + shlex.quote(token),
        "lock=" + shlex.quote(lock),
        "terminal=" + shlex.quote(terminal),
        "active=" + shlex.quote(active),
        'parent=${lock%/*}',
        'test ! -L "$parent" && test -d "$parent"',
        'test "$(readlink -f -- "$parent")" = "$parent"',
        'test "$(stat -c %u:%g -- "$parent")" = "$(id -u):$(id -g)"',
        'test "$(stat -c %a -- "$parent")" = 750',
        'test -f "$active" && test "$(cat -- "$active")" = "$token"',
        'if ! test -e "$lock" && ! test -L "$lock"; then (umask 027; set -o noclobber; : >"$lock") 2>/dev/null || true; fi',
        'test ! -L "$lock" && test -f "$lock"',
        'test "$(readlink -f -- "$lock")" = "$lock"',
        'test "$(stat -c %h -- "$lock")" = 1',
        'test "$(stat -c %u:%g -- "$lock")" = "$(id -u):$(id -g)"',
        'test "$(stat -c %a -- "$lock")" = 640',
        'exec 9<>"$lock"',
        'test "$(stat -Lc %d:%i /proc/$$/fd/9)" = "$(stat -c %d:%i -- "$lock")"',
        'test ! -L "$lock" && test "$(stat -c %h -- "$lock")" = 1',
        "flock -n 9",
        "printf 'READY\\n'",
        'IFS= read -r command || exit 90',
        'test "$command" = LOGGED',
        "printf 'LOGGED\\n'",
        # If the host command disappears, docker closes this exec's stdin and
        # cat exits, releasing this second lock. The original helper's own
        # operation lease and active marker remain untouched.
        'cat <&0 >/dev/null & input_pid=$!',
        'while test ! -f "$terminal"; do',
        '  if ! kill -0 "$input_pid" 2>/dev/null; then wait "$input_pid" 2>/dev/null || true; exit 0; fi',
        "  sleep 0.1",
        "done",
        'kill "$input_pid" 2>/dev/null || true',
        'wait "$input_pid" 2>/dev/null || true',
    ))


def observer_script(token: str, root: str = "/control") -> str:
    """Private shell generator; the alternate root is used only by local tests."""
    return _observer_script(token, root)


def _json_optional(control: BuildControl, path: str):
    raw = control.read_bytes(path, optional=True, maximum=MAX_RECORD_BYTES)
    if raw is None:
        return None, None
    return strict_object(raw, path), raw


def _raw_optional(control: BuildControl, path: str):
    return control.read_bytes(path, optional=True, maximum=MAX_RECORD_BYTES)


def _check_host_writer_processes(prior_attempt: str, recreation_attempt: str) -> list[list[str]]:
    if os.name != "posix":
        _fail("Interrupted archive requires a bounded POSIX host process inventory")
    try:
        result = subprocess.run(
            ["ps", "-eo", "pid=,args="], check=False, capture_output=True,
            timeout=10, text=True, encoding="utf-8", errors="replace",
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise BuildControlError("Cannot inventory possible original host writer processes") from error
    if result.returncode:
        _fail("Host process inventory failed; original writer closure is unknown")
    current_pid = os.getpid()
    matches = []
    for line in result.stdout.splitlines():
        row = line.strip()
        if not row:
            continue
        pieces = row.split(None, 1)
        if len(pieces) != 2:
            _fail("Host process inventory contains a malformed row")
        pid_text, command = pieces
        try:
            pid = int(pid_text)
        except ValueError:
            _fail("Host process inventory contains a malformed PID")
        if pid == current_pid:
            continue
        try:
            argv = shlex.split(command)
        except ValueError:
            if "docker_dev.py" in command:
                _fail("Possible original writer has malformed command-line evidence")
            continue
        is_launcher = (any(Path(arg).name == "docker_dev.py" for arg in argv)
                       or re.search(r"(?:^|/)docker_dev\.py(?=\s|$)", command) is not None)
        if is_launcher and {prior_attempt, recreation_attempt} & set(argv):
            matches.append([str(pid), "docker_dev.py", prior_attempt, recreation_attempt])
    if matches:
        _fail("An original docker_dev writer process is still present")
    return matches


def _inspect_pinned_helper(control: BuildControl, recreation_attempt: str,
                           expected_id: str, expected_image: str) -> dict[str, object]:
    from docker_volume_fresh_runtime import _container_ids, _inspect_one
    name = "fullmag-control-" + recreation_attempt
    helper = _inspect_one(name)
    config = helper.get("Config")
    state = helper.get("State")
    expected_command = control.helper_args(
        control.operation_script("recreate-services", recreation_attempt), name=name
    )
    entrypoint_index = expected_command.index("--entrypoint")
    if (helper.get("Id") != expected_id or helper.get("Name") != "/" + name
            or not isinstance(config, Mapping) or config.get("Image") != expected_image
            or expected_image != control.image or not isinstance(state, Mapping)
            or state.get("Running") is not True
            or helper.get("Path") != expected_command[entrypoint_index + 1]
            or helper.get("Args") != expected_command[entrypoint_index + 3:]):
        _fail("Pinned original operation helper identity/command differs")
    image_rows = json.loads(docker_capture("image", "inspect", expected_image, timeout=60).stdout)
    if len(image_rows) != 1 or helper.get("Image") != image_rows[0].get("Id"):
        _fail("Pinned original operation helper image ID differs")
    from docker_compose_identity import source_labels
    expected_labels = {
        **control.labels,
        **source_labels(control.identity),
        "com.docker.compose.project": control.project,
        "com.docker.compose.service": "build-control",
    }
    labels = config.get("Labels")
    if not isinstance(labels, Mapping) or any(labels.get(k) != v for k, v in expected_labels.items()):
        _fail("Pinned original operation helper labels differ")
    expected_mounts = {"/control": True}
    if control.namespace:
        expected_mounts["/registry"] = False
    mounts = helper.get("Mounts")
    observed = {}
    if not isinstance(mounts, list) or len(mounts) != len(expected_mounts):
        _fail("Pinned original operation helper mount set is ambiguous")
    for mount in mounts:
        if not isinstance(mount, Mapping):
            _fail("Pinned original operation helper mount is malformed")
        destination = mount.get("Destination")
        if (destination not in expected_mounts or mount.get("Type") != "volume"
                or mount.get("Name") != control.volume
                or type(mount.get("RW")) is not bool
                or mount.get("RW") is not expected_mounts[destination]
                or destination in observed):
            _fail("Pinned original operation helper mount identity differs")
        observed[destination] = mount["RW"]
    if observed != expected_mounts:
        _fail("Pinned original operation helper mount set differs")
    volume_rows = json.loads(docker_capture("volume", "inspect", control.volume, timeout=60).stdout)
    if (len(volume_rows) != 1 or volume_rows[0].get("Name") != control.volume
            or volume_rows[0].get("Driver") != "local" or volume_rows[0].get("Options")
            or not isinstance(volume_rows[0].get("Labels"), Mapping)
            or any(volume_rows[0]["Labels"].get(k) != v for k, v in control.shared_labels.items())):
        _fail("Pinned original operation control volume identity differs")
    volume_ids = _container_ids("--filter", "volume=" + control.volume)
    project_ids = _container_ids("--filter", "label=com.docker.compose.project=" + control.project)
    if volume_ids != {expected_id} or project_ids != {expected_id}:
        _fail("Only the exact original operation helper may consume the control volume")
    return helper


def _assert_engine(expected: str) -> None:
    observed = docker_capture("info", "--format", "{{.ID}}", timeout=30).stdout.decode("utf-8", "strict").strip()
    if observed != expected:
        _fail("Docker Engine ID changed from the explicit pin")


def _assert_active_marker(helper_id: str, attempt: str) -> None:
    result = docker_capture("exec", helper_id, "/bin/bash", "-euo", "pipefail", "-c",
                            'test "$(cat /control/active)" = ' + shlex.quote(attempt), timeout=20)
    if result.returncode:
        _fail("Original helper no longer owns the exact active marker")


def _assert_logged(helper_id: str) -> str:
    from docker_build_control import MAX_LOG_BYTES
    output = bounded_capture(
        docker_argv("logs", helper_id), timeout=30, maximum=MAX_LOG_BYTES + 4096,
    ).stdout
    lines = output.decode("utf-8", "replace").splitlines()
    if lines.count("READY") != 1 or lines.count("LOGGED") != 1:
        _fail("Original helper logs do not show one READY and one LOGGED acknowledgment")
    return _sha(output)


def _archive_inode_evidence(control: BuildControl, helper_id: str, attempt: str):
    from docker_volume_fresh_runtime import (
        _archive_preflight, _retained_group_ledger_binding,
    )
    retained = control.read("recreate-services/attempts/" + attempt + "/retained-containers.json")
    operation = {"receipt": control.read("recreate-services/attempts/" + attempt + "/receipt.json")}
    binding = _retained_group_ledger_binding(control, operation, retained)
    if (binding.get("private") is not True or binding.get("volume_name") != control.volume
            or binding.get("control_role_path") != "private/ledger"
            or binding.get("control_leaf_path") != "private/ledger/ledger"):
        _fail("Interrupted archive is not the pinned ADR 0076 private group-ledger layout")
    evidence = _archive_preflight(helper_id, "private/ledger")
    return {"ledger_binding": binding, "inode_evidence": evidence}


def _read_recovery_evidence(control: BuildControl, pins: Mapping[str, object]):
    from docker_volume_cancelled_activation_guard import RECORD, read_record
    record = read_record(control)
    if record is None:
        _fail("Canonical cancelled-activation recovery record is absent")
    record_raw = control.read_bytes(RECORD, maximum=MAX_RECORD_BYTES)
    if strict_object(record_raw, "Cancelled activation recovery record") != record:
        _fail("Cancelled-activation recovery record changed after authentication")
    journal_raw = control.read_bytes(record["journal_path"], maximum=MAX_RECORD_BYTES)
    if _sha(journal_raw) != record.get("journal_sha256"):
        _fail("Cancelled-activation journal SHA-256 differs from its recovery current record")
    activation_terminal_raw = control.read_bytes(
        "activation/attempts/" + record["activation_attempt"] + "/terminal.json",
        maximum=MAX_RECORD_BYTES,
    )
    activation_terminal = strict_object(activation_terminal_raw, "Cancelled activation terminal")
    if (activation_terminal.get("cancelled_recovery_sha256") != _sha(record_raw)
            or activation_terminal.get("state") != "failed-confirmed"
            or activation_terminal.get("activation_state") != "operator-cancelled-after-confirmed-drain"):
        _fail("Cancelled-activation terminal no longer authenticates its stopped recovery fence")
    if (record.get("development_attempt") != pins["prior_attempt"]
            or record.get("config_sha256") != pins["config_sha256"]
            or record.get("source_root") != pins["source_root"]):
        _fail("Cancelled-activation recovery is for another source/configuration")
    return record, _sha(canonical(record)), _sha(journal_raw)


def _validate_continuation_intent(intent: Mapping[str, object], plan: Mapping[str, object],
                                  plan_sha: str) -> dict[str, object]:
    if (not isinstance(intent, Mapping) or intent.get("schema") != INTENT_SCHEMA
            or intent.get("plan") != dict(plan) or intent.get("plan_sha256") != plan_sha
            or intent.get("original_unknown_receipt_sha256") != plan.get("unknown_receipt_sha256")
            or intent.get("original_unknown_receipt_path") != plan.get("original_unknown_receipt_path")):
        _fail("Existing interrupted-archive continuation intent differs from this plan")
    for key in ("recreate_services_current_sha256", "recreate_services_verified_sha256"):
        value = intent.get(key)
        if value != plan.get(key):
            _fail("Continuation intent does not bind the prior " + key)
    return dict(intent)


def _collect(control: BuildControl, pins: Mapping[str, object]):
    pins = validate_pins(pins)
    _assert_engine(pins["engine_id"])
    _check_host_writer_processes(pins["prior_attempt"], pins["recreation_attempt"])
    helper = _inspect_pinned_helper(
        control, pins["recreation_attempt"], pins["helper_container_id"], pins["helper_image"]
    )
    _assert_active_marker(pins["helper_container_id"], pins["recreation_attempt"])
    logs_sha = _assert_logged(pins["helper_container_id"])
    root = "recreate-services/attempts/" + pins["recreation_attempt"]
    receipt_path = root + "/receipt.json"
    receipt_raw = control.read_bytes(receipt_path, maximum=MAX_RECORD_BYTES)
    original_unknown_path = root + "/interrupted-fresh-archive-original-unknown-receipt.json"
    finalization_path = root + "/interrupted-fresh-archive-finalization.json"
    intent_path = root + "/interrupted-fresh-archive-intent.json"
    sidecar_raw = _raw_optional(control, original_unknown_path)
    outer_intent, outer_raw = _json_optional(control, intent_path)
    receipt, unknown_receipt, unknown_receipt_raw = select_receipt_documents(
        receipt_raw, sidecar_raw, pins,
        continuation_intent_exists=outer_intent is not None,
    )
    previous_root = "development/attempts/" + pins["prior_attempt"]
    previous_raw = control.read_bytes(previous_root + "/terminal.json", maximum=MAX_RECORD_BYTES)
    if (control.read_bytes("development/current.json", maximum=MAX_RECORD_BYTES) != previous_raw
            or control.read_bytes("development/verified.json", maximum=MAX_RECORD_BYTES) != previous_raw):
        _fail("A newer development authority superseded the retained source attempt")
    previous = strict_object(previous_raw, "Prior development terminal")
    compose_raw = control.read_bytes(previous_root + "/compose.json", maximum=MAX_RECORD_BYTES)
    compose = strict_object(compose_raw, "Prior canonical Compose document")
    retained_path = root + "/retained-containers.json"
    retained_raw = control.read_bytes(retained_path, maximum=MAX_RECORD_BYTES)
    retained = strict_object(retained_raw, "Retained application pair")
    recovery, recovery_sha, journal_sha = _read_recovery_evidence(control, pins)
    snapshot = validate_snapshot(
        pins, unknown_receipt, previous, compose, retained, recovery,
        identity=control.identity, control_volume=control.volume, namespace=control.namespace,
    )
    archive_intent_path = root + "/runtime-control-archive-intent.json"
    archive_terminal_path = root + "/runtime-control-archive-terminal.json"
    archive_intent, archive_intent_raw = _json_optional(control, archive_intent_path)
    archive_terminal, archive_terminal_raw = _json_optional(control, archive_terminal_path)
    finalization, finalization_raw = _json_optional(control, finalization_path)
    if outer_intent is None and (archive_intent is not None or archive_terminal is not None
                                 or finalization is not None):
        _fail("Archive state exists without this continuation's durable intent")
    for label, document, raw in (
        ("continuation intent", outer_intent, outer_raw),
        ("runtime archive intent", archive_intent, archive_intent_raw),
        ("runtime archive terminal", archive_terminal, archive_terminal_raw),
        ("finalization record", finalization, finalization_raw),
    ):
        if document is not None and raw != canonical(dict(document)) + b"\n":
            _fail("Existing " + label + " is not canonical newline-terminated JSON")
    if outer_intent is None:
        inode_bundle = _archive_inode_evidence(control, pins["helper_container_id"],
                                               pins["recreation_attempt"])
        inode_evidence = inode_bundle["inode_evidence"]
        current_raw = _raw_optional(control, "recreate-services/current.json")
        verified_raw = _raw_optional(control, "recreate-services/verified.json")
        base_current_sha = "ABSENT" if current_raw is None else _sha(current_raw)
        base_verified_sha = "ABSENT" if verified_raw is None else _sha(verified_raw)
    else:
        if sidecar_raw is None or _sha(sidecar_raw) != pins["unknown_receipt_sha256"]:
            _fail("Continuation intent exists without its immutable original receipt sidecar")
        if not isinstance(outer_intent.get("plan"), Mapping):
            _fail("Continuation intent has no pinned original preview plan")
        stored_plan = dict(outer_intent["plan"])
        plan_sha = plan_sha256(stored_plan)
        _validate_continuation_intent(outer_intent, stored_plan, plan_sha)
        if outer_intent.get("plan_sha256") != plan_sha:
            _fail("Continuation intent plan digest is invalid")
        base_current_sha = outer_intent.get("recreate_services_current_sha256")
        base_verified_sha = outer_intent.get("recreate_services_verified_sha256")
        inode_evidence = stored_plan.get("archive_inode_evidence")
        if archive_intent is not None:
            if not isinstance(archive_intent, Mapping):
                _fail("Existing runtime archive intent is malformed")
            for key, value in (inode_evidence or {}).items():
                if archive_intent.get(key) != value:
                    _fail("Runtime archive intent inode evidence differs from the continuation plan")
        else:
            current_bundle = _archive_inode_evidence(control, pins["helper_container_id"],
                                                     pins["recreation_attempt"])
            if current_bundle["inode_evidence"] != inode_evidence:
                _fail("Runtime root or private-ledger inode changed after preview")
    if base_current_sha != "ABSENT" and SHA256.fullmatch(str(base_current_sha)) is None:
        _fail("Prior recreation current-pointer SHA-256 pin is invalid")
    if base_verified_sha != "ABSENT" and SHA256.fullmatch(str(base_verified_sha)) is None:
        _fail("Prior recreation verified-pointer SHA-256 pin is invalid")
    current_raw = _raw_optional(control, "recreate-services/current.json")
    verified_raw = _raw_optional(control, "recreate-services/verified.json")
    if outer_intent is None:
        pass
    else:
        allowed = {base_current_sha}
        if finalization is not None and isinstance(finalization, Mapping):
            final_sha = finalization.get("final_receipt_sha256")
            if isinstance(final_sha, str) and SHA256.fullmatch(final_sha):
                allowed.add(final_sha)
        current_sha = "ABSENT" if current_raw is None else _sha(current_raw)
        verified_sha = "ABSENT" if verified_raw is None else _sha(verified_raw)
        final_shas = allowed - {base_current_sha}
        if current_sha not in allowed or verified_sha not in ({base_verified_sha} | final_shas):
            _fail("Recreation current/verified pointer changed outside this continuation")
    if sidecar_raw is not None and receipt_raw != sidecar_raw:
        if finalization is None or archive_terminal is None:
            _fail("Receipt publication started before archive and finalization evidence existed")
        final_raw = _decode_finalization(finalization, plan_sha=outer_intent.get("plan_sha256"),
                                         archive_terminal=archive_terminal)
        if receipt_raw != final_raw or receipt.get("state") != "succeeded":
            _fail("Authoritative recreation receipt is neither original unknown nor this final value")
    evidence = {
        **snapshot,
        "schema": PLAN_SCHEMA,
        "operation_attempt": pins["recreation_attempt"],
        "unknown_receipt_sha256": pins["unknown_receipt_sha256"],
        "unknown_receipt_path": receipt_path,
        "original_unknown_receipt_path": original_unknown_path,
        "config_sha256": pins["config_sha256"],
        "source_root": pins["source_root"],
        "helper_container_id": pins["helper_container_id"],
        "helper_image": pins["helper_image"],
        "docker_engine_id": pins["engine_id"],
        "helper_logs_sha256": logs_sha,
        "receipt_inputs_sha256": _sha(canonical(dict(unknown_receipt.get("inputs", {})))),
        "prior_terminal_sha256": _sha(previous_raw),
        "prior_compose_sha256": _sha(compose_raw),
        "retained_containers_sha256": _sha(retained_raw),
        "cancelled_recovery_sha256": recovery_sha,
        "cancelled_journal_sha256": journal_sha,
        "recreate_services_current_sha256": base_current_sha,
        "recreate_services_verified_sha256": base_verified_sha,
        "archive_inode_evidence": inode_evidence,
        "runtime_archive_intent_sha256": None if archive_intent_raw is None else _sha(archive_intent_raw),
        "runtime_archive_terminal_sha256": None if archive_terminal_raw is None else _sha(archive_terminal_raw),
        "finalization_sha256": None if finalization_raw is None else _sha(finalization_raw),
        "control_volume": control.volume,
        "control_namespace": control.namespace,
        "retained_backend_started_at": retained["backend"]["State"]["StartedAt"],
        "retained_frontend_started_at": retained["frontend"]["State"]["StartedAt"],
        "host_writer_processes": [],
        "active_marker": pins["recreation_attempt"],
    }
    plan = make_plan({k: v for k, v in evidence.items() if k != "schema"})
    digest = plan_sha256(plan)
    if outer_intent is not None:
        stored_plan = outer_intent["plan"]
        # Once the first archive command has created its own intent/terminal,
        # those paths are progress evidence rather than changes to the plan.
        for key in ("runtime_archive_intent_sha256", "runtime_archive_terminal_sha256",
                    "finalization_sha256"):
            plan[key] = stored_plan.get(key)
        digest = plan_sha256(plan)
        if plan != stored_plan or digest != outer_intent.get("plan_sha256"):
            _fail("Current evidence no longer matches the original continuation preview")
    return {
        "pins": pins,
        "receipt": receipt,
        "unknown_receipt": unknown_receipt,
        "unknown_receipt_raw": unknown_receipt_raw,
        "receipt_raw": receipt_raw,
        "previous": previous,
        "retained": retained,
        "recovery": recovery,
        "plan": plan,
        "plan_sha256": digest,
        "outer_intent": outer_intent,
        "outer_intent_raw": outer_raw,
        "archive_intent": archive_intent,
        "archive_terminal": archive_terminal,
        "finalization": finalization,
        "finalization_raw": finalization_raw,
        "base_current_sha256": base_current_sha,
        "base_verified_sha256": base_verified_sha,
        "inode_evidence": inode_evidence,
    }


def _prepare_control(source_root: Path, helper_image: str) -> BuildControl:
    try:
        selected = source_root.resolve(strict=True)
    except OSError as error:
        raise BuildControlError("Pinned registered source checkout is unavailable") from error
    if not source_root.is_absolute() or selected != source_root or source_root.is_symlink() or not source_root.is_dir():
        _fail("Pinned source root is not a canonical registered checkout")
    from docker_compose_identity import compose_source_identity
    try:
        identity = compose_source_identity(selected)
    except Exception as error:
        raise BuildControlError("Cannot resolve selected registered Compose identity") from error
    return BuildControl(identity, helper_image)


def preview(args) -> dict[str, object]:
    pins_data = dict(vars(args))
    pins_data["source_root"] = str(args.source_root)
    pins = validate_pins(pins_data)
    control = _prepare_control(Path(pins["source_root"]), pins["helper_image"])
    completed = _completed_publication(control, pins)
    if completed is not None:
        return {
            "schema": "fullmag.docker-interrupted-fresh-archive-preview.v1",
            "action": "preview",
            "plan": completed["plan"],
            "plan_sha256": completed["plan_sha256"],
            "archive_already_terminal": True,
            "finalization_already_present": True,
            "already_succeeded": True,
            "will_start_services": False,
            "will_repeat_stop_or_rm": False,
        }
    evidence = _collect(control, pins)
    return {
        "schema": "fullmag.docker-interrupted-fresh-archive-preview.v1",
        "action": "preview",
        "plan": evidence["plan"],
        "plan_sha256": evidence["plan_sha256"],
        "archive_already_terminal": evidence["archive_terminal"] is not None,
        "finalization_already_present": evidence["finalization"] is not None,
        "will_start_services": False,
        "will_repeat_stop_or_rm": False,
    }


def _completed_publication(control: BuildControl, pins: Mapping[str, object]):
    """Recognize a fully published retry after the original helper self-released."""
    attempt_root = "recreate-services/attempts/" + pins["recreation_attempt"]
    terminal_path = attempt_root + "/terminal.json"
    terminal_raw = _raw_optional(control, terminal_path)
    if terminal_raw is None:
        return None
    receipt_raw = control.read_bytes(attempt_root + "/receipt.json", maximum=MAX_RECORD_BYTES)
    current_raw = control.read_bytes("recreate-services/current.json", maximum=MAX_RECORD_BYTES)
    verified_raw = control.read_bytes("recreate-services/verified.json", maximum=MAX_RECORD_BYTES)
    if any(raw != terminal_raw for raw in (receipt_raw, current_raw, verified_raw)):
        _fail("A terminal recreation publication has inconsistent standard records")
    final_receipt = strict_object(terminal_raw, "Completed interrupted archive receipt")
    if (final_receipt.get("schema") != "fullmag.docker-build-operation.v1"
            or final_receipt.get("phase") != "recreate-services"
            or final_receipt.get("state") != "succeeded"
            or final_receipt.get("attempt") != pins["recreation_attempt"]
            or final_receipt.get("fresh_state") is not True):
        _fail("Existing terminal does not represent this succeeded fresh-state recreation")
    sidecar = control.read_bytes(
        attempt_root + "/interrupted-fresh-archive-original-unknown-receipt.json",
        maximum=MAX_RECORD_BYTES,
    )
    validate_unknown_receipt(sidecar, pins)
    intent = strict_object(
        control.read_bytes(attempt_root + "/interrupted-fresh-archive-intent.json",
                           maximum=MAX_RECORD_BYTES),
        "Completed continuation intent",
    )
    intent_raw = control.read_bytes(attempt_root + "/interrupted-fresh-archive-intent.json",
                                    maximum=MAX_RECORD_BYTES)
    if intent_raw != canonical(intent) + b"\n":
        _fail("Completed continuation intent is not canonical")
    plan = intent.get("plan")
    if not isinstance(plan, Mapping):
        _fail("Completed continuation has no pinned preview plan")
    plan = dict(plan)
    plan_sha = plan_sha256(plan)
    _validate_continuation_intent(intent, plan, plan_sha)
    recovery_provenance = final_receipt.get("interrupted_fresh_archive")
    if (not isinstance(recovery_provenance, Mapping)
            or recovery_provenance.get("continuation_intent_sha256") != _sha(intent_raw)):
        _fail("Completed receipt does not bind the exact continuation intent")
    archive_path = attempt_root + "/runtime-control-archive-terminal.json"
    archive_raw = control.read_bytes(archive_path, maximum=MAX_RECORD_BYTES)
    archive_terminal = strict_object(archive_raw, "Completed runtime archive terminal")
    finalization = strict_object(
        control.read_bytes(attempt_root + "/interrupted-fresh-archive-finalization.json",
                           maximum=MAX_RECORD_BYTES),
        "Completed finalization record",
    )
    finalization_raw = control.read_bytes(
        attempt_root + "/interrupted-fresh-archive-finalization.json", maximum=MAX_RECORD_BYTES
    )
    if finalization_raw != canonical(finalization) + b"\n":
        _fail("Completed finalization record is not canonical")
    if _decode_finalization(finalization, plan_sha=plan_sha,
                            archive_terminal=archive_terminal) != terminal_raw:
        _fail("Completed standard records differ from the durable finalization bytes")
    if final_receipt.get("runtime_control_archive") != archive_terminal:
        _fail("Completed receipt differs from the runtime archive terminal")
    if (plan.get("operation_attempt") != pins["recreation_attempt"]
            or plan.get("prior_attempt") != pins["prior_attempt"]
            or plan.get("config_sha256") != pins["config_sha256"]
            or plan.get("source_root") != pins["source_root"]
            or plan.get("unknown_receipt_sha256") != pins["unknown_receipt_sha256"]
            or plan.get("helper_container_id") != pins["helper_container_id"]
            or plan.get("helper_image") != pins["helper_image"]
            or plan.get("docker_engine_id") != pins["engine_id"]):
        _fail("Completed continuation plan does not match the explicit operator pins")
    _assert_engine(pins["engine_id"])
    record, record_sha, journal_sha = _read_recovery_evidence(control, pins)
    if (record_sha != plan.get("cancelled_recovery_sha256")
            or journal_sha != plan.get("cancelled_journal_sha256")):
        _fail("Completed cancellation evidence differs from the pinned continuation plan")
    previous_root = "development/attempts/" + pins["prior_attempt"]
    previous_raw = control.read_bytes(previous_root + "/terminal.json", maximum=MAX_RECORD_BYTES)
    compose_raw = control.read_bytes(previous_root + "/compose.json", maximum=MAX_RECORD_BYTES)
    retained_raw = control.read_bytes(attempt_root + "/retained-containers.json",
                                      maximum=MAX_RECORD_BYTES)
    if (previous_raw != control.read_bytes("development/current.json", maximum=MAX_RECORD_BYTES)
            or previous_raw != control.read_bytes("development/verified.json", maximum=MAX_RECORD_BYTES)
            or _sha(previous_raw) != plan.get("prior_terminal_sha256")
            or _sha(compose_raw) != plan.get("prior_compose_sha256")
            or _sha(retained_raw) != plan.get("retained_containers_sha256")):
        _fail("Completed continuation prior authority or retained container evidence changed")
    previous = strict_object(previous_raw, "Prior development terminal")
    compose = strict_object(compose_raw, "Prior canonical Compose document")
    retained = strict_object(retained_raw, "Retained application pair")
    validate_snapshot(
        pins, validate_unknown_receipt(sidecar, pins), previous, compose,
        retained, record, identity=control.identity, control_volume=control.volume,
        namespace=control.namespace,
    )
    from docker_volume_fresh_runtime import pinned_group_archive
    generation = control.read("group-ledger-generation.json")
    if pinned_group_archive(control, generation) != archive_terminal:
        _fail("Completed archive terminal differs from the pinned group-ledger generation")
    from docker_volume_fresh_runtime import _container_ids
    helper_id = pins["helper_container_id"]
    if helper_id in _container_ids("--filter", "id=" + helper_id):
        _fail("Terminal is published but the original helper has not self-released")
    if _raw_optional(control, "active") is not None:
        _fail("Original operation active marker remains after terminal publication")
    return {
        "plan": plan,
        "plan_sha256": plan_sha,
        "archive_terminal": archive_terminal,
        "finalization": finalization,
        "finalization_sha256": _sha(finalization_raw),
        "record": record,
        "final_receipt_raw": terminal_raw,
    }


def _start_observer(control: BuildControl, pins: Mapping[str, object]):
    helper_id = pins["helper_container_id"]
    command = [*docker_argv("exec", "-i", "--user", "65532:65532", helper_id,
                            "/bin/bash", "-euo", "pipefail", "-c",
                            _observer_script(pins["recreation_attempt"], "/control"))]
    try:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, bufsize=0)
    except OSError as error:
        raise BuildControlError("Cannot attach the pinned live continuation observer") from error
    try:
        if BuildControl._line(process, timeout=15) != "READY":
            raise BuildControlError("Continuation observer did not acknowledge READY")
        process.stdin.write(b"LOGGED\n")
        process.stdin.flush()
        if BuildControl._line(process, timeout=15) != "LOGGED":
            raise BuildControlError("Continuation observer did not acknowledge LOGGED")
    except BaseException:
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
        raise
    return process


def _cas_publish(control: BuildControl, relative: str, new_raw: bytes,
                 expected_sha256: str) -> None:
    """CAS one canonical authority record, accepting an exact completed replay."""
    if len(new_raw) > MAX_RECORD_BYTES or SHA256.fullmatch(expected_sha256) is None and expected_sha256 != "ABSENT":
        _fail("Interrupted archive CAS inputs are malformed")
    path = control.path(relative)
    parent = path.rsplit("/", 1)[0]
    lock_path = control.path("verification/.interrupted-fresh-archive-cas.lock")
    new_sha = _sha(new_raw)
    tmp_template = parent + "/.interrupted-archive.XXXXXXXX"
    command = (
        "set -euo pipefail; umask 027; "
        f"parent={shlex.quote(parent)}; path={shlex.quote(path)}; lock={shlex.quote(lock_path)}; "
        'mkdir -p -- "$parent"; test ! -L "$parent"; test "$(readlink -f -- "$parent")" = "$parent"; '
        'test ! -L "$lock"; exec 9>"$lock"; flock -x 9; test ! -L "$path"; '
        'current=ABSENT; if test -e "$path"; then test -f "$path"; test "$(stat -c %h "$path")" = 1; '
        'current=$(sha256sum "$path" | cut -d " " -f 1); '
        f'if test "$current" = "{new_sha}"; then printf SAME; exit 0; fi; '
        f'test "{expected_sha256}" != ABSENT; test "$current" = "{expected_sha256}"; '
        f'else test "{expected_sha256}" = ABSENT; fi; '
        f'temporary=$(mktemp {shlex.quote(tmp_template)}); trap \'rm -f -- "$temporary"\' EXIT; '
        'cat > "$temporary"; sync "$temporary"; '
        f'test "$(sha256sum "$temporary" | cut -d " " -f 1)" = "{new_sha}"; '
        'if test "$current" = ABSENT; then '
        'if ln -- "$temporary" "$path"; then rm -- "$temporary"; sync "$parent"; printf PUBLISHED; '
        'else test -f "$path"; test ! -L "$path"; '
        f'test "$(sha256sum "$path" | cut -d " " -f 1)" = "{new_sha}"; printf SAME; fi; '
        'else mv -T -- "$temporary" "$path"; sync "$parent"; printf PUBLISHED; fi'
    )
    result = bounded_capture(control.helper_args(command), data=new_raw, timeout=90, maximum=MAX_RECORD_BYTES + 1024)
    if result.returncode or result.stdout.decode("ascii", "replace").strip() not in {"PUBLISHED", "SAME"}:
        _fail("Interrupted archive CAS publication did not acknowledge its exact bytes")


def _publish_immutable(control: BuildControl, relative: str, raw: bytes) -> None:
    from docker_volume_unclaimed_cancellation import _publish_immutable as publish
    publish(control, relative, raw)


def _build_finalization(control: BuildControl, evidence: Mapping[str, object],
                        archive_terminal: Mapping[str, object], intent_sha: str) -> tuple[dict[str, object], bytes]:
    receipt = dict(evidence["receipt"])
    receipt.pop("error", None)
    receipt.update(
        state="succeeded",
        finished_at=archive_terminal.get("finished_at"),
        runtime_control_archive=dict(archive_terminal),
        removed_containers=list(evidence["plan"]["removed_containers"]),
        retained_volumes=evidence["previous"].get("backend_volumes"),
        retained_frontend_volume=evidence["previous"].get("frontend_volume"),
        interrupted_fresh_archive={
            "schema": FINALIZATION_SCHEMA,
            "original_unknown_receipt_sha256": evidence["plan"]["unknown_receipt_sha256"],
            "continuation_intent_sha256": intent_sha,
            "archive_terminal_sha256": _sha(canonical(dict(archive_terminal))),
        },
    )
    raw = canonical(receipt) + b"\n"
    return receipt, raw


def _validate_finalization(finalization: Mapping[str, object], plan_sha: str,
                           receipt_raw: bytes, archive_terminal: Mapping[str, object]) -> bytes:
    if (not isinstance(finalization, Mapping) or finalization.get("schema") != FINALIZATION_SCHEMA
            or finalization.get("plan_sha256") != plan_sha
            or finalization.get("archive_terminal_sha256") != _sha(canonical(dict(archive_terminal)))):
        _fail("Interrupted archive finalization record is not bound to the verified archive")
    encoded = finalization.get("final_receipt_base64")
    if not isinstance(encoded, str):
        _fail("Interrupted archive finalization has no exact final receipt bytes")
    try:
        final_raw = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as error:
        raise BuildControlError("Interrupted archive final receipt bytes are malformed") from error
    if _sha(final_raw) != finalization.get("final_receipt_sha256"):
        _fail("Interrupted archive final receipt SHA-256 differs")
    return final_raw


def _decode_finalization(finalization: Mapping[str, object], *, plan_sha: str,
                         archive_terminal: Mapping[str, object]) -> bytes:
    if (not isinstance(finalization, Mapping) or finalization.get("schema") != FINALIZATION_SCHEMA
            or finalization.get("plan_sha256") != plan_sha
            or finalization.get("archive_terminal_sha256") != _sha(canonical(dict(archive_terminal)))):
        _fail("Interrupted archive finalization record is not bound to the verified archive")
    encoded = finalization.get("final_receipt_base64")
    if not isinstance(encoded, str):
        _fail("Interrupted archive finalization has no exact final receipt bytes")
    try:
        final_raw = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as error:
        raise BuildControlError("Interrupted archive final receipt bytes are malformed") from error
    if _sha(final_raw) != finalization.get("final_receipt_sha256"):
        _fail("Interrupted archive final receipt SHA-256 differs")
    return final_raw


def _wait_original_release(control: BuildControl, helper_id: str, observer) -> int:
    if observer.stdin and not observer.stdin.closed:
        try:
            observer.stdin.close()
        except OSError:
            pass
    try:
        return_code = observer.wait(timeout=30)
    except subprocess.TimeoutExpired as error:
        raise BuildControlError("Terminal was published but the pinned helper/observer did not self-release") from error
    from docker_volume_fresh_runtime import _container_ids
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if helper_id not in _container_ids("--filter", "id=" + helper_id):
            return return_code
        time.sleep(0.2)
    raise BuildControlError("Terminal was published but the original operation helper remains present")


def apply(args) -> dict[str, object]:
    pins_data = dict(vars(args))
    pins_data["source_root"] = str(args.source_root)
    pins = validate_pins(pins_data)
    control = _prepare_control(Path(pins["source_root"]), pins["helper_image"])
    completed = _completed_publication(control, pins)
    if completed is not None:
        if completed["plan_sha256"] != args.expected_plan_sha256:
            _fail("Completed continuation differs from --expected-plan-sha256")
        from docker_volume_cancelled_activation_guard import pin_archive, read_record
        pin_archive(control)
        record = read_record(control)
        if record is None:
            _fail("Cancelled recovery fence disappeared during completed replay")
        return {
            "schema": "fullmag.docker-interrupted-fresh-archive-result.v1",
            "state": "already-succeeded",
            "plan_sha256": completed["plan_sha256"],
            "original_unknown_receipt_sha256": pins["unknown_receipt_sha256"],
            "final_receipt_sha256": _sha(completed["final_receipt_raw"]),
            "archive_terminal_sha256": _sha(canonical(dict(completed["archive_terminal"]))),
            "four_standard_records_equal": True,
            "cancelled_activation_attempt": record["activation_attempt"],
            "services_started": False,
            "solve_replayed": False,
        }
    evidence = _collect(control, pins)
    if evidence["plan_sha256"] != args.expected_plan_sha256:
        _fail("Current continuation plan differs from --expected-plan-sha256; nothing was changed")
    plan = evidence["plan"]
    plan_sha = evidence["plan_sha256"]
    root = "recreate-services/attempts/" + pins["recreation_attempt"]
    original_path = root + "/interrupted-fresh-archive-original-unknown-receipt.json"
    intent_path = root + "/interrupted-fresh-archive-intent.json"
    finalization_path = root + "/interrupted-fresh-archive-finalization.json"
    receipt_path = root + "/receipt.json"
    terminal_path = root + "/terminal.json"
    current_path = "recreate-services/current.json"
    verified_path = "recreate-services/verified.json"

    observer = _start_observer(control, pins)
    operation = {
        "receipt": evidence["receipt"],
        "root": root,
        "logger": observer,
        "lease_ready": True,
        "daemon_pending": True,
        "helper_container_id": pins["helper_container_id"],
    }
    control._active_operation = operation
    terminal_published = False
    try:
        # Recheck the exact pins through the existing live operation helper.
        from docker_volume_fresh_runtime import _operation_helper, archive_runtime_control
        from docker_volume_cancelled_activation_guard import read_record
        _assert_engine(pins["engine_id"])
        _check_host_writer_processes(pins["prior_attempt"], pins["recreation_attempt"])
        helper_id, _ = _operation_helper(control, operation, pins["recreation_attempt"])
        if helper_id != pins["helper_container_id"]:
            _fail("Pinned original helper ID changed after preview")
        _assert_active_marker(helper_id, pins["recreation_attempt"])
        refreshed = _collect(control, pins)
        if refreshed["plan_sha256"] != plan_sha:
            _fail("Continuation evidence changed after preview and before its durable intent")
        record = read_record(control)
        if (not isinstance(record, Mapping)
                or hashlib.sha256(canonical(dict(record))).hexdigest()
                    != plan["cancelled_recovery_sha256"]):
            _fail("Cancelled-activation recovery changed after preview")

        unknown_raw = evidence["unknown_receipt_raw"]
        if _sha(unknown_raw) != pins["unknown_receipt_sha256"]:
            _fail("Immutable original unknown receipt changed before continuation intent publication")
        _publish_immutable(control, original_path, unknown_raw)
        sidecar = control.read_bytes(original_path, maximum=MAX_RECORD_BYTES)
        if sidecar != unknown_raw:
            _fail("Immutable original unknown receipt sidecar did not persist exactly")

        intent = evidence["outer_intent"]
        if intent is None:
            intent = {
                "schema": INTENT_SCHEMA,
                "plan": plan,
                "plan_sha256": plan_sha,
                "original_unknown_receipt_path": original_path,
                "original_unknown_receipt_sha256": _sha(unknown_raw),
                "recreate_services_current_sha256": plan["recreate_services_current_sha256"],
                "recreate_services_verified_sha256": plan["recreate_services_verified_sha256"],
            }
            _publish_immutable(control, intent_path, canonical(intent) + b"\n")
        else:
            _validate_continuation_intent(intent, plan, plan_sha)
        intent_raw = control.read_bytes(intent_path, maximum=MAX_RECORD_BYTES)
        if strict_object(intent_raw, "Continuation intent") != intent:
            _fail("Continuation intent changed after immutable publication")
        intent_sha = _sha(intent_raw)

        _assert_engine(pins["engine_id"])
        _assert_active_marker(helper_id, pins["recreation_attempt"])
        snapshot_path = root + "/retained-containers.json"
        retained = strict_object(control.read_bytes(snapshot_path, maximum=MAX_RECORD_BYTES),
                                 "Retained application pair")
        if _sha(control.read_bytes(snapshot_path, maximum=MAX_RECORD_BYTES)) != plan["retained_containers_sha256"]:
            _fail("Retained container snapshot changed after preview")
        removed = [retained["backend"]["Id"], retained["frontend"]["Id"]]
        archive_terminal = archive_runtime_control(
            control,
            operation,
            previous_state_root=plan["previous_state_root"],
            source_root=plan["source_root"],
            removed_containers=removed,
        )
        if (not isinstance(archive_terminal, Mapping)
                or archive_terminal.get("state") != "succeeded"
                or archive_terminal.get("operation_attempt") != pins["recreation_attempt"]):
            _fail("Existing runtime archiver did not return its exact succeeded terminal")

        finalization_doc, final_raw = _build_finalization(control, evidence, archive_terminal, intent_sha)
        finalization = {
            "schema": FINALIZATION_SCHEMA,
            "plan_sha256": plan_sha,
            "archive_terminal_sha256": _sha(canonical(dict(archive_terminal))),
            "final_receipt_sha256": _sha(final_raw),
            "final_receipt_base64": base64.b64encode(final_raw).decode("ascii"),
        }
        _publish_immutable(control, finalization_path, canonical(finalization) + b"\n")
        published_finalization = strict_object(control.read_bytes(finalization_path, maximum=MAX_RECORD_BYTES),
                                               "Finalization record")
        if published_finalization != finalization:
            _fail("Finalization record differs from the deterministic terminal bytes")

        # The three pointers are CAS-published first. terminal.json is last:
        # the original helper watches it and owns /control/active cleanup.
        _cas_publish(control, receipt_path, final_raw, pins["unknown_receipt_sha256"])
        _cas_publish(control, current_path, final_raw, plan["recreate_services_current_sha256"])
        _cas_publish(control, verified_path, final_raw, plan["recreate_services_verified_sha256"])
        for path in (receipt_path, current_path, verified_path):
            if control.read_bytes(path, maximum=MAX_RECORD_BYTES) != final_raw:
                _fail("A standard recreation pointer differs before terminal publication")
        _cas_publish(control, terminal_path, final_raw, "ABSENT")
        terminal_published = True
    finally:
        if not terminal_published:
            # Closing this exact docker-exec stdin releases only the narrow
            # continuation flock; the original operation helper remains the
            # sole owner of /control/active and waits for terminal.json.
            if observer.stdin and not observer.stdin.closed:
                try:
                    observer.stdin.close()
                except OSError:
                    pass
            control._active_operation = None

    # terminal.json makes the original helper remove itself. Do no more reads
    # through its live observer; switch back to detached, bounded helpers.
    control._active_operation = None
    helper_rc = _wait_original_release(control, pins["helper_container_id"], observer)
    active = control.read_bytes("active", optional=True, maximum=1024)
    if active is not None:
        _fail("Original operation helper did not release its active marker after terminal")
    for path in (receipt_path, terminal_path, current_path, verified_path):
        if control.read_bytes(path, maximum=MAX_RECORD_BYTES) != final_raw:
            _fail("Final detached readback differs across the four standard recreation records")
    from docker_volume_cancelled_activation_guard import pin_archive, read_record
    pin_archive(control)
    cancellation = read_record(control)
    if cancellation is None:
        _fail("Cancelled recovery fence disappeared after archive publication")
    return {
        "schema": "fullmag.docker-interrupted-fresh-archive-result.v1",
        "state": "succeeded",
        "plan_sha256": plan_sha,
        "original_unknown_receipt_sha256": pins["unknown_receipt_sha256"],
        "final_receipt_sha256": _sha(final_raw),
        "archive_terminal_sha256": _sha(canonical(dict(archive_terminal))),
        "four_standard_records_equal": True,
        "original_helper_exit_code": helper_rc,
        "cancelled_activation_attempt": cancellation["activation_attempt"],
        "services_started": False,
        "solve_replayed": False,
    }


PREPARED_PLAN_SCHEMA = 'fullmag.docker-prepared-completed-archive-plan.v1'
PREPARED_FINISH_SCHEMA = 'fullmag.docker-prepared-completed-archive-finalization.v1'


def _prepared_completed_archive_collect(control, args):
    """Qualify only an already completed archive, never an archive retry."""
    from docker_volume_linux_supervision_stop import PREPARED_QUARANTINE, PREPARED_QUARANTINE_SCHEMA
    pins = validate_pins({**vars(args), 'source_root': str(args.source_root)})
    _require_sha(args.prepared_quarantine_sha256, 'Prepared quarantine pin')
    _require_sha(args.prepared_archive_terminal_sha256, 'Completed prepared archive pin')
    _assert_engine(pins['engine_id'])
    _check_host_writer_processes(pins['prior_attempt'], pins['recreation_attempt'])
    root = 'recreate-services/attempts/' + pins['recreation_attempt']
    finish_path = root + '/prepared-completed-archive-finalization.json'
    finished, finished_raw = _json_optional(control, finish_path)
    if finished is not None and finished_raw != canonical(finished) + b'\n':
        _fail('Prepared archive finalization is not exact canonical immutable bytes')
    current_receipt_raw = control.read_bytes(root + '/receipt.json')
    sidecar = _raw_optional(control, root + '/prepared-completed-archive-original-unknown.json')
    original_raw = sidecar if sidecar is not None else current_receipt_raw
    original = strict_object(original_raw, 'Original prepared archive unknown receipt')
    inputs = original.get('inputs', {})
    if (_sha(original_raw) != pins['unknown_receipt_sha256']
            or original.get('schema') != 'fullmag.docker-build-operation.v1'
            or original.get('phase') != 'recreate-services' or original.get('attempt') != pins['recreation_attempt']
            or original.get('state') != 'outcome-unknown-resources-retained' or original.get('fresh_state') is not True
            or inputs.get('attempt') != pins['prior_attempt'] or inputs.get('config_sha256') != pins['config_sha256']
            or original.get('compose_project') != control.project or original.get('control_volume') != control.volume
            or original.get('helper_container') != 'fullmag-control-' + pins['recreation_attempt']
            or not isinstance(original.get('error'), str) or not original['error']):
        _fail('Prepared completed archive requires its exact finalized unknown operation, without a legacy error exception')
    for key in ('started_at', 'finished_at'):
        if type(original.get(key)) not in (int, float) or not math.isfinite(original[key]):
            _fail('Prepared archive original writer has no finalized timestamp')
    if original['finished_at'] < original['started_at']:
        _fail('Prepared archive original writer timestamps are reversed')
    archive_raw = control.read_bytes(root + '/runtime-control-archive-terminal.json')
    intent_raw = control.read_bytes(root + '/runtime-control-archive-intent.json')
    archive = strict_object(archive_raw, 'Completed prepared archive terminal')
    intent = strict_object(intent_raw, 'Completed prepared archive intent')
    if (_sha(archive_raw) != args.prepared_archive_terminal_sha256
            or archive.get('schema') != 'fullmag.docker-fresh-runtime-archive-terminal.v1'
            or archive.get('state') != 'succeeded' or archive.get('intent_sha256') != _sha(intent_raw)
            or intent.get('schema') != 'fullmag.docker-fresh-runtime-archive-intent.v1'
            or any(row.get('operation_attempt') != pins['recreation_attempt']
                   or row.get('compose_project') != control.project or row.get('control_volume') != control.volume
                   or row.get('control_namespace', '') != control.namespace for row in (archive, intent))
            or intent.get('source_root') != pins['source_root']
            or intent.get('previous_state_root') != original.get('previous_state_root')
            or archive.get('mapping') != intent.get('mapping')
            or archive.get('removed_containers') != intent.get('removed_containers')):
        _fail('Prepared continuation requires an authentic existing archive intent and terminal from this exact operation')
    quarantine_raw = control.read_bytes(PREPARED_QUARANTINE)
    quarantine = strict_object(quarantine_raw, 'Prepared quarantine')
    if quarantine.get('schema') != PREPARED_QUARANTINE_SCHEMA:
        _fail('Prepared archive has an unknown quarantine version')
    if quarantine.get('state') == 'archived':
        original_quarantine = {k: v for k, v in quarantine.items() if k not in ('fresh_archive', 'cancellation_admission')}
        original_quarantine['state'] = 'cancellation-required'
        original_quarantine_raw = canonical(original_quarantine) + b'\n'
    elif quarantine.get('state') == 'cancellation-required':
        original_quarantine_raw = quarantine_raw
    else:
        _fail('Prepared archive quarantine has an unknown lifecycle')
    witness = original.get('prepared_cancelled_fresh_admission')
    if (_sha(original_quarantine_raw) != args.prepared_quarantine_sha256 or not isinstance(witness, Mapping)
            or witness.get('schema') != 'fullmag.docker-prepared-cancelled-fresh-admission.v1'
            or witness.get('quarantine_sha256') != args.prepared_quarantine_sha256):
        _fail('Completed archive is not qualified by the exact prepared cancellation/fresh admission')
    if quarantine.get('state') == 'archived' and (
            quarantine.get('cancellation_admission') != witness
            or quarantine.get('fresh_archive') != {'path': root + '/runtime-control-archive-terminal.json', 'sha256': _sha(archive_raw)}):
        _fail('Archived prepared quarantine points at another fresh generation')
    prior_raw = control.read_bytes('development/attempts/' + pins['prior_attempt'] + '/terminal.json')
    previous = strict_object(prior_raw, 'Prepared cancellation terminal')
    if (_sha(prior_raw) != witness.get('cancellation_terminal_sha256')
            or previous.get('config_sha256') != pins['config_sha256']
            or previous.get('inputs', {}).get('source_root') != pins['source_root']
            or previous.get('state_root') != original.get('previous_state_root')
            or control.read_bytes('development/current.json') != prior_raw
            or control.read_bytes('development/verified.json') != prior_raw):
        _fail('Prepared cancellation authority changed before completed archive finalization')
    from docker_volume_fresh_runtime import _archive_mapping
    if archive.get('mapping') != _archive_mapping(pins['recreation_attempt'], private_ledger='preserved_group_ledger_subpath' in intent):
        _fail('Prepared archive mapping differs from the owning archive protocol')
    from docker_volume_fresh_runtime import pinned_group_archive
    generation_raw = control.read_bytes('group-ledger-generation.json')
    generation = strict_object(generation_raw, 'Completed prepared group-ledger generation')
    if pinned_group_archive(control, generation) != archive:
        _fail('Prepared archive metadata is partial or belongs to another group-ledger generation')
    from docker_volume_cancelled_recovery import _validate_operation
    result, _, _, request, _, before, _, _, _ = _validate_operation(
        control, pins['prior_attempt'], prior_raw, previous, _sha(prior_raw), Path(pins['source_root']))
    target = quarantine.get('target', {})
    if (witness.get('constraints') != before.get('prepared_unclaimed_quarantine')
            or request.get('run_id') != target.get('run_id') or request.get('task_id') != target.get('task_id')
            or result.get('native_result', {}).get('disposition') != 'cancelled'):
        _fail('Prepared archive lacks this exact task canonical native cancellation')
    retained_raw = control.read_bytes(root + '/retained-containers.json')
    retained = strict_object(retained_raw, 'Archived prepared maintenance pair')
    removed = archive['removed_containers']
    if (not isinstance(removed, Mapping) or set(removed) != {'backend', 'frontend'}
            or any(retained.get(name, {}).get('Id') != removed[name] for name in ('backend', 'frontend'))):
        _fail('Prepared archive removed pair differs from its retained service evidence')
    from docker_volume_fresh_runtime import _assert_exact_absence
    for name, identifier in removed.items():
        _assert_exact_absence(identifier, name)
    final = dict(original, state='succeeded', runtime_control_archive=archive,
                 removed_containers=[removed['backend'], removed['frontend']],
                 retained_volumes=previous.get('backend_volumes'), retained_frontend_volume=previous.get('frontend_volume'),
                 prepared_completed_archive={'schema': PREPARED_FINISH_SCHEMA,
                    'original_unknown_receipt_sha256': _sha(original_raw),
                    'archive_terminal_sha256': _sha(archive_raw), 'quarantine_sha256': args.prepared_quarantine_sha256})
    final.pop('error', None)
    final_raw = canonical(final) + b'\n'
    core = {'schema': PREPARED_PLAN_SCHEMA, 'pins': pins, 'original_receipt_sha256': _sha(original_raw),
            'archive_intent_sha256': _sha(intent_raw), 'archive_terminal_sha256': _sha(archive_raw),
            'retained_containers_sha256': _sha(retained_raw), 'prior_terminal_sha256': _sha(prior_raw),
            'group_ledger_generation_sha256': _sha(generation_raw),
            'final_receipt_sha256': _sha(final_raw)}
    # Exclude invocation controls from the immutable recovery identity.
    core['pins'] = {k: pins[k] for k in ('prior_attempt', 'config_sha256', 'source_root', 'recreation_attempt',
                   'unknown_receipt_sha256', 'helper_container_id', 'helper_image', 'engine_id',
                   'prepared_quarantine_sha256', 'prepared_archive_terminal_sha256')}
    paths = ('recreate-services/current.json', 'recreate-services/verified.json')
    pointers = {path: _raw_optional(control, path) for path in paths}
    if finished is None:
        plan = dict(core, pointer_predecessors={path: 'ABSENT' if raw is None else _sha(raw) for path, raw in pointers.items()})
    else:
        if (finished.get('schema') != PREPARED_FINISH_SCHEMA or finished.get('final_receipt_base64') != base64.b64encode(final_raw).decode()
                or finished.get('original_receipt_sha256') != _sha(original_raw)
                or {k: v for k, v in finished.get('plan', {}).items() if k != 'pointer_predecessors'} != core):
            _fail('Prepared completed archive finalization does not match its immutable plan')
        plan = finished['plan']
    if current_receipt_raw not in (original_raw, final_raw):
        _fail('Prepared recreation receipt changed outside its exact finalization')
    for path, raw in pointers.items():
        observed = 'ABSENT' if raw is None else _sha(raw)
        if observed not in (plan['pointer_predecessors'][path], _sha(final_raw)):
            _fail('Prepared recreation pointer changed outside its exact finalization')
    terminal_raw = _raw_optional(control, root + '/terminal.json')
    if terminal_raw is not None:
        if (finished is None or terminal_raw != final_raw or current_receipt_raw != final_raw
                or any(raw != final_raw for raw in pointers.values())
                or control.read_bytes('active', optional=True) is not None):
            _fail('Prepared completed publication has incomplete final records or a retained lease')
        from docker_volume_linux_supervision_stop import assert_prepared_start_allowed
        assert_prepared_start_allowed(control)
    else:
        _inspect_pinned_helper(control, pins['recreation_attempt'], pins['helper_container_id'], pins['helper_image'])
        _assert_active_marker(pins['helper_container_id'], pins['recreation_attempt'])
        _assert_logged(pins['helper_container_id'])
        # Explicit low-level verification only: this cannot create an intent,
        # publish an archive terminal, rename roots, remove or start services.
        from docker_volume_fresh_runtime import _archive_runtime_control
        inode_evidence = _archive_runtime_control(pins['helper_container_id'], pins['recreation_attempt'], intent, verify_only=True)
        if any(archive.get(key) != value for key, value in inode_evidence.items()):
            _fail('Completed prepared archive inode evidence drifted')
    return {'plan': plan, 'plan_sha256': _sha(canonical(plan)), 'root': root, 'pins': pins,
            'original_raw': original_raw, 'archive': archive, 'archive_raw': archive_raw, 'intent_raw': intent_raw,
            'witness': dict(witness), 'final': final, 'final_raw': final_raw, 'completed': terminal_raw is not None}


def prepared_completed_archive(args):
    """Finish only metadata after this family's already genuine fresh archive."""
    control = _prepare_control(Path(args.source_root), args.helper_image)
    evidence = _prepared_completed_archive_collect(control, args)
    if not args.apply:
        return {'schema': PREPARED_PLAN_SCHEMA, 'plan': evidence['plan'], 'plan_sha256': evidence['plan_sha256']}
    if args.expected_plan_sha256 != evidence['plan_sha256']:
        _fail('Prepared completed archive differs from the reviewed preview; no writes were made')
    if evidence['completed']:
        return {'schema': PREPARED_FINISH_SCHEMA, 'state': 'already-succeeded',
                'plan_sha256': evidence['plan_sha256'], 'services_started': False, 'solve_replayed': False}
    root = evidence['root']
    pins = evidence['pins']
    observer = _start_observer(control, pins)
    operation = {'receipt': strict_object(evidence['original_raw'], 'Prepared original operation'),
                 'root': root, 'logger': observer, 'lease_ready': True, 'daemon_pending': True,
                 'helper_container_id': pins['helper_container_id']}
    control._active_operation = operation
    terminal_published = False
    try:
        fresh = _prepared_completed_archive_collect(control, args)
        if fresh['plan'] != evidence['plan']:
            _fail('Prepared completed archive changed at the immediate finalization barrier')
        from docker_volume_fresh_runtime import _operation_helper
        _operation_helper(control, operation, pins['recreation_attempt'])
        _publish_immutable(control, root + '/prepared-completed-archive-original-unknown.json', evidence['original_raw'])
        finalization = {'schema': PREPARED_FINISH_SCHEMA, 'plan': evidence['plan'],
                        'original_receipt_sha256': _sha(evidence['original_raw']),
                        'final_receipt_base64': base64.b64encode(evidence['final_raw']).decode()}
        _publish_immutable(control, root + '/prepared-completed-archive-finalization.json', canonical(finalization) + b'\n')
        from docker_volume_linux_supervision_stop import pin_prepared_fresh_archive
        pin_prepared_fresh_archive(control, operation, evidence['witness'])
        _cas_publish(control, root + '/receipt.json', evidence['final_raw'], pins['unknown_receipt_sha256'])
        for path, expected in evidence['plan']['pointer_predecessors'].items():
            _cas_publish(control, path, evidence['final_raw'], expected)
        for path in (root + '/receipt.json', 'recreate-services/current.json', 'recreate-services/verified.json'):
            if control.read_bytes(path) != evidence['final_raw']:
                _fail('Prepared standard recreation records differ before terminal-last publication')
        from docker_volume_fresh_runtime import pinned_group_archive
        generation_raw = control.read_bytes('group-ledger-generation.json')
        if (_sha(generation_raw) != evidence['plan']['group_ledger_generation_sha256']
                or pinned_group_archive(control, strict_object(generation_raw, 'Prepared generation barrier')) != evidence['archive']):
            _fail('Prepared completed archive group-ledger generation drifted before terminal publication')
        _cas_publish(control, root + '/terminal.json', evidence['final_raw'], 'ABSENT')
        terminal_published = True
    finally:
        control._active_operation = None
        if not terminal_published and observer.stdin and not observer.stdin.closed:
            observer.stdin.close()
    _wait_original_release(control, pins['helper_container_id'], observer)
    final = _prepared_completed_archive_collect(control, args)
    if not final['completed'] or final['plan_sha256'] != evidence['plan_sha256']:
        _fail('Prepared completed archive detached finalization readback differs')
    return {'schema': PREPARED_FINISH_SCHEMA, 'state': 'succeeded', 'plan_sha256': evidence['plan_sha256'],
            'services_started': False, 'solve_replayed': False, 'original_helper_released': True}


def _parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prior-attempt", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--recreation-attempt", required=True)
    parser.add_argument("--unknown-receipt-sha256", required=True)
    parser.add_argument("--helper-container-id", required=True)
    parser.add_argument("--helper-image", required=True)
    parser.add_argument("--engine-id", required=True)
    parser.add_argument("--expected-plan-sha256")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument('--prepared-quarantine-sha256')
    parser.add_argument('--prepared-archive-terminal-sha256')
    return parser


def run(args) -> int:
    try:
        if args.apply and not args.expected_plan_sha256:
            _fail("--apply requires --expected-plan-sha256 from an exact preview")
        if not args.apply and args.expected_plan_sha256 is not None:
            _fail("--expected-plan-sha256 requires --apply")
        require_host()
        if bool(getattr(args, 'prepared_quarantine_sha256', None)) != bool(getattr(args, 'prepared_archive_terminal_sha256', None)):
            _fail('Prepared archive continuation requires both quarantine and completed archive terminal pins')
        result = (prepared_completed_archive(args) if getattr(args, 'prepared_quarantine_sha256', None)
                  else (apply(args) if args.apply else preview(args)))
        print(json.dumps(result, sort_keys=True, ensure_ascii=False))
        return 0
    except (BuildControlError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2


def main(argv=None) -> int:
    return run(_parser().parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
