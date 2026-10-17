"""Bounded host authorization for explicit Docker runtime recovery.

The native runtime owns the session-store mutation.  This module only binds a
single stopped Docker run, its immutable evidence, and one read-only native
request.  There is deliberately no implicit recovery or owner takeover here.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid
from typing import Any, Mapping


AUTH_SCHEMA = "fullmag.docker-runtime-recovery-authorization.v1"
NATIVE_REQUEST_SCHEMA = "runtime_service_recovery_request.v1"
MAX_JSON_BYTES = 512 * 1024
MAX_OWNER_BYTES = 256 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
CONTAINER_ID_RE = re.compile(r"^[0-9a-f]{12,64}$")
RUN_ID_RE = re.compile(r"^[0-9a-f]{32}$")
FILESYSTEM_UUID_RE = re.compile(
    r"^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$"
)
NATIVE_PATH_RE = re.compile(r"^/state/(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+$")


class RecoveryAuthorizationError(ValueError):
    """A recovery authorization is malformed, stale, or not owned."""


def _fail(message: str) -> None:
    raise RecoveryAuthorizationError(message)


def _digest_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _canonical_json(value: Mapping[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=True, sort_keys=True,
                       separators=(",", ":")) + "\n").encode("utf-8")


def _regular_bytes(path: Path, label: str, maximum: int = MAX_JSON_BYTES) -> bytes:
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        _fail(f"{label} is not a regular file")
    try:
        metadata = path.stat()
        if metadata.st_size <= 0 or metadata.st_size > maximum:
            _fail(f"{label} exceeds its bounded size")
        raw = path.read_bytes()
    except OSError as error:
        _fail(f"cannot read {label}: {error}")
    if len(raw) != metadata.st_size or len(raw) > maximum:
        _fail(f"{label} changed while it was read")
    return raw


def _json(path: Path, label: str, maximum: int = MAX_JSON_BYTES) -> tuple[dict[str, Any], bytes]:
    raw = _regular_bytes(path, label, maximum)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"{label} is not valid JSON: {error}")
    if not isinstance(value, dict):
        _fail(f"{label} must contain an object")
    return value, raw


def _digest_file(path: Path, label: str, maximum: int = MAX_JSON_BYTES) -> str:
    return _digest_bytes(_regular_bytes(path, label, maximum))


def _hex(value: Any, label: str) -> str:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        _fail(f"{label} must be a lowercase SHA-256")
    return value


def _uuid(value: Any, label: str) -> str:
    if not isinstance(value, str):
        _fail(f"{label} must be a UUID")
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError) as error:
        _fail(f"{label} must be a canonical UUID")
    if parsed.int == 0 or str(parsed) != value:
        _fail(f"{label} must be a canonical nonzero UUID")
    return value


def _contained(path: Path, root: Path, label: str) -> Path:
    path = Path(path)
    root = Path(root).resolve()
    try:
        resolved = path.resolve(strict=False)
        resolved.relative_to(root)
    except (OSError, ValueError) as error:
        _fail(f"{label} escapes the owned run root")
    if path.is_symlink():
        _fail(f"{label} is a symlink")
    return path


def _safe_relative_text(value: Any, label: str) -> Path:
    """Validate a run-owned POSIX relative path carried in a receipt."""
    if not isinstance(value, str) or not value or "\\" in value:
        _fail(f"{label} must be a normalized relative path")
    candidate = Path(value)
    if candidate.is_absolute() or any(part in {"", ".", ".."} for part in candidate.parts):
        _fail(f"{label} must be a normalized relative path")
    if candidate.as_posix() != value:
        _fail(f"{label} must be a normalized relative path")
    return candidate


def _relative_owned_path(path: Path, root: Path, label: str) -> str:
    path = _contained(Path(path), Path(root), label)
    try:
        relative = path.resolve(strict=False).relative_to(Path(root).resolve())
    except (OSError, ValueError) as error:
        _fail(f"{label} escapes the owned run root: {error}")
    return _safe_relative_text(relative.as_posix(), label).as_posix()


def _filesystem_uuid(value: Mapping[str, Any], label: str) -> str:
    host_receipt = value.get("host_receipt")
    if not isinstance(host_receipt, Mapping):
        _fail(f"{label} has no host-ledger filesystem receipt")
    filesystem_uuid = host_receipt.get("filesystem_uuid")
    if not isinstance(filesystem_uuid, str) or FILESYSTEM_UUID_RE.fullmatch(filesystem_uuid) is None:
        _fail(f"{label} has an invalid host-ledger filesystem UUID")
    return filesystem_uuid.lower()


def mount_attestation_path_for_receipt(
    run_root: Path, run_receipt: Mapping[str, Any]
) -> Path:
    """Resolve the host-ledger receipt path declared by the pinned run receipt."""
    host_ledger = run_receipt.get("host_ledger")
    if not isinstance(host_ledger, Mapping):
        _fail("pinned run receipt has no host-ledger binding")
    value = host_ledger.get("receipt")
    if not isinstance(value, str) or not Path(value).is_absolute():
        _fail("pinned run receipt has no absolute host-ledger receipt path")
    return _contained(Path(value), Path(run_root), "host-ledger receipt")


def _native_path(value: Any, label: str) -> str:
    if not isinstance(value, str) or NATIVE_PATH_RE.fullmatch(value) is None:
        _fail(f"{label} must be an absolute /state path without traversal")
    return value


def _write_readonly_json(path: Path, value: Mapping[str, Any], label: str) -> bytes:
    path = Path(path)
    if path.exists() or path.is_symlink():
        _fail(f"{label} already exists")
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = _canonical_json(value)
    if len(raw) > MAX_JSON_BYTES:
        _fail(f"{label} exceeds its bounded size")
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o440)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = -1
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        try:
            path.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
        except OSError:
            # The Windows bind may not expose POSIX mode bits.  The caller
            # still mounts the authorization read-only and rechecks its hash.
            pass
        return raw
    finally:
        if descriptor != -1:
            os.close(descriptor)
        if temporary.exists():
            temporary.unlink()


def _validate_expected_owner(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail("native recovery request expected_owner must be an object")
    required = {
        "owner_token", "process_start_token", "pid", "host", "state", "target_id",
        "control_address", "build_commit", "build_snapshot", "compute_pool_id",
        "preparation_pool_id", "compute_pool_generation", "preparation_pool_generation",
        "children",
    }
    if not required.issubset(value):
        _fail("native recovery request expected_owner is incomplete")
    return value


def prepare_authorization(
    *,
    run_receipt_path: Path,
    state_root: Path,
    config_path: Path,
    owner_path: Path,
    launch_path: Path,
    host_certificate_path: Path,
    mount_attestation_path: Path,
    evidence_root: Path,
    output_path: Path,
    run_receipt: Mapping[str, Any],
    container_ids: Mapping[str, str],
    image_ids: Mapping[str, str],
    native_config_path: str = "/state/.fullmag/runtime-service/docker-all.json",
) -> dict[str, Any]:
    """Create one request and host authorization before lifecycle mutation."""

    if not isinstance(run_receipt, Mapping):
        _fail("pinned run receipt is not an object")
    if run_receipt.get("state") != "failed_resources_retained":
        _fail("recovery authorization requires a failed retained run")
    run_root = Path(run_receipt_path).resolve().parent
    run_id = run_root.name
    if RUN_ID_RE.fullmatch(run_id) is None:
        _fail("run receipt is not in an owned docker-all run directory")
    _contained(Path(run_receipt_path), run_root, "run receipt")
    receipt_sha = _digest_file(Path(run_receipt_path), "run receipt", 16 * 1024 * 1024)
    state_root = _contained(Path(state_root), run_root, "state root")
    config_path = _contained(Path(config_path), state_root, "runtime configuration")
    owner_path = _contained(Path(owner_path), state_root, "runtime owner")
    launch_path = _contained(Path(launch_path), state_root, "runtime launch record")
    host_certificate_path = _contained(Path(host_certificate_path), run_root, "host certificate")
    mount_attestation_path = _contained(Path(mount_attestation_path), run_root, "mount attestation")
    receipt_mount_path = mount_attestation_path_for_receipt(run_root, run_receipt)
    if receipt_mount_path.resolve() != mount_attestation_path.resolve():
        _fail("mount attestation does not match the pinned run receipt")
    mount_attestation_relative_path = _relative_owned_path(
        receipt_mount_path, run_root, "mount attestation"
    )
    evidence_root = _contained(Path(evidence_root), run_root, "recovery evidence")
    output_path = _contained(Path(output_path), run_root, "recovery authorization")
    evidence_manifest = evidence_root / "manifest.json"
    if not evidence_root.is_dir() or evidence_root.is_symlink():
        _fail("recovery evidence root is not a real directory")
    evidence_manifest_sha = _digest_file(evidence_manifest, "recovery evidence manifest")

    owner, owner_raw = _json(owner_path, "runtime owner", MAX_OWNER_BYTES)
    _validate_expected_owner(owner)
    config_sha = _digest_file(config_path, "runtime configuration", MAX_JSON_BYTES)
    launch_sha = _digest_file(launch_path, "runtime launch record", MAX_JSON_BYTES)
    host_certificate_sha = _digest_file(host_certificate_path, "host certificate", MAX_JSON_BYTES)
    mount_attestation_sha = _digest_file(mount_attestation_path, "mount attestation", MAX_JSON_BYTES)
    request_id = str(uuid.uuid4())
    native_request_path = state_root / ".fullmag" / "runtime-service" / "recovery" / f"{request_id}.json"
    native_request_path = _contained(native_request_path, state_root, "native recovery request")
    native_request_guest_path = "/state/.fullmag/runtime-service/recovery/" + f"{request_id}.json"
    native_request = {
        "schema_version": NATIVE_REQUEST_SCHEMA,
        "request_id": request_id,
        "config_sha256": config_sha,
        "owner_sha256": _digest_bytes(owner_raw),
        "launch_sha256": launch_sha,
        "expected_owner": owner,
    }
    native_raw = _write_readonly_json(native_request_path, native_request, "native recovery request")
    native_request_sha = _digest_bytes(native_raw)
    if set(container_ids) != {"backend", "frontend"}:
        _fail("recovery authorization requires backend and frontend container IDs")
    if set(image_ids) != {"backend", "frontend"}:
        _fail("recovery authorization requires backend and frontend image IDs")
    for label, value in (*container_ids.items(),):
        if not isinstance(value, str) or CONTAINER_ID_RE.fullmatch(value) is None:
            _fail(f"{label} container ID is invalid")
    for label, value in (*image_ids.items(),):
        if not isinstance(value, str) or IMAGE_ID_RE.fullmatch(value) is None:
            _fail(f"{label} image ID is invalid")
    retained = run_receipt.get("retained_container_ids")
    if (not isinstance(retained, list) or len(retained) != 2
            or len(set(retained)) != 2
            or set(retained) != set(container_ids.values())):
        _fail("failed retained run does not have an exact two-service container pin")
    receipt_container_ids = {
        "backend": run_receipt.get("container_id"),
        "frontend": run_receipt.get("frontend_container_id"),
    }
    if any(value is None for value in receipt_container_ids.values()) \
            and not all(value is None for value in receipt_container_ids.values()):
        _fail("failed retained run has only a partial service container declaration")
    if all(isinstance(value, str) for value in receipt_container_ids.values()) \
            and set(receipt_container_ids.values()) != set(retained):
        _fail("failed retained run service IDs disagree with its retained container set")
    authorization = {
        "schema_version": AUTH_SCHEMA,
        "request_id": request_id,
        "run_id": run_id,
        "run_receipt_path": str(Path(run_receipt_path).resolve()),
        "run_receipt_sha256": receipt_sha,
        "config_path": native_config_path,
        "config_sha256": config_sha,
        "owner_sha256": _digest_bytes(owner_raw),
        "launch_sha256": launch_sha,
        "native_request_path": native_request_guest_path,
        "native_request_host_path": str(native_request_path.resolve()),
        "native_request_sha256": native_request_sha,
        "container_ids": dict(container_ids),
        "image_ids": dict(image_ids),
        "host_certificate_path": str(host_certificate_path.resolve()),
        "host_certificate_sha256": host_certificate_sha,
        "mount_attestation_path": str(mount_attestation_path.resolve()),
        "mount_attestation_relative_path": mount_attestation_relative_path,
        "mount_attestation_sha256": mount_attestation_sha,
        "evidence_root": str(evidence_root.resolve()),
        "evidence_manifest_sha256": evidence_manifest_sha,
    }
    auth_raw = _write_readonly_json(output_path, authorization, "recovery authorization")
    authorization["authorization_sha256"] = _digest_bytes(auth_raw)
    return authorization


def validate_authorization(
    path: Path,
    *,
    run_receipt_path: Path,
    run_receipt: Mapping[str, Any],
    state_root: Path,
    config_path: Path,
    host_certificate_path: Path,
    mount_attestation_path: Path,
) -> dict[str, Any]:
    """Validate a supplied authorization without mutating any runtime state."""

    if not isinstance(run_receipt, Mapping):
        _fail("pinned run receipt is not an object")
    if run_receipt.get("state") != "failed_resources_retained":
        _fail("recovery authorization requires a failed retained run")
    path = Path(path)
    run_root = Path(run_receipt_path).resolve().parent
    _contained(path, run_root, "recovery authorization")
    auth, auth_raw = _json(path, "recovery authorization")
    if auth.get("schema_version") != AUTH_SCHEMA:
        _fail("unsupported recovery authorization schema")
    request_id = _uuid(auth.get("request_id"), "recovery request_id")
    if auth.get("run_id") != run_root.name:
        _fail("recovery authorization run_id differs from the pinned run")
    receipt_sha = _digest_file(Path(run_receipt_path), "run receipt", 16 * 1024 * 1024)
    if auth.get("run_receipt_sha256") != receipt_sha:
        _fail("recovery authorization run receipt changed")
    if not isinstance(auth.get("run_receipt_path"), str) or Path(auth["run_receipt_path"]).resolve() != Path(run_receipt_path).resolve():
        _fail("recovery authorization run receipt path differs")
    state_root = _contained(Path(state_root), run_root, "state root")
    config_path = _contained(Path(config_path), state_root, "runtime configuration")
    if auth.get("config_path") != "/state/.fullmag/runtime-service/docker-all.json":
        _fail("recovery authorization config path is not canonical")
    if auth.get("config_sha256") != _digest_file(config_path, "runtime configuration", MAX_JSON_BYTES):
        _fail("recovery authorization configuration changed")
    _hex(auth.get("owner_sha256"), "owner_sha256")
    _hex(auth.get("launch_sha256"), "launch_sha256")
    _native_path(auth.get("native_request_path"), "native_request_path")
    request_host = Path(auth.get("native_request_host_path", ""))
    _contained(request_host, state_root, "native recovery request")
    request, request_raw = _json(request_host, "native recovery request", MAX_JSON_BYTES)
    if request.get("schema_version") != NATIVE_REQUEST_SCHEMA or request.get("request_id") != request_id:
        _fail("native recovery request identity differs from authorization")
    request_sha = _digest_bytes(request_raw)
    if auth.get("native_request_sha256") != request_sha:
        _fail("native recovery request changed")
    if request.get("config_sha256") != auth.get("config_sha256") or request.get("owner_sha256") != auth.get("owner_sha256") or request.get("launch_sha256") != auth.get("launch_sha256"):
        _fail("native recovery request pins differ from authorization")
    _validate_expected_owner(request.get("expected_owner"))
    owner_path = state_root / "runs" / "docker-all" / "session-store" / "runtime-services" / "OWNER.json"
    launch_path = state_root / "runs" / "docker-all" / "session-store" / "runtime-services" / "LAUNCH.json"
    if _digest_file(owner_path, "runtime owner", MAX_OWNER_BYTES) != auth.get("owner_sha256"):
        _fail("runtime owner changed since recovery authorization")
    if _digest_file(launch_path, "runtime launch record", MAX_JSON_BYTES) != auth.get("launch_sha256"):
        _fail("runtime launch record changed since recovery authorization")
    receipt_mount_path = mount_attestation_path_for_receipt(run_root, run_receipt)
    supplied_mount_path = _contained(Path(mount_attestation_path), run_root, "mount attestation")
    if supplied_mount_path.resolve() != receipt_mount_path.resolve():
        _fail("mount attestation does not match the pinned run receipt")
    mount_attestation_relative_path = _relative_owned_path(
        receipt_mount_path, run_root, "mount attestation"
    )
    if auth.get("mount_attestation_relative_path") != mount_attestation_relative_path:
        _fail("recovery authorization mount attestation path differs")
    for field, expected in (("host_certificate_path", host_certificate_path),
                            ("mount_attestation_path", supplied_mount_path)):
        value = auth.get(field)
        if not isinstance(value, str) or Path(value).resolve() != Path(expected).resolve():
            _fail(f"recovery authorization {field} differs")
    if auth.get("host_certificate_sha256") != _digest_file(host_certificate_path, "host certificate", MAX_JSON_BYTES):
        _fail("host certificate changed since recovery authorization")
    if auth.get("mount_attestation_sha256") != _digest_file(mount_attestation_path, "mount attestation", MAX_JSON_BYTES):
        _fail("mount attestation changed since recovery authorization")
    evidence_root = Path(auth.get("evidence_root", ""))
    _contained(evidence_root, run_root, "recovery evidence")
    evidence_manifest = evidence_root / "manifest.json"
    if auth.get("evidence_manifest_sha256") != _digest_file(evidence_manifest, "recovery evidence manifest"):
        _fail("recovery evidence changed since authorization")
    expected_containers = {"backend": run_receipt.get("container_id"),
                           "frontend": run_receipt.get("frontend_container_id")}
    expected_images = {"backend": run_receipt.get("image_id"),
                       "frontend": run_receipt.get("frontend_image_id")
                       or run_receipt.get("image_id")}
    authorized_containers = auth.get("container_ids")
    if not isinstance(authorized_containers, dict) or set(authorized_containers) != {"backend", "frontend"}:
        _fail("recovery authorization has no complete service container pins")
    retained = run_receipt.get("retained_container_ids")
    if run_receipt.get("state") == "failed_resources_retained":
        if (not isinstance(retained, list) or len(retained) != 2
                or len(set(retained)) != 2
                or set(retained) != set(authorized_containers.values())):
            _fail("failed retained run does not have an exact two-service container pin")
        if any(value is None for value in expected_containers.values()) \
                and not all(value is None for value in expected_containers.values()):
            _fail("failed retained run has only a partial service container declaration")
        if all(isinstance(value, str) for value in expected_containers.values()) and \
                set(expected_containers.values()) != set(retained):
            _fail("failed retained run service IDs disagree with its retained container set")
    elif authorized_containers != expected_containers:
        _fail("recovery authorization container pins differ from the run receipt")
    if auth.get("image_ids") != expected_images:
        _fail("recovery authorization container/image pins differ from the run receipt")
    # A supplied authorization is immutable host evidence.  The bytes are
    # re-read immediately before Compose overlay publication by the caller.
    return {"authorization": auth, "authorization_sha256": _digest_bytes(auth_raw),
            "request": request, "request_sha256": request_sha,
            "path": path.resolve(), "request_host_path": request_host.resolve(),
            "evidence_root": evidence_root.resolve(), "request_id": request_id}


def validate_preserved_evidence(recovery_info: Mapping[str, Any], history_root: Path) -> dict[str, str]:
    """Prove the old certificate and mount evidence survived before rotation."""

    authorization = recovery_info.get("authorization")
    if not isinstance(authorization, Mapping):
        _fail("recovery validation has no authorization object")
    history_root = Path(history_root)
    if history_root.is_symlink() or not history_root.is_dir():
        _fail("recovery history root is not an owned directory")
    manifest_path = history_root / "manifest.json"
    manifest, _ = _json(manifest_path, "recovery history manifest")
    files = manifest.get("files")
    if not isinstance(files, list):
        _fail("recovery history manifest has no file inventory")
    manifest_digests: dict[str, str] = {}
    for item in files:
        if not isinstance(item, dict) or not isinstance(item.get("relative"), str):
            _fail("recovery history manifest contains an invalid file entry")
        relative = item["relative"]
        if relative in manifest_digests:
            _fail("recovery history manifest contains duplicate files")
        manifest_digests[relative] = item.get("sha256", "")
    mount_relative = _safe_relative_text(
        authorization.get("mount_attestation_relative_path"),
        "authorized mount attestation path",
    )
    if mount_relative.as_posix() == "windows-folder-host.json":
        _fail("authorized mount attestation path overlaps the host certificate")
    expected = {
        "windows-folder-host.json": authorization.get("host_certificate_sha256"),
        mount_relative.as_posix(): authorization.get("mount_attestation_sha256"),
    }
    observed: dict[str, str] = {}
    for relative, expected_sha in expected.items():
        if not isinstance(expected_sha, str) or SHA256_RE.fullmatch(expected_sha) is None:
            _fail(f"recovery authorization has no valid {relative} digest")
        archived = _contained(history_root / Path(relative), history_root,
                              f"preserved {relative}")
        observed_sha = _digest_file(archived, f"preserved {relative}")
        if observed_sha != expected_sha or manifest_digests.get(relative) != expected_sha:
            _fail(f"preserved {relative} differs from the authorized evidence")
        observed[relative] = observed_sha
    return observed


def validate_postrotation_identity(
    recovery_info: Mapping[str, Any],
    *,
    history_root: Path,
    current_host_certificate_path: Path,
    current_mount_attestation_path: Path,
    binding_path: Path,
) -> dict[str, Any]:
    """Bind fresh post-rotation evidence to the same physical storage.

    The old certificate and host-ledger receipt are only historical evidence.
    The current files must be newly attested, retain the physical volume and
    host-ledger identity, and be recorded before the recovery CLI is allowed to
    run.
    """
    authorization = recovery_info.get("authorization")
    if not isinstance(authorization, Mapping):
        _fail("recovery validation has no authorization object")
    run_receipt_path = authorization.get("run_receipt_path")
    if not isinstance(run_receipt_path, str):
        _fail("recovery authorization has no run receipt path")
    run_root = Path(run_receipt_path).resolve().parent
    history_root = Path(history_root)
    if history_root.is_symlink() or not history_root.is_dir():
        _fail("recovery history root is not an owned directory")
    mount_relative = _safe_relative_text(
        authorization.get("mount_attestation_relative_path"),
        "authorized mount attestation path",
    )
    old_certificate = _contained(
        history_root / "windows-folder-host.json", history_root,
        "preserved host certificate",
    )
    old_mount = _contained(
        history_root / mount_relative, history_root,
        "preserved mount attestation",
    )
    if _digest_file(old_certificate, "preserved host certificate") != authorization.get(
        "host_certificate_sha256"
    ):
        _fail("preserved host certificate is not the authorized pre-rotation evidence")
    if _digest_file(old_mount, "preserved mount attestation") != authorization.get(
        "mount_attestation_sha256"
    ):
        _fail("preserved mount attestation is not the authorized pre-rotation evidence")
    current_certificate = _contained(
        Path(current_host_certificate_path), run_root, "current host certificate"
    )
    current_mount = _contained(
        Path(current_mount_attestation_path), run_root, "current mount attestation"
    )
    if current_certificate.resolve() == old_certificate.resolve() or current_mount.resolve() == old_mount.resolve():
        _fail("post-rotation evidence still points at the preserved pre-rotation copy")
    current_certificate_sha = _digest_file(
        current_certificate, "current host certificate"
    )
    current_mount_sha = _digest_file(
        current_mount, "current mount attestation"
    )
    if current_certificate_sha == authorization.get("host_certificate_sha256"):
        _fail("post-rotation host certificate was not freshly published")
    if current_mount_sha == authorization.get("mount_attestation_sha256"):
        _fail("post-rotation mount attestation was not freshly published")
    old_certificate_value, _ = _json(old_certificate, "preserved host certificate")
    current_certificate_value, _ = _json(current_certificate, "current host certificate")
    old_mount_value, _ = _json(old_mount, "preserved mount attestation")
    current_mount_value, _ = _json(current_mount, "current mount attestation")
    certificate_fields = (
        "schema", "storage_profile", "role", "owner_scope", "host_root",
        "host_filesystem", "host_drive_type", "host_volume_serial", "host_root_no_reparse",
    )
    mount_fields = (
        "schema", "profile", "project_id", "storage_root", "mount_root",
        "ledger_root", "backing_image", "docker_daemon_id_sha256",
    )
    old_filesystem_uuid = _filesystem_uuid(old_mount_value, "preserved mount attestation")
    current_filesystem_uuid = _filesystem_uuid(current_mount_value, "current mount attestation")
    if old_filesystem_uuid != current_filesystem_uuid:
        _fail("post-rotation mount attestation changed the physical filesystem UUID")
    for label, before, after, fields in (
        ("host certificate", old_certificate_value, current_certificate_value, certificate_fields),
        ("mount attestation", old_mount_value, current_mount_value, mount_fields),
    ):
        for field in fields:
            if field not in before or field not in after or before[field] != after[field]:
                _fail(f"post-rotation {label} changed physical identity: {field}")
    current_certificate_relative = _relative_owned_path(
        current_certificate, run_root, "current host certificate"
    )
    current_mount_relative = _relative_owned_path(
        current_mount, run_root, "current mount attestation"
    )
    binding = {
        "schema": "fullmag.docker-runtime-recovery-postrotation-binding.v1",
        "request_id": authorization.get("request_id"),
        "run_id": run_root.name,
        "old": {
            "host_certificate_relative": "windows-folder-host.json",
            "host_certificate_sha256": authorization.get("host_certificate_sha256"),
            "mount_attestation_relative": mount_relative.as_posix(),
            "mount_attestation_sha256": authorization.get("mount_attestation_sha256"),
        },
        "new": {
            "host_certificate_relative": current_certificate_relative,
            "host_certificate_sha256": current_certificate_sha,
            "mount_attestation_relative": current_mount_relative,
            "mount_attestation_sha256": current_mount_sha,
        },
        "physical_identity": {
            "host_certificate": {field: current_certificate_value[field] for field in certificate_fields},
            "mount_attestation": {
                **{field: current_mount_value[field] for field in mount_fields},
                "filesystem_uuid": current_filesystem_uuid,
            },
        },
    }
    binding_path = _contained(Path(binding_path), run_root, "post-rotation binding")
    raw = _write_readonly_json(binding_path, binding, "post-rotation binding")
    return {
        "path": str(binding_path.resolve()),
        "sha256": _digest_bytes(raw),
        "binding": binding,
    }
