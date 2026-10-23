"""Stop one pinned DEV backend that retains only a fenced diagnostic API.

This command preserves the failed native owner and all durable leases.  It
stops the exact backend supervisor/API pair after authenticating the failure
fence and proving that the native owner, schedulers, and workers are absent.
The resulting receipt deliberately records execution state as unknown.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from collections.abc import Mapping
from pathlib import Path
import re
import shlex
import sys
import time

from docker_build_control import (
    BuildControl,
    BuildControlError,
    canonical,
    compose_capture,
    control_read_script,
    docker_capture,
    toolchain_configuration,
)
from docker_dev_host import require_host


ATTEMPT_RE = re.compile(r"[0-9a-f]{32}\Z")
CONTAINER_RE = re.compile(r"[0-9a-f]{64}\Z")
IMAGE_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
MAX_EVIDENCE_BYTES = 1024 * 1024
PROCESS_RECEIPT_PATH = "/opt/fullmag/runtime-control/runtime-service/process-tree.json"
OWNER_PATH = "/opt/fullmag/runtime-control/runtime-services/OWNER.json"
RUNTIME_CONFIG_PATH = "/opt/fullmag/runtime-control/runtime-service/docker-all.json"
FENCE_PARENT = "/opt/fullmag/runtime-control/runtime-service"


def _fail(message: str) -> None:
    raise BuildControlError(message)


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _single_id(value: bytes, label: str) -> str:
    rows = value.decode("utf-8", "strict").splitlines()
    if len(rows) != 1 or CONTAINER_RE.fullmatch(rows[0]) is None:
        _fail("Compose did not identify one exact " + label)
    return rows[0]


def _port_matches(document: Mapping[str, object], port: int) -> None:
    services = document.get("services")
    frontend = services.get("frontend") if isinstance(services, Mapping) else None
    ports = frontend.get("ports") if isinstance(frontend, Mapping) else None
    if not isinstance(ports, list) or len(ports) != 1:
        _fail("Retained Compose frontend port is ambiguous")
    binding = ports[0]
    if (not isinstance(binding, Mapping)
            or binding.get("host_ip") != "127.0.0.1"
            or binding.get("target") != 8080
            or binding.get("protocol") != "tcp"
            or binding.get("mode") != "ingress"
            or binding.get("published") != str(port)):
        _fail("Requested port differs from the retained Compose frontend")


def _read_raw(control: BuildControl, relative: str, *, maximum: int = MAX_EVIDENCE_BYTES) -> bytes:
    from docker_volume_unclaimed_cancellation import _control_raw

    raw = _control_raw(control, relative, maximum=maximum)
    if raw is None:
        _fail("Required control-volume evidence is missing: " + relative)
    return raw


def _optional_sidecar_sha256(control: BuildControl, previous_root: str) -> str | None:
    from docker_volume_unclaimed_cancellation import _control_raw

    raw = _control_raw(
        control, previous_root + "/process-failure.json", optional=True,
        maximum=MAX_EVIDENCE_BYTES,
    )
    return _sha256(raw) if raw is not None else None


def _json(raw: bytes, label: str) -> dict[str, object]:
    from docker_volume_unclaimed_cancellation import _json_object

    return _json_object(raw, label, maximum=MAX_EVIDENCE_BYTES)


def _runtime_relative(path: object) -> str:
    if not isinstance(path, str) or not path.startswith(FENCE_PARENT + "/"):
        _fail("API failure fence is outside the canonical runtime-service directory")
    name = path[len(FENCE_PARENT) + 1 :]
    if re.fullmatch(r"api-failure-[0-9a-f]{32}\.json", name) is None:
        _fail("API failure fence filename is not an exact incarnation marker")
    return "runtime-control/runtime-service/" + name


def _validate_resume_terminal(
    control: BuildControl,
    resume_attempt: object,
    *,
    development_attempt: str,
    config_sha256: str,
    previous: Mapping[str, object],
    phase: str = "resume",
) -> dict[str, object]:
    if phase not in {"resume", "iteration"}:
        _fail("Unsupported backend continuation phase")
    if not isinstance(resume_attempt, str) or ATTEMPT_RE.fullmatch(resume_attempt) is None:
        _fail("Resume attempt is not a complete lowercase identity")
    relative = phase + "/attempts/" + resume_attempt + "/terminal.json"
    raw = _read_raw(control, relative)
    receipt = _json(raw, "retained resume terminal")
    inputs = receipt.get("inputs")
    previous_inputs = previous.get("inputs")
    expected_state_root = previous.get("state_root")
    expected_backend = previous.get("backend_container")
    expected_frontend = previous.get("frontend_container")
    image = previous_inputs.get("image_id") if isinstance(previous_inputs, Mapping) else None
    # A build can fail before _finish records the service IDs in the initial
    # development terminal. Its successful linked resume is then the identity
    # authority; validate that complete existing contract before adopting IDs.
    if expected_backend is None or expected_frontend is None:
        from docker_volume_activate import _validate_linked_runtime_terminal
        _validate_linked_runtime_terminal(
            receipt, phase=phase, original_attempt=development_attempt,
            original=previous, source_root=previous_inputs.get("source_root"),
            image=image, config_sha256=config_sha256,
        )
        expected_backend = expected_backend or receipt.get("backend_container")
        expected_frontend = expected_frontend or receipt.get("frontend_container")
    cgroup = receipt.get("worker_cgroup")
    if (
        receipt.get("schema") != "fullmag.docker-build-operation.v1"
        or receipt.get("phase") != phase
        or receipt.get("state") != "succeeded"
        or receipt.get("attempt") != resume_attempt
        or receipt.get("compose_project") != control.project
        or receipt.get("control_volume") != control.volume
        or receipt.get("config_sha256") != config_sha256
        or not isinstance(inputs, Mapping)
        or inputs.get("attempt") != development_attempt
        or inputs.get("config_sha256") != config_sha256
        or not isinstance(expected_state_root, str)
        or not expected_state_root
        or receipt.get("state_root") != expected_state_root
        or not isinstance(expected_backend, str)
        or CONTAINER_RE.fullmatch(expected_backend) is None
        or receipt.get("backend_container") != expected_backend
        or not isinstance(expected_frontend, str)
        or CONTAINER_RE.fullmatch(expected_frontend) is None
        or receipt.get("frontend_container") != expected_frontend
        or not isinstance(image, str)
        or IMAGE_RE.fullmatch(image) is None
        or not isinstance(cgroup, Mapping)
        or cgroup.get("schema") != "fullmag.worker-cgroup-ready.v1"
        or cgroup.get("compose_project") != control.project
        or cgroup.get("container_id") != expected_backend
        or cgroup.get("image_id") != image
        or cgroup.get("state") != "ready"
        or cgroup.get("root") != "/opt/fullmag/worker-cgroup"
    ):
        _fail("Resume terminal is not the exact successful continuation of this development attempt")
    expected_namespace = previous.get("control_namespace")
    if control.namespace:
        if (expected_namespace != control.namespace
                or receipt.get("control_namespace") != control.namespace):
            _fail("Resume terminal belongs to a different control namespace")
    elif "control_namespace" in receipt or "control_namespace" in previous:
        _fail("Resume terminal or development attempt has an unexpected control namespace")
    started_at = receipt.get("backend_started_at")
    if not isinstance(started_at, str) or not started_at:
        _fail("Resume terminal does not pin the backend start time")
    return {
        "attempt": resume_attempt,
        "phase": phase,
        "relative": relative,
        "sha256": _sha256(raw),
        "backend_started_at": started_at,
        "backend_container": expected_backend,
        "frontend_container": expected_frontend,
    }


def _probe_script() -> str:
    return r'''import base64, hashlib, json, os, pathlib, re, stat, sys, urllib.request

MAX=1024*1024
PROCESS='/opt/fullmag/runtime-control/runtime-service/process-tree.json'
OWNER='/opt/fullmag/runtime-control/runtime-services/OWNER.json'
CONFIG='/opt/fullmag/runtime-control/runtime-service/docker-all.json'
FENCE_PARENT=pathlib.Path('/opt/fullmag/runtime-control/runtime-service')

def regular(path, label, maximum=MAX):
    path=pathlib.Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise RuntimeError(label+' path is not canonical')
    if path.parent.resolve(strict=True) != path.parent:
        raise RuntimeError(label+' parent is not canonical')
    fd=os.open(path, os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
    try:
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > maximum:
            raise RuntimeError(label+' is not a bounded regular file')
        raw=os.read(fd, maximum+1)
        if len(raw)>maximum:
            raise RuntimeError(label+' exceeds its byte bound')
        return raw
    finally: os.close(fd)

def unique(pairs):
    value={}
    for key,item in pairs:
        if key in value: raise RuntimeError('duplicate JSON key')
        value[key]=item
    return value

def obj(raw,label):
    try: value=json.loads(raw.decode('utf-8'), object_pairs_hook=unique)
    except (UnicodeDecodeError,json.JSONDecodeError) as error:
        raise RuntimeError(label+' is invalid JSON') from error
    if not isinstance(value,dict): raise RuntimeError(label+' is not an object')
    return value

process_raw=regular(PROCESS,'process receipt')
owner_raw=regular(OWNER,'runtime owner')
config_raw=regular(CONFIG,'runtime configuration')
process=obj(process_raw,'process receipt')
owner=obj(owner_raw,'runtime owner')
config=obj(config_raw,'runtime configuration')
if (process.get('schema')!='fullmag.docker-process-tree.v1'
        or process.get('state')!='failed_outcome_retained'
        or process.get('api_diagnostic_only') is not True
        or process.get('runtime_pid') is not None
        or not isinstance(process.get('service_owner'),dict)
        or 'terminal_service_owner' in process):
    raise RuntimeError('process receipt is not the exact retained diagnostic-only API state')
if type(process.get('api_pid')) is not int or process['api_pid']<=0:
    raise RuntimeError('retained diagnostic API pid is invalid')
if not isinstance(process.get('error'),str) or not process['error']:
    raise RuntimeError('retained process receipt has no failure detail')
if (config.get('schema_version')!='runtime_service_config.v2'
        or config.get('target_id')!='docker-all'
        or config.get('store_root')!='/state/runs/docker-all/session-store'):
    raise RuntimeError('runtime configuration is not bound to the managed store')

sys.path.insert(0,'/opt/fullmag')
import runtime_service
paths=runtime_service.canonical_paths()
runtime_service._validate_terminal_owner(
    owner,state='failed',name='retained failed runtime owner',
    allowed_child_statuses=('exited_success','exited_failure'))
ready_owner=process['service_owner']
runtime_service._validate_terminal_owner(ready_owner,state='ready',name='retained ready owner pin')
if (runtime_service._owner_identity(ready_owner)!=runtime_service._owner_identity(owner)
        or runtime_service._owner_child_identity(ready_owner)!=runtime_service._owner_child_identity(owner)):
    raise RuntimeError('retained ready owner pin differs from the failed OWNER identity')
if runtime_service._read_json(paths.config,'runtime service configuration')!=config:
    raise RuntimeError('runtime configuration changed during read')

failure_path=process.get('api_failure_fence')
if (not isinstance(failure_path,str) or pathlib.Path(failure_path).parent!=FENCE_PARENT
        or FENCE_PARENT.resolve(strict=True)!=FENCE_PARENT):
    raise RuntimeError('runtime receipt does not bind a canonical API failure fence')
failure_name=pathlib.Path(failure_path).name
if re.fullmatch(r'api-failure-[0-9a-f]{32}\.json',failure_name) is None:
    raise RuntimeError('API failure fence filename is invalid')
fence_raw=regular(failure_path,'API failure fence',256*1024)
fence=obj(fence_raw,'API failure fence')
api_pid=process['api_pid']
api_instance=fence.get('api_instance_id')
if (fence.get('schema')!='fullmag.api-runtime-failure-fence.v1'
        or fence.get('stage')!='runtime_supervision'
        or fence.get('api_pid')!=api_pid
        or not isinstance(api_instance,str)
        or re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',api_instance) is None):
    raise RuntimeError('API failure fence is not bound to this runtime-supervision failure')

owner_pids=[owner.get('pid')]
children=owner.get('children')
if not isinstance(children,list) or len(children)!=2:
    raise RuntimeError('failed owner does not identify both native schedulers')
for child in children:
    if not isinstance(child,dict) or type(child.get('pid')) is not int:
        raise RuntimeError('failed owner child identity is invalid')
    owner_pids.append(child['pid'])
if any(type(pid) is not int or pid<=0 or pathlib.Path('/proc/'+str(pid)).exists()
       for pid in owner_pids):
    raise RuntimeError('failed owner or a native scheduler is still present in /proc')

def proc(pid):
    root=pathlib.Path('/proc')/str(pid)
    status=(root/'status').read_text(encoding='utf-8')
    match=re.search(r'^PPid:\s+(\d+)$',status,re.MULTILINE)
    if match is None: raise RuntimeError('process parent identity is unavailable')
    return {
        'pid':pid,
        'ppid':int(match.group(1)),
        'comm':(root/'comm').read_text(encoding='utf-8').strip(),
        'exe':os.readlink(root/'exe'),
        'argv':(root/'cmdline').read_bytes().split(b'\0'),
    }

rows=[]
for item in pathlib.Path('/proc').iterdir():
    if item.name.isdigit(): rows.append(proc(int(item.name)))
by_pid={row['pid']:row for row in rows}
self_pid=os.getpid()
if self_pid not in by_pid: raise RuntimeError('current bounded probe is absent from /proc')
init=by_pid.get(1)
if init is None or init['comm'] not in {'docker-init','tini'}:
    raise RuntimeError('container init identity is unexpected')
supervisors=[row for row in rows if row['pid']!=1 and any(
    arg==b'/opt/fullmag/entrypoint.py' for arg in row['argv'])]
if len(supervisors)!=1:
    raise RuntimeError('backend supervisor process is missing or ambiguous')
supervisor=supervisors[0]
if supervisor['ppid']!=1 or not pathlib.Path(supervisor['exe']).name.startswith('python3'):
    raise RuntimeError('backend supervisor parent or executable differs')
api=by_pid.get(api_pid)
if api is None or api['ppid']!=supervisor['pid'] or not api['exe'].endswith('/fullmag-api'):
    raise RuntimeError('retained API process identity differs from its receipt')
if len({1,supervisor['pid'],api_pid,self_pid})!=4 or set(by_pid)!={1,supervisor['pid'],api_pid,self_pid}:
    raise RuntimeError('container has a process beyond init, supervisor, fenced API, and this probe')
environment=(pathlib.Path('/proc')/str(api_pid)/'environ').read_bytes().split(b'\0')
if b'FULLMAG_API_RUNTIME_FAILURE_FENCE='+failure_path.encode() not in environment:
    raise RuntimeError('API process environment does not contain its exact failure-fence path')

with urllib.request.urlopen('http://127.0.0.1:8081/v2/platform/health',timeout=5) as response:
    health=obj(response.read(256*1024),'API health')
    if (response.status!=200 or health.get('status')!='degraded'
            or response.headers.get('x-fullmag-api-instance')!=api_instance):
        raise RuntimeError('API health does not acknowledge the exact diagnostic fence')

print(json.dumps({
    'schema':'fullmag.docker-api-diagnostic-stop-probe.v1',
    'runtime_config':base64.b64encode(config_raw).decode('ascii'),
    'owner':base64.b64encode(owner_raw).decode('ascii'),
    'process_receipt':base64.b64encode(process_raw).decode('ascii'),
    'failure_fence':base64.b64encode(fence_raw).decode('ascii'),
    'api_pid':api_pid,'api_instance_id':api_instance,
    'api_failure_fence':failure_path,
    'owner_pids_absent':sorted(owner_pids),
    'process_ids':[1,supervisor['pid'],api_pid,self_pid],
    'health_status':'degraded',
},sort_keys=True,separators=(',',':')))
'''


def _decode_probe(probe: Mapping[str, object], name: str) -> bytes:
    value = probe.get(name)
    if not isinstance(value, str):
        _fail("In-container diagnostic probe omitted " + name)
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise BuildControlError("In-container diagnostic probe returned invalid " + name) from error
    if len(raw) > MAX_EVIDENCE_BYTES:
        _fail("In-container diagnostic evidence exceeds its byte bound")
    return raw


def _probe_backend(backend_id: str) -> dict[str, object]:
    result = docker_capture(
        "exec", backend_id, "/usr/local/bin/python3", "-B", "-c", _probe_script(),
        timeout=30,
    )
    try:
        probe = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Diagnostic-only backend probe returned invalid JSON") from error
    if (not isinstance(probe, dict)
            or probe.get("schema") != "fullmag.docker-api-diagnostic-stop-probe.v1"):
        _fail("Diagnostic-only backend probe has an unsupported schema")
    return probe


def _probe_evidence(control: BuildControl, previous_root: str, probe: Mapping[str, object]):
    from docker_volume_stop_failed import (
        _owner_identity_key,
        _validate_native_failed_owner,
        _validate_native_ready_owner,
    )

    config_raw = _read_raw(control, "runtime-control/runtime-service/docker-all.json", maximum=256 * 1024)
    owner_raw = _read_raw(control, "runtime-control/runtime-services/OWNER.json", maximum=256 * 1024)
    process_raw = _read_raw(control, "runtime-control/runtime-service/process-tree.json")
    from docker_volume_unclaimed_cancellation import _control_raw
    sidecar_raw = _control_raw(
        control, previous_root + "/process-failure.json", optional=True,
        maximum=MAX_EVIDENCE_BYTES,
    )
    config = _json(config_raw, "runtime service configuration")
    owner = _json(owner_raw, "retained failed runtime owner")
    process = _json(process_raw, "retained diagnostic process receipt")
    sidecar = _json(sidecar_raw, "retained process-failure sidecar") if sidecar_raw is not None else None
    fence_path = probe.get("api_failure_fence")
    relative = _runtime_relative(fence_path)
    fence_raw = _read_raw(control, relative, maximum=256 * 1024)
    fence = _json(fence_raw, "API failure fence")
    probe_config = _decode_probe(probe, "runtime_config")
    probe_owner = _decode_probe(probe, "owner")
    probe_process = _decode_probe(probe, "process_receipt")
    probe_fence = _decode_probe(probe, "failure_fence")
    if (probe_config != config_raw or probe_owner != owner_raw
            or probe_process != process_raw or probe_fence != fence_raw):
        _fail("In-container diagnostic observation differs from canonical control-volume bytes")
    if sidecar is not None and sidecar != process:
        _fail("Retained attempt process-failure sidecar differs from the current process receipt")
    if (config.get("schema_version") != "runtime_service_config.v2"
            or config.get("target_id") != "docker-all"
            or config.get("store_root") != "/state/runs/docker-all/session-store"):
        _fail("Runtime configuration is not bound to the selected accepted store")
    failed_owner = _validate_native_failed_owner(
        owner, allowed_child_statuses=frozenset({"exited_success", "exited_failure"})
    )
    if (process.get("schema") != "fullmag.docker-process-tree.v1"
            or process.get("state") != "failed_outcome_retained"
            or process.get("api_diagnostic_only") is not True
            or process.get("runtime_pid") is not None
            or not isinstance(process.get("service_owner"), Mapping)
            or "terminal_service_owner" in process
            or type(process.get("api_pid")) is not int or process["api_pid"] <= 0
            or process.get("api_failure_fence") != fence_path):
        _fail("Process receipt does not prove a retained diagnostic-only API and ready-owner pin")
    if (fence.get("schema") != "fullmag.api-runtime-failure-fence.v1"
            or fence.get("stage") != "runtime_supervision"
            or fence.get("api_pid") != process.get("api_pid")
            or fence.get("api_instance_id") != probe.get("api_instance_id")):
        _fail("API failure marker is not bound to the retained API incarnation")
    ready_owner = _validate_native_ready_owner(process["service_owner"])
    if _owner_identity_key(ready_owner, "retained ready owner") != _owner_identity_key(
        failed_owner, "failed owner"
    ):
        _fail("Failed OWNER identity differs from the retained ready-owner pin")
    return {
        "runtime_config_sha256": _sha256(config_raw),
        "failed_owner_sha256": _sha256(owner_raw),
        "process_receipt_sha256": _sha256(process_raw),
        "process_failure_sidecar_sha256": _sha256(sidecar_raw) if sidecar_raw is not None else None,
        "api_failure_fence_sha256": _sha256(fence_raw),
        "runtime_config": config,
        "failed_owner": failed_owner,
        "ready_owner": ready_owner,
        "process_receipt": process,
        "api_failure_fence": fence,
        "api_failure_fence_relative": relative,
        "probe": dict(probe),
    }


def _container_snapshot(args, selected, identity, control, previous, document, *, allow_stopped_backend=False):
    from docker_compose_identity import validate_source_labels
    from docker_volume_dev import _validate_retained_service
    from docker_volume_stop_unadmitted import _validate_network

    services = document.get("services")
    if not isinstance(services, Mapping) or set(services) != {"backend", "frontend"}:
        _fail("Retained Compose must contain exactly the fixed backend/frontend pair")
    image = previous.get("inputs", {}).get("image_id")
    if not isinstance(image, str) or IMAGE_RE.fullmatch(image) is None:
        _fail("Retained attempt has no immutable development image identity")
    ids = {
        service: _single_id(compose_capture(document, "ps", "--all", "--quiet", service), service)
        for service in ("backend", "frontend")
    }
    for service in ids:
        recorded = previous.get(service + "_container")
        if recorded is not None and recorded != ids[service]:
            _fail("Retained attempt names a different " + service + " incarnation")
    inspected = json.loads(docker_capture("inspect", ids["backend"], ids["frontend"]).stdout)
    by_id = {row.get("Id"): row for row in inspected if isinstance(row, Mapping)}
    if set(by_id) != set(ids.values()):
        _fail("Compose service inspection is incomplete or ambiguous")
    actual = {service: by_id[identifier] for service, identifier in ids.items()}
    image_rows = json.loads(docker_capture("image", "inspect", image).stdout)
    if len(image_rows) != 1 or not isinstance(image_rows[0].get("Config"), Mapping):
        _fail("Retained development image inspection is incomplete")
    image_config = image_rows[0]["Config"]
    for service, identifier in ids.items():
        row = actual[service]
        labels = row.get("Config", {}).get("Labels", {})
        if (row.get("Id") != identifier or row.get("Image") != image
                or labels.get("com.docker.compose.project") != control.project
                or labels.get("com.docker.compose.service") != service):
            _fail("Retained service identity differs from its Compose/source pin")
        validate_source_labels(row, identity)
        _validate_retained_service(
            document, row, service, image_config,
            expected_started_at=(previous.get("backend_started_at") if service == "backend" else None),
        )
        if (row.get("State", {}).get("Running") is not True
                and not (allow_stopped_backend and service == "backend"
                         and row.get("State", {}).get("Running") is False)):
            _fail("Diagnostic stop requires both exact Compose services running")
    if (actual["backend"].get("State", {}).get("StartedAt")
            != previous.get("backend_started_at")):
        _fail("Backend incarnation differs from the failed start receipt")
    _validate_network(
        actual, ids, control.project,
        allow_stopped_backend=(allow_stopped_backend and actual["backend"].get("State", {}).get("Running") is False),
    )
    return image, ids, actual


def _assert_group_consumers(control: BuildControl, operation, ids: Mapping[str, str]) -> str:
    from docker_volume_unclaimed_cancellation import _project_container_ids, _volume_consumer_ids
    from docker_compose_identity import validate_source_labels

    receipt = operation.get("receipt", {})
    attempt = receipt.get("attempt")
    name = receipt.get("helper_container")
    if (not isinstance(attempt, str) or ATTEMPT_RE.fullmatch(attempt) is None
            or name != "fullmag-control-" + attempt):
        _fail("Diagnostic stop lease has no exact BuildControl helper identity")
    rows = json.loads(docker_capture("inspect", name).stdout)
    if len(rows) != 1:
        _fail("Diagnostic stop BuildControl helper is ambiguous")
    helper = rows[0]
    config = helper.get("Config", {})
    labels = config.get("Labels", {})
    if (helper.get("Id") is None or not CONTAINER_RE.fullmatch(helper["Id"])
            or config.get("Image") != control.image
            or labels.get("com.docker.compose.project") != control.project
            or labels.get("com.docker.compose.service") != "build-control"
            or labels.get("org.fullmag.compose.project") != control.project
            or helper.get("State", {}).get("Running") is not True
            or helper.get("HostConfig", {}).get("NetworkMode") != "none"):
        _fail("Diagnostic stop BuildControl helper does not match its private lease")
    validate_source_labels(helper, control.identity)
    mounts = helper.get("Mounts")
    control_mounts = [item for item in mounts if isinstance(item, Mapping)
                      and item.get("Destination") == "/control"] if isinstance(mounts, list) else []
    if (len(control_mounts) != 1 or control_mounts[0].get("Type") != "volume"
            or control_mounts[0].get("Name") != control.volume):
        _fail("Diagnostic stop helper does not mount the selected control volume")
    command = config.get("Cmd")
    command_text = " ".join(command) if isinstance(command, list) and all(
        isinstance(item, str) for item in command
    ) else ""
    if ("/control/stop-diagnostic/attempts/" + attempt not in command_text
            or "until test -f" not in command_text or "/control/active" not in command_text):
        _fail("BuildControl helper is not holding this exact diagnostic stop lease")
    expected = set(ids.values()) | {helper["Id"]}
    if (_project_container_ids(control.project) != expected
            or _volume_consumer_ids(control.volume) != expected):
        _fail("Compose group or control volume has another consumer")
    return helper["Id"]


def _terminal_receipt(control: BuildControl, operation, backend_id: str,
                      before: Mapping[str, object], stopped: Mapping[str, object],
                      resume_pin: Mapping[str, object] | None = None) -> dict[str, object]:
    state = stopped.get("State")
    if (stopped.get("Id") != backend_id
            or stopped.get("Image") != operation["receipt"].get("image_id")
            or not isinstance(state, Mapping)
            or state.get("Running") is not False
            or state.get("OOMKilled") is not False
            or type(state.get("ExitCode")) is not int
            or not isinstance(state.get("FinishedAt"), str)
            or not state["FinishedAt"]):
        _fail("Backend stop outcome is not confirmed for the exact retained incarnation")
    process_raw = _read_raw(control, "runtime-control/runtime-service/process-tree.json")
    owner_raw = _read_raw(control, "runtime-control/runtime-services/OWNER.json", maximum=256 * 1024)
    fence_raw = _read_raw(control, before["api_failure_fence_relative"], maximum=256 * 1024)
    process = _json(process_raw, "terminal diagnostic process receipt")
    if (process.get("schema") != "fullmag.docker-process-tree.v1"
            or process.get("state") != "shutdown_unknown"
            or process.get("runtime_pid") is not None
            or type(process.get("api_exit_code")) is not int
            or process.get("api_diagnostic_only") is not True
            or process.get("api_pid") != before["process_receipt"].get("api_pid")
            or process.get("api_failure_fence") != before["process_receipt"].get("api_failure_fence")
            or process.get("shutdown_error") != "runtime service owner is not ready"
            or not isinstance(process.get("service_owner"), Mapping)
            or "terminal_service_owner" in process):
        _fail("Stopped diagnostic supervisor did not publish canonical shutdown_unknown evidence")
    from docker_volume_stop_failed import _owner_identity_key, _validate_native_ready_owner
    ready_owner = _validate_native_ready_owner(process["service_owner"])
    if _owner_identity_key(ready_owner, "terminal ready-owner pin") != _owner_identity_key(
        before["failed_owner"], "preserved failed owner"
    ):
        _fail("Terminal ready-owner pin differs from the preserved failed OWNER")
    config_raw = _read_raw(control, "runtime-control/runtime-service/docker-all.json", maximum=256 * 1024)
    if (_sha256(config_raw) != before["runtime_config_sha256"]
            or _sha256(owner_raw) != before["failed_owner_sha256"]
            or _sha256(fence_raw) != before["api_failure_fence_sha256"]):
        _fail("Failed owner or API failure fence changed while stopping the diagnostic API")
    receipt = {
        "schema": "fullmag.docker-api-diagnostic-stop.v1",
        "state": "stopped-execution-unknown",
        "attempt": operation["receipt"]["inputs"]["attempt"],
        "config_sha256": operation["receipt"]["inputs"]["config_sha256"],
        "backend_container_id": backend_id,
        "backend_image_id": stopped.get("Image"),
        "backend_started_at": stopped.get("State", {}).get("StartedAt"),
        "backend_finished_at": state["FinishedAt"],
        "backend_exit_code": state["ExitCode"],
        "frontend_container_id": operation["receipt"]["inputs"]["frontend_container_id"],
        "runtime_owner_state": "failed-preserved",
        "execution_state": "unknown",
        "resource_leases": "untouched",
        "runtime_config_sha256": before["runtime_config_sha256"],
        "failed_owner_sha256": before["failed_owner_sha256"],
        "failure_process_receipt_sha256": before["process_receipt_sha256"],
        "terminal_process_receipt_sha256": _sha256(process_raw),
        "api_failure_fence_sha256": before["api_failure_fence_sha256"],
        "api_instance_id": before["probe"]["api_instance_id"],
        "api_exit_code": process["api_exit_code"],
        "shutdown_error": process["shutdown_error"],
        "retained_ready_owner": ready_owner,
    }
    if resume_pin is not None:
        receipt["resume_attempt"] = resume_pin["attempt"]
        receipt["resume_terminal_sha256"] = resume_pin["sha256"]
        receipt["continuation_phase"] = resume_pin.get("phase", "resume")
    control.write(operation["root"] + "/diagnostic-stop-terminal.json", receipt)
    return receipt


def _read_from_original_helper(
    control: BuildControl,
    helper_id: str,
    relative: str,
    *,
    optional: bool = False,
    maximum: int = MAX_EVIDENCE_BYTES,
) -> bytes | None:
    if not isinstance(helper_id, str) or CONTAINER_RE.fullmatch(helper_id) is None:
        _fail("Original stop-diagnostic helper ID is not canonical")
    script = control._namespace_guard(
        control_read_script(control.path(relative), maximum)
    )
    result = docker_capture(
        "exec", "--user", "65532:65532", helper_id,
        "/bin/bash", "-euo", "pipefail", "-c", script,
        timeout=90, allow_failure=True,
    )
    if optional and result.returncode == 44:
        return None
    if result.returncode:
        _fail("Original helper could not read pinned control evidence: " + relative)
    raw = bytes(result.stdout)
    if len(raw) > maximum:
        _fail("Original helper returned oversized control evidence: " + relative)
    return raw


def _assert_read_timeout_attempt(
    control: BuildControl,
    helper_id: str,
    attempt: str,
    operation_inputs: Mapping[str, object],
    *,
    active_raw: bytes,
    receipt_raw: bytes,
) -> dict[str, object]:
    root = "stop-diagnostic/attempts/" + attempt
    if active_raw != (attempt + "\n").encode("ascii"):
        _fail("Original stop-diagnostic active marker differs from the named attempt")
    receipt = _json(receipt_raw, "retained stop-diagnostic receipt")
    expected_name = "fullmag-control-" + attempt
    expected_error = (
        "Docker observation exceeded its time/output budget during "
        "_control_raw (timeout=90s); daemon resources retained"
    )
    if (
        receipt.get("schema") != "fullmag.docker-build-operation.v1"
        or receipt.get("phase") != "stop-diagnostic"
        or receipt.get("state") != "outcome-unknown-resources-retained"
        or receipt.get("attempt") != attempt
        or receipt.get("compose_project") != control.project
        or receipt.get("control_volume") != control.volume
        or receipt.get("helper_container") != expected_name
        or receipt.get("error") != expected_error
        or not isinstance(receipt.get("inputs"), Mapping)
        or dict(receipt["inputs"]) != dict(operation_inputs)
    ):
        _fail("Old operation is not the exact preflight control-read timeout for these pins")
    if control.namespace:
        if (receipt.get("control_namespace") != control.namespace
                or receipt.get("namespace_registry_sha256") != control.namespace_registry_sha256):
            _fail("Old stop-diagnostic operation belongs to a different control namespace")
    elif "control_namespace" in receipt or "namespace_registry_sha256" in receipt:
        _fail("Old stop-diagnostic operation unexpectedly carries a control namespace")
    if expected_name != receipt.get("helper_container"):
        _fail("Old stop-diagnostic operation helper identity differs")

    for name in ("terminal.json", "diagnostic-stop-preflight.json", "diagnostic-stop-terminal.json"):
        if _read_from_original_helper(
            control, helper_id, root + "/" + name, optional=True
        ) is not None:
            _fail("Old stop-diagnostic attempt has evidence that forbids read-timeout reconciliation")
    return receipt


def _service_incarnation(actual: Mapping[str, object], service: str) -> dict[str, object]:
    row = actual.get(service)
    state = row.get("State") if isinstance(row, Mapping) else None
    if (not isinstance(row, Mapping) or not isinstance(state, Mapping)
            or state.get("Running") is not True
            or not isinstance(state.get("StartedAt"), str)
            or not state.get("StartedAt")
            or type(row.get("RestartCount")) is not int):
        _fail("Both exact retained services must remain running during read-timeout reconciliation")
    return {
        "container_id": row.get("Id"),
        "started_at": state["StartedAt"],
        "restart_count": row["RestartCount"],
        "running": True,
    }


def _publish_read_timeout_reconciliation(
    control: BuildControl,
    helper_id: str,
    *,
    root: str,
    active_sha256: str,
    receipt_sha256: str,
    proof_raw: bytes,
    terminal_raw: bytes,
) -> None:
    active_path = shlex.quote(control.path("active"))
    receipt_path = shlex.quote(control.path(root + "/receipt.json"))
    proof_path = shlex.quote(control.path(root + "/read-timeout-reconciliation-proof.json"))
    preflight_path = shlex.quote(control.path(root + "/diagnostic-stop-preflight.json"))
    diagnostic_terminal_path = shlex.quote(control.path(root + "/diagnostic-stop-terminal.json"))
    terminal_path = shlex.quote(control.path(root + "/terminal.json"))
    directory = shlex.quote(control.path(root))

    def assert_original_pins() -> str:
        return (
            f"test ! -L {active_path}; test -f {active_path}; test $(stat -c %h {active_path}) = 1; "
            f"test \"$(sha256sum {active_path} | cut -d' ' -f1)\" = {shlex.quote(active_sha256)}; "
            f"test ! -L {receipt_path}; test -f {receipt_path}; test $(stat -c %h {receipt_path}) = 1; "
            f"test \"$(sha256sum {receipt_path} | cut -d' ' -f1)\" = {shlex.quote(receipt_sha256)}; "
        )

    def publish(target: str, payload: bytes) -> str:
        encoded = shlex.quote(base64.b64encode(payload).decode("ascii"))
        return (
            f"test ! -e {target}; test ! -L {target}; "
            f"tmp=$(mktemp {directory}/.read-timeout-reconcile.XXXXXXXX); "
            f"trap 'rm -f -- \"$tmp\"' EXIT; "
            f"printf %s {encoded} | base64 -d > \"$tmp\"; chmod 0440 \"$tmp\"; "
            # Link publication is atomic and refuses an existing target even
            # if two reconciliations passed the preceding absence check.
            f"sync \"$tmp\"; ln -T -- \"$tmp\" {target}; rm -f -- \"$tmp\"; sync {directory}; "
        )

    script = (
        "set -euo pipefail; umask 027; "
        f"test ! -L {directory}; test -d {directory}; test \"$(readlink -f {directory})\" = {directory}; "
        + assert_original_pins()
        + f"test ! -e {proof_path}; test ! -L {proof_path}; "
        + f"test ! -e {terminal_path}; test ! -L {terminal_path}; "
        + publish(proof_path, proof_raw)
        + assert_original_pins()
        + f"test -f {proof_path}; test ! -L {proof_path}; test $(stat -c %h {proof_path}) = 1; "
        + f"test \"$(sha256sum {proof_path} | cut -d' ' -f1)\" = {shlex.quote(_sha256(proof_raw))}; "
        + f"test ! -e {preflight_path}; test ! -L {preflight_path}; "
        + f"test ! -e {diagnostic_terminal_path}; test ! -L {diagnostic_terminal_path}; "
        + publish(terminal_path, terminal_raw)
        + f"sync {directory}; sync /control; printf 'RECONCILED\\n'"
    )
    script = control._namespace_guard(script)
    result = docker_capture(
        "exec", "--user", "65532:65532", helper_id,
        "/bin/bash", "-euo", "pipefail", "-c", script,
        timeout=90, allow_failure=True,
    )
    if result.returncode:
        _fail("Original helper did not acknowledge read-timeout reconciliation publication")
    if result.stdout.strip() != b"RECONCILED":
        _fail("Original helper returned no canonical read-timeout reconciliation acknowledgement")


def _reconcile_read_timeout_attempt(
    args: argparse.Namespace,
    control: BuildControl,
    selected: Path,
    identity: Mapping[str, object],
    effective_previous: Mapping[str, object],
    document: Mapping[str, object],
    operation_inputs: Mapping[str, object],
) -> dict[str, object] | None:
    attempt = getattr(args, "reconcile_read_attempt", None)
    if attempt is None:
        return None
    if not isinstance(attempt, str) or ATTEMPT_RE.fullmatch(attempt) is None:
        _fail("Read-timeout reconciliation attempt is not a complete lowercase identity")

    from docker_volume_activation_reconcile import _validate_helper, _validate_helper_logged, _wait_for_helper_exit

    helper_name = "fullmag-control-" + attempt
    helper_document, helper_id = _validate_helper(
        control, helper_name, attempt, phase="stop-diagnostic"
    )
    if helper_document.get("Id") != helper_id:
        _fail("Original stop-diagnostic helper ID changed during authentication")
    _validate_helper_logged(helper_id)

    root = "stop-diagnostic/attempts/" + attempt
    active_raw = _read_from_original_helper(control, helper_id, "active", maximum=128)
    receipt_raw = _read_from_original_helper(control, helper_id, root + "/receipt.json")
    receipt = _assert_read_timeout_attempt(
        control, helper_id, attempt, operation_inputs,
        active_raw=active_raw or b"", receipt_raw=receipt_raw or b"",
    )

    image, ids, actual = _container_snapshot(
        args, selected, identity, control, effective_previous, document
    )
    if (image != operation_inputs.get("image_id")
            or ids.get("backend") != operation_inputs.get("backend_container_id")
            or ids.get("frontend") != operation_inputs.get("frontend_container_id")
            or actual["backend"].get("State", {}).get("StartedAt")
                != operation_inputs.get("backend_started_at")):
        _fail("Live Compose services differ from the old stop-diagnostic pins")
    original_operation = {"receipt": receipt}
    if _assert_group_consumers(control, original_operation, ids) != helper_id:
        _fail("Only the retained services and exact original helper may consume the group")
    service_incarnations = {
        name: _service_incarnation(actual, name) for name in ("backend", "frontend")
    }

    # Re-authenticate and reread all decision pins immediately before the
    # helper's CAS publication. Any stop preflight or service restart aborts.
    final_helper_document, final_helper_id = _validate_helper(
        control, helper_name, attempt, phase="stop-diagnostic"
    )
    if final_helper_id != helper_id or final_helper_document.get("Id") != helper_id:
        _fail("Original stop-diagnostic helper changed before reconciliation publication")
    _validate_helper_logged(helper_id)
    final_image, final_ids, final_actual = _container_snapshot(
        args, selected, identity, control, effective_previous, document
    )
    final_service_incarnations = {
        name: _service_incarnation(final_actual, name) for name in ("backend", "frontend")
    }
    if (final_image != image or final_ids != ids
            or final_service_incarnations != service_incarnations):
        _fail("A service identity or running incarnation changed before reconciliation publication")
    if _assert_group_consumers(control, original_operation, ids) != helper_id:
        _fail("Compose group acquired another consumer before reconciliation publication")
    final_active = _read_from_original_helper(control, helper_id, "active", maximum=128)
    final_receipt = _read_from_original_helper(control, helper_id, root + "/receipt.json")
    if final_active != active_raw or final_receipt != receipt_raw:
        _fail("Original active marker or receipt changed before reconciliation publication")
    _assert_read_timeout_attempt(
        control, helper_id, attempt, operation_inputs,
        active_raw=final_active or b"", receipt_raw=final_receipt or b"",
    )

    proof = {
        "schema": "fullmag.docker-api-diagnostic-stop-read-timeout-proof.v1",
        "state": "no-stop-confirmed",
        "attempt": attempt,
        "development_attempt": operation_inputs["attempt"],
        "config_sha256": operation_inputs["config_sha256"],
        "operation_inputs_sha256": _sha256(canonical(dict(operation_inputs))),
        "active_sha256": _sha256(active_raw or b""),
        "receipt_sha256": _sha256(receipt_raw or b""),
        "original_error": receipt["error"],
        "stop_preflight": "absent",
        "diagnostic_stop_terminal": "absent",
        "services": final_service_incarnations,
        "stop_action_performed": False,
        "created_at": time.time(),
    }
    proof_raw = canonical(proof) + b"\n"
    terminal = {
        **receipt,
        "state": "failed-confirmed",
        "error": receipt["error"],
        "reconciliation": "read-timeout-before-diagnostic-stop-preflight",
        "reconciliation_proof": root + "/read-timeout-reconciliation-proof.json",
        "reconciliation_proof_sha256": _sha256(proof_raw),
        "finished_at": time.time(),
    }
    terminal_raw = canonical(terminal) + b"\n"
    _publish_read_timeout_reconciliation(
        control, helper_id,
        root=root,
        active_sha256=_sha256(active_raw or b""),
        receipt_sha256=_sha256(receipt_raw or b""),
        proof_raw=proof_raw,
        terminal_raw=terminal_raw,
    )
    _wait_for_helper_exit(helper_id)
    return {
        "state": "failed-confirmed-no-stop",
        "attempt": attempt,
        "terminal_sha256": _sha256(terminal_raw),
        "proof_sha256": _sha256(proof_raw),
        "backend_container_id": ids["backend"],
        "backend_started_at": final_service_incarnations["backend"]["started_at"],
        "resource_leases": "untouched",
    }


def stop_diagnostic(args: argparse.Namespace) -> dict[str, object]:
    from docker_dev import _compose_identity, _select_source
    from docker_volume_unclaimed_cancellation import _control_raw, _json_object
    from docker_volume_dev import _operator_probe_record_from_retained

    for value, pattern, label in (
        (args.attempt, ATTEMPT_RE, "attempt"),
        (args.config_sha256, SHA256_RE, "Compose config SHA-256"),
    ):
        if not isinstance(value, str) or pattern.fullmatch(value) is None:
            _fail(label + " is not a complete lowercase identity")
    if type(args.port) is not int or not 1 <= args.port <= 65535:
        _fail("Frontend port is outside the valid range")
    resume_attempt = getattr(args, "resume_attempt", None)
    iteration_attempt = getattr(args, "iteration_attempt", None)
    if resume_attempt is not None and iteration_attempt is not None:
        _fail("Specify one exact resume or iteration, never both")
    continuation_phase = "iteration" if iteration_attempt is not None else "resume"
    resume_attempt = iteration_attempt if iteration_attempt is not None else resume_attempt
    if resume_attempt is not None and (
        not isinstance(resume_attempt, str) or ATTEMPT_RE.fullmatch(resume_attempt) is None
    ):
        _fail("Resume attempt is not a complete lowercase identity")
    require_host()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(
        selected, identity
    )
    helper_image = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    control = BuildControl(identity, helper_image)
    control.prepare()

    previous_root = "development/attempts/" + args.attempt
    terminal_raw = _read_raw(control, previous_root + "/terminal.json")
    previous = _json(terminal_raw, "retained development terminal")
    if (previous.get("schema") != "fullmag.docker-build-operation.v1"
            or previous.get("phase") != "development"
            or previous.get("state") not in {"failed-confirmed", "succeeded"}
            or previous.get("attempt") != args.attempt
            or previous.get("compose_project") != control.project):
        _fail("Diagnostic stop requires the exact terminal development attempt")
    inputs = previous.get("inputs")
    if not isinstance(inputs, Mapping) or inputs.get("source_root") != str(selected):
        _fail("Failed development attempt belongs to a different selected checkout")
    document_raw = _read_raw(control, previous_root + "/compose.json")
    document = _json(document_raw, "retained Compose document")
    if (_sha256(canonical(document)) != args.config_sha256
            or document.get("name") != control.project):
        _fail("Retained Compose project/configuration pin differs")
    _operator_probe_record_from_retained(previous, document)
    _port_matches(document, args.port)
    started_at = previous.get("backend_started_at")
    if not isinstance(started_at, str) or not started_at:
        _fail("Failed attempt does not pin the backend start time")
    resume_pin = None
    effective_previous = previous
    if resume_attempt is not None:
        resume_pin = _validate_resume_terminal(
            control,
            resume_attempt,
            development_attempt=args.attempt,
            config_sha256=args.config_sha256,
            previous=previous,
            phase=continuation_phase,
        )
        started_at = resume_pin["backend_started_at"]
        effective_previous = dict(previous)
        effective_previous["backend_started_at"] = started_at
        effective_previous["backend_container"] = resume_pin["backend_container"]
        effective_previous["frontend_container"] = resume_pin["frontend_container"]
    # A failed-confirmed start has a _finish process sidecar; a succeeded
    # start may fail later under supervision, so current process-tree bytes
    # are the live failure pin in that case.
    sidecar_raw = _control_raw(
        control, previous_root + "/process-failure.json", optional=True,
        maximum=MAX_EVIDENCE_BYTES,
    )
    if previous["state"] == "failed-confirmed" and sidecar_raw is None and resume_pin is None:
        _fail("Failed-confirmed attempt has no process-failure sidecar")
    process_raw = _read_raw(control, "runtime-control/runtime-service/process-tree.json")
    if (sidecar_raw is not None
            and _json(sidecar_raw, "retained process-failure sidecar")
                != _json(process_raw, "retained diagnostic process receipt")):
        _fail("Retained process-failure sidecar differs from the current process receipt")

    operation_inputs = {
        "attempt": args.attempt,
        "config_sha256": args.config_sha256,
        "source_root": str(selected),
        "image_id": inputs.get("image_id"),
        "backend_started_at": started_at,
        "backend_container_id": previous.get("backend_container"),
        "frontend_container_id": previous.get("frontend_container"),
        "terminal_sha256": _sha256(terminal_raw),
        "compose_sha256": _sha256(document_raw),
        "process_receipt_sha256": _sha256(process_raw),
    }
    if resume_pin is not None:
        operation_inputs.update(
            resume_attempt=resume_pin["attempt"],
            resume_terminal_sha256=resume_pin["sha256"],
        )
    if getattr(args, "pending_activation", None) is not None:
        from docker_volume_preparation_abort import abort_pending_preparation
        return abort_pending_preparation(
            args, control, selected, identity, effective_previous, document,
            previous_root, operation_inputs, resume_pin,
        )
    _reconcile_read_timeout_attempt(
        args, control, selected, identity, effective_previous, document, operation_inputs
    )
    with control.operation("stop-diagnostic", operation_inputs) as operation:
        from docker_volume_preparation_abort import pin_completed_fresh_archive
        pin_completed_fresh_archive(control)
        operation["receipt"].update(state="validating-diagnostic-api")
        image, ids, actual = _container_snapshot(
            args, selected, identity, control, effective_previous, document
        )
        operation["receipt"]["image_id"] = image
        operation["receipt"]["inputs"].update(
            backend_container_id=ids["backend"], frontend_container_id=ids["frontend"]
        )
        helper_id = _assert_group_consumers(control, operation, ids)
        guest_probe = _probe_backend(ids["backend"])
        before = _probe_evidence(control, previous_root, guest_probe)
        if before["process_receipt_sha256"] != operation_inputs["process_receipt_sha256"]:
            _fail("Diagnostic process receipt changed since the retained failure was pinned")
        # Re-read the pins and repeat both process and health observation
        # immediately before signaling the exact backend container.
        if (_sha256(_read_raw(control, previous_root + "/terminal.json")) != operation_inputs["terminal_sha256"]
                or _sha256(_read_raw(control, previous_root + "/compose.json")) != operation_inputs["compose_sha256"]
                or _optional_sidecar_sha256(control, previous_root) != before["process_failure_sidecar_sha256"]):
            _fail("Retained terminal, Compose, or process-failure evidence changed under the stop lease")
        if (resume_pin is not None
                and _sha256(_read_raw(control, resume_pin["relative"])) != resume_pin["sha256"]):
            _fail("Successful resume terminal changed under the diagnostic stop lease")
        fresh_image, fresh_ids, fresh_actual = _container_snapshot(
            args, selected, identity, control, effective_previous, document
        )
        if (fresh_image != image or fresh_ids != ids
                or any(fresh_actual[name].get("State", {}).get("StartedAt")
                       != actual[name].get("State", {}).get("StartedAt")
                       for name in ids)):
            _fail("Compose container incarnation changed during diagnostic stop preflight")
        fresh_probe = _probe_backend(ids["backend"])
        rechecked = _probe_evidence(control, previous_root, fresh_probe)
        stable_keys = (
            "runtime_config_sha256", "failed_owner_sha256", "process_receipt_sha256",
            "process_failure_sidecar_sha256", "api_failure_fence_sha256",
        )
        if any(rechecked[key] != before[key] for key in stable_keys):
            _fail("Runtime configuration, owner, process receipt, or failure fence changed before stop")
        if fresh_probe.get("api_instance_id") != guest_probe.get("api_instance_id"):
            _fail("Diagnostic API incarnation changed during stop preflight")
        operation["receipt"].update(state="stopping-diagnostic-api", helper_container_id=helper_id)
        preflight = {
            "schema": "fullmag.docker-api-diagnostic-stop-preflight.v1",
            "attempt": args.attempt,
            "config_sha256": args.config_sha256,
            "terminal_sha256": operation_inputs["terminal_sha256"],
            "compose_sha256": operation_inputs["compose_sha256"],
            "backend_container_id": ids["backend"],
            "backend_image_id": image,
            "backend_started_at": started_at,
            "frontend_container_id": ids["frontend"],
            "runtime_config_sha256": before["runtime_config_sha256"],
            "failed_owner_sha256": before["failed_owner_sha256"],
            "failed_owner": before["failed_owner"],
            "retained_ready_owner": before["ready_owner"],
            "process_receipt_sha256": before["process_receipt_sha256"],
            "process_failure_sidecar_sha256": before["process_failure_sidecar_sha256"],
            "api_failure_fence_sha256": before["api_failure_fence_sha256"],
            "api_instance_id": guest_probe["api_instance_id"],
            "probe_process_ids": fresh_probe["process_ids"],
            "owner_pids_absent": fresh_probe["owner_pids_absent"],
            "resource_leases": "untouched",
        }
        if resume_pin is not None:
            preflight["resume_attempt"] = resume_pin["attempt"]
            preflight["resume_terminal_sha256"] = resume_pin["sha256"]
        control.write(operation["root"] + "/diagnostic-stop-preflight.json", preflight)
        if (
            _sha256(_read_raw(control, previous_root + "/terminal.json"))
            != operation_inputs["terminal_sha256"]
            or (
                resume_pin is not None
                and _sha256(_read_raw(control, resume_pin["relative"])) != resume_pin["sha256"]
            )
        ):
            _fail("Original or resume terminal changed immediately before the backend stop")
        operation["daemon_pending"] = True
        docker_capture("stop", "--time", "60", ids["backend"], timeout=90)
        observed = json.loads(docker_capture("inspect", ids["backend"]).stdout)
        if len(observed) != 1:
            _fail("Stopped backend inspection is ambiguous")
        stopped = observed[0]
        if (stopped.get("Id") != ids["backend"]
                or stopped.get("Image") != image
                or stopped.get("State", {}).get("StartedAt") != started_at
                or stopped.get("State", {}).get("Running") is not False):
            _fail("Docker did not confirm stopping the exact retained backend incarnation")
        operation["daemon_pending"] = False
        frontend_now = json.loads(docker_capture("inspect", ids["frontend"]).stdout)
        if (len(frontend_now) != 1
                or frontend_now[0].get("Id") != ids["frontend"]
                or frontend_now[0].get("Image") != image
                or frontend_now[0].get("State", {}).get("StartedAt")
                    != actual["frontend"].get("State", {}).get("StartedAt")
                or frontend_now[0].get("State", {}).get("Running") is not True):
            _fail("Frontend changed while stopping the backend; no further lifecycle action was taken")
        terminal_result = _terminal_receipt(
            control, operation, ids["backend"], before, stopped, resume_pin
        )
        operation["receipt"].update(
            state="succeeded",
            stopped_backend=True,
            execution_state="unknown",
            diagnostic_stop_terminal_sha256=_sha256(canonical(terminal_result)),
        )
        return terminal_result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--resume-attempt",
        help="exact successful retained resume attempt that pins the current backend start time",
    )
    parser.add_argument(
        "--reconcile-read-attempt",
        help="reconcile one exact preflight control-read timeout before beginning a new stop attempt",
    )
    args = parser.parse_args(argv)
    try:
        result = stop_diagnostic(args)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except (BuildControlError, ValueError, OSError, json.JSONDecodeError) as error:
        print("stop-diagnostic-volume: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
