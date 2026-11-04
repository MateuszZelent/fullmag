"""Cold quarantine of a terminal, stopped failed-bootstrap namespace.

No native ownership is recovered, drained or transferred. Old control records,
leases and user data remain untouched; a CAS selects a fresh technical namespace.
"""
from __future__ import annotations
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess

from docker_build_control import BuildControlError, bounded_capture, canonical, docker_capture
from docker_volume_offline_reconcile import (
    _control_raw, _strict_json, _relative, _inventory_store,
    _validate_group_ledger as validate_ledger, _validate_container,
    _read_only_control_args, _line,
)
from docker_control_namespace import REGISTRY_PATH, REGISTRY_SCHEMA

SCHEMA = 'fullmag.docker-failed-bootstrap-quarantine.v1'
STATE = 'failed-bootstrap-quarantined-not-drained'
OWNER = 'runtime-control/runtime-services/OWNER.json'
PROCESS = 'runtime-control/runtime-service/process-tree.json'
RUNTIME_PINS = (OWNER, PROCESS, 'runtime-control/runtime-services/LAUNCH.json',
                'runtime-control/runtime-service/docker-all.json', 'backend/runtime-provenance.json')
HEX = re.compile(r'[0-9a-f]{32}\Z')
SHA = re.compile(r'[0-9a-f]{64}\Z')


