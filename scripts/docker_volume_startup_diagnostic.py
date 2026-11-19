"""Inspect a startup-fenced API without claiming historical runtime ownership."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re

from docker_build_control import BuildControl, BuildControlError, docker_capture

SCHEMA = "fullmag.docker-startup-diagnostic-inspection.v1"

PROBE = r'''import hashlib,json,os,pathlib,re,sys,urllib.error,urllib.request,uuid
sys.path.insert(0,"/opt/fullmag")
import runtime_service as runtime
paths=runtime.canonical_paths()

def read(path,label,maximum=1024*1024):
    first=runtime._bounded_regular(path,label,maximum)
    if first!=runtime._bounded_regular(path,label,maximum):
        raise RuntimeError(label+" changed during inspection")
    return first

def unique(pairs):
    result={}
    for key,value in pairs:
        if key in result: raise RuntimeError("duplicate JSON key")
        result[key]=value
    return result

def obj(raw):
    value=json.loads(raw,object_pairs_hook=unique)
    if not isinstance(value,dict): raise RuntimeError("expected a JSON object")
    return value

def sha(raw): return hashlib.sha256(raw).hexdigest()

def proc(pid):
    root=pathlib.Path("/proc")/str(pid)
    stat=(root/"stat").read_text().rsplit(")",1)[1].split()
    with (root/"cmdline").open("rb") as stream: raw=stream.read(65537)
    if len(raw)>65536: raise RuntimeError("process command exceeds bound")
    return {"pid":pid,"ppid":int(stat[1]),"start_ticks":int(stat[19]),
            "exe":os.readlink(root/"exe"),
            "argv":[value.decode("utf-8") for value in raw.split(b"\0") if value]}

rows=[]
for path in pathlib.Path("/proc").iterdir():
    if path.name.isdigit():
        try: rows.append(proc(int(path.name)))
        except FileNotFoundError: pass
if len(rows)>256: raise RuntimeError("process inventory exceeds bound")
by_pid={row["pid"]:row for row in rows}
init=by_pid.get(1)
supervisors=[row for row in rows if "/opt/fullmag/entrypoint.py" in row["argv"]]
apis=[row for row in rows if row["exe"].endswith("/fullmag-api")]
if (not init or pathlib.Path(init["exe"]).name not in {"docker-init","tini"}
        or len(supervisors)!=1 or len(apis)!=1):
    raise RuntimeError("startup diagnostic process tree is missing or ambiguous")
supervisor=supervisors[0];api_proc=apis[0];api_pid=api_proc["pid"]
if (supervisor["ppid"]!=1 or not pathlib.Path(supervisor["exe"]).name.startswith("python3")
        or api_proc["ppid"]!=supervisor["pid"]
        or set(by_pid)!={1,supervisor["pid"],api_pid,os.getpid()}):
    raise RuntimeError("unexpected process or parent in startup diagnostic namespace")
with (pathlib.Path("/proc")/str(api_pid)/"environ").open("rb") as stream:
    environment=stream.read(1024*1024+1)
if len(environment)>1024*1024: raise RuntimeError("API environment exceeds bound")
values=[item.split(b"=",1)[1].decode() for item in environment.split(b"\0")
        if item.startswith(b"FULLMAG_API_RUNTIME_FAILURE_FENCE=")]
if len(values)!=1: raise RuntimeError("API does not pin one failure fence")
fence_path=pathlib.Path(values[0]);parent=runtime.process_receipt_path(paths).parent
if (fence_path.parent!=parent or re.fullmatch(r"api-failure-[0-9a-f]{32}\.json",fence_path.name) is None):
    raise RuntimeError("API startup fence is outside its canonical namespace")
fence_raw=read(fence_path,"startup failure fence",256*1024);fence=obj(fence_raw)
instance=None
if (fence.get("schema")!="fullmag.api-runtime-failure-fence.v1"
        or fence.get("stage")!="runtime_startup"
        or ("api_pid" in fence and fence["api_pid"]!=api_pid)
        or not isinstance(fence.get("reason"),str) or not 0<len(fence["reason"])<=4096):
    raise RuntimeError("failure fence does not identify this startup-only API")
config_raw=read(paths.config,"runtime configuration",256*1024);config=obj(config_raw)
if (config.get("schema_version")!="runtime_service_config.v2"
        or config.get("target_id")!="docker-all" or pathlib.Path(config["store_root"])!=paths.store):
    raise RuntimeError("unexpected managed runtime configuration")
owner_path=paths.store/"runtime-services/OWNER.json"
owner_raw=read(owner_path,"historical owner",256*1024);owner=obj(owner_raw)
runtime._validate_terminal_owner(owner,state="failed",name="historical Failed owner",allowed_child_statuses=("exited_success","exited_failure"))
history_path=runtime.process_receipt_path(paths);history_raw=read(history_path,"historical process receipt")
if (owner.get("schema_version")!="runtime_service_owner.v1" or owner.get("state")!="failed"
        or owner.get("target_id")!="docker-all" or len(owner.get("children",[]))!=2
        or {child.get("role") for child in owner["children"]}!={"compute","preparation"}
        or any(child.get("status") not in {"exited_success","exited_failure"} for child in owner["children"])):
    raise RuntimeError("historical owner lacks terminal Failed scheduler evidence")
owner_pids=[owner["pid"],*(child["pid"] for child in owner["children"])]
if any(type(pid) is not int or pid<=0 or pathlib.Path("/proc",str(pid)).exists() for pid in owner_pids):
    raise RuntimeError("historical owner or scheduler process is still present")
ledger_root=pathlib.Path(config["host_execution"]["ledger_root"])
ledger_path=ledger_root/"HOST_RESOURCE_LEDGER.json";ledger_raw=read(ledger_path,"host ledger",4*1024*1024);ledger=obj(ledger_raw)
if ledger.get("schema_version")!="host_resource_ledger.v4": raise RuntimeError("unsupported ledger schema")
if any(item.get("state")!="released" for item in ledger["reservations"]):
    raise RuntimeError("active or ambiguous host reservation remains")
lease_digests={}
for path in sorted((paths.store/"runs").glob("*/resource_leases/*/*.json")):
    if len(lease_digests)>=10000: raise RuntimeError("lease inventory exceeds bound")
    raw=read(path,"local resource lease",256*1024);lease=obj(raw)
    if lease.get("schema_version")!="resource_lease.v1" or lease.get("state")!="released" or not lease.get("released_at"):
        raise RuntimeError("active or unconfirmed local lease remains")
    lease_digests[str(path.relative_to(paths.store))]=sha(raw)
provenance_raw=read(paths.provenance,"build provenance",256*1024);provenance=obj(provenance_raw)
snapshot=provenance["native_source_identity"]["source_snapshot_sha256"];commit=provenance["commit"]
def api(path,expected,maximum=256*1024):
    global instance
    try: response=urllib.request.urlopen("http://127.0.0.1:8081"+path,timeout=10)
    except urllib.error.HTTPError as error: response=error
    with response:
        raw=response.read(maximum+1)
        observed=response.headers.get("x-fullmag-api-instance")
        if instance is None:
            if path!="/v2/platform/health" or not observed or str(uuid.UUID(observed))!=observed:
                raise RuntimeError("initial API incarnation header is missing or malformed")
            instance=observed
        if len(raw)>maximum or response.code!=expected or observed!=instance:
            raise RuntimeError("API identity/status/read bound differs for "+path)
        return obj(raw)
health=api("/v2/platform/health",200)
if "api_instance_id" in fence and fence["api_instance_id"]!=instance:
    raise RuntimeError("optional fence API instance differs from live headers")
if health.get("status")!="degraded" or health.get("active_session") is not False:
    raise RuntimeError("API is not an empty execution-fenced diagnostic instance")
build=api("/v2/platform/openapi.json",200,4*1024*1024).get("x-fullmag-build-identity",{})
if build.get("git_commit")!=commit or build.get("source_snapshot_sha256")!=snapshot:
    raise RuntimeError("API build identity differs from published package")
if api("/v2/sessions/current/status",503).get("code")!="runtime_unavailable":
    raise RuntimeError("current-session route is not execution-fenced")
if (proc(api_pid)!=api_proc or proc(supervisor["pid"])!=supervisor
        or read(owner_path,"historical owner",256*1024)!=owner_raw
        or read(paths.config,"runtime configuration",256*1024)!=config_raw
        or read(fence_path,"startup failure fence",256*1024)!=fence_raw
        or read(ledger_path,"host ledger",4*1024*1024)!=ledger_raw
        or read(history_path,"historical process receipt")!=history_raw):
    raise RuntimeError("startup diagnostic identity changed during inspection")
print(json.dumps({"schema":"fullmag.docker-startup-diagnostic-guest.v1",
    "api":api_proc,"supervisor":supervisor,"api_instance_id":instance,
    "api_instance_evidence":"live matching health/openapi/status headers; PID binds fence through process environment",
    "fence_path":str(fence_path),"fence_sha256":sha(fence_raw),"fence":fence,
    "owner_sha256":sha(owner_raw),"owner":owner,"runtime_config_sha256":sha(config_raw),
    "historical_process_receipt_sha256":sha(history_raw),
    "ledger_sha256":sha(ledger_raw),"local_lease_digests":lease_digests,
    "provenance_sha256":sha(provenance_raw),"build_commit":commit,"build_snapshot":snapshot,
    "active_reservations":0,"active_local_leases":0,"historical_process_receipt_used_as_current":False},sort_keys=True))
'''


def validate_options(args):
    for name, pattern in (("backend_container_id", r"[0-9a-f]{64}"),
                          ("image_id", r"sha256:[0-9a-f]{64}")):
        if re.fullmatch(pattern, getattr(args, name, "")) is None:
            raise ValueError("Full immutable pin required: " + name)
    report = PurePosixPath(args.report)
    if (not args.report.startswith("verification/") or report.is_absolute()
            or ".." in report.parts or str(report) != args.report or not args.report.endswith(".json")):
        raise ValueError("Report must be a canonical control verification JSON path")


def inspect(args):
    from docker_dev import _select_source, _compose_identity
    from docker_dev_recovery_build import inspect_one, validate_backend
    from docker_volume_reconcile import fingerprint
    selected, layout = _select_source(Path(args.source_root), args.source_root)
    identity = _compose_identity(layout)
    control = BuildControl(identity, args.image_id)
    before = inspect_one("container", args.backend_container_id)
    validate_backend(before, identity, args.backend_container_id, args.image_id)
    result = docker_capture("exec", args.backend_container_id, "python3", "-B", "-c", PROBE, timeout=60)
    guest = json.loads(result.stdout)
    if guest.get("schema") != "fullmag.docker-startup-diagnostic-guest.v1":
        raise BuildControlError("Unexpected startup diagnostic probe result")
    after = inspect_one("container", args.backend_container_id)
    if fingerprint(before) != fingerprint(after):
        raise BuildControlError("Backend incarnation changed during inspection")
    report = {"schema": SCHEMA, "state": "inspected", "source_root": str(selected),
              "compose_project": control.project, "backend_container_id": args.backend_container_id,
              "image_id": args.image_id, "backend_started_at": before["State"]["StartedAt"],
              "container_fingerprint": fingerprint(before), "guest": guest,
              "probe_sha256": hashlib.sha256(PROBE.encode()).hexdigest(),
              "controller_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "justfile_sha256": hashlib.sha256((selected / "justfile").read_bytes()).hexdigest(),
              "storage_wrapper_sha256": hashlib.sha256((selected / "scripts/just_storage_shell.sh").read_bytes()).hexdigest(),
              "stop_authorized": False, "stop_applied": False, "new_solve": False}
    if control.read(args.report, optional=True) is not None:
        raise BuildControlError("Inspection report already exists; choose a fresh evidence path")
    control.write(args.report, report)
    print(json.dumps({"state": "inspected", "report": args.report,
                      "api_pid": guest["api"]["pid"], "active_reservations": 0,
                      "stop_authorized": False, "stop_applied": False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source-root", "backend-container-id", "image-id", "report"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    validate_options(args)
    inspect(args)


if __name__ == "__main__":
    main()
