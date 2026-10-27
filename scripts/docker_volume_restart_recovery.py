"""Stop a restarted diagnostic-only namespace with terminal, released work.

The caller then uses managed recreate-volume --fresh-state, which archives the
entire old runtime namespace. No owner, lease or drain receipt is fabricated.
"""
from __future__ import annotations
import json
import re
from pathlib import Path
from docker_build_control import BuildControl, BuildControlError, canonical, compose_capture, docker_capture, toolchain_configuration
from docker_dev_host import require_host
from docker_volume_stop_bootstrap import _read_raw, _json, _sha256, _assert_group_consumers


def require(ok, message):
    if not ok:
        raise BuildControlError(message)


def validate_terminal_evidence(catalogs, ledger):
    require(isinstance(catalogs, list) and bool(catalogs), "Recovery requires retained run catalogs")
    for catalog in catalogs:
        require(isinstance(catalog, dict) and catalog.get("schema_version") == "run_catalog.v1" and isinstance(catalog.get("tasks"), list) and bool(catalog["tasks"]), "Invalid or empty run catalog")
        require(all(isinstance(t, dict) and t.get("lifecycle") in {"succeeded", "failed", "cancelled", "interrupted"}
                    for t in catalog["tasks"]), "Recovery refuses nonterminal tasks")
    require(isinstance(ledger, dict) and isinstance(ledger.get("reservations"), list), "Missing reservation inventory")
    for reservation in ledger["reservations"]:
        require(isinstance(reservation, dict) and reservation.get("state") == "released" and
                re.fullmatch(r"[0-9a-f]{64}", str(reservation.get("release_proof_sha256", ""))),
                "Recovery refuses unreleased or unproven reservations")


def validate_failed_helper(row, name, project, image, volume):
    require(row.get("Name") == "/" + name and row.get("Image") == image,
            "Failed helper identity differs")
    state = row.get("State", {})
    require(state.get("Status") == "exited" and state.get("Running") is False
            and state.get("Pid") == 0 and state.get("ExitCode") == 1,
            "Failed helper is not confirmed exited")
    labels = row.get("Config", {}).get("Labels", {})
    require(labels.get("com.docker.compose.project") == project and
            labels.get("com.docker.compose.service") == "worker-cgroup-maintenance",
            "Failed helper belongs to another service")
    mounts = row.get("Mounts", [])
    require(len(mounts) == 2 and all(m.get("Type") == "volume" and
            m.get("Name") == volume for m in mounts) and
            {m.get("Destination") for m in mounts} == {"/control", "/fullmag-build-control"},
            "Failed helper has unexpected mounts")


