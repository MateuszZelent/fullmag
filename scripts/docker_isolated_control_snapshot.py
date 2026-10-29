"""Read-only snapshot and isolated publication of one API control workspace.

The helper source embeds the bounded tree copier so the short-lived Docker
control helper needs no repository bind mount, image install, or build.
"""
from __future__ import annotations

import copy
import json
import re
import shlex
import sys
from pathlib import Path

from docker_build_control import (
    MAX_DOCUMENT_BYTES,
    BuildControlError,
    bounded_capture,
    canonical,
)


CONTROL_SNAPSHOT_SCHEMA = "fullmag.isolated-control-workspace.v1"
_RECOVERY_ID = re.compile(r"[0-9a-f]{32}\Z")
_NAMESPACE = re.compile(r"namespaces/[0-9a-f]{32}\Z")
_IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
_MAX_HELPER_SECONDS = 1800


_CONTROL_HELPER = r'''
CONTROL_SNAPSHOT_SCHEMA = "fullmag.isolated-control-workspace.v1"
_RECOVERY_ID = re.compile(r"[0-9a-f]{32}\Z")
_NAMESPACE = re.compile(r"namespaces/[0-9a-f]{32}\Z")
_REQUEST_LIMIT = 8 * 1024 * 1024

def _request_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("request JSON contains a duplicate key")
        result[key] = value
    return result

def _identity(metadata):
    return (metadata.st_dev, metadata.st_ino, metadata.st_mode,
            metadata.st_nlink, metadata.st_size, metadata.st_mtime_ns,
            metadata.st_ctime_ns, metadata.st_uid, metadata.st_gid)

def _validate_control_wrapper(value, source_root):
    if not isinstance(value, dict) or value.get("schema") != CONTROL_SNAPSHOT_SCHEMA:
        raise SnapshotError("expected control-workspace record has an unsupported schema")
    if value.get("present") is False:
        if set(value) != {"schema", "present"}:
            raise SnapshotError("absent control-workspace record has an unexpected shape")
        return {"schema": CONTROL_SNAPSHOT_SCHEMA, "present": False}
    if value.get("present") is not True or set(value) != {"schema", "present", "tree"}:
        raise SnapshotError("present control-workspace record has an unexpected shape")
    tree = _validate_manifest(value["tree"])
    if tree["source_root"] != str(source_root):
        raise SnapshotError("expected control tree names a different source root")
    return {"schema": CONTROL_SNAPSHOT_SCHEMA, "present": True, "tree": tree}

def _verify_parent(parent, parent_fd, parent_chain, parent_identity):
    _same_identity(os.fstat(parent_fd), parent_identity, "control source parent")
    _verify_path_chain(parent_chain)
    _verify_reopened_path_chain(parent, parent_chain)
    _same_identity(os.stat(parent, follow_symlinks=False), parent_identity,
                   "named control source parent")

def _verify_source(parent, parent_fd, parent_chain, parent_identity,
                   source_fd, source_identity, source_name, source_names):
    _verify_parent(parent, parent_fd, parent_chain, parent_identity)
    _same_identity(os.fstat(source_fd), source_identity, "control workspace root")
    named = os.stat(source_name, dir_fd=parent_fd, follow_symlinks=False)
    _same_identity(named, source_identity, "named control workspace root")
    if _list_directory(source_fd) != source_names:
        raise SnapshotError("control workspace root listing changed during snapshot")

def _open_source(source):
    parent = source.parent
    parent = _canonical_existing_directory(parent, "control workspace parent")
    parent_fd, parent_chain = _open_directory_path(parent)
    source_fd = -1
    try:
        parent_identity = _identity(os.fstat(parent_fd))
        source_name = source.name
        names_before = _list_directory(parent_fd)
        try:
            metadata = os.stat(source_name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            names_after = _list_directory(parent_fd)
            if source_name in names_before or names_after != names_before:
                raise SnapshotError("control workspace presence changed during inspection")
            _verify_parent(parent, parent_fd, parent_chain, parent_identity)
            try:
                os.stat(source_name, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                return None, parent_fd, parent_chain, parent_identity, names_before
            raise SnapshotError("control workspace appeared during absence verification")
        if not stat.S_ISDIR(metadata.st_mode):
            raise SnapshotError("control workspace root is a link or non-directory")
        source_fd = _open_child_directory(parent_fd, source_name, _identity(metadata))
        _verify_parent(parent, parent_fd, parent_chain, parent_identity)
        return source_fd, parent_fd, parent_chain, parent_identity, names_before
    except BaseException:
        if source_fd >= 0:
            os.close(source_fd)
        _close_chain(parent_chain, parent_fd)
        raise

def _existing_session_store(source_fd, source):
    names_before = _list_directory(source_fd)
    try:
        metadata = os.stat("session-store", dir_fd=source_fd, follow_symlinks=False)
    except FileNotFoundError:
        if "session-store" in names_before or _list_directory(source_fd) != names_before:
            raise SnapshotError("session-store presence changed during inspection")
        return None
    if not stat.S_ISDIR(metadata.st_mode):
        raise SnapshotError("existing session-store is a link or non-directory")
    store_path = source / "session-store"
    store = _canonical_existing_directory(store_path, "session-store")
    return store, _identity(metadata), names_before

def _destination_parent(control_root, recovery_id):
    namespaces = _canonical_existing_directory(control_root / "namespaces",
                                               "destination namespaces directory")
    namespace = namespaces / recovery_id
    namespace_fd, namespace_chain = _open_directory_path(namespace)
    try:
        namespace_identity = _identity(os.fstat(namespace_fd))
        _verify_path_chain(namespace_chain)
        _verify_reopened_path_chain(namespace, namespace_chain)
        return namespaces, namespace, namespace_fd, namespace_chain, namespace_identity
    except BaseException:
        _close_chain(namespace_chain, namespace_fd)
        raise

def _publish_tree(control_root, recovery_id, source, source_manifest,
                  verify_source):
    _namespaces, namespace, namespace_fd, namespace_chain, namespace_identity = (
        _destination_parent(control_root, recovery_id)
    )
    runtime_fd = -1
    try:
        _same_identity(os.fstat(namespace_fd), namespace_identity,
                       "destination namespace")
        try:
            os.stat("runtime-control", dir_fd=namespace_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise SnapshotError("destination runtime-control already exists")
        os.mkdir("runtime-control", mode=0o750, dir_fd=namespace_fd)
        os.fsync(namespace_fd)
        runtime_fd = _open_child_directory(namespace_fd, "runtime-control")
        runtime_identity = _identity(os.fstat(runtime_fd))
        if _list_directory(runtime_fd):
            raise SnapshotError("new destination runtime-control is not empty")
        _verify_path_chain(namespace_chain)
        _verify_reopened_path_chain(namespace, namespace_chain)
        _same_directory_object(os.stat("runtime-control", dir_fd=namespace_fd,
                                       follow_symlinks=False), runtime_identity,
                               "named destination runtime-control before copy")
        verify_source()
        destination = namespace / "runtime-control" / "local-live"
        copied = copy_verified_tree(source, destination, source_manifest)
        verify_source()
        _same_directory_object(os.fstat(namespace_fd), namespace_identity,
                               "destination namespace after copy")
        _verify_path_chain(namespace_chain)
        _verify_reopened_path_chain(namespace, namespace_chain)
        _same_directory_object(os.fstat(runtime_fd), runtime_identity,
                               "destination runtime-control after copy")
        _same_directory_object(os.stat("runtime-control", dir_fd=namespace_fd,
                                       follow_symlinks=False), runtime_identity,
                               "named destination runtime-control after copy")
        if copied["destination_identity"] == source_manifest["root_identity"]:
            raise SnapshotError("destination control workspace reused the source root inode")
        return True
    finally:
        if runtime_fd >= 0:
            os.close(runtime_fd)
        _close_chain(namespace_chain, namespace_fd)

def _run_control_snapshot(request, control_root):
    if not isinstance(request, dict) or set(request) != {
            "recovery_id", "old_namespace", "expected", "publish"}:
        raise SnapshotError("control snapshot request has an unexpected shape")
    recovery_id = request["recovery_id"]
    old_namespace = request["old_namespace"]
    publish = request["publish"]
    if not isinstance(recovery_id, str) or _RECOVERY_ID.fullmatch(recovery_id) is None:
        raise SnapshotError("control snapshot recovery identity is invalid")
    if (not isinstance(old_namespace, str)
            or (old_namespace and _NAMESPACE.fullmatch(old_namespace) is None)
            or old_namespace == "namespaces/" + recovery_id):
        raise SnapshotError("control snapshot source namespace is invalid or reused")
    if type(publish) is not bool:
        raise SnapshotError("control snapshot publish flag must be boolean")
    expected = request["expected"]
    if publish and expected is None:
        raise SnapshotError("publishing a control snapshot requires an earlier expected record")
    if expected is not None and not isinstance(expected, dict):
        raise SnapshotError("expected control-workspace record must be an object")

    root = _canonical_existing_directory(control_root, "control root")
    source = root
    if old_namespace:
        source = source / old_namespace
        source = _canonical_existing_directory(source, "source namespace")
    source = source / "runtime-control" / "local-live"
    destination = "/control/namespaces/" + recovery_id + "/runtime-control/local-live"

    source_fd, parent_fd, parent_chain, parent_identity, parent_names = _open_source(source)
    if source_fd is None:
        try:
            absent = {"schema": CONTROL_SNAPSHOT_SCHEMA, "present": False}
            if expected is not None and _validate_control_wrapper(expected, source) != absent:
                raise SnapshotError("current control workspace differs from the expected record")
            if publish:
                # A genuinely absent source has no destination subtree to create.
                return {"source": absent, "copied": False, "destination": destination}
            return {"source": absent, "copied": False, "destination": destination}
        finally:
            _close_chain(parent_chain, parent_fd)

    try:
        source_identity = _identity(os.fstat(source_fd))
        source_names = _list_directory(source_fd)
        if "current" not in source_names:
            raise SnapshotError("present control workspace has no current model directory")
        session_store = _existing_session_store(source_fd, source)
    except BaseException:
        os.close(source_fd)
        _close_chain(parent_chain, parent_fd)
        raise

    def verify_source():
        _verify_source(source.parent, parent_fd, parent_chain, parent_identity,
                       source_fd, source_identity, source.name, source_names)
        if _list_directory(parent_fd) != parent_names:
            raise SnapshotError("control source parent listing changed during snapshot")

    try:
        if session_store is None:
            source_manifest = snapshot_tree(source)
            verify_source()
            if source_manifest["root_identity"] != {
                    "device": source_identity[0], "inode": source_identity[1]}:
                raise SnapshotError("control workspace path changed after it was opened")
            if "current" not in source_manifest["directories"]:
                raise SnapshotError("control workspace current model is not a directory")
            wrapped = {"schema": CONTROL_SNAPSHOT_SCHEMA, "present": True,
                       "tree": source_manifest}
            if expected is not None and _validate_control_wrapper(expected, source) != wrapped:
                raise SnapshotError("current control workspace differs from the expected record")
            copied = False
            if publish:
                copied = _publish_tree(root, recovery_id, source,
                                       source_manifest, verify_source)
            verify_source()
            return {"source": wrapped, "copied": copied, "destination": destination}

        store_path, store_identity, source_names_before_store = session_store
        if source_names_before_store != source_names:
            raise SnapshotError("control workspace listing changed before writer admission")
        with hold_source_writer(store_path) as store_fd:
            _same_identity(os.fstat(store_fd), store_identity, "locked session-store")
            _same_identity(os.stat(store_path, follow_symlinks=False), store_identity,
                           "named locked session-store")
            source_manifest = snapshot_tree(source)
            verify_source()
            if source_manifest["root_identity"] != {
                    "device": source_identity[0], "inode": source_identity[1]}:
                raise SnapshotError("control workspace path changed after it was opened")
            if "current" not in source_manifest["directories"]:
                raise SnapshotError("control workspace current model is not a directory")
            wrapped = {"schema": CONTROL_SNAPSHOT_SCHEMA, "present": True,
                       "tree": source_manifest}
            if expected is not None and _validate_control_wrapper(expected, source) != wrapped:
                raise SnapshotError("current control workspace differs from the expected record")
            copied = False
            if publish:
                copied = _publish_tree(root, recovery_id, source,
                                       source_manifest, verify_source)
            verify_source()
            return {"source": wrapped, "copied": copied, "destination": destination}
    finally:
        os.close(source_fd)
        _close_chain(parent_chain, parent_fd)

def _main():
    try:
        raw = sys.stdin.buffer.read(_REQUEST_LIMIT + 1)
        if len(raw) > _REQUEST_LIMIT:
            raise SnapshotError("control snapshot request exceeds its byte limit")
        request = json.loads(raw.decode("utf-8", "strict"),
                             object_pairs_hook=_request_object,
                             parse_constant=_reject_json_constant)
        result = _run_control_snapshot(request, CONTROL_ROOT)
        encoded = json.dumps(result, sort_keys=True, separators=(",", ":"),
                             ensure_ascii=False).encode("utf-8")
        if len(encoded) > _REQUEST_LIMIT:
            raise SnapshotError("control snapshot response exceeds its byte limit")
        sys.stdout.buffer.write(encoded + b"\n")
        return 0
    except BaseException as error:
        message = str(error).replace("\n", " ")[:900]
        sys.stderr.write("control snapshot failed: " + message + "\n")
        return 1

if __name__ == "__main__":
    raise SystemExit(_main())
'''


