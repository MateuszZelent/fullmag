"""Fail-closed handshake for a delegated worker cgroup in Docker DEV."""
from __future__ import annotations

import json
import os
import re
import stat
import time
import uuid


PROFILE_ENV = "FULLMAG_WORKER_CGROUP_PROFILE"
PROJECT_ENV = "FULLMAG_COMPOSE_PROJECT"
PROFILE = "docker-backend-v1"
ROOT = "/opt/fullmag/worker-cgroup"
REQUEST_PATH = "/opt/fullmag/runtime-control/worker-cgroup/request.json"
READY_PATH = "/opt/fullmag/runtime-control/worker-cgroup/ready.json"

_CONTROL_DIRECTORY = "/opt/fullmag/runtime-control/worker-cgroup"
_CONTROL_PARENT = "/opt/fullmag/runtime-control"
_REQUEST_SCHEMA = "fullmag.worker-cgroup-request.v1"
_READY_SCHEMA = "fullmag.worker-cgroup-ready.v1"
_MAX_DOCUMENT_BYTES = 16 * 1024
_MAX_PROC_BYTES = 16 * 1024
_MAX_MOUNTINFO_BYTES = 2 * 1024 * 1024
_TIMEOUT_SECONDS = 300.0
# A plain restart has no host launcher; allow only a short window for a
# launcher that happens to run concurrently before deferring delegation.
_RESTART_GRACE_SECONDS = 30.0
_POLL_SECONDS = 0.25
_CONTAINER_BIND_PATTERN = re.compile(
    r"/containers/([0-9a-f]{64})/(?:hostname|hosts|resolv\.conf)\Z"
)
_PROJECT_PATTERN = re.compile(r"fullmag-(?:master|worktree-[a-z0-9][a-z0-9_-]*)\Z")


def wait_for_delegation() -> dict[str, object]:
    """Publish this backend identity and wait for its matching CPU delegation.

    Lifecycle:

    * Fresh container (created by the host launcher): the launcher's
      ``ensure_delegation`` serves this exact request, so the gate blocks
      fail-closed until the matching receipt arrives.
    * Plain restart of the same container (Docker Desktop restart, restart
      policy, host reboot): the engine destroys the container cgroup and mount
      namespace, so no earlier delegation can survive and no earlier receipt is
      ever accepted as proof. No host launcher serves the new request either.
      The gate therefore publishes a fresh request bound to this incarnation,
      waits a short grace window, and then returns ``state="deferred"``. The
      worker root stays an undelegated image directory, the runtime CPU quota
      probe reports ``Unavailable``, and owner-bound admission keeps rejecting
      quota-requiring work until a host launcher run delegates this live
      incarnation (the published request remains valid after ``exec`` because
      PID and process start time are preserved).
    """

    profile = os.environ.get(PROFILE_ENV)
    if profile is None:
        return {}
    if profile != PROFILE:
        raise RuntimeError(f"worker cgroup profile must be exactly {PROFILE!r}")
    if os.environ.get("FULLMAG_WORKER_CGROUP_ROOT") != ROOT:
        raise RuntimeError(f"FULLMAG_WORKER_CGROUP_ROOT must be exactly {ROOT!r}")

    project = os.environ.get(PROJECT_ENV, "")
    if _PROJECT_PATTERN.fullmatch(project) is None:
        raise RuntimeError("FULLMAG_COMPOSE_PROJECT is not a managed Fullmag DEV group")

    container_id = _container_id_from_mountinfo()
    identity = {
        "compose_project": project,
        "pid": os.getpid(),
        "process_start_token": _process_start_token(),
        "boot_id": _boot_id(),
        "container_id": container_id,
    }
    nonce = uuid.uuid4().hex
    request = {
        "schema": _REQUEST_SCHEMA,
        "nonce": nonce,
        **identity,
    }

    directory_fd = _open_control_directory()
    try:
        # Read the restart hint before replacing the request. The previous
        # receipt is never accepted as delegation proof; it only shows that a
        # host launcher already delegated an earlier incarnation of this same
        # engine container, so none is expected to serve this restart.
        restarted = _is_restart_of_delegated_container(directory_fd, container_id)
        _atomic_write_request(directory_fd, request, nonce)
        timeout = _RESTART_GRACE_SECONDS if restarted else _TIMEOUT_SECONDS
        deadline = time.monotonic() + timeout
        while True:
            receipt = _read_ready_receipt(directory_fd, nonce)
            if receipt is not None:
                return _accept_receipt(receipt, request)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if restarted:
                    return {
                        "schema": _REQUEST_SCHEMA,
                        "state": "deferred",
                        "reason": "restart-without-launcher",
                        "nonce": nonce,
                    }
                raise RuntimeError("timed out waiting for delegated worker cgroup readiness")
            time.sleep(min(_POLL_SECONDS, remaining))
    finally:
        os.close(directory_fd)


