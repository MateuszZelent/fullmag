#!/usr/bin/env python3
"""Run package retention inside the selected stopped Docker DEV group.

The launcher has no image override. It first authenticates the selected group
through the existing ``docker_dev_up`` discovery path, then holds the normal
``BuildControl.operation`` lease while invoking the retained ``backend``
service. It never builds an image, starts application services, or writes
build data to host storage.
"""

from __future__ import annotations

import argparse
from collections.abc import Mapping
import hashlib
import json
from pathlib import Path
import re
import sys
import time
from types import SimpleNamespace

from docker_build_control import (
    BuildControlError,
    ControlOutcomeUnknown,
    MIN_FREE_CONTROL_BYTES,
    canonical,
    compose_capture,
    docker_capture,
    _publish_operation_records,
)
from docker_dev_host import require_host


SHA256_RE = r"[0-9a-f]{64}"
ATTEMPT_RE = r"[0-9a-f]{32}"
RETENTION_REPORT_SCHEMA = "fullmag.direct-compose.package-retention-operation.v1"
PACKAGE_ROOT = "/opt/fullmag/package"
RETENTION_CONTAINER_LABEL_SCHEMA = "fullmag.direct-compose.package-retention-container.v1"


def _fail(message: str) -> BuildControlError:
    return BuildControlError(message)


def _sha(value: object) -> str:
    # The backend mirrors this exact no-newline CAS encoding in
    # ``backend_dev._canonical_cas``.  Do not use record-output encoding here.
    return hashlib.sha256(canonical(value)).hexdigest()


def _json_document(raw: bytes, label: str) -> Mapping[str, object]:
    """Read the last canonical JSON object from bounded Compose output."""

    for line in reversed(raw.decode("utf-8", "replace").splitlines()):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, Mapping):
            return value
    raise _fail(f"{label} is not a valid JSON object")


def _group_plan_sha256(backend_plan_sha256: str, inputs_sha256: str) -> str:
    if not re.fullmatch(SHA256_RE, backend_plan_sha256) or not re.fullmatch(
        SHA256_RE, inputs_sha256
    ):
        raise _fail("retention group-plan inputs must be lowercase SHA-256 digests")
    return _sha(
        {
            "backend_plan_sha256": backend_plan_sha256,
            "operation_inputs_sha256": inputs_sha256,
        }
    )


