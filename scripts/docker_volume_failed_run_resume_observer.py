"""Read-only evidence capture for an explicitly pinned failed-run continuation."""
from __future__ import annotations

import hashlib
import inspect
import json
import re
from collections.abc import Mapping
from pathlib import Path

from docker_build_control import BuildControlError, bounded_capture, canonical


RUN_ID_RE = re.compile(r"run-[A-Za-z0-9_-]{1,128}\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
MAX_CAPTURE_BYTES = 8 * 1024 * 1024
LINUX_CERTIFICATE_TARGET = "/run/fullmag/linux-native-host.json"
LINUX_CERTIFICATE_NAME = "linux-native-host.json"


def _fail(message: str) -> None:
    raise BuildControlError(message)


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _json_object(raw: bytes, label: str) -> dict[str, object]:
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate JSON key")
            value[key] = item
        return value

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise BuildControlError(label + " is not unambiguous JSON") from error
    if not isinstance(value, Mapping):
        _fail(label + " is not a JSON object")
    return dict(value)


def _read_runtime(control, relative: str, label: str, maximum: int) -> tuple[bytes, dict[str, object]]:
    raw = control.read_bytes(relative, maximum=maximum)
    if not isinstance(raw, bytes) or len(raw) > maximum:
        _fail(label + " exceeds its bounded control record")
    return raw, _json_object(raw, label)


def _stable_linux_host_identity(host, owner, state_device, state_inode, store_device):
    """Validate only the Linux-native identity that survives managed reuse.

    Current mount-namespace probes and image/restart fields are admission
    evidence and may legitimately change before this observer runs.  The
    state/owner identity and the store's same-device relation remain stable.
    This function's source is embedded in the isolated read-only observer.
    """
    if not isinstance(host, dict) or not isinstance(owner, dict):
        raise ValueError("Linux-native certificate/owner marker is malformed")
    if host != owner:
        raise ValueError("Linux-native owner marker differs from certificate")
    fields = {
        "schema", "storage_profile", "role", "owner_scope", "owner_token",
        "engine_id", "host_root", "host_filesystem", "host_platform",
        "host_device", "host_root_no_reparse", "host_inode",
    }
    identity = {key: host.get(key) for key in fields}
    if (identity["schema"] != "fullmag.linux-native-host.v1"
            or identity["storage_profile"] != "linux-native-v1"
            or identity["role"] != "session"
            or identity["owner_scope"] != "docker-linux"):
        raise ValueError("Linux-native host owner/profile scope differs")
    token = identity["owner_token"]
    if (not isinstance(token, str) or re.fullmatch(r"[0-9a-f]{32}", token) is None
            or set(token) == {"0"}):
        raise ValueError("Linux-native owner token is invalid")
    engine = identity["engine_id"]
    if (not isinstance(engine, str) or not engine or len(engine) > 256
            or "\x00" in engine):
        raise ValueError("Linux-native Docker engine identity is invalid")
    root = identity["host_root"]
    filesystem = identity["host_filesystem"]
    if (not isinstance(root, str) or not root or len(root) > 4096 or "\x00" in root
            or not isinstance(filesystem, str) or filesystem not in {"ext4", "xfs", "btrfs"}):
        raise ValueError("Linux-native host root/filesystem identity is invalid")
    if (identity["host_platform"] != "linux"
            or identity["host_root_no_reparse"] is not True):
        raise ValueError("Linux-native host platform/root identity differs")
    device = identity["host_device"]
    inode = identity["host_inode"]
    if (type(device) is not int or device <= 0 or type(inode) is not int or inode <= 0
            or type(state_device) is not int or type(state_inode) is not int
            or type(store_device) is not int
            or device != state_device or inode != state_inode
            or store_device != state_device):
        raise ValueError("Linux-native state mount identity differs")
    return identity


def _task_admission_identity(admission, relative, run_id):
    """Bind a task admission's task and lease identities to its selected path."""
    if not isinstance(admission, dict):
        raise ValueError("task admission is not an object")
    required = {
        "schema_version", "expected_catalog_revision", "queued_task", "task",
        "lease", "resolved_inputs_snapshot",
    }
    if set(admission) != required or admission.get("schema_version") != "task_admission.v1":
        raise ValueError("task admission schema or field set differs")
    if (type(admission.get("expected_catalog_revision")) is not int
            or admission["expected_catalog_revision"] <= 0
            or not isinstance(admission.get("resolved_inputs_snapshot"), dict)):
        raise ValueError("task admission revision or resolved input snapshot is malformed")
    parts = relative.split("/")
    if (len(parts) != 5 or parts[0] != "runs" or parts[1] != run_id
            or parts[2] != "task_admissions" or not parts[4].endswith(".json")):
        raise ValueError("task admission path is outside the selected run")
    path_task = parts[3]
    path_attempt = parts[4][:-5]
    safe = r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}"
    if re.fullmatch(safe, path_task) is None or re.fullmatch(safe, path_attempt) is None:
        raise ValueError("task admission path identity is malformed")
    queued = admission.get("queued_task")
    task = admission.get("task")
    lease = admission.get("lease")
    if not isinstance(queued, dict) or not isinstance(task, dict) or not isinstance(lease, dict):
        raise ValueError("task admission task or lease record is malformed")
    task_id = task.get("task_id")
    attempt_id = task.get("attempt_id")
    epoch = task.get("ownership_epoch")
    resource_id = task.get("resource_id")
    if ("run_id" in task or task_id != path_task or attempt_id != path_attempt
            or queued.get("task_id") != task_id
            or re.fullmatch(safe, task_id or "") is None
            or re.fullmatch(safe, attempt_id or "") is None
            or type(epoch) is not int or epoch <= 0
            or not isinstance(resource_id, str) or re.fullmatch(safe, resource_id) is None):
        raise ValueError("task admission task identity differs from its path")
    if (lease.get("schema_version") != "resource_lease.v1"
            or lease.get("run_id") != run_id
            or lease.get("task_id") != task_id
            or lease.get("attempt_id") != attempt_id
            or type(lease.get("ownership_epoch")) is not int
            or lease.get("ownership_epoch") != epoch
            or lease.get("resource_id") != resource_id):
        raise ValueError("task admission lease identity differs from its task or selected run")
    return {
        "run_id": run_id,
        "task_id": task_id,
        "attempt_id": attempt_id,
        "ownership_epoch": epoch,
        "resource_id": resource_id,
    }


