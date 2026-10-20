"""Produce the private same-run accepted reattach input for Docker DEV.

The producer is deliberately a narrow bridge between the retained Docker
control records and the API's pre-listen input.  It does not submit a run,
release the accepted start gate, acquire or release resources, retry startup,
or mutate the Windows-backed SessionStore.  Rust revalidates the complete
accepted snapshot before installing it in the new API process.

Four immutable documents are published to the technical control volume: the
proof, request, and raw terminal process/owner records consumed by PID 1.
The public return value contains
the environment overlay and all record pins needed by the caller to retain
the operation context.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import stat
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
import re

from docker_build_control import (
    BuildControl,
    BuildControlError,
    bounded_capture,
    canonical,
    control_read_script,
)


REQUEST_SCHEMA = "fullmag.docker-accepted-run-reattach-request.v1"
PROOF_SCHEMA = "fullmag.development-accepted-run-reattach-proof.v1"
PRODUCER_SCHEMA = "fullmag.docker-accepted-run-reattach-producer.v1"
NAMESPACE_ATTESTATION_SCHEMA = "fullmag.docker-stopped-namespace-attestation.v1"

# The runtime-control subpath is mounted both as a subdirectory of the full
# control volume and as the API's technical state root.  The request's paths
# are relative to that subpath; the publisher prefixes them when addressing
# the full control mount.
RUNTIME_RELATIVE_PREFIX = "accepted-run-reattach"
CONTROL_RELATIVE_PREFIX = "runtime-control/" + RUNTIME_RELATIVE_PREFIX
TERMINAL_PROCESS_ARCHIVE_NAME = "terminal-process.json"
TERMINAL_OWNER_ARCHIVE_NAME = "terminal-owner.json"

MAX_STORE_RECORD_BYTES = 2 * 1024 * 1024
MAX_CONTROL_RECORD_BYTES = 512 * 1024
MAX_PROOF_BYTES = 256 * 1024
MAX_REQUEST_BYTES = 64 * 1024
MAX_RUN_DISCOVERY = 128
MAX_TASKS = 4096
MAX_TEXT = 4096

ATTEMPT_RE = re.compile(r"^[0-9a-f]{32}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
CONTAINER_ID_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
PORTABLE_ID_RE = re.compile(r"^[^/\\\x00\r\n\t]{1,256}$")
PROJECT_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
VOLUME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]*$")


def _fail(message: str) -> BuildControlError:
    return BuildControlError(message)


def _hash(value: object, label: str) -> str:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        raise _fail(f"{label} is not a lowercase SHA-256")
    if set(value) == {"0"}:
        raise _fail(f"{label} is an all-zero placeholder")
    return value


def _attempt(value: object, label: str) -> str:
    if not isinstance(value, str) or ATTEMPT_RE.fullmatch(value) is None:
        raise _fail(f"{label} is not an operation token")
    return value


def _container(value: object, label: str) -> str:
    if not isinstance(value, str) or CONTAINER_ID_RE.fullmatch(value) is None:
        raise _fail(f"{label} is not a container identity")
    if set(value) == {"0"}:
        raise _fail(f"{label} is an all-zero placeholder")
    return value


def _image(value: object, label: str) -> str:
    if not isinstance(value, str) or IMAGE_ID_RE.fullmatch(value) is None:
        raise _fail(f"{label} is not an immutable image identity")
    if set(value[7:]) == {"0"}:
        raise _fail(f"{label} is an all-zero placeholder")
    return value


def _namespace_attestation_relative(backend_id: object) -> str:
    backend = _container(backend_id, "stopped namespace backend")
    return "verification/stopped-namespace-attestation-" + backend + ".json"


def _terminal_archive_relative(key: str, name: str) -> str:
    _hash(key, "accepted reattach archive key")
    return f"{RUNTIME_RELATIVE_PREFIX}/{key}/{name}"


def _text(value: object, label: str, *, maximum: int = MAX_TEXT) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum or "\x00" in value:
        raise _fail(f"{label} is not bounded text")
    return value


def _portable_id(value: object, label: str) -> str:
    if (not isinstance(value, str) or PORTABLE_ID_RE.fullmatch(value) is None
            or value in {".", ".."} or ":" in value
            or any(ord(character) < 32 or ord(character) == 127 for character in value)):
        raise _fail(f"{label} is not a portable identifier")
    return value


def _json_bytes(value: Mapping[str, object], maximum: int, label: str) -> bytes:
    try:
        raw = canonical(value) + b"\n"
    except (TypeError, ValueError) as error:
        raise _fail(f"{label} is not canonical JSON") from error
    if len(raw) > maximum:
        raise _fail(f"{label} exceeds its size bound")
    return raw


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _decode_json(raw: bytes, label: str) -> dict[str, object]:
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise _fail(f"{label} is not valid JSON") from error
    if not isinstance(value, dict):
        raise _fail(f"{label} is not a JSON object")
    return value


def _relative_path(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise _fail(f"{label} is not a bounded relative path")
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or str(path) != value
        or ".." in path.parts
        or "\\" in value
        or ":" in value
        or any(part in {"", "."} for part in path.parts)
    ):
        raise _fail(f"{label} escapes its control root")
    return value


def _control_bytes(
    control: BuildControl,
    relative: str,
    *,
    optional: bool = False,
    maximum: int = MAX_CONTROL_RECORD_BYTES,
) -> bytes | None:
    """Read one bounded, immutable control-volume record.

    A tiny ``read_raw`` hook is accepted for source-level fixture tests.  The
    production BuildControl path always uses its image-owned helper and never
    reads the control volume through a host filesystem path.
    """

    relative = _relative_path(relative, "control record")
    read_raw = getattr(control, "read_raw", None)
    if callable(read_raw):
        try:
            raw = read_raw(relative, optional=optional)
        except FileNotFoundError:
            if optional:
                return None
            raise _fail(f"control record {relative} is missing")
        if raw is None:
            return None
        if not isinstance(raw, bytes) or len(raw) > maximum:
            raise _fail(f"control record {relative} exceeds its size bound")
        return raw

    path = control.path(relative)
    script = control_read_script(path, maximum=maximum)
    result = bounded_capture(control.helper_args(script), data=b"", timeout=90)
    if optional and result.returncode == 44:
        return None
    if result.returncode:
        detail = result.stderr.decode("utf-8", "replace")[-2048:]
        raise _fail(f"cannot read control record {relative}: {detail}")
    if len(result.stdout) > maximum:
        raise _fail(f"control record {relative} exceeds its size bound")
    return bytes(result.stdout)


def _control_json(control: BuildControl, relative: str, *, optional: bool = False) -> tuple[dict[str, object] | None, bytes | None]:
    raw = _control_bytes(control, relative, optional=optional)
    if raw is None:
        return None, None
    return _decode_json(raw, f"control record {relative}"), raw


def _safe_store_root(store_root: Path) -> Path:
    try:
        root = Path(store_root)
    except (TypeError, ValueError) as error:
        raise _fail("accepted store root is not a path") from error
    if not root.is_absolute() or ".." in root.parts or root.is_symlink():
        raise _fail("accepted store root must be absolute and bounded")
    try:
        root = root.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise _fail("accepted store root cannot be resolved") from error
    if root.is_symlink() or not root.is_dir():
        raise _fail("accepted store root is not a regular directory")
    return root


def _read_store_regular(
    root: Path,
    relative: str,
    label: str,
    *,
    maximum: int = MAX_STORE_RECORD_BYTES,
    optional: bool = False,
) -> bytes | None:
    """Read a store record with component-wise NOFOLLOW checks.

    The producer has no store writer.  This helper intentionally reads only
    named records below the selected run and never walks arbitrary output
    trees.  Rust repeats the authoritative SessionStore validation afterwards.
    """

    path = PurePosixPath(relative)
    if path.is_absolute() or ".." in path.parts or any(part in {"", "."} for part in path.parts):
        raise _fail(f"{label} path escapes the accepted store")
    root = _safe_store_root(root)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    parts = list(path.parts)
    if not parts:
        raise _fail(f"{label} path is empty")

    # The controller can run from native Windows, where ``dir_fd`` and
    # ``O_DIRECTORY`` are unavailable.  Keep the same bounded regular-file
    # checks there and reject every visible symlink component before opening.
    if os.name == "nt":
        candidate = root
        for component in parts:
            candidate /= component
            if candidate.is_symlink():
                raise _fail(f"{label} path contains a symlink")
        file_descriptor = None
        try:
            file_descriptor = os.open(str(candidate), flags | getattr(os, "O_BINARY", 0))
            stat_result = os.fstat(file_descriptor)
            if not stat.S_ISREG(stat_result.st_mode):
                raise _fail(f"{label} is not a regular file")
            if stat_result.st_size > maximum:
                raise _fail(f"{label} exceeds its size bound")
            chunks: list[bytes] = []
            total = 0
            while total <= maximum:
                chunk = os.read(file_descriptor, min(65536, maximum + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
            if total > maximum:
                raise _fail(f"{label} exceeds its size bound")
            return b"".join(chunks)
        except FileNotFoundError as error:
            if optional:
                return None
            raise _fail(f"{label} is missing") from error
        except OSError as error:
            raise _fail(f"{label} cannot be read safely") from error
        finally:
            if file_descriptor is not None:
                os.close(file_descriptor)

    directory_flags = flags | getattr(os, "O_DIRECTORY", 0)
    descriptor: int | None = None
    try:
        descriptor = os.open(root, directory_flags)
        for component in parts[:-1]:
            child = os.open(component, directory_flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        if not parts:
            raise _fail(f"{label} path is empty")
        file_descriptor = os.open(parts[-1], flags, dir_fd=descriptor)
        try:
            stat_result = os.fstat(file_descriptor)
            if not stat.S_ISREG(stat_result.st_mode):
                raise _fail(f"{label} is not a regular file")
            if stat_result.st_size > maximum:
                raise _fail(f"{label} exceeds its size bound")
            chunks: list[bytes] = []
            total = 0
            while total <= maximum:
                chunk = os.read(file_descriptor, min(65536, maximum + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
            if total > maximum:
                raise _fail(f"{label} exceeds its size bound")
            return b"".join(chunks)
        finally:
            os.close(file_descriptor)
    except FileNotFoundError as error:
        if optional:
            return None
        raise _fail(f"{label} is missing") from error
    except OSError as error:
        raise _fail(f"{label} cannot be read safely") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _read_store_json(root: Path, relative: str, label: str) -> tuple[dict[str, object], bytes]:
    raw = _read_store_regular(root, relative, label)
    return _decode_json(raw, label), raw


def _assert_control_identity(control: BuildControl) -> tuple[str, str]:
    project = getattr(control, "project", None)
    volume = getattr(control, "volume", None)
    if not isinstance(project, str) or PROJECT_RE.fullmatch(project) is None:
        raise _fail("selected Compose project identity is invalid")
    if not isinstance(volume, str) or VOLUME_RE.fullmatch(volume) is None:
        raise _fail("selected control volume identity is invalid")
    return project, volume


def _validate_unresolved(control: BuildControl, value: Mapping[str, object]) -> dict[str, object]:
    project, volume = _assert_control_identity(control)
    required = {
        "schema": "fullmag.docker-activation-unresolved.v1",
        "state": "unknown-retained",
        "phase": "activation",
        "activation_outcome": "unknown-retained",
        "reason": "backend-namespace-stopped",
        "compose_project": project,
        "control_volume": volume,
    }
    if any(value.get(key) != expected for key, expected in required.items()):
        raise _fail("retained activation quarantine identity/state differs")
    activation_attempt = _attempt(value.get("activation_attempt"), "activation attempt")
    development_attempt = _attempt(value.get("development_attempt"), "development attempt")
    reconciliation_attempt = _attempt(value.get("reconciliation_attempt"), "reconciliation attempt")
    backend = _container(value.get("backend_container"), "backend container")
    image = _image(value.get("image_id"), "backend image")
    config = _hash(value.get("config_sha256"), "configuration digest")
    source_sha = _hash(value.get("source_sha256"), "source digest")
    provenance_sha = _hash(value.get("provenance_sha256"), "startup provenance digest")
    activation_sha = _hash(value.get("activation_receipt_sha256"), "activation receipt digest")
    stop_sha = _hash(value.get("native_stop_journal_sha256"), "stop journal digest")
    key = _hash(value.get("activation_receipt_key"), "activation receipt key")
    request_id = value.get("request_id")
    if not isinstance(request_id, str) or REQUEST_ID_RE.fullmatch(request_id) is None:
        raise _fail("retained activation request id is invalid")
    if key != hashlib.sha256(request_id.encode("utf-8")).hexdigest():
        raise _fail("activation receipt key is not bound to the request id")
    expected_marker = "/opt/fullmag/control/backend/script-activation-" + key + "/activation.json"
    if value.get("activation_receipt_path") != expected_marker:
        raise _fail("activation receipt path differs from its request key")
    source_root = _text(value.get("source_root"), "source root")
    source_relative = _relative_path(value.get("source_relative"), "source relative path")
    if value.get("helper_container") != "fullmag-control-" + activation_attempt:
        raise _fail("retained activation helper identity differs from its attempt")
    if value.get("helper_state") != "absent-confirmed" or value.get("helper_id") is not None:
        raise _fail("reattach requires an absent, reconciled activation helper")
    _hash(value.get("helper_sha256"), "activation helper digest")
    _hash(value.get("helper_absence_probe_sha256"), "helper absence probe digest")
    created_at = value.get("created_at")
    if not isinstance(created_at, (int, float)) or isinstance(created_at, bool):
        raise _fail("retained activation quarantine has no valid creation timestamp")
    return {
        **dict(value),
        "activation_attempt": activation_attempt,
        "development_attempt": development_attempt,
        "reconciliation_attempt": reconciliation_attempt,
        "backend_container": backend,
        "image_id": image,
        "config_sha256": config,
        "source_sha256": source_sha,
        "provenance_sha256": provenance_sha,
        "activation_receipt_sha256": activation_sha,
        "native_stop_journal_sha256": stop_sha,
        "activation_receipt_key": key,
        "request_id": request_id,
        "source_root": source_root,
        "source_relative": source_relative,
    }


def _validate_activation_receipt(
    control: BuildControl,
    record: Mapping[str, object],
    raw: bytes,
    unresolved: Mapping[str, object],
) -> dict[str, object]:
    project, volume = _assert_control_identity(control)
    expected = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "activation",
        "state": "outcome-unknown-resources-retained",
        "attempt": unresolved["activation_attempt"],
        "compose_project": project,
        "control_volume": volume,
    }
    if any(record.get(key) != value for key, value in expected.items()):
        raise _fail("original activation receipt is not the retained unknown record")
    if record.get("helper_container") != "fullmag-control-" + str(unresolved["activation_attempt"]):
        raise _fail("original activation helper identity differs from its activation")
    if record.get("helper_sha256") != unresolved.get("helper_sha256"):
        raise _fail("original activation helper digest differs from quarantine")
    if not isinstance(record.get("helper_sha256"), str) or SHA256_RE.fullmatch(record["helper_sha256"]) is None:
        raise _fail("original activation helper digest is missing")
    for field in ("started_at", "finished_at"):
        timestamp = record.get(field)
        if not isinstance(timestamp, (int, float)) or isinstance(timestamp, bool):
            raise _fail("original activation receipt has no valid " + field)
    _text(record.get("error"), "original activation failure")
    if hashlib.sha256(raw).hexdigest() != unresolved["activation_receipt_sha256"]:
        raise _fail("original activation receipt digest differs from quarantine")
    inputs = record.get("inputs")
    if not isinstance(inputs, Mapping):
        raise _fail("original activation receipt has no immutable inputs")
    expected_inputs = {
        "development_attempt": unresolved["development_attempt"],
        "config_sha256": unresolved["config_sha256"],
        "source_root": unresolved["source_root"],
        "image_id": unresolved["image_id"],
        "backend_container": unresolved["backend_container"],
        "source_relative": unresolved["source_relative"],
        "source_sha256": unresolved["source_sha256"],
        "request_id": unresolved["request_id"],
        "provenance_sha256": unresolved["provenance_sha256"],
        "activation_receipt_key": unresolved["activation_receipt_key"],
        "activation_receipt_path": unresolved["activation_receipt_path"],
    }
    for key, expected_value in expected_inputs.items():
        if inputs.get(key) != expected_value:
            raise _fail("original activation input differs from quarantine: " + key)
    return dict(record)


def _validate_startup_provenance(
    raw: bytes,
    unresolved: Mapping[str, object],
) -> dict[str, object]:
    """Bind the original authorization bytes to the retained activation."""

    expected_sha256 = unresolved["provenance_sha256"]
    if hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise _fail("original startup provenance digest differs from quarantine")
    value = _decode_json(raw, "original startup provenance")
    expected = {
        "schema": "fullmag.docker-startup-script.v1",
        "authorization": "explicit_startup_script",
        "source_root": unresolved["source_root"],
        "source_relative": unresolved["source_relative"],
        "source_sha256": unresolved["source_sha256"],
        "request_id": unresolved["request_id"],
    }
    if any(value.get(key) != expected_value for key, expected_value in expected.items()):
        raise _fail("original startup provenance differs from activation inputs")
    return value


def _validate_reconciliation(
    control: BuildControl,
    record: Mapping[str, object],
    raw: bytes,
    unresolved: Mapping[str, object],
) -> dict[str, object]:
    project, volume = _assert_control_identity(control)
    expected = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "activation-reconciliation",
        "state": "failed-confirmed",
        "attempt": unresolved["reconciliation_attempt"],
        "compose_project": project,
        "control_volume": volume,
        "reconciled_activation_attempt": unresolved["activation_attempt"],
        "activation_receipt_sha256": unresolved["activation_receipt_sha256"],
        "backend_container": unresolved["backend_container"],
        "image_id": unresolved["image_id"],
        "development_attempt": unresolved["development_attempt"],
        "config_sha256": unresolved["config_sha256"],
        "source_root": unresolved["source_root"],
        "native_stop_journal_sha256": unresolved["native_stop_journal_sha256"],
        "activation_outcome": "unknown-retained",
        "reason": "backend-namespace-stopped",
        "helper_container": "fullmag-control-" + str(unresolved["activation_attempt"]),
        "helper_id": None,
        "helper_state": "absent-confirmed",
    }
    if any(record.get(key) != value for key, value in expected.items()):
        raise _fail("terminal activation reconciliation differs from quarantine")
    if record.get("helper_sha256") != unresolved.get("helper_sha256"):
        raise _fail("terminal activation helper digest differs from quarantine")
    if record.get("helper_absence_probe_sha256") != unresolved.get("helper_absence_probe_sha256"):
        raise _fail("terminal activation helper absence proof differs from quarantine")
    _hash(record.get("helper_sha256"), "terminal activation helper digest")
    _hash(record.get("helper_absence_probe_sha256"), "terminal helper absence proof")
    if not raw:
        raise _fail("terminal activation reconciliation is empty")
    return dict(record)


def _validate_stop_journal(
    record: Mapping[str, object], raw: bytes, unresolved: Mapping[str, object]
) -> dict[str, object]:
    if hashlib.sha256(raw).hexdigest() != unresolved["native_stop_journal_sha256"]:
        raise _fail("stopped-backend journal digest differs from quarantine")
    if (
        record.get("schema") != "fullmag.stop-failed-admission.v1"
        or record.get("state") != "stopped-confirmed"
        or record.get("container_id") != unresolved["backend_container"]
        or record.get("image_id") != unresolved["image_id"]
    ):
        raise _fail("stopped-backend journal is not the exact stopped backend proof")
    container_state = record.get("container_state")
    if "container_state" in record and not isinstance(container_state, Mapping):
        raise _fail("stopped-backend journal has an invalid namespace attestation")
    exit_code = record.get("exit_code")
    if type(exit_code) is not int:
        raise _fail("stopped-backend journal has no integer exit code")
    if isinstance(container_state, Mapping) and (
        container_state.get("id") != unresolved["backend_container"]
        or container_state.get("image") != unresolved["image_id"]
        or not isinstance(container_state.get("started_at"), str)
        or not container_state.get("started_at")
        or not isinstance(container_state.get("finished_at"), str)
        or not container_state.get("finished_at")
        or type(container_state.get("exit_code")) is not int
        or exit_code != container_state.get("exit_code")
    ):
        raise _fail("stopped-backend namespace attestation identity is incomplete")
    failure = record.get("failure_receipt")
    if not isinstance(failure, Mapping):
        raise _fail("stopped-backend journal has no failed process receipt")
    process_receipt = failure.get("receipt")
    process_receipt_sha256 = failure.get("sha256")
    if not isinstance(process_receipt, Mapping):
        raise _fail("stopped-backend journal has no nested failed process receipt")
    if (
        process_receipt.get("schema") != "fullmag.docker-process-tree.v1"
        or process_receipt.get("state") != "failed_outcome_retained"
        or process_receipt.get("runtime_pid") is not None
        or failure.get("api_pid_exists") is not False
    ):
        raise _fail("stopped-backend journal retains a live runtime")
    probe = record.get("native_failure_probe")
    if not isinstance(probe, Mapping):
        raise _fail("stopped-backend journal has no native failure probe")
    if (
        any(probe.get(field) is not False for field in (
            "api_pid_exists",
            "owner_pid_exists",
            "child_pids_exist",
            "native_processes_live",
        ))
        or type(probe.get("active_lease_count")) is not int
        or probe.get("active_lease_count") != 0
    ):
        raise _fail("stopped-backend native failure probe is not terminal")
    for field in ("reservation_states", "lease_states"):
        values = probe.get(field)
        if not isinstance(values, list) or any(value != "released" for value in values):
            raise _fail("stopped-backend native failure probe retains " + field)
    failure_kind = record.get("failure_kind")
    if failure_kind not in {"native-start-failure", "native-after-ready-failure"}:
        raise _fail("stopped-backend journal has no typed native failure kind")
    if not isinstance(process_receipt_sha256, str) or SHA256_RE.fullmatch(process_receipt_sha256) is None:
        raise _fail("stopped-backend journal has no process receipt digest")
    if probe.get("process_receipt") != process_receipt or probe.get("process_receipt_sha256") != process_receipt_sha256:
        raise _fail("stopped-backend process receipt differs from its native probe")
    try:
        from docker_volume_stop_failed import (
            _validate_native_after_ready_failure_probe,
            _validate_native_failure_probe,
        )

        if failure_kind == "native-start-failure":
            native = _validate_native_failure_probe(probe, process_receipt_sha256)
        else:
            native = _validate_native_after_ready_failure_probe(probe, process_receipt_sha256)
    except (ImportError, BuildControlError) as error:
        raise _fail("stopped-backend native failure evidence is not authoritative") from error
    failed_owner = native["failed_owner"]
    failed_owner_sha = probe.get("failed_owner_sha256")
    # The native probe hashes raw OWNER.json bytes, which may be pretty JSON.
    # The separate control-record validator compares those exact bytes with
    # both digest pins; re-encoding this parsed object would change the hash.
    if not isinstance(failed_owner_sha, str) or SHA256_RE.fullmatch(failed_owner_sha) is None:
        raise _fail("stopped-backend failed owner digest is missing or invalid")
    if record.get("terminal_failed_owner") != failed_owner:
        raise _fail("stopped-backend terminal failed owner differs from its probe")
    terminal_failed_owner_sha = record.get("terminal_failed_owner_sha256")
    if not isinstance(terminal_failed_owner_sha, str) or SHA256_RE.fullmatch(terminal_failed_owner_sha) is None:
        raise _fail("stopped-backend terminal failed owner digest is missing")
    if terminal_failed_owner_sha != failed_owner_sha:
        raise _fail("stopped-backend failed owner digest changed during terminalization")
    terminal = record.get("terminal_process_receipt")
    if not isinstance(terminal, Mapping):
        raise _fail("stopped-backend journal has no terminal process receipt")
    if (
        terminal.get("schema") != "fullmag.docker-process-tree.v1"
        or terminal.get("state") != "shutdown_unknown"
        or type(terminal.get("api_exit_code")) is not int
        or terminal.get("runtime_pid") is not None
        or "startup_activation" in terminal
        or "terminal_service_owner" in terminal
    ):
        raise _fail("stopped-backend terminal process receipt retains an owner")
    if failure_kind == "native-start-failure":
        if "service_owner" in terminal or "terminal_service_owner" in terminal:
            raise _fail("native start-failure terminal receipt retains an owner")
    else:
        ready_owner = native["ready_owner"]
        if terminal.get("service_owner") != ready_owner:
            raise _fail("after-ready terminal receipt lost the retained ready owner")
        if record.get("retained_ready_owner") != ready_owner:
            raise _fail("after-ready journal lost the retained ready owner")
        if record.get("terminal_retained_ready_owner") != ready_owner:
            raise _fail("after-ready terminal owner differs from its journal pin")
        ready_owner_sha = record.get("retained_ready_owner_sha256")
        accepted_ready_digests = {
            hashlib.sha256(canonical(ready_owner)).hexdigest(),
            hashlib.sha256(canonical(ready_owner) + b"\n").hexdigest(),
        }
        if (not isinstance(ready_owner_sha, str) or SHA256_RE.fullmatch(ready_owner_sha) is None
                or ready_owner_sha not in accepted_ready_digests):
            raise _fail("after-ready retained owner digest differs")
    return dict(record)


def _validate_namespace_attestation(
    control: BuildControl,
    record: Mapping[str, object],
    raw: bytes,
    *,
    unresolved: Mapping[str, object],
    journal: Mapping[str, object],
    journal_raw: bytes,
    terminal: Mapping[str, object],
    terminal_raw: bytes,
    owner: Mapping[str, object],
    owner_raw: bytes,
) -> dict[str, object]:
    """Validate the fresh typed namespace sidecar against retained records.

    A legacy stop journal may lack ``container_state``.  The sidecar is the
    only accepted source for that incarnation in that case, and the journal
    bytes remain immutable.  The sidecar still has to bind the complete native
    owner chain already authenticated by ``_validate_stop_journal``.
    """

    project, volume = _assert_control_identity(control)
    backend = _container(unresolved.get("backend_container"), "stopped namespace backend")
    image = _image(unresolved.get("image_id"), "stopped namespace image")
    source_root = _text(unresolved.get("source_root"), "stopped namespace source")
    expected = {
        "schema": NAMESPACE_ATTESTATION_SCHEMA,
        "state": "stopped-confirmed",
        "compose_project": project,
        "control_volume": volume,
        "backend_container": backend,
        "image_id": image,
        "source_root": source_root,
        "stop_journal_path": "verification/stop-failed-" + backend + ".json",
        "terminal_process_receipt_path": "runtime-control/runtime-service/process-tree.json",
        "terminal_failed_owner_path": "runtime-control/runtime-services/OWNER.json",
    }
    if any(record.get(key) != expected_value for key, expected_value in expected.items()):
        raise _fail("stopped namespace attestation identity/state differs")
    if hashlib.sha256(journal_raw).hexdigest() != unresolved.get("native_stop_journal_sha256"):
        raise _fail("stopped namespace attestation journal input differs from quarantine")
    for field, expected_digest, label in (
        ("stop_journal_sha256", hashlib.sha256(journal_raw).hexdigest(), "stopped namespace journal"),
        ("terminal_process_receipt_sha256", hashlib.sha256(terminal_raw).hexdigest(), "stopped namespace process receipt"),
        ("terminal_failed_owner_sha256", hashlib.sha256(owner_raw).hexdigest(), "stopped namespace failed owner"),
    ):
        if _hash(record.get(field), label) != expected_digest:
            raise _fail(label + " digest differs")
    if _hash(journal.get("terminal_failed_owner_sha256"), "journal terminal failed owner") != hashlib.sha256(owner_raw).hexdigest():
        raise _fail("journal terminal failed owner digest differs from its control record")

    container_state = record.get("container_state")
    if not isinstance(container_state, Mapping):
        raise _fail("stopped namespace attestation has no container incarnation")
    if (
        container_state.get("id") != backend
        or container_state.get("image") != image
        or not isinstance(container_state.get("started_at"), str)
        or not container_state.get("started_at")
        or not isinstance(container_state.get("finished_at"), str)
        or not container_state.get("finished_at")
        or type(container_state.get("exit_code")) is not int
    ):
        raise _fail("stopped namespace attestation container incarnation is incomplete")
    journal_state = journal.get("container_state")
    if journal_state is not None and (
        not isinstance(journal_state, Mapping) or dict(journal_state) != dict(container_state)
    ):
        raise _fail("stopped namespace attestation differs from journal incarnation")
    journal_exit_code = journal.get("exit_code")
    if type(journal_exit_code) is not int:
        raise _fail("stopped namespace journal has no integer exit code")
    if container_state.get("exit_code") != journal_exit_code:
        raise _fail("stopped namespace attestation exit code differs from journal")

    if record.get("terminal_process_receipt") != dict(terminal):
        raise _fail("stopped namespace terminal process receipt differs")
    if journal.get("terminal_process_receipt") != dict(terminal):
        raise _fail("stopped namespace terminal process receipt differs from journal")
    if record.get("terminal_failed_owner") != dict(owner):
        raise _fail("stopped namespace terminal failed owner differs")
    if journal.get("terminal_failed_owner") != dict(owner):
        raise _fail("stopped namespace terminal failed owner differs from journal")

    failure_kind = journal.get("failure_kind")
    if failure_kind not in {"native-start-failure", "native-after-ready-failure"}:
        raise _fail("stopped namespace journal has no typed native failure kind")
    if record.get("failure_kind") != failure_kind:
        raise _fail("stopped namespace failure kind differs from journal")
    probe = journal.get("native_failure_probe")
    if not isinstance(probe, Mapping) or record.get("native_failure_probe") != dict(probe):
        raise _fail("stopped namespace native failure proof differs from journal")
    probe_raw = _json_bytes(probe, MAX_CONTROL_RECORD_BYTES, "stopped namespace native failure probe")
    if _hash(record.get("native_failure_probe_sha256"), "stopped namespace native failure probe") != hashlib.sha256(probe_raw).hexdigest():
        raise _fail("stopped namespace native failure probe digest differs")
    if record.get("terminal_failed_owner") != probe.get("failed_owner"):
        raise _fail("stopped namespace failed owner differs from native proof")
    if failure_kind == "native-after-ready-failure":
        if record.get("retained_ready_owner") != journal.get("retained_ready_owner"):
            raise _fail("stopped namespace retained ready owner differs")
    elif "retained_ready_owner" in record:
        raise _fail("start-failure namespace attestation contains a ready owner")
    created_at = record.get("created_at")
    if (not isinstance(created_at, (int, float)) or isinstance(created_at, bool)
            or (isinstance(created_at, float) and not math.isfinite(created_at))):
        raise _fail("stopped namespace attestation has no valid creation timestamp")
    if not raw:
        raise _fail("stopped namespace attestation is empty")
    return dict(record)


def _validate_terminal_control_records(
    journal: Mapping[str, object],
    terminal: Mapping[str, object],
    terminal_raw: bytes,
    owner: Mapping[str, object],
    owner_raw: bytes,
) -> None:
    """Bind the live control records to the stop journal's terminal pins.

    A current stop journal carries the complete container incarnation in its
    own immutable bytes, so a namespace sidecar is optional for that route.
    The terminal process and failed-owner records remain separate control
    records and must still be read and matched byte-for-byte through their
    journal snapshots.  This preserves the native owner-chain check for both
    the current and historical journal formats.
    """

    expected_terminal = journal.get("terminal_process_receipt")
    if not isinstance(expected_terminal, Mapping) or dict(terminal) != dict(expected_terminal):
        raise _fail("stopped-backend terminal process receipt differs from its control record")

    expected_owner = journal.get("terminal_failed_owner")
    if not isinstance(expected_owner, Mapping) or dict(owner) != dict(expected_owner):
        raise _fail("stopped-backend terminal failed owner differs from its control record")

    owner_sha256 = hashlib.sha256(owner_raw).hexdigest()
    if (
        _hash(journal.get("terminal_failed_owner_sha256"), "journal terminal failed owner")
        != owner_sha256
    ):
        raise _fail("journal terminal failed owner digest differs from its control record")
    probe = journal.get("native_failure_probe")
    if not isinstance(probe, Mapping):
        raise _fail("stopped-backend journal has no native failure probe")
    if _hash(probe.get("failed_owner_sha256"), "native failed owner") != owner_sha256:
        raise _fail("native failed owner digest differs from its control record")
    if probe.get("failed_owner") != dict(owner):
        raise _fail("native failed owner differs from its control record")

    # The journal validator already proves the terminal receipt shape and the
    # after-ready retained-owner relation.  Keep this final check explicit so
    # the strict-journal path cannot drop those checks when no sidecar exists.
    if not terminal_raw or not owner_raw:
        raise _fail("stopped-backend terminal control records are empty")


def _validate_held_run(
    store_root: Path,
    run_id: str,
    source_request_id: str,
    source_sha256: str,
) -> dict[str, object]:
    run_id = _portable_id(run_id, "run id")
    run_relative = PurePosixPath("runs") / run_id
    intent, _intent_raw = _read_store_json(
        store_root, str(run_relative / "run_intent.json"), "accepted RunIntent"
    )
    if intent.get("schema_version") != "run_intent.v1" or intent.get("run_id") != run_id:
        raise _fail("accepted RunIntent schema/identity differs")
    expected_key = "live-http-" + hashlib.sha256(source_request_id.encode("utf-8")).hexdigest()
    if intent.get("idempotency_key") != expected_key:
        raise _fail("accepted RunIntent idempotency key differs from startup request")
    specification = intent.get("specification")
    if not isinstance(specification, Mapping):
        raise _fail("accepted RunIntent specification is missing")
    if hashlib.sha256(canonical(specification)).hexdigest() != intent.get("payload_sha256"):
        raise _fail("accepted RunIntent payload digest differs")
    if specification.get("schema_version") != "run_spec.v2" or specification.get("run_id") != run_id:
        raise _fail("accepted RunSpecification schema/identity differs")
    snapshot = specification.get("snapshot")
    if not isinstance(snapshot, Mapping):
        raise _fail("accepted RunSpecification snapshot is missing")
    project_id = _portable_id(snapshot.get("project_id"), "project id")
    parameters = specification.get("parameters")
    if not isinstance(parameters, Mapping):
        raise _fail("accepted RunSpecification parameters are missing")
    policy = parameters.get("fullmag.accepted_run_start")
    if not isinstance(policy, Mapping) or policy.get("schema_version") != "accepted_run_start_policy.v1" or policy.get("mode") != "manual":
        raise _fail("accepted run is not held by the manual start gate")
    live = parameters.get("live_workspace")
    if not isinstance(live, Mapping):
        raise _fail("accepted RunSpecification live_workspace binding is missing")
    session_id = _text(live.get("session_id"), "logical session id")
    session_epoch = live.get("session_epoch")
    if isinstance(session_epoch, bool) or not isinstance(session_epoch, int) or session_epoch <= 0:
        raise _fail("accepted live_workspace session_epoch is not positive")
    if live.get("request_idempotency_key") != source_request_id:
        raise _fail("accepted live_workspace request binding differs")
    if live.get("startup_source_sha256") != source_sha256:
        raise _fail("accepted live_workspace source binding differs")
    scene_revision = live.get("scene_revision")
    definition_revision = snapshot.get("definition_revision")
    if (isinstance(scene_revision, bool) or not isinstance(scene_revision, int) or scene_revision < 0
            or isinstance(definition_revision, bool) or not isinstance(definition_revision, int)
            or definition_revision < 0 or scene_revision != definition_revision):
        raise _fail("accepted live_workspace scene revision differs from its snapshot")
    command = live.get("command")
    if (live.get("command_id") != source_request_id or not isinstance(command, Mapping)
            or command.get("kind") != "startup_script"
            or command.get("request_id") != source_request_id
            or command.get("source_sha256") != source_sha256):
        raise _fail("accepted live_workspace startup command differs")
    catalog, _catalog_raw = _read_store_json(
        store_root, str(run_relative / "run_catalog.json"), "accepted run catalog"
    )
    if catalog.get("schema_version") != "run_catalog.v1" or catalog.get("run_id") != run_id:
        raise _fail("accepted run catalog schema/identity differs")
    revision = catalog.get("revision")
    tasks = catalog.get("tasks")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision <= 0 or not isinstance(tasks, list) or not tasks or len(tasks) > MAX_TASKS:
        raise _fail("accepted run catalog is missing bounded tasks")
    task_ids: set[str] = set()
    for task in tasks:
        if not isinstance(task, Mapping):
            raise _fail("accepted run catalog task is malformed")
        task_id = _portable_id(task.get("task_id"), "accepted task id")
        if task_id in task_ids:
            raise _fail("accepted run catalog contains duplicate task identity")
        task_ids.add(task_id)
        readiness = task.get("readiness")
        if task.get("lifecycle") != "accepted" or not isinstance(readiness, Mapping) or readiness.get("state") != "blocked" or not isinstance(readiness.get("reason"), str) or not readiness["reason"]:
            raise _fail("accepted run catalog is no longer held/blocked")
    start_release_raw = _read_store_regular(
        store_root,
        str(run_relative / "start_release.json"),
        "accepted run start release",
        optional=True,
    )
    if start_release_raw is not None:
        raise _fail("accepted run start gate has already been released")
    return {
        "run_id": run_id,
        "project_id": project_id,
        "logical_session_id": session_id,
        "session_epoch": session_epoch,
        "catalog_revision": revision,
        "task_count": len(tasks),
        "specification_sha256": intent.get("payload_sha256"),
    }


def _discover_run_id(store_root: Path, source_request_id: str, explicit_run_id: str | None) -> str:
    if explicit_run_id is not None:
        return _portable_id(explicit_run_id, "explicit run id")
    root = _safe_store_root(store_root)
    runs = root / "runs"
    try:
        if runs.is_symlink() or not runs.is_dir():
            raise _fail("accepted store runs root is invalid")
        entries: list[os.DirEntry[str]] = []
        with os.scandir(runs) as iterator:
            for entry in iterator:
                if len(entries) >= MAX_RUN_DISCOVERY:
                    raise _fail("accepted run discovery exceeds its bounded candidate count")
                entries.append(entry)
    except OSError as error:
        raise _fail("accepted store runs root cannot be enumerated safely") from error
    matches: list[str] = []
    expected_key = "live-http-" + hashlib.sha256(source_request_id.encode("utf-8")).hexdigest()
    for entry in entries:
        if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
            raise _fail("accepted store runs root contains an invalid entry")
        run_id = _portable_id(entry.name, "discovered run id")
        intent_path = Path(entry.path) / "run_intent.json"
        if intent_path.is_symlink():
            raise _fail("accepted store candidate RunIntent is a symlink")
        if not intent_path.exists():
            # A bounded run inventory may contain unrelated directories, but
            # a present record is always parsed and validated fail-closed.
            continue
        intent, _raw = _read_store_json(
            store_root, f"runs/{run_id}/run_intent.json", "candidate RunIntent"
        )
        if intent.get("idempotency_key") == expected_key:
            matches.append(run_id)
    if len(matches) != 1:
        if not matches:
            raise _fail("no accepted run matches the original startup request")
        raise _fail("multiple accepted runs match the original startup request")
    return matches[0]


def _bundle_from_records(
    control: BuildControl,
    *,
    store_root: Path,
    run_id: str | None = None,
) -> dict[str, object]:
    project, volume = _assert_control_identity(control)
    unresolved, unresolved_raw = _control_json(control, "activation/unresolved.json")
    assert unresolved is not None and unresolved_raw is not None
    quarantine = _validate_unresolved(control, unresolved)
    activation_relative = "activation/attempts/{}/receipt.json".format(quarantine["activation_attempt"])
    activation, activation_raw = _control_json(control, activation_relative)
    assert activation is not None and activation_raw is not None
    _validate_activation_receipt(control, activation, activation_raw, quarantine)
    provenance_relative = "activation/attempts/{}/startup-provenance.json".format(
        quarantine["activation_attempt"]
    )
    provenance_raw = _control_bytes(control, provenance_relative)
    assert provenance_raw is not None
    _validate_startup_provenance(provenance_raw, quarantine)
    authorization_relative = "activation/attempts/{}/authorization.json".format(
        quarantine["activation_attempt"]
    )
    authorization_raw = _control_bytes(control, authorization_relative)
    authorization = _decode_json(authorization_raw, "original startup authorization")
    provenance = _decode_json(provenance_raw, "original startup provenance")
    if authorization != provenance:
        raise _fail("original startup authorization differs from its provenance bytes")
    reconciliation_relative = "activation-reconciliation/attempts/{}/terminal.json".format(quarantine["reconciliation_attempt"])
    reconciliation, reconciliation_raw = _control_json(control, reconciliation_relative)
    assert reconciliation is not None and reconciliation_raw is not None
    _validate_reconciliation(control, reconciliation, reconciliation_raw, quarantine)
    current, current_raw = _control_json(control, "activation-reconciliation/current.json")
    assert current is not None and current_raw is not None
    if current_raw != reconciliation_raw:
        raise _fail("current activation reconciliation differs from its terminal record")
    stop_relative = "verification/stop-failed-{}.json".format(quarantine["backend_container"])
    stop, stop_raw = _control_json(control, stop_relative)
    assert stop is not None and stop_raw is not None
    _validate_stop_journal(stop, stop_raw, quarantine)
    terminal_relative = "runtime-control/runtime-service/process-tree.json"
    terminal, terminal_raw = _control_json(control, terminal_relative)
    assert terminal is not None and terminal_raw is not None
    owner_relative = "runtime-control/runtime-services/OWNER.json"
    owner, owner_raw = _control_json(control, owner_relative)
    assert owner is not None and owner_raw is not None
    _validate_terminal_control_records(stop, terminal, terminal_raw, owner, owner_raw)
    namespace_relative = _namespace_attestation_relative(quarantine["backend_container"])
    namespace, namespace_raw = _control_json(control, namespace_relative, optional=True)
    has_incarnation = isinstance(stop.get("container_state"), Mapping)
    if namespace is None:
        if not has_incarnation:
            raise _fail("legacy stopped-backend journal requires a fresh namespace attestation")
    else:
        assert namespace_raw is not None
        _validate_namespace_attestation(
            control,
            namespace,
            namespace_raw,
            unresolved=quarantine,
            journal=stop,
            journal_raw=stop_raw,
            terminal=terminal,
            terminal_raw=terminal_raw,
            owner=owner,
            owner_raw=owner_raw,
        )
    reconciliation_namespace_path = reconciliation.get("namespace_attestation_path")
    reconciliation_namespace_sha256 = reconciliation.get("namespace_attestation_sha256")
    if (reconciliation_namespace_path is None) != (reconciliation_namespace_sha256 is None):
        raise _fail("terminal reconciliation namespace attestation metadata is incomplete")
    if reconciliation_namespace_path is not None:
        if (
            namespace_raw is None
            or reconciliation_namespace_path != namespace_relative
            or _hash(
                reconciliation_namespace_sha256,
                "terminal reconciliation namespace attestation",
            )
            != hashlib.sha256(namespace_raw).hexdigest()
        ):
            raise _fail("terminal reconciliation namespace attestation differs")

    source_request_id = quarantine["request_id"]
    selected_run = _discover_run_id(store_root, source_request_id, run_id)
    held = _validate_held_run(store_root, selected_run, source_request_id, quarantine["source_sha256"])
    if held["project_id"] is None:
        raise _fail("accepted run has no project identity")

    key = quarantine["activation_receipt_key"]
    runtime_request = f"{RUNTIME_RELATIVE_PREFIX}/{key}/request.json"
    runtime_proof = f"{RUNTIME_RELATIVE_PREFIX}/{key}/proof.json"
    runtime_terminal_process = _terminal_archive_relative(
        key, TERMINAL_PROCESS_ARCHIVE_NAME
    )
    runtime_terminal_owner = _terminal_archive_relative(
        key, TERMINAL_OWNER_ARCHIVE_NAME
    )
    control_request = f"{CONTROL_RELATIVE_PREFIX}/{key}/request.json"
    control_proof = f"{CONTROL_RELATIVE_PREFIX}/{key}/proof.json"
    control_terminal_process = f"{CONTROL_RELATIVE_PREFIX}/{key}/{TERMINAL_PROCESS_ARCHIVE_NAME}"
    control_terminal_owner = f"{CONTROL_RELATIVE_PREFIX}/{key}/{TERMINAL_OWNER_ARCHIVE_NAME}"
    proof: dict[str, object] = {
        "schema": PROOF_SCHEMA,
        "run_id": selected_run,
        "project_id": held["project_id"],
        "source_request_id": source_request_id,
        "source_sha256": quarantine["source_sha256"],
        "startup_provenance_sha256": quarantine["provenance_sha256"],
        "activation_receipt_sha256": quarantine["activation_receipt_sha256"],
        "stop_reconcile_proof_sha256": hashlib.sha256(reconciliation_raw).hexdigest(),
        "stop_verification_sha256": hashlib.sha256(stop_raw).hexdigest(),
        "terminal_process_record_path": runtime_terminal_process,
        "terminal_process_record_sha256": hashlib.sha256(terminal_raw).hexdigest(),
        "terminal_owner_record_path": runtime_terminal_owner,
        "terminal_owner_record_sha256": hashlib.sha256(owner_raw).hexdigest(),
        "activation_attempt": quarantine["activation_attempt"],
        "reconciliation_attempt": quarantine["reconciliation_attempt"],
        "backend_container": quarantine["backend_container"],
        "image_id": quarantine["image_id"],
        "source_root": quarantine["source_root"],
        "compose_project": project,
        "control_volume": volume,
        "development_attempt": quarantine["development_attempt"],
        "config_sha256": quarantine["config_sha256"],
        "logical_session_id": held["logical_session_id"],
        "session_epoch": held["session_epoch"],
    }
    # Rust accepts these fields only when a legacy journal needs the fresh
    # namespace attestation.  A current journal's immutable container_state
    # is the authoritative incarnation proof and carries no sidecar pin.
    if namespace_raw is not None:
        proof.update(
            namespace_attestation_path=namespace_relative,
            namespace_attestation_sha256=hashlib.sha256(namespace_raw).hexdigest(),
        )
    proof_raw = _json_bytes(proof, MAX_PROOF_BYTES, "accepted reattach proof")
    proof_sha = hashlib.sha256(proof_raw).hexdigest()
    request: dict[str, object] = {
        "schema": REQUEST_SCHEMA,
        "run_id": selected_run,
        "project_id": held["project_id"],
        "source_request_id": source_request_id,
        "source_sha256": quarantine["source_sha256"],
        "startup_provenance_sha256": quarantine["provenance_sha256"],
        "config_sha256": quarantine["config_sha256"],
        "proof_path": runtime_proof,
        "proof_sha256": proof_sha,
    }
    request_raw = _json_bytes(request, MAX_REQUEST_BYTES, "accepted reattach request")
    request_sha = hashlib.sha256(request_raw).hexdigest()
    pins = {
        "schema": PRODUCER_SCHEMA,
        "state": "prepared",
        "run_id": selected_run,
        "project_id": held["project_id"],
        "source_request_id": source_request_id,
        "source_sha256": quarantine["source_sha256"],
        "startup_provenance_sha256": quarantine["provenance_sha256"],
        "config_sha256": quarantine["config_sha256"],
        "source_root": quarantine["source_root"],
        "source_relative": quarantine["source_relative"],
        "compose_project": project,
        "control_volume": volume,
        "logical_session_id": held["logical_session_id"],
        "session_epoch": held["session_epoch"],
        "activation_record_relative": activation_relative,
        "startup_provenance_relative": provenance_relative,
        "authorization_relative": authorization_relative,
        "reconciliation_record_relative": reconciliation_relative,
        "stop_verification_relative": stop_relative,
        "terminal_process_receipt_relative": terminal_relative,
        "terminal_process_receipt_sha256": hashlib.sha256(terminal_raw).hexdigest(),
        "terminal_failed_owner_relative": owner_relative,
        "terminal_failed_owner_sha256": hashlib.sha256(owner_raw).hexdigest(),
        "terminal_process_record_relative": runtime_terminal_process,
        "terminal_process_record_sha256": proof["terminal_process_record_sha256"],
        "terminal_owner_record_relative": runtime_terminal_owner,
        "terminal_owner_record_sha256": proof["terminal_owner_record_sha256"],
        "store_run_relative": f"runs/{selected_run}",
        "request_relative": runtime_request,
        "proof_relative": runtime_proof,
        "control_request_relative": control_request,
        "control_proof_relative": control_proof,
        "request_sha256": request_sha,
        "proof_sha256": proof_sha,
        "activation_receipt_sha256": quarantine["activation_receipt_sha256"],
        "stop_reconcile_proof_sha256": proof["stop_reconcile_proof_sha256"],
        "stop_verification_sha256": proof["stop_verification_sha256"],
        "activation_attempt": quarantine["activation_attempt"],
        "reconciliation_attempt": quarantine["reconciliation_attempt"],
        "development_attempt": quarantine["development_attempt"],
        "backend_container": quarantine["backend_container"],
        "image_id": quarantine["image_id"],
        "catalog_revision": held["catalog_revision"],
        "task_count": held["task_count"],
    }
    if namespace_raw is not None:
        pins.update(
            namespace_attestation_relative=namespace_relative,
            namespace_attestation_sha256=proof["namespace_attestation_sha256"],
        )
    return {
        "request": request,
        "proof": proof,
        "request_raw": request_raw,
        "proof_raw": proof_raw,
        "request_sha256": request_sha,
        "proof_sha256": proof_sha,
        "request_relative": runtime_request,
        "proof_relative": runtime_proof,
        "terminal_process_relative": runtime_terminal_process,
        "terminal_owner_relative": runtime_terminal_owner,
        "control_request_relative": control_request,
        "control_proof_relative": control_proof,
        "control_terminal_process_relative": control_terminal_process,
        "control_terminal_owner_relative": control_terminal_owner,
        "terminal_process_raw": terminal_raw,
        "terminal_owner_raw": owner_raw,
        "environment": {
            "FULLMAG_ACCEPTED_REATTACH_REQUEST": runtime_request,
            "FULLMAG_ACCEPTED_REATTACH_REQUEST_SHA256": request_sha,
        },
        "pins": pins,
    }


def _publish_control_records(control: BuildControl, bundle: Mapping[str, object]) -> None:
    """Publish proof, terminal archives, and request under one CAS transaction."""

    # Fixture controls can capture writes without invoking Docker.  Production
    # BuildControl always follows the image-owned helper below.
    publish_raw = getattr(control, "publish_raw", None)
    if callable(publish_raw):
        publish_raw(
            str(bundle["control_proof_relative"]), bytes(bundle["proof_raw"]),
            str(bundle["control_request_relative"]), bytes(bundle["request_raw"]),
            str(bundle["control_terminal_process_relative"]),
            bytes(bundle["terminal_process_raw"]),
            str(bundle["control_terminal_owner_relative"]),
            bytes(bundle["terminal_owner_raw"]),
        )
        return
    proof_path = control.path(str(bundle["control_proof_relative"]))
    request_path = control.path(str(bundle["control_request_relative"]))
    terminal_process_path = control.path(str(bundle["control_terminal_process_relative"]))
    terminal_owner_path = control.path(str(bundle["control_terminal_owner_relative"]))
    proof_parent = str(PurePosixPath(proof_path).parent)
    request_parent = str(PurePosixPath(request_path).parent)
    terminal_process_parent = str(PurePosixPath(terminal_process_path).parent)
    terminal_owner_parent = str(PurePosixPath(terminal_owner_path).parent)
    values = {
        "FULLMAG_REATTACH_PROOF_B64": base64.b64encode(bytes(bundle["proof_raw"])).decode("ascii"),
        "FULLMAG_REATTACH_PROOF_SHA256": str(bundle["proof_sha256"]),
        "FULLMAG_REATTACH_PROOF_PATH": proof_path,
        "FULLMAG_REATTACH_REQUEST_B64": base64.b64encode(bytes(bundle["request_raw"])).decode("ascii"),
        "FULLMAG_REATTACH_REQUEST_SHA256": str(bundle["request_sha256"]),
        "FULLMAG_REATTACH_REQUEST_PATH": request_path,
        "FULLMAG_REATTACH_PROOF_PARENT": proof_parent,
        "FULLMAG_REATTACH_REQUEST_PARENT": request_parent,
        "FULLMAG_REATTACH_TERMINAL_PROCESS_B64": base64.b64encode(
            bytes(bundle["terminal_process_raw"])
        ).decode("ascii"),
        "FULLMAG_REATTACH_TERMINAL_PROCESS_SHA256": str(
            bundle["proof"]["terminal_process_record_sha256"]
        ),
        "FULLMAG_REATTACH_TERMINAL_PROCESS_PATH": terminal_process_path,
        "FULLMAG_REATTACH_TERMINAL_PROCESS_PARENT": terminal_process_parent,
        "FULLMAG_REATTACH_TERMINAL_OWNER_B64": base64.b64encode(
            bytes(bundle["terminal_owner_raw"])
        ).decode("ascii"),
        "FULLMAG_REATTACH_TERMINAL_OWNER_SHA256": str(
            bundle["proof"]["terminal_owner_record_sha256"]
        ),
        "FULLMAG_REATTACH_TERMINAL_OWNER_PATH": terminal_owner_path,
        "FULLMAG_REATTACH_TERMINAL_OWNER_PARENT": terminal_owner_parent,
    }
    script = r'''set -euo pipefail
umask 027
exec 9>/control/operation.lock
flock -n 9 || exit 73
test ! -e /control/active
test ! -L /control/active

publish() {
    path="$1"; parent="$2"; expected="$3"; payload="$4"
    test -n "$path"; test -n "$parent"
    test ! -L "$parent"; mkdir -p "$parent"
    test "$(readlink -f "$parent")" = "$parent"
    test ! -L "$path"
    if test -e "$path"; then
        test -f "$path"; test "$(stat -c %h "$path")" = 1
        test "$(sha256sum "$path" | cut -d' ' -f1)" = "$expected"
        return 0
    fi
    tmp="$(mktemp "$parent/.reattach.XXXXXXXX")"
    trap 'rm -f -- "$tmp"' EXIT
    printf '%s' "$payload" | base64 -d > "$tmp"
    test "$(sha256sum "$tmp" | cut -d' ' -f1)" = "$expected"
    test "$(stat -c %h "$tmp")" = 1
    sync "$tmp"
    mv -T -- "$tmp" "$path"
    sync "$parent"
    trap - EXIT
}
publish "$FULLMAG_REATTACH_TERMINAL_PROCESS_PATH" "$FULLMAG_REATTACH_TERMINAL_PROCESS_PARENT" "$FULLMAG_REATTACH_TERMINAL_PROCESS_SHA256" "$FULLMAG_REATTACH_TERMINAL_PROCESS_B64"
publish "$FULLMAG_REATTACH_TERMINAL_OWNER_PATH" "$FULLMAG_REATTACH_TERMINAL_OWNER_PARENT" "$FULLMAG_REATTACH_TERMINAL_OWNER_SHA256" "$FULLMAG_REATTACH_TERMINAL_OWNER_B64"
publish "$FULLMAG_REATTACH_PROOF_PATH" "$FULLMAG_REATTACH_PROOF_PARENT" "$FULLMAG_REATTACH_PROOF_SHA256" "$FULLMAG_REATTACH_PROOF_B64"
publish "$FULLMAG_REATTACH_REQUEST_PATH" "$FULLMAG_REATTACH_REQUEST_PARENT" "$FULLMAG_REATTACH_REQUEST_SHA256" "$FULLMAG_REATTACH_REQUEST_B64"
printf 'PUBLISHED\n'
'''
    args = control.helper_args(script, name="fullmag-control-reattach-" + str(bundle["proof_sha256"])[:24])
    entrypoint = args.index("--entrypoint")
    for key, value in values.items():
        args[entrypoint:entrypoint] = ["--env", key + "=" + value]
    result = bounded_capture(args, data=b"", timeout=180)
    if result.returncode or b"PUBLISHED\n" not in result.stdout:
        detail = (result.stderr + result.stdout).decode("utf-8", "replace")[-2048:]
        raise _fail("accepted reattach control publication was not committed: " + detail)


def build_accepted_reattach_bundle(
    control: BuildControl,
    *,
    store_root: Path,
    run_id: str | None = None,
) -> dict[str, object]:
    """Read and validate one exact held run without writing any record."""

    if run_id is not None:
        _portable_id(run_id, "explicit run id")
    return _bundle_from_records(control, store_root=store_root, run_id=run_id)


def produce_accepted_reattach(
    control: BuildControl,
    *,
    store_root: Path,
    run_id: str | None = None,
) -> dict[str, object]:
    """Prepare and publish a private same-run reattach request.

    The return mapping is intentionally small and serializable.  ``environment``
    can be overlaid on the selected backend start environment; ``pins`` is the
    caller's record of every immutable source/control/run identity.  The
    producer itself writes only the two CAS-checked documents in runtime
    control.
    """

    bundle = _bundle_from_records(control, store_root=store_root, run_id=run_id)
    _publish_control_records(control, bundle)
    return {"environment": dict(bundle["environment"]), "pins": dict(bundle["pins"])}


__all__ = [
    "REQUEST_SCHEMA",
    "PROOF_SCHEMA",
    "PRODUCER_SCHEMA",
    "build_accepted_reattach_bundle",
    "produce_accepted_reattach",
]
