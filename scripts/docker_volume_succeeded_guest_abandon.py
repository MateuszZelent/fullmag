"""Abandon one pinned diagnostic START solely for an explicit fresh-state archive.

No namespace release, solver replay, removal, or retained admission occurs.
"""
from __future__ import annotations
import argparse
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import time
from types import MappingProxyType
import uuid
import docker_volume_succeeded_namespace_recovery as base
from docker_build_control import BuildControl, canonical, docker_capture

require, digest, strict_json = base.require, base.digest, base.strict_json
REQUEST = "fullmag.succeeded-guest-abandon-request.v1"
OBSERVATION = "fullmag.succeeded-guest-abandon-observation.v1"
PROOF = "fullmag.succeeded-guest-fresh-start.v1"
FIELDS = {"schema", "request_id", "source_root", "image_id", "recreate_request_path",
          "recreate_request_sha256", "original_attempt", "original_receipt_sha256",
          "helper", "backend", "frontend", "expected_observation_sha256"}
PREFIX = "/opt/fullmag/control/"
SERVICES = ("backend", "frontend")
STOP_TIMEOUT = 60
FRONTEND_OWNER = "/run/fullmag/frontend-owner"
FRONTEND_CACHE = "/opt/fullmag/shared-pnpm"


def evidence_path(value):
    require(isinstance(value, str) and value.startswith(PREFIX + "verification/")
            and str(PurePosixPath(value)) == value and ".." not in PurePosixPath(value).parts,
            "Evidence escaped private verification root")
    return value.removeprefix(PREFIX)


def validate_request(value):
    require(isinstance(value, dict) and set(value) == FIELDS and value["schema"] == REQUEST,
            "Unsupported diagnostic abandonment request")
    identifier = value["request_id"]
    require(isinstance(identifier, str) and str(uuid.UUID(identifier)) == identifier
            and uuid.UUID(identifier).int != 0, "Canonical request UUID required")
    source = value["source_root"]
    require(isinstance(source, str) and Path(source).is_absolute() and str(Path(source)) == source
            and ".." not in Path(source).parts, "Canonical source root required")
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", value["image_id"] or "")
            and re.fullmatch(r"[0-9a-f]{32}", value["original_attempt"] or ""), "Invalid image/attempt")
    for name in ("recreate_request_sha256", "original_receipt_sha256", "expected_observation_sha256"):
        require(isinstance(value[name], str) and base.SHA.fullmatch(value[name]), "Invalid evidence hash")
    evidence_path(value["recreate_request_path"])
    for service in (*SERVICES, "helper"):
        pin = value[service]
        require(isinstance(pin, dict) and set(pin) == {"container_id", "image_id", "started_at", "fingerprint"}
                and base.SHA.fullmatch(pin["container_id"] or "")
                and re.fullmatch(r"sha256:[0-9a-f]{64}", pin["image_id"] or "")
                and base.SHA.fullmatch(pin["fingerprint"] or "")
                and isinstance(pin["started_at"], str) and pin["started_at"]
                and not pin["started_at"].startswith("0001-"), "Exact incarnation required")
    require(value["backend"]["image_id"] == value["image_id"]
            and value["helper"]["image_id"] == value["image_id"]
            and len({value[key]["container_id"] for key in (*SERVICES, "helper")}) == 3,
            "Container identities overlap or image differs")
    return value


def _read(control, path, sha):
    raw = control.read_bytes(evidence_path(path))
    require(digest(raw) == sha, "Pinned evidence changed")
    return strict_json(raw)


def _root(request):
    return "verification/succeeded-guest-abandon/" + request["request_id"]


def _original_root(request):
    return "succeeded-namespace-recreate/attempts/" + request["original_attempt"]


def _request_intent(request):
    return {key: value for key, value in request.items() if key != "expected_observation_sha256"}


def load_lineage(control, request):
    from docker_volume_container_recovery import _docker_engine_sha
    seed = _read(control, request["recreate_request_path"], request["recreate_request_sha256"])
    require(seed.get("schema") == "fullmag.succeeded-namespace-recreate-request.v1"
            and seed.get("source_root") == request["source_root"]
            and seed.get("compose_project") == control.project, "Recreate source/group differs")
    native = _read(control, seed["native_request_path"], seed["native_request_sha256"])
    guest = _read(control, seed["guest_request_path"], seed["guest_request_sha256"])
    core = native["teardown"]
    require(native.get("schema_version") == "runtime_service_succeeded_namespace_recovery.v1"
            and guest.get("schema") == "fullmag.succeeded-namespace-guest.v1"
            and guest.get("teardown") == core and core.get("private_volume_name") == control.volume
            and core.get("docker_engine_id_sha256") == _docker_engine_sha()
            and guest.get("teardown_request_sha256") == digest(canonical(core)), "Original core differs")
    # The request explicitly pins the current same-container frontend restart.
    require(all(seed["frontend"].get(key) == request["frontend"].get(key)
                for key in ("container_id", "image_id", "fingerprint")), "Historical frontend identity differs")
    original = _original_root(request)
    archived = control.read_bytes(_root(request) + "/original-unknown-receipt.json", optional=True)
    raw = archived if archived is not None else control.read_bytes(original + "/receipt.json")
    require(digest(raw) == request["original_receipt_sha256"], "Original unknown receipt changed")
    receipt = strict_json(raw)
    require(receipt.get("schema") == "fullmag.docker-build-operation.v1"
            and receipt.get("phase") == "succeeded-namespace-recreate"
            and receipt.get("state") == "outcome-unknown-resources-retained"
            and receipt.get("attempt") == request["original_attempt"]
            and receipt.get("compose_project") == control.project and receipt.get("control_volume") == control.volume
            and receipt.get("helper_container") == "fullmag-control-" + request["original_attempt"]
            and receipt.get("inputs", {}).get("source_root") == request["source_root"]
            and receipt["inputs"].get("request_sha256") == request["recreate_request_sha256"]
            and receipt["inputs"].get("controller_sha256") == digest(base.regular(Path(base.__file__))), "Original START differs")
    authored = _read(control, seed["compose_path"], seed["compose_sha256"])
    planned_raw = control.read_bytes(original + "/compose.json")
    planned = strict_json(planned_raw)
    expected = deepcopy(authored)
    expected["services"]["backend"].update(init=False, entrypoint=["/usr/local/bin/python3", "-B",
        "/opt/fullmag/source/scripts/docker_volume_succeeded_namespace_guest.py", "--request",
        seed["guest_request_path"], "--request-sha256", seed["guest_request_sha256"]], command=[])
    expected["services"]["backend"].pop("x-fullmag-daemon-binds", None)
    checked = deepcopy(planned)
    binds = checked["services"]["backend"].pop("x-fullmag-daemon-binds", None)
    require(checked == expected and isinstance(binds, dict), "Exact diagnostic init=false Compose required")
    candidate = base.managed_candidate_result(control, native, Path(request["source_root"]))
    require(guest["candidate_path"] == candidate["candidate"]
            and guest["candidate_receipt_sha256"] == native["package_receipt_sha256"]
            and guest["source_snapshot_sha256"] == native["source_snapshot_sha256"]
            and digest(base.regular(Path(request["source_root"]) / "scripts/docker_volume_succeeded_namespace_guest.py"))
                == guest["guest_sha256"], "Guest/candidate provenance changed")
    sources = {name: digest(base.regular(Path(request["source_root"]) / "scripts" / name)) for name in (
        "docker_volume_succeeded_guest_abandon.py", "docker_volume_succeeded_namespace_recovery.py")}
    return {"seed": seed, "native": native, "guest": guest, "core": core, "authored": authored,
            "compose": planned, "compose_sha256": digest(planned_raw), "receipt": receipt, "receipt_raw": raw,
            "sources": sources}


