"""Operational probes for one Docker-owned Windows session namespace."""
import errno
import fcntl
import hashlib
import json
import os
import sqlite3
import stat
import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path('/state')
HOST = Path('/run/fullmag/windows-folder-host.json')
CHECKS = ('file_sync', 'directory_sync', 'atomic_replace', 'atomic_directory_publish',
          'process_lock', 'no_follow_symlink', 'no_follow_junction',
          'sqlite_transactions', 'restart_readback')

_NOFOLLOW = os.O_NOFOLLOW
_DIRECTORY = os.O_DIRECTORY
_CLOEXEC = getattr(os, 'O_CLOEXEC', 0)
_DIRECTORY_FLAGS = os.O_RDONLY | _DIRECTORY | _NOFOLLOW | _CLOEXEC
_READ_FLAGS = os.O_RDONLY | _NOFOLLOW | os.O_NONBLOCK | _CLOEXEC
_REGULAR_FLAGS = os.O_RDWR | _NOFOLLOW | _CLOEXEC
_CREATE_FLAGS = _REGULAR_FLAGS | os.O_CREAT | os.O_EXCL


def _component(name):
    if not isinstance(name, str) or not name or '/' in name or name in ('.', '..'):
        raise RuntimeError('Probe path component is invalid')
    return name


def _open_directory_at(parent_fd, name):
    return os.open(_component(name), _DIRECTORY_FLAGS, dir_fd=parent_fd)


def _open_pinned_directory(path):
    """Open every absolute path component without following a reparse point."""
    path = Path(path)
    if not path.is_absolute() or any(part in ('', '.', '..') for part in path.parts[1:]):
        raise RuntimeError('Probe directory must be an absolute path without traversal')
    fd = os.open('/', _DIRECTORY_FLAGS)
    try:
        for component in path.parts[1:]:
            child = _open_directory_at(fd, component)
            os.close(fd)
            fd = child
        return fd
    except Exception:
        os.close(fd)
        raise


def _open_pinned_parent(path):
    path = Path(path)
    if not path.is_absolute() or not path.name:
        raise RuntimeError('Probe file must be an absolute path')
    return _open_pinned_directory(path.parent), _component(path.name)


