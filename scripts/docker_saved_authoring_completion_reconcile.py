"""Inspect one saved-authoring iteration; publishing requires a shared writer fence."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from docker_build_control import BuildControlError, MAX_DOCUMENT_BYTES, canonical
import docker_volume_reconcile as legacy

SCHEMA = "fullmag.docker-saved-authoring-completion-reconciliation.v1"
EXIT_SCHEMA = "fullmag.host-controller-exit-observation.v1"
BINARIES = ("fullmag-api", "fullmag-bin", "fullmag-api-accepted-worker")
REQUEST_KEYS = {
    "schema", "attempt", "compose_project", "source_root", "port", "config_sha256",
    "retained_receipt_sha256", "controller_sha256", "completion_module_sha256",
    "containers", "package_documents", "checkpoint_sha256", "controller_exit_evidence",
}
PROCESS_KEYS = {"pid", "ppid", "start_token", "cmdline_sha256", "boot_id", "pid_namespace"}


def _require(condition, message):
    if not condition:
        raise BuildControlError("Saved-authoring completion: " + message)


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _document(raw):
    _require(isinstance(raw, bytes) and len(raw) <= MAX_DOCUMENT_BYTES, "unbounded document")
    def pairs(items):
        result = {}
        for key, value in items:
            _require(key not in result, "duplicate JSON key")
            result[key] = value
        return result
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs)
    except (UnicodeDecodeError, ValueError) as error:
        raise BuildControlError("Saved-authoring completion: malformed document") from error
    _require(isinstance(value, dict), "document must be an object")
    return value


def _legacy_request(request):
    return {
        "schema": legacy.SCHEMA, "attempt": request["attempt"],
        "compose_project": request["compose_project"], "source_root": request["source_root"],
        "port": request["port"], "config_sha256": request["config_sha256"],
        "unknown_receipt_sha256": request["retained_receipt_sha256"],
        "controller_sha256": request["controller_sha256"], "containers": request["containers"],
        "package_documents": {k: request["package_documents"][k] for k in ("receipt", "provenance")},
    }


def _validate_shape(request):
    _require(isinstance(request, dict) and set(request) == REQUEST_KEYS
             and request["schema"] == SCHEMA, "request schema/keys differ")
    for key in ("retained_receipt_sha256", "completion_module_sha256", "checkpoint_sha256"):
        _require(isinstance(request[key], str) and legacy.SHA.fullmatch(request[key]), "invalid " + key)
    package = request["package_documents"]
    _require(isinstance(package, dict) and set(package) == {"receipt", "provenance", "binary_hashes"},
             "package pins differ")
    hashes = package["binary_hashes"]
    _require(isinstance(hashes, dict) and set(hashes) == set(BINARIES)
             and all(isinstance(h, str) and legacy.SHA.fullmatch(h) for h in hashes.values()),
             "exact API/CLI/worker pins required")
    legacy.validate_request(_legacy_request(request))
    evidence = request["controller_exit_evidence"]
    _require(isinstance(evidence, dict)
             and set(evidence) == {"host_profile", "process_identity", "exit_observation_sha256"}
             and evidence["host_profile"] == "linux-native-v1"
             and isinstance(evidence["exit_observation_sha256"], str)
             and legacy.SHA.fullmatch(evidence["exit_observation_sha256"]), "exit evidence shape differs")
    identity = evidence["process_identity"]
    _require(isinstance(identity, dict) and set(identity) == PROCESS_KEYS
             and type(identity["pid"]) is int and 0 < identity["pid"] <= 2147483647
             and type(identity["ppid"]) is int and identity["ppid"] > 0
             and isinstance(identity["start_token"], str) and identity["start_token"].isdigit()
             and isinstance(identity["cmdline_sha256"], str) and legacy.SHA.fullmatch(identity["cmdline_sha256"])
             and all(isinstance(identity[k], str) and identity[k] for k in ("boot_id", "pid_namespace")),
             "exact Linux process identity required")


def _validate_controller(request, observed, receipt):
    evidence = request["controller_exit_evidence"]
    identity = evidence["process_identity"]
    _require(observed["host_boot_id"] == identity["boot_id"]
             and observed["pid_namespace"] == identity["pid_namespace"], "host process namespace changed")
    current = observed["controller_process"]
    _require(current is None or (current.get("boot_id") == identity["boot_id"]
             and current.get("pid_namespace") == identity["pid_namespace"]
             and current.get("start_token") != identity["start_token"]),
             "original host controller is still live or unproven")
    _require(observed["active_controllers"] == [], "another original controller is live")
    exit_raw = observed["controller_exit_raw"]
    _require(_sha(exit_raw) == evidence["exit_observation_sha256"], "exit observation CAS differs")
    value = _document(exit_raw)
    _require(set(value) == {"schema", "attempt", "process_identity", "exit_code",
                           "wait_completed", "launch_observation_sha256"}
             and value["schema"] == EXIT_SCHEMA and value["attempt"] == request["attempt"]
             and value["process_identity"] == identity and type(value["exit_code"]) is int
             and value["exit_code"] == 2 and value["wait_completed"] is True,
             "authenticated completed wait required")
    launch_raw = observed["controller_launch_raw"]
    _require(_sha(launch_raw) == value["launch_observation_sha256"], "launch observation CAS differs")
    launch = _document(launch_raw)
    _require(launch.get("attempt") == request["attempt"]
             and launch.get("process_identity") == identity, "original launch identity is missing or changed")
    command = launch.get("command")
    _require(isinstance(command, list) and len(command) == 8
             and all(isinstance(a, str) and "\x00" not in a for a in command)
             and Path(command[0]).is_absolute() and command[1] == "docker-dev-restart-saved-authoring"
             and command[2] == receipt["inputs"]["attempt"]
             and command[3] == request["config_sha256"] and command[4] == request["source_root"]
             and command[6] == request["checkpoint_sha256"] and command[7] == str(request["port"]),
             "original launch command differs")
    _require(_sha(b"\0".join(a.encode("utf-8") for a in command)+b"\0") == identity["cmdline_sha256"],
             "launch command does not match observed process")


def validate_saved_completion(request: dict, observation: dict) -> None:
    """Validate concrete observations, never caller-supplied readiness booleans."""
    _validate_shape(request)
    o = observation
    receipt = _document(o["receipt_raw"])
    document = _document(o["compose_raw"])
    checkpoint = _document(o["checkpoint_raw"])
    _require(_sha(o["receipt_raw"]) == request["retained_receipt_sha256"]
             and _sha(o["checkpoint_raw"]) == request["checkpoint_sha256"]
             and _sha(canonical(document)) == request["config_sha256"], "retained document CAS differs")
    _require(receipt.get("schema") == "fullmag.docker-build-operation.v1"
             and receipt.get("phase") == "iteration"
             and receipt.get("state") in {"restarting-idle-backend", "outcome-unknown-resources-retained"}
             and receipt.get("attempt") == request["attempt"]
             and receipt.get("compose_project") == request["compose_project"]
             and receipt.get("inputs", {}).get("source_root") == request["source_root"]
             and receipt["inputs"].get("config_sha256") == request["config_sha256"]
             and receipt["inputs"].get("saved_authoring_checkpoint_sha256") == request["checkpoint_sha256"]
             and receipt.get("saved_authoring_restore_required") == checkpoint.get("archive")
             and isinstance(checkpoint.get("archive"), dict), "original saved iteration binding differs")
    _require(o["controller_sha256"] == request["controller_sha256"]
             and o["completion_module_sha256"] == request["completion_module_sha256"], "controller code changed")
    _require(o["active"] == request["attempt"] and o["terminal_raw"] is None, "lease/terminal differs")
    _require(document.get("name") == request["compose_project"], "Compose project differs")
    env = document.get("services", {}).get("backend", {}).get("environment", {})
    ports = document.get("services", {}).get("frontend", {}).get("ports", [])
    _require(env.get("FULLMAG_STARTUP_ENABLED") == "0"
             and env.get("FULLMAG_SESSION_STORAGE_PROFILE") == "linux-native-v1"
             and env.get("FULLMAG_AUTO_CACHE_MAINTENANCE") == "1"
             and len(ports) == 1 and str(ports[0].get("published")) == str(request["port"])
             and ports[0].get("host_ip") == "127.0.0.1", "startup/storage/port differs")
    _require(o["certificate"].get("storage_profile") == "linux-native-v1"
             and o["ledger_profile"].get("profile") == "group-ledger-v1", "Linux private ledger required")
    for name in ("lease", "backend", "frontend"):
        legacy.validate_incarnation(o["containers"][name], request["containers"][name],
                                    request["compose_project"])
    owner = type("Owner", (), {"volume": receipt.get("control_volume")})()
    legacy.validate_original_owner(o["containers"]["lease"], receipt, owner,
                                  request["containers"]["lease"]["image"])
    _require(receipt.get("backend_started_at") == request["containers"]["backend"]["started_at"]
             and receipt.get("frontend_started_at") == request["containers"]["frontend"]["started_at"]
             and receipt["inputs"].get("image_id") == request["containers"]["backend"]["image"],
             "service incarnation binding differs")
    _require(o["containers"]["lease"]["Config"].get("Cmd") == o["expected_lease_command"],
             "original helper is not executing its image-owned operation")
    _require(o["archive_sha256"] == checkpoint["archive"].get("sha256"), "archived FMS changed")
    from docker_volume_offline_reconcile import _validate_group_ledger
    _validate_group_ledger(o["group_ledger"])
    _validate_controller(request, o, receipt)
    pins = request["package_documents"]
    package = o["package"]
    for name in ("receipt", "provenance"):
        _require(package[name]["sha256"] == pins[name]
                 and package[name]["value"].get("state") == "succeeded", "built " + name + " differs")
    provenance = package["provenance"]["value"]
    _require(provenance.get("build_receipt_sha256") == pins["receipt"]
             and provenance.get("binary_hashes") is not None, "package provenance binding differs")
    hashes = pins["binary_hashes"]
    _require(all(provenance["binary_hashes"].get(n) == hashes[n] for n in BINARIES)
             and o["loaded_api"]["package_hashes"] == hashes
             and o["loaded_api"]["running_api_sha256"] == hashes["fullmag-api"]
             and o["loaded_api"]["running_api_identity"] == o["loaded_api"]["published_api_identity"]
             and len(o["loaded_api"]["running_api_identity"]) == 2
             and all(type(i) is int and i > 0 for i in o["loaded_api"]["running_api_identity"]),
             "published or loaded binaries differ")
    _require(o["health"].get("status") == "ok" and o["health"].get("active_session") is False
             and o["queue"].get("items") == [], "workspace/queue is not idle")
    _require(o["retained_catalogs"] == checkpoint.get("retained_run_catalogs"),
             "retained history differs")


# Executed inside the already running backend; all operations are read-only.
_BACKEND_OBSERVATION = r"""
import fcntl,hashlib,json,os,stat,urllib.request
from pathlib import Path
def digest(path):
    h=hashlib.sha256()
    with open(path,"rb") as f:
        for chunk in iter(lambda:f.read(1024*1024),b""): h.update(chunk)
    return h.hexdigest()
