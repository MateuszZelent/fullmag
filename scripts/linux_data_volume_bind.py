"""One-shot root cutover of an exact completed copy, without admission.

No CLI is exposed. A managed caller must retain the host/group lease and the
live native fences throughout this stage. Stored acknowledgements bind its
scope, but never replace those live guards. Partial outcomes preserve every
tree and a durable ordinary-startup interlock, for explicit recovery.
"""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import os
from pathlib import Path
import re
import stat

import fullmag_data_volume_bind as primitive
import fullmag_data_volume_pending as pending
from fullmag_data_volume_fs import _same_directory
from fullmag_data_volume_guard import _open_directory_nofollow, _parse_object, _read_optional_regular
from fullmag_data_volume_journal import append_started, append_terminal
from fullmag_data_volume_linux_request import _path
from fullmag_data_volume_manifest import _validate_manifest, _read_xattrs
import linux_data_volume_copy as copy_stage
from linux_data_volume_format import _document, _exclusive, _publish_journal, _encoded
import linux_data_volume_provision as qualification


SCHEMA='fullmag.data-volume-linux-bind-request.v1'
REQUEST_KEYS={'schema','volume_id','storage_root','token','copy_request_sha256',
              'copy_receipt_sha256','fence_ready_sha256','components'}
COMPONENTS=(*copy_stage.COMPONENTS,'fullmag_data_volume_bind.py',
            'fullmag_data_volume_pending.py','linux_data_volume_bind.py')
MAX_MANIFEST_BYTES=256*1024**2
ARTIFACTS=('linux-bind-started.json','linux-bind-result.json','linux-bind-failed.json',
           'linux-bind-event-000.json')


def validate_request(value):
    require=qualification.require
    require(type(value) is dict and set(value) == REQUEST_KEYS and value['schema'] == SCHEMA,
            'Closed root bind request required')
    for key in ('volume_id','token'):
        require(type(value[key]) is str and re.fullmatch('[0-9a-f]{32}',value[key]) and value[key] != '0'*32,
                'Exact nonzero bind identity required')
    for key in ('copy_request_sha256','copy_receipt_sha256','fence_ready_sha256'):
        require(type(value[key]) is str and re.fullmatch('[0-9a-f]{64}',value[key]),
                'Exact bind predecessor SHA required')
    _path(value['storage_root'],'bind storage root')
    require(type(value['components']) is dict and set(value['components']) == set(COMPONENTS) and
        all(type(v) is str and re.fullmatch('[0-9a-f]{64}',v) for v in value['components'].values()),
        'Exact root bind component pins required')
    return value


def _components(request):
    for name in COMPONENTS:
        raw=_read_optional_regular(Path(__file__).parent/name,'root bind source',maximum=4*1024**2)
        qualification.require(raw is not None and qualification.digest(raw) == request['components'][name],
                              'Root bind source changed: '+name)


