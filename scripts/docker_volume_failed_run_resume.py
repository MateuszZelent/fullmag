"""Preserve and resume one pinned accepted run after a diagnostic API stop.

This path never edits the accepted store or invents a cancellation/terminal
receipt. It proves that completed tasks remain completed, and that the only
nonterminal tasks are still unclaimed Accepted/Queued catalog entries.
"""
from __future__ import annotations

import hashlib
import json
import re
import os
import uuid
from collections.abc import Mapping
from pathlib import Path

from docker_build_control import BuildControlError, bounded_capture, canonical, docker_capture


SCHEMA = "fullmag.failed-run-resume.v1"
SNAPSHOT_SCHEMA = "fullmag.failed-run-resume-store-observation.v1"
RUN_PIN_SCHEMA = "fullmag.failed-run-resume-run-pin.v1"
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
RUN_ID_RE = re.compile(r"run-[A-Za-z0-9_-]{1,128}\Z")
TASK_ID_RE = re.compile(r"task-[A-Za-z0-9_-]{1,160}\Z")
ATTEMPT_RE = re.compile(r"attempt-[A-Za-z0-9_-]{1,128}\Z")
LEASE_RE = re.compile(r"lease-[A-Za-z0-9_-]{1,128}\Z")
ATTEMPT_TOKEN_RE = re.compile(r"[0-9a-f]{32}\Z")
CONTAINER_RE = re.compile(r"[0-9a-f]{64}\Z")
IMAGE_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
RESUME_REQUEST_SCHEMA = "fullmag.failed-run-resume-request.v1"
MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024


class ResumeError(BuildControlError):
    """The preserving accepted-run continuation could not be authenticated."""


def _fail(message: str) -> None:
    raise ResumeError(message)


def _sha(value: object, label: str) -> str:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        _fail(label + " is not a lowercase SHA-256")
    return value


def _record(snapshot: Mapping[str, object], relative: str, label: str) -> dict[str, object]:
    records = snapshot.get("records")
    item = records.get(relative) if isinstance(records, Mapping) else None
    if (not isinstance(item, Mapping) or set(item) != {"sha256", "value"}
            or not isinstance(item.get("value"), Mapping)):
        _fail(label + " record is missing or malformed")
    _sha(item.get("sha256"), label + " raw file digest")
    return dict(item)


