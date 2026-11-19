"""Pure qualification of an activation's immutable history evidence.

No filesystem or Docker mutation lives here. Admission success is deliberately
separate from the terminal run evidence supplied by the managed inventory.
"""
from __future__ import annotations

import hashlib
import json
import re


SCHEMA = "fullmag.activation-history.v1"
MAX_HISTORY_ATTEMPTS = 4096
MAX_HISTORY_BYTES = 256 * 1024 * 1024
MAX_FILES = 32
MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
MAX_LOG_BYTES = 32 * 1024 * 1024
MAX_ATTEMPT_BYTES = 64 * 1024 * 1024
ATTEMPT = re.compile(r"[0-9a-f]{32}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")
REQUIRED = frozenset({"receipt.json", "terminal.json", "result.json",
                      "authorization.json", "startup-provenance.json", "build.log"})


class HistoryError(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def document(raw, label):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError("non-finite constant: " + value)

    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_DOCUMENT_BYTES:
        raise HistoryError(label + " has no bounded bytes")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique,
                           parse_constant=invalid_constant)
    except (UnicodeError, ValueError, RecursionError) as error:
        raise HistoryError(label + " is not strict JSON") from error
    if not isinstance(value, dict):
        raise HistoryError(label + " must be an object")
    return value


def file_manifest(files):
    if not isinstance(files, dict) or not REQUIRED.issubset(files):
        raise HistoryError("Activation evidence is incomplete")
    # Two slots are reserved for the immutable history metadata and index.
    if len(files) + 2 > MAX_FILES:
        raise HistoryError("Activation file count exceeds history budget")
    manifest = {}
    for name, raw in sorted(files.items()):
        if (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", name)
                or name in {".", ".."} or name.startswith(".history")):
            raise HistoryError("Unsafe or reserved activation filename")
        maximum = MAX_LOG_BYTES if name == "build.log" else MAX_DOCUMENT_BYTES
        if not isinstance(raw, bytes) or len(raw) > maximum:
            raise HistoryError("Activation file exceeds its byte budget")
        manifest[name] = {"size_bytes": len(raw), "sha256": digest(raw)}
    if sum(row["size_bytes"] for row in manifest.values()) > MAX_ATTEMPT_BYTES - MAX_DOCUMENT_BYTES - 16384:
        raise HistoryError("Activation exceeds total byte budget")
    return manifest


def _qualify_identity(attempt, files, *, project, volume, namespace, state, activation_state):
    if not isinstance(attempt, str) or ATTEMPT.fullmatch(attempt) is None:
        raise HistoryError("Invalid activation identity")
    manifest = file_manifest(files)
    receipt = document(files["receipt.json"], "receipt")
    terminal = document(files["terminal.json"], "terminal")
    if files["receipt.json"] != files["terminal.json"]:
        raise HistoryError("Receipt and terminal bytes differ")
    expected = {"schema": "fullmag.docker-build-operation.v1", "phase": "activation",
                "state": state, "activation_state": activation_state, "attempt": attempt,
                "compose_project": project, "control_volume": volume}
    if any(receipt.get(key) != value for key, value in expected.items()):
        raise HistoryError("Activation is not a succeeded terminal of this group")
    if receipt.get("control_namespace", "") != namespace:
        raise HistoryError("Activation control namespace differs")
    if receipt.get("reconciliation"):
        raise HistoryError("Recovered or uncertain activation requires separate qualification")
    for key in ("started_at", "finished_at"):
        if type(receipt.get(key)) not in {int, float} or receipt[key] <= 0:
            raise HistoryError("Activation timestamps are malformed")
    if receipt["finished_at"] < receipt["started_at"]:
        raise HistoryError("Activation terminal predates admission")
    inputs = receipt.get("inputs")
    if not isinstance(inputs, dict):
        raise HistoryError("Activation input identity is missing")
    for key in ("request_id", "source_sha256", "source_root", "source_relative"):
        if not isinstance(receipt.get(key), str) or not receipt[key] or receipt[key] != inputs.get(key):
            raise HistoryError("Activation input differs: " + key)
    if SHA.fullmatch(receipt["source_sha256"]) is None:
        raise HistoryError("Activation source digest is malformed")
    provenance = document(files["startup-provenance.json"], "provenance")
    authorization = document(files["authorization.json"], "authorization")
    if (provenance != authorization
            or provenance.get("schema") != "fullmag.docker-startup-script.v1"
            or provenance.get("authorization") != "explicit_startup_script"):
        raise HistoryError("Startup authorization and provenance differ")
    for key in ("request_id", "source_sha256", "source_root", "source_relative"):
        if provenance.get(key) != receipt[key]:
            raise HistoryError("Startup provenance differs: " + key)
    provenance_sha = digest(files["startup-provenance.json"])
    if (receipt.get("provenance_sha256") != provenance_sha
            or inputs.get("provenance_sha256") != provenance_sha
            or receipt.get("provenance_path") != (
                "/opt/fullmag/control/activation/attempts/" + attempt + "/startup-provenance.json")):
        raise HistoryError("Startup provenance byte/path pin differs")
    return receipt, terminal, inputs, provenance, authorization, manifest


