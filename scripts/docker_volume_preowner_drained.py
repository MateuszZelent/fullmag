"""Stop one cold API-only DEV incarnation while preserving its old native drain.

This helper never recovers or drains a native owner. It authenticates the
historical drain through the supplied terminal-observation proof, then records
one separate Docker-only stop of the exact current backend/frontend pair.
"""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import re
import shlex
from collections.abc import Mapping

import fullmag_storage as storage
from docker_build_control import (
    BuildControl,
    BuildControlError,
    bounded_capture,
    canonical,
    docker_capture,
)
from docker_volume_reconcile import fingerprint


SCHEMA = "fullmag.docker-preowner-drained-stop.v1"
INTENT_SCHEMA = "fullmag.docker-preowner-drained-stop-intent.v1"
PROOF_SCHEMA = "fullmag.development-terminal-observation-proof.v1"
REFUSAL = "stored host resource policy differs from explicit ledger configuration"
GIB = 1024 ** 3
MAX_RECORD_BYTES = 8 * 1024 * 1024
MAX_PROBE_BYTES = 256 * 1024
SHA = re.compile(r"[0-9a-f]{64}\Z")
ATTEMPT = re.compile(r"[0-9a-f]{32}\Z")
CONTAINER = re.compile(r"[0-9a-f]{64}\Z")
IMAGE = re.compile(r"sha256:[0-9a-f]{64}\Z")
OWNER_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


