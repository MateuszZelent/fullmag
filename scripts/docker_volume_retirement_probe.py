"""Read-only evidence for one held, pre-publication retirement.

This probe never finalizes an operation, releases a lease, or stops a service.
Its evidence is not a replacement for an archive or a complete UI checkpoint.
"""
from __future__ import annotations

import hashlib
import argparse
import json
import re

from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture, toolchain_configuration
from docker_dev_browser_qa import _resolve_selected
from docker_volume_activate import _read_control_bytes, _retained_retirement_context, _validate_running_group
from docker_volume_activation_reconcile import _validate_helper
from docker_volume_stop_diagnostic import _validate_resume_terminal


_PROBE = r'''import hashlib,json,os,pathlib,re,stat,sys,urllib.request
sys.path.insert(0,"/opt/fullmag")
import runtime_service as service
import docker_startup_script as startup
expected=json.load(sys.stdin)
MAX=4*1024*1024
def require(condition,message):
    if not condition: raise RuntimeError(message)
def digest(raw): return hashlib.sha256(raw).hexdigest()
def read(path):
    path=pathlib.Path(path)
    for parent in (path,*path.parents):
        require(not parent.is_symlink(),"probe path contains a symlink")
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,"rb") as source:
        require(stat.S_ISREG(os.fstat(source.fileno()).st_mode),"probe record is not regular")
        raw=source.read(MAX+1)
    require(len(raw)<=MAX,"probe record exceeds byte bound")
    return raw
def doc(path):
    raw=read(path)
    return json.loads(raw),digest(raw)
instance=None
def get(path):
    global instance
    headers={"Accept":"application/json"}
    if instance: headers["x-fullmag-api-instance"]=instance
    with urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8081"+path,headers=headers),timeout=10) as response:
        pin=response.headers.get("x-fullmag-api-instance")
        require(response.status==200,"probe GET failed")
        require(isinstance(pin,str) and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}",pin),"API instance is invalid")
        require(instance in (None,pin),"API instance changed")
        instance=pin
        raw=response.read(MAX+1)
        require(len(raw)<=MAX,"API probe exceeds byte bound")
    return json.loads(raw)
paths=service.canonical_paths()
config,config_sha=doc(paths.config)
root=pathlib.Path(config["store_root"])
require(root.is_absolute() and root.resolve()==root and root==paths.store,"native store identity differs")
process,process_sha=doc(service.process_receipt_path(paths))
require(process.get("schema")=="fullmag.docker-process-tree.v1"
    and process.get("state")=="failed_outcome_retained"
    and process.get("api_diagnostic_only") is True
    and process.get("accepted_store")==str(root),"API is not the retained diagnostic process")
fence,fence_sha=doc(process["api_failure_fence"])
require(fence.get("schema")=="fullmag.api-runtime-failure-fence.v1"
    and fence.get("stage")=="runtime_supervision"
    and fence.get("reason")=="API identity probe failed during supervision: API runtime-service liveness contract changed"
    and fence.get("api_pid")==process.get("api_pid"),"failure fence differs from the observed supervision failure")
health=get("/v2/platform/health")
require(health.get("status")=="degraded" and health.get("active_session") is True,"API is not fenced with an active workspace")
require(fence.get("api_instance_id")==instance,"failure fence belongs to another API")
api=get("/v2/platform/openapi.json")
# Rust writable_product_state_path canonicalizes the existing directory and
# joins its empty suffix. PathBuf retains that trailing separator in the
# opaque store binding; pathlib strips it. Match the producer's exact bytes.
binding=hashlib.sha256(b"fullmag.accepted-store-binding.v1\0"+os.fsencode(str(root)+"/")).hexdigest()
require(api.get("x-fullmag-runtime-store-binding")=={
    "schema_version":"runtime_store_binding.v1","kind":"accepted_runs","binding":binding},"API submit store differs from the native store")
before=get("/v2/sessions/current/status")
session=before["session"]
scope=(session["session_id"],session["session_epoch"],session["request_scope_epoch"])
require(scope[0]==expected["session_id"] and scope[2]==expected["api_request_scope_epoch"],"retirement session/API scope changed")
run=before.get("run") or {}
require(run.get("run_id")==expected["run_id"] and before["solver"]["state"]=="failed","current run is not the bound failed task")
# This handler takes the same transition mutex as retirement. The sticky
# failure fence rejects subsequent/queued begin_freeze attempts.
visualization=get("/v2/sessions/current/visualization/state")
operation=expected["operation_id"]
evidence=startup.retirement_receipt_evidence(operation,expected["inputs_sha256"])
require(evidence==expected["retirement"],"image-owned retirement intent changed")
require(evidence["state"]=="pending","retirement already has a different outcome")
require(pathlib.Path(os.environ["FULLMAG_RUNS_ROOT"])/"session-store"==root,"helper archive root differs from API submit store")
archive=startup._retirement_archive_receipt(operation,session_id=scope[0],run_id=run["run_id"],api_request_scope_epoch=scope[2])
require(archive is None,"retirement archive exists; replay is required")
marker=pathlib.Path(expected["bindings"]["activation_receipt_path"])
require(re.fullmatch(r"/opt/fullmag/control/backend/script-activation-[0-9a-f]{64}/activation.json",str(marker)) is not None,"successor marker path is invalid")
require(not marker.exists() and not marker.is_symlink(),"successor activation has a marker")
run_root=root/"runs"/run["run_id"]
intent,intent_sha=doc(run_root/"run_intent.json")
live=intent["specification"]["parameters"]["live_workspace"]
require(intent["run_id"]==run["run_id"] and live["session_id"]==scope[0]
    and live["api_instance_id"]==instance,"durable intent differs from current workspace")
catalog,catalog_sha=doc(run_root/"run_catalog.json")
require(catalog["run_id"]==run["run_id"] and len(catalog["tasks"])==1
    and catalog["tasks"][0]["lifecycle"]=="failed","bound durable task is not terminal failed")
task=catalog["tasks"][0]
leases=list((run_root/"resource_leases").glob("**/*.json"))
require(0<len(leases)<=32,"bound run lease set is missing or too large")
lease_hashes=[]
for path in leases:
    lease,sha=doc(path)
    require(lease["run_id"]==run["run_id"] and lease["task_id"]==task["task_id"]
        and lease["state"]=="released","bound task has an unreleased or foreign lease")
    lease_hashes.append(sha)
owner=service._service_status(paths)
require(service._owner_fingerprint(owner)==service._owner_fingerprint(process["service_owner"]),"live native owner differs from the retained Ready owner")
processes=[]
for pid in [process["api_pid"],owner["pid"],*[child["pid"] for child in owner["children"]]]:
    pid_path=pathlib.Path("/proc")/str(pid)
    fields=(pid_path/"stat").read_text().rsplit(")",1)[1].split()
    processes.append({"pid":pid,"kernel_starttime":fields[19]})
for pid_path in pathlib.Path("/proc").iterdir():
    if not pid_path.name.isdigit() or int(pid_path.name)==os.getpid(): continue
    try: command=(pid_path/"cmdline").read_bytes()
    except FileNotFoundError: continue
    require(not (b"python" in command.split(b"\0",1)[0] and b"/opt/fullmag/docker_startup_script.py" in command),"an activation wrapper is still running")
after=get("/v2/sessions/current/status")
require(after["session"]==session and after.get("run")==before.get("run")
    and after["resources"]["scene_revision"]==before["resources"]["scene_revision"],"current workspace changed during the probe")
require(startup.retirement_receipt_evidence(operation,expected["inputs_sha256"])==evidence,"retirement intent changed after the barrier")
print(json.dumps({"schema":"fullmag.held-retirement-read-only-probe.v1",
    "api_instance_id":instance,"session_id":scope[0],"session_epoch":scope[1],"request_scope_epoch":scope[2],
    "run_id":run["run_id"],"task_id":task["task_id"],"task_lifecycle":"failed",
    "run_intent_sha256":intent_sha,"catalog_sha256":catalog_sha,"released_lease_sha256":sorted(lease_hashes),
    "native_config_sha256":config_sha,"native_owner_fingerprint_sha256":digest(service._owner_fingerprint(owner).encode()),
    "native_processes":processes,"process_receipt_sha256":process_sha,"failure_fence_sha256":fence_sha,
    "store_binding":binding,"retirement_marker_sha256":evidence["marker_sha256"],
    "archive_present":False,"successor_marker_present":False,"transition_barrier_observed":True,
    "scene_revision":after["resources"]["scene_revision"],"visualization_revision":visualization["revision"],
    "scope":"read-only evidence; no lease release, stop, restart, UI reset or Solve"}))
'''


