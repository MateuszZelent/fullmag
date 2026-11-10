"""Run and attest opt-in native backend contracts during a managed build."""
from __future__ import annotations

import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
import uuid
from collections.abc import Mapping, Sequence
from typing import Any


SCHEMA = "fullmag.backend-native-contracts.v1"
CONTRACT_REVISION = 1
FEM_DEMAG_POISSON = "fem-demag-poisson"
FEM_CUDA_ACTIVITY_TRACE = "fem-cuda-activity-trace"
CONTRACT_TARGETS = {
    FEM_DEMAG_POISSON: "fem_demag_poisson_contract",
    FEM_CUDA_ACTIVITY_TRACE: "fem_cuda_activity_trace_contract",
    "fem-cuda-pgbb-reuse": "fem_cuda_pgbb_reuse_contract",
    "fem-cuda-rk-guard": "fem_cuda_rk_guard_contract",
    "fem-cpu-pgbb-reuse": "fem_pgbb_accepted_cache_contract",
    "fem-cuda-object-average": "fem_cuda_object_average_contract",
}
ALLOWED_CONTRACTS = frozenset(CONTRACT_TARGETS)
PACKAGE_LIBRARY_ARTIFACT_PATH = "lib/libfullmag_fem.so"
BUILD_LIBRARY_RELATIVE_PATH = Path("backends/fem/libfullmag_fem.so")
TEST_BINARY_RELATIVE_PATH = Path("backends/fem/fem_demag_poisson_contract")
MAX_LOG_BYTES = 16 * 1024 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class NativeContractError(RuntimeError):
    """A native contract failed; ``report`` is the durable terminal receipt."""

    def __init__(
        self,
        message: str,
        *,
        report: dict[str, Any] | None = None,
        receipt_path: Path | None = None,
    ) -> None:
        super().__init__(message)
        self.report = report
        self.receipt_path = receipt_path


class _LogLimitExceeded(RuntimeError):
    pass


def normalize_contracts(requested: Sequence[str] | None) -> tuple[str, ...]:
    """Validate the opt-in contract IDs while preserving their requested order."""

    if requested is None:
        return ()
    if isinstance(requested, (str, bytes)):
        raise ValueError("native contracts must be a sequence of contract IDs")
    try:
        values = tuple(requested)
    except TypeError as error:
        raise ValueError("native contracts must be a sequence of contract IDs") from error
    normalized: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str) or value not in ALLOWED_CONTRACTS:
            raise ValueError(f"unknown native contract: {value!r}")
        if value in seen:
            raise ValueError(f"duplicate native contract: {value}")
        seen.add(value)
        normalized.append(value)
    if len(normalized) > 1:
        raise ValueError("select at most one native contract per managed build")
    return tuple(normalized)


def _test_binary_path(contract_id: str) -> Path:
    return Path("backends/fem") / CONTRACT_TARGETS[contract_id]


def _valid_sha256(value: Any) -> bool:
    return isinstance(value, str) and SHA256_RE.fullmatch(value) is not None


