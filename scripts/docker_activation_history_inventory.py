"""Read-only inventories used by the managed activation history transaction."""
from __future__ import annotations

from datetime import datetime
import os
from pathlib import Path
import re
import stat
import subprocess
import uuid

from docker_activation_history_policy import (
    HistoryError, canonical, digest, document, file_manifest, referenced_attempts,
)
from docker_activation_history_reader import activation_history_read_script
from docker_activation_history_storage import _directory, _raw, _entries


# Technical compiler/package trees and immutable historical evidence are not
# live recovery roots. Every other control document is conservatively a pin.
EXCLUDED_ROOTS = frozenset({"private", "verification", "runtime-archives"})
KNOWN_ROOTS = frozenset({
    "image-backend", "resume", "toolchain", "prepared-unclaimed", "development",
    "cache-maintenance", "cache-retirement", "image-dev", "runtime-control",
    "activation", "iteration", "backend", "frontend", "cancelled-activation-recovery",
    "cold-stored-budget-stop-preview", "cold-stored-budget-stop", "recreate-services",
    "offline-reconciliation", "pre-admission-output-reconciliation", "namespaces",
    "host-device-reattest", "container-recovery-preparation", "runtime-services",
    "stop-bootstrap", "stop-bootstrap-frontend",
    "startup-recovery-stop", "startup-recovery-stop-preview",
    "stop-diagnostic", "stop-diagnostic-preview",
    "browser-qa", "claimed-interruption-collect", "cancel-failed-no-spawn",
    "no-spawn-cancellation", "stop-failed-runtime", "recovery-promotion", "recovery-build",
    "bootstrap-namespace-proof", "bootstrap-container-proof",
}) | EXCLUDED_ROOTS
MAX_INVENTORY_ENTRIES = 70000
MAX_PIN_BYTES = 32 * 1024 * 1024
HOST_LEDGER_ROOT_WRITER_OWNER = "runtime-control/host-ledger-roots/WRITER.owner.json"
WRITER_TIMESTAMP = re.compile(
    r"([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})"
    r"(?:\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})\Z"
)


def _writer_uuid(value, label):
    if not isinstance(value, str):
        raise HistoryError("Host ledger writer " + label + " is malformed")
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError) as error:
        raise HistoryError("Host ledger writer " + label + " is malformed") from error
    if str(parsed) != value or parsed.version != 4 or parsed.variant != uuid.RFC_4122:
        raise HistoryError("Host ledger writer " + label + " is malformed")


def _writer_timestamp(value, label):
    match = WRITER_TIMESTAMP.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise HistoryError("Host ledger writer " + label + " timestamp is malformed")
    try:
        datetime.strptime(match.group(1), "%Y-%m-%dT%H:%M:%S")
    except ValueError as error:
        raise HistoryError("Host ledger writer " + label + " timestamp is malformed") from error
    zone = match.group(3)
    if zone != "Z":
        hours, minutes = map(int, zone[1:].split(":"))
        if hours > 23 or minutes > 59:
            raise HistoryError("Host ledger writer " + label + " timestamp is malformed")


def _host_ledger_writer_digest(raw):
    value = document(raw, "host ledger roots writer owner")
    if value.get("schema") != "fullmag.writer.v1" or value.get("released") is not True:
        raise HistoryError("Host ledger roots writer owner is not a released fullmag.writer.v1 record")
    _writer_uuid(value.get("token"), "token")
    _writer_uuid(value.get("process_start_token"), "process_start_token")
    if not isinstance(value.get("host"), str) or not value["host"]:
        raise HistoryError("Host ledger writer host identity is malformed")
    if type(value.get("pid")) is not int or not 0 < value["pid"] <= 0xFFFFFFFF:
        raise HistoryError("Host ledger writer pid is malformed")
    _writer_timestamp(value.get("acquired_at"), "acquired_at")
    _writer_timestamp(value.get("heartbeat_at"), "heartbeat_at")

    # Rust rewrites these three values for every write transaction. Keep every
    # stable and future field in the digest so identity changes remain pinned.
    stable = dict(value)
    for key in ("token", "acquired_at", "heartbeat_at"):
        del stable[key]
    return digest(canonical(stable))


