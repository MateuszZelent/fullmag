"""Narrow read-only proof for restarting saved authoring after pre-claim cancellation.

This does not cancel/retry a task, clear a lease, edit a catalog, or stop a service.
The existing saved-authoring owner, archive, drain and restore gates still apply.
"""
from __future__ import annotations

import hashlib
import re

from docker_build_control import BuildControlError, canonical

SCHEMA = "fullmag.saved-authoring-preclaim-cancelled-restart.v1"
HASH_FIELDS = ("run_intent_sha256", "run_catalog_sha256", "cancellation_intent_sha256",
               "command_sha256", "live_run_sha256")
ID_FIELDS = ("run_id", "task_id", "command_id")


def require(value, message):
    if not value:
        raise BuildControlError("Pre-claim cancelled restart: " + message)


def validate_checkpoint(request):
    special = request.get("schema") == SCHEMA
    require(("cancelled_preclaim" in request) == special, "checkpoint schema/pins differ")
    if not special:
        return None
    pin = request["cancelled_preclaim"]
    require(isinstance(pin, dict), "pin must be an object")
    stop = "stop_command_id" in pin or "stop_command_sha256" in pin
    hashes = HASH_FIELDS + (("stop_command_sha256",) if stop else ())
    identities = ID_FIELDS + (("stop_command_id",) if stop else ())
    require(set(pin) == set(hashes + identities), "pin fields differ")
    for name in hashes:
        require(isinstance(pin[name], str) and re.fullmatch("[0-9a-f]{64}", pin[name])
                and pin[name] != "0" * 64, "invalid digest: " + name)
    for name in identities:
        require(isinstance(pin[name], str) and re.fullmatch("[A-Za-z0-9][A-Za-z0-9_-]{0,255}", pin[name]),
                "invalid identity: " + name)
    require(not stop or pin["stop_command_id"] != pin["command_id"], "Stop and Mesh identities must differ")
    return pin



def validate_historical_checkpoint(request):
    if "historical_preclaim" not in request:
        return None
    require(request.get("schema") in ("fullmag.saved-authoring-restart.v1", SCHEMA),
            "historical proof requires saved-authoring checkpoint")
    current = validate_checkpoint(request)
    historical = request["historical_preclaim"]
    require(isinstance(historical, dict) and set(historical) == {"session", "archive", "cancelled_preclaim"},
            "historical binding fields differ")
    session = historical["session"]
    require(isinstance(session, dict) and set(session) == {
        "api_instance_id", "session_id", "session_epoch", "request_scope_epoch", "source_kind"},
        "historical session fields differ")
    require(all(isinstance(v, str) and v and len(v) < 4096 for v in session.values()),
            "historical session identity missing")
    require(session["source_kind"] == "ui_authoring"
            and session["session_epoch"].startswith(session["session_id"] + "@")
            and session["session_epoch"].split("@")[-1].isdigit()
            and session["request_scope_epoch"].startswith(session["api_instance_id"] + ":")
            and session["request_scope_epoch"].split(":")[-1].isdigit(), "invalid historical session epochs")
    require(isinstance(request.get("session"), dict)
            and session["session_id"] != request["session"].get("session_id"),
            "historical session must differ from current session")
    archive = historical["archive"]
    require(isinstance(archive, dict) and set(archive) == {"scene_revision"}
            and type(archive["scene_revision"]) is int and archive["scene_revision"] >= 0,
            "invalid historical scene revision")
    old = validate_checkpoint({"schema": SCHEMA, "cancelled_preclaim": historical["cancelled_preclaim"]})
    require(current is None or current["run_id"] != old["run_id"], "historical run must differ from current run")
    return historical


def expected_run_directories(request):
    current = validate_checkpoint(request)
    historical = validate_historical_checkpoint(request)
    return sorted(pin["run_id"] for pin in (current, historical["cancelled_preclaim"] if historical else None)
                  if pin is not None)


def validate_historical_binding(probe, request):
    historical = validate_historical_checkpoint(request)
    if historical is None:
        require("historical_preclaim_cancelled_snapshot" not in probe, "unexpected historical proof")
        return
    _validate_snapshot(probe.get("historical_preclaim_cancelled_snapshot"), historical["cancelled_preclaim"],
                       expected_run_directories(request))


def _validate_snapshot(snapshot, pin, expected_runs):
    require(isinstance(snapshot, dict) and snapshot.get("writer_locks_held_together") is True
            and snapshot.get("run_id") == pin["run_id"] and snapshot.get("task_id") == pin["task_id"]
            and snapshot.get("host_reservation_count") == 0
            and snapshot.get("run_directories") == expected_runs
            and snapshot.get("run_root_entries") == ["run_catalog.json", "run_intent.json", "task_cancellation_intents"],
            "durable pre-claim proof missing or not empty")
    for name in HASH_FIELDS[:3]:
        require(snapshot.get(name) == pin[name], "durable digest differs: " + name)


