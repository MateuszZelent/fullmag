"""Archive the prior native runtime-control tree for an explicit fresh start.

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
from pathlib import Path
import time

from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture
from docker_compose_identity import source_labels


_OPERATION_ID = re.compile(r"[0-9a-f]{32}\Z")
_CONTAINER_ID = re.compile(r"[0-9a-f]{64}\Z")
_ABSENT_CONTAINER = re.compile(
    r"(?:no such object|no such container):\s*([0-9a-f]{64})(?:\s|$)",
    re.IGNORECASE,
)


def _fail(message: str) -> None:
    raise BuildControlError(message)


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
old=/control/runtime-control
archives=/control/runtime-archives
target="$archives/$token"
active=/control/active
test ! -L /control
test "$(readlink -f /control)" = /control
test ! -L "$old"
test -d "$old"
test "$(readlink -f "$old")" = "$old"
services="$old/runtime-services"
test ! -L "$services"
test -d "$services"
test "$(readlink -f "$services")" = "$services"
test ! -L "$active"
test -f "$active"
test "$(stat -c %h "$active")" = 1
test "$(wc -c < "$active")" -eq 33
test "$(cat "$active")" = "$token"
active_sha=$(sha256sum "$active" | cut -d' ' -f1)
old_inode=$(stat -c '%d:%i' "$old")
if test -L "$archives"; then exit 71; fi
if test -e "$archives"; then
  test -d "$archives"
  test "$(readlink -f "$archives")" = "$archives"
else
  mkdir -m 0750 "$archives"
fi
test ! -e "$target"
test ! -L "$target"
test "$(stat -c %d "$old")" = "$(stat -c %d "$archives")"

held_locks=
owner_lock="$services/OWNER.lock"
if test -L "$owner_lock"; then exit 72; fi
if test -e "$owner_lock"; then
  test -f "$owner_lock" && test "$(stat -c %h "$owner_lock")" = 1
  exec 10< "$owner_lock"
  flock -n -x 10
  held_locks="OWNER.lock"
fi
launch_lock="$services/LAUNCH.lock"
if test -L "$launch_lock"; then exit 73; fi
if test -e "$launch_lock"; then
  test -f "$launch_lock" && test "$(stat -c %h "$launch_lock")" = 1
  exec 11< "$launch_lock"
  flock -n -x 11
  if test -n "$held_locks"; then held_locks="$held_locks,LAUNCH.lock"; else held_locks="LAUNCH.lock"; fi
fi
startup_lock="$services/STARTUP-GATE.lock"
if test -L "$startup_lock"; then exit 74; fi
if test -e "$startup_lock"; then
  test -f "$startup_lock" && test "$(stat -c %h "$startup_lock")" = 1
  exec 12< "$startup_lock"
  flock -n -x 12
  if test -n "$held_locks"; then held_locks="$held_locks,STARTUP-GATE.lock"; else held_locks="STARTUP-GATE.lock"; fi
fi

mv -T -- "$old" "$target"
archived_inode=$(stat -c '%d:%i' "$target")
test "$archived_inode" = "$old_inode"
mkdir -m 0750 /control/runtime-control
mkdir -m 0750 /control/runtime-control/runtime-services
test "$(readlink -f /control/runtime-control)" = /control/runtime-control
test "$(readlink -f /control/runtime-control/runtime-services)" = /control/runtime-control/runtime-services
test "$(find /control/runtime-control -mindepth 1 -maxdepth 1 -type d -name runtime-services -print -quit)" = /control/runtime-control/runtime-services
test "$(find /control/runtime-control -mindepth 1 -maxdepth 1 -print | wc -l)" -eq 1
test -z "$(find /control/runtime-control/runtime-services -mindepth 1 -maxdepth 1 -print -quit)"
test ! -L "$active"
test "$(stat -c %h "$active")" = 1
test "$(wc -c < "$active")" -eq 33
test "$(cat "$active")" = "$token"
test "$(sha256sum "$active" | cut -d' ' -f1)" = "$active_sha"
fresh_inode=$(stat -c '%d:%i' /control/runtime-control)
services_inode=$(stat -c '%d:%i' /control/runtime-control/runtime-services)
sync /control/runtime-archives
sync "$target"
sync /control/runtime-control/runtime-services
sync /control/runtime-control
sync /control
printf 'ARCHIVED\t%s\t%s\t%s\t%s\t%s\n' "$archived_inode" "$fresh_inode" "$services_inode" "$active_sha" "${held_locks:--}"
'''


def _archive_runtime_control(helper_id: str, token: str) -> dict[str, object]:
    script = _ARCHIVE_SCRIPT.replace("TOKEN", token)
    result = docker_capture(
        "exec", helper_id, "/bin/bash", "-euo", "pipefail", "-c", script,
        timeout=90,
    )
    lines = result.stdout.decode("ascii", "strict").splitlines()
    if len(lines) != 1:
        _fail("Fresh-runtime archive helper returned an ambiguous receipt")
    fields = lines[0].split("\t")
    if len(fields) != 6 or fields[0] != "ARCHIVED":
        _fail("Fresh-runtime archive helper did not confirm the atomic rename")
    inode_fields = fields[1:4]
    if any(re.fullmatch(r"[0-9]+:[0-9]+", value) is None for value in inode_fields):
        _fail("Fresh-runtime archive helper returned malformed directory identities")
    if re.fullmatch(r"[0-9a-f]{64}", fields[4]) is None:
        _fail("Fresh-runtime archive helper returned a malformed active-marker digest")
    locks = [] if fields[5] == "-" else fields[5].split(",")
    if any(value not in {"OWNER.lock", "LAUNCH.lock", "STARTUP-GATE.lock"} for value in locks):
        _fail("Fresh-runtime archive helper returned malformed lock evidence")
    return {
        "archived_runtime_control_device_inode": inode_fields[0],
        "fresh_runtime_control_device_inode": inode_fields[1],
        "fresh_runtime_services_device_inode": inode_fields[2],
        "active_marker_sha256": fields[4],
        "locked_runtime_service_files": locks,
    }


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

    # A fresh session must not inherit reservations from the archived runtime.
    # Keep that ledger intact and select a new named volume for this generation.
    from docker_group_ledger import is_group_ledger_mount
    retained_pair = control.read(operation["root"] + "/retained-containers.json")
    ledger_mounts = [mount for mount in retained_pair["backend"].get("Mounts", [])
                     if is_group_ledger_mount(mount)]
    if len(ledger_mounts) != 1:
        _fail("Fresh runtime requires exactly one group-owned DEV ledger")
    previous_ledger = ledger_mounts[0]["Name"]
    if _container_ids("--filter", "volume=" + previous_ledger):
        _fail("Archived group ledger still has a container consumer")

    intent_path = operation["root"] + "/runtime-control-archive-intent.json"
    terminal_path = operation["root"] + "/runtime-control-archive-terminal.json"
    if control.read(intent_path, optional=True) is not None or control.read(terminal_path, optional=True) is not None:
        _fail("Fresh-runtime archive attempt already has intent or terminal evidence")

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
        "mapping": {
            "previous_runtime_control": "runtime-control",
            "archived_runtime_control": "runtime-archives/" + token,
            "fresh_runtime_control": "runtime-control",
            "fresh_runtime_services": "runtime-control/runtime-services",
        },
        "created_at": time.time(),
    }
    intent_sha256 = hashlib.sha256(canonical(intent) + b"\n").hexdigest()
    control.write(intent_path, intent)
    if control.read(intent_path) != intent:
        _fail("Fresh-runtime archive intent did not persist exactly")

    _assert_only_operation_helper(control, helper_id)
    archive_evidence = _archive_runtime_control(helper_id, token)

    for service, identifier in pinned_containers.items():
        _assert_exact_absence(identifier, service)
    _assert_only_operation_helper(control, helper_id)

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
        **archive_evidence,
        "finished_at": time.time(),
    }
    control.write(terminal_path, terminal)
    if control.read(terminal_path) != terminal:
        _fail("Fresh-runtime archive terminal receipt did not persist exactly")
    control.write("group-ledger-generation.json", {
        "schema": "fullmag.docker-group-ledger-generation.v1",
        "compose_project": control.project,
        "generation": token,
        "archive_terminal_path": terminal_path,
        "archive_terminal_sha256": hashlib.sha256(canonical(terminal)).hexdigest(),
        "preserved_volume": previous_ledger,
    })
    return terminal
