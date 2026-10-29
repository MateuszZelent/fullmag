"""Private terminal observation input producer.

Pure proof construction is separate from explicit technical CAS publication.
Rust owns Study loading, canonical terminal fences and memory installation.
No run, Start, admission, lease, native exit or solver action is issued here.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Callable, Mapping

PROOF_SCHEMA = "fullmag.development-terminal-observation-proof.v1"
Read = Callable[[str], bytes]


def diagnostic_terminal_stop_probe(control, previous, backend):
    """Read-only admission to an explicit stop, never restart or recovery.

    A target API may install Completed correctly while an older Python
    receipt reader rejects it. Its native owner can still be Ready and idle.
    Authenticate that exact case instead of treating API health as proof that
    the native service is dead. The caller must still obtain a real drain.
    """
    from docker_build_control import BuildControlError, docker_capture
    from docker_volume_preowner_drained import _released, _run_pins
    metadata = previous.get("terminal_observation")
    if (previous.get("state") != "failed-confirmed" or not isinstance(metadata, Mapping)
            or previous.get("error") != "Runtime admission failed; services retained: terminal observation receipt differs from the real target installation"):
        raise BuildControlError("Diagnostic stop requires the exact terminal-installation admission failure")
    proof_sha = metadata.get("proof_sha256")
    digest(proof_sha)
    script = r'''import hashlib,json,os,pathlib,sys,urllib.request
sys.path.insert(0,'/opt/fullmag')
import runtime_service as service
paths=service.canonical_paths()
sha=lambda raw:hashlib.sha256(raw).hexdigest()
def read(path,label,maximum=1048576): return service._bounded_regular(path,label,maximum)
def obj(path,label,maximum=1048576): return service._accepted_reattach_json(read(path,label,maximum),label)
def require(value,message):
 if not value: raise RuntimeError(message)
environment,observation=service._terminal_observation_documents(paths)
require(isinstance(observation,dict) and observation['proof_sha256']==sys.argv[1],'source observation differs')
proof=observation['proof']
process_path=service.process_receipt_path(paths)
process_raw=read(process_path,'diagnostic process')
process=service._accepted_reattach_json(process_raw,'diagnostic process')
cause='terminal observation receipt differs from the real target installation'
require(process.get('schema')=='fullmag.docker-process-tree.v1'
 and process.get('state')=='failed_outcome_retained' and process.get('error')==cause
 and process.get('api_diagnostic_only') is True and 'terminal_service_owner' not in process,
 'not the exact retained terminal-observation failure')
owner=process.get('service_owner',{})
service._validate_terminal_owner(owner,state='ready',name='diagnostic ready owner')
native=service._service_status(paths)
fingerprint=service._owner_fingerprint(owner)
require(service._owner_fingerprint(native)==fingerprint,'native owner changed or is not ready')
fence_path=process.get('api_failure_fence','')
require(isinstance(fence_path,str) and pathlib.Path(fence_path).parent==process_path.parent
 and pathlib.Path(fence_path).name.startswith('api-failure-'),'failure fence path differs')
fence_raw=read(fence_path,'diagnostic API fence')
fence=service._accepted_reattach_json(fence_raw,'diagnostic API fence')
api_id=fence.get('api_instance_id')
service._accepted_reattach_api_id(api_id,'diagnostic API')
require(fence.get('schema')=='fullmag.api-runtime-failure-fence.v1'
 and fence.get('stage')=='runtime_supervision' and fence.get('reason')==cause
 and fence.get('api_pid')==process.get('api_pid'),'failure fence identity differs')
def get(path):
 request=urllib.request.Request('http://127.0.0.1:8081'+path,headers={'Host':'localhost'})
 with urllib.request.urlopen(request,timeout=5) as response:
  raw=response.read(1048577)
  require(response.status==200 and len(raw)<=1048576
   and response.headers.get_all('x-fullmag-api-instance')==[api_id],'API identity differs')
  return service._accepted_reattach_json(raw,'diagnostic response')
health=get('/v2/platform/health'); status=get('/v2/sessions/current/status')
require(health.get('status')=='degraded' and health.get('active_session') is True
 and status.get('session',{}).get('session_id')==proof['session_id']
 and status.get('run',{}).get('run_id')==proof['run_id']
 and status.get('solver',{}).get('state')=='completed','retained session is not completed')
parent=pathlib.PurePosixPath(observation['proof_relative']).parent
installed_path=service._reattach_relative(paths.state_root,str(parent/('installed-'+api_id+'.json')),'installed observation')
installed_raw=read(installed_path,'installed observation')
installed=service._accepted_reattach_json(installed_raw,'installed observation')
launch_sha=installed.get('launch_sha256')
require(isinstance(launch_sha,str) and service.HEX64.fullmatch(launch_sha),'launch digest differs')
launch_path=service._reattach_relative(paths.state_root,str(parent/('launch-'+launch_sha+'.json')),'launch observation')
launch_raw=read(launch_path,'launch observation'); launch=service._accepted_reattach_json(launch_raw,'launch observation')
require(sha(launch_raw)==launch_sha and launch.get('source_proof_sha256')==sys.argv[1]
 and launch.get('source_native_config_sha256')==proof['native_config_sha256']
 and launch.get('terminal_evidence_sha256')==proof['terminal_evidence_sha256'],'launch/source binding differs')
expected={'schema':'fullmag.terminal-observation-restored.v1','api_instance_id':api_id,
 'run_id':proof['run_id'],'session_id':proof['session_id'],'session_epoch':proof['session_epoch'],
 'scene_revision':proof['scene_revision'],'terminal_outcome':'completed','proof_sha256':sys.argv[1],
 'launch_sha256':launch_sha,'source_image_id':proof['image_id'],'source_config_sha256':proof['config_sha256'],
 'target_build_id':launch['target_build_id'],'target_source_sha256':launch['target_source_sha256'],
 'target_image_id':launch['target_image_id'],'native_config_sha256':launch['native_config_sha256'],
 'terminal_evidence_sha256':proof['terminal_evidence_sha256']}
require(installed==expected,'native installed observation differs')
config_raw=read(paths.config,'native config'); config_sha=sha(config_raw)
require(config_sha==launch['native_config_sha256'],'native config changed')
evidence=service._run_cli(paths,['runtime','service-inspect-terminal-run','--config',str(paths.config),
 '--config-sha256',config_sha,'--run-id',proof['run_id']],timeout=30)
require(evidence=={'schema_version':'runtime_service_terminal_run_evidence.v1','run_id':proof['run_id'],
 'terminal_evidence_sha256':proof['terminal_evidence_sha256'],'mutations_applied':False,'solve_replayed':False},
 'native terminal evidence differs')
catalogs={}
runs=paths.store/'runs'
require(not runs.is_symlink() and runs.is_dir(),'run inventory is unsafe')
for run in runs.iterdir():
 require(len(catalogs)<128 and not run.is_symlink() and run.is_dir(),'run inventory exceeds its bound')
 raw=read(run/'run_catalog.json','terminal catalog',8*1048576)
 catalog=service._accepted_reattach_json(raw,'terminal catalog')
 tasks=catalog.get('tasks')
 require(isinstance(tasks,list) and tasks and all(isinstance(task,dict)
  and task.get('lifecycle') in {'succeeded','failed','cancelled','interrupted'} for task in tasks),
  'run inventory contains a nonterminal task; stop refused')
 catalogs[run.name]=sha(raw)
require(catalogs.get(proof['run_id'])==proof['catalog_sha256'],'source catalog changed')
def proc(pid):
 root=pathlib.Path('/proc')/str(pid)
 tail=(root/'stat').read_text().rsplit(') ',1)[1].split()
 return {'pid':pid,'ppid':int(tail[1]),'start':int(tail[19]),'exe':os.readlink(root/'exe'),
  'argv':[x.decode() for x in (root/'cmdline').read_bytes().split(bytes([0])) if x]}
rows=[]
for path in pathlib.Path('/proc').iterdir():
 if path.name.isdigit():
  try: rows.append(proc(int(path.name)))
  except FileNotFoundError: pass
 require(len(rows)<=32,'process inventory exceeds its bound')
api=proc(process['api_pid']); entry=proc(api['ppid'])
require(entry['ppid']==1 and entry['argv']==['/usr/local/bin/python3','/opt/fullmag/entrypoint.py']
 and api['exe'].endswith('/fullmag-api'),'API/entrypoint ancestry differs')
health_processes=[row for row in rows if row['ppid']==0
 and row['argv']==['/usr/local/bin/python3','/opt/fullmag/healthcheck.py']]
allowed={1,entry['pid'],api['pid'],owner['pid'],os.getpid(),*(child['pid'] for child in owner['children'])}
require(len(health_processes)<=1 and {row['pid'] for row in rows}==allowed|{row['pid'] for row in health_processes},
 'a worker or unknown process is present; stop refused')
stable=sorted((row['pid'],row['ppid'],row['start'],row['exe']) for row in rows
 if row['pid']!=os.getpid() and row not in health_processes)
require(read(process_path,'diagnostic process')==process_raw
 and read(fence_path,'diagnostic API fence')==fence_raw
 and service._owner_fingerprint(service._service_status(paths))==fingerprint,'diagnostic state changed')
print(json.dumps({'schema':'fullmag.terminal-diagnostic-stop-preflight.v1',
 'proof_sha256':sys.argv[1],'run_id':proof['run_id'],'session_id':proof['session_id'],
 'api_instance_id':api_id,'process_sha256':sha(process_raw),'fence_sha256':sha(fence_raw),
 'installed_sha256':sha(installed_raw),'native_config_sha256':config_sha,
 'owner_sha256':sha(fingerprint.encode()),'terminal_evidence_sha256':proof['terminal_evidence_sha256'],
 'terminal_catalogs':catalogs,
 'process_inventory_sha256':sha(json.dumps(stable,separators=(',',':')).encode()),
 'health':{'status':'degraded','active_session':True},'mutations_applied':False,'solve_replayed':False},sort_keys=True))
'''
    result = docker_capture("exec", backend["Id"], "python3", "-I", "-B", "-c", script, proof_sha, timeout=90)
    if len(result.stdout) > 64 * 1024:
        raise BuildControlError("Diagnostic terminal stop probe exceeds its bound")
    probe = decode(result.stdout)
    if (probe.get("schema") != "fullmag.terminal-diagnostic-stop-preflight.v1"
            or probe.get("proof_sha256") != proof_sha
            or probe.get("mutations_applied") is not False or probe.get("solve_replayed") is not False):
        raise BuildControlError("Diagnostic terminal stop probe differs")
    return {**probe, "released": _released(control, backend), "run_pins": _run_pins(control, backend)}


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def require(condition: object, message: str) -> None:
    if not condition:
        raise ValueError(message)


def digest(value: object) -> str:
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value),
            "invalid digest")
    return value


def portable(value: object) -> str:
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", value),
            "invalid portable identity")
    return value


def decode(raw: bytes) -> dict:
    require(isinstance(raw, bytes) and 0 < len(raw) <= 8 * 1024 * 1024,
            "record is not bounded bytes")

    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, "duplicate JSON field")
            value[key] = item
        return value

    result = json.loads(raw, object_pairs_hook=unique,
                        parse_constant=lambda _: require(False, "non-finite JSON"))
    require(isinstance(result, dict), "record is not an object")
    return result


def managed(read: Read, relative: str) -> tuple[bytes, dict]:
    raw = read(relative)
    value = decode(raw)
    require(raw == canonical(value) + b"\n", "managed record is not canonical JSON plus LF")
    return raw, value


def owner_identity(owner: Mapping) -> dict:
    fields = ("owner_token", "process_start_token", "pid", "host", "target_id",
              "protocol", "build_commit", "build_snapshot", "control_address",
              "compute_pool_generation", "preparation_pool_generation",
              "compute_pool_id", "preparation_pool_id")
    require(all(owner.get(key) is not None for key in fields), "owner identity is incomplete")
    children = owner.get("children")
    require(isinstance(children, list) and len(children) == 2, "native child set is incomplete")
    require({child.get("role") for child in children} == {"compute", "preparation"},
            "native child roles differ")
    return {**{key: owner[key] for key in fields},
            "children": sorted((child["role"], child["pid"]) for child in children)}


def build_proof(read_control: Read, read_store: Read, *, iteration: str,
                run_id: str, scope: Mapping[str, str], native_config_sha256: str,
                terminal_evidence_sha256: str) -> dict:
    """Pure assembly only; readers must provide bounded, no-symlink bytes.

    Both native pins must come from the canonical native terminal inspection,
    never from this Python catalog parser. Rust revalidates them under its
    host-before-store fence; a config rotation invalidates the launch request.
    """
    digest(native_config_sha256)
    digest(terminal_evidence_sha256)
    require(isinstance(iteration, str) and re.fullmatch("[0-9a-f]{32}", iteration),
            "invalid original iteration")
    portable(run_id)
    require(set(scope) == {"compose_project", "control_volume", "source_root", "image_id"},
            "explicit Docker scope fields differ")
    base = f"iteration/attempts/{iteration}/"
    operation_raw, operation = managed(read_control, base + "terminal.json")
    require(read_control(base + "receipt.json") == operation_raw, "operation is not terminal")
    require(operation.get("schema") == "fullmag.docker-build-operation.v1"
            and operation.get("phase") == "iteration" and operation.get("state") == "succeeded"
            and operation.get("attempt") == iteration, "original iteration did not succeed")
    for key in ("compose_project", "control_volume"):
        require(operation.get(key) == scope[key], "operation belongs to another scope")
    inputs = operation.get("inputs", {})
    require(inputs.get("source_root") == scope["source_root"]
            and inputs.get("image_id") == scope["image_id"], "source/image scope differs")
    config_sha = digest(operation.get("config_sha256"))
    require(inputs.get("config_sha256") == config_sha, "configuration input differs")
    preflight_raw, preflight = managed(read_control, base + "terminal-session-preflight.json")
    require(sha(canonical(preflight)) == operation.get("terminal_session_preflight_sha256"),
            "terminal preflight canonical CAS differs")
    require(preflight.get("schema") == "fullmag.docker-terminal-session-drain-preflight.v1",
            "preflight is not a terminal session observation")
    public_run = preflight.get("run", {})
    public_status = public_run.get("status")
    require(public_run.get("run_id") == run_id and public_status in ("failed", "completed"),
            "preflight is not this Failed or Completed run")
    session_id = portable(preflight.get("session_id"))
    require(public_run.get("session_id") == session_id, "public session binding differs")
    started_at = public_run.get("started_at")
    require(isinstance(started_at, str) and started_at.isdigit() and int(started_at) > 0
            and preflight.get("session_epoch") == f"{session_id}@{started_at}",
            "public session timestamp/epoch binding differs")
    queue = preflight.get("compute_queue", {})
    require(queue.get("schema_version") == "compute_queue.v1"
            and queue.get("next_cursor") is None and isinstance(queue.get("items"), list),
            "historical queue is unavailable or paginated")
    held = preflight.get("held_run_intent_sha256", {})
    require(isinstance(held, dict), "held queue pins are invalid")
    queued = set()
    for item in queue["items"]:
        require(isinstance(item, dict) and item.get("state") == "accepted",
                "historical queue had a runnable task")
        held_id = portable(item.get("run_id"))
        queued.add(held_id)
        require(sha(read_store(f"runs/{held_id}/run_intent.json")) == digest(held.get(held_id)),
                "historical held intent changed")
    require(set(held) == queued, "held queue identity set differs")
    runtime = preflight.get("runtime_service", {})
    require(runtime.get("schema_version") == "application_service_status.v1"
            and runtime.get("configured") is True and runtime.get("state") == "ready",
            "historical runtime was not Ready")

    drain_raw, drain = managed(read_control, base + "backend-drain.json")
    require(drain.get("schema") == "fullmag.docker-idle-restart-drain.v1"
            and drain.get("backend_container_id") == operation.get("backend_container"),
            "native drain belongs to another backend")
    process = drain.get("process_receipt", {})
    require(set(process) == {"schema", "state", "api_pid", "api_exit_code", "accepted_store",
                            "bootstrap", "qualification", "service_owner", "terminal_service_owner"},
            "native process receipt is partial or unsupported")
    require(process.get("schema") == "fullmag.docker-process-tree.v1"
            and process.get("state") == "drained"
            and process.get("accepted_store") == "/state/runs/docker-all/session-store"
            and type(process.get("api_exit_code")) is int, "native drain is not confirmed")
    require(sha(canonical(process) + b"\n") == drain.get("process_receipt_sha256"),
            "native process receipt canonical+LF CAS differs")
    ready, terminal = process.get("service_owner", {}), process.get("terminal_service_owner", {})
    require(ready.get("state") == "ready" and terminal.get("state") == "drained"
            and owner_identity(ready) == owner_identity(terminal), "native owner continuity differs")
    require(all(child.get("status") == "running" for child in ready["children"])
            and all(child.get("status") == "exited_success" for child in terminal["children"]),
            "native drain children are not terminal")
    # The token is used only as an internal locator and is never emitted.
    token = portable(ready.get("owner_token"))
    ready_raw = read_control(f"runtime-control/runtime-services/docker-client-{token}.json")
    archived = decode(ready_raw)
    require(archived.get("state") == "ready" and owner_identity(archived) == owner_identity(ready),
            "immutable Ready owner differs")

    relative = f"runs/{run_id}/"
    intent_raw = read_store(relative + "run_intent.json")
    intent = decode(intent_raw)
    require(intent.get("schema_version") == "run_intent.v1" and intent.get("run_id") == run_id,
            "accepted intent identity differs")
    spec = intent.get("specification", {})
    require(spec.get("run_id") == run_id, "specification run differs")
    snapshot, live = spec.get("snapshot", {}), spec.get("parameters", {}).get("live_workspace", {})
    epoch = live.get("session_epoch")
    require(type(epoch) is int and epoch > 0
            and live.get("session_id") == session_id
            and live.get("api_instance_id") == preflight.get("api_instance_id")
            and preflight.get("request_scope_epoch") == f"{live['api_instance_id']}:{epoch}",
            "accepted live identity differs")
    scene_revision = live.get("scene_revision")
    require(type(scene_revision) is int and scene_revision >= 0
            and snapshot.get("definition_revision") == scene_revision,
            "accepted scene revision differs")
    source_id = portable(live.get("request_idempotency_key"))
    source_sha = digest(live.get("startup_source_sha256"))
    command = live.get("command", {})
    require(live.get("command_id") == source_id and command == {
        "kind": "startup_script", "request_id": source_id, "source_sha256": source_sha},
        "immutable startup command binding differs")
    catalog_raw = read_store(relative + "run_catalog.json")
    catalog = decode(catalog_raw)
    tasks = catalog.get("tasks")
    require(catalog.get("schema_version") == "run_catalog.v1" and catalog.get("run_id") == run_id
            and type(catalog.get("revision")) is int and catalog["revision"] > 0
            and isinstance(tasks, list) and tasks, "native catalog is incomplete")
    require(all(isinstance(task, dict) and task.get("lifecycle") in {
                    "succeeded", "failed", "cancelled", "interrupted"}
                for task in tasks), "native catalog is not terminal")
    all_succeeded = all(task.get("lifecycle") == "succeeded" for task in tasks)
    any_failed = any(task.get("lifecycle") == "failed" for task in tasks)
    catalog_outcome = "completed" if all_succeeded else "failed" if any_failed else None
    require(catalog_outcome == public_status,
            "public run status differs from the terminal catalog outcome")
    release_raw = read_store(relative + "start_release.json")
    release = decode(release_raw)
    require(release.get("schema_version") == "accepted_run_start_release.v1"
            and release.get("run_id") == run_id
            and release.get("specification_sha256") == intent.get("payload_sha256"),
            "native Start release differs")
    return {
        "schema": PROOF_SCHEMA, "original_iteration": iteration,
        "operation_sha256": sha(operation_raw), "preflight_raw_sha256": sha(preflight_raw),
        "drain_sha256": sha(drain_raw), "ready_owner_sha256": sha(ready_raw),
        **scope, "config_sha256": config_sha,
        "run_id": run_id, "project_id": portable(snapshot.get("project_id")),
        "session_id": session_id, "session_epoch": epoch, "scene_revision": scene_revision,
        "definition_sha256": digest(snapshot.get("definition_sha256")),
        "intent_sha256": sha(intent_raw), "specification_sha256": digest(intent.get("payload_sha256")),
        "catalog_sha256": sha(catalog_raw), "catalog_revision": catalog["revision"],
        "native_config_sha256": native_config_sha256,
        "terminal_evidence_sha256": terminal_evidence_sha256,
        "start_release_sha256": sha(release_raw),
        "source_request_id": source_id, "source_sha256": source_sha,
    }


# This context selects observation only. Native admission/recovery stays with
# docker_volume_dev and the native terminal evidence fence.
REQUEST_ENV = "FULLMAG_TERMINAL_OBSERVATION_REQUEST"
REQUEST_SHA_ENV = "FULLMAG_TERMINAL_OBSERVATION_REQUEST_SHA256"
CONTEXT_SCHEMA = "fullmag.terminal-observation-context.v1"


def validate_context(context):
    if context is None:
        return None
    if not isinstance(context, dict) or set(context) != {"environment", "metadata"}:
        raise ValueError("terminal observation context shape differs")
    env, meta = context["environment"], context["metadata"]
    if not isinstance(meta, dict) or set(meta) != {"schema", "proof_sha256", "request_sha256", "stop_attempt", "stop_sha256"}:
        raise ValueError("terminal observation metadata shape differs")
    if meta["schema"] != CONTEXT_SCHEMA:
        raise ValueError("terminal observation metadata schema differs")
    for key in ("proof_sha256", "request_sha256", "stop_sha256"):
        if not isinstance(meta[key], str) or re.fullmatch(r"[0-9a-f]{64}", meta[key]) is None:
            raise ValueError("terminal observation metadata digest differs")
    if re.fullmatch(r"[0-9a-f]{32}", str(meta["stop_attempt"])) is None:
        raise ValueError("terminal observation stop identity differs")
    relative = "terminal-observation/" + meta["proof_sha256"] + "/request.json"
    if env != {REQUEST_ENV: relative, REQUEST_SHA_ENV: meta["request_sha256"]}:
        raise ValueError("terminal observation environment differs")
    return {"environment": dict(env), "metadata": dict(meta)}


def _validate_diagnostic_stop(read_control, root, current, health, actual, proof):
    """Bind a later genuine drain to the original observation; keep both IDs."""
    require(isinstance(proof, dict) and health.get("status") == "degraded"
            and health.get("active_session") is True, "diagnostic stop has no source observation")
    require(proof.get("compose_project") == current.get("compose_project")
            and proof.get("control_volume") == current.get("control_volume")
            and proof.get("source_root") == current.get("inputs", {}).get("source_root"),
            "diagnostic source observation belongs to another group")
    probe_raw, probe = managed(read_control, root + "diagnostic-terminal-preflight.json")
    require(sha(canonical(probe)) == current.get("diagnostic_terminal_stop_sha256")
            and probe.get("schema") == "fullmag.terminal-diagnostic-stop-preflight.v1"
            and probe.get("proof_sha256") == sha(canonical(proof) + b"\n")
            and probe.get("run_id") == proof.get("run_id")
            and probe.get("session_id") == proof.get("session_id")
            and probe.get("terminal_evidence_sha256") == proof.get("terminal_evidence_sha256")
            and probe.get("mutations_applied") is False and probe.get("solve_replayed") is False
            and probe.get("released", {}).get("active_count") == 0,
            "diagnostic stop preflight differs from its source proof")
    require(current.get("native_drain_authenticated") is True and current.get("backend_exit_code") == 1,
            "diagnostic stop has no authenticated native drain")
    for role in ("backend", "frontend"):
        state = actual[role].get("State", {})
        require(state.get("Status") == "exited" and state.get("Running") is False
                and state.get("Pid") == 0 and state.get("OOMKilled") is False
                and state.get("ExitCode") == (1 if role == "backend" else 0),
                "diagnostic stop Docker exit differs")
    api_id = portable(probe.get("api_instance_id"))
    require(re.fullmatch(r"[0-9a-f-]{36}", api_id), "diagnostic API instance is invalid")
    private = "runtime-control/terminal-observation/" + probe["proof_sha256"] + "/"
    installed_raw = read_control(private + "installed-" + api_id + ".json")
    installed = decode(installed_raw)
    require(sha(installed_raw) == probe.get("installed_sha256")
            and installed.get("schema") == "fullmag.terminal-observation-restored.v1"
            and installed.get("api_instance_id") == api_id
            and installed.get("proof_sha256") == probe["proof_sha256"]
            and installed.get("terminal_outcome") == "completed"
            and installed.get("run_id") == proof["run_id"]
            and installed.get("session_id") == proof["session_id"]
            and installed.get("target_image_id") == actual["backend"].get("Image"),
            "diagnostic installed observation changed")
    require(sha(read_control("runtime-control/runtime-service/docker-all.json"))
            == probe.get("native_config_sha256") == installed.get("native_config_sha256"),
            "diagnostic native configuration changed")
    before_raw = read_control(root + "diagnostic-terminal-process-before.json")
    before = decode(before_raw)
    require(sha(before_raw) == probe.get("process_sha256")
            and before.get("state") == "failed_outcome_retained"
            and before.get("api_diagnostic_only") is True
            and before.get("error") == "terminal observation receipt differs from the real target installation",
            "diagnostic process archive changed")
    drain_raw, drain = managed(read_control, root + "backend-drain.json")
    process = drain.get("process_receipt", {})
    current_process_raw = read_control("runtime-control/runtime-service/process-tree.json")
    require(current_process_raw == canonical(process) + b"\n"
            and sha(current_process_raw) == drain.get("process_receipt_sha256")
            and process.get("state") == "drained"
            and process.get("service_owner") == before.get("service_owner")
            and process.get("api_pid") == before.get("api_pid")
            and process.get("error") == before.get("error"), "diagnostic native drain changed")
    ready, terminal = process.get("service_owner", {}), process.get("terminal_service_owner", {})
    persisted = decode(read_control("runtime-control/runtime-services/OWNER.json"))
    from docker_volume_drained_successor import _validate_native_owners
    native = _validate_native_owners(ready, persisted)
    native._validate_terminal_owner(terminal, state="drained", name="diagnostic terminal owner")
    require(native._owner_fingerprint(terminal) == native._owner_fingerprint(persisted)
            and sha(native._owner_fingerprint(ready).encode()) == probe.get("owner_sha256")
            and ready.get("build_commit") == installed.get("target_build_id")
            and ready.get("build_snapshot") == installed.get("target_source_sha256"),
            "diagnostic native owner continuity changed")
    pin = decode(read_control("runtime-control/runtime-services/docker-client-" + portable(ready["owner_token"]) + ".json"))
    require(native._owner_fingerprint(pin) == native._owner_fingerprint(ready), "diagnostic Ready pin changed")
    fence_path = before.get("api_failure_fence", "")
    require(isinstance(fence_path, str) and re.fullmatch(
        r"/opt/fullmag/runtime-control/runtime-service/api-failure-[0-9a-f]{32}[.]json", fence_path),
        "diagnostic fence path differs")
    require(sha(read_control(fence_path.removeprefix("/opt/fullmag/"))) == probe.get("fence_sha256"),
            "diagnostic failure fence changed")
    return probe


def validate_empty_stop(read_control, *, project, volume, source_root, attempt, config_sha256, actual,
                        stop_pin=None, source_proof=None):
    if stop_pin is None:
        current_raw = read_control("iteration/current.json")
    else:
        token, expected_sha = stop_pin
        if (re.fullmatch(r"[0-9a-f]{32}", str(token)) is None
                or re.fullmatch(r"[0-9a-f]{64}", str(expected_sha)) is None):
            raise ValueError("terminal observation pinned idle stop is invalid")
        current_raw = read_control("iteration/attempts/" + token + "/terminal.json")
        if hashlib.sha256(current_raw).hexdigest() != expected_sha:
            raise ValueError("terminal observation pinned idle stop CAS changed")
    current = decode(current_raw)
    token = current.get("attempt")
    if re.fullmatch(r"[0-9a-f]{32}", str(token)) is None:
        raise ValueError("terminal observation idle stop identity is invalid")
    root = "iteration/attempts/" + token + "/"
    if (read_control(root + "terminal.json") != current_raw
            or read_control(root + "receipt.json") != current_raw):
        raise ValueError("terminal observation idle stop archive differs")
    if (current.get("schema") != "fullmag.docker-build-operation.v1"
            or current.get("phase") != "iteration"
            or current.get("state") != "succeeded"
            or current.get("idle_backend_stopped") is not True
            or current.get("compose_project") != project
            or current.get("control_volume") != volume
            or current.get("inputs", {}).get("source_root") != source_root
            or current.get("inputs", {}).get("attempt") != attempt
            or current.get("config_sha256") != config_sha256):
        raise ValueError("terminal observation requires the exact managed empty idle stop")
    health = decode(read_control(root + "idle-preflight.json"))
    diagnostic = current.get("diagnostic_terminal_stop_sha256") is not None
    if diagnostic:
        _validate_diagnostic_stop(read_control, root, current, health, actual, source_proof)
    elif health.get("status") != "ok":
        raise ValueError("terminal observation idle stop health is unavailable")
    nonempty_source_bound = False
    if diagnostic:
        # This stop has its own authenticated owner/drain. It is not the
        # historical source stop and cannot replace that proof's bytes.
        pass
    elif health.get("active_session") is False:
        # Preserve the original empty-stop observation path.
        pass
    elif health.get("active_session") is True and isinstance(source_proof, dict):
        proof_iteration = source_proof.get("original_iteration")
        if (not isinstance(proof_iteration, str)
                or re.fullmatch(r"[0-9a-f]{32}", proof_iteration) is None
                or token != proof_iteration
                or sha(current_raw) != source_proof.get("operation_sha256")):
            raise ValueError("terminal observation stop differs from its original iteration proof")
        if (source_proof.get("compose_project") != project
                or source_proof.get("control_volume") != volume
                or source_proof.get("source_root") != source_root
                or current.get("inputs", {}).get("image_id") != source_proof.get("image_id")
                or source_proof.get("config_sha256") != config_sha256
                or current.get("inputs", {}).get("source_root") != source_root
                or current.get("inputs", {}).get("config_sha256") != config_sha256):
            raise ValueError("terminal observation stop scope differs from its source proof")
        preflight_raw, preflight = managed(
            read_control, root + "terminal-session-preflight.json")
        if (sha(preflight_raw) != source_proof.get("preflight_raw_sha256")
                or sha(canonical(preflight)) != current.get("terminal_session_preflight_sha256")):
            raise ValueError("terminal observation stop preflight differs from its source proof")
        public_run = preflight.get("run", {})
        if (preflight.get("session_id") != source_proof.get("session_id")
                or public_run.get("run_id") != source_proof.get("run_id")
                or public_run.get("session_id") != source_proof.get("session_id")
                or public_run.get("status") not in ("failed", "completed")):
            raise ValueError("terminal observation stop run differs from its source proof")
        # prepare_context rebuilt this proof against its exact catalog. The raw
        # preflight pin above therefore preserves that status/catalog agreement.
        nonempty_source_bound = True
    else:
        raise ValueError("terminal observation idle stop had a nonempty workspace")
    stopped_raw = read_control(root + "idle-stop-containers.json")
    stopped = decode(stopped_raw)
    if (hashlib.sha256(stopped_raw).hexdigest() != current.get("idle_stop_containers_sha256")
            or set(stopped) != {"backend", "frontend"} or set(actual) != set(stopped)):
        raise ValueError("terminal observation stopped services CAS differs")
    for key in stopped:
        old, now = stopped[key], actual[key]
        if (old.get("Id") != now.get("Id") or old.get("Image") != now.get("Image")
                or old.get("Config") != now.get("Config")
                or (diagnostic and old.get("HostConfig") != now.get("HostConfig"))
                or sorted(old.get("Mounts", []), key=canonical)
                != sorted(now.get("Mounts", []), key=canonical)
                or old.get("State", {}).get("StartedAt") != now.get("State", {}).get("StartedAt")
                or old.get("State", {}).get("Running") is not False
                or now.get("State", {}).get("Running") is not False):
            raise ValueError("terminal observation stopped service incarnation differs")
    drain_raw = read_control(root + "backend-drain.json")
    if (nonempty_source_bound
            and sha(drain_raw) != source_proof.get("drain_sha256")):
        raise ValueError("terminal observation native drain differs from its source proof")
    drain = decode(drain_raw)
    process = drain.get("process_receipt", {})
    if (drain.get("schema") != "fullmag.docker-idle-restart-drain.v1"
            or drain.get("backend_container_id") != actual["backend"].get("Id")
            or process.get("state") != "drained"
            or hashlib.sha256(canonical(process) + b"\n").hexdigest() != drain.get("process_receipt_sha256")):
        raise ValueError("terminal observation idle stop native drain differs")
    return token, hashlib.sha256(current_raw).hexdigest()



def _observation_stop(control, read_control, *, source_root, attempt, config_sha256,
                      actual, proof, proof_sha256, stop_pin=None):
    """Keep the original native drain distinct from a later API-only stop."""
    from docker_volume_accepted_reattach import _control_bytes
    backend_id = actual.get("backend", {}).get("Id")
    successor = None
    if isinstance(backend_id, str) and re.fullmatch(r"[0-9a-f]{64}", backend_id):
        journal = "verification/preowner-drained-stop-" + backend_id
        records = [_control_bytes(control, journal + suffix, optional=True, maximum=8 * 1024 * 1024)
                   for suffix in (".json", ".intent.json")]
        if any(raw is not None for raw in records):
            from docker_volume_preowner_drained import retained_context
            parent_root = "development/attempts/" + attempt + "/"
            previous = decode(read_control(parent_root + "terminal.json"))
            document = decode(read_control(parent_root + "compose.json"))
            successor = retained_context(control, previous, document, actual, proof, proof_sha256)
            if successor is None:
                raise ValueError("terminal observation has an unresolved pre-owner successor stop")
    if successor is not None:
        original = (successor["original_stop_attempt"], successor["source_stop_sha256"])
        if stop_pin is not None and original != stop_pin:
            raise ValueError("terminal observation predecessor drain changed")
        return *original, successor
    original = validate_empty_stop(
        read_control, project=control.project, volume=control.volume, source_root=source_root,
        attempt=attempt, config_sha256=config_sha256, actual=actual,
        stop_pin=stop_pin, source_proof=proof)
    stop = decode(read_control("iteration/attempts/" + original[0] + "/terminal.json"))
    if stop.get("diagnostic_terminal_stop_sha256") is not None:
        root = "iteration/attempts/" + original[0] + "/"
        probe = decode(read_control(root + "diagnostic-terminal-preflight.json"))
        from docker_volume_preowner_drained import _released, _run_pins
        require(_released(control, actual["backend"]) == probe.get("released")
                and _run_pins(control, actual["backend"]) == probe.get("run_pins"),
                "diagnostic stopped run catalogs or leases changed")
        return *original, {
            "schema": "fullmag.terminal-diagnostic-drain-context.v1",
            "stop_attempt": original[0], "stop_sha256": original[1],
            "source_proof_sha256": proof_sha256,
            "diagnostic_preflight_sha256": stop["diagnostic_terminal_stop_sha256"],
        }
    return *original, None


def revalidate_context(control, context, *, source_root, attempt, config_sha256, actual):
    """Read-only revalidation under the caller's existing recreate lease."""
    from docker_volume_accepted_reattach import _control_bytes
    context = validate_context(context)
    if context is None:
        raise ValueError("terminal observation context is absent")
    read_control = lambda relative: _control_bytes(control, relative, maximum=8 * 1024 * 1024)
    meta = context["metadata"]
    private = "runtime-control/terminal-observation/" + meta["proof_sha256"]
    proof_raw = read_control(private + "/proof.json")
    request_raw = read_control(private + "/request.json")
    if (hashlib.sha256(proof_raw).hexdigest() != meta["proof_sha256"]
            or hashlib.sha256(request_raw).hexdigest() != meta["request_sha256"]):
        raise ValueError("terminal observation private input CAS changed under recreate lease")
    proof = decode(proof_raw)
    if proof.get("schema") != PROOF_SCHEMA:
        raise ValueError("terminal observation private proof schema differs")
    expected = {"schema": "fullmag.terminal-observation-request.v1",
                "proof_path": "terminal-observation/" + meta["proof_sha256"] + "/proof.json",
                "proof_sha256": meta["proof_sha256"]}
    if decode(request_raw) != expected:
        raise ValueError("terminal observation private request changed under recreate lease")
    _, _, successor = _observation_stop(
        control, read_control, source_root=source_root,
        attempt=attempt, config_sha256=config_sha256, actual=actual,
        stop_pin=(meta["stop_attempt"], meta["stop_sha256"]),
        proof=proof, proof_sha256=meta["proof_sha256"])
    return successor