def validate_binding(probe, request):
    pin = validate_checkpoint(request)
    if pin is None:
        require("preclaim_cancelled_snapshot" not in probe, "unexpected cancelled proof")
        return
    rows = probe["resources"]
    commands = rows["commands"]["body"]
    stop = "stop_command_id" in pin
    count = 2 if stop else 1
    lifecycle = "cancelled" if stop else "waiting_for_compute"
    require(isinstance(commands.get("commands"), list) and len(commands["commands"]) == count
            and all(isinstance(command, dict) for command in commands["commands"]),
            "exactly the bound commands required")
    mesh_commands = [command for command in commands["commands"] if command.get("command_id") == pin["command_id"]]
    require(len(mesh_commands) == 1, "bound mesh command missing or duplicated")
    command = mesh_commands[0]
    require(command.get("command_id") == pin["command_id"] and command.get("kind") == "mesh_build"
            and command.get("status") == "accepted"
            and command.get("target") == {"kind": "run", "run_id": pin["run_id"]}
            and hashlib.sha256(canonical(command)).hexdigest() == pin["command_sha256"],
            "stale mesh command differs from checkpoint")
    if stop:
        stop_commands = [command for command in commands["commands"]
                         if command.get("command_id") == pin["stop_command_id"]]
        require(len(stop_commands) == 1, "bound Stop command missing or duplicated")
        stop_command = stop_commands[0]
        require(stop_command.get("kind") == "stop" and stop_command.get("status") == "accepted"
                and stop_command.get("target") == {"kind": "run", "run_id": pin["run_id"]}
                and hashlib.sha256(canonical(stop_command)).hexdigest() == pin["stop_command_sha256"],
                "Stop command differs from checkpoint")
    for name in ("pending_count", "accepted_count", "dispatched_count", "running_count",
                 "completed_count", "rejected_count", "failed_count"):
        require(type(commands.get(name)) is int and commands[name] == (count if name == "accepted_count" else 0),
                "other commands exist")
    run = rows["run"]
    require(run["status"] == 200 and run["body"].get("run_id") == pin["run_id"]
            and run["body"].get("session_id") == request["session"]["session_id"]
            and run["body"].get("status") == lifecycle
            and hashlib.sha256(canonical(run["body"])).hexdigest() == pin["live_run_sha256"],
            "stale live run differs")
    for suffix in ("before", "after"):
        status = rows["status_" + suffix]["body"]
        require(isinstance(status.get("run"), dict) and status["run"].get("run_id") == pin["run_id"],
                "status run binding differs")
        require(status.get("lifecycle", {}).get("solver") == lifecycle,
                "live execution lifecycle changed")
        require(all(status.get("resources", {}).get(name) == 0
                    for name in ("artifact_revision", "field_revision", "fields_revision")),
                "published runtime fields/artifacts exist")
    _validate_snapshot(probe.get("preclaim_cancelled_snapshot"), pin, expected_run_directories(request))


