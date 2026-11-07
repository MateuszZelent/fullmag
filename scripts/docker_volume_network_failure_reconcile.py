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
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import stat
import time

from docker_build_control import (
    BuildControl,
    BuildControlError,
    bounded_capture,
    canonical,
    docker_capture,
    toolchain_configuration,
)
import docker_windows_absent_bind_isolation as absent_windows
import docker_windows_bind_isolation as windows
from docker_compose_identity import source_labels
from docker_foreign_bind_identity import WSL_ALIAS
from docker_linux_native_readmission import live_bind_path
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
WINDOWS_BIND = re.compile(r"^(?:[A-Za-z]:|/(?:run/desktop/mnt/host|host_mnt|mnt/host)/[A-Za-z](?:/|$))")
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
    qualify_desktop_bind=None,
) -> list[dict[str, object]]:
    """Require the exact live helper to be the sole selected-group consumer."""
    labels_expected = source_labels(identity)
    observed: list[dict[str, object]] = []
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
                if isinstance(source, str) and (WINDOWS_BIND.match(source) or source.startswith(WSL_ALIAS)):
                    require(qualify_desktop_bind is not None,
                            "Foreign Desktop bind requires initial recovery isolation evidence")
                    source, evidence = qualify_desktop_bind(document, source)
                    observed.append(evidence)
                    if source is None:
                        return False
                require(isinstance(source, str) and source.startswith("/")
                        and not source.startswith("//") and chr(92) not in source
                        and str(PurePosixPath(source)) == source
                        and ".." not in PurePosixPath(source).parts,
                        "Foreign bind mount source is not canonical")
                path = PurePosixPath(source)
                return (path == source_path or source_path in path.parents
                        or path in source_path.parents)
            require(not any(m.get("Name") == control_volume or overlaps_checkout(m) for m in mounts),
                    "A foreign container consumes this group's control volume or checkout")
    require(helper_matches == 1, "The exact BuildControl helper is not the sole selected-group container")
    return sorted(observed, key=canonical)


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
    for retry in range(3):
        try:
            return _inspect_inventory_snapshot()
        except BuildControlError as error:
            # A short-lived foreign helper may disappear between ps and inspect.
            # Retry the full snapshot, including previously inspected batches.
            if retry == 2 or not re.fullmatch(r"error: no such object: [0-9a-f]{64}", str(error)):
                raise
    raise AssertionError("Container inventory retry exhausted")


def _inspect_inventory_snapshot() -> list[dict[str, object]]:
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
        require(sorted(str(item.get("Id")) for item in rows) == sorted(batch),
                "Full Docker inspection returned different container IDs")
        documents.extend(rows)
    return documents


def _observe_present_windows_bind(source, distro, root_device):
    mapping = windows._mapping(source)
    native = windows._native(source, distro, allow_external_junctions=True)
    kind = native["candidate"]["kind"]
    require((kind == "file" and stat.S_ISREG(mapping["mode"]))
            or (kind == "directory" and stat.S_ISDIR(mapping["mode"])),
            "Windows and WSL candidate object types differ")
    require(mapping["device"] != root_device, "Foreign Windows bind aliases the protected ext4 filesystem")

    native_root = PureWindowsPath(native["candidate"]["path"])
    root = Path(mapping["path"])
    external = {}
    for _, relative, link in windows._link_paths(native):
        if link["tag"] != "0xa0000003":
            continue
        target = PureWindowsPath(link["target"])
        if target == native_root or native_root in target.parents:
            continue
        path = root / relative
        windows._link_parent_directories(root, path, mapping["device"])
        link_identity = windows._file_identity(path)
        require(stat.S_ISLNK(link_identity["mode"]) and link_identity["device"] == mapping["device"],
                "External Windows junction is not the exact DrvFs link")
        target_mapping = windows._mapping(str(target))
        require(os.readlink(path) == target_mapping["path"]
                and target_mapping["device"] != root_device
                and stat.S_ISDIR(target_mapping["mode"]),
                "External Windows junction target is not the exact disjoint DrvFs directory")
        # An external target gets the full existing proof. Nested external
        # junctions fail closed, keeping this initial recovery traversal bounded.
        target_native = windows._native(str(target), distro)
        require(target_native["candidate"]["kind"] == "directory",
                "External Windows junction target is not an ordinary directory")
        links = windows._qualify_links(target_mapping, target_native)
        windows._link_parent_directories(root, path, mapping["device"])
        require(windows._file_identity(path) == link_identity and os.readlink(path) == target_mapping["path"],
                "External Windows junction changed during isolation proof")
        external[relative] = {"link": link_identity, "mapping": target_mapping,
                              "native": target_native, "contained_links": links}

    return {"native": native, "mapping": mapping, "kind": "present",
            "external_junctions": external,
            "contained_links": windows._qualify_links(mapping, native, external_junctions=external)}