def _require(value, message):
    if not value:
        raise BuildControlError("Pre-owner drained stop: " + message)


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _json(raw: bytes, label: str, *, maximum=MAX_RECORD_BYTES) -> dict:
    if not isinstance(raw, bytes) or not 0 < len(raw) <= maximum:
        _require(False, label + " is absent or exceeds its byte bound")

    def unique(pairs):
        result = {}
        for key, value in pairs:
            _require(key not in result, label + " contains a duplicate JSON key")
            result[key] = value
        return result

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique,
                           parse_constant=lambda _: _require(False, label + " contains non-finite JSON"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError(label + " is not valid UTF-8 JSON") from error
    _require(isinstance(value, dict), label + " is not an object")
    return value


def _read(control, relative, *, optional=False, maximum=MAX_RECORD_BYTES):
    raw = control.read_bytes(relative, optional=optional, maximum=maximum, timeout=90)
    if raw is None:
        return None, None
    return raw, _json(raw, "Control record " + relative, maximum=maximum)


def _record(control, relative, *, expected=None, canonical_record=False, optional=False):
    raw, value = _read(control, relative, optional=optional)
    if raw is None:
        return None, None, None
    digest = _sha(raw)
    _require(expected is None or digest == expected, "Control record digest differs: " + relative)
    if canonical_record:
        _require(raw == canonical(value) + b"\n", "Control record is not canonical JSON plus LF: " + relative)
    return raw, value, digest


class PreownerDrainedContext(dict):
    """Typed pointer to a Docker-only stop journal, not native recovery authority."""

    REQUIRED = {
        "journal_relative", "journal_sha256", "source_proof_sha256",
        "original_stop_attempt", "source_stop_sha256",
    }

    def __init__(self, metadata):
        _require(isinstance(metadata, Mapping) and set(metadata) == self.REQUIRED,
                 "retained context metadata fields differ")
        super().__init__(metadata)


_COLD_PROBE = r'''import hashlib,json,os,pathlib,re,stat,urllib.error,urllib.request,uuid
MAX=1048576
OWNER='/opt/fullmag/runtime-control/runtime-services/OWNER.json'
PROCESS='/opt/fullmag/runtime-control/runtime-service/process-tree.json'
CONFIG='/opt/fullmag/runtime-control/runtime-service/docker-all.json'

def fail(message): raise RuntimeError(message)
def unique(pairs):
 d={}
 for k,v in pairs:
  if k in d: fail('duplicate JSON field')
  d[k]=v
 return d
def read(path,limit=MAX):
 p=pathlib.Path(path)
 for parent in (p,*p.parents):
  try:
   if parent.is_symlink(): fail('evidence traverses symlink')
  except OSError: fail('evidence parent cannot be inspected')
 fd=os.open(p,os.O_RDONLY|getattr(os,'O_CLOEXEC',0)|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0))
 try:
  a=os.fstat(fd)
  if not stat.S_ISREG(a.st_mode) or a.st_nlink!=1 or a.st_size>limit: fail('evidence is not a bounded regular file')
  data=bytearray()
  while len(data)<=limit:
   chunk=os.read(fd,min(65536,limit+1-len(data)))
   if not chunk: break
   data.extend(chunk)
  b=os.fstat(fd); c=os.stat(p,follow_symlinks=False)
  identity=lambda x:(x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns)
  if (len(data)!=a.st_size or len(data)>limit or a.st_nlink!=1 or b.st_nlink!=1 or c.st_nlink!=1
      or not stat.S_ISREG(b.st_mode) or not stat.S_ISREG(c.st_mode)
      or identity(a)!=identity(b) or identity(a)!=identity(c)):
   fail('evidence changed while being read')
  return bytes(data)
 finally: os.close(fd)
def obj(path,limit=MAX):
 try: value=json.loads(read(path,limit),object_pairs_hook=unique)
 except (UnicodeDecodeError,json.JSONDecodeError) as e: fail('invalid JSON evidence: '+str(e))
 if not isinstance(value,dict): fail('evidence is not an object')
 return value
def proc(pid):
 p=pathlib.Path('/proc')/str(pid)
 statline=(p/'stat').read_text()
 tail=statline[statline.rfind(')')+2:].split()
 return {'pid':pid,'ppid':int(tail[1]),'start_ticks':int(tail[19]),
         'exe':os.readlink(p/'exe'),'argv':[x.decode() for x in (p/'cmdline').read_bytes().split(bytes([0])) if x]}
def proc_environ(pid):
 # Procfs reports st_size=0 for this bounded kernel-generated stream. Pin the
 # process identity across the read instead of using the regular-file reader.
 before=proc(pid)
 fd=os.open('/proc/'+str(pid)+'/environ',os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  if not stat.S_ISREG(os.fstat(fd).st_mode): fail('process environment is not a regular procfs stream')
  data=bytearray()
  while len(data)<=MAX:
   chunk=os.read(fd,min(65536,MAX+1-len(data)))
   if not chunk: break
   data.extend(chunk)
  if len(data)>MAX: fail('process environment exceeds bound')
 finally: os.close(fd)
 if proc(pid)!=before: fail('API process identity changed while reading its environment')
 return bytes(data)
rows=[]
for item in pathlib.Path('/proc').iterdir():
 if item.name.isdigit():
  try: rows.append(proc(int(item.name)))
  except FileNotFoundError: pass
 if len(rows)>32: fail('process inventory exceeds its bound')
init=[p for p in rows if p['pid']==1]
entry=[p for p in rows if '/opt/fullmag/entrypoint.py' in p['argv']]
api=[p for p in rows if p['exe'].endswith('/fullmag-api')]
probe=[p for p in rows if p['pid']==os.getpid()]
health_processes=[p for p in rows if p['ppid']==0 and pathlib.Path(p['exe']).name.startswith('python3')
        and p['argv']==['/usr/local/bin/python3','/opt/fullmag/healthcheck.py']]
if (len(init)!=1 or len(entry)!=1 or len(api)!=1 or len(probe)!=1
    or pathlib.Path(init[0]['exe']).name not in {'tini','docker-init'}
    or entry[0]['ppid']!=1 or api[0]['ppid']!=entry[0]['pid']
    or entry[0]['argv']!=['/usr/local/bin/python3','/opt/fullmag/entrypoint.py']
    or api[0]['argv']!=[api[0]['exe']] or len(health_processes)>1
    or {p['pid'] for p in rows}!={1,entry[0]['pid'],api[0]['pid'],os.getpid(),*(p['pid'] for p in health_processes)}):
 fail('cold namespace is not exactly tini, entrypoint, API, probe and optional image healthcheck')
if not pathlib.Path('/proc/1').exists(): fail('container init disappeared')
owner=obj(OWNER); process=obj(PROCESS); config_raw=read(CONFIG)
if (owner.get('schema_version')!='runtime_service_owner.v1' or owner.get('state')!='drained'
    or process.get('schema')!='fullmag.docker-process-tree.v1' or process.get('state')!='drained'):
 fail('historical native records are not drained')
old_pids=[owner.get('pid')]+[child.get('pid') for child in owner.get('children',[])]
if (len(old_pids)!=3 or any(type(pid) is not int or pid<=0 for pid in old_pids)
    or any(pathlib.Path('/proc',str(pid)).exists() for pid in old_pids)):
 fail('historical native owner process is present or ambiguous')
if process.get('terminal_service_owner',{}).get('state')!='drained': fail('terminal native owner differs')
environ=proc_environ(api[0]['pid'])
fences=[x.split(b'=',1)[1].decode() for x in environ.split(bytes([0]))
        if x.startswith(b'FULLMAG_API_RUNTIME_FAILURE_FENCE=')]
if (len(fences)!=1 or re.fullmatch('/opt/fullmag/runtime-control/runtime-service/api-failure-[0-9a-f]{32}[.]json',fences[0]) is None):
 fail('API has no exact startup failure fence')
fence=obj(fences[0])
if (fence.get('schema')!='fullmag.api-runtime-failure-fence.v1' or fence.get('stage')!='runtime_startup'
    or any(k in fence for k in ('api_pid','api_instance_id','runtime_pid','owner_pid','current_owner_token'))):
 fail('API fence records a live owner or another startup stage')
reason=fence.get('reason','')
prefix='native Docker host profile initialization failed: native runtime service failed: Docker host ledger rejected probed_policy='
suffix=': stored host resource policy differs from explicit ledger configuration'
if not isinstance(reason,str) or not reason.startswith(prefix): fail('failure fence is not the host-policy refusal')
policy,end=json.JSONDecoder().raw_decode(reason[len(prefix):])
if reason[len(prefix)+end:].strip()!=suffix: fail('failure fence refusal suffix differs')
def get(path):
 request=urllib.request.Request('http://127.0.0.1:8081'+path,headers={'Host':'localhost','Accept':'application/json','Connection':'close'})
 try:
  with urllib.request.urlopen(request,timeout=5) as response:
   headers=response.getheaders(); raw=response.read(MAX+1)
   if len(raw)>MAX: fail('API response exceeds its bound')
   ids=[v.strip() for k,v in headers if k.lower()=='x-fullmag-api-instance']
   if len(ids)!=1: fail('API response instance header is ambiguous')
   uuid.UUID(ids[0]); return response.status,ids[0],json.loads(raw,object_pairs_hook=unique)
 except urllib.error.HTTPError as e:
  raw=e.read(65537); headers=e.headers
  ids=headers.get_all('x-fullmag-api-instance') or []
  if len(raw)>65536 or len(ids)!=1: fail('API error response identity is ambiguous')
  uuid.UUID(ids[0]); return e.code,ids[0],json.loads(raw,object_pairs_hook=unique)
health_code,health_id,health=get('/v2/platform/health')
current_code,current_id,current=get('/v2/sessions/current/status')
if (health_code!=200 or health_id!=current_id or health.get('status')!='degraded'
    or health.get('active_session') is not False or current_code!=503
    or current.get('code')!='runtime_unavailable' or current.get('message')!='Runtime startup failed; API diagnostics remain available and execution is disabled.'):
 fail('API is not the exact cold degraded/no-session diagnostic instance')
proc_material=sorted((p['pid'],p['ppid'],p['start_ticks'],pathlib.Path(p['exe']).name)
                    for p in rows if p['pid']!=os.getpid() and p not in health_processes)
relative=fences[0].removeprefix('/opt/fullmag/')
print(json.dumps({'schema':'fullmag.preowner-cold-api-probe.v1','processes':proc_material,
 'processes_sha256':hashlib.sha256(json.dumps(proc_material,separators=(',',':')).encode()).hexdigest(),
 'probe_present':True,
 'api_instance_sha256':hashlib.sha256(health_id.encode()).hexdigest(),
 'health_status':health_code,'health_state':health['status'],'active_session':False,
 'current_status':current_code,'failure_reason':reason,'requested_policy':policy,
 'failure_fence_relative':relative,'failure_fence_sha256':hashlib.sha256(read(fences[0])).hexdigest(),
 'owner_sha256':hashlib.sha256(read(OWNER)).hexdigest(),
 'process_tree_sha256':hashlib.sha256(read(PROCESS)).hexdigest(),
 'native_config_sha256':hashlib.sha256(config_raw).hexdigest(),
 'current_owner_pids_absent':True},sort_keys=True,separators=(',',':')))
'''


_OWNER_LOCK_PROBE = r'''import fcntl,hashlib,json,os,stat
import pathlib
path='/control/runtime-control/runtime-services/OWNER.lock'
for parent in (pathlib.Path(path),*pathlib.Path(path).parents):
 if parent.is_symlink(): raise RuntimeError('OWNER.lock traverses a symlink')
before=os.stat(path,follow_symlinks=False)
if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1: raise RuntimeError('OWNER.lock inode is not private')
fd=os.open(path,os.O_RDWR|getattr(os,'O_CLOEXEC',0)|getattr(os,'O_NOFOLLOW',0))
try:
 opened=os.fstat(fd)
 identity=(before.st_dev,before.st_ino)
 if not stat.S_ISREG(opened.st_mode) or opened.st_nlink!=1 or (opened.st_dev,opened.st_ino)!=identity:
  raise RuntimeError('OWNER.lock changed before open')
 fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 held=os.fstat(fd); current=os.stat(path,follow_symlinks=False)
 if ((held.st_dev,held.st_ino)!=(current.st_dev,current.st_ino) or (current.st_dev,current.st_ino)!=identity
     or held.st_nlink!=1 or current.st_nlink!=1): raise RuntimeError('OWNER.lock changed while locked')
 fcntl.flock(fd,fcntl.LOCK_UN)
 current=os.stat(path,follow_symlinks=False)
 if (current.st_dev,current.st_ino)!=identity or current.st_nlink!=1: raise RuntimeError('OWNER.lock changed after unlock')
 print(json.dumps({'schema':'fullmag.preowner-owner-lock-observation.v1',
  'inode_sha256':hashlib.sha256((str(identity[0])+':'+str(identity[1])).encode()).hexdigest(),
  'unlocked':True},sort_keys=True,separators=(',',':')))
finally: os.close(fd)
'''


_LEDGER_PROBE = r'''import fcntl,hashlib,json,os,pathlib,stat
root=pathlib.Path('/ledger/ledger')
def read(path,maximum=8388608):
 fd=os.open(path,os.O_RDONLY|getattr(os,'O_CLOEXEC',0)|getattr(os,'O_NOFOLLOW',0))
 try:
  a=os.fstat(fd)
  if not stat.S_ISREG(a.st_mode) or a.st_nlink!=1 or a.st_size>maximum: raise RuntimeError('ledger record is not bounded regular data')
  raw=bytearray()
  while len(raw)<=maximum:
   chunk=os.read(fd,min(65536,maximum+1-len(raw)))
   if not chunk: break
   raw.extend(chunk)
  b=os.fstat(fd); c=os.stat(path,follow_symlinks=False)
  identity=lambda x:(x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns)
  if len(raw)!=a.st_size or len(raw)>maximum or identity(a)!=identity(b) or identity(a)!=identity(c):
   raise RuntimeError('ledger record changed during read')
  return bytes(raw)
 finally: os.close(fd)
lock=root/'WRITER.lock'; before=os.stat(lock,follow_symlinks=False)
if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1: raise RuntimeError('ledger writer lock is not regular')
fd=os.open(lock,os.O_RDONLY|getattr(os,'O_CLOEXEC',0)|getattr(os,'O_NOFOLLOW',0))
try:
 fcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)
 opened=os.fstat(fd); current=os.stat(lock,follow_symlinks=False)
 if ((opened.st_dev,opened.st_ino)!=(before.st_dev,before.st_ino)
     or (current.st_dev,current.st_ino)!=(before.st_dev,before.st_ino)
     or opened.st_nlink!=1 or current.st_nlink!=1): raise RuntimeError('ledger lock changed')
 def unique(pairs):
  result={}
  for key,value in pairs:
   if key in result: raise RuntimeError('duplicate ledger JSON field')
   result[key]=value
  return result
 raw=read(root/'HOST_RESOURCE_LEDGER.json'); doc=json.loads(raw,object_pairs_hook=unique)
 if doc.get('schema_version')!='host_resource_ledger.v4' or not isinstance(doc.get('policy'),dict): raise RuntimeError('group host ledger schema differs')
 policy=doc['policy']; budget=policy.get('total_budget')
 if not isinstance(budget,dict) or any(type(budget.get(k)) is not int or budget[k]<0 for k in ('cpu_millis','memory_bytes','storage_bytes','gpu_memory_bytes')): raise RuntimeError('group host budget differs')
 print(json.dumps({'schema':'fullmag.preowner-ledger-policy.v1','ledger_sha256':hashlib.sha256(raw).hexdigest(),
  'host_id':policy.get('host_id'),'topology_sha256':policy.get('topology_sha256'),
  'total_budget':budget},sort_keys=True,separators=(',',':')))
finally:
 fcntl.flock(fd,fcntl.LOCK_UN); os.close(fd)
'''


def _inspect(kind, identity):
    rows = json.loads(docker_capture("inspect", "--type", kind, identity, timeout=60).stdout)
    _require(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict),
             "Docker identity is ambiguous: " + kind)
    _require(rows[0].get("Id") == identity, "Docker identity changed: " + kind)
    return rows[0]