def _nonnegative_int(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise _fail(f"backend package retention report has invalid {label}")
    return value


def _validate_report(
    report: Mapping[str, object],
    expected_state: str,
    inputs_sha256: str,
    expected_plan_sha256: str | None = None,
    expected_group_plan_sha256: str | None = None,
) -> Mapping[str, object]:
    """Validate the backend report before it enters the external receipt."""

    if not isinstance(report, Mapping):
        raise _fail("backend package retention report is not an object")
    if report.get("schema") != RETENTION_REPORT_SCHEMA:
        raise _fail("backend package retention report schema is invalid")
    if report.get("state") != expected_state:
        raise _fail("backend package retention returned an unexpected state")
    if report.get("package_root") != PACKAGE_ROOT:
        raise _fail("backend package retention report package root is invalid")
    plan_sha256 = report.get("plan_sha256")
    if not isinstance(plan_sha256, str) or not re.fullmatch(SHA256_RE, plan_sha256):
        raise _fail("backend package retention report plan sha256 is invalid")
    if expected_plan_sha256 is not None and plan_sha256 != expected_plan_sha256:
        raise _fail("backend package retention report plan sha256 differs from requested plan")
    if report.get("operation_inputs_sha256") != inputs_sha256:
        raise _fail("backend package retention report is not bound to group inputs")
    expected_group_plan = _group_plan_sha256(plan_sha256, inputs_sha256)
    if (
        expected_group_plan_sha256 is not None
        and expected_group_plan_sha256 != expected_group_plan
    ):
        raise _fail("backend package retention group plan differs from requested plan")
    if report.get("group_plan_sha256") != expected_group_plan:
        raise _fail("backend package retention group plan sha256 is invalid")
    if report.get("scope") != "obsolete-backup-trees":
        raise _fail("backend package retention report scope is invalid")
    before = _nonnegative_int(
        report.get("scope_allocated_bytes_before"),
        "scope_allocated_bytes_before",
    )
    after = _nonnegative_int(
        report.get("scope_allocated_bytes_after"),
        "scope_allocated_bytes_after",
    )
    if report.get("scope_allocated_bytes_delta") != before - after:
        raise _fail("backend package retention scoped byte delta is invalid")
    available_before = _nonnegative_int(
        report.get("filesystem_available_bytes_before"),
        "filesystem_available_bytes_before",
    )
    available_after = _nonnegative_int(
        report.get("filesystem_available_bytes_after"),
        "filesystem_available_bytes_after",
    )
    if report.get("filesystem_available_bytes_delta") != available_after - available_before:
        raise _fail("backend package retention filesystem byte delta is invalid")
    if report.get("filesystem_available_delta_is_observed_only") is not True:
        raise _fail("backend package retention filesystem delta is not marked observed-only")
    allocation = report.get("allocation")
    if not isinstance(allocation, Mapping) or allocation.get("scope") != report.get("scope"):
        raise _fail("backend package retention allocation scope is invalid")
    if allocation.get("allocated_bytes_before") != before:
        raise _fail("backend package retention allocation before value is unbound")
    return report


def _service_volume_pins(document: Mapping[str, object]) -> dict[str, object]:
    services = document.get("services")
    declared = document.get("volumes")
    if not isinstance(services, Mapping) or not isinstance(declared, Mapping):
        raise _fail("retained Compose document has no canonical services/volumes")
    pins: dict[str, list[dict[str, object]]] = {}
    for service_name in ("backend", "frontend"):
        service = services.get(service_name)
        mounts = service.get("volumes") if isinstance(service, Mapping) else None
        if not isinstance(mounts, list):
            raise _fail(f"retained {service_name} service has no volume list")
        service_pins: list[dict[str, object]] = []
        for mount in mounts:
            if not isinstance(mount, Mapping):
                raise _fail(f"retained {service_name} volume mount is malformed")
            source = mount.get("source")
            target = mount.get("target")
            mount_type = mount.get("type")
            if not all(isinstance(value, str) and value for value in (source, target, mount_type)):
                raise _fail(f"retained {service_name} volume mount is not pinned")
            pin = {
                "source": source,
                "target": target,
                "type": mount_type,
                "read_only": bool(mount.get("read_only", False)),
            }
            if mount_type == "volume":
                volume = declared.get(source)
                if not isinstance(volume, Mapping) or not isinstance(volume.get("name"), str):
                    raise _fail(f"retained named volume is not resolved: {source}")
                pin["name"] = volume["name"]
                if "subpath" in mount:
                    pin["subpath"] = mount["subpath"]
            elif mount_type == "bind":
                pin["bind"] = mount.get("bind", {})
            else:
                raise _fail(f"retained service has unsupported volume type: {mount_type}")
            service_pins.append(pin)
        pins[service_name] = service_pins
    descriptor = {"services": pins, "declared": declared}
    return {**descriptor, "sha256": _sha(descriptor)}


def _image_labels(image_id: str, label: str) -> Mapping[str, object]:
    try:
        records = json.loads(docker_capture("image", "inspect", image_id, timeout=60).stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _fail(f"{label} image inspection is not valid JSON") from error
    if not isinstance(records, list) or len(records) != 1 or not isinstance(records[0], Mapping):
        raise _fail(f"{label} image identity is ambiguous")
    config = records[0].get("Config")
    labels = config.get("Labels") if isinstance(config, Mapping) else None
    if not isinstance(labels, Mapping):
        raise _fail(f"{label} image has no labels")
    return labels


def _receipt_pin(receipt: Mapping[str, object], phase: str) -> dict[str, object]:
    image_id = receipt.get("image_id")
    source_digest = receipt.get("source_digest")
    inputs = receipt.get("inputs")
    if (receipt.get("phase") != phase or receipt.get("state") != "succeeded"
            or not isinstance(image_id, str) or not re.fullmatch(r"sha256:" + SHA256_RE, image_id)
            or not isinstance(source_digest, str)
            or not re.fullmatch(SHA256_RE, source_digest)
            or not isinstance(inputs, Mapping)):
        raise _fail(f"verified {phase} receipt is incomplete")
    if _sha(inputs) != source_digest:
        raise _fail(f"verified {phase} receipt input digest is invalid")
    return {
        "phase": phase,
        "image_id": image_id,
        "source_digest": source_digest,
        "inputs_sha256": _sha(inputs),
        "receipt_sha256": _sha(receipt),
    }


def _operation_inputs(group) -> dict[str, object]:
    """Build the complete CAS identity for the retained group."""

    from docker_dev_up import _build_inputs_match, _verified_build_receipt

    # Refuse source/image drift rather than running maintenance against an
    # image-owned helper from another checkout or a stale source snapshot.
    _build_inputs_match(group)
    toolchain = _verified_build_receipt(group, "toolchain/verified.json", "toolchain")
    development = _verified_build_receipt(group, "image-dev/verified.json", "image-dev")
    backend = _verified_build_receipt(group, "image-backend/verified.json", "image-backend")
    services = group.document.get("services")
    if not isinstance(services, Mapping):
        raise _fail("retained Compose document has no service map")
    backend_service = services.get("backend")
    frontend_service = services.get("frontend")
    if not isinstance(backend_service, Mapping) or not isinstance(frontend_service, Mapping):
        raise _fail("retained Compose document lacks backend/frontend")
    backend_id = backend["image_id"]
    if backend_service.get("image") != backend_id:
        raise _fail("backend service image is not bound to image-backend/verified.json")
    terminal_inputs = group.terminal.get("inputs")
    if not isinstance(terminal_inputs, Mapping) or terminal_inputs.get("image_id") != backend_id:
        raise _fail("development terminal image is not bound to image-backend/verified.json")
    frontend_id = frontend_service.get("image")
    if not isinstance(frontend_id, str) or not re.fullmatch(r"sha256:" + SHA256_RE, frontend_id):
        raise _fail("frontend service image is not immutable")
    backend_labels = _image_labels(backend_id, "backend")
    frontend_labels = _image_labels(frontend_id, "frontend")
    current = group.control.read("development/current.json")
    if not isinstance(current, Mapping):
        raise _fail("development/current.json is not an object")
    volume_pins = _service_volume_pins(group.document)
    return {
        "schema": "fullmag.direct-compose.package-retention-inputs.v1",
        "operation": "package-retention",
        "compose_project": group.identity["project_name"],
        "compose_config_sha256": group.config_sha256,
        "compose_document_sha256": _sha(group.document),
        "development_attempt": group.attempt,
        "development_terminal_receipt_sha256": _sha(group.terminal),
        "development_current_receipt_sha256": _sha(current),
        "source": {
            "root": str(group.source_root),
            "project_id": group.identity["project_id"],
            "worktree_id": group.identity["worktree_id"],
            "checkout_kind": group.identity["checkout_kind"],
            "commit": terminal_inputs.get("source_commit"),
            "source_digest": group.terminal.get("source_digest"),
        },
        "images": {
            "toolchain": _receipt_pin(toolchain, "toolchain"),
            "development": _receipt_pin(development, "image-dev"),
            "backend": _receipt_pin(backend, "image-backend"),
            "frontend": {"image_id": frontend_id, "labels_sha256": _sha(frontend_labels)},
            "backend_labels_sha256": _sha(backend_labels),
        },
        "volumes": volume_pins,
        "control_volume": group.control.volume,
        "network": {
            "name": group.identity["network_name"],
            "sha256": _sha(group.document.get("networks", {})),
        },
        "service_labels_sha256": {
            name: _sha(services[name].get("labels", {}))
            for name in ("backend", "frontend")
        },
    }


def _selected_group(args: argparse.Namespace):
    from docker_dev_up import _discover_group

    discovery_args = SimpleNamespace(
        repo_root=args.repo_root,
        source_root=args.source_root,
        port=None,
        port_explicit=False,
    )
    group = _discover_group(discovery_args)
    if group is None:
        raise _fail("package retention requires the selected group's stopped backend/frontend containers")
    if group.backend_running or group.frontend_running:
        raise _fail("package retention requires both selected Compose services to be stopped")
    return group


def _selected_context(args: argparse.Namespace):
    """Resolve the selected group context without discovering active services."""

    from docker_dev_up import _selected_context as resolve_context

    context_args = SimpleNamespace(
        repo_root=args.repo_root,
        source_root=args.source_root,
        port=None,
        port_explicit=False,
    )
    return resolve_context(context_args)


def _retention_container_contract(
    group,
    inputs: Mapping[str, object],
    operation: Mapping[str, object],
    *,
    expected_state: str,
    plan_sha256: str | None,
    group_plan_sha256: str | None,
) -> dict[str, object]:
    """Bind the one-off Compose container to the immutable selected group."""

    identity = group.identity
    project = identity.get("project_name")
    if group.document.get("name") != project:
        raise _fail("retention container Compose project differs from selected identity")
    attempt = operation.get("receipt", {}).get("attempt") if isinstance(
        operation.get("receipt"), Mapping
    ) else None
    if not isinstance(project, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project):
        raise _fail("retention container project identity is invalid")
    if not isinstance(attempt, str) or not re.fullmatch(ATTEMPT_RE, attempt):
        raise _fail("retention container attempt identity is invalid")
    images = inputs.get("images")
    backend_image = images.get("backend", {}).get("image_id") if isinstance(images, Mapping) else None
    services = group.document.get("services")
    backend_service = services.get("backend") if isinstance(services, Mapping) else None
    if (
        not isinstance(backend_image, str)
        or not re.fullmatch(r"sha256:" + SHA256_RE, backend_image)
        or not isinstance(backend_service, Mapping)
        or backend_service.get("image") != backend_image
    ):
        raise _fail("retention container image is not bound to the verified backend")
    volumes = inputs.get("volumes")
    backend_mounts = volumes.get("services", {}).get("backend") if isinstance(volumes, Mapping) else None
    network = inputs.get("network")
    if not isinstance(backend_mounts, list) or not isinstance(network, Mapping):
        raise _fail("retention container mounts or network are not pinned")
    network_name = network.get("name")
    if not isinstance(network_name, str) or not network_name:
        raise _fail("retention container network is not pinned")
    operation_inputs_sha256 = inputs.get("operation_inputs_sha256")
    if not isinstance(operation_inputs_sha256, str):
        operation_inputs_sha256 = _sha(inputs)
    labels = {
        "org.fullmag.package-retention.schema": RETENTION_CONTAINER_LABEL_SCHEMA,
        "org.fullmag.package-retention.attempt": attempt,
        "org.fullmag.package-retention.inputs-sha256": operation_inputs_sha256,
        "org.fullmag.package-retention.control-volume": group.control.volume,
        "org.fullmag.package-retention.project": project,
    }
    service_labels = backend_service.get("labels", {})
    if not isinstance(service_labels, Mapping):
        raise _fail("retained backend labels are not a mapping")
    service_labels = {
        str(key): str(value) for key, value in service_labels.items()
    }
    name = f"fullmag-package-retention-{project}-{attempt}"
    return {
        "schema": RETENTION_CONTAINER_LABEL_SCHEMA,
        "name": name,
        "project": project,
        "service": "backend",
        "attempt": attempt,
        "image": backend_image,
        "image_labels_sha256": inputs.get("images", {}).get("backend_labels_sha256")
        if isinstance(inputs.get("images"), Mapping)
        else None,
        "labels": labels,
        "service_labels": service_labels,
        "mounts": backend_mounts,
        "network": network_name,
        "control_volume": group.control.volume,
        "operation_inputs_sha256": operation_inputs_sha256,
        "expected_state": expected_state,
        "plan_sha256": plan_sha256,
        "group_plan_sha256": group_plan_sha256,
    }


def _mount_signature(mount: Mapping[str, object], *, observed: bool) -> dict[str, object]:
    if observed:
        mount_type = mount.get("Type")
        target = mount.get("Destination")
        read_only = not bool(mount.get("RW", True))
    else:
        mount_type = mount.get("type")
        target = mount.get("target")
        read_only = bool(mount.get("read_only", False))
    if not isinstance(mount_type, str) or not isinstance(target, str) or not target:
        raise _fail("retention container mount identity is invalid")
    signature: dict[str, object] = {
        "type": mount_type,
        "target": target,
        "read_only": read_only,
    }
    if mount_type == "volume":
        value = mount.get("Name" if observed else "name")
        if not isinstance(value, str) or not value:
            raise _fail("retention container named volume identity is invalid")
        signature["name"] = value
    elif mount_type == "bind":
        value = mount.get("Source" if observed else "source")
        if not isinstance(value, str) or not value:
            raise _fail("retention container bind identity is invalid")
        signature["source"] = value
    else:
        raise _fail("retention container has an unsupported mount type")
    return signature


def _container_absent(result) -> bool:
    text = (result.stdout + result.stderr).decode("utf-8", "replace").lower()
    return result.returncode != 0 and (
        "no such object" in text or "no such container" in text
    )


def _retention_container_is_absent(contract: Mapping[str, object]) -> bool:
    """Prove absence from a successful Docker response, or retain unknown."""

    name = contract.get("name")
    if not isinstance(name, str) or not name:
        raise _fail("retention container contract has no name")
    try:
        result = docker_capture("inspect", name, allow_failure=True, timeout=60)
    except OSError as error:
        raise ControlOutcomeUnknown(
            "Docker could not confirm whether the managed package-retention container exists"
        ) from error
    if _container_absent(result):
        return True
    if result.returncode:
        raise ControlOutcomeUnknown(
            "Docker could not confirm whether the managed package-retention container exists"
        )
    return False


def _inspect_retention_container(contract: Mapping[str, object]) -> Mapping[str, object]:
    """Inspect and authenticate the exact terminal one-off before cleanup."""

    name = contract.get("name")
    if not isinstance(name, str) or not name:
        raise _fail("retention container contract has no name")
    result = docker_capture("inspect", name, allow_failure=True, timeout=60)
    if result.returncode:
        if _container_absent(result):
            raise ControlOutcomeUnknown(
                "managed package-retention container disappeared before terminal proof"
            )
        raise ControlOutcomeUnknown(
            "Docker could not inspect the managed package-retention container"
        )
    try:
        values = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ControlOutcomeUnknown(
            "managed package-retention container inspection is not valid JSON"
        ) from error
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], Mapping):
        raise ControlOutcomeUnknown("managed package-retention container identity is ambiguous")
    document = values[0]
    state = document.get("State")
    if not isinstance(state, Mapping) or state.get("Running") is not False:
        raise ControlOutcomeUnknown(
            "managed package-retention container has no terminal state"
        )
    exit_code = state.get("ExitCode")
    if isinstance(exit_code, bool) or not isinstance(exit_code, int):
        raise ControlOutcomeUnknown(
            "managed package-retention container has no terminal exit code"
        )
    labels = document.get("Config", {}).get("Labels") if isinstance(document.get("Config"), Mapping) else None
    required_labels = contract.get("labels")
    if not isinstance(labels, Mapping) or not isinstance(required_labels, Mapping):
        raise _fail("managed package-retention container labels are missing")
    if any(labels.get(key) != value for key, value in required_labels.items()):
        raise _fail("managed package-retention container labels differ")
    if (
        labels.get("com.docker.compose.project") != contract.get("project")
        or labels.get("com.docker.compose.service") != "backend"
    ):
        raise _fail("managed package-retention Compose labels differ")
    if document.get("Name", "").lstrip("/") != name:
        raise _fail("managed package-retention container name differs")
    if document.get("Image") != contract.get("image"):
        raise _fail("managed package-retention container image differs")
    expected_image_labels_sha256 = contract.get("image_labels_sha256")
    if not isinstance(expected_image_labels_sha256, str) or not re.fullmatch(
        SHA256_RE, expected_image_labels_sha256
    ):
        raise _fail("managed package-retention image label pin is missing")
    if _sha(_image_labels(str(contract["image"]), "managed backend")) != expected_image_labels_sha256:
        raise _fail("managed package-retention image labels differ")
    expected_service_labels = contract.get("service_labels")
    if not isinstance(expected_service_labels, Mapping) or any(
        labels.get(key) != value for key, value in expected_service_labels.items()
    ):
        raise _fail("managed package-retention service labels differ")
    mounts = document.get("Mounts")
    expected_mounts = contract.get("mounts")
    if not isinstance(mounts, list) or not isinstance(expected_mounts, list):
        raise _fail("managed package-retention mount inventory is missing")
    if any(not isinstance(value, Mapping) for value in mounts) or any(
        not isinstance(value, Mapping) for value in expected_mounts
    ):
        raise _fail("managed package-retention mount entry is malformed")
    actual_mounts = sorted(
        (_mount_signature(value, observed=True) for value in mounts),
        key=lambda value: str(value["target"]),
    )
    expected_signatures = sorted(
        (_mount_signature(value, observed=False) for value in expected_mounts),
        key=lambda value: str(value["target"]),
    )
    if actual_mounts != expected_signatures:
        raise _fail("managed package-retention mount pins differ")
    networks = document.get("NetworkSettings", {}).get("Networks") if isinstance(
        document.get("NetworkSettings"), Mapping
    ) else None
    if not isinstance(networks, Mapping) or set(networks) != {contract.get("network")}:
        raise _fail("managed package-retention network pins differ")
    return document