def get(path):
    with urllib.request.urlopen("http://127.0.0.1:8081"+path,timeout=5) as response:
        assert response.status==200
        return json.load(response)
root=Path("/opt/fullmag/package/bin")
names=("fullmag-api","fullmag-bin","fullmag-api-accepted-worker")
hashes={name:digest(root/name) for name in names}
pids=[]
for path in Path("/proc").iterdir():
    if not path.name.isdigit(): continue
    try:
        if os.readlink(str(path/"exe")).split("/")[-1]=="fullmag-api": pids.append(path)
    except FileNotFoundError: pass
assert len(pids)==1,"ambiguous running API"
exe=pids[0]/"exe"
running=os.stat(exe);published=os.stat(root/"fullmag-api")
lock=Path("/host-ledger/ledger/WRITER.lock")
fd=os.open(str(lock),os.O_RDONLY|os.O_NOFOLLOW)
assert stat.S_ISREG(os.fstat(fd).st_mode) and os.fstat(fd).st_nlink==1
fcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)
ledger=Path("/host-ledger/ledger/HOST_RESOURCE_LEDGER.json")
with ledger.open("rb") as f: raw=f.read(8*1024*1024+1)
assert len(raw)<=8*1024*1024
result={"loaded_api":{"package_hashes":hashes,"running_api_sha256":digest(exe),
    "running_api_identity":[running.st_dev,running.st_ino],
    "published_api_identity":[published.st_dev,published.st_ino]},
    "group_ledger":json.loads(raw),"group_ledger_sha256":hashlib.sha256(raw).hexdigest(),
    "health":get("/v2/platform/health"),"queue":get("/v2/platform/compute/queue")}
