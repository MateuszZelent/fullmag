"""Read-only evidence capture for one failed held-UI startup retry."""
from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping

from docker_build_control import BuildControlError, canonical, docker_capture

OBSERVATION_SCHEMA = "fullmag.held-ui-start-retry-observation.v1"
MAX_INPUT_BYTES = 512 * 1024
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
STORE_REL = "runs/docker-all/session-store"
STORE_PATH = "/state/" + STORE_REL
SHA = re.compile(r"[0-9a-f]{64}\Z")
TOKEN = re.compile(r"[0-9a-f]{32}\Z")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")

DEFAULT_ROOTS = {
    "runtime": "/opt/fullmag/runtime-control",
    "control": "/opt/fullmag/control",
    "state": "/state",
    "ledger": "/host-ledger/ledger",
    "proc": "/proc",
    "host_identity": "/run/fullmag/linux-native-host.json",
}

PROBE = r'''import fcntl,hashlib,json,os,pathlib,re,stat,sys
ROOTS=__ROOTS__
MAX_INPUT=524288
MAX_RECORD=8*1024*1024
MAX_OBJECT=64*1024*1024
MAX_ITEMS=4096
HELD_FDS=[]
RUN_ID_RE=re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
UUID_RE=re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SHA_RE=re.compile(r"^[0-9a-f]{64}$")
BINARY="/opt/fullmag/package/bin/fullmag-api"
STORE_REL="runs/docker-all/session-store"
STORE_PATH="/state/"+STORE_REL
def fail(message): raise RuntimeError("held retry probe: "+message)
def unique(pairs):
 result={}
 for key,value in pairs:
  if key in result: fail("duplicate JSON object key")
  result[key]=value
 return result
def canon(value):
 try: return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":"),allow_nan=False).encode("utf-8")
 except (TypeError,ValueError,UnicodeError) as error: raise RuntimeError("held retry probe: noncanonical JSON") from error
def digest(raw): return hashlib.sha256(raw).hexdigest()
def parse(raw,label):
 if not isinstance(raw,bytes) or len(raw)>MAX_RECORD: fail(label+" exceeds its bounded read")
 try: value=json.loads(raw.decode("utf-8"),object_pairs_hook=unique,parse_constant=lambda _:fail(label+" contains a nonfinite number"))
 except (UnicodeDecodeError,json.JSONDecodeError) as error: raise RuntimeError("held retry probe: "+label+" is invalid JSON") from error
 if not isinstance(value,dict): fail(label+" is not an object")
 return value
def open_dir(path):
 p=pathlib.PurePosixPath(str(path))
 if not p.is_absolute() or ".." in p.parts or str(p)!=str(path): fail("unsafe absolute directory path")
 flags=os.O_RDONLY|getattr(os,"O_DIRECTORY",0)|getattr(os,"O_CLOEXEC",0)|getattr(os,"O_NOFOLLOW",0)
 fd=os.open("/",flags)
 try:
  for part in p.parts[1:]:
   if part in ("",".",".."): fail("unsafe directory component")
   next_fd=os.open(part,flags,dir_fd=fd)
   if not stat.S_ISDIR(os.fstat(next_fd).st_mode): os.close(next_fd); fail("path parent is not a directory")
   os.close(fd); fd=next_fd
  return fd
 except BaseException:
  os.close(fd); raise
def _read_fd(fd,maximum,label,single_link=True):
 before=os.fstat(fd)
 if not stat.S_ISREG(before.st_mode) or (single_link and before.st_nlink!=1) or before.st_size>maximum:
  fail(label+" is linked, nonregular, or oversized")
 chunks=[]; total=0
 while True:
  chunk=os.read(fd,min(65536,maximum+1-total))
  if not chunk: break
  chunks.append(chunk); total+=len(chunk)
  if total>maximum: fail(label+" exceeds its byte limit")
 after=os.fstat(fd)
 stable=(before.st_dev,before.st_ino,before.st_mode,before.st_nlink,before.st_size,before.st_mtime_ns,before.st_ctime_ns)
 fresh=(after.st_dev,after.st_ino,after.st_mode,after.st_nlink,after.st_size,after.st_mtime_ns,after.st_ctime_ns)
 if fresh!=stable: fail(label+" changed during its bounded read")
 return b"".join(chunks)
def read_abs(path,maximum=MAX_RECORD,label="record",optional=False,single_link=True):
 p=pathlib.PurePosixPath(str(path))
 if not p.is_absolute() or ".." in p.parts or str(p)!=str(path) or len(p.parts)<2: fail(label+" path is unsafe")
 parent=open_dir(str(p.parent))
 try:
  try: fd=os.open(p.name,os.O_RDONLY|getattr(os,"O_CLOEXEC",0)|getattr(os,"O_NOFOLLOW",0),dir_fd=parent)
  except FileNotFoundError:
   if optional: return None
   raise
 finally: os.close(parent)
 try: return _read_fd(fd,maximum,label,single_link)
 finally: os.close(fd)
def read_rel(root,relative,maximum=MAX_RECORD,label="record",optional=False,single_link=True):
 if not isinstance(relative,str) or not relative or relative.startswith("/") or "\\" in relative: fail(label+" relative path is unsafe")
 p=pathlib.PurePosixPath(relative)
 if str(p)!=relative or ".." in p.parts or any(part in ("",".") for part in p.parts): fail(label+" relative path is unsafe")
 return read_abs(str(pathlib.PurePosixPath(root)/p),maximum,label,optional,single_link)
def list_dir(path,label):
 fd=open_dir(path)
 try:
  names=os.listdir(fd)
  if len(names)>MAX_ITEMS: fail(label+" exceeds its entry bound")
  result=[]
  for name in names:
   metadata=os.stat(name,dir_fd=fd,follow_symlinks=False)
   if stat.S_ISLNK(metadata.st_mode): fail(label+" contains a symlink")
   result.append((name,metadata))
  return result
 finally: os.close(fd)
def load_json(path,label,maximum=MAX_RECORD,canonical_lf=False,optional=False):
 raw=read_abs(path,maximum,label,optional)
 if raw is None: return None,None
 value=parse(raw,label)
 if canonical_lf and raw!=canon(value)+b"\n": fail(label+" is not canonical JSON plus LF")
 return raw,value
def valid_hash(value,label):
 if not isinstance(value,str) or SHA_RE.fullmatch(value) is None: fail(label+" is not lowercase SHA-256")
 return value
def accepted_binding(path):
 if not isinstance(path,str) or not path.startswith("/") or path.endswith("/") or ".." in pathlib.PurePosixPath(path).parts: return None
 return digest(b"fullmag.accepted-store-binding.v1\0"+os.fsencode(path+"/"))
def expected_request(payload):
 request=payload.get("request")
 if not isinstance(request,dict) or set(request)!={"schema","plan","source_scope","stop_authority","accepted"}: fail("request envelope fields differ")
 if request.get("schema")!="fullmag.held-ui-materialization-request.v1": fail("request schema differs")
 plan=request["plan"]
 if not isinstance(plan,dict) or set(plan)!={"attempt","plan_sha256","maintenance_request_id"}: fail("request plan fields differ")
 if not isinstance(plan["attempt"],str) or re.fullmatch(r"[0-9a-f]{32}",plan["attempt"]) is None: fail("request attempt is malformed")
 valid_hash(plan["plan_sha256"],"request plan digest")
 maintenance_id=plan["maintenance_request_id"]
 if not isinstance(maintenance_id,str) or UUID_RE.fullmatch(maintenance_id) is None: fail("maintenance UUID is malformed")
 accepted=request["accepted"]
 if not isinstance(accepted,dict) or not isinstance(accepted.get("run_id"),str) or RUN_ID_RE.fullmatch(accepted["run_id"]) is None: fail("accepted run identity is malformed")
 for key in ("run_intent_sha256","run_intent_payload_sha256","definition_sha256","study_sha256","execution_input_sha256","accepted_scene_sha256","request_receipt_sha256"):
  valid_hash(accepted.get(key),"accepted "+key)
 if accepted.get("command_kind")!="relax": fail("accepted command kind is not the pinned Relax")
 return request,maintenance_id
def verify_authority(request,maintenance_id):
 root="held-ui-materialization/"+maintenance_id
 request_raw,stored=load_json(str(pathlib.PurePosixPath(ROOTS["runtime"])/root/"request.json"),"immutable held request",64*1024,True)
 if stored!=request: fail("stored immutable request differs")
 authority=request.get("stop_authority")
 if not isinstance(authority,dict): fail("stop authority is malformed")
 refs={"preflight":root+"/preflight.json","inventory":root+"/inventory.json","api_quiescence":root+"/api-quiescence.json","native_drain":root+"/native-drain.json"}
 proofs={}
 for key,path in refs.items():
  ref=authority.get(key)
  if not isinstance(ref,dict) or set(ref)!={"path","sha256"} or ref.get("path")!=path: fail(key+" proof path differs")
  proof_raw,proof=load_json(str(pathlib.PurePosixPath(ROOTS["runtime"])/path),key+" proof",MAX_RECORD,True)
  if digest(proof_raw)!=valid_hash(ref.get("sha256"),key+" proof digest"): fail(key+" proof bytes changed")
  proofs[key]=proof
 stop_attempt=authority.get("stop_attempt")
 terminal=authority.get("terminal")
 if not isinstance(stop_attempt,str) or re.fullmatch(r"[0-9a-f]{32}",stop_attempt) is None: fail("stop attempt is malformed")
 terminal_path="held-ui-materialization-stop/attempts/"+stop_attempt+"/terminal.json"
 if not isinstance(terminal,dict) or set(terminal)!={"path","sha256"} or terminal.get("path")!=terminal_path: fail("outer stop terminal path differs")
 terminal_raw,_=load_json(str(pathlib.PurePosixPath(ROOTS["control"])/terminal_path),"outer stop terminal",MAX_RECORD,True)
 if digest(terminal_raw)!=valid_hash(terminal.get("sha256"),"outer stop terminal digest"): fail("outer stop terminal bytes changed")
 accepted=request["accepted"]; preflight=proofs["preflight"]
 if (preflight.get("schema")!="fullmag.held-ui-materialization-preflight.v1"
     or preflight.get("source_scope")!=request.get("source_scope")
     or preflight.get("run_intent_sha256")!=accepted["run_intent_sha256"]
     or preflight.get("execution_input_sha256")!=accepted["execution_input_sha256"]): fail("pinned preflight differs from accepted scope")
 inventory=proofs["inventory"]
 if inventory.get("schema")!="fullmag.held-ui-materialization-inventory.v1" or inventory.get("before")!=inventory.get("after"):
  fail("pinned accepted-store inventory is not a stable snapshot")
 return proofs
def acquire_lock(path,label,held):
 p=pathlib.PurePosixPath(path); parent=open_dir(str(p.parent))
 try: fd=os.open(p.name,os.O_RDONLY|getattr(os,"O_CLOEXEC",0)|getattr(os,"O_NOFOLLOW",0),dir_fd=parent)
 finally: os.close(parent)
 try:
  metadata=os.fstat(fd)
  if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink!=1: fail(label+" lock is linked or nonregular")
  try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except OSError as error: raise RuntimeError("held retry probe: "+label+" lock is busy or unknown") from error
  held.append(fd)
  return {"device":metadata.st_dev,"inode":metadata.st_ino,"unlocked":True}
 except BaseException:
  if fd not in held: os.close(fd)
  raise
def take_locks(held,ledger_root):
 state=ROOTS["state"]; store=str(pathlib.PurePosixPath(state)/STORE_REL)
 service_root=str(pathlib.PurePosixPath(store)/"runtime-services")
 records={}
 paths=((str(pathlib.PurePosixPath(ledger_root)/"WRITER.lock"),"ledger-writer"),
        (str(pathlib.PurePosixPath(ledger_root)/"HOST_INVENTORY_OWNER.lock"),"host_inventory_owner"),
        (str(pathlib.PurePosixPath(store)/"WRITER.lock"),"store-writer"),
        (service_root+"/OWNER.lock","owner"),
        (service_root+"/STARTUP-GATE.lock","startup_gate"),
        (service_root+"/LAUNCH.lock","launch"))
 for path,name in paths:
  identity=acquire_lock(path,name+" lock",held)
  if name in ("owner","startup_gate","launch","host_inventory_owner"): records[name]=identity
 return records
def process_pin(pid,fence_relative):
 if type(pid)is not int or pid<=1: fail("diagnostic API PID is invalid")
 root=str(pathlib.PurePosixPath(ROOTS["proc"])/str(pid))
 raw=read_rel(ROOTS["proc"],str(pid)+"/stat",8192,"API process stat",single_link=False)
 text=raw.decode("ascii","strict"); close=text.rfind(")")
 if close<0 or not text.startswith(str(pid)+" ("): fail("API process stat is malformed")
 fields=text[close+2:].split()
 if len(fields)<=19 or not fields[19].isdigit() or int(fields[19])<=0: fail("API process start token is malformed")
 if len(fields)<2 or not fields[1].isdigit() or int(fields[1])<=0: fail("API process parent identity is malformed")
 cmdline=read_rel(ROOTS["proc"],str(pid)+"/cmdline",4096,"API process command line",single_link=False)
 if cmdline!=BINARY.encode()+b"\0": fail("diagnostic API command line differs")
 if os.readlink(root+"/exe")!=BINARY: fail("diagnostic API executable differs")
 namespace=os.readlink(root+"/ns/pid")
 if re.fullmatch(r"pid:\[[0-9]+\]",namespace) is None: fail("diagnostic API PID namespace is malformed")
 boot=read_rel(ROOTS["proc"],"sys/kernel/random/boot_id",128,"kernel boot identity",single_link=False).decode("ascii","strict").strip()
 if UUID_RE.fullmatch(boot) is None: fail("kernel boot identity is malformed")
 environ=read_rel(ROOTS["proc"],str(pid)+"/environ",256*1024,"API process environment",single_link=False)
 fence_values=[item.split(b"=",1)[1].decode("utf-8","strict") for item in environ.split(b"\0") if item.startswith(b"FULLMAG_API_RUNTIME_FAILURE_FENCE=")]
 if fence_values!=["/opt/fullmag/"+fence_relative]: fail("API process failure-fence environment differs")
 return {"pid":pid,"start_token":fields[19],"ppid":int(fields[1]),"argv":[BINARY],"exe":BINARY,"boot_id":boot,"pid_namespace":namespace}
def scan_native_processes(api_pid):
 root_fd=open_dir(ROOTS["proc"])
 try: names=os.listdir(root_fd)
 finally: os.close(root_fd)
 for name in names:
  if not name.isdigit(): continue
  pid=int(name)
  if pid in (api_pid,os.getpid()): continue
  root_fd=open_dir(ROOTS["proc"])
  try:
   try: metadata=os.stat(name,dir_fd=root_fd,follow_symlinks=False)
   except FileNotFoundError: continue
  finally: os.close(root_fd)
  if stat.S_ISLNK(metadata.st_mode): fail("numeric process entry is a symlink")
  if not stat.S_ISDIR(metadata.st_mode): continue
  path=str(pathlib.PurePosixPath(ROOTS["proc"])/name)
  try: exe=os.readlink(path+"/exe")
  except FileNotFoundError: continue
  except PermissionError: fail("cannot inspect a process while excluding native workers")
  if re.fullmatch(r"/opt/fullmag/package/bin/fullmag-[A-Za-z0-9._-]+",exe):
   fail("another native worker or service process is present")
  try: cmdline=read_rel(ROOTS["proc"],name+"/cmdline",128*1024,"process command line",single_link=False)
  except FileNotFoundError: continue
  argv=[argument for argument in cmdline.split(b"\0") if argument]
  if any(re.fullmatch(rb"/opt/fullmag/package/bin/fullmag-[A-Za-z0-9._-]+",argument) for argument in argv):
   fail("another native worker or service process is present")
def store_id(store,state,mode):
 host=parse(read_abs(ROOTS["host_identity"],65536,"native host identity"),"native host identity")
 owner=parse(read_abs(str(pathlib.PurePosixPath(state)/".fullmag-linux-native-owner.json"),65536,"native store owner"),"native store owner")
 if (host!=owner or host.get("schema")!="fullmag.linux-native-host.v1" or host.get("storage_profile")!="linux-native-v1"
     or host.get("role")!="session" or host.get("owner_scope")!="docker-linux"
     or type(host.get("restart_verified")) is not bool
     or (mode!="archived" and host.get("restart_verified") is not True)
     or not isinstance(host.get("owner_token"),str) or re.fullmatch(r"[0-9a-f]{32}",host["owner_token"]) is None
     or not isinstance(host.get("engine_id"),str) or not host["engine_id"]): fail("native accepted-store identity differs")
 identity={"schema":"fullmag.linux-native-store-identity.v1","engine_id":host["engine_id"],
           "owner_token":host["owner_token"],"relative_state_path":STORE_REL}
 return "sha256:"+digest(canon(identity))
def release_snapshot(ledger_root,store):
 ledger=parse(read_abs(ledger_root+"/HOST_RESOURCE_LEDGER.json",16*1024*1024,"host resource ledger"),"host resource ledger")
 rows=ledger.get("reservations")
 if (ledger.get("schema_version")!="host_resource_ledger.v4" or not isinstance(ledger.get("policy"),dict)
     or not isinstance(rows,list) or len(rows)>8192): fail("host resource ledger schema differs")
 refs=[]
 for row in rows:
  if not isinstance(row,dict) or row.get("state")!="released" or not isinstance(row.get("identity"),dict): fail("host reservation is not released")
  proof_sha=valid_hash(row.get("release_proof_sha256"),"release proof digest")
  proof_raw=read_abs(ledger_root+"/proofs/"+proof_sha+".json",65536,"host release proof")
  proof=parse(proof_raw,"host release proof")
  if (digest(proof_raw)!=proof_sha or proof.get("schema_version") not in ("host_resource_release_proof.v1","host_resource_release_proof.v2")
      or proof.get("host_id")!=ledger["policy"].get("host_id")
      or proof.get("store_id")!=row["identity"].get("store_id")
      or proof.get("request_sha256")!=row.get("request_sha256")): fail("host release proof identity differs")
  refs.append([row["identity"],row["request_sha256"],proof_sha])
 runs_root=str(pathlib.PurePosixPath(store)/"runs"); leases=[]; count=0
 for run,metadata in list_dir(runs_root,"released run inventory"):
  count+=1
  if count>8192 or not stat.S_ISDIR(metadata.st_mode): fail("released run inventory is invalid")
  for directory in ("resource_leases","preparation_resource_leases"):
   lease_root=str(pathlib.PurePosixPath(runs_root)/run/directory)
   try: resources=list_dir(lease_root,"local lease root")
   except FileNotFoundError: continue
   for resource,resource_meta in resources:
    count+=1
    if count>8192 or not stat.S_ISDIR(resource_meta.st_mode): fail("local lease resource directory is invalid")
    resource_root=lease_root+"/"+resource
    for name,file_meta in list_dir(resource_root,"local lease directory"):
     count+=1
     if count>8192 or not stat.S_ISREG(file_meta.st_mode) or not name.endswith(".json"): fail("local lease inventory is invalid")
     path=resource_root+"/"+name; raw=read_abs(path,262144,"local resource lease")
     value=parse(raw,"local resource lease")
     if value.get("state")!="released": fail("local resource lease is active")
     relative=str(pathlib.PurePosixPath(path).relative_to(store))
     leases.append([relative,digest(raw)])
 result={"schema":"fullmag.pre-ack-released-observation.v1",
         "reservations":sorted(refs,key=lambda row:json.dumps(row[0],sort_keys=True)),
         "leases":sorted(leases),"active_count":0}
 return result
def run_store_snapshot(request,proofs,mode):
 accepted=request["accepted"]; run_id=accepted["run_id"]; state=ROOTS["state"]
 store=str(pathlib.PurePosixPath(state)/STORE_REL); run_root=store+"/runs/"+run_id
 entries=list_dir(run_root,"accepted run")
 if sorted(name for name,_ in entries)!=["live_demand.v1.json","run_intent.json"]:
  fail("accepted run has a catalog, release, attempt, worker, output, or unknown file")
 intent_raw=read_abs(run_root+"/run_intent.json",MAX_RECORD,"accepted RunIntent")
 intent=parse(intent_raw,"accepted RunIntent")
 demand_raw=read_abs(run_root+"/live_demand.v1.json",64*1024,"accepted live demand")
 demand=parse(demand_raw,"accepted live demand")
 if (demand.get("schema_version")!="fullmag.accepted_live_demand.v1" or demand.get("run_id")!=run_id
     or not isinstance(demand.get("quantities"),list) or len(demand["quantities"])>64
     or any(not isinstance(item,str) or not item.strip() or len(item)>256 for item in demand["quantities"])):
  fail("accepted live demand identity differs")
 spec=intent.get("specification"); live=spec.get("parameters",{}).get("live_workspace",{}) if isinstance(spec,dict) else {}
 receipt=live.get("request_receipt"); execution=live.get("execution_input")
 snapshot=spec.get("snapshot",{}) if isinstance(spec,dict) else {}; study=spec.get("study",{}) if isinstance(spec,dict) else {}
 command=live.get("command")
 if (intent.get("schema_version")!="run_intent.v1" or intent.get("run_id")!=run_id
     or not isinstance(spec,dict) or spec.get("run_id")!=run_id or digest(intent_raw)!=accepted["run_intent_sha256"]
     or intent.get("payload_sha256")!=accepted["run_intent_payload_sha256"]
     or live.get("api_instance_id")!=accepted["old_api_instance_id"]
     or live.get("session_id")!=accepted["session_id"] or live.get("session_epoch")!=accepted["session_epoch"]
     or live.get("scene_revision")!=accepted["scene_revision"]
     or not isinstance(command,dict) or command.get("command_id")!=accepted["command_id"]
     or command.get("kind")!=accepted["command_kind"] or command.get("client_intent_id")!=accepted["client_intent_id"]
     or not isinstance(receipt,dict) or receipt.get("request_id")!=accepted["request_id"]
     or receipt.get("request_sha256")!=accepted["request_sha256"] or receipt.get("key_sha256")!=accepted["request_key_sha256"]
     or receipt.get("command_id")!=accepted["command_id"] or receipt.get("command_kind")!=accepted["command_kind"]
     or receipt.get("client_intent_id")!=accepted["client_intent_id"]
     or digest(canon(receipt))!=accepted["request_receipt_sha256"]
     or not isinstance(execution,dict) or execution.get("schema_version")!="fullmag.scene_execution_input.v1"
     or execution.get("sha256")!=accepted["execution_input_sha256"]
     or intent.get("definition_object_ref")!=accepted["definition_sha256"]
     or intent.get("study_object_ref")!=accepted["study_sha256"]
     or snapshot.get("project_id")!=accepted["project_id"]
     or snapshot.get("definition_sha256")!=accepted["definition_sha256"]
     or study.get("plan_sha256")!=accepted["study_sha256"]): fail("accepted RunIntent or request receipt changed")
 for ref in (accepted["definition_sha256"],accepted["study_sha256"]):
  valid_hash(ref,"accepted CAS reference")
  if digest(read_abs(store+"/objects/sha256/"+ref,MAX_OBJECT,"accepted CAS object"))!=ref:
   fail("accepted definition or Study CAS bytes differ")
 others=[]; runs_root=store+"/runs"
 for name,metadata in list_dir(runs_root,"accepted run inventory"):
  if name==run_id: continue
  if not stat.S_ISDIR(metadata.st_mode): fail("accepted run inventory contains a non-directory")
  catalog_raw=read_abs(runs_root+"/"+name+"/run_catalog.json",MAX_RECORD,"other run catalog",optional=True)
  if catalog_raw is None: others.append(name); continue
  try: catalog=parse(catalog_raw,"other run catalog")
  except Exception: others.append(name); continue
  tasks=catalog.get("tasks"); terminal={"succeeded","failed","cancelled","rejected"}
  if (catalog.get("schema_version")!="run_catalog.v1" or catalog.get("run_id")!=name
      or not isinstance(tasks,list) or not tasks
      or any(not isinstance(task,dict) or task.get("lifecycle") not in terminal for task in tasks)):
   others.append(name)
 if len(others)>256: fail("other active run inventory exceeds its bound")
 files=[{"name":"live_demand.v1.json","sha256":digest(demand_raw)},{"name":"run_intent.json","sha256":digest(intent_raw)}]
 result={"run_id":run_id,"store_id":store_id(store,state,mode),
  "run_intent_sha256":digest(intent_raw),"run_intent_payload_sha256":intent.get("payload_sha256"),
  "definition_sha256":intent.get("definition_object_ref"),"study_sha256":intent.get("study_object_ref"),
  "execution_input":{"schema_version":execution["schema_version"],"sha256":execution["sha256"]},
  "run_files":files,"run_catalog_absent":True,"start_release_absent":True,"pending_materialization":True,
  "task_attempts":[],"leases":[],"workers":[],"outputs":[],"other_active_runs":sorted(others)}
 if proofs["inventory"].get("after")!=result: fail("accepted store differs from its immutable inventory proof")
 return result
def main():
 raw=sys.stdin.buffer.read(MAX_INPUT+1)
 if len(raw)>MAX_INPUT: fail("probe input exceeds its byte limit")
 payload=json.loads(raw.decode("utf-8"),object_pairs_hook=unique,parse_constant=lambda _:fail("probe input contains a nonfinite number"))
 mode=payload.get("mode")
 if mode not in ("live","stopped","archived"): fail("probe mode is invalid")
 request,maintenance_id=expected_request(payload)
 runtime_root=ROOTS["runtime"]; state=ROOTS["state"]
 ledger_root=ROOTS["ledger"]; expected=payload.get("expected")
 if mode=="archived":
  attempt=payload.get("archive_attempt")
  if not isinstance(attempt,str) or re.fullmatch(r"[0-9a-f]{32}",attempt) is None: fail("archive attempt is malformed")
  runtime_path=pathlib.PurePosixPath(runtime_root)
  if runtime_path.name!=attempt or runtime_path.parent.name!="runtime-archives": fail("archive runtime root differs from the explicit attempt")
  if ledger_root!=runtime_root+"/group-ledger": fail("archive group-ledger root differs from its runtime archive")
  if not isinstance(expected,dict) or set(expected)!={"runtime","native_locks"} or not isinstance(expected.get("runtime"),dict): fail("archived comparison pins are missing")
 else:
  attempt=None
 native_locks=take_locks(HELD_FDS,ledger_root)
 request_dir=str(pathlib.PurePosixPath(runtime_root)/"held-ui-materialization"/maintenance_id)
 ack_prefix="restore-ack-"
 for name,metadata in list_dir(request_dir,"held request directory"):
  if name.startswith(ack_prefix) and name.endswith(".json"): fail("held UI restore acknowledgement already exists")
  if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink!=1: fail("held request directory contains an unsafe entry")
 proofs=verify_authority(request,maintenance_id)
 launch_raw,launch=load_json(request_dir+"/launch.json","immutable held launch",MAX_RECORD,True)
 request_raw=read_abs(request_dir+"/request.json",64*1024,"immutable held request")
 target=launch.get("input",{}).get("target_runtime") if isinstance(launch.get("input"),dict) else None
 if (launch.get("schema")!="fullmag.held-ui-materialization-launch.v1"
     or not isinstance(launch.get("launch_id"),str) or UUID_RE.fullmatch(launch["launch_id"]) is None
     or launch.get("request_path")!="held-ui-materialization/"+maintenance_id+"/request.json"
     or launch.get("request_sha256")!=digest(request_raw) or not isinstance(target,dict)
     or set(target)!={"build_id","source_sha256","image_id","config_sha256","accepted_store_binding"}):
  fail("held launch identity or target runtime differs")
 private=launch.get("input")
 private_expected={**request,"schema":"fullmag.development-held-ui-materialization-restore.v1",
                   "launch_id":launch["launch_id"],"target_runtime":target}
 if private!=private_expected or launch.get("input_sha256")!=digest(canon(private)+b"\n"):
  fail("held launch input differs from the exact request")
 for key in ("source_sha256","config_sha256","accepted_store_binding"): valid_hash(target.get(key),"target runtime "+key)
 if not isinstance(target.get("build_id"),str) or not target["build_id"]: fail("target runtime build identity is malformed")
 if not isinstance(target.get("image_id"),str) or re.fullmatch(r"sha256:[0-9a-f]{64}",target["image_id"]) is None: fail("target runtime image identity is malformed")
 if payload.get("container_image_id") is not None and payload["container_image_id"]!=target["image_id"]: fail("target runtime image differs from the exact container")
 config_raw=read_abs(runtime_root+"/runtime-service/docker-all.json",64*1024,"native runtime config")
 config=parse(config_raw,"native runtime config")
 if config.get("store_root")!=STORE_PATH: fail("accepted store path differs from native config")
 config_sha=digest(config_raw)
 valid_hash(proofs["preflight"].get("native_config_sha256"),"preflight native config digest")
 if (config_sha!=target["config_sha256"]
     or accepted_binding(config["store_root"])!=target["accepted_store_binding"]
     or target["accepted_store_binding"]!=proofs["preflight"].get("accepted_store_binding")):
  fail("native runtime config or accepted store binding differs")
 if mode!="archived":
  provenance=parse(read_abs(ROOTS["control"]+"/backend/runtime-provenance.json",64*1024,"runtime provenance"),"runtime provenance")
  if (provenance.get("schema")!="fullmag.docker-all-image.v1" or provenance.get("state")!="succeeded"
      or provenance.get("commit")!=target["build_id"] or provenance.get("source_snapshot_sha256")!=target["source_sha256"]
      or provenance.get("image_id")!=target["image_id"]): fail("target runtime differs from succeeded build provenance")
 store_snapshot=run_store_snapshot(request,proofs,mode)
 if mode=="live":
  process_raw=read_abs(runtime_root+"/runtime-service/process-tree.json",64*1024,"diagnostic process receipt")
  process=parse(process_raw,"diagnostic process receipt")
  if (process.get("schema")!="fullmag.docker-process-tree.v1" or process.get("state")!="failed_outcome_retained"
      or process.get("api_diagnostic_only") is not True or "runtime_pid" in process
      or process.get("accepted_store")!=STORE_PATH): fail("API is not a diagnostic-only failed startup")
  bootstrap=process.get("bootstrap")
  if (not isinstance(bootstrap,dict) or bootstrap.get("schema")!="fullmag.docker-accepted-store-bootstrap.v1"
      or bootstrap.get("store_root")!=STORE_PATH or bootstrap.get("binding")!=target["accepted_store_binding"]):
   fail("accepted store bootstrap binding differs")
  fence_path=process.get("api_failure_fence"); prefix="/opt/fullmag/runtime-control/"
  if not isinstance(fence_path,str) or not fence_path.startswith(prefix): fail("API failure fence path is invalid")
  fence_relative=fence_path[len(prefix):]
  if re.fullmatch(r"runtime-service/api-failure-[0-9a-f]{32}\.json",fence_relative) is None: fail("API failure fence path is not canonical")
  fence_raw,fence=load_json(runtime_root+"/"+fence_relative,"API failure fence",64*1024,True)
  api_pid=process.get("api_pid")
  if (fence.get("schema")!="fullmag.api-runtime-failure-fence.v1" or fence.get("stage")!="runtime_startup"
      or fence.get("api_pid")!=api_pid or not isinstance(fence.get("api_instance_id"),str)
      or UUID_RE.fullmatch(fence["api_instance_id"]) is None
      or (process.get("api_instance_id") is not None and process.get("api_instance_id")!=fence["api_instance_id"])
      or not isinstance(fence.get("reason"),str) or not fence["reason"]
      or (process.get("error") is not None and process.get("error")!=fence["reason"])):
   fail("API failure fence identity or stage differs")
  relative="runtime-control/"+fence_relative
  api=process_pin(api_pid,relative); scan_native_processes(api_pid)
  runtime={"process_sha256":digest(process_raw),"failure_fence_relative":relative,
   "failure_fence_sha256":digest(fence_raw),"launch_sha256":digest(launch_raw),
   "launch_id":launch["launch_id"],"input_sha256":launch["input_sha256"],
   "native_config_sha256":config_sha,"api_pin":api,"store_snapshot":store_snapshot}
 elif mode=="stopped":
  runtime={"launch_sha256":digest(launch_raw),"launch_id":launch["launch_id"],
   "input_sha256":launch["input_sha256"],"native_config_sha256":config_sha,"store_snapshot":store_snapshot}
 elif mode=="archived":
  expected_runtime=expected["runtime"]
  for key in ("launch_sha256","launch_id","input_sha256","native_config_sha256","failure_fence_relative","failure_fence_sha256"):
   actual_value=(digest(launch_raw) if key=="launch_sha256" else launch["input_sha256"] if key=="input_sha256"
                 else launch["launch_id"] if key=="launch_id" else config_sha if key=="native_config_sha256" else None)
   if key=="failure_fence_relative": actual_value=expected_runtime.get(key)
   if key=="failure_fence_sha256":
    relative=expected_runtime.get("failure_fence_relative")
    if not isinstance(relative,str) or not relative.startswith("runtime-control/runtime-service/api-failure-"): fail("archived failure fence path is malformed")
    fence_raw=read_abs(runtime_root+"/"+relative[len("runtime-control/"):],64*1024,"archived failure fence")
    actual_value=digest(fence_raw)
   if actual_value!=expected_runtime.get(key): fail("archived "+key+" differs from the approved diagnostic snapshot")
  runtime={"process_sha256":digest(read_abs(runtime_root+"/runtime-service/process-tree.json",64*1024,"archived process receipt")),
   "failure_fence_relative":expected_runtime["failure_fence_relative"],
   "failure_fence_sha256":expected_runtime["failure_fence_sha256"],
   "launch_sha256":digest(launch_raw),"launch_id":launch["launch_id"],
   "input_sha256":launch["input_sha256"],"native_config_sha256":config_sha,
   "api_pin":expected_runtime["api_pin"],"store_snapshot":store_snapshot}
 else: fail("probe mode is invalid")
 if store_snapshot!=runtime["store_snapshot"]: fail("accepted store snapshot changed")
 released=release_snapshot(ledger_root,str(pathlib.PurePosixPath(state)/STORE_REL))
 release_locks()
 if mode in ("stopped","archived"):
  if not isinstance(expected,dict) or not isinstance(expected.get("native_locks"),dict) or native_locks!=expected["native_locks"]:
   fail("stopped native lock inode or release state differs")
 if mode=="stopped":
  expected_runtime=expected.get("runtime",{})
  for key in ("launch_sha256","launch_id","input_sha256","native_config_sha256","store_snapshot"):
   if runtime.get(key)!=expected_runtime.get(key): fail("stopped "+key+" differs from the pre-stop snapshot")
 result={"schema":"fullmag.held-ui-start-retry-observation.v1","runtime":runtime,"native_locks":native_locks,
         "released_snapshot_sha256":digest(canon(released))}
 if len(canon(result))>MAX_INPUT: fail("probe output exceeds its byte bound")
 sys.stdout.buffer.write(canon(result))
def release_locks():
 for fd in reversed(HELD_FDS):
  try: fcntl.flock(fd,fcntl.LOCK_UN)
  finally: os.close(fd)
 HELD_FDS.clear()
try:
 main()
except BaseException as error:
 sys.stderr.write(str(error)+"\n")
 sys.exit(2)
finally:
 release_locks()
'''