def _container_id_from_mountinfo() -> str | None:
    """Return this container's full engine ID from its engine-provided binds.

    Docker bind-mounts ``hostname``, ``hosts`` and ``resolv.conf`` from
    ``.../containers/<64-hex id>/``. Any ambiguity yields ``None``.
    """

    try:
        payload = _read_absolute_file("/proc/self/mountinfo", _MAX_MOUNTINFO_BYTES, "mountinfo")
        text = payload.decode("utf-8", "strict")
    except (RuntimeError, UnicodeDecodeError):
        return None
    found: set[str] = set()
    for line in text.splitlines():
        fields = line.split(" - ", 1)[0].split()
        if len(fields) < 5:
            continue
        match = _CONTAINER_BIND_PATTERN.search(_unescape_mount_field(fields[3]))
        if match is not None:
            found.add(match.group(1))
    if len(found) != 1:
        return None
    return found.pop()


def _is_restart_of_delegated_container(directory_fd: int, container_id: str | None) -> bool:
    if container_id is None:
        return False
    previous = _read_any_ready_receipt(directory_fd)
    if previous is None:
        return False
    return (
        previous.get("schema") == _READY_SCHEMA
        and previous.get("state") == "ready"
        and previous.get("container_id") == container_id
        and previous.get("compose_project") == os.environ.get(PROJECT_ENV)
    )


def _read_any_ready_receipt(directory_fd: int) -> dict[str, object] | None:
    """Read the retained receipt as a hint only; malformed data is no hint."""

    try:
        descriptor = os.open(
            "ready.json",
            os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0),
            dir_fd=directory_fd,
        )
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            return None
        payload = _read_bounded(descriptor, _MAX_DOCUMENT_BYTES, "worker cgroup receipt")
    except RuntimeError:
        return None
    finally:
        os.close(descriptor)
    try:
        document = json.loads(payload, object_pairs_hook=_unique_object_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return None
    return document if isinstance(document, dict) else None


def _open_directory(path: str) -> int:
    if not path.startswith("/") or "\x00" in path:
        raise RuntimeError("worker cgroup directory path is invalid")
    flags = _directory_open_flags()
    current_fd = os.open("/", flags)
    try:
        for component in path.split("/")[1:]:
            if not component or component in {".", ".."}:
                raise RuntimeError("worker cgroup directory path is not canonical")
            next_fd = os.open(component, flags, dir_fd=current_fd)
            try:
                if not stat.S_ISDIR(os.fstat(next_fd).st_mode):
                    raise RuntimeError("worker cgroup path contains a non-directory component")
            except BaseException:
                os.close(next_fd)
                raise
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except BaseException:
        os.close(current_fd)
        raise


def _directory_open_flags() -> int:
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise RuntimeError("worker cgroup gate requires no-follow directory opens")
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)


def _open_control_directory() -> int:
    parent_fd = _open_directory(_CONTROL_PARENT)
    try:
        try:
            os.mkdir("worker-cgroup", 0o700, dir_fd=parent_fd)
        except FileExistsError:
            pass
        directory_fd = os.open("worker-cgroup", _directory_open_flags(), dir_fd=parent_fd)
        if not stat.S_ISDIR(os.fstat(directory_fd).st_mode):
            os.close(directory_fd)
            raise RuntimeError("worker cgroup control path is not a directory")
        return directory_fd
    finally:
        os.close(parent_fd)