PROBE = r'''import os,json,sys,hashlib,pathlib
sys.path.insert(0,'/opt/fullmag')
import runtime_service
root=pathlib.Path('/opt/fullmag/runtime-control')
proof={}
def read(p):
 raw=runtime_service._bounded_regular(p,'restart recovery evidence')
 proof[str(p)]=hashlib.sha256(raw).hexdigest()
 return json.loads(raw)
rows=[]
for p in pathlib.Path('/proc').iterdir():
 if p.name.isdigit():
  try:
   argv=(p/'cmdline').read_bytes().split(b'\0')
   ppid=int(next(x.split()[1] for x in (p/'status').read_text().splitlines() if x.startswith('PPid:')))
   rows.append(dict(pid=int(p.name),ppid=ppid,argv=argv,exe=os.readlink(p/'exe')))
  except FileNotFoundError: raise RuntimeError('process set changed')
supervisors=[r for r in rows if b'/opt/fullmag/entrypoint.py' in r['argv'] and r['ppid']==1]
apis=[r for r in rows if r['exe']=='/opt/fullmag/package/bin/fullmag-api']
if len(rows)!=4 or len(supervisors)!=1 or len(apis)!=1: raise RuntimeError('not a diagnostic-only process tree')
a=apis[0];s=supervisors[0]
if a['ppid']!=s['pid'] or {r['pid'] for r in rows}!={1,s['pid'],a['pid'],os.getpid()}: raise RuntimeError('unexpected diagnostic process ownership')
env=dict(v.split(b'=',1) for v in (pathlib.Path('/proc')/str(a['pid'])/'environ').read_bytes().split(b'\0') if b'=' in v)
fence_path=pathlib.Path(env[b'FULLMAG_API_RUNTIME_FAILURE_FENCE'].decode())
if fence_path.parent!=root/'runtime-service': raise RuntimeError('unexpected fence location')
fence=read(fence_path)
if fence.get('schema')!='fullmag.api-runtime-failure-fence.v1' or fence.get('stage')!='runtime_startup' or fence.get('reason')!='runtime configuration rotation requires an authenticated drained process receipt': raise RuntimeError('unrecognized restart failure')
owner=read(root/'runtime-services/OWNER.json');process=read(root/'runtime-service/process-tree.json')
if owner.get('schema_version')!='runtime_service_owner.v1' or owner.get('state')!='ready' or process.get('state')!='ready': raise RuntimeError('not an interrupted ready owner')
previous=process.get('service_owner',{})
for key in ('owner_token','process_start_token','pid','host','target_id','build_commit','build_snapshot','children'):
 if previous.get(key)!=owner.get(key): raise RuntimeError('prior process owner differs')
if owner['pid'] in {r['pid'] for r in rows} or any(c['pid'] in {r['pid'] for r in rows} for c in owner['children']): raise RuntimeError('prior owner PID is present')
config=read(root/'runtime-service/docker-all.json')
store=pathlib.Path(config['store_root'])
if not store.is_absolute() or store.resolve()!=store: raise RuntimeError('noncanonical store')
runs=store/'runs'; catalogs=[]
for p in sorted(runs.iterdir()):
 if not p.is_dir() or p.is_symlink(): raise RuntimeError('unexpected run directory')
 catalogs.append(read(p/'run_catalog.json'))
ledger_root=pathlib.Path(config['host_execution']['ledger_root'])
if ledger_root!=pathlib.Path('/host-ledger/ledger'): raise RuntimeError('unexpected ledger')
ledger=read(ledger_root/'HOST_RESOURCE_LEDGER.json')
print(json.dumps(dict(hashes=proof,catalogs=catalogs,ledger=ledger,api_pid=a['pid'],supervisor_pid=s['pid'])))
'''


