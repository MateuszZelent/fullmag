"""Validate and resolve an explicitly copied, isolated session namespace.

This module authenticates a snapshot receipt and its raw control-volume pins.
It does not create a namespace, copy data, start requests, or prove native
storage admission or physical path disjointness. Those require separately
qualified evidence from the copier and native admission tools.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
from pathlib import PurePosixPath

from docker_build_control import BuildControl, BuildControlError, MAX_DOCUMENT_BYTES
from docker_control_namespace import REGISTRY_PATH, REGISTRY_SCHEMA, _raw


SNAPSHOT_SCHEMA = "fullmag.docker-isolated-session-snapshot.v1"
SNAPSHOT_STATE = "snapshot-copied-awaiting-native-admission"
HEX32 = re.compile(r"[0-9a-f]{32}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
CONTAINER_ID = re.compile(r"[0-9a-f]{64}\Z")
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
MAX_PINS = 32
MAX_RUNS = 128
MAX_CONTROL_DOCUMENT_BYTES = MAX_DOCUMENT_BYTES

_REGISTRY_KEYS = {
    "schema", "recovery_id", "namespace", "receipt_path", "receipt_sha256",
    "compose_project", "control_volume", "source_project_id", "source_worktree_id",
}
_RECEIPT_KEYS = {
    "schema", "state", "recovery_id", "namespace", "previous_namespace",
    "compose_project", "control_volume", "source_project_id", "source_worktree_id",
    "source_root", "source_state_root", "destination_state_root",
    "source_user_data_root", "destination_user_data_root", "source_manifest_path",
    "source_manifest_sha256", "request_path", "request_sha256", "original_config_path",
    "original_config_sha256", "old_container_ids", "old_image_id",
    "allow_old_request_replay", "allow_new_requests", "terminal_run_count",
    "held_manual_run_count", "old_development_attempt", "old_request_id",
    "previous_registry_path", "previous_registry_sha256", "control_pins",
}


def _fail(message):
    raise BuildControlError(message)


def _text(value, label, *, nonempty=True):
    if type(value) is not str or (nonempty and not value):
        _fail(label + " must be a " + ("nonempty " if nonempty else "") + "string")
    return value


def _digest(value, label):
    if type(value) is not str or HEX64.fullmatch(value) is None:
        _fail(label + " must be a lowercase SHA-256 digest")
    return value


def _hex32(value, label):
    if type(value) is not str or HEX32.fullmatch(value) is None:
        _fail(label + " must be a lowercase 32-character hex token")
    return value


def _control_relative(value, label):
    """Apply BuildControl.path's raw-control contract and reject aliases."""
    _text(value, label)
    if len(value) > 4096 or any(len(part) > 255 for part in value.split("/")):
        _fail(label + " exceeds the bounded control-path length")
    try:
        resolved = BuildControl.path(value)
    except (BuildControlError, TypeError, ValueError) as error:
        raise BuildControlError(label + " is not a valid raw control path") from error
    if resolved != "/control/" + value:
        _fail(label + " is not a canonical raw control path")
    return value


def _absolute_linux_path(value, label):
    _text(value, label)
    if "\x00" in value or not value.startswith("/") or value.startswith("//"):
        _fail(label + " must be a canonical absolute Linux path")
    path = PurePosixPath(value)
    if str(path) != value or any(part in {".", ".."} for part in path.parts):
        _fail(label + " must not contain lexical path aliases")
    return value


def _required_pin_paths(previous_namespace, previous_registry_path, old_attempt):
    prefix = previous_namespace + "/" if previous_namespace else ""
    attempt = prefix + "development/attempts/" + old_attempt
    runtime = prefix + "runtime-control/"
    return {
        previous_registry_path,
        attempt + "/terminal.json",
        attempt + "/compose.json",
        runtime + "runtime-services/OWNER.json",
        runtime + "runtime-services/LAUNCH.json",
        runtime + "runtime-service/docker-all.json",
        runtime + "runtime-service/process-tree.json",
    }


