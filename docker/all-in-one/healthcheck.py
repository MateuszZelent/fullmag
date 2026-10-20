"""Read-only readiness of the actual container process tree."""
from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import stat
import urllib.request
from typing import Any, Mapping


RUNTIME_CONTROL_ROOT = Path("/opt/fullmag/runtime-control")


def backend_receipt_path(environment: Mapping[str, str] | None = None) -> Path:
    """Resolve the PID-1 receipt from the technical runtime volume."""

    environment = os.environ if environment is None else environment
    root = Path(environment.get("FULLMAG_RUNTIME_CONTROL_ROOT", str(RUNTIME_CONTROL_ROOT)))
    value = Path(
        environment.get(
            "FULLMAG_RUNTIME_PROCESS_RECEIPT",
            str(root / "runtime-service/process-tree.json"),
        )
    )
    if not value.is_absolute() or any(part == ".." for part in value.parts):
        raise RuntimeError("FULLMAG_RUNTIME_PROCESS_RECEIPT must be absolute without traversal")
    return value


BACKEND_RECEIPT_PATH = backend_receipt_path()
MAX_BACKEND_RECEIPT_BYTES = 512 * 1024
# The native control probe may use three seconds before Windows-folder I/O.
BACKEND_LIVENESS_TIMEOUT_SECONDS = 5.0


FRONTEND_RECEIPT_PATH = Path("/run/fullmag/frontend-owner/receipt.json")
FRONTEND_RECEIPT_SCHEMA = "fullmag.docker-frontend-development-receipt.v1"
FRONTEND_INTERNAL_HOST = "127.0.0.1"
FRONTEND_INTERNAL_PORT = 8080
FRONTEND_TCP_TIMEOUT_SECONDS = 0.5
MAX_FRONTEND_RECEIPT_BYTES = 512 * 1024
PROCESS_IDENTITY_FIELDS = (
    "pid_namespace",
    "process_start_time_ticks",
    "session_id",
    "process_group_id",
)


def _assert_no_links(path: Path, name: str) -> None:
    if not path.is_absolute() or any(part == ".." for part in path.parts):
        raise RuntimeError(f"{name} must be absolute without parent traversal")
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise RuntimeError(f"cannot inspect {name}: {error}") from error
        if stat.S_ISLNK(metadata.st_mode):
            raise RuntimeError(f"{name} traverses a symbolic link: {current}")


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise RuntimeError(f"frontend receipt contains duplicate key: {key}")
        result[key] = value
    return result


