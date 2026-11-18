"""Archive prior native runtime and private-ledger roots for a fresh start.

This runs only inside the already-admitted ``recreate-services`` operation,
after its exact application containers have been removed.  It never edits
records in the old runtime tree; the whole directory is moved atomically into
the control volume's archive area before an empty replacement is created.
"""
from __future__ import annotations

from collections.abc import Mapping
import hashlib
import json
import re
import shlex
from pathlib import Path
import time

from docker_build_control import (
    BuildControl, BuildControlError, bounded_capture, canonical, docker_capture,
)
from docker_compose_identity import source_labels


_OPERATION_ID = re.compile(r"[0-9a-f]{32}\Z")
_CONTAINER_ID = re.compile(r"[0-9a-f]{64}\Z")
_ABSENT_CONTAINER = re.compile(
    r"(?:no such object|no such container):\s*([0-9a-f]{64})(?:\s|$)",
    re.IGNORECASE,
)
_PRIVATE_LEDGER = re.compile(r"(?:namespaces/[0-9a-f]{32}/)?private/ledger\Z")
_DEVICE_INODE = re.compile(r"[0-9]+:[0-9]+\Z")


def _fail(message: str) -> None:
    raise BuildControlError(message)


def _expected_private_ledger_subpath(control) -> str:
    namespace = getattr(control, "namespace", "")
    return "/".join(part for part in (namespace, "private/ledger") if part)


def pinned_group_archive(control, generation):
    """Read the exact archive backing a ledger generation, without changing it."""
    if (not isinstance(generation, Mapping)
            or generation.get("schema") != "fullmag.docker-group-ledger-generation.v1"
            or generation.get("compose_project") != control.project
            or not _OPERATION_ID.fullmatch(str(generation.get("generation", "")))):
        _fail("Fresh group ledger generation is malformed")
    token = generation["generation"]
    path = "recreate-services/attempts/" + token + "/runtime-control-archive-terminal.json"
    if generation.get("archive_terminal_path") != path:
        _fail("Fresh ledger generation has another archive path")
    archive = control.read(path)
    if (not isinstance(archive, Mapping) or archive.get("state") != "succeeded"
            or archive.get("operation_attempt") != token
            or archive.get("compose_project") != control.project
            or archive.get("preserved_group_ledger_volume") != generation.get("preserved_volume")
            or hashlib.sha256(canonical(archive)).hexdigest() != generation.get("archive_terminal_sha256")):
        _fail("Fresh ledger generation has no exact completed runtime archive")
    subpath = archive.get("preserved_group_ledger_subpath")
    if subpath is not None:
        if (not isinstance(subpath, str) or _PRIVATE_LEDGER.fullmatch(subpath) is None
                or subpath != _expected_private_ledger_subpath(control)
                or archive.get("preserved_group_ledger_volume") != control.volume
                or generation.get("preserved_subpath") != subpath
                or generation.get("archived_group_ledger_path")
                    != "runtime-archives/" + token + "/group-ledger"
                or archive.get("mapping") != _archive_mapping(token, private_ledger=True)
                or not _DEVICE_INODE.fullmatch(str(archive.get("preserved_runtime_control_device_inode", "")))
                or archive.get("archived_runtime_control_device_inode")
                    != archive.get("preserved_runtime_control_device_inode")
                or not _DEVICE_INODE.fullmatch(str(archive.get("fresh_runtime_control_device_inode", "")))
                or archive.get("fresh_runtime_control_device_inode")
                    == archive.get("preserved_runtime_control_device_inode")
                or not _DEVICE_INODE.fullmatch(str(archive.get("fresh_runtime_services_device_inode", "")))
                or archive.get("fresh_runtime_services_device_inode")
                    == archive.get("fresh_runtime_control_device_inode")
                or not _DEVICE_INODE.fullmatch(str(archive.get("preserved_group_ledger_device_inode", "")))
                or re.fullmatch(r"[0-9]+:[0-9]+", str(archive.get("preserved_group_ledger_owner", ""))) is None
                or re.fullmatch(r"[0-7]{3,4}", str(archive.get("preserved_group_ledger_mode", ""))) is None
                or archive.get("archived_group_ledger_device_inode")
                    != archive.get("preserved_group_ledger_device_inode")
                or archive.get("archived_group_ledger_owner")
                    != archive.get("preserved_group_ledger_owner")
                or archive.get("archived_group_ledger_mode")
                    != archive.get("preserved_group_ledger_mode")
                or not _DEVICE_INODE.fullmatch(str(archive.get("preserved_group_ledger_role_device_inode", "")))
                or archive.get("fresh_group_ledger_role_device_inode")
                    != archive.get("preserved_group_ledger_role_device_inode")
                or archive.get("preserved_group_ledger_role_owner") != "65532:65532"
                or archive.get("fresh_group_ledger_role_owner") != "65532:65532"
                or archive.get("preserved_group_ledger_role_mode") != "750"
                or archive.get("fresh_group_ledger_role_mode") != "750"
                or not _DEVICE_INODE.fullmatch(str(archive.get("fresh_group_ledger_device_inode", "")))
                or archive.get("fresh_group_ledger_device_inode")
                    == archive.get("preserved_group_ledger_device_inode")
                or archive.get("fresh_group_ledger_owner") != "65532:65532"):
            _fail("Fresh private group ledger archive binding is malformed")
    elif "preserved_subpath" in generation or "archived_group_ledger_path" in generation:
        _fail("Legacy group ledger generation has private archive bindings")
    return archive


def _archive_mapping(token: str, *, private_ledger: bool) -> dict[str, str]:
    mapping = {
        "previous_runtime_control": "runtime-control",
        "archived_runtime_control": "runtime-archives/" + token,
        "fresh_runtime_control": "runtime-control",
        "fresh_runtime_services": "runtime-control/runtime-services",
    }
    if private_ledger:
        mapping.update({
            "preserved_group_ledger_role": "private/ledger",
            "previous_group_ledger": "private/ledger/ledger",
            "archived_group_ledger": "runtime-archives/" + token + "/group-ledger",
            "fresh_group_ledger": "private/ledger/ledger",
        })
    return mapping


