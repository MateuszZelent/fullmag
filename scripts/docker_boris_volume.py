"""Optional pinned BORIS producer in the already admitted volume DEV backend."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

from docker_build_control import (BuildControl,BuildControlError,ControlOutcomeUnknown,
    canonical,docker_capture,bounded_capture,toolchain_configuration)

LOADED_CONTROLLER_SHA256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
ASSET="sha256:545279e00703d60dcaf33d455461ba90e0dea7ec5647e96392bbc9246c21b6a6"
MODULES={"supplier":"scripts/docker_boris_prefix.py","producer":"scripts/docker_boris_reference.py",
    "boris":"scripts/local_runner/boris_cpu.py","verify_boris_nf_interface":"scripts/verify_boris_nf_interface.py",
    "boris_nf_common_case_v3":"scripts/boris_nf_common_case_v3.py"}
# Fixed trusted controller wrapper executes exactly the hash-bound admitted bytes.
WRAPPER=r"""import hashlib,json,os,stat,sys,types
from pathlib import Path
def require(ok,message):
 if not ok:raise RuntimeError(message)
raw=sys.stdin.buffer.read(4*1024*1024+1);require(len(raw)<=4*1024*1024,'bounded admission exceeded')
doc=json.loads(raw);loaded={}
for name in doc['order']:
 item=doc['modules'][name];code=item['source'].encode();require(hashlib.sha256(code).hexdigest()==item['sha256'],'module bytes differ')
 if doc['mode']=='produce':
  path=Path('/opt/fullmag/source')/item['path']
  require(not path.is_symlink() and path.is_file() and path.read_bytes()==code,'mounted module differs')
 else:path=Path('/__pinned_supplier__')
 module=types.ModuleType(name);module.__file__=str(path);sys.modules[name]=module
 exec(compile(code,str(path),'exec'),module.__dict__);loaded[name]=module
if doc['mode']=='copy':
 target=Path(doc['target']);require(target.parent.parent==Path('/build/external-reference-boris'),'copy target escapes build volume')
 require(len(target.parent.name)==32 and all(c in '0123456789abcdef' for c in target.parent.name),'copy attempt differs')
 require(not target.parent.parent.is_symlink(),'copy root link')
 target.parent.parent.mkdir(exist_ok=True);target.parent.mkdir(exist_ok=False)
 result=loaded['supplier'].copy_payload(target)
 print(json.dumps({'state':'copied','payload_receipt_sha256':hashlib.sha256((target/'payload-receipt.json').read_bytes()).hexdigest()}))
else:
 sys.path.insert(0,'/opt/fullmag');import backend_dev
 admission=doc['admission'];require(os.uname().nodename==admission['container_hostname'],'backend hostname differs')
 result=loaded['producer'].produce(admission,(json.dumps(admission,sort_keys=True,separators=(',',':'),ensure_ascii=False)+'\n').encode(),backend_dev,loaded['boris'],loaded['boris_nf_common_case_v3'],loaded['supplier'])
 print(json.dumps({'state':'completed','receipt_path':str(result)}))
"""
HEALTH=r"""import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:8081/v2/platform/health',timeout=5) as response:
 value=json.load(response)
 if response.status!=200 or value.get('status')!='ok' or value.get('active_session') is not False:raise RuntimeError('BORIS producer requires an empty idle API')
 print(json.dumps(value))
"""
READ_RECEIPT=r"""import json,os,stat,sys
from pathlib import Path
root=Path('/build/external-reference-boris')/sys.argv[1]
path=root/'build-receipt.json'
fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
try:
 st=os.fstat(fd)
 if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or not 0<st.st_size<=8*1024*1024:raise RuntimeError('invalid retained producer receipt')
 data=os.read(fd,8*1024*1024+1)
 if len(data)>8*1024*1024:raise RuntimeError('producer receipt overflow')
 print(data.decode())