def validate_snapshot_namespace_receipt(
    receipt, *, project, control_volume, project_id, worktree_id
):
    """Validate the complete v1 copied-session receipt without reading storage."""
    if type(receipt) is not dict or set(receipt) != _RECEIPT_KEYS:
        _fail("Isolated snapshot receipt has an unexpected shape")

    expected_identity = {
        "compose_project": (project, "project"),
        "control_volume": (control_volume, "control volume"),
        "source_project_id": (project_id, "source project identity"),
        "source_worktree_id": (worktree_id, "source worktree identity"),
    }
    for field, (expected, label) in expected_identity.items():
        _text(expected, "Expected " + label)
        if type(receipt[field]) is not str or receipt[field] != expected:
            _fail("Isolated snapshot receipt " + field + " differs")

    if type(receipt["schema"]) is not str or receipt["schema"] != SNAPSHOT_SCHEMA:
        _fail("Isolated snapshot receipt schema is unsupported")
    if type(receipt["state"]) is not str or receipt["state"] != SNAPSHOT_STATE:
        _fail("Isolated snapshot receipt state is unsupported")

    recovery_id = _hex32(receipt["recovery_id"], "recovery_id")
    namespace = "namespaces/" + recovery_id
    if type(receipt["namespace"]) is not str or receipt["namespace"] != namespace:
        _fail("Isolated snapshot namespace does not match its recovery id")

    previous_namespace = _text(receipt["previous_namespace"], "previous_namespace", nonempty=False)
    if previous_namespace:
        match = re.fullmatch(r"namespaces/([0-9a-f]{32})", previous_namespace)
        if match is None or match.group(1) == recovery_id:
            _fail("previous_namespace must be empty or a distinct canonical namespace")

    _absolute_linux_path(receipt["source_root"], "source_root")
    roots = (
        _absolute_linux_path(receipt["source_state_root"], "source_state_root"),
        _absolute_linux_path(receipt["destination_state_root"], "destination_state_root"),
        _absolute_linux_path(receipt["source_user_data_root"], "source_user_data_root"),
        _absolute_linux_path(receipt["destination_user_data_root"], "destination_user_data_root"),
    )
    if roots[0] == roots[1] or roots[2] == roots[3]:
        _fail("Source and destination state roots must be distinct")

    source_paths = {
        "source_manifest_path": "source_manifest_sha256",
        "request_path": "request_sha256",
        "original_config_path": "original_config_sha256",
    }
    source_digests = {}
    own_receipt_path = "namespace-recovery/" + recovery_id + "/terminal.json"
    for path_field, digest_field in source_paths.items():
        path = _control_relative(receipt[path_field], path_field)
        if path in {REGISTRY_PATH, own_receipt_path} or path.startswith(namespace + "/"):
            _fail(path_field + " cannot reference the current registry or snapshot receipt")
        digest = _digest(receipt[digest_field], digest_field)
        prior = source_digests.get(path)
        if prior is not None and prior != digest:
            _fail("receipt references conflicting digests for one control path")
        source_digests[path] = digest

    containers = receipt["old_container_ids"]
    if type(containers) is not dict or set(containers) != {"backend", "frontend"}:
        _fail("old_container_ids must contain exactly backend and frontend")
    for service, container_id in containers.items():
        if type(container_id) is not str or CONTAINER_ID.fullmatch(container_id) is None:
            _fail("old_container_ids contains an invalid full container id")
    if containers["backend"] == containers["frontend"]:
        _fail("old backend and frontend container ids must be distinct")
    if type(receipt["old_image_id"]) is not str or IMAGE_ID.fullmatch(receipt["old_image_id"]) is None:
        _fail("old_image_id must be an immutable sha256 image id")

    if type(receipt["allow_old_request_replay"]) is not bool or receipt["allow_old_request_replay"]:
        _fail("old request replay must remain disabled")
    if type(receipt["allow_new_requests"]) is not bool or receipt["allow_new_requests"]:
        _fail("new requests must remain disabled pending native admission")

    terminal_count = receipt["terminal_run_count"]
    held_count = receipt["held_manual_run_count"]
    if type(terminal_count) is not int or terminal_count < 0:
        _fail("terminal_run_count must be a nonnegative integer")
    if type(held_count) is not int or held_count < 1:
        _fail("held_manual_run_count must be a positive integer")
    if terminal_count + held_count > MAX_RUNS:
        _fail("snapshot run count exceeds the v1 bound")

    old_attempt = _hex32(receipt["old_development_attempt"], "old_development_attempt")
    _text(receipt["old_request_id"], "old_request_id")

    expected_previous_registry = (
        "namespace-recovery/" + recovery_id + "/previous-registry.json"
    )
    previous_registry_path = _control_relative(
        receipt["previous_registry_path"], "previous_registry_path"
    )
    previous_registry_sha256 = _digest(
        receipt["previous_registry_sha256"], "previous_registry_sha256"
    )
    if previous_registry_path != expected_previous_registry:
        _fail("previous_registry_path is not the exact recovery archive path")

    pins = receipt["control_pins"]
    if type(pins) is not dict or not 1 <= len(pins) <= MAX_PINS:
        _fail("control_pins must be a bounded nonempty object")
    startup_prefix = namespace + "/isolated-snapshot/"
    startup_paths = {
        startup_prefix + name for name in (
            "start.json", "copied-content.json", "source-manifest.json",
            "request.json", "original-config.json",
        )
    }
    pin_digests = {}
    for path, pin in pins.items():
        safe_path = _control_relative(path, "control pin path")
        digest = _digest(pin, "control pin digest")
        if (
            safe_path == REGISTRY_PATH
            or safe_path == own_receipt_path
            or (safe_path.startswith(namespace + "/") and safe_path not in startup_paths)
        ):
            _fail("control_pins cannot pin the current registry, snapshot receipt, or other new namespace paths")
        pin_digests[safe_path] = digest

    required_paths = _required_pin_paths(previous_namespace, previous_registry_path, old_attempt)
    required_paths.update(startup_paths)
    if not required_paths.issubset(pin_digests):
        _fail("control_pins omit required prior-session or immutable startup records")
    if pin_digests[previous_registry_path] != previous_registry_sha256:
        _fail("previous registry digest conflicts with its control pin")

    for name, digest_field in (
        ("source-manifest.json", "source_manifest_sha256"),
        ("request.json", "request_sha256"),
        ("original-config.json", "original_config_sha256"),
    ):
        if pin_digests[startup_prefix + name] != receipt[digest_field]:
            _fail("Immutable startup " + name + " digest differs from its archived source pin")

    # A path may be referenced through more than one receipt field only when
    # every reference authenticates the same bytes.
    for path, digest in pin_digests.items():
        previous_digest = source_digests.get(path)
        if previous_digest is not None and previous_digest != digest:
            _fail("receipt references conflicting digests for one control path")
        source_digests[path] = digest

    return receipt


