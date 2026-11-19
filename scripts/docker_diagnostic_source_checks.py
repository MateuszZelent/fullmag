"""Admit source-only checks in a pre-owner, execution-fenced DEV backend."""
from __future__ import annotations
import json
import re
import uuid
from docker_build_control import BuildControlError, docker_capture

SCHEMA = 'fullmag.pre-owner-diagnostic-source-check.v1'
PROBE = r'''import hashlib,json,os,pathlib,re,sys,urllib.request,uuid
sys.path.insert(0,'/opt/fullmag')
import runtime_service as runtime
paths=runtime.canonical_paths()
def read(path,label,maximum=1024*1024):
    raw=runtime._bounded_regular(path,label,maximum)
    if raw!=runtime._bounded_regular(path,label,maximum): raise RuntimeError(label+' changed')
    return raw
owner=paths.store/'runtime-services/OWNER.json'
receipt=runtime.process_receipt_path(paths)
if os.path.lexists(owner) or os.path.lexists(receipt):
    raise RuntimeError('Source-only diagnostic admission requires no native owner or process receipt')
rows=[]
for path in pathlib.Path('/proc').iterdir():
    if not path.name.isdigit(): continue
    try:
        raw=(path/'cmdline').read_bytes()
        if len(raw)>65536: raise RuntimeError('process command exceeds bound')
        argv=[value.decode() for value in raw.split(b'\0') if value]
        stat=(path/'stat').read_text().rsplit(')',1)[1].split()
        rows.append((int(path.name),int(stat[1]),os.readlink(path/'exe'),argv))
    except FileNotFoundError: pass
if len(rows)>256: raise RuntimeError('process inventory exceeds bound')
supervisors=[row for row in rows if '/opt/fullmag/entrypoint.py' in row[3]]
apis=[row for row in rows if row[2].endswith('/fullmag-api')]
if len(supervisors)!=1 or len(apis)!=1: raise RuntimeError('diagnostic process identity is ambiguous')
supervisor,api=supervisors[0],apis[0]
if supervisor[1]!=1 or api[1]!=supervisor[0]: raise RuntimeError('diagnostic process parent differs')
allowed={1,supervisor[0],api[0],os.getpid()}
if any(row[0] not in allowed and '/opt/fullmag/healthcheck.py' not in row[3] for row in rows):
    raise RuntimeError('unexpected process in diagnostic backend')
environment=(pathlib.Path('/proc')/str(api[0])/'environ').read_bytes()
if len(environment)>1024*1024: raise RuntimeError('environment exceeds bound')
fences=[item.split(b'=',1)[1].decode() for item in environment.split(b'\0')
        if item.startswith(b'FULLMAG_API_RUNTIME_FAILURE_FENCE=')]
if len(fences)!=1: raise RuntimeError('API must bind exactly one runtime fence')
fence_path=pathlib.Path(fences[0])
if (fence_path.parent!=receipt.parent or
        re.fullmatch(r'api-failure-[0-9a-f]{32}\.json',fence_path.name) is None):
    raise RuntimeError('failure fence is outside canonical control storage')
fence_raw=read(fence_path,'runtime startup fence',256*1024)
fence=json.loads(fence_raw)
if (fence.get('schema')!='fullmag.api-runtime-failure-fence.v1' or
        fence.get('stage')!='runtime_startup' or
        not str(fence.get('reason','')).startswith('native Docker host profile initialization failed:')):
    raise RuntimeError('API is not fenced before native host initialization')
ledger_root=runtime.HOST_LEDGER_ROOT
if os.path.lexists(paths.config):
    config=json.loads(read(paths.config,'runtime configuration',256*1024))
    if config.get('host_execution',{}).get('ledger_root')!=str(ledger_root):
        raise RuntimeError('runtime configuration uses a noncanonical ledger')
ledger=ledger_root/'HOST_RESOURCE_LEDGER.json'
if os.path.lexists(ledger):
    value=json.loads(read(ledger,'group ledger',4*1024*1024))
    if (value.get('schema_version')!='host_resource_ledger.v4' or
            not isinstance(value.get('reservations'),list) or
            any(item.get('state')!='released' for item in value['reservations'])):
        raise RuntimeError('active or unknown group reservation')
leases=list((paths.store/'runs').glob('*/resource_leases/*/*.json'))
if len(leases)>10000: raise RuntimeError('lease inventory exceeds bound')
for path in leases:
    value=json.loads(read(path,'local lease',256*1024))
    if value.get('state')!='released' or not value.get('released_at'):
        raise RuntimeError('active or unknown local lease')
with urllib.request.urlopen('http://127.0.0.1:8081/v2/platform/health',timeout=10) as response:
    raw=response.read(256*1024+1)
    if len(raw)>256*1024: raise RuntimeError('health response exceeds bound')
    health=json.loads(raw)
    instance=response.headers.get('x-fullmag-api-instance')
if str(uuid.UUID(instance))!=instance: raise RuntimeError('API incarnation is invalid')
if os.path.lexists(owner) or os.path.lexists(receipt) or read(fence_path,'runtime startup fence',256*1024)!=fence_raw:
    raise RuntimeError('diagnostic authority changed during admission')
print(json.dumps({'schema':'fullmag.pre-owner-diagnostic-source-check.v1',
    'api_instance_id':instance,'fence_sha256':hashlib.sha256(fence_raw).hexdigest(),
    'owner_absent':True,'process_receipt_absent':True,'native_processes':0,
    'active_reservations':0,'active_local_leases':0,
    'api_health':health.get('status'),'active_session':health.get('active_session')}))
'''

def validate_diagnostic_evidence(value):
    if not isinstance(value,dict) or value.get('schema')!=SCHEMA:
        raise BuildControlError('Unrecognized diagnostic source-check evidence')
    for field in ('owner_absent','process_receipt_absent'):
        if value.get(field) is not True:
            raise BuildControlError('Diagnostic source checks require '+field)
    for field in ('native_processes','active_reservations','active_local_leases'):
        if type(value.get(field)) is not int or value[field]!=0:
            raise BuildControlError('Diagnostic source checks require zero '+field)
    if value.get('api_health')!='degraded' or value.get('active_session') is not False:
        raise BuildControlError('Diagnostic API is not empty and execution-fenced')
    if not isinstance(value.get('fence_sha256'),str) or not re.fullmatch('[0-9a-f]{64}',value['fence_sha256']):
        raise BuildControlError('Diagnostic failure fence is not pinned')
    try:
        if str(uuid.UUID(value['api_instance_id']))!=value['api_instance_id']: raise ValueError('incarnation')
    except (KeyError,ValueError,TypeError,AttributeError) as error:
        raise BuildControlError('Diagnostic API incarnation is not pinned') from error
    return value

def admit_diagnostic_source_checks(backend, document, expected_volume):
    mounts={item.get('Destination'):item for item in document.get('Mounts',[])}
    for target in ('/build','/opt/fullmag/control','/host-ledger'):
        mount=mounts.get(target,{})
        if mount.get('Type')!='volume' or mount.get('Name')!=expected_volume:
            raise BuildControlError('Diagnostic source checks require the exact group volume at '+target)
    result=docker_capture('exec',backend,'/usr/local/bin/python3','-B','-c',PROBE,timeout=60)
    try:
        return validate_diagnostic_evidence(json.loads(result.stdout.decode('utf-8')))
    except (ValueError,UnicodeError) as error:
        raise BuildControlError('Invalid diagnostic source-check probe response') from error