def qualify_activation(attempt, files, *, project, volume, namespace,
                       run_catalog_raw, run_intent_raw, lease_records):
    """Validate bytes; the caller must prove inventory completeness and quiescence.

    lease_records is the complete relative-path -> bytes inventory for BOTH
    resource lease families of this run, collected without following links.
    Returned evidence is not itself an apply authorization.
    """
    receipt, terminal, inputs, provenance, authorization, manifest = _qualify_identity(
        attempt, files, project=project, volume=volume, namespace=namespace,
        state="succeeded", activation_state="activated")
    if receipt.get("error"):
        raise HistoryError("Recovered or uncertain activation requires separate qualification")
    result = document(files["result.json"], "result")
    response = result.get("response")
    if (result.get("schema") != "fullmag.startup-script-activation.v1"
            or result.get("state") != "activated" or not isinstance(response, dict)
            or response.get("schema") != "fullmag.startup-script-activation.v1"
            or response.get("status") != "accepted"):
        raise HistoryError("Activation result is not confirmed accepted")
    for key in ("request_id", "source_sha256"):
        if result.get(key) != receipt[key] or response.get(key) != receipt[key]:
            raise HistoryError("Activation result differs: " + key)
    for key in ("session_id", "run_id"):
        if (not isinstance(receipt.get(key), str) or not receipt[key]
                or response.get(key) != receipt[key]):
            raise HistoryError("Activated run identity differs: " + key)

    # Reuse the SessionStore validators rather than a second terminal vocabulary.
    from docker_volume_offline_reconcile import _validate_catalogs, _validate_store_leases
    catalog = document(run_catalog_raw, "run catalog")
    run_id = receipt["run_id"]
    try:
        _validate_catalogs([{"path": "runs/" + run_id + "/run_catalog.json", "document": catalog}])
        if not isinstance(lease_records, dict):
            raise HistoryError("Run lease inventory is missing")
        for path, raw in lease_records.items():
            if (not isinstance(path, str) or not path.startswith("runs/" + run_id + "/")
                    or not re.fullmatch(r"runs/[^/]+/(resource_leases|preparation_resource_leases)/[^/]+/[^/]+\.json", path)):
                raise HistoryError("Run lease path differs")
            _validate_store_leases(path, document(raw, "run lease"))
    except RuntimeError as error:
        raise HistoryError("Run is not terminal with released leases: " + str(error)) from error
    intent = document(run_intent_raw, "run intent")
    if (intent.get("schema_version") != "run_intent.v1" or intent.get("run_id") != run_id
            or intent.get("idempotency_key") != "live-http-" + digest(receipt["request_id"].encode())):
        raise HistoryError("RunIntent does not bind the activated request")
    specification = intent.get("specification")
    parameters = specification.get("parameters") if isinstance(specification, dict) else None
    if not isinstance(parameters, dict):
        raise HistoryError("RunIntent session binding differs")

    session_identity = receipt["request_id"] + "\0" + receipt["source_sha256"]
    profile_records = (authorization, provenance, parameters)
    profile_pins = (receipt, inputs, response)
    if (any("solver_profile" in record for record in profile_records)
            or any("solver_profile_sha256" in record for record in profile_pins)):
        from docker_startup_script import StartupScriptError, solver_profile_sha256
        try:
            profile_sha, provenance_sha, intent_sha = (
                solver_profile_sha256(record.get("solver_profile")) for record in profile_records
            )
        except StartupScriptError as error:
            raise HistoryError("Activation solver profile is missing or invalid") from error
        if (profile_sha != provenance_sha or profile_sha != intent_sha
                or any(record.get("solver_profile_sha256") != profile_sha for record in profile_pins)):
            raise HistoryError("Activation solver profile digest differs")
        session_identity += "\0" + profile_sha

    trace_records = (authorization, provenance, parameters)
    trace_pins = (receipt, inputs, response)
    if (any("cuda_trace" in record for record in trace_records)
            or any("cuda_trace_sha256" in record for record in trace_pins)):
        from docker_startup_script import StartupScriptError, cuda_trace_sha256
        try:
            trace_sha, provenance_trace_sha, intent_trace_sha = (
                cuda_trace_sha256(record.get("cuda_trace")) for record in trace_records
            )
        except StartupScriptError as error:
            raise HistoryError("Activation cuda trace wrapper is missing or invalid") from error
        if (trace_sha != provenance_trace_sha or trace_sha != intent_trace_sha
                or any(record.get("cuda_trace_sha256") != trace_sha for record in trace_pins)):
            raise HistoryError("Activation cuda trace digest differs")
        session_identity += "\0cuda_trace\0" + trace_sha

    expected_session = "docker-startup-" + digest(session_identity.encode())
    if receipt["session_id"] != expected_session:
        raise HistoryError("RunIntent does not bind the activated request")
    workspace = parameters.get("live_workspace")
    if not isinstance(workspace, dict) or workspace.get("session_id") != expected_session:
        raise HistoryError("RunIntent session binding differs")
    return {"attempt": attempt, "run_id": run_id, "session_id": receipt["session_id"],
            "request_id": receipt["request_id"], "source_sha256": receipt["source_sha256"],
            "finished_at": terminal["finished_at"], "files": manifest,
            "run_catalog_sha256": digest(run_catalog_raw), "run_intent_sha256": digest(run_intent_raw),
            "leases": {path: digest(raw) for path, raw in sorted(lease_records.items())}}