def capture_runtime_evidence(control, backend, compose):
    """Read four current failed-owner records and the exact process-pinned fence.

    Historical ``failure_process_receipt`` bytes are bound by the immutable
    diagnostic-stop record; they are not expected to remain as a live file.
    """
    del backend, compose  # The records live in the authenticated BuildControl namespace.
    paths = {
        "runtime_config": "runtime-control/runtime-service/docker-all.json",
        "failed_owner": "runtime-control/runtime-services/OWNER.json",
        "terminal_process_receipt": "runtime-control/runtime-service/process-tree.json",
    }
    result = {}
    for key, relative in paths.items():
        maximum = 256 * 1024 if key != "terminal_process_receipt" else 1024 * 1024
        raw, value = _read_runtime(control, relative, key.replace("_", " "), maximum)
        result[key] = {"sha256": _sha(raw), "value": value}

    process = result["terminal_process_receipt"]["value"]
    fence_path = process.get("api_failure_fence")
    from docker_volume_stop_diagnostic import _runtime_relative
    try:
        fence_relative = _runtime_relative(fence_path)
    except Exception as error:
        raise BuildControlError("terminal process receipt does not bind a canonical API failure fence") from error
    fence_raw, fence = _read_runtime(control, fence_relative, "API failure fence", 256 * 1024)
    result["api_failure_fence"] = {"sha256": _sha(fence_raw), "value": fence}
    return result


