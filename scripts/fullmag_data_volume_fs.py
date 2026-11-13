"""Bounded filesystem primitives for a managed, separately guarded data move.

These functions do not authenticate a live drain or authorize a mount. The
controller owns those gates and pins exact source roots and the new volume.
No function here removes an original tree or an image.
"""
from __future__ import annotations

from contextlib import ExitStack, contextmanager
import hashlib
import fcntl
import os
from pathlib import Path
import stat
import subprocess
import tarfile

try:
    from .fullmag_data_volume_manifest import inventory_datasets, require_matching_data, _read_xattrs
except ImportError:
    from fullmag_data_volume_manifest import inventory_datasets, require_matching_data, _read_xattrs


COPY_HEADROOM_BYTES = 25 * 1024**3
ARCHIVE_ENV = {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL':'C', 'LANG':'C'}


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024**2), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _no_links(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('Filesystem operation requires an absolute path without traversal')
    for ancestor in (*reversed(path.parents), path):
        if ancestor.is_symlink():
            raise ValueError('Filesystem operation refuses symlink traversal')
    return path


@contextmanager
def _directory_fd(path):
    """Pin every component, refusing symlinks even in parent directories."""
    path = _no_links(path)
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in path.parts[1:]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


def _same_directory(path, descriptor):
    try:
        with _directory_fd(path) as current:
            a, b = os.fstat(current), os.fstat(descriptor)
            if (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino):
                raise ValueError('Pinned directory identity changed')
    except OSError as error:
        raise ValueError('Pinned directory path changed; artifacts retained') from error


def _exclusive_at(parent, name):
    if not name or '/' in name or name in ('.', '..'):
        raise ValueError('New artifact must be one directory entry')
    try:
        descriptor = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o640, dir_fd=parent)
    except FileExistsError as error:
        raise ValueError('New migration artifact already exists; inspect/recover first') from error
    return os.fdopen(descriptor, 'w+b')


def _require_owned_parent(descriptor):
    metadata = os.fstat(descriptor)
    if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o022:
        raise ValueError('Destination namespace must be owned and exclusively writable by the caller')


def _run_to_file(argv, output, error_name, *, parent_fd, pass_fds=()):
    if not argv or argv[0] != '/usr/bin/tar':
        raise ValueError('Only the fixed system archive tool is allowed')
    with _exclusive_at(parent_fd, error_name) as errors:
        result = subprocess.run(argv, stdout=output, stderr=errors,
                                stdin=subprocess.DEVNULL, env=ARCHIVE_ENV,
                                pass_fds=pass_fds, check=False)
        errors.flush(); os.fsync(errors.fileno())
        if result.returncode:
            errors.seek(max(0, os.fstat(errors.fileno()).st_size - 4096))
            tail = errors.read().decode('utf-8', errors='replace')
            raise ValueError('Archive operation failed; artifacts retained: ' + tail)


