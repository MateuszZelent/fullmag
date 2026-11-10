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
    HistoryError, canonical, digest, document, referenced_attempts,
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


def control_references(root, candidate, *, owner_marker_pin=None, qualified_rejection=None):
    """Conservatively preserve references from nonhistorical control documents.

    A succeeded terminal attempt is historical. Failed, incomplete and unknown
    attempts remain roots, including their entire bounded record set. Backend
    script activation markers are historical only when confirmed activated.
    """
    root = _directory(root)
    if qualified_rejection is not None:
        from docker_activation_history_storage import source_files
        directory = root / "activation/attempts" / candidate
        if not directory.exists():
            directory = root / "activation/history-v1" / candidate
        if source_files(directory) != qualified_rejection:
            raise HistoryError("Qualified rejection bytes changed before reference inventory")
        rejected_receipt = document(qualified_rejection["receipt.json"], "qualified rejection")
        if (rejected_receipt.get("attempt") != candidate
                or rejected_receipt.get("state") != "failed-confirmed"
                or rejected_receipt.get("activation_state") != "rejected"
                or rejected_receipt.get("run_id") is not None):
            raise HistoryError("Invalid qualified rejection reference identity")
        expected_rejected_marker = {
            "schema": "fullmag.docker-startup-activation-receipt.v1", "state": "rejected",
            "request_id": rejected_receipt["request_id"],
            "source_sha256": rejected_receipt["source_sha256"],
            "provenance_sha256": rejected_receipt["provenance_sha256"],
            "authorization": document(qualified_rejection["authorization.json"], "authorization"),
            "result": document(qualified_rejection["result.json"], "result")}
    references, pins = {}, {}
    known_runs = {}
    closed_activations = {}
    live = _entries(root / "activation/attempts")
    def closed_terminal(path):
        terminal, receipt = path / "terminal.json", path / "receipt.json"
        if terminal.exists() and receipt.exists():
            terminal_raw = _raw(terminal)
            value = document(terminal_raw, str(path) + "/terminal")
            if (value.get("schema") == "fullmag.docker-build-operation.v1"
                    and (value.get("state") == "succeeded" or (
                        qualified_rejection is not None and path.name == candidate
                        and terminal_raw == qualified_rejection["terminal.json"]
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
                if entry.parent.name == "attempts":
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
                    references[relative] = raw
                    pins[relative] = _reference_digest(root, relative, raw)
            else:
                raise HistoryError("Linked or special control reference entry")
    walk(root, top=True)
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