def _no_handoff(control, lineage):
    guest, seed = lineage["guest"], lineage["seed"]
    status = PurePosixPath(guest["status_path"])
    absent = [str(status.with_suffix(".native-preview.json")), str(status.with_suffix(".handoff-committed.json")),
              guest["resume_intent_path"], str(PurePosixPath(seed["guest_request_path"]).with_name("engine-attestation.json"))]
    for path in absent:
        require(control.read_bytes(evidence_path(path), optional=True) is None, "Resume/handoff/attestation exists")


def _helper(control, request, lineage):
    from docker_volume_activation_reconcile import _validate_helper_logged
    require(control.read_bytes("active") == (request["original_attempt"] + "\n").encode(), "Original active marker differs")
    base.retained_stop_helper(control, lineage["receipt"], request["helper"], "succeeded-namespace-recreate")
    return digest(_validate_helper_logged(request["helper"]["container_id"]).encode())


def _consumers(control, request, helper=None):
    from docker_volume_unclaimed_cancellation import _project_container_ids, _volume_consumer_ids
    expected = {request[name]["container_id"] for name in SERVICES}
    if helper is not None:
        expected.add(helper)
    require(_project_container_ids(control.project) == expected
            and _volume_consumer_ids(control.volume) == expected, "Unexpected group/private-volume consumer")


def validate_guest_state(request, lineage, state):
    require(state.get("schema") == "fullmag.succeeded-guest-abandon-guest.v1"
            and state.get("guest_request_sha256") == lineage["seed"]["guest_request_sha256"]
            and state.get("backend_id") == request["backend"]["container_id"]
            and state.get("pid1_source_sha256") == lineage["guest"]["guest_sha256"]
            and all(state.get(key) is True for key in ("diagnostic_only", "no_other_processes", "no_pending_work"))
            and isinstance(state.get("protected"), dict) and state["protected"], "Not the idle fenced diagnostic API")
    return state


def protected_inventory(lineage, paths):
    import docker_volume_succeeded_namespace_guest as g
    guest = lineage["guest"]
    result, total = {}, 0
    def add(path):
        nonlocal total
        require(len(result) < g.MAX_GUARDED_FILES, "Protected file count exceeds existing bound")
        total += path.lstat().st_size
        require(total <= g.MAX_FILE, "Protected evidence exceeds existing 64-GiB bound")
        result[str(path)] = g.file_hash(path)
    for root in (paths.store, Path(os.environ["FULLMAG_HOST_LEDGER_ROOT"])):
        g.no_links(root)
        for directory, dirs, files in os.walk(root, followlinks=False):
            for name in dirs:
                require(not (Path(directory) / name).is_symlink(), "Protected directory alias")
            for name in sorted(files):
                add(Path(directory) / name)
    for path in (paths.config, paths.store / "runtime-services/OWNER.json", Path(guest["fms_archive_path"])):
        if str(path) not in result:
            add(path)
    require(result.get(str(paths.config)) == guest["config_sha256"]
            and result.get(guest["fms_archive_path"]) == guest["fms_archive_sha256"], "Config/FMS changed")
    for path in paths.store.glob("runs/*/run_catalog.json"):
        value = strict_json(base.regular(path))
        require(isinstance(value.get("tasks"), list) and all(row.get("lifecycle") in ("succeeded", "failed", "cancelled")
                    for row in value["tasks"]), "A nonterminal task exists")
    return {"inventory_sha256": digest(canonical(result)), "files": len(result), "bytes": total,
            "config_sha256": result[str(paths.config)], "fms_sha256": result[guest["fms_archive_path"]]}



HEALTH_COMMAND = b"/usr/local/bin/python3\0/opt/fullmag/healthcheck.py\0"


def _extra_processes(allowed):
    result = []
    for path in Path("/proc").iterdir():
        if path.name.isdigit() and int(path.name) not in allowed:
            pid = int(path.name)
            if base.process_identity(pid) is None:
                continue
            try:
                command = (path / "cmdline").read_bytes()
            except FileNotFoundError:
                continue
            if base.process_identity(pid) is not None:
                result.append((pid, command))
    return result


def wait_for_no_extra_processes(allowed):
    """Wait only for exact health probes; never admit a still-live probe."""
    deadline = time.monotonic() + 2.0
    while True:
        processes = _extra_processes(allowed)
        if not processes:
            return
        require(all(command == HEALTH_COMMAND for _pid, command in processes), "Another process/worker exists")
        require(time.monotonic() < deadline, "Health probe did not naturally exit within two seconds")
        time.sleep(0.05)