def load_context(request_path,request_sha256):
    require=qualification.require
    require(os.name == 'posix' and os.geteuid() == 0,'Host root required for bind cutover')
    require(type(request_sha256) is str and re.fullmatch('[0-9a-f]{64}',request_sha256),
            'Exact root bind request SHA required')
    _,value=qualification._read(Path(request_path),request_sha256)
    request=validate_request(value);_components(request)
    op=Path(request['storage_root'])/'migrations/data-volumes'/request['volume_id']
    require(Path(request_path) == op/'linux-bind-request.json','Bind request escapes its selected operation')
    copied=copy_stage.load_context(op/'linux-copy-request.json',request['copy_request_sha256'],
                                 completed_receipt_sha256=request['copy_receipt_sha256'])
    require(copied['operation_root'] == op and copied['request']['volume_id'] == request['volume_id'] and
        copied['request']['storage_root'] == request['storage_root'],'Bind copy belongs to another operation')
    # The new operation may have a different token; the old copy token remains
    # authenticated by its own request/result. Never overwrite its ready file.
    _,held=qualification._read(op/'bind-fence-ready.json',request['fence_ready_sha256'])
    copy_stage.validate_held_fence(held,request['token'],request['volume_id'],copied['drain']['process_receipt_sha256'])
    result=copied['copy_result'];plan=copied['plan'];linux=copied['linux']
    raw=_read_optional_regular(Path(result['manifest_path']),'completed source manifest',maximum=MAX_MANIFEST_BYTES)
    require(raw is not None and qualification.digest(raw) == result['manifest_sha256'],
            'Completed copy manifest SHA changed')
    manifest=_validate_manifest(_parse_object(raw,'completed source manifest'),'completed source manifest')
    expected={role:{'path':pin['canonical_root'],'device':pin['device'],'inode':pin['inode']}
              for role,pin in linux['source_roots'].items()}
    require(manifest['roots'] == expected and manifest['data_sha256'] == result['data_sha256'],
            'Completed source manifest belongs to another copy')
    writers=[e for e in manifest['entries'] if e['role'] == 'state' and
             e['path'] == 'runs/docker-all/session-store/WRITER.lock']
    require(len(writers) == 1 and writers[0]['kind'] == 'file',
            'Completed manifest must contain the existing copied store writer descriptor')
    layout={'repo_root':plan['source_root'],'storage_root':plan['storage_root'],'runtime_root':plan['runtime_root'],
            'worktree_id':plan['worktree_id'],'env':{'FULLMAG_PROJECT_ID':plan['project_id']}}
    marker={'schema':pending.SCHEMA,'project_id':plan['project_id'],'worktree_id':plan['worktree_id'],
            'compose_project':plan['compose_project'],'source_root':plan['source_root'],'volume_id':request['volume_id'],
            'plan_sha256':copied['plan_sha256'],'linux_request_sha256':copied['request']['linux_request_sha256'],
            'copy_receipt_sha256':request['copy_receipt_sha256'],
            'state_root':linux['source_roots']['state']['canonical_root'],
            'user_data_root':linux['source_roots']['user_data']['canonical_root']}
    marker=pending.validate_pending(marker,layout,plan['compose_project'])
    require(not os.path.lexists(pending.pending_path(layout)) and
        not os.path.lexists(pending.pending_path(layout).with_name(plan['worktree_id']+'.json')),
        'Pending or registered migration exists; reconcile, never replay')
    for name in ARTIFACTS:
        require(not os.path.lexists(op/name),'Bind has previous artifacts; reconcile, never replay')
    filesystem=copied['provision']['filesystem']
    switch={'schema':primitive.SCHEMA,'volume_id':request['volume_id'],'storage_root':request['storage_root'],
            'mount_root':linux['mount_root'],'filesystem_uuid':linux['filesystem_uuid'],
            'mount_identity':{k:filesystem[k] for k in ('device','inode')},
            'source_manifest':manifest,'copied_roots':result['copied_roots']}
    primitive._scope(switch)
    return {'request':request,'operation_root':op,'copy_context':copied,'copy_result':result,
            'plan':plan,'linux':linux,'primitive':switch,'pending_layout':layout,'pending':marker,
            'writer_entry':writers[0]}


@contextmanager
def _copied_writer(state_root,expected_entry=None):
    """Hold the existing copied store lock before exposing its new inode."""
    state_root=Path(state_root);store=state_root/'runs/docker-all/session-store'
    parent=_open_directory_nofollow(store);descriptor=None
    try:
        descriptor=os.open('WRITER.lock',os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK,dir_fd=parent)
        before=os.fstat(descriptor);directory=os.fstat(parent)
        qualification.require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
            before.st_dev == directory.st_dev == state_root.stat().st_dev,'Unsafe copied store writer lock')
        if expected_entry is None:
            qualification.require(before.st_uid in (0,directory.st_uid) and
                not stat.S_IMODE(before.st_mode) & 0o022,'Unpinned copied writer ownership or permissions differ')
        else:
            # Linux-native defaults grant the operator and UID65532 access by
            # named ACL. Group mode bits represent its mask, not group::write.
            # Preserve and compare the authenticated source metadata verbatim.
            _writer_metadata(descriptor,expected_entry)
        fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
        after=os.stat('WRITER.lock',dir_fd=parent,follow_symlinks=False)
        qualification.require((before.st_dev,before.st_ino) == (after.st_dev,after.st_ino),
                              'Copied store writer lock was replaced')
        if expected_entry is not None:_writer_metadata(descriptor,expected_entry)
        yield descriptor
    finally:
        if descriptor is not None:os.close(descriptor)
        os.close(parent)


def _writer_metadata(descriptor,expected):
    info=os.fstat(descriptor)
    qualification.require(expected.get('role') == 'state' and
        expected.get('path') == 'runs/docker-all/session-store/WRITER.lock' and expected.get('kind') == 'file' and
        {'uid':info.st_uid,'gid':info.st_gid,'mode':stat.S_IMODE(info.st_mode),'mtime_ns':info.st_mtime_ns,
         'xattrs':_read_xattrs(descriptor,'copied store writer')} ==
        {k:expected.get(k) for k in ('uid','gid','mode','mtime_ns','xattrs')},
        'Copied writer metadata/ACL differs from the authenticated source manifest')


def _verify_archive(context):
    """Stream the current retained PAX; never load it into memory or alter it."""
    path=Path(context['copy_result']['archive_path']);parent=_open_directory_nofollow(path.parent)
    descriptor=None
    try:
        descriptor=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK,dir_fd=parent)
        before=os.fstat(descriptor);mount=Path(context['linux']['mount_root']).stat()
        qualification.require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
            before.st_dev == mount.st_dev and before.st_uid == mount.st_uid and
            not stat.S_IMODE(before.st_mode) & 0o022,'Retained PAX archive identity differs')
        digest=hashlib.sha256()
        while raw:=os.read(descriptor,1024**2):digest.update(raw)
        after=os.fstat(descriptor);entry=os.stat(path.name,dir_fd=parent,follow_symlinks=False)
        pin=lambda m:(m.st_dev,m.st_ino,m.st_size,m.st_mtime_ns,m.st_ctime_ns)
        qualification.require(pin(before) == pin(after) == pin(entry) and
            digest.hexdigest() == context['copy_result']['archive_sha256'],'Retained PAX archive SHA or inode changed')
    finally:
        if descriptor is not None:os.close(descriptor)
        os.close(parent)