def _container_pin(actual):
    state = actual.get("State", {})
    return {
        "container_id": actual.get("Id"),
        "image_id": actual.get("Image"),
        "started_at": state.get("StartedAt"),
        "fingerprint": fingerprint(actual),
    }


def _stopped_state(actual, expected):
    state = actual.get("State", {})
    _require(_container_pin(actual) == expected
             and state.get("Status") == "exited"
             and state.get("Running") is False
             and state.get("Pid") == 0
             and state.get("ExitCode") == 0
             and state.get("OOMKilled") is False,
             "stopped Docker incarnation or exit outcome differs")
    return {
        **_container_pin(actual),
        "status": state.get("Status"),
        "exit_code": state.get("ExitCode"),
        "oom_killed": state.get("OOMKilled"),
    }


def _project_container_ids(project):
    result = set()
    for label in ("com.docker.compose.project", "org.fullmag.compose.project"):
        output = docker_capture("ps", "--all", "--quiet", "--no-trunc",
                                "--filter", "label=" + label + "=" + project,
                                timeout=60).stdout.decode("utf-8", "strict")
        result.update(line.strip() for line in output.splitlines() if line.strip())
    _require(all(CONTAINER.fullmatch(value) for value in result), "project inventory has an invalid container ID")
    return result


def _volume_consumer_ids(volume):
    output = docker_capture("ps", "--all", "--quiet", "--no-trunc",
                            "--filter", "volume=" + volume, timeout=60).stdout.decode("utf-8", "strict")
    values = {line.strip() for line in output.splitlines() if line.strip()}
    _require(all(CONTAINER.fullmatch(value) for value in values), "control-volume inventory has an invalid ID")
    return values


def _assert_group_inventory(control, backend_id, frontend_id):
    operation = getattr(control, "_active_operation", None)
    helper_id = operation.get("helper_container_id") if isinstance(operation, Mapping) else None
    expected = {backend_id, frontend_id}
    if helper_id is not None:
        _require(isinstance(helper_id, str) and CONTAINER.fullmatch(helper_id),
                 "active BuildControl helper identity is invalid")
        expected.add(helper_id)
    _require(_project_container_ids(control.project) == expected,
             "Compose group contains an unexpected container")
    _require(_volume_consumer_ids(control.volume) == expected,
             "control volume has an unexpected consumer")


def _load_parent(control, previous, document, *, selected, attempt, config_sha256, image_id,
                 backend_container_id):
    _require(isinstance(attempt, str) and ATTEMPT.fullmatch(attempt), "parent development attempt is invalid")
    _require(isinstance(config_sha256, str) and SHA.fullmatch(config_sha256), "Compose digest is invalid")
    _require(isinstance(image_id, str) and IMAGE.fullmatch(image_id), "backend image ID is invalid")
    _require(isinstance(backend_container_id, str) and CONTAINER.fullmatch(backend_container_id),
             "backend container ID is invalid")
    root = "development/attempts/" + attempt
    terminal_raw, terminal, _ = _record(control, root + "/terminal.json", canonical_record=True)
    receipt_raw, receipt, _ = _record(control, root + "/receipt.json", canonical_record=True)
    current_raw, _, _ = _record(control, "development/current.json", canonical_record=True)
    compose_raw, stored_document, _ = _record(control, root + "/compose.json", canonical_record=True)
    _require(terminal_raw == receipt_raw == current_raw and terminal == previous,
             "parent failure is not the exact current terminal receipt")
    _require(stored_document == document and document.get("name") == control.project,
             "parent Compose document differs")
    inputs = terminal.get("inputs", {})
    _require(terminal.get("schema") == "fullmag.docker-build-operation.v1"
             and terminal.get("phase") == "development"
             and terminal.get("state") == "failed-confirmed"
             and terminal.get("attempt") == attempt
             and terminal.get("compose_project") == control.project
             and terminal.get("control_volume") == control.volume
             and terminal.get("control_namespace") == control.namespace
             and terminal.get("config_sha256") == config_sha256 == _sha(canonical(document))
             and inputs.get("source_root") == str(selected)
             and inputs.get("image_id") == image_id
             and terminal.get("backend_container") in (None, backend_container_id),
             "parent failed-development scope differs")
    _require(terminal.get("ledger_profile") == "group-ledger-v1"
             and REFUSAL in terminal.get("error", ""),
             "parent development is not the exact cold group-ledger refusal")
    group = terminal.get("worker_cgroup", {})
    _require(group.get("state") == "ready" and group.get("container_id") == backend_container_id
             and group.get("image_id") == image_id and group.get("compose_project") == control.project,
             "parent failure has no exact worker-cgroup proof")
    return root, terminal_raw, compose_raw, terminal


def _terminal_observation_metadata(previous):
    inputs = previous.get("inputs", {})
    values = [value for value in (previous.get("terminal_observation"),
                                  inputs.get("terminal_observation")) if value is not None]
    _require(values and all(isinstance(value, Mapping) for value in values),
             "parent has no terminal-observation authorization metadata")
    _require(all(dict(value) == dict(values[0]) for value in values[1:]),
             "parent terminal-observation metadata copies differ")
    metadata = dict(values[0])
    expected = {"schema", "proof_sha256", "request_sha256", "stop_attempt", "stop_sha256"}
    _require(set(metadata) == expected and metadata.get("schema") == "fullmag.terminal-observation-context.v1",
             "parent terminal-observation metadata shape differs")
    return metadata


def _source_proof(control, selected, previous, proof, proof_sha256, *, proof_path=None):
    _require(isinstance(proof_sha256, str) and SHA.fullmatch(proof_sha256), "source proof digest is invalid")
    relative = "runtime-control/terminal-observation/" + proof_sha256 + "/proof.json"
    if proof_path is not None:
        _require(proof_path == relative, "source proof path is not the exact private namespace path")
    raw, value, _ = _record(control, relative, expected=proof_sha256, canonical_record=True)
    if proof is not None:
        _require(isinstance(proof, Mapping) and dict(proof) == value,
                 "caller source proof differs from the private CAS-pinned proof")
    request_relative = "runtime-control/terminal-observation/" + proof_sha256 + "/request.json"
    request_raw, request, _ = _record(control, request_relative, canonical_record=True)
    expected_request = {"schema": "fullmag.terminal-observation-request.v1",
                        "proof_path": "terminal-observation/" + proof_sha256 + "/proof.json",
                        "proof_sha256": proof_sha256}
    _require(request == expected_request, "source proof request binding differs")
    metadata = _terminal_observation_metadata(previous)
    original_iteration = value.get("original_iteration")
    operation_sha = value.get("operation_sha256")
    _require(metadata.get("proof_sha256") == proof_sha256
             and metadata.get("request_sha256") == _sha(request_raw)
             and metadata.get("stop_attempt") == original_iteration
             and metadata.get("stop_sha256") == operation_sha,
             "parent authorization does not bind this original terminal stop")
    _require(value.get("schema") == PROOF_SCHEMA and isinstance(original_iteration, str)
             and ATTEMPT.fullmatch(original_iteration)
             and isinstance(operation_sha, str) and SHA.fullmatch(operation_sha),
             "source proof schema or original stop pins differ")
    for key in ("compose_project", "control_volume", "source_root"):
        expected = control.project if key == "compose_project" else control.volume if key == "control_volume" else str(selected)
        _require(value.get(key) == expected, "source proof workspace scope differs: " + key)
    _require(isinstance(value.get("image_id"), str) and IMAGE.fullmatch(value["image_id"]),
             "source proof image identity is invalid")
    # The immutable source image is checked against its original drain below;
    # the current target image is bound separately by _load_parent/containers.
    state_root = previous.get("state_root")
    _require(isinstance(state_root, str) and state_root, "parent has no retained state root")
    state = Path(state_root).resolve(strict=True)
    layout = storage.resolve_layout(selected, "docker-all-gpu")
    state = storage.validate_path(state, Path(str(layout["runtime_root"])), "pre-owner retained state")
    store_root = storage.validate_path(state / "runs" / "docker-all" / "session-store",
                                       state, "pre-owner accepted store")
    from docker_volume_accepted_reattach import _read_store_regular
    from docker_volume_terminal_observation import build_proof
    scope = {key: value[key] for key in ("compose_project", "control_volume", "source_root", "image_id")}
    rebuilt = build_proof(
        lambda path: control.read_bytes(path, maximum=MAX_RECORD_BYTES),
        lambda path: _read_store_regular(store_root, path, "pre-owner retained source record",
                                         maximum=MAX_RECORD_BYTES),
        iteration=original_iteration, run_id=value.get("run_id"), scope=scope,
        native_config_sha256=value.get("native_config_sha256"),
        terminal_evidence_sha256=value.get("terminal_evidence_sha256"),
    )
    _require(value == rebuilt, "source proof differs from the retained terminal/catalog evidence")
    preflight_raw, preflight, _ = _record(
        control, "iteration/attempts/" + original_iteration + "/terminal-session-preflight.json",
        canonical_record=True)
    _require(preflight.get("run", {}).get("status") == "completed",
             "source run is not the pinned Completed run")
    return {
        "relative": relative,
        "sha256": proof_sha256,
        "request_relative": request_relative,
        "request_sha256": _sha(request_raw),
        "original_iteration": original_iteration,
        "operation_sha256": operation_sha,
        "preflight_sha256": value["preflight_raw_sha256"],
        "drain_sha256": value["drain_sha256"],
        "native_config_sha256": value["native_config_sha256"],
        "run_id": value["run_id"],
        "catalog_sha256": value["catalog_sha256"],
        "catalog_revision": value["catalog_revision"],
        "request_id": value["source_request_id"],
        "source_sha256": value["source_sha256"],
        "proof": value,
        "state_root": str(state),
        "store_root": str(store_root),
    }