def qualify_rejected_activation(attempt, files, *, project, volume, namespace,
                                store_records, inventory_paths):
    """Require a confirmed pre-admission rejection, never infer it from no run_id.

    The managed caller supplies the complete, locked store path inventory and
    all RunIntent/admission/lease/control metadata, not a selected set of runs.
    """
    receipt, terminal, inputs, provenance, authorization, manifest = _qualify_identity(
        attempt, files, project=project, volume=volume, namespace=namespace,
        state="failed-confirmed", activation_state="rejected")
    if "reconciliation" in receipt:
        raise HistoryError("Recovered rejection requires separate qualification")
    if receipt.get("error") != "Backend activation was rejected; terminal activation receipt retained and retry is forbidden":
        raise HistoryError("Activation has no confirmed API rejection")
    result = document(files["result.json"], "rejected result")
    rejection = result.get("rejection")
    if (result.get("schema") != "fullmag.startup-script-activation.v1"
            or result.get("state") != "rejected" or not isinstance(rejection, dict)
            or type(rejection.get("http_status")) is not int
            or rejection["http_status"] not in {400, 422}
            or not isinstance(rejection.get("code"), str) or not rejection["code"]
            or not isinstance(rejection.get("message"), str) or not rejection["message"]):
        raise HistoryError("Result is not a confirmed pre-admission API rejection")
    for key in ("request_id", "source_sha256", "source_relative"):
        if result.get(key) != receipt[key]:
            raise HistoryError("Rejected result identity differs: " + key)
    if any(record.get(key) is not None for record in (receipt, result, rejection)
           for key in ("run_id", "session_id", "response")):
        raise HistoryError("Rejected activation has an accepted identity or response")
    if not isinstance(store_records, dict) or not isinstance(inventory_paths, list):
        raise HistoryError("Complete rejected activation store evidence is missing")
    from docker_volume_offline_reconcile import _metadata_file
    required = {path for path in inventory_paths if path.endswith(".json") and (
        _metadata_file(path) or any(word in path.casefold() for word in ("admission", "idempotency", "intake", "intent")))}
    if set(store_records) != required:
        raise HistoryError("Rejected activation metadata inventory is incomplete")
    request_hash = digest(receipt["request_id"].encode())
    needles = {attempt, receipt["request_id"], request_hash,
               "live-http-" + request_hash, receipt["source_sha256"]}
    def referenced(value):
        if isinstance(value, dict):
            return any(referenced(key) or referenced(item) for key, item in value.items())
        if isinstance(value, list):
            return any(referenced(item) for item in value)
        return isinstance(value, str) and any(needle in value for needle in needles)
    retirement_result = receipt.get("retirement_result")
    if (receipt.get("retirement") is not None or not isinstance(retirement_result, dict)
            or retirement_result != {"state": "retirement-only", "retirement": None}):
        raise HistoryError("Rejected history v1 requires no predecessor workspace retirement")
    if referenced(inventory_paths):
        raise HistoryError("Rejected activation has a related SessionStore path")
    for path, raw in store_records.items():
        if path not in inventory_paths or referenced(document(raw, "store admission metadata")):
            raise HistoryError("Rejected activation has related RunIntent/admission/lease evidence")
    return {"attempt": attempt, "qualification_kind": "rejected-no-run-v1",
            "run_id": None, "session_id": None, "request_id": receipt["request_id"],
            "source_sha256": receipt["source_sha256"], "finished_at": terminal["finished_at"],
            "files": manifest, "rejection": rejection,
            "store_record_hashes": {path: digest(raw) for path, raw in sorted(store_records.items())}}


