"""Retain originals and switch two verified roots under a managed migration.

These primitives grant no lifecycle or namespace authority. The managed caller
must authenticate its plan, archive, terminal copy, host namespace and stopped
group, hold its host/operation/writer guards, and persist every record outside
the two datasets. A failed partial switch retains all trees and mountpoints;
it must leave the group stopped for explicit recovery, never replay or restart.
There is deliberately no CLI, automatic rollback, deletion or admission here.
"""
from __future__ import annotations

from contextlib import ExitStack
import ctypes
import json
import os
from pathlib import Path
import re
import stat
import subprocess
from uuid import UUID

from fullmag_data_volume_fs import _directory_fd, _same_directory
from fullmag_data_volume_manifest import inventory_datasets, require_matching_data, _validate_manifest
from fullmag_data_volume_guard import resolve_mount_uuid
from fullmag_data_volume_linux_request import _path
import linux_data_volume_provision as qualification


SCHEMA = 'fullmag.data-volume-bind-request.v1'
KEYS = {'schema','volume_id','storage_root','mount_root','filesystem_uuid',
        'mount_identity','source_manifest','copied_roots'}
ROLES = ('user_data','state')


def _identity(metadata):
    return {'device':metadata.st_dev,'inode':metadata.st_ino}


def _positive_identity(value, label):
    qualification.require(type(value) is dict and set(value) == {"device", "inode"} and
        all(type(item) is int and item > 0 for item in value.values()),
        "Exact positive " + label + " identity required")


def validate_switch_result(switch, request, linux, copy_result):
    """Validate the closed nested switch result against authenticated input views.

    This pure check deliberately performs no host observations and grants no
    admission authority; callers must authenticate the inputs and separately
    establish the live mount and lifecycle guards.
    """
    require = qualification.require
    root_keys = {"role", "canonical_root", "backup_root", "copied_root", "original_identity",
                 "underlay_identity", "bound_identity", "mount"}
    require(type(switch) is dict and set(switch) == {
        "schema", "state", "volume_id", "filesystem_uuid", "data_sha256", "roots",
        "namespace_admitted", "originals_retired",
    } and switch["schema"] == "fullmag.data-volume-bind-result.v1" and
        switch["state"] == "binds-switched-not-admitted" and
        switch["volume_id"] == request["volume_id"] and
        switch["filesystem_uuid"] == linux["filesystem_uuid"] and
        switch["data_sha256"] == copy_result["data_sha256"] and
        switch["namespace_admitted"] is False and switch["originals_retired"] is False and
        type(switch["roots"]) is dict and set(switch["roots"]) == {"state", "user_data"},
        "Nested root bind result differs from the verified copy")
    for role, source in linux["source_roots"].items():
        row = switch["roots"][role]
        canonical = Path(source["canonical_root"])
        backup = canonical.with_name("." + canonical.name + ".fullmag-before-" + request["volume_id"])
        require(type(row) is dict and set(row) == root_keys and row["role"] == role and
            row["canonical_root"] == str(canonical) and row["backup_root"] == str(backup) and
            row["copied_root"] == copy_result["copied_roots"][role] and
            row["original_identity"] == {key: source[key] for key in ("device", "inode")},
            "Nested root bind path or original identity differs: " + role)
        _positive_identity(row["underlay_identity"], role + " underlay")
        _positive_identity(row["bound_identity"], role + " bound root")
        require(row["underlay_identity"]["device"] == source["device"] and
            row["bound_identity"]["device"] != source["device"],
            "Nested bind inode identities cross the wrong filesystems: " + role)
        mount = row["mount"]
        require(type(mount) is dict and set(mount) == {"target", "fstype", "uuid", "options", "propagation"} and
            mount["target"] == str(canonical) and mount["fstype"] == "ext4" and
            mount["uuid"] == linux["filesystem_uuid"] and
            type(mount["options"]) is str and
            {"rw", "nodev", "nosuid"} <= set(mount["options"].split(",")) and
            mount["propagation"] == "private",
            "Nested canonical bind mount identity or protection differs: " + role)


def _scope(request):
    """Validate the closed scope before any filesystem mutation."""
    require=qualification.require
    require(type(request) is dict and set(request) == KEYS and request['schema'] == SCHEMA,
            'Closed bind request required')
    require(type(request['volume_id']) is str and re.fullmatch('[0-9a-f]{32}',request['volume_id']) and
            request['volume_id'] != '0'*32,'Exact nonzero bind volume identity required')
    _path(request['storage_root'],'bind storage root');_path(request['mount_root'],'bind mount root')
    root,target=Path(request['storage_root']),Path(request['mount_root'])
    require(root != target and root not in target.parents and target not in root.parents,
            'Bind mount view and original storage must be disjoint')
    try:
        value=request['filesystem_uuid']
        valid=type(value) is str and str(UUID(value)) == value and UUID(value).int != 0
    except (ValueError,TypeError,AttributeError):valid=False
    require(valid,'Canonical nonzero bind filesystem UUID required')
    identity=request['mount_identity']
    require(type(identity) is dict and set(identity) == {'device','inode'} and
            all(type(v) is int and v > 0 for v in identity.values()),'Exact bind mount identity required')
    manifest=_validate_manifest(request['source_manifest'],'bind source manifest')
    sources={role:Path(manifest['roots'][role]['path']) for role in ROLES}
    require(all(p != root and root in p.parents for p in sources.values()),
            'Bind original roots must be below the exact project storage')
    copies={role:str(target/'payload'/p.relative_to(root)) for role,p in sources.items()}
    require(type(request['copied_roots']) is dict and request['copied_roots'] == copies,
            'Bind copied roots differ from the exact verified payload')
    require(all(identity['device'] != manifest['roots'][r]['device'] for r in ROLES),
            'Bind destination must be a different filesystem')
    return sources,{role:Path(p) for role,p in copies.items()}