def _native_history(control, source):
    proof = source["proof"]
    attempt = source["original_iteration"]
    root = "iteration/attempts/" + attempt
    operation_raw, operation, operation_sha = _record(control, root + "/terminal.json", canonical_record=True)
    receipt_raw, _, _ = _record(control, root + "/receipt.json", canonical_record=True)
    preflight_raw, preflight, preflight_sha = _record(
        control, root + "/terminal-session-preflight.json", expected=proof["preflight_raw_sha256"],
        canonical_record=True)
    drain_raw, drain, drain_sha = _record(
        control, root + "/backend-drain.json", expected=proof["drain_sha256"], canonical_record=True)
    _require(receipt_raw == operation_raw and operation_sha == proof["operation_sha256"]
             and operation.get("schema") == "fullmag.docker-build-operation.v1"
             and operation.get("phase") == "iteration" and operation.get("state") == "succeeded"
             and operation.get("attempt") == attempt and operation.get("idle_backend_stopped") is True
             and operation.get("compose_project") == control.project
             and operation.get("control_volume") == control.volume
             and operation.get("inputs", {}).get("source_root") == proof["source_root"]
             and operation.get("inputs", {}).get("image_id") == proof["image_id"]
             and operation.get("config_sha256") == proof["config_sha256"]
             and operation.get("terminal_session_preflight_sha256") == _sha(canonical(preflight)),
             "source terminal operation/receipt differs from the proof")
    _require(preflight_sha == proof["preflight_raw_sha256"]
             and preflight.get("run", {}).get("run_id") == proof["run_id"]
             and preflight.get("session_id") == proof["session_id"],
             "source terminal preflight differs from the proof")
    process = drain.get("process_receipt", {})
    process_raw, process_tree, process_sha = _record(
        control, "runtime-control/runtime-service/process-tree.json", canonical_record=True)
    owner_raw, owner, owner_sha = _record(
        control, "runtime-control/runtime-services/OWNER.json")
    config_raw, config, config_sha = _record(
        control, "runtime-control/runtime-service/docker-all.json", canonical_record=True)
    _require(drain_sha == proof["drain_sha256"]
             and drain.get("schema") == "fullmag.docker-idle-restart-drain.v1"
             and drain.get("backend_container_id") == operation.get("backend_container")
             and process.get("schema") == "fullmag.docker-process-tree.v1"
             and process.get("state") == "drained"
             and drain.get("process_receipt_sha256") == _sha(canonical(process) + b"\n")
             and process_raw == canonical(process) + b"\n" and process_tree == process,
             "current process-tree is not the exact historical drained receipt")
    ready_owner = process.get("service_owner", {})
    terminal_owner = process.get("terminal_service_owner", {})
    _require(owner.get("state") == "drained" and terminal_owner.get("state") == "drained",
             "OWNER.json or historical terminal owner is not Drained")
    try:
        from docker_volume_drained_successor import _validate_native_owners
        native = _validate_native_owners(ready_owner, owner)
        native._validate_terminal_owner(terminal_owner, state="drained", name="source proof terminal owner")
        _require(native._owner_fingerprint(owner) == native._owner_fingerprint(terminal_owner),
                 "persisted OWNER.json differs from the exact historical Drained owner")
    except BuildControlError:
        raise
    except Exception as error:
        raise BuildControlError("Pre-owner drained stop: historical native owner authentication failed") from error
    token = ready_owner.get("owner_token")
    _require(isinstance(token, str) and OWNER_TOKEN.fullmatch(token), "historical owner pin reference is invalid")
    ready_relative = "runtime-control/runtime-services/docker-client-" + token + ".json"
    ready_raw, ready, ready_sha = _record(control, ready_relative, canonical_record=True)
    _require(ready.get("state") == "ready"
             and ready_sha == proof["ready_owner_sha256"]
             and native._owner_fingerprint(ready) == native._owner_fingerprint(ready_owner),
             "ready owner pin differs from the source drain")
    _require(config_sha == proof["native_config_sha256"]
             and config.get("schema_version") == "runtime_service_config.v2",
             "native configuration changed after the historical stop")
    from docker_volume_accepted_reattach import _read_store_regular
    catalog_raw = _read_store_regular(
        Path(source["store_root"]), "runs/" + proof["run_id"] + "/run_catalog.json",
        "pre-owner Completed catalog", maximum=MAX_RECORD_BYTES)
    catalog = _json(catalog_raw, "pre-owner Completed catalog")
    catalog_sha = _sha(catalog_raw)
    _require(catalog_sha == proof["catalog_sha256"] and catalog.get("revision") == proof["catalog_revision"],
             "source catalog changed after its Completed proof")
    fence_relative = source.get("failure_fence_relative")
    _require(isinstance(fence_relative, str)
             and re.fullmatch(r"runtime-control/runtime-service/api-failure-[0-9a-f]{32}\.json", fence_relative),
             "cold API failure fence path is invalid")
    pinned = {
        root + "/terminal.json": operation_sha,
        root + "/receipt.json": _sha(receipt_raw),
        root + "/terminal-session-preflight.json": preflight_sha,
        root + "/backend-drain.json": drain_sha,
        source["relative"]: source["sha256"],
        source["request_relative"]: source["request_sha256"],
        ready_relative: ready_sha,
        "runtime-control/runtime-service/process-tree.json": process_sha,
        "runtime-control/runtime-services/OWNER.json": owner_sha,
        "runtime-control/runtime-service/docker-all.json": config_sha,
        fence_relative: source["failure_fence_sha256"],
        "backend/runtime-provenance.json": None,
    }
    provenance_raw, provenance, provenance_sha = _record(
        control, "backend/runtime-provenance.json", canonical_record=True)
    _require(provenance.get("state") == "succeeded"
             and isinstance(ready_owner.get("build_snapshot"), str)
             and SHA.fullmatch(ready_owner["build_snapshot"])
             and isinstance(provenance.get("source_snapshot_sha256"), str)
             and SHA.fullmatch(provenance["source_snapshot_sha256"])
             and ready_owner.get("build_snapshot") != provenance.get("source_snapshot_sha256"),
             "current backend provenance is not a distinct verified build")
    pinned["backend/runtime-provenance.json"] = provenance_sha
    for relative, digest in pinned.items():
        if digest is not None:
            raw, _, observed = _record(control, relative, expected=digest)
            _require(observed == digest, "historical control record changed: " + relative)
    _require(source["native_config_sha256"] == config_sha,
             "historical native configuration digest differs")
    return {
        "control_hashes": pinned,
        "native_config_sha256": config_sha,
        "process_tree_sha256": process_sha,
        "owner_sha256": owner_sha,
        "ready_owner_sha256": ready_sha,
        "drain_sha256": drain_sha,
        "operation_sha256": operation_sha,
        "catalog_sha256": catalog_sha,
        "catalog_revision": catalog["revision"],
        "owner_token_hash": _sha(token.encode("utf-8")),
    }


def _python_helper_args(control, script, image_id, *, initialize=False):
    # The generic control image provides shell tools, not Python. Keep the
    # selected group's labels/mounts/namespace guard and use its pinned backend
    # image for these bounded read-only Python probes.
    _require(isinstance(image_id, str) and IMAGE.fullmatch(image_id),
             "Python probe requires the exact retained backend image")
    args = control.helper_args(script, initialize=initialize)
    image_index = args.index("--entrypoint") + 2
    _require(args[image_index] == control.image, "control helper image position differs")
    args[image_index] = image_id
    return args


def _owner_lock_identity(control, image_id):
    script = "python3 -I -B -c " + shlex.quote(_OWNER_LOCK_PROBE)
    args = _python_helper_args(control, script, image_id, initialize=True)
    result = bounded_capture(args, data=b"", timeout=30, maximum=4096)
    if result.returncode:
        raise BuildControlError("Pre-owner drained stop: OWNER.lock is held, replaced, or unreadable")
    value = _json(result.stdout, "OWNER.lock observation", maximum=4096)
    _require(value.get("schema") == "fullmag.preowner-owner-lock-observation.v1"
             and value.get("unlocked") is True and isinstance(value.get("inode_sha256"), str)
             and SHA.fullmatch(value["inode_sha256"]), "OWNER.lock observation is invalid")
    return value


