"""Close one externally interrupted pre-owner source verification; never start services."""
from __future__ import annotations
import argparse
import base64
import copy
import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import uuid

from docker_build_control import BuildControl, BuildControlError, bounded_capture, canonical, docker_capture, toolchain_configuration
from docker_volume_offline_reconcile import _control_raw, _read_only_control_args, _line
from docker_volume_reconcile import fingerprint, require

SCHEMA = "fullmag.interrupted-preowner-verification-reconciliation.v1"
FAILURE_REASON = ("native Docker host profile initialization failed: native runtime service failed: "
                  "parse GPU temperature from nvidia-smi: invalid digit found in string")
ABSENT = ("runtime-control/runtime-services/OWNER.json", "runtime-control/runtime-services/LAUNCH.json",
          "runtime-control/runtime-service/process-tree.json", "runtime-control/runtime-service/docker-all.json")
STORE_FILES = {"WRITER.lock", "WRITER.owner.json", "scheduler_pools/docker-all.compute.resources.json",
               "scheduler_pools/docker-all.preparation.preparation-resources.json"}
STORE_DIRS = {".", "temp", "runs", "scheduler_pools", "live_command_journals", "objects", "recovery",
              "manifests", "runtime-services", "objects/sha256", "objects/pins"}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def validate_reason(value):
    require(value in (FAILURE_REASON, FAILURE_REASON + "\n"), "Startup fence differs from the exact GPU temperature parser failure")


def validate_startup_intent(environment):
    require(environment.get("FULLMAG_DOCKER_DEVICE_ACCESS") == "gpu"
            and not any(name.startswith("FULLMAG_STARTUP_") for name in environment),
            "Recovery requires retained GPU intent without a startup script")


def validate_receipt(value, attempt, project, volume):
    require(isinstance(value, dict) and value.get("schema") == "fullmag.docker-build-operation.v1"
            and value.get("phase") == "verification" and value.get("state") == "running"
            and value.get("attempt") == attempt and value.get("compose_project") == project
            and value.get("control_volume") == volume and value.get("helper_container") == "fullmag-control-" + attempt
            and value.get("qualification") == "source tests only"
            and value.get("runtime_qualification") == "NOT VERIFIED"
            and value.get("scope") in ("material-library-contracts", "gpu-temperature-contracts"),
            "Only the exact interrupted pre-owner source verification is eligible")
    expected = {
      "material-library-contracts": ["/usr/bin/env","CARGO_INCREMENTAL=0","CARGO_PROFILE_BACKEND_DEV_DEBUG=0",
        "/root/.cargo/bin/cargo","test","--locked","--profile","backend-dev","-p","fullmag-api","--bin","fullmag-api","material_library"],
      "gpu-temperature-contracts": ["/usr/bin/env","CARGO_INCREMENTAL=0","CARGO_PROFILE_BACKEND_DEV_DEBUG=0",
        "/root/.cargo/bin/cargo","test","--locked","--profile","backend-dev","-p","fullmag-runtime-control","--lib","gpu_temperature"]}
    require(value.get("commands") == [expected[value["scope"]]], "Verification commands are not the bounded source gate")
    witness = value.get("diagnostic_source_admission", {})
    require(witness.get("schema") == "fullmag.pre-owner-diagnostic-source-check.v1"
            and witness.get("owner_absent") is True and witness.get("process_receipt_absent") is True
            and witness.get("active_session") is False and witness.get("api_health") == "degraded"
            and all(type(witness.get(key)) is int and witness[key] == 0
                    for key in ("native_processes","active_reservations","active_local_leases")),
            "Verification lacks its original idle pre-owner diagnostic witness")


def validate_stopped(value, identifier, image, started_at, project, worktree):
    state = value.get("State", {})
    labels = value.get("Config", {}).get("Labels", {})
    require(value.get("Id") == identifier and value.get("Image") == image
            and state.get("StartedAt") == started_at
            and state.get("Running") is False and state.get("Status") == "exited" and state.get("Pid") == 0
            and type(state.get("ExitCode")) is int and state["ExitCode"] == 255
            and all(state.get(key) is False for key in ("OOMKilled","Paused","Restarting","Dead"))
            and isinstance(state.get("FinishedAt"), str) and bool(state["FinishedAt"])
            and labels.get("com.docker.compose.project") == project
            and labels.get("org.fullmag.source.worktree-id") == worktree,
            "The exact externally stopped container incarnation differs")