def run(args):
    from docker_dev import _compose_identity, _select_source
    from docker_volume_stop_diagnostic import _container_snapshot, _port_matches
    from docker_volume_dev import _operator_probe_record_from_retained
    require_host()
    for value in (args.attempt, args.resume_attempt):
        require(isinstance(value,str) and re.fullmatch(r"[0-9a-f]{32}",value), "Exact attempt required")
    selected,layout=_select_source(Path(args.repo_root).resolve(strict=True),args.source_root)
    identity=_compose_identity(layout)
    configured=toolchain_configuration(selected,identity)
    control=BuildControl(identity,configured['services']['fem-gpu-toolchain']['build']['args']['FULLMAG_CUDA_BASE_IMAGE'])
    control.prepare()
    paths=[f'development/attempts/{args.attempt}/terminal.json',f'resume/attempts/{args.resume_attempt}/terminal.json',f'development/attempts/{args.attempt}/compose.json']
    def observe():
        raws=[_read_raw(control,p) for p in paths]
        parent,resume,document=[_json(raw,p) for raw,p in zip(raws,paths)]
        require(parent.get('phase')=='development' and parent.get('attempt')==args.attempt and parent.get('state')=='succeeded','Prior development is not successful')
        require(resume.get('schema')=='fullmag.docker-build-operation.v1' and resume.get('phase')=='resume' and resume.get('attempt')==args.resume_attempt and resume.get('state')=='failed-confirmed','Exact failed resume required')
        require(resume.get('inputs',{}).get('attempt')==args.attempt and resume.get('config_sha256')==args.config_sha256 and parent.get('config_sha256')==args.config_sha256,'Resume/config binding differs')
        require(all(r.get('compose_project')==control.project and r.get('control_volume')==control.volume for r in (parent,resume)),'Wrong control group')
        require('backend cgroup already contains Fullmag children; recovery required' in resume.get('error',''),'Not the retained cgroup restart failure')
        require(_sha256(canonical(document))==args.config_sha256,'Compose bytes differ')
        _port_matches(document,args.port)
        _operator_probe_record_from_retained(parent,document)
        effective=dict(parent,backend_started_at=resume['backend_started_at'])
        image,ids,actual=_container_snapshot(args,selected,identity,control,effective,document)
        result=docker_capture('exec',ids['backend'],'/usr/local/bin/python3','-B','-c',PROBE,timeout=40)
        require(result.returncode==0,'Restart preflight failed: '+result.stderr.decode('utf-8','replace')[-2000:])
        probe=json.loads(result.stdout)
        validate_terminal_evidence(probe['catalogs'],probe['ledger'])
        proof=dict(receipts=[_sha256(r) for r in raws],probe=probe,ids=ids,image=image,starts={s:actual[s]['State']['StartedAt'] for s in ids})
        return proof,document,effective
    initial,_,_=observe()
    if not args.apply:
        return dict(state='validated-preview',proof=initial)
    with control.operation('stop-bootstrap',dict(attempt=args.attempt,resume_attempt=args.resume_attempt,source_root=str(selected),config_sha256=args.config_sha256)) as operation:
        current,document,effective=observe()
        require(current==initial,'Restart evidence changed before lease')
        name = 'fullmag-cgroup-' + args.resume_attempt
        rows = json.loads(docker_capture('inspect', name).stdout)
        require(len(rows) == 1, 'Failed cgroup helper is ambiguous')
        failed = rows[0]
        validate_failed_helper(failed, name, control.project, current['image'], control.volume)
        logs = docker_capture('logs', failed['Id'])
        retained_log = (logs.stdout + logs.stderr).decode('utf-8', 'replace')
        require('backend cgroup already contains Fullmag children; recovery required' in retained_log,
                'Failed helper log differs from retained resume failure')
        control.write(operation['root'] + '/failed-cgroup-helper.json', failed)
        control.write(operation['root'] + '/failed-cgroup-helper-log.json', {'log': retained_log})
        again = json.loads(docker_capture('inspect', failed['Id']).stdout)[0]
        require(again == failed, 'Failed helper changed before removal')
        control._assert_live_operation_helper(operation)
        docker_capture('rm', failed['Id'])
        helper=_assert_group_consumers(control,operation,current['ids'])
        control.write(operation['root']+'/restarted-terminal-preflight.json',current)
        final,_,_=observe()
        require(final==initial and _assert_group_consumers(control,operation,final['ids'])==helper,'Restart evidence changed before stop')
        control._assert_live_operation_helper(operation)
        operation['daemon_pending']=True
        compose_capture(document,'stop','--timeout','60','backend',timeout=90)
        image,ids,actual=_container_snapshot(args,selected,identity,control,effective,document,allow_stopped_backend=True)
        require(not actual['backend']['State']['Running'] and actual['frontend']['State']['StartedAt']==initial['starts']['frontend'],'Pinned stop not confirmed')
        require([_sha256(_read_raw(control,p)) for p in paths]==initial['receipts'],'Original receipts changed')
        _assert_group_consumers(control,operation,ids)
        operation['daemon_pending']=False
        result=dict(state='succeeded',stop_state='stopped-confirmed',backend_container=ids['backend'],frontend_container=ids['frontend'],preserved='all runtime records, results, caches and ledger',next_action='recreate-volume --fresh-state archives old namespace')
        control.write(operation['root']+'/restarted-terminal-stop.json',result)
        operation['receipt'].update(result)
        return result
