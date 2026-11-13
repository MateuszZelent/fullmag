"""Exact recovery proof for one failed, un-frozen frontend seed generation."""
from __future__ import annotations

import base64
from collections.abc import Mapping
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile

from docker_build_control import BuildControlError, MAX_DOCUMENT_BYTES, canonical, docker_capture


SCHEMA = "fullmag.docker-frontend-failed-seed-recovery.v1"
SEED_RELATIVE = "apps/control-room/next-env.d.ts"
SEED_PATH = "/state/development/workspace/" + SEED_RELATIVE
ERROR_SUFFIX = "FrontendDevError: seed file hash changed: " + SEED_RELATIVE
_ATTEMPT = re.compile(r"[0-9a-f]{32}\Z")
_COMMIT = re.compile(r"[0-9a-f]{40}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_CONTAINER = re.compile(r"[0-9a-f]{64}\Z")
_BACKEND_ANCHOR_FIELDS = (
    "container_id", "started_at", "container_pid", "fingerprint", "owner_token",
    "owner_start_token", "state", "certificate_identity", "processes",
    "api_instance_id", "active_session",
)


def _fail(message: str) -> None:
    raise BuildControlError(message)


def validate_refresh_options(args) -> bool:
    """Return whether the explicit seed-recovery mode was selected."""
    enabled = getattr(args, "failed_seed_new_generation", False)
    if type(enabled) is not bool:
        _fail("Failed-seed generation selector must be a boolean")
    if not enabled:
        return False
    if (getattr(args, "frontend_frozen_resume", None) is not None
            or getattr(args, "frontend_frozen_resume_sha256", None) is not None
            or getattr(args, "restart_backend", False)):
        _fail("Failed-seed generation is exclusive with frozen-resume and backend restart")
    return True


def validate_seed_manifest(previous: Mapping[str, object], current: Mapping[str, object], *,
                           backend_app_commit: str, expected_backend_app_commit: str,
                           input_manifest_commit: str,
                           controller_commit: str,
                           selected_seed_bytes: Mapping[str, bytes]) -> dict[str, object]:
    """Bind all seed inputs, allowing only the app/input commit to differ."""
    if not isinstance(previous, Mapping) or not isinstance(current, Mapping):
        _fail("Failed-seed recovery input manifest is malformed")
    if (not isinstance(backend_app_commit, str) or _COMMIT.fullmatch(backend_app_commit) is None
            or not isinstance(expected_backend_app_commit, str)
            or _COMMIT.fullmatch(expected_backend_app_commit) is None
            or backend_app_commit != expected_backend_app_commit):
        _fail("Failed-seed backend app commit differs from the retained receipt")
    if (not isinstance(input_manifest_commit, str) or _COMMIT.fullmatch(input_manifest_commit) is None
            or previous.get("source_commit") != input_manifest_commit):
        _fail("Failed-seed retained input commit differs from its prior input manifest")
    if (not isinstance(controller_commit, str) or _COMMIT.fullmatch(controller_commit) is None
            or current.get("source_commit") != controller_commit):
        _fail("Failed-seed controller commit differs from the current source manifest")
    if (previous.get("schema") != "fullmag.docker-development-inputs.v1"
            or current.get("schema") != previous.get("schema")):
        _fail("Failed-seed input manifest schema differs")
    previous_without_commit = dict(previous)
    current_without_commit = dict(current)
    previous_without_commit.pop("source_commit", None)
    current_without_commit.pop("source_commit", None)
    if previous_without_commit != current_without_commit:
        _fail("Failed-seed source manifest differs outside source_commit")
    files = current.get("files")
    if not isinstance(files, list) or not files:
        _fail("Failed-seed source seed inventory is missing")
    expected = {}
    for item in files:
        if (not isinstance(item, Mapping) or set(item) != {"relative", "sha256"}
                or not isinstance(item.get("relative"), str)
                or item["relative"].startswith("/") or ".." in item["relative"].split("/")
                or not isinstance(item.get("sha256"), str)
                or _SHA256.fullmatch(item["sha256"]) is None
                or item["relative"] in expected):
            _fail("Failed-seed source seed inventory is malformed")
        expected[item["relative"]] = item["sha256"]
    if SEED_RELATIVE not in expected:
        _fail("Failed-seed source manifest omits next-env.d.ts")
    if (not isinstance(selected_seed_bytes, Mapping)
            or set(selected_seed_bytes) != set(expected)
            or any(not isinstance(value, bytes) for value in selected_seed_bytes.values())):
        _fail("Failed-seed captured source bytes do not cover the exact seed inventory")
    observed = {relative: hashlib.sha256(value).hexdigest()
                for relative, value in selected_seed_bytes.items()}
    if observed != expected:
        _fail("Failed-seed source seed hash differs from the retained manifest")
    ordered_files = [{"relative": relative, "sha256": expected[relative]}
                     for relative in sorted(expected)]
    return {
        "backend_app_commit": backend_app_commit,
        "input_manifest_commit": input_manifest_commit,
        "controller_commit": controller_commit,
        "seed_files_sha256": hashlib.sha256(canonical(ordered_files)).hexdigest(),
        "next_env_sha256": expected[SEED_RELATIVE],
    }


def authenticated_source_pins(control, previous: Mapping[str, object],
                              document: Mapping[str, object], actual: Mapping[str, object],
                              previous_inputs: Mapping[str, object]) -> dict[str, object]:
    """Authenticate backend app and frontend input commits from retained artifacts."""
    import docker_dev_codegen as codegen

    attempt = previous.get("attempt")
    backend_id = previous.get("backend_container")
    backend_started_at = previous.get("backend_started_at")
    backend = actual.get("backend")
    backend_state = backend.get("State") if isinstance(backend, Mapping) else None
    backend_health = backend_state.get("Health") if isinstance(backend_state, Mapping) else None
    backend_config = backend.get("Config") if isinstance(backend, Mapping) else None
    backend_labels = backend_config.get("Labels") if isinstance(backend_config, Mapping) else None
    services = document.get("services") if isinstance(document, Mapping) else None
    backend_service = services.get("backend") if isinstance(services, Mapping) else None
    backend_environment = (backend_service.get("environment")
                           if isinstance(backend_service, Mapping) else None)
    frontend_service = services.get("frontend") if isinstance(services, Mapping) else None
    frontend_environment = (frontend_service.get("environment")
                           if isinstance(frontend_service, Mapping) else None)
    input_manifest_commit = (frontend_environment.get("FULLMAG_SOURCE_COMMIT")
                             if isinstance(frontend_environment, Mapping) else None)
    if (not isinstance(attempt, str) or _ATTEMPT.fullmatch(attempt) is None
            or not isinstance(backend_id, str) or _CONTAINER.fullmatch(backend_id) is None
            or not isinstance(backend_started_at, str) or not backend_started_at
            or not isinstance(backend, Mapping) or backend.get("Id") != backend_id
            or not isinstance(backend_state, Mapping) or backend_state.get("Running") is not True
            or backend_state.get("StartedAt") != backend_started_at
            or not isinstance(backend_health, Mapping) or backend_health.get("Status") != "healthy"
            or not isinstance(backend_labels, Mapping)
            or backend_labels.get("com.docker.compose.project") != control.project
            or backend_labels.get("com.docker.compose.service") != "backend"
            or not isinstance(backend_service, Mapping)
            or not isinstance(backend_service.get("image"), str)
            or backend.get("Image") != backend_service.get("image")
            or previous.get("compose_project") != control.project
            or previous.get("control_volume") != control.volume):
        _fail("Failed-seed backend container/configuration is not the retained healthy incarnation")
    if (not isinstance(input_manifest_commit, str)
            or _COMMIT.fullmatch(input_manifest_commit) is None
            or not isinstance(previous_inputs, Mapping)
            or previous_inputs.get("source_commit") != input_manifest_commit):
        _fail("Failed-seed frontend Compose commit differs from its retained input manifest")

    root = "development/attempts/" + attempt
    saved_receipt_raw = control.read_bytes(root + "/backend-build-receipt.json", optional=True)
    saved_provenance_raw = control.read_bytes(root + "/provenance.json", optional=True)
    if not isinstance(saved_receipt_raw, bytes) or not isinstance(saved_provenance_raw, bytes):
        _fail("Failed-seed attempt has no saved backend package/provenance proof")
    try:
        saved_receipt = json.loads(saved_receipt_raw)
        saved_provenance = json.loads(saved_provenance_raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Failed-seed saved backend package/provenance is malformed") from error
    if (not isinstance(saved_receipt, Mapping) or not isinstance(saved_provenance, Mapping)
            or canonical(saved_receipt) + b"\n" != saved_receipt_raw
            or canonical(saved_provenance) + b"\n" != saved_provenance_raw):
        _fail("Failed-seed saved backend package/provenance is not canonical")

    try:
        live_receipt, live_provenance, receipt_sha256, provenance_and_binary = codegen._backend_documents(backend_id)
        backend_source, provenance_sha256, binary_sha256 = codegen._validate_backend(
            live_receipt, live_provenance, receipt_sha256, provenance_and_binary)
    except codegen.CodegenError as error:
        if error.reconciliation_required:
            from docker_build_control import ControlOutcomeUnknown
            raise ControlOutcomeUnknown(
                "Failed-seed live backend package/provenance observation is unknown") from error
        raise BuildControlError("Failed-seed live backend package/provenance is not verified") from error
    if (saved_receipt != live_receipt or saved_provenance != live_provenance
            or hashlib.sha256(saved_receipt_raw).hexdigest() != receipt_sha256
            or hashlib.sha256(saved_provenance_raw).hexdigest() != provenance_sha256):
        _fail("Failed-seed saved package/provenance differs from the retained live backend")
    backend_app_commit = backend_source.get("commit") if isinstance(backend_source, Mapping) else None
    if (not isinstance(backend_app_commit, str) or _COMMIT.fullmatch(backend_app_commit) is None
            or (isinstance(backend_environment, Mapping)
                and "FULLMAG_SOURCE_COMMIT" in backend_environment
                and backend_environment.get("FULLMAG_SOURCE_COMMIT") != backend_app_commit)):
        _fail("Failed-seed live backend source commit differs from its retained configuration")
    for field in ("source_commit", "backend_app_commit"):
        if field in previous and previous.get(field) != backend_app_commit:
            _fail("Failed-seed optional backend finish pin differs from the live package")
    if ("frontend_input_commit" in previous
            and previous.get("frontend_input_commit") != input_manifest_commit):
        _fail("Failed-seed optional frontend finish pin differs from retained Compose")
    return {
        "backend_app_commit": backend_app_commit,
        "input_manifest_commit": input_manifest_commit,
        "backend_receipt_sha256": receipt_sha256,
        "backend_provenance_sha256": provenance_sha256,
        "backend_binary_sha256": binary_sha256,
        "backend_container_id": backend_id,
        "backend_started_at": backend_started_at,
    }


def validate_live_backend_pins(source_pins: Mapping[str, object],
                               backend_source: Mapping[str, object], *,
                               receipt_sha256: str, provenance_sha256: str,
                               binary_sha256: str) -> None:
    """Recheck the captured package, provenance, and binary before publication."""
    if (not isinstance(source_pins, Mapping) or not isinstance(backend_source, Mapping)
            or source_pins.get("backend_app_commit") != backend_source.get("commit")
            or source_pins.get("backend_receipt_sha256") != receipt_sha256
            or source_pins.get("backend_provenance_sha256") != provenance_sha256
            or source_pins.get("backend_binary_sha256") != binary_sha256):
        _fail("Retained frontend seed recovery backend package/provenance changed")


def _validate_failed_seed_identity(previous: Mapping[str, object], frontend: Mapping[str, object],
                                   log: bytes, seed_bytes: bytes, *, expected_attempt: str) -> dict[str, object]:
    if (previous.get("schema") != "fullmag.docker-build-operation.v1"
            or previous.get("phase") != "development"
            or previous.get("state") != "failed-confirmed"
            or previous.get("error") != "DEV service exited before readiness: frontend"
            or not isinstance(previous.get("attempt"), str)
            or _ATTEMPT.fullmatch(previous["attempt"]) is None
            or not isinstance(expected_attempt, str)
            or _ATTEMPT.fullmatch(expected_attempt) is None
            or previous.get("attempt") != expected_attempt):
        _fail("Failed-seed recovery requires the exact failed-confirmed development attempt")
    if (not isinstance(frontend.get("Id"), str)
            or _CONTAINER.fullmatch(frontend["Id"]) is None
            or frontend.get("Id") != previous.get("frontend_container")):
        _fail("Failed-seed frontend container differs from the terminal receipt")
    state = frontend.get("State")
    if (not isinstance(state, Mapping)
            or state.get("Status") != "exited" or state.get("Running") is not False
            or type(state.get("Pid")) is not int or state["Pid"] != 0
            or type(state.get("ExitCode")) is not int or state["ExitCode"] != 1
            or state.get("OOMKilled") is not False or state.get("Dead") is not False
            or state.get("Restarting") is not False or state.get("Paused") is not False
            or state.get("Error") not in (None, "")
            or not isinstance(state.get("StartedAt"), str) or not state["StartedAt"]
            or not isinstance(state.get("FinishedAt"), str) or not state["FinishedAt"]):
        _fail("Failed-seed frontend is not the exact exited-1, process-free container")
    if (not isinstance(log, bytes) or len(log) > MAX_DOCUMENT_BYTES
            or not log.decode("utf-8", "replace").rstrip().endswith(ERROR_SUFFIX)):
        _fail("Failed-seed frontend log does not end at the exact next-env hash refusal")
    if not isinstance(seed_bytes, bytes) or seed_bytes != b"":
        _fail("Failed-seed private next-env file is not the exact zero-byte observation")
    return {
        "attempt": previous["attempt"],
        "frontend_container_id": frontend["Id"],
        "frontend_state_sha256": hashlib.sha256(canonical(dict(state))).hexdigest(),
        "frontend_log_sha256": hashlib.sha256(log).hexdigest(),
        "old_seed_sha256": hashlib.sha256(seed_bytes).hexdigest(),
        "frontend_started_at": state["StartedAt"],
        "frontend_finished_at": state["FinishedAt"],
    }


def validate_failed_seed(previous: Mapping[str, object], frontend: Mapping[str, object],
                         log: bytes, seed_bytes: bytes, *, expected_attempt: str, freeze_exists: bool,
                         frozen_root_exists: bool) -> dict[str, object]:
    """Admit only the precise failed seed with no durable freeze artifacts."""
    if type(freeze_exists) is not bool or type(frozen_root_exists) is not bool:
        _fail("Failed-seed freeze observation is incomplete")
    if freeze_exists or frozen_root_exists:
        _fail("Failed-seed recovery refuses an existing or partial freeze")
    evidence = _validate_failed_seed_identity(
        previous, frontend, log, seed_bytes, expected_attempt=expected_attempt)
    evidence.update(inputs_freeze_absent=True, frozen_root_absent=True)
    return evidence


def validate_backend_anchor(before: Mapping[str, object], after: Mapping[str, object]) -> dict[str, object]:
    """Compare stable backend ownership/process identity, excluding telemetry."""
    if not isinstance(before, Mapping) or not isinstance(after, Mapping):
        _fail("Frontend refresh backend anchor is malformed")
    for label, value in (("before", before), ("after", after)):
        if any(key not in value for key in _BACKEND_ANCHOR_FIELDS):
            _fail("Frontend refresh backend anchor omits stable identity fields: " + label)
        if (_CONTAINER.fullmatch(value["container_id"]) is None
                or not isinstance(value["started_at"], str) or not value["started_at"]
                or type(value["container_pid"]) is not int or value["container_pid"] <= 0
                or not isinstance(value["fingerprint"], str)
                or _SHA256.fullmatch(value["fingerprint"]) is None
                or not isinstance(value["owner_token"], str)
                or _ATTEMPT.fullmatch(value["owner_token"]) is None
                or not isinstance(value["owner_start_token"], str) or not value["owner_start_token"]
                or not isinstance(value["state"], Mapping)
                or value["state"].get("running") is not True
                or value["state"].get("health") != "healthy"
                or not isinstance(value["certificate_identity"], Mapping)
                or not value["certificate_identity"]
                or not isinstance(value["processes"], list) or not value["processes"]
                or not isinstance(value["api_instance_id"], str) or not value["api_instance_id"]
                or value["active_session"] is not False):
            _fail("Frontend refresh backend anchor is not a healthy idle owned process")
    stable_before = {key: before[key] for key in _BACKEND_ANCHOR_FIELDS}
    stable_after = {key: after[key] for key in _BACKEND_ANCHOR_FIELDS}
    if stable_before != stable_after:
        _fail("Backend stable process/owner anchor changed during frontend refresh")
    return dict(before)


def _generation_mount(compose: Mapping[str, object], control, expected_subpath: str):
    services = compose.get("services")
    frontend = services.get("frontend") if isinstance(services, Mapping) else None
    mounts = frontend.get("volumes") if isinstance(frontend, Mapping) else None
    selected = [mount for mount in mounts if isinstance(mount, Mapping)
                and mount.get("target") == "/state/development"] if isinstance(mounts, list) else []
    if len(selected) != 1:
        _fail("Retained frontend development mount is missing or ambiguous")
    mount = selected[0]
    volumes = compose.get("volumes")
    declaration = volumes.get("frontend-build") if isinstance(volumes, Mapping) else None
    options = mount.get("volume")
    if (mount.get("type") != "volume" or mount.get("source") != "frontend-build"
            or not isinstance(options, Mapping) or options.get("subpath") != expected_subpath
            or not isinstance(declaration, Mapping) or declaration.get("name") != control.volume
            or declaration.get("external") is not True):
        _fail("Retained frontend Compose subpath/volume identity differs")
    return mount


def resolve_active_generation(control, previous: Mapping[str, object],
                              compose: Mapping[str, object]) -> dict[str, object]:
    """Resolve legacy or generation-backed frontend state from receipt + Compose."""
    import docker_group_storage as group_storage

    if (not isinstance(previous, Mapping)
            or previous.get("private_group_storage") != "group-volume-v1"
            or previous.get("frontend_volume") != control.volume
            or previous.get("compose_project") != control.project):
        _fail("Frontend generation is not bound to the selected private group")
    generation_id = previous.get("frontend_generation_id")
    generation_path = previous.get("frontend_generation_subpath")
    if generation_id is None and generation_path is None:
        expected = group_storage.role_subpath(control, "frontend")
    elif generation_id is None or generation_path is None:
        _fail("Retained frontend generation ID/path pair is incomplete")
    else:
        expected = group_storage.frontend_generation_subpath(control, generation_id)
        if generation_path != expected:
            _fail("Retained frontend generation path differs from its authenticated ID")
    _generation_mount(compose, control, expected)
    return {"generation_id": generation_id, "subpath": expected}


def generation_receipt_fields(control, previous: Mapping[str, object],
                              compose: Mapping[str, object]) -> dict[str, object]:
    """Return only generation pins authenticated by the retained Compose receipt."""
    active = resolve_active_generation(control, previous, compose)
    if active["generation_id"] is None:
        return {}
    return {
        "frontend_generation_id": active["generation_id"],
        "frontend_generation_subpath": active["subpath"],
    }


def validate_generation_probe(probe: Mapping[str, object], *, generation_id: str,
                              old_generation_id: str | None, old_seed_sha256: str) -> dict[str, object]:
    if not isinstance(probe, Mapping) or set(probe) != {
            "mode", "generation_id", "old_generation_id", "old_seed_sha256",
            "inputs_freeze_absent", "frozen_root_absent"}:
        _fail("Frontend generation probe fields differ")
    if (probe.get("mode") != "created"
            or probe.get("generation_id") != generation_id
            or probe.get("old_generation_id") != old_generation_id
            or probe.get("old_seed_sha256") != old_seed_sha256
            or _SHA256.fullmatch(str(probe.get("old_seed_sha256", ""))) is None
            or probe.get("inputs_freeze_absent") is not True
            or probe.get("frozen_root_absent") is not True):
        _fail("Frontend generation probe does not attest the exact old-state absence and seed")
    return dict(probe)


def stage_and_publish_generation(control, operation: Mapping[str, object], *,
                                 guard_prior_consumers, stage_generation,
                                 guard_consumers, revalidate_prior,
                                 compose_apply) -> dict[str, object]:
    """Fence old consumers, seed, re-fence, CAS, publish, then Compose."""
    if (not isinstance(operation, Mapping) or not isinstance(operation.get("root"), str)
            or not callable(guard_prior_consumers) or not callable(stage_generation)
            or not callable(guard_consumers) or not callable(revalidate_prior)
            or not callable(compose_apply)):
        _fail("Frontend generation operation is malformed")
    guard_prior_consumers()
    staged = stage_generation()
    if (not isinstance(staged, Mapping) or set(staged) != {"inputs", "compose", "volume"}
            or not isinstance(staged.get("inputs"), Mapping)
            or not isinstance(staged.get("compose"), Mapping)
            or not isinstance(staged.get("volume"), str)):
        _fail("Staged frontend generation output is malformed")
    generation_id = operation.get("receipt", {}).get("frontend_generation_id")
    generation_path = operation.get("receipt", {}).get("frontend_generation_subpath")
    if (not isinstance(generation_id, str) or _ATTEMPT.fullmatch(generation_id) is None
            or not isinstance(generation_path, str)):
        _fail("Frontend generation publication has no exact new generation receipt")
    import docker_group_storage as group_storage
    expected = group_storage.frontend_generation_subpath(control, generation_id)
    if generation_path != expected:
        _fail("Frontend generation publication path differs from its receipt ID")
    _generation_mount(staged["compose"], control, expected)
    guard_consumers(staged)
    revalidate_prior(staged)
    control.write(operation["root"] + "/compose.json", dict(staged["compose"]))
    control.write("frontend/development-inputs.json", dict(staged["inputs"]))
    compose_apply(staged["compose"])
    return dict(staged)


def assert_group_local_consumers(control, backend, frontend, compose) -> None:
    """Run the v6 metadata-only consumer fence for this selected Linux group."""
    import docker_volume_container_recovery as recovery

    recovery._assert_no_foreign_storage_consumers(
        control, backend, frontend, compose,
        consumer_scope=recovery.GROUP_LOCAL_DIRECT_BINDS_SCOPE,
    )


def read_stopped_container_file(identifier: str, path: str, *, maximum=16 * 1024 * 1024) -> bytes:
    """Read one bounded regular file from the exact stopped container archive."""
    if _CONTAINER.fullmatch(identifier) is None or not path.startswith("/") or ".." in path.split("/"):
        _fail("Stopped frontend file identity/path is invalid")
    result = docker_capture("cp", identifier + ":" + path, "-")
    if len(result.stdout) > maximum + 64 * 1024:
        _fail("Stopped frontend file archive exceeds its bound")
    try:
        with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
            members = archive.getmembers()
            if len(members) != 1 or not members[0].isfile() or members[0].size > maximum:
                _fail("Stopped frontend seed is not one bounded regular file")
            stream = archive.extractfile(members[0])
            if stream is None:
                _fail("Stopped frontend seed archive has no file payload")
            data = stream.read(maximum + 1)
    except (tarfile.TarError, OSError) as error:
        raise BuildControlError("Stopped frontend seed archive is malformed") from error
    if len(data) > maximum or len(data) != members[0].size:
        _fail("Stopped frontend seed file size differs from its archive header")
    return data


def refresh_context(control, args, previous, document, actual, selected) -> dict[str, object]:
    """Build a repeatable read-only proof before and under the managed lease."""
    from docker_volume_reconcile import digest
    from docker_development_inputs import seed

    attempt = getattr(args, "attempt", None)
    config_sha256 = getattr(args, "config_sha256", None)
    if (not isinstance(attempt, str) or _ATTEMPT.fullmatch(attempt) is None
            or not isinstance(config_sha256, str) or _SHA256.fullmatch(config_sha256) is None):
        _fail("Failed-seed refresh requires exact prior attempt/config pins")
    root = "development/attempts/" + attempt
    terminal_raw = control.read_bytes(root + "/terminal.json")
    current_raw = control.read_bytes("development/current.json")
    verified_raw = control.read_bytes("development/verified.json", optional=True)
    compose_raw = control.read_bytes(root + "/compose.json")
    try:
        terminal = json.loads(terminal_raw)
        current = json.loads(current_raw)
        recorded_compose = json.loads(compose_raw)
        verified = json.loads(verified_raw) if verified_raw is not None else None
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Failed-seed retained control record is malformed") from error
    if (canonical(terminal) + b"\n" != terminal_raw or current_raw != terminal_raw
            or terminal != previous or terminal.get("attempt") != attempt
            or terminal.get("compose_project") != control.project
            or terminal.get("control_volume") != control.volume
            or terminal.get("config_sha256") != config_sha256
            or hashlib.sha256(canonical(recorded_compose)).hexdigest() != config_sha256
            or recorded_compose != document):
        _fail("Failed-seed terminal/current/Compose CAS differs")
    if verified is not None and (
            not isinstance(verified, Mapping)
            or verified.get("schema") != "fullmag.docker-build-operation.v1"
            or verified.get("state") != "succeeded"
            or verified.get("phase") != "development"
            or verified.get("compose_project") != control.project
            or verified.get("control_volume") != control.volume):
        _fail("Prior verified development authority is malformed or foreign")
    active_generation = resolve_active_generation(control, previous, document)
    mounts = [mount for mount in actual["frontend"].get("Mounts", [])
              if isinstance(mount, Mapping) and mount.get("Destination") == "/state/development"]
    if (len(mounts) != 1 or mounts[0].get("Type") != "volume"
            or mounts[0].get("Name") != control.volume or mounts[0].get("RW") is not True):
        _fail("Failed-seed stopped frontend has a different private group mount")
    host_mounts = actual["frontend"].get("HostConfig", {}).get("Mounts")
    host_mounts = [mount for mount in host_mounts if isinstance(mount, Mapping)
                   and mount.get("Target") == "/state/development"] if isinstance(host_mounts, list) else []
    if (len(host_mounts) != 1 or host_mounts[0].get("Type") != "volume"
            or host_mounts[0].get("Source") != control.volume
            or host_mounts[0].get("ReadOnly", False) is not False
            or not isinstance(host_mounts[0].get("VolumeOptions"), Mapping)
            or host_mounts[0]["VolumeOptions"].get("Subpath") != active_generation["subpath"]):
        _fail("Failed-seed stopped frontend subpath differs from its Compose generation")
    log_result = docker_capture("logs", "--since", actual["frontend"]["State"]["StartedAt"],
                                actual["frontend"]["Id"])
    log = log_result.stdout + log_result.stderr
    seed_bytes = read_stopped_container_file(actual["frontend"]["Id"], SEED_PATH)

    input_raw = control.read_bytes("frontend/development-inputs.json")
    try:
        previous_inputs = json.loads(input_raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Failed-seed prior input manifest is malformed") from error
    seeded_files = []
    state_root = Path(previous.get("state_root", ""))
    current_inputs = seed(selected, state_root, int(args.port), write_file=lambda relative, data: seeded_files.append({
        "relative": relative, "data": base64.b64encode(data).decode("ascii")}))
    selected_bytes = {item["relative"]: base64.b64decode(item["data"], validate=True)
                      for item in seeded_files}
    if canonical(previous_inputs) + b"\n" != input_raw:
        _fail("Failed-seed prior input manifest is not its canonical retained document")
    backend_pins = authenticated_source_pins(control, previous, document, actual, previous_inputs)
    pins = validate_seed_manifest(
        previous_inputs, current_inputs,
        backend_app_commit=backend_pins["backend_app_commit"],
        expected_backend_app_commit=backend_pins["backend_app_commit"],
        input_manifest_commit=backend_pins["input_manifest_commit"],
        controller_commit=current_inputs.get("source_commit"),
        selected_seed_bytes=selected_bytes,
    )
    pins.update(backend_pins)
    failure_identity = _validate_failed_seed_identity(
        previous, actual["frontend"], log, seed_bytes, expected_attempt=attempt)
    helper_paths = (
        "docker_dev.py", "docker_volume_dev.py", "docker_group_storage.py",
        "docker_volume_frontend_seed_recovery.py", "docker_volume_container_recovery.py",
        "docker_build_control.py", "docker_development_inputs.py", "docker_dev_codegen.py",
    )
    helper_hashes = {name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest()
                     for name in helper_paths}
    return {
        "schema": SCHEMA,
        "attempt": attempt,
        "config_sha256": config_sha256,
        "terminal_sha256": digest(terminal_raw),
        "current_sha256": digest(current_raw),
        "verified_sha256": digest(verified_raw) if verified_raw is not None else None,
        "compose_sha256": digest(compose_raw),
        "input_manifest_sha256": digest(input_raw),
        "failure_identity": failure_identity,
        "source_pins": pins,
        "active_generation": active_generation,
        "controller_source_sha256": hashlib.sha256(canonical(helper_hashes)).hexdigest(),
        "current_inputs": current_inputs,
        "selected_seed_bytes": selected_bytes,
        "frontend_log": log,
        "old_seed_bytes": seed_bytes,
    }


def revalidate_context(control, args, previous, document, actual, selected, expected) -> dict[str, object]:
    observed = refresh_context(control, args, previous, document, actual, selected)
    comparable = {key: value for key, value in expected.items()
                  if key not in {"current_inputs", "selected_seed_bytes", "frontend_log", "old_seed_bytes"}}
    current = {key: value for key, value in observed.items() if key in comparable}
    if current != comparable:
        _fail("Failed-seed proof changed under the managed operation lease")
    for key in ("current_inputs", "selected_seed_bytes", "frontend_log", "old_seed_bytes"):
        if observed[key] != expected[key]:
            _fail("Failed-seed source or stopped evidence changed under the managed operation lease")
    return observed


def backend_anchor(actual: Mapping[str, object], fingerprint: str, certificate: Mapping[str, object],
                   observation: Mapping[str, object]) -> dict[str, object]:
    state = actual.get("State")
    processes = observation.get("processes")
    api = [row for row in processes if isinstance(row, Mapping)
           and Path(str(row.get("executable", ""))).name == "fullmag-api"] if isinstance(processes, list) else []
    if len(api) != 1:
        _fail("Frontend refresh backend observation has no unique API process")
    process = api[0]
    certificate_identity = {key: certificate.get(key) for key in (
        "schema", "storage_profile", "role", "owner_scope", "host_root", "host_filesystem",
        "host_inode", "engine_id", "owner_token", "image_id", "source_commit", "binary_hashes",
        "artifact_receipt_sha256", "restart_expected_sha256", "restart_verified",
    ) if key in certificate}
    return {
        "container_id": actual.get("Id"),
        "started_at": state.get("StartedAt") if isinstance(state, Mapping) else None,
        "container_pid": state.get("Pid") if isinstance(state, Mapping) else None,
        "fingerprint": fingerprint,
        "owner_token": certificate.get("owner_token"),
        "owner_start_token": str(process.get("start_ticks", "")),
        "state": {
            "running": state.get("Running") if isinstance(state, Mapping) else None,
            "health": state.get("Health", {}).get("Status") if isinstance(state, Mapping) else None,
        },
        "certificate_identity": certificate_identity,
        "processes": processes,
        "api_instance_id": observation.get("api_instance_id"),
        "active_session": observation.get("active_session"),
    }