def archive_and_extract(storage_root, roots, archive_path, payload_root):
    """Archive original bytes and independently verify an extracted copy.

    The caller authenticates the new volume and holds all source lifecycle and
    writer guards. Directory FDs also pin write destinations against namespace
    replacements; tar never resolves a mutable destination pathname again.
    """
    storage_root = _no_links(storage_root)
    archive = _no_links(archive_path)
    payload = _no_links(payload_root)
    if os.path.lexists(archive) or os.path.lexists(payload):
        raise ValueError('Archive and extraction targets must both be new')
    relatives = []
    for role in ('user_data', 'state'):
        source = _no_links(roots[role])
        if source == storage_root or not source.is_relative_to(storage_root):
            raise ValueError('Archive source is outside the exact project storage')
        if archive.is_relative_to(source) or payload.is_relative_to(source):
            raise ValueError('Archive destination must not overlap an original dataset')
        relatives.append(source.relative_to(storage_root).as_posix())
    before = inventory_datasets(roots)
    with ExitStack() as stack:
        source_fd = stack.enter_context(_directory_fd(storage_root))
        archive_parent_fd = stack.enter_context(_directory_fd(archive.parent))
        payload_parent_fd = stack.enter_context(_directory_fd(payload.parent))
        _require_owned_parent(archive_parent_fd)
        _require_owned_parent(payload_parent_fd)
        if os.fstat(archive_parent_fd).st_dev != os.fstat(payload_parent_fd).st_dev:
            raise ValueError('Archive and copied payload must share the new filesystem')
        available = os.fstatvfs(archive_parent_fd)
        if available.f_bavail * available.f_frsize < 2*before['totals']['logical_bytes'] + COPY_HEADROOM_BYTES:
            raise ValueError('Destination lacks archive plus payload and 25 GiB campaign headroom')
        output = stack.enter_context(_exclusive_at(archive_parent_fd, archive.name))
        create = ['/usr/bin/tar', '--format=pax', '--acls', '--xattrs', '--numeric-owner',
                  '--one-file-system', '--pax-option=delete=atime,delete=ctime',
                  '-c', '-f', '-', '-C', '/proc/self/fd/' + str(source_fd), '--', *relatives]
        _run_to_file(create, output, archive.name + '.create.stderr',
                     parent_fd=archive_parent_fd, pass_fds=(source_fd,))
        output.flush(); os.fsync(output.fileno())
        _same_directory(storage_root, source_fd)
        _same_directory(archive.parent, archive_parent_fd)
        _same_directory(payload.parent, payload_parent_fd)
        require_matching_data(before, inventory_datasets(roots))
        output.seek(0)
        digest = hashlib.sha256()
        for chunk in iter(lambda: output.read(1024**2), b''):
            digest.update(chunk)
        # The privileged controller exclusively owns these destination parents
        # under its lifecycle guard. Snapshot the new entry before opening it;
        # compare both sides so rename or mount drift cannot substitute a root.
        os.mkdir(payload.name, mode=0o700, dir_fd=payload_parent_fd)
        created = os.stat(payload.name, dir_fd=payload_parent_fd, follow_symlinks=False)
        payload_fd = os.open(payload.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                             dir_fd=payload_parent_fd)
        stack.callback(os.close, payload_fd)
        opened = os.fstat(payload_fd)
        if ((opened.st_dev, opened.st_ino) != (created.st_dev, created.st_ino) or
                opened.st_dev != os.fstat(payload_parent_fd).st_dev or
                opened.st_uid != os.geteuid() or stat.S_IMODE(opened.st_mode) != 0o700 or
                os.listdir(payload_fd)):
            raise ValueError('New extraction root was replaced before it was pinned')
        extract = ['/usr/bin/tar', '--acls', '--xattrs', '--xattrs-include=*', '--numeric-owner',
                   '--same-owner', '--same-permissions', '--delay-directory-restore',
                   '--keep-old-files', '-x', '-f', '/proc/self/fd/' + str(output.fileno()),
                   '-C', '/proc/self/fd/' + str(payload_fd)]
        with open(os.devnull, 'wb') as sink:
            _run_to_file(extract, sink, archive.name + '.extract.stderr',
                         parent_fd=archive_parent_fd, pass_fds=(output.fileno(), payload_fd))
        _same_directory(payload, payload_fd)
        _same_directory(archive.parent, archive_parent_fd)
        os.fchmod(payload_fd, 0o755)
        copied = {role: payload / Path(path).relative_to(storage_root)
                  for role, path in roots.items()}
        require_matching_data(before, inventory_datasets(copied))
    return {'schema': 'fullmag.data-volume-copy.v1', 'state': 'copied-and-verified',
            'data_sha256': before['data_sha256'], 'archive_path': str(archive),
            'archive_sha256': digest.hexdigest(), 'source_manifest': before,
            'copied_roots': {role: str(path) for role, path in copied.items()}}


def _archive_members(stream, manifest, relatives):
    """Validate effective PAX names and hardlink topology before privileged tar."""
    expected = {}
    aliases = {}
    for entry in manifest['entries']:
        name = relatives[entry['role']] + ('/'+entry['path'] if entry['path'] else '')
        expected[name] = entry
        aliases[entry['role']+':'+entry['path']] = name
    def group(name):
        entry = expected[name]
        return aliases[entry['hardlink_to']] if entry.get('hardlink_to') else name
    seen = {}
    materialized_groups = set()
    stream.seek(0)
    with tarfile.open(fileobj=stream, mode='r:') as archive:
        for member in archive:
            name = member.name[:-1] if member.isdir() and member.name.endswith('/') else member.name
            if (not name or name.startswith('/') or any(p in ('', '.', '..') for p in name.split('/')) or
                    name not in expected or name in seen or member.sparse is not None or
                    any(k.startswith('GNU.sparse') for k in member.pax_headers)):
                raise ValueError('Retained PAX has an unsafe, duplicate or unexpected member')
            entry = expected[name]
            if entry['kind'] == 'directory':
                valid = member.type == tarfile.DIRTYPE
            elif member.type in (tarfile.REGTYPE, tarfile.AREGTYPE):
                valid = member.size == entry['size'] and group(name) not in materialized_groups
            elif member.type == tarfile.LNKTYPE:
                target = member.linkname
                valid = (target in seen and seen[target] in (tarfile.REGTYPE, tarfile.AREGTYPE) and
                         expected[target]['kind'] == 'file' and group(target) == group(name))
            else:
                valid = False
            if not valid:
                raise ValueError('Retained PAX member type or hardlink topology differs')
            seen[name] = member.type
            if member.type in (tarfile.REGTYPE,tarfile.AREGTYPE):
                materialized_groups.add(group(name))
        # GNU tar stops at its first zero header; reject hidden trailing data.
        stream.seek(archive.offset)
        remaining = 0
        for chunk in iter(lambda:stream.read(1024**2), b''):
            remaining += len(chunk)
            if any(chunk):
                raise ValueError('Retained PAX contains data after its terminal header')
        if remaining < 1024 or remaining % 512:
            raise ValueError('Retained PAX terminal padding is incomplete')
    if set(seen) != set(expected):
        raise ValueError('Retained PAX does not contain the exact two complete datasets')
    stream.seek(0)


