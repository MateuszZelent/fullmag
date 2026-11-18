"""Explicit stop and offline preservation of one empty, ownerless API abort.

No owner is invented and no drain is claimed. The only lifecycle action is
Docker stop of the exact pair admitted by the preview plan.
"""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import re
import shlex

from docker_build_control import BuildControlError, canonical

PHASE = "stop-empty-api-abort"
SCHEMA = "fullmag.empty-api-abort-stop-plan.v1"
PROBE_SCHEMA = "fullmag.empty-api-abort-probe.v1"
MAXIMUM = 8 * 1024 * 1024
PROCESS_RELATIVE = "runtime-control/runtime-service/process-tree.json"
SHUTDOWN_ERROR = "no pinned runtime service owner was available for authenticated drain"
ERROR_PREFIX = "API binding did not become ready: "
SHA = re.compile(r"[0-9a-f]{64}\Z")
TOKEN = re.compile(r"[0-9a-f]{32}\Z")


def require(value, message):
    if not value:
        raise BuildControlError("Empty API abort: " + message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def decode(raw):
    require(isinstance(raw, bytes) and len(raw) <= MAXIMUM, "record exceeds byte bound")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate JSON key")
            result[key] = value
        return result
    try:
        result = json.loads(raw, object_pairs_hook=unique)
    except (ValueError, UnicodeDecodeError) as error:
        raise BuildControlError("Empty API abort: invalid JSON") from error
    require(isinstance(result, dict), "record is not an object")
    return result


def process_contract(process, *, stopped=False):
    require(process.get("schema") == "fullmag.docker-process-tree.v1"
            and process.get("state") == ("shutdown_unknown" if stopped else "failed_outcome_retained")
            and type(process.get("api_pid")) is int and process["api_pid"] > 1
            and type(process.get("api_exit_code")) is int and process["api_exit_code"] == -6
            and process.get("api_diagnostic_only") is False
            and process.get("accepted_store") == "/state/runs/docker-all/session-store"
            and isinstance(process.get("bootstrap"), dict)
            and isinstance(process.get("error"), str) and process["error"].startswith(ERROR_PREFIX),
            "not the exact pre-owner API abort")
    bootstrap = process["bootstrap"]
    require(set(bootstrap) == {"schema", "store_root", "binding", "created"}
            and bootstrap.get("schema") == "fullmag.docker-accepted-store-bootstrap.v1"
            and bootstrap.get("store_root") == process["accepted_store"] and bootstrap.get("created") is True
            # Rust joins an empty missing suffix, preserving the trailing separator.
            and bootstrap.get("binding") == sha(b"fullmag.accepted-store-binding.v1\0" +
                                                (process["accepted_store"] + "/").encode()),
            "bootstrap schema/created/store binding differs")
    forbidden = {"runtime_pid", "service_owner", "terminal_service_owner", "startup_activation", "startup",
                 "accepted_reattach", "terminal_observation", "runtime_recovery", "container_recovery",
                 "container_recovery_authorization", "owner_pin", "owner_pin_candidate", "owner_pin_state"}
    require(not forbidden.intersection(process), "runtime/owner/activation authority exists")
    require((process.get("shutdown_error") == SHUTDOWN_ERROR) if stopped else "shutdown_error" not in process,
            "ownerless shutdown shape differs")


def service_pin(actual):
    state = actual.get("State", {})
    require(isinstance(actual.get("Id"), str) and SHA.fullmatch(actual["Id"])
            and isinstance(actual.get("Image"), str) and re.fullmatch(r"sha256:[0-9a-f]{64}", actual["Image"])
            and isinstance(state.get("StartedAt"), str) and bool(state["StartedAt"]), "service identity is incomplete")
    return {**{key: actual.get(key) for key in ("Id", "Image", "Config", "HostConfig", "Mounts")},
            "StartedAt": state["StartedAt"]}


def validate_guest(guest, image, *, stopped=False):
    require(guest.get("schema") == PROBE_SCHEMA, "guest schema differs")
    try:
        process_raw = base64.b64decode(guest.get("process_raw", ""), validate=True)
    except (ValueError, TypeError) as error:
        raise BuildControlError("Empty API abort: invalid process bytes") from error
    process = decode(process_raw)
    process_contract(process, stopped=stopped)
    require(sha(process_raw) == guest.get("process_sha256"), "process raw SHA differs")
    store_services = guest.get("store_runtime_services", {})
    require(guest.get("runtime_services_entries") == [] and guest.get("runs_entries") == []
            and store_services.get("state") in {"absent", "empty"} and store_services.get("entries") == [],
            "runtime owner/history or accepted runs exist")
    config = guest.get("config", {})
    require(config.get("schema_version") == "runtime_service_config.v2" and config.get("target_id") == "docker-all"
            and config.get("store_root") == "/state/runs/docker-all/session-store"
            and config.get("host_execution", {}).get("ledger_root") == "/host-ledger/ledger", "native configuration differs")
    package, provenance = guest.get("package", {}), guest.get("provenance", {})
    require(package.get("schema") == "fullmag.direct-compose.backend-build-receipt.v1"
            and package.get("state") == "succeeded" and isinstance(package.get("source"), dict)
            and provenance.get("schema") == "fullmag.docker-all-image.v1"
            and provenance.get("state") == "succeeded" and provenance.get("image_id") == image
            and provenance.get("build_receipt_sha256") == guest.get("package_sha256"),
            "package/provenance is not a coherent successful publication")
    for key in ("config_sha256", "package_sha256", "provenance_sha256"):
        require(isinstance(guest.get(key), str) and SHA.fullmatch(guest[key]), "invalid publication digest")
    if not stopped:
        rows = guest.get("process_pins")
        require(guest.get("api_pid_absent") is True and guest.get("api_port_closed") is True
                and isinstance(rows, list) and len(rows) == 2 and {row.get("role") for row in rows} == {"init", "supervisor"}
                and len({row.get("pid") for row in rows}) == 2 and all(
                    type(row.get("pid")) is int and row["pid"] > 0
                    and type(row.get("start_ticks")) is int and row["start_ticks"] > 0 for row in rows),
                "API/native/compiler process absence is unconfirmed")
    released = guest.get("released", {})
    require(released.get("schema") == "fullmag.pre-ack-released-observation.v1"
            and type(released.get("active_count")) is int and released["active_count"] == 0
            and released.get("leases") == [] and isinstance(released.get("reservations"), list)
            and all(isinstance(row, list) and len(row) == 3 and isinstance(row[0], dict)
                    and all(isinstance(value, str) and SHA.fullmatch(value) for value in row[1:])
                    for row in released["reservations"]),
            "active or unknown leases/reservations remain")
    require(guest.get("activation_active") is False, "activation may be active")
    return process


def invariant_binding(guest):
    return {key: guest.get(key) for key in ("config_sha256", "package_sha256", "provenance_sha256",
        "runtime_services_entries", "store_runtime_services", "runs_entries", "released", "activation_active")}


def validate_transition(before, after, image):
    original = validate_guest(before, image)
    terminal = validate_guest(after, image, stopped=True)
    expected = dict(original, state="shutdown_unknown", shutdown_error=SHUTDOWN_ERROR)
    require(terminal == expected and invariant_binding(before) == invariant_binding(after),
            "stop changed empty namespace/publication or fabricated a drain")


PROBE = r'''import base64,hashlib,json,os,pathlib,socket,stat,sys
mode=sys.argv[1]
if mode not in ("live","offline"): raise RuntimeError("invalid fixed probe mode")
control=pathlib.Path("/opt/fullmag/runtime-control") if mode=="live" else pathlib.Path("/control/runtime-control")
backend=pathlib.Path("/opt/fullmag/control/backend") if mode=="live" else pathlib.Path("/control/backend")
store=pathlib.Path("/state/runs/docker-all/session-store")
MAX=8*1024*1024
def regular(path):
 p=pathlib.Path(path)
 if not p.is_absolute() or any(x.is_symlink() for x in (p,*p.parents)):
  raise RuntimeError("probe path traverses symlink")
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  before=os.fstat(fd)
  if not stat.S_ISREG(before.st_mode) or before.st_size>MAX: raise RuntimeError("unbounded/nonregular evidence")
  with os.fdopen(os.dup(fd),"rb") as source: raw=source.read(MAX+1)
  after=os.fstat(fd)
  if len(raw)!=before.st_size or (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):
   raise RuntimeError("evidence changed during bounded read")
  return raw
 finally: os.close(fd)
def unique(pairs):
 result={}
 for key,value in pairs:
  if key in result: raise RuntimeError("duplicate JSON key")
  result[key]=value
 return result
def doc(path):
 raw=regular(path)
 value=json.loads(raw,object_pairs_hook=unique)
 if not isinstance(value,dict): raise RuntimeError("evidence is not an object")
 return raw,value
def entries(path):
 p=pathlib.Path(path)
 if any(x.is_symlink() for x in (p,*p.parents)) or not p.is_dir(): raise RuntimeError("invalid namespace directory")
 with os.scandir(p) as names:
  result=[]
  for entry in names:
   result.append(entry.name)
   if len(result)>8192: raise RuntimeError("namespace entry bound exceeded")
 return sorted(result)
def optional_services(path):
 p=pathlib.Path(path)
 if any(x.is_symlink() for x in (p,*p.parents)) or not p.parent.is_dir():
  raise RuntimeError("invalid accepted runtime-services parent")
 try: os.lstat(p)
 except FileNotFoundError: return {"state":"absent","entries":[]}
 found=entries(p)
 if found: raise RuntimeError("accepted runtime-services contains owner/history")
 return {"state":"empty","entries":found}
def procs():
 rows=[]
 for p in pathlib.Path("/proc").iterdir():
  if not p.name.isdigit() or int(p.name)==os.getpid(): continue
  try:
   text=(p/"stat").read_text(); fields=text[text.rfind(")")+2:].split()
   argv=(p/"cmdline").read_bytes()
   if len(argv)>4096: raise RuntimeError("unexpected long process command")
   rows.append({"pid":int(p.name),"ppid":int(fields[1]),"start_ticks":int(fields[19]),
    "exe":os.readlink(p/"exe"),"argv":argv})
  except FileNotFoundError: raise RuntimeError("process inventory raced")
  if len(rows)>3: raise RuntimeError("unexpected API/native/compiler process")
 init=[r for r in rows if r["pid"]==1 and pathlib.Path(r["exe"]).name in ("tini","docker-init")]
 supervisor=[r for r in rows if r["ppid"]==1 and pathlib.Path(r["exe"]).name.startswith("python3")
  and b"/opt/fullmag/entrypoint.py" in r["argv"].split(b"\0")]
 if len(rows)!=2 or len(init)!=1 or len(supervisor)!=1 or init[0]["pid"]==supervisor[0]["pid"]:
  raise RuntimeError("namespace is not exact init+supervisor+this bounded probe")
 result=[]
 for role,row in (("init",init[0]),("supervisor",supervisor[0])):
  argv=row.pop("argv"); row["role"]=role; row["argv_sha256"]=hashlib.sha256(argv).hexdigest(); result.append(row)
 return result
pins=procs() if mode=="live" else None
process_raw,process=doc(control/"runtime-service/process-tree.json")
config_raw,config=doc(control/"runtime-service/docker-all.json")
package_raw,package=doc("/opt/fullmag/package/backend-build-receipt.json")
provenance_raw,provenance=doc(backend/"runtime-provenance.json")
runtime_entries=entries(control/"runtime-services"); run_entries=entries(store/"runs")
store_services=optional_services(store/"runtime-services")
if runtime_entries or run_entries: raise RuntimeError("native owner/history or accepted run exists")
result={"schema":"fullmag.empty-api-abort-probe.v1","process_raw":base64.b64encode(process_raw).decode(),
 "process_sha256":hashlib.sha256(process_raw).hexdigest(),"config":config,"config_sha256":hashlib.sha256(config_raw).hexdigest(),
 "package":package,"package_sha256":hashlib.sha256(package_raw).hexdigest(),"provenance":provenance,
 "provenance_sha256":hashlib.sha256(provenance_raw).hexdigest(),"runtime_services_entries":runtime_entries,
 "store_runtime_services":store_services,"runs_entries":run_entries}
if mode=="live":
 api=process.get("api_pid")
 if type(api) is not int or api<=1 or (pathlib.Path("/proc")/str(api)).exists(): raise RuntimeError("aborted API PID is present")
 try:
  with socket.create_connection(("127.0.0.1",8081),timeout=1): raise RuntimeError("API port remains open")
 except ConnectionRefusedError: pass
 if procs()!=pins: raise RuntimeError("namespace processes changed")
 result.update(api_pid_absent=True,api_port_closed=True,process_pins=pins)
if (regular(control/"runtime-service/process-tree.json")!=process_raw
 or regular(control/"runtime-service/docker-all.json")!=config_raw
 or regular("/opt/fullmag/package/backend-build-receipt.json")!=package_raw
 or regular(backend/"runtime-provenance.json")!=provenance_raw
 or entries(control/"runtime-services")!=runtime_entries or entries(store/"runs")!=run_entries
 or optional_services(store/"runtime-services")!=store_services):
 raise RuntimeError("empty abort evidence changed")
print(json.dumps(result,sort_keys=True,separators=(",",":")))
'''


def _read(control, relative, *, optional=False):
    raw = control.read_bytes(relative, optional=optional, maximum=MAXIMUM)
    require(raw is None and optional or isinstance(raw, bytes) and len(raw) <= MAXIMUM, "control read exceeds bound")
    return raw


def _scope(control, args, selected):
    return {"compose_project": control.project, "control_volume": control.volume,
            "control_namespace": control.namespace, "namespace_registry_sha256": control.namespace_registry_sha256,
            "source_root": str(selected), "development_attempt": args.attempt, "config_sha256": args.config_sha256,
            "frontend_port": args.port}


def _development(control, args, selected):
    from docker_volume_stop_diagnostic import _port_matches
    root = "development/attempts/" + args.attempt
    raw = _read(control, root + "/terminal.json")
    previous = decode(raw)
    require(_read(control, "development/current.json") == raw and _read(control, root + "/receipt.json") == raw,
            "development is not the exact current terminal")
    require(previous.get("schema") == "fullmag.docker-build-operation.v1" and previous.get("phase") == "development"
            and previous.get("state") == "failed-confirmed" and previous.get("attempt") == args.attempt
            and previous.get("compose_project") == control.project and previous.get("control_volume") == control.volume
            and previous.get("control_namespace", "") == control.namespace
            and previous.get("namespace_registry_sha256") == control.namespace_registry_sha256
            and previous.get("inputs", {}).get("source_root") == str(selected)
            and previous.get("config_sha256") == args.config_sha256, "failed development scope differs")
    compose_raw = _read(control, root + "/compose.json")
    document = decode(compose_raw)
    require(sha(canonical(document)) == args.config_sha256 and document.get("name") == control.project,
            "Compose/config pin differs")
    _port_matches(document, args.port)
    require(document["services"]["backend"]["environment"].get("FULLMAG_STARTUP_ENABLED") != "1"
            and previous["inputs"].get("script") is None and previous.get("startup") is None,
            "current development startup script is outside ownerless abort scope")
    sidecar = _read(control, root + "/process-failure.json")
    process_contract(decode(sidecar))
    for role in ("backend", "frontend"):
        require(isinstance(previous.get(role + "_started_at"), str) and previous[role + "_started_at"],
                "development does not pin both service incarnations")
    return previous, document, {"development_terminal_sha256": sha(raw), "compose_raw_sha256": sha(compose_raw),
                                "process_failure_sha256": sha(sidecar)}


def _snapshot(control, args, selected, previous, document):
    # This already-admitted profile has one immutable image for the fixed pair.
    from docker_volume_stop_diagnostic import _container_snapshot
    image, ids, actual = _container_snapshot(args, selected, control.identity, control, previous, document)
    require(all(actual[role]["State"].get("StartedAt") == previous[role + "_started_at"]
                and actual[role]["State"].get("OOMKilled") is False
                and actual[role]["State"].get("Restarting") is False for role in actual),
            "service start/restart/OOM pin differs")
    return image, ids, actual


def _assert_consumers(control, operation, ids):
    from docker_volume_unclaimed_cancellation import _project_container_ids, _volume_consumer_ids
    # BuildControl itself authenticates labels, image, command, mount, and lease.
    helper = control._assert_live_operation_helper(operation)
    require(control._inspect_operation_helper(operation) == helper, "operation helper incarnation changed")
    require(helper == operation.get("helper_container_id") and isinstance(helper, str) and SHA.fullmatch(helper)
            and operation["receipt"].get("phase") == PHASE, "new stop phase/helper differs")
    # Activation/run-script and iteration producers use this same operation.lock
    # and active-token protocol. Historical backend script receipts are not leases.
    token = operation["receipt"].get("attempt")
    require(isinstance(token, str) and TOKEN.fullmatch(token)
            and _read(control, "active") == token.encode() + b"\n", "current operation marker is not our exact lease")
    expected = set(ids.values()) | {helper}
    require(_project_container_ids(control.project) == expected and _volume_consumer_ids(control.volume) == expected,
            "selected group/control has another consumer")


def _probe(control, backend, *, stopped=False):
    from docker_build_control import bounded_capture, docker_capture
    from docker_volume_pre_ack_retry import _released_snapshot
    if stopped:
        from docker_volume_preowner_drained import _python_helper_args
        from docker_volume_linux_supervision_stop import readonly_mount
        args = _python_helper_args(control, "python3 -I -B -c " + shlex.quote(PROBE) + " offline", backend["Image"])
        for index, value in enumerate(args):
            if isinstance(value, str) and value.startswith("type=volume,") and ",dst=/control," in value:
                args[index] = value + ",readonly"
        offset = args.index("--entrypoint")
        args[offset:offset] = ["--mount", readonly_mount(backend, "/state"),
                               "--mount", readonly_mount(backend, "/opt/fullmag/package")]
        result = bounded_capture(args, data=b"", timeout=90, maximum=MAXIMUM)
        require(result.returncode == 0, "offline empty-abort probe failed")
    else:
        result = docker_capture("exec", backend["Id"], "python3", "-I", "-B", "-c", PROBE, "live", timeout=90)
    guest = decode(bytes(result.stdout))
    guest["released"] = _released_snapshot(control, backend)
    # The typed unresolved marker is published by the activation producer;
    # ambiguous publication also keeps the shared /control/active lease above.
    guest["activation_active"] = any(_read(control, relative, optional=True) is not None
                                     for relative in ("activation/active", "activation/unresolved.json"))
    validate_guest(guest, backend["Image"], stopped=stopped)
    require(_read(control, PROCESS_RELATIVE) == base64.b64decode(guest["process_raw"], validate=True)
            and sha(_read(control, "runtime-control/runtime-service/docker-all.json")) == guest["config_sha256"]
            and sha(_read(control, "backend/runtime-provenance.json")) == guest["provenance_sha256"],
            "backend/control namespace records differ")
    return guest


def _plan(control, args, selected, operation):
    previous, document, records = _development(control, args, selected)
    image, ids, actual = _snapshot(control, args, selected, previous, document)
    _assert_consumers(control, operation, ids)
    guest = _probe(control, actual["backend"])
    require(guest["process_sha256"] == records["process_failure_sha256"], "live failure differs from development sidecar")
    _assert_consumers(control, operation, ids)
    body = {"schema": SCHEMA, "scope": _scope(control, args, selected), **records,
            "image_id": image, "services": {role: service_pin(row) for role, row in actual.items()},
            "guest": guest, "controller_sha256": sha(Path(__file__).read_bytes()), "probe_sha256": sha(PROBE.encode()),
            "actions": ["stop-exact-backend-and-frontend", "preserve-shutdown-unknown-and-empty-namespace"],
            "claims": {"native_owner_ever_admitted": False, "drained": False, "solve_replayed": False,
                       "data_deleted": False, "lease_or_reservation_cleared": False}}
    return {**body, "plan_sha256": sha(canonical(body))}, actual, document


def stop(args):
    from docker_build_control import BuildControl, docker_capture, toolchain_configuration
    from docker_dev import _compose_identity, _select_source
    from docker_dev_host import require_host
    require(isinstance(args.attempt, str) and TOKEN.fullmatch(args.attempt)
            and isinstance(args.config_sha256, str) and SHA.fullmatch(args.config_sha256), "invalid development/config pins")
    apply, preview = getattr(args, "apply", False), getattr(args, "preview", False)
    expected = getattr(args, "expected_plan_sha256", None)
    require(type(apply) is bool and type(preview) is bool and apply != preview
            and (isinstance(expected, str) and SHA.fullmatch(expected) if apply else expected is None),
            "choose preview or explicit apply with exact plan SHA")
    require(type(args.port) is int and 1 <= args.port <= 65535, "invalid frontend port")
    require_host()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    helper = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    control = BuildControl(identity, helper)
    require(docker_capture("volume", "inspect", control.volume, allow_failure=True).returncode == 0,
            "selected control volume does not exist")
    control.prepare()
    inputs = {"source_root": str(selected), "attempt": args.attempt, "config_sha256": args.config_sha256,
              "empty_api_abort": True, "preview_only": preview}
    with control.operation(PHASE, inputs) as operation:
        plan, actual, document = _plan(control, args, selected, operation)
        if apply:
            require(plan["plan_sha256"] == expected, "preview plan SHA changed; no stop issued")
        control.write(operation["root"] + "/plan.json", plan)
        operation["receipt"].update(plan_sha256=plan["plan_sha256"], image_id=plan["image_id"],
                                    config_sha256=args.config_sha256, process_receipt_sha256=plan["guest"]["process_sha256"])
        if apply:
            from docker_volume_stop_unadmitted import _preflight_terminal_process_receipt
            _preflight_terminal_process_receipt(actual["backend"], control)
            fresh_plan, fresh_actual, _ = _plan(control, args, selected, operation)
            require(fresh_plan == plan, "pins changed immediately before Docker stop")
            ids = {role: row["Id"] for role, row in fresh_actual.items()}
            operation["daemon_pending"] = True
            docker_capture("stop", "--time", "60", ids["backend"], ids["frontend"], timeout=90)
            rows = decode_inspect(docker_capture("inspect", ids["backend"], ids["frontend"]).stdout)
            stopped = {role: rows[identifier] for role, identifier in ids.items()}
            for role, row in stopped.items():
                state = row.get("State", {})
                require(service_pin(row) == plan["services"][role] and state.get("Running") is False
                        and state.get("Pid") == 0 and state.get("OOMKilled") is False and type(state.get("ExitCode")) is int
                        and state["ExitCode"] == (1 if role == "backend" else 0), "stopped incarnation/exit differs")
            after = _probe(control, stopped["backend"], stopped=True)
            validate_transition(plan["guest"], after, plan["image_id"])
            control.write(operation["root"] + "/after.json", after)
            control.write(operation["root"] + "/stopped-services.json", stopped)
            operation["receipt"].update(empty_api_abort_stopped=True, after_sha256=sha(canonical(after) + b"\n"),
                                        stopped_services_sha256=sha(canonical(stopped) + b"\n"))
            operation["daemon_pending"] = False
        operation["receipt"].update(state="succeeded", stop_applied=apply, owner_state="absent",
                                    process_outcome="shutdown_unknown" if apply else "failed_outcome_retained",
                                    data_deleted=False, solve_replayed=False)
        stop_attempt = operation["receipt"]["attempt"]
    raw = _read(control, PHASE + "/attempts/" + stop_attempt + "/terminal.json")
    return {"state": "stopped-confirmed" if apply else "preview-passed", "stop_applied": apply,
            "plan_sha256": plan["plan_sha256"], "stop_attempt": stop_attempt, "stop_terminal_sha256": sha(raw),
            "backend_container_id": actual["backend"]["Id"], "frontend_container_id": actual["frontend"]["Id"],
            "native_owner": "absent", "process_outcome": "shutdown_unknown" if apply else "failed_outcome_retained"}


def decode_inspect(raw):
    require(isinstance(raw, bytes) and len(raw) <= MAXIMUM, "Docker inspect exceeds bound")
    try:
        rows = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as error:
        raise BuildControlError("Empty API abort: invalid Docker inspect") from error
    require(isinstance(rows, list) and len(rows) == 2 and all(isinstance(row, dict) for row in rows)
            and len({row.get("Id") for row in rows}) == 2, "Docker service inspection is ambiguous")
    return {row["Id"]: row for row in rows}


def fresh_pin(args, *, recreate_services, restart_idle_service=False, stop_after_drain=False,
              resume_recreation_id=None, refresh_frontend_service=False, retire_only=False):
    token, digest = (getattr(args, key, None) for key in ("empty_api_abort_stop", "empty_api_abort_stop_sha256"))
    require(bool(token) == bool(digest), "fresh-state needs paired empty-abort stop pins")
    if token is None:
        return None
    require(isinstance(token, str) and TOKEN.fullmatch(token) and isinstance(digest, str) and SHA.fullmatch(digest),
            "empty-abort stop identity is malformed")
    require(recreate_services and getattr(args, "fresh_state", False) is True
            and not restart_idle_service and not stop_after_drain and resume_recreation_id is None
            and not refresh_frontend_service and not retire_only
            and not any(getattr(args, key, None) for key in (
                "script", "recovery_authorization", "native_terminal_stop", "native_terminal_stop_sha256",
                "terminal_observation_stop", "terminal_observation_proof", "terminal_observation_proof_sha256",
                "completed_recreation_attempt", "completed_recreation_sha256", "lost_state_stop",
                "offline_reconciliation", "drained_successor_proof", "drained_successor_proof_sha256",
                "pending_activation", "restart_backend", "capture_native_terminal", "quiesce_api",
                "capture_terminal_observation", "saved_authoring_checkpoint", "saved_authoring_checkpoint_sha256")), "empty-abort receipt authorizes only plain fresh-state archival")
    return token, digest


def validate_fresh(control, args, selected, actual, pin):
    token, expected_sha = pin
    require(isinstance(token, str) and TOKEN.fullmatch(token) and isinstance(expected_sha, str) and SHA.fullmatch(expected_sha),
            "fresh receipt pins are malformed")
    root = PHASE + "/attempts/" + token + "/"
    terminal_raw = _read(control, root + "terminal.json")
    stop = decode(terminal_raw)
    require(sha(terminal_raw) == expected_sha and _read(control, root + "receipt.json") == terminal_raw,
            "stop terminal raw SHA/receipt differs")
    require(stop.get("schema") == "fullmag.docker-build-operation.v1" and stop.get("phase") == PHASE
            and stop.get("attempt") == token and stop.get("state") == "succeeded"
            and stop.get("empty_api_abort_stopped") is True and stop.get("stop_applied") is True
            and stop.get("owner_state") == "absent" and stop.get("process_outcome") == "shutdown_unknown"
            and stop.get("compose_project") == control.project and stop.get("control_volume") == control.volume
            and stop.get("control_namespace", "") == control.namespace
            and stop.get("namespace_registry_sha256") == control.namespace_registry_sha256
            and stop.get("inputs", {}).get("empty_api_abort") is True
            and stop.get("inputs", {}).get("preview_only") is False
            and stop.get("inputs", {}).get("attempt") == args.attempt
            and stop.get("inputs", {}).get("source_root") == str(selected)
            and stop.get("config_sha256") == args.config_sha256
            and stop.get("inputs", {}).get("config_sha256") == args.config_sha256,
            "stop was not this scope's successful explicit empty-abort apply")
    plan = decode(_read(control, root + "plan.json"))
    body = {key: value for key, value in plan.items() if key != "plan_sha256"}
    require(plan.get("schema") == SCHEMA and plan.get("plan_sha256") == sha(canonical(body)) == stop.get("plan_sha256")
            and plan.get("scope") == _scope(control, args, selected), "stop plan digest/scope differs")
    previous, document, records = _development(control, args, selected)
    require(all(plan.get(key) == value for key, value in records.items()), "original development records changed")
    after_raw, stopped_raw = _read(control, root + "after.json"), _read(control, root + "stopped-services.json")
    require(sha(after_raw) == stop.get("after_sha256") and sha(stopped_raw) == stop.get("stopped_services_sha256"),
            "post-stop proof CAS differs")
    after, stopped = decode(after_raw), decode(stopped_raw)
    validate_transition(plan["guest"], after, plan["image_id"])
    require(set(stopped) == set(actual) == {"backend", "frontend"}, "fresh service set differs")
    for role, now in actual.items():
        require(service_pin(now) == service_pin(stopped[role]) == plan["services"][role]
                and now.get("State", {}).get("Running") is False and now["State"].get("Pid") == 0
                and now["State"].get("OOMKilled") is False and type(now["State"].get("ExitCode")) is int
                and now["State"]["ExitCode"] == (1 if role == "backend" else 0), "fresh service incarnation/exit differs")
    require(_probe(control, actual["backend"], stopped=True) == after, "current empty ownerless namespace differs from stop")
    return {"schema": "fullmag.empty-api-abort-fresh-state.v1", "stop_attempt": token,
            "stop_terminal_sha256": expected_sha, "plan_sha256": plan["plan_sha256"],
            "process_outcome": "shutdown_unknown", "native_owner": "absent"}
