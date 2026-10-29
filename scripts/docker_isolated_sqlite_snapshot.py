"""Linux SQLite source fences and validation confined to a new copy.

OFD locks survive closing other descriptors during the streamed copy.
They conflict with the standard Unix SQLite rollback and WAL writer locks.
The caller must additionally pin the stopped group and tree manifest; these
locks are not an attestation about raw disk access or a Windows VFS.
"""
from contextlib import contextmanager, closing
import fcntl
import os
from pathlib import Path
import sqlite3
import stat
import struct


@contextmanager
def hold_workspace_database(root):
    root = Path(root)
    db = root / 'workspace.db'
    descriptors = []
    identities = []
    try:
        if not hasattr(fcntl, 'F_OFD_SETLK'):
            raise ValueError('SQLite snapshot requires Linux OFD locks')
        def pin(path, offset, length, exclusive=False):
            before = path.lstat()
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise ValueError('SQLite source is linked or not a regular file')
            fd = os.open(path, (os.O_RDWR if exclusive else os.O_RDONLY) | os.O_NOFOLLOW | os.O_NONBLOCK)
            descriptors.append(fd)
            after = os.fstat(fd)
            if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                raise ValueError('SQLite source identity changed')
            lock = struct.pack('@hhqqi4x', fcntl.F_WRLCK if exclusive else fcntl.F_RDLCK, os.SEEK_SET, offset, length, 0)
            fcntl.fcntl(fd, fcntl.F_OFD_SETLK, lock)
            identities.append((path, fd, after.st_dev, after.st_ino))
            return fd
        if db.exists() or db.is_symlink():
            # SQLite holds a SHARED lock on this range even in WAL mode.
            # An exclusive OFD lock also fences a first WAL writer when the
            # closed database has no -shm file yet. O_RDWR is needed for the
            # kernel lock; no operation writes source bytes or metadata.
            fd = pin(db, 0x40000000, 512, exclusive=True)
            if os.pread(fd, 16, 0) != b'SQLite format 3\x00':
                raise ValueError('Workspace database has an invalid SQLite header')
            if (root / 'workspace.db-journal').exists():
                raise ValueError('Workspace rollback journal requires separate recovery')
            shm = root / 'workspace.db-shm'
            if shm.exists() or shm.is_symlink():
                pin(shm, 120, 8)
            elif (root / 'workspace.db-wal').exists():
                raise ValueError('WAL without its lock file is not a supported snapshot source')
        yield
        for path, fd, device, inode in identities:
            info = path.lstat()
            if (info.st_dev, info.st_ino) != (device, inode) or os.fstat(fd).st_nlink != 1:
                raise ValueError('SQLite source lock identity changed')
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def validate_copied_workspace(root):
    """Recover/check only the already isolated copy, including its WAL."""
    db = Path(root) / 'workspace.db'
    if not db.exists():
        return {'database_present': False}
    if db.is_symlink() or not db.is_file() or db.stat().st_nlink != 1:
        raise ValueError('Copied workspace database is unsafe')
    with closing(sqlite3.connect(str(db), timeout=0)) as connection:
        rows = connection.execute('PRAGMA quick_check').fetchall()
        if rows != [('ok',)]:
            raise ValueError('Copied workspace database failed SQLite quick_check')
        checkpoint = connection.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchall()
        if len(checkpoint) != 1 or checkpoint[0][0] != 0:
            raise ValueError('Copied workspace WAL checkpoint remained busy')
    return {'database_present': True, 'quick_check': 'ok'}