def _accepted_store_script() -> str:
    """Image-owned bounded snapshot under host-ledger then store writer locks."""
    script = r'''import fcntl,hashlib,json,os,pathlib,re,stat,time
MAX_FILES=32768;MAX_DIRS=8192;MAX_FILE=1024*1024*1024;MAX_TOTAL=2*1024*1024*1024
DEADLINE=time.monotonic()+110;RUN_ID=os.environ['FULLMAG_RESUME_RUN_ID'];EXPECTED_STORE=os.environ['FULLMAG_RESUME_STORE_ID']
def fail(message): raise RuntimeError(message)
def canon(value): return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def sha(raw): return hashlib.sha256(raw).hexdigest()
def unique(pairs):
 out={}
 for key,value in pairs:
  if key in out: fail('duplicate JSON key')
  out[key]=value
 return out
def regular(path,maximum=MAX_FILE,collect=True):
 path=pathlib.Path(path)
 if not path.is_absolute() or '..' in path.parts: fail('unsafe retained path')
 fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0)|getattr(os,'O_CLOEXEC',0))
 try:
  before=os.fstat(fd);named=os.lstat(path);ident=(before.st_dev,before.st_ino,before.st_mode,before.st_size,before.st_mtime_ns,before.st_ctime_ns)
  if not stat.S_ISREG(before.st_mode) or not stat.S_ISREG(named.st_mode) or ident!=(named.st_dev,named.st_ino,named.st_mode,named.st_size,named.st_mtime_ns,named.st_ctime_ns) or before.st_size<0 or before.st_size>maximum: fail('retained file is not stable bounded regular data')
  digest=hashlib.sha256();chunks=[];size=0
  while True:
   if time.monotonic()>DEADLINE: fail('retained store observation exceeded time budget')
   chunk=os.read(fd,1024*1024)
   if not chunk: break
   digest.update(chunk)
   if collect: chunks.append(chunk)
   size+=len(chunk)
   if size>maximum or size>before.st_size: fail('retained file exceeded byte bound while reading')
  after=os.fstat(fd);named_after=os.lstat(path)
  if size!=before.st_size or ident!=(after.st_dev,after.st_ino,after.st_mode,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or ident!=(named_after.st_dev,named_after.st_ino,named_after.st_mode,named_after.st_size,named_after.st_mtime_ns,named_after.st_ctime_ns): fail('retained file changed during locked observation')
  return (digest.hexdigest(),b''.join(chunks) if collect else None)
 finally: os.close(fd)
def obj(raw,label):
 try: value=json.loads(raw.decode('utf-8'),object_pairs_hook=unique)
 except (UnicodeDecodeError,json.JSONDecodeError) as error: raise RuntimeError(label+' is not unambiguous JSON') from error
 if not isinstance(value,dict): fail(label+' is not an object')
 return value
def lock(path,label):
 fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0))
 try:
  info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1: fail(label+' is not a singly linked regular lock')
  if os.read(fd,64)!=b'fullmag.writer.lock.v1\n': fail(label+' descriptor differs')
  deadline=time.monotonic()+5
  while True:
   try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); return fd
   except BlockingIOError as error:
    if time.monotonic()>=deadline: raise RuntimeError(label+' remained busy') from error
    time.sleep(.05)
   except OSError as error: raise RuntimeError(label+' lock outcome is unknown') from error
 except BaseException: os.close(fd);raise
def walk(root):
 root=pathlib.Path(root)
 if not root.is_dir() or root.is_symlink(): fail('session store root is missing or linked')
 files={};dirs=[];total=0
 for current,names,leaves in os.walk(root,topdown=True,followlinks=False):
  if time.monotonic()>DEADLINE: fail('retained store walk exceeded time budget')
  current=pathlib.Path(current);names.sort();leaves.sort()
  for name in names:
   path=current/name
   if path.is_symlink() or not path.is_dir(): fail('session store contains a linked/invalid directory')
   dirs.append(path.relative_to(root).as_posix())
   if len(dirs)>MAX_DIRS: fail('session store directory inventory is unbounded')
  for name in leaves:
   path=current/name
   if path.is_symlink(): fail('session store contains a symlink')
   relative=path.relative_to(root).as_posix()
   relevant=(relative.startswith('runs/') and (
    relative.endswith('/run_intent.json') or relative.endswith('/run_catalog.json')
    or relative.endswith('/start_release.json') or relative.endswith('/artifact_catalog.json')
    or '/coordinator_journal/' in relative or '/worker_process_exit_receipts/' in relative
    or '/resource_leases/' in relative or '/preparation_resource_leases/' in relative
    or '/task_admissions/' in relative or '/task_cancellation_intents/' in relative
    or '/worker_inbox/' in relative))
   digest,raw=regular(path,collect=relevant);total+=os.lstat(path).st_size
   if total>MAX_TOTAL: fail('session store exceeds aggregate byte budget')
   if relevant and len(raw)>8*1024*1024: fail('accepted runtime evidence exceeds its JSON size bound')
   cas_match=re.fullmatch(r'objects/sha256/([0-9a-f]{64})',relative)
   if cas_match and cas_match[1]!=digest: fail('retained CAS object content differs from its address')
   files[relative]=(digest,raw)
   if len(files)>MAX_FILES: fail('session store file inventory is unbounded')
 return files,sorted(dirs)
state=pathlib.Path('/state');store=state/'runs/docker-all/session-store';ledger=pathlib.Path('/host-ledger/ledger')
if os.environ.get('FULLMAG_SESSION_STORAGE_PROFILE')!='linux-native-v1' or os.environ.get('FULLMAG_HOST_LEDGER_ROOT')!='/host-ledger/ledger': fail('selected storage profile is not Linux-native')
certificate_path=pathlib.Path(os.environ['FULLMAG_HOST_CERTIFICATE'])
if (not certificate_path.is_absolute() or certificate_path.parent!=state
    or certificate_path.name!='linux-native-host.json'): fail('host certificate is not the selected state certificate')
ledger_fd=lock(ledger/'WRITER.lock','host ledger writer lock')
try:
 store_fd=lock(store/'WRITER.lock','accepted-store writer lock')
 try:
  host_digest,host_raw=regular(certificate_path,1024*1024)
  owner_digest,owner_raw=regular(state/'.fullmag-linux-native-owner.json',1024*1024)
  host=obj(host_raw,'Linux host certificate');owner=obj(owner_raw,'Linux host owner marker')
  state_stat=state.stat();store_stat=store.stat()
  try: identity=_stable_linux_host_identity(host,owner,state_stat.st_dev,state_stat.st_ino,store_stat.st_dev)
  except ValueError as error: fail(str(error))
  stable={'schema':'fullmag.linux-native-store-identity.v1','engine_id':identity['engine_id'],'owner_token':identity['owner_token'],'relative_state_path':'runs/docker-all/session-store'}
  store_id='sha256:'+sha(canon(stable))
  if store_id!=EXPECTED_STORE: fail('Linux-native host ledger store identity differs')
  store_files,store_dirs=walk(store);ledger_raw=regular(ledger/'HOST_RESOURCE_LEDGER.json',8*1024*1024)[1];ledger_doc=obj(ledger_raw,'host resource ledger')
  rows=ledger_doc.get('reservations')
  if not isinstance(rows,list) or len(rows)>MAX_FILES: fail('host ledger reservation inventory is malformed')
  host_id=ledger_doc.get('policy',{}).get('host_id') if isinstance(ledger_doc.get('policy'),dict) else None
  if not isinstance(host_id,str) or not host_id: fail('host ledger identity is missing')
  reservations=[]
  for row in rows:
   if not isinstance(row,dict): fail('host ledger reservation is malformed')
   identity=row.get('identity');sid=identity.get('store_id') if isinstance(identity,dict) else None
   if not isinstance(sid,str) or not re.fullmatch(r'sha256:[0-9a-f]{64}',sid): fail('host reservation store identity is unknown')
   if sid!=store_id: reservations.append({'store_id':sid,'state':row.get('state')});continue
   if row.get('state')!='released': fail('selected session-store host reservation is active or unknown')
   proof_sha=row.get('release_proof_sha256');request_sha=row.get('request_sha256')
   if not isinstance(proof_sha,str) or not re.fullmatch(r'[0-9a-f]{64}',proof_sha) or not isinstance(request_sha,str) or not re.fullmatch(r'[0-9a-f]{64}',request_sha): fail('host reservation release reference is malformed')
   proof_raw=regular(ledger/'proofs'/(proof_sha+'.json'),1024*1024)[1];proof=obj(proof_raw,'host reservation release proof')
   if sha(proof_raw)!=proof_sha or proof.get('schema_version') not in {'host_resource_release_proof.v1','host_resource_release_proof.v2'} or proof.get('host_id')!=host_id or proof.get('store_id')!=store_id or proof.get('request_sha256')!=request_sha: fail('host reservation release proof differs')
   owner=identity.get('owner')
   reservations.append({'store_id':sid,'run_id':identity.get('run_id'),'task_id':identity.get('task_id'),'attempt_id':owner.get('attempt_id') if isinstance(owner,dict) else None,'ownership_epoch':owner.get('ownership_epoch') if isinstance(owner,dict) else None,'resource_id':identity.get('resource_id'),'lease_token':identity.get('lease_token'),'state':'released','release_proof_sha256':proof_sha,'release_proof_raw_sha256':sha(proof_raw)})
  run_root=store/'runs';run_ids=[]
  for entry in os.scandir(run_root):
   if entry.is_symlink() or not entry.is_dir(follow_symlinks=False) or not re.fullmatch(r'run-[A-Za-z0-9_-]{1,128}',entry.name): fail('session run directory is unknown or linked')
   run_ids.append(entry.name)
  run_ids.sort()
  if len(run_ids)>128 or RUN_ID not in run_ids: fail('selected accepted run is absent or inventory is unbounded')
  def record(run,suffix,label):
   item=store_files.get('runs/'+run+'/'+suffix)
   if item is None or item[1] is None: fail(label+' is absent from the locked inventory')
   return {'sha256':item[0],'value':obj(item[1],label)}
  records={name:record(RUN_ID,name,'accepted '+name) for name in ('run_intent.json','run_catalog.json','start_release.json','artifact_catalog.json')}
  tasks=records['run_catalog.json']['value'].get('tasks')
  if not isinstance(tasks,list): fail('selected run catalog task list is malformed')
  resumable={row.get('task_id') for row in tasks if isinstance(row,dict) and row.get('lifecycle') in {'accepted','queued'}}
  target='runs/'+RUN_ID+'/';events=[];exits=[];leases=[];admissions=[];cancellations=[]
  for relative,(digest,raw) in store_files.items():
   if not relative.startswith(target): continue
   suffix=relative[len(target):];parts=suffix.split('/')
   if parts[0] in {'worker-attempts','worker_inbox','worker_process_exit_receipts'} and len(parts)>1 and parts[1] in resumable: fail('Accepted/Queued task has durable worker evidence')
   if parts[0]=='coordinator_journal' and len(parts)>2 and parts[2].endswith('.json'):
    if raw is None: fail('coordinator journal evidence was not captured')
    entry=obj(raw,'coordinator journal entry')
    if any(task_id in json.dumps(entry,ensure_ascii=False) for task_id in resumable): fail('Accepted/Queued task has a durable coordinator command or event')
    if entry.get('direction')=='event': events.append({'sha256':digest,'value':entry})
    elif entry.get('task_id') in resumable or (isinstance(entry.get('payload'),dict) and entry['payload'].get('task_id') in resumable): fail('Accepted/Queued task has a durable coordinator command')
   elif parts[0]=='worker_process_exit_receipts' and suffix.endswith('.json'):
    if raw is None: fail('worker exit receipt was not captured')
    exits.append({'sha256':digest,'value':obj(raw,'worker exit receipt')})
   elif parts[0]=='resource_leases' and suffix.endswith('.json'):
    if raw is None: fail('resource lease was not captured')
    leases.append({'sha256':digest,'value':obj(raw,'resource lease')})
   elif parts[0]=='task_admissions' and suffix.endswith('.json'):
    if raw is None: fail('task admission evidence was not captured')
    admission=obj(raw,'task admission')
    try: admissions.append(_task_admission_identity(admission,relative,RUN_ID))
    except ValueError as error: fail(str(error))
   elif parts[0]=='task_cancellation_intents' and suffix.endswith('.json'):
    if raw is None: fail('cancellation intent was not captured')
    cancellations.append({'sha256':digest,'value':obj(raw,'task cancellation intent')})
   elif parts[0]=='worker_inbox':
    if not suffix.endswith('.json') or raw is None: fail('worker inbox contains an unknown record')
    inbox=obj(raw,'worker inbox record')
    if any(task_id in json.dumps(inbox,ensure_ascii=False) for task_id in resumable): fail('Accepted/Queued task has a worker inbox record')
   elif parts[0] in {'task_admissions','task_cancellation_intents','worker_process_exit_receipts','resource_leases'}:
    fail('accepted run contains an unknown execution-evidence path')
  # Any active local lease, including another run in this selected store, blocks.
  for relative,(digest,raw) in store_files.items():
   parts=relative.split('/')
   if len(parts)>3 and parts[0]=='runs' and parts[2] in {'resource_leases','preparation_resource_leases'} and parts[-1].endswith('.json'):
    if raw is None: fail('session resource lease was not captured')
    lease=obj(raw,'session resource lease')
    if lease.get('state')!='released': fail('selected session store contains an active or unknown lease')
    if parts[2]=='resource_leases' and not relative.startswith(target): leases.append({'sha256':digest,'value':lease})
  other=[]
  for other_id in run_ids:
   if other_id==RUN_ID: continue
   item=store_files.get('runs/'+other_id+'/run_catalog.json')
   if item is None or item[1] is None: fail('other retained run has no catalog')
   catalog=obj(item[1],'other run catalog');other.append({'run_id':other_id,'tasks':catalog.get('tasks')})
  for transient in ('temp','recovery','manifests','live_command_journals','batches'):
   root=store/transient
   if root.exists() and (root.is_symlink() or not root.is_dir() or any(root.iterdir())): fail('pending/unknown native runtime work: '+transient)
  inventory={'files':[(path,digest) for path,(digest,_) in sorted(store_files.items())],'directories':store_dirs}
  result={'schema':'fullmag.failed-run-resume-store-observation.v1','run_id':RUN_ID,'run_directories':run_ids,'records':records,'coordinator_events':events,'worker_exit_receipts':exits,'resource_leases':leases,'task_admissions':admissions,'task_cancellation_intents':cancellations,'host_ledger':{'sha256':sha(ledger_raw),'store_id':store_id,'reservations':reservations},'other_run_catalogs':other,'store_inventory_sha256':sha(canon(inventory))}
  print(json.dumps(result,ensure_ascii=False,sort_keys=True,separators=(',',':')))
 finally: fcntl.flock(store_fd,fcntl.LOCK_UN);os.close(store_fd)
finally: fcntl.flock(ledger_fd,fcntl.LOCK_UN);os.close(ledger_fd)
'''
    helper = (inspect.getsource(_stable_linux_host_identity) + "\n"
              + inspect.getsource(_task_admission_identity))
    anchor = "state=pathlib.Path('/state');store=state/'runs/docker-all/session-store';ledger=pathlib.Path('/host-ledger/ledger')"
    if anchor not in script:
        _fail("accepted-store observer no longer has its host-identity insertion point")
    return script.replace(anchor, helper + "\n" + anchor, 1)