def _atomic_write_request(directory_fd: int, request: dict[str, object], nonce: str) -> None:
    payload = json.dumps(request, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(payload) > _MAX_DOCUMENT_BYTES:
        raise RuntimeError("worker cgroup request exceeds the 16 KiB limit")
    _require_regular_or_missing(directory_fd, "request.json")

    temporary_name = f".request-{nonce}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    if not hasattr(os, "O_NOFOLLOW"):
        raise RuntimeError("worker cgroup gate requires no-follow file opens")
    flags |= os.O_NOFOLLOW
    descriptor = os.open(temporary_name, flags, 0o600, dir_fd=directory_fd)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise RuntimeError("worker cgroup request temporary is not a regular file")
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise RuntimeError("worker cgroup request write made no progress")
            view = view[written:]
        os.fsync(descriptor)
    except BaseException:
        os.close(descriptor)
        _unlink_if_present(directory_fd, temporary_name)
        raise
    else:
        os.close(descriptor)

    try:
        _require_regular_or_missing(directory_fd, "request.json")
        os.replace(
            temporary_name,
            "request.json",
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
        os.fsync(directory_fd)
    except BaseException:
        _unlink_if_present(directory_fd, temporary_name)
        raise


def _require_regular_or_missing(directory_fd: int, name: str) -> None:
    try:
        info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeError(f"worker cgroup control file {name} is not a regular non-symlink file")


def _unlink_if_present(directory_fd: int, name: str) -> None:
    try:
        os.unlink(name, dir_fd=directory_fd)
    except FileNotFoundError:
        pass


def _read_ready_receipt(directory_fd: int, nonce: str) -> dict[str, object] | None:
    if not hasattr(os, "O_NOFOLLOW"):
        raise RuntimeError("worker cgroup gate requires no-follow file opens")
    try:
        descriptor = os.open(
            "ready.json",
            os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0),
            dir_fd=directory_fd,
        )
    except FileNotFoundError:
        return None
    except OSError as error:
        raise RuntimeError(f"cannot safely open worker cgroup receipt: {error}") from error

    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise RuntimeError("worker cgroup receipt is not a regular file")
        payload = _read_bounded(descriptor, _MAX_DOCUMENT_BYTES, "worker cgroup receipt")
    finally:
        os.close(descriptor)

    try:
        document = json.loads(payload, object_pairs_hook=_unique_object_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        if _contains_nonce(payload, nonce):
            raise RuntimeError("matching worker cgroup receipt is malformed") from error
        return None
    if not isinstance(document, dict):
        if _contains_nonce(payload, nonce):
            raise RuntimeError("matching worker cgroup receipt is not an object")
        return None
    if document.get("nonce") != nonce:
        return None
    return document


def _unique_object_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def _contains_nonce(payload: bytes, nonce: str) -> bool:
    pattern = rb'"nonce"\s*:\s*"' + re.escape(nonce.encode("ascii")) + rb'"'
    return re.search(pattern, payload) is not None


def _accept_receipt(receipt: dict[str, object], request: dict[str, object]) -> dict[str, object]:
    if receipt.get("schema") != _READY_SCHEMA:
        raise RuntimeError("matching worker cgroup receipt has an unsupported schema")
    for key in ("nonce", "compose_project", "pid", "process_start_token", "boot_id"):
        if receipt.get(key) != request[key]:
            raise RuntimeError(f"matching worker cgroup receipt has invalid {key}")
    # Bind the proof to this engine container when its ID is observable here.
    own_container = request.get("container_id")
    if own_container is not None and receipt.get("container_id") != own_container:
        raise RuntimeError("matching worker cgroup receipt names a different container")

    state = receipt.get("state")
    if state == "failed":
        detail = receipt.get("error")
        if not isinstance(detail, str) or not detail.strip():
            detail = "delegation helper reported failure"
        detail = " ".join(detail.split())[:512]
        raise RuntimeError(f"worker cgroup delegation failed: {detail}")
    if state != "ready":
        raise RuntimeError("matching worker cgroup receipt has an invalid state")
    if receipt.get("root") != ROOT:
        raise RuntimeError("worker cgroup receipt names an unexpected root")

    root_fd = _open_directory(ROOT)
    try:
        root_info = os.fstat(root_fd)
        if not _json_integer_equals(receipt.get("root_device"), root_info.st_dev):
            raise RuntimeError("worker cgroup root device differs from its receipt")
        if not _json_integer_equals(receipt.get("root_inode"), root_info.st_ino):
            raise RuntimeError("worker cgroup root inode differs from its receipt")
        _require_cgroup_mount()

        reported_controllers = _controller_tokens(receipt.get("controllers"), "controllers")
        reported_subtree = _controller_tokens(receipt.get("subtree_control"), "subtree_control")
        actual_controllers = set(_read_control_file(root_fd, "cgroup.controllers").split())
        actual_subtree = set(_read_control_file(root_fd, "cgroup.subtree_control").split())
        if "cpu" not in reported_controllers or "cpu" not in actual_controllers:
            raise RuntimeError("worker cgroup root does not expose the cpu controller")
        if "cpu" not in reported_subtree or "cpu" not in actual_subtree:
            raise RuntimeError("worker cgroup root does not enable the cpu controller for children")
    finally:
        os.close(root_fd)

    return receipt


def _json_integer_equals(value: object, expected: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value == expected


def _controller_tokens(value: object, label: str) -> set[str]:
    if isinstance(value, str):
        return set(value.split())
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return {token for item in value for token in item.split()}
    raise RuntimeError(f"worker cgroup receipt has malformed {label}")


def _read_control_file(directory_fd: int, name: str) -> str:
    if not hasattr(os, "O_NOFOLLOW"):
        raise RuntimeError("worker cgroup gate requires no-follow file opens")
    try:
        descriptor = os.open(
            name,
            os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0),
            dir_fd=directory_fd,
        )
    except OSError as error:
        raise RuntimeError(f"cannot read worker cgroup {name}: {error}") from error
    try:
        return _read_bounded(descriptor, _MAX_DOCUMENT_BYTES, f"worker cgroup {name}").decode("ascii")
    except UnicodeDecodeError as error:
        raise RuntimeError(f"worker cgroup {name} is not ASCII") from error
    finally:
        os.close(descriptor)


def _require_cgroup_mount() -> None:
    payload = _read_absolute_file("/proc/self/mountinfo", _MAX_MOUNTINFO_BYTES, "mountinfo")
    matching: list[tuple[str, set[str]]] = []
    for line in payload.decode("utf-8", "strict").splitlines():
        sides = line.split(" - ", 1)
        if len(sides) != 2:
            raise RuntimeError("worker cgroup mountinfo is malformed")
        left = sides[0].split()
        right = sides[1].split()
        if len(left) < 6 or len(right) < 3:
            raise RuntimeError("worker cgroup mountinfo entry is malformed")
        mountpoint = _unescape_mount_field(left[4])
        if mountpoint == ROOT:
            matching.append((right[0], set(left[5].split(","))))
    if len(matching) != 1:
        raise RuntimeError("worker cgroup root is not one unambiguous mountpoint")
    filesystem, options = matching[0]
    if filesystem != "cgroup2" or "rw" not in options or "ro" in options:
        raise RuntimeError("worker cgroup root is not a read-write cgroup v2 mount")


def _unescape_mount_field(value: str) -> str:
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), value)