def helper_script_text(control_root: Path | str = "/control") -> str:
    """Return the self-contained helper program, using a test root when supplied."""
    root = Path(control_root)
    if not root.is_absolute() or ".." in root.parts:
        raise BuildControlError("Control helper root must be an absolute canonical path")
    copier_path = Path(__file__).with_name("docker_isolated_snapshot_copy.py")
    try:
        copier_source = copier_path.read_text(encoding="utf-8")
    except OSError as error:
        raise BuildControlError("Cannot embed the bounded control snapshot copier") from error
    return (copier_source + "\n\nCONTROL_ROOT = Path(" + repr(str(root)) + ")\n"
            + _CONTROL_HELPER)


def _expected_shape(value: object, *, source_root: str | None = None) -> None:
    if not isinstance(value, dict) or value.get("schema") != CONTROL_SNAPSHOT_SCHEMA:
        raise BuildControlError("Expected control snapshot has an unsupported schema")
    if value.get("present") is False:
        if set(value) != {"schema", "present"}:
            raise BuildControlError("Absent expected control snapshot has an unexpected shape")
        return
    if value.get("present") is not True or set(value) != {"schema", "present", "tree"}:
        raise BuildControlError("Expected control snapshot has an unexpected shape")
    if not isinstance(value["tree"], dict):
        raise BuildControlError("Expected control snapshot tree must be an object")
    try:
        from docker_isolated_snapshot_copy import _validate_manifest
        normalized = _validate_manifest(value["tree"])
    except (ImportError, ValueError) as error:
        raise BuildControlError("Expected control snapshot tree is invalid") from error
    if normalized != value["tree"]:
        raise BuildControlError("Expected control snapshot tree is not canonical")
    if source_root is not None and normalized["source_root"] != source_root:
        raise BuildControlError("Control snapshot tree names a different source root")


