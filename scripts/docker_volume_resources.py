"""Increase one owned pre-API backend's limits without restarting its build."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
import uuid

from docker_build_control import BuildControl, BuildControlError, bounded_capture, canonical, control_read_script, docker_capture, toolchain_configuration
from docker_dev_host import require_host

SCHEMA = "fullmag.docker-backend-resource-budget.v1"
PROFILE_PATH = "backend/resource-budget.json"
GIB = 1024 ** 3


def _raw_record(control, relative):
    result = bounded_capture(control.helper_args(control_read_script(control.path(relative), 65536)),
                             data=b"", timeout=30)
    if result.returncode or len(result.stdout) > 65536:
        raise BuildControlError("Cannot read the pinned backend budget receipt")
    return result.stdout


def _inspect(*arguments, timeout=90):
    records = json.loads(docker_capture(*arguments, timeout=timeout).stdout)
    if not isinstance(records, list) or len(records) != 1:
        raise BuildControlError("Resource operation requires one exact Docker object")
    return records[0]


def _docker_capacity():
    return json.loads(docker_capture("info", "--format", "{{json .}}").stdout)


def default_group_budget(capacity):
    """Per-group defaults sized so three DEV groups fit in one Docker VM.

    Compose limits are caps, not reservations: an idle group costs nothing and
    a busy one is throttled by its own quota instead of stopping other groups.
    """
    cpus, memory_gib = int(capacity["NCPU"]), int(capacity["MemTotal"]) // GIB
    return {
        "FULLMAG_DEV_BACKEND_CPUS": max(2, min(8, cpus // 4)),
        "FULLMAG_DEV_BACKEND_MEMORY_GIB": max(8, min(32, memory_gib // 6)),
        "FULLMAG_DEV_FRONTEND_CPUS": max(2, min(4, cpus // 10)),
        "FULLMAG_DEV_FRONTEND_MEMORY_GIB": max(8, min(16, memory_gib // 12)),
    }


def apply_group_budget(document, configured, capacity=None):
    """Apply the static per-group budget from ``.env`` or the VM defaults.

    The container quota, the native host profile and Cargo use one value, so
    the group's own ledger never offers more than its container may use.
    """
    capacity = _docker_capacity() if capacity is None else capacity
    budget = {**default_group_budget(capacity), **configured}
    backend_cpus = budget["FULLMAG_DEV_BACKEND_CPUS"]
    backend_memory = budget["FULLMAG_DEV_BACKEND_MEMORY_GIB"] * GIB
    frontend_cpus = budget["FULLMAG_DEV_FRONTEND_CPUS"]
    frontend_memory = budget["FULLMAG_DEV_FRONTEND_MEMORY_GIB"] * GIB
    if backend_cpus < 2:
        raise BuildControlError("FULLMAG_DEV_BACKEND_CPUS must be at least 2 for compute and preparation")
    if backend_memory < 4 * GIB or frontend_memory < 8 * GIB:
        raise BuildControlError("DEV budget needs at least 4 GiB for backend and 8 GiB for frontend")
    if (max(backend_cpus, frontend_cpus) > capacity["NCPU"]
            or max(backend_memory, frontend_memory) > capacity["MemTotal"]):
        raise BuildControlError("DEV group budget exceeds Docker capacity "
                                f"({capacity['NCPU']} CPUs, {capacity['MemTotal'] // GIB} GiB)")
    backend, frontend = (document["services"][name] for name in ("backend", "frontend"))
    backend.update(cpus=backend_cpus, mem_limit=backend_memory)
    frontend.update(cpus=frontend_cpus, mem_limit=frontend_memory)
    environment = backend.setdefault("environment", {})
    environment["CARGO_BUILD_JOBS"] = str(min(backend_cpus, 64))
    environment["FULLMAG_DOCKER_CPU_MILLIS"] = str(backend_cpus * 1000)
    environment["FULLMAG_DOCKER_MEMORY_BYTES"] = str(backend_memory)


def apply_saved_budget(control, document):
    """Apply only this control namespace's explicitly saved backend budget."""
    profile = control.read(PROFILE_PATH, optional=True)
    if profile is None:
        return
    if (profile.get("schema") != SCHEMA or profile.get("state") != "succeeded"
            or profile.get("compose_project") != control.project
            or profile.get("control_namespace") != control.namespace):
        raise BuildControlError("Saved backend resource budget identity differs")
    relative = profile.get("receipt_path")
    if not isinstance(relative, str) or not re.fullmatch(
        r"development/attempts/[0-9a-f]{32}/resource-increases/[0-9a-f]{32}/receipt.json", relative
    ):
        raise BuildControlError("Saved backend resource budget has no pinned receipt")
    raw = _raw_record(control, relative)
    bound = json.loads(raw)
    if (hashlib.sha256(raw).hexdigest() != profile.get("receipt_sha256")
            or any(bound.get(key) != profile.get(key) for key in
                   ("schema", "state", "compose_project", "control_namespace", "budget"))
            or bound.get("parent_attempt") != relative.split("/")[2]
            or bound.get("adjustment_id") != relative.split("/")[4]):
        raise BuildControlError("Saved backend resource budget differs from its receipt")
    budget = profile.get("budget", {})
    memory, cpus, swap = (budget.get(key) for key in ("memory_bytes", "cpus", "memory_swap_bytes"))
    if (type(memory) is not int or memory < GIB or type(cpus) is not int or cpus < 1
            or type(swap) is not int or (swap != -1 and swap < memory)):
        raise BuildControlError("Saved backend resource budget is invalid")
    backend = document["services"]["backend"]
    capacity = _docker_capacity()
    if (memory < int(backend["mem_limit"]) or cpus < float(backend["cpus"])
            or memory > capacity["MemTotal"] or cpus > capacity["NCPU"]):
        raise BuildControlError("Saved backend budget is below the Compose baseline or above Docker capacity")
    backend.update(cpus=cpus, mem_limit=memory, memswap_limit=swap)
    # The container quota, native host profile, and Cargo must use the same
    # verified budget. Native CMake builds share Cargo's jobserver.
    environment = backend.setdefault("environment", {})
    environment["CARGO_BUILD_JOBS"] = str(min(cpus, 64))
    environment["FULLMAG_DOCKER_CPU_MILLIS"] = str(cpus * 1000)
    environment["FULLMAG_DOCKER_MEMORY_BYTES"] = str(memory)