def _retention_container_logs(name: str) -> bytes:
    result = docker_capture("logs", name, timeout=60)
    return result.stdout + result.stderr


def _remove_retention_container(contract: Mapping[str, object]) -> None:
    name = contract.get("name")
    if not isinstance(name, str) or not name:
        raise _fail("retention container contract has no name")
    result = docker_capture("rm", name, allow_failure=True, timeout=60)
    if result.returncode and not _container_absent(result):
        raise ControlOutcomeUnknown(
            "Docker could not remove the terminal managed package-retention container"
        )
    confirmation = docker_capture("inspect", name, allow_failure=True, timeout=60)
    if not _container_absent(confirmation):
        raise ControlOutcomeUnknown(
            "managed package-retention container removal was not confirmed"
        )


def _write_operation_receipt(control, operation: Mapping[str, object]) -> None:
    receipt = operation.get("receipt")
    root = operation.get("root")
    if not isinstance(receipt, Mapping) or not isinstance(root, str):
        raise _fail("package-retention operation receipt is incomplete")
    control.write(root + "/receipt.json", receipt)


def _wait_for_control_active_clear(control, timeout: float = 30.0) -> None:
    """Wait for the existing BuildControl helper to consume terminal.json."""

    from docker_dev_up import _control_file_exists

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _control_file_exists(control, "active"):
            return
        time.sleep(0.2)
    raise ControlOutcomeUnknown(
        "package-retention terminal receipt was written but the control lease remains active"
    )