def validate_empty_namespace(value):
    require(isinstance(value, dict) and str(uuid.UUID(value.get("boot_id", ""))) == value["boot_id"],
            "Guest boot identity is invalid")
    require(not (set(ABSENT) & set(value.get("runtime", {}))), "Runtime owner/process/config appeared")
    require(value.get("ledger", {}).get("files") == {}
            and set(value.get("ledger", {}).get("directories", [])) <= {"."},
            "Initial pre-owner group ledger is no longer empty")
    store = value.get("store", {})
    require(set(store.get("files", {})) <= STORE_FILES
            and set(store.get("directories", [])) <= STORE_DIRS,
            "Session store contains a run, lease, or unknown content")


def transaction_payload(attempt, records, original_receipt, proof):
    require(re.fullmatch("[0-9a-f]{32}", attempt) is not None, "Invalid verification attempt")
    root = "verification/attempts/" + attempt
    final = {**original_receipt, "state":"failed-confirmed", "verification_outcome":"interrupted",
             "runtime_qualification":"NOT VERIFIED", "build_data_qualification":"NOT VERIFIED",
             "exit_code":None, "finished_at":proof["finished_at"],
             "error":"Source verification interrupted by external Docker host stop; result unavailable",
             "reconciliation":{"schema":SCHEMA, "proof_sha256":sha(canonical(proof)),
                               "native_drain":False, "solve_replayed":False}}
    raw = canonical(final) + b"\n"
    pins = {name:None if data is None else sha(data) for name,data in records.items()}
    pins.setdefault(root + "/terminal.json", None)
    archived = {name:base64.b64encode(data).decode() for name,data in records.items()
                if data is not None and (name.startswith(root + "/") or name in ("verification/current.json","verification/verified.json"))}
    return {"schema":SCHEMA, "attempt":attempt, "pins":pins, "original":archived,
            "final":base64.b64encode(raw).decode(), "proof":proof}


def _read_regular(path):
    path = Path(path)
    for parent in (path.parent, *path.parent.parents):
        if parent.is_symlink():
            raise RuntimeError("Linked control parent")
    if not os.path.lexists(path):
        return None
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 4*1024*1024:
            raise RuntimeError("Control record is not bounded regular data")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            raw = stream.read(4*1024*1024 + 1)
        after = os.fstat(descriptor)
        if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns) != (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns):
            raise RuntimeError("Control record changed while reading")
        return raw
    finally:
        os.close(descriptor)


def _sync_directory(path):
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def _temporary_name(path, raw):
    return ".verification-reconcile-" + hashlib.sha256(Path(path).name.encode()+b"\0"+raw).hexdigest()


def _journal_documents(payload):
    encode=lambda value: json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()
    prefix="verification/attempts/"+payload["attempt"]
    journal=prefix+"/interrupted-reconciliation"
    final=base64.b64decode(payload["final"],validate=True)
    documents={prefix+"/receipt.json":final,prefix+"/terminal.json":final,"verification/current.json":final,
               journal+"/payload.json":encode(payload)+b"\n",
               journal+"/intent.json":encode({"schema":payload["schema"],"attempt":payload["attempt"],
                   "plan_sha256":hashlib.sha256(encode(payload)).hexdigest()})+b"\n"}
    for name,encoded in payload["original"].items():
        if name.startswith(prefix+"/"):destination=name[len(prefix)+1:]
        elif name=="verification/current.json":destination="previous-current.json"
        elif name=="verification/verified.json":destination="previous-verified.json"
        else:raise RuntimeError("Unexpected archive record")
        documents[journal+"/original/"+destination]=base64.b64decode(encoded,validate=True)
    return documents


def validate_journal(payload, observed):
    """Internal files are retained data; only exact payload documents are authoritative."""
    prefix="verification/attempts/"+payload["attempt"]+"/interrupted-reconciliation/"
    documents=_journal_documents(payload)
    files={name[len(prefix):]:raw for name,raw in documents.items() if name.startswith(prefix)}
    temporaries={_temporary_name(name,raw):raw for name,raw in documents.items()}
    allowed_dirs={".","original","temporary"}
    if (not isinstance(observed,dict) or not set(observed.get("directories",[]))<=allowed_dirs
            or not isinstance(observed.get("files"),dict) or len(observed["files"])>64):
        raise RuntimeError("Unknown or unbounded reconciliation journal")
    for name,encoded in observed["files"].items():
        raw=base64.b64decode(encoded,validate=True)
        if len(raw)>4*1024*1024:raise RuntimeError("Internal journal artifact exceeds its bound")
        if name in files:
            if raw!=files[name]:raise RuntimeError("Journal document differs from the pinned plan")
        elif name.startswith("temporary/"):
            temporary=name[len("temporary/"):]
            if temporary in temporaries:
                if len(raw)>len(temporaries[temporary]):raise RuntimeError("Internal partial temp exceeds its target")
            elif re.fullmatch(r"retained-[0-9a-f]{64}",temporary):
                if hashlib.sha256(raw).hexdigest()!=temporary[len("retained-"):]:
                    raise RuntimeError("Retained partial temp hash differs")
            else:raise RuntimeError("Unknown internal temporary artifact")
        else:raise RuntimeError("Unknown reconciliation journal file")


