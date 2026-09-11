#!/usr/bin/env python3
"""Bounded, evidence-producing storage capability probe.

This module deliberately tests filesystem behaviour instead of allowing a
filesystem by name.  It is a Linux probe used by the container runner.  The
public :func:`probe` function returns a report even when a target is invalid or
the host is not Linux; callers can therefore preserve a failed report rather
than treating an exception as a capability receipt.

The probe creates one uniquely named child below the approved target and keeps
it as evidence.  It never removes an existing path and its CLI publishes a
report only to a new output path.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import mmap
import os
from pathlib import Path
import select
import stat
import subprocess
import sys
import time
import uuid
from typing import Any, Callable


SCHEMA = "fullmag.storage-capabilities.v1"
QUALIFICATION = "NOT VERIFIED"
ROLES = ("source", "artifact", "build")

# These names are part of the report contract.  The source role deliberately
# checks only candidate write/read behaviour; a source bind mount is later
# made read-only by the worker and that mount is not writable proof.
ROLE_CHECKS = {
    "source": ("write_read_hash",),
    "artifact": (
        "write_read_hash",
        "exclusive_create",
        "replace_dir_fsync",
        "flock",
    ),
    "build": (
        "write_read_hash",
        "exclusive_create",
        "replace_dir_fsync",
        "flock",
        "case_sensitivity",
        "links",
        "exec",
        "mmap",
        "same_fs_rename",
    ),
}


class CapabilityError(RuntimeError):
    """A fail-closed target or capability error."""


def _is_linux() -> bool:
    return sys.platform.startswith("linux")


def _display_error(error: BaseException) -> str:
    message = str(error).strip()
    return f"{type(error).__name__}: {message}" if message else type(error).__name__


def _is_link(path: Path) -> bool:
    """Return whether *path* is a symlink or a Windows reparse point."""

    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    # Python exposes the Windows reparse-point bit through st_file_attributes.
    # Checking it here keeps junctions out of the approved target boundary.
    return bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _absolute_path(value: os.PathLike[str] | str, label: str) -> Path:
    try:
        candidate = Path(value).expanduser()
    except (TypeError, ValueError) as error:
        raise CapabilityError(f"{label} is not a valid path: {value!r}") from error
    if not candidate.is_absolute():
        raise CapabilityError(f"{label} must be absolute: {value}")
    # abspath is lexical and does not follow a redirect.  This is intentional:
    # every component below is checked with lstat before the path is accepted.
    return Path(os.path.abspath(os.fspath(candidate)))


def _reject_link_ancestors(path: Path, label: str) -> None:
    """Reject symlinks/junctions in every existing component of *path*."""

    current = Path(path.anchor)
    # pathlib.parts preserves the lexical path after the anchor.  On Windows
    # the drive/UNC anchor is kept as the first component and is not lstat'ed.
    for part in path.parts[1:]:
        current = current / part
        if _is_link(current):
            raise CapabilityError(f"{label} contains a symlink or reparse point: {current}")


def require_target(
    root: os.PathLike[str] | str,
    allowed_root: os.PathLike[str] | str | None = None,
) -> Path:
    """Validate an existing non-root directory and return its lexical path.

    If ``allowed_root`` is supplied, the target must be a *strict* descendant
    of it.  Both paths and all of their ancestors are checked for symlinks or
    reparse points before containment is evaluated.
    """

    target = _absolute_path(root, "probe root")
    if target == Path(target.anchor) or target.parent == target:
        raise CapabilityError(f"probe root must not be a filesystem root: {target}")
    _reject_link_ancestors(target, "probe root")
    if not target.exists():
        raise CapabilityError(f"probe root does not exist: {target}")
    if not target.is_dir():
        raise CapabilityError(f"probe root is not a directory: {target}")

    if allowed_root is not None:
        allowed = _absolute_path(allowed_root, "allowed root")
        if allowed == Path(allowed.anchor) or allowed.parent == allowed:
            raise CapabilityError(f"allowed root must not be a filesystem root: {allowed}")
        _reject_link_ancestors(allowed, "allowed root")
        if not allowed.exists() or not allowed.is_dir():
            raise CapabilityError(f"allowed root is not an existing directory: {allowed}")
        if target == allowed or allowed not in target.parents:
            raise CapabilityError(
                f"probe root must be a strict descendant of allowed root: {target} under {allowed}"
            )
    return target


def _findmnt_row(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise CapabilityError("findmnt JSON root is not an object")
    rows = payload.get("filesystems")
    if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
        raise CapabilityError("findmnt JSON has no filesystem row")
    return rows[0]


def filesystem_fingerprint(root: Path) -> dict[str, Any]:
    """Return the live mount and stat-device fingerprint for *root*.

    ``findmnt --json`` is intentionally used at both ends of the probe.  A
    changed target, source, filesystem type, option set, or stat device makes
    the report fail closed.
    """

    if not _is_linux():
        raise CapabilityError("storage capability probe requires Linux findmnt JSON support")
    command = [
        "findmnt",
        "--json",
        "--noheadings",
        "--output",
        "TARGET,SOURCE,FSTYPE,OPTIONS",
        "--target",
        str(root),
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise CapabilityError(f"findmnt failed: {_display_error(error)}") from error
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        raise CapabilityError(f"findmnt failed with exit {result.returncode}: {detail}")
    try:
        row = _findmnt_row(json.loads(result.stdout))
    except (ValueError, TypeError, CapabilityError) as error:
        raise CapabilityError(f"invalid findmnt JSON: {error}") from error
    fields = {}
    for name in ("target", "source", "fstype", "options"):
        value = row.get(name.upper())
        if value is None:
            # findmnt's JSON keys are normally lower-case, but accepting the
            # upper-case spelling makes the parser robust to test fixtures.
            value = row.get(name)
        if value is None:
            raise CapabilityError(f"findmnt JSON omitted {name.upper()}")
        fields[name] = str(value)
    try:
        device = int(os.stat(root, follow_symlinks=False).st_dev)
    except OSError as error:
        raise CapabilityError(f"cannot stat probe root: {_display_error(error)}") from error
    fields["stat_device"] = device
    return fields


def _fingerprint_same(first: dict[str, Any], second: dict[str, Any]) -> bool:
    return first == second


def _create_scratch(root: Path) -> Path:
    for _ in range(8):
        candidate = root / f".fullmag-storage-capabilities-{uuid.uuid4().hex}"
        try:
            candidate.mkdir(mode=0o700)
        except FileExistsError:
            continue
        except OSError as error:
            raise CapabilityError(f"cannot create retained probe scratch under {root}: {_display_error(error)}") from error
        if _is_link(candidate):
            raise CapabilityError(f"probe scratch unexpectedly became a symlink: {candidate}")
        return candidate
    raise CapabilityError(f"could not allocate a unique probe scratch under {root}")


def _fsync_directory(directory: Path) -> None:
    if not _is_linux():
        return
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(os.fspath(directory), flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_new(path: Path, payload: bytes) -> None:
    created = False
    descriptor = os.open(
        os.fspath(path),
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
        0o600,
    )
    created = True
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        # The path is our newly created evidence file.  Removing only this
        # path prevents a partial check file from being mistaken for evidence.
        if created:
            try:
                path.unlink()
            except FileNotFoundError:
                pass
        raise


def _read_hash(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while True:
            block = stream.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
            size += len(block)
    return digest.hexdigest(), size


def _check_write_read_hash(scratch: Path) -> dict[str, Any]:
    directory = scratch / "write-read"
    directory.mkdir()
    path = directory / "payload.bin"
    payload = (b"fullmag-storage-capability\0" * 4096)[:65536]
    expected = hashlib.sha256(payload).hexdigest()
    _write_new(path, payload)
    _fsync_directory(directory)
    actual, size = _read_hash(path)
    if actual != expected or size != len(payload):
        raise CapabilityError(f"read hash mismatch: expected {expected}/{len(payload)}, got {actual}/{size}")
    return {
        "bytes": size,
        "sha256": actual,
        "file_fsync": True,
        "directory_fsync": _is_linux(),
    }


def _check_exclusive_create(scratch: Path) -> dict[str, Any]:
    directory = scratch / "exclusive"
    directory.mkdir()
    path = directory / "only-once"
    _write_new(path, b"first\n")
    try:
        with path.open("xb"):
            raise CapabilityError("second exclusive create unexpectedly succeeded")
    except FileExistsError:
        pass
    _fsync_directory(directory)
    return {"path": str(path), "second_create": "rejected"}


def _check_replace_dir_fsync(scratch: Path) -> dict[str, Any]:
    directory = scratch / "replace"
    directory.mkdir()
    destination = directory / "destination"
    replacement = directory / "replacement"
    _write_new(destination, b"before\n")
    _write_new(replacement, b"after\n")
    os.replace(replacement, destination)
    _fsync_directory(directory)
    if destination.read_bytes() != b"after\n" or replacement.exists():
        raise CapabilityError("os.replace did not publish the replacement contents")
    return {"path": str(destination), "directory_fsync": _is_linux()}


def _flock_script(mode: str) -> str:
    if mode == "contender":
        return (
            "import fcntl, sys, time\n"
            "with open(sys.argv[1], 'a+b') as stream:\n"
            "    try:\n"
            "        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)\n"
            "    except BlockingIOError:\n"
            "        print('blocked', flush=True)\n"
            "    else:\n"
            "        print('acquired', flush=True)\n"
            "    time.sleep(30)\n"
        )
    return (
        "import fcntl, sys, time\n"
        "with open(sys.argv[1], 'a+b') as stream:\n"
        "    fcntl.flock(stream, fcntl.LOCK_EX)\n"
        "    print('held', flush=True)\n"
        "    time.sleep(30)\n"
    )


def _terminate_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def _readline_with_timeout(process: subprocess.Popen[str], timeout: float = 3.0) -> str:
    """Read one child status line without allowing a broken child to hang us."""

    stream = process.stdout
    if stream is None:
        return ""
    ready, _, _ = select.select([stream], [], [], timeout)
    if not ready:
        return ""
    return stream.readline().strip()


def _check_flock(scratch: Path) -> dict[str, Any]:
    if not _is_linux():
        raise CapabilityError("flock capability requires Linux fcntl")
    import fcntl

    directory = scratch / "flock"
    directory.mkdir()
    contention = directory / "contention.lock"
    with contention.open("a+b") as parent:
        fcntl.flock(parent, fcntl.LOCK_EX)
        contender = subprocess.Popen(
            [sys.executable, "-c", _flock_script("contender"), str(contention)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            line = _readline_with_timeout(contender)
            if line != "blocked":
                raise CapabilityError(f"flock mutual exclusion was not observed: {line!r}")
        finally:
            _terminate_process(contender)
        fcntl.flock(parent, fcntl.LOCK_UN)

    released = directory / "terminated-child.lock"
    holder = subprocess.Popen(
        [sys.executable, "-c", _flock_script("holder"), str(released)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        line = _readline_with_timeout(holder)
        if line != "held":
            raise CapabilityError(f"lock-holder child did not acquire flock: {line!r}")
    finally:
        _terminate_process(holder)

    acquired_after_termination = False
    with released.open("a+b") as parent:
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                fcntl.flock(parent, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                time.sleep(0.02)
            else:
                acquired_after_termination = True
                fcntl.flock(parent, fcntl.LOCK_UN)
                break
    if not acquired_after_termination:
        raise CapabilityError("flock was not released after terminating the owned child")
    _fsync_directory(directory)
    return {
        "mutual_exclusion": True,
        "terminated_child_released": True,
    }


def _check_case_sensitivity(scratch: Path) -> dict[str, Any]:
    directory = scratch / "case"
    directory.mkdir()
    upper = directory / "Aa"
    lower = directory / "aA"
    _write_new(upper, b"upper\n")
    try:
        _write_new(lower, b"lower\n")
    except FileExistsError as error:
        raise CapabilityError(
            "filesystem is not case-sensitive: distinct names collided "
            "(a v9fs/Windows-style mount may have this weakness)"
        ) from error
    if upper.read_bytes() == lower.read_bytes():
        raise CapabilityError("case-distinct files unexpectedly have identical contents")
    _fsync_directory(directory)
    return {"distinct_names": True, "names": [upper.name, lower.name]}


def _check_links(scratch: Path) -> dict[str, Any]:
    directory = scratch / "links"
    directory.mkdir()
    target = directory / "target"
    hard = directory / "hard"
    symbolic = directory / "symbolic"
    _write_new(target, b"link-target\n")
    try:
        os.link(target, hard)
    except OSError as error:
        raise CapabilityError(f"hardlink creation failed: {_display_error(error)}") from error
    try:
        os.symlink(target.name, symbolic)
    except OSError as error:
        raise CapabilityError(f"symlink creation failed: {_display_error(error)}") from error
    target_stat = os.stat(target)
    hard_stat = os.stat(hard)
    if target_stat.st_dev != hard_stat.st_dev or target_stat.st_ino != hard_stat.st_ino:
        raise CapabilityError("hardlink does not share the target inode")
    if symbolic.read_bytes() != b"link-target\n":
        raise CapabilityError("symlink did not resolve to target contents")
    _fsync_directory(directory)
    return {"hardlink": True, "symlink": True, "same_inode": True}


def _check_exec(scratch: Path) -> dict[str, Any]:
    directory = scratch / "exec"
    directory.mkdir()
    script = directory / "probe-script"
    _write_new(script, b"#!/bin/sh\nprintf 'fullmag-exec\\n'\n")
    script.chmod(0o700)
    _fsync_directory(directory)
    if not (script.stat().st_mode & stat.S_IXUSR):
        raise CapabilityError("chmod did not make the probe script executable")
    try:
        result = subprocess.run(
            [os.fspath(script)],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise CapabilityError(f"executable probe failed: {_display_error(error)}") from error
    if result.returncode:
        raise CapabilityError(f"executable probe returned {result.returncode}: {result.stderr.strip()}")
    if result.stdout != "fullmag-exec\n":
        raise CapabilityError(f"executable probe returned unexpected output: {result.stdout!r}")
    return {"chmod": True, "executed": True, "returncode": result.returncode}


def _check_mmap(scratch: Path) -> dict[str, Any]:
    directory = scratch / "mmap"
    directory.mkdir()
    path = directory / "mapped.bin"
    size = mmap.PAGESIZE
    _write_new(path, b"\0" * size)
    with path.open("r+b") as stream:
        mapping = mmap.mmap(stream.fileno(), size, access=mmap.ACCESS_WRITE)
        try:
            mapping[0:8] = b"mapped-1"
            mapping.flush()
            if mapping[0:8] != b"mapped-1":
                raise CapabilityError("mmap write was not visible through the mapping")
            stream.seek(8)
            stream.write(b"file-2")
            stream.flush()
            os.fsync(stream.fileno())
            if mapping[8:14] != b"file-2":
                raise CapabilityError("file write was not coherent through the mapping")
        finally:
            mapping.close()
    _fsync_directory(directory)
    return {"bytes": size, "mapping_write_visible": True, "file_write_visible": True}


def _check_same_fs_rename(scratch: Path) -> dict[str, Any]:
    parent = scratch / "rename"
    parent.mkdir()
    source = parent / "source"
    destination = parent / "destination"
    source.mkdir()
    (source / "payload").write_bytes(b"rename\n")
    source_device = os.stat(source, follow_symlinks=False).st_dev
    parent_device = os.stat(parent, follow_symlinks=False).st_dev
    if source_device != parent_device:
        raise CapabilityError(
            f"directory rename crosses filesystem devices: source={source_device}, parent={parent_device}"
        )
    os.replace(source, destination)
    _fsync_directory(parent)
    if source.exists() or (destination / "payload").read_bytes() != b"rename\n":
        raise CapabilityError("same-filesystem directory rename did not preserve contents")
    return {"source_device": source_device, "destination_device": os.stat(destination).st_dev}


def _benchmark(scratch: Path) -> dict[str, Any]:
    directory = scratch / "benchmark"
    directory.mkdir()
    path = directory / "payload.bin"
    size = 256 * 1024
    unit = b"fullmag-storage-benchmark\0"
    payload = unit * (size // len(unit) + 1)
    payload = payload[:size]
    started = time.perf_counter()
    _write_new(path, payload)
    _fsync_directory(directory)
    digest, read_size = _read_hash(path)
    elapsed = max(time.perf_counter() - started, 1e-9)
    if read_size != size:
        raise CapabilityError(f"benchmark read size mismatch: expected {size}, got {read_size}")
    return {
        "status": "PASS",
        "bytes": size,
        "megabytes": round(size / (1024 * 1024), 6),
        "elapsed_ms": round(elapsed * 1000, 3),
        "megabytes_per_second": round((size / (1024 * 1024)) / elapsed, 3),
        "sha256": digest,
    }


_CHECK_FUNCTIONS: dict[str, Callable[[Path], dict[str, Any]]] = {
    "write_read_hash": _check_write_read_hash,
    "exclusive_create": _check_exclusive_create,
    "replace_dir_fsync": _check_replace_dir_fsync,
    "flock": _check_flock,
    "case_sensitivity": _check_case_sensitivity,
    "links": _check_links,
    "exec": _check_exec,
    "mmap": _check_mmap,
    "same_fs_rename": _check_same_fs_rename,
}


def _run_check(
    name: str,
    function: Callable[[Path], dict[str, Any]],
    scratch: Path,
    checks: dict[str, Any],
    errors: list[str],
) -> None:
    started = time.perf_counter()
    try:
        detail = function(scratch)
    except Exception as error:  # each check is independent by contract
        checks[name] = {
            "status": "FAIL",
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
            "error": _display_error(error),
        }
        errors.append(f"{name}: {_display_error(error)}")
        return
    checks[name] = {
        "status": "PASS",
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
        **(detail or {}),
    }


def probe(
    root: os.PathLike[str] | str,
    role: str,
    *,
    allowed_root: os.PathLike[str] | str | None = None,
) -> dict[str, Any]:
    """Run the bounded probe and return a self-contained report."""

    if role not in ROLES:
        raise ValueError(f"unknown storage capability role: {role!r}")
    try:
        root_text = os.fspath(root)
    except TypeError:
        root_text = repr(root)
    report: dict[str, Any] = {
        "schema": SCHEMA,
        "role": role,
        "root": str(root_text),
        "fingerprint": {"before": None, "after": None, "stable": False},
        "scratch": None,
        "scratch_retained": False,
        "checks": {},
        "benchmarks": {"status": "NOT_RUN"},
        "errors": [],
        "state": "failed",
        "qualification": QUALIFICATION,
        "notes": [
            "The report is capability evidence only; qualification remains NOT VERIFIED.",
        ],
    }
    if role == "source":
        report["notes"].append(
            "Source probes test candidate writable storage only; an actual read-only source snapshot is not writable proof."
        )

    try:
        target = require_target(root, allowed_root)
    except Exception as error:
        report["errors"].append(f"target: {_display_error(error)}")
        return report
    report["root"] = str(target)

    try:
        before = filesystem_fingerprint(target)
    except Exception as error:
        report["errors"].append(f"fingerprint before: {_display_error(error)}")
        return report
    report["fingerprint"]["before"] = before

    try:
        scratch = _create_scratch(target)
    except Exception as error:
        report["errors"].append(f"scratch: {_display_error(error)}")
        return report
    report["scratch"] = str(scratch)
    report["scratch_retained"] = True

    for name in ROLE_CHECKS[role]:
        _run_check(name, _CHECK_FUNCTIONS[name], scratch, report["checks"], report["errors"])

    if role in ("artifact", "build"):
        try:
            report["benchmarks"] = _benchmark(scratch)
        except Exception as error:
            report["benchmarks"] = {"status": "FAIL", "error": _display_error(error)}
    else:
        report["benchmarks"] = {
            "status": "NOT_RUN",
            "reason": "source role is a write/read diagnostic, not a build-performance gate",
        }

    try:
        after = filesystem_fingerprint(target)
        report["fingerprint"]["after"] = after
        stable = _fingerprint_same(before, after)
        report["fingerprint"]["stable"] = stable
        if not stable:
            report["errors"].append(
                f"fingerprint changed during probe: before={before!r}, after={after!r}"
            )
    except Exception as error:
        report["errors"].append(f"fingerprint after: {_display_error(error)}")

    required = ROLE_CHECKS[role]
    checks_passed = all(report["checks"].get(name, {}).get("status") == "PASS" for name in required)
    report["state"] = "passed" if checks_passed and not report["errors"] and report["fingerprint"]["stable"] else "failed"
    return report


def evaluate_capability_report(report: dict[str, Any]) -> dict[str, Any]:
    """Evaluate report evidence without trusting a caller-supplied pass flag.

    Filesystem type is recorded evidence, not an allow-list.  A v9fs report can
    only be accepted if every role-specific behaviour check actually passed;
    a named filesystem alone never creates a capability.
    """

    errors: list[str] = []
    if not isinstance(report, dict):
        return {"accepted": False, "errors": ["report is not an object"]}
    if report.get("schema") != SCHEMA:
        errors.append("schema is not fullmag.storage-capabilities.v1")
    role = report.get("role")
    if role not in ROLES:
        errors.append(f"unknown role: {role!r}")
        required: tuple[str, ...] = ()
    else:
        required = ROLE_CHECKS[role]
    if report.get("qualification") != QUALIFICATION:
        errors.append("qualification must remain NOT VERIFIED")
    if report.get("state") != "passed":
        errors.append("probe state is not passed")
    fingerprint = report.get("fingerprint")
    required_fingerprint_fields = ("target", "source", "fstype", "options", "stat_device")
    if not isinstance(fingerprint, dict):
        errors.append("filesystem fingerprint is not an object")
    else:
        before = fingerprint.get("before")
        after = fingerprint.get("after")
        if not isinstance(before, dict) or not isinstance(after, dict):
            errors.append("filesystem fingerprint is missing before/after evidence")
        else:
            for phase, value in (("before", before), ("after", after)):
                missing = [field for field in required_fingerprint_fields if field not in value]
                if missing:
                    errors.append(f"filesystem fingerprint {phase} is missing: {', '.join(missing)}")
            if not errors and any(before[field] != after[field] for field in required_fingerprint_fields):
                errors.append("filesystem fingerprint before/after values differ")
        if fingerprint.get("stable") is not True:
            errors.append("filesystem fingerprint is not stable")
    reported_errors = report.get("errors")
    if not isinstance(reported_errors, list):
        errors.append("report errors field is not a list")
    elif reported_errors:
        errors.extend(f"probe error: {item}" for item in reported_errors)
    checks = report.get("checks")
    if not isinstance(checks, dict):
        errors.append("checks field is not an object")
    else:
        for name in required:
            item = checks.get(name)
            if not isinstance(item, dict) or item.get("status") != "PASS":
                errors.append(f"required check did not pass: {name}")
    return {"accepted": not errors, "errors": errors}


def _validate_output(path: os.PathLike[str] | str, forbidden: Path | None = None) -> Path:
    output = _absolute_path(path, "report output")
    _reject_link_ancestors(output.parent, "report output")
    if output == Path(output.anchor):
        raise CapabilityError(f"report output must be a file below a directory: {output}")
    if not output.parent.exists() or not output.parent.is_dir():
        raise CapabilityError(f"report output parent does not exist: {output.parent}")
    if forbidden is not None and (output == forbidden or forbidden in output.parents):
        raise CapabilityError("report output cannot be placed inside retained probe scratch")
    if output.exists() or output.is_symlink():
        raise CapabilityError(f"report output already exists; refusing overwrite: {output}")
    return output


def _write_exclusive(path: Path, payload: bytes) -> None:
    """Write a complete report to a path that did not exist before the call."""

    descriptor = None
    created = False
    try:
        descriptor = os.open(
            os.fspath(path),
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
            0o600,
        )
        created = True
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            descriptor = None
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        if descriptor is not None:
            os.close(descriptor)
        if created:
            try:
                path.unlink()
            except FileNotFoundError:
                pass
        raise


def write_report(path: os.PathLike[str] | str, report: dict[str, Any]) -> Path:
    """Publish JSON to an exclusive new path.

    Linux filesystems that support hard links get complete temp+hardlink
    publication.  A bind-mounted Windows/v9fs evidence directory may reject
    hard links; in that case the function falls back to an exclusive new file,
    writing and fsyncing its complete contents without ever overwriting an
    existing path.  This keeps the evidence path usable while preserving the
    no-overwrite invariant.
    """

    forbidden = None
    scratch = report.get("scratch") if isinstance(report, dict) else None
    if scratch:
        try:
            forbidden = Path(scratch).resolve(strict=True)
        except OSError:
            forbidden = Path(scratch)
    output = _validate_output(path, forbidden)
    payload = (json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    temporary = output.parent / f".{output.name}.{uuid.uuid4().hex}.tmp"
    descriptor = None
    try:
        descriptor = os.open(
            os.fspath(temporary),
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
            0o600,
        )
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            descriptor = None
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        published = False
        try:
            # link() publishes a complete file atomically and refuses to
            # replace an existing output, including a concurrent creator.
            os.link(os.fspath(temporary), os.fspath(output))
            published = True
        except FileExistsError as error:
            raise CapabilityError(f"report output already exists; refusing overwrite: {output}") from error
        except OSError as error:
            if error.errno not in {
                errno.EOPNOTSUPP,
                errno.EXDEV,
                errno.EPERM,
                errno.EINVAL,
            }:
                raise CapabilityError(f"cannot publish report atomically and exclusively: {_display_error(error)}") from error
        if not published:
            # The target is still absent because link() never creates a
            # partial destination.  O_EXCL makes the fallback race-safe with
            # respect to concurrent writers.
            _write_exclusive(output, payload)
        if _is_linux():
            try:
                _fsync_directory(output.parent)
            except OSError:
                # Some host-shared filesystems reject directory fsync although
                # they accepted file fsync.  The report is already complete;
                # retain it and let the capability checks report any relevant
                # storage weakness separately.
                pass
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return output


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, help="existing absolute directory to probe")
    parser.add_argument("--role", required=True, choices=ROLES)
    parser.add_argument("--output", required=True, help="absolute new JSON report path")
    parser.add_argument(
        "--allowed-root",
        help="optional existing boundary; --root must be a strict descendant",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        report = probe(args.root, args.role, allowed_root=args.allowed_root)
        write_report(args.output, report)
    except (CapabilityError, OSError, ValueError, TypeError) as error:
        print(f"storage capability probe failed: {_display_error(error)}", file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if report.get("state") == "passed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