def _assert_no_unresolved_increases(control, root):
    path = control.path(root + "/resource-increases")
    script = (f"test ! -L '{path}'; if test ! -e '{path}'; then exit 0; fi; "
              f"test -d '{path}'; test \"$(readlink -f '{path}')\" = '{path}'; "
              f"find '{path}' -mindepth 1 -maxdepth 1 -printf '%f\\n'")
    result = bounded_capture(control.helper_args(script), data=b"", timeout=30, maximum=4096)
    if result.returncode:
        raise BuildControlError("Cannot inspect previous resource increases")
    tokens = result.stdout.decode().splitlines()
    if len(tokens) > 64 or any(not re.fullmatch(r"[0-9a-f]{32}", token) for token in tokens):
        raise BuildControlError("Resource increase inventory is unknown or exceeds its bound")
    for token in tokens:
        prior = control.read(root + "/resource-increases/" + token + "/receipt.json", optional=True)
        if (prior is None or prior.get("state") != "succeeded" or prior.get("schema") != SCHEMA
                or prior.get("adjustment_id") != token or prior.get("compose_project") != control.project
                or prior.get("control_namespace") != control.namespace):
            raise BuildControlError("Resource increase " + token + " is unresolved; no new update issued")


_START_PROBE = """import json,pathlib
children=pathlib.Path('/proc/1/task/1/children').read_text().split()
if len(children)!=1: raise RuntimeError('backend init has no unique child')
p=pathlib.Path('/proc')/children[0]
args=(p/'cmdline').read_bytes().decode().split('\\0')
if args[1:3]!=['/opt/fullmag/backend_dev.py','start']: raise RuntimeError('backend is no longer in pre-API start')
stat=(p/'stat').read_text(); token=stat[stat.rfind(')')+2:].split()[19]
memory={line.split()[0].rstrip(':'):int(line.split()[1])*1024 for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.startswith(('MemTotal:','MemAvailable:'))}
print(json.dumps({'pid':int(children[0]),'start_token':token,**memory}))
"""