def _retained_group_ledger_binding(control, operation, retained_pair):
    """Authenticate the prior backend's group ledger and its private role path."""
    receipt = operation.get("receipt") if isinstance(operation, Mapping) else None
    inputs = receipt.get("inputs") if isinstance(receipt, Mapping) else None
    attempt = inputs.get("attempt") if isinstance(inputs, Mapping) else None
    config_sha = inputs.get("config_sha256") if isinstance(inputs, Mapping) else None
    if (not isinstance(attempt, str) or _OPERATION_ID.fullmatch(attempt) is None
            or not isinstance(config_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", config_sha)):
        _fail("Fresh-runtime archive has no pinned prior Compose render")
    previous_root = "development/attempts/" + attempt
    previous = control.read(previous_root + "/terminal.json")
    compose = control.read(previous_root + "/compose.json")
    previous_inputs = previous.get("inputs") if isinstance(previous, Mapping) else None
    if (not isinstance(previous, Mapping) or previous.get("schema") != "fullmag.docker-build-operation.v1"
            or previous.get("phase") != "development"
            or previous.get("state") not in {"succeeded", "failed-confirmed"}
            or previous.get("attempt") != attempt
            or previous.get("compose_project") != control.project
            or previous.get("control_volume") != control.volume
            or previous.get("control_namespace", "") != control.namespace
            or not isinstance(previous_inputs, Mapping)
            or previous_inputs.get("source_root") != control.identity.get("source_root")
            or any(previous_inputs.get(source_key) != control.identity.get(identity_key)
                   for source_key, identity_key in (
                       ("source_project_id", "project_id"),
                       ("source_worktree_id", "worktree_id"),
                       ("source_checkout_kind", "checkout_kind"),
                   ))
            or not isinstance(compose, Mapping) or compose.get("name") != control.project
            or hashlib.sha256(canonical(compose)).hexdigest() != config_sha):
        _fail("Fresh-runtime archive prior Compose render differs from its durable pin")

    backend = retained_pair.get("backend") if isinstance(retained_pair, Mapping) else None
    if not isinstance(backend, Mapping):
        _fail("Fresh-runtime archive has no retained backend ledger evidence")
    backend_image = backend.get("Image")
    if (not isinstance(backend_image, str) or not isinstance(previous_inputs, Mapping)
            or backend_image != previous_inputs.get("image_id")):
        _fail("Fresh-runtime archive retained backend image differs from its prior terminal")

    import docker_group_ledger as group_ledger
    try:
        expected = group_ledger.retained_profile(compose, backend_image)
    except group_ledger.GroupLedgerError as error:
        raise BuildControlError(str(error)) from error
    ledger_record = control.read(previous_root + "/group-ledger.json")
    if (not isinstance(ledger_record, Mapping)
            or ledger_record.get("schema") != "fullmag.docker-group-ledger.v1"
            or ledger_record.get("profile") != group_ledger.PROFILE
            or ledger_record.get("daemon_id_sha256")
                != expected["environment"].get("FULLMAG_DOCKER_HOST_ID")
            or ledger_record.get("compose_project") != control.project
            or ledger_record.get("volume_name") != expected.get("volume_name")
            or ledger_record.get("host_id") != expected["environment"].get(group_ledger.HOST_ID_ENV)):
        _fail("Fresh-runtime archive group-ledger record differs from the retained Compose render")

    config = backend.get("Config")
    environment = group_ledger._env_map(config) if isinstance(config, Mapping) else {}
    host_config = backend.get("HostConfig")
    if (not isinstance(config, Mapping) or config.get("User") != "65532:65532"
            or not isinstance(host_config, Mapping) or host_config.get("Privileged") is True
            or any(environment.get(key) != value for key, value in expected["environment"].items())):
        _fail("Fresh-runtime archive retained backend group-ledger environment differs")
    if group_ledger.GLOBAL_ONLY_ENVIRONMENT & set(environment):
        _fail("Fresh-runtime archive retained backend leaks global host-ledger settings")
    mounts = [mount for mount in backend.get("Mounts", []) or []
              if isinstance(mount, Mapping) and mount.get("Destination") == group_ledger.MOUNT_TARGET]
    if (len(mounts) != 1 or mounts[0].get("Type") != "volume"
            or mounts[0].get("RW") is not True
            or mounts[0].get("Name") != expected["volume_name"]):
        _fail("Fresh-runtime archive retained backend ledger mount differs")

    subpath = expected.get("ledger_subpath", "")
    if subpath:
        import docker_group_storage as group_storage
        expected_subpath = group_storage.role_subpath(control, "ledger")
        if (expected["volume_name"] != control.volume or subpath != expected_subpath
                or environment.get(group_ledger.PRIVATE_GROUP_STORAGE_ENV)
                    != group_ledger.PRIVATE_GROUP_STORAGE):
            _fail("Fresh-runtime archive private ledger is not this control volume's ledger role")
        try:
            group_ledger._attest_private_subpath(
                backend, mounts[0], expected, subpath,
                lambda *args: docker_capture(*args, timeout=60).stdout,
            )
        except group_ledger.GroupLedgerError as error:
            raise BuildControlError(str(error)) from error
        relative = subpath[len(control.namespace) + 1:] if control.namespace else subpath
        if relative != "private/ledger":
            _fail("Fresh-runtime archive private ledger control-relative path is not canonical")
        return {
            "volume_name": expected["volume_name"],
            "private": True,
            "subpath": subpath,
            "control_role_path": relative,
            "control_leaf_path": relative + "/ledger",
        }
    if expected["volume_name"] == control.volume:
        _fail("Fresh-runtime archive legacy ledger unexpectedly shares the control volume")
    return {"volume_name": expected["volume_name"], "private": False, "subpath": "",
            "control_role_path": "", "control_leaf_path": ""}


def _archive_preflight(helper_id: str, private_ledger_role_path: str | None) -> dict[str, str]:
    ledger_checks = ""
    ledger_output = '"-" "-" "-" "-" "-" "-"'
    if private_ledger_role_path is not None:
        if private_ledger_role_path != "private/ledger":
            _fail("Fresh-runtime archive private ledger role path is invalid")
        ledger_checks = r'''test ! -L /control/private
test -d /control/private
test "$(readlink -f /control/private)" = /control/private
role=/control/private/ledger
ledger="$role/ledger"
test ! -L "$role"
test -d "$role"
test "$(readlink -f "$role")" = "$role"
test "$(stat -c '%u:%g' "$role")" = 65532:65532
test "$(stat -c '%a' "$role")" = 750
test "$(stat -c %d "$role")" = "$(stat -c %d "$ledger")"
test "$(find "$role" -mindepth 1 -maxdepth 1 -print)" = "$ledger"
test ! -L "$ledger"
test -d "$ledger"
test "$(readlink -f "$ledger")" = "$ledger"
role_inode=$(stat -c '%d:%i' "$role")
ledger_inode=$(stat -c '%d:%i' "$ledger")
ledger_owner=$(stat -c '%u:%g' "$ledger")
ledger_mode=$(stat -c '%a' "$ledger")
role_owner=$(stat -c '%u:%g' "$role")
role_mode=$(stat -c '%a' "$role")'''
        ledger_output = '"$role_inode" "$role_owner" "$role_mode" "$ledger_inode" "$ledger_owner" "$ledger_mode"'
    script = r'''set -euo pipefail
old=/control/runtime-control
test ! -L /control
test "$(readlink -f /control)" = /control
test ! -L "$old"
test -d "$old"
test "$(readlink -f "$old")" = "$old"
runtime_inode=$(stat -c '%d:%i' "$old")
LEDGER_CHECKS
printf 'PREFLIGHT\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$runtime_inode" LEDGER_OUTPUT'''
    script = script.replace("LEDGER_CHECKS", ledger_checks).replace("LEDGER_OUTPUT", ledger_output)
    result = docker_capture(
        "exec", helper_id, "/bin/bash", "-euo", "pipefail", "-c", script, timeout=60,
    )
    lines = result.stdout.decode("ascii", "strict").splitlines()
    if len(lines) != 1:
        _fail("Fresh-runtime archive preflight returned an ambiguous directory receipt")
    fields = lines[0].split("\t")
    if len(fields) != 8 or fields[0] != "PREFLIGHT" or not _DEVICE_INODE.fullmatch(fields[1]):
        _fail("Fresh-runtime archive preflight returned malformed inode evidence")
    if private_ledger_role_path is None:
        if fields[2:] != ["-", "-", "-", "-", "-", "-"]:
            _fail("Legacy ledger archive preflight unexpectedly returned a private inode")
        return {"runtime_control_device_inode": fields[1]}
    if (not _DEVICE_INODE.fullmatch(fields[2]) or fields[3] != "65532:65532"
            or fields[4] != "750" or not _DEVICE_INODE.fullmatch(fields[5])
            or re.fullmatch(r"[0-9]+:[0-9]+", fields[6]) is None
            or re.fullmatch(r"[0-7]{3,4}", fields[7]) is None):
        _fail("Fresh-runtime archive preflight returned malformed role/ledger evidence")
    return {
        "runtime_control_device_inode": fields[1],
        "preserved_group_ledger_role_device_inode": fields[2],
        "preserved_group_ledger_role_owner": fields[3],
        "preserved_group_ledger_role_mode": fields[4],
        "preserved_group_ledger_device_inode": fields[5],
        "preserved_group_ledger_owner": fields[6],
        "preserved_group_ledger_mode": fields[7],
    }


def _archived_successful_runtime(control, previous, inputs, removed):
    """Keep a failed build immutable; qualify its actual successful resume."""
    if previous.get("state") == "succeeded":
        return previous
    if previous.get("state") != "failed-confirmed":
        _fail("Snapshot bootstrap retirement has no terminal previous development")
    # Enumerate immutable resume terminals, rather than a mutable verified
    # pointer which a later start may replace. This is read-only and bounded.
    script = (
        "if test -d /control/resume/attempts; then "
        "test ! -L /control/resume; test ! -L /control/resume/attempts; "
        "test \"$(readlink -f /control/resume/attempts)\" = /control/resume/attempts; "
        "find /control/resume/attempts -mindepth 2 -maxdepth 2 "
        "-type f -name terminal.json -printf '%h\\n'; fi"
    )
    from docker_volume_pre_admission_selector import _readonly_control_helper_args
    image = previous["inputs"].get("image_id")
    result = bounded_capture(
        _readonly_control_helper_args(control, control._namespace_guard(script), image),
        timeout=30, maximum=32768,
    )
    if result.returncode:
        _fail("Snapshot bootstrap retirement could not enumerate resume evidence")
    paths = result.stdout.decode("utf-8").splitlines()
    if len(paths) > 256 or len(set(paths)) != len(paths):
        _fail("Snapshot bootstrap retirement resume inventory exceeds its bound")
    from docker_volume_activate import _validate_linked_runtime_terminal
    for path in sorted(paths):
        match = re.fullmatch(r"/control/resume/attempts/([0-9a-f]{32})", path)
        if match is None:
            _fail("Snapshot bootstrap retirement resume path is not portable")
        relative = "resume/attempts/" + match.group(1)
        raw = control.read_bytes(relative + "/terminal.json")
        candidate = json.loads(raw)
        if not isinstance(candidate, Mapping):
            continue
        candidate_inputs = candidate.get("inputs")
        if (candidate.get("state") != "succeeded"
                or not isinstance(candidate_inputs, Mapping)
                or candidate_inputs.get("attempt") != inputs["attempt"]
                or any(candidate.get(role + "_container") != identifier
                       for role, identifier in removed.items())):
            continue
        if (raw != canonical(candidate) + b"\n"
                or raw != control.read_bytes(relative + "/receipt.json")
                or candidate.get("schema") != "fullmag.docker-build-operation.v1"
                or candidate.get("attempt") != match.group(1)
                or candidate.get("control_volume") != control.volume
                or candidate.get("control_namespace") != control.namespace):
            _fail("Snapshot bootstrap retirement resume backing records differ")
        _validate_linked_runtime_terminal(
            candidate, phase="resume", original_attempt=inputs["attempt"],
            original=previous, source_root=control.identity["source_root"],
            image=image, config_sha256=inputs["config_sha256"],
        )
        return candidate
    _fail("Snapshot bootstrap retirement has no successful resume for its removed services")


def snapshot_bootstrap_retired(control, snapshot):
    """A completed explicit fresh start supersedes only its old bootstrap.

    The immutable snapshot, its native validation and its data remain intact.
    An archive intent or an incomplete recreation grants no such authority.
    """
    generation = control.read("group-ledger-generation.json", optional=True)
    if generation is None:
        return False
    archive = pinned_group_archive(control, generation)
    token = generation["generation"]
    root = "recreate-services/attempts/" + token
    outer = control.read(root + "/terminal.json")
    raw_intent = control.read_bytes(root + "/runtime-control-archive-intent.json")
    intent = json.loads(raw_intent)
    retained = control.read(root + "/retained-containers.json")
    meta = {"compose_project": control.project, "control_volume": control.volume,
            "control_namespace": control.namespace}
    preserved_subpath = intent.get("preserved_group_ledger_subpath")
    private_ledger = preserved_subpath is not None
    mapping = _archive_mapping(token, private_ledger=private_ledger)
    removed = archive.get("removed_containers")
    outer_removed = outer.get("removed_containers") if isinstance(outer, Mapping) else None
    if (not isinstance(outer, Mapping) or not isinstance(intent, Mapping)
            or not isinstance(retained, Mapping) or not isinstance(removed, Mapping)
            or set(removed) != {"backend", "frontend"}
            or any(not _CONTAINER_ID.fullmatch(str(value)) for value in removed.values())
            or len(set(removed.values())) != 2
            or archive.get("schema") != "fullmag.docker-fresh-runtime-archive-terminal.v1"
            or intent.get("schema") != "fullmag.docker-fresh-runtime-archive-intent.v1"
            or intent.get("operation_attempt") != token
            or any(document.get(key) != value for document in (archive, intent, outer)
                   for key, value in meta.items())
            or archive.get("intent_sha256") != hashlib.sha256(raw_intent).hexdigest()
            or archive.get("mapping") != mapping or intent.get("mapping") != mapping
            or intent.get("removed_containers") != removed
            or intent.get("preserved_group_ledger_volume") != generation.get("preserved_volume")
            or (private_ledger and (
                not isinstance(preserved_subpath, str)
                or _PRIVATE_LEDGER.fullmatch(preserved_subpath) is None
                or preserved_subpath != _expected_private_ledger_subpath(control)
                or intent.get("preserved_group_ledger_device_inode")
                    != archive.get("preserved_group_ledger_device_inode")
                or intent.get("preserved_group_ledger_owner")
                    != archive.get("preserved_group_ledger_owner")
                or intent.get("preserved_group_ledger_mode")
                    != archive.get("preserved_group_ledger_mode")
                or intent.get("preserved_group_ledger_role_device_inode")
                    != archive.get("preserved_group_ledger_role_device_inode")
                or intent.get("preserved_group_ledger_role_owner")
                    != archive.get("preserved_group_ledger_role_owner")
                or intent.get("preserved_group_ledger_role_mode")
                    != archive.get("preserved_group_ledger_role_mode")
                or intent.get("runtime_control_device_inode")
                    != archive.get("preserved_runtime_control_device_inode")
                or generation.get("preserved_subpath") != preserved_subpath
                or generation.get("archived_group_ledger_path")
                    != mapping["archived_group_ledger"]
            ))
            or (not private_ledger and (
                "preserved_group_ledger_device_inode" in intent
                or "preserved_group_ledger_role_device_inode" in intent
                or "preserved_group_ledger_role_owner" in intent
                or "preserved_group_ledger_role_mode" in intent
                or "preserved_subpath" in generation
                or "archived_group_ledger_path" in generation
            ))
            or intent.get("source_root") != control.identity.get("source_root")
            or outer.get("schema") != "fullmag.docker-build-operation.v1"
            or outer.get("phase") != "recreate-services" or outer.get("state") != "succeeded"
            or outer.get("attempt") != token or outer.get("fresh_state") is not True
            or canonical(outer.get("runtime_control_archive")) != canonical(archive)
            or not isinstance(outer_removed, list) or sorted(outer_removed) != sorted(removed.values())
            or outer.get("previous_state_root") != intent.get("previous_state_root")
            or any(not isinstance(retained.get(role), Mapping)
                   or retained[role].get("Id") != identifier for role, identifier in removed.items())):
        _fail("Snapshot bootstrap retirement has no exact completed fresh-runtime archive")
    inputs = outer.get("inputs")
    if (not isinstance(inputs, Mapping)
            or not _OPERATION_ID.fullmatch(str(inputs.get("attempt", "")))
            or not re.fullmatch(r"[0-9a-f]{64}", str(inputs.get("config_sha256", "")))):
        _fail("Snapshot bootstrap retirement has no pinned previous development")
    previous_root = "development/attempts/" + inputs["attempt"]
    previous = control.read(previous_root + "/terminal.json")
    compose = control.read(previous_root + "/compose.json")
    previous_inputs = previous.get("inputs") if isinstance(previous, Mapping) else None
    if (not isinstance(previous, Mapping) or not isinstance(previous_inputs, Mapping)
            or previous.get("schema") != "fullmag.docker-build-operation.v1"
            or previous.get("phase") != "development"
            or previous.get("state") not in {"succeeded", "failed-confirmed"}
            or previous.get("attempt") != inputs["attempt"]
            or any(previous.get(key) != value for key, value in meta.items())
            or previous_inputs.get("source_root") != control.identity.get("source_root")
            or previous.get("state_root") != intent.get("previous_state_root")
            or hashlib.sha256(canonical(compose)).hexdigest() != inputs["config_sha256"]):
        _fail("Snapshot bootstrap retirement has another previous development identity")
    runtime = _archived_successful_runtime(control, previous, inputs, removed)
    if (runtime.get("state_root") != intent.get("previous_state_root")
            or any(runtime.get(role + "_container") != identifier
                   for role, identifier in removed.items())):
        _fail("Snapshot bootstrap retirement has another successful runtime identity")
    binding = outer.get("snapshot_bootstrap_retirement")
    proof_path = root + "/snapshot-native-drain.json"
    if (not isinstance(binding, Mapping)
            or binding.get("schema") != "fullmag.docker-snapshot-bootstrap-retirement.v1"
            or binding.get("snapshot_sha256") != hashlib.sha256(canonical(snapshot)).hexdigest()
            or binding.get("backend_container_id") != removed["backend"]
            or binding.get("image_id") != retained["backend"].get("Image")
            or binding.get("backend_started_at") != retained["backend"].get("State", {}).get("StartedAt")
            or binding.get("native_drain_path") != proof_path):
        _fail("Snapshot bootstrap retirement has no exact stopped incarnation")
    native_raw = control.read_bytes(proof_path)
    archived_raw = control.read_bytes("runtime-archives/" + token + "/runtime-service/process-tree.json")
    native = json.loads(native_raw)
    state = retained["backend"].get("State", {})
    if (hashlib.sha256(native_raw).hexdigest() != binding.get("native_drain_sha256")
            or native_raw != archived_raw
            or not isinstance(native, Mapping) or native.get("schema") != "fullmag.docker-process-tree.v1"
            or native.get("state") != "drained" or state.get("Running") is not False
            or state.get("OOMKilled") is not False or state.get("ExitCode") != 0
            or state.get("Pid") != 0 or state.get("Status") != "exited"):
        _fail("Snapshot bootstrap retirement lacks its preserved genuine native drain")
    return True


def _preserve_previous_preparation_abort_archive(control: BuildControl, operation: Mapping[str, object]) -> bool:
    """Anchor an older abort before this recreation rotates its generation pointer."""
    from docker_volume_preparation_abort import RECORD, pin_completed_fresh_archive

    receipt = operation.get("receipt")
    inputs = receipt.get("inputs") if isinstance(receipt, Mapping) else None
    development_attempt = inputs.get("attempt") if isinstance(inputs, Mapping) else None
    if not isinstance(development_attempt, str) or _OPERATION_ID.fullmatch(development_attempt) is None:
        _fail("Fresh-runtime archive has no exact retained development attempt")

    record = control.read(RECORD, optional=True)
    if record is None:
        return False
    if not isinstance(record, Mapping):
        _fail("Preparation abort current pointer is malformed before fresh archive")

    from docker_volume_stop_diagnostic import ATTEMPT_RE
    activation_attempt = record.get("activation_attempt")
    if not isinstance(activation_attempt, str) or ATTEMPT_RE.fullmatch(activation_attempt) is None:
        _fail("Preparation abort activation identity is malformed before fresh archive")
    anchor = control.read(
        "preparation-abort/archives/" + activation_attempt + ".json",
        optional=True,
    )
    if anchor is not None:
        pin_completed_fresh_archive(control)
        return True

    # The first recreation for this abort has not yet published its operation
    # terminal, so pinning here would claim completion prematurely. A later
    # recreation has a different parent attempt; pin its completed predecessor
    # while group-ledger-generation.json still names that exact archive.
    if record.get("development_attempt") == development_attempt:
        return False
    generation = control.read("group-ledger-generation.json", optional=True)
    if generation is None:
        _fail("Older preparation abort has no completed archive generation to preserve")
    if not isinstance(generation, Mapping):
        _fail("Previous group ledger generation is malformed before fresh archive")
    pin_completed_fresh_archive(control)
    return True


def _json_documents(raw: bytes, description: str) -> list[dict[str, object]]:
    try:
        value = json.loads(raw)
    except (TypeError, ValueError) as error:
        raise BuildControlError(description + " is not valid JSON") from error
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        _fail(description + " is malformed")
    return value


def _inspect_one(identifier: str) -> dict[str, object]:
    documents = _json_documents(docker_capture("inspect", identifier, timeout=60).stdout,
                                "Docker container inspection")
    if len(documents) != 1:
        _fail("Docker container inspection is ambiguous")
    return documents[0]


def _assert_exact_absence(identifier: str, service: str) -> None:
    inspected = docker_capture("inspect", identifier, allow_failure=True, timeout=60)
    if inspected.returncode == 0:
        _fail("Removed " + service + " container remains inspectable")
    detail = (inspected.stderr + inspected.stdout).decode("utf-8", "replace")
    absent = _ABSENT_CONTAINER.search(detail)
    if absent is None or absent.group(1).lower() != identifier:
        _fail("Docker did not confirm exact " + service + " container absence")
    listed = docker_capture(
        "ps", "--all", "--quiet", "--no-trunc", "--filter", "id=" + identifier,
        timeout=60,
    )
    if listed.stdout.decode("utf-8", "replace").split():
        _fail("Removed " + service + " container is still listed")


def _container_ids(*filters: str) -> set[str]:
    result = docker_capture("ps", "--all", "--quiet", "--no-trunc", *filters, timeout=60)
    values = result.stdout.decode("ascii", "strict").split()
    if any(_CONTAINER_ID.fullmatch(value) is None for value in values) or len(values) != len(set(values)):
        _fail("Docker container inventory is malformed")
    return set(values)


def _operation_helper(control: BuildControl, operation: Mapping[str, object], token: str) -> tuple[str, dict[str, object]]:
    receipt = operation.get("receipt")
    logger = operation.get("logger")
    if (
        not isinstance(receipt, Mapping)
        or receipt.get("schema") != "fullmag.docker-build-operation.v1"
        or receipt.get("phase") != "recreate-services"
        or receipt.get("fresh_state") is not True
        or receipt.get("attempt") != token
        or receipt.get("helper_container") != "fullmag-control-" + token
        or operation.get("root") != "recreate-services/attempts/" + token
        or operation.get("lease_ready") is not True
        or operation.get("daemon_pending") is not True
        or logger is None
        or not callable(getattr(logger, "poll", None))
        or logger.poll() is not None
    ):
        _fail("Fresh-runtime archive requires the live recreate-services lease")

    name = "fullmag-control-" + token
    helper = _inspect_one(name)
    identifier = helper.get("Id")
    config = helper.get("Config")
    state = helper.get("State")
    expected_command = control.helper_args(
        control.operation_script("recreate-services", token), name=name
    )
    entrypoint_index = expected_command.index("--entrypoint")
    expected_path = expected_command[entrypoint_index + 1]
    expected_image = expected_command[entrypoint_index + 2]
    expected_args = expected_command[entrypoint_index + 3:]
    if (
        not isinstance(identifier, str)
        or _CONTAINER_ID.fullmatch(identifier) is None
        or helper.get("Name") != "/" + name
        or helper.get("Image") is None
        or not isinstance(config, Mapping)
        or config.get("Image") != expected_image
        or expected_image != control.image
        or not isinstance(state, Mapping)
        or state.get("Running") is not True
        or helper.get("Path") != expected_path
        or helper.get("Args") != expected_args
    ):
        _fail("Fresh-runtime archive lease helper identity differs")

    image_rows = _json_documents(docker_capture("image", "inspect", control.image, timeout=60).stdout,
                                 "Control helper image inspection")
    if len(image_rows) != 1 or helper.get("Image") != image_rows[0].get("Id"):
        _fail("Fresh-runtime archive helper image is not the pinned local image")

    labels = config.get("Labels")
    expected_labels = {
        **control.labels,
        **source_labels(control.identity),
        "com.docker.compose.project": control.project,
        "com.docker.compose.service": "build-control",
    }
    if not isinstance(labels, Mapping) or any(labels.get(key) != value for key, value in expected_labels.items()):
        _fail("Fresh-runtime archive lease helper labels differ")

    mounts = helper.get("Mounts")
    expected_mounts = {"/control": True}
    if control.namespace:
        expected_mounts["/registry"] = False
    if not isinstance(mounts, list) or len(mounts) != len(expected_mounts):
        _fail("Fresh-runtime archive lease helper mounts are ambiguous")
    observed_mounts: dict[str, bool] = {}
    for mount in mounts:
        if not isinstance(mount, Mapping):
            _fail("Fresh-runtime archive lease helper mount is malformed")
        destination = mount.get("Destination")
        if (
            destination not in expected_mounts
            or mount.get("Type") != "volume"
            or mount.get("Name") != control.volume
            or type(mount.get("RW")) is not bool
            or mount.get("RW") is not expected_mounts[destination]
            or destination in observed_mounts
        ):
            _fail("Fresh-runtime archive lease helper mount identity differs")
        observed_mounts[destination] = mount["RW"]
    if observed_mounts != expected_mounts:
        _fail("Fresh-runtime archive lease helper mount set differs")

    volume_rows = _json_documents(docker_capture("volume", "inspect", control.volume, timeout=60).stdout,
                                  "Control volume inspection")
    if len(volume_rows) != 1:
        _fail("Fresh-runtime archive control volume is ambiguous")
    volume = volume_rows[0]
    volume_labels = volume.get("Labels")
    if (
        volume.get("Name") != control.volume
        or volume.get("Driver") != "local"
        or volume.get("Options")
        or not isinstance(volume_labels, Mapping)
        or any(volume_labels.get(key) != value for key, value in control.shared_labels.items())
    ):
        _fail("Fresh-runtime archive control volume identity differs")
    return identifier, helper


def _assert_only_operation_helper(control: BuildControl, helper_id: str) -> None:
    project_ids = _container_ids("--filter", "label=com.docker.compose.project=" + control.project)
    volume_ids = _container_ids("--filter", "volume=" + control.volume)
    if project_ids != {helper_id} or volume_ids != {helper_id}:
        _fail("Fresh-runtime archive has another project or control-volume consumer")


def _assert_ledger_consumers(control: BuildControl, helper_id: str,
                             binding: Mapping[str, object]) -> None:
    volume_name = binding.get("volume_name")
    if not isinstance(volume_name, str) or not volume_name:
        _fail("Fresh-runtime archive ledger volume identity is malformed")
    if binding.get("private") is True:
        if volume_name != control.volume:
            _fail("Fresh-runtime private ledger is not the canonical control volume")
    elif _container_ids("--filter", "volume=" + volume_name):
        _fail("Archived group ledger still has a container consumer")
    _assert_only_operation_helper(control, helper_id)


def _validate_old_container_pins(
    control: BuildControl,
    operation: Mapping[str, object],
    removed_containers: object,
) -> dict[str, str]:
    token = operation["receipt"]["attempt"]  # validated by _operation_helper first
    snapshot = control.read("recreate-services/attempts/" + token + "/retained-containers.json")
    if not isinstance(snapshot, Mapping) or set(snapshot) != {"backend", "frontend"}:
        _fail("Fresh-runtime archive has no exact retained application pair")
    if not isinstance(removed_containers, (list, tuple)) or len(removed_containers) != 2:
        _fail("Fresh-runtime archive requires the exact removed application pair")

    pinned: dict[str, str] = {}
    for service in ("backend", "frontend"):
        row = snapshot.get(service)
        config = row.get("Config") if isinstance(row, Mapping) else None
        labels = config.get("Labels") if isinstance(config, Mapping) else None
        identifier = row.get("Id") if isinstance(row, Mapping) else None
        if (
            not isinstance(identifier, str)
            or _CONTAINER_ID.fullmatch(identifier) is None
            or not isinstance(labels, Mapping)
            or labels.get("com.docker.compose.project") != control.project
            or labels.get("com.docker.compose.service") != service
        ):
            _fail("Fresh-runtime archive retained " + service + " pin is malformed")
        pinned[service] = identifier
    supplied = list(removed_containers)
    if (
        any(not isinstance(value, str) or _CONTAINER_ID.fullmatch(value) is None for value in supplied)
        or len(set(supplied)) != 2
        or set(supplied) != set(pinned.values())
    ):
        _fail("Fresh-runtime archive removed IDs differ from the retained application pins")
    return pinned


_ARCHIVE_SCRIPT = r'''set -euo pipefail
token='TOKEN'
root=CONTROL_ROOT
old="$root/runtime-control"
archives="$root/runtime-archives"
target="$archives/$token"
active="$root/active"
expected_runtime_inode='RUNTIME_INODE'
ledger_rel='LEDGER_REL'
role_rel='ROLE_REL'
expected_ledger_inode='LEDGER_INODE'
expected_role_inode='ROLE_INODE'
expected_role_owner='ROLE_OWNER'
expected_role_mode='ROLE_MODE'
expected_ledger_owner='LEDGER_OWNER'
expected_ledger_mode='LEDGER_MODE'
verify_only=VERIFY_ONLY
fresh_uid=65532
fresh_gid=65532
test "$(id -u):$(id -g)" = "$fresh_uid:$fresh_gid"

validate_fresh_runtime() {
  test ! -L "$old"
  test -d "$old"
  test "$(readlink -f "$old")" = "$old"
  test "$(stat -c '%u:%g' "$old")" = "$fresh_uid:$fresh_gid"
  test "$(stat -c '%a' "$old")" = 750
  fresh_runtime_entries=$(find "$old" -mindepth 1 -maxdepth 1 -print)
  if test -z "$fresh_runtime_entries"; then
    fresh_runtime_state=partial
    return 0
  fi
  test "$fresh_runtime_entries" = "$old/runtime-services"
  test ! -L "$old/runtime-services"
  test -d "$old/runtime-services"
  test "$(readlink -f "$old/runtime-services")" = "$old/runtime-services"
  test -z "$(find "$old/runtime-services" -mindepth 1 -maxdepth 1 -print -quit)"
  fresh_runtime_state=complete
}

test ! -L "$root"
test "$(readlink -f "$root")" = "$root"
test ! -L "$active"
test -f "$active"
test "$(stat -c %h "$active")" = 1
test "$(wc -c < "$active")" -eq 33
test "$(cat "$active")" = "$token"
active_sha=$(sha256sum "$active" | cut -d' ' -f1)

if test -L "$archives"; then exit 71; fi
if test -e "$archives"; then
  test -d "$archives"
  test "$(readlink -f "$archives")" = "$archives"
fi

runtime_source=0
runtime_archived=0
fresh_runtime_state=missing
if test -e "$target" || test -L "$target"; then
  test ! -L "$target"
  test -d "$target"
  test "$(readlink -f "$target")" = "$target"
  test "$(stat -c '%d:%i' "$target")" = "$expected_runtime_inode"
  runtime_archived=1
fi
if test -e "$old" || test -L "$old"; then
  test ! -L "$old"
  test -d "$old"
  test "$(readlink -f "$old")" = "$old"
  old_inode_now=$(stat -c '%d:%i' "$old")
  if test "$old_inode_now" = "$expected_runtime_inode"; then
    test "$runtime_archived" -eq 0
    runtime_source=1
  else
    test "$runtime_archived" -eq 1
    validate_fresh_runtime
  fi
fi
if test "$runtime_source" -eq 0 && test "$runtime_archived" -eq 0; then exit 75; fi

if test "$runtime_source" -eq 0; then
  old_services="$target/runtime-services"
else
  old_services="$old/runtime-services"
fi
test ! -L "$old_services"
test -d "$old_services"
test "$(readlink -f "$old_services")" = "$old_services"

role="$root/$role_rel"
ledger="$role/ledger"
archived_ledger="$target/group-ledger"
ledger_source=0
ledger_archived=0
ledger_fresh=0
if test -n "$ledger_rel"; then
  ledger_parent="$root/private"
  test ! -L "$ledger_parent"
  test -d "$ledger_parent"
  test "$(readlink -f "$ledger_parent")" = "$ledger_parent"
  test ! -L "$role"
  test -d "$role"
  test "$(readlink -f "$role")" = "$role"
  test "$(stat -c '%d:%i' "$role")" = "$expected_role_inode"
  test "$(stat -c '%u:%g' "$role")" = "$expected_role_owner"
  test "$(stat -c '%a' "$role")" = "$expected_role_mode"
  if test -d "$archives"; then
    test "$(stat -c %d "$role")" = "$(stat -c %d "$archives")"
  fi
  if test -e "$archived_ledger" || test -L "$archived_ledger"; then
    test ! -L "$archived_ledger"
    test -d "$archived_ledger"
    test "$(readlink -f "$archived_ledger")" = "$archived_ledger"
    test "$(stat -c '%d:%i' "$archived_ledger")" = "$expected_ledger_inode"
    test "$(stat -c '%u:%g' "$archived_ledger")" = "$expected_ledger_owner"
    test "$(stat -c '%a' "$archived_ledger")" = "$expected_ledger_mode"
    ledger_archived=1
  fi
  if test -e "$ledger" || test -L "$ledger"; then
    test ! -L "$ledger"
    test -d "$ledger"
    test "$(readlink -f "$ledger")" = "$ledger"
    ledger_inode_now=$(stat -c '%d:%i' "$ledger")
    if test "$ledger_inode_now" = "$expected_ledger_inode"; then
      test "$ledger_archived" -eq 0
      test "$(stat -c '%u:%g' "$ledger")" = "$expected_ledger_owner"
      test "$(stat -c '%a' "$ledger")" = "$expected_ledger_mode"
      ledger_source=1
    else
      test "$ledger_archived" -eq 1
      test -z "$(find "$ledger" -mindepth 1 -maxdepth 1 -print -quit)"
      test "$(stat -c '%u:%g' "$ledger")" = "$fresh_uid:$fresh_gid"
      test "$(stat -c '%a' "$ledger")" = 750
      ledger_fresh=1
    fi
  fi
  if test "$ledger_source" -eq 0 && test "$ledger_archived" -eq 0; then exit 76; fi
  if test "$runtime_source" -eq 1 && test "$ledger_archived" -eq 1; then exit 77; fi
  if test "$ledger_source" -eq 1 || test "$ledger_fresh" -eq 1; then
    test "$(find "$role" -mindepth 1 -maxdepth 1 -print)" = "$ledger"
  else
    test -z "$(find "$role" -mindepth 1 -maxdepth 1 -print -quit)"
  fi
fi
if test "$verify_only" -eq 1; then
  test "$runtime_source" -eq 0
  test "$runtime_archived" -eq 1
  if test -n "$ledger_rel"; then
    test "$ledger_source" -eq 0
    test "$ledger_archived" -eq 1
    test "$ledger_fresh" -eq 1
  fi
  validate_fresh_runtime
  test "$fresh_runtime_state" = complete
fi

held_locks=
owner_lock="$old_services/OWNER.lock"
if test -L "$owner_lock"; then exit 72; fi
if test -e "$owner_lock"; then
  test -f "$owner_lock" && test "$(stat -c %h "$owner_lock")" = 1
  exec 10< "$owner_lock"
  flock -n -x 10
  held_locks="OWNER.lock"
fi
launch_lock="$old_services/LAUNCH.lock"
if test -L "$launch_lock"; then exit 73; fi
if test -e "$launch_lock"; then
  test -f "$launch_lock" && test "$(stat -c %h "$launch_lock")" = 1
  exec 11< "$launch_lock"
  flock -n -x 11
  if test -n "$held_locks"; then held_locks="$held_locks,LAUNCH.lock"; else held_locks="LAUNCH.lock"; fi
fi
startup_lock="$old_services/STARTUP-GATE.lock"
if test -L "$startup_lock"; then exit 74; fi
if test -e "$startup_lock"; then
  test -f "$startup_lock" && test "$(stat -c %h "$startup_lock")" = 1
  exec 12< "$startup_lock"
  flock -n -x 12
  if test -n "$held_locks"; then held_locks="$held_locks,STARTUP-GATE.lock"; else held_locks="STARTUP-GATE.lock"; fi
fi

if test "$runtime_source" -eq 1; then
  if test ! -e "$archives"; then mkdir -m 0750 "$archives"; fi
  test "$(stat -c %d "$old")" = "$(stat -c %d "$archives")"
  test ! -e "$target"
  test ! -L "$target"
  mv -T -- "$old" "$target"
  runtime_archived=1
fi
test "$(stat -c '%d:%i' "$target")" = "$expected_runtime_inode"

if test -n "$ledger_rel" && test "$ledger_source" -eq 1; then
  test ! -e "$archived_ledger"
  test ! -L "$archived_ledger"
  test "$(stat -c %d "$ledger")" = "$(stat -c %d "$archives")"
  mv -T -- "$ledger" "$archived_ledger"
  ledger_archived=1
fi
if test -n "$ledger_rel"; then
  test "$(stat -c '%d:%i' "$archived_ledger")" = "$expected_ledger_inode"
  test "$(stat -c '%u:%g' "$archived_ledger")" = "$expected_ledger_owner"
  test "$(stat -c '%a' "$archived_ledger")" = "$expected_ledger_mode"
fi

if test "$verify_only" -eq 0; then
  if test -e "$old"; then
    test "$runtime_archived" -eq 1
    test "$(stat -c '%d:%i' "$old")" != "$expected_runtime_inode"
    if test "$fresh_runtime_state" = partial; then
      mkdir -m 0750 "$old/runtime-services"
    elif test "$fresh_runtime_state" != complete; then
      exit 78
    fi
  else
    mkdir -m 0750 "$old"
    mkdir -m 0750 "$old/runtime-services"
  fi
fi
validate_fresh_runtime
if test "$verify_only" -eq 1; then test "$fresh_runtime_state" = complete; fi

if test -n "$ledger_rel" && test "$verify_only" -eq 0; then
  if test ! -e "$ledger"; then mkdir -m 0750 "$ledger"; fi
fi
if test -n "$ledger_rel"; then
  test "$(stat -c '%d:%i' "$role")" = "$expected_role_inode"
  test "$(stat -c '%u:%g' "$role")" = "$expected_role_owner"
  test "$(stat -c '%a' "$role")" = "$expected_role_mode"
  test "$(stat -c %d "$role")" = "$(stat -c %d "$ledger")"
  test "$(stat -c %d "$role")" = "$(stat -c %d "$archives")"
  test ! -L "$ledger"
  test -d "$ledger"
  test "$(readlink -f "$ledger")" = "$ledger"
  test "$(stat -c '%d:%i' "$ledger")" != "$expected_ledger_inode"
  test -z "$(find "$ledger" -mindepth 1 -maxdepth 1 -print -quit)"
  test "$(stat -c '%u:%g' "$ledger")" = "$fresh_uid:$fresh_gid"
  test "$(stat -c '%a' "$ledger")" = 750
fi

test ! -L "$active"
test "$(stat -c %h "$active")" = 1
test "$(wc -c < "$active")" -eq 33
test "$(cat "$active")" = "$token"
test "$(sha256sum "$active" | cut -d' ' -f1)" = "$active_sha"
archived_inode=$(stat -c '%d:%i' "$target")
fresh_inode=$(stat -c '%d:%i' "$old")
services_inode=$(stat -c '%d:%i' "$old/runtime-services")
archived_ledger_inode=-
archived_ledger_owner=-
archived_ledger_mode=-
fresh_ledger_inode=-
fresh_ledger_owner=-
role_inode=-
role_owner=-
role_mode=-
if test -n "$ledger_rel"; then
  archived_ledger_inode=$(stat -c '%d:%i' "$archived_ledger")
  archived_ledger_owner=$(stat -c '%u:%g' "$archived_ledger")
  archived_ledger_mode=$(stat -c '%a' "$archived_ledger")
  fresh_ledger_inode=$(stat -c '%d:%i' "$ledger")
  fresh_ledger_owner=$(stat -c '%u:%g' "$ledger")
  role_inode=$(stat -c '%d:%i' "$role")
  role_owner=$(stat -c '%u:%g' "$role")
  role_mode=$(stat -c '%a' "$role")
fi
sync "$archives"
sync "$target"
sync "$old/runtime-services"
sync "$old"
if test -n "$ledger_rel"; then sync "$archived_ledger"; sync "$ledger"; fi
sync "$root"
printf 'ARCHIVED\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$archived_inode" "$fresh_inode" "$services_inode" "$active_sha" "${held_locks:--}" "$archived_ledger_inode" "$archived_ledger_owner" "$archived_ledger_mode" "$fresh_ledger_inode" "$fresh_ledger_owner" "$role_inode" "$role_owner" "$role_mode"
'''


def _archive_script(token: str, intent: Mapping[str, object], *, root: str = "/control",
                    verify_only: bool = False) -> str:
    if not _OPERATION_ID.fullmatch(token):
        _fail("Fresh-runtime archive token is malformed")
    runtime_inode = intent.get("runtime_control_device_inode")
    if not isinstance(runtime_inode, str) or not _DEVICE_INODE.fullmatch(runtime_inode):
        _fail("Fresh-runtime archive intent has no runtime-control inode pin")
    private = "preserved_group_ledger_subpath" in intent
    role_rel = "private/ledger" if private else ""
    ledger_rel = role_rel + "/ledger" if private else ""
    ledger_inode = intent.get("preserved_group_ledger_device_inode", "-")
    ledger_owner = intent.get("preserved_group_ledger_owner", "-")
    ledger_mode = intent.get("preserved_group_ledger_mode", "-")
    role_inode = intent.get("preserved_group_ledger_role_device_inode", "-")
    role_owner = intent.get("preserved_group_ledger_role_owner", "-")
    role_mode = intent.get("preserved_group_ledger_role_mode", "-")
    if private:
        subpath = intent.get("preserved_group_ledger_subpath")
        if (not isinstance(subpath, str) or _PRIVATE_LEDGER.fullmatch(subpath) is None
                or not isinstance(ledger_inode, str) or not _DEVICE_INODE.fullmatch(ledger_inode)
                or not isinstance(ledger_owner, str) or re.fullmatch(r"[0-9]+:[0-9]+", ledger_owner) is None
                or not isinstance(ledger_mode, str) or re.fullmatch(r"[0-7]{3,4}", ledger_mode) is None
                or not isinstance(role_inode, str) or not _DEVICE_INODE.fullmatch(role_inode)
                or role_owner != "65532:65532" or role_mode != "750"):
            _fail("Fresh-runtime archive intent has no private ledger inode pin")
    elif (ledger_inode != "-" or ledger_owner != "-" or ledger_mode != "-"
            or role_inode != "-" or role_owner != "-" or role_mode != "-"):
        _fail("Legacy fresh-runtime archive carries a private ledger inode pin")
    if not isinstance(root, str) or not root.startswith("/") or "'" in root or "\n" in root:
        _fail("Fresh-runtime archive control root is invalid")
    if type(verify_only) is not bool:
        _fail("Fresh-runtime archive verification mode is invalid")
    return (_ARCHIVE_SCRIPT.replace("TOKEN", token)
            .replace("CONTROL_ROOT", shlex.quote(root))
            .replace("RUNTIME_INODE", runtime_inode)
            .replace("LEDGER_REL", ledger_rel)
            .replace("LEDGER_INODE", ledger_inode)
            .replace("LEDGER_OWNER", ledger_owner)
            .replace("LEDGER_MODE", ledger_mode)
            .replace("ROLE_REL", role_rel)
            .replace("ROLE_INODE", role_inode)
            .replace("ROLE_OWNER", role_owner)
            .replace("ROLE_MODE", role_mode)
            .replace("VERIFY_ONLY", "1" if verify_only else "0"))


def _archive_runtime_control(helper_id: str, token: str, intent: Mapping[str, object],
                             *, verify_only: bool = False) -> dict[str, object]:
    script = _archive_script(token, intent, verify_only=verify_only)
    result = docker_capture(
        "exec", helper_id, "/bin/bash", "-euo", "pipefail", "-c", script,
        timeout=90,
    )
    lines = result.stdout.decode("ascii", "strict").splitlines()
    if len(lines) != 1:
        _fail("Fresh-runtime archive helper returned an ambiguous receipt")
    fields = lines[0].split("\t")
    if len(fields) != 14 or fields[0] != "ARCHIVED":
        _fail("Fresh-runtime archive helper did not confirm the atomic rename")
    inode_fields = fields[1:4]
    if (any(not _DEVICE_INODE.fullmatch(value) for value in inode_fields)
            or inode_fields[0] == inode_fields[1]
            or inode_fields[1] == inode_fields[2]):
        _fail("Fresh-runtime archive helper returned malformed directory identities")
    if (inode_fields[0] != intent.get("runtime_control_device_inode")
            or re.fullmatch(r"[0-9a-f]{64}", fields[4]) is None):
        _fail("Fresh-runtime archive helper returned a malformed active-marker digest")
    locks = [] if fields[5] == "-" else fields[5].split(",")
    if any(value not in {"OWNER.lock", "LAUNCH.lock", "STARTUP-GATE.lock"} for value in locks):
        _fail("Fresh-runtime archive helper returned malformed lock evidence")
    evidence: dict[str, object] = {
        "preserved_runtime_control_device_inode": inode_fields[0],
        "archived_runtime_control_device_inode": inode_fields[0],
        "fresh_runtime_control_device_inode": inode_fields[1],
        "fresh_runtime_services_device_inode": inode_fields[2],
        "active_marker_sha256": fields[4],
        "locked_runtime_service_files": locks,
    }
    if "preserved_group_ledger_subpath" in intent:
        if (fields[6] != intent.get("preserved_group_ledger_device_inode")
                or fields[7] != intent.get("preserved_group_ledger_owner")
                or fields[8] != intent.get("preserved_group_ledger_mode")
                or not _DEVICE_INODE.fullmatch(fields[9])
                or fields[9] == fields[6] or fields[10] != "65532:65532"
                or fields[11] != intent.get("preserved_group_ledger_role_device_inode")
                or fields[12] != "65532:65532" or fields[13] != "750"):
            _fail("Fresh-runtime archive helper returned invalid private-ledger inode/owner evidence")
        evidence.update({
            "archived_group_ledger_device_inode": fields[6],
            "archived_group_ledger_owner": fields[7],
            "archived_group_ledger_mode": fields[8],
            "fresh_group_ledger_device_inode": fields[9],
            "fresh_group_ledger_owner": fields[10],
            "preserved_group_ledger_role_device_inode": fields[11],
            "fresh_group_ledger_role_device_inode": fields[11],
            "preserved_group_ledger_role_owner": fields[12],
            "fresh_group_ledger_role_owner": fields[12],
            "preserved_group_ledger_role_mode": fields[13],
            "fresh_group_ledger_role_mode": fields[13],
        })
    elif fields[6:] != ["-", "-", "-", "-", "-", "-", "-", "-"]:
        _fail("Legacy fresh-runtime archive helper returned unexpected private-ledger evidence")
    return evidence


def archive_runtime_control(
    control: BuildControl,
    operation: Mapping[str, object],
    *,
    previous_state_root: str,
    source_root: str,
    removed_containers: object,
) -> dict[str, object]:
    """Retain old native state and create the empty runtime root for fresh DEV."""
    if not isinstance(control, BuildControl) or not isinstance(operation, Mapping):
        _fail("Fresh-runtime archive requires the managed BuildControl operation")
    receipt = operation.get("receipt")
    token = receipt.get("attempt") if isinstance(receipt, Mapping) else None
    if not isinstance(token, str) or _OPERATION_ID.fullmatch(token) is None:
        _fail("Fresh-runtime archive operation token is malformed")
    helper_id, _ = _operation_helper(control, operation, token)

    source = Path(source_root)
    prior_state = Path(previous_state_root)
    try:
        source_resolved = source.resolve(strict=True)
        state_resolved = prior_state.resolve(strict=True)
    except OSError as error:
        raise BuildControlError("Fresh-runtime archive source or prior state path is unavailable") from error
    if (
        not source.is_absolute()
        or not state_resolved.is_absolute()
        or not source_resolved.is_dir()
        or not state_resolved.is_dir()
        or str(source_resolved) != control.identity.get("source_root")
        or str(source_resolved) != source_root
        or not isinstance(receipt, Mapping)
        or receipt.get("previous_state_root") != previous_state_root
        or str(state_resolved) != previous_state_root
    ):
        _fail("Fresh-runtime archive source or prior state binding differs")

    pinned_containers = _validate_old_container_pins(control, operation, removed_containers)
    for service, identifier in pinned_containers.items():
        _assert_exact_absence(identifier, service)

    # The ledger can be a separate legacy volume or a role subpath of the
    # canonical private control volume. Only the exact latter case can have
    # the admitted control helper as its remaining consumer.
    retained_pair = control.read(operation["root"] + "/retained-containers.json")
    ledger_binding = _retained_group_ledger_binding(control, operation, retained_pair)
    previous_ledger = ledger_binding["volume_name"]
    private_ledger = bool(ledger_binding["private"])
    _assert_ledger_consumers(control, helper_id, ledger_binding)

    intent_path = operation["root"] + "/runtime-control-archive-intent.json"
    terminal_path = operation["root"] + "/runtime-control-archive-terminal.json"
    intent = control.read(intent_path, optional=True)
    terminal_existing = control.read(terminal_path, optional=True)
    if intent is None:
        if terminal_existing is not None:
            _fail("Fresh-runtime archive terminal exists without its durable intent")
        _preserve_previous_preparation_abort_archive(control, operation)
        inode_evidence = _archive_preflight(
            helper_id, ledger_binding["control_role_path"] if private_ledger else None,
        )
        intent = {
            "schema": "fullmag.docker-fresh-runtime-archive-intent.v1",
            "operation_attempt": token,
            "compose_project": control.project,
            "control_volume": control.volume,
            "control_namespace": control.namespace,
            "source_root": str(source_resolved),
            "previous_state_root": str(state_resolved),
            "preserved_group_ledger_volume": previous_ledger,
            "removed_containers": pinned_containers,
            "mapping": _archive_mapping(token, private_ledger=private_ledger),
            **inode_evidence,
            "created_at": time.time(),
        }
        if private_ledger:
            intent["preserved_group_ledger_subpath"] = ledger_binding["subpath"]
        control.write(intent_path, intent)
        if control.read(intent_path) != intent:
            _fail("Fresh-runtime archive intent did not persist exactly")
    intent_raw = control.read_bytes(intent_path)
    if (intent_raw != canonical(intent) + b"\n"
            or not isinstance(intent, Mapping)
            or intent.get("schema") != "fullmag.docker-fresh-runtime-archive-intent.v1"
            or intent.get("operation_attempt") != token
            or intent.get("compose_project") != control.project
            or intent.get("control_volume") != control.volume
            or intent.get("control_namespace", "") != control.namespace
            or intent.get("source_root") != str(source_resolved)
            or intent.get("previous_state_root") != str(state_resolved)
            or intent.get("preserved_group_ledger_volume") != previous_ledger
            or intent.get("removed_containers") != pinned_containers
            or intent.get("mapping") != _archive_mapping(token, private_ledger=private_ledger)
            or (private_ledger and (
                intent.get("preserved_group_ledger_subpath") != ledger_binding["subpath"]
                or not _DEVICE_INODE.fullmatch(str(intent.get("preserved_group_ledger_device_inode", "")))
                or re.fullmatch(r"[0-9]+:[0-9]+", str(intent.get("preserved_group_ledger_owner", ""))) is None
                or re.fullmatch(r"[0-7]{3,4}", str(intent.get("preserved_group_ledger_mode", ""))) is None
                or not _DEVICE_INODE.fullmatch(str(intent.get("preserved_group_ledger_role_device_inode", "")))
                or intent.get("preserved_group_ledger_role_owner") != "65532:65532"
                or intent.get("preserved_group_ledger_role_mode") != "750"
            ))
            or (not private_ledger and (
                "preserved_group_ledger_subpath" in intent
                or "preserved_group_ledger_device_inode" in intent
                or "preserved_group_ledger_owner" in intent
                or "preserved_group_ledger_mode" in intent
                or "preserved_group_ledger_role_device_inode" in intent
                or "preserved_group_ledger_role_owner" in intent
                or "preserved_group_ledger_role_mode" in intent
            ))
            or not _DEVICE_INODE.fullmatch(str(intent.get("runtime_control_device_inode", "")))):
        _fail("Fresh-runtime archive intent no longer binds the retained roots")

    intent_sha256 = hashlib.sha256(intent_raw).hexdigest()
    _assert_only_operation_helper(control, helper_id)

    archive_evidence = _archive_runtime_control(
        helper_id, token, intent, verify_only=terminal_existing is not None,
    )

    for service, identifier in pinned_containers.items():
        _assert_exact_absence(identifier, service)
    _assert_only_operation_helper(control, helper_id)

    if terminal_existing is None:
        terminal = {
            "schema": "fullmag.docker-fresh-runtime-archive-terminal.v1",
            "state": "succeeded",
            "operation_attempt": token,
            "intent_sha256": intent_sha256,
            "compose_project": control.project,
            "control_volume": control.volume,
            "control_namespace": control.namespace,
            "removed_containers": pinned_containers,
            "mapping": intent["mapping"],
            "preserved_group_ledger_volume": previous_ledger,
            **({"preserved_group_ledger_subpath": intent["preserved_group_ledger_subpath"],
                "preserved_group_ledger_device_inode": intent["preserved_group_ledger_device_inode"],
                "preserved_group_ledger_owner": intent["preserved_group_ledger_owner"],
                "preserved_group_ledger_mode": intent["preserved_group_ledger_mode"],
                "preserved_group_ledger_role_device_inode": intent["preserved_group_ledger_role_device_inode"],
                "preserved_group_ledger_role_owner": intent["preserved_group_ledger_role_owner"],
                "preserved_group_ledger_role_mode": intent["preserved_group_ledger_role_mode"]}
               if private_ledger else {}),
            **archive_evidence,
            "finished_at": time.time(),
        }
        control.write(terminal_path, terminal)
        if control.read(terminal_path) != terminal:
            _fail("Fresh-runtime archive terminal receipt did not persist exactly")
    else:
        terminal = terminal_existing
        if (not isinstance(terminal, Mapping)
                or control.read_bytes(terminal_path) != canonical(terminal) + b"\n"
                or terminal.get("schema") != "fullmag.docker-fresh-runtime-archive-terminal.v1"
                or terminal.get("state") != "succeeded"
                or terminal.get("operation_attempt") != token
                or terminal.get("intent_sha256") != intent_sha256
                or terminal.get("compose_project") != control.project
                or terminal.get("control_volume") != control.volume
                or terminal.get("control_namespace", "") != control.namespace
                or terminal.get("removed_containers") != pinned_containers
                or terminal.get("mapping") != intent["mapping"]
                or terminal.get("preserved_group_ledger_volume") != previous_ledger
                or terminal.get("preserved_runtime_control_device_inode")
                    != intent["runtime_control_device_inode"]
                or any(terminal.get(key) != value for key, value in archive_evidence.items())
                or (private_ledger and (
                    terminal.get("preserved_group_ledger_subpath")
                        != intent["preserved_group_ledger_subpath"]
                    or terminal.get("preserved_group_ledger_device_inode")
                        != intent["preserved_group_ledger_device_inode"]
                    or terminal.get("archived_group_ledger_device_inode")
                        != intent["preserved_group_ledger_device_inode"]
                    or terminal.get("preserved_group_ledger_owner")
                        != intent["preserved_group_ledger_owner"]
                    or terminal.get("preserved_group_ledger_mode")
                        != intent["preserved_group_ledger_mode"]
                    or terminal.get("archived_group_ledger_owner")
                        != intent["preserved_group_ledger_owner"]
                    or terminal.get("archived_group_ledger_mode")
                        != intent["preserved_group_ledger_mode"]
                    or terminal.get("preserved_group_ledger_role_device_inode")
                        != intent["preserved_group_ledger_role_device_inode"]
                    or terminal.get("fresh_group_ledger_role_device_inode")
                        != intent["preserved_group_ledger_role_device_inode"]
                    or terminal.get("preserved_group_ledger_role_owner")
                        != intent["preserved_group_ledger_role_owner"]
                    or terminal.get("fresh_group_ledger_role_owner")
                        != intent["preserved_group_ledger_role_owner"]
                    or terminal.get("preserved_group_ledger_role_mode")
                        != intent["preserved_group_ledger_role_mode"]
                    or terminal.get("fresh_group_ledger_role_mode")
                        != intent["preserved_group_ledger_role_mode"]
                    or not _DEVICE_INODE.fullmatch(str(terminal.get("fresh_group_ledger_device_inode", "")))
                    or terminal.get("fresh_group_ledger_device_inode")
                        == intent["preserved_group_ledger_device_inode"]
                    or terminal.get("fresh_group_ledger_owner") != "65532:65532"
                ))
                or (not private_ledger and "fresh_group_ledger_device_inode" in terminal)):
            _fail("Fresh-runtime archive terminal differs from its exact durable intent")

    generation = {
        "schema": "fullmag.docker-group-ledger-generation.v1",
        "compose_project": control.project,
        "generation": token,
        "archive_terminal_path": terminal_path,
        "archive_terminal_sha256": hashlib.sha256(canonical(terminal)).hexdigest(),
        "preserved_volume": previous_ledger,
    }
    if private_ledger:
        generation.update({
            "preserved_subpath": intent["preserved_group_ledger_subpath"],
            "archived_group_ledger_path": intent["mapping"]["archived_group_ledger"],
        })
    previous_generation = control.read("group-ledger-generation.json", optional=True)
    if previous_generation not in (None, generation):
        # A prior pointer is expected when resuming before this archive reached
        # its terminal; a pointer to this token must already be exact.
        if isinstance(previous_generation, Mapping) and previous_generation.get("generation") == token:
            _fail("Fresh-runtime archive generation pointer changed after publication")
    control.write("group-ledger-generation.json", generation)
    if control.read("group-ledger-generation.json") != generation:
        _fail("Fresh-runtime archive generation pin did not persist exactly")
    return terminal