def _json_object_no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise BuildControlError("Control JSON contains a duplicate object key")
        result[key] = value
    return result


def _decode_control_json(raw, label):
    if type(raw) is not bytes or len(raw) > MAX_CONTROL_DOCUMENT_BYTES:
        _fail(label + " is not a bounded raw control document")
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_json_object_no_duplicates)
    except BuildControlError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError, RecursionError) as error:
        raise BuildControlError(label + " is malformed JSON") from error


def _same_json_types(left, right):
    if type(left) is not type(right):
        return False
    if type(left) is dict:
        return (
            left.keys() == right.keys()
            and all(_same_json_types(left[key], right[key]) for key in left)
        )
    if type(left) is list:
        return len(left) == len(right) and all(
            _same_json_types(a, b) for a, b in zip(left, right)
        )
    return left == right


def _validate_registry(registry, control):
    if type(registry) is not dict or set(registry) != _REGISTRY_KEYS:
        _fail("Control namespace registry has an unexpected shape")
    if type(registry["schema"]) is not str or registry["schema"] != REGISTRY_SCHEMA:
        _fail("Control namespace registry schema is unsupported")
    recovery_id = _hex32(registry["recovery_id"], "registry recovery_id")
    if type(registry["namespace"]) is not str or registry["namespace"] != "namespaces/" + recovery_id:
        _fail("Control namespace registry namespace differs from its recovery id")
    if (type(registry["receipt_path"]) is not str
            or registry["receipt_path"] != "namespace-recovery/" + recovery_id + "/terminal.json"):
        _fail("Control namespace registry receipt path is invalid")
    _digest(registry["receipt_sha256"], "registry receipt_sha256")
    if type(control.identity) is not dict:
        _fail("Selected source identity is malformed")
    expected = {
        "compose_project": (control.project, "project"),
        "control_volume": (control.volume, "control volume"),
        "source_project_id": (control.identity.get("project_id"), "project identity"),
        "source_worktree_id": (control.identity.get("worktree_id"), "worktree identity"),
    }
    for field, (value, label) in expected.items():
        _text(value, "Selected " + label)
        if type(registry[field]) is not str or registry[field] != value:
            _fail("Control namespace registry " + field + " differs from the selected source")
    return registry