# Pause only the verified Python startup process, before any worker gate.
# Once an update is armed, an unknown outcome keeps startup stopped. Only a
# confirmed outcome permits handoff; host-side recovery covers helper death.
_PAUSE_START = """import json,os,pathlib,select,signal,sys,time
pid=int(sys.argv[1]); token=sys.argv[2]; proc=pathlib.Path('/proc')/str(pid)
def verify():
 value=(proc/'stat').read_text(); current=value[value.rfind(')')+2:].split()[19]
 if current!=token: raise RuntimeError('startup process identity changed')
 args=(proc/'cmdline').read_bytes().decode().split('\\0')
 if args[1:3]!=['/opt/fullmag/backend_dev.py','start']: raise RuntimeError('startup process reached API')
def interrupted(*args): raise SystemExit('resource pause interrupted')
signal.signal(signal.SIGTERM,interrupted); signal.signal(signal.SIGINT,interrupted)
fd=os.pidfd_open(pid); stopped=False; armed=False; resume=False
try:
 verify(); stopped=True; signal.pidfd_send_signal(fd,signal.SIGSTOP,None,0)
 deadline=time.monotonic()+3
 while True:
  verify()
  state=next(line for line in (proc/'status').read_text().splitlines() if line.startswith('State:'))
  if state.split()[1]=='T': break
  if time.monotonic()>deadline: raise RuntimeError('startup process did not pause')
  time.sleep(.01)
 request=pathlib.Path('/opt/fullmag/runtime-control/worker-cgroup/request.json')
 if request.exists():
  value=json.loads(request.read_bytes())
  if value.get('pid')==pid and value.get('process_start_token')==token: raise RuntimeError('worker gate already started')
 print('PAUSED',flush=True)
 while select.select([sys.stdin],[],[],float(sys.argv[3]))[0]:
  command=sys.stdin.readline().strip()
  if command=='ARM':
   armed=True; print('ARMED',flush=True)
  elif command=='RESUME':
   resume=True; break
  else: break
finally:
 if stopped and (resume or not armed):
  try: signal.pidfd_send_signal(fd,signal.SIGCONT,None,0)
  except ProcessLookupError: pass
 os.close(fd)
print('RESUMED' if resume or not armed else 'HELD',flush=True)
"""

_RESUME_START = """import json,os,pathlib,signal,sys
pid=int(sys.argv[1]); token=sys.argv[2]; p=pathlib.Path('/proc')/str(pid)
fd=os.pidfd_open(pid)
try:
 value=(p/'stat').read_text(); current=value[value.rfind(')')+2:].split()[19]
 if current!=token: raise RuntimeError('startup process identity changed before resume')
 state=next(line for line in (p/'status').read_text().splitlines() if line.startswith('State:'))
 if state.split()[1]=='T':
  args=(p/'cmdline').read_bytes().decode().split('\\0')
  if args[1:3]!=['/opt/fullmag/backend_dev.py','start']: raise RuntimeError('stopped process is not startup')
  signal.pidfd_send_signal(fd,signal.SIGCONT,None,0)
 print(json.dumps({'pid':pid,'resume_confirmed':True}))
finally: os.close(fd)
"""