def _mount_info(path,exact=False):
    args=['findmnt','--json','--mountpoint' if exact else '--target',str(path),
          '--output','TARGET,FSTYPE,UUID,MAJ:MIN,OPTIONS,PROPAGATION']
    result=qualification._capture(args,allowed=(0,1))
    if result.returncode == 1:
        qualification.require(exact and not result.stdout.strip(),'Mount observation is ambiguous')
        return None
    rows=json.loads(result.stdout).get('filesystems')
    qualification.require(type(rows) is list and len(rows) == 1,'Exactly one mount observation required')
    row=rows[0]
    qualification.require(type(row) is dict and 'uuid' in row and 'UUID' not in row,
                          'Mount observation must report exactly one UUID field')
    if row['uuid'] is None:
        row=dict(row)
        major_minor=row.get('maj:min')
        qualification.require(type(major_minor) is str and
            re.fullmatch(r'[0-9]+:[0-9]+',major_minor),
            'Null mount UUID requires an exact findmnt major:minor identity')
        row['uuid']=resolve_mount_uuid(path,None,major_minor=major_minor)
    else:
        qualification.require(type(row['uuid']) is str and bool(row['uuid']),
                              'Mount observation UUID must be a nonempty string')
    return row


def _destination(request):
    target=Path(request['mount_root'])
    row=_mount_info(target,exact=True)
    qualification.require(row is not None and row.get('target') == str(target) and
        row.get('fstype') == 'ext4' and row.get('uuid') == request['filesystem_uuid'] and
        {'rw','nodev','nosuid'} <= set(row.get('options','').split(',')) and
        row.get('propagation') == 'private','Exact protected new mount is required for bind switching')
    with _directory_fd(target) as fd:
        info=os.fstat(fd)
        qualification.require(_identity(info) == request['mount_identity'] and info.st_uid == 0 and
            not stat.S_IMODE(info.st_mode) & 0o022,'New bind filesystem root changed or is writable by others')
    return target


def _private_parent(path):
    row=_mount_info(path.parent)
    qualification.require(row is not None and row.get('propagation') == 'private',
                          'Original bind parent must be on a private mount')


def _rename_noreplace(parent_fd,old_name,backup_name):
    """Atomically retain a directory without replacing even an empty target."""
    qualification.require(all(type(p) is str and p not in ('','.','..') and '/' not in p and '\0' not in p
                              for p in (old_name,backup_name)),'Rename requires two literal directory entries')
    try:rename=ctypes.CDLL(None,use_errno=True).renameat2
    except AttributeError as error:raise ValueError('Atomic no-replace rename is unavailable') from error
    rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    rename.restype=ctypes.c_int
    if rename(parent_fd,os.fsencode(old_name),parent_fd,os.fsencode(backup_name),1) != 0:
        code=ctypes.get_errno()
        raise OSError(code,os.strerror(code),backup_name)
    os.fsync(parent_fd)


def _mount(args,pass_fds=()):
    # Fixed system tool and minimal environment: inherited mount options or
    # executable search paths must not change a privileged operation.
    result=subprocess.run(['/usr/bin/mount','--no-canonicalize',*args],
        stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
        env=qualification.ENV,pass_fds=pass_fds,check=False)
    qualification.require(result.returncode == 0,'Bind mount command failed; retained resources require recovery')


def _bind(source_fd,target_fd):
    _mount(['--bind','/proc/self/fd/'+str(source_fd),'/proc/self/fd/'+str(target_fd)],
           (source_fd,target_fd))


def _make_private(path):
    with _directory_fd(path) as fd:
        _mount(['--make-private','/proc/self/fd/'+str(fd)],(fd,))


def _underlay(parent_fd,name):
    os.mkdir(name,mode=0,dir_fd=parent_fd)
    metadata=os.stat(name,dir_fd=parent_fd,follow_symlinks=False)
    qualification.require(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == 0 and
                          stat.S_IMODE(metadata.st_mode) == 0,'New bind underlay is not root-owned mode000')
    os.fsync(parent_fd)
    return _identity(metadata)


