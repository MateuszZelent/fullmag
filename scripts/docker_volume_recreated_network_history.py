"""Read-only proof for a network-pool failure after fresh-state recreation."""
from __future__ import annotations

from collections.abc import Mapping
from pathlib import PurePosixPath
import math
import re

from docker_build_control import BuildControlError, canonical
from docker_volume_reconcile import digest, read_raw, require
from docker_volume_fresh_runtime import _archive_mapping


TOKEN = re.compile(r"[0-9a-f]{32}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
CONTAINER = re.compile(r"[0-9a-f]{64}\Z")
RECREATION_SCHEMA = "fullmag.docker-build-operation.v1"
RECREATION_TERMINAL_SCHEMA = "fullmag.docker-fresh-runtime-archive-terminal.v1"
PRELAUNCH_FRESH_SCHEMA = "fullmag.prelaunch-failure-stop-fresh-state.v1"
MAX_RETAINED_RECORDS = 32

PUBLICATION_PATHS = {
    "development/current.json",
    "development/verified.json",
    "backend/runtime-provenance.json",
    "runtime-control/runtime-services/OWNER.json",
    "runtime-control/runtime-service/process-tree.json",
}


def _json(raw: bytes, label: str) -> dict:
    from docker_volume_prelaunch_failure_stop import decode

    value = decode(raw)
    require(raw == canonical(value) + b"\n", label + " is not canonical JSON")
    return value


def _time(value: object, label: str) -> float:
    require(type(value) in (int, float) and math.isfinite(value) and value > 0,
            label + " is not a finite positive timestamp")
    return float(value)


def _token(value: object, label: str) -> str:
    require(isinstance(value, str) and TOKEN.fullmatch(value) is not None,
            label + " is not a lowercase operation token")
    return value


def _sha(value: object, label: str) -> str:
    require(isinstance(value, str) and SHA256.fullmatch(value) is not None,
            label + " is not a lowercase SHA-256")
    return value


def _group(document: Mapping, control, label: str) -> None:
    require(document.get("compose_project") == control.project
            and document.get("control_volume") == control.volume,
            label + " belongs to another control group")
    namespace = getattr(control, "namespace", "")
    require(document.get("control_namespace", "") == namespace,
            label + " belongs to another control namespace")


def _read_record(control, path: str, retained: dict[str, str | None], *, optional=False):
    raw = read_raw(control, path, optional=optional)
    if raw is None:
        require(optional, "Required history record is absent: " + path)
        retained[path] = None
        return None, None
    require(isinstance(raw, bytes), "History reader returned non-bytes: " + path)
    value = _json(raw, path)
    retained[path] = digest(raw)
    return raw, value


def _identity_inputs(inputs: object, identity: Mapping, label: str) -> None:
    require(isinstance(inputs, Mapping), label + " source identity is absent")
    require(inputs.get("source_root") == identity.get("source_root"), label + " source root differs")
    for input_key, identity_key in (
        ("source_project_id", "project_id"),
        ("source_worktree_id", "worktree_id"),
        ("source_checkout_kind", "checkout_kind"),
    ):
        require(inputs.get(input_key) == identity.get(identity_key),
                label + " source identity differs: " + input_key)


def _stop_source_root(inputs: object, identity: Mapping) -> None:
    require(isinstance(inputs, Mapping)
            and inputs.get("source_root") == identity.get("source_root"),
            "Prelaunch stop source root differs from the selected checkout")


def _validate_quiescence_services(intent: Mapping, identity: Mapping, containers: list[str]) -> None:
    from docker_compose_identity import source_labels

    try:
        expected_labels = source_labels(identity)
    except (TypeError, ValueError) as error:
        raise BuildControlError("Selected source labels are malformed") from error
    services = intent.get("services")
    require(isinstance(services, Mapping) and set(services) == {"backend", "frontend"},
            "Prelaunch intent does not bind both selected Compose services")
    for name, identifier in zip(("backend", "frontend"), containers):
        document = services.get(name)
        config = document.get("Config") if isinstance(document, Mapping) else None
        labels = config.get("Labels") if isinstance(config, Mapping) else None
        require(isinstance(document, Mapping) and document.get("Id") == identifier
                and isinstance(labels, Mapping)
                and all(labels.get(key) == value for key, value in expected_labels.items()),
                "Prelaunch intent service identity differs from the selected source")


def _absolute_state_root(value: object, label: str) -> PurePosixPath:
    require(isinstance(value, str) and value.startswith("/") and len(value) <= 4096,
            label + " is not an absolute bounded path")
    path = PurePosixPath(value)
    require(str(path) == value and ".." not in path.parts and path.name not in {"", "."},
            label + " is not canonical")
    return path


def _validate_provenance(provenance: Mapping, process: Mapping) -> dict[str, object]:
    require(provenance.get("schema") == "fullmag.docker-all-image.v1"
            and provenance.get("state") == "succeeded",
            "Retained backend provenance is not a successful package record")
    receipt_sha = _sha(provenance.get("build_receipt_sha256"), "Runtime build receipt SHA-256")
    package_root = provenance.get("package_root")
    require(package_root == "/opt/fullmag/package"
            and provenance.get("backend_build_receipt")
                == package_root + "/backend-build-receipt.json"
            and provenance.get("backend_build_receipt_schema")
                == "fullmag.direct-compose.backend-build-receipt.v1",
            "Runtime provenance does not name the canonical package receipt")

    owner = process.get("service_owner")
    require(isinstance(owner, Mapping), "Drained native service owner is absent")
    commit = owner.get("build_commit")
    snapshot = owner.get("build_snapshot")
    native = provenance.get("native_source_identity")
    require(isinstance(native, Mapping)
            and native.get("schema") == "fullmag.source-snapshot.v2"
            and isinstance(commit, str) and re.fullmatch(r"[0-9a-f]{40}", commit)
            and isinstance(snapshot, str) and SHA256.fullmatch(snapshot)
            and native.get("head_commit_full") == commit
            and provenance.get("commit") == commit
            and provenance.get("native_source_identity_sha256")
                == digest(canonical(dict(native)) + b"\n")
            and native.get("source_snapshot_sha256") == snapshot
            and provenance.get("source_snapshot_sha256") == snapshot
            and provenance.get("source_mode") in {"archive", "live-shadow-v1"}
            and provenance.get("direct_source_provenance") == (
                "fullmag.docker-backend-live-source.v1"
                if provenance.get("source_mode") == "live-shadow-v1"
                else "fullmag.docker-backend-source.v1"
            ),
            "Runtime native source provenance differs from the archived service build identity")
    source_digest = _sha(provenance.get("source_digest"), "Runtime source digest")

    binary_hashes = provenance.get("binary_hashes")
    require(isinstance(binary_hashes, Mapping) and bool(binary_hashes)
            and all(isinstance(name, str) and name and isinstance(value, str)
                    and SHA256.fullmatch(value) is not None
                    for name, value in binary_hashes.items()),
            "Runtime provenance binary hash inventory is malformed")
    return {
        "native_build_commit": commit,
        "native_build_snapshot_sha256": snapshot,
        "native_source_digest": source_digest,
        "build_receipt_sha256": receipt_sha,
        "source_mode": provenance.get("source_mode"),
    }


def validate_recreated_history(
    control,
    *,
    recreation_attempt: str,
    recreation_sha256: str,
    failed_attempt: str,
    original: dict,
    publications: dict[str, bytes | None],
    attempts: list[tuple[str, str]],
) -> dict[str, object]:
    """Bind one later network failure to its successful fresh recreation and old owner."""
    from docker_volume_prelaunch_failure_stop import (
        POSTDRAIN_SCHEMA,
        QUIESCE_INTENT_SCHEMA,
        _store_binding_hash,
        validate_capture,
        validate_drain,
        validate_source_binding_chain,
    )

    recreation_attempt = _token(recreation_attempt, "recreation attempt")
    recreation_sha256 = _sha(recreation_sha256, "recreation receipt pin")
    failed_attempt = _token(failed_attempt, "failed development attempt")
    require(recreation_attempt != failed_attempt, "Recreation and failed development attempts must differ")
    identity = getattr(control, "identity", None)
    require(isinstance(identity, Mapping), "Control source identity is unavailable")
    source_root = identity.get("source_root")
    require(isinstance(source_root, str) and source_root.startswith("/")
            and str(PurePosixPath(source_root)) == source_root
            and ".." not in PurePosixPath(source_root).parts,
            "Control source root is not canonical")

    target_root = "development/attempts/" + failed_attempt
    target_terminal = target_root + "/terminal.json"
    required_publications = PUBLICATION_PATHS | {target_terminal}
    require(isinstance(publications, dict) and set(publications) == required_publications,
            "Recreated-history publication inventory is incomplete")
    require(publications[target_terminal] is None
            and publications["runtime-control/runtime-services/OWNER.json"] is None
            and publications["runtime-control/runtime-service/process-tree.json"] is None,
            "New terminal or old runtime owner/process publication remains")
    require(isinstance(publications["development/current.json"], bytes)
            and isinstance(publications["development/verified.json"], bytes)
            and isinstance(publications["backend/runtime-provenance.json"], bytes),
            "Old development pointers or runtime provenance are absent")

    retained: dict[str, str | None] = {
        "runtime-control/runtime-services/OWNER.json": None,
        "runtime-control/runtime-service/process-tree.json": None,
    }
    current_raw = publications["development/current.json"]
    verified_raw = publications["development/verified.json"]
    require(current_raw == verified_raw, "Current and verified development pointers differ")
    current = _json(current_raw, "development/current.json")
    retained["development/current.json"] = digest(current_raw)
    retained["development/verified.json"] = digest(verified_raw)

    old_attempt = _token(current.get("attempt"), "previous development attempt")
    require(old_attempt != failed_attempt, "Failed development attempt already owns the old pointers")
    old_root = "development/attempts/" + old_attempt
    old_terminal_raw, old_terminal = _read_record(
        control, old_root + "/terminal.json", retained,
    )
    require(old_terminal_raw == current_raw and old_terminal == current,
            "Old current/verified pointers differ from their immutable terminal receipt")
    require(current.get("schema") == RECREATION_SCHEMA
            and current.get("phase") == "development"
            and current.get("state") == "succeeded",
            "Old development pointer is not a successful development terminal")
    _group(current, control, "Old development terminal")
    _identity_inputs(current.get("inputs"), identity, "Old development terminal")
    old_state = _absolute_state_root(current.get("state_root"), "Old state root")
    require(old_state.name == old_attempt, "Old state root does not belong to its development attempt")

    require(isinstance(attempts, list)
            and all(isinstance(item, tuple) and len(item) == 2 for item in attempts)
            and sorted(attempts) == sorted([(old_attempt, "d"), (failed_attempt, "d")]),
            "Development attempt inventory is not exactly the old and failed attempts")

    failed_raw = read_raw(control, target_root + "/receipt.json")
    require(isinstance(failed_raw, bytes) and _json(failed_raw, "Failed development receipt") == original,
            "Failed target receipt differs from the supplied original")
    require(isinstance(original, dict)
            and original.get("schema") == RECREATION_SCHEMA
            and original.get("phase") == "development"
            and original.get("state") == "outcome-unknown-resources-retained"
            and original.get("attempt") == failed_attempt,
            "Only the exact later unknown development attempt is admissible")
    _group(original, control, "Failed development receipt")
    _identity_inputs(original.get("inputs"), identity, "Failed development receipt")
    new_state = _absolute_state_root(original.get("state_root"), "Fresh failed state root")
    require(new_state.parent == old_state.parent and new_state.name == failed_attempt
            and new_state != old_state,
            "Failed attempt does not use its exact fresh state path under the old runtime root")

    old_finished = _time(current.get("finished_at"), "Old development finish time")
    failed_started = _time(original.get("started_at"), "Failed development start time")
    require(failed_started > old_finished,
            "Failed development attempt did not start after the old owner")

    rec_root = "recreate-services/attempts/" + recreation_attempt
    rec_terminal_path = rec_root + "/terminal.json"
    rec_raw, recreation = _read_record(control, rec_terminal_path, retained)
    require(digest(rec_raw) == recreation_sha256,
            "Fresh recreation terminal differs from the supplied SHA-256 pin")
    rec_receipt_raw, rec_receipt = _read_record(control, rec_root + "/receipt.json", retained)
    require(rec_receipt_raw == rec_raw and rec_receipt == recreation,
            "Fresh recreation receipt differs from its terminal")
    require(recreation.get("schema") == RECREATION_SCHEMA
            and recreation.get("phase") == "recreate-services"
            and recreation.get("state") == "succeeded"
            and recreation.get("fresh_state") is True
            and recreation.get("attempt") == recreation_attempt,
            "Pinned recreation is not a successful fresh-state operation")
    _group(recreation, control, "Fresh recreation terminal")
    rec_inputs = recreation.get("inputs")
    require(isinstance(rec_inputs, Mapping) and rec_inputs.get("attempt") == old_attempt,
            "Fresh recreation does not bind the old development attempt")
    require(recreation.get("previous_state_root") == str(old_state),
            "Fresh recreation archived a different old state root")
    rec_started = _time(recreation.get("started_at"), "Fresh recreation start time")
    rec_finished = _time(recreation.get("finished_at"), "Fresh recreation finish time")
    require(old_finished <= rec_started < rec_finished < failed_started,
            "Old, recreation, and failed development operation order differs")

    old_containers = [current.get("backend_container"), current.get("frontend_container")]
    require(all(isinstance(value, str) and CONTAINER.fullmatch(value) for value in old_containers)
            and len(set(old_containers)) == 2
            and recreation.get("removed_containers") == old_containers,
            "Recreation removed-container list differs from the old development owner")

    stop_pin = rec_inputs.get("prelaunch_failure_stop")
    require(isinstance(stop_pin, Mapping) and set(stop_pin) == {"attempt", "terminal_sha256"},
            "Fresh recreation has no exact prelaunch stop pin")
    stop_attempt = _token(stop_pin.get("attempt"), "Prelaunch stop attempt")
    stop_sha256 = _sha(stop_pin.get("terminal_sha256"), "Prelaunch stop terminal SHA-256")
    stop_root = "iteration/attempts/" + stop_attempt
    stop_terminal_path = stop_root + "/terminal.json"
    stop_raw, stop = _read_record(control, stop_terminal_path, retained)
    require(digest(stop_raw) == stop_sha256,
            "Prelaunch stop terminal differs from the recreation pin")
    stop_receipt_raw, stop_receipt = _read_record(control, stop_root + "/receipt.json", retained)
    require(stop_receipt_raw == stop_raw and stop_receipt == stop,
            "Prelaunch stop receipt differs from its immutable terminal")
    require(stop.get("schema") == RECREATION_SCHEMA
            and stop.get("phase") == "iteration" and stop.get("state") == "succeeded"
            and stop.get("attempt") == stop_attempt and stop.get("idle_backend_stopped") is True,
            "Pinned prelaunch stop is not a successful stop-only operation")
    _group(stop, control, "Prelaunch stop terminal")
    stop_inputs = stop.get("inputs")
    _stop_source_root(stop_inputs, identity)
    require(isinstance(stop_inputs, Mapping)
            and stop_inputs.get("attempt") == old_attempt
            and stop_inputs.get("capture_prelaunch_failure") is True
            and stop_inputs.get("quiesce_api") is True
            and stop.get("backend_container") == old_containers[0]
            and stop.get("frontend_container") == old_containers[1],
            "Prelaunch stop does not bind the old development owner and stop-only mode")
    require(stop.get("config_sha256") == rec_inputs.get("config_sha256"),
            "Prelaunch stop and recreation use different Compose configurations")
    stop_started = _time(stop.get("started_at"), "Prelaunch stop start time")
    stop_finished = _time(stop.get("finished_at"), "Prelaunch stop finish time")
    require(old_finished <= stop_started <= stop_finished < rec_started,
            "Prelaunch stop did not complete between the old development and recreation")

    capture_path = stop_root + "/prelaunch-failure-stop.json"
    capture_raw, captured = _read_record(control, capture_path, retained)
    require(digest(capture_raw) == stop.get("prelaunch_failure_capture_sha256"),
            "Prelaunch capture differs from the successful stop receipt")
    intent_path = stop_root + "/prelaunch-failure-quiescence-intent.json"
    intent_raw, intent = _read_record(control, intent_path, retained)
    require(digest(intent_raw) == stop.get("api_quiescence_intent_sha256")
            and intent.get("schema") == QUIESCE_INTENT_SCHEMA,
            "Durable API-quiescence intent differs from the stop receipt")
    source_binding = validate_source_binding_chain(stop_inputs, intent, captured)
    _validate_quiescence_services(intent, identity, old_containers)
    validate_capture(captured)

    drain_path = stop_root + "/backend-drain.json"
    drain_raw, drain = _read_record(control, drain_path, retained)
    process = drain.get("process_receipt")
    require(drain.get("schema") == "fullmag.docker-idle-restart-drain.v1"
            and drain.get("backend_container_id") == old_containers[0]
            and isinstance(process, dict)
            and drain.get("process_receipt_sha256") == digest(canonical(process) + b"\n"),
            "Prelaunch stop native drain receipt is not pinned")
    validate_drain(captured, process)
    postdrain_path = stop_root + "/prelaunch-failure-postdrain-lock.json"
    postdrain_raw, postdrain = _read_record(control, postdrain_path, retained)
    store_binding = captured["store_binding"]
    require(digest(postdrain_raw) == stop.get("prelaunch_failure_postdrain_sha256")
            and postdrain.get("schema") == POSTDRAIN_SCHEMA
            and postdrain.get("run_id") == store_binding.get("run_id")
            and postdrain.get("store_id") == store_binding.get("store_id")
            and postdrain.get("store_binding_sha256") == _store_binding_hash(store_binding)
            and postdrain.get("locked_evidence_sha256") == captured.get("locked_evidence_sha256"),
            "Post-drain lock witness differs from the captured failed run")

    witness = recreation.get("prelaunch_failure_fresh_archive")
    expected_witness = {
        "schema": PRELAUNCH_FRESH_SCHEMA,
        "stop_attempt": stop_attempt,
        "stop_sha256": stop_sha256,
        "capture_sha256": digest(capture_raw),
        "source_binding_sha256": digest(canonical(source_binding)),
        "store_binding_sha256": _store_binding_hash(store_binding),
    }
    require(witness == expected_witness,
            "Fresh recreation lacks the exact completed prelaunch-preservation witness")

    archive_path = rec_root + "/runtime-control-archive-terminal.json"
    archive_raw, archive = _read_record(control, archive_path, retained)
    embedded_archive = recreation.get("runtime_control_archive")
    require(isinstance(embedded_archive, Mapping) and archive == embedded_archive
            and archive_raw == canonical(embedded_archive) + b"\n",
            "Fresh-runtime archive terminal differs from the recreation receipt")
    private_ledger = "preserved_group_ledger_subpath" in archive
    expected_mapping = _archive_mapping(recreation_attempt, private_ledger=private_ledger)
    old_services = {"backend": old_containers[0], "frontend": old_containers[1]}
    require(archive.get("schema") == RECREATION_TERMINAL_SCHEMA
            and archive.get("state") == "succeeded"
            and archive.get("operation_attempt") == recreation_attempt
            and archive.get("compose_project") == control.project
            and archive.get("control_volume") == control.volume
            and archive.get("control_namespace", "") == getattr(control, "namespace", "")
            and archive.get("removed_containers") == old_services
            and archive.get("mapping") == expected_mapping,
            "Archive terminal does not bind this group's old runtime to the recreation")
    archive_intent_path = rec_root + "/runtime-control-archive-intent.json"
    archive_intent_raw, archive_intent = _read_record(control, archive_intent_path, retained)
    require(digest(archive_intent_raw) == archive.get("intent_sha256")
            and archive_intent.get("schema") == "fullmag.docker-fresh-runtime-archive-intent.v1"
            and archive_intent.get("operation_attempt") == recreation_attempt
            and archive_intent.get("compose_project") == control.project
            and archive_intent.get("control_volume") == control.volume
            and archive_intent.get("control_namespace", "") == getattr(control, "namespace", "")
            and archive_intent.get("source_root") == source_root
            and archive_intent.get("previous_state_root") == str(old_state)
            and archive_intent.get("removed_containers") == old_services
            and archive_intent.get("mapping") == expected_mapping,
            "Archive intent does not bind the old runtime, source and removed services")

    archived_root = "runtime-archives/" + recreation_attempt + "/runtime-service"
    archived_config_path = archived_root + "/docker-all.json"
    archived_config_raw = read_raw(control, archived_config_path)
    require(isinstance(archived_config_raw, bytes)
            and digest(archived_config_raw) == captured.get("native_config_sha256"),
            "Archived native runtime configuration differs from the prelaunch stop capture")
    retained[archived_config_path] = digest(archived_config_raw)
    archived_process_path = archived_root + "/process-tree.json"
    archived_process_raw, archived_process = _read_record(
        control, archived_process_path, retained,
    )
    require(archived_process == process
            and archived_process_raw == canonical(process) + b"\n",
            "Archived native process receipt differs from the exact drained stop receipt")

    provenance_raw = publications["backend/runtime-provenance.json"]
    provenance = _json(provenance_raw, "backend/runtime-provenance.json")
    retained["backend/runtime-provenance.json"] = digest(provenance_raw)
    provenance_identity = _validate_provenance(provenance, process)

    require(len(retained) <= MAX_RETAINED_RECORDS,
            "Recreated-history proof exceeds its retained-record bound")
    return {
        "schema": "fullmag.docker-development-network-recreated-history.v1",
        "mode": "fresh-state-prelaunch-failure-archive",
        "recreation_attempt": recreation_attempt,
        "recreation_sha256": recreation_sha256,
        "failed_attempt": failed_attempt,
        "previous_development_attempt": old_attempt,
        "prelaunch_stop_attempt": stop_attempt,
        "prelaunch_stop_sha256": stop_sha256,
        "old_state_root": str(old_state),
        "fresh_state_root": str(new_state),
        "source_identity": {
            "source_root": source_root,
            "project_id": identity.get("project_id"),
            "worktree_id": identity.get("worktree_id"),
            "checkout_kind": identity.get("checkout_kind"),
        },
        **provenance_identity,
        "retained_records": retained,
    }