def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON object key")
        value[key] = item
    return value


def accepted_store_binding(path: str) -> str:
    if (not isinstance(path, str) or not path.startswith("/") or path.endswith("/")
            or ".." in path.split("/")):
        raise BuildControlError("Accepted store path is not canonical")
    return hashlib.sha256(b"fullmag.accepted-store-binding.v1\0" + path.encode() + b"/").hexdigest()


def probe_program(*, roots: Mapping[str, str | object] | None = None) -> str:
    selected = dict(DEFAULT_ROOTS)
    if roots is not None:
        if not isinstance(roots, Mapping) or set(roots) - set(selected):
            raise BuildControlError("Held retry probe roots are malformed")
        selected.update({key: str(value) for key, value in roots.items()})
    return PROBE.replace("__ROOTS__", repr(selected))


def _read_request_authority(control, request):
    import docker_volume_held_ui_materialization as controller

    request = controller.validate_request(request)
    maintenance_id = request["plan"]["maintenance_request_id"]
    stored, _ = controller.load_request(control, maintenance_id)
    if stored != request:
        raise BuildControlError("Held retry request differs from its immutable control record")

    def read_control_record(relative):
        prefix = "" if relative.startswith("held-ui-materialization-stop/") else "runtime-control/"
        return control.read_bytes(prefix + relative, maximum=controller.MAX_PROOF_BYTES)

    controller.validate_stop_proofs(request, read_control_record)
    return request