def _publish(path, raw, immutable, temporary_root):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.parent.resolve() != path.parent or path.is_symlink():
        raise RuntimeError("Noncanonical transaction destination")
    existing = _read_regular(path)
    if immutable and existing is not None:
        if existing != raw: raise RuntimeError("Immutable reconciliation evidence differs")
        return
    temporary_root=Path(temporary_root)
    temporary_root.mkdir(parents=True,exist_ok=True)
    if temporary_root.resolve()!=temporary_root:raise RuntimeError("Noncanonical internal temporary directory")
    temporary=temporary_root/_temporary_name(path,raw)
    retained=_read_regular(temporary)
    if retained is not None and retained!=raw:
        if len(retained)>len(raw):raise RuntimeError("Internal partial temp exceeds its target")
        history=temporary_root/("retained-"+hashlib.sha256(retained).hexdigest())
        previous=_read_regular(history)
        if previous is not None and previous!=retained:raise RuntimeError("Retained partial temp differs")
        os.replace(temporary,history)
        _sync_directory(temporary_root)
        retained=None
    if retained is None:
        descriptor=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o640)
        with os.fdopen(descriptor,"wb") as stream:
            stream.write(raw);stream.flush();os.fsync(stream.fileno())
    # operation.lock serializes publishers; repeat the immutable CAS before rename.
    if immutable and _read_regular(path)!=existing:raise RuntimeError("Immutable publication CAS changed")
    os.replace(temporary,path)
    _sync_directory(path.parent)
    if temporary_root!=path.parent:_sync_directory(temporary_root)


def commit_locked(root, payload, revalidate, checkpoint=lambda stage:None):
    """Caller holds the existing operation.lock; every write is CAS fenced."""
    root = Path(root).resolve()
    if payload.get("schema") != "fullmag.interrupted-preowner-verification-reconciliation.v1":
        raise RuntimeError("Unexpected transaction schema")
    attempt = payload["attempt"]
    if re.fullmatch("[0-9a-f]{32}", attempt) is None: raise RuntimeError("Invalid transaction attempt")
    prefix = "verification/attempts/" + attempt
    journal = prefix + "/interrupted-reconciliation"
    temporary_root = root/(journal+"/temporary")
    final = base64.b64decode(payload["final"], validate=True)
    intent = (json.dumps({"schema":payload["schema"], "attempt":attempt,
                         "plan_sha256":hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()},
                        sort_keys=True,separators=(",",":")) + "\n").encode()
    mutable = {prefix+"/receipt.json","verification/current.json",prefix+"/terminal.json"}
    def verify():
        for name, expected in payload["pins"].items():
            if Path(name).is_absolute() or ".." in Path(name).parts: raise RuntimeError("Escaping transaction pin")
            raw = _read_regular(root/name)
            actual = None if raw is None else hashlib.sha256(raw).hexdigest()
            if actual != expected and not (name in mutable and raw == final):
                raise RuntimeError("Control CAS differs: " + name)
        current_active = _read_regular(root/"active")
        if current_active is not None and current_active != (attempt+"\n").encode():
            raise RuntimeError("Active marker belongs to another operation")
        if current_active is None:
            if any(_read_regular(root/name) != final for name in mutable):
                raise RuntimeError("Active disappeared before completion")
            if _read_regular(root/(journal+"/intent.json")) != intent:
                raise RuntimeError("Missing completed reconciliation intent")
        revalidate()
    # The active pin must permit only this transaction's completed absence.
    active_pin = payload["pins"].get("active")
    original_pins = payload["pins"]
    payload = {**payload,"pins":{name:value for name,value in original_pins.items() if name!="active"}}
    try:
        if active_pin != hashlib.sha256((attempt+"\n").encode()).hexdigest():
            raise RuntimeError("Transaction does not pin its exact active token")
        verify()
        full_payload = {**payload,"pins":original_pins}
        _publish(root/(journal+"/payload.json"),
                 (json.dumps(full_payload,sort_keys=True,separators=(",",":"),ensure_ascii=False)+"\n").encode(), True, temporary_root)
        _publish(root/(journal+"/intent.json"), intent, True, temporary_root)
        for name, encoded in payload["original"].items():
            if name.startswith(prefix+"/"):
                destination = name[len(prefix)+1:]
            elif name == "verification/current.json": destination = "previous-current.json"
            elif name == "verification/verified.json": destination = "previous-verified.json"
            else: raise RuntimeError("Unexpected archive record")
            _publish(root/(journal+"/original/"+destination), base64.b64decode(encoded,validate=True), True, temporary_root)
        verify()
        _publish(root/(prefix+"/terminal.json"), final, True, temporary_root)
        _publish(root/(prefix+"/receipt.json"), final, False, temporary_root)
        checkpoint("receipt-published")
        _publish(root/"verification/current.json", final, False, temporary_root)
        verify()
        active = root/"active"
        if active.exists(): active.unlink();_sync_directory(root)
        verify()
    finally:
        pass