def _retained_certificate_bind_source(backend, compose, state_source):
    """Authenticate the read-only certificate bind without the writable-bind helper."""
    if not isinstance(backend, Mapping) or not isinstance(compose, Mapping):
        _fail("retained Linux certificate bind metadata is missing")
    services = compose.get("services")
    service = services.get("backend") if isinstance(services, Mapping) else None
    volumes = service.get("volumes") if isinstance(service, Mapping) else None
    if not isinstance(volumes, list):
        _fail("retained Compose backend bind inventory is missing")
    specs = [mount for mount in volumes if isinstance(mount, Mapping)
             and mount.get("target") == LINUX_CERTIFICATE_TARGET]
    if len(specs) != 1:
        _fail("retained Compose must have one Linux host certificate bind")
    spec = specs[0]
    expected_source = str(Path(state_source) / LINUX_CERTIFICATE_NAME)
    source = spec.get("source")
    if (spec.get("type") != "bind" or spec.get("read_only") is not True
            or not isinstance(source, str) or source != expected_source
            or not Path(source).is_absolute() or ".." in Path(source).parts
            or "\\" in source):
        _fail("retained Compose certificate bind differs from the selected state source")

    mounts = backend.get("Mounts")
    if not isinstance(mounts, list):
        _fail("retained backend mount inventory is missing")
    actual = [mount for mount in mounts if isinstance(mount, Mapping)
              and mount.get("Destination") == LINUX_CERTIFICATE_TARGET]
    if len(actual) != 1:
        _fail("retained backend must have one Linux host certificate mount")
    mounted = actual[0]
    actual_source = mounted.get("Source")
    if (mounted.get("Type") != "bind" or mounted.get("RW") is not False
            or not isinstance(actual_source, str) or not actual_source):
        _fail("retained backend Linux host certificate mount is not read-only")
    daemon_binds = service.get("x-fullmag-daemon-binds", {})
    if not isinstance(daemon_binds, Mapping):
        _fail("retained Compose daemon bind inventory is malformed")
    if LINUX_CERTIFICATE_TARGET in daemon_binds:
        if daemon_binds[LINUX_CERTIFICATE_TARGET] != actual_source:
            _fail("retained certificate daemon bind alias differs from the inspected mount")
    elif actual_source != source:
        _fail("retained certificate mount has no matching daemon bind alias")
    return source