def _inspect_incarnation(actual, *, running):
    if not isinstance(actual, Mapping):
        raise BuildControlError("Held retry container observation is malformed")
    identifier = actual.get("Id")
    if not isinstance(identifier, str) or re.fullmatch(r"[0-9a-f]{64}", identifier) is None:
        raise BuildControlError("Held retry container identity is malformed")
    state = actual.get("State")
    if (not isinstance(state, Mapping) or state.get("Running") is not running
            or state.get("Restarting") is True or not isinstance(state.get("StartedAt"), str)
            or not state.get("StartedAt") or not isinstance(actual.get("Image"), str)):
        raise BuildControlError("Held retry container state or StartedAt differs")
    return {"id": identifier, "image": actual["Image"], "started_at": state["StartedAt"],
            "running": running}


def _inspect_same_container(actual, *, running):
    observed = docker_capture("inspect", actual["Id"], timeout=30)
    try:
        values = json.loads(observed.stdout)
    except (TypeError, ValueError) as error:
        raise BuildControlError("Held retry Docker inspection is invalid") from error
    if not isinstance(values, list) or len(values) != 1:
        raise BuildControlError("Held retry Docker inspection is ambiguous")
    pinned = _inspect_incarnation(actual, running=actual.get("State", {}).get("Running"))
    current = _inspect_incarnation(values[0], running=running)
    if (current["id"], current["image"], current["started_at"]) != (
            pinned["id"], pinned["image"], pinned["started_at"]):
        raise BuildControlError("Held retry container incarnation changed")
    return pinned, values[0]


