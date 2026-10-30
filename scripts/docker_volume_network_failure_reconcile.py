#!/usr/bin/env python3
"""Close one initial DEV attempt after Compose exhausted every network pool.

Preview is read-only. Apply publishes only a failure receipt after the original
BuildControl helper, source identity, compose failure, and absent resources have
been re-observed. The original helper remains the sole owner that releases the
active marker.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path, PurePosixPath
import re
import time

from docker_build_control import (
    BuildControl,
    BuildControlError,
    bounded_capture,
    canonical,
    docker_capture,
    toolchain_configuration,
)
from docker_compose_identity import source_labels
from docker_volume_activation_reconcile import (
    _probe_helper_absence,
    _validate_helper,
    _validate_helper_logged,
)
from docker_volume_reconcile import digest, fingerprint, read_raw, require, write_immutable

SCHEMA = "fullmag.docker-development-network-failure-reconciliation.v1"
TOKEN = re.compile(r"[0-9a-f]{32}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")
MAX_CONTAINERS = 4096
MAX_INSPECT_BATCH = 64
POOL_ERROR = "all predefined address pools have been fully subnetted"


def _require_sha(value: object, label: str) -> str:
    require(isinstance(value, str) and SHA.fullmatch(value) is not None,
            label + " must be a lowercase SHA-256")
    return value


def _json(raw: bytes, label: str) -> dict[str, object]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError(label + " is not valid UTF-8 JSON") from error
    require(isinstance(value, dict), label + " is not an object")
    return value


def validate_pool_failure(error: object, network_name: str, project: str) -> str:
    """Accept only the exact recorded Compose pool-exhaustion output."""
    require(isinstance(error, str) and error and len(error) <= 8192,
            "Original Compose error is absent or exceeds its bound")
    lines = [line.strip() for line in error.splitlines() if line.strip()]
    require(lines, "Original Compose error has no diagnostic lines")
    failure = "Error response from daemon: " + POOL_ERROR
    terminal = f"failed to create network {network_name}: {failure}"
    expected = [
        f"Network {network_name} Creating",
        f"Network {network_name} Creating",
        f"Network {network_name} Error {failure}",
        f"network:fullmag failed to create network {network_name}: {failure}",
        f"Container {project}-backend-1 Creating",
        terminal,
    ]
    require(lines == expected,
            "Original Compose output differs from the exact observed address-pool failure")
    require(not re.search(r"\b(?:Created|Started|Running|Done)\b", error, re.IGNORECASE),
            "Compose output includes a successful creation or start")
    return terminal


def validate_network_absence(returncode: int, stdout: bytes, stderr: bytes, network_name: str) -> str:
    """Authenticate only Docker's exact network-not-found responses."""
    require(returncode == 1, "Network inspect did not return the canonical absent status")
    try:
        standard_output = json.loads(stdout.decode("utf-8", "strict"))
        text = stderr.decode("utf-8", "strict").strip()
    except UnicodeDecodeError as error:
        raise BuildControlError("Network inspect error is not UTF-8") from error
    except json.JSONDecodeError as error:
        raise BuildControlError("Network inspect stdout is not authoritative JSON") from error
    require(standard_output == [], "Docker returned a network despite its not-found error")
    accepted = {
        f"Error response from daemon: network {network_name} not found",
        f"Error: No such network: {network_name}",
    }
    require(text in accepted, "Network absence is not an exact daemon not-found response")
    return text


def validate_initial_receipt(
    receipt: object,
    *,
    attempt: str,
    project: str,
    volume: str,
    identity: dict[str, str],
    network_name: str,
) -> str:
    require(isinstance(receipt, dict), "Original development receipt is malformed")
    require(receipt.get("schema") == "fullmag.docker-build-operation.v1"
            and receipt.get("phase") == "development"
            and receipt.get("state") == "outcome-unknown-resources-retained"
            and receipt.get("attempt") == attempt
            and receipt.get("compose_project") == project
            and receipt.get("control_volume") == volume
            and receipt.get("helper_container") == "fullmag-control-" + attempt,
            "Only the exact unknown initial development operation is admissible")
    inputs = receipt.get("inputs")
    require(isinstance(inputs, dict)
            and inputs.get("source_root") == identity["source_root"]
            and inputs.get("source_project_id") == identity["project_id"]
            and inputs.get("source_worktree_id") == identity["worktree_id"]
            and inputs.get("source_checkout_kind") == identity["checkout_kind"],
            "Original development source identity differs from the selected checkout")
    # These fields are only written after Compose has returned both services and
    # package publication has progressed. The deterministic up failure cannot
    # be reconciled if any such success evidence exists.
    forbidden = {
        "backend_container_id", "frontend_container_id", "backend_started_at",
        "backend_build_receipt_sha256", "backend_package_cache_hit", "startup",
        "url", "config_sha256", "backend_build_receipt", "provenance",
    }
    require(not (forbidden & set(receipt)),
            "Original receipt crossed a backend/frontend creation or publication boundary")
    return validate_pool_failure(receipt.get("error"), network_name, project)