SNAPSHOT_CODE = r'''
import base64,hashlib,json,os,pathlib,stat,sys
sys.path.insert(0,"/opt/fullmag")
import runtime_service as runtime
P=pathlib.Path
def read(path):
    path=P(path)
    for parent in (path.parent,*path.parent.parents):
        if parent.is_symlink():raise RuntimeError("Linked observation parent")
    if not os.path.lexists(path):return None
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size>4*1024*1024:
            raise RuntimeError("Unbounded or linked observation")
        with os.fdopen(fd,"rb",closefd=False) as stream:raw=stream.read(4*1024*1024+1)
        after=os.fstat(fd)
        if (before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns):
            raise RuntimeError("Observation changed")
        return raw
    finally:os.close(fd)
def tree(root,raw=False):
    root=P(root);files={};directories=[]
    if not root.is_dir() or root.is_symlink():raise RuntimeError("Missing canonical observation root")
    for parent,dirs,names in os.walk(root,followlinks=False):
        rel=P(parent).relative_to(root).as_posix();directories.append(rel)
        if len(directories)>64 or any((P(parent)/name).is_symlink() for name in dirs):
            raise RuntimeError("Unbounded or linked directory")
        for name in names:
            path=P(parent)/name;data=read(path);key=path.relative_to(root).as_posix()
            if data is None:raise RuntimeError("Observation disappeared")
            files[key]=base64.b64encode(data).decode() if raw else hashlib.sha256(data).hexdigest()
            if len(files)>64:raise RuntimeError("Too many observation files")
    return {"directories":sorted(directories),"files":files}
def snapshot(paths,attempt):
    control={}
    for relative in paths:
        value=read("/control/"+relative)
        control[relative]=None if value is None else base64.b64encode(value).decode()
    namespace=tree("/control/runtime-control",True)
    runtime_files={"runtime-control/"+name:hashlib.sha256(base64.b64decode(raw)).hexdigest()
                   for name,raw in namespace["files"].items()}
    for name,raw in namespace["files"].items():control["runtime-control/"+name]=raw
    owner=read("/store/WRITER.owner.json")
    if owner is not None and json.loads(owner).get("released") is not True:
        raise RuntimeError("Session store writer is not released")
    ledger=P(runtime.HOST_LEDGER_ROOT)
    if ledger!=P("/host-ledger/ledger"):raise RuntimeError("Noncanonical group ledger root")
    journal_root=P("/control/verification/attempts")/attempt/"interrupted-reconciliation"
    journal=tree(journal_root,True) if os.path.lexists(journal_root) else {"directories":[],"files":{}}
    return {"journal":journal,"boot_id":P("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "control":control,"runtime":runtime_files,"ledger":tree(ledger),
            "store":tree("/store")}
'''

def _snapshot_command(paths):
    attempts={path.split("/")[2] for path in paths if path.startswith("verification/attempts/")}
    require(len(attempts)==1,"Observation must pin one verification attempt")
    return "/usr/local/bin/python3 -B -c " + shlex.quote(
        SNAPSHOT_CODE + "\nprint(json.dumps(snapshot(json.loads(sys.argv[1]),sys.argv[2]),sort_keys=True))") + " " + shlex.quote(json.dumps(paths)) + " " + shlex.quote(attempts.pop())


def _probe_args(control, image, command, store_root, name=None, readonly=True):
    probe = copy.copy(control)
    probe.image = image
    args = probe.helper_args(command, name=name)
    if readonly:
        for index,value in enumerate(args):
            if value.startswith("type=volume,src="+control.volume+",dst=/control,"):
                args[index] = value + ",readonly"
    index = args.index("--entrypoint")
    args[index:index] = ["--mount", "type=bind,src="+str(store_root)+",dst=/store,readonly",
        "--mount", "type=volume,src=" + control.volume + ",dst=/host-ledger,readonly,volume-nocopy,volume-subpath=private/ledger"]
    # Source observation and the 350 KiB interrupted receipt need Python headroom.
    args[args.index("--memory")+1] = "128m"
    return probe, args


