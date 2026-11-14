"""Hold the five existing native writer locks during an authorized copy."""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import json
import math
import os
from pathlib import Path
import stat


SCHEMA = "fullmag.data-volume-copy-fences.v1"


class _FrozenDict(dict):
    """Dict-compatible immutable JSON object."""

    def __init__(self, values):
        dict.__init__(self)
        for key, value in values.items():
            dict.__setitem__(self, key, value)

    @staticmethod
    def _immutable(*_args, **_kwargs):
        raise TypeError("copy-fence observation is immutable")

    __setitem__ = _immutable
    __delitem__ = _immutable
    clear = _immutable
    pop = _immutable
    popitem = _immutable
    setdefault = _immutable
    update = _immutable
    __ior__ = _immutable


def _fail(message: str) -> None:
    raise ValueError(message)


def _root_path(value, label: str) -> Path:
    if not isinstance(value, (str, os.PathLike)):
        _fail(f"{label} must be an absolute path")
    try:
        path = Path(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be an absolute path") from error
    if not path.is_absolute() or ".." in path.parts:
        _fail(f"{label} must be absolute and contain no parent traversal")
    return path


def _open_existing(path: Path, flags: int) -> int:
    if __package__:
        from .docker_volume_linux_supervision_stop import open_existing
    else:
        from docker_volume_linux_supervision_stop import open_existing
    return open_existing(path, flags)


def _lock_paths(state_root: Path, runtime_control_root: Path, ledger_root: Path):
    owners = runtime_control_root / "runtime-services"
    store = state_root / "runs" / "docker-all" / "session-store"
    return (
        owners / "STARTUP-GATE.lock",
        owners / "LAUNCH.lock",
        owners / "OWNER.lock",
        ledger_root / "WRITER.lock",
        store / "WRITER.lock",
    )


def _pin_descriptor(descriptor: int, path: Path) -> dict:
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        _fail(f"copy fence must be an existing singly linked regular file: {path}")
    return {"device": int(info.st_dev), "inode": int(info.st_ino)}


def _identity(pin: dict) -> tuple[int, int]:
    return pin["device"], pin["inode"]


def _rewalk(records) -> None:
    for record in records:
        path = record["path"]
        expected = record["pin"]
        if _identity(_pin_descriptor(record["fd"], path)) != _identity(expected):
            _fail(f"held copy fence descriptor identity changed: {path}")

        descriptor = _open_existing(path, os.O_RDONLY)
        try:
            observed = _pin_descriptor(descriptor, path)
            if _identity(observed) != _identity(expected):
                _fail(f"copy fence path was replaced: {path}")
        finally:
            os.close(descriptor)


def _json_value(value, label: str):
    if value is None or type(value) in (str, bool, int):
        return value
    if type(value) is float:
        if not math.isfinite(value):
            _fail(f"{label} contains a nonfinite number")
        return value
    if type(value) is list:
        return [_json_value(item, label) for item in value]
    if type(value) is dict:
        if any(type(key) is not str for key in value):
            _fail(f"{label} object keys must be strings")
        return {key: _json_value(item, label) for key, item in value.items()}
    _fail(f"{label} is not JSON-safe")


def _authenticate(authenticate):
    result = authenticate()
    if result is None or type(result) is bool:
        _fail("authenticate must return proof data, not a boolean or null")
    normalized = _json_value(result, "authenticate result")
    try:
        encoded = json.dumps(
            normalized,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        )
        return json.loads(encoded)
    except (TypeError, ValueError, RecursionError) as error:
        raise ValueError("authenticate result is not JSON-safe") from error


def _freeze(value):
    if type(value) is dict:
        return _FrozenDict({key: _freeze(item) for key, item in value.items()})
    if type(value) is list:
        return tuple(_freeze(item) for item in value)
    return value


def _release(records):
    first_error = None
    for record in reversed(records):
        descriptor = record["fd"]
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        except BaseException as error:
            if first_error is None:
                first_error = error
        try:
            os.close(descriptor)
        except BaseException as error:
            if first_error is None:
                first_error = error
    return first_error


@contextmanager
def hold_copy_fences(
    state_root,
    runtime_control_root,
    ledger_root,
    *,
    authenticate,
):
    """Hold existing runtime and writer fences while a caller performs a copy.

    The caller must keep this context open until the root copy has a confirmed
    terminal result. Exiting releases the locks; this primitive does not manage
    a parent process, IPC, admission, or copy lifecycle.
    """

    if not callable(authenticate):
        _fail("authenticate must be a callable proof verifier")
    state_root = _root_path(state_root, "state_root")
    runtime_control_root = _root_path(runtime_control_root, "runtime_control_root")
    ledger_root = _root_path(ledger_root, "ledger_root")
    paths = _lock_paths(state_root, runtime_control_root, ledger_root)

    records = []
    entry_authenticated = False
    primary_error = None
    try:
        for path in paths:
            descriptor = _open_existing(path, os.O_RDONLY)
            try:
                pin = _pin_descriptor(descriptor, path)
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                records.append({"path": path, "fd": descriptor, "pin": pin})
            except BaseException:
                os.close(descriptor)
                raise

        _rewalk(records)
        authentication_result = _authenticate(authenticate)
        _rewalk(records)
        entry_authenticated = True
        observation = _freeze(
            {
                "schema": SCHEMA,
                "locks": [
                    {
                        "path": str(record["path"]),
                        "device": record["pin"]["device"],
                        "inode": record["pin"]["inode"],
                    }
                    for record in records
                ],
                "authentication": authentication_result,
            }
        )
        yield observation
    except BaseException as error:
        primary_error = error
        raise
    finally:
        cleanup_error = None
        if entry_authenticated:
            try:
                _rewalk(records)
            except BaseException as error:
                cleanup_error = error
            else:
                try:
                    _authenticate(authenticate)
                except BaseException as error:
                    cleanup_error = error
                try:
                    _rewalk(records)
                except BaseException as error:
                    if cleanup_error is None:
                        cleanup_error = error

        release_error = _release(records)
        if cleanup_error is None:
            cleanup_error = release_error
        if cleanup_error is not None:
            if primary_error is not None:
                raise primary_error.with_traceback(primary_error.__traceback__) from cleanup_error
            raise cleanup_error