def _run_managed_retention_container(
    group,
    control,
    operation: dict[str, object],
    inputs: Mapping[str, object],
    command: list[str],
    *,
    expected_state: str,
    plan_sha256: str | None,
    group_plan_sha256: str | None,
) -> Mapping[str, object]:
    """Run one named container and retain an exact recovery path on uncertainty."""

    contract = _retention_container_contract(
        group,
        inputs,
        operation,
        expected_state=expected_state,
        plan_sha256=plan_sha256,
        group_plan_sha256=group_plan_sha256,
    )
    receipt = operation["receipt"]
    receipt.update(
        daemon_pending=True,
        managed_container=contract,
        managed_container_state="starting",
    )
    operation["daemon_pending"] = True
    _write_operation_receipt(control, operation)
    run_args = [
        "run",
        "--name",
        str(contract["name"]),
    ]
    for key, value in contract["labels"].items():
        run_args.extend(("--label", f"{key}={value}"))
    run_args.extend(("--no-deps", "backend", *command))
    output: bytes | None = None
    original_error: BaseException | None = None
    try:
        output = compose_capture(group.document, *run_args, timeout=300)
    except BaseException as error:
        original_error = error
    try:
        observed = _inspect_retention_container(contract)
    except ControlOutcomeUnknown as error:
        if original_error is not None and _retention_container_is_absent(contract):
            receipt.update(
                managed_container_state="absent-after-launch-error",
                launch_error=str(original_error),
                effects_unknown=True,
                verification="NOT VERIFIED",
            )
            _write_operation_receipt(control, operation)
            raise ControlOutcomeUnknown(
                "Compose failed and exact container absence is confirmed; operation effects remain unknown"
            ) from error
        raise
    try:
        exit_code = observed.get("State", {}).get("ExitCode")
        if isinstance(exit_code, bool) or not isinstance(exit_code, int):
            raise ControlOutcomeUnknown("managed package-retention exit code is not terminal")
        if output is None and exit_code == 0:
            output = _retention_container_logs(str(contract["name"]))
        if exit_code != 0:
            _remove_retention_container(contract)
            receipt.update(
                daemon_pending=True,
                managed_container_state="removed",
                managed_container_exit_code=exit_code,
                effects_unknown=True,
                verification="NOT VERIFIED",
            )
            _write_operation_receipt(control, operation)
            if original_error is None:
                raise _fail(f"managed package-retention container exited with {exit_code}")
            raise _fail(
                f"managed package-retention container exited with {exit_code}: {original_error}"
            ) from original_error
        if output is None:
            raise ControlOutcomeUnknown(
                "managed package-retention container completed without captured output"
            )
        report = _json_document(output, "backend package retention report")
        # Make the backend result recoverable before removing the named
        # container.  If the following removal observation is interrupted,
        # reconciliation can authenticate the durable report and finish the
        # exact container cleanup without starting a second operation.
        control.write(operation["root"] + "/report.json", report)
        _remove_retention_container(contract)
        receipt.update(
            daemon_pending=True,
            managed_container_state="removed",
            managed_container_exit_code=exit_code,
        )
        _write_operation_receipt(control, operation)
        return report
    except ControlOutcomeUnknown:
        raise
    except BaseException:
        # A terminal but malformed report remains explicitly recoverable: keep
        # the named container and the operation lease for a later reconcile.
        raise