@contextmanager
def _pause_start(backend_id, probe, *, pause_seconds=30):
    from docker_dev_host import docker_argv
    if not 30 <= pause_seconds <= 600:
        raise BuildControlError("Startup pause exceeds its bounded observation window")
    process = subprocess.Popen(docker_argv("exec", "-i", backend_id, "/usr/local/bin/python3",
                               "-I", "-B", "-u", "-c", _PAUSE_START,
                               str(probe["pid"]), probe["start_token"], str(pause_seconds)),
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    state = {"process": process, "issued": False, "resolved": False}
    try:
        if BuildControl._line(process, timeout=10) != "PAUSED":
            raise BuildControlError("Startup did not enter the resource adjustment pause")
        yield state
    finally:
        may_resume = state["resolved"] or not state["issued"]
        if process.stdin and not process.stdin.closed:
            if may_resume:
                try:
                    process.stdin.write(b"RESUME\n")
                    process.stdin.flush()
                except (BrokenPipeError, OSError):
                    pass
            try:
                process.stdin.close()
            except (BrokenPipeError, OSError):
                pass
        try:
            process.wait(timeout=35)
        finally:
            if may_resume:
                # This independent path also resumes startup if the pause helper
                # was killed after SIGSTOP. It is forbidden for unknown updates.
                docker_capture("exec", backend_id, "/usr/local/bin/python3", "-I", "-B", "-c",
                               _RESUME_START, str(probe["pid"]), probe["start_token"], timeout=10)


def _fence(control, attempt, root, selected, identity, backend_id, document, receipt):
    from docker_volume_activation_reconcile import _validate_helper
    from docker_volume_dev import _validate_existing_development_operation, _validate_retained_service
    _validate_existing_development_operation(
        control, {"lease_ready": True, "root": root, "receipt": receipt}, selected, identity
    )
    _validate_helper(control, receipt["helper_container"], attempt, phase="development")
    active_result = bounded_capture(control.helper_args(
        "test ! -L /control/active; test -f /control/active; head -c 128 /control/active"
    ), data=b"", timeout=30)
    if active_result.returncode:
        raise BuildControlError("Cannot read the active development operation")
    active = active_result.stdout.decode().strip()
    if active != attempt or control.read(root + "/terminal.json", optional=True) is not None:
        raise BuildControlError("Development operation is no longer active")
    actual = _inspect("inspect", backend_id)
    if (actual.get("Id") != backend_id or actual.get("Image") != receipt["inputs"]["image_id"]
            or actual.get("State", {}).get("Running") is not True):
        raise BuildControlError("Pinned backend is not the active development container")
    image = _inspect("image", "inspect", actual["Image"])
    _validate_retained_service(document, actual, "backend", image["Config"])
    probe = json.loads(docker_capture(
        "exec", backend_id, "/usr/local/bin/python3", "-I", "-B", "-c", _START_PROBE
    ).stdout)
    return actual, probe


@contextmanager
def _resource_lock(control, root, attempt):
    path = control.path(root)
    lock = path + "/resource-budget.lock"
    script = (f"test \"$(cat /control/active)\" = '{attempt}'; "
              f"test \"$(readlink -f '{path}')\" = '{path}'; "
              f"test ! -L '{lock}'; if test -e '{lock}'; then test -f '{lock}'; "
              f"test $(stat -c %h '{lock}') = 1; fi; "
              f"umask 027; exec 8>>'{lock}'; flock -n 8; printf 'READY\\n'; cat >/dev/null")
    process = subprocess.Popen(control.helper_args(script), stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        if control._line(process) != "READY":
            raise BuildControlError("Backend resource adjustment lock is unavailable")
        # Callers may observe liveness while a long child operation is running.
        yield process
    finally:
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
        if process.wait(timeout=30) != 0:
            raise BuildControlError("Backend resource adjustment lock did not close cleanly")


def increase(args):
    from docker_dev import _select_source, _compose_identity
    require_host()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    if (not re.fullmatch(r"[0-9a-f]{32}", args.attempt)
            or not re.fullmatch(r"[0-9a-f]{64}", args.backend_container_id)
            or args.backend_memory_gib < 1 or args.backend_cpus < 1):
        raise BuildControlError("Resource increase requires exact identities and positive budgets")
    configured = toolchain_configuration(selected, identity)
    control = BuildControl(identity, configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    root = "development/attempts/" + args.attempt
    receipt = control.read(root + "/receipt.json")
    if receipt.get("state") != "starting":
        raise BuildControlError("Resource increase requires a live development start")
    document = control.read(root + "/compose.json")
    if document.get("name") != control.project:
        raise BuildControlError("Resource increase Compose project differs")
    with _resource_lock(control, root, args.attempt):
        _assert_no_unresolved_increases(control, root)
        actual, probe = _fence(control, args.attempt, root, selected, identity,
                               args.backend_container_id, document, receipt)
        host = actual["HostConfig"]
        memory, cpus = args.backend_memory_gib * GIB, args.backend_cpus
        old_memory, old_cpus, old_swap = (host.get(key, 0) for key in ("Memory", "NanoCpus", "MemorySwap"))
        if (old_memory <= 0 or old_cpus <= 0 or memory < old_memory or cpus * 10**9 < old_cpus):
            raise BuildControlError("This live operation only increases existing bounded limits")
        info = json.loads(docker_capture("info", "--format", "{{json .}}").stdout)
        if memory > info["MemTotal"] or cpus > info["NCPU"]:
            raise BuildControlError("Requested backend budget exceeds the Docker VM capacity")
        if memory - old_memory > max(0, probe["MemAvailable"] - 16 * GIB):
            raise BuildControlError("Requested memory increase leaves less than 16 GiB available")
        # Docker's swap limit includes RAM. Preserve the existing extra swap allowance.
        if old_swap != -1 and old_swap < old_memory:
            raise BuildControlError("Existing backend swap allowance is ambiguous")
        swap = -1 if old_swap == -1 else memory + old_swap - old_memory
        budget = {"memory_bytes": memory, "cpus": cpus, "memory_swap_bytes": swap}
        record = {"schema": SCHEMA, "state": "planned", "compose_project": control.project,
                  "control_namespace": control.namespace, "parent_attempt": args.attempt,
                  "backend_container_id": actual["Id"], "image_id": actual["Image"],
                  "started_at": actual["State"]["StartedAt"], "process": probe,
                  "before": {"memory_bytes": old_memory, "nano_cpus": old_cpus,
                             "memory_swap_bytes": old_swap}, "budget": budget}
        if not args.apply:
            print(json.dumps(record, indent=2))
            return
        token = uuid.uuid4().hex
        record_root = root + "/resource-increases/" + token
        record.update(adjustment_id=token, requested_at=time.time())
        pinned, live = _fence(control, args.attempt, root, selected, identity,
                              args.backend_container_id, document, receipt)
        if (pinned["State"]["StartedAt"] != record["started_at"]
                or live["pid"] != probe["pid"] or live["start_token"] != probe["start_token"]
                or any(pinned["HostConfig"].get(k, 0) != host.get(k, 0)
                       for k in ("Memory", "NanoCpus", "MemorySwap"))):
            raise BuildControlError("Backend incarnation or resource limits changed before update")
        update_error = None
        with _pause_start(actual["Id"], probe) as pause:
            pause["process"].stdin.write(b"ARM\n")
            pause["process"].stdin.flush()
            if BuildControl._line(pause["process"], timeout=5) != "ARMED":
                raise BuildControlError("Startup pause was not armed; no update issued")
            # Publish only after fencing and the pause handshake have succeeded.
            # A rejected pre-API/gate check must not strand an unused intent.
            control.write(record_root + "/intent.json", record)
            control.write(record_root + "/update-issued.json", {
                "schema": SCHEMA, "adjustment_id": token, "backend_container_id": actual["Id"],
                "process": probe, "budget": budget,
            })
            pause["issued"] = True
            try:
                docker_capture("update", "--memory", str(memory), "--memory-swap", str(swap),
                               "--cpus", str(cpus), actual["Id"], timeout=10)
            except (BuildControlError, OSError, subprocess.SubprocessError) as error:
                update_error = type(error).__name__
            # A client timeout is an unknown daemon outcome: inspect, never repeat the update.
            observed = _inspect("inspect", actual["Id"], timeout=10)
            after = observed["HostConfig"]
            succeeded = (observed["Id"] == actual["Id"] and observed["Image"] == actual["Image"]
                         and observed["State"]["StartedAt"] == record["started_at"]
                         and observed["State"]["Running"] is True
                         and after.get("Memory") == memory and after.get("NanoCpus") == cpus * 10**9
                         and after.get("MemorySwap") == swap)
            pause["resolved"] = succeeded
        record.update(state="succeeded" if succeeded else "outcome-unknown-resources-retained",
                      finished_at=time.time(), update_error=update_error,
                      startup_kept_paused=not succeeded,
                      observed={key: after.get(key) for key in ("Memory", "NanoCpus", "MemorySwap")})
        control.write(record_root + "/receipt.json", record)
        if not succeeded:
            raise BuildControlError("Resource update did not reconcile to the requested limits; receipt retained")
        digest = hashlib.sha256(canonical(record) + b"\n").hexdigest()
        control.write(PROFILE_PATH, {"schema": SCHEMA, "state": "succeeded",
                      "compose_project": control.project, "control_namespace": control.namespace,
                      "budget": budget, "receipt_path": record_root + "/receipt.json",
                      "receipt_sha256": digest})
        print(json.dumps({"state": record["state"], "adjustment_id": token,
                          "compose_project": control.project, "budget": budget,
                          "receipt": record_root + "/receipt.json",
                          "receipt_sha256": digest}, indent=2))
