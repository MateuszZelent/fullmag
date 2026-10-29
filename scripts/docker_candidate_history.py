"""Inspect terminal history in a canonical, unpublished candidate package view."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re

from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture
from docker_dev_recovery_build import inspect_one, require, validate_backend
from docker_volume_reconcile import fingerprint


DONOR_PROBE = r'''
import sys,json,hashlib
from pathlib import Path
sys.path.insert(0,'/opt/fullmag/source/scripts')
import docker_dev_recovery_build as repair
ns=dict(Path=Path,json=json,hashlib=hashlib,require=repair.require,
        validate_terminal=repair.validate_terminal,validate_diagnostic_build=repair.validate_diagnostic_build)
exec(repair.RUNTIME,ns)
paths=ns['runtime'].canonical_paths()
request={'diagnostic_api_only':True,
 'process_receipt_sha256':hashlib.sha256(ns['read'](ns['runtime'].process_receipt_path(paths))).hexdigest(),
 'owner_sha256':hashlib.sha256(ns['read'](ns['runtime'].runtime_services_root(paths)/'OWNER.json')).hexdigest()}
candidate_request=json.loads(sys.argv[1])
backend=ns['backend']
p=backend.PACKAGE_ROOT/'.development'/'candidates'/candidate_request['candidate']
backend._validate_candidate_marker(p,backend.PACKAGE_ROOT,Path('/build'),state='ready')
_,raw,_=backend._validated_package(p,'pinned diagnostic candidate',exclude_candidate_marker=True)
repair.require(hashlib.sha256(raw).hexdigest()==candidate_request['receipt_sha256'],'Candidate receipt changed')
evidence=ns['pinned_evidence'](request,paths)
evidence['linux_probe_sha256']=hashlib.sha256(Path('/state/.linux-native-probe.json').read_bytes()).hexdigest()
print(json.dumps(evidence,sort_keys=True))
'''

STORE_VALIDATION = r'''
def validate_store_changes(changes, writer):
 if any(row['path']!='WRITER.owner.json' for row in changes):
  raise ValueError('Native diagnostic changed retained scientific store bytes')
 if changes and (writer.get('schema')!='fullmag.writer.v1' or writer.get('released') is not True):
  raise ValueError('Diagnostic writer advisory record is not released')
 return changes
'''

RUNTIME = STORE_VALIDATION + r'''
import ctypes,hashlib,json,os,re,subprocess,sys,types
from pathlib import Path
sys.path.insert(0,'/opt/fullmag')
import backend_dev as backend
request=json.loads(sys.argv[1])
def require(condition,message):
 if not condition:raise RuntimeError(message)
driver=ctypes.CDLL('libcuda.so.1')
kernel=Path('/proc/sys/kernel/osrelease').read_text().strip()
driver_nodes=sorted(p.name for p in Path('/dev').iterdir() if re.fullmatch(r'nvidia[0-9]+|dxg',p.name))
Path('/evidence/driver-environment.json').write_text(json.dumps({'kernel':kernel,'driver_nodes':driver_nodes,'driver_library_loaded':True},indent=2)+'\n')
require(not driver_nodes or (driver_nodes==['dxg'] and 'microsoft' in kernel.lower()),
        'Unexpected driver device topology for the read-only WSL diagnostic')
package=Path('/opt/fullmag/package')
require(backend.PACKAGE_ROOT==package,'Package path is not canonical')
require(backend.PROVENANCE_PATH==Path('/opt/fullmag/control/backend/runtime-provenance.json'),'Provenance path is not canonical')
receipt,raw,_=backend._validated_package(package,'candidate diagnostic package',exclude_candidate_marker=True)
require(hashlib.sha256(raw).hexdigest()==request['candidate_receipt_sha256'],'Candidate receipt changed')
backend._publish_runtime_provenance(package)
probe_source=request['storage_probe_source']
require(hashlib.sha256(probe_source.encode()).hexdigest()==request['storage_probe_sha256'],'Storage probe source differs')
probe=types.ModuleType('candidate_linux_native_probe')
exec(compile(probe_source,'linux_native_probe.py','exec'),probe.__dict__)
probe_evidence=probe.run(True,evidence_path=Path('/evidence/linux-native-probe.json'))
require(json.loads(Path('/state/.linux-native-probe.json').read_bytes())==probe_evidence,
        'Private diagnostic probe mount does not expose its genuine evidence')
store=Path('/state/runs/docker-all/session-store')
config=Path('/opt/fullmag/runtime-control/runtime-service/docker-all.json')
def sha(path):
 return backend._sha256_file(path,'candidate history retained file',1024**3)[0]
def inventory():
 records={};total=0
 for current,dirs,files in os.walk(store,followlinks=False):
  if Path(current)==store:dirs[:]=[name for name in dirs if name!='runtime-services']
  require(not any((Path(current)/name).is_symlink() for name in dirs),'Store directory contains a symlink')
  for name in files:
   path=Path(current)/name
   require(not path.is_symlink() and path.is_file(),'Store file is not a regular non-link file')
   total+=path.stat().st_size
   require(len(records)<32768 and total<=1024**3,'Diagnostic inventory exceeds bounds')
   records[path.relative_to(store).as_posix()]=sha(path)
 return records
before=inventory()
Path('/evidence/store-before.json').write_text(json.dumps(before,sort_keys=True)+'\n')
config_sha=sha(config)
ids=sorted(path.name for path in (store/'runs').iterdir())
require(0<len(ids)<=128,'Run inventory exceeds bounds')
rows=[]
def command(digest,run):
 return [str(package/'bin/fullmag-bin'),'runtime','service-inspect-terminal-run',
         '--config',str(config),'--config-sha256',digest,'--run-id',run]
for run in ids:
 result=subprocess.run(command(config_sha,run),capture_output=True,text=True,timeout=30)
 row={'run_id':run,'exit_code':result.returncode,'stdout':result.stdout,'stderr':result.stderr}
 if result.returncode==0:
  value=json.loads(result.stdout)
  require(value['run_id']==run and value['mutations_applied'] is False and value['solve_replayed'] is False,'Native evidence identity differs')
  row['pin']={'run_id':run,'run_intent_sha256':before['runs/'+run+'/run_intent.json'],
   'run_catalog_sha256':before['runs/'+run+'/run_catalog.json'],
   'terminal_evidence_sha256':value['terminal_evidence_sha256']}
 rows.append(row)
 print(run,result.returncode,flush=True)
negative=[]
for name,digest,run,expected in [
 ('wrong-config','0'*64,ids[0],'terminal evidence configuration differs'),
 ('missing-run',config_sha,'run-missing-terminal-evidence','terminal evidence requires a durable run catalog'),
 ('unsafe-run',config_sha,'../escape','invalid repository identifier')]:
 result=subprocess.run(command(digest,run),capture_output=True,text=True,timeout=30)
 negative.append({'case':name,'exit_code':result.returncode,'stderr':result.stderr,
  'expected_gate_reached':result.returncode!=0 and expected in result.stderr})
after=inventory()
Path('/evidence/store-after.json').write_text(json.dumps(after,sort_keys=True)+'\n')
changes=[{'path':name,'before':before.get(name),'after':after.get(name)} for name in sorted(set(before)|set(after)) if before.get(name)!=after.get(name)]
Path('/evidence/native-observations.json').write_text(json.dumps({'observations':rows,'negative_checks':negative,'store_changes':changes},indent=2)+'\n')
writer={}
if changes:
 require((store/'WRITER.owner.json').stat().st_size<=65536,'Writer advisory record exceeds bounds')
 writer=json.loads((store/'WRITER.owner.json').read_bytes())
validate_store_changes(changes,writer)
require(config_sha==sha(config),'Native diagnostic changed runtime config')
passed=all(row['exit_code']==0 for row in rows) and all(row['expected_gate_reached'] for row in negative)
report={'schema':'fullmag.candidate-terminal-history-diagnostics.v1',
 'state':'passed' if passed else 'history-not-fully-proven','build_attempt':request['build_attempt'],
 'candidate_receipt_sha256':request['candidate_receipt_sha256'],'source':receipt['source'],
 'run_count':len(rows),'passed_runs':sum(row['exit_code']==0 for row in rows),
 'observations':rows,'negative_checks':negative,'unchanged_store_files':len(before)-len(changes),'technical_writer_changes':changes,
 'recovery_pins':[row['pin'] for row in rows] if passed else None,
 'recovery_applied':False,'new_solve':False,'package_promoted':False,
 'driver_library_loaded':True,'driver_nodes':driver_nodes,'kernel':kernel}
Path('/evidence/result.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k not in {'observations','negative_checks','recovery_pins','source'}}),flush=True)
'''


def volume_subpath(actual,target):
    rows=[m for m in actual['HostConfig']['Mounts'] if m.get('Target')==target]
    require(len(rows)==1,'Declared volume mount is missing or duplicated: '+target)
    value=rows[0].get('VolumeOptions',{}).get('Subpath','')
    require(isinstance(value,str) and (not value or re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*',value))
            and not any(part in {'.','..'} for part in value.split('/')),'Unsafe donor volume subpath')
    return value


def diagnostic_mounts(actual, volume, root, candidate):
    """Only the candidate and private provenance are overlaid; never mount /build."""
    require(re.fullmatch(r'\.backend-package-candidate-[A-Za-z0-9._-]+',candidate), 'Unsafe candidate subpath')
    require(re.fullmatch(r'candidate-history/attempts/[0-9a-f]{32}',root), 'Unsafe diagnostic control subpath')
    allowed={'/state','/user-data','/host-ledger','/run/fullmag/linux-native-host.json',
             '/opt/fullmag/runtime-control','/state/runs/docker-all/session-store/runtime-services'}
    mounts=[]
    for target in sorted(allowed):
        rows=[m for m in actual['Mounts'] if m.get('Destination')==target]
        require(len(rows)==1,'Required diagnostic mount is missing or duplicated: '+target)
        mount=rows[0]
        source=mount.get('Name') if mount.get('Type')=='volume' else mount.get('Source')
        require(mount.get('Type') in {'volume','bind'} and isinstance(source,str)
                and ',' not in source and '\n' not in source,'Unsafe diagnostic source')
        access='' if target in {'/state','/host-ledger'} else ',readonly'
        options=''
        if mount['Type']=='volume':
            subpath=volume_subpath(actual,target)
            options=',volume-nocopy'+(',volume-subpath='+subpath if subpath else '')
        mounts.append('type='+mount['Type']+',src='+source+',dst='+target+access+options)
    packages=[m for m in actual['Mounts'] if m.get('Destination')=='/opt/fullmag/package']
    require(len(packages)==1 and packages[0].get('Type')=='volume','A named package volume is required')
    base=volume_subpath(actual,'/opt/fullmag/package')
    candidate_subpath=(base+'/' if base else '')+'.development/candidates/'+candidate
    mounts.extend([
        'type=volume,src='+packages[0]['Name']+',dst=/opt/fullmag/package,readonly,volume-nocopy,volume-subpath='+candidate_subpath,
        'type=volume,src='+volume+',dst=/opt/fullmag/control,readonly',
        'type=volume,src='+volume+',dst=/opt/fullmag/control/backend,volume-nocopy,volume-subpath='+root+'/backend',
        'type=volume,src='+volume+',dst=/evidence,volume-nocopy,volume-subpath='+root,
        'type=volume,src='+volume+',dst=/state/.linux-native-probe.json,readonly,volume-nocopy,volume-subpath='+root+'/linux-native-probe.json',
    ])
    return mounts


def run(args):
    from docker_dev import _select_source,_compose_identity
    selected,layout=_select_source(Path(args.source_root),args.source_root)
    identity=_compose_identity(layout)
    for value,pattern in [(args.backend_container_id,r'[0-9a-f]{64}'),(args.image_id,r'sha256:[0-9a-f]{64}'),
                          (args.build_attempt,r'[0-9a-f]{32}'),(args.candidate_receipt_sha256,r'[0-9a-f]{64}')]:
        require(re.fullmatch(pattern,value),'Full immutable diagnostic pins are required')
    control=BuildControl(identity,args.image_id);control.prepare()
    actual=inspect_one('container',args.backend_container_id)
    validate_backend(actual,identity,args.backend_container_id,args.image_id)
    build=control.read('recovery-build/attempts/'+args.build_attempt+'/terminal.json')
    result=control.read('recovery-build/attempts/'+args.build_attempt+'/result.json')
    require(build.get('schema')=='fullmag.docker-build-operation.v1' and build.get('phase')=='recovery-build'
            and build.get('state')=='succeeded' and build.get('compose_project')==control.project
            and build.get('inputs',{}).get('backend_container_id')==args.backend_container_id
            and build['inputs'].get('source_root')==str(selected)
            and build['inputs'].get('image_id')==args.image_id,'Build authority differs')
    require(build.get('candidate')==result,'Candidate result differs from its terminal build authority')
    candidate=Path(result.get('candidate',''))
    require(candidate.parent==Path('/opt/fullmag/package/.development/candidates')
            and re.fullmatch(r'\.backend-package-candidate-[A-Za-z0-9._-]+',candidate.name)
            and result.get('state')=='ready' and result.get('package_promoted') is False
            and result.get('runtime_started') is False and result.get('receipt_sha256')==args.candidate_receipt_sha256,
            'Exact ready unpublished candidate required')
    def donor():
        return json.loads(docker_capture('exec',args.backend_container_id,'/usr/local/bin/python3','-B','-c',DONOR_PROBE,json.dumps({'candidate':candidate.name,'receipt_sha256':args.candidate_receipt_sha256})).stdout)
    before=donor();original=fingerprint(actual)
    probe_source=(selected/'docker/all-in-one/linux_native_probe.py').read_text()
    inputs={key:getattr(args,key) for key in ('backend_container_id','image_id','build_attempt','candidate_receipt_sha256')}
    inputs.update(source_root=str(selected),controller_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  runtime_controller_sha256=hashlib.sha256(RUNTIME.encode()).hexdigest(),
                  storage_probe_sha256=hashlib.sha256(probe_source.encode()).hexdigest())
    with control.operation('candidate-history',inputs) as operation:
        root=operation['root']
        control.write(root+'/donor-before.json',before)
        control.write(root+'/linux-native-probe.json',{})
        control.write(root+'/backend/scope.json',{'schema':'fullmag.candidate-history-scope.v1',**inputs})
        mounts=diagnostic_mounts(actual,control.volume,root,candidate.name)
        control.write(root+'/mounts.json',{'mounts':mounts,'source_root':str(selected)})
        fresh=inspect_one('container',args.backend_container_id)
        require(fingerprint(fresh)==original and donor()==before,'Donor changed before candidate diagnostic')
        command=['run','--rm','--pull','never','--network','none','--runtime','nvidia',
                 '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true',
                 '--pids-limit','64','--memory',str(actual['HostConfig']['Memory']),
                 '--cpus',str(actual['HostConfig']['NanoCpus']/1e9),
                 '--label','com.docker.compose.project='+control.project,
                 '--label','com.docker.compose.service=host-runtime-maintenance',
                 '--name','fullmag-candidate-history-'+operation['receipt']['attempt']]
        for mount in mounts:command+=['--mount',mount]
        for item in actual['Config'].get('Env',[]):
            key=item.split('=',1)[0]
            if key.startswith('FULLMAG_') and not any(word in key for word in ('TOKEN','SECRET','PASSWORD','KEY')):
                command+=['--env',item]
        command+=['--env','NVIDIA_VISIBLE_DEVICES=none','--env','NVIDIA_DRIVER_CAPABILITIES=compute,utility',
                  '--env','FULLMAG_DOCKER_DEVICE_ACCESS=cpu','--entrypoint','/usr/local/bin/python3',args.image_id,
                  '-B','-c',RUNTIME,json.dumps(dict(inputs,storage_probe_source=probe_source))]
        operation['daemon_pending']=True
        completed=docker_capture(*command,timeout=300,allow_failure=True)
        operation['logger'].stdin.write(completed.stdout+completed.stderr);operation['logger'].stdin.flush()
        operation['daemon_pending']=False
        require(fingerprint(inspect_one('container',args.backend_container_id))==original and donor()==before,
                'Donor changed during candidate diagnostic')
        control.write(root+'/donor-retention.json',{'state':'unchanged','pins':before})
        require(completed.returncode==0,'Candidate diagnostic failed: '+completed.stderr.decode(errors='replace')[-4096:])
        report=control.read(root+'/result.json')
        operation['receipt'].update(state='succeeded',image_id=args.image_id,
            diagnostic_state=report['state'],passed_runs=report['passed_runs'],run_count=report['run_count'])
        print(json.dumps({'state':report['state'],'passed_runs':report['passed_runs'],'run_count':report['run_count'],
                          'evidence':root+'/result.json','donor_unchanged':True}))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root',required=True)
    parser.add_argument('--backend-container-id',required=True)
    parser.add_argument('--image-id',required=True)
    parser.add_argument('--build-attempt',required=True)
    parser.add_argument('--candidate-receipt-sha256',required=True)
    try:run(parser.parse_args())
    except (BuildControlError,ValueError,OSError) as error:parser.exit(2,str(error)+'\n')

if __name__=='__main__':main()
