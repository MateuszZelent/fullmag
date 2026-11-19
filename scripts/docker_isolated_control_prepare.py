"""Prepare copied snapshot control markers without replacing its live payload.

Before native admission, this operation authenticates the published snapshot
namespace and parks only its verified copied ``local-live`` tree,
runs Fullmag's existing managed control namespace initializer, and restores
the exact tree. It never creates a native OWNER or starts an application.
"""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import re
import shlex

from docker_build_control import (
    BuildControlError,
    ControlOutcomeUnknown,
    bounded_capture,
    canonical,
)
from docker_control_namespace import REGISTRY_PATH, _raw
from docker_isolated_snapshot_namespace import (
    SNAPSHOT_SCHEMA,
    SNAPSHOT_STATE,
    resolve_snapshot_namespace,
    validate_snapshot_namespace_receipt,
)


HELPER_INPUT_SCHEMA = "fullmag.isolated-snapshot-control-prepare-input.v1"
RECEIPT_SCHEMA = "fullmag.isolated-snapshot-control-prepare.v1"
_IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
_ATTEMPT = re.compile(r"[0-9a-f]{32}\Z")
_RECOVERY_ID = _ATTEMPT
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_STARTUP_DOCUMENTS = (
    "start.json",
    "copied-content.json",
    "source-manifest.json",
    "request.json",
    "original-config.json",
)
_MAX_HELPER_INPUT = 8 * 1024 * 1024
_MAX_HELPER_SECONDS = 300


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _same_json(left, right) -> bool:
    """Compare serialized JSON so bool/int equality cannot weaken a pin."""
    try:
        return canonical(left) == canonical(right)
    except (TypeError, ValueError):
        return False