def _released(control, backend):
    from docker_volume_pre_ack_retry import _released_snapshot
    return _released_snapshot(control, backend)


def _run_pins(control, backend):
    from docker_volume_stop_preowner_policy import RUN_PINS
    from docker_volume_capture_failure_reconcile import _mount_arg
    args = _python_helper_args(control, "python3 -I -B -c " + shlex.quote(RUN_PINS), backend["Image"])
    offset = args.index("--entrypoint")
    args[offset:offset] = ["--mount", _mount_arg(backend, "/state")]
    result = bounded_capture(args, data=b"", timeout=60, maximum=1024 * 1024)
    _require(result.returncode == 0, "retained catalog/run inventory could not be observed")
    return _json(result.stdout, "retained catalog/run inventory", maximum=1024 * 1024)


def _ledger_policy(control, document, backend):
    import docker_group_ledger as ledger

    expected = ledger.retained_profile(document, backend["Image"])
    mounts = [mount for mount in backend.get("Mounts", []) if isinstance(mount, Mapping)
              and mount.get("Destination") == ledger.MOUNT_TARGET]
    _require(len(mounts) == 1 and mounts[0].get("Type") == "volume"
             and mounts[0].get("Name") == expected["volume_name"]
             and mounts[0].get("RW") is True,
             "backend does not retain its exact writable group ledger")
    volume = expected["volume_name"]
    _require(isinstance(volume, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,255}", volume),
             "group ledger volume name is invalid")
    args = _python_helper_args(control, "python3 -I -B -c " + shlex.quote(_LEDGER_PROBE), backend["Image"])
    index = args.index("--entrypoint")
    args[index:index] = ["--mount", "type=volume,src=" + volume + ",dst=/ledger,readonly,volume-nocopy"]
    result = bounded_capture(args, data=b"", timeout=45, maximum=64 * 1024)
    if result.returncode:
        raise BuildControlError("Pre-owner drained stop: group host ledger cannot be read under its lock")
    value = _json(result.stdout, "group host-ledger observation", maximum=64 * 1024)
    budget = value.get("total_budget", {})
    _require(value.get("schema") == "fullmag.preowner-ledger-policy.v1"
             and isinstance(value.get("ledger_sha256"), str) and SHA.fullmatch(value["ledger_sha256"])
             and isinstance(value.get("host_id"), str) and isinstance(value.get("topology_sha256"), str)
             and SHA.fullmatch(value["topology_sha256"])
             and all(type(budget.get(key)) is int for key in
                     ("cpu_millis", "memory_bytes", "storage_bytes", "gpu_memory_bytes")),
             "group host-ledger policy is malformed")
    return value


def _budget(control, document, backend, previous, image_id):
    from docker_volume_resources import apply_saved_budget
    from docker_volume_unclaimed_cancellation import _saved_backend_budget

    saved = _saved_backend_budget(control, backend["Id"], document)
    receipt_raw = saved["receipt_raw"]
    receipt = _json(receipt_raw, "saved resource increase receipt", maximum=64 * 1024)
    _require(receipt.get("parent_attempt") == previous.get("attempt")
             and receipt.get("backend_container_id") == backend["Id"]
             and receipt.get("image_id") == image_id
             and receipt.get("started_at") == backend.get("State", {}).get("StartedAt"),
             "saved resource increase is not bound to this source/container incarnation")
    copied = copy.deepcopy(document)
    apply_saved_budget(control, copied)
    service = copied.get("services", {}).get("backend", {})
    environment = service.get("environment", {})
    budget = saved["budget"]
    _require(budget.get("memory_bytes") == 128 * GIB and budget.get("cpus") == 16
             and type(budget.get("memory_swap_bytes")) is int,
             "saved backend profile is not exactly 128 GiB/16 CPU")
    _require(int(service.get("mem_limit", 0)) == budget["memory_bytes"]
             and float(service.get("cpus", 0)) == budget["cpus"]
             and environment.get("FULLMAG_DOCKER_CPU_MILLIS") == str(budget["cpus"] * 1000)
             and environment.get("FULLMAG_DOCKER_MEMORY_BYTES") == str(budget["memory_bytes"]),
             "saved budget validator did not produce the exact applied backend profile")
    host = backend.get("HostConfig", {})
    _require(host.get("Memory") == budget["memory_bytes"]
             and host.get("NanoCpus") == budget["cpus"] * 10**9
             and host.get("MemorySwap") == budget["memory_swap_bytes"],
             "current backend kernel limits differ from the saved profile")
    profile_raw, profile, _ = _record(control, "backend/resource-budget.json", canonical_record=True)
    return {
        "profile_sha256": _sha(profile_raw),
        "receipt_path": saved["receipt_path"],
        "receipt_sha256": saved["receipt_sha256"],
        "budget": budget,
        "parent_attempt": receipt["parent_attempt"],
        "image_id": receipt["image_id"],
        "started_at": receipt["started_at"],
        "before": receipt.get("before"),
        "profile": profile,
    }


def _certificate(selected, layout, previous, document):
    state_root = previous.get("state_root")
    _require(isinstance(state_root, str) and state_root, "parent has no retained state root")
    state = Path(state_root).resolve(strict=True)
    state = storage.validate_path(state, Path(str(layout["runtime_root"])), "pre-owner state root")
    import docker_volume_dev as dev
    certificate = dev._retained_certificate(state, document)
    _require(certificate.get("restart_verified") is True,
             "retained source certificate is not restart_verified")
    host = dev._session_host()
    certificate_raw = host.read_owned_regular(dev._certificate_path(state), maximum=1024 * 1024)
    owner_raw = host.read_owned_regular(state / host.OWNER_NAME, maximum=1024 * 1024)
    return {
        "state_root": str(state),
        "certificate_sha256": _sha(certificate_raw),
        "state_owner_sha256": _sha(owner_raw),
        "restart_verified": True,
    }


def _cold_probe(backend_id, document, ledger_policy):
    result = docker_capture("exec", backend_id, "python3", "-I", "-B", "-c", _COLD_PROBE,
                            timeout=35)
    if len(result.stdout) > MAX_PROBE_BYTES:
        raise BuildControlError("Pre-owner drained stop: cold API probe exceeds its bound")
    guest = _json(result.stdout, "cold API probe", maximum=MAX_PROBE_BYTES)
    process_rows = guest.get("processes")
    _require(set(guest) == {
        "schema", "processes", "processes_sha256", "probe_present", "api_instance_sha256",
        "health_status", "health_state", "active_session", "current_status", "failure_reason",
        "requested_policy", "failure_fence_relative", "failure_fence_sha256", "owner_sha256",
        "process_tree_sha256", "native_config_sha256", "current_owner_pids_absent",
    } and isinstance(process_rows, list) and len(process_rows) == 3
             and all(isinstance(row, list) and len(row) == 4
                     and type(row[0]) is int and type(row[1]) is int and type(row[2]) is int
                     and isinstance(row[3], str) for row in process_rows)
             and process_rows == sorted(process_rows)
             and len({row[0] for row in process_rows}) == len(process_rows)
             and isinstance(guest.get("processes_sha256"), str)
             and guest["processes_sha256"] == _sha(json.dumps(process_rows, separators=(",", ":")).encode()),
             "cold API stable process inventory is malformed")
    _require(all(isinstance(guest.get(key), str) and SHA.fullmatch(guest[key]) for key in (
        "processes_sha256", "api_instance_sha256", "failure_fence_sha256", "owner_sha256",
        "process_tree_sha256", "native_config_sha256",
    )), "cold API record digests are malformed")
    requested = guest.get("requested_policy", {}).get("total_budget", {})
    env = document["services"]["backend"].get("environment", {})
    try:
        requested_cpu = int(env["FULLMAG_DOCKER_CPU_MILLIS"])
        requested_memory = int(env["FULLMAG_DOCKER_MEMORY_BYTES"]) - GIB
    except (KeyError, TypeError, ValueError) as error:
        raise BuildControlError("Pre-owner drained stop: current Compose native budget is malformed") from error
    old_budget = ledger_policy["total_budget"]
    _require(requested.get("cpu_millis") == requested_cpu
             and requested.get("memory_bytes") == requested_memory
             and requested.get("storage_bytes") == old_budget["storage_bytes"]
             and requested.get("gpu_memory_bytes") == old_budget["gpu_memory_bytes"]
             and old_budget["cpu_millis"] > requested_cpu
             and old_budget["memory_bytes"] > requested_memory,
             "cold API refusal does not match the preserved larger ledger budget")
    _require(guest.get("schema") == "fullmag.preowner-cold-api-probe.v1"
             and guest.get("probe_present") is True
             and guest.get("health_status") == 200 and guest.get("health_state") == "degraded"
             and guest.get("active_session") is False and guest.get("current_status") == 503
             and guest.get("current_owner_pids_absent") is True
             and guest.get("failure_reason", "").rstrip().endswith(": " + REFUSAL),
             "current backend is not the exact cold API-only refusal")
    return guest