def guest_observe(payload):
    import docker_volume_succeeded_namespace_guest as g
    request, lineage = payload["request"], payload["lineage"]
    guest = lineage["guest"]
    service, _backend = g.image_modules(guest)
    paths = service.canonical_paths()
    status = strict_json(base.regular(Path(guest["status_path"])))
    started = strict_json(base.regular(Path(guest["status_path"]).with_suffix(".started.json")))
    expected_cmd = b"\0".join(item.encode() for item in lineage["compose"]["services"]["backend"]["entrypoint"]) + b"\0"
    require(Path("/proc/1/cmdline").read_bytes() == expected_cmd
            and status.get("schema") == "fullmag.succeeded-namespace-guest-status.v1"
            and status.get("state") == "diagnostic_api" and status.get("solve_replay") is False
            and status.get("execution_container_id") == request["backend"]["container_id"]
            and status.get("guest_request_sha256") == lineage["seed"]["guest_request_sha256"]
            and started.get("guest_request_sha256") == lineage["seed"]["guest_request_sha256"]
            and started.get("pid") == 1 and started.get("start_token") == g.start_token(1), "PID1/status differs")
    require(g.file_hash(Path("/opt/fullmag/source/scripts/docker_volume_succeeded_namespace_guest.py"))
            == guest["guest_sha256"], "PID1 source differs")
    api = base.process_identity(status["diagnostic_api_pid"])
    require(api == {"pid": status["diagnostic_api_pid"], "start_token": status["diagnostic_api_start_token"],
                    "executable_sha256": guest["candidate_api_sha256"]}, "API identity differs")
    require(g.file_hash(Path(status["diagnostic_api_failure_fence"]))
            == status["diagnostic_api_failure_fence_sha256"], "Diagnostic fence changed")
    environment = dict(item.split(b"=", 1) for item in Path(f"/proc/{api['pid']}/environ").read_bytes().split(b"\0") if b"=" in item)
    require(environment.get(b"FULLMAG_API_RUNTIME_FAILURE_FENCE") == status["diagnostic_api_failure_fence"].encode(),
            "API lacks its pre-spawn execution fence")
    wait_for_no_extra_processes({1, api["pid"], os.getpid()})
    require(base.process_identity(api["pid"]) == api, "API changed while waiting for health probe exit")
    return {"schema": "fullmag.succeeded-guest-abandon-guest.v1",
            "guest_request_sha256": lineage["seed"]["guest_request_sha256"],
            "backend_id": request["backend"]["container_id"], "pid1_source_sha256": guest["guest_sha256"],
            "diagnostic_only": True, "no_other_processes": True, "no_pending_work": True,
            "api": api, "protected": protected_inventory(lineage, paths)}


FENCE = r"""
import os,sys,time
from pathlib import Path
sys.path.insert(0,'/opt/fullmag/source/scripts')
import docker_volume_succeeded_guest_abandon as c
import docker_volume_succeeded_namespace_guest as g
p=c.strict_json(sys.stdin.buffer.readline(c.base.MAX_BYTES+1))
s,b=g.image_modules(p['lineage']['guest']);paths=s.canonical_paths()
with g.final_fences(b,paths,Path(os.environ['FULLMAG_HOST_LEDGER_ROOT'])):
 print(c.canonical(c.guest_observe(p)).decode(),flush=True)
 line=sys.stdin.buffer.readline(64)
 if line==b'ABORT\n':sys.exit(0)
 c.require(line==b'BEGIN_STOP\n','Exact diagnostic stop decision missing')
 print('FENCED',flush=True)
 while True:time.sleep(1)
"""


