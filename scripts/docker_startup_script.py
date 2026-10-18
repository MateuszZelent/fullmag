"""Validate and activate one explicit Docker workspace startup script.

The host launcher owns source admission and the container owns execution.  A
startup script is never executed by this module and is never sent through the
legacy ``fullmag-bin`` scratch CLI.  The API must lower it through the live
accepted-v2 path after checking the same immutable bytes that the launcher
attested.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import uuid
from contextlib import nullcontext
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

import fullmag_storage as storage


AUTHORIZATION_SCHEMA = "fullmag.docker-startup-script.v1"
REQUEST_SCHEMA = "fullmag.startup-script-activation-request.v1"
RESPONSE_SCHEMA = "fullmag.startup-script-activation.v1"
ACTIVATION_RECEIPT_SCHEMA = "fullmag.docker-startup-activation-receipt.v1"
STARTUP_ACTIVATION_DIAGNOSTIC_SCHEMA = "fullmag.startup-activation-diagnostic.v1"
AUTHORIZATION_KIND = "explicit_startup_script"
# The existing script importer and Python helper both use a 1 MiB source
# boundary.  Startup must not create a larger, parallel script transport.
# Keep the bridge outside the browser v2 resource tree.  The API owner wires
# this beside the existing `/v1/internal/live/current/*` runner bridge and
# applies the normal current-session/epoch owner fence there.
STARTUP_ENDPOINT = "/v1/internal/live/current/startup"
MAX_SCRIPT_BYTES = 1024 * 1024
MAX_PROVENANCE_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_ACTIVATION_RECEIPT_BYTES = 2 * MAX_RESPONSE_BYTES
STARTUP_ACTIVATION_TIMEOUT_SECONDS = 2100.0
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
PROVENANCE_SHA256_ENV = "FULLMAG_STARTUP_PROVENANCE_SHA256"
ACTIVATION_RECEIPT_PATH = Path("/state/.fullmag/docker-startup/activation.json")
# Script authoring/capability failures are command outcomes. A rejected
# execution-policy envelope is a launcher/protocol error and stays fatal.
SCRIPT_REJECTION_CODES = frozenset({
    "bad_request", "validation_error", "unprocessable_entity", "unsupported_capability",
    # Canonical accepted-study validation runs before durable RunIntent admission.
    # Do not include commit/catalog/storage errors or accept an "accepted_" prefix.
    "accepted_execution_command_unsupported", "accepted_study_plan_invalid",
    "accepted_execution_stage_missing", "accepted_gpu_scope_unsupported",
    "accepted_execution_plan_invalid", "accepted_backend_unsupported",
    "accepted_study_step_unsupported", "accepted_study_step_ambiguous",
})


class StartupScriptError(ValueError):
    """Fail-closed source or activation admission error."""


class StartupScriptRejected(StartupScriptError):
    """An authoritative script validation rejection, before solver admission."""

    def __init__(self, http_status: int, code: str, message: str):
        self.http_status = http_status
        self.code = code
        self.message = message[:2048]
        super().__init__(f"startup script rejected (HTTP {http_status}, {code}): {self.message}")


class _StartupActivationTransportUnknown(StartupScriptError):
    """The activation request may have reached the API without a result."""


class _StartupActivationReceiptExists(StartupScriptError):
    """The exclusive marker open lost a create race with another starter."""


class StartupActivationOutcomeUnknown(StartupScriptError):
    """A POST may have reached the API; its durable marker forbids retry."""

    def __init__(self, started: Mapping[str, Any], message: str):
        authorization = started.get("authorization")
        self.started = dict(started)
        self.diagnostic = {
            "schema": STARTUP_ACTIVATION_DIAGNOSTIC_SCHEMA,
            "state": "unknown",
            "request_id": started.get("request_id"),
            "source_sha256": started.get("source_sha256"),
            "source_relative": (
                authorization.get("source_relative")
                if isinstance(authorization, Mapping) else None
            ),
            "durable_state": "started",
            "error": str(message)[-4096:],
        }
        super().__init__(self.diagnostic["error"])


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise StartupScriptError("startup activation API redirect is not allowed")


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise StartupScriptError(f"startup metadata contains duplicate key {key!r}")
        result[key] = value
    return result


def _no_reparse_path(path: Path, label: str, *, require_directory: bool = False) -> Path:
    """Return an existing absolute path after lexical and reparse checks."""

    path = Path(path).expanduser()
    if not path.is_absolute():
        raise StartupScriptError(f"{label} must be an absolute path")
    lexical = Path(os.path.abspath(str(path)))
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise StartupScriptError(f"{label} is unavailable: {path}") from error
    if os.path.normcase(str(lexical)) != os.path.normcase(str(resolved)):
        raise StartupScriptError(f"{label} must not traverse a symlink or reparse point")
    for ancestor in (path, *path.parents):
        try:
            if storage.is_link(ancestor):
                raise StartupScriptError(
                    f"{label} traverses a symlink or reparse point: {ancestor}"
                )
        except OSError as error:
            raise StartupScriptError(f"cannot inspect {label}: {error}") from error
    try:
        metadata = path.stat()
    except OSError as error:
        raise StartupScriptError(f"cannot inspect {label}: {error}") from error
    if require_directory:
        if not stat.S_ISDIR(metadata.st_mode):
            raise StartupScriptError(f"{label} must be a directory")
    elif not stat.S_ISREG(metadata.st_mode):
        raise StartupScriptError(f"{label} must be a regular file")
    return resolved


def _bounded_regular(path: Path, maximum: int, label: str) -> bytes:
    """Read an owned bounded file through the native no-follow helper."""

    path = _no_reparse_path(path, label)
    if os.name == "nt":
        # This helper opens a native handle, checks the reparse tag, and reads
        # from that handle.  It is the only supported Windows path read here.
        from windows_folder_host import read_owned_regular

        return read_owned_regular(path, maximum=maximum)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise StartupScriptError(f"cannot open {label}: {error}") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > maximum:
            raise StartupScriptError(f"{label} must be a bounded regular file")
        data = bytearray()
        while len(data) <= maximum:
            chunk = os.read(descriptor, min(64 * 1024, maximum + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > maximum:
            raise StartupScriptError(f"{label} exceeds the {maximum}-byte bound")
        return bytes(data)
    except OSError as error:
        raise StartupScriptError(f"cannot read {label}: {error}") from error
    finally:
        os.close(descriptor)


def _contained_relative(path: Path, root: Path, label: str) -> str:
    try:
        relative = path.relative_to(root)
    except ValueError as error:
        raise StartupScriptError(f"{label} must be inside the selected readonly checkout") from error
    if not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
        raise StartupScriptError(f"{label} has an invalid relative path")
    return relative.as_posix()


def _container_script_path(source_relative: str) -> str:
    # source_relative was produced from a checked path, but keep this boundary
    # explicit because the resulting value is sent to another process.
    parts = source_relative.split("/")
    if (
        not parts
        or "\\" in source_relative
        or "\x00" in source_relative
        or any(not part or part in {".", ".."} for part in parts)
    ):
        raise StartupScriptError("startup script relative path is invalid")
    return "/opt/fullmag/source/" + "/".join(parts)


def _validate_request_id(value: str) -> str:
    if not isinstance(value, str) or not REQUEST_ID_RE.fullmatch(value):
        raise StartupScriptError("startup request id is invalid")
    return value


@dataclass(frozen=True)
class StartupScriptAuthorization:
    """Host-attested script identity and its fixed container projection."""

    source_root: Path
    source_path: Path
    source_relative: str
    source_sha256: str
    source_size_bytes: int
    container_source_root: str
    container_script_path: str
    request_id: str
    source_commit: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": AUTHORIZATION_SCHEMA,
            "authorization": AUTHORIZATION_KIND,
            "source_root": str(self.source_root),
            "source_path": str(self.source_path),
            "source_relative": self.source_relative,
            "source_sha256": self.source_sha256,
            "source_size_bytes": self.source_size_bytes,
            "source_commit": self.source_commit,
            "container_source_root": self.container_source_root,
            "container_script_path": self.container_script_path,
            "request_id": self.request_id,
            "execution_policy": {
                "mode": "canonical_live_v2",
                "auto_study": True,
                "interactive": "script_metadata",
                "wait_for_solve": "script_metadata",
                "legacy_cli": False,
            },
        }


def prepare(
    source_root: str | os.PathLike[str],
    script_path: str | os.PathLike[str],
    *,
    request_id: str,
    source_commit: str | None = None,
    container_source_root: str = "/opt/fullmag/source",
) -> StartupScriptAuthorization:
    """Admit a regular Python file relative to one readonly checkout."""

    root = _no_reparse_path(Path(source_root), "startup source checkout", require_directory=True)
    candidate = Path(script_path).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    candidate = _no_reparse_path(candidate, "startup script")
    relative = _contained_relative(candidate, root, "startup script")
    if not relative.lower().endswith(".py"):
        raise StartupScriptError("startup script must have a .py extension")
    data = _bounded_regular(candidate, MAX_SCRIPT_BYTES, "startup script")
    try:
        data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise StartupScriptError("startup script must be UTF-8") from error
    if not isinstance(container_source_root, str) or container_source_root != "/opt/fullmag/source":
        raise StartupScriptError("startup container source root is immutable")
    if source_commit is not None and (
        not isinstance(source_commit, str) or not COMMIT_RE.fullmatch(source_commit)
    ):
        raise StartupScriptError("startup source commit must be a full lowercase SHA-1")
    return StartupScriptAuthorization(
        source_root=root,
        source_path=candidate,
        source_relative=relative,
        source_sha256=hashlib.sha256(data).hexdigest(),
        source_size_bytes=len(data),
        source_commit=source_commit,
        container_source_root=container_source_root,
        container_script_path=_container_script_path(relative),
        request_id=_validate_request_id(request_id),
    )


def _pinned_parent(path: Path):
    """Hold native parent handles while publishing a one-shot receipt."""

    if os.name != "nt":
        return nullcontext()
    try:
        from windows_folder_host import _pinned_no_reparse_ancestors
    except ImportError as error:
        raise StartupScriptError("native Windows provenance pinning helper is unavailable") from error
    return _pinned_no_reparse_ancestors(path)


def _json_payload(value: Mapping[str, Any], maximum: int, label: str) -> bytes:
    try:
        payload = (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    except (TypeError, ValueError) as error:
        raise StartupScriptError(f"{label} is not serializable JSON") from error
    if len(payload) > maximum:
        raise StartupScriptError(f"{label} exceeds its {maximum}-byte bound")
    return payload


def _exclusive_json(
    path: Path,
    value: Mapping[str, Any],
    *,
    label: str = "startup provenance",
    maximum: int | None = None,
) -> str:
    """Create one durable JSON file without replacing a concurrent publication."""

    parent = _no_reparse_path(path.parent, f"{label} parent", require_directory=True)
    payload = _json_payload(value, maximum, label) if maximum is not None else (
        json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    ).encode("utf-8")
    # The Windows CRT defaults file descriptors to text mode.  Provenance is
    # attested as bytes, so force binary mode before writing; otherwise the
    # CRT may expand LF to CRLF and the returned digest would not describe the
    # durable file that the container later reads.
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_BINARY", 0)
    )
    parent_fd = None
    descriptor = None
    try:
        with _pinned_parent(parent):
            if os.name != "nt" and hasattr(os, "O_DIRECTORY"):
                parent_fd = os.open(str(parent), os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0))
                try:
                    descriptor = os.open(path.name, flags, 0o660, dir_fd=parent_fd)
                except FileExistsError as error:
                    raise _StartupActivationReceiptExists(
                        f"{label} destination already exists"
                    ) from error
            else:
                try:
                    descriptor = os.open(str(parent / path.name), flags, 0o660)
                except FileExistsError as error:
                    raise _StartupActivationReceiptExists(
                        f"{label} destination already exists"
                    ) from error
            offset = 0
            while offset < len(payload):
                offset += os.write(descriptor, payload[offset:])
            os.fsync(descriptor)
            if parent_fd is not None:
                os.fsync(parent_fd)
    except OSError as error:
        raise StartupScriptError(f"cannot publish {label}: {error}") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if parent_fd is not None:
            os.close(parent_fd)
    return hashlib.sha256(payload).hexdigest()


def _ensure_activation_receipt_parent(path: Path) -> Path:
    """Create the one missing receipt directory under an already owned state root."""

    path = Path(path).expanduser()
    if not path.is_absolute():
        raise StartupScriptError("startup activation receipt must be an absolute path")
    parent = path.parent
    # The entrypoint creates /state/.fullmag before importing this helper.  Do
    # not recursively create arbitrary path components: only the final,
    # helper-owned directory may be added here.
    state_parent = _no_reparse_path(parent.parent, "startup activation state parent", require_directory=True)
    if os.path.lexists(parent):
        return _no_reparse_path(parent, "startup activation receipt parent", require_directory=True)
    try:
        with _pinned_parent(state_parent):
            os.mkdir(parent, 0o770)
    except FileExistsError:
        pass
    except OSError as error:
        raise StartupScriptError(f"cannot create startup activation receipt parent: {error}") from error
    result = _no_reparse_path(parent, "startup activation receipt parent", require_directory=True)
    if os.name != "nt":
        try:
            descriptor = os.open(
                str(state_parent),
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
            )
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        except OSError as error:
            raise StartupScriptError("cannot durably publish startup activation parent") from error
    return result


def _replace_json(
    path: Path,
    value: Mapping[str, Any],
    *,
    label: str,
    maximum: int,
) -> str:
    """Atomically replace a validated receipt with a flushed terminal result."""

    path = Path(path)
    parent = _no_reparse_path(path.parent, f"{label} parent", require_directory=True)
    _no_reparse_path(path, label)
    payload = _json_payload(value, maximum, label)
    temporary_name = f".{path.name}.{uuid.uuid4().hex}.tmp"
    temporary = parent / temporary_name
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_BINARY", 0)
    )
    parent_fd = None
    descriptor = None
    try:
        with _pinned_parent(parent):
            if os.name != "nt" and hasattr(os, "O_DIRECTORY"):
                parent_fd = os.open(
                    str(parent), os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
                )
                descriptor = os.open(temporary_name, flags, 0o660, dir_fd=parent_fd)
            else:
                descriptor = os.open(str(temporary), flags, 0o660)
            offset = 0
            while offset < len(payload):
                offset += os.write(descriptor, payload[offset:])
            os.fsync(descriptor)
            if descriptor is not None:
                os.close(descriptor)
                descriptor = None
            if os.name != "nt":
                os.replace(
                    temporary_name,
                    path.name,
                    src_dir_fd=parent_fd,
                    dst_dir_fd=parent_fd,
                )
                os.fsync(parent_fd)
            else:
                from windows_folder_host import _replace_write_through

                _replace_write_through(temporary, path)
    except OSError as error:
        raise StartupScriptError(f"cannot publish {label}: {error}") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if parent_fd is not None:
            os.close(parent_fd)
        try:
            if os.path.lexists(temporary):
                os.unlink(temporary)
        except OSError:
            # The terminal publication error is the useful evidence; never
            # remove an unrelated path while trying to clean our own temp name.
            pass
    return hashlib.sha256(payload).hexdigest()


def write_provenance(path: str | os.PathLike[str], authorization: StartupScriptAuthorization) -> str:
    """Publish the bounded startup authorization into the run-owned state."""

    return _exclusive_json(Path(path), authorization.as_dict())


def _load_provenance_with_digest(path: str | os.PathLike[str]) -> tuple[dict[str, Any], str]:
    raw = _bounded_regular(Path(path), MAX_PROVENANCE_BYTES, "startup provenance")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise StartupScriptError("startup provenance is not valid JSON") from error
    if not isinstance(value, dict) or value.get("schema") != AUTHORIZATION_SCHEMA:
        raise StartupScriptError("startup provenance schema mismatch")
    if value.get("authorization") != AUTHORIZATION_KIND:
        raise StartupScriptError("startup provenance authorization mismatch")
    return value, hashlib.sha256(raw).hexdigest()


def _load_provenance(path: str | os.PathLike[str]) -> dict[str, Any]:
    return _load_provenance_with_digest(path)[0]


def build_activation_request(authorization: Mapping[str, Any]) -> dict[str, Any]:
    """Build the fixed live-v2 request; no executable command is accepted."""

    if authorization.get("schema") != AUTHORIZATION_SCHEMA:
        raise StartupScriptError("startup authorization schema mismatch")
    if authorization.get("authorization") != AUTHORIZATION_KIND:
        raise StartupScriptError("startup authorization kind mismatch")
    source_sha256 = authorization.get("source_sha256")
    source_relative = authorization.get("source_relative")
    source_path = authorization.get("container_script_path")
    source_root = authorization.get("container_source_root")
    request_id = _validate_request_id(authorization.get("request_id"))
    if not isinstance(source_sha256, str) or not SHA256_RE.fullmatch(source_sha256):
        raise StartupScriptError("startup authorization has an invalid SHA-256")
    if not isinstance(source_relative, str) or not source_relative.lower().endswith(".py"):
        raise StartupScriptError("startup authorization has an invalid relative path")
    if source_path != _container_script_path(source_relative):
        raise StartupScriptError("startup authorization container path mismatch")
    if source_root != "/opt/fullmag/source":
        raise StartupScriptError("startup authorization container root mismatch")
    source_commit = authorization.get("source_commit")
    if source_commit is not None and (
        not isinstance(source_commit, str) or not COMMIT_RE.fullmatch(source_commit)
    ):
        raise StartupScriptError("startup authorization commit is invalid")
    return {
        "schema": REQUEST_SCHEMA,
        "authorization": AUTHORIZATION_KIND,
        "request_id": request_id,
        "source": {
            "path": source_path,
            "root": source_root,
            "relative": source_relative,
            "sha256": source_sha256,
            "commit": source_commit,
        },
        "execution": {
            "mode": "canonical_live_v2",
            "auto_study": True,
            "interactive": "script_metadata",
            "wait_for_solve": "script_metadata",
            "legacy_cli": False,
        },
    }


def validate_activation_response(
    response: Mapping[str, Any], authorization: Mapping[str, Any]
) -> dict[str, Any]:
    if not isinstance(response, Mapping) or response.get("schema") != RESPONSE_SCHEMA:
        raise StartupScriptError("startup activation response schema mismatch")
    if response.get("authorization") != AUTHORIZATION_KIND:
        raise StartupScriptError("startup activation response authorization mismatch")
    if response.get("request_id") != authorization.get("request_id"):
        raise StartupScriptError("startup activation response request fence mismatch")
    if response.get("source_sha256") != authorization.get("source_sha256"):
        raise StartupScriptError("startup activation response source hash mismatch")
    for field in ("session_id", "run_id"):
        value = response.get(field)
        if not isinstance(value, str) or not value.strip():
            raise StartupScriptError(f"startup activation response {field} is missing")
    step_ids = response.get("step_ids")
    if (not isinstance(step_ids, list) or not step_ids
            or any(not isinstance(step_id, str) or not step_id.strip() for step_id in step_ids)
            or len(set(step_ids)) != len(step_ids)):
        raise StartupScriptError("startup activation response step_ids are invalid")
    scene_revision = response.get("scene_revision")
    if (isinstance(scene_revision, bool) or not isinstance(scene_revision, int)
            or not 0 <= scene_revision <= 2**64 - 1):
        raise StartupScriptError("startup activation response scene_revision is invalid")
    status = response.get("status")
    if status not in {"accepted", "waiting_for_solve"}:
        raise StartupScriptError("startup activation did not reach a recognized terminal state")
    execution = response.get("execution")
    expected_execution = {
        "mode": "canonical_live_v2",
        "auto_study": True,
        "interactive": "script_metadata",
        "wait_for_solve": "script_metadata",
        "legacy_cli": False,
    }
    if not isinstance(execution, Mapping) or any(
        execution.get(key) != value for key, value in expected_execution.items()
    ):
        raise StartupScriptError("startup activation response does not attest canonical live execution")
    runtime_metadata = response.get("runtime_metadata")
    if (not isinstance(runtime_metadata, Mapping)
            or type(runtime_metadata.get("interactive")) is not bool
            or type(runtime_metadata.get("wait_for_solve")) is not bool):
        raise StartupScriptError("startup activation response runtime metadata is invalid")
    wait_for_solve = runtime_metadata["wait_for_solve"]
    if wait_for_solve and not runtime_metadata["interactive"]:
        raise StartupScriptError("startup activation response wait_for_solve requires interactive")
    if (wait_for_solve and status != "waiting_for_solve") or (
            not wait_for_solve and status != "accepted"):
        raise StartupScriptError("startup activation response status disagrees with wait_for_solve")
    return dict(response)


def activate(
    authorization: Mapping[str, Any],
    *,
    api_base: str = "http://127.0.0.1:8081",
    timeout: float = STARTUP_ACTIVATION_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Activate through the one canonical current-session API endpoint."""

    if not 0 < timeout <= STARTUP_ACTIVATION_TIMEOUT_SECONDS:
        raise StartupScriptError(
            "startup activation timeout must be between 0 and "
            f"{STARTUP_ACTIVATION_TIMEOUT_SECONDS:g} seconds"
        )
    parsed = urllib.parse.urlparse(api_base)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise StartupScriptError("startup activation API must be the local backend")
    request = urllib.request.Request(
        api_base.rstrip("/") + STARTUP_ENDPOINT,
        data=json.dumps(build_activation_request(authorization), separators=(",", ":")).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        opener = urllib.request.build_opener(_NoRedirect())
        with opener.open(request, timeout=timeout) as result:
            if result.status < 200 or result.status >= 300:
                error_type = (
                    _StartupActivationTransportUnknown
                    if result.status == 409 or result.status >= 500
                    else StartupScriptError
                )
                raise error_type(f"startup activation returned HTTP {result.status}")
            body = result.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        try:
            body = error.read(MAX_RESPONSE_BYTES + 1)
        except (OSError, urllib.error.URLError, TimeoutError) as read_error:
            error_type = (
                _StartupActivationTransportUnknown
                if error.code == 409 or error.code >= 500
                else StartupScriptError
            )
            raise error_type(
                f"startup activation HTTP {error.code} response read failed: {read_error}"
            ) from read_error
        # Only a well-formed validation response is a known command rejection.
        # Authentication and malformed/client responses remain fatal; 409 and
        # server failures become outcome-unknown after the durable marker.
        if error.code in {400, 422} and len(body) <= MAX_RESPONSE_BYTES:
            try:
                rejection = json.loads(body.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
            except (UnicodeDecodeError, ValueError):
                rejection = None
            if (isinstance(rejection, dict)
                    and isinstance(rejection.get("code"), str)
                    and rejection.get("code") in SCRIPT_REJECTION_CODES
                    and isinstance(rejection.get("message"), str)
                    and rejection["message"].strip()):
                raise StartupScriptRejected(
                    error.code, rejection["code"], rejection["message"],
                ) from error
        detail = body[:4096].decode("utf-8", errors="replace")
        error_type = (
            _StartupActivationTransportUnknown
            if error.code == 409 or error.code >= 500
            else StartupScriptError
        )
        raise error_type(
            f"startup activation returned HTTP {error.code}: {detail}"
        ) from error
    except (OSError, urllib.error.URLError, TimeoutError) as error:
        raise _StartupActivationTransportUnknown(
            f"startup activation outcome is unknown: {error}"
        ) from error
    if len(body) > MAX_RESPONSE_BYTES:
        raise StartupScriptError("startup activation response exceeds its size bound")
    try:
        response = json.loads(body.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise StartupScriptError("startup activation response is not valid JSON") from error
    return validate_activation_response(response, authorization)


def _activation_receipt_started(
    authorization: Mapping[str, Any], provenance_sha256: str
) -> dict[str, Any]:
    """Build the durable pre-POST marker from one host-attested request."""

    build_activation_request(authorization)
    source_sha256 = authorization.get("source_sha256")
    if not isinstance(source_sha256, str) or not SHA256_RE.fullmatch(source_sha256):
        raise StartupScriptError("startup activation authorization has an invalid source hash")
    if not isinstance(provenance_sha256, str) or not SHA256_RE.fullmatch(provenance_sha256):
        raise StartupScriptError("startup activation provenance hash is invalid")
    _validate_source_size(authorization, "startup activation authorization")
    return {
        "schema": ACTIVATION_RECEIPT_SCHEMA,
        "state": "started",
        "request_id": authorization["request_id"],
        "provenance_sha256": provenance_sha256,
        "source_sha256": source_sha256,
        "authorization": dict(authorization),
    }


def _validate_source_size(authorization: Mapping[str, Any], label: str) -> None:
    source_size_bytes = authorization.get("source_size_bytes")
    if (isinstance(source_size_bytes, bool) or not isinstance(source_size_bytes, int)
            or not 0 <= source_size_bytes <= MAX_SCRIPT_BYTES):
        raise StartupScriptError(f"{label} source size is invalid")


def _validate_activation_receipt(value: Mapping[str, Any]) -> dict[str, Any]:
    """Validate a bounded receipt before it can influence startup behavior."""

    if not isinstance(value, dict) or value.get("schema") != ACTIVATION_RECEIPT_SCHEMA:
        raise StartupScriptError("startup activation receipt schema mismatch")
    state = value.get("state")
    if state not in {"started", "activated", "rejected"}:
        raise StartupScriptError("startup activation receipt state is unknown")
    base_fields = {
        "schema", "state", "request_id", "provenance_sha256",
        "source_sha256", "authorization",
    }
    expected_fields = base_fields if state == "started" else base_fields | {"result"}
    if set(value) != expected_fields:
        raise StartupScriptError("startup activation receipt fields are invalid")
    request_id = value.get("request_id")
    if not isinstance(request_id, str) or not REQUEST_ID_RE.fullmatch(request_id):
        raise StartupScriptError("startup activation receipt request id is invalid")
    for field in ("provenance_sha256", "source_sha256"):
        candidate = value.get(field)
        if not isinstance(candidate, str) or not SHA256_RE.fullmatch(candidate):
            raise StartupScriptError(f"startup activation receipt {field} is invalid")
    authorization = value.get("authorization")
    if not isinstance(authorization, dict):
        raise StartupScriptError("startup activation receipt authorization is missing")
    build_activation_request(authorization)
    if authorization.get("request_id") != request_id:
        raise StartupScriptError("startup activation receipt request fence differs")
    if authorization.get("source_sha256") != value.get("source_sha256"):
        raise StartupScriptError("startup activation receipt source hash fence differs")
    _validate_source_size(authorization, "startup activation receipt")
    if state == "started":
        return dict(value)
    result = value.get("result")
    if not isinstance(result, dict) or result.get("state") != state:
        raise StartupScriptError("startup activation receipt terminal result is invalid")
    if state == "rejected":
        validate_rejection_receipt(result, authorization)
    else:
        if (result.get("schema") != RESPONSE_SCHEMA
                or result.get("request_id") != request_id
                or result.get("source_sha256") != value.get("source_sha256")
                or result.get("source_relative") != authorization.get("source_relative")):
            raise StartupScriptError("startup activation receipt terminal fence differs")
        response = result.get("response")
        if not isinstance(response, dict):
            raise StartupScriptError("startup activation receipt activation response is missing")
        validate_activation_response(response, authorization)
    return dict(value)


def _load_activation_receipt(path: Path) -> dict[str, Any] | None:
    """Read a receipt only through the bounded no-reparse reader."""

    if not os.path.lexists(path):
        return None
    raw = _bounded_regular(path, MAX_ACTIVATION_RECEIPT_BYTES, "startup activation receipt")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise StartupScriptError("startup activation receipt is not valid JSON") from error
    return _validate_activation_receipt(value)


def _receipt_identity_matches(
    receipt: Mapping[str, Any], authorization: Mapping[str, Any], provenance_sha256: str
) -> bool:
    stored_authorization = receipt.get("authorization")
    if not isinstance(stored_authorization, Mapping):
        return False
    if receipt.get("provenance_sha256") != provenance_sha256:
        return False
    if receipt.get("request_id") != authorization.get("request_id"):
        return False
    if receipt.get("source_sha256") != authorization.get("source_sha256"):
        return False
    return dict(stored_authorization) == dict(authorization)


def _replay_or_reject_existing_receipt(
    receipt: Mapping[str, Any], authorization: Mapping[str, Any], provenance_sha256: str
) -> dict[str, Any]:
    if not _receipt_identity_matches(receipt, authorization, provenance_sha256):
        raise StartupScriptError("startup activation receipt belongs to a different request")
    if receipt.get("state") == "started":
        raise StartupActivationOutcomeUnknown(
            receipt,
            "startup activation outcome is unknown; durable started receipt prevents a retry",
        )
    result = receipt.get("result")
    if not isinstance(result, dict):
        raise StartupScriptError("startup activation receipt terminal result is missing")
    return dict(result)


def _publish_activation_terminal(
    path: Path,
    started: Mapping[str, Any],
    result: Mapping[str, Any],
) -> None:
    """Publish activated/rejected only if the pre-POST marker is still intact."""

    current = _load_activation_receipt(path)
    if current != dict(started):
        raise StartupScriptError("startup activation started receipt changed before terminal publication")
    terminal = dict(started)
    terminal["state"] = result.get("state")
    terminal["result"] = dict(result)
    _validate_activation_receipt(terminal)
    _replace_json(
        path,
        terminal,
        label="startup activation receipt",
        maximum=MAX_ACTIVATION_RECEIPT_BYTES,
    )


def run_from_environment() -> dict[str, Any] | None:
    """Run the optional startup activation after the API is ready."""

    configured_names = (
        "FULLMAG_STARTUP_ENABLED",
        "FULLMAG_STARTUP_SCRIPT",
        "FULLMAG_STARTUP_PROVENANCE",
        "FULLMAG_STARTUP_API",
        PROVENANCE_SHA256_ENV,
    )
    if not any(name in os.environ for name in configured_names):
        return None
    values = {
        "enabled": os.environ.get("FULLMAG_STARTUP_ENABLED"),
        "script": os.environ.get("FULLMAG_STARTUP_SCRIPT"),
        "provenance": os.environ.get("FULLMAG_STARTUP_PROVENANCE"),
        "api": os.environ.get("FULLMAG_STARTUP_API", "http://127.0.0.1:8081"),
        "provenance_sha256": os.environ.get(PROVENANCE_SHA256_ENV),
    }
    if (values["enabled"] != "1" or not values["script"] or not values["provenance"]
            or not isinstance(values["provenance_sha256"], str)
            or not SHA256_RE.fullmatch(values["provenance_sha256"])):
        raise StartupScriptError("startup activation environment is incomplete")
    authorization, provenance_sha256 = _load_provenance_with_digest(values["provenance"])
    if provenance_sha256 != values["provenance_sha256"]:
        raise StartupScriptError("mounted startup provenance differs from host-attested bytes")
    build_activation_request(authorization)
    _validate_source_size(authorization, "startup activation authorization")
    if authorization.get("container_script_path") != values["script"]:
        raise StartupScriptError("mounted startup script path differs from provenance")
    receipt_path = _ensure_activation_receipt_parent(ACTIVATION_RECEIPT_PATH) / ACTIVATION_RECEIPT_PATH.name
    existing = _load_activation_receipt(receipt_path)
    if existing is not None:
        return _replay_or_reject_existing_receipt(existing, authorization, provenance_sha256)
    script_data = _bounded_regular(Path(values["script"]), MAX_SCRIPT_BYTES, "mounted startup script")
    observed = hashlib.sha256(script_data).hexdigest()
    if observed != authorization.get("source_sha256"):
        raise StartupScriptError("mounted startup script differs from host-attested bytes")
    if len(script_data) != authorization.get("source_size_bytes"):
        raise StartupScriptError("mounted startup script size differs from host-attested bytes")
    started = _activation_receipt_started(authorization, provenance_sha256)
    try:
        _exclusive_json(
            receipt_path,
            started,
            label="startup activation receipt",
            maximum=MAX_ACTIVATION_RECEIPT_BYTES,
        )
    except _StartupActivationReceiptExists:
        raced = _load_activation_receipt(receipt_path)
        if raced is None:
            raise StartupScriptError(
                "startup activation receipt disappeared after an exclusive-create race"
            )
        return _replay_or_reject_existing_receipt(raced, authorization, provenance_sha256)
    try:
        response = activate(authorization, api_base=values["api"])
    except _StartupActivationTransportUnknown as error:
        # Only the transport/server-outcome class is non-terminal here.  The
        # marker must still be byte-for-byte unchanged; malformed provenance,
        # response contracts, policy, and receipt publication remain fatal.
        current = _load_activation_receipt(receipt_path)
        if current != started or current.get("state") != "started":
            raise error
        raise StartupActivationOutcomeUnknown(started, str(error)) from error
    except StartupScriptRejected as error:
        result = {
            "schema": RESPONSE_SCHEMA,
            "state": "rejected",
            "request_id": authorization["request_id"],
            "source_sha256": authorization["source_sha256"],
            "source_relative": authorization["source_relative"],
            "rejection": {
                "http_status": error.http_status,
                "code": error.code,
                "message": error.message,
            },
        }
        _publish_activation_terminal(receipt_path, started, result)
        return result
    result = {
        "schema": RESPONSE_SCHEMA,
        "state": "activated",
        "request_id": authorization["request_id"],
        "source_sha256": authorization["source_sha256"],
        "source_relative": authorization["source_relative"],
        "response": response,
    }
    _publish_activation_terminal(receipt_path, started, result)
    return result


def validate_rejection_receipt(value: Mapping[str, Any], authorization: Mapping[str, Any]) -> dict[str, Any]:
    """Fence a known rejection to the same host-authorized script request."""
    build_activation_request(authorization)
    if (not isinstance(value, dict) or value.get("schema") != RESPONSE_SCHEMA
            or value.get("state") != "rejected"
            or any(value.get(key) != authorization.get(key)
                   for key in ("request_id", "source_sha256", "source_relative"))
            or "response" in value):
        raise StartupScriptError("startup rejection fence differs from the host authorization")
    rejection = value.get("rejection")
    if (not isinstance(rejection, dict)
            or type(rejection.get("http_status")) is not int
            or rejection["http_status"] not in {400, 422}
            or not isinstance(rejection.get("code"), str)
            or rejection.get("code") not in SCRIPT_REJECTION_CODES
            or not isinstance(rejection.get("message"), str)
            or not rejection["message"].strip() or len(rejection["message"]) > 2048):
        raise StartupScriptError("startup rejection response is invalid")
    return dict(value)


__all__ = [
    "AUTHORIZATION_SCHEMA",
    "ACTIVATION_RECEIPT_PATH",
    "ACTIVATION_RECEIPT_SCHEMA",
    "REQUEST_SCHEMA",
    "RESPONSE_SCHEMA",
    "StartupScriptAuthorization",
    "StartupScriptError",
    "StartupScriptRejected",
    "StartupActivationOutcomeUnknown",
    "STARTUP_ACTIVATION_DIAGNOSTIC_SCHEMA",
    "STARTUP_ACTIVATION_TIMEOUT_SECONDS",
    "activate",
    "build_activation_request",
    "prepare",
    "run_from_environment",
    "validate_activation_response",
    "validate_rejection_receipt",
    "write_provenance",
]
