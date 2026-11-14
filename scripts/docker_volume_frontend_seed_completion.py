"""Pure authority and backend-baseline checks for failed-seed completion."""
from __future__ import annotations

from collections.abc import Mapping
import copy
import hashlib
from pathlib import PurePosixPath
import re

from docker_build_control import BuildControlError, canonical


SCHEMA = "fullmag.frontend-seed-backend-baseline.v1"
BASELINE_KINDS = {"captured-under-lease", "operator-pinned-prior-observation"}
_TOKEN = re.compile(r"[0-9a-f]{32}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_CONTAINER = re.compile(r"[0-9a-f]{64}\Z")
_IMAGE = re.compile(r"sha256:[0-9a-f]{64}\Z")
_COMMIT = re.compile(r"[0-9a-f]{40}\Z")
_API_OBSERVATION_KEYS = {
    "active_session", "api_instance_id", "processes", "run_id", "scene_revision", "session",
}
_PROCESS_KEYS = {"pid", "start_ticks", "executable"}
_BASELINE_KEYS = {
    "id", "image", "pid", "started_at", "restart_count", "state", "health", "api_observation",
}
_BASELINE_RECORD_KEYS = {
    "schema", "attempt", "base_attempt", "kind", "baseline", "baseline_sha256",
}
_MODE_KEYS = {
    "schema", "failed_attempt", "failed_config_sha256", "source_pins",
    "prior_terminal_sha256", "prior_input_manifest_sha256",
}
_SOURCE_PIN_KEYS = {
    "backend_app_commit", "input_manifest_commit", "controller_commit",
    "seed_files_sha256", "next_env_sha256", "backend_receipt_sha256",
    "backend_provenance_sha256", "backend_binary_sha256", "backend_container_id",
    "backend_started_at",
}
_EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
_UNKNOWN_BIND_ERROR = "Recreated frontend source bind identity could not be proven"
_FAILED_FRONTEND_ERROR = "DEV service exited before readiness: frontend"


def _fail(message: str) -> None:
    raise BuildControlError(message)


def _token(value: object, label: str) -> str:
    if not isinstance(value, str) or _TOKEN.fullmatch(value) is None:
        _fail("Invalid " + label)
    return value


def _sha256(value: object, label: str) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        _fail("Invalid " + label)
    return value


def _mode(value: object) -> Mapping[str, object]:
    from docker_volume_frontend_seed_recovery import SCHEMA as SEED_RECOVERY_SCHEMA

    if not isinstance(value, Mapping) or set(value) != _MODE_KEYS:
        _fail("Failed-seed completion mode fields differ")
    if value.get("schema") != SEED_RECOVERY_SCHEMA:
        _fail("Failed-seed completion mode schema differs")
    _token(value.get("failed_attempt"), "failed-seed attempt")
    _sha256(value.get("failed_config_sha256"), "failed-seed config digest")
    _sha256(value.get("prior_terminal_sha256"), "prior terminal digest")
    _sha256(value.get("prior_input_manifest_sha256"), "prior input manifest digest")
    _source_pins(value.get("source_pins"))
    return value


def _source_pins(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping) or set(value) != _SOURCE_PIN_KEYS:
        _fail("Failed-seed source package pin fields differ")
    for key in ("backend_app_commit", "input_manifest_commit", "controller_commit"):
        if not isinstance(value.get(key), str) or _COMMIT.fullmatch(value[key]) is None:
            _fail("Invalid failed-seed commit role: " + key)
    for key in ("seed_files_sha256", "next_env_sha256", "backend_receipt_sha256",
                "backend_provenance_sha256", "backend_binary_sha256"):
        _sha256(value.get(key), "failed-seed package digest: " + key)
    if not isinstance(value.get("backend_container_id"), str) or _CONTAINER.fullmatch(value["backend_container_id"]) is None:
        _fail("Invalid failed-seed backend container pin")
    if not isinstance(value.get("backend_started_at"), str) or not value["backend_started_at"]:
        _fail("Invalid failed-seed backend start pin")
    return dict(value)


def is_seed_completion(original: object) -> bool:
    """Identify this completion mode and reject any malformed present marker."""
    if not isinstance(original, Mapping):
        _fail("Frontend seed completion receipt is malformed")
    if "inputs" not in original:
        return False
    inputs = original.get("inputs")
    if not isinstance(inputs, Mapping):
        _fail("Frontend seed completion inputs are malformed")
    if "failed_seed_new_generation" not in inputs:
        return False
    _mode(inputs["failed_seed_new_generation"])
    return True


def baseline_relative(attempt: str) -> str:
    """Return the immutable operator-baseline path for one exact operation."""
    _token(attempt, "frontend seed completion attempt")
    return "verification/frontend-seed-completion/" + attempt + "/operator-backend-baseline.json"


def _validate_api_observation(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping) or set(value) != _API_OBSERVATION_KEYS:
        _fail("Frontend seed backend API observation fields differ")
    if (value.get("active_session") is not False
            or value.get("session") is not None
            or value.get("run_id") is not None
            or value.get("scene_revision") is not None
            or not isinstance(value.get("api_instance_id"), str)
            or not value["api_instance_id"]):
        _fail("Frontend seed backend API observation is not uniquely idle")
    processes = value.get("processes")
    if not isinstance(processes, list) or not processes:
        _fail("Frontend seed backend process observation is incomplete")
    pids = []
    api_count = 0
    for process in processes:
        if not isinstance(process, Mapping) or set(process) != _PROCESS_KEYS:
            _fail("Frontend seed backend process row is malformed")
        pid = process.get("pid")
        ticks = process.get("start_ticks")
        executable = process.get("executable")
        if (type(pid) is not int or pid <= 0
                or not isinstance(ticks, str) or not ticks.isdecimal()
                or not isinstance(executable, str) or not executable.startswith("/")
                or "\x00" in executable):
            _fail("Frontend seed backend process identity is incomplete")
        pids.append(pid)
        if PurePosixPath(executable).name == "fullmag-api":
            api_count += 1
    if len(set(pids)) != len(pids) or pids != sorted(pids) or api_count != 1:
        _fail("Frontend seed backend process list is unstable or has no unique API")
    return copy.deepcopy(dict(value))


def _validate_baseline(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping) or set(value) != _BASELINE_KEYS:
        _fail("Frontend seed backend baseline fields differ")
    if (not isinstance(value.get("id"), str) or _CONTAINER.fullmatch(value["id"]) is None
            or not isinstance(value.get("image"), str) or _IMAGE.fullmatch(value["image"]) is None
            or type(value.get("pid")) is not int or value["pid"] <= 0
            or not isinstance(value.get("started_at"), str) or not value["started_at"]
            or type(value.get("restart_count")) is not int or value["restart_count"] != 0
            or value.get("state") != "running"
            or value.get("health") != "healthy"):
        _fail("Frontend seed backend baseline is not the exact healthy incarnation")
    result = dict(value)
    result["api_observation"] = _validate_api_observation(value.get("api_observation"))
    return result


def capture_baseline(actual_backend: object, observation: object) -> dict[str, object]:
    """Extract and validate the eight stable backend fields from live observations."""
    if not isinstance(actual_backend, Mapping):
        _fail("Frontend seed backend container observation is malformed")
    state = actual_backend.get("State")
    health = state.get("Health") if isinstance(state, Mapping) else None
    if (not isinstance(state, Mapping) or state.get("Running") is not True
            or state.get("Status") != "running" or not isinstance(health, Mapping)):
        _fail("Frontend seed backend is not running")
    baseline = {
        "id": actual_backend.get("Id"),
        "image": actual_backend.get("Image"),
        "pid": state.get("Pid"),
        "started_at": state.get("StartedAt"),
        "restart_count": actual_backend.get("RestartCount"),
        "state": state.get("Status"),
        "health": health.get("Status"),
        "api_observation": observation,
    }
    return _validate_baseline(baseline)


def baseline_record(attempt: str, base_attempt: str, baseline: object, kind: str) -> dict[str, object]:
    """Create the exact immutable baseline record and its canonical-content digest."""
    attempt = _token(attempt, "frontend seed completion attempt")
    base_attempt = _token(base_attempt, "failed-seed base attempt")
    if not isinstance(kind, str) or kind not in BASELINE_KINDS:
        _fail("Unknown frontend seed backend baseline authority kind")
    normalized = _validate_baseline(baseline)
    return {
        "schema": SCHEMA,
        "attempt": attempt,
        "base_attempt": base_attempt,
        "kind": kind,
        "baseline": normalized,
        "baseline_sha256": hashlib.sha256(canonical(normalized)).hexdigest(),
    }


def validate_baseline(record: object, attempt: str, base_attempt: str,
                      actual_backend: object, observation: object) -> dict[str, object]:
    """Require the retained baseline to match the exact current backend observation."""
    attempt = _token(attempt, "frontend seed completion attempt")
    base_attempt = _token(base_attempt, "failed-seed base attempt")
    if not isinstance(record, Mapping) or set(record) != _BASELINE_RECORD_KEYS:
        _fail("Frontend seed backend baseline record is missing or malformed")
    if (record.get("schema") != SCHEMA or record.get("attempt") != attempt
            or record.get("base_attempt") != base_attempt
            or not isinstance(record.get("kind"), str)
            or record.get("kind") not in BASELINE_KINDS):
        _fail("Frontend seed backend baseline authority differs")
    baseline = _validate_baseline(record.get("baseline"))
    recorded_sha = _sha256(record.get("baseline_sha256"), "frontend seed backend baseline digest")
    if hashlib.sha256(canonical(baseline)).hexdigest() != recorded_sha:
        _fail("Frontend seed backend baseline content digest differs")
    current = capture_baseline(actual_backend, observation)
    if current != baseline:
        _fail("Frontend seed backend baseline drifted")
    return baseline


def validate_seed_authority(original: object, previous: object, rollback: object,
                            document: object, control: object,
                            attempt: str, base_attempt: str) -> dict[str, object]:
    """Validate the exact failed-seed lineage and return separately pinned commits."""
    from docker_volume_frontend_seed_recovery import resolve_active_generation, validate_generation_probe

    attempt = _token(attempt, "frontend seed completion attempt")
    base_attempt = _token(base_attempt, "failed-seed base attempt")
    if not isinstance(original, Mapping) or not is_seed_completion(original):
        _fail("Operation is not a failed-seed frontend completion")
    inputs = original.get("inputs")
    mode = _mode(inputs.get("failed_seed_new_generation"))
    if (original.get("schema") != "fullmag.docker-build-operation.v1"
            or original.get("phase") != "development"
            or original.get("state") != "outcome-unknown-resources-retained"
            or original.get("attempt") != attempt
            or original.get("error") != _UNKNOWN_BIND_ERROR
            or original.get("compose_project") != getattr(control, "project", None)
            or original.get("control_volume") != getattr(control, "volume", None)):
        _fail("Frontend seed completion is not the exact retained source-bind failure")
    refresh_attempt = inputs.get("frontend_refresh_from_attempt")
    refresh_config = inputs.get("frontend_refresh_from_config_sha256")
    if (inputs.get("native_build_requested") is not False
            or refresh_attempt != base_attempt
            or mode.get("failed_attempt") != base_attempt
            or mode.get("failed_config_sha256") != refresh_config):
        _fail("Frontend seed completion mode does not match its failed base attempt/config")
    if not isinstance(previous, Mapping):
        _fail("Failed-seed base terminal is malformed")
    config_sha = _sha256(refresh_config, "failed-seed base config digest")
    if (previous.get("schema") != "fullmag.docker-build-operation.v1"
            or previous.get("phase") != "development"
            or previous.get("state") != "failed-confirmed"
            or previous.get("attempt") != base_attempt
            or previous.get("config_sha256") != config_sha
            or previous.get("error") != _FAILED_FRONTEND_ERROR
            or not isinstance(previous.get("frontend_container"), str)
            or _CONTAINER.fullmatch(previous["frontend_container"]) is None
            or previous.get("compose_project") != control.project
            or previous.get("control_volume") != control.volume):
        _fail("Failed-seed base is not the exact frontend readiness refusal")
    if hashlib.sha256(canonical(dict(previous)) + b"\n").hexdigest() != mode.get("prior_terminal_sha256"):
        _fail("Failed-seed base terminal content digest differs")
    _sha256(mode.get("prior_input_manifest_sha256"), "failed-seed prior input manifest digest")

    source_pins = _source_pins(mode.get("source_pins"))
    if not isinstance(rollback, Mapping) or not isinstance(document, Mapping):
        _fail("Failed-seed Compose authority is malformed")
    rollback_services = rollback.get("services")
    current_services = document.get("services")
    if (rollback.get("name") != control.project or document.get("name") != control.project
            or not isinstance(rollback_services, Mapping)
            or not isinstance(current_services, Mapping)):
        _fail("Frontend seed completion Compose identity differs")
    rollback_frontend = rollback_services.get("frontend") if isinstance(rollback_services, Mapping) else None
    current_frontend = current_services.get("frontend") if isinstance(current_services, Mapping) else None
    rollback_backend = rollback_services.get("backend") if isinstance(rollback_services, Mapping) else None
    current_backend = current_services.get("backend") if isinstance(current_services, Mapping) else None
    if (not isinstance(rollback_backend, Mapping) or rollback_backend != current_backend):
        _fail("Frontend seed completion changed the retained backend declaration")
    if not isinstance(rollback_frontend, Mapping) or not isinstance(current_frontend, Mapping):
        _fail("Failed-seed frontend Compose commit pins are missing")
    rollback_front_env = rollback_frontend.get("environment")
    current_front_env = current_frontend.get("environment")
    rollback_back_env = rollback_backend.get("environment") if isinstance(rollback_backend, Mapping) else None
    if (not isinstance(rollback_front_env, Mapping)
            or rollback_front_env.get("FULLMAG_SOURCE_COMMIT") != source_pins["input_manifest_commit"]
            or not isinstance(current_front_env, Mapping)
            or current_front_env.get("FULLMAG_SOURCE_COMMIT") != source_pins["controller_commit"]):
        _fail("Failed-seed frontend input/controller commit roles differ from Compose")
    if (isinstance(rollback_back_env, Mapping)
            and "FULLMAG_SOURCE_COMMIT" in rollback_back_env
            and rollback_back_env.get("FULLMAG_SOURCE_COMMIT") != source_pins["backend_app_commit"]):
        _fail("Failed-seed backend app commit role differs from retained Compose")

    if (original.get("private_group_storage") != "group-volume-v1"
            or original.get("frontend_volume") != control.volume
            or previous.get("private_group_storage") != "group-volume-v1"
            or previous.get("frontend_volume") != control.volume):
        _fail("Failed-seed completion is not bound to the selected private group")
    old_generation = resolve_active_generation(control, previous, rollback)
    new_generation = resolve_active_generation(control, original, document)
    if new_generation.get("generation_id") != attempt:
        _fail("Failed-seed completion did not select its exact new generation")
    validate_generation_probe(
        original.get("frontend_generation_probe"), generation_id=attempt,
        old_generation_id=old_generation.get("generation_id"), old_seed_sha256=_EMPTY_SHA256,
    )
    return source_pins