def _raw_root_control(control):
    """Copy control state so helper_args always addresses /control itself."""
    root_control = copy.copy(control)
    root_control.namespace = ""
    root_control.namespace_registry_sha256 = None
    return root_control


def resolve_snapshot_namespace(control, registry, registry_raw) -> None:
    """Resolve a copied namespace from root-mounted, digest-pinned records.

    The original BuildControl is untouched until all reads, hashes, schema
    checks, and a byte-identical final current-registry reread have succeeded.
    """
    parsed_registry = _decode_control_json(registry_raw, "Initial namespace registry")
    try:
        _validate_registry(parsed_registry, control)
        if not _same_json_types(registry, parsed_registry):
            _fail("Passed namespace registry differs from its supplied raw bytes")
    except BuildControlError:
        raise
    except (AttributeError, KeyError, TypeError, ValueError) as error:
        raise BuildControlError("Control namespace registry or selected identity is malformed") from error

    root_control = _raw_root_control(control)
    try:
        receipt_path = parsed_registry["receipt_path"]
        receipt_raw = _raw(root_control, receipt_path)
        if hashlib.sha256(receipt_raw).hexdigest() != parsed_registry["receipt_sha256"]:
            _fail("Isolated snapshot receipt digest differs from the registry")
        receipt = _decode_control_json(receipt_raw, "Isolated snapshot receipt")
        validate_snapshot_namespace_receipt(
            receipt,
            project=control.project,
            control_volume=control.volume,
            project_id=control.identity["project_id"],
            worktree_id=control.identity["worktree_id"],
        )
        for field in ("recovery_id", "namespace", "compose_project", "control_volume",
                      "source_project_id", "source_worktree_id"):
            if receipt[field] != parsed_registry[field]:
                _fail("Snapshot receipt and namespace registry disagree on " + field)

        referenced = {
            receipt["source_manifest_path"]: receipt["source_manifest_sha256"],
            receipt["request_path"]: receipt["request_sha256"],
            receipt["original_config_path"]: receipt["original_config_sha256"],
            **receipt["control_pins"],
        }
        # Equal duplicate references are read once; conflicting ones were
        # rejected by the pure receipt validator.
        for path, expected_digest in referenced.items():
            raw = _raw(root_control, path)
            if hashlib.sha256(raw).hexdigest() != expected_digest:
                _fail("Pinned snapshot control record digest differs: " + path)

        if _raw(root_control, REGISTRY_PATH) != registry_raw:
            _fail("Control namespace registry changed while resolving snapshot")
    except BuildControlError:
        raise
    except (KeyError, TypeError, ValueError, UnicodeError) as error:
        raise BuildControlError("Isolated snapshot namespace evidence is malformed") from error

    # Keep mutation at the successful end of the transaction only.
    control.namespace = receipt["namespace"]
    control.namespace_registry = {**parsed_registry, "retirement": receipt}
    control.namespace_registry_sha256 = hashlib.sha256(registry_raw).hexdigest()
