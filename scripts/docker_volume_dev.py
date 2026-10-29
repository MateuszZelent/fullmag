"""Volume-only orchestration for the existing fixed DEV backend/frontend."""
from __future__ import annotations

import base64
from contextlib import nullcontext
import hashlib
import io
import stat
import zipfile
import json
import os
from collections.abc import Mapping
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shlex
import stat
import sys
import time

import fullmag_storage as storage
from docker_build_control import (BuildControl, BuildControlError, canonical, control_read_script, docker_capture,
                                  compose_capture, build_volume_toolchain, build_volume_runtime_images, bounded_capture,
                                  mirror_console)
from docker_dev_host import docker_argv, require_host, local_volume, validate_host_path
import docker_preclaim_cancelled_restart as preclaim_restart
import docker_saved_authoring_history as retained_history

INCLUDE_UNTRACKED_ENV = "FULLMAG_DEV_INCLUDE_UNTRACKED"
_MAX_INCLUDE_UNTRACKED_FILES = 10000
_MAX_INCLUDE_UNTRACKED_BYTES = 64 * 1024
_CONTROL_NAMESPACE = re.compile(r"^namespaces/[0-9a-f]{32}$")


def _session_host():
    if os.name == "nt":
        import windows_folder_host as host
    else:
        import linux_native_host as host
    return host


def _capture_helper_source_binding(args, selected_source):
    from docker_dev import BASE_CONTEXT_FILES, RUNTIME_IMAGE_CONTEXT_FILES
    import docker_helper_source as helper_source

    pair = helper_source.validate_option_pair(
        getattr(args, "helper_source_root", None),
        getattr(args, "helper_source_commit", None),
    )
    if pair is None:
        return None
    try:
        return helper_source.capture_current_binding(
            pair[0], pair[1], selected_source, BASE_CONTEXT_FILES, RUNTIME_IMAGE_CONTEXT_FILES
        )
    except helper_source.HelperSourceError as error:
        raise BuildControlError("Helper-source pin is invalid: " + str(error)) from error


def _revalidate_helper_source_binding(binding, selected_source=None):
    if binding is None:
        return None
    from docker_dev import BASE_CONTEXT_FILES, RUNTIME_IMAGE_CONTEXT_FILES
    import docker_helper_source as helper_source

    try:
        return helper_source.revalidate_binding(
            binding,
            selected_source,
            base_context_files=BASE_CONTEXT_FILES,
            runtime_context_files=RUNTIME_IMAGE_CONTEXT_FILES,
        )
    except helper_source.HelperSourceError as error:
        raise BuildControlError("Pinned helper source changed or is unavailable: " + str(error)) from error


def _source_supplementary_groups(*paths):
    """Return non-primary owner groups needed to read selected source paths."""
    if sys.platform != "linux":
        return []
    groups = set()
    for path in (path.resolve(strict=True) for path in paths):
        info = path.stat()
        if not stat.S_ISDIR(info.st_mode):
            raise BuildControlError("Selected source mount is not a directory: " + str(path))
        if info.st_gid == 0:
            owner_access = info.st_uid == 65532 and info.st_mode & 0o500 == 0o500
            other_access = info.st_mode & 0o005 == 0o005
            if not (owner_access or other_access):
                raise BuildControlError(
                    "Selected source path requires GID 0 for runtime access: " + str(path)
                    + "; assign it to a non-root group or grant read/traverse access to others"
                )
            continue
        if info.st_gid != 65532:
            groups.add(str(info.st_gid))
    return sorted(groups, key=int)


def normalize_include_untracked_paths(values):
    """Validate and sort exact relative paths supplied through the CLI."""

    if values is None:
        values = []
    if not isinstance(values, (list, tuple)) or len(values) > _MAX_INCLUDE_UNTRACKED_FILES:
        raise BuildControlError("--include-untracked requires a bounded list of exact file paths")
    paths = []
    seen = set()
    for value in values:
        if not isinstance(value, str) or not value or "\x00" in value or "\\" in value:
            raise BuildControlError("--include-untracked paths must be non-empty POSIX-relative paths")
        posix = PurePosixPath(value)
        windows = PureWindowsPath(value)
        if (
            posix.is_absolute()
            or windows.is_absolute()
            or windows.anchor
            or value != posix.as_posix()
            or any(part in {"", ".", ".."} for part in posix.parts)
        ):
            raise BuildControlError("--include-untracked path escapes or is not canonical: " + value)
        if any(character in value for character in "*?[]"):
            raise BuildControlError("--include-untracked does not accept glob syntax: " + value)
        for component in posix.parts:
            stem = component.split(".", 1)[0].rstrip(" .").casefold()
            if (
                stem in {"con", "prn", "aux", "nul", "conin$", "conout$"}
                or re.fullmatch(r"(?:com|lpt)(?:[1-9]|[¹²³])", stem)
            ):
                raise BuildControlError("--include-untracked path uses a Windows device name: " + value)
        if value in seen:
            raise BuildControlError("--include-untracked paths must be unique: " + value)
        seen.add(value)
        paths.append(value)
    paths.sort()
    encoded = json.dumps(paths, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > _MAX_INCLUDE_UNTRACKED_BYTES:
        raise BuildControlError("--include-untracked allowlist exceeds its size bound")
    return paths


def parse_include_untracked_json(value):
    """Validate the canonical allowlist pinned in a backend environment."""

    if not isinstance(value, str):
        raise BuildControlError("Pinned live-source allowlist is missing or is not a string")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise BuildControlError("Pinned live-source allowlist is not UTF-8") from error
    if len(encoded) > _MAX_INCLUDE_UNTRACKED_BYTES:
        raise BuildControlError("Pinned live-source allowlist exceeds its size bound")
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError as error:
        raise BuildControlError("Pinned live-source allowlist is not valid JSON") from error
    paths = normalize_include_untracked_paths(decoded)
    canonical_value = json.dumps(paths, ensure_ascii=False, separators=(",", ":"))
    if value != canonical_value:
        raise BuildControlError("Pinned live-source allowlist is not canonical JSON")
    return paths


def include_untracked_from_compose(document):
    services = document.get("services") if isinstance(document, Mapping) else None
    backend = services.get("backend") if isinstance(services, Mapping) else None
    environment = backend.get("environment") if isinstance(backend, Mapping) else None
    if not isinstance(environment, Mapping):
        raise BuildControlError("Retained Compose backend environment is missing")
    return parse_include_untracked_json(environment.get(INCLUDE_UNTRACKED_ENV, "[]"))


def _certificate_path(state):
    return Path(state) / Path(_session_host().HOST_CERT_PATH).name


def _retained_certificate(state, document):
    host = _session_host()
    certificate = json.loads(host.read_owned_regular(_certificate_path(state)))
    if (certificate.get("schema") != host.HOST_SCHEMA
            or certificate.get("storage_profile") != document["services"]["backend"]["environment"]["FULLMAG_SESSION_STORAGE_PROFILE"]
            or certificate != json.loads(host.read_owned_regular(Path(state) / host.OWNER_NAME))):
        raise BuildControlError("Retained session storage profile/ownership differs")
    if os.name != "nt":
        if (certificate.get("host_inode") != Path(state).stat().st_ino
                or certificate.get("engine_id") != docker_text("info", "--format", "{{.ID}}").strip()
                or any(certificate.get(key) != value for key, value in local_volume(state).items())):
            raise BuildControlError("Retained Linux host directory/engine identity differs")
    return certificate


def _post_build_certificate_evidence(state, certificate):
    """Pin pre-rotation bytes plus the closed identity for continuation.

    ``reuse_host_certificate`` intentionally rotates image/source/binary and
    artifact fields.  The raw hashes here therefore describe the historical
    certificate observed before Compose recreation; the stable identity is the
    part that must match the newly admitted certificate.
    """
    from docker_volume_post_build_generation import certificate_stable_identity

    host = _session_host()
    certificate_path = _certificate_path(state)
    owner_path = Path(state) / host.OWNER_NAME
    certificate_raw = host.read_owned_regular(certificate_path)
    owner_raw = host.read_owned_regular(owner_path)
    try:
        certificate_value = json.loads(certificate_raw.decode("utf-8"))
        owner_value = json.loads(owner_raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Retained certificate evidence is not valid JSON") from error
    if certificate_value != certificate or owner_value != certificate_value:
        raise BuildControlError("Retained certificate/owner bytes differ from the admitted certificate")
    return {
        "historical_certificate_sha256": hashlib.sha256(certificate_raw).hexdigest(),
        "historical_owner_marker_sha256": hashlib.sha256(owner_raw).hexdigest(),
        "stable_identity": certificate_stable_identity(certificate),
        "storage_profile": certificate.get("storage_profile"),
        "restart_verified": certificate.get("restart_verified"),
    }


def _assert_post_build_removed_namespace_absent(metadata):
    """Recheck exact removed IDs after the new development lease opens."""
    recreate = metadata.get("recreate_operation") if isinstance(metadata, Mapping) else None
    absence = recreate.get("absence") if isinstance(recreate, Mapping) else None
    if not isinstance(recreate, Mapping) or not isinstance(absence, Mapping):
        raise BuildControlError("Post-build continuation has no completed recreation absence proof")
    for service in ("backend", "frontend"):
        item = absence.get(service)
        identifier = item.get("container_id") if isinstance(item, Mapping) else None
        if not isinstance(identifier, str):
            raise BuildControlError("Post-build continuation absence proof has no " + service + " ID")
        inspected = docker_capture("inspect", identifier, allow_failure=True, timeout=60)
        if inspected.returncode == 0:
            raise BuildControlError("A removed post-build service ID is inspectable under the new lease")
        detail = (inspected.stderr + inspected.stdout).decode("utf-8", "replace")
        if re.search(
            r"(?:no such object|no such container):\s*" + re.escape(identifier) + r"(?:\s|$)",
            detail,
            re.IGNORECASE,
        ) is None:
            raise BuildControlError("Docker did not confirm removed " + service + " absence under the new lease")
        listed = docker_capture(
            "ps", "--all", "--quiet", "--no-trunc", "--filter", "id=" + identifier,
            timeout=60,
        )
        if listed.returncode or listed.stdout.decode("utf-8", "replace").split():
            raise BuildControlError("Removed " + service + " ID is present under the new lease")



_PROCESS_RECEIPT_PROBE = """import json,pathlib,sys
sys.path.insert(0,'/opt/fullmag')
import runtime_service
try:
 raw=runtime_service._bounded_regular(runtime_service.process_receipt_path(runtime_service.canonical_paths()),'process receipt')
except FileNotFoundError:
 print(json.dumps({'state':'not-published'}))
else:
 print(raw.decode('utf-8'))
"""
BACKEND_PROCESS_RECEIPT_SCRIPT = _PROCESS_RECEIPT_PROBE


def _readiness_failure(process_receipt, logs):
    """Report a closed startup admission even when the process receipt is historical."""
    startup_prefix = "[fullmag-backend] Runtime startup failed; starting diagnostic API only: "
    for line in reversed(logs.splitlines()):
        if line.startswith(startup_prefix):
            return "Runtime startup failed; diagnostic API retained: " + line[len(startup_prefix):4096 + len(startup_prefix)]
    if (str(process_receipt.get("state", "")).startswith("failed")
            and "Startup or runtime failed; admission closed:" in logs):
        return "Runtime admission failed; services retained: " + str(process_receipt.get("error", "unknown failure"))[:4096]
    return None

_NEW_WINDOWS_RUNTIME_STATE_DIRECTORIES = (
    Path("runs"),
    Path("runs/docker-all"),
    Path("runs/docker-all/session-store"),
    Path("runs/docker-all/session-store/runtime-services"),
)

_RECOVERY_ENVIRONMENT_NAME = re.compile(r"FULLMAG_CONTAINER_RECOVERY_[A-Z0-9_]+\Z")
_RECOVERY_ATTEMPT = re.compile(r"[0-9a-f]{32}\Z")
_MAX_RECOVERY_METADATA_BYTES = 256 * 1024
_MAX_CANCELLED_ACTIVATION_RECORD_BYTES = 8 * 1024 * 1024
_CANCELLED_ACTIVATION_SCHEMA = "fullmag.docker-activation-accepted-then-cancelled.v1"
_CANCELLED_ACTIVATION_ATTEMPT = re.compile(r"[0-9a-f]{32}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_NATIVE_STOP_JOURNAL_SCHEMA = "fullmag.stop-failed-admission.v1"
_NATIVE_STOP_RECREATE_METADATA_SCHEMA = "fullmag.docker-native-failed-stop-recreate.v1"
_MAX_RUNTIME_CONFIG_BYTES = 256 * 1024
_ACCEPTED_REATTACH_ENVIRONMENT_KEYS = frozenset({
    "FULLMAG_ACCEPTED_REATTACH_REQUEST",
    "FULLMAG_ACCEPTED_REATTACH_REQUEST_SHA256",
})
_FRONTEND_OWNER_TMPFS = "/run/fullmag/frontend-owner"


def _normalize_tmpfs_options(value, *, label):
    """Return one canonical option map and reject duplicate/conflicting keys."""

    if not isinstance(value, str):
        raise BuildControlError("Retained tmpfs options are malformed: " + label)
    aliases = {
        "rw": "access", "ro": "access",
        "suid": "suid", "nosuid": "suid",
        "dev": "device", "nodev": "device",
        "exec": "exec", "noexec": "exec",
    }
    options = {}
    for raw in value.split(","):
        token = raw.strip().lower()
        if not token:
            raise BuildControlError("Retained tmpfs options contain an empty item: " + label)
        if "=" in token:
            key, item = token.split("=", 1)
            if not key or not item:
                raise BuildControlError("Retained tmpfs option is malformed: " + label)
            if key in {"uid", "gid"}:
                try:
                    item = str(int(item, 10))
                except ValueError as error:
                    raise BuildControlError("Retained tmpfs identity is malformed: " + label) from error
            elif key == "mode":
                try:
                    item = format(int(item, 8), "o")
                except ValueError as error:
                    raise BuildControlError("Retained tmpfs mode is malformed: " + label) from error
            elif key == "size" and item == "1048576":
                item = "1m"
            canonical = (key, item)
            option_key = key
        else:
            option_key = aliases.get(token, token)
            canonical = (option_key, token)
        if option_key in options:
            raise BuildControlError("Retained tmpfs options duplicate or conflict: " + label)
        options[option_key] = canonical
    return tuple(sorted(options.values()))


def _validate_recovery_environment(values):
    """Validate recovery-only environment injected from the control volume.

    Recovery callers must construct this mapping from authenticated control
    volume data.  Restricting names to the recovery namespace prevents a
    caller from replacing the source, storage, GPU, or Compose identity that
    ``start`` derives from the selected checkout.
    """

    if values is None:
        return {}
    if not isinstance(values, Mapping):
        raise BuildControlError("Recovery environment must be a mapping")
    result = {}
    for name, value in values.items():
        if not isinstance(name, str) or not _RECOVERY_ENVIRONMENT_NAME.fullmatch(name):
            raise BuildControlError("Recovery environment contains an unsupported variable name")
        if not isinstance(value, str) or "\x00" in value or len(value) > 8192:
            raise BuildControlError("Recovery environment contains an invalid value")
        result[name] = value
    if len(canonical(result)) > _MAX_RECOVERY_METADATA_BYTES:
        raise BuildControlError("Recovery environment exceeds the metadata budget")
    return result


def _validate_recovery_metadata(value):
    """Accept only bounded JSON metadata already authenticated by the caller."""

    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise BuildControlError("Recovery metadata must be a mapping")
    try:
        encoded = canonical(value)
    except (TypeError, ValueError) as error:
        raise BuildControlError("Recovery metadata is not canonical JSON") from error
    if len(encoded) > _MAX_RECOVERY_METADATA_BYTES:
        raise BuildControlError("Recovery metadata exceeds the metadata budget")
    return dict(value)


def _validate_accepted_reattach_environment(value):
    """Validate the two private controls passed to the API reattach bridge."""

    if value is None:
        return {}
    if not isinstance(value, Mapping) or set(value) != _ACCEPTED_REATTACH_ENVIRONMENT_KEYS:
        raise BuildControlError(
            "Accepted-run reattach requires exactly its request path and digest controls"
        )
    relative = value["FULLMAG_ACCEPTED_REATTACH_REQUEST"]
    if (not isinstance(relative, str) or not relative
            or len(relative) > 1024 or relative.startswith("/")
            or "\\" in relative or ":" in relative):
        raise BuildControlError("Accepted-run reattach request path is not relative")
    path = PurePosixPath(relative)
    if (str(path) != relative or path.is_absolute() or ".." in path.parts
            or any(part in {"", "."} for part in path.parts)
            or not relative.startswith("accepted-run-reattach/")):
        raise BuildControlError("Accepted-run reattach request path escapes runtime control")
    digest = value["FULLMAG_ACCEPTED_REATTACH_REQUEST_SHA256"]
    if not isinstance(digest, str) or _SHA256.fullmatch(digest) is None:
        raise BuildControlError("Accepted-run reattach request digest is invalid")
    return {key: str(item) for key, item in value.items()}


def _validate_accepted_reattach_metadata(value, environment):
    """Keep the producer's immutable pins in the next development receipt."""

    if value is None:
        if environment:
            raise BuildControlError("Accepted-run reattach pins are missing")
        return None
    validated = _validate_recovery_metadata(value)
    if not environment:
        raise BuildControlError("Accepted-run reattach pins have no environment controls")
    if validated.get("schema") != "fullmag.docker-accepted-run-reattach-producer.v1":
        raise BuildControlError("Accepted-run reattach pins have an unsupported schema")
    if validated.get("state") != "prepared":
        raise BuildControlError("Accepted-run reattach pins are not prepared")
    request_sha = validated.get("request_sha256")
    proof_sha = validated.get("proof_sha256")
    if (_SHA256.fullmatch(request_sha or "") is None
            or _SHA256.fullmatch(proof_sha or "") is None):
        raise BuildControlError("Accepted-run reattach pins have invalid record digests")
    if environment["FULLMAG_ACCEPTED_REATTACH_REQUEST_SHA256"] != request_sha:
        raise BuildControlError("Accepted-run reattach environment differs from its pins")
    for key, item in validated.items():
        if key.endswith("_sha256") and _SHA256.fullmatch(item or "") is None:
            raise BuildControlError("Accepted-run reattach pin has an invalid " + key)
    return validated


def _validate_existing_development_operation(control, operation, selected, identity):
    """Validate an already-held development lease before reusing it.

    The recovery path must never open a second BuildControl operation.  This
    check binds the supplied operation to the selected source and Compose
    group, and rejects an operation from another phase or attempt root.
    """

    if not isinstance(control, BuildControl):
        raise BuildControlError("Existing development context has no BuildControl")
    if not isinstance(operation, Mapping) or operation.get("lease_ready") is not True:
        raise BuildControlError("Existing development context has no active lease")
    receipt = operation.get("receipt")
    if not isinstance(receipt, Mapping):
        raise BuildControlError("Existing development context has no operation receipt")
    if receipt.get("phase") != "development":
        raise BuildControlError("Recovery operation must use the development phase")
    attempt = receipt.get("attempt")
    expected_root = "development/attempts/" + str(attempt)
    if not isinstance(attempt, str) or not _RECOVERY_ATTEMPT.fullmatch(attempt):
        raise BuildControlError("Recovery operation has an invalid attempt token")
    if operation.get("root") != expected_root:
        raise BuildControlError("Recovery operation root does not match its attempt")
    if receipt.get("compose_project") != control.project:
        raise BuildControlError("Recovery operation belongs to another Compose project")
    if identity.get("project_name") != control.project:
        raise BuildControlError("Selected checkout belongs to another Compose project")
    control_identity = control.identity
    for key in ("project_id", "worktree_id", "checkout_kind"):
        if control_identity.get(key) != identity.get(key):
            raise BuildControlError("Recovery operation identity differs from selected checkout")
    inputs = receipt.get("inputs")
    if not isinstance(inputs, Mapping) or inputs.get("source_root") != str(selected):
        raise BuildControlError("Recovery operation source differs from selected checkout")
    for key in ("source_project_id", "source_worktree_id", "source_checkout_kind"):
        expected = {"source_project_id": "project_id", "source_worktree_id": "worktree_id",
                    "source_checkout_kind": "checkout_kind"}[key]
        if key in inputs and inputs.get(key) != identity.get(expected):
            raise BuildControlError("Recovery operation source identity differs from selected checkout")
    return dict(receipt)


def _validate_existing_operation_inputs(receipt, expected):
    """Keep the ordinary DEV input contract immutable on a reused lease.

    Recovery owns one already-open ``BuildControl.operation``.  ``start`` may
    add recovery-only metadata, but it must not silently replace the standard
    source/image/device/operator inputs that later activate/resume commands
    use as their terminal proof.
    """

    actual = receipt.get("inputs") if isinstance(receipt, Mapping) else None
    if not isinstance(actual, Mapping):
        raise BuildControlError("Existing development operation has no standard inputs")
    required = (
        "source_root", "image_id", "source_project_id", "source_worktree_id",
        "source_checkout_kind", "gpu_access_requested", "device_access",
        "gpu_preflight", "operator_probe_environment_schema",
        "operator_probe_environment", "operator_probe_environment_sha256",
    )
    for key in required:
        if actual.get(key) != expected.get(key):
            raise BuildControlError(
                "Existing development operation input differs: " + key
            )
    if actual.get("unclaimed_cancellation") != expected.get("unclaimed_cancellation"):
        raise BuildControlError("Existing development operation input differs: unclaimed_cancellation")
    if "post_build_generation" in expected and actual.get("post_build_generation") != expected.get(
        "post_build_generation"
    ):
        raise BuildControlError("Existing development operation input differs: post_build_generation")


def _validate_prepared_start_context(prepared):
    """Validate toolchain/runtime receipts supplied by a recovery caller."""

    if not isinstance(prepared, Mapping):
        raise BuildControlError("Recovery start requires a prepared Docker context")
    toolchain = prepared.get("toolchain")
    images = prepared.get("images")
    if not isinstance(toolchain, Mapping) or not isinstance(images, Mapping):
        raise BuildControlError("Recovery start has incomplete prepared Docker context")
    toolchain_image = toolchain.get("image_id")
    backend = images.get("backend")
    image = backend.get("image_id") if isinstance(backend, Mapping) else None
    for label, value in (("toolchain", toolchain_image), ("backend", image)):
        if not isinstance(value, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
            raise BuildControlError(f"Recovery {label} image is not pinned by digest")
    if not isinstance(toolchain.get("inputs"), Mapping):
        raise BuildControlError("Recovery toolchain receipt has no inputs")
    return toolchain, images


def docker_text(*args, timeout=90, combined=False):
    result = docker_capture(*args, timeout=timeout)
    return (result.stdout + (result.stderr if combined else b"")).decode("utf-8", "replace")


_NO_SUCH_OBJECT = re.compile(r"error(?: response from daemon)?: no such (?:object|container): [0-9a-f]{12,64}", re.IGNORECASE)


def consumers():
    """Running containers, inspected as one snapshot.

    Other DEV groups start and remove short-lived helper containers all the
    time. One that exits or is removed between ``docker ps`` and ``docker
    inspect`` is no longer a consumer: it is left out exactly as if it had
    exited before the listing. Any other inspection failure still fails.
    """
    ids = docker_text("ps", "--quiet", "--no-trunc").split()
    if not ids:
        return []
    result = docker_capture("inspect", *ids, allow_failure=True)
    if result.returncode:
        stderr = result.stderr.decode("utf-8", "replace").strip()
        if not stderr or any(not _NO_SUCH_OBJECT.fullmatch(line.strip())
                             for line in stderr.splitlines() if line.strip()):
            raise BuildControlError(stderr or "Docker consumer inspection failed")
    documents = json.loads(result.stdout or b"[]")
    return [document for document in documents
            if isinstance(document, dict) and document.get("State", {}).get("Running") is True]


def _owned_volume(control, role, key):
    name = "fullmag-dev-" + role + "-v1-" + key[:24]
    labels = {**{k: v for k, v in control.labels.items() if k.startswith("org.fullmag.")},
              "org.fullmag.build.role": role, "org.fullmag.build.cache-key": key}
    found = docker_capture("volume", "inspect", name, allow_failure=True)
    if found.returncode:
        names = docker_text("volume", "ls", "--format", "{{.Name}}").splitlines()
        if name in names:
            raise BuildControlError("Existing data volume could not be inspected")
        arguments = ["volume", "create", "--driver", "local"]
        for label, value in labels.items():
            arguments += ["--label", label + "=" + value]
        docker_capture(*arguments, name)
        found = docker_capture("volume", "inspect", name)
    records = json.loads(found.stdout)
    if len(records) != 1:
        raise BuildControlError("Ambiguous build-data volume")
    observed = records[0]
    if (observed.get("Name") != name or observed.get("Driver") != "local"
            or observed.get("Options")
            or any((observed.get("Labels") or {}).get(k) != v for k, v in labels.items())):
        raise BuildControlError("Build-data volume ownership differs; retained")
    if any(m.get("Name") == name for c in consumers() for m in c.get("Mounts", [])):
        raise BuildControlError("Cannot initialize a build-data volume with active consumers")
    script = "test $(stat -c %u /data) = 0 -o $(stat -c %u /data) = 65532; chown 65532:65532 /data; chmod 0750 /data"
    args = control.helper_args(script, initialize=True)
    args[args.index("--entrypoint"):args.index("--entrypoint")] = ["--mount", "type=volume,src=" + name + ",dst=/data,volume-nocopy"]
    result = bounded_capture(args, data=b"", timeout=90)
    if result.returncode:
        raise BuildControlError(result.stderr.decode("utf-8", "replace"))
    return name


def _frontend(control, operation, selected, state, port, image):
    from docker_development_inputs import metadata_cache_key, seed
    files = []
    inputs = seed(selected, state, port, write_file=lambda relative, data: files.append({
        "relative": relative, "data": base64.b64encode(data).decode("ascii")}))
    previous_inputs = control.read("frontend/development-inputs.json", optional=True)
    if (isinstance(previous_inputs, dict)
            and all(previous_inputs.get(key) == inputs.get(key) for key in
                ("source_root", "worktree_id", "dependency_seed_sha256", "toolpins_sha256", "host_port", "files", "live_directories"))):
        inputs = previous_inputs
    key = metadata_cache_key(inputs, control.project)
    volume = _owned_volume(control, "frontend", key)
    operation["receipt"]["frontend_volume"] = volume
    request = canonical({"files": files, "inputs": inputs})
    if len(request) > 8 * 1024 * 1024:
        raise BuildControlError("Frontend metadata exceeds transfer budget")
    # Metadata only: the four application directories stay live readonly binds.
    script = r'''
import base64, hashlib, json, os, pathlib, stat, sys
root=pathlib.Path('/data/workspace')
request=json.load(sys.stdin)
freeze=pathlib.Path('/data/inputs-freeze.json')
if freeze.exists() or freeze.is_symlink():
    descriptor=os.open(freeze, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        metadata=os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink!=1 or metadata.st_size>8*1024*1024:
            raise RuntimeError('Frozen frontend inputs are not one bounded regular file')
        frozen=json.loads(stream.read(8*1024*1024+1))
    original=frozen.get('manifest')
    if not isinstance(original,dict): raise RuntimeError('Frozen frontend manifest is missing')
    digest=hashlib.sha256((json.dumps(original,sort_keys=True,separators=(',',':'))+'\n').encode()).hexdigest()
    without_commit=lambda value:{k:v for k,v in value.items() if k!='source_commit'}
    if (frozen.get('schema')!='fullmag.docker-development-inputs-freeze.v1'
            or frozen.get('frozen_root')!='/state/development/frozen-inputs'
            or frozen.get('manifest_digest')!=digest
            or frozen.get('files')!=original.get('files')
            or without_commit(original)!=without_commit(request['inputs'])):
        raise RuntimeError('Frozen frontend configuration changed; cache retained')
    request['inputs']=original
root.mkdir(parents=True,exist_ok=True)
cache=pathlib.Path('/data/cache')
if cache.is_symlink(): raise RuntimeError('Frontend cache is a link')
cache.mkdir(exist_ok=True)
lock=cache/'.fullmag-frontend-runtime.lock'
if lock.is_symlink(): raise RuntimeError('Frontend runtime lock is a link')
with lock.open('ab'): pass
for record in request['files']:
    relative=pathlib.PurePosixPath(record['relative'])
    if relative.is_absolute() or '..' in relative.parts:
        raise RuntimeError('Unsafe frontend seed path')
    target=root.joinpath(*relative.parts)
    parent=root
    for part in relative.parts[:-1]:
        parent=parent/part
        if parent.is_symlink(): raise RuntimeError('Frontend parent is a link')
        parent.mkdir(exist_ok=True)
    data=base64.b64decode(record['data'],validate=True)
    if target.is_symlink(): raise RuntimeError('Frontend seed is a link')
    if target.exists():
        if target.read_bytes()!=data and record['relative'] not in ('apps/control-room/tsconfig.json','apps/control-room/next-env.d.ts'):
            raise RuntimeError('Frontend metadata changed; cache retained')
    else:
        with target.open('xb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
for name in ('app','src','public','scripts'):
    target=root/'apps/control-room'/name
    if target.is_symlink(): raise RuntimeError('Live directory is a link')
    target.mkdir(exist_ok=True)
print(json.dumps({'state':'seeded','files':len(request['files']),'inputs':request['inputs']}))
'''
    args = control.helper_args("exec /usr/local/bin/python3 -I -c " + __import__('shlex').quote(script))
    args[args.index("--entrypoint"):args.index("--entrypoint")] = ["--mount", "type=volume,src=" + volume + ",dst=/data,volume-nocopy"]
    args[args.index(control.image)] = image
    result = bounded_capture(args, data=request, timeout=120)
    if result.returncode:
        raise BuildControlError(result.stderr.decode("utf-8", "replace"))
    seeded = json.loads(result.stdout)
    inputs = seeded.pop("inputs")
    control.write(operation["root"] + "/frontend-seed.json", seeded)
    control.write("frontend/development-inputs.json", inputs)
    return inputs, volume


def _backend_cache(control, operation, layout, selected, image, toolchain):
    import docker_backend_volume_cache as cache
    def volume_docker(*args):
        result = docker_capture(*args, allow_failure=True)
        if result.returncode:
            if args[:2] == ("volume", "inspect") and "no such volume" in result.stderr.decode().lower():
                raise cache.VolumeNotFound(result.stderr.decode())
            raise BuildControlError(result.stderr.decode())
        return result.stdout.decode()
    relative = operation["root"] + "/backend-cache.json"
    layout = {**layout, "compose_project": control.project}
    import docker_shared_build_storage as shared
    planned = cache.prepare(layout, selected, image, layout["storage_root"],
        source_root=selected, toolchain_image=toolchain,
        control_volume_name=control.volume, control_namespace=control.namespace,
        shared_packages=True)
    def shared_docker(*args):
        try:
            return volume_docker(*args)
        except cache.VolumeNotFound as error:
            raise shared.VolumeNotFound(str(error)) from error
    shared.ensure_volumes(shared_docker, planned["project_id"])
    helper = control.helper_args(shared.INITIALIZER_SCRIPT, initialize=True)
    extra = []
    for mount in shared.initializer_mount_descriptors(planned["project_id"]):
        extra += ["--mount", "type=volume,src=" + mount["source"] + ",dst=" + mount["target"] + ",volume-nocopy"]
    for key, value in shared.initializer_environment(planned["unit_key"]).items():
        extra += ["--env", key + "=" + value]
    for key, value in shared.initializer_labels(planned["project_id"], planned["unit_key"]).items():
        extra += ["--label", key + "=" + value]
    helper[helper.index("--entrypoint"):helper.index("--entrypoint")] = extra
    helper[helper.index(control.image)] = image
    initialized = bounded_capture(helper, data=b"", timeout=180)
    if initialized.returncode:
        raise BuildControlError("Shared cache initialization failed: " + initialized.stderr.decode("utf-8", "replace"))
    proof = shared.validate_initializer_receipt(initialized.stdout.decode(), planned["unit_key"])
    control.write(operation["root"] + "/shared-storage.json", {
        "schema": shared.SCHEMA, "project_id": planned["project_id"],
        "volumes": shared.volume_descriptors(planned["project_id"]), "initialization": proof})
    profile = cache.prepare(layout, selected, image, layout["storage_root"], volume_docker,
        source_root=selected, toolchain_image=toolchain, active_consumers=consumers,
        control_volume_name=control.volume, control_namespace=control.namespace,
        shared_packages=True)
    snapshot = _active_isolated_snapshot(control)
    if snapshot is not None:
        from docker_isolated_control_prepare import prepare_snapshot_control
        prepare_snapshot_control(control, snapshot, operation=operation)
    overlay = cache.maintenance_overlay(profile)
    overlay["name"] = control.project
    control.write(operation["root"] + "/cache-maintenance-compose.json", overlay)
    output = compose_capture(overlay, "run", "--rm", "--no-deps", cache.MAINTENANCE_SERVICE, timeout=180)
    receipt = cache._read_json_output(output.decode())
    result = cache.validate(profile, profile["volume_documents"], receipt, consumers)
    control.write(relative, result)
    return result


def _verify_host_ledger_volume(control, operation, descriptor, image):
    import docker_host_ledger as ledger
    spec = ledger.host_volume_probe_spec(descriptor, image)
    service = "host-ledger-volume-probe"
    name = "fullmag-ledger-volume-" + operation["receipt"]["attempt"]
    control.write(operation["root"] + "/host-ledger-volume-probe-compose.json", spec)
    operation["receipt"]["ledger_volume_probe_container"] = name
    output = compose_capture(spec, "run", "--name", name, "--no-deps", service, timeout=90)
    observed = json.loads(docker_text("inspect", name))
    if len(observed) != 1:
        raise BuildControlError("Ledger volume probe identity is ambiguous; retained")
    actual = observed[0]
    config, isolation = actual.get("Config", {}), actual.get("HostConfig", {})
    labels = config.get("Labels", {})
    mounts = [mount for mount in actual.get("Mounts", []) if mount.get("Destination") == "/host-ledger"]
    if (actual.get("Image") != image or actual.get("State", {}).get("Running")
            or actual.get("State", {}).get("ExitCode") != 0
            or labels.get("com.docker.compose.project") != control.project
            or labels.get("com.docker.compose.service") != service
            or config.get("User") != "65532:65532" or isolation.get("Privileged")
            or not isolation.get("ReadonlyRootfs") or isolation.get("NetworkMode") != "none"
            or isolation.get("PidMode") not in {None, "", "private"}
            or len(mounts) != 1 or mounts[0].get("Type") != "volume"
            or mounts[0].get("Name") != descriptor["name"] or mounts[0].get("RW")):
        raise BuildControlError("Ledger volume probe isolation/identity/outcome differs; retained")
    proof = json.loads(output.decode().strip())
    if (proof.get("schema") != "fullmag.host-ledger-volume-probe.v1"
            or proof.get("state") != "verified" or proof.get("volume_name") != descriptor["name"]
            or proof.get("filesystem_uuid") != descriptor["filesystem_uuid"]):
        raise BuildControlError("Ledger volume probe did not verify the selected filesystem; retained")
    control.write(operation["root"] + "/host-ledger-volume-probe.json",
                  {**proof, "container_id": actual["Id"], "image_id": image,
                   "descriptor_sha256": hashlib.sha256(canonical(descriptor)).hexdigest()})
    control.write(operation["root"] + "/host-ledger-volume-probe-log.json",
                  {"log": docker_text("logs", name, combined=True)})
    docker_capture("rm", actual["Id"])


def _assert_host_capacity_migration_quiescent():
    """A shared policy change requires coordinated, stopped ledger consumers.

    This is a read-only preflight. The native writer and owner lock still
    decide quiescence at publication; a Docker observation is not that proof.
    """
    listing = bounded_capture(
        docker_argv("ps", "--all", "--no-trunc", "--format", "{{.ID}}"),
        timeout=30, maximum=1024 * 1024,
    )
    if listing.returncode:
        raise BuildControlError("Cannot observe ledger consumers before host capacity migration")
    identifiers = listing.stdout.decode("ascii").splitlines()
    if (len(identifiers) > 4096 or len(set(identifiers)) != len(identifiers)
            or any(re.fullmatch(r"[0-9a-f]{64}", item) is None for item in identifiers)):
        raise BuildControlError("Docker consumer inventory is malformed or exceeds its bound")
    blockers = []
    for offset in range(0, len(identifiers), 32):
        batch = identifiers[offset:offset + 32]
        result = bounded_capture(
            docker_argv("inspect", *batch), timeout=30, maximum=8 * 1024 * 1024,
        )
        if result.returncode:
            raise BuildControlError("Docker consumer inventory changed; coordinate and retry observation")
        records = json.loads(result.stdout)
        if (not isinstance(records, list) or len(records) != len(batch)
                or any(not isinstance(item, dict) for item in records)
                or {item.get("Id") for item in records} != set(batch)):
            raise BuildControlError("Docker consumer inspection differs from its inventory")
        for item in records:
            mounts = item.get("Mounts")
            if (not isinstance(mounts, list)
                    or any(not isinstance(mount, dict)
                           or not isinstance(mount.get("Destination"), str) for mount in mounts)):
                raise BuildControlError("Docker consumer inspection has an unknown mount inventory")
            # A DEV group ledger volume at the same path is private to its
            # group and never a consumer of the global host ledger.
            import docker_group_ledger as group_ledger
            if not any(mount["Destination"] == "/host-ledger"
                       and not group_ledger.is_group_ledger_mount(mount) for mount in mounts):
                continue
            running = item.get("State", {}).get("Running")
            if type(running) is not bool:
                raise BuildControlError("Ledger consumer has an unknown running state")
            if running:
                blockers.append(str(item.get("Name", item["Id"])) + " (" + item["Id"] + ")")
    if blockers:
        raise BuildControlError(
            "Host capacity migration requires coordinated stop of ledger consumers: "
            + ", ".join(blockers)
        )


def _uses_group_ledger(control, operation, *, new_render):
    """Select the ledger profile pinned in this operation receipt.

    Every new render uses the per-group ledger (ADR 0067).  A supplied
    operation keeps an explicit pin: container recovery pins the profile of
    the backend it recovers, and a partially resumed global render keeps the
    global ledger.  An unpinned supplied operation without a global render
    is a fresh render of this group.
    """
    receipt = operation["receipt"]
    pinned = receipt.get("ledger_profile")
    if pinned not in (None, "group-ledger-v1", "host-ledger-v1"):
        raise BuildControlError("Retained ledger profile is invalid")
    if new_render:
        return True
    if pinned is not None:
        return pinned == "group-ledger-v1"
    global_render = ("host_capacity_scope" in receipt or control.read(
        operation["root"] + "/ledger-maintenance-compose.json", optional=True) is not None)
    return not global_render


def _group_ledger(control, operation, image, *, new_render=False):
    """Prepare the group's own ledger volume; no host or privileged helper."""
    import docker_group_ledger as group_ledger
    import docker_host_ledger as ledger
    if new_render:
        operation["receipt"]["ledger_profile"] = group_ledger.PROFILE
        control.write(operation["root"] + "/receipt.json", operation["receipt"])
    daemon = ledger._daemon_info(docker_text)
    retained = control.read(operation["root"] + "/group-ledger.json", optional=True)
    if retained is not None and (
            not isinstance(retained, Mapping)
            or retained.get("daemon_id_sha256") != daemon["id_sha256"]
            or retained.get("compose_project") != control.project):
        raise BuildControlError("Retained group ledger belongs to another daemon or group")
    generation_record = control.read("group-ledger-generation.json", optional=True)
    empty_generation = _empty_stopped_namespace_ledger_generation(control)
    generation = empty_generation
    if generation_record is not None:
        from docker_volume_fresh_runtime import pinned_group_archive
        pinned_group_archive(control, generation_record)
        generation = generation_record["generation"]
    generation = _select_group_ledger_generation(empty_generation, generation_record)
    key = group_ledger.volume_key(daemon["id_sha256"], control.project, generation)
    volume = _owned_volume(control, group_ledger.VOLUME_ROLE, key)
    _validate_empty_quarantine_ledger_volume(control, empty_generation, volume)
    # Create the ledger leaf before admission: the backend is attested
    # before its native initializer would otherwise create it.
    script = ("test ! -L /data/ledger; if test ! -e /data/ledger; then "
              "mkdir -m 0750 /data/ledger; fi; test -d /data/ledger; "
              "test $(stat -c %u /data/ledger) = 65532")
    args = control.helper_args(script)
    args[args.index("--entrypoint"):args.index("--entrypoint")] = [
        "--mount", "type=volume,src=" + volume + ",dst=/data,volume-nocopy"]
    result = bounded_capture(args, data=b"", timeout=90)
    if result.returncode:
        raise BuildControlError("Group ledger initialization failed: "
                                + result.stderr.decode("utf-8", "replace"))
    profile = group_ledger.profile(daemon["id_sha256"], control.project, volume, image)
    record = {"schema": "fullmag.docker-group-ledger.v1", "profile": group_ledger.PROFILE,
              "daemon_id_sha256": daemon["id_sha256"], "compose_project": control.project,
              "volume_name": volume, "host_id": profile["environment"][group_ledger.HOST_ID_ENV]}
    if retained is not None and retained != record:
        raise BuildControlError("Retained group ledger identity changed during partial resume")
    control.write(operation["root"] + "/group-ledger.json", record)
    return profile["backend"], profile


def _snapshot_certificate_placeholder(control, state, certificate_path, snapshot):
    """Retain only the empty pre-admission placeholder from the known cache refusal."""
    import linux_native_host as host
    if not os.path.lexists(certificate_path):
        certificate_path.touch(exist_ok=False)
        return
    previous = control.read("development/current.json", optional=True)
    if (not isinstance(previous, Mapping)
            or previous.get("state") != "failed-confirmed"
            or previous.get("control_namespace") != control.namespace
            or previous.get("namespace_registry_sha256") != control.namespace_registry_sha256
            or previous.get("inputs", {}).get("source_root") != snapshot["source_root"]
            or previous.get("backend_container") or previous.get("frontend_container")
            or "runtime-control control namespace is nonempty without its owner marker"
               not in str(previous.get("error", ""))
            or Path(state) != Path(snapshot["destination_state_root"])
            or os.path.lexists(Path(state) / host.OWNER_NAME)
            or control.read_bytes("isolated-snapshot/native-validation.json", optional=True) is not None
            or host.read_owned_regular(certificate_path, 1) != b""):
        raise BuildControlError("Existing snapshot certificate is not the pinned pre-admission placeholder")


def _active_isolated_snapshot(control):
    snapshot = (getattr(control, "namespace_registry", None) or {}).get("retirement", {})
    if snapshot.get("schema") != "fullmag.docker-isolated-session-snapshot.v1":
        return None
    from docker_volume_fresh_runtime import snapshot_bootstrap_retired
    return None if snapshot_bootstrap_retired(control, snapshot) else snapshot


def _empty_stopped_namespace_ledger_generation(control):
    """Bind an empty-stopped namespace to its fresh isolated ledger generation."""
    if not control.namespace:
        return None
    retirement = control.namespace_registry.get("retirement")
    if not isinstance(retirement, Mapping):
        return None
    if retirement.get("schema") == "fullmag.docker-isolated-session-snapshot.v1":
        token = retirement["recovery_id"]
        if control.namespace != "namespaces/" + token:
            raise BuildControlError("Snapshot fresh-ledger namespace differs")
        return token
    if retirement.get("schema") != "fullmag.docker-control-namespace-empty-quarantine.v1":
        return None
    token = retirement.get("recovery_id")
    if (retirement.get("scope") != "empty-stopped-namespace"
            or retirement.get("state") != "quarantined-empty-not-replayed"
            or not isinstance(token, str) or re.fullmatch(r"[0-9a-f]{32}", token) is None
            or control.namespace != "namespaces/" + token
            or not isinstance(retirement.get("ledger_volume"), str)
            or not retirement["ledger_volume"].startswith("fullmag-dev-group-ledger-v1-")):
        raise BuildControlError("Empty quarantine namespace has an invalid fresh-ledger binding")
    return token


def _select_group_ledger_generation(empty_generation, generation_record):
    """Let a later explicit archive rotation supersede the bootstrap token."""
    if generation_record is not None:
        return generation_record["generation"]
    return empty_generation


def _validate_empty_quarantine_ledger_volume(control, empty_generation, volume):
    if empty_generation is None:
        return
    retirement = control.namespace_registry.get("retirement", {})
    if volume == retirement.get("ledger_volume"):
        raise BuildControlError("Empty quarantine namespace resolved to the retained old ledger")


def _retained_ledger_profile(control, previous_root, document, image):
    """Rebuild the ledger attestation profile of one retained DEV render."""
    environment = document["services"]["backend"]["environment"]
    import docker_group_ledger as group_ledger
    if group_ledger.is_group_ledger_backend(environment):
        try:
            profile = group_ledger.retained_profile(document, image)
        except group_ledger.GroupLedgerError as error:
            raise BuildControlError(str(error)) from error
        record = control.read(previous_root + "/group-ledger.json")
        if (not isinstance(record, Mapping) or record.get("volume_name") != profile["volume_name"]
                or record.get("host_id") != profile["environment"][group_ledger.HOST_ID_ENV]):
            raise BuildControlError("Retained group ledger record differs from its Compose render")
        return profile
    return {"profile": "host-ledger-v1", "image_id": image, "environment": environment,
        "mount_root": environment["FULLMAG_HOST_LEDGER_MOUNT_ROOT"],
        "project_id": environment["FULLMAG_HOST_LEDGER_PROJECT_ID"],
        "backing_image": environment["FULLMAG_HOST_LEDGER_BACKING_IMAGE"],
        "host_receipt": control.read(previous_root + "/host-ledger.json"),
        "maintenance_document": control.read(previous_root + "/ledger-maintenance-compose.json")}


def _host_ledger(control, operation, layout, selected, image, *, new_render=False,
                 migrate_capacity=False):
    import docker_host_ledger as ledger
    scope = operation["receipt"].get("host_capacity_scope")
    migrate = operation["receipt"].get("host_capacity_migration", False)
    if type(migrate) is not bool or type(migrate_capacity) is not bool:
        raise BuildControlError("Host capacity migration intent is invalid")
    if scope not in (None, "docker_vm_root"):
        raise BuildControlError("Retained host capacity scope is invalid")
    if new_render:
        # Pin the intent in the existing receipt before any fallible helper or
        # Compose work. An interrupted first render must not resume as legacy.
        scope = operation["receipt"]["host_capacity_scope"] = "docker_vm_root"
        migrate = operation["receipt"]["host_capacity_migration"] = migrate_capacity
        control.write(operation["root"] + "/receipt.json", operation["receipt"])
    elif migrate_capacity and not migrate:
        raise BuildControlError("Partial resume cannot add a new host capacity migration intent")
    if migrate:
        if scope != "docker_vm_root":
            raise BuildControlError("Host capacity migration requires pinned root/VM capacity")
        _assert_host_capacity_migration_quiescent()
    values = ledger._resolve_values(layout)
    prior_environment = None
    prior_backend_environment = None
    prior_capacity_publication = control.read(
        operation["root"] + "/host-capacity-publication.json", optional=True
    )
    publish_capacity = scope == "docker_vm_root"
    if not new_render:
        prior_spec = control.read(operation["root"] + "/ledger-maintenance-compose.json", optional=True)
        if prior_spec is not None:
            if not isinstance(prior_spec, Mapping) or not isinstance(prior_spec.get("services"), Mapping):
                raise BuildControlError("Retained host-ledger Compose is malformed")
            prior_service = prior_spec["services"].get("host-ledger-maintenance")
            prior_environment = prior_service.get("environment") if isinstance(prior_service, Mapping) else None
            if not isinstance(prior_environment, Mapping):
                raise BuildControlError("Retained host-ledger Compose has no maintenance environment")
            prior_flag = prior_environment.get("FULLMAG_HOST_LEDGER_PUBLISH_CAPACITY", "0")
            if scope == "docker_vm_root" and prior_flag != "1":
                raise BuildControlError("Retained maintenance differs from the pinned host capacity scope")
            if prior_flag not in {"0", "1"}:
                raise BuildControlError("Retained host-ledger capacity flag is invalid")
            publish_capacity = prior_flag == "1"
        prior_app_spec = control.read(operation["root"] + "/compose.json", optional=True)
        if prior_app_spec is not None:
            if not isinstance(prior_app_spec, Mapping) or not isinstance(prior_app_spec.get("services"), Mapping):
                raise BuildControlError("Retained application Compose is malformed")
            prior_backend = prior_app_spec["services"].get("backend")
            prior_backend_environment = prior_backend.get("environment") if isinstance(prior_backend, Mapping) else None
            if not isinstance(prior_backend_environment, Mapping):
                raise BuildControlError("Retained application Compose has no backend environment")
            old_path = prior_backend_environment.get("FULLMAG_DOCKER_HOST_CAPACITY_PATH")
            old_sha = prior_backend_environment.get("FULLMAG_DOCKER_HOST_CAPACITY_SHA256")
            if bool(old_path) != bool(old_sha):
                raise BuildControlError("Retained backend capacity binding is incomplete")
            if old_sha is not None:
                if (not isinstance(old_sha, str) or re.fullmatch(r"[0-9a-f]{64}", old_sha) is None
                        or old_path != f"/host-ledger/capacity/{old_sha}.json"):
                    raise BuildControlError("Retained backend capacity binding is invalid")
            if bool(old_sha) != publish_capacity:
                raise BuildControlError("Retained application and maintenance capacity settings differ")
            old_migration = prior_backend_environment.get("FULLMAG_DOCKER_HOST_CAPACITY_MIGRATION_SHA256")
            if bool(old_migration) != migrate or (migrate and old_migration != old_sha):
                raise BuildControlError("Retained backend host capacity migration intent differs")
    if prior_capacity_publication is not None and not publish_capacity:
        raise BuildControlError("Legacy resume cannot retain a host capacity publication")
    fresh_capacity = publish_capacity and (new_render or prior_environment is None)
    daemon = ledger._daemon_info(docker_text, include_capacity=fresh_capacity)
    if publish_capacity and not fresh_capacity:
        if prior_environment.get("FULLMAG_DOCKER_HOST_ID") != daemon["id_sha256"]:
            raise BuildControlError("Retained capacity publication belongs to another Docker daemon")
        for key in (
            "FULLMAG_HOST_LEDGER_DOCKER_CPU_COUNT",
            "FULLMAG_HOST_LEDGER_DOCKER_MEMORY_TOTAL_BYTES",
        ):
            value = prior_environment.get(key)
            if not isinstance(value, str) or not value.isdecimal() or int(value) <= 0:
                raise BuildControlError("Retained host-ledger capacity input is invalid: " + key)
    ledger._image_attestation(image, docker_text)
    helper = selected / "scripts/lib/docker_host_ledger.sh"
    helper_bytes = _session_host().read_owned_regular(helper, maximum=ledger.MAX_HELPER_BYTES)
    helper_hash = hashlib.sha256(helper_bytes).hexdigest()
    helper_relative = operation["root"] + "/docker_host_ledger.sh"
    control.write_bytes(helper_relative, helper_bytes)
    daemon_storage = ledger._daemon_path(values["storage_root"], "storage root")
    if os.name != "nt":
        from docker_wsl_bind import resolve_daemon_bind
        daemon_storage = resolve_daemon_bind(control, operation, Path(values["storage_root"]), image)
    backing = daemon_storage + "/build-volumes/" + ledger.IMAGE_NAME
    env = {
        "FULLMAG_HOST_LEDGER_PROFILE": ledger.PROFILE,
        "FULLMAG_HOST_LEDGER_PROJECT_ID": values["project_id"],
        "FULLMAG_HOST_LEDGER_STORAGE_ROOT": daemon_storage,
        "FULLMAG_HOST_LEDGER_BACKING_IMAGE": backing,
        "FULLMAG_HOST_LEDGER_MOUNT_ROOT": values["mount_root"],
        "FULLMAG_HOST_LEDGER_LOCK_PATH": backing + ".lock",
        "FULLMAG_HOST_LEDGER_OWNER_MARKER": values["owner_marker"],
        "FULLMAG_HOST_LEDGER_SIZE_BYTES": str(ledger.IMAGE_SIZE_BYTES),
        "FULLMAG_HOST_LEDGER_MOUNT_TARGET": ledger.MOUNT_TARGET,
        "FULLMAG_HOST_LEDGER_ROOT": ledger.LEDGER_ROOT,
        "FULLMAG_HOST_LEDGER_LEDGER_ROOT": values["ledger_root_daemon"],
        "FULLMAG_HOST_LEDGER_HELPER_PATH": ledger._daemon_path(helper, "readonly helper source"),
        "FULLMAG_HOST_LEDGER_HELPER_IMAGE": image,
        "FULLMAG_HOST_LEDGER_HOST_PID": "1",
        "FULLMAG_HOST_LEDGER_RUNTIME_UID": "65532", "FULLMAG_HOST_LEDGER_RUNTIME_GID": "65532",
        "FULLMAG_HOST_LEDGER_LOCK_WAIT_SECONDS": "120", "FULLMAG_DOCKER_HOST_ID": daemon["id_sha256"],
        "FULLMAG_HOST_LEDGER_CGROUP_MODE": "host" if publish_capacity else "private",
    }
    if publish_capacity:
        env.update({
            "FULLMAG_HOST_LEDGER_PUBLISH_CAPACITY": "1",
            "FULLMAG_HOST_LEDGER_DOCKER_CPU_COUNT": str(
                daemon["cpu_count"] if fresh_capacity else int(prior_environment["FULLMAG_HOST_LEDGER_DOCKER_CPU_COUNT"])
            ),
            "FULLMAG_HOST_LEDGER_DOCKER_MEMORY_TOTAL_BYTES": str(
                daemon["memory_total_bytes"] if fresh_capacity else int(prior_environment["FULLMAG_HOST_LEDGER_DOCKER_MEMORY_TOTAL_BYTES"])
            ),
        })
    else:
        env["FULLMAG_HOST_LEDGER_PUBLISH_CAPACITY"] = "0"
    command = docker_argv("compose", "--project-name", control.project,
               "-f", "-", "-f", str(selected / "compose.host-ledger.yaml"), "--profile", "host-ledger-maintenance", "config", "--format", "json")
    result = bounded_capture(command, data=canonical({"name": control.project,
        "services": {"backend": {"image": image}}}),
        env={**os.environ, **env}, timeout=90)
    if result.returncode or len(result.stdout) > 1024 * 1024:
        raise BuildControlError("Host-ledger Compose rendering failed: " + result.stderr.decode("utf-8", "replace"))
    rendered = json.loads(result.stdout)
    service = rendered["services"]["host-ledger-maintenance"]
    if prior_environment is not None:
        helper_environment = service.get("environment")
        if not isinstance(helper_environment, dict):
            raise BuildControlError("Rendered host-ledger maintenance environment is not a mapping")
        if any(helper_environment.get(key) != value for key, value in prior_environment.items()):
            raise BuildControlError("Retained host-ledger maintenance environment changed")
        extra_environment = set(helper_environment) - set(prior_environment)
        allowed_capacity_fields = {
            "FULLMAG_DOCKER_HOST_ID",
            "FULLMAG_HOST_LEDGER_PUBLISH_CAPACITY",
            "FULLMAG_HOST_LEDGER_DOCKER_CPU_COUNT",
            "FULLMAG_HOST_LEDGER_DOCKER_MEMORY_TOTAL_BYTES",
        }
        if extra_environment - allowed_capacity_fields:
            raise BuildControlError("Retained host-ledger maintenance environment has new fields")
        for key in extra_environment:
            helper_environment.pop(key, None)
        if set(helper_environment) != set(prior_environment):
            raise BuildControlError("Retained host-ledger maintenance environment shape changed")
    service["volumes"] = [mount for mount in service["volumes"]
                          if mount["target"] != "/usr/local/sbin/docker_host_ledger.sh"]
    control_options = {"nocopy": True}
    control_subpath = _resolved_control_subpath(control)
    if control_subpath:
        control_options["subpath"] = control_subpath
    service["volumes"].append({"type": "volume", "source": "build-control",
        "target": "/fullmag-build-control", "read_only": True, "volume": control_options})
    service["entrypoint"] = ["/bin/bash", "/fullmag-build-control/" + helper_relative]
    spec = {"name": control.project, "services": {"host-ledger-maintenance": service},
            "volumes": {"build-control": {"name": control.volume, "external": True}}}
    control.write(operation["root"] + "/ledger-maintenance-compose.json", spec)
    name = "fullmag-ledger-" + operation["receipt"]["attempt"]
    operation["daemon_pending"] = True
    try:
        output = compose_capture(
            spec, "run", "--name", name, "--no-deps",
            "host-ledger-maintenance", "ensure", timeout=360,
        )
    except BaseException as capture_error:
        proof_path = operation["root"] + "/ledger-helper-failure-observation.json"
        log_path = operation["root"] + "/ledger-helper-failure-log.json"
        proof = {
            "schema": "fullmag.host-ledger-helper-failure-observation.v1",
            "container_name": name,
            "image_id": image,
            "compose_project": control.project,
            "compose_service": "host-ledger-maintenance",
            "capture_error": str(capture_error)[:4096],
        }
        try:
            inspected = bounded_capture(
                docker_argv("inspect", name), timeout=30, maximum=1024 * 1024,
            )
            proof["inspect_exit_code"] = inspected.returncode
            initial = None
            if inspected.returncode == 0:
                records = json.loads(inspected.stdout)
                if isinstance(records, list) and len(records) == 1 and isinstance(records[0], dict):
                    initial = records[0]
                    proof["inspect"] = initial
                else:
                    proof["inspect_error"] = "inspect result is not exactly one container"
            else:
                proof["inspect_error"] = (inspected.stderr or inspected.stdout).decode(
                    "utf-8", "replace"
                )[:4096]

            logs = bounded_capture(
                docker_argv("logs", "--tail", "200", name), timeout=30, maximum=1024 * 1024,
            )
            log_bytes = logs.stdout + logs.stderr
            control.write(log_path, {
                "schema": "fullmag.host-ledger-helper-failure-log.v1",
                "container_name": name,
                "exit_code": logs.returncode,
                "truncated": len(log_bytes) > 512 * 1024,
                "log": log_bytes[-(512 * 1024):].decode("utf-8", "replace"),
            })
            proof["log_path"] = log_path
            proof["logs_exit_code"] = logs.returncode

            state = initial.get("State") if isinstance(initial, Mapping) else None
            config = initial.get("Config") if isinstance(initial, Mapping) else None
            labels = config.get("Labels") if isinstance(config, Mapping) else None
            first_id = initial.get("Id") if isinstance(initial, Mapping) else None
            initially_owned = (
                isinstance(initial, Mapping)
                and initial.get("Name") == "/" + name
                and initial.get("Image") == image
                and isinstance(config, Mapping) and config.get("Image") == image
                and isinstance(labels, Mapping)
                and labels.get("com.docker.compose.project") == control.project
                and labels.get("com.docker.compose.service") == "host-ledger-maintenance"
                and isinstance(first_id, str) and re.fullmatch(r"[0-9a-f]{64}", first_id)
            )
            if initially_owned and logs.returncode == 0:
                checked = bounded_capture(
                    docker_argv("inspect", name), timeout=30, maximum=1024 * 1024,
                )
                proof["recheck_exit_code"] = checked.returncode
                current = None
                if checked.returncode == 0:
                    records = json.loads(checked.stdout)
                    if isinstance(records, list) and len(records) == 1 and isinstance(records[0], dict):
                        current = records[0]
                        proof["recheck"] = current
                final_state = current.get("State") if isinstance(current, Mapping) else None
                final_config = current.get("Config") if isinstance(current, Mapping) else None
                final_labels = final_config.get("Labels") if isinstance(final_config, Mapping) else None
                safe_to_remove = (
                    isinstance(current, Mapping)
                    and current.get("Id") == first_id
                    and current.get("Name") == "/" + name
                    and current.get("Image") == image
                    and isinstance(final_config, Mapping) and final_config.get("Image") == image
                    and isinstance(final_labels, Mapping)
                    and final_labels.get("com.docker.compose.project") == control.project
                    and final_labels.get("com.docker.compose.service") == "host-ledger-maintenance"
                    and isinstance(final_state, Mapping)
                    and final_state.get("Running") is False
                    and final_state.get("Status") == "exited"
                    and type(final_state.get("Pid")) is int and final_state.get("Pid") == 0
                )
                proof["cleanup"] = "eligible" if safe_to_remove else "retained-unverified-or-running"
                control.write(proof_path, proof)
                operation["receipt"]["ledger_helper_failure_observation"] = proof_path
                if safe_to_remove:
                    # Remove only the verified ephemeral container. No -v or
                    # force flag is used, so named volumes remain untouched.
                    docker_capture("rm", first_id, timeout=30)
                    operation["daemon_pending"] = False
                    proof["cleanup"] = "removed"
                    control.write(proof_path, proof)
            else:
                proof["cleanup"] = "retained-unverified-or-logs-unavailable"
                control.write(proof_path, proof)
                operation["receipt"]["ledger_helper_failure_observation"] = proof_path
        except BaseException as observation_error:
            proof["observation_error"] = str(observation_error)[:4096]
            try:
                control.write(proof_path, proof)
                operation["receipt"]["ledger_helper_failure_observation"] = proof_path
            except BaseException:
                pass
        raise
    operation["daemon_pending"] = False
    observed = json.loads(docker_text("inspect", name))
    if (len(observed) != 1 or observed[0].get("Image") != image
            or observed[0].get("State", {}).get("ExitCode") != 0
            or observed[0].get("State", {}).get("Running")
            or observed[0].get("Config", {}).get("Labels", {}).get("com.docker.compose.project") != control.project):
        raise BuildControlError("Host-ledger helper identity/outcome differs; resources retained")
    if publish_capacity and (
            observed[0].get("HostConfig", {}).get("CgroupnsMode") != "host"
            or observed[0].get("HostConfig", {}).get("PidMode") != "host"):
        raise BuildControlError("Host capacity helper did not use the host PID and cgroup namespaces")
    if hashlib.sha256(_session_host().read_owned_regular(helper, maximum=ledger.MAX_HELPER_BYTES)).hexdigest() != helper_hash:
        raise BuildControlError("Host-ledger helper changed during maintenance")
    host_receipt = ledger._parse_json_lines(output.decode(), ledger.HOST_RECEIPT_SCHEMA)
    ledger._validate_host_receipt(host_receipt, {"project_id": values["project_id"],
        "mount_root": values["mount_root"], "backing_image": env["FULLMAG_HOST_LEDGER_BACKING_IMAGE"]})
    control.write(operation["root"] + "/host-ledger.json", host_receipt)
    capacity_publication = None
    if publish_capacity:
        publication_schema = "fullmag.docker-host-capacity-publication.v1"
        capacity_publication = ledger._parse_json_lines(output.decode(), publication_schema)
        required_publication = {
            "schema", "descriptor_sha256", "descriptor_path", "descriptor",
            "project_id", "daemon_id_sha256",
        }
        descriptor_fields = {
            "schema", "scope", "project_id", "daemon_id_sha256", "boot_id",
            "allowed_cpu_ids", "cpu_max", "memory_max_bytes",
            "kernel_memory_total_bytes", "docker_cpu_count", "docker_memory_total_bytes",
        }
        if (not isinstance(capacity_publication, Mapping)
                or set(capacity_publication) != required_publication
                or capacity_publication.get("schema") != publication_schema):
            raise BuildControlError("Host capacity publication receipt is missing or malformed")
        descriptor = capacity_publication.get("descriptor")
        descriptor_sha = capacity_publication.get("descriptor_sha256")
        if (not isinstance(descriptor, Mapping) or set(descriptor) != descriptor_fields
                or not isinstance(descriptor_sha, str)
                or re.fullmatch(r"[0-9a-f]{64}", descriptor_sha) is None):
            raise BuildControlError("Host capacity descriptor fields or digest are invalid")
        descriptor_bytes = (json.dumps(
            dict(descriptor), sort_keys=True, separators=(",", ":"), allow_nan=False
        ) + "\n").encode("utf-8")
        expected_capacity_path = f"/host-ledger/capacity/{descriptor_sha}.json"
        if (hashlib.sha256(descriptor_bytes).hexdigest() != descriptor_sha
                or capacity_publication.get("descriptor_path") != expected_capacity_path
                or capacity_publication.get("project_id") != values["project_id"]
                or capacity_publication.get("daemon_id_sha256") != daemon["id_sha256"]
                or descriptor.get("schema") != "fullmag.docker-host-capacity.v1"
                or descriptor.get("scope") != "docker_vm_root"
                or descriptor.get("project_id") != values["project_id"]
                or descriptor.get("daemon_id_sha256") != daemon["id_sha256"]
                or descriptor.get("docker_cpu_count") != int(env["FULLMAG_HOST_LEDGER_DOCKER_CPU_COUNT"])
                or descriptor.get("docker_memory_total_bytes") != int(env["FULLMAG_HOST_LEDGER_DOCKER_MEMORY_TOTAL_BYTES"])):
            raise BuildControlError("Host capacity publication identity or digest differs")
        capacity_publication = dict(capacity_publication)
        if (prior_capacity_publication is not None
                and prior_capacity_publication != capacity_publication):
            raise BuildControlError("Retained host capacity publication changed during partial resume")
        control.write(operation["root"] + "/host-capacity-publication.json", capacity_publication)
        backend_environment = rendered["services"]["backend"].get("environment")
        if not isinstance(backend_environment, dict):
            raise BuildControlError("Rendered backend environment is not a mapping")
        if prior_backend_environment is not None:
            if (prior_backend_environment.get("FULLMAG_DOCKER_HOST_CAPACITY_PATH") != expected_capacity_path
                    or prior_backend_environment.get("FULLMAG_DOCKER_HOST_CAPACITY_SHA256") != descriptor_sha):
                raise BuildControlError("Retained backend capacity binding changed during partial resume")
        backend_environment["FULLMAG_DOCKER_HOST_CAPACITY_PATH"] = expected_capacity_path
        backend_environment["FULLMAG_DOCKER_HOST_CAPACITY_SHA256"] = descriptor_sha
        if migrate:
            backend_environment["FULLMAG_DOCKER_HOST_CAPACITY_MIGRATION_SHA256"] = descriptor_sha
    control.write(operation["root"] + "/ledger-helper-log.json",
                  {"log": docker_text("logs", name, combined=True)})
    docker_capture("rm", observed[0]["Id"])
    backend = rendered["services"]["backend"]
    profile = {"profile": ledger.PROFILE, "image_id": image, "environment": env,
        "mount_root": values["mount_root"], "project_id": values["project_id"],
        "backing_image": env["FULLMAG_HOST_LEDGER_BACKING_IMAGE"], "host_receipt": host_receipt,
        "maintenance_document": spec, "capacity_publication": capacity_publication}
    if os.name != "nt":
        descriptor = ledger.prepare_host_volume(profile, control.project, docker_text)
        _verify_host_ledger_volume(control, operation, descriptor, image)
        profile["daemon_volume"] = descriptor
        backend["volumes"] = [mount for mount in backend["volumes"]
                              if mount["target"] != ledger.MOUNT_TARGET] + [descriptor["mount"]]
        backend["x-fullmag-host-ledger-volume"] = descriptor
        control.write(operation["root"] + "/host-ledger-volume.json", descriptor)
    return backend, profile



def _startup_helper(control, selected, image, *, helper_source_binding=None):
    """Execute host admission code only when both helper bytes match the image."""
    import fullmag_docker_runtime as runtime
    import docker_helper_source as helper_source
    names = ("docker_startup_script.py", "fullmag_storage.py")
    if helper_source_binding is None and callable(getattr(control, "read", None)):
        current = control.read("development/current.json", optional=True)
        current_inputs = current.get("inputs") if isinstance(current, Mapping) else None
        if isinstance(current_inputs, Mapping):
            helper_source_binding = current_inputs.get("helper_source")
    if helper_source_binding is not None:
        try:
            image_documents = json.loads(docker_capture("image", "inspect", image).stdout)
        except Exception as error:
            raise BuildControlError("Pinned image startup-helper identity is unavailable") from error
        if (not isinstance(image_documents, list) or len(image_documents) != 1
                or image_documents[0].get("Id") != image):
            raise BuildControlError("Pinned image startup-helper identity is not the exact immutable image")
        labels = image_documents[0].get("Config", {}).get("Labels", {})
        try:
            expected_hashes = helper_source.startup_hashes_from_image_labels(
                labels, helper_source_binding
            )
        except helper_source.HelperSourceError as error:
            raise BuildControlError("Image startup-helper pin validation failed: " + str(error)) from error
        verified = {}
        for name in names:
            path = "/opt/fullmag/" + name
            script = (
                "import base64,os,stat,sys\n"
                "path=sys.argv[1]\n"
                "fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)\n"
                "metadata=os.fstat(fd)\n"
                "if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 4194304:\n"
                " raise RuntimeError('startup helper is not a bounded regular file')\n"
                "data=bytearray()\n"
                "while True:\n"
                " chunk=os.read(fd,65536)\n"
                " if not chunk: break\n"
                " data.extend(chunk)\n"
                " if len(data)>4194304: raise RuntimeError('startup helper exceeds size bound')\n"
                "os.close(fd)\n"
                "print(base64.b64encode(data).decode('ascii'))\n"
            )
            command = "/usr/local/bin/python3 -B -c " + shlex.quote(script) + " " + shlex.quote(path)
            arguments = control.helper_args(command)
            try:
                arguments[arguments.index(control.image)] = image
            except (ValueError, AttributeError) as error:
                raise BuildControlError("Image startup-helper reader is not bound to its immutable image") from error
            result = bounded_capture(arguments, data=b"", timeout=90)
            if result.returncode:
                raise BuildControlError("Pinned image startup-helper read failed: " + name)
            try:
                data = base64.b64decode(result.stdout.strip(), validate=True)
            except (ValueError, TypeError) as error:
                raise BuildControlError("Pinned image startup-helper output is malformed: " + name) from error
            if (len(data) > 4 * 1024 * 1024
                    or hashlib.sha256(data).hexdigest() != expected_hashes[name]):
                raise BuildControlError("Pinned image startup-helper bytes differ from their image labels: " + name)
            verified[name] = (Path(path), data)
        return runtime._exec_verified_startup_helpers(verified), expected_hashes
    command = "sha256sum " + " ".join("/opt/fullmag/" + name for name in names)
    arguments = control.helper_args(command)
    arguments[arguments.index(control.image)] = image
    result = bounded_capture(arguments, data=b"", timeout=90)
    if result.returncode:
        raise BuildControlError("Image startup-helper attestation failed")
    hashes = {}
    for line in result.stdout.decode().splitlines():
        digest, path = line.split()
        if not re.fullmatch(r"[0-9a-f]{64}", digest) or path not in {"/opt/fullmag/" + name for name in names}:
            raise BuildControlError("Image startup-helper inventory differs")
        hashes[PurePosixPath(path).name] = digest
    if set(hashes) != set(names):
        raise BuildControlError("Image startup-helper inventory is incomplete")
    verified = {}
    for name in names:
        path = selected / "scripts" / name
        data, matches, _ = runtime._verified_startup_helper(path, hashes[name])
        if not matches:
            raise BuildControlError("Startup helper changed since image preparation: " + name)
        verified[name] = (path, data)
    return runtime._exec_verified_startup_helpers(verified), hashes


def _operator_probe_record(values):
    """Return the bounded operator controls with their canonical digest."""

    from docker_dev import (
        OPERATOR_PROBE_ENVIRONMENT_SCHEMA,
        _normalize_operator_probe_environment,
        _operator_probe_environment_sha256,
    )

    try:
        normalized = _normalize_operator_probe_environment(values)
        digest = _operator_probe_environment_sha256(normalized)
    except Exception as error:
        raise BuildControlError(f"Invalid operator probe environment: {error}") from error
    return {
        "operator_probe_environment_schema": OPERATOR_PROBE_ENVIRONMENT_SCHEMA,
        "operator_probe_environment": dict(normalized),
        "operator_probe_environment_sha256": digest,
    }


def _operator_probe_record_from_fields(fields, *, label):
    """Validate a previously frozen record; never replace it from host env."""

    from docker_dev import (
        OPERATOR_PROBE_ENVIRONMENT_SCHEMA,
        _normalize_operator_probe_environment,
        _operator_probe_environment_sha256,
    )

    if not isinstance(fields, Mapping):
        raise BuildControlError(f"{label} has no operator probe environment record")
    if fields.get("operator_probe_environment_schema") != OPERATOR_PROBE_ENVIRONMENT_SCHEMA:
        raise BuildControlError(f"{label} has an unsupported operator probe environment schema")
    values = fields.get("operator_probe_environment")
    try:
        normalized = _normalize_operator_probe_environment(values)
        digest = _operator_probe_environment_sha256(normalized)
    except Exception as error:
        raise BuildControlError(f"{label} has an invalid operator probe environment: {error}") from error
    if fields.get("operator_probe_environment_sha256") != digest:
        raise BuildControlError(f"{label} operator probe environment digest does not match its values")
    return {
        "operator_probe_environment_schema": OPERATOR_PROBE_ENVIRONMENT_SCHEMA,
        "operator_probe_environment": dict(normalized),
        "operator_probe_environment_sha256": digest,
    }


def _operator_probe_record_from_retained(previous, document):
    """Recover the exact controls from the retained Compose record and verify mounts."""

    record = _operator_probe_record_from_fields(previous, label="retained operation")
    backend = document.get("services", {}).get("backend", {})
    environment = backend.get("environment", {})
    if not isinstance(environment, Mapping):
        raise BuildControlError("retained backend environment is malformed")
    values = record["operator_probe_environment"]
    if any(environment.get(name) != value for name, value in values.items()):
        raise BuildControlError("retained backend operator probe environment differs from its receipt")
    if environment.get("FULLMAG_OPERATOR_PROBE_ENVIRONMENT_SHA256") != record["operator_probe_environment_sha256"]:
        raise BuildControlError("retained backend operator probe digest differs from its receipt")
    if environment.get("FULLMAG_DEVELOPMENT_INPUTS_PATH") != (
        "/opt/fullmag/control/frontend/development-inputs.json"
    ):
        raise BuildControlError("retained backend development-inputs path differs from its full control volume")
    frontend = document.get("services", {}).get("frontend", {})
    frontend_environment = frontend.get("environment", {})
    control_namespace = _control_namespace_from_document(document)
    if environment.get("FULLMAG_CONTROL_NAMESPACE", "") != control_namespace:
        raise BuildControlError("retained backend control namespace differs from its Compose marker")
    if frontend_environment.get("FULLMAG_DEVELOPMENT_INPUTS_PATH") != (
        "/opt/fullmag/control/development-inputs.json"
    ):
        raise BuildControlError("retained frontend uses an unrestricted development-inputs path")
    frontend_control_mounts = [
        mount for mount in frontend.get("volumes", [])
        if mount.get("source") == "build-control"
        and mount.get("target") == "/opt/fullmag/control"
    ]
    expected_frontend_subpath = _control_mount_subpath(control_namespace, "frontend")
    if (len(frontend_control_mounts) != 1
            or frontend_control_mounts[0].get("volume", {}).get("subpath") != expected_frontend_subpath):
        raise BuildControlError("retained frontend does not use the restricted control-volume subpath")
    return record


def _reassert_operator_probe_environment(document, record):
    """Reapply the frozen controls after every Compose/cache environment overlay."""

    backend = document["services"]["backend"]
    backend_environment = backend["environment"]
    if not isinstance(backend_environment, dict):
        raise BuildControlError("DEV backend environment is malformed")
    backend_environment.update(record["operator_probe_environment"])
    backend_environment["FULLMAG_OPERATOR_PROBE_ENVIRONMENT_SHA256"] = record[
        "operator_probe_environment_sha256"
    ]
    backend_environment["FULLMAG_DEVELOPMENT_INPUTS_PATH"] = (
        "/opt/fullmag/control/frontend/development-inputs.json"
    )
    if any(backend_environment.get(name) != value
           for name, value in record["operator_probe_environment"].items()):
        raise BuildControlError("DEV backend operator probe environment was not reasserted")
    if backend_environment.get("FULLMAG_OPERATOR_PROBE_ENVIRONMENT_SHA256") != record[
        "operator_probe_environment_sha256"
    ]:
        raise BuildControlError("DEV backend operator probe digest was not reasserted")

    # The frontend sees only the `frontend` subpath of build-control.  Its
    # manifest path is therefore relative to that restricted mount; backend
    # keeps the full-volume path used during Compose interpolation.
    frontend_environment = document["services"]["frontend"]["environment"]
    if not isinstance(frontend_environment, dict):
        raise BuildControlError("DEV frontend environment is malformed")
    frontend_environment["FULLMAG_DEVELOPMENT_INPUTS_PATH"] = (
        "/opt/fullmag/control/development-inputs.json"
    )


def _control_mount_subpath(namespace, relative=""):
    if not isinstance(namespace, str) or (namespace and _CONTROL_NAMESPACE.fullmatch(namespace) is None):
        raise BuildControlError("control namespace must be empty or namespaces/<32 lowercase hexadecimal characters>")
    if not relative:
        return namespace
    if (not isinstance(relative, str) or relative.startswith("/") or "\\" in relative
            or any(part in {"", ".", ".."} for part in relative.split("/"))):
        raise BuildControlError("control mount relative path is not canonical")
    return f"{namespace}/{relative}" if namespace else relative


def _resolved_control_subpath(control, relative=""):
    expected = _control_mount_subpath(control.namespace, relative)
    actual = control.subpath(relative)
    if not relative and not expected and actual in {None, ""}:
        return ""
    if actual != expected:
        raise BuildControlError("control namespace subpath resolver returned a different path")
    return actual


def _control_namespace_from_document(document):
    if not isinstance(document, Mapping):
        raise BuildControlError("retained Compose document is malformed")
    if "x-fullmag-control-namespace" not in document:
        namespace = ""
    else:
        namespace = document.get("x-fullmag-control-namespace")
    if not isinstance(namespace, str) or (namespace and _CONTROL_NAMESPACE.fullmatch(namespace) is None):
        raise BuildControlError("retained Compose control namespace is malformed")
    return namespace


def _prefix_runtime_control_mounts(control, backend):
    targets = {
        "/opt/fullmag/runtime-control": "runtime-control",
        "/state/runs/docker-all/session-store/runtime-services": "runtime-control/runtime-services",
    }
    for target, relative in targets.items():
        matches = [mount for mount in backend.get("volumes", [])
                   if isinstance(mount, Mapping) and mount.get("target") == target]
        if len(matches) != 1:
            raise BuildControlError("backend control namespace mount is missing or ambiguous: " + target)
        mount = matches[0]
        if mount.get("type") != "volume":
            raise BuildControlError("backend control namespace mount is not a named volume: " + target)
        volume = mount.get("volume")
        if not isinstance(volume, dict):
            raise BuildControlError("backend control namespace volume options are malformed: " + target)
        subpath = _resolved_control_subpath(control, relative)
        if subpath:
            volume["subpath"] = subpath
        else:
            volume.pop("subpath", None)


def _start_compose_services(control, operation, document):
    # Reject invalid declarations before crossing the daemon-mutation boundary.
    configured = json.loads(compose_capture(document, "config", "--format", "json", timeout=60))
    if configured.get("name") != control.project or set(configured.get("services", {})) != {"backend", "frontend"}:
        raise BuildControlError("DEV Compose preflight changed the selected group or services")
    if operation["receipt"].get("host_capacity_migration") is True:
        _assert_host_capacity_migration_quiescent()
    operation["receipt"]["compose_preflight"] = "PASS"
    operation["daemon_pending"] = True
    compose_capture(document, "up", "--detach", "--no-build", "--pull", "never", timeout=180)
    operation["daemon_pending"] = False


def _assert_new_windows_runtime_path(path, state):
    """Reject reparse points while inspecting a fresh Windows state tree."""

    path = Path(path)
    state = Path(state)
    current = path
    while True:
        if os.path.lexists(current) and storage.is_link(current):
            raise BuildControlError(
                "New Windows runtime state traverses a reparse point: " + str(current)
            )
        if current == state:
            return
        if current.parent == current or state not in current.parents:
            raise BuildControlError("Windows runtime state path escaped its new state root")
        current = current.parent


def _probe_new_windows_runtime_directory(directory):
    """Prove that the native Windows user can write the final runtime directory."""

    directory = Path(directory)
    if not os.access(directory, os.W_OK | os.X_OK):
        raise BuildControlError("New Windows runtime directory is not writable: " + str(directory))
    probe = directory / (
        ".fullmag-runtime-state-write-probe-"
        + str(os.getpid())
        + "-"
        + str(time.monotonic_ns())
    )
    descriptor = None
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(probe, flags, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = None
            stream.write(b"fullmag-runtime-state-preflight\n")
            stream.flush()
            os.fsync(stream.fileno())
        if storage.is_link(probe):
            raise BuildControlError("Runtime write probe became a reparse point")
        probe.unlink()
    except BuildControlError:
        raise
    except (OSError, ValueError) as error:
        raise BuildControlError(
            "New Windows runtime directory failed the write probe: " + str(directory)
        ) from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if os.path.lexists(probe) and not storage.is_link(probe):
            try:
                probe.unlink()
            except OSError:
                pass
    if os.path.lexists(probe):
        raise BuildControlError("Runtime write probe was not removed safely")


def _precreate_new_windows_runtime_state(state):
    """Prepare the exact runtime namespace before Docker can create it as root.

    This is intentionally limited to a freshly-created state root. Existing
    entries are rejected rather than adopted, repaired, or recursively
    permission-changed. Build data remains in Docker volumes.
    """

    if sys.platform != "win32":
        raise BuildControlError("Windows runtime state must be prepared by native Windows")
    state = Path(state)
    if storage.is_link(state) or not state.is_dir():
        raise BuildControlError("New Windows runtime state root is missing or a reparse point")

    for relative in _NEW_WINDOWS_RUNTIME_STATE_DIRECTORIES:
        target = state / relative
        _assert_new_windows_runtime_path(target, state)
        if os.path.lexists(target):
            raise BuildControlError(
                "New Windows runtime state already contains " + relative.as_posix()
            )

    for relative in _NEW_WINDOWS_RUNTIME_STATE_DIRECTORIES:
        target = state / relative
        try:
            target.mkdir()
        except OSError as error:
            raise BuildControlError(
                "New Windows runtime state directory could not be created: " + str(target)
            ) from error
        _assert_new_windows_runtime_path(target, state)
        if not target.is_dir():
            raise BuildControlError("Windows runtime state entry is not a directory: " + str(target))

    _probe_new_windows_runtime_directory(
        state / _NEW_WINDOWS_RUNTIME_STATE_DIRECTORIES[-1]
    )
    return tuple(relative.as_posix() for relative in _NEW_WINDOWS_RUNTIME_STATE_DIRECTORIES)


def _retained_device_access(previous, document):
    """Bind resolved CPU/GPU access to the retained receipt and Compose render."""
    inputs = previous.get("inputs")
    services = document.get("services")
    backend = services.get("backend") if isinstance(services, Mapping) else None
    environment = backend.get("environment") if isinstance(backend, Mapping) else None
    if not isinstance(inputs, Mapping) or not isinstance(environment, Mapping):
        raise BuildControlError("Retained device access has no receipt/Compose binding")
    policy = inputs.get("gpu_access_requested")
    access = inputs.get("device_access")
    if (policy not in ("auto", "required", "disabled") or access not in ("cpu", "gpu")
            or (policy == "required" and access != "gpu")
            or (policy == "disabled" and access != "cpu")
            or environment.get("FULLMAG_DOCKER_DEVICE_ACCESS") != access
            or inputs.get("gpu_preflight") != ("PASS" if access == "gpu" else "NOT_REQUIRED")
            or bool(backend.get("gpus")) != (access == "gpu")):
        raise BuildControlError("Retained resolved device access differs from its receipt/Compose proof")
    return access


def _probe_retained_device_access(device_access, image, project):
    """A retained profile cannot gain or lose GPU access during recreation."""
    from docker_dev import _resolve_gpu_access, _verify_docker_gpu_access
    if device_access not in ("cpu", "gpu"):
        raise BuildControlError("Retained device access must be cpu or gpu")
    if device_access == "cpu":
        return "cpu"
    resolved = _verify_docker_gpu_access(_resolve_gpu_access("required"), "required", image, project)
    if resolved != device_access:
        raise BuildControlError("Current Docker GPU access differs from the retained device profile")
    return resolved


def _validate_cancellation_maintenance(value):
    if value is None:
        return None
    if not isinstance(value, Mapping) or set(value) != {"request_id", "request_sha256", "request_path"}:
        raise BuildControlError("Cancellation maintenance has an unsupported shape")
    import uuid
    request_id = value["request_id"]
    try:
        parsed = uuid.UUID(request_id)
    except (ValueError, TypeError, AttributeError) as error:
        raise BuildControlError("Cancellation maintenance request ID is invalid") from error
    if parsed.int == 0 or str(parsed) != request_id:
        raise BuildControlError("Cancellation maintenance request ID is not canonical")
    if not isinstance(value["request_sha256"], str) or not _SHA256.fullmatch(value["request_sha256"]):
        raise BuildControlError("Cancellation maintenance request SHA is invalid")
    expected = "/opt/fullmag/control/backend/runtime-service/unclaimed-cancellation/requests/" + request_id + ".json"
    if value["request_path"] != expected:
        raise BuildControlError("Cancellation maintenance request path differs from its identity")
    return dict(value)


def start(args, *, reuse_state=None, control=None, operation=None, prepared=None,
          recovery_environment=None, recovery_metadata=None, previous_config_sha256=None,
          native_restart_metadata=None, accepted_reattach_environment=None,
          accepted_reattach_metadata=None, recreation_resume_proof=None,
          post_build_generation=None, retained_device_access=None, maintenance=None,
          startup_diagnostic_restart=None, terminal_observation=None, helper_source_binding=None):
    from docker_dev import (_select_source, _compose_identity,
        _assert_no_running_fullmag, _source_git_common_directory, _workspace_state_root,
        _operator_probe_environment_from_host)
    import fullmag_docker_runtime as runtime
    provided_control = control
    provided_operation = operation
    if retained_device_access is not None and retained_device_access not in ("cpu", "gpu"):
        raise BuildControlError("Retained device access must be cpu or gpu")
    retained_helper_source_binding = (
        reuse_state.get("helper_source_binding")
        if isinstance(reuse_state, Mapping) else None
    )
    if helper_source_binding is None:
        helper_source_binding = retained_helper_source_binding
    elif (retained_helper_source_binding is not None
          and retained_helper_source_binding != helper_source_binding):
        raise BuildControlError("Retained helper-source pin differs from the requested recreation")
    if (getattr(args, "helper_source_root", None) is not None
            or getattr(args, "helper_source_commit", None) is not None):
        if helper_source_binding is None:
            raise BuildControlError("Helper-source pins are supported only through managed recreation")
    if helper_source_binding is not None:
        _revalidate_helper_source_binding(helper_source_binding, getattr(args, "source_root", None))
    maintenance = _validate_cancellation_maintenance(maintenance)
    from docker_volume_terminal_observation import validate_context
    terminal_observation = validate_context(terminal_observation)
    if terminal_observation is not None and (reuse_state is None or args.script is not None
            or any(value is not None for value in (maintenance, accepted_reattach_environment,
                accepted_reattach_metadata, startup_diagnostic_restart, recreation_resume_proof,
                post_build_generation))):
        raise BuildControlError("Terminal observation requires retained storage without activation or another restore")
    if maintenance is not None:
        if (provided_operation is None or reuse_state is None or args.script is not None
                or any(value is not None for value in (
                    recovery_environment, recovery_metadata, native_restart_metadata,
                    accepted_reattach_environment, accepted_reattach_metadata,
                    recreation_resume_proof, post_build_generation, startup_diagnostic_restart))):
            raise BuildControlError("Cancellation maintenance requires its owned operation and retained store, without runtime activation")
    if (provided_control is None) != (provided_operation is None):
        raise BuildControlError("Recovery start requires both control and operation")
    if recreation_resume_proof is not None and (reuse_state is None or provided_operation is not None):
        raise BuildControlError("Recreation resume requires the retained state and a new managed start")
    validated_recovery_environment = _validate_recovery_environment(recovery_environment)
    validated_recovery_metadata = _validate_recovery_metadata(recovery_metadata)
    validated_native_restart_metadata = _validate_recovery_metadata(native_restart_metadata)
    validated_startup_diagnostic_restart = None
    if startup_diagnostic_restart is not None:
        from docker_volume_startup_diagnostic_restart import validate_metadata
        validated_startup_diagnostic_restart = validate_metadata(startup_diagnostic_restart)
        if (reuse_state is None or args.script is not None
                or any(value is not None for value in (recovery_environment, recovery_metadata,
                    native_restart_metadata, post_build_generation, accepted_reattach_metadata,
                    accepted_reattach_environment))):
            raise BuildControlError("Startup diagnostic restart requires the same store without activation or other recovery")
        if (recreation_resume_proof is None
                and not getattr(args, "completed_recreation_attempt", None)):
            raise BuildControlError("Startup diagnostic restart requires an authenticated completed recreation")
        if previous_config_sha256 != validated_startup_diagnostic_restart["runtime_config_sha256"]:
            raise BuildControlError("Startup diagnostic restart runtime configuration differs")
    validated_post_build_generation = None
    if post_build_generation is not None:
        from docker_volume_post_build_generation import validate_continuation_metadata
        try:
            validated_post_build_generation = validate_continuation_metadata(post_build_generation)
        except BuildControlError as error:
            raise BuildControlError("Post-build continuation metadata is invalid: " + str(error)) from error
        if reuse_state is None:
            raise BuildControlError("Post-build continuation requires retained session storage")
    validated_accepted_reattach_environment = _validate_accepted_reattach_environment(
        accepted_reattach_environment
    )
    validated_accepted_reattach_metadata = _validate_accepted_reattach_metadata(
        accepted_reattach_metadata, validated_accepted_reattach_environment
    )
    if previous_config_sha256 is not None and _SHA256.fullmatch(str(previous_config_sha256)) is None:
        raise BuildControlError("Previous runtime configuration digest is not a lowercase SHA-256")
    require_host()
    host = _session_host()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root or args.repo_root)
    _revalidate_helper_source_binding(helper_source_binding, selected)
    validate_host_path(selected, "source checkout")
    local_volume(Path(layout["storage_root"]))
    identity = _compose_identity(layout)
    if validated_post_build_generation is not None:
        if (validated_post_build_generation["compose_project"] != identity["project_name"]
                or validated_post_build_generation["source_root"] != str(selected)):
            raise BuildControlError("Post-build continuation source or Compose identity differs")
        if previous_config_sha256 != validated_post_build_generation["runtime_config"]["sha256"]:
            raise BuildControlError("Post-build continuation config digest differs from its start pin")
    admission_context = {}
    if provided_operation is not None:
        _validate_existing_development_operation(provided_control, provided_operation, selected, identity)
        held = provided_operation["receipt"]
        admission_context["owned_control"] = {
            "name": held["helper_container"],
            "attempt": held["attempt"],
            "image": provided_control.image,
            "volume": provided_control.volume,
            "namespace": provided_control.namespace,
        }
    _assert_no_running_fullmag(identity["project_name"], identity, **admission_context)
    if (getattr(args, "migrate_host_capacity", False)
            or (provided_operation is not None
                and provided_operation["receipt"].get("host_capacity_migration") is True)):
        _assert_host_capacity_migration_quiescent()
    if provided_operation is None and reuse_state is None and not getattr(args, "port_explicit", True):
        # A configured or default port is a preference for a new group.  Every
        # later start of this group reuses the port its document pins.
        preferred = args.port
        args.port = runtime.select_loopback_port(preferred, identity["project_name"])
        if args.port != preferred:
            print(f"Port {preferred} is taken; group {identity['project_name']} uses {args.port}",
                  file=sys.stderr)
    runtime.assert_loopback_port_available(args.port, identity["project_name"])
    if args.profile != "dev":
        raise BuildControlError("Volume DEV supports backend-dev; release uses its explicit managed recipe")
    include_untracked = normalize_include_untracked_paths(
        getattr(args, "include_untracked", None)
    )
    if args.image or args.toolchain_image or args.source_manifest:
        raise BuildControlError("Volume DEV requires its attested dependency/image route; explicit overrides are not qualified")
    # Freeze the bounded operator controls before any toolchain/image/cache
    # preparation.  A service recreation reuses the exact prior record rather
    # than rereading ambient host variables.
    if reuse_state is None:
        operator_probe_record = _operator_probe_record(_operator_probe_environment_from_host())
    else:
        operator_probe_record = _operator_probe_record_from_fields(
            reuse_state.get("operator_probe_environment_record"), label="service recreation"
        )
    from docker_dev import _resolve_gpu_access, _verify_docker_gpu_access
    policy = getattr(args, "gpu_access", None) or "auto"
    if retained_device_access is not None and (
            policy not in ("auto", "required", "disabled")
            or (policy == "required" and retained_device_access != "gpu")
            or (policy == "disabled" and retained_device_access != "cpu")):
        raise BuildControlError("Retained device access differs from the requested GPU policy")
    device_access = _resolve_gpu_access(policy) if retained_device_access is None else retained_device_access
    if provided_operation is None:
        toolchain = build_volume_toolchain(selected)
        control = BuildControl(identity, toolchain["inputs"]["build_args"]["FULLMAG_CUDA_BASE_IMAGE"])
        helper_repo = Path(helper_source_binding["root"]) if helper_source_binding is not None else selected
        _revalidate_helper_source_binding(helper_source_binding, selected)
        if helper_source_binding is None:
            images = build_volume_runtime_images(helper_repo, control, toolchain)
        else:
            images = build_volume_runtime_images(
                helper_repo, control, toolchain, helper_source_binding=helper_source_binding
            )
    else:
        control = provided_control
        toolchain, images = _validate_prepared_start_context(prepared)
    snapshot = _active_isolated_snapshot(control)
    if snapshot is not None and (snapshot["source_root"] != str(selected) or args.script is not None
          or getattr(args, "fresh_state", False)):
        raise BuildControlError("Isolated snapshot start must preserve its source and cannot replay a script")
    from docker_volume_cancelled_activation_guard import assert_start_allowed
    assert_start_allowed(control, getattr(args, "request_id", None), reuse_state=reuse_state)
    image = images["backend"]["image_id"]
    if retained_device_access is None:
        device_access = _verify_docker_gpu_access(device_access, policy, image, control.project)
    else:
        device_access = _probe_retained_device_access(retained_device_access, image, control.project)
    _assert_no_running_fullmag(control.project, identity, **admission_context)
    if recreation_resume_proof is not None:
        if args.script is not None or getattr(args, "fresh_state", False):
            raise BuildControlError("Recreation resume cannot change startup-script or session-state intent")
        _validate_recreation_resume_records(
            args, control, selected, identity, expected_proof=recreation_resume_proof,
            helper_source_binding=helper_source_binding,
        )
    if args.script is not None:
        if validated_accepted_reattach_environment:
            raise BuildControlError(
                "Accepted-run reattach cannot be combined with a new startup script"
            )
        # ``start --script`` enables the image entrypoint's startup POST after
        # Compose starts.  Apply the same durable unknown-activation quarantine
        # used by the explicit activation command before creating provenance
        # or admitting a new RunIntent.
        from docker_volume_activation_reconcile import assert_no_unresolved_activation
        assert_no_unresolved_activation(control)
    operation_inputs = {"source_root": str(selected), "image_id": image,
        "source_project_id": identity["project_id"],
        "source_worktree_id": identity["worktree_id"],
        "source_checkout_kind": identity["checkout_kind"],
        "gpu_access_requested": policy, "device_access": device_access,
        "gpu_preflight": "PASS" if device_access == "gpu" else "NOT_REQUIRED",
        **operator_probe_record}
    if getattr(args, "completed_recreation_attempt", None):
        operation_inputs["completed_recreation"] = {
            "attempt": args.completed_recreation_attempt,
            "terminal_sha256": args.completed_recreation_sha256,
        }
    if helper_source_binding is not None:
        operation_inputs["helper_source"] = helper_source_binding
    if previous_config_sha256 is not None:
        operation_inputs["previous_config_sha256"] = previous_config_sha256
    if maintenance is not None:
        operation_inputs["unclaimed_cancellation"] = maintenance
    if validated_native_restart_metadata is not None:
        operation_inputs["native_failed_restart"] = validated_native_restart_metadata
    if validated_accepted_reattach_metadata is not None:
        operation_inputs["accepted_reattach"] = validated_accepted_reattach_metadata
    if terminal_observation is not None:
        operation_inputs["terminal_observation"] = terminal_observation["metadata"]
    if validated_startup_diagnostic_restart is not None:
        operation_inputs["startup_diagnostic_restart"] = validated_startup_diagnostic_restart
    if validated_post_build_generation is not None:
        operation_inputs["post_build_generation"] = validated_post_build_generation
    if recreation_resume_proof is not None:
        operation_inputs["recreation_resume"] = {
            key: recreation_resume_proof[key]
            for key in (
                "recreation_operation_id", "recreation_terminal_sha256",
                "retained_snapshot_sha256", "prior_terminal_sha256", "prior_compose_sha256",
            )
        }
        operation_inputs["recreation_resume"]["proof_sha256"] = hashlib.sha256(
            canonical(recreation_resume_proof)
        ).hexdigest()
    if provided_operation is not None:
        _validate_existing_operation_inputs(provided_operation.get("receipt", {}), operation_inputs)
    operation_context = (control.operation("development", operation_inputs)
                         if provided_operation is None
                         else nullcontext(provided_operation))
    with operation_context as operation:
        if validated_startup_diagnostic_restart is not None and recreation_resume_proof is not None:
            leased_records = _validate_recreation_resume_records(
                args, control, selected, identity, expected_proof=recreation_resume_proof,
                current_operation=operation, helper_source_binding=helper_source_binding,
            )
            if leased_records["native_recovery_context"].get("startup_diagnostic_restart") != validated_startup_diagnostic_restart:
                raise BuildControlError("Startup diagnostic recreation resume changed under start lease")
        if getattr(args, "completed_recreation_attempt", None):
            # Recheck the exact completed transition under the new development
            # lease before any state/cache/admission write or service creation.
            current = _completed_recreation_start_context(control, args, selected, layout)
            expected = {"previous_config_sha256": previous_config_sha256,
                        "retained_device_access": retained_device_access}
            if validated_startup_diagnostic_restart is not None:
                expected["startup_diagnostic_restart"] = validated_startup_diagnostic_restart
            else:
                expected["native_restart_metadata"] = validated_native_restart_metadata
            if (current.pop("reuse_state") != reuse_state or current != expected):
                raise BuildControlError("Completed recreation handoff changed before start")
        operation["receipt"].update(operator_probe_record)
        if helper_source_binding is not None:
            operation["receipt"]["helper_source"] = helper_source_binding
        if maintenance is not None:
            operation["receipt"]["unclaimed_cancellation"] = maintenance
        if validated_recovery_metadata is not None:
            operation["receipt"]["container_recovery"] = validated_recovery_metadata
        if validated_recovery_environment:
            operation["receipt"]["container_recovery_environment"] = sorted(
                validated_recovery_environment
            )
        if validated_startup_diagnostic_restart is not None:
            operation["receipt"]["startup_diagnostic_restart"] = validated_startup_diagnostic_restart
        if validated_accepted_reattach_metadata is not None:
            operation["receipt"]["accepted_reattach"] = validated_accepted_reattach_metadata
        if terminal_observation is not None:
            operation["receipt"]["terminal_observation"] = terminal_observation["metadata"]
        if validated_post_build_generation is not None:
            operation["receipt"]["post_build_generation"] = validated_post_build_generation
        token = operation["receipt"]["attempt"]
        post_build_start_binding = None
        if validated_post_build_generation is not None:
            from docker_volume_post_build_generation import prepare_start_binding
            try:
                post_build_start_binding = prepare_start_binding(
                    validated_post_build_generation, operation
                )
            except BuildControlError as error:
                raise BuildControlError("Post-build continuation start binding is invalid: " + str(error)) from error
            control.write(
                post_build_start_binding["relative"],
                post_build_start_binding["record"],
            )
            operation["receipt"]["post_build_start"] = post_build_start_binding["receipt"]
            # The runtime guard authenticates the active marker and this exact
            # receipt before it consumes the old configuration digest.
            control.write(operation["root"] + "/receipt.json", operation["receipt"])
        if reuse_state is None:
            if snapshot is not None:
                if os.name == "nt":
                    raise BuildControlError("Initial isolated snapshot admission requires Linux")
                state = storage.validate_path(Path(snapshot["destination_state_root"]),
                                              layout["runtime_root"], "isolated session storage")
                if not state.is_dir() or state.resolve(strict=True) != state:
                    raise BuildControlError("Copied session state is missing or noncanonical")
            else:
                state = storage.validate_path(Path(layout["runtime_root"]) / "docker-volume-dev" / token,
                                              layout["storage_root"], "session storage")
                state.mkdir(parents=True, exist_ok=False)
            if os.name == "nt":
                operation["receipt"]["windows_runtime_directories"] = list(
                    _precreate_new_windows_runtime_state(state)
                )
                operation["receipt"]["windows_runtime_write_probe"] = "PASS"
            elif snapshot is None:
                operation["receipt"]["linux_runtime_directories"] = list(
                    host.prepare_runtime_directories(state)
                )
            else:
                operation["receipt"]["isolated_snapshot"] = {
                    "recovery_id": snapshot["recovery_id"],
                    "source_manifest_sha256": snapshot["source_manifest_sha256"],
                }
            certificate_path = _certificate_path(state)
            if snapshot is not None:
                _snapshot_certificate_placeholder(control, state, certificate_path, snapshot)
            else:
                certificate_path.touch(exist_ok=False)
        else:
            try:
                state = storage.validate_path(
                    Path(reuse_state["state"]),
                    Path(layout["runtime_root"]),
                    "retained Windows sessions",
                )
                certificate_path = storage.validate_path(
                    Path(reuse_state["host_certificate"]),
                    state,
                    "retained Windows session certificate",
                )
                owner_marker = storage.validate_path(
                    Path(reuse_state["owner_marker"]),
                    state,
                    "retained Windows session owner marker",
                )
            except (KeyError, TypeError, ValueError, storage.StorageError) as error:
                raise BuildControlError(
                    "Retained Windows session paths are outside the selected runtime root"
                ) from error
            reuse_state = dict(reuse_state)
            reuse_state["state"] = state
            reuse_state["host_certificate"] = certificate_path
            reuse_state["owner_marker"] = owner_marker
        operation["receipt"]["state_root"] = str(state)
        if validated_post_build_generation is not None:
            # BuildKit has already completed and the new development lease is
            # held.  Re-read the durable failed-owner/recreation proof and the
            # mutable runtime controls before certificate rotation or cache/
            # ledger allocation.  A stale proof must leave retained admission
            # evidence untouched.  A prior controlled start may already have
            # rotated image/source fields; compare the closed host identity.
            from docker_volume_post_build_generation import (
                certificate_stable_identity,
                validate_post_build_lease_evidence,
            )
            accepted_context_for_post_build = None
            if validated_accepted_reattach_metadata is not None:
                accepted_context_for_post_build = {
                    "accepted_reattach_metadata": validated_accepted_reattach_metadata,
                    "accepted_reattach_environment": validated_accepted_reattach_environment,
                }
            current_certificate = json.loads(host.read_owned_regular(certificate_path))
            current_certificate_evidence = _post_build_certificate_evidence(
                state, current_certificate
            )
            try:
                _assert_post_build_removed_namespace_absent(validated_post_build_generation)
                validate_post_build_lease_evidence(
                    control,
                    validated_post_build_generation,
                    certificate_evidence=current_certificate_evidence,
                    accepted_context=accepted_context_for_post_build,
                    runtime_config_sha256=_read_runtime_config_digest(control),
                )
            except BuildControlError as error:
                raise BuildControlError(
                    "Post-build continuation changed under the new development lease: " + str(error)
                ) from error
        local_volume(state)
        cache = _backend_cache(control, operation, layout, selected, image, toolchain["image_id"])
        operation["receipt"]["backend_volumes"] = cache["volume_names"]
        frontend_inputs, frontend_volume = _frontend(control, operation, selected, state, args.port, image)
        if _uses_group_ledger(control, operation, new_render=provided_operation is None):
            if getattr(args, "migrate_host_capacity", False):
                raise BuildControlError(
                    "A DEV group ledger has no host capacity migration; its budget is the group's own")
            ledger_backend, ledger_profile = _group_ledger(
                control, operation, image, new_render=provided_operation is None)
        else:
            ledger_backend, ledger_profile = _host_ledger(
                control, operation, layout, selected, image, new_render=provided_operation is None,
                migrate_capacity=bool(getattr(args, "migrate_host_capacity", False)),
            )
        inputs = {"image_id": image, "toolchain_image_id": toolchain["image_id"],
                  "guest_provenance_path": "/opt/fullmag/control/backend/runtime-provenance.json"}
        provisional, hashes, delegation = runtime._provisional_development_certificate(inputs, identity)
        provisional["binary_hashes"] = hashes
        engine_id = docker_text("info", "--format", "{{.ID}}").strip()
        if reuse_state is None:
            certificate = host.attest(state, provisional, engine_id, hashes, development_build=delegation)
            host.publish_evidence(certificate_path, certificate)
        else:
            reuse_certificate = runtime._reuse_host_certificate if os.name == "nt" else host.reuse_certificate
            certificate = reuse_certificate(reuse_state, provisional, engine_id,
                                                         development_build=delegation)
        if validated_post_build_generation is not None:
            # Reuse may rotate image/source fields and clear readiness, but
            # cannot change the host identity authenticated under this lease.
            if (certificate_stable_identity(certificate) !=
                    validated_post_build_generation["certificate"]["stable_identity"]):
                raise BuildControlError("Post-build continuation certificate stable identity changed")
        startup = None
        if args.script is not None:
            from docker_volume_activate import _managed_activation_receipt_contract
            if helper_source_binding is None:
                startup_helper, startup_hashes = _startup_helper(control, selected, image)
            else:
                startup_helper, startup_hashes = _startup_helper(
                    control, selected, image, helper_source_binding=helper_source_binding
                )
            authorization = startup_helper.prepare(selected, args.script,
                request_id="docker-volume-" + token, source_commit=storage.git(selected, "rev-parse", "HEAD"))
            receipt_key, receipt_path = _managed_activation_receipt_contract(
                startup_helper, authorization.request_id)
            startup_path = state / "startup-provenance.json"
            startup_digest = startup_helper.write_provenance(startup_path, authorization)
            startup = {"authorization": authorization.as_dict(), "path": str(startup_path),
                       "provenance_sha256": startup_digest, "helper_hashes": startup_hashes,
                       "receipt_key": receipt_key, "receipt_path": receipt_path}
        if snapshot is None:
            user_data = _workspace_state_root(layout, control.project)
        else:
            user_data = storage.validate_path(Path(snapshot["destination_user_data_root"]),
                                             layout["storage_root"], "isolated workspace data")
            if not user_data.is_dir() or user_data.resolve(strict=True) != user_data:
                raise BuildControlError("Copied workspace data is missing or noncanonical")
        if os.name != "nt":
            host.admit_runtime_uid(user_data)
        git_common = _source_git_common_directory(selected)
        environment = {**os.environ, "FULLMAG_COMPOSE_PROJECT": control.project,
            "FULLMAG_COMPOSE_NETWORK": identity["network_name"],
            "FULLMAG_DOCKER_DEVICE_ACCESS": device_access,
            "FULLMAG_BUILD_CONTROL_VOLUME": control.volume,
            "FULLMAG_SOURCE_COMMIT": storage.git(selected, "rev-parse", "HEAD"),
            "FULLMAG_DEVELOPMENT_INPUTS_PATH": "/opt/fullmag/control/frontend/development-inputs.json",
            "FULLMAG_SOURCE_ROOT": str(selected), "FULLMAG_SOURCE_GIT_COMMON": str(git_common),
            "FULLMAG_DEV_IMAGE": image, "FULLMAG_TOOLCHAIN_IMAGE_ID": toolchain["image_id"],
            "FULLMAG_TOOLCHAIN_IMAGE": toolchain["image_id"],
            "FULLMAG_BACKEND_HOSTNAME": "fullmag-direct-backend-" + token[:12],
            "FULLMAG_STATE_ROOT": str(state), "FULLMAG_HOST_CERTIFICATE": str(certificate_path),
            "FULLMAG_PACKAGE_PROVENANCE": str(certificate_path),
            "FULLMAG_WORKSPACE_STATE_ROOT": str(user_data),
            "FULLMAG_DEVELOPMENT_INPUTS": str(certificate_path), "FULLMAG_HTTP_PORT": str(args.port),
            "FULLMAG_SOURCE_PROJECT_ID": identity["project_id"],
            "FULLMAG_SOURCE_WORKTREE_ID": identity["worktree_id"],
            "FULLMAG_SOURCE_CHECKOUT_KIND": identity["checkout_kind"]}
        # Compose interpolation cannot inherit an operator's unrelated host
        # value; only the explicit CLI list is pinned into the backend below.
        environment.pop(INCLUDE_UNTRACKED_ENV, None)
        # Only the two validated controls are carried into Compose.  The
        # digest is explicit so later cache/ledger overlays cannot silently
        # replace the operator's requested probe mode.
        environment.update(operator_probe_record["operator_probe_environment"])
        environment["FULLMAG_OPERATOR_PROBE_ENVIRONMENT_SHA256"] = operator_probe_record[
            "operator_probe_environment_sha256"
        ]
        compose_root = Path(helper_source_binding["root"]) if helper_source_binding is not None else selected
        _revalidate_helper_source_binding(helper_source_binding, selected)
        configured = bounded_capture(docker_argv("compose",
            "--project-name", control.project, "-f", str(compose_root / "compose.dev.yaml"),
            "config", "--format", "json"), env=environment, timeout=90)
        if configured.returncode or len(configured.stdout) > 1024 * 1024:
            raise BuildControlError("DEV Compose render failed: " + configured.stderr.decode("utf-8", "replace"))
        document = json.loads(configured.stdout)
        from docker_dev_defaults import configured_group_budget
        from docker_volume_resources import apply_group_budget, apply_saved_budget
        apply_group_budget(document, configured_group_budget(selected))
        apply_saved_budget(control, document)
        if device_access == "gpu":
            document["services"]["backend"]["gpus"] = [{"count": "all"}]
        backend, frontend = (document["services"][name] for name in ("backend", "frontend"))
        service_source_groups = (
            (backend, _source_supplementary_groups(selected, git_common)),
            (frontend, _source_supplementary_groups(selected)),
        )
        for service, source_groups in service_source_groups:
            if source_groups:
                existing_groups = service.get("group_add", [])
                if not isinstance(existing_groups, list) or any(
                    not isinstance(group, (str, int)) or isinstance(group, bool)
                    for group in existing_groups
                ):
                    raise BuildControlError("Rendered DEV service has invalid supplementary groups")
                merged_groups = list(dict.fromkeys(str(group) for group in existing_groups))
                merged_groups.extend(group for group in source_groups if group not in merged_groups)
                service["group_add"] = merged_groups
        control_namespace = _control_namespace_from_document({
            "x-fullmag-control-namespace": control.namespace,
        })
        document["x-fullmag-control-namespace"] = control_namespace
        _prefix_runtime_control_mounts(control, backend)
        backend["environment"]["FULLMAG_SESSION_STORAGE_PROFILE"] = certificate["storage_profile"]
        for mount in backend["volumes"]:
            if mount["target"] == "/run/fullmag/windows-folder-host.json":
                mount["target"] = host.HOST_CERT_PATH
        backend.pop("build", None)
        backend["environment"].update(cache["environment"])
        backend["environment"].update(ledger_backend["environment"])
        if control_namespace:
            backend["environment"]["FULLMAG_CONTROL_NAMESPACE"] = control_namespace
        else:
            backend["environment"].pop("FULLMAG_CONTROL_NAMESPACE", None)
        backend["environment"]["FULLMAG_PACKAGE_PROVENANCE"] = runtime.BACKEND_PROVENANCE_PATH
        backend["environment"]["FULLMAG_RUNTIME_PROVENANCE"] = runtime.BACKEND_PROVENANCE_PATH
        backend["environment"]["CUDA_CACHE_PATH"] = "/build/cuda-cache"
        backend["environment"].pop("FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256", None)
        if previous_config_sha256 is not None:
            backend["environment"]["FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256"] = str(
                previous_config_sha256
            )
        backend["environment"].update(validated_recovery_environment)
        for name in ("FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_REQUEST",
                     "FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_REQUEST_SHA256",
                     "FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_ATTEMPT"):
            backend["environment"].pop(name, None)
        if maintenance is not None:
            backend["environment"].update({
                "FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_REQUEST": maintenance["request_path"],
                "FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_REQUEST_SHA256": maintenance["request_sha256"],
                "FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_ATTEMPT": operation["receipt"]["attempt"],
            })
        backend["environment"].pop("FULLMAG_DOCKER_POST_BUILD_CONTINUATION", None)
        backend["environment"].pop("FULLMAG_DOCKER_POST_BUILD_CONTINUATION_SHA256", None)
        if post_build_start_binding is not None:
            backend["environment"].update(post_build_start_binding["environment"])
        backend["environment"].pop("FULLMAG_ACCEPTED_REATTACH_REQUEST", None)
        backend["environment"].pop("FULLMAG_ACCEPTED_REATTACH_REQUEST_SHA256", None)
        backend["environment"].update(validated_accepted_reattach_environment)
        for name in ("FULLMAG_TERMINAL_OBSERVATION_REQUEST", "FULLMAG_TERMINAL_OBSERVATION_REQUEST_SHA256",
                     "FULLMAG_DEVELOPMENT_TERMINAL_OBSERVATION_STDIN"):
            backend["environment"].pop(name, None)
        if terminal_observation is not None:
            backend["environment"].update(terminal_observation["environment"])
        backend["environment"].pop("FULLMAG_ISOLATED_SNAPSHOT_START", None)
        backend["environment"].pop("FULLMAG_ISOLATED_SNAPSHOT_START_SHA256", None)
        # A validated terminal observation selects its exact current run. Keep
        # the imported snapshot/archive intact, but do not hydrate that older
        # workspace before the terminal observation requires a fresh API.
        if snapshot is not None and terminal_observation is None:
            meta_raw = control.read_bytes("isolated-snapshot/start.json")
            meta_pin = snapshot["control_pins"].get(
                control.namespace + "/isolated-snapshot/start.json"
            )
            if meta_pin is None or hashlib.sha256(meta_raw).hexdigest() != meta_pin:
                raise BuildControlError("Snapshot startup metadata differs from its published receipt")
            backend["environment"].update({
                "FULLMAG_ISOLATED_SNAPSHOT_START": "/opt/fullmag/control/isolated-snapshot/start.json",
                "FULLMAG_ISOLATED_SNAPSHOT_START_SHA256": meta_pin,
            })
        if startup is not None:
            backend["environment"].update(FULLMAG_STARTUP_ENABLED="1",
                FULLMAG_STARTUP_SCRIPT=startup["authorization"]["container_script_path"],
                FULLMAG_STARTUP_PROVENANCE="/run/fullmag/startup-provenance.json",
                FULLMAG_STARTUP_PROVENANCE_SHA256=startup["provenance_sha256"],
                FULLMAG_STARTUP_HELPER_SHA256=startup["helper_hashes"]["docker_startup_script.py"],
                FULLMAG_STARTUP_RECEIPT_KEY=startup["receipt_key"],
                FULLMAG_STARTUP_API="http://127.0.0.1:8081")
            backend["volumes"].append({"type": "bind", "source": startup["path"],
                "target": "/run/fullmag/startup-provenance.json", "read_only": True,
                "bind": {"create_host_path": False}})
        backend["labels"].update(cache["overlay"]["services"]["backend"]["labels"])
        backend["volumes"] = [m for m in backend["volumes"]
                              if m["target"] not in {"/opt/fullmag/provenance.json", "/build", "/opt/fullmag/package", "/opt/fullmag/control"}]
        backend["volumes"] += cache["overlay"]["services"]["backend"]["volumes"] + ledger_backend["volumes"]
        frontend["volumes"] = [m for m in frontend["volumes"]
                               if m["target"] not in {"/state/development", "/run/fullmag/development-inputs.json"}]
        frontend["volumes"] += [
            {"type": "volume", "source": "frontend-build", "target": "/state/development", "volume": {"nocopy": True}},
            {"type": "volume", "source": "build-control", "target": "/opt/fullmag/control", "read_only": True,
             "volume": {"nocopy": True, "subpath": _resolved_control_subpath(control, "frontend")}}]
        owner_tmpfs = "/run/fullmag/frontend-owner:rw,nosuid,nodev,noexec,size=1m,uid=65532,gid=65532,mode=0700"
        existing_tmpfs = [
            value for value in frontend.get("tmpfs", [])
            if isinstance(value, str) and value.split(":", 1)[0] == _FRONTEND_OWNER_TMPFS
        ]
        if existing_tmpfs and existing_tmpfs != [owner_tmpfs]:
            raise BuildControlError("Frontend owner tmpfs declaration is ambiguous")
        frontend["tmpfs"] = [
            value for value in frontend.get("tmpfs", [])
            if not (isinstance(value, str) and value.split(":", 1)[0] == _FRONTEND_OWNER_TMPFS)
        ] + [owner_tmpfs]
        document["volumes"] = {**document.get("volumes", {}), **cache["overlay"]["volumes"],
            "frontend-build": {"name": frontend_volume, "external": True},
            "build-control": {"name": control.volume, "external": True}}
        import docker_shared_build_storage as shared
        shared_volumes = shared.volume_descriptors(cache["project_id"])
        for service, role, compose_name, subpath, variable in (
            (backend, shared.CARGO_ROLE, "shared-cargo", "home", "FULLMAG_SHARED_CARGO_HOME"),
            (frontend, shared.PNPM_ROLE, "shared-pnpm", "store", "FULLMAG_SHARED_PNPM_STORE"),
        ):
            descriptor = shared_volumes[role]
            document["volumes"][compose_name] = {"name": descriptor["name"], "external": True}
            service["volumes"].append({"type": "volume", "source": compose_name,
                "target": descriptor["target"], "volume": {"nocopy": True, "subpath": subpath}})
            service["environment"][variable] = descriptor["target"]
        operation["receipt"]["shared_storage"] = {
            "schema": shared.SCHEMA, "project_id": cache["project_id"],
            "package_group": cache["shared_package_subpath"],
            "volumes": {role: value["name"] for role, value in shared_volumes.items()},
        }
        if "x-fullmag-host-ledger-volume" in ledger_backend:
            descriptor = ledger_backend["x-fullmag-host-ledger-volume"]
            backend["x-fullmag-host-ledger-volume"] = descriptor
            document["volumes"]["host-ledger"] = descriptor["compose_volume"]
        if ledger_profile.get("profile") == "group-ledger-v1":
            import docker_group_ledger as group_ledger
            document["volumes"][group_ledger.COMPOSE_VOLUME] = ledger_profile["compose_volume"]
            # The group's base render must not retain any global ledger field.
            for key in group_ledger.GLOBAL_ONLY_ENVIRONMENT:
                backend["environment"].pop(key, None)
        _reassert_operator_probe_environment(document, operator_probe_record)
        for service in (backend, frontend):
            service["logging"] = {"driver": "local", "options": {"max-size": "10m", "max-file": "3"}}
        from docker_script_output_mounts import configure as configure_script_output, validate as validate_script_output
        configure_script_output(document, selected)
        validate_script_output(document)
        # All writable bind destinations are runtime/user stores, never build data.
        for service in (backend, frontend):
            for mount in service["volumes"]:
                if mount["type"] == "bind" and not mount.get("read_only") and mount["target"] not in ({"/state", "/user-data", "/host-ledger"} | ({"/opt/fullmag/script-output"} if service is backend else set())):
                    raise BuildControlError("Unexpected writable host bind: " + mount["target"])
        import docker_worker_cgroup
        docker_worker_cgroup.configure_backend(document)
        backend["environment"][INCLUDE_UNTRACKED_ENV] = json.dumps(
            include_untracked, ensure_ascii=False, separators=(",", ":")
        )
        control.write(operation["root"] + "/compose.json", document)
        operation["receipt"].update(state="starting-services", state_root=str(state),
            frontend_volume=frontend_volume, backend_volumes=cache["volume_names"])
        _revalidate_helper_source_binding(helper_source_binding, selected)
        _start_compose_services(control, operation, document)
        backend_id = compose_capture(document, "ps", "--all", "--quiet", "backend").decode().strip()
        frontend_id = compose_capture(document, "ps", "--all", "--quiet", "frontend").decode().strip()
        if not backend_id or not frontend_id:
            raise BuildControlError("Compose did not return both fixed services")
        import docker_backend_volume_cache as backend_cache
        backend_cache.validate_container(json.loads(docker_text("inspect", backend_id))[0], cache)
        if os.name != "nt":
            # Desktop translates WSL client paths. Pin inspect's daemon paths
            # after creation so later resumes compare the same namespace.
            for service, identifier in (("backend", backend_id), ("frontend", frontend_id)):
                actual = json.loads(docker_text("inspect", identifier))[0]
                if (actual.get("Config", {}).get("Labels", {}).get("com.docker.compose.project") != control.project
                        or actual.get("Config", {}).get("Labels", {}).get("com.docker.compose.service") != service):
                    raise BuildControlError("Cannot pin binds of a foreign service")
                document["services"][service]["x-fullmag-daemon-binds"] = {
                    mount["Destination"]: mount["Source"] for mount in actual.get("Mounts", [])
                    if mount["Type"] == "bind"}
            control.write(operation["root"] + "/compose.json", document)
        if helper_source_binding is None:
            _finish(control, operation, document, backend_id, frontend_id, selected, state,
                    certificate_path, certificate, cache, toolchain, image, git_common,
                    ledger_profile, args.port)
        else:
            _finish(control, operation, document, backend_id, frontend_id, selected, state,
                    certificate_path, certificate, cache, toolchain, image, git_common,
                    ledger_profile, args.port, helper_source_binding=helper_source_binding)



def _wait_for_publication(control, operation, backend_id, *, timeout=14400, publication_pins=None):
    """A previous succeeded package is not evidence that this start finished."""
    import fullmag_docker_runtime as runtime
    deadline = time.monotonic() + timeout
    started_at = operation["receipt"].get("backend_started_at")
    handoff_seen = False
    last_report = 0.0
    while time.monotonic() < deadline:
        actual = json.loads(docker_text("inspect", backend_id))[0]
        current_start = actual.get("State", {}).get("StartedAt")
        if started_at is None:
            started_at = current_start
            operation["receipt"]["backend_started_at"] = started_at
        elif current_start != started_at:
            raise BuildControlError("Backend incarnation changed during build observation")
        if not actual["State"]["Running"]:
            logs = docker_text("logs", "--since", started_at, "--tail", "200", backend_id, combined=True)
            control.write(operation["root"] + "/backend-failure-log.json",
                          {"started_at": started_at, "log": logs})
            raise BuildControlError("Backend exited during build; logs and volumes retained: " + logs[-4000:])
        if not handoff_seen:
            logs = docker_text("logs", "--since", started_at, "--tail", "200", backend_id, combined=True)
            handoff_seen = "phase=start state=handoff" in logs
            if handoff_seen:
                operation["receipt"]["backend_package_cache_hit"] = "phase=start state=cache-hit" in logs
                control.write(operation["root"] + "/handoff-log.json", {"started_at": started_at, "log": logs})
        if handoff_seen:
            raw = docker_capture("exec", backend_id, "/usr/local/bin/python3", "-c",
                runtime._BACKEND_BUILD_DOCUMENTS_SCRIPT)
            observed = json.loads(raw.stdout)
            receipt, provenance = observed["receipt"]["value"], observed["provenance"]["value"]
            if (receipt.get("state") != "succeeded" or provenance.get("state") != "succeeded"
                    or provenance.get("build_receipt_sha256") != observed["receipt"]["sha256"]):
                raise BuildControlError("Current handoff has no matching succeeded package/provenance")
            if publication_pins is not None:
                publication_pins.update(receipt_sha256=observed["receipt"]["sha256"],
                                        provenance_sha256=observed["provenance"]["sha256"])
            return receipt, provenance
        if time.monotonic() - last_report > 45:
            mirror_console("Backend startup is in progress (build, package validation or runtime handoff); see backend service logs. Docker data retained.\n")
            last_report = time.monotonic()
        time.sleep(3)
    raise BuildControlError("Backend publication observation timed out; services and volumes retained")


def _finish(control, operation, document, backend_id, frontend_id, selected, state,
            certificate_path, certificate, cache, toolchain, image, git_common, ledger_profile, port,
            *, completion_gate=None, helper_source_binding=None, terminal_completion_gate=None):
    import fullmag_docker_runtime as runtime
    token = operation["receipt"]["attempt"]
    operator_probe_record = _operator_probe_record_from_retained(operation["receipt"], document)
    inputs = {"image_id": image, "toolchain_image_id": toolchain["image_id"],
              "guest_provenance_path": "/opt/fullmag/control/backend/runtime-provenance.json",
              **operator_probe_record}
    receipt, provenance = _wait_for_publication(control, operation, backend_id)
    control.write(operation["root"] + "/backend-build-receipt.json", receipt)
    control.write(operation["root"] + "/provenance.json", provenance)
    operation["receipt"]["config_sha256"] = hashlib.sha256(canonical(document)).hexdigest()
    operation["receipt"]["storage_profile"] = certificate["storage_profile"]
    operation["receipt"]["storage_delegation_reused"] = certificate.get("restart_verified") is True
    # Use the existing source/binary validation before rotating Windows admission.
    inputs.update(device_access=document["services"]["backend"]["environment"]["FULLMAG_DOCKER_DEVICE_ACCESS"],
        gpu_preflight="PASS" if document["services"]["backend"]["environment"]["FULLMAG_DOCKER_DEVICE_ACCESS"] == "gpu" else "NOT_REQUIRED",
        backend_cache=cache, package_root="/opt/fullmag/package", run_id=token,
        source_root=str(selected), git_common_dir=str(git_common), build_profile="dev",
        startup_helper_hashes={}, backend_start_receipt="docker-volume://" + control.volume + "/" + operation["root"] + "/receipt.json",
        helper_context="image-owned")
    # Keep the exact frozen operator record in the final operation receipt and
    # in the assembly input consumed by runtime admission.
    operation["receipt"].update(operator_probe_record)
    assembly = runtime._assembly_from_backend_start(inputs, receipt, provenance, container_id=backend_id)
    # An admitted delegation intentionally permits subsequent live builds.
    # Rotating it back to unverified after handoff races the serving process.
    if certificate.get("restart_verified") is not True:
        certificate = runtime._refresh_development_certificate(certificate, assembly, inputs)
        host = _session_host()
        host.write_bound_evidence(certificate_path, certificate)
        host.publish_evidence(state / host.OWNER_NAME, certificate)
    log_writer = lambda output: control.write(operation["root"] + "/storage-probe-log.json", {"log": output})
    if os.name == "nt":
        runtime._complete_backend_storage_preflight(docker_text, backend_id, state, certificate_path, certificate, None,
                                                   log_writer=log_writer)
    else:
        _session_host().complete_preflight(docker_text, backend_id, state, certificate_path, certificate,
                                           log_writer=log_writer)
    # The backend publishes its cgroup request only after storage admission.
    # Complete the independent guest probes first to avoid a circular wait.
    import docker_worker_cgroup
    docker_worker_cgroup.ensure_delegation(control, operation, document, backend_id, image, selected)
    if ledger_profile.get("profile") == "group-ledger-v1":
        import docker_group_ledger as group_ledger
        ledger_attestation = group_ledger.validate_container(
            json.loads(docker_text("inspect", backend_id))[0], ledger_profile, docker_text)
        control.write(operation["root"] + "/group-ledger-attestation.json", ledger_attestation)
    else:
        import docker_host_ledger as ledger
        verify_spec = ledger_profile["maintenance_document"]
        verify_name = "fullmag-ledger-verify-" + token
        output = compose_capture(verify_spec, "run", "--name", verify_name, "--no-deps", "host-ledger-maintenance", "verify", timeout=240)
        actual_verify = json.loads(docker_text("inspect", verify_name))
        if (len(actual_verify) != 1 or actual_verify[0].get("Image") != image
                or actual_verify[0].get("State", {}).get("Running")
                or actual_verify[0].get("State", {}).get("ExitCode") != 0
                or actual_verify[0].get("Config", {}).get("Labels", {}).get("com.docker.compose.project") != control.project):
            raise BuildControlError("Fresh host-ledger verification identity/outcome differs")
        host_receipt = ledger._parse_json_lines(output.decode(), ledger.HOST_RECEIPT_SCHEMA)
        ledger._validate_host_receipt(host_receipt, {"project_id": ledger_profile["project_id"],
            "mount_root": ledger_profile["mount_root"], "backing_image": ledger_profile["backing_image"]})
        ledger_profile["host_receipt"] = host_receipt
        # Preserve the successful probe before observing the application. A backend
        # exit during its attestation must not leave this known stopped helper
        # blocking the next managed start of the same Compose project.
        control.write(operation["root"] + "/ledger-verify-receipt.json", host_receipt)
        control.write(operation["root"] + "/ledger-verify-log.json",
                      {"log": docker_text("logs", verify_name, combined=True)})
        docker_capture("rm", actual_verify[0]["Id"])
        backend_service = document["services"]["backend"]
        if "x-fullmag-host-ledger-volume" in backend_service:
            ledger_profile = {**ledger_profile, "daemon_volume": backend_service["x-fullmag-host-ledger-volume"]}
        ledger_attestation = ledger.validate_container(json.loads(docker_text("inspect", backend_id))[0], ledger_profile, docker_text)
        control.write(operation["root"] + "/host-ledger-attestation.json", ledger_attestation)
    maintenance = _validate_cancellation_maintenance(operation["receipt"].get("unclaimed_cancellation"))
    if maintenance is not None:
        operation["receipt"].update(
            backend_build_receipt_sha256=provenance["build_receipt_sha256"],
            source_commit=provenance["commit"], source_digest=provenance["source_digest"],
            source_snapshot_sha256=provenance["source_snapshot_sha256"],
            backend_container=backend_id, frontend_container=frontend_id,
        )
        admission = {
            "schema": "fullmag.docker-runtime-unclaimed-cancellation-admission.v1",
            "attempt": token, "request_id": maintenance["request_id"],
            "request_sha256": maintenance["request_sha256"],
            "backend_container_id": backend_id,
            "backend_started_at": operation["receipt"]["backend_started_at"],
            "backend_build_receipt_sha256": provenance["build_receipt_sha256"],
        }
        admission_path = "backend/runtime-service/unclaimed-cancellation/admissions/" + token + ".json"
        previous = control.read(admission_path, optional=True)
        if previous is not None and previous != admission:
            raise BuildControlError("Cancellation maintenance admission already exists with different evidence")
        if previous is None:
            control.write(admission_path, admission)
        operation["receipt"]["unclaimed_cancellation_admission"] = admission
        from docker_volume_unclaimed_cancellation import wait_for_maintenance
        result = wait_for_maintenance(control, operation, backend_id, document, maintenance)
        operation["receipt"].update(state="succeeded", unclaimed_cancellation_result=result)
        return
    # Observe the existing incarnations; a readiness check must never run up
    # again or wait an hour after the supervisor has already closed admission.
    service_images = {name: document['services'][name]['image'] for name in ('backend', 'frontend')}
    image_configs = {value: json.loads(docker_text('image', 'inspect', value))[0]['Config']
                     for value in set(service_images.values())}
    readiness_deadline = time.monotonic() + 3900
    while time.monotonic() < readiness_deadline:
        services = json.loads(docker_text("inspect", backend_id, frontend_id))
        for service, observed in zip(("backend", "frontend"), services):
            if observed.get('Image') != service_images[service]:
                raise BuildControlError('DEV service image differs: ' + service)
            _validate_retained_service(document, observed, service, image_configs[service_images[service]],
                expected_started_at=operation["receipt"]["backend_started_at"] if service == "backend" else None)
            if not observed.get("State", {}).get("Running"):
                raise BuildControlError("DEV service exited before readiness: " + service)
        process_receipt = json.loads(docker_text("exec", backend_id, "/usr/local/bin/python3", "-B", "-c", _PROCESS_RECEIPT_PROBE))
        if (str(process_receipt.get("state", "")).startswith("failed")
                or services[0].get("State", {}).get("Health", {}).get("Status") != "healthy"):
            logs = docker_text("logs", "--since", operation["receipt"]["backend_started_at"],
                               "--tail", "100", backend_id, combined=True)
            failure = _readiness_failure(process_receipt, logs)
            if failure:
                control.write(operation["root"] + "/process-failure.json", process_receipt)
                control.write(operation["root"] + "/readiness-failure.json", {
                    "backend_container_id": backend_id,
                    "backend_started_at": operation["receipt"]["backend_started_at"],
                    "error": failure,
                })
                raise BuildControlError(failure)
        if all(service.get("State", {}).get("Health", {}).get("Status") == "healthy" for service in services):
            break
        time.sleep(3)
    else:
        raise BuildControlError("API/frontend readiness timed out; services and Docker data retained")
    startup_environment = document["services"]["backend"]["environment"]
    if startup_environment.get("FULLMAG_STARTUP_ENABLED") == "1":
        startup_path = state / "startup-provenance.json"
        data = _session_host().read_owned_regular(startup_path, maximum=256 * 1024)
        if hashlib.sha256(data).hexdigest() != startup_environment["FULLMAG_STARTUP_PROVENANCE_SHA256"]:
            raise BuildControlError("Startup authorization changed after admission")
        authorization = json.loads(data)
        if helper_source_binding is None:
            helper, hashes = _startup_helper(control, selected, image)
        else:
            helper, hashes = _startup_helper(
                control, selected, image, helper_source_binding=helper_source_binding
            )
        if hashes["docker_startup_script.py"] != startup_environment["FULLMAG_STARTUP_HELPER_SHA256"]:
            raise BuildControlError("Startup helper differs from retained service")
        operation["receipt"]["startup"] = runtime._wait_for_startup_ready(
            state, authorization, startup_helper=helper,
            receipt_reader=lambda: (read_process_receipt(), None))
    if terminal_completion_gate is not None:
        published = json.loads(docker_text("exec", backend_id, "/usr/local/bin/python3", "-B", "-c",
                                          runtime._BACKEND_BUILD_DOCUMENTS_SCRIPT))
        if (published["receipt"]["value"] != receipt or published["provenance"]["value"] != provenance
                or published["receipt"]["sha256"] != provenance["build_receipt_sha256"]):
            raise BuildControlError("Qualified terminal retry publication changed before completion")
        terminal_completion_gate({
            "backend_container_id": backend_id, "backend_started_at": operation["receipt"]["backend_started_at"],
            "image_id": image, "package_receipt_sha256": published["receipt"]["sha256"],
            "provenance_sha256": published["provenance"]["sha256"],
            "runtime_config_sha256": _read_runtime_config_digest(control),
        })
    if completion_gate is not None:
        completion_gate()
    post_build_start = operation["receipt"].get("post_build_start")
    if isinstance(post_build_start, Mapping) and post_build_start.get("state") == "pending":
        # A successful, fully qualified start durably consumes the one-shot
        # host binding.  The immutable binding bytes remain available for
        # receipt comparison; subsequent Docker restarts use normal drain.
        operation["receipt"]["post_build_start"] = {
            **post_build_start,
            "state": "consumed",
        }
    if startup_environment.get("FULLMAG_SHARED_BACKEND_STORE"):
        if startup_environment.get("FULLMAG_AUTO_CACHE_MAINTENANCE") == "1":
            # The image-owned supervisor schedules this after its ready receipt,
            # including Docker Desktop restarts. Never race it with a host exec.
            operation["receipt"]["cache_maintenance"] = {
                "schema": "fullmag.automatic-cache-maintenance-reference.v1",
                "state": "scheduled-by-container",
                "backend_container": backend_id,
                "receipt": "/opt/fullmag/runtime-control/runtime-service/cache-maintenance.json",
            }
        else:
            from docker_volume_cache_maintenance import run_guest_maintenance
            operation["receipt"]["cache_maintenance"] = run_guest_maintenance(operation, backend_id)
        control.write(operation["root"] + "/cache-maintenance.json", operation["receipt"]["cache_maintenance"])
    operation["receipt"].update(state="succeeded", backend_container=backend_id,
        frontend_container=frontend_id, url="http://127.0.0.1:" + str(port),
        source_commit=provenance["commit"], source_digest=provenance["source_digest"],
        source_snapshot_sha256=provenance["source_snapshot_sha256"],
        backend_build_receipt_sha256=provenance["build_receipt_sha256"])



def _validate_retained_service(document, actual, service, image_config, *,
                               expected_started_at=None, allow_legacy_frontend=False):
    """Reject configuration/mount drift and a replaced observed incarnation."""
    if expected_started_at is not None and actual.get("State", {}).get("StartedAt") != expected_started_at:
        raise BuildControlError("Backend incarnation changed during readiness observation")
    from run_managed_browser import host_path
    expected = document["services"][service]
    config, host = actual.get("Config", {}), actual.get("HostConfig", {})
    environment = dict(item.split("=", 1) for item in config.get("Env", []) if "=" in item)
    if any(environment.get(key) != str(value) for key, value in expected.get("environment", {}).items()):
        raise BuildControlError("Retained service environment differs: " + service)
    if any(config.get("Labels", {}).get(key) != value for key, value in expected.get("labels", {}).items()):
        raise BuildControlError("Retained service source/cache labels differ: " + service)
    for field, observed in (("hostname", config.get("Hostname")), ("user", config.get("User"))):
        if field in expected and expected[field] != observed:
            raise BuildControlError("Retained service configuration differs: " + service + "/" + field)
    expected_groups = expected.get("group_add", [])
    observed_groups = host.get("GroupAdd") or []
    if (
        not isinstance(expected_groups, list)
        or not isinstance(observed_groups, list)
        or any(not isinstance(group, (str, int)) or isinstance(group, bool)
               for group in expected_groups + observed_groups)
        or {str(group) for group in expected_groups} != {str(group) for group in observed_groups}
    ):
        raise BuildControlError("Retained service supplementary groups differ: " + service)
    for field, image_field in (("entrypoint", "Entrypoint"), ("command", "Cmd")):
        resolved = expected.get(field)
        if resolved is None:
            resolved = image_config.get(image_field)
        if (resolved or None) != (config.get(image_field) or None):
            raise BuildControlError("Retained service image command differs: " + service + "/" + field)
    if host.get("ReadonlyRootfs") is not True or host.get("Privileged") is not False:
        raise BuildControlError("Retained service isolation differs: " + service)
    mounts = {mount["Destination"]: mount for mount in actual.get("Mounts", [])}
    if len(mounts) != len(actual.get("Mounts", [])):
        raise BuildControlError("Retained service has duplicate mount destinations")
    targets = {mount["target"] for mount in expected["volumes"]}
    temporary = {value.split(":", 1)[0] for value in expected.get("tmpfs", [])}
    if (targets - set(mounts) or set(mounts) - targets - temporary
            or set(host.get("Tmpfs") or {}) != temporary
            or any(mounts[target].get("Type") != "tmpfs" for target in set(mounts) - targets)):
        raise BuildControlError("Retained service has missing or extra mounts: " + service)
    if service == "frontend":
        owner_specs = [
            value for value in expected.get("tmpfs", [])
            if isinstance(value, str) and value.split(":", 1)[0] == _FRONTEND_OWNER_TMPFS
        ]
        if owner_specs:
            if len(owner_specs) != 1:
                raise BuildControlError("Frontend service must declare one ephemeral owner tmpfs")
            _, expected_options = owner_specs[0].split(":", 1)
            actual_options = (host.get("Tmpfs") or {}).get(_FRONTEND_OWNER_TMPFS)
            expected_normalized = _normalize_tmpfs_options(
                expected_options, label="frontend owner expected"
            )
            actual_normalized = _normalize_tmpfs_options(
                actual_options, label="frontend owner observed"
            )
            required = _normalize_tmpfs_options(
                "rw,nosuid,nodev,noexec,size=1m,uid=65532,gid=65532,mode=0700",
                label="frontend owner required",
            )
            if expected_normalized != required:
                raise BuildControlError("Frontend owner tmpfs declaration is not private and bounded")
            if actual_normalized != required:
                raise BuildControlError("Frontend owner tmpfs mount is not private and bounded")
        if not owner_specs and not allow_legacy_frontend:
            raise BuildControlError("Retained frontend is missing the ephemeral owner tmpfs")
        # A retained compose document from before this migration may be read
        # only during a controlled recreation that renders the current document;
        # a normal resume must never restart it without the new owner boundary.
    for mount in expected["volumes"]:
        observed = mounts[mount["target"]]
        if observed.get("Type") != mount["type"] or bool(observed.get("RW")) == bool(mount.get("read_only", False)):
            raise BuildControlError("Retained mount type/access differs: " + mount["target"])
        if mount["type"] == "volume":
            name = document["volumes"][mount["source"]]["name"]
            if observed.get("Name") != name:
                raise BuildControlError("Retained named-volume identity differs: " + mount["target"])
        elif mount["type"] == "bind":
            pinned = expected.get("x-fullmag-daemon-binds", {}).get(mount["target"])
            matches = (observed["Source"] == pinned if pinned is not None else
                       host_path(observed["Source"]) == Path(mount["source"]).resolve())
            if not matches:
                raise BuildControlError("Retained source/runtime bind differs: " + mount["target"])


def _assert_private_restart_network(actual, ids, project):
    """Only the pinned frontend may expose this backend to browser commands."""
    backend = actual["backend"]
    if backend.get("HostConfig", {}).get("PortBindings") or backend.get("HostConfig", {}).get("NetworkMode") in {"host", "none"}:
        raise BuildControlError("Idle restart requires an unpublished private backend")
    networks = backend.get("NetworkSettings", {}).get("Networks", {})
    if len(networks) != 1:
        raise BuildControlError("Idle restart requires one private application bridge")
    observed = json.loads(docker_text("network", "inspect", next(iter(networks))))
    if (len(observed) != 1 or observed[0].get("Driver") != "bridge"
            or observed[0].get("Labels", {}).get("com.docker.compose.project") != project
            or set(observed[0].get("Containers", {})) - set(ids.values())):
        raise BuildControlError("Idle restart bridge has unknown consumers; no backend will be stopped")


def _terminal_session_restart_probe(backend_id, *, allow_prepared=False, startup_enabled=False):
    """Allow drain after a terminal task or an exact pre-acceptance failure.

    Called only with the private frontend stopped and the group control lease
    held. This is admission to graceful drain, not proof of process absence:
    the existing native drain receipt remains mandatory before restart.
    """
    script = ('ALLOW_PREPARED = ' + repr(bool(allow_prepared)) + '\n'
        + 'STARTUP_ENABLED = ' + repr(bool(startup_enabled)) + '\n' + r'''import hashlib,json,os,re,stat,urllib.error,urllib.request
MAX=1024*1024
MAX_STARTUP_RECEIPT=2*MAX
MAX_STARTUP_MARKERS=256
MAX_CONTROL_ENTRIES=4096
instance=None
last_current_run_not_found=None
def unique_object(pairs):
    result={}
    for key,value in pairs:
        if key in result: raise RuntimeError("restart record has duplicate JSON keys")
        result[key]=value
    return result
def read_startup_marker(key):
    root="/opt/fullmag/control/backend"
    if os.path.realpath(root)!=root:
        raise RuntimeError("startup receipt root is not canonical")
    flags=os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK
    root_fd=os.open(root,flags|os.O_DIRECTORY)
    try:
        if not stat.S_ISDIR(os.fstat(root_fd).st_mode):
            raise RuntimeError("startup receipt root is not a directory")
        marker_dir=os.open("script-activation-"+key,flags|os.O_DIRECTORY,dir_fd=root_fd)
        try:
            fd=os.open("activation.json",flags,dir_fd=marker_dir)
            with os.fdopen(fd,"rb") as source:
                if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                    raise RuntimeError("startup activation receipt is not a regular file")
                raw=source.read(MAX_STARTUP_RECEIPT+1)
            if len(raw)>MAX_STARTUP_RECEIPT:
                raise RuntimeError("startup activation receipt exceeds its bound")
        finally: os.close(marker_dir)
    finally: os.close(root_fd)
    value=json.loads(raw,object_pairs_hook=unique_object)
    if not isinstance(value,dict): raise RuntimeError("startup activation receipt is invalid")
    return raw,value
def rejected_startup_marker(status,identity):
    session=status.get("session") or {}
    script=session.get("script") or {}
    script_path=script.get("path")
    if not isinstance(script_path,str) or not script_path:
        raise RuntimeError("startup_failed session has no public script path")
    configured_key=os.environ.get("FULLMAG_STARTUP_RECEIPT_KEY") if STARTUP_ENABLED else None
    if STARTUP_ENABLED and (not isinstance(configured_key,str)
            or re.fullmatch(r"[0-9a-f]{64}",configured_key) is None
            or os.environ.get("FULLMAG_STARTUP_SCRIPT")!=script_path):
        raise RuntimeError("configured startup activation does not bind the current script")
    root="/opt/fullmag/control/backend"
    if os.path.realpath(root)!=root:
        raise RuntimeError("startup receipt root is not canonical")
    flags=os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_DIRECTORY
    root_fd=os.open(root,flags)
    try:
        names=sorted(os.listdir(root_fd))
        if len(names)>MAX_CONTROL_ENTRIES:
            raise RuntimeError("startup receipt namespace exceeds its entry bound")
        keys=[]
        for name in names:
            match=re.fullmatch(r"script-activation-([0-9a-f]{64})",name)
            if match:
                keys.append(match.group(1))
        if len(keys)>MAX_STARTUP_MARKERS:
            raise RuntimeError("startup receipt namespace exceeds its marker bound")
    finally: os.close(root_fd)
    if STARTUP_ENABLED:
        keys=[key for key in keys if key==configured_key]
    matches=[]
    for key in keys:
        try: raw,marker=read_startup_marker(key)
        except (FileNotFoundError,PermissionError,NotADirectoryError,OSError,RuntimeError,json.JSONDecodeError,UnicodeDecodeError):
            continue
        request_id=marker.get("request_id")
        source_sha=marker.get("source_sha256")
        if (not isinstance(request_id,str)
                or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}",request_id) is None
                or not isinstance(source_sha,str)
                or re.fullmatch(r"[0-9a-f]{64}",source_sha) is None):
            continue
        expected_session="docker-startup-"+hashlib.sha256(
            (request_id+"\0"+source_sha).encode("utf-8")).hexdigest()
        if expected_session!=identity[0]: continue
        authorization=marker.get("authorization")
        if not isinstance(authorization,dict):
            raise RuntimeError("startup activation receipt has no authorization")
        if (hashlib.sha256(request_id.encode("utf-8")).hexdigest()!=key
                or marker.get("schema")!="fullmag.docker-startup-activation-receipt.v1"
                or marker.get("state")!="rejected"
                or set(marker)!={"schema","state","request_id","provenance_sha256","source_sha256","authorization","result"
                }
                or marker.get("request_id")!=request_id
                or marker.get("source_sha256")!=source_sha
                or re.fullmatch(r"[0-9a-f]{64}",marker.get("provenance_sha256","")) is None):
            raise RuntimeError("current session is not bound to a rejected startup receipt")
        relative=authorization.get("source_relative")
        if (set(authorization)!={"schema","authorization","source_root","source_path","source_relative","source_sha256","source_size_bytes","source_commit","container_source_root","container_script_path","request_id","execution_policy"}
                or authorization.get("schema")!="fullmag.docker-startup-script.v1"
                or authorization.get("authorization")!="explicit_startup_script"
                or authorization.get("request_id")!=request_id
                or authorization.get("source_sha256")!=source_sha
                or authorization.get("container_source_root")!="/opt/fullmag/source"
                or not isinstance(relative,str) or not relative.lower().endswith(".py")
                or relative.startswith("/") or "\\" in relative or "\x00" in relative
                or any(not part or part in {".",".."} for part in relative.split("/"))
                or authorization.get("container_script_path")!="/opt/fullmag/source/"+relative
                or authorization.get("source_size_bytes") is None
                or isinstance(authorization.get("source_size_bytes"),bool)
                or not isinstance(authorization.get("source_size_bytes"),int)
                or not 0<=authorization["source_size_bytes"]<=MAX
                or (authorization.get("source_commit") is not None
                    and re.fullmatch(r"[0-9a-f]{40}",authorization.get("source_commit","")) is None)
                or authorization.get("source_path") is None or authorization.get("source_root") is None
                or authorization.get("container_script_path")!=script_path):
            raise RuntimeError("startup authorization differs from the current session source")
        if STARTUP_ENABLED and (key!=configured_key
                or os.environ.get("FULLMAG_STARTUP_PROVENANCE_SHA256")!=marker.get("provenance_sha256")):
            raise RuntimeError("configured startup receipt/provenance differs from its rejected marker")
        policy={"mode":"canonical_live_v2","auto_study":True,"interactive":"script_metadata","wait_for_solve":"script_metadata","legacy_cli":False}
        if authorization.get("execution_policy")!=policy:
            raise RuntimeError("startup authorization execution policy differs")
        result=marker.get("result")
        if (not isinstance(result,dict)
                or set(result)!={"schema","state","request_id","source_sha256","source_relative","rejection"}
                or result.get("schema")!="fullmag.startup-script-activation.v1"
                or result.get("state")!="rejected"
                or result.get("request_id")!=request_id
                or result.get("source_sha256")!=source_sha
                or result.get("source_relative")!=relative):
            raise RuntimeError("startup activation rejection result differs from its receipt")
        rejection=result.get("rejection")
        rejection_codes={"bad_request","validation_error","unprocessable_entity","unsupported_capability","accepted_execution_command_unsupported","accepted_study_plan_invalid","accepted_execution_stage_missing","accepted_gpu_scope_unsupported","accepted_execution_plan_invalid","accepted_backend_unsupported","accepted_study_step_unsupported","accepted_study_step_ambiguous","docker_startup_output_mapping_required","docker_startup_output_mapping_invalid"}
        if (not isinstance(rejection,dict)
                or set(rejection)!={"http_status","code","message"}
                or type(rejection.get("http_status")) is not int
                or rejection["http_status"] not in {400,422}
                or rejection.get("code") not in rejection_codes
                or not isinstance(rejection.get("message"),str)
                or not rejection["message"].strip() or len(rejection["message"])>2048):
            raise RuntimeError("startup activation rejection is not a known pre-acceptance outcome")
        matches.append({"key":key,"raw":raw,"marker":marker,"request_id":request_id,
            "source_sha256":source_sha,"source_relative":relative,"rejection":rejection})
    if len(matches)!=1:
        raise RuntimeError("startup_failed session has no unique exact rejected activation receipt")
    return matches[0]
def require_empty_queue(queue):
    return (queue.get("schema_version")=="compute_queue.v1"
        and queue.get("next_cursor") is None and queue.get("items")==[])
def require_empty_commands(commands):
    count_fields=("pending_count","accepted_count","dispatched_count","running_count",
        "completed_count","rejected_count","failed_count")
    return (commands.get("commands")==[]
        and all(type(commands.get(key)) is int and commands[key]==0 for key in count_fields)
        and commands.get("can_accept_commands") is False)
def require_ready_runtime(runtime):
    return runtime.get("configured") is True and runtime.get("state")=="ready"
def startup_failed_preacceptance(status,run,identity):
    session=status.get("session") or {}
    run_not_found=last_current_run_not_found
    if (run is not None or status.get("run") is not None
            or status.get("solver",{}).get("state")!="startup_failed"
            or status.get("lifecycle",{}).get("solver")!="startup_failed"
            or status.get("lifecycle",{}).get("session_resource")!="active"
            or status.get("lifecycle",{}).get("commandability")!="forbidden"
            or not isinstance(run_not_found,dict)
            or run_not_found.get("status")!=404
            or run_not_found.get("code")!="not_found"
            or run_not_found.get("message")!="no active run"):
        raise RuntimeError("current session is not an unaccepted startup_failed session")
    activation=rejected_startup_marker(status,identity)
    preparation=get("/v2/sessions/current/simulation/preparation")
    failure=preparation.get("failure")
    stages=preparation.get("stages")
    # An ApiError without an application code has two deliberate projections:
    # HTTP rejection uses bad_request; preparation uses docker_startup_failed.
    # Bind that exact fallback to the same bounded original error message.
    rejection=activation["rejection"]
    failure_code_matches=isinstance(failure,dict) and (
        failure.get("error_code")==rejection.get("code")
        or (failure.get("error_code")=="docker_startup_failed"
            and rejection.get("code")=="bad_request"
            and rejection.get("http_status")==400
            and isinstance(failure.get("summary"),str) and bool(failure["summary"].strip())
            and rejection["message"].startswith(failure["summary"])))
    if (preparation.get("status")!="failed"
            or preparation.get("active_stage_id") is not None
            or not isinstance(preparation.get("started_at_unix_ms"),int)
            or isinstance(preparation.get("started_at_unix_ms"),bool)
            or not isinstance(preparation.get("completed_at_unix_ms"),int)
            or isinstance(preparation.get("completed_at_unix_ms"),bool)
            or preparation["completed_at_unix_ms"]<preparation["started_at_unix_ms"]
            or not isinstance(failure,dict)
            or not failure_code_matches
            or not isinstance(failure.get("summary"),str) or not failure["summary"].strip()
            or not isinstance(failure.get("stage_id"),str)
            or not isinstance(stages,list) or not stages
            or any(not isinstance(stage,dict)
                or stage.get("status") not in {"completed","failed","pending","skipped"}
                for stage in stages)
            or not any(stage.get("id")==failure["stage_id"] and stage.get("status")=="failed"
                for stage in stages)):
        raise RuntimeError("startup_failed session has no terminal failed-preparation receipt")
    queue=get("/v2/platform/compute/queue")
    commands=get("/v2/sessions/current/simulation/commands")
    runtime=get("/v2/platform/runtime-service")
    if not require_empty_queue(queue):
        raise RuntimeError("startup_failed pre-acceptance restart requires an empty unpaginated queue")
    if not require_empty_commands(commands):
        raise RuntimeError("startup_failed pre-acceptance restart requires an empty command ledger")
    if not require_ready_runtime(runtime):
        raise RuntimeError("startup_failed pre-acceptance restart requires a ready native runtime")
    after=get("/v2/sessions/current/status")
    after_run=get("/v2/sessions/current/simulation/runs/current",optional=True)
    after_run_not_found=last_current_run_not_found
    after_preparation=get("/v2/sessions/current/simulation/preparation")
    after_queue=get("/v2/platform/compute/queue")
    after_commands=get("/v2/sessions/current/simulation/commands")
    after_runtime=get("/v2/platform/runtime-service")
    after_session=after.get("session") or {}
    after_identity=tuple(after_session.get(k) for k in ("session_id","session_epoch","request_scope_epoch"))
    if (after_identity!=identity or after.get("solver",{}).get("state")!="startup_failed"
            or after.get("lifecycle",{}).get("solver")!="startup_failed"
            or after.get("lifecycle",{}).get("session_resource")!="active"
            or after.get("lifecycle",{}).get("commandability")!="forbidden"
            or after.get("resources")!=status.get("resources")
            or after_session.get("script",{}).get("path")!=activation["marker"]["authorization"].get("container_script_path")
            or after_run is not None or after.get("run") is not None
            or after_run_not_found!=run_not_found
            or after_preparation!=preparation or after_queue!=queue
            or after_commands!=commands or not require_empty_queue(after_queue)
            or not require_empty_commands(after_commands)
            or not require_ready_runtime(after_runtime)
            or after_runtime.get("configured")!=runtime.get("configured")):
        raise RuntimeError("startup_failed pre-acceptance proof changed during observation")
    raw_after,marker_after=read_startup_marker(activation["key"])
    if raw_after!=activation["raw"] or marker_after!=activation["marker"]:
        raise RuntimeError("rejected startup activation receipt changed during observation")
    return {"schema":"fullmag.docker-preaccepted-startup-failure-drain-preflight.v1",
        "api_instance_id":instance,"session_id":identity[0],"session_epoch":identity[1],
        "request_scope_epoch":identity[2],"current_run_status":404,
        "current_run_not_found":run_not_found,
        "startup_activation":{"receipt_key":activation["key"],
            "receipt_sha256":hashlib.sha256(activation["raw"]).hexdigest(),
            "request_id":activation["request_id"],"source_sha256":activation["source_sha256"],
            "source_relative":activation["source_relative"],
            "rejection":activation["rejection"]},
        "session_status":{"solver":status.get("solver"),"lifecycle":status.get("lifecycle"),
            "resources":status.get("resources"),"session":session},
        "preparation":preparation,"compute_queue":queue,"commands":commands,
        "runtime_service":runtime}
def held_run_proofs(items):
    config_path=os.environ.get("FULLMAG_RUNTIME_SERVICE_CONFIG")
    if not config_path or not os.path.isabs(config_path):
        raise RuntimeError("prepared restart has no native service configuration")
    flags=os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK
    with os.fdopen(os.open(config_path,flags),"rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise RuntimeError("native configuration is not a regular file")
        raw=source.read(MAX+1)
    if len(raw)>MAX: raise RuntimeError("native configuration exceeds restart bound")
    root=json.loads(raw,object_pairs_hook=unique_object).get("store_root")
    if not isinstance(root,str) or not os.path.isabs(root) or os.path.realpath(root)!=root:
        raise RuntimeError("prepared restart store is not canonical")
    root_fd=os.open(root,flags|os.O_DIRECTORY)
    try:
        runs_fd=os.open("runs",flags|os.O_DIRECTORY,dir_fd=root_fd)
        try:
            proofs={}
            for run_id in sorted({item["run_id"] for item in items}):
                if not isinstance(run_id,str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}",run_id):
                    raise RuntimeError("prepared restart queue has an invalid run identity")
                run_fd=os.open(run_id,flags|os.O_DIRECTORY,dir_fd=runs_fd)
                try:
                    fd=os.open("run_intent.json",flags,dir_fd=run_fd)
                    with os.fdopen(fd,"rb") as source:
                        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                            raise RuntimeError("accepted intent is not a regular file")
                        raw=source.read(MAX+1)
                    if len(raw)>MAX: raise RuntimeError("accepted intent exceeds restart bound")
                    intent=json.loads(raw,object_pairs_hook=unique_object)
                    policy=(intent.get("specification") or {}).get("parameters",{}).get("fullmag.accepted_run_start")
                    if intent.get("run_id")!=run_id or policy!={"schema_version":"accepted_run_start_policy.v1","mode":"manual"}:
                        raise RuntimeError("prepared restart requires an explicitly held manual run")
                    try: os.stat("start_release.json",dir_fd=run_fd,follow_symlinks=False)
                    except FileNotFoundError: pass
                    else: raise RuntimeError("prepared restart refuses a released Compute gate")
                    proofs[run_id]=hashlib.sha256(raw).hexdigest()
                finally: os.close(run_fd)
            return proofs
        finally: os.close(runs_fd)
    finally: os.close(root_fd)
def get(path,optional=False):
    global instance,last_current_run_not_found
    headers={"Accept":"application/json","Host":"localhost"}
    if instance: headers["x-fullmag-api-instance"]=instance
    request=urllib.request.Request("http://127.0.0.1:8081"+path,headers=headers)
    try:
        response=urllib.request.urlopen(request,timeout=30)
    except urllib.error.HTTPError as error:
        if (optional and error.code==404 and instance is not None
                and error.headers.get_all("x-fullmag-api-instance")==[instance]):
            try:
                raw_error=error.read(MAX+1)
                if len(raw_error)>MAX:
                    raise RuntimeError("optional current-run error exceeds restart bound")
                error_document=json.loads(raw_error,object_pairs_hook=unique_object)
            finally:
                error.close()
            if (path!="/v2/sessions/current/simulation/runs/current"
                    or not isinstance(error_document,dict)
                    or error_document.get("code")!="not_found"
                    or error_document.get("message")!="no active run"
                    or error_document.get("error")!="no active run"):
                raise RuntimeError("current run is not the exact no-active-run 404")
            last_current_run_not_found={"status":404,"code":"not_found",
                "message":"no active run","api_instance_id":instance}
            return None
        raise
    with response:
        ids=response.headers.get_all("x-fullmag-api-instance") or []
        if len(ids)!=1 or not re.fullmatch(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}",ids[0]):
            raise RuntimeError("terminal restart probe has no exact API identity")
        if instance is not None and instance!=ids[0]:
            raise RuntimeError("API identity changed during terminal restart probe")
        instance=ids[0]
        raw=response.read(MAX+1)
        if response.status!=200 or len(raw)>MAX:
            raise RuntimeError("terminal restart response is unavailable or too large")
    value=json.loads(raw)
    if not isinstance(value,dict): raise RuntimeError("invalid terminal restart response")
    return value
status=get("/v2/sessions/current/status")
session=status.get("session") or {}
identity=tuple(session.get(k) for k in ("session_id","session_epoch","request_scope_epoch"))
if not all(isinstance(v,str) and v for v in identity):
    raise RuntimeError("terminal restart has no current session identity")
run=get("/v2/sessions/current/simulation/runs/current",optional=True)
terminal={"completed","failed","cancelled","stopped"}
prepared=bool(ALLOW_PREPARED and run and run.get("status")=="waiting_for_solve"
    and status.get("solver",{}).get("state")=="awaiting_command")
if (not STARTUP_ENABLED and run is None
        and status.get("solver",{}).get("state")=="startup_failed"):
    print(json.dumps(startup_failed_preacceptance(status,run,identity),sort_keys=True))
elif STARTUP_ENABLED or run is None or (run.get("status") not in terminal and not prepared):
    print("null")
else:
    run_id=run.get("run_id")
    if (not isinstance(run_id,str) or not run_id
            or run.get("session_id")!=identity[0]
            or status.get("run",{}).get("run_id")!=run_id
            or status.get("solver",{}).get("state") not in
                (terminal|{"idle"}|({"awaiting_command"} if prepared else set()))):
        raise RuntimeError("terminal run differs from the current session")
    queue=get("/v2/platform/compute/queue")
    runtime=get("/v2/platform/runtime-service")
    items=queue.get("items")
    if (queue.get("schema_version")!="compute_queue.v1" or queue.get("next_cursor") is not None
            or not isinstance(items,list)
            or (not ALLOW_PREPARED and items!=[])
            or (ALLOW_PREPARED and any(not isinstance(item,dict)
                or item.get("state")!="accepted" for item in items))):
        raise RuntimeError("restart requires no running or released computation")
    held_items=items+([{"run_id":run_id}] if prepared else [])
    held_runs=held_run_proofs(held_items) if ALLOW_PREPARED and held_items else {}
    if prepared:
        preparation=get("/v2/sessions/current/simulation/preparation")
        stages=get("/v2/sessions/current/simulation/stages/execution")
        commands=get("/v2/sessions/current/simulation/commands")
        if (preparation.get("status")!="ready" or preparation.get("failure") is not None
                or status.get("resources",{}).get("mesh_revision",0)<=0
                or stages.get("run_id")!=run_id
                or stages.get("runtime_state")!="awaiting_command"
                or not stages.get("stage_statuses")
                or len(stages["stage_statuses"])!=stages.get("total_stages")
                or stages.get("completed_stage_indexes")!=[]
                or any(value!="pending" for value in stages["stage_statuses"])
                or commands.get("commands")!=[]):
            raise RuntimeError("prepared restart requires a ready mesh and a never-started Study")
    if runtime.get("configured") is not True or runtime.get("state")!="ready":
        raise RuntimeError("terminal restart requires a live native runtime for drain")
    after=get("/v2/sessions/current/status")
    after_run=get("/v2/sessions/current/simulation/runs/current")
    if (tuple((after.get("session") or {}).get(k) for k in
              ("session_id","session_epoch","request_scope_epoch"))!=identity
            or after.get("run",{}).get("run_id")!=run_id
            or after.get("solver",{}).get("state")!=status.get("solver",{}).get("state")
            or after_run.get("run_id")!=run_id
            or after_run.get("session_id")!=identity[0]
            or after_run.get("status")!=run.get("status")
            or after_run.get("revision")!=run.get("revision")):
        raise RuntimeError("terminal session changed before drain")
    if prepared and any((after.get("resources") or {}).get(key)!=(status.get("resources") or {}).get(key)
            for key in ("scene_revision","mesh_revision","stages_revision","commands_revision",
                        "command_completion_revision","simulation_preparation_revision")):
        raise RuntimeError("prepared session changed before drain")
    if held_runs and held_run_proofs(held_items)!=held_runs:
        raise RuntimeError("manual start gate changed before drain")
    result={"schema":("fullmag.docker-prepared-session-drain-preflight.v1" if prepared
            else "fullmag.docker-terminal-session-drain-preflight.v1"),
        "api_instance_id":instance,"session_id":identity[0],"session_epoch":identity[1],
        "request_scope_epoch":identity[2],"run":run,"compute_queue":queue,
        "runtime_service":runtime}
    if held_runs: result["held_run_intent_sha256"]=held_runs
    print(json.dumps(result,sort_keys=True))
'''
    )
    return json.loads(docker_text(
        "exec", backend_id, "/usr/local/bin/python3", "-B", "-c", script,
    ))


def _read_cancelled_activation_bytes(control, relative, *, optional=False):
    """Read one bounded, immutable control-volume file with its raw bytes."""
    path = control.path(relative)
    script = control_read_script(path, _MAX_CANCELLED_ACTIVATION_RECORD_BYTES)
    result = bounded_capture(control.helper_args(script), data=b"", timeout=90)
    if optional and result.returncode == 44:
        return None
    if result.returncode:
        raise BuildControlError(
            f"Cannot read cancelled activation record {relative}: "
            + result.stderr.decode("utf-8", "replace")[-2048:]
        )
    raw = bytes(result.stdout)
    if len(raw) > _MAX_CANCELLED_ACTIVATION_RECORD_BYTES:
        raise BuildControlError(f"Cancelled activation record {relative} exceeds its size bound")
    return raw


def _read_cancelled_activation_record(control, relative, *, optional=False):
    """Read one bounded, immutable control-volume JSON record with its bytes."""
    raw = _read_cancelled_activation_bytes(control, relative, optional=optional)
    if raw is None:
        return None, None

    def reject_duplicate_keys(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise BuildControlError(f"Cancelled activation record {relative} contains a duplicate key")
            value[key] = item
        return value

    try:
        document = json.loads(raw.decode("utf-8"), object_pairs_hook=reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError(f"Cancelled activation record {relative} is invalid JSON: {error}") from error
    if not isinstance(document, dict):
        raise BuildControlError(f"Cancelled activation record {relative} is not an object")
    return document, raw


def _cancelled_activation_probe_script() -> str:
    # This script is passed on stdin to the already pinned backend. It
    # only reads bounded regular files while holding both writer locks. It does
    # not import application code and cannot publish a cancellation itself.
    return r'''import fcntl, hashlib, json, os, pathlib, stat, sys, time, urllib.error, urllib.request, uuid

MAX=8*1024*1024
MAX_PREPARATION_EVIDENCE_RECORDS=6
preparation_evidence_budget={"records":0,"bytes":0}
run_id, task_id, request_id, source_sha, marker_path, store_root, ledger_root, expected_scene_revision = sys.argv[1:]

def fail(message): raise RuntimeError(message)
def regular(path, label, maximum=MAX):
    path=pathlib.Path(path)
    if not path.is_absolute() or ".." in path.parts or path.is_symlink(): fail(label+" path is unsafe")
    try: fd=os.open(path, os.O_RDONLY|getattr(os, "O_NOFOLLOW", 0))
    except OSError as error: raise RuntimeError(label+" cannot be opened") from error
    try:
        meta=os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_size>maximum: fail(label+" is not bounded regular")
        chunks=[]; total=0
        while total<=maximum:
            chunk=os.read(fd, min(65536, maximum+1-total))
            if not chunk: break
            chunks.append(chunk); total+=len(chunk)
        if total>maximum: fail(label+" exceeds size bound")
        return b"".join(chunks)
    finally: os.close(fd)
def obj(path, label):
    try: value=json.loads(regular(path,label).decode("utf-8"))
    except (UnicodeDecodeError,json.JSONDecodeError) as error: raise RuntimeError(label+" is invalid JSON") from error
    if not isinstance(value,dict): fail(label+" is not an object")
    return value
def strict_obj(raw, label):
    def unique(pairs):
        value={}
        for key,item in pairs:
            if key in value: fail(label+" contains a duplicate key")
            value[key]=item
        return value
    try: value=json.loads(raw.decode("utf-8"),object_pairs_hook=unique)
    except (UnicodeDecodeError,json.JSONDecodeError) as error: raise RuntimeError(label+" is invalid JSON") from error
    if not isinstance(value,dict): fail(label+" is not an object")
    return value
def read_records(root, label, max_depth=0):
    root=pathlib.Path(root)
    if root.is_symlink(): fail(label+" is a symbolic link")
    if not root.exists(): return []
    if not root.is_dir(): fail(label+" is not a directory")
    found=[]
    def walk_error(error): fail(label+" cannot be inspected")
    for current,dirs,files in os.walk(root,topdown=True,onerror=walk_error,followlinks=False):
        current=pathlib.Path(current)
        depth=len(current.relative_to(root).parts)
        for name in list(dirs):
            path=current/name
            if path.is_symlink() or not path.is_dir() or depth>=max_depth: fail(label+" contains an invalid directory")
        for name in files:
            path=current/name
            if path.is_symlink() or not path.is_file() or path.suffix!=".json": fail(label+" contains an invalid file")
            raw=regular(path,label+" record")
            preparation_evidence_budget["records"]+=1
            preparation_evidence_budget["bytes"]+=len(raw)
            if (preparation_evidence_budget["records"]>MAX_PREPARATION_EVIDENCE_RECORDS
                    or preparation_evidence_budget["bytes"]>MAX): fail("preparation evidence exceeds its bound")
            found.append({"path":path.relative_to(run).as_posix(),"value":strict_obj(raw,label+" record"),"raw":raw})
    found.sort(key=lambda record:record["path"])
    return found
def digest(raw): return hashlib.sha256(raw).hexdigest()
def is_sha(value): return isinstance(value,str) and len(value)==64 and all(char in "0123456789abcdef" for char in value)
def is_prefixed_sha(value): return isinstance(value,str) and len(value)==71 and value.startswith("sha256:") and is_sha(value[7:])
def canon(value): return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":"),allow_nan=False).encode("utf-8")
def ordered_json(value): return json.dumps(value,ensure_ascii=False,sort_keys=False,separators=(",",":"),allow_nan=False).encode("utf-8")
def preparation_plan_v2_bytes(plan):
    plan_fields={"schema_version","problem_fingerprint","source","requested_backend","resolved_backend",
                 "geometry","display","grid","mesh","space"}
    if not isinstance(plan,dict) or set(plan)!=plan_fields or plan.get("schema_version")!="preparation_plan.v2":
        fail("accepted preparation plan is not the closed typed v2 schema")
    if not is_prefixed_sha(plan.get("problem_fingerprint")):
        fail("accepted preparation plan problem fingerprint is invalid")
    source=plan.get("source")
    source_fields={"kind","run_id","specification_fingerprint","step_id"}
    if (not isinstance(source,dict) or set(source)!=source_fields
            or source.get("kind")!="accepted_run_step"
            or not all(isinstance(source.get(key),str) and source.get(key)
                       for key in ("run_id","specification_fingerprint","step_id"))
            or not is_prefixed_sha(source.get("specification_fingerprint"))):
        fail("accepted preparation plan source is not the closed typed v2 schema")
    requested=plan.get("requested_backend")
    resolved=plan.get("resolved_backend")
    if requested not in {"auto","fdm","fem"} or resolved not in {"fdm","fem"}:
        fail("accepted preparation plan backend is invalid")
    ordered={
        "schema_version":plan["schema_version"],
        "problem_fingerprint":plan["problem_fingerprint"],
        "source":{
            "kind":source["kind"],
            "run_id":source["run_id"],
            "specification_fingerprint":source["specification_fingerprint"],
            "step_id":source["step_id"],
        },
        "requested_backend":requested,
        "resolved_backend":resolved,
    }
    producer_fields={"kind","producer_id","schema_version","producer_version",
                     "input_fingerprint","output_fingerprint"}
    for kind in ("geometry","display","grid","mesh","space"):
        producer=plan.get(kind)
        if (not isinstance(producer,dict) or set(producer)!=producer_fields
                or producer.get("kind")!=kind
                or any(not isinstance(producer.get(key),str) or not producer.get(key)
                       for key in ("producer_id","schema_version","producer_version"))
                or not is_prefixed_sha(producer.get("input_fingerprint"))
                or not is_prefixed_sha(producer.get("output_fingerprint"))):
            fail("accepted preparation plan producer is not the closed typed v2 schema")
        ordered[kind]={
            "kind":producer["kind"],
            "producer_id":producer["producer_id"],
            "schema_version":producer["schema_version"],
            "producer_version":producer["producer_version"],
            "input_fingerprint":producer["input_fingerprint"],
            "output_fingerprint":producer["output_fingerprint"],
        }
    return ordered_json(ordered)
def lock(path,label):
    path=pathlib.Path(path)
    if not path.is_file() or path.is_symlink(): fail(label+" is missing")
    fd=os.open(path,os.O_RDWR|getattr(os,"O_NOFOLLOW",0))
    deadline=time.monotonic()+5
    while True:
        try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); return fd
        except BlockingIOError as error:
            if time.monotonic()>=deadline: os.close(fd); raise RuntimeError(label+" remained busy") from error
            time.sleep(0.05)
        except OSError as error: os.close(fd); raise RuntimeError(label+" lock outcome is unknown") from error
def matching_json(root, label, predicate):
    root=pathlib.Path(root)
    if not root.exists(): return []
    if root.is_symlink() or not root.is_dir(): fail(label+" is not a directory")
    found=[]
    for current, dirs, files in os.walk(root,topdown=True,followlinks=False):
        current=pathlib.Path(current)
        for name in list(dirs):
            if (current/name).is_symlink(): fail(label+" contains a symlink")
        for name in files:
            path=current/name
            if path.is_symlink() or not path.is_file(): fail(label+" contains an invalid file")
            value=obj(path,label+" record")
            if predicate(value): found.append(str(path))
    return found
def ensure_empty_tree(root,label):
    root=pathlib.Path(root)
    if not root.exists(): return
    if root.is_symlink() or not root.is_dir(): fail(label+" is not a directory")
    for current, dirs, files in os.walk(root,topdown=True,followlinks=False):
        current=pathlib.Path(current)
        for name in list(dirs):
            if (current/name).is_symlink(): fail(label+" contains a symlink")
        for name in files:
            path=current/name
            if path.is_symlink() or not path.is_file(): fail(label+" contains an invalid file")
            fail(label+" contains a durable record")
def api_get(path,label):
    request=urllib.request.Request("http://127.0.0.1:8081"+path,headers={"Accept":"application/json","Host":"localhost"})
    try:
        with urllib.request.urlopen(request,timeout=5) as response:
            data=response.read(MAX+1)
            if len(data)>MAX: fail(label+" response exceeds size bound")
            if response.status!=200: fail(label+" returned HTTP "+str(response.status))
            value=json.loads(data.decode("utf-8"))
            if not isinstance(value,dict): fail(label+" response is not an object")
            return value,response.headers.get("x-fullmag-api-instance"),digest(data)
    except urllib.error.HTTPError as error:
        try: error.read(MAX+1)
        except OSError: pass
        fail(label+" returned HTTP "+str(error.code))
    except (OSError,urllib.error.URLError,UnicodeDecodeError,json.JSONDecodeError) as error:
        raise RuntimeError(label+" cannot be read") from error

store=pathlib.Path(store_root)
ledger=pathlib.Path(ledger_root)
if (not store.is_absolute() or ".." in store.parts or store.is_symlink()
        or not ledger.is_absolute() or ".." in ledger.parts or ledger.is_symlink()): fail("probe roots are unsafe")
ledger_fd=None
try:
    ledger_fd=lock(ledger/"WRITER.lock","host ledger writer lock")
    store_fd=lock(store/"WRITER.lock","accepted store writer lock")
    runs=store/"runs"
    if runs.is_symlink() or not runs.is_dir(): fail("accepted run root is not a real directory")
    run=store/"runs"/run_id
    if run.is_symlink() or not run.is_dir(): fail("accepted run directory is not a real directory")
    intent_path=run/"run_intent.json"
    catalog_path=run/"run_catalog.json"
    cancellation_path=run/"task_cancellation_intents"/(task_id+".json")
    intent_raw=regular(intent_path,"accepted RunIntent")
    catalog_raw=regular(catalog_path,"run catalog")
    cancellation_raw=regular(cancellation_path,"cancellation intent")
    intent=obj(intent_path,"accepted RunIntent")
    catalog=obj(catalog_path,"run catalog")
    cancellation=obj(cancellation_path,"cancellation intent")
    if intent.get("schema_version")!="run_intent.v1" or intent.get("run_id")!=run_id: fail("RunIntent identity/schema differs")
    expected_intent_key="live-http-"+digest(request_id.encode("utf-8"))
    if intent.get("idempotency_key")!=expected_intent_key: fail("RunIntent idempotency identity is not bound to the startup request")
    if not isinstance(intent.get("payload_sha256"),str) or intent.get("payload_sha256")!=digest(canon(intent.get("specification"))): fail("RunIntent payload digest differs")
    specification=intent.get("specification")
    if not isinstance(specification,dict): fail("RunIntent specification is not an object")
    accepted_spec_fingerprint="sha256:"+digest(canon(specification))
    parameters=specification.get("parameters")
    if not isinstance(parameters,dict): fail("RunIntent parameters are missing")
    live=parameters.get("live_workspace")
    if not isinstance(live,dict): fail("RunIntent live workspace binding is missing")
    api_instance_id=live.get("api_instance_id")
    session_id=live.get("session_id")
    session_epoch=live.get("session_epoch")
    scene_revision=live.get("scene_revision")
    if (not isinstance(api_instance_id,str) or not api_instance_id
            or not isinstance(session_id,str) or not session_id
            or not isinstance(session_epoch,int) or isinstance(session_epoch,bool) or session_epoch<0
            or not isinstance(scene_revision,int) or isinstance(scene_revision,bool) or scene_revision<0):
        fail("RunIntent live workspace identity is malformed")
    if (live.get("command_id")!=request_id
            or live.get("request_idempotency_key")!=request_id
            or live.get("startup_source_sha256")!=source_sha):
        fail("RunIntent live workspace request/source binding differs")
    command=live.get("command")
    if (not isinstance(command,dict) or command.get("kind")!="startup_script"
            or command.get("request_id")!=request_id or command.get("source_sha256")!=source_sha):
        fail("RunIntent live workspace startup command differs")
    policy=parameters.get("fullmag.accepted_run_start")
    if (not isinstance(policy,dict) or policy.get("schema_version")!="accepted_run_start_policy.v1"
            or policy.get("mode")!="manual"):
        fail("RunIntent accepted start policy is not manual")
    if catalog.get("schema_version")!="run_catalog.v1" or catalog.get("run_id")!=run_id or not isinstance(catalog.get("revision"),int) or catalog.get("revision",0)<=0: fail("run catalog identity/schema differs")
    tasks=catalog.get("tasks")
    if not isinstance(tasks,list) or not tasks: fail("run catalog has no tasks")
    target=None
    task_ids=set()
    for task in tasks:
        if not isinstance(task,dict) or not isinstance(task.get("task_id"),str): fail("run catalog task is malformed")
        if task.get("task_id") in task_ids: fail("run catalog contains duplicate task identity")
        task_ids.add(task.get("task_id"))
        if task.get("lifecycle")!="cancelled": fail("run catalog still has a non-cancelled task")
        for key in ("attempt_id","resource_id","resolved_input_fingerprint","coordinator_watermark","coordinator_genesis"):
            if task.get(key) is not None: fail("run catalog retains an owner on a cancelled task")
        if task.get("artifact_ids",[])!=[]: fail("cancelled task retains output artifacts")
        if task.get("task_id")==task_id: target=task
    if target is None: fail("target task is missing from the run catalog")
    if cancellation.get("schema_version")!="task_cancellation_intent.v1" or cancellation.get("run_id")!=run_id: fail("cancellation intent identity/schema differs")
    if cancellation.get("task",{}).get("task_id")!=task_id: fail("cancellation intent task differs")
    if cancellation.get("task",{}).get("lifecycle") not in {"accepted","queued"}: fail("cancellation intent was not pre-claim")
    if cancellation.get("task",{}).get("input_fingerprint")!=target.get("input_fingerprint"): fail("cancellation intent input scope differs")
    if cancellation.get("expected_catalog_revision",0)>catalog.get("revision",0): fail("cancellation intent revision is ahead of catalog")
    semantic={k:cancellation.get(k) for k in ("schema_version","cancellation_id","run_id","expected_catalog_revision","task","reason")}
    if cancellation.get("request_sha256")!=digest(canon(semantic)): fail("cancellation intent digest differs")
    if cancellation.get("cancellation_id") is None: fail("cancellation identity is missing")

    ensure_empty_tree(run/"task_admissions","cancelled run task admissions")
    task_receipts=read_records(run/"task_preparation_receipts","task preparation receipts")
    stage_receipts=read_records(run/"accepted_stage_preparation_receipts","accepted stage preparation receipts")
    prep_launches=read_records(run/"preparation_process_launches","preparation process launches")
    prep_exits=read_records(run/"preparation_process_exit_receipts","preparation process exits")
    prep_leases=read_records(run/"preparation_resource_leases","preparation resource leases",1)
    preparation_records=task_receipts+stage_receipts+prep_launches+prep_exits+prep_leases
    preparation_evidence=[]
    if not task_receipts:
        if preparation_records: fail("preparation evidence is orphaned from its task receipt")
    else:
        if (len(task_receipts)!=1 or task_receipts[0]["path"]!="task_preparation_receipts/"+task_id+".json"
                or len(stage_receipts)>1 or len(prep_launches)!=1 or len(prep_exits)!=1 or len(prep_leases)!=1):
            fail("cancelled task preparation evidence is not unique")
        receipt_record=task_receipts[0]
        receipt=receipt_record["value"]
        step_id=receipt.get("step_id")
        input_fingerprint=target.get("input_fingerprint")
        if (set(receipt)!={"schema_version","run_id","task_id","step_id","input_fingerprint",
                           "preparation_id","plan_fingerprint","payload_sha256","payload","created_at"}
                or not isinstance(receipt.get("created_at"),str)
                or not isinstance(step_id,str) or not step_id or len(step_id.encode("utf-8"))>256
                or any(ord(char)<32 or 127<=ord(char)<=159 or char in "/\\" for char in step_id)):
            fail("task preparation receipt step identity is invalid")
        expected_task_id="task-"+digest((run_id+"\0"+step_id).encode("utf-8"))
        if (receipt.get("schema_version")!="task_preparation_receipt.v1"
                or receipt.get("run_id")!=run_id or receipt.get("task_id")!=task_id
                or expected_task_id!=task_id or not is_sha(input_fingerprint)
                or receipt.get("input_fingerprint")!=input_fingerprint
                or receipt.get("preparation_id")!="prep-"+task_id):
            fail("task preparation receipt run/task/step/fingerprint differs")
        payload=receipt.get("payload")
        plan_fingerprint=receipt.get("plan_fingerprint")
        payload_sha=receipt.get("payload_sha256")
        if (not isinstance(payload,dict) or not is_prefixed_sha(plan_fingerprint)
                or payload_sha!=digest(canon(payload))):
            fail("task preparation receipt payload digest differs")
        payload_schema=payload.get("schema_version")
        plan=payload.get("plan")
        if (payload_schema not in {"preparation_receipt.v1","closed_loop_preparation_receipt.v1"}
                or payload.get("preparation_id")!="prep-"+task_id
                or payload.get("plan_fingerprint")!=plan_fingerprint or not isinstance(plan,dict)):
            fail("task preparation receipt plan identity differs")
        plan_bytes=(preparation_plan_v2_bytes(plan) if payload_schema=="preparation_receipt.v1"
                    else canon(plan))
        if "sha256:"+digest(plan_bytes)!=plan_fingerprint:
            fail("task preparation receipt plan fingerprint differs")
        source=plan.get("source")
        if not isinstance(source,dict) or source.get("run_id")!=run_id or source.get("step_id")!=step_id:
            fail("task preparation receipt source run/step differs")
        if payload_schema=="preparation_receipt.v1":
            accepted_source=payload.get("accepted_run_source")
            if (source.get("kind")!="accepted_run_step" or not isinstance(accepted_source,dict)
                    or accepted_source.get("schema_version")!="accepted_run_preparation_source.v1"
                    or accepted_source.get("run_id")!=run_id or accepted_source.get("step_id")!=step_id
                    or accepted_source.get("specification_fingerprint")!=accepted_spec_fingerprint
                    or source.get("specification_fingerprint")!=accepted_source.get("specification_fingerprint")
                    or plan.get("problem_fingerprint")!=accepted_source.get("problem_fingerprint")
                    or not is_prefixed_sha(accepted_source.get("problem_fingerprint"))):
                fail("task preparation receipt accepted source differs")
        elif (plan.get("schema_version")!="closed_loop_preparation_plan.v1"
                or source.get("schema_version")!="accepted_run_preparation_source.v1"
                or source.get("specification_fingerprint")!=accepted_spec_fingerprint
                or plan.get("problem_fingerprint")!=source.get("problem_fingerprint")
                or any(not is_prefixed_sha(plan.get(field)) for field in
                       ("problem_fingerprint","carrier_fingerprint","operation_fingerprint","source_mesh_fingerprint"))):
            fail("task preparation receipt closed-loop source differs")
        if stage_receipts:
            stage_record=stage_receipts[0]
            stage=stage_record["value"]
            if (set(stage)!={"schema_version","run_id","step_id","task_id","input_fingerprint",
                             "preparation_id","plan_fingerprint","task_receipt_payload_sha256"}
                    or stage_record["path"]!="accepted_stage_preparation_receipts/"+task_id+".json"
                    or stage.get("schema_version")!="accepted_stage_preparation_receipt.v1"
                    or stage.get("run_id")!=run_id or stage.get("task_id")!=task_id
                    or stage.get("step_id")!=step_id
                    or stage.get("input_fingerprint")!=receipt.get("input_fingerprint")
                    or stage.get("preparation_id")!=receipt.get("preparation_id")
                    or stage.get("plan_fingerprint")!=plan_fingerprint
                    or stage.get("task_receipt_payload_sha256")!=payload_sha):
                fail("accepted stage preparation receipt differs from its task receipt")
        launch_record=prep_launches[0]; launch=launch_record["value"]
        exit_record=prep_exits[0]; process_exit=exit_record["value"]
        lease_record=prep_leases[0]; prep_lease=lease_record["value"]
        launch_id=launch.get("launch_id"); exit_id=process_exit.get("receipt_id")
        preparation_attempt=launch.get("preparation_attempt_id")
        resource_id=launch.get("resource_id"); lease_token=launch.get("lease_token")
        launch_heartbeat=launch.get("lease_heartbeat_sequence")
        exit_heartbeat=process_exit.get("lease_heartbeat_sequence")
        lease_heartbeat=prep_lease.get("heartbeat_sequence")
        launch_required={"schema_version","launch_id","run_id","task_id","preparation_attempt_id",
                         "resource_id","lease_token","lease_heartbeat_sequence","supervisor_process_id","created_at"}
        exit_required={"schema_version","receipt_id","run_id","task_id","preparation_attempt_id",
                       "resource_id","lease_token","lease_heartbeat_sequence","process_id",
                       "status_success","exit_code","timed_out","observed_at"}
        lease_required={"schema_version","resource_id","budget","run_id","task_id","preparation_attempt_id",
                        "lease_token","state","acquired_at","heartbeat_at","heartbeat_sequence","released_at"}
        if (not all(isinstance(value,str) and value and len(value)<=200
                    and value[0] in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
                    and all(char in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-" for char in value)
                    and not value.endswith(".") for value in (launch_id,exit_id,preparation_attempt,resource_id,lease_token))
                or not isinstance(launch_heartbeat,int) or isinstance(launch_heartbeat,bool) or launch_heartbeat<0
                or not isinstance(exit_heartbeat,int) or isinstance(exit_heartbeat,bool) or exit_heartbeat<0
                or not isinstance(lease_heartbeat,int) or isinstance(lease_heartbeat,bool) or lease_heartbeat<0
                or exit_heartbeat<launch_heartbeat or exit_heartbeat!=lease_heartbeat):
            fail("preparation process identity is invalid")
        identity={"run_id":run_id,"task_id":task_id,"preparation_attempt_id":preparation_attempt,
                  "resource_id":resource_id,"lease_token":lease_token}
        if (launch_record["path"]!="preparation_process_launches/"+launch_id+".json"
                or not launch_required.issubset(launch) or not set(launch).issubset(launch_required|{"supervisor_start_token"})
                or launch.get("schema_version")!="preparation_process_launch.v1"
                or exit_id!="prep-exit-"+launch_id
                or not isinstance(launch.get("supervisor_process_id"),int)
                or isinstance(launch.get("supervisor_process_id"),bool) or launch.get("supervisor_process_id",0)<=0
                or not isinstance(launch.get("created_at"),str)
                or any(launch.get(key)!=value for key,value in identity.items())
                or exit_record["path"]!="preparation_process_exit_receipts/"+exit_id+".json"
                or not exit_required.issubset(process_exit)
                or not set(process_exit).issubset(exit_required|{"process_start_token","failure_reason"})
                or process_exit.get("schema_version")!="preparation_process_exit_receipt.v1"
                or any(process_exit.get(key)!=value for key,value in identity.items())
                or process_exit.get("lease_heartbeat_sequence")!=exit_heartbeat
                or process_exit.get("status_success") is not True
                or not isinstance(process_exit.get("exit_code"),int)
                or isinstance(process_exit.get("exit_code"),bool) or process_exit.get("exit_code")!=0
                or process_exit.get("timed_out") is not False or process_exit.get("failure_reason") is not None
                or not isinstance(process_exit.get("process_id"),int) or isinstance(process_exit.get("process_id"),bool)
                or process_exit.get("process_id",0)<=0 or not isinstance(process_exit.get("observed_at"),str)):
            fail("preparation process does not have one successful exact exit proof")
        if (lease_record["path"]!="preparation_resource_leases/"+resource_id+"/"+lease_token+".json"
                or not lease_required.issubset(prep_lease)
                or not set(prep_lease).issubset(lease_required|{"host_launch_binding"})
                or prep_lease.get("schema_version")!="preparation_resource_lease.v1"
                or any(prep_lease.get(key)!=value for key,value in identity.items())
                or prep_lease.get("heartbeat_sequence")!=exit_heartbeat
                or prep_lease.get("state")!="released"
                or not isinstance(prep_lease.get("released_at"),str) or not prep_lease.get("released_at")
                or not isinstance(prep_lease.get("budget"),dict)
                or any(not isinstance(prep_lease.get(key),str) for key in ("acquired_at","heartbeat_at"))):
            fail("preparation resource lease is not released for the exact process")
        preparation_evidence=sorted(
            ({"path":record["path"],"sha256":digest(record["raw"])} for record in preparation_records),
            key=lambda item:item["path"],
        )
    solver_matches=matching_json(run/"resource_leases","solver resource leases",lambda value: value.get("run_id")==run_id and value.get("task_id") in task_ids and value.get("state")!="released")
    if solver_matches: fail("task has an active or uncertain solver lease")

    ledger_raw=regular(ledger/"HOST_RESOURCE_LEDGER.json","host resource ledger")
    ledger_doc=strict_obj(ledger_raw,"host resource ledger")
    reservations=ledger_doc.get("reservations")
    if not isinstance(reservations,list): fail("host resource ledger reservations are missing")
    ledger_policy=ledger_doc.get("policy")
    if not isinstance(ledger_policy,dict): fail("host resource ledger policy is missing")
    matching=[]
    preparation_host_reservations=[]
    reservation_required={"identity","request_sha256","host_id","policy_revision","host_owner_epoch",
                          "topology_sha256","budget","release_proof_sha256","state",
                          "preparation_launch_gate","preparation_launch_owner"}
    reservation_allowed=reservation_required|{"runtime_generation_sha256","compute_node_owner_id",
                          "compute_node_owner_epoch","exclusive_gpu_uuids","gpu_vram_bytes_by_uuid",
                          "cpu_ids","node_policy_revision","scheduling_priority","parallelism"}
    for row in reservations:
        if not isinstance(row,dict): fail("host resource ledger reservation is malformed")
        identity=row.get("identity")
        if isinstance(identity,dict) and identity.get("run_id")==run_id and identity.get("task_id") in task_ids:
            if row.get("state")!="released":
                matching.append(row)
                continue
            if not task_receipts or preparation_host_reservations:
                fail("host resource ledger retains an unexpected released task reservation")
            if (not reservation_required.issubset(row)
                    or not set(row).issubset(reservation_allowed)
                    or "worker_launch_gate" in row):
                fail("released preparation reservation fields are invalid")
            owner_identity=identity.get("owner")
            if (set(identity)!={"store_id","run_id","task_id","resource_id","owner","lease_token"}
                    or not isinstance(owner_identity,dict)
                    or set(owner_identity)!={"kind","preparation_attempt_id"}
                    or owner_identity.get("kind")!="preparation"
                    or identity.get("run_id")!=run_id or identity.get("task_id")!=task_id
                    or identity.get("resource_id")!=resource_id
                    or identity.get("lease_token")!=lease_token
                    or owner_identity.get("preparation_attempt_id")!=preparation_attempt
                    or not is_prefixed_sha(identity.get("store_id"))):
                fail("released preparation reservation identity differs from its exact process")
            request_sha=row.get("request_sha256")
            proof_sha=row.get("release_proof_sha256")
            if not is_sha(request_sha) or not is_sha(proof_sha):
                fail("released preparation reservation proof digests are invalid")
            binding=prep_lease.get("host_launch_binding")
            if not isinstance(binding,dict):
                fail("released preparation reservation has no host launch binding")
            binding_required={"schema_version","ledger_root","policy"}
            binding_allowed=binding_required|{"runtime_generation_sha256"}
            if (not binding_required.issubset(binding) or not set(binding).issubset(binding_allowed)
                    or binding.get("schema_version")!="host_launch_binding.v1"
                    or not isinstance(binding.get("ledger_root"),str)
                    or pathlib.Path(binding["ledger_root"])!=ledger
                    or binding.get("policy")!=ledger_policy):
                fail("preparation lease host binding differs from the pinned ledger")
            binding_policy=binding["policy"]
            for key in ("revision","owner_epoch"):
                value=binding_policy.get(key)
                if not isinstance(value,int) or isinstance(value,bool) or value<=0:
                    fail("preparation host policy identity is invalid")
            if (not isinstance(binding_policy.get("host_id"),str) or not binding_policy["host_id"]
                    or not is_sha(binding_policy.get("topology_sha256"))):
                fail("preparation host policy identity is invalid")
            for key in ("policy_revision","host_owner_epoch"):
                value=row.get(key)
                if not isinstance(value,int) or isinstance(value,bool) or value<=0:
                    fail("released preparation reservation policy fence is invalid")
            if (row.get("host_id")!=binding_policy.get("host_id")
                    or row.get("policy_revision")!=binding_policy.get("revision")
                    or row.get("host_owner_epoch")!=binding_policy.get("owner_epoch")
                    or row.get("topology_sha256")!=binding_policy.get("topology_sha256")):
                fail("released preparation reservation differs from its bound host policy")
            generation=binding.get("runtime_generation_sha256")
            policy_schema=binding_policy.get("schema_version")
            if policy_schema not in {"host_resource_ledger_policy.v1","host_resource_ledger_policy.v2","host_resource_ledger_policy.v3"}:
                fail("preparation host binding policy schema is unsupported")
            if ((policy_schema in {"host_resource_ledger_policy.v2","host_resource_ledger_policy.v3"} and generation is None)
                    or (generation is not None and not is_sha(generation))):
                fail("preparation host binding runtime generation is invalid")
            if row.get("runtime_generation_sha256")!=generation:
                fail("released preparation reservation runtime generation differs")
            owner=row.get("preparation_launch_owner")
            owner_required={"schema_version","launch_id","launch_sha256","supervisor_process_id","supervisor_start_token"}
            if (not isinstance(owner,dict) or set(owner)!=owner_required
                    or owner.get("schema_version")!="host_preparation_launch_owner.v1"
                    or owner.get("launch_id")!=launch_id
                    or owner.get("launch_sha256")!=digest(canon(launch))
                    or not isinstance(owner.get("supervisor_process_id"),int)
                    or isinstance(owner.get("supervisor_process_id"),bool)
                    or owner.get("supervisor_process_id",0)<=0
                    or owner.get("supervisor_process_id")!=launch.get("supervisor_process_id")
                    or owner.get("supervisor_start_token")!=launch.get("supervisor_start_token")
                    or not isinstance(owner.get("supervisor_start_token"),str)
                    or not owner["supervisor_start_token"]):
                fail("released preparation reservation is not bound to the exact launch owner")
            gate=row.get("preparation_launch_gate")
            if (not isinstance(gate,dict) or set(gate)!={"state","token"}
                    or gate.get("state")!="consumed" or not isinstance(gate.get("token"),str)):
                fail("released preparation reservation has no consumed launch gate")
            try:
                if str(uuid.UUID(gate["token"]))!=gate["token"]:
                    fail("released preparation launch gate token is not canonical")
            except (ValueError, AttributeError):
                fail("released preparation launch gate token is invalid")
            budget=row.get("budget")
            budget_fields={"cpu_millis","memory_bytes","gpu_memory_bytes","storage_bytes"}
            if (not isinstance(budget,dict) or set(budget)!=budget_fields
                    or budget!=prep_lease.get("budget")
                    or any(not isinstance(budget[key],int) or isinstance(budget[key],bool) or budget[key]<0
                           for key in budget_fields)
                    or any(budget[key]<=0 for key in ("cpu_millis","memory_bytes","storage_bytes"))
                    or budget["gpu_memory_bytes"]!=0):
                fail("released preparation reservation budget differs from its exact lease")
            proof_dir=ledger/"proofs"
            if proof_dir.is_symlink() or not proof_dir.is_dir():
                fail("released preparation proof directory is missing or unsafe")
            proof_raw=regular(proof_dir/(proof_sha+".json"),"preparation host release proof")
            preparation_evidence_budget["records"]+=1
            preparation_evidence_budget["bytes"]+=len(proof_raw)
            if (preparation_evidence_budget["records"]>MAX_PREPARATION_EVIDENCE_RECORDS
                    or preparation_evidence_budget["bytes"]>MAX):
                fail("preparation evidence exceeds its bound")
            release_proof=strict_obj(proof_raw,"preparation host release proof")
            proof_fields={"schema_version","kind","host_id","store_id","request_sha256",
                          "preparation_receipt","released_preparation_lease","preparation_launch_owner"}
            if (digest(proof_raw)!=proof_sha or set(release_proof)!=proof_fields
                    or release_proof.get("schema_version")!="host_resource_release_proof.v1"
                    or release_proof.get("kind")!="preparation"
                    or release_proof.get("host_id")!=row.get("host_id")
                    or release_proof.get("store_id")!=identity.get("store_id")
                    or release_proof.get("request_sha256")!=request_sha
                    or canon(release_proof.get("preparation_receipt"))!=canon(process_exit)
                    or canon(release_proof.get("released_preparation_lease"))!=canon(prep_lease)
                    or canon(release_proof.get("preparation_launch_owner"))!=canon(owner)):
                fail("released preparation reservation lacks its exact immutable release proof")
            preparation_host_reservations.append({"identity":identity,"sha256":digest(canon(row))})
    if (task_receipts and isinstance(prep_lease.get("host_launch_binding"),dict)
            and len(preparation_host_reservations)!=1):
        fail("host-bound preparation evidence has no exact released reservation")
    preparation_host_reservations.sort(key=lambda item:canon(item["identity"]))

    expected_scene_revision=int(expected_scene_revision)
    marker_raw=regular(marker_path,"startup activation marker")
    marker=obj(marker_path,"startup activation marker")
    expected_key=hashlib.sha256(request_id.encode("utf-8")).hexdigest()
    expected_path="/opt/fullmag/control/backend/script-activation-"+expected_key+"/activation.json"
    if marker_path!=expected_path: fail("startup activation marker path differs from request")
    if marker.get("schema")!="fullmag.docker-startup-activation-receipt.v1" or marker.get("state")!="started": fail("startup activation marker is not the unchanged started marker")
    if marker.get("request_id")!=request_id or marker.get("source_sha256")!=source_sha: fail("startup activation marker request/source fence differs")
    auth=marker.get("authorization")
    if not isinstance(auth,dict) or auth.get("request_id")!=request_id or auth.get("source_sha256")!=source_sha: fail("startup activation authorization fence differs")
    # The cancellation is terminal. Release writer leases before asking the
    # API for liveness: its native observer also needs those same writers.
    fcntl.flock(store_fd,fcntl.LOCK_UN); os.close(store_fd); store_fd=None
    fcntl.flock(ledger_fd,fcntl.LOCK_UN); os.close(ledger_fd); ledger_fd=None
    current_status,current_api_instance,current_status_sha256=api_get("/v2/sessions/current/status","current live session status")
    current_session=current_status.get("session")
    if not isinstance(current_session,dict): fail("current live session status has no session")
    if (current_session.get("session_id")!=session_id
            or not isinstance(current_session.get("created_at"),str)
            or not current_session["created_at"].isdigit()
            or current_session.get("session_epoch")!=session_id+"@"+current_session["created_at"]
            or current_session.get("request_scope_epoch")!=api_instance_id+":"+str(session_epoch)):
        fail("current live session identity differs from RunIntent")
    if current_api_instance!=api_instance_id: fail("current API instance differs from RunIntent")
    current_document, current_document_instance, _ = api_get("/v2/sessions/current", "current session")
    if (current_document.get("current") is not True
            or current_document.get("session_id") != session_id
            or current_document.get("script", {}).get("sha256") != source_sha
            or current_document_instance != api_instance_id):
        fail("current session script identity differs from the cancelled activation")
    run_request=urllib.request.Request("http://127.0.0.1:8081/v2/sessions/current/simulation/runs/current",headers={"Accept":"application/json","Host":"localhost"})
    retained_current_run_sha256=None
    try:
        with urllib.request.urlopen(run_request,timeout=5) as response:
            run_raw=response.read(MAX+1)
            if (response.status!=200 or len(run_raw)>MAX
                    or response.headers.get("x-fullmag-api-instance")!=api_instance_id):
                fail("retained current run response identity is invalid")
            retained_run=strict_obj(run_raw,"retained current run")
            # Stop retains a read-model record with status stopping even when
            # every durable task is cancelled before claim. This is history,
            # not a process owner: the native proofs above remain mandatory.
            if (retained_run.get("run_id")!=run_id
                    or retained_run.get("session_id")!=session_id
                    or retained_run.get("started_at")!=current_session["created_at"]
                    or retained_run.get("status") not in {"stopping","stopped","cancelled"}
                    or current_status.get("solver",{}).get("state") not in {"breaking","stopped","cancelled","idle"}
                    or any(value is not None for key,value in retained_run.items()
                           if key=="solver_time_seconds" or key.startswith("final_"))):
                fail("retained current run is not the exact pre-Compute cancelled read model")
            retained_current_run_sha256=digest(run_raw)
    except urllib.error.HTTPError as error:
        if error.code != 404: fail("current run absence is not confirmed")
        if error.headers.get("x-fullmag-api-instance") != api_instance_id:
            fail("current run API instance differs")
        error.read(MAX+1)
    except (OSError,urllib.error.URLError) as error:
        raise RuntimeError("current run absence cannot be read") from error
    scene, _, _ = api_get("/v2/sessions/current/model/scene", "current live scene")
    observed_scene_revision=scene.get("revision")
    if observed_scene_revision is None: observed_scene_revision=scene.get("scene_revision")
    if observed_scene_revision!=expected_scene_revision or observed_scene_revision!=scene_revision:
        fail("current API scene revision differs from the accepted scene")
    queue, _, _ = api_get("/v2/platform/compute/queue", "compute queue")
    if queue.get("schema_version")!="compute_queue.v1" or queue.get("items")!=[]:
        fail("compute queue is not empty")
    runtime, _, _ = api_get("/v2/platform/runtime-service", "native runtime service")
    reason=runtime.get("reason")
    if (runtime.get("configured") is not True or runtime.get("state")!="ready"
            or not isinstance(reason,dict) or reason.get("code")!="service_ready"):
        fail("native runtime service is not ready")
    health, _, _ = api_get("/v2/platform/health", "platform health")
    if health.get("status")!="ok" or health.get("active_session") is not True:
        fail("cancelled activation requires the pinned stale active session")
    if matching: fail("host resource ledger retains a cancelled task reservation")
    probe={"schema":"fullmag.docker-activation-cancel-probe.v1","run_id":run_id,"task_id":task_id,"request_id":request_id,"source_sha256":source_sha,"catalog_revision":catalog["revision"],"cancellation_id":cancellation["cancellation_id"],"run_intent_sha256":digest(intent_raw),"run_catalog_sha256":digest(catalog_raw),"cancellation_intent_sha256":digest(cancellation_raw),"activation_marker_sha256":digest(marker_raw),"host_ledger_sha256":digest(ledger_raw),"matching_reservations":len(matching),"task_count":len(tasks),"live_api_instance_id":api_instance_id,"live_session_id":session_id,"live_session_epoch":session_epoch,"live_scene_revision":scene_revision,"live_workspace_sha256":digest(canon(live)),"current_session_sha256":current_status_sha256,"scene":scene,"compute_queue":queue,"runtime_service":runtime,"health":health}
    if retained_current_run_sha256 is not None: probe["retained_current_run_sha256"]=retained_current_run_sha256
    if preparation_evidence: probe["preparation_evidence"]=preparation_evidence
    if preparation_host_reservations: probe["preparation_host_reservations"]=preparation_host_reservations
    print(json.dumps(probe,sort_keys=True))
finally:
    if ledger_fd is not None: fcntl.flock(ledger_fd,fcntl.LOCK_UN); os.close(ledger_fd)
    if "store_fd" in locals() and store_fd is not None: fcntl.flock(store_fd,fcntl.LOCK_UN); os.close(store_fd)
'''



def _cancelled_activation_store_probe(
    backend_id, *, run_id, task_id, request_id, source_sha256, marker_path,
    expected_scene_revision, environment,
):
    """Recheck cancelled store ownership and the live API from the image.

    Writer locks protect the bounded durable snapshot and are released before
    HTTP liveness checks. Cancelled tasks cannot acquire new native owners.
    The caller repeats this check after stopping the private frontend.
    """
    store_root = environment.get("FULLMAG_RUNS_ROOT", "/state/runs/docker-all") + "/session-store"
    ledger_root = environment.get("FULLMAG_HOST_LEDGER_ROOT", "/host-ledger/ledger")
    result = docker_capture(
        "exec", "-i", backend_id, "/usr/local/bin/python3", "-B", "-",
        run_id, task_id, request_id, source_sha256, marker_path,
        store_root, ledger_root, str(expected_scene_revision),
        data=_cancelled_activation_probe_script().encode("utf-8"),
        timeout=90, allow_failure=True,
    )
    if result.returncode:
        raise BuildControlError(
            "Cancelled activation store preflight failed: "
            + result.stderr.decode("utf-8", "replace")[-4096:]
        )
    try:
        value = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Cancelled activation store preflight returned invalid JSON") from error
    if not isinstance(value, dict) or value.get("schema") != "fullmag.docker-activation-cancel-probe.v1":
        raise BuildControlError("Cancelled activation store preflight returned an invalid schema")
    if "preparation_evidence" in value:
        value["preparation_evidence"] = _cancelled_activation_preparation_evidence(
            value["preparation_evidence"], "store probe preparation evidence",
        )
    if "preparation_host_reservations" in value:
        value["preparation_host_reservations"] = _cancelled_activation_preparation_host_reservations(
            value["preparation_host_reservations"], "store probe preparation host reservations",
        )
    return value



def _cancelled_activation_sha(value, label):
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise BuildControlError(f"Cancelled activation {label} is not a SHA-256 digest")
    return value


def _cancelled_activation_preparation_evidence(value, label):
    if not isinstance(value, list) or len(value) > 5:
        raise BuildControlError(f"Cancelled activation {label} is not a bounded manifest")
    path_pattern = re.compile(
        r"(?:task_preparation_receipts|accepted_stage_preparation_receipts|"
        r"preparation_process_launches|preparation_process_exit_receipts)/"
        r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json|"
        r"preparation_resource_leases/[A-Za-z0-9][A-Za-z0-9._-]{0,199}/"
        r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json"
    )
    result = []
    previous = None
    for entry in value:
        if not isinstance(entry, Mapping) or set(entry) != {"path", "sha256"}:
            raise BuildControlError(f"Cancelled activation {label} entry is invalid")
        path = entry.get("path")
        if not isinstance(path, str) or path_pattern.fullmatch(path) is None:
            raise BuildControlError(f"Cancelled activation {label} path is invalid")
        if previous is not None and path <= previous:
            raise BuildControlError(f"Cancelled activation {label} is not strictly ordered")
        previous = path
        result.append({
            "path": path,
            "sha256": _cancelled_activation_sha(entry.get("sha256"), label + " digest"),
        })
    return result


def _cancelled_activation_preparation_host_reservations(value, label):
    if not isinstance(value, list) or len(value) > 1:
        raise BuildControlError(f"Cancelled activation {label} is not a bounded manifest")
    result = []
    previous = None
    identity_fields = {"store_id", "run_id", "task_id", "resource_id", "owner", "lease_token"}
    for entry in value:
        if not isinstance(entry, Mapping) or set(entry) != {"identity", "sha256"}:
            raise BuildControlError(f"Cancelled activation {label} entry is invalid")
        identity = entry.get("identity")
        if not isinstance(identity, Mapping) or set(identity) != identity_fields:
            raise BuildControlError(f"Cancelled activation {label} identity is invalid")
        store_id = identity.get("store_id")
        if not isinstance(store_id, str) or not store_id.startswith("sha256:"):
            raise BuildControlError(f"Cancelled activation {label} store identity is invalid")
        _cancelled_activation_sha(store_id[7:], label + " store identity")
        for key in ("run_id", "task_id", "resource_id", "lease_token"):
            _cancelled_activation_id(identity.get(key), label + " " + key)
        owner = identity.get("owner")
        if (not isinstance(owner, Mapping)
                or set(owner) != {"kind", "preparation_attempt_id"}
                or owner.get("kind") != "preparation"):
            raise BuildControlError(f"Cancelled activation {label} owner is invalid")
        _cancelled_activation_id(owner.get("preparation_attempt_id"), label + " preparation attempt")
        sort_key = json.dumps(dict(identity), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if previous is not None and sort_key <= previous:
            raise BuildControlError(f"Cancelled activation {label} is not strictly ordered")
        previous = sort_key
        result.append({
            "identity": {
                "store_id": store_id,
                "run_id": identity["run_id"],
                "task_id": identity["task_id"],
                "resource_id": identity["resource_id"],
                "owner": {
                    "kind": "preparation",
                    "preparation_attempt_id": owner["preparation_attempt_id"],
                },
                "lease_token": identity["lease_token"],
            },
            "sha256": _cancelled_activation_sha(entry.get("sha256"), label + " row digest"),
        })
    return result


def _cancelled_activation_id(value, label, *, request=False):
    pattern = r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}" if request else r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}"
    if not isinstance(value, str) or re.fullmatch(pattern, value) is None or value in {".", ".."}:
        raise BuildControlError(f"Cancelled activation {label} is not a portable identifier")
    if not request and value.endswith("."):
        raise BuildControlError(f"Cancelled activation {label} is not a portable identifier")
    return value


def _validate_cancelled_activation_preflight(
    control, previous_root, previous, document, selected, config_sha256, backend_id, environment,
    *, require_quiesced_activation=True,
):
    """Accept the stale active-session exception only for one immutable proof."""
    current, current_raw = _read_cancelled_activation_record(
        control, "activation/current.json", optional=True
    )
    if current is None or current_raw is None:
        # No script activation was cancelled: the session is a live one (for
        # example created by `fm.connect()`), and restarting would end it.
        raise BuildControlError(
            "Restart refused: the backend has an active session and no cancelled script "
            "activation; the active session is never interrupted"
        )
    if (current.get("schema") != "fullmag.docker-build-operation.v1"
            or current.get("phase") != "activation"
            or current.get("compose_project") != control.project
            or current.get("control_volume") != control.volume
            or current.get("state") != "failed-confirmed"
            or current.get("activation_state") != "accepted-then-cancelled"):
        raise BuildControlError("Current activation is not a failed accepted-then-cancelled terminal")
    activation_attempt = current.get("attempt")
    if (not isinstance(activation_attempt, str)
            or _CANCELLED_ACTIVATION_ATTEMPT.fullmatch(activation_attempt) is None):
        raise BuildControlError("Current cancelled activation attempt is invalid")
    terminal, terminal_raw = _read_cancelled_activation_record(
        control, f"activation/attempts/{activation_attempt}/terminal.json"
    )
    if terminal_raw != current_raw or terminal != current:
        raise BuildControlError("Current activation pointer differs from its immutable terminal")
    proof, proof_raw = _read_cancelled_activation_record(
        control, f"activation/attempts/{activation_attempt}/accepted-then-cancelled.json"
    )
    if proof is None or proof_raw is None:
        raise BuildControlError("Accepted-then-cancelled activation proof is missing")
    if (proof.get("schema") != _CANCELLED_ACTIVATION_SCHEMA
            or proof.get("state") != "accepted-then-cancelled"):
        raise BuildControlError("Accepted-then-cancelled activation proof schema/state differs")
    proof_sha256 = hashlib.sha256(proof_raw).hexdigest()
    if current.get("cancellation_proof_sha256") != proof_sha256:
        raise BuildControlError("Current activation proof digest differs")

    inputs = current.get("inputs")
    if not isinstance(inputs, Mapping):
        raise BuildControlError("Cancelled activation inputs are missing")
    previous_inputs = previous.get("inputs")
    image_id = previous_inputs.get("image_id") if isinstance(previous_inputs, Mapping) else None
    development_attempt = previous_root.rsplit("/", 1)[-1]
    expected = {
        "activation_attempt": activation_attempt,
        "development_attempt": development_attempt,
        "compose_project": control.project,
        "config_sha256": config_sha256,
        "source_root": str(selected),
        "image_id": image_id,
        "backend_container": backend_id,
    }
    for key, value in expected.items():
        if proof.get(key) != value:
            raise BuildControlError(f"Cancelled activation proof {key} differs")
    for key, value in {
        "development_attempt": development_attempt,
        "config_sha256": config_sha256,
        "source_root": str(selected),
        "backend_container": backend_id,
        "image_id": image_id,
    }.items():
        if inputs.get(key) != value:
            raise BuildControlError(f"Cancelled activation input/{key} differs")

    request_id = proof.get("request_id")
    source_sha256 = proof.get("source_sha256")
    run_id = proof.get("run_id")
    task_id = proof.get("task_id")
    cancellation_id = proof.get("cancellation_id")
    _cancelled_activation_id(request_id, "request_id", request=True)
    _cancelled_activation_sha(source_sha256, "source_sha256")
    _cancelled_activation_id(run_id, "run_id")
    _cancelled_activation_id(task_id, "task_id")
    _cancelled_activation_id(cancellation_id, "cancellation_id")
    if inputs.get("request_id") != request_id or inputs.get("source_sha256") != source_sha256:
        raise BuildControlError("Cancelled activation input request/source differs")
    for key, value in {"run_id": run_id, "task_id": task_id, "cancellation_id": cancellation_id}.items():
        if current.get(key) != value:
            raise BuildControlError(f"Current activation {key} differs")

    expected_key = hashlib.sha256(request_id.encode("utf-8")).hexdigest()
    expected_marker = "/opt/fullmag/control/backend/script-activation-" + expected_key + "/activation.json"
    if (inputs.get("activation_receipt_path") != expected_marker
            or inputs.get("activation_receipt_key") != expected_key):
        raise BuildControlError("Cancelled activation marker path is not request-bound")
    # The service may not carry the wrapper's receipt key.  The immutable
    # activation input and image-side marker are the authorization boundary.

    for key in (
        "config_sha256", "source_sha256", "unknown_receipt_sha256",
        "activation_marker_sha256", "run_intent_sha256", "run_catalog_sha256",
        "cancellation_intent_sha256", "host_ledger_sha256", "live_workspace_sha256",
        "current_session_sha256", "probe_sha256",
    ):
        _cancelled_activation_sha(proof.get(key), "proof " + key)
    for key in ("live_api_instance_id", "live_session_id"):
        if not isinstance(proof.get(key), str) or not proof[key]:
            raise BuildControlError(f"Cancelled activation proof {key} is missing")
    for key in ("live_session_epoch", "live_scene_revision", "catalog_revision"):
        value = proof.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise BuildControlError(f"Cancelled activation proof {key} is invalid")
    if proof["catalog_revision"] <= 0:
        raise BuildControlError("Cancelled activation proof catalog_revision is invalid")
    helper_name = proof.get("helper_container")
    if not isinstance(helper_name, str) or helper_name != "fullmag-control-" + activation_attempt:
        raise BuildControlError("Cancelled activation proof helper identity differs")
    helper_id = proof.get("helper_container_id")
    if not isinstance(helper_id, str) or re.fullmatch(r"[0-9a-f]{64}", helper_id) is None:
        raise BuildControlError("Cancelled activation proof helper container id is invalid")

    if require_quiesced_activation and _read_cancelled_activation_bytes(control, "active", optional=True) is not None:
        raise BuildControlError("Original accepted activation helper still holds the control lease")
    fresh_probe = _cancelled_activation_store_probe(
        backend_id, run_id=run_id, task_id=task_id, request_id=request_id,
        source_sha256=source_sha256, marker_path=expected_marker,
        expected_scene_revision=proof["live_scene_revision"], environment=environment,
    )
    for key, value in {
        "run_id": run_id, "task_id": task_id, "request_id": request_id,
        "source_sha256": source_sha256,
        "catalog_revision": proof["catalog_revision"],
        "cancellation_id": cancellation_id,
        "run_intent_sha256": proof["run_intent_sha256"],
        "run_catalog_sha256": proof["run_catalog_sha256"],
        "cancellation_intent_sha256": proof["cancellation_intent_sha256"],
        "activation_marker_sha256": proof["activation_marker_sha256"],
        "live_api_instance_id": proof["live_api_instance_id"],
        "live_session_id": proof["live_session_id"],
        "live_session_epoch": proof["live_session_epoch"],
        "live_scene_revision": proof["live_scene_revision"],
        "live_workspace_sha256": proof["live_workspace_sha256"],
        "matching_reservations": 0,
    }.items():
        if fresh_probe.get(key) != value:
            raise BuildControlError(f"Fresh cancelled activation probe {key} differs")
    if fresh_probe.get("schema") != "fullmag.docker-activation-cancel-probe.v1":
        raise BuildControlError("Fresh cancelled activation probe schema differs")
    fresh_preparation_evidence = _cancelled_activation_preparation_evidence(
        fresh_probe.get("preparation_evidence", []), "fresh probe preparation evidence",
    )
    if "preparation_evidence" not in proof:
        if fresh_preparation_evidence:
            raise BuildControlError("Historical cancelled activation proof omits preparation evidence")
    elif _cancelled_activation_preparation_evidence(
            proof["preparation_evidence"], "proof preparation evidence") != fresh_preparation_evidence:
        raise BuildControlError("Fresh cancelled activation preparation evidence differs from proof")
    fresh_preparation_host_reservations = _cancelled_activation_preparation_host_reservations(
        fresh_probe.get("preparation_host_reservations", []), "fresh probe preparation host reservations",
    )
    if "preparation_host_reservations" not in proof:
        if fresh_preparation_host_reservations:
            raise BuildControlError("Historical cancelled activation proof omits preparation host reservations")
    elif _cancelled_activation_preparation_host_reservations(
            proof["preparation_host_reservations"], "proof preparation host reservations") != fresh_preparation_host_reservations:
        raise BuildControlError("Fresh cancelled activation preparation host reservations differ from proof")
    retained_current_run_sha256 = fresh_probe.get("retained_current_run_sha256")
    if retained_current_run_sha256 is not None:
        _cancelled_activation_sha(retained_current_run_sha256, "fresh retained current run")
    if proof.get("retained_current_run_sha256") != retained_current_run_sha256:
        raise BuildControlError("Fresh cancelled activation retained current run differs from proof")
    # Heartbeats and other worktrees legitimately change these snapshots.
    # Immutable run/catalog/cancellation/marker identity was checked above.
    for key in ("host_ledger_sha256", "current_session_sha256"):
        _cancelled_activation_sha(fresh_probe.get(key), "fresh probe " + key)
    if fresh_probe.get("compute_queue", {}).get("items") != []:
        raise BuildControlError("Fresh cancelled activation probe found queued compute")
    runtime = fresh_probe.get("runtime_service")
    if (not isinstance(runtime, Mapping) or runtime.get("configured") is not True
            or runtime.get("state") != "ready"):
        raise BuildControlError("Fresh cancelled activation probe found an unready runtime")
    health = fresh_probe.get("health")
    if not isinstance(health, Mapping) or health.get("status") != "ok" or health.get("active_session") is not True:
        raise BuildControlError("Fresh cancelled activation probe lost the pinned active session")
    return {"proof_sha256": proof_sha256, "probe": fresh_probe, "runtime": fresh_probe}


def _retained_startup_enabled(container):
    """Match the image entrypoint's opt-in startup rule using effective env."""
    environment = dict(item.split("=", 1) for item in container.get("Config", {}).get("Env", []) if "=" in item)
    value = environment.get("FULLMAG_STARTUP_ENABLED", "0")
    if value not in {"0", "1"}:
        raise BuildControlError("Retained startup activation setting is invalid")
    return value == "1"


_SAVED_AUTHORING_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
_SAVED_EMPTY_AUTHORING_RESTART_SCHEMA = 'fullmag.saved-empty-authoring-restart.v1'


_SAVED_AUTHORING_SCENE_FIELDS = (
    'version', 'revision', 'scene', 'universe', 'objects', 'couplings', 'materials',
    'magnetization_assets', 'field_drives', 'monitors', 'selections',
    'magnetization_constraints', 'current_modules', 'current_transports',
    'spin_transports', 'spin_torques', 'oersted_fields', 'study', 'outputs', 'editor',
    'antenna_port_modes', 'antenna_field_solve_stages', 'antenna_target_projections',
    'solved_antenna_drives', 'antenna_spectrum_requests',
)


def _saved_authoring_require(value, message):
    if not value:
        raise BuildControlError('Saved authoring restart: ' + message)


def _saved_authoring_sha(value):
    return hashlib.sha256(value).hexdigest()


def _saved_authoring_document(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            _saved_authoring_require(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=unique,
                       parse_constant=lambda value: _saved_authoring_require(False, 'non-finite JSON'))
    _saved_authoring_require(isinstance(value, dict), 'JSON object required')
    return value


def _saved_authoring_validate_request(request, *, project, attempt, config_sha256, selected):
    empty_authoring = isinstance(request, dict) and request.get('schema') == _SAVED_EMPTY_AUTHORING_RESTART_SCHEMA
    if empty_authoring:
        _saved_authoring_require(not any(key in request for key in (
            'cancelled_preclaim', 'historical_preclaim', 'retained_run_catalogs')),
            'empty authoring checkpoint cannot include run-history extensions')
    cancelled = preclaim_restart.validate_checkpoint(request)
    historical = preclaim_restart.validate_historical_checkpoint(request)
    retained = retained_history.validate_retained_catalogs(request)
    _saved_authoring_require(set(request) == ({'schema', 'compose_project', 'attempt', 'config_sha256',
        'source_root', 'exclusive_operator_window', 'archive', 'session', 'containers',
        'package', 'service_owner_sha256'} | ({'cancelled_preclaim'} if cancelled else set())
        | ({'historical_preclaim'} if historical else set())
        | ({'retained_run_catalogs'} if retained is not None else set())), 'checkpoint fields differ')
    _saved_authoring_require(request['schema'] in {'fullmag.saved-authoring-restart.v1', preclaim_restart.SCHEMA,
                                                    _SAVED_EMPTY_AUTHORING_RESTART_SCHEMA}
        and request['compose_project'] == project and request['attempt'] == attempt
        and request['config_sha256'] == config_sha256
        and request['source_root'] == str(selected)
        and request['exclusive_operator_window'] is True, 'checkpoint operation/CAS/window differs')
    archive = request['archive']
    _saved_authoring_require(isinstance(archive, dict) and set(archive) == {'path', 'sha256', 'bytes',
        'project_id', 'project_revision', 'scene_revision', 'scene_sha256',
        'source_entry', 'source_sha256'}, 'archive pins differ')
    session = request['session']
    _saved_authoring_require(isinstance(session, dict) and set(session) == {'api_instance_id', 'session_id',
        'session_epoch', 'request_scope_epoch', 'source_kind'}, 'session pins differ')
    for value in (*session.values(), archive['path'], archive['project_id']):
        _saved_authoring_require(isinstance(value, str) and value and len(value) < 4096, 'missing identity pin')
    _saved_authoring_require((archive['source_entry'] is None) == (archive['source_sha256'] is None),
        'source entry and digest must be both present or both absent')
    if empty_authoring:
        _saved_authoring_require(archive['source_entry'] is None and archive['source_sha256'] is None,
            'empty authoring source pins must be explicitly null')
    else:
        _saved_authoring_require(isinstance(archive['source_entry'], str) and archive['source_entry']
            and len(archive['source_entry']) < 4096, 'missing identity pin')
    epoch_pattern = re.escape(session['session_id']) + r'@[0-9]+'
    if cancelled and 'stop_command_id' in cancelled:
        epoch_pattern += r':tombstone:[0-9]+'
    _saved_authoring_require(re.fullmatch(epoch_pattern, session['session_epoch']) is not None
        and session['request_scope_epoch'].startswith(session['api_instance_id'] + ':')
        and session['request_scope_epoch'].split(':')[-1].isdigit(), 'invalid session epoch pins')
    for key in ('bytes', 'project_revision', 'scene_revision'):
        _saved_authoring_require(type(archive[key]) is int and archive[key] >= 0, 'invalid archive numeric pin')
    _saved_authoring_require(0 < archive['bytes'] <= _SAVED_AUTHORING_MAX_ARCHIVE_BYTES, 'archive size exceeds checkpoint budget')
    _saved_authoring_require(isinstance(request['package'], dict) and set(request['package']) ==
        {'provenance_sha256', 'source_snapshot_sha256'}, 'package source pins differ')
    _saved_authoring_require(session['source_kind'] == 'ui_authoring', 'UI authoring source kind differs')
    if empty_authoring:
        _saved_authoring_require(archive['source_entry'] is None, 'empty UI authoring cannot bind a source file')
    else:
        _saved_authoring_require(archive['source_entry'] == 'project/source/script.py'
            or re.fullmatch(r'project/source-history/[0-9a-f]{64}\.py', archive['source_entry']),
            'UI authoring/source archive binding differs')
    hashes = [archive[k] for k in ('sha256', 'scene_sha256')]
    if not empty_authoring:
        hashes.append(archive['source_sha256'])
    hashes += [request['service_owner_sha256'], *request['package'].values()]
    _saved_authoring_require(all(isinstance(v, str) and re.fullmatch('[0-9a-f]{64}', v) for v in hashes), 'invalid digest pin')
    _saved_authoring_require(isinstance(request['containers'], dict) and set(request['containers']) ==
        {'backend', 'frontend'}, 'exact two service pins required')
    for pin in request['containers'].values():
        _saved_authoring_require(isinstance(pin, dict) and set(pin) == {'id', 'image', 'started_at', 'fingerprint'}
            and isinstance(pin['id'], str) and re.fullmatch('[0-9a-f]{64}', pin['id'])
            and isinstance(pin['fingerprint'], str) and re.fullmatch('[0-9a-f]{64}', pin['fingerprint'])
            and isinstance(pin['image'], str) and re.fullmatch('sha256:[0-9a-f]{64}', pin['image'])
            and isinstance(pin['started_at'], str) and pin['started_at'], 'invalid service pin')
    _saved_authoring_require(request['containers']['backend']['id'] != request['containers']['frontend']['id'],
            'services must be distinct')


def _saved_authoring_validate_services(request, actual, *, quiesced=False):
    from docker_volume_reconcile import fingerprint
    for service, pin in request['containers'].items():
        observed = actual[service]
        _saved_authoring_require(observed.get('Id') == pin['id'] and observed.get('Image') == pin['image']
            and observed.get('State', {}).get('StartedAt') == pin['started_at']
            and fingerprint(observed) == pin['fingerprint']
            and observed.get('Config', {}).get('Labels', {}).get('com.docker.compose.project') == request['compose_project']
            and observed.get('Config', {}).get('Labels', {}).get('com.docker.compose.service') == service
            and observed.get('State', {}).get('Running') is (not (quiesced and service == 'frontend')),
            'service incarnation/configuration/state differs: ' + service)


def _saved_authoring_validate_archive(raw, pin):
    _saved_authoring_require(len(raw) == pin['bytes'] and _saved_authoring_sha(raw) == pin['sha256'], 'saved Windows archive changed')
    source_entry = pin.get('source_entry')
    source_sha256 = pin.get('source_sha256')
    source_less = source_entry is None and source_sha256 is None
    _saved_authoring_require((source_entry is None) == (source_sha256 is None),
        'source entry and digest must be both present or both absent')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        _saved_authoring_require(0 < len(entries) <= 8192 and sum(e.file_size for e in entries) <= _SAVED_AUTHORING_MAX_ARCHIVE_BYTES,
                'archive entry/uncompressed size budget exceeded')
        names = [e.filename for e in entries]
        _saved_authoring_require(len(set(names)) == len(names), 'duplicate archive entries')
        for entry in entries:
            path = PurePosixPath(entry.filename)
            mode = entry.external_attr >> 16
            _saved_authoring_require(not entry.is_dir() and not (entry.flag_bits & 1)
                and not stat.S_ISLNK(mode) and (not stat.S_IFMT(mode) or stat.S_ISREG(mode))
                and not path.is_absolute() and '..' not in path.parts
                and str(path) == entry.filename and '\\' not in entry.filename,
                'unsafe archive entry')
        manifest = _saved_authoring_document(archive.read('manifest/project.json'))
        _saved_authoring_require(manifest.get('format') == 'fullmag.project.archive.v1'
            and manifest.get('project_schema') == 'fullmag.project.v1'
            and manifest.get('scene_schema') == 'scene.v2'
            and manifest.get('definition') == 'project/definition.json'
            and manifest.get('scene') == 'project/scene_document.json', 'runtime-free project manifest required')
        allowed = {'manifest/project.json', 'project/definition.json', 'project/scene_document.json'}
        source = manifest.get('source')
        if source_less:
            _saved_authoring_require(source is None, 'empty UI authoring must not contain a source script')
        elif source is not None:
            _saved_authoring_require(source in ('project/source.py', 'project/source/script.py'), 'unexpected authoring source path')
            allowed.add(source)
        assets = manifest.get('assets')
        opaque = manifest.get('opaque_documents')
        _saved_authoring_require(isinstance(assets, list) and isinstance(opaque, list), 'manifest lists missing')
        if source_less:
            _saved_authoring_require(assets == [], 'empty UI authoring cannot contain unbound assets')
        for asset in assets:
            _saved_authoring_require(isinstance(asset, dict) and isinstance(asset.get('path'), str)
                and asset['path'].startswith('assets/'), 'unexpected asset path')
            allowed.add(asset['path'])
        for name in opaque:
            if source_less:
                _saved_authoring_require(isinstance(name, str) and name == 'project/provenance.json',
                    'empty UI authoring cannot contain source files, metadata, or history')
            else:
                _saved_authoring_require(isinstance(name, str) and (name in {'project/provenance.json',
                    'project/source/script.py', 'project/source/script.json'}
                    or re.fullmatch(r'project/source-history/[0-9a-f]{64}\.py', name)),
                    'non-authoring opaque document is not admissible')
            allowed.add(name)
        _saved_authoring_require(set(names) == allowed and (source_less or source_entry in allowed),
            'archive contains missing/extra runtime entries')
        definition = _saved_authoring_document(archive.read('project/definition.json'))
        scene = _saved_authoring_document(archive.read('project/scene_document.json'))
        _saved_authoring_require(definition.get('schema') == 'fullmag.project.v1'
            and definition.get('project_id') == pin['project_id']
            and definition.get('revision') == pin['project_revision']
            and definition.get('scene') == scene and scene.get('version') == 'scene.v2'
            and scene.get('revision') == pin['scene_revision']
            and _saved_authoring_sha(canonical(scene)) == pin['scene_sha256'], 'saved project/revision/scene differs')
        if source_less:
            nested_scene = scene.get('scene')
            _saved_authoring_require(isinstance(nested_scene, dict)
                and nested_scene.get('source_of_truth') == 'ui'
                and ('objects' not in scene or scene['objects'] == []),
                'empty UI authoring scene must have UI source of truth and no objects')
        else:
            _saved_authoring_require(_saved_authoring_sha(archive.read(source_entry)) == source_sha256,
                'preserved authoring source differs')
        if 'project/provenance.json' in allowed:
            provenance = _saved_authoring_document(archive.read('project/provenance.json'))
            _saved_authoring_require(provenance.get('runs') == [], 'archive retains runtime runs')
            if source_less:
                _saved_authoring_require(provenance.get('history', []) == []
                    and provenance.get('authors', []) == []
                    and set(provenance).issubset({'authors', 'history', 'runs'}),
                    'empty UI authoring provenance retains source metadata or history')
        if not source_less and 'project/source/script.json' in allowed:
            _saved_authoring_require(_saved_authoring_document(archive.read('project/source/script.json')).get('sha256') == source_sha256,
                    'source metadata digest differs')
    return scene


def _saved_authoring_read_archive(request, state):
    import fullmag_storage as storage
    read_owned_regular = _session_host().read_owned_regular
    path = Path(request['archive']['path'])
    _saved_authoring_require(path.is_absolute() and path.suffix.lower() == '.fms', 'absolute FMS path required')
    storage.validate_path(path, state / 'runs' / 'projects', 'saved authoring project')
    raw = read_owned_regular(path, maximum=_SAVED_AUTHORING_MAX_ARCHIVE_BYTES)
    return raw, _saved_authoring_validate_archive(raw, request['archive'])


def _saved_authoring_validate_probe(probe, request, scene):
    cancelled = preclaim_restart.validate_checkpoint(request)
    terminal_cancelled = cancelled is not None and 'stop_command_id' in cancelled
    _saved_authoring_require(probe.get('schema') == 'fullmag.saved-authoring-restart-probe.v1', 'probe schema differs')
    rows = probe['resources']
    for row in rows.values():
        _saved_authoring_require(row.get('api_instance_id') == request['session']['api_instance_id'], 'API incarnation differs')
    def body(name, status=200):
        _saved_authoring_require(rows[name].get('status') == status, 'unexpected HTTP result: ' + name)
        return rows[name]['body']
    for suffix in ('before', 'after'):
        current = body('current_' + suffix)
        status = body('status_' + suffix)
        expected = request['session']
        _saved_authoring_require(current.get('current') is True and current.get('session_id') == expected['session_id']
            and current.get('status') == ('cancelled' if terminal_cancelled else ('waiting_for_compute' if cancelled else 'awaiting_command'))
            and expected['source_kind'] == 'ui_authoring'
            and current.get('script') is None and current.get('script_path') == '',
            'UI authoring owner/status/source-kind changed')
        _saved_authoring_require(all(status.get('session', {}).get(k) == expected[k]
            for k in ('session_id', 'session_epoch', 'request_scope_epoch'))
            and (cancelled is not None or status.get('run') is None)
            and status.get('resources', {}).get('scene_revision') == scene['revision']
            and status.get('solver', {}).get('state') in ({'cancelled'} if terminal_cancelled else {'idle', 'awaiting_command'}), 'session epoch/run/readiness differs')
        live = body('scene_' + suffix)
        _saved_authoring_require({k: live[k] for k in _SAVED_AUTHORING_SCENE_FIELDS if k in live} == scene, 'live authored scene differs from durable archive')
    health = body('health')
    _saved_authoring_require(health.get('status') == 'ok' and health.get('active_session') is True, 'pinned authoring session lost')
    _saved_authoring_require(body('queue').get('schema_version') == 'compute_queue.v1'
        and body('queue').get('items') == [], 'compute queue is not empty')
    commands = body('commands')
    if cancelled is None:
        _saved_authoring_require(commands.get('commands') == [] and all(type(commands.get(k)) is int and commands[k] == 0
            for k in ('pending_count', 'accepted_count', 'dispatched_count', 'running_count',
                      'completed_count', 'rejected_count', 'failed_count')), 'command ledger is not empty')
        body('run', 404)
    body('preparation', 404)
    mesh = rows['mesh']
    _saved_authoring_require(mesh['status'] in {200, 404}, 'mesh state is unknown')
    if mesh['status'] == 200:
        mesh_body = mesh['body']
        _saved_authoring_require(all(mesh_body.get(k) is None for k in ('active_build', 'last_build_summary',
            'mesh_pipeline_status', 'shared_domain_build_report', 'source_scene_revision',
            'geometry_realization_revision')), 'mesh build/admission exists')
        provenance = mesh_body.get('provenance')
        if provenance is not None:
            _saved_authoring_require(isinstance(provenance, dict)
                and all(k == 'mesh_revision' or v is None for k, v in provenance.items()),
                'mesh provenance has an accepted build owner')
        published = mesh_body.get('published_resources')
        if published is not None:
            # mesh.rs emits these URLs for any nonzero revision, including an
            # authoring skeleton. Absence of a real manifest is checked below.
            _saved_authoring_require(isinstance(published, dict)
                and set(published) == {'mesh_revision', 'mesh_build_revision', 'manifest',
                                       'quality', 'realized_size_fields'}
                and type(published['mesh_revision']) is int and published['mesh_revision'] >= 0
                and type(published['mesh_build_revision']) is int and published['mesh_build_revision'] >= 0
                and published['mesh_build_revision'] == mesh_body.get('revision')
                and isinstance(provenance, dict) and published['mesh_revision'] == provenance.get('mesh_revision')
                and all(published[k] == '/v2/sessions/current/meshing/meshes/shared-domain/' + suffix
                    for k, suffix in (('manifest', 'manifest'), ('quality', 'quality'),
                                      ('realized_size_fields', 'realized-size-fields'))),
                'mesh publication metadata is not the empty revision fallback')
    _saved_authoring_require(body('mesh_manifest', 204) is None, 'mesh publication is not definitively absent')
    history = rows['mesh_history']
    _saved_authoring_require(history['status'] == 404 or (history['status'] == 200 and history['body'].get('history') == []),
            'mesh history is not empty')
    runtime = body('runtime')
    _saved_authoring_require(runtime.get('configured') is True and runtime.get('state') == 'ready'
        and runtime.get('reason', {}).get('code') == 'service_ready', 'native runtime is not ready')
    opened = body('project_open')
    _saved_authoring_require(opened.get('project_id') == request['archive']['project_id']
        and opened.get('revision') == request['archive']['project_revision']
        and opened.get('schema_version') == 'fullmag.project.v1'
        and opened.get('mode', {}).get('kind') == 'read_write', 'canonical project open differs')
    _saved_authoring_require(isinstance(probe.get('accepted_store_id'), str)
        and re.fullmatch(r'sha256:[0-9a-f]{64}', probe['accepted_store_id'])
        and probe.get('run_directories') == (sorted(row['run_id'] for row in request['retained_run_catalogs'])
            if 'retained_run_catalogs' in request else preclaim_restart.expected_run_directories(request))
        and probe.get('retained_run_catalogs') == retained_history.validate_retained_catalogs(request)
        and probe.get('transient_files') == []
        and isinstance(probe.get('reservation_states'), list)
        and all(s == 'released' for s in probe['reservation_states']), 'durable affected admissions/leases are not empty')
    receipt = probe.get('process_receipt', {})
    _saved_authoring_require(receipt.get('schema') == 'fullmag.docker-process-tree.v1' and receipt.get('state') == 'ready'
        and 'startup_activation' not in receipt
        and _saved_authoring_sha(canonical(receipt.get('service_owner'))) == request['service_owner_sha256'], 'native ready owner differs')
    _saved_authoring_require(probe.get('provenance_sha256') == request['package']['provenance_sha256']
        and probe.get('source_snapshot_sha256') == request['package']['source_snapshot_sha256'], 'captured package source differs')
    preclaim_restart.validate_binding(probe, request)
    preclaim_restart.validate_historical_binding(probe, request)


_SAVED_AUTHORING_PROBE_SCRIPT = retained_history.PROBE_FUNCTION + "\n" + r"""import base64,fcntl,hashlib,json,os,pathlib,stat,sys,time,urllib.error,urllib.parse,urllib.request,uuid
MAX=8*1024*1024
request=json.load(sys.stdin)
pin=request['checkpoint']; session=pin['session']
def canon(value): return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def regular(path):
 path=pathlib.Path(path)
 if not path.is_absolute() or '..' in path.parts or any(p.is_symlink() for p in (path,*path.parents)): raise RuntimeError('unsafe evidence path')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  st=os.fstat(fd)
  if not stat.S_ISREG(st.st_mode) or st.st_size>MAX or st.st_nlink!=1: raise RuntimeError('invalid bounded evidence')
  raw=os.read(fd,MAX+1)
  if len(raw)>MAX: raise RuntimeError('evidence too large')
  return raw
 finally: os.close(fd)
def lock(path):
 fd=os.open(path,os.O_RDWR|os.O_NOFOLLOW)
 deadline=time.monotonic()+5
 try:
  while True:
   try:
    fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    return fd
   except BlockingIOError:
    if time.monotonic()>=deadline: raise RuntimeError('saved-authoring evidence lock busy after 5 seconds')
    time.sleep(0.025)
 except BaseException: os.close(fd);raise
def inventory(root):
 root=pathlib.Path(root)
 if not root.is_dir() or any(p.is_symlink() for p in (root,*root.parents)): raise RuntimeError('unsafe inventory root')
 found=[];count=0
 for current,dirs,files in os.walk(root,followlinks=False):
  for name in dirs+files:
   p=pathlib.Path(current)/name;count+=1
   if count>8192 or p.is_symlink(): raise RuntimeError('unsafe/unbounded inventory')
  for name in files:
   p=pathlib.Path(current)/name
   if not p.is_file(): raise RuntimeError('invalid inventory entry')
   found.append(str(p.relative_to(root)))
 return found
scope='session='+urllib.parse.quote(session['session_id'],safe="~!*'()-._")+'&epoch='+urllib.parse.quote(session['session_epoch'],safe="~!*'()-._")+'&request_scope_epoch='+urllib.parse.quote(session['request_scope_epoch'],safe="~!*'()-._")
def api(path,payload=None):
 headers={'Accept':'application/json','Host':'localhost','x-fullmag-session-scope':scope}
 if payload is not None: headers['Content-Type']='application/json'
 req=urllib.request.Request('http://127.0.0.1:8081'+path,headers=headers,data=None if payload is None else canon(payload))
 try: response=urllib.request.urlopen(req,timeout=10)
 except urllib.error.HTTPError as error: response=error
 with response:
  raw=response.read(MAX+1)
  if len(raw)>MAX: raise RuntimeError('API response exceeded budget')
  if response.status==204 and not raw: value=None
  else:
   value=json.loads(raw)
   if not isinstance(value,dict): raise RuntimeError('API response is not an object')
  return {'status':response.status,'body':value,'api_instance_id':response.headers.get('x-fullmag-api-instance')}
rows={}
for suffix in ('before',):
 for name,path in [('current',''),('status','/status'),('scene','/model/scene')]: rows[name+'_'+suffix]=api('/v2/sessions/current'+path)
for name,path in [('health','/v2/platform/health'),('queue','/v2/platform/compute/queue'),('runtime','/v2/platform/runtime-service'),('commands','/v2/sessions/current/simulation/commands'),('run','/v2/sessions/current/simulation/runs/current'),('preparation','/v2/sessions/current/simulation/preparation'),('mesh','/v2/sessions/current/meshing/builds/current'),('mesh_history','/v2/sessions/current/meshing/builds'),('mesh_manifest','/v2/sessions/current/meshing/meshes/shared-domain/manifest')]: rows[name]=api(path)
rows['project_open']=api('/v2/persistence/projects/open',{'display_name':pin['archive']['path'].replace('\\','/').split('/')[-1],'archive_base64':request['archive_base64']})
# Do not retain the archive copy returned by the memory-only project parser.
rows['project_open']['body'].pop('archive_base64',None)
import runtime_service
paths=runtime_service.canonical_paths()
store=paths.store
if os.environ.get('FULLMAG_ACCEPTED_STORE_SCOPE') or store!=pathlib.Path(os.environ['FULLMAG_RUNS_ROOT'])/'session-store': raise RuntimeError('accepted store differs from the canonical service store')
host_raw=regular(paths.host_certificate)
host=json.loads(host_raw)
profile=host.get('storage_profile')
if host!=request['host_certificate']: raise RuntimeError('host storage certificate differs')
if profile=='linux-native-v1':
 if os.environ.get('FULLMAG_SESSION_STORAGE_PROFILE')!=profile: raise RuntimeError('Linux storage profile differs')
 import linux_native_probe
 verified,verified_raw,payload=linux_native_probe.validate_host(paths.state,paths.host_certificate,require_restart=True)
 if verified!=host or verified_raw!=host_raw or regular(paths.state/'.linux-native-restart')!=payload:
  raise RuntimeError('Linux host restart admission differs')
 probe=json.loads(regular(paths.state/'.linux-native-probe.json'))
 state_stat=paths.state.stat()
 checks={'file_sync','directory_sync','atomic_replace','process_lock','no_follow_symlink','sqlite_transactions','restart_readback'}
 if (probe.get('schema')!='fullmag.linux-native-probe.v1' or probe.get('storage_profile')!=profile
  or probe.get('owner_token')!=host['owner_token'] or probe.get('host_attestation_sha256')!=hashlib.sha256(host_raw).hexdigest()
  or probe.get('root_device')!=state_stat.st_dev or probe.get('root_inode')!=state_stat.st_ino
  or probe.get('mount_namespace_inode')!=pathlib.Path('/proc/self/ns/mnt').stat().st_ino
  or not isinstance(probe.get('checks'),dict) or set(probe['checks'])!=checks
  or any(probe['checks'][key] is not True for key in checks) or store.stat().st_dev!=state_stat.st_dev):
  raise RuntimeError('Linux storage probe mount/namespace/checks differ')
 relative=store.relative_to(paths.state).as_posix()
 if relative=='.' or '..' in pathlib.PurePosixPath(relative).parts: raise RuntimeError('unsafe Linux store relative path')
 # Canonical HostResourceLedger::store_id payload; admission remains image-owned.
 stable_identity={'schema':'fullmag.linux-native-store-identity.v1','engine_id':host['engine_id'],
  'owner_token':host['owner_token'],'relative_state_path':relative}
elif profile=='windows-folder-v1':
 owner=json.loads(regular(paths.state/'.fullmag-windows-folder-owner.json'))
 grant=json.loads(regular(paths.state/'.fullmag-windows-folder-grant.json'))
 if (host!=request['host_certificate'] or owner!=host or host.get('schema')!='fullmag.windows-folder-host.v1'
  or host.get('storage_profile')!='windows-folder-v1' or host.get('restart_verified') is not True
  or grant.get('schema')!='fullmag.windows-folder-session.v1' or grant.get('state')!='operational'
  or grant.get('container_root')!='/state' or grant.get('host_attestation_sha256')!=hashlib.sha256(host_raw).hexdigest()
  or grant.get('owner_token')!=host.get('owner_token')): raise RuntimeError('Windows store ownership/admission differs')
 relative=store.relative_to(paths.state).as_posix()
 if relative=='.' or '..' in pathlib.PurePosixPath(relative).parts: raise RuntimeError('unsafe accepted store relative path')
 owner_token=host['owner_token']
 if str(uuid.UUID(owner_token))!=owner_token or uuid.UUID(owner_token).int==0: raise RuntimeError('invalid store owner token')
 if type(host.get('host_volume_serial')) is not int or host['host_volume_serial']<=0: raise RuntimeError('invalid host volume serial')
 stable_identity={'schema':'fullmag.docker-admitted-store-identity.v2',
  'host_root':host['host_root'].replace('\\','/').translate(str.maketrans('ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')),
  'host_volume_serial':host['host_volume_serial'],'engine_id':host['engine_id'],
  'owner_token':owner_token,'relative_state_path':relative}
else: raise RuntimeError('unsupported saved-authoring storage profile')
store_id='sha256:'+hashlib.sha256(canon(stable_identity)).hexdigest()
ledger=pathlib.Path(os.environ['FULLMAG_HOST_LEDGER_ROOT'])
for root in (store,ledger):
 if not root.is_dir() or any(p.is_symlink() for p in (root,*root.parents)): raise RuntimeError('unsafe store/ledger root')
store_fd=lock(store/'WRITER.lock')
try:
 runs=store/'runs'
 if not runs.is_dir() or runs.is_symlink(): raise RuntimeError('runs directory missing')
 run_directories=sorted(p.name for p in runs.iterdir())
 history=pin.get('historical_preclaim')
 expected_runs=sorted(binding['cancelled_preclaim']['run_id'] for binding in (pin,history) if binding and 'cancelled_preclaim' in binding)
 retained_catalogs=observe_retained_catalogs(store,pin,regular)
 if retained_catalogs is not None: expected_runs=sorted(row['run_id'] for row in retained_catalogs)
 if run_directories!=expected_runs: raise RuntimeError('accepted runs, admissions or leases differ')
 transient_files=inventory(store/'temp')+inventory(store/'recovery')
 if transient_files: raise RuntimeError('store has pending writes/recovery')
finally: fcntl.flock(store_fd,fcntl.LOCK_UN);os.close(store_fd)
ledger_fd=lock(ledger/'WRITER.lock')
try:
 reservations=json.loads(regular(ledger/'HOST_RESOURCE_LEDGER.json')).get('reservations')
 if not isinstance(reservations,list): raise RuntimeError('reservations missing')
 reservation_states=[];foreign_reservations=0
 for row in reservations:
  identity=row.get('identity') if isinstance(row,dict) else None
  candidate=identity.get('store_id') if isinstance(identity,dict) else None
  if not isinstance(candidate,str) or len(candidate)!=71 or not candidate.startswith('sha256:') or any(c not in '0123456789abcdef' for c in candidate[7:]): raise RuntimeError('reservation store ownership is unknown')
  if candidate==store_id: reservation_states.append(row.get('state'))
  else: foreign_reservations+=1
 if any(s!='released' for s in reservation_states): raise RuntimeError('affected host resource reservation active/unknown')
finally: fcntl.flock(ledger_fd,fcntl.LOCK_UN);os.close(ledger_fd)
receipt=json.loads(runtime_service._bounded_regular(runtime_service.process_receipt_path(paths),'process receipt'))
runtime_service._validate_terminal_owner(receipt.get('service_owner'),state='ready',name='saved-authoring pre-stop owner')
if os.environ.get('FULLMAG_STARTUP_ENABLED','0')!='0': raise RuntimeError('startup activation enabled')
provenance_raw=regular('/opt/fullmag/control/backend/runtime-provenance.json')
provenance=json.loads(provenance_raw)
extra={}
if 'cancelled_preclaim' in pin or 'historical_preclaim' in pin: extra.update(preclaim_cancelled_snapshots(store,ledger,pin))
for name,path in [('current',''),('status','/status'),('scene','/model/scene')]: rows[name+'_after']=api('/v2/sessions/current'+path)
print(json.dumps({'schema':'fullmag.saved-authoring-restart-probe.v1','resources':rows,'run_directories':run_directories,'retained_run_catalogs':retained_catalogs,'transient_files':transient_files,'reservation_states':reservation_states,'accepted_store_id':store_id,'foreign_reservations_observed':foreign_reservations,'process_receipt':receipt,'provenance_sha256':hashlib.sha256(provenance_raw).hexdigest(),'source_snapshot_sha256':provenance.get('source_snapshot_sha256'),**extra},sort_keys=True))
"""


def _saved_authoring_probe(backend_id, request, raw, scene, certificate):
    cancelled = preclaim_restart.validate_checkpoint(request)
    historical = preclaim_restart.validate_historical_checkpoint(request)
    script = (preclaim_restart.PROBE_FUNCTION if cancelled or historical else '') + _SAVED_AUTHORING_PROBE_SCRIPT
    result = docker_capture('exec', '-i', '--env',
        'PYTHONPATH=/opt/fullmag:/opt/fullmag/package:/build/workspace/packages/fullmag-py/src',
        backend_id, '/usr/local/bin/python3', '-B', '-c', script,
        data=canonical({'checkpoint': request, 'archive_base64': base64.b64encode(raw).decode('ascii'),
                        'host_certificate': certificate}), timeout=180)
    observed = _saved_authoring_document(result.stdout)
    _saved_authoring_validate_probe(observed, request, scene)
    return observed


def _saved_authoring_validate_drain(probe, drained):
    from docker_volume_stop_unadmitted import _owner_identity_key
    _saved_authoring_require(drained.get('schema') == 'fullmag.docker-process-tree.v1'
        and drained.get('state') == 'drained', 'canonical authenticated drain is missing')
    expected = _owner_identity_key(probe['process_receipt']['service_owner'], 'pre-stop service owner')
    for name in ('service_owner', 'terminal_service_owner'):
        _saved_authoring_require(_owner_identity_key(drained.get(name), name) == expected, 'drain owner/children differ')


def _saved_authoring_verify_post_restart(backend_id):
    script = "import json,urllib.request\nwith urllib.request.urlopen('http://127.0.0.1:8081/v2/platform/health',timeout=5) as r:\n print(json.dumps(json.load(r)))"
    observed = _saved_authoring_document(docker_capture('exec', backend_id, '/usr/local/bin/python3', '-B', '-c', script).stdout)
    _saved_authoring_require(observed.get('status') == 'ok' and observed.get('active_session') is False,
            'restart unexpectedly restored/activated a session; explicit project restore is required')
    return observed



def _saved_authoring_verify_retained_history(request, state):
    pins = retained_history.validate_retained_catalogs(request)
    if pins is None:
        return
    store = storage.validate_path(state / 'runs' / 'docker-all' / 'session-store', state,
                                  'retained authoring history')
    entries = list((store / 'runs').iterdir())
    _saved_authoring_require(all(path.is_dir() and not path.is_symlink() for path in entries)
        and sorted(path.name for path in entries) == sorted(row['run_id'] for row in pins),
        'retained history directories changed after drain')
    observed = retained_history.observe_retained_catalogs(
        store, request, lambda path: _session_host().read_owned_regular(path, maximum=8 * 1024 * 1024))
    _saved_authoring_require(observed == pins, 'retained history changed after drain')


def _saved_authoring_complete(control, operation, backend_id, request, state, checkpoint_sha):
    """Keep the retained lease until every saved-authoring completion gate passes."""
    post_health = _saved_authoring_verify_post_restart(backend_id)
    _saved_authoring_verify_retained_history(request, state)
    _saved_authoring_read_archive(request, state)
    control.write(operation["root"] + "/saved-authoring-restart-result.json", {
        "schema": "fullmag.saved-authoring-restart-result.v1", "state": "succeeded",
        "checkpoint_sha256": checkpoint_sha, "health": post_health,
        "restore_required": request["archive"], "auto_solve": False})
    operation["daemon_pending"] = False


def _idle_preflight_failed(error, saved_authoring, operation, frontend_id):
    from docker_build_control import ControlOutcomeUnknown
    if saved_authoring and isinstance(error, ControlOutcomeUnknown):
        operation["daemon_pending"] = True
        operation["receipt"]["saved_authoring_outcome"] = "outcome-unknown"
        return
    operation["daemon_pending"] = True
    docker_capture("start", frontend_id, timeout=90)
    operation["daemon_pending"] = False


def restart_idle(args):
    return _retained_operation(args, recreate_services=False, restart_idle_service=True,
                               stop_after_drain=bool(getattr(args, "stop_only", False)))


def stop_idle(args):
    """Drain the exact idle backend before managed service recreation."""
    return _retained_operation(args, recreate_services=False, restart_idle_service=True, stop_after_drain=True)


def recreate(args):
    import docker_helper_source as helper_source
    helper_source.validate_option_pair(
        getattr(args, "helper_source_root", None),
        getattr(args, "helper_source_commit", None),
    )
    if getattr(args, "migrate_host_capacity", False):
        _assert_host_capacity_migration_quiescent()
    return _retained_operation(args, recreate_services=True)


def resume_recreation(args):
    """Resume only the exact successful recreation whose app IDs are absent."""
    import docker_helper_source as helper_source
    helper_source.validate_option_pair(
        getattr(args, "helper_source_root", None),
        getattr(args, "helper_source_commit", None),
    )
    if not re.fullmatch(r"[0-9a-f]{32}", str(getattr(args, "resume_recreation", ""))):
        raise BuildControlError("--resume-recreation requires one exact operation UUID")
    if getattr(args, "migrate_host_capacity", False):
        _assert_host_capacity_migration_quiescent()
    if (
        getattr(args, "fresh_state", False)
        or getattr(args, "script", None) is not None
        or getattr(args, "recovery_authorization", None) is not None
        or getattr(args, "include_untracked", None) is not None
        or getattr(args, "image", None) is not None
        or getattr(args, "toolchain_image", None) is not None
        or getattr(args, "source_manifest", None) is not None
        or getattr(args, "profile", "dev") != "dev"
    ):
        raise BuildControlError(
            "--resume-recreation cannot combine with fresh state, a script, recovery authorization, or source/image overrides"
        )
    return _retained_operation(
        args, recreate_services=False, resume_recreation_id=args.resume_recreation
    )


def resume(args):
    return _retained_operation(args, recreate_services=False)


def _read_runtime_config_digest(control):
    """Read the current native config while holding the runtime owner lock."""

    config_path = control.path("runtime-control/runtime-service/docker-all.json")
    lock_path = control.path("runtime-control/runtime-services/OWNER.lock")
    config_parent = str(PurePosixPath(config_path).parent)
    lock_parent = str(PurePosixPath(lock_path).parent)
    script = (
        f"test -e '{lock_path}'; test ! -L '{lock_path}'; test -f '{lock_path}'; "
        f"test $(stat -c %h '{lock_path}') = 1; "
        f"test \"$(readlink -f '{lock_parent}')\" = '{lock_parent}'; "
        f"exec 9<> '{lock_path}'; flock -n 9; "
        f"test -e '{config_path}'; test ! -L '{config_path}'; test -f '{config_path}'; "
        f"test $(stat -c %h '{config_path}') = 1; "
        f"test \"$(readlink -f '{config_parent}')\" = '{config_parent}'; "
        f"head -c {_MAX_RUNTIME_CONFIG_BYTES + 1} '{config_path}'"
    )
    result = bounded_capture(control.helper_args(script), data=b"", timeout=90)
    if result.returncode:
        raise BuildControlError(
            "Native runtime configuration could not be pinned under OWNER.lock: "
            + result.stderr.decode("utf-8", "replace")[-2048:]
        )
    raw = bytes(result.stdout)
    if not raw or len(raw) > _MAX_RUNTIME_CONFIG_BYTES:
        raise BuildControlError("Native runtime configuration exceeds its bounded size")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Native runtime configuration is not valid JSON") from error
    if not isinstance(value, Mapping):
        raise BuildControlError("Native runtime configuration is not an object")
    digest = hashlib.sha256(raw).hexdigest()
    if _SHA256.fullmatch(digest) is None:
        raise BuildControlError("Native runtime configuration digest is invalid")
    return digest


def _validate_completed_recovery_receipt(control, authorization, recovery_module):
    """Return true only for a complete receipt bound to the old authorization."""

    receipt_relative = (
        "runtime-control/runtime-services/container-recovery/"
        + authorization["native_request_sha256"] + "/receipt.json"
    )
    receipt_raw = recovery_module._control_bytes(control, receipt_relative, optional=True)
    if receipt_raw is None:
        return False
    receipt = recovery_module._parse_json(receipt_raw, "retained recovery receipt")
    if receipt.get("schema_version") != "runtime_service_container_recovery.v1":
        raise BuildControlError("Completed recovery receipt schema is unsupported")
    if receipt.get("status") != "recovered":
        # A prepared/pending receipt still owns the original capability.  It
        # must be carried unchanged so PID 1 can finish its authenticated
        # recovery protocol on the next start.
        return False
    request_relative = authorization["native_request_path"][len("/opt/fullmag/control/"):]
    request_raw = recovery_module._control_bytes(control, request_relative)
    if hashlib.sha256(request_raw).hexdigest() != authorization["native_request_sha256"]:
        raise BuildControlError("Completed recovery request digest differs from authorization")
    request = recovery_module.validate_request(
        recovery_module._parse_json(request_raw, "retained recovery request")
    )
    if receipt.get("outcome") != recovery_module.expected_recovery_outcome(request):
        raise BuildControlError("Completed recovery outcome differs from its request scope")
    for field in ("request_id", "config_sha256", "owner_sha256"):
        if request.get(field) != authorization[field]:
            raise BuildControlError("Completed recovery request differs from authorization")
    attestation_relative = authorization["attestation_path"][len("/opt/fullmag/control/"):]
    attestation_raw = recovery_module._control_bytes(control, attestation_relative)
    attestation = recovery_module.validate_attestation(
        recovery_module._parse_json(attestation_raw, "retained recovery attestation"),
        request,
        authorization["native_request_sha256"],
    )
    if hashlib.sha256(canonical(attestation)).hexdigest() != authorization["attestation_sha256"]:
        raise BuildControlError("Completed recovery attestation digest differs from authorization")
    manifest_relative = authorization["manifest_path"][len("/opt/fullmag/control/"):]
    manifest_raw = recovery_module._control_bytes(control, manifest_relative)
    if hashlib.sha256(manifest_raw).hexdigest() != authorization["manifest_sha256"]:
        raise BuildControlError("Completed recovery manifest digest differs from authorization")
    expected = {
        "request_id": request["request_id"],
        "request_sha256": authorization["native_request_sha256"],
        "config_sha256": request["config_sha256"],
        "target_id": "docker-all",
        "owner_sha256_before": request["owner_sha256"],
        "owner_state_before": request["expected_owner"]["state"],
        "owner_state_after": "failed",
        "store_root_sha256": request["store_root_sha256"],
        "application": request["application"],
        "ledger_root_sha256": request["ledger_root_sha256"],
        "ledger_snapshot_sha256": request["ledger_snapshot_sha256"],
        "attestation_sha256": authorization["attestation_sha256"],
        "docker_manifest_sha256": request["docker_manifest_sha256"],
        "prior_ready_owner_proof_sha256": request["prior_ready_owner_proof_sha256"],
        "device_release_mapping_sha256": request["device_release_mapping_sha256"],
    }
    if any(receipt.get(key) != value for key, value in expected.items()):
        raise BuildControlError("Completed recovery receipt differs from its authorization")
    owner_after = receipt.get("owner_sha256_after")
    if _SHA256.fullmatch(owner_after or "") is None or owner_after == request["owner_sha256"]:
        raise BuildControlError("Completed recovery receipt has no new failed-owner digest")
    for field, pattern in (
        ("historical_build_commit", re.compile(r"[0-9a-f]{40}\Z")),
        ("executor_build_commit", re.compile(r"[0-9a-f]{40}\Z")),
        ("historical_build_snapshot", _SHA256),
        ("executor_build_snapshot", _SHA256),
        ("archived_evidence_sha256", _SHA256),
    ):
        if pattern.fullmatch(receipt.get(field, "")) is None:
            raise BuildControlError("Completed recovery receipt has invalid " + field)
    return True


def _native_failed_stop_recovery_context(
    control, previous, *, backend_id, fresh_state, removed_container_proof=None,
):
    """Validate one managed native-failure stop journal for recreation.

    The legacy ``native-start-failure`` proof has no retained service owner.
    ``native-after-ready-failure`` is a separate, stricter proof: it carries
    the previous READY owner as an identity pin and may only recreate after
    the terminal receipt preserves that exact pin.  Neither route changes the
    owner state or releases a resource lease here; the proof is only carried
    into the next managed start.
    """

    if not isinstance(backend_id, str) or not _SHA256.fullmatch(backend_id):
        return None
    journal_path = "verification/stop-failed-" + backend_id + ".json"
    from docker_volume_stop_unadmitted import _control_bytes, _json
    journal_raw = _control_bytes(control, journal_path, optional=True)
    if journal_raw is None:
        return None
    journal = _json(journal_raw, "native failed-stop journal")
    if journal.get("failure_kind") == "native-runtime-supervision-linux-retained":
        from docker_volume_linux_supervision_stop import retained_context
        return retained_context(
            control, previous, journal, journal_raw, backend_id, fresh_state,
            removed_container_proof=removed_container_proof,
        )
    if journal.get("failure_kind") == "native-runtime-supervision-failure":
        from docker_volume_stop_failed import _supervision_failed_restart_context
        return _supervision_failed_restart_context(
            control, previous, journal, journal_raw, backend_id, fresh_state,
        )
    if fresh_state:
        raise BuildControlError("Native failed-stop recovery requires the retained session storage")
    previous_inputs = previous.get("inputs")
    if not isinstance(previous_inputs, Mapping):
        raise BuildControlError("Native failed-stop recreation has no retained inputs")
    image_id = previous_inputs.get("image_id")
    if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        raise BuildControlError("Native failed-stop recreation has no immutable image identity")
    failure_kind = journal.get("failure_kind")
    if (
        journal.get("schema") != _NATIVE_STOP_JOURNAL_SCHEMA
        or journal.get("state") != "stopped-confirmed"
        or failure_kind not in {"native-start-failure", "native-after-ready-failure"}
        or journal.get("container_id") != backend_id
        or journal.get("image_id") != image_id
        or type(journal.get("exit_code")) is not int
    ):
        raise BuildControlError("Native failed-stop journal is not the exact stopped backend proof")
    after_ready = failure_kind == "native-after-ready-failure"
    failure_mode = journal.get("failure_mode")
    api_start_failure = failure_mode == "api-start-failure"
    if failure_mode is not None and (failure_kind != "native-start-failure" or not api_start_failure):
        raise BuildControlError("Native failed-stop journal has an unsupported failure mode")
    failure = journal.get("failure_receipt")
    if not isinstance(failure, Mapping):
        raise BuildControlError("Native failed-stop journal has no failed process receipt")
    process_sha = failure.get("sha256")
    if not isinstance(process_sha, str) or _SHA256.fullmatch(process_sha) is None:
        raise BuildControlError("Native failed-stop journal has an invalid failed process digest")
    failed_receipt = failure.get("receipt")
    probe = journal.get("native_failure_probe")
    if not isinstance(failed_receipt, Mapping) or not isinstance(probe, Mapping):
        raise BuildControlError("Native failed-stop journal has incomplete native failure evidence")
    if probe.get("process_receipt_sha256") != process_sha or probe.get("process_receipt") != failed_receipt:
        raise BuildControlError("Native failed-stop journal failed process evidence differs")
    from docker_volume_stop_failed import (
        _validate_native_after_ready_failure_probe,
        _validate_native_failure_probe,
    )
    validated = (
        _validate_native_after_ready_failure_probe(probe, process_sha)
        if after_ready
        else _validate_native_failure_probe(
            probe, process_sha, api_start_failure=api_start_failure
        )
    )

    terminal_raw = _control_bytes(control, "runtime-control/runtime-service/process-tree.json")
    terminal = _json(terminal_raw, "native failed-stop terminal process receipt")
    if terminal != journal.get("terminal_process_receipt"):
        raise BuildControlError("Native failed-stop terminal process receipt differs")
    if (
        terminal.get("schema") != "fullmag.docker-process-tree.v1"
        or terminal.get("state") != "shutdown_unknown"
        or "terminal_service_owner" in terminal
        or type(terminal.get("api_exit_code")) is not int
        or terminal.get("runtime_pid") is not None
    ):
        raise BuildControlError("Native failed-stop terminal process receipt is not canonical")
    if after_ready:
        retained_ready_owner = journal.get("retained_ready_owner")
        terminal_ready_owner = terminal.get("service_owner")
        if retained_ready_owner != validated["ready_owner"]:
            raise BuildControlError("Native failed-stop retained ready owner differs from its probe")
        if terminal_ready_owner != validated["ready_owner"]:
            raise BuildControlError("Native failed-stop terminal ready owner differs from its probe")
        if journal.get("terminal_retained_ready_owner") != terminal_ready_owner:
            raise BuildControlError("Native failed-stop terminal ready owner evidence differs")
    elif "service_owner" in terminal:
        raise BuildControlError("Native failed-stop terminal process receipt is not canonical")
    terminal_owner_raw = _control_bytes(control, "runtime-control/runtime-services/OWNER.json")
    terminal_owner = _json(terminal_owner_raw, "native failed-stop terminal owner")
    expected_owner = journal.get("terminal_failed_owner")
    owner_sha = hashlib.sha256(terminal_owner_raw).hexdigest()
    if (
        terminal_owner != expected_owner
        or (
            journal.get("terminal_failed_owner_sha256") is not None
            and journal.get("terminal_failed_owner_sha256") != owner_sha
        )
        or validated["probe"].get("failed_owner_sha256") != owner_sha
        or terminal_owner != validated["failed_owner"]
    ):
        raise BuildControlError("Native failed-stop failed owner changed after the stop proof")
    from docker_volume_activation_reconcile import (
        _namespace_attestation_path,
        _validate_namespace_attestation,
        _validate_stopped_backend,
    )
    namespace_relative = _namespace_attestation_path(backend_id)
    namespace_raw = _control_bytes(control, namespace_relative, optional=True)
    namespace_attestation = None
    if namespace_raw is not None and removed_container_proof is not None:
        raise BuildControlError(
            "Removed-container recreation cannot substitute for a fresh namespace-attestation observation"
        )
    if namespace_raw is not None:
        namespace_attestation = _validate_namespace_attestation(
            control,
            _json(namespace_raw, "stopped namespace attestation"),
            backend_id=backend_id,
            image_id=image_id,
            journal_raw=journal_raw,
            journal=journal,
            terminal_raw=terminal_raw,
            terminal=terminal,
            owner_raw=terminal_owner_raw,
            owner=terminal_owner,
            selected_source=previous_inputs["source_root"],
        )
    capture_failure_sidecar = None
    if isinstance(journal.get("container_state"), Mapping):
        if removed_container_proof is None:
            try:
                _validate_stopped_backend(control, backend_id, image_id, journal=journal)
            except BuildControlError as stopped_error:
                if namespace_attestation is not None:
                    raise
                from docker_volume_capture_failure_reconcile import validate_capture_failure_sidecar

                try:
                    capture_failure_sidecar = validate_capture_failure_sidecar(
                        control,
                        previous,
                        backend_id=backend_id,
                        image_id=image_id,
                    )
                except BuildControlError as sidecar_error:
                    raise BuildControlError(
                        "Stopped backend differs from the native stop journal and has no valid "
                        "capture-only incarnation sidecar: " + str(sidecar_error)
                    ) from stopped_error
        else:
            if not isinstance(removed_container_proof, Mapping):
                raise BuildControlError("Removed-container recreation proof is malformed")
            retained_state = removed_container_proof.get("container_state")
            journal_state = journal["container_state"]
            if (
                removed_container_proof.get("schema") != "fullmag.docker-removed-recreation-container.v1"
                or not re.fullmatch(
                    r"[0-9a-f]{32}", removed_container_proof.get("recreation_operation_id", "")
                )
                or removed_container_proof.get("container_id") != backend_id
                or removed_container_proof.get("image_id") != image_id
                or not isinstance(retained_state, Mapping)
                or dict(retained_state) != dict(journal_state)
                or type(journal.get("exit_code")) is not int
                or journal.get("exit_code") != retained_state.get("exit_code")
                or any(
                    _SHA256.fullmatch(removed_container_proof.get(key, "")) is None
                    for key in (
                        "recreation_terminal_sha256", "retained_snapshot_sha256",
                        "prior_terminal_sha256", "prior_compose_sha256",
                    )
                )
            ):
                raise BuildControlError(
                    "Removed-container proof does not match the exact native stop journal incarnation"
                )
    elif namespace_attestation is None:
        raise BuildControlError("Legacy native stop journal requires a fresh namespace attestation")
    elif removed_container_proof is not None:
        raise BuildControlError(
            "Removed-container recreation cannot replace the legacy namespace attestation"
        )
    previous_config_sha256 = _read_runtime_config_digest(control)
    recorded_config = journal.get("previous_config_sha256")
    if recorded_config is not None and recorded_config != previous_config_sha256:
        raise BuildControlError("Native failed-stop runtime configuration digest differs")
    metadata = {
        "schema": _NATIVE_STOP_RECREATE_METADATA_SCHEMA,
        "failure_kind": failure_kind,
        "journal_sha256": hashlib.sha256(journal_raw).hexdigest(),
        "container_id": backend_id,
        "image_id": image_id,
        "failure_receipt_sha256": process_sha,
        "terminal_process_receipt_sha256": hashlib.sha256(terminal_raw).hexdigest(),
        "terminal_failed_owner_sha256": owner_sha,
        "previous_config_sha256": previous_config_sha256,
        "claim_pending": False,
    }
    if api_start_failure:
        metadata["failure_mode"] = failure_mode
    if after_ready:
        metadata["retained_ready_owner"] = validated["ready_owner"]
    if namespace_attestation is not None:
        metadata["namespace_attestation_path"] = namespace_relative
        metadata["namespace_attestation_sha256"] = hashlib.sha256(namespace_raw).hexdigest()
    if capture_failure_sidecar is not None:
        metadata["capture_failure_sidecar_path"] = capture_failure_sidecar["path"]
        metadata["capture_failure_sidecar_sha256"] = capture_failure_sidecar["sha256"]
        metadata["capture_failure_operation_attempt"] = capture_failure_sidecar["operation_attempt"]
        metadata["capture_failure_operation_terminal_sha256"] = (
            capture_failure_sidecar["operation_terminal_sha256"]
        )
        metadata["capture_failure_store_probe_sha256"] = capture_failure_sidecar["store_probe_sha256"]
        metadata["capture_failure_origin"] = capture_failure_sidecar["origin"]
        metadata["capture_failure_launch_origin"] = capture_failure_sidecar["launch_origin"]
        metadata["capture_failure_backend_started_at"] = capture_failure_sidecar["backend_started_at"]
        metadata["capture_failure_backend_finished_at"] = capture_failure_sidecar["backend_finished_at"]
        metadata["capture_failure_historical_resume_attempt"] = (
            capture_failure_sidecar["historical_resume_attempt"]
        )
        metadata["capture_failure_host_ledger_raw_sha256_observations"] = (
            capture_failure_sidecar["host_ledger_raw_sha256_observations"]
        )
    return {
        "previous_config_sha256": previous_config_sha256,
        "native_restart_metadata": metadata,
    }


def _retained_recovery_context(
    control, previous, document, *, fresh_state, backend_id=None, removed_container_proof=None,
    drained_successor=None, actual=None,
):
    """Carry pending recovery authority, or consume a completed proof once.

    PID 1 still authenticates the native request and current owner before any
    recovery or service start. Pending authorization is carried unchanged;
    a completed recovery receipt is validated before its authority is dropped.
    A separate native-start-failure journal carries only reduced restart
    evidence and never mints a recovery authorization.
    """
    if drained_successor is not None:
        if fresh_state:
            raise BuildControlError("Drained successor requires retained storage")
        from docker_volume_drained_successor import retained_context
        return retained_context(control, previous, document, actual, *drained_successor,
                                removed_container_proof=removed_container_proof)
    import docker_volume_container_recovery as recovery_module
    from docker_volume_container_recovery import (
        AUTHORIZATION_ENV, AUTHORIZATION_SHA_ENV, CONTROL_ROOT,
        _control_bytes, _parse_json, _relative_control_path,
        validate_runtime_authorization,
    )
    environment = document["services"]["backend"]["environment"]
    carried = {key: value for key, value in environment.items()
               if key.startswith("FULLMAG_CONTAINER_RECOVERY_")}
    metadata = previous.get("container_recovery")
    if not carried and metadata is None:
        native = _native_failed_stop_recovery_context(
            control, previous, backend_id=backend_id or previous.get("backend_container"),
            fresh_state=fresh_state, removed_container_proof=removed_container_proof,
        )
        if native is not None:
            return native
        from docker_volume_native_init_successor import retained_context as retained_successor_context
        successor = retained_successor_context(
            control, previous, document, backend_id or previous.get("backend_container"),
            fresh_state=fresh_state, removed_container_proof=removed_container_proof,
        )
        if successor is not None:
            return successor
        from docker_volume_pre_api_stop import retained_context as retained_pre_api_context
        pre_api = retained_pre_api_context(
            control, previous, document, backend_id or previous.get("backend_container"),
            fresh_state=fresh_state, removed_container_proof=removed_container_proof,
        )
        if pre_api is not None:
            return pre_api
        if removed_container_proof is None:
            from docker_volume_pre_ack_retry import retained_pre_ack_context
            retry = retained_pre_ack_context(
                control, previous, document, backend_id or previous.get("backend_container"), fresh_state=fresh_state
            )
            if retry is not None:
                return retry
        return {}
    if fresh_state:
        raise BuildControlError("Pending container recovery must retain its original session storage")
    if set(carried) != {AUTHORIZATION_ENV, AUTHORIZATION_SHA_ENV} or not isinstance(metadata, Mapping):
        raise BuildControlError("Retained container recovery capability is incomplete")
    if previous.get("container_recovery_environment") != sorted(carried):
        raise BuildControlError("Retained container recovery environment differs from its receipt")
    path = carried[AUTHORIZATION_ENV]
    if not isinstance(path, str) or not path.startswith(CONTROL_ROOT + "/"):
        raise BuildControlError("Retained container recovery authorization escapes control volume")
    relative = _relative_control_path(path[len(CONTROL_ROOT) + 1:])
    raw = _control_bytes(control, relative)
    if raw is None:
        raise BuildControlError("Retained container recovery authorization is missing")
    digest = hashlib.sha256(raw).hexdigest()
    if digest != carried[AUTHORIZATION_SHA_ENV] or digest != metadata.get("authorization_sha256"):
        raise BuildControlError("Retained container recovery authorization digest differs")
    authorization = validate_runtime_authorization(_parse_json(raw, "retained runtime authorization"))
    if (authorization["compose_project"] != control.project
            or authorization["source_root"] != previous["inputs"]["source_root"]):
        raise BuildControlError("Retained container recovery source or project differs")
    expected = {
        "schema": "fullmag.container-recovery.v1",
        "request_id": authorization["request_id"],
        "request_sha256": authorization["native_request_sha256"],
        "attestation_sha256": authorization["attestation_sha256"],
        "manifest_sha256": authorization["manifest_sha256"],
        "authorization_sha256": digest,
        "stop_journal_sha256": authorization["prior_stop_journal_sha256"],
        "removed_container_ids": [authorization["backend_container_id"], authorization["frontend_container_id"]],
    }
    if metadata != expected:
        raise BuildControlError("Retained container recovery metadata differs from authorization")
    if _validate_completed_recovery_receipt(control, authorization, recovery_module):
        from docker_volume_startup_diagnostic_restart import retained_context as diagnostic_context
        startup_stop = diagnostic_context(
            control, previous, document, backend_id or previous.get("backend_container"),
            fresh_state=fresh_state, authorization=authorization,
            removed_container_proof=removed_container_proof, actual=actual,
        )
        if startup_stop is not None:
            return startup_stop
        native_restart = _native_failed_stop_recovery_context(
            control, previous, backend_id=backend_id or previous.get("backend_container"),
            fresh_state=fresh_state, removed_container_proof=removed_container_proof,
        )
        if native_restart is not None:
            return native_restart
        # The first post-recovery Failed owner still needs the original
        # capability for its authorized configuration-generation rotation.
        # A completed receipt alone does not prove a later owner existed.
    return {"recovery_environment": _validate_recovery_environment(carried),
            "recovery_metadata": _validate_recovery_metadata(expected)}


def _read_canonical_control_record(control, relative, label):
    from docker_volume_stop_unadmitted import _control_bytes, _json

    raw = _control_bytes(control, relative)
    value = _json(raw, label)
    if not isinstance(value, Mapping) or raw != canonical(value) + b"\n":
        raise BuildControlError(label + " is not a canonical control-volume record")
    return raw, dict(value)


def _validate_failed_prestart_successor(
    args,
    control,
    selected,
    identity,
    *,
    current_raw,
    current,
    previous_raw,
    previous,
    document_raw,
    operation_raw,
    operation_terminal,
    retained_raw,
    operator_probe_record,
    native_recovery_context,
    removed_container_proof,
    helper_source_binding=None,
):
    """Admit only the closed start attempt that failed before publication.

    A recreation caller can open a fresh development lease before Compose is
    rendered.  If that host process fails at that pre-start boundary, the
    durable current pointer no longer equals the original development
    attempt.  This narrow bridge authenticates that one successor, then all
    existing recreation/continuation validators continue to use ``previous``
    as the historical attempt.  It is deliberately not a general later-
    attempt recovery path.
    """

    from docker_volume_post_build_generation import (
        _accepted_metadata,
        _validate_metadata_shape,
        validate_continuation_metadata,
        validate_start_binding,
    )
    from docker_volume_stop_unadmitted import _control_bytes

    if not isinstance(current, Mapping) or current_raw != canonical(current) + b"\n":
        raise BuildControlError("Pre-start successor terminal is not canonical")
    successor_attempt = current.get("attempt")
    if (
        not isinstance(successor_attempt, str)
        or _RECOVERY_ATTEMPT.fullmatch(successor_attempt) is None
        or successor_attempt == args.attempt
    ):
        raise BuildControlError("Pre-start successor is not a distinct development attempt")
    if (
        current.get("schema") != "fullmag.docker-build-operation.v1"
        or current.get("phase") != "development"
        or current.get("state") != "failed-confirmed"
        or current.get("compose_project") != control.project
        or current.get("control_volume") != control.volume
    ):
        raise BuildControlError("Pre-start successor is not a failed development receipt")
    error = current.get("error")
    if not isinstance(error, str) or not error.startswith(
        "Post-build continuation changed under the new development lease: "
    ):
        raise BuildControlError("Pre-start successor did not fail at the unmodified admission gate")
    if current.get("state_root") != previous.get("state_root"):
        raise BuildControlError("Pre-start successor changed the retained session state root")

    successor_inputs = current.get("inputs")
    if not isinstance(successor_inputs, Mapping):
        raise BuildControlError("Pre-start successor has no operation inputs")
    if "recreation_resume" in successor_inputs:
        expected_resume = {
            key: removed_container_proof[key]
            for key in (
                "recreation_operation_id", "recreation_terminal_sha256",
                "retained_snapshot_sha256", "prior_terminal_sha256", "prior_compose_sha256",
            )
        }
        expected_resume["proof_sha256"] = hashlib.sha256(canonical(removed_container_proof)).hexdigest()
        if successor_inputs["recreation_resume"] != expected_resume:
            raise BuildControlError("Pre-start successor recreation resume proof differs")
    metadata = current.get("post_build_generation")
    if successor_inputs.get("post_build_generation") != metadata:
        raise BuildControlError("Pre-start successor continuation metadata is not receipt-bound")
    if not isinstance(metadata, Mapping):
        raise BuildControlError("Pre-start successor has no continuation metadata")
    try:
        validated_metadata = validate_continuation_metadata(metadata)
    except BuildControlError as error:
        raise BuildControlError("Pre-start successor continuation metadata is invalid: " + str(error)) from error
    if (
        validated_metadata.get("operation_id") != previous.get("attempt")
        or validated_metadata.get("compose_project") != control.project
        or validated_metadata.get("source_root") != str(selected)
    ):
        raise BuildControlError("Pre-start successor continuation does not name the retained attempt/source")
    source_identity = validated_metadata.get("source_identity")
    if not isinstance(source_identity, Mapping) or any(
        source_identity.get(key) != identity.get(identity_key)
        for key, identity_key in (
            ("project_id", "project_id"),
            ("worktree_id", "worktree_id"),
            ("checkout_kind", "checkout_kind"),
        )
    ):
        raise BuildControlError("Pre-start successor continuation source identity differs")

    previous_inputs = previous.get("inputs")
    if not isinstance(previous_inputs, Mapping):
        raise BuildControlError("Retained development attempt has no inputs")
    for key, expected in (
        ("source_root", str(selected)),
        ("source_project_id", identity.get("project_id")),
        ("source_worktree_id", identity.get("worktree_id")),
        ("source_checkout_kind", identity.get("checkout_kind")),
        ("gpu_access_requested", previous_inputs.get("gpu_access_requested")),
        ("device_access", previous_inputs.get("device_access")),
        ("gpu_preflight", previous_inputs.get("gpu_preflight")),
    ):
        if successor_inputs.get(key) != expected:
            raise BuildControlError("Pre-start successor input differs: " + key)
    for key, expected in operator_probe_record.items():
        if successor_inputs.get(key) != expected:
            raise BuildControlError("Pre-start successor operator control differs: " + key)
    if helper_source_binding is not None:
        try:
            import docker_helper_source as helper_source
            helper_source.compare_operation_binding(
                {"helper_source": successor_inputs.get("helper_source")},
                helper_source_binding,
            )
        except helper_source.HelperSourceError as error:
            raise BuildControlError("Pre-start successor helper-source pin differs: " + str(error)) from error
        if current.get("helper_source") != helper_source_binding:
            raise BuildControlError("Pre-start successor receipt helper-source pin differs")
    for key in ("image_id",) + (("toolchain_image_id",) if "toolchain_image_id" in successor_inputs else ()):
        value = successor_inputs.get(key)
        if not isinstance(value, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", value) is None:
            raise BuildControlError("Pre-start successor has no immutable " + key)
    if successor_inputs.get("previous_config_sha256") != validated_metadata["runtime_config"]["sha256"]:
        raise BuildControlError("Pre-start successor runtime configuration pin differs")
    expected_native_restart = native_recovery_context.get("native_restart_metadata")
    if (("native_failed_restart" in successor_inputs) != (expected_native_restart is not None)
            or successor_inputs.get("native_failed_restart") != expected_native_restart):
        raise BuildControlError("Pre-start successor native restart evidence differs")
    allowed_inputs = {
        "source_root", "image_id", "source_project_id", "source_worktree_id",
        "source_checkout_kind", "gpu_access_requested", "device_access", "gpu_preflight",
        "previous_config_sha256", "post_build_generation", *operator_probe_record,
    }
    if "toolchain_image_id" in successor_inputs:
        allowed_inputs.add("toolchain_image_id")
    if "recreation_resume" in successor_inputs:
        allowed_inputs.add("recreation_resume")
    if expected_native_restart is not None:
        allowed_inputs.add("native_failed_restart")
    if helper_source_binding is not None:
        allowed_inputs.add("helper_source")
    accepted_run = validated_metadata.get("accepted_run")
    if accepted_run:
        allowed_inputs.add("accepted_reattach")
    if set(successor_inputs) != allowed_inputs:
        raise BuildControlError("Pre-start successor operation input fields differ")
    for key, expected in operator_probe_record.items():
        if current.get(key) != expected:
            raise BuildControlError("Pre-start successor receipt operator control differs: " + key)
    if accepted_run:
        producer = successor_inputs.get("accepted_reattach")
        if (not isinstance(producer, Mapping)
                or current.get("accepted_reattach") != producer
                or operation_terminal.get("accepted_reattach") != producer):
            raise BuildControlError("Pre-start successor accepted-run producer evidence differs")
        # The continuation carries the existing closed projection, while the
        # operation retains the full producer record (including source and
        # activation provenance). Never compare these different contracts as
        # though their field sets were identical.
        accepted_projection = _accepted_metadata({
            "accepted_reattach_metadata": producer,
            "accepted_reattach_environment": {
                "FULLMAG_ACCEPTED_REATTACH_REQUEST": producer.get("request_relative"),
                "FULLMAG_ACCEPTED_REATTACH_REQUEST_SHA256": producer.get("request_sha256"),
            },
        })
        if accepted_projection != accepted_run:
            raise BuildControlError("Pre-start successor accepted-run projection differs")
    elif "accepted_reattach" in current or "accepted_reattach" in operation_terminal:
        raise BuildControlError("Pre-start successor has unexpected accepted-run evidence")

    operation_metadata = operation_terminal.get("post_build_generation")
    if not isinstance(operation_metadata, Mapping):
        raise BuildControlError("Completed recreation has no post-build continuation metadata")
    try:
        operation_base = _validate_metadata_shape(operation_metadata)
    except BuildControlError as error:
        raise BuildControlError("Completed recreation continuation metadata is invalid: " + str(error)) from error
    current_base = dict(validated_metadata)
    current_recreate = current_base.pop("recreate_operation", None)
    operation_base.pop("recreate_operation", None)
    if current_base != operation_base:
        raise BuildControlError("Pre-start successor continuation changed the completed recreation proof")
    if not isinstance(current_recreate, Mapping):
        raise BuildControlError("Pre-start successor has no recreation binding")
    recreation_root = "recreate-services/attempts/" + args.resume_recreation
    if (
        current_recreate.get("operation_id") != args.resume_recreation
        or current_recreate.get("terminal_relative") != recreation_root + "/terminal.json"
        or current_recreate.get("retained_relative") != recreation_root + "/retained-containers.json"
        or current_recreate.get("terminal_sha256") != hashlib.sha256(operation_raw).hexdigest()
        or current_recreate.get("retained_sha256") != hashlib.sha256(retained_raw).hexdigest()
        or current_recreate.get("prior_terminal_sha256") != hashlib.sha256(previous_raw).hexdigest()
        or current_recreate.get("prior_compose_sha256") != hashlib.sha256(document_raw).hexdigest()
    ):
        raise BuildControlError("Pre-start successor recreation binding does not match the retained proof")

    reference = current.get("post_build_start")
    expected_reference_fields = {"schema", "state", "path", "sha256", "continuation_sha256"}
    if not isinstance(reference, Mapping) or set(reference) != expected_reference_fields:
        raise BuildControlError("Pre-start successor has no exact pending start binding")
    expected_root = "development/attempts/" + successor_attempt
    expected_guest_path = "/opt/fullmag/control/" + expected_root + "/post-build-continuation.json"
    metadata_sha = hashlib.sha256(canonical(validated_metadata) + b"\n").hexdigest()
    binding_sha = reference.get("sha256")
    if (
        reference.get("schema") != "fullmag.docker-post-build-failed-owner-start.v1"
        or reference.get("state") != "pending"
        or reference.get("path") != expected_guest_path
        or reference.get("continuation_sha256") != metadata_sha
        or not isinstance(binding_sha, str)
        or _SHA256.fullmatch(binding_sha) is None
        or set(binding_sha) == {"0"}
    ):
        raise BuildControlError("Pre-start successor start binding is not the exact pending reference")
    binding_relative = expected_root + "/post-build-continuation.json"
    binding_raw = _control_bytes(control, binding_relative, optional=True)
    if binding_raw is None:
        raise BuildControlError("Pre-start successor pending start binding is missing")
    try:
        binding = json.loads(binding_raw)
        checked_binding = validate_start_binding(binding)
    except (BuildControlError, UnicodeDecodeError, json.JSONDecodeError, TypeError) as error:
        raise BuildControlError("Pre-start successor pending start binding is invalid: " + str(error)) from error
    if (
        binding_raw != canonical(binding) + b"\n"
        or hashlib.sha256(binding_raw).hexdigest() != reference.get("sha256")
        or checked_binding.get("state") != "pending"
        or checked_binding.get("attempt") != successor_attempt
        or checked_binding.get("continuation") != validated_metadata
        or checked_binding.get("continuation_sha256") != metadata_sha
    ):
        raise BuildControlError("Pre-start successor pending start binding changed")

    successor_terminal_raw = _control_bytes(
        control, expected_root + "/terminal.json", optional=True
    )
    if successor_terminal_raw != current_raw:
        raise BuildControlError("Pre-start successor current pointer is not its exact terminal bytes")
    if _control_bytes(control, "active", optional=True) is not None:
        raise BuildControlError("Pre-start successor still owns an active operation lease")

    consumed_relative = (
        "runtime-control/runtime-services/post-build-continuation/"
        + successor_attempt + "/consumed.json"
    )
    if _control_bytes(control, consumed_relative, optional=True) is not None:
        raise BuildControlError("Pre-start successor already consumed its runtime continuation")

    # Accept only receipt metadata and the pending binding at this boundary;
    # cache, Compose and runtime publication must not have begun.
    allowed_fields = {
        "schema", "phase", "state", "attempt", "compose_project", "control_volume",
        "helper_container", "inputs", "attempt_limit", "log_byte_limit",
        "minimum_free_bytes", "started_at", "finished_at", "error",
        "build_data_qualification", "filesystem_before", "filesystem_after",
        "state_root", "post_build_generation", "post_build_start", *operator_probe_record,
    }
    if accepted_run:
        allowed_fields.add("accepted_reattach")
    if helper_source_binding is not None:
        allowed_fields.add("helper_source")
    namespace = getattr(control, "namespace", None)
    if namespace:
        allowed_fields.update({"control_namespace", "namespace_registry_sha256"})
        if (current.get("control_namespace") != namespace
                or current.get("namespace_registry_sha256") != control.namespace_registry_sha256):
            raise BuildControlError("Pre-start successor control namespace differs")
    if set(current) - allowed_fields:
        raise BuildControlError("Pre-start successor contains a published runtime artifact or unknown field")
    forbidden_files = (
        "compose.json", "frontend-seed.json", "backend-cache.json",
        "cache-maintenance-compose.json", "host-ledger-volume-probe-compose.json",
        "host-ledger-volume-probe.json", "host-ledger-volume-probe-log.json",
        "ledger-maintenance-compose.json", "ledger-helper-log.json", "host-ledger.json",
        "host-capacity-publication.json",
        "host-ledger-volume.json", "backend-failure-log.json", "handoff-log.json",
        "backend-build-receipt.json", "provenance.json", "storage-probe-log.json",
        "ledger-verify-receipt.json", "ledger-verify-log.json", "host-ledger-attestation.json",
        "process-failure.json", "retained-containers.json",
        "group-ledger.json", "group-ledger-attestation.json",
    )
    for filename in forbidden_files:
        if _control_bytes(control, expected_root + "/" + filename, optional=True) is not None:
            raise BuildControlError("Pre-start successor published an unexpected artifact: " + filename)


def _validate_removed_recreation_proof(
    args, control, previous, document, identity, *, operation_id, operation_raw,
    operation_terminal, retained_raw, retained, previous_raw, document_raw, operator_probe_record,
    helper_source_binding=None,
):
    """Validate the retained incarnation and native proof after exact app-ID removal.

    Operation admission remains with each caller: ordinary resume requires no
    active lease; completed-start rechecks this immutable evidence under its own.
    """
    image = previous["inputs"]["image_id"]
    expected_operation_inputs = {
        "attempt": args.attempt,
        "config_sha256": args.config_sha256,
        **operator_probe_record,
    }
    try:
        import docker_helper_source as helper_source
        stored_helper_source = helper_source.compare_operation_binding(
            operation_terminal.get("inputs"), helper_source_binding
        )
    except helper_source.HelperSourceError as error:
        raise BuildControlError("Recreation helper-source pin cannot be resumed: " + str(error)) from error
    if stored_helper_source is not None:
        expected_operation_inputs["helper_source"] = stored_helper_source
    offline_attempt = getattr(args, "offline_reconciliation", None)
    retained_offline = operation_terminal.get("offline_reconciliation")
    if retained_offline is not None or offline_attempt is not None:
        if retained_offline != offline_attempt or not isinstance(offline_attempt, str):
            raise BuildControlError("Recreation resume must retain its exact offline reconciliation pin")
        expected_operation_inputs["offline_reconciliation"] = offline_attempt
    if (
        operation_terminal.get("schema") != "fullmag.docker-build-operation.v1"
        or operation_terminal.get("phase") != "recreate-services"
        or operation_terminal.get("state") != "succeeded"
        or operation_terminal.get("attempt") != operation_id
        or operation_terminal.get("compose_project") != control.project
        or operation_terminal.get("control_volume") != control.volume
        or operation_terminal.get("inputs") != expected_operation_inputs
        or operation_terminal.get("previous_state_root") != previous.get("state_root")
        or operation_terminal.get("retained_volumes") != previous.get("backend_volumes")
        or operation_terminal.get("retained_frontend_volume") != previous.get("frontend_volume")
        or operation_terminal.get("fresh_state") is not False
    ):
        raise BuildControlError("Recreation operation receipt does not prove this exact completed replacement")
    if offline_attempt is not None:
        from docker_volume_offline_reconcile import validate_recreate_resume
        if not validate_recreate_resume(
            control, operation_terminal, expected_offline_attempt=offline_attempt,
        ):
            raise BuildControlError("Recreation resume lost its completed offline reconciliation proof")
    namespace = getattr(control, "namespace", None)
    if namespace:
        if (operation_terminal.get("control_namespace") != namespace
                or operation_terminal.get("namespace_registry_sha256")
                != control.namespace_registry_sha256):
            raise BuildControlError("Recreation operation control namespace differs")
    elif ("control_namespace" in operation_terminal
          or "namespace_registry_sha256" in operation_terminal):
        raise BuildControlError("Recreation operation carries a foreign control namespace")

    if not isinstance(retained, Mapping) or set(retained) != {"backend", "frontend"}:
        raise BuildControlError("Recreation receipt has no exact retained backend/frontend snapshot")
    snapshot = {service: retained[service] for service in ("backend", "frontend")}
    ids = {}
    image_config_records = json.loads(docker_text("image", "inspect", image))
    if (
        len(image_config_records) != 1
        or not isinstance(image_config_records[0], Mapping)
        or not isinstance(image_config_records[0].get("Config"), Mapping)
    ):
        raise BuildControlError("Retained recreation image configuration is ambiguous")
    image_config = image_config_records[0]["Config"]
    for service in ("backend", "frontend"):
        observed = snapshot[service]
        if not isinstance(observed, Mapping):
            raise BuildControlError("Retained recreation container snapshot is malformed: " + service)
        identifier = observed.get("Id")
        if not isinstance(identifier, str) or re.fullmatch(r"[0-9a-f]{64}", identifier) is None:
            raise BuildControlError("Retained recreation container ID is invalid: " + service)
        ids[service] = identifier
        config = observed.get("Config")
        labels = config.get("Labels") if isinstance(config, Mapping) else None
        if (
            not isinstance(labels, Mapping)
            or observed.get("Image") != image
            or labels.get("com.docker.compose.project") != control.project
            or labels.get("com.docker.compose.service") != service
            or labels.get("org.fullmag.source.worktree-id") != identity.get("worktree_id")
        ):
            raise BuildControlError("Retained recreation container ownership/incarnation differs: " + service)
        previous_id = previous.get(service + "_container")
        if previous_id is not None and previous_id != identifier:
            raise BuildControlError("Retained recreation container differs from the prior recorded incarnation: " + service)
        _validate_retained_service(
            document, observed, service, image_config, allow_legacy_frontend=True
        )
    removed_ids = operation_terminal.get("removed_containers")
    if removed_ids != [ids["backend"], ids["frontend"]] or ids["backend"] == ids["frontend"]:
        raise BuildControlError("Recreation terminal receipt does not name the exact retained app containers")

    backend_state = snapshot["backend"].get("State")
    if not isinstance(backend_state, Mapping) or backend_state.get("Running") is not False:
        raise BuildControlError("Retained backend snapshot does not prove a stopped service")
    exit_code = backend_state.get("ExitCode")
    if type(exit_code) is not int:
        raise BuildControlError("Retained backend stop snapshot has no exact exit code")
    container_state = {
        "id": ids["backend"],
        "image": image,
        "started_at": backend_state.get("StartedAt"),
        "finished_at": backend_state.get("FinishedAt"),
        "exit_code": exit_code,
    }

    # Inspect and list the exact IDs after the terminal receipt; the ordinary
    # start guard below still rejects every remaining group container.
    absence_proof = {}
    for service in ("backend", "frontend"):
        inspected = docker_capture("inspect", ids[service], allow_failure=True, timeout=60)
        if inspected.returncode == 0:
            raise BuildControlError("A retained app-container ID is still inspectable in Docker")
        detail = (inspected.stderr + inspected.stdout).decode("utf-8", "replace")
        not_found = re.search(
            r"(?:no such object|no such container):\s*" + re.escape(ids[service]) + r"(?:\s|$)",
            detail,
            re.IGNORECASE,
        )
        if not_found is None:
            raise BuildControlError("Docker inspect did not authoritatively confirm removed app-container absence")
        absence_result = docker_capture(
            "ps", "--all", "--quiet", "--no-trunc", "--filter", "id=" + ids[service], timeout=60
        )
        if absence_result.returncode:
            raise BuildControlError("Cannot verify removed app-container absence")
        if absence_result.stdout.decode("utf-8", "replace").split():
            raise BuildControlError("A retained app-container ID is still present in Docker")
        absence_proof[service] = {
            "container_id": ids[service],
            "inspect_returncode": inspected.returncode,
            "inspect_output_sha256": hashlib.sha256(
                inspected.stderr + inspected.stdout
            ).hexdigest(),
            "ps_returncode": absence_result.returncode,
            "ps_output_sha256": hashlib.sha256(absence_result.stdout).hexdigest(),
        }

    proof = {
        "schema": "fullmag.docker-removed-recreation-container.v1",
        "recreation_operation_id": operation_id,
        "recreation_terminal_sha256": hashlib.sha256(operation_raw).hexdigest(),
        "retained_snapshot_sha256": hashlib.sha256(retained_raw).hexdigest(),
        "prior_terminal_sha256": hashlib.sha256(previous_raw).hexdigest(),
        "prior_compose_sha256": hashlib.sha256(document_raw).hexdigest(),
        "container_id": ids["backend"],
        "frontend_container": ids["frontend"],
        "image_id": image,
        "container_state": container_state,
        "absence": absence_proof,
    }
    successor_path = getattr(args, "drained_successor_proof", None)
    successor_sha = getattr(args, "drained_successor_proof_sha256", None)
    recorded_successor = operation_terminal.get("drained_successor")
    if recorded_successor is not None:
        if not isinstance(recorded_successor, Mapping):
            raise BuildControlError("Completed recreation drained-successor witness is invalid")
        recorded_pins = (recorded_successor.get("proof_path"), recorded_successor.get("proof_sha256"))
        if ((successor_path or successor_sha) and (successor_path, successor_sha) != recorded_pins):
            raise BuildControlError("Completed recreation drained-successor request pins differ")
        successor_path, successor_sha = recorded_pins
    if bool(successor_path) != bool(successor_sha):
        raise BuildControlError("Completed recreation requires paired drained-successor pins")
    native_recovery_context = _retained_recovery_context(
        control,
        previous,
        document,
        fresh_state=False,
        backend_id=ids["backend"],
        removed_container_proof=proof,
        drained_successor=((successor_path, successor_sha) if successor_path else None), actual=snapshot,
    )
    from docker_volume_drained_successor import DrainedSuccessorContext
    if isinstance(native_recovery_context, DrainedSuccessorContext):
        witness = native_recovery_context.witness
        if operation_terminal.get("drained_successor") != witness:
            raise BuildControlError("Completed recreation drained-successor witness differs")
        proof["drained_successor"] = witness
    from docker_volume_startup_diagnostic_restart import StartupDiagnosticStopContext
    if isinstance(native_recovery_context, StartupDiagnosticStopContext):
        if operation_terminal.get("startup_diagnostic_restart") != native_recovery_context["startup_diagnostic_restart"]:
            raise BuildControlError("Completed recreation startup diagnostic witness differs")
        proof["startup_diagnostic_restart"] = native_recovery_context["startup_diagnostic_restart"]
    proof["native_recovery_context"] = native_recovery_context
    return snapshot, proof, native_recovery_context


def _validate_recreation_resume_records(args, control, selected, identity, *, expected_proof=None,
                                        current_operation=None, helper_source_binding=None):
    """Revalidate one completed recreation and prove its old app IDs are absent."""

    from docker_volume_stop_unadmitted import _control_bytes

    if not re.fullmatch(r"[0-9a-f]{32}", str(getattr(args, "resume_recreation", ""))):
        raise BuildControlError("Recreation resume requires one exact operation UUID")
    if not re.fullmatch(r"[0-9a-f]{32}", str(getattr(args, "attempt", ""))):
        raise BuildControlError("Recreation resume requires the exact prior start attempt UUID")
    if not isinstance(args.config_sha256, str) or _SHA256.fullmatch(args.config_sha256) is None:
        raise BuildControlError("Recreation resume requires the exact prior configuration digest")

    previous_root = "development/attempts/" + args.attempt
    previous_raw, previous = _read_canonical_control_record(
        control, previous_root + "/terminal.json", "prior development terminal receipt"
    )
    current_raw = _control_bytes(control, "development/current.json", optional=True)
    if current_raw is None:
        raise BuildControlError("Recreation resume has no current development receipt")
    current = json.loads(current_raw)
    if previous.get("state") not in {"failed-confirmed", "succeeded"}:
        raise BuildControlError("Recreation resume has no admissible prior development outcome")
    if previous.get("compose_project") != control.project:
        raise BuildControlError("Recreation resume belongs to another Compose project")
    inputs = previous.get("inputs")
    if not isinstance(inputs, Mapping) or inputs.get("source_root") != str(selected):
        raise BuildControlError("Recreation resume source selection differs from the prior start")
    for source_key, identity_key in (
        ("source_project_id", "project_id"),
        ("source_worktree_id", "worktree_id"),
        ("source_checkout_kind", "checkout_kind"),
    ):
        if inputs.get(source_key) != identity.get(identity_key):
            raise BuildControlError("Recreation resume source identity differs from the prior start")
    image = inputs.get("image_id")
    if not isinstance(image, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", image) is None:
        raise BuildControlError("Recreation resume has no immutable prior image identity")

    document_raw, document = _read_canonical_control_record(
        control, previous_root + "/compose.json", "prior development Compose document"
    )
    if (
        hashlib.sha256(canonical(document)).hexdigest() != args.config_sha256
        or document.get("name") != control.project
    ):
        raise BuildControlError("Recreation resume prior Compose identity/configuration pin differs")
    services = document.get("services")
    frontend = services.get("frontend") if isinstance(services, Mapping) else None
    frontend_ports = frontend.get("ports") if isinstance(frontend, Mapping) else None
    if not isinstance(frontend_ports, list) or len(frontend_ports) != 1:
        raise BuildControlError("Recreation resume prior Compose frontend port is ambiguous")
    frontend_port = frontend_ports[0]
    if (
        not isinstance(frontend_port, Mapping)
        or frontend_port.get("host_ip") != "127.0.0.1"
        or frontend_port.get("mode") != "ingress"
        or frontend_port.get("protocol") != "tcp"
        or frontend_port.get("target") != 8080
        or not isinstance(frontend_port.get("published"), str)
        or re.fullmatch(r"[1-9][0-9]{0,4}", frontend_port["published"]) is None
        or int(frontend_port["published"]) > 65535
        or int(frontend_port["published"]) != args.port
    ):
        raise BuildControlError("Recreation resume frontend port differs from the prior start")
    url = previous.get("url")
    if url is not None:
        match = re.fullmatch(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})", url) if isinstance(url, str) else None
        if match is None or int(match.group(1)) != args.port:
            raise BuildControlError("Recreation resume prior frontend URL differs from its Compose port")
    policy = inputs.get("gpu_access_requested")
    if policy not in {"auto", "required", "disabled"} or getattr(args, "gpu_access", None) != policy:
        raise BuildControlError("Recreation resume GPU access intent differs from the prior start")
    allowlist = include_untracked_from_compose(document)
    if normalize_include_untracked_paths(getattr(args, "include_untracked", None)) != allowlist:
        raise BuildControlError("Recreation resume source allowlist differs from the retained Compose document")
    operator_probe_record = _operator_probe_record_from_retained(previous, document)

    active_raw = _control_bytes(control, "active", optional=True)
    if current_operation is None:
        if active_raw is not None:
            raise BuildControlError("A managed operation lease is still active; recreation resume is refused")
    else:
        receipt = current_operation.get("receipt", {})
        token = receipt.get("attempt")
        helper_id = current_operation.get("helper_container_id")
        if (control._active_operation is not current_operation
                or current_operation.get("lease_ready") is not True
                or not isinstance(helper_id, str) or _SHA256.fullmatch(helper_id) is None
                or not isinstance(token, str) or _RECOVERY_ATTEMPT.fullmatch(token) is None
                or active_raw != (token + "\n").encode()
                or receipt.get("phase") != "development" or receipt.get("state") != "starting"
                or receipt.get("compose_project") != control.project
                or receipt.get("control_volume") != control.volume
                or current_operation.get("root") != "development/attempts/" + token
                or expected_proof is None
                or receipt.get("inputs", {}).get("recreation_resume", {}).get("proof_sha256")
                    != hashlib.sha256(canonical(expected_proof)).hexdigest()):
            raise BuildControlError("Recreation revalidation does not own the exact active start lease")
        if (_control_bytes(control, current_operation["root"] + "/receipt.json") != canonical(receipt) + b"\n"
                or control._pin_operation_helper(current_operation) != helper_id):
            raise BuildControlError("Recreation active start lease receipt/helper changed")

    operation_id = args.resume_recreation
    operation_root = "recreate-services/attempts/" + operation_id
    operation_raw, operation_terminal = _read_canonical_control_record(
        control, operation_root + "/terminal.json", "recreation operation terminal receipt"
    )
    retained_raw, retained = _read_canonical_control_record(
        control, operation_root + "/retained-containers.json", "recreation retained-container snapshot"
    )
    snapshot, proof, native_recovery_context = _validate_removed_recreation_proof(
        args, control, previous, document, identity, operation_id=operation_id,
        operation_raw=operation_raw, operation_terminal=operation_terminal,
        retained_raw=retained_raw, retained=retained, previous_raw=previous_raw,
        document_raw=document_raw, operator_probe_record=operator_probe_record,
        helper_source_binding=helper_source_binding,
    )
    if expected_proof is not None and proof != expected_proof:
        raise BuildControlError("Recreation resume evidence changed before the new start admission")
    if current_raw != canonical(current) + b"\n" or current != previous:
        _validate_failed_prestart_successor(
            args,
            control,
            selected,
            identity,
            current_raw=current_raw,
            current=current,
            previous_raw=previous_raw,
            previous=previous,
            document_raw=document_raw,
            operation_raw=operation_raw,
            operation_terminal=operation_terminal,
            retained_raw=retained_raw,
            operator_probe_record=operator_probe_record,
            helper_source_binding=helper_source_binding,
            native_recovery_context=native_recovery_context,
            removed_container_proof=proof,
        )
    return {
        "previous": previous,
        "document": document,
        "operation_terminal": operation_terminal,
        "snapshot": snapshot,
        "image_id": image,
        "operator_probe_record": operator_probe_record,
        "proof": proof,
        "native_recovery_context": native_recovery_context,
    }


def _resume_recreated_operation(args, control, selected, layout, identity, *, helper_source_binding=None):
    records = _validate_recreation_resume_records(
        args, control, selected, identity, helper_source_binding=helper_source_binding
    )
    previous = records["previous"]
    document = records["document"]
    operation_terminal = records["operation_terminal"]
    snapshot = records["snapshot"]
    image = records["image_id"]
    proof = records["proof"]
    operator_probe_record = records["operator_probe_record"]
    backend_id = proof["container_id"]

    if _retained_startup_enabled(snapshot["backend"]):
        stop_path = "verification/stop-failed-" + backend_id + ".json"
        stop = control.read(stop_path)
        failure = stop.get("failure_receipt", {}).get("receipt", {})
        drained = control.read("runtime-control/runtime-service/process-tree.json")
        if (
            operation_terminal.get("pre_activation_stop_receipt") != stop_path
            or stop.get("state") != "stopped-confirmed"
            or stop.get("container_id") != backend_id
            or stop.get("image_id") != image
            or failure.get("error") != "startup activation state parent is unavailable: /state/.fullmag"
            or drained.get("state") != "drained"
            or drained != stop.get("drained_process_receipt")
            or "startup_activation" in drained
        ):
            raise BuildControlError("Retained startup activation is not an exact pre-activation failure")
    elif "pre_activation_stop_receipt" in operation_terminal:
        raise BuildControlError("Recreation receipt has an unexpected pre-activation failure pin")

    state = storage.validate_path(
        Path(previous["state_root"]), layout["runtime_root"], "retained Windows sessions"
    )
    certificate_path = _certificate_path(state)
    certificate = _retained_certificate(state, document)
    from docker_volume_pre_api_stop import PreApiContext
    pre_api_stopped = isinstance(records["native_recovery_context"], PreApiContext)
    carry_resume_metadata = operation_terminal.get("post_build_generation")
    carry_resume_proof = operation_terminal.get("pre_admission_recreate")
    if certificate.get("image_id") != image:
        raise BuildControlError("Retained storage certificate image differs from recreation resume")
    from docker_volume_pending_continuation import _classify_recreate_resume
    carry_resume = (
        _classify_recreate_resume(
            operation_terminal,
            certificate,
            records["native_recovery_context"],
        )
        == "carry"
    )
    if certificate.get("restart_verified") is not True and not pre_api_stopped:
        if not carry_resume or certificate.get("restart_verified") is not False:
            raise BuildControlError("Retained storage certificate does not authorize recreation resume")
    owner_path = state / _session_host().OWNER_NAME
    recovery_context = dict(records["native_recovery_context"])
    if carry_resume:
        if recovery_context != {}:
            raise BuildControlError(
                "Capture-only recreation resume has unexpected native recovery authority"
            )

    from docker_volume_activation_reconcile import reconcile_unknown_activation
    unresolved = control.read("activation/unresolved.json", optional=True)
    recorded_reconciliation = operation_terminal.get("activation_reconciliation")
    reconciliation = None
    if unresolved is not None:
        if not isinstance(recorded_reconciliation, Mapping):
            raise BuildControlError("Completed recreation did not record its activation reconciliation proof")
        reconciliation = reconcile_unknown_activation(
            control,
            previous=previous,
            document=document,
            selected_source=str(selected),
            config_sha256=args.config_sha256,
            image_id=image,
            backend_id=backend_id,
            native_restart_metadata=recovery_context.get("native_restart_metadata"),
            fresh_state=False,
        )
        if reconciliation is None:
            raise BuildControlError("Recorded activation reconciliation is no longer present")
        reconciliation_summary = {
            key: reconciliation[key]
            for key in (
                "attempt", "activation_receipt_sha256", "native_stop_journal_sha256",
                "namespace_attestation_path", "namespace_attestation_sha256",
            )
            if key in reconciliation
        }
        if reconciliation_summary != dict(recorded_reconciliation):
            raise BuildControlError("Activation reconciliation differs from the completed recreation receipt")
    elif recorded_reconciliation is not None:
        raise BuildControlError("Completed recreation records an activation reconciliation without its quarantine")

    accepted_reattach_context = {}
    accepted_record = operation_terminal.get("accepted_reattach")
    if reconciliation is not None:
        from docker_volume_accepted_reattach import produce_accepted_reattach
        accepted_store_root = storage.validate_path(
            state / "runs" / "docker-all" / "session-store",
            state,
            "retained accepted session store",
        )
        produced = produce_accepted_reattach(control, store_root=accepted_store_root)
        accepted_environment = _validate_accepted_reattach_environment(produced.get("environment"))
        accepted_pins = _validate_accepted_reattach_metadata(produced.get("pins"), accepted_environment)
        if accepted_record != accepted_pins:
            raise BuildControlError("Accepted-run reattach differs from the completed recreation receipt")
        accepted_reattach_context = {
            "accepted_reattach_environment": accepted_environment,
            "accepted_reattach_metadata": accepted_pins,
        }
    elif accepted_record is not None:
        raise BuildControlError("Completed recreation records an unexpected accepted-run reattach")

    post_build_generation = carry_resume_metadata
    if post_build_generation is not None:
        if carry_resume:
            from docker_volume_pending_continuation import (
                validate_carry_recreate_receipt,
                validate_pending_capture_continuation,
            )
            _assert_post_build_removed_namespace_absent(post_build_generation)
            try:
                carried = validate_pending_capture_continuation(
                    control,
                    previous=previous,
                    document=document,
                    expected_attempt=previous["attempt"],
                    expected_project=control.project,
                    expected_source_root=previous["inputs"]["source_root"],
                    expected_config_sha256=carry_resume_proof.get("config_sha256"),
                    certificate_evidence=_post_build_certificate_evidence(state, certificate),
                    accepted_context=accepted_reattach_context,
                    runtime_config_sha256=_read_runtime_config_digest(control),
                    pre_admission_recreate_proof=carry_resume_proof,
                )
                validate_carry_recreate_receipt(
                    operation_terminal,
                    metadata=carried["metadata"],
                    pre_admission_proof=carry_resume_proof,
                    recreation_attempt=operation_terminal["attempt"],
                    accepted_producer=operation_terminal.get("accepted_reattach"),
                )
            except BuildControlError as error:
                raise BuildControlError(
                    "Completed capture-only continuation changed: " + str(error)
                ) from error
            post_build_generation = carried["metadata"]
            recovery_context["previous_config_sha256"] = carried[
                "previous_config_sha256"
            ]
            recovery_context["post_build_generation"] = post_build_generation
        else:
            from docker_volume_post_build_generation import (
                bind_recreate_operation,
                validate_resume_continuation,
            )
            try:
                # Native continuation is bound to the exact completed
                # terminal/snapshot/absence evidence.  This branch is not
                # used for a capture-only receipt.
                post_build_generation = bind_recreate_operation(
                    post_build_generation, proof
                )
                validated_post_build_generation = validate_resume_continuation(
                    control,
                    post_build_generation,
                    operation_id=previous.get("attempt"),
                    expected_project=control.project,
                    expected_source_root=str(selected),
                    previous=previous,
                    document=document,
                    accepted_context=accepted_reattach_context,
                )
            except BuildControlError as error:
                raise BuildControlError("Completed post-build continuation changed: " + str(error)) from error
            accepted_record = validated_post_build_generation.get("accepted_run")
            if accepted_record and not accepted_reattach_context:
                raise BuildControlError("Completed post-build continuation lost its accepted-run proof")
            recovery_context["previous_config_sha256"] = validated_post_build_generation[
                "runtime_config"
            ]["sha256"]
            recovery_context["post_build_generation"] = validated_post_build_generation

    reuse = {
        "state": state,
        "host_certificate": certificate_path,
        "owner_marker": owner_path,
        "receipt": {"image_id": image},
        "operator_probe_environment_record": operator_probe_record,
    }
    if helper_source_binding is not None:
        reuse["helper_source_binding"] = helper_source_binding
    recovery_context.update(accepted_reattach_context)
    args.include_untracked = include_untracked_from_compose(document)
    args.gpu_access = previous["inputs"]["gpu_access_requested"]
    return start(
        args,
        reuse_state=reuse,
        recreation_resume_proof=proof,
        retained_device_access=_retained_device_access(previous, document),
        helper_source_binding=helper_source_binding,
        **recovery_context,
    )




def _verified_frontend_recovery_image(control, selected):
    """Attest the current image recipe and its immutable parent chain; never build."""
    from bootstrap_docker_toolchain import read_input, tracked_input_files
    from docker_dev import BASE_CONTEXT_FILES, RUNTIME_IMAGE_CONTEXT_FILES
    from docker_build_control import toolchain_configuration
    configured = toolchain_configuration(selected, control.identity)
    build = configured['services']['fem-gpu-toolchain']['build']
    toolchain = control.read('toolchain/verified.json')
    expected = {'source_inputs': [{'path': p.as_posix(), 'sha256': hashlib.sha256(read_input(selected, p)).hexdigest()}
                                 for p in tracked_input_files(selected)],
                'build_args': build.get('args', {}), 'target': build['target']}
    parent = None
    parent_layers = None
    witness = {}
    for kind, inventory in (('toolchain', None), ('image-dev', BASE_CONTEXT_FILES),
                            ('image-backend', RUNTIME_IMAGE_CONTEXT_FILES)):
        receipt = toolchain if kind == 'toolchain' else control.read(kind + '/verified.json')
        if inventory is not None:
            names = sorted({relative for _, relative in inventory}
                           | {'docker/all-in-one/Dockerfile.' + kind.removeprefix('image-') + '.dockerignore'})
            expected = {'parent_image_id': parent, 'files': [
                {'path': name, 'sha256': hashlib.sha256(read_input(selected, name)).hexdigest()} for name in names]}
        digest = hashlib.sha256(canonical(expected)).hexdigest()
        image = receipt.get('image_id')
        if (receipt.get('schema') != 'fullmag.docker-build-operation.v1'
                or receipt.get('phase') != kind or receipt.get('state') != 'succeeded'
                or receipt.get('compose_project') != control.project or receipt.get('control_volume') != control.volume
                or receipt.get('inputs') != expected or receipt.get('source_digest') != digest
                or not isinstance(image, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', image)):
            raise BuildControlError('Frontend recovery image recipe/receipt differs: ' + kind)
        records = json.loads(docker_text('image', 'inspect', image))
        if len(records) != 1 or records[0].get('Id') != image:
            raise BuildControlError('Frontend recovery image identity differs: ' + kind)
        observed = records[0]
        layers = observed.get('RootFS', {}).get('Layers')
        if not isinstance(layers, list) or not layers or (parent_layers is not None
                and (len(layers) < len(parent_layers) or layers[:len(parent_layers)] != parent_layers)):
            raise BuildControlError('Frontend recovery image parent layers differ: ' + kind)
        labels = observed.get('Config', {}).get('Labels', {})
        if inventory is not None and (labels.get('org.fullmag.compose.project') != control.project
                or labels.get('org.fullmag.build.input-digest') != digest
                or labels.get('org.fullmag.toolchain.image-id') != toolchain['image_id']):
            raise BuildControlError('Frontend recovery image labels differ: ' + kind)
        witness[kind] = {'image_id': image, 'receipt_sha256': hashlib.sha256(canonical(receipt)).hexdigest(),
                         'input_sha256': digest}
        parent, parent_layers = image, layers
    return parent, witness


def _frontend_recovery_backend_observation(backend_id, *, allow_empty=False):
    """Read only process incarnations and public session identity, never owner secrets."""
    import docker_dev_codegen as codegen
    probe = 'ALLOW_EMPTY=' + repr(allow_empty) + '\n' + r'''import json,os,pathlib,urllib.request
processes=[]
for entry in pathlib.Path('/proc').iterdir():
 if not entry.name.isdigit():continue
 try:
  executable=os.readlink(entry/'exe')
  if pathlib.Path(executable).name.startswith('fullmag-'):
   fields=(entry/'stat').read_text().rsplit(')',1)[1].split()
   processes.append({'pid':int(entry.name),'executable':executable,'start_ticks':fields[19]})
 except (FileNotFoundError,ProcessLookupError,PermissionError):continue
if sum(pathlib.Path(p['executable']).name=='fullmag-api' for p in processes)!=1:raise RuntimeError('Expected one live API process')
with urllib.request.urlopen('http://127.0.0.1:8081/v2/platform/health',timeout=5) as r:
 health=json.load(r)
 if r.status!=200 or health.get('status')!='ok' or (health.get('active_session') is not True and not (ALLOW_EMPTY and health.get('active_session') is False)):raise RuntimeError('Backend API has no healthy retained session')
 api=r.headers.get('x-fullmag-api-instance')
if ALLOW_EMPTY and health['active_session'] is False:
 if not api:raise RuntimeError('API incarnation is incomplete')
 print(json.dumps({'processes':sorted(processes,key=lambda p:p['pid']),'api_instance_id':api,
  'active_session':False,'session':None,'run_id':None,'scene_revision':None}))
 raise SystemExit(0)
with urllib.request.urlopen('http://127.0.0.1:8081/v2/sessions/current/status',timeout=5) as r:
 status=json.load(r)
 if r.status!=200 or not api or r.headers.get('x-fullmag-api-instance')!=api:raise RuntimeError('API incarnation changed')
 session=status.get('session')
 if not isinstance(session,dict) and not (ALLOW_EMPTY and session is None and health['active_session'] is False):raise RuntimeError('Expected the retained authoring session')
 identity={k:session.get(k) for k in ('session_id','session_epoch','request_scope_epoch')} if session is not None else None
 if identity is not None and not all(isinstance(v,str) and v for v in identity.values()):raise RuntimeError('Session identity is incomplete')
 resources=status.get('resources')
 if not isinstance(resources,dict) or type(resources.get('scene_revision')) is not int or resources['scene_revision']<0:raise RuntimeError('Scene revision is incomplete')
 run=status.get('run')
 if run is not None and (not isinstance(run,dict) or not isinstance(run.get('run_id'),str) or not run['run_id']):raise RuntimeError('Run identity is malformed')
print(json.dumps({'processes':sorted(processes,key=lambda p:p['pid']),'api_instance_id':api,
 'active_session':health['active_session'],'session':identity,'run_id':run['run_id'] if run is not None else None,
 'scene_revision':resources['scene_revision']}))
'''
    output, _ = codegen._exec(backend_id, ('/usr/local/bin/python3', '-B', '-c', probe), stdout_limit=65536)
    return json.loads(output)


def _frontend_refresh_document(document, volume, inputs, *, frontend_image=None):
    import copy
    refreshed = copy.deepcopy(document)
    refreshed['volumes']['frontend-build']['name'] = volume
    refreshed['services']['frontend']['environment']['FULLMAG_SOURCE_COMMIT'] = inputs['source_commit']
    # Upgrade the former default; preserve explicitly different retained limits.
    frontend = refreshed['services']['frontend']
    if str(frontend.get('mem_limit')) in ('6442450944', '6g'):
        frontend['mem_limit'] = str(8 * 1024**3)
    if frontend_image is not None:
        frontend = refreshed['services']['frontend']
        frontend['image'] = frontend_image
        frontend['tmpfs'] = [value for value in frontend.get('tmpfs', [])
            if value.split(':', 1)[0] != _FRONTEND_OWNER_TMPFS] + [
            _FRONTEND_OWNER_TMPFS + ':rw,nosuid,nodev,noexec,size=1m,uid=65532,gid=65532,mode=0700']
    if refreshed['services']['backend'] != document['services']['backend']:
        raise BuildControlError('Frontend refresh changed the retained backend declaration')
    return refreshed


def _refresh_frontend_services(control, args, previous_root, previous, document, selected,
                               layout, actual, ids, image, operator_probe_record, *, recover_oom=False, frozen_context=None):
    """Create a new DEV handoff by replacing only the frontend generation."""
    import docker_dev_codegen as codegen
    from docker_development_inputs import describe, frontend_view
    from docker_volume_reconcile import fingerprint
    host = _session_host()
    read_owned_regular = host.read_owned_regular
    from docker_build_control import ControlOutcomeUnknown
    state = storage.validate_path(Path(previous['state_root']), layout['runtime_root'], 'retained sessions')
    if args.port != int(document['services']['frontend']['environment']['FULLMAG_FRONTEND_HOST_PORT']):
        raise BuildControlError('Frontend refresh port differs from retained published port')
    if _retained_startup_enabled(actual['backend']):
        raise BuildControlError('Frontend refresh will not repeat startup activation')
    certificate_path = _certificate_path(state)
    owner_path = state / host.OWNER_NAME
    certificate = read_owned_regular(certificate_path)
    owner = read_owned_regular(owner_path)
    if canonical(json.loads(owner)) != canonical(json.loads(certificate)):
        raise BuildControlError('Frontend refresh owner/certificate differs')
    backend_pin = (actual['backend']['State']['StartedAt'], fingerprint(actual['backend']))
    old_frontend_pin = (actual['frontend']['State']['StartedAt'], fingerprint(actual['frontend']))
    oom_state = {key: actual['frontend']['State'].get(key)
                 for key in ('Running', 'OOMKilled', 'ExitCode', 'StartedAt', 'FinishedAt')}
    if recover_oom and (actual['backend']['State'].get('Running') is not True
            or actual['backend']['State'].get('Health', {}).get('Status') != 'healthy'
            or oom_state['Running'] is not False or oom_state['OOMKilled'] is not True
            or type(oom_state['ExitCode']) is not int or oom_state['ExitCode'] == 0
            or not oom_state['StartedAt'] or not oom_state['FinishedAt']):
        raise BuildControlError('Legacy frontend recovery requires its exact OOM-stopped frontend and healthy backend')
    frontend_image = document['services']['frontend'].get('image', image)
    image_witness = None
    backend_observation = None
    if frozen_context is not None:
        from docker_volume_frontend_frozen_recovery import backend_observation
        backend_observation_pin = backend_observation(ids['backend'])
    if recover_oom:
        frontend_image, image_witness = _verified_frontend_recovery_image(control, selected)
        backend_observation = _frontend_recovery_backend_observation(ids['backend'])
    def inspect_services(frontend_id):
        current = {name: json.loads(docker_text('inspect', identifier))[0]
                   for name, identifier in {'backend': ids['backend'], 'frontend': frontend_id}.items()}
        backend = current['backend']
        if ((backend['State']['StartedAt'], fingerprint(backend)) != backend_pin
                or backend.get('Id') != ids['backend'] or not backend['State'].get('Running')
                or backend['State'].get('Health', {}).get('Status') != 'healthy'):
            raise BuildControlError('Retained backend incarnation/configuration changed during frontend refresh')
        frontend = current['frontend']
        if (frontend.get('Id') != frontend_id or (frontend_id == ids['frontend']
                and (frontend['State']['StartedAt'], fingerprint(frontend)) != old_frontend_pin)):
            raise BuildControlError('Owned frontend incarnation/configuration changed before refresh')
        if recover_oom:
            if frontend_id == ids['frontend'] and any(frontend['State'].get(k) != v for k, v in oom_state.items()):
                raise BuildControlError('OOM frontend state changed before controlled recreation')
            if _frontend_recovery_backend_observation(ids['backend']) != backend_observation:
                raise BuildControlError('Backend processes/session changed during frontend recovery')
        if frozen_context is not None and backend_observation(ids['backend']) != backend_observation_pin:
            raise BuildControlError('Terminal backend observation changed during frontend refresh')
        _assert_private_restart_network(current, {'backend': ids['backend'], 'frontend': frontend_id}, control.project)
        return current
    health_script = "import json,urllib.request\nwith urllib.request.urlopen('http://127.0.0.1:8081/v2/platform/health',timeout=5) as r:\n value=json.load(r)\n if r.status!=200 or value.get('status')!='ok' or value.get('active_session') is not False:raise RuntimeError('Frontend refresh requires an empty healthy API')\n print(json.dumps(value))"
    def source_matches(probe, backend_source, package):
        if frozen_context is None:
            return codegen._source_matches(probe, backend_source)
        from docker_volume_frontend_frozen_recovery import source_qualification
        source_qualification(control, frozen_context['request'], actual['backend'],
                             probe, backend_source, package['source'])
        return True
    def healthy_idle():
        if frozen_context is not None:
            value = backend_observation(ids['backend'])
            if value != backend_observation_pin:
                raise BuildControlError('Terminal backend observation changed during frontend refresh')
            return value
        if recover_oom:
            return _frontend_recovery_backend_observation(ids['backend'])
        return json.loads(docker_text('exec', ids['backend'], '/usr/local/bin/python3', '-B', '-c', health_script))
    inputs = {**previous['inputs'], 'source_root': str(selected), 'image_id': image,
        'frontend_refresh_from_attempt': args.attempt, 'frontend_refresh_from_config_sha256': args.config_sha256,
        'native_build_requested': False, **operator_probe_record}
    if recover_oom:
        inputs.update(frontend_recovery_image_id=frontend_image, frontend_recovery_image_witness=image_witness,
                      selected_source_qualification='NOT VERIFIED')
    if frozen_context is not None:
        inputs['helper_transition'] = frozen_context['request']['source_transition']
    inputs.pop('attempt', None)
    inputs.pop('config_sha256', None)
    with control.operation('development', inputs) as operation:
        operation['receipt'].update(operator_probe_record)
        operation['receipt'].update(state='validating-frontend-refresh', state_root=str(state),
            backend_volumes=previous['backend_volumes'], previous_frontend_volume=previous['frontend_volume'])
        inspect_services(ids['frontend']); healthy_idle()
        if frozen_context is not None:
            from docker_volume_frontend_frozen_recovery import refresh_context
            repeated = refresh_context(control, args, previous, document, actual)
            if repeated != frozen_context:
                raise BuildControlError('Frozen frontend proof changed under refresh lease')
        try:
            package, provenance, package_sha, binary_provenance = codegen._backend_documents(ids['backend'])
            backend_source, _, _ = codegen._validate_backend(package, provenance, package_sha, binary_provenance)
            source_probe = None
            if not recover_oom:
                source_probe, _ = codegen._probe_source(ids['backend'], operation['receipt']['attempt'])
        except codegen.CodegenError as error:
            if error.reconciliation_required:
                raise ControlOutcomeUnknown(str(error)) from error
            raise
        if not recover_oom and not source_matches(source_probe, backend_source, package):
            raise BuildControlError('Frontend refresh requires the current native source capture; run the canonical idle restart first')
        desired = describe(selected, args.port)
        control.write(operation['root'] + '/rollback-compose.json', document)
        control.write(operation['root'] + '/rollback-development-inputs.json',
                      control.read('frontend/development-inputs.json'))
        for name in ('backend-cache.json', 'host-ledger.json', 'ledger-maintenance-compose.json'):
            control.write(operation['root'] + '/' + name, control.read(previous_root + '/' + name))
        # Quiesce the sole browser admission route before the final empty-API
        # fence. Unknown stop/seed outcomes retain this exact control lease.
        operation['daemon_pending'] = True
        if not recover_oom:
            docker_capture('stop', '--time', '60', ids['frontend'], timeout=90)
        quiesced = inspect_services(ids['frontend'])
        if quiesced['frontend']['State'].get('Running') is not False:
            raise BuildControlError('Owned frontend did not quiesce before refresh')
        healthy_idle()
        if not recover_oom:
            source_probe, _ = codegen._probe_source(ids['backend'], operation['receipt']['attempt'])
            if not source_matches(source_probe, backend_source, package):
                raise BuildControlError('Backend source changed after frontend quiescence')
        seeded, volume = _frontend(control, operation, selected, state, args.port, frontend_image)
        if seeded['files'] != desired['files']:
            raise BuildControlError('Frontend seed changed during refresh')
        refreshed = _frontend_refresh_document(document, volume, seeded,
            frontend_image=frontend_image if recover_oom else None)
        new_config_sha = hashlib.sha256(canonical(refreshed)).hexdigest()
        control.write(operation['root'] + '/compose.json', refreshed)
        control.write(operation['root'] + '/backend-build-receipt.json', package)
        control.write(operation['root'] + '/provenance.json', provenance)
        if recover_oom:
            if (_verified_frontend_recovery_image(control, selected) != (frontend_image, image_witness)
                    or codegen._backend_documents(ids['backend']) != (package, provenance, package_sha, binary_provenance)):
                raise BuildControlError('Recovery image or backend package changed before frontend recreation')
        healthy_idle(); inspect_services(ids['frontend'])
        operation['receipt']['state'] = 'recreating-owned-frontend'
        compose_capture(refreshed, 'up', '--detach', '--no-build', '--pull', 'never',
                        '--no-deps', '--force-recreate', 'frontend', timeout=180)
        frontend_id = compose_capture(refreshed, 'ps', '--all', '--quiet', 'frontend').decode().strip()
        if not re.fullmatch('[0-9a-f]{64}', frontend_id) or frontend_id == ids['frontend']:
            raise BuildControlError('Frontend refresh did not produce one new owned incarnation')
        deadline = time.monotonic() + 3900
        while time.monotonic() < deadline:
            current = inspect_services(frontend_id)
            if current['frontend'].get('HostConfig', {}).get('Memory') != int(refreshed['services']['frontend']['mem_limit']):
                raise BuildControlError('Recreated frontend memory limit differs from the retained configuration')
            if current['frontend'].get('Id') != frontend_id or current['frontend'].get('Image') != frontend_image:
                raise BuildControlError('New frontend image/incarnation differs')
            _validate_retained_service(refreshed, current['frontend'], 'frontend',
                                      json.loads(docker_text('image', 'inspect', frontend_image))[0]['Config'])
            if not current['frontend']['State'].get('Running'):
                raise BuildControlError('New frontend exited; old cache and rollback configuration retained')
            if current['frontend']['State'].get('Health', {}).get('Status') == 'healthy':
                break
            time.sleep(3)
        else:
            raise BuildControlError('New frontend readiness timed out; exact resources retained')
        frontend_pin = (current['frontend']['State']['StartedAt'], fingerprint(current['frontend']))
        view = frontend_view(frontend_id, selected, args.port, inputs=seeded)
        control.write(operation['root'] + '/frontend-source-view.json', view)
        again_package, again_provenance, again_sha, again_binary = codegen._backend_documents(ids['backend'])
        again_probe = None
        if not recover_oom:
            again_probe, _ = codegen._probe_source(ids['backend'], operation['receipt']['attempt'])
        if (again_package != package or again_provenance != provenance or again_sha != package_sha
                or again_binary != binary_provenance
                or (not recover_oom and not source_matches(again_probe, backend_source, package))
                or describe(selected, args.port)['files'] != seeded['files']
                or read_owned_regular(certificate_path) != certificate
                or read_owned_regular(owner_path) != owner):
            raise BuildControlError('Backend package/source, frontend seed or session storage changed during refresh')
        if recover_oom and _verified_frontend_recovery_image(control, selected) != (frontend_image, image_witness):
            raise BuildControlError('Frontend recovery image inputs changed after recreation')
        healthy_idle(); final = inspect_services(frontend_id)
        if ((final['frontend']['State']['StartedAt'], fingerprint(final['frontend'])) != frontend_pin
                or final['frontend']['State'].get('Running') is not True
                or final['frontend']['State'].get('Health', {}).get('Status') != 'healthy'):
            raise BuildControlError('New frontend changed during source-view verification')
        if recover_oom:
            operation['receipt'].update(recovery_scope='legacy-oom-frontend-recreation',
                selected_source_qualification='NOT VERIFIED', backend_observation=backend_observation,
                frontend_generation_changed=True, frontend_image_id=frontend_image,
                replaced_frontend_container=ids['frontend'], frontend_oom_state=oom_state)
        if frozen_context is not None:
            from docker_volume_frontend_frozen_recovery import complete_refresh
            complete_refresh(control, operation, frozen_context, final['backend'])
            operation['receipt']['frontend_frozen_resume'] = {
                'attempt': frozen_context['resume'], 'terminal_sha256': frozen_context['terminal_sha256']}
        operation['receipt'].update(frontend_volume=volume, backend_container=ids['backend'],
            frontend_container=frontend_id, backend_started_at=backend_pin[0], config_sha256=new_config_sha,
            source_commit=backend_source['commit'], source_digest=backend_source['source_digest'],
            source_snapshot_sha256=backend_source['snapshot'], backend_build_receipt_sha256=package_sha,
            url='http://127.0.0.1:' + str(args.port), native_build_executed=False,
            previous_development_attempt=args.attempt, previous_config_sha256=args.config_sha256)
        operation['daemon_pending'] = False
        operation['receipt']['state'] = 'succeeded'
    return


def refresh_frontend(args):
    return _retained_operation(args, recreate_services=False, refresh_frontend_service=True)


def _completed_recreation_start_context(control, args, selected, layout):
    """Continue one exact completed removal; never repeat container deletion."""
    from docker_volume_stop_unadmitted import _control_bytes
    from docker_volume_container_recovery import _assert_container_absent
    attempt = getattr(args, "completed_recreation_attempt", None)
    digest = getattr(args, "completed_recreation_sha256", None)
    if (not isinstance(attempt, str) or _RECOVERY_ATTEMPT.fullmatch(attempt) is None
            or not isinstance(digest, str) or _SHA256.fullmatch(digest) is None
            or getattr(args, "fresh_state", False) or getattr(args, "recovery_authorization", None)):
        raise BuildControlError("Completed recreation requires paired exact pins and retained state")
    base = "recreate-services/attempts/" + attempt
    raw = _control_bytes(control, base + "/terminal.json")
    if hashlib.sha256(raw).hexdigest() != digest:
        raise BuildControlError("Completed recreation terminal digest differs")
    completed = json.loads(raw)
    for path in (base + "/receipt.json", "recreate-services/current.json", "recreate-services/verified.json"):
        if _control_bytes(control, path) != raw:
            raise BuildControlError("Completed recreation terminal/current/verified CAS differs")
    previous_base = "development/attempts/" + args.attempt
    previous_raw = _control_bytes(control, previous_base + "/terminal.json")
    if any(_control_bytes(control, path) != previous_raw for path in ("development/current.json", "development/verified.json")):
        raise BuildControlError("A newer or inconsistent development authority superseded this continuation")
    previous = json.loads(previous_raw)
    document_raw = _control_bytes(control, previous_base + "/compose.json")
    document = json.loads(document_raw)
    image = previous.get("inputs", {}).get("image_id")
    ids = [previous.get("backend_container"), previous.get("frontend_container")]
    if (previous.get("state") != "succeeded" or previous.get("compose_project") != control.project
            or previous.get("attempt") != args.attempt or previous.get("config_sha256") != args.config_sha256
            or previous.get("inputs", {}).get("source_root") != str(selected)
            or document.get("name") != control.project or hashlib.sha256(canonical(document)).hexdigest() != args.config_sha256
            or any(not isinstance(value, str) or _SHA256.fullmatch(value) is None for value in ids)
            or len(set(ids)) != 2 or not isinstance(image, str) or re.fullmatch("sha256:[0-9a-f]{64}", image) is None):
        raise BuildControlError("Completed recreation old development authority differs")
    if (completed.get("schema") != "fullmag.docker-build-operation.v1" or completed.get("phase") != "recreate-services"
            or completed.get("state") != "succeeded" or completed.get("attempt") != attempt
            or completed.get("compose_project") != control.project or completed.get("fresh_state") is not False
            or completed.get("inputs", {}).get("attempt") != args.attempt
            or completed.get("inputs", {}).get("config_sha256") != args.config_sha256
            or completed.get("removed_containers") != ids
            or completed.get("retained_volumes") != previous.get("backend_volumes")
            or completed.get("retained_frontend_volume") != previous.get("frontend_volume")
            or completed.get("previous_state_root") != previous.get("state_root")):
        raise BuildControlError("Completed recreation removal/state/cache proof differs")
    if completed.get("accepted_reattach") is not None or completed.get("activation_reconciliation") is not None:
        raise BuildControlError("Completed recreation with accepted-run reattach requires its retained handoff; continuation refused")
    for identifier in ids:
        _assert_container_absent(identifier)
    state = storage.validate_path(Path(previous["state_root"]), layout["runtime_root"], "retained sessions")
    host = _session_host()
    certificate_path = _certificate_path(state)
    owner_marker = state / host.OWNER_NAME
    certificate = json.loads(host.read_owned_regular(certificate_path))
    if (canonical(json.loads(host.read_owned_regular(owner_marker))) != canonical(certificate)
            or certificate.get("image_id") != image or certificate.get("restart_verified") is not True
            or document["services"]["backend"]["environment"].get("FULLMAG_STARTUP_ENABLED") == "1"):
        raise BuildControlError("Completed recreation session owner/admission/startup differs")
    if str(args.port) != document["services"]["frontend"]["environment"].get("FULLMAG_FRONTEND_HOST_PORT"):
        raise BuildControlError("Completed recreation retained frontend port differs")
    retained_raw, retained = _read_canonical_control_record(
        control, base + "/retained-containers.json", "completed recreation retained-container snapshot"
    )
    operator_probe_record = _operator_probe_record_from_retained(previous, document)
    _, removed_proof, recovery = _validate_removed_recreation_proof(
        args, control, previous, document, control.identity, operation_id=attempt,
        operation_raw=raw, operation_terminal=completed, retained_raw=retained_raw,
        retained=retained, previous_raw=previous_raw, document_raw=document_raw,
        operator_probe_record=operator_probe_record,
    )
    from docker_volume_drained_successor import DrainedSuccessorContext
    from docker_volume_startup_diagnostic_restart import StartupDiagnosticStopContext
    if (not isinstance(recovery, (DrainedSuccessorContext, StartupDiagnosticStopContext))
            and (not recovery.get("previous_config_sha256") or not recovery.get("native_restart_metadata")
                 or recovery.get("recovery_environment") or recovery.get("recovery_metadata"))):
        raise BuildControlError("Completed recreation requires the exact managed failed-owner restart proof")
    reuse = {"state": state, "host_certificate": certificate_path,
        "owner_marker": owner_marker, "receipt": {"image_id": image},
        "operator_probe_environment_record": operator_probe_record,
        "removed_recreation_proof_sha256": hashlib.sha256(canonical(removed_proof)).hexdigest()}
    return {"reuse_state": reuse,
            "retained_device_access": _retained_device_access(previous, document), **recovery}


def _resume_oom_frontend(control, args, document, actual, ids, selected):
    """Restore only the exact OOM-stopped frontend; do not qualify stale native sources."""
    import docker_dev_codegen as codegen
    from docker_volume_reconcile import fingerprint
    frontend_state = actual['frontend']['State']
    if (actual['backend']['State'].get('Running') is not True
            or actual['backend']['State'].get('Health', {}).get('Status') != 'healthy'
            or frontend_state.get('Running') is not False
            or frontend_state.get('OOMKilled') is not True
            or not isinstance(frontend_state.get('ExitCode'), int) or frontend_state['ExitCode'] == 0
            or not frontend_state.get('FinishedAt')):
        raise BuildControlError('Successful-start resume requires its exact OOM-stopped frontend and healthy backend')
    if args.port != int(document['services']['frontend']['environment']['FULLMAG_FRONTEND_HOST_PORT']):
        raise BuildControlError('OOM frontend recovery port differs from the retained port')
    pins = {name: fingerprint(actual[name]) for name in ('backend', 'frontend')}
    backend_started = actual['backend']['State']['StartedAt']
    package_before = codegen._backend_documents(ids['backend'])
    native_source, _, _ = codegen._validate_backend(*package_before)
    process_probe = """import json,os,pathlib
result=[]
for entry in pathlib.Path('/proc').iterdir():
 if not entry.name.isdigit():continue
 try:
  executable=os.readlink(entry/'exe')
  if pathlib.Path(executable).name.startswith('fullmag-'):
   fields=(entry/'stat').read_text().rsplit(')',1)[1].split()
   result.append({'pid':int(entry.name),'executable':executable,'start_ticks':fields[19]})
 except (FileNotFoundError,ProcessLookupError,PermissionError):continue
if sum(pathlib.Path(p['executable']).name=='fullmag-api' for p in result)!=1:raise RuntimeError('Expected one live API process')
print(json.dumps(sorted(result,key=lambda p:p['pid'])))
"""
    def processes():
        output, _ = codegen._exec(ids['backend'], ('/usr/local/bin/python3', '-B', '-c', process_probe), stdout_limit=65536)
        return json.loads(output)
    process_before = processes()
    inputs = {'development_attempt': args.attempt, 'config_sha256': args.config_sha256,
              'source_root': str(selected), 'backend_container': ids['backend'],
              'frontend_container': ids['frontend'], 'fingerprints': pins,
              'frontend_oom_finished_at': frontend_state['FinishedAt'],
              'frontend_oom_exit_code': frontend_state['ExitCode']}
    def inspect_unchanged():
        current = {name: json.loads(docker_text('inspect', ids[name]))[0] for name in ('backend', 'frontend')}
        for name in current:
            if fingerprint(current[name]) != pins[name]:
                raise BuildControlError('Container configuration changed during OOM frontend recovery')
        backend = current['backend']['State']
        if (backend.get('Running') is not True or backend.get('Health', {}).get('Status') != 'healthy'
                or backend.get('StartedAt') != backend_started or processes() != process_before):
            raise BuildControlError('Backend processes changed during OOM frontend recovery')
        _assert_private_restart_network(current, ids, control.project)
        return current
    with control.operation('frontend-recovery', inputs) as operation:
        current = inspect_unchanged()
        if any(current['frontend']['State'].get(key) != frontend_state.get(key)
               for key in ('Running', 'OOMKilled', 'ExitCode', 'StartedAt', 'FinishedAt')):
            raise BuildControlError('OOM frontend incarnation changed before recovery admission')
        # Starting the retained service preserves its seed, dependencies and current session.
        operation['daemon_pending'] = True
        docker_capture('start', ids['frontend'], timeout=90)
        deadline = time.monotonic() + 600
        recovered_start = None
        while True:
            current = inspect_unchanged()
            state = current['frontend']['State']
            if recovered_start is not None and state.get('StartedAt') != recovered_start:
                raise BuildControlError('Frontend restarted again during recovery observation')
            recovered_start = state.get('StartedAt')
            if recovered_start == frontend_state.get('StartedAt'):
                raise BuildControlError('Frontend recovery did not establish a new process incarnation')
            if state.get('Running') is not True:
                operation['daemon_pending'] = False
                raise BuildControlError('Retained frontend exited again; no automatic retry')
            if state.get('Health', {}).get('Status') == 'healthy':
                break
            if time.monotonic() >= deadline:
                raise BuildControlError('Frontend recovery observation timed out; reconcile the same incarnation')
            time.sleep(3)
        if codegen._backend_documents(ids['backend']) != package_before:
            raise BuildControlError('Backend package/provenance changed during OOM frontend recovery')
        final = inspect_unchanged()
        state = final['frontend']['State']
        if (state.get('Running') is not True or state.get('Health', {}).get('Status') != 'healthy'
                or state.get('StartedAt') != recovered_start):
            raise BuildControlError('Frontend no longer has the recovered healthy incarnation')
        operation['receipt'].update(state='succeeded', recovery_scope='frontend-process-only',
            backend_started_at=backend_started, backend_processes=process_before,
            backend_source=native_source, backend_build_receipt_sha256=package_before[2],
            frontend_started_at=state['StartedAt'], native_build_executed=False,
            frontend_generation_changed=False, selected_source_qualification='NOT VERIFIED',
            url='http://127.0.0.1:' + str(args.port))
        operation['daemon_pending'] = False



_RECOVERY_BUILD_SCHEMA = "fullmag.retained-recovery-build.v1"
_RECOVERY_HISTORY_BUILD_SCHEMA = "fullmag.retained-recovery-build.v2"
_RECOVERY_BUILD_HELPERS = ("backend_dev.py", "linux_native_probe.py")


def _recovery_build_request(raw):
    import docker_volume_container_recovery as recovery
    value = json.loads(raw)
    fields = {"schema", "authorization_pins", "retained_terminal_runs", "retained_held_manual_runs",
              "storage_proof_sha256", "certificate_sha256", "source_commit", "source_digest",
              "source_snapshot_sha256", "controller_sha256", "baked_helpers"}
    if not isinstance(value, dict) or value.get("schema") not in {_RECOVERY_BUILD_SCHEMA, _RECOVERY_HISTORY_BUILD_SCHEMA}:
        raise BuildControlError("Recovery build request fields/schema differ")
    history = value["schema"] == _RECOVERY_HISTORY_BUILD_SCHEMA
    if set(value) != fields | ({"retained_attempt_histories"} if history else set()):
        raise BuildControlError("Recovery build request fields/schema differ")
    recovery._abrupt_pins(value["authorization_pins"])
    recovery_request = {"schema_version": recovery.ATTEMPT_HISTORY_REQUEST_SCHEMA if history else recovery.HELD_MANUAL_REQUEST_SCHEMA,
        "retained_terminal_runs": value["retained_terminal_runs"],
        "retained_held_manual_runs": value["retained_held_manual_runs"]}
    if history:
        recovery_request["retained_attempt_histories"] = value["retained_attempt_histories"]
    recovery.expected_recovery_outcome(recovery_request)
    for key in ("storage_proof_sha256", "certificate_sha256", "source_digest", "source_snapshot_sha256", "controller_sha256"):
        recovery._require_sha(value[key], key)
    if not isinstance(value["source_commit"], str) or not re.fullmatch(r"[0-9a-f]{40}", value["source_commit"]):
        raise BuildControlError("Recovery build requires the full source commit")
    if not isinstance(value["baked_helpers"], dict) or set(value["baked_helpers"]) != set(_RECOVERY_BUILD_HELPERS):
        raise BuildControlError("Recovery build requires both baked helper pins")
    for key, digest in value["baked_helpers"].items():
        recovery._require_sha(digest, key)
    return value


def _recovery_build_helpers(backend_id, request, selected):
    """Authenticate the stopped image and its unchanged fail-closed handoff."""
    import ast
    import tarfile
    for name, symbol in (("backend_dev.py", "_serve"), ("linux_native_probe.py", "validate_host")):
        archive = docker_capture("cp", backend_id + ":/opt/fullmag/" + name, "-").stdout
        if len(archive) > 16 * 1024 * 1024:
            raise BuildControlError("Baked helper exceeds its observation budget")
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:*") as stream:
            members = stream.getmembers()
            if len(members) != 1 or not members[0].isfile() or members[0].size > 8 * 1024 * 1024:
                raise BuildControlError("Baked helper is not one bounded regular file")
            raw = stream.extractfile(members[0]).read()
        if hashlib.sha256(raw).hexdigest() != request["baked_helpers"][name]:
            raise BuildControlError("Baked recovery helper SHA differs: " + name)
        def function(source):
            nodes = [node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == symbol]
            if len(nodes) != 1:
                raise BuildControlError("Baked storage handoff function is ambiguous")
            return ast.dump(nodes[0], include_attributes=False)
        if function(raw) != function((selected / "docker/all-in-one" / name).read_bytes()):
            raise BuildControlError("Baked storage handoff differs from the reviewed launcher source")


def _recovery_build_certificate(state, document, request):
    host = _session_host()
    certificate = _retained_certificate(state, document)
    if certificate.get("storage_profile") != "linux-native-v1" or certificate.get("restart_verified") is not False:
        raise BuildControlError("Recovery build requires prepared, unverified Linux storage")
    evidence = {name: hashlib.sha256(host.read_owned_regular(state / name)).hexdigest()
                for name in host.READMISSION_FILES}
    if evidence[host.CERTIFICATE_NAME] != request["certificate_sha256"]:
        raise BuildControlError("Prepared recovery certificate SHA differs")
    return evidence


_RECOVERY_BUILD_CAPABILITY = r'''
import hashlib,json,os,stat,subprocess,sys
from pathlib import Path
root=Path('/opt/fullmag/package')
paths=[root/'bin/fullmag-bin',root/'backend-build-receipt.json',Path('/opt/fullmag/control/backend/runtime-provenance.json')]
def observe(path, maximum, shared_payload=False):
    if path.resolve(strict=True)!=path: raise RuntimeError('Capability path contains a link')
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as stream:
        before=os.fstat(stream.fileno())
        if (not stat.S_ISREG(before.st_mode) or not 0<before.st_size<=maximum
                or (before.st_nlink!=1 and (not shared_payload or before.st_mode&0o222))):
            raise RuntimeError('Capability input is not bounded owned or sealed regular data')
        digest=hashlib.sha256(); count=0; chunks=[]
        for block in iter(lambda:stream.read(1024*1024),b''):
            count+=len(block)
            if count>maximum or count>before.st_size: raise RuntimeError('Capability input exceeded its size bound')
            digest.update(block)
            if not shared_payload: chunks.append(block)
        after=os.fstat(stream.fileno())
    def identity(v): return (v.st_dev,v.st_ino,v.st_size,v.st_mtime_ns,v.st_ctime_ns,v.st_nlink,v.st_mode)
    if count!=before.st_size or identity(before)!=identity(after) or identity(after)!=identity(path.stat()):
        raise RuntimeError('Capability input changed')
    return digest.hexdigest(),None if shared_payload else b''.join(chunks)
def snapshot():
    return [observe(path,2*1024**3 if i==0 else 8*1024**2,shared_payload=i==0) for i,path in enumerate(paths)]
expected=json.loads(sys.argv[1])
if (not isinstance(expected,dict) or set(expected)!={'binary_sha256','receipt_sha256','provenance_sha256'}
        or any(not isinstance(value,str) or len(value)!=64 or any(c not in '0123456789abcdef' for c in value) for value in expected.values())):
    raise RuntimeError('Capability publication pins are invalid')
before=snapshot()
if [item[0] for item in before]!=[expected['binary_sha256'],expected['receipt_sha256'],expected['provenance_sha256']]:
    raise RuntimeError('Capability input differs from pinned publication; native command not executed')
result=subprocess.run([str(paths[0]),'runtime','service-container-recovery-capabilities'],capture_output=True,timeout=30)
if result.returncode or len(result.stdout)>65536: raise RuntimeError('Native recovery capability command failed')
if snapshot()!=before: raise RuntimeError('Capability publication changed')
print(json.dumps({'binary_sha256':before[0][0],'receipt_sha256':before[1][0],'provenance_sha256':before[2][0],
                  'raw_utf8':result.stdout.decode('utf-8'),'capabilities':json.loads(result.stdout),
                  'receipt':json.loads(before[1][1]),'provenance':json.loads(before[2][1])}))
'''


def _recovery_build_source(receipt, provenance, request, publication_pins=None):
    """Validate source and publication before executing its native capability CLI."""
    source = receipt.get("source", {})
    native = receipt.get("native_source_identity", {})
    if (receipt.get("state") != "succeeded" or provenance.get("state") != "succeeded"
            or source.get("resolved_commit") != request["source_commit"]
            or source.get("source_digest") != request["source_digest"]
            or source.get("source_snapshot_sha256") != request["source_snapshot_sha256"]
            or native.get("head_commit_full") != request["source_commit"]
            or native.get("source_snapshot_sha256") != request["source_snapshot_sha256"]
            or provenance.get("commit") != request["source_commit"]
            or provenance.get("source_digest") != request["source_digest"]
            or provenance.get("source_snapshot_sha256") != request["source_snapshot_sha256"]):
        raise BuildControlError("Recovery publication is stale or differs from the requested source")
    binaries = [item.get("sha256") for item in receipt.get("artifacts", []) if item.get("path") == "bin/fullmag-bin"]
    receipt_sha = provenance.get("build_receipt_sha256")
    if (len(binaries) != 1 or not isinstance(binaries[0], str) or not _SHA256.fullmatch(binaries[0])
            or not isinstance(receipt_sha, str) or not _SHA256.fullmatch(receipt_sha)
            or provenance.get("binary_hashes", {}).get("fullmag-bin") != binaries[0]):
        raise BuildControlError("Recovery publication has no coherent native executable/receipt pins")
    expected = {"binary_sha256": binaries[0], "receipt_sha256": receipt_sha}
    if publication_pins is not None:
        if (set(publication_pins) != {"receipt_sha256", "provenance_sha256"}
                or publication_pins["receipt_sha256"] != receipt_sha
                or not isinstance(publication_pins["provenance_sha256"], str)
                or not _SHA256.fullmatch(publication_pins["provenance_sha256"])):
            raise BuildControlError("Recovery publication raw evidence differs from its provenance")
        expected["provenance_sha256"] = publication_pins["provenance_sha256"]
    return expected


def _recovery_build_publication(receipt, provenance, capability, request, *, expected=None):
    pins = _recovery_build_source(receipt, provenance, request)
    if expected is not None:
        pins = expected
    if (capability.get("receipt") != receipt or capability.get("provenance") != provenance
            or any(capability.get(key) != value for key, value in pins.items())):
        raise BuildControlError("Native recovery executable/publication changed from the pinned package")
    value = capability.get("capabilities")
    if (not isinstance(value, dict) or set(value) != {"schema_version", "supported_recovery_schemas", "build_identity"}
            or value.get("schema_version") != "runtime_service_container_recovery_capabilities.v1"
            or json.loads(capability["raw_utf8"]) != value):
        raise BuildControlError("Invalid native recovery capabilities")
    schemas = value["supported_recovery_schemas"]
    required_schema = ("runtime_service_container_recovery_request.v5"
        if request["schema"] == _RECOVERY_HISTORY_BUILD_SCHEMA else "runtime_service_container_recovery_request.v4")
    build = value["build_identity"]
    if (not isinstance(schemas, list) or not 1 <= len(schemas) <= 16
            or any(not isinstance(item, str) or not re.fullmatch(r"runtime_service_container_recovery_request\.v[1-9][0-9]*", item) for item in schemas)
            or len(schemas) != len(set(schemas)) or required_schema not in schemas
            or not isinstance(build, dict) or set(build) != {"version", "built_at_utc", "git_commit", "worktree_state", "source_snapshot_sha256"}
            or build.get("git_commit") != request["source_commit"]
            or build.get("source_snapshot_sha256") != request["source_snapshot_sha256"]
            or build.get("worktree_state") not in {"clean", "dirty", "unknown"}
            or not isinstance(build.get("version"), str) or not 0 < len(build["version"]) <= 128
            or not isinstance(build.get("built_at_utc"), str)
            or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", build["built_at_utc"])):
        raise BuildControlError("Actual native package lacks matching " + required_schema.rsplit(".", 1)[-1] + " recovery capability")


def _recovery_build_timeout(actual, started_at, logs):
    from datetime import datetime
    state = actual.get("State", {})
    try:
        def timestamp(value):
            # Docker timestamps have nanoseconds; the launcher also supports Python 3.8.
            return datetime.fromisoformat(re.sub(r"(\.\d{6})\d+", r"\1", value).replace("Z", "+00:00"))
        elapsed = (timestamp(state["FinishedAt"]) - timestamp(started_at)).total_seconds()
    except (KeyError, TypeError, ValueError):
        elapsed = -1
    if (elapsed < 240 or state.get("Status") != "exited" or state.get("Running") is not False or state.get("Pid") != 0
            or state.get("StartedAt") != started_at or state.get("ExitCode") != 2
            or state.get("OOMKilled") is not False or state.get("Error") not in (None, "")
            or not state.get("FinishedAt")
            or "phase=gate state=start profile=linux-native-v1" not in logs
            or "backend-dev: Linux native host admission did not become ready" not in logs
            or "phase=api state=exec" in logs or "phase=gate state=complete profile=linux-native-v1" in logs):
        raise BuildControlError("Recovery build has no confirmed storage-gate timeout; outcome retained")


def _retained_recovery_build(args, control, previous, document, selected, layout):
    import docker_volume_container_recovery as recovery
    import docker_backend_volume_cache as cache_adapter
    path, digest = getattr(args, "build_for_recovery", None), getattr(args, "build_for_recovery_sha256", None)
    if (os.name == "nt" or not path or not isinstance(digest, str) or not _SHA256.fullmatch(digest)
            or not getattr(args, "restart_backend", False)
            or any(getattr(args, name, None) for name in ("prestart_reconciliation", "prestart_reconciliation_sha256",
                "script", "helper_source_root", "helper_source_commit"))):
        raise BuildControlError("Recovery build requires paired pins and plain same-container restart on Linux")
    raw = _read_cancelled_activation_bytes(control, path)
    if hashlib.sha256(raw).hexdigest() != digest:
        raise BuildControlError("Recovery build request CAS differs")
    request = _recovery_build_request(raw)
    if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != request["controller_sha256"]:
        raise BuildControlError("Recovery build controller SHA differs from the reviewed request")
    pins = request["authorization_pins"]
    if (pins["development_attempt"] != args.attempt or pins["compose_config_sha256"] != args.config_sha256
            or pins["source_root"] != str(selected) or pins["compose_project"] != control.project
            or pins["old_image_id"] != previous["inputs"]["image_id"]
            or previous["inputs"]["source_root"] != str(selected)):
        raise BuildControlError("Recovery build retained source/attempt/group differs")
    state = storage.validate_path(Path(previous["state_root"]), layout["runtime_root"], "retained Linux sessions")
    def observe(operation_helper=None):
        history_options = ({"retained_attempt_histories": request["retained_attempt_histories"]}
            if request["schema"] == _RECOVERY_HISTORY_BUILD_SCHEMA else {})
        proof = recovery.prepare_abrupt_stop_proof(control, pins, document,
            retained_terminal_runs=request["retained_terminal_runs"], retained_held_manual_runs=request["retained_held_manual_runs"],
            **history_options)
        owner = json.loads(proof["raw_records"]["owner"]["raw_utf8"])
        if owner.get("state") != "ready" or hashlib.sha256(canonical(proof["storage_proof"])).hexdigest() != request["storage_proof_sha256"]:
            raise BuildControlError("Recovery build requires the unchanged Ready owner and retained inventory")
        backend = proof["containers"]["backend"]
        config = backend.get("Config", {})
        if (config.get("Entrypoint") != ["/usr/local/bin/python3", "/opt/fullmag/backend_dev.py"]
                or config.get("Cmd") != ["start", "--source-root", "/opt/fullmag/source", "--git-common-root", "/opt/fullmag/source-git",
                    "--output", "/opt/fullmag/package", "--build-root", "/build"]):
            raise BuildControlError("Recovery build requires the fixed backend build-before-serve command")
        environment = dict(item.split("=", 1) for item in config.get("Env", []) if "=" in item)
        if environment.get("FULLMAG_SESSION_STORAGE_PROFILE") != "linux-native-v1" or environment.get("FULLMAG_DOCKER_ROLE") != "backend":
            raise BuildControlError("Recovery build backend storage gate environment differs")
        profile = control.read("development/attempts/" + args.attempt + "/backend-cache.json")
        cache_adapter.validate_container(backend, profile)
        volume_rows = json.loads(docker_text("volume", "inspect", *sorted(set(profile["volume_names"].values()))))
        volumes = {row["Name"]: row for row in volume_rows}
        if set(volumes) != set(profile["volume_names"].values()):
            raise BuildControlError("Recovery build cache volume inventory differs")
        profile = {**profile, "volume_documents": {role: volumes[name] for role, name in profile["volume_names"].items()}}
        live_ids = docker_text("ps", "--quiet", "--no-trunc").split()
        live = json.loads(docker_text("inspect", *live_ids)) if live_ids else []
        if not isinstance(live, list) or {row.get("Id") for row in live} != set(live_ids):
            raise BuildControlError("Recovery cache consumer inventory changed")
        cache_adapter._assert_no_active_consumers(profile, [row for row in live if row.get("Id") != operation_helper])
        certificate = _recovery_build_certificate(state, document, request)
        _recovery_build_helpers(backend["Id"], request, selected)
        if storage.git(selected, "rev-parse", "HEAD") != request["source_commit"]:
            raise BuildControlError("Recovery build source HEAD changed")
        return proof, certificate
    before, certificate = observe()
    with control.operation("recovery-build", {"attempt": args.attempt, "config_sha256": args.config_sha256,
            "request": path, "request_sha256": digest, "source_root": str(selected),
            "controller_sha256": request["controller_sha256"], "source_commit": request["source_commit"], "image_id": pins["old_image_id"]}) as operation:
        if _read_cancelled_activation_bytes(control, path) != raw or observe(operation["helper_container_id"]) != (before, certificate):
            raise BuildControlError("Recovery build evidence changed under the operation lease")
        control.write(operation["root"] + "/before.json", before)
        control.write(operation["root"] + "/request.json", request)
        operation["daemon_pending"] = True
        compose_capture(document, "start", "backend", timeout=90)
        backend_id = pins["backend_container_id"]
        publication_pins = {}
        receipt, provenance = _wait_for_publication(control, operation, backend_id, publication_pins=publication_pins)
        expected = _recovery_build_source(receipt, provenance, request, publication_pins)
        started_at = operation["receipt"].get("backend_started_at")
        if not started_at or started_at == before["containers"]["backend"]["State"].get("StartedAt"):
            raise BuildControlError("Recovery publication has no fresh backend start")
        capability = json.loads(docker_text("exec", backend_id, "/usr/local/bin/python3", "-B", "-c", _RECOVERY_BUILD_CAPABILITY,
            json.dumps(expected), timeout=90))
        _recovery_build_publication(receipt, provenance, capability, request, expected=expected)
        control.write(operation["root"] + "/backend-build-receipt.json", receipt)
        control.write(operation["root"] + "/provenance.json", provenance)
        control.write(operation["root"] + "/native-capabilities.json", capability)
        started_at = operation["receipt"]["backend_started_at"]
        deadline = time.monotonic() + 300
        while True:
            if _recovery_build_certificate(state, document, request) != certificate:
                raise BuildControlError("Prepared storage changed during recovery build")
            actual = json.loads(docker_text("inspect", backend_id))[0]
            if actual.get("Id") != backend_id or actual.get("State", {}).get("StartedAt") != started_at:
                raise BuildControlError("Recovery backend incarnation changed")
            if not actual["State"]["Running"]:
                break
            if time.monotonic() >= deadline:
                raise BuildControlError("Recovery build storage-gate outcome is unknown")
            time.sleep(3)
        logs = docker_text("logs", "--since", started_at, "--tail", "200", backend_id, combined=True)
        control.write(operation["root"] + "/storage-gate-timeout-log.json", {"started_at": started_at, "log": logs})
        _recovery_build_timeout(actual, started_at, logs)
        after, after_certificate = observe(operation["helper_container_id"])
        if (after_certificate != certificate or after["raw_records"] != before["raw_records"]
                or after["storage_proof"] != before["storage_proof"]
                or after["containers"]["frontend"] != before["containers"]["frontend"]):
            raise BuildControlError("Native records, retained data or stopped frontend changed during recovery build")
        control.write(operation["root"] + "/after.json", after)
        operation["daemon_pending"] = False
        operation["receipt"].update(state="succeeded", image_id=pins["old_image_id"],
            backend_container=backend_id, frontend_container=pins["frontend_container_id"],
            package_built=True, runtime_started=False, storage_admitted=False, runtime_qualification="NOT VERIFIED")


def _retained_operation(
    args, *, recreate_services, restart_idle_service=False, stop_after_drain=False,
    resume_recreation_id=None, refresh_frontend_service=False,
):
    """Resume one exact retained start; a frontend-only recovery never restarts the backend."""
    from docker_dev import _select_source, _compose_identity
    require_host()
    import docker_helper_source as helper_source
    helper_pair = helper_source.validate_option_pair(
        getattr(args, "helper_source_root", None),
        getattr(args, "helper_source_commit", None),
    )
    if helper_pair is not None and getattr(args, "recovery_authorization", None) is not None:
        raise BuildControlError("Helper-source pins are unsupported with container recovery authorization")
    if helper_pair is not None and not (recreate_services or resume_recreation_id is not None):
        raise BuildControlError("Helper-source pins are supported only by recreate-volume and its resume")
    selected_before_runtime = None
    helper_source_binding = None
    if helper_pair is not None:
        from docker_development_inputs import select_checkout
        try:
            selected_before_runtime = select_checkout(
                Path(args.repo_root).resolve(strict=True), args.source_root
            ).resolve(strict=True)
        except Exception as error:
            raise BuildControlError("Cannot resolve the app checkout before helper pin validation: " + str(error)) from error
        helper_source_binding = _capture_helper_source_binding(args, selected_before_runtime)
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    if selected_before_runtime is not None and selected_before_runtime != selected:
        raise BuildControlError("Selected app checkout changed during helper-source validation")
    identity = _compose_identity(layout)
    from docker_build_control import toolchain_configuration
    configured = toolchain_configuration(selected, identity)
    control = BuildControl(identity, configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    control.prepare()
    if not re.fullmatch(r"[0-9a-f]{32}", args.attempt):
        raise BuildControlError("Resume requires an exact attempt UUID")
    previous_root = "development/attempts/" + args.attempt
    previous = control.read(previous_root + "/terminal.json")
    # A successfully admitted group can subsequently lose its frontend (for
    # example a Next.js heap failure). Resume still validates both exact
    # container incarnations below and requires backend running/frontend
    # stopped; the historical startup receipt must remain immutable.
    allowed = {"failed-confirmed", "succeeded"}
    if previous.get("state") not in allowed or previous.get("compose_project") != control.project:
        raise BuildControlError("Retained start has no admissible terminal outcome")
    document = control.read(previous_root + "/compose.json")
    if hashlib.sha256(canonical(document)).hexdigest() != args.config_sha256 or document.get("name") != control.project:
        raise BuildControlError("Resume Compose identity/CAS differs")
    from docker_volume_cancelled_activation_guard import require_fresh_recreation
    require_fresh_recreation(control, args, previous, recreate_services=recreate_services)
    from docker_volume_preparation_abort import require_fresh_archive
    preparation_abort = require_fresh_archive(control, args, previous, document, recreate_services=recreate_services)
    if getattr(args, "build_for_recovery", None) or getattr(args, "build_for_recovery_sha256", None):
        if recreate_services or restart_idle_service or stop_after_drain or refresh_frontend_service or resume_recreation_id is not None:
            raise BuildControlError("Recovery build is supported only by plain retained resume")
        return _retained_recovery_build(args, control, previous, document, selected, layout)
    operator_probe_record = _operator_probe_record_from_retained(previous, document)
    image = previous["inputs"]["image_id"]
    if previous["inputs"]["source_root"] != str(selected):
        raise BuildControlError("Resume source selection differs")
    retained_terminal_observation = any(
        name.startswith("FULLMAG_TERMINAL_OBSERVATION_")
        for name in document["services"]["backend"]["environment"]
    )
    terminal_observation_exit = (
        (restart_idle_service and not recreate_services)
        or (recreate_services and bool(getattr(args, "fresh_state", False)))
    )
    terminal_observation_failed_resume = (
        previous.get("state") == "failed-confirmed"
        and bool(getattr(args, "restart_backend", False))
        and not recreate_services and not restart_idle_service and not stop_after_drain
        and not refresh_frontend_service and resume_recreation_id is None
    )
    if (retained_terminal_observation
            and not getattr(args, "terminal_observation_proof", None)
            and not terminal_observation_exit
            and not terminal_observation_failed_resume):
        raise BuildControlError(
            "Retained terminal observation requires proof pins, managed stop-only, explicit fresh state, or same-container failed-start resume"
        )
    if resume_recreation_id is not None:
        if (recreate_services or restart_idle_service or stop_after_drain or refresh_frontend_service
                or getattr(args, "completed_recreation_attempt", None)
                or getattr(args, "completed_recreation_sha256", None)):
            raise BuildControlError("Recreation resume cannot combine with another retained lifecycle operation")
        policy = previous["inputs"].get("gpu_access_requested")
        if policy not in {"auto", "required", "disabled"}:
            raise BuildControlError("Recreation resume requires the retained GPU access intent")
        args.gpu_access = policy
        args.include_untracked = include_untracked_from_compose(document)
        return _resume_recreated_operation(
            args, control, selected, layout, identity,
            helper_source_binding=helper_source_binding,
        )
    if recreate_services:
        requested_allowlist = getattr(args, "include_untracked", None)
        args.include_untracked = (
            include_untracked_from_compose(document)
            if requested_allowlist is None
            else normalize_include_untracked_paths(requested_allowlist)
        )
        policy = previous["inputs"].get("gpu_access_requested")
        if policy not in {"auto", "required", "disabled"}:
            raise BuildControlError("Recreation requires the retained GPU access intent")
        args.gpu_access = policy
        retained_device_access = _retained_device_access(previous, document)
    successor_path = getattr(args, "drained_successor_proof", None)
    successor_sha = getattr(args, "drained_successor_proof_sha256", None)
    if bool(successor_path) != bool(successor_sha):
        raise BuildControlError("Drained successor requires paired exact proof pins")
    drained_successor_pins = (successor_path, successor_sha) if successor_path else None
    observation_path = getattr(args, "terminal_observation_proof", None)
    observation_sha = getattr(args, "terminal_observation_proof_sha256", None)
    if bool(observation_path) != bool(observation_sha):
        raise BuildControlError("Terminal observation requires paired proof pins")
    if observation_path and (not recreate_services or getattr(args, "fresh_state", False)
            or args.script is not None or successor_path or resume_recreation_id is not None
            or getattr(args, "completed_recreation_attempt", None)
            or getattr(args, "recovery_authorization", None)):
        raise BuildControlError("Terminal observation requires plain retained recreation")
    if drained_successor_pins and (not recreate_services or getattr(args, "fresh_state", False)
            or getattr(args, "recovery_authorization", None) or getattr(args, "script", None)):
        raise BuildControlError("Drained successor only permits retained empty-workspace recreation")
    completed_attempt = getattr(args, "completed_recreation_attempt", None)
    completed_sha = getattr(args, "completed_recreation_sha256", None)
    if completed_attempt or completed_sha:
        if not recreate_services:
            raise BuildControlError("Completed recreation continuation requires recreate-volume")
        return start(args, **_completed_recreation_start_context(control, args, selected, layout))
    ids = {service: compose_capture(document, "ps", "--all", "--quiet", service).decode().strip()
           for service in ("backend", "frontend")}
    actual = {}
    oom_resume = (previous.get('state') == 'succeeded' and not recreate_services
                  and not restart_idle_service and not refresh_frontend_service
                  and not getattr(args, 'restart_backend', False))
    legacy_oom_recreation = oom_resume and not any(
        value.split(':', 1)[0] == _FRONTEND_OWNER_TMPFS
        for value in document['services']['frontend'].get('tmpfs', []))
    for service, identifier in ids.items():
        service_image = document['services'][service].get('image')
        if (not isinstance(service_image, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', service_image)
                or (service == 'backend' and service_image != image)):
            raise BuildControlError('Retained service image is not the pinned per-service identity')
        image_records = json.loads(docker_text('image', 'inspect', service_image))
        if len(image_records) != 1 or image_records[0].get('Id') != service_image:
            raise BuildControlError('Retained service image inspect differs: ' + service)
        image_config = image_records[0]['Config']
        records = json.loads(docker_text("inspect", identifier))
        if len(records) != 1:
            raise BuildControlError("Ambiguous retained service")
        observed = actual[service] = records[0]
        labels = observed.get("Config", {}).get("Labels", {})
        if (observed.get("Image") != service_image or labels.get("com.docker.compose.project") != control.project
                or labels.get("com.docker.compose.service") != service
                or labels.get("org.fullmag.source.worktree-id") != identity["worktree_id"]):
            raise BuildControlError("Retained container ownership differs")
        recorded_id = previous.get(service + "_container")
        if recorded_id is not None and observed.get("Id") != recorded_id:
            raise BuildControlError("Recorded container incarnation differs")
        _validate_retained_service(
            document,
            observed,
            service,
            image_config,
            allow_legacy_frontend=recreate_services or (service == 'frontend' and legacy_oom_recreation),
        )
    if legacy_oom_recreation:
        return _refresh_frontend_services(control, args, previous_root, previous, document, selected,
            layout, actual, ids, image, operator_probe_record, recover_oom=True)
    if refresh_frontend_service:
        from docker_volume_frontend_frozen_recovery import refresh_context
        frozen_context = refresh_context(control, args, previous, document, actual)
        return _refresh_frontend_services(control, args, previous_root, previous, document, selected,
            layout, actual, ids, image, operator_probe_record, frozen_context=frozen_context)
    if (previous.get('state') == 'succeeded' and not recreate_services
            and not restart_idle_service and not getattr(args, 'restart_backend', False)):
        return _resume_oom_frontend(control, args, document, actual, ids, selected)
    checkpoint_path = getattr(args, "saved_authoring_checkpoint", None)
    checkpoint_sha = getattr(args, "saved_authoring_checkpoint_sha256", None)
    if bool(checkpoint_path) != bool(checkpoint_sha) or (checkpoint_path and not restart_idle_service):
        raise BuildControlError("Saved authoring restart requires both checkpoint path and digest on restart-idle-volume")
    saved_authoring = None
    if checkpoint_path:
        checkpoint_raw = _read_cancelled_activation_bytes(control, checkpoint_path)
        if not _SHA256.fullmatch(checkpoint_sha) or hashlib.sha256(checkpoint_raw).hexdigest() != checkpoint_sha:
            raise BuildControlError("Saved authoring checkpoint CAS differs")
        saved_authoring = _saved_authoring_document(checkpoint_raw)
        _saved_authoring_validate_request(saved_authoring, project=control.project, attempt=args.attempt,
            config_sha256=args.config_sha256, selected=selected)
        _saved_authoring_validate_services(saved_authoring, actual)
    if restart_idle_service:
        diagnostic_terminal = None
        if not actual["backend"]["State"]["Running"]:
            raise BuildControlError("Idle restart requires a healthy backend; an active build is never interrupted")
        if actual["backend"]["State"].get("Health", {}).get("Status") != "healthy":
            if not stop_after_drain or saved_authoring is not None:
                raise BuildControlError("An unhealthy backend requires explicit diagnostic stop-only")
            from docker_volume_terminal_observation import diagnostic_terminal_stop_probe
            diagnostic_terminal = diagnostic_terminal_stop_probe(control, previous, actual["backend"])
        state = storage.validate_path(Path(previous["state_root"]), layout["runtime_root"], "retained Windows sessions")
        certificate_path = _certificate_path(state)
        certificate = _retained_certificate(state, document)
        environment = document["services"]["backend"]["environment"]
        startup_enabled = _retained_startup_enabled(actual["backend"])
        if startup_enabled:
            raise BuildControlError("Startup activation requires dedicated recovery; idle restart will not repeat Solve")
        if _read_cancelled_activation_bytes(control, "active", optional=True) is not None:
            raise BuildControlError("Original accepted activation helper still holds the control lease")
        cache = control.read(previous_root + "/backend-cache.json")
        import docker_backend_volume_cache as cache_adapter
        cache_adapter.validate_container(actual["backend"], cache)
        ledger_profile = _retained_ledger_profile(control, previous_root, document, image)
        # Fail before the lease and any stop if the drained receipt could not
        # be read once the backend exits.
        from docker_volume_stop_unadmitted import _preflight_terminal_process_receipt
        _preflight_terminal_process_receipt(actual["backend"], control)
        if saved_authoring:
            _saved_authoring_read_archive(saved_authoring, state)
        with control.operation("iteration", {"source_root": str(selected), "image_id": image,
                                            "attempt": args.attempt, "config_sha256": args.config_sha256,
                                            **({"saved_authoring_checkpoint_sha256": checkpoint_sha} if saved_authoring else {}),
                                            **operator_probe_record}) as operation:
            operation["receipt"].update(operator_probe_record)
            _assert_private_restart_network(actual, ids, control.project)
            operation["daemon_pending"] = True
            docker_capture("stop", "--time", "60", ids["frontend"], timeout=90)
            operation["daemon_pending"] = False
            try:
                fresh = {service: json.loads(docker_text("inspect", identifier))[0]
                         for service, identifier in ids.items()}
                for service in ids:
                    if (fresh[service].get("Id") != actual[service].get("Id")
                            or fresh[service].get("State", {}).get("StartedAt")
                            != actual[service].get("State", {}).get("StartedAt")):
                        raise BuildControlError("Service incarnation changed during idle restart preflight")
                if (fresh["frontend"]["State"].get("Running") is not False
                        or fresh["backend"]["State"].get("Running") is not True):
                    raise BuildControlError("Frontend is not quiesced or backend is no longer running")
                _assert_private_restart_network(fresh, ids, control.project)
                probe = "EXPECTED_HEALTH = " + repr("degraded" if diagnostic_terminal else "ok") + "\n" + """import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:8081/v2/platform/health',timeout=5) as response:
 document=json.load(response)
 if (response.status!=200 or document.get('status')!=EXPECTED_HEALTH
         or (document.get('active_session') is not False
             and document.get('active_session') is not True)):
  raise RuntimeError('Backend health is unknown; restart refused')
 print(json.dumps(document))
"""
                health = json.loads(docker_text("exec", ids["backend"], "/usr/local/bin/python3", "-B", "-c", probe))
                if health.get("status") != ("degraded" if diagnostic_terminal else "ok"):
                    raise BuildControlError("Backend health is not ready; idle restart refused")
                active_session = health.get("active_session")
                authoring_probe = None
                if saved_authoring:
                    if active_session is not True:
                        raise BuildControlError("Pinned saved authoring session disappeared; restart refused")
                    _saved_authoring_validate_services(saved_authoring, fresh, quiesced=True)
                    archive_raw, saved_scene = _saved_authoring_read_archive(saved_authoring, state)
                    authoring_probe = _saved_authoring_probe(ids["backend"], saved_authoring, archive_raw, saved_scene, certificate)
                    control.write(operation["root"] + "/saved-authoring-checkpoint.json", saved_authoring)
                    control.write(operation["root"] + "/saved-authoring-preflight.json", authoring_probe)
                    operation["receipt"]["saved_authoring_restore_required"] = saved_authoring["archive"]
                elif diagnostic_terminal is not None:
                    from docker_volume_terminal_observation import diagnostic_terminal_stop_probe
                    diagnostic_fresh = diagnostic_terminal_stop_probe(control, previous, fresh["backend"])
                    # Uptime/version are not part of the stable stop pin.
                    if diagnostic_fresh != diagnostic_terminal or any(
                        health.get(key) != value for key, value in diagnostic_terminal["health"].items()
                    ):
                        raise BuildControlError("Diagnostic terminal stop proof changed under lease")
                    control.write(operation["root"] + "/diagnostic-terminal-preflight.json", diagnostic_terminal)
                    operation["receipt"]["diagnostic_terminal_stop_sha256"] = hashlib.sha256(canonical(diagnostic_terminal)).hexdigest()
                    diagnostic_process = control.read_bytes("runtime-control/runtime-service/process-tree.json")
                    if hashlib.sha256(diagnostic_process).hexdigest() != diagnostic_terminal["process_sha256"]:
                        raise BuildControlError("Diagnostic process changed before stop archival")
                    control.write_bytes(operation["root"] + "/diagnostic-terminal-process-before.json", diagnostic_process)
                elif active_session is True:
                    if startup_enabled:
                        raise BuildControlError("Backend has an active session; idle restart refused")
                    terminal_session = _terminal_session_restart_probe(
                        ids["backend"], allow_prepared=getattr(args, "allow_prepared_session", False),
                    )
                    if terminal_session is not None:
                        control.write(operation["root"] + "/terminal-session-preflight.json", terminal_session)
                        operation["receipt"]["terminal_session_preflight_sha256"] = hashlib.sha256(
                            canonical(terminal_session)
                        ).hexdigest()
                    else:
                        cancelled_activation = _validate_cancelled_activation_preflight(
                            control, previous_root, previous, document, selected, args.config_sha256,
                            ids["backend"], environment, require_quiesced_activation=False,
                        )
                        health = cancelled_activation["probe"]["health"]
                        operation["receipt"]["accepted_then_cancelled_proof_sha256"] = (
                            cancelled_activation["proof_sha256"]
                        )
                elif active_session is not False:
                    raise BuildControlError("Backend has an active or unknown session; idle restart refused")
                if saved_authoring:
                    # The operator window is explicit; repeat archive, API, ledger and
                    # service pins immediately before crossing the backend stop boundary.
                    archive_raw, saved_scene = _saved_authoring_read_archive(saved_authoring, state)
                    authoring_probe = _saved_authoring_probe(ids["backend"], saved_authoring, archive_raw, saved_scene, certificate)
                    fresh = {service: json.loads(docker_text("inspect", identifier))[0]
                             for service, identifier in ids.items()}
                    _saved_authoring_validate_services(saved_authoring, fresh, quiesced=True)
                    _assert_private_restart_network(fresh, ids, control.project)
                    _saved_authoring_read_archive(saved_authoring, state)
                    control.write(operation["root"] + "/saved-authoring-final-preflight.json", authoring_probe)
            except Exception as error:
                _idle_preflight_failed(error, saved_authoring, operation, ids["frontend"])
                raise
            control.write(operation["root"] + "/idle-preflight.json", health)
            control.write(operation["root"] + "/compose.json", document)
            operation["receipt"].update(state="restarting-idle-backend", state_root=str(state),
                backend_volumes=previous["backend_volumes"], frontend_volume=previous["frontend_volume"])
            operation["daemon_pending"] = True
            docker_capture("stop", "--time", "60", ids["backend"], timeout=90)
            stopped = json.loads(docker_text("inspect", ids["backend"]))[0]
            if (stopped.get("Id") != actual["backend"].get("Id")
                    or stopped.get("State", {}).get("StartedAt")
                    != actual["backend"].get("State", {}).get("StartedAt")
                    or stopped["State"].get("Running") is not False
                    or stopped["State"].get("OOMKilled") is not False
                    or stopped["State"].get("ExitCode") != (1 if diagnostic_terminal else 0)):
                raise BuildControlError("Backend termination is not confirmed graceful; restart withheld")
            from docker_volume_stop_unadmitted import _read_terminal_process_receipt
            drained_raw, drained = _read_terminal_process_receipt(stopped, control)
            if saved_authoring:
                _saved_authoring_validate_drain(authoring_probe, drained)
                _saved_authoring_verify_retained_history(saved_authoring, state)
                _saved_authoring_read_archive(saved_authoring, state)
            control.write(operation["root"] + "/backend-drain.json", {
                "schema": "fullmag.docker-idle-restart-drain.v1",
                "backend_container_id": ids["backend"],
                "process_receipt_sha256": hashlib.sha256(drained_raw).hexdigest(),
                "process_receipt": drained,
            })
            if stop_after_drain:
                stopped_services = {service: json.loads(docker_text("inspect", identifier))[0]
                                    for service, identifier in ids.items()}
                for service, observed in stopped_services.items():
                    if (observed.get("Id") != actual[service].get("Id")
                            or observed.get("Image") != actual[service].get("Image")
                            or observed.get("State", {}).get("StartedAt") != actual[service].get("State", {}).get("StartedAt")
                            or observed.get("State", {}).get("Running") is not False):
                        raise BuildControlError("Idle stop service incarnation or stopped state differs")
                control.write(operation["root"] + "/idle-stop-containers.json", stopped_services)
                operation["receipt"]["idle_stop_containers_sha256"] = hashlib.sha256(
                    canonical(stopped_services) + b"\n").hexdigest()
                operation["daemon_pending"] = False
                operation["receipt"].update(
                    state="succeeded", idle_backend_stopped=True,
                    backend_container=ids["backend"], frontend_container=ids["frontend"],
                    config_sha256=args.config_sha256,
                )
                if diagnostic_terminal is not None:
                    operation["receipt"]["backend_exit_code"] = stopped["State"]["ExitCode"]
                    operation["receipt"]["native_drain_authenticated"] = True
                return
            docker_capture("start", ids["backend"], timeout=90)
            docker_capture("start", ids["frontend"], timeout=90)
            operation["daemon_pending"] = bool(saved_authoring)
            git_common = Path(next(m["source"] for m in document["services"]["backend"]["volumes"]
                                   if m["target"] == "/opt/fullmag/source-git"))
            _finish(control, operation, document, ids["backend"], ids["frontend"], selected, state,
                certificate_path, certificate, cache, {"image_id": environment["FULLMAG_TOOLCHAIN_IMAGE_ID"]},
                image, git_common, ledger_profile, args.port,
                completion_gate=(lambda: _saved_authoring_complete(control, operation,
                    ids["backend"], saved_authoring, state, checkpoint_sha)) if saved_authoring else None)
        return
    if recreate_services:
        if actual["backend"]["State"]["Running"]:
            raise BuildControlError("Recreation requires the backend stopped; an active build/runtime is never interrupted")
        pre_activation_stop = None
        if (document["services"]["backend"]["environment"].get("FULLMAG_STARTUP_ENABLED") == "1"
                and preparation_abort is None):
            stop_path = "verification/stop-failed-" + ids["backend"] + ".json"
            stop = control.read(stop_path)
            failure = stop.get("failure_receipt", {}).get("receipt", {})
            drained = control.read("runtime-control/runtime-service/process-tree.json")
            if (stop.get("state") != "stopped-confirmed"
                    or stop.get("container_id") != ids["backend"]
                    or stop.get("image_id") != image
                    or failure.get("error") != "startup activation state parent is unavailable: /state/.fullmag"
                    or drained.get("state") != "drained"
                    or drained != stop.get("drained_process_receipt")
                    or "startup_activation" in drained
                    or getattr(args, "script", None) is not None):
                raise BuildControlError("Retained startup activation requires its dedicated recovery; recreation will not repeat Solve")
            # This authenticated failure preceded the exclusive activation
            # marker and POST. Recreate an empty workspace; never replay it.
            pre_activation_stop = stop_path
        state = storage.validate_path(Path(previous["state_root"]), layout["runtime_root"], "retained Windows sessions")
        certificate_path = _certificate_path(state)
        certificate = _retained_certificate(state, document)
        owner_path = state / _session_host().OWNER_NAME
        if certificate.get("image_id") != image:
            raise BuildControlError("Retained storage image differs")
        fresh_state = bool(getattr(args, "fresh_state", False))
        # A fresh session archives its entire old runtime namespace below.
        # It must not carry permissions to recover or restore the old owner.
        recovery_context = {} if fresh_state else _retained_recovery_context(
            control, previous, document, fresh_state=False,
            backend_id=actual["backend"].get("Id"),
            drained_successor=drained_successor_pins, actual=actual,
        )
        from docker_volume_drained_successor import DrainedSuccessorContext
        drained_successor = isinstance(recovery_context, DrainedSuccessorContext)
        from docker_volume_native_init_successor import NativeInitSuccessorContext
        native_init_successor = isinstance(recovery_context, NativeInitSuccessorContext)
        from docker_volume_startup_diagnostic_restart import StartupDiagnosticStopContext
        startup_diagnostic_stopped = isinstance(recovery_context, StartupDiagnosticStopContext)
        if startup_diagnostic_stopped and (args.script is not None or pre_activation_stop is not None
                or certificate.get("restart_verified") is not True):
            raise BuildControlError("Startup diagnostic restart requires verified retained storage without activation")
        if native_init_successor:
            if args.script is not None or pre_activation_stop is not None:
                raise BuildControlError("Native init successor cannot activate a new script")
            retained_device_access = recovery_context.target_device_access
        # Reconcile only the exact activation helper that still owns the
        # control lease.  The native failed-stop proof above authenticates the
        # stopped backend; the reconciler preserves the unknown activation
        # marker and only lets that helper release its own technical lease.
        from docker_volume_activation_reconcile import reconcile_unknown_activation
        offline_attempt = getattr(args, "offline_reconciliation", None)
        if offline_attempt is not None:
            if fresh_state or getattr(args, "script", None) is not None:
                raise BuildControlError("Offline reconciliation must preserve the session and cannot replay a script")
            from docker_volume_offline_reconcile import validate_for_recreate
            if not validate_for_recreate(
                control, previous, document, actual, selected, args.config_sha256,
                expected_operation_attempt=offline_attempt,
            ):
                raise BuildControlError("The requested offline reconciliation proof is absent")
            # Terminal runs and their results are preserved in place. They
            # are not a held accepted run requiring automatic reattachment.
            reconciliation = None
        else:
            reconciliation = reconcile_unknown_activation(
                control,
                previous=previous,
                document=document,
                selected_source=str(selected),
                config_sha256=args.config_sha256,
                image_id=image,
                backend_id=actual["backend"].get("Id"),
                native_restart_metadata=recovery_context.get("native_restart_metadata"),
                fresh_state=fresh_state,
            )
        accepted_reattach_context = {}
        accepted_store_root = None
        if reconciliation is not None:
            if args.script is not None:
                raise BuildControlError(
                    "A retained accepted run cannot be recreated together with a new startup script"
                )
            from docker_volume_accepted_reattach import produce_accepted_reattach
            accepted_store_root = storage.validate_path(
                state / "runs" / "docker-all" / "session-store",
                state,
                "retained accepted session store",
            )
            produced = produce_accepted_reattach(
                control,
                store_root=accepted_store_root,
            )
            accepted_environment = _validate_accepted_reattach_environment(
                produced.get("environment")
            )
            accepted_pins = _validate_accepted_reattach_metadata(
                produced.get("pins"), accepted_environment
            )
            accepted_reattach_context = {
                "accepted_reattach_environment": accepted_environment,
                "accepted_reattach_metadata": accepted_pins,
            }
        terminal_observation = None
        if observation_path:
            if accepted_reattach_context or reconciliation is not None:
                raise BuildControlError("Terminal observation cannot combine with accepted run reattach")
            from docker_volume_terminal_observation import prepare_context
            terminal_observation = prepare_context(
                control, proof_relative=observation_path, proof_sha256=observation_sha,
                store_root=state / "runs" / "docker-all" / "session-store",
                source_root=str(selected), attempt=args.attempt, config_sha256=args.config_sha256,
                actual=actual,
            )
        native_recovery_context = dict(recovery_context)
        post_build_generation = None
        # A validated pre-API cancellation pins byte-identical native config;
        # it carries the existing first pre-ACK context, not a new generation proof.
        from docker_volume_pre_api_stop import PreApiContext
        pre_api_stopped = isinstance(recovery_context, PreApiContext)
        # The original stopped after-ready namespace already has an exact
        # native restart proof. API-before-owner continuation belongs only to
        # a later failed start, whose process receipt has a different contract.
        native_restart = recovery_context.get("native_restart_metadata")
        original_after_ready_stop = (
            isinstance(native_restart, Mapping)
            and native_restart.get("schema") == _NATIVE_STOP_RECREATE_METADATA_SCHEMA
            and native_restart.get("failure_kind") == "native-after-ready-failure"
            and native_restart.get("container_id") == ids["backend"]
            and native_restart.get("image_id") == image
            and native_restart.get("claim_pending") is False
        )
        from docker_volume_linux_supervision_stop import LinuxSupervisionContext
        linux_supervision_stop = isinstance(recovery_context, LinuxSupervisionContext)
        if (not fresh_state and pre_activation_stop is None and not pre_api_stopped
                and not original_after_ready_stop and not native_init_successor and not drained_successor
                and not startup_diagnostic_stopped and not linux_supervision_stop
                and certificate.get("restart_verified") is True):
            retained_environment = document["services"]["backend"]["environment"]
            retained_reattach_declared = (
                "accepted_reattach" in previous
                or any(name.startswith("FULLMAG_ACCEPTED_REATTACH_") for name in retained_environment)
            )
            if accepted_reattach_context:
                accepted_pins = accepted_reattach_context.get("accepted_reattach_metadata")
                original_stop_path = accepted_pins.get("stop_verification_relative") if isinstance(
                    accepted_pins, Mapping
                ) else None
                if not isinstance(original_stop_path, str):
                    raise BuildControlError("Post-build continuation accepted proof has no stop archive path")
                # The accepted producer already authenticated this path and its
                # raw digest.  A missing archive is therefore an unavailable
                # proof, never a reason to fall back to the newer namespace.
                original_stop = control.read(original_stop_path)
            else:
                original_stop_path = "verification/stop-failed-" + ids["backend"] + ".json"
                original_stop = control.read(original_stop_path, optional=True)
            if original_stop is not None:
                if retained_reattach_declared and not accepted_reattach_context:
                    raise BuildControlError("Post-build continuation has no held accepted-run proof")
                from docker_volume_post_build_generation import build_failed_owner_continuation
                try:
                    post_build_generation = build_failed_owner_continuation(
                        control,
                        operation_id=previous["attempt"],
                        previous=previous,
                        document=document,
                        actual_backend=actual["backend"],
                        source_identity={
                            "source_root": str(selected),
                            "project_id": identity["project_id"],
                            "worktree_id": identity["worktree_id"],
                            "checkout_kind": identity["checkout_kind"],
                        },
                        certificate_evidence=_post_build_certificate_evidence(state, certificate),
                        accepted_context=accepted_reattach_context,
                        runtime_config_sha256=_read_runtime_config_digest(control),
                    )
                except BuildControlError as error:
                    raise BuildControlError("Post-build continuation proof is unavailable: " + str(error)) from error
                recovery_context["previous_config_sha256"] = post_build_generation[
                    "runtime_config"
                ]["sha256"]
                recovery_context["post_build_generation"] = post_build_generation
        pre_admission_recreate_proof = None
        # This checkpoint already carries authenticated native recovery
        # authority. It must not enter the mutually exclusive no-native
        # pre-admission path merely because the old storage probe was limited.
        if (not fresh_state and not pre_api_stopped and not native_init_successor and not drained_successor
                and not startup_diagnostic_stopped
                and not certificate.get("restart_verified")):
            retained_environment = document["services"]["backend"]["environment"]
            observed_environment = actual["backend"].get("Config", {}).get("Env") or []
            retained_reattach_declared = (
                "accepted_reattach" in previous
                or any(name.startswith("FULLMAG_ACCEPTED_REATTACH_") for name in retained_environment)
                or any(
                    isinstance(value, str)
                    and value.split("=", 1)[0].startswith("FULLMAG_ACCEPTED_REATTACH_")
                    for value in observed_environment
                )
            )
            if retained_reattach_declared and not accepted_reattach_context:
                raise BuildControlError(
                    "Retained accepted run has no authenticated reattach context"
                )
            from docker_volume_pre_admission_recreate import (
                PreAdmissionRecreateError,
                validate_pre_admission_recreate,
            )
            try:
                pre_admission_recreate_proof = validate_pre_admission_recreate(
                    control,
                    previous,
                    document,
                    actual,
                    state,
                    certificate,
                    identity,
                    args.config_sha256,
                    accepted_reattach_context,
                    recovery_context,
                )
            except PreAdmissionRecreateError as error:
                raise BuildControlError(str(error)) from error
            if not pre_admission_recreate_proof:
                raise BuildControlError(
                    "Unadmitted storage cannot rotate as an admitted runtime; "
                    "use explicit --fresh-state to preserve the old root"
                )
        carry_existing = None
        pending_metadata = previous.get("post_build_generation")
        pending_inputs = previous.get("inputs")
        if not isinstance(pending_inputs, Mapping):
            pending_inputs = {}
        has_pending_metadata = (
            pending_metadata is not None
            or "post_build_generation" in pending_inputs
        )
        has_pending_binding = "post_build_start" in previous
        if (not fresh_state and certificate.get("restart_verified") is False
                and (has_pending_metadata or has_pending_binding)):
            if not (has_pending_metadata and has_pending_binding):
                raise BuildControlError(
                    "Capture-only continuation has a partial pending post-build record"
                )
            if pre_activation_stop is not None:
                raise BuildControlError(
                    "Capture-only continuation cannot combine startup activation recovery"
                )
            if certificate.get("restart_verified") is not False:
                raise BuildControlError(
                    "Pending capture continuation requires the provisional certificate"
                )
            if pre_admission_recreate_proof is None:
                raise BuildControlError(
                    "Pending capture continuation requires an exact pre-admission proof"
                )
            from docker_volume_pending_continuation import (
                validate_pending_capture_continuation,
            )
            _assert_post_build_removed_namespace_absent(pending_metadata)
            carry_existing = validate_pending_capture_continuation(
                control,
                previous=previous,
                document=document,
                expected_attempt=previous["attempt"],
                expected_project=control.project,
                expected_source_root=str(selected),
                expected_config_sha256=args.config_sha256,
                certificate_evidence=_post_build_certificate_evidence(state, certificate),
                accepted_context=accepted_reattach_context,
                runtime_config_sha256=_read_runtime_config_digest(control),
                pre_admission_recreate_proof=pre_admission_recreate_proof,
            )
            post_build_generation = carry_existing["metadata"]
        # Exact recorded helper only; unknown group resources are never deleted.
        helper_ids = []
        for helper_name in ("fullmag-ledger-" + previous["attempt"], "fullmag-ledger-verify-" + previous["attempt"]):
            helper = docker_capture("inspect", helper_name, allow_failure=True)
            if not helper.returncode:
                helper_document = json.loads(helper.stdout)[0]
                labels = helper_document.get("Config", {}).get("Labels", {})
                if (helper_document.get("Image") != image or helper_document.get("State", {}).get("Running")
                        or labels.get("com.docker.compose.project") != control.project
                        or labels.get("com.docker.compose.service") != "host-ledger-maintenance"):
                    raise BuildControlError("Recorded ledger helper identity/outcome differs")
                helper_ids.append(helper_document["Id"])
        recreate_inputs = {"attempt": args.attempt, "config_sha256": args.config_sha256,
                           **operator_probe_record}
        if helper_source_binding is not None:
            recreate_inputs["helper_source"] = helper_source_binding
        if offline_attempt is not None:
            recreate_inputs["offline_reconciliation"] = offline_attempt
        with control.operation("recreate-services", recreate_inputs) as operation:
            if offline_attempt is not None:
                if not validate_for_recreate(
                    control, previous, document, actual, selected, args.config_sha256,
                    expected_operation_attempt=offline_attempt, current_operation=operation,
                ):
                    raise BuildControlError("Offline reconciliation proof disappeared before recreation")
                operation["receipt"]["offline_reconciliation"] = offline_attempt
            if helper_source_binding is not None:
                operation["receipt"]["helper_source"] = helper_source_binding
                control.write(operation["root"] + "/helper-source-binding.json", helper_source_binding)
            successor_actual = ({service: json.loads(docker_text("inspect", identifier))[0]
                for service, identifier in ids.items()} if drained_successor else actual)
            # Match the pre-lease choice: explicit fresh state archives the
            # complete old runtime and its recovery authority without consuming
            # or carrying it. The fresh-state incarnation/archive fences below
            # still apply under this same lease.
            leased_recovery_context = {} if fresh_state else _retained_recovery_context(
                control, previous, document, fresh_state=fresh_state,
                backend_id=actual["backend"].get("Id"),
                drained_successor=drained_successor_pins, actual=successor_actual,
            )
            if drained_successor:
                if (not isinstance(leased_recovery_context, DrainedSuccessorContext)
                        or leased_recovery_context.witness != recovery_context.witness):
                    raise BuildControlError("Drained-successor proof changed under recreate lease")
                operation["receipt"]["drained_successor"] = recovery_context.witness
            if startup_diagnostic_stopped:
                if not isinstance(leased_recovery_context, StartupDiagnosticStopContext):
                    raise BuildControlError("Startup diagnostic context changed under recreate lease")
                operation["receipt"]["startup_diagnostic_restart"] = recovery_context["startup_diagnostic_restart"]
            if native_recovery_context != leased_recovery_context:
                raise BuildControlError("Retained container recovery capability changed before recreation")
            if native_init_successor:
                if (not isinstance(leased_recovery_context, NativeInitSuccessorContext)
                        or leased_recovery_context.witness != recovery_context.witness):
                    raise BuildControlError("Native init successor witness changed under recreate lease")
                operation["receipt"]["native_init_successor"] = recovery_context.witness
            operation["receipt"].update(operator_probe_record)
            if fresh_state:
                # Re-pin the stopped generation under the same lease that
                # owns removal and archival, including Docker Desktop restarts.
                for service, identifier in ids.items():
                    observed_rows = json.loads(docker_text("inspect", identifier))
                    if len(observed_rows) != 1:
                        raise BuildControlError("Fresh session service identity is ambiguous")
                    observed = observed_rows[0]
                    before = actual[service]
                    if any(observed.get(key) != before.get(key) for key in ("Id", "Image")) or (
                        observed.get("State", {}).get("StartedAt")
                        != before.get("State", {}).get("StartedAt")
                    ):
                        raise BuildControlError("Service restarted before fresh session: " + service)
                    _validate_retained_service(document, observed, service, image_config,
                                               allow_legacy_frontend=True)
                    if service == "backend" and observed.get("State", {}).get("Running"):
                        raise BuildControlError("Fresh session requires the backend stopped")
                    actual[service] = observed
            if reconciliation is not None:
                operation["receipt"]["activation_reconciliation"] = {
                    key: reconciliation[key]
                    for key in (
                        "attempt", "activation_receipt_sha256", "native_stop_journal_sha256",
                        "namespace_attestation_path", "namespace_attestation_sha256",
                    )
                    if key in reconciliation
                }
            if accepted_reattach_context:
                operation["receipt"]["accepted_reattach"] = accepted_reattach_context[
                    "accepted_reattach_metadata"
                ]
            if post_build_generation is not None:
                operation["receipt"]["post_build_generation"] = post_build_generation
            if (post_build_generation is not None or native_init_successor or drained_successor
                    or startup_diagnostic_stopped or terminal_observation is not None):
                # The retained snapshot was observed before this lease. Pin
                # both application services again under the recreate lease;
                # the post-build proof must never authorize stop/rm from a
                # stale backend-only observation.
                leased_actual = {}
                for service, identifier in ids.items():
                    observed = json.loads(docker_text("inspect", identifier))
                    if len(observed) != 1:
                        raise BuildControlError(
                            "Post-build continuation has an ambiguous leased service: "
                            + service
                        )
                    observed = observed[0]
                    before = actual[service]
                    if (
                        observed.get("Id") != before.get("Id")
                        or observed.get("Image") != before.get("Image")
                        or observed.get("State", {}).get("StartedAt")
                        != before.get("State", {}).get("StartedAt")
                    ):
                        raise BuildControlError(
                            "Post-build continuation service incarnation changed under lease: "
                            + service
                        )
                    retained_image_config = image_config
                    if native_init_successor:
                        service_images = json.loads(docker_text("image", "inspect", observed["Image"]))
                        if len(service_images) != 1 or service_images[0].get("Id") != observed["Image"]:
                            raise BuildControlError("Native init successor service image changed")
                        retained_image_config = service_images[0]["Config"]
                    _validate_retained_service(
                        document,
                        observed,
                        service,
                        retained_image_config,
                        allow_legacy_frontend=True,
                    )
                    if (native_init_successor or startup_diagnostic_stopped) and any(
                        observed.get("State", {}).get(key) != before.get("State", {}).get(key)
                        for key in ("Running", "Status", "Pid", "StartedAt", "FinishedAt",
                                    "ExitCode", "OOMKilled")
                    ):
                        raise BuildControlError("Native init successor service changed under lease")
                    leased_actual[service] = observed
                _retained_certificate(state, document)
                if terminal_observation is not None:
                    from docker_volume_terminal_observation import revalidate_context
                    preowner_successor = revalidate_context(
                        control, terminal_observation, source_root=str(selected),
                        attempt=args.attempt, config_sha256=args.config_sha256, actual=leased_actual,
                    )
                    if preowner_successor is not None:
                        context_key = ("terminal_diagnostic_successor"
                            if preowner_successor.get("schema") == "fullmag.terminal-diagnostic-drain-context.v1"
                            else "preowner_drained_successor")
                        operation["receipt"][context_key] = dict(preowner_successor)
                    operation["receipt"]["terminal_observation"] = terminal_observation["metadata"]
                actual = leased_actual
            if pre_admission_recreate_proof is not None:
                # Re-pin both app containers after the durable recreate lease is
                # held.  This closes the gap between the retained observation
                # above and the stop/rm boundary below.
                leased_actual = {}
                for service, identifier in ids.items():
                    observed = json.loads(docker_text("inspect", identifier))
                    if len(observed) != 1:
                        raise BuildControlError(
                            "Pre-admission recreation has an ambiguous leased service: "
                            + service
                        )
                    observed = observed[0]
                    before = actual[service]
                    if (
                        observed.get("Id") != before.get("Id")
                        or observed.get("Image") != before.get("Image")
                        or observed.get("State", {}).get("StartedAt")
                        != before.get("State", {}).get("StartedAt")
                    ):
                        raise BuildControlError(
                            "Pre-admission recreation service incarnation changed under lease: "
                            + service
                        )
                    _validate_retained_service(
                        document,
                        observed,
                        service,
                        image_config,
                        allow_legacy_frontend=True,
                    )
                    leased_actual[service] = observed
                leased_certificate = _retained_certificate(state, document)
                try:
                    leased_proof = validate_pre_admission_recreate(
                        control,
                        previous,
                        document,
                        leased_actual,
                        state,
                        leased_certificate,
                        identity,
                        args.config_sha256,
                        accepted_reattach_context,
                        recovery_context,
                    )
                except PreAdmissionRecreateError as error:
                    raise BuildControlError(str(error)) from error
                if leased_proof != pre_admission_recreate_proof:
                    raise BuildControlError(
                        "Pre-admission recreation proof changed before stop/rm"
                    )
                actual = leased_actual
                operation["receipt"]["pre_admission_recreate"] = pre_admission_recreate_proof
                if carry_existing is not None:
                    _assert_post_build_removed_namespace_absent(
                        carry_existing["metadata"]
                    )
                    leased_carry = validate_pending_capture_continuation(
                        control,
                        previous=previous,
                        document=document,
                        expected_attempt=previous["attempt"],
                        expected_project=control.project,
                        expected_source_root=str(selected),
                        expected_config_sha256=args.config_sha256,
                        certificate_evidence=_post_build_certificate_evidence(
                            state, leased_certificate
                        ),
                        accepted_context=accepted_reattach_context,
                        runtime_config_sha256=_read_runtime_config_digest(control),
                        pre_admission_recreate_proof=leased_proof,
                    )
                    if leased_carry != carry_existing:
                        raise BuildControlError(
                            "Capture-only continuation changed under recreate-services lease"
                        )
            if accepted_reattach_context:
                # The publishing producer cannot run while /control/active is
                # held.  Its read-only bundle path performs the same archive,
                # proof and held-Run validation without publishing anything.
                if accepted_store_root is None:
                    raise BuildControlError("Accepted-run reattach store was not retained")
                from docker_volume_accepted_reattach import build_accepted_reattach_bundle
                produced_again = build_accepted_reattach_bundle(
                    control,
                    store_root=accepted_store_root,
                )
                environment_again = _validate_accepted_reattach_environment(
                    produced_again.get("environment")
                )
                metadata_again = _validate_accepted_reattach_metadata(
                    produced_again.get("pins"), environment_again
                )
                if (
                    environment_again
                    != accepted_reattach_context["accepted_reattach_environment"]
                    or metadata_again
                    != accepted_reattach_context["accepted_reattach_metadata"]
                ):
                    raise BuildControlError(
                        "Accepted-run reattach changed before recreation"
                    )
            if post_build_generation is not None and carry_existing is None:
                from docker_volume_post_build_generation import validate_failed_owner_continuation
                leased_backend = json.loads(docker_text("inspect", ids["backend"]))
                if len(leased_backend) != 1:
                    raise BuildControlError("Post-build continuation has an ambiguous leased backend")
                leased_backend = leased_backend[0]
                before = actual["backend"]
                if (
                    leased_backend.get("Id") != before.get("Id")
                    or leased_backend.get("Image") != before.get("Image")
                    or leased_backend.get("State", {}).get("StartedAt")
                    != before.get("State", {}).get("StartedAt")
                ):
                    raise BuildControlError("Post-build continuation backend incarnation changed under lease")
                _validate_retained_service(
                    document,
                    leased_backend,
                    "backend",
                    image_config,
                    allow_legacy_frontend=True,
                )
                try:
                    leased_post_build = validate_failed_owner_continuation(
                        control,
                        post_build_generation,
                        operation_id=previous["attempt"],
                        expected_project=control.project,
                        expected_source_root=str(selected),
                        previous=previous,
                        document=document,
                        actual_backend=leased_backend,
                        source_identity={
                            "source_root": str(selected),
                            "project_id": identity["project_id"],
                            "worktree_id": identity["worktree_id"],
                            "checkout_kind": identity["checkout_kind"],
                        },
                        certificate_evidence=_post_build_certificate_evidence(
                            state, _retained_certificate(state, document)
                        ),
                        accepted_context=accepted_reattach_context,
                        runtime_config_sha256=_read_runtime_config_digest(control),
                    )
                except BuildControlError as error:
                    raise BuildControlError("Post-build continuation changed under recreate lease: " + str(error)) from error
                if leased_post_build != post_build_generation:
                    raise BuildControlError("Post-build continuation differs under recreate lease")
                actual["backend"] = leased_backend
            _probe_retained_device_access(retained_device_access, image, control.project)
            control.write(operation["root"] + "/retained-containers.json", actual)
            if pre_activation_stop is not None:
                operation["receipt"]["pre_activation_stop_receipt"] = pre_activation_stop
            operation["receipt"].update(state="stopping-owned-frontend", previous_state_root=str(state),
                                        fresh_state=fresh_state)
            operation["daemon_pending"] = True
            if actual["frontend"]["State"]["Running"]:
                _revalidate_helper_source_binding(helper_source_binding, selected)
                docker_capture("stop", "--time", "60", ids["frontend"], timeout=90)
            for service, identifier in ids.items():
                observed = json.loads(docker_text("inspect", identifier))[0]
                if observed["State"]["Running"]:
                    raise BuildControlError("An owned service is still running; resources retained")
                if (fresh_state or terminal_observation is not None) and (
                    observed.get("Id") != actual[service].get("Id")
                    or observed.get("Image") != actual[service].get("Image")
                    or observed["State"].get("StartedAt") != actual[service]["State"].get("StartedAt")
                ):
                    raise BuildControlError("Service restarted during fresh session: " + service)
            snapshot_record = (control.namespace_registry or {}).get("retirement", {})
            if fresh_state and snapshot_record.get("schema") == "fullmag.docker-isolated-session-snapshot.v1":
                from docker_volume_stop_unadmitted import _read_terminal_process_receipt
                native_raw, _ = _read_terminal_process_receipt(actual["backend"], control)
                native_path = operation["root"] + "/snapshot-native-drain.json"
                control.write_bytes(native_path, native_raw)
                operation["receipt"]["snapshot_bootstrap_retirement"] = {
                    "schema": "fullmag.docker-snapshot-bootstrap-retirement.v1",
                    "snapshot_sha256": hashlib.sha256(canonical(snapshot_record)).hexdigest(),
                    "backend_container_id": ids["backend"],
                    "image_id": actual["backend"]["Image"],
                    "backend_started_at": actual["backend"]["State"]["StartedAt"],
                    "native_drain_path": native_path,
                    "native_drain_sha256": hashlib.sha256(native_raw).hexdigest(),
                }
                control.write(operation["root"] + "/receipt.json", operation["receipt"])
            _revalidate_helper_source_binding(helper_source_binding, selected)
            docker_capture("rm", *ids.values())
            if helper_ids:
                docker_capture("rm", *helper_ids)
            if fresh_state:
                from docker_volume_fresh_runtime import archive_runtime_control
                operation["receipt"]["runtime_control_archive"] = archive_runtime_control(
                    control,
                    operation,
                    previous_state_root=str(state),
                    source_root=str(selected),
                    removed_containers=list(ids.values()),
                )
            operation["daemon_pending"] = False
            operation["receipt"].update(state="succeeded", removed_containers=list(ids.values()),
                                        retained_volumes=previous["backend_volumes"], retained_frontend_volume=previous["frontend_volume"])
        if startup_diagnostic_stopped:
            args.completed_recreation_attempt = operation["receipt"]["attempt"]
            args.completed_recreation_sha256 = hashlib.sha256(
                canonical(operation["receipt"]) + b"\n"
            ).hexdigest()
            completed_context = _completed_recreation_start_context(control, args, selected, layout)
            return start(args, **completed_context)
        if post_build_generation is not None:
            # The old namespace is now intentionally gone.  Reuse the same
            # terminal/snapshot/authoritative-Docker-absence validator used by
            # recreation resume, rather than inspecting either removed ID or
            # pretending that the old development attempt is this operation.
            from copy import copy
            proof_args = copy(args)
            proof_args.resume_recreation = operation["receipt"]["attempt"]
            try:
                completed_recreation = _validate_recreation_resume_records(
                    proof_args, control, selected, identity,
                    helper_source_binding=helper_source_binding,
                )
                if carry_existing is None:
                    from docker_volume_post_build_generation import bind_recreate_operation
                    post_build_generation = bind_recreate_operation(
                        post_build_generation, completed_recreation["proof"]
                    )
                else:
                    from docker_volume_pending_continuation import (
                        validate_carry_recreate_receipt,
                    )
                    if completed_recreation["native_recovery_context"] != native_recovery_context:
                        raise BuildControlError(
                            "Capture-only recreation acquired unexpected native recovery authority"
                        )
                    _assert_post_build_removed_namespace_absent(post_build_generation)
                    validate_carry_recreate_receipt(
                        completed_recreation["operation_terminal"],
                        metadata=post_build_generation,
                        pre_admission_proof=pre_admission_recreate_proof,
                        recreation_attempt=completed_recreation["operation_terminal"]["attempt"],
                        accepted_producer=completed_recreation["operation_terminal"].get(
                            "accepted_reattach"
                        ),
                    )
            except BuildControlError as error:
                raise BuildControlError(
                    "Post-build continuation could not validate the completed recreation: " + str(error)
                ) from error
            recovery_context["previous_config_sha256"] = post_build_generation[
                "runtime_config"
            ]["sha256"]
            recovery_context["post_build_generation"] = post_build_generation
        if fresh_state:
            from docker_volume_cancelled_activation_guard import pin_archive
            pin_archive(control)
        reuse = None if fresh_state else {"state": state, "host_certificate": certificate_path,
            "owner_marker": owner_path, "receipt": {"image_id": image},
            "operator_probe_environment_record": operator_probe_record}
        if reuse is not None and helper_source_binding is not None:
            reuse["helper_source_binding"] = helper_source_binding
        recovery_context.update(accepted_reattach_context)
        return start(
            args, reuse_state=reuse, retained_device_access=retained_device_access,
            terminal_observation=terminal_observation, helper_source_binding=helper_source_binding,
            **recovery_context,
        )
    restart_backend = bool(getattr(args, "restart_backend", False))
    if restart_backend:
        if actual["backend"]["State"]["Running"]:
            raise BuildControlError("Starting the retained backend requires it to be stopped; active runtime is never interrupted")
    elif not actual["backend"]["State"]["Running"] or actual["frontend"]["State"]["Running"]:
        raise BuildControlError("Resume requires the retained backend running and frontend stopped")
    state = storage.validate_path(Path(previous["state_root"]), layout["runtime_root"], "retained Windows sessions")
    certificate_path = _certificate_path(state)
    certificate = _retained_certificate(state, document)
    cache = control.read(previous_root + "/backend-cache.json")
    import docker_backend_volume_cache as cache_adapter
    cache_adapter.validate_container(actual["backend"], cache)
    environment = document["services"]["backend"]["environment"]
    ledger_profile = _retained_ledger_profile(control, previous_root, document, image)
    from docker_volume_prestart_recovery import continuation
    import docker_volume_terminal_prestart_recovery as terminal_prestart
    terminal_context = terminal_prestart.continuation(control, args, previous, document, actual, state)
    prestart_checkpoint = (None if terminal_context is not None else
                          continuation(control, args, previous, document, actual, state))
    with control.operation("resume", {"attempt": args.attempt, "config_sha256": args.config_sha256,
                                       **operator_probe_record}) as operation:
        operation["receipt"].update(operator_probe_record)
        operation["receipt"].update(state="resuming-observation", state_root=str(state),
            backend_volumes=previous["backend_volumes"], frontend_volume=previous["frontend_volume"])
        if terminal_context is not None:
            fresh = {name: json.loads(docker_text("inspect", identifier))[0] for name, identifier in ids.items()}
            _assert_private_restart_network(fresh, ids, control.project)
            _retained_certificate(state, document)
            terminal_context = terminal_prestart.continuation(
                control, args, previous, document, fresh, state)
            operation["receipt"].update(
                terminal_prestart_reconciliation=args.prestart_reconciliation,
                terminal_prestart_reconciliation_sha256=args.prestart_reconciliation_sha256)
            operation["daemon_pending"] = True
        if prestart_checkpoint:
            fresh = {name: json.loads(docker_text("inspect", identifier))[0] for name, identifier in ids.items()}
            _assert_private_restart_network(fresh, ids, control.project)
            _retained_certificate(state, document)
            prestart_checkpoint = continuation(control, args, previous, document, fresh, state)
            operation["receipt"].update(
                saved_authoring_restore_required=prestart_checkpoint[0]["archive"],
                prestart_reconciliation=args.prestart_reconciliation,
                prestart_reconciliation_sha256=args.prestart_reconciliation_sha256)
            operation["daemon_pending"] = True
        if not actual["frontend"]["State"]["Running"]:
            _frontend(control, operation, selected, state, args.port, image)
            compose_capture(document, "start", "frontend", timeout=90)
        if restart_backend:
            operation["daemon_pending"] = True
            compose_capture(document, "start", "backend", timeout=90)
            operation["daemon_pending"] = bool(prestart_checkpoint or terminal_context is not None)
        git_common = Path(environment["FULLMAG_SOURCE_GIT_COMMON"]) if "FULLMAG_SOURCE_GIT_COMMON" in environment else Path(
            next(m["source"] for m in document["services"]["backend"]["volumes"] if m["target"] == "/opt/fullmag/source-git"))
        _finish(control, operation, document, ids["backend"], ids["frontend"], selected, state,
            certificate_path, certificate, cache, {"image_id": environment["FULLMAG_TOOLCHAIN_IMAGE_ID"]},
            image, git_common, ledger_profile, args.port,
            terminal_completion_gate=(lambda qualified: terminal_prestart.complete(
                control, operation, ids["backend"], terminal_context, qualified))
                if terminal_context is not None else None,
            completion_gate=(lambda: _saved_authoring_complete(control, operation,
                ids["backend"], prestart_checkpoint[0], state, prestart_checkpoint[1]))
                if prestart_checkpoint else None)
