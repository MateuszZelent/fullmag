"""Issue a current mount-namespace grant for explicit orphan recovery.

The host builds a small, immutable context.  The guest script re-reads all
authoritative records with no-follow bounded reads, runs the image's existing
Windows-folder probe in its own namespace, and returns one typed proof.  It
does not start the runtime service or perform a ledger/API operation.
"""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from collections.abc import Mapping
from typing import Any


CONTEXT_SCHEMA = "fullmag.docker.orphan-namespace-grant-context.v1"
PROOF_SCHEMA = "fullmag.docker.orphan-namespace-grant-proof.v1"
REQUEST_SCHEMA = "host_worker_orphan_teardown_request.v1"
CONFIG_PATH = "/state/.fullmag/runtime-service/docker-all.json"
HOST_CERTIFICATE_PATH = "/run/fullmag/windows-folder-host.json"
GRANT_PATH = "/state/.fullmag-windows-folder-grant.json"
REQUEST_ROOT = "/state/diagnostics/orphan"
MAX_DOCUMENT_BYTES = 512 * 1024
MAX_PROOF_BYTES = 128 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
CONTAINER_RE = re.compile(r"^[0-9a-f]{12,64}$")
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
CHECKS = (
    "file_sync", "directory_sync", "atomic_replace", "atomic_directory_publish",
    "process_lock", "no_follow_symlink", "no_follow_junction",
    "sqlite_transactions", "restart_readback",
)
GRANT_KEYS = frozenset({
    "schema", "storage_profile", "role", "state", "container_root",
    "host_attestation_sha256", "owner_token", "root_device", "root_inode",
    "mount_namespace_inode", "power_loss", "checks",
})
CONTEXT_KEYS = frozenset({
    "schema", "request_id", "request_sha256", "context_sha256",
    "image_scope_sha256", "phase", "request_path", "config_path",
    "config_sha256", "owner_sha256", "host_certificate_path",
    "host_certificate_sha256", "grant_path", "image_id", "target_container_id",
})
PROOF_KEYS = frozenset({
    "schema", "status", "phase", "request_id", "request_sha256",
    "context_sha256", "image_scope_sha256", "image_id", "target_container_id",
    "old_grant_sha256", "old_grant_archive_path", "old_grant",
    "new_grant_sha256", "new_grant_canonical_sha256", "new_grant",
    "root_device", "root_inode", "mount_namespace_inode",
})