def _fresh_snapshot_record(control, record: dict) -> tuple[dict, bytes]:
    if not isinstance(record, dict):
        raise BuildControlError("Snapshot control preparation requires its resolved receipt")
    if not isinstance(control.identity, dict):
        raise BuildControlError("Snapshot control preparation has no selected source identity")
    root_control = copy.copy(control)
    root_control.namespace = ""
    root_control.namespace_registry = None
    root_control.namespace_registry_sha256 = None
    registry_raw = _raw(root_control, REGISTRY_PATH)
    if not isinstance(registry_raw, bytes) or not registry_raw:
        raise BuildControlError("Snapshot namespace registry is empty")
    try:
        registry = json.loads(registry_raw.decode("utf-8", "strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Snapshot namespace registry is malformed") from error

    resolved = copy.copy(root_control)
    resolve_snapshot_namespace(resolved, registry, registry_raw)
    if (resolved.namespace != control.namespace
            or resolved.namespace_registry_sha256 != control.namespace_registry_sha256
            or not _same_json(resolved.namespace_registry, control.namespace_registry)):
        raise BuildControlError("Snapshot namespace changed since the selected control was resolved")
    actual_record = resolved.namespace_registry.get("retirement")
    if not _same_json(actual_record, record):
        raise BuildControlError("Snapshot control preparation receipt differs from the current registry")
    validate_snapshot_namespace_receipt(
        actual_record,
        project=control.project,
        control_volume=control.volume,
        project_id=control.identity.get("project_id"),
        worktree_id=control.identity.get("worktree_id"),
    )
    if actual_record.get("schema") != SNAPSHOT_SCHEMA or actual_record.get("state") != SNAPSHOT_STATE:
        raise BuildControlError("Current control namespace is not a copied snapshot awaiting admission")
    return resolved.namespace_registry, registry_raw


def _pinned_backend_image(control) -> tuple[str, str]:
    current = control.read("image-backend/current.json", optional=True)
    if not isinstance(current, dict):
        raise BuildControlError("Current backend image receipt is missing")
    attempt = current.get("attempt")
    image_id = current.get("image_id")
    inputs = current.get("inputs")
    source_digest = current.get("source_digest")
    if (current.get("phase") != "image-backend"
            or current.get("state") != "succeeded"
            or current.get("compose_project") != control.project
            or current.get("control_volume") != control.volume
            or not isinstance(attempt, str) or _ATTEMPT.fullmatch(attempt) is None
            or not isinstance(image_id, str) or _IMAGE_ID.fullmatch(image_id) is None
            or not isinstance(inputs, dict)
            or not isinstance(source_digest, str) or _SHA256.fullmatch(source_digest) is None
            or _sha(canonical(inputs)) != source_digest):
        raise BuildControlError("Current backend image receipt is incomplete or unauthenticated")
    terminal_path = f"image-backend/attempts/{attempt}/terminal.json"
    terminal = control.read(terminal_path, optional=True)
    if not isinstance(terminal, dict) or not _same_json(current, terminal):
        raise BuildControlError("Current backend image attempt has no matching succeeded terminal")
    return image_id, attempt


def _helper_payload(control, record, registry_raw, image_id, attempt) -> bytes:
    payload = {
        "schema": HELPER_INPUT_SCHEMA,
        "record": record,
        "control_volume": control.volume,
        "registry_sha256": _sha(registry_raw),
        "project": control.project,
        "project_id": control.identity["project_id"],
        "worktree_id": control.identity["worktree_id"],
        "backend_image_id": image_id,
        "backend_image_attempt": attempt,
    }
    raw = canonical(payload)
    if len(raw) > _MAX_HELPER_INPUT:
        raise BuildControlError("Snapshot control preparation input exceeds its byte limit")
    return raw


def _control_prepare_helper_script(
    *,
    control_root="/control",
    registry_root="/registry",
    module_root="/opt/fullmag",
    owner_uid=65532,
    owner_gid=65532,
) -> str:
    """Render the fixed helper; path/owner overrides are for local fixtures only."""
    return f'''\
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

sys.path.insert(0, {str(module_root)!r})
from runtime_service_snapshot import _content, _exact_json_equal, _json_document, _read
import backend_volume_cache_maintenance as maintenance

INPUT_SCHEMA = {HELPER_INPUT_SCHEMA!r}
RECEIPT_SCHEMA = {RECEIPT_SCHEMA!r}
CONTROL_ROOT = Path({str(control_root)!r})
REGISTRY_ROOT = Path({str(registry_root)!r})
OWNER_UID = {int(owner_uid)!r}
OWNER_GID = {int(owner_gid)!r}
STARTUP_NAMES = {list(_STARTUP_DOCUMENTS)!r}
PARKED_NAME = "parked-local-live"
PARKED_RELATIVE = "isolated-snapshot/" + PARKED_NAME
MAX_INPUT = {_MAX_HELPER_INPUT}
SHA256 = re.compile(r"[0-9a-f]{{64}}\\Z")
RECOVERY_ID = re.compile(r"[0-9a-f]{{32}}\\Z")
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{{64}}\\Z")
_AT_FDCWD = -100
_RENAME_NOREPLACE = 1


def fail(message):
    raise RuntimeError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def require_digest(value, label):
    if not isinstance(value, str) or SHA256.fullmatch(value) is None:
        fail(label + " is not a lowercase SHA-256 digest")
    return value


def require_directory(path, label):
    path = Path(path)
    try:
        metadata = path.lstat()
    except OSError as error:
        fail(label + " is unavailable: " + str(error))
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink() or path.resolve(strict=True) != path:
        fail(label + " is linked or noncanonical")
    return metadata


def names(path):
    return sorted(os.listdir(path))


def request_object():
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        fail("control preparation input exceeds its bound")
    value = _json_document(raw, "control preparation input")
    expected_keys = {{"schema", "record", "control_volume", "registry_sha256", "project",
                      "project_id", "worktree_id", "backend_image_id", "backend_image_attempt"}}
    if not isinstance(value, dict) or set(value) != expected_keys or value.get("schema") != INPUT_SCHEMA:
        fail("control preparation input has an unexpected shape")
    return value


def exact_registry(input_value, record):
    recovery_id = record.get("recovery_id")
    namespace = record.get("namespace")
    if (not isinstance(recovery_id, str) or RECOVERY_ID.fullmatch(recovery_id) is None
            or namespace != "namespaces/" + recovery_id):
        fail("snapshot record has an invalid namespace identity")
    expected = {{
        "schema": "fullmag.docker-control-namespace-registry.v1",
        "recovery_id": recovery_id,
        "namespace": namespace,
        "receipt_path": "namespace-recovery/" + recovery_id + "/terminal.json",
        "compose_project": input_value["project"],
        "control_volume": input_value["control_volume"],
        "source_project_id": input_value["project_id"],
        "source_worktree_id": input_value["worktree_id"],
    }}
    registry_path = REGISTRY_ROOT / "namespaces" / "current.json"
    raw = _read(registry_path, input_value["registry_sha256"])
    registry = _json_document(raw, "current namespace registry")
    if not isinstance(registry, dict) or any(registry.get(key) != value for key, value in expected.items()):
        fail("current namespace registry differs from the snapshot identity")
    if not require_digest(registry.get("receipt_sha256"), "registry receipt hash"):
        fail("current namespace registry has no receipt hash")


def pinned_startup_documents(record):
    namespace = record["namespace"]
    prefix = namespace + "/isolated-snapshot/"
    pins = record.get("control_pins")
    if not isinstance(pins, dict):
        fail("snapshot control pins are malformed")
    expected_paths = {{prefix + name for name in STARTUP_NAMES}}
    current_paths = {{path for path in pins if isinstance(path, str) and path.startswith(namespace + "/")}}
    if current_paths != expected_paths:
        fail("snapshot namespace startup pins are incomplete or contain foreign paths")
    startup_root = CONTROL_ROOT / "isolated-snapshot"
    require_directory(startup_root, "snapshot startup directory")
    allowed_entries = set(STARTUP_NAMES) | {{"native-validation.json", PARKED_NAME}}
    if not set(names(startup_root)).issubset(allowed_entries):
        fail("snapshot startup directory contains an unexpected entry")
    if not set(STARTUP_NAMES).issubset(names(startup_root)):
        fail("snapshot startup documents are incomplete")
    documents = {{}}
    for name in STARTUP_NAMES:
        expected = require_digest(pins.get(prefix + name), "snapshot startup pin")
        documents[name] = _read(startup_root / name, expected)
    native_path = startup_root / "native-validation.json"
    if os.path.lexists(native_path):
        documents["native-validation.json"] = _read(native_path)
    return documents


def validate_payload(input_value, record, documents):
    start = _json_document(documents["start.json"], "snapshot start document")
    request = _json_document(documents["request.json"], "snapshot request")
    source = _json_document(documents["source-manifest.json"], "snapshot source manifest")
    content = _json_document(documents["copied-content.json"], "copied content manifest")
    if not isinstance(start, dict) or set(start) != {{
        "schema", "allow_script_replay", "request_sha256", "config_sha256",
        "source_manifest_sha256", "copied_content_sha256", "restore_run_id",
    }}:
        fail("snapshot start document shape differs")
    if (start.get("schema") != "fullmag.isolated-snapshot-start.v1"
            or start.get("allow_script_replay") is not False
            or start.get("request_sha256") != record.get("request_sha256")
            or start.get("config_sha256") != record.get("original_config_sha256")
            or start.get("source_manifest_sha256") != record.get("source_manifest_sha256")
            or start.get("copied_content_sha256") != sha(documents["copied-content.json"])):
        fail("snapshot start document does not bind its pinned inputs")
    if (not isinstance(request, dict)
            or request.get("schema_version") != "runtime_service_retained_snapshot_validation_request.v1"
            or request.get("source_manifest_sha256") != record.get("source_manifest_sha256")
            or request.get("request_id") is None
            or sha(documents["request.json"]) != record.get("request_sha256")):
        fail("snapshot request does not match its retained pins")
    if (not isinstance(source, dict)
            or source.get("schema") != "fullmag.isolated-session-snapshot-manifest.v1"
            or source.get("restore_run_id") != start.get("restore_run_id")
            or sha(documents["source-manifest.json"]) != record.get("source_manifest_sha256")):
        fail("snapshot source manifest does not match its retained pins")
    if (not isinstance(content, dict) or set(content) != {{"state", "user_data", "live_workspace"}}
            or not _exact_json_equal(content.get("live_workspace"), source.get("live_workspace"))):
        fail("copied content does not match the pinned source workspace")
    workspace = content.get("live_workspace")
    if (not isinstance(workspace, dict)
            or set(workspace) != {{"schema", "present", "tree"}}
            or workspace.get("schema") != "fullmag.isolated-control-workspace.v1"
            or workspace.get("present") is not True):
        fail("copied live workspace must be present with an exact descriptor")
    tree = workspace.get("tree")
    if (not isinstance(tree, dict) or not isinstance(tree.get("files"), list)
            or len(tree["files"]) > 20000
            or not isinstance(tree.get("directories"), list)
            or len(tree["directories"]) > 20000):
        fail("copied live workspace must contain a bounded pinned file tree")
    held = request.get("retained_held_manual_runs")
    terminal = request.get("retained_terminal_runs")
    if not isinstance(held, list) or len(held) != record.get("held_manual_run_count") or not held:
        fail("snapshot held-manual request pins differ")
    if not isinstance(terminal, list) or len(terminal) != record.get("terminal_run_count"):
        fail("snapshot terminal request pins differ")
    restore = start.get("restore_run_id")
    if not any(isinstance(item, dict) and item.get("run_id") == restore for item in held):
        fail("snapshot selected model is not an explicitly held manual run")
    expected_native = {{
        "schema_version": "runtime_service_retained_snapshot_validation.v1",
        "state": "validated-read-only",
        "request_sha256": record["request_sha256"],
        "config_sha256": record["original_config_sha256"],
        "source_manifest_sha256": record["source_manifest_sha256"],
        "run_ids": sorted(
            [item["run_id"] for item in terminal] + [item["run_id"] for item in held]
        ),
        "terminal_count": record["terminal_run_count"],
        "held_count": record["held_manual_run_count"],
        "owner_changed": False,
        "compute_started": False,
    }}
    native_raw = documents.get("native-validation.json")
    if native_raw is not None:
        native = _json_document(native_raw, "native snapshot validation")
        if not _exact_json_equal(native, expected_native):
            fail("native read-only admission receipt differs from the snapshot pins")
    return tree, native_raw is not None


def expected_runtime_marker(volume):
    return {{
        "schema": maintenance.CONTROL_NAMESPACE_SCHEMA,
        "state": "owned",
        "role": "runtime-control",
        "volume_name": volume,
        "mount": maintenance.CONTROL_ROOT,
        "namespace": maintenance.CONTROL_ROOT + "/runtime-control",
    }}


def verify_initialized(runtime_root, volume, *, require_live=True, require_empty_services=False,
                       preserve_owned_entries=False):
    names_now = set(names(runtime_root))
    marker_name = maintenance.CONTROL_MARKER_NAME
    readback_name = maintenance.READBACK_NAME
    expected_names = {{marker_name, readback_name, "runtime-services"}}
    if require_live:
        expected_names.add("local-live")
    if (not expected_names.issubset(names_now)
            or (not preserve_owned_entries and names_now != expected_names)):
        fail("runtime-control entries do not match the initialized namespace")
    marker_path = runtime_root / marker_name
    marker = expected_runtime_marker(volume)
    marker_raw = canonical(marker) + b"\\n"
    if _read(marker_path) != marker_raw:
        fail("runtime-control marker differs from the factory contract")
    readback_path = runtime_root / readback_name
    readback = _read(readback_path)
    expected_readback = b"fullmag-cache-readback:" + hashlib.sha256(canonical(marker)).hexdigest().encode("ascii")
    if readback != expected_readback:
        fail("runtime-control readback differs from the factory contract")
    services = runtime_root / "runtime-services"
    require_directory(services, "runtime-services directory")
    if require_empty_services and names(services):
        fail("runtime-services must be empty before native ownership")
    runtime_service = runtime_root / "runtime-service"
    if os.path.lexists(runtime_service):
        require_directory(runtime_service, "runtime-service directory")
    return sha(marker_raw), sha(expected_readback)


def inspect_runtime_state(runtime_root, snapshot_root, volume, tree, *, native_present):
    present = set(names(runtime_root))
    marker_name = maintenance.CONTROL_MARKER_NAME
    readback_name = maintenance.READBACK_NAME
    marker_path = runtime_root / marker_name
    marker_present = os.path.lexists(marker_path)
    live_present = os.path.lexists(runtime_root / "local-live")
    parked_present = os.path.lexists(snapshot_root / PARKED_NAME)
    if live_present == parked_present:
        fail("exactly one live or parked workspace tree must exist")
    if not marker_present:
        allowed = {{"local-live", marker_name, readback_name, "runtime-services"}}
        if not present.issubset(allowed):
            fail("unowned runtime-control contains a foreign namespace entry")
        if readback_name in present:
            fail("runtime-control has a readback without its owner marker")
        if native_present:
            fail("native admission exists before the technical control marker")
        services = runtime_root / "runtime-services"
        if "runtime-services" in present:
            require_directory(services, "runtime-services directory")
            if names(services):
                fail("unowned runtime-services must be empty before native admission")
        if present - {{"local-live", "runtime-services"}}:
            fail("unowned runtime-control has unexpected technical entries")
        return "unowned"

    marker = expected_runtime_marker(volume)
    marker_raw = canonical(marker) + b"\\n"
    if _read(marker_path) != marker_raw:
        fail("runtime-control marker differs from the factory contract")
    if readback_name in present:
        expected_readback = b"fullmag-cache-readback:" + hashlib.sha256(canonical(marker)).hexdigest().encode("ascii")
        if _read(runtime_root / readback_name) != expected_readback:
            fail("runtime-control readback differs from the factory contract")
    services = runtime_root / "runtime-services"
    if "runtime-services" in present:
        require_directory(services, "runtime-services directory")
    runtime_service = runtime_root / "runtime-service"
    if os.path.lexists(runtime_service):
        require_directory(runtime_service, "runtime-service directory")
    if parked_present:
        _content(snapshot_root / PARKED_NAME, tree)
    return "owned"


def rename_noreplace(source_parent_fd, source_name, target_parent_fd, target_name):
    function = getattr(ctypes.CDLL(None, use_errno=True), "renameat2", None)
    if function is None:
        fail("atomic no-replace directory rename is unavailable")
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    result = function(source_parent_fd, os.fsencode(source_name), target_parent_fd,
                      os.fsencode(target_name), _RENAME_NOREPLACE)
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number), target_name)


def open_directory(path, label):
    before = require_directory(path, label)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    opened = os.fstat(descriptor)
    if (not stat.S_ISDIR(opened.st_mode)
            or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)):
        os.close(descriptor)
        fail(label + " changed during open")
    return descriptor, (opened.st_dev, opened.st_ino)


def verify_directory(path, descriptor, identity, label):
    current = os.fstat(descriptor)
    named = path.lstat()
    if (not stat.S_ISDIR(named.st_mode) or path.is_symlink()
            or (current.st_dev, current.st_ino) != identity
            or (named.st_dev, named.st_ino) != identity):
        fail(label + " changed during namespace preparation")


def move_live(runtime_fd, snapshot_fd, runtime_root, snapshot_root, *, to_parked):
    if to_parked:
        source_name, target_name = "local-live", PARKED_NAME
        source_parent, target_parent = runtime_fd, snapshot_fd
    else:
        source_name, target_name = PARKED_NAME, "local-live"
        source_parent, target_parent = snapshot_fd, runtime_fd
    source_metadata = os.stat(source_name, dir_fd=source_parent, follow_symlinks=False)
    if not stat.S_ISDIR(source_metadata.st_mode):
        fail("live workspace move source is not a real directory")
    try:
        os.stat(target_name, dir_fd=target_parent, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        fail("live workspace move target already exists; no replacement allowed")
    rename_noreplace(source_parent, source_name, target_parent, target_name)
    os.fsync(source_parent)
    if source_parent != target_parent:
        os.fsync(target_parent)
    moved = os.stat(target_name, dir_fd=target_parent, follow_symlinks=False)
    if (moved.st_dev, moved.st_ino) != (source_metadata.st_dev, source_metadata.st_ino):
        fail("live workspace directory identity changed during its atomic move")
    verify_directory(runtime_root, runtime_fd, (os.fstat(runtime_fd).st_dev, os.fstat(runtime_fd).st_ino), "runtime-control")
    verify_directory(snapshot_root, snapshot_fd, (os.fstat(snapshot_fd).st_dev, os.fstat(snapshot_fd).st_ino), "snapshot startup directory")


def ensure_factory_and_restore(runtime_fd, snapshot_fd, runtime_root, snapshot_root,
                               volume, tree, *, require_empty_services):
    live_path = runtime_root / "local-live"
    parked_path = snapshot_root / PARKED_NAME
    try:
        maintenance._ensure_control_namespace(
            str(CONTROL_ROOT), volume, OWNER_UID, OWNER_GID
        )
        marker_sha, readback_sha = verify_initialized(
            runtime_root, volume, require_live=not os.path.lexists(parked_path),
            require_empty_services=require_empty_services,
            preserve_owned_entries=not require_empty_services,
        )
        if os.path.lexists(parked_path):
            if os.path.lexists(live_path):
                fail("live workspace target appeared while its verified tree was parked")
            _content(parked_path, tree)
            move_live(runtime_fd, snapshot_fd, runtime_root, snapshot_root, to_parked=False)
        return marker_sha, readback_sha
    except BaseException:
        if os.path.lexists(parked_path) and not os.path.lexists(live_path):
            try:
                _content(parked_path, tree)
                move_live(runtime_fd, snapshot_fd, runtime_root, snapshot_root, to_parked=False)
                _content(live_path, tree)
                print("SNAPSHOT_CONTROL_PREPARE_RESTORED=runtime-control/local-live",
                      file=sys.stderr, flush=True)
            except BaseException as restore_error:
                print("SNAPSHOT_CONTROL_PREPARE_PARKED=" + PARKED_RELATIVE
                      + " restore_error=" + str(restore_error),
                      file=sys.stderr, flush=True)
        elif os.path.lexists(parked_path):
            print("SNAPSHOT_CONTROL_PREPARE_PARKED=" + PARKED_RELATIVE
                  + " local-live target is occupied; no replacement performed",
                  file=sys.stderr, flush=True)
        raise


def run():
    input_value = request_object()
    record = input_value["record"]
    if (not isinstance(record, dict)
            or record.get("schema") != "fullmag.docker-isolated-session-snapshot.v1"
            or record.get("state") != "snapshot-copied-awaiting-native-admission"
            or record.get("compose_project") != input_value["project"]
            or record.get("control_volume") != input_value["control_volume"]
            or record.get("source_project_id") != input_value["project_id"]
            or record.get("source_worktree_id") != input_value["worktree_id"]
            or record.get("namespace") != "namespaces/" + str(record.get("recovery_id"))):
        fail("snapshot record does not bind the selected control namespace")
    if (not isinstance(input_value["project"], str) or not input_value["project"]
            or not isinstance(input_value["control_volume"], str) or not input_value["control_volume"]
            or not isinstance(input_value["project_id"], str) or not input_value["project_id"]
            or not isinstance(input_value["worktree_id"], str) or not input_value["worktree_id"]
            or not isinstance(input_value["backend_image_id"], str)
            or IMAGE_ID.fullmatch(input_value["backend_image_id"]) is None
            or not isinstance(input_value["backend_image_attempt"], str)
            or RECOVERY_ID.fullmatch(input_value["backend_image_attempt"]) is None):
        fail("pinned source or backend image identity is malformed")
    exact_registry(input_value, record)
    startup = pinned_startup_documents(record)
    tree, native_present = validate_payload(input_value, record, startup)
    require_directory(CONTROL_ROOT, "current control namespace root")
    runtime_root = CONTROL_ROOT / "runtime-control"
    snapshot_root = CONTROL_ROOT / "isolated-snapshot"
    require_directory(runtime_root, "runtime-control directory")
    require_directory(snapshot_root, "snapshot startup directory")
    runtime_fd, runtime_identity = open_directory(runtime_root, "runtime-control directory")
    snapshot_fd, snapshot_identity = open_directory(snapshot_root, "snapshot startup directory")
    try:
        parked_path = snapshot_root / PARKED_NAME
        live_path = runtime_root / "local-live"
        state = inspect_runtime_state(
            runtime_root, snapshot_root, input_value["control_volume"], tree,
            native_present=native_present,
        )
        live_exists = os.path.lexists(live_path)
        if state == "unowned":
            if live_exists:
                _content(live_path, tree)
                move_live(runtime_fd, snapshot_fd, runtime_root, snapshot_root, to_parked=True)
            else:
                _content(parked_path, tree)
            marker_sha, readback_sha = ensure_factory_and_restore(
                runtime_fd, snapshot_fd, runtime_root, snapshot_root,
                input_value["control_volume"], tree, require_empty_services=True,
            )
            baseline_verified = True
        else:
            if live_exists:
                require_directory(live_path, "owned live workspace directory")
            else:
                _content(parked_path, tree)
            marker_sha, readback_sha = ensure_factory_and_restore(
                runtime_fd, snapshot_fd, runtime_root, snapshot_root,
                input_value["control_volume"], tree, require_empty_services=False,
            )
            baseline_verified = not live_exists

        verify_directory(runtime_root, runtime_fd, runtime_identity, "runtime-control directory")
        verify_directory(snapshot_root, snapshot_fd, snapshot_identity, "snapshot startup directory")
        restored = runtime_root / "local-live"
        require_directory(restored, "restored live workspace directory")
        if baseline_verified:
            _content(restored, tree)
        if PARKED_NAME in names(snapshot_root):
            fail("parked live workspace remains after successful restoration")
        marker_sha, readback_sha = verify_initialized(
            runtime_root, input_value["control_volume"], require_live=True,
            require_empty_services=(state == "unowned"),
            preserve_owned_entries=(state == "owned"),
        )
        response = {{
            "schema": RECEIPT_SCHEMA,
            "state": "initialized",
            "recovery_id": record["recovery_id"],
            "namespace": record["namespace"],
            "control_volume": input_value["control_volume"],
            "backend_image_id": input_value["backend_image_id"],
            "backend_image_attempt": input_value["backend_image_attempt"],
            "live_workspace_file_count": len(tree["files"]),
            "live_workspace_tree_sha256": sha(canonical(tree)),
            "workspace_baseline_verified": baseline_verified,
            "native_admission_present": native_present,
            "control_marker_sha256": marker_sha,
            "control_readback_sha256": readback_sha,
            "source_unchanged": True,
            "compute_started": False,
        }}
        print(json.dumps(response, sort_keys=True, separators=(",", ":")))
    except BaseException:
        if os.path.lexists(snapshot_root / PARKED_NAME):
            print("SNAPSHOT_CONTROL_PREPARE_PARKED=" + PARKED_RELATIVE,
                  file=sys.stderr, flush=True)
        raise
    finally:
        os.close(snapshot_fd)
        os.close(runtime_fd)


run()
'''


def _validated_receipt(raw: bytes, record: dict, control, image_id: str, attempt: str,
                       expected_file_count: int) -> dict:
    try:
        result = json.loads(raw.decode("utf-8", "strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ControlOutcomeUnknown("Managed snapshot control helper returned malformed evidence") from error
    if (not isinstance(result, dict)
            or result.get("schema") != RECEIPT_SCHEMA
            or result.get("state") != "initialized"
            or result.get("recovery_id") != record.get("recovery_id")
            or result.get("namespace") != record.get("namespace")
            or result.get("control_volume") != control.volume
            or result.get("backend_image_id") != image_id
            or result.get("backend_image_attempt") != attempt
            or type(result.get("live_workspace_file_count")) is not int
            or result.get("live_workspace_file_count") != expected_file_count
            or _SHA256.fullmatch(result.get("live_workspace_tree_sha256", "")) is None
            or _SHA256.fullmatch(result.get("control_marker_sha256", "")) is None
            or _SHA256.fullmatch(result.get("control_readback_sha256", "")) is None
            or type(result.get("workspace_baseline_verified")) is not bool
            or type(result.get("native_admission_present")) is not bool
            or result.get("source_unchanged") is not True
            or result.get("compute_started") is not False
            or set(result) != {
                "schema", "state", "recovery_id", "namespace", "control_volume",
                "backend_image_id", "backend_image_attempt", "live_workspace_file_count",
                "live_workspace_tree_sha256", "workspace_baseline_verified",
                "native_admission_present", "control_marker_sha256",
                "control_readback_sha256", "source_unchanged", "compute_started",
            }):
        raise ControlOutcomeUnknown("Managed snapshot control helper returned different evidence")
    return result


def _operation_root(operation) -> str:
    if not isinstance(operation, dict) or not isinstance(operation.get("receipt"), dict):
        raise BuildControlError("Snapshot control preparation has no managed operation receipt")
    receipt = operation["receipt"]
    attempt = receipt.get("attempt")
    phase = receipt.get("phase")
    root = operation.get("root")
    if (phase not in {"development", "snapshot-control-prepare"}
            or not isinstance(attempt, str) or _ATTEMPT.fullmatch(attempt) is None
            or root != f"{phase}/attempts/{attempt}"):
        raise BuildControlError("Snapshot control preparation operation identity is invalid")
    return root


def _execute_prepare(control, record, registry_raw, image_id, attempt, operation) -> dict:
    root = _operation_root(operation)
    helper_control = copy.copy(control)
    helper_control.image = image_id
    if hasattr(control, "_assert_live_operation_helper") and operation is not None:
        control._assert_live_operation_helper(operation)
    from docker_dev import _assert_no_running_fullmag

    operation_receipt = operation["receipt"]
    _assert_no_running_fullmag(
        control.project,
        control.identity,
        owned_control={
            "name": operation_receipt.get("helper_container"),
            "image": control.image,
            "volume": control.volume,
            "attempt": operation_receipt.get("attempt"),
            "namespace": control.namespace,
        },
    )
    copied_content = control.read("isolated-snapshot/copied-content.json")
    workspace = copied_content.get("live_workspace") if isinstance(copied_content, dict) else None
    tree = workspace.get("tree") if isinstance(workspace, dict) else None
    files = tree.get("files") if isinstance(tree, dict) else None
    if (not isinstance(workspace, dict) or workspace.get("present") is not True
            or not isinstance(files, list) or len(files) > 20000):
        raise BuildControlError("Pinned copied live-workspace file inventory is malformed")
    expected_file_count = len(files)
    payload = _helper_payload(control, record, registry_raw, image_id, attempt)
    command = "exec /usr/local/bin/python3 -I -B -c " + shlex.quote(
        _control_prepare_helper_script()
    )
    helper_name = "fullmag-snapshot-control-" + operation["receipt"]["attempt"]
    operation["receipt"]["snapshot_control_helper"] = helper_name
    operation["receipt"]["snapshot_control_helper_image"] = image_id
    control.write(root + "/receipt.json", operation["receipt"])
    arguments = helper_control.helper_args(command, name=helper_name, initialize=True)
    operation["daemon_pending"] = True
    result = bounded_capture(arguments, data=payload, timeout=_MAX_HELPER_SECONDS)
    operation["daemon_pending"] = False
    if result.returncode:
        detail = result.stderr.decode("utf-8", "replace")[-2048:]
        raise BuildControlError(
            "Snapshot control preparation failed; retain the namespace and inspect its resumable state: "
            + detail
        )
    receipt = _validated_receipt(
        result.stdout, record, control, image_id, attempt, expected_file_count
    )
    receipt_path = root + "/snapshot-control-prepare.json"
    control.write(receipt_path, receipt)
    operation["receipt"]["snapshot_control_prepare"] = receipt
    return receipt


def prepare_snapshot_control(control, record, operation=None) -> dict:
    """Initialize only the isolated copied namespace's technical controls.

    The native OWNER remains absent. When the caller already owns a managed
    development lease, pass its operation to avoid opening a nested lease.
    """
    _registry_document, registry_raw = _fresh_snapshot_record(control, record)
    image_id, attempt = _pinned_backend_image(control)
    inputs = {
        "schema": HELPER_INPUT_SCHEMA,
        "recovery_id": record["recovery_id"],
        "namespace": record["namespace"],
        "control_volume": control.volume,
        "namespace_registry_sha256": _sha(registry_raw),
        "image_backend_attempt": attempt,
        "image_id": image_id,
    }
    if operation is not None:
        return _execute_prepare(control, record, registry_raw, image_id, attempt, operation)

    helper_control = copy.copy(control)
    helper_control.image = image_id
    with helper_control.operation("snapshot-control-prepare", inputs) as owned_operation:
        receipt = _execute_prepare(
            helper_control, record, registry_raw, image_id, attempt, owned_operation
        )
        owned_operation["receipt"].update(
            state="succeeded",
            source_unchanged=True,
            compute_started=False,
        )
        return receipt
