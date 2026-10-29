"""Pinned terminal-history retry after an OCI rejection before a new PID 1."""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from pathlib import Path, PurePosixPath

from docker_build_control import BuildControlError, canonical

SCHEMA = "fullmag.docker-terminal-prestart-reconciliation.v1"
OBSERVATION_SCHEMA = "fullmag.docker-terminal-prestart-observation.v1"
SHA = re.compile(r"[0-9a-f]{64}\Z")
RUN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}\Z")
PREFLIGHT_SCHEMA = "fullmag.docker-terminal-session-drain-preflight.v1"


def require(value, message):
    if not value:
        raise BuildControlError(message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def validate_failure_pin(proof):
    require(isinstance(proof, dict) and set(proof) == {
        "drain_sha256", "preflight_sha256", "backend_state_sha256",
        "frontend_state_sha256", "error_sha256", "previous_receipt_sha256",
    }, "Exact terminal prestart failure pins required")
    require(all(isinstance(v, str) and SHA.fullmatch(v) for v in proof.values()),
            "Invalid terminal prestart digest")


def validate_history_baseline(value):
    require(isinstance(value, dict) and set(value) == {"path", "sha256", "run_id"},
            "Exact operator history baseline required")
    path = PurePosixPath(value["path"]) if isinstance(value["path"], str) else None
    require(path is not None and str(path) == value["path"]
            and path.parts[:1] == ("verification",) and ".." not in path.parts
            and path.suffix == ".json", "Operator baseline must be a control verification record")
    require(isinstance(value["sha256"], str) and SHA.fullmatch(value["sha256"])
            and isinstance(value["run_id"], str) and RUN.fullmatch(value["run_id"])
            and value["run_id"] not in (".", ".."), "Invalid operator baseline identity")


def validate_publication_pin(value):
    from docker_volume_reconcile import TOKEN
    require(isinstance(value, dict) and set(value) == {"attempt", "sha256"}
            and isinstance(value["attempt"], str) and TOKEN.fullmatch(value["attempt"])
            and isinstance(value["sha256"], str) and SHA.fullmatch(value["sha256"]),
            "Exact prior iteration publication pin required")


def prior_publication(control, request, original):
    from docker_volume_reconcile import read_raw
    pin = request["prior_publication"]
    validate_publication_pin(pin)
    raw = read_raw(control, "iteration/attempts/" + pin["attempt"] + "/terminal.json")
    require(digest(raw) == pin["sha256"] and read_raw(control, "iteration/verified.json") == raw,
            "Prior iteration publication CAS differs")
    value = json.loads(raw)
    require(value.get("control_volume") == original.get("control_volume") == control.volume
            and getattr(control, "namespace", "") == ""
            and "control_namespace" not in original and "control_namespace" not in value,
            "Terminal publication control-volume scope differs or uses an unsupported namespace")
    inputs = value.get("inputs", {})
    require(value.get("schema") == "fullmag.docker-build-operation.v1"
            and value.get("phase") == "iteration" and value.get("state") == "succeeded"
            and value.get("attempt") == pin["attempt"] and value.get("compose_project") == request["compose_project"]
            and inputs.get("attempt") == original.get("inputs", {}).get("attempt")
            and inputs.get("source_root") == request["source_root"]
            and inputs.get("config_sha256") == value.get("config_sha256") == request["config_sha256"]
            and inputs.get("image_id") == request["containers"]["backend"]["image"]
            and value.get("backend_container") == request["containers"]["backend"]["id"]
            and value.get("frontend_container") == request["containers"]["frontend"]["id"]
            and value.get("backend_started_at") == request["containers"]["backend"]["started_at"]
            and all(value.get(k) == original.get(k) for k in
                    ("state_root", "backend_volumes", "frontend_volume")),
            "Prior iteration publication is not the exact retained generation")
    require(isinstance(value.get("backend_build_receipt_sha256"), str)
            and SHA.fullmatch(value["backend_build_receipt_sha256"]),
            "Prior iteration has no sealed package pin")
    return value


def validate_observation(value):
    expected = {"schema", "run_id", "terminal_evidence_sha256", "runtime_config_sha256",
                "package_receipt_sha256", "provenance_sha256", "held_run_intent_sha256",
                "released_snapshot_sha256", "recovery_store_sha256", "storage_binding_sha256",
                "operator_baseline_projection_sha256"}
    require(isinstance(value, dict) and set(value) == expected
            and value["schema"] == OBSERVATION_SCHEMA, "Terminal observation schema/keys differ")
    require(isinstance(value["run_id"], str) and RUN.fullmatch(value["run_id"])
            and value["run_id"] not in (".", ".."), "Invalid terminal run identity")
    for name in expected - {"schema", "run_id", "held_run_intent_sha256"}:
        require(isinstance(value[name], str) and SHA.fullmatch(value[name]),
                "Invalid terminal observation digest: " + name)
    held = value["held_run_intent_sha256"]
    require(isinstance(held, dict) and len(held) <= 128
            and all(isinstance(k, str) and RUN.fullmatch(k) and k not in (".", "..")
                    and isinstance(v, str) and SHA.fullmatch(v) for k, v in held.items())
            and value["run_id"] not in held, "Invalid held run pins")


def validate_preflight(probe):
    required = {"schema", "api_instance_id", "session_id", "session_epoch",
                "request_scope_epoch", "run", "compute_queue", "runtime_service"}
    require(isinstance(probe, dict) and set(probe) in
            (required, required | {"held_run_intent_sha256"})
            and probe["schema"] == PREFLIGHT_SCHEMA, "Only a terminal session preflight is supported")
    require(all(isinstance(probe[k], str) and probe[k]
                for k in ("api_instance_id", "session_id", "session_epoch", "request_scope_epoch")),
            "Terminal preflight session identity is incomplete")
    run, queue, runtime = probe["run"], probe["compute_queue"], probe["runtime_service"]
    require(isinstance(run, dict) and run.get("status") in
            {"completed", "failed", "cancelled", "stopped"}
            and run.get("session_id") == probe["session_id"]
            and isinstance(run.get("run_id"), str) and RUN.fullmatch(run["run_id"]),
            "Terminal preflight run is not terminal or belongs to another session")
    require(isinstance(queue, dict) and queue.get("schema_version") == "compute_queue.v1"
            and queue.get("next_cursor") is None and isinstance(queue.get("items"), list),
            "Terminal preflight queue is incomplete")
    items = queue["items"]
    require(len(items) <= 128 and all(isinstance(row, dict) and row.get("state") == "accepted"
            and isinstance(row.get("run_id"), str) and RUN.fullmatch(row["run_id"])
            for row in items), "Terminal queue contains a released/running computation")
    ids = [row["run_id"] for row in items]
    held = probe.get("held_run_intent_sha256", {})
    require(len(set(ids)) == len(ids) and isinstance(held, dict) and set(ids) == set(held)
            and run["run_id"] not in held
            and all(isinstance(v, str) and SHA.fullmatch(v) for v in held.values()),
            "Held manual intents do not match the exact queue")
    require(isinstance(runtime, dict) and runtime.get("configured") is True
            and runtime.get("state") == "ready", "Original terminal runtime was not ready")
    return run["run_id"], held


# The retained binary owns terminality, retry, preparation and resource evidence.
# Python only checks raw-file preservation and never interprets numerical payloads.
PROBE = r"""
import calendar,datetime,hashlib,json,os,re,stat,subprocess,sys,types,uuid
from pathlib import Path
sys.path.insert(0,"/opt/fullmag")
import backend_dev as backend
import entrypoint as image_entrypoint
# Reuse the image-owned CPU CUDA ABI loader setup, without hardware preflight.
image_entrypoint._configure_device_access()
request=json.loads(sys.argv[1])
def check(ok,message):
 if not ok: raise RuntimeError(message)
def writer_timestamp_ns(value):
 match=re.fullmatch(r"([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})",value) if isinstance(value,str) else None
 check(match is not None,"Native diagnostic writer timestamps are malformed")
 # Preserve all native nanoseconds; datetime only validates whole calendar seconds.
 try: local=datetime.datetime.strptime(match.group(1),"%Y-%m-%dT%H:%M:%S")
 except ValueError as error: raise RuntimeError("Native diagnostic writer timestamps are malformed") from error
 zone=match.group(3);offset=0
 if zone!="Z":
  hours,minutes=map(int,zone[1:].split(":"))
  check(hours<24 and minutes<60,"Native diagnostic writer timestamps are malformed")
  offset=(hours*3600+minutes*60)*(1 if zone[0]=="+" else -1)
 return (calendar.timegm(local.timetuple())-offset)*1000000000+int((match.group(2) or "").ljust(9,"0"))
def read(path,limit=1048576):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
 try:
  before=os.fstat(fd)
  check(stat.S_ISREG(before.st_mode) and before.st_size<=limit,"Unbounded/nonregular proof file")
  data=bytearray()
  while len(data)<=limit:
   chunk=os.read(fd,min(65536,limit+1-len(data)))
   if not chunk: break
   data.extend(chunk)
  after=os.fstat(fd)
  check((before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==
        (after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)
        and len(data)==before.st_size,"Proof file changed")
  return bytes(data)
 finally: os.close(fd)
def sha(path,limit=1048576):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
 try:
  before=os.fstat(fd);total=0;result=hashlib.sha256()
  check(stat.S_ISREG(before.st_mode) and before.st_size<=limit,"Unbounded hash input")
  while True:
   chunk=os.read(fd,65536)
   if not chunk: break
   total+=len(chunk);check(total<=limit,"Hash input grew");result.update(chunk)
  after=os.fstat(fd)
  check((before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==
        (after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)
        and total==before.st_size,"Hash input changed")
  return result.hexdigest()
 finally: os.close(fd)
def packed(value):
 return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
root=Path("/state/runs/docker-all/session-store")
def inventory():
 result={};size=0
 for parent,dirs,files in os.walk(root,followlinks=False):
  if Path(parent)==root: dirs[:]=[d for d in dirs if d!="runtime-services"]
  check(not any((Path(parent)/n).is_symlink() for n in dirs),"Store directory is a symlink")
  for name in files:
   path=Path(parent)/name
   relative=path.relative_to(root).as_posix()
   if relative in {"WRITER.owner.json","WRITER.lock"}: continue
   check(not path.is_symlink() and path.is_file(),"Store entry is not a regular file")
   size+=path.stat().st_size
   check(len(result)<32768 and size<=1024**3,"Store inventory exceeds proof bounds")
   result[relative]=sha(path,1024**3)
 return result
def held():
 result={}
 for run,pin in request["held"].items():
  directory=root/"runs"/run
  check(directory.is_dir() and not directory.is_symlink(),"Held run is not a real directory")
  raw=read(directory/"run_intent.json")
  value=json.loads(raw)
  check(value.get("run_id")==run and
        value.get("specification",{}).get("parameters",{}).get("fullmag.accepted_run_start")==
        {"schema_version":"accepted_run_start_policy.v1","mode":"manual"},"Held run is not canonical manual")
  check(not os.path.lexists(directory/"start_release.json"),"Held manual run has been released")
  check(hashlib.sha256(raw).hexdigest()==pin,"Held intent changed")
  result[run]=pin
 return result
def history_projection(records):
 required={"all_run_catalogs","full_run_files","recovered_solution_files"}
 check(required<=set(baseline),"Operator baseline is incomplete")
 catalogs={k:v for k,v in records.items() if k.startswith("runs/") and k.count("/")==2 and k.endswith("/run_catalog.json")}
 prefix="runs/"+request["history_run_id"]+"/"
 full={k[len(prefix):]:v for k,v in records.items() if k.startswith(prefix)}
 solution=baseline["recovered_solution_files"]
 check(isinstance(solution,dict) and "manifest.json" in solution and solution,"Solution baseline is incomplete")
 candidates=[k.removesuffix("/manifest.json")+"/" for k,v in records.items()
             if k.startswith("solutions/") and k.count("/")==2 and k.endswith("/manifest.json")
             and v==solution["manifest.json"]]
 check(len(candidates)==1,"Saved solution owner is absent or ambiguous")
 recovered={k[len(candidates[0]):]:v for k,v in records.items() if k.startswith(candidates[0])}
 projected={"all_run_catalogs":catalogs,"full_run_files":full,"recovered_solution_files":recovered}
 check(full and "run_catalog.json" in full and projected=={k:baseline[k] for k in required},
       "Operator baseline scientific bytes changed")
 return packed(projected)
def admission_snapshot():
 result={}
 for name in (".fullmag-linux-native-owner.json",".linux-native-sentinel",".linux-native-restart",".linux-native-probe.json"):
  path=Path("/retained-state")/name
  metadata=path.stat()
  result[name]={"sha256":sha(path),"identity":[metadata.st_dev,metadata.st_ino,metadata.st_mode,
      metadata.st_uid,metadata.st_gid,metadata.st_nlink,metadata.st_size,metadata.st_mtime_ns,metadata.st_ctime_ns]}
 certificate=Path("/run/fullmag/linux-native-host.json");metadata=certificate.stat()
 result["host_certificate"]={"sha256":sha(certificate),"identity":[metadata.st_dev,metadata.st_ino,
     metadata.st_mode,metadata.st_uid,metadata.st_gid,metadata.st_nlink,metadata.st_size,
     metadata.st_mtime_ns,metadata.st_ctime_ns]}
 return result
check(all(os.environ.get(key)==value for key,value in request["storage_environment"].items()),
      "Private storage environment differs from its retained pin")
admission_before=admission_snapshot()
private=Path("/evidence/linux-native-probe.json")
overlay=Path("/state/.linux-native-probe.json")
metadata=private.stat();bound=overlay.stat()
check(metadata.st_uid==65532 and stat.S_IMODE(metadata.st_mode)==0o600
      and stat.S_ISREG(metadata.st_mode) and metadata.st_nlink==1
      and (metadata.st_dev,metadata.st_ino)==(bound.st_dev,bound.st_ino),
      "Private namespace evidence inode/owner/permissions differ")
probe_path=Path("/opt/fullmag/source/docker/all-in-one/linux_native_probe.py")
probe_source=read(probe_path,262144)
check(hashlib.sha256(probe_source).hexdigest()==request["storage_probe_sha256"],"Storage probe source changed")
storage_probe=types.ModuleType("terminal_linux_native_probe")
exec(compile(probe_source,str(probe_path),"exec"),storage_probe.__dict__)
private_evidence=storage_probe.run(True,evidence_path=private)
check(json.loads(read(overlay))==private_evidence,"Private evidence overlay readback differs")
check(admission_snapshot()==admission_before,"Namespace probe changed original storage admission")
owner=json.loads(read(Path("/retained-state")/".fullmag-linux-native-owner.json"))
storage_binding={"environment":request["storage_environment"],"probe_source_sha256":request["storage_probe_sha256"],
 "profile":private_evidence["storage_profile"],"engine_id":owner["engine_id"],
 "owner_token":private_evidence["owner_token"],"root_device":private_evidence["root_device"],
 "root_inode":private_evidence["root_inode"]}
def save_private_report(stage):
 report={"schema":"fullmag.terminal-private-namespace-proof.v1","stage":stage,
  "storage_probe_source_sha256":request["storage_probe_sha256"],"private_probe":private_evidence,
  "original_admission_before":admission_before,"original_admission_after":admission_snapshot(),
  "storage_binding_sha256":packed(storage_binding)}
 Path("/evidence/namespace-observation.json").write_text(json.dumps(report,sort_keys=True)+"\n")
save_private_report("namespace-probed")
baseline_raw=read(Path("/opt/fullmag/control")/request["history_baseline"]["path"],8388608)
check(hashlib.sha256(baseline_raw).hexdigest()==request["history_baseline"]["sha256"],"Operator baseline CAS differs")
baseline=json.loads(baseline_raw)
receipt,raw,_=backend._validated_package(Path("/opt/fullmag/package"),"retained terminal proof",exclude_development_control=True)
config=Path("/opt/fullmag/runtime-control/runtime-service/docker-all.json")
configuration=read(config,65536)
provenance=Path("/opt/fullmag/control/backend/runtime-provenance.json")
provenance_raw=read(provenance,8388608);provenance_sha=hashlib.sha256(provenance_raw).hexdigest()
published=json.loads(provenance_raw);source=receipt.get("source");native=receipt.get("native_source_identity")
check(isinstance(published,dict) and published.get("schema")=="fullmag.docker-all-image.v1"
      and published.get("state")=="succeeded" and published.get("image_id")==request["image_id"]
      and published.get("build_receipt_sha256")==hashlib.sha256(raw).hexdigest()
      and published.get("package_root")=="/opt/fullmag/package"
      and published.get("backend_build_receipt")=="/opt/fullmag/package/backend-build-receipt.json",
      "Retained provenance does not identify the sealed package/image")
check(isinstance(source,dict) and isinstance(native,dict)
      and isinstance(source.get("resolved_commit"),str) and re.fullmatch("[0-9a-f]{40}",source["resolved_commit"])
      and published.get("commit")==source["resolved_commit"]
      and published.get("source_mode")==source.get("source_mode")=="live-shadow-v1"
      and published.get("source_digest")==source.get("source_digest")
      and published.get("source_snapshot_sha256")==native.get("source_snapshot_sha256")
      and published.get("native_source_identity")==native
      and published.get("native_source_identity_sha256")==receipt.get("native_source_identity_sha256")
      and published.get("toolchain")==receipt.get("toolchain")
      and published.get("toolchain_image_id")==receipt.get("toolchain",{}).get("image_id"),
      "Retained provenance source/toolchain differs from its receipt")
artifacts=receipt.get("artifacts")
check(isinstance(artifacts,list) and published.get("artifacts")==artifacts
      and published.get("execution_lanes")==receipt.get("execution_lanes")
      and published.get("binary_hashes")=={row["path"][4:]:row["sha256"] for row in artifacts
          if isinstance(row,dict) and isinstance(row.get("path"),str) and row["path"].startswith("bin/")},
      "Retained provenance binary inventory differs from its sealed package")
before=inventory();held_before=held();history_sha=history_projection(before)
completed=subprocess.run(["/opt/fullmag/package/bin/fullmag-bin","runtime","service-inspect-terminal-run",
 "--config",str(config),"--config-sha256",hashlib.sha256(configuration).hexdigest(),
 "--run-id",request["run_id"]],capture_output=True,text=True,timeout=30)
check(completed.returncode==0,"Native terminal evidence failed: "+completed.stderr[-2048:])
value=json.loads(completed.stdout)
check(set(value)=={"schema_version","run_id","terminal_evidence_sha256","mutations_applied","solve_replayed"}
      and value["schema_version"]=="runtime_service_terminal_run_evidence.v1"
      and value["run_id"]==request["run_id"] and value["mutations_applied"] is False
      and value["solve_replayed"] is False,"Native terminal evidence identity differs")
after=inventory()
check(read(probe_path,262144)==probe_source and admission_snapshot()==admission_before,
      "Native proof changed source or original storage admission")
save_private_report("native-inspected")
check(before==after and held_before==held() and configuration==read(config,65536)
      and provenance_sha==sha(provenance,8388608),"Native proof changed retained files")
again,again_raw,_=backend._validated_package(Path("/opt/fullmag/package"),"retained terminal proof",exclude_development_control=True)
check(raw==again_raw and receipt==again,"Retained package changed")
writer=root/"WRITER.owner.json"
if writer.exists():
 owner=json.loads(read(writer,65536))
 check(isinstance(owner,dict) and set(owner)=={"schema","token","process_start_token","host","pid",
       "acquired_at","heartbeat_at","released"} and owner["schema"]=="fullmag.writer.v1"
       and owner["released"] is True and isinstance(owner["host"],str) and bool(owner["host"])
       and type(owner["pid"]) is int and 0<owner["pid"]<=4294967295,
       "Native diagnostic writer is malformed or not released")
 for key in ("token","process_start_token"):
  check(isinstance(owner[key],str) and str(uuid.UUID(owner[key]))==owner[key] and uuid.UUID(owner[key]).int!=0,
        "Native diagnostic writer token is malformed")
 acquired=writer_timestamp_ns(owner["acquired_at"])
 heartbeat=writer_timestamp_ns(owner["heartbeat_at"])
 check(heartbeat>=acquired,"Native diagnostic writer timestamps are malformed")
print(json.dumps({"run_id":request["run_id"],"terminal_evidence_sha256":value["terminal_evidence_sha256"],
 "runtime_config_sha256":hashlib.sha256(configuration).hexdigest(),"package_receipt_sha256":hashlib.sha256(raw).hexdigest(),
 "provenance_sha256":provenance_sha,"held_run_intent_sha256":held_before,
 "recovery_store_sha256":packed(after),"operator_baseline_projection_sha256":history_sha,
 "storage_binding_sha256":packed(storage_binding)},sort_keys=True,separators=(",",":")))
"""


STORAGE_ENVIRONMENT = {
    "FULLMAG_SESSION_STORAGE_PROFILE", "FULLMAG_DOCKER_HOST_ID", "FULLMAG_RUNTIME_IMAGE_ID",
    "FULLMAG_TOOLCHAIN_IMAGE_ID", "FULLMAG_BACKEND_CARGO_PROFILE", "FULLMAG_COMPOSE_PROJECT",
}


def retained_storage_environment(control, actual):
    values = {}
    for entry in actual.get("Config", {}).get("Env", []):
        require(isinstance(entry, str) and "=" in entry, "Malformed retained environment entry")
        key, value = entry.split("=", 1)
        if key in STORAGE_ENVIRONMENT:
            require(key not in values, "Duplicate retained storage environment key")
            values[key] = value
    require(set(values) == STORAGE_ENVIRONMENT
            and values["FULLMAG_SESSION_STORAGE_PROFILE"] == "linux-native-v1"
            and values["FULLMAG_RUNTIME_IMAGE_ID"] == actual["Image"]
            and isinstance(values["FULLMAG_DOCKER_HOST_ID"], str) and SHA.fullmatch(values["FULLMAG_DOCKER_HOST_ID"])
            and re.fullmatch(r"sha256:[0-9a-f]{64}", values["FULLMAG_TOOLCHAIN_IMAGE_ID"])
            and values["FULLMAG_BACKEND_CARGO_PROFILE"] == "backend-dev"
            and values["FULLMAG_COMPOSE_PROJECT"] == control.project,
            "Retained Linux storage profile/engine/image/toolchain/group differs")
    return values


def diagnostic_document(control, actual, payload, *, evidence_root):

    """Clone exact retained mounts into one no-network, no-GPU Compose probe."""
    from docker_compose_identity import source_labels, validate_source_labels
    validate_source_labels(actual, control.identity)
    storage_environment = retained_storage_environment(control, actual)
    require(isinstance(evidence_root, str) and re.fullmatch(
        r"verification/terminal-prestart-recovery-20261027/probes/[0-9a-f]{32}", evidence_root),
        "Private namespace evidence requires its own bounded control scope")
    mounts = []
    allowed = {"/state", "/host-ledger", "/opt/fullmag/package", "/opt/fullmag/control",
               "/opt/fullmag/runtime-control", "/state/runs/docker-all/session-store/runtime-services",
               "/opt/fullmag/source", "/run/fullmag/linux-native-host.json"}
    declared = actual.get("HostConfig", {}).get("Mounts", [])
    for target in sorted(allowed):
        rows = [m for m in actual.get("Mounts", []) if m.get("Destination") == target]
        require(len(rows) == 1, "Missing/duplicate retained diagnostic mount: " + target)
        row = rows[0]
        require(row.get("Type") in {"bind", "volume"}, "Unsupported diagnostic mount")
        source = row.get("Name") if row["Type"] == "volume" else row.get("Source")
        require(isinstance(source, str) and source and "\\n" not in source, "Invalid diagnostic mount source")
        mount = {"type": row["Type"], "source": source, "target": target,
                 "read_only": target not in {"/state", "/host-ledger"}}
        if row["Type"] == "volume":
            definitions = [m for m in declared if m.get("Target") == target]
            require(len(definitions) == 1, "Ambiguous declared volume mount")
            subpath = definitions[0].get("VolumeOptions", {}).get("Subpath", "")
            require(isinstance(subpath, str) and (not subpath or
                    (str(PurePosixPath(subpath)) == subpath and not subpath.startswith("/")
                     and all(re.fullmatch(r"[A-Za-z0-9_.-]+", part)
                             and part not in {".", ".."} for part in subpath.split("/")))),
                    "Unsafe retained diagnostic subpath")
            # The reused shared-lock snapshot adapter has no subpath support.
            require(target not in {"/state", "/host-ledger"} or not subpath,
                    "Released snapshot cannot observe a volume subpath")
            mount["volume"] = {"nocopy": True, **({"subpath": subpath} if subpath else {})}
        mounts.append(mount)
    state_alias = dict(next(m for m in mounts if m["target"] == "/state"),
                       target="/retained-state", read_only=True)
    control_mount = next(m for m in mounts if m["target"] == "/opt/fullmag/control")
    require(control_mount["type"] == "volume" and control_mount["source"] == control.volume
            and not control_mount["volume"].get("subpath"),
            "Private namespace evidence requires the exact unnamespaced control volume")
    mounts.extend([state_alias,
        {"type": "volume", "source": control.volume, "target": "/evidence", "read_only": False,
         "volume": {"nocopy": True, "subpath": evidence_root}},
        {"type": "volume", "source": control.volume, "target": "/state/.linux-native-probe.json",
         "read_only": True, "volume": {"nocopy": True, "subpath": evidence_root + "/linux-native-probe.json"}},
    ])
    libraries = [entry.partition("=")[2] for entry in actual.get("Config", {}).get("Env", [])
                 if isinstance(entry, str) and entry.startswith("LD_LIBRARY_PATH=")]
    require(len(libraries) <= 1, "Ambiguous retained library path")
    labels = {"com.docker.compose.project": control.project,
              "com.docker.compose.service": "terminal-prestart-proof", **source_labels(control.identity)}
    volumes = {mount["source"]: {"external": True, "name": mount["source"]}
               for mount in mounts if mount["type"] == "volume"}
    return {"name": control.project, "volumes": volumes, "services": {"terminal-prestart-proof": {
        "image": actual["Image"], "pull_policy": "never", "runtime": "runc",
        "user": "65532:65532", "network_mode": "none", "read_only": True,
        "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
        "mem_limit": "256m", "pids_limit": 24, "cpus": 1, "healthcheck": {"disable": True}, "labels": labels,
        "environment": {**storage_environment, "PYTHONDONTWRITEBYTECODE": "1", "FULLMAG_DOCKER_DEVICE_ACCESS": "cpu", "LD_LIBRARY_PATH": "/opt/fullmag/package/lib" + (":" + libraries[0] if libraries else "")},
        "volumes": mounts, "entrypoint": ["/usr/local/bin/python3", "-B", "-c"],
        "command": [PROBE, json.dumps(payload, separators=(",", ":"))],
    }}}


def build_observation(control, actual, probe, history_baseline):
    from docker_build_control import compose_capture, ControlOutcomeUnknown
    from docker_volume_reconcile import read_raw
    from docker_volume_pre_ack_retry import _released_snapshot
    run_id, held = validate_preflight(probe)
    validate_history_baseline(history_baseline)
    raw = read_raw(control, history_baseline["path"])
    require(digest(raw) == history_baseline["sha256"], "Operator baseline CAS differs")
    require(isinstance(json.loads(raw), dict), "Operator baseline must be an object")
    storage_environment = retained_storage_environment(control, actual)
    source_path = Path(__file__).resolve().parents[1] / "docker/all-in-one/linux_native_probe.py"
    source_raw = source_path.read_bytes()
    require(0 < len(source_raw) <= 262144, "Storage probe source exceeds its bound")
    evidence_root = "verification/terminal-prestart-recovery-20261027/probes/" + uuid.uuid4().hex
    helper_name = "fullmag-terminal-proof-" + evidence_root.rsplit("/", 1)[1]
    # Keep the large baseline in its existing control mount, below argv limits.
    payload = {"run_id": run_id, "image_id": actual["Image"], "held": held,
               "history_baseline": history_baseline, "history_run_id": history_baseline["run_id"],
               "storage_probe_sha256": digest(source_raw), "storage_environment": storage_environment}
    document = diagnostic_document(control, actual, payload, evidence_root=evidence_root)
    before = _released_snapshot(control, actual)
    require(before.get("active_count") == 0, "A resource reservation is active")
    control.write(evidence_root + "/linux-native-probe.json", {})
    observation = {"schema": "fullmag.terminal-native-observation-attempt.v1", "state": "observing",
                   "helper_name": helper_name, "storage_probe_source_sha256": digest(source_raw)}
    control.write(evidence_root + "/attempt.json", observation)
    try:
        result = compose_capture(document, "run", "--rm", "--name", helper_name, "--no-deps",
                                 "terminal-prestart-proof", timeout=600)
    except ControlOutcomeUnknown as error:
        observation["state"] = "outcome-unknown-resources-retained"
        try:
            control.write(evidence_root + "/attempt.json", observation)
        except Exception:
            error.add_note("Unknown native observation could not be persisted; helper must be inspected explicitly")
        raise
    require(len(result) <= 1024 * 1024, "Terminal observation exceeds its bound")
    value = json.loads(result)
    after = _released_snapshot(control, actual)
    require(before == after and after.get("active_count") == 0, "Released resource evidence changed")
    value.update(schema=OBSERVATION_SCHEMA, released_snapshot_sha256=digest(canonical(after)))
    validate_observation(value)
    require(read_raw(control, history_baseline["path"]) == raw and source_path.read_bytes() == source_raw,
            "Operator baseline or storage probe source changed during proof")
    observation.update(state="observed", observation=value)
    control.write(evidence_root + "/attempt.json", observation)
    return value


def validate_failure(control, root, request, original, actual, state):
    from docker_volume_reconcile import read_raw
    from docker_volume_stop_unadmitted import _read_terminal_process_receipt, _owner_identity_key
    require(digest(Path(__file__).read_bytes()) == request["prestart_helper_sha256"],
            "Terminal prestart helper differs from the reviewed request")
    proof = request["failure"]
    validate_failure_pin(proof)
    for name in ("backend", "frontend"):
        stopped = actual[name].get("State", {})
        require(digest(canonical(stopped)) == proof[name + "_state_sha256"]
                and stopped.get("Status") == "exited" and type(stopped.get("Pid")) is int
                and stopped["Pid"] == 0 and all(stopped.get(key) is False for key in
                ("Running", "Paused", "Restarting", "OOMKilled", "Dead")),
                "Terminal prestart Docker state CAS differs: " + name)
    backend, frontend = actual["backend"]["State"], actual["frontend"]["State"]
    error = backend.get("Error")
    require(type(backend.get("ExitCode")) is int and backend["ExitCode"] == 128
            and isinstance(error, str) and digest(error.encode()) == proof["error_sha256"]
            and "error running prestart hook #0" in error
            and "nvidia-container-cli: ldcache error: process /sbin/ldconfig terminated with signal 9" in error
            and type(frontend.get("ExitCode")) is int and frontend["ExitCode"] == 0
            and frontend.get("Error") == "", "Only the exact stopped NVIDIA prestart rejection is supported")
    documents = {}
    for name, filename in (("preflight", "terminal-session-preflight.json"),
                           ("drain", "backend-drain.json")):
        raw = read_raw(control, root + "/" + filename)
        require(digest(raw) == proof[name + "_sha256"], "Terminal prestart evidence CAS differs")
        documents[name] = json.loads(raw)
    probe, drain = documents["preflight"], documents["drain"]
    validate_preflight(probe)
    require(digest(canonical(probe)) == original.get("terminal_session_preflight_sha256"),
            "Original terminal preflight obligation differs")
    raw, receipt = _read_terminal_process_receipt(actual["backend"], control)
    require(drain.get("schema") == "fullmag.docker-idle-restart-drain.v1"
            and drain.get("backend_container_id") == actual["backend"]["Id"]
            and drain.get("process_receipt_sha256") == digest(raw)
            and drain.get("process_receipt") == receipt
            and receipt.get("schema") == "fullmag.docker-process-tree.v1"
            and receipt.get("state") == "drained", "Authenticated terminal drain changed")
    require(_owner_identity_key(receipt.get("service_owner"), "drained service") ==
            _owner_identity_key(receipt.get("terminal_service_owner"), "terminal service"),
            "Drain owner/children differ")
    require(not original.get("saved_authoring_restore_required")
            and "saved_authoring_checkpoint_sha256" not in original.get("inputs", {})
            and "backend_started_at" not in original
            and all(read_raw(control, root + "/" + name, optional=True) is None for name in
                    ("backend-build-receipt.json", "provenance.json", "saved-authoring-checkpoint.json")),
            "Prestart operation contains a new generation/publication or authoring obligation")
    base_attempt = original.get("inputs", {}).get("attempt")
    from docker_volume_reconcile import TOKEN
    require(isinstance(base_attempt, str) and TOKEN.fullmatch(base_attempt), "Missing original development attempt")
    previous_raw = read_raw(control, "development/attempts/" + base_attempt + "/terminal.json")
    require(digest(previous_raw) == proof["previous_receipt_sha256"], "Original development receipt CAS differs")
    previous = json.loads(previous_raw)
    require(previous.get("state") in {"failed-confirmed", "succeeded"}
            and previous.get("attempt") == base_attempt, "Original development terminal differs")
    published = prior_publication(control, request, original)
    observed = build_observation(control, actual["backend"], probe, request["history_baseline"])
    require(published.get("backend_build_receipt_sha256") == observed["package_receipt_sha256"],
            "Terminal proof does not use the original sealed package")
    require(observed == request["observation"], "Fresh terminal recovery observation changed")
    return dict(proof)


def continuation(control, args, previous, document, actual, state):
    """Return a typed terminal context; leave legacy saved-authoring dispatch intact."""
    from docker_volume_reconcile import TOKEN, read_raw, fingerprint, validate_request
    reference = getattr(args, "prestart_reconciliation", None)
    sha = getattr(args, "prestart_reconciliation_sha256", None)
    require(bool(reference) == bool(sha), "Both prestart reconciliation pins are required")
    if reference is None:
        return None
    require(isinstance(reference, str) and TOKEN.fullmatch(reference)
            and isinstance(sha, str) and SHA.fullmatch(sha), "Invalid prestart continuation pins")
    root = "iteration/attempts/" + reference
    terminal_raw = read_raw(control, root + "/terminal.json")
    require(digest(terminal_raw) == sha, "Confirmed terminal prestart receipt CAS differs")
    terminal = json.loads(terminal_raw)
    reconciliation = terminal.get("reconciliation", {})
    request_raw = read_raw(control, reconciliation["request"])
    require(digest(request_raw) == reconciliation.get("request_sha256"), "Terminal request CAS differs")
    request = json.loads(request_raw)
    if request.get("schema") != SCHEMA:
        return None
    validate_request(request)
    require(getattr(args, "restart_backend", False)
            and terminal.get("state") == "failed-confirmed" and terminal.get("phase") == "iteration"
            and terminal.get("attempt") == reference and request["attempt"] == reference
            and terminal.get("inputs", {}).get("attempt") == args.attempt
            and terminal.get("inputs", {}).get("config_sha256") == args.config_sha256
            and request["config_sha256"] == args.config_sha256
            and request["source_root"] == terminal["inputs"].get("source_root")
            and request["compose_project"] == control.project == terminal.get("compose_project")
            and terminal.get("state_root") == previous.get("state_root")
            and terminal.get("terminal_prestart_failure_proof") == request["failure"]
            and reconciliation.get("evidence") == request["failure"],
            "Confirmed terminal prestart operation differs")
    require(document["services"]["backend"]["environment"].get("FULLMAG_STARTUP_ENABLED") != "1",
            "Terminal continuation never activates a startup script")
    for name in ("backend", "frontend"):
        pin, observed = request["containers"][name], actual[name]
        require(observed.get("Id") == pin["id"] and observed.get("Image") == pin["image"]
                and observed.get("State", {}).get("StartedAt") == pin["started_at"]
                and fingerprint(observed) == pin["fingerprint"], "Terminal prestart incarnation changed")
    original_raw = read_raw(control, root + "/unknown-receipt.json")
    require(digest(original_raw) == request["unknown_receipt_sha256"], "Original unknown receipt changed")
    original = json.loads(original_raw)
    validate_failure(control, root, request, original, actual, state)
    return {"kind": "terminal_history", "request": request,
            "probe": json.loads(read_raw(control, root + "/terminal-session-preflight.json"))}


def complete(control, operation, backend_id, context, qualified):
    from docker_build_control import docker_text
    actual = json.loads(docker_text("inspect", backend_id))
    require(isinstance(qualified, dict) and set(qualified) == {
        "backend_container_id", "backend_started_at", "image_id", "package_receipt_sha256",
        "provenance_sha256", "runtime_config_sha256"},
        "Terminal completion requires the current finish qualification")
    require(len(actual) == 1 and actual[0].get("State", {}).get("Running") is True
            and actual[0].get("Id") == backend_id == qualified["backend_container_id"]
            and actual[0].get("State", {}).get("StartedAt") == qualified["backend_started_at"]
            and actual[0].get("Image") == qualified["image_id"],
            "Retried backend differs from its qualified incarnation")
    request = context["request"]
    require(qualified["image_id"] == request["containers"]["backend"]["image"],
            "Terminal retry changed the retained image")
    observed = build_observation(control, actual[0], context["probe"], request["history_baseline"])
    runtime_fields = {"package_receipt_sha256", "provenance_sha256", "runtime_config_sha256"}
    require(all(isinstance(qualified[k], str) and SHA.fullmatch(qualified[k])
                and observed[k] == qualified[k] for k in runtime_fields),
            "Terminal retry runtime is not the qualified publication")
    require({k: v for k, v in observed.items() if k not in runtime_fields} ==
            {k: v for k, v in request["observation"].items() if k not in runtime_fields},
            "Terminal retry changed retained history or held admission")
    control.write(operation["root"] + "/terminal-history-restart-result.json", {
        "schema": "fullmag.terminal-history-restart-result.v1", "state": "succeeded",
        "observation": observed, "solve_replayed": False, "authoring_restored": False,
    })
    operation["daemon_pending"] = False