def prepare_context(control, *, proof_relative, proof_sha256, store_root, source_root,
                    attempt, config_sha256, actual):
    from docker_volume_accepted_reattach import _control_bytes, _read_store_regular
    read_control = lambda relative: _control_bytes(control, relative, maximum=8 * 1024 * 1024)
    if (not isinstance(proof_relative, str) or not proof_relative
            or proof_relative.startswith("/") or "\\" in proof_relative
            or any(part in {"", ".", ".."} for part in proof_relative.split("/"))
            or re.fullmatch(r"[0-9a-f]{64}", str(proof_sha256)) is None):
        raise ValueError("terminal observation source proof reference is invalid")
    raw = read_control(proof_relative)
    if hashlib.sha256(raw).hexdigest() != proof_sha256:
        raise ValueError("terminal observation source proof CAS differs")
    proof = decode(raw)
    scope = {key: proof[key] for key in ("compose_project", "control_volume", "source_root", "image_id")}
    if (scope["compose_project"] != control.project or scope["control_volume"] != control.volume
            or scope["source_root"] != source_root):
        raise ValueError("terminal observation source proof belongs to another workspace")
    rebuilt = build_proof(
        read_control,
        lambda relative: _read_store_regular(store_root, relative, "terminal observation retained record", maximum=8 * 1024 * 1024),
        iteration=proof["original_iteration"], run_id=proof["run_id"], scope=scope,
        native_config_sha256=proof["native_config_sha256"],
        terminal_evidence_sha256=proof["terminal_evidence_sha256"])
    if proof != rebuilt:
        raise ValueError("terminal observation proof differs from authoritative original records")
    stop_attempt, stop_sha256, _ = _observation_stop(
        control, read_control, source_root=source_root, attempt=attempt,
        config_sha256=config_sha256, actual=actual, proof=proof, proof_sha256=proof_sha256)
    private = "terminal-observation/" + proof_sha256
    request = {"schema": "fullmag.terminal-observation-request.v1",
               "proof_path": private + "/proof.json", "proof_sha256": proof_sha256}
    request_raw = canonical(request) + b"\n"
    request_sha = hashlib.sha256(request_raw).hexdigest()
    _publish_private_records(control, [(private + "/proof.json", raw),
                                      (private + "/request.json", request_raw)])
    return validate_context({"environment": {REQUEST_ENV: private + "/request.json", REQUEST_SHA_ENV: request_sha},
                            "metadata": {"schema": CONTEXT_SCHEMA, "proof_sha256": proof_sha256,
                                         "request_sha256": request_sha, "stop_attempt": stop_attempt,
                                         "stop_sha256": stop_sha256}})


