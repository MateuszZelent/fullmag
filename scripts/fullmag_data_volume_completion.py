"""Read-only final commit fence for a registration with a retained pending marker.

The publisher validates runtime/science evidence before creating this last
witness. This reader checks its fixed-path digests and scope, without granting
qualification, registration, startup-scope or retirement capabilities.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import os
from pathlib import Path
import re


SCHEMA = "fullmag.data-volume-registration-commit.v1"
WITNESS_KEYS = {
    "schema", "volume_id", "project_id", "worktree_id", "compose_project", "plan_sha256",
    "copy_receipt_sha256", "registration_sha256", "migration_receipt_sha256",
    "journal_relative", "journal_prefix",
}
REGISTERED_KEYS = {
    "schema", "state", "volume_id", "registration_sha256", "migration_receipt_sha256",
    "index_path", "index_sha256_at_publication",
}
QUALIFIED_KEYS = {
    "schema", "state", "project_id", "worktree_id", "compose_project", "volume_id", "plan_sha256",
    "copy_receipt_sha256", "restart_receipt_sha256", "runtime_qualification_sha256",
    "zarr_qualification_sha256", "namespace_admitted", "data_migrated", "originals_retired",
}
MAX_PROOF_BYTES = 4 * 1024**2
_SHA = re.compile(r"[0-9a-f]{64}\Z")
_TOKEN = re.compile(r"[0-9a-f]{32}\Z")
_IDENTIFIER = re.compile(r"[a-z0-9._-]{1,128}\Z")


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _sha(value):
    _require(type(value) is str and _SHA.fullmatch(value), "Exact completion evidence SHA required")
    return value


def verify_committed_registration(layout, compose_project, pending, registration, registration_sha256):
    """Require the publisher's final witness, preserving later legal retirement events."""
    # Lazy imports avoid guard -> completion -> guard initialization cycles.
    try:
        from .fullmag_data_volume_guard import _absolute_path, _read_optional_regular, _parse_object
        from .fullmag_data_volume_pending import validate_pending, require_registration
        from .fullmag_data_volume import validate_registration
        from .fullmag_data_volume_journal import validate_journal, next_phase
    except ImportError:
        from fullmag_data_volume_guard import _absolute_path, _read_optional_regular, _parse_object
        from fullmag_data_volume_pending import validate_pending, require_registration
        from fullmag_data_volume import validate_registration
        from fullmag_data_volume_journal import validate_journal, next_phase
    from linux_data_volume_provision import _selected_journal

    _require(type(layout) is dict and type(layout.get("env")) is dict,
             "Exact selected completion layout required")
    pending = validate_pending(pending, layout, compose_project)
    registration = validate_registration(registration)
    require_registration(pending, registration)
    _sha(registration_sha256)
    for key, expected in (("project_id", layout["env"].get("FULLMAG_PROJECT_ID")),
                          ("worktree_id", layout.get("worktree_id")), ("compose_project", compose_project)):
        _require(registration[key] == expected == pending[key], "Completion identity differs: " + key)
    worktree_id = registration["worktree_id"]
    volume_id = registration["volume_id"]
    _require(type(worktree_id) is str and _IDENTIFIER.fullmatch(worktree_id)
             and type(volume_id) is str and _TOKEN.fullmatch(volume_id) and volume_id != "0" * 32,
             "Exact bounded completion worktree/volume required")
    storage_root = _absolute_path(layout["storage_root"], "completion storage root")
    operation_root = storage_root / "migrations/data-volumes" / volume_id
    registration_path = storage_root / "index/data-volumes" / (worktree_id + ".json")
    index_path = storage_root / "index" / (worktree_id + ".json")
    observed_raw = {}

    def check_failure():
        _require(not os.path.lexists(operation_root / "registration-failed.json"),
                 "A registration failure artifact prevents committed startup")

    check_failure()

    def read(path, label, expected=None):
        raw = _read_optional_regular(path, label, maximum=MAX_PROOF_BYTES)
        _require(raw is not None, "Missing " + label)
        if expected is not None:
            _require(hashlib.sha256(raw).hexdigest() == _sha(expected), label + " digest differs")
        observed_raw[Path(path)] = raw
        return _parse_object(raw, label)

    witness = read(operation_root / "registration-committed.json", "registration commit witness")
    _require(type(witness) is dict and set(witness) == WITNESS_KEYS and witness["schema"] == SCHEMA,
             "Closed registration commit witness required")
    for key in ("volume_id", "project_id", "worktree_id", "compose_project", "plan_sha256", "copy_receipt_sha256"):
        _require(witness[key] == pending[key], "Registration commit witness scope differs: " + key)
    _require(witness["registration_sha256"] == registration_sha256
             and witness["migration_receipt_sha256"] == registration["migration_receipt_sha256"],
             "Registration commit witness registration/migration digest differs")
    for key in ("plan_sha256", "copy_receipt_sha256", "registration_sha256", "migration_receipt_sha256"):
        _sha(witness[key])
    relative = witness["journal_relative"]
    _require(type(relative) is str and (relative == "journal.json" or re.fullmatch(
        r"recovery/[0-9a-f]{32}/journal\.json", relative)), "Bounded selected completion journal required")
    prefix = validate_journal(witness["journal_prefix"])
    _require(prefix["volume_id"] == volume_id and prefix["request_sha256"] == pending["plan_sha256"]
             and next_phase(prefix) == "originals-retired" and prefix["events"][-1]["phase"] == "volume-registered"
             and prefix["events"][-1]["state"] == "succeeded"
             and prefix["events"][-1]["inputs_sha256"] == witness["migration_receipt_sha256"],
             "Registration commit journal prefix is not the completed registration phase")

    def check_journal():
        path, current = _selected_journal(operation_root)
        current = validate_journal(current)
        _require(Path(path) == operation_root / relative
                 and all(current[key] == prefix[key] for key in ("schema", "volume_id", "request_sha256"))
                 and current["events"][:len(prefix["events"])] == prefix["events"],
                 "Selected completion journal differs from its committed prefix")

    check_journal()
    registered = read(operation_root / "volume-registered.json", "volume registration phase receipt",
                      prefix["events"][-1]["receipt_sha256"])
    _require(type(registered) is dict and set(registered) == REGISTERED_KEYS
             and registered["schema"] == "fullmag.data-volume-registered.v1"
             and registered["state"] == "registration-pair-published"
             and registered["volume_id"] == volume_id
             and registered["registration_sha256"] == registration_sha256
             and registered["migration_receipt_sha256"] == witness["migration_receipt_sha256"]
             and registered["index_path"] == str(index_path), "Volume registration phase scope differs")
    # This is an audit pin of publication time, not a lock on unrelated index fields.
    _sha(registered["index_sha256_at_publication"])
    qualified = read(operation_root / "migration-qualified.json", "migration qualification receipt",
                     witness["migration_receipt_sha256"])
    _require(type(qualified) is dict and set(qualified) == QUALIFIED_KEYS
             and qualified["schema"] == "fullmag.data-volume-migration-qualified.v1"
             and qualified["state"] == "runtime-and-full-zarr-qualified"
             and qualified["namespace_admitted"] is True and qualified["data_migrated"] is True
             and qualified["originals_retired"] is False, "Closed successful migration qualification required")
    for key in ("project_id", "worktree_id", "compose_project", "volume_id", "plan_sha256", "copy_receipt_sha256"):
        _require(qualified[key] == witness[key], "Migration qualification scope differs: " + key)
    for phase, field in (("runtime-qualified", "runtime_qualification_sha256"),
                         ("zarr-qualified", "zarr_qualification_sha256")):
        terminal = next(event for event in prefix["events"]
                        if event["phase"] == phase and event["state"] == "succeeded")
        _require(terminal["receipt_sha256"] == qualified[field],
                 "Qualification journal terminal differs from its exact evidence: " + phase)
    scoped = (
        ("restart-result.json", "restart_receipt_sha256", "fullmag.data-volume-restart-result.v1",
         "runtime-started-not-scientifically-qualified"),
        ("runtime-qualified.json", "runtime_qualification_sha256", "fullmag.data-volume-runtime-qualified.v1", "qualified"),
        ("zarr-qualified.json", "zarr_qualification_sha256", "fullmag.data-volume-zarr-qualified.v1", "qualified"),
    )
    for filename, digest_key, schema, state in scoped:
        value = read(operation_root / filename, filename, qualified[digest_key])
        _require(value.get("schema") == schema and value.get("state") == state
                 and value.get("volume_id") == volume_id and value.get("compose_project") == compose_project
                 and value.get("source_root") == pending["source_root"], "Qualification receipt scope differs: " + filename)
        if filename == "restart-result.json":
            _require(value.get("namespace_admitted") is True, "Restart namespace was not admitted")
    _require(read(registration_path, "committed registration", registration_sha256) == registration,
             "Committed registration changed during completion verification")
    # Re-read immutable bytes after the complete chain; a later legal journal
    # retirement suffix is allowed, but none of these pinned proof files rotate.
    for path, raw in observed_raw.items():
        _require(_read_optional_regular(path, "completion evidence readback", maximum=MAX_PROOF_BYTES) == raw,
                 "Completion evidence changed during verification")
    check_journal()
    check_failure()
    return deepcopy(witness)
