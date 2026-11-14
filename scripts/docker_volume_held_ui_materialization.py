"""Qualified continuation for one accepted UI Compute missing its run catalog.

The module publishes a private immutable request only after the existing
managed API quiescence and native drain have produced real receipts. It does
not submit Compute, create a RunIntent, or claim a terminal result.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import sys
import uuid
from collections.abc import Mapping
from pathlib import PurePosixPath


REQUEST_SCHEMA = "fullmag.held-ui-materialization-request.v1"
PREFLIGHT_SCHEMA = "fullmag.held-ui-materialization-preflight.v1"
INVENTORY_SCHEMA = "fullmag.held-ui-materialization-inventory.v1"
API_QUIESCE_INTENT_SCHEMA = "fullmag.held-ui-materialization-api-quiescence-intent.v1"
PRIVATE_SCHEMA = "fullmag.development-held-ui-materialization-restore.v1"
HANDOFF_SCHEMA = "fullmag.docker-held-ui-materialization-handoff.v1"
PREFLIGHT_CAPTURE_MAX = 3 * 1024 * 1024
REQUEST_ENV = "FULLMAG_HELD_UI_MATERIALIZATION_REQUEST"
REQUEST_DIGEST_ENV = "FULLMAG_HELD_UI_MATERIALIZATION_REQUEST_SHA256"
STARTUP_ENV_NAMES = (
    "FULLMAG_STARTUP_ENABLED", "FULLMAG_STARTUP_SCRIPT", "FULLMAG_STARTUP_PROVENANCE",
    "FULLMAG_STARTUP_API", "FULLMAG_STARTUP_PROVENANCE_SHA256",
    "FULLMAG_STARTUP_HELPER_SHA256", "FULLMAG_STARTUP_RECEIPT_KEY",
)
RECOVERY_ENV_NAMES = (
    "FULLMAG_CONTAINER_RECOVERY_AUTHORIZATION",
    "FULLMAG_CONTAINER_RECOVERY_AUTHORIZATION_SHA256",
    "FULLMAG_RUNTIME_RECOVERY_AUTHORIZATION",
)
MAX_PROOF_BYTES = 256 * 1024
MAX_REQUEST_BYTES = 64 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
TOKEN_RE = re.compile(r"^[0-9a-f]{32}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
CONTAINER_RE = re.compile(r"^[0-9a-f]{64}$")
PROJECT_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
VOLUME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,127}$")
RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
COMMAND_ID_RE = re.compile(r"^fm-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
PORTABLE_RE = re.compile(r"^[^/\\\x00\r\n\t]{1,256}$")
REQUEST_PATHS = {
    "preflight": "preflight.json",
    "api_quiescence": "api-quiescence.json",
    "native_drain": "native-drain.json",
    "inventory": "inventory.json",
}
ACCEPTED_FIELDS = {
    "project_id", "run_id", "session_id", "session_epoch", "session_created_at_unix_ms",
    "old_api_instance_id",
    "old_request_scope_epoch", "scene_revision", "run_intent_sha256",
    "run_intent_payload_sha256", "definition_sha256", "study_sha256",
    "accepted_scene_sha256", "execution_input_sha256", "command_id", "command_kind",
    "client_intent_id", "request_id", "request_sha256", "request_key_sha256",
    "request_receipt_sha256",
}
SOURCE_SCOPE_FIELDS = {
    "compose_project", "control_volume", "namespace", "namespace_registry_sha256",
    "source_root", "state_root_sha256", "backend_container_id", "backend_started_at",
    "frontend_container_id", "frontend_started_at", "runtime_config_sha256",
}
STOP_AUTHORITY_FIELDS = {
    "stop_attempt", "terminal", "preflight", "api_quiescence", "native_drain", "inventory",
}
PLAN_FIELDS = {"attempt", "plan_sha256", "maintenance_request_id"}
API_QUIESCE_INTENT_FIELDS = {
    "schema", "plan_sha256", "preflight_sha256", "inventory_sha256",
    "ready_owner_identity", "plan",
}


HELD_READONLY_CAPTURE = r'''import base64,hashlib,json,os,pathlib,re,stat,sys,urllib.error,urllib.parse,urllib.request
sys.path.insert(0,"/opt/fullmag")
import runtime_service as service
import entrypoint
entrypoint._configure_device_access()
paths=service.canonical_paths()
MAX=256*1024
MAX_RECORD=8*1024*1024
def fail(message): raise RuntimeError("held UI preview: "+message)
def unique(pairs):
 result={}
 for key,value in pairs:
  if key in result: fail("duplicate JSON key")
  result[key]=value
 return result
def canon(value):
 return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":"),allow_nan=False).encode()
def digest(raw): return hashlib.sha256(raw).hexdigest()
def obj(raw,label):
 if len(raw)>MAX_RECORD: fail(label+" exceeds its bounded read")
 value=json.loads(raw,object_pairs_hook=unique)
 if not isinstance(value,dict): fail(label+" is not an object")
 return value
def read_record(path,label,maximum=MAX_RECORD):
 raw=service._bounded_regular(path,label,maximum)
 if len(raw)>maximum: fail(label+" exceeds its bound")
 return raw
def optional_record(path,label):
 service._assert_no_links(path.parent,label+" parent")
 try: metadata=path.lstat()
 except FileNotFoundError: return None
 if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink!=1:
  fail(label+" is linked or not a regular file")
 return read_record(path,label)
def get_raw(path,api_id=None,allow_error=False):
 headers={"Host":"localhost","Accept":"application/json"}
 if api_id: headers["x-fullmag-api-instance"]=api_id
 request=urllib.request.Request("http://127.0.0.1:8081"+path,headers=headers)
 try:
  response=urllib.request.urlopen(request,timeout=10)
  status=response.status; response_headers=response.headers; raw=response.read(MAX+1); response.close()
 except urllib.error.HTTPError as error:
  status=error.code; response_headers=error.headers; raw=error.read(MAX+1); error.close()
 except Exception as error: fail("API GET failed: "+type(error).__name__)
 if len(raw)>MAX: fail("API response exceeds its bound")
 identities=response_headers.get_all("x-fullmag-api-instance") or []
 if len(identities)!=1 or (api_id is not None and identities[0]!=api_id): fail("API instance header changed")
 if not allow_error and status!=200: fail("API GET did not return 200")
 return status,raw,identities[0]
def get_json(path,api_id=None):
 status,raw,identity=get_raw(path,api_id)
 return json.loads(raw.decode("utf-8"),object_pairs_hook=unique),raw,identity
API_PATHS=(("health","/v2/platform/health"),("status","/v2/sessions/current/status"),
 ("run","/v2/sessions/current/simulation/runs/current"),("scene","/v2/sessions/current/model/scene"),
 ("queue","/v2/platform/compute/queue"),("commands","/v2/sessions/current/simulation/commands"),
 ("runtime","/v2/platform/runtime-service"))
def snapshot():
 responses={}; parsed={}; api_id=None
 for name,path in API_PATHS:
  status,raw,api_id=get_raw(path,api_id)
  if status!=200: fail(name+" endpoint did not return 200")
  body=json.loads(raw.decode("utf-8"),object_pairs_hook=unique)
  if not isinstance(body,dict): fail(name+" response is not an object")
  parsed[name]=body
  responses[name]={"raw_base64":base64.b64encode(raw).decode("ascii"),"sha256":digest(raw)}
 return {"api_instance_id":api_id,**parsed},responses
def stable(value,scene_sha256):
 status=value["status"]; session=status["session"]; resources=status["resources"]
 run=value["run"]; queue=value["queue"]; commands=value["commands"]; runtime=value["runtime"]
 return {"api_instance_id":value["api_instance_id"],
  "session":{key:session.get(key) for key in ("session_id","session_epoch","created_at","request_scope_epoch")},
  "scene_revision":resources.get("scene_revision"),"scene_sha256":scene_sha256,
  "run":{key:run.get(key) for key in ("run_id","session_id","revision","status","started_at")},
  "queue":{"revision":queue.get("revision"),"items":queue.get("items"),"next_cursor":queue.get("next_cursor")},
  "commands":{"revision":commands.get("revision"),"commands":commands.get("commands"),
   **{key:commands.get(key) for key in ("pending_count","accepted_count","dispatched_count","running_count","completed_count","rejected_count","failed_count")}},
  "runtime":{"schema_version":runtime.get("schema_version"),"configured":runtime.get("configured"),"state":runtime.get("state")},
  "health":{"status":value["health"].get("status"),"active_session":value["health"].get("active_session")}}
def owner_identity(owner):
 fields=("owner_token","process_start_token","pid","host","target_id","protocol","build_commit","build_snapshot",
  "control_address","compute_pool_generation","preparation_pool_generation","compute_pool_id","preparation_pool_id")
 if owner.get("state")!="ready" or any(owner.get(key) is None for key in fields): fail("native owner is not Ready")
 children=owner.get("children")
 if not isinstance(children,list) or len(children)!=2 or {child.get("role") for child in children}!={"compute","preparation"}:
  fail("native owner children differ")
 return {**{key:owner[key] for key in fields},"children":sorted((child["role"],child["pid"]) for child in children)}
def process_pin(pid):
 if type(pid) is not int or pid<=1: fail("API PID is invalid")
 root=pathlib.Path("/proc")/str(pid)
 text=(root/"stat").read_text(); fields=text[text.rfind(")")+2:].split()
 binary="/opt/fullmag/package/bin/fullmag-api"
 with (root/"cmdline").open("rb") as stream: argv=stream.read(4097)
 exe=os.readlink(root/"exe")
 if argv!=binary.encode()+b"\0" or exe!=str(pathlib.Path(binary).resolve(strict=True)):
  fail("API process image differs")
 return {"pid":pid,"start_token":fields[19],"ppid":int(fields[1]),"argv":[binary],"exe":exe}
def accepted_store_binding_for(store_path):
 store_path=pathlib.Path(store_path)
 try:
  if store_path.resolve(strict=True)!=store_path: return None
 except (OSError,RuntimeError): return None
 text=str(store_path)
 if not text.startswith("/") or text.endswith("/"): return None
 return hashlib.sha256(b"fullmag.accepted-store-binding.v1\0"+os.fsencode(text+"/")).hexdigest()
def process_store_identity_matches(process,store_path,expected_binding):
 store_path=pathlib.Path(store_path); text=str(store_path)
 if not isinstance(process,dict): return False
 bootstrap=process.get("bootstrap")
 return (accepted_store_binding_for(store_path)==expected_binding
  and isinstance(expected_binding,str) and re.fullmatch(r"[0-9a-f]{64}",expected_binding) is not None
  and process.get("accepted_store")==text
  and process.get("api_diagnostic_only",False) is False
  and isinstance(bootstrap,dict)
  and bootstrap.get("schema")=="fullmag.docker-accepted-store-bootstrap.v1"
  and bootstrap.get("store_root")==text and bootstrap.get("binding")==expected_binding)
def native_owner():
 value=service._service_status(paths)
 service._validate_terminal_owner(value,state="ready",name="held UI preview Ready owner")
 return value
def native_config(): return read_record(paths.config,"held UI native config",64*1024)
def store_id():
 state=paths.state; store=paths.store
 if state.resolve(strict=True)!=state or store.resolve(strict=True)!=store: fail("accepted store root is linked")
 relative=store.relative_to(state).as_posix()
 host=obj(read_record(pathlib.Path("/run/fullmag/linux-native-host.json"),"native host identity"),"native host identity")
 owner=obj(read_record(state/".fullmag-linux-native-owner.json","native store owner"),"native store owner")
 token=host.get("owner_token"); engine=host.get("engine_id")
 if (host!=owner or host.get("schema")!="fullmag.linux-native-host.v1" or host.get("storage_profile")!="linux-native-v1"
  or host.get("role")!="session" or host.get("owner_scope")!="docker-linux" or host.get("restart_verified") is not True
  or not isinstance(token,str) or re.fullmatch("[0-9a-f]{32}",token) is None or not isinstance(engine,str) or not engine):
  fail("native store identity differs")
 stable={"schema":"fullmag.linux-native-store-identity.v1","engine_id":engine,"owner_token":token,"relative_state_path":relative}
 return "sha256:"+digest(canon(stable))
def inventory_side(run_id,intent,live):
 root=paths.store/"runs"/run_id
 service._assert_no_links(root.parent,"held UI run directory parent")
 metadata=root.lstat()
 if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode): fail("accepted run directory is unsafe")
 names=[]
 with os.scandir(root) as entries:
  for entry in entries:
   item=entry.stat(follow_symlinks=False)
   if stat.S_ISLNK(item.st_mode) or not stat.S_ISREG(item.st_mode): fail("accepted run directory contains a subdirectory or special entry")
   names.append(entry.name)
 names=sorted(names)
 if names!=["live_demand.v1.json","run_intent.json"]: fail("accepted run has catalog, release, or unknown files")
 intent_raw=read_record(root/"run_intent.json","accepted RunIntent")
 demand_raw=read_record(root/"live_demand.v1.json","accepted live demand",64*1024)
 demand=obj(demand_raw,"accepted live demand")
 if (demand.get("schema_version")!="fullmag.accepted_live_demand.v1" or demand.get("run_id")!=run_id
  or not isinstance(demand.get("quantities"),list) or len(demand["quantities"])>64
  or any(not isinstance(item,str) or not item.strip() or len(item)>256 for item in demand["quantities"])):
  fail("live demand does not bind the accepted run")
 others=[]; runs=paths.store/"runs"
 service._assert_no_links(runs.parent,"accepted runs parent")
 with os.scandir(runs) as entries:
  candidates=list(entries)
 if len(candidates)>4096: fail("accepted run inventory exceeds its bound")
 for entry in candidates:
  if entry.name==run_id: continue
  item=entry.stat(follow_symlinks=False)
  if stat.S_ISLNK(item.st_mode) or not stat.S_ISDIR(item.st_mode): fail("accepted runs inventory contains an unsafe entry")
  catalog_raw=optional_record(pathlib.Path(entry.path)/"run_catalog.json","other run catalog")
  if catalog_raw is None:
   others.append(entry.name); continue
  try: catalog=obj(catalog_raw,"other run catalog")
  except Exception:
   others.append(entry.name); continue
  tasks=catalog.get("tasks")
  terminal={"succeeded","failed","cancelled","rejected"}
  if (catalog.get("schema_version")!="run_catalog.v1" or catalog.get("run_id")!=entry.name
      or not isinstance(tasks,list) or not tasks
      or any(not isinstance(task,dict) or task.get("lifecycle") not in terminal for task in tasks)):
   others.append(entry.name)
  if len(others)>256: fail("other active run inventory exceeds its bound")
 return {"run_id":run_id,"store_id":store_id(),
  "run_intent_sha256":digest(intent_raw),"run_intent_payload_sha256":intent.get("payload_sha256"),
  "definition_sha256":intent.get("definition_object_ref"),"study_sha256":intent.get("study_object_ref"),
  "execution_input":{"schema_version":live["execution_input"]["schema_version"],"sha256":live["execution_input"]["sha256"]},
  "run_files":[{"name":"live_demand.v1.json","sha256":digest(demand_raw)},
   {"name":"run_intent.json","sha256":digest(intent_raw)}],
  "run_catalog_absent":not (root/"run_catalog.json").exists(),
  "start_release_absent":not (root/"start_release.json").exists(),"pending_materialization":True,
  "task_attempts":[],"leases":[],"workers":[],"outputs":[],"other_active_runs":sorted(others)}
input_raw=sys.stdin.buffer.read(MAX_RECORD+1)
if len(input_raw)>MAX_RECORD: fail("preview input exceeds its bound")
request=obj(input_raw,"preview input"); expected_run=request.get("run_id"); source_scope=request.get("source_scope")
if not isinstance(expected_run,str) or not isinstance(source_scope,dict): fail("preview run/source pin is missing")
before,responses=snapshot()
run_id=before["run"].get("run_id")
if run_id!=expected_run: fail("current API run differs from the selected run")
run_root=paths.store/"runs"/run_id
intent_raw=read_record(run_root/"run_intent.json","accepted RunIntent")
intent=obj(intent_raw,"accepted RunIntent")
spec=intent.get("specification"); live=spec.get("parameters",{}).get("live_workspace",{}) if isinstance(spec,dict) else {}
if (intent.get("schema_version")!="run_intent.v1" or intent.get("run_id")!=run_id
 or not isinstance(spec,dict) or not isinstance(live,dict) or spec.get("run_id")!=run_id
 or not isinstance(intent.get("payload_sha256"),str)):
 fail("immutable accepted RunIntent differs")
session=before["status"].get("session",{}); scene=before["scene"]
created_at=session.get("created_at")
session_epoch=live.get("session_epoch")
if (not isinstance(created_at,str) or re.fullmatch(r"[1-9][0-9]{0,19}",created_at) is None
 or int(created_at)>2**64-1 or type(session_epoch) is not int or not 0<session_epoch<=2**64-1):
 fail("accepted internal session epoch or public creation time is invalid")
if (session.get("session_id")!=live.get("session_id")
 or session.get("session_epoch")!=str(session.get("session_id"))+"@"+created_at
 or session.get("request_scope_epoch")!=str(before["api_instance_id"])+":"+str(session_epoch)
 or before["api_instance_id"]!=live.get("api_instance_id")
 or before["status"].get("resources",{}).get("scene_revision")!=live.get("scene_revision")
 or scene.get("revision")!=live.get("scene_revision")
 or before["run"].get("status")!="waiting_for_compute"
 or before["status"].get("solver",{}).get("state")!="waiting_for_compute"):
 fail("current API session/run/scene differs from accepted RunIntent")
command=live.get("command"); receipt=live.get("request_receipt")
if not isinstance(command,dict) or not isinstance(receipt,dict) or command.get("kind")!="relax":
 fail("accepted Compute command or original receipt is missing")
detail_path="/v2/sessions/current/simulation/commands/"+urllib.parse.quote(str(command.get("command_id")),safe="")
detail_status,detail_raw,detail_api=get_raw(detail_path,before["api_instance_id"],allow_error=True)
if detail_status!=404 or detail_api!=before["api_instance_id"]: fail("original command detail is not the pinned 404")
spec_snapshot=spec.get("snapshot",{}); study_ref=spec.get("study",{}).get("plan_sha256")
definition_ref=intent.get("definition_object_ref"); study_object_ref=intent.get("study_object_ref")
execution=live.get("execution_input")
if (not isinstance(execution,dict) or execution.get("schema_version")!="fullmag.scene_execution_input.v1"
 or spec_snapshot.get("definition_sha256")!=definition_ref or spec.get("study",{}).get("plan_sha256")!=study_object_ref
 or study_ref!=study_object_ref): fail("accepted definition, Study, or execution-input references differ")
accepted={"project_id":spec_snapshot.get("project_id"),"run_id":run_id,"session_id":session.get("session_id"),
 "session_epoch":session_epoch,"session_created_at_unix_ms":int(created_at),
 "old_api_instance_id":before["api_instance_id"],
 "old_request_scope_epoch":session["request_scope_epoch"],"scene_revision":live.get("scene_revision"),
 "run_intent_sha256":digest(intent_raw),"run_intent_payload_sha256":intent.get("payload_sha256"),
 "definition_sha256":definition_ref,"study_sha256":study_object_ref,
 "accepted_scene_sha256":responses["scene"]["sha256"],"execution_input_sha256":execution.get("sha256"),
 "command_id":command.get("command_id"),"command_kind":command.get("kind"),
 "client_intent_id":command.get("client_intent_id"),"request_id":receipt.get("request_id"),
 "request_sha256":receipt.get("request_sha256"),"request_key_sha256":receipt.get("key_sha256"),
 "request_receipt_sha256":digest(canon(receipt))}
owner=native_owner(); process_raw=read_record(service.process_receipt_path(paths),"native process receipt",64*1024)
process=obj(process_raw,"native process receipt"); config_raw=native_config(); api_pin=process_pin(process.get("api_pid"))
native_binding=accepted_store_binding_for(paths.store)
if (process.get("schema")!="fullmag.docker-process-tree.v1" or process.get("state")!="ready"
 or process.get("service_owner") is None or service._owner_fingerprint(process["service_owner"])!=service._owner_fingerprint(owner)
 or native_binding is None or not process_store_identity_matches(process,paths.store,native_binding)):
 fail("native Ready process receipt differs")
identity=owner_identity(owner)
inventory_before=inventory_side(run_id,intent,live); inventory_after=inventory_side(run_id,intent,live)
if inventory_before!=inventory_after: fail("accepted store changed during the read-only preview")
after,after_responses=snapshot()
if stable(before,responses["scene"]["sha256"])!=stable(after,after_responses["scene"]["sha256"]): fail("API/session/queue changed during the read-only preview")
if (responses.keys()!=after_responses.keys() or process_pin(api_pin["pid"])!=api_pin
 or read_record(service.process_receipt_path(paths),"native process receipt",64*1024)!=process_raw
 or native_config()!=config_raw): fail("native API/owner/config changed during preview")
command_bundle={"ledger":before["commands"],"command":command,"request_receipt":receipt,
 "request_receipt_sha256":digest(canon(receipt)),"detail":{"http_status":detail_status,
  "raw_base64":base64.b64encode(detail_raw).decode("ascii"),"sha256":digest(detail_raw)}}
preflight={"schema":"fullmag.held-ui-materialization-preflight.v1","source_scope":source_scope,
 "api_response":{"responses":responses,"snapshot":before},"commands":command_bundle,
 "native_config_sha256":digest(config_raw),"accepted_store_binding":native_binding,
 "ready_owner_sha256":digest(canon(identity)),
 "process_sha256":digest(process_raw),"api_pin":api_pin,"ready_owner_identity":identity,
 "run_intent_sha256":accepted["run_intent_sha256"],"execution_input_sha256":accepted["execution_input_sha256"]}
if len(canon(preflight)+b"\n")>MAX: fail("complete preflight proof exceeds its bound")
inventory={"schema":"fullmag.held-ui-materialization-inventory.v1",
 "before":inventory_before,"after":inventory_after}
print(json.dumps({"accepted":accepted,"preflight":preflight,"inventory":inventory},sort_keys=True,separators=(",",":")))
'''

_HELD_READONLY_CAPTURE_MARKER = "input_raw=sys.stdin.buffer.read(MAX_RECORD+1)"
if HELD_READONLY_CAPTURE.count(_HELD_READONLY_CAPTURE_MARKER) != 1:
    raise RuntimeError("held read-only capture prelude boundary changed")
HELD_READONLY_CAPTURE_PRELUDE = HELD_READONLY_CAPTURE.split(
    _HELD_READONLY_CAPTURE_MARKER, 1,
)[0]

HELD_API_QUIESCE_CAPTURE_BODY = r'''import signal,socket,time,urllib.error,urllib.parse
API_BINARY="/opt/fullmag/package/bin/fullmag-api"
CAUSE="Fullmag API exited unexpectedly (-15)"
def process_record():
 raw=read_record(service.process_receipt_path(paths),"held UI quiescence process receipt",64*1024)
 return raw,obj(raw,"held UI quiescence process receipt")
def proc_pin(pid): return process_pin(pid)
def held_api_context(value,scene_sha256):
 status=value["status"]; session=status["session"]; resources=status["resources"]
 run=value["run"]; queue=value["queue"]; commands=value["commands"]; runtime=value["runtime"]
 items=queue.get("items",[])
 stable_items=[{key:item.get(key) for key in ("item_id","project_id","run_id","state","task_id")}
  for item in items if isinstance(item,dict)]
 entries=commands.get("commands",[])
 stable_commands=[{key:entry.get(key) for key in
  ("command_id","seq","kind","client_intent_id","request_id","status","target")}
  for entry in entries if isinstance(entry,dict)]
 stable_counts={key:commands.get(key) for key in
  ("pending_count","accepted_count","dispatched_count","running_count","completed_count","rejected_count","failed_count")}
 return {"api_instance_id":value.get("api_instance_id"),
  "session":{key:session.get(key) for key in ("session_id","session_epoch","created_at","request_scope_epoch")},
  "scene_revision":resources.get("scene_revision"),"scene_sha256":scene_sha256,
  "run":{key:run.get(key) for key in ("run_id","session_id","revision","status","started_at")},
  "queue":{"revision":queue.get("revision"),"items":stable_items,"next_cursor":queue.get("next_cursor")},
  "commands":{"revision":commands.get("revision"),"counts":stable_counts,"commands":stable_commands},
  "runtime":{key:runtime.get(key) for key in ("schema_version","configured","state","reason")},
  "health":{key:value["health"].get(key) for key in ("status","active_session")}}
def owner_digest(value): return digest(canon(owner_identity(value)))
def verify_run_intent(accepted):
 root=paths.store/"runs"/accepted["run_id"]
 raw=read_record(root/"run_intent.json","held accepted RunIntent")
 if digest(raw)!=accepted["run_intent_sha256"]: fail("accepted RunIntent bytes changed")
 run_intent=obj(raw,"held accepted RunIntent")
 spec=run_intent.get("specification"); live=spec.get("parameters",{}).get("live_workspace",{}) if isinstance(spec,dict) else {}
 snapshot_spec=spec.get("snapshot",{}) if isinstance(spec,dict) else {}
 command=live.get("command"); receipt=live.get("request_receipt")
 execution=live.get("execution_input")
 if (run_intent.get("schema_version")!="run_intent.v1" or run_intent.get("run_id")!=accepted["run_id"]
  or spec.get("run_id")!=accepted["run_id"]
  or run_intent.get("payload_sha256")!=accepted["run_intent_payload_sha256"]
  or live.get("session_id")!=accepted["session_id"] or live.get("session_epoch")!=accepted["session_epoch"]
  or live.get("api_instance_id")!=accepted["old_api_instance_id"]
  or live.get("scene_revision")!=accepted["scene_revision"]
  or command!={"command_id":accepted["command_id"],"client_intent_id":accepted["client_intent_id"],
    "frozen_spins_runtime_plan_binding":command.get("frozen_spins_runtime_plan_binding") if isinstance(command,dict) else None,
    "initial_state":command.get("initial_state") if isinstance(command,dict) else None,
    "kind":"relax","precondition":command.get("precondition") if isinstance(command,dict) else None,
    "reason":command.get("reason") if isinstance(command,dict) else None,
    "requested_at_unix_ms":command.get("requested_at_unix_ms") if isinstance(command,dict) else None,
    "created_at_unix_ms":command.get("created_at_unix_ms") if isinstance(command,dict) else None,
    "seq":0,"target":command.get("target") if isinstance(command,dict) else None}
  or not isinstance(receipt,dict) or receipt.get("request_id")!=accepted["request_id"]
  or receipt.get("request_sha256")!=accepted["request_sha256"]
  or receipt.get("key_sha256")!=accepted["request_key_sha256"]
  or receipt.get("command_id")!=accepted["command_id"] or receipt.get("command_kind")!="relax"
  or receipt.get("client_intent_id")!=accepted["client_intent_id"]
  or digest(canon(receipt))!=accepted["request_receipt_sha256"]
  or not isinstance(execution,dict) or execution.get("schema_version")!="fullmag.scene_execution_input.v1"
  or execution.get("sha256")!=accepted["execution_input_sha256"]
  or run_intent.get("definition_object_ref")!=accepted["definition_sha256"]
  or run_intent.get("study_object_ref")!=accepted["study_sha256"]
  or snapshot_spec.get("project_id")!=accepted["project_id"]
  or snapshot_spec.get("definition_sha256")!=accepted["definition_sha256"]
  or spec.get("study",{}).get("plan_sha256")!=accepted["study_sha256"]):
  fail("accepted RunIntent, request receipt, or execution input changed")
 return run_intent,live
def detail_is_pinned_404(accepted):
 path="/v2/sessions/current/simulation/commands/"+urllib.parse.quote(accepted["command_id"],safe="")
 headers={"Host":"localhost","Accept":"application/json","x-fullmag-api-instance":accepted["old_api_instance_id"]}
 req=urllib.request.Request("http://127.0.0.1:8081"+path,headers=headers)
 try:
  response=urllib.request.urlopen(req,timeout=10); status=response.status; response_headers=response.headers
  response.read(256*1024+1); response.close()
 except urllib.error.HTTPError as error:
  status=error.code; response_headers=error.headers; error.read(256*1024+1); error.close()
 ids=response_headers.get_all("x-fullmag-api-instance") or []
 if status!=404 or ids!=[accepted["old_api_instance_id"]]:
  fail("original HTTP Compute detail is no longer the pinned 404")
def read_held_authority(intent):
 plan=intent["plan"]; accepted=plan["accepted"]; native=plan["native"]
 current,responses=snapshot()
 if held_api_context(current,responses["scene"]["sha256"])!=plan["current"] or current["status"].get("solver",{}).get("state")!="waiting_for_compute":
  fail("API/session/request-scope/scene/queue changed after preview")
 owner=native_owner(); identity=owner_identity(owner)
 process_raw,process=process_record()
 config_raw=native_config()
 native_binding=accepted_store_binding_for(paths.store)
 if (process.get("schema")!="fullmag.docker-process-tree.v1" or process.get("state")!="ready"
  or service._owner_fingerprint(process.get("service_owner",{}))!=service._owner_fingerprint(owner)
  or native_binding is None or native_binding!=native["accepted_store_binding"]
  or not process_store_identity_matches(process,paths.store,native["accepted_store_binding"])
  or owner_digest(owner)!=native["ready_owner_sha256"]
  or digest(process_raw)!=native["process_sha256"]
  or digest(config_raw)!=native["config_sha256"]):
  fail("native Ready owner, process receipt, or config changed after preview")
 api=process_pin(process.get("api_pid"))
 if api!=native["api_pin"]: fail("pinned API PID or start token changed after preview")
 run_intent,live=verify_run_intent(accepted)
 inventory=inventory_side(accepted["run_id"],run_intent,live)
 if inventory!=plan["inventory"]: fail("accepted-store inventory changed after preview")
 detail_is_pinned_404(accepted)
 return {"plan_sha256":intent["plan_sha256"],
  "source_scope_sha256":digest(canon(plan["source_scope"])),
  "preflight_sha256":intent["preflight_sha256"],"inventory_sha256":intent["inventory_sha256"],
  "api_context_sha256":digest(canon(held_api_context(current,responses["scene"]["sha256"]))),
  "native_config_sha256":digest(config_raw),"accepted_store_binding":native_binding,
  "process_sha256":digest(process_raw),
  "api_pin":api,"ready_owner_sha256":owner_digest(owner),
  "run_intent_sha256":accepted["run_intent_sha256"],
  "execution_input_sha256":accepted["execution_input_sha256"],
  "store_id":inventory["store_id"]},owner,identity,inventory
request_raw=sys.stdin.buffer.read(256*1024+1)
if len(request_raw)>256*1024: fail("API quiescence intent request exceeds its bound")
request=obj(request_raw,"API quiescence intent request")
intent=request.get("intent"); intent_sha=request.get("intent_sha256")
if digest(canon(intent)+b"\n")!=intent_sha: fail("API quiescence intent digest differs")
if intent.get("schema")!="fullmag.held-ui-materialization-api-quiescence-intent.v1":
 fail("held API quiescence intent schema differs")
plan=intent["plan"]
if digest(canon(plan))!=intent.get("plan_sha256"): fail("preview plan digest differs")
accepted=plan["accepted"]; native=plan["native"]
if len(canon(intent)+b"\n")>256*1024: fail("held API quiescence intent exceeds its bound")
before_fences,owner,identity,inventory=read_held_authority(intent)
expected={"plan_sha256":intent["plan_sha256"],
 "source_scope_sha256":digest(canon(plan["source_scope"])),
 "preflight_sha256":intent["preflight_sha256"],"inventory_sha256":intent["inventory_sha256"],
 "api_context_sha256":digest(canon(plan["current"])),
 "native_config_sha256":native["config_sha256"],
 "accepted_store_binding":native["accepted_store_binding"],"process_sha256":native["process_sha256"],
 "api_pin":native["api_pin"],"ready_owner_sha256":native["ready_owner_sha256"],
 "run_intent_sha256":accepted["run_intent_sha256"],
 "execution_input_sha256":accepted["execution_input_sha256"],
 "store_id":plan["inventory"]["store_id"]}
if before_fences!=expected: fail("held API quiescence pre-signal fences differ")
def verify_before_signal():
 fresh, fresh_owner, fresh_identity, fresh_inventory=read_held_authority(intent)
 if (fresh!=expected or fresh_identity!=identity or fresh_inventory!=inventory
  or service._owner_fingerprint(fresh_owner)!=service._owner_fingerprint(owner)):
  fail("held UI API or native authority changed before pidfd signal")
def signal_api_once(fd,signum,info,flags): signal.pidfd_send_signal(fd,signum,info,flags)
api=native["api_pin"]
retained_raw,retained=pidfd_close_api(api,owner,verify_before_signal,signal_api_once)
fresh_owner=native_owner(); fresh_identity=owner_identity(fresh_owner)
process_raw_after,process_after=process_record()
run_intent_after,live_after=verify_run_intent(accepted)
inventory_after=inventory_side(accepted["run_id"],run_intent_after,live_after)
if (service._owner_fingerprint(fresh_owner)!=service._owner_fingerprint(owner)
 or fresh_identity!=identity or digest(native_config())!=native["config_sha256"]
 or not process_store_identity_matches(process_after,paths.store,native["accepted_store_binding"])
 or inventory_after!=inventory or process_raw_after!=retained_raw or process_after!=retained):
 fail("held API closure changed native owner, config, or accepted-store pins")
receipt={"schema":"fullmag.native-terminal-api-quiescence.v1","intent_sha256":intent_sha,
 "api_pin":api,"api_closed":True,"signal":"SIGTERM","retained_process":retained,
 "retained_process_sha256":digest(retained_raw)}
after_fences={"native_config_sha256":digest(native_config()),
 "accepted_store_binding":accepted_store_binding_for(paths.store),
 "inventory_sha256":digest(canon(inventory_after)),"ready_owner_sha256":owner_digest(fresh_owner),
 "retained_process_sha256":digest(retained_raw)}
print(json.dumps({"receipt":receipt,"fences":{"before":before_fences,"after":after_fences}},sort_keys=True,separators=(",",":")))
'''


def _fail(message: str):
    from docker_build_control import BuildControlError
    raise BuildControlError("Held UI materialization: " + message)


def _require(condition: bool, message: str):
    if not condition:
        _fail(message)


def canonical(value) -> bytes:
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"),
                          ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise _error("record is not canonical JSON") from error


def _error(message):
    from docker_build_control import BuildControlError
    return BuildControlError("Held UI materialization: " + message)


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _duplicate_rejector(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail("JSON contains a duplicate key")
        result[key] = value
    return result


def decode(raw: bytes, label: str, *, maximum: int = MAX_PROOF_BYTES) -> dict:
    _require(isinstance(raw, bytes) and len(raw) <= maximum, label + " exceeds its byte limit")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_duplicate_rejector,
                           parse_constant=lambda _: _fail(label + " contains a non-finite number"))
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as error:
        raise _error(label + " is not valid JSON") from error
    _require(isinstance(value, dict), label + " is not a JSON object")
    return value


def _exact(value, fields, label):
    _require(isinstance(value, Mapping) and set(value) == set(fields), label + " fields differ")
    return value


def _text(value, label, *, maximum=1024):
    _require(isinstance(value, str) and 0 < len(value) <= maximum
             and not any(ord(character) < 32 or ord(character) == 127 for character in value),
             label + " is invalid")
    return value


def _digest(value, label, *, allow_zero=False):
    _require(isinstance(value, str) and SHA256_RE.fullmatch(value) is not None,
             label + " is not lowercase SHA-256")
    if not allow_zero:
        _require(set(value) != {"0"}, label + " is an all-zero placeholder")
    return value


def _uuid(value, label):
    _require(isinstance(value, str) and UUID_RE.fullmatch(value) is not None,
             label + " is not a canonical lowercase UUID")
    return value


def _token(value, label):
    _require(isinstance(value, str) and TOKEN_RE.fullmatch(value) is not None,
             label + " is not a 32-character operation token")
    return value


def request_relative(maintenance_request_id: str) -> str:
    request_id = _uuid(maintenance_request_id, "maintenance request id")
    return "held-ui-materialization/" + request_id + "/request.json"


def start_environment(relative_path: str, request_sha256: str) -> dict[str, str]:
    """Build the only two Compose variables that authorize the private restore."""
    parsed = PurePosixPath(relative_path)
    _require(not parsed.is_absolute() and str(parsed) == relative_path
             and re.fullmatch(r"held-ui-materialization/[0-9a-f-]{36}/request\.json",
                              relative_path) is not None,
             "handoff request path is invalid")
    _digest(request_sha256, "handoff request digest")
    return {REQUEST_ENV: relative_path, REQUEST_DIGEST_ENV: request_sha256}


def validate_start_handoff(environment: object, metadata: object) -> tuple[dict[str, str], dict]:
    """Validate internal start context without granting legacy recovery authority."""
    env = _exact(environment, {REQUEST_ENV, REQUEST_DIGEST_ENV}, "handoff environment")
    path = env.get(REQUEST_ENV)
    digest = _digest(env.get(REQUEST_DIGEST_ENV), "handoff request digest")
    _require(isinstance(path, str), "handoff request path is missing")
    parsed = PurePosixPath(path)
    _require(not parsed.is_absolute() and str(parsed) == path
             and re.fullmatch(r"held-ui-materialization/[0-9a-f-]{36}/request\.json", path) is not None,
             "handoff request path is invalid")
    handoff = _exact(metadata, {"schema", "request_path", "request_sha256", "run_id", "command_id"},
                     "handoff metadata")
    _require(handoff.get("schema") == HANDOFF_SCHEMA and handoff.get("request_path") == path
             and handoff.get("request_sha256") == digest,
             "handoff environment and metadata differ")
    _text(handoff.get("run_id"), "handoff run id", maximum=200)
    _text(handoff.get("command_id"), "handoff command id", maximum=64)
    return dict(env), dict(handoff)


def sanitize_backend_environment(environment: dict[str, str], *, enabled: bool) -> None:
    """Keep typed restore mutually exclusive with script/recovery startup modes."""
    if not enabled:
        return
    for name in STARTUP_ENV_NAMES:
        environment.pop(name, None)
    # Compose must see an explicit disabled value even when the operator's
    # shell previously enabled activation for a different start.
    environment["FULLMAG_STARTUP_ENABLED"] = "0"
    for name in RECOVERY_ENV_NAMES:
        environment.pop(name, None)


def validate_handoff(control, metadata: Mapping, *, selected_source: str, state_root: str) -> dict:
    """Re-read the immutable stop authority under the successor DEV lease."""
    _, handoff = validate_start_handoff(
        {REQUEST_ENV: metadata.get("request_path"),
         REQUEST_DIGEST_ENV: metadata.get("request_sha256")}, metadata,
    )
    request_id = handoff["request_path"].split("/")[1]
    request, raw = load_request(control, request_id, handoff["request_sha256"])
    source = request["source_scope"]
    _require(source.get("source_root") == selected_source,
             "retained source root differs at successor admission")
    _require(source.get("compose_project") == control.project
             and source.get("control_volume") == control.volume
             and source.get("namespace") == getattr(control, "namespace", "")
             and source.get("namespace_registry_sha256")
                 == getattr(control, "namespace_registry_sha256", None),
             "retained control namespace differs at successor admission")
    _require(request["accepted"]["run_id"] == handoff["run_id"]
             and request["accepted"]["command_id"] == handoff["command_id"],
             "accepted RunIntent differs from successor handoff")

    def read_record(relative):
        prefix = "" if relative.startswith("held-ui-materialization-stop/") else "runtime-control/"
        return control.read_bytes(prefix + relative, maximum=MAX_PROOF_BYTES)

    proofs = validate_stop_proofs(request, read_record)
    return {"request": request, "request_raw": raw, "proofs": proofs,
            "request_path": handoff["request_path"], "request_sha256": handoff["request_sha256"],
            "state_root": state_root}


def _proof_relative(value, expected, label):
    _require(value == expected, label + " path differs from this request")
    parsed = PurePosixPath(value)
    _require(not parsed.is_absolute() and str(parsed) == value and ".." not in parsed.parts
             and "\\" not in value and ":" not in value
             and all(part not in {"", "."} for part in parsed.parts),
             label + " path escapes the retained runtime-control root")
    return value


def _digest_ref(value, expected_path, label):
    _exact(value, {"path", "sha256"}, label)
    _proof_relative(value["path"], expected_path, label)
    _digest(value["sha256"], label + " digest")
    return value


def validate_request(
    value: object,
    *,
    expected_maintenance_request_id: str | None = None,
    expected_run_id: str | None = None,
    expected_plan_sha256: str | None = None,
) -> dict:
    """Validate the Python-owned request envelope without reading any proof."""
    _exact(value, {"schema", "plan", "source_scope", "stop_authority", "accepted"}, "request")
    _require(value.get("schema") == REQUEST_SCHEMA, "request schema differs")

    plan = _exact(value.get("plan"), PLAN_FIELDS, "plan")
    _token(plan.get("attempt"), "development attempt")
    _digest(plan.get("plan_sha256"), "prepared plan digest")
    maintenance_id = _uuid(plan.get("maintenance_request_id"), "maintenance request id")
    if expected_maintenance_request_id is not None:
        _require(maintenance_id == _uuid(expected_maintenance_request_id, "expected maintenance request id"),
                 "request id differs from the requested maintenance operation")
    if expected_plan_sha256 is not None:
        _require(plan["plan_sha256"] == _digest(expected_plan_sha256, "expected plan digest"),
                 "prepared plan changed before apply")

    source = _exact(value.get("source_scope"), SOURCE_SCOPE_FIELDS, "source scope")
    _require(isinstance(source.get("compose_project"), str)
             and PROJECT_RE.fullmatch(source["compose_project"]) is not None, "Compose project is invalid")
    _require(isinstance(source.get("control_volume"), str)
             and VOLUME_RE.fullmatch(source["control_volume"]) is not None, "control volume is invalid")
    namespace = source.get("namespace")
    _require(isinstance(namespace, str) and (namespace == "" or
             re.fullmatch(r"namespaces/[0-9a-f]{32}", namespace) is not None), "namespace is invalid")
    registry_sha = source.get("namespace_registry_sha256")
    if namespace:
        _digest(registry_sha, "namespace registry digest")
    else:
        _require(registry_sha is None, "unnamespaced control has a registry digest")
    root = _text(source.get("source_root"), "source root", maximum=4096)
    _require(root.startswith("/") and ".." not in PurePosixPath(root).parts,
             "source root is not a canonical absolute path")
    _digest(source.get("state_root_sha256"), "state root binding")
    _require(isinstance(source.get("backend_container_id"), str)
             and CONTAINER_RE.fullmatch(source["backend_container_id"]) is not None,
             "backend container identity is invalid")
    _require(isinstance(source.get("frontend_container_id"), str)
             and CONTAINER_RE.fullmatch(source["frontend_container_id"]) is not None,
             "frontend container identity is invalid")
    _text(source.get("backend_started_at"), "backend StartedAt", maximum=128)
    _text(source.get("frontend_started_at"), "frontend StartedAt", maximum=128)
    _digest(source.get("runtime_config_sha256"), "retained runtime configuration digest")

    accepted = _exact(value.get("accepted"), ACCEPTED_FIELDS, "accepted Compute binding")
    _text(accepted.get("project_id"), "accepted project id", maximum=256)
    run_id = accepted.get("run_id")
    _require(isinstance(run_id, str) and RUN_ID_RE.fullmatch(run_id) is not None,
             "accepted run id is invalid")
    if expected_run_id is not None:
        _require(run_id == _text(expected_run_id, "expected run id", maximum=200),
                 "accepted run differs from requested run")
    _require(isinstance(accepted.get("session_id"), str)
             and PORTABLE_RE.fullmatch(accepted["session_id"]) is not None,
             "accepted session id is invalid")
    _require(type(accepted.get("session_epoch")) is int and 0 < accepted["session_epoch"] <= 2**64 - 1,
             "accepted session epoch is invalid")
    _require(type(accepted.get("session_created_at_unix_ms")) is int
             and 0 < accepted["session_created_at_unix_ms"] <= 2**64 - 1,
             "accepted public session creation time is invalid")
    api_id = _uuid(accepted.get("old_api_instance_id"), "old API identity")
    scope = accepted.get("old_request_scope_epoch")
    _require(isinstance(scope, str) and len(scope) <= 128
             and scope == api_id + ":" + str(accepted["session_epoch"]),
             "old request-scope epoch differs from its API identity")
    _require(type(accepted.get("scene_revision")) is int
             and 0 <= accepted["scene_revision"] <= 2**64 - 1,
             "accepted scene revision is invalid")
    for field in ("run_intent_sha256", "run_intent_payload_sha256", "definition_sha256",
                  "study_sha256", "accepted_scene_sha256", "execution_input_sha256",
                  "request_key_sha256", "request_receipt_sha256"):
        _digest(accepted.get(field), "accepted " + field)
    # request_sha256 is a digest supplied by the immutable receipt; its exact
    # value is pinned and rechecked against that receipt, not interpreted here.
    _digest(accepted.get("request_sha256"), "accepted request digest", allow_zero=True)
    _require(isinstance(accepted.get("command_id"), str)
             and COMMAND_ID_RE.fullmatch(accepted["command_id"]) is not None,
             "accepted command id is invalid")
    _require(accepted.get("command_kind") == "relax",
             "only the pinned manual Relax command is in this continuation scope")
    _text(accepted.get("client_intent_id"), "accepted client intent id", maximum=256)
    _uuid(accepted.get("request_id"), "accepted request id")

    authority = _exact(value.get("stop_authority"), STOP_AUTHORITY_FIELDS, "stop authority")
    stop_attempt = _token(authority.get("stop_attempt"), "stop attempt")
    _require(stop_attempt != plan["attempt"], "stop attempt aliases the old development attempt")
    request_root = "held-ui-materialization/" + maintenance_id
    _digest_ref(authority.get("preflight"), request_root + "/preflight.json", "preflight")
    _digest_ref(authority.get("api_quiescence"), request_root + "/api-quiescence.json", "API quiescence")
    _digest_ref(authority.get("native_drain"), request_root + "/native-drain.json", "native drain")
    _digest_ref(authority.get("inventory"), request_root + "/inventory.json", "inventory")
    terminal_path = (
        "held-ui-materialization-stop/attempts/" + stop_attempt + "/terminal.json"
    )
    _digest_ref(authority.get("terminal"), terminal_path, "outer stop terminal")
    return dict(value)


def validate_preflight(value: object, accepted: Mapping) -> dict:
    """Validate bounded actual API response and immutable HTTP Compute receipt."""
    _exact(value, {"schema", "source_scope", "api_response", "commands", "native_config_sha256",
                   "accepted_store_binding", "ready_owner_sha256", "process_sha256", "api_pin", "ready_owner_identity",
                   "run_intent_sha256", "execution_input_sha256"}, "preflight")
    _require(value.get("schema") == PREFLIGHT_SCHEMA, "preflight schema differs")
    source_scope = _exact(value.get("source_scope"), SOURCE_SCOPE_FIELDS, "preflight source scope")
    _require(source_scope == value.get("source_scope"), "preflight source scope is malformed")
    for field in ("native_config_sha256", "accepted_store_binding", "ready_owner_sha256", "process_sha256",
                  "run_intent_sha256", "execution_input_sha256"):
        _digest(value.get(field), "preflight " + field)
    _require(value["run_intent_sha256"] == accepted.get("run_intent_sha256")
             and value["execution_input_sha256"] == accepted.get("execution_input_sha256"),
             "preflight RunIntent or execution input differs from accepted pins")
    api_pin = _exact(value.get("api_pin"), {"pid", "start_token", "ppid", "argv", "exe"},
                     "preflight API process pin")
    _require(type(api_pin.get("pid")) is int and api_pin["pid"] > 1
             and type(api_pin.get("ppid")) is int and api_pin["ppid"] > 0
             and isinstance(api_pin.get("start_token"), str)
             and api_pin["start_token"].isdigit() and int(api_pin["start_token"]) > 0
             and api_pin.get("argv") == ["/opt/fullmag/package/bin/fullmag-api"]
             and api_pin.get("exe") == "/opt/fullmag/package/bin/fullmag-api",
             "preflight API process incarnation differs")
    owner_identity = _exact(value.get("ready_owner_identity"), {
        "owner_token", "process_start_token", "pid", "host", "target_id", "protocol",
        "build_commit", "build_snapshot", "control_address", "compute_pool_generation",
        "preparation_pool_generation", "compute_pool_id", "preparation_pool_id", "children",
    }, "preflight Ready owner identity")
    children = owner_identity.get("children")
    _require(isinstance(children, list) and len(children) == 2
             and children == sorted(children)
             and {tuple(child) for child in children if isinstance(child, list) and len(child) == 2}
             and {child[0] for child in children} == {"compute", "preparation"}
             and all(type(child[1]) is int and child[1] > 0 for child in children),
             "preflight Ready owner children differ")
    _require(sha(canonical(owner_identity)) == value["ready_owner_sha256"],
             "preflight Ready owner identity digest differs")
    response = _exact(value.get("api_response"), {"responses", "snapshot"}, "API response bundle")
    responses = _exact(response.get("responses"),
                       {"health", "status", "run", "scene", "queue", "commands", "runtime"},
                       "API response map")
    parsed = {}
    for name, body in responses.items():
        _exact(body, {"raw_base64", "sha256"}, name + " response")
        _text(body.get("raw_base64"), name + " response base64", maximum=MAX_PROOF_BYTES * 2)
        try:
            raw = base64.b64decode(body["raw_base64"], validate=True)
        except (ValueError, TypeError) as error:
            raise _error(name + " response is not valid base64") from error
        _require(len(raw) <= MAX_PROOF_BYTES, name + " response exceeds its limit")
        _require(sha(raw) == _digest(body.get("sha256"), name + " response digest", allow_zero=True),
                 name + " response bytes differ from their digest")
        parsed[name] = decode(raw, name + " API response")
    snapshot = _exact(response.get("snapshot"),
                      {"api_instance_id", "health", "status", "run", "scene", "queue", "commands", "runtime"},
                      "API snapshot")
    _require(all(snapshot[name] == parsed[name] for name in parsed),
             "parsed API snapshot differs from its raw responses")
    _uuid(snapshot.get("api_instance_id"), "current API identity")
    health, status = snapshot["health"], snapshot["status"]
    _require(health.get("status") == "ok" and health.get("active_session") is True,
             "API health or active-session state differs")
    _require(snapshot["runtime"].get("configured") is True and snapshot["runtime"].get("state") == "ready",
             "runtime service is not Ready")
    session = status.get("session", {})
    resources = status.get("resources", {})
    _require(session.get("session_id") == accepted.get("session_id")
             and session.get("session_epoch") == (
                 str(accepted.get("session_id")) + "@" + str(accepted.get("session_created_at_unix_ms")))
             and session.get("created_at") == str(accepted.get("session_created_at_unix_ms"))
             and session.get("request_scope_epoch") == accepted.get("old_request_scope_epoch")
             and snapshot["api_instance_id"] == accepted.get("old_api_instance_id"),
             "API/session/request-scope identity differs")
    # Bind the scene's exact API bytes; Rust and Python may spell the same nm floats differently.
    _require(resources.get("scene_revision") == accepted.get("scene_revision")
             and snapshot["scene"].get("revision") == accepted.get("scene_revision")
             and responses["scene"]["sha256"] == accepted.get("accepted_scene_sha256"),
             "accepted scene revision or canonical scene digest differs")
    run = snapshot["run"]
    _require(run.get("run_id") == accepted.get("run_id")
             and run.get("session_id") == accepted.get("session_id")
             and run.get("status") == "waiting_for_compute",
             "current public run differs from the held Compute")
    queue = snapshot["queue"]
    items = queue.get("items")
    _require(queue.get("schema_version") == "compute_queue.v1"
             and queue.get("next_cursor") is None
             and isinstance(queue.get("revision"), str)
             and re.fullmatch(r"sha256:[0-9a-f]{64}", queue["revision"]) is not None
             and isinstance(items, list) and len(items) == 1
             and items[0].get("run_id") == accepted.get("run_id")
             and items[0].get("project_id") == accepted.get("project_id")
             and items[0].get("state") == "pending_materialization"
             and items[0].get("task_id") is None,
             "compute queue is not the one exact pending-materialization item")

    commands = _exact(value.get("commands"),
                      {"ledger", "command", "request_receipt", "request_receipt_sha256", "detail"},
                      "accepted command receipt bundle")
    ledger = commands["ledger"]
    _require(ledger == snapshot["commands"], "command ledger differs from the raw API response")
    _require(isinstance(ledger.get("commands"), list)
             and all(entry.get("command_id") != accepted.get("command_id")
                     for entry in ledger["commands"] if isinstance(entry, dict)),
             "original command unexpectedly has a public ledger entry")
    command = commands["command"]
    receipt = commands["request_receipt"]
    _require(isinstance(command, Mapping) and command.get("seq") == 0
             and command.get("command_id") == accepted.get("command_id")
             and command.get("kind") == accepted.get("command_kind")
             and command.get("client_intent_id") == accepted.get("client_intent_id"),
             "RunIntent command differs from the pinned HTTP Compute")
    _require(isinstance(receipt, Mapping)
             and receipt.get("command_id") == accepted.get("command_id")
             and receipt.get("request_id") == accepted.get("request_id")
             and receipt.get("request_sha256") == accepted.get("request_sha256")
             and receipt.get("key_sha256") == accepted.get("request_key_sha256")
             and receipt.get("command_kind") == accepted.get("command_kind")
             and receipt.get("client_intent_id") == accepted.get("client_intent_id")
             and receipt.get("requested_target") == command.get("target"),
             "immutable Compute receipt differs from the request")
    receipt_sha = sha(canonical(receipt))
    _require(commands.get("request_receipt_sha256") == receipt_sha
             == accepted.get("request_receipt_sha256"),
             "immutable request receipt digest differs")
    detail = _exact(commands.get("detail"), {"http_status", "raw_base64", "sha256"},
                     "original command detail response")
    _require(detail.get("http_status") == 404, "original command detail is not the pinned 404")
    try:
        detail_raw = base64.b64decode(detail.get("raw_base64"), validate=True)
    except (ValueError, TypeError) as error:
        raise _error("command detail response is not valid base64") from error
    _require(len(detail_raw) <= MAX_PROOF_BYTES and sha(detail_raw) == detail.get("sha256"),
             "command detail response digest differs")
    return dict(value)


INVENTORY_FIELDS = {
    "run_id", "store_id", "run_intent_sha256", "run_intent_payload_sha256",
    "definition_sha256", "study_sha256", "execution_input", "run_files", "run_catalog_absent",
    "start_release_absent", "pending_materialization", "task_attempts", "leases",
    "workers", "outputs", "other_active_runs",
}


def validate_inventory(value: object, accepted: Mapping) -> dict:
    """Validate unchanged relevant store evidence while allowing terminal history."""
    _exact(value, {"schema", "before", "after"}, "inventory")
    _require(value.get("schema") == INVENTORY_SCHEMA, "inventory schema differs")
    before = _exact(value.get("before"), INVENTORY_FIELDS, "before inventory")
    after = _exact(value.get("after"), INVENTORY_FIELDS, "after inventory")
    _require(before == after, "relevant accepted-store inventory changed across stop")
    _require(before.get("run_id") == accepted.get("run_id")
             and before.get("run_intent_sha256") == accepted.get("run_intent_sha256")
             and before.get("run_intent_payload_sha256") == accepted.get("run_intent_payload_sha256")
             and before.get("definition_sha256") == accepted.get("definition_sha256")
             and before.get("study_sha256") == accepted.get("study_sha256"),
             "inventory does not match the accepted RunIntent/CAS bindings")
    execution_input = _exact(before.get("execution_input"), {"schema_version", "sha256"},
                             "inventory execution input")
    _require(execution_input.get("schema_version") == "fullmag.scene_execution_input.v1"
             and execution_input.get("sha256") == accepted.get("execution_input_sha256"),
             "inventory execution input differs from the immutable accepted RunIntent")
    _require(isinstance(before.get("store_id"), str)
             and re.fullmatch(r"sha256:[0-9a-f]{64}", before["store_id"]) is not None,
             "native store identity is invalid")
    files = before.get("run_files")
    _require(isinstance(files, list) and len(files) == 2
             and [entry.get("name") for entry in files if isinstance(entry, dict)]
             == ["live_demand.v1.json", "run_intent.json"]
             and all(set(entry) == {"name", "sha256"} for entry in files),
             "held run directory contains an unexpected record")
    for entry in files:
        _digest(entry["sha256"], "run file digest")
    intent_files = [entry for entry in files if entry["name"] == "run_intent.json"]
    _require(len(intent_files) == 1 and intent_files[0]["sha256"] == accepted.get("run_intent_sha256"),
             "run_intent.json bytes differ from the accepted intent digest")
    _require(before.get("run_catalog_absent") is True
             and before.get("start_release_absent") is True
             and before.get("pending_materialization") is True,
             "held run has a catalog, Start release, or no pending materialization")
    for field in ("task_attempts", "leases", "workers", "outputs", "other_active_runs"):
        _require(before.get(field) == [], "other active work exists in " + field)
    return dict(value)


def capture_readonly_preflight(backend_container_id: str, *, attempt: str,
                               maintenance_request_id: str, run_id: str,
                               source_scope: Mapping) -> tuple[dict, dict, dict]:
    """Capture bounded current API/native/store state without creating a control operation."""
    from docker_build_control import docker_capture
    _require(isinstance(backend_container_id, str)
             and CONTAINER_RE.fullmatch(backend_container_id) is not None,
             "preview backend container identity is invalid")
    _token(attempt, "preview development attempt")
    _uuid(maintenance_request_id, "preview maintenance request id")
    _text(run_id, "preview run id", maximum=200)
    _exact(source_scope, SOURCE_SCOPE_FIELDS, "preview source scope")
    payload = canonical({"run_id": run_id, "source_scope": dict(source_scope)})
    result = docker_capture(
        "exec", "-i", backend_container_id, "python3", "-I", "-B", "-c",
        HELD_READONLY_CAPTURE, data=payload, timeout=180,
    )
    _require(len(result.stdout) <= PREFLIGHT_CAPTURE_MAX,
             "read-only preview output exceeds its bound")
    captured = decode(bytes(result.stdout), "read-only preview capture",
                      maximum=PREFLIGHT_CAPTURE_MAX)
    _exact(captured, {"accepted", "preflight", "inventory"}, "read-only preview capture")
    accepted = captured["accepted"]
    stop_attempt = hashlib.sha256(
        ("held-ui-preview-stop:" + maintenance_request_id).encode("ascii")
    ).hexdigest()[:32]
    if stop_attempt == attempt:
        stop_attempt = ("0" if stop_attempt[0] != "0" else "1") + stop_attempt[1:]
    request_root = "held-ui-materialization/" + maintenance_request_id
    terminal_path = "held-ui-materialization-stop/attempts/" + stop_attempt + "/terminal.json"
    validate_request({
        "schema": REQUEST_SCHEMA,
        "plan": {"attempt": attempt, "plan_sha256": "f" * 64,
                  "maintenance_request_id": maintenance_request_id},
        "source_scope": dict(source_scope),
        "stop_authority": {
            "stop_attempt": stop_attempt,
            "terminal": {"path": terminal_path, "sha256": "e" * 64},
            "preflight": {"path": request_root + "/preflight.json", "sha256": "1" * 64},
            "api_quiescence": {"path": request_root + "/api-quiescence.json", "sha256": "2" * 64},
            "native_drain": {"path": request_root + "/native-drain.json", "sha256": "3" * 64},
            "inventory": {"path": request_root + "/inventory.json", "sha256": "4" * 64},
        },
        "accepted": accepted,
    }, expected_maintenance_request_id=maintenance_request_id, expected_run_id=run_id)
    preflight = validate_preflight(captured["preflight"], accepted)
    inventory = validate_inventory(captured["inventory"], accepted)
    _require(preflight["source_scope"] == source_scope,
             "read-only preview source scope changed during API capture")
    return dict(accepted), preflight, inventory


def build_preview_plan(*, attempt: str, maintenance_request_id: str, source_scope: Mapping,
                       accepted: Mapping, preflight: Mapping, inventory: Mapping) -> tuple[dict, str]:
    """Build a stable review plan, excluding volatile health uptime and raw response bytes."""
    _token(attempt, "development attempt")
    _uuid(maintenance_request_id, "maintenance request id")
    _exact(source_scope, SOURCE_SCOPE_FIELDS, "preview source scope")
    _exact(accepted, ACCEPTED_FIELDS, "preview accepted binding")
    snapshot = preflight.get("api_response", {}).get("snapshot", {})
    _require(isinstance(snapshot, Mapping), "preview API snapshot is missing")
    status = snapshot.get("status", {})
    session = status.get("session", {}) if isinstance(status, Mapping) else {}
    resources = status.get("resources", {}) if isinstance(status, Mapping) else {}
    run = snapshot.get("run", {})
    queue = snapshot.get("queue", {})
    commands = snapshot.get("commands", {})
    runtime = snapshot.get("runtime", {})
    queue_items = queue.get("items", []) if isinstance(queue, Mapping) else []
    stable_items = [{key: item.get(key) for key in ("item_id", "project_id", "run_id", "state", "task_id")}
                    for item in queue_items if isinstance(item, Mapping)]
    command_entries = commands.get("commands", []) if isinstance(commands, Mapping) else []
    stable_commands = [{key: entry.get(key) for key in (
        "command_id", "seq", "kind", "client_intent_id", "request_id", "status", "target")}
        for entry in command_entries if isinstance(entry, Mapping)]
    stable_command_counts = {key: commands.get(key) for key in (
        "pending_count", "accepted_count", "dispatched_count", "running_count",
        "completed_count", "rejected_count", "failed_count")}
    before = inventory.get("before", {}) if isinstance(inventory, Mapping) else {}
    plan = {
        "schema": "fullmag.development-held-ui-materialization-plan.v1",
        "attempt": attempt,
        "maintenance_request_id": maintenance_request_id,
        "source_scope": dict(source_scope),
        "accepted": dict(accepted),
        "current": {
            "api_instance_id": snapshot.get("api_instance_id"),
            "session": {key: session.get(key) for key in (
                "session_id", "session_epoch", "created_at", "request_scope_epoch")},
            "scene_revision": resources.get("scene_revision"),
            "scene_sha256": accepted.get("accepted_scene_sha256"),
            "run": {key: run.get(key) for key in (
                "run_id", "session_id", "revision", "status", "started_at")},
            "queue": {"revision": queue.get("revision"), "items": stable_items,
                      "next_cursor": queue.get("next_cursor")},
            "commands": {"revision": commands.get("revision"), "counts": stable_command_counts,
                         "commands": stable_commands},
            "runtime": {key: runtime.get(key) for key in (
                "schema_version", "configured", "state", "reason")},
            "health": {key: snapshot.get("health", {}).get(key) for key in ("status", "active_session")},
        },
        "native": {
            "config_sha256": preflight.get("native_config_sha256"),
            "accepted_store_binding": preflight.get("accepted_store_binding"),
            "process_sha256": preflight.get("process_sha256"),
            "api_pin": preflight.get("api_pin"),
            "ready_owner_sha256": preflight.get("ready_owner_sha256"),
            "run_intent_sha256": preflight.get("run_intent_sha256"),
            "execution_input_sha256": preflight.get("execution_input_sha256"),
        },
        "inventory": dict(before),
    }
    return plan, sha(canonical(plan))


def _quiescence_request_from_plan(plan: Mapping) -> dict:
    attempt = _token(plan.get("attempt"), "quiescence development attempt")
    maintenance_id = _uuid(plan.get("maintenance_request_id"), "quiescence maintenance request id")
    stop_attempt = "0" * 32 if attempt != "0" * 32 else "1" * 32
    request_root = "held-ui-materialization/" + maintenance_id
    return {
        "schema": REQUEST_SCHEMA,
        "plan": {"attempt": attempt, "plan_sha256": "f" * 64,
                 "maintenance_request_id": maintenance_id},
        "source_scope": plan.get("source_scope"),
        "stop_authority": {
            "stop_attempt": stop_attempt,
            "terminal": {"path": "held-ui-materialization-stop/attempts/" + stop_attempt + "/terminal.json",
                         "sha256": "9" * 64},
            "preflight": {"path": request_root + "/preflight.json", "sha256": "1" * 64},
            "api_quiescence": {"path": request_root + "/api-quiescence.json", "sha256": "2" * 64},
            "native_drain": {"path": request_root + "/native-drain.json", "sha256": "3" * 64},
            "inventory": {"path": request_root + "/inventory.json", "sha256": "4" * 64},
        },
        "accepted": plan.get("accepted"),
    }


def validate_api_quiescence_intent(
    value: object,
    *,
    expected_sha256: str | None = None,
    expected_plan_sha256: str | None = None,
) -> dict:
    """Validate the immutable held-run intent before any API-close signal."""
    intent = _exact(value, API_QUIESCE_INTENT_FIELDS, "API quiescence intent")
    _require(intent.get("schema") == API_QUIESCE_INTENT_SCHEMA, "API quiescence intent schema differs")
    _digest(intent.get("plan_sha256"), "quiescence preview plan digest")
    if expected_plan_sha256 is not None:
        _require(intent["plan_sha256"] == _digest(expected_plan_sha256, "expected preview plan digest"),
                 "approved preview plan changed before API quiescence")
    _digest(intent.get("preflight_sha256"), "quiescence preflight digest")
    _digest(intent.get("inventory_sha256"), "quiescence inventory digest")
    plan = _exact(intent.get("plan"), {
        "schema", "attempt", "maintenance_request_id", "source_scope", "accepted",
        "current", "native", "inventory",
    }, "quiescence preview plan")
    _require(plan.get("schema") == "fullmag.development-held-ui-materialization-plan.v1",
             "quiescence preview plan schema differs")
    _token(plan.get("attempt"), "quiescence development attempt")
    maintenance_id = _uuid(plan.get("maintenance_request_id"), "quiescence maintenance request id")
    _require(sha(canonical(plan)) == intent["plan_sha256"], "quiescence preview plan bytes differ")
    request = validate_request(_quiescence_request_from_plan(plan))
    accepted = request["accepted"]
    current = _exact(plan.get("current"), {
        "api_instance_id", "session", "scene_revision", "scene_sha256", "run",
        "queue", "commands", "runtime", "health",
    }, "quiescence API context")
    api_id = _uuid(current.get("api_instance_id"), "quiescence API identity")
    _require(api_id == accepted["old_api_instance_id"], "quiescence API identity differs from accepted RunIntent")
    session = _exact(current.get("session"), {
        "session_id", "session_epoch", "created_at", "request_scope_epoch",
    }, "quiescence session scope")
    _require(session.get("session_id") == accepted["session_id"]
             and session.get("session_epoch") == accepted["session_id"] + "@"
                 + str(accepted["session_created_at_unix_ms"])
             and session.get("created_at") == str(accepted["session_created_at_unix_ms"])
             and session.get("request_scope_epoch") == accepted["old_request_scope_epoch"],
             "quiescence session/request-scope identity differs")
    _require(current.get("scene_revision") == accepted["scene_revision"]
             and current.get("scene_sha256") == accepted["accepted_scene_sha256"],
             "quiescence scene basis differs")
    run = _exact(current.get("run"), {"run_id", "session_id", "revision", "status", "started_at"},
                 "quiescence public run")
    _require(run.get("run_id") == accepted["run_id"] and run.get("session_id") == accepted["session_id"]
             and run.get("status") == "waiting_for_compute", "quiescence public run differs")
    queue = _exact(current.get("queue"), {"revision", "items", "next_cursor"}, "quiescence queue")
    items = queue.get("items")
    _require(queue.get("next_cursor") is None and isinstance(items, list) and len(items) == 1
             and items[0].get("run_id") == accepted["run_id"]
             and items[0].get("project_id") == accepted["project_id"]
             and items[0].get("state") == "pending_materialization" and items[0].get("task_id") is None,
             "quiescence queue is not the exact held run")
    commands = _exact(current.get("commands"), {"revision", "counts", "commands"},
                      "quiescence public command ledger")
    _require(commands.get("commands") == [] and isinstance(commands.get("counts"), Mapping)
             and all(commands["counts"].get(name) == 0 for name in (
                 "pending_count", "accepted_count", "dispatched_count", "running_count")),
             "quiescence command ledger has another active or published command")
    runtime = _exact(current.get("runtime"), {"schema_version", "configured", "state", "reason"},
                     "quiescence runtime status")
    _require(runtime.get("configured") is True and runtime.get("state") == "ready",
             "quiescence runtime is not Ready")
    health = _exact(current.get("health"), {"status", "active_session"}, "quiescence health")
    _require(health == {"status": "ok", "active_session": True}, "quiescence API health differs")

    native = _exact(plan.get("native"), {
        "config_sha256", "accepted_store_binding", "process_sha256", "api_pin", "ready_owner_sha256",
        "run_intent_sha256", "execution_input_sha256",
    }, "quiescence native pins")
    for field in ("config_sha256", "accepted_store_binding", "process_sha256", "ready_owner_sha256",
                  "run_intent_sha256", "execution_input_sha256"):
        _digest(native.get(field), "quiescence native " + field)
    _require(native.get("run_intent_sha256") == accepted["run_intent_sha256"]
             and native.get("execution_input_sha256") == accepted["execution_input_sha256"],
             "quiescence native RunIntent or execution input differs")
    api_pin = _exact(native.get("api_pin"), {"pid", "start_token", "ppid", "argv", "exe"},
                     "quiescence API process pin")
    _require(type(api_pin.get("pid")) is int and api_pin["pid"] > 1
             and type(api_pin.get("ppid")) is int and api_pin["ppid"] > 0
             and isinstance(api_pin.get("start_token"), str)
             and api_pin["start_token"].isdigit() and int(api_pin["start_token"]) > 0
             and api_pin.get("argv") == ["/opt/fullmag/package/bin/fullmag-api"]
             and api_pin.get("exe") == "/opt/fullmag/package/bin/fullmag-api",
             "quiescence API PID incarnation differs")
    ready_owner = _exact(intent.get("ready_owner_identity"), {
        "owner_token", "process_start_token", "pid", "host", "target_id", "protocol",
        "build_commit", "build_snapshot", "control_address", "compute_pool_generation",
        "preparation_pool_generation", "compute_pool_id", "preparation_pool_id", "children",
    }, "quiescence Ready owner identity")
    _require(sha(canonical(ready_owner)) == native["ready_owner_sha256"],
             "quiescence Ready owner digest differs")
    inventory = _exact(plan.get("inventory"), INVENTORY_FIELDS, "quiescence store inventory")
    validate_inventory({"schema": INVENTORY_SCHEMA, "before": inventory, "after": inventory}, accepted)
    if expected_sha256 is not None:
        _require(sha(canonical(intent) + b"\n") == _digest(expected_sha256, "expected intent digest"),
                 "immutable API quiescence intent digest differs")
    return dict(intent)


def prepare_api_quiescence_intent(*, attempt: str, maintenance_request_id: str,
                                  plan_sha256: str, source_scope: Mapping, accepted: Mapping,
                                  preflight: Mapping, inventory: Mapping) -> tuple[dict, bytes, str]:
    """Prepare an immutable, scope-pinned API-close intent without signaling the backend."""
    _token(attempt, "quiescence development attempt")
    _uuid(maintenance_request_id, "quiescence maintenance request id")
    _digest(plan_sha256, "approved preview plan digest")
    _exact(source_scope, SOURCE_SCOPE_FIELDS, "quiescence source scope")
    preflight = validate_preflight(preflight, accepted)
    inventory = validate_inventory(inventory, accepted)
    _require(preflight.get("source_scope") == source_scope,
             "quiescence source scope differs from the captured preflight")
    plan, actual_plan_sha256 = build_preview_plan(
        attempt=attempt, maintenance_request_id=maintenance_request_id,
        source_scope=source_scope, accepted=accepted, preflight=preflight, inventory=inventory,
    )
    _require(actual_plan_sha256 == _digest(plan_sha256, "approved preview plan digest"),
             "API quiescence basis differs from the approved preview plan")
    intent = {
        "schema": API_QUIESCE_INTENT_SCHEMA,
        "plan_sha256": actual_plan_sha256,
        "preflight_sha256": sha(canonical(preflight) + b"\n"),
        "inventory_sha256": sha(canonical(inventory) + b"\n"),
        "ready_owner_identity": preflight["ready_owner_identity"],
        "plan": plan,
    }
    raw = canonical(validate_api_quiescence_intent(intent, expected_plan_sha256=plan_sha256)) + b"\n"
    _require(len(raw) <= MAX_PROOF_BYTES, "API quiescence intent exceeds its byte limit")
    return intent, raw, sha(raw)


def quiescence_intent_relative(maintenance_request_id: str) -> str:
    return request_relative(maintenance_request_id).rsplit("/", 1)[0] + "/api-quiescence-intent.json"


def quiescence_start_claim_relative(maintenance_request_id: str) -> str:
    return request_relative(maintenance_request_id).rsplit("/", 1)[0] + "/api-quiescence-start.json"


def _publish_immutable_record(control, relative: str, raw: bytes, label: str) -> str:
    control_path = "runtime-control/" + relative
    existing = control.read_bytes(control_path, optional=True)
    if existing is not None:
        _require(existing == raw, "maintenance request already has different " + label + " bytes")
    else:
        control.write_bytes(control_path, raw)
    return sha(raw)


def publish_api_quiescence_inputs(control, maintenance_request_id: str, *, source_scope: Mapping,
                                  accepted: Mapping, preflight: Mapping,
                                  inventory: Mapping) -> dict:
    """Durably pin the actual read-only API and store observations before API closure."""
    maintenance_id = _uuid(maintenance_request_id, "quiescence maintenance request id")
    _exact(source_scope, SOURCE_SCOPE_FIELDS, "quiescence source scope")
    preflight = validate_preflight(preflight, accepted)
    inventory = validate_inventory(inventory, accepted)
    _require(preflight.get("source_scope") == source_scope,
             "quiescence source scope differs from the captured preflight")
    root = request_relative(maintenance_id).rsplit("/", 1)[0]
    preflight_raw = canonical(preflight) + b"\n"
    inventory_raw = canonical(inventory) + b"\n"
    _require(len(preflight_raw) <= MAX_PROOF_BYTES and len(inventory_raw) <= MAX_PROOF_BYTES,
             "quiescence API or store input exceeds its proof byte limit")
    return {
        "preflight": {"path": root + "/preflight.json",
                      "sha256": _publish_immutable_record(
                          control, root + "/preflight.json", preflight_raw, "preflight")},
        "inventory": {"path": root + "/inventory.json",
                      "sha256": _publish_immutable_record(
                          control, root + "/inventory.json", inventory_raw, "inventory")},
    }


def _validate_durable_quiescence_inputs(control, intent: Mapping) -> None:
    maintenance_id = intent["plan"]["maintenance_request_id"]
    root = request_relative(maintenance_id).rsplit("/", 1)[0]
    preflight_raw = control.read_bytes("runtime-control/" + root + "/preflight.json")
    inventory_raw = control.read_bytes("runtime-control/" + root + "/inventory.json")
    _require(isinstance(preflight_raw, bytes) and len(preflight_raw) <= MAX_PROOF_BYTES
             and sha(preflight_raw) == intent["preflight_sha256"],
             "durable API preflight bytes differ from the quiescence intent")
    _require(isinstance(inventory_raw, bytes) and len(inventory_raw) <= MAX_PROOF_BYTES
             and sha(inventory_raw) == intent["inventory_sha256"],
             "durable store inventory bytes differ from the quiescence intent")
    preflight = decode(preflight_raw, "durable quiescence preflight", maximum=MAX_PROOF_BYTES)
    inventory = decode(inventory_raw, "durable quiescence inventory", maximum=MAX_PROOF_BYTES)
    accepted = intent["plan"]["accepted"]
    preflight = validate_preflight(preflight, accepted)
    inventory = validate_inventory(inventory, accepted)
    _require(preflight_raw == canonical(preflight) + b"\n"
             and inventory_raw == canonical(inventory) + b"\n",
             "durable API or store input is not canonical JSON plus LF")
    _require(preflight.get("source_scope") == intent["plan"]["source_scope"],
             "durable API preflight source scope differs")
    plan, plan_sha256 = build_preview_plan(
        attempt=intent["plan"]["attempt"],
        maintenance_request_id=maintenance_id,
        source_scope=intent["plan"]["source_scope"],
        accepted=accepted, preflight=preflight, inventory=inventory,
    )
    _require(plan_sha256 == intent["plan_sha256"] and plan == intent["plan"],
             "durable API/store inputs no longer reproduce the approved preview plan")


def publish_api_quiescence_intent(control, intent: Mapping, *,
                                  expected_plan_sha256: str) -> tuple[str, str]:
    """Publish the prepared close intent with immutable request-id CAS semantics."""
    validated = validate_api_quiescence_intent(intent, expected_plan_sha256=expected_plan_sha256)
    raw = canonical(validated) + b"\n"
    _require(len(raw) <= MAX_PROOF_BYTES, "API quiescence intent exceeds its byte limit")
    _validate_durable_quiescence_inputs(control, validated)
    relative = quiescence_intent_relative(validated["plan"]["maintenance_request_id"])
    return relative, _publish_immutable_record(control, relative, raw, "API quiescence intent")


def _expected_api_quiescence_fences(intent: Mapping, retained_process_sha256: str | None = None) -> dict:
    plan = intent["plan"]
    accepted = plan["accepted"]
    native = plan["native"]
    before = {
        "plan_sha256": intent["plan_sha256"],
        "source_scope_sha256": sha(canonical(plan["source_scope"])),
        "preflight_sha256": intent["preflight_sha256"],
        "inventory_sha256": intent["inventory_sha256"],
        "api_context_sha256": sha(canonical(plan["current"])),
        "native_config_sha256": native["config_sha256"],
        "accepted_store_binding": native["accepted_store_binding"],
        "process_sha256": native["process_sha256"],
        "api_pin": native["api_pin"],
        "ready_owner_sha256": native["ready_owner_sha256"],
        "run_intent_sha256": accepted["run_intent_sha256"],
        "execution_input_sha256": accepted["execution_input_sha256"],
        "store_id": plan["inventory"]["store_id"],
    }
    after = {
        "native_config_sha256": native["config_sha256"],
        "accepted_store_binding": native["accepted_store_binding"],
        "inventory_sha256": sha(canonical(plan["inventory"])),
        "ready_owner_sha256": native["ready_owner_sha256"],
    }
    if retained_process_sha256 is not None:
        after["retained_process_sha256"] = _digest(
            retained_process_sha256, "retained process digest",
        )
    return {"before": before, "after": after}


def held_api_quiescence_capture_program() -> str:
    from docker_volume_native_terminal_stop import quiescence_capture_program
    return quiescence_capture_program(
        HELD_API_QUIESCE_CAPTURE_BODY, prelude=HELD_READONLY_CAPTURE_PRELUDE,
    )


def _require_held_stop_operation(control, operation: Mapping) -> str:
    """Require the group-wide operation lease before creating a spent claim."""
    receipt = operation.get("receipt") if isinstance(operation, Mapping) else None
    attempt = receipt.get("attempt") if isinstance(receipt, Mapping) else None
    _require(isinstance(operation, dict)
             and getattr(control, "_active_operation", None) is operation
             and operation.get("lease_ready") is True
             and operation.get("daemon_pending") is False
             and isinstance(receipt, dict)
             and receipt.get("schema") == "fullmag.docker-build-operation.v1"
             and receipt.get("phase") == "held-ui-materialization-stop"
             and receipt.get("compose_project") == getattr(control, "project", None)
             and receipt.get("control_volume") == getattr(control, "volume", None)
             and receipt.get("control_namespace", "") == getattr(control, "namespace", "")
             and isinstance(attempt, str) and TOKEN_RE.fullmatch(attempt) is not None
             and operation.get("root") == "held-ui-materialization-stop/attempts/" + attempt,
             "API quiescence requires the active group held-stop operation lease")
    return attempt


def _exclusive_start_claim(control, operation: dict, intent: Mapping,
                           intent_sha256: str) -> dict:
    """Create a durable no-replay claim with O_EXCL while the group lease is held."""
    from docker_build_control import docker_capture

    operation_attempt = _require_held_stop_operation(control, operation)
    plan = intent["plan"]
    accepted = plan["accepted"]
    maintenance_id = plan["maintenance_request_id"]
    relative = quiescence_start_claim_relative(maintenance_id)
    control_relative = "runtime-control/" + relative
    _require(control.read_bytes(control_relative, optional=True) is None,
             "API quiescence start claim already exists; replay is prohibited until typed reconciliation")

    claim = {
        "schema": "fullmag.held-ui-materialization-api-quiescence-start.v1",
        "state": "started",
        "maintenance_request_id": maintenance_id,
        "plan_sha256": intent["plan_sha256"],
        "intent_sha256": intent_sha256,
        "run_id": accepted["run_id"],
        "run_intent_sha256": accepted["run_intent_sha256"],
        "backend_container_id": plan["source_scope"]["backend_container_id"],
        "operation_attempt": operation_attempt,
    }
    raw = canonical(claim) + b"\n"
    _require(len(raw) <= 16 * 1024, "API quiescence start claim exceeds its byte limit")
    path = control.path(control_relative)
    program = "\n".join((
        "import os,sys",
        "path=" + repr(path),
        "parent=os.path.dirname(path)",
        "data=sys.stdin.buffer.read(16385)",
        "if not data or len(data)>16384: raise SystemExit('claim size differs')",
        "if not os.path.isdir(parent) or os.path.realpath(parent)!=parent: raise SystemExit('claim parent differs')",
        "flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0)",
        "fd=os.open(path,flags,0o640)",
        "try:",
        " view=memoryview(data)",
        " while view:",
        "  written=os.write(fd,view)",
        "  if written<=0: raise OSError('claim write made no progress')",
        "  view=view[written:]",
        " os.fsync(fd)",
        "finally: os.close(fd)",
        "dirfd=os.open(parent,os.O_RDONLY|getattr(os,'O_DIRECTORY',0)|getattr(os,'O_NOFOLLOW',0))",
        "try: os.fsync(dirfd)",
        "finally: os.close(dirfd)",
        "sys.stdout.write('CLAIMED\\n')",
    ))
    import shlex
    try:
        result = docker_capture(*control.helper_args(
            "exec /usr/local/bin/python3 -I -c " + shlex.quote(program),
        ), data=raw, timeout=90)
    except Exception as error:
        raise _error("API quiescence start claim could not be confirmed; no API exec was attempted") from error
    _require(result.returncode == 0 and result.stdout == b"CLAIMED\n",
             "API quiescence start claim already exists or was not durably created")
    _require(control.read_bytes(control_relative, optional=True) == raw,
             "API quiescence start claim bytes could not be re-read exactly")
    reference = {"path": relative, "sha256": sha(raw), "operation_attempt": operation_attempt,
                 "state": "started"}
    operation["receipt"]["held_ui_api_quiescence_claim"] = reference
    return reference


def capture_held_api_quiescence(control, backend_container_id: str, intent: Mapping, *,
                                operation: Mapping,
                                expected_plan_sha256: str,
                                expected_intent_sha256: str) -> dict:
    """Close only the pinned API incarnation and return its truthful retained-exit receipt."""
    from docker_build_control import docker_capture
    from docker_volume_native_terminal_stop import QUIESCE_SCHEMA, validate_quiescence
    intent = validate_api_quiescence_intent(
        intent, expected_sha256=expected_intent_sha256,
        expected_plan_sha256=expected_plan_sha256,
    )
    expected_backend = intent["plan"]["source_scope"]["backend_container_id"]
    _require(backend_container_id == expected_backend,
             "API quiescence backend differs from the pinned source service")
    raw_intent = canonical(intent) + b"\n"
    relative = quiescence_intent_relative(intent["plan"]["maintenance_request_id"])
    _validate_durable_quiescence_inputs(control, intent)
    durable_intent = control.read_bytes("runtime-control/" + relative)
    _require(durable_intent == raw_intent and sha(durable_intent) == expected_intent_sha256,
             "API quiescence intent was not durably published with its approved digest")
    operation_attempt = _require_held_stop_operation(control, operation)
    claim = _exclusive_start_claim(control, operation, intent, sha(raw_intent))
    request = canonical({"intent": intent, "intent_sha256": sha(raw_intent)})
    operation["daemon_pending"] = True
    try:
        result = docker_capture(
            "exec", "-i", backend_container_id, "python3", "-I", "-B", "-c",
            held_api_quiescence_capture_program(), data=request, timeout=210,
        )
        _require(len(result.stdout) <= MAX_PROOF_BYTES,
                 "held API quiescence output exceeds its byte limit")
        captured = decode(bytes(result.stdout), "held API quiescence capture", maximum=MAX_PROOF_BYTES)
        _exact(captured, {"receipt", "fences"}, "held API quiescence capture")
        receipt = _exact(captured["receipt"], {
            "schema", "intent_sha256", "api_pin", "api_closed", "signal",
            "retained_process", "retained_process_sha256",
        }, "held API quiescence receipt")
        _require(receipt.get("schema") == QUIESCE_SCHEMA
                 and receipt.get("intent_sha256") == sha(raw_intent)
                 and receipt.get("api_pin") == intent["plan"]["native"]["api_pin"]
                 and receipt.get("api_closed") is True and receipt.get("signal") == "SIGTERM",
                 "held API quiescence receipt does not bind the exact closure intent")
        validate_quiescence({
            "ready_owner": intent["ready_owner_identity"],
            "api_quiescence": receipt,
        })
        expected_fences = _expected_api_quiescence_fences(intent, receipt["retained_process_sha256"])
        _require(captured.get("fences") == expected_fences,
                 "held API quiescence scope/config/scene/receipt fences differ")
    except BaseException:
        claim["state"] = "outcome-unknown"
        operation["receipt"]["held_ui_api_quiescence_claim"] = claim
        raise
    claim["state"] = "consumed"
    claim["quiescence_receipt_sha256"] = sha(canonical(receipt) + b"\n")
    claim["operation_attempt"] = operation_attempt
    operation["receipt"]["held_ui_api_quiescence_claim"] = claim
    operation["daemon_pending"] = False
    return dict(receipt)


def validate_stop_proofs(request: Mapping, read_control_record) -> dict:
    """Revalidate every pinned proof, including actual API close and native drain."""
    request = validate_request(request)
    accepted = request["accepted"]
    authority = request["stop_authority"]
    proofs = {}
    proof_raws = {}
    for key in ("preflight", "api_quiescence", "native_drain", "inventory", "terminal"):
        ref = authority[key]
        raw = read_control_record(ref["path"])
        _require(isinstance(raw, bytes) and len(raw) <= MAX_PROOF_BYTES,
                 key + " proof exceeds its byte limit")
        _require(sha(raw) == ref["sha256"], key + " proof raw SHA differs")
        proofs[key] = decode(raw, key + " proof")
        proof_raws[key] = raw

    preflight = validate_preflight(proofs["preflight"], accepted)
    source_scope = request["source_scope"]
    _require(preflight["source_scope"] == source_scope,
             "preflight selected source or service incarnation differs from the request")
    validate_inventory(proofs["inventory"], accepted)
    quiescence = proofs["api_quiescence"]
    terminal = proofs["terminal"]
    _exact(quiescence, {"schema", "intent_sha256", "api_pin", "api_closed", "signal",
                        "retained_process", "retained_process_sha256"}, "API quiescence")
    _require(quiescence.get("schema") == "fullmag.native-terminal-api-quiescence.v1"
             and quiescence.get("api_closed") is True and quiescence.get("signal") == "SIGTERM",
             "actual API closure receipt differs")
    terminal_intent_sha256 = terminal.get("api_quiescence_intent_sha256")
    _digest(terminal_intent_sha256, "terminal API quiescence intent digest")
    _require(quiescence.get("intent_sha256") == terminal_intent_sha256,
             "API closure receipt differs from the intent pinned by the terminal")
    api_pin = quiescence.get("api_pin", {})
    _require(api_pin == preflight["api_pin"]
             and api_pin.get("argv") == ["/opt/fullmag/package/bin/fullmag-api"]
             and api_pin.get("exe") == "/opt/fullmag/package/bin/fullmag-api",
             "quiesced API process identity differs")
    retained_process = quiescence.get("retained_process", {})
    ready_owner = retained_process.get("service_owner")
    retained_bootstrap = retained_process.get("bootstrap")
    expected_store_root = "/state/runs/docker-all/session-store"
    _require(retained_process.get("accepted_store") == expected_store_root
             and retained_process.get("api_diagnostic_only") is False
             and isinstance(retained_bootstrap, Mapping)
             and retained_bootstrap.get("schema") == "fullmag.docker-accepted-store-bootstrap.v1"
             and retained_bootstrap.get("store_root") == expected_store_root
             and retained_bootstrap.get("binding") == preflight["accepted_store_binding"],
             "quiesced process accepted-store path, bootstrap binding, or capability differs")
    from docker_volume_native_terminal_stop import owner_identity
    _require(canonical(owner_identity(ready_owner)) == canonical(preflight["ready_owner_identity"]),
             "quiescence Ready owner differs from preflight")
    process_raw = (json.dumps(retained_process, sort_keys=True, separators=(",", ":")) + "\n").encode()
    _require(sha(process_raw) == quiescence.get("retained_process_sha256"),
             "quiescence retained process digest differs")
    from docker_volume_native_terminal_stop import validate_drain
    validate_drain({"ready_owner": preflight["ready_owner_identity"],
                    "api_quiescence": quiescence},
                   proofs["native_drain"])
    _require(canonical(owner_identity(proofs["native_drain"].get("service_owner", {})))
             == canonical(preflight["ready_owner_identity"]),
             "native drain owner differs from preflight")

    _require(terminal.get("schema") == "fullmag.docker-build-operation.v1"
             and terminal.get("phase") == "held-ui-materialization-stop"
             and terminal.get("attempt") == authority.get("stop_attempt")
             and terminal.get("state") == "succeeded"
             and terminal.get("idle_backend_stopped") is True
             and terminal.get("compose_project") == source_scope["compose_project"]
             and terminal.get("control_volume") == source_scope["control_volume"]
             and terminal.get("control_namespace", "") == source_scope["namespace"]
             and terminal.get("namespace_registry_sha256") == source_scope["namespace_registry_sha256"]
             and terminal.get("config_sha256") == source_scope["runtime_config_sha256"]
             and terminal.get("inputs", {}).get("source_root") == source_scope["source_root"]
             and terminal.get("inputs", {}).get("attempt") == request["plan"]["attempt"]
             and terminal.get("inputs", {}).get("source_scope") == source_scope
             and terminal.get("inputs", {}).get("config_sha256") == source_scope["runtime_config_sha256"]
             and terminal.get("inputs", {}).get("maintenance_request_id")
                 == request["plan"]["maintenance_request_id"]
             and terminal.get("inputs", {}).get("plan_sha256") == request["plan"]["plan_sha256"]
             and terminal.get("inputs", {}).get("run_id") == accepted["run_id"]
             and terminal.get("inputs", {}).get("accepted_run_id") == accepted["run_id"]
             and terminal.get("inputs", {}).get("capture_held_ui_materialization") is True
             and terminal.get("backend_container") == source_scope["backend_container_id"]
             and terminal.get("frontend_container") == source_scope["frontend_container_id"]
             and terminal.get("backend_started_at") == source_scope["backend_started_at"]
             and terminal.get("frontend_started_at") == source_scope["frontend_started_at"],
             "outer stop terminal does not prove this completed stop")
    terminal_proofs = _exact(terminal.get("held_ui_stop_proofs"),
                             {"preflight", "api_quiescence", "native_drain", "inventory"},
                             "terminal held UI stop proof references")
    for key, reference in terminal_proofs.items():
        _exact(reference, {"path", "sha256"}, "terminal " + key + " proof reference")
        _require(reference == authority[key],
                 "outer stop terminal and request proof references differ: " + key)

    claim_reference = _exact(terminal.get("held_ui_api_quiescence_claim"), {
        "path", "sha256", "operation_attempt", "state", "quiescence_receipt_sha256",
    }, "terminal API quiescence start-claim reference")
    claim_path = quiescence_start_claim_relative(request["plan"]["maintenance_request_id"])
    _require(claim_reference.get("path") == claim_path
             and claim_reference.get("operation_attempt") == authority["stop_attempt"]
             and claim_reference.get("state") == "consumed",
             "outer stop terminal does not bind the spent API quiescence claim")
    _digest(claim_reference.get("sha256"), "terminal API quiescence claim digest")
    _digest(claim_reference.get("quiescence_receipt_sha256"),
            "terminal API quiescence receipt digest")
    claim_raw = read_control_record(claim_path)
    _require(isinstance(claim_raw, bytes) and len(claim_raw) <= 16 * 1024
             and sha(claim_raw) == claim_reference["sha256"],
             "spent API quiescence claim bytes differ from the stop terminal")
    claim = _exact(decode(claim_raw, "API quiescence start claim", maximum=16 * 1024), {
        "schema", "state", "maintenance_request_id", "plan_sha256", "intent_sha256",
        "run_id", "run_intent_sha256", "backend_container_id", "operation_attempt",
    }, "API quiescence start claim")
    _require(claim_raw == canonical(claim) + b"\n"
             and claim.get("schema") == "fullmag.held-ui-materialization-api-quiescence-start.v1"
             and claim.get("state") == "started"
             and claim.get("maintenance_request_id") == request["plan"]["maintenance_request_id"]
             and claim.get("plan_sha256") == request["plan"]["plan_sha256"]
             and claim.get("intent_sha256") == terminal.get("api_quiescence_intent_sha256")
             and claim.get("run_id") == accepted["run_id"]
             and claim.get("run_intent_sha256") == accepted["run_intent_sha256"]
             and claim.get("backend_container_id") == source_scope["backend_container_id"]
             and claim.get("operation_attempt") == authority["stop_attempt"],
             "spent API quiescence claim differs from the accepted stop scope")
    intent_path = quiescence_intent_relative(request["plan"]["maintenance_request_id"])
    intent_raw = read_control_record(intent_path)
    _require(isinstance(intent_raw, bytes) and len(intent_raw) <= MAX_PROOF_BYTES
             and sha(intent_raw) == claim.get("intent_sha256") == terminal_intent_sha256,
             "spent API quiescence claim does not bind its durable intent bytes")
    intent = decode(intent_raw, "API quiescence intent", maximum=MAX_PROOF_BYTES)
    validate_api_quiescence_intent(
        intent, expected_sha256=terminal_intent_sha256,
        expected_plan_sha256=request["plan"]["plan_sha256"],
    )
    quiescence_raw = proof_raws["api_quiescence"]
    _require(quiescence_raw == canonical(quiescence) + b"\n"
             and claim_reference["quiescence_receipt_sha256"] == sha(quiescence_raw),
             "spent API quiescence claim does not bind the exact closure receipt")
    stopped = _exact(terminal.get("held_ui_stop_services"), {"backend", "frontend"},
                     "stopped service incarnation pins")
    for name in ("backend", "frontend"):
        expected_id = source_scope[name + "_container_id"]
        expected_started = source_scope[name + "_started_at"]
        service = _exact(stopped[name], {"id", "image_id", "started_at", "running"},
                         name + " stopped service pin")
        _require(service.get("id") == expected_id and service.get("started_at") == expected_started
                 and service.get("running") is False,
                 name + " stopped service incarnation differs")
    _require(sha(canonical(stopped) + b"\n") == terminal.get("held_ui_stop_services_sha256"),
             "outer stop terminal service-incarnation digest differs")
    return proofs


def load_request(control, maintenance_request_id: str, expected_sha256: str | None = None) -> tuple[dict, bytes]:
    relative = request_relative(maintenance_request_id)
    raw = control.read_bytes("runtime-control/" + relative)
    _require(len(raw) <= MAX_REQUEST_BYTES, "request exceeds its byte limit")
    if expected_sha256 is not None:
        _require(sha(raw) == _digest(expected_sha256, "request digest"),
                 "immutable request bytes changed")
    value = decode(raw, "request", maximum=MAX_REQUEST_BYTES)
    validated = validate_request(value, expected_maintenance_request_id=maintenance_request_id)
    _require(raw == canonical(validated) + b"\n", "request is not canonical JSON plus LF")
    return validated, raw


def publish_request(control, value: Mapping) -> tuple[str, str]:
    validated = validate_request(value)
    raw = canonical(validated) + b"\n"
    _require(len(raw) <= MAX_REQUEST_BYTES, "request exceeds its byte limit")
    relative = request_relative(validated["plan"]["maintenance_request_id"])
    # Immutable publication is handled by the image-owned control-volume writer.
    existing = control.read_bytes("runtime-control/" + relative, optional=True)
    if existing is not None:
        _require(existing == raw, "maintenance request id already binds different bytes")
    else:
        control.write_bytes("runtime-control/" + relative, raw)
    return relative, sha(raw)


def run(args):
    """Public action entry; the retained DEV lifecycle owns Docker orchestration."""
    from docker_volume_dev import _run_held_ui_materialization
    return _run_held_ui_materialization(args, controller=sys.modules[__name__])