def capture_accepted_run_snapshot(control, backend, compose, run_id):
    """Capture and validate a read-only snapshot from the pinned Linux group mounts."""
    if not isinstance(run_id, str) or RUN_ID_RE.fullmatch(run_id) is None:
        _fail("accepted run ID is malformed")
    if not isinstance(backend, Mapping) or not isinstance(compose, Mapping):
        _fail("accepted-store capture requires pinned backend and Compose metadata")
    from docker_volume_container_recovery import _bind_source, _ledger_snapshot_mount
    try:
        state_source = _bind_source(backend, "/state")
        ledger_mount, descriptor = _ledger_snapshot_mount(control, backend, compose)
    except Exception as error:
        raise BuildControlError("retained state/ledger mounts cannot be authenticated") from error
    if state_source.startswith("/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/"):
        backend_service = compose.get("services", {}).get("backend", {})
        declarations = backend_service.get("volumes", [])
        sources = [mount.get("source") for mount in declarations
                   if isinstance(mount, Mapping) and mount.get("target") == "/state" and mount.get("type") == "bind"]
        daemon_binds = backend_service.get("x-fullmag-daemon-binds", {})
        if len(sources) != 1 or not isinstance(daemon_binds, Mapping) or daemon_binds.get("/state") != state_source:
            _fail("daemon state alias is not bound to one retained Linux source")
        state_source = sources[0]
    if (not isinstance(state_source, str) or not state_source.startswith("/")
            or ".." in Path(state_source).parts or "\\" in state_source):
        _fail("retained Linux state bind is not a canonical absolute path")
    service = compose.get("services", {}).get("backend", {})
    environment = service.get("environment", {}) if isinstance(service, Mapping) else {}
    if (not isinstance(environment, Mapping)
            or environment.get("FULLMAG_SESSION_STORAGE_PROFILE") != "linux-native-v1"
            or "FULLMAG_HOST_CERTIFICATE" in environment):
        _fail("selected state does not have the retained Linux-native certificate profile")
    _retained_certificate_bind_source(backend, compose, state_source)
    from docker_volume_dev import _retained_certificate
    try:
        host_certificate = _retained_certificate(Path(state_source), compose)
    except Exception as error:
        raise BuildControlError("retained Linux host certificate is not valid for the selected state") from error
    stable_store = {
        "schema": "fullmag.linux-native-store-identity.v1",
        "engine_id": host_certificate.get("engine_id"),
        "owner_token": host_certificate.get("owner_token"),
        "relative_state_path": "runs/docker-all/session-store",
    }
    store_id = "sha256:" + hashlib.sha256(canonical(stable_store)).hexdigest()
    image = backend.get("Image")
    if not isinstance(image, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        _fail("retained backend image identity is not immutable")
    if descriptor is not None:
        _fail("preserving resume does not support an external host-ledger descriptor")
    from docker_dev_host import docker_argv
    command = [
        *docker_argv("run"), "--rm", "-i", "--pull", "never", "--network", "none",
        "--runtime", "runc", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true", "--pids-limit", "32",
  "--memory", "256m", "--cpus", "0.5", "--env", "NVIDIA_VISIBLE_DEVICES=void",
        "--env", "FULLMAG_SESSION_STORAGE_PROFILE=linux-native-v1",
        "--env", "FULLMAG_HOST_LEDGER_ROOT=/host-ledger/ledger",
        "--env", "FULLMAG_HOST_CERTIFICATE=/state/" + LINUX_CERTIFICATE_NAME,
        "--env", "FULLMAG_RESUME_RUN_ID=" + run_id,
        "--env", "FULLMAG_RESUME_STORE_ID=" + store_id,
        "--label", "com.docker.compose.project=" + control.project,
        "--label", "com.docker.compose.service=host-runtime-maintenance",
        "--label", "org.fullmag.compose.project=" + control.project,
        "--mount", "type=bind,src=" + state_source + ",dst=/state,readonly",
        "--mount", ledger_mount, "--user", "65532:65532",
        "--entrypoint", "/usr/local/bin/python3", image, "-B", "-c", _accepted_store_script(),
    ]
    result = bounded_capture(command, data=b"", timeout=150, maximum=MAX_CAPTURE_BYTES)
    if result.returncode:
        raise BuildControlError("accepted store observation failed: "
                                + result.stderr.decode("utf-8", "replace")[-2048:])
    try:
        snapshot = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("accepted store observer returned invalid JSON") from error
    if (not isinstance(snapshot, Mapping)
            or snapshot.get("schema") != "fullmag.failed-run-resume-store-observation.v1"
            or snapshot.get("run_id") != run_id):
        _fail("accepted store observer returned a foreign snapshot")
    from docker_volume_failed_run_resume import validate_accepted_run_snapshot
    validate_accepted_run_snapshot(snapshot, run_id=run_id)
    return dict(snapshot)