def validate_container_inventory(
    documents: list[dict[str, object]],
    *,
    helper_id: str,
    helper_name: str,
    project: str,
    network_name: str,
    identity: dict[str, str],
    control_volume: str,
) -> list[dict[str, str]]:
    """Require the exact live helper to be the sole selected-group consumer."""
    labels_expected = source_labels(identity)
    observed: list[dict[str, str]] = []
    helper_matches = 0
    for document in documents:
        identifier = document.get("Id")
        name = str(document.get("Name") or "").removeprefix("/")
        config = document.get("Config")
        labels = config.get("Labels") if isinstance(config, dict) else None
        labels = labels if isinstance(labels, dict) else {}
        host = document.get("HostConfig")
        host = host if isinstance(host, dict) else {}
        state = document.get("State")
        state = state if isinstance(state, dict) else {}
        network_settings = document.get("NetworkSettings")
        networks = network_settings.get("Networks") if isinstance(network_settings, dict) else None
        require(isinstance(identifier, str) and re.fullmatch(r"[0-9a-f]{64}", identifier),
                "Container inventory contains an invalid identity")
        require(isinstance(networks, dict), "Container network attachments are incomplete")
        require(network_name not in networks,
                "A container still references the expected private network")

        is_helper = identifier == helper_id or name == helper_name
        is_selected = (
            labels.get("com.docker.compose.project") == project
            or labels.get("org.fullmag.compose.project") == project
            or all(labels.get(key) == value for key, value in labels_expected.items())
            or name.startswith(project + "-")
            or name.startswith(project + "_")
        )
        if is_helper:
            require(identifier == helper_id and name == helper_name
                    and labels.get("com.docker.compose.project") == project
                    and labels.get("com.docker.compose.service") == "build-control"
                    and all(labels.get(key) == value for key, value in labels_expected.items())
                    and state.get("Running") is True and host.get("NetworkMode") == "none",
                    "The selected BuildControl helper differs from its authenticated identity")
            helper_matches += 1
            observed.append({"id": identifier, "name": name, "service": "build-control"})
        elif is_selected:
            raise BuildControlError("A selected-group service or application consumer remains present")
        else:
            mounts = document.get("Mounts")
            require(isinstance(mounts, list) and all(isinstance(m, dict) for m in mounts),
                    "Foreign container mount inventory is incomplete")
            source_path = PurePosixPath(identity["source_root"])
            def overlaps_checkout(mount):
                if mount.get("Type") != "bind":
                    return False
                source = mount.get("Source")
                require(isinstance(source, str) and source.startswith("/")
                        and ".." not in PurePosixPath(source).parts,
                        "Foreign bind mount source is not canonical")
                path = PurePosixPath(source)
                return (path == source_path or source_path in path.parents
                        or path in source_path.parents)
            require(not any(m.get("Name") == control_volume or overlaps_checkout(m) for m in mounts),
                    "A foreign container consumes this group's control volume or checkout")
    require(helper_matches == 1, "The exact BuildControl helper is not the sole selected-group container")
    return observed


def validate_initial_artifacts(attempts: list[tuple[str, str]], attempt: str) -> None:
    require(attempts == [(attempt, "d")],
            "Initial-only proof failed: development attempt inventory is not exactly the target attempt")


def validate_absent_publications(values: dict[str, bytes | None], attempt: str) -> None:
    required = {
        "development/current.json",
        "development/verified.json",
        "development/attempts/" + attempt + "/terminal.json",
        "backend/runtime-provenance.json",
        "runtime-control/runtime-services/OWNER.json",
        "runtime-control/runtime-service/process-tree.json",
    }
    require(set(values) == required, "Initial publication inventory is incomplete")
    require(all(value is None for value in values.values()),
            "A current, terminal, runtime provenance, or prior-owner publication exists")