def _containers(control, identity, previous, document, backend_id, image_id, *, running):
    from docker_dev_up import _compose_container_id
    from docker_volume_dev import _validate_retained_service
    from docker_compose_identity import validate_source_labels

    _require(document.get("name") == control.project, "Compose project identity differs")
    ids = {service: _compose_container_id(document, service) for service in ("backend", "frontend")}
    # _finish publishes worker_cgroup before observing runtime startup, while
    # backend_container is only added after a successful API admission.
    _require(ids["backend"] == backend_id == previous.get("worker_cgroup", {}).get("container_id")
             and previous.get("backend_container") in (None, backend_id),
             "backend container differs from the exact failed development")
    if previous.get("frontend_container") is not None:
        _require(ids["frontend"] == previous.get("frontend_container"),
                 "frontend container differs from the parent development")
    actual = {service: _inspect("container", identifier) for service, identifier in ids.items()}
    for service, row in actual.items():
        state = row.get("State", {})
        expected_image = image_id if service == "backend" else document["services"][service]["image"]
        _require(row.get("Image") == expected_image
                 and state.get("Running") is running
                 and state.get("OOMKilled") is False,
                 "retained service state/image differs: " + service)
        expected_started = previous.get(service + "_started_at")
        if expected_started is not None:
            _require(state.get("StartedAt") == expected_started,
                     "retained service StartedAt differs: " + service)
        image = _inspect("image", expected_image)
        _validate_retained_service(document, row, service, image.get("Config", {}),
                                   expected_started_at=expected_started)
        validate_source_labels(row, identity)
    if running:
        _require(all(actual[name]["State"].get("Pid", 0) > 0
                     and actual[name]["State"].get("Status") == "running" for name in actual),
                 "cold API-only container pair is not running")
    return ids, actual


def _history(control, source):
    _require(isinstance(source.get("failure_fence_relative"), str)
             and isinstance(source.get("failure_fence_sha256"), str)
             and SHA.fullmatch(source["failure_fence_sha256"]),
             "cold API failure-fence path and digest are not pinned")
    return _native_history(control, source)


def _collect(control, identity, selected, *, attempt, config_sha256, image_id,
             backend_container_id, proof_path, proof_sha256, previous, document, layout):
    parent_root, parent_raw, compose_raw, _ = _load_parent(
        control, previous, document, selected=selected, attempt=attempt,
        config_sha256=config_sha256, image_id=image_id, backend_container_id=backend_container_id)
    source = _source_proof(control, selected, previous, None, proof_sha256, proof_path=proof_path)
    ids, actual = _containers(control, identity, previous, document, backend_container_id, image_id, running=True)
    _require(actual["backend"].get("State", {}).get("StartedAt") == previous.get("backend_started_at"),
             "current backend StartedAt is not pinned by the failed development")
    _assert_group_inventory(control, ids["backend"], ids["frontend"])
    owner_lock = _owner_lock_identity(control, image_id)
    saved = _budget(control, document, actual["backend"], previous, image_id)
    ledger = _ledger_policy(control, document, actual["backend"])
    _require(saved["budget"]["cpus"] * 1000 >= ledger["total_budget"]["cpu_millis"]
             and saved["budget"]["memory_bytes"] >= ledger["total_budget"]["memory_bytes"] + GIB,
             "saved backend limits do not cover the historical ledger budget and API headroom")
    cold = _cold_probe(ids["backend"], document, ledger)
    _require(previous.get("error", "").strip() ==
             ("Runtime startup failed; diagnostic API retained: " + cold["failure_reason"]).strip(),
             "live startup fence differs from the failed-development terminal")
    source["failure_fence_relative"] = cold["failure_fence_relative"]
    source["failure_fence_sha256"] = cold["failure_fence_sha256"]
    native = _history(control, source)
    _require(cold.get("native_config_sha256") == source["native_config_sha256"]
             and cold.get("owner_sha256") == native["owner_sha256"]
             and cold.get("process_tree_sha256") == native["process_tree_sha256"],
             "live cold API owner/process/config differs from the exact historical Drained records")
    released = _released(control, actual["backend"])
    _require(released.get("active_count") == 0, "host ledger or local store contains an active lease")
    run_pins = _run_pins(control, actual["backend"])
    cert = _certificate(selected, layout, previous, document)
    _require(_history(control, source) == native,
             "historical native/control proof changed during collection")
    return {
        "schema": "fullmag.preowner-drained-stop-plan.v1",
        "parent": {"attempt": attempt, "terminal_sha256": _sha(parent_raw),
                   "compose_sha256": _sha(compose_raw), "config_sha256": config_sha256,
                   "source_root": str(selected), "image_id": image_id,
                   "control_namespace": control.namespace},
        "source_proof": {key: value for key, value in source.items()
                         if key not in {"proof", "state_root", "store_root", "failure_fence_relative",
                                        "failure_fence_sha256"}},
        "parent_terminal_observation": _terminal_observation_metadata(previous),
        "native_history": native,
        "owner_lock": owner_lock,
        "cold_api": cold,
        "saved_budget": saved,
        "host_ledger": ledger,
        "released": released,
        "run_pins": run_pins,
        "certificate": cert,
        "containers": {name: {"before": _container_pin(row)} for name, row in actual.items()},
        "backend_container_id": ids["backend"],
        "frontend_container_id": ids["frontend"],
        "native_drain_performed": False,
    }, source, ids, actual


def _publish_immutable(control, relative, value):
    raw = canonical(value) + b"\n"
    if len(raw) > MAX_RECORD_BYTES:
        _require(False, "immutable stop evidence exceeds its byte bound")
    path = control.path(relative)
    parent = str(Path(path).parent)
    script = f"""set -euo pipefail
parent={shlex.quote(parent)}
path={shlex.quote(path)}
mkdir -p -- "$parent"
test ! -L "$parent"
test "$(readlink -f -- "$parent")" = "$parent"
test ! -e "$path"
test ! -L "$path"
tmp=$(mktemp "$parent/.preowner.XXXXXXXX")
trap 'rm -f -- "$tmp"' EXIT
cat > "$tmp"
chmod 0440 "$tmp"
test "$(sha256sum "$tmp" | cut -d' ' -f1)" = {shlex.quote(_sha(raw))}
sync "$tmp"
ln -T -- "$tmp" "$path"
sync "$parent"
rm -- "$tmp"
trap - EXIT
"""
    result = bounded_capture(control.helper_args(script), data=raw, timeout=90)
    if result.returncode:
        raise BuildControlError("Cannot create immutable pre-owner stop evidence")
    observed = control.read_bytes(relative, maximum=MAX_RECORD_BYTES)
    _require(observed == raw, "immutable stop evidence was not confirmed")
    return _sha(raw)


