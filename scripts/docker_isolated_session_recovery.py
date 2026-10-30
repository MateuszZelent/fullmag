"""Explicit Linux-only verified-copy recovery of one stopped DEV group.

No original certificate, OWNER, catalog, result or workspace byte is replaced.
The new namespace grants only a gated first start, never replay of a script.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import struct
import uuid

from docker_build_control import BuildControlError, canonical, docker_capture, bounded_capture
from docker_control_namespace import REGISTRY_PATH, REGISTRY_SCHEMA, _raw
from docker_isolated_snapshot_namespace import SNAPSHOT_SCHEMA, SNAPSHOT_STATE, validate_snapshot_namespace_receipt
from docker_isolated_snapshot_copy import snapshot_tree, copy_verified_tree, hold_source_writer
from docker_isolated_sqlite_snapshot import validate_copied_workspace
from docker_isolated_sqlite_fence import hold_managed_workspace_database
from docker_isolated_control_snapshot import snapshot_control_workspace
import docker_linux_host_readmission as retained
import docker_volume_container_recovery as recovery
from docker_isolated_stopped_predecessor import load_stopped_predecessor, validate_stopped_incarnations
import fullmag_storage as storage
import linux_native_host as host


def digest(raw): return hashlib.sha256(raw).hexdigest()


def _root_control(control):
    result=copy.copy(control); result.namespace=''; result.namespace_registry_sha256=None
    return result


def _once(control, relative, raw):
    before=control.read_bytes(relative, optional=True)
    if before is not None and before != raw:
        raise BuildControlError('Isolated snapshot evidence already differs: '+relative)
    if before is None: control.write_bytes(relative, raw)
    if control.read_bytes(relative) != raw:
        raise BuildControlError('Isolated snapshot evidence readback differs: '+relative)


def _successor_admission_pins(control, pins, terminal_raw, *, context=None, compose=None, state=None,
                              validation_terminal_raw=None):
    """Require a completed prior admission; preserve its immutable authority."""
    from docker_control_namespace import assert_namespace_activation
    native_path='isolated-snapshot/native-validation.json'
    native_raw=control.read_bytes(native_path)
    assert_namespace_activation(control)
    if control.read_bytes(native_path)!=native_raw:
        raise BuildControlError('Successor snapshot native admission changed during validation')
    original=retained._parse_object(terminal_raw,'successor original development terminal receipt')
    terminal=retained._parse_object(validation_terminal_raw if validation_terminal_raw is not None else terminal_raw,
                                   'successor development terminal receipt')
    identity_fields=('backend_container','frontend_container')
    if (canonical({k:v for k,v in original.items() if k not in identity_fields})
            !=canonical({k:v for k,v in terminal.items() if k not in identity_fields})
            or any(original.get(k) is not None and original[k]!=terminal.get(k) for k in identity_fields)):
        raise BuildControlError('Successor terminal normalization changed original semantics')
    expected={'schema':'fullmag.docker-build-operation.v1','phase':'development',
              'attempt':pins['development_attempt'],
              'config_sha256':pins['compose_config_sha256'],
              'backend_container':pins['backend_container_id'],
              'frontend_container':pins['frontend_container_id'],
              'control_namespace':control.namespace,
              'namespace_registry_sha256':control.namespace_registry_sha256}
    if (terminal.get('state') not in ('succeeded','failed-confirmed')
            or any(terminal.get(key)!=value for key,value in expected.items())):
        raise BuildControlError('Successor snapshot requires the exact admitted predecessor')
    result={}
    for path in ('development/current.json','development/verified.json'):
        raw=control.read_bytes(path)
        if path=='development/verified.json' and terminal['state']=='failed-confirmed':
            if context is None or compose is None or state is None:
                raise BuildControlError('Failed successor requires the validated source state and Compose context')
            verified=retained._parse_object(raw,'successor verified development receipt')
            previous=dict(pins)
            fields=(('development_attempt','attempt',retained._ATTEMPT),
                    ('backend_container_id','backend_container',retained._CONTAINER_ID),
                    ('frontend_container_id','frontend_container',retained._CONTAINER_ID))
            for target,source,pattern in fields:
                value=verified.get(source)
                if not isinstance(value,str) or pattern.fullmatch(value) is None:
                    raise BuildControlError('Successor verified predecessor has malformed '+source)
                previous[target]=value
            previous['compose_config_sha256']=retained._sha(verified.get('config_sha256'),'verified Compose digest')
            inputs=verified.get('inputs')
            image=inputs.get('image_id') if isinstance(inputs,dict) else None
            if not isinstance(image,str) or retained._IMAGE_ID.fullmatch(image) is None:
                raise BuildControlError('Successor verified predecessor has malformed image')
            previous['old_image_id']=image
            if (previous['development_attempt']==pins['development_attempt']
                    or previous['backend_container_id']==previous['frontend_container_id']
                    or verified.get('control_namespace')!=control.namespace
                    or verified.get('namespace_registry_sha256')!=control.namespace_registry_sha256):
                raise BuildControlError('Successor verified predecessor namespace or service pins differ')
            terminal_path,compose_path=retained._terminal_paths(previous['development_attempt'])
            previous_terminal=retained._read_control(control,terminal_path)
            previous_compose=retained._read_control(control,compose_path)
            if raw!=previous_terminal:
                raise BuildControlError('Successor verified pointer differs from its immutable terminal')
            _,validated_compose,validated_state=retained._validate_terminal_and_compose(
                control,previous,context['identity'],previous_terminal,previous_compose,context['layout'])
            if (validated_state!=state
                    or _data_root(validated_compose,context['layout'])!=_data_root(compose,context['layout'])):
                raise BuildControlError('Successor verified predecessor state or user-data root differs')
            result[control.namespace+'/'+terminal_path]=previous_terminal
            result[control.namespace+'/'+compose_path]=previous_compose
        elif raw!=terminal_raw:
            raise BuildControlError('Successor snapshot predecessor pointer differs: '+path)
        result[control.namespace+'/'+path]=raw
    result[control.namespace+'/'+native_path]=native_raw
    return result


def _merge_control_pins(target, *sources):
    for source in sources:
        for path,raw in source.items():
            if path in target and target[path]!=raw:
                raise BuildControlError('Conflicting original control evidence: '+path)
            target[path]=raw


def _stopped_pair(context, pins, compose):
    control=context['control']; ids=[pins[k+'_container_id'] for k in ('backend','frontend')]
    rows=json.loads(docker_capture('inspect',*ids,timeout=60).stdout)
    if len(rows)!=2 or {r['Id'] for r in rows}!=set(ids):
        raise BuildControlError('Pinned stopped pair differs')
    image=retained._image_config(pins['old_image_id']); result={}
    for service,identifier in zip(('backend','frontend'),ids):
        row=next(r for r in rows if r['Id']==identifier)
        retained._validate_stopped_service(row,request=pins,service=service,project=control.project,
             identity=context['identity'],compose=compose,image_config=image)
        result[service]=row
    return result


def _owner_control(control, validated_backend):
    """Pin the already-authenticated backend config digest for OWNER locking."""
    image = validated_backend.get('Image')
    if not isinstance(image, str) or re.fullmatch(r'sha256:[0-9a-f]{64}', image) is None:
        raise BuildControlError('OWNER helper requires the validated immutable backend image')
    result = copy.copy(control)
    result.image = image
    return result


def _data_root(compose, layout):
    mounts=compose['services']['backend']['volumes']
    selected=[m for m in mounts if isinstance(m,dict) and m.get('target')=='/user-data']
    if len(selected)!=1 or selected[0].get('type')!='bind':
        raise BuildControlError('Retained user-data mount is not one exact bind')
    path=storage.validate_path(Path(selected[0]['source']),Path(layout['storage_root'])/'user-data','retained workspace')
    if path.resolve(strict=True)!=path or not path.is_dir():
        raise BuildControlError('Retained workspace source is not canonical')
    return path


def _admit_copy(root):
    """Grant runtime access only to newly copied operator-owned data."""
    undefined=0xffffffff
    for directory,dirs,files in os.walk(root,followlinks=False):
        parent=Path(directory); host.admit_runtime_uid(parent)
        for name in files:
            path=parent/name
            fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
            try:
                info=os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=os.getuid():
                    raise BuildControlError('New snapshot file is not singly owned by this operator')
                entries=[(1,6,undefined),(2,6,65532),(4,0,undefined),(16,6,undefined),(32,0,undefined)]
                acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*e) for e in entries)
                os.setxattr(fd,'system.posix_acl_access',acl); os.fsync(fd)
            finally: os.close(fd)


# This commit opens existing locks without modifying their descriptor bytes.
# The native OWNER and source WRITER are held by the outer operation. Only the
# registry is replaced, after all immutable proof files are durably published.
COMMIT=r'''
import fcntl,hashlib,json,os,pathlib,stat,sys
root=pathlib.Path('/control'); p=json.loads(sys.stdin.buffer.read(8*1024*1024+1))
def read(rel):
 q=root/rel
 if q.resolve()!=q: raise RuntimeError('noncanonical control path')
 s=q.lstat()
 if not stat.S_ISREG(s.st_mode) or s.st_size>8*1024*1024: raise RuntimeError('unsafe control record')
 return q.read_bytes()
fd=os.open(root/'operation.lock',os.O_RDONLY|os.O_NOFOLLOW)
fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
if hashlib.sha256(read('namespaces/current.json')).hexdigest()!=p['previous_registry_sha256']: raise RuntimeError('registry CAS changed')
for rel,sha in p['pins'].items():
 if hashlib.sha256(read(rel)).hexdigest()!=sha: raise RuntimeError('control evidence changed: '+rel)
target=root/p['namespace']
if target.resolve()!=target or not target.is_dir(): raise RuntimeError('new namespace staging absent')
lock=target/'operation.lock'
if lock.is_symlink(): raise RuntimeError('linked namespace lock')
if lock.exists():
 if lock.stat().st_ino!=(root/'operation.lock').stat().st_ino: raise RuntimeError('wrong namespace lock')
else: os.link(root/'operation.lock',lock)
registry=root/'namespaces/current.json'
tmp=registry.parent/('.isolated-'+p['recovery_id'])
raw=json.dumps(p['registry'],sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
f=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o640)
with os.fdopen(f,'wb') as out: out.write(raw);out.flush();os.fsync(out.fileno())
if hashlib.sha256(read('namespaces/current.json')).hexdigest()!=p['previous_registry_sha256']: raise RuntimeError('registry CAS changed before publish')
os.replace(tmp,registry)
d=os.open(registry.parent,os.O_RDONLY|os.O_DIRECTORY);os.fsync(d);os.close(d)
print(json.dumps({'state':'snapshot-namespace-published','namespace':p['namespace'],'registry_sha256':hashlib.sha256(raw).hexdigest()}))
'''


def _remove_stopped(record):
    """Remove only archived, exact stopped IDs; never stop any container."""
    for identifier in record['old_container_ids'].values():
        listed=docker_capture('ps','-aq','--no-trunc',timeout=60).stdout.decode().split()
        if identifier not in listed:
            again=docker_capture('ps','-aq','--no-trunc',timeout=60).stdout.decode().split()
            if identifier in again: raise BuildControlError('Retired container inventory changed')
            continue
        rows=json.loads(docker_capture('inspect',identifier,timeout=60).stdout)
        if len(rows)!=1 or rows[0]['Id']!=identifier or rows[0]['Image']!=record['old_image_id']:
            raise BuildControlError('Retired stopped container identity differs')
        retained._validate_stopped_state(rows[0])
        labels=rows[0]['Config']['Labels']
        if labels.get('com.docker.compose.project')!=record['compose_project']:
            raise BuildControlError('Retired stopped container group differs')
        docker_capture('rm',identifier,timeout=60)


def recover(args):
    if not re.fullmatch('[0-9a-f]{32}',args.recovery_id):
        raise BuildControlError('Recovery requires an explicit 32-hex identity')
    parser=(retained.parse_snapshot_operator_bytes if getattr(args,'successor_snapshot',False)
            else retained.parse_operator_bytes)
    pins,pin_raw,pin_path=retained._read_operator_file(args.operator_pins,parser=parser)
    context=retained._request_context(args,pins); control=context['control']; raw_control=_root_control(control)
    if control.project!='fullmag-master':
        raise BuildControlError('Initial isolated retained-snapshot route is qualified only for master')
    prior=(control.namespace_registry or {}).get('retirement',{})
    successor=False
    if prior.get('schema')==SNAPSHOT_SCHEMA:
        if prior['recovery_id']==args.recovery_id:
            if control.read('isolated-snapshot/start.json')['restore_run_id'] != args.restore_run_id:
                raise BuildControlError('Snapshot selected model differs from this recovery')
            if args.apply: _remove_stopped(prior)
            return {'state':'snapshot-awaiting-gated-start','namespace':control.namespace,'original_preserved':True}
        if not getattr(args,'successor_snapshot',False):
            raise BuildControlError('A different isolated snapshot is already selected; explicit successor required')
        successor=True
    elif getattr(args,'successor_snapshot',False):
        raise BuildControlError('Successor snapshot requires a selected isolated predecessor')
    token=args.recovery_id; root='namespace-recovery/'+token; namespace='namespaces/'+token
    terminal_rel,compose_rel=retained._terminal_paths(pins['development_attempt'])
    terminal_raw=retained._read_control(control,terminal_rel); compose_raw=retained._read_control(control,compose_rel)
    proof_path=getattr(args,'stopped_predecessor_proof',None)
    proof_sha=getattr(args,'stopped_predecessor_proof_sha256',None)
    if (proof_path is None)!=(proof_sha is None):
        raise BuildControlError('Stopped predecessor proof requires both its control path and SHA-256')
    validation_raw=terminal_raw; stopped_pins={}; stopped_services=None
    if proof_path is not None:
        if not successor or retained._parse_object(terminal_raw,'original development terminal').get('state')!='failed-confirmed':
            raise BuildControlError('Stopped predecessor proof requires an explicit failed successor snapshot')
        validation_raw,stopped_pins,stopped_services=load_stopped_predecessor(control,pins,terminal_raw,proof_path,proof_sha)
    terminal,compose,state=retained._validate_terminal_and_compose(control,pins,context['identity'],validation_raw,compose_raw,context['layout'],
        allowed_terminal_states=('succeeded','failed-confirmed') if successor else ('succeeded',))
    admission_pins=(_successor_admission_pins(control,pins,terminal_raw,context=context,compose=compose,state=state,
                                           validation_terminal_raw=validation_raw)
                    if successor else {})
    def observe_pair():
        pair=_stopped_pair(context,pins,compose)
        if stopped_services is not None:
            validate_stopped_incarnations(pair,stopped_services)
        return pair
    runtime=retained._read_runtime_records(control,pins)
    if digest(host.read_owned_regular(state/host.CERTIFICATE_NAME))!=pins['expected_certificate_sha256'] or digest(host.read_owned_regular(state/host.OWNER_NAME))!=pins['expected_owner_sha256']:
        raise BuildControlError('Original host admission bytes changed')
    certificate=json.loads(host.read_owned_regular(state/host.CERTIFICATE_NAME))
    if (state.stat().st_ino!=pins['expected_inode']
            or certificate.get('host_inode')!=pins['expected_inode']
            or certificate.get('host_device')!=pins['old_host_device']
            or state.stat().st_dev!=pins['new_host_device']
            or certificate.get('engine_id')!=retained._engine_id()
            or retained._filesystem_uuid(state)!=pins['filesystem_uuid']):
        raise BuildControlError('Source state inode, engine or current filesystem identity differs')
    old_registry=_raw(raw_control,REGISTRY_PATH)
    pair=observe_pair()
    user_data=_data_root(compose,context['layout'])
    terminal_pins=json.loads(host.read_owned_regular(args.retained_terminal_runs.absolute(),1024*1024))
    held_pins=json.loads(host.read_owned_regular(args.retained_held_manual_runs.absolute(),1024*1024))
    if args.restore_run_id not in {p.get('run_id') for p in held_pins}:
        raise BuildControlError('Explicit restored model must be one of the held-manual pins')
    # Full native-equivalent readonly storage proof, including released ledger,
    # catalog fences, CAS and manual-start absence. No original write authority.
    proof=recovery._ledger_and_store_snapshot(control,pair['backend'],compose=compose,
            retained_terminal_runs=terminal_pins,retained_held_manual_runs=held_pins)
    destination=Path(context['layout']['runtime_root'])/'docker-volume-dev'/token
    destination_user=Path(context['layout']['storage_root'])/'user-data'/(control.project+'-isolated-'+token)
    prefix=(control.namespace+'/') if control.namespace else ''
    paths={prefix+terminal_rel:terminal_raw,prefix+compose_rel:compose_raw}
    _merge_control_pins(paths,admission_pins,stopped_pins)
    for name,relative in retained._RUNTIME_RECORDS.items():
        _merge_control_pins(paths,{prefix+relative:runtime[name]})
    previous_registry_path=root+'/previous-registry.json'; paths[previous_registry_path]=old_registry
    record={
      'schema':SNAPSHOT_SCHEMA,'state':SNAPSHOT_STATE,'recovery_id':token,'namespace':namespace,
      'previous_namespace':control.namespace,'compose_project':control.project,'control_volume':control.volume,
      'source_project_id':context['identity']['project_id'],'source_worktree_id':context['identity']['worktree_id'],
      'source_root':str(context['selected']),'source_state_root':str(state),'destination_state_root':str(destination),
      'source_user_data_root':str(user_data),'destination_user_data_root':str(destination_user),
      'source_manifest_path':root+'/source-manifest.json','source_manifest_sha256':'0'*64,
      'request_path':root+'/request.json','request_sha256':'0'*64,
      'original_config_path':root+'/original-config.json','original_config_sha256':digest(runtime['runtime_config']),
      'old_container_ids':{s:pair[s]['Id'] for s in ('backend','frontend')},'old_image_id':pins['old_image_id'],
      'allow_old_request_replay':False,'allow_new_requests':False,
      'terminal_run_count':len(terminal_pins),'held_manual_run_count':len(held_pins),
      'old_development_attempt':pins['development_attempt'],'old_request_id':prior.get('old_request_id',pins['request_id']),
      'previous_registry_path':previous_registry_path,'previous_registry_sha256':digest(old_registry),
      'control_pins':{path:digest(raw) for path,raw in paths.items()},
    }
    if not args.apply:
        return {'state':'preview-no-copy','record':record,'storage_proof':proof,'original_preserved':True}
    if destination.exists() or destination_user.exists():
        raise BuildControlError('Snapshot destination already exists; inspect retained partial copy')
    # These locks never alter OWNER, writer records or SQLite bytes. Existing
    # active readers/writers cause a refusal instead of being interrupted.
    with retained._owner_lock(_owner_control(control,pair['backend'])), hold_source_writer(state/'runs/docker-all/session-store') as store_fd, hold_managed_workspace_database(control,pair['backend'],user_data) as workspace_fence:
        def verify_store_binding():
            pinned=os.fstat(store_fd); current=(state/'runs/docker-all/session-store').stat()
            if (pinned.st_dev,pinned.st_ino)!=(current.st_dev,current.st_ino):
                raise BuildControlError('Source store differs from the locked directory')
        verify_store_binding()
        workspace_fence.verify()
        pair_before=observe_pair()
        live_workspace=snapshot_control_workspace(control,token,image_id=pins['old_image_id'])['source']
        source={'schema':'fullmag.isolated-session-snapshot-manifest.v1',
                'state':snapshot_tree(state/'runs'),'user_data':snapshot_tree(user_data),
                'terminal_run_count':len(terminal_pins),'held_manual_run_count':len(held_pins),
                'restore_run_id':args.restore_run_id,'live_workspace':live_workspace}
        retired=[]
        for pin in [*terminal_pins,*held_pins]:
            intent=json.loads(host.read_owned_regular(state/'runs/docker-all/session-store/runs'/pin['run_id']/'run_intent.json'))
            key=intent.get('specification',{}).get('parameters',{}).get('live_workspace',{}).get('request_idempotency_key')
            if isinstance(key,str) and key: retired.append(key)
            if pin['run_id']==args.restore_run_id and key:
                record['old_request_id']=key
        source['retired_request_ids']=sorted(set(retired))
        verify_store_binding()
        required=source['state']['total_bytes']+source['user_data']['total_bytes']+512*1024**2
        if shutil.disk_usage(destination.parent).free < required:
            raise BuildControlError('Insufficient free space for the complete retained-data copy')
        source_raw=canonical(source); record['source_manifest_sha256']=digest(source_raw)
        request={'schema_version':'runtime_service_retained_snapshot_validation_request.v1',
                 'request_id':str(uuid.UUID(hex=token)),'source_manifest_sha256':digest(source_raw),
                 'retained_terminal_runs':terminal_pins,'retained_held_manual_runs':held_pins}
        request_raw=canonical(request); record['request_sha256']=digest(request_raw)
        control.prepare()
        executor_root=Path(__file__).resolve().parent.parent
        executor={'source_root':str(executor_root),
                  'commit':storage.git(executor_root,'rev-parse','HEAD'),
                  'script_sha256':{name:digest((executor_root/'scripts'/name).read_bytes()) for name in (
                    'docker_isolated_session_recovery.py','docker_isolated_snapshot_copy.py',
                    'docker_isolated_sqlite_snapshot.py','docker_isolated_sqlite_fence.py',
                    'docker_isolated_control_snapshot.py','docker_isolated_stopped_predecessor.py')}}
        operation_inputs={'source_root':str(context['selected']),'recovery_id':token,'executor':executor}
        if proof_path is not None:
            operation_inputs['stopped_predecessor_proof']={'path':proof_path,'sha256':proof_sha}
        with control.operation('isolated-session-snapshot',operation_inputs) as operation:
            destination.mkdir(mode=0o700,exist_ok=False)
            host.admit_runtime_uid(destination)
            copy_verified_tree(state/'runs',destination/'runs',source['state'])
            copy_verified_tree(user_data,destination_user,source['user_data'])
            sqlite_proof=validate_copied_workspace(destination_user)
            _admit_copy(destination/'runs'); _admit_copy(destination_user)
            # Seed only the new namespace before copying its control workspace.
            # The original native OWNER/configuration are never copied there.
            _once(raw_control,namespace+'/isolated-snapshot/source-manifest.json',source_raw)
            live_result=snapshot_control_workspace(control,token,image_id=pins['old_image_id'],
                                                  expected=live_workspace,publish=True)
            if live_result['source']!=live_workspace:
                raise BuildControlError('Original live workspace changed during copy')
            content={'state':snapshot_tree(destination/'runs'),'user_data':snapshot_tree(destination_user),
                     'live_workspace':live_workspace}
            content_raw=canonical(content)
            # Keep every source byte identical through the copy and admission
            # permission setup. The copied SQLite may have checkpointed its WAL.
            if snapshot_tree(state/'runs')!=source['state'] or snapshot_tree(user_data)!=source['user_data']:
                raise BuildControlError('Original source drifted during isolated snapshot')
            verify_store_binding()
            observe_pair()
            for path,raw in paths.items():
                if path!=previous_registry_path and _raw(raw_control,path)!=raw:
                    raise BuildControlError('Original control evidence changed')
            documents={record['source_manifest_path']:source_raw,record['request_path']:request_raw,
                       record['original_config_path']:runtime['runtime_config'],previous_registry_path:old_registry}
            for path,raw in documents.items(): _once(raw_control,path,raw)
            # Full logs and inspect remain in the control volume, not host storage.
            for service,row in pair_before.items():
                logs=docker_capture('logs','--timestamps',row['Id'],timeout=60)
                for stream,data in (('stdout',logs.stdout),('stderr',logs.stderr)):
                    _once(raw_control,root+'/containers/'+service+'-'+stream+'.log',data)
                _once(raw_control,root+'/containers/'+service+'-inspect.json',canonical(row))
            meta={'schema':'fullmag.isolated-snapshot-start.v1','allow_script_replay':False,
                  'request_sha256':digest(request_raw),'config_sha256':digest(runtime['runtime_config']),
                  'source_manifest_sha256':digest(source_raw),'copied_content_sha256':digest(content_raw),
                  'restore_run_id':args.restore_run_id}
            start_root=namespace+'/isolated-snapshot/'
            for name,raw in {'source-manifest.json':source_raw,'request.json':request_raw,
                             'original-config.json':runtime['runtime_config'],'copied-content.json':content_raw,
                             'start.json':canonical(meta)}.items():
                _once(raw_control,start_root+name,raw)
                record['control_pins'][start_root+name]=digest(raw)
            validate_snapshot_namespace_receipt(record,project=control.project,control_volume=control.volume,
                     project_id=context['identity']['project_id'],worktree_id=context['identity']['worktree_id'])
            receipt_raw=canonical(record); _once(raw_control,root+'/terminal.json',receipt_raw)
            operation['receipt'].update(state='succeeded',snapshot_receipt_path=root+'/terminal.json',
                snapshot_receipt_sha256=digest(receipt_raw),sqlite_copy=sqlite_proof,
                source_sqlite_fence=workspace_fence,live_workspace_copied=live_result['copied'],
                copied_file_owner_uid=os.getuid(),runtime_uid=65532,runtime_access='explicit-posix-acl',
                application_started=False)
        # Re-pin after releasing the old namespace operation. The registry
        # switch occurs under the same global lock, with a byte-exact CAS.
        verify_store_binding()
        observe_pair()
        workspace_fence.verify()
        registry={'schema':REGISTRY_SCHEMA,'recovery_id':token,'namespace':namespace,
                  'receipt_path':root+'/terminal.json','receipt_sha256':digest(receipt_raw),
                  'compose_project':control.project,'control_volume':control.volume,
                  'source_project_id':context['identity']['project_id'],'source_worktree_id':context['identity']['worktree_id']}
        payload={'previous_registry_sha256':digest(old_registry),'pins':{**record['control_pins'],root+'/terminal.json':digest(receipt_raw)},
                 'namespace':namespace,'recovery_id':token,'registry':registry}
        python_control=copy.copy(raw_control); python_control.image=pins['old_image_id']
        result=bounded_capture(python_control.helper_args('exec python3 -I -B -c '+shlex.quote(COMMIT)),data=canonical(payload),timeout=60)
        if result.returncode:
            raise BuildControlError('Snapshot namespace commit not confirmed; retain data and inspect: '+result.stderr.decode('utf-8','replace'))
    _remove_stopped(record)
    return {'state':'snapshot-awaiting-gated-start','namespace':namespace,'original_preserved':True,
            'destination_state_root':str(destination),'destination_user_data_root':str(destination_user)}


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo-root',type=Path,required=True);p.add_argument('--source-root',type=Path,required=True)
    p.add_argument('--operator-pins',type=Path,required=True);p.add_argument('--recovery-id',required=True)
    p.add_argument('--retained-terminal-runs',type=Path,required=True);p.add_argument('--retained-held-manual-runs',type=Path,required=True)
    p.add_argument('--restore-run-id',required=True,help='Explicit held-manual model to restore without script replay')
    p.add_argument('--successor-snapshot',action='store_true',
                   help='Copy a stopped, previously admitted snapshot into a new pinned namespace')
    p.add_argument('--stopped-predecessor-proof',help='Explicit control-relative typed stop proof for a failed successor')
    p.add_argument('--stopped-predecessor-proof-sha256',help='Exact raw SHA-256 of the typed stop proof')
    p.add_argument('--apply',action='store_true')
    args=p.parse_args(argv)
    try: print(json.dumps(recover(args),indent=2,ensure_ascii=False))
    except (OSError,ValueError,RuntimeError) as error: p.exit(2,'Isolated session recovery: '+str(error)+'\n')

if __name__=='__main__': main()