def _snapshot(control, image, store_root, paths):
    probe,args = _probe_args(control,image,_snapshot_command(paths),store_root)
    result = bounded_capture(args,
                             data=b"",timeout=45,maximum=16*1024*1024)
    require(result.returncode == 0, "Read-only stopped namespace observation failed: " + result.stderr.decode("utf8","replace")[-1024:])
    value = json.loads(result.stdout)
    validate_empty_namespace(value)
    return value


def _consumers(control, expected, allowed_helper=None):
    ids = set(docker_capture("ps","--all","--quiet","--no-trunc","--filter","volume="+control.volume).stdout.decode().split())
    ids.update(docker_capture("ps","--all","--quiet","--no-trunc","--filter",
                              "label=com.docker.compose.project="+control.project).stdout.decode().split())
    ids = sorted(ids)
    require(ids == sorted([*expected, *([allowed_helper] if allowed_helper else [])]),
            "Private group volume has a new or missing consumer")
    return ids


def validate_attempt_artifacts(entries, prepared=False):
    names=[]
    for line in entries:
        name,kind=line.rsplit(" ",1)
        if kind=="d" and name=="interrupted-reconciliation":
            continue
        require(kind=="f" and name in ("receipt.json","build.log","stdout.log","stderr.log","terminal.json")
                and (name!="terminal.json" or prepared),
                "Unknown verification artifact; all data retained")
        names.append(name)
    return names