@contextmanager
def _existing_copy_writer(state_root, expected):
    """Lock an existing inode; never create or replace the copied writer."""
    store = state_root/'runs/docker-all/session-store'
    with _directory_fd(store) as parent:
        descriptor = os.open('WRITER.lock', os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=parent)
        try:
            before = os.fstat(descriptor)
            if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
                    before.st_dev != os.fstat(parent).st_dev or
                    {'mode':stat.S_IMODE(before.st_mode),'uid':before.st_uid,'gid':before.st_gid,
                     'mtime_ns':before.st_mtime_ns,'xattrs':_read_xattrs(descriptor, 'copied writer')} !=
                    {k:expected[k] for k in ('mode','uid','gid','mtime_ns','xattrs')}):
                raise ValueError('Existing copied writer metadata or ACL differs')
            fcntl.flock(descriptor, fcntl.LOCK_EX|fcntl.LOCK_NB)
            def check():
                current = os.stat('WRITER.lock', dir_fd=parent, follow_symlinks=False)
                if (current.st_dev,current.st_ino) != (before.st_dev,before.st_ino):
                    raise ValueError('Existing copied writer was replaced')
                now = os.fstat(descriptor)
                if ({'mode':stat.S_IMODE(now.st_mode),'uid':now.st_uid,'gid':now.st_gid,
                     'mtime_ns':now.st_mtime_ns,'xattrs':_read_xattrs(descriptor,'copied writer')} !=
                        {k:expected[k] for k in ('mode','uid','gid','mtime_ns','xattrs')}):
                    raise ValueError('Existing copied writer metadata changed')
                _same_directory(store, parent)
            check()
            yield
            check()
        finally:
            os.close(descriptor)


