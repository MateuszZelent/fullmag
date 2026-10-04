"""Cross-host reader/writer admission for managed storage retention.

Windows byte-range locks and Linux flock are not assumed to interoperate on a
Docker Desktop bind mount. An atomic directory gate serializes admission only;
durable reader tickets allow independent runtimes to continue concurrently.
Unknown tickets and interrupted gates are protective, never expired by age.
"""
from contextlib import contextmanager
import os
import socket
import time
import uuid

from fullmag_storage import StorageError, atomic_json
from local_runner.retention import _canonical_storage, _checked_child, _PathIssue, _read_json


def _checked_directory(storage, path):
    try:
        return _checked_child(storage, path.relative_to(storage).parts, kind='directory')
    except _PathIssue as error:
        raise StorageError('Unsafe storage admission directory: ' + str(path)) from error


def _ensure_directory(storage, path):
    if not os.path.lexists(path):
        path.mkdir(exist_ok=True)
    return _checked_directory(storage, path)


def _paths(layout):
    storage = _canonical_storage(layout['storage_root'])
    locks = _ensure_directory(storage, storage / 'locks')
    return storage, locks


def _owned_record(token, purpose):
    return {'token': token, 'purpose': purpose, 'host': socket.gethostname(),
            'pid': os.getpid(), 'created_at': time.time()}


def _remove_owned(storage, directory, token):
    """Remove only our attested tiny record; foreign contents remain protective."""
    directory = _checked_directory(storage, directory)
    record = directory / 'owner.json'
    if _read_json(record).get('token') != token:
        raise StorageError('Storage admission ownership changed: ' + str(directory))
    if {item.name for item in directory.iterdir()} != {'owner.json'}:
        raise StorageError('Storage admission contains unknown data: ' + str(directory))
    record.unlink()
    directory.rmdir()


@contextmanager
def _admission_gate(layout, purpose):
    storage, locks = _paths(layout)
    gate = locks / 'retention-admission'
    token = uuid.uuid4().hex
    deadline = time.monotonic() + 3.0
    while True:
        try:
            gate.mkdir()
            break
        except FileExistsError as error:
            _checked_directory(storage, gate)
            if time.monotonic() >= deadline:
                raise StorageError('Storage retention admission is busy or needs recovery: ' + str(gate)) from error
            time.sleep(0.05)
    # A crash, including before the record is written, leaves a protective gate.
    atomic_json(gate / 'owner.json', _owned_record(token, purpose))
    try:
        yield storage, locks
    finally:
        _remove_owned(storage, gate, token)


@contextmanager
def retention_mutation_guard(layout):
    """Prevent runtime admission throughout a validated cleanup or compaction."""
    with _admission_gate(layout, 'storage retention') as (storage, locks):
        users = locks / 'runtime-users'
        if os.path.lexists(users):
            _checked_directory(storage, users)
            if any(users.iterdir()):
                raise StorageError('Storage has active or unknown runtime users: ' + str(users))
        yield


@contextmanager
def runtime_package_use(layout):
    """Hold until a durable consumer receipt and its container are established.

    Short-lived exporters hold this guard through receipt publication. Scientific
    pilots hold it for the run. After a GUI launcher returns, its attested mount
    and retained receipt protect the package independently of the host process.
    """
    token = uuid.uuid4().hex
    with _admission_gate(layout, 'runtime admission') as (storage, locks):
        users = _ensure_directory(storage, locks / 'runtime-users')
        ticket = users / token
        ticket.mkdir()
        atomic_json(ticket / 'owner.json', _owned_record(token, 'managed runtime package use'))
    try:
        yield
    finally:
        with _admission_gate(layout, 'runtime release'):
            _remove_owned(storage, ticket, token)