def publish_pending(context):
    """Durably publish one immutable startup interlock outside both datasets."""
    layout=context['pending_layout'];plan=context['plan']
    value=pending.validate_pending(context['pending'],layout,plan['compose_project'])
    path=pending.pending_path(layout);index=_open_directory_nofollow(path.parent.parent)
    directory=None
    try:
        info=os.fstat(index);owner=context['operation_root'].stat().st_uid
        qualification.require(info.st_uid in (0,owner) and not stat.S_IMODE(info.st_mode) & 0o022,
                              'Pending marker index has a foreign writer')
        try:os.mkdir(path.parent.name,mode=0o755,dir_fd=index)
        except FileExistsError:pass
        directory=os.open(path.parent.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=index)
        parent=os.fstat(directory)
        qualification.require(parent.st_dev == info.st_dev and parent.st_uid in (0,owner) and
            not stat.S_IMODE(parent.st_mode) & 0o022,'Pending marker directory differs')
        raw=_encoded(value);_exclusive(directory,path.name,raw);os.fsync(index)
        _same_directory(path.parent.parent,index);_same_directory(path.parent,directory)
        marker={'path':str(path),'sha256':qualification.digest(raw)}
        _require_pending(context,marker)
        _same_directory(path.parent.parent,index);_same_directory(path.parent,directory)
        return marker
    finally:
        if directory is not None:os.close(directory)
        os.close(index)


def _require_pending(context,marker):
    path=pending.pending_path(context['pending_layout'])
    qualification.require(marker['path'] == str(path),'Pending marker reference escapes its selected scope')
    raw=_read_optional_regular(path,'published pending marker',maximum=pending.MAX_BYTES)
    qualification.require(raw is not None and qualification.digest(raw) == marker['sha256'] and
        _parse_object(raw,'published pending marker') == context['pending'],
        'Canonical pending marker changed before bind mutation')


def bind_verified(request_path,request_sha256):
    """Switch once under caller-held live fences; preserve partial outcomes."""
    context=load_context(request_path,request_sha256);op=context['operation_root'];request=context['request']
    with copy_stage._operation_lock(op):
        qualification.require(load_context(request_path,request_sha256) == context,'Bind context changed before its lock')
        with _copied_writer(Path(context['primitive']['copied_roots']['state']),context['writer_entry']):
            _verify_archive(context)
            copied=context['copy_context'];journal_path=copied['journal_path'];journal=copied['journal']
            started=append_started(journal,'binds-switched',request_sha256)
            _publish_journal(journal_path,journal,started)
            marker=None;written=False
            try:
                _document(op,'linux-bind-started.json',{'schema':'fullmag.data-volume-bind-started.v1',
                    'volume_id':request['volume_id'],'token':request['token'],'request_sha256':request_sha256})
                marker=publish_pending(context)
                events=[]
                def record(event):
                    _require_pending(context,marker)
                    _document(op,'linux-bind-event-'+str(len(events)).zfill(3)+'.json',event)
                    events.append(event)
                    _require_pending(context,marker)
                _require_pending(context,marker)
                switched=primitive.switch_roots(context['primitive'],record)
                _require_pending(context,marker)
                result={'schema':'fullmag.data-volume-linux-bind-result.v1','state':'binds-switched-not-admitted',
                    'volume_id':request['volume_id'],'token':request['token'],'request_sha256':request_sha256,
                    'copy_receipt_sha256':request['copy_receipt_sha256'],'pending_marker':marker,'switch':switched,
                    'namespace_admitted':False,'originals_retired':False}
                result_sha=_document(op,'linux-bind-result.json',result);written=True
                _publish_journal(journal_path,started,append_terminal(started,'succeeded',result_sha))
                return result
            except BaseException as error:
                # Once the marker is published, even a partially switched
                # namespace stays blocked for explicit recovery, never restart.
                state=('failed-confirmed' if isinstance(error,Exception) and marker is None and not written
                       else 'outcome-unknown-resources-retained')
                failure={'schema':'fullmag.data-volume-linux-bind-failure.v1','state':state,
                    'volume_id':request['volume_id'],'token':request['token'],'request_sha256':request_sha256,
                    'error_type':type(error).__name__,'originals_and_copies_retained':True,
                    'manual_recovery_required':True}
                failure_sha=_document(op,'linux-bind-failed.json',failure)
                _,current=qualification._read(journal_path)
                if current == started:
                    _publish_journal(journal_path,started,append_terminal(started,state,failure_sha))
                raise