def referenced_attempts(records, known_runs):
    """Resolve references from a caller-selected COMPLETE set of live roots.

    Do not pass every historical receipt as a live root: historical edges are
    preserved by archival reads and are not active recovery dependencies.
    """
    result = set()
    def visit(value):
        if isinstance(value, dict):
            for key, item in value.items():
                visit(key)
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)
        elif isinstance(value, str):
            if ATTEMPT.fullmatch(value):
                result.add(value)
            result.update(re.findall(r"activation/(?:attempts|history-v1)/([0-9a-f]{32})(?:/|$)", value))
            if value in known_runs:
                result.add(known_runs[value])
    for label, raw in records.items():
        visit(document(raw, label))
    return result


def select_candidates(qualified, protected, *, history_count, history_bytes, limit=16):
    """Choose a bounded oldest-first batch without deleting anything at capacity."""
    if (type(history_count) is not int or history_count < 0
            or type(history_bytes) is not int or history_bytes < 0
            or type(limit) is not int or not 1 <= limit <= 16):
        raise HistoryError("Invalid history inventory or batch limit")
    selected = []
    seen = set()
    for candidate in sorted(qualified, key=lambda value: (value["finished_at"], value["attempt"])):
        token = candidate["attempt"]
        if token in seen:
            raise HistoryError("Duplicate qualified activation")
        seen.add(token)
        if token not in protected and len(selected) < limit:
            selected.append(candidate)
    # Reserve a full metadata budget per entry before any publication.
    bytes_after = history_bytes + sum(
        sum(row["size_bytes"] for row in value["files"].values()) + MAX_DOCUMENT_BYTES + 16384
        for value in selected)
    if history_count + len(selected) > MAX_HISTORY_ATTEMPTS or bytes_after > MAX_HISTORY_BYTES:
        raise HistoryError("Bounded history capacity exhausted; records retained")
    return selected
