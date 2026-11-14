"""Guarded successor-preparation primitive, without CLI or runtime admission.

The root caller must authenticate migration lineage, both datasets, pending,
the persistent host namespace and live OLD native guards. It must also supply
a fixed trusted tool environment. This primitive adds the NEW writer fence
and protected archive; hash pins alone do not prove the caller's obligations.
Failure retains the archive/partial state for explicit recovery. The existing
certificate writer may attempt its local byte restoration on write failure;
that never authorizes replay or a successful migration acknowledgement.
"""
from __future__ import annotations

from contextlib import ExitStack,contextmanager
import fcntl
import hashlib
import os
from pathlib import Path
import re
import stat

from fullmag_data_volume_fs import _same_directory
from fullmag_data_volume_guard import _open_directory_nofollow
from fullmag_data_volume_manifest import _FILE_ENTRY_KEYS
import linux_data_volume_bind as bind_stage
from linux_data_volume_format import _encoded
import linux_native_data_volume_migration as migration


SCHEMA='fullmag.data-volume-admission-apply.v1'
require=bind_stage.qualification.require


def validate_request(value):
    require(type(value) is dict and set(value) == {'schema','pins','writer_entry'} and value['schema'] == SCHEMA,
            'Closed admission preparation request required')
    pins=value['pins'];entry=value['writer_entry']
    require(type(pins) is dict and set(pins) == migration._PIN_KEYS,'Exact admission migration pins required')
    require(type(entry) is dict and set(entry) == _FILE_ENTRY_KEYS and entry['role'] == 'state' and
        entry['path'] == 'runs/docker-all/session-store/WRITER.lock' and entry['kind'] == 'file' and
        entry['hardlink_to'] is None and type(entry['size']) is int and 0 <= entry['size'] <= 1024**2 and
        type(entry['sha256']) is str and re.fullmatch('[0-9a-f]{64}',entry['sha256']) and
        all(type(entry[k]) is int and entry[k] >= 0 for k in ('uid','gid','mode')) and
        entry['mode'] <= 0o7777 and type(entry['mtime_ns']) is int and type(entry['xattrs']) is dict,
        'Exact authenticated new store writer entry required')
    return value


def _require_archive_directory(descriptor,pins):
    info=os.fstat(descriptor)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700 and
        info.st_dev == pins['observed_device'],'Admission archive must use the protected root-owned new-volume directory')


def _writer(descriptor,store_fd,entry):
    before=os.fstat(descriptor);current=os.stat('WRITER.lock',dir_fd=store_fd,follow_symlinks=False)
    require(stat.S_ISREG(current.st_mode) and current.st_nlink == 1 and
        (before.st_dev,before.st_ino) == (current.st_dev,current.st_ino),'New store writer path changed')
    bind_stage._writer_metadata(descriptor,entry)
    raw=os.pread(descriptor,entry['size']+1,0)
    require(len(raw) == entry['size'] and hashlib.sha256(raw).hexdigest() == entry['sha256'],
            'New store writer content differs from its authenticated manifest')


def _archive(parent,name,prepared):
    raw=_encoded(prepared)
    require(len(raw) <= 16*1024**2,'Admission preparation archive exceeds its evidence budget')
    descriptor=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=parent)
    with os.fdopen(descriptor,'wb') as stream:
        info=os.fstat(stream.fileno());directory=os.fstat(parent)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == directory.st_uid and
            info.st_dev == directory.st_dev and stat.S_IMODE(info.st_mode) == 0o600,
            'New admission archive has unsafe ownership or permissions')
        stream.write(raw);stream.flush();os.fsync(stream.fileno())
    os.fsync(parent)
    return hashlib.sha256(raw).hexdigest()


@contextmanager
def _held_writer(state,entry,writer_fd,store_fd):
    if writer_fd is None:
        with bind_stage._copied_writer(state,entry) as descriptor:yield descriptor
        return
    require(type(writer_fd) is int and writer_fd >= 0,'Exact new store writer descriptor required')
    # A duplicate retains the caller's open file description and flock. Close
    # only our reference; never LOCK_UN a lock still owned by the outer stage.
    descriptor=os.dup(writer_fd)
    try:
        _writer(descriptor,store_fd,entry)
        fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
        _writer(descriptor,store_fd,entry)
        yield descriptor
    finally:os.close(descriptor)


def prepare_guarded(value,*,writer_fd=None):
    """Prepare only under NEW writer; never start, probe, register or retire."""
    require(os.name == 'posix' and os.geteuid() == 0,'Host root required for protected admission preparation')
    request=validate_request(value);pins=request['pins'];entry=request['writer_entry']
    state=migration.host.storage.absolute(pins['state_root'],'Migration canonical state')
    # Validate the token before it participates in an archive pathname.
    require(type(pins['volume_id']) is str and re.fullmatch('[0-9a-f]{32}',pins['volume_id']) and
        pins['volume_id'] != '0'*32,'Exact nonzero admission volume identity required')
    mount=migration.host.storage.absolute(pins['mount_root'],'Migration archive mount')
    archive=mount/'migration'/pins['volume_id']/'state-admission.json'
    store=state/'runs/docker-all/session-store'
    with ExitStack() as stack:
        root_fd=_open_directory_nofollow(state);stack.callback(os.close,root_fd)
        store_fd=_open_directory_nofollow(store);stack.callback(os.close,store_fd)
        parent=_open_directory_nofollow(archive.parent);stack.callback(os.close,parent)
        _require_archive_directory(parent,pins)
        require(not os.path.lexists(archive),'Admission archive already exists; reconcile, never replay')
        with _held_writer(state,entry,writer_fd,store_fd) as locked_writer:
            _writer(locked_writer,store_fd,entry)
            prepared=migration.prepare_state_migration(state,pins)
            _same_directory(state,root_fd);_same_directory(store,store_fd);_same_directory(archive.parent,parent)
            _writer(locked_writer,store_fd,entry)
            digest=_archive(parent,archive.name,prepared)
            _same_directory(archive.parent,parent)
            _writer(locked_writer,store_fd,entry)
            applied=migration.apply_state_migration(state,prepared,archive,digest)
            _same_directory(state,root_fd);_same_directory(store,store_fd);_same_directory(archive.parent,parent)
            _writer(locked_writer,store_fd,entry)
            require(migration._certificate_identity(state) == prepared['certificate_inode'] and
                applied['state'] == 'prepared-not-admitted' and applied['namespace_admitted'] is False and
                applied['certificate_sha256'] == prepared['candidate_sha256'],
                'Prepared certificate identity or admission authority changed')
            return {'schema':SCHEMA,'state':'admission-prepared-not-admitted','volume_id':pins['volume_id'],
                'archive':{'path':str(archive),'sha256':digest},
                'certificate_sha256':prepared['candidate_sha256'],'namespace_admitted':False,'originals_retired':False}
