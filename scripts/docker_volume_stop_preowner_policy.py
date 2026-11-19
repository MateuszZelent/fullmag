"""Stop one startup-only diagnostic namespace after a refused group budget.

This does not drain or recover the historical native owner. Both its evidence
and all user data survive. A fresh snapshot/ledger is a separate operation.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import shlex

from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture
from docker_volume_reconcile import fingerprint

SCHEMA = "fullmag.docker-preowner-policy-stop.v1"
REFUSAL = "stored host resource policy differs from explicit ledger configuration"


def require(value, message):
    if not value:
        raise BuildControlError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


# No mutation, dynamic imports, owner takeover or recovery runs in this probe.
PROBE = r'''import hashlib,json,os,pathlib,re,stat,sys,urllib.error,urllib.request,uuid
def read(path,maximum=1048576):
 p=pathlib.Path(path)
 if any(x.is_symlink() for x in (p,*p.parents)): raise RuntimeError('evidence traverses symlink')
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  st=os.fstat(fd)
  if not stat.S_ISREG(st.st_mode) or st.st_size>maximum: raise RuntimeError('unbounded evidence')
  data=os.read(fd,maximum+1)
  if len(data)!=st.st_size: raise RuntimeError('evidence size changed')
  return data
 finally: os.close(fd)
def digest(path):
 a=read(path); b=read(path)
 if a!=b: raise RuntimeError('evidence changed')
 return hashlib.sha256(a).hexdigest()
def process(pid):
 p=pathlib.Path('/proc')/str(pid); parts=(p/'stat').read_text().rsplit(')',1)[1].split()
 return {'pid':pid,'ppid':int(parts[1]),'start_ticks':int(parts[19]),'exe':os.readlink(p/'exe'),
         'argv':[x.decode() for x in (p/'cmdline').read_bytes().split(bytes([0])) if x]}
rows=[]
for p in pathlib.Path('/proc').iterdir():
 if p.name.isdigit():
  try: rows.append(process(int(p.name)))
  except FileNotFoundError: pass
 if len(rows)>64: raise RuntimeError('process inventory exceeds bound')
apis=[p for p in rows if p['exe'].endswith('/fullmag-api')]
sup=[p for p in rows if '/opt/fullmag/entrypoint.py' in p['argv']]
init=[p for p in rows if p['pid']==1]
if (len(apis)!=1 or len(sup)!=1 or len(init)!=1
 or pathlib.Path(init[0]['exe']).name not in {'tini','docker-init'}
 or sup[0]['ppid']!=1 or apis[0]['ppid']!=sup[0]['pid']
 or {p['pid'] for p in rows}!={1,sup[0]['pid'],apis[0]['pid'],os.getpid()}):
 raise RuntimeError('unexpected process in diagnostic namespace')
api=apis[0]
with (pathlib.Path('/proc')/str(api['pid'])/'environ').open('rb') as stream: env=stream.read(1048577)
if len(env)>1048576: raise RuntimeError('API environment exceeds bound')
fences=[x.split(b'=',1)[1].decode() for x in env.split(bytes([0])) if x.startswith(b'FULLMAG_API_RUNTIME_FAILURE_FENCE=')]
if len(fences)!=1 or re.fullmatch('/opt/fullmag/runtime-control/runtime-service/api-failure-[0-9a-f]{32}[.]json',fences[0]) is None:
 raise RuntimeError('API has no canonical private failure fence')
fence=json.loads(read(fences[0]))
if fence.get('schema')!='fullmag.api-runtime-failure-fence.v1' or fence.get('stage')!='runtime_startup':
 raise RuntimeError('API is not startup-only diagnostic')
if any(k in fence for k in ['api_pid','api_instance_id']): raise RuntimeError('post-owner fence is outside this stop mode')
reason=fence.get('reason',''); prefix='native Docker host profile initialization failed: native runtime service failed: Docker host ledger rejected probed_policy='
if not reason.startswith(prefix): raise RuntimeError('startup failure is not a host-policy refusal')
policy,end=json.JSONDecoder().raw_decode(reason[len(prefix):])
if reason[len(prefix)+end:].strip()!=': stored host resource policy differs from explicit ledger configuration':
 raise RuntimeError('host-policy refusal suffix differs')
old=json.loads(read('/host-ledger/ledger/HOST_RESOURCE_LEDGER.json'))['policy']
if (old.get('schema_version')!='host_resource_ledger_policy.v2'
 or {k:v for k,v in old.items() if k not in {'topology_sha256','total_budget'}}!={k:v for k,v in policy.items() if k not in {'topology_sha256','total_budget'}}
 or old['total_budget']['storage_bytes']!=policy['total_budget']['storage_bytes']
 or old['total_budget']['gpu_memory_bytes']!=policy['total_budget']['gpu_memory_bytes']
 or old['total_budget']['cpu_millis']>=policy['total_budget']['cpu_millis']
 or old['total_budget']['memory_bytes']>=policy['total_budget']['memory_bytes']):
 raise RuntimeError('refusal is not a pure CPU/memory budget increase')
owner=json.loads(read('/opt/fullmag/runtime-control/runtime-services/OWNER.json'))
history=json.loads(read('/opt/fullmag/runtime-control/runtime-service/process-tree.json'))
identity_fields=['schema_version','owner_token','process_start_token','pid','host','target_id','control_address',
 'build_commit','build_snapshot','compute_pool_id','preparation_pool_id','compute_pool_generation','preparation_pool_generation']
if (owner.get('schema_version')!='runtime_service_owner.v1' or owner.get('state')!='ready'
 or history.get('schema')!='fullmag.docker-process-tree.v1' or history.get('state')!='ready'
 or any(owner.get(k)!=history.get('service_owner',{}).get(k) for k in identity_fields)):
 raise RuntimeError('historical Ready identity differs')
if len(owner.get('children',[]))!=2 or {p.get('role') for p in owner['children']}!={'compute','preparation'}:
 raise RuntimeError('historical scheduler identity differs')
old_pids=[owner.get('pid')]+[p.get('pid') for p in owner.get('children',[])]
if len(old_pids)!=3 or any(type(p) is not int or p<=0 or pathlib.Path('/proc',str(p)).exists() for p in old_pids):
 raise RuntimeError('historical owner PID is present or ambiguous')
def get(path):
 request=urllib.request.Request('http://127.0.0.1:8081'+path,headers={'Host':'localhost'})
 try:
  with urllib.request.urlopen(request,timeout=3) as r:
   ids=r.headers.get_all('x-fullmag-api-instance') or []; data=r.read(1048577)
   if len(ids)!=1 or len(data)>1048576: raise RuntimeError('HTTP identity/size differs')
   uuid.UUID(ids[0]); return r.status,ids[0],json.loads(data)
 except urllib.error.HTTPError as e:
  ids=e.headers.get_all('x-fullmag-api-instance') or []
  if len(ids)!=1: raise RuntimeError('error response identity missing')
  return e.code,ids[0],json.loads(e.read(65537))
code,instance,health=get('/v2/platform/health')
missing_code,missing_instance,missing=get('/v2/sessions/current/status')
# The cold diagnostic-only middleware blocks current-session reads before
# any restore runs. It deliberately returns its exact 503 rather than 404.
if (code!=200 or health.get('status')!='degraded' or health.get('active_session') is not False
 or missing_code!=503 or missing_instance!=instance or missing.get('code')!='runtime_unavailable'
 or missing.get('message')!='Runtime startup failed; API diagnostics remain available and execution is disabled.'):
 raise RuntimeError('diagnostic API has an active or unknown session')
control={}
for rel in ['runtime-services/OWNER.json','runtime-service/process-tree.json','runtime-service/docker-all.json']:
 control['runtime-control/'+rel]=digest('/opt/fullmag/runtime-control/'+rel)
control[fences[0].replace('/opt/fullmag/runtime-control/','runtime-control/',1)]=digest(fences[0])
for rel in ['isolated-snapshot/start.json','isolated-snapshot/native-validation.json']:
 p=pathlib.Path('/opt/fullmag/control')/rel
 if p.exists(): control[rel]=digest(p)
provenance=json.loads(read('/opt/fullmag/control/backend/runtime-provenance.json'))
if provenance.get('state')!='succeeded' or owner.get('build_snapshot')==provenance.get('source_snapshot_sha256'):
 raise RuntimeError('historical owner is not a different verified build')
control['backend/runtime-provenance.json']=digest('/opt/fullmag/control/backend/runtime-provenance.json')
print(json.dumps({'schema':'fullmag.preowner-policy-stop-probe.v1','api':{k:v for k,v in api.items() if k!='argv'},
 'supervisor':{k:v for k,v in sup[0].items() if k!='argv'},'api_instance_id':instance,'failure_reason':reason,
 'requested_policy':policy,'stored_policy':old,'control_hashes':control,'current_session_present':False},sort_keys=True))
'''

RUN_PINS = r'''import hashlib,json,os,pathlib,stat
root=pathlib.Path('/state/runs/docker-all/session-store/runs'); result={}; total=0
if root.is_symlink() or not root.is_dir(): raise RuntimeError('invalid runs root')
for run in sorted(root.iterdir()):
 if run.is_symlink() or not run.is_dir(): raise RuntimeError('invalid run entry')
 for pattern in ['run_intent.json','run_catalog.json','tasks/*/task_catalog.json']:
  for p in sorted(run.glob(pattern)):
   if any(x.is_symlink() for x in (p,*p.parents)): raise RuntimeError('metadata traverses symlink')
   st=p.stat(); total+=st.st_size
   if len(result)>=8192 or st.st_size>4194304 or total>67108864 or not stat.S_ISREG(st.st_mode): raise RuntimeError('metadata bound exceeded')
   raw=p.read_bytes(); key=str(p.relative_to(root)); result[key]=hashlib.sha256(raw).hexdigest()
print(json.dumps(result,sort_keys=True))
'''


def inspect_one(kind, identity):
    rows = json.loads(docker_capture("inspect", "--type", kind, identity).stdout)
    require(isinstance(rows, list) and len(rows) == 1, "Ambiguous Docker identity")
    return rows[0]


def container_pin(actual):
    return {"id": actual["Id"], "image": actual["Image"],
            "started_at": actual["State"]["StartedAt"], "fingerprint": fingerprint(actual)}


def run_pins(control, actual):
    from docker_volume_capture_failure_reconcile import _mount_arg
    args = control.helper_args("python3 -I -B -c " + shlex.quote(RUN_PINS))
    offset = args.index("--entrypoint")
    args[offset:offset] = ["--mount", _mount_arg(actual, "/state")]
    from docker_build_control import bounded_capture
    result = bounded_capture(args, data=b"", timeout=60, maximum=1024 * 1024)
    require(result.returncode == 0, "Run metadata observation failed: " + result.stderr.decode(errors="replace")[-1000:])
    return json.loads(result.stdout)


def collect(control, args):
    from docker_dev_up import _compose_container_id
    from docker_volume_dev import _validate_retained_service
    from docker_volume_pre_ack_retry import _released_snapshot
    root = "development/attempts/" + args.attempt
    raw = control.read_bytes(root + "/terminal.json")
    terminal = json.loads(raw)
    document = control.read(root + "/compose.json")
    require(control.read_bytes("development/current.json") == raw, "Failed development is no longer current")
    require(terminal.get("schema") == "fullmag.docker-build-operation.v1"
            and terminal.get("phase") == "development" and terminal.get("state") == "failed-confirmed"
            and terminal.get("attempt") == args.attempt and terminal.get("control_namespace") == control.namespace
            and terminal.get("compose_project") == control.project and terminal.get("control_volume") == control.volume
            and terminal.get("inputs", {}).get("source_root") == str(args.source_root)
            and terminal.get("ledger_profile") == "group-ledger-v1", "Failed development authority differs")
    require(terminal.get("config_sha256") == args.config_sha256 == sha(canonical(document)), "Compose digest differs")
    require(document.get("name") == control.project and terminal["inputs"].get("image_id") == args.image_id,
            "Compose project/image differs")
    require(REFUSAL in terminal.get("error", ""), "Terminal is not a policy refusal")
    back_id = _compose_container_id(document, "backend")
    front_id = _compose_container_id(document, "frontend")
    require(back_id == args.backend_container_id, "Backend ID differs")
    backend, frontend = (inspect_one("container", x) for x in (back_id, front_id))
    for role, actual in (("backend", backend), ("frontend", frontend)):
        expected_image = document["services"][role]["image"]
        require(actual["Image"] == expected_image and actual["State"].get("Running") is True
                and actual["State"].get("OOMKilled") is False, "Service is replaced, stopped or OOM-killed")
        image = inspect_one("image", expected_image)
        _validate_retained_service(document, actual, role, image["Config"],
                                   expected_started_at=terminal["backend_started_at"] if role == "backend" else None)
    group = terminal.get("worker_cgroup", {})
    require(group.get("state") == "ready" and group.get("container_id") == back_id
            and group.get("image_id") == args.image_id and group.get("compose_project") == control.project,
            "Missing exact worker-cgroup evidence")
    probe = docker_capture("exec", back_id, "python3", "-I", "-B", "-c", PROBE, timeout=30)
    guest = json.loads(probe.stdout)
    require(terminal["error"].strip() == ("Runtime startup failed; diagnostic API retained: " + guest["failure_reason"]).strip(),
            "Live failure differs from the terminal")
    require(guest["requested_policy"]["total_budget"]["cpu_millis"] == int(document["services"]["backend"]["environment"]["FULLMAG_DOCKER_CPU_MILLIS"])
            and guest["requested_policy"]["total_budget"]["memory_bytes"] == int(document["services"]["backend"]["environment"]["FULLMAG_DOCKER_MEMORY_BYTES"]) - 1024**3,
            "Requested ledger budget differs from this container")
    return {"schema": SCHEMA, "development_attempt": args.attempt, "config_sha256": args.config_sha256,
            "development_terminal_sha256": sha(raw), "backend": container_pin(backend), "frontend": container_pin(frontend),
            "probe_sha256": sha(PROBE.encode()), "controller_sha256": sha(Path(__file__).read_bytes()),
            "guest": guest, "released": _released_snapshot(control, backend), "run_pins": run_pins(control, backend)}, backend, frontend


def stop(args):
    from docker_dev import _compose_identity, _select_source
    from docker_volume_unclaimed_cancellation import _project_container_ids, _volume_consumer_ids
    for value, pattern in ((args.attempt, r"[0-9a-f]{32}"), (args.config_sha256, r"[0-9a-f]{64}"),
                           (args.backend_container_id, r"[0-9a-f]{64}"), (args.image_id, r"sha256:[0-9a-f]{64}")):
        require(re.fullmatch(pattern, value or ""), "Full immutable pins are required")
    require(args.apply == (args.expected_plan_sha256 is not None), "Apply requires its preview plan hash")
    if args.apply:
        require(re.fullmatch(r"[0-9a-f]{64}", args.expected_plan_sha256), "Full preview digest required")
    selected, layout = _select_source(Path(args.repo_root), args.source_root)
    args.source_root = selected
    control = BuildControl(_compose_identity(layout), args.image_id)
    phase = "preowner-policy-stop" if args.apply else "preowner-policy-stop-preview"
    inputs = {"attempt": args.attempt, "config_sha256": args.config_sha256, "source_root": str(selected),
              "backend_container_id": args.backend_container_id, "image_id": args.image_id,
              "controller_sha256": sha(Path(__file__).read_bytes())}
    journal_path = "verification/preowner-policy-stop-" + args.backend_container_id + ".json"
    require(control.read(journal_path, optional=True) is None, "A stop intent already exists; reconcile it without replay")
    with control.operation(phase, inputs) as operation:
        plan, backend, frontend = collect(control, args)
        expected = {backend["Id"], frontend["Id"], operation["helper_container_id"]}
        require(_project_container_ids(control.project) == expected and _volume_consumer_ids(control.volume) == expected,
                "Unexpected project/control consumer")
        plan_sha = sha(canonical(plan))
        control.write(operation["root"] + "/plan.json", plan)
        if not args.apply:
            operation["receipt"].update(state="succeeded", result={"state": "preview-passed", "plan_sha256": plan_sha})
            print(json.dumps({"state": "preview-passed", "plan_sha256": plan_sha, "plan_path": operation["root"] + "/plan.json"}))
            return
        preview = control.read("preowner-policy-stop-preview/verified.json")
        require(preview.get("state") == "succeeded" and preview.get("inputs") == inputs
                and preview.get("result", {}).get("plan_sha256") == args.expected_plan_sha256 == plan_sha,
                "Exact successful preview no longer matches")
        require(control.read("preowner-policy-stop-preview/attempts/" + preview["attempt"] + "/terminal.json") == preview,
                "Preview pointer differs from its immutable terminal")
        fresh, _, _ = collect(control, args)
        require(fresh == plan, "Evidence changed immediately before stop")
        journal = {"schema": SCHEMA, "state": "stop-planned", "plan_sha256": plan_sha, "plan": plan,
                   "operation_root": operation["root"], "native_owner_drained": False}
        control.write(journal_path, journal)
        operation["daemon_pending"] = True
        for original in (backend, frontend):
            docker_capture("stop", "--time", "-1", original["Id"], timeout=45)
            current = inspect_one("container", original["Id"])
            require(container_pin(current) == container_pin(original) and current["State"].get("Running") is False
                    and current["State"].get("Pid") == 0
                    and current["State"].get("ExitCode") in ({0} if original is backend else {0, 143})
                    and current["State"].get("OOMKilled") is False, "Graceful stop is not confirmed")
        from docker_volume_pre_ack_retry import _released_snapshot
        require(_released_snapshot(control, backend) == plan["released"] and run_pins(control, backend) == plan["run_pins"],
                "Preserved ledger/leases/run metadata changed")
        for relative, digest in plan["guest"]["control_hashes"].items():
            require(sha(control.read_bytes(relative)) == digest, "Preserved evidence changed: " + relative)
        journal.update(state="stopped-confirmed", backend_after=container_pin(inspect_one("container", backend["Id"])),
                       frontend_after=container_pin(inspect_one("container", frontend["Id"])), data_preserved=True)
        control.write(journal_path, journal)
        operation["daemon_pending"] = False
        operation["receipt"].update(state="succeeded", result={"state": "stopped-confirmed", "journal_path": journal_path,
                                                               "journal_sha256": sha(canonical(journal) + b"\n"), "native_owner_drained": False})
        print(json.dumps(operation["receipt"]["result"]))