def _wsl_kernel_bind_identity(source):
    path = live_bind_path(source)
    require(path is not None and path.resolve(strict=True) == path, "Foreign WSL source is not canonical")
    return {"canonical_source": str(path), **windows._file_identity(path)}


def _observe_windows_source(source, native_source, context, pin):
    translated = windows._capture(["wslpath", "-u", native_source]).decode("utf-8", "strict").strip()
    try:
        Path(translated).lstat()
    except FileNotFoundError:
        absent_windows._stopped(pin)
        native = absent_windows._native(source)
        mapping = absent_windows._mapping(source, native)
        require(mapping["device"] != context["linux"]["root_device"],
                "Absent Windows bind aliases the protected ext4 filesystem")
        return {"native": native, "mapping": mapping, "kind": "absent-stopped"}
    return _observe_present_windows_bind(source, context["distro"], context["linux"]["root_device"])


def _initial_desktop_qualifier(identity, compose, engine_id):
    """Collect read-only evidence for the authenticated pre-backend attempt."""
    context = None
    by_source = {}
    pins = {}
    wsl_sources = {}

    def observe(container, source):
        nonlocal context
        pin = windows._container_pin(container)
        pins[pin["id"]] = pin
        if source.startswith(WSL_ALIAS):
            evidence = _wsl_kernel_bind_identity(source)
            wsl_sources[source] = evidence
            return evidence["canonical_source"], {
                "foreign": pin, "source_sha256": digest(source.encode("utf-8")),
                "mapping": evidence, "kind": "wsl-kernel",
            }
        native_source = windows._windows_source_path(source)
        if context is None:
            mounts = compose["services"]["backend"].get("volumes")
            require(isinstance(mounts, list) and all(isinstance(m, dict) for m in mounts),
                    "Initial Compose backend mount inventory is incomplete")
            roots = [m for m in mounts if m.get("target") == "/state"]
            require(len(roots) == 1 and roots[0].get("type") == "bind"
                    and isinstance(roots[0].get("source"), str),
                    "Initial Compose has no exact native /state bind")
            distro = os.environ.get("WSL_DISTRO_NAME", "")
            require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", distro)
                    and distro != "docker-desktop", "Current WSL distro identity is unavailable")
            linux = windows._linux_identity(identity["source_root"], roots[0]["source"])
            engine = windows._engine()
            require(engine["ID"] == linux["engine_id"] == engine_id,
                    "Initial native admission does not match the pinned Docker engine")
            context = {"linux": linux, "engine": engine, "distro": distro}
        if source not in by_source:
            by_source[source] = (_observe_windows_source(source, native_source, context, pin), pin)
        evidence, _ = by_source[source]
        if evidence["kind"] == "absent-stopped":
            absent_windows._stopped(pin)
        return None, {"schema": "fullmag.initial-network-failure-windows-bind.v1",
                "foreign": pin, "source_sha256": digest(source.encode("utf-8")),
                "context_sha256": digest(canonical(context)),
                "evidence_sha256": digest(canonical(evidence)), "kind": evidence["kind"]}

    def verify(*, refresh_windows=False):
        if refresh_windows:
            # Recheck early sources last so the oldest Windows evidence is
            # refreshed closest to the failure publication boundary.
            for source, (evidence, pin) in reversed(by_source.items()):
                refreshed = _observe_windows_source(source, windows._windows_source_path(source), context, pin)
                require(refreshed == evidence,
                        "Foreign Windows bind changed before failure publication: " + source
                        + "; changed fields: " + ", ".join(windows._observation_differences(evidence, refreshed)))
        for identifier, pin in pins.items():
            require(windows._container_pin(windows._inspect(identifier)) == pin,
                    "Foreign container changed during initial Desktop bind isolation")
        for source, evidence in wsl_sources.items():
            require(_wsl_kernel_bind_identity(source) == evidence, "Foreign WSL kernel mapping changed")
        if context is None:
            return
        linux = context["linux"]
        require(windows._engine() == context["engine"]
                and windows._linux_identity(linux["source_root"], linux["reference_root"]) == linux,
                "Initial Windows isolation context changed")

    return observe, verify


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
    qualify_desktop_bind, verify_desktop_binds = _initial_desktop_qualifier(identity, compose, args.engine_id)
    inventory = validate_container_inventory(
        containers, helper_id=helper_id, helper_name=helper_name, project=control.project,
        network_name=network_name, identity=identity, control_volume=control.volume,
        qualify_desktop_bind=qualify_desktop_bind,
    )
    verify_desktop_binds(refresh_windows=allowed_archive is not None)
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