def requalify_existing_copy(storage_root, roots, archive_path, payload_root, verification_root):
    """Prove CURRENT fenced source, retained PAX and payload are identical.

    Only the fresh verification directory and its stderr evidence are written.
    It is retained on success and failure. No claim about an unrecorded historic
    pre-failure content hash is made.
    """
    storage = _no_links(storage_root); archive = _no_links(archive_path)
    payload = _no_links(payload_root); verification = _no_links(verification_root)
    if verification.parent != archive.parent or os.path.lexists(verification):
        raise ValueError('Recovery verification directory must be new beside retained PAX')
    if set(roots) != {'state','user_data'}:
        raise ValueError('Exact two source roots required')
    relatives = {}
    for role, root in roots.items():
        root = _no_links(root)
        if root == storage or not root.is_relative_to(storage):
            raise ValueError('Recovery source escapes its exact storage')
        if archive.is_relative_to(root) or payload.is_relative_to(root):
            raise ValueError('Retained copy overlaps an original')
        relatives[role] = root.relative_to(storage).as_posix()
    before = inventory_datasets(roots)
    writers = [e for e in before['entries'] if e['role'] == 'state' and
               e['path'] == 'runs/docker-all/session-store/WRITER.lock' and e['kind'] == 'file']
    if len(writers) != 1:
        raise ValueError('Source manifest must pin the existing store writer')
    copied = {role:payload/relative for role,relative in relatives.items()}
    with ExitStack() as stack:
        parent = stack.enter_context(_directory_fd(archive.parent))
        payload_fd = stack.enter_context(_directory_fd(payload))
        _require_owned_parent(parent); _require_owned_parent(payload_fd)
        if os.fstat(parent).st_dev != os.fstat(payload_fd).st_dev:
            raise ValueError('Retained archive and payload filesystem differs')
        stack.enter_context(_existing_copy_writer(copied['state'],writers[0]))
        require_matching_data(before, inventory_datasets(copied))
        descriptor = os.open(archive.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
        stream = stack.enter_context(os.fdopen(descriptor,'rb'))
        pin = lambda m:(m.st_dev,m.st_ino,m.st_mode,m.st_uid,m.st_gid,m.st_size,m.st_mtime_ns,m.st_ctime_ns)
        initial = os.fstat(descriptor)
        if (not stat.S_ISREG(initial.st_mode) or initial.st_nlink != 1 or
                initial.st_dev != os.fstat(parent).st_dev or initial.st_uid != os.geteuid() or
                stat.S_IMODE(initial.st_mode) & 0o022):
            raise ValueError('Retained PAX must be a protected single regular file')
        def archive_hash():
            stream.seek(0); digest = hashlib.sha256()
            for chunk in iter(lambda:stream.read(1024**2),b''): digest.update(chunk)
            if pin(os.fstat(descriptor)) != pin(initial) or pin(os.stat(archive.name,dir_fd=parent,
                    follow_symlinks=False)) != pin(initial):
                raise ValueError('Retained PAX changed during recovery')
            _same_directory(archive.parent,parent)
            return digest.hexdigest()
        digest = archive_hash()
        _archive_members(stream,before,relatives)
        available = os.fstatvfs(parent)
        if available.f_bavail*available.f_frsize < before['totals']['logical_bytes']+COPY_HEADROOM_BYTES:
            raise ValueError('Recovery lacks independent extraction plus 25 GiB campaign headroom')
        os.mkdir(verification.name,mode=0o700,dir_fd=parent)
        created = os.stat(verification.name,dir_fd=parent,follow_symlinks=False)
        verify_fd = stack.enter_context(_directory_fd(verification))
        opened = os.fstat(verify_fd)
        if ((opened.st_dev,opened.st_ino) != (created.st_dev,created.st_ino) or
                opened.st_dev != initial.st_dev or opened.st_uid != os.geteuid() or
                stat.S_IMODE(opened.st_mode) != 0o700 or os.listdir(verify_fd)):
            raise ValueError('New recovery verification directory was replaced')
        stream.seek(0)
        extract = ['/usr/bin/tar','--acls','--xattrs','--xattrs-include=*','--numeric-owner',
                   '--same-owner','--same-permissions','--delay-directory-restore','--keep-old-files',
                   '-x','-f','/proc/self/fd/'+str(descriptor),'-C','/proc/self/fd/'+str(verify_fd)]
        with open(os.devnull,'wb') as sink:
            _run_to_file(extract,sink,verification.name+'.extract.stderr',parent_fd=parent,
                         pass_fds=(descriptor,verify_fd))
        _same_directory(verification,verify_fd); _same_directory(payload,payload_fd)
        extracted = {role:verification/relative for role,relative in relatives.items()}
        require_matching_data(before,inventory_datasets(extracted))
        require_matching_data(before,inventory_datasets(copied))
        require_matching_data(before,inventory_datasets(roots))
        if archive_hash() != digest:
            raise ValueError('Retained PAX bytes changed during verification')
    return {'source_manifest':before,'data_sha256':before['data_sha256'],
            'archive_path':str(archive),'archive_sha256':digest,
            'copied_roots':{role:str(root) for role,root in copied.items()}}


def select_new_empty_device(baseline, observed, capacity_bytes):
    """Select exactly one new empty disk after an authenticated VHDX attach.

    This observation alone never authorizes formatting: the caller additionally
    authenticates the create/attach receipts and live disk path before mutation.
    """
    if type(capacity_bytes) is not int or capacity_bytes <= 0:
        raise ValueError('New device capacity must be a positive integer')
    if not isinstance(baseline, list) or not isinstance(observed, list):
        raise ValueError('Device observations must be lists')
    old_paths = {item['path'] for item in baseline}
    added = [item for item in observed
             if item.get('path') not in old_paths and item.get('type') == 'disk']
    if len(added) != 1:
        raise ValueError('Attach did not produce exactly one new disk')
    item = added[0]
    if (type(item.get('path')) is not str or not item['path'].startswith('/dev/') or
            type(item.get('size')) is not int or item['size'] != capacity_bytes or
            item.get('fstype') or item.get('uuid') or item.get('children') or
            item.get('ro') is not False or any(item.get('mountpoints') or [])):
        raise ValueError('The new disk is not empty or does not match the pinned capacity')
    return dict(item)