def _read_bounded_json(path: Path, name: str, maximum: int) -> dict[str, Any]:
    """Read a fixed receipt without following a replacement or special file."""

    _assert_no_links(path.parent, f"{name} parent")
    descriptor: int | None = None
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_NONBLOCK", 0),
        )
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > maximum:
            raise RuntimeError(f"{name} is not a bounded regular file")
        data = bytearray()
        while len(data) <= maximum:
            chunk = os.read(descriptor, min(64 * 1024, maximum + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > maximum:
            raise RuntimeError(f"{name} exceeds its size bound")
    except FileNotFoundError as error:
        raise RuntimeError(f"{name} is missing") from error
    except OSError as error:
        raise RuntimeError(f"cannot read {name}: {error}") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
    try:
        value = json.loads(bytes(data), object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"{name} is not valid JSON: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"{name} must contain a JSON object")
    return value


def _read_process_identity(pid: int, proc_root: Path = Path("/proc")) -> dict[str, Any]:
    """Read the identity fields needed to reject PID reuse."""

    stat_path = proc_root / str(pid) / "stat"
    namespace_path = proc_root / str(pid) / "ns" / "pid"
    try:
        raw = stat_path.read_bytes()
        namespace = os.readlink(namespace_path)
    except FileNotFoundError as error:
        raise RuntimeError(f"frontend owner pid {pid} is not running") from error
    except OSError as error:
        raise RuntimeError(f"cannot inspect frontend owner pid {pid}: {error}") from error
    closing_paren = raw.rfind(b")")
    if closing_paren < 0:
        raise RuntimeError(f"frontend owner stat is malformed for pid {pid}")
    fields = raw[closing_paren + 1 :].split()
    if len(fields) <= 19:
        raise RuntimeError(f"frontend owner stat is incomplete for pid {pid}")
    try:
        state = fields[0].decode("ascii")
        process_group_id = int(fields[2], 10)
        session_id = int(fields[3], 10)
        process_start_time_ticks = int(fields[19], 10)
    except (UnicodeDecodeError, ValueError) as error:
        raise RuntimeError(f"frontend owner stat is not numeric for pid {pid}") from error
    if state in {"Z", "X", "x"}:
        raise RuntimeError(f"frontend owner pid {pid} is not running")
    if (
        not namespace.startswith("pid:[")
        or process_group_id <= 0
        or session_id <= 0
        or process_start_time_ticks < 0
    ):
        raise RuntimeError(f"frontend owner identity is invalid for pid {pid}")
    return {
        "pid": pid,
        "pid_namespace": namespace,
        "process_start_time_ticks": process_start_time_ticks,
        "session_id": session_id,
        "process_group_id": process_group_id,
    }


def _receipt_process_identity(receipt: Mapping[str, Any]) -> dict[str, Any]:
    if receipt.get("process_identity_schema") != "linux-proc-v1":
        raise RuntimeError("frontend receipt has no supported process identity")
    pid = receipt.get("pid")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        raise RuntimeError("frontend receipt has an invalid owner pid")
    namespace = receipt.get("pid_namespace")
    if not isinstance(namespace, str) or not namespace.startswith("pid:["):
        raise RuntimeError("frontend receipt has an invalid pid namespace")
    identity: dict[str, Any] = {"pid": pid, "pid_namespace": namespace}
    for field in PROCESS_IDENTITY_FIELDS[1:]:
        value = receipt.get(field)
        if isinstance(value, bool) or not isinstance(value, int):
            raise RuntimeError(f"frontend receipt has an invalid {field}")
        if field == "process_start_time_ticks" and value < 0:
            raise RuntimeError(f"frontend receipt has an invalid {field}")
        if field != "process_start_time_ticks" and value <= 0:
            raise RuntimeError(f"frontend receipt has an invalid {field}")
        identity[field] = value
    return identity


def _check_frontend_dev_liveness(
    *,
    receipt_path: Path = FRONTEND_RECEIPT_PATH,
    proc_root: Path = Path("/proc"),
    tcp_host: str = FRONTEND_INTERNAL_HOST,
    tcp_port: int = FRONTEND_INTERNAL_PORT,
    tcp_timeout: float = FRONTEND_TCP_TIMEOUT_SECONDS,
) -> None:
    """Require the receipt owner and a listening Next TCP socket.

    This intentionally performs no HTTP request.  Rendering ``/workspace`` from
    Docker's periodic health probe can start or invalidate a Next page while
    its development manifests are being written.
    """

    receipt = _read_bounded_json(
        receipt_path, "frontend development receipt", MAX_FRONTEND_RECEIPT_BYTES
    )
    if receipt.get("schema") != FRONTEND_RECEIPT_SCHEMA:
        raise RuntimeError("frontend receipt has an unsupported schema")
    if receipt.get("state") != "running":
        raise RuntimeError(f"frontend receipt is not running: {receipt.get('state')!r}")
    if receipt.get("internal_port") != FRONTEND_INTERNAL_PORT:
        raise RuntimeError("frontend receipt has an unexpected internal port")
    owner_token = receipt.get("owner_token")
    if not isinstance(owner_token, str) or not owner_token or len(owner_token) > 256:
        raise RuntimeError("frontend receipt has an invalid owner token")
    expected = _receipt_process_identity(receipt)
    observed = _read_process_identity(expected["pid"], proc_root)
    if any(expected[field] != observed[field] for field in PROCESS_IDENTITY_FIELDS):
        raise RuntimeError("frontend receipt owner identity does not match the live process")
    if tcp_host != FRONTEND_INTERNAL_HOST or tcp_port != FRONTEND_INTERNAL_PORT:
        raise RuntimeError("frontend TCP liveness target is not fixed")
    try:
        with socket.create_connection((tcp_host, tcp_port), timeout=tcp_timeout):
            pass
    except OSError as error:
        raise RuntimeError(f"frontend TCP liveness failed: {error}") from error


def _check_backend_readiness(receipt_path: Path = BACKEND_RECEIPT_PATH) -> None:
    receipt = _read_bounded_json(
        receipt_path, "backend process-tree receipt", MAX_BACKEND_RECEIPT_BYTES
    )
    if (receipt.get("schema") != "fullmag.docker-process-tree.v1"
            or receipt.get("state") != "ready"):
        raise RuntimeError("backend supervisor has not confirmed startup readiness")
    with urllib.request.urlopen("http://127.0.0.1:8081/healthz", timeout=2) as response:
        if response.status != 200:
            raise RuntimeError("backend API is unavailable")
    with urllib.request.urlopen(
        "http://127.0.0.1:8081/v2/platform/runtime-service",
        timeout=BACKEND_LIVENESS_TIMEOUT_SECONDS,
    ) as response:
        status = json.load(response)
        if (response.status != 200
                or status.get("schema_version") != "application_service_status.v1"
                or status.get("state") != "ready"
                or status.get("configured") is not True):
            raise RuntimeError("native backend readiness is not confirmed")


def _run() -> None:
    if os.environ.get("FULLMAG_DOCKER_ROLE") != "frontend":
        _check_backend_readiness()
    if os.environ.get("FULLMAG_DOCKER_FRONTEND") == "dev":
        _check_frontend_dev_liveness()


if __name__ == "__main__":
    _run()