def require(value, message):
    if not value:
        raise BuildControlError('Cold namespace quarantine: ' + message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def require_plan(expected, plan):
    require(isinstance(expected, str) and SHA.fullmatch(expected)
            and expected == digest(canonical(plan)), 'reviewed plan SHA-256 differs or is absent')


def assert_no_replay(receipt, request_id):
    require(request_id not in set(receipt['retired_request_ids']) | {receipt['old_request_id']},
            'a quarantined request cannot be replayed')


def historical_owner_pins(snapshot, owner, process):
    """Optional diagnostic only; never substitutes for terminal/lock closure."""
    prefix = snapshot['previous_namespace'] + '/'
    result = {prefix + OWNER: digest(owner), prefix + PROCESS: digest(process)}
    require(all(snapshot['control_pins'].get(path) == sha for path, sha in result.items()),
            'OWNER/process bytes are not the original copied snapshot pins')
    return result


def _root(control):
    result = copy.copy(control)
    result.namespace = ''
    result.namespace_registry = None
    result.namespace_registry_sha256 = None
    return result


def _documents(control, paths):
    """One bounded shell-only batch, also usable by the ordinary constructor."""
    import base64
    paths=sorted(set(_relative(path) for path in paths))
    commands=[]
    for relative in paths:
        path=shlex.quote(control.path(relative))
        token=relative.encode().hex()
        commands.append(
            'p='+path+'; '
            'if [ ! -e "$p" ] && [ ! -L "$p" ]; then '
            "printf '"+token+"\\t-\\n'; "
            'else test ! -L "$p"; test -f "$p"; '
            'test "$(readlink -f "$p")" = "$p"; '
            'test "$(stat -c %h "$p")" = 1; '
            'test "$(stat -c %s "$p")" -le 8388608; '
            'before=$(stat -c "%d:%i:%s:%y:%z" "$p"); '
            "printf '"+token+"\\t'; base64 -w0 -- \"$p\"; printf '\\n'; "
            'test "$before" = "$(stat -c "%d:%i:%s:%y:%z" "$p")"; fi'
        )
    result=bounded_capture(_read_only_control_args(control,'\n'.join(commands)),
                           data=b'',timeout=90,maximum=32*1024*1024)
    require(result.returncode==0,'cannot read pinned control records: '+result.stderr.decode(errors='replace')[-1000:])
    records={}
    for line in result.stdout.decode('ascii').splitlines():
        token,value=line.split('\t',1)
        path=bytes.fromhex(token).decode()
        require(path not in records,'duplicate batched control record')
        records[path]=None if value=='-' else base64.b64decode(value,validate=True)
    require(set(records)==set(paths),'incomplete batched control records')
    return records


def _inventory(control, pair, state, ledger_volume, *, allowed_helpers=(), state_sources=()):
    ids = docker_capture('ps', '-aq', '--no-trunc').stdout.decode().splitlines()
    require(len(ids) <= 512 and len(set(ids)) == len(ids), 'Docker inventory exceeds bound')
    rows = json.loads(docker_capture('inspect', *ids).stdout) if ids else []
    require(len(rows) == len(ids), 'Docker inventory incomplete')
    allowed = {p['Id'] for p in pair.values()}
    protected = {control.volume, ledger_volume}
    # source-git is an explicitly shared readonly metadata bind. Recovery
    # does not mutate Git, so it is inventoried without claiming exclusivity.
    protected_targets={'/state','/user-data','/opt/fullmag/source','/opt/fullmag/script-output'}
    sources = {str(state),*state_sources} | {m['Source'] for row in pair.values()
        for m in [*row.get('Mounts',[]),*row.get('HostConfig',{}).get('Mounts',[])]
        if m.get('Type')=='bind' and m.get('Source')
        and m.get('Destination',m.get('Target')) in protected_targets}
    def overlap(a,b):
        a,b=a.rstrip('/'),b.rstrip('/')
        return a==b or a.startswith(b+'/') or b.startswith(a+'/')
    for row in rows:
        if row['Id'] in allowed or row['Id'] in allowed_helpers:
            continue
        labels = row.get('Config',{}).get('Labels') or {}
        require(labels.get('com.docker.compose.project') != control.project
                and labels.get('org.fullmag.compose.project') != control.project,
                'another project container/helper exists: '+row['Id'])
        for mount in [*row.get('Mounts',[]),*row.get('HostConfig',{}).get('Mounts',[])]:
            require(mount.get('Name') not in protected
                    and not (mount.get('Source') and any(overlap(mount['Source'],source) for source in sources)),
                    'foreign state/control/ledger consumer: '+row['Id'])
    return sorted(allowed)


def _ledger_binding(compose, control):
    backend=compose['services']['backend']
    mounts=[m for m in backend['volumes'] if m.get('target')=='/host-ledger']
    require(len(mounts)==1 and mounts[0].get('type')=='volume', 'missing exact ledger mount')
    m=mounts[0]; volume=compose['volumes'][m['source']]['name']
    subpath=(m.get('volume') or {}).get('subpath','')
    require(isinstance(volume,str) and volume.startswith('fullmag-'), 'foreign ledger volume')
    require(not subpath or subpath==control.namespace+'/private/ledger', 'foreign private ledger subpath')
    mount='type=volume,src='+volume+',dst=/ledger,readonly,volume-nocopy'
    if subpath: mount+=',volume-subpath='+subpath
    return volume, mount


def _ledger(control, mount):
    command=_read_only_control_args(control,'cat /ledger/ledger/HOST_RESOURCE_LEDGER.json')
    index=command.index('--entrypoint'); command[index:index]=['--mount',mount]
    result=bounded_capture(command,data=b'',timeout=60)
    require(result.returncode==0,'cannot read retained ledger')
    validate_ledger(_strict_json(result.stdout,'ledger'))
    return digest(result.stdout)


def _pending_store(root):
    """This bounded recovery supports empty command/recovery journals only.

    Real CURRENT/generation journals need their own outcome-aware native
    parser. A terminal catalog alone never resolves a command journal.
    """
    for directory in ('live_command_journals','recovery'):
        base=root/directory
        if not base.exists(): continue
        require(not base.is_symlink() and base.is_dir(),'linked journal root')
        for parent, dirs, files in os.walk(base,followlinks=False):
            require(all(not (Path(parent)/d).is_symlink() for d in dirs),'linked journal directory')
            require(not files,'cold recovery supports only empty command/recovery journals: '+directory)
    return {}


def _context(args):
    # Recovery inspection must not call _select_source/_selected_context:
    # those initialize host storage even when no build is requested.
    import fullmag_storage as storage
    from docker_development_inputs import select_checkout
    from docker_dev import _compose_identity
    from docker_build_control import BuildControl, toolchain_configuration
    selected=select_checkout(Path(args.repo_root),args.source_root).resolve(strict=True)
    layout=storage.resolve_layout(selected,'docker-all-gpu')
    identity=_compose_identity(layout)
    configured=toolchain_configuration(selected,identity)
    helper=configured['services']['fem-gpu-toolchain']['build']['args']['FULLMAG_CUDA_BASE_IMAGE']
    control=BuildControl(identity,helper)
    retirement=(control.namespace_registry or {}).get('retirement',{})
    if retirement.get('schema')==SCHEMA:
        control.image=retirement['helper_image_id']
        return selected,layout,identity,control
    toolchain=control.read('toolchain/verified.json')
    require(toolchain.get('schema')=='fullmag.docker-build-operation.v1'
            and toolchain.get('state')=='succeeded' and toolchain.get('phase')=='toolchain'
            and re.fullmatch(r'sha256:[0-9a-f]{64}',toolchain.get('image_id','')),
            'no pinned existing Python-capable toolchain image')
    control.image=toolchain['image_id']
    return selected,layout,identity,control


def collect(args):
    from docker_compose_identity import validate_source_labels
    selected, layout, identity, control = _context(args)
    image_rows=json.loads(docker_capture('image','inspect',control.image).stdout)
    require(len(image_rows)==1 and re.fullmatch(r'sha256:[0-9a-f]{64}',image_rows[0].get('Id','')),'helper image is not locally immutable')
    control.image=image_rows[0]['Id']
    require(control.project=='fullmag-master','initial cold recovery is qualified only for master')
    require(HEX.fullmatch(args.recovery_id or '') and HEX.fullmatch(args.operation_attempt or ''), 'invalid recovery/operation token')
    old=control.namespace
    require(isinstance(control.namespace_registry,dict),'no selected snapshot namespace')
    snapshot=control.namespace_registry['retirement']
    if snapshot.get('schema')==SCHEMA:
        return _resume_collect(args,control)
    require(snapshot.get('schema')=='fullmag.docker-isolated-session-snapshot.v1','selected predecessor is not an isolated snapshot')
    require(old and old!='namespaces/'+args.recovery_id,'expected distinct selected snapshot namespace')
    prefix=old+'/'
    op='recreate-services/attempts/'+args.operation_attempt
    initial=_documents(control,[op+'/receipt.json','active'])
    unknown=_strict_json(initial[op+'/receipt.json'],'unknown recreation')
    attempt=unknown.get('inputs',{}).get('attempt')
    require(HEX.fullmatch(attempt or ''),'invalid previous development token')
    dev='development/attempts/'+attempt
    paths=[op+'/receipt.json',op+'/terminal.json',op+'/retained-containers.json','active',
           dev+'/terminal.json',dev+'/compose.json','development/current.json','development/verified.json',
           'isolated-snapshot/source-manifest.json','isolated-snapshot/request.json',
           'isolated-snapshot/start.json','isolated-snapshot/native-validation.json',
           'activation/unresolved.json','toolchain/verified.json',*RUNTIME_PINS]
    documents=_documents(control,paths)
    require(documents[op+'/receipt.json']==initial[op+'/receipt.json'],'operation changed while observing')
    require(documents['active'].decode().strip()==args.operation_attempt,'active marker differs')
    require(documents['activation/unresolved.json'] is None,'pending activation mutation remains')
    require(unknown.get('phase')=='recreate-services' and unknown.get('state')=='outcome-unknown-resources-retained'
            and unknown.get('fresh_state') is True and unknown.get('attempt')==args.operation_attempt
            and unknown.get('compose_project')==control.project and unknown.get('control_volume')==control.volume
            and unknown.get('control_namespace')==old
            and unknown.get('namespace_registry_sha256')==control.namespace_registry_sha256
            and documents[op+'/terminal.json'] is None
            and 'runtime configuration rotation requires an authenticated drained process receipt' in unknown.get('error',''),
            'not the exact retained failed snapshot recreation')
    terminal=_strict_json(documents[dev+'/terminal.json'],'failed development')
    require(terminal.get('state')=='failed-confirmed' and terminal.get('phase')=='development'
            and terminal.get('attempt')==attempt and terminal.get('control_namespace')==old
            and terminal.get('namespace_registry_sha256')==control.namespace_registry_sha256
            and terminal.get('compose_project')==control.project and terminal.get('control_volume')==control.volume
            and terminal.get('inputs',{}).get('source_root')==str(selected)
            and 'foreign-host writer record requires controlled recovery' in terminal.get('error',''),
            'not the retained foreign-host bootstrap failure')
    compose=_strict_json(documents[dev+'/compose.json'],'Compose')
    require(compose.get('name')==control.project and set(compose.get('services',{}))=={'backend','frontend'},'Compose project/services differ')
    config_sha=unknown['inputs']['config_sha256']
    require(digest(canonical(compose))==config_sha==terminal.get('config_sha256'),'Compose digest differs')
    require(documents['development/current.json']==documents[dev+'/terminal.json'],'failed development is not current')
    retained=_strict_json(documents[op+'/retained-containers.json'],'retained pair')
    require(retained.get('backend',{}).get('State',{}).get('Running') is False
            and retained['backend']['State'].get('Pid')==0,
            'original failed recreation did not pin a stopped backend for resumable SQLite fencing')
    ids={s:retained[s]['Id'] for s in ('backend','frontend')}
    rows=json.loads(docker_capture('inspect',*ids.values()).stdout)
    byid={r['Id']:r for r in rows}; require(set(byid)==set(ids.values()),'incomplete exact pair')
    pair={s:byid[i] for s,i in ids.items()}
    for service,row in pair.items():
        require(row['Image']==retained[service]['Image'] and row['State']['StartedAt']==retained[service]['State']['StartedAt'],
                'retained container incarnation drift')
        _validate_container(row,container_id=ids[service],service=service,project=control.project,image_id=row['Image'])
        validate_source_labels(row,identity)
        image_rows=json.loads(docker_capture('image','inspect',row['Image']).stdout)
        require(len(image_rows)==1 and image_rows[0].get('Id')==row['Image'],'immutable image inspection differs')
        from docker_volume_dev import _validate_retained_service
        _validate_retained_service(compose,row,service,image_rows[0]['Config'],allow_legacy_frontend=True)
        require(row['State']['ExitCode']==0,'only cleanly stopped pair is eligible')
    require(pair['backend']['State']['StartedAt']==terminal.get('backend_started_at')
            and pair['backend']['Image']==terminal['inputs']['image_id'],'backend incarnation differs from failed bootstrap')
    state=Path(terminal['state_root']); require(str(state)==unknown.get('previous_state_root'),'state root differs')
    import fullmag_storage as storage
    resolved=storage.resolve_layout(selected,'docker-all-gpu')
    require(state.resolve(strict=True)==state and state.parent==Path(resolved['runtime_root'])/'docker-volume-dev','state root is outside managed runtime')
    store=state/'runs/docker-all/session-store'
    store_proof=_inventory_store(store); require(store_proof['runs'],'terminal snapshot store is empty')
    pending=_pending_store(store)
    ledger_volume,ledger_mount=_ledger_binding(compose,control)
    inventory=_inventory(control,pair,state,ledger_volume,allowed_helpers=getattr(args,'_allowed_helpers',()))
    ledger_sha=_ledger(control,ledger_mount)
    raw=_root(control)
    rootdocs=_documents(raw,[REGISTRY_PATH,control.namespace_registry['receipt_path'],*snapshot['control_pins'],snapshot['source_manifest_path'],snapshot['request_path']])
    registry=rootdocs[REGISTRY_PATH]
    require(digest(registry)==control.namespace_registry_sha256,'selected registry changed')
    for path,sha in snapshot['control_pins'].items():
        require(rootdocs[path] is not None and digest(rootdocs[path])==sha,'snapshot source pin changed: '+path)
    manifest=_strict_json(documents['isolated-snapshot/source-manifest.json'],'source manifest')
    require(digest(documents['isolated-snapshot/source-manifest.json'])==snapshot['source_manifest_sha256'],'source manifest differs')
    owner=_strict_json(documents[OWNER],'preserved OWNER')
    process=_strict_json(documents[PROCESS],'preserved process receipt')
    require(owner.get('schema_version')=='runtime_service_owner.v1' and process.get('schema')=='fullmag.docker-process-tree.v1', 'unknown preserved native records')
    history=False
    try: historical_owner_pins(snapshot,documents[OWNER],documents[PROCESS]); history=True
    except BuildControlError: pass
    pins={prefix+p: None if value is None else digest(value) for p,value in documents.items()}
    pins.update({p:None if value is None else digest(value) for p,value in rootdocs.items()})
    retired=set(manifest.get('retired_request_ids',[]))|{snapshot['old_request_id']}
    for run in store_proof['runs']:
        intent=_strict_json((store/'runs'/run['run_id']/'run_intent.json').read_bytes(),'retained RunIntent')
        key=intent.get('idempotency_key')
        require(intent.get('run_id')==run['run_id'] and isinstance(key,str) and key,'retained RunIntent has no request identity')
        retired.add(key)
    retired=sorted(retired)
    engine=docker_capture('info','--format','{{.ID}}').stdout.decode().strip()
    require(bool(engine),'Docker engine identity absent')
    import linux_native_host as host
    certificate_raw=host.read_owned_regular(state/host.CERTIFICATE_NAME)
    host_owner_raw=host.read_owned_regular(state/host.OWNER_NAME)
    certificate=_strict_json(certificate_raw,'state admission certificate')
    require(certificate.get('engine_id')==engine,'state admission belongs to another Docker engine')
    from docker_isolated_session_recovery import _data_root
    plan={'controller_sha256':digest(Path(__file__).read_bytes()),
          'helper_image_id':control.image,'transaction_sha256':digest(TRANSACTION.encode()),
          'schema':SCHEMA,'state':STATE,'recovery_id':args.recovery_id,'namespace':'namespaces/'+args.recovery_id,
          'previous_namespace':old,'compose_project':control.project,'control_volume':control.volume,
          'source_project_id':identity['project_id'],'source_worktree_id':identity['worktree_id'],
          'source_root':str(selected),
          'user_data_root':str(_data_root(compose,layout)),
          'protected_bind_sources':sorted({m['Source'] for row in pair.values()
             for m in [*row.get('Mounts',[]),*row.get('HostConfig',{}).get('Mounts',[])]
             if m.get('Type')=='bind' and m.get('Source') and m.get('Destination',m.get('Target'))
             in {'/state','/user-data','/opt/fullmag/source','/opt/fullmag/script-output'}}),
          'previous_state_root':str(state),'store':store_proof,'pending':pending,
          'operation_attempt':args.operation_attempt,'development_attempt':attempt,'config_sha256':config_sha,
          'containers':{service:{'id':row['Id'],'image_id':row['Image'],'started_at':row['State']['StartedAt'],
                         'inspect_sha256':digest(canonical(row))} for service,row in pair.items()},
          'host_certificate_sha256':digest(certificate_raw),'host_owner_sha256':digest(host_owner_raw),'engine_id':engine,'ledger_volume':ledger_volume,'ledger_mount':ledger_mount,
          'ledger_sha256':ledger_sha,
          'ledger_subpath':ledger_mount.split(',volume-subpath=',1)[1] if ',volume-subpath=' in ledger_mount else '',
          'control_pins':pins,'previous_registry_sha256':digest(registry),
          'native_owner_drained':False,'owner_history_verified':history,'allow_old_request_replay':False,
          'allow_new_requests':True,'old_request_id':snapshot['old_request_id'],'retired_request_ids':retired,
          'data_preserved':True}
    return {'plan':plan,'plan_sha256':digest(canonical(plan)), 'control':control,'compose':compose,
            'pair':pair,'store_root':store,'state_root':state,'inventory':inventory}


def _observe_survivors(plan, *, allow_absent):
    survivors={}
    for service,pin in plan['containers'].items():
        identifier=pin['id']
        result=docker_capture('inspect',identifier,allow_failure=True)
        if result.returncode:
            text=result.stderr.decode(errors='replace')
            require(allow_absent and result.returncode==1
                    and re.search(r'(?:No such object|No such container):\s*'+re.escape(identifier)+r'(?:\s|$)',text),
                    'container absence is not authenticated: '+identifier)
            continue
        rows=json.loads(result.stdout)
        require(len(rows)==1 and rows[0].get('Id')==identifier,'ambiguous survivor identity')
        row=rows[0]
        require(digest(canonical(row))==pin['inspect_sha256'],'survivor incarnation/inspection drift')
        _validate_container(row,container_id=identifier,service=service,
                            project=plan['compose_project'],image_id=pin['image_id'])
        require(row['State']['ExitCode']==0,'survivor no longer cleanly stopped')
        survivors[service]=row
    return survivors


def _resume_collect(args, control):
    plan=control.namespace_registry['retirement']
    require(plan['recovery_id']==args.recovery_id and plan['operation_attempt']==args.operation_attempt,
            'published recovery differs; no new quarantine is admitted')
    require(plan['controller_sha256']==digest(Path(__file__).read_bytes())
            and plan['transaction_sha256']==digest(TRANSACTION.encode()),'published recovery controller code differs')
    require(docker_capture('info','--format','{{.ID}}').stdout.decode().strip()==plan['engine_id'],
            'published recovery Docker engine differs')
    import linux_native_host as host
    state=Path(plan['previous_state_root']);store=state/'runs/docker-all/session-store'
    require(digest(host.read_owned_regular(state/host.CERTIFICATE_NAME))==plan['host_certificate_sha256']
            and digest(host.read_owned_regular(state/host.OWNER_NAME))==plan['host_owner_sha256'],
            'published recovery state admission drift')
    require(_inventory_store(store)==plan['store'] and _pending_store(store)==plan['pending'],
            'published recovery store drift')
    oldcontrol=copy.copy(control);oldcontrol.namespace=plan['previous_namespace']
    pair=_observe_survivors(plan,allow_absent=True)
    inventory=_inventory(control,pair,state,plan['ledger_volume'],
                         allowed_helpers=getattr(args,'_allowed_helpers',()),state_sources=plan['protected_bind_sources'])
    require(_ledger(control,plan['ledger_mount'])==plan['ledger_sha256'],'published recovery ledger drift')
    op='recreate-services/attempts/'+plan['operation_attempt']
    retained=oldcontrol.read(op+'/retained-containers.json')
    compose=oldcontrol.read('development/attempts/'+plan['development_attempt']+'/compose.json')
    return {'plan':plan,'plan_sha256':digest(canonical(plan)),'control':oldcontrol,
            'compose':compose,'pair':pair,'store_root':store,'state_root':state,
            'inventory':inventory,'resume':True,'fence_backend':retained['backend']}

# The helper owns the existing global and native flock inodes throughout the
# second host observation and registry CAS. All retained mounts are read-only.
TRANSACTION = r'''
import fcntl,hashlib,json,os,pathlib,stat,sys
P=pathlib.Path
root=P('/control')
request=json.loads(sys.stdin.buffer.readline(8*1024*1024+1))
p=request.get('plan',request)
resume=request.get('resume',False)
old=root/p['previous_namespace']
fds=[]
def read(path):
 if path.resolve()!=path: raise RuntimeError('noncanonical record')
 s=path.lstat()
 if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size>8388608: raise RuntimeError('unsafe record')
 return path.read_bytes()
def sha(path): return hashlib.sha256(read(path)).hexdigest()
def lock(path):
 if path.resolve()!=path or not stat.S_ISREG(path.lstat().st_mode): raise RuntimeError('unsafe existing lock')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 if (os.fstat(fd).st_dev,os.fstat(fd).st_ino)!=(path.stat().st_dev,path.stat().st_ino): raise RuntimeError('lock inode changed')
 fds.append((fd,path))
for path in [root/'operation.lock',old/'runtime-control/runtime-services/OWNER.lock',
 old/'runtime-control/runtime-services/LAUNCH.lock',old/'runtime-control/runtime-services/STARTUP-GATE.lock',
 P('/store/WRITER.lock'),P('/ledger/ledger/WRITER.lock'),P('/ledger/ledger/HOST_INVENTORY_OWNER.lock')]: lock(path)
if not os.path.samefile(root/'operation.lock',old/'operation.lock'): raise RuntimeError('old namespace uses another global lock')
def verify():
 for relative,expected in p['control_pins'].items():
  path=root/relative
  if resume and relative=='namespaces/current.json':
   if sha(path)!=request['registry_sha256']: raise RuntimeError('published registry CAS drift')
   continue
  if expected is None:
   if os.path.lexists(path): raise RuntimeError('absent control pin appeared')
  elif sha(path)!=expected: raise RuntimeError('control pin drift: '+relative)
 for fd,path in fds:
  if (os.fstat(fd).st_dev,os.fstat(fd).st_ino)!=(path.stat().st_dev,path.stat().st_ino): raise RuntimeError('lock inode drift')
 if sha(P('/ledger/ledger/HOST_RESOURCE_LEDGER.json'))!=p['ledger_sha256']: raise RuntimeError('ledger drift')
 rows=json.loads(read(P('/ledger/ledger/HOST_RESOURCE_LEDGER.json')))['reservations']
 if not isinstance(rows,list) or any(r.get('state')!='released' for r in rows): raise RuntimeError('live reservation')
 if json.loads(read(P('/store/WRITER.owner.json'))).get('released') is not True: raise RuntimeError('live store writer')
verify()
if resume:
 archive=root/'namespace-recovery'/p['recovery_id']
 receipt=(json.dumps(p,sort_keys=True,separators=(',',':'),ensure_ascii=False)+'\n').encode()
 if read(archive/'terminal.json')!=receipt: raise RuntimeError('published immutable receipt drift')
 if sha(archive/'previous-registry.json')!=p['previous_registry_sha256']: raise RuntimeError('published predecessor archive drift')
 registry=json.loads(read(root/'namespaces/current.json'))
 if registry.get('namespace')!=p['namespace'] or registry.get('receipt_sha256')!=hashlib.sha256(receipt).hexdigest(): raise RuntimeError('not the exact published recovery')
 if not os.path.samefile(root/'operation.lock',root/p['namespace']/'operation.lock'): raise RuntimeError('published namespace lock differs')
print('LOCKED',flush=True)
command=sys.stdin.buffer.readline(32)
if command==b'ABORT\n': sys.exit(0)
if command!=b'PUBLISH\n': raise RuntimeError('missing explicit publish')
verify()
def directory(path):
 if os.path.lexists(path):
  if path.is_symlink() or not path.is_dir() or path.resolve()!=path: raise RuntimeError('unsafe destination directory')
 else: path.mkdir(mode=0o750)
def immutable(path,data):
 if os.path.lexists(path):
  if read(path)!=data: raise RuntimeError('immutable destination differs')
  return
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o640)
 with os.fdopen(fd,'wb') as out: out.write(data);out.flush();os.fsync(out.fileno())
 fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
if not resume:
 namespace=root/p['namespace']
 if os.path.lexists(namespace): raise RuntimeError('destination namespace already exists')
 directory(root/'namespace-recovery'); archive=root/'namespace-recovery'/p['recovery_id'];directory(archive)
 directory(namespace)
 os.link(root/'operation.lock',namespace/'operation.lock')
 receipt=(json.dumps(p,sort_keys=True,separators=(',',':'),ensure_ascii=False)+'\n').encode()
 immutable(archive/'terminal.json',receipt);immutable(namespace/'namespace.json',receipt)
 # No mutable development/runtime/cache pointers are imported. Normal DEV
 # image/toolchain validation runs before use in the fresh namespace.
 registry={'schema':'fullmag.docker-control-namespace-registry.v1','recovery_id':p['recovery_id'],
  'namespace':p['namespace'],'receipt_path':'namespace-recovery/'+p['recovery_id']+'/terminal.json',
  'receipt_sha256':hashlib.sha256(receipt).hexdigest(),'compose_project':p['compose_project'],
  'control_volume':p['control_volume'],'source_project_id':p['source_project_id'],
  'source_worktree_id':p['source_worktree_id']}
 immutable(archive/'previous-registry.json',read(root/'namespaces/current.json'))
 verify()
 tmp=root/'namespaces'/('.cold-'+p['recovery_id'])
 immutable(tmp,json.dumps(registry,sort_keys=True,separators=(',',':')).encode())
 if sha(root/'namespaces/current.json')!=p['previous_registry_sha256']: raise RuntimeError('registry CAS drift')
 os.replace(tmp,root/'namespaces/current.json')
 fd=os.open(root/'namespaces',os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
print('PUBLISHED',flush=True)
# Wait for exact stopped-pair retirement while the global lock remains held.
if sys.stdin.buffer.readline(32)!=b'RELEASE\n': raise RuntimeError('publication retained; removal outcome unknown')
removed={'schema':'fullmag.cold-quarantine-container-retirement.v1','state':'removed-confirmed',
 'container_ids':{k:v['id'] for k,v in p['containers'].items()},'native_owner_drained':False,'data_preserved':True}
immutable(archive/'removed-containers.json',(json.dumps(removed,sort_keys=True,separators=(',',':'))+'\n').encode())
print('RELEASED',flush=True)
'''


def _authenticate_helper(control, name, script, store, ledger_mount):
    rows=json.loads(docker_capture('inspect',name).stdout)
    require(len(rows)==1,'ambiguous transaction helper')
    row=rows[0]; config=row['Config']; host=row['HostConfig']
    require(row['Name']=='/'+name and row['Image']==control.image
            and config.get('User')=='65532:65532'
            and config.get('Entrypoint')==['/bin/bash']
            and config.get('Cmd')==['-euo','pipefail','-c',script]
            and row['State']['Running'] is True and host.get('NetworkMode')=='none'
            and host.get('ReadonlyRootfs') is True and host.get('Privileged') is False
            and 'ALL' in host.get('CapDrop',[]) and not host.get('CapAdd'), 'helper identity/isolation differs')
    mounts=host.get('Mounts',[])
    expected={'/control':('volume',control.volume,False),'/store':('bind',str(store),True),
              '/ledger':('volume',ledger_mount.split('src=',1)[1].split(',',1)[0],True)}
    require(len(mounts)==3,'helper mount set differs')
    for target,(kind,source,readonly) in expected.items():
        found=[m for m in mounts if m.get('Target')==target]
        require(len(found)==1 and found[0].get('Type')==kind and found[0].get('Source')==source
                and bool(found[0].get('ReadOnly',False))==readonly,'helper mount identity differs')
    ledger=[m for m in mounts if m.get('Target')=='/ledger'][0]
    expected_subpath=ledger_mount.split(',volume-subpath=',1)[1] if ',volume-subpath=' in ledger_mount else ''
    require((ledger.get('VolumeOptions') or {}).get('Subpath','')==expected_subpath,'helper ledger subpath differs')
    return row['Id']


def _sqlite_helpers(control, before):
    """Identify only the fence that the existing managed OFD API authenticates."""
    ids=set(docker_capture('ps','-aq','--no-trunc').stdout.decode().splitlines())-set(before)
    require(len(ids)<=1,'unexpected container appeared during SQLite fencing')
    if not ids:return []
    rows=json.loads(docker_capture('inspect',*ids).stdout)
    from docker_isolated_sqlite_fence import _owner_script
    expected=control._namespace_guard(_owner_script())
    for row in rows:
        require(re.fullmatch(r'/fullmag-sqlite-fence-[0-9a-f]{32}',row['Name'])
                and row['Config'].get('Cmd')==['-euo','pipefail','-c',expected], 'foreign helper appeared during SQLite fencing')
    return list(ids)


def run(args):
    from docker_isolated_sqlite_fence import hold_managed_workspace_database
    context=collect(args); plan=context['plan']; control=context['control']
    if args.apply: require_plan(args.expected_plan_sha256,plan)
    else: require(args.expected_plan_sha256 is None,'plan confirmation requires apply')
    raw=_root(control)
    name='fullmag-cold-quarantine-'+args.recovery_id
    script='python3 -u -c '+shlex.quote(TRANSACTION)
    command=raw.helper_args(script,name=name)
    index=command.index('--entrypoint')
    command[index:index]=['--mount','type=bind,src='+str(context['store_root'])+',dst=/store,readonly',
                          '--mount',plan['ledger_mount']]
    process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        process.stdin.write(canonical({'plan':plan,'resume':context.get('resume',False),
                                              'registry_sha256':control.namespace_registry_sha256})+b'\n');process.stdin.flush()
        require(_line(process,timeout=60)=='LOCKED','existing lock acquisition refused')
        helper_id=_authenticate_helper(raw,name,script,context['store_root'],plan['ledger_mount'])
        before=docker_capture('ps','-aq','--no-trunc').stdout.decode().splitlines()
        with hold_managed_workspace_database(control,context['fence_backend'] if context.get('resume') else context['pair']['backend'],Path(plan['user_data_root'])) as fence:
            sqlite_ids=_sqlite_helpers(control,before)
            fence.verify()
            args._allowed_helpers=[helper_id,*sqlite_ids]
            again=collect(args)
            require(again['plan']==plan,'namespace/store/container/engine drift under locks')
            fence.verify()
            if not args.apply:
                process.stdin.write(b'ABORT\n');process.stdin.flush()
                require(process.wait(timeout=30)==0,'preview lock release failed')
                return {'state':'preview-no-mutation','plan':plan,'plan_sha256':context['plan_sha256']}
            process.stdin.write(b'PUBLISH\n');process.stdin.flush()
            require(_line(process,timeout=60)=='PUBLISHED','registry publication outcome unknown; retain resources')
            # Publication fences old clients. Containers are removed only while
            # the same global lock and SQLite/store/native locks remain held.
            survivors=_observe_survivors(plan,allow_absent=True)
            _inventory(control,survivors,context['state_root'],plan['ledger_volume'],
                       allowed_helpers=[helper_id,*sqlite_ids],state_sources=plan['protected_bind_sources'])
            fence.verify()
            surviving_ids=[r['Id'] for r in survivors.values()]
            if surviving_ids:
                docker_capture('rm',*surviving_ids)
            require(not _observe_survivors(plan,allow_absent=True),'exact container removal not confirmed')
            ids=[row['id'] for row in plan['containers'].values()]
            process.stdin.write(b'RELEASE\n');process.stdin.flush()
            require(_line(process,timeout=30)=='RELEASED' and process.wait(timeout=30)==0,'transaction release outcome unknown')
        return {'state':STATE,'namespace':plan['namespace'],'native_owner_drained':False,
                'data_preserved':True,'removed_container_ids':ids,'plan_sha256':context['plan_sha256']}
    finally:
        if process.poll() is None:
            # EOF never authorizes publication; after publication EOF retains
            # the registry and all historical records for explicit inspection.
            process.stdin.close()
            try: process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                raise BuildControlError('Cold quarantine helper is still active; retain resources and inspect '+name)


def resolve_cold_namespace(control,registry,registry_raw,receipt):
    """Authenticate immutable old evidence before authorizing fresh requests."""
    require(receipt.get('schema')==SCHEMA and receipt.get('state')==STATE
            and receipt.get('namespace')==registry['namespace']
            and receipt.get('compose_project')==control.project and receipt.get('control_volume')==control.volume
            and receipt.get('source_project_id')==control.identity['project_id']
            and receipt.get('source_worktree_id')==control.identity['worktree_id']
            and receipt.get('native_owner_drained') is False and receipt.get('data_preserved') is True
            and receipt.get('allow_old_request_replay') is False and receipt.get('allow_new_requests') is True,
            'invalid cold quarantine authorization')
    require(receipt.get('previous_namespace')!=registry['namespace']
            and re.fullmatch(r'namespaces/[0-9a-f]{32}',receipt.get('previous_namespace','')),
            'invalid cold predecessor namespace')
    require(HEX.fullmatch(registry.get('recovery_id',''))
            and registry['namespace']=='namespaces/'+registry['recovery_id']
            and receipt.get('recovery_id')==registry['recovery_id']
            and isinstance(receipt.get('old_request_id'),str) and receipt['old_request_id']
            and isinstance(receipt.get('retired_request_ids'),list)
            and len(receipt['retired_request_ids'])<=512
            and all(isinstance(value,str) and value for value in receipt['retired_request_ids']),
            'invalid cold request/token closure')
    pins=receipt.get('control_pins')
    require(isinstance(pins,dict) and 1<=len(pins)<=128,'unbounded cold evidence')
    require(all(_relative(path)==path and (sha is None or isinstance(sha,str) and SHA.fullmatch(sha)) for path,sha in pins.items()),'malformed cold pins')
    required={receipt['previous_namespace']+'/'+OWNER,receipt['previous_namespace']+'/'+PROCESS,
              receipt['previous_namespace']+'/active',REGISTRY_PATH}
    require(required<=set(pins),'incomplete preserved owner/operation closure')
    # current.json intentionally changed at publication; its former bytes are
    # archived immutably and all other predecessor pins remain authoritative.
    archived='namespace-recovery/'+registry['recovery_id']+'/previous-registry.json'
    expected=dict(pins);expected.pop(REGISTRY_PATH,None)
    expected[archived]=receipt['previous_registry_sha256']
    require(re.fullmatch(r'sha256:[0-9a-f]{64}',receipt.get('helper_image_id','')),'invalid pinned cold evidence image')
    observed=_documents(control,expected)
    require(all((observed[p] is None if sha is None else observed[p] is not None and digest(observed[p])==sha)
                for p,sha in expected.items()),'preserved cold predecessor evidence changed')
    require(_control_raw(control,REGISTRY_PATH)==registry_raw,'registry changed during cold resolution')
    control.namespace=registry['namespace']
    control.namespace_registry={**registry,'retirement':receipt}
    control.namespace_registry_sha256=digest(registry_raw)
