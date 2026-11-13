"""Pure validation of one retained stop/recreation/development witness diamond."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import math
from pathlib import PurePosixPath
import re

import fullmag_data_volume_runtime_binding as _binding_model


_HEX32 = re.compile(r"[0-9a-f]{32}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_IMAGE = re.compile(r"sha256:[0-9a-f]{64}\Z")
_COMMIT = re.compile(r"[0-9a-f]{40}\Z")
_ROLES = ("backend", "frontend")
_WITNESS_PHASES = {"stop": "iteration", "recreation": "recreate-services", "development": "development"}


def _require(value: bool, message: str) -> None:
    if not value:
        raise ValueError(message)


def _is_sha(value: object) -> bool:
    return type(value) is str and _SHA256.fullmatch(value) is not None


def _is_canonical_absolute_path(value: object) -> bool:
    if type(value) is not str:
        return False
    path = PurePosixPath(value)
    return path.is_absolute() and str(path) == value and ".." not in path.parts


def _canonical(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def _runtime_pins(value: object) -> dict:
    pins = _binding_model.runtime_pins(value)
    _require(_is_canonical_absolute_path(pins["state_root"]), "Original plan StateRoot is not canonical")
    return pins


def _plan_scope(plan: object, compose_project: object, source_root: object) -> tuple[dict, dict]:
    _require(type(plan) is dict and plan.get("schema") == "fullmag.data-volume-plan.v1",
             "Exact original data-volume plan required")
    _require(type(plan.get("volume_id")) is str and _HEX32.fullmatch(plan["volume_id"]) is not None
             and set(plan["volume_id"]) != {"0"}, "Original plan volume identity is invalid")
    for key in ("project_id", "worktree_id", "compose_project", "storage_root", "mount_root", "runtime_root"):
        _require(type(plan.get(key)) is str and plan[key], "Original plan scope is incomplete: " + key)
    _require(type(compose_project) is str and compose_project == plan["compose_project"],
             "Witness Compose project differs from the original plan")
    _require(_is_canonical_absolute_path(source_root) and source_root == plan.get("source_root"),
             "Witness source root differs from the original plan")
    pins = _runtime_pins(plan.get("runtime_pins"))
    observation = plan.get("observation")
    _require(type(observation) is dict and type(observation.get("datasets")) is dict
             and set(observation["datasets"]) == {"state", "user_data"},
             "Original dataset observations are incomplete")
    state_dataset = observation["datasets"]["state"]
    _require(type(state_dataset) is dict, "Original State dataset identity is invalid")
    state_root = state_dataset.get("canonical_root")
    _require(pins["state_root"] == state_root, "Original plan runtime and State dataset root differ")
    for role, row in observation["datasets"].items():
        _require(type(row) is dict and _is_canonical_absolute_path(row.get("canonical_root"))
                 and type(row.get("device")) is int and row["device"] > 0
                 and type(row.get("inode")) is int and row["inode"] > 0,
                 "Original dataset identity is invalid: " + role)
    return pins, observation["datasets"]


def _read_record(records: dict, path: str) -> dict:
    record = records[path]
    _require(type(record) is dict and set(record) == {"sha256", "value"}
             and _is_sha(record.get("sha256")) and type(record.get("value")) is dict,
             "Managed witness record is malformed: " + path)
    try:
        serialized = _canonical(record["value"]) + b"\n"
    except (TypeError, ValueError) as error:
        raise ValueError("Managed witness value is not canonical JSON: " + path) from error
    _require(hashlib.sha256(serialized).hexdigest() == record["sha256"],
             "Managed witness raw digest differs from its value: " + path)
    return record["value"]


def _timestamp(receipt: dict, key: str, role: str) -> float:
    value = receipt.get(key)
    _require(type(value) in (int, float), "Managed witness timestamp is invalid: " + role + "/" + key)
    try:
        numeric = float(value)
    except (OverflowError, ValueError) as error:
        raise ValueError("Managed witness timestamp is invalid: " + role + "/" + key) from error
    _require(math.isfinite(numeric) and numeric >= 0,
             "Managed witness timestamp is invalid: " + role + "/" + key)
    return numeric


def _terminal_observation(value: object, stop_attempt: str, stop_sha256: str) -> dict:
    keys = {"schema", "stop_attempt", "stop_sha256", "request_sha256", "proof_sha256"}
    _require(type(value) is dict and set(value) == keys
             and value.get("schema") == "fullmag.terminal-observation-context.v1"
             and value.get("stop_attempt") == stop_attempt and value.get("stop_sha256") == stop_sha256
             and _is_sha(value.get("request_sha256")) and _is_sha(value.get("proof_sha256")),
             "Exact shared terminal-observation witness is required")
    return value


def qualify_witnesses(
    plan: dict,
    *,
    compose_project: str,
    control_volume: str,
    source_root: str,
    witnesses: dict,
    records: dict,
) -> dict:
    """Validate an immutable stop/recreation/development diamond without I/O.

    The stopped predecessor belongs to the stop receipt, which may postdate the
    original plan runtime. The function proves the latest endpoint and its
    common-stop relationship; it does not claim that this stop drained the
    original plan's runtime pins or that recreation directly caused development.
    """
    old_pins, _datasets = _plan_scope(plan, compose_project, source_root)
    _require(type(control_volume) is str and control_volume, "Exact control-volume identity is required")
    _require(type(witnesses) is dict and set(witnesses) == set(_WITNESS_PHASES),
             "Exact stop/recreation/development witness set is required")

    witness_tokens: dict[str, str] = {}
    expected_paths: dict[str, str] = {}
    for role, phase in _WITNESS_PHASES.items():
        ref = witnesses[role]
        _require(type(ref) is dict and set(ref) == {"path", "sha256"}
                 and _is_sha(ref.get("sha256")) and type(ref.get("path")) is str,
                 "Malformed witness reference: " + role)
        match = re.fullmatch(phase + r"/attempts/([0-9a-f]{32})/terminal\.json", ref["path"])
        _require(match is not None, "Witness path is not bounded: " + role)
        witness_tokens[role] = match.group(1)
        expected_paths[role] = ref["path"]
    stop_path = expected_paths["stop"]
    recreation_path = expected_paths["recreation"]
    development_path = expected_paths["development"]
    stop_snapshot_path = stop_path.replace("terminal.json", "idle-stop-containers.json")
    retained_snapshot_path = recreation_path.replace("terminal.json", "retained-containers.json")
    compose_path = development_path.replace("terminal.json", "compose.json")
    required_records = {
        stop_path, recreation_path, development_path,
        stop_snapshot_path, retained_snapshot_path, compose_path,
    }
    _require(type(records) is dict and set(records) == required_records,
             "Exact bounded witness record set is required")

    stop = _read_record(records, stop_path)
    recreation = _read_record(records, recreation_path)
    development = _read_record(records, development_path)
    snapshot = _read_record(records, stop_snapshot_path)
    retained = _read_record(records, retained_snapshot_path)
    compose = _read_record(records, compose_path)
    for role, receipt in (("stop", stop), ("recreation", recreation), ("development", development)):
        ref = witnesses[role]
        _require(records[ref["path"]]["sha256"] == ref["sha256"],
                 "Witness terminal digest differs: " + role)
        _require(receipt.get("schema") == "fullmag.docker-build-operation.v1"
                 and receipt.get("phase") == _WITNESS_PHASES[role]
                 and receipt.get("state") == "succeeded"
                 and receipt.get("attempt") == witness_tokens[role]
                 and receipt.get("compose_project") == compose_project
                 and receipt.get("control_volume") == control_volume,
                 "Witness terminal scope or state differs: " + role)

    state_root = old_pins["state_root"]
    stop_inputs = stop.get("inputs")
    recreation_inputs = recreation.get("inputs")
    development_inputs = development.get("inputs")
    _require(type(stop_inputs) is dict and type(recreation_inputs) is dict
             and type(stop_inputs.get("attempt")) is str
             and _HEX32.fullmatch(stop_inputs["attempt"]) is not None
             and _is_sha(stop_inputs.get("config_sha256"))
             and recreation_inputs.get("attempt") == stop_inputs["attempt"]
             and recreation_inputs.get("config_sha256") == stop_inputs["config_sha256"]
             and stop.get("config_sha256") == stop_inputs["config_sha256"],
             "Recreation does not name the exact stopped predecessor")
    _require(stop_inputs.get("source_root") == source_root
             and type(stop_inputs.get("image_id")) is str
             and _IMAGE.fullmatch(stop_inputs["image_id"]) is not None
             and stop.get("state_root") == state_root
             and stop.get("idle_backend_stopped") is True,
             "Stop source, image, StateRoot, or terminal-stop state differs")

    stopped_ids = {role: stop.get(role + "_container") for role in _ROLES}
    _require(all(type(value) is str and _is_sha(value) for value in stopped_ids.values())
             and stopped_ids["backend"] != stopped_ids["frontend"],
             "Stopped service identities are invalid")
    _require(set(snapshot) == set(_ROLES), "Stopped snapshot must contain exactly the backend/frontend pair")
    stop_snapshot_sha = records[stop_snapshot_path]["sha256"]
    _require(stop.get("idle_stop_containers_sha256") == stop_snapshot_sha
             and records[retained_snapshot_path]["sha256"] == stop_snapshot_sha
             and retained == snapshot,
             "Recreation did not retain the exact raw stopped-container snapshot")
    for role in _ROLES:
        container = snapshot[role]
        state = container.get("State") if type(container) is dict else None
        config = container.get("Config") if type(container) is dict else None
        labels = config.get("Labels") if type(config) is dict else None
        _require(type(container) is dict and container.get("Id") == stopped_ids[role]
                 and container.get("Image") == stop_inputs["image_id"]
                 and type(state) is dict and state.get("Status") == "exited"
                 and state.get("Running") is False and type(state.get("ExitCode")) is int
                 and state["ExitCode"] == 0 and type(state.get("Pid")) is int and state["Pid"] == 0
                 and type(labels) is dict and labels.get("com.docker.compose.project") == compose_project
                 and labels.get("com.docker.compose.service") == role
                 and labels.get("org.fullmag.source.worktree-id") == plan["worktree_id"],
                 "Stopped container image/source/state differs: " + role)

    removed = recreation.get("removed_containers")
    _require(recreation.get("fresh_state") is False and recreation.get("previous_state_root") == state_root
             and type(removed) is list and len(removed) == 2
             and all(type(value) is str and _is_sha(value) for value in removed)
             and len(set(removed)) == 2
             and set(removed) == set(stopped_ids.values()),
             "Recreation changed StateRoot or removed another container pair")

    stop_ref_sha = witnesses["stop"]["sha256"]
    recreation_observation = _terminal_observation(
        recreation.get("terminal_observation"), witness_tokens["stop"], stop_ref_sha
    )
    development_observation = _terminal_observation(
        development.get("terminal_observation"), witness_tokens["stop"], stop_ref_sha
    )
    _require(recreation_observation == development_observation,
             "Recreation and development do not share the exact stop/request/proof")

    _require(type(development_inputs) is dict
             and development_inputs.get("source_root") == source_root
             and development_inputs.get("source_worktree_id") == plan["worktree_id"]
             and development_inputs.get("source_project_id") == plan["project_id"]
             and type(development_inputs.get("image_id")) is str
             and _IMAGE.fullmatch(development_inputs["image_id"]) is not None
             and development.get("state_root") == state_root,
             "Current development source, image, or StateRoot differs")
    current_ids = {role: development.get(role + "_container") for role in _ROLES}
    _require(all(type(value) is str and _is_sha(value) for value in current_ids.values())
             and current_ids["backend"] != current_ids["frontend"]
             and set(current_ids.values()).isdisjoint(stopped_ids.values())
             and all(current_ids[role] != old_pins[role] for role in _ROLES)
             and development["attempt"] != old_pins["attempt"]
             and development["attempt"] != stop_inputs["attempt"],
             "Current development must identify a new distinct service pair")
    source_commit = development.get("source_commit")
    source_snapshot_sha = development.get("source_snapshot_sha256")
    backend_receipt_sha = development.get("backend_build_receipt_sha256")
    _require(type(source_commit) is str and _COMMIT.fullmatch(source_commit) is not None
             and _is_sha(source_snapshot_sha) and _is_sha(backend_receipt_sha),
             "Current development source/build digests are invalid")

    _require(compose.get("name") == compose_project and type(compose.get("services")) is dict
             and set(compose["services"]) == set(_ROLES),
             "Current Compose document does not describe the exact service pair")
    try:
        compose_sha = hashlib.sha256(_canonical(compose)).hexdigest()
    except (TypeError, ValueError) as error:
        raise ValueError("Current Compose document is not canonical JSON") from error
    _require(development.get("config_sha256") == compose_sha,
             "Current Compose document differs from the development configuration pin")

    stop_started, stop_finished = _timestamp(stop, "started_at", "stop"), _timestamp(stop, "finished_at", "stop")
    recreation_started = _timestamp(recreation, "started_at", "recreation")
    recreation_finished = _timestamp(recreation, "finished_at", "recreation")
    development_started = _timestamp(development, "started_at", "development")
    development_finished = _timestamp(development, "finished_at", "development")
    _require(stop_started <= stop_finished <= recreation_started <= recreation_finished
             <= development_started <= development_finished,
             "Stop/recreation/development timestamps are out of order")

    runtime_pins = {
        "attempt": development["attempt"],
        "config_sha256": development["config_sha256"],
        "state_root": state_root,
        "backend": current_ids["backend"],
        "frontend": current_ids["frontend"],
        "image_id": development_inputs["image_id"],
        "runtime_witness_path": development_path,
        "runtime_witness_sha256": witnesses["development"]["sha256"],
    }
    runtime_source = {
        "source_commit": source_commit,
        "source_snapshot_sha256": source_snapshot_sha,
        "backend_build_receipt_sha256": backend_receipt_sha,
    }
    return {
        "runtime_pins": deepcopy(runtime_pins),
        "runtime_source": runtime_source,
        "compose": deepcopy(compose),
        "stopped_pair": deepcopy(stopped_ids),
    }