@contextmanager
def diagnostic_fence(request, lineage):
    import queue
    import threading
    from docker_dev_host import docker_argv
    process = subprocess.Popen(docker_argv("exec", "-i", request["backend"]["container_id"], "python3", "-B", "-c", FENCE),
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    messages = queue.Queue()
    errors = bytearray()
    def read_errors():
        while block := process.stderr.read(4096):
            errors.extend(block[:max(0, 65536 - len(errors))])
    threading.Thread(target=read_errors, daemon=True).start()
    def reader():
        for _ in range(2):
            messages.put(process.stdout.readline(base.MAX_BYTES + 1))
    threading.Thread(target=reader, daemon=True).start()
    began = False
    try:
        payload = {"request": request, "lineage": {key: lineage[key] for key in ("guest", "seed", "compose")}}
        process.stdin.write(canonical(payload) + b"\n"); process.stdin.flush()
        try:
            response = messages.get(timeout=300)
            require(response, "Diagnostic probe returned no observation")
            state = validate_guest_state(request, lineage, strict_json(response))
        except (queue.Empty, base.BuildControlError, ValueError) as error:
            detail = bytes(errors).decode("utf-8", "replace")[-2048:]
            raise base.BuildControlError("Diagnostic fence refused: " + detail) from error
        def begin():
            nonlocal began
            process.stdin.write(b"BEGIN_STOP\n"); process.stdin.flush()
            require(messages.get(timeout=10) == b"FENCED\n", "Stop fence ACK missing")
            began = True
        yield state, begin
    finally:
        if not began and process.poll() is None:
            process.stdin.write(b"ABORT\n"); process.stdin.flush(); process.stdin.close()
            process.wait(timeout=10)
        # No client kill is interpreted as namespace termination.


def _frontend_rows(inventory, service):
    """Allow only the two existing frontend directory mountpoints, not files."""
    require(service in SERVICES and isinstance(inventory.get("entries"), list)
            and len(inventory["entries"]) <= 256, "Unsupported or unbounded layer inventory")
    known, special = deepcopy(inventory), []
    known["entries"] = []
    for row in inventory["entries"]:
        path = row.get("path")
        if path not in (FRONTEND_OWNER, FRONTEND_CACHE):
            known["entries"].append(deepcopy(row))
            continue
        require(service == "frontend" and row.get("change") in ("A", "C")
                and row.get("kind") == "directory" and type(row.get("mode")) is int
                and stat.S_ISDIR(row["mode"]) and type(row.get("uid")) is int and row["uid"] >= 0
                and type(row.get("gid")) is int and row["gid"] >= 0 and type(row.get("size")) is int,
                "Frontend exception requires the exact existing directory mountpoint")
        selected = deepcopy(row)
        require(not row.get("frontend_abandon_path") or row.get("disposition") == "retained-frontend-mountpoint",
                "Frontend disposition changed")
        selected.update(frontend_abandon_path=True, disposition="retained-frontend-mountpoint")
        special.append(selected)
    paths = [row["path"] for row in inventory["entries"]]
    require(len(paths) == len(set(paths)), "Duplicate writable-layer path")
    known["unknown_paths"] = [path for path in inventory.get("unknown_paths", [])
                              if path not in (FRONTEND_OWNER, FRONTEND_CACHE)]
    return known, special


def frontend_mountpoint_metadata(row):
    require(row.get("path") in (FRONTEND_OWNER, FRONTEND_CACHE) and row.get("kind") == "directory"
            and row.get("change") in ("A", "C") and row.get("frontend_abandon_path") is True
            and row.get("disposition") == "retained-frontend-mountpoint", "Exact frontend mountpoint required")
    path = Path(row["path"])
    require(not any(part.is_symlink() for part in (path, *path.parents)), "Frontend mountpoint alias refused")
    value = path.lstat()
    require(stat.S_ISDIR(value.st_mode) and (value.st_mode, value.st_uid, value.st_gid, value.st_size)
            == (row["mode"], row["uid"], row["gid"], row["size"]), "Frontend mountpoint metadata changed")
    matches = []
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        fields = line.split()
        if fields[4].replace("\\040", " ").replace("\\134", "\\") == str(path):
            matches.append((fields[5].split(","), fields[fields.index("-") + 1]))
    require(len(matches) == 1 and "rw" in matches[0][0], "Frontend path is not its exact writable mount")
    require((matches[0][1] == "tmpfs") == (str(path) == FRONTEND_OWNER), "Frontend mount classification differs")
    return row


def _layer_exec(cid, function, payload, *, user="0"):
    original = function in ("guest_layer_snapshot", "guest_layer_hash", "guest_layer_payload")
    require(original or function == "frontend_mountpoint_metadata", "Unsupported layer read")
    module = "docker_volume_succeeded_namespace_recovery" if original else "docker_volume_succeeded_guest_abandon"
    code = ("import sys,json;sys.path.insert(0,'/opt/fullmag/source/scripts');import " + module + " as c;"
            "v=getattr(c,sys.argv[1])(json.loads(sys.stdin.buffer.read()));"
            "sys.stdout.buffer.write(v if isinstance(v,bytes) else "
            "(v.encode() if isinstance(v,str) else json.dumps(v).encode()))")
    return docker_capture("exec", "--user", user, "-i", cid, "python3", "-B", "-c", code, function,
                          data=canonical(payload), timeout=180).stdout


def layer_snapshot(cid, service):
    result = docker_capture("diff", cid, timeout=120)
    require(not result.stderr.strip(), "Layer diff failed")
    inventory = strict_json(_layer_exec(cid, "guest_layer_snapshot", result.stdout.decode("utf-8", "strict")))
    known, special = _frontend_rows(inventory, service)
    base.hash_layer_inventory(known, lambda row: _layer_exec(cid, "guest_layer_hash", row,
        user=str(row["uid"])).decode("ascii").strip())
    for row in special:
        require(strict_json(_layer_exec(cid, "frontend_mountpoint_metadata", row, user=str(row["uid"]))) == row,
                "Frontend mountpoint identity changed")
    inventory["entries"] = sorted(known["entries"] + special, key=lambda row: row["path"])
    inventory["unknown_paths"] = known["unknown_paths"]
    return inventory


def copy_layer_payloads(control, root, cid, service, inventory):
    known, _special = _frontend_rows(inventory, service)
    base.copy_layer_payloads(control, root, known,
        lambda row: _layer_exec(cid, "guest_layer_payload", row, user=str(row["uid"])))


def validate_stopped(actual, pin, project, service):
    base.require_container(actual, pin, project, service, running=False)
    state = actual["State"]
    require(state.get("Pid") == 0 and type(state.get("ExitCode")) is int
            and isinstance(state.get("FinishedAt"), str) and not state["FinishedAt"].startswith("0001-"),
            "Stopped namespace not confirmed")


def observation(request, lineage, state, layers, log_ack):
    layers = deepcopy(layers)
    for inventory in layers.values():
        # Docker's raw diff ordering is unstable; the canonical digest and
        # sorted metadata/payload entries still bind every actual change.
        inventory.pop("diff_sha256", None)
    return {"schema": OBSERVATION, "intent": _request_intent(request), "compose_sha256": lineage["compose_sha256"],
            "engine_id_sha256": lineage["core"]["docker_engine_id_sha256"], "sources": lineage["sources"],
            "guest": state, "layers": layers, "helper_log_ack_sha256": log_ack}


def _immutable(control, helper, relative, raw):
    """Create-new inside the original helper. Exact-existing still fsyncs both."""
    require(len(raw) <= base.MAX_BYTES, "Operational evidence exceeds bound")
    code = r"""
import os,sys,stat
from pathlib import Path
p=Path(sys.argv[1]);raw=sys.stdin.buffer.read(8388609)
assert len(raw)<=8388608 and str(p).startswith('/control/') and '..' not in p.parts
p.parent.mkdir(parents=True,exist_ok=True)
assert not any(x.is_symlink() for x in (p,*p.parents))
created=False
try:fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o640);created=True
except FileExistsError:fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
with os.fdopen(fd,'wb' if created else 'rb') as f:
 before=os.fstat(f.fileno());assert stat.S_ISREG(before.st_mode) and before.st_nlink==1
 if created:f.write(raw);f.flush()
 else:assert before.st_size==len(raw) and f.read(len(raw)+1)==raw
 os.fsync(f.fileno());after=os.fstat(f.fileno());named=p.lstat()
 assert (after.st_dev,after.st_ino)==(named.st_dev,named.st_ino)
for directory in (p.parent,*p.parent.parents):
 before=directory.lstat();assert stat.S_ISDIR(before.st_mode)
 fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  opened=os.fstat(fd);assert (before.st_dev,before.st_ino)==(opened.st_dev,opened.st_ino)
  os.fsync(fd);named=directory.lstat()
  assert (named.st_dev,named.st_ino)==(opened.st_dev,opened.st_ino)
 finally:os.close(fd)
 if str(directory)=='/control':break
else:raise AssertionError('Control ancestor missing')
print('created' if created else 'existing')
"""
    response = docker_capture("exec", "--user", "65532:65532", "-i", helper, "python3", "-B", "-c", code,
                              control.path(relative), data=raw, timeout=90)
    require(response.stdout in (b"created\n", b"existing\n") and not response.stderr.strip(), "Immutable publication refused")
    return response.stdout == b"created\n"


def signal_once(control, request, service, journal, inspect, signal, wait):
    """Existing intent never authorizes a repeated signal after interruption."""
    pin = request[service]
    actual = inspect(pin["container_id"])
    if journal is not None:
        validate_stopped(actual, pin, control.project, service)
        return actual
    base.require_container(actual, pin, control.project, service)
    require(signal() is True, "Signal intent exists; no replay")
    wait()
    actual = inspect(pin["container_id"])
    validate_stopped(actual, pin, control.project, service)
    return actual


@dataclass(frozen=True)
class FreshGuestContext:
    request: dict
    lineage: dict
    proof: dict
    metadata: object

    @property
    def compose_document(self):
        return deepcopy(self.lineage["compose"])

    @property
    def original_helper_id(self):
        return self.request["helper"]["container_id"]

    def expected_id(self, service):
        require(service in SERVICES, "Unknown fresh service")
        return self.request[service]["container_id"]


def _fresh_only(args, *, recreate_services, retire_only):
    require(recreate_services is True and getattr(args, "fresh_state", False) is True and not retire_only
            and not getattr(args, "headless", False), "Proof permits only plain GUI fresh-state recreation")
    forbidden = ("script", "recovery_authorization", "resume_recreation", "completed_recreation_attempt",
                 "completed_recreation_sha256", "drained_successor_proof", "drained_successor_proof_sha256",
                 "terminal_observation_proof", "terminal_observation_proof_sha256", "build_for_recovery",
                 "build_for_recovery_sha256", "pending_recovery_successor", "pending_recovery_successor_sha256",
                 "restart_backend", "helper_source_root", "helper_source_commit")
    require(not any(getattr(args, name, None) for name in forbidden), "Cannot combine another runtime authority")


def load_fresh_context(control, args, previous, document, selected, *, recreate_services, retire_only=False):
    _fresh_only(args, recreate_services=recreate_services, retire_only=retire_only)
    path, sha = getattr(args, "abandoned_diagnostic_proof", None), getattr(args, "abandoned_diagnostic_proof_sha256", None)
    require(bool(path) and isinstance(sha, str) and base.SHA.fullmatch(sha), "Paired fresh proof pins required")
    proof = _read(control, path, sha)
    require(proof.get("schema") == PROOF and proof.get("fresh_state_only") is True
            and proof.get("retained_resume_authorized") is False and proof.get("solve_replayed") is False
            and proof.get("reservations_modified") is False, "Not an additive fresh-only proof")
    request = validate_request(_read(control, proof["request_path"], proof["request_sha256"]))
    require(request["source_root"] == str(selected) == previous["inputs"]["source_root"]
            and request["image_id"] == previous["inputs"]["image_id"]
            and proof["original_development_compose_sha256"] == digest(canonical(document)), "Original development CAS differs")
    lineage = load_lineage(control, request)
    require(digest(canonical(lineage["authored"])) == digest(canonical(document))
            and proof["compose_sha256"] == lineage["compose_sha256"]
            and proof["engine_id_sha256"] == lineage["core"]["docker_engine_id_sha256"]
            and proof["sources"] == lineage["sources"], "Proof lineage/source differs")
    context = FreshGuestContext(request, lineage, proof, MappingProxyType({
        "schema": PROOF, "proof_path": path, "proof_sha256": sha,
        "request_sha256": proof["request_sha256"], "original_recreate_attempt": request["original_attempt"]}))
    _validate_proof_documents(control, context)
    return context


def _validate_proof_documents(control, context):
    request, proof = context.request, context.proof
    root = _root(request)
    required = {root + "/request.json", root + "/original-unknown-receipt.json", root + "/observation.json", root + "/final-terminal.json"}
    required.update(root + "/" + name + "/" + suffix for name in SERVICES for suffix in
                    ("signal-intent.json", "sigterm.json", "stopped-inspect.json", "stdout.log", "stderr.log"))
    if proof.get("pre_stop_sources") != proof.get("sources"):
        required.add(root + "/pre-stop-controller.py")
    require(set(proof["documents"]) == required, "Incomplete abandonment proof")
    for name, sha in proof["documents"].items():
        require(digest(control.read_bytes(name)) == sha, "Archived proof document changed")
    terminal_raw = control.read_bytes(_original_root(request) + "/terminal.json")
    terminal = strict_json(terminal_raw)
    require(digest(terminal_raw) == proof["terminal_sha256"]
            and control.read_bytes(_original_root(request) + "/receipt.json") == terminal_raw
            and terminal.get("state") == "failed-confirmed" and terminal.get("attempt") == request["original_attempt"]
            and terminal.get("diagnostic_abandon_request_sha256") == proof["request_sha256"]
            and terminal.get("scientific_claim_modified") is False, "Original helper terminal differs")
    require(control.read_bytes(root + "/final-terminal.json") == terminal_raw, "Terminal journal differs")
    observed = strict_json(control.read_bytes(root + "/observation.json"))
    require(observed.get("intent") == _request_intent(request)
            and digest(canonical(observed)) == request["expected_observation_sha256"]
            and observed.get("layers") == proof["layers"]
            and digest(canonical(observed["guest"]["protected"])) == proof["protected_sha256"], "Observation binding differs")
    phase, source_documents, _stops = _source_phase(control, request, context.lineage, observed, proof["request_sha256"])
    require(all(proof.get(key) == value for key, value in phase.items())
            and all(proof["documents"].get(path) == sha for path, sha in source_documents.items()),
            "Pre/post-stop source provenance differs")
    if not source_documents:
        require("pre_stop_controller_path" not in proof and "pre_stop_controller_sha256" not in proof,
                "Unexpected pre-stop archive authority")
    _no_handoff(control, context.lineage)


def _stop_documents(control, request, engine, request_sha):
    result = {}
    root = _root(request)
    for service in SERVICES:
        intent = strict_json(control.read_bytes(root + "/" + service + "/signal-intent.json"))
        require(intent == {"schema": "fullmag.succeeded-guest-sigterm-intent.v1", "request_sha256": request_sha,
                           "service": service, "pin": request[service], "signal": "SIGTERM", "escalation": False},
                "Signal intent differs")
        signal = strict_json(control.read_bytes(root + "/" + service + "/sigterm.json"))
        require(signal.get("engine_id_sha256") == engine and signal.get("exit_code") == 0
                and signal.get("argv") == ["kill", "--signal", "SIGTERM", request[service]["container_id"]]
                and signal.get("stdout", "").strip() == request[service]["container_id"]
                and not signal.get("stderr", "").strip(), "SIGTERM receipt differs")
        stopped_receipt = strict_json(control.read_bytes(root + "/" + service + "/stopped-inspect.json"))
        require(stopped_receipt.get("engine_id_sha256") == engine, "Stopped Engine receipt differs")
        stopped = base.inspect_receipt(stopped_receipt, request[service]["container_id"])
        validate_stopped(stopped, request[service], control.project, service)
        for suffix in ("signal-intent.json", "sigterm.json", "stopped-inspect.json", "stdout.log", "stderr.log"):
            path = root + "/" + service + "/" + suffix
            result[path] = digest(control.read_bytes(path))
    return result


def read_protected(control, lineage, backend):
    """Read exact protected mounts through a transient read-only managed helper."""
    from docker_build_control import bounded_capture
    command = ("exec python3 -B -c \"import sys;sys.path.insert(0,'/opt/fullmag/source/scripts');"
        "import docker_volume_succeeded_guest_abandon as c;import docker_volume_succeeded_namespace_guest as g;"
        "p=c.strict_json(sys.stdin.buffer.read());s,b=g.image_modules(p['guest']);"
        "print(c.canonical(c.protected_inventory(p,s.canonical_paths())).decode())\"")
    args = control.helper_args(command)
    insert = []
    roots = ["/state", "/host-ledger", "/opt/fullmag/runtime-control", "/opt/fullmag/source"]
    nested = "/state/runs/docker-all/session-store/runtime-services"
    if any(row.get("Destination") == nested for row in backend["Mounts"]):
        roots.append(nested)
    for root in roots:
        rows = [row for row in backend["Mounts"] if row["Destination"] == root]
        require(len(rows) == 1 and rows[0]["Type"] in ("bind", "volume"), "Protected mount mapping differs")
        row = rows[0]
        source = row["Source"] if row["Type"] == "bind" else row["Name"]
        mount = "type=" + row["Type"] + ",src=" + source + ",dst=" + root + ",readonly"
        if row["Type"] == "volume":
            mount += ",volume-nocopy"
            specs = [item for item in backend["HostConfig"].get("Mounts", []) if item.get("Target") == root]
            require(len(specs) == 1, "Protected volume subpath specification missing")
            subpath = specs[0].get("VolumeOptions", {}).get("Subpath")
            if subpath:
                require(not PurePosixPath(subpath).is_absolute() and ".." not in PurePosixPath(subpath).parts, "Unsafe volume subpath")
                mount += ",volume-subpath=" + subpath
        insert.extend(["--mount", mount])
    names = {"FULLMAG_HOST_LEDGER_ROOT", "FULLMAG_CONTAINER_STATE_ROOT", "FULLMAG_PROJECT_STORAGE_ROOT",
             "FULLMAG_RUNS_ROOT", "FULLMAG_RUNTIME_CONTROL_ROOT", "FULLMAG_STATE_ROOT",
             "FULLMAG_RUNTIME_SERVICES_ROOT", "FULLMAG_REPO_ROOT", "FULLMAG_RUNTIME_ROOT",
             "FULLMAG_RUNTIME_PROVENANCE"}
    environment = [value for value in backend["Config"]["Env"] if value.split("=", 1)[0] in names]
    require(len({value.split("=", 1)[0] for value in environment}) == len(environment)
            and any(value.startswith("FULLMAG_HOST_LEDGER_ROOT=") for value in environment),
            "Canonical path environment missing or ambiguous")
    for value in environment:
        insert.extend(["--env", value])
    args[args.index("--entrypoint"):args.index("--entrypoint")] = insert
    response = bounded_capture(args, data=canonical({"guest": lineage["guest"]}), timeout=300, maximum=base.MAX_BYTES)
    require(response.returncode == 0 and not response.stderr.strip(),
            "Protected read-only inventory refused: " + response.stderr.decode("utf-8", "replace")[-2048:])
    return strict_json(response.stdout)


def _validate_tar(raw, row):
    import io
    import tarfile
    require(len(raw) <= base.MAX_BYTES + 64 * 1024, "Stopped layer copy exceeds bound")
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        members = []
        for member in archive:
            members.append(member)
            require(len(members) <= 1, "Ambiguous stopped layer copy")
        require(len(members) == 1 and members[0].isreg() and not members[0].sparse
                and members[0].name == PurePosixPath(row["path"]).name
                and members[0].size == row["size"], "Stopped layer metadata changed")
        stream = archive.extractfile(members[0])
        require(stream is not None and digest(stream.read(base.MAX_BYTES + 1)) == row["sha256"], "Stopped payload changed")


def _validate_archived_layers(control, request, proof):
    for service in SERVICES:
        cid = request[service]["container_id"]
        current = docker_capture("diff", cid, timeout=120)
        inventory = proof["layers"][service]
        known, _special = _frontend_rows(inventory, service)
        require(not known["unknown_paths"], "Unknown stopped layer path")
        require(not current.stderr.strip() and base.canonical_layer_diff_sha256(current.stdout.decode())
                == inventory["canonical_diff_sha256"], "Stopped writable layer changed")
        for row in inventory["entries"]:
            if row.get("disposition") == "preserved-control-file":
                path = _root(request) + "/" + service + "/layer-files/" + row["sha256"] + ".bin"
                require(digest(control.read_bytes(path)) == row["sha256"], "Archived payload changed")
                _validate_tar(docker_capture("cp", cid + ":" + row["path"], "-", timeout=120).stdout, row)



def _inspect_optional(cid):
    result = docker_capture("inspect", cid, allow_failure=True, timeout=60)
    if result.returncode == 0:
        rows = json.loads(result.stdout)
        require(isinstance(rows, list) and len(rows) == 1 and rows[0].get("Id") == cid, "Ambiguous helper identity")
        return rows[0]
    receipt = {"argv": ["inspect", cid], "exit_code": result.returncode,
               "stdout": result.stdout.decode("utf-8", "strict"), "stderr": result.stderr.decode("utf-8", "strict")}
    base.validate_not_found(cid, receipt)
    return None


def validate_context(control, context, actual, selected, *, operation_helper_id=None):
    from docker_volume_container_recovery import _docker_engine_sha
    require(str(selected) == context.request["source_root"]
            and _docker_engine_sha() == context.proof["engine_id_sha256"], "Context source/Engine changed")
    _validate_proof_documents(control, context)
    require(_inspect_optional(context.original_helper_id) is None, "Original helper has not released its own operation")
    active = control.read_bytes("active", optional=True)
    if operation_helper_id is None:
        require(active is None, "Another operation is active")
    else:
        from docker_dev_recovery_build import inspect_one
        require(control._active_operation is not None
                and control._assert_live_operation_helper(control._active_operation) == operation_helper_id,
                "Fresh validation lacks its own authenticated operation lease")
        helper = inspect_one("container", operation_helper_id)
        attempt = helper.get("Name", "").removeprefix("/fullmag-control-")
        require(re.fullmatch(r"[0-9a-f]{32}", attempt or "") and active == (attempt + "\n").encode(),
                "New operation helper/active identity differs")
    for service in SERVICES:
        validate_stopped(actual[service], context.request[service], control.project, service)
    _consumers(control, context.request, operation_helper_id)
    _validate_archived_layers(control, context.request, context.proof)
    require(digest(canonical(read_protected(control, context.lineage, actual["backend"])))
            == context.proof["protected_sha256"], "Scientific/config/ledger evidence changed")


def _stop_services(control, request, lineage):
    from docker_dev_recovery_build import inspect_one
    root, helper = _root(request), request["helper"]["container_id"]
    engine = lineage["core"]["docker_engine_id_sha256"]
    for name in SERVICES:
        _helper(control, request, lineage); _no_handoff(control, lineage); _consumers(control, request, helper)
        intent_path = root + "/" + name + "/signal-intent.json"
        def signal():
            intent = {"schema": "fullmag.succeeded-guest-sigterm-intent.v1", "request_sha256": digest(canonical(request) + b"\n"),
                      "service": name, "pin": request[name], "signal": "SIGTERM", "escalation": False}
            require(_immutable(control, helper, intent_path, canonical(intent) + b"\n"), "Intent exists; no replay")
            receipt, _sha = base.engine_observe(control, root + "/" + name, "sigterm.json", engine,
                ["kill", "--signal", "SIGTERM", request[name]["container_id"]])
            require(receipt["exit_code"] == 0 and receipt["stdout"].strip() == request[name]["container_id"]
                    and not receipt["stderr"].strip(), "SIGTERM ACK missing")
            return True
        def wait():
            deadline = time.monotonic() + STOP_TIMEOUT
            while inspect_one("container", request[name]["container_id"])["State"]["Running"]:
                require(time.monotonic() < deadline, "SIGTERM timeout; no escalation or replay")
                time.sleep(0.2)
        signal_once(control, request, name, control.read_bytes(intent_path, optional=True),
                    lambda cid: inspect_one("container", cid), signal, wait)
        base.engine_observe(control, root + "/" + name, "stopped-inspect.json", engine,
                            ["inspect", request[name]["container_id"]])
        logs = docker_capture("logs", request[name]["container_id"], allow_failure=True, timeout=120)
        require(logs.returncode == 0, "Final container logs unavailable")
        _immutable(control, helper, root + "/" + name + "/stdout.log", logs.stdout)
        _immutable(control, helper, root + "/" + name + "/stderr.log", logs.stderr)



def _source_phase(control, request, lineage, observed, request_sha):
    """Separate the actual stop producer from a corrected post-stop reader.

    A reader bug fix cannot rewrite the successful preview's source pin. A
    changed controller is allowed only after both exact stop receipts exist,
    with the original controller archived verbatim and the base unchanged.
    This produces no new signal or retained-runtime authorization.
    """
    before, after = observed["sources"], lineage["sources"]
    controller = "docker_volume_succeeded_guest_abandon.py"
    original = "docker_volume_succeeded_namespace_recovery.py"
    require(isinstance(before, dict) and set(before) == {controller, original}
            and isinstance(after, dict) and set(after) == set(before)
            and all(isinstance(value, str) and base.SHA.fullmatch(value) for value in (*before.values(), *after.values()))
            and before[original] == after[original], "Original recovery source changed")
    stops = _stop_documents(control, request, lineage["core"]["docker_engine_id_sha256"], request_sha)
    phase = {"sources": after, "pre_stop_sources": before}
    documents = {}
    if before != after:
        path = _root(request) + "/pre-stop-controller.py"
        raw = control.read_bytes(path)
        require(digest(raw) == before[controller], "Original pre-stop controller archive differs")
        phase.update(pre_stop_controller_path=PREFIX + path, pre_stop_controller_sha256=before[controller])
        documents[path] = before[controller]
    return phase, documents, stops

def _finish(control, request, lineage, observed, request_sha):
    from docker_dev_recovery_build import inspect_one
    root, original = _root(request), _original_root(request)
    stopped = {name: inspect_one("container", request[name]["container_id"]) for name in SERVICES}
    for name in SERVICES:
        validate_stopped(stopped[name], request[name], control.project, name)
    phase, source_documents, stopped_documents = _source_phase(control, request, lineage, observed, request_sha)
    proof = {"schema": PROOF, "fresh_state_only": True, "retained_resume_authorized": False,
             "solve_replayed": False, "reservations_modified": False,
             "request_path": PREFIX + root + "/request.json", "request_sha256": request_sha,
             "compose_sha256": lineage["compose_sha256"], **phase,
             "engine_id_sha256": lineage["core"]["docker_engine_id_sha256"],
             "original_development_compose_sha256": digest(canonical(lineage["authored"])),
             "layers": observed["layers"], "protected_sha256": digest(canonical(observed["guest"]["protected"]))}
    _validate_archived_layers(control, request, proof)
    require(read_protected(control, lineage, stopped["backend"]) == observed["guest"]["protected"], "Protected evidence changed")
    terminal_raw = control.read_bytes(original + "/terminal.json", optional=True)
    if terminal_raw is None:
        ack = _helper(control, request, lineage)
        _consumers(control, request, request["helper"]["container_id"]); _no_handoff(control, lineage)
        current = control.read_bytes(original + "/receipt.json")
        planned_terminal = control.read_bytes(root + "/final-terminal.json", optional=True)
        require(current == lineage["receipt_raw"] or (planned_terminal is not None and current == planned_terminal),
                "Original START changed")
        terminal = {**lineage["receipt"], "state": "failed-confirmed",
                    "finished_at": max(stopped[name]["State"]["FinishedAt"] for name in SERVICES),
                    "diagnostic_abandon_request_sha256": request_sha, "observation_sha256": digest(canonical(observed)),
                    "log_ack_sha256": ack, "scientific_claim_modified": False, "fresh_state_only": True}
        terminal_raw = canonical(terminal) + b"\n"
        planned_terminal = control.read_bytes(root + "/final-terminal.json", optional=True)
        require(planned_terminal is None or planned_terminal == terminal_raw, "Final terminal intent differs")
        _immutable(control, request["helper"]["container_id"], root + "/final-terminal.json", terminal_raw)
        control.write_bytes(original + "/receipt.json", terminal_raw)
        control.write_bytes("succeeded-namespace-recreate/current.json", terminal_raw)
        _immutable(control, request["helper"]["container_id"], original + "/terminal.json", terminal_raw)
    terminal = strict_json(terminal_raw)
    require(terminal.get("state") == "failed-confirmed" and terminal.get("diagnostic_abandon_request_sha256") == request_sha
            and control.read_bytes(original + "/receipt.json") == terminal_raw, "Terminal decision differs")
    deadline = time.monotonic() + 30
    while _inspect_optional(request["helper"]["container_id"]) is not None:
        require(time.monotonic() < deadline, "Original helper finalization unknown")
        time.sleep(0.2)
    require(control.read_bytes("active", optional=True) is None, "Original helper retained active marker")
    _consumers(control, request)
    proof["terminal_sha256"] = digest(terminal_raw)
    documents = {root + "/request.json": request_sha,
                 root + "/original-unknown-receipt.json": request["original_receipt_sha256"],
                 root + "/observation.json": digest(canonical(observed) + b"\n"),
                 root + "/final-terminal.json": digest(terminal_raw)}
    documents.update(stopped_documents)
    documents.update(source_documents)
    proof["documents"] = documents
    raw = canonical(proof) + b"\n"
    previous = control.read_bytes(root + "/proof.json", optional=True)
    require(previous is None or previous == raw, "Fresh proof differs")
    if previous is None:
        control.write_bytes(root + "/proof.json", raw)
    print(json.dumps({"state": "failed-confirmed", "proof_path": PREFIX + root + "/proof.json", "proof_sha256": digest(raw)}))


def run(args):
    from docker_dev import _compose_identity, _select_source
    from docker_dev_recovery_build import inspect_one
    from docker_volume_dev import _validate_retained_service
    from docker_compose_identity import validate_source_labels
    selected, layout = _select_source(Path(args.source_root), args.source_root)
    control = BuildControl(_compose_identity(layout), args.image_id)
    request_path = PREFIX + args.request if args.request.startswith("verification/") else args.request
    raw = control.read_bytes(evidence_path(request_path))
    require(digest(raw) == args.request_sha256, "Request changed")
    request = validate_request(strict_json(raw))
    require(raw == canonical(request) + b"\n", "Request must use canonical JSON plus LF")
    require(request["source_root"] == str(selected) and request["image_id"] == args.image_id, "Source/image differs")
    lineage = load_lineage(control, request)
    root = _root(request)
    require(control.read_bytes(root + "/proof.json", optional=True) is None, "Proof already exists; use fresh-state reader")
    _no_handoff(control, lineage)
    terminal = control.read_bytes(_original_root(request) + "/terminal.json", optional=True)
    journal = control.read_bytes(root + "/observation.json", optional=True)
    if journal is None:
        require(terminal is None, "Terminal lacks this observation")
        ack = _helper(control, request, lineage)
        actual = {name: inspect_one("container", request[name]["container_id"]) for name in SERVICES}
        for name in SERVICES:
            base.require_container(actual[name], request[name], control.project, name)
            validate_source_labels(actual[name], control.identity)
            _validate_retained_service(lineage["compose"], actual[name], name,
                inspect_one("image", request[name]["image_id"]).get("Config", {}))
        _consumers(control, request, request["helper"]["container_id"])
        with diagnostic_fence(request, lineage) as (state, begin):
            layers = {name: layer_snapshot(request[name]["container_id"], name) for name in SERVICES}
            observed = observation(request, lineage, state, layers, ack)
            observed_sha = digest(canonical(observed))
            _immutable(control, request["helper"]["container_id"],
                       root + "/previews/" + observed_sha + ".json", canonical(observed) + b"\n")
            if not args.apply:
                print(json.dumps({"state": "preview-passed", "observation_sha256": observed_sha}))
                return
            require(request["expected_observation_sha256"] == observed_sha, "Exact read-only preview required")
            _helper(control, request, lineage); _no_handoff(control, lineage)
            for name in SERVICES:
                copy_layer_payloads(control, root + "/" + name, request[name]["container_id"], name, layers[name])
            _immutable(control, request["helper"]["container_id"], root + "/request.json", raw)
            _immutable(control, request["helper"]["container_id"], root + "/original-unknown-receipt.json", lineage["receipt_raw"])
            _immutable(control, request["helper"]["container_id"], root + "/observation.json", canonical(observed) + b"\n")
            begin()
            _stop_services(control, request, lineage)
    else:
        require(args.apply, "Interrupted abandonment requires explicit apply")
        observed = strict_json(journal)
        require(observed.get("intent") == _request_intent(request)
                and digest(canonical(observed)) == request["expected_observation_sha256"], "Journal differs")
        for name in SERVICES:
            require(control.read_bytes(root + "/" + name + "/signal-intent.json", optional=True) is not None,
                    "Interrupted pre-signal boundary; no blind replay")
            validate_stopped(inspect_one("container", request[name]["container_id"]), request[name], control.project, name)
    _finish(control, request, lineage, observed, args.request_sha256)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source-root", "image-id", "request", "request-sha256"):
        parser.add_argument("--" + name, required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--preview", action="store_true")
    mode.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        run(args)
    except (base.BuildControlError, OSError, ValueError, KeyError) as error:
        parser.exit(1, "Diagnostic abandonment refused: " + str(error) + "\n")


if __name__ == "__main__":
    main()