def inspect_retirement(args):
    """Inspect exact retained pins, using no mutation or operation lease."""
    for value in (args.attempt, args.iteration_attempt, args.activation_attempt):
        if not re.fullmatch(r"[0-9a-f]{32}", value):
            raise BuildControlError("Expected a complete retained attempt identity")
    selected, _, identity = _resolve_selected(args)
    configured = toolchain_configuration(selected, identity)
    control = BuildControl(identity, configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    root = "development/attempts/" + args.attempt
    original = control.read(root + "/terminal.json")
    document = control.read(root + "/compose.json")
    if hashlib.sha256(canonical(document)).hexdigest() != args.config_sha256:
        raise BuildControlError("Retained Compose digest changed")
    pin = _validate_resume_terminal(control, args.iteration_attempt,
        development_attempt=args.attempt, config_sha256=args.config_sha256,
        previous=original, phase="iteration")
    effective = dict(original, backend_container=pin["backend_container"],
        frontend_container=pin["frontend_container"])
    image = original["inputs"]["image_id"]
    backend, frontend = _validate_running_group(control, identity, document, effective,
        image, source_root=str(selected), require_healthy=False)
    actual = json.loads(docker_capture("inspect", backend).stdout)[0]
    if actual["State"]["StartedAt"] != pin["backend_started_at"]:
        raise BuildControlError("Backend incarnation changed after the retained iteration")
    retained = _retained_retirement_context(control, development_attempt=args.attempt,
        config_sha256=args.config_sha256, source_root=str(selected), image_id=image, backend_id=backend)
    if retained is None:
        raise BuildControlError("There is no held retirement")
    receipt, context, raw = retained
    if (context["operation_id"] != args.activation_attempt or context["phase"] != "retirement"
            or context.get("archive_sha256") is not None or context.get("terminal") is not None):
        raise BuildControlError("Operation is not the selected unresolved pre-publication retirement")
    _, helper_id = _validate_helper(control, receipt["helper_container"], args.activation_attempt)
    result = docker_capture("exec", "-i", backend, "python3", "-B", "-c", _PROBE,
        data=canonical(context), timeout=45)
    probe = json.loads(result.stdout)
    fresh = _read_control_bytes(control, "activation/attempts/" + args.activation_attempt + "/receipt.json")
    if fresh != raw or _read_control_bytes(control, "active").strip() != args.activation_attempt.encode():
        raise BuildControlError("Held operation changed during inspection")
    _, fresh_helper = _validate_helper(control, receipt["helper_container"], args.activation_attempt)
    if fresh_helper != helper_id:
        raise BuildControlError("Original helper incarnation changed during inspection")
    evidence = {"schema":"fullmag.held-retirement-inspection.v1", "state":"observed",
        "development_attempt":args.attempt, "iteration_attempt":args.iteration_attempt,
        "activation_attempt":args.activation_attempt, "compose_project":control.project,
        "config_sha256":args.config_sha256, "control_namespace":control.namespace,
        "backend_container":backend, "frontend_container":frontend, "image_id":image,
        "backend_started_at":pin["backend_started_at"], "helper_container_id":helper_id,
        "unknown_receipt_sha256":hashlib.sha256(raw).hexdigest(), "probe":probe,
        "execution_authorized":False, "full_ui_checkpoint":False}
    return {**evidence, "proof_sha256":hashlib.sha256(canonical(evidence)).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--iteration-attempt", required=True)
    parser.add_argument("--activation-attempt", required=True)
    parser.add_argument("--config-sha256", required=True)
    args = parser.parse_args()
    try:
        evidence = inspect_retirement(args)
    except (BuildControlError, ValueError, KeyError) as error:
        parser.exit(1, f"Retirement inspection failed: {error}\n")
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