def _publication_paths(attempt: str, recovery_id: str | None = None) -> dict[str, str]:
    require(isinstance(attempt, str) and TOKEN.fullmatch(attempt) is not None,
            "Invalid publication attempt")
    root = "development/attempts/" + attempt + "/reconciliation"
    if recovery_id is not None:
        require(isinstance(recovery_id, str) and TOKEN.fullmatch(recovery_id) is not None,
                "Recovery identity must be a complete lowercase token")
        root += "/recoveries/" + recovery_id
    return {"proof": root + "/network-failure-proof.json",
            "result": root + "/result.json", "prepared": root + "/prepared.json"}


def _load_prepared_recovery(control, args, original_raw) -> dict[str, object] | None:
    previous_sha = getattr(args, "resume_prepared_sha256", None)
    recovery_id = getattr(args, "recovery_id", None)
    if previous_sha is None and recovery_id is None:
        return None
    _require_sha(previous_sha, "resume-prepared-sha256")
    require(recovery_id is not None, "Prepared recovery requires an explicit recovery-id")
    new_paths = _publication_paths(args.attempt, recovery_id)
    root = "development/attempts/" + args.attempt
    for relative in (root + "/network-failure-reconcile.lock", root + "/terminal.json",
                     "development/current.json", "development/verified.json", *new_paths.values()):
        require(read_raw(control, relative, optional=True) is None,
                "Prepared recovery has a partial publication or occupied generation")
    require(digest(original_raw) == args.receipt_sha256
            and read_raw(control, root + "/unknown-receipt.json") == original_raw,
            "Prepared recovery lost its exact original receipt archive")
    old_paths = _publication_paths(args.attempt)
    raw = {key: read_raw(control, path) for key, path in old_paths.items()}
    require(all(isinstance(value, bytes) for value in raw.values()),
            "Prepared recovery is incomplete")
    require(digest(raw["prepared"]) == previous_sha, "Prepared recovery digest changed")
    prepared = _json(raw["prepared"], "Previous preparation")
    require(prepared == {"schema": SCHEMA, "attempt": args.attempt,
            "original_receipt_sha256": args.receipt_sha256, "compose_sha256": args.compose_sha256,
            "proof_sha256": digest(raw["proof"]), "result_sha256": digest(raw["result"])},
            "Previous preparation does not bind its complete proof and result")
    proof = _json(raw["proof"], "Previous proof")
    original = _json(original_raw, "Original development receipt")
    require(all(proof.get(key) == value for key, value in {
            "schema": SCHEMA, "state": "failed-confirmed", "attempt": args.attempt,
            "original_receipt_sha256": args.receipt_sha256, "compose_sha256": args.compose_sha256,
            "engine_id": args.engine_id, "compose_project": control.project,
            "original_error_sha256": digest(str(original["error"]).encode("utf-8")),
            "admission_scope": "initial-failure-only-group-local"}.items()),
            "Previous proof belongs to another attempt, engine or group")
    require(isinstance(proof.get("helper_id"), str) and SHA.fullmatch(proof["helper_id"]) is not None
            and isinstance(proof.get("helper_fingerprint"), str)
            and SHA.fullmatch(proof["helper_fingerprint"]) is not None,
            "Previous proof does not pin its original helper")
    result = _json(raw["result"], "Previous result")
    reconciliation = result.get("reconciliation")
    require(isinstance(reconciliation, dict), "Previous result has no reconciliation")
    observation_sha = _require_sha(reconciliation.get("observation_sha256"), "previous observation digest")
    expected = deepcopy(original)
    expected.update(state="failed-confirmed", finished_at=result.get("finished_at"),
        reconciliation={"schema": SCHEMA, "state": "failed-confirmed",
            "original_receipt_sha256": args.receipt_sha256, "compose_sha256": args.compose_sha256,
            "proof_sha256": digest(raw["proof"]), "observation_sha256": observation_sha,
            "resource_policy": "retained"}, build_data_qualification="NOT VERIFIED")
    require(result == expected and type(result.get("finished_at")) in (int, float)
            and 0 < result["finished_at"] < float("inf"),
            "Previous result changed original evidence or its failure-only semantics")
    return {"prepared_sha256": previous_sha, "recovery_id": recovery_id,
            "helper_id": proof["helper_id"], "helper_fingerprint": proof["helper_fingerprint"],
            "previous_files": {old_paths[key]: digest(value) for key, value in raw.items()}}


