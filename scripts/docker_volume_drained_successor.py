"""Authenticate a completed native drain after one recovered failed incarnation.

This is host-side evidence selection, not native recovery authority. PID 1 still
authenticates its persisted drained owner under OWNER.lock before config rotation.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import sys
from collections.abc import Mapping

from docker_build_control import BuildControlError, canonical, bounded_capture
from docker_volume_stop_unadmitted import _control_bytes, _owner_identity_key
from docker_volume_reconcile import fingerprint

_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
_ATTEMPT = re.compile(r"[0-9a-f]{32}\Z")


class DrainedSuccessorContext(dict):
    """No authority-bearing start kwargs; immutable, separately compared witness."""

    def __init__(self, witness):
        super().__init__()
        self._witness_bytes = canonical(witness)

    @property
    def witness(self):
        return json.loads(self._witness_bytes)


def _require(condition, message):
    if not condition:
        raise BuildControlError("Drained successor: " + message)


def _record(control, relative, *, expected=None):
    raw = _control_bytes(control, relative)
    _require(isinstance(raw, bytes) and 0 < len(raw) <= 8 * 1024**2, "bounded record missing")
    sha = hashlib.sha256(raw).hexdigest()
    _require(expected is None or sha == expected, "record digest differs: " + relative)
    def unique(pairs):
        result = {}
        for key, value in pairs:
            _require(key not in result, "duplicate JSON field")
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=unique)
    _require(isinstance(value, dict), "record must be an object")
    return raw, value, sha


def _operation(control, phase, pin, previous, config_sha):
    _require(isinstance(pin, dict) and set(pin) == {"attempt", "terminal_sha256"},
             "operation pins differ")
    _require(isinstance(pin["attempt"], str) and _ATTEMPT.fullmatch(pin["attempt"])
             and isinstance(pin["terminal_sha256"], str) and _DIGEST.fullmatch(pin["terminal_sha256"]),
             "operation pins are invalid")
    base = phase + "/attempts/" + pin["attempt"]
    raw, receipt, _ = _record(control, base + "/terminal.json", expected=pin["terminal_sha256"])
    current_raw, _, _ = _record(control, base + "/receipt.json")
    _require(current_raw == raw, "operation receipt differs from terminal")
    _require(receipt.get("schema") == "fullmag.docker-build-operation.v1"
             and receipt.get("phase") == phase and receipt.get("state") == "succeeded"
             and receipt.get("attempt") == pin["attempt"]
             and receipt.get("compose_project") == control.project
             and receipt.get("control_volume") == control.volume,
             "operation is not this group's completed success")
    inputs = receipt.get("inputs", {})
    _require(inputs.get("attempt") == previous["attempt"]
             and inputs.get("config_sha256") == config_sha,
             "operation belongs to another development/configuration")
    return base, receipt


_LEDGER_READ_SCRIPT = r"""test "$(readlink -e /ledger)" = /ledger
test "$(readlink -e /ledger/ledger)" = /ledger/ledger
test ! -L /ledger/ledger/WRITER.lock
test -f /ledger/ledger/WRITER.lock
test "$(stat -c %h /ledger/ledger/WRITER.lock)" = 1
ledger_lock_pin=$(stat -c '%d:%i' /ledger/ledger/WRITER.lock)
exec 9</ledger/ledger/WRITER.lock
flock -n 9
test "$(stat -Lc '%d:%i' /proc/self/fd/9)" = "$ledger_lock_pin"
test "$(stat -c '%d:%i' /ledger/ledger/WRITER.lock)" = "$ledger_lock_pin"
test ! -L /ledger/ledger/HOST_RESOURCE_LEDGER.json
test -f /ledger/ledger/HOST_RESOURCE_LEDGER.json
test "$(readlink -e /ledger/ledger/HOST_RESOURCE_LEDGER.json)" = /ledger/ledger/HOST_RESOURCE_LEDGER.json
test "$(stat -c %h /ledger/ledger/HOST_RESOURCE_LEDGER.json)" = 1
test "$(stat -c %s /ledger/ledger/HOST_RESOURCE_LEDGER.json)" -gt 0
test "$(stat -c %s /ledger/ledger/HOST_RESOURCE_LEDGER.json)" -le 8388608
ledger_file_pin=$(stat -c '%d:%i:%h:%s' /ledger/ledger/HOST_RESOURCE_LEDGER.json)
exec 10</ledger/ledger/HOST_RESOURCE_LEDGER.json
test "$(stat -Lc '%d:%i:%h:%s' /proc/self/fd/10)" = "$ledger_file_pin"
head -c 8388609 <&10
test "$(stat -Lc '%d:%i:%h:%s' /proc/self/fd/10)" = "$ledger_file_pin"
test "$(stat -c '%d:%i:%h:%s' /ledger/ledger/HOST_RESOURCE_LEDGER.json)" = "$ledger_file_pin"
test "$(stat -c '%d:%i' /ledger/ledger/WRITER.lock)" = "$ledger_lock_pin"
"""

def _ledger_observation(control, document, actual):
    import docker_group_ledger as ledger
    expected = ledger.retained_profile(document, actual["backend"]["Image"])
    mounts = [mount for mount in actual["backend"].get("Mounts", [])
              if mount.get("Destination") == ledger.MOUNT_TARGET]
    _require(len(mounts) == 1 and mounts[0].get("Type") == "volume"
             and mounts[0].get("Name") == expected["volume_name"]
             and mounts[0].get("Driver") == "local" and mounts[0].get("RW") is True,
             "stopped backend ledger mount differs")
    observed_env = ledger._env_map(actual["backend"].get("Config", {}))
    _require(all(observed_env.get(key) == value for key, value in expected["environment"].items()),
             "stopped backend ledger environment differs")
    volume = expected["volume_name"]
    _require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,255}", volume), "ledger volume invalid")
    script = _LEDGER_READ_SCRIPT
    args = control.helper_args(script)
    at = args.index("--entrypoint")
    args[at:at] = ["--mount", "type=volume,src=" + volume + ",dst=/ledger,readonly,volume-nocopy"]
    result = bounded_capture(args, data=b"", timeout=90)
    _require(result.returncode == 0, "ledger observation unavailable or writer active")
    _require(isinstance(result.stdout, bytes) and 0 < len(result.stdout) <= 8 * 1024**2,
             "ledger observation exceeds byte bound")
    value = json.loads(result.stdout)
    _require(isinstance(value, dict), "ledger observation is not an object")
    _require(value.get("schema_version") == "host_resource_ledger.v4", "ledger schema is unsupported")
    reservations = value.get("reservations")
    _require(isinstance(reservations, list) and all(isinstance(row, dict)
             and row.get("state") == "released" for row in reservations),
             "ledger contains an active or unknown reservation")
    return hashlib.sha256(result.stdout).hexdigest()


def _validate_native_owners(ready, owner):
    name = "_fullmag_drained_successor_runtime_contract"
    module = sys.modules.get(name)
    if module is None:
        source = Path(__file__).resolve().parents[1] / "docker/all-in-one/runtime_service.py"
        spec = importlib.util.spec_from_file_location(name, source)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    module._validate_terminal_owner(ready, state="ready", name="drained successor ready owner")
    module._validate_terminal_owner(owner, state="drained", name="drained successor terminal owner")
    return module


def retained_context(control, previous, document, actual, proof_path, proof_sha256,
                     *, removed_container_proof=None):
    import docker_volume_dev as dev

    _require(isinstance(proof_path, str) and isinstance(proof_sha256, str)
             and _DIGEST.fullmatch(proof_sha256), "paired proof pins required")
    path = PurePosixPath(proof_path)
    root = PurePosixPath("/opt/fullmag/control/verification")
    _require(path.is_absolute() and path.is_relative_to(root) and ".." not in path.parts
             and str(path) == proof_path and "\\" not in proof_path,
             "proof must be a canonical verification reference")
    relative = str(path.relative_to("/opt/fullmag/control"))
    _, request, _ = _record(control, relative, expected=proof_sha256)
    _require(set(request) == {"schema", "stop", "journal_sha256", "native_config_sha256"}
             and request["schema"] == "fullmag.drained-successor-proof.v1"
             and isinstance(request["journal_sha256"], str)
             and _DIGEST.fullmatch(request["journal_sha256"])
             and isinstance(request["native_config_sha256"], str)
             and _DIGEST.fullmatch(request["native_config_sha256"]), "proof fields differ")
    inputs = previous.get("inputs", {})
    _require(previous.get("compose_project") == control.project
             and previous.get("state") == "succeeded"
             and document.get("name") == control.project, "development identity differs")
    config_sha = hashlib.sha256(canonical(document)).hexdigest()
    _require(previous.get("config_sha256") == config_sha, "development config pin differs")
    _require(isinstance(actual, Mapping) and set(actual) == {"backend", "frontend"},
             "exact two service observations required")
    stop_base, stop = _operation(control, "iteration", request["stop"], previous, config_sha)
    _require(stop.get("idle_backend_stopped") is True and stop.get("config_sha256") == config_sha,
             "operation is not a completed managed stop-only drain")
    backend, frontend = actual["backend"], actual["frontend"]
    _require(stop.get("backend_container") == backend.get("Id")
             and stop.get("frontend_container") == frontend.get("Id")
             and previous.get("backend_container") == backend.get("Id")
             and previous.get("frontend_container") == frontend.get("Id"),
             "service identities differ")
    for service, observed in actual.items():
        state = observed.get("State", {})
        labels = observed.get("Config", {}).get("Labels", {})
        _require(state.get("Running") is False and state.get("OOMKilled") is False
                 and type(state.get("ExitCode")) is int
                 and (service != "backend" or state["ExitCode"] == 0)
                 and state.get("Status") == "exited"
                 and labels.get("com.docker.compose.project") == control.project
                 and labels.get("com.docker.compose.service") == service
                 and observed.get("Image") == document["services"][service]["image"],
                 "service is not this group's graceful stopped incarnation")
    _, journal, _ = _record(control, "verification/stop-failed-" + backend["Id"] + ".json",
                            expected=request["journal_sha256"])
    _require(journal.get("schema") == "fullmag.stop-failed-admission.v1"
             and journal.get("state") == "stopped-confirmed"
             and journal.get("failure_kind") == "native-after-ready-failure"
             and journal.get("container_id") == backend["Id"]
             and journal.get("image_id") == backend["Image"],
             "historical failure journal identity differs")
    from docker_volume_stop_failed import _validate_native_after_ready_failure_probe
    failure = journal.get("failure_receipt", {})
    validated_failure = _validate_native_after_ready_failure_probe(
        journal.get("native_failure_probe"), failure.get("sha256"))
    _require(journal.get("retained_ready_owner") == validated_failure["ready_owner"]
             and failure.get("receipt") == journal["native_failure_probe"].get("process_receipt"),
             "historical failure owner/probe differs")
    old_state = journal.get("container_state", {})
    _require(isinstance(old_state.get("started_at"), str)
             and old_state["started_at"] != backend["State"].get("StartedAt")
             , "drain does not prove a later container incarnation")
    checkpoint_sha = probe_sha = archive_sha = None
    checkpoint = probe = None
    state_root = Path(previous["state_root"])
    checkpoint_pin = stop.get("inputs", {}).get("saved_authoring_checkpoint_sha256")
    if checkpoint_pin is not None:
        _, checkpoint, checkpoint_sha = _record(control, stop_base + "/saved-authoring-checkpoint.json", expected=checkpoint_pin)
        _require(stop.get("saved_authoring_restore_required") == checkpoint.get("archive"),
                 "stop checkpoint binding differs")
        dev._saved_authoring_validate_request(checkpoint, project=control.project,
            attempt=previous["attempt"], config_sha256=config_sha, selected=Path(inputs["source_root"]))
        for service, observed in actual.items():
            pin = checkpoint["containers"][service]
            _require(pin["id"] == observed["Id"] and pin["image"] == observed["Image"]
                     and pin["started_at"] == observed["State"]["StartedAt"]
                     and pin["fingerprint"] == fingerprint(observed),
                     "saved checkpoint service incarnation differs")
        archive_raw, scene = dev._saved_authoring_read_archive(checkpoint, state_root)
        archive_sha = hashlib.sha256(archive_raw).hexdigest()
        _, probe, probe_sha = _record(control, stop_base + "/saved-authoring-final-preflight.json")
        dev._saved_authoring_validate_probe(probe, checkpoint, scene)
    else:
        _require("saved_authoring_restore_required" not in stop,
                 "ordinary idle stop unexpectedly carries saved authoring")
        _, idle, _ = _record(control, stop_base + "/idle-preflight.json")
        _require(idle.get("status") == "ok" and idle.get("active_session") is False,
                 "ordinary stop did not observe an inactive session")
        snapshot_pin = stop.get("idle_stop_containers_sha256")
        _require(isinstance(snapshot_pin, str) and _DIGEST.fullmatch(snapshot_pin),
                 "ordinary stop has no immutable service snapshot")
        _, snapshot, _ = _record(control, stop_base + "/idle-stop-containers.json", expected=snapshot_pin)
        _require(set(snapshot) == set(actual), "ordinary stop services changed")
        for service, observed in actual.items():
            pinned = snapshot[service]
            # Docker reorders Mounts. fingerprint validates unique canonical
            # destinations and preserves every mount field while sorting them.
            _require(fingerprint(pinned) == fingerprint(observed)
                     and {key: value for key, value in pinned.items() if key != "Mounts"}
                     == {key: value for key, value in observed.items() if key != "Mounts"},
                     "ordinary stop service snapshot changed")
    _, drain, drain_sha = _record(control, stop_base + "/backend-drain.json")
    terminal_raw, terminal, terminal_sha = _record(control, "runtime-control/runtime-service/process-tree.json")
    _require(drain.get("schema") == "fullmag.docker-idle-restart-drain.v1"
             and drain.get("backend_container_id") == backend["Id"]
             and drain.get("process_receipt_sha256") == terminal_sha
             and drain.get("process_receipt") == terminal,
             "current native drain differs from managed stop")
    if probe is not None:
        dev._saved_authoring_validate_drain(probe, terminal)
    _require(terminal.get("schema") == "fullmag.docker-process-tree.v1"
             and terminal.get("state") == "drained", "native process receipt is not drained")
    _, owner, owner_sha = _record(control, "runtime-control/runtime-services/OWNER.json")
    _require(owner.get("state") == "drained", "persisted owner is not drained")
    ready = terminal.get("service_owner", {})
    token = ready.get("owner_token")
    _require(isinstance(token, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", token),
             "ready owner pin reference invalid")
    _, ready_pin, ready_sha = _record(control, "runtime-control/runtime-services/docker-client-" + token + ".json")
    native = _validate_native_owners(ready, owner)
    native._validate_terminal_owner(ready_pin, state="ready", name="durable ready owner pin")
    native._validate_terminal_owner(terminal.get("terminal_service_owner", {}), state="drained",
                                    name="native drain terminal owner")
    _require(native._owner_fingerprint(ready_pin) == native._owner_fingerprint(ready),
             "durable ready owner pin differs")
    _require(native._owner_fingerprint(terminal["terminal_service_owner"]) == native._owner_fingerprint(owner),
             "persisted owner differs from authenticated drain")
    _require(_owner_identity_key(ready, "ready owner") == _owner_identity_key(owner, "drained owner"),
             "native owner identity changed during drain")
    _require(journal.get("retained_ready_owner") != ready,
             "failure journal is not from an earlier native owner")
    config_native_sha = dev._read_runtime_config_digest(control)
    _require(config_native_sha == request["native_config_sha256"],
             "native owner configuration differs")
    if checkpoint is not None:
        dev._saved_authoring_verify_retained_history(checkpoint, state_root)
    ledger_sha = _ledger_observation(control, document, actual)
    # Native PID 1 remains the authority for OWNER.lock, durable pools, process
    # absence and generation rotation. Host proof must not create recovery kwargs.
    if removed_container_proof is not None:
        removed = removed_container_proof
        observed_state = backend["State"]
        _require(removed.get("schema") == "fullmag.docker-removed-recreation-container.v1"
                 and removed.get("container_id") == backend["Id"]
                 and removed.get("frontend_container") == frontend["Id"]
                 and removed.get("image_id") == backend["Image"]
                 and removed.get("container_state") == {"id": backend["Id"], "image": backend["Image"],
                     "started_at": observed_state["StartedAt"], "finished_at": observed_state["FinishedAt"],
                     "exit_code": 0},
                 "completed recreation snapshot differs from the drained incarnation")
    return DrainedSuccessorContext({"schema": "fullmag.drained-successor-witness.v1",
        "proof_path": proof_path, "proof_sha256": proof_sha256,
        "stop": request["stop"],
        "journal_sha256": request["journal_sha256"], "config_sha256": config_sha,
        "native_config_sha256": config_native_sha, "ledger_sha256": ledger_sha, "checkpoint_sha256": checkpoint_sha,
        "probe_sha256": probe_sha, "drain_sha256": drain_sha,
        "terminal_sha256": terminal_sha, "owner_sha256": owner_sha,
        "ready_owner_pin_sha256": ready_sha, "archive_sha256": archive_sha,
        "containers": {service: {"id": row["Id"], "image": row["Image"],
            "started_at": row["State"]["StartedAt"], "finished_at": row["State"]["FinishedAt"],
            "exit_code": row["State"]["ExitCode"], "fingerprint": fingerprint(row)}
            for service, row in actual.items()}})
