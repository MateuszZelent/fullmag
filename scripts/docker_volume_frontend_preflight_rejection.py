"""Authenticate the one known pre-service frontend refresh rejection."""
from __future__ import annotations

import hashlib
import json
from pathlib import PurePosixPath
import re
from typing import Mapping

from docker_build_control import BuildControlError, MAX_DOCUMENT_BYTES, canonical

SCHEMA = "fullmag.docker-frontend-preflight-rejection.v1"
ERROR_LINE = "RuntimeError: Frontend refresh requires an empty healthy API"
MAX_PROOF_BYTES = 64 * 1024
TOKEN = re.compile(r"[0-9a-f]{32}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
PROOF_PATH = re.compile(
    r"verification/frontend-preflight-rejection/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.json\Z"
)
PROOF_KEYS = frozenset((
    "schema", "failed_attempt", "failed_current_sha256", "failed_receipt_sha256",
    "failed_terminal_sha256", "parent_attempt", "parent_config_sha256",
    "verified_parent_sha256", "compose_project", "control_volume", "source_identity",
    "failure_line",
))
PRE_SERVICE_MARKERS = (
    "rollback-compose.json",
    "rollback-development-inputs.json",
    "backend-cache.json",
    "group-ledger.json",
    "host-ledger.json",
    "ledger-maintenance-compose.json",
    "compose.json",
    "backend-build-receipt.json",
    "provenance.json",
    "frontend-source-view.json",
)


def _require(value: object, message: str) -> None:
    if not value:
        raise BuildControlError(message)


def _valid_sha(value: object, label: str) -> str:
    _require(isinstance(value, str) and SHA256.fullmatch(value) is not None,
             label + " must be a lowercase SHA-256")
    return value


def _valid_token(value: object, label: str) -> str:
    _require(isinstance(value, str) and TOKEN.fullmatch(value) is not None,
             label + " must be an exact attempt token")
    return value


def _read_document(control, relative: str, *, optional: bool = False):
    raw = control.read_bytes(relative, optional=optional, maximum=MAX_DOCUMENT_BYTES)
    if raw is None:
        return None, None
    try:
        value = json.loads(raw.decode("utf-8", "strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Frontend preflight evidence is not valid UTF-8 JSON: " + relative) from error
    _require(isinstance(value, dict), "Frontend preflight evidence must be a JSON object: " + relative)
    return raw, value


def _proof_options(args, mode: str):
    if mode not in {"restart-idle", "refresh-frontend"}:
        raise BuildControlError("Frontend preflight proof is unsupported for this recovery mode")
    path = getattr(args, "frontend_preflight_rejection", None)
    sha256 = getattr(args, "frontend_preflight_rejection_sha256", None)
    if path is None and sha256 is None:
        return None
    _require(isinstance(path, str) and isinstance(sha256, str),
             "Frontend preflight recovery requires both proof path and raw SHA-256")
    _require(PROOF_PATH.fullmatch(path) is not None
             and str(PurePosixPath(path)) == path
             and ".." not in PurePosixPath(path).parts,
             "Frontend preflight proof path is not an approved control-volume path")
    _valid_sha(sha256, "Frontend preflight proof pin")
    if mode == "restart-idle":
        _require(not getattr(args, "stop_only", False)
                 and not getattr(args, "allow_prepared_session", False)
                 and not getattr(args, "saved_authoring_checkpoint", None)
                 and not getattr(args, "saved_authoring_checkpoint_sha256", None),
                 "Frontend preflight proof cannot be combined with stop-only, prepared-session, or saved-authoring recovery")
    else:
        _require(not getattr(args, "frontend_frozen_resume", None)
                 and not getattr(args, "frontend_frozen_resume_sha256", None),
                 "Frontend preflight proof cannot be combined with frozen-frontend recovery")
    return {"path": path, "sha256": sha256}


def _expected_source_identity(control, selected) -> dict[str, str]:
    identity = getattr(control, "identity", None)
    _require(isinstance(identity, Mapping), "Frontend preflight proof has no pinned source identity")
    source_root = str(selected)
    expected = {
        "source_root": source_root,
        "source_project_id": identity.get("project_id"),
        "source_worktree_id": identity.get("worktree_id"),
        "source_checkout_kind": identity.get("checkout_kind"),
    }
    _require(all(isinstance(value, str) and value for value in expected.values()),
             "Frontend preflight source identity is incomplete")
    return expected


def _validate_lease(control, operation, mode: str) -> None:
    if operation is None:
        _require(getattr(control, "_active_operation", None) is None,
                 "Another control operation is active; frontend recovery refused")
        active = control.read_bytes("active", optional=True, maximum=128)
        _require(active is None, "Another control operation holds the active lease")
        return

    expected_phase = "iteration" if mode == "restart-idle" else "development"
    _require(getattr(control, "_active_operation", None) is operation
             and operation.get("lease_ready") is True,
             "Frontend preflight proof is not being checked under its active control lease")
    receipt = operation.get("receipt")
    _require(isinstance(receipt, dict) and receipt.get("phase") == expected_phase,
             "Frontend preflight proof is under an incompatible control operation")
    token = _valid_token(receipt.get("attempt"), "Active control lease attempt")
    expected_helper = operation.get("helper_container_id")
    _require(isinstance(expected_helper, str) and re.fullmatch(r"[0-9a-f]{64}", expected_helper),
             "Active control lease helper is not pinned")
    observed_helper = control._pin_operation_helper(operation)
    _require(observed_helper == expected_helper,
             "Active control lease helper identity changed")
    active = control.read_bytes("active", optional=True, maximum=128)
    _require(active == (token + "\n").encode("ascii"),
             "Active control lease marker does not identify this operation")


def _validate_no_displaced_current(control, args, mode: str) -> None:
    # These recovery paths already carry their own independent proof and are
    # intentionally allowed to target a verified parent while current points
    # at a different terminal child.
    if mode == "refresh-frontend" and (
        getattr(args, "frontend_frozen_resume", None)
        or getattr(args, "frontend_frozen_resume_sha256", None)
    ):
        return
    if mode == "restart-idle" and (
        getattr(args, "stop_only", False)
        or getattr(args, "allow_prepared_session", False)
        or getattr(args, "saved_authoring_checkpoint", None)
        or getattr(args, "saved_authoring_checkpoint_sha256", None)
    ):
        return
    raw, current = _read_document(control, "development/current.json", optional=True)
    if raw is None:
        return
    if (current.get("attempt") == getattr(args, "attempt", None)
            and current.get("config_sha256") == getattr(args, "config_sha256", None)):
        return
    raise BuildControlError(
        "Development current points to another attempt; an exact frontend recovery proof is required"
    )


def _validate_proof(control, args, selected, options: dict[str, str]) -> dict[str, object]:
    proof_raw = control.read_bytes(options["path"], maximum=MAX_PROOF_BYTES)
    proof_sha = hashlib.sha256(proof_raw).hexdigest()
    _require(proof_sha == options["sha256"], "Frontend preflight proof raw-byte SHA-256 differs")
    try:
        proof = json.loads(proof_raw.decode("utf-8", "strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Frontend preflight proof is not valid UTF-8 JSON") from error
    _require(isinstance(proof, dict) and set(proof) == PROOF_KEYS,
             "Frontend preflight proof keys differ")
    _require(canonical(proof) + b"\n" == proof_raw,
             "Frontend preflight proof is not canonically serialized")
    _require(proof.get("schema") == SCHEMA, "Frontend preflight proof schema differs")

    child_attempt = _valid_token(proof.get("failed_attempt"), "Failed frontend attempt")
    parent_attempt = _valid_token(proof.get("parent_attempt"), "Verified parent attempt")
    _require(child_attempt != parent_attempt,
             "Failed frontend attempt must differ from its verified parent")
    parent_config = _valid_sha(proof.get("parent_config_sha256"), "Verified parent Compose config")
    current_pin = _valid_sha(proof.get("failed_current_sha256"), "Failed current receipt")
    receipt_pin = _valid_sha(proof.get("failed_receipt_sha256"), "Failed operation receipt")
    terminal_pin = _valid_sha(proof.get("failed_terminal_sha256"), "Failed terminal receipt")
    verified_pin = _valid_sha(proof.get("verified_parent_sha256"), "Verified parent terminal")
    _require(parent_attempt == getattr(args, "attempt", None)
             and parent_config == getattr(args, "config_sha256", None),
             "Frontend preflight proof does not select the requested parent attempt/config")
    _require(proof.get("compose_project") == control.project
             and proof.get("control_volume") == control.volume,
             "Frontend preflight proof project or control-volume identity differs")
    expected_source = _expected_source_identity(control, selected)
    _require(proof.get("source_identity") == expected_source,
             "Frontend preflight proof source identity differs")
    _require(proof.get("failure_line") == ERROR_LINE,
             "Frontend preflight proof does not identify the known healthy-idle rejection")

    child_root = "development/attempts/" + child_attempt
    current_raw, current = _read_document(control, "development/current.json")
    receipt_raw, receipt = _read_document(control, child_root + "/receipt.json")
    terminal_raw, terminal = _read_document(control, child_root + "/terminal.json")
    _require(current_raw == receipt_raw == terminal_raw,
             "Failed frontend current, receipt, and terminal bytes are not identical")
    _require(hashlib.sha256(current_raw).hexdigest() == current_pin
             and hashlib.sha256(receipt_raw).hexdigest() == receipt_pin
             and hashlib.sha256(terminal_raw).hexdigest() == terminal_pin,
             "Failed frontend current/receipt/terminal raw-byte pins differ")
    _require(current.get("attempt") == child_attempt
             and receipt.get("attempt") == child_attempt
             and terminal.get("attempt") == child_attempt,
             "Failed frontend receipt attempt identity differs")
    for document in (current, receipt, terminal):
        _require(document.get("schema") == "fullmag.docker-build-operation.v1"
                 and document.get("phase") == "development"
                 and document.get("state") == "failed-confirmed"
                 and document.get("compose_project") == control.project
                 and document.get("control_volume") == control.volume,
                 "Failed frontend operation is not the exact terminal development attempt")
    error = terminal.get("error")
    _require(isinstance(error, str) and error.splitlines()
             and error.splitlines()[-1] == ERROR_LINE,
             "Failed frontend attempt does not end at the known healthy-idle rejection")
    child_inputs = terminal.get("inputs")
    _require(isinstance(child_inputs, Mapping)
             and child_inputs.get("frontend_refresh_from_attempt") == parent_attempt
             and child_inputs.get("frontend_refresh_from_config_sha256") == parent_config,
             "Failed frontend attempt is not linked to the selected parent")
    _require(all(child_inputs.get(key) == value for key, value in expected_source.items()),
             "Failed frontend attempt source identity differs")

    parent_root = "development/attempts/" + parent_attempt
    verified_raw, verified = _read_document(control, "development/verified.json")
    parent_raw, parent = _read_document(control, parent_root + "/terminal.json")
    _require(verified_raw == parent_raw
             and hashlib.sha256(verified_raw).hexdigest() == verified_pin,
             "Verified development pointer is not the pinned parent terminal")
    _require(verified.get("attempt") == parent_attempt
             and parent.get("attempt") == parent_attempt
             and verified.get("schema") == "fullmag.docker-build-operation.v1"
             and parent.get("schema") == "fullmag.docker-build-operation.v1"
             and verified.get("phase") == "development"
             and parent.get("phase") == "development"
             and verified.get("state") == "succeeded"
             and parent.get("state") == "succeeded"
             and verified.get("compose_project") == control.project
             and parent.get("compose_project") == control.project
             and verified.get("control_volume") == control.volume
             and parent.get("control_volume") == control.volume
             and parent.get("config_sha256") == parent_config,
             "Verified development parent identity/state/config differs")
    parent_inputs = parent.get("inputs")
    _require(isinstance(parent_inputs, Mapping)
             and all(parent_inputs.get(key) == value for key, value in expected_source.items()),
             "Verified development parent source identity differs")
    parent_compose = control.read(parent_root + "/compose.json")
    _require(isinstance(parent_compose, dict) and parent_compose.get("name") == control.project
             and hashlib.sha256(canonical(parent_compose)).hexdigest() == parent_config,
             "Verified development parent Compose config differs")

    for marker in PRE_SERVICE_MARKERS:
        marker_raw = control.read_bytes(child_root + "/" + marker, optional=True, maximum=MAX_DOCUMENT_BYTES)
        _require(marker_raw is None,
                 "Failed frontend attempt has post-preflight mutation evidence: " + marker)

    return {
        "schema": SCHEMA,
        "path": options["path"],
        "sha256": proof_sha,
        "failed_attempt": child_attempt,
        "failed_current_sha256": current_pin,
        "failed_receipt_sha256": receipt_pin,
        "failed_terminal_sha256": terminal_pin,
        "parent_attempt": parent_attempt,
        "parent_config_sha256": parent_config,
        "verified_parent_sha256": verified_pin,
    }


def validate(control, args, selected, *, mode: str, operation=None):
    """Validate the optional exact proof, or reject a displaced current pointer."""
    options = _proof_options(args, mode)
    if options is None:
        # Current authority is checked on both sides of lease admission.
        # BuildControl.read_bytes uses its already-pinned helper under an
        # active operation; ordinary paths need no second Docker helper probe.
        if operation is not None:
            _require(getattr(control, "_active_operation", None) is operation
                     and operation.get("lease_ready") is True,
                     "Development current was not rechecked under its active control lease")
        _validate_no_displaced_current(control, args, mode)
        return None
    _validate_lease(control, operation, mode)
    return _validate_proof(control, args, selected, options)