def _identity(value: object, pattern: re.Pattern[str], label: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        _fail(label + " is malformed")
    return value


def _canonical_control_record(raw: bytes, label: str) -> dict[str, object]:
    if not isinstance(raw, bytes) or len(raw) > 1024 * 1024:
        _fail(label + " exceeds its raw evidence bound")

    def no_duplicate_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=no_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ResumeError(label + " is not unambiguous JSON") from error
    if not isinstance(value, Mapping) or raw != canonical(value) + b"\n":
        _fail(label + " is not a canonical control-volume record")
    return dict(value)


def _record_rows(snapshot: Mapping[str, object], key: str, label: str) -> list[dict[str, object]]:
    rows = snapshot.get(key)
    if not isinstance(rows, list) or len(rows) > 8192:
        _fail(label + " inventory is missing or unbounded")
    result = []
    for row in rows:
        if not isinstance(row, Mapping):
            _fail(label + " inventory contains a malformed row")
        result.append(dict(row))
    return result


def _task_identity(task: Mapping[str, object], run_id: str) -> tuple[str, str, str, int, str]:
    task_id = _identity(task.get("task_id"), TASK_ID_RE, "catalog task id")
    if task.get("lifecycle") != "succeeded":
        _fail("completed task state differs")
    attempt = _identity(task.get("attempt_id"), ATTEMPT_RE, "completed task attempt")
    resource_id = task.get("resource_id")
    if not isinstance(resource_id, str) or not resource_id or len(resource_id) > 255:
        _fail("completed task resource identity is malformed")
    epoch = task.get("ownership_epoch")
    if type(epoch) is not int or epoch <= 0:
        _fail("completed task ownership epoch is malformed")
    watermark = task.get("coordinator_watermark")
    if (not isinstance(watermark, Mapping)
            or type(watermark.get("command_sequence")) is not int
            or type(watermark.get("event_sequence")) is not int
            or watermark["command_sequence"] < 0 or watermark["event_sequence"] <= 0):
        _fail("completed task coordinator watermark is malformed")
    genesis = task.get("coordinator_genesis")
    if (not isinstance(genesis, Mapping) or genesis.get("run_id") != run_id
            or genesis.get("task_id") != task_id or genesis.get("attempt_id") != attempt
            or genesis.get("ownership_epoch") != epoch):
        _fail("completed task coordinator genesis differs")
    lease_token = _identity(genesis.get("lease_token"), LEASE_RE, "completed task lease token")
    return task_id, attempt, resource_id, epoch, lease_token


def _completed_evidence(snapshot: Mapping[str, object], run_id: str,
                        task: Mapping[str, object]) -> str:
    task_id, attempt, resource_id, epoch, lease_token = _task_identity(task, run_id)
    events = _record_rows(snapshot, "coordinator_events", "coordinator event")
    terminal = []
    for row in events:
        value = row.get("value")
        if not isinstance(value, Mapping):
            _fail("coordinator event body is malformed")
        _sha(row.get("sha256"), "coordinator event raw file digest")
        if value.get("run_id") != run_id:
            _fail("coordinator event belongs to another run")
        if value.get("task_id") != task_id:
            continue
        payload = value.get("payload")
        message = payload.get("message") if isinstance(payload, Mapping) else None
        envelope = message.get("envelope") if isinstance(message, Mapping) else None
        claim = envelope.get("claim") if isinstance(envelope, Mapping) else None
        event = envelope.get("event") if isinstance(envelope, Mapping) else None
        if (value.get("schema_version") != "coordinator_journal.v1"
                or value.get("direction") != "event"
                or value.get("attempt_id") != attempt
                or value.get("ownership_epoch") != epoch
                or value.get("lease_token") != lease_token
                or not isinstance(claim, Mapping)
                or claim.get("run_id") != run_id or claim.get("task_id") != task_id
                or claim.get("attempt_id") != attempt or claim.get("ownership_epoch") != epoch
                or claim.get("lease_token") != lease_token
                or not isinstance(event, Mapping)):
            _fail("coordinator event claim differs from completed task")
        if value.get("terminal") is True:
            terminal.append((value, event))
    watermark = task["coordinator_watermark"]
    if (len(terminal) != 1
            or terminal[0][0].get("sequence") != watermark.get("event_sequence")
            or terminal[0][1].get("kind") != "completed"):
        _fail("completed task has no unique matching terminal coordinator event")

    exits = _record_rows(snapshot, "worker_exit_receipts", "worker exit")
    matching_exits = []
    for row in exits:
        value = row.get("value")
        if not isinstance(value, Mapping):
            _fail("worker exit receipt is malformed")
        _sha(row.get("sha256"), "worker exit raw file digest")
        if value.get("run_id") == run_id and value.get("task_id") == task_id:
            matching_exits.append(value)
    if (len(matching_exits) != 1
            or matching_exits[0].get("schema_version") != "worker_process_exit_receipt.v1"
            or matching_exits[0].get("attempt_id") != attempt
            or matching_exits[0].get("ownership_epoch") != epoch
            or matching_exits[0].get("resource_id") != resource_id
            or matching_exits[0].get("lease_token") != lease_token
            or matching_exits[0].get("status_success") is not True
            or type(matching_exits[0].get("exit_code")) is not int
            or matching_exits[0].get("exit_code") != 0
            or matching_exits[0].get("timed_out") is not False
            or matching_exits[0].get("stop_requested") is not False):
        _fail("completed task has no unique successful matching worker exit")

    leases = _record_rows(snapshot, "resource_leases", "resource lease")
    matching_leases = []
    for row in leases:
        value = row.get("value")
        if not isinstance(value, Mapping):
            _fail("resource lease record is malformed")
        _sha(row.get("sha256"), "resource lease raw file digest")
        if value.get("run_id") == run_id and value.get("task_id") == task_id:
            matching_leases.append(value)
        if value.get("state") != "released":
            _fail("session resource lease is active or unknown")
    if (len(matching_leases) != 1
            or matching_leases[0].get("attempt_id") != attempt
            or matching_leases[0].get("ownership_epoch") != epoch
            or matching_leases[0].get("resource_id") != resource_id
            or matching_leases[0].get("lease_token") != lease_token):
        _fail("completed task has no unique matching released resource lease")

    admissions = _record_rows(snapshot, "task_admissions", "task admission")
    matching_admissions = [row for row in admissions
                           if row.get("run_id") == run_id and row.get("task_id") == task_id]
    if (len(matching_admissions) != 1
            or matching_admissions[0].get("attempt_id") != attempt):
        _fail("completed task admission evidence is missing or ambiguous")
    return task_id


def validate_accepted_run_snapshot(snapshot: Mapping[str, object], *, run_id: str) -> dict[str, object]:
    """Validate mixed completed/accepted history without changing the session store."""
    run_id = _identity(run_id, RUN_ID_RE, "requested run id")
    required = {
        "schema", "run_id", "run_directories", "records", "coordinator_events",
        "worker_exit_receipts", "resource_leases", "task_admissions",
        "task_cancellation_intents", "host_ledger", "other_run_catalogs",
        "store_inventory_sha256",
    }
    if not isinstance(snapshot, Mapping) or set(snapshot) != required:
        _fail("accepted-run store snapshot shape is unsupported")
    if snapshot.get("schema") != SNAPSHOT_SCHEMA or snapshot.get("run_id") != run_id:
        _fail("accepted-run store snapshot identity differs")
    store_digest = _sha(snapshot.get("store_inventory_sha256"), "accepted store inventory digest")
    intent = _record(snapshot, "run_intent.json", "RunIntent")
    catalog_record = _record(snapshot, "run_catalog.json", "run catalog")
    release_record = _record(snapshot, "start_release.json", "accepted run start release")
    artifact_record = _record(snapshot, "artifact_catalog.json", "accepted artifact catalog")
    intent_value, catalog, release = intent["value"], catalog_record["value"], release_record["value"]
    if (intent_value.get("schema_version") != "run_intent.v1" or intent_value.get("run_id") != run_id
            or catalog.get("schema_version") != "run_catalog.v1" or catalog.get("run_id") != run_id
            or artifact_record["value"].get("schema_version") != "artifact_catalog.v1"
            or artifact_record["value"].get("run_id") != run_id
            or type(catalog.get("revision")) is not int or catalog["revision"] <= 0
            or release.get("schema_version") != "accepted_run_start_release.v1"
            or release.get("run_id") != run_id):
        _fail("RunIntent, catalog, or immutable start-release identity differs")
    specification = intent_value.get("specification")
    specification_sha = release.get("specification_sha256")
    if (not isinstance(specification, Mapping) or not isinstance(specification_sha, str)
            or hashlib.sha256(canonical(specification)).hexdigest() != specification_sha
            or intent_value.get("payload_sha256") != specification_sha):
        _fail("accepted RunIntent payload/specification differs from its immutable start release")
    release_request = release.get("request_id")
    if not isinstance(release_request, str) or not release_request:
        _fail("accepted start release request identity is missing")
    tasks = catalog.get("tasks")
    if not isinstance(tasks, list) or not 1 <= len(tasks) <= 4096:
        _fail("accepted run catalog task inventory is missing or unbounded")
    artifact_catalog = artifact_record["value"].get("entries")
    if not isinstance(artifact_catalog, list) or len(artifact_catalog) > 16384:
        _fail("accepted artifact catalog inventory is missing or unbounded")
    artifacts_by_id = {}
    for artifact in artifact_catalog:
        if not isinstance(artifact, Mapping):
            _fail("accepted artifact catalog contains a malformed entry")
        artifact_id = artifact.get("artifact_id")
        task_id = artifact.get("task_id")
        if (not isinstance(artifact_id, str) or not artifact_id
                or not isinstance(task_id, str) or TASK_ID_RE.fullmatch(task_id) is None
                or artifact_id in artifacts_by_id
                or artifact.get("status") != "published"
                or not isinstance(artifact.get("object_ref"), str)
                or SHA256_RE.fullmatch(artifact["object_ref"]) is None
                or artifact.get("content_sha256") != artifact.get("object_ref")):
            _fail("accepted artifact catalog entry identity or CAS reference differs")
        artifacts_by_id[artifact_id] = dict(artifact)
    task_ids: set[str] = set()
    completed = []
    resumable = []
    completed_tasks = []
    for task in tasks:
        if not isinstance(task, Mapping):
            _fail("accepted run catalog has a malformed task")
        task_id = _identity(task.get("task_id"), TASK_ID_RE, "catalog task id")
        if task_id in task_ids:
            _fail("accepted run catalog has duplicate task identity")
        task_ids.add(task_id)
        lifecycle = task.get("lifecycle")
        artifact_ids = task.get("artifact_ids")
        if not isinstance(artifact_ids, list) or len(artifact_ids) > 4096:
            _fail("accepted run task artifact inventory is malformed")
        if lifecycle == "succeeded":
            if not artifact_ids:
                _fail("completed task lost its immutable outputs")
            for artifact_id in artifact_ids:
                artifact = artifacts_by_id.get(artifact_id)
                if (artifact is None or artifact.get("task_id") != task_id
                        or artifact.get("attempt_id") != task.get("attempt_id")
                        or artifact.get("ownership_epoch") != task.get("ownership_epoch")):
                    _fail("completed task output is absent from its immutable artifact catalog")
            completed.append(task_id)
            completed_tasks.append(task)
        elif lifecycle in {"accepted", "queued"}:
            if (artifact_ids or any(task.get(key) is not None for key in (
                    "attempt_id", "resource_id", "resolved_input_fingerprint",
                    "ownership_epoch", "coordinator_watermark", "coordinator_genesis"))):
                _fail("Accepted/Queued task already has a claim or execution evidence")
            resumable.append(task_id)
        else:
            _fail("accepted run contains a task outside succeeded or unclaimed Accepted/Queued state")
    if not completed or not resumable:
        _fail("accepted run has no preserved completion or no remaining accepted work")
    resumable_set = set(resumable)
    for key, label in (("coordinator_events", "coordinator event"),
                       ("worker_exit_receipts", "worker exit receipt"),
                       ("task_admissions", "task admission")):
        for row in _record_rows(snapshot, key, label):
            value = row.get("value") if key != "task_admissions" else row
            if not isinstance(value, Mapping):
                _fail(label + " evidence is malformed")
            if key != "task_admissions":
                _sha(row.get("sha256"), label + " raw file digest")
            if value.get("run_id", run_id) != run_id:
                _fail(label + " belongs to another run")
            if value.get("task_id") in resumable_set:
                _fail("Accepted/Queued task already has durable execution evidence")
    for task in completed_tasks:
        _completed_evidence(snapshot, run_id, task)
    if sorted(completed) != sorted(
            [row.get("task_id") for row in _record_rows(snapshot, "task_admissions", "task admission")]):
        raise ResumeError("task admission inventory differs from the succeeded catalog tasks")
    if snapshot.get("task_cancellation_intents") != []:
        _fail("accepted run has a cancellation intent; preserving resume refuses it")

    ledger = snapshot.get("host_ledger")
    if (not isinstance(ledger, Mapping)
            or set(ledger) != {"sha256", "store_id", "reservations"}
            or not isinstance(ledger.get("reservations"), list)):
        _fail("host resource ledger snapshot is malformed")
    ledger_digest = _sha(ledger.get("sha256"), "host resource ledger digest")
    store_id = ledger.get("store_id")
    if not isinstance(store_id, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", store_id) is None:
        _fail("host resource ledger store identity is malformed")
    same_store = []
    for row in ledger["reservations"]:
        if not isinstance(row, Mapping):
            _fail("host ledger reservation inventory is malformed")
        row_store = row.get("store_id")
        if not isinstance(row_store, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", row_store) is None:
            _fail("host ledger reservation store identity is unknown")
        if row_store != store_id:
            continue
        if row.get("state") != "released":
            _fail("selected session-store host reservation is active or unknown")
        if (not isinstance(row.get("run_id"), str) or RUN_ID_RE.fullmatch(row["run_id"]) is None
                or not isinstance(row.get("task_id"), str) or TASK_ID_RE.fullmatch(row["task_id"]) is None
                or not isinstance(row.get("release_proof_sha256"), str)
                or SHA256_RE.fullmatch(row["release_proof_sha256"]) is None
                or not isinstance(row.get("release_proof_raw_sha256"), str)
                or SHA256_RE.fullmatch(row["release_proof_raw_sha256"]) is None):
            _fail("selected session-store host reservation release proof is incomplete")
        same_store.append(row)
    current_run_rows = [row for row in same_store if row.get("run_id") == run_id]
    for row in current_run_rows:
        if row.get("task_id") not in task_ids:
            _fail("selected session-store reservation belongs to an unknown task")
        if row.get("task_id") in resumable_set:
            _fail("Accepted/Queued task already owns a session-store host reservation")
    for task in completed_tasks:
        task_id = task["task_id"]
        task_id_value, attempt, resource_id, epoch, lease_token = _task_identity(task, run_id)
        matches = [row for row in current_run_rows if row.get("task_id") == task_id]
        if (len(matches) != 1
                or matches[0].get("attempt_id") != attempt
                or matches[0].get("ownership_epoch") != epoch
                or matches[0].get("resource_id") != resource_id
                or matches[0].get("lease_token") != lease_token):
            _fail("completed task has no unique matching released host reservation")

    directories = snapshot.get("run_directories")
    other = snapshot.get("other_run_catalogs")
    if (not isinstance(directories, list) or not isinstance(other, list)
            or any(not isinstance(value, str) for value in directories)
            or directories != sorted(set(directories))
            or len(directories) > 128 or any(not isinstance(row, Mapping) for row in other)):
        _fail("complete run directory inventory is malformed")
    other_ids = []
    for row in other:
        other_id = _identity(row.get("run_id"), RUN_ID_RE, "other run id")
        other_tasks = row.get("tasks")
        if not isinstance(other_tasks, list) or not other_tasks:
            _fail("other run catalog has no terminal task inventory")
        for task in other_tasks:
            if not isinstance(task, Mapping) or task.get("lifecycle") not in {
                    "succeeded", "failed", "cancelled", "interrupted"}:
                _fail("other run has nonterminal work; preserving resume refuses it")
        other_ids.append(other_id)
    if len(set(other_ids)) != len(other_ids) or directories != sorted([run_id, *other_ids]):
        _fail("accepted store run directories differ from the exact retained catalogs")

    return {
        "schema": RUN_PIN_SCHEMA,
        "run_id": run_id,
        "run_intent_sha256": intent["sha256"],
        "run_catalog_sha256": catalog_record["sha256"],
        "start_release_sha256": release_record["sha256"],
        "artifact_catalog_sha256": artifact_record["sha256"],
        "start_release_request_id": release_request,
        "store_inventory_sha256": store_digest,
        "host_store_id": store_id,
        "host_ledger_sha256": ledger_digest,
        "completed_task_ids": sorted(completed),
        "resumable_task_ids": sorted(resumable),
    }


def validate_stop_diagnostic_authority(
    outer_raw: bytes, diagnostic_raw: bytes, binding: Mapping[str, object],
) -> dict[str, object]:
    """Authenticate the outer stop-diagnostic operation and its typed result.

    The CLI pin is the raw outer ``terminal.json`` hash. The outer operation's
    diagnostic field binds the canonical typed body, and the typed record gets
    its own independent raw-file hash in the returned pin.
    """
    required_binding = {
        "stop_attempt", "stop_terminal_sha256", "development_attempt", "config_sha256",
        "source_root", "compose_project", "control_volume", "backend_container_id",
        "backend_image_id", "backend_started_at", "frontend_container_id",
    }
    if not isinstance(binding, Mapping) or set(binding) != required_binding:
        _fail("diagnostic stop authority binding shape differs")
    stop_attempt = _identity(binding.get("stop_attempt"), re.compile(r"[0-9a-f]{32}\Z"),
                             "diagnostic stop attempt")
    development_attempt = _identity(binding.get("development_attempt"), re.compile(r"[0-9a-f]{32}\Z"),
                                    "retained development attempt")
    stop_sha = _sha(binding.get("stop_terminal_sha256"), "outer stop terminal digest")
    config_sha = _sha(binding.get("config_sha256"), "retained Compose config digest")
    for key in ("source_root", "compose_project", "control_volume", "backend_started_at"):
        if not isinstance(binding.get(key), str) or not binding[key]:
            _fail("diagnostic stop binding is missing " + key)
    backend_id = _identity(binding.get("backend_container_id"), re.compile(r"[0-9a-f]{64}\Z"),
                            "diagnostic stop backend container id")
    frontend_id = _identity(binding.get("frontend_container_id"), re.compile(r"[0-9a-f]{64}\Z"),
                             "diagnostic stop frontend container id")
    image_id = _identity(binding.get("backend_image_id"), re.compile(r"sha256:[0-9a-f]{64}\Z"),
                         "diagnostic stop backend image")

    outer = _canonical_control_record(outer_raw, "outer diagnostic stop terminal")
    outer_raw_sha = hashlib.sha256(outer_raw).hexdigest()
    if outer_raw_sha != stop_sha:
        _fail("outer stop terminal digest differs from the requested raw pin")
    inputs = outer.get("inputs")
    if (outer.get("schema") != "fullmag.docker-build-operation.v1"
            or outer.get("phase") != "stop-diagnostic"
            or outer.get("state") != "succeeded"
            or outer.get("attempt") != stop_attempt
            or outer.get("compose_project") != binding.get("compose_project")
            or outer.get("control_volume") != binding.get("control_volume")
            or outer.get("image_id") != image_id
            or not isinstance(inputs, Mapping)
            or inputs.get("preview_only") is not False
            or inputs.get("attempt") != development_attempt
            or inputs.get("config_sha256") != config_sha
            or inputs.get("source_root") != binding.get("source_root")
            or inputs.get("backend_container_id") != backend_id
            or inputs.get("frontend_container_id") != frontend_id
            or inputs.get("backend_started_at") != binding.get("backend_started_at")
            or inputs.get("image_id") != image_id):
        _fail("outer terminal is not the exact successful stop-diagnostic operation")

    diagnostic = _canonical_control_record(diagnostic_raw, "typed diagnostic stop terminal")
    diagnostic_body_sha = hashlib.sha256(canonical(diagnostic)).hexdigest()
    diagnostic_raw_sha = hashlib.sha256(diagnostic_raw).hexdigest()
    if outer.get("diagnostic_stop_terminal_sha256") != diagnostic_body_sha:
        _fail("typed diagnostic body digest differs from its outer operation binding")
    if (diagnostic.get("schema") != "fullmag.docker-api-diagnostic-stop.v1"
            or diagnostic.get("state") != "stopped-execution-unknown"
            or diagnostic.get("attempt") != development_attempt
            or diagnostic.get("config_sha256") != config_sha
            or diagnostic.get("backend_container_id") != backend_id
            or diagnostic.get("backend_image_id") != image_id
            or diagnostic.get("backend_started_at") != binding.get("backend_started_at")
            or type(diagnostic.get("backend_exit_code")) is not int
            or diagnostic.get("frontend_container_id") != frontend_id
            or diagnostic.get("runtime_owner_state") != "failed-preserved"
            or diagnostic.get("execution_state") != "unknown"
            or diagnostic.get("resource_leases") != "untouched"
            or type(diagnostic.get("api_exit_code")) is not int
            or diagnostic.get("shutdown_error") != "runtime service owner is not ready"
            or not isinstance(diagnostic.get("retained_ready_owner"), Mapping)):
        _fail("typed diagnostic stop receipt differs from the failed retained runtime")
    raw_hashes = {}
    for field in (
        "runtime_config_sha256", "failed_owner_sha256", "failure_process_receipt_sha256",
        "terminal_process_receipt_sha256", "api_failure_fence_sha256",
    ):
        raw_hashes[field] = _sha(diagnostic.get(field), "typed diagnostic stop " + field)
    api_instance = diagnostic.get("api_instance_id")
    if not isinstance(api_instance, str) or not api_instance:
        _fail("typed diagnostic stop API instance pin is missing")
    return {
        "schema": "fullmag.failed-run-resume-stop-pin.v1",
        "stop_attempt": stop_attempt,
        "stop_terminal_path": "stop-diagnostic/attempts/" + stop_attempt + "/terminal.json",
        "stop_terminal_raw_sha256": outer_raw_sha,
        "stop_terminal_body_sha256": hashlib.sha256(canonical(outer)).hexdigest(),
        "diagnostic_terminal_path": "stop-diagnostic/attempts/" + stop_attempt + "/diagnostic-stop-terminal.json",
        "diagnostic_terminal_raw_sha256": diagnostic_raw_sha,
        "diagnostic_terminal_body_sha256": diagnostic_body_sha,
        "development_attempt": development_attempt,
        "config_sha256": config_sha,
        "source_root": binding["source_root"],
        "compose_project": binding["compose_project"],
        "control_volume": binding["control_volume"],
        "backend_container_id": backend_id,
        "backend_image_id": image_id,
        "backend_started_at": binding["backend_started_at"],
        "frontend_container_id": frontend_id,
        "api_instance_id": api_instance,
        "runtime_hashes": raw_hashes,
    }


CONTEXT_SCHEMA = 'fullmag.failed-run-resume-context.v1'
PLAN_SCHEMA = 'fullmag.failed-run-resume-plan.v1'
_CONTEXT_KEYS = {'schema', 'request_id', 'run_id', 'stop_pin', 'run_pin',
    'previous_terminal_sha256', 'config_sha256', 'source_root', 'compose_project',
    'control_volume', 'backend_pin', 'frontend_pin', 'state_root'}


def _validate_args(args):
    import uuid
    from pathlib import Path
    for key in ('attempt', 'stop_attempt'):
        _identity(getattr(args, key, None), re.compile(r'[0-9a-f]{32}\Z'), key)
    for key in ('config_sha256', 'stop_terminal_sha256'):
        _sha(getattr(args, key, None), key)
    _identity(getattr(args, 'run_id', None), RUN_ID_RE, 'run id')
    request_id = getattr(args, 'request_id', None)
    try:
        if not isinstance(request_id, str) or str(uuid.UUID(request_id)) != request_id:
            raise ValueError('not canonical')
    except ValueError as error:
        raise ResumeError('request_id must be a canonical UUID') from error
    if (type(getattr(args, 'preview', None)) is not bool
            or type(getattr(args, 'apply', None)) is not bool
            or args.preview == args.apply):
        _fail('select exactly one preview or apply mode')
    if args.apply:
        _sha(getattr(args, 'expected_plan_sha256', None), 'reviewed plan SHA')
    elif getattr(args, 'expected_plan_sha256', None) is not None:
        _fail('preview cannot carry an apply plan SHA')
    source = getattr(args, 'source_root', None)
    if source is None or not Path(source).is_absolute() or '..' in Path(source).parts:
        _fail('source root must be an exact absolute checkout')
    if type(getattr(args, 'port', None)) is not int or not 1 <= args.port <= 65535:
        _fail('retained frontend port is invalid')
    if (getattr(args, 'fresh_state', False) or getattr(args, 'script', None) is not None
            or getattr(args, 'profile', 'dev') != 'dev'
            or any(getattr(args, key, None) is not None for key in (
                'image', 'toolchain_image', 'source_manifest', 'recovery_authorization',
                'resume_recreation', 'completed_recreation_attempt', 'offline_reconciliation',
                'drained_successor_proof', 'terminal_observation_proof', 'terminal_observation_stop'))):
        _fail('failed-run continuation cannot change storage, replay a script, or combine another recovery')


def _request_path(args):
    return 'failed-run-resume/requests/' + args.request_id + '/plan.json'


def _read_control(control, path, *, optional=False):
    raw = control.read_bytes(path, optional=optional)
    if raw is None and optional:
        return None
    return _canonical_control_record(raw, path)


def _service_pin(container):
    if not isinstance(container, Mapping) or not isinstance(container.get('State'), Mapping):
        _fail('retained service observation is malformed')
    state = container['State']
    return {'Id': container.get('Id'), 'Image': container.get('Image'),
        'StartedAt': state.get('StartedAt'), 'Running': state.get('Running'),
        'Pid': state.get('Pid'), 'ExitCode': state.get('ExitCode'),
        'mounts_sha256': hashlib.sha256(canonical(container.get('Mounts'))).hexdigest(),
        'config_sha256': hashlib.sha256(canonical(container.get('Config'))).hexdigest(),
        'host_config_sha256': hashlib.sha256(canonical(container.get('HostConfig'))).hexdigest()}


def _inspect_container(identifier, *, absent=False):
    from docker_build_control import docker_capture
    result = docker_capture('inspect', identifier, allow_failure=True, timeout=60)
    if absent:
        text = result.stderr.decode('utf-8', 'strict').strip()
        pattern = r'Error(?: response from daemon)?: No such (?:object|container): ' + re.escape(identifier)
        if result.returncode != 1 or result.stdout.strip() not in (b'', b'[]') or re.fullmatch(pattern, text) is None:
            _fail('old service absence is not authoritative: ' + identifier)
        return None
    if result.returncode:
        _fail('cannot inspect the exact retained service; resources retained')
    value = json.loads(result.stdout)
    if not isinstance(value, list) or len(value) != 1 or value[0].get('Id') != identifier:
        _fail('retained service identity is ambiguous')
    return value[0]


def _check_services(actual, phase):
    for service in ('backend', 'frontend'):
        original = actual[service]
        expected = _service_pin(original)
        if phase == 'before-start':
            _inspect_container(expected['Id'], absent=True)
            continue
        observed = _inspect_container(expected['Id'])
        pin = _service_pin(observed)
        if service == 'frontend' and phase == 'before-remove':
            if observed['State'].get('Running') is not False or observed['State'].get('Pid') != 0:
                _fail('pinned frontend was not stopped before removal')
            for key in ('Running', 'Pid', 'ExitCode'):
                pin.pop(key); expected.pop(key)
        if pin != expected or observed['State'].get('OOMKilled') is not False:
            _fail('retained service incarnation changed before continuation')
        if service == 'backend' and (pin['Running'] is not False or pin['Pid'] != 0):
            _fail('failed-run continuation requires the exact stopped backend')


def _validate_removal(control, context, previous, actual, removal):
    if (not isinstance(removal, Mapping) or removal.get('phase') != 'recreate-services'
            or removal.get('state') != 'succeeded'
            or removal.get('compose_project') != control.project
            or removal.get('control_volume') != control.volume
            or removal.get('inputs', {}).get('failed_run_resume') != context
            or removal.get('removed_containers') != [actual['backend']['Id'], actual['frontend']['Id']]
            or removal.get('retained_volumes') != previous.get('backend_volumes')
            or removal.get('retained_frontend_volume') != previous.get('frontend_volume')):
        _fail('before-start requires the exact successful retained recreation removal receipt')
    attempt = _identity(removal.get('attempt'), re.compile(r'[0-9a-f]{32}\Z'), 'removal attempt')
    root = 'recreate-services/attempts/' + attempt
    if (_read_control(control, root + '/terminal.json') != removal
            or _read_control(control, root + '/retained-containers.json') != actual):
        _fail('persisted recreation removal or retained service snapshot changed')


def _collect_resume_context(control, args, previous, document, actual, state, *, phase='preflight'):
    from pathlib import Path
    from docker_volume_stop_diagnostic import _port_matches
    from docker_volume_stop_failed import _owner_identity_key, _validate_native_failed_owner
    from docker_volume_failed_run_resume_observer import capture_accepted_run_snapshot, capture_runtime_evidence
    if (previous.get('inputs', {}).get('source_root') != str(args.source_root)
            or previous.get('state_root') != str(state)
            or document.get('name') != control.project
            or hashlib.sha256(canonical(document)).hexdigest() != args.config_sha256):
        _fail('retained source, Compose, or state root differs')
    _port_matches(document, args.port)
    if str(Path(args.source_root)) != str(args.source_root):
        _fail('source root spelling is not canonical')
    previous_raw = control.read_bytes('development/attempts/' + args.attempt + '/terminal.json')
    if _canonical_control_record(previous_raw, 'retained development terminal') != previous:
        _fail('retained development terminal changed')
    _check_services(actual, phase)
    backend, frontend = actual['backend'], actual['frontend']
    binding = {'stop_attempt': args.stop_attempt, 'stop_terminal_sha256': args.stop_terminal_sha256,
        'development_attempt': args.attempt, 'config_sha256': args.config_sha256,
        'source_root': str(args.source_root), 'compose_project': control.project,
        'control_volume': control.volume, 'backend_container_id': backend['Id'],
        'backend_image_id': backend['Image'], 'backend_started_at': backend['State']['StartedAt'],
        'frontend_container_id': frontend['Id']}
    root = 'stop-diagnostic/attempts/' + args.stop_attempt
    stop_pin = validate_stop_diagnostic_authority(
        control.read_bytes(root + '/terminal.json'),
        control.read_bytes(root + '/diagnostic-stop-terminal.json'), binding)
    live = capture_runtime_evidence(control, backend, document)
    for key in ('runtime_config', 'failed_owner', 'terminal_process_receipt', 'api_failure_fence'):
        record = live.get(key) if isinstance(live, Mapping) else None
        if (not isinstance(record, Mapping) or set(record) != {'sha256', 'value'}
                or not isinstance(record.get('value'), Mapping)
                or record.get('sha256') != stop_pin['runtime_hashes'][key + '_sha256']):
            _fail('live failed runtime evidence changed: ' + key)
    owner = _validate_native_failed_owner(live['failed_owner']['value'],
        allowed_child_statuses=frozenset({'exited_success', 'exited_failure'}))
    typed = _read_control(control, root + '/diagnostic-stop-terminal.json')
    if _owner_identity_key(owner, 'failed owner') != _owner_identity_key(typed['retained_ready_owner'], 'ready owner'):
        _fail('failed owner identity differs from the exact diagnostic stop')
    config = live['runtime_config']['value']
    if (config.get('schema_version') != 'runtime_service_config.v2'
            or config.get('target_id') != 'docker-all'
            or config.get('store_root') != '/state/runs/docker-all/session-store'):
        _fail('retained runtime configuration uses another accepted store')
    snapshot = capture_accepted_run_snapshot(control, backend, document, args.run_id)
    run_pin = validate_accepted_run_snapshot(snapshot, run_id=args.run_id)
    return {'schema': CONTEXT_SCHEMA, 'request_id': args.request_id, 'run_id': args.run_id,
        'stop_pin': stop_pin, 'run_pin': run_pin,
        'previous_terminal_sha256': hashlib.sha256(previous_raw).hexdigest(),
        'config_sha256': args.config_sha256, 'source_root': str(args.source_root),
        'compose_project': control.project, 'control_volume': control.volume,
        'backend_pin': _service_pin(backend), 'frontend_pin': _service_pin(frontend), 'state_root': str(state)}


def _plan(context):
    if not isinstance(context, Mapping) or set(context) != _CONTEXT_KEYS or context.get('schema') != CONTEXT_SCHEMA:
        _fail('continuation context shape differs')
    body = {'schema': PLAN_SCHEMA, 'request_id': context['request_id'], 'pins': dict(context)}
    digest = hashlib.sha256(canonical(body)).hexdigest()
    return {**body, 'plan_sha256': digest}, {**context, 'plan_sha256': digest}


def prepare_resume_request(control, args, previous, document, actual, state):
    _validate_args(args)
    context = _collect_resume_context(control, args, previous, document, actual, state)
    plan, context = _plan(context)
    existing = _read_control(control, _request_path(args), optional=True)
    if existing is not None and existing != plan:
        _fail('request already pins another or changed continuation plan')
    if args.apply and (existing is None or args.expected_plan_sha256 != plan['plan_sha256']):
        _fail('apply requires the exact unchanged preview plan')
    if existing is None:
        control.write(_request_path(args), plan)
    return {'context': context, 'plan': plan}


def revalidate_resume_request(control, args, context, previous, document, actual, state, *, phase, removal=None):
    _validate_args(args)
    if phase not in {'recreate-lease', 'before-remove', 'before-start'}:
        _fail('unsupported continuation lifecycle phase')
    if not isinstance(context, Mapping) or set(context) != _CONTEXT_KEYS | {'plan_sha256'}:
        _fail('continuation context shape changed')
    if not args.apply or args.expected_plan_sha256 != context['plan_sha256']:
        _fail('revalidation requires apply with the same reviewed plan SHA')
    base = {key: value for key, value in context.items() if key != 'plan_sha256'}
    plan, checked = _plan(base)
    if checked != context or _read_control(control, _request_path(args), optional=True) != plan:
        _fail('immutable continuation plan changed')
    if phase == 'before-start':
        _validate_removal(control, context, previous, actual, removal)
    current = _collect_resume_context(control, args, previous, document, actual, state, phase=phase)
    if current != base:
        _fail('retained continuation pins changed before ' + phase)
    return dict(context)


def _request_control(args):
    from pathlib import Path
    from docker_dev import _compose_identity, _select_source
    from docker_build_control import BuildControl, toolchain_configuration
    from docker_dev_host import require_host
    require_host()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    if str(selected) != str(args.source_root):
        _fail('continuation source selection differs')
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    control = BuildControl(identity, configured['services']['fem-gpu-toolchain']['build']['args']['FULLMAG_CUDA_BASE_IMAGE'])
    control.prepare()
    return control


def _completed_result(control, args):
    plan = _read_control(control, _request_path(args), optional=True)
    if plan is None:
        return None
    pins = plan.get('pins')
    if not isinstance(pins, Mapping):
        _fail('saved continuation plan is malformed')
    checked_plan, context = _plan(pins)
    if plan != checked_plan or context['request_id'] != args.request_id:
        _fail('saved continuation plan identity differs')
    stop = context['stop_pin']
    if (context['run_id'] != args.run_id or context['source_root'] != str(args.source_root)
            or context['config_sha256'] != args.config_sha256
            or stop.get('stop_attempt') != args.stop_attempt
            or stop.get('stop_terminal_raw_sha256') != args.stop_terminal_sha256
            or stop.get('development_attempt') != args.attempt):
        _fail('request UUID already belongs to another continuation')
    if context['compose_project'] != control.project or context['control_volume'] != control.volume:
        _fail('completed request belongs to another runtime group')
    if args.apply and args.expected_plan_sha256 != context['plan_sha256']:
        _fail('completed request requires its original reviewed plan SHA')
    pointer_path = 'failed-run-resume/requests/' + args.request_id + '/start.json'
    pointer = _read_control(control, pointer_path, optional=True)
    if pointer is not None:
        if (set(pointer) != {'schema', 'request_id', 'plan_sha256', 'development_attempt'}
                or pointer.get('schema') != 'fullmag.failed-run-resume-start.v1'
                or pointer.get('request_id') != args.request_id
                or pointer.get('plan_sha256') != context['plan_sha256']):
            _fail('request start pointer differs from its immutable plan')
        started_attempt = _identity(pointer.get('development_attempt'), re.compile(r'[0-9a-f]{32}\Z'), 'request development attempt')
        completed = _read_control(control, 'development/attempts/' + started_attempt + '/terminal.json', optional=True)
        if completed is None:
            _fail('request has an unresolved start; retain resources without replay')
    else:
        completed = _read_control(control, 'development/verified.json', optional=True)
    if (isinstance(completed, Mapping) and completed.get('inputs', {}).get('failed_run_resume') == context):
        attempt = _identity(completed.get('attempt'), re.compile(r'[0-9a-f]{32}\Z'), 'completed development attempt')
        if (completed.get('phase') != 'development' or completed.get('state') != 'succeeded'
                or completed.get('compose_project') != control.project
                or completed.get('control_volume') != control.volume
                or _read_control(control, 'development/attempts/' + attempt + '/terminal.json') != completed):
            _fail('completed continuation development proof differs')
        return {'state': 'operation-completed', 'request_id': args.request_id, 'run_id': args.run_id,
            'plan_sha256': context['plan_sha256'], 'development_attempt': attempt,
            'development_terminal_sha256': hashlib.sha256(canonical(completed) + b'\n').hexdigest(),
            'backend_container': completed.get('backend_container'),
            'frontend_container': completed.get('frontend_container')}
    if pointer is not None:
        _fail('request start has no completed success proof; retain resources without replay')
    recreation = _read_control(control, 'recreate-services/verified.json', optional=True)
    if isinstance(recreation, Mapping) and recreation.get('inputs', {}).get('failed_run_resume') == context:
        _fail('continuation removed old services without a completed start; retain resources and do not replay')
    return None



def bind_start_attempt(control, context, operation):
    """Publish the exact start pointer under the already-owned development lease."""
    attempt = _identity(operation['receipt'].get('attempt'), re.compile(r'[0-9a-f]{32}\Z'), 'new development attempt')
    path = 'failed-run-resume/requests/' + context['request_id'] + '/start.json'
    pointer = {'schema': 'fullmag.failed-run-resume-start.v1', 'request_id': context['request_id'],
               'plan_sha256': context['plan_sha256'], 'development_attempt': attempt}
    existing = _read_control(control, path, optional=True)
    if existing is not None and existing != pointer:
        _fail('request already owns another start attempt; do not replay')
    if existing is None:
        control.write(path, pointer)


def run(args):
    _validate_args(args)
    control = _request_control(args)
    completed = _completed_result(control, args)
    if completed is not None:
        return completed
    from docker_volume_dev import resume_failed_run
    result = resume_failed_run(args)
    if args.preview:
        return result
    completed = _completed_result(control, args)
    if completed is None:
        _fail('continuation has no completed managed start proof; resources retained without replay')
    return completed