def _require(condition: object, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _sha_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha(value: Any, label: str) -> str:
    _require(isinstance(value, str) and SHA256_RE.fullmatch(value) is not None,
             f"{label} must be a lowercase SHA-256")
    _require(set(value) != {"0"}, f"{label} cannot be all zeroes")
    return value


def _uuid(value: Any, label: str) -> str:
    _require(isinstance(value, str) and UUID_RE.fullmatch(value) is not None,
             f"{label} must be a canonical nonzero UUID")
    _require(uuid.UUID(value).int != 0, f"{label} cannot be zero")
    return value


def _image(value: Any, label: str) -> str:
    _require(isinstance(value, str) and IMAGE_RE.fullmatch(value) is not None,
             f"{label} must be an immutable image ID")
    return value


def _container(value: Any, label: str) -> str:
    _require(isinstance(value, str) and CONTAINER_RE.fullmatch(value) is not None,
             f"{label} must be a full Docker container ID")
    return value


def _mapping(value: Any, label: str) -> dict[str, Any]:
    _require(isinstance(value, Mapping), f"{label} must be an object")
    return dict(value)


def _context_digest(context: Mapping[str, Any]) -> str:
    unsigned = dict(context)
    unsigned.pop("context_sha256", None)
    return _sha_bytes(_canonical(unsigned))


def _image_scope_digest(image_id: str, target_container_id: str) -> str:
    return _sha_bytes(_canonical({
        "image_id": image_id,
        "target_container_id": target_container_id,
    }))


def build_grant_context(
    request: Mapping[str, Any], phase: str, *, image_id: str, target_container_id: str
) -> dict[str, Any]:
    """Build the exact guest context from one already validated request.

    The request itself is passed by its canonical diagnostic path.  No host
    path or caller-provided owner path enters the context; the guest derives
    the owner path from ``config.store_root`` after reading the pinned config.
    """

    request = _mapping(request, "orphan request")
    _require(request.get("schema_version") == REQUEST_SCHEMA,
             "orphan request schema is unsupported")
    request_id = _uuid(request.get("request_id"), "request_id")
    _require(phase in {"prepare", "complete"}, "orphan grant phase is invalid")
    image_id = _image(image_id, "image_id")
    target_container_id = _container(target_container_id, "target_container_id")
    containers = request.get("containers")
    _require(isinstance(containers, list) and len(containers) == 1 and
             isinstance(containers[0], Mapping),
             "orphan request must bind exactly one backend container")
    binding = dict(containers[0])
    _require(binding.get("container_id") == target_container_id,
             "target container differs from the request")
    _require(binding.get("image_id") == image_id,
             "target image differs from the request")
    config_sha = _sha(request.get("config_sha256"), "request.config_sha256")
    owner_sha = _sha(request.get("owner_sha256"), "request.owner_sha256")
    host_sha = _sha(
        request.get("windows_folder_host_sha256"),
        "request.windows_folder_host_sha256",
    )
    context = {
        "schema": CONTEXT_SCHEMA,
        "request_id": request_id,
        "request_sha256": _sha_bytes(_canonical(request)),
        "phase": phase,
        "request_path": f"{REQUEST_ROOT}/{request_id}/request.json",
        "config_path": CONFIG_PATH,
        "config_sha256": config_sha,
        "owner_sha256": owner_sha,
        "host_certificate_path": HOST_CERTIFICATE_PATH,
        "host_certificate_sha256": host_sha,
        "grant_path": GRANT_PATH,
        "image_id": image_id,
        "target_container_id": target_container_id,
    }
    context["image_scope_sha256"] = _image_scope_digest(image_id, target_container_id)
    context["context_sha256"] = _context_digest(context)
    _require(set(context) == CONTEXT_KEYS, "grant context has an unexpected field")
    return context


def _validate_grant(grant: Mapping[str, Any], context: Mapping[str, Any]) -> dict[str, Any]:
    grant = _mapping(grant, "namespace grant")
    _require(set(grant) == GRANT_KEYS, "namespace grant fields are incomplete or unexpected")
    _require(grant.get("schema") == "fullmag.windows-folder-session.v1",
             "namespace grant schema is unsupported")
    _require(grant.get("storage_profile") == "windows-folder-v1" and
             grant.get("role") == "session" and grant.get("state") == "operational" and
             grant.get("container_root") == "/state" and
             grant.get("power_loss") == "NOT VERIFIED",
             "namespace grant has an invalid storage contract")
    _sha(grant.get("host_attestation_sha256"), "namespace grant host attestation")
    _require(grant["host_attestation_sha256"] == context["host_certificate_sha256"],
             "namespace grant is bound to a different host certificate")
    _require(isinstance(grant.get("owner_token"), str) and
             0 < len(grant["owner_token"]) <= 256,
             "namespace grant owner token is invalid")
    for field in ("root_device", "root_inode", "mount_namespace_inode"):
        _require(type(grant.get(field)) is int and grant[field] > 0,
                 f"namespace grant {field} is invalid")
    checks = grant.get("checks")
    _require(isinstance(checks, Mapping) and set(checks) == set(CHECKS) and
             all(value is True for value in checks.values()),
             "namespace grant storage checks are not all true")
    return grant


def validate_grant_receipt(proof: Mapping[str, Any], context: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the bounded one-line proof returned by the guest executor."""

    context = _mapping(context, "grant context")
    _require(set(context) == CONTEXT_KEYS and context.get("schema") == CONTEXT_SCHEMA,
             "grant context schema is unsupported")
    _require(context.get("context_sha256") == _context_digest(context),
             "grant context digest does not match its fields")
    _sha(context.get("request_sha256"), "context.request_sha256")
    _sha(context.get("config_sha256"), "context.config_sha256")
    _sha(context.get("owner_sha256"), "context.owner_sha256")
    _sha(context.get("host_certificate_sha256"), "context.host_certificate_sha256")
    _require(context.get("phase") in {"prepare", "complete"},
             "grant context phase is invalid")
    _require(context.get("config_path") == CONFIG_PATH and
             context.get("host_certificate_path") == HOST_CERTIFICATE_PATH and
             context.get("grant_path") == GRANT_PATH,
             "grant context uses a noncanonical fixed path")
    _require(context.get("request_path") ==
             f"{REQUEST_ROOT}/{context['request_id']}/request.json",
             "grant context request path is not canonical")
    _uuid(context.get("request_id"), "context.request_id")
    _image(context.get("image_id"), "context.image_id")
    _container(context.get("target_container_id"), "context.target_container_id")
    _require(context.get("image_scope_sha256") == _image_scope_digest(
        context["image_id"], context["target_container_id"]),
             "grant context image scope differs")

    proof = _mapping(proof, "namespace grant proof")
    _require(set(proof) == PROOF_KEYS, "namespace grant proof fields are incomplete or unexpected")
    _require(proof.get("schema") == PROOF_SCHEMA and proof.get("status") == "ready",
             "namespace grant proof is not ready")
    for field in ("phase", "request_id", "request_sha256", "context_sha256",
                  "image_scope_sha256", "image_id", "target_container_id"):
        _require(proof.get(field) == context.get(field),
                 f"namespace grant proof differs in {field}")
    _sha(proof.get("old_grant_sha256"), "proof.old_grant_sha256")
    _sha(proof.get("new_grant_sha256"), "proof.new_grant_sha256")
    # Namespace inode values can be reused after a container exits. A fresh
    # trusted probe may therefore publish identical bytes; its current-root
    # and current-namespace checks, not digest inequality, prove admission.
    old_archive = (
        f"{REQUEST_ROOT}/{context['request_id']}/namespace-grant-"
        f"{context['phase']}-old-{proof['old_grant_sha256']}.json"
    )
    _require(proof.get("old_grant_archive_path") == old_archive,
             "namespace grant archive path is not canonical")
    _validate_grant(proof.get("old_grant"), context)
    grant = _validate_grant(proof.get("new_grant"), context)
    _require(proof.get("new_grant_canonical_sha256") == _sha_bytes(_canonical(grant)),
             "namespace grant canonical digest differs")
    for field in ("root_device", "root_inode", "mount_namespace_inode"):
        _require(proof.get(field) == grant.get(field),
                 f"namespace proof {field} differs from the grant")
    encoded = _canonical(proof)
    _require(len(encoded) <= MAX_PROOF_BYTES, "namespace grant proof is oversized")
    return proof


GUEST_NAMESPACE_GRANT_SCRIPT = r'''
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

_CONTEXT_SCHEMA = "fullmag.docker.orphan-namespace-grant-context.v1"
_PROOF_SCHEMA = "fullmag.docker.orphan-namespace-grant-proof.v1"
_REQUEST_SCHEMA = "host_worker_orphan_teardown_request.v1"
_CONFIG_PATH = "/state/.fullmag/runtime-service/docker-all.json"
_HOST_CERTIFICATE_PATH = "/run/fullmag/windows-folder-host.json"
_GRANT_PATH = "/state/.fullmag-windows-folder-grant.json"
_REQUEST_ROOT = "/state/diagnostics/orphan"
_MAX_BYTES = 512 * 1024
_CHECKS = ("file_sync", "directory_sync", "atomic_replace", "atomic_directory_publish",
           "process_lock", "no_follow_symlink", "no_follow_junction",
           "sqlite_transactions", "restart_readback")
_GRANT_KEYS = frozenset(("schema", "storage_profile", "role", "state", "container_root",
                         "host_attestation_sha256", "owner_token", "root_device",
                         "root_inode", "mount_namespace_inode", "power_loss", "checks"))
_CONTEXT_KEYS = frozenset(("schema", "request_id", "request_sha256", "context_sha256",
                           "image_scope_sha256", "phase", "request_path", "config_path",
                           "config_sha256", "owner_sha256", "host_certificate_path",
                           "host_certificate_sha256", "grant_path", "image_id",
                           "target_container_id"))


def _fail(message):
    raise RuntimeError(message)


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail("duplicate JSON object key")
        result[key] = value
    return result


def _json(raw, name):
    if len(raw) > _MAX_BYTES:
        _fail(name + " is oversized")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError, RuntimeError) as error:
        _fail(name + " is not valid JSON: " + str(error))
    if not isinstance(value, dict):
        _fail(name + " must be an object")
    return value


def _component(value):
    if not isinstance(value, str) or not value or value in (".", "..") or "/" in value:
        _fail("invalid path component")
    return value


def _map_path(value, fs_root):
    path = Path(value)
    if fs_root is None:
        return path
    root = Path(fs_root)
    if path == Path("/state"):
        return root
    if path.parts[:2] == ("/", "state"):
        return root.joinpath(*path.parts[2:])
    if path.parts[:2] == ("/", "run"):
        return root.joinpath(*path.parts[1:])
    _fail("test path mapping escaped the fixed guest roots")


def _open_directory(path):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    if not path.is_absolute() or any(part in ("", ".", "..") for part in path.parts[1:]):
        _fail("guest directory is not an absolute no-follow path")
    descriptor = os.open("/", flags)
    try:
        for part in path.parts[1:]:
            child = os.open(_component(part), flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _read_regular(path, name):
    parent = _open_directory(path.parent)
    descriptor = None
    try:
        descriptor = os.open(_component(path.name),
                             os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0),
                             dir_fd=parent)
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size <= 0 or metadata.st_size > _MAX_BYTES:
            _fail(name + " is not a bounded regular file")
        chunks = []
        remaining = _MAX_BYTES + 1
        while remaining:
            block = os.read(descriptor, min(65536, remaining))
            if not block:
                break
            chunks.append(block)
            remaining -= len(block)
        raw = b"".join(chunks)
        if len(raw) > _MAX_BYTES:
            _fail(name + " is oversized")
        return raw
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)


def _archive_immutable(path, raw):
    """Create/read back one immutable old-grant archive under pinned parents."""
    parent = _open_directory(path.parent)
    descriptor = None
    try:
        try:
            descriptor = os.open(_component(path.name),
                                 os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0),
                                 dir_fd=parent)
        except FileNotFoundError:
            descriptor = os.open(_component(path.name),
                                 os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW |
                                 getattr(os, "O_CLOEXEC", 0), 0o600, dir_fd=parent)
            view = memoryview(raw)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    _fail("short write while archiving the old namespace grant")
                view = view[written:]
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = None
            os.fsync(parent)
            return
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != len(raw):
            _fail("old namespace grant archive is not the exact regular file")
        chunks = []
        remaining = len(raw)
        while remaining:
            block = os.read(descriptor, remaining)
            if not block:
                break
            chunks.append(block)
            remaining -= len(block)
        if b"".join(chunks) != raw:
            _fail("old namespace grant archive differs from the pinned grant")
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)


def _validate_context(context):
    if not isinstance(context, dict) or set(context) != _CONTEXT_KEYS:
        _fail("grant context fields are incomplete or unexpected")
    if context.get("schema") != _CONTEXT_SCHEMA or context.get("phase") not in ("prepare", "complete"):
        _fail("grant context schema or phase is invalid")
    request_id = context.get("request_id")
    try:
        if not isinstance(request_id, str) or str(uuid.UUID(request_id)) != request_id or uuid.UUID(request_id).int == 0:
            raise ValueError
    except ValueError:
        _fail("grant context request ID is invalid")
    for field in ("request_sha256", "context_sha256", "image_scope_sha256", "config_sha256",
                  "owner_sha256", "host_certificate_sha256"):
        value = context.get(field)
        if not isinstance(value, str) or len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
            _fail("grant context has an invalid " + field)
    image = context.get("image_id")
    target = context.get("target_container_id")
    if not isinstance(image, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        _fail("grant context image is invalid")
    if not isinstance(target, str) or not re.fullmatch(r"[0-9a-f]{12,64}", target):
        _fail("grant context target container is invalid")
    if context.get("config_path") != _CONFIG_PATH or context.get("host_certificate_path") != _HOST_CERTIFICATE_PATH or context.get("grant_path") != _GRANT_PATH:
        _fail("grant context uses a noncanonical fixed path")
    expected_request = _REQUEST_ROOT + "/" + request_id + "/request.json"
    if context.get("request_path") != expected_request:
        _fail("grant context request path is not canonical")
    unsigned = dict(context)
    unsigned.pop("context_sha256")
    if _sha(_canonical(unsigned)) != context["context_sha256"]:
        _fail("grant context digest does not match its fields")
    expected_scope = _sha(_canonical({"image_id": image, "target_container_id": target}))
    if context["image_scope_sha256"] != expected_scope:
        _fail("grant context image scope does not match its fields")
    return context


def _validate_grant(grant, context):
    if not isinstance(grant, dict) or set(grant) != _GRANT_KEYS:
        _fail("namespace grant fields are incomplete or unexpected")
    if (grant.get("schema") != "fullmag.windows-folder-session.v1" or
            grant.get("storage_profile") != "windows-folder-v1" or
            grant.get("role") != "session" or grant.get("state") != "operational" or
            grant.get("container_root") != "/state" or grant.get("power_loss") != "NOT VERIFIED"):
        _fail("namespace grant storage contract is invalid")
    if grant.get("host_attestation_sha256") != context["host_certificate_sha256"]:
        _fail("namespace grant uses a different host certificate")
    if not isinstance(grant.get("owner_token"), str) or not grant["owner_token"]:
        _fail("namespace grant owner token is invalid")
    for field in ("root_device", "root_inode", "mount_namespace_inode"):
        if type(grant.get(field)) is not int or grant[field] <= 0:
            _fail("namespace grant identity is invalid")
    checks = grant.get("checks")
    if not isinstance(checks, dict) or set(checks) != set(_CHECKS) or not all(value is True for value in checks.values()):
        _fail("namespace grant checks are not all true")
    return grant


def _issue_recovery_namespace_grant(context, *, _fs_root=None, _probe=None):
    """Validate failed-owner evidence, rotate the current namespace grant, and return proof.

    ``_fs_root`` and ``_probe`` are private interpreted-test seams; the real
    inline executor calls the function with its defaults and fixed container
    paths.  They never enter the JSON context.
    """
    context = _validate_context(context)
    image = context["image_id"]
    if os.environ.get("FULLMAG_RUNTIME_IMAGE_ID") != image:
        _fail("runtime image environment differs from the pinned image scope")
    state_root = _map_path("/state", _fs_root)
    request_path = _map_path(context["request_path"], _fs_root)
    config_path = _map_path(context["config_path"], _fs_root)
    host_path = _map_path(context["host_certificate_path"], _fs_root)
    grant_path = _map_path(context["grant_path"], _fs_root)

    request_raw = _read_regular(request_path, "orphan request")
    config_raw = _read_regular(config_path, "runtime config")
    host_raw = _read_regular(host_path, "Windows host certificate")
    old_grant_raw = _read_regular(grant_path, "previous namespace grant")
    if _sha(request_raw) != context["request_sha256"]:
        _fail("orphan request bytes differ from the host context")
    if _sha(config_raw) != context["config_sha256"]:
        _fail("runtime config bytes differ from the host context")
    if _sha(host_raw) != context["host_certificate_sha256"]:
        _fail("Windows host certificate bytes differ from the host context")
    request = _json(request_raw, "orphan request")
    config = _json(config_raw, "runtime config")
    host = _json(host_raw, "Windows host certificate")
    old_grant = _json(old_grant_raw, "previous namespace grant")
    if request.get("schema_version") != _REQUEST_SCHEMA or request.get("request_id") != context["request_id"]:
        _fail("orphan request identity differs from the host context")
    if request.get("config_sha256") != context["config_sha256"] or request.get("owner_sha256") != context["owner_sha256"] or request.get("windows_folder_host_sha256") != context["host_certificate_sha256"]:
        _fail("orphan request pins differ from the host context")
    containers = request.get("containers")
    if not isinstance(containers, list) or len(containers) != 1 or not isinstance(containers[0], dict):
        _fail("orphan request has no exact backend container")
    binding = containers[0]
    if binding.get("container_id") != context["target_container_id"] or binding.get("image_id") != image:
        _fail("orphan request image scope differs from the host context")
    expected = request.get("expected")
    if not isinstance(expected, dict) or expected.get("reservation_state") not in ("committed", "quarantined") or expected.get("local_lease_state") != "active" or expected.get("started_receipt_absent") is not True or expected.get("worker_exit_receipt_absent") is not True or expected.get("task_outcome") != "unknown" or expected.get("solve_replay") is not False:
        _fail("orphan request does not prove the unknown-outcome boundary")
    gate = request.get("worker_launch_gate")
    if not isinstance(gate, dict) or gate.get("state") != "consumed":
        _fail("orphan request has no consumed launch gate")
    if config.get("schema_version") not in ("runtime_service_config.v1", "runtime_service_config.v2"):
        _fail("runtime config schema is unsupported")
    store_root = config.get("store_root")
    if not isinstance(store_root, str) or not store_root.startswith("/state/") or any(part in ("", ".", "..") for part in store_root.split("/")[1:]):
        _fail("runtime config store_root is not a fixed /state path")
    owner_path = _map_path(store_root + "/runtime-services/OWNER.json", _fs_root)
    owner_raw = _read_regular(owner_path, "runtime service owner")
    if _sha(owner_raw) != context["owner_sha256"]:
        _fail("runtime service owner bytes differ from the host context")
    owner = _json(owner_raw, "runtime service owner")
    if (owner.get("schema_version") != "runtime_service_owner.v1" or
            owner.get("protocol") != "stdin-v1" or
            owner.get("state") != "failed" or
            owner.get("target_id") != config.get("target_id")):
        _fail("runtime service owner is not the exact Failed owner")
    children = owner.get("children")
    child_pids = [child.get("pid") for child in children] if isinstance(children, list) else []
    if (not isinstance(children, list) or len(children) != 2 or
            {child.get("role") for child in children if isinstance(child, dict)} != {"compute", "preparation"} or
            any(not isinstance(child, dict) or child.get("status") not in ("exited_success", "exited_failure") or
                type(child.get("pid")) is not int or child["pid"] <= 0 for child in children) or
            len(set(child_pids)) != 2):
        _fail("runtime service owner does not prove two terminal children")
    if (host.get("image_id") != image or
            host.get("schema") != "fullmag.windows-folder-host.v1" or
            host.get("storage_profile") != "windows-folder-v1" or
            host.get("role") != "session" or
            host.get("owner_scope") != "docker-desktop-linux" or
            host.get("restart_verified") is not True):
        _fail("Windows host certificate is outside the exact image scope")
    _validate_grant(old_grant, context)
    old_grant_sha = _sha(old_grant_raw)
    old_archive_guest_path = (
        _REQUEST_ROOT + "/" + context["request_id"] + "/namespace-grant-" +
        context["phase"] + "-old-" + old_grant_sha + ".json"
    )
    _archive_immutable(
        _map_path(old_archive_guest_path, _fs_root), old_grant_raw)
    if _probe is None:
        if "/opt/fullmag" not in sys.path:
            sys.path.insert(0, "/opt/fullmag")
        import windows_folder_probe as _probe
    new_grant = _probe.run(require_restart=True)

    # A probe is bounded but the owner/config/certificate records can still
    # be replaced while it runs.  Re-read the same no-follow bytes before
    # accepting the newly published grant.
    if (_read_regular(request_path, "orphan request") != request_raw or
            _read_regular(config_path, "runtime config") != config_raw or
            _read_regular(host_path, "Windows host certificate") != host_raw or
            _read_regular(owner_path, "runtime service owner") != owner_raw):
        _fail("pinned orphan evidence changed during namespace probing")
    new_grant_raw = _read_regular(grant_path, "new namespace grant")
    persisted_grant = _json(new_grant_raw, "new namespace grant")
    if not isinstance(new_grant, dict) or persisted_grant != new_grant:
        _fail("namespace probe result differs from its persisted grant")
    _validate_grant(persisted_grant, context)
    if persisted_grant.get("owner_token") != host.get("owner_token"):
        _fail("namespace grant owner token differs from the host certificate")
    state_descriptor = _open_directory(state_root)
    try:
        state_identity = os.fstat(state_descriptor)
    finally:
        os.close(state_descriptor)
    # Match windows_folder_probe.run and the Rust admission check: the
    # namespace symlink is resolved to the target namespace inode.
    namespace_inode = os.stat("/proc/self/ns/mnt").st_ino
    if (persisted_grant.get("root_device") != state_identity.st_dev or
            persisted_grant.get("root_inode") != state_identity.st_ino or
            persisted_grant.get("mount_namespace_inode") != namespace_inode):
        _fail("namespace probe did not publish the current root and mount namespace")
    proof = {
        "schema": _PROOF_SCHEMA,
        "status": "ready",
        "phase": context["phase"],
        "request_id": context["request_id"],
        "request_sha256": context["request_sha256"],
        "context_sha256": context["context_sha256"],
        "image_scope_sha256": context["image_scope_sha256"],
        "image_id": image,
        "target_container_id": context["target_container_id"],
        "old_grant_sha256": old_grant_sha,
        "old_grant_archive_path": old_archive_guest_path,
        "old_grant": old_grant,
        "new_grant_sha256": _sha(new_grant_raw),
        "new_grant_canonical_sha256": _sha(_canonical(persisted_grant)),
        "new_grant": persisted_grant,
        "root_device": persisted_grant["root_device"],
        "root_inode": persisted_grant["root_inode"],
        "mount_namespace_inode": persisted_grant["mount_namespace_inode"],
    }
    if len(_canonical(proof)) > 128 * 1024:
        _fail("namespace proof is oversized")
    return proof
'''


__all__ = [
    "CONFIG_PATH", "CONTEXT_SCHEMA", "GUEST_NAMESPACE_GRANT_SCRIPT",
    "GRANT_PATH", "HOST_CERTIFICATE_PATH", "PROOF_SCHEMA",
    "build_grant_context", "validate_grant_receipt",
]