def observe(args, *, allowed_helper=None):
    import fullmag_storage as storage
    from docker_compose_identity import compose_project_identity
    from docker_dev_up import _control_volume_exists
    from docker_volume_activation_reconcile import _probe_helper_absence
    from datetime import datetime
    source = args.source_root.resolve(strict=True)
    layout = storage.resolve_layout(source,"docker-all-gpu")
    identity = compose_project_identity(layout)
    configured = toolchain_configuration(source,identity)
    helper_image = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    control = BuildControl(identity,helper_image)
    require(control.namespace == "" and _control_volume_exists(control), "Initial verification requires its existing root control volume")
    engine = docker_capture("info","--format","{{.ID}}").stdout.decode().strip()
    require(engine == args.engine_id, "Docker engine identity differs")
    root = "verification/attempts/" + args.attempt
    paths = ["active",root+"/receipt.json",root+"/terminal.json",
             "verification/current.json","verification/verified.json",
             "development/current.json",
             "development/attempts/"+args.development_attempt+"/terminal.json",
             "development/attempts/"+args.development_attempt+"/compose.json",
             *ABSENT]
    original = _control_raw(control,root+"/receipt.json")
    prepared = None
    prepared_raw = _control_raw(control,root+"/interrupted-reconciliation/payload.json",optional=True)
    if prepared_raw is not None:
        prepared = json.loads(prepared_raw)
        require(args.apply and sha(canonical(prepared)) == args.expected_plan_sha256,
                "Partial reconciliation requires its exact prepared plan digest")
        original = base64.b64decode(prepared["original"][root+"/receipt.json"],validate=True)
    require(sha(original) == args.receipt_sha256, "Interrupted verification receipt CAS differs")
    receipt = json.loads(original)
    validate_receipt(receipt,args.attempt,control.project,control.volume)
    previous_raw = _control_raw(control,"development/attempts/"+args.development_attempt+"/terminal.json")
    require(sha(previous_raw) == args.development_terminal_sha256, "Development terminal CAS differs")
    previous = json.loads(previous_raw)
    inputs = previous.get("inputs",{})
    require(previous.get("schema") == "fullmag.docker-build-operation.v1"
            and previous.get("phase") == "development" and previous.get("state") == "failed-confirmed"
            and previous.get("attempt") == args.development_attempt
            and previous.get("compose_project") == control.project and previous.get("control_volume") == control.volume
            and previous.get("ledger_profile") == "group-ledger-v1"
            and previous.get("private_group_storage") == "group-volume-v1"
            and inputs.get("source_root") == str(source)
            and inputs.get("source_worktree_id") == identity["worktree_id"]
            and inputs.get("source_project_id") == identity["project_id"],
            "Original development/source/group identity differs")
    validate_reason(previous.get("error","").removeprefix("Runtime startup failed; diagnostic API retained: "))
    document = json.loads(_control_raw(control,"development/attempts/"+args.development_attempt+"/compose.json"))
    require(document.get("name") == control.project and sha(canonical(document)) == args.compose_sha256
            and previous.get("config_sha256") == args.compose_sha256, "Compose CAS differs")
    environment = document["services"]["backend"]["environment"]
    validate_startup_intent(environment)
    image = inputs["image_id"]
    actual = {}
    for service in ("backend","frontend"):
        identifier = previous[service+"_container"]
        rows = json.loads(docker_capture("inspect",identifier).stdout)
        require(len(rows)==1, "Retained service observation is ambiguous")
        value=rows[0]
        validate_stopped(value,identifier,image,previous[service+"_started_at"],control.project,identity["worktree_id"])
        require(value.get("HostConfig",{}).get("RestartPolicy",{}).get("Name") == "no", "Automatic service restart remains enabled")
        from docker_volume_dev import _validate_retained_service
        image_config=json.loads(docker_capture("image","inspect",image).stdout)[0]["Config"]
        _validate_retained_service(document,value,service,image_config)
        actual[service]=value
    require(receipt.get("container_id") == actual["backend"]["Id"][:12]
            and receipt.get("image_id") == image, "Verification backend/image differs from original development")
    consumers = _consumers(control,[value["Id"] for value in actual.values()],allowed_helper)
    helper_absence = _probe_helper_absence("fullmag-control-"+args.attempt)
    state = storage.validate_path(Path(previous["state_root"]),layout["runtime_root"],"retained runtime state")
    store_root = state/"runs/docker-all/session-store"
    # The attempt may contain only these logs. The guest checks this inventory again under lock.
    inventory_command = "find " + shlex.quote(control.path(root)) + " -maxdepth 1 -mindepth 1 -printf '%f %y\\n'"
    found=bounded_capture(_read_only_control_args(control,inventory_command),data=b"",timeout=30,maximum=8192)
    require(found.returncode==0,"Cannot inventory interrupted verification artifacts")
    artifacts={}
    for name in validate_attempt_artifacts(found.stdout.decode().splitlines(),prepared is not None):
        paths.append(root+"/"+name)
    paths=sorted(set(paths))
    guest = _snapshot(control,image,store_root,paths)
    require(guest["boot_id"] == args.boot_id and guest["boot_id"] != previous.get("worker_cgroup",{}).get("boot_id"),
            "External host stop is not tied to a new pinned boot incarnation")
    records={name:None if encoded is None else base64.b64decode(encoded,validate=True)
             for name,encoded in guest["control"].items()}
    if prepared is not None:
        final=base64.b64decode(prepared["final"],validate=True)
        for name,encoded in prepared["original"].items():
            expected=base64.b64decode(encoded,validate=True)
            require(records.get(name)==expected or (name in (root+"/receipt.json","verification/current.json") and records.get(name)==final),
                    "Partially reconciled record differs")
            records[name]=expected
        require(records.get(root+"/terminal.json") in (None,final),"Partial terminal differs")
        records[root+"/terminal.json"]=None
        require(records.get("active") in (None,(args.attempt+"\n").encode()),"Partial active differs")
        records["active"]=(args.attempt+"\n").encode()
    require(records["active"] == (args.attempt+"\n").encode() and sha(records["active"]) == args.active_sha256,
            "Active verification marker CAS differs")
    require(records[root+"/receipt.json"] == original and records[root+"/terminal.json"] is None,
            "Verification receipt/terminal changed during observation")
    current=json.loads(records["development/current.json"])
    require(current.get("attempt")==args.development_attempt and current.get("state")=="failed-confirmed",
            "Development current attempt changed")
    fences=[name for name in records if re.fullmatch(r"runtime-control/runtime-service/api-failure-[0-9a-f]{32}\.json",name)]
    require(len(fences)==1,"Initial namespace has an ambiguous failure fence")
    fence=records[fences[0]]
    failure=json.loads(fence)
    require(failure.get("schema")=="fullmag.api-runtime-failure-fence.v1" and failure.get("stage")=="runtime_startup"
            and "api_pid" not in failure and "api_instance_id" not in failure,
            "Failure fence contains post-owner or unknown runtime authority")
    validate_reason(failure.get("reason"))
    require(sha(fence)==receipt["diagnostic_source_admission"]["fence_sha256"],"Original diagnostic fence changed")
    proof={"schema":SCHEMA,"attempt":args.attempt,"source_root":str(source),"source_identity":identity,
           "compose_project":control.project,"control_volume":control.volume,
           "engine_id":engine,"boot_id":guest["boot_id"],"receipt_sha256":args.receipt_sha256,
           "active_sha256":args.active_sha256,"development_attempt":args.development_attempt,
           "development_terminal_sha256":args.development_terminal_sha256,"compose_sha256":args.compose_sha256,
           "containers":{name:{"id":value["Id"],"image":value["Image"],"fingerprint":fingerprint(value),
                  "state":value["State"]} for name,value in actual.items()},
           "consumers":sorted(value["Id"] for value in actual.values()),
           "original_helper_absence_sha256":helper_absence,
           "runtime":guest["runtime"],"ledger":guest["ledger"],"store":guest["store"],
           "finished_at":max(datetime.fromisoformat(value["State"]["FinishedAt"].replace("Z","+00:00")).timestamp() for value in actual.values()),
           "controller_sha256":sha(Path(__file__).read_bytes())}
    payload=transaction_payload(args.attempt,records,receipt,proof)
    validate_journal(payload,guest["journal"])
    if prepared is not None:
        require(payload == prepared,"Partial reconciliation plan no longer matches observations")
    return {"control":control,"image":image,"store_root":store_root,"payload":payload,"paths":paths,"guest":guest}