# Prepend to the existing image-executed saved-authoring probe. Helpers regular,
# lock, canon and inventory are defined by that probe before this function runs.
PROBE_FUNCTION = r'''
def preclaim_cancelled_snapshots(store, ledger, pin):
 bindings=[]
 if 'cancelled_preclaim' in pin: bindings.append(('preclaim_cancelled_snapshot',pin))
 if 'historical_preclaim' in pin: bindings.append(('historical_preclaim_cancelled_snapshot',pin['historical_preclaim']))
 return _collect_preclaim_snapshots(store,ledger,bindings)

def preclaim_cancelled_snapshot(store, ledger, pin):
 return _collect_preclaim_snapshots(store,ledger,[('single',pin)])['single']

def _collect_preclaim_snapshots(store, ledger, bindings):
 expected_runs=sorted(binding['cancelled_preclaim']['run_id'] for _,binding in bindings)
 if len(set(expected_runs))!=len(expected_runs): raise RuntimeError('duplicate cancelled run binding')
 locks=[]
 try:
  # Validate every pinned run while holding the same ledger -> store lock pair.
  for root in (ledger,store): locks.append(lock(root/'WRITER.lock'))
  return {name:_preclaim_snapshot_locked(store,ledger,binding,expected_runs) for name,binding in bindings}
 finally:
  for fd in reversed(locks): fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)

def _preclaim_snapshot_locked(store, ledger, pin, expected_runs):
 expected=pin['cancelled_preclaim']
 runs=store/'runs'
 names=sorted(p.name for p in runs.iterdir())
 if names != expected_runs: raise RuntimeError('other accepted runs exist')
 run=runs/expected['run_id']
 if run.is_symlink() or not run.is_dir(): raise RuntimeError('unsafe cancelled run directory')
 entries=sorted(p.name for p in run.iterdir())
 if entries != ['run_catalog.json','run_intent.json','task_cancellation_intents']:
  raise RuntimeError('cancelled run has preparation, claim, result or unknown records')
 records={};digests={}
 for name,path in [('run_intent',run/'run_intent.json'),('run_catalog',run/'run_catalog.json'),
                   ('cancellation_intent',run/'task_cancellation_intents'/(expected['task_id']+'.json'))]:
  raw=regular(path);digest=hashlib.sha256(raw).hexdigest()
  if digest!=expected[name+'_sha256']: raise RuntimeError('pinned cancelled record changed: '+name)
  records[name]=json.loads(raw);digests[name+'_sha256']=digest
 if inventory(run/'task_cancellation_intents') != [expected['task_id']+'.json']:
  raise RuntimeError('unexpected cancellation records')
 if inventory(store/'temp') or inventory(store/'recovery'): raise RuntimeError('pending store writes/recovery')
 intent=records['run_intent'];catalog=records['run_catalog'];cancel=records['cancellation_intent']
 if (intent.get('schema_version')!='run_intent.v1' or catalog.get('schema_version')!='run_catalog.v1'
     or cancel.get('schema_version')!='task_cancellation_intent.v1'
     or any(value.get('run_id')!=expected['run_id'] for value in records.values())):
  raise RuntimeError('cancelled document identity/schema differs')
 tasks=catalog.get('tasks')
 if not isinstance(tasks,list) or len(tasks)!=1: raise RuntimeError('exactly one pre-claim task required')
 task=tasks[0]
 if (task.get('task_id')!=expected['task_id'] or task.get('lifecycle')!='cancelled'
     or task.get('artifact_ids')!=[] or any(task.get(key) is not None for key in
     ('attempt_id','ownership_epoch','resource_id','resolved_input_fingerprint','observation',
      'coordinator_watermark','coordinator_genesis'))):
  raise RuntimeError('task is not cancelled before claim')
 old=cancel.get('task',{})
 if (old.get('task_id')!=expected['task_id'] or old.get('lifecycle') not in ('accepted','queued')
     or old.get('input_fingerprint')!=task.get('input_fingerprint')
     or old.get('artifact_ids')!=[] or any(old.get(key) is not None for key in
     ('attempt_id','ownership_epoch','resource_id','resolved_input_fingerprint','observation',
      'coordinator_watermark','coordinator_genesis'))):
  raise RuntimeError('cancellation was not pre-claim or has different input')
 revision=catalog.get('revision');prior=cancel.get('expected_catalog_revision')
 if type(revision) is not int or type(prior) is not int or not 0<prior<revision:
  raise RuntimeError('invalid cancellation catalog revision')
 if 'stop_command_id' in expected:
  stop_scope='\0'.join((expected['stop_command_id'],expected['run_id'],expected['task_id']))
  if cancel.get('cancellation_id')!='cancel-live-'+hashlib.sha256(stop_scope.encode()).hexdigest():
   raise RuntimeError('cancellation does not belong to the bound Stop command')
 semantic={k:cancel.get(k) for k in ('schema_version','cancellation_id','run_id','expected_catalog_revision','task','reason')}
 if not cancel.get('cancellation_id') or cancel.get('request_sha256')!=hashlib.sha256(canon(semantic)).hexdigest():
  raise RuntimeError('invalid cancellation digest')
 specification=intent.get('specification')
 if not isinstance(specification,dict) or intent.get('payload_sha256')!=hashlib.sha256(canon(specification)).hexdigest():
  raise RuntimeError('invalid RunIntent payload digest')
 parameters=specification.get('parameters',{});live=parameters.get('live_workspace',{})
 request_id='live-preparation-'+expected['command_id']
 session=pin['session'];epoch=int(session['request_scope_epoch'].rsplit(':',1)[1])
 if (live.get('api_instance_id')!=session['api_instance_id'] or live.get('session_id')!=session['session_id']
     or live.get('session_epoch')!=epoch or live.get('scene_revision')!=pin['archive']['scene_revision']
     or live.get('command_id')!=request_id or live.get('request_idempotency_key')!=request_id
     or intent.get('idempotency_key')!='live-http-'+hashlib.sha256(request_id.encode()).hexdigest()):
  raise RuntimeError('RunIntent belongs to another live command/session')
 source=live.get('startup_source_sha256');command=live.get('command')
 if (not isinstance(source,str) or len(source)!=64 or any(c not in '0123456789abcdef' for c in source)
     or command!={'kind':'startup_script','request_id':request_id,'source_sha256':source}):
  raise RuntimeError('preparation source binding differs')
 if parameters.get('fullmag.accepted_run_start')!={'schema_version':'accepted_run_start_policy.v1','mode':'manual'}:
  raise RuntimeError('accepted start policy is not manual')
 resources=json.loads(regular(ledger/'HOST_RESOURCE_LEDGER.json'))
 if resources.get('schema_version')!='host_resource_ledger.v4' or resources.get('reservations')!=[]:
  raise RuntimeError('host ledger has reservations')
 return dict(writer_locks_held_together=True,run_id=expected['run_id'],task_id=expected['task_id'],
             host_reservation_count=0,run_directories=names,run_root_entries=entries,**digests)
'''