def _is_real_number(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(float(value))


def _report_package_library_sha256(report: Mapping[str, Any], contract_id: str) -> str | None:
    contracts = report.get("contracts")
    if not isinstance(contracts, Mapping):
        return None
    contract = contracts.get(contract_id)
    if not isinstance(contract, Mapping):
        return None
    libraries = contract.get("libraries")
    package_library = libraries.get("package") if isinstance(libraries, Mapping) else None
    if not isinstance(package_library, Mapping):
        return None
    digest = package_library.get("sha256")
    return digest if _valid_sha256(digest) else None


def _expected_compile_argv(argv: Any, contract_id: str = FEM_DEMAG_POISSON) -> bool:
    if not isinstance(argv, list) or len(argv) != 7:
        return False
    return (
        isinstance(argv[0], str)
        and (argv[0] == "cmake" or (Path(argv[0]).is_absolute() and Path(argv[0]).name == "cmake"))
        and argv[1] == "--build"
        and isinstance(argv[2], str)
        and Path(argv[2]).is_absolute()
        and argv[3] == "--target"
        and argv[4] == CONTRACT_TARGETS[contract_id]
        and argv[5] == "--parallel"
        and isinstance(argv[6], str)
        and argv[6].isdecimal()
        and int(argv[6]) > 0
    )


def _expected_test_argv(argv: Any, contract_id: str = FEM_DEMAG_POISSON) -> bool:
    if not isinstance(argv, list) or len(argv) != 1 or not isinstance(argv[0], str):
        return False
    path = Path(argv[0])
    return (
        path.is_absolute()
        and path.name == _test_binary_path(contract_id).name
        and path.parent.name == "fem"
        and path.parent.parent.name == "backends"
    )


def _command_succeeded(command: Any, *, kind: str, contract_id: str = FEM_DEMAG_POISSON) -> bool:
    if not isinstance(command, Mapping):
        return False
    expected = _expected_compile_argv(command.get("argv"), contract_id) if kind == "compile" else _expected_test_argv(command.get("argv"), contract_id)
    return (
        expected
        and command.get("state") == "succeeded"
        and type(command.get("exit_code")) is int
        and command.get("exit_code") == 0
        and _is_real_number(command.get("duration_seconds"))
        and command["duration_seconds"] >= 0
    )


def _hash_regular_file(path: Path) -> str:
    """Hash a regular, non-symlink file and reject concurrent replacement."""

    try:
        before = path.lstat()
    except OSError as error:
        raise NativeContractError(f"missing native contract input: {path}") from error
    if not stat.S_ISREG(before.st_mode):
        raise NativeContractError(f"native contract input is not a regular file: {path}")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise NativeContractError(f"cannot open native contract input: {path}") from error
    digest = hashlib.sha256()
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or _signature(before) != _signature(opened):
            raise NativeContractError(f"native contract input changed while opening: {path}")
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(descriptor)
        current = path.lstat()
        if _signature(opened) != _signature(after) or _signature(after) != _signature(current):
            raise NativeContractError(f"native contract input changed while hashing: {path}")
    finally:
        os.close(descriptor)
    return digest.hexdigest()


def _signature(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _require_directory(path: Path, name: str) -> None:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise NativeContractError(f"{name} is missing: {path}") from error
    if not stat.S_ISDIR(metadata.st_mode):
        raise NativeContractError(f"{name} must be a regular directory: {path}")


def _build_library_sha256(native_root: Path) -> str:
    library = native_root / BUILD_LIBRARY_RELATIVE_PATH
    try:
        resolved_root = native_root.resolve(strict=True)
        resolved_library = library.resolve(strict=True)
        resolved_library.relative_to(resolved_root)
    except (OSError, ValueError) as error:
        raise NativeContractError(
            "built FEM library is missing or resolves outside the native build root"
        ) from error
    digest = _hash_regular_file(resolved_library)
    _require_soname_matches(library, native_root, digest)
    return digest


def _package_library_sha256(package_root: Path) -> str:
    library = package_root / PACKAGE_LIBRARY_ARTIFACT_PATH
    return _hash_regular_file(library)


def _require_soname_matches(library: Path, root: Path, digest: str) -> None:
    # CMake declares SOVERSION 0: the ELF loader follows .so.0, not .so.
    alias = library.with_name("libfullmag_fem.so.0")
    try:
        resolved = alias.resolve(strict=True)
        resolved.relative_to(root.resolve(strict=True))
    except (OSError, ValueError) as error:
        raise NativeContractError("FEM SONAME library is missing or escapes its root") from error
    if _hash_regular_file(resolved) != digest:
        raise NativeContractError("FEM SONAME library differs from the attested library")


def _require_cmake_snapshot(native_root: Path, snapshot: str) -> None:
    cache = native_root / "CMakeCache.txt"
    before = _hash_regular_file(cache)
    with cache.open("rb") as source:
        payload = source.read(1024 * 1024 + 1)
    if len(payload) > 1024 * 1024 or hashlib.sha256(payload).hexdigest() != before:
        raise NativeContractError("CMake snapshot cache changed or exceeds its size limit")
    values = re.findall(rb"^FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256:[^=\r\n]+=([^\r\n]*)$", payload, re.MULTILINE)
    if values != [snapshot.encode("ascii")]:
        raise NativeContractError("CMake snapshot does not match the requested source snapshot")


def _safe_evidence_attempt(evidence_root: Path) -> tuple[Path, str]:
    root = Path(evidence_root).absolute()
    current = Path(root.anchor)
    for component in root.parts[1:]:
        current = current / component
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            try:
                current.mkdir(mode=0o700)
            except FileExistsError:
                pass
            except OSError as error:
                raise NativeContractError(f"cannot create native contract evidence directory: {current}") from error
            try:
                metadata = current.lstat()
            except OSError as error:
                raise NativeContractError(f"cannot inspect native contract evidence directory: {current}") from error
        except OSError as error:
            raise NativeContractError(f"cannot inspect native contract evidence directory: {current}") from error
        if stat.S_ISLNK(metadata.st_mode):
            raise NativeContractError(f"native contract evidence path must not be a symlink: {current}")
        if not stat.S_ISDIR(metadata.st_mode):
            raise NativeContractError(f"native contract evidence path is not a directory: {current}")
    attempt_id = uuid.uuid4().hex
    attempt = root / f"attempt-{attempt_id}"
    try:
        attempt.mkdir(mode=0o700, exist_ok=False)
    except OSError as error:
        raise NativeContractError(f"cannot create exclusive native contract attempt: {attempt}") from error
    _require_directory(attempt, "native contract attempt directory")
    directory_fd = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    return attempt, attempt_id


def _json_requested_value(requested: Any) -> list[Any]:
    if isinstance(requested, (str, bytes)):
        values: list[Any] = [requested]
    else:
        try:
            values = list(requested) if requested is not None else []
        except TypeError:
            values = [repr(requested)]
    safe: list[Any] = []
    for value in values[:64]:
        if isinstance(value, float) and not math.isfinite(value):
            safe.append(repr(value))
        else:
            safe.append(value if isinstance(value, (str, int, float, bool)) or value is None else repr(value))
    return safe


def _new_report(
    *,
    attempt_id: str,
    requested: list[Any],
    source_snapshot_sha256: str,
) -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "contract_revision": CONTRACT_REVISION,
        "state": "running",
        "source_snapshot_sha256": source_snapshot_sha256,
        "requested": requested,
        "attempt_id": attempt_id,
        "contracts": {},
        "evidence": {
            "report_path": f"attempt-{attempt_id}/report.json",
            "log_path": f"attempt-{attempt_id}/native-contract.log",
            "log_sha256": None,
            "log_size_bytes": 0,
        },
    }


def _write_terminal_report(report: dict[str, Any], attempt: Path) -> Path:
    report_path = attempt / "report.json"
    payload = (json.dumps(report, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
    try:
        with report_path.open("xb") as output:
            if not stat.S_ISREG(os.fstat(output.fileno()).st_mode):
                raise NativeContractError("native contract report is not a regular file")
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        directory_fd = os.open(attempt, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError as error:
        raise NativeContractError(f"cannot persist native contract receipt: {report_path}", report=report) from error
    return report_path


def _write_log_header(log_file: Any, text: str) -> None:
    encoded = (text + "\n").encode("utf-8")
    remaining = MAX_LOG_BYTES - log_file.tell()
    if len(encoded) > remaining:
        log_file.write(encoded[: max(0, remaining)])
        log_file.flush()
        raise _LogLimitExceeded("native contract log exceeded 16 MiB")
    log_file.write(encoded)
    log_file.flush()


def _session_has_live_processes(session_id: int) -> bool:
    # A zombie cannot mutate build files. The command leader stays unreaped
    # until this check succeeds, reserving the session identity during proof.
    Path("/proc/self/stat").read_bytes()
    for status in Path("/proc").glob("[0-9]*/stat"):
        try:
            fields = status.read_bytes().rsplit(b")", 1)[1].split()
        except FileNotFoundError:
            continue
        if int(fields[3]) == session_id and fields[0] not in {b"Z", b"X"}:
            return True
    return False


def _terminate_command_group(process: subprocess.Popen) -> None:
    """Never publish failure or release the build lock before quiescence."""
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except OSError:
        # Signalling failure is not proof of termination. Retain ownership
        # while the command/session finishes rather than cleaning its files.
        pass
    while True:
        try:
            if not _session_has_live_processes(process.pid):
                break
        except (OSError, ValueError, IndexError):
            # An unavailable observation must not become a terminal receipt.
            pass
        time.sleep(0.01)
    process.wait()


def _run_command(
    argv: list[str],
    *,
    cwd: Path,
    environment: Mapping[str, str],
    log_file: Any,
) -> dict[str, Any]:
    started = time.monotonic()
    record: dict[str, Any] = {
        "state": "failed",
        "exit_code": None,
        "argv": argv,
        "duration_seconds": 0.0,
    }
    try:
        _write_log_header(log_file, "$ " + json.dumps(argv, ensure_ascii=False))
        process = subprocess.Popen(
            argv,
            cwd=str(cwd),
            env=dict(environment),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            shell=False,
            start_new_session=True,
        )
    except _LogLimitExceeded:
        record["reason"] = "log_limit_exceeded"
        record["duration_seconds"] = max(0.0, time.monotonic() - started)
        return record
    except OSError as error:
        _append_diagnostic(log_file, f"command could not start: {error}")
        record["reason"] = "command_start_failed"
        record["error"] = str(error)
        record["duration_seconds"] = max(0.0, time.monotonic() - started)
        return record

    exceeded = False
    try:
        stream = process.stdout
        if stream is None:
            raise NativeContractError("native contract command has no captured output stream")
        while True:
            block = stream.read(64 * 1024)
            if not block:
                break
            remaining = MAX_LOG_BYTES - log_file.tell()
            if len(block) > remaining:
                if remaining > 0:
                    log_file.write(block[:remaining])
                    log_file.flush()
                exceeded = True
                _terminate_command_group(process)
                break
            log_file.write(block)
            log_file.flush()
        record["exit_code"] = process.wait()
    except Exception as error:
        _terminate_command_group(process)
        record["exit_code"] = process.wait()
        record["error"] = str(error)
        record["reason"] = "command_capture_failed"
    finally:
        if process.stdout is not None:
            process.stdout.close()
        record["duration_seconds"] = max(0.0, time.monotonic() - started)

    if exceeded:
        record["reason"] = "log_limit_exceeded"
    elif record.get("reason") is None and record["exit_code"] == 0:
        record["state"] = "succeeded"
    else:
        record["reason"] = record.get("reason") or "nonzero_exit"
    return record


def _append_diagnostic(log_file: Any, message: str) -> None:
    encoded = (message + "\n").encode("utf-8", errors="replace")
    remaining = MAX_LOG_BYTES - log_file.tell()
    if remaining > 0:
        log_file.write(encoded[:remaining])
        log_file.flush()


def _finish_report(report: dict[str, Any], attempt: Path, log_file: Any) -> Path:
    log_file.flush()
    os.fsync(log_file.fileno())
    log_file.close()
    log_path = attempt / "native-contract.log"
    log_sha = _hash_regular_file(log_path)
    log_size = log_path.stat().st_size
    report["evidence"]["log_sha256"] = log_sha
    report["evidence"]["log_size_bytes"] = log_size
    return _write_terminal_report(report, attempt)


def prepare_contracts(
    *, requested: Sequence[str], native_build_root: Path, evidence_root: Path,
    source_snapshot_sha256: str, environment: Mapping[str, str], jobs: int,
) -> dict[str, Any]:
    """Compile before Make copies the FEM library; this is not a test pass."""
    contract_ids = normalize_contracts(requested)
    if len(contract_ids) != 1:
        raise NativeContractError("native preparation requires the allowlisted contract")
    contract_id = contract_ids[0]
    attempt, attempt_id = _safe_evidence_attempt(evidence_root)
    report = _new_report(attempt_id=attempt_id, requested=list(contract_ids),
                         source_snapshot_sha256=source_snapshot_sha256)
    report["state"] = "failed"
    log_file = (attempt / "native-contract.log").open("xb")
    try:
        if not _valid_sha256(source_snapshot_sha256):
            raise NativeContractError("source snapshot SHA-256 is invalid")
        if type(jobs) is not int or jobs <= 0:
            raise NativeContractError("native contract parallel job count must be a positive integer")
        native_root = Path(native_build_root).absolute()
        _require_directory(native_root, "native build root")
        _require_cmake_snapshot(native_root, source_snapshot_sha256)
        compile_argv = [environment.get("FULLMAG_CMAKE", "cmake"), "--build", str(native_root),
                        "--target", CONTRACT_TARGETS[contract_id], "--parallel", str(jobs)]
        if not _expected_compile_argv(compile_argv, contract_id):
            raise NativeContractError("invalid native preparation CMake command")
        contract: dict[str, Any] = {"state": "failed", "contract_revision": CONTRACT_REVISION}
        report["contracts"][contract_id] = contract
        contract["compile"] = _run_command(compile_argv, cwd=native_root,
                                            environment=environment, log_file=log_file)
        if not _command_succeeded(contract["compile"], kind="compile", contract_id=contract_id):
            raise NativeContractError("native contract preparation compile failed")
        _require_cmake_snapshot(native_root, source_snapshot_sha256)
        contract["library_sha256"] = _build_library_sha256(native_root)
        contract["test_binary_sha256"] = _hash_regular_file(native_root / _test_binary_path(contract_id))
        contract["state"] = "compiled"
        report["state"] = "compiled"
    except Exception as error:
        report["error"] = str(error)
        _append_diagnostic(log_file, f"native contract preparation failed: {error}")
    receipt_path = _finish_report(report, attempt, log_file)
    if report["state"] != "compiled":
        raise NativeContractError(report["error"], report=report, receipt_path=receipt_path)
    return report


def _valid_evidence(report: Mapping[str, Any]) -> bool:
    evidence = report.get("evidence")
    attempt_id = report.get("attempt_id")
    return (
        isinstance(evidence, Mapping) and isinstance(attempt_id, str)
        and re.fullmatch(r"[0-9a-f]{32}", attempt_id) is not None
        and _valid_sha256(evidence.get("log_sha256"))
        and type(evidence.get("log_size_bytes")) is int
        and 0 <= evidence["log_size_bytes"] <= MAX_LOG_BYTES
        and evidence.get("log_path") == f"attempt-{attempt_id}/native-contract.log"
        and evidence.get("report_path") == f"attempt-{attempt_id}/report.json"
    )


def _preparation_matches(report: Any, snapshot: str, contract_id: str = FEM_DEMAG_POISSON) -> bool:
    if not isinstance(report, Mapping) or (
        report.get("schema") != SCHEMA
        or type(report.get("contract_revision")) is not int
        or report.get("contract_revision") != CONTRACT_REVISION
        or report.get("state") != "compiled"
        or report.get("source_snapshot_sha256") != snapshot
        or not _valid_sha256(snapshot)
        or report.get("requested") != [contract_id]
        or not _valid_evidence(report)
    ):
        return False
    contracts = report.get("contracts")
    if not isinstance(contracts, Mapping) or set(contracts) != {contract_id}:
        return False
    contract = contracts[contract_id]
    return (
        isinstance(contract, Mapping) and contract.get("state") == "compiled"
        and type(contract.get("contract_revision")) is int
        and contract.get("contract_revision") == CONTRACT_REVISION
        and _command_succeeded(contract.get("compile"), kind="compile", contract_id=contract_id)
        and _valid_sha256(contract.get("library_sha256"))
        and _valid_sha256(contract.get("test_binary_sha256"))
    )


def _read_preparation(root: Path, native_root: Path, snapshot: str, jobs: int,
                      contract_id: str = FEM_DEMAG_POISSON) -> dict[str, Any]:
    """Reject missing, ambiguous, stale or changed pre-copy compilation evidence."""
    root = root.absolute()
    for path in reversed((root, *root.parents)):
        _require_directory(path, "native preparation evidence directory")
    entries = list(itertools.islice(root.iterdir(), 2))
    if len(entries) != 1 or re.fullmatch(r"attempt-[0-9a-f]{32}", entries[0].name) is None:
        raise NativeContractError("native preparation requires exactly one attempt")
    attempt = entries[0]
    _require_directory(attempt, "native preparation attempt")
    receipt = attempt / "report.json"
    before = _hash_regular_file(receipt)
    with receipt.open("rb") as source:
        payload = source.read(1024 * 1024 + 1)
    if len(payload) > 1024 * 1024 or hashlib.sha256(payload).hexdigest() != before or before != _hash_regular_file(receipt):
        raise NativeContractError("native preparation report changed or exceeds its size limit")
    report = json.loads(payload)
    if not _preparation_matches(report, snapshot, contract_id) or attempt.name != "attempt-" + report["attempt_id"]:
        raise NativeContractError("native preparation does not match this contract and snapshot")
    contract = report["contracts"][contract_id]
    _require_cmake_snapshot(native_root, snapshot)
    argv = contract["compile"]["argv"]
    log_path = attempt / "native-contract.log"
    if (
        argv[2] != str(native_root) or argv[6] != str(jobs)
        or _hash_regular_file(log_path) != report["evidence"]["log_sha256"]
        or log_path.stat().st_size != report["evidence"]["log_size_bytes"]
        or _build_library_sha256(native_root) != contract["library_sha256"]
        or _hash_regular_file(native_root / _test_binary_path(contract_id)) != contract["test_binary_sha256"]
    ):
        raise NativeContractError("native preparation inputs, command or log changed")
    return report


def run_contracts(
    *,
    requested: Sequence[str] | None,
    native_build_root: Path,
    package_root: Path,
    evidence_root: Path,
    source_snapshot_sha256: str,
    environment: Mapping[str, str],
    jobs: int,
    preparation_root: Path | None = None,
) -> dict[str, Any]:
    """Run requested native contracts and persist a terminal report plus raw log.

    The evidence directory is private control-volume data. Commands are fixed to
    the allowlisted CMake target and its one executable; callers cannot provide
    arbitrary command fragments or target names.
    """

    if requested is None or isinstance(requested, (str, bytes)):
        request_values = requested
    else:
        try:
            request_values = tuple(requested)
        except TypeError:
            request_values = requested
    raw_requested = _json_requested_value(request_values)
    normalize_error: Exception | None = None
    try:
        contract_ids = normalize_contracts(request_values)
    except (TypeError, ValueError) as error:
        contract_ids = ()
        normalize_error = error

    if normalize_error is None and not contract_ids:
        return {
            "schema": SCHEMA,
            "contract_revision": CONTRACT_REVISION,
            "state": "skipped",
            "source_snapshot_sha256": source_snapshot_sha256,
            "requested": [],
            "contracts": {},
            "evidence": None,
        }

    attempt, attempt_id = _safe_evidence_attempt(Path(evidence_root))
    report = _new_report(
        attempt_id=attempt_id,
        requested=list(contract_ids) if normalize_error is None else raw_requested,
        source_snapshot_sha256=(
            source_snapshot_sha256
            if isinstance(source_snapshot_sha256, str)
            else repr(source_snapshot_sha256)
        ),
    )
    report["state"] = "failed"
    log_path = attempt / "native-contract.log"
    try:
        log_file = log_path.open("xb")
    except OSError as error:
        raise NativeContractError(f"cannot create exclusive native contract log: {log_path}", report=report) from error
    if not stat.S_ISREG(os.fstat(log_file.fileno()).st_mode):
        log_file.close()
        raise NativeContractError(f"native contract log is not a regular file: {log_path}", report=report)

    receipt_path: Path | None = None
    error_message: str | None = None
    try:
        if normalize_error is not None:
            raise NativeContractError(f"invalid native contract request: {normalize_error}")
        if not _valid_sha256(source_snapshot_sha256):
            raise NativeContractError("source snapshot SHA-256 is invalid")
        if type(jobs) is not int or jobs <= 0:
            raise NativeContractError("native contract parallel job count must be a positive integer")
        if not isinstance(environment, Mapping) or any(
            not isinstance(key, str) or not isinstance(value, str) or "\x00" in key or "\x00" in value
            for key, value in environment.items()
        ):
            raise NativeContractError("native contract environment must contain string keys and values")
        native_root = Path(native_build_root).absolute()
        package = Path(package_root).absolute()
        _require_directory(native_root, "native build root")
        _require_directory(package, "native package root")
        build_backends = native_root / "backends"
        build_fem = build_backends / "fem"
        _require_directory(build_backends, "native build backends directory")
        _require_directory(build_fem, "native FEM build directory")
        package_lib_dir = package / "lib"
        _require_directory(package_lib_dir, "native package library directory")

        contract_id = contract_ids[0]
        compile_argv = [
            "cmake",
            "--build",
            str(native_root),
            "--target",
            CONTRACT_TARGETS[contract_id],
            "--parallel",
            str(jobs),
        ]
        test_binary = native_root / _test_binary_path(contract_id)
        test_argv = [str(test_binary)]
        build_lib_dir = native_root / BUILD_LIBRARY_RELATIVE_PATH.parent
        command_environment = dict(environment)
        prior_library_path = command_environment.get("LD_LIBRARY_PATH", "")
        command_environment["LD_LIBRARY_PATH"] = (
            str(build_lib_dir) + (os.pathsep + prior_library_path if prior_library_path else "")
        )

        contract: dict[str, Any] = {
            "contract_revision": CONTRACT_REVISION,
            "state": "failed",
            "compile": {
                "state": "not_run",
                "exit_code": None,
                "argv": compile_argv,
                "duration_seconds": 0.0,
            },
            "test": {
                "state": "not_run",
                "exit_code": None,
                "argv": test_argv,
                "duration_seconds": 0.0,
            },
            "test_binary": {
                "path": _test_binary_path(contract_id).as_posix(),
                "sha256_before": None,
                "sha256_after": None,
            },
            "libraries": {
                "build": {
                    "path": BUILD_LIBRARY_RELATIVE_PATH.as_posix(),
                    "sha256": None,
                },
                "package": {
                    "path": PACKAGE_LIBRARY_ARTIFACT_PATH,
                    "sha256": None,
                },
            },
        }
        report["contracts"][contract_id] = contract

        package_hash_before = _package_library_sha256(package)
        if preparation_root is None:
            contract["compile"] = _run_command(
                compile_argv, cwd=native_root,
                environment=command_environment, log_file=log_file,
            )
        else:
            try:
                prepared = _read_preparation(Path(preparation_root), native_root, source_snapshot_sha256, jobs, contract_id)
            except Exception as error:
                raise NativeContractError(f"native contract preparation rejected: {error}") from error
            report["preparation"] = prepared
            report["preparation_root"] = str(Path(preparation_root).absolute())
            contract["compile"] = prepared["contracts"][contract_id]["compile"]
            _append_diagnostic(log_file, f"compile evidence: {preparation_root}/{prepared['evidence']['report_path']}")
        if contract["compile"]["state"] != "succeeded":
            reason = contract["compile"].get("reason", "compile_failed")
            raise NativeContractError(f"native contract compile failed: {reason}")

        build_library_hash = _build_library_sha256(native_root)
        package_library_hash = _package_library_sha256(package)
        if package_hash_before != package_library_hash:
            raise NativeContractError("packaged FEM library changed during native contract compilation")
        if build_library_hash != package_library_hash:
            raise NativeContractError("built FEM library does not match the installed package library")
        contract["libraries"]["build"]["sha256"] = build_library_hash
        contract["libraries"]["package"]["sha256"] = package_library_hash

        contract["test_binary"]["sha256_before"] = _hash_regular_file(test_binary)
        _require_soname_matches(package / PACKAGE_LIBRARY_ARTIFACT_PATH, package, package_library_hash)
        if preparation_root is not None:
            prepared_contract = report["preparation"]["contracts"][contract_id]
            if (
                contract["test_binary"]["sha256_before"] != prepared_contract["test_binary_sha256"]
                or build_library_hash != prepared_contract["library_sha256"]
            ):
                raise NativeContractError("prepared binary or library changed before test execution")
        contract["test"] = _run_command(
            test_argv,
            cwd=native_root,
            environment=command_environment,
            log_file=log_file,
        )
        contract["test_binary"]["sha256_after"] = _hash_regular_file(test_binary)
        build_library_hash_after = _build_library_sha256(native_root)
        package_library_hash_after = _package_library_sha256(package)
        if contract["test_binary"]["sha256_before"] != contract["test_binary"]["sha256_after"]:
            raise NativeContractError("native contract test binary changed while it was executing")
        if build_library_hash_after != build_library_hash:
            raise NativeContractError("built FEM library changed while the native contract was executing")
        if package_library_hash_after != package_library_hash:
            raise NativeContractError("packaged FEM library changed while the native contract was executing")
        _require_soname_matches(package / PACKAGE_LIBRARY_ARTIFACT_PATH, package, package_library_hash_after)
        if contract["test"]["state"] != "succeeded":
            reason = contract["test"].get("reason", "test_failed")
            raise NativeContractError(f"native contract test failed: {reason}")
        contract["state"] = "passed"
        report["state"] = "succeeded"
    except Exception as error:
        error_message = str(error)
        report["state"] = "failed"
        if contract_ids:
            contract = report["contracts"].get(contract_ids[0])
            if isinstance(contract, dict):
                contract["state"] = "failed"
        _append_diagnostic(log_file, f"native contract gate failed: {error_message}")

    if error_message is not None:
        report["error"] = error_message
    try:
        receipt_path = _finish_report(report, attempt, log_file)
    except Exception as error:
        try:
            if not log_file.closed:
                log_file.close()
        except Exception:
            pass
        raise NativeContractError(
            f"could not persist terminal native contract evidence: {error}",
            report=report,
            receipt_path=receipt_path,
        ) from error
    if report["state"] != "succeeded":
        raise NativeContractError(
            error_message or "native contract gate failed",
            report=report,
            receipt_path=receipt_path,
        )
    return report


def receipt_satisfies(
    report: Mapping[str, Any] | None,
    *,
    requested: Sequence[str] | None,
    source_snapshot_sha256: str,
    package_root: Path | None = None,
    package_library_sha256: str | None = None,
) -> bool:
    """Check an attestation, optionally against a restored package directory.

    When ``package_root`` is absent, the caller must supply the FEM library hash
    from an already-verified build receipt artifact table. This binds producer
    receipts before a shared-package restore has materialized the candidate.
    """

    try:
        contract_ids = normalize_contracts(requested)
    except (TypeError, ValueError):
        return False
    if not contract_ids:
        return True
    if not isinstance(report, Mapping):
        return False
    if (
        report.get("schema") != SCHEMA
        or report.get("contract_revision") != CONTRACT_REVISION
        or type(report.get("contract_revision")) is not int
        or report.get("state") != "succeeded"
        or report.get("source_snapshot_sha256") != source_snapshot_sha256
        or not _valid_sha256(source_snapshot_sha256)
        or report.get("requested") != list(contract_ids)
    ):
        return False
    contracts = report.get("contracts")
    if not isinstance(contracts, Mapping) or set(contracts) != set(contract_ids):
        return False
    if not _valid_evidence(report):
        return False

    for contract_id in contract_ids:
        contract = contracts.get(contract_id)
        if not isinstance(contract, Mapping):
            return False
        if (
            type(contract.get("contract_revision")) is not int
            or contract.get("contract_revision") != CONTRACT_REVISION
            or contract.get("state") != "passed"
            or not _command_succeeded(contract.get("compile"), kind="compile", contract_id=contract_id)
            or not _command_succeeded(contract.get("test"), kind="test", contract_id=contract_id)
        ):
            return False
        compile_argv = contract["compile"]["argv"]
        test_argv = contract["test"]["argv"]
        if Path(test_argv[0]) != Path(compile_argv[2]) / _test_binary_path(contract_id):
            return False
        binary = contract.get("test_binary")
        if (
            not isinstance(binary, Mapping)
            or binary.get("path") != _test_binary_path(contract_id).as_posix()
            or not _valid_sha256(binary.get("sha256_before"))
            or binary.get("sha256_before") != binary.get("sha256_after")
        ):
            return False
        libraries = contract.get("libraries")
        if not isinstance(libraries, Mapping):
            return False
        build_library = libraries.get("build")
        package_library = libraries.get("package")
        if (
            not isinstance(build_library, Mapping)
            or build_library.get("path") != BUILD_LIBRARY_RELATIVE_PATH.as_posix()
            or not _valid_sha256(build_library.get("sha256"))
            or not isinstance(package_library, Mapping)
            or package_library.get("path") != PACKAGE_LIBRARY_ARTIFACT_PATH
            or not _valid_sha256(package_library.get("sha256"))
            or build_library["sha256"] != package_library["sha256"]
        ):
            return False
        if "preparation" in report or "preparation_root" in report:
            prepared = report.get("preparation")
            preparation_root = report.get("preparation_root")
            if (
                not _preparation_matches(prepared, source_snapshot_sha256, contract_id)
                or not isinstance(preparation_root, str) or not Path(preparation_root).is_absolute()
            ):
                return False
            prepared_contract = prepared["contracts"][contract_id]
            if (
                prepared_contract["compile"] != contract["compile"]
                or prepared_contract["library_sha256"] != build_library["sha256"]
                or prepared_contract["test_binary_sha256"] != binary["sha256_before"]
            ):
                return False

    for contract_id in contract_ids:
        report_package_hash = _report_package_library_sha256(report, contract_id)
        if package_root is None:
            if not _valid_sha256(package_library_sha256) or package_library_sha256 != report_package_hash:
                return False
        else:
            package = Path(package_root)
            try:
                _require_directory(package, "native package root")
                actual_package_hash = _package_library_sha256(package)
                _require_soname_matches(package / PACKAGE_LIBRARY_ARTIFACT_PATH, package, actual_package_hash)
            except (OSError, NativeContractError):
                return False
            if actual_package_hash != report_package_hash:
                return False
            if package_library_sha256 is not None and (
                not _valid_sha256(package_library_sha256)
                or package_library_sha256 != actual_package_hash
            ):
                return False
    return True


__all__ = [
    "ALLOWED_CONTRACTS",
    "BUILD_LIBRARY_RELATIVE_PATH",
    "CONTRACT_REVISION",
    "FEM_DEMAG_POISSON",
    "FEM_CUDA_ACTIVITY_TRACE",
    "CONTRACT_TARGETS",
    "MAX_LOG_BYTES",
    "NativeContractError",
    "PACKAGE_LIBRARY_ARTIFACT_PATH",
    "SCHEMA",
    "TEST_BINARY_RELATIVE_PATH",
    "normalize_contracts",
    "prepare_contracts",
    "receipt_satisfies",
    "run_contracts",
]


def _main(argv: Sequence[str]) -> int:
    if list(argv) != ["prepare"]:
        print("usage: backend_native_contracts.py prepare", file=sys.stderr)
        return 2
    try:
        if os.environ.get("FULLMAG_DIRECT_COMPOSE") != "1":
            raise NativeContractError("native preparation requires managed direct Compose")
        native_root = Path(os.environ["FULLMAG_FEM_NATIVE_BUILD_ROOT"])
        evidence_root = Path(os.environ["FULLMAG_INTERNAL_NATIVE_CONTRACT_PREPARATION_ROOT"])
        if not native_root.is_absolute() or not evidence_root.is_absolute():
            raise NativeContractError("native preparation paths must be absolute")
        report = prepare_contracts(
            requested=[os.environ["FULLMAG_INTERNAL_NATIVE_CONTRACTS"]],
            native_build_root=native_root, evidence_root=evidence_root,
            source_snapshot_sha256=os.environ["FULLMAG_SOURCE_SNAPSHOT_SHA256"],
            environment=os.environ.copy(), jobs=int(os.environ["CARGO_BUILD_JOBS"]),
        )
        print(f"native contract compiled: {evidence_root}/{report['evidence']['report_path']}")
        return 0
    except (KeyError, ValueError, OSError, NativeContractError) as error:
        print(f"native contract preparation failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