def _attempt_inventory_script(control: BuildControl) -> str:
    path = control.path("development/attempts")
    return (
        f"test ! -L '{path}'; test -d '{path}'; test \"$(readlink -f '{path}')\" = '{path}'; "
        f"find '{path}' -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\n' | LC_ALL=C sort"
    )


def _container_inventory() -> list[dict[str, object]]:
    listed = docker_capture("ps", "--all", "--no-trunc", "--format", "{{.ID}} {{.Names}}")
    rows = listed.stdout.decode("utf-8", "strict").splitlines()
    require(len(rows) <= MAX_CONTAINERS, "Full Docker container inventory exceeded its bound")
    ordered: list[str] = []
    for row in rows:
        parts = row.split(maxsplit=1)
        require(len(parts) == 2 and re.fullmatch(r"[0-9a-f]{64}", parts[0]),
                "Full Docker container inventory is malformed")
        ordered.append(parts[0])
    require(len(set(ordered)) == len(ordered), "Full Docker container inventory contains duplicates")
    documents: list[dict[str, object]] = []
    for index in range(0, len(ordered), MAX_INSPECT_BATCH):
        batch = ordered[index:index + MAX_INSPECT_BATCH]
        result = docker_capture("inspect", *batch)
        try:
            rows = json.loads(result.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise BuildControlError("Full Docker container inspection is invalid JSON") from error
        require(isinstance(rows, list) and len(rows) == len(batch)
                and all(isinstance(item, dict) for item in rows),
                "Full Docker container inspection is incomplete")
        documents.extend(rows)
    return documents


def _observe(control: BuildControl, identity: dict[str, str], args: argparse.Namespace,
             *, allowed_archive: bytes | None = None) -> dict[str, object]:
    require(docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip() == args.engine_id,
            "Docker engine identity differs from the operator pin")
    root = "development/attempts/" + args.attempt
    original_raw = read_raw(control, root + "/receipt.json")
    require(digest(original_raw) == args.receipt_sha256, "Original receipt digest differs from the operator pin")
    original = _json(original_raw, "Original development receipt")
    network_name = identity["network_name"]
    pool_error = validate_initial_receipt(
        original, attempt=args.attempt, project=control.project, volume=control.volume,
        identity=identity, network_name=network_name,
    )
    require(original.get("compose_preflight") == "PASS",
            "Original Compose preflight did not reach the known network-creation boundary")
    compose_raw = read_raw(control, root + "/compose.json")
    require(digest(compose_raw) == args.compose_sha256, "Original Compose document differs from the operator pin")
    compose = _json(compose_raw, "Original Compose document")
    networks = compose.get("networks")
    services = compose.get("services")
    require(compose.get("name") == control.project and isinstance(services, dict)
            and set(services) == {"backend", "frontend"}
            and isinstance(networks, dict) and set(networks) == {"fullmag"}
            and networks["fullmag"].get("name") == network_name,
            "Original Compose identity/services/private network differ")
    for service_name in ("backend", "frontend"):
        service = services[service_name]
        require(isinstance(service, dict), "Original Compose service is malformed")
        service_networks = service.get("networks")
        require(service_networks == ["fullmag"] or service_networks == {"fullmag": None}
                or service_networks == {"fullmag": {}},
                "Application service is not attached only to the expected private network")
        labels = service.get("labels")
        require(isinstance(labels, dict) and all(labels.get(key) == value
                for key, value in source_labels(identity).items()),
                "Compose source labels differ from the selected checkout")

    helper_name = "fullmag-control-" + args.attempt
    helper, helper_id = _validate_helper(control, helper_name, args.attempt, phase="development")
    log_tail = _validate_helper_logged(helper_id)
    require("READY\n" in log_tail and "LOGGED\n" in log_tail,
            "Original helper has not durably acknowledged its log")
    active = read_raw(control, "active")
    require(active == (args.attempt + "\n").encode(), "Original helper no longer owns the active marker")

    publications = {
        "development/current.json": read_raw(control, "development/current.json", optional=True),
        "development/verified.json": read_raw(control, "development/verified.json", optional=True),
        root + "/terminal.json": read_raw(control, root + "/terminal.json", optional=True),
        root + "/unknown-receipt.json": read_raw(control, root + "/unknown-receipt.json", optional=True),
        "backend/runtime-provenance.json": read_raw(control, "backend/runtime-provenance.json", optional=True),
        "runtime-control/runtime-services/OWNER.json": read_raw(
            control, "runtime-control/runtime-services/OWNER.json", optional=True),
        "runtime-control/runtime-service/process-tree.json": read_raw(
            control, "runtime-control/runtime-service/process-tree.json", optional=True),
    }
    require(publications[root + "/unknown-receipt.json"] == allowed_archive,
            "Original unknown receipt archive is absent or differs from its immutable pin")
    absent = dict(publications)
    absent.pop(root + "/unknown-receipt.json")
    validate_absent_publications(absent, args.attempt)
    attempts_result = bounded_capture(control.helper_args(_attempt_inventory_script(control)), data=b"", timeout=60)
    require(attempts_result.returncode == 0, "Development attempt inventory could not be read")
    try:
        attempts = [tuple(line.split("\t", 1)) for line in
                    attempts_result.stdout.decode("utf-8", "strict").splitlines()]
    except UnicodeDecodeError as error:
        raise BuildControlError("Development attempt inventory is not UTF-8") from error
    require(all(len(item) == 2 for item in attempts), "Development attempt inventory is malformed")
    validate_initial_artifacts(attempts, args.attempt)

    network_result = docker_capture("network", "inspect", network_name, allow_failure=True)
    network_error = validate_network_absence(
        network_result.returncode, network_result.stdout, network_result.stderr, network_name)
    containers = _container_inventory()
    inventory = validate_container_inventory(
        containers, helper_id=helper_id, helper_name=helper_name, project=control.project,
        network_name=network_name, identity=identity, control_volume=control.volume,
    )
    # This failure-only transaction is group-local (ADR 0067). The authenticated
    # original helper has closed its log input and still holds operation.lock;
    # a new managed producer cannot enter this group before its terminal receipt.
    # Global process liveness would incorrectly block independent DEV groups.
    active_again = read_raw(control, "active")
    require(active_again == active, "Active helper ownership changed during observation")
    require(digest(read_raw(control, root + "/receipt.json")) == args.receipt_sha256,
            "Original receipt changed during observation")
    require(digest(read_raw(control, root + "/compose.json")) == args.compose_sha256,
            "Original Compose document changed during observation")
    return {
        "schema": "fullmag.docker-development-network-failure-observation.v1",
        "attempt": args.attempt,
        "engine_id": args.engine_id,
        "source_root": identity["source_root"],
        "source_project_id": identity["project_id"],
        "source_worktree_id": identity["worktree_id"],
        "compose_project": control.project,
        "control_volume": control.volume,
        "receipt_sha256": args.receipt_sha256,
        "compose_sha256": args.compose_sha256,
        "pool_error": pool_error,
        "network_absence_error": network_error,
        "network_name": network_name,
        "helper_id": helper_id,
        "helper_fingerprint": fingerprint(helper),
        "helper_log_sha256": digest(log_tail.encode("utf-8")),
        "container_inventory": inventory,
        "development_attempts": attempts,
        "admission_scope": "initial-failure-only-group-local",
    }


def _proof_bytes(observation: dict[str, object], original: dict[str, object]) -> bytes:
    return canonical({
        "schema": SCHEMA,
        "state": "failed-confirmed",
        "attempt": observation["attempt"],
        "original_receipt_sha256": observation["receipt_sha256"],
        "compose_sha256": observation["compose_sha256"],
        "engine_id": observation["engine_id"],
        "compose_project": observation["compose_project"],
        "network_name": observation["network_name"],
        "network_absence_error": observation["network_absence_error"],
        "pool_error": observation["pool_error"],
        "helper_id": observation["helper_id"],
        "helper_fingerprint": observation["helper_fingerprint"],
        "helper_log_sha256": observation["helper_log_sha256"],
        "container_inventory": observation["container_inventory"],
        "development_attempts": observation["development_attempts"],
        "admission_scope": observation["admission_scope"],
        "original_error_sha256": digest(str(original["error"]).encode("utf-8")),
    }) + b"\n"


def _failure_result(original_raw: bytes, proof_raw: bytes, observation: dict[str, object]) -> bytes:
    result = deepcopy(_json(original_raw, "Original development receipt"))
    result.update(
        state="failed-confirmed",
        finished_at=time.time(),
        reconciliation={
            "schema": SCHEMA,
            "state": "failed-confirmed",
            "original_receipt_sha256": observation["receipt_sha256"],
            "compose_sha256": observation["compose_sha256"],
            "proof_sha256": digest(proof_raw),
            "observation_sha256": digest(canonical(observation)),
            "resource_policy": "retained",
        },
        build_data_qualification="NOT VERIFIED",
    )
    return canonical(result) + b"\n"


def _cas_script(control: BuildControl, attempt: str, original_sha: str, compose_sha: str,
                proof_sha: str, result_sha: str, prepared_sha: str) -> str:
    root = control.path("development/attempts/" + attempt)
    current = control.path("development/current.json")
    verified = control.path("development/verified.json")
    receipt = root + "/receipt.json"
    terminal = root + "/terminal.json"
    archive = root + "/unknown-receipt.json"
    compose = root + "/compose.json"
    proof = root + "/reconciliation/network-failure-proof.json"
    result = root + "/reconciliation/result.json"
    prepared = root + "/reconciliation/prepared.json"
    lock = root + "/network-failure-reconcile.lock"
    active = control.path("active")
    operation_lock = control.path("operation.lock")
    inputs = (active, operation_lock, receipt, compose,
              archive, proof, result, prepared)
    parents = set("/".join(path.split("/")[:-1]) for path in (*inputs, current, verified, terminal, lock))
    parent_checks = " ".join(
        f"test ! -L '{parent}'; test -d '{parent}'; "
        f"test \"$(readlink -f '{parent}')\" = '{parent}';"
        for parent in sorted(parents)
    )
    input_checks = " ".join(
        f"test ! -L '{path}'; test -f '{path}'; test $(stat -c %h '{path}') = 1;"
        for path in inputs
    )
    # Original BuildControl holds operation.lock for this entire transaction.
    return (
        "umask 027; " + parent_checks + " " + input_checks + " "
        f"test ! -L '{lock}'; test ! -e '{lock}'; exec 7>'{lock}'; flock -n 7; "
        f"test \"$(cat '{active}')\" = '{attempt}'; "
        f"test \"$(sha256sum '{receipt}' | cut -d' ' -f1)\" = '{original_sha}'; "
        f"test \"$(sha256sum '{compose}' | cut -d' ' -f1)\" = '{compose_sha}'; "
        f"test \"$(sha256sum '{archive}' | cut -d' ' -f1)\" = '{original_sha}'; "
        f"test \"$(sha256sum '{proof}' | cut -d' ' -f1)\" = '{proof_sha}'; "
        f"test \"$(sha256sum '{result}' | cut -d' ' -f1)\" = '{result_sha}'; "
        f"test \"$(sha256sum '{prepared}' | cut -d' ' -f1)\" = '{prepared_sha}'; "
        f"test ! -L '{current}'; test ! -e '{current}'; "
        f"test ! -L '{verified}'; test ! -e '{verified}'; "
        f"test ! -L '{terminal}'; test ! -e '{terminal}'; "
        f"exec 8<>'{operation_lock}'; if flock -n 8; then exit 72; fi; "
        "for p in " + " ".join("'" + p + "'" for p in (receipt, current, terminal)) + "; do "
        "test ! -L \"$p\"; parent=$(dirname \"$p\"); "
        "test \"$(readlink -f \"$parent\")\" = \"$parent\"; "
        f"if test \"$p\" = '{receipt}'; then "
        f"test -f \"$p\"; test $(stat -c %h \"$p\") = 1; "
        f"test \"$(sha256sum \"$p\" | cut -d' ' -f1)\" = '{original_sha}'; "
        "else test ! -e \"$p\"; fi; "
        f"t=$(mktemp \"$parent/.network-failure.XXXXXXXX\"); "
        f"cat '{result}' > \"$t\"; sync \"$t\"; mv -T -- \"$t\" \"$p\"; sync \"$parent\"; "
        "done"
    )


def _identity_and_control(source_root: str) -> tuple[Path, dict[str, str], BuildControl]:
    from docker_development_inputs import select_checkout
    from docker_dev import STORAGE_PROFILE, _compose_identity
    from fullmag_storage import resolve_layout

    requested = Path(source_root).resolve(strict=True)
    selected = select_checkout(requested, requested).resolve(strict=True)
    require(selected.is_dir() and not selected.is_symlink(), "Selected source is not a registered checkout")
    layout = resolve_layout(selected, STORAGE_PROFILE)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    helper_image = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    control = BuildControl(identity, helper_image)
    require(not control.namespace, "Initial network recovery does not support retained namespaces")
    return selected, identity, control


def reconcile(args: argparse.Namespace) -> dict[str, object]:
    require(isinstance(args.attempt, str) and TOKEN.fullmatch(args.attempt) is not None,
            "A lowercase initial development attempt token is required")
    _require_sha(args.receipt_sha256, "receipt-sha256")
    _require_sha(args.compose_sha256, "compose-sha256")
    require(isinstance(args.engine_id, str) and args.engine_id and len(args.engine_id) <= 256
            and "\x00" not in args.engine_id,
            "engine-id is not a bounded Docker engine identity")
    selected, identity, control = _identity_and_control(args.source_root)
    require(identity["source_root"] == str(selected), "Selected checkout identity is not canonical")

    first = _observe(control, identity, args)
    time.sleep(0.5)
    second = _observe(control, identity, args)
    require(canonical(second) == canonical(first),
            "Full Docker/control observation changed during the stability window")
    root = "development/attempts/" + args.attempt
    original_raw = read_raw(control, root + "/receipt.json")
    require(digest(original_raw) == args.receipt_sha256, "Original receipt changed after stable observation")
    original = _json(original_raw, "Original development receipt")
    proof_raw = _proof_bytes(second, original)
    result_raw = _failure_result(original_raw, proof_raw, second)
    proof_relative = root + "/reconciliation/network-failure-proof.json"
    result_relative = root + "/reconciliation/result.json"
    prepared_relative = root + "/reconciliation/prepared.json"
    prepared_raw = canonical({
        "schema": SCHEMA,
        "attempt": args.attempt,
        "original_receipt_sha256": args.receipt_sha256,
        "compose_sha256": args.compose_sha256,
        "proof_sha256": digest(proof_raw),
        "result_sha256": digest(result_raw),
    }) + b"\n"
    summary = {
        "state": "validated-only",
        "attempt": args.attempt,
        "compose_project": control.project,
        "network_name": identity["network_name"],
        "receipt_sha256": args.receipt_sha256,
        "compose_sha256": args.compose_sha256,
        "result_sha256": digest(result_raw),
        "proof_sha256": digest(proof_raw),
        "engine_id": args.engine_id,
        "apply": bool(args.apply),
    }
    if not args.apply:
        return summary

    # All paths must be pristine before the first write. Any partial transaction
    # is intentionally non-replayable and requires operator inspection.
    for relative in (root + "/unknown-receipt.json", proof_relative, result_relative,
                     prepared_relative, root + "/network-failure-reconcile.lock",
                     "development/current.json", "development/verified.json", root + "/terminal.json"):
        require(read_raw(control, relative, optional=True) is None,
                "An earlier or partial failure reconciliation publication exists")
    write_immutable(control, root + "/unknown-receipt.json", original_raw)
    write_immutable(control, proof_relative, proof_raw)
    write_immutable(control, result_relative, result_raw)
    write_immutable(control, prepared_relative, prepared_raw)

    # A complete second observation is taken after immutable proof preparation
    # and immediately before the atomic pointer/terminal CAS.
    final_observation = _observe(control, identity, args, allowed_archive=original_raw)
    require(canonical(final_observation) == canonical(second),
            "Resources or ownership changed immediately before failure publication")
    committed = bounded_capture(control.helper_args(_cas_script(
        control, args.attempt, args.receipt_sha256, args.compose_sha256,
        digest(proof_raw), digest(result_raw), digest(prepared_raw),
    )), data=b"", timeout=90)
    require(committed.returncode == 0,
            "Failure publication outcome is unknown; preserve exact attempt and inspect its receipts")
    for relative in (root + "/receipt.json", "development/current.json", root + "/terminal.json"):
        require(read_raw(control, relative) == result_raw,
                "Failure terminal publication differs from its exact prepared result")
    require(read_raw(control, "development/verified.json", optional=True) is None,
            "Failure reconciliation unexpectedly published a verified pointer")
    deadline = time.monotonic() + 30
    helper_name = "fullmag-control-" + args.attempt
    while time.monotonic() < deadline:
        active = read_raw(control, "active", optional=True)
        if active is None:
            require(_probe_helper_absence(helper_name) is not None,
                    "Original helper remains present after releasing its active marker")
            summary["state"] = "failed-confirmed"
            return summary
        require(active == (args.attempt + "\n").encode(),
                "A different helper acquired the active marker during release")
        time.sleep(0.25)
    raise BuildControlError("Failure terminal is committed; original helper release is not yet confirmed")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--receipt-sha256", required=True)
    parser.add_argument("--compose-sha256", required=True)
    parser.add_argument("--engine-id", required=True)
    parser.add_argument("--apply", action="store_true", help="publish failure-only terminal after full re-observation")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(reconcile(args), sort_keys=True, separators=(",", ":")))
        return 0
    except BuildControlError as error:
        parser.exit(2, "docker-volume-network-failure-reconcile: " + str(error) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