finally:os.close(fd)
"""

def require(ok,message):
    if not ok:raise BuildControlError("BORIS volume controller: "+message)

def inspect(identifier):
    rows=json.loads(docker_capture("inspect",identifier).stdout)
    require(len(rows)==1,"ambiguous container")
    return rows[0]

def _module_inputs(selected):
    from bootstrap_docker_toolchain import read_input
    controller=read_input(selected,"scripts/docker_boris_volume.py")
    require(hashlib.sha256(controller).hexdigest()==LOADED_CONTROLLER_SHA256,"loaded controller differs from selected source")
    return {name:dict(path=path,source=(raw:=read_input(selected,path)).decode('utf-8'),sha256=hashlib.sha256(raw).hexdigest())
            for name,path in MODULES.items()}

def _same_services(before,after,*,frontend_running):
    for key in ("backend","frontend"):
        require(after[key].get("Id")==before[key].get("Id") and after[key].get("Image")==before[key].get("Image")
                and after[key].get("State",{}).get("StartedAt")==before[key].get("State",{}).get("StartedAt"),"service incarnation changed")
    require(after["backend"].get("State",{}).get("Running") is True and
            after["frontend"].get("State",{}).get("Running") is frontend_running,"service running state differs")

def _mount_evidence(actual,cache,config_sha256):
    # Keep only ownership/mount facts, never a copy of image/container Env.
    return dict(config_sha256=config_sha256,cache_receipt_sha256=hashlib.sha256(canonical(cache)).hexdigest(),
        services={name:dict(container_id=value.get("Id"),image_id=value.get("Image"),
            started_at=value.get("State",{}).get("StartedAt"),hostname=value.get("Config",{}).get("Hostname"),
            user=value.get("Config",{}).get("User"),readonly_rootfs=value.get("HostConfig",{}).get("ReadonlyRootfs"),
            mounts=[{key:mount.get(key) for key in ("Destination","Type","Name","RW","Source")} for mount in value.get("Mounts",[])])
            for name,value in actual.items()})

def _asset():
    rows=json.loads(docker_capture("image","inspect",ASSET).stdout)
    require(len(rows)==1 and rows[0].get("Id")==ASSET and rows[0].get("Os")=="linux" and
            rows[0].get("Architecture")=="amd64" and not rows[0].get("Config",{}).get("Volumes"),"retained local asset differs")

def _checked_worker_receipt(value,admission):
    def known(ok,message):
        if not ok:raise ControlOutcomeUnknown("BORIS worker outcome unproven: "+message)
    known(isinstance(value,dict),"receipt is not an object")
    known(value.get("schema")=="fullmag.boris.volume-build-receipt.v2" and
          value.get("attempt_id")==admission["attempt_id"] and value.get("admission")==admission,"receipt binding differs")
    state=value.get("state")
    known(state in {"native_build_and_abi_verified_not_benchmark","failed_resources_retained"},"state is not a recognized terminal outcome")
    known(isinstance(value.get("stages"),list),"stage termination inventory missing")
    known(state!="native_build_and_abi_verified_not_benchmark" or bool(value["stages"]),"successful build lacks executed stages")
    for record in value["stages"]:
        known(isinstance(record,dict) and {"pid","child_reaped","exit_code","process_returncode"}.issubset(record),"stage termination proof missing")
        known(not record.get("cleanup_errors"),"process-group/pipe cleanup outcome unproven")
        pid=record["pid"]
        if pid is None:
            known(state=="failed_resources_retained" and record["child_reaped"] is False and
                  record["exit_code"] is None and record["process_returncode"] is None and
                  isinstance(record.get("failure"),str) and bool(record["failure"]),"unstarted child proof inconsistent")
        else:
            known(type(pid) is int and pid>0 and record["child_reaped"] is True and
                  type(record["exit_code"]) is int and type(record["process_returncode"]) is int and record["process_returncode"]==record["exit_code"],"child termination not confirmed")
    if state=="failed_resources_retained":
        known(isinstance(value.get("error"),str) and bool(value["error"]),"terminal failure reason missing")
    return state=="native_build_and_abi_verified_not_benchmark"


def run(args):
    from docker_dev import _require_native_windows,_select_source,_compose_identity
    from docker_volume_activate import _linked_runtime_terminals,_validate_running_group
    from docker_volume_dev import (_assert_private_restart_network,_retained_startup_enabled)
    from docker_dev_codegen import _backend_documents,_validate_backend,_probe_source,_source_matches
    import docker_backend_volume_cache as cache
    _require_native_windows()
    require(re.fullmatch(r"[0-9a-f]{32}",args.attempt) and re.fullmatch(r"[0-9a-f]{64}",args.config_sha256),"exact attempt/config pins required")
    require(args.reference_asset_image_id==ASSET and 0<args.maximum_build_seconds<=28800,"asset/duration differs")
    selected,layout=_select_source(Path(args.repo_root).resolve(strict=True),args.source_root)
    identity=_compose_identity(layout);configured=toolchain_configuration(selected,identity)
    control=BuildControl(identity,configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]);control.prepare()
    root="development/attempts/"+args.attempt
    original=control.read(root+"/terminal.json");document=control.read(root+"/compose.json")
    require(document.get("name")==control.project and hashlib.sha256(canonical(document)).hexdigest()==args.config_sha256,"retained Compose CAS differs")
    require(original.get("compose_project")==control.project and original.get("inputs",{}).get("source_root")==str(selected),"retained source/project differs")
    image=original["inputs"]["image_id"]
    candidates=_linked_runtime_terminals(control,args.attempt,original,source_root=str(selected),image=image,config_sha256=args.config_sha256)
    # Match exactly one current admitted incarnation, never silently select an old one.
    admitted=[]
    for terminal in candidates:
        try:ids=_validate_running_group(control,identity,document,terminal,image,source_root=str(selected));admitted.append((terminal,ids))
        except BuildControlError:continue
    require(len(admitted)==1,"one exact admitted current runtime required")
    terminal,(backend_id,frontend_id)=admitted[0];ids=dict(backend=backend_id,frontend=frontend_id)
    before={key:inspect(value) for key,value in ids.items()};_asset()
    require(not _retained_startup_enabled(before["backend"]),"startup activation requires dedicated recovery")
    cache_profile=control.read(root+"/backend-cache.json");cache.validate_container(before["backend"],cache_profile)
    modules=_module_inputs(selected)
    inputs=dict(development_attempt=args.attempt,config_sha256=args.config_sha256,source_root=str(selected),image_id=image,
        backend_container=backend_id,frontend_container=frontend_id,retained_asset_image_id=ASSET,
        module_sha256={key:value["sha256"] for key,value in modules.items()},maximum_build_seconds=args.maximum_build_seconds)
    with control.operation("boris-reference",inputs) as operation:
        require(control.read(root+"/terminal.json")==original and control.read(root+"/compose.json")==document,"retained proof changed")
        fresh={key:inspect(value) for key,value in ids.items()};_same_services(before,fresh,frontend_running=True)
        _assert_private_restart_network(fresh,ids,control.project)
        known=False;frontend_stopped=False
        try:
            operation["daemon_pending"]=True
            docker_capture("stop","--time","60",frontend_id,timeout=90)
            frontend_stopped=True
            fresh={key:inspect(value) for key,value in ids.items()};_same_services(before,fresh,frontend_running=False)
            _assert_private_restart_network(fresh,ids,control.project)
            docker_capture("exec",backend_id,"/usr/local/bin/python3","-B","-c",HEALTH,timeout=15)
            operation["daemon_pending"]=False
            receipt,provenance,receipt_sha,provenance_binary=_backend_documents(backend_id)
            backend_source,_,_=_validate_backend(receipt,provenance,receipt_sha,provenance_binary)
            source_probe,_=_probe_source(backend_id,operation["receipt"]["attempt"])
            if not _source_matches(source_probe,backend_source):
                # This exact refusal precedes every copy/admission/worker dispatch.
                known=True
                operation["receipt"].update(refusal_phase="preproducer-source-guard",producer_started=False)
                require(False,"mounted sources differ from actual Fullmag package")
            token=operation["receipt"]["attempt"];prefix="/build/external-reference-boris/"+token+"/prefix"
            copy_doc=dict(mode="copy",order=["supplier"],modules={"supplier":modules["supplier"]},target=prefix)
            command=control.helper_args("",name="fullmag-boris-copy-"+token)
            point=command.index("--entrypoint")
            command[point:]=["--mount","type=volume,src="+cache_profile["volume_names"]["build"]+",dst=/build,volume-nocopy",
                "--entrypoint","/usr/bin/python3",ASSET,"-B","-c",WRAPPER]
            operation["daemon_pending"]=True
            copied=bounded_capture(command,data=canonical(copy_doc),timeout=300)
            if copied.returncode:raise BuildControlError("retained payload copy failed: "+copied.stderr.decode('utf-8','replace')[-4096:])
            operation["daemon_pending"]=False;_asset()
            require(_module_inputs(selected)==modules,"source helpers changed during supply")
            fresh={key:inspect(value) for key,value in ids.items()};_same_services(before,fresh,frontend_running=False)
            _assert_private_restart_network(fresh,ids,control.project)
            docker_capture("exec",backend_id,"/usr/local/bin/python3","-B","-c",HEALTH,timeout=15)
            mount_evidence=_mount_evidence(fresh,cache_profile,args.config_sha256)
            mount_sha=hashlib.sha256(canonical(mount_evidence)).hexdigest()
            admission=dict(schema="fullmag.boris.volume-producer-admission.v2",compose_project=control.project,
                container_id=backend_id,container_hostname=fresh["backend"]["Config"]["Hostname"],image_id=image,
                toolchain_image_id=document["services"]["backend"]["environment"]["FULLMAG_TOOLCHAIN_IMAGE_ID"],
                source_host_root=str(selected),package_receipt_sha256=receipt_sha,producer_sha256=modules["producer"]["sha256"],
                maximum_build_seconds=args.maximum_build_seconds,mount_attestation_sha256=mount_sha,
                attempt_id=token,prefix_root=prefix,payload_image_id=ASSET,supplier_sha256=modules["supplier"]["sha256"],
                controller_sha256=LOADED_CONTROLLER_SHA256,module_manifest_sha256=hashlib.sha256(canonical(modules)).hexdigest())
            control.write(operation["root"]+"/admission.json",admission)
            control.write(operation["root"]+"/mount-attestation.json",mount_evidence)
            worker_doc=dict(mode="produce",order=["supplier","producer","boris","verify_boris_nf_interface","boris_nf_common_case_v3"],modules=modules,admission=admission)
            operation["daemon_pending"]=True
            result=docker_capture("exec","-i",backend_id,"/usr/local/bin/python3","-B","-c",WRAPPER,
                data=canonical(worker_doc),timeout=args.maximum_build_seconds+120,allow_failure=True)
            retained=docker_capture("exec",backend_id,"/usr/local/bin/python3","-B","-c",READ_RECEIPT,token,timeout=30)
            worker=json.loads(retained.stdout);success=_checked_worker_receipt(worker,admission)
            require((result.returncode==0)==success,"client/worker completion differs")
            operation["daemon_pending"]=False
            require(_module_inputs(selected)==modules,"helpers changed during producer")
            _,_,after_sha,_=_backend_documents(backend_id);require(after_sha==receipt_sha,"Fullmag package changed during producer")
            fresh={key:inspect(value) for key,value in ids.items()};_same_services(before,fresh,frontend_running=False)
            _assert_private_restart_network(fresh,ids,control.project)
            docker_capture("exec",backend_id,"/usr/local/bin/python3","-B","-c",HEALTH,timeout=15)
            known=True
            control.write(operation["root"]+"/producer-receipt.json",worker)
            operation["receipt"].update(state="restoring-owned-frontend",image_id=image,
                config_sha256=args.config_sha256,backend_container=backend_id,frontend_container=frontend_id,
                worker_receipt_sha256=hashlib.sha256(retained.stdout).hexdigest(),benchmark_executed=False,physics_qualified=False)
        finally:
            if frontend_stopped and known:
                fresh={key:inspect(value) for key,value in ids.items()};_same_services(before,fresh,frontend_running=False)
                operation["daemon_pending"]=True;docker_capture("start",frontend_id,timeout=90)
                restored=inspect(frontend_id)
                require(restored.get("Id")==before["frontend"].get("Id") and restored.get("Image")==before["frontend"].get("Image") and restored.get("State",{}).get("Running") is True,"owned frontend restart not confirmed")
                operation["daemon_pending"]=False
            elif frontend_stopped:
                operation["daemon_pending"]=True
                operation["receipt"]["idle_fence"]="retained; reconcile exact operation before retry"
        operation["receipt"]["state"]="succeeded" if success else "failed-confirmed"
        if not success:raise BuildControlError("BORIS producer failed; bounded retained receipt saved")
    return 0


# This recovery admits only the reviewed controller's source-guard refusal.
PREPRODUCER_SCHEMA="fullmag.boris.preproducer-reconciliation.v1"
REFUSED_CONTROLLER_SHA256="bda9188b58bfcb5c9f5d8dd30d4920e87e0ab69227dc4f37439e58a4eae2525a"
PREPRODUCER_ERROR="BORIS volume controller: mounted sources differ from actual Fullmag package"
PREPRODUCER_PROBE=r"""import json,os,sys,urllib.request,fcntl,time,uuid,pathlib
from pathlib import Path
attempt=sys.argv[1]
if len(attempt)!=32 or any(c not in '0123456789abcdef' for c in attempt):raise RuntimeError('invalid attempt')
if os.path.lexists('/build/external-reference-boris/'+attempt):raise RuntimeError('producer/payload root exists')
if os.environ.get('FULLMAG_ACCEPTED_STORE_SCOPE'):raise RuntimeError('scoped store unsupported by this recovery')
sys.path.insert(0,'/opt/fullmag');import runtime_service,hashlib,stat
paths=runtime_service.canonical_paths();expected=json.loads(sys.argv[2])
def regular(path):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  st=os.fstat(fd)
  if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or not 0<st.st_size<=8*1024*1024:raise RuntimeError('invalid Windows ownership file')
  return os.read(fd,8*1024*1024+1)
 finally:os.close(fd)
