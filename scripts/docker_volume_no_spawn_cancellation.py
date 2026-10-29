"""Managed invocation of the existing native failed-before-spawn cancellation.

Preview reads only. Apply never edits a lease/catalog/OWNER: the pinned native
operator alone publishes Stop/Cancelled and WorkerNoSpawn under its own locks.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import uuid

from docker_build_control import (BuildControl, BuildControlError, ControlOutcomeUnknown,
                                  canonical, docker_capture, toolchain_configuration)
from docker_volume_reconcile import fingerprint, write_immutable

NATIVE_SCHEMA='runtime_service_failed_no_spawn_cancellation.v1'
SCHEMA='fullmag.docker-no-spawn-cancellation.v1'
PROBE_SCHEMA='fullmag.docker-failed-no-spawn-probe.v1'
SHA=re.compile(r'[0-9a-f]{64}\Z')
ID=re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,199}\Z')


def require(condition,message):
    if not condition:raise BuildControlError('No-spawn cancellation: '+message)


def sha(raw):return hashlib.sha256(raw).hexdigest()


def obj(raw,label):
    def unique(pairs):
        value={}
        for key,item in pairs:
            require(key not in value,'duplicate key in '+label);value[key]=item
        return value
    require(isinstance(raw,bytes) and 0<len(raw)<=256*1024,label+' exceeds byte bound')
    value=json.loads(raw.decode('utf-8'),object_pairs_hook=unique)
    require(isinstance(value,dict),label+' is not an object')
    return value


def validate_request_shape(request):
    fields={'schema_version','request_id','config_sha256','owner_sha256','expected_owner',
            'claim_sha256','lease_sha256','reservation_sha256','identity','reason'}
    require(set(request)==fields and request['schema_version']==NATIVE_SCHEMA,'unsupported request')
    try:token=uuid.UUID(request['request_id'])
    except (ValueError,TypeError,AttributeError):raise BuildControlError('Invalid cancellation UUID')
    require(token.int!=0 and str(token)==request['request_id'],'noncanonical request UUID')
    require(isinstance(request['reason'],str) and 0<len(request['reason'].strip())<=4096
            and all(ord(c)>=32 and ord(c)!=127 for c in request['reason']),'unsafe reason')
    for field in ('config_sha256','owner_sha256','claim_sha256','lease_sha256','reservation_sha256'):
        require(isinstance(request[field],str) and SHA.fullmatch(request[field]),'invalid '+field)
    identity=request['identity'];require(isinstance(identity,dict),'missing reservation identity')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}',identity.get('store_id','')) is not None,'invalid store ID')
    for field in ('run_id','task_id','resource_id','lease_token'):
        require(isinstance(identity.get(field),str) and ID.fullmatch(identity[field]),'unsafe '+field)
    owner=identity.get('owner',{})
    require(isinstance(owner,dict) and owner.get('kind')=='solver'
            and isinstance(owner.get('attempt_id'),str) and ID.fullmatch(owner['attempt_id'])
            and type(owner.get('ownership_epoch')) is int and owner['ownership_epoch']>0,'invalid attempt identity')


def validate_request(request,probe,process_sha):
    validate_request_shape(request)
    identity=request['identity']
    require(probe.get('schema')==PROBE_SCHEMA and probe.get('native_processes_absent') is True
            and probe.get('process_receipt_sha256')==process_sha,'live or changed process proof')
    require(not probe.get('other_active_reservations'),'other active reservations exist')
    require(probe.get('config_sha256')==request['config_sha256']
            and probe.get('owner_sha256')==request['owner_sha256']
            and probe.get('owner')==request['expected_owner'],'native owner/config changed')
    require(probe['owner'].get('state')=='failed','native owner is not failed')
    for field in ('claim','lease','reservation'):
        require(sha(canonical(probe[field]))==request[field+'_sha256'],field+' changed')
    require(probe['reservation'].get('identity')==identity
            and probe['reservation'].get('state')=='committed'
            and probe['reservation'].get('worker_launch_gate')=={'state':'pending'}
            and probe['lease'].get('state')=='active','launch permit is not unused')


def validate_result(request,result,after):
    identity=request['identity']
    require(result.get('schema_version')==NATIVE_SCHEMA and result.get('status')=='cancelled_no_spawn'
            and result.get('request_id')==request['request_id']
            and all(result.get(k)==identity[k] for k in ('run_id','task_id')),'native result scope differs')
    proof=result.get('release_proof_sha256')
    require(isinstance(proof,str) and SHA.fullmatch(proof),'native release proof is absent')
    require(after['reservation'].get('identity')==identity
            and after['reservation'].get('state')=='released'
            and after['reservation'].get('worker_launch_gate')=={'state':'closed'}
            and after['reservation'].get('release_proof_sha256')==proof
            and after['lease'].get('state')=='released'
            and after['task'].get('lifecycle')=='cancelled'
            and after.get('native_processes_absent') is True
            and not after.get('other_active_reservations'),'native terminal/release evidence incomplete')


# The probe executes in the exact retained backend, never in a replacement PID
# namespace. Reads are fenced by the native OWNER, ledger and store locks.
BINARY_HASH=r'''
def binary_sha(path):
 if path.parent.resolve(strict=True)!=path.parent:raise RuntimeError('linked binary parent')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  before=os.fstat(fd)
  if not stat.S_ISREG(before.st_mode) or before.st_nlink<1 or not 0<before.st_size<=512*1024*1024 or before.st_mode&0o222:raise RuntimeError('binary is not a bounded published file')
  digest=hashlib.sha256();count=0
  while True:
   block=os.read(fd,1024*1024)
   if not block:break
   count+=len(block)
   if count>before.st_size:raise RuntimeError('binary grew during read')
   digest.update(block)
  after=os.fstat(fd)
  fields=('st_dev','st_ino','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
  if count!=before.st_size or any(getattr(before,k)!=getattr(after,k) for k in fields):raise RuntimeError('binary changed during read')
  return digest.hexdigest()
 finally:os.close(fd)
'''

# docker exec does not inherit PID 1's environment adjustments. Reuse the
# image-owned CPU CUDA ABI setup before both observation and invocation.
NATIVE_ENVIRONMENT=r'''
def native_environment(paths,binary):
 import entrypoint,subprocess
 entrypoint._configure_device_access()
 environment=runtime_service.process_environment(paths,service=True)
 trace=subprocess.run(['/usr/bin/ldd',str(binary)],stdin=subprocess.DEVNULL,
  stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,env=environment)
 if trace.returncode or b'not found' in trace.stdout+trace.stderr:
  raise RuntimeError('native loader preflight failed: '+(trace.stdout+trace.stderr).decode('utf-8','replace')[-4096:])
 return environment
'''

GUEST=r'''
import fcntl,hashlib,json,os,pathlib,stat,sys
sys.path.insert(0,'/opt/fullmag');import runtime_service
def canon(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
def sha(v):return hashlib.sha256(v).hexdigest()
def read(path,maximum=16*1024*1024):
 p=pathlib.Path(path)
 if p.parent.resolve(strict=True)!=p.parent:raise RuntimeError('linked operational parent')
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  st=os.fstat(fd)
  if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or not 0<st.st_size<=maximum:raise RuntimeError('unsafe operational file')
  raw=os.read(fd,maximum+1)
  if len(raw)!=st.st_size:raise RuntimeError('operational file changed')
  return raw
 finally:os.close(fd)
def load(path):return json.loads(read(path))
def lock(path):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 if not stat.S_ISREG(os.fstat(fd).st_mode):raise RuntimeError('unsafe lock')
 fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);return fd
paths=runtime_service.canonical_paths();root=runtime_service.runtime_services_root(paths)
fds=[]
try:
 for path in (root/'OWNER.lock',pathlib.Path('/host-ledger/ledger/WRITER.lock'),paths.store/'WRITER.lock'):fds.append(lock(path))
 owner_raw=read(root/'OWNER.json');owner=json.loads(owner_raw)
 if owner.get('state')!='failed':raise RuntimeError('native owner is not failed')
 children=owner.get('children')
 if not isinstance(children,list) or len(children)!=2 or {x.get('role') for x in children}!={'compute','preparation'} or any(x.get('status') not in {'exited_success','exited_failure'} for x in children):raise RuntimeError('native children are not terminal')
 pids=[owner.get('pid'),*[x.get('pid') for x in children]]
 if any(type(pid)is not int or pid<=0 or os.path.exists('/proc/'+str(pid)) for pid in pids):raise RuntimeError('native process is live or ambiguous')
 process_raw=read(runtime_service.process_receipt_path(paths));process=json.loads(process_raw)
 if process.get('schema')!='fullmag.docker-process-tree.v1' or process.get('state')!='failed_outcome_retained' or process.get('api_diagnostic_only')is not True or process.get('accepted_store')!=str(paths.store):raise RuntimeError('API is not a fenced diagnostic')
 if process.get('error')!='runtime service owner observation failed during supervision: runtime service owner is not ready':raise RuntimeError('different supervision failure')
 ready=process.get('service_owner',{})
 if runtime_service._owner_identity(ready)!=runtime_service._owner_identity(owner) or runtime_service._owner_child_identity(ready)!=runtime_service._owner_child_identity(owner):raise RuntimeError('failed owner differs from retained ready pin')
 fence=pathlib.Path(process.get('api_failure_fence',''))
 if fence.parent!=runtime_service.process_receipt_path(paths).parent or not fence.name.startswith('api-failure-'):raise RuntimeError('diagnostic fence is outside control')
 fence_sha=sha(read(fence));api=process.get('api_pid')
 if type(api)is not int or api<=0:raise RuntimeError('API identity missing')
 for entry in pathlib.Path('/proc').iterdir():
  if not entry.name.isdigit():continue
  try:exe=os.readlink(entry/'exe')
  except FileNotFoundError:continue
  if exe.startswith(str(paths.package)+'/') and pathlib.Path(exe).name.startswith('fullmag'):
   if int(entry.name)!=api or pathlib.Path(exe).name!='fullmag-api':raise RuntimeError('unexpected native process remains live')
 request=INPUT['request'];identity=request['identity'];run=paths.store/'runs'/identity['run_id']
 lease=load(run/'resource_leases'/identity['resource_id']/(identity['lease_token']+'.json'))
 ledger=load('/host-ledger/ledger/HOST_RESOURCE_LEDGER.json');rows=ledger['reservations']
 selected=[r for r in rows if r.get('identity')==identity]
 if len(selected)!=1:raise RuntimeError('exact reservation absent or ambiguous')
 catalog=load(run/'run_catalog.json');tasks=[t for t in catalog['tasks'] if t.get('task_id')==identity['task_id']]
 if len(tasks)!=1:raise RuntimeError('exact task absent or ambiguous')
 claims=[]
 for p in sorted((run/'coordinator_journal'/'command').glob('*.json')):
  item=load(p)
  if item.get('task_id')==identity['task_id'] and item.get('attempt_id')==identity['owner']['attempt_id']:
   claim=item['payload']['checkpoint']['claim']
   if not claims or claim not in claims:claims.append(claim)
 if len(claims)!=1:raise RuntimeError('immutable claim is absent or ambiguous')
 binary=paths.package/'bin/fullmag-runtime-service'
 native_environment(paths,binary)
 print(json.dumps({'schema':'fullmag.docker-failed-no-spawn-probe.v1','owner':owner,'owner_sha256':sha(owner_raw),'config_sha256':sha(canon(load(paths.config))),
  'process_receipt_sha256':sha(process_raw),'api_failure_fence_sha256':fence_sha,'claim':claims[0],'lease':lease,'reservation':selected[0],'task':tasks[0],
  'other_active_reservations':[r for r in rows if r.get('state')!='released' and r.get('identity')!=identity],
  'native_processes_absent':True,'native_binary_sha256':binary_sha(binary)},sort_keys=True))
finally:
 for fd in reversed(fds):fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)
'''

APPLY=r'''
import hashlib,json,os,pathlib,stat,subprocess,sys
sys.path.insert(0,'/opt/fullmag');import runtime_service
paths=runtime_service.canonical_paths();binary=paths.package/'bin/fullmag-runtime-service'
if binary_sha(binary)!=INPUT['binary_sha256']:raise RuntimeError('native executable changed')
request=pathlib.Path(INPUT['request_path']);result_path=pathlib.Path(INPUT['result_path'])
if hashlib.sha256(request.read_bytes()).hexdigest()!=INPUT['request_sha256']:raise RuntimeError('immutable request changed')
if result_path.exists():raise RuntimeError('native result already exists; inspect before any replay')
result=subprocess.run([str(binary),'--cancel-failed-no-spawn','--config',str(paths.config),'--request',str(request)],
 stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120,env=native_environment(paths,binary))
if result.returncode:raise RuntimeError('native cancellation did not complete: '+result.stderr.decode('utf-8','replace')[-4096:])
value=json.loads(result.stdout);raw=json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()+b'\n'
fd=os.open(result_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o640)
try:os.write(fd,raw);os.fsync(fd)
finally:os.close(fd)
parent=os.open(result_path.parent,os.O_RDONLY|os.O_DIRECTORY)
try:os.fsync(parent)
finally:os.close(parent)
sys.stdout.buffer.write(raw)
'''


def guest(container,body,inputs):
    result=docker_capture('exec',container,'/usr/local/bin/python3','-B','-c',
                         'INPUT='+repr(inputs)+'\n'+BINARY_HASH+'\n'+NATIVE_ENVIRONMENT+'\n'+body,timeout=150)
    require(result.returncode==0,result.stderr.decode('utf-8','replace')[-4096:])
    return obj(result.stdout,'guest result')


def cancel(args):
    from docker_development_inputs import select_checkout
    from docker_dev_host import require_host
    from docker_compose_identity import compose_project_identity,validate_source_labels
    from docker_volume_dev import _validate_retained_service
    import fullmag_storage as storage
    require_host();selected=select_checkout(args.repo_root,args.source_root).resolve(strict=True)
    identity=compose_project_identity(storage.resolve_layout(selected,'docker-all-gpu'))
    configured=toolchain_configuration(selected,identity)
    control=BuildControl(identity,configured['services']['fem-gpu-toolchain']['build']['args']['FULLMAG_CUDA_BASE_IMAGE'])
    request_path=args.request.absolute();require(request_path.resolve(strict=True)==request_path,'linked request path')
    raw=request_path.read_bytes();require(sha(raw)==args.request_sha256,'operator request SHA differs')
    request=obj(raw,'operator request');validate_request_shape(request)
    previous_raw=control.read_bytes('development/current.json');previous=obj(previous_raw,'development terminal')
    attempt=previous.get('attempt');require(isinstance(attempt,str) and re.fullmatch('[0-9a-f]{32}',attempt),'invalid development attempt')
    base='development/attempts/'+attempt;compose_raw=control.read_bytes(base+'/compose.json');document=obj(compose_raw,'Compose')
    config_sha=sha(canonical(document))
    require(previous.get('state')=='succeeded' and previous.get('inputs',{}).get('source_root')==str(selected)
            and previous.get('compose_project')==control.project and previous.get('config_sha256')==config_sha
            and previous.get('backend_container')==args.backend_container_id
            and previous.get('inputs',{}).get('image_id')==args.image_id
            and control.read_bytes(base+'/terminal.json')==previous_raw
            and control.read_bytes('development/verified.json')==previous_raw,'retained development authority differs')
    image=json.loads(docker_capture('image','inspect',args.image_id).stdout)[0]
    first=None
    def observe():
        actual=json.loads(docker_capture('inspect',args.backend_container_id).stdout)
        require(len(actual)==1 and actual[0].get('Id')==args.backend_container_id,'backend incarnation differs')
        actual=actual[0];validate_source_labels(actual,identity)
        require(actual.get('Image')==args.image_id and actual.get('State',{}).get('Running')is True,'backend is not the retained running image')
        _validate_retained_service(document,actual,'backend',image['Config'])
        require(any(m.get('Destination')=='/host-ledger' and m.get('Type')=='volume'
                    and m.get('Name','').startswith('fullmag-dev-group-ledger-v1-') for m in actual.get('Mounts',[])),
                'requires a private DEV group ledger')
        if first is not None:require((actual['State']['StartedAt'],fingerprint(actual))==first,'backend restarted or changed')
        require(control.read_bytes('development/current.json')==previous_raw
                and control.read_bytes(base+'/terminal.json')==previous_raw
                and control.read_bytes(base+'/compose.json')==compose_raw,'development/config CAS changed')
        return actual,guest(args.backend_container_id,GUEST,{'request':request})
    actual,before=observe();first=(actual['State']['StartedAt'],fingerprint(actual))
    validate_request(request,before,args.process_receipt_sha256)
    if getattr(args,'reconcile_loader_failure',None):
        from docker_volume_no_spawn_loader_reconcile import reconcile
        return reconcile(control,attempt=args.reconcile_loader_failure,
            receipt_sha256=args.failed_receipt_sha256,request_raw=raw,selected=selected,
            backend_id=args.backend_container_id,image_id=args.image_id,before=before,
            observe=lambda:observe()[1],apply=args.apply)
    if not args.apply:return {'state':'preview-no-mutation','request':request,'before':before,'development_attempt':attempt,'compose_config_sha256':config_sha}
    executor_root=Path(__file__).resolve().parent.parent
    executor={'source_root':str(executor_root),'commit':storage.git(executor_root,'rev-parse','HEAD'),
              'controller_sha256':sha(Path(__file__).read_bytes())}
    with control.operation('cancel-failed-no-spawn',{'source_root':str(selected),'request_sha256':sha(raw),
            'backend_container_id':args.backend_container_id,'image_id':args.image_id,'executor':executor}) as operation:
        root='cancel-failed-no-spawn/attempts/'+operation['receipt']['attempt']
        saved_request=root+'/request.json';native_result=root+'/native-result.json'
        _,again=observe();require(again==before,'native cancellation evidence changed')
        write_immutable(control,saved_request,raw)
        operation['daemon_pending']=True
        try:
            # Both the helper and backend already mount the selected namespace
            # at their control root. Never insert the namespace a second time.
            result=guest(args.backend_container_id,APPLY,{'request_path':'/opt/fullmag/control/'+saved_request,
                'result_path':'/opt/fullmag/control/'+native_result,'request_sha256':sha(raw),'binary_sha256':before['native_binary_sha256']})
            _,after=observe();validate_result(request,result,after)
            require(after['owner_sha256']==before['owner_sha256'] and after['config_sha256']==before['config_sha256']
                    and after['process_receipt_sha256']==before['process_receipt_sha256']
                    and after['native_binary_sha256']==before['native_binary_sha256'],'native authority changed during cancellation')
        except Exception as error:
            raise ControlOutcomeUnknown('Native cancellation outcome requires receipt inspection; do not retry: '+str(error)) from error
        record={'schema':SCHEMA,'state':'cancelled-no-spawn','compose_project':control.project,'control_volume':control.volume,
                'control_namespace':control.namespace,'namespace_registry_sha256':control.namespace_registry_sha256,
                'source_root':str(selected),'development_attempt':attempt,'compose_config_sha256':config_sha,
                'backend_container_id':args.backend_container_id,'image_id':args.image_id,'started_at':first[0],
                'backend_fingerprint':first[1],'native_binary_sha256':before['native_binary_sha256'],
                'process_receipt_sha256':before['process_receipt_sha256'],'owner_sha256':before['owner_sha256'],
                'config_sha256':before['config_sha256'],'request_sha256':sha(raw),'request':request,'result':result,
                'before':before,'after':after,'native_result_path':native_result,'operation_root':root}
        path='verification/no-spawn-cancellation-'+request['request_id']+'.json';record_raw=canonical(record)+b'\n'
        write_immutable(control,path,record_raw)
        control.write('no-spawn-cancellation/current.json',{'schema':'fullmag.docker-no-spawn-cancellation-reference.v1','path':path,'sha256':sha(record_raw)})
        operation['daemon_pending']=False;operation['receipt'].update(state='succeeded',result={'path':path,'sha256':sha(record_raw)})
    return {'state':'cancelled-no-spawn','proof_path':path,'proof_sha256':sha(record_raw),'result':result}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo-root',type=Path,default=Path(__file__).resolve().parent.parent)
    p.add_argument('--source-root',type=Path,required=True)
    p.add_argument('--backend-container-id',required=True);p.add_argument('--image-id',required=True)
    p.add_argument('--process-receipt-sha256',required=True);p.add_argument('--request',type=Path,required=True)
    p.add_argument('--request-sha256',required=True);p.add_argument('--apply',action='store_true')
    p.add_argument('--reconcile-loader-failure');p.add_argument('--failed-receipt-sha256')
    args=p.parse_args()
    for value in (args.backend_container_id,args.process_receipt_sha256,args.request_sha256):require(SHA.fullmatch(value),'invalid explicit SHA/ID pin')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}',args.image_id),'invalid image pin')
    require(bool(args.reconcile_loader_failure)==bool(args.failed_receipt_sha256),'both loader reconciliation pins are required')
    if args.reconcile_loader_failure:
        require(re.fullmatch(r'[0-9a-f]{32}',args.reconcile_loader_failure)
                and SHA.fullmatch(args.failed_receipt_sha256),'invalid loader reconciliation pins')
    try:print(json.dumps(cancel(args),indent=2))
    except (ValueError,OSError,BuildControlError) as error:p.exit(2,str(error)+'\n')


if __name__=='__main__':main()