print(json.dumps(result,sort_keys=True))
"""


def _controller_evidence(control, root, request):
    # These records must have been emitted by the launcher at launch/wait time.
    # Absence cannot be repaired from a stale PID or retrospective operator text.
    launch = legacy.read_raw(control, root + "/host-controller-launch.json", optional=True)
    _require(launch is not None, "original launch observation is unavailable")
    exit_raw = legacy.read_raw(control, root + "/host-controller-exit.json", optional=True)
    _require(exit_raw is not None, "original completed wait observation is unavailable")
    import os
    from docker_dev_failed_build_recovery import host_process
    pid = request["controller_exit_evidence"]["process_identity"]["pid"]
    try:
        current = host_process(pid)
    except FileNotFoundError:
        current = None
    active = []
    for directory in Path("/proc").iterdir():
        if not directory.name.isdigit() or directory.stat().st_uid != os.getuid():
            continue
        try:
            command = (directory / "cmdline").read_bytes().split(b"\0")
        except FileNotFoundError:
            continue
        original_command = (b"docker-dev-restart-saved-authoring" in command
            or (b"restart-idle-volume" in command
                and any(arg.endswith(b"/docker_dev.py") for arg in command)))
        if original_command and request["source_root"].encode() in command:
            active.append(host_process(int(directory.name)))
    return {"controller_launch_raw": launch, "controller_exit_raw": exit_raw,
            "controller_process": current, "active_controllers": active,
            "host_boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "pid_namespace": os.readlink("/proc/self/ns/pid")}


def _collect(control, selected, request):
    import docker_backend_volume_cache as cache_adapter
    import docker_volume_dev as dev
    import fullmag_docker_runtime as runtime
    root = "iteration/attempts/" + request["attempt"]
    current = legacy.read_raw(control, root + "/receipt.json")
    saved = legacy.read_raw(control, root + "/unknown-receipt.json", optional=True)
    original_raw = saved if saved is not None else current
    original = _document(original_raw)
    process = _controller_evidence(control, root, request)
    document = control.read(root + "/compose.json")
    checkpoint_raw = legacy.read_raw(control, root + "/saved-authoring-checkpoint.json")
    checkpoint = _document(checkpoint_raw)
    state = Path(original["state_root"])
    # The canonical archive reader validates containment, owner and both source pins.
    archive_raw, _ = dev._saved_authoring_read_archive(checkpoint, state)
    dev._saved_authoring_verify_retained_history(checkpoint, state)
    certificate = dev._retained_certificate(state, document)
    base = "development/attempts/" + original["inputs"]["attempt"]
    previous = control.read(base + "/terminal.json")
    _require(original.get("control_volume") == control.volume, "original control volume differs")
    _require(previous.get("state") == "succeeded"
             and previous.get("attempt") == original["inputs"]["attempt"]
             and previous.get("compose_project") == control.project
             and all(previous.get(key) == original.get(key) for key in
                     ("state_root", "backend_volumes", "frontend_volume"))
             and previous.get("config_sha256") == request["config_sha256"]
             and all(previous.get(name+"_container") == request["containers"][name]["id"]
                     for name in ("backend", "frontend")), "original development resources differ")
    image = request["containers"]["backend"]["image"]
    ledger = dev._retained_ledger_profile(control, base, document, image)
    _require(ledger.get("profile") == "group-ledger-v1", "private group ledger required")
    actual = legacy.inspect_pins(_legacy_request(request))
    image_config = _document(legacy.docker_capture("image", "inspect", image, "--format", "{{json .Config}}").stdout)
    for name in ("backend", "frontend"):
        dev._validate_retained_service(document, actual[name], name, image_config,
                                      expected_started_at=request["containers"][name]["started_at"])
    cache = control.read(base + "/backend-cache.json")
    cache_adapter.validate_container(actual["backend"], cache)
    dev._assert_private_restart_network(actual,
        {name: request["containers"][name]["id"] for name in ("backend", "frontend")}, control.project)
    package = _document(legacy.docker_capture("exec", actual["backend"]["Id"],
        "/usr/local/bin/python3", "-B", "-c", runtime._BACKEND_BUILD_DOCUMENTS_SCRIPT).stdout)
    native = _document(legacy.docker_capture("exec", actual["backend"]["Id"],
        "/usr/local/bin/python3", "-B", "-c", _BACKEND_OBSERVATION).stdout)
    expected_script = control.operation_script("iteration", request["attempt"])
    if control.namespace:
        expected_script = control._namespace_guard(expected_script)
    observation = {
        **process, **native, "receipt_raw": original_raw, "current_receipt_raw": current,
        "compose_raw": canonical(document), "checkpoint_raw": checkpoint_raw,
        "containers": actual, "package": package, "certificate": certificate,
        "ledger_profile": ledger, "retained_catalogs": checkpoint["retained_run_catalogs"],
        "archive_sha256": _sha(archive_raw), "active": legacy.read_raw(control,"active").decode("ascii").strip(),
        "terminal_raw": legacy.read_raw(control, root+"/terminal.json", optional=True),
        "controller_sha256": _sha(Path(legacy.__file__).read_bytes()),
        "completion_module_sha256": _sha(Path(__file__).read_bytes()),
        "expected_lease_command": ["-euo", "pipefail", "-c", expected_script],
    }
    return observation, {"document": document, "checkpoint": checkpoint, "state": state,
        "certificate": certificate, "certificate_path": dev._certificate_path(state),
        "cache": cache, "image": image, "ledger_profile": ledger}


def _plan_digest(request_raw, observed):
    # Health uptime/heartbeats are not execution identity. All persistent inputs,
    # actual binary/container identities and idle predicates are included.
    values = {k: observed[k] for k in (
        "controller_process", "active_controllers", "host_boot_id", "pid_namespace",
        "loaded_api", "certificate", "ledger_profile", "retained_catalogs",
        "archive_sha256", "expected_lease_command", "controller_sha256", "completion_module_sha256")}
    values.update(request_sha256=_sha(request_raw),
                  documents={k:_sha(observed[k]) for k in (
                      "receipt_raw","current_receipt_raw","compose_raw","checkpoint_raw",
                      "controller_launch_raw","controller_exit_raw")},
                  containers={k:legacy.fingerprint(v) for k,v in observed["containers"].items()},
                  package=observed["package"], group_ledger=observed["group_ledger"],
                  active=observed["active"], terminal_sha256=(
                      _sha(observed["terminal_raw"]) if observed["terminal_raw"] is not None else None),
                  health={"status":observed["health"].get("status"),
                          "active_session":observed["health"].get("active_session")},
                  queue=observed["queue"].get("items"))
    return _sha(canonical(values))


def reconcile_saved_completion(args, control, selected: Path, request: dict, request_raw: bytes) -> dict:
    _validate_shape(request)
    _require(_sha(request_raw) == args.request_sha256 and _document(request_raw) == request,
             "request CAS differs")
    _require(request["source_root"] == str(selected) and request["compose_project"] == control.project
             and request["port"] == args.port, "selected source/group/port differs")
    preview = getattr(args,"preview",False)
    pin = getattr(args,"preview_sha256",None)
    _require(not (preview and pin) and (preview or
             (isinstance(pin,str) and legacy.SHA.fullmatch(pin))), "exact apply preview digest required")
    root = "iteration/attempts/"+request["attempt"]
    recorded = _recorded_result(control,root,request,args.request_sha256)
    if recorded is not None:
        return recorded
    observed, context = _collect(control, selected, request)
    legacy.validate_partial_journal(control,root+"/reconciliation",observed["current_receipt_raw"],
                                   request["retained_receipt_sha256"],args.request_sha256)
    validate_saved_completion(request, observed)
    digest = _plan_digest(request_raw, observed)
    if preview:
        return {"schema":SCHEMA,"state":"validated-only","attempt":request["attempt"],
                "plan_sha256":digest,"apply_supported":False}
    _require(pin == digest, "preview digest changed")
    fresh, context = _collect(control, selected, request)
    validate_saved_completion(request, fresh)
    _require(_plan_digest(request_raw,fresh) == digest, "observation changed before publication")
    return _publish(args,control,selected,request,request_raw,fresh,context,digest)


def _recorded_result(control, root, request, request_sha):
    marker = legacy.read_raw(control, root+"/reconciliation/completion-v1.json", optional=True)
    if marker is None:
        return None
    record = _document(marker)
    _require(set(record) == {"schema","request_sha256","result_sha256"}
             and record["schema"] == SCHEMA and record["request_sha256"] == request_sha
             and isinstance(record["result_sha256"],str)
             and legacy.SHA.fullmatch(record["result_sha256"]), "partial journal belongs to another request")
    folder = root+"/reconciliation/"+record["result_sha256"]
    result_raw = legacy.read_raw(control,folder+"/result.json")
    _require(_sha(result_raw) == record["result_sha256"], "prepared result changed")
    legacy.validate_partial_journal(control,root+"/reconciliation",result_raw,
                                   request["retained_receipt_sha256"],request_sha)
    result = _document(result_raw)
    binding = result.get("reconciliation",{})
    _require(result.get("state") == "succeeded" and result.get("attempt") == request["attempt"]
             and binding.get("schema") == SCHEMA and binding.get("request_sha256") == request_sha
             and binding.get("retained_receipt_sha256") == request["retained_receipt_sha256"],
             "prepared completion binding changed")
    terminal = legacy.read_raw(control,root+"/terminal.json",optional=True)
    _require(terminal is not None, "partial journal retained; original observer must be inspected; no repeated finish")
    for path in (root+"/terminal.json",root+"/receipt.json","iteration/current.json","iteration/verified.json"):
        _require(legacy.read_raw(control,path) == result_raw,"partial publication is not fully committed")
    active = legacy.read_raw(control,"active",optional=True)
    _require(active is None or active.decode("ascii").strip() == request["attempt"],
             "active belongs to another operation")
    released = active is None
    return {"schema":SCHEMA,"state":"succeeded" if released else "completion-release-pending",
            "attempt":request["attempt"],"result_sha256":record["result_sha256"],
            "recorded_only":True,"lease_release_confirmed":released}


def _publish(args, control, selected, request, request_raw, observed, context, plan_sha):
    # The existing observer locks receipts, not the API/session/FMS writers.
    # No operator flag may substitute for a shared atomic writer fence.
    raise BuildControlError(
        "Saved-authoring completion has no atomic session/queue/archive fence; "
        "publication is unavailable, preview is read-only")