def lock(path):
 fd=os.open(path,os.O_RDWR|os.O_NOFOLLOW)
 deadline=time.monotonic()+5
 try:
  while True:
   try:
    fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    return fd
   except BlockingIOError:
    if time.monotonic()>=deadline: raise RuntimeError('saved-authoring evidence lock busy after 5 seconds')
    time.sleep(0.025)
 except BaseException: os.close(fd);raise
def inventory(root):
 root=pathlib.Path(root)
 if not root.is_dir() or any(p.is_symlink() for p in (root,*root.parents)): raise RuntimeError('unsafe inventory root')
 found=[];count=0
 for current,dirs,files in os.walk(root,followlinks=False):
  for name in dirs+files:
   p=pathlib.Path(current)/name;count+=1
   if count>8192 or p.is_symlink(): raise RuntimeError('unsafe/unbounded inventory')
  for name in files:
   p=pathlib.Path(current)/name
   if not p.is_file(): raise RuntimeError('invalid inventory entry')
   found.append(str(p.relative_to(root)))
 return found
def canon(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
raws={'certificate':regular(paths.host_certificate),'owner':regular(paths.state/'.fullmag-windows-folder-owner.json'),'grant':regular(paths.state/'.fullmag-windows-folder-grant.json')}
if {k:hashlib.sha256(v).hexdigest() for k,v in raws.items()}!=expected:raise RuntimeError('Windows documents changed')
host=json.loads(raws['certificate']);owner=json.loads(raws['owner']);grant=json.loads(raws['grant'])
if (owner!=host or host.get('schema')!='fullmag.windows-folder-host.v1' or host.get('storage_profile')!='windows-folder-v1' or host.get('restart_verified') is not True
 or grant.get('schema')!='fullmag.windows-folder-session.v1' or grant.get('state')!='operational' or grant.get('container_root')!='/state'
 or grant.get('host_attestation_sha256')!=hashlib.sha256(raws['certificate']).hexdigest() or grant.get('owner_token')!=host.get('owner_token')):raise RuntimeError('Windows ownership/grant differs')
if paths.store!=Path(os.environ['FULLMAG_RUNS_ROOT'])/'session-store':raise RuntimeError('runtime store differs')
store=paths.store
relative=store.relative_to(paths.state).as_posix()
if relative=='.' or '..' in pathlib.PurePosixPath(relative).parts: raise RuntimeError('unsafe accepted store relative path')
owner_token=host['owner_token']
if str(uuid.UUID(owner_token))!=owner_token or uuid.UUID(owner_token).int==0: raise RuntimeError('invalid store owner token')
if type(host.get('host_volume_serial')) is not int or host['host_volume_serial']<=0: raise RuntimeError('invalid host volume serial')
stable_identity={'schema':'fullmag.docker-admitted-store-identity.v2',
 'host_root':host['host_root'].replace('\\','/').translate(str.maketrans('ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')),
 'host_volume_serial':host['host_volume_serial'],'engine_id':host['engine_id'],
 'owner_token':owner_token,'relative_state_path':relative}
store_id='sha256:'+hashlib.sha256(canon(stable_identity)).hexdigest()
ledger=pathlib.Path(os.environ['FULLMAG_HOST_LEDGER_ROOT'])
for root in (store,ledger):
 if not root.is_dir() or any(p.is_symlink() for p in (root,*root.parents)): raise RuntimeError('unsafe store/ledger root')
store_fd=lock(store/'WRITER.lock')
try:
 runs=store/'runs'
 if not runs.is_dir() or runs.is_symlink(): raise RuntimeError('runs directory missing')
 run_directories=sorted(p.name for p in runs.iterdir())
 if run_directories: raise RuntimeError('accepted runs, admissions or leases exist')
 transient_files=inventory(store/'temp')+inventory(store/'recovery')
 if transient_files: raise RuntimeError('store has pending writes/recovery')
finally: fcntl.flock(store_fd,fcntl.LOCK_UN);os.close(store_fd)
ledger_fd=lock(ledger/'WRITER.lock')
try:
 reservations=json.loads(regular(ledger/'HOST_RESOURCE_LEDGER.json')).get('reservations')
 if not isinstance(reservations,list): raise RuntimeError('reservations missing')
 reservation_states=[];foreign_reservations=0
 for row in reservations:
  identity=row.get('identity') if isinstance(row,dict) else None
  candidate=identity.get('store_id') if isinstance(identity,dict) else None
  if not isinstance(candidate,str) or len(candidate)!=71 or not candidate.startswith('sha256:') or any(c not in '0123456789abcdef' for c in candidate[7:]): raise RuntimeError('reservation store ownership is unknown')
  if candidate==store_id: reservation_states.append(row.get('state'))
  else: foreign_reservations+=1
 if any(s!='released' for s in reservation_states): raise RuntimeError('affected host resource reservation active/unknown')
finally: fcntl.flock(ledger_fd,fcntl.LOCK_UN);os.close(ledger_fd)
with urllib.request.urlopen('http://127.0.0.1:8081/v2/platform/health',timeout=5) as r:
 health=json.load(r)
 if r.status!=200 or health.get('status')!='ok' or health.get('active_session') is not False:raise RuntimeError('API is not empty idle')
print(json.dumps(dict(schema='fullmag.boris.preproducer-absence.v1',attempt=attempt,prefix_absent=True,accepted_runs_empty=True,transient_files=transient_files,reservation_states=reservation_states,accepted_store_id=store_id,health=health)))
"""


def validate_preproducer_refusal(original, request, host, absence):
    require(original.get('schema')=='fullmag.docker-build-operation.v1' and original.get('phase')=='boris-reference' and
        original.get('state')=='outcome-unknown-resources-retained' and original.get('error')==PREPRODUCER_ERROR and
        original.get('attempt')==request['attempt'] and original.get('compose_project')==request['compose_project'], 'not the exact source-guard refusal')
    require(request.get('refused_controller_sha256')==REFUSED_CONTROLLER_SHA256 and host.get('controller_sha256')==REFUSED_CONTROLLER_SHA256 and
        host.get('attempt')==request['attempt'] and type(host.get('exit_code')) is int and host['exit_code']==1 and
        host.get('schema')=='fullmag.boris.preproducer-host-exit-attestation.v1' and host.get('observation_kind')=='operator-factual-attestation' and
        host.get('exec_session_id')==37116 and host.get('observed_error')==PREPRODUCER_ERROR, 'host source-guard exit attestation differs')
    require(absence.get('schema')=='fullmag.boris.preproducer-absence.v1' and absence.get('attempt')==request['attempt'] and
        absence.get('prefix_absent') is True and absence.get('accepted_runs_empty') is True and
        absence.get('transient_files')==[] and isinstance(absence.get('reservation_states'),list) and all(v=='released' for v in absence['reservation_states']) and
        absence.get('health',{}).get('active_session') is False, 'producer/accepted work is not proven absent')
    inputs=original['inputs']
    require(inputs.get('backend_container')==request['containers']['backend']['id'] and
        inputs.get('frontend_container')==request['containers']['frontend']['id'] and inputs.get('source_root')==request['source_root'] and
        inputs.get('config_sha256')==request['config_sha256'] and inputs.get('image_id')==request['containers']['backend']['image'], 'original service/source pins differ')
    require(original.get('helper_container')=='fullmag-control-'+request['attempt'] and
        not any(k in original for k in ('worker_receipt_sha256','producer_receipt','admission')), 'producer may have started')


def reconcile_preproducer(args, control, selected, request, request_raw):
    import copy,time,subprocess
    import docker_volume_reconcile as recovery
    from bootstrap_docker_toolchain import read_input
    expected={'schema','attempt','compose_project','source_root','port','config_sha256','unknown_receipt_sha256','controller_sha256','containers','package_documents','refused_controller_sha256','host_exit_proof','reconciler_sha256','windows_documents','ledger_receipt_sha256'}
    require(set(request)==expected,'closed preproducer request required')
    core={k:v for k,v in request.items() if k not in ('refused_controller_sha256','host_exit_proof','reconciler_sha256','windows_documents','ledger_receipt_sha256')};core['schema']=recovery.SCHEMA
    recovery.validate_request(core)
    require(hashlib.sha256(read_input(selected,'scripts/docker_volume_reconcile.py')).hexdigest()==hashlib.sha256(Path(recovery.__file__).read_bytes()).hexdigest()==request['reconciler_sha256'],'reconcile helper source differs')
    require(isinstance(request['windows_documents'],dict) and set(request['windows_documents'])=={'certificate','owner','grant'} and all(isinstance(v,str) and re.fullmatch(r'[0-9a-f]{64}',v) for v in request['windows_documents'].values()),'Windows document pins missing')
    require(isinstance(request['ledger_receipt_sha256'],str) and re.fullmatch(r'[0-9a-f]{64}',request['ledger_receipt_sha256']),'ledger receipt pin missing')
    require(request['source_root']==str(selected) and request['compose_project']==control.project and request['port']==args.port and
        hashlib.sha256(read_input(selected,'scripts/docker_boris_volume.py')).hexdigest()==LOADED_CONTROLLER_SHA256==request['controller_sha256'], 'recovery source/group differs')
    root='boris-reference/attempts/'+request['attempt'];original_raw=recovery.read_raw(control,root+'/receipt.json')
    require(hashlib.sha256(original_raw).hexdigest()==request['unknown_receipt_sha256'],'unknown receipt changed')
    original=json.loads(original_raw)
    require(recovery.read_raw(control,'active').strip()==request['attempt'].encode() and recovery.read_raw(control,root+'/terminal.json',True) is None,'original lease/terminal differs')
    proof=request['host_exit_proof'];require(isinstance(proof,dict) and set(proof)=={'path','sha256'} and re.fullmatch(r'[0-9a-f]{64}',proof['sha256']),'closed host exit proof required')
    host_raw=recovery.read_raw(control,proof['path']);require(hashlib.sha256(host_raw).hexdigest()==proof['sha256'],'host proof CAS differs');host=json.loads(host_raw)
    document=control.read('development/attempts/'+original['inputs']['development_attempt']+'/compose.json')
    require(hashlib.sha256(canonical(document)).hexdigest()==request['config_sha256'] and document.get('name')==control.project,'Compose binding differs')
    actual=recovery.inspect_pins(request,frontend_running=False)
    from docker_volume_dev import _assert_private_restart_network, _retained_startup_enabled
    ids={key:request['containers'][key]['id'] for key in ('backend','frontend')}
    _assert_private_restart_network({key:actual[key] for key in ids},ids,control.project)
    require(not _retained_startup_enabled(actual['backend']),'startup-enabled backend requires separate recovery')
    require(actual['frontend']['State'].get('Status')=='exited','frontend is not known stopped')
    recovery.validate_original_owner(actual['lease'],original,control,request['containers']['lease']['image'])
    image=json.loads(docker_capture('image','inspect',control.image).stdout);require(len(image)==1 and image[0]['Id']==actual['lease']['Image'],'original helper image differs')
    environment=document['services']['backend']['environment']
    ports=document['services']['frontend'].get('ports',[])
    require(len(ports)==1 and str(ports[0].get('published'))==str(args.port) and ports[0].get('host_ip')=='127.0.0.1','frontend loopback port differs')
    from docker_volume_dev import _validate_retained_service
    image_config=json.loads(docker_capture('image','inspect',request['containers']['backend']['image']).stdout)[0]['Config']
    for name in ('backend','frontend'):
        _validate_retained_service(document,actual[name],name,image_config,expected_started_at=request['containers'][name]['started_at'])
    base='development/attempts/'+original['inputs']['development_attempt']
    ledger_raw=recovery.read_raw(control,base+'/host-ledger.json')
    require(hashlib.sha256(ledger_raw).hexdigest()==request['ledger_receipt_sha256'],'retained ledger receipt differs')
    import docker_host_ledger as ledger
    ledger._validate_host_receipt(json.loads(ledger_raw),{key:environment['FULLMAG_HOST_LEDGER_'+key.upper()] for key in ('project_id','mount_root','backing_image')})
    recovery.validate_package(request)
    def absent():
        for name in ('admission.json','mount-attestation.json','producer-receipt.json'):
            require(recovery.read_raw(control,root+'/'+name,True) is None,'producer admission/output exists')
        copied=docker_capture('ps','-a','--filter','name=^/fullmag-boris-copy-'+request['attempt']+'$','--format','{{.ID}}')
        require(not copied.stdout.strip(),'copy helper exists')
        raw=docker_capture('exec',request['containers']['backend']['id'],'/usr/local/bin/python3','-B','-c',PREPRODUCER_PROBE,request['attempt'],json.dumps(request['windows_documents']),timeout=15).stdout
        value=json.loads(raw);validate_preproducer_refusal(original,request,host,value);return value
    before_absence=absent();observer='fullmag-boris-reconcile-'+request['attempt'];journal=root+'/reconciliation'
    claim=subprocess.Popen(control.helper_args(recovery.claim_script(control,root,request,request['unknown_receipt_sha256'],phase='boris-reference',publish_verified=False),name=observer),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    begun=False
    try:
        require(control._line(claim)=='READY','observer exclusion not acquired')
        observer_rows=json.loads(docker_capture('inspect',observer).stdout);require(len(observer_rows)==1,'ambiguous observer')
        observed=observer_rows[0];recovery.validate_original_owner(observed,{'helper_container':observer},control,actual['lease']['Image'])
        require(observed['State'].get('Running') is True,'observer not live')
        recovery.inspect_pins(request,frontend_running=False);absent();recovery.validate_package(request)
        recovery.write_immutable(control,root+'/unknown-receipt.json',original_raw)
        control.write(journal+'/observer.json',dict(request_sha256=args.request_sha256,container_id=observed['Id'],fingerprint=recovery.fingerprint(observed),state='BEGIN-requested'))
        begun=True;claim.stdin.write(b'BEGIN\n');claim.stdin.flush();require(control._line(claim)=='OBSERVING','observer BEGIN unknown')
        # Restore only the original frontend; no source admission or producer retry.
        docker_capture('start',request['containers']['frontend']['id'],timeout=90)
        restored=inspect(request['containers']['frontend']['id']);require(restored.get('State',{}).get('Running') is True and recovery.fingerprint(restored)==request['containers']['frontend']['fingerprint'],'frontend restore not confirmed')
        ready_script="fetch('http://127.0.0.1:8080/',{redirect:'manual',signal:AbortSignal.timeout(5000)}).then(r=>{if(![200,307,308].includes(r.status))process.exit(1)}).catch(()=>process.exit(1))"
        deadline=time.monotonic()+120
        while True:
            status=docker_capture('exec',restored['Id'],'/usr/local/bin/node','-e',ready_script,timeout=10,allow_failure=True)
            if status.returncode==0:break
            require(time.monotonic()<deadline,'frontend readiness unknown');time.sleep(.5)
        final_request=copy.deepcopy(request);final_request['containers']['frontend']['started_at']=restored['State']['StartedAt']
        final_actual=recovery.inspect_pins(final_request)
        _assert_private_restart_network({key:final_actual[key] for key in ids},ids,control.project)
        after_absence=absent();recovery.validate_package(request)
        result=copy.deepcopy(original);result.update(state='failed-confirmed',reconciliation=dict(schema=PREPRODUCER_SCHEMA,request_sha256=args.request_sha256,original_sha256=request['unknown_receipt_sha256'],host_exit_proof=proof,before_absence=before_absence,after_absence=after_absence,frontend_restored=dict(id=restored['Id'],started_at=restored['State']['StartedAt'],fingerprint=recovery.fingerprint(restored))),finished_at=time.time())
        result.pop('idle_fence',None);raw=canonical(result)+b'\n';sha=hashlib.sha256(raw).hexdigest();entry=journal+'/'+sha
        recovery.write_immutable(control,entry+'/result.json',raw)
        recovery.write_immutable(control,entry+'/prepared.json',canonical(dict(schema=PREPRODUCER_SCHEMA,request_sha256=args.request_sha256,unknown_receipt_sha256=request['unknown_receipt_sha256'],result_sha256=sha))+b'\n')
        require(claim.poll() is None,'observer lease disappeared');claim.stdin.write(('COMMIT '+sha+'\n').encode());claim.stdin.flush();claim.stdin.close();require(control._line(claim)=='COMMITTED','terminal publication unknown')
        require(recovery.read_raw(control,root+'/terminal.json')==raw,'terminal differs')
        deadline=time.monotonic()+30
        while recovery.read_raw(control,'active',True) is not None:
            require(time.monotonic()<deadline,'original lease release unconfirmed');time.sleep(.25)
        require(claim.wait(timeout=5)==0,'observer exit unconfirmed')
        print(json.dumps(dict(state='failed-confirmed',attempt=request['attempt'],frontend_restored=True,producer_started=False)))
    except BaseException as error:
        if begun:
            control.write(journal+'/last-error.json',dict(request_sha256=args.request_sha256,error=str(error),state='outcome-unknown-resources-retained',observer=observer))
            raise ControlOutcomeUnknown('BORIS recovery after BEGIN unknown; original and observer leases retained') from error
        raise
    finally:
        if claim.stdin is not None and not claim.stdin.closed:claim.stdin.close()
        if not begun:claim.wait(timeout=5)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo-root',type=Path,required=True);parser.add_argument('--source-root',type=Path,required=True)
    parser.add_argument('--attempt',required=True);parser.add_argument('--config-sha256',required=True)
    parser.add_argument('--reference-asset-image-id',required=True);parser.add_argument('--maximum-build-seconds',type=int,required=True)
    return run(parser.parse_args())
if __name__=='__main__':raise SystemExit(main())