def _guest_code(plan_sha256):
    functions = "\n\n".join(inspect.getsource(value) for value in
                             (_read_regular,_sync_directory,_temporary_name,_journal_documents,validate_journal,_publish,commit_locked))
    return ("import base64,hashlib,json,os,pathlib,re,stat,sys,uuid,fcntl\nfrom pathlib import Path\n"
            + SNAPSHOT_CODE + "\n" + functions + """
payload=json.loads(sys.stdin.buffer.readline(4*1024*1024+1))
encoded=json.dumps(payload,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()
if hashlib.sha256(encoded).hexdigest()!=PLAN_SHA:raise RuntimeError("Prepared plan CAS differs")
lock=Path("/control/operation.lock")
raw=_read_regular(lock)
if raw is None:raise RuntimeError("Existing operation lock is absent")
descriptor=os.open(lock,os.O_RDONLY|os.O_NOFOLLOW)
fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
if os.fstat(descriptor).st_ino!=lock.stat().st_ino:raise RuntimeError("Operation lock inode changed")
store_lock=os.open("/store/WRITER.lock",os.O_RDONLY|os.O_NOFOLLOW)
if not stat.S_ISREG(os.fstat(store_lock).st_mode):raise RuntimeError("Store lock is not regular")
fcntl.flock(store_lock,fcntl.LOCK_SH|fcntl.LOCK_NB)
def revalidate():
    value=snapshot([],payload["attempt"])
    validate_journal(payload,value["journal"])
    for key in ("boot_id","runtime","ledger","store"):
        if value[key]!=payload["proof"][key]:raise RuntimeError("Stopped namespace changed: "+key)
    root=Path("/control/verification/attempts")/payload["attempt"]
    names={p.name for p in root.iterdir()}
    allowed={"receipt.json","terminal.json","build.log","stdout.log","stderr.log","interrupted-reconciliation"}
    if not names<=allowed:raise RuntimeError("New verification artifact appeared")
revalidate()
print("LOCKED",flush=True)
if sys.stdin.buffer.readline(16)!=b"COMMIT\\n":raise RuntimeError("Host did not revalidate Docker state")
commit_locked(Path("/control"),payload,revalidate)
print("COMPLETED",flush=True)
""").replace("PLAN_SHA", repr(plan_sha256))


