"""Format/mount only the new empty device authenticated by the WSL preflight.

No existing image, filesystem or data tree is deleted. A started or failed
attempt cannot replay formatting; recovery must reconcile its retained proofs.
Run only in the persistent Ubuntu host namespace, under the migration caller's
worktree lock. The caller separately authenticates its source/formatter hashes.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import uuid

import linux_data_volume_provision as qualification
from fullmag_data_volume_guard import _open_directory_nofollow
from fullmag_data_volume_journal import append_started, append_terminal
from fullmag_data_volume_linux_request import validate_linux_request


ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'LANG': 'C'}


def _encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False)+'\n').encode()


def _exclusive(parent, name, raw):
    qualification.require(name and '/' not in name and name not in ('.', '..'), 'Invalid artifact name')
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=parent)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    os.fsync(parent)


def _document(op, name, value):
    parent = _open_directory_nofollow(op)
    try:
        raw = _encoded(value)
        _exclusive(parent, name, raw)
        return qualification.digest(raw)
    finally:
        os.close(parent)


def _publish_journal(path, expected, value):
    _, current = qualification._read(path)
    qualification.require(current == expected, 'Journal changed under the provision operation')
    parent = _open_directory_nofollow(path.parent)
    try:
        temporary = '.journal-'+uuid.uuid4().hex
        _exclusive(parent, temporary, _encoded(value))
        os.replace(temporary, path.name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        os.close(parent)


@contextmanager
def _operation_lock(op):
    parent = _open_directory_nofollow(op)
    lock = None
    try:
        lock = os.open('linux-format.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                       0o600, dir_fd=parent)
        metadata = os.fstat(lock)
        qualification.require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1 and
                               not stat.S_IMODE(metadata.st_mode) & 0o022 and
                               metadata.st_uid in (0, os.fstat(parent).st_uid),
                               'Unsafe format operation lock')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        if lock is not None:
            os.close(lock)
        os.close(parent)


def _run(op, label, argv, descriptors):
    """Record bounded-stage command output; never accept a caller command."""
    qualification.require(argv[0] in ('/usr/sbin/mkfs.ext4', '/usr/bin/mount'),
                           'Only the fixed new-volume commands are allowed')
    qualification.require(label in ('mkfs', 'mount'), 'Only fixed provision log names are allowed')
    qualification.require(all(type(fd) is int and fd >= 3 for fd in descriptors) and
                           len(set(descriptors)) == len(descriptors), 'Pinned non-stdio descriptors required')
    if argv[0] == '/usr/sbin/mkfs.ext4':
        valid = (len(argv) == 6 and len(descriptors) == 1 and argv[1] == '-U' and
                 argv[3] == '-L' and re.fullmatch(r'fm-[0-9a-f]{8}', argv[4]) and
                 argv[5] == '/proc/self/fd/'+str(descriptors[0]))
        if valid:
            valid = type(argv[2]) is str and str(uuid.UUID(argv[2])) == argv[2] and uuid.UUID(argv[2]).int != 0
    else:
        valid = (len(descriptors) == 2 and argv == ['/usr/bin/mount', '--no-canonicalize',
                 '--internal-only', '--types', 'ext4', '--options', 'nodev,nosuid',
                 '/proc/self/fd/'+str(descriptors[0]), '/proc/self/fd/'+str(descriptors[1])])
    qualification.require(valid, 'Only the exact new-volume command shape is allowed')
    parent = _open_directory_nofollow(op)
    streams = []
    try:
        for suffix in ('stdout', 'stderr'):
            fd = os.open('linux-'+label+'.'+suffix, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o644, dir_fd=parent)
            streams.append(os.fdopen(fd, 'wb'))
        print(json.dumps({'phase': label, 'state': 'started'}), flush=True)
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=streams[0], stderr=streams[1],
                                pass_fds=tuple(descriptors), env=ENV, timeout=300)
        for stream in streams:
            stream.flush(); os.fsync(stream.fileno())
        qualification.require(result.returncode == 0, 'New volume command failed: ' + label)
    finally:
        for stream in streams:
            stream.close()
        os.close(parent)


def _format_args(ready):
    request = ready['request']
    return ['/usr/sbin/mkfs.ext4', '-U', request['filesystem_uuid'],
            '-L', 'fm-'+request['volume_id'][:8], '/proc/self/fd/'+str(ready['descriptor'])]


@contextmanager
def _mount_parent(ready):
    target = Path(ready['request']['mount_root'])
    parent = _open_directory_nofollow(target.parent)
    try:
        metadata = os.fstat(parent)
        qualification.require(metadata.st_uid == 0 and not stat.S_IMODE(metadata.st_mode) & 0o022 and
                               metadata.st_dev == os.stat('/').st_dev,
                               'Mountpoint parent must be root-owned and protected')
        try:
            os.stat(target.name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise ValueError('Mountpoint already exists; inspect/recover first')
        yield parent
    finally:
        os.close(parent)


def _mount_verified(ready):
    request, descriptor, op = ready['request'], ready['descriptor'], ready['operation_root']
    target = Path(request['mount_root'])
    parent = ready['mount_parent_descriptor']
    fresh = _open_directory_nofollow(target.parent)
    try:
        a, b = os.fstat(parent), os.fstat(fresh)
        qualification.require((a.st_dev, a.st_ino) == (b.st_dev, b.st_ino) and
                               b.st_uid == 0 and not stat.S_IMODE(b.st_mode) & 0o022,
                               'Pinned mountpoint parent changed')
    finally:
        os.close(fresh)
    underlay = None
    try:
        os.mkdir(target.name, mode=0o700, dir_fd=parent)
        created = os.stat(target.name, dir_fd=parent, follow_symlinks=False)
        underlay = os.open(target.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        opened = os.fstat(underlay)
        qualification.require((created.st_dev, created.st_ino) == (opened.st_dev, opened.st_ino) and
                               opened.st_uid == 0 and stat.S_IMODE(opened.st_mode) == 0o700 and
                               not os.listdir(underlay), 'New mountpoint identity changed')
        _run(op, 'mount', ['/usr/bin/mount', '--no-canonicalize', '--internal-only', '--types', 'ext4',
             '--options', 'nodev,nosuid', '/proc/self/fd/'+str(descriptor),
             '/proc/self/fd/'+str(underlay)], (descriptor, underlay))
    finally:
        if underlay is not None:
            os.close(underlay)
    observation = qualification._capture(['findmnt', '--json', '--target', str(target), '--output',
                                           'TARGET,FSTYPE,UUID,MAJ:MIN,OPTIONS'])
    rows = json.loads(observation.stdout).get('filesystems')
    qualification.require(type(rows) is list and len(rows) == 1, 'One exact new mount required')
    row = rows[0]
    qualification.require(row.get('target') == str(target) and row.get('fstype') == 'ext4' and
                           row.get('uuid') == request['filesystem_uuid'] and
                           row.get('maj:min') == ready['device']['maj:min'] and
                           {'nodev', 'nosuid', 'rw'} <= set(row.get('options', '').split(',')),
                           'New mount identity, UUID, mode or block device differs')
    root = _open_directory_nofollow(target)
    try:
        qualification.require(os.fstat(root).st_dev == os.fstat(descriptor).st_rdev,
                               'Mounted root does not belong to the pinned block device')
        identity = {'schema': 'fullmag.user-data-volume-identity.v1', 'volume_id': request['volume_id'],
                    'filesystem_uuid': request['filesystem_uuid'],
                    'created_receipt_sha256': request['created_receipt_sha256'],
                    'attached_receipt_sha256': request['attached_receipt_sha256'],
                    'controller_sha256': request['controller_sha256'], 'data_migrated': False}
        _exclusive(root, '.fullmag-user-data-volume.json', _encoded(identity))
        os.fchmod(root, 0o755)
        space = os.fstatvfs(root)
        return {'mount': row, 'device': os.fstat(root).st_dev, 'inode': os.fstat(root).st_ino,
                'available_bytes': space.f_bavail*space.f_frsize,
                'total_bytes': space.f_blocks*space.f_frsize}
    finally:
        os.close(root)


def _entry_request(path, expected_sha256):
    qualification.require(os.name == 'posix' and os.geteuid() == 0, 'Host root required')
    qualification.require(type(expected_sha256) is str and re.fullmatch(r'[0-9a-f]{64}', expected_sha256),
                           'Exact Linux request SHA required')
    _, value = qualification._read(Path(path), expected_sha256)
    request = validate_linux_request(value)
    return request, Path(request['storage_root'])/'migrations/data-volumes'/request['volume_id']


def format_mount(request_path, expected_sha256, formatter_sha256):
    qualification.require(qualification.digest(Path(__file__).read_bytes()) == formatter_sha256,
                           'Formatter source changed')
    request, op = _entry_request(request_path, expected_sha256)
    with _operation_lock(op), qualification.prepared_device(request_path, expected_sha256) as ready, \
            _mount_parent(ready) as parent:
        ready = dict(ready, mount_parent_descriptor=parent)
        qualification.require(ready['operation_root'] == op and ready['request'] == request,
                               'Qualified operation scope changed')
        for name in ('linux-format-inputs.json', 'linux-format-started.json',
                     'linux-provision-result.json', 'linux-provision-failed.json'):
            qualification.require(not os.path.lexists(op/name), 'Format was already prepared; reconcile, never replay')
        inputs = {'linux_request_sha256': expected_sha256, 'formatter_sha256': formatter_sha256}
        input_sha = _document(op, 'linux-format-inputs.json', inputs)
        current = ready['journal']
        started = append_started(current, 'ext4-mounted', input_sha)
        _publish_journal(ready['journal_path'], current, started)
        try:
            _document(op, 'linux-format-started.json', dict(inputs, device=ready['device']))
            _run(op, 'mkfs', _format_args(ready), (ready['descriptor'],))
            probe = qualification._capture(['blkid', '-p', '-o', 'export',
                         '/proc/self/fd/'+str(ready['descriptor'])], pass_fds=(ready['descriptor'],))
            values = dict(line.split('=', 1) for line in probe.stdout.decode('ascii').splitlines() if '=' in line)
            qualification.require(values.get('TYPE') == 'ext4' and
                                   values.get('UUID') == request['filesystem_uuid'],
                                   'Formatted filesystem UUID/type differs')
            filesystem = _mount_verified(ready)
            result = {'schema': 'fullmag.data-volume-linux-provision-result.v1',
                      'state': 'mounted-not-data-migrated', 'volume_id': request['volume_id'],
                      'filesystem_uuid': request['filesystem_uuid'], 'device': ready['device'],
                      'filesystem': filesystem, 'namespace_admitted': False, **inputs}
            result_sha = _document(op, 'linux-provision-result.json', result)
            _publish_journal(ready['journal_path'], started, append_terminal(started, 'succeeded', result_sha))
            return result
        except BaseException as error:
            # All ordinary subprocess failures/timeouts have been observed to
            # terminal by subprocess.run. Interruption retains an unknown phase.
            state = 'failed-confirmed' if isinstance(error, Exception) else 'outcome-unknown-resources-retained'
            failure = {'schema': 'fullmag.data-volume-linux-provision-failure.v1', 'state': state,
                       'volume_id': request['volume_id'], 'error_type': type(error).__name__,
                       'image_and_partial_filesystem_retained': True, **inputs}
            failure_sha = _document(op, 'linux-provision-failed.json', failure)
            _publish_journal(ready['journal_path'], started, append_terminal(started, state, failure_sha))
            raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['format-mount'])
    parser.add_argument('--request', required=True)
    parser.add_argument('--request-sha256', required=True)
    parser.add_argument('--formatter-sha256', required=True)
    args = parser.parse_args(argv)
    print(json.dumps(format_mount(args.request, args.request_sha256, args.formatter_sha256), sort_keys=True))


if __name__ == '__main__':
    main()