def _publish_private_records(control, records):
    # Same managed control helper and operation mutex as other private inputs.
    # No SessionStore or native owner/admission row is written.
    import base64
    from docker_build_control import bounded_capture
    payload = []
    for relative, raw in records:
        payload.append({"path": control.path("runtime-control/" + relative),
                        "sha256": hashlib.sha256(raw).hexdigest(),
                        "base64": base64.b64encode(raw).decode("ascii")})
    script = r'''set -euo pipefail
umask 027
exec 9>/control/operation.lock
flock -n 9 || exit 73
test ! -e /control/active
test ! -L /control/active
publish() {
 path="$1"; expected="$2"; payload="$3"; parent="$(dirname "$path")"
 test ! -L "$parent"; mkdir -p "$parent"
 test "$(readlink -f "$parent")" = "$parent"; test ! -L "$path"
 if test -e "$path"; then
  test -f "$path"; test "$(stat -c %h "$path")" = 1
  test "$(sha256sum "$path" | cut -d' ' -f1)" = "$expected"; return
 fi
 tmp="$(mktemp "$parent/.observation.XXXXXXXX")"
 trap 'rm -f -- "$tmp"' EXIT
 printf '%s' "$payload" | base64 -d > "$tmp"
 test "$(sha256sum "$tmp" | cut -d' ' -f1)" = "$expected"
 sync "$tmp"; mv -T -- "$tmp" "$path"; sync "$parent"
 trap - EXIT
}
'''
    for index, record in enumerate(payload):
        script += 'publish "$OBS_PATH_' + str(index) + '" "$OBS_SHA_' + str(index) + '" "$OBS_DATA_' + str(index) + '"\n'
    script += "printf 'PUBLISHED\\n'\n"
    argv = control.helper_args(script, name="fullmag-control-observation-" + payload[0]["sha256"][:24])
    insertion = argv.index("--entrypoint")
    for index, record in enumerate(payload):
        for field, prefix in (("path", "OBS_PATH_"), ("sha256", "OBS_SHA_"), ("base64", "OBS_DATA_")):
            argv[insertion:insertion] = ["--env", prefix + str(index) + "=" + record[field]]
    result = bounded_capture(argv, data=b"", timeout=180)
    if result.returncode or result.stdout != b"PUBLISHED\n":
        raise ValueError("terminal observation private control publication failed; retained data is unchanged")