def _roots_for(mode, archive_attempt=None):
    if mode == "live":
        return None
    roots = {
        "runtime": "/opt/fullmag/runtime-control" if mode == "stopped"
                   else "/opt/fullmag/control/runtime-archives/" + archive_attempt,
        "control": "/opt/fullmag/control", "state": "/state",
        "ledger": "/host-ledger/ledger" if mode == "stopped"
                  else "/opt/fullmag/control/runtime-archives/" + archive_attempt + "/group-ledger",
        "proc": "/proc", "host_identity": "/run/fullmag/linux-native-host.json",
    }
    return roots


def _run_probe(actual, request, *, mode, expected=None, archive_attempt=None):
    payload = {"mode": mode, "request": request, "expected": expected,
               "container_image_id": actual.get("Image")}
    if archive_attempt is not None:
        payload["archive_attempt"] = archive_attempt
    raw_input = canonical(payload)
    if len(raw_input) > MAX_INPUT_BYTES:
        raise BuildControlError("Held retry probe input exceeds its byte bound")
    roots = _roots_for(mode, archive_attempt)
    script = probe_program(roots=roots) if roots is not None else probe_program()
    if mode == "live":
        result = docker_capture(
            "exec", "-i", actual["Id"], "python3", "-I", "-B", "-c", script,
            data=raw_input, timeout=90,
        )
    else:
        from docker_volume_linux_supervision_stop import readonly_mount

        mounts = [
            readonly_mount(actual, "/state"),
            readonly_mount(actual, "/opt/fullmag/control"),
            readonly_mount(actual, "/run/fullmag/linux-native-host.json"),
        ]
        if mode == "stopped":
            mounts.extend([
                readonly_mount(actual, "/host-ledger"),
                readonly_mount(actual, "/opt/fullmag/runtime-control"),
            ])
        args = [
            "run", "--rm", "-i", "--pull", "never", "--network", "none", "--runtime", "runc",
            "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
            "--pids-limit", "24", "--memory", "96m", "--cpus", "0.25", "--user", "65532:65532",
            "--label", "com.docker.compose.project=" + request["source_scope"]["compose_project"],
            "--label", "com.docker.compose.service=held-ui-start-retry-readonly-probe",
        ]
        for mount in mounts:
            args.extend(("--mount", mount))
        args.extend(("--entrypoint", "/usr/local/bin/python3", actual["Image"],
                     "-I", "-B", "-c", script))
        result = docker_capture(*args, data=raw_input, timeout=90)
    if result.returncode or len(result.stdout) > MAX_OUTPUT_BYTES:
        detail = result.stderr.decode("utf-8", "replace")[-1024:]
        raise BuildControlError("Held retry read-only probe failed: " + detail)
    try:
        value = json.loads(result.stdout.decode("utf-8"), object_pairs_hook=_unique_object)
    except (TypeError, ValueError, UnicodeDecodeError) as error:
        raise BuildControlError("Held retry read-only probe output is invalid") from error
    if (not isinstance(value, Mapping) or value.get("schema") != OBSERVATION_SCHEMA
            or set(value) != {"schema", "runtime", "native_locks", "released_snapshot_sha256"}):
        raise BuildControlError("Held retry read-only probe output schema differs")
    return dict(value)