def _cas_script(control: BuildControl, attempt: str, original_sha: str, compose_sha: str,
                proof_sha: str, result_sha: str, prepared_sha: str,
                *, recovery: dict[str, object] | None = None) -> str:
    root = control.path("development/attempts/" + attempt)
    current = control.path("development/current.json")
    verified = control.path("development/verified.json")
    receipt = root + "/receipt.json"
    terminal = root + "/terminal.json"
    archive = root + "/unknown-receipt.json"
    compose = root + "/compose.json"
    paths = _publication_paths(attempt, recovery["recovery_id"] if recovery else None)
    proof, result, prepared = (control.path(paths[key]) for key in ("proof", "result", "prepared"))
    previous_files = recovery["previous_files"] if recovery else {}
    lock = root + "/network-failure-reconcile.lock"
    active = control.path("active")
    operation_lock = control.path("operation.lock")
    inputs = (active, operation_lock, receipt, compose,
              archive, proof, result, prepared, *(control.path(path) for path in previous_files))
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
    previous_checks = " ".join(
        f"test \"$(sha256sum '{control.path(path)}' | cut -d' ' -f1)\" = '{sha}';"
        for path, sha in previous_files.items())
    return (
        "umask 027; " + parent_checks + " " + input_checks + " "
        + previous_checks + " "
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

    recovery = None
    observation_options = {}
    if getattr(args, "resume_prepared_sha256", None) is not None or getattr(args, "recovery_id", None) is not None:
        original_raw = read_raw(control, "development/attempts/" + args.attempt + "/receipt.json")
        recovery = _load_prepared_recovery(control, args, original_raw)
        observation_options = {"allowed_archive": original_raw}
    first = _observe(control, identity, args, **observation_options)
    if recovery:
        require(first["helper_id"] == recovery["helper_id"]
                and first["helper_fingerprint"] == recovery["helper_fingerprint"],
                "Prepared recovery no longer belongs to the original helper")
    time.sleep(0.5)
    second = _observe(control, identity, args, **observation_options)
    require(canonical(second) == canonical(first),
            "Full Docker/control observation changed during the stability window")
    root = "development/attempts/" + args.attempt
    original_raw = read_raw(control, root + "/receipt.json")
    require(digest(original_raw) == args.receipt_sha256, "Original receipt changed after stable observation")
    original = _json(original_raw, "Original development receipt")
    proof_raw = _proof_bytes(second, original)
    result_raw = _failure_result(original_raw, proof_raw, second)
    if recovery:
        result = _json(result_raw, "Fresh recovery result")
        result["reconciliation"].update(recovery_id=recovery["recovery_id"],
            previous_prepared_sha256=recovery["prepared_sha256"])
        result_raw = canonical(result) + b"\n"
    paths = _publication_paths(args.attempt, recovery["recovery_id"] if recovery else None)
    proof_relative, result_relative, prepared_relative = (paths[key] for key in ("proof", "result", "prepared"))
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
    archive_paths = () if recovery else (root + "/unknown-receipt.json",)
    for relative in (*archive_paths, proof_relative, result_relative,
                     prepared_relative, root + "/network-failure-reconcile.lock",
                     "development/current.json", "development/verified.json", root + "/terminal.json"):
        require(read_raw(control, relative, optional=True) is None,
                "An earlier or partial failure reconciliation publication exists")
    if not recovery:
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
        **({"recovery": recovery} if recovery else {}),
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
    parser.add_argument("--resume-prepared-sha256")
    parser.add_argument("--recovery-id")
    parser.add_argument("--apply", action="store_true", help="publish failure-only terminal after full re-observation")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(reconcile(args), sort_keys=True, separators=(",", ":")))
        return 0
    except BuildControlError as error:
        parser.exit(2, "docker-volume-network-failure-reconcile: " + str(error) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