def stop(args):
    """Preview by default; apply stops only the pinned backend/frontend pair."""
    from docker_dev import _compose_identity, _select_source
    from docker_dev_host import require_host

    require_host()
    apply = getattr(args, "apply", False)
    _require(type(apply) is bool, "apply mode must be an explicit boolean")
    for value, pattern in (
        (getattr(args, "attempt", None), ATTEMPT),
        (getattr(args, "config_sha256", None), SHA),
        (getattr(args, "backend_container_id", None), CONTAINER),
        (getattr(args, "image_id", None), IMAGE),
        (getattr(args, "proof_sha256", None), SHA),
    ):
        _require(isinstance(value, str) and pattern.fullmatch(value), "full immutable operator pins are required")
    expected_plan_sha256 = getattr(args, "expected_plan_sha256", None)
    if apply:
        _require(isinstance(expected_plan_sha256, str) and SHA.fullmatch(expected_plan_sha256),
                 "apply requires the reviewed 64-hex preview plan digest")
    source_root = getattr(args, "source_root", None)
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True),
                                      Path(source_root) if source_root is not None else None)
    identity = _compose_identity(layout)
    control = BuildControl(identity, args.image_id)
    proof_path = "runtime-control/terminal-observation/" + args.proof_sha256 + "/proof.json"
    if getattr(args, "proof_path", None) != proof_path:
        _require(False, "source proof path must be its exact private CAS-pinned path")
    journal_relative = "verification/preowner-drained-stop-" + args.backend_container_id + ".json"
    intent_relative = "verification/preowner-drained-stop-" + args.backend_container_id + ".intent.json"
    _require(control.read_bytes(journal_relative, optional=True) is None
             and control.read_bytes(intent_relative, optional=True) is None,
             "a prior stop journal or intent exists; do not replay the stop")
    phase = "preowner-drained-stop" if apply else "preowner-drained-stop-preview"
    inputs = {
        "attempt": args.attempt,
        "config_sha256": args.config_sha256,
        "source_root": str(selected),
        "image_id": args.image_id,
        "backend_container_id": args.backend_container_id,
        "proof_path": proof_path,
        "proof_sha256": args.proof_sha256,
        "expected_plan_sha256": expected_plan_sha256,
        "controller_sha256": _sha(Path(__file__).read_bytes()),
    }
    with control.operation(phase, inputs) as operation:
        _require(control.read_bytes(journal_relative, optional=True) is None
                 and control.read_bytes(intent_relative, optional=True) is None,
                 "a stop intent appeared before the operation lease")
        current_raw, previous, _ = _record(control, "development/attempts/" + args.attempt + "/terminal.json",
                                        canonical_record=True)
        document_raw, document, _ = _record(control, "development/attempts/" + args.attempt + "/compose.json",
                                         canonical_record=True)
        _require(_sha(canonical(document)) == args.config_sha256, "parent Compose digest differs")
        plan, source, ids, before = _collect(
            control, identity, selected, attempt=args.attempt, config_sha256=args.config_sha256,
            image_id=args.image_id, backend_container_id=args.backend_container_id,
            proof_path=proof_path, proof_sha256=args.proof_sha256, previous=previous,
            document=document, layout=layout)
        plan["controller_sha256"] = inputs["controller_sha256"]
        plan_sha = _sha(canonical(plan))
        control.write(operation["root"] + "/plan.json", plan)
        if not apply:
            operation["receipt"].update(state="succeeded", result={"state": "preview-passed",
                                                                      "plan_sha256": plan_sha})
            print(json.dumps({"state": "preview-passed", "plan_sha256": plan_sha}, sort_keys=True))
            return {"state": "preview-passed", "plan_sha256": plan_sha}
        _require(plan_sha == expected_plan_sha256,
                 "fresh apply plan differs from the reviewed preview; no containers were stopped")
        _require(current_raw == control.read_bytes("development/current.json"),
                 "parent development changed before the pre-owner stop")
        intent = {
            "schema": INTENT_SCHEMA,
            "state": "stop-authorized",
            "plan_sha256": plan_sha,
            "plan": plan,
            "operation": {"phase": phase, "attempt": operation["receipt"]["attempt"],
                          "root": operation["root"]},
            "journal_relative": journal_relative,
            "intent_relative": intent_relative,
        }
        intent_sha = _publish_immutable(control, intent_relative, intent)
        operation["daemon_pending"] = True
        for service in ("backend", "frontend"):
            docker_capture("stop", "--time", "60", ids[service], timeout=75)
            stopped = _inspect("container", ids[service])
            _stopped_state(stopped, plan["containers"][service]["before"])
        after = {service: _inspect("container", ids[service]) for service in ("backend", "frontend")}
        stop_states = {service: _stopped_state(after[service], plan["containers"][service]["before"])
                       for service in after}
        _assert_group_inventory(control, ids["backend"], ids["frontend"])
        parent_raw_after, parent_after, _ = _record(
            control, "development/attempts/" + args.attempt + "/terminal.json", canonical_record=True)
        _require(parent_raw_after == current_raw and parent_after == previous
                 and control.read_bytes("development/current.json") == current_raw,
                 "parent development changed while stopping services")
        source_after = _source_proof(control, selected, previous, source["proof"],
                                     args.proof_sha256, proof_path=proof_path)
        source_after["failure_fence_relative"] = plan["cold_api"]["failure_fence_relative"]
        source_after["failure_fence_sha256"] = plan["cold_api"]["failure_fence_sha256"]
        native_after = _history(control, source_after)
        _require(native_after == plan["native_history"], "historical native/control records changed during stop")
        owner_lock_after = _owner_lock_identity(control, args.image_id)
        _require(owner_lock_after == plan["owner_lock"], "OWNER.lock changed during stop")
        saved_after = _budget(control, document, after["backend"], previous, args.image_id)
        ledger_after = _ledger_policy(control, document, after["backend"])
        _require(saved_after == plan["saved_budget"] and ledger_after == plan["host_ledger"],
                 "saved resource profile or group ledger changed during stop")
        released_after = _released(control, after["backend"])
        pins_after = _run_pins(control, after["backend"])
        _require(released_after == plan["released"] and released_after.get("active_count") == 0
                 and pins_after == plan["run_pins"],
                 "released host/store leases or retained run catalogs changed during stop")
        cert_after = _certificate(selected, layout, previous, document)
        _require(cert_after == plan["certificate"], "retained state certificate/owner changed during stop")
        journal = {
            "schema": SCHEMA,
            "state": "stopped-confirmed",
            "native_drain_performed": False,
            "data_preserved": True,
            "journal_relative": journal_relative,
            "plan_sha256": plan_sha,
            "intent_relative": intent_relative,
            "intent_sha256": intent_sha,
            "operation": intent["operation"],
            "parent_authorization": {
                "attempt": args.attempt,
                "terminal_sha256": plan["parent"]["terminal_sha256"],
                "config_sha256": args.config_sha256,
                "terminal_observation": plan["parent_terminal_observation"],
            },
            "source_proof": {
                "sha256": args.proof_sha256,
                "original_stop_attempt": source["original_iteration"],
                "source_stop_sha256": source["operation_sha256"],
                "drain_sha256": source["drain_sha256"],
                "native_config_sha256": source["native_config_sha256"],
            },
            "containers": {service: {"before": plan["containers"][service]["before"],
                                      "after": stop_states[service]}
                           for service in stop_states},
            "native_history": plan["native_history"],
            "owner_lock": plan["owner_lock"],
            "host_ledger": plan["host_ledger"],
            "released": plan["released"],
            "run_pins": plan["run_pins"],
            "saved_budget": plan["saved_budget"],
            "certificate": plan["certificate"],
        }
        journal_sha = _publish_immutable(control, journal_relative, journal)
        operation["daemon_pending"] = False
        operation["receipt"].update(state="succeeded", result={
            "state": "stopped-confirmed", "journal_relative": journal_relative,
            "journal_sha256": journal_sha, "native_drain_performed": False,
        })
        print(json.dumps({"state": "stopped-confirmed", "journal_sha256": journal_sha,
                          "native_drain_performed": False}, sort_keys=True))
        return {"state": "stopped-confirmed", "journal_sha256": journal_sha,
                "native_drain_performed": False}