def _validate_locks(value):
    if not isinstance(value, Mapping) or set(value) != {
            "owner", "startup_gate", "launch", "host_inventory_owner"}:
        raise BuildControlError("Held retry read-only probe lock fields differ")
    for identity in value.values():
        if (not isinstance(identity, Mapping) or set(identity) != {"device", "inode", "unlocked"}
                or type(identity.get("device")) is not int or identity["device"] <= 0
                or type(identity.get("inode")) is not int or identity["inode"] <= 0
                or identity.get("unlocked") is not True):
            raise BuildControlError("Held retry read-only probe lock identity is malformed")


def observe(control, actual, request) -> dict:
    """Revalidate a running diagnostic API and capture its accepted-store pins."""
    request = _read_request_authority(control, request)
    pin, before = _inspect_same_container(actual, running=True)
    value = _run_probe(before, request, mode="live")
    after_pin, _ = _inspect_same_container(before, running=True)
    if after_pin != pin:
        raise BuildControlError("Held retry backend changed during observation")
    runtime = value["runtime"]
    if set(runtime) != {
            "process_sha256", "failure_fence_relative", "failure_fence_sha256",
            "launch_sha256", "launch_id", "input_sha256", "native_config_sha256",
            "api_pin", "store_snapshot"}:
        raise BuildControlError("Held retry read-only probe runtime fields differ")
    _validate_locks(value["native_locks"])
    return value


def observe_stopped(control, actual, request, expected) -> dict:
    """Prove accepted state and lock identities survived the pinned container stop."""
    request = _read_request_authority(control, request)
    pin, stopped = _inspect_same_container(actual, running=False)
    value = _run_probe(stopped, request, mode="stopped", expected=expected)
    after_pin, _ = _inspect_same_container(stopped, running=False)
    if after_pin != pin:
        raise BuildControlError("Held retry stopped backend identity changed during observation")
    _validate_locks(value["native_locks"])
    return value


def observe_archived(control, actual, request, expected, archive_attempt) -> dict:
    """Revalidate preserved request/store/ledger from the exact technical archive."""
    import docker_volume_held_ui_materialization as controller
    request = controller.validate_request(request)
    if not isinstance(archive_attempt, str) or TOKEN.fullmatch(archive_attempt) is None:
        raise BuildControlError("Held retry archive attempt is malformed")
    if not isinstance(expected, Mapping) or set(expected) != {"runtime", "native_locks"}:
        raise BuildControlError("Held retry archive comparison pins are malformed")
    value = _run_probe(actual, request, mode="archived",
                       expected=dict(expected), archive_attempt=archive_attempt)
    _validate_locks(value["native_locks"])
    return value