def _process_start_token() -> str:
    payload = _read_absolute_file("/proc/self/stat", _MAX_PROC_BYTES, "process stat")
    closing_paren = payload.rfind(b")")
    if closing_paren < 0:
        raise RuntimeError("cannot parse process start token")
    fields = payload[closing_paren + 1 :].split()
    # The remainder starts at proc stat field 3; starttime is field 22.
    if len(fields) <= 19 or not fields[19].isdigit():
        raise RuntimeError("process stat has no valid field 22 start token")
    return fields[19].decode("ascii")


def _boot_id() -> str:
    payload = _read_absolute_file(
        "/proc/sys/kernel/random/boot_id", 128, "boot id"
    ).decode("ascii").strip()
    try:
        return str(uuid.UUID(payload))
    except ValueError as error:
        raise RuntimeError("kernel boot id is malformed") from error


def _read_absolute_file(path: str, limit: int, label: str) -> bytes:
    if not hasattr(os, "O_NOFOLLOW"):
        raise RuntimeError("worker cgroup gate requires no-follow file opens")
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0))
    except OSError as error:
        raise RuntimeError(f"cannot read {label}: {error}") from error
    try:
        return _read_bounded(descriptor, limit, label)
    finally:
        os.close(descriptor)


def _read_bounded(descriptor: int, limit: int, label: str) -> bytes:
    chunks = bytearray()
    while len(chunks) <= limit:
        chunk = os.read(descriptor, min(4096, limit + 1 - len(chunks)))
        if not chunk:
            break
        chunks.extend(chunk)
    if len(chunks) > limit:
        raise RuntimeError(f"{label} exceeds its {limit}-byte limit")
    return bytes(chunks)