def _read_fd(fd, limit):
    metadata = os.fstat(fd)
    if not stat.S_ISREG(metadata.st_mode):
        raise RuntimeError('Attestation must be a regular file')
    if metadata.st_size > limit:
        raise RuntimeError('Attestation is oversized')
    chunks = []
    remaining = limit + 1
    while remaining:
        chunk = os.read(fd, min(65536, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    data = b''.join(chunks)
    if len(data) > limit:
        raise RuntimeError('Attestation is oversized')
    return data


def _read_regular_at(parent_fd, name, limit=65536):
    fd = os.open(_component(name), _READ_FLAGS, dir_fd=parent_fd)
    try:
        return _read_fd(fd, limit)
    finally:
        os.close(fd)


def read_regular(path, limit=65536):
    """Read a bounded regular file after pinning every parent component."""
    parent_fd, name = _open_pinned_parent(path)
    try:
        return _read_regular_at(parent_fd, name, limit)
    finally:
        os.close(parent_fd)


def _sync_dir_fd(directory_fd):
    os.fsync(directory_fd)


def sync_dir(path):
    """Fsync a directory after pinning its complete path."""
    directory_fd = _open_pinned_directory(path)
    try:
        _sync_dir_fd(directory_fd)
    finally:
        os.close(directory_fd)


def _publish_at(parent_fd, name, data):
    name = _component(name)
    temporary = '.publish-' + uuid.uuid4().hex
    fd = None
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW | _CLOEXEC,
                     0o660, dir_fd=parent_fd)
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise RuntimeError('Short write during atomic publication')
            view = view[written:]
        os.fsync(fd)
        os.close(fd)
        fd = None
        os.replace(temporary, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        _sync_dir_fd(parent_fd)
    except Exception:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(temporary, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        raise


def publish(path, data):
    """Atomically publish below a directory whose ancestors are pinned first."""
    parent_fd, name = _open_pinned_parent(path)
    try:
        _publish_at(parent_fd, name, data)
    finally:
        os.close(parent_fd)


def _exists_at(parent_fd, name):
    try:
        os.lstat(_component(name), dir_fd=parent_fd)
    except FileNotFoundError:
        return False
    return True


def _ensure_directory_at(parent_fd, name):
    name = _component(name)
    try:
        os.mkdir(name, 0o700, dir_fd=parent_fd)
    except FileExistsError:
        pass
    return _open_directory_at(parent_fd, name)


def _ensure_regular_at(parent_fd, name):
    name = _component(name)
    try:
        fd = os.open(name, _REGULAR_FLAGS, dir_fd=parent_fd)
    except FileNotFoundError:
        fd = os.open(name, _CREATE_FLAGS, 0o660, dir_fd=parent_fd)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise RuntimeError('Probe file is not a regular file')
        return fd
    except Exception:
        os.close(fd)
        raise


def _assert_regular_or_absent_at(parent_fd, name):
    try:
        fd = os.open(_component(name), _READ_FLAGS, dir_fd=parent_fd)
    except FileNotFoundError:
        return
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise RuntimeError('SQLite auxiliary path is not a regular file')
    finally:
        os.close(fd)


def _database_identity(parent_fd, name):
    fd = os.open(_component(name), _READ_FLAGS, dir_fd=parent_fd)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode):
            raise RuntimeError('SQLite database is not a regular file')
        return metadata.st_dev, metadata.st_ino
    finally:
        os.close(fd)


def _assert_database_identity(parent_fd, name, expected):
    if _database_identity(parent_fd, name) != expected:
        raise RuntimeError('SQLite database was replaced during the probe')


def _sqlite_probe(directory_fd, owner_token):
    database_name = 'transactions.sqlite'
    database_fd = _ensure_regular_at(directory_fd, database_name)
    try:
        identity = os.fstat(database_fd)
        expected_identity = identity.st_dev, identity.st_ino
        auxiliary = tuple(database_name + suffix for suffix in ('-journal', '-wal', '-shm'))
        for name in auxiliary:
            _assert_regular_or_absent_at(directory_fd, name)

        # SQLite has no dir_fd API. Keep the probe directory pinned and make
        # SQLite resolve the database and its journal/WAL sidecars through it.
        database_path = f'/proc/self/fd/{directory_fd}/{database_name}'
        with sqlite3.connect(database_path, timeout=5) as connection:
            connection.execute('PRAGMA synchronous=FULL')
            connection.execute('CREATE TABLE IF NOT EXISTS probe (id TEXT PRIMARY KEY)')
            connection.execute('INSERT OR REPLACE INTO probe VALUES (?)', (owner_token,))
            connection.commit()
            connection.execute('INSERT INTO probe VALUES (?)', ('rollback-' + uuid.uuid4().hex,))
            connection.rollback()
        _assert_database_identity(directory_fd, database_name, expected_identity)
        for name in auxiliary:
            _assert_regular_or_absent_at(directory_fd, name)

        with sqlite3.connect(database_path, timeout=5) as connection:
            if connection.execute('SELECT id FROM probe').fetchall() != [(owner_token,)]:
                raise RuntimeError('SQLite committed/rolled-back state mismatch')
        _assert_database_identity(directory_fd, database_name, expected_identity)
        for name in auxiliary:
            _assert_regular_or_absent_at(directory_fd, name)
    finally:
        os.close(database_fd)


def _nofollow_at(parent_fd, name):
    name = _component(name)
    try:
        metadata = os.lstat(name, dir_fd=parent_fd)
    except FileNotFoundError as error:
        raise RuntimeError('Guest did not expose the probe link as a symlink') from error
    if not stat.S_ISLNK(metadata.st_mode):
        raise RuntimeError('Guest did not expose the probe link as a symlink')
    try:
        fd = os.open(name, os.O_RDONLY | _NOFOLLOW | _CLOEXEC, dir_fd=parent_fd)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            return
        raise
    os.close(fd)
    raise RuntimeError('No-follow opened the link target')


def nofollow(path):
    parent_fd, name = _open_pinned_parent(path)
    try:
        _nofollow_at(parent_fd, name)
    finally:
        os.close(parent_fd)


def _ensure_symlink_at(parent_fd, name, target):
    name = _component(name)
    try:
        metadata = os.lstat(name, dir_fd=parent_fd)
    except FileNotFoundError:
        os.symlink(target, name, dir_fd=parent_fd)
        return
    if not stat.S_ISLNK(metadata.st_mode):
        raise RuntimeError('Probe link path is not a symlink')


def _child_lock_probe(directory_fd):
    writer_fd = _ensure_regular_at(directory_fd, 'writer.lock')
    try:
        fcntl.flock(writer_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        code = (
            'import fcntl, os, sys\n'
            'directory_fd = int(sys.argv[1])\n'
            'fd = os.open("writer.lock", os.O_RDWR | os.O_NOFOLLOW, dir_fd=directory_fd)\n'
            'try:\n'
            '    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)\n'
            'except BlockingIOError:\n'
            '    os.close(fd)\n'
            '    sys.exit(0)\n'
            'os.close(fd)\n'
            'sys.exit(1)\n'
        )
        result = subprocess.run(
            [sys.executable, '-c', code, str(directory_fd)],
            pass_fds=(directory_fd,),
            timeout=5,
        )
        if result.returncode != 0:
            raise RuntimeError('Independent process acquired the held writer lock')
    finally:
        fcntl.flock(writer_fd, fcntl.LOCK_UN)
        os.close(writer_fd)


def run(require_restart):
    raw = read_regular(HOST)
    host = json.loads(raw)
    image = os.environ.get('FULLMAG_RUNTIME_IMAGE_ID')

    root_fd = _open_pinned_directory(ROOT)
    try:
        owner = json.loads(_read_regular_at(root_fd, '.fullmag-windows-folder-owner.json'))
        if (host['schema'] != 'fullmag.windows-folder-host.v1'
                or host['storage_profile'] != 'windows-folder-v1'
                or host['role'] != 'session' or host['owner_scope'] != 'docker-desktop-linux'
                or not host['host_root_no_reparse'] or host['host_drive_type'] != 3
                or host['host_filesystem'] not in ('NTFS', 'ReFS') or host['image_id'] != image
                or owner != host):
            raise RuntimeError('Invalid Windows host admission')
        if require_restart and host['restart_verified'] is not True:
            raise RuntimeError('Native host has not confirmed the restart readback')

        directory_fd = _ensure_directory_at(root_fd, '.windows-folder-probe')
        try:
            payload = (host['owner_token'] + ':' + image).encode('ascii')
            sentinel_name = 'restart-sentinel.bin'
            existed = _exists_at(directory_fd, sentinel_name)
            if existed:
                if hashlib.sha256(_read_regular_at(directory_fd, sentinel_name)).hexdigest() != host['restart_expected_sha256']:
                    raise RuntimeError('Restart sentinel changed')
            elif require_restart:
                raise RuntimeError('Restart sentinel is missing')
            else:
                _publish_at(directory_fd, sentinel_name, payload)

            checks = {key: False for key in CHECKS}
            publication_name = 'publication.bin'
            _publish_at(directory_fd, publication_name, payload)
            if _read_regular_at(directory_fd, publication_name) != payload:
                raise RuntimeError('Atomic publication readback mismatch')
            checks.update(file_sync=True, directory_sync=True, atomic_replace=True)

            stage_name = 'stage-' + uuid.uuid4().hex
            os.mkdir(stage_name, 0o700, dir_fd=directory_fd)
            stage_fd = _open_directory_at(directory_fd, stage_name)
            try:
                _publish_at(stage_fd, 'payload', payload)
            finally:
                os.close(stage_fd)
            final_name = 'published-' + uuid.uuid4().hex
            os.rename(stage_name, final_name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
            _sync_dir_fd(directory_fd)
            final_fd = _open_directory_at(directory_fd, final_name)
            try:
                if _read_regular_at(final_fd, 'payload') != payload:
                    raise RuntimeError('Directory publication readback mismatch')
            finally:
                os.close(final_fd)
            checks['atomic_directory_publish'] = True

            _child_lock_probe(directory_fd)
            checks['process_lock'] = True

            _ensure_symlink_at(directory_fd, 'posix-link', 'publication.bin')
            _nofollow_at(directory_fd, 'posix-link')
            _nofollow_at(directory_fd, 'host-junction')
            checks.update(no_follow_symlink=True, no_follow_junction=True)

            _sqlite_probe(directory_fd, host['owner_token'])
            checks['sqlite_transactions'] = True
            checks['restart_readback'] = existed

            root_stat = os.fstat(root_fd)
            grant = {'schema': 'fullmag.windows-folder-session.v1', 'storage_profile': 'windows-folder-v1',
                     'role': 'session', 'state': 'operational', 'container_root': '/state',
                     'host_attestation_sha256': hashlib.sha256(raw).hexdigest(), 'owner_token': host['owner_token'],
                     'root_device': root_stat.st_dev, 'root_inode': root_stat.st_ino,
                     'mount_namespace_inode': os.stat('/proc/self/ns/mnt').st_ino,
                     'power_loss': 'NOT VERIFIED', 'checks': checks}
            _publish_at(directory_fd, 'probe-restart.json' if existed else 'probe-first.json',
                        json.dumps(grant, indent=2).encode())
            if require_restart:
                if not all(checks.values()):
                    raise RuntimeError('Windows storage operational probes did not pass')
                _publish_at(root_fd, '.fullmag-windows-folder-grant.json',
                            json.dumps(grant, indent=2).encode())
            return grant
        finally:
            os.close(directory_fd)
    finally:
        os.close(root_fd)