def _validate_helper(control, name, command, store_root):
    from docker_compose_identity import source_labels
    from run_managed_browser import host_path
    rows=json.loads(docker_capture("inspect",name).stdout)
    require(len(rows)==1,"Recovery helper identity is ambiguous")
    value=rows[0];config=value.get("Config",{});host=value.get("HostConfig",{});state=value.get("State",{})
    expected={**control.labels,**source_labels(control.identity),"com.docker.compose.project":control.project,
              "com.docker.compose.service":"build-control"}
    labels=config.get("Labels",{})
    require(value.get("Name")=="/"+name and value.get("Image")==control.image
            and config.get("Image")==control.image and config.get("User")=="65532:65532"
            and config.get("Entrypoint")==["/bin/bash"]
            and config.get("Cmd")==["-euo","pipefail","-c",command]
            and all(labels.get(key)==val for key,val in expected.items())
            and state.get("Running") is True and type(state.get("Pid")) is int and state["Pid"]>0
            and host.get("NetworkMode")=="none" and host.get("ReadonlyRootfs") is True
            and host.get("Privileged") is False and "ALL" in (host.get("CapDrop") or [])
            and not host.get("Binds") and not host.get("Tmpfs"), "Recovery helper isolation differs")
    mounts=host.get("Mounts",[])
    require(len(mounts)==3,"Recovery helper mount set differs")
    expected_mounts={"/control":("volume",control.volume,False,""),
                     "/store":("bind",str(store_root),True,""),
                     "/host-ledger":("volume",control.volume,True,"private/ledger")}
    for mount in mounts:
        target=mount.get("Target");expected_mount=expected_mounts.pop(target,None)
        require(expected_mount is not None,"Unexpected recovery helper mount")
        kind,source,readonly,subpath=expected_mount
        actual_source=mount.get("Source")
        if kind=="bind":
            source_matches=isinstance(actual_source,str) and host_path(actual_source)==host_path(source)
        else:source_matches=actual_source==source
        options=mount.get("VolumeOptions",{})
        require(mount.get("Type")==kind and source_matches
                and bool(mount.get("ReadOnly",False)) is readonly
                and (kind!="volume" or options.get("NoCopy") is True and options.get("Subpath","")==subpath),
                "Recovery helper mount identity/mode differs")
    require(not expected_mounts,"Recovery helper mount is missing")
    return value["Id"]


def run(args):
    validate_options(args)
    context=observe(args)
    payload=context["payload"]
    plan_sha256=sha(canonical(payload))
    summary={"schema":SCHEMA,"state":"preview","plan_sha256":plan_sha256,"proof":payload["proof"],
             "preserved_records":payload["pins"],"result":"interrupted / failed-confirmed / NOT VERIFIED",
             "native_drain":False,"solve_replayed":False,"services_started":False}
    if not args.apply:
        print(json.dumps(summary,indent=2,sort_keys=True));return summary
    require(args.expected_plan_sha256==plan_sha256,"Apply requires the unchanged preview plan digest")
    control=context["control"]
    command="/usr/local/bin/python3 -B -c "+shlex.quote(_guest_code(plan_sha256))
    name="fullmag-verification-reconcile-"+uuid.uuid4().hex
    probe,arguments=_probe_args(control,context["image"],command,context["store_root"],name=name,readonly=False)
    process=subprocess.Popen(arguments,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        process.stdin.write(canonical(payload)+b"\n");process.stdin.flush()
        require(_line(process,timeout=60)=="LOCKED","Recovery helper did not acquire the existing operation lock")
        helper_id=_validate_helper(probe,name,command,context["store_root"])
        fresh=observe(args,allowed_helper=helper_id)
        require(fresh["payload"]==payload,"Pinned Docker/control observations changed under recovery lock")
        _validate_helper(probe,name,command,context["store_root"])
        process.stdin.write(b"COMMIT\n");process.stdin.flush()
        require(_line(process,timeout=60)=="COMPLETED","Recovery commit acknowledgement is unknown; records retained")
        process.stdin.close()
        code=process.wait(timeout=30)
        require(code==0,"Recovery helper exit is not confirmed")
    except BaseException:
        if process.stdin and not process.stdin.closed:process.stdin.close()
        # No stop/kill/remove of a helper whose commit outcome is unknown.
        raise
    summary.update(state="failed-confirmed",active_released=True,
                   terminal="verification/attempts/"+args.attempt+"/terminal.json")
    print(json.dumps(summary,indent=2,sort_keys=True))
    return summary


def validate_options(args):
    for key in ("attempt","development_attempt"):
        require(re.fullmatch("[0-9a-f]{32}",getattr(args,key,"")) is not None,"Invalid "+key)
    for key in ("receipt_sha256","active_sha256","development_terminal_sha256","compose_sha256"):
        require(re.fullmatch("[0-9a-f]{64}",getattr(args,key,"")) is not None,"Invalid "+key)
    for key in ("engine_id","boot_id"):
        value=getattr(args,key,"")
        require(str(uuid.UUID(value))==value,"Invalid "+key)
    require(bool(args.apply)==bool(args.expected_plan_sha256),"Apply requires exactly one preview plan digest")
    if args.expected_plan_sha256:
        require(re.fullmatch("[0-9a-f]{64}",args.expected_plan_sha256) is not None,"Invalid prepared plan digest")


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root",type=Path,required=True)
    for name in ("attempt","receipt-sha256","active-sha256","development-attempt",
                 "development-terminal-sha256","compose-sha256","engine-id","boot-id"):
        parser.add_argument("--"+name,required=True)
    parser.add_argument("--apply",action="store_true")
    parser.add_argument("--expected-plan-sha256")
    run(parser.parse_args())


if __name__=="__main__":
    main()