def _reconcile_active_operation(control, attempt: str, args: argparse.Namespace) -> int:
    """Resume exactly one retained operation after a Docker transport failure."""

    if not re.fullmatch(ATTEMPT_RE, attempt):
        raise _fail("retention reconciliation requires one exact operation attempt")
    root = f"package-retention/attempts/{attempt}"
    receipt = control.read(root + "/receipt.json")
    terminal = control.read(root + "/terminal.json", optional=True)
    active_unknown = (
        isinstance(receipt, Mapping)
        and receipt.get("phase") == "package-retention"
        and receipt.get("attempt") == attempt
        and receipt.get("state") in {"starting", "outcome-unknown-resources-retained"}
        and receipt.get("daemon_pending") is True
    )
    final_publication_pending = (
        isinstance(receipt, Mapping)
        and receipt.get("phase") == "package-retention"
        and receipt.get("attempt") == attempt
        and receipt.get("state") == "succeeded"
        and receipt.get("daemon_pending") is False
        and receipt.get("managed_container_state") == "removed"
        and terminal is None
    )
    if not active_unknown and not final_publication_pending:
        raise _fail("retention reconciliation receipt is not an active unknown operation")
    contract = receipt.get("managed_container")
    if (
        not isinstance(contract, Mapping)
        or contract.get("control_volume") != control.volume
        or contract.get("project") != control.project
        or contract.get("service") != "backend"
        or contract.get("expected_state") not in {"dry-run", "applied"}
    ):
        raise _fail("retention reconciliation container contract is not group-bound")
    inputs_sha256 = contract.get("operation_inputs_sha256")
    if not isinstance(inputs_sha256, str):
        raise _fail("retention reconciliation has no operation input digest")
    report = control.read(root + "/report.json", optional=True)
    if final_publication_pending:
        if not isinstance(report, Mapping):
            raise ControlOutcomeUnknown(
                "final package-retention receipt has no durable report"
            )
        if (
            receipt.get("report_sha256") != _sha(report)
            or receipt.get("operation_inputs_sha256") != inputs_sha256
            or receipt.get("backend_plan_sha256") != report.get("plan_sha256")
            or receipt.get("group_plan_sha256") != report.get("group_plan_sha256")
        ):
            raise ControlOutcomeUnknown(
                "final package-retention receipt is not bound to its durable report"
            )
        # The final receipt is only an idempotent publication recovery path.
        # It must never replay cleanup; the prior operation must already have
        # proved that its exact managed helper is absent.
        if not _retention_container_is_absent(contract):
            raise ControlOutcomeUnknown(
                "final package-retention receipt cannot prove managed container absence"
            )
    if report is None:
        if receipt.get("managed_container_state") == "absent-after-launch-error":
            if not _retention_container_is_absent(contract):
                raise ControlOutcomeUnknown(
                    "retention launch-error container is present again"
                )
            receipt = dict(receipt)
            receipt.update(
                state="failed-confirmed",
                daemon_pending=False,
                error="Compose launch failed; container absence is confirmed but effects remain unknown",
                effects_unknown=True,
                verification="NOT VERIFIED",
            )
            _publish_operation_records(control, "package-retention", root, receipt)
            _wait_for_control_active_clear(control)
            return 2
        if (
            receipt.get("managed_container_state") == "removed"
            and receipt.get("managed_container_exit_code") not in (None, 0)
        ):
            if not _retention_container_is_absent(contract):
                raise ControlOutcomeUnknown(
                    "retention failure container is present again"
                )
            receipt = dict(receipt)
            receipt.update(
                state="failed-confirmed",
                daemon_pending=False,
                error="managed package-retention container exited unsuccessfully; effects remain unknown",
                effects_unknown=True,
                verification="NOT VERIFIED",
            )
            _publish_operation_records(control, "package-retention", root, receipt)
            _wait_for_control_active_clear(control)
            return 2
        observed = _inspect_retention_container(contract)
        exit_code = observed.get("State", {}).get("ExitCode")
        if exit_code != 0:
            _remove_retention_container(contract)
            receipt = dict(receipt)
            receipt.update(
                state="failed-confirmed",
                daemon_pending=False,
                error=f"managed package-retention container exited with {exit_code}",
                managed_container_state="removed",
                effects_unknown=True,
                verification="NOT VERIFIED",
            )
            _publish_operation_records(control, "package-retention", root, receipt)
            _wait_for_control_active_clear(control)
            return 2
        report = _json_document(
            _retention_container_logs(str(contract["name"])),
            "reconciled backend package retention report",
        )
        # Persist the recovered output before removing the terminal container;
        # if the following Docker call is interrupted, the next reconcile can
        # authenticate the report and retry only the exact removal.
        control.write(root + "/report.json", report)
        _remove_retention_container(contract)
    elif not final_publication_pending:
        # A report may have been durable before the launcher lost its final
        # receipt write.  If the named container still exists, authenticate
        # its terminal identity and retry only its exact removal.
        confirmation = docker_capture(
            "inspect", str(contract["name"]), allow_failure=True, timeout=60
        )
        if not _container_absent(confirmation):
            observed = _inspect_retention_container(contract)
            if observed.get("State", {}).get("ExitCode") != 0:
                raise ControlOutcomeUnknown(
                    "retention report exists but its named container exited unsuccessfully"
                )
            _remove_retention_container(contract)
    report = _validate_report(
        report,
        str(contract.get("expected_state")),
        inputs_sha256,
        contract.get("plan_sha256"),
        contract.get("group_plan_sha256"),
    )
    receipt = dict(receipt)
    backend_plan_sha256 = report["plan_sha256"]
    receipt.update(
        report_state=report.get("state"),
        operation_inputs_sha256=inputs_sha256,
        backend_plan_sha256=backend_plan_sha256,
        group_plan_sha256=_group_plan_sha256(backend_plan_sha256, inputs_sha256),
        report_plan_sha256=backend_plan_sha256,
        report_sha256=_sha(report),
        scope=report.get("scope"),
        scope_allocated_bytes_before=report.get("scope_allocated_bytes_before"),
        scope_allocated_bytes_after=report.get("scope_allocated_bytes_after"),
        scope_allocated_bytes_delta=report.get("scope_allocated_bytes_delta"),
        filesystem_available_path=report.get("filesystem_available_path"),
        filesystem_available_bytes_before=report.get(
            "filesystem_available_bytes_before"
        ),
        filesystem_available_bytes_after=report.get(
            "filesystem_available_bytes_after"
        ),
        filesystem_available_bytes_delta=report.get(
            "filesystem_available_bytes_delta"
        ),
        filesystem_available_delta_is_observed_only=report.get(
            "filesystem_available_delta_is_observed_only"
        ),
        state="succeeded",
        daemon_pending=False,
        managed_container_state="removed",
    )
    _publish_operation_records(control, "package-retention", root, receipt)
    _wait_for_control_active_clear(control)
    return 0


