"""Authorize fresh archival after one exact diagnostic stop and loss of WSL state."""
from __future__ import annotations

from hashlib import sha256
import json
import os
from pathlib import Path
import re
import stat

from docker_build_control import BuildControlError, canonical
from linux_native_host import PROFILE, read_owned_regular


def _require(condition, message):
    if not condition:
        raise BuildControlError("Lost Linux state: " + message)


def _record(raw):
    def unique(items):
        result = {}
        for key, value in items:
            _require(key not in result, "duplicate JSON field")
            result[key] = value
        return result

    data = json.loads(raw, object_pairs_hook=unique)
    _require(isinstance(data, dict), "evidence must be a JSON object")
    return data


def _host_witness(state):
    directory_names = ("runs", "docker-all", "session-store", "WRITER.owner.json")
    root_device = state.stat().st_dev
    fingerprints = []
    path = state
    for name in directory_names:
        meta = path.lstat()
        _require(stat.S_ISDIR(meta.st_mode) and meta.st_dev == root_device,
                 "retained state is not one local directory tree")
        with os.scandir(path) as entries:
            first = next(entries, None)
            _require(first is not None and first.name == name and next(entries, None) is None,
                     "retained state contains unexpected entries or recovery metadata")
        fingerprints.append((meta.st_dev, meta.st_ino, meta.st_mtime_ns))
        path /= name
    raw = read_owned_regular(path)
    writer = _record(raw)
    _require(writer.get("schema") == "fullmag.writer.v1" and writer.get("released") is True,
             "retained session writer is not released")
    return {"directories": fingerprints, "released_writer_sha256": sha256(raw).hexdigest()}


def assert_lost_state_consumers(control, ids, helper=None):
    from docker_volume_unclaimed_cancellation import _project_container_ids, _volume_consumer_ids

    expected = set(ids.values())
    if helper is not None:
        expected.add(helper)
    _require(_project_container_ids(control.project) == expected
             and _volume_consumer_ids(control.volume) == expected,
             "another container references the group or its private volume")


def validate_lost_linux_state(control, stop_pin, previous, document, actual, state):
    """Read evidence only. The caller repeats this witness before container removal."""
    match = re.fullmatch(r"([0-9a-f]{32})@([0-9a-f]{64})", stop_pin)
    _require(match is not None, "expected stop-attempt@terminal-sha256")
    attempt, terminal_sha = match.groups()
    backend = document["services"]["backend"]
    mounts = {row["target"]: row for row in backend["volumes"]}
    state = Path(state)
    _require(control.project == document["name"] == "fullmag-master"
             and not getattr(control, "namespace", "")
             and backend["environment"].get("FULLMAG_SESSION_STORAGE_PROFILE") == PROFILE
             and mounts["/state"].get("type") == "bind"
             and mounts["/state"].get("source") == previous["state_root"] == str(state)
             and state.resolve(strict=True) == state
             and mounts["/host-ledger"].get("type") == "volume"
             and mounts["/host-ledger"].get("volume", {}).get("subpath") == "private/ledger"
             and document["volumes"][mounts["/host-ledger"]["source"]].get("name") == control.volume,
             "expected the retained master Linux bind and private ledger")
    host = _host_witness(state)

    base = "stop-diagnostic/attempts/" + attempt + "/"
    raw = control.read_bytes(base + "terminal.json")
    _require(sha256(raw).hexdigest() == terminal_sha
             and control.read_bytes(base + "receipt.json") == raw, "diagnostic stop digest differs")
    receipt = _record(raw)
    inputs = receipt["inputs"]
    config_sha = sha256(canonical(document)).hexdigest()
    backend_row = actual["backend"]
    docker_state = backend_row["State"]
    ids = {"backend_container_id": backend_row["Id"], "frontend_container_id": actual["frontend"]["Id"]}
    _require(receipt.get("schema") == "fullmag.docker-build-operation.v1"
             and receipt.get("attempt") == attempt and receipt.get("phase") == "stop-diagnostic"
             and receipt.get("state") == "succeeded" and receipt.get("stopped_backend") is True
             and inputs.get("preview_only") is False
             and receipt.get("compose_project") == control.project and receipt.get("control_volume") == control.volume
             and inputs.get("attempt") == previous["attempt"]
             and inputs.get("source_root") == previous["inputs"]["source_root"]
             and inputs.get("terminal_sha256") == sha256(canonical(previous) + b"\n").hexdigest()
             and inputs.get("config_sha256") == previous["config_sha256"] == config_sha
             and inputs.get("image_id") == receipt.get("image_id") == backend_row["Image"]
             and all(inputs.get(key) == value for key, value in ids.items()),
             "diagnostic stop does not bind this development attempt and service pair")

    stop = _record(control.read_bytes(base + "diagnostic-stop-terminal.json"))
    ready = stop["retained_ready_owner"]
    owner_pids = sorted([ready["pid"], *(child["pid"] for child in ready["children"])])
    preflight = _record(control.read_bytes(base + "diagnostic-stop-preflight.json"))
    _require(sha256(canonical(stop)).hexdigest() == receipt.get("diagnostic_stop_terminal_sha256")
             and stop.get("schema") == "fullmag.docker-api-diagnostic-stop.v1"
             and stop.get("state") == "stopped-execution-unknown"
             and stop.get("runtime_owner_state") == "failed-preserved"
             and stop.get("execution_state") == "unknown" and stop.get("resource_leases") == "untouched"
             and stop.get("attempt") == previous["attempt"] and stop.get("config_sha256") == config_sha
             and all(stop.get(key) == value for key, value in ids.items())
             and stop.get("backend_image_id") == backend_row["Image"]
             and stop.get("backend_started_at") == inputs.get("backend_started_at") == docker_state.get("StartedAt")
             and stop.get("backend_finished_at") == docker_state.get("FinishedAt")
             and stop.get("backend_exit_code") == docker_state.get("ExitCode")
             and docker_state.get("Status") == "exited" and docker_state.get("Pid") == 0
             and docker_state.get("Running") is False and docker_state.get("OOMKilled") is False
             and not any(docker_state.get(key) for key in ("Paused", "Restarting", "Dead"))
             and preflight.get("schema") == "fullmag.docker-api-diagnostic-stop-preflight.v1"
             and all(preflight.get(key) == value for key, value in ids.items())
             and preflight.get("attempt") == previous["attempt"]
             and preflight.get("config_sha256") == config_sha
             and preflight.get("backend_started_at") == docker_state.get("StartedAt")
             and preflight.get("retained_ready_owner") == ready
             and preflight.get("owner_pids_absent") == owner_pids,
             "diagnostic stop does not prove the exact stopped backend incarnation")

    for key, relative in (
        ("failed_owner_sha256", "runtime-services/OWNER.json"),
        ("terminal_process_receipt_sha256", "runtime-service/process-tree.json"),
        ("runtime_config_sha256", "runtime-service/docker-all.json"),
    ):
        current = control.read_bytes("runtime-control/" + relative)
        _require(sha256(current).hexdigest() == stop.get(key), "retained native evidence changed: " + relative)

    ledger_raw = control.read_bytes("private/ledger/ledger/HOST_RESOURCE_LEDGER.json")
    ledger = _record(ledger_raw)
    reservations = ledger.get("reservations")
    _require(ledger.get("schema_version") == "host_resource_ledger.v4"
             and isinstance(reservations, list)
             and all(isinstance(item, dict) and item.get("state") == "released" for item in reservations),
             "private ledger has an active or unknown reservation")
    return {"stop_pin": stop_pin, "ledger_sha256": sha256(ledger_raw).hexdigest(), **host}
