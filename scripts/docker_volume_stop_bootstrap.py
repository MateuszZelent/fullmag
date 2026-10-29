"""Stop one exact DEV backend retaining only its startup-fenced API.

This recovery is limited to a pre-owner runtime-startup failure whose native
owner is a historical Ready record from a different build. It stops only the
pinned Compose backend and preserves the owner and all runtime data; native
execution remains unknown until a later managed recovery step.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from collections.abc import Mapping
from pathlib import Path
import re
import sys
import time

from docker_build_control import (
    BuildControl,
    BuildControlError,
    canonical,
    compose_capture,
    docker_capture,
    toolchain_configuration,
)
from docker_dev_host import require_host


ATTEMPT_RE = re.compile(r"[0-9a-f]{32}\Z")
CONTAINER_RE = re.compile(r"[0-9a-f]{64}\Z")
IMAGE_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
MAX_EVIDENCE_BYTES = 1024 * 1024
TARGET_BUILD_ERROR = "native service target/build mismatch; attach refused"
TARGET_BUILD_ERROR_PREFIX = "runtime service ownership was not confirmed: runtime CLI failed: [fullmag] version"
TARGET_BUILD_ERROR_SUFFIX = "Error: " + TARGET_BUILD_ERROR
EXPECTED_SHUTDOWN_ERROR = (
    "no pinned runtime service owner was available for authenticated drain"
)


def _fail(message: str) -> None:
    raise BuildControlError(message)


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _matches_target_build_failure(value: object) -> bool:
    return (
        isinstance(value, str)
        and value.startswith(TARGET_BUILD_ERROR_PREFIX)
        and value.endswith("\n" + TARGET_BUILD_ERROR_SUFFIX)
    )


def _read_raw(control: BuildControl, relative: str, *, maximum: int = MAX_EVIDENCE_BYTES) -> bytes:
    from docker_volume_unclaimed_cancellation import _control_raw

    raw = _control_raw(control, relative, maximum=maximum)
    if raw is None:
        _fail("Required control-volume evidence is missing: " + relative)
    return raw


def _json(raw: bytes, label: str) -> dict[str, object]:
    from docker_volume_unclaimed_cancellation import _json_object

    return _json_object(raw, label, maximum=MAX_EVIDENCE_BYTES)


def _decode_probe(probe: Mapping[str, object], name: str, *, maximum: int = MAX_EVIDENCE_BYTES) -> bytes:
    value = probe.get(name)
    if not isinstance(value, str):
        _fail("In-container bootstrap probe omitted " + name)
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise BuildControlError("In-container bootstrap probe returned invalid " + name) from error
    if len(raw) > maximum:
        _fail("In-container bootstrap evidence exceeds its byte bound")
    return raw


def _runtime_relative(path: object) -> str:
    prefix = "/opt/fullmag/runtime-control/runtime-service/"
    if not isinstance(path, str) or not path.startswith(prefix):
        _fail("API failure fence is outside the canonical runtime-service directory")
    name = path[len(prefix):]
    if re.fullmatch(r"api-failure-[0-9a-f]{32}\.json", name) is None:
        _fail("API failure fence filename is not an exact incarnation marker")
    return "runtime-control/runtime-service/" + name


def _container_iteration(control, args, previous):
    """Use only an explicit, successful linked iteration for missing DEV IDs.

    This is historical container identity, not a start-time or ownership proof:
    the failed resume and the live probe must still authenticate this start.
    """
    attempt = getattr(args, "iteration_attempt", None)
    if attempt is None:
        return None
    for key in ("backend_container", "frontend_container"):
        value = previous.get(key)
        if value is not None and (not isinstance(value, str) or CONTAINER_RE.fullmatch(value) is None):
            _fail("Development terminal has an invalid explicit " + key)
    if all(previous.get(key) is not None for key in ("backend_container", "frontend_container")):
        _fail("An iteration identity is only needed when the development terminal omitted service IDs")
    from docker_volume_stop_diagnostic import _validate_resume_terminal

    pin = _validate_resume_terminal(
        control, attempt, development_attempt=args.attempt,
        config_sha256=args.config_sha256, previous=previous, phase="iteration",
    )
    # Do not adopt a superseded or failed latest iteration merely because a
    # historical successful receipt still exists in the control volume.
    current = "iteration/current.json"
    if _sha256(_read_raw(control, current)) != pin["sha256"]:
        _fail("The pinned successful iteration is not the current iteration")
    return {**pin, "current_relative": current}


def _verify_container_iteration(control, pin):
    if pin is not None:
        for relative in (pin["relative"], pin["current_relative"]):
            if _sha256(_read_raw(control, relative)) != pin["sha256"]:
                _fail("Pinned container iteration changed during the bootstrap stop")


def _validate_resume(
    control: BuildControl,
    *,
    attempt: str,
    resume_attempt: str,
    config_sha256: str,
    selected: Path,
    previous: Mapping[str, object],
    previous_inputs: Mapping[str, object],
) -> dict[str, object]:
    relative = "resume/attempts/" + resume_attempt + "/terminal.json"
    raw = _read_raw(control, relative)
    receipt = _json(raw, "failed-confirmed resume terminal")
    inputs = receipt.get("inputs")
    cgroup = receipt.get("worker_cgroup")
    backend_id = previous.get("backend_container")
    frontend_id = previous.get("frontend_container")
    image_id = previous_inputs.get("image_id")
    if (
        receipt.get("schema") != "fullmag.docker-build-operation.v1"
        or receipt.get("phase") != "resume"
        or receipt.get("state") != "failed-confirmed"
        or receipt.get("attempt") != resume_attempt
        or receipt.get("compose_project") != control.project
        or receipt.get("control_volume") != control.volume
        or receipt.get("config_sha256") not in (None, config_sha256)
        or not isinstance(inputs, Mapping)
        or inputs.get("attempt") != attempt
        or inputs.get("config_sha256") != config_sha256
        or ("source_root" in inputs and inputs.get("source_root") != str(selected))
        or ("image_id" in inputs and inputs.get("image_id") != image_id)
        or not isinstance(previous.get("state_root"), str)
        or receipt.get("state_root") != previous.get("state_root")
        or not isinstance(backend_id, str)
        or CONTAINER_RE.fullmatch(backend_id) is None
        or not isinstance(frontend_id, str)
        or CONTAINER_RE.fullmatch(frontend_id) is None
        or not isinstance(image_id, str)
        or IMAGE_RE.fullmatch(image_id) is None
        or not isinstance(cgroup, Mapping)
        or cgroup.get("schema") != "fullmag.worker-cgroup-ready.v1"
        or cgroup.get("state") != "ready"
        or cgroup.get("compose_project") != control.project
        or cgroup.get("container_id") != backend_id
        or cgroup.get("image_id") != image_id
    ):
        _fail("Resume terminal is not the exact failed continuation of this development attempt")

    for key, expected in (("backend_container", backend_id), ("frontend_container", frontend_id)):
        observed = receipt.get(key)
        if observed is not None and observed != expected:
            _fail("Resume terminal names a different " + key)
    if receipt.get("image_id") not in (None, image_id):
        _fail("Resume terminal names a different development image")
    started_at = receipt.get("backend_started_at")
    if not isinstance(started_at, str) or not started_at:
        _fail("Failed resume terminal does not pin the backend start time")
    error = receipt.get("error")
    if not isinstance(error, str) or TARGET_BUILD_ERROR not in error:
        _fail("Failed resume terminal does not retain the exact native target/build mismatch")

    expected_namespace = previous.get("control_namespace")
    if control.namespace:
        if (expected_namespace != control.namespace
                or receipt.get("control_namespace") != control.namespace):
            _fail("Development and resume terminals belong to a different control namespace")
    elif "control_namespace" in receipt or "control_namespace" in previous:
        _fail("Resume or development terminal has an unexpected control namespace")

    return {
        "attempt": resume_attempt,
        "relative": relative,
        "sha256": _sha256(raw),
        "backend_started_at": started_at,
        "backend_container": backend_id,
        "frontend_container": frontend_id,
        "image_id": image_id,
        "pin_sources": {
            "backend_container": ["development terminal", "resume worker_cgroup", "Docker inspect"],
            "frontend_container": ["development terminal", "Docker inspect"],
            "image_id": ["development inputs", "resume worker_cgroup", "Docker inspect"],
            "backend_started_at": ["failed resume terminal", "Docker inspect"],
        },
    }


def _load_pins(args, control: BuildControl, selected: Path) -> dict[str, object]:
    from docker_volume_stop_diagnostic import _port_matches
    from docker_volume_unclaimed_cancellation import _control_raw
    from docker_volume_dev import _operator_probe_record_from_retained

    if not isinstance(args.attempt, str) or ATTEMPT_RE.fullmatch(args.attempt) is None:
        _fail("Development attempt is not a complete lowercase identity")
    if not isinstance(args.resume_attempt, str) or ATTEMPT_RE.fullmatch(args.resume_attempt) is None:
        _fail("Resume attempt is not a complete lowercase identity")
    if not isinstance(args.config_sha256, str) or SHA256_RE.fullmatch(args.config_sha256) is None:
        _fail("Compose config SHA-256 is not a complete lowercase digest")
    if type(args.port) is not int or not 1 <= args.port <= 65535:
        _fail("Frontend port is outside the valid range")

    previous_root = "development/attempts/" + args.attempt
    terminal_relative = previous_root + "/terminal.json"
    terminal_raw = _read_raw(control, terminal_relative)
    previous = _json(terminal_raw, "retained development terminal")
    inputs = previous.get("inputs")
    if (
        previous.get("schema") != "fullmag.docker-build-operation.v1"
        or previous.get("phase") != "development"
        or previous.get("state") not in {"succeeded", "failed-confirmed"}
        or previous.get("attempt") != args.attempt
        or previous.get("compose_project") != control.project
        or previous.get("control_volume") != control.volume
        or not isinstance(inputs, Mapping)
        or inputs.get("source_root") != str(selected)
        or ("config_sha256" in inputs and inputs.get("config_sha256") != args.config_sha256)
        or ("config_sha256" in previous and previous.get("config_sha256") != args.config_sha256)
    ):
        _fail("Stop-bootstrap requires the exact retained development terminal and source")
    if control.namespace:
        if previous.get("control_namespace") != control.namespace:
            _fail("Development terminal belongs to a different control namespace")
    elif "control_namespace" in previous:
        _fail("Development terminal has an unexpected control namespace")

    compose_relative = previous_root + "/compose.json"
    compose_raw = _read_raw(control, compose_relative)
    document = _json(compose_raw, "retained Compose document")
    if _sha256(canonical(document)) != args.config_sha256 or document.get("name") != control.project:
        _fail("Retained Compose project/configuration CAS differs")
    _operator_probe_record_from_retained(previous, document)
    _port_matches(document, args.port)

    iteration = _container_iteration(control, args, previous)
    identity_previous = dict(previous)
    if iteration is not None:
        for key in ("backend_container", "frontend_container"):
            identity_previous[key] = iteration[key]
    resume = _validate_resume(
        control,
        attempt=args.attempt,
        resume_attempt=args.resume_attempt,
        config_sha256=args.config_sha256,
        selected=selected,
        previous=identity_previous,
        previous_inputs=inputs,
    )
    if iteration is not None:
        for key in ("backend_container", "frontend_container"):
            resume["pin_sources"][key][0] = "explicit succeeded iteration terminal"
    resume_sidecar_relative = "resume/attempts/" + args.resume_attempt + "/process-failure.json"
    sidecar_raw = _control_raw(
        control, resume_sidecar_relative, optional=True, maximum=MAX_EVIDENCE_BYTES
    )
    if sidecar_raw is None:
        _fail("Failed-confirmed resume terminal has no process-failure sidecar")
    sidecar = _json(sidecar_raw, "failed resume process-failure sidecar")
    process_raw = _read_raw(control, "runtime-control/runtime-service/process-tree.json")
    process = _json(process_raw, "live diagnostic process receipt")
    if sidecar_raw != process_raw or sidecar != process:
        _fail("Resume process-failure sidecar is not byte-identical to the live process receipt")

    effective_previous = dict(previous)
    effective_previous["backend_started_at"] = resume["backend_started_at"]
    effective_previous["backend_container"] = resume["backend_container"]
    effective_previous["frontend_container"] = resume["frontend_container"]
    effective_inputs = dict(inputs)
    effective_inputs["image_id"] = resume["image_id"]
    effective_previous["inputs"] = effective_inputs
    return {
        "previous_root": previous_root,
        "terminal_relative": terminal_relative,
        "terminal_raw": terminal_raw,
        "terminal": previous,
        "terminal_sha256": _sha256(terminal_raw),
        "compose_relative": compose_relative,
        "compose_raw": compose_raw,
        "compose": document,
        "compose_sha256": _sha256(compose_raw),
        "image_id": resume["image_id"],
        "backend_container": resume["backend_container"],
        "frontend_container": resume["frontend_container"],
        "backend_started_at": resume["backend_started_at"],
        "resume": resume,
        "resume_sidecar_relative": resume_sidecar_relative,
        "resume_sidecar_raw": sidecar_raw,
        "resume_sidecar_sha256": _sha256(sidecar_raw),
        "process_raw": process_raw,
        "effective_previous": effective_previous,
        "pin_sources": resume["pin_sources"],
        "container_iteration": iteration,
    }


def _probe_script() -> str:
    return r'''import base64, hashlib, json, os, pathlib, re, stat, urllib.error, urllib.request

MAX=1024*1024
PROCESS='/opt/fullmag/runtime-control/runtime-service/process-tree.json'
OWNER='/opt/fullmag/runtime-control/runtime-services/OWNER.json'
CONFIG='/opt/fullmag/runtime-control/runtime-service/docker-all.json'
FENCE_PARENT=pathlib.Path('/opt/fullmag/runtime-control/runtime-service')
EXPECTED='native service target/build mismatch; attach refused'
EXPECTED_PREFIX='runtime service ownership was not confirmed: runtime CLI failed: [fullmag] version'
EXPECTED_SUFFIX='Error: '+EXPECTED

def regular(path,label,maximum=MAX):
    path=pathlib.Path(path)
    if not path.is_absolute() or '..' in path.parts or str(path)!=str(pathlib.PurePosixPath(path)):
        raise RuntimeError(label+' path is not canonical')
    if path.parent.resolve(strict=True)!=path.parent:
        raise RuntimeError(label+' parent is not canonical')
    fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0))
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>maximum:
            raise RuntimeError(label+' is not a bounded single-link regular file')
        chunks=[]
        remaining=maximum+1
        while remaining:
            chunk=os.read(fd,min(65536,remaining))
            if not chunk: break
            chunks.append(chunk); remaining-=len(chunk)
        raw=b''.join(chunks)
        if len(raw)>maximum: raise RuntimeError(label+' exceeds its byte bound')
        return raw
    finally: os.close(fd)

def unique(pairs):
    value={}
    for key,item in pairs:
        if key in value: raise RuntimeError('duplicate JSON key')
        value[key]=item
    return value

def reject_constant(value): raise RuntimeError('non-finite JSON number is forbidden')
def obj(raw,label):
    try: value=json.loads(raw.decode('utf-8'),object_pairs_hook=unique,parse_constant=reject_constant)
    except (UnicodeDecodeError,json.JSONDecodeError) as error: raise RuntimeError(label+' is invalid JSON') from error
    if not isinstance(value,dict): raise RuntimeError(label+' is not an object')
    return value

process_raw=regular(PROCESS,'process receipt')
owner_raw=regular(OWNER,'runtime owner',256*1024)
config_raw=regular(CONFIG,'runtime configuration',256*1024)
process=obj(process_raw,'process receipt')
owner=obj(owner_raw,'runtime owner')
config=obj(config_raw,'runtime configuration')
if (process.get('schema')!='fullmag.docker-process-tree.v1'
        or process.get('state')!='failed_outcome_retained'
        or process.get('api_diagnostic_only') is not True
        or 'service_owner' in process or 'runtime_pid' in process
        or 'terminal_service_owner' in process):
    raise RuntimeError('receipt is not the exact pre-owner diagnostic-only API state')
failure_reason=process.get('error')
if (not isinstance(failure_reason,str)
        or not failure_reason.startswith(EXPECTED_PREFIX)
        or not failure_reason.endswith('\n'+EXPECTED_SUFFIX)
        or type(process.get('api_pid')) is not int or process['api_pid']<=0):
    raise RuntimeError('receipt does not pin the exact startup target/build failure and API')
if (config.get('schema_version')!='runtime_service_config.v2'
        or config.get('target_id')!='docker-all'
        or config.get('store_root')!='/state/runs/docker-all/session-store'):
    raise RuntimeError('runtime configuration is not bound to the managed docker-all store')

failure_path=process.get('api_failure_fence')
if (not isinstance(failure_path,str) or pathlib.Path(failure_path).parent!=FENCE_PARENT
        or FENCE_PARENT.resolve(strict=True)!=FENCE_PARENT):
    raise RuntimeError('process receipt does not bind the canonical runtime-service failure fence')
failure_name=pathlib.Path(failure_path).name
if re.fullmatch(r'api-failure-[0-9a-f]{32}\.json',failure_name) is None:
    raise RuntimeError('failure fence filename is not an exact incarnation marker')
fence_raw=regular(failure_path,'API failure fence',256*1024)
fence=obj(fence_raw,'API failure fence')
api_pid=process['api_pid']
api_instance=fence.get('api_instance_id')
if (fence.get('schema')!='fullmag.api-runtime-failure-fence.v1'
        or fence.get('stage')!='runtime_startup'
        or fence.get('reason')!=failure_reason
        or fence.get('api_pid')!=api_pid
        or not isinstance(api_instance,str)
        or re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',api_instance) is None):
    raise RuntimeError('failure fence is not bound to this exact startup failure and API incarnation')

import sys
sys.path.insert(0,'/opt/fullmag')
import runtime_service
paths=runtime_service.canonical_paths()
if (paths.config!=pathlib.Path(CONFIG)
        or runtime_service.runtime_services_root(paths)!=pathlib.Path('/opt/fullmag/runtime-control/runtime-services')):
    raise RuntimeError('runtime paths differ from the fixed docker-all control layout')
runtime_service._validate_terminal_owner(owner,state='ready',name='historical Ready runtime owner')
owner_pids=[owner.get('pid')]
children=owner.get('children')
if not isinstance(children,list) or len(children)!=2:
    raise RuntimeError('historical Ready owner has no exact scheduler pair')
for child in children:
    if not isinstance(child,dict) or type(child.get('pid')) is not int:
        raise RuntimeError('historical Ready scheduler identity is invalid')
    owner_pids.append(child['pid'])
if any(type(pid) is not int or pid<=0 or pathlib.Path('/proc/'+str(pid)).exists() for pid in owner_pids):
    raise RuntimeError('historical Ready owner or scheduler process remains live')
provenance_raw=runtime_service._bounded_regular(paths.provenance,'runtime image provenance',256*1024)
provenance=obj(provenance_raw,'runtime image provenance')
current_commit=provenance.get('commit')
native_identity=provenance.get('native_source_identity')
current_snapshot=native_identity.get('source_snapshot_sha256') if isinstance(native_identity,dict) else None
if (not isinstance(current_commit,str) or re.fullmatch(r'[0-9a-f]{40}',current_commit) is None
        or not isinstance(current_snapshot,str) or re.fullmatch(r'[0-9a-f]{64}',current_snapshot) is None):
    raise RuntimeError('runtime image provenance does not pin the current compiled build')
if owner.get('build_commit')==current_commit and owner.get('build_snapshot')==current_snapshot:
    raise RuntimeError('historical Ready owner matches the current compiled build')
def api(path,maximum=256*1024):
    request=urllib.request.Request('http://127.0.0.1:8081'+path,method='GET')
    try:
        response=urllib.request.urlopen(request,timeout=5)
    except urllib.error.HTTPError as error:
        response=error
    try:
        body=response.read(maximum+1)
        if len(body)>maximum: raise RuntimeError('API observation exceeds its byte bound')
        return response.code,response.headers,body
    finally: response.close()

def api_obj(path,expected_status,maximum=256*1024):
    status,headers,raw=api(path,maximum)
    if status!=expected_status: raise RuntimeError(path+' returned an unexpected status')
    return headers,obj(raw,path)

health_headers,health=api_obj('/v2/platform/health',200)
if (health.get('status')!='degraded' or health.get('active_session') is not False
        or health_headers.get('x-fullmag-api-instance')!=api_instance):
    raise RuntimeError('health does not acknowledge the exact degraded, no-session API fence')
openapi_headers,openapi=api_obj('/v2/platform/openapi.json',200,4*1024*1024)
build=openapi.get('x-fullmag-build-identity')
if (not isinstance(build,dict) or build.get('git_commit')!=current_commit
        or build.get('source_snapshot_sha256')!=current_snapshot
        or openapi_headers.get('x-fullmag-api-instance')!=api_instance
        or not isinstance(openapi.get('paths'),dict)):
    raise RuntimeError('API compiled build identity differs from the pinned runtime provenance')

status_headers,status_body=api_obj('/v2/platform/runtime-service',200)
reason=status_body.get('reason')
if (status_body.get('state')=='ready' or not isinstance(reason,dict)
        or reason.get('code')!='owner_invalid'
        or status_headers.get('x-fullmag-api-instance')!=api_instance):
    raise RuntimeError('runtime-service does not expose the expected invalid historical owner state')

current_headers,_current_body=api_obj('/v2/sessions/current/status',404)
if current_headers.get('x-fullmag-api-instance')!=api_instance:
    raise RuntimeError('current-session absence belongs to a different API instance')

def proc(pid):
    root=pathlib.Path('/proc')/str(pid)
    status=(root/'status').read_text(encoding='utf-8')
    match=re.search(r'^PPid:\s+(\d+)$',status,re.MULTILINE)
    if match is None: raise RuntimeError('process parent identity is unavailable')
    argv=(root/'cmdline').read_bytes().split(b'\0')
    return {'pid':pid,'ppid':int(match.group(1)),'comm':(root/'comm').read_text(encoding='utf-8').strip(),
            'exe':os.readlink(root/'exe'),'argv':argv}

rows=[]
for item in pathlib.Path('/proc').iterdir():
    if item.name.isdigit(): rows.append(proc(int(item.name)))
by_pid={row['pid']:row for row in rows}
self_pid=os.getpid()
init=by_pid.get(1)
if init is None or init['comm'] not in {'docker-init','tini'}:
    raise RuntimeError('container init identity is unexpected')
supervisors=[row for row in rows if row['pid']!=1 and b'/opt/fullmag/entrypoint.py' in row['argv']]
if len(supervisors)!=1: raise RuntimeError('backend supervisor is missing or ambiguous')
supervisor=supervisors[0]
if supervisor['ppid']!=1 or not pathlib.Path(supervisor['exe']).name.startswith('python3'):
    raise RuntimeError('backend supervisor parent/executable differs')
api_proc=by_pid.get(api_pid)
if api_proc is None or api_proc['ppid']!=supervisor['pid'] or not api_proc['exe'].endswith('/fullmag-api'):
    raise RuntimeError('retained API process identity differs from its receipt')
if set(by_pid)!={1,supervisor['pid'],api_pid,self_pid} or len(by_pid)!=4:
    raise RuntimeError('backend has a process beyond init, supervisor, diagnostic API, and this probe')
environment=(pathlib.Path('/proc')/str(api_pid)/'environ').read_bytes()
if len(environment)>MAX or b'FULLMAG_API_RUNTIME_FAILURE_FENCE='+failure_path.encode() not in environment.split(b'\0'):
    raise RuntimeError('API process environment does not pin its exact failure-fence path')

print(json.dumps({
    'schema':'fullmag.docker-bootstrap-api-stop-probe.v1',
    'runtime_config':base64.b64encode(config_raw).decode('ascii'),
    'owner':base64.b64encode(owner_raw).decode('ascii'),
    'process_receipt':base64.b64encode(process_raw).decode('ascii'),
    'failure_fence':base64.b64encode(fence_raw).decode('ascii'),
    'provenance':base64.b64encode(provenance_raw).decode('ascii'),
    'api_pid':api_pid,'api_instance_id':api_instance,'api_failure_fence':failure_path,
    'current_build_commit':current_commit,'current_build_snapshot':current_snapshot,
    'owner_pids_absent':sorted(owner_pids),'process_ids':[1,supervisor['pid'],api_pid,self_pid],
    'health_status':'degraded','active_session':False,'runtime_service_state':status_body.get('state'),
    'runtime_service_reason_code':reason.get('code'),
    'current_session_status':404,
},sort_keys=True,separators=(',',':')))
'''


def _probe_backend(backend_id: str) -> dict[str, object]:
    result = docker_capture(
        "exec", backend_id, "/usr/local/bin/python3", "-B", "-c", _probe_script(), timeout=30
    )
    from docker_volume_unclaimed_cancellation import _json_object

    probe = _json_object(result.stdout, "in-container bootstrap probe", maximum=4 * 1024 * 1024)
    if probe.get("schema") != "fullmag.docker-bootstrap-api-stop-probe.v1":
        _fail("In-container bootstrap probe has an unsupported schema")
    return probe


def _probe_evidence(
    control: BuildControl,
    pins: Mapping[str, object],
    probe: Mapping[str, object],
) -> dict[str, object]:
    from docker_volume_stop_failed import _validate_native_ready_owner

    config_raw = _read_raw(control, "runtime-control/runtime-service/docker-all.json", maximum=256 * 1024)
    owner_raw = _read_raw(control, "runtime-control/runtime-services/OWNER.json", maximum=256 * 1024)
    process_raw = _read_raw(control, "runtime-control/runtime-service/process-tree.json")
    fence_relative = _runtime_relative(probe.get("api_failure_fence"))
    fence_raw = _read_raw(control, fence_relative, maximum=256 * 1024)
    config = _json(config_raw, "runtime service configuration")
    owner = _json(owner_raw, "historical Ready runtime owner")
    process = _json(process_raw, "diagnostic process receipt")
    fence = _json(fence_raw, "startup failure fence")
    sidecar_raw = pins["resume_sidecar_raw"]
    if not isinstance(sidecar_raw, bytes):
        _fail("Resume process-failure sidecar pin is invalid")
    if (
        _decode_probe(probe, "runtime_config", maximum=256 * 1024) != config_raw
        or _decode_probe(probe, "owner", maximum=256 * 1024) != owner_raw
        or _decode_probe(probe, "process_receipt") != process_raw
        or _decode_probe(probe, "failure_fence", maximum=256 * 1024) != fence_raw
    ):
        _fail("In-container bootstrap evidence differs from canonical control-volume bytes")
    if process_raw != sidecar_raw:
        _fail("Current process receipt no longer matches the exact failed-resume sidecar")
    if (config.get("schema_version") != "runtime_service_config.v2"
            or config.get("target_id") != "docker-all"
            or config.get("store_root") != "/state/runs/docker-all/session-store"):
        _fail("Runtime configuration is not the retained docker-all session store")
    if (process.get("schema") != "fullmag.docker-process-tree.v1"
            or process.get("state") != "failed_outcome_retained"
            or process.get("api_diagnostic_only") is not True
            or "service_owner" in process or "runtime_pid" in process
            or "terminal_service_owner" in process
            or not _matches_target_build_failure(process.get("error"))
            or type(process.get("api_pid")) is not int or process.get("api_pid") <= 0
            or process.get("api_failure_fence") != probe.get("api_failure_fence")):
        _fail("Process receipt is not the exact pre-owner startup failure")
    if (fence.get("schema") != "fullmag.api-runtime-failure-fence.v1"
            or fence.get("stage") != "runtime_startup"
            or fence.get("reason") != process.get("error")
            or not _matches_target_build_failure(fence.get("reason"))
            or fence.get("api_pid") != process.get("api_pid")
            or fence.get("api_instance_id") != probe.get("api_instance_id")):
        _fail("Startup failure fence is not bound to the exact retained API")
    provenance_raw = _decode_probe(probe, "provenance", maximum=256 * 1024)
    provenance = _json(provenance_raw, "runtime image provenance")
    native_identity = provenance.get("native_source_identity")
    provenance_snapshot = (
        native_identity.get("source_snapshot_sha256")
        if isinstance(native_identity, Mapping) else None
    )
    if (provenance.get("commit") != probe.get("current_build_commit")
            or provenance_snapshot != probe.get("current_build_snapshot")):
        _fail("Current build identity does not derive from the captured runtime provenance bytes")
    ready_owner = _validate_native_ready_owner(owner)
    if (ready_owner.get("target_id") != "docker-all"
            or (ready_owner.get("build_commit") == probe.get("current_build_commit")
                and ready_owner.get("build_snapshot") == probe.get("current_build_snapshot"))):
        _fail("Historical Ready owner is not pinned to an older docker-all build")
    if (probe.get("api_pid") != process.get("api_pid")
            or not isinstance(probe.get("api_instance_id"), str)
            or UUID_RE.fullmatch(probe["api_instance_id"]) is None
            or probe.get("health_status") != "degraded"
            or probe.get("active_session") is not False
            or probe.get("current_session_status") != 404
            or probe.get("runtime_service_state") == "ready"
            or probe.get("runtime_service_reason_code") != "owner_invalid"):
        _fail("API health/current-session proof does not establish an execution-blocked diagnostic instance")
    owner_pids = [ready_owner["pid"], *(child["pid"] for child in ready_owner["children"])]
    if probe.get("owner_pids_absent") != sorted(owner_pids):
        _fail("Runtime owner/scheduler absence proof differs from the exact historical owner")
    process_ids = probe.get("process_ids")
    if (not isinstance(process_ids, list) or len(process_ids) != 4
            or process_ids[2] != process.get("api_pid")):
        _fail("Backend process inventory is incomplete")
    current_commit = probe.get("current_build_commit")
    current_snapshot = probe.get("current_build_snapshot")
    if (not isinstance(current_commit, str) or re.fullmatch(r"[0-9a-f]{40}", current_commit) is None
            or not isinstance(current_snapshot, str) or SHA256_RE.fullmatch(current_snapshot) is None):
        _fail("Current compiled build identity is malformed")
    return {
        "runtime_config_sha256": _sha256(config_raw),
        "owner_sha256": _sha256(owner_raw),
        "process_receipt_sha256": _sha256(process_raw),
        "failure_fence_sha256": _sha256(fence_raw),
        "resume_sidecar_sha256": _sha256(sidecar_raw),
        "provenance_sha256": _sha256(provenance_raw),
        "runtime_config_raw": config_raw,
        "owner_raw": owner_raw,
        "fence_raw": fence_raw,
        "owner": ready_owner,
        "process": process,
        "fence": fence,
        "api_instance_id": probe["api_instance_id"],
        "api_pid": probe["api_pid"],
        "current_build_commit": current_commit,
        "current_build_snapshot": current_snapshot,
        "owner_pids_absent": sorted(owner_pids),
        "process_ids": list(process_ids),
        "fence_relative": fence_relative,
    }


def _assert_group_consumers(control: BuildControl, operation, ids: Mapping[str, str]) -> str:
    from docker_volume_unclaimed_cancellation import _project_container_ids, _volume_consumer_ids
    from docker_compose_identity import validate_source_labels

    receipt = operation.get("receipt", {})
    attempt = receipt.get("attempt")
    name = receipt.get("helper_container")
    if (not isinstance(attempt, str) or ATTEMPT_RE.fullmatch(attempt) is None
            or name != "fullmag-control-" + attempt):
        _fail("Stop-bootstrap lease has no exact BuildControl helper identity")
    rows = json.loads(docker_capture("inspect", name).stdout)
    if len(rows) != 1:
        _fail("Stop-bootstrap BuildControl helper is ambiguous")
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
        _fail("Stop-bootstrap BuildControl helper differs from its private lease")
    validate_source_labels(helper, control.identity)
    mounts = helper.get("Mounts")
    control_mounts = [item for item in mounts if isinstance(item, Mapping)
                      and item.get("Destination") == "/control"] if isinstance(mounts, list) else []
    if (len(control_mounts) != 1 or control_mounts[0].get("Type") != "volume"
            or control_mounts[0].get("Name") != control.volume):
        _fail("Stop-bootstrap helper does not mount the selected control volume")
    command = config.get("Cmd")
    command_text = " ".join(command) if isinstance(command, list) and all(
        isinstance(item, str) for item in command
    ) else ""
    if ("/control/stop-bootstrap/attempts/" + attempt not in command_text
            or "until test -f" not in command_text or "/control/active" not in command_text):
        _fail("BuildControl helper is not holding this exact stop-bootstrap lease")
    expected = set(ids.values()) | {helper["Id"]}
    if (_project_container_ids(control.project) != expected
            or _volume_consumer_ids(control.volume) != expected):
        _fail("Compose group or control volume has another consumer")
    return helper["Id"]


def _fingerprint(pins: Mapping[str, object], evidence: Mapping[str, object], image: str, ids: Mapping[str, str], actual) -> tuple[object, ...]:
    return (
        pins.get("container_iteration"),
        pins["terminal_sha256"], pins["compose_sha256"], pins["resume"]["sha256"],
        pins["resume_sidecar_sha256"], pins["backend_started_at"], pins["image_id"],
        pins["backend_container"], pins["frontend_container"],
        evidence["runtime_config_sha256"], evidence["owner_sha256"],
        evidence["process_receipt_sha256"], evidence["failure_fence_sha256"],
        evidence["resume_sidecar_sha256"], evidence["provenance_sha256"],
        evidence["api_instance_id"], evidence["api_pid"], evidence["current_build_commit"],
        evidence["current_build_snapshot"], image, ids["backend"], ids["frontend"],
        actual["backend"].get("State", {}).get("StartedAt"),
        actual["frontend"].get("State", {}).get("StartedAt"),
    )


def _observe(args, control, selected, identity, pins):
    from docker_volume_stop_diagnostic import _container_snapshot

    image, ids, actual = _container_snapshot(
        args, selected, identity, control, pins["effective_previous"], pins["compose"]
    )
    if (image != pins["image_id"]
            or ids["backend"] != pins["backend_container"]
            or ids["frontend"] != pins["frontend_container"]):
        _fail("Compose service IDs/image differ from the exact linked development and resume pins")
    probe = _probe_backend(ids["backend"])
    evidence = _probe_evidence(control, pins, probe)
    return image, ids, actual, evidence


def stop_bootstrap(args: argparse.Namespace) -> dict[str, object]:
    from docker_dev import _compose_identity, _select_source

    if not isinstance(args.attempt, str) or ATTEMPT_RE.fullmatch(args.attempt) is None:
        _fail("Development attempt is not a complete lowercase identity")
    if not isinstance(args.resume_attempt, str) or ATTEMPT_RE.fullmatch(args.resume_attempt) is None:
        _fail("Resume attempt is not a complete lowercase identity")
    if not isinstance(args.config_sha256, str) or SHA256_RE.fullmatch(args.config_sha256) is None:
        _fail("Compose config SHA-256 is not a complete lowercase digest")
    if type(args.port) is not int or not 1 <= args.port <= 65535:
        _fail("Frontend port is outside the valid range")

    require_host()
    repo_root = Path(args.repo_root).resolve(strict=True)
    selected, layout = _select_source(repo_root, args.source_root)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    try:
        helper_image = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    except (KeyError, TypeError) as error:
        raise BuildControlError("Selected Compose toolchain does not pin the managed BuildControl image") from error
    control = BuildControl(identity, helper_image)
    control.prepare()

    initial_pins = _load_pins(args, control, selected)
    initial_image, initial_ids, initial_actual, initial_evidence = _observe(
        args, control, selected, identity, initial_pins
    )
    initial_fingerprint = _fingerprint(
        initial_pins, initial_evidence, initial_image, initial_ids, initial_actual
    )
    operation_inputs = {
        "attempt": args.attempt,
        "resume_attempt": args.resume_attempt,
        "config_sha256": args.config_sha256,
        "source_root": str(selected),
        "port": args.port,
        "image_id": initial_image,
        "backend_container_id": initial_ids["backend"],
        "frontend_container_id": initial_ids["frontend"],
        "backend_started_at": initial_pins["backend_started_at"],
        "development_terminal_sha256": initial_pins["terminal_sha256"],
        "resume_terminal_sha256": initial_pins["resume"]["sha256"],
        "compose_sha256": initial_pins["compose_sha256"],
        "resume_process_failure_sha256": initial_pins["resume_sidecar_sha256"],
        "process_receipt_sha256": initial_evidence["process_receipt_sha256"],
        "owner_sha256": initial_evidence["owner_sha256"],
        "failure_fence_sha256": initial_evidence["failure_fence_sha256"],
        "api_instance_id": initial_evidence["api_instance_id"],
        "current_build_commit": initial_evidence["current_build_commit"],
        "current_build_snapshot": initial_evidence["current_build_snapshot"],
        "pin_sources": initial_pins["pin_sources"],
        "container_iteration": initial_pins["container_iteration"],
        "execution_state": "unknown",
    }

    with control.operation("stop-bootstrap", operation_inputs) as operation:
        operation["receipt"].update(
            state="validating-bootstrap-api",
            execution_state="unknown",
        )
        pins = _load_pins(args, control, selected)
        image, ids, actual, evidence = _observe(args, control, selected, identity, pins)
        if _fingerprint(pins, evidence, image, ids, actual) != initial_fingerprint:
            _fail("Startup-failure, owner, API, or Compose pins changed under the stop lease")
        helper_id = _assert_group_consumers(control, operation, ids)
        control._assert_live_operation_helper(operation)

        preflight = {
            "schema": "fullmag.docker-bootstrap-api-stop-preflight.v1",
            "state": "preflight-confirmed",
            "execution_state": "unknown",
            "attempt": args.attempt,
            "resume_attempt": args.resume_attempt,
            "config_sha256": args.config_sha256,
            "development_terminal_sha256": pins["terminal_sha256"],
            "resume_terminal_sha256": pins["resume"]["sha256"],
            "compose_sha256": pins["compose_sha256"],
            "image_id": image,
            "backend_container_id": ids["backend"],
            "frontend_container_id": ids["frontend"],
            "backend_started_at": pins["backend_started_at"],
            "pin_sources": pins["pin_sources"],
            "container_iteration": pins["container_iteration"],
            "runtime_owner_state": "ready-history-preserved",
            "owner_sha256": evidence["owner_sha256"],
            "owner_pids_absent": evidence["owner_pids_absent"],
            "process_receipt_sha256": evidence["process_receipt_sha256"],
            "resume_process_failure_sha256": pins["resume_sidecar_sha256"],
            "failure_fence_sha256": evidence["failure_fence_sha256"],
            "api_pid": evidence["api_pid"],
            "api_instance_id": evidence["api_instance_id"],
            "probe_process_ids": evidence["process_ids"],
            "current_build_commit": evidence["current_build_commit"],
            "current_build_snapshot": evidence["current_build_snapshot"],
            "resource_leases": "untouched",
            "session_store": "untouched",
        }
        control.write(operation["root"] + "/stop-bootstrap-preflight.json", preflight)

        # The preflight receipt write can take time. Re-read every durable and
        # live pin after it, with the operation lock held, immediately before
        # signaling only the selected backend service.
        final_pins = _load_pins(args, control, selected)
        final_image, final_ids, final_actual, final_evidence = _observe(
            args, control, selected, identity, final_pins
        )
        if _fingerprint(final_pins, final_evidence, final_image, final_ids, final_actual) != initial_fingerprint:
            _fail("Pre-owner startup failure evidence changed immediately before the backend stop")
        if _assert_group_consumers(control, operation, final_ids) != helper_id:
            _fail("BuildControl helper identity changed immediately before the stop")
        control._assert_live_operation_helper(operation)
        operation["receipt"].update(
            state="stopping-bootstrap-diagnostic-api",
            helper_container_id=helper_id,
            execution_state="unknown",
        )
        operation["daemon_pending"] = True
        compose_capture(pins["compose"], "stop", "--timeout", "60", "backend", timeout=90)

        stopped_rows = json.loads(docker_capture("inspect", ids["backend"]).stdout)
        if len(stopped_rows) != 1:
            _fail("Stopped bootstrap backend inspection is ambiguous")
        stopped = stopped_rows[0]
        if (stopped.get("Id") != ids["backend"]
                or stopped.get("Image") != image
                or stopped.get("State", {}).get("StartedAt") != pins["backend_started_at"]
                or stopped.get("State", {}).get("Running") is not False):
            _fail("Compose did not confirm stopping the exact pinned backend incarnation")
        frontend_rows = json.loads(docker_capture("inspect", ids["frontend"]).stdout)
        if (len(frontend_rows) != 1
                or frontend_rows[0].get("Id") != ids["frontend"]
                or frontend_rows[0].get("Image") != image
                or frontend_rows[0].get("State", {}).get("StartedAt")
                    != final_actual["frontend"].get("State", {}).get("StartedAt")
                or frontend_rows[0].get("State", {}).get("Running") is not True):
            _fail("Frontend changed while stopping the backend; no further lifecycle action was taken")

        owner_after = _read_raw(control, "runtime-control/runtime-services/OWNER.json", maximum=256 * 1024)
        config_after = _read_raw(control, "runtime-control/runtime-service/docker-all.json", maximum=256 * 1024)
        fence_after = _read_raw(control, evidence["fence_relative"], maximum=256 * 1024)
        sidecar_after = _read_raw(control, pins["resume_sidecar_relative"])
        process_after_raw = _read_raw(control, "runtime-control/runtime-service/process-tree.json")
        process_after = _json(process_after_raw, "post-stop process receipt")
        process_before = evidence["process"]
        if (
            owner_after != evidence["owner_raw"]
            or _sha256(owner_after) != evidence["owner_sha256"]
            or config_after != evidence["runtime_config_raw"]
            or _sha256(config_after) != evidence["runtime_config_sha256"]
            or fence_after != evidence["fence_raw"]
            or _sha256(fence_after) != evidence["failure_fence_sha256"]
            or sidecar_after != pins["resume_sidecar_raw"]
            or process_after.get("state") != "shutdown_unknown"
            or process_after.get("api_diagnostic_only") is not True
            or process_after.get("api_pid") != evidence["api_pid"]
            or process_after.get("api_failure_fence") != process_before.get("api_failure_fence")
            or process_after.get("shutdown_error") != EXPECTED_SHUTDOWN_ERROR
            or type(process_after.get("api_exit_code")) is not int
            or "service_owner" in process_after or "runtime_pid" in process_after
            or "terminal_service_owner" in process_after
        ):
            _fail("Post-stop evidence did not preserve OWNER and report only unknown native shutdown")
        before_comparable = dict(process_before)
        after_comparable = dict(process_after)
        for field in ("state", "api_exit_code", "shutdown_error"):
            before_comparable.pop(field, None)
            after_comparable.pop(field, None)
        if before_comparable != after_comparable:
            _fail("Supervisor changed process evidence beyond the expected unknown API shutdown")

        _verify_container_iteration(control, pins["container_iteration"])
        terminal_raw = _read_raw(control, pins["terminal_relative"])
        resume_raw = _read_raw(control, pins["resume"]["relative"])
        compose_raw = _read_raw(control, pins["compose_relative"])
        if (_sha256(terminal_raw) != pins["terminal_sha256"]
                or _sha256(resume_raw) != pins["resume"]["sha256"]
                or _sha256(compose_raw) != pins["compose_sha256"]):
            _fail("Original development/resume/Compose receipts changed during the stop")
        if _assert_group_consumers(control, operation, ids) != helper_id:
            _fail("Compose or control-volume consumer set changed during the stop")
        stopped_again = json.loads(docker_capture("inspect", ids["backend"]).stdout)
        if (len(stopped_again) != 1
                or stopped_again[0].get("Id") != ids["backend"]
                or stopped_again[0].get("Image") != image
                or stopped_again[0].get("State", {}).get("StartedAt") != pins["backend_started_at"]
                or stopped_again[0].get("State", {}).get("Running") is not False):
            _fail("Exact backend stopped state changed during post-stop evidence capture")

        terminal = {
            "schema": "fullmag.docker-bootstrap-api-stop.v1",
            "state": "stopped-confirmed",
            "execution_state": "unknown",
            "created_at": time.time(),
            "attempt": args.attempt,
            "resume_attempt": args.resume_attempt,
            "config_sha256": args.config_sha256,
            "source_root": str(selected),
            "port": args.port,
            "compose_project": control.project,
            "image_id": image,
            "backend_container_id": ids["backend"],
            "backend_started_at": pins["backend_started_at"],
            "frontend_container_id": ids["frontend"],
            "pin_sources": pins["pin_sources"],
            "container_iteration": pins["container_iteration"],
            "development_terminal_sha256": pins["terminal_sha256"],
            "resume_terminal_sha256": pins["resume"]["sha256"],
            "compose_sha256": pins["compose_sha256"],
            "resume_process_failure_sha256": pins["resume_sidecar_sha256"],
            "runtime_owner_state": "ready-history-preserved",
            "owner_sha256_before": evidence["owner_sha256"],
            "owner_sha256_after": _sha256(owner_after),
            "runtime_config_sha256": evidence["runtime_config_sha256"],
            "process_receipt_sha256_before": evidence["process_receipt_sha256"],
            "process_receipt_sha256_after": _sha256(process_after_raw),
            "failure_fence_sha256": evidence["failure_fence_sha256"],
            "api_pid": evidence["api_pid"],
            "api_instance_id": evidence["api_instance_id"],
            "api_exit_code": process_after["api_exit_code"],
            "shutdown_error": EXPECTED_SHUTDOWN_ERROR,
            "current_build_commit": evidence["current_build_commit"],
            "current_build_snapshot": evidence["current_build_snapshot"],
            "backend_running": False,
            "frontend_running": True,
            "resource_leases": "untouched",
            "session_store": "untouched",
        }
        control.write(operation["root"] + "/stop-bootstrap-terminal.json", terminal)
        operation["daemon_pending"] = False
        operation["receipt"].update(
            state="succeeded",
            stop_state="stopped-confirmed",
            execution_state="unknown",
            owner_state="ready-history-preserved",
            stop_bootstrap_terminal_sha256=_sha256(canonical(terminal)),
        )
        return terminal