def run(args: argparse.Namespace) -> int:
    require_host()
    group = _selected_group(args)
    inputs = _operation_inputs(group)
    inputs_sha256 = _sha(inputs)
    # The retained Compose document is the only execution input. It contains
    # the verified backend image, exact named volumes, source binds and private
    # network. No command-line image or regenerated ambient config is allowed.
    command = [
        "retention",
        "--output",
        PACKAGE_ROOT,
        "--build-root",
        "/build",
        "--operation-input-sha256",
        inputs_sha256,
    ]
    if args.apply:
        if not isinstance(args.plan_sha256, str) or not re.fullmatch(SHA256_RE, args.plan_sha256):
            raise _fail("--apply requires the lowercase plan sha256 from a preceding dry-run")
        if not isinstance(args.group_plan_sha256, str) or not re.fullmatch(
            SHA256_RE, args.group_plan_sha256
        ):
            raise _fail(
                "--apply requires the lowercase group plan sha256 from a preceding dry-run"
            )
        if _group_plan_sha256(args.plan_sha256, inputs_sha256) != args.group_plan_sha256:
            raise _fail("requested group plan does not match current Compose-group inputs")
        command.extend(
            (
                "--apply",
                "--plan-sha256",
                args.plan_sha256,
                "--group-plan-sha256",
                args.group_plan_sha256,
            )
        )
    control = group.control
    with control.operation("package-retention", inputs, minimum_free_bytes=MIN_FREE_CONTROL_BYTES) as operation:
        control.write(operation["root"] + "/compose.json", group.document)
        expected_state = "applied" if args.apply else "dry-run"
        report = _run_managed_retention_container(
            group,
            control,
            operation,
            inputs,
            command,
            expected_state=expected_state,
            plan_sha256=args.plan_sha256 if args.apply else None,
            group_plan_sha256=args.group_plan_sha256 if args.apply else None,
        )
        report = _validate_report(
            report,
            expected_state,
            inputs_sha256,
            args.plan_sha256 if args.apply else None,
            args.group_plan_sha256 if args.apply else None,
        )
        backend_plan_sha256 = report["plan_sha256"]
        group_plan_sha256 = _group_plan_sha256(backend_plan_sha256, inputs_sha256)
        receipt_update = dict(
            report_state=report.get("state"),
            operation_inputs_sha256=inputs_sha256,
            backend_plan_sha256=backend_plan_sha256,
            group_plan_sha256=group_plan_sha256,
            report_plan_sha256=backend_plan_sha256,
            report_sha256=_sha(report),
            scope=report.get("scope"),
            scope_allocated_bytes_before=report.get("scope_allocated_bytes_before"),
            scope_allocated_bytes_after=report.get("scope_allocated_bytes_after"),
            scope_allocated_bytes_delta=report.get("scope_allocated_bytes_delta"),
            filesystem_available_path=report.get("filesystem_available_path"),
            filesystem_available_bytes_before=report.get(
                "filesystem_available_bytes_before"
            ),
            filesystem_available_bytes_after=report.get(
                "filesystem_available_bytes_after"
            ),
            filesystem_available_bytes_delta=report.get(
                "filesystem_available_bytes_delta"
            ),
            filesystem_available_delta_is_observed_only=report.get(
                "filesystem_available_delta_is_observed_only"
            ),
        )
        # The report is the durable witness of the backend operation.  Write
        # it before transitioning the BuildControl receipt to succeeded; a
        # failed report write must remain failed-confirmed/recoverable.
        control.write(operation["root"] + "/report.json", report)
        operation["receipt"].update(
            **receipt_update,
            state="succeeded",
        )
        # Keep the in-memory daemon fence set through the context finalizer.
        # BuildControl clears the durable receipt flag only after all terminal
        # records have been published, so an ordinary exception cannot be
        # misclassified as a completed daemon operation.
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--plan-sha256")
    parser.add_argument("--group-plan-sha256")
    parser.add_argument("--reconcile-attempt")
    args = parser.parse_args(argv)
    try:
        if args.reconcile_attempt is not None:
            if args.apply or args.plan_sha256 is not None or args.group_plan_sha256 is not None:
                raise _fail("retention reconciliation cannot combine with a new apply request")
            require_host()
            _repo_root, _source_root, _layout, _identity, control = _selected_context(args)
            return _reconcile_active_operation(control, args.reconcile_attempt, args)
        return run(args)
    except BuildControlError as error:
        print(f"docker-package-retention: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