def _unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("JSON object contains a duplicate key")
        result[key] = value
    return result


def _expected_source_root(old_namespace: str) -> str:
    source = Path("/control")
    if old_namespace:
        source = source / old_namespace
    return str(source / "runtime-control" / "local-live")


def snapshot_control_workspace(
    control,
    recovery_id: str,
    *,
    image_id: str,
    expected: dict | None = None,
    publish: bool = False,
) -> dict:
    """Preview or publish the fixed local-live tree into a recovery namespace.

    Source paths are derived only from the selected control namespace and the
    validated recovery token. ``publish`` is a compare-and-copy operation and
    requires the exact prior source record in ``expected``.
    """
    if not sys.platform.startswith("linux"):
        raise BuildControlError("Control workspace snapshots are supported only on Linux")
    if not isinstance(image_id, str) or _IMAGE_ID.fullmatch(image_id) is None:
        raise BuildControlError("Control snapshot requires an exact immutable backend image ID")
    if not isinstance(recovery_id, str) or _RECOVERY_ID.fullmatch(recovery_id) is None:
        raise BuildControlError("Control snapshot requires an explicit 32-hex recovery identity")
    old_namespace = getattr(control, "namespace", None)
    if (not isinstance(old_namespace, str)
            or (old_namespace and _NAMESPACE.fullmatch(old_namespace) is None)
            or old_namespace == "namespaces/" + recovery_id):
        raise BuildControlError("Control snapshot source namespace is invalid or reused")
    if type(publish) is not bool:
        raise BuildControlError("Control snapshot publish flag must be boolean")
    if expected is not None:
        _expected_shape(expected)
    if publish and expected is None:
        raise BuildControlError("Publishing a control snapshot requires an earlier expected record")

    request = {
        "recovery_id": recovery_id,
        "old_namespace": old_namespace,
        "expected": expected,
        "publish": publish,
    }
    try:
        data = canonical(request)
    except (TypeError, ValueError) as error:
        raise BuildControlError("Control snapshot request is not canonical JSON") from error
    if len(data) > MAX_DOCUMENT_BYTES:
        raise BuildControlError("Control snapshot request exceeds the control document limit")

    raw_control = copy.copy(control)
    raw_control.namespace = ""
    raw_control.image = image_id
    if hasattr(raw_control, "namespace_registry_sha256"):
        raw_control.namespace_registry_sha256 = None
    script = "exec python3 -I -B -c " + shlex.quote(helper_script_text())
    result = bounded_capture(
        raw_control.helper_args(script), data=data,
        timeout=_MAX_HELPER_SECONDS, maximum=MAX_DOCUMENT_BYTES,
    )
    if result.returncode:
        detail = result.stderr.decode("utf-8", "replace")[-1024:]
        raise BuildControlError("Control workspace snapshot failed" + (": " + detail if detail else ""))
    try:
        response = json.loads(result.stdout.decode("utf-8", "strict"),
                              object_pairs_hook=_unique_json_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise BuildControlError("Control workspace helper returned invalid JSON") from error
    expected_destination = "/control/namespaces/" + recovery_id + "/runtime-control/local-live"
    if (not isinstance(response, dict)
            or set(response) != {"source", "copied", "destination"}
            or type(response.get("copied")) is not bool
            or response.get("destination") != expected_destination):
        raise BuildControlError("Control workspace helper returned an unexpected result")
    expected_source_root = _expected_source_root(old_namespace)
    try:
        _expected_shape(response["source"], source_root=expected_source_root)
    except BuildControlError as error:
        raise BuildControlError("Control workspace helper returned an invalid source record") from error
    if expected is not None and response["source"] != expected:
        raise BuildControlError("Control workspace helper changed the pinned source record")
    expected_copied = publish and response["source"].get("present") is True
    if response["copied"] is not expected_copied:
        raise BuildControlError("Control workspace helper reported an impossible copy outcome")
    return response