def switch_roots(request,record):
    """One-shot switch, preserving both originals; caller retains all guards.

    Records are write-ahead intents and observations, not replay authority.
    A callback failure aborts immediately and never removes/rolls back a tree.
    A missing/canceled terminal observation must retain the caller's live lease.
    """
    qualification.require(os.name == 'posix' and os.geteuid() == 0,'Host root required to switch bind roots')
    qualification.require(callable(record),'A durable external migration record callback is required')
    sources,copies=_scope(request)
    target=_destination(request)
    manifest=request['source_manifest']
    require=qualification.require
    # Re-read both complete datasets while the managed caller holds its live
    # fences. Changed bytes/ACL/mtime/hardlinks abort before the first rename.
    require_matching_data(manifest,inventory_datasets(sources))
    require_matching_data(manifest,inventory_datasets(copies))
    result={}
    with ExitStack() as stack:
        mount_fd=stack.enter_context(_directory_fd(target))
        require(_identity(os.fstat(mount_fd)) == request['mount_identity'],'Bind mount identity drifted')
        held={}
        # Pin and check BOTH roots before mutating either one.
        for role in ROLES:
            path=sources[role];backup=path.with_name('.'+path.name+'.fullmag-before-'+request['volume_id'])
            parent_fd=stack.enter_context(_directory_fd(path.parent))
            original_fd=stack.enter_context(_directory_fd(path))
            copied_fd=stack.enter_context(_directory_fd(copies[role]))
            old=os.fstat(original_fd);parent=os.fstat(parent_fd);new=os.fstat(copied_fd)
            require(len(os.fsencode(backup.name)) <= os.fpathconf(parent_fd,'PC_NAME_MAX'),
                    'Retained original name exceeds its filesystem limit')
            require(parent.st_uid in (0,old.st_uid) and not stat.S_IMODE(parent.st_mode) & 0o022 and
                old.st_dev == parent.st_dev and _identity(old) ==
                {k:manifest['roots'][role][k] for k in ('device','inode')} and
                new.st_dev == request['mount_identity']['device'],'Pinned bind source or parent identity differs')
            try:os.stat(backup.name,dir_fd=parent_fd,follow_symlinks=False)
            except FileNotFoundError:pass
            else:raise ValueError('Retained original already exists; reconcile, never replay')
            require(_mount_info(path,exact=True) is None,'Original root already has a mount; reconcile, never replay')
            _private_parent(path)
            held[role]=(parent_fd,original_fd,copied_fd,backup)
        for role in ROLES:
            path=sources[role];parent_fd,original_fd,copied_fd,backup=held[role]
            detail={'role':role,'canonical_root':str(path),'backup_root':str(backup),
                    'copied_root':str(copies[role]),'original_identity':_identity(os.fstat(original_fd))}
            def event(step,**extra):record(dict(detail,step=step,**extra))
            _same_directory(target,mount_fd);_same_directory(path.parent,parent_fd)
            _same_directory(path,original_fd);_same_directory(copies[role],copied_fd)
            require(_mount_info(path,exact=True) is None,'Original root mount changed before rename')
            _private_parent(path)
            event('rename-intent')
            _same_directory(path.parent,parent_fd);_same_directory(path,original_fd)
            _private_parent(path)
            _rename_noreplace(parent_fd,path.name,backup.name)
            _same_directory(backup,original_fd)
            event('original-retained')
            underlay=_underlay(parent_fd,path.name)
            event('underlay-created',underlay_identity=underlay)
            underlay_fd=stack.enter_context(_directory_fd(path))
            require(_identity(os.fstat(underlay_fd)) == underlay and not os.listdir(underlay_fd),
                    'New bind underlay changed before mount')
            _same_directory(target,mount_fd);_same_directory(copies[role],copied_fd)
            event('bind-intent',underlay_identity=underlay)
            _same_directory(path,underlay_fd);_same_directory(target,mount_fd)
            _private_parent(path)
            _bind(copied_fd,underlay_fd)
            current=stack.enter_context(_directory_fd(path))
            require(_identity(os.fstat(current)) == _identity(os.fstat(copied_fd)),
                    'Canonical bind does not resolve to the exact copied directory')
            # Authenticate the new view before changing propagation: a no-op
            # or substituted bind must never make the old host mount private.
            _make_private(path)
            row=_mount_info(path,exact=True)
            require(row is not None and row.get('target') == str(path) and row.get('fstype') == 'ext4' and
                row.get('uuid') == request['filesystem_uuid'] and row.get('propagation') == 'private' and
                {'rw','nodev','nosuid'} <= set(row.get('options','').split(',')),
                'Canonical bind mount identity or protection differs')
            _same_directory(backup,original_fd)
            result[role]=dict(detail,underlay_identity=underlay,
                              bound_identity=_identity(os.fstat(current)),mount=row)
            event('bind-verified',bound_identity=result[role]['bound_identity'])
        _destination(request)
        require_matching_data(manifest,inventory_datasets(sources))
        backups={role:held[role][3] for role in ROLES}
        require_matching_data(manifest,inventory_datasets(backups))
    return {'schema':'fullmag.data-volume-bind-result.v1','state':'binds-switched-not-admitted',
            'volume_id':request['volume_id'],'filesystem_uuid':request['filesystem_uuid'],
            'data_sha256':manifest['data_sha256'],'roots':result,
            'namespace_admitted':False,'originals_retired':False}