def retained_context(control, previous, document, actual, proof, proof_sha256):
    """Read-only authentication of this stop under the caller's recreate lease."""
    backend = actual.get("backend") if isinstance(actual, Mapping) else None
    backend_id = backend.get("Id") if isinstance(backend, Mapping) else None
    if not isinstance(backend_id, str) or CONTAINER.fullmatch(backend_id) is None:
        return None
    journal_relative = "verification/preowner-drained-stop-" + backend_id + ".json"
    intent_relative = "verification/preowner-drained-stop-" + backend_id + ".intent.json"
    journal_raw = control.read_bytes(journal_relative, optional=True)
    intent_raw = control.read_bytes(intent_relative, optional=True)
    if journal_raw is None:
        _require(intent_raw is None, "pre-owner stop intent has no confirmed journal; do not replay")
        return None
    journal = _json(journal_raw, "pre-owner stopped-confirmed journal")
    expected_journal_keys = {
        "schema", "state", "native_drain_performed", "data_preserved", "journal_relative",
        "plan_sha256", "intent_relative", "intent_sha256", "operation", "parent_authorization",
        "source_proof", "containers", "native_history", "owner_lock", "host_ledger",
        "released", "run_pins", "saved_budget", "certificate",
    }
    _require(set(journal) == expected_journal_keys
             and journal_raw == canonical(journal) + b"\n"
             and journal.get("schema") == SCHEMA
             and journal.get("state") == "stopped-confirmed"
             and journal.get("native_drain_performed") is False
             and journal.get("data_preserved") is True
             and journal.get("journal_relative") == journal_relative
             and journal.get("intent_relative") == intent_relative,
             "pre-owner journal is not a typed Docker-only stop")
    _require(intent_raw is not None and _sha(intent_raw) == journal.get("intent_sha256"),
             "immutable pre-owner intent is absent or changed")
    intent = _json(intent_raw, "pre-owner immutable intent")
    _require(set(intent) == {"schema", "state", "plan_sha256", "plan", "operation",
                            "journal_relative", "intent_relative"}
             and intent_raw == canonical(intent) + b"\n"
             and intent.get("schema") == INTENT_SCHEMA
             and intent.get("state") == "stop-authorized"
             and intent.get("plan_sha256") == journal.get("plan_sha256")
             and intent.get("journal_relative") == journal_relative
             and intent.get("intent_relative") == intent_relative,
             "pre-owner stop intent differs from its journal")
    plan = intent.get("plan")
    expected_plan_keys = {
        "schema", "parent", "source_proof", "parent_terminal_observation", "native_history",
        "owner_lock", "cold_api", "saved_budget", "host_ledger", "released", "run_pins",
        "certificate", "containers", "backend_container_id", "frontend_container_id",
        "native_drain_performed", "controller_sha256",
    }
    _require(isinstance(plan, Mapping) and set(plan) == expected_plan_keys
             and _sha(canonical(plan)) == journal.get("plan_sha256"),
             "pre-owner stop plan differs from its immutable pin")
    _require(plan.get("schema") == "fullmag.preowner-drained-stop-plan.v1"
             and plan.get("native_drain_performed") is False
             and isinstance(plan.get("controller_sha256"), str)
             and SHA.fullmatch(plan["controller_sha256"])
             and plan.get("parent_terminal_observation") == _terminal_observation_metadata(previous)
             and plan.get("parent", {}).get("control_namespace") == control.namespace
             and plan.get("parent", {}).get("source_root") == previous.get("inputs", {}).get("source_root"),
             "pre-owner stop plan differs from the authorized parent scope")
    op = journal.get("operation", {})
    _require(op == intent.get("operation") and isinstance(op.get("attempt"), str)
             and ATTEMPT.fullmatch(op["attempt"])
             and op.get("phase") == "preowner-drained-stop"
             and op.get("root") == "preowner-drained-stop/attempts/" + op["attempt"],
             "pre-owner stop operation identity differs")
    operation_root = op["root"]
    operation_raw, operation, _ = _record(control, operation_root + "/terminal.json", canonical_record=True)
    receipt_raw, receipt, _ = _record(control, operation_root + "/receipt.json", canonical_record=True)
    _require(operation_raw == receipt_raw and operation == receipt
             and operation.get("phase") == op["phase"]
             and operation.get("attempt") == op["attempt"]
             and operation.get("state") == "succeeded"
             and operation.get("result", {}).get("state") == "stopped-confirmed"
             and operation.get("result", {}).get("journal_relative") == journal_relative
             and operation.get("result", {}).get("journal_sha256") == _sha(journal_raw)
             and operation.get("result", {}).get("native_drain_performed") is False,
             "pre-owner operation terminal does not authenticate the journal")
    parent = journal.get("parent_authorization", {})
    _require(isinstance(parent, Mapping)
             and set(parent) == {"attempt", "terminal_sha256", "config_sha256", "terminal_observation"}
             and isinstance(journal.get("source_proof"), Mapping)
             and set(journal["source_proof"]) == {
                 "sha256", "original_stop_attempt", "source_stop_sha256", "drain_sha256",
                 "native_config_sha256",
             }
             and isinstance(journal.get("containers"), Mapping)
             and set(journal["containers"]) == {"backend", "frontend"},
             "pre-owner journal authority records have an unexpected shape")
    parent_attempt = parent.get("attempt")
    parent_root, parent_raw, compose_raw, _ = _load_parent(
        control, previous, document, selected=Path(previous.get("inputs", {}).get("source_root", "")),
        attempt=parent_attempt, config_sha256=parent.get("config_sha256"),
        image_id=plan.get("parent", {}).get("image_id"), backend_container_id=backend_id)
    _require(_sha(parent_raw) == parent.get("terminal_sha256")
             and _sha(compose_raw) == plan.get("parent", {}).get("compose_sha256")
             and parent.get("terminal_observation") == plan.get("parent_terminal_observation"),
             "parent failed-development authority changed")
    _require(set(actual) == {"backend", "frontend"}, "exact stopped service pair is required")
    ids = {"backend": backend_id, "frontend": journal.get("containers", {}).get("frontend", {}).get("after", {}).get("container_id")}
    _require(isinstance(ids["frontend"], str) and CONTAINER.fullmatch(ids["frontend"]),
             "journal frontend identity is invalid")
    _require(journal["containers"].get("backend", {}).get("before")
             == plan.get("containers", {}).get("backend", {}).get("before")
             and journal["containers"].get("frontend", {}).get("before")
             == plan.get("containers", {}).get("frontend", {}).get("before"),
             "journal container pins differ from the reviewed stop plan")
    parent_frontend = previous.get("frontend_container")
    if parent_frontend is not None:
        _require(ids["frontend"] == parent_frontend,
                 "stopped frontend differs from the parent development container")
    fresh = {service: _inspect("container", ids[service]) for service in ids}
    for service, observed in fresh.items():
        _require(_container_pin(observed) == journal["containers"][service]["before"],
                 "current stopped Docker incarnation differs: " + service)
        stopped_pin = _stopped_state(observed, journal["containers"][service]["before"])
        _require(stopped_pin == journal["containers"][service].get("after"),
                 "journal stopped exit record differs from the current container: " + service)
        _require(_container_pin(actual[service]) == _container_pin(observed)
                 and actual[service].get("State", {}).get("ExitCode") == 0
                 and actual[service].get("State", {}).get("OOMKilled") is False,
                 "caller stopped service observation differs: " + service)
    from docker_compose_identity import validate_source_labels
    from docker_volume_dev import _validate_retained_service
    for service, observed in fresh.items():
        expected_image = (plan["parent"]["image_id"] if service == "backend"
                          else document["services"][service]["image"])
        _require(observed.get("Image") == expected_image,
                 "stopped Docker image differs from its parent configuration: " + service)
        image = _inspect("image", expected_image)
        _validate_retained_service(
            document, observed, service, image.get("Config", {}),
            expected_started_at=previous.get(service + "_started_at"))
        validate_source_labels(observed, control.identity)
    _require(plan.get("backend_container_id") == backend_id
             and plan.get("frontend_container_id") == ids["frontend"],
             "pre-owner plan container identity differs from the retained pair")
    _assert_group_inventory(control, ids["backend"], ids["frontend"])
    source = _source_proof(control, Path(plan["parent"]["source_root"]), previous,
                           proof, proof_sha256)
    _require(proof_sha256 == journal.get("source_proof", {}).get("sha256")
             and source["original_iteration"] == journal["source_proof"].get("original_stop_attempt")
             and source["operation_sha256"] == journal["source_proof"].get("source_stop_sha256")
             and source["drain_sha256"] == journal["source_proof"].get("drain_sha256")
             and source["native_config_sha256"] == journal["source_proof"].get("native_config_sha256"),
             "source proof or parent authorization differs from the stopped journal")
    source_projection = {key: value for key, value in source.items()
                         if key not in {"proof", "state_root", "store_root"}}
    _require(source_projection == plan.get("source_proof"),
             "source proof projection differs from the reviewed stop plan")
    _require(plan.get("cold_api", {}).get("probe_present") is True,
             "cold API exact-process observation lacks its one-shot probe identity")
    source["failure_fence_relative"] = plan["cold_api"]["failure_fence_relative"]
    source["failure_fence_sha256"] = plan["cold_api"]["failure_fence_sha256"]
    native = _history(control, source)
    _require(native == journal.get("native_history") == plan.get("native_history"),
             "historical native/control/catalog hashes changed")
    owner_lock = _owner_lock_identity(control, fresh["backend"]["Image"])
    _require(owner_lock == journal.get("owner_lock") == plan.get("owner_lock"),
             "OWNER.lock is held or its inode changed")
    saved = _budget(control, document, fresh["backend"], previous, plan["parent"]["image_id"])
    ledger = _ledger_policy(control, document, fresh["backend"])
    _require(saved == journal.get("saved_budget") == plan.get("saved_budget")
             and ledger == journal.get("host_ledger") == plan.get("host_ledger")
             and saved["budget"]["cpus"] * 1000 >= ledger["total_budget"]["cpu_millis"]
             and saved["budget"]["memory_bytes"] >= ledger["total_budget"]["memory_bytes"] + GIB,
             "saved 128 GiB/16 CPU profile no longer covers the historical ledger plus API headroom")
    released = _released(control, fresh["backend"])
    pins = _run_pins(control, fresh["backend"])
    _require(released.get("active_count") == 0
             and released == journal.get("released") == plan.get("released")
             and pins == journal.get("run_pins") == plan.get("run_pins"),
             "host/store leases or retained catalogs changed after the stop")
    layout = storage.resolve_layout(Path(plan["parent"]["source_root"]), "docker-all-gpu")
    certificate = _certificate(Path(plan["parent"]["source_root"]), layout, previous, document)
    _require(certificate == journal.get("certificate") == plan.get("certificate"),
             "retained stateOwner certificate differs")
    return PreownerDrainedContext({
        "journal_relative": journal_relative,
        "journal_sha256": _sha(journal_raw),
        "source_proof_sha256": proof_sha256,
        "original_stop_attempt": source["original_iteration"],
        "source_stop_sha256": source["operation_sha256"],
    })