def _reference_digest(root, relative, raw):
    if relative == HOST_LEDGER_ROOT_WRITER_OWNER:
        return _host_ledger_writer_digest(raw)
    if relative != "runtime-control/runtime-services/OWNER.json":
        return digest(raw)
    value = document(raw, "runtime owner")
    token, heartbeat = value.get("owner_token"), value.get("heartbeat_at")
    if (value.get("schema_version") != "runtime_service_owner.v1"
            or value.get("protocol") != "stdin-v1" or value.get("target_id") != "docker-all"
            or value.get("state") != "ready" or not isinstance(token, str)
            or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", token) is None
            or not isinstance(heartbeat, str)
            or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z", heartbeat) is None):
        raise HistoryError("Runtime owner is not an authenticated healthy heartbeat")
    from datetime import datetime
    try:
        datetime.strptime(heartbeat[:-1].split(".")[0], "%Y-%m-%dT%H:%M:%S")
    except ValueError as error:
        raise HistoryError("Runtime owner heartbeat timestamp is malformed") from error
    ready = document(_raw(root / "runtime-control/runtime-services" / ("docker-client-" + token + ".json")),
                     "immutable runtime Ready owner")
    def identity(owner):
        return {key: item for key, item in owner.items() if key != "heartbeat_at"}
    if identity(value) != identity(ready):
        raise HistoryError("Runtime owner differs from its immutable Ready identity")
    # Only this periodic timestamp is volatile. The complete raw document is
    # still scanned for references, and the immutable Ready record stays pinned.
    return digest(canonical(identity(value)))


def tree_inventory(root):
    """Pin all paths/stat data and bounded metadata, without copying field data."""
    root = _directory(root)
    rows = []
    def walk_error(error):
        raise HistoryError("Cannot inventory preserved data: " + str(error))
    for parent, directories, files in os.walk(root, followlinks=False, onerror=walk_error):
        for name in sorted(directories + files):
            path = Path(parent) / name
            info = path.lstat()
            relative = path.relative_to(root).as_posix()
            if stat.S_ISDIR(info.st_mode):
                row = {"path": relative, "kind": "directory"}
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                row = {"path": relative, "kind": "file", "size": info.st_size,
                       "mtime_ns": info.st_mtime_ns}
                if name.endswith((".json", ".py")) or name in {".zgroup", ".zattrs", ".zarray"}:
                    row["sha256"] = digest(_raw(path))
            else:
                raise HistoryError("Preserved data contains a link or special entry")
            rows.append(row)
            if len(rows) > MAX_INVENTORY_ENTRIES:
                raise HistoryError("Preserved data inventory exceeds its bound")
    return {"entries": len(rows), "sha256": digest(canonical(sorted(rows, key=lambda row: row["path"]))) }


def source_inventory(root):
    scripts = _directory(root / "scripts")
    paths = sorted(path for path in scripts.glob("*.py") if not path.name.startswith("test_"))
    if not paths or len(paths) > 4096:
        raise HistoryError("Launcher source inventory is incomplete or unbounded")
    return {path.name: digest(_raw(path)) for path in paths}


def _closed_recovery_metadata_file(path):
    from pathlib import PurePosixPath
    from docker_volume_offline_reconcile import _metadata_file
    parts = PurePosixPath(path).parts
    retirement_json = len(parts) >= 3 and parts[0] == "retirements" and path.endswith(".json")
    retirement_script = len(parts) == 4 and parts[0] == "retirements" and parts[2:] == ("project", "main.py")
    return (retirement_json or retirement_script or (path.endswith(".json") and (
        _metadata_file(path) or any(word in path.casefold() for word in ("admission", "idempotency", "intake", "intent")))))


def _authenticate_own_predecessor_retirement(attempt, receipt, records, paths):
    """Allow one operation identity only inside its byte-bound predecessor archive."""
    from docker_startup_script import _validate_retirement_response, _retirement_scope, StartupScriptError
    prefix = "retirements/" + attempt
    own_paths = [path for path in paths if path == prefix or path.startswith(prefix + "/")]
    response = receipt.get("retirement")
    if not own_paths and response is None:
        return None
    manifest_path = prefix + "/project/retirement-manifest.json"
    raw = records.get(manifest_path)
    if not isinstance(response, dict) or not isinstance(raw, bytes):
        raise HistoryError("Closed recovery predecessor retirement manifest or response is missing")
    proof = document(raw, "closed recovery predecessor retirement")
    if (proof.get("schema") != "fullmag.live-workspace-retirement-proof.v2"
            or proof.get("state") != "retired" or proof.get("operation_id") != attempt
            or response.get("schema") != "fullmag.live-workspace-retirement-response.v1"
            or response.get("archive_sha256") != digest(raw)
            or response.get("archive_manifest_path") != manifest_path
            or receipt.get("retirement_result") != {"state": "retirement-only", "retirement": response}):
        raise HistoryError("Closed recovery predecessor retirement is not authenticated")
    try:
        _retirement_scope(proof["request_scope_epoch"])
        _retirement_scope(response["api_request_scope_epoch"])
        _validate_retirement_response(response, operation_id=attempt, session_id=proof["session_id"],
            run_id=proof["run_id"], request_scope_epoch=proof["request_scope_epoch"],
            api_request_scope_epoch=response["api_request_scope_epoch"])
    except (StartupScriptError, KeyError) as error:
        raise HistoryError("Closed recovery predecessor retirement response differs") from error
    fields = ("session_id", "run_id", "request_scope_epoch", "session_epoch", "scene_revision",
              "state_version", "terminal_outcome", "terminal_evidence_sha256", "ui_state_scope", "script_available")
    if any(response.get(key) != proof.get(key) for key in fields):
        raise HistoryError("Closed recovery predecessor retirement manifest identity differs")
    run_id = proof.get("run_id")
    catalog_raw = records.get("runs/" + str(run_id) + "/run_catalog.json")
    intent_raw = records.get("runs/" + str(run_id) + "/run_intent.json")
    if not isinstance(catalog_raw, bytes) or not isinstance(intent_raw, bytes):
        raise HistoryError("Closed recovery predecessor accepted run evidence is missing")
    catalog = document(catalog_raw, "predecessor run catalog")
    intent = document(intent_raw, "predecessor run intent")
    workspace = intent.get("specification", {}).get("parameters", {}).get("live_workspace", {})
    revision = proof.get("terminal_catalog_revision")
    if (catalog.get("schema_version") != "run_catalog.v1" or catalog.get("run_id") != run_id
            or type(revision) is not int or revision <= 0
            or type(catalog.get("revision")) is not int or catalog["revision"] < revision
            or proof.get("terminal_outcome") not in {"completed", "failed", "cancelled"}
            or intent.get("schema_version") != "run_intent.v1" or intent.get("run_id") != run_id
            or not isinstance(workspace, dict) or workspace.get("session_id") != proof.get("session_id")):
        raise HistoryError("Closed recovery predecessor run/session inventory binding differs")
    documents = proof.get("documents")
    allowed = {"main.py", "scene_document.json", "ui_state.json", "workspace_metadata.json"}
    if (not isinstance(documents, dict) or not {"ui_state.json", "workspace_metadata.json"} <= set(documents)
            or not set(documents) <= allowed or proof.get("script_available") != ("main.py" in documents)):
        raise HistoryError("Closed recovery predecessor document set is invalid")
    for name, pin in documents.items():
        content = records.get(prefix + "/project/" + name)
        if (not isinstance(pin, dict) or not isinstance(content, bytes)
                or pin.get("sha256") != digest(content) or pin.get("object_ref") != pin.get("sha256")
                or type(pin.get("byte_length")) is not int or pin["byte_length"] != len(content)):
            raise HistoryError("Closed recovery predecessor document pin differs")
    return prefix, manifest_path


def _closed_recovery_store_evidence(store_root):
    """Read complete fresh admission metadata; caller holds existing writer fences."""
    from docker_volume_offline_reconcile import _inventory_store, _read_store_file
    root = Path(store_root)
    _inventory_store(root)  # Requires terminal catalogs, released leases and writer.
    paths = sorted(path.relative_to(root).as_posix() for path in root.rglob("*"))
    required = [path for path in paths if _closed_recovery_metadata_file(path)]
    return {path: _read_store_file(root, path)[0] for path in required}, paths


def _closed_recovery_request_identities(attempt, inputs):
    request_hash = digest(inputs["request_id"].encode())
    session_parts = [inputs["request_id"], inputs["source_sha256"]]
    needles = {attempt, inputs["request_id"], request_hash, "live-http-" + request_hash,
               "docker-startup-" + digest("\0".join(session_parts).encode())}
    if "solver_profile_sha256" in inputs:
        session_parts.append(inputs["solver_profile_sha256"])
        needles.add("docker-startup-" + digest("\0".join(session_parts).encode()))
    if "cuda_trace_sha256" in inputs:
        # Match docker_startup.rs::startup_session_id exactly, including its tag.
        session_parts.extend(["cuda_trace", inputs["cuda_trace_sha256"]])
        needles.add("docker-startup-" + digest("\0".join(session_parts).encode()))
    return needles


def validate_closed_pre_admission_recovery(attempt, files, *, marker_raw, identity,
                                           store_records, inventory_paths):
    """Authenticate only the completed no-admission producer, without rewriting it."""
    import math
    from types import SimpleNamespace
    from docker_build_control import BuildControlError
    from docker_dev_reconcile_helper_output_failure import (
        SCHEMA, failure_response, failure_variant, retained_plan, validate_terminal_proof_variant,
    )
    from docker_volume_activation_reconcile import _validate_activation_receipt

    required_files = {"receipt.json", "terminal.json", "authorization.json", "startup-provenance.json",
                      "terminal-history-output-intent.json", "terminal-history-output-proof.json", "build.log"}
    if not isinstance(files, dict) or set(files) != required_files or not isinstance(identity, dict):
        raise HistoryError("Closed recovery record set is incomplete or unclassified")
    receipt = document(files["receipt.json"], "closed recovery original receipt")
    terminal = document(files["terminal.json"], "closed recovery terminal")
    proof = document(files["terminal-history-output-proof.json"], "closed recovery proof")
    intent = document(files["terminal-history-output-intent.json"], "closed recovery intent")
    try:
        _, _, inputs = _validate_activation_receipt(
            SimpleNamespace(project=identity["compose_project"], volume=identity["control_volume"]),
            activation_attempt=attempt, development_attempt=receipt["development_attempt"],
            config_sha256=receipt["config_sha256"], source_root=identity["source_root"],
            image_id=receipt["image_id"], backend_id=receipt["backend_container"],
            receipt_raw=files["receipt.json"])
        for key in ("started_at", "finished_at"):
            value = receipt.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise HistoryError("Closed recovery receipt timestamp is invalid")
        if receipt["finished_at"] < receipt["started_at"]:
            raise HistoryError("Closed recovery receipt timestamps are unordered")
        if receipt.get("retirement_phase") != "startup":
            raise HistoryError("Closed recovery was not a startup failure")
        if any(record.get(key) is not None for record in (receipt, terminal)
               for key in ("run_id", "session_id")):
            raise HistoryError("Closed recovery has an accepted run or session")
        if any(receipt.get(key) != value for key, value in inputs.items()):
            raise HistoryError("Closed recovery top-level identity differs from immutable inputs")
        response = failure_response(receipt.get("error"))
        variant = failure_variant(response)
        validate_terminal_proof_variant(proof, variant)
        if (set(proof) != {"schema", "plan", "plan_sha256", "failure_variant", "process_tree_sha256",
                          "preserved_store", "outcome", "old_request_replay"}
                or proof.get("schema") != SCHEMA or proof.get("outcome") != "not-admitted"
                or proof.get("old_request_replay") != "forbidden"
                or re.fullmatch(r"[0-9a-f]{64}", str(proof.get("process_tree_sha256"))) is None):
            raise HistoryError("Closed recovery release proof is malformed")
        marker = document(marker_raw, "closed recovery started marker")
        authorization = document(files["authorization.json"], "closed recovery authorization")
        if (marker != {"schema": "fullmag.docker-startup-activation-receipt.v1", "state": "started",
                       "request_id": inputs["request_id"], "source_sha256": inputs["source_sha256"],
                       "provenance_sha256": inputs["provenance_sha256"], "authorization": authorization}
                or digest(files["startup-provenance.json"]) != inputs["provenance_sha256"]
                or document(files["startup-provenance.json"], "closed recovery provenance") != authorization):
            raise HistoryError("Closed recovery started marker or authorization binding differs")
        for key in ("request_id", "source_sha256", "source_relative", "source_root"):
            if authorization.get(key) != inputs[key]:
                raise HistoryError("Closed recovery authorization identity differs")
        bindings = {"schema": SCHEMA, "activation": attempt, "backend": inputs["backend_container"],
                    "receipt_sha256": digest(files["receipt.json"]), "marker_sha256": digest(marker_raw),
                    "config_sha256": inputs["config_sha256"], "source_root": identity["source_root"],
                    "request_id": inputs["request_id"], "source_sha256": inputs["source_sha256"], "response": response}
        plan = proof.get("plan")
        if (not isinstance(plan, dict) or set(plan) != set(bindings) | {
                "backend_started_at", "protected_runs_sha256", "run_count"}
                or not isinstance(plan.get("backend_started_at"), str)):
            raise HistoryError("Closed recovery backend incarnation is missing")
        from docker_dev_release_unknown_activation import docker_time
        docker_time(plan["backend_started_at"])
        retained_plan(proof, bindings, plan["backend_started_at"])
        retained_plan(intent, bindings, plan["backend_started_at"])
        if set(intent) != {"schema", "plan", "plan_sha256"} or intent["plan"] != plan or intent["plan_sha256"] != proof["plan_sha256"]:
            raise HistoryError("Closed recovery intent and proof differ")
        preserved = proof.get("preserved_store")
        if (not isinstance(preserved, dict) or preserved.get("root") != identity.get("store_root")
                or not isinstance(preserved.get("runs"), list) or type(plan.get("run_count")) is not int
                or plan["run_count"] != len(preserved["runs"])):
            raise HistoryError("Closed recovery historical store identity differs")
        finished = terminal.get("finished_at")
        if (isinstance(finished, bool) or not isinstance(finished, (int, float)) or not math.isfinite(finished)
                or finished < receipt["finished_at"]):
            raise HistoryError("Closed recovery completion timestamp is invalid")
        expected = {**receipt, "state": "failed-confirmed", "activation_state": "not-admitted",
                    "reconciliation": "pre-admission-output-terminal-history",
                    "release_proof_sha256": digest(canonical(proof)), "finished_at": finished}
        if terminal != expected:
            raise HistoryError("Closed recovery terminal is not the exact producer overlay")
    except (BuildControlError, KeyError, TypeError, ValueError) as error:
        raise HistoryError("Closed pre-admission recovery authentication failed: " + str(error)) from error
    if (not isinstance(store_records, dict) or not isinstance(inventory_paths, list)
            or any(not isinstance(path, str) for path in inventory_paths)
            or len(set(inventory_paths)) != len(inventory_paths)):
        raise HistoryError("Closed recovery requires complete fresh admission metadata")
    required = {path for path in inventory_paths if _closed_recovery_metadata_file(path)}
    if set(store_records) != required:
        raise HistoryError("Closed recovery admission metadata inventory is incomplete")
    owner = document(store_records.get("WRITER.owner.json", b"{}"), "fresh store writer")
    if owner.get("schema") != "fullmag.writer.v1" or owner.get("released") is not True:
        raise HistoryError("Closed recovery store writer is not released")
    needles = _closed_recovery_request_identities(attempt, inputs)
    own_retirement = _authenticate_own_predecessor_retirement(attempt, receipt, store_records, inventory_paths)
    def references(value):
        if isinstance(value, dict): return any(references(key) or references(item) for key, item in value.items())
        if isinstance(value, list): return any(references(item) for item in value)
        return isinstance(value, str) and any(needle in value for needle in needles)
    for path in inventory_paths:
        scanned = path
        if own_retirement is not None:
            prefix, _ = own_retirement
            if path == prefix or path.startswith(prefix + "/"):
                # Remove only the authenticated namespace component. Repeated
                # attempt IDs or real request identities below it remain live.
                scanned = path[len(prefix):]
        if references(scanned):
            raise HistoryError("Closed recovery request has fresh RunIntent/admission/lease evidence")
    for path, raw in store_records.items():
        value = document(raw, "fresh admission metadata") if path.endswith(".json") else raw.decode("utf-8", "strict")
        if own_retirement is not None and path == own_retirement[1]:
            value = dict(value)
            # Its exact operation_id was authenticated above. No other field,
            # nested payload or foreign retirement receives this exception.
            del value["operation_id"]
        if references(value):
            raise HistoryError("Closed recovery request has fresh RunIntent/admission/lease evidence")
    return terminal


def control_references(root, candidate, *, owner_marker_pin=None, qualified_rejection=None,
                       store_root=None, identity=None):
    """Conservatively preserve references from nonhistorical control documents.

    A succeeded terminal attempt is historical. A completed pre-admission
    recovery is historical only after exact producer and fresh store validation.
    Other failed, incomplete and unknown attempts remain roots. Backend
    script activation markers are historical only when confirmed activated.
    """
    root = _directory(root)
    rejected_terminal_raw = None
    rejection_files = None
    if qualified_rejection is not None:
        from docker_activation_history_storage import source_files
        rejection_candidate = qualified_rejection.get("candidate")
        rejection_files = qualified_rejection.get("files")
        if (not isinstance(rejection_candidate, dict)
                or rejection_candidate.get("qualification_kind") != "rejected-no-run-v1"
                or rejection_candidate.get("attempt") != candidate
                or rejection_candidate.get("run_id") is not None
                or rejection_candidate.get("session_id") is not None
                or not isinstance(rejection_files, dict)
                or rejection_candidate.get("files") != file_manifest(rejection_files)):
            raise HistoryError("Qualified rejection lacks its current no-run qualification")
        directory = root / "activation/attempts" / candidate
        if not directory.exists():
            directory = root / "activation/history-v1" / candidate
        if source_files(directory) != rejection_files:
            raise HistoryError("Qualified rejection bytes changed before reference inventory")
        rejected_receipt = document(rejection_files["receipt.json"], "qualified rejection")
        rejected_terminal_raw = rejection_files.get("terminal.json")
        if (rejected_receipt.get("attempt") != candidate
                or rejected_receipt.get("state") != "failed-confirmed"
                or rejected_receipt.get("activation_state") != "rejected"
                or rejected_receipt.get("run_id") is not None
                or not isinstance(rejected_terminal_raw, bytes)):
            raise HistoryError("Invalid qualified rejection reference identity")
        expected_rejected_marker = {
            "schema": "fullmag.docker-startup-activation-receipt.v1", "state": "rejected",
            "request_id": rejected_receipt["request_id"],
            "source_sha256": rejected_receipt["source_sha256"],
            "provenance_sha256": rejected_receipt["provenance_sha256"],
            "authorization": document(rejection_files["authorization.json"], "authorization"),
            "result": document(rejection_files["result.json"], "result")}
    references, pins = {}, {}
    known_runs = {}
    closed_activations = {}
    qualified_current_terminal = None
    closed_recovery_pins = {}
    fresh_recovery_store = None
    live = _entries(root / "activation/attempts")
    def closed_terminal(path):
        terminal, receipt = path / "terminal.json", path / "receipt.json"
        if terminal.exists() and receipt.exists():
            terminal_raw = _raw(terminal)
            value = document(terminal_raw, str(path) + "/terminal")
            if (value.get("state") == "failed-confirmed"
                    and value.get("reconciliation") == "pre-admission-output-terminal-history"
                    and path.parent == root / "activation/attempts"
                    and store_root is not None and identity is not None):
                nonlocal fresh_recovery_store
                from docker_activation_history_storage import source_files
                files = source_files(path)
                recovery_proof = document(files["terminal-history-output-proof.json"], "closed recovery proof")
                preserved = recovery_proof.get("preserved_store")
                if (not isinstance(preserved, dict) or not isinstance(preserved.get("root"), str)):
                    raise HistoryError("Closed recovery store identity is malformed")
                if preserved["root"] != identity.get("store_root"):
                    # The selected candidate's mount cannot authenticate another
                    # SessionStore. Keep this entire recovery as a live root;
                    # never mount or read a path supplied by historical proof.
                    return None
                receipt_value = document(files["receipt.json"], "closed recovery receipt")
                key = receipt_value.get("activation_receipt_key")
                if not isinstance(key, str) or re.fullmatch(r"[0-9a-f]{64}", key) is None:
                    raise HistoryError("Closed recovery marker key is invalid")
                marker_relative = "backend/script-activation-" + key + "/activation.json"
                marker_raw = _raw(root / marker_relative)
                if fresh_recovery_store is None:
                    fresh_recovery_store = _closed_recovery_store_evidence(store_root)
                validate_closed_pre_admission_recovery(path.name, files, marker_raw=marker_raw,
                    identity=identity, store_records=fresh_recovery_store[0], inventory_paths=fresh_recovery_store[1])
                for name, raw in files.items():
                    closed_recovery_pins[(path / name).relative_to(root).as_posix()] = digest(raw)
                closed_recovery_pins[marker_relative] = digest(marker_raw)
                return value
            if (value.get("schema") == "fullmag.docker-build-operation.v1"
                    and (value.get("state") == "succeeded" or (
                        qualified_rejection is not None and path.name == candidate
                        and terminal_raw == rejection_files["terminal.json"]
                        and value.get("state") == "failed-confirmed"
                        and value.get("activation_state") == "rejected"))
                    and value.get("attempt") == path.name
                    and _raw(receipt) == terminal_raw):
                return value
        return None
    for token in live + _entries(root / "activation/history-v1"):
        directory = root / "activation/attempts" / token
        if not directory.exists():
            directory = root / "activation/history-v1" / token
        receipt = directory / "receipt.json"
        if receipt.exists():
            value = document(_raw(receipt), "activation receipt")
            if isinstance(value.get("run_id"), str):
                known_runs[value["run_id"]] = token
        closed = closed_terminal(directory)
        if closed is not None:
            closed_activations[token] = closed
    total = 0
    visited = 0
    historical_marker_digests = {}
    def walk(path, *, top=False):
        nonlocal total, visited
        _directory(path)
        for entry in sorted(path.iterdir()):
            visited += 1
            if visited > MAX_INVENTORY_ENTRIES:
                raise HistoryError("Control reference inventory exceeds its bound")
            info = entry.lstat()
            relative = entry.relative_to(root).as_posix()
            if stat.S_ISDIR(info.st_mode):
                if top and entry.name not in KNOWN_ROOTS:
                    raise HistoryError("Unclassified control consumer root: " + entry.name)
                if top and entry.name in EXCLUDED_ROOTS:
                    continue
                if relative in {"activation/history-v1", "activation/history-staging-v1",
                                "activation/history-operations-v1"}:
                    continue
                if (entry.parent.name == "attempts"
                        and entry.parent.parent.name not in {
                            "stop-diagnostic", "stop-diagnostic-preview",
                        }):
                    if closed_terminal(entry) is not None:
                        # A current/verified pointer outside attempts still
                        # protects this record and its direct dependencies.
                        continue
                if entry.parent.name == "backend" and entry.name.startswith("script-activation-"):
                    marker = entry / "activation.json"
                    if marker.exists():
                        marker_raw = _raw(marker)
                        value = document(marker_raw, relative)
                        matches = [row for row in closed_activations.values()
                                   if row.get("activation_receipt_key") == entry.name.removeprefix("script-activation-")]
                        if (len(matches) == 1 and (
                                (value.get("state") == "activated" and matches[0].get("state") == "succeeded") or (
                                qualified_rejection is not None and matches[0]["attempt"] == candidate
                                and value == expected_rejected_marker))
                                and all(value.get(key) == matches[0].get(key) for key in ("request_id", "source_sha256", "provenance_sha256"))):
                            historical_marker_digests[
                                marker.relative_to(root).as_posix()
                            ] = digest(marker_raw)
                if entry.parent.name == "backend" and entry.name.startswith("workspace-retirement-"):
                    marker = entry / "retirement.json"
                    closed = closed_activations.get(entry.name.removeprefix("workspace-retirement-"))
                    if marker.exists() and closed is not None:
                        marker_raw = _raw(marker)
                        value = document(marker_raw, relative)
                        if (value.get("schema") == "fullmag.docker-workspace-retirement-receipt.v1"
                                and value.get("state") in {"retired", "replayed"}
                                and value.get("operation_id") == closed["attempt"]
                                and value.get("response") == closed.get("retirement")
                                and value.get("operation_inputs_sha256") == closed.get("retirement_inputs_sha256")):
                            historical_marker_digests[
                                marker.relative_to(root).as_posix()
                            ] = digest(marker_raw)
                walk(entry)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                if relative in historical_marker_digests:
                    if digest(_raw(entry)) != historical_marker_digests[relative]:
                        raise HistoryError("Historical backend marker changed during reference inventory")
                    continue
                if relative == ".fullmag-toolchain-control-owner.json":
                    # This fixed-schema volume marker may be root:root 0640.
                    # The host validates its exact ownership-only content via
                    # the retained backend; the unprivileged helper checks the
                    # pinned inode/stat identity without changing permissions.
                    observed = {"inode": info.st_ino, "size": info.st_size,
                                "mtime_ns": info.st_mtime_ns, "uid": info.st_uid,
                                "gid": info.st_gid, "mode": stat.S_IMODE(info.st_mode)}
                    if (not isinstance(owner_marker_pin, dict)
                            or owner_marker_pin.get("stat") != observed):
                        raise HistoryError("Control owner marker has no current authenticated pin")
                    pins[relative] = digest(canonical(owner_marker_pin))
                    continue
                if entry.name.endswith(".json"):
                    raw = _raw(entry)
                    total += len(raw)
                    if total > MAX_PIN_BYTES:
                        raise HistoryError("Control reference documents exceed byte budget")
                    # Every retained live JSON document must be readable. Do
                    # not silently omit a new pin vocabulary or malformed JSON.
                    document(raw, relative)
                    if (relative == "activation/current.json"
                            and rejected_terminal_raw is not None
                            and raw == rejected_terminal_raw):
                        # This one no-run terminal pointer is historical only
                        # under exact qualification. Keep its raw pin/CAS and
                        # leave every other root in the live reference graph.
                        qualified_current_terminal = {
                            "path": relative,
                            "qualification_kind": "rejected-no-run-v1",
                            "attempt": candidate,
                            "terminal_sha256": digest(rejected_terminal_raw),
                            "current_sha256": digest(raw),
                        }
                    else:
                        references[relative] = raw
                    pins[relative] = _reference_digest(root, relative, raw)
            else:
                raise HistoryError("Linked or special control reference entry")
    walk(root, top=True)
    pins.update(closed_recovery_pins)
    protected = referenced_attempts(references, known_runs)
    # Follow explicit attempt/path pins to a fixed point. A past retirement's
    # run_id is historical evidence, not a requirement to keep every predecessor
    # in the live pool; the current roots above retain their direct predecessor.
    visited_attempts = set()
    while protected - visited_attempts:
        token = sorted(protected - visited_attempts)[0]
        visited_attempts.add(token)
        if token not in live:
            continue
        for path in sorted((root / "activation/attempts" / token).glob("*.json")):
            raw = _raw(path)
            relative = path.relative_to(root).as_posix()
            pins[relative] = digest(raw)
            protected |= referenced_attempts({relative: raw}, {})
    if candidate in protected:
        direct = [name for name, raw in references.items()
                  if candidate in referenced_attempts({name: raw}, known_runs)]
        raise HistoryError("Activation is referenced by live control/recovery roots: "
                           + ", ".join(direct[:12] or ["transitive attempt pin"]))
    return {"protected": sorted(protected), "pins": pins,
            "qualified_current_terminal": qualified_current_terminal,
            "live_attempts": live, "sha256": digest(canonical(pins))}


def validate_existing_archives(root):
    tokens = _entries(root / "activation/history-v1")
    pins = {}
    for token in tokens:
        script = activation_history_read_script("/control/activation/attempts/" + token + "/receipt.json")
        result = subprocess.run(["/bin/bash", "-euo", "pipefail", "-c", script.replace("/control", str(root))],
                                capture_output=True, timeout=30)
        if result.returncode:
            raise HistoryError("Existing history archive failed integrity validation: " + token)
        pins[token] = digest(_raw(root / "activation/history-v1" / token / ".history.sha256"))
    return pins
