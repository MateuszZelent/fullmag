"""Safely stop one pinned pre-admission Docker DEV startup failure.

This command is deliberately narrower than runtime recovery.  It is allowed
only for a failed startup-script admission whose durable rejection marker is
bound to one request/source/session and whose accepted store and host ledger
prove that no run or reservation was admitted.  It never clears a lease,
removes a volume, recreates Compose services, or retries the script.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Mapping

import fullmag_storage as storage
from docker_build_control import (
    BuildControl,
    BuildControlError,
    ControlOutcomeUnknown,
    bounded_capture,
    canonical,
    control_read_script,
    docker_capture,
    toolchain_configuration,
)
from docker_dev import _compose_identity, _select_source
from docker_volume_activate import _same_host_path, _validate_running_group
from docker_volume_dev import _assert_private_restart_network, _validate_retained_service
from docker_compose_identity import validate_source_labels
from docker_dev_host import docker_argv


ATTEMPT_RE = re.compile(r"^[0-9a-f]{32}$")
CONTAINER_ID_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")
MAX_PROBE_BYTES = 8 * 1024 * 1024
PROCESS_RECEIPT_SCHEMA = "fullmag.docker-process-tree.v1"
CANONICAL_RUNTIME_PROCESS_RECEIPT = "/opt/fullmag/runtime-control/runtime-service/process-tree.json"
RUNTIME_CONTROL_SUBPATH = "runtime-control"
OWNER_IDENTITY_FIELDS = (
    "owner_token",
    "process_start_token",
    "pid",
    "host",
    "target_id",
    "control_address",
    "build_commit",
    "build_snapshot",
    "compute_pool_id",
    "preparation_pool_id",
    "compute_pool_generation",
    "preparation_pool_generation",
)


class StopUnadmittedError(BuildControlError):
    """The exact pre-admission stop proof is absent or inconsistent."""


def _fail(message: str) -> StopUnadmittedError:
    return StopUnadmittedError(message)


def _require(value: object, pattern: re.Pattern[str], label: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise _fail(f"{label} is not a complete immutable identity")
    return value


def _json(raw: bytes, label: str) -> dict[str, object]:
    if len(raw) > MAX_PROBE_BYTES:
        raise _fail(f"{label} exceeds the bounded observation size")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _fail(f"{label} is not valid JSON") from error
    if not isinstance(value, dict):
        raise _fail(f"{label} is not a JSON object")
    return value


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _env_map(document: Mapping[str, object]) -> dict[str, str]:
    config = document.get("Config")
    raw = config.get("Env", []) if isinstance(config, Mapping) else []
    if not isinstance(raw, list):
        raise _fail("container environment is not a list")
    result: dict[str, str] = {}
    for item in raw:
        if isinstance(item, str) and "=" in item:
            name, value = item.split("=", 1)
            result[name] = value
    return result


def _validate_runtime_process_receipt_override(env: Mapping[str, str]) -> None:
    """Allow the image-owned default while fencing an explicit override."""
    override = env.get("FULLMAG_RUNTIME_PROCESS_RECEIPT")
    if override is not None and override != CANONICAL_RUNTIME_PROCESS_RECEIPT:
        raise _fail("backend process receipt path override differs from the canonical runtime-control path")


def _owner_identity_key(owner: Mapping[str, object], label: str) -> tuple[tuple[object, ...], tuple[tuple[object, object], ...]]:
    """Build the same stable owner/child identity used by runtime_service."""
    if not isinstance(owner, Mapping):
        raise _fail(f"{label} is not a runtime-service owner object")
    children = owner.get("children")
    if not isinstance(children, list):
        raise _fail(f"{label} has no scheduler child identity")
    child_identity: list[tuple[object, object]] = []
    for child in children:
        if not isinstance(child, Mapping):
            raise _fail(f"{label} has an invalid scheduler child")
        child_identity.append((child.get("role"), child.get("pid")))
    child_identity.sort(key=lambda item: (str(item[0]), str(item[1])))
    return (
        tuple(owner.get(field) for field in OWNER_IDENTITY_FIELDS),
        tuple(child_identity),
    )


def _validate_frontend_stopped(actual: Mapping[str, object]) -> None:
    state = actual.get("State")
    if not isinstance(state, Mapping) or state.get("Running"):
        raise _fail("frontend did not stop cleanly")
    if state.get("ExitCode") != 0:
        raise _fail("frontend stop did not produce the canonical graceful exit code")


def _control_bytes(control: BuildControl, relative: str, *, optional: bool = False) -> bytes | None:
    path = control.path(relative)
    script = control_read_script(path, MAX_PROBE_BYTES)
    result = bounded_capture(control.helper_args(script), data=b"", timeout=90)
    if optional and result.returncode == 44:
        return None
    if result.returncode:
        raise _fail(f"cannot read control-volume record {relative}: "
                    + result.stderr.decode("utf-8", "replace")[-1024:])
    if len(result.stdout) > MAX_PROBE_BYTES:
        raise _fail(f"control-volume record {relative} exceeds its size bound")
    return bytes(result.stdout)


def _read_control_json(control: BuildControl, relative: str, *, optional: bool = False) -> dict[str, object] | None:
    raw = _control_bytes(control, relative, optional=optional)
    if raw is None:
        return None
    return _json(raw, f"control-volume record {relative}")


def _validate_attempt_identity(
    args: argparse.Namespace,
    selected: Path,
    control: BuildControl,
    terminal: Mapping[str, object],
    compose: Mapping[str, object],
) -> dict[str, object]:
    if terminal.get("schema") != "fullmag.docker-build-operation.v1" or terminal.get("phase") != "development":
        raise _fail("retained record is not a development attempt")
    if terminal.get("state") not in {"failed-confirmed", "succeeded"}:
        raise _fail("operator stop requires a retained development attempt")
    if terminal.get("compose_project") != control.project or terminal.get("attempt") != args.attempt:
        raise _fail("retained attempt belongs to another Compose group")
    if terminal.get("config_sha256") not in (None, args.config_sha256):
        raise _fail("retained terminal/config pin differs")
    if _sha256(canonical(compose)) != args.config_sha256:
        raise _fail("retained Compose configuration/CAS differs")
    inputs = terminal.get("inputs")
    if not isinstance(inputs, Mapping):
        raise _fail("retained attempt has no immutable input record")
    if inputs.get("source_root") != str(selected) or inputs.get("image_id") != args.image_id:
        raise _fail("retained source or development image differs")
    state_root = terminal.get("state_root")
    if not isinstance(state_root, str) or not state_root:
        raise _fail("retained attempt has no state root")
    state = Path(state_root).resolve()
    layout = storage.resolve_layout(selected, "docker-all-gpu")
    storage.validate_path(state, Path(str(layout["runtime_root"])), "retained Windows runtime state")
    return {"inputs": dict(inputs), "state_root": str(state)}


def _validate_container(
    actual: Mapping[str, object], service: str, expected_id: str, image_id: str,
    identity: Mapping[str, object], compose: Mapping[str, object], image_config: Mapping[str, object],
) -> None:
    if actual.get("Id") != expected_id or actual.get("Image") != image_id:
        raise _fail(f"pinned {service} container/image identity differs")
    config = actual.get("Config")
    labels = config.get("Labels") if isinstance(config, Mapping) else None
    if not isinstance(labels, Mapping):
        raise _fail(f"pinned {service} has no labels")
    if labels.get("com.docker.compose.project") != identity["project_name"]:
        raise _fail(f"pinned {service} belongs to another Compose project")
    if labels.get("com.docker.compose.service") != service:
        raise _fail(f"pinned container is not the {service} service")
    validate_source_labels(actual, identity)
    if not actual.get("State", {}).get("Running"):
        raise _fail(f"pinned {service} is not running")
    _validate_retained_service(compose, actual, service, image_config)


def _validate_source_bind(actual: Mapping[str, object], expected_source: Path,
                          daemon_binds: Mapping[str, object] | None = None) -> None:
    mounts = actual.get("Mounts")
    if not isinstance(mounts, list):
        raise _fail("backend mounts cannot be inspected")
    candidates = [mount for mount in mounts if isinstance(mount, Mapping)
                  and mount.get("Destination") == "/opt/fullmag/source"]
    if len(candidates) != 1:
        raise _fail("backend does not have exactly one source mount")
    mount = candidates[0]
    if mount.get("Type") != "bind" or mount.get("RW") is not False:
        raise _fail("backend source mount is not readonly")
    if daemon_binds is not None:
        pinned = daemon_binds.get("/opt/fullmag/source") if isinstance(daemon_binds, Mapping) else None
        matches = isinstance(pinned, str) and bool(pinned) and mount.get("Source") == pinned
    else:
        matches = _same_host_path(mount.get("Source"), str(expected_source))
    if not matches:
        raise _fail("backend source mount differs from the selected checkout")


def _probe_script() -> str:
    """Return the bounded read-only probe executed inside the backend."""
    return r'''import fcntl, hashlib, json, os, pathlib, stat, sys, time, urllib.error, urllib.request
MAX=8*1024*1024
MAX_ENTRIES=8192
request_id, session_id, expected_source_sha, marker_sha = sys.argv[1:5]

def read_regular(path, label, maximum=MAX):
    path=pathlib.Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise RuntimeError(label+' path is unsafe')
    fd=os.open(path, os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
    try:
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size>maximum: raise RuntimeError(label+' is not bounded regular file')
        data=os.read(fd, maximum+1)
        if len(data)>maximum: raise RuntimeError(label+' exceeds bound')
        return data
    finally: os.close(fd)

def read_json(path, label):
    try: value=json.loads(read_regular(path,label).decode('utf-8'))
    except (UnicodeDecodeError,json.JSONDecodeError) as error: raise RuntimeError(label+' is invalid JSON') from error
    if not isinstance(value,dict): raise RuntimeError(label+' is not an object')
    return value

def lock_probe(path, label):
    path=pathlib.Path(path)
    if not path.is_file() or path.is_symlink(): raise RuntimeError(label+' is missing')
    fd=os.open(path, os.O_RDWR|getattr(os,'O_NOFOLLOW',0))
    try:
        deadline=time.monotonic()+5
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
                return fd
            except BlockingIOError as error:
                if time.monotonic()>=deadline:
                    raise RuntimeError(label+' remained busy within the observation budget') from error
                time.sleep(0.05)
            except OSError as error:
                raise RuntimeError(label+' lock outcome is unknown') from error
    except Exception:
        os.close(fd); raise

def scan_store(root):
    root=pathlib.Path(root)
    if not root.is_dir() or root.is_symlink(): raise RuntimeError('accepted store root is missing')
    fd=lock_probe(root/'WRITER.lock','accepted-store writer lock')
    try:
        runs_root=root/'runs'
        if not runs_root.is_dir() or runs_root.is_symlink(): raise RuntimeError('accepted store runs directory is missing')
        run_directories=[]
        with os.scandir(runs_root) as entries:
            for entry in entries:
                if entry.is_symlink(): raise RuntimeError('accepted store runs directory contains a symlink')
                if not entry.is_dir(follow_symlinks=False): raise RuntimeError('accepted store runs directory contains a non-directory entry')
                run_directories.append(entry.name)
                if len(run_directories)>MAX_ENTRIES: raise RuntimeError('accepted-store run inventory is unbounded')
        found=[]; count=0
        for run_name in run_directories:
            run_path=runs_root/run_name
            for marker_name in ('run_intent.json','run_catalog.json'):
                marker_path=run_path/marker_name
                if os.path.lexists(marker_path): found.append(str(marker_path.relative_to(root)))
        for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
            current_path=pathlib.Path(current)
            for name in list(dirs):
                if (current_path/name).is_symlink(): raise RuntimeError('accepted store contains a symlink')
            for name in files:
                count+=1
                if count>MAX_ENTRIES: raise RuntimeError('accepted-store inventory is unbounded')
                path=current_path/name
                if path.is_symlink() or not path.is_file(): raise RuntimeError('accepted store contains an invalid entry')
                if name in {'run_intent.json','run_catalog.json'}: found.append(str(path.relative_to(root)))
        if found: raise RuntimeError('accepted store contains run records: '+','.join(found[:8]))
        return {'root':str(root),'file_count':count,'run_directories':run_directories,'run_records':found}
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN); os.close(fd)

def scan_ledger(root):
    root=pathlib.Path(root)
    if not root.is_dir() or root.is_symlink(): raise RuntimeError('host ledger root is missing')
    writer=lock_probe(root/'WRITER.lock','host ledger writer lock')
    try:
        document=read_json(root/'HOST_RESOURCE_LEDGER.json','host resource ledger')
        reservations=document.get('reservations')
        if not isinstance(reservations,list): raise RuntimeError('host ledger reservations are missing')
        states=[]
        for row in reservations:
            if not isinstance(row,dict) or not isinstance(row.get('state'),str): raise RuntimeError('host ledger reservation is invalid')
            states.append(row['state'])
        if any(state!='released' for state in states): raise RuntimeError('host ledger has active or unknown reservations')
        return {'root':str(root),'schema':document.get('schema_version'),'reservation_states':states,'reservation_count':len(states)}
    finally:
        fcntl.flock(writer, fcntl.LOCK_UN); os.close(writer)

def api_get(path):
    request=urllib.request.Request('http://127.0.0.1:8081'+path, headers={'Accept':'application/json','Host':'localhost'})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            data=response.read(MAX+1)
            if len(data)>MAX: raise RuntimeError(path+' response exceeds bound')
            value=json.loads(data.decode('utf-8'))
            if not isinstance(value,dict): raise RuntimeError(path+' response is not an object')
            return response.status, value
    except urllib.error.HTTPError as error:
        data=error.read(MAX+1)
        try: value=json.loads(data.decode('utf-8'))
        except (UnicodeDecodeError,json.JSONDecodeError) as parse_error: raise RuntimeError(path+' error response is invalid') from parse_error
        return error.code, value

receipt_candidates=[]
env_receipt=os.environ.get('FULLMAG_RUNTIME_PROCESS_RECEIPT')
if env_receipt: receipt_candidates.append(env_receipt)
receipt_candidates += ['/opt/fullmag/runtime-control/runtime-service/process-tree.json']
receipt_path=next((path for path in receipt_candidates if os.path.exists(path)),None)
if receipt_path is None: raise RuntimeError('runtime process receipt is missing')
receipt_raw=read_regular(receipt_path,'runtime process receipt')
receipt=read_json(receipt_path,'runtime process receipt')
if receipt.get('schema')!='fullmag.docker-process-tree.v1': raise RuntimeError('runtime process receipt schema differs')
if receipt.get('state')!='ready': raise RuntimeError('runtime process receipt is not ready')
if os.environ.get('FULLMAG_STARTUP_ENABLED')=='1': raise RuntimeError('internal startup activation is not admissible for this external-stop recipe')
if 'startup_activation' in receipt: raise RuntimeError('runtime process receipt contains an internal startup activation outcome')
service_owner=receipt.get('service_owner')
if not isinstance(service_owner,dict): raise RuntimeError('runtime process receipt has no ready service owner')
try:
 import runtime_service as _runtime_service
 _runtime_service._validate_terminal_owner(service_owner,state='ready',name='pre-stop service owner')
except Exception as error: raise RuntimeError('image-owned ready service-owner validation failed') from error
marker_key=hashlib.sha256(request_id.encode('utf-8')).hexdigest()
marker_path='/opt/fullmag/control/backend/script-activation-'+marker_key+'/activation.json'
marker_raw=read_regular(marker_path,'startup activation marker')
marker=read_json(marker_path,'startup activation marker')
if hashlib.sha256(marker_raw).hexdigest()!=marker_sha: raise RuntimeError('startup marker digest changed')
if marker.get('schema')!='fullmag.docker-startup-activation-receipt.v1' or marker.get('state')!='rejected': raise RuntimeError('startup marker is not a durable rejection')
if marker.get('request_id')!=request_id or marker.get('source_sha256')!=expected_source_sha: raise RuntimeError('startup marker request/source fence differs')
authorization=marker.get('authorization')
if (not isinstance(authorization,dict) or authorization.get('request_id')!=request_id
        or authorization.get('source_sha256')!=expected_source_sha
        or authorization.get('container_source_root')!='/opt/fullmag/source'
        or not isinstance(authorization.get('source_relative'),str)
        or not authorization.get('source_relative')): raise RuntimeError('startup marker authorization fence differs')
result=marker.get('result')
if (not isinstance(result,dict) or result.get('state')!='rejected'
        or result.get('schema')!='fullmag.startup-script-activation.v1'
        or result.get('request_id')!=request_id
        or result.get('source_sha256')!=expected_source_sha
        or result.get('source_relative')!=authorization.get('source_relative')): raise RuntimeError('startup marker terminal result is missing or fenced differently')
status, session=api_get('/v2/sessions/current')
if status!=200 or session.get('session_id')!=session_id: raise RuntimeError('current session does not match pinned startup session')
if session.get('status')!='startup_failed': raise RuntimeError('current session is not the rejected startup session')
script=session.get('script')
if not isinstance(script,dict) or script.get('sha256')!=expected_source_sha: raise RuntimeError('current session script digest differs from the rejected startup source')
queue_status, queue=api_get('/v2/platform/compute/queue')
if queue_status!=200 or queue.get('schema_version')!='compute_queue.v1': raise RuntimeError('compute queue is not readable with its canonical schema')
items=queue.get('items')
if not isinstance(items,list) or items: raise RuntimeError('compute queue is not empty')
runtime_status, runtime=api_get('/v2/platform/runtime-service')
if runtime_status!=200 or runtime.get('configured') is not True or runtime.get('state')!='ready': raise RuntimeError('native runtime service is not ready')
reason=runtime.get('reason')
if not isinstance(reason,dict) or reason.get('code')!='service_ready': raise RuntimeError('native runtime service readiness reason differs')
run_status, run=api_get('/v2/sessions/current/simulation/runs/current')
if run_status!=404: raise RuntimeError('current run is not definitively absent')
store=scan_store(os.environ.get('FULLMAG_RUNS_ROOT','/state/runs/docker-all')+'/session-store')
ledger=scan_ledger(os.environ.get('FULLMAG_HOST_LEDGER_ROOT','/host-ledger/ledger'))
print(json.dumps({'schema':'fullmag.docker-unadmitted-stop-probe.v1','process_receipt_sha256':hashlib.sha256(receipt_raw).hexdigest(),'activation_marker_sha256':hashlib.sha256(marker_raw).hexdigest(),'request_id':request_id,'session_id':session_id,'source_sha256':expected_source_sha,'process_receipt':receipt,'activation_marker':marker,'current_session':session,'current_session_status':session.get('status'),'current_session_script_sha256':script.get('sha256'),'compute_queue':queue,'runtime_service':runtime,'current_run_status':run_status,'accepted_store':store,'host_ledger':ledger},sort_keys=True))
'''


def _probe(backend_id: str, request_id: str, session_id: str, source_sha256: str, marker_sha256: str) -> dict[str, object]:
    result = docker_capture(
        "exec", "--env", "PYTHONPATH=/opt/fullmag:/opt/fullmag/package:/build/workspace/packages/fullmag-py/src",
        backend_id, "/usr/local/bin/python3", "-B", "-c", _probe_script(),
        request_id, session_id, source_sha256, marker_sha256, timeout=90,
    )
    if result.returncode:
        raise _fail("pre-admission proof probe failed: " + result.stderr.decode("utf-8", "replace")[-4096:])
    return _json(result.stdout, "pre-admission proof probe")


def _validate_probe_document(
    probe: Mapping[str, object], args: argparse.Namespace
) -> None:
    """Validate the in-container observation again at the operator boundary."""
    if probe.get("schema") != "fullmag.docker-unadmitted-stop-probe.v1":
        raise _fail("pre-admission proof schema differs")
    if probe.get("request_id") != args.request_id or probe.get("session_id") != args.session_id:
        raise _fail("pre-admission proof request/session fence differs")
    if probe.get("source_sha256") != args.source_sha256:
        raise _fail("pre-admission proof source fence differs")
    if probe.get("activation_marker_sha256") != args.failure_marker_sha256:
        raise _fail("pre-admission failure marker digest differs")
    if probe.get("process_receipt_sha256") != args.process_receipt_sha256:
        raise _fail("pre-admission process receipt digest differs")
    session = probe.get("current_session")
    if not isinstance(session, Mapping) or session.get("session_id") != args.session_id:
        raise _fail("pre-admission current session differs")
    if session.get("status") != "startup_failed":
        raise _fail("pre-admission current session is not startup_failed")
    script = session.get("script")
    if not isinstance(script, Mapping) or script.get("sha256") != args.source_sha256:
        raise _fail("pre-admission current session script digest differs")
    queue = probe.get("compute_queue")
    if (
        not isinstance(queue, Mapping)
        or queue.get("schema_version") != "compute_queue.v1"
        or queue.get("items") != []
    ):
        raise _fail("pre-admission compute queue is not empty")
    runtime = probe.get("runtime_service")
    reason = runtime.get("reason") if isinstance(runtime, Mapping) else None
    if (
        not isinstance(runtime, Mapping)
        or runtime.get("configured") is not True
        or runtime.get("state") != "ready"
        or not isinstance(reason, Mapping)
        or reason.get("code") != "service_ready"
    ):
        raise _fail("pre-admission native runtime service is not ready")
    if probe.get("current_run_status") != 404:
        raise _fail("pre-admission current run is not absent")
    store = probe.get("accepted_store")
    if not isinstance(store, Mapping) or store.get("run_records") != []:
        raise _fail("accepted store is not empty of run admissions")
    ledger = probe.get("host_ledger")
    states = ledger.get("reservation_states") if isinstance(ledger, Mapping) else None
    if not isinstance(states, list) or any(state != "released" for state in states):
        raise _fail("host ledger is not terminal and released")
    marker = probe.get("activation_marker")
    if (
        not isinstance(marker, Mapping)
        or marker.get("schema") != "fullmag.docker-startup-activation-receipt.v1"
        or marker.get("state") != "rejected"
        or marker.get("request_id") != args.request_id
        or marker.get("source_sha256") != args.source_sha256
    ):
        raise _fail("pre-admission activation marker is not rejected")
    authorization = marker.get("authorization")
    result = marker.get("result")
    if (
        not isinstance(authorization, Mapping)
        or authorization.get("request_id") != args.request_id
        or authorization.get("source_sha256") != args.source_sha256
        or authorization.get("container_source_root") != "/opt/fullmag/source"
        or not isinstance(authorization.get("source_relative"), str)
        or not authorization.get("source_relative")
        or not isinstance(result, Mapping)
        or result.get("state") != "rejected"
        or result.get("schema") != "fullmag.startup-script-activation.v1"
        or result.get("request_id") != args.request_id
        or result.get("source_sha256") != args.source_sha256
        or result.get("source_relative") != authorization.get("source_relative")
    ):
        raise _fail("pre-admission activation marker fence is incomplete")
    receipt = probe.get("process_receipt")
    if not isinstance(receipt, Mapping) or receipt.get("state") != "ready":
        raise _fail("pre-admission process receipt is not ready")
    if "startup_activation" in receipt:
        raise _fail("pre-admission process receipt contains an internal startup activation outcome")
    _owner_identity_key(receipt.get("service_owner"), "pre-admission service owner")


def _validate_network(
    actual: Mapping[str, Mapping[str, object]],
    ids: Mapping[str, str],
    project: str,
    *,
    allow_stopped_frontend: bool = False,
    allow_stopped_backend: bool = False,
) -> None:
    if allow_stopped_backend and (
        allow_stopped_frontend or actual["backend"].get("State", {}).get("Running") is not False
    ):
        raise _fail("Stopped-backend network proof requires the exact stopped backend and running frontend")
    _assert_private_restart_network(actual, ids, project)
    backend_networks = actual["backend"].get("NetworkSettings", {}).get("Networks", {})
    frontend_networks = actual["frontend"].get("NetworkSettings", {}).get("Networks", {})
    if not isinstance(backend_networks, Mapping) or not isinstance(frontend_networks, Mapping):
        raise _fail("Compose network membership is missing")
    if len(backend_networks) != 1:
        raise _fail("backend does not have exactly one private network")
    if allow_stopped_frontend:
        if frontend_networks and set(backend_networks) != set(frontend_networks):
            raise _fail("backend/frontend network identities differ")
    elif set(backend_networks) != set(frontend_networks):
        raise _fail("backend/frontend do not share exactly one private network")
    network_name = next(iter(backend_networks))
    documents = json.loads(docker_capture("network", "inspect", network_name, timeout=60).stdout)
    if len(documents) != 1:
        raise _fail("Compose network inspection is ambiguous")
    network = documents[0]
    consumers = set(network.get("Containers", {}))
    allowed = set(ids.values())
    expected = ({ids["frontend"]} if allow_stopped_backend else
                allowed if not allow_stopped_frontend else {ids["backend"]})
    if (network.get("Driver") != "bridge"
            or network.get("Labels", {}).get("com.docker.compose.project") != project
            or (not allow_stopped_backend and ids["backend"] not in consumers)
            or consumers - allowed
            or (not allow_stopped_frontend and consumers != expected)
            or (allow_stopped_frontend and consumers not in (expected, allowed))):
        raise _fail("Compose network has an unknown consumer or identity")


def _validate_preflight(args: argparse.Namespace, selected: Path, identity: Mapping[str, object], control: BuildControl,
                       terminal: Mapping[str, object], compose: Mapping[str, object]) -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
    retained = _validate_attempt_identity(args, selected, control, terminal, compose)
    running_backend, running_frontend = _validate_running_group(
        control,
        identity,
        compose,
        terminal,
        args.image_id,
        source_root=str(selected),
    )
    if (running_backend, running_frontend) != (
        args.backend_container_id,
        args.frontend_container_id,
    ):
        raise _fail("running Compose group does not match the pinned service identities")
    actual_documents = json.loads(docker_capture("inspect", args.backend_container_id, args.frontend_container_id).stdout)
    by_id = {item.get("Id"): item for item in actual_documents if isinstance(item, Mapping)}
    if set(by_id) != {args.backend_container_id, args.frontend_container_id}:
        raise _fail("pinned service inspection identities are incomplete")
    image_documents = json.loads(docker_capture("image", "inspect", args.image_id).stdout)
    if len(image_documents) != 1 or not isinstance(image_documents[0].get("Config"), Mapping):
        raise _fail("pinned development image inspection is incomplete")
    image_config = image_documents[0]["Config"]
    actual = {"backend": by_id[args.backend_container_id], "frontend": by_id[args.frontend_container_id]}
    for service, container_id in (("backend", args.backend_container_id), ("frontend", args.frontend_container_id)):
        _validate_container(actual[service], service, container_id, args.image_id, identity, compose, image_config)
    _validate_source_bind(actual["backend"], selected,
                          compose["services"]["backend"].get("x-fullmag-daemon-binds"))
    _validate_network(actual, {"backend": args.backend_container_id, "frontend": args.frontend_container_id}, control.project)
    env = _env_map(actual["backend"])
    _validate_runtime_process_receipt_override(env)
    if env.get("FULLMAG_SOURCE_HOST_ROOT") != str(selected):
        raise _fail("backend source identity does not match the selected checkout")
    _validate_source_bind(actual["frontend"], selected,
                          compose["services"]["frontend"].get("x-fullmag-daemon-binds"))
    _preflight_terminal_process_receipt(actual["backend"], control)
    probe = _probe(args.backend_container_id, args.request_id, args.session_id, args.source_sha256, args.failure_marker_sha256)
    _validate_probe_document(probe, args)
    return retained, dict(actual), probe


def _write_journal(control: BuildControl, path: str, journal: Mapping[str, object]) -> None:
    try:
        control.write(path, dict(journal))
    except Exception as error:
        raise _fail(f"cannot persist stop proof in control volume: {error}") from error


def _restore_frontend(frontend_id: str) -> None:
    docker_capture("start", frontend_id, timeout=90)
    observed = json.loads(docker_capture("inspect", frontend_id).stdout)
    if len(observed) != 1 or not observed[0].get("State", {}).get("Running"):
        raise _fail("frontend restore did not reach running state")


def _runtime_control_volume_mount(
    actual_backend: Mapping[str, object], project: str, *, namespace: str | None = None,
) -> tuple[str, str]:
    """Return the exact named volume and selected namespace subpath."""
    # BuildControl records a group without a quarantined namespace as "".
    if namespace and re.fullmatch(r"namespaces/[0-9a-f]{32}", namespace) is None:
        raise _fail("runtime-control namespace is invalid")
    expected_subpath = f"{namespace}/{RUNTIME_CONTROL_SUBPATH}" if namespace else RUNTIME_CONTROL_SUBPATH
    mounts = actual_backend.get("Mounts")
    if not isinstance(mounts, list):
        raise _fail("backend runtime-control mounts cannot be inspected")
    candidates = [
        mount for mount in mounts
        if isinstance(mount, Mapping)
        and mount.get("Destination") == "/opt/fullmag/runtime-control"
    ]
    if len(candidates) != 1:
        raise _fail("backend does not have exactly one runtime-control mount")
    mount = candidates[0]
    name = mount.get("Name")
    if (
        mount.get("Type") != "volume"
        or not isinstance(name, str)
        or not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,127}", name)
        or mount.get("RW") is not True
    ):
        raise _fail("backend runtime-control mount is not the expected writable named volume")
    host_config = actual_backend.get("HostConfig")
    host_mounts = host_config.get("Mounts") if isinstance(host_config, Mapping) else None
    if not isinstance(host_mounts, list):
        raise _fail("backend runtime-control HostConfig mount metadata is missing")
    matching_host_mounts = [
        item for item in host_mounts
        if isinstance(item, Mapping) and item.get("Target") == "/opt/fullmag/runtime-control"
    ]
    if len(matching_host_mounts) != 1:
        raise _fail("backend runtime-control HostConfig mount is ambiguous")
    host_mount = matching_host_mounts[0]
    options = host_mount.get("VolumeOptions")
    if (
        host_mount.get("Type") != "volume"
        or host_mount.get("Source") != name
        or not isinstance(options, Mapping)
        or options.get("Subpath") != expected_subpath
        or host_mount.get("ReadOnly") is True
    ):
        raise _fail("backend runtime-control mount does not prove the canonical subpath")
    documents = json.loads(docker_capture("volume", "inspect", name).stdout)
    if len(documents) != 1:
        raise _fail("runtime-control volume inspection is ambiguous")
    volume = documents[0]
    labels = volume.get("Labels")
    if (
        volume.get("Name") != name
        or volume.get("Driver") != "local"
        or volume.get("Options")
        or not isinstance(labels, Mapping)
        or labels.get("com.fullmag.compose.project") != project
    ):
        raise _fail("runtime-control volume ownership differs from the selected group")
    return name, expected_subpath


def _runtime_control_validation_helper(
    actual_backend: Mapping[str, object], control: BuildControl
) -> list[str]:
    """Build a readonly helper using the backend image and exact subpath mount."""
    image = actual_backend.get("Image")
    if not isinstance(image, str) or not IMAGE_ID_RE.fullmatch(image):
        raise _fail("backend image identity is unavailable for terminal validation")
    volume, subpath = _runtime_control_volume_mount(
        actual_backend, control.project, namespace=control.namespace,
    )
    if volume != control.volume:
        raise _fail("runtime-control volume differs from the selected controller")
    script = r'''
import json, sys
sys.path.insert(0, '/opt/fullmag')
import runtime_service

paths = runtime_service.canonical_paths()
runtime_service._read_authenticated_terminal_drain(paths)
receipt_path = runtime_service.process_receipt_path(paths)
with receipt_path.open('rb') as stream:
    data = stream.read(8 * 1024 * 1024 + 1)
if len(data) > 8 * 1024 * 1024:
    raise RuntimeError('canonical drained process receipt exceeds its size bound')
sys.stdout.buffer.write(data)
'''
    args = [
        *docker_argv("run"), "--rm", "-i", "--pull", "never",
        "--network", "none", "--runtime", "runc", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true", "--pids-limit", "32", "--memory", "64m",
        "--cpus", "0.25", "--env", "NVIDIA_VISIBLE_DEVICES=void",
        "--env", "PYTHONPATH=/opt/fullmag:/opt/fullmag/package:/build/workspace/packages/fullmag-py/src",
        "--label", f"com.docker.compose.project={control.project}",
        "--label", "com.docker.compose.service=host-runtime-maintenance",
        "--label", f"org.fullmag.compose.project={control.project}",
        "--env", "FULLMAG_RUNTIME_CONTROL_ROOT=/opt/fullmag/runtime-control",
        "--env", "FULLMAG_STATE_ROOT=/opt/fullmag/runtime-control",
        "--env", "FULLMAG_STATE_DIR=/opt/fullmag/runtime-control",
        "--env", "FULLMAG_RUNTIME_SERVICES_ROOT=/opt/fullmag/runtime-control/runtime-services",
        "--env", "FULLMAG_RUNS_ROOT=/state/runs/docker-all",
        "--env", "FULLMAG_CONTAINER_STATE_ROOT=/state",
        "--env", "FULLMAG_REPO_ROOT=/opt/fullmag/source",
        "--env", "FULLMAG_RUNTIME_ROOT=/opt/fullmag/package",
        "--env", "FULLMAG_WORKTREE_ID=docker-all",
        "--mount", f"type=volume,src={volume},dst=/opt/fullmag/runtime-control,readonly,volume-subpath={subpath},volume-nocopy",
        "--user", "65532:65532", "--entrypoint", "/usr/local/bin/python3", image,
        "-B", "-c", script,
    ]
    return args


def _preflight_terminal_process_receipt(
    actual_backend: Mapping[str, object], control: BuildControl
) -> None:
    """Prove before any stop that the drained receipt can be read afterwards.

    The read itself needs the stopped backend; its image, runtime-control
    mount and volume ownership do not change across a graceful stop.
    """
    _runtime_control_validation_helper(actual_backend, control)


def _read_terminal_process_receipt(
    actual_backend: Mapping[str, object], control: BuildControl
) -> tuple[bytes, dict[str, object]]:
    """Validate and read the canonical receipt through the backend image."""
    arguments = _runtime_control_validation_helper(actual_backend, control)
    result = bounded_capture(arguments, data=b"", timeout=90)
    if result.returncode:
        raise _fail(
            "canonical runtime-control receipt could not be read: "
            + result.stderr.decode("utf-8", "replace")[-1024:]
        )
    raw = bytes(result.stdout)
    if len(raw) > MAX_PROBE_BYTES:
        raise _fail("canonical drained process receipt exceeds its size bound")
    receipt = _json(raw, "canonical drained process receipt")
    return raw, receipt


def stop(args: argparse.Namespace) -> None:
    for value, pattern, label in (
        (args.attempt, ATTEMPT_RE, "attempt"),
        (args.backend_container_id, CONTAINER_ID_RE, "backend container"),
        (args.frontend_container_id, CONTAINER_ID_RE, "frontend container"),
        (args.image_id, IMAGE_ID_RE, "image"),
        (args.config_sha256, SHA256_RE, "config"),
        (args.failure_marker_sha256, SHA256_RE, "failure marker"),
        (args.process_receipt_sha256, SHA256_RE, "process receipt"),
        (args.source_sha256, SHA256_RE, "source"),
        (args.request_id, REQUEST_ID_RE, "request"),
        (args.session_id, SESSION_ID_RE, "session"),
    ):
        _require(value, pattern, label)
    repo = Path(args.repo_root).resolve(strict=True)
    selected, layout = _select_source(repo, args.source_root)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    try:
        helper_image = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    except (KeyError, TypeError) as error:
        raise _fail("canonical Docker toolchain helper image is unavailable") from error
    control = BuildControl(identity, helper_image)
    observed_volume = docker_capture("volume", "inspect", control.volume, allow_failure=True)
    if observed_volume.returncode:
        raise _fail("selected control volume is missing; no resources were adopted")
    control.prepare()
    root = "development/attempts/" + args.attempt
    terminal = _read_control_json(control, root + "/terminal.json")
    compose = _read_control_json(control, root + "/compose.json")
    if terminal is None or compose is None:
        raise _fail("retained development attempt or Compose document is missing")
    inputs = {
        "development_attempt": args.attempt,
        "config_sha256": args.config_sha256,
        "source_root": str(selected),
        "image_id": args.image_id,
        "backend_container": args.backend_container_id,
        "frontend_container": args.frontend_container_id,
        "failure_marker_sha256": args.failure_marker_sha256,
        "process_receipt_sha256": args.process_receipt_sha256,
        "source_sha256": args.source_sha256,
        "request_id": args.request_id,
        "session_id": args.session_id,
    }
    with control.operation("stop-unadmitted", inputs) as operation:
        operation["receipt"].update(
            state="preparing",
            development_attempt=args.attempt,
            config_sha256=args.config_sha256,
        )
        journal_path = "verification/stop-unadmitted-" + args.attempt + ".json"
        journal: dict[str, object] = {
            "schema": "fullmag.docker-unadmitted-stop.v1", "state": "operation-started",
            "attempt": args.attempt, "config_sha256": args.config_sha256, "source_root": str(selected),
            "source_sha256": args.source_sha256, "compose_project": control.project,
            "backend_container_id": args.backend_container_id, "frontend_container_id": args.frontend_container_id,
            "image_id": args.image_id, "request_id": args.request_id, "session_id": args.session_id,
            "failure_marker_sha256": args.failure_marker_sha256, "process_receipt_sha256": args.process_receipt_sha256,
            "operation_attempt": operation["receipt"]["attempt"], "started_at": time.time(),
        }
        _write_journal(control, journal_path, journal)
        frontend_stop_started = False
        frontend_stop_completed = False
        frontend_stopped = False
        backend_stop_started = False
        backend_stop_completed = False
        try:
            retained, actual, probe = _validate_preflight(args, selected, identity, control, terminal, compose)
            journal.update(state="preflight-passed", proof=probe)
            _write_journal(control, journal_path, journal)
            operation["receipt"].update(state="preflight-passed", proof=probe)
            frontend_stop_started = True
            operation["daemon_pending"] = True
            docker_capture("stop", "--time", "60", args.frontend_container_id, timeout=90)
            operation["daemon_pending"] = False
            frontend_stop_started = False
            frontend_stop_completed = True
            frontend_state = json.loads(docker_capture("inspect", args.frontend_container_id).stdout)
            if len(frontend_state) != 1:
                raise _fail("frontend stop inspection is ambiguous")
            _validate_frontend_stopped(frontend_state[0])
            frontend_stopped = True
            journal.update(state="frontend-stopped", frontend_exit_code=frontend_state[0].get("State", {}).get("ExitCode"))
            _write_journal(control, journal_path, journal)
            current = json.loads(docker_capture("inspect", args.backend_container_id, args.frontend_container_id).stdout)
            by_id = {item.get("Id"): item for item in current if isinstance(item, Mapping)}
            if set(by_id) != {args.backend_container_id, args.frontend_container_id}:
                raise _fail("service incarnation changed after frontend stop")
            _validate_frontend_stopped(by_id[args.frontend_container_id])
            if not by_id[args.backend_container_id].get("State", {}).get("Running"):
                raise _fail("backend stopped before the second proof")
            image_config = json.loads(docker_capture("image", "inspect", args.image_id).stdout)[0]["Config"]
            _validate_container(by_id[args.backend_container_id], "backend", args.backend_container_id, args.image_id, identity, compose, image_config)
            _validate_source_bind(by_id[args.backend_container_id], selected,
                                  compose["services"]["backend"].get("x-fullmag-daemon-binds"))
            _validate_network(
                {"backend": by_id[args.backend_container_id], "frontend": by_id[args.frontend_container_id]},
                {"backend": args.backend_container_id, "frontend": args.frontend_container_id},
                control.project,
                allow_stopped_frontend=True,
            )
            reprobe = _probe(args.backend_container_id, args.request_id, args.session_id, args.source_sha256, args.failure_marker_sha256)
            _validate_probe_document(reprobe, args)
            journal.update(state="frontend-stopped-rechecked", proof_recheck=reprobe)
            _write_journal(control, journal_path, journal)
            backend_stop_started = True
            operation["daemon_pending"] = True
            docker_capture("stop", "--time", "60", args.backend_container_id, timeout=90)
            operation["daemon_pending"] = False
            backend_stop_started = False
            backend_stop_completed = True
            after = json.loads(docker_capture("inspect", args.backend_container_id).stdout)
            if len(after) != 1 or after[0].get("State", {}).get("Running") or after[0].get("State", {}).get("ExitCode") != 0:
                raise _fail("backend did not exit successfully after the graceful stop")
            drained_raw, drained = _read_terminal_process_receipt(after[0], control)
            previous_owner = probe.get("process_receipt", {}).get("service_owner")
            terminal_owner = drained.get("terminal_service_owner")
            drained_owner = drained.get("service_owner")
            if (
                drained.get("schema") != PROCESS_RECEIPT_SCHEMA
                or drained.get("state") != "drained"
                or not isinstance(terminal_owner, Mapping)
                or not isinstance(drained_owner, Mapping)
            ):
                raise _fail("backend has no canonical drained process receipt")
            if _owner_identity_key(previous_owner, "pre-stop service owner") != _owner_identity_key(
                drained_owner, "drained service owner"
            ):
                raise _fail("drained receipt service owner differs from the pre-stop owner")
            journal.update(state="stopped-confirmed", backend_exit_code=after[0]["State"].get("ExitCode"),
                           drained_process_receipt_sha256=_sha256(drained_raw), drained_process_receipt=drained,
                           finished_at=time.time())
            _write_journal(control, journal_path, journal)
            operation["receipt"].update(
                state="succeeded",
                stop_outcome="stopped-confirmed",
                drained_process_receipt_sha256=_sha256(drained_raw),
            )
            control.write(operation["root"] + "/terminal.json", operation["receipt"])
            print(json.dumps({"state": journal["state"], "attempt": args.attempt,
                              "backend_container_id": args.backend_container_id,
                              "frontend_container_id": args.frontend_container_id}, sort_keys=True))
        except Exception as error:
            if (isinstance(error, ControlOutcomeUnknown) or frontend_stop_started
                    or backend_stop_started or backend_stop_completed
                    or (frontend_stop_completed and not frontend_stopped)):
                journal.update(state="outcome-unknown", error=str(error), finished_at=time.time())
                try: _write_journal(control, journal_path, journal)
                except Exception: pass
                raise
            if frontend_stopped and not backend_stop_started:
                try:
                    operation["daemon_pending"] = True
                    _restore_frontend(args.frontend_container_id)
                    operation["daemon_pending"] = False
                    journal.update(state="proof-rejected-frontend-restored", error=str(error), finished_at=time.time())
                    _write_journal(control, journal_path, journal)
                except Exception as restore_error:
                    journal.update(state="outcome-unknown", error=str(error), restore_error=str(restore_error), finished_at=time.time())
                    try: _write_journal(control, journal_path, journal)
                    except Exception: pass
                    raise _fail("proof failed and frontend restoration outcome is unknown") from restore_error
            else:
                journal.update(state="proof-rejected", error=str(error), finished_at=time.time())
                try: _write_journal(control, journal_path, journal)
                except Exception: pass
            raise


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--backend-container-id", required=True)
    parser.add_argument("--frontend-container-id", required=True)
    parser.add_argument("--image-id", required=True)
    parser.add_argument("--failure-marker-sha256", required=True)
    parser.add_argument("--process-receipt-sha256", required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--session-id", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        stop(_parser().parse_args(argv))
        return 0
    except (BuildControlError, storage.StorageError, ValueError, OSError) as error:
        print(f"docker-dev-stop-unadmitted: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
